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

/**
 * Delete all extractions for a document, cascading through
 * extraction-sourced embeddings, their vectors, and provenance.
 *
 * Cascade order:
 *   1. vec_embeddings (vectors for extraction embeddings)
 *   2. provenance (for extraction embeddings)
 *   3. embeddings (where extraction_id references these extractions)
 *   4. extractions (the extractions themselves)
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns number - Number of extractions deleted
 */
export function deleteExtractionsByDocument(db: Database.Database, documentId: string): number {
  const extractionSubquery = 'SELECT id FROM extractions WHERE document_id = ?';
  const embeddingSubquery = `SELECT id FROM embeddings WHERE extraction_id IN (${extractionSubquery})`;

  // Step 1: Delete vectors for extraction-sourced embeddings
  // vec_embeddings is a sqlite-vec virtual table that may not exist in test environments
  let vecDeleted = 0;
  try {
    vecDeleted = db.prepare(
      `DELETE FROM vec_embeddings WHERE embedding_id IN (${embeddingSubquery})`
    ).run(documentId).changes;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
  }

  // Step 2: Capture provenance IDs before deleting embeddings (needed for step 3)
  const provIds = db.prepare(
    `SELECT provenance_id FROM embeddings WHERE extraction_id IN (${extractionSubquery})`
  ).all(documentId) as { provenance_id: string }[];

  // Step 3: Delete extraction-sourced embeddings (must happen before provenance deletion
  // because embeddings.provenance_id references provenance.id)
  const embDeleted = db.prepare(
    `DELETE FROM embeddings WHERE extraction_id IN (${extractionSubquery})`
  ).run(documentId).changes;

  // Step 4: Delete provenance for extraction-sourced embeddings
  let provDeleted = 0;
  if (provIds.length > 0) {
    const placeholders = provIds.map(() => '?').join(',');
    provDeleted = db.prepare(
      `DELETE FROM provenance WHERE id IN (${placeholders})`
    ).run(...provIds.map(p => p.provenance_id)).changes;
  }

  // Step 5: Delete the extractions themselves
  const extDeleted = db.prepare(
    'DELETE FROM extractions WHERE document_id = ?'
  ).run(documentId).changes;

  if (vecDeleted > 0 || embDeleted > 0) {
    console.error(
      `[deleteExtractionsByDocument] doc="${documentId}": cascaded ${vecDeleted} vectors, ${provDeleted} provenance, ${embDeleted} embeddings, ${extDeleted} extractions`
    );
  }

  return extDeleted;
}
