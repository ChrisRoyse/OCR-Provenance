/**
 * Form fill operations for DatabaseService
 *
 * Handles all CRUD operations for form fill results
 * from the Datalab /fill API.
 */

import Database from 'better-sqlite3';
import { FormFill } from '../../../models/form-fill.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { escapeLikePattern } from '../../../utils/validation.js';

/**
 * Insert a form fill record
 *
 * @param db - Database connection
 * @param formFill - Form fill data
 * @param updateMetadataCounts - Callback to update metadata counts
 * @returns string - The form fill ID
 */
export function insertFormFill(
  db: Database.Database,
  formFill: FormFill,
  updateMetadataCounts: () => void
): string {
  const stmt = db.prepare(`
    INSERT INTO form_fills (
      id, source_file_path, source_file_hash, field_data_json, context,
      confidence_threshold, output_file_path, output_base64, fields_filled,
      fields_not_found, page_count, cost_cents, status, error_message,
      provenance_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      formFill.id,
      formFill.source_file_path,
      formFill.source_file_hash,
      formFill.field_data_json,
      formFill.context,
      formFill.confidence_threshold,
      formFill.output_file_path,
      formFill.output_base64,
      formFill.fields_filled,
      formFill.fields_not_found,
      formFill.page_count,
      formFill.cost_cents,
      formFill.status,
      formFill.error_message,
      formFill.provenance_id,
      formFill.created_at,
    ],
    `inserting form fill: FK violation for provenance_id="${formFill.provenance_id}"`
  );

  updateMetadataCounts();
  return formFill.id;
}

/**
 * Get a form fill by ID
 *
 * @param db - Database connection
 * @param id - Form fill ID
 * @returns FormFill | null - The form fill or null if not found
 */
export function getFormFill(db: Database.Database, id: string): FormFill | null {
  return (db.prepare('SELECT * FROM form_fills WHERE id = ?').get(id) as FormFill | undefined) ?? null;
}

/**
 * List form fills with optional filtering
 *
 * @param db - Database connection
 * @param options - Optional filter options (status, limit, offset)
 * @returns FormFill[] - Array of form fills
 */
export function listFormFills(
  db: Database.Database,
  options?: { status?: string; limit?: number; offset?: number }
): FormFill[] {
  let query = 'SELECT * FROM form_fills';
  const params: (string | number)[] = [];

  if (options?.status) {
    query += ' WHERE status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options?.limit !== undefined) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset !== undefined) {
    if (options?.limit === undefined) {
      query += ' LIMIT 10000';  // bounded default
    }
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  return db.prepare(query).all(...params) as FormFill[];
}

/**
 * Search form fills by field values using LIKE matching on field_data_json
 *
 * @param db - Database connection
 * @param query - Search query string
 * @param options - Optional filter options (limit, offset)
 * @returns FormFill[] - Matching form fills
 */
export function searchFormFills(
  db: Database.Database,
  query: string,
  options?: { limit?: number; offset?: number }
): FormFill[] {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const escaped = escapeLikePattern(query);
  return db.prepare(`
    SELECT * FROM form_fills
    WHERE field_data_json LIKE ? ESCAPE '\\' OR fields_filled LIKE ? ESCAPE '\\' OR source_file_path LIKE ? ESCAPE '\\'
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, limit, offset) as FormFill[];
}

/**
 * Delete a form fill record
 *
 * @param db - Database connection
 * @param id - Form fill ID
 * @returns boolean - true if a record was deleted
 */
export function deleteFormFill(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM form_fills WHERE id = ?').run(id).changes > 0;
}
