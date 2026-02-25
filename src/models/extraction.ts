/**
 * Extraction interface for structured data extracted via page_schema
 * Provenance depth: 2 (parallel to CHUNK)
 */
export interface Extraction {
  id: string;
  document_id: string;
  ocr_result_id: string;
  schema_json: string;
  extraction_json: string;
  content_hash: string;
  provenance_id: string;
  created_at: string;
}
