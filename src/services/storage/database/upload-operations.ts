/**
 * Upload operations for DatabaseService
 *
 * Handles all CRUD operations for uploaded_files table
 * tracking Datalab cloud file uploads.
 */

import Database from 'better-sqlite3';
import { UploadedFile } from '../../../models/uploaded-file.js';
import { runWithForeignKeyCheck } from './helpers.js';

/**
 * Insert an uploaded file record
 *
 * @param db - Database connection
 * @param data - Uploaded file data
 * @returns string - The uploaded file ID
 */
export function insertUploadedFile(db: Database.Database, data: UploadedFile): UploadedFile {
  const stmt = db.prepare(`
    INSERT INTO uploaded_files (
      id, local_path, file_name, file_hash, file_size, content_type,
      datalab_file_id, datalab_reference, upload_status, error_message,
      created_at, completed_at, provenance_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      data.id,
      data.local_path,
      data.file_name,
      data.file_hash,
      data.file_size,
      data.content_type,
      data.datalab_file_id,
      data.datalab_reference,
      data.upload_status,
      data.error_message,
      data.created_at,
      data.completed_at,
      data.provenance_id,
    ],
    `inserting uploaded file: FK violation for provenance_id="${data.provenance_id}"`
  );

  return data;
}

/**
 * Get an uploaded file by ID
 *
 * @param db - Database connection
 * @param id - Uploaded file ID
 * @returns UploadedFile | null
 */
export function getUploadedFile(db: Database.Database, id: string): UploadedFile | null {
  return (
    (db.prepare('SELECT * FROM uploaded_files WHERE id = ?').get(id) as UploadedFile | undefined) ??
    null
  );
}

/**
 * Get an uploaded file by file hash (for deduplication)
 *
 * @param db - Database connection
 * @param fileHash - SHA-256 hash of the file
 * @returns UploadedFile | null - The first matching upload or null
 */
export function getUploadedFileByHash(
  db: Database.Database,
  fileHash: string
): UploadedFile | null {
  return (
    (db
      .prepare(
        'SELECT * FROM uploaded_files WHERE file_hash = ? AND upload_status = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(fileHash, 'complete') as UploadedFile | undefined) ?? null
  );
}

/**
 * List uploaded files with optional filtering
 *
 * @param db - Database connection
 * @param options - Optional filter options (status, limit, offset)
 * @returns UploadedFile[] - Array of uploaded files
 */
export function listUploadedFiles(
  db: Database.Database,
  options?: { status?: string; limit?: number; offset?: number }
): UploadedFile[] {
  let query = 'SELECT * FROM uploaded_files';
  const params: (string | number)[] = [];

  if (options?.status) {
    query += ' WHERE upload_status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options?.limit !== undefined) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset !== undefined) {
    if (options?.limit === undefined) {
      query += ' LIMIT 10000'; // bounded default
    }
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  return db.prepare(query).all(...params) as UploadedFile[];
}

/**
 * Update uploaded file status
 *
 * @param db - Database connection
 * @param id - Uploaded file ID
 * @param status - New upload status
 * @param errorMessage - Optional error message (for 'failed' status)
 */
export function updateUploadedFileStatus(
  db: Database.Database,
  id: string,
  status: 'pending' | 'uploading' | 'confirming' | 'complete' | 'failed',
  errorMessage?: string
): void {
  const completedAt = status === 'complete' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE uploaded_files SET upload_status = ?, error_message = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?'
  ).run(status, errorMessage ?? null, completedAt, id);
}

/**
 * Update uploaded file with Datalab file ID and reference after successful upload
 *
 * @param db - Database connection
 * @param id - Uploaded file ID
 * @param datalabFileId - Datalab cloud file ID
 * @param datalabReference - Datalab reference string
 */
export function updateUploadedFileDatalabInfo(
  db: Database.Database,
  id: string,
  datalabFileId: string,
  datalabReference: string | null
): void {
  db.prepare(
    'UPDATE uploaded_files SET datalab_file_id = ?, datalab_reference = ? WHERE id = ?'
  ).run(datalabFileId, datalabReference, id);
}

/**
 * Delete an uploaded file record
 *
 * @param db - Database connection
 * @param id - Uploaded file ID
 * @returns boolean - true if a record was deleted
 */
export function deleteUploadedFile(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM uploaded_files WHERE id = ?').run(id).changes > 0;
}
