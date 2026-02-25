/**
 * Embedding interfaces for OCR Provenance MCP System
 *
 * Represents vector embeddings with full provenance.
 * Provenance depth: 3
 *
 * CRITICAL: This interface is denormalized to include original_text
 * and source file info. Search results are self-contained per CP-002.
 */

/**
 * Embedding model constants
 */
export const EMBEDDING_MODEL = {
  name: 'nomic-embed-text-v1.5',
  version: '1.5.0',
  dimensions: 768,
  maxSequenceLength: 8192,
  prefixes: {
    document: 'search_document: ',
    query: 'search_query: '
  }
} as const;

/**
 * Represents a vector embedding with full provenance
 * Provenance depth: 3 (from chunks) or 4 (from VLM descriptions)
 *
 * CRITICAL: This table is denormalized to include original_text
 * and source file info. Search results are self-contained.
 *
 * Either chunk_id (for text embeddings), image_id (for VLM embeddings),
 * or extraction_id (for extraction embeddings) must be set.
 */
export interface Embedding {
  /** UUID v4 identifier */
  id: string;

  /** Reference to source chunk (null for VLM embeddings) */
  chunk_id: string | null;

  /** Reference to source image (null for text embeddings) */
  image_id: string | null;

  /** Reference to source extraction (null for text/VLM embeddings) */
  extraction_id: string | null;

  /** Reference to root document */
  document_id: string;

  // Original text - always stored per CP-002
  /** The actual chunk text that was embedded - ALWAYS INCLUDED */
  original_text: string;

  /** Length of original text in characters */
  original_text_length: number;

  // Source file - denormalized for fast retrieval
  /** Full path to source file */
  source_file_path: string;

  /** Source file name */
  source_file_name: string;

  /** SHA-256 hash of source file */
  source_file_hash: string;

  // Location in source document
  /** Page number (1-indexed) */
  page_number: number | null;

  /** Page range if spanning multiple pages */
  page_range: string | null;

  /** Start character offset in OCR text */
  character_start: number;

  /** End character offset in OCR text */
  character_end: number;

  /** Chunk index in document */
  chunk_index: number;

  /** Total chunks in document */
  total_chunks: number;

  // Vector data
  /** 768-dimensional float32 vector */
  vector: Float32Array;

  // Model metadata for reproducibility
  /** Model name (nomic-embed-text-v1.5) */
  model_name: string;

  /** Model version */
  model_version: string;

  /** Task type used (search_document) */
  task_type: 'search_document' | 'search_query';

  /** Inference mode (always 'local') */
  inference_mode: 'local';

  /** GPU device used */
  gpu_device: string;

  // Provenance
  /** Reference to provenance record */
  provenance_id: string;

  /** SHA-256 hash of original_text */
  content_hash: string;

  /** ISO 8601 timestamp */
  created_at: string;

  /** Generation duration in milliseconds */
  generation_duration_ms: number | null;
}


