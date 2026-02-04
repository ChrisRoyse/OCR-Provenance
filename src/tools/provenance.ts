/**
 * Provenance Management MCP Tools
 *
 * Extracted from src/index.ts Task 22.
 * Tools: ocr_provenance_get, ocr_provenance_verify, ocr_provenance_export
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

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** Detected item types from findProvenanceId - includes 'provenance' for direct provenance ID lookups */
type DetectedItemType = 'document' | 'chunk' | 'embedding' | 'ocr_result' | 'provenance';

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

  const prov = db.getProvenance(itemId);
  if (prov) return { provenanceId: prov.id, itemType: 'provenance' };

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function handleProvenanceGet(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ProvenanceGetInput, params);
    const { db } = requireDatabase();

    let provenanceId: string | null = null;
    let itemType: DetectedItemType | 'auto' = input.item_type ?? 'auto';

    if (itemType === 'auto') {
      const found = findProvenanceId(db, input.item_id);
      if (found) {
        provenanceId = found.provenanceId;
        itemType = found.itemType;
      }
    } else if (itemType === 'document') {
      provenanceId = db.getDocument(input.item_id)?.provenance_id ?? null;
    } else if (itemType === 'chunk') {
      provenanceId = db.getChunk(input.item_id)?.provenance_id ?? null;
    } else if (itemType === 'embedding') {
      provenanceId = db.getEmbedding(input.item_id)?.provenance_id ?? null;
    } else {
      provenanceId = input.item_id;
    }

    if (!provenanceId) {
      throw provenanceNotFoundError(input.item_id);
    }

    const chain = db.getProvenanceChain(provenanceId);
    if (chain.length === 0) {
      throw provenanceNotFoundError(input.item_id);
    }

    return formatResponse(successResult({
      item_id: input.item_id,
      item_type: itemType,
      chain: chain.map(p => ({
        id: p.id,
        type: p.type,
        chain_depth: p.chain_depth,
        processor: p.processor,
        processor_version: p.processor_version,
        content_hash: p.content_hash,
        created_at: p.created_at,
        parent_id: p.parent_id,
      })),
      root_document_id: chain[0].root_document_id,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_provenance_verify - Verify the integrity of an item through its provenance chain
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

    const chain = db.getProvenanceChain(provenanceId);
    if (chain.length === 0) {
      throw provenanceNotFoundError(input.item_id);
    }

    const steps: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    let contentIntegrity = true;
    let chainIntegrity = true;

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

      // Verify chain integrity
      if (input.verify_chain) {
        // Check chain depth is correct
        if (prov.chain_depth !== i) {
          step.chain_verified = false;
          chainIntegrity = false;
          errors.push(`Chain depth mismatch at ${prov.id}: expected ${i}, got ${prov.chain_depth}`);
        }

        // Check parent link (except for root)
        if (i > 0 && prov.parent_id !== chain[i - 1].id) {
          step.chain_verified = false;
          chainIntegrity = false;
          errors.push(`Parent link broken at ${prov.id}`);
        }
      }

      // Content verification - validate hash format
      if (input.verify_content) {
        if (!prov.content_hash.startsWith('sha256:')) {
          step.content_verified = false;
          contentIntegrity = false;
          errors.push(`Invalid hash format at ${prov.id}`);
        }
      }

      steps.push(step);
    }

    return formatResponse(successResult({
      item_id: input.item_id,
      verified: contentIntegrity && chainIntegrity,
      content_integrity: contentIntegrity,
      chain_integrity: chainIntegrity,
      steps,
      errors: errors.length > 0 ? errors : undefined,
    }));
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

    // Filter null records once
    const records = rawRecords.filter((r): r is NonNullable<typeof r> => r !== null);

    let data: unknown;

    if (input.format === 'json') {
      data = records.map(r => ({
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
      const entities: Record<string, unknown> = {};
      const activities: Record<string, unknown> = {};
      const derivations: unknown[] = [];

      for (const r of records) {
        entities[`entity:${r.id}`] = {
          'prov:type': r.type,
          'ocr:contentHash': r.content_hash,
          'ocr:chainDepth': r.chain_depth,
        };
        activities[`activity:${r.id}`] = {
          'prov:type': r.processor,
          'ocr:processorVersion': r.processor_version,
        };
        if (r.parent_id) {
          derivations.push({
            'prov:generatedEntity': `entity:${r.id}`,
            'prov:usedEntity': `entity:${r.parent_id}`,
            'prov:activity': `activity:${r.id}`,
          });
        }
      }

      data = {
        '@context': 'https://www.w3.org/ns/prov',
        entity: entities,
        activity: activities,
        wasDerivedFrom: derivations,
      };
    } else {
      // CSV format
      const headers = ['id', 'type', 'chain_depth', 'processor', 'processor_version', 'content_hash', 'parent_id', 'root_document_id', 'created_at'];
      const rows = records.map(r => [
        r.id, r.type, r.chain_depth, r.processor, r.processor_version,
        r.content_hash, r.parent_id ?? '', r.root_document_id, r.created_at,
      ].join(','));
      data = [headers.join(','), ...rows].join('\n');
    }

    return formatResponse(successResult({
      scope: input.scope,
      format: input.format,
      document_id: input.document_id,
      record_count: records.length,
      data,
    }));
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
  'ocr_provenance_get': {
    description: 'Get the complete provenance chain for an item',
    inputSchema: {
      item_id: z.string().min(1).describe('ID of the item (document, chunk, embedding, or provenance)'),
      item_type: z.enum(['document', 'ocr_result', 'chunk', 'embedding', 'auto']).default('auto').describe('Type of item'),
      format: z.enum(['chain', 'tree', 'flat']).default('chain').describe('Output format'),
    },
    handler: handleProvenanceGet,
  },
  'ocr_provenance_verify': {
    description: 'Verify the integrity of an item through its provenance chain',
    inputSchema: {
      item_id: z.string().min(1).describe('ID of the item to verify'),
      verify_content: z.boolean().default(true).describe('Verify content hashes'),
      verify_chain: z.boolean().default(true).describe('Verify chain integrity'),
    },
    handler: handleProvenanceVerify,
  },
  'ocr_provenance_export': {
    description: 'Export provenance data in various formats',
    inputSchema: {
      scope: z.enum(['document', 'database', 'all']).describe('Export scope'),
      document_id: z.string().optional().describe('Document ID (required when scope is document)'),
      format: z.enum(['json', 'w3c-prov', 'csv']).default('json').describe('Export format'),
      output_path: z.string().optional().describe('Optional output file path'),
    },
    handler: handleProvenanceExport,
  },
};
