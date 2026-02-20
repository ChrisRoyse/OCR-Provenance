/**
 * Text Normalizer for Embedding Input
 *
 * Strips OCR artifacts (like leading line numbers from PDF rendering)
 * from chunk text before sending to the embedding model. The raw text
 * is preserved in the database for provenance and display.
 *
 * @module services/chunking/text-normalizer
 */

/**
 * Leading line number pattern from PDF OCR output.
 *
 * Matches lines starting with one or more digits followed by 2+ spaces.
 * PDFs with line numbering typically use 6-8 trailing spaces. The 2+ space
 * requirement avoids false positives with:
 * - Ordered lists: "1. Item" (dot after number)
 * - Section numbers: "1.2 Title" (dot separator)
 * - Year references: "2024 was..." (single space)
 */
const LINE_NUMBER_REGEX = /^\d+\s{2,}/gm;

/**
 * Normalize text for embedding by stripping OCR artifacts.
 *
 * Currently strips leading line numbers that pollute embedding vectors.
 * The original text is preserved in the database for provenance.
 *
 * @param text - Raw chunk text from OCR output
 * @returns Cleaned text suitable for embedding
 */
export function normalizeForEmbedding(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text.replace(LINE_NUMBER_REGEX, '');
}
