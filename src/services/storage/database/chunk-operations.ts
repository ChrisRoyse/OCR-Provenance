/**
 * Chunk operations for DatabaseService
 *
 * Handles all CRUD operations for text chunks including
 * batch inserts, embedding status updates, filtered queries,
 * and neighbor lookups.
 */

import Database from 'better-sqlite3';
import { Chunk } from '../../../models/chunk.js';
import { DatabaseError, DatabaseErrorCode, ChunkRow } from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToChunk } from './converters.js';

/**
 * Filter options for getChunksFiltered
 */
export interface ChunkFilterOptions {
  section_path_filter?: string;
  heading_filter?: string;
  content_type_filter?: string[];
  min_quality_score?: number;
  embedding_status?: 'pending' | 'complete' | 'failed';
  is_atomic?: boolean;
  page_range?: { min_page?: number; max_page?: number };
  limit?: number;
  offset?: number;
  include_text?: boolean;
}

/**
 * Insert a chunk
 *
 * @param db - Database connection
 * @param chunk - Chunk data (created_at, embedding_status, embedded_at will be generated)
 * @param updateMetadataCounts - Callback to update metadata counts
 * @returns string - The chunk ID
 */
export function insertChunk(
  db: Database.Database,
  chunk: Omit<Chunk, 'created_at' | 'embedding_status' | 'embedded_at'>,
  updateMetadataCounts: () => void
): string {
  const created_at = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO chunks (
      id, document_id, ocr_result_id, text, text_hash, chunk_index,
      character_start, character_end, page_number, page_range,
      overlap_previous, overlap_next, provenance_id, created_at,
      embedding_status, embedded_at, ocr_quality_score,
      heading_context, heading_level, section_path,
      content_types, is_atomic, chunking_strategy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      chunk.id,
      chunk.document_id,
      chunk.ocr_result_id,
      chunk.text,
      chunk.text_hash,
      chunk.chunk_index,
      chunk.character_start,
      chunk.character_end,
      chunk.page_number,
      chunk.page_range,
      chunk.overlap_previous,
      chunk.overlap_next,
      chunk.provenance_id,
      created_at,
      'pending',
      null,
      chunk.ocr_quality_score ?? null,
      chunk.heading_context ?? null,
      chunk.heading_level ?? null,
      chunk.section_path ?? null,
      chunk.content_types ?? null,
      chunk.is_atomic ?? 0,
      chunk.chunking_strategy ?? 'fixed',
    ],
    'inserting chunk: document_id, ocr_result_id, or provenance_id does not exist'
  );

  updateMetadataCounts();
  return chunk.id;
}

/**
 * Insert multiple chunks in a batch transaction
 *
 * @param db - Database connection
 * @param chunks - Array of chunk data
 * @param updateMetadataCounts - Callback to update metadata counts
 * @param transaction - Transaction wrapper function
 * @returns string[] - Array of chunk IDs
 */
export function insertChunks(
  db: Database.Database,
  chunks: Omit<Chunk, 'created_at' | 'embedding_status' | 'embedded_at'>[],
  updateMetadataCounts: () => void,
  transaction: <T>(fn: () => T) => T
): string[] {
  if (chunks.length === 0) {
    return [];
  }

  return transaction(() => {
    const created_at = new Date().toISOString();
    const ids: string[] = [];

    const stmt = db.prepare(`
      INSERT INTO chunks (
        id, document_id, ocr_result_id, text, text_hash, chunk_index,
        character_start, character_end, page_number, page_range,
        overlap_previous, overlap_next, provenance_id, created_at,
        embedding_status, embedded_at, ocr_quality_score,
        heading_context, heading_level, section_path,
        content_types, is_atomic, chunking_strategy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      runWithForeignKeyCheck(
        stmt,
        [
          chunk.id,
          chunk.document_id,
          chunk.ocr_result_id,
          chunk.text,
          chunk.text_hash,
          chunk.chunk_index,
          chunk.character_start,
          chunk.character_end,
          chunk.page_number,
          chunk.page_range,
          chunk.overlap_previous,
          chunk.overlap_next,
          chunk.provenance_id,
          created_at,
          'pending',
          null,
          chunk.ocr_quality_score ?? null,
          chunk.heading_context ?? null,
          chunk.heading_level ?? null,
          chunk.section_path ?? null,
          chunk.content_types ?? null,
          chunk.is_atomic ?? 0,
          chunk.chunking_strategy ?? 'fixed',
        ],
        `inserting chunk "${chunk.id}"`
      );
      ids.push(chunk.id);
    }

    updateMetadataCounts();
    return ids;
  });
}

/**
 * Get a chunk by ID
 *
 * @param db - Database connection
 * @param id - Chunk ID
 * @returns Chunk | null - The chunk or null if not found
 */
export function getChunk(db: Database.Database, id: string): Chunk | null {
  const stmt = db.prepare('SELECT * FROM chunks WHERE id = ?');
  const row = stmt.get(id) as ChunkRow | undefined;
  return row ? rowToChunk(row) : null;
}

/**
 * Check if a document has any chunks (M-9: avoids loading all chunk rows)
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns boolean - true if document has at least one chunk
 */
export function hasChunksByDocumentId(db: Database.Database, documentId: string): boolean {
  const stmt = db.prepare('SELECT 1 FROM chunks WHERE document_id = ? LIMIT 1');
  return stmt.get(documentId) !== undefined;
}

/**
 * Get all chunks for a document
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns Chunk[] - Array of chunks ordered by chunk_index
 */
export function getChunksByDocumentId(db: Database.Database, documentId: string): Chunk[] {
  const stmt = db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index');
  const rows = stmt.all(documentId) as ChunkRow[];
  return rows.map(rowToChunk);
}

/**
 * Get all chunks for an OCR result
 *
 * @param db - Database connection
 * @param ocrResultId - OCR result ID
 * @returns Chunk[] - Array of chunks ordered by chunk_index
 */
export function getChunksByOCRResultId(db: Database.Database, ocrResultId: string): Chunk[] {
  const stmt = db.prepare('SELECT * FROM chunks WHERE ocr_result_id = ? ORDER BY chunk_index');
  const rows = stmt.all(ocrResultId) as ChunkRow[];
  return rows.map(rowToChunk);
}

/**
 * Get chunks pending embedding generation
 *
 * @param db - Database connection
 * @param limit - Optional maximum number of chunks to return
 * @returns Chunk[] - Array of pending chunks
 */
export function getPendingEmbeddingChunks(db: Database.Database, limit?: number): Chunk[] {
  // M-15: Default limit prevents unbounded loading of all pending chunks
  const effectiveLimit = limit ?? 1000;
  const query =
    "SELECT * FROM chunks WHERE embedding_status = 'pending' ORDER BY created_at LIMIT ?";
  const stmt = db.prepare(query);
  const rows = stmt.all(effectiveLimit) as ChunkRow[];
  return rows.map(rowToChunk);
}

/**
 * Update chunk embedding status
 *
 * @param db - Database connection
 * @param id - Chunk ID
 * @param status - New embedding status
 * @param embeddedAt - Optional ISO 8601 timestamp when embedded
 * @param updateMetadataModified - Callback to update metadata modified timestamp
 */
export function updateChunkEmbeddingStatus(
  db: Database.Database,
  id: string,
  status: 'pending' | 'complete' | 'failed',
  embeddedAt: string | undefined,
  updateMetadataModified: () => void
): void {
  const stmt = db.prepare(`
    UPDATE chunks
    SET embedding_status = ?, embedded_at = ?
    WHERE id = ?
  `);

  const result = stmt.run(status, embeddedAt ?? null, id);

  if (result.changes === 0) {
    throw new DatabaseError(`Chunk "${id}" not found`, DatabaseErrorCode.CHUNK_NOT_FOUND);
  }

  updateMetadataModified();
}

/**
 * Get chunks for a document with dynamic filtering.
 *
 * Builds a parameterized WHERE clause from the provided filters.
 * For content_type_filter, uses LIKE matching against the JSON-encoded
 * content_types column (e.g., content_types LIKE '%table%').
 *
 * @param db - Database connection
 * @param documentId - Document ID to filter by
 * @param filters - Filter options
 * @returns Object with chunks array and total count
 */
export function getChunksFiltered(
  db: Database.Database,
  documentId: string,
  filters: ChunkFilterOptions
): { chunks: Chunk[]; total: number } {
  const conditions: string[] = ['document_id = ?'];
  const params: (string | number)[] = [documentId];

  if (filters.section_path_filter) {
    conditions.push("section_path LIKE ? || '%'");
    params.push(filters.section_path_filter);
  }

  if (filters.heading_filter) {
    conditions.push("heading_context LIKE '%' || ? || '%'");
    params.push(filters.heading_filter);
  }

  if (filters.content_type_filter && filters.content_type_filter.length > 0) {
    // Each content type must be present in the JSON array string
    for (const ct of filters.content_type_filter) {
      conditions.push("content_types LIKE '%' || ? || '%'");
      params.push(ct);
    }
  }

  if (filters.min_quality_score !== undefined) {
    conditions.push('ocr_quality_score >= ?');
    params.push(filters.min_quality_score);
  }

  if (filters.embedding_status) {
    conditions.push('embedding_status = ?');
    params.push(filters.embedding_status);
  }

  if (filters.is_atomic !== undefined) {
    conditions.push('is_atomic = ?');
    params.push(filters.is_atomic ? 1 : 0);
  }

  if (filters.page_range) {
    if (filters.page_range.min_page !== undefined) {
      conditions.push('page_number >= ?');
      params.push(filters.page_range.min_page);
    }
    if (filters.page_range.max_page !== undefined) {
      conditions.push('page_number <= ?');
      params.push(filters.page_range.max_page);
    }
  }

  const whereClause = ' WHERE ' + conditions.join(' AND ');

  // Get total count with same filters
  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM chunks${whereClause}`)
    .get(...params) as { total: number };

  // Get paginated results
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const dataQuery = `SELECT * FROM chunks${whereClause} ORDER BY chunk_index LIMIT ? OFFSET ?`;
  const rows = db.prepare(dataQuery).all(...params, limit, offset) as ChunkRow[];

  return {
    chunks: rows.map(rowToChunk),
    total: countRow.total,
  };
}

/**
 * Get neighboring chunks around a given chunk index for context building.
 *
 * Returns chunks with chunk_index in range [chunkIndex - count, chunkIndex + count],
 * ordered by chunk_index.
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @param chunkIndex - Center chunk index
 * @param count - Number of neighbors on each side
 * @returns Chunk[] - Array of neighboring chunks (including center)
 */
export function getChunkNeighbors(
  db: Database.Database,
  documentId: string,
  chunkIndex: number,
  count: number
): Chunk[] {
  const minIndex = Math.max(0, chunkIndex - count);
  const maxIndex = chunkIndex + count;

  const stmt = db.prepare(
    'SELECT * FROM chunks WHERE document_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index'
  );
  const rows = stmt.all(documentId, minIndex, maxIndex) as ChunkRow[];
  return rows.map(rowToChunk);
}
