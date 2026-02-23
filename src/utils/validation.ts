/**
 * OCR Provenance MCP System - Zod Validation Schemas
 *
 * This module provides comprehensive input validation for all MCP tool inputs.
 * Each schema includes:
 * - Type validation
 * - Constraint validation (min/max, patterns, etc.)
 * - Descriptive error messages
 * - Default values where appropriate
 *
 * @module utils/validation
 */

import { z } from 'zod';
import * as path from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM ERROR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Custom validation error with descriptive message
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate input against schema and throw descriptive error if invalid
 *
 * @param schema - Zod schema to validate against
 * @param input - Input value to validate
 * @returns Validated and typed input data
 * @throws ValidationError with descriptive message if validation fails
 */
export function validateInput<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const errors = result.error.errors.map((e) => {
      const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
      return `${path}${e.message}`;
    });
    throw new ValidationError(errors.join('; '));
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED ENUMS AND BASE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * OCR processing mode enum
 */
export const OCRMode = z.enum(['fast', 'balanced', 'accurate']);

/**
 * Item type for provenance lookups
 */
export const ItemType = z.enum([
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
]);

/**
 * Export format for provenance data
 */
export const ExportFormat = z.enum(['json', 'w3c-prov', 'csv']);

/**
 * Export scope for provenance exports
 */
export const ExportScope = z.enum(['document', 'database']);

/**
 * Configuration keys that can be set
 */
export const ConfigKey = z.enum([
  'datalab_default_mode',
  'datalab_max_concurrent',
  'embedding_batch_size',
  'embedding_device',
  'chunk_size',
  'chunk_overlap_percent',
  'max_chunk_size',
  'auto_cluster_enabled',
  'auto_cluster_threshold',
  'auto_cluster_algorithm',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE MANAGEMENT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Schema for creating a new database
 */
export const DatabaseCreateInput = z.object({
  name: z
    .string()
    .min(1, 'Database name is required')
    .max(64, 'Database name must be 64 characters or less')
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'Database name must contain only alphanumeric characters, underscores, and hyphens'
    ),
  description: z.string().max(500, 'Description must be 500 characters or less').optional(),
  storage_path: z.string().optional(),
});

/**
 * Schema for listing databases
 */
export const DatabaseListInput = z.object({
  include_stats: z.boolean().default(false),
});

/**
 * Schema for selecting a database
 */
export const DatabaseSelectInput = z.object({
  database_name: z.string().min(1, 'Database name is required'),
});

/**
 * Schema for getting database statistics
 */
export const DatabaseStatsInput = z.object({
  database_name: z.string().optional(),
});

/**
 * Schema for deleting a database
 */
export const DatabaseDeleteInput = z.object({
  database_name: z.string().min(1, 'Database name is required'),
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Confirm must be true to delete database' }),
  }),
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT INGESTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default supported file types for ingestion
 */
export const DEFAULT_FILE_TYPES = [
  // Documents
  'pdf',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'xlsx',
  'xls',
  // Images
  'png',
  'jpg',
  'jpeg',
  'tiff',
  'tif',
  'bmp',
  'gif',
  'webp',
  // Text
  'txt',
  'csv',
  'md',
];

/**
 * Schema for ingesting a directory
 */
export const IngestDirectoryInput = z.object({
  directory_path: z.string().min(1, 'Directory path is required'),
  recursive: z.boolean().default(true),
  file_types: z.array(z.string()).optional().default(DEFAULT_FILE_TYPES),
});

/**
 * Schema for ingesting specific files
 */
export const IngestFilesInput = z.object({
  file_paths: z
    .array(z.string().min(1, 'File path cannot be empty'))
    .min(1, 'At least one file path is required'),
});

/**
 * Schema for processing pending documents
 */
export const ProcessPendingInput = z.object({
  max_concurrent: z.number().int().min(1).max(10).default(3),
  ocr_mode: OCRMode.optional(),
  // Datalab API parameters
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(7000)
    .optional()
    .describe('Maximum pages to process per document (Datalab limit: 7000)'),
  page_range: z
    .string()
    .regex(/^[0-9,\-\s]+$/)
    .optional()
    .describe('Specific pages to process, 0-indexed (e.g., "0-5,10")'),
  skip_cache: z.boolean().optional().describe('Force reprocessing, skip Datalab cache'),
  disable_image_extraction: z
    .boolean()
    .optional()
    .describe('Skip image extraction for text-only processing'),
  extras: z
    .array(
      z.enum([
        'track_changes',
        'chart_understanding',
        'extract_links',
        'table_row_bboxes',
        'infographic',
        'new_block_types',
      ])
    )
    .optional()
    .describe('Extra Datalab features to enable'),
  page_schema: z
    .string()
    .optional()
    .describe('JSON schema string for structured data extraction per page'),
  additional_config: z
    .record(z.unknown())
    .optional()
    .describe(
      'Additional Datalab config: keep_pageheader_in_output, keep_pagefooter_in_output, keep_spreadsheet_formatting'
    ),
});

/**
 * Schema for checking OCR status
 */
export const OCRStatusInput = z.object({
  document_id: z.string().optional(),
  status_filter: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('all'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Metadata filter for filtering search results by document metadata
 */
export const MetadataFilter = z
  .object({
    doc_title: z.string().optional(),
    doc_author: z.string().optional(),
    doc_subject: z.string().optional(),
  })
  .optional();

/**
 * Page range filter for chunk-level filtering
 */
export const PageRangeFilter = z
  .object({
    min_page: z.number().int().min(1).optional(),
    max_page: z.number().int().min(1).optional(),
  })
  .optional();

/**
 * Search filters sub-object schema.
 * Groups all filter parameters into a single `filters` object to reduce
 * the top-level parameter count and improve schema clarity.
 */
export const SearchFilters = z.object({
  document_filter: z.array(z.string()).optional()
    .describe('Restrict results to specific document IDs'),
  metadata_filter: MetadataFilter
    .describe('Filter by document metadata (doc_title, doc_author, doc_subject)'),
  cluster_id: z.string().optional()
    .describe('Filter results to documents in this cluster'),
  content_type_filter: z
    .array(z.string())
    .optional()
    .describe('Filter by chunk content types (e.g., ["table", "code", "heading"])'),
  section_path_filter: z
    .string()
    .optional()
    .describe('Filter by section path prefix (e.g., "Section 3" matches "Section 3 > 3.1 > Definitions")'),
  heading_filter: z
    .string()
    .optional()
    .describe('Filter by heading context text (LIKE match)'),
  page_range_filter: PageRangeFilter.describe('Filter results to specific page range'),
  is_atomic_filter: z.boolean().optional()
    .describe('When true, return only atomic chunks (complete tables, figures, code blocks). When false, exclude atomic chunks.'),
  heading_level_filter: z.object({
    min_level: z.number().int().min(1).max(6).optional(),
    max_level: z.number().int().min(1).max(6).optional(),
  }).optional().describe('Filter by heading level (1=h1 top-level, 6=h6 deepest)'),
  min_page_count: z.number().int().min(1).optional()
    .describe('Only include results from documents with at least this many pages'),
  max_page_count: z.number().int().min(1).optional()
    .describe('Only include results from documents with at most this many pages'),
  table_columns_contain: z.string().optional()
    .describe('Filter to table chunks whose column headers contain this text (case-insensitive match on stored table_columns in processing_params)'),
  min_quality_score: z
    .number()
    .min(0)
    .max(5)
    .optional()
    .describe('Minimum OCR quality score (0-5). Filters documents with low-quality OCR results.'),
}).optional().default({});

/**
 * Unified search schema - single schema for keyword, semantic, and hybrid search.
 * Mode parameter selects the search strategy. Defaults that are always-on are
 * hardcoded in the handler (quality_boost, expand_query, exclude_duplicate_chunks,
 * exclude headers/footers, include cluster context).
 *
 * Filter parameters are grouped under `filters` to reduce top-level parameter count.
 */
export const SearchUnifiedInput = z.object({
  // ── Core parameters ─────────────────────────────────────────────────────
  query: z.string().min(1, 'Query is required').max(1000, 'Query must be 1000 characters or less'),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('hybrid')
    .describe('Search mode: keyword (BM25), semantic (vector), or hybrid (BM25+semantic fusion). Default: hybrid.'),
  limit: z.number().int().min(1).max(100).default(10),
  include_provenance: z.boolean().default(false),
  rerank: z
    .boolean()
    .default(false)
    .describe('Re-rank results using local cross-encoder model for contextual relevance scoring'),
  include_context_chunks: z.number().int().min(0).max(3).default(0)
    .describe('Number of neighboring chunks to include before and after each result (0=none, max 3). Adds context_before and context_after arrays.'),
  group_by_document: z.boolean().default(false)
    .describe('Group results by source document with document-level statistics'),

  // ── Filters (grouped) ──────────────────────────────────────────────────
  filters: SearchFilters,

  // ── Keyword-mode specific ───────────────────────────────────────────────
  phrase_search: z.boolean().default(false)
    .describe('(keyword mode) Treat query as exact phrase'),
  include_highlight: z.boolean().default(true)
    .describe('(keyword mode) Include highlighted snippets'),

  // ── Semantic-mode specific ──────────────────────────────────────────────
  similarity_threshold: z.number().min(0).max(1).default(0.7)
    .describe('(semantic mode) Minimum similarity score (0-1)'),

  // ── Hybrid-mode specific ────────────────────────────────────────────────
  bm25_weight: z.number().min(0).max(2).default(1.0)
    .describe('(hybrid mode) BM25 result weight'),
  semantic_weight: z.number().min(0).max(2).default(1.0)
    .describe('(hybrid mode) Semantic result weight'),
  rrf_k: z.number().int().min(1).max(100).default(60)
    .describe('(hybrid mode) RRF smoothing constant'),
  auto_route: z.boolean().default(true)
    .describe('(hybrid mode) Auto-adjust BM25/semantic weights based on query classification'),

  // ── V7 Intelligence Optimization ──────────────────────────────────────
  compact: z.boolean().default(false)
    .describe('When true, return only essential fields per result (document_id, chunk_id, original_text, source_file_name, page_number, score, result_type) for ~77% token reduction'),
  include_provenance_summary: z.boolean().default(false)
    .describe('When true, add a one-line provenance_summary string to each result showing the data lineage chain'),
});

/**
 * Schema for FTS5 index management
 */
export const FTSManageInput = z.object({
  action: z.enum(['rebuild', 'status']),
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT MANAGEMENT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Schema for listing documents
 */
export const DocumentListInput = z.object({
  status_filter: z.enum(['pending', 'processing', 'complete', 'failed']).optional(),
  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),
  created_after: z.string().datetime().optional()
    .describe('Filter documents created after this ISO 8601 timestamp'),
  created_before: z.string().datetime().optional()
    .describe('Filter documents created before this ISO 8601 timestamp'),
  file_type: z.string().optional()
    .describe('Filter by file type (e.g., "pdf", "docx")'),
});

/**
 * Schema for getting a specific document
 */
export const DocumentGetInput = z.object({
  document_id: z.string().min(1, 'Document ID is required'),
  include_text: z.boolean().default(false),
  include_chunks: z.boolean().default(false),
  include_blocks: z.boolean().default(false),
  include_full_provenance: z.boolean().default(false),
});

/**
 * Schema for deleting a document
 */
export const DocumentDeleteInput = z.object({
  document_id: z.string().min(1, 'Document ID is required'),
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Confirm must be true to delete document' }),
  }),
});

/**
 * Schema for retrying failed documents
 */
export const RetryFailedInput = z.object({
  document_id: z.string().min(1).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Schema for getting provenance information
 */
export const ProvenanceGetInput = z.object({
  item_id: z.string().min(1, 'Item ID is required'),
  item_type: ItemType.default('auto'),
});

/**
 * Schema for verifying provenance integrity
 */
export const ProvenanceVerifyInput = z.object({
  item_id: z.string().min(1, 'Item ID is required'),
  verify_content: z.boolean().default(true),
  verify_chain: z.boolean().default(true),
});

/**
 * Schema for exporting provenance data
 */
export const ProvenanceExportInput = z
  .object({
    scope: ExportScope,
    document_id: z.string().optional(),
    format: ExportFormat.default('json'),
  })
  .refine((data) => data.scope !== 'document' || data.document_id !== undefined, {
    message: 'document_id is required when scope is "document"',
    path: ['document_id'],
  });

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Schema for getting configuration
 */
export const ConfigGetInput = z.object({
  key: ConfigKey.optional(),
});

/**
 * Schema for setting configuration
 */
export const ConfigSetInput = z.object({
  key: ConfigKey,
  value: z.union([z.string(), z.number(), z.boolean()]),
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATH SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the default set of allowed base directories.
 *
 * SEC-002: Paths MUST always be validated against allowed directories.
 * The default set covers all directories the system legitimately needs:
 *   - The storage path (database location) from server config
 *   - The user's home directory (documents live here)
 *   - /tmp for temporary files
 *   - The current working directory (project root)
 *
 * This function is called lazily so it picks up the current config at call time.
 */
function getDefaultAllowedBaseDirs(): string[] {
  // Lazy require to avoid circular dependency (validation.ts is imported by tools
  // which are imported by state.ts consumers). We only need the config value.
  let storagePath: string;
  try {
    // Synchronous require via createRequire (same pattern as vector.ts, schema-helpers.ts).
    // Reads DEFAULT_STORAGE_PATH from helpers module which has no circular deps.
    const { DEFAULT_STORAGE_PATH } = require('../services/storage/database/helpers.js');
    storagePath = DEFAULT_STORAGE_PATH;
  } catch {
    // Fallback if helpers not available (e.g., during early init)
    storagePath = path.join(homedir(), '.ocr-provenance', 'databases');
  }

  return [
    path.resolve(storagePath),
    path.resolve(homedir()),
    path.resolve('/tmp'),
    path.resolve(process.cwd()),
  ];
}

/**
 * Sanitize a file path to prevent directory traversal attacks.
 *
 * SEC-002 ENFORCEMENT: Paths are ALWAYS validated against allowed directories.
 * When no allowedBaseDirs are provided, a default set is used that covers
 * the storage path, home directory, /tmp, and the current working directory.
 *
 * - Rejects null bytes
 * - Resolves the path fully via path.resolve() to eliminate '..' segments
 * - Verifies the resolved path starts with one of the allowed base directories
 *
 * @param filePath - The file path to sanitize
 * @param allowedBaseDirs - Optional array of allowed base directories. When omitted,
 *   defaults to [storagePath, homedir, /tmp, cwd] per SEC-002.
 * @returns The resolved, safe path
 * @throws ValidationError if the path contains null bytes or escapes allowed directories
 */
export function sanitizePath(filePath: string, allowedBaseDirs?: string[]): string {
  if (filePath.includes('\0')) {
    throw new ValidationError('Path contains null bytes');
  }

  const resolved = path.resolve(filePath);

  // SEC-002: ALWAYS enforce path restrictions. Use defaults when none provided.
  const baseDirs = (allowedBaseDirs && allowedBaseDirs.length > 0)
    ? allowedBaseDirs
    : getDefaultAllowedBaseDirs();

  const resolvedBases = baseDirs.map((d) => path.resolve(d));
  const withinAllowed = resolvedBases.some(
    (base) => resolved === base || resolved.startsWith(base + path.sep)
  );
  if (!withinAllowed) {
    throw new ValidationError(
      `Path "${resolved}" is outside allowed directories: ${resolvedBases.join(', ')}`
    );
  }

  return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQL ESCAPING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Escape special characters for safe use in SQL LIKE clauses.
 * Escapes '%', '_', and '\' characters.
 *
 * @param pattern - The raw string to escape
 * @returns The escaped string safe for LIKE clause usage
 */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
