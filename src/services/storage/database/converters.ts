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
  type SourceType,
} from '../../../models/provenance.js';
import {
  ImageReference,
  VLMStatus,
  VLMStructuredData,
} from '../../../models/image.js';
import {
  DocumentRow,
  OCRResultRow,
  ChunkRow,
  EmbeddingRow,
  ProvenanceRow,
  ImageRow,
} from './types.js';

/**
 * Safely parse JSON processing_params, returning a fallback on corrupt data.
 */
function parseProcessingParams(id: string, raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error(`[ERROR] Corrupt processing_params in provenance ${id}: ${raw}`);
    return { _parse_error: true, _raw: raw };
  }
}

/**
 * Safely parse JSON location, returning a fallback on corrupt data.
 * On parse failure, returns { _parse_error, _raw } cast to ProvenanceLocation
 * so the caller can inspect the object at runtime without crashing.
 */
function parseLocation(id: string, raw: string): ProvenanceLocation {
  try {
    return JSON.parse(raw) as ProvenanceLocation;
  } catch {
    console.error(`[ERROR] Corrupt location in provenance ${id}: ${raw}`);
    return { _parse_error: true, _raw: raw } as unknown as ProvenanceLocation;
  }
}

/**
 * Safely parse JSON vlm_structured_data, returning a fallback on corrupt data.
 * On parse failure, returns { _parse_error, _raw } cast to VLMStructuredData
 * so the caller can inspect the object at runtime without crashing.
 */
function parseVLMStructuredData(id: string, raw: string): VLMStructuredData {
  try {
    return JSON.parse(raw) as VLMStructuredData;
  } catch {
    console.error(`[ERROR] Corrupt vlm_structured_data in image ${id}: ${raw}`);
    return { _parse_error: true, _raw: raw } as unknown as VLMStructuredData;
  }
}

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
    doc_title: row.doc_title ?? null,
    doc_author: row.doc_author ?? null,
    doc_subject: row.doc_subject ?? null,
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
    json_blocks: row.json_blocks ?? null,
    extras_json: row.extras_json ?? null,
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
    ocr_quality_score: row.ocr_quality_score ?? null,
  };
}

/**
 * Convert embedding row to Embedding interface (without vector)
 */
export function rowToEmbedding(row: EmbeddingRow): Omit<Embedding, 'vector'> {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    image_id: row.image_id,
    extraction_id: row.extraction_id,
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
    source_type: row.source_type as SourceType,
    source_path: row.source_path,
    source_id: row.source_id,
    root_document_id: row.root_document_id,
    location: row.location
      ? parseLocation(row.id, row.location)
      : null,
    content_hash: row.content_hash,
    input_hash: row.input_hash,
    file_hash: row.file_hash,
    processor: row.processor,
    processor_version: row.processor_version,
    processing_params: parseProcessingParams(row.id, row.processing_params),
    processing_duration_ms: row.processing_duration_ms,
    processing_quality_score: row.processing_quality_score,
    parent_id: row.parent_id,
    parent_ids: row.parent_ids,
    chain_depth: row.chain_depth,
    chain_path: row.chain_path,
  };
}

/**
 * Convert image row to ImageReference interface
 */
export function rowToImage(row: ImageRow): ImageReference {
  return {
    id: row.id,
    document_id: row.document_id,
    ocr_result_id: row.ocr_result_id,
    page_number: row.page_number,
    bounding_box: {
      x: row.bbox_x,
      y: row.bbox_y,
      width: row.bbox_width,
      height: row.bbox_height,
    },
    image_index: row.image_index,
    format: row.format,
    dimensions: {
      width: row.width,
      height: row.height,
    },
    extracted_path: row.extracted_path,
    file_size: row.file_size,
    vlm_status: row.vlm_status as VLMStatus,
    vlm_description: row.vlm_description,
    vlm_structured_data: row.vlm_structured_data
      ? parseVLMStructuredData(row.id, row.vlm_structured_data)
      : null,
    vlm_embedding_id: row.vlm_embedding_id,
    vlm_model: row.vlm_model,
    vlm_confidence: row.vlm_confidence,
    vlm_processed_at: row.vlm_processed_at,
    vlm_tokens_used: row.vlm_tokens_used,
    context_text: row.context_text,
    provenance_id: row.provenance_id,
    created_at: row.created_at,
    error_message: row.error_message,
    block_type: row.block_type ?? null,
    is_header_footer: Boolean(row.is_header_footer),
    content_hash: row.content_hash ?? null,
  };
}
