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
interface ChunkProvenanceParams {
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
  const startPage = pageOffsets.find((p) => charStart >= p.charStart && charStart < p.charEnd);

  // Find page containing end offset (note: endOffset is exclusive, so use >/<= for boundary)
  const endPage = pageOffsets.find((p) => charEnd > p.charStart && charEnd <= p.charEnd);

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

/**
 * Chunk text with page-boundary awareness
 *
 * Unlike standard chunking which ignores page boundaries, this mode ensures
 * no chunk spans across pages. Each page is chunked independently, preserving
 * document structure for better search relevance.
 *
 * Falls back to standard chunkText() if pageOffsets is empty.
 *
 * @param text - The full OCR text to chunk
 * @param pageOffsets - Array of page offset information mapping pages to character ranges
 * @param config - Chunking configuration (default: 2000 chars, 10% overlap)
 * @returns Array of ChunkResult with page numbers set from page boundaries
 */
export function chunkTextPageAware(
  text: string,
  pageOffsets: PageOffset[],
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): ChunkResult[] {
  // Fall back to standard chunking if no page offsets
  if (pageOffsets.length === 0) {
    return chunkText(text, config);
  }

  const chunks: ChunkResult[] = [];
  const overlapSize = getOverlapCharacters(config);

  for (let pageIdx = 0; pageIdx < pageOffsets.length; pageIdx++) {
    const pageStart = pageOffsets[pageIdx].charStart;
    const pageEnd = pageOffsets[pageIdx].charEnd;
    const pageText = text.slice(pageStart, pageEnd);
    const pageNumber = pageOffsets[pageIdx].page;

    if (pageText.trim().length === 0) continue;

    // Chunk within the page
    let pos = 0;
    while (pos < pageText.length) {
      const end = Math.min(pos + config.chunkSize, pageText.length);
      const chunkContent = pageText.slice(pos, end);

      if (chunkContent.trim().length > 0) {
        const chunkIndex = chunks.length;
        chunks.push({
          text: chunkContent,
          index: chunkIndex,
          startOffset: pageStart + pos,
          endOffset: pageStart + end,
          overlapWithPrevious: chunkIndex === 0 ? 0 : overlapSize,
          overlapWithNext: 0, // Set after loop
          pageNumber,
          pageRange: null,
        });
      }

      // Move forward by stepSize, but stop if we reached end of page
      if (end >= pageText.length) break;
      const nextPos = end - overlapSize;
      if (nextPos <= pos) break; // Prevent infinite loop on tiny pages
      pos = nextPos;
    }
  }

  // Set overlapWithNext for all but last chunk
  for (let i = 0; i < chunks.length - 1; i++) {
    chunks[i].overlapWithNext = overlapSize;
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY BOUNDARY ISSUE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Result of entity boundary issue detection */
export interface EntityBoundaryReport {
  /** Number of entity mentions that span across chunk boundaries */
  split_entities: number;
  /** Number of chunks affected by split entities */
  affected_chunks: number;
  /** Details of each split entity */
  details: Array<{ entity_text: string; chunk_boundary_at: number }>;
}

/**
 * Detect entity mentions that span across chunk boundaries.
 *
 * For each entity mention, checks if its character range crosses a chunk boundary
 * (i.e., the mention starts in one chunk but ends in the next). This is informational
 * only - it reports issues without changing chunking behavior.
 *
 * @param chunks - Array of chunks with character_start/character_end positions
 * @param entityMentions - Array of entity mentions with char_start/char_end and raw_text
 * @returns Report of split entities and affected chunks
 */
export function detectEntityBoundaryIssues(
  chunks: Array<{ text: string; character_start: number; character_end: number }>,
  entityMentions: Array<{ char_start: number; char_end: number; raw_text: string }>
): EntityBoundaryReport {
  if (chunks.length < 2 || entityMentions.length === 0) {
    return { split_entities: 0, affected_chunks: 0, details: [] };
  }

  // Build a sorted set of chunk boundary positions (the end of each chunk except last)
  const boundaries = new Set<number>();
  for (let i = 0; i < chunks.length - 1; i++) {
    boundaries.add(chunks[i].character_end);
  }

  const affectedChunkIndices = new Set<number>();
  const details: Array<{ entity_text: string; chunk_boundary_at: number }> = [];

  for (const mention of entityMentions) {
    if (mention.char_start === null || mention.char_end === null) continue;

    // Check if any chunk boundary falls strictly within this entity mention
    for (const boundary of boundaries) {
      if (boundary > mention.char_start && boundary < mention.char_end) {
        details.push({
          entity_text: mention.raw_text,
          chunk_boundary_at: boundary,
        });

        // Find which chunk index this boundary belongs to
        for (let i = 0; i < chunks.length - 1; i++) {
          if (chunks[i].character_end === boundary) {
            affectedChunkIndices.add(i);
            affectedChunkIndices.add(i + 1);
            break;
          }
        }
        break; // Only report once per entity mention
      }
    }
  }

  return {
    split_entities: details.length,
    affected_chunks: affectedChunkIndices.size,
    details,
  };
}

// Re-export types for convenience
export type { ChunkResult, ChunkingConfig } from '../../models/chunk.js';
export { DEFAULT_CHUNKING_CONFIG } from '../../models/chunk.js';
