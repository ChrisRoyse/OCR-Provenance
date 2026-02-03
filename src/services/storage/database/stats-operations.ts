/**
 * Statistics operations for DatabaseService
 *
 * Handles database statistics retrieval.
 */

import Database from 'better-sqlite3';
import { statSync } from 'fs';
import { DatabaseStats } from './types.js';

/**
 * Get database statistics
 *
 * @param db - Database connection
 * @param name - Database name
 * @param path - Database file path
 * @returns DatabaseStats - Live statistics from database
 */
export function getStats(
  db: Database.Database,
  name: string,
  path: string
): DatabaseStats {
  const docStats = db
    .prepare(
      `
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'processing') as processing,
      COUNT(*) FILTER (WHERE status = 'complete') as complete,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) as total
    FROM documents
  `
    )
    .get() as {
    pending: number;
    processing: number;
    complete: number;
    failed: number;
    total: number;
  };

  const chunkStats = db
    .prepare(
      `
    SELECT
      COUNT(*) FILTER (WHERE embedding_status = 'pending') as pending,
      COUNT(*) FILTER (WHERE embedding_status = 'complete') as complete,
      COUNT(*) FILTER (WHERE embedding_status = 'failed') as failed,
      COUNT(*) as total
    FROM chunks
  `
    )
    .get() as {
    pending: number;
    complete: number;
    failed: number;
    total: number;
  };

  const ocrCount = (
    db
      .prepare('SELECT COUNT(*) as count FROM ocr_results')
      .get() as { count: number }
  ).count;

  const embeddingCount = (
    db
      .prepare('SELECT COUNT(*) as count FROM embeddings')
      .get() as { count: number }
  ).count;

  const stats = statSync(path);

  const avgChunksPerDocument =
    docStats.total > 0 ? chunkStats.total / docStats.total : 0;
  const avgEmbeddingsPerChunk =
    chunkStats.total > 0 ? embeddingCount / chunkStats.total : 0;

  return {
    name,
    total_documents: docStats.total,
    documents_by_status: {
      pending: docStats.pending,
      processing: docStats.processing,
      complete: docStats.complete,
      failed: docStats.failed,
    },
    total_ocr_results: ocrCount,
    total_chunks: chunkStats.total,
    chunks_by_embedding_status: {
      pending: chunkStats.pending,
      complete: chunkStats.complete,
      failed: chunkStats.failed,
    },
    total_embeddings: embeddingCount,
    storage_size_bytes: stats.size,
    avg_chunks_per_document: avgChunksPerDocument,
    avg_embeddings_per_chunk: avgEmbeddingsPerChunk,
  };
}

/**
 * Update metadata counts from actual table counts
 *
 * @param db - Database connection
 */
export function updateMetadataCounts(db: Database.Database): void {
  const now = new Date().toISOString();
  const getCount = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;

  const stmt = db.prepare(`
    UPDATE database_metadata
    SET total_documents = ?, total_ocr_results = ?, total_chunks = ?,
        total_embeddings = ?, last_modified_at = ?
    WHERE id = 1
  `);

  stmt.run(
    getCount('documents'),
    getCount('ocr_results'),
    getCount('chunks'),
    getCount('embeddings'),
    now
  );
}

/**
 * Update metadata last_modified_at timestamp
 *
 * @param db - Database connection
 */
export function updateMetadataModified(db: Database.Database): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE database_metadata SET last_modified_at = ? WHERE id = 1
  `);
  stmt.run(now);
}
