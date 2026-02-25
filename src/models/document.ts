/**
 * Document interfaces for OCR Provenance MCP System
 *
 * Represents source documents ingested into the system.
 * Provenance depth: 0 (root of chain)
 */

/**
 * Document status throughout processing lifecycle
 */
export type DocumentStatus = 'pending' | 'processing' | 'complete' | 'failed';

/**
 * Supported file types for OCR processing
 */
export const SUPPORTED_FILE_TYPES = [
  'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls',
  'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp',
  'txt', 'csv', 'md',
] as const;



/**
 * Represents a source document ingested into the system
 * Provenance depth: 0 (root of chain)
 */
export interface Document {
  /** UUID v4 identifier */
  id: string;

  /** Full absolute path to source file */
  file_path: string;

  /** Original filename */
  file_name: string;

  /** SHA-256 hash of file content (format: 'sha256:...') */
  file_hash: string;

  /** File size in bytes */
  file_size: number;

  /** File type/extension (e.g., 'pdf', 'png', 'docx') */
  file_type: string;

  /** Current processing status */
  status: DocumentStatus;

  /** Number of pages (populated after OCR) */
  page_count: number | null;

  /** Reference to provenance record */
  provenance_id: string;

  /** ISO 8601 timestamp when document was ingested */
  created_at: string;

  /** ISO 8601 timestamp when file was last modified */
  modified_at: string | null;

  /** ISO 8601 timestamp when OCR completed */
  ocr_completed_at: string | null;

  /** Error message if status is 'failed' */
  error_message: string | null;

  /** Document title from metadata */
  doc_title: string | null;
  /** Document author from metadata */
  doc_author: string | null;
  /** Document subject from metadata */
  doc_subject: string | null;

  /** Reference to Datalab uploaded file ID */
  datalab_file_id: string | null;
}

/**
 * OCR result from Datalab processing
 * Provenance depth: 1
 */
export interface OCRResult {
  /** UUID v4 identifier */
  id: string;

  /** Reference to provenance record */
  provenance_id: string;

  /** Reference to source document */
  document_id: string;

  /** Extracted text content (Markdown format) */
  extracted_text: string;

  /** Length of extracted text */
  text_length: number;

  /** Datalab API request ID for tracing */
  datalab_request_id: string;

  /** OCR mode used: 'fast', 'balanced', 'accurate' */
  datalab_mode: 'fast' | 'balanced' | 'accurate';

  /** Datalab parse quality score (0-5) */
  parse_quality_score: number | null;

  /** Number of pages processed */
  page_count: number;

  /** Processing cost in cents */
  cost_cents: number | null;

  /** SHA-256 hash of extracted text */
  content_hash: string;

  /** ISO 8601 processing start timestamp */
  processing_started_at: string;

  /** ISO 8601 processing complete timestamp */
  processing_completed_at: string;

  /** Processing duration in milliseconds */
  processing_duration_ms: number;

  /** JSON block hierarchy from Datalab */
  json_blocks?: string | null;

  /** Extras metadata (cost_breakdown, Datalab metadata, etc.) */
  extras_json?: string | null;
}

/**
 * Page offset information for tracking text positions
 */
export interface PageOffset {
  /** 1-indexed page number */
  page: number;
  /** Character offset where page starts */
  charStart: number;
  /** Character offset where page ends */
  charEnd: number;
}
