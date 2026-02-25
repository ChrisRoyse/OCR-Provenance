/**
 * FormFill interface for form fill results from Datalab /fill API
 * Provenance depth: 1
 */
export interface FormFill {
  id: string;
  source_file_path: string;
  source_file_hash: string;
  field_data_json: string;
  context: string | null;
  confidence_threshold: number;
  output_file_path: string | null;
  output_base64: string | null;
  fields_filled: string;
  fields_not_found: string;
  page_count: number | null;
  cost_cents: number | null;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  error_message: string | null;
  provenance_id: string;
  created_at: string;
}
