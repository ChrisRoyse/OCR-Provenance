/**
 * Chunk interfaces for OCR Provenance MCP System
 *
 * Represents text chunks extracted from OCR output.
 * Provenance depth: 2
 */

/**
 * Configuration for text chunking
 */
/** Configuration for heading level normalization */
export interface HeadingNormalizationConfig {
  /** Enable heading normalization (default: false) */
  enabled: boolean;
  /** Minimum pattern group size to trigger normalization (default: 3) */
  minPatternCount?: number;
}

export interface ChunkingConfig {
  /** Maximum characters per chunk (default: 2000) */
  chunkSize: number;

  /** Overlap percentage between chunks (default: 10) */
  overlapPercent: number;

  /** Maximum chunk size for oversized sections (default: 8000) */
  maxChunkSize: number;

  /** Minimum chunk size - heading-only chunks below this are merged (default: 100) */
  minChunkSize?: number;

  /** Heading normalization configuration (default: disabled) */
  headingNormalization?: HeadingNormalizationConfig;
}

/**
 * Default chunking configuration per PRD
 */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 2000,
  overlapPercent: 10,
  maxChunkSize: 8000,
};

/**
 * Calculate overlap in characters
 */
export function getOverlapCharacters(config: ChunkingConfig): number {
  return Math.floor(config.chunkSize * config.overlapPercent / 100);
}

/**
 * Calculate step size for chunking
 */
export function getStepSize(config: ChunkingConfig): number {
  return config.chunkSize - getOverlapCharacters(config);
}

/**
 * Result of chunking operation (before database storage)
 */
export interface ChunkResult {
  /** 0-indexed chunk position */
  index: number;

  /** The chunk text */
  text: string;

  /** Start offset in source text */
  startOffset: number;

  /** End offset in source text */
  endOffset: number;

  /** Characters overlapping with previous chunk */
  overlapWithPrevious: number;

  /** Characters overlapping with next chunk */
  overlapWithNext: number;

  /** Page number if determinable (1-indexed) */
  pageNumber: number | null;

  /** Page range if spanning pages (e.g., "4-5") */
  pageRange: string | null;

  /** Heading text that provides context for this chunk */
  headingContext: string | null;

  /** Heading level (1-6) of the section this chunk belongs to */
  headingLevel: number | null;

  /** Full section path (e.g., "Introduction > Background > History") */
  sectionPath: string | null;

  /** Content types present in this chunk (e.g., ["text", "table", "list"]) */
  contentTypes: string[];

  /** Whether this chunk is atomic (should not be split further) */
  isAtomic: boolean;

  /** Table metadata if this chunk contains a table */
  tableMetadata?: {
    columnHeaders: string[];
    rowCount: number;
    columnCount: number;
    /** Human-readable summary of table content */
    summary?: string;
    /** Caption text from preceding block (e.g., "Table 1: Budget Summary") */
    caption?: string;
    /** Index of a prior table structure this continues (cross-page) */
    continuationOf?: number;
  } | null;
}

/**
 * Represents a text chunk stored in database
 * Provenance depth: 2
 */
export interface Chunk {
  /** UUID v4 identifier */
  id: string;

  /** Reference to parent document */
  document_id: string;

  /** Reference to OCR result this chunk came from */
  ocr_result_id: string;

  /** The actual chunk text content */
  text: string;

  /** SHA-256 hash of text content */
  text_hash: string;

  /** 0-indexed position in document */
  chunk_index: number;

  /** Character offset where chunk starts in OCR text */
  character_start: number;

  /** Character offset where chunk ends in OCR text */
  character_end: number;

  /** Page number this chunk primarily belongs to (1-indexed) */
  page_number: number | null;

  /** Page range if chunk spans multiple pages (e.g., "4-5") */
  page_range: string | null;

  /** Characters overlapping with previous chunk */
  overlap_previous: number;

  /** Characters overlapping with next chunk */
  overlap_next: number;

  /** Reference to provenance record */
  provenance_id: string;

  /** ISO 8601 timestamp */
  created_at: string;

  /** Status of embedding generation */
  embedding_status: 'pending' | 'complete' | 'failed';

  /** ISO 8601 timestamp when embedded */
  embedded_at: string | null;

  /** OCR parse quality score from Datalab (0-5 range), propagated to chunk level */
  ocr_quality_score: number | null;

  /** Heading text that provides context for this chunk */
  heading_context: string | null;

  /** Heading level (1-6) of the section this chunk belongs to */
  heading_level: number | null;

  /** Full section path (e.g., "Introduction > Background > History") */
  section_path: string | null;

  /** JSON-encoded array of content types (e.g., '["text","table"]') */
  content_types: string | null;

  /** Whether this chunk is atomic (should not be split further) */
  is_atomic: number;

  /** Chunking strategy used to create this chunk (e.g., "fixed", "hybrid_section") */
  chunking_strategy: string;
}
