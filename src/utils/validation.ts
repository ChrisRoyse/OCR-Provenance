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

/**
 * Safely validate input without throwing, returns result object
 *
 * @param schema - Zod schema to validate against
 * @param input - Input value to validate
 * @returns Object with success status and either data or error
 */
export function safeValidateInput<T>(
  schema: z.ZodSchema<T>,
  input: unknown
): { success: true; data: T } | { success: false; error: ValidationError } {
  const result = schema.safeParse(input);
  if (!result.success) {
    const errors = result.error.errors.map((e) => {
      const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
      return `${path}${e.message}`;
    });
    return { success: false, error: new ValidationError(errors.join('; ')) };
  }
  return { success: true, data: result.data };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED ENUMS AND BASE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * OCR processing mode enum
 */
export const OCRMode = z.enum(['fast', 'balanced', 'accurate']);

/**
 * Document/processing status
 */
export const ProcessingStatus = z.enum(['pending', 'processing', 'complete', 'failed']);

/**
 * Item type for provenance lookups
 */
export const ItemType = z.enum(['document', 'ocr_result', 'chunk', 'embedding', 'auto']);

/**
 * Provenance output format
 */
export const ProvenanceFormat = z.enum(['chain', 'tree', 'flat']);

/**
 * Export format for provenance data
 */
export const ExportFormat = z.enum(['json', 'w3c-prov', 'csv']);

/**
 * Export scope for provenance exports
 */
export const ExportScope = z.enum(['document', 'database', 'all']);

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
  'log_level',
]);

/**
 * Sort order for list operations
 */
export const SortOrder = z.enum(['asc', 'desc']);

/**
 * Document list sort fields
 */
export const DocumentSortField = z.enum(['created_at', 'file_name', 'file_size']);

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
export const DEFAULT_FILE_TYPES = ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'docx', 'doc'];

/**
 * Schema for ingesting a directory
 */
export const IngestDirectoryInput = z.object({
  directory_path: z.string().min(1, 'Directory path is required'),
  recursive: z.boolean().default(true),
  file_types: z.array(z.string()).optional().default(DEFAULT_FILE_TYPES),
  ocr_mode: OCRMode.default('balanced'),
  auto_process: z.boolean().default(false),
});

/**
 * Schema for ingesting specific files
 */
export const IngestFilesInput = z.object({
  file_paths: z
    .array(z.string().min(1, 'File path cannot be empty'))
    .min(1, 'At least one file path is required'),
  ocr_mode: OCRMode.default('balanced'),
  auto_process: z.boolean().default(false),
});

/**
 * Schema for processing pending documents
 */
export const ProcessPendingInput = z.object({
  max_concurrent: z.number().int().min(1).max(10).default(3),
  ocr_mode: OCRMode.optional(),
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
 * Schema for semantic search
 */
export const SearchSemanticInput = z.object({
  query: z.string().min(1, 'Query is required').max(1000, 'Query must be 1000 characters or less'),
  limit: z.number().int().min(1).max(100).default(10),
  similarity_threshold: z.number().min(0).max(1).default(0.7),
  include_provenance: z.boolean().default(false),
  document_filter: z.array(z.string()).optional(),
});

/**
 * Schema for keyword search (BM25 full-text)
 */
export const SearchInput = z.object({
  query: z.string().min(1, 'Query is required').max(1000, 'Query must be 1000 characters or less'),
  limit: z.number().int().min(1).max(100).default(10),
  phrase_search: z.boolean().default(false),
  include_highlight: z.boolean().default(true),
  include_provenance: z.boolean().default(false),
  document_filter: z.array(z.string()).optional(),
});

/**
 * Schema for hybrid search (RRF fusion of BM25 + semantic)
 */
export const SearchHybridInput = z.object({
  query: z.string().min(1, 'Query is required').max(1000, 'Query must be 1000 characters or less'),
  limit: z.number().int().min(1).max(100).default(10),
  bm25_weight: z.number().min(0).max(2).default(1.0),
  semantic_weight: z.number().min(0).max(2).default(1.0),
  rrf_k: z.number().int().min(1).max(100).default(60),
  include_provenance: z.boolean().default(false),
  document_filter: z.array(z.string()).optional(),
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
  status_filter: ProcessingStatus.optional(),
  sort_by: DocumentSortField.default('created_at'),
  sort_order: SortOrder.default('desc'),
  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),
});

/**
 * Schema for getting a specific document
 */
export const DocumentGetInput = z.object({
  document_id: z.string().uuid('Invalid document ID format'),
  include_text: z.boolean().default(false),
  include_chunks: z.boolean().default(false),
  include_full_provenance: z.boolean().default(false),
});

/**
 * Schema for deleting a document
 */
export const DocumentDeleteInput = z.object({
  document_id: z.string().uuid('Invalid document ID format'),
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Confirm must be true to delete document' }),
  }),
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
  format: ProvenanceFormat.default('chain'),
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
    output_path: z.string().optional(),
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
// TYPE EXPORTS (inferred from schemas)
// ═══════════════════════════════════════════════════════════════════════════════

// Enum types
export type OCRMode = z.infer<typeof OCRMode>;
export type ProcessingStatus = z.infer<typeof ProcessingStatus>;
export type ItemType = z.infer<typeof ItemType>;
export type ProvenanceFormat = z.infer<typeof ProvenanceFormat>;
export type ExportFormat = z.infer<typeof ExportFormat>;
export type ExportScope = z.infer<typeof ExportScope>;
export type ConfigKey = z.infer<typeof ConfigKey>;
export type SortOrder = z.infer<typeof SortOrder>;
export type DocumentSortField = z.infer<typeof DocumentSortField>;

// Database management types
export type DatabaseCreateInput = z.infer<typeof DatabaseCreateInput>;
export type DatabaseListInput = z.infer<typeof DatabaseListInput>;
export type DatabaseSelectInput = z.infer<typeof DatabaseSelectInput>;
export type DatabaseStatsInput = z.infer<typeof DatabaseStatsInput>;
export type DatabaseDeleteInput = z.infer<typeof DatabaseDeleteInput>;

// Document ingestion types
export type IngestDirectoryInput = z.infer<typeof IngestDirectoryInput>;
export type IngestFilesInput = z.infer<typeof IngestFilesInput>;
export type ProcessPendingInput = z.infer<typeof ProcessPendingInput>;
export type OCRStatusInput = z.infer<typeof OCRStatusInput>;

// Search types
export type SearchSemanticInput = z.infer<typeof SearchSemanticInput>;
export type SearchInput = z.infer<typeof SearchInput>;
export type SearchHybridInput = z.infer<typeof SearchHybridInput>;
export type FTSManageInput = z.infer<typeof FTSManageInput>;

// Document management types
export type DocumentListInput = z.infer<typeof DocumentListInput>;
export type DocumentGetInput = z.infer<typeof DocumentGetInput>;
export type DocumentDeleteInput = z.infer<typeof DocumentDeleteInput>;

// Provenance types
export type ProvenanceGetInput = z.infer<typeof ProvenanceGetInput>;
export type ProvenanceVerifyInput = z.infer<typeof ProvenanceVerifyInput>;
export type ProvenanceExportInput = z.infer<typeof ProvenanceExportInput>;

// Config types
export type ConfigGetInput = z.infer<typeof ConfigGetInput>;
export type ConfigSetInput = z.infer<typeof ConfigSetInput>;
