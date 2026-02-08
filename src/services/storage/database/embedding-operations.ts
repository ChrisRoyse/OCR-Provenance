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
export function getEmbedding(
  db: Database.Database,
  id: string
): Omit<Embedding, 'vector'> | null {
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
  documentId: string
): Omit<Embedding, 'vector'>[] {
  const stmt = db.prepare(
    'SELECT * FROM embeddings WHERE document_id = ? ORDER BY chunk_index'
  );
  const rows = stmt.all(documentId) as EmbeddingRow[];
  return rows.map(rowToEmbedding);
}
