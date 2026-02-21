/**
 * Chunk Deduplication Service (HE-4 / Task 7.3)
 *
 * Identifies exact duplicate chunks by text_hash for deduplication
 * in search results and storage analysis.
 *
 * @module services/chunking/chunk-deduplicator
 */

import type { DatabaseService } from '../storage/database/index.js';

/** Result of a chunk deduplication analysis */
export interface DeduplicationResult {
  totalChunks: number;
  uniqueChunks: number;
  duplicateGroups: Array<{
    hash: string;
    count: number;
    chunkIds: string[];
    representativeChunkId: string;
  }>;
}

/**
 * Find exact duplicate chunks by text_hash.
 *
 * Groups chunks that share the same text_hash and identifies
 * duplicate groups (2+ chunks with the same hash). Optionally
 * scoped to a single document.
 *
 * @param db - Database service instance
 * @param documentId - Optional document ID to scope analysis
 * @returns DeduplicationResult with total, unique counts, and duplicate groups
 */
export function findExactDuplicateChunks(
  db: DatabaseService,
  documentId?: string
): DeduplicationResult {
  const conn = db.getConnection();
  const filter = documentId ? 'WHERE document_id = ?' : '';
  const params = documentId ? [documentId] : [];

  const groups = conn.prepare(
    `SELECT text_hash, COUNT(*) as count, GROUP_CONCAT(id) as chunk_ids
     FROM chunks ${filter}
     GROUP BY text_hash
     HAVING COUNT(*) > 1
     ORDER BY count DESC`
  ).all(...params) as Array<{ text_hash: string; count: number; chunk_ids: string }>;

  const duplicateGroups = groups.map(g => {
    const chunkIds = g.chunk_ids.split(',');
    return {
      hash: g.text_hash,
      count: g.count,
      chunkIds,
      representativeChunkId: chunkIds[0],
    };
  });

  const totalRow = conn.prepare(
    `SELECT COUNT(*) as c FROM chunks ${filter}`
  ).get(...params) as { c: number };

  const uniqueRow = conn.prepare(
    `SELECT COUNT(DISTINCT text_hash) as c FROM chunks ${filter}`
  ).get(...params) as { c: number };

  return {
    totalChunks: totalRow.c,
    uniqueChunks: uniqueRow.c,
    duplicateGroups,
  };
}
