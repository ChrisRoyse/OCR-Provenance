/**
 * Document operations for DatabaseService
 *
 * Handles all CRUD operations for documents including
 * insert, get, list, update, and delete with cascade.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Document, DocumentStatus } from '../../../models/document.js';
import { DatabaseError, DatabaseErrorCode, DocumentRow, ListDocumentsOptions } from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToDocument } from './converters.js';
import { computeHash } from '../../../utils/hash.js';
import { computeChainHash } from '../../provenance/chain-hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CURSOR-BASED PAGINATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Encode a cursor from a (created_at, id) tuple.
 * Uses base64url encoding for URL-safe transport.
 *
 * @param createdAt - ISO 8601 timestamp
 * @param id - Document UUID
 * @returns Base64url-encoded cursor string
 */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ created_at: createdAt, id })).toString('base64url');
}

/**
 * Decode a cursor back to a (created_at, id) tuple.
 *
 * @param cursor - Base64url-encoded cursor string
 * @returns Decoded cursor with created_at and id
 * @throws Error if cursor is invalid or malformed
 */
export function decodeCursor(cursor: string): { created_at: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
    if (typeof decoded.created_at !== 'string' || typeof decoded.id !== 'string') {
      throw new Error('Invalid cursor format: missing created_at or id');
    }
    return { created_at: decoded.created_at as string, id: decoded.id as string };
  } catch (error) {
    throw new Error(`Invalid cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
 * Result from listDocuments when cursor-based pagination is used
 */
export interface ListDocumentsResult {
  documents: Document[];
  /** Cursor for the next page (null if no more results) */
  next_cursor: string | null;
}

/**
 * List documents with optional filtering.
 *
 * Supports both offset-based and cursor-based pagination:
 * - When `cursor` is provided, uses keyset pagination (WHERE created_at < cursor.created_at
 *   OR (created_at = cursor.created_at AND id < cursor.id)) and ignores offset.
 * - When `cursor` is absent, uses traditional LIMIT/OFFSET.
 *
 * @param db - Database connection
 * @param options - Optional filter options (status, limit, offset, cursor)
 * @returns Document[] - Array of documents (backward-compatible)
 */
export function listDocuments(db: Database.Database, options?: ListDocumentsOptions): Document[] {
  const result = listDocumentsWithCursor(db, options);
  return result.documents;
}

/**
 * List documents with cursor-based pagination support.
 *
 * Returns both the documents and a next_cursor for fetching the next page.
 *
 * @param db - Database connection
 * @param options - Optional filter options (status, limit, offset, cursor)
 * @returns ListDocumentsResult with documents and next_cursor
 */
export function listDocumentsWithCursor(
  db: Database.Database,
  options?: ListDocumentsOptions
): ListDocumentsResult {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  // Cursor-based pagination: keyset filtering
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor);
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(decoded.created_at, decoded.created_at, decoded.id);
  }

  let query = 'SELECT * FROM documents';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC, id DESC';

  const limit = options?.limit ?? 10000;
  query += ' LIMIT ?';
  params.push(limit);

  // Only apply OFFSET when NOT using cursor-based pagination
  if (!options?.cursor && options?.offset !== undefined) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as DocumentRow[];
  const documents = rows.map(rowToDocument);

  // Compute next_cursor from the last row
  let next_cursor: string | null = null;
  if (documents.length > 0 && documents.length === limit) {
    const lastDoc = documents[documents.length - 1];
    next_cursor = encodeCursor(lastDoc.created_at, lastDoc.id);
  }

  return { documents, next_cursor };
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
    throw new DatabaseError(`Document "${id}" not found`, DatabaseErrorCode.DOCUMENT_NOT_FOUND);
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
    SET status = 'processing', page_count = ?, ocr_completed_at = ?, modified_at = ?
    WHERE id = ?
  `);

  const result = stmt.run(pageCount, ocrCompletedAt, modified_at, id);

  if (result.changes === 0) {
    throw new DatabaseError(`Document "${id}" not found`, DatabaseErrorCode.DOCUMENT_NOT_FOUND);
  }

  updateMetadataModified();
}

/**
 * Update document metadata (title, author, subject) from OCR extraction
 *
 * @param db - Database connection
 * @param id - Document ID
 * @param metadata - Metadata fields to update (null values are ignored via COALESCE)
 * @param updateMetadataModified - Callback to update metadata modified timestamp
 */
export function updateDocumentMetadata(
  db: Database.Database,
  id: string,
  metadata: { docTitle?: string | null; docAuthor?: string | null; docSubject?: string | null },
  updateMetadataModified: () => void
): void {
  const modified_at = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE documents
    SET doc_title = COALESCE(?, doc_title),
        doc_author = COALESCE(?, doc_author),
        doc_subject = COALESCE(?, doc_subject),
        modified_at = ?
    WHERE id = ?
  `);
  const result = stmt.run(
    metadata.docTitle ?? null,
    metadata.docAuthor ?? null,
    metadata.docSubject ?? null,
    modified_at,
    id
  );
  if (result.changes > 0) updateMetadataModified();
}

/**
 * Shared cleanup: delete all derived records for a document.
 *
 * Deletion order (FK-safe):
 *   1. vec_embeddings (no inbound FKs)
 *   2. NULL images.vlm_embedding_id (break circular FK with embeddings)
 *   3. Re-queue orphaned images from other documents (VLM dedup)
 *   4. embeddings (covers chunk, VLM, and extraction types in one pass)
 *   5. images (safe after embeddings.image_id references gone)
 *   6. chunks
 *   7. extractions (before ocr_results: extractions.ocr_result_id -> ocr_results)
 *   8. ocr_results
 *   9. FTS metadata count updates (ids 1, 2, 3)
 *
 * @returns The number of embedding IDs deleted (for logging)
 */
function deleteDerivedRecords(db: Database.Database, documentId: string, caller: string): number {
  // M-3: Count embeddings first, then use subquery DELETE instead of loading all IDs
  const embeddingCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE document_id = ?').get(documentId) as {
      cnt: number;
    }
  ).cnt;

  // Delete from vec_embeddings using a single subquery
  db.prepare(
    'DELETE FROM vec_embeddings WHERE embedding_id IN (SELECT id FROM embeddings WHERE document_id = ?)'
  ).run(documentId);

  // Break circular FK: images.vlm_embedding_id → embeddings ↔ embeddings.image_id → images
  // NULL out vlm_embedding_id on THIS document's images so embeddings can be deleted
  db.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE document_id = ?').run(documentId);

  // Re-queue OTHER documents' images that shared embeddings via VLM dedup.
  // Setting vlm_status='pending' ensures they get re-processed instead of
  // silently remaining 'complete' but invisible to search (orphaned).
  const orphanedImages = db
    .prepare(
      `
    SELECT id, document_id FROM images
    WHERE vlm_embedding_id IN (SELECT id FROM embeddings WHERE document_id = ?)
    AND document_id != ?
  `
    )
    .all(documentId, documentId) as { id: string; document_id: string }[];

  if (orphanedImages.length > 0) {
    console.error(
      `[WARN] ${caller} "${documentId}": re-queuing ${orphanedImages.length} images from other documents ` +
        `that shared VLM embeddings (document_ids: ${[...new Set(orphanedImages.map((i) => i.document_id))].join(', ')})`
    );
    db.prepare(
      `
      UPDATE images SET vlm_embedding_id = NULL, vlm_status = 'pending'
      WHERE vlm_embedding_id IN (SELECT id FROM embeddings WHERE document_id = ?)
      AND document_id != ?
    `
    ).run(documentId, documentId);
  }

  // Delete entity_tags referencing entities about to be deleted (polymorphic FK, no CASCADE)
  try {
    db.prepare(
      `
      DELETE FROM entity_tags WHERE
        (entity_type = 'document' AND entity_id = ?)
        OR (entity_type = 'chunk' AND entity_id IN (SELECT id FROM chunks WHERE document_id = ?))
        OR (entity_type = 'image' AND entity_id IN (SELECT id FROM images WHERE document_id = ?))
        OR (entity_type = 'extraction' AND entity_id IN (SELECT id FROM extractions WHERE document_id = ?))
    `
    ).run(documentId, documentId, documentId, documentId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
    console.error('[document-operations] entity_tags table not found, skipping:', msg);
  }

  // Delete from embeddings (safe: images.vlm_embedding_id already NULLed)
  db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(documentId);

  // Delete from images (safe: embeddings.image_id references gone)
  db.prepare('DELETE FROM images WHERE document_id = ?').run(documentId);

  // Decrement cluster document_count before removing assignments
  db.prepare(
    `UPDATE clusters SET document_count = document_count - 1
     WHERE id IN (SELECT cluster_id FROM document_clusters WHERE document_id = ? AND cluster_id IS NOT NULL)`
  ).run(documentId);
  // Delete document-cluster assignments
  db.prepare('DELETE FROM document_clusters WHERE document_id = ?').run(documentId);

  // Delete comparisons referencing this document
  db.prepare('DELETE FROM comparisons WHERE document_id_1 = ? OR document_id_2 = ?').run(
    documentId,
    documentId
  );

  // Delete form_fills linked to this document via source_file_hash
  // (form_fills has no document_id FK — it joins through source_file_hash)
  try {
    const docRow = db.prepare('SELECT file_hash FROM documents WHERE id = ?').get(documentId) as
      | { file_hash: string }
      | undefined;
    if (docRow) {
      db.prepare('DELETE FROM form_fills WHERE source_file_hash = ?').run(docRow.file_hash);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
    console.error('[document-operations] form_fills table not found, skipping:', msg);
  }

  // Delete from chunks
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);

  // Delete from extractions (BEFORE ocr_results: extractions.ocr_result_id REFERENCES ocr_results(id))
  db.prepare('DELETE FROM extractions WHERE document_id = ?').run(documentId);

  // Delete from ocr_results (safe now that extractions are gone)
  db.prepare('DELETE FROM ocr_results WHERE document_id = ?').run(documentId);

  // Delete uploaded_files whose provenance_id references this document's provenance chain.
  // Must happen before provenance cleanup (callers delete provenance after this function).
  // uploaded_files has provenance_id NOT NULL REFERENCES provenance(id).
  try {
    const docForProv = db
      .prepare('SELECT provenance_id FROM documents WHERE id = ?')
      .get(documentId) as { provenance_id: string } | undefined;
    if (docForProv) {
      db.prepare(
        'DELETE FROM uploaded_files WHERE provenance_id IN (SELECT id FROM provenance WHERE root_document_id = ?)'
      ).run(docForProv.provenance_id);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
    console.error('[document-operations] uploaded_files table not found, skipping:', msg);
  }

  // Update FTS metadata counts after chunk/embedding deletion
  try {
    const chunkCount = (db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number })
      .cnt;
    db.prepare(
      `
      UPDATE fts_index_metadata SET chunks_indexed = ?, last_rebuild_at = ?
      WHERE id = 1
    `
    ).run(chunkCount, new Date().toISOString());

    // Update VLM FTS metadata if table exists
    const vlmCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL').get() as {
        cnt: number;
      }
    ).cnt;
    db.prepare(
      `
      UPDATE fts_index_metadata SET chunks_indexed = ?, last_rebuild_at = ?
      WHERE id = 2
    `
    ).run(vlmCount, new Date().toISOString());

    // Update extractions FTS metadata (id=3)
    const extCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM extractions').get() as { cnt: number }
    ).cnt;
    db.prepare(
      `
      UPDATE fts_index_metadata SET chunks_indexed = ?, last_rebuild_at = ?
      WHERE id = 3
    `
    ).run(extCount, new Date().toISOString());
  } catch (e: unknown) {
    // Only ignore "no such table" errors from older schemas pre-v4
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) {
      throw e;
    }
    console.error(
      '[document-operations] fts_index_metadata table not found, skipping FTS update:',
      msg
    );
  }

  return embeddingCount;
}

/**
 * Get or create the synthetic ORPHANED_ROOT provenance record.
 * Used to re-parent provenance records when their original document is deleted
 * but surviving clusters still reference them (P1.4).
 *
 * @param db - Database connection
 * @returns The ID of the ORPHANED_ROOT provenance record
 */
function getOrCreateOrphanedRoot(db: Database.Database): string {
  const existing = db
    .prepare(
      "SELECT id FROM provenance WHERE root_document_id = 'ORPHANED_ROOT' AND type = 'DOCUMENT' LIMIT 1"
    )
    .get() as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  // Create synthetic orphaned root provenance
  const id = uuidv4();
  const now = new Date().toISOString();
  const contentHash = computeHash('ORPHANED_ROOT');
  const chainHash = computeChainHash(contentHash, null);

  db.prepare(
    `
    INSERT INTO provenance (
      id, type, created_at, processed_at, source_type, source_id,
      root_document_id, content_hash, input_hash, processor,
      processor_version, processing_params, parent_id, parent_ids,
      chain_depth, chain_path, chain_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    'DOCUMENT',
    now,
    now,
    'FILE',
    null,
    'ORPHANED_ROOT',
    contentHash,
    null,
    'system',
    '1.0.0',
    '{}',
    null,
    '[]',
    0,
    '["DOCUMENT"]',
    chainHash
  );

  return id;
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
  // First check document exists (outside transaction - read-only)
  const doc = getDocument(db, id);
  if (!doc) {
    throw new DatabaseError(`Document "${id}" not found`, DatabaseErrorCode.DOCUMENT_NOT_FOUND);
  }

  // H-5: Wrap entire cascade delete in a transaction so a crash mid-sequence
  // cannot leave the database in an inconsistent state.
  const runInTransaction = db.transaction(() => {
    deleteDerivedRecords(db, id, 'deleteDocument');

    // Delete the document itself BEFORE provenance
    // (document has FK to provenance via provenance_id)
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);

    // Delete from provenance - must delete in reverse chain_depth order
    // due to self-referential FKs on source_id and parent_id
    // NOTE: root_document_id stores the document's provenance_id, NOT document id
    const provenanceIds = db
      .prepare('SELECT id FROM provenance WHERE root_document_id = ? ORDER BY chain_depth DESC')
      .all(doc.provenance_id) as { id: string }[];

    // P1.4: Get or create orphaned root provenance for re-parenting
    const orphanedRootId = getOrCreateOrphanedRoot(db);

    // Pre-clear self-referencing FKs (parent_id, source_id) on provenance records being deleted.
    // Within the same chain_depth, parent provenance may appear before child provenance in the
    // iteration order, causing FK violations. NULLing these first breaks the circular references.
    const clearSelfRefStmt = db.prepare(
      'UPDATE provenance SET parent_id = NULL, source_id = NULL WHERE id = ?'
    );
    for (const { id: provId } of provenanceIds) {
      clearSelfRefStmt.run(provId);
    }

    const deleteProvStmt = db.prepare('DELETE FROM provenance WHERE id = ?');
    const clusterRefCheck = db.prepare(
      'SELECT COUNT(*) as cnt FROM clusters WHERE provenance_id = ?'
    );
    const reparentProvStmt = db.prepare(
      'UPDATE provenance SET source_id = NULL, parent_id = ?, root_document_id = ? WHERE id = ?'
    );
    for (const { id: provId } of provenanceIds) {
      // Skip CLUSTERING provenance still referenced by clusters (NOT NULL FK).
      // Re-parent to orphaned root so provenance chain is preserved (P1.4).
      // These are cleaned up when the cluster run is deleted.
      const clusterRefs = (clusterRefCheck.get(provId) as { cnt: number }).cnt;
      if (clusterRefs > 0) {
        reparentProvStmt.run(orphanedRootId, 'ORPHANED_ROOT', provId);
        continue;
      }
      deleteProvStmt.run(provId);
    }

    // Update metadata counts inside transaction for atomicity
    updateMetadataCounts();
  });

  runInTransaction();
}

/**
 * Clean all derived data for a document, keeping the document record and its DOCUMENT-level provenance.
 *
 * Deletes: vec_embeddings, embeddings, images, chunks, ocr_results, and non-root provenance records.
 * This is used by retry_failed to reset a document to a clean "pending" state.
 *
 * @param db - Database connection
 * @param documentId - Document ID to clean
 */
export function cleanDocumentDerivedData(db: Database.Database, documentId: string): void {
  // Validate document exists (outside transaction - read-only)
  const doc = getDocument(db, documentId);
  if (!doc) {
    throw new DatabaseError(
      `Document "${documentId}" not found`,
      DatabaseErrorCode.DOCUMENT_NOT_FOUND
    );
  }

  // H-5: Wrap cleanup in a transaction so partial deletes cannot leave
  // the database in an inconsistent state.
  let embeddingCount = 0;
  let provenanceCount = 0;

  const runInTransaction = db.transaction(() => {
    embeddingCount = deleteDerivedRecords(db, documentId, 'cleanDocumentDerivedData');

    // Delete non-root provenance records (keep DOCUMENT-level provenance at chain_depth=0)
    // root_document_id stores the document's provenance_id, NOT document id
    const nonRootProvIds = db
      .prepare(
        'SELECT id FROM provenance WHERE root_document_id = ? AND chain_depth > 0 ORDER BY chain_depth DESC'
      )
      .all(doc.provenance_id) as { id: string }[];

    const deleteProvStmt = db.prepare('DELETE FROM provenance WHERE id = ?');
    for (const { id: provId } of nonRootProvIds) {
      deleteProvStmt.run(provId);
    }

    provenanceCount = nonRootProvIds.length;
  });

  runInTransaction();

  console.error(
    `[INFO] Cleaned derived data for document ${documentId}: ${embeddingCount} embeddings, ${provenanceCount} provenance records removed`
  );
}
