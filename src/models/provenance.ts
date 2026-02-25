/**
 * Provenance interfaces for OCR Provenance MCP System
 *
 * Comprehensive provenance tracking for complete data lineage.
 * Every data transformation creates a provenance record.
 */

/**
 * Types of provenance records in the chain
 * Each type has a fixed chain depth
 */
export enum ProvenanceType {
  /** Original source file (depth 0) */
  DOCUMENT = 'DOCUMENT',

  /** Text extracted via Datalab OCR (depth 1) */
  OCR_RESULT = 'OCR_RESULT',

  /** Text segment with overlap (depth 2) */
  CHUNK = 'CHUNK',

  /** Extracted image from document (depth 2, parallel to CHUNK) */
  IMAGE = 'IMAGE',

  /** VLM analysis output describing an image (depth 3) */
  VLM_DESCRIPTION = 'VLM_DESCRIPTION',

  /** Structured extraction from page_schema (depth 2, parallel to CHUNK) */
  EXTRACTION = 'EXTRACTION',

  /** Form fill result (depth 0, parallel to DOCUMENT) */
  FORM_FILL = 'FORM_FILL',

  /** Comparison between two documents (depth 2, parallel to CHUNK) */
  COMPARISON = 'COMPARISON',

  /** Document clustering result (depth 2, parallel to CHUNK) */
  CLUSTERING = 'CLUSTERING',

  /** 768-dim vector from nomic model (depth 3 from CHUNK, depth 4 from VLM_DESCRIPTION) */
  EMBEDDING = 'EMBEDDING'
}

/**
 * Chain depth for each provenance type
 * Note: EMBEDDING depth is 3 when derived from CHUNK, but 4 when derived from VLM_DESCRIPTION.
 * The actual depth is computed dynamically from the parent chain.
 */
// NOTE: EMBEDDING depth is 3 for chunk-derived embeddings only.
// VLM description embeddings use depth 4 and bypass createProvenance() - see pipeline.ts
export const PROVENANCE_CHAIN_DEPTH: Record<ProvenanceType, number> = {
  [ProvenanceType.DOCUMENT]: 0,
  [ProvenanceType.OCR_RESULT]: 1,
  [ProvenanceType.CHUNK]: 2,
  [ProvenanceType.IMAGE]: 2,           // Same depth as CHUNK (parallel branch)
  [ProvenanceType.VLM_DESCRIPTION]: 3, // After IMAGE
  [ProvenanceType.EXTRACTION]: 2,      // Same depth as CHUNK (parallel branch)
  [ProvenanceType.FORM_FILL]: 0,       // Same depth as DOCUMENT (form fill is a root-level operation)
  [ProvenanceType.COMPARISON]: 2,        // Same depth as CHUNK (parallel branch)
  [ProvenanceType.CLUSTERING]: 2,        // Same depth as CHUNK (parallel branch)
  [ProvenanceType.EMBEDDING]: 3        // Chunk-derived only; VLM embeddings use depth 4 (built in pipeline.ts)
};

/**
 * Source type for provenance tracking
 */
export type SourceType = 'FILE' | 'OCR' | 'CHUNKING' | 'IMAGE_EXTRACTION' | 'VLM' | 'VLM_DEDUP' | 'EMBEDDING' | 'EXTRACTION' | 'FORM_FILL' | 'COMPARISON' | 'CLUSTERING';

/**
 * Location information within source document
 */
export interface ProvenanceLocation {
  /** 1-indexed page number */
  page_number?: number;

  /** Page range if spanning pages (e.g., "4-5") */
  page_range?: string;

  /** Start character offset */
  character_start?: number;

  /** End character offset */
  character_end?: number;

  /** Chunk index (0-indexed) */
  chunk_index?: number;

  /** Bounding box for OCR position data */
  bounding_box?: {
    x: number;
    y: number;
    width: number;
    height: number;
    page: number;
  };
}

/**
 * Comprehensive provenance record
 * Every data transformation creates one of these
 */
export interface ProvenanceRecord {
  // Identity
  /** UUID v4 - globally unique */
  id: string;

  /** Type of record (determines chain depth) */
  type: ProvenanceType;

  // Timestamps
  /** ISO 8601 - when this record was created */
  created_at: string;

  /** ISO 8601 - when processing completed */
  processed_at: string;

  /** Original file creation time (for DOCUMENT type) */
  source_file_created_at: string | null;

  /** Original file modified time (for DOCUMENT type) */
  source_file_modified_at: string | null;

  // Origin
  /** Type of source operation */
  source_type: SourceType;

  /** Full absolute path (for FILE source) */
  source_path: string | null;

  /** Parent provenance ID (null for DOCUMENT type) */
  source_id: string | null;

  /** Original document this derives from */
  root_document_id: string;

  // Location (for CHUNK and EMBEDDING types)
  /** Precise location within source */
  location: ProvenanceLocation | null;

  // Integrity - cryptographic verification
  /** SHA-256 of THIS item's content (format: 'sha256:...') */
  content_hash: string;

  /** SHA-256 of the INPUT that produced this */
  input_hash: string | null;

  /** SHA-256 of original source file (for tracing) */
  file_hash: string | null;

  // Processing metadata
  /** Processor name (e.g., 'datalab-ocr', 'chunker', 'nomic-embed-text-v1.5') */
  processor: string;

  /** Exact processor version */
  processor_version: string;

  /** ALL parameters used for processing */
  processing_params: Record<string, unknown>;

  /** Processing duration in milliseconds */
  processing_duration_ms: number | null;

  /** Quality metric if available */
  processing_quality_score: number | null;

  // Chain - lineage back to source
  /** Immediate parent provenance ID */
  parent_id: string | null;

  /** ALL ancestor provenance IDs as JSON array string */
  parent_ids: string;

  /** How many transformations from source */
  chain_depth: number;

  /** Human-readable path as JSON array string */
  chain_path: string | null;
}

/**
 * Parameters for creating a new provenance record
 */
export interface CreateProvenanceParams {
  type: ProvenanceType;
  source_type: SourceType;
  source_id?: string | null;
  root_document_id: string;
  content_hash: string;
  input_hash?: string | null;
  file_hash?: string | null;
  source_path?: string | null;
  processor: string;
  processor_version: string;
  processing_params: Record<string, unknown>;
  processing_duration_ms?: number | null;
  processing_quality_score?: number | null;
  location?: ProvenanceLocation | null;
  source_file_created_at?: string | null;
  source_file_modified_at?: string | null;
}

/**
 * Verification result for provenance integrity
 */
export interface VerificationResult {
  /** Overall validity */
  valid: boolean;

  /** Whether chain is intact (no missing records) */
  chain_intact: boolean;

  /** Number of hashes successfully verified */
  hashes_verified: number;

  /** Number of hash verification failures */
  hashes_failed: number;

  /** Details of failed verifications */
  failed_items: Array<{
    id: string;
    expected_hash: string;
    computed_hash: string;
    type: ProvenanceType;
  }>;

  /** ISO 8601 timestamp of verification */
  verified_at: string;
}

/**
 * W3C PROV-JSON export format
 */
export interface W3CProvDocument {
  prefix: Record<string, string>;
  entity: Record<string, Record<string, unknown>>;
  activity: Record<string, Record<string, unknown>>;
  agent: Record<string, Record<string, unknown>>;
  wasGeneratedBy: Record<string, Record<string, unknown>>;
  wasDerivedFrom: Record<string, Record<string, unknown>>;
  wasAttributedTo: Record<string, Record<string, unknown>>;
  used: Record<string, Record<string, unknown>>;
}
