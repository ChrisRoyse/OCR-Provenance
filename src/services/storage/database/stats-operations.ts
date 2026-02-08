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

  const otherCounts = db
    .prepare(`
    SELECT
      (SELECT COUNT(*) FROM ocr_results) as ocr_count,
      (SELECT COUNT(*) FROM embeddings) as embedding_count,
      (SELECT COUNT(*) FROM provenance) as provenance_count,
      (SELECT COUNT(*) FROM images) as image_count,
      (SELECT COUNT(*) FROM extractions) as extraction_count,
      (SELECT COUNT(*) FROM form_fills) as form_fill_count
  `)
    .get() as {
    ocr_count: number;
    embedding_count: number;
    provenance_count: number;
    image_count: number;
    extraction_count: number;
    form_fill_count: number;
  };

  const ocrCount = otherCounts.ocr_count;
  const embeddingCount = otherCounts.embedding_count;
  const provenanceCount = otherCounts.provenance_count;
  const imageCount = otherCounts.image_count;
  const extractionCount = otherCounts.extraction_count;
  const formFillCount = otherCounts.form_fill_count;

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
    total_images: imageCount,
    total_extractions: extractionCount,
    total_form_fills: formFillCount,
    total_provenance: provenanceCount,
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

  // M-2: Single query for all counts instead of 4 separate COUNT(*) scans
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents) as doc_count,
      (SELECT COUNT(*) FROM ocr_results) as ocr_count,
      (SELECT COUNT(*) FROM chunks) as chunk_count,
      (SELECT COUNT(*) FROM embeddings) as emb_count
  `).get() as { doc_count: number; ocr_count: number; chunk_count: number; emb_count: number };

  db.prepare(`
    UPDATE database_metadata
    SET total_documents = ?, total_ocr_results = ?, total_chunks = ?,
        total_embeddings = ?, last_modified_at = ?
    WHERE id = 1
  `).run(counts.doc_count, counts.ocr_count, counts.chunk_count, counts.emb_count, now);
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
