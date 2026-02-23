/**
 * Hybrid Section-Aware Chunking Service for OCR Provenance MCP System
 *
 * Uses markdown structure (headings, paragraphs, tables), JSON block data
 * (for atomic region detection), and page offsets (for page tracking) to
 * produce semantically coherent chunks with provenance records (chain_depth=2).
 *
 * @module services/chunking/chunker
 */

import {
  ChunkResult,
  ChunkingConfig,
  DEFAULT_CHUNKING_CONFIG,
  getOverlapCharacters,
} from '../../models/chunk.js';
import { PageOffset } from '../../models/document.js';
import {
  ProvenanceType,
  SourceType,
  ProvenanceLocation,
  CreateProvenanceParams,
} from '../../models/provenance.js';
import {
  parseMarkdownBlocks,
  buildSectionHierarchy,
  getPageNumberForOffset,
  MarkdownBlock,
} from './markdown-parser.js';
import {
  findAtomicRegions,
  isOffsetInAtomicRegion,
  extractTableStructures,
  extractHeadersFromMarkdown,
  countTableDimensionsFromMarkdown,
  extractFirstDataRow,
  generateTableSummary,
  type TableStructure,
} from './json-block-analyzer.js';
import { normalizeHeadingLevels } from './heading-normalizer.js';
import { mergeHeadingOnlyChunks } from './chunk-merger.js';

/**
 * Strip HTML tags from text and collapse whitespace.
 * Used to clean table chunk text before FTS5 indexing.
 */
function stripHtmlForFTS(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ');
}

/**
 * Create table metadata directly from chunk text by parsing pipe-delimited markdown.
 * Used as a fallback when offset-based table structure matching fails
 * (common with DOCX tables where locateBlockInMarkdown cannot find the table).
 */
function createTableMetadataFromText(chunkText: string): ChunkResult['tableMetadata'] {
  // Only attempt if text contains pipe-delimited table patterns
  const pipeLines = chunkText.split('\n').filter(l => l.includes('|'));
  if (pipeLines.length < 2) {
    return null;
  }

  const columnHeaders = extractHeadersFromMarkdown(chunkText);
  const { rowCount, columnCount } = countTableDimensionsFromMarkdown(chunkText);
  const firstRowValues = extractFirstDataRow(chunkText);
  const summary = generateTableSummary(columnHeaders, rowCount, firstRowValues);

  return {
    columnHeaders,
    rowCount,
    columnCount: columnCount > 0 ? columnCount : columnHeaders.length,
    summary,
  };
}

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

// ---------------------------------------------------------------------------
// Accumulator state for building chunks from blocks
// ---------------------------------------------------------------------------

interface Accumulator {
  text: string;
  blocks: MarkdownBlock[];
  startOffset: number;
  contentTypes: Set<string>;
}

function createEmptyAccumulator(startOffset: number): Accumulator {
  return {
    text: '',
    blocks: [],
    startOffset,
    contentTypes: new Set(),
  };
}

function accumulatorHasContent(acc: Accumulator): boolean {
  return acc.text.trim().length > 0;
}

function addBlockToAccumulator(acc: Accumulator, block: MarkdownBlock): void {
  if (acc.text.length > 0) {
    acc.text += '\n\n';
  }
  acc.text += block.text;
  acc.blocks.push(block);
  acc.contentTypes.add(mapBlockTypeToContentType(block.type));
}

function mapBlockTypeToContentType(blockType: string): string {
  switch (blockType) {
    case 'heading': return 'heading';
    case 'table': return 'table';
    case 'code': return 'code';
    case 'list': return 'list';
    case 'paragraph': return 'text';
    default: return 'text';
  }
}

// ---------------------------------------------------------------------------
// Sentence boundary detection
// ---------------------------------------------------------------------------

/**
 * Find a sentence boundary position for splitting text.
 *
 * Scans backward from `maxPos` looking for sentence-ending punctuation,
 * paragraph breaks, line breaks, or spaces. Returns the position just
 * after the boundary character (i.e., the start of the next sentence).
 *
 * @param text - The text to scan
 * @param maxPos - Maximum position (typically chunkSize)
 * @returns Position to split at
 */
function findSentenceBoundary(text: string, maxPos: number): number {
  const searchStart = Math.max(0, maxPos - 500);

  // Priority 1: Sentence endings (. ? !) followed by whitespace
  for (let i = maxPos; i >= searchStart; i--) {
    const ch = text[i];
    if ((ch === '.' || ch === '?' || ch === '!') && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === ' ' || next === '\n') {
        return i + 1; // Split after the punctuation
      }
    }
  }

  // Priority 2: Paragraph break (\n\n)
  for (let i = maxPos; i >= searchStart + 1; i--) {
    if (text[i] === '\n' && text[i - 1] === '\n') {
      return i + 1;
    }
  }

  // Priority 3: Line break (\n)
  for (let i = maxPos; i >= searchStart; i--) {
    if (text[i] === '\n') {
      return i + 1;
    }
  }

  // Priority 4: Any space
  for (let i = maxPos; i >= searchStart; i--) {
    if (text[i] === ' ') {
      return i + 1;
    }
  }

  // Last resort: force split at maxPos
  return maxPos;
}

// ---------------------------------------------------------------------------
// Page info determination
// ---------------------------------------------------------------------------

/**
 * Determine page number and page range for a character span.
 */
function determinePageInfoForSpan(
  startOffset: number,
  endOffset: number,
  pageOffsets: PageOffset[]
): { pageNumber: number | null; pageRange: string | null } {
  if (pageOffsets.length === 0) {
    return { pageNumber: null, pageRange: null };
  }

  const startPage = getPageNumberForOffset(startOffset, pageOffsets);
  const endPage = getPageNumberForOffset(
    Math.max(startOffset, endOffset - 1),
    pageOffsets
  );

  if (startPage === null) {
    return { pageNumber: null, pageRange: null };
  }

  if (endPage === null || startPage === endPage) {
    return { pageNumber: startPage, pageRange: null };
  }

  return {
    pageNumber: startPage,
    pageRange: `${startPage}-${endPage}`,
  };
}

// ---------------------------------------------------------------------------
// Main hybrid chunking function
// ---------------------------------------------------------------------------

/**
 * Hybrid section-aware chunking.
 *
 * Uses markdown structure (headings, paragraphs, tables), JSON block data
 * (for atomic region detection), and page offsets (for page tracking) to
 * produce semantically coherent chunks.
 *
 * @param text - Full markdown text from OCR output
 * @param pageOffsets - Page offset information for page number assignment
 * @param jsonBlocks - JSON block hierarchy from Datalab OCR (may be null)
 * @param config - Chunking configuration (default: 2000 chars, 10% overlap)
 * @returns Array of ChunkResult with section context, content types, and page info
 */
export function chunkHybridSectionAware(
  text: string,
  pageOffsets: PageOffset[],
  jsonBlocks: Record<string, unknown> | null,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): ChunkResult[] {
  // 1. Empty text returns empty array
  if (text.length === 0) {
    return [];
  }

  // 2. Parse markdown blocks
  const blocks = parseMarkdownBlocks(text, pageOffsets);

  // 3. If blocks is empty but text is not, something is wrong
  if (blocks.length === 0) {
    throw new Error(
      `Markdown parser returned no blocks for non-empty text (${text.length} chars)`
    );
  }

  // 3.5. Normalize heading levels if configured
  if (config.headingNormalization) {
    normalizeHeadingLevels(blocks, config.headingNormalization);
  }

  // 4. Build section hierarchy
  const sections = buildSectionHierarchy(blocks);

  // 5. Find atomic regions from JSON blocks
  const atomicRegions = findAtomicRegions(jsonBlocks, text, pageOffsets);

  // 5.5. Extract table structures for column header context (Task 7.2)
  const tableStructures = extractTableStructures(jsonBlocks, text, pageOffsets);

  /**
   * Find a table structure whose offset range overlaps a given block.
   */
  function findTableStructureForBlock(block: MarkdownBlock): TableStructure | null {
    for (const ts of tableStructures) {
      // Check if block overlaps this table structure
      if (block.startOffset < ts.endOffset && block.endOffset > ts.startOffset) {
        return ts;
      }
    }
    return null;
  }

  /**
   * Find table metadata for a chunk based on its offset range.
   * Returns metadata if the chunk overlaps with a known table structure.
   */
  function findTableMetadata(
    offset: number,
    length: number,
  ): ChunkResult['tableMetadata'] {
    const end = offset + length;
    for (const ts of tableStructures) {
      // Check if chunk overlaps with table structure
      if (offset <= ts.endOffset && end >= ts.startOffset) {
        return {
          columnHeaders: ts.columnHeaders,
          rowCount: ts.rowCount,
          columnCount: ts.columnCount,
          summary: ts.summary,
          caption: ts.caption,
          continuationOf: ts.continuationOf,
        };
      }
    }
    return null;
  }

  /**
   * Build a column header prefix string for a table chunk.
   * Format: "[Table: col1 | col2 | col3] "
   */
  function buildTableHeaderPrefix(ts: TableStructure): string {
    if (ts.columnHeaders.length === 0) return '';
    return `[Table: ${ts.columnHeaders.join(' | ')}] `;
  }

  // 6. Walk blocks, accumulating into chunks
  const chunks: ChunkResult[] = [];
  let accumulator = createEmptyAccumulator(0);
  let currentSectionPath: string | null = null;
  let currentHeadingText: string | null = null;
  let currentHeadingLevel: number | null = null;
  let chunkIndex = 0;
  const overlapSize = getOverlapCharacters(config);

  /**
   * Flush the accumulator as a chunk and reset it.
   */
  function flushAccumulator(isAtomic: boolean): void {
    if (!accumulatorHasContent(accumulator)) {
      return;
    }

    const chunkText = accumulator.text;
    const startOff = accumulator.startOffset;
    const endOff = startOff + chunkText.length;

    const pageInfo = determinePageInfoForSpan(startOff, endOff, pageOffsets);

    // Check if this flushed chunk overlaps with a table structure
    const hasTableContent = accumulator.contentTypes.has('table');
    const tableMetaForFlushed = hasTableContent
      ? (findTableMetadata(startOff, endOff - startOff) ?? createTableMetadataFromText(chunkText))
      : null;

    chunks.push({
      index: chunkIndex++,
      text: chunkText,
      startOffset: startOff,
      endOffset: endOff,
      overlapWithPrevious: 0, // Set in post-processing
      overlapWithNext: 0,     // Set in post-processing
      pageNumber: pageInfo.pageNumber,
      pageRange: pageInfo.pageRange,
      headingContext: currentHeadingText,
      headingLevel: currentHeadingLevel,
      sectionPath: currentSectionPath,
      contentTypes: Array.from(accumulator.contentTypes),
      isAtomic,
      tableMetadata: tableMetaForFlushed,
    });
  }

  /**
   * Emit a single block as an atomic chunk (table, code, or JSON-detected region).
   * For table blocks, prepends column header context if available (Task 7.2).
   */
  function emitAtomicChunk(block: MarkdownBlock): void {
    // Guard: reject empty blocks (same as flushAccumulator's accumulatorHasContent)
    if (block.text.trim().length === 0) {
      console.error(
        `[chunker] Skipping empty atomic block at offset ${block.startOffset}-${block.endOffset} ` +
        `(type=${block.type}, raw length=${block.text.length})`
      );
      return;
    }

    const startOff = block.startOffset;
    const endOff = block.endOffset;
    const pageInfo = determinePageInfoForSpan(startOff, endOff, pageOffsets);

    // Task 7.2: Prepend column header context for table chunks
    let chunkText = block.text;
    if (block.type === 'table') {
      // Strip HTML tags from table text for clean FTS indexing
      chunkText = stripHtmlForFTS(chunkText);
      const ts = findTableStructureForBlock(block);
      if (ts) {
        const prefix = buildTableHeaderPrefix(ts);
        if (prefix.length > 0) {
          chunkText = prefix + chunkText;
        }
      }
    }

    // Post-processing guard: HTML stripping or prefix may leave empty text
    if (chunkText.trim().length === 0) {
      console.error(
        `[chunker] Atomic chunk became empty after processing at offset ${startOff}-${endOff} ` +
        `(type=${block.type}, original length=${block.text.length})`
      );
      return;
    }

    const tableMetaForAtomicChunk = block.type === 'table'
      ? (findTableMetadata(startOff, endOff - startOff) ?? createTableMetadataFromText(chunkText))
      : null;

    chunks.push({
      index: chunkIndex++,
      text: chunkText,
      startOffset: startOff,
      endOffset: endOff,
      overlapWithPrevious: 0,
      overlapWithNext: 0,
      pageNumber: pageInfo.pageNumber,
      pageRange: pageInfo.pageRange,
      headingContext: currentHeadingText,
      headingLevel: currentHeadingLevel,
      sectionPath: currentSectionPath,
      contentTypes: [mapBlockTypeToContentType(block.type)],
      isAtomic: true,
      tableMetadata: tableMetaForAtomicChunk,
    });
  }

  /**
   * Emit an atomic block with size awareness: if the block exceeds
   * maxChunkSize, split it at line boundaries (row breaks for tables,
   * line breaks for code). Each sub-chunk inherits atomic status.
   * For table blocks, prepends column header context to each sub-chunk (Task 7.2).
   */
  function emitSizedAtomicChunk(block: MarkdownBlock): void {
    if (block.text.length <= config.maxChunkSize) {
      emitAtomicChunk(block);
      return;
    }

    // Task 7.2: Get table header prefix for table blocks
    let tablePrefix = '';
    if (block.type === 'table') {
      const ts = findTableStructureForBlock(block);
      if (ts) {
        tablePrefix = buildTableHeaderPrefix(ts);
      }
    }

    // Split oversized atomic block at line boundaries
    // Strip HTML tags from table text for clean FTS indexing
    const blockText = block.type === 'table' ? stripHtmlForFTS(block.text) : block.text;
    let pos = 0;

    while (pos < blockText.length) {
      let endPos: number;

      if (blockText.length - pos <= config.maxChunkSize) {
        // Remaining text fits in one chunk
        endPos = blockText.length;
      } else {
        // Find last newline before maxChunkSize boundary
        endPos = blockText.lastIndexOf('\n', pos + config.maxChunkSize);
        if (endPos <= pos) {
          // No newline found within range, force split at maxChunkSize
          endPos = pos + config.maxChunkSize;
        }
      }

      let chunkText = blockText.slice(pos, endPos);
      if (chunkText.trim().length > 0) {
        // Task 7.2: Prepend column header context to each table sub-chunk
        if (tablePrefix.length > 0) {
          chunkText = tablePrefix + chunkText;
        }

        const startOff = block.startOffset + pos;
        const endOff = block.startOffset + endPos;
        const pageInfo = determinePageInfoForSpan(startOff, endOff, pageOffsets);

        const tableMetaForSubChunk = block.type === 'table'
          ? (findTableMetadata(startOff, endOff - startOff) ?? createTableMetadataFromText(chunkText))
          : null;

        chunks.push({
          index: chunkIndex++,
          text: chunkText,
          startOffset: startOff,
          endOffset: endOff,
          overlapWithPrevious: 0,
          overlapWithNext: 0,
          pageNumber: pageInfo.pageNumber,
          pageRange: pageInfo.pageRange,
          headingContext: currentHeadingText,
          headingLevel: currentHeadingLevel,
          sectionPath: currentSectionPath,
          contentTypes: [mapBlockTypeToContentType(block.type)],
          isAtomic: true,
          tableMetadata: tableMetaForSubChunk,
        });
      }

      // Advance past the split point (skip newline if present)
      pos = endPos < blockText.length && blockText[endPos] === '\n' ? endPos + 1 : endPos;
    }
  }

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx];

    // Skip empty and page_marker blocks
    if (block.type === 'empty' || block.type === 'page_marker') {
      continue;
    }

    // Get section info for this block
    const sectionNode = sections.get(blockIdx);
    if (sectionNode) {
      currentSectionPath = sectionNode.path;
    }

    if (block.type === 'heading') {
      // Flush accumulator before starting new section
      flushAccumulator(false);

      // Update heading context
      currentHeadingText = block.headingText;
      currentHeadingLevel = block.headingLevel;

      // Start new accumulator with the heading
      accumulator = createEmptyAccumulator(block.startOffset);
      addBlockToAccumulator(accumulator, block);

    } else if (block.type === 'table' || block.type === 'code') {
      // Size-aware atomic treatment: only emit as atomic if block is large enough
      // to produce meaningful standalone embeddings. Small tables/code blocks are
      // merged into surrounding content for better embedding quality.
      const minAtomicSize = Math.floor(config.chunkSize / 4);

      if (block.text.length >= minAtomicSize) {
        // Large table/code → atomic chunk (with oversized splitting)
        flushAccumulator(false);
        emitSizedAtomicChunk(block);
        accumulator = createEmptyAccumulator(block.endOffset);
      } else {
        // Small table/code → treat as regular content, merge into accumulator
        addBlockToAccumulator(accumulator, block);

        // Check if accumulator exceeds chunk size (same logic as paragraph branch)
        if (accumulator.text.length > config.chunkSize) {
          const splitPos = findSentenceBoundary(accumulator.text, config.chunkSize);
          const fullText = accumulator.text;
          const savedStartOffset = accumulator.startOffset;
          const savedContentTypes = new Set(accumulator.contentTypes);

          accumulator.text = fullText.slice(0, splitPos);
          flushAccumulator(false);

          const remainder = fullText.slice(splitPos);
          accumulator = createEmptyAccumulator(savedStartOffset + splitPos);
          accumulator.text = remainder;
          accumulator.contentTypes = savedContentTypes;
        }
      }

    } else {
      // Regular content (paragraph, list)
      // Check if this block overlaps an atomic region from JSON blocks
      const atomicRegion = isOffsetInAtomicRegion(block.startOffset, atomicRegions);
      if (atomicRegion) {
        // This was detected as part of an atomic region by JSON analysis
        flushAccumulator(false);
        emitAtomicChunk(block);
        accumulator = createEmptyAccumulator(block.endOffset);
      } else {
        // Add to accumulator
        addBlockToAccumulator(accumulator, block);

        // Check if accumulator exceeds chunk size
        if (accumulator.text.length > config.chunkSize) {
          // Need to split - find sentence boundary
          const splitPos = findSentenceBoundary(accumulator.text, config.chunkSize);

          // Save state before flush
          const fullText = accumulator.text;
          const savedStartOffset = accumulator.startOffset;
          const savedContentTypes = new Set(accumulator.contentTypes);

          // Truncate accumulator text to split point and flush
          accumulator.text = fullText.slice(0, splitPos);
          flushAccumulator(false);

          // Keep the remainder in a new accumulator
          const remainder = fullText.slice(splitPos);
          accumulator = createEmptyAccumulator(savedStartOffset + splitPos);
          accumulator.text = remainder;
          accumulator.contentTypes = savedContentTypes;

          // If remainder still exceeds maxChunkSize, keep splitting
          while (accumulator.text.length > config.chunkSize) {
            const innerSplitPos = findSentenceBoundary(
              accumulator.text,
              config.chunkSize
            );
            const innerFullText = accumulator.text;
            const innerStartOffset = accumulator.startOffset;
            const innerContentTypes = new Set(accumulator.contentTypes);

            accumulator.text = innerFullText.slice(0, innerSplitPos);
            flushAccumulator(false);

            const innerRemainder = innerFullText.slice(innerSplitPos);
            accumulator = createEmptyAccumulator(innerStartOffset + innerSplitPos);
            accumulator.text = innerRemainder;
            accumulator.contentTypes = innerContentTypes;
          }
        }
      }
    }
  }

  // Flush any remaining content
  flushAccumulator(false);

  // 8.5. Merge heading-only tiny chunks with neighbors
  const mergedChunks = mergeHeadingOnlyChunks(chunks, config.minChunkSize ?? 100);
  // Replace chunks array contents with merged results
  chunks.length = 0;
  chunks.push(...mergedChunks);

  // 9. Set overlap values for non-atomic chunks
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (chunk.isAtomic) {
      // Atomic chunks never participate in overlap
      chunk.overlapWithPrevious = 0;
      chunk.overlapWithNext = 0;
      continue;
    }

    // Set overlapWithPrevious for non-first, non-atomic chunks
    if (i > 0 && !chunks[i - 1].isAtomic) {
      chunk.overlapWithPrevious = overlapSize;
    }

    // Set overlapWithNext for non-last, non-atomic chunks
    if (i < chunks.length - 1 && !chunks[i + 1].isAtomic) {
      chunk.overlapWithNext = overlapSize;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Provenance creation
// ---------------------------------------------------------------------------

/**
 * Create provenance parameters for a chunk.
 *
 * Generates a CreateProvenanceParams object suitable for creating
 * a CHUNK provenance record (chain_depth=2).
 *
 * @param params - Chunk provenance parameters
 * @returns CreateProvenanceParams ready for insertProvenance
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
    processor_version: '2.0.0',
    processing_params: {
      chunk_size: config.chunkSize,
      overlap_percent: config.overlapPercent,
      max_chunk_size: config.maxChunkSize,
      strategy: 'hybrid_section',
      chunk_index: chunk.index,
      total_chunks: totalChunks,
      character_start: chunk.startOffset,
      character_end: chunk.endOffset,
      heading_context: chunk.headingContext ?? null,
      section_path: chunk.sectionPath ?? null,
      is_atomic: chunk.isAtomic,
      content_types: chunk.contentTypes,
    },
    processing_duration_ms: processingDurationMs ?? null,
    location,
  };
}

// Re-export types for convenience
export type { ChunkResult, ChunkingConfig } from '../../models/chunk.js';
export { DEFAULT_CHUNKING_CONFIG } from '../../models/chunk.js';
