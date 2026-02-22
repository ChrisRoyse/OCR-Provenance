/**
 * Unit Tests for Search Result Export (ocr_search_export)
 *
 * Tests the handleSearchExport handler in src/tools/search.ts.
 * Uses real SQLite databases with BM25 data to test the BM25 export path.
 *
 * @module tests/unit/tools/search-export
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { searchTools } from '../../../src/tools/search.js';
import { state, resetState, updateConfig, clearDatabase } from '../../../src/server/state.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { BM25SearchService } from '../../../src/services/search/bm25.js';
import { computeHash } from '../../../src/utils/hash.js';

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

const handleSearchExport = searchTools['ocr_search_export'].handler;

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function insertSearchableDoc(
  db: DatabaseService,
  chunkText: string,
  fileName: string
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
    source_path: `/tmp/${fileName}`,
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
    file_path: `/tmp/${fileName}`,
    file_name: fileName,
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
    processing_quality_score: null,
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
    parse_quality_score: 4.0,
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

describe('Search Result Export (ocr_search_export)', () => {
  let tempDir: string;
  let dbName: string;
  let outputDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('qw5-search-export-');
    tempDirs.push(tempDir);
    outputDir = join(tempDir, 'exports');
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('qw5');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('should have ocr_search_export in searchTools', () => {
    expect(searchTools['ocr_search_export']).toBeDefined();
    expect(searchTools['ocr_search_export'].description).toContain('export search results');
  });

  it.skipIf(!sqliteVecAvailable)('should export BM25 results to CSV', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertSearchableDoc(db, 'document about quantum computing and physics', 'quantum.pdf');
    insertSearchableDoc(db, 'another document about quantum mechanics', 'mechanics.pdf');

    const bm25 = new BM25SearchService(db.getConnection());
    bm25.rebuildIndex();

    const csvPath = join(outputDir, 'results.csv');
    const response = await handleSearchExport({
      query: 'quantum',
      search_type: 'bm25',
      limit: 10,
      format: 'csv',
      output_path: csvPath,
      include_text: true,
    });

    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.output_path).toBe(csvPath);
    expect(parsed.data!.format).toBe('csv');
    expect(parsed.data!.result_count).toBe(2);
    expect(parsed.data!.search_type).toBe('bm25');

    expect(existsSync(csvPath)).toBe(true);
    const csvContent = readFileSync(csvPath, 'utf-8');
    const lines = csvContent.split('\n');

    // Header + 2 data rows
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('"document_id","source_file","page_number","score","result_type","text"');
  });

  it.skipIf(!sqliteVecAvailable)('should export BM25 results to JSON', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertSearchableDoc(db, 'document about artificial intelligence', 'ai.pdf');

    const bm25 = new BM25SearchService(db.getConnection());
    bm25.rebuildIndex();

    const jsonPath = join(outputDir, 'results.json');
    const response = await handleSearchExport({
      query: 'artificial intelligence',
      search_type: 'bm25',
      limit: 10,
      format: 'json',
      output_path: jsonPath,
      include_text: true,
    });

    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.format).toBe('json');
    expect(parsed.data!.result_count).toBe(1);

    expect(existsSync(jsonPath)).toBe(true);
    const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(jsonContent.results).toBeDefined();
    expect(Array.isArray(jsonContent.results)).toBe(true);
    expect(jsonContent.results.length).toBe(1);
    expect(jsonContent.results[0].document_id).toBeDefined();
    expect(jsonContent.results[0].text).toContain('artificial intelligence');
  });

  it.skipIf(!sqliteVecAvailable)(
    'should export CSV without text when include_text is false',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertSearchableDoc(db, 'document about neural networks', 'neural.pdf');

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      const csvPath = join(outputDir, 'no-text.csv');
      const response = await handleSearchExport({
        query: 'neural',
        search_type: 'bm25',
        limit: 10,
        format: 'csv',
        output_path: csvPath,
        include_text: false,
      });

      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const csvContent = readFileSync(csvPath, 'utf-8');
      const lines = csvContent.split('\n');
      expect(lines[0]).toBe('"document_id","source_file","page_number","score","result_type"');
    }
  );

  it.skipIf(!sqliteVecAvailable)('should export empty results gracefully', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const bm25 = new BM25SearchService(db.getConnection());
    bm25.rebuildIndex();

    const csvPath = join(outputDir, 'empty.csv');
    const response = await handleSearchExport({
      query: 'nonexistent',
      search_type: 'bm25',
      limit: 10,
      format: 'csv',
      output_path: csvPath,
    });

    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.result_count).toBe(0);

    const csvContent = readFileSync(csvPath, 'utf-8');
    const lines = csvContent.split('\n');
    expect(lines.length).toBe(1); // Just header
  });

  it.skipIf(!sqliteVecAvailable)(
    'should create output directory if it does not exist',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertSearchableDoc(db, 'document about deep learning', 'deep.pdf');

      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      const nestedDir = join(outputDir, 'nested', 'dir');
      const csvPath = join(nestedDir, 'results.csv');

      expect(existsSync(nestedDir)).toBe(false);

      const response = await handleSearchExport({
        query: 'deep learning',
        search_type: 'bm25',
        limit: 10,
        format: 'csv',
        output_path: csvPath,
      });

      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      expect(existsSync(csvPath)).toBe(true);
    }
  );

  it.skipIf(!sqliteVecAvailable)('should handle JSON export without text', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertSearchableDoc(db, 'document about machine learning algorithms', 'ml.pdf');

    const bm25 = new BM25SearchService(db.getConnection());
    bm25.rebuildIndex();

    const jsonPath = join(outputDir, 'no-text.json');
    const response = await handleSearchExport({
      query: 'machine learning',
      search_type: 'bm25',
      limit: 10,
      format: 'json',
      output_path: jsonPath,
      include_text: false,
    });

    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);

    const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(jsonContent.results[0].text).toBeUndefined();
    expect(jsonContent.results[0].document_id).toBeDefined();
  });

  it.skipIf(!sqliteVecAvailable)('should validate required parameters', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Missing query
    const response = await handleSearchExport({
      output_path: '/tmp/test.csv',
    });

    const parsed = parseResponse(response);
    expect(parsed.success).toBe(false);
  });
});
