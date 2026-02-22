/**
 * Quality scoring utilities shared by BM25, vector, and fusion search.
 *
 * @module services/search/quality
 */

/**
 * Compute a quality-weighted score multiplier from an OCR quality score.
 * Quality 5.0 -> 1.0, Quality 0.0 -> 0.8, null/undefined -> 0.9 (neutral)
 */
export function computeQualityMultiplier(qualityScore: number | null | undefined): number {
  if (qualityScore !== null && qualityScore !== undefined) {
    return 0.8 + 0.04 * qualityScore;
  }
  return 0.9;
}
