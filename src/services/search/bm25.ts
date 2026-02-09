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
  extraction_id: string | null;
  document_id: string;
  original_text: string;
  bm25_score: number;
  rank: number;
  result_type: 'chunk' | 'vlm' | 'extraction';
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
        (SELECT e.id FROM embeddings e WHERE e.chunk_id = c.id ORDER BY e.created_at DESC LIMIT 1) AS embedding_id,
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
      extraction_id: null as string | null,
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
    // L-8 fix: Preserve FTS5 boolean operators (NOT, OR) to maintain query intent.
    // Previously "cats NOT dogs" became "cats AND dogs" -- reversing intent.
    // Note: NEAR removed -- FTS5 requires NEAR(t1 t2, N) function syntax, not infix.
    const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT']);
    const rawTokens = query.trim().split(/\s+/).filter(t => t.length > 0);

    const result: string[] = [];
    for (const raw of rawTokens) {
      if (FTS5_OPERATORS.has(raw.toUpperCase())) {
        result.push(raw.toUpperCase());
      } else {
        // L-5: Treat hyphens as word separators (matching FTS5 unicode61 tokenizer)
        const parts = raw.split(/-/)
          .map(p => p.replace(/['"()*:^~+{}\[\]\\;@<>#!$%&|,./`?]/g, ''))
          .filter(p => p.length > 0);
        result.push(...parts);
      }
    }

    // Strip leading/trailing operators and consecutive operators
    while (result.length > 0 && FTS5_OPERATORS.has(result[0])) result.shift();
    while (result.length > 0 && FTS5_OPERATORS.has(result[result.length - 1])) result.pop();
    const cleaned: string[] = [];
    for (const t of result) {
      if (FTS5_OPERATORS.has(t) && cleaned.length > 0 && FTS5_OPERATORS.has(cleaned[cleaned.length - 1])) continue;
      cleaned.push(t);
    }

    const finalTokens = cleaned.filter(t => t.length > 0);
    if (finalTokens.length === 0) {
      throw new Error('Query contains no valid search tokens after sanitization');
    }

    // Insert implicit AND between consecutive non-operator tokens
    const parts: string[] = [];
    for (let i = 0; i < finalTokens.length; i++) {
      parts.push(finalTokens[i]);
      if (i < finalTokens.length - 1 && !FTS5_OPERATORS.has(finalTokens[i]) && !FTS5_OPERATORS.has(finalTokens[i + 1])) {
        parts.push('AND');
      }
    }

    return parts.join(' ');
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
      extraction_id: null as string | null,
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

  /**
   * Search extraction content using FTS5
   * Queries extractions_fts JOIN extractions JOIN documents
   */
  searchExtractions(options: BM25SearchOptions): BM25SearchResult[] {
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

    // Check if extractions_fts table exists (v9+ only)
    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='extractions_fts'"
    ).get();
    if (!ftsExists) return [];

    const ftsQuery = phraseSearch
      ? `"${query.replace(/"/g, '""')}"`
      : this.buildFTSQuery(query);

    let sql = `
      SELECT
        ex.id AS extraction_id,
        ex.document_id,
        ex.extraction_json AS original_text,
        bm25(extractions_fts) AS bm25_score,
        d.file_path AS source_file_path,
        d.file_name AS source_file_name,
        d.file_hash AS source_file_hash,
        ex.provenance_id,
        ex.content_hash
        ${includeHighlight ? ", snippet(extractions_fts, 0, '<mark>', '</mark>', '...', 32) AS highlight" : ''}
      FROM extractions_fts
      JOIN extractions ex ON extractions_fts.rowid = ex.rowid
      JOIN documents d ON ex.document_id = d.id
      WHERE extractions_fts MATCH ?
    `;

    const params: unknown[] = [ftsQuery];

    if (documentFilter && documentFilter.length > 0) {
      sql += ` AND ex.document_id IN (${documentFilter.map(() => '?').join(',')})`;
      params.push(...documentFilter);
    }

    sql += ` ORDER BY bm25(extractions_fts) LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row, index) => ({
      chunk_id: null as string | null,
      image_id: null as string | null,
      embedding_id: null as string | null,
      extraction_id: row.extraction_id as string,
      document_id: row.document_id as string,
      original_text: row.original_text as string,
      bm25_score: Math.abs(row.bm25_score as number),
      rank: index + 1,
      result_type: 'extraction' as const,
      source_file_path: row.source_file_path as string,
      source_file_name: row.source_file_name as string,
      source_file_hash: row.source_file_hash as string,
      page_number: null as number | null,
      character_start: 0,
      character_end: 0,
      chunk_index: 0,
      provenance_id: row.provenance_id as string,
      content_hash: row.content_hash as string,
      highlight: row.highlight as string | undefined,
    }));
  }

  rebuildIndex(): {
    chunks_indexed: number;
    vlm_indexed: number;
    extractions_indexed: number;
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

    // Also rebuild extractions FTS if table exists
    const extractionResult = this.rebuildExtractionIndex();

    const duration = Date.now() - start;

    return {
      chunks_indexed: count.cnt,
      vlm_indexed: vlmResult.vlm_indexed,
      extractions_indexed: extractionResult.extractions_indexed,
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

    // H-4 fix: FTS5 'rebuild' reads ALL rows from the content table (embeddings),
    // including chunk embeddings (image_id IS NULL). This creates ghost VLM results.
    // Instead: clear the index, then manually re-insert only VLM embeddings.
    this.db.exec("INSERT INTO vlm_fts(vlm_fts) VALUES('delete-all')");
    this.db.exec(`
      INSERT INTO vlm_fts(rowid, original_text)
      SELECT rowid, original_text FROM embeddings WHERE image_id IS NOT NULL
    `);

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

  /**
   * Rebuild extractions FTS index
   */
  rebuildExtractionIndex(): { extractions_indexed: number; duration_ms: number } {
    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='extractions_fts'"
    ).get();
    if (!ftsExists) return { extractions_indexed: 0, duration_ms: 0 };

    const start = Date.now();

    this.db.exec("INSERT INTO extractions_fts(extractions_fts) VALUES('rebuild')");

    const count = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM extractions'
    ).get() as { cnt: number };

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (3, ?, ?, 'porter unicode61', ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        last_rebuild_at = excluded.last_rebuild_at,
        chunks_indexed = excluded.chunks_indexed
    `).run(now, count.cnt, SCHEMA_VERSION);

    return {
      extractions_indexed: count.cnt,
      duration_ms: Date.now() - start,
    };
  }

  getStatus(): {
    chunks_indexed: number;
    current_chunk_count: number;
    index_stale: boolean;
    last_rebuild_at: string | null;
    tokenizer: string;
    content_hash: string | null;
    vlm_indexed: number;
    current_vlm_count: number;
    vlm_index_stale: boolean;
    vlm_last_rebuild_at: string | null;
    extractions_indexed: number;
    current_extraction_count: number;
    extraction_index_stale: boolean;
    extraction_last_rebuild_at: string | null;
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

    // Drift detection: compare stored count to actual count
    const chunkCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt;

    // Get VLM FTS metadata (id=2) if it exists
    const vlmMeta = this.db.prepare('SELECT * FROM fts_index_metadata WHERE id = 2').get() as {
      chunks_indexed: number;
      last_rebuild_at: string | null;
    } | undefined;

    const vlmCount = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL'
    ).get() as { cnt: number }).cnt;

    const vlmIndexed = vlmMeta?.chunks_indexed ?? 0;

    // Get extraction FTS metadata (id=3) if it exists
    const extractionMeta = this.db.prepare('SELECT * FROM fts_index_metadata WHERE id = 3').get() as {
      chunks_indexed: number;
      last_rebuild_at: string | null;
    } | undefined;

    const extractionCount = (() => {
      try {
        return (this.db.prepare('SELECT COUNT(*) as cnt FROM extractions').get() as { cnt: number }).cnt;
      } catch {
        return 0;
      }
    })();

    const extractionsIndexed = extractionMeta?.chunks_indexed ?? 0;

    return {
      ...meta,
      current_chunk_count: chunkCount,
      index_stale: meta.chunks_indexed !== chunkCount,
      vlm_indexed: vlmIndexed,
      current_vlm_count: vlmCount,
      vlm_index_stale: vlmIndexed !== vlmCount,
      vlm_last_rebuild_at: vlmMeta?.last_rebuild_at ?? null,
      extractions_indexed: extractionsIndexed,
      current_extraction_count: extractionCount,
      extraction_index_stale: extractionsIndexed !== extractionCount,
      extraction_last_rebuild_at: extractionMeta?.last_rebuild_at ?? null,
    };
  }

  private computeContentHash(): string {
    return computeFTSContentHash(this.db);
  }
}

/**
 * Compute SHA-256 content hash of all chunk IDs and text_hashes for FTS index integrity verification.
 * L-10 fix: Uses incremental hashing with iterate() instead of loading all rows into memory.
 * Used by both BM25SearchService and the v3->v4 migration.
 */
export function computeFTSContentHash(db: Database.Database): string {
  const hash = crypto.createHash('sha256');
  let first = true;
  for (const row of db.prepare('SELECT id, text_hash FROM chunks ORDER BY id').iterate()) {
    const r = row as { id: string; text_hash: string };
    if (!first) hash.update('|');
    hash.update(`${r.id}:${r.text_hash}`);
    first = false;
  }
  return 'sha256:' + hash.digest('hex');
}
