/**
 * Comparison Tool Handler Tests
 *
 * Tests the MCP tool handlers in src/tools/comparison.ts with REAL databases.
 * Uses DatabaseService.create() for fresh v14 databases, NO mocks.
 *
 * @module tests/unit/tools/comparison
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { comparisonTools } from '../../../src/tools/comparison.js';
import { state, resetState, updateConfig, clearDatabase } from '../../../src/server/state.js';
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
  [key: string]: unknown;
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
  resetState();
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC TEST DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DOC1_TEXT =
  'AGREEMENT between Party A (John Smith) and Party B (Acme Corp).\nEffective Date: January 15, 2025.\nTotal Amount: $50,000.\nGoverned by California law.\n';
const DOC2_TEXT =
  'AGREEMENT between Party A (John Smith) and Party B (Beta LLC).\nEffective Date: March 1, 2025.\nTotal Amount: $75,000.\nGoverned by California law.\nArbitration clause added.\n';

// ═══════════════════════════════════════════════════════════════════════════════
// DATA SETUP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Insert a complete document chain: provenance + document + OCR provenance + OCR result
 * Returns { docId, docProvId, ocrProvId, ocrResultId }
 */
function insertCompleteDocChain(
  db: DatabaseService,
  fileName: string,
  filePath: string,
  extractedText: string,
  status: string = 'complete',
  pageCount: number = 1
): { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string } {
  const docId = uuidv4();
  const docProvId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(filePath);

  // DOCUMENT provenance
  db.insertProvenance({
    id: docProvId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: filePath,
    source_id: null,
    root_document_id: docProvId,
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

  // Document record
  db.insertDocument({
    id: docId,
    file_path: filePath,
    file_name: fileName,
    file_hash: fileHash,
    file_size: extractedText.length * 2,
    file_type: 'pdf',
    status,
    page_count: pageCount,
    provenance_id: docProvId,
    error_message: null,
    ocr_completed_at: now,
  });

  // OCR_RESULT provenance
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
    content_hash: computeHash(extractedText),
    input_hash: null,
    file_hash: null,
    processor: 'datalab-marker',
    processor_version: '1.0.0',
    processing_params: { mode: 'balanced' },
    processing_duration_ms: 2000,
    processing_quality_score: 4.5,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  // OCR result record
  db.insertOCRResult({
    id: ocrResultId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: extractedText,
    text_length: extractedText.length,
    datalab_request_id: `req-${ocrResultId}`,
    datalab_mode: 'balanced',
    parse_quality_score: 4.5,
    page_count: pageCount,
    cost_cents: 5,
    content_hash: computeHash(extractedText),
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 2000,
  });

  return { docId, docProvId, ocrProvId, ocrResultId };
}

/**
 * Insert a chunk for a document
 */
function insertTestChunk(
  db: DatabaseService,
  docId: string,
  ocrResultId: string,
  docProvId: string,
  text: string,
  chunkIndex: number
): string {
  const chunkId = uuidv4();
  const chunkProvId = uuidv4();
  const _ocrProvId = uuidv4();
  const now = new Date().toISOString();
  const hash = computeHash(text);

  // CHUNK provenance
  db.insertProvenance({
    id: chunkProvId,
    type: 'CHUNK',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'CHUNKING',
    source_path: null,
    source_id: docProvId,
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
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
  });

  db.insertChunk({
    id: chunkId,
    document_id: docId,
    ocr_result_id: ocrResultId,
    text,
    text_hash: hash,
    chunk_index: chunkIndex,
    character_start: 0,
    character_end: text.length,
    page_number: 1,
    page_range: null,
    overlap_previous: 0,
    overlap_next: 0,
    provenance_id: chunkProvId,
    embedding_status: 'pending',
    embedded_at: null,
  });

  return chunkId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXPORT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('comparisonTools exports', () => {
  it('exports all 6 comparison tools', () => {
    expect(Object.keys(comparisonTools)).toHaveLength(6);
    expect(comparisonTools).toHaveProperty('ocr_document_compare');
    expect(comparisonTools).toHaveProperty('ocr_comparison_list');
    expect(comparisonTools).toHaveProperty('ocr_comparison_get');
    expect(comparisonTools).toHaveProperty('ocr_comparison_discover');
    expect(comparisonTools).toHaveProperty('ocr_comparison_batch');
    expect(comparisonTools).toHaveProperty('ocr_comparison_matrix');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(comparisonTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDocumentCompare TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDocumentCompare', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  // Document chain IDs populated in beforeEach
  let doc1: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };
  let doc2: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('comp-compare-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('comptest');

    if (!sqliteVecAvailable) return;

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;

    // Insert two complete document chains
    doc1 = insertCompleteDocChain(
      dbService,
      'contract-v1.pdf',
      '/test/contract-v1.pdf',
      DOC1_TEXT,
      'complete',
      4
    );
    doc2 = insertCompleteDocChain(
      dbService,
      'contract-v2.pdf',
      '/test/contract-v2.pdf',
      DOC2_TEXT,
      'complete',
      5
    );

    // Insert some chunks for structural comparison
    insertTestChunk(dbService, doc1.docId, doc1.ocrResultId, doc1.docProvId, 'Chunk 1 of doc 1', 0);
    insertTestChunk(dbService, doc1.docId, doc1.ocrResultId, doc1.docProvId, 'Chunk 2 of doc 1', 1);
    insertTestChunk(dbService, doc2.docId, doc2.ocrResultId, doc2.docProvId, 'Chunk 1 of doc 2', 0);
    insertTestChunk(dbService, doc2.docId, doc2.ocrResultId, doc2.docProvId, 'Chunk 2 of doc 2', 1);
    insertTestChunk(dbService, doc2.docId, doc2.ocrResultId, doc2.docProvId, 'Chunk 3 of doc 2', 2);
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)(
    'compare valid docs -> returns comparison_id, similarity, summary; row in DB',
    async () => {
      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_1: doc1.docId,
        document_id_2: doc2.docId,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.comparison_id).toBeDefined();
      expect(typeof data.comparison_id).toBe('string');
      expect(data.similarity_ratio).toBeDefined();
      expect(typeof data.similarity_ratio).toBe('number');
      expect(data.similarity_ratio as number).toBeGreaterThan(0);
      expect(data.similarity_ratio as number).toBeLessThan(1);
      expect(data.summary).toBeDefined();
      expect(typeof data.summary).toBe('string');
      expect(data.provenance_id).toBeDefined();

      // Verify row exists in comparisons table
      const conn = dbService.getConnection();
      const row = conn
        .prepare('SELECT * FROM comparisons WHERE id = ?')
        .get(data.comparison_id as string) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.document_id_1).toBe(doc1.docId);
      expect(row.document_id_2).toBe(doc2.docId);
      expect(typeof row.similarity_ratio).toBe('number');
      expect(row.content_hash).toBeDefined();
      expect(typeof row.content_hash).toBe('string');
      expect((row.content_hash as string).startsWith('sha256:')).toBe(true);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'missing doc_id_1 -> validation error; no row in comparisons',
    async () => {
      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_2: doc2.docId,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Verify no comparisons created
      const conn = dbService.getConnection();
      const count = (
        conn.prepare('SELECT COUNT(*) as cnt FROM comparisons').get() as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'non-existent doc_id_1 -> document not found; no row in comparisons',
    async () => {
      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_1: 'nonexistent-doc-id',
        document_id_2: doc2.docId,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');

      // Verify no comparisons created
      const conn = dbService.getConnection();
      const count = (
        conn.prepare('SELECT COUNT(*) as cnt FROM comparisons').get() as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'doc not OCR processed (status=pending) -> error; no row in comparisons',
    async () => {
      // Insert a pending document
      const pendingDoc = insertCompleteDocChain(
        dbService,
        'pending.pdf',
        '/test/pending.pdf',
        'pending text',
        'pending',
        1
      );

      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_1: pendingDoc.docId,
        document_id_2: doc2.docId,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('pending');

      // Verify no comparisons created
      const conn = dbService.getConnection();
      const count = (
        conn.prepare('SELECT COUNT(*) as cnt FROM comparisons').get() as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'same doc both IDs -> self-compare error; no row in comparisons',
    async () => {
      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_1: doc1.docId,
        document_id_2: doc1.docId,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('itself');

      // Verify no comparisons created
      const conn = dbService.getConnection();
      const count = (
        conn.prepare('SELECT COUNT(*) as cnt FROM comparisons').get() as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'include_text_diff=false -> text_diff is null in response',
    async () => {
      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_1: doc1.docId,
        document_id_2: doc2.docId,
        include_text_diff: false,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.text_diff).toBeNull();
      // Structural diff should still be present
      expect(data.structural_diff).toBeDefined();
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'provenance created after compare -> COMPARISON provenance record exists',
    async () => {
      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_1: doc1.docId,
        document_id_2: doc2.docId,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const provId = data.provenance_id as string;
      expect(provId).toBeDefined();

      // Verify provenance record in DB
      const conn = dbService.getConnection();
      const prov = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(provId) as Record<
        string,
        unknown
      >;
      expect(prov).toBeDefined();
      expect(prov.type).toBe('COMPARISON');
      expect(prov.source_type).toBe('COMPARISON');
      expect(prov.chain_depth).toBe(2);
      expect(prov.processor).toBe('document-comparison');
      expect(prov.processor_version).toBe('1.0.0');

      // chain_path should be DOCUMENT -> OCR_RESULT -> COMPARISON
      const chainPath = JSON.parse(prov.chain_path as string);
      expect(chainPath).toEqual(['DOCUMENT', 'OCR_RESULT', 'COMPARISON']);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'content hash matches -> stored hash matches recomputed hash',
    async () => {
      const handler = comparisonTools['ocr_document_compare'].handler;
      const response = await handler({
        document_id_1: doc1.docId,
        document_id_2: doc2.docId,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const compId = data.comparison_id as string;
      const conn = dbService.getConnection();
      const row = conn
        .prepare(
          'SELECT content_hash, text_diff_json, structural_diff_json FROM comparisons WHERE id = ?'
        )
        .get(compId) as Record<string, unknown>;

      // Recompute the hash using same formula as comparison.ts
      const diffContent = JSON.stringify({
        text_diff: JSON.parse(row.text_diff_json as string),
        structural_diff: JSON.parse(row.structural_diff_json as string),
      });
      const expectedHash = computeHash(diffContent);

      expect(row.content_hash).toBe(expectedHash);
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleComparisonList TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleComparisonList', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;
  let doc1: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };
  let doc2: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };
  let doc3: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('comp-list-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('complist');

    if (!sqliteVecAvailable) return;

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;

    // Insert three docs to create multiple comparisons
    doc1 = insertCompleteDocChain(dbService, 'doc1.pdf', '/test/doc1.pdf', DOC1_TEXT);
    doc2 = insertCompleteDocChain(dbService, 'doc2.pdf', '/test/doc2.pdf', DOC2_TEXT);
    doc3 = insertCompleteDocChain(
      dbService,
      'doc3.pdf',
      '/test/doc3.pdf',
      'Third document text content.\n'
    );
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('after creating 2 comparisons, list returns 2', async () => {
    const compareHandler = comparisonTools['ocr_document_compare'].handler;
    const listHandler = comparisonTools['ocr_comparison_list'].handler;

    // Create two comparisons
    await compareHandler({ document_id_1: doc1.docId, document_id_2: doc2.docId });
    await compareHandler({ document_id_1: doc1.docId, document_id_2: doc3.docId });

    const response = await listHandler({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.comparisons).toBeDefined();
    const comparisons = data.comparisons as Array<Record<string, unknown>>;
    expect(comparisons.length).toBe(2);
    // Each comparison should have summary fields but not large diff data
    for (const comp of comparisons) {
      expect(comp.id).toBeDefined();
      expect(comp.document_id_1).toBeDefined();
      expect(comp.document_id_2).toBeDefined();
      expect(comp.similarity_ratio).toBeDefined();
      expect(comp.summary).toBeDefined();
      expect(comp.created_at).toBeDefined();
    }
  });

  it.skipIf(!sqliteVecAvailable)(
    'list filtered by document_id -> returns only matching',
    async () => {
      const compareHandler = comparisonTools['ocr_document_compare'].handler;
      const listHandler = comparisonTools['ocr_comparison_list'].handler;

      // Create comparisons: doc1 vs doc2, doc2 vs doc3
      await compareHandler({ document_id_1: doc1.docId, document_id_2: doc2.docId });
      await compareHandler({ document_id_1: doc2.docId, document_id_2: doc3.docId });

      // Filter by doc3 -> only the doc2-vs-doc3 comparison
      const response = await listHandler({ document_id: doc3.docId });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const comparisons = data.comparisons as Array<Record<string, unknown>>;
      expect(comparisons.length).toBe(1);
      // Should involve doc3
      const comp = comparisons[0];
      const involvesDoc3 = comp.document_id_1 === doc3.docId || comp.document_id_2 === doc3.docId;
      expect(involvesDoc3).toBe(true);
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleComparisonGet TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleComparisonGet', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;
  let doc1: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };
  let doc2: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('comp-get-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('compget');

    if (!sqliteVecAvailable) return;

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;

    doc1 = insertCompleteDocChain(dbService, 'get-doc1.pdf', '/test/get-doc1.pdf', DOC1_TEXT);
    doc2 = insertCompleteDocChain(dbService, 'get-doc2.pdf', '/test/get-doc2.pdf', DOC2_TEXT);
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('get returns full comparison with parsed JSON', async () => {
    const compareHandler = comparisonTools['ocr_document_compare'].handler;
    const getHandler = comparisonTools['ocr_comparison_get'].handler;

    // Create a comparison first
    const compareResponse = await compareHandler({
      document_id_1: doc1.docId,
      document_id_2: doc2.docId,
    });
    const compareResult = parseResponse(compareResponse);
    expect(compareResult.success).toBe(true);
    const compareData = compareResult.data as Record<string, unknown>;
    const comparisonId = compareData.comparison_id as string;

    // Get the comparison
    const response = await getHandler({ comparison_id: comparisonId });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe(comparisonId);
    expect(data.document_id_1).toBe(doc1.docId);
    expect(data.document_id_2).toBe(doc2.docId);
    expect(data.similarity_ratio).toBeDefined();
    expect(data.summary).toBeDefined();

    // JSON fields should be parsed objects, not strings
    expect(data.text_diff_json).toBeDefined();
    expect(typeof data.text_diff_json).toBe('object');
    expect(data.structural_diff_json).toBeDefined();
    expect(typeof data.structural_diff_json).toBe('object');
  });

  it.skipIf(!sqliteVecAvailable)('get non-existent -> error response', async () => {
    const getHandler = comparisonTools['ocr_comparison_get'].handler;
    const response = await getHandler({ comparison_id: 'nonexistent-comparison-id' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CASCADE DELETE TEST
// ═══════════════════════════════════════════════════════════════════════════════

describe('cascade delete', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;
  let doc1: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };
  let doc2: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };
  let doc3: { docId: string; docProvId: string; ocrProvId: string; ocrResultId: string };

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('comp-cascade-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('compcascade');

    if (!sqliteVecAvailable) return;

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;

    doc1 = insertCompleteDocChain(
      dbService,
      'cascade-doc1.pdf',
      '/test/cascade-doc1.pdf',
      DOC1_TEXT
    );
    doc2 = insertCompleteDocChain(
      dbService,
      'cascade-doc2.pdf',
      '/test/cascade-doc2.pdf',
      DOC2_TEXT
    );
    doc3 = insertCompleteDocChain(
      dbService,
      'cascade-doc3.pdf',
      '/test/cascade-doc3.pdf',
      'Third doc text.\n'
    );
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('delete doc1 -> comparisons involving doc1 are gone', async () => {
    const compareHandler = comparisonTools['ocr_document_compare'].handler;

    // Create comparisons: doc1 vs doc2, doc2 vs doc3
    const resp1 = await compareHandler({ document_id_1: doc1.docId, document_id_2: doc2.docId });
    const comp1Result = parseResponse(resp1);
    expect(comp1Result.success).toBe(true);
    const comp1Data = comp1Result.data as Record<string, unknown>;
    const comp1Id = comp1Data.comparison_id as string;

    const resp2 = await compareHandler({ document_id_1: doc2.docId, document_id_2: doc3.docId });
    const comp2Result = parseResponse(resp2);
    expect(comp2Result.success).toBe(true);
    const comp2Data = comp2Result.data as Record<string, unknown>;
    const comp2Id = comp2Data.comparison_id as string;

    const conn = dbService.getConnection();

    // Verify both comparisons exist
    expect(conn.prepare('SELECT COUNT(*) as cnt FROM comparisons').get()).toEqual({ cnt: 2 });

    // Delete doc1 using the document delete tool (which triggers cascade)
    // We need to import and use the document delete handler
    const { documentTools } = await import('../../../src/tools/documents.js');
    const deleteHandler = documentTools['ocr_document_delete'].handler;
    const deleteResponse = await deleteHandler({ document_id: doc1.docId, confirm: true });
    const deleteResult = parseResponse(deleteResponse);
    expect(deleteResult.success).toBe(true);

    // Comparison involving doc1 should be gone
    const row1 = conn.prepare('SELECT * FROM comparisons WHERE id = ?').get(comp1Id);
    expect(row1).toBeUndefined();

    // Comparison NOT involving doc1 should still exist
    const row2 = conn.prepare('SELECT * FROM comparisons WHERE id = ?').get(comp2Id);
    expect(row2).toBeDefined();
  });
});
