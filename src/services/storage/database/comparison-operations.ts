/**
 * Comparison operations for DatabaseService
 *
 * Handles CRUD operations for the comparisons table.
 */

import Database from 'better-sqlite3';
import type { Comparison } from '../../../models/comparison.js';
import { runWithForeignKeyCheck } from './helpers.js';

/**
 * Insert a comparison record
 */
export function insertComparison(db: Database.Database, comparison: Comparison): string {
  const stmt = db.prepare(`
    INSERT INTO comparisons (id, document_id_1, document_id_2, similarity_ratio,
      text_diff_json, structural_diff_json, entity_diff_json, summary,
      content_hash, provenance_id, created_at, processing_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      comparison.id,
      comparison.document_id_1,
      comparison.document_id_2,
      comparison.similarity_ratio,
      comparison.text_diff_json,
      comparison.structural_diff_json,
      comparison.entity_diff_json,
      comparison.summary,
      comparison.content_hash,
      comparison.provenance_id,
      comparison.created_at,
      comparison.processing_duration_ms,
    ],
    `inserting comparison: FK violation for document_id_1="${comparison.document_id_1}" or document_id_2="${comparison.document_id_2}"`
  );

  return comparison.id;
}

/**
 * Get a comparison by ID
 */
export function getComparison(db: Database.Database, id: string): Comparison | null {
  const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as Comparison | undefined;
  return row ?? null;
}

/**
 * List comparisons with optional document filter and pagination
 */
export function listComparisons(
  db: Database.Database,
  options?: { document_id?: string; limit?: number; offset?: number }
): Comparison[] {
  const params: (string | number)[] = [];
  let where = '';

  if (options?.document_id) {
    where = 'WHERE document_id_1 = ? OR document_id_2 = ?';
    params.push(options.document_id, options.document_id);
  }

  params.push(options?.limit ?? 50, options?.offset ?? 0);

  return db.prepare(
    `SELECT * FROM comparisons ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params) as Comparison[];
}

/**
 * Delete a single comparison by ID
 */
export function deleteComparison(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM comparisons WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Delete all comparisons referencing a document (for cascade delete)
 */
export function deleteComparisonsByDocument(db: Database.Database, documentId: string): number {
  const result = db.prepare(
    'DELETE FROM comparisons WHERE document_id_1 = ? OR document_id_2 = ?'
  ).run(documentId, documentId);
  return result.changes;
}
