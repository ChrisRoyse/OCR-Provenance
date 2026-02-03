/**
 * Row conversion functions for DatabaseService
 *
 * Converts database row objects to domain model interfaces.
 */

import { Document, DocumentStatus, OCRResult } from '../../../models/document.js';
import { Chunk } from '../../../models/chunk.js';
import { Embedding } from '../../../models/embedding.js';
import {
  ProvenanceRecord,
  ProvenanceType,
  ProvenanceLocation,
} from '../../../models/provenance.js';
import {
  DocumentRow,
  OCRResultRow,
  ChunkRow,
  EmbeddingRow,
  ProvenanceRow,
} from './types.js';

/**
 * Convert document row to Document interface
 */
export function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    file_path: row.file_path,
    file_name: row.file_name,
    file_hash: row.file_hash,
    file_size: row.file_size,
    file_type: row.file_type,
    status: row.status as DocumentStatus,
    page_count: row.page_count,
    provenance_id: row.provenance_id,
    created_at: row.created_at,
    modified_at: row.modified_at,
    ocr_completed_at: row.ocr_completed_at,
    error_message: row.error_message,
  };
}

/**
 * Convert OCR result row to OCRResult interface
 */
export function rowToOCRResult(row: OCRResultRow): OCRResult {
  return {
    id: row.id,
    provenance_id: row.provenance_id,
    document_id: row.document_id,
    extracted_text: row.extracted_text,
    text_length: row.text_length,
    datalab_request_id: row.datalab_request_id,
    datalab_mode: row.datalab_mode as 'fast' | 'balanced' | 'accurate',
    parse_quality_score: row.parse_quality_score,
    page_count: row.page_count,
    cost_cents: row.cost_cents,
    content_hash: row.content_hash,
    processing_started_at: row.processing_started_at,
    processing_completed_at: row.processing_completed_at,
    processing_duration_ms: row.processing_duration_ms,
  };
}

/**
 * Convert chunk row to Chunk interface
 */
export function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    document_id: row.document_id,
    ocr_result_id: row.ocr_result_id,
    text: row.text,
    text_hash: row.text_hash,
    chunk_index: row.chunk_index,
    character_start: row.character_start,
    character_end: row.character_end,
    page_number: row.page_number,
    page_range: row.page_range,
    overlap_previous: row.overlap_previous,
    overlap_next: row.overlap_next,
    provenance_id: row.provenance_id,
    created_at: row.created_at,
    embedding_status: row.embedding_status as 'pending' | 'complete' | 'failed',
    embedded_at: row.embedded_at,
  };
}

/**
 * Convert embedding row to Embedding interface (without vector)
 */
export function rowToEmbedding(row: EmbeddingRow): Omit<Embedding, 'vector'> {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    original_text: row.original_text,
    original_text_length: row.original_text_length,
    source_file_path: row.source_file_path,
    source_file_name: row.source_file_name,
    source_file_hash: row.source_file_hash,
    page_number: row.page_number,
    page_range: row.page_range,
    character_start: row.character_start,
    character_end: row.character_end,
    chunk_index: row.chunk_index,
    total_chunks: row.total_chunks,
    model_name: row.model_name,
    model_version: row.model_version,
    task_type: row.task_type as 'search_document' | 'search_query',
    inference_mode: row.inference_mode as 'local',
    gpu_device: row.gpu_device ?? '',
    provenance_id: row.provenance_id,
    content_hash: row.content_hash,
    created_at: row.created_at,
    generation_duration_ms: row.generation_duration_ms,
  };
}

/**
 * Convert provenance row to ProvenanceRecord interface
 */
export function rowToProvenance(row: ProvenanceRow): ProvenanceRecord {
  return {
    id: row.id,
    type: row.type as ProvenanceType,
    created_at: row.created_at,
    processed_at: row.processed_at,
    source_file_created_at: row.source_file_created_at,
    source_file_modified_at: row.source_file_modified_at,
    source_type: row.source_type as 'FILE' | 'OCR' | 'CHUNKING' | 'EMBEDDING',
    source_path: row.source_path,
    source_id: row.source_id,
    root_document_id: row.root_document_id,
    location: row.location
      ? (JSON.parse(row.location) as ProvenanceLocation)
      : null,
    content_hash: row.content_hash,
    input_hash: row.input_hash,
    file_hash: row.file_hash,
    processor: row.processor,
    processor_version: row.processor_version,
    processing_params: JSON.parse(row.processing_params) as Record<
      string,
      unknown
    >,
    processing_duration_ms: row.processing_duration_ms,
    processing_quality_score: row.processing_quality_score,
    parent_id: row.parent_id,
    parent_ids: row.parent_ids,
    chain_depth: row.chain_depth,
    chain_path: row.chain_path,
  };
}
