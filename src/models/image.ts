/**
 * Image interfaces for OCR Provenance MCP System
 *
 * Represents images extracted from documents for VLM analysis.
 * Provenance depth: 2 (after OCR)
 */

/**
 * Bounding box coordinates for image location in document
 */
interface BoundingBox {
  /** X coordinate (pixels from left) */
  x: number;
  /** Y coordinate (pixels from top) */
  y: number;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
}

/**
 * Image dimensions
 */
interface ImageDimensions {
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
}

/**
 * VLM processing status
 */
export type VLMStatus = 'pending' | 'processing' | 'complete' | 'failed';

/**
 * Structured data extracted from image by VLM
 */
export interface VLMStructuredData {
  /** Type of image identified */
  imageType: string;
  /** Primary subject/content */
  primarySubject?: string;
  /** Extracted text strings */
  extractedText?: string[];
  /** Dates found in image */
  dates?: string[];
  /** Names found in image */
  names?: string[];
  /** Numbers/amounts found */
  numbers?: string[];
  /** Additional metadata */
  [key: string]: unknown;
}

/**
 * Represents an extracted image from a document
 * Provenance depth: 2 (after OCR extraction)
 */
export interface ImageReference {
  /** UUID v4 identifier */
  id: string;

  /** Reference to source document */
  document_id: string;

  /** Reference to OCR result that produced this */
  ocr_result_id: string;

  /** Page number where image appears (1-indexed) */
  page_number: number;

  /** Bounding box coordinates on page */
  bounding_box: BoundingBox;

  /** Index of image on this page (0-indexed) */
  image_index: number;

  /** Image format (png, jpg, etc.) */
  format: string;

  /** Image dimensions in pixels */
  dimensions: ImageDimensions;

  /** Path to extracted image file */
  extracted_path: string | null;

  /** File size in bytes */
  file_size: number | null;

  /** VLM processing status */
  vlm_status: VLMStatus;

  /** Natural language description from VLM */
  vlm_description: string | null;

  /** Structured data extracted by VLM */
  vlm_structured_data: VLMStructuredData | null;

  /** Reference to embedding of VLM description */
  vlm_embedding_id: string | null;

  /** Model used for VLM processing */
  vlm_model: string | null;

  /** VLM confidence score (0-1) */
  vlm_confidence: number | null;

  /** ISO 8601 timestamp when VLM completed */
  vlm_processed_at: string | null;

  /** Tokens used for VLM processing */
  vlm_tokens_used: number | null;

  /** Surrounding text context from document */
  context_text: string | null;

  /** Reference to provenance record */
  provenance_id: string | null;

  /** Datalab block type: 'Figure', 'Picture', 'PageHeader', etc. Null if unknown */
  block_type: string | null;

  /** True if image is inside a PageHeader or PageFooter block */
  is_header_footer: boolean;

  /** SHA-256 hash of image file bytes for deduplication: 'sha256:...' */
  content_hash: string | null;

  /** ISO 8601 timestamp when image was extracted */
  created_at: string;

  /** Error message if VLM failed */
  error_message: string | null;
}

/**
 * Input for creating a new image reference
 */
export type CreateImageReference = Omit<
  ImageReference,
  | 'id'
  | 'created_at'
  | 'vlm_status'
  | 'vlm_description'
  | 'vlm_structured_data'
  | 'vlm_embedding_id'
  | 'vlm_model'
  | 'vlm_confidence'
  | 'vlm_processed_at'
  | 'vlm_tokens_used'
  | 'error_message'
>;

/**
 * VLM result to update an image with
 */
export interface VLMResult {
  /** Natural language description */
  description: string;
  /** Structured data extracted */
  structuredData: VLMStructuredData;
  /** Embedding ID for description */
  embeddingId: string;
  /** Model used */
  model: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Tokens used */
  tokensUsed: number;
}

/**
 * Image extraction result from PDF
 */
export interface ExtractedImage {
  /** Page number (1-indexed) */
  page: number;
  /** Index on page (0-indexed) */
  index: number;
  /** Image format */
  format: string;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Bounding box on page */
  bbox: BoundingBox;
  /** Path to extracted file */
  path: string;
  /** File size in bytes */
  size: number;
}

/**
 * Image extraction options
 */
export interface ImageExtractionOptions {
  /** Minimum image dimension (pixels) to include */
  minSize?: number;
  /** Maximum images to extract per document */
  maxImages?: number;
  /** Output directory for extracted images */
  outputDir: string;
}

/**
 * Image statistics
 */
export interface ImageStats {
  /** Total images in database */
  total: number;
  /** Images with VLM complete */
  processed: number;
  /** Images pending VLM */
  pending: number;
  /** Images currently being processed */
  processing: number;
  /** Images with VLM failed */
  failed: number;
}
