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
  const blockType = block.block_type as string | undefined;

  // Track page numbers from Page blocks
  let currentPageNum = pageNum;
  if (blockType === 'Page') {
    // Page blocks increment the page counter
    // The page number is tracked by order of appearance
    currentPageNum = pageNum;
  }

  // Call the callback for this block
  callback(block, currentPageNum);

  // Walk children
  const children = (block.children ?? block.blocks) as unknown[] | undefined;
  if (Array.isArray(children)) {
    let childPageNum = currentPageNum;
    for (const child of children) {
      const childBlock = child as Record<string, unknown>;
      const childType = childBlock.block_type as string | undefined;

      // If this child is a Page block, increment the page counter
      if (childType === 'Page' || (!childType && block === block)) {
        // For top-level iteration, count pages
      }

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
      tableEnd = tableEnd;
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
  let searchFrom = startIdx;

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
