/**
 * Markdown Parser for Section-Aware Chunking
 *
 * Parses Datalab markdown output into structural blocks with section hierarchy,
 * enabling the hybrid chunker to make intelligent split decisions.
 *
 * @module services/chunking/markdown-parser
 */

import { PageOffset } from '../../models/document.js';

/** Classification of a markdown text block */
export type MarkdownBlockType =
  | 'heading'
  | 'table'
  | 'code'
  | 'list'
  | 'paragraph'
  | 'page_marker'
  | 'empty';

/** A single structural block parsed from markdown */
export interface MarkdownBlock {
  type: MarkdownBlockType;
  text: string;
  startOffset: number;
  endOffset: number;
  headingLevel: number | null;
  headingText: string | null;
  pageNumber: number | null;
}

/** Section hierarchy node */
export interface SectionNode {
  level: number;
  text: string;
  path: string;
}

/**
 * Page marker pattern used by Datalab to denote page boundaries.
 * Matches patterns like:
 *   ---\n<!-- Page 3 -->
 * with optional surrounding whitespace.
 */
const PAGE_MARKER_REGEX = /^\s*---\s*\n\s*<!--\s*Page\s+\d+\s*-->\s*$/;

/**
 * Datalab page separator pattern.
 * Matches: {0}------------------------------------------------
 * Format: {digits} followed by 10+ dashes, optionally followed by whitespace.
 */
const DATALAB_PAGE_SEPARATOR_REGEX = /^\s*\{\d+\}-{10,}\s*$/;

/**
 * Heading pattern: 1-6 hash marks followed by a space and text
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)/;

/**
 * Bold-only heading pattern: entire line is bold text (**...**).
 * Used to detect headings in Datalab OCR output where headings are rendered
 * as bold text rather than ATX-style markdown headings.
 * Examples: "**HEADING TEXT**", "**I. MERIT STRENGTH**", "**A. Sub-heading**"
 */
const BOLD_HEADING_REGEX = /^\*\*(.+)\*\*$/;

/**
 * Roman numeral prefix pattern for heading level detection.
 * Matches: I., II., III., IV., V., VI., VII., VIII., IX., X., XI., etc.
 * Requires at least one Roman numeral character before the period.
 */
const ROMAN_NUMERAL_PREFIX = /^(X{0,3}(?:IX|IV|V?I{1,3}|V)|X+)\.\s/;

/**
 * Letter prefix pattern (A., B., C., etc.) for heading level detection.
 */
const LETTER_PREFIX = /^[A-Z]\.\s/;

/**
 * Numbered prefix pattern (1., 2., 3., etc.) for heading level detection.
 */
const NUMBERED_PREFIX = /^\d+\.\s/;

/**
 * Table separator line pattern: line with pipes and dashes/colons
 */
const TABLE_SEPARATOR_REGEX = /^\|[\s\-:|]+\|$/;

/**
 * List item pattern: unordered (- * +) or ordered (digits.)
 */
const LIST_ITEM_REGEX = /^(\s*[-*+]\s|\s*\d+\.\s)/;

/**
 * Parse markdown text into structural blocks.
 *
 * Splits text by double-newline separators, classifies each segment by type
 * (heading, table, code, list, paragraph, page_marker, empty), and tracks
 * character offsets and page numbers.
 *
 * @param text - The full markdown text from Datalab OCR output
 * @param pageOffsets - Page offset information for page number assignment
 * @returns Array of MarkdownBlock with type, offsets, and page info
 */
export function parseMarkdownBlocks(text: string, pageOffsets: PageOffset[]): MarkdownBlock[] {
  if (text.length === 0) {
    return [];
  }

  // Split by double newline to get raw segments
  const rawSegments = text.split('\n\n');
  const blocks: MarkdownBlock[] = [];
  let currentOffset = 0;

  let i = 0;
  while (i < rawSegments.length) {
    const segment = rawSegments[i];

    // Check if this segment starts a code fence - may need to merge segments
    if (isCodeFenceOpen(segment)) {
      // Scan forward to find the closing fence
      const merged = mergeCodeFenceSegments(rawSegments, i);
      const mergedText = merged.text;
      const mergedCount = merged.segmentCount;

      const startOffset = currentOffset;
      const endOffset = startOffset + mergedText.length;

      blocks.push({
        type: 'code',
        text: mergedText,
        startOffset,
        endOffset,
        headingLevel: null,
        headingText: null,
        pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
      });

      // Advance offset past the merged text plus the \n\n separators between segments
      currentOffset = endOffset;
      // Account for \n\n separators after all but the last merged segment
      if (i + mergedCount < rawSegments.length) {
        currentOffset += 2; // The \n\n after the code block
      }
      i += mergedCount;
      continue;
    }

    const startOffset = currentOffset;
    const endOffset = startOffset + segment.length;

    const block = classifySegment(segment, startOffset, endOffset, pageOffsets);
    blocks.push(block);

    // Advance offset: segment length + 2 for the \n\n separator (unless last segment)
    currentOffset = endOffset;
    if (i < rawSegments.length - 1) {
      currentOffset += 2; // \n\n separator
    }

    i++;
  }

  return blocks;
}

/**
 * Build a section hierarchy map from parsed markdown blocks.
 *
 * Walks the blocks in order, maintaining a heading stack. Each block
 * (heading or content) is mapped to its SectionNode, which includes
 * the heading level, text, and full path (e.g., "Intro > Background > History").
 *
 * @param blocks - Array of MarkdownBlock from parseMarkdownBlocks
 * @returns Map from block index to SectionNode. Blocks before any heading
 *   will not have an entry in the map.
 */
export function buildSectionHierarchy(blocks: MarkdownBlock[]): Map<number, SectionNode> {
  const result = new Map<number, SectionNode>();

  // Stack of headings: index = heading level (1-6), value = heading text
  // We use indices 1-6, ignore index 0
  const headingStack: (string | null)[] = [null, null, null, null, null, null, null];

  let currentNode: SectionNode | null = null;

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx];

    if (block.type === 'heading' && block.headingLevel !== null && block.headingText !== null) {
      const level = block.headingLevel;

      // Clear all entries at levels >= this heading's level
      for (let l = level; l <= 6; l++) {
        headingStack[l] = null;
      }

      // Push this heading onto the stack at its level
      headingStack[level] = block.headingText;

      // Build path by joining all stack entries that are non-null
      const pathParts: string[] = [];
      for (let l = 1; l <= 6; l++) {
        if (headingStack[l] !== null) {
          pathParts.push(headingStack[l] as string);
        }
      }

      currentNode = {
        level,
        text: block.headingText,
        path: pathParts.join(' > '),
      };

      result.set(blockIdx, currentNode);
    } else {
      // Non-heading blocks inherit the section from the most recent heading
      if (currentNode !== null) {
        result.set(blockIdx, currentNode);
      }
      // If no heading seen yet, don't add an entry
    }
  }

  return result;
}

/**
 * Find the page number for a given character offset using binary search.
 *
 * @param charOffset - The character offset to look up
 * @param pageOffsets - Sorted array of page offset ranges
 * @returns The 1-indexed page number, or null if pageOffsets is empty
 */
export function getPageNumberForOffset(
  charOffset: number,
  pageOffsets: PageOffset[]
): number | null {
  if (pageOffsets.length === 0) {
    return null;
  }

  // If offset is before the first page start, return first page number
  if (charOffset < pageOffsets[0].charStart) {
    return pageOffsets[0].page;
  }

  // If offset is at or after the last page's end, return last page number
  const lastPage = pageOffsets[pageOffsets.length - 1];
  if (charOffset >= lastPage.charEnd) {
    return lastPage.page;
  }

  // Binary search for the page containing this offset
  let low = 0;
  let high = pageOffsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const page = pageOffsets[mid];

    if (charOffset < page.charStart) {
      high = mid - 1;
    } else if (charOffset >= page.charEnd) {
      low = mid + 1;
    } else {
      // charOffset >= page.charStart && charOffset < page.charEnd
      return page.page;
    }
  }

  // Should not reach here if pageOffsets covers the full text,
  // but fall back to the nearest page
  if (low >= pageOffsets.length) {
    return pageOffsets[pageOffsets.length - 1].page;
  }
  return pageOffsets[low].page;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if a segment opens a code fence (starts with ``` but doesn't close it)
 */
function isCodeFenceOpen(segment: string): boolean {
  const trimmed = segment.trimStart();
  if (!trimmed.startsWith('```')) {
    return false;
  }

  // Count occurrences of ``` in the segment
  // A self-contained code block has both opening and closing fences
  const fenceMatches = segment.match(/^```/gm);
  if (!fenceMatches) {
    return false;
  }

  // If there's an odd number of fence markers, the block is not self-contained
  // (opening without closing, or includes nested fences that are unbalanced)
  // More precisely: check if there's a closing ``` on its own line after the opening
  const lines = segment.split('\n');
  let openCount = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      openCount++;
    }
  }

  // Odd count means the fence is unclosed within this segment
  return openCount % 2 !== 0;
}

/**
 * Merge segments that are part of a code fence block split by \n\n.
 * Returns the merged text and the number of segments consumed.
 */
function mergeCodeFenceSegments(
  segments: string[],
  startIdx: number
): { text: string; segmentCount: number } {
  const parts: string[] = [segments[startIdx]];
  let idx = startIdx + 1;

  while (idx < segments.length) {
    parts.push(segments[idx]);

    // Check if this segment contains the closing fence
    const lines = segments[idx].split('\n');
    let hasClosingFence = false;
    for (const line of lines) {
      if (line.trimStart().startsWith('```')) {
        hasClosingFence = true;
        break;
      }
    }

    idx++;

    if (hasClosingFence) {
      break;
    }
  }

  // Join with \n\n since that's what was used to split
  return {
    text: parts.join('\n\n'),
    segmentCount: idx - startIdx,
  };
}

/**
 * Classify a single text segment into a MarkdownBlock
 */
function classifySegment(
  segment: string,
  startOffset: number,
  endOffset: number,
  pageOffsets: PageOffset[]
): MarkdownBlock {
  // Validate offsets
  if (startOffset < 0) {
    throw new Error(`Invalid negative startOffset: ${startOffset}`);
  }
  if (endOffset < startOffset) {
    throw new Error(`endOffset (${endOffset}) is less than startOffset (${startOffset})`);
  }

  const trimmed = segment.trim();

  // Empty block
  if (trimmed.length === 0) {
    return {
      type: 'empty',
      text: segment,
      startOffset,
      endOffset,
      headingLevel: null,
      headingText: null,
      pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
    };
  }

  // Page marker (HTML comment format or Datalab {N}--- format)
  if (PAGE_MARKER_REGEX.test(segment) || DATALAB_PAGE_SEPARATOR_REGEX.test(segment)) {
    return {
      type: 'page_marker',
      text: segment,
      startOffset,
      endOffset,
      headingLevel: null,
      headingText: null,
      pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
    };
  }

  // Heading: first line starts with #{1,6} followed by space
  const firstLine = segment.split('\n')[0];
  const headingMatch = HEADING_REGEX.exec(firstLine);
  if (headingMatch) {
    return {
      type: 'heading',
      text: segment,
      startOffset,
      endOffset,
      headingLevel: headingMatch[1].length,
      headingText: headingMatch[2].trim(),
      pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
    };
  }

  // Bold-text heading: first line is entirely bold (**...**).
  // Datalab OCR often renders document headings as bold text rather than
  // ATX-style headings. Only match when the first line is a standalone bold line.
  const boldHeadingResult = detectBoldHeading(firstLine);
  if (boldHeadingResult !== null) {
    return {
      type: 'heading',
      text: segment,
      startOffset,
      endOffset,
      headingLevel: boldHeadingResult.level,
      headingText: boldHeadingResult.text,
      pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
    };
  }

  // Table: has at least 2 lines, at least one line with | at start and end,
  // and a separator line matching the table separator pattern
  if (isTable(segment)) {
    return {
      type: 'table',
      text: segment,
      startOffset,
      endOffset,
      headingLevel: null,
      headingText: null,
      pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
    };
  }

  // Code fence (self-contained - both open and close in same segment)
  if (trimmed.startsWith('```')) {
    return {
      type: 'code',
      text: segment,
      startOffset,
      endOffset,
      headingLevel: null,
      headingText: null,
      pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
    };
  }

  // List: first line starts with list marker
  if (LIST_ITEM_REGEX.test(firstLine)) {
    return {
      type: 'list',
      text: segment,
      startOffset,
      endOffset,
      headingLevel: null,
      headingText: null,
      pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
    };
  }

  // Default: paragraph
  return {
    type: 'paragraph',
    text: segment,
    startOffset,
    endOffset,
    headingLevel: null,
    headingText: null,
    pageNumber: getPageNumberForOffset(startOffset, pageOffsets),
  };
}

/**
 * Check if a segment is a markdown table
 */
/**
 * Extract page offsets from markdown text by scanning for Datalab page markers.
 *
 * This is used when re-chunking already-OCR'd documents where the original
 * pageOffsets from Datalab are no longer available.
 * The function reconstructs page boundaries from the `---\n<!-- Page N -->`
 * markers embedded in the markdown text.
 *
 * @param text - The full markdown text containing Datalab page markers
 * @returns Array of PageOffset sorted by page number, or empty array if no markers found
 */
export function extractPageOffsetsFromText(text: string): PageOffset[] {
  // Match Datalab page markers in both formats:
  // Format 1 (HTML comment): ---\n<!-- Page N -->
  // Format 2 (Datalab separator): {N}------------------------------------------------
  const htmlMarkerRegex = /---\n<!--\s*Page\s+(\d+)\s*-->/g;
  const datalabMarkerRegex = /\{(\d+)\}-{10,}/g;
  const markers: Array<{ page: number; markerStart: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = htmlMarkerRegex.exec(text)) !== null) {
    markers.push({
      page: parseInt(match[1], 10),
      markerStart: match.index,
    });
  }

  // Also check Datalab {N}--- format (page numbers are 0-based, convert to 1-based)
  while ((match = datalabMarkerRegex.exec(text)) !== null) {
    const pageNum = parseInt(match[1], 10);
    // Only add if this position wasn't already captured by the HTML format
    const alreadyCaptured = markers.some((m) => Math.abs(m.markerStart - match!.index) < 10);
    if (!alreadyCaptured) {
      markers.push({
        page: pageNum + 1, // Convert 0-based to 1-based
        markerStart: match.index,
      });
    }
  }

  // Sort by position in text
  markers.sort((a, b) => a.markerStart - b.markerStart);

  if (markers.length === 0) {
    return [];
  }

  const offsets: PageOffset[] = [];

  // Page 1 starts at offset 0 (content before the first marker belongs to page 1
  // or the page number of the first marker if it's not page 1)
  // Each subsequent page starts after the previous marker
  for (let i = 0; i < markers.length; i++) {
    const charStart = i === 0 ? 0 : markers[i].markerStart;
    const charEnd = i < markers.length - 1 ? markers[i + 1].markerStart : text.length;

    offsets.push({
      page: markers[i].page,
      charStart,
      charEnd,
    });
  }

  // Sort by page number (should already be sorted, but be safe)
  offsets.sort((a, b) => a.page - b.page);

  return offsets;
}

/**
 * Detect if a line is a bold-text heading and determine its level.
 *
 * Datalab OCR often renders document headings as bold text (**...**) rather
 * than ATX-style markdown headings (# ...). This function checks if the
 * first line of a segment is entirely bold and heuristically assigns a
 * heading level based on text characteristics.
 *
 * Level assignment heuristics:
 * - ALL CAPS bold text: level 1 (e.g., "**DEFENSE ARGUMENTS**")
 * - Roman numeral prefix (I., II., III.): level 2 (e.g., "**I. MERIT STRENGTH**")
 * - Letter prefix (A., B., C.): level 3 (e.g., "**A. Wound Tracker**")
 * - Numbered prefix (1., 2., 3.): level 3 (e.g., "**1. First Item**")
 * - Mixed case bold text: level 2 (e.g., "**Provider Chronology**")
 *
 * @param firstLine - The first line of a segment (trimmed by caller)
 * @returns Object with level and text if bold heading detected, null otherwise
 */
function detectBoldHeading(firstLine: string): { level: number; text: string } | null {
  const trimmedLine = firstLine.trim();
  const boldMatch = BOLD_HEADING_REGEX.exec(trimmedLine);
  if (!boldMatch) {
    return null;
  }

  const innerText = boldMatch[1].trim();

  // Reject empty or too-short bold text (must be at least 3 characters)
  if (innerText.length < 3) {
    return null;
  }

  // Reject very long bold text (>200 chars) - likely a paragraph, not a heading
  if (innerText.length > 200) {
    return null;
  }

  // Reject if the bold text contains pipe characters (likely a table cell)
  if (innerText.includes('|')) {
    return null;
  }

  // Reject if the bold text is only numbers and/or punctuation
  if (/^[\d\s.,;:!?'"()\-/]+$/.test(innerText)) {
    return null;
  }

  // Determine heading level heuristically
  const level = determineBoldHeadingLevel(innerText);

  return { level, text: innerText };
}

/**
 * Determine the heading level for bold text based on its content.
 *
 * @param text - The inner text of the bold heading (without ** markers)
 * @returns Heading level (1-3)
 */
function determineBoldHeadingLevel(text: string): number {
  // Check for Roman numeral prefix first (e.g., "I. MERIT STRENGTH")
  if (ROMAN_NUMERAL_PREFIX.test(text)) {
    return 2;
  }

  // Check for letter prefix (e.g., "A. Wound Tracker")
  if (LETTER_PREFIX.test(text)) {
    return 3;
  }

  // Check for numbered prefix (e.g., "1. First Item")
  if (NUMBERED_PREFIX.test(text)) {
    return 3;
  }

  // Check if ALL CAPS (ignoring non-letter characters like periods, spaces, slashes)
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return 1;
  }

  // Default: mixed case bold text gets level 2
  return 2;
}

function isTable(segment: string): boolean {
  const lines = segment.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return false;
  }

  // Check if at least one line has | at start and end (trimmed)
  let hasPipeRow = false;
  let hasSeparatorLine = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('|') && trimmedLine.endsWith('|')) {
      hasPipeRow = true;
    }
    if (TABLE_SEPARATOR_REGEX.test(trimmedLine)) {
      hasSeparatorLine = true;
    }
  }

  return hasPipeRow && hasSeparatorLine;
}
