/**
 * String similarity utilities for entity resolution
 *
 * Provides Sorensen-Dice coefficient, token-sorted similarity, initial matching,
 * abbreviation expansion, case number normalization, amount comparison, and
 * location containment checks.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 */

/**
 * Common organization name abbreviation expansions
 */
const ORG_ABBREVIATIONS: Record<string, string> = {
  'corp.': 'corporation', 'corp': 'corporation',
  'inc.': 'incorporated', 'inc': 'incorporated',
  'ltd.': 'limited', 'ltd': 'limited',
  'llc': 'limited liability company',
  'llp': 'limited liability partnership',
  'co.': 'company', 'co': 'company',
  'dept.': 'department', 'dept': 'department',
  'assn.': 'association', 'assn': 'association',
  'intl.': 'international', 'intl': 'international',
  'natl.': 'national', 'natl': 'national',
  'univ.': 'university', 'univ': 'university',
  'govt.': 'government', 'govt': 'government',
};

/**
 * Extract character bigrams from a string
 *
 * @param str - Input string
 * @returns Set of all two-character substrings
 */
function getBigrams(str: string): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Sorensen-Dice coefficient on character bigrams
 *
 * Computes similarity between two strings using the formula:
 * dice = 2 * |intersection| / (|A| + |B|)
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity score between 0 and 1 (1 = identical)
 */
export function sorensenDice(a: string, b: string): number {
  const normA = a.toLowerCase().trim();
  const normB = b.toLowerCase().trim();

  if (normA === normB) return 1.0;
  if (normA.length < 2 || normB.length < 2) return 0.0;

  const bigramsA = getBigrams(normA);
  const bigramsB = getBigrams(normB);

  if (bigramsA.size === 0 && bigramsB.size === 0) return 1.0;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) {
      intersectionSize++;
    }
  }

  return (2 * intersectionSize) / (bigramsA.size + bigramsB.size);
}

/**
 * Token-sorted similarity: sort words alphabetically, then Sorensen-Dice
 *
 * Handles reordered names like "Smith, John" vs "John Smith" by sorting
 * all tokens alphabetically before comparison.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity score between 0 and 1
 */
export function tokenSortedSimilarity(a: string, b: string): number {
  const sortTokens = (s: string): string =>
    s.toLowerCase().trim()
      .replace(/[,;]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0)
      .sort()
      .join(' ');

  return sorensenDice(sortTokens(a), sortTokens(b));
}

/**
 * Check if one name is an initial-abbreviated form of another
 *
 * Matches patterns like:
 * - "J. Smith" matches "John Smith"
 * - "J Smith" matches "John Smith"
 * - "A. B. Carter" matches "Alice B. Carter"
 *
 * @param a - First name string
 * @param b - Second name string
 * @returns true if one is an initial-abbreviated form of the other
 */
export function initialMatch(a: string, b: string): boolean {
  const normA = a.toLowerCase().trim();
  const normB = b.toLowerCase().trim();

  if (normA === normB) return true;

  const tokensA = normA.replace(/[,;]/g, ' ').split(/\s+/).filter(t => t.length > 0);
  const tokensB = normB.replace(/[,;]/g, ' ').split(/\s+/).filter(t => t.length > 0);

  // Require same number of tokens
  if (tokensA.length !== tokensB.length) return false;
  if (tokensA.length === 0) return false;

  // Check if every token pair matches (either exactly or by initial)
  let hasInitial = false;
  for (let i = 0; i < tokensA.length; i++) {
    const tA = tokensA[i].replace(/\.$/, '');
    const tB = tokensB[i].replace(/\.$/, '');

    if (tA === tB) continue;

    // Check if one is a single-char initial of the other
    if (tA.length === 1 && tB.length > 1 && tB.startsWith(tA)) {
      hasInitial = true;
      continue;
    }
    if (tB.length === 1 && tA.length > 1 && tA.startsWith(tB)) {
      hasInitial = true;
      continue;
    }

    return false;
  }

  // Must have at least one initial match (otherwise it's just an exact match)
  return hasInitial;
}

/**
 * Expand common abbreviations in organization names
 *
 * Replaces known abbreviations (Corp., Inc., Ltd., LLC, etc.) with their
 * full-length equivalents for more accurate comparison.
 *
 * @param text - Organization name potentially containing abbreviations
 * @returns Expanded text with abbreviations replaced
 */
export function expandAbbreviations(text: string): string {
  let result = text.toLowerCase().trim();

  // Sort by key length descending so "corp." is matched before "co"
  const sortedKeys = Object.keys(ORG_ABBREVIATIONS).sort((a, b) => b.length - a.length);

  for (const abbrev of sortedKeys) {
    // Use word boundary matching to avoid replacing inside other words
    const escaped = abbrev.replace(/\./g, '\\.');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, ORG_ABBREVIATIONS[abbrev]);
  }

  return result;
}

/**
 * Normalize a case number by stripping whitespace and normalizing separators
 *
 * Removes excess whitespace, normalizes dashes and colons, and converts
 * to lowercase for consistent comparison.
 *
 * @param text - Raw case number string
 * @returns Normalized case number string
 */
export function normalizeCaseNumber(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')         // Strip all whitespace
    .replace(/[:\u2013\u2014]/g, '-')  // Normalize en-dash, em-dash, colon to hyphen
    .replace(/-+/g, '-');        // Collapse multiple hyphens
}

/**
 * Compare two monetary amounts with tolerance
 *
 * Parses numeric values from amount strings (stripping currency symbols,
 * commas, etc.) and checks if they are within a percentage tolerance.
 *
 * @param a - First amount string (e.g., "$1,234.56")
 * @param b - Second amount string (e.g., "1234.56")
 * @param tolerance - Fractional tolerance (default 0.01 = 1%)
 * @returns true if amounts match within tolerance
 */
export function amountsMatch(a: string, b: string, tolerance: number = 0.01): boolean {
  const parseAmount = (s: string): number | null => {
    // Strip currency symbols, commas, spaces
    const cleaned = s.replace(/[$\u20AC\u00A3\u00A5,\s]/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  const valA = parseAmount(a);
  const valB = parseAmount(b);

  if (valA === null || valB === null) return false;
  if (valA === 0 && valB === 0) return true;

  const maxVal = Math.max(Math.abs(valA), Math.abs(valB));
  if (maxVal === 0) return true;

  return Math.abs(valA - valB) / maxVal <= tolerance;
}

/**
 * Check if one location contains the other as a substring
 *
 * Performs case-insensitive containment check in both directions.
 * "New York" matches "New York City" and vice versa.
 *
 * @param a - First location string
 * @param b - Second location string
 * @returns true if one location contains the other
 */
export function locationContains(a: string, b: string): boolean {
  const normA = a.toLowerCase().trim();
  const normB = b.toLowerCase().trim();

  if (normA === normB) return true;

  return normA.includes(normB) || normB.includes(normA);
}
