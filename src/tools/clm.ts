/**
 * Contract Lifecycle Management (CLM) Tools
 *
 * Provides 9 MCP tools for contract intelligence:
 * - ocr_contract_extract (contract data extraction using predefined schemas)
 * - ocr_obligation_list/update/calendar (obligation tracking)
 * - ocr_playbook_create/compare/list (playbook management)
 * - ocr_document_summarize/ocr_corpus_summarize (summarization)
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/clm
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import {
  listObligations,
  updateObligationStatus,
  getObligationCalendar,
  markOverdueObligations,
  OBLIGATION_TYPES,
  OBLIGATION_STATUSES,
} from '../services/storage/database/obligation-operations.js';
import {
  createPlaybook,
  listPlaybooks,
  compareWithPlaybook,
} from '../services/storage/database/playbook-operations.js';
import { getSchemasByName, ALL_CONTRACT_SCHEMAS } from '../services/clm/contract-schemas.js';
import type { ContractSchema } from '../services/clm/contract-schemas.js';
import { summarizeDocument } from '../services/clm/summarization.js';
import type { ChunkInput } from '../services/clm/summarization.js';

// =============================================================================
// SCHEMAS
// =============================================================================

const ObligationTypeSchema = z.enum(OBLIGATION_TYPES as unknown as [string, ...string[]]);
const ObligationStatusSchema = z.enum(OBLIGATION_STATUSES as unknown as [string, ...string[]]);
const ClauseSeveritySchema = z.enum(['critical', 'major', 'minor']);

// =============================================================================
// TOOL 4.1: ocr_contract_extract
// =============================================================================

/**
 * Extract contract-specific information using predefined schemas.
 * Reads chunks for the document and uses pattern matching to identify
 * contract elements. No external API calls.
 */
async function handleContractExtract(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        schemas: z.array(z.string()).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists
    const doc = conn
      .prepare('SELECT id, file_name, status FROM documents WHERE id = ?')
      .get(input.document_id) as { id: string; file_name: string; status: string } | undefined;

    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    // Get schemas to extract
    const schemas = getSchemasByName(input.schemas);

    // Get all chunks for the document
    const chunks = conn
      .prepare(
        `
      SELECT id, text, page_number, heading_context, section_path, content_types
      FROM chunks WHERE document_id = ?
      ORDER BY chunk_index ASC
    `
      )
      .all(input.document_id) as Array<{
      id: string;
      text: string;
      page_number: number | null;
      heading_context: string | null;
      section_path: string | null;
      content_types: string | null;
    }>;

    if (chunks.length === 0) {
      throw new Error(
        `No chunks found for document ${input.document_id}. Process the document first.`
      );
    }

    // Extract data for each schema
    const results: Record<string, Record<string, unknown>> = {};
    for (const schema of schemas) {
      results[schema.name] = extractSchemaFields(schema, chunks);
    }

    // Also auto-mark overdue obligations while we are at it
    const overdueCount = markOverdueObligations(conn);

    return formatResponse(
      successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        schemas_extracted: schemas.map((s) => s.name),
        chunk_count: chunks.length,
        extractions: results,
        overdue_marked: overdueCount,
        next_steps: [
          { tool: 'ocr_obligation_list', description: 'View obligations for this document' },
          { tool: 'ocr_playbook_compare', description: 'Compare document against a playbook' },
          { tool: 'ocr_document_summarize', description: 'Generate structured summary' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.2: ocr_obligation_list
// =============================================================================

async function handleObligationList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1).optional(),
        obligation_type: ObligationTypeSchema.optional(),
        status: ObligationStatusSchema.optional(),
        due_before: z.string().optional(),
        due_after: z.string().optional(),
        responsible_party: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Auto-mark overdue before listing
    markOverdueObligations(conn);

    const result = listObligations(conn, {
      document_id: input.document_id,
      obligation_type: input.obligation_type as Parameters<
        typeof listObligations
      >[1]['obligation_type'],
      status: input.status as Parameters<typeof listObligations>[1]['status'],
      due_before: input.due_before,
      due_after: input.due_after,
      responsible_party: input.responsible_party,
      limit: input.limit,
      offset: input.offset,
    });

    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const hasMore = offset + result.obligations.length < result.total;

    return formatResponse(
      successResult({
        obligations: result.obligations,
        total: result.total,
        limit,
        offset,
        has_more: hasMore,
        next_steps: hasMore
          ? [
              {
                tool: 'ocr_obligation_list',
                description: `Get next page with offset=${offset + limit}`,
              },
            ]
          : [
              { tool: 'ocr_obligation_update', description: 'Update an obligation status' },
              { tool: 'ocr_obligation_calendar', description: 'View obligation calendar' },
              {
                tool: 'ocr_contract_extract',
                description: 'Extract more obligations from a document',
              },
            ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.3: ocr_obligation_update
// =============================================================================

async function handleObligationUpdate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        obligation_id: z.string().min(1),
        status: ObligationStatusSchema,
        reason: z.string().max(1000).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const updated = updateObligationStatus(
      conn,
      input.obligation_id,
      input.status as Parameters<typeof updateObligationStatus>[2],
      input.reason
    );

    return formatResponse(
      successResult({
        obligation: updated,
        next_steps: [
          { tool: 'ocr_obligation_list', description: 'List obligations to see updated state' },
          { tool: 'ocr_obligation_calendar', description: 'View upcoming deadlines' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.4: ocr_obligation_calendar
// =============================================================================

async function handleObligationCalendar(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        months_ahead: z.number().int().min(1).max(24).default(3),
        status: ObligationStatusSchema.optional(),
        document_id: z.string().min(1).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Auto-mark overdue before calendar view
    markOverdueObligations(conn);

    const calendar = getObligationCalendar(conn, {
      months_ahead: input.months_ahead,
      status: input.status as Parameters<typeof getObligationCalendar>[1]['status'],
      document_id: input.document_id,
    });

    const totalObligations = calendar.reduce((sum, m) => sum + m.obligations.length, 0);

    return formatResponse(
      successResult({
        months: calendar,
        total_months: calendar.length,
        total_obligations: totalObligations,
        range: {
          months_ahead: input.months_ahead,
          status_filter: input.status ?? null,
          document_id: input.document_id ?? null,
        },
        next_steps: [
          { tool: 'ocr_obligation_list', description: 'List obligations with more filters' },
          { tool: 'ocr_obligation_update', description: 'Update an obligation status' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.5: ocr_playbook_create
// =============================================================================

async function handlePlaybookCreate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        clauses: z
          .array(
            z.object({
              clause_name: z.string().min(1).max(200),
              preferred_text: z.string().min(1).max(5000),
              severity: ClauseSeveritySchema,
              alternatives: z.array(z.string().max(5000)).default([]),
            })
          )
          .min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const playbook = createPlaybook(conn, {
      name: input.name,
      description: input.description ?? null,
      clauses: input.clauses.map((c) => ({
        clause_name: c.clause_name,
        preferred_text: c.preferred_text,
        severity: c.severity,
        alternatives: c.alternatives ?? [],
      })),
    });

    return formatResponse(
      successResult({
        playbook,
        next_steps: [
          { tool: 'ocr_playbook_compare', description: 'Compare a document against this playbook' },
          { tool: 'ocr_playbook_list', description: 'List all playbooks' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.6: ocr_playbook_compare
// =============================================================================

async function handlePlaybookCompare(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        playbook_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const result = compareWithPlaybook(conn, input.document_id, input.playbook_id);

    return formatResponse(
      successResult({
        comparison: result,
        next_steps: [
          { tool: 'ocr_obligation_list', description: 'View obligations for this document' },
          { tool: 'ocr_contract_extract', description: 'Extract contract details' },
          { tool: 'ocr_playbook_list', description: 'Compare against a different playbook' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.7: ocr_playbook_list
// =============================================================================

async function handlePlaybookList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    validateInput(z.object({}), params);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const playbooks = listPlaybooks(conn);

    return formatResponse(
      successResult({
        playbooks: playbooks.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          clause_count: p.clauses.length,
          created_at: p.created_at,
          updated_at: p.updated_at,
        })),
        total: playbooks.length,
        next_steps:
          playbooks.length === 0
            ? [
                {
                  tool: 'ocr_playbook_create',
                  description: 'Create a playbook with preferred contract terms',
                },
              ]
            : [
                {
                  tool: 'ocr_playbook_compare',
                  description: 'Compare a document against a playbook',
                },
                { tool: 'ocr_playbook_create', description: 'Create a new playbook' },
              ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.8: ocr_document_summarize
// =============================================================================

async function handleDocumentSummarize(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists
    const doc = conn
      .prepare('SELECT id, file_name, status FROM documents WHERE id = ?')
      .get(input.document_id) as { id: string; file_name: string; status: string } | undefined;

    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    // Get all chunks with relevant columns
    const chunks = conn
      .prepare(
        `
      SELECT text, page_number, heading_context, section_path, content_types
      FROM chunks WHERE document_id = ?
      ORDER BY chunk_index ASC
    `
      )
      .all(input.document_id) as ChunkInput[];

    if (chunks.length === 0) {
      throw new Error(
        `No chunks found for document ${input.document_id}. Process the document first.`
      );
    }

    const summary = summarizeDocument(chunks);
    summary.document_id = input.document_id;

    return formatResponse(
      successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        status: doc.status,
        summary,
        next_steps: [
          { tool: 'ocr_contract_extract', description: 'Extract contract-specific information' },
          { tool: 'ocr_search', description: 'Search within this document' },
          { tool: 'ocr_document_get', description: 'Get full document details' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 4.9: ocr_corpus_summarize
// =============================================================================

async function handleCorpusSummarize(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        limit: z.number().int().min(1).max(500).default(100),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Get document summaries
    const documents = conn
      .prepare(
        `
      SELECT d.id, d.file_name, d.status, d.page_count,
        (SELECT COUNT(*) FROM chunks WHERE document_id = d.id) as chunk_count
      FROM documents d
      ORDER BY d.created_at DESC
      LIMIT ?
    `
      )
      .all(input.limit) as Array<{
      id: string;
      file_name: string;
      status: string;
      page_count: number | null;
      chunk_count: number;
    }>;

    // Aggregate stats
    const totalChunks = documents.reduce((sum, d) => sum + d.chunk_count, 0);
    const totalPages = documents.reduce((sum, d) => sum + (d.page_count ?? 0), 0);

    // Get content type distribution across all chunks
    const contentTypeRows = conn
      .prepare(
        `
      SELECT content_types FROM chunks
      WHERE content_types IS NOT NULL AND content_types != ''
      LIMIT 10000
    `
      )
      .all() as Array<{ content_types: string }>;

    const contentTypeDist: Record<string, number> = {};
    for (const row of contentTypeRows) {
      try {
        const parsed = JSON.parse(row.content_types) as string[];
        if (Array.isArray(parsed)) {
          for (const ct of parsed) {
            if (typeof ct === 'string' && ct.trim()) {
              const trimmed = ct.trim();
              contentTypeDist[trimmed] = (contentTypeDist[trimmed] ?? 0) + 1;
            }
          }
        }
      } catch {
        // Fallback: if not valid JSON, treat as comma-separated
        for (const ct of row.content_types.split(',')) {
          const trimmed = ct.trim();
          if (trimmed) {
            contentTypeDist[trimmed] = (contentTypeDist[trimmed] ?? 0) + 1;
          }
        }
      }
    }

    // Get top sections across corpus
    const sectionRows = conn
      .prepare(
        `
      SELECT DISTINCT heading_context FROM chunks
      WHERE heading_context IS NOT NULL AND heading_context != ''
      LIMIT 50
    `
      )
      .all() as Array<{ heading_context: string }>;

    const topSections = sectionRows.map((r) => r.heading_context);

    // Get total word count (approximate from chunk count * avg words)
    const wordCountRow = conn
      .prepare(
        `
      SELECT SUM(LENGTH(text) - LENGTH(REPLACE(text, ' ', '')) + 1) as total_words
      FROM chunks
      LIMIT 10000
    `
      )
      .get() as { total_words: number | null };

    return formatResponse(
      successResult({
        total_documents: documents.length,
        total_chunks: totalChunks,
        total_pages: totalPages,
        total_words: wordCountRow.total_words ?? 0,
        documents: documents.map((d) => ({
          document_id: d.id,
          file_name: d.file_name,
          page_count: d.page_count ?? 0,
          chunk_count: d.chunk_count,
          status: d.status,
        })),
        content_type_distribution: contentTypeDist,
        top_sections: topSections,
        next_steps: [
          { tool: 'ocr_document_summarize', description: 'Summarize a specific document' },
          { tool: 'ocr_search', description: 'Search across all documents' },
          { tool: 'ocr_document_list', description: 'List all documents with filters' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// HELPER: EXTRACT SCHEMA FIELDS FROM CHUNKS
// =============================================================================

/**
 * Extract schema fields from document chunks using pattern matching.
 * No external API calls - pure text analysis.
 */
function extractSchemaFields(
  schema: ContractSchema,
  chunks: Array<{
    id: string;
    text: string;
    page_number: number | null;
    heading_context: string | null;
  }>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of schema.fields) {
    result[field.name] = extractField(field, chunks);
  }

  return result;
}

/**
 * Extract a single field from chunks using heuristic pattern matching.
 */
function extractField(
  field: { name: string; type: string; description: string },
  chunks: Array<{
    id: string;
    text: string;
    page_number: number | null;
    heading_context: string | null;
  }>
): unknown {
  const fieldPatterns = getFieldPatterns(field.name, field.type);
  const matches: Array<{
    text: string;
    chunk_id: string;
    page: number | null;
    confidence: number;
  }> = [];

  for (const chunk of chunks) {
    for (const pattern of fieldPatterns) {
      const regex = new RegExp(pattern, 'gi');
      let match = regex.exec(chunk.text);
      while (match !== null) {
        const context = extractMatchContext(chunk.text, match.index, match[0].length);
        matches.push({
          text: context,
          chunk_id: chunk.id,
          page: chunk.page_number,
          confidence: 0.7,
        });
        match = regex.exec(chunk.text);
      }
    }

    // Also check if heading matches field description
    if (chunk.heading_context) {
      const headingLower = chunk.heading_context.toLowerCase();
      const fieldNameLower = field.name.replace(/_/g, ' ').toLowerCase();
      if (headingLower.includes(fieldNameLower)) {
        matches.push({
          text: chunk.text.substring(0, 500),
          chunk_id: chunk.id,
          page: chunk.page_number,
          confidence: 0.8,
        });
      }
    }
  }

  if (field.type === 'list') {
    return matches.length > 0 ? matches : [];
  }
  if (field.type === 'boolean') {
    return matches.length > 0;
  }
  if (matches.length > 0) {
    // Return best match
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches[0];
  }
  return null;
}

/**
 * Get regex patterns for a given field name and type.
 * Returns patterns that commonly match the field's expected content.
 */
function getFieldPatterns(fieldName: string, _fieldType: string): string[] {
  const patternMap: Record<string, string[]> = {
    parties: [
      'between\\s+([^,]+?)\\s+(?:and|&)\\s+([^,\\.]+)',
      '(?:party|parties)\\s*[:.]\\s*([^\\n]+)',
      '(?:hereinafter|hereafter)\\s+(?:referred to as|called)\\s+"([^"]+)"',
    ],
    effective_date: [
      '(?:effective|start|commencement)\\s+date\\s*[:.]?\\s*([^\\n]{5,30})',
      '(?:dated|entered into)\\s+(?:as of\\s+)?([^\\n]{5,30})',
      '(?:this agreement|this contract).*(?:dated|of)\\s+([^\\n]{5,30})',
    ],
    expiration_date: [
      '(?:expir(?:ation|es?)|end|termination)\\s+date\\s*[:.]?\\s*([^\\n]{5,30})',
      '(?:valid|effective)\\s+(?:until|through)\\s+([^\\n]{5,30})',
    ],
    governing_law: [
      '(?:governing|applicable)\\s+law\\s*[:.]?\\s*([^\\n]+)',
      '(?:governed by|construed under|subject to)\\s+(?:the laws of\\s+)?([^\\n]+)',
      '(?:jurisdiction|venue)\\s*[:.]?\\s*([^\\n]+)',
    ],
    contract_type: [
      '(?:this\\s+)(\\w+\\s+agreement|\\w+\\s+contract)',
      '(?:non-disclosure|confidentiality|master\\s+service|statement\\s+of\\s+work|employment)',
    ],
    total_value: [
      '(?:total|aggregate|contract)\\s+(?:value|amount|price|consideration)\\s*[:.]?\\s*([^\\n]+)',
      '\\$[\\d,]+\\.?\\d*',
      '(?:sum of|amount of)\\s+([^\\n]+)',
    ],
    payment_schedule: [
      '(?:payment|billing)\\s+(?:schedule|terms|frequency)\\s*[:.]?\\s*([^\\n]+)',
      '(?:payable|due|invoiced?)\\s+(?:within|on|by|every)\\s+([^\\n]+)',
      '(?:net\\s+\\d+|\\d+\\s+days)',
    ],
    penalties: [
      '(?:penalty|penalties|liquidated damages|late fee)\\s*[:.]?\\s*([^\\n]+)',
      '(?:interest|surcharge)\\s+(?:of|at)\\s+([^\\n]+)',
    ],
    interest_rate: ['(?:interest|apr|rate)\\s*[:.]?\\s*(\\d+\\.?\\d*\\s*%)'],
    deadlines: [
      '(?:deadline|due date|by|before|no later than)\\s*[:.]?\\s*([^\\n]+)',
      '(?:within|\\d+)\\s+(?:business\\s+)?days',
    ],
    deliverables: ['(?:deliverable|milestone|shall deliver|shall provide)\\s*[:.]?\\s*([^\\n]+)'],
    responsibilities: ['(?:responsible for|shall|obligation|duty|must)\\s+([^\\n]+)'],
    auto_renewal: ['(?:auto(?:-|\\s)?renew|automatically\\s+renew)'],
    renewal_notice_period: [
      '(?:renewal|non-renewal)\\s+notice\\s*[:.]?\\s*([^\\n]+)',
      '(?:notice of)\\s+(?:renewal|non-renewal)\\s+([^\\n]+)',
    ],
    termination_triggers: [
      '(?:terminat(?:e|ion))\\s+(?:upon|if|in the event|for cause)\\s*[:.]?\\s*([^\\n]+)',
      '(?:material breach|default|insolvency|bankruptcy)',
    ],
    termination_notice_period: [
      '(?:termination)\\s+(?:notice|written notice)\\s*[:.]?\\s*([^\\n]+)',
      '(?:\\d+)\\s+(?:days?|months?)\\s+(?:prior\\s+)?(?:written\\s+)?notice',
    ],
    indemnification: [
      '(?:indemnif(?:y|ication|ies))\\s*[:.]?\\s*([^\\n]+)',
      '(?:hold harmless|defend and indemnify)',
    ],
    liability_limit: [
      '(?:limit(?:ation)?\\s+(?:of\\s+)?liability)\\s*[:.]?\\s*([^\\n]+)',
      '(?:aggregate liability|total liability|maximum liability)\\s*[:.]?\\s*([^\\n]+)',
    ],
    force_majeure: ['(?:force majeure|act of god|unforeseeable circumstances)'],
    confidentiality: [
      '(?:confidential(?:ity)?|non-disclosure|proprietary information)\\s*[:.]?\\s*([^\\n]+)',
    ],
    data_protection: [
      '(?:data protection|privacy|gdpr|ccpa|personal data|data processing)\\s*[:.]?\\s*([^\\n]+)',
    ],
  };

  return patternMap[fieldName] ?? [`(?:${fieldName.replace(/_/g, '\\s+')})\\s*[:.]?\\s*([^\\n]+)`];
}

/**
 * Extract context around a match (up to 300 chars)
 */
function extractMatchContext(text: string, matchIndex: number, matchLength: number): string {
  const contextBefore = 50;
  const contextAfter = 200;
  const start = Math.max(0, matchIndex - contextBefore);
  const end = Math.min(text.length, matchIndex + matchLength + contextAfter);
  let result = text.substring(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) result = '...' + result;
  if (end < text.length) result = result + '...';
  return result;
}

// =============================================================================
// TOOL DEFINITIONS EXPORT
// =============================================================================

export const clmTools: Record<string, ToolDefinition> = {
  ocr_contract_extract: {
    description:
      '[PROCESSING] Extract contract-specific information using predefined schemas (contract_metadata, financial_terms, obligations, renewal_termination, compliance_clauses). Uses pattern matching on document chunks - no external API calls. Returns extracted fields organized by schema.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to extract contract information from'),
      schemas: z
        .array(z.string())
        .optional()
        .describe(
          `Schema names to extract (default: all). Available: ${ALL_CONTRACT_SCHEMAS.map((s) => s.name).join(', ')}`
        ),
    },
    handler: handleContractExtract,
  },

  ocr_obligation_list: {
    description:
      '[STATUS] List contract obligations with filters. Auto-marks overdue obligations. Filter by document, type, status, due date range, or responsible party.',
    inputSchema: {
      document_id: z.string().min(1).optional().describe('Filter by document ID'),
      obligation_type: ObligationTypeSchema.optional().describe(
        'Filter by type: payment, delivery, notification, renewal, termination, compliance, reporting, approval, other'
      ),
      status: ObligationStatusSchema.optional().describe(
        'Filter by status: active, fulfilled, overdue, waived, expired'
      ),
      due_before: z.string().optional().describe('Filter obligations due before this ISO date'),
      due_after: z.string().optional().describe('Filter obligations due after this ISO date'),
      responsible_party: z.string().optional().describe('Filter by responsible party name'),
      limit: z.number().int().min(1).max(500).default(50).describe('Max results (1-500)'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    handler: handleObligationList,
  },

  ocr_obligation_update: {
    description:
      '[MANAGE] Update obligation status (active, fulfilled, overdue, waived, expired). Optionally provide a reason which is recorded in status history.',
    inputSchema: {
      obligation_id: z.string().min(1).describe('Obligation ID to update'),
      status: ObligationStatusSchema.describe(
        'New status: active, fulfilled, overdue, waived, or expired'
      ),
      reason: z
        .string()
        .max(1000)
        .optional()
        .describe('Reason for status change (recorded in history)'),
    },
    handler: handleObligationUpdate,
  },

  ocr_obligation_calendar: {
    description:
      '[STATUS] Calendar view of upcoming obligation deadlines grouped by month. Auto-marks overdue obligations. Filter by status or document.',
    inputSchema: {
      months_ahead: z
        .number()
        .int()
        .min(1)
        .max(24)
        .default(3)
        .describe('Number of months to look ahead (1-24, default 3)'),
      status: ObligationStatusSchema.optional().describe('Filter by status'),
      document_id: z.string().min(1).optional().describe('Filter by document ID'),
    },
    handler: handleObligationCalendar,
  },

  ocr_playbook_create: {
    description:
      '[SETUP] Create a playbook of preferred contract terms for deviation detection. Each clause has a name, preferred text, severity (critical/major/minor), and optional alternatives.',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Playbook name'),
      description: z.string().max(2000).optional().describe('Playbook description'),
      clauses: z
        .array(
          z.object({
            clause_name: z.string().min(1).max(200).describe('Clause identifier name'),
            preferred_text: z.string().min(1).max(5000).describe('Preferred contract language'),
            severity: ClauseSeveritySchema.describe(
              'Deviation severity: critical, major, or minor'
            ),
            alternatives: z
              .array(z.string().max(5000))
              .default([])
              .describe('Acceptable alternative texts'),
          })
        )
        .min(1)
        .describe('Array of clause definitions'),
    },
    handler: handlePlaybookCreate,
  },

  ocr_playbook_compare: {
    description:
      '[ANALYSIS] Compare a document against a playbook to detect deviations from preferred terms. Returns clause-by-clause match/deviation status with compliance score.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to compare'),
      playbook_id: z.string().min(1).describe('Playbook ID to compare against'),
    },
    handler: handlePlaybookCompare,
  },

  ocr_playbook_list: {
    description:
      '[STATUS] List all available playbooks with clause counts. Use to find a playbook for comparison.',
    inputSchema: {},
    handler: handlePlaybookList,
  },

  ocr_document_summarize: {
    description:
      '[ANALYSIS] Generate a structured summary of a document from its chunks. Returns key sections, content types, word count, and section previews. No external API calls.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to summarize'),
    },
    handler: handleDocumentSummarize,
  },

  ocr_corpus_summarize: {
    description:
      '[ANALYSIS] Summarize the entire document corpus. Returns document count, total pages/words, content type distribution, and top sections across all documents.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Max documents to include (1-500, default 100)'),
    },
    handler: handleCorpusSummarize,
  },
};
