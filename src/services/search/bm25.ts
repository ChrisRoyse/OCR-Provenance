/**
 * BM25 Search Service using SQLite FTS5
 *
 * FAIL FAST: All errors throw immediately with detailed messages
 * PROVENANCE: Every result includes provenance_id and content_hash
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../storage/migrations/schema-definitions.js';

interface ChunkFilterSQL {
  conditions: string[];
  params: unknown[];
}

interface BM25SearchOptions {
  query: string;
  limit?: number;
  phraseSearch?: boolean;
  documentFilter?: string[];
  includeHighlight?: boolean;
  chunkFilter?: ChunkFilterSQL;
  qualityBoost?: boolean;
  /** Page range filter applied to VLM/extraction searches (which lack chunk metadata) */
  pageRangeFilter?: { min_page?: number; max_page?: number };
}

interface BM25SearchResult {
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
  heading_context?: string | null;
  section_path?: string | null;
  content_types?: string | null;
  is_atomic?: boolean;
  page_range?: string | null;
  heading_level?: number | null;
  ocr_quality_score?: number | null;
}

export class BM25SearchService {
  constructor(private readonly db: Database.Database) {
    this.verifyFTSTableExists();
  }

  private verifyFTSTableExists(): void {
    const result = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
      .get() as { name: string } | undefined;

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
      chunkFilter,
      qualityBoost = false,
    } = options;

    if (!query || query.trim().length === 0) {
      throw new Error('BM25 search query cannot be empty');
    }

    const ftsQuery = phraseSearch ? `"${query.replace(/"/g, '""')}"` : sanitizeFTS5Query(query);

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
        c.text_hash AS content_hash,
        c.heading_context,
        c.section_path,
        c.content_types,
        c.is_atomic,
        c.page_range,
        c.heading_level
        ${qualityBoost ? ', (SELECT o.parse_quality_score FROM ocr_results o WHERE o.document_id = c.document_id ORDER BY o.processing_completed_at DESC LIMIT 1) AS ocr_quality_score' : ''}
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

    if (chunkFilter && chunkFilter.conditions.length > 0) {
      for (const condition of chunkFilter.conditions) {
        sql += ` AND ${condition}`;
      }
      params.push(...chunkFilter.params);
    }

    sql += ` ORDER BY bm25(chunks_fts) LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    // TY-09: Field casts below are intentional -- better-sqlite3 returns untyped Records.
    // The SQL query guarantees these columns exist and have the expected types.
    const results = rows.map((row, index) => ({
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
      heading_context: (row.heading_context as string | null) ?? null,
      section_path: (row.section_path as string | null) ?? null,
      content_types: (row.content_types as string | null) ?? null,
      is_atomic: !!(row.is_atomic as number),
      page_range: (row.page_range as string | null) ?? null,
      heading_level: (row.heading_level as number | null) ?? null,
      ocr_quality_score: qualityBoost ? ((row.ocr_quality_score as number | null) ?? null) : undefined,
    }));

    // Apply quality boost post-query: multiply bm25_score by quality factor
    if (qualityBoost) {
      for (const r of results) {
        const qualityFactor = 1 + (r.ocr_quality_score ?? 3) / 10.0;
        r.bm25_score = r.bm25_score * qualityFactor;
      }
      // Re-sort by boosted score and re-rank
      results.sort((a, b) => b.bm25_score - a.bm25_score);
      for (let i = 0; i < results.length; i++) {
        results[i].rank = i + 1;
      }
    }

    return results;
  }

  /**
   * Search VLM description embeddings using FTS5
   * Queries vlm_fts JOIN embeddings JOIN images JOIN documents
   *
   * NOTE: VLM results only support page_range_filter from chunk filters
   * (VLM embeddings don't have heading_context, section_path, etc.)
   */
  searchVLM(options: BM25SearchOptions): BM25SearchResult[] {
    const {
      query,
      limit = 10,
      phraseSearch = false,
      documentFilter,
      includeHighlight = true,
      pageRangeFilter,
      qualityBoost = false,
    } = options;

    if (!query || query.trim().length === 0) {
      throw new Error('BM25 search query cannot be empty');
    }

    // Check if vlm_fts table exists (v6+ only)
    const vlmFtsExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'")
      .get();
    if (!vlmFtsExists) return [];

    const ftsQuery = phraseSearch ? `"${query.replace(/"/g, '""')}"` : sanitizeFTS5Query(query);

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
        ${qualityBoost ? ', (SELECT o.parse_quality_score FROM ocr_results o WHERE o.document_id = e.document_id ORDER BY o.processing_completed_at DESC LIMIT 1) AS ocr_quality_score' : ''}
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

    // VLM only supports page_range_filter (no heading/section/content_type)
    if (pageRangeFilter) {
      if (pageRangeFilter.min_page !== undefined) {
        sql += ' AND e.page_number >= ?';
        params.push(pageRangeFilter.min_page);
      }
      if (pageRangeFilter.max_page !== undefined) {
        sql += ' AND e.page_number <= ?';
        params.push(pageRangeFilter.max_page);
      }
    }

    sql += ` ORDER BY bm25(vlm_fts) LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    const results = rows.map((row, index) => ({
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
      ocr_quality_score: qualityBoost ? ((row.ocr_quality_score as number | null) ?? null) : undefined,
    }));

    // Apply quality boost post-query
    if (qualityBoost) {
      for (const r of results) {
        const qualityFactor = 1 + (r.ocr_quality_score ?? 3) / 10.0;
        r.bm25_score = r.bm25_score * qualityFactor;
      }
      results.sort((a, b) => b.bm25_score - a.bm25_score);
      for (let i = 0; i < results.length; i++) {
        results[i].rank = i + 1;
      }
    }

    return results;
  }

  /**
   * Search extraction content using FTS5
   * Queries extractions_fts JOIN extractions JOIN documents
   *
   * NOTE: Extractions don't have page numbers or chunk metadata,
   * so chunkFilter and pageRangeFilter are not applied here.
   * Only qualityBoost is supported.
   */
  searchExtractions(options: BM25SearchOptions): BM25SearchResult[] {
    const {
      query,
      limit = 10,
      phraseSearch = false,
      documentFilter,
      includeHighlight = true,
      qualityBoost = false,
    } = options;

    if (!query || query.trim().length === 0) {
      throw new Error('BM25 search query cannot be empty');
    }

    // Check if extractions_fts table exists (v9+ only)
    const ftsExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extractions_fts'")
      .get();
    if (!ftsExists) return [];

    const ftsQuery = phraseSearch ? `"${query.replace(/"/g, '""')}"` : sanitizeFTS5Query(query);

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
        ${qualityBoost ? ', (SELECT o.parse_quality_score FROM ocr_results o WHERE o.document_id = ex.document_id ORDER BY o.processing_completed_at DESC LIMIT 1) AS ocr_quality_score' : ''}
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

    const results = rows.map((row, index) => ({
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
      ocr_quality_score: qualityBoost ? ((row.ocr_quality_score as number | null) ?? null) : undefined,
    }));

    // Apply quality boost post-query
    if (qualityBoost) {
      for (const r of results) {
        const qualityFactor = 1 + (r.ocr_quality_score ?? 3) / 10.0;
        r.bm25_score = r.bm25_score * qualityFactor;
      }
      results.sort((a, b) => b.bm25_score - a.bm25_score);
      for (let i = 0; i < results.length; i++) {
        results[i].rank = i + 1;
      }
    }

    return results;
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

    this.db
      .prepare(
        `
      INSERT INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (1, ?, ?, 'porter unicode61', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_rebuild_at = excluded.last_rebuild_at,
        chunks_indexed = excluded.chunks_indexed,
        content_hash = excluded.content_hash
    `
      )
      .run(now, count.cnt, SCHEMA_VERSION, contentHash);

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
    const vlmFtsExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'")
      .get();
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

    const count = this.db
      .prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL')
      .get() as { cnt: number };

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (2, ?, ?, 'porter unicode61', ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        last_rebuild_at = excluded.last_rebuild_at,
        chunks_indexed = excluded.chunks_indexed
    `
      )
      .run(now, count.cnt, SCHEMA_VERSION);

    return {
      vlm_indexed: count.cnt,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Rebuild extractions FTS index
   */
  rebuildExtractionIndex(): { extractions_indexed: number; duration_ms: number } {
    const ftsExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extractions_fts'")
      .get();
    if (!ftsExists) return { extractions_indexed: 0, duration_ms: 0 };

    const start = Date.now();

    this.db.exec("INSERT INTO extractions_fts(extractions_fts) VALUES('rebuild')");

    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM extractions').get() as {
      cnt: number;
    };

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (3, ?, ?, 'porter unicode61', ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        last_rebuild_at = excluded.last_rebuild_at,
        chunks_indexed = excluded.chunks_indexed
    `
      )
      .run(now, count.cnt, SCHEMA_VERSION);

    return {
      extractions_indexed: count.cnt,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Check whether all expected FTS triggers exist for a given set of trigger names.
   * If all triggers are present, the FTS index is kept in sync atomically and cannot be stale.
   * If any trigger is missing, the index IS stale (triggers are the sync mechanism).
   */
  private checkTriggersExist(triggerNames: string[]): boolean {
    if (triggerNames.length === 0) return true;
    const placeholders = triggerNames.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='trigger' AND name IN (${placeholders})`
      )
      .get(...triggerNames) as { cnt: number };
    return row.cnt === triggerNames.length;
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
    const meta = this.db.prepare('SELECT * FROM fts_index_metadata WHERE id = 1').get() as
      | {
          chunks_indexed: number;
          last_rebuild_at: string | null;
          tokenizer: string;
          content_hash: string | null;
        }
      | undefined;

    if (!meta) {
      throw new Error(
        'FTS index metadata not found. Database migration to v4 may not have completed.'
      );
    }

    const chunkCount = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }
    ).cnt;

    // L-7 fix: Stale detection via trigger existence, not count comparison.
    // FTS is maintained by triggers that fire atomically on INSERT/DELETE/UPDATE.
    // If all triggers exist, the index is in sync by definition.
    // If any trigger is missing, the index IS stale (sync mechanism is broken).
    const chunksTriggersOk = this.checkTriggersExist([
      'chunks_fts_ai', 'chunks_fts_ad', 'chunks_fts_au',
    ]);

    // Get VLM FTS metadata (id=2) if it exists
    const vlmMeta = this.db.prepare('SELECT * FROM fts_index_metadata WHERE id = 2').get() as
      | {
          chunks_indexed: number;
          last_rebuild_at: string | null;
        }
      | undefined;

    const vlmCount = (
      this.db
        .prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL')
        .get() as { cnt: number }
    ).cnt;

    const vlmIndexed = vlmMeta?.chunks_indexed ?? 0;

    const vlmTriggersOk = this.checkTriggersExist([
      'vlm_fts_ai', 'vlm_fts_ad', 'vlm_fts_au',
    ]);

    // Get extraction FTS metadata (id=3) if it exists
    const extractionMeta = this.db
      .prepare('SELECT * FROM fts_index_metadata WHERE id = 3')
      .get() as
      | {
          chunks_indexed: number;
          last_rebuild_at: string | null;
        }
      | undefined;

    const extractionCount = (() => {
      try {
        return (this.db.prepare('SELECT COUNT(*) as cnt FROM extractions').get() as { cnt: number })
          .cnt;
      } catch (error) {
        console.error(`[BM25] Failed to count extractions: ${String(error)}`);
        return 0;
      }
    })();

    const extractionsIndexed = extractionMeta?.chunks_indexed ?? 0;

    const extractionTriggersOk = this.checkTriggersExist([
      'extractions_fts_ai', 'extractions_fts_ad', 'extractions_fts_au',
    ]);

    return {
      ...meta,
      current_chunk_count: chunkCount,
      index_stale: !chunksTriggersOk,
      vlm_indexed: vlmIndexed,
      current_vlm_count: vlmCount,
      vlm_index_stale: !vlmTriggersOk,
      vlm_last_rebuild_at: vlmMeta?.last_rebuild_at ?? null,
      extractions_indexed: extractionsIndexed,
      current_extraction_count: extractionCount,
      extraction_index_stale: !extractionTriggersOk,
      extraction_last_rebuild_at: extractionMeta?.last_rebuild_at ?? null,
    };
  }

  private computeContentHash(): string {
    return computeFTSContentHash(this.db);
  }
}

/**
 * Sanitize a user-provided query for safe use in FTS5 MATCH expressions.
 *
 * - Preserves FTS5 boolean operators (AND, OR, NOT)
 * - Treats hyphens as word separators (matching unicode61 tokenizer)
 * - Strips all FTS5 metacharacters (' " ( ) * : ^ ~ + etc.)
 * - Inserts implicit AND between consecutive non-operator tokens
 * - Strips leading/trailing/consecutive operators
 *
 * This is the SINGLE authoritative FTS5 sanitizer for the entire codebase.
 *
 * @param query - Raw user query string
 * @returns Sanitized FTS5 query string
 * @throws Error if query contains no valid tokens after sanitization
 */
export function sanitizeFTS5Query(query: string): string {
  const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT']);
  const rawTokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  for (const raw of rawTokens) {
    if (FTS5_OPERATORS.has(raw.toUpperCase())) {
      result.push(raw.toUpperCase());
    } else {
      // L-5: Treat hyphens as word separators (matching FTS5 unicode61 tokenizer)
      const parts = raw
        .split(/-/)
        .map((p) => p.replace(/['"()*:^~+{}[\]\\;@<>#!$%&|,./`?]/g, ''))
        .filter((p) => p.length > 0);
      result.push(...parts);
    }
  }

  // Strip leading/trailing operators and consecutive operators
  while (result.length > 0 && FTS5_OPERATORS.has(result[0])) result.shift();
  while (result.length > 0 && FTS5_OPERATORS.has(result[result.length - 1])) result.pop();
  const cleaned: string[] = [];
  for (const t of result) {
    if (
      FTS5_OPERATORS.has(t) &&
      cleaned.length > 0 &&
      FTS5_OPERATORS.has(cleaned[cleaned.length - 1])
    )
      continue;
    cleaned.push(t);
  }

  const finalTokens = cleaned.filter((t) => t.length > 0);
  if (finalTokens.length === 0) {
    throw new Error('Query contains no valid search tokens after sanitization');
  }

  // Insert implicit AND between consecutive non-operator tokens
  const parts: string[] = [];
  for (let i = 0; i < finalTokens.length; i++) {
    parts.push(finalTokens[i]);
    if (
      i < finalTokens.length - 1 &&
      !FTS5_OPERATORS.has(finalTokens[i]) &&
      !FTS5_OPERATORS.has(finalTokens[i + 1])
    ) {
      parts.push('AND');
    }
  }

  return parts.join(' ');
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
