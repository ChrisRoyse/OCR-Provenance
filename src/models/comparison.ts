/**
 * Comparison interfaces for OCR Provenance MCP System
 *
 * Types for document comparison (text diff, structural diff).
 * Pure types - no logic.
 */

/**
 * A single diff operation (insert, delete, or equal)
 */
export interface TextDiffOperation {
  type: 'insert' | 'delete' | 'equal';
  text: string;
  doc1_offset: number;
  doc2_offset: number;
  line_count: number;
}

/**
 * Result of comparing two documents' text content
 */
export interface TextDiffResult {
  operations: TextDiffOperation[];
  total_operations: number;
  truncated: boolean;
  insertions: number;
  deletions: number;
  unchanged: number;
  similarity_ratio: number;
  doc1_length: number;
  doc2_length: number;
}

/**
 * Structural metadata comparison between two documents
 */
export interface StructuralDiff {
  doc1_page_count: number | null;
  doc2_page_count: number | null;
  doc1_chunk_count: number;
  doc2_chunk_count: number;
  doc1_text_length: number;
  doc2_text_length: number;
  doc1_quality_score: number | null;
  doc2_quality_score: number | null;
  doc1_ocr_mode: string;
  doc2_ocr_mode: string;
}

/**
 * Stored comparison record (maps to comparisons table row)
 */
export interface Comparison {
  id: string;
  document_id_1: string;
  document_id_2: string;
  similarity_ratio: number;
  text_diff_json: string;
  structural_diff_json: string;
  summary: string;
  content_hash: string;
  provenance_id: string;
  created_at: string;
  processing_duration_ms: number | null;
}
