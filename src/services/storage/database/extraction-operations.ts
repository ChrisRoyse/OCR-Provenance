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
  return db.prepare('SELECT * FROM extractions WHERE document_id = ? ORDER BY created_at DESC').all(documentId) as Extraction[];
}

