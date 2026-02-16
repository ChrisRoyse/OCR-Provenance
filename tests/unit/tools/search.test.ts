/**
 * Unit Tests for Search MCP Tools
 *
 * Tests the extracted search tool handlers in src/tools/search.ts
 * Tools: handleSearchSemantic, handleSearch, handleSearchHybrid, handleFTSManage
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 * Uses real GPU embeddings (nomic-embed-text-v1.5) for semantic/hybrid search tests.
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
  handleSearch,
  handleSearchHybrid,
  handleFTSManage,
  searchTools,
} from '../../../src/tools/search.js';
import { state, resetState, updateConfig, clearDatabase } from '../../../src/server/state.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { VectorService } from '../../../src/services/storage/vector.js';
import {
  EmbeddingService,
  resetEmbeddingService,
} from '../../../src/services/embedding/embedder.js';
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
  it('exports all 8 search tools', () => {
    expect(Object.keys(searchTools)).toHaveLength(8);
    expect(searchTools).toHaveProperty('ocr_search');
    expect(searchTools).toHaveProperty('ocr_search_semantic');
    expect(searchTools).toHaveProperty('ocr_search_hybrid');
    expect(searchTools).toHaveProperty('ocr_fts_manage');
    expect(searchTools).toHaveProperty('ocr_search_export');
    expect(searchTools).toHaveProperty('ocr_benchmark_compare');
    expect(searchTools).toHaveProperty('ocr_related_documents');
    expect(searchTools).toHaveProperty('ocr_rag_context');
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
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleSearch TESTS (BM25 keyword search)
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleSearch', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('search-bm25-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('search');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleSearch({ query: 'test' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('returns empty results for empty database', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleSearch({ query: 'test', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.results).toEqual([]);
    expect(result.data?.total).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('finds keyword matches', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'The quick brown fox jumps over the lazy dog';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearch({ query: 'quick brown fox', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].original_text).toContain('quick brown fox');
  });

  it.skipIf(!sqliteVecAvailable)('case-insensitive search via BM25 tokenizer', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'The Quick Brown Fox Jumps Over';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    // Lowercase query should match uppercase text via FTS5 unicode61 tokenizer
    const response = await handleSearch({ query: 'quick brown fox', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(1);
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

    const response = await handleSearch({ query: 'searchable', limit: 3 });
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

    const response = await handleSearch({ query: 'original text', limit: 10 });
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

    const response = await handleSearch({ query: 'Searchable', limit: 10 });
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

    const response = await handleSearch({ query: 'Page content', limit: 10 });
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

    const response = await handleSearch({
      query: 'provenance',
      limit: 10,
      include_provenance: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty('provenance_chain');
    expect(Array.isArray(results[0].provenance_chain)).toBe(true);
  });

  it('returns error for empty query', async () => {
    const response = await handleSearch({ query: '', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it.skipIf(!sqliteVecAvailable)('returns no matches for non-existent text', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Some content', 0);

    const response = await handleSearch({ query: 'nonexistent12345', limit: 10 });
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

    const response = await handleSearch({ query: 'findable', limit: 10 });
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

    const response = await handleSearch({ query: 'ID verification', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].chunk_id).toBe(chunkId);
    expect(results[0].document_id).toBe(docId);
  });

  it.skipIf(!sqliteVecAvailable)(
    'returns character_start and character_end in results',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
      insertTestChunk(db, chunkId, docId, docProvId, 'Character position test', 0);

      const response = await handleSearch({ query: 'Character', limit: 10 });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;
      expect(results[0]).toHaveProperty('character_start');
      expect(results[0]).toHaveProperty('character_end');
    }
  );

  it.skipIf(!sqliteVecAvailable)('returns chunk_index in results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Chunk index verification', 0);

    const response = await handleSearch({ query: 'Chunk index', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty('chunk_index');
    expect(results[0].chunk_index).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('response includes query and search_type', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleSearch({ query: 'test query', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.query).toBe('test query');
    expect(result.data?.search_type).toBe('bm25');
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
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error for query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchSemantic({ query: overMaxQuery });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it.skipIf(!sqliteVecAvailable)(
    'finds semantically similar chunks with real embeddings',
    async () => {
      const tempDir = createTempDir('search-semantic-embed-');
      tempDirs.push(tempDir);
      updateConfig({ defaultStoragePath: tempDir });
      const dbName = createUniqueName('semantic');

      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId1 = uuidv4();
      const chunkId2 = uuidv4();
      const text1 =
        'The patient was diagnosed with severe hypertension and prescribed medication for blood pressure management.';
      const text2 =
        'Financial quarterly report shows increased revenue and profit margins for the fiscal year.';

      const docProvId = insertTestDocument(db, docId, 'medical.txt', '/test/medical.txt');
      const _chunkProvId1 = insertTestChunk(db, chunkId1, docId, docProvId, text1, 0);
      const _chunkProvId2 = insertTestChunk(db, chunkId2, docId, docProvId, text2, 1);

      // Generate real embeddings using GPU
      const embedder = new EmbeddingService();
      const vector = new VectorService(db.getConnection());
      const chunks = db.getChunksByDocumentId(docId);

      await embedder.embedDocumentChunks(db, vector, chunks, {
        documentId: docId,
        filePath: '/test/medical.txt',
        fileName: 'medical.txt',
        fileHash: computeHash('/test/medical.txt'),
        documentProvenanceId: docProvId,
      });

      // Search for medical content — should rank medical chunk higher
      const response = await handleSearchSemantic({
        query: 'hypertension blood pressure treatment',
        limit: 10,
        similarity_threshold: 0.3,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBeGreaterThan(0);

      const results = result.data?.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThan(0);

      // CP-002: original_text always present
      expect(results[0].original_text).toBeTruthy();
      expect(typeof results[0].similarity_score).toBe('number');

      // Medical chunk should be the top result for a medical query
      expect(results[0].original_text).toContain('hypertension');

      resetEmbeddingService();
    },
    120000
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// HYBRID SEARCH TESTS (RRF-based BM25 + semantic)
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
      bm25_weight: 1.0,
      semantic_weight: 1.0,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error for empty query', async () => {
    const response = await handleSearchHybrid({
      query: '',
      bm25_weight: 1.0,
      semantic_weight: 1.0,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error for query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchHybrid({
      query: overMaxQuery,
      bm25_weight: 1.0,
      semantic_weight: 1.0,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it.skipIf(!sqliteVecAvailable)(
    'combines BM25 and semantic results with real embeddings',
    async () => {
      const tempDir = createTempDir('search-hybrid-embed-');
      tempDirs.push(tempDir);
      updateConfig({ defaultStoragePath: tempDir });
      const dbName = createUniqueName('hybrid');

      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId1 = uuidv4();
      const chunkId2 = uuidv4();
      const text1 =
        'The contract stipulates that all parties must agree to the terms and conditions before signing.';
      const text2 =
        'Laboratory analysis confirmed the presence of elevated biomarkers in the blood sample results.';

      const docProvId = insertTestDocument(db, docId, 'legal.txt', '/test/legal.txt');
      insertTestChunk(db, chunkId1, docId, docProvId, text1, 0);
      insertTestChunk(db, chunkId2, docId, docProvId, text2, 1);

      // Generate real embeddings using GPU
      const embedder = new EmbeddingService();
      const vector = new VectorService(db.getConnection());
      const chunks = db.getChunksByDocumentId(docId);

      await embedder.embedDocumentChunks(db, vector, chunks, {
        documentId: docId,
        filePath: '/test/legal.txt',
        fileName: 'legal.txt',
        fileHash: computeHash('/test/legal.txt'),
        documentProvenanceId: docProvId,
      });

      // Rebuild FTS index to ensure BM25 picks up newly inserted chunks
      const bm25 = new BM25SearchService(db.getConnection());
      bm25.rebuildIndex();

      // Hybrid search — both BM25 and semantic should find results
      const response = await handleSearchHybrid({
        query: 'contract terms conditions',
        limit: 10,
        bm25_weight: 1.0,
        semantic_weight: 1.0,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.search_type).toBe('rrf_hybrid');
      expect(result.data?.total).toBeGreaterThan(0);

      const results = result.data?.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThan(0);

      // CP-002: original_text always present
      expect(results[0].original_text).toBeTruthy();

      // Should have source counts from both search types
      const sources = result.data?.sources as Record<string, number>;
      expect(sources.bm25_chunk_count).toBeGreaterThan(0);
      expect(sources.semantic_count).toBeGreaterThan(0);

      // Contract chunk should rank first for a contract-related query
      expect(results[0].original_text).toContain('contract');

      resetEmbeddingService();
    },
    120000
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleFTSManage TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleFTSManage', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleFTSManage({ action: 'status' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error for missing action', async () => {
    const response = await handleFTSManage({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error for invalid action', async () => {
    const response = await handleFTSManage({ action: 'invalid' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
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

  it('BM25 search rejects empty query', async () => {
    const response = await handleSearch({ query: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('semantic search rejects empty query', async () => {
    const response = await handleSearchSemantic({ query: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('hybrid search rejects empty query', async () => {
    const response = await handleSearchHybrid({
      query: '',
      bm25_weight: 1.0,
      semantic_weight: 1.0,
    });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('BM25 search accepts max length query', async () => {
    const maxQuery = 'a'.repeat(1000);
    const response = await handleSearch({ query: maxQuery });
    const result = parseResponse(response);
    // Should fail with DATABASE_NOT_SELECTED, not validation error
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('BM25 search rejects query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearch({ query: overMaxQuery });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
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
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('hybrid search accepts max length query', async () => {
    const maxQuery = 'a'.repeat(1000);
    const response = await handleSearchHybrid({
      query: maxQuery,
      bm25_weight: 1.0,
      semantic_weight: 1.0,
    });
    const result = parseResponse(response);
    // Should fail with DATABASE_NOT_SELECTED, not validation error
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('hybrid search rejects query over max length', async () => {
    const overMaxQuery = 'a'.repeat(1001);
    const response = await handleSearchHybrid({
      query: overMaxQuery,
      bm25_weight: 1.0,
      semantic_weight: 1.0,
    });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
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
      const response = await handleSearch({ query: '' });
      const result = parseResponse(response);
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });
  });

  describe('Edge Case 2: Query at Max Length', () => {
    it.skipIf(!sqliteVecAvailable)('accepts query at exactly 1000 chars', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const maxQuery = 'a'.repeat(1000);
      const response = await handleSearch({ query: maxQuery });
      const result = parseResponse(response);

      // Should succeed with empty results (no matches)
      expect(result.success).toBe(true);
      expect(result.data?.results).toEqual([]);
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
    it.skipIf(!sqliteVecAvailable)('handles unicode in search query without error', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId = uuidv4();
      const unicodeText = '日本語テキスト contains special characters';
      const docProvId = insertTestDocument(db, docId, 'unicode.txt', '/test/unicode.txt');
      insertTestChunk(db, chunkId, docId, docProvId, unicodeText, 0);

      // BM25/FTS5 unicode61 tokenizer handles CJK by splitting into individual characters.
      // Search for an ASCII token that is definitely in the FTS index.
      const response = await handleSearch({ query: 'special' });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBe(1);
      const results = result.data?.results as Array<Record<string, unknown>>;
      expect(results[0].original_text).toContain('日本語');
    });
  });

  describe('Edge Case 6: Special Characters in Query', () => {
    it.skipIf(!sqliteVecAvailable)('handles special characters in BM25 search', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId = uuidv4();
      const textWithSpecial = 'Price: $100.00 (discount: 20%)';
      const docProvId = insertTestDocument(db, docId, 'special.txt', '/test/special.txt');
      insertTestChunk(db, chunkId, docId, docProvId, textWithSpecial, 0);

      const response = await handleSearch({ query: '100' });
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

      const response = await handleSearch({ query: 'keyword', limit: 10 });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBe(3);
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

  it.skipIf(!sqliteVecAvailable)('BM25 search results always contain original_text', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'CP-002 compliance verification text';
    const docProvId = insertTestDocument(db, docId, 'cp002.txt', '/test/cp002.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearch({ query: 'compliance', limit: 10 });
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

    const response = await handleSearch({ query: 'verbatim', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0].original_text).toBe(exactText);
  });

  it.skipIf(!sqliteVecAvailable)('original_text preserved for BM25 search', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const testText = 'BM25 original text preservation test';
    const docProvId = insertTestDocument(db, docId, 'bm25.txt', '/test/bm25.txt');
    insertTestChunk(db, chunkId, docId, docProvId, testText, 0);

    const response = await handleSearch({ query: 'preservation', limit: 10 });
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

  it.skipIf(!sqliteVecAvailable)('excludes provenance_chain by default', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Default provenance test', 0);

    const response = await handleSearch({ query: 'provenance', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    expect(results[0]).not.toHaveProperty('provenance_chain');
  });

  it.skipIf(!sqliteVecAvailable)(
    'includes provenance_chain when include_provenance=true',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
      insertTestChunk(db, chunkId, docId, docProvId, 'Included provenance test', 0);

      const response = await handleSearch({
        query: 'Included',
        limit: 10,
        include_provenance: true,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;
      expect(results[0]).toHaveProperty('provenance_chain');
      expect(Array.isArray(results[0].provenance_chain)).toBe(true);
    }
  );

  it.skipIf(!sqliteVecAvailable)('provenance_chain has expected fields', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, chunkId, docId, docProvId, 'Provenance fields test', 0);

    const response = await handleSearch({
      query: 'fields',
      limit: 10,
      include_provenance: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const results = result.data?.results as Array<Record<string, unknown>>;
    const provenance = results[0].provenance_chain as Array<Record<string, unknown>>;

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

    const response = await handleSearch({ query: 'Default limit' });
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

    const response = await handleSearch({ query: 'Limit one', limit: 1 });
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

    const response = await handleSearch({ query: 'Large limit', limit: 100 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(5); // Only 5 available
  });
});
