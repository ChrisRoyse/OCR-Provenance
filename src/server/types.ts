/**
 * MCP Server Type Definitions
 *
 * Defines interfaces for tool results, server configuration, and state.
 *
 * @module server/types
 */

import type { ErrorCategory } from './errors.js';
import type { DatabaseService } from '../services/storage/database/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Error structure for failed tool operations
 */
export interface ToolError {
  category: ErrorCategory;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Successful tool result
 */
export interface ToolResultSuccess<T = unknown> {
  success: true;
  data: T;
}

/**
 * Failed tool result
 */
export interface ToolResultFailure {
  success: false;
  error: ToolError;
}

/**
 * Union type for all tool results
 */
export type ToolResult<T = unknown> = ToolResultSuccess<T> | ToolResultFailure;

/**
 * Helper to create success result
 */
export function successResult<T>(data: T): ToolResultSuccess<T> {
  return { success: true, data };
}

/**
 * Helper to create failure result
 */
export function failureResult(
  category: ErrorCategory,
  message: string,
  details?: Record<string, unknown>
): ToolResultFailure {
  return {
    success: false,
    error: { category, message, details },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * OCR processing mode
 */
export type OCRMode = 'fast' | 'balanced' | 'accurate';

/**
 * Image optimization configuration
 */
export interface ImageOptimizationConfig {
  /** Enable image optimization (default: true) */
  enabled: boolean;

  /** Maximum width for OCR resize - Datalab API limit (default: 4800) */
  ocrMaxWidth: number;

  /** Maximum dimension for VLM resize - optimize tokens (default: 2048) */
  vlmMaxDimension: number;

  /** Skip images smaller than this for VLM (default: 50) */
  vlmSkipBelowSize: number;

  /** Minimum relevance score for VLM processing (default: 0.3) */
  vlmMinRelevance: number;

  /** Skip images predicted as logos/icons (default: true) */
  vlmSkipLogosIcons: boolean;
}

/**
 * Server configuration options
 */
export interface ServerConfig {
  /** Default path for database storage */
  defaultStoragePath: string;

  /** Default OCR processing mode */
  defaultOCRMode: OCRMode;

  /** Maximum concurrent OCR operations */
  maxConcurrent: number;

  /** Batch size for embedding generation */
  embeddingBatchSize: number;

  /** GPU device for embedding generation */
  embeddingDevice: string;

  /** Chunk size in characters */
  chunkSize: number;

  /** Chunk overlap percentage (0-50) */
  chunkOverlapPercent: number;

  /** Log level */
  logLevel: string;

  /** Image optimization settings */
  imageOptimization: ImageOptimizationConfig;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Server state tracking
 */
export interface ServerState {
  /** Currently selected database instance */
  currentDatabase: DatabaseService | null;

  /** Name of the currently selected database */
  currentDatabaseName: string | null;

  /** Server configuration */
  config: ServerConfig;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE OPERATION RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Result of database creation
 */
export interface DatabaseCreateResult {
  name: string;
  path: string;
  created: true;
  description?: string;
}

/**
 * Database info for listing
 */
export interface DatabaseListItem {
  name: string;
  path: string;
  size_bytes: number;
  created_at: string;
  modified_at: string;
  document_count?: number;
  chunk_count?: number;
  embedding_count?: number;
}

/**
 * Result of database selection
 */
export interface DatabaseSelectResult {
  name: string;
  path: string;
  selected: true;
  stats?: {
    document_count: number;
    chunk_count: number;
    embedding_count: number;
    vector_count: number;
  };
}

/**
 * Database statistics
 */
export interface DatabaseStatsResult {
  name: string;
  path: string;
  size_bytes: number;
  document_count: number;
  chunk_count: number;
  embedding_count: number;
  provenance_count: number;
  ocr_result_count: number;
  pending_documents: number;
  processing_documents: number;
  complete_documents: number;
  failed_documents: number;
}

/**
 * Result of database deletion
 */
export interface DatabaseDeleteResult {
  name: string;
  deleted: true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT OPERATION RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Document summary for listing
 */
export interface DocumentListItem {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  file_type: string;
  status: string;
  page_count: number | null;
  created_at: string;
}

/**
 * Document list result
 */
export interface DocumentListResult {
  documents: DocumentListItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Full document details
 */
export interface DocumentGetResult {
  id: string;
  file_name: string;
  file_path: string;
  file_hash: string;
  file_size: number;
  file_type: string;
  status: string;
  page_count: number | null;
  created_at: string;
  provenance_id: string;
  ocr_text?: string;
  chunks?: ChunkInfo[];
  provenance_chain?: ProvenanceInfo[];
}

/**
 * Chunk information
 */
export interface ChunkInfo {
  id: string;
  chunk_index: number;
  text_length: number;
  page_number: number | null;
  character_start: number;
  character_end: number;
  embedding_status: string;
}

/**
 * Provenance information
 */
export interface ProvenanceInfo {
  id: string;
  type: string;
  chain_depth: number;
  processor: string;
  processor_version: string;
  content_hash: string;
  created_at: string;
}

/**
 * Result of document deletion
 */
export interface DocumentDeleteResult {
  document_id: string;
  deleted: true;
  chunks_deleted: number;
  embeddings_deleted: number;
  vectors_deleted: number;
  provenance_deleted: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Semantic search result item
 */
export interface SemanticSearchItem {
  embedding_id: string;
  chunk_id: string;
  document_id: string;
  similarity_score: number;
  original_text: string;
  source_file_path: string;
  source_file_name: string;
  page_number: number | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  total_chunks: number;
  provenance?: ProvenanceInfo[];
}

/**
 * Semantic search result
 */
export interface SemanticSearchResult {
  query: string;
  results: SemanticSearchItem[];
  total: number;
  threshold: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INGESTION RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * File ingestion item
 */
export interface IngestFileItem {
  file_path: string;
  file_name: string;
  document_id: string;
  status: 'pending' | 'skipped' | 'error';
  error_message?: string;
}

/**
 * Directory ingestion result
 */
export interface IngestDirectoryResult {
  directory_path: string;
  files_found: number;
  files_ingested: number;
  files_skipped: number;
  files_errored: number;
  items: IngestFileItem[];
}

/**
 * Files ingestion result
 */
export interface IngestFilesResult {
  files_ingested: number;
  files_skipped: number;
  files_errored: number;
  items: IngestFileItem[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Provenance chain result
 */
export interface ProvenanceGetResult {
  item_id: string;
  item_type: string;
  chain: ProvenanceInfo[];
  root_document_id: string;
}

/**
 * Verification step result
 */
export interface VerificationStep {
  provenance_id: string;
  type: string;
  chain_depth: number;
  content_verified: boolean;
  chain_verified: boolean;
  expected_hash: string;
  computed_hash?: string;
  error?: string;
}

/**
 * Provenance verification result
 */
export interface ProvenanceVerifyResult {
  item_id: string;
  verified: boolean;
  content_integrity: boolean;
  chain_integrity: boolean;
  steps: VerificationStep[];
  errors?: string[];
}

/**
 * Provenance export result
 */
export interface ProvenanceExportResult {
  scope: string;
  format: string;
  document_id?: string;
  output_path?: string;
  record_count: number;
  data?: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OCR STATUS RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * OCR status item
 */
export interface OCRStatusItem {
  document_id: string;
  file_name: string;
  status: string;
  page_count: number | null;
  error_message?: string;
  created_at: string;
}

/**
 * OCR status result
 */
export interface OCRStatusResult {
  documents: OCRStatusItem[];
  summary: {
    total: number;
    pending: number;
    processing: number;
    complete: number;
    failed: number;
  };
}

/**
 * Process pending result
 */
export interface ProcessPendingResult {
  processed: number;
  failed: number;
  items: Array<{
    document_id: string;
    file_name: string;
    status: 'complete' | 'failed';
    error_message?: string;
  }>;
}
