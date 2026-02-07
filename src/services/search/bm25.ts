/**
 * BM25 Search Service using SQLite FTS5
 *
 * FAIL FAST: All errors throw immediately with detailed messages
 * PROVENANCE: Every result includes provenance_id and content_hash
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../storage/migrations/schema-definitions.js';

export interface BM25SearchOptions {
  query: string;
  limit?: number;
  phraseSearch?: boolean;
  documentFilter?: string[];
  includeHighlight?: boolean;
}

export interface BM25SearchResult {
  chunk_id: string | null;
  image_id: string | null;
  embedding_id: string | null;
  document_id: string;
  original_text: string;
  bm25_score: number;
  rank: number;
  result_type: 'chunk' | 'vlm';
  source_file_path: string;
  source_file_name: string;
  source_file_hash: string;
  page_number: number | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  provenance_id: string;
  content_hash: string;
  highlight?: string;
}

export class BM25SearchService {
  constructor(private readonly db: Database.Database) {
    this.verifyFTSTableExists();
  }

  private verifyFTSTableExists(): void {
    const result = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'"
    ).get() as { name: string } | undefined;

    if (!result) {
      throw new Error(
        'FTS5 table "chunks_fts" not found. Database must be at schema version 4. ' +
        'Re-select the database to trigger migration.'
      );
    }
  }

  search(options: BM25SearchOptions): BM25SearchResult[] {
    const {
      query,
      limit = 10,
      phraseSearch = false,
      documentFilter,
      includeHighlight = true,
    } = options;

    if (!query || query.trim().length === 0) {
      throw new Error('BM25 search query cannot be empty');
    }

    const ftsQuery = phraseSearch
      ? `"${query.replace(/"/g, '""')}"`
      : this.buildFTSQuery(query);

    let sql = `
      SELECT
        c.id AS chunk_id,
        (SELECT MIN(e.id) FROM embeddings e WHERE e.chunk_id = c.id) AS embedding_id,
        c.document_id,
        c.text AS original_text,
        bm25(chunks_fts) AS bm25_score,
        d.file_path AS source_file_path,
        d.file_name AS source_file_name,
        d.file_hash AS source_file_hash,
        c.page_number,
        c.character_start,
        c.character_end,
        c.chunk_index,
        c.provenance_id,
        c.text_hash AS content_hash
        ${includeHighlight ? ", snippet(chunks_fts, 0, '<mark>', '</mark>', '...', 32) AS highlight" : ''}
      FROM chunks_fts
      JOIN chunks c ON chunks_fts.rowid = c.rowid
      JOIN documents d ON c.document_id = d.id
      WHERE chunks_fts MATCH ?
    `;

    const params: unknown[] = [ftsQuery];

    if (documentFilter && documentFilter.length > 0) {
      sql += ` AND c.document_id IN (${documentFilter.map(() => '?').join(',')})`;
      params.push(...documentFilter);
    }

    sql += ` ORDER BY bm25(chunks_fts) LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row, index) => ({
      chunk_id: row.chunk_id as string,
      image_id: null as string | null,
      embedding_id: (row.embedding_id as string | null) ?? null,
      document_id: row.document_id as string,
      original_text: row.original_text as string,
      bm25_score: Math.abs(row.bm25_score as number),
      rank: index + 1,
      result_type: 'chunk' as const,
      source_file_path: row.source_file_path as string,
      source_file_name: row.source_file_name as string,
      source_file_hash: row.source_file_hash as string,
      page_number: row.page_number as number | null,
      character_start: row.character_start as number,
      character_end: row.character_end as number,
      chunk_index: row.chunk_index as number,
      provenance_id: row.provenance_id as string,
      content_hash: row.content_hash as string,
      highlight: row.highlight as string | undefined,
    }));
  }

  private buildFTSQuery(query: string): string {
    const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => t.replace(/['"()*:^~\-+{}\[\]\\]/g, ''))
      .filter(t => t.length > 0 && !FTS5_KEYWORDS.has(t.toUpperCase()));

    if (tokens.length === 0) {
      throw new Error('Query contains no valid search tokens after sanitization');
    }

    return tokens.join(' AND ');
  }

  /**
   * Search VLM description embeddings using FTS5
   * Queries vlm_fts JOIN embeddings JOIN images JOIN documents
   */
  searchVLM(options: BM25SearchOptions): BM25SearchResult[] {
    const {
      query,
      limit = 10,
      phraseSearch = false,
      documentFilter,
      includeHighlight = true,
    } = options;

    if (!query || query.trim().length === 0) {
      throw new Error('BM25 search query cannot be empty');
    }

    // Check if vlm_fts table exists (v6+ only)
    const vlmFtsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'"
    ).get();
    if (!vlmFtsExists) return [];

    const ftsQuery = phraseSearch
      ? `"${query.replace(/"/g, '""')}"`
      : this.buildFTSQuery(query);

    let sql = `
      SELECT
        e.id AS embedding_id,
        e.image_id,
        e.document_id,
        e.original_text,
        bm25(vlm_fts) AS bm25_score,
        d.file_path AS source_file_path,
        d.file_name AS source_file_name,
        d.file_hash AS source_file_hash,
        e.page_number,
        e.character_start,
        e.character_end,
        e.chunk_index,
        e.provenance_id,
        e.content_hash
        ${includeHighlight ? ", snippet(vlm_fts, 0, '<mark>', '</mark>', '...', 32) AS highlight" : ''}
      FROM vlm_fts
      JOIN embeddings e ON vlm_fts.rowid = e.rowid
      JOIN documents d ON e.document_id = d.id
      WHERE vlm_fts MATCH ?
    `;

    const params: unknown[] = [ftsQuery];

    if (documentFilter && documentFilter.length > 0) {
      sql += ` AND e.document_id IN (${documentFilter.map(() => '?').join(',')})`;
      params.push(...documentFilter);
    }

    sql += ` ORDER BY bm25(vlm_fts) LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row, index) => ({
      chunk_id: null as string | null,
      image_id: row.image_id as string,
      embedding_id: row.embedding_id as string,
      document_id: row.document_id as string,
      original_text: row.original_text as string,
      bm25_score: Math.abs(row.bm25_score as number),
      rank: index + 1,
      result_type: 'vlm' as const,
      source_file_path: row.source_file_path as string,
      source_file_name: row.source_file_name as string,
      source_file_hash: row.source_file_hash as string,
      page_number: row.page_number as number | null,
      character_start: row.character_start as number,
      character_end: row.character_end as number,
      chunk_index: row.chunk_index as number,
      provenance_id: row.provenance_id as string,
      content_hash: row.content_hash as string,
      highlight: row.highlight as string | undefined,
    }));
  }

  rebuildIndex(): {
    chunks_indexed: number;
    vlm_indexed: number;
    duration_ms: number;
    content_hash: string;
  } {
    const start = Date.now();

    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");

    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
    const contentHash = this.computeContentHash();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (1, ?, ?, 'porter unicode61', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_rebuild_at = excluded.last_rebuild_at,
        chunks_indexed = excluded.chunks_indexed,
        content_hash = excluded.content_hash
    `).run(now, count.cnt, SCHEMA_VERSION, contentHash);

    // Also rebuild VLM FTS if table exists
    const vlmResult = this.rebuildVLMIndex();

    const duration = Date.now() - start;

    return {
      chunks_indexed: count.cnt,
      vlm_indexed: vlmResult.vlm_indexed,
      duration_ms: duration,
      content_hash: contentHash,
    };
  }

  /**
   * Rebuild VLM FTS index from embeddings where image_id IS NOT NULL
   */
  rebuildVLMIndex(): { vlm_indexed: number; duration_ms: number } {
    const vlmFtsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'"
    ).get();
    if (!vlmFtsExists) return { vlm_indexed: 0, duration_ms: 0 };

    const start = Date.now();

    this.db.exec("INSERT INTO vlm_fts(vlm_fts) VALUES('rebuild')");

    const count = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL'
    ).get() as { cnt: number };

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (2, ?, ?, 'porter unicode61', ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        last_rebuild_at = excluded.last_rebuild_at,
        chunks_indexed = excluded.chunks_indexed
    `).run(now, count.cnt, SCHEMA_VERSION);

    return {
      vlm_indexed: count.cnt,
      duration_ms: Date.now() - start,
    };
  }

  getStatus(): {
    chunks_indexed: number;
    last_rebuild_at: string | null;
    tokenizer: string;
    content_hash: string | null;
    vlm_indexed: number;
    vlm_last_rebuild_at: string | null;
  } {
    const meta = this.db.prepare('SELECT * FROM fts_index_metadata WHERE id = 1').get() as {
      chunks_indexed: number;
      last_rebuild_at: string | null;
      tokenizer: string;
      content_hash: string | null;
    } | undefined;

    if (!meta) {
      throw new Error('FTS index metadata not found. Database migration to v4 may not have completed.');
    }

    // Get VLM FTS metadata (id=2) if it exists
    const vlmMeta = this.db.prepare('SELECT * FROM fts_index_metadata WHERE id = 2').get() as {
      chunks_indexed: number;
      last_rebuild_at: string | null;
    } | undefined;

    return {
      ...meta,
      vlm_indexed: vlmMeta?.chunks_indexed ?? 0,
      vlm_last_rebuild_at: vlmMeta?.last_rebuild_at ?? null,
    };
  }

  private computeContentHash(): string {
    return computeFTSContentHash(this.db);
  }
}

/**
 * Compute SHA-256 content hash of all chunk IDs and text_hashes for FTS index integrity verification.
 * Used by both BM25SearchService and the v3->v4 migration.
 */
export function computeFTSContentHash(db: Database.Database): string {
  const rows = db.prepare(
    'SELECT id, text_hash FROM chunks ORDER BY id'
  ).all() as Array<{ id: string; text_hash: string }>;

  const content = rows.map(r => `${r.id}:${r.text_hash}`).join('|');
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}
