/**
 * Heading Level Normalizer for Section-Aware Chunking
 *
 * Fixes inconsistent heading levels from Datalab OCR by detecting
 * repeating heading patterns (e.g., "ARTICLE N") and normalizing
 * their heading levels to the mode (most common) level within each group.
 *
 * @module services/chunking/heading-normalizer
 */

import { MarkdownBlock } from './markdown-parser.js';

/** Configuration for heading normalization */
export interface HeadingNormalizationConfig {
  /** Enable heading normalization (default: false) */
  enabled: boolean;
  /** Minimum pattern group size to trigger normalization (default: 3) */
  minPatternCount?: number;
}

/** A recognized heading pattern and its members */
interface PatternGroup {
  /** Pattern name for debugging */
  name: string;
  /** Block indices of headings matching this pattern */
  blockIndices: number[];
  /** Heading levels for each member (parallel to blockIndices) */
  levels: number[];
}

/**
 * Patterns that identify structural heading groups in legal/organizational documents.
 * Each regex matches the heading text (not the markdown # prefix).
 * Bold-wrapped text (e.g., **ARTICLE 1**) is stripped before matching.
 */
const HEADING_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'ARTICLE', regex: /^ARTICLE\s+\d+/i },
  { name: 'SECTION', regex: /^SECTION\s+\d+(\.\d+)*/i },
  { name: 'CHAPTER', regex: /^CHAPTER\s+\d+/i },
  { name: 'PART', regex: /^PART\s+\d+/i },
  { name: 'TITLE', regex: /^TITLE\s+\d+/i },
  { name: 'APPENDIX', regex: /^APPENDIX\s+[A-Z0-9]/i },
  { name: 'SCHEDULE', regex: /^SCHEDULE\s+[A-Z0-9]/i },
  { name: 'EXHIBIT', regex: /^EXHIBIT\s+[A-Z0-9]/i },
];

/**
 * Strip bold markers (**text**) from heading text for pattern matching.
 */
function stripBold(text: string): string {
  return text.replace(/^\*\*(.+)\*\*$/, '$1').trim();
}

/**
 * Compute the mode (most frequent value) of a number array.
 * Ties are broken by preferring the smaller value.
 */
function computeMode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }

  let modeValue = values[0];
  let modeCount = 0;
  for (const [val, count] of counts) {
    if (count > modeCount || (count === modeCount && val < modeValue)) {
      modeValue = val;
      modeCount = count;
    }
  }
  return modeValue;
}

/**
 * Normalize heading levels in-place for consistent section hierarchy.
 *
 * Groups headings by structural patterns (ARTICLE N, Section N.N, etc.),
 * then normalizes each group to use the mode heading level. This fixes
 * Datalab OCR inconsistencies where identical structural headings get
 * assigned different levels (e.g., ARTICLE 1 as H1 but ARTICLE 5 as H3).
 *
 * Only mutates `block.headingLevel` - never modifies `block.text`.
 *
 * @param blocks - Parsed markdown blocks (mutated in-place)
 * @param config - Normalization configuration
 * @returns The same blocks array (for chaining convenience)
 */
export function normalizeHeadingLevels(
  blocks: MarkdownBlock[],
  config: HeadingNormalizationConfig
): MarkdownBlock[] {
  if (!config.enabled) {
    return blocks;
  }

  const minCount = config.minPatternCount ?? 3;

  // Build pattern groups
  const groups: PatternGroup[] = HEADING_PATTERNS.map(p => ({
    name: p.name,
    blockIndices: [],
    levels: [],
  }));

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== 'heading' || block.headingLevel === null || block.headingText === null) {
      continue;
    }

    const cleanText = stripBold(block.headingText);

    for (let g = 0; g < HEADING_PATTERNS.length; g++) {
      if (HEADING_PATTERNS[g].regex.test(cleanText)) {
        groups[g].blockIndices.push(i);
        groups[g].levels.push(block.headingLevel);
        break; // A heading belongs to at most one pattern group
      }
    }
  }

  // Normalize groups that meet the minimum count threshold
  for (const group of groups) {
    if (group.blockIndices.length < minCount) {
      continue;
    }

    const targetLevel = computeMode(group.levels);

    for (const blockIdx of group.blockIndices) {
      blocks[blockIdx].headingLevel = targetLevel;
    }
  }

  return blocks;
}
