/**
 * JSON Block Analyzer for Section-Aware Chunking
 *
 * Analyzes Datalab JSON block hierarchy to identify atomic (unsplittable)
 * regions such as tables, figures, and code blocks. These regions inform
 * the hybrid chunker where it must NOT split text.
 *
 * @module services/chunking/json-block-analyzer
 */

import { PageOffset } from '../../models/document.js';

/** A region in the markdown text that should not be split */
export interface AtomicRegion {
  startOffset: number;
  endOffset: number;
  blockType: string;
  pageNumber: number | null;
}

/** Block types that should be treated as atomic (unsplittable) */
const ATOMIC_BLOCK_TYPES = new Set([
  'Table',
  'TableGroup',
  'Figure',
  'FigureGroup',
  'Code',
]);

/**
 * Find atomic (unsplittable) regions in the markdown text by analyzing JSON blocks.
 *
 * Walks the Datalab JSON block tree, locates Table, TableGroup, Figure, FigureGroup,
 * and Code blocks, then finds their approximate positions in the markdown text using
 * fuzzy text matching. Returns sorted, non-overlapping regions.
 *
 * @param jsonBlocks - The JSON block hierarchy from Datalab OCR (may be null)
 * @param markdownText - The full markdown text to search within
 * @param pageOffsets - Page offset information for page number assignment
 * @returns Sorted array of AtomicRegion representing unsplittable text spans
 */
export function findAtomicRegions(
  jsonBlocks: Record<string, unknown> | null,
  markdownText: string,
  pageOffsets: PageOffset[]
): AtomicRegion[] {
  if (!jsonBlocks) {
    return [];
  }

  if (markdownText.length === 0) {
    return [];
  }

  const rawRegions: AtomicRegion[] = [];

  // Walk the JSON block tree
  walkBlocks(jsonBlocks, (block, pageNum) => {
    const blockType = block.block_type as string | undefined;
    if (!blockType || !ATOMIC_BLOCK_TYPES.has(blockType)) {
      return;
    }

    const region = locateBlockInMarkdown(block, blockType, pageNum, markdownText, pageOffsets);
    if (region) {
      rawRegions.push(region);
    }
  }, 0);

  // Sort by startOffset
  rawRegions.sort((a, b) => a.startOffset - b.startOffset);

  // Merge overlapping regions
  return mergeOverlappingRegions(rawRegions);
}

/**
 * Check if a character offset falls within an atomic region.
 *
 * Uses binary search on the sorted regions array for efficient lookup.
 *
 * @param offset - The character offset to check
 * @param regions - Sorted array of AtomicRegion (from findAtomicRegions)
 * @returns The containing AtomicRegion, or null if offset is not in any region
 */
export function isOffsetInAtomicRegion(offset: number, regions: AtomicRegion[]): AtomicRegion | null {
  if (regions.length === 0) {
    return null;
  }

  let low = 0;
  let high = regions.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const region = regions[mid];

    if (offset < region.startOffset) {
      high = mid - 1;
    } else if (offset >= region.endOffset) {
      low = mid + 1;
    } else {
      // offset >= region.startOffset && offset < region.endOffset
      return region;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and decode basic entities from an HTML string
 */
function stripHtmlTags(html: string): string {
  // Remove all HTML tags
  let text = html.replace(/<[^>]*>/g, '');

  // Decode basic HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  return text;
}

/**
 * Recursively walk the JSON block tree, calling the callback for each block.
 * Tracks the current page number from Page blocks.
 */
function walkBlocks(
  block: Record<string, unknown>,
  callback: (block: Record<string, unknown>, pageNum: number) => void,
  pageNum: number
): void {
  callback(block, pageNum);

  const children = (block.children ?? block.blocks) as unknown[] | undefined;
  if (Array.isArray(children)) {
    let childPageNum = pageNum;
    for (const child of children) {
      const childBlock = child as Record<string, unknown>;
      const childType = childBlock.block_type as string | undefined;

      walkBlocks(childBlock, callback, childPageNum);

      // After walking a Page child, increment for the next page
      if (childType === 'Page') {
        childPageNum++;
      }
    }
  }
}

/**
 * Attempt to locate a JSON block's content in the markdown text.
 * Uses different strategies depending on block type.
 */
function locateBlockInMarkdown(
  block: Record<string, unknown>,
  blockType: string,
  _pageNum: number,
  markdownText: string,
  pageOffsets: PageOffset[]
): AtomicRegion | null {
  // For Table blocks, search for the table's header row (first pipe-delimited line)
  if (blockType === 'Table' || blockType === 'TableGroup') {
    return locateTableInMarkdown(block, blockType, markdownText, pageOffsets);
  }

  // For Figure, FigureGroup, Code blocks: use HTML content
  return locateByHtmlContent(block, blockType, markdownText, pageOffsets);
}

/**
 * Locate a table block by searching for its header row pattern in markdown
 */
function locateTableInMarkdown(
  block: Record<string, unknown>,
  blockType: string,
  markdownText: string,
  pageOffsets: PageOffset[]
): AtomicRegion | null {
  // Try to get table content from the block's HTML or text
  const html = (block.html as string) ?? '';
  const strippedText = stripHtmlTags(html).trim();

  // Extract the first meaningful line as a search key
  let searchKey = '';

  if (strippedText.length > 0) {
    // Get first non-empty line from stripped HTML
    const lines = strippedText.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      searchKey = lines[0].trim().slice(0, 60);
    }
  }

  // Also try to find a markdown table pattern near the expected location
  // Search for pipe-delimited lines
  if (searchKey.length < 5) {
    // Fallback: try to find any table near the expected page
    return locateTableByPattern(blockType, markdownText, pageOffsets);
  }

  // Search for the key in the markdown
  const keyIdx = findFuzzyMatch(searchKey, markdownText);
  if (keyIdx === -1) {
    console.error(
      `[json-block-analyzer] Could not locate ${blockType} block with search key: "${searchKey.slice(0, 40)}..."`
    );
    return null;
  }

  // Find the extent of the table around this match point
  const tableExtent = findTableExtent(markdownText, keyIdx);
  if (!tableExtent) {
    return null;
  }

  validateRegionOffsets(tableExtent.start, tableExtent.end);

  return {
    startOffset: tableExtent.start,
    endOffset: tableExtent.end,
    blockType,
    pageNumber: getPageNumberForOffset(tableExtent.start, pageOffsets),
  };
}

/**
 * Locate a block by its HTML content using fuzzy text matching
 */
function locateByHtmlContent(
  block: Record<string, unknown>,
  blockType: string,
  markdownText: string,
  pageOffsets: PageOffset[]
): AtomicRegion | null {
  const html = (block.html as string) ?? '';
  if (html.length === 0) {
    // No HTML content to match against
    return null;
  }

  const strippedText = stripHtmlTags(html).trim();
  if (strippedText.length === 0) {
    return null;
  }

  // Use the first 50 characters as a search key
  const searchKey = strippedText.slice(0, 50).trim();
  if (searchKey.length < 3) {
    return null;
  }

  const matchIdx = findFuzzyMatch(searchKey, markdownText);
  if (matchIdx === -1) {
    console.error(
      `[json-block-analyzer] Could not locate ${blockType} block with content: "${searchKey.slice(0, 40)}..."`
    );
    return null;
  }

  // Estimate the end of this block:
  // For code blocks, look for closing fence
  // For figures, use a reasonable extent based on the full stripped text length
  let endIdx: number;

  if (blockType === 'Code') {
    endIdx = findCodeBlockEnd(markdownText, matchIdx);
  } else {
    // Figure/FigureGroup: estimate based on content length
    // Use the stripped text length as a rough guide, with a minimum extent
    const estimatedLength = Math.max(strippedText.length, 20);
    endIdx = Math.min(matchIdx + estimatedLength, markdownText.length);
  }

  validateRegionOffsets(matchIdx, endIdx);

  return {
    startOffset: matchIdx,
    endOffset: endIdx,
    blockType,
    pageNumber: getPageNumberForOffset(matchIdx, pageOffsets),
  };
}

/**
 * Find a fuzzy match for a search key in the markdown text.
 * First tries exact substring match, then falls back to normalized matching.
 *
 * @returns The start index of the match, or -1 if not found
 */
function findFuzzyMatch(searchKey: string, markdownText: string): number {
  // Try exact match first
  const exactIdx = markdownText.indexOf(searchKey);
  if (exactIdx !== -1) {
    return exactIdx;
  }

  // Normalize both strings: collapse whitespace, lowercase
  const normalizedKey = normalizeForSearch(searchKey);
  if (normalizedKey.length < 3) {
    return -1;
  }

  const normalizedText = normalizeForSearch(markdownText);
  const normalizedIdx = normalizedText.indexOf(normalizedKey);

  if (normalizedIdx === -1) {
    return -1;
  }

  // Map the normalized index back to the original text position.
  // Walk the original text, counting non-whitespace characters to find the
  // position that corresponds to the normalized index.
  return mapNormalizedIndexToOriginal(markdownText, normalizedIdx);
}

/**
 * Normalize text for fuzzy matching: collapse whitespace, lowercase
 */
function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Map a character index in normalized text back to the original text position.
 */
function mapNormalizedIndexToOriginal(originalText: string, normalizedIdx: number): number {
  let normalizedPos = 0;
  let inWhitespace = false;
  let started = false;

  for (let i = 0; i < originalText.length; i++) {
    const ch = originalText[i];
    const isWs = /\s/.test(ch);

    if (!started && isWs) {
      // Skip leading whitespace
      continue;
    }

    started = true;

    if (isWs) {
      if (!inWhitespace) {
        // First whitespace char after non-whitespace counts as one space
        if (normalizedPos === normalizedIdx) {
          return i;
        }
        normalizedPos++;
        inWhitespace = true;
      }
      // Additional whitespace chars are collapsed, don't increment
    } else {
      if (normalizedPos === normalizedIdx) {
        return i;
      }
      normalizedPos++;
      inWhitespace = false;
    }
  }

  // If we reach here, return the end of the text
  return originalText.length;
}

/**
 * Find the full extent of a markdown table around a given position
 */
function findTableExtent(
  markdownText: string,
  nearIdx: number
): { start: number; end: number } | null {
  // Find the start of the line containing nearIdx
  let lineStart = nearIdx;
  while (lineStart > 0 && markdownText[lineStart - 1] !== '\n') {
    lineStart--;
  }

  // Scan backward to find the first line of the table (starts with |)
  let tableStart = lineStart;
  while (tableStart > 0) {
    // Find start of previous line
    let prevLineStart = tableStart - 1;
    if (prevLineStart >= 0 && markdownText[prevLineStart] === '\n') {
      prevLineStart--;
    }
    while (prevLineStart > 0 && markdownText[prevLineStart - 1] !== '\n') {
      prevLineStart--;
    }

    const prevLine = markdownText.slice(prevLineStart, tableStart).trim();
    if (prevLine.startsWith('|') || prevLine.length === 0) {
      // The previous line is part of the table or empty (could be above table)
      if (prevLine.startsWith('|')) {
        tableStart = prevLineStart;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // Scan forward to find the last line of the table
  let tableEnd = nearIdx;
  while (tableEnd < markdownText.length) {
    // Find end of current line
    let lineEnd = tableEnd;
    while (lineEnd < markdownText.length && markdownText[lineEnd] !== '\n') {
      lineEnd++;
    }

    const currentLine = markdownText.slice(tableEnd, lineEnd).trim();
    if (currentLine.startsWith('|') || currentLine.length === 0) {
      tableEnd = lineEnd + 1;
      if (currentLine.length === 0 && tableEnd > nearIdx + 2) {
        // Empty line after some table content - table is done
        break;
      }
    } else {
      // Non-table line, table ends at start of this line
      break;
    }
  }

  // Ensure we don't go past the text
  tableEnd = Math.min(tableEnd, markdownText.length);

  if (tableEnd <= tableStart) {
    return null;
  }

  return { start: tableStart, end: tableEnd };
}

/**
 * Find the end of a code block starting near a given position
 */
function findCodeBlockEnd(markdownText: string, startIdx: number): number {
  // Look for the opening ``` line
  const searchFrom = startIdx;

  // First, find the opening fence if we're not exactly at it
  let fenceStart = markdownText.lastIndexOf('```', searchFrom);
  if (fenceStart === -1) {
    fenceStart = startIdx;
  }

  // Find the end of the opening fence line
  let pos = fenceStart + 3;
  while (pos < markdownText.length && markdownText[pos] !== '\n') {
    pos++;
  }
  pos++; // Skip the newline

  // Now look for the closing ```
  while (pos < markdownText.length) {
    if (markdownText.slice(pos).trimStart().startsWith('```')) {
      // Find the end of the closing fence line
      let endPos = pos;
      while (endPos < markdownText.length && markdownText[endPos] !== '\n') {
        endPos++;
      }
      return Math.min(endPos + 1, markdownText.length);
    }
    // Move to next line
    while (pos < markdownText.length && markdownText[pos] !== '\n') {
      pos++;
    }
    pos++; // Skip newline
  }

  // No closing fence found, return end of text
  return markdownText.length;
}

/**
 * Fallback: try to locate a table by scanning for pipe-delimited patterns
 * near the expected page region
 */
function locateTableByPattern(
  blockType: string,
  _markdownText: string,
  _pageOffsets: PageOffset[]
): AtomicRegion | null {
  // This is a fallback when we have no content to match.
  // We cannot reliably locate a specific table without content.
  console.error(
    `[json-block-analyzer] Could not locate ${blockType} block: no searchable content in HTML`
  );
  return null;
}

/**
 * Get page number for a character offset (delegates to page offsets lookup)
 */
function getPageNumberForOffset(charOffset: number, pageOffsets: PageOffset[]): number | null {
  if (pageOffsets.length === 0) {
    return null;
  }

  for (const page of pageOffsets) {
    if (charOffset >= page.charStart && charOffset < page.charEnd) {
      return page.page;
    }
  }

  // If past all pages, return last page
  if (charOffset >= pageOffsets[pageOffsets.length - 1].charEnd) {
    return pageOffsets[pageOffsets.length - 1].page;
  }

  return pageOffsets[0].page;
}

/**
 * Merge overlapping or adjacent regions in a sorted array
 */
function mergeOverlappingRegions(regions: AtomicRegion[]): AtomicRegion[] {
  if (regions.length <= 1) {
    return regions;
  }

  const merged: AtomicRegion[] = [regions[0]];

  for (let i = 1; i < regions.length; i++) {
    const current = regions[i];
    const last = merged[merged.length - 1];

    if (current.startOffset <= last.endOffset) {
      // Overlapping or adjacent - merge
      last.endOffset = Math.max(last.endOffset, current.endOffset);
      // Keep the block type of the larger region
      if (current.endOffset - current.startOffset > last.endOffset - last.startOffset) {
        last.blockType = current.blockType;
      }
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Validate that region offsets are non-negative and properly ordered
 */
function validateRegionOffsets(start: number, end: number): void {
  if (start < 0) {
    throw new Error(`Invalid negative startOffset in atomic region: ${start}`);
  }
  if (end < start) {
    throw new Error(`endOffset (${end}) is less than startOffset (${start}) in atomic region`);
  }
}

// ---------------------------------------------------------------------------
// Block-Type Statistics (ME-1 / Task 4.1)
// ---------------------------------------------------------------------------

/** Statistics about block types found in the JSON block hierarchy */
export interface BlockTypeStats {
  total_blocks: number;
  text_blocks: number;
  table_blocks: number;
  figure_blocks: number;
  code_blocks: number;
  list_blocks: number;
  header_blocks: number;
  footer_blocks: number;
  heading_blocks: number;
  page_count: number;
  tables_per_page: number;
  figures_per_page: number;
  text_density: number;
}

/**
 * Walk the JSON block tree and count block types to produce statistics.
 *
 * Recognizes: Text, Table, TableGroup, Figure, FigureGroup, Code,
 * ListItem, List, PageHeader, PageFooter, SectionHeader, Title, Page.
 *
 * @param jsonBlocks - The JSON block hierarchy from Datalab OCR (may be null)
 * @returns BlockTypeStats with counts and derived ratios
 */
export function computeBlockTypeStats(
  jsonBlocks: Record<string, unknown> | null
): BlockTypeStats | null {
  if (!jsonBlocks) {
    return null;
  }

  const counts = {
    total: 0,
    text: 0,
    table: 0,
    figure: 0,
    code: 0,
    list: 0,
    header: 0,
    footer: 0,
    heading: 0,
    page: 0,
  };

  const countBlocks = (block: Record<string, unknown>): void => {
    const blockType = block.block_type as string | undefined;
    if (blockType) {
      counts.total++;
      switch (blockType) {
        case 'Text':
          counts.text++;
          break;
        case 'Table':
        case 'TableGroup':
          counts.table++;
          break;
        case 'Figure':
        case 'FigureGroup':
          counts.figure++;
          break;
        case 'Code':
          counts.code++;
          break;
        case 'ListItem':
        case 'List':
          counts.list++;
          break;
        case 'PageHeader':
          counts.header++;
          break;
        case 'PageFooter':
          counts.footer++;
          break;
        case 'SectionHeader':
        case 'Title':
          counts.heading++;
          break;
        case 'Page':
          counts.page++;
          break;
        // Other block types still count toward total_blocks
      }
    }

    const children = (block.children ?? block.blocks) as unknown[] | undefined;
    if (Array.isArray(children)) {
      for (const child of children) {
        countBlocks(child as Record<string, unknown>);
      }
    }
  };

  countBlocks(jsonBlocks);

  const pageCount = Math.max(counts.page, 1);
  // Content blocks = non-structural blocks (exclude Page, PageHeader, PageFooter)
  const contentBlocks = counts.total - counts.page - counts.header - counts.footer;

  return {
    total_blocks: counts.total,
    text_blocks: counts.text,
    table_blocks: counts.table,
    figure_blocks: counts.figure,
    code_blocks: counts.code,
    list_blocks: counts.list,
    header_blocks: counts.header,
    footer_blocks: counts.footer,
    heading_blocks: counts.heading,
    page_count: counts.page,
    tables_per_page: Math.round((counts.table / pageCount) * 100) / 100,
    figures_per_page: Math.round((counts.figure / pageCount) * 100) / 100,
    text_density: contentBlocks > 0
      ? Math.round((counts.text / contentBlocks) * 100) / 100
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Block-Type Confidence Scoring (ME-8 / Task 4.3)
// ---------------------------------------------------------------------------

/**
 * Confidence scores for block types, used to compute chunk quality from
 * the block types present in a chunk. Higher values indicate more structured
 * and typically more reliable content.
 */
export const BLOCK_TYPE_CONFIDENCE: Record<string, number> = {
  Table: 0.9,
  TableGroup: 0.9,
  Code: 0.9,
  SectionHeader: 0.85,
  Title: 0.85,
  ListItem: 0.8,
  List: 0.8,
  Text: 0.7,
  Figure: 0.6,
  PageHeader: 0.5,
  PageFooter: 0.5,
};

/**
 * Compute a confidence score for a chunk based on the block types it contains.
 *
 * Returns the average confidence across all content types in the chunk.
 * Unknown block types default to 0.7. An empty content types array also
 * defaults to 0.7.
 *
 * @param contentTypes - Array of block type strings from the chunk
 * @returns Confidence score between 0 and 1
 */
export function computeBlockConfidence(contentTypes: string[]): number {
  if (contentTypes.length === 0) return 0.7;
  const scores = contentTypes.map((t) => BLOCK_TYPE_CONFIDENCE[t] ?? 0.7);
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// ---------------------------------------------------------------------------
// Header/Footer Detection (HE-2 / Task 7.1)
// ---------------------------------------------------------------------------

/** Information about headers and footers detected in the JSON block tree */
export interface HeaderFooterInfo {
  headerTexts: string[];
  footerTexts: string[];
  repeatedHeaders: string[];   // appearing on >50% of pages (min 2 pages)
  repeatedFooters: string[];   // appearing on >50% of pages (min 2 pages)
}

/**
 * Extract text content from a block by walking its HTML or children.
 * Returns the concatenated text content, stripped of HTML tags.
 */
function extractBlockText(block: Record<string, unknown>): string {
  // Try HTML content first
  const html = (block.html as string) ?? '';
  if (html.length > 0) {
    return stripHtmlTags(html).trim();
  }

  // Try direct text content
  const text = (block.text as string) ?? '';
  if (text.length > 0) {
    return text.trim();
  }

  // Walk children to collect text
  const children = (block.children ?? block.blocks) as unknown[] | undefined;
  if (Array.isArray(children)) {
    const parts: string[] = [];
    for (const child of children) {
      const childText = extractBlockText(child as Record<string, unknown>);
      if (childText.length > 0) {
        parts.push(childText);
      }
    }
    return parts.join(' ').trim();
  }

  return '';
}

/**
 * Detect repeated headers and footers from the JSON block tree.
 *
 * Walks the block tree for each page, collecting PageHeader and PageFooter
 * block texts. A text is considered "repeated" if it appears on >50% of pages
 * with at least 2 occurrences.
 *
 * @param jsonBlocks - The JSON block hierarchy from Datalab OCR (may be null)
 * @returns HeaderFooterInfo with all and repeated header/footer texts
 */
export function detectRepeatedHeadersFooters(
  jsonBlocks: Record<string, unknown> | null
): HeaderFooterInfo {
  const result: HeaderFooterInfo = {
    headerTexts: [],
    footerTexts: [],
    repeatedHeaders: [],
    repeatedFooters: [],
  };

  if (!jsonBlocks) {
    return result;
  }

  // Collect header/footer texts per page
  const headerCounts = new Map<string, number>();
  const footerCounts = new Map<string, number>();
  let pageCount = 0;

  // Walk the tree collecting PageHeader and PageFooter blocks
  walkBlocks(jsonBlocks, (block, _pageNum) => {
    const blockType = block.block_type as string | undefined;
    if (!blockType) return;

    if (blockType === 'Page') {
      pageCount++;
      return;
    }

    if (blockType === 'PageHeader') {
      const text = extractBlockText(block);
      if (text.length > 0) {
        result.headerTexts.push(text);
        headerCounts.set(text, (headerCounts.get(text) ?? 0) + 1);
      }
    } else if (blockType === 'PageFooter') {
      const text = extractBlockText(block);
      if (text.length > 0) {
        result.footerTexts.push(text);
        footerCounts.set(text, (footerCounts.get(text) ?? 0) + 1);
      }
    }
  }, 0);

  // Ensure at least 1 page for percentage calculation
  const effectivePageCount = Math.max(pageCount, 1);
  const threshold = effectivePageCount / 2;

  // Repeated = appears on >50% of pages, with at least 2 occurrences
  for (const [text, count] of headerCounts) {
    if (count >= 2 && count > threshold) {
      result.repeatedHeaders.push(text);
    }
  }

  for (const [text, count] of footerCounts) {
    if (count >= 2 && count > threshold) {
      result.repeatedFooters.push(text);
    }
  }

  return result;
}

/**
 * Check if a chunk's text closely matches any of the repeated header/footer texts.
 * Uses normalized comparison (lowercased, whitespace-collapsed).
 *
 * @param chunkText - The chunk text to check
 * @param repeatedTexts - Array of repeated header/footer texts
 * @returns true if the chunk text matches a repeated header/footer
 */
export function isRepeatedHeaderFooter(
  chunkText: string,
  repeatedTexts: string[]
): boolean {
  if (repeatedTexts.length === 0) return false;

  const normalizedChunk = chunkText.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalizedChunk.length === 0) return false;

  for (const repeated of repeatedTexts) {
    const normalizedRepeated = repeated.toLowerCase().replace(/\s+/g, ' ').trim();
    // Exact match or chunk contains the repeated text
    if (normalizedChunk === normalizedRepeated) return true;
    // Check if the chunk is very short and is a substring of the repeated text
    if (normalizedChunk.length <= normalizedRepeated.length * 1.2 &&
        normalizedRepeated.includes(normalizedChunk)) return true;
    // Check if the repeated text is contained in a short chunk
    if (normalizedChunk.length <= normalizedRepeated.length * 1.5 &&
        normalizedChunk.includes(normalizedRepeated)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Table Structure Extraction (HE-3 / Task 7.2)
// ---------------------------------------------------------------------------

/** Extracted structure information for a table block */
export interface TableStructure {
  startOffset: number;
  endOffset: number;
  columnHeaders: string[];
  rowCount: number;
  columnCount: number;
  pageNumber: number | null;
  /** Human-readable summary of table content */
  summary: string;
  /** Values from the first data row (for summary generation) */
  firstRowValues: string[];
  /** Caption text from preceding block (e.g., "Table 1: Budget Summary") */
  caption?: string;
  /** Index of a prior table this continues (cross-page table detection) */
  continuationOf?: number;
}

/**
 * Extract table structures from the JSON block tree.
 *
 * Walks json_blocks for Table/TableGroup blocks, extracts column headers
 * from the first row, and maps to markdown text offsets.
 *
 * @param jsonBlocks - The JSON block hierarchy from Datalab OCR (may be null)
 * @param markdownText - The full markdown text to search within
 * @param pageOffsets - Page offset information for page number assignment
 * @returns Array of TableStructure with column headers and position info
 */
export function extractTableStructures(
  jsonBlocks: Record<string, unknown> | null,
  markdownText: string,
  pageOffsets: PageOffset[]
): TableStructure[] {
  if (!jsonBlocks || markdownText.length === 0) {
    return [];
  }

  const structures: TableStructure[] = [];
  /** Track previous block for caption detection */
  let previousBlockText = '';

  walkBlocks(jsonBlocks, (block, _pageNum) => {
    const blockType = block.block_type as string | undefined;

    // Track non-table block text for caption detection
    if (blockType && blockType !== 'Table' && blockType !== 'TableGroup') {
      const text = extractBlockText(block);
      if (text.length > 0) {
        previousBlockText = text;
      }
      return;
    }

    if (blockType !== 'Table' && blockType !== 'TableGroup') {
      return;
    }

    // Locate the table in markdown text first (needed for markdown fallbacks)
    const region = locateBlockInMarkdown(block, blockType, _pageNum, markdownText, pageOffsets);
    if (!region) {
      previousBlockText = '';
      return;
    }

    // Get the markdown text range for this table
    const tableMarkdown = markdownText.slice(region.startOffset, region.endOffset);

    // Extract column headers from the block's children, with markdown fallback
    let columnHeaders = extractTableColumnHeaders(block);
    if (columnHeaders.length === 0) {
      columnHeaders = extractHeadersFromMarkdown(tableMarkdown);
    }

    // Count rows from block children, with markdown fallback
    let { rowCount, columnCount } = countTableDimensions(block, columnHeaders.length);
    if (rowCount === 0) {
      const mdDims = countTableDimensionsFromMarkdown(tableMarkdown);
      rowCount = mdDims.rowCount;
      if (columnCount === 0) columnCount = mdDims.columnCount;
    }

    // Extract first data row values from markdown for summary
    const firstRowValues = extractFirstDataRow(tableMarkdown);

    // Detect caption from preceding block
    let caption: string | undefined;
    if (previousBlockText.length > 0 && /^(Table|Figure)\s+\d+[.:]/i.test(previousBlockText)) {
      caption = previousBlockText.slice(0, 200);
    }

    // Generate summary
    const summary = generateTableSummary(columnHeaders, rowCount, firstRowValues, caption);

    structures.push({
      startOffset: region.startOffset,
      endOffset: region.endOffset,
      columnHeaders,
      rowCount,
      columnCount,
      pageNumber: region.pageNumber,
      summary,
      firstRowValues,
      caption,
    });

    previousBlockText = '';
  }, 0);

  // Cross-page table continuity detection
  detectTableContinuations(structures);

  return structures;
}

/**
 * Extract column headers from the first pipe-delimited row of markdown table text.
 * Fallback when JSON block children don't contain TableRow elements.
 */
export function extractHeadersFromMarkdown(tableMarkdown: string): string[] {
  const lines = tableMarkdown.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) continue;
    // Skip separator rows like |---|---|
    if (/^\|?[\s-:|]+\|?$/.test(trimmed)) continue;
    // Parse pipe-delimited cells
    const cells = trimmed.split('|')
      .map(c => c.trim())
      .filter(c => c.length > 0);
    if (cells.length > 0) return cells;
  }
  return [];
}

/**
 * Count table dimensions from markdown pipe-delimited text.
 * Counts data rows (excludes header and separator rows).
 */
export function countTableDimensionsFromMarkdown(tableMarkdown: string): { rowCount: number; columnCount: number } {
  const lines = tableMarkdown.split('\n').filter(l => l.trim().length > 0 && l.includes('|'));
  if (lines.length === 0) return { rowCount: 0, columnCount: 0 };

  let maxCols = 0;
  let headerFound = false;
  let dataRows = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Check if separator row
    if (/^\|?[\s-:|]+\|?$/.test(trimmed)) {
      continue;
    }
    const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (cells.length > maxCols) maxCols = cells.length;

    if (!headerFound) {
      headerFound = true; // first non-separator row is the header
    } else {
      dataRows++;
    }
  }

  return { rowCount: dataRows, columnCount: maxCols };
}

/**
 * Extract values from the first data row (after header and separator) of markdown table.
 */
export function extractFirstDataRow(tableMarkdown: string): string[] {
  const lines = tableMarkdown.split('\n').filter(l => l.trim().length > 0 && l.includes('|'));
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|?[\s-:|]+\|?$/.test(trimmed)) {
      continue;
    }
    if (!headerSeen) {
      headerSeen = true;
      continue;
    }
    // First non-header, non-separator row is the first data row
    return trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
  }
  return [];
}

/**
 * Generate a human-readable summary of table content.
 * Format: "Table with N rows and columns: col1, col2. Sample: val1, val2"
 * Max 200 chars.
 */
export function generateTableSummary(
  columnHeaders: string[],
  rowCount: number,
  firstRowValues: string[],
  caption?: string,
): string {
  const parts: string[] = [];

  if (caption) {
    parts.push(caption);
  }

  const rowDesc = rowCount > 0 ? `${rowCount} rows` : 'rows';
  if (columnHeaders.length > 0) {
    parts.push(`Table with ${rowDesc} and columns: ${columnHeaders.join(', ')}`);
  } else {
    parts.push(`Table with ${rowDesc}`);
  }

  if (firstRowValues.length > 0) {
    parts.push(`Sample: ${firstRowValues.join(', ')}`);
  }

  let summary = parts.join('. ');
  if (summary.length > 200) {
    summary = summary.slice(0, 197) + '...';
  }
  return summary;
}

/**
 * Detect cross-page table continuations by comparing column headers.
 * Consecutive tables with matching headers on adjacent pages are linked.
 */
function detectTableContinuations(structures: TableStructure[]): void {
  if (structures.length < 2) return;

  for (let i = 1; i < structures.length; i++) {
    const prev = structures[i - 1];
    const curr = structures[i];

    // Both must have column headers to compare
    if (prev.columnHeaders.length === 0 || curr.columnHeaders.length === 0) continue;

    // Must be on adjacent pages (or page info unavailable)
    if (prev.pageNumber !== null && curr.pageNumber !== null) {
      if (curr.pageNumber - prev.pageNumber > 1) continue;
    }

    // Compare column headers: exact match or >80% overlap
    const overlap = columnHeaderOverlap(prev.columnHeaders, curr.columnHeaders);
    if (overlap >= 0.8) {
      curr.continuationOf = i - 1;
    }
  }
}

/**
 * Compute Sorensen-Dice similarity between two column header arrays.
 */
function columnHeaderOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a.map(h => h.toLowerCase().trim()));
  const setB = new Set(b.map(h => h.toLowerCase().trim()));
  let intersection = 0;
  for (const h of setA) {
    if (setB.has(h)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * Extract column headers from the first row of a table block.
 * Looks for the first TableRow/Row child and extracts cell texts.
 */
function extractTableColumnHeaders(block: Record<string, unknown>): string[] {
  const children = (block.children ?? block.blocks) as unknown[] | undefined;
  if (!Array.isArray(children) || children.length === 0) {
    // Try extracting from HTML content as fallback
    return extractHeadersFromHtml(block);
  }

  // Look for the first row-like child
  for (const child of children) {
    const childBlock = child as Record<string, unknown>;
    const childType = childBlock.block_type as string | undefined;

    if (childType === 'TableRow' || childType === 'Row' || childType === 'TableHeader') {
      const cells = (childBlock.children ?? childBlock.blocks) as unknown[] | undefined;
      if (Array.isArray(cells) && cells.length > 0) {
        const headers: string[] = [];
        for (const cell of cells) {
          const cellBlock = cell as Record<string, unknown>;
          const cellText = extractBlockText(cellBlock);
          if (cellText.length > 0) {
            headers.push(cellText);
          }
        }
        if (headers.length > 0) return headers;
      }
    }

    // For TableGroup, check nested Table children
    if (childType === 'Table') {
      const tableHeaders = extractTableColumnHeaders(childBlock);
      if (tableHeaders.length > 0) return tableHeaders;
    }
  }

  // Fallback: try HTML parsing
  return extractHeadersFromHtml(block);
}

/**
 * Extract table headers from block HTML content (fallback).
 * Looks for the first row in an HTML table.
 */
function extractHeadersFromHtml(block: Record<string, unknown>): string[] {
  const html = (block.html as string) ?? '';
  if (html.length === 0) return [];

  // Try to find <th> elements first
  const thMatches = html.match(/<th[^>]*>(.*?)<\/th>/gi);
  if (thMatches && thMatches.length > 0) {
    return thMatches.map(th => stripHtmlTags(th).trim()).filter(t => t.length > 0);
  }

  // Try first <tr> and extract <td> elements
  const firstRowMatch = html.match(/<tr[^>]*>(.*?)<\/tr>/i);
  if (firstRowMatch) {
    const tdMatches = firstRowMatch[1].match(/<td[^>]*>(.*?)<\/td>/gi);
    if (tdMatches && tdMatches.length > 0) {
      return tdMatches.map(td => stripHtmlTags(td).trim()).filter(t => t.length > 0);
    }
  }

  return [];
}

/**
 * Count table dimensions from block children, with HTML fallback.
 */
function countTableDimensions(
  block: Record<string, unknown>,
  headerColumnCount: number
): { rowCount: number; columnCount: number } {
  const children = (block.children ?? block.blocks) as unknown[] | undefined;

  let rowCount = 0;
  let maxColumns = headerColumnCount;

  if (Array.isArray(children) && children.length > 0) {
    for (const child of children) {
      const childBlock = child as Record<string, unknown>;
      const childType = childBlock.block_type as string | undefined;

      if (childType === 'TableRow' || childType === 'Row' || childType === 'TableHeader') {
        rowCount++;
        const cells = (childBlock.children ?? childBlock.blocks) as unknown[] | undefined;
        if (Array.isArray(cells) && cells.length > maxColumns) {
          maxColumns = cells.length;
        }
      } else if (childType === 'Table') {
        // Nested table in TableGroup
        const nested = countTableDimensions(childBlock, headerColumnCount);
        rowCount += nested.rowCount;
        if (nested.columnCount > maxColumns) maxColumns = nested.columnCount;
      }
    }
  }

  // HTML fallback: count <tr> elements when block children yield 0 rows
  if (rowCount === 0) {
    const html = (block.html as string) ?? '';
    if (html.length > 0) {
      const trMatches = html.match(/<tr[^>]*>/gi);
      if (trMatches) {
        // Subtract 1 for header row (data rows only)
        rowCount = Math.max(0, trMatches.length - 1);
      }
      // Count max columns from HTML if needed
      if (maxColumns === 0) {
        const firstRowMatch = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
        if (firstRowMatch) {
          const cellCount = (firstRowMatch[1].match(/<t[dh][^>]*>/gi) ?? []).length;
          if (cellCount > maxColumns) maxColumns = cellCount;
        }
      }
    }
  }

  return { rowCount, columnCount: maxColumns };
}
