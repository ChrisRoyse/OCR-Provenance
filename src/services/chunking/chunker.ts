/**
 * Text Chunking Service for OCR Provenance MCP System
 *
 * Splits OCR text into 2000-character chunks with 10% overlap (200 chars),
 * tracks page numbers, and creates CHUNK provenance records (chain_depth=2).
 *
 * @module services/chunking/chunker
 * @see Task 12: Implement Text Chunking Service
 */

import {
  ChunkResult,
  ChunkingConfig,
  DEFAULT_CHUNKING_CONFIG,
  getOverlapCharacters,
  getStepSize,
} from '../../models/chunk.js';
import { PageOffset } from '../../models/document.js';
import {
  ProvenanceType,
  SourceType,
  ProvenanceLocation,
  CreateProvenanceParams,
} from '../../models/provenance.js';

/**
 * Parameters for creating chunk provenance record
 */
export interface ChunkProvenanceParams {
  /** The chunk result containing text and position info */
  chunk: ChunkResult;
  /** Pre-computed hash of chunk.text (sha256:...) */
  chunkTextHash: string;
  /** Parent provenance ID (OCR result, chain_depth=1) */
  ocrProvenanceId: string;
  /** Root document provenance ID (chain_depth=0) */
  documentProvenanceId: string;
  /** Hash of full OCR text (input_hash) */
  ocrContentHash: string;
  /** Hash of original file */
  fileHash: string;
  /** Total number of chunks produced */
  totalChunks: number;
  /** Processing duration in milliseconds */
  processingDurationMs?: number;
  /** Chunking config used (defaults to DEFAULT_CHUNKING_CONFIG) */
  config?: ChunkingConfig;
}

/**
 * Chunk text into fixed-size segments with overlap
 *
 * Algorithm:
 * 1. Calculate overlap and step sizes from config
 * 2. Iterate through text, extracting chunks of chunkSize
 * 3. Move forward by stepSize (chunkSize - overlap) each iteration
 * 4. Track overlap values for each chunk
 *
 * @param text - The text to chunk (typically OCR output)
 * @param config - Chunking configuration (default: 2000 chars, 10% overlap)
 * @returns Array of ChunkResult with position and overlap info
 *
 * @example
 * const chunks = chunkText('...4000 char text...', { chunkSize: 2000, overlapPercent: 10 });
 * // Returns 3 chunks with 200-char overlap between adjacent chunks
 */
export function chunkText(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): ChunkResult[] {
  // Edge case: empty string returns empty array
  if (text.length === 0) {
    return [];
  }

  const overlapSize = getOverlapCharacters(config);
  const stepSize = getStepSize(config);
  const chunks: ChunkResult[] = [];
  let startOffset = 0;
  let index = 0;

  // Iterate through text, creating chunks
  while (startOffset < text.length) {
    const endOffset = Math.min(startOffset + config.chunkSize, text.length);
    const chunkText = text.slice(startOffset, endOffset);

    chunks.push({
      index,
      text: chunkText,
      startOffset,
      endOffset,
      overlapWithPrevious: index === 0 ? 0 : overlapSize,
      overlapWithNext: 0, // Set after loop
      pageNumber: null,
      pageRange: null,
    });

    // If this chunk reached the end of the text, we're done
    // This prevents creating tiny overlap-only chunks at the end
    if (endOffset >= text.length) {
      break;
    }

    startOffset += stepSize;
    index++;
  }

  // Set overlapWithNext for all but last chunk
  for (let i = 0; i < chunks.length - 1; i++) {
    chunks[i].overlapWithNext = overlapSize;
  }

  return chunks;
}

/**
 * Determine page information for a character range
 *
 * @param charStart - Start character offset
 * @param charEnd - End character offset
 * @param pageOffsets - Array of page offset information
 * @returns Object with pageNumber (single page) or pageRange (spans multiple)
 */
function determinePageInfo(
  charStart: number,
  charEnd: number,
  pageOffsets: PageOffset[]
): { pageNumber: number | null; pageRange: string | null } {
  // No page info available
  if (pageOffsets.length === 0) {
    return { pageNumber: null, pageRange: null };
  }

  // Find page containing start offset
  const startPage = pageOffsets.find(
    (p) => charStart >= p.charStart && charStart < p.charEnd
  );

  // Find page containing end offset (note: endOffset is exclusive, so use >/<= for boundary)
  const endPage = pageOffsets.find(
    (p) => charEnd > p.charStart && charEnd <= p.charEnd
  );

  // Start position not found in any page
  if (!startPage) {
    return { pageNumber: null, pageRange: null };
  }

  // Single page or end page not found/same as start
  if (!endPage || startPage.page === endPage.page) {
    return { pageNumber: startPage.page, pageRange: null };
  }

  // Spans multiple pages
  return {
    pageNumber: startPage.page,
    pageRange: `${startPage.page}-${endPage.page}`,
  };
}

/**
 * Chunk text with page number tracking
 *
 * Extends basic chunking with page information from pageOffsets.
 * Each chunk will have pageNumber (for single-page chunks) or
 * pageRange (for chunks spanning multiple pages).
 *
 * @param text - The text to chunk
 * @param pageOffsets - Array mapping page numbers to character offsets
 * @param config - Chunking configuration
 * @returns Array of ChunkResult with page tracking
 *
 * @example
 * const pageOffsets = [
 *   { page: 1, charStart: 0, charEnd: 1500 },
 *   { page: 2, charStart: 1500, charEnd: 3000 }
 * ];
 * const chunks = chunkWithPageTracking(text, pageOffsets);
 * // Chunks spanning pages will have pageRange like "1-2"
 */
export function chunkWithPageTracking(
  text: string,
  pageOffsets: PageOffset[],
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): ChunkResult[] {
  // First, chunk the text normally
  const chunks = chunkText(text, config);

  // Then add page tracking info to each chunk
  for (const chunk of chunks) {
    const pageInfo = determinePageInfo(chunk.startOffset, chunk.endOffset, pageOffsets);
    chunk.pageNumber = pageInfo.pageNumber;
    chunk.pageRange = pageInfo.pageRange;
  }

  return chunks;
}

/**
 * Create provenance parameters for a chunk
 *
 * Generates a CreateProvenanceParams object suitable for creating
 * a CHUNK provenance record (chain_depth=2).
 *
 * @param params - Chunk provenance parameters
 * @returns CreateProvenanceParams ready for insertProvenance
 *
 * @example
 * const provParams = createChunkProvenance({
 *   chunk: chunks[0],
 *   chunkTextHash: computeHash(chunks[0].text),
 *   ocrProvenanceId: ocrProv.id,
 *   documentProvenanceId: docProv.id,
 *   ocrContentHash: ocrResult.content_hash,
 *   fileHash: doc.file_hash,
 *   totalChunks: chunks.length
 * });
 */
export function createChunkProvenance(params: ChunkProvenanceParams): CreateProvenanceParams {
  const {
    chunk,
    chunkTextHash,
    ocrProvenanceId,
    documentProvenanceId,
    ocrContentHash,
    fileHash,
    totalChunks,
    processingDurationMs,
    config = DEFAULT_CHUNKING_CONFIG,
  } = params;

  // Build location information
  const location: ProvenanceLocation = {
    chunk_index: chunk.index,
    character_start: chunk.startOffset,
    character_end: chunk.endOffset,
  };

  // Add page info only if available
  if (chunk.pageNumber !== null) {
    location.page_number = chunk.pageNumber;
  }
  if (chunk.pageRange !== null) {
    location.page_range = chunk.pageRange;
  }

  return {
    type: ProvenanceType.CHUNK,
    source_type: 'CHUNKING' as SourceType,
    source_id: ocrProvenanceId,
    root_document_id: documentProvenanceId,
    content_hash: chunkTextHash,
    input_hash: ocrContentHash,
    file_hash: fileHash,
    processor: 'chunker',
    processor_version: '1.0.0',
    processing_params: {
      chunk_size: config.chunkSize,
      overlap_percent: config.overlapPercent,
      overlap_characters: getOverlapCharacters(config),
      chunk_index: chunk.index,
      total_chunks: totalChunks,
      character_start: chunk.startOffset,
      character_end: chunk.endOffset,
    },
    processing_duration_ms: processingDurationMs ?? null,
    location,
  };
}

// Re-export types for convenience
export type { ChunkResult, ChunkingConfig } from '../../models/chunk.js';
export { DEFAULT_CHUNKING_CONFIG } from '../../models/chunk.js';
