/**
 * Document operations for DatabaseService
 *
 * Handles all CRUD operations for documents including
 * insert, get, list, update, and delete with cascade.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Document, DocumentStatus } from '../../../models/document.js';
import {
  DatabaseError,
  DatabaseErrorCode,
  DocumentRow,
  ListDocumentsOptions,
} from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToDocument } from './converters.js';
import { cleanupGraphForDocument, updateKnowledgeNode } from './knowledge-graph-operations.js';
import { computeHash } from '../../../utils/hash.js';

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
      query += ' LIMIT 10000';  // L-1: bounded default instead of LIMIT -1
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
    SET status = 'processing', page_count = ?, ocr_completed_at = ?, modified_at = ?
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
  const embeddingCount = (db.prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE document_id = ?').get(documentId) as { cnt: number }).cnt;

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
  const orphanedImages = db.prepare(`
    SELECT id, document_id FROM images
    WHERE vlm_embedding_id IN (SELECT id FROM embeddings WHERE document_id = ?)
    AND document_id != ?
  `).all(documentId, documentId) as { id: string; document_id: string }[];

  if (orphanedImages.length > 0) {
    console.error(
      `[WARN] ${caller} "${documentId}": re-queuing ${orphanedImages.length} images from other documents ` +
      `that shared VLM embeddings (document_ids: ${[...new Set(orphanedImages.map(i => i.document_id))].join(', ')})`
    );
    db.prepare(`
      UPDATE images SET vlm_embedding_id = NULL, vlm_status = 'pending'
      WHERE vlm_embedding_id IN (SELECT id FROM embeddings WHERE document_id = ?)
      AND document_id != ?
    `).run(documentId, documentId);
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
  db.prepare('DELETE FROM comparisons WHERE document_id_1 = ? OR document_id_2 = ?').run(documentId, documentId);

  // Clean up entity_embeddings BEFORE graph cleanup (entity_embeddings.node_id -> knowledge_nodes.id)
  try {
    db.prepare(
      `DELETE FROM vec_entity_embeddings WHERE entity_embedding_id IN (
         SELECT ee.id FROM entity_embeddings ee
         JOIN node_entity_links nel ON nel.node_id = ee.node_id
         WHERE nel.document_id = ?
       )`
    ).run(documentId);
    db.prepare(
      `DELETE FROM entity_embeddings WHERE node_id IN (
         SELECT DISTINCT node_id FROM node_entity_links WHERE document_id = ?
       )`
    ).run(documentId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
  }

  // Clean up knowledge graph data (must come before entities deletion since links reference entities)
  cleanupGraphForDocument(db, documentId);

  // Delete extraction segments (may not exist in pre-v19 schemas)
  try {
    db.prepare('DELETE FROM entity_extraction_segments WHERE document_id = ?').run(documentId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
  }

  // Delete entity mentions and entities BEFORE chunks
  // (entity_mentions.chunk_id REFERENCES chunks(id) — must remove child FK first)
  // (entity_mentions.entity_id -> entities.id — mentions before entities)
  try {
    db.prepare(
      'DELETE FROM entity_mentions WHERE entity_id IN (SELECT id FROM entities WHERE document_id = ?)'
    ).run(documentId);
    db.prepare('DELETE FROM entities WHERE document_id = ?').run(documentId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
  }

  // Delete from chunks (safe: entity_mentions.chunk_id references now gone)
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);

  // Delete from extractions (BEFORE ocr_results: extractions.ocr_result_id REFERENCES ocr_results(id))
  db.prepare('DELETE FROM extractions WHERE document_id = ?').run(documentId);

  // Delete from ocr_results (safe now that extractions are gone)
  db.prepare('DELETE FROM ocr_results WHERE document_id = ?').run(documentId);

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

    // Update extractions FTS metadata (id=3)
    const extCount = (db.prepare('SELECT COUNT(*) as cnt FROM extractions').get() as { cnt: number }).cnt;
    db.prepare(`
      UPDATE fts_index_metadata SET chunks_indexed = ?, last_rebuild_at = ?
      WHERE id = 3
    `).run(extCount, new Date().toISOString());
  } catch (e: unknown) {
    // Only ignore "no such table" errors from older schemas pre-v4
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) {
      throw e;
    }
  }

  return embeddingCount;
}

/**
 * Get or create the synthetic ORPHANED_ROOT provenance record.
 * Used to re-parent provenance records when their original document is deleted
 * but surviving KG nodes or clusters still reference them (P1.4).
 *
 * @param db - Database connection
 * @returns The ID of the ORPHANED_ROOT provenance record
 */
function getOrCreateOrphanedRoot(db: Database.Database): string {
  const existing = db.prepare(
    "SELECT id FROM provenance WHERE root_document_id = 'ORPHANED_ROOT' AND type = 'DOCUMENT' LIMIT 1",
  ).get() as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  // Create synthetic orphaned root provenance
  const id = uuidv4();
  const now = new Date().toISOString();
  const contentHash = computeHash('ORPHANED_ROOT');

  db.prepare(`
    INSERT INTO provenance (
      id, type, created_at, processed_at, source_type, source_id,
      root_document_id, content_hash, input_hash, processor,
      processor_version, processing_params, parent_id, parent_ids,
      chain_depth, chain_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, 'DOCUMENT', now, now, 'FILE', null,
    'ORPHANED_ROOT', contentHash, null, 'system',
    '1.0.0', '{}', null, '[]',
    0, '["DOCUMENT"]',
  );

  return id;
}

// ============================================================
// KG Snapshot Archival
// ============================================================

/**
 * Row type for knowledge node archive query
 */
interface ArchiveNodeRow {
  id: string;
  entity_type: string;
  canonical_name: string;
  normalized_name: string;
  aliases: string | null;
  document_count: number;
  mention_count: number;
  edge_count: number;
  avg_confidence: number;
  importance_score: number;
  metadata: string | null;
  provenance_id: string;
  created_at: string;
  updated_at: string;
  resolution_type: string | null;
}

/**
 * Row type for knowledge edge archive query
 */
interface ArchiveEdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relationship_type: string;
  weight: number;
  evidence_count: number;
  document_ids: string;
  metadata: string | null;
  provenance_id: string;
  created_at: string;
  valid_from: string | null;
  valid_until: string | null;
  normalized_weight: number | null;
  contradiction_count: number;
}

/**
 * Row type for node_entity_links archive query
 */
interface ArchiveLinkRow {
  id: string;
  node_id: string;
  entity_id: string;
  document_id: string;
  similarity_score: number;
  resolution_method: string | null;
  created_at: string;
}

/**
 * Row type for entities archive query
 */
interface ArchiveEntityRow {
  id: string;
  document_id: string;
  entity_type: string;
  raw_text: string;
  normalized_text: string;
  confidence: number;
  metadata: string | null;
  provenance_id: string;
  created_at: string;
}

/**
 * Result of a KG snapshot archival operation
 */
export interface KGArchiveResult {
  archived: boolean;
  archive_path: string | null;
  nodes_archived: number;
  edges_archived: number;
}

/**
 * Archive the knowledge graph subgraph linked to a document before cascade deletion.
 *
 * Queries all knowledge_nodes connected via node_entity_links -> entities for the
 * given document, plus all edges between those nodes, and writes a JSON snapshot
 * to the archive directory.
 *
 * @param conn - Database connection
 * @param documentId - The document being deleted
 * @param archiveDir - Directory to write the archive file into
 * @returns Archive result with path and counts
 */
export function archiveKGSubgraphForDocument(
  conn: Database.Database,
  documentId: string,
  archiveDir: string,
): KGArchiveResult {
  // Find all knowledge nodes linked to this document
  const nodes = conn.prepare(`
    SELECT DISTINCT kn.*
    FROM knowledge_nodes kn
    JOIN node_entity_links nel ON nel.node_id = kn.id
    WHERE nel.document_id = ?
  `).all(documentId) as ArchiveNodeRow[];

  if (nodes.length === 0) {
    return { archived: false, archive_path: null, nodes_archived: 0, edges_archived: 0 };
  }

  const nodeIds = nodes.map(n => n.id);
  const placeholders = nodeIds.map(() => '?').join(',');

  // Find all edges between the affected nodes
  const edges = conn.prepare(`
    SELECT * FROM knowledge_edges
    WHERE source_node_id IN (${placeholders})
       OR target_node_id IN (${placeholders})
  `).all(...nodeIds, ...nodeIds) as ArchiveEdgeRow[];

  // Get the node_entity_links for this document
  const links = conn.prepare(
    'SELECT * FROM node_entity_links WHERE document_id = ?',
  ).all(documentId) as ArchiveLinkRow[];

  // Get the entities for this document
  const entities = conn.prepare(
    'SELECT * FROM entities WHERE document_id = ?',
  ).all(documentId) as ArchiveEntityRow[];

  // Build the archive payload
  const archive = {
    archive_type: 'kg_snapshot',
    document_id: documentId,
    archived_at: new Date().toISOString(),
    nodes,
    edges,
    node_entity_links: links,
    entities,
  };

  // Write to disk
  mkdirSync(archiveDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(archiveDir, `kg-archive-${documentId}-${timestamp}.json`);
  writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf-8');

  console.error(
    `[INFO] KG snapshot archived for document ${documentId}: ${nodes.length} nodes, ${edges.length} edges -> ${archivePath}`,
  );

  return {
    archived: true,
    archive_path: archivePath,
    nodes_archived: nodes.length,
    edges_archived: edges.length,
  };
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

  deleteDerivedRecords(db, id, 'deleteDocument');

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

  // P1.4: Get or create orphaned root provenance for re-parenting
  const orphanedRootId = getOrCreateOrphanedRoot(db);

  // Pre-clear self-referencing FKs (parent_id, source_id) on provenance records being deleted.
  // Within the same chain_depth, parent provenance may appear before child provenance in the
  // iteration order, causing FK violations. NULLing these first breaks the circular references.
  const clearSelfRefStmt = db.prepare('UPDATE provenance SET parent_id = NULL, source_id = NULL WHERE id = ?');
  for (const { id: provId } of provenanceIds) {
    clearSelfRefStmt.run(provId);
  }

  const deleteProvStmt = db.prepare('DELETE FROM provenance WHERE id = ?');
  const clusterRefCheck = db.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE provenance_id = ?');
  const kgNodeRefCheck = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE provenance_id = ?');
  const reparentProvStmt = db.prepare('UPDATE provenance SET source_id = NULL, parent_id = ?, root_document_id = ? WHERE id = ?');
  const getKgNodesForProv = db.prepare('SELECT id, metadata FROM knowledge_nodes WHERE provenance_id = ?');
  for (const { id: provId } of provenanceIds) {
    // Skip CLUSTERING provenance still referenced by clusters (NOT NULL FK).
    // Skip KNOWLEDGE_GRAPH provenance still referenced by surviving knowledge_nodes (NOT NULL FK).
    // Re-parent to orphaned root so provenance chain is preserved (P1.4).
    // These are cleaned up when the cluster run / knowledge graph is deleted.
    const clusterRefs = (clusterRefCheck.get(provId) as { cnt: number }).cnt;
    const kgNodeRefs = (kgNodeRefCheck.get(provId) as { cnt: number }).cnt;
    if (clusterRefs > 0 || kgNodeRefs > 0) {
      reparentProvStmt.run(orphanedRootId, 'ORPHANED_ROOT', provId);

      // Store re-parenting info in KG node metadata
      if (kgNodeRefs > 0) {
        const kgNodes = getKgNodesForProv.all(provId) as { id: string; metadata: string | null }[];
        for (const kgNode of kgNodes) {
          const existingMeta = kgNode.metadata ? (() => { try { return JSON.parse(kgNode.metadata!); } catch { return {}; } })() : {};
          updateKnowledgeNode(db, kgNode.id, {
            metadata: JSON.stringify({
              ...existingMeta,
              reparented: {
                original_document_id: id,
                original_root_document_id: doc.provenance_id,
                orphaned_root_id: orphanedRootId,
                reparented_at: new Date().toISOString(),
              },
            }),
            updated_at: new Date().toISOString(),
          });
        }
      }
      continue;
    }
    deleteProvStmt.run(provId);
  }

  // Update metadata counts
  updateMetadataCounts();
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
  const doc = getDocument(db, documentId);
  if (!doc) {
    throw new DatabaseError(
      `Document "${documentId}" not found`,
      DatabaseErrorCode.DOCUMENT_NOT_FOUND
    );
  }

  const embeddingCount = deleteDerivedRecords(db, documentId, 'cleanDocumentDerivedData');

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

  console.error(`[INFO] Cleaned derived data for document ${documentId}: ${embeddingCount} embeddings, ${nonRootProvIds.length} provenance records removed`);
}

