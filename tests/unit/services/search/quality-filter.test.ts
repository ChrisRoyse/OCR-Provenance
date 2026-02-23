/**
 * Unit Tests for QW-2: Quality-Filtered Search
 *
 * Tests the resolveQualityFilter function integrated into all 3 search handlers.
 * Uses real SQLite databases with synthetic data via actual DB operations.
 *
 * @module tests/unit/services/search/quality-filter
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { handleSearchUnified } from '../../../../src/tools/search.js';

// Wrapper that routes through the unified handler with keyword mode
const handleSearch = (params: Record<string, unknown>) =>
  handleSearchUnified({ ...params, mode: 'keyword' });
import { state, resetState, updateConfig, clearDatabase } from '../../../../src/server/state.js';
import { DatabaseService } from '../../../../src/services/storage/database/index.js';
import { BM25SearchService } from '../../../../src/services/search/bm25.js';
import { computeHash } from '../../../../src/utils/hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { category: string; message: string };
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* */
  }
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

function createUniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTempDir(dir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function insertDocWithQuality(
  db: DatabaseService,
  qualityScore: number | null,
  chunkText: string
): { docId: string; chunkId: string } {
  const docId = uuidv4();
  const provId = uuidv4();
  const ocrProvId = uuidv4();
  const chunkProvId = uuidv4();
  const ocrResultId = uuidv4();
  const chunkId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(docId);
  const textHash = computeHash(chunkText);

  db.insertProvenance({
    id: provId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: `/tmp/test-${docId}.pdf`,
    source_id: null,
    root_document_id: provId,
    location: null,
    content_hash: fileHash,
    input_hash: null,
    file_hash: fileHash,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });
  db.insertDocument({
    id: docId,
    file_path: `/tmp/test-${docId}.pdf`,
    file_name: `test-${docId}.pdf`,
    file_hash: fileHash,
    file_size: 1000,
    file_type: 'pdf',
    status: 'complete',
    page_count: 1,
    provenance_id: provId,
    error_message: null,
    ocr_completed_at: now,
  });
  db.insertProvenance({
    id: ocrProvId,
    type: 'OCR_RESULT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'OCR',
    source_path: null,
    source_id: provId,
    root_document_id: provId,
    location: null,
    content_hash: textHash,
    input_hash: null,
    file_hash: null,
    processor: 'datalab',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: qualityScore,
    parent_id: provId,
    parent_ids: JSON.stringify([provId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });
  db.insertOCRResult({
    id: ocrResultId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: chunkText,
    text_length: chunkText.length,
    datalab_request_id: `test-${uuidv4()}`,
    datalab_mode: 'balanced',
    parse_quality_score: qualityScore,
    page_count: 1,
    cost_cents: 0,
    content_hash: textHash,
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 100,
  });
  db.insertProvenance({
    id: chunkProvId,
    type: 'CHUNK',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'CHUNKING',
    source_path: null,
    source_id: ocrProvId,
    root_document_id: provId,
    location: null,
    content_hash: textHash,
    input_hash: null,
    file_hash: null,
    processor: 'chunker',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: ocrProvId,
    parent_ids: JSON.stringify([provId, ocrProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
  });
  db.insertChunk({
    id: chunkId,
    document_id: docId,
    ocr_result_id: ocrResultId,
    text: chunkText,
    text_hash: textHash,
    chunk_index: 0,
    character_start: 0,
    character_end: chunkText.length,
    page_number: 1,
    page_range: null,
    overlap_previous: 0,
    overlap_next: 0,
    provenance_id: chunkProvId,
  });

  return { docId, chunkId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('QW-2: Quality-Filtered Search', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('qw2-quality-filter-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('qw2');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)(
    'should return all results when min_quality_score is not set',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithQuality(db, 1.0, 'low quality document about apples');
      insertDocWithQuality(db, 4.5, 'high quality document about apples');

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      const response = await handleSearch({ query: 'apples', limit: 10 });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.total).toBe(2);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should filter out low-quality documents with min_quality_score',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithQuality(db, 1.0, 'low quality document about bananas');
      const { docId: highDoc } = insertDocWithQuality(
        db,
        4.5,
        'high quality document about bananas'
      );

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      const response = await handleSearch({ query: 'bananas', limit: 10, filters: { min_quality_score: 3.0 } });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.total).toBe(1);
      const results = parsed.data!.results as Array<Record<string, unknown>>;
      expect(results[0].document_id).toBe(highDoc);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return empty results when no documents meet quality threshold',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithQuality(db, 1.0, 'poor quality document about oranges');
      insertDocWithQuality(db, 1.5, 'poor quality document about oranges and more');

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      const response = await handleSearch({ query: 'oranges', limit: 10, filters: { min_quality_score: 4.0 } });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.total).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)('should handle quality score at exact boundary', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const { docId: exactDoc } = insertDocWithQuality(
      db,
      3.0,
      'boundary quality document about grapes'
    );
    insertDocWithQuality(db, 2.9, 'just below boundary document about grapes');

    const bm25 = new BM25SearchService(db.getConnection());
    bm25.rebuildIndex();

    const response = await handleSearch({ query: 'grapes', limit: 10, filters: { min_quality_score: 3.0 } });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.total).toBe(1);
    const results = parsed.data!.results as Array<Record<string, unknown>>;
    expect(results[0].document_id).toBe(exactDoc);
  });

  it.skipIf(!sqliteVecAvailable)(
    'should reject min_quality_score of 0 (minimum is 0.01)',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithQuality(db, 0.5, 'very low quality document about pears');
      insertDocWithQuality(db, 4.0, 'high quality document about pears');

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      // min_quality_score=0 is now rejected by Zod (minimum 0.01) to avoid
      // ambiguity between "no filter" and "quality >= 0" (M-4 fix)
      const response = await handleSearch({ query: 'pears', limit: 10, filters: { min_quality_score: 0 } });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(false);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should combine min_quality_score with document_filter',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const { docId: doc1 } = insertDocWithQuality(db, 4.0, 'high quality cherry document');
      insertDocWithQuality(db, 4.5, 'higher quality cherry document');

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      const response = await handleSearch({
        query: 'cherry',
        limit: 10,
        filters: {
          min_quality_score: 3.0,
          document_filter: [doc1],
        },
      });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.total).toBe(1);
      const results = parsed.data!.results as Array<Record<string, unknown>>;
      expect(results[0].document_id).toBe(doc1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should handle documents with no OCR quality score (null)',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // null quality score doc
      insertDocWithQuality(db, null, 'document with null quality about mangos');

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      const response = await handleSearch({ query: 'mangos', limit: 10, filters: { min_quality_score: 1.0 } });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      // NULL quality score excluded by WHERE >= ? (NULL comparisons return false)
      expect(parsed.data!.total).toBe(0);
    }
  );
});
