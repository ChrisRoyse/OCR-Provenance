/**
 * Embedding operations for DatabaseService
 *
 * Handles all CRUD operations for embeddings including batch inserts.
 * Note: Vector data is stored separately in vec_embeddings by VectorService.
 */

import Database from 'better-sqlite3';
import { Embedding } from '../../../models/embedding.js';
import { EmbeddingRow } from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToEmbedding } from './converters.js';

/**
 * Insert an embedding (vector stored separately in vec_embeddings by VectorService)
 *
 * @param db - Database connection
 * @param embedding - Embedding data (created_at will be generated, vector excluded)
 * @param updateMetadataCounts - Callback to update metadata counts
 * @returns string - The embedding ID
 */
export function insertEmbedding(
  db: Database.Database,
  embedding: Omit<Embedding, 'created_at' | 'vector'>,
  updateMetadataCounts: () => void
): string {
  const created_at = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO embeddings (
      id, chunk_id, image_id, extraction_id, document_id, original_text, original_text_length,
      source_file_path, source_file_name, source_file_hash,
      page_number, page_range, character_start, character_end,
      chunk_index, total_chunks, model_name, model_version,
      task_type, inference_mode, gpu_device, provenance_id,
      content_hash, created_at, generation_duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      embedding.id,
      embedding.chunk_id,
      embedding.image_id,
      embedding.extraction_id,
      embedding.document_id,
      embedding.original_text,
      embedding.original_text_length,
      embedding.source_file_path,
      embedding.source_file_name,
      embedding.source_file_hash,
      embedding.page_number,
      embedding.page_range,
      embedding.character_start,
      embedding.character_end,
      embedding.chunk_index,
      embedding.total_chunks,
      embedding.model_name,
      embedding.model_version,
      embedding.task_type,
      embedding.inference_mode,
      embedding.gpu_device,
      embedding.provenance_id,
      embedding.content_hash,
      created_at,
      embedding.generation_duration_ms,
    ],
    'inserting embedding: chunk_id/image_id/extraction_id, document_id, or provenance_id does not exist'
  );

  updateMetadataCounts();
  return embedding.id;
}

/**
 * Insert multiple embeddings in a batch transaction
 *
 * @param db - Database connection
 * @param embeddings - Array of embedding data
 * @param updateMetadataCounts - Callback to update metadata counts
 * @param transaction - Transaction wrapper function
 * @returns string[] - Array of embedding IDs
 */
export function insertEmbeddings(
  db: Database.Database,
  embeddings: Omit<Embedding, 'created_at' | 'vector'>[],
  updateMetadataCounts: () => void,
  transaction: <T>(fn: () => T) => T
): string[] {
  if (embeddings.length === 0) {
    return [];
  }

  return transaction(() => {
    const created_at = new Date().toISOString();
    const ids: string[] = [];

    const stmt = db.prepare(`
      INSERT INTO embeddings (
        id, chunk_id, image_id, extraction_id, document_id, original_text, original_text_length,
        source_file_path, source_file_name, source_file_hash,
        page_number, page_range, character_start, character_end,
        chunk_index, total_chunks, model_name, model_version,
        task_type, inference_mode, gpu_device, provenance_id,
        content_hash, created_at, generation_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const embedding of embeddings) {
      runWithForeignKeyCheck(
        stmt,
        [
          embedding.id,
          embedding.chunk_id,
          embedding.image_id,
          embedding.extraction_id,
          embedding.document_id,
          embedding.original_text,
          embedding.original_text_length,
          embedding.source_file_path,
          embedding.source_file_name,
          embedding.source_file_hash,
          embedding.page_number,
          embedding.page_range,
          embedding.character_start,
          embedding.character_end,
          embedding.chunk_index,
          embedding.total_chunks,
          embedding.model_name,
          embedding.model_version,
          embedding.task_type,
          embedding.inference_mode,
          embedding.gpu_device,
          embedding.provenance_id,
          embedding.content_hash,
          created_at,
          embedding.generation_duration_ms,
        ],
        `inserting embedding "${embedding.id}"`
      );
      ids.push(embedding.id);
    }

    updateMetadataCounts();
    return ids;
  });
}

/**
 * Get an embedding by ID (without vector)
 *
 * @param db - Database connection
 * @param id - Embedding ID
 * @returns Omit<Embedding, 'vector'> | null - The embedding or null if not found
 */
export function getEmbedding(db: Database.Database, id: string): Omit<Embedding, 'vector'> | null {
  const stmt = db.prepare('SELECT * FROM embeddings WHERE id = ?');
  const row = stmt.get(id) as EmbeddingRow | undefined;
  return row ? rowToEmbedding(row) : null;
}

/**
 * Get embedding by chunk ID (without vector)
 *
 * @param db - Database connection
 * @param chunkId - Chunk ID
 * @returns Omit<Embedding, 'vector'> | null - The embedding or null if not found
 */
export function getEmbeddingByChunkId(
  db: Database.Database,
  chunkId: string
): Omit<Embedding, 'vector'> | null {
  const stmt = db.prepare('SELECT * FROM embeddings WHERE chunk_id = ?');
  const row = stmt.get(chunkId) as EmbeddingRow | undefined;
  return row ? rowToEmbedding(row) : null;
}

/**
 * Get embedding by extraction ID (without vector)
 *
 * @param db - Database connection
 * @param extractionId - Extraction ID
 * @returns Omit<Embedding, 'vector'> | null
 */
export function getEmbeddingByExtractionId(
  db: Database.Database,
  extractionId: string
): Omit<Embedding, 'vector'> | null {
  const stmt = db.prepare('SELECT * FROM embeddings WHERE extraction_id = ?');
  const row = stmt.get(extractionId) as EmbeddingRow | undefined;
  return row ? rowToEmbedding(row) : null;
}

/**
 * Get all embeddings for a document (without vectors)
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns Omit<Embedding, 'vector'>[] - Array of embeddings
 */
export function getEmbeddingsByDocumentId(
  db: Database.Database,
  documentId: string,
  options?: { limit?: number; offset?: number }
): Omit<Embedding, 'vector'>[] {
  let sql = 'SELECT * FROM embeddings WHERE document_id = ? ORDER BY chunk_index';
  const params: (string | number)[] = [documentId];

  const limit = options?.limit ?? 10000;
  sql += ' LIMIT ?';
  params.push(limit);

  if (options?.offset !== undefined) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as EmbeddingRow[];
  return rows.map(rowToEmbedding);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILTERED QUERIES & STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Filter options for getEmbeddingsFiltered
 */
export interface EmbeddingFilterOptions {
  document_id?: string;
  source_type?: 'chunk' | 'image' | 'extraction';
  model_name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Get embeddings with dynamic filtering by document, source type, model.
 * Does NOT select the vector column (it's huge binary data in vec_embeddings).
 *
 * @param db - Database connection
 * @param filters - Filter options
 * @returns Array of embeddings (without vector) and total count
 */
export function getEmbeddingsFiltered(
  db: Database.Database,
  filters: EmbeddingFilterOptions
): { embeddings: Array<Omit<Embedding, 'vector'>>; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.document_id) {
    conditions.push('e.document_id = ?');
    params.push(filters.document_id);
  }

  if (filters.source_type === 'chunk') {
    conditions.push('e.chunk_id IS NOT NULL AND e.image_id IS NULL AND e.extraction_id IS NULL');
  } else if (filters.source_type === 'image') {
    conditions.push('e.image_id IS NOT NULL');
  } else if (filters.source_type === 'extraction') {
    conditions.push('e.extraction_id IS NOT NULL');
  }

  if (filters.model_name) {
    conditions.push('e.model_name = ?');
    params.push(filters.model_name);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Get total count
  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM embeddings e ${whereClause}`)
    .get(...params) as { total: number };

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const rows = db
    .prepare(
      `SELECT e.* FROM embeddings e ${whereClause} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as EmbeddingRow[];

  return {
    embeddings: rows.map(rowToEmbedding),
    total: countRow.total,
  };
}

/**
 * Embedding statistics result
 */
export interface EmbeddingStatsResult {
  total_embeddings: number;
  by_source_type: Record<string, { count: number; avg_duration_ms: number }>;
  by_device: Record<string, number>;
  unembedded_chunks: number;
  unembedded_images: number;
}

/**
 * Get embedding statistics with optional document-level scoping.
 *
 * @param db - Database connection
 * @param documentId - Optional document ID to scope stats
 * @returns EmbeddingStatsResult
 */
export function getEmbeddingStats(
  db: Database.Database,
  documentId?: string
): EmbeddingStatsResult {
  const docFilter = documentId ? ' WHERE document_id = ?' : '';
  const docParams: unknown[] = documentId ? [documentId] : [];

  // Total embeddings
  const totalRow = db
    .prepare(`SELECT COUNT(*) as total FROM embeddings${docFilter}`)
    .get(...docParams) as { total: number };

  // By source type
  const sourceTypeRows = db
    .prepare(
      `
    SELECT
      CASE
        WHEN chunk_id IS NOT NULL AND image_id IS NULL AND extraction_id IS NULL THEN 'chunk'
        WHEN image_id IS NOT NULL THEN 'image'
        WHEN extraction_id IS NOT NULL THEN 'extraction'
        ELSE 'unknown'
      END as source_type,
      COUNT(*) as count,
      COALESCE(AVG(generation_duration_ms), 0) as avg_duration_ms
    FROM embeddings${docFilter}
    GROUP BY source_type
  `
    )
    .all(...docParams) as Array<{ source_type: string; count: number; avg_duration_ms: number }>;

  const by_source_type: Record<string, { count: number; avg_duration_ms: number }> = {};
  for (const row of sourceTypeRows) {
    by_source_type[row.source_type] = {
      count: row.count,
      avg_duration_ms: Math.round(row.avg_duration_ms),
    };
  }

  // By device (from provenance processor field)
  const deviceRows = db
    .prepare(
      `
    SELECT
      COALESCE(e.gpu_device, 'unknown') as device,
      COUNT(*) as count
    FROM embeddings e${docFilter}
    GROUP BY device
  `
    )
    .all(...docParams) as Array<{ device: string; count: number }>;

  const by_device: Record<string, number> = {};
  for (const row of deviceRows) {
    by_device[row.device] = row.count;
  }

  // Unembedded chunks: chunks with embedding_status != 'complete'
  const unembeddedChunksRow = db
    .prepare(
      `
    SELECT COUNT(*) as count FROM chunks
    WHERE embedding_status != 'complete'${documentId ? ' AND document_id = ?' : ''}
  `
    )
    .get(...docParams) as { count: number };

  // Unembedded images: images with vlm_status='complete' but no VLM embedding
  const unembeddedImagesRow = db
    .prepare(
      `
    SELECT COUNT(*) as count FROM images i
    WHERE i.vlm_status = 'complete'
      AND i.vlm_embedding_id IS NULL
      ${documentId ? 'AND i.document_id = ?' : ''}
  `
    )
    .get(...docParams) as { count: number };

  return {
    total_embeddings: totalRow.total,
    by_source_type,
    by_device,
    unembedded_chunks: unembeddedChunksRow.count,
    unembedded_images: unembeddedImagesRow.count,
  };
}

/**
 * Delete all embeddings for a specific chunk
 *
 * @param db - Database connection
 * @param chunkId - Chunk ID
 * @returns number of embeddings deleted
 */
export function deleteEmbeddingsByChunkId(db: Database.Database, chunkId: string): number {
  const result = db.prepare('DELETE FROM embeddings WHERE chunk_id = ?').run(chunkId);
  return result.changes;
}

/**
 * Delete all embeddings for a specific image
 *
 * @param db - Database connection
 * @param imageId - Image ID
 * @returns number of embeddings deleted
 */
export function deleteEmbeddingsByImageId(db: Database.Database, imageId: string): number {
  const result = db.prepare('DELETE FROM embeddings WHERE image_id = ?').run(imageId);
  return result.changes;
}

/**
 * Delete all embeddings for a document
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns number of embeddings deleted
 */
export function deleteEmbeddingsByDocumentId(db: Database.Database, documentId: string): number {
  const result = db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(documentId);
  return result.changes;
}
