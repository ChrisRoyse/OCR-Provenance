/**
 * Document operations for DatabaseService
 *
 * Handles all CRUD operations for documents including
 * insert, get, list, update, and delete with cascade.
 */

import Database from 'better-sqlite3';
import { Document, DocumentStatus } from '../../../models/document.js';
import {
  DatabaseError,
  DatabaseErrorCode,
  DocumentRow,
  ListDocumentsOptions,
} from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToDocument } from './converters.js';

/**
 * Insert a new document
 *
 * @param db - Database connection
 * @param doc - Document data (created_at will be generated)
 * @param updateMetadataCounts - Callback to update metadata counts
 * @returns string - The document ID
 */
export function insertDocument(
  db: Database.Database,
  doc: Omit<Document, 'created_at'>,
  updateMetadataCounts: () => void
): string {
  const created_at = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO documents (
      id, file_path, file_name, file_hash, file_size, file_type,
      status, page_count, provenance_id, created_at, modified_at,
      ocr_completed_at, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      doc.id,
      doc.file_path,
      doc.file_name,
      doc.file_hash,
      doc.file_size,
      doc.file_type,
      doc.status,
      doc.page_count,
      doc.provenance_id,
      created_at,
      doc.modified_at,
      doc.ocr_completed_at,
      doc.error_message,
    ],
    `inserting document: provenance_id "${doc.provenance_id}" does not exist`
  );

  updateMetadataCounts();
  return doc.id;
}

/**
 * Get a document by ID
 *
 * @param db - Database connection
 * @param id - Document ID
 * @returns Document | null - The document or null if not found
 */
export function getDocument(db: Database.Database, id: string): Document | null {
  const stmt = db.prepare('SELECT * FROM documents WHERE id = ?');
  const row = stmt.get(id) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

/**
 * Get a document by file path
 *
 * @param db - Database connection
 * @param filePath - Full file path
 * @returns Document | null - The document or null if not found
 */
export function getDocumentByPath(db: Database.Database, filePath: string): Document | null {
  const stmt = db.prepare('SELECT * FROM documents WHERE file_path = ?');
  const row = stmt.get(filePath) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

/**
 * Get a document by file hash
 *
 * @param db - Database connection
 * @param fileHash - SHA-256 file hash
 * @returns Document | null - The document or null if not found
 */
export function getDocumentByHash(db: Database.Database, fileHash: string): Document | null {
  const stmt = db.prepare('SELECT * FROM documents WHERE file_hash = ?');
  const row = stmt.get(fileHash) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

/**
 * List documents with optional filtering
 *
 * @param db - Database connection
 * @param options - Optional filter options (status, limit, offset)
 * @returns Document[] - Array of documents
 */
export function listDocuments(
  db: Database.Database,
  options?: ListDocumentsOptions
): Document[] {
  let query = 'SELECT * FROM documents';
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
      query += ' LIMIT -1';
    }
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as DocumentRow[];
  return rows.map(rowToDocument);
}

/**
 * Update document status
 *
 * @param db - Database connection
 * @param id - Document ID
 * @param status - New status
 * @param errorMessage - Optional error message (for 'failed' status)
 * @param updateMetadataModified - Callback to update metadata modified timestamp
 */
export function updateDocumentStatus(
  db: Database.Database,
  id: string,
  status: DocumentStatus,
  errorMessage: string | undefined,
  updateMetadataModified: () => void
): void {
  const modified_at = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE documents
    SET status = ?, error_message = ?, modified_at = ?
    WHERE id = ?
  `);

  const result = stmt.run(status, errorMessage ?? null, modified_at, id);

  if (result.changes === 0) {
    throw new DatabaseError(
      `Document "${id}" not found`,
      DatabaseErrorCode.DOCUMENT_NOT_FOUND
    );
  }

  updateMetadataModified();
}

/**
 * Update document when OCR completes
 *
 * @param db - Database connection
 * @param id - Document ID
 * @param pageCount - Number of pages processed
 * @param ocrCompletedAt - ISO 8601 completion timestamp
 * @param updateMetadataModified - Callback to update metadata modified timestamp
 */
export function updateDocumentOCRComplete(
  db: Database.Database,
  id: string,
  pageCount: number,
  ocrCompletedAt: string,
  updateMetadataModified: () => void
): void {
  const modified_at = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE documents
    SET status = 'complete', page_count = ?, ocr_completed_at = ?, modified_at = ?
    WHERE id = ?
  `);

  const result = stmt.run(pageCount, ocrCompletedAt, modified_at, id);

  if (result.changes === 0) {
    throw new DatabaseError(
      `Document "${id}" not found`,
      DatabaseErrorCode.DOCUMENT_NOT_FOUND
    );
  }

  updateMetadataModified();
}

/**
 * Delete a document and all related data (CASCADE DELETE)
 *
 * @param db - Database connection
 * @param id - Document ID to delete
 * @param updateMetadataCounts - Callback to update metadata counts
 */
export function deleteDocument(
  db: Database.Database,
  id: string,
  updateMetadataCounts: () => void
): void {
  // First check document exists
  const doc = getDocument(db, id);
  if (!doc) {
    throw new DatabaseError(
      `Document "${id}" not found`,
      DatabaseErrorCode.DOCUMENT_NOT_FOUND
    );
  }

  // Get all embedding IDs for this document
  const embeddingIds = db
    .prepare('SELECT id FROM embeddings WHERE document_id = ?')
    .all(id) as { id: string }[];

  // Delete from vec_embeddings for each embedding
  const deleteVecStmt = db.prepare(
    'DELETE FROM vec_embeddings WHERE embedding_id = ?'
  );
  for (const { id: embeddingId } of embeddingIds) {
    deleteVecStmt.run(embeddingId);
  }

  // Delete from images (before embeddings due to vlm_embedding_id FK)
  db.prepare('DELETE FROM images WHERE document_id = ?').run(id);

  // Nullify shared vlm_embedding_id references in OTHER documents' images
  // (copyVLMResult dedup shares embedding IDs across documents)
  db.prepare(`
    UPDATE images SET vlm_embedding_id = NULL
    WHERE vlm_embedding_id IN (SELECT id FROM embeddings WHERE document_id = ?)
    AND document_id != ?
  `).run(id, id);

  // Delete from embeddings
  db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(id);

  // Delete from chunks
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);

  // Delete from ocr_results
  db.prepare('DELETE FROM ocr_results WHERE document_id = ?').run(id);

  // Delete the document itself BEFORE provenance
  // (document has FK to provenance via provenance_id)
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);

  // Delete from provenance - must delete in reverse chain_depth order
  // due to self-referential FKs on source_id and parent_id
  // NOTE: root_document_id stores the document's provenance_id, NOT document id
  const provenanceIds = db
    .prepare(
      'SELECT id FROM provenance WHERE root_document_id = ? ORDER BY chain_depth DESC'
    )
    .all(doc.provenance_id) as { id: string }[];

  const deleteProvStmt = db.prepare('DELETE FROM provenance WHERE id = ?');
  for (const { id: provId } of provenanceIds) {
    deleteProvStmt.run(provId);
  }

  // Update FTS metadata counts after chunk/embedding deletion
  try {
    const chunkCount = (db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt;
    db.prepare(`
      UPDATE fts_index_metadata SET chunks_indexed = ?, last_rebuild_at = ?
      WHERE id = 1
    `).run(chunkCount, new Date().toISOString());

    // Update VLM FTS metadata if table exists
    const vlmCount = (db.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL").get() as { cnt: number }).cnt;
    db.prepare(`
      UPDATE fts_index_metadata SET chunks_indexed = ?, last_rebuild_at = ?
      WHERE id = 2
    `).run(vlmCount, new Date().toISOString());
  } catch {
    // fts_index_metadata may not exist in older schemas - ignore
  }

  // Update metadata counts
  updateMetadataCounts();
}

/**
 * Reset documents stuck in 'processing' status back to 'pending'
 *
 * @param db - Database connection
 * @returns number - Number of documents reset
 */
export function resetProcessingDocuments(db: Database.Database): number {
  return db.prepare(
    "UPDATE documents SET status = 'pending', error_message = 'Reset from stuck processing state' WHERE status = 'processing'"
  ).run().changes;
}
