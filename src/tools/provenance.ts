/**
 * Provenance Management MCP Tools
 *
 * Extracted from src/index.ts Task 22.
 * Tools: ocr_provenance_get, ocr_provenance_verify, ocr_provenance_export,
 *         ocr_provenance_query, ocr_provenance_timeline, ocr_provenance_processor_stats
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/provenance
 */

import { z } from 'zod';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  ProvenanceGetInput,
  ProvenanceVerifyInput,
  ProvenanceExportInput,
} from '../utils/validation.js';
import {
  provenanceNotFoundError,
  validationError,
  documentNotFoundError,
} from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import type { DatabaseService } from '../services/storage/database/index.js';
import { getImage } from '../services/storage/database/image-operations.js';
import { getOCRResult } from '../services/storage/database/ocr-operations.js';
import { ProvenanceVerifier } from '../services/provenance/verifier.js';
import { ProvenanceTracker } from '../services/provenance/tracker.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Escape a field for CSV output.
 * If the field contains a comma, double-quote, or newline, wrap it in double quotes
 * and escape internal double-quotes by doubling them.
 */
function csvEscape(field: string | number | null | undefined): string {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Detected item types from findProvenanceId */
type DetectedItemType =
  | 'document'
  | 'chunk'
  | 'embedding'
  | 'ocr_result'
  | 'image'
  | 'comparison'
  | 'clustering'
  | 'form_fill'
  | 'extraction'
  | 'provenance';

/**
 * Find provenance ID from an item of any type.
 * Returns the provenance ID and detected item type, or null if not found.
 */
function findProvenanceId(
  db: DatabaseService,
  itemId: string
): { provenanceId: string; itemType: DetectedItemType } | null {
  const doc = db.getDocument(itemId);
  if (doc) return { provenanceId: doc.provenance_id, itemType: 'document' };

  const chunk = db.getChunk(itemId);
  if (chunk) return { provenanceId: chunk.provenance_id, itemType: 'chunk' };

  const embedding = db.getEmbedding(itemId);
  if (embedding) return { provenanceId: embedding.provenance_id, itemType: 'embedding' };

  const dbConn = db.getConnection();

  const image = getImage(dbConn, itemId);
  if (image && image.provenance_id) {
    return { provenanceId: image.provenance_id, itemType: 'image' };
  }

  const ocrResult = getOCRResult(dbConn, itemId);
  if (ocrResult && ocrResult.provenance_id) {
    return { provenanceId: ocrResult.provenance_id, itemType: 'ocr_result' };
  }

  const comparison = dbConn
    .prepare('SELECT provenance_id FROM comparisons WHERE id = ?')
    .get(itemId) as { provenance_id: string } | undefined;
  if (comparison) {
    return { provenanceId: comparison.provenance_id, itemType: 'comparison' };
  }

  const cluster = dbConn.prepare('SELECT provenance_id FROM clusters WHERE id = ?').get(itemId) as
    | { provenance_id: string }
    | undefined;
  if (cluster) {
    return { provenanceId: cluster.provenance_id, itemType: 'clustering' };
  }

  const formFill = dbConn
    .prepare('SELECT provenance_id FROM form_fills WHERE id = ?')
    .get(itemId) as { provenance_id: string } | undefined;
  if (formFill) {
    return { provenanceId: formFill.provenance_id, itemType: 'form_fill' };
  }

  const extraction = dbConn
    .prepare('SELECT provenance_id FROM extractions WHERE id = ?')
    .get(itemId) as { provenance_id: string } | undefined;
  if (extraction) {
    return { provenanceId: extraction.provenance_id, itemType: 'extraction' };
  }

  const prov = db.getProvenance(itemId);
  if (prov) return { provenanceId: prov.id, itemType: 'provenance' };

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function handleProvenanceGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ProvenanceGetInput, params);
    const { db } = requireDatabase();

    const found = findProvenanceId(db, input.item_id);
    const provenanceId = found?.provenanceId ?? null;
    const itemType: DetectedItemType | 'auto' = found?.itemType ?? input.item_type ?? 'auto';

    if (!provenanceId) {
      throw provenanceNotFoundError(input.item_id);
    }

    const chain = db.getProvenanceChain(provenanceId);
    if (chain.length === 0) {
      throw provenanceNotFoundError(input.item_id);
    }

    const enrichedChain = chain.map((p) => ({
      id: p.id,
      type: p.type,
      chain_depth: p.chain_depth,
      processor: p.processor,
      processor_version: p.processor_version,
      content_hash: p.content_hash,
      created_at: p.created_at,
      parent_id: p.parent_id,
    }));

    return formatResponse(
      successResult({
        item_id: input.item_id,
        item_type: itemType,
        chain: enrichedChain,
        root_document_id: chain[0].root_document_id,
        next_steps: [
          { tool: 'ocr_provenance_verify', description: 'Verify content integrity of this provenance chain' },
          { tool: 'ocr_document_get', description: 'Get details for the root document' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_provenance_verify - Verify the integrity of an item through its provenance chain
 *
 * Uses real ProvenanceVerifier to re-hash content and compare against stored hashes.
 * Constitution CP-003: SHA-256 hashes at every processing step enable tamper detection.
 */
export async function handleProvenanceVerify(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ProvenanceVerifyInput, params);
    const { db } = requireDatabase();

    const found = findProvenanceId(db, input.item_id);
    if (!found) {
      throw provenanceNotFoundError(input.item_id);
    }
    const provenanceId = found.provenanceId;

    // Use real ProvenanceVerifier for content integrity verification
    const tracker = new ProvenanceTracker(db);
    const verifier = new ProvenanceVerifier(db, tracker);

    // Verify the full chain (re-hashes content at each step)
    const chainResult = await verifier.verifyChain(provenanceId);

    // Build per-step details for the response
    const chain = db.getProvenanceChain(provenanceId);
    const steps: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    let chainIntegrity = chainResult.chain_intact;

    for (let i = 0; i < chain.length; i++) {
      const prov = chain[i];
      const step: Record<string, unknown> = {
        provenance_id: prov.id,
        type: prov.type,
        chain_depth: prov.chain_depth,
        content_verified: true,
        chain_verified: true,
        expected_hash: prov.content_hash,
      };

      // Check if this item failed content verification
      if (input.verify_content) {
        const failedItem = chainResult.failed_items.find((f) => f.id === prov.id);
        if (failedItem) {
          step.content_verified = false;
          step.computed_hash = failedItem.computed_hash;
          errors.push(
            `Content hash mismatch at ${prov.id}: expected ${failedItem.expected_hash}, got ${failedItem.computed_hash}`
          );
        }
      }

      // Verify chain structure (depth and parent links)
      // H-5: Only verify depths when chain is intact; incomplete chains produce wrong expected depths
      if (input.verify_chain) {
        if (chainResult.chain_intact) {
          const expectedDepth = chain.length - 1 - i;
          if (prov.chain_depth !== expectedDepth) {
            step.chain_verified = false;
            chainIntegrity = false;
            errors.push(
              `Chain depth mismatch at ${prov.id}: expected ${expectedDepth}, got ${prov.chain_depth}`
            );
          }

          if (i > 0 && chain[i - 1].parent_id !== prov.id) {
            step.chain_verified = false;
            chainIntegrity = false;
            errors.push(`Parent link broken at ${chain[i - 1].id}`);
          }
        } else {
          step.chain_verified = false;
        }
      }

      steps.push(step);
    }

    // H-5: When chain is not intact, add a note instead of false-positive depth errors
    if (input.verify_chain && !chainResult.chain_intact) {
      errors.push('Depth verification skipped: chain is incomplete');
    }

    // M-9: When verify_content is false, skip content hash result entirely
    const contentIntegrity = input.verify_content ? chainResult.hashes_failed === 0 : true;

    const result: Record<string, unknown> = {
      item_id: input.item_id,
      verified: contentIntegrity && chainIntegrity,
      content_integrity: contentIntegrity,
      chain_integrity: chainIntegrity,
      steps,
      errors: errors.length > 0 ? errors : undefined,
    };

    // M-9: Only include hash counts when content verification was requested
    if (input.verify_content) {
      result.hashes_verified = chainResult.hashes_verified;
      result.hashes_failed = chainResult.hashes_failed;
    }

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_provenance_export - Export provenance data in various formats
 */
export async function handleProvenanceExport(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ProvenanceExportInput, params);
    const { db } = requireDatabase();

    // Collect provenance records based on scope
    let rawRecords: ReturnType<typeof db.getProvenance>[] = [];

    if (input.scope === 'document') {
      if (!input.document_id) {
        throw validationError('document_id is required when scope is "document"');
      }
      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }
      rawRecords = db.getProvenanceByRootDocument(doc.provenance_id);
    } else {
      const docs = db.listDocuments({ limit: 10000 });
      for (const doc of docs) {
        rawRecords.push(...db.getProvenanceByRootDocument(doc.provenance_id));
      }
    }

    // Filter null records and deduplicate by provenance ID (L-17: cross-document VLM dedup can overlap)
    const nonNullRecords = rawRecords.filter((r): r is NonNullable<typeof r> => r !== null);
    const records = [...new Map(nonNullRecords.map((r) => [r.id, r])).values()];

    let data: unknown;

    if (input.format === 'json') {
      data = records.map((r) => ({
        id: r.id,
        type: r.type,
        chain_depth: r.chain_depth,
        processor: r.processor,
        processor_version: r.processor_version,
        content_hash: r.content_hash,
        parent_id: r.parent_id,
        root_document_id: r.root_document_id,
        created_at: r.created_at,
      }));
    } else if (input.format === 'w3c-prov') {
      // W3C PROV-JSON compliant export matching W3CProvDocument interface
      const prefix: Record<string, string> = {
        prov: 'http://www.w3.org/ns/prov#',
        ocr: 'http://ocr-provenance.local/ns#',
        xsd: 'http://www.w3.org/2001/XMLSchema#',
      };

      const entity: Record<string, Record<string, unknown>> = {};
      const activity: Record<string, Record<string, unknown>> = {};
      const agent: Record<string, Record<string, unknown>> = {
        'ocr:system': {
          'prov:type': { $: 'ocr-provenance-mcp', type: 'xsd:string' },
          'prov:label': 'OCR Provenance MCP System',
        },
      };
      const wasGeneratedBy: Record<string, Record<string, unknown>> = {};
      const wasDerivedFrom: Record<string, Record<string, unknown>> = {};
      const wasAttributedTo: Record<string, Record<string, unknown>> = {};
      const used: Record<string, Record<string, unknown>> = {};

      for (const r of records) {
        // Each provenance record is an entity
        entity[`ocr:${r.id}`] = {
          'prov:type': { $: r.type, type: 'xsd:string' },
          'ocr:contentHash': r.content_hash,
          'ocr:chainDepth': r.chain_depth,
          'prov:generatedAtTime': r.created_at,
        };

        // Only processing steps (chain_depth > 0) have activities
        if (r.chain_depth > 0) {
          const activityId = `ocr:activity-${r.id}`;
          activity[activityId] = {
            'prov:type': { $: r.processor, type: 'xsd:string' },
            'ocr:processorVersion': r.processor_version,
            'prov:startedAtTime': r.created_at,
          };

          // wasGeneratedBy: entity was generated by activity
          wasGeneratedBy[`ocr:wgb-${r.id}`] = {
            'prov:entity': `ocr:${r.id}`,
            'prov:activity': activityId,
          };

          if (r.parent_id) {
            // wasDerivedFrom: child entity derived from parent entity
            wasDerivedFrom[`ocr:wdf-${r.id}`] = {
              'prov:generatedEntity': `ocr:${r.id}`,
              'prov:usedEntity': `ocr:${r.parent_id}`,
              'prov:activity': activityId,
            };

            // used: activity used parent entity as input
            used[`ocr:used-${r.id}`] = {
              'prov:activity': activityId,
              'prov:entity': `ocr:${r.parent_id}`,
            };
          }
        } else {
          // DOCUMENT entities (chain_depth 0) are attributed to the system agent
          wasAttributedTo[`ocr:wat-${r.id}`] = {
            'prov:entity': `ocr:${r.id}`,
            'prov:agent': 'ocr:system',
          };
        }
      }

      data = {
        prefix,
        entity,
        activity,
        agent,
        wasGeneratedBy,
        wasDerivedFrom,
        wasAttributedTo,
        used,
      };
    } else {
      // CSV format with proper escaping (M-10)
      const headers = [
        'id',
        'type',
        'chain_depth',
        'processor',
        'processor_version',
        'content_hash',
        'parent_id',
        'root_document_id',
        'created_at',
      ];
      const rows = records.map((r) =>
        [
          csvEscape(r.id),
          csvEscape(r.type),
          csvEscape(r.chain_depth),
          csvEscape(r.processor),
          csvEscape(r.processor_version),
          csvEscape(r.content_hash),
          csvEscape(r.parent_id ?? ''),
          csvEscape(r.root_document_id),
          csvEscape(r.created_at),
        ].join(',')
      );
      data = [headers.join(','), ...rows].join('\n');
    }

    return formatResponse(
      successResult({
        scope: input.scope,
        format: input.format,
        document_id: input.document_id,
        record_count: records.length,
        data,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE QUERY TOOL HANDLERS (Phase 5)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_provenance_query - Query provenance records with filters
 *
 * Supports filtering by processor, type, chain_depth, date range, quality score,
 * duration, and root_document_id. Supports ordering and pagination.
 */
export async function handleProvenanceQuery(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        processor: z.string().optional().describe('Filter by processor name'),
        type: z
          .enum([
            'DOCUMENT',
            'OCR_RESULT',
            'FORM_FILL',
            'CHUNK',
            'IMAGE',
            'EXTRACTION',
            'COMPARISON',
            'CLUSTERING',
            'EMBEDDING',
            'VLM_DESCRIPTION',
          ])
          .optional()
          .describe('Filter by provenance type'),
        chain_depth: z.number().int().min(0).optional().describe('Filter by exact chain depth'),
        created_after: z.string().optional().describe('Filter records created after this ISO 8601 timestamp'),
        created_before: z.string().optional().describe('Filter records created before this ISO 8601 timestamp'),
        min_quality_score: z.number().min(0).optional().describe('Minimum processing quality score'),
        min_duration_ms: z.number().min(0).optional().describe('Minimum processing duration in ms'),
        root_document_id: z.string().optional().describe('Filter by root document provenance ID'),
        limit: z.number().int().min(1).max(100).default(50).describe('Maximum results (default 50)'),
        offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
        order_by: z
          .enum(['created_at', 'processing_duration_ms', 'processing_quality_score'])
          .default('created_at')
          .describe('Field to order by'),
        order_dir: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
      }),
      params
    );

    const { db } = requireDatabase();

    const { records, total } = db.queryProvenance({
      processor: input.processor,
      type: input.type,
      chain_depth: input.chain_depth,
      created_after: input.created_after,
      created_before: input.created_before,
      min_quality_score: input.min_quality_score,
      min_duration_ms: input.min_duration_ms,
      root_document_id: input.root_document_id,
      limit: input.limit,
      offset: input.offset,
      order_by: input.order_by,
      order_dir: input.order_dir,
    });

    // Build filters_applied for response transparency
    const filtersApplied: Record<string, unknown> = {};
    if (input.processor !== undefined) filtersApplied.processor = input.processor;
    if (input.type !== undefined) filtersApplied.type = input.type;
    if (input.chain_depth !== undefined) filtersApplied.chain_depth = input.chain_depth;
    if (input.created_after !== undefined) filtersApplied.created_after = input.created_after;
    if (input.created_before !== undefined) filtersApplied.created_before = input.created_before;
    if (input.min_quality_score !== undefined) filtersApplied.min_quality_score = input.min_quality_score;
    if (input.min_duration_ms !== undefined) filtersApplied.min_duration_ms = input.min_duration_ms;
    if (input.root_document_id !== undefined) filtersApplied.root_document_id = input.root_document_id;

    const formattedRecords = records.map((r) => ({
      id: r.id,
      type: r.type,
      chain_depth: r.chain_depth,
      processor: r.processor,
      processor_version: r.processor_version,
      processing_duration_ms: r.processing_duration_ms,
      processing_quality_score: r.processing_quality_score,
      content_hash: r.content_hash,
      root_document_id: r.root_document_id,
      parent_id: r.parent_id,
      created_at: r.created_at,
    }));

    return formatResponse(
      successResult({
        records: formattedRecords,
        total,
        limit: input.limit,
        offset: input.offset,
        filters_applied: filtersApplied,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_provenance_timeline - Complete processing timeline for a document
 *
 * Shows every transformation chronologically with step numbers, types,
 * processors, durations, and quality scores.
 */
export async function handleProvenanceTimeline(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1).describe('Document ID to get timeline for'),
        include_params: z
          .boolean()
          .default(false)
          .describe('Include processing parameters in each step'),
      }),
      params
    );

    const { db } = requireDatabase();

    // Get the document to find its provenance_id
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Get all provenance records for this document's root
    const records = db.getProvenanceByRootDocument(doc.provenance_id);

    if (records.length === 0) {
      return formatResponse(
        successResult({
          document_id: input.document_id,
          total_processing_time_ms: 0,
          steps_count: 0,
          timeline: [],
        })
      );
    }

    // Sort chronologically by created_at, then by chain_depth for stable ordering
    const sorted = [...records].sort((a, b) => {
      const timeCompare = a.created_at.localeCompare(b.created_at);
      if (timeCompare !== 0) return timeCompare;
      return a.chain_depth - b.chain_depth;
    });

    // Compute total processing time
    let totalProcessingTimeMs = 0;
    for (const r of sorted) {
      if (r.processing_duration_ms !== null) {
        totalProcessingTimeMs += r.processing_duration_ms;
      }
    }

    // Build timeline entries
    const timeline = sorted.map((r, index) => {
      const entry: Record<string, unknown> = {
        step: index + 1,
        type: r.type,
        processor: r.processor,
        processor_version: r.processor_version,
        duration_ms: r.processing_duration_ms,
        quality_score: r.processing_quality_score,
        chain_depth: r.chain_depth,
        timestamp: r.created_at,
        provenance_id: r.id,
        parent_id: r.parent_id,
      };

      if (input.include_params) {
        entry.processing_params = r.processing_params;
      }

      return entry;
    });

    return formatResponse(
      successResult({
        document_id: input.document_id,
        total_processing_time_ms: totalProcessingTimeMs,
        steps_count: timeline.length,
        timeline,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_provenance_processor_stats - Aggregate statistics per processor
 *
 * Groups by processor and processor_version with COUNT, AVG, MIN, MAX, SUM
 * aggregations on processing_duration_ms and processing_quality_score.
 */
export async function handleProvenanceProcessorStats(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        processor: z.string().optional().describe('Filter by specific processor name'),
        created_after: z.string().optional().describe('Filter records created after this ISO 8601 timestamp'),
        created_before: z.string().optional().describe('Filter records created before this ISO 8601 timestamp'),
      }),
      params
    );

    const { db } = requireDatabase();

    const stats = db.getProvenanceProcessorStats({
      processor: input.processor,
      created_after: input.created_after,
      created_before: input.created_before,
    });

    return formatResponse(
      successResult({
        stats,
        total_processors: stats.length,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Provenance tools collection for MCP server registration
 */
export const provenanceTools: Record<string, ToolDefinition> = {
  ocr_provenance_get: {
    description:
      '[ANALYSIS] Use to trace the complete processing history of any item (document, chunk, image, etc.). Returns provenance chain from origin to current state.',
    inputSchema: {
      item_id: z
        .string()
        .min(1)
        .describe(
          'ID of the item (document, ocr_result, chunk, embedding, image, comparison, clustering, form_fill, extraction, or provenance)'
        ),
      item_type: z
        .enum([
          'document',
          'ocr_result',
          'chunk',
          'embedding',
          'image',
          'comparison',
          'clustering',
          'form_fill',
          'extraction',
          'auto',
        ])
        .default('auto')
        .describe('Type of item'),
    },
    handler: handleProvenanceGet,
  },
  ocr_provenance_verify: {
    description:
      '[ANALYSIS] Use to verify data integrity by checking content hashes and chain consistency. Returns verification status with any issues found.',
    inputSchema: {
      item_id: z.string().min(1).describe('ID of the item to verify'),
      verify_content: z.boolean().default(true).describe('Verify content hashes'),
      verify_chain: z.boolean().default(true).describe('Verify chain integrity'),
    },
    handler: handleProvenanceVerify,
  },
  ocr_provenance_export: {
    description:
      '[ADMIN] Use to export provenance records to JSON, W3C PROV-JSON, or CSV. Scope to a document or entire database.',
    inputSchema: {
      scope: z.enum(['document', 'database']).describe('Export scope'),
      document_id: z.string().optional().describe('Document ID (required when scope is document)'),
      format: z.enum(['json', 'w3c-prov', 'csv']).default('json').describe('Export format'),
    },
    handler: handleProvenanceExport,
  },
  ocr_provenance_query: {
    description:
      '[ANALYSIS] Use to query provenance records with filters (processor, type, date, depth, quality). Returns paginated records for auditing.',
    inputSchema: {
      processor: z.string().optional().describe('Filter by processor name'),
      type: z
        .enum([
          'DOCUMENT',
          'OCR_RESULT',
          'FORM_FILL',
          'CHUNK',
          'IMAGE',
          'EXTRACTION',
          'COMPARISON',
          'CLUSTERING',
          'EMBEDDING',
          'VLM_DESCRIPTION',
        ])
        .optional()
        .describe('Filter by provenance type'),
      chain_depth: z.number().int().min(0).optional().describe('Filter by exact chain depth'),
      created_after: z.string().optional().describe('Filter records created after this ISO 8601 timestamp'),
      created_before: z.string().optional().describe('Filter records created before this ISO 8601 timestamp'),
      min_quality_score: z.number().min(0).optional().describe('Minimum processing quality score'),
      min_duration_ms: z.number().min(0).optional().describe('Minimum processing duration in ms'),
      root_document_id: z.string().optional().describe('Filter by root document provenance ID'),
      limit: z.number().int().min(1).max(100).default(50).describe('Maximum results (default 50)'),
      offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
      order_by: z
        .enum(['created_at', 'processing_duration_ms', 'processing_quality_score'])
        .default('created_at')
        .describe('Field to order by'),
      order_dir: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
    },
    handler: handleProvenanceQuery,
  },
  ocr_provenance_timeline: {
    description:
      '[ANALYSIS] Use to see the complete processing timeline for a document. Returns every transformation step chronologically with durations.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to get timeline for'),
      include_params: z
        .boolean()
        .default(false)
        .describe('Include processing parameters in each step'),
    },
    handler: handleProvenanceTimeline,
  },
  ocr_provenance_processor_stats: {
    description:
      '[ADMIN] Use to get aggregate performance stats per processor (operation counts, durations, quality). Returns processor-level analytics.',
    inputSchema: {
      processor: z.string().optional().describe('Filter by specific processor name'),
      created_after: z.string().optional().describe('Filter records created after this ISO 8601 timestamp'),
      created_before: z.string().optional().describe('Filter records created before this ISO 8601 timestamp'),
    },
    handler: handleProvenanceProcessorStats,
  },
};
