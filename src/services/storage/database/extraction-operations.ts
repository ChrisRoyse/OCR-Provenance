/**
 * Extraction operations for DatabaseService
 *
 * Handles all CRUD operations for structured extractions
 * from page_schema processing.
 */

import Database from 'better-sqlite3';
import { Extraction } from '../../../models/extraction.js';
import { runWithForeignKeyCheck } from './helpers.js';

/**
 * Insert an extraction record
 *
 * @param db - Database connection
 * @param extraction - Extraction data
 * @param updateMetadataCounts - Callback to update metadata counts
 * @returns string - The extraction ID
 */
export function insertExtraction(
  db: Database.Database,
  extraction: Extraction,
  updateMetadataCounts: () => void
): string {
  const stmt = db.prepare(`
    INSERT INTO extractions (id, document_id, ocr_result_id, schema_json, extraction_json, content_hash, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      extraction.id,
      extraction.document_id,
      extraction.ocr_result_id,
      extraction.schema_json,
      extraction.extraction_json,
      extraction.content_hash,
      extraction.provenance_id,
      extraction.created_at,
    ],
    `inserting extraction: FK violation for document_id="${extraction.document_id}"`
  );

  updateMetadataCounts();
  return extraction.id;
}

/**
 * Get all extractions for a document
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns Extraction[] - Array of extractions ordered by created_at DESC
 */
export function getExtractionsByDocument(db: Database.Database, documentId: string): Extraction[] {
  return db
    .prepare('SELECT * FROM extractions WHERE document_id = ? ORDER BY created_at DESC LIMIT 1000')
    .all(documentId) as Extraction[];
}

/**
 * Get a single extraction by ID
 *
 * @param db - Database connection
 * @param id - Extraction ID
 * @returns Extraction or null if not found
 */
export function getExtraction(db: Database.Database, id: string): Extraction | null {
  const row = db
    .prepare('SELECT * FROM extractions WHERE id = ?')
    .get(id) as Extraction | undefined;
  return row ?? null;
}

/**
 * Search extractions by text matching within extraction_json content.
 * Uses LIKE for simple text matching (no FTS5 for extractions).
 *
 * @param db - Database connection
 * @param query - Search query string
 * @param filters - Optional filters (document_filter, limit)
 * @returns Extraction[] - Matching extractions ordered by created_at DESC
 */
export function searchExtractions(
  db: Database.Database,
  query: string,
  filters?: { document_filter?: string[]; limit?: number }
): Extraction[] {
  const limit = filters?.limit ?? 10;
  const conditions: string[] = ['extraction_json LIKE ? ESCAPE \'\\\''];
  // Escape special LIKE characters in the query
  const escapedQuery = query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const params: unknown[] = [`%${escapedQuery}%`];

  if (filters?.document_filter && filters.document_filter.length > 0) {
    const placeholders = filters.document_filter.map(() => '?').join(', ');
    conditions.push(`document_id IN (${placeholders})`);
    params.push(...filters.document_filter);
  }

  const whereClause = conditions.join(' AND ');
  params.push(limit);

  return db
    .prepare(`SELECT * FROM extractions WHERE ${whereClause} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as Extraction[];
}
