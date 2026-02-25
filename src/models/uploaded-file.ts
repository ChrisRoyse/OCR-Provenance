/**
 * UploadedFile interface for Datalab cloud file uploads
 * Provenance depth: 0 (root level, parallel to DOCUMENT)
 */
export interface UploadedFile {
  id: string;
  local_path: string;
  file_name: string;
  file_hash: string;
  file_size: number;
  content_type: string;
  datalab_file_id: string | null;
  datalab_reference: string | null;
  upload_status: 'pending' | 'uploading' | 'confirming' | 'complete' | 'failed';
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  provenance_id: string;
}
