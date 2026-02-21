/**
 * VectorService - sqlite-vec vector storage and similarity search
 *
 * Handles vector CRUD operations on vec_embeddings virtual table.
 * Search results are self-contained per CP-002 (original text always included).
 *
 * Uses vec_distance_cosine() for all similarity calculations to ensure
 * consistent cosine similarity scoring regardless of underlying index configuration.
 *
 * @module services/storage/vector
 */

import Database from 'better-sqlite3';
import { createRequire } from 'module';
import { SqliteVecModule } from './types.js';

const require = createRequire(import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Error codes for vector operations
 */
enum VectorErrorCode {
  INVALID_VECTOR_DIMENSIONS = 'INVALID_VECTOR_DIMENSIONS',
  EMBEDDING_NOT_FOUND = 'EMBEDDING_NOT_FOUND',
  VEC_EXTENSION_NOT_LOADED = 'VEC_EXTENSION_NOT_LOADED',
  STORE_FAILED = 'STORE_FAILED',
  SEARCH_FAILED = 'SEARCH_FAILED',
  DELETE_FAILED = 'DELETE_FAILED',
}

/**
 * Custom error class for vector operations
 * Includes error code and optional details for debugging
 */
export class VectorError extends Error {
  constructor(
    message: string,
    public readonly code: VectorErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VectorError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Search result from vector similarity search
 * FLAT structure - no nested objects - direct from SQL join
 *
 * CRITICAL: original_text is ALWAYS included per CP-002
 */
export interface VectorSearchResult {
  // Identity
  embedding_id: string;
  chunk_id: string | null;
  image_id: string | null;
  extraction_id: string | null;
  document_id: string;

  // Result type discriminator
  result_type: 'chunk' | 'vlm' | 'extraction';

  // Similarity (computed from distance)
  similarity_score: number; // 1 - distance (0-1, higher = better)
  distance: number; // Raw cosine distance from sqlite-vec

  // Original text - CP-002 CRITICAL
  original_text: string;
  original_text_length: number;

  // Source file (denormalized from embeddings table)
  source_file_path: string;
  source_file_name: string;
  source_file_hash: string;

  // Location in document
  page_number: number | null;
  page_range: string | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  total_chunks: number;

  // Model info
  model_name: string;
  model_version: string;

  // Provenance
  provenance_id: string;
  content_hash: string;

  // Chunk metadata (populated for chunk-based embeddings, null for VLM/extraction)
  heading_context?: string | null;
  section_path?: string | null;
  content_types?: string | null;
  is_atomic?: boolean;
  chunk_page_range?: string | null;
  heading_level?: number | null;

  // Quality score
  ocr_quality_score?: number | null;

  // Document metadata
  doc_title?: string | null;
  doc_author?: string | null;
  doc_subject?: string | null;
}

/**
 * Options for vector similarity search
 */
export interface VectorSearchOptions {
  /** Maximum results to return. Default: 10, Max: 100 */
  limit?: number;
  /** Similarity threshold 0-1. Default: 0.0 (no threshold) */
  threshold?: number;
  /** Filter by document IDs */
  documentFilter?: string[];
  /** Chunk-level filter conditions (from resolveChunkFilter) */
  chunkFilter?: { conditions: string[]; params: unknown[] };
  /** Boost results from higher-quality OCR pages */
  qualityBoost?: boolean;
  /** Page range filter for VLM/extraction results */
  pageRangeFilter?: { min_page?: number; max_page?: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Helper type for search result rows from database
 */
interface SearchRow {
  embedding_id: string;
  distance: number;
  chunk_id: string | null;
  image_id: string | null;
  extraction_id: string | null;
  document_id: string;
  original_text: string;
  original_text_length: number;
  source_file_path: string;
  source_file_name: string;
  source_file_hash: string;
  page_number: number | null;
  page_range: string | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  total_chunks: number;
  model_name: string;
  model_version: string;
  provenance_id: string;
  content_hash: string;
  heading_context: string | null;
  section_path: string | null;
  content_types: string | null;
  is_atomic: number | null;
  chunk_page_range: string | null;
  heading_level: number | null;
  ocr_quality_score?: number | null;
  doc_title: string | null;
  doc_author: string | null;
  doc_subject: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VECTOR SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * VectorService - handles vector storage and similarity search
 *
 * Wraps sqlite-vec operations for 768-dimensional vectors.
 * All search results are self-contained with original text per CP-002.
 */
export class VectorService {
  private readonly db: Database.Database;
  private vecLoaded = false;

  /**
   * Create a new VectorService
   *
   * @param db - Better-sqlite3 database connection with schema already initialized
   * @throws VectorError if sqlite-vec extension cannot be loaded
   */
  constructor(db: Database.Database) {
    this.db = db;
    this.ensureVecExtension();
  }

  /**
   * Ensure sqlite-vec extension is loaded
   * FAIL FAST if not available - no workarounds
   */
  private ensureVecExtension(): void {
    if (this.vecLoaded) return;

    try {
      const sqliteVec = require('sqlite-vec') as SqliteVecModule;
      sqliteVec.load(this.db);
      this.vecLoaded = true;
    } catch (error) {
      throw new VectorError(
        'sqlite-vec extension failed to load. Install: npm install sqlite-vec',
        VectorErrorCode.VEC_EXTENSION_NOT_LOADED,
        { error: String(error) }
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STORE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Store a vector in vec_embeddings
   *
   * PREREQUISITE: Embedding record must already exist in embeddings table
   * (inserted via DatabaseService.insertEmbedding)
   *
   * @param embeddingId - Must match an existing embeddings.id
   * @param vector - 768-dimensional Float32Array
   * @throws VectorError if dimensions != 768 or embedding doesn't exist
   */
  storeVector(embeddingId: string, vector: Float32Array): void {
    // Validate dimensions - FAIL FAST
    if (vector.length !== 768) {
      throw new VectorError(
        `Vector must be 768 dimensions, got ${vector.length}`,
        VectorErrorCode.INVALID_VECTOR_DIMENSIONS,
        { embeddingId, actualDimensions: vector.length, expectedDimensions: 768 }
      );
    }

    // Verify embedding exists - FAIL FAST, no silent failures
    const exists = this.db.prepare('SELECT 1 FROM embeddings WHERE id = ?').get(embeddingId);

    if (!exists) {
      throw new VectorError(
        `Embedding ${embeddingId} not found. Insert into embeddings table first.`,
        VectorErrorCode.EMBEDDING_NOT_FOUND,
        { embeddingId }
      );
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO vec_embeddings (embedding_id, vector)
        VALUES (?, ?)
      `);
      stmt.run(embeddingId, Buffer.from(vector.buffer));
    } catch (error) {
      throw new VectorError(
        `Failed to store vector for ${embeddingId}`,
        VectorErrorCode.STORE_FAILED,
        { embeddingId, error: String(error) }
      );
    }
  }

  /**
   * Store multiple vectors in a single transaction
   *
   * @param items - Array of {embeddingId, vector} pairs
   * @returns Count of vectors stored
   * @throws VectorError on any failure (transaction rolls back)
   */
  batchStoreVectors(items: Array<{ embeddingId: string; vector: Float32Array }>): number {
    if (items.length === 0) return 0;

    // Validate ALL vectors first - FAIL FAST before any writes
    for (const { embeddingId, vector } of items) {
      if (vector.length !== 768) {
        throw new VectorError(
          `Vector for ${embeddingId} must be 768 dimensions, got ${vector.length}`,
          VectorErrorCode.INVALID_VECTOR_DIMENSIONS,
          { embeddingId, actualDimensions: vector.length }
        );
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO vec_embeddings (embedding_id, vector)
      VALUES (?, ?)
    `);

    const insertAll = this.db.transaction((batch) => {
      let count = 0;
      for (const { embeddingId, vector } of batch) {
        stmt.run(embeddingId, Buffer.from(vector.buffer));
        count++;
      }
      return count;
    });

    try {
      return insertAll(items);
    } catch (error) {
      throw new VectorError('Batch vector store failed', VectorErrorCode.STORE_FAILED, {
        count: items.length,
        error: String(error),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Search for similar vectors using cosine distance
   *
   * CRITICAL: Results ALWAYS include original_text per CP-002.
   * No follow-up queries needed - results are self-contained.
   *
   * Uses vec_distance_cosine() for consistent cosine similarity.
   *
   * @param queryVector - 768-dim query vector
   * @param options - Search options (limit, threshold, filters)
   * @returns Array of VectorSearchResult with original text and source info
   */
  searchSimilar(
    queryVector: Float32Array,
    options: VectorSearchOptions = {}
  ): VectorSearchResult[] {
    // Validate query vector - FAIL FAST
    if (queryVector.length !== 768) {
      throw new VectorError(
        `Query vector must be 768 dimensions, got ${queryVector.length}`,
        VectorErrorCode.INVALID_VECTOR_DIMENSIONS,
        { actualDimensions: queryVector.length }
      );
    }

    const limit = Math.min(Math.max(1, options.limit ?? 10), 100);
    const threshold = Math.max(0, Math.min(1, options.threshold ?? 0.0));
    // Cosine distance = 1 - cosine_similarity
    // similarity=1.0 -> distance=0.0 (identical)
    // similarity=0.7 -> distance=0.3
    // similarity=0.0 -> distance=1.0 (perpendicular)
    const maxDistance = 1 - threshold;

    // Convert Float32Array to Buffer for sqlite-vec
    const queryBuffer = Buffer.from(queryVector.buffer);

    if (options.documentFilter?.length) {
      return this.searchWithFilter(queryBuffer, options.documentFilter, maxDistance, limit, options);
    }
    return this.searchAll(queryBuffer, maxDistance, limit, options);
  }

  /**
   * Build chunk filter SQL fragment for vector search.
   * Translates chunk filter conditions from 'c.' alias to 'ch.' alias used in vector queries.
   */
  private buildChunkFilterSQL(options: VectorSearchOptions): { sql: string; params: unknown[] } {
    let sql = '';
    const params: unknown[] = [];

    if (options.chunkFilter?.conditions.length) {
      for (const condition of options.chunkFilter.conditions) {
        // Replace c. with ch. since vector.ts uses 'ch' alias for chunks table
        sql += ` AND ${condition.replace(/\bc\./g, 'ch.')}`;
      }
      params.push(...options.chunkFilter.params);
    }

    // Page range filter for VLM results (which use e.page_number, not ch.page_number)
    // This is handled post-filter in mapAndFilterResults for simplicity,
    // since VLM and chunk results are mixed in vector search.

    return { sql, params };
  }

  /**
   * Search with document filter
   */
  private searchWithFilter(
    queryBuffer: Buffer,
    documentFilter: string[],
    maxDistance: number,
    limit: number,
    options: VectorSearchOptions = {}
  ): VectorSearchResult[] {
    const placeholders = documentFilter.map(() => '?').join(', ');
    const chunkFilterSQL = this.buildChunkFilterSQL(options);

    let sql = `
      SELECT
        e.id as embedding_id,
        e.chunk_id,
        e.image_id,
        e.extraction_id,
        e.document_id,
        e.original_text,
        e.original_text_length,
        e.source_file_path,
        e.source_file_name,
        e.source_file_hash,
        e.page_number,
        e.page_range,
        e.character_start,
        e.character_end,
        e.chunk_index,
        e.total_chunks,
        e.model_name,
        e.model_version,
        e.provenance_id,
        e.content_hash,
        ch.heading_context,
        ch.section_path,
        ch.content_types,
        ch.is_atomic,
        ch.page_range AS chunk_page_range,
        ch.heading_level,
        doc.doc_title,
        doc.doc_author,
        doc.doc_subject,
        (SELECT o.parse_quality_score FROM ocr_results o WHERE o.document_id = e.document_id ORDER BY o.processing_completed_at DESC LIMIT 1) AS ocr_quality_score,
        vec_distance_cosine(v.vector, ?) as distance
      FROM vec_embeddings v
      JOIN embeddings e ON e.id = v.embedding_id
      LEFT JOIN chunks ch ON e.chunk_id = ch.id
      LEFT JOIN documents doc ON e.document_id = doc.id
      WHERE e.document_id IN (${placeholders})
    `;

    // Build params array: queryBuffer for vec_distance_cosine, then document IDs
    const params: unknown[] = [queryBuffer];
    for (const docId of documentFilter) {
      params.push(docId);
    }

    // Add chunk filter conditions
    sql += chunkFilterSQL.sql;
    params.push(...chunkFilterSQL.params);

    sql += `
      ORDER BY distance ASC
      LIMIT ?
    `;
    params.push(limit * 2);

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as SearchRow[];
      return this.mapAndFilterResults(rows, maxDistance, limit, options);
    } catch (error) {
      throw new VectorError('Vector search failed', VectorErrorCode.SEARCH_FAILED, {
        error: String(error),
        hasFilter: true,
      });
    }
  }

  /**
   * Search all vectors without filter
   */
  private searchAll(
    queryBuffer: Buffer,
    maxDistance: number,
    limit: number,
    options: VectorSearchOptions = {}
  ): VectorSearchResult[] {
    try {
      const chunkFilterSQL = this.buildChunkFilterSQL(options);

      let sql = `
        SELECT
          e.id as embedding_id,
          e.chunk_id,
          e.image_id,
          e.extraction_id,
          e.document_id,
          e.original_text,
          e.original_text_length,
          e.source_file_path,
          e.source_file_name,
          e.source_file_hash,
          e.page_number,
          e.page_range,
          e.character_start,
          e.character_end,
          e.chunk_index,
          e.total_chunks,
          e.model_name,
          e.model_version,
          e.provenance_id,
          e.content_hash,
          ch.heading_context,
          ch.section_path,
          ch.content_types,
          ch.is_atomic,
          ch.page_range AS chunk_page_range,
          ch.heading_level,
          doc.doc_title,
          doc.doc_author,
          doc.doc_subject,
          (SELECT o.parse_quality_score FROM ocr_results o WHERE o.document_id = e.document_id ORDER BY o.processing_completed_at DESC LIMIT 1) AS ocr_quality_score,
          vec_distance_cosine(v.vector, ?) as distance
        FROM vec_embeddings v
        JOIN embeddings e ON e.id = v.embedding_id
        LEFT JOIN chunks ch ON e.chunk_id = ch.id
        LEFT JOIN documents doc ON e.document_id = doc.id
      `;

      const params: unknown[] = [queryBuffer];

      // Add chunk filter conditions (need WHERE clause if any)
      if (chunkFilterSQL.sql) {
        sql += ` WHERE 1=1 ${chunkFilterSQL.sql}`;
        params.push(...chunkFilterSQL.params);
      }

      sql += `
        ORDER BY distance ASC
        LIMIT ?
      `;
      params.push(limit * 2);

      const rows = this.db.prepare(sql).all(...params) as SearchRow[];
      return this.mapAndFilterResults(rows, maxDistance, limit, options);
    } catch (error) {
      throw new VectorError('Vector search failed', VectorErrorCode.SEARCH_FAILED, {
        error: String(error),
        hasFilter: false,
      });
    }
  }

  /**
   * Determine result type from row identity fields.
   */
  private static getResultType(row: SearchRow): 'chunk' | 'vlm' | 'extraction' {
    if (row.chunk_id !== null) return 'chunk';
    if (row.extraction_id !== null) return 'extraction';
    return 'vlm';
  }

  /**
   * Map database rows to VectorSearchResult and filter by threshold.
   * Applies quality boost post-query when enabled.
   */
  private mapAndFilterResults(
    rows: SearchRow[],
    maxDistance: number,
    limit: number,
    options: VectorSearchOptions = {}
  ): VectorSearchResult[] {
    const results = rows
      .filter((row) => row.distance <= maxDistance)
      .slice(0, limit)
      .map((row) => ({
        embedding_id: row.embedding_id,
        chunk_id: row.chunk_id,
        image_id: row.image_id,
        extraction_id: row.extraction_id,
        document_id: row.document_id,
        result_type: VectorService.getResultType(row),
        similarity_score: 1 - row.distance, // Convert distance to similarity
        distance: row.distance,
        original_text: row.original_text,
        original_text_length: row.original_text_length,
        source_file_path: row.source_file_path,
        source_file_name: row.source_file_name,
        source_file_hash: row.source_file_hash,
        page_number: row.page_number,
        page_range: row.page_range,
        character_start: row.character_start,
        character_end: row.character_end,
        chunk_index: row.chunk_index,
        total_chunks: row.total_chunks,
        model_name: row.model_name,
        model_version: row.model_version,
        provenance_id: row.provenance_id,
        content_hash: row.content_hash,
        heading_context: row.heading_context ?? null,
        section_path: row.section_path ?? null,
        content_types: row.content_types ?? null,
        is_atomic: !!row.is_atomic,
        chunk_page_range: row.chunk_page_range ?? null,
        heading_level: row.heading_level ?? null,
        ocr_quality_score: row.ocr_quality_score ?? null,
        doc_title: row.doc_title ?? null,
        doc_author: row.doc_author ?? null,
        doc_subject: row.doc_subject ?? null,
      }));

    // Apply quality boost: multiply similarity_score by quality factor, then re-sort
    if (options.qualityBoost) {
      for (const r of results) {
        const qualityFactor = 1 + (r.ocr_quality_score ?? 3) / 10.0;
        r.similarity_score = r.similarity_score * qualityFactor;
      }
      results.sort((a, b) => b.similarity_score - a.similarity_score);
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Delete a vector from vec_embeddings
   *
   * @param embeddingId - The embedding ID
   * @returns true if deleted, false if not found
   */
  deleteVector(embeddingId: string): boolean {
    try {
      const result = this.db
        .prepare('DELETE FROM vec_embeddings WHERE embedding_id = ?')
        .run(embeddingId);
      return result.changes > 0;
    } catch (error) {
      throw new VectorError(
        `Failed to delete vector ${embeddingId}`,
        VectorErrorCode.DELETE_FAILED,
        { embeddingId, error: String(error) }
      );
    }
  }

  /**
   * Delete all vectors for a document
   *
   * @param documentId - The document ID
   * @returns Count of vectors deleted
   */
  deleteVectorsByDocumentId(documentId: string): number {
    try {
      // Get embedding IDs for this document
      const embeddingIds = this.db
        .prepare('SELECT id FROM embeddings WHERE document_id = ?')
        .all(documentId) as Array<{ id: string }>;

      if (embeddingIds.length === 0) return 0;

      const stmt = this.db.prepare('DELETE FROM vec_embeddings WHERE embedding_id = ?');

      const deleteAll = this.db.transaction((ids) => {
        let count = 0;
        for (const id of ids) {
          const result = stmt.run(id);
          count += result.changes;
        }
        return count;
      });

      return deleteAll(embeddingIds.map((e) => e.id));
    } catch (error) {
      throw new VectorError(
        `Failed to delete vectors for document ${documentId}`,
        VectorErrorCode.DELETE_FAILED,
        { documentId, error: String(error) }
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get count of vectors stored
   */
  getVectorCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM vec_embeddings').get() as {
      count: number;
    };
    return result.count;
  }

  /**
   * Check if vector exists
   */
  vectorExists(embeddingId: string): boolean {
    const result = this.db
      .prepare('SELECT 1 FROM vec_embeddings WHERE embedding_id = ?')
      .get(embeddingId);
    return !!result;
  }

  /**
   * Get raw vector by embedding ID
   * @returns Float32Array or null if not found
   */
  getVector(embeddingId: string): Float32Array | null {
    const result = this.db
      .prepare('SELECT vector FROM vec_embeddings WHERE embedding_id = ?')
      .get(embeddingId) as { vector: Buffer } | undefined;

    if (!result) return null;

    return new Float32Array(
      result.vector.buffer,
      result.vector.byteOffset,
      result.vector.byteLength / 4
    );
  }
}
