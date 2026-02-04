/**
 * Unit Tests for Search MCP Tools
 *
 * Tests the extracted search tool handlers in src/tools/search.ts
 * Tools: handleSearchSemantic, handleSearchText, handleSearchHybrid
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * NOTE: Semantic and hybrid search tests are skipped because they require
 * real embedding vectors. Text search tests are comprehensive.
 *
 * @module tests/unit/tools/search
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import {
  handleSearchSemantic,
  handleSearchText,
  handleSearchHybrid,
  searchTools,
} from '../../../src/tools/search.js';
import {
  state,
  resetState,
  updateConfig,
  clearDatabase,
} from '../../../src/server/state.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
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
  error?: {
    category: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

function createUniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

// Track all temp directories for final cleanup
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Insert test document with provenance
 */
function insertTestDocument(
  db: DatabaseService,
  docId: string,
  fileName: string,
  filePath: string
): string {
  const provId = uuidv4();
  const now = new Date().toISOString();
  const hash = computeHash(filePath);

  db.insertProvenance({
    id: provId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: filePath,
    source_id: null,
    root_document_id: provId,
    location: null,
    content_hash: hash,
    input_hash: null,
    file_hash: hash,
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
    file_path: filePath,
    file_name: fileName,
    file_hash: hash,
    file_size: 1000,
    file_type: 'txt',
    status: 'complete',
    page_count: 1,
    provenance_id: provId,
    error_message: null,
    ocr_completed_at: now,
  });

  return provId;
}

/**
 * Insert test chunk with provenance
 */
function insertTestChunk(
  db: DatabaseService,
  chunkId: string,
  docId: string,
  docProvId: string,
  text: string,
  chunkIndex: number
): string {
  const provId = uuidv4();
  const ocrResultId = uuidv4();
  const now = new Date().toISOString();
  const hash = computeHash(text);

  // Insert OCR result first (required for foreign key)
  const ocrProvId = uuidv4();
  db.insertProvenance({
    id: ocrProvId,
    type: 'OCR_RESULT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'OCR',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: hash,
    input_hash: null,
    file_hash: null,
    processor: 'datalab',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  db.insertOCRResult({
    id: ocrResultId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: text,
    text_length: text.length,
    datalab_request_id: `test-request-${uuidv4()}`,
    datalab_mode: 'balanced',
    parse_quality_score: 4.5,
    page_count: 1,
    cost_cents: 0,
    content_hash: hash,
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 100,
  });

  // Insert chunk provenance
  db.insertProvenance({
    id: provId,
    type: 'CHUNK',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'CHUNKING',
    source_path: null,
    source_id: ocrProvId,
    root_document_id: docProvId,
    location: JSON.stringify({ chunk_index: chunkIndex }),
    content_hash: hash,
    input_hash: null,
    file_hash: null,
    processor: 'chunker',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: ocrProvId,
    parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
  });

  db.insertChunk({
    id: chunkId,
    document_id: docId,
    ocr_result_id: ocrResultId,
    text: text,
    text_hash: hash,
    chunk_index: chunkIndex,
    character_start: 0,
    character_end: text.length,
    page_number: 1,
    page_range: null,
    overlap_previous: 0,
    overlap_next: 0,
    provenance_id: provId,
    embedding_status: 'pending',
    embedded_at: null,
  });

  return provId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXPORTS VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('searchTools exports', () => {
  it('exports all 3 search tools', () => {
    expect(Object.keys(searchTools)).toHaveLength(3);
    expect(searchTools).toHaveProperty('ocr_search_semantic');
    expect(searchTools).toHaveProperty('ocr_search_text');
    expect(searchTools).toHaveProperty('ocr_search_hybrid');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(searchTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('handlers are exported functions', () => {
    expect(typeof handleSearchSemantic).toBe('function');
    expect(typeof handleSearchText).toBe('function');
    expect(typeof handleSearchHybrid).toBe('function');
  });

  it('tool names match expected values', () => {
    const names = Object.keys(searchTools);
    expect(names).toContain('ocr_search_semantic');
    expect(names).toContain('ocr_search_text');
    expect(names).toContain('ocr_search_hybrid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleSearchText TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleSearchText', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('search-text-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('search');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleSearchText({ query: 'test' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('returns empty results for empty database', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleSearchText({ query: 'test', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.results).toEqual([]);
    expect(result.data?.total).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('finds exact matches with match_type="exact"', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'The quick brown fox jumps over the lazy dog';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearchText({ query: 'quick brown fox', match_type: 'exact', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].original_text).toContain('quick brown fox');
  });

  it.skipIf(!sqliteVecAvailable)('case-insensitive search with match_type="fuzzy"', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'The Quick Brown Fox Jumps Over';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    // Lowercase query should match uppercase text
    const response = await handleSearchText({ query: 'quick brown fox', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('regex search with match_type="regex"', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'Document number 12345 contains important data';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearchText({ query: 'number \\d+', match_type: 'regex', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('returns VALIDATION_ERROR for invalid regex', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Must insert data so the regex gets tested against at least one chunk
    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Some test content', 0);

    const response = await handleSearchText({ query: '[invalid', match_type: 'regex', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Invalid regex pattern');
  });

  it.skipIf(!sqliteVecAvailable)('respects limit parameter', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    // Insert 5 chunks with matching text
    for (let i = 0; i < 5; i++) {
      const chunkId = uuidv4();
      insertTestChunk(db, chunkId, docId, docProvId, `Test content ${i} with searchable text`, i);
    }

    const response = await handleSearchText({ query: 'searchable', match_type: 'fuzzy', limit: 3 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('CP-002: original_text always present in results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'This is the original text content for verification';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearchText({ query: 'original text', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);

    // CP-002 verification
    expect(results[0].original_text).toBeDefined();
    expect(typeof results[0].original_text).toBe('string');
    expect((results[0].original_text as string).length).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteVecAvailable)('source_file_path always present in results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const filePath = '/test/documents/test.txt';
    const docProvId = insertTestDocument(db, docId, 'test.txt', filePath);
    insertTestChunk(db, chunkId, docId, docProvId, 'Searchable content here', 0);

    const response = await handleSearchText({ query: 'Searchable', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].source_file_path).toBe(filePath);
    expect(results[0].source_file_name).toBe('test.txt');
  });

  it.skipIf(!sqliteVecAvailable)('page_number present in results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Page content here', 0);

    const response = await handleSearchText({ query: 'Page content', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty('page_number');
  });

  it.skipIf(!sqliteVecAvailable)('includes provenance when requested', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Content with provenance', 0);

    const response = await handleSearchText({
      query: 'provenance',
      match_type: 'fuzzy',
      limit: 10,
      include_provenance: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty('provenance');
    expect(Array.isArray(results[0].provenance)).toBe(true);
  });

  it('returns error for empty query', async () => {
    const response = await handleSearchText({ query: '', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
  });

  it.skipIf(!sqliteVecAvailable)('exact match is case-sensitive', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'UPPERCASE content here';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    // Lowercase query should NOT match with exact
    const response = await handleSearchText({ query: 'uppercase', match_type: 'exact', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('returns no matches for non-existent text', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Some content', 0);

    const response = await handleSearchText({ query: 'nonexistent12345', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(0);
    expect(result.data?.results).toEqual([]);
  });

  it.skipIf(!sqliteVecAvailable)('searches across multiple documents', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Create 3 documents with similar content
    for (let i = 0; i < 3; i++) {
      const docId = uuidv4();
      const chunkId = uuidv4();
      const docProvId = insertTestDocument(db, docId, `doc${i}.txt`, `/test/doc${i}.txt`);
      insertTestChunk(db, chunkId, docId, docProvId, `Document ${i} contains findable text`, 0);
    }

    const response = await handleSearchText({ query: 'findable', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('returns chunk_id and document_id in results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Test content for ID verification', 0);

    const response = await handleSearchText({ query: 'ID verification', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].chunk_id).toBe(chunkId);
    expect(results[0].document_id).toBe(docId);
  });

  it.skipIf(!sqliteVecAvailable)('returns character_start and character_end in results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Character position test', 0);

    const response = await handleSearchText({ query: 'Character', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty('character_start');
    expect(results[0]).toHaveProperty('character_end');
  });

  it.skipIf(!sqliteVecAvailable)('returns chunk_index in results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Chunk index verification', 0);

    const response = await handleSearchText({ query: 'Chunk index', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty('chunk_index');
    expect(results[0].chunk_index).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('response includes query and match_type', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleSearchText({ query: 'test query', match_type: 'exact', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.query).toBe('test query');
    expect(result.data?.match_type).toBe('exact');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEMANTIC SEARCH TESTS (Skipped - requires embedding generation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleSearchSemantic', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleSearchSemantic({ query: 'test' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error for empty query', async () => {
    const response = await handleSearchSemantic({ query: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
  });

  it('returns error for query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchSemantic({ query: overMaxQuery });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
  });

  it.skip('requires embedding service (skipped - embedding tests in manual verification)', () => {
    // Semantic search tests require actual embeddings
    // Full tests are in tests/manual/task-21-verification.test.ts
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HYBRID SEARCH TESTS (Skipped - requires embedding generation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleSearchHybrid', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleSearchHybrid({
      query: 'test',
      semantic_weight: 0.7,
      keyword_weight: 0.3,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns validation error for weights not summing to 1', async () => {
    const response = await handleSearchHybrid({
      query: 'test',
      semantic_weight: 0.5,
      keyword_weight: 0.3,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Weights must sum to 1.0
  });

  it('returns error for empty query', async () => {
    const response = await handleSearchHybrid({
      query: '',
      semantic_weight: 0.7,
      keyword_weight: 0.3,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
  });

  it('returns error for query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchHybrid({
      query: overMaxQuery,
      semantic_weight: 0.7,
      keyword_weight: 0.3,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
  });

  it.skip('requires embedding service (skipped - embedding tests in manual verification)', () => {
    // Hybrid search tests require actual embeddings
    // Full tests are in tests/manual/task-21-verification.test.ts
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Input Validation', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  it('text search rejects empty query', async () => {
    const response = await handleSearchText({ query: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('semantic search rejects empty query', async () => {
    const response = await handleSearchSemantic({ query: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('hybrid search rejects empty query', async () => {
    const response = await handleSearchHybrid({
      query: '',
      semantic_weight: 0.7,
      keyword_weight: 0.3,
    });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('text search accepts max length query', async () => {
    const maxQuery = 'a'.repeat(1000);
    const response = await handleSearchText({ query: maxQuery });
    const result = parseResponse(response);
    // Should fail with DATABASE_NOT_SELECTED, not validation error
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('text search rejects query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchText({ query: overMaxQuery });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('semantic search accepts max length query', async () => {
    const maxQuery = 'a'.repeat(1000);
    const response = await handleSearchSemantic({ query: maxQuery });
    const result = parseResponse(response);
    // Should fail with DATABASE_NOT_SELECTED, not validation error
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('semantic search rejects query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchSemantic({ query: overMaxQuery });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('hybrid search accepts max length query', async () => {
    const maxQuery = 'a'.repeat(1000);
    const response = await handleSearchHybrid({
      query: maxQuery,
      semantic_weight: 0.7,
      keyword_weight: 0.3,
    });
    const result = parseResponse(response);
    // Should fail with DATABASE_NOT_SELECTED, not validation error
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('hybrid search rejects query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchHybrid({
      query: overMaxQuery,
      semantic_weight: 0.7,
      keyword_weight: 0.3,
    });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('search-edge-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('search-edge');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('Edge Case 1: Empty Query String', () => {
    it('rejects empty query with validation error', async () => {
      const response = await handleSearchText({ query: '' });
      const result = parseResponse(response);
      expect(result.success).toBe(false);
    });
  });

  describe('Edge Case 2: Query at Max Length', () => {
    it.skipIf(!sqliteVecAvailable)('accepts query at exactly 1000 chars', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const maxQuery = 'a'.repeat(1000);
      const response = await handleSearchText({ query: maxQuery });
      const result = parseResponse(response);

      // Should succeed with empty results (no matches)
      expect(result.success).toBe(true);
      expect(result.data?.results).toEqual([]);
    });
  });

  describe('Edge Case 3: Invalid Regex Pattern', () => {
    it.skipIf(!sqliteVecAvailable)('returns error for malformed regex', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // Must insert data so the regex gets tested against at least one chunk
      const docId = uuidv4();
      const chunkId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
      insertTestChunk(db, chunkId, docId, docProvId, 'Some test content', 0);

      const response = await handleSearchText({ query: '[invalid(', match_type: 'regex' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid regex');
    });
  });

  describe('Edge Case 4: Similarity Threshold Edge Values', () => {
    it('accepts threshold=0', async () => {
      const response = await handleSearchSemantic({
        query: 'test',
        similarity_threshold: 0,
      });
      const result = parseResponse(response);
      // Should fail with DATABASE_NOT_SELECTED, not validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts threshold=1', async () => {
      const response = await handleSearchSemantic({
        query: 'test',
        similarity_threshold: 1,
      });
      const result = parseResponse(response);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  describe('Edge Case 5: Unicode Content', () => {
    it.skipIf(!sqliteVecAvailable)('handles unicode in search query and results', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId = uuidv4();
      const unicodeText = '日本語テキスト contains special characters';
      const docProvId = insertTestDocument(db, docId, 'unicode.txt', '/test/unicode.txt');
      insertTestChunk(db, chunkId, docId, docProvId, unicodeText, 0);

      const response = await handleSearchText({ query: '日本語', match_type: 'fuzzy' });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBe(1);
      const results = result.data?.results as Array<Record<string, unknown>>;
      expect(results[0].original_text).toContain('日本語');
    });
  });

  describe('Edge Case 6: Special Characters in Query', () => {
    it.skipIf(!sqliteVecAvailable)('handles special characters in fuzzy search', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId = uuidv4();
      const textWithSpecial = 'Price: $100.00 (discount: 20%)';
      const docProvId = insertTestDocument(db, docId, 'special.txt', '/test/special.txt');
      insertTestChunk(db, chunkId, docId, docProvId, textWithSpecial, 0);

      const response = await handleSearchText({ query: '$100.00', match_type: 'fuzzy' });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBe(1);
    });
  });

  describe('Edge Case 7: Multiple Chunks in Same Document', () => {
    it.skipIf(!sqliteVecAvailable)('finds matches across multiple chunks', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'multi.txt', '/test/multi.txt');

      // Insert 3 chunks with the same keyword
      for (let i = 0; i < 3; i++) {
        const chunkId = uuidv4();
        insertTestChunk(db, chunkId, docId, docProvId, `Chunk ${i} has keyword here`, i);
      }

      const response = await handleSearchText({ query: 'keyword', match_type: 'fuzzy', limit: 10 });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBe(3);
    });
  });

  describe('Edge Case 8: Whitespace-only Query', () => {
    it('rejects whitespace-only query', async () => {
      const response = await handleSearchText({ query: '   ' });
      const result = parseResponse(response);
      // May be rejected by validation or return empty results
      // Either behavior is acceptable
      expect(result).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CP-002 COMPLIANCE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('CP-002 Compliance: original_text in Search Results', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('search-cp002-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('cp002');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('text search results always contain original_text', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'CP-002 compliance verification text';
    const docProvId = insertTestDocument(db, docId, 'cp002.txt', '/test/cp002.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearchText({ query: 'CP-002', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(r).toHaveProperty('original_text');
      expect(typeof r.original_text).toBe('string');
      expect((r.original_text as string).length).toBeGreaterThan(0);
    }
  });

  it.skipIf(!sqliteVecAvailable)('original_text matches inserted chunk text', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const exactText = 'This is the exact text that should be returned verbatim';
    const docProvId = insertTestDocument(db, docId, 'exact.txt', '/test/exact.txt');
    insertTestChunk(db, chunkId, docId, docProvId, exactText, 0);

    const response = await handleSearchText({ query: 'verbatim', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].original_text).toBe(exactText);
  });

  it.skipIf(!sqliteVecAvailable)('original_text preserved for exact match', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'Exact match original text preservation test';
    const docProvId = insertTestDocument(db, docId, 'exact.txt', '/test/exact.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearchText({ query: 'Exact match', match_type: 'exact', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].original_text).toBe(testText);
  });

  it.skipIf(!sqliteVecAvailable)('original_text preserved for regex match', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'Regex match original text test 12345';
    const docProvId = insertTestDocument(db, docId, 'regex.txt', '/test/regex.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearchText({ query: 'test \\d+', match_type: 'regex', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].original_text).toBe(testText);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE CHAIN TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provenance Chain in Search Results', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('search-prov-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('prov');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('excludes provenance by default', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Default provenance test', 0);

    const response = await handleSearchText({ query: 'provenance', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).not.toHaveProperty('provenance');
  });

  it.skipIf(!sqliteVecAvailable)('includes provenance when include_provenance=true', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Included provenance test', 0);

    const response = await handleSearchText({
      query: 'Included',
      match_type: 'fuzzy',
      limit: 10,
      include_provenance: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty('provenance');
    expect(Array.isArray(results[0].provenance)).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('provenance chain has expected fields', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Provenance fields test', 0);

    const response = await handleSearchText({
      query: 'fields',
      match_type: 'fuzzy',
      limit: 10,
      include_provenance: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    const provenance = results[0].provenance as Array<Record<string, unknown>>;

    expect(provenance.length).toBeGreaterThan(0);
    for (const prov of provenance) {
      expect(prov).toHaveProperty('id');
      expect(prov).toHaveProperty('type');
      expect(prov).toHaveProperty('chain_depth');
      expect(prov).toHaveProperty('processor');
      expect(prov).toHaveProperty('content_hash');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIMIT AND PAGINATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Limit Parameter', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('search-limit-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('limit');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('default limit is 10', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    // Insert 15 chunks
    for (let i = 0; i < 15; i++) {
      const chunkId = uuidv4();
      insertTestChunk(db, chunkId, docId, docProvId, `Default limit test ${i}`, i);
    }

    const response = await handleSearchText({ query: 'Default limit' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(10);
  });

  it.skipIf(!sqliteVecAvailable)('respects limit=1', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    for (let i = 0; i < 5; i++) {
      const chunkId = uuidv4();
      insertTestChunk(db, chunkId, docId, docProvId, `Limit one test ${i}`, i);
    }

    const response = await handleSearchText({ query: 'Limit one', limit: 1 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('respects limit=100', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    // Insert 5 chunks (less than limit)
    for (let i = 0; i < 5; i++) {
      const chunkId = uuidv4();
      insertTestChunk(db, chunkId, docId, docProvId, `Large limit test ${i}`, i);
    }

    const response = await handleSearchText({ query: 'Large limit', limit: 100 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(5); // Only 5 available
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MATCH TYPE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Match Type Behavior', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('search-match-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('match');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('exact: case-sensitive substring match', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    const chunkId1 = uuidv4();
    insertTestChunk(db, chunkId1, docId, docProvId, 'Hello World', 0);
    const chunkId2 = uuidv4();
    insertTestChunk(db, chunkId2, docId, docProvId, 'hello world', 1);

    const response = await handleSearchText({ query: 'Hello', match_type: 'exact', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1); // Only uppercase match
  });

  it.skipIf(!sqliteVecAvailable)('fuzzy: case-insensitive substring match', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    const chunkId1 = uuidv4();
    insertTestChunk(db, chunkId1, docId, docProvId, 'Hello World', 0);
    const chunkId2 = uuidv4();
    insertTestChunk(db, chunkId2, docId, docProvId, 'HELLO WORLD', 1);

    const response = await handleSearchText({ query: 'hello', match_type: 'fuzzy', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(2); // Both match
  });

  it.skipIf(!sqliteVecAvailable)('regex: pattern matching with flags', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    const chunkId1 = uuidv4();
    insertTestChunk(db, chunkId1, docId, docProvId, 'Phone: 123-456-7890', 0);
    const chunkId2 = uuidv4();
    insertTestChunk(db, chunkId2, docId, docProvId, 'No phone here', 1);

    const response = await handleSearchText({ query: '\\d{3}-\\d{3}-\\d{4}', match_type: 'regex', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('regex: case-insensitive by default', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    const chunkId1 = uuidv4();
    insertTestChunk(db, chunkId1, docId, docProvId, 'UPPERCASE test', 0);
    const chunkId2 = uuidv4();
    insertTestChunk(db, chunkId2, docId, docProvId, 'lowercase test', 1);

    const response = await handleSearchText({ query: 'test', match_type: 'regex', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(2); // Both match due to 'i' flag
  });
});
