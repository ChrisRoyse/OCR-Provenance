/**
 * Type definitions for DatabaseService
 *
 * Contains all interfaces, enums, and row types used by the database service.
 */

import { DocumentStatus } from '../../../models/document.js';

/**
 * Database information interface
 */
export interface DatabaseInfo {
  name: string;
  path: string;
  size_bytes: number;
  created_at: string;
  last_modified_at: string;
  total_documents: number;
  total_ocr_results: number;
  total_chunks: number;
  total_embeddings: number;
}

/**
 * Database statistics interface
 */
export interface DatabaseStats {
  name: string;
  total_documents: number;
  documents_by_status: {
    pending: number;
    processing: number;
    complete: number;
    failed: number;
  };
  total_ocr_results: number;
  total_chunks: number;
  chunks_by_embedding_status: {
    pending: number;
    complete: number;
    failed: number;
  };
  total_embeddings: number;
  total_images: number;
  total_extractions: number;
  total_form_fills: number;
  total_provenance: number;
  storage_size_bytes: number;
  avg_chunks_per_document: number;
  avg_embeddings_per_chunk: number;
}

/**
 * Document list options
 */
export interface ListDocumentsOptions {
  status?: DocumentStatus;
  limit?: number;
  offset?: number;
}

/**
 * Error codes for database operations
 */
export enum DatabaseErrorCode {
  DATABASE_NOT_FOUND = 'DATABASE_NOT_FOUND',
  DATABASE_ALREADY_EXISTS = 'DATABASE_ALREADY_EXISTS',
  DATABASE_LOCKED = 'DATABASE_LOCKED',
  DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
  OCR_RESULT_NOT_FOUND = 'OCR_RESULT_NOT_FOUND',
  CHUNK_NOT_FOUND = 'CHUNK_NOT_FOUND',
  EMBEDDING_NOT_FOUND = 'EMBEDDING_NOT_FOUND',
  IMAGE_NOT_FOUND = 'IMAGE_NOT_FOUND',
  PROVENANCE_NOT_FOUND = 'PROVENANCE_NOT_FOUND',
  FOREIGN_KEY_VIOLATION = 'FOREIGN_KEY_VIOLATION',
  SCHEMA_MISMATCH = 'SCHEMA_MISMATCH',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INVALID_NAME = 'INVALID_NAME',
}

/**
 * Custom error class for database operations
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code: DatabaseErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/**
 * Database row type for metadata
 */
export interface MetadataRow {
  database_name: string;
  database_version: string;
  created_at: string;
  last_modified_at: string;
  total_documents: number;
  total_ocr_results: number;
  total_chunks: number;
  total_embeddings: number;
}

/**
 * Database row type for documents
 */
export interface DocumentRow {
  id: string;
  file_path: string;
  file_name: string;
  file_hash: string;
  file_size: number;
  file_type: string;
  status: string;
  page_count: number | null;
  provenance_id: string;
  created_at: string;
  modified_at: string | null;
  ocr_completed_at: string | null;
  error_message: string | null;
  doc_title: string | null;
  doc_author: string | null;
  doc_subject: string | null;
}

/**
 * Database row type for OCR results
 */
export interface OCRResultRow {
  id: string;
  provenance_id: string;
  document_id: string;
  extracted_text: string;
  text_length: number;
  datalab_request_id: string;
  datalab_mode: string;
  parse_quality_score: number | null;
  page_count: number;
  cost_cents: number | null;
  content_hash: string;
  processing_started_at: string;
  processing_completed_at: string;
  processing_duration_ms: number;
}

/**
 * Database row type for chunks
 */
export interface ChunkRow {
  id: string;
  document_id: string;
  ocr_result_id: string;
  text: string;
  text_hash: string;
  chunk_index: number;
  character_start: number;
  character_end: number;
  page_number: number | null;
  page_range: string | null;
  overlap_previous: number;
  overlap_next: number;
  provenance_id: string;
  created_at: string;
  embedding_status: string;
  embedded_at: string | null;
}

/**
 * Database row type for embeddings (without vector)
 * chunk_id is for text embeddings, image_id is for VLM description embeddings
 * At least one of chunk_id or image_id must be set
 */
export interface EmbeddingRow {
  id: string;
  chunk_id: string | null;
  image_id: string | null;
  document_id: string;
  original_text: string;
  original_text_length: number;
  source_file_path: string;
  source_file_name: string;
  source_file_hash: string;
  page_number: number | null;
  page_range: string | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  total_chunks: number;
  model_name: string;
  model_version: string;
  task_type: string;
  inference_mode: string;
  gpu_device: string | null;
  provenance_id: string;
  content_hash: string;
  created_at: string;
  generation_duration_ms: number | null;
}

/**
 * Database row type for provenance
 */
export interface ProvenanceRow {
  id: string;
  type: string;
  created_at: string;
  processed_at: string;
  source_file_created_at: string | null;
  source_file_modified_at: string | null;
  source_type: string;
  source_path: string | null;
  source_id: string | null;
  root_document_id: string;
  location: string | null;
  content_hash: string;
  input_hash: string | null;
  file_hash: string | null;
  processor: string;
  processor_version: string;
  processing_params: string;
  processing_duration_ms: number | null;
  processing_quality_score: number | null;
  parent_id: string | null;
  parent_ids: string;
  chain_depth: number;
  chain_path: string | null;
}

/**
 * Database row type for images
 */
export interface ImageRow {
  id: string;
  document_id: string;
  ocr_result_id: string;
  page_number: number;
  bbox_x: number;
  bbox_y: number;
  bbox_width: number;
  bbox_height: number;
  image_index: number;
  format: string;
  width: number;
  height: number;
  extracted_path: string | null;
  file_size: number | null;
  vlm_status: string;
  vlm_description: string | null;
  vlm_structured_data: string | null;
  vlm_embedding_id: string | null;
  vlm_model: string | null;
  vlm_confidence: number | null;
  vlm_processed_at: string | null;
  vlm_tokens_used: number | null;
  context_text: string | null;
  provenance_id: string | null;
  created_at: string;
  error_message: string | null;
  block_type: string | null;
  is_header_footer: number;
  content_hash: string | null;
}

/**
 * Options for listing images
 */
export interface ListImagesOptions {
  vlmStatus?: 'pending' | 'processing' | 'complete' | 'failed';
  limit?: number;
  offset?: number;
}
