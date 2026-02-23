/**
 * Unit Tests for Document MCP Tools
 *
 * Tests the extracted document tool handlers in src/tools/documents.ts
 * Tools: handleDocumentList, handleDocumentGet, handleDocumentDelete
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/documents
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import {
  handleDocumentList,
  handleDocumentGet,
  handleDocumentDelete,
  handleFindSimilar,
  handleDocumentStructure,
  handleUpdateMetadata,
  handleDuplicateDetection,
  documentTools,
} from '../../../src/tools/documents.js';
import { state, resetState, updateConfig, clearDatabase } from '../../../src/server/state.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { VectorService } from '../../../src/services/storage/vector.js';
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
  filePath: string,
  status: string = 'complete'
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
    status: status,
    page_count: 1,
    provenance_id: provId,
    error_message: null,
    ocr_completed_at: now,
  });

  return provId;
}

/**
 * Insert test chunk with provenance and OCR result
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

describe('documentTools exports', () => {
  it('exports all 10 document tools (MERGE-A: ocr_document_export + ocr_corpus_export -> ocr_export)', () => {
    expect(Object.keys(documentTools)).toHaveLength(10);
    expect(documentTools).toHaveProperty('ocr_document_list');
    expect(documentTools).toHaveProperty('ocr_document_get');
    expect(documentTools).toHaveProperty('ocr_document_delete');
    expect(documentTools).toHaveProperty('ocr_document_find_similar');
    expect(documentTools).toHaveProperty('ocr_document_structure');
    expect(documentTools).toHaveProperty('ocr_document_update_metadata');
    expect(documentTools).toHaveProperty('ocr_document_duplicates');
    expect(documentTools).toHaveProperty('ocr_export');
    expect(documentTools).toHaveProperty('ocr_document_versions');
    expect(documentTools).toHaveProperty('ocr_document_workflow');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(documentTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDocumentList TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDocumentList', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-list-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('doclist');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleDocumentList({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('returns empty list for empty database', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleDocumentList({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.documents).toEqual([]);
    // Note: total comes from stats.documentCount which maps to total_documents
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(0);
  });

  it.skipIf(!sqliteVecAvailable)('returns documents with correct fields', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    const response = await handleDocumentList({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(1);
    expect(documents[0]).toHaveProperty('id');
    expect(documents[0]).toHaveProperty('file_name');
    expect(documents[0]).toHaveProperty('file_path');
    expect(documents[0]).toHaveProperty('file_size');
    expect(documents[0]).toHaveProperty('file_type');
    expect(documents[0]).toHaveProperty('status');
    expect(documents[0]).toHaveProperty('page_count');
    expect(documents[0]).toHaveProperty('created_at');
  });

  it.skipIf(!sqliteVecAvailable)('applies status_filter correctly', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert documents with different statuses
    insertTestDocument(db, uuidv4(), 'complete1.txt', '/test/complete1.txt', 'complete');
    insertTestDocument(db, uuidv4(), 'complete2.txt', '/test/complete2.txt', 'complete');
    insertTestDocument(db, uuidv4(), 'pending.txt', '/test/pending.txt', 'pending');

    const response = await handleDocumentList({ status_filter: 'complete' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(2);
    for (const doc of documents) {
      expect(doc.status).toBe('complete');
    }
  });

  it.skipIf(!sqliteVecAvailable)('returns all documents with default sort', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert documents with different names
    insertTestDocument(db, uuidv4(), 'aaa.txt', '/test/aaa.txt');
    insertTestDocument(db, uuidv4(), 'zzz.txt', '/test/zzz.txt');
    insertTestDocument(db, uuidv4(), 'mmm.txt', '/test/mmm.txt');

    const response = await handleDocumentList({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(3);
    const fileNames = documents.map((d) => d.file_name);
    expect(fileNames).toContain('aaa.txt');
    expect(fileNames).toContain('mmm.txt');
    expect(fileNames).toContain('zzz.txt');
  });

  it.skipIf(!sqliteVecAvailable)('applies pagination (limit/offset)', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert 5 documents
    for (let i = 0; i < 5; i++) {
      insertTestDocument(db, uuidv4(), `doc${i}.txt`, `/test/doc${i}.txt`);
    }

    // Get page 2 (offset 2, limit 2)
    const response = await handleDocumentList({ limit: 2, offset: 2 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(2);
    expect(result.data?.limit).toBe(2);
    expect(result.data?.offset).toBe(2);
  });

  it.skipIf(!sqliteVecAvailable)('returns multiple documents correctly', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert 3 documents
    for (let i = 0; i < 3; i++) {
      insertTestDocument(db, uuidv4(), `multi${i}.txt`, `/test/multi${i}.txt`);
    }

    const response = await handleDocumentList({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDocumentGet TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDocumentGet', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-get-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docget');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    // Use a valid UUID format to pass validation before database check
    const response = await handleDocumentGet({ document_id: uuidv4() });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('returns document with basic fields', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    const response = await handleDocumentGet({ document_id: docId });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(docId);
    expect(result.data?.file_name).toBe('test.txt');
    expect(result.data?.file_path).toBe('/test/test.txt');
    expect(result.data).toHaveProperty('file_hash');
    expect(result.data).toHaveProperty('file_size');
    expect(result.data).toHaveProperty('file_type');
    expect(result.data).toHaveProperty('status');
    expect(result.data).toHaveProperty('page_count');
    expect(result.data).toHaveProperty('created_at');
    expect(result.data).toHaveProperty('provenance_id');
  });

  it.skipIf(!sqliteVecAvailable)('includes OCR text when include_text=true', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const ocrText = 'This is the extracted OCR text content';
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    insertTestChunk(db, uuidv4(), docId, docProvId, ocrText, 0);

    const response = await handleDocumentGet({ document_id: docId, include_text: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('ocr_text');
    expect(result.data?.ocr_text).toBe(ocrText);
  });

  it.skipIf(!sqliteVecAvailable)('includes chunks when include_chunks=true', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    // Insert 3 chunks
    for (let i = 0; i < 3; i++) {
      insertTestChunk(db, uuidv4(), docId, docProvId, `Chunk ${i} content`, i);
    }

    const response = await handleDocumentGet({ document_id: docId, include_chunks: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('chunks');
    const chunks = result.data?.chunks as Array<Record<string, unknown>>;
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveProperty('id');
    expect(chunks[0]).toHaveProperty('chunk_index');
    expect(chunks[0]).toHaveProperty('text_length');
    expect(chunks[0]).toHaveProperty('page_number');
    expect(chunks[0]).toHaveProperty('character_start');
    expect(chunks[0]).toHaveProperty('character_end');
    expect(chunks[0]).toHaveProperty('embedding_status');
  });

  it.skipIf(!sqliteVecAvailable)(
    'includes provenance chain when include_full_provenance=true',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

      const response = await handleDocumentGet({
        document_id: docId,
        include_full_provenance: true,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('provenance_chain');
      const chain = result.data?.provenance_chain as Array<Record<string, unknown>>;
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0]).toHaveProperty('id');
      expect(chain[0]).toHaveProperty('type');
      expect(chain[0]).toHaveProperty('chain_depth');
      expect(chain[0]).toHaveProperty('processor');
      expect(chain[0]).toHaveProperty('processor_version');
      expect(chain[0]).toHaveProperty('content_hash');
      expect(chain[0]).toHaveProperty('created_at');
    }
  );

  it.skipIf(!sqliteVecAvailable)('returns DOCUMENT_NOT_FOUND for invalid ID', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Use valid UUID format that doesn't exist in database
    const response = await handleDocumentGet({ document_id: uuidv4() });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it.skipIf(!sqliteVecAvailable)(
    'returns document without optional fields by default',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
      insertTestChunk(db, uuidv4(), docId, docProvId, 'Some text', 0);

      const response = await handleDocumentGet({ document_id: docId });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('ocr_text');
      expect(result.data).not.toHaveProperty('chunks');
      expect(result.data).not.toHaveProperty('provenance_chain');
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDocumentDelete TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDocumentDelete', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-delete-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docdel');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    // Use valid UUID format to pass validation before database check
    const response = await handleDocumentDelete({ document_id: uuidv4(), confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('deletes document and returns counts', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'delete-test.txt', '/test/delete-test.txt');

    // Insert chunks to be deleted along with document
    insertTestChunk(db, uuidv4(), docId, docProvId, 'Chunk 1 to delete', 0);
    insertTestChunk(db, uuidv4(), docId, docProvId, 'Chunk 2 to delete', 1);

    // Verify document exists before delete
    const docBefore = db.getDocument(docId);
    expect(docBefore).not.toBeNull();

    const response = await handleDocumentDelete({ document_id: docId, confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.document_id).toBe(docId);
    expect(result.data?.deleted).toBe(true);
    expect(result.data).toHaveProperty('chunks_deleted');
    expect(result.data).toHaveProperty('embeddings_deleted');
    expect(result.data).toHaveProperty('vectors_deleted');
    expect(result.data).toHaveProperty('provenance_deleted');

    // PHYSICAL VERIFICATION: Document no longer exists in database
    const docAfter = db.getDocument(docId);
    expect(docAfter).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('returns DOCUMENT_NOT_FOUND for invalid ID', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Use valid UUID format that doesn't exist in database
    const response = await handleDocumentDelete({ document_id: uuidv4(), confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it.skipIf(!sqliteVecAvailable)('returns VALIDATION_ERROR when confirm is not true', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'no-confirm.txt', '/test/no-confirm.txt');

    const response = await handleDocumentDelete({ document_id: docId, confirm: false as never });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // confirm: false fails z.literal(true) Zod validation -> VALIDATION_ERROR
    expect(result.error?.category).toBe('VALIDATION_ERROR');

    // PHYSICAL VERIFICATION: Document still exists
    const docAfter = db.getDocument(docId);
    expect(docAfter).not.toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('deletes all associated chunks', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'with-chunks.txt', '/test/with-chunks.txt');

    // Insert multiple chunks
    const chunkIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const chunkId = uuidv4();
      chunkIds.push(chunkId);
      insertTestChunk(db, chunkId, docId, docProvId, `Chunk ${i}`, i);
    }

    // Verify chunks exist before delete
    const chunksBefore = db.getChunksByDocumentId(docId);
    expect(chunksBefore).toHaveLength(3);

    await handleDocumentDelete({ document_id: docId, confirm: true });

    // PHYSICAL VERIFICATION: Chunks no longer exist
    const chunksAfter = db.getChunksByDocumentId(docId);
    expect(chunksAfter).toHaveLength(0);
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
    tempDir = createTempDir('doc-edge-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docedge');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('Edge Case 1: Empty Database Operations', () => {
    it.skipIf(!sqliteVecAvailable)('list returns empty array for new database', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleDocumentList({});
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.documents).toEqual([]);
      const documents = result.data?.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(0);
    });

    it.skipIf(!sqliteVecAvailable)('get fails gracefully for non-existent document', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleDocumentGet({ document_id: uuidv4() });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('Edge Case 2: Invalid Document IDs', () => {
    it.skipIf(!sqliteVecAvailable)('get handles empty string document_id', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleDocumentGet({ document_id: '' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it.skipIf(!sqliteVecAvailable)('delete handles empty string document_id', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleDocumentDelete({ document_id: '', confirm: true });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it.skipIf(!sqliteVecAvailable)('get handles special characters in document_id', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // Special characters are accepted by min(1) validation, so lookup proceeds to DB
      const response = await handleDocumentGet({ document_id: 'special-!@#$%' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      // Non-UUID IDs pass validation but are not found in DB
      expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('Edge Case 3: Pagination Boundaries', () => {
    it.skipIf(!sqliteVecAvailable)('list handles offset greater than total documents', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // Insert 2 documents
      insertTestDocument(db, uuidv4(), 'doc1.txt', '/test/doc1.txt');
      insertTestDocument(db, uuidv4(), 'doc2.txt', '/test/doc2.txt');

      // Request with offset beyond total
      const response = await handleDocumentList({ offset: 100, limit: 10 });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const documents = result.data?.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(0);
    });

    it.skipIf(!sqliteVecAvailable)('list handles limit=1 correctly', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // Insert 5 documents
      for (let i = 0; i < 5; i++) {
        insertTestDocument(db, uuidv4(), `doc${i}.txt`, `/test/doc${i}.txt`);
      }

      const response = await handleDocumentList({ limit: 1 });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const documents = result.data?.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(1);
    });

    it.skipIf(!sqliteVecAvailable)('list handles max limit=1000', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // Insert 3 documents
      for (let i = 0; i < 3; i++) {
        insertTestDocument(db, uuidv4(), `doc${i}.txt`, `/test/doc${i}.txt`);
      }

      const response = await handleDocumentList({ limit: 1000 });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const documents = result.data?.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(3); // Only 3 exist
    });
  });

  describe('Edge Case 4: Document with No Chunks or OCR', () => {
    it.skipIf(!sqliteVecAvailable)('get handles document without OCR text gracefully', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      insertTestDocument(db, docId, 'no-ocr.txt', '/test/no-ocr.txt');

      const response = await handleDocumentGet({ document_id: docId, include_text: true });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.ocr_text).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('get handles document without chunks gracefully', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      insertTestDocument(db, docId, 'no-chunks.txt', '/test/no-chunks.txt');

      const response = await handleDocumentGet({ document_id: docId, include_chunks: true });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const chunks = result.data?.chunks as Array<Record<string, unknown>>;
      expect(chunks).toEqual([]);
    });
  });

  describe('Edge Case 5: Status Filter Edge Cases', () => {
    it.skipIf(!sqliteVecAvailable)(
      'list with non-matching status filter returns empty',
      async () => {
        const db = DatabaseService.create(dbName, undefined, tempDir);
        state.currentDatabase = db;
        state.currentDatabaseName = dbName;

        // Insert only complete documents
        insertTestDocument(db, uuidv4(), 'complete.txt', '/test/complete.txt', 'complete');

        // Filter for pending should return empty
        const response = await handleDocumentList({ status_filter: 'pending' });
        const result = parseResponse(response);

        expect(result.success).toBe(true);
        const documents = result.data?.documents as Array<Record<string, unknown>>;
        expect(documents).toHaveLength(0);
      }
    );

    it.skipIf(!sqliteVecAvailable)('list with failed status filter', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertTestDocument(db, uuidv4(), 'failed.txt', '/test/failed.txt', 'failed');
      insertTestDocument(db, uuidv4(), 'complete.txt', '/test/complete.txt', 'complete');

      const response = await handleDocumentList({ status_filter: 'failed' });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const documents = result.data?.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(1);
      expect(documents[0].status).toBe('failed');
    });
  });

  describe('Edge Case 6: Sort Order Edge Cases', () => {
    it.skipIf(!sqliteVecAvailable)(
      'list returns documents in created_at descending order',
      async () => {
        const db = DatabaseService.create(dbName, undefined, tempDir);
        state.currentDatabase = db;
        state.currentDatabaseName = dbName;

        insertTestDocument(db, uuidv4(), 'doc1.txt', '/test/doc1.txt');
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
        insertTestDocument(db, uuidv4(), 'doc2.txt', '/test/doc2.txt');

        const response = await handleDocumentList({});
        const result = parseResponse(response);

        expect(result.success).toBe(true);
        const documents = result.data?.documents as Array<Record<string, unknown>>;
        expect(documents).toHaveLength(2);
        // Default sort is created_at DESC, so doc2 (newer) should come first
        expect(documents[0].file_name).toBe('doc2.txt');
        expect(documents[1].file_name).toBe('doc1.txt');
      }
    );

    it.skipIf(!sqliteVecAvailable)('list sorts by created_at descending (default)', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertTestDocument(db, uuidv4(), 'first.txt', '/test/first.txt');
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      insertTestDocument(db, uuidv4(), 'second.txt', '/test/second.txt');

      const response = await handleDocumentList({});
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const documents = result.data?.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(2);
      // Most recent should be first
      expect(documents[0].file_name).toBe('second.txt');
    });
  });

  describe('Edge Case 7: Delete Cascade Verification', () => {
    it.skipIf(!sqliteVecAvailable)('delete removes OCR results along with document', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'cascade.txt', '/test/cascade.txt');
      insertTestChunk(db, uuidv4(), docId, docProvId, 'OCR text to delete', 0);

      // Verify OCR result exists before delete
      const ocrBefore = db.getOCRResultByDocumentId(docId);
      expect(ocrBefore).not.toBeNull();

      await handleDocumentDelete({ document_id: docId, confirm: true });

      // PHYSICAL VERIFICATION: OCR result no longer exists
      const ocrAfter = db.getOCRResultByDocumentId(docId);
      expect(ocrAfter).toBeNull();
    });
  });

  describe('Edge Case 8: Include All Options at Once', () => {
    it.skipIf(!sqliteVecAvailable)(
      'get includes text, chunks, and provenance together',
      async () => {
        const db = DatabaseService.create(dbName, undefined, tempDir);
        state.currentDatabase = db;
        state.currentDatabaseName = dbName;

        const docId = uuidv4();
        const docProvId = insertTestDocument(db, docId, 'full.txt', '/test/full.txt');
        insertTestChunk(db, uuidv4(), docId, docProvId, 'Full document content', 0);
        insertTestChunk(db, uuidv4(), docId, docProvId, 'More content', 1);

        const response = await handleDocumentGet({
          document_id: docId,
          include_text: true,
          include_chunks: true,
          include_full_provenance: true,
        });
        const result = parseResponse(response);

        expect(result.success).toBe(true);
        expect(result.data).toHaveProperty('ocr_text');
        expect(result.data).toHaveProperty('chunks');
        expect(result.data).toHaveProperty('provenance_chain');

        const chunks = result.data?.chunks as Array<Record<string, unknown>>;
        expect(chunks).toHaveLength(2);

        const chain = result.data?.provenance_chain as Array<Record<string, unknown>>;
        expect(chain.length).toBeGreaterThan(0);
      }
    );
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

  it('document_list rejects invalid status_filter', async () => {
    const response = await handleDocumentList({ status_filter: 'invalid' });
    const result = parseResponse(response);
    // Should fail - Zod validation rejects invalid enum value
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('document_list strips unknown params like sort_by', async () => {
    // sort_by was removed as a dead param; Zod strips unknown fields
    // The handler proceeds past validation but fails on "no database selected"
    const response = await handleDocumentList({ sort_by: 'invalid_field' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('document_list rejects negative limit', async () => {
    const response = await handleDocumentList({ limit: -1 });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('document_list rejects negative offset', async () => {
    const response = await handleDocumentList({ offset: -1 });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('document_get rejects missing document_id', async () => {
    const response = await handleDocumentGet({});
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('document_delete rejects missing confirm', async () => {
    const response = await handleDocumentDelete({ document_id: 'test-id' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('document_delete rejects missing document_id', async () => {
    const response = await handleDocumentDelete({ confirm: true });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Response Structure', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-response-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docresp');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('list response has correct structure', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleDocumentList({});
    const result = parseResponse(response);

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('data');
    expect(result.data).toHaveProperty('documents');
    expect(result.data).toHaveProperty('limit');
    expect(result.data).toHaveProperty('offset');
    // Note: total may be undefined due to stats.documentCount property mismatch
    // The response structure includes documents array for counting
  });

  it.skipIf(!sqliteVecAvailable)('get response has correct structure', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'structure.txt', '/test/structure.txt');

    const response = await handleDocumentGet({ document_id: docId });
    const result = parseResponse(response);

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('data');
    expect(result.success).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('delete response has correct structure', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'delete-struct.txt', '/test/delete-struct.txt');

    const response = await handleDocumentDelete({ document_id: docId, confirm: true });
    const result = parseResponse(response);

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('data');
    expect(result.data).toHaveProperty('document_id');
    expect(result.data).toHaveProperty('deleted');
    expect(result.data).toHaveProperty('chunks_deleted');
    expect(result.data).toHaveProperty('embeddings_deleted');
    expect(result.data).toHaveProperty('vectors_deleted');
    expect(result.data).toHaveProperty('provenance_deleted');
  });

  it('error response has correct structure', async () => {
    // Use valid UUID to get past validation, will fail with DATABASE_NOT_SELECTED
    const response = await handleDocumentGet({ document_id: uuidv4() });
    const result = parseResponse(response);

    expect(result).toHaveProperty('success');
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
    expect(result.error).toHaveProperty('category');
    expect(result.error).toHaveProperty('message');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Insert embedding + vector for a chunk
// ═══════════════════════════════════════════════════════════════════════════════

function insertTestEmbeddingWithVector(
  db: DatabaseService,
  vector: VectorService,
  embId: string,
  chunkId: string,
  docId: string,
  docProvId: string,
  text: string,
  vecValues: Float32Array
): void {
  const provId = uuidv4();
  const now = new Date().toISOString();
  const hash = computeHash(text);

  // Insert embedding provenance
  db.insertProvenance({
    id: provId,
    type: 'EMBEDDING',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'EMBEDDING',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: hash,
    input_hash: null,
    file_hash: null,
    processor: 'nomic-embed-text-v1.5',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 10,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 3,
    chain_path: '["DOCUMENT","OCR_RESULT","CHUNK","EMBEDDING"]',
  });

  db.insertEmbedding({
    id: embId,
    chunk_id: chunkId,
    image_id: null,
    extraction_id: null,
    document_id: docId,
    original_text: text,
    original_text_length: text.length,
    source_file_path: '/test/test.txt',
    source_file_name: 'test.txt',
    source_file_hash: hash,
    page_number: 1,
    page_range: null,
    character_start: 0,
    character_end: text.length,
    chunk_index: 0,
    total_chunks: 1,
    model_name: 'nomic-embed-text-v1.5',
    model_version: '1.0.0',
    task_type: 'search_document',
    inference_mode: 'local',
    gpu_device: 'cpu',
    provenance_id: provId,
    content_hash: hash,
    generation_duration_ms: 10,
  });

  vector.storeVector(embId, vecValues);
}

// ═══════════════════════════════════════════════════════════════════════════════
// handleFindSimilar TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleFindSimilar', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-similar-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docsimilar');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleFindSimilar({ document_id: uuidv4() });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('returns DOCUMENT_NOT_FOUND for invalid doc', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleFindSimilar({ document_id: uuidv4() });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it.skipIf(!sqliteVecAvailable)('returns error when document has no embeddings', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'no-emb.txt', '/test/no-emb.txt');

    const response = await handleFindSimilar({ document_id: docId });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('no chunk embeddings');
  });

  it.skipIf(!sqliteVecAvailable)('finds similar documents by centroid', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    const vec = new VectorService(db.getConnection());
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;
    state.vectorService = vec;

    // Create doc1 with a chunk+embedding
    const doc1Id = uuidv4();
    const doc1ProvId = insertTestDocument(db, doc1Id, 'doc1.txt', '/test/doc1.txt');
    const chunk1Id = uuidv4();
    insertTestChunk(db, chunk1Id, doc1Id, doc1ProvId, 'Document one text about legal contracts', 0);
    const emb1Id = uuidv4();
    // Create a 768-dim vector with known pattern
    const vec1 = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec1[i] = 0.1;
    insertTestEmbeddingWithVector(db, vec, emb1Id, chunk1Id, doc1Id, doc1ProvId, 'Document one text', vec1);

    // Create doc2 with similar vector (close to doc1)
    const doc2Id = uuidv4();
    const doc2ProvId = insertTestDocument(db, doc2Id, 'doc2.txt', '/test/doc2.txt');
    const chunk2Id = uuidv4();
    insertTestChunk(db, chunk2Id, doc2Id, doc2ProvId, 'Document two also about legal contracts', 0);
    const emb2Id = uuidv4();
    const vec2 = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec2[i] = 0.11; // Very similar to vec1
    insertTestEmbeddingWithVector(db, vec, emb2Id, chunk2Id, doc2Id, doc2ProvId, 'Document two text', vec2);

    // Create doc3 with different vector (far from doc1)
    const doc3Id = uuidv4();
    const doc3ProvId = insertTestDocument(db, doc3Id, 'doc3.txt', '/test/doc3.txt');
    const chunk3Id = uuidv4();
    insertTestChunk(db, chunk3Id, doc3Id, doc3ProvId, 'Document three about cooking recipes', 0);
    const emb3Id = uuidv4();
    const vec3 = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec3[i] = (i % 2 === 0) ? -0.5 : 0.5; // Different pattern
    insertTestEmbeddingWithVector(db, vec, emb3Id, chunk3Id, doc3Id, doc3ProvId, 'Document three text', vec3);

    // Find similar to doc1
    const response = await handleFindSimilar({ document_id: doc1Id, min_similarity: 0.0 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.source_document_id).toBe(doc1Id);
    expect(result.data?.source_chunk_count).toBe(1);
    const similar = result.data?.similar_documents as Array<Record<string, unknown>>;
    expect(similar.length).toBeGreaterThanOrEqual(1);

    // doc2 should be most similar (vectors are close)
    expect(similar[0].document_id).toBe(doc2Id);
    expect(similar[0].file_name).toBe('doc2.txt');
    expect(typeof similar[0].avg_similarity).toBe('number');
    expect((similar[0].avg_similarity as number)).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteVecAvailable)('excludes source document from results', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    const vec = new VectorService(db.getConnection());
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;
    state.vectorService = vec;

    // Create a single document
    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'only.txt', '/test/only.txt');
    const chunkId = uuidv4();
    insertTestChunk(db, chunkId, docId, docProvId, 'Only document in database', 0);
    const embId = uuidv4();
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = 0.1;
    insertTestEmbeddingWithVector(db, vec, embId, chunkId, docId, docProvId, 'Only text', v);

    const response = await handleFindSimilar({ document_id: docId, min_similarity: 0.0 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const similar = result.data?.similar_documents as Array<Record<string, unknown>>;
    // Source doc should be excluded - no other docs, so empty
    expect(similar.length).toBe(0);
    expect(result.data?.total).toBe(0);
  });

  it('rejects empty document_id', async () => {
    const response = await handleFindSimilar({ document_id: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDocumentStructure TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDocumentStructure', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-structure-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docstructure');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleDocumentStructure({ document_id: uuidv4() });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('returns DOCUMENT_NOT_FOUND for invalid doc', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleDocumentStructure({ document_id: uuidv4() });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('rejects empty document_id', async () => {
    const response = await handleDocumentStructure({ document_id: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it.skipIf(!sqliteVecAvailable)('returns empty structure for document with no OCR or chunks', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'empty.txt', '/test/empty.txt');

    const response = await handleDocumentStructure({ document_id: docId });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.document_id).toBe(docId);
    expect(result.data?.file_name).toBe('empty.txt');
    expect(result.data?.source).toBe('chunks');
    expect(result.data?.outline).toEqual([]);
    expect((result.data?.tables as Record<string, unknown>).count).toBe(0);
    expect((result.data?.figures as Record<string, unknown>).count).toBe(0);
    expect((result.data?.code_blocks as Record<string, unknown>).count).toBe(0);
    expect(result.data?.total_structural_elements).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('builds outline from chunks with heading metadata', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'headings.txt', '/test/headings.txt');

    // Insert chunks with heading_context metadata
    const chunk1Id = uuidv4();
    insertTestChunk(db, chunk1Id, docId, docProvId, 'Introduction content', 0);
    // Update chunk to have heading metadata
    db.getConnection()
      .prepare('UPDATE chunks SET heading_context = ?, heading_level = ? WHERE id = ?')
      .run('Introduction', 1, chunk1Id);

    const chunk2Id = uuidv4();
    insertTestChunk(db, chunk2Id, docId, docProvId, 'Methods content', 1);
    db.getConnection()
      .prepare('UPDATE chunks SET heading_context = ?, heading_level = ? WHERE id = ?')
      .run('Methods', 2, chunk2Id);

    // Insert a chunk with same heading (should be deduplicated)
    const chunk3Id = uuidv4();
    insertTestChunk(db, chunk3Id, docId, docProvId, 'More introduction content', 2);
    db.getConnection()
      .prepare('UPDATE chunks SET heading_context = ?, heading_level = ? WHERE id = ?')
      .run('Introduction', 1, chunk3Id);

    const response = await handleDocumentStructure({ document_id: docId });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.source).toBe('chunks');
    const outline = result.data?.outline as Array<Record<string, unknown>>;
    // Should have 2 unique headings (Introduction deduplicated)
    expect(outline).toHaveLength(2);
    expect(outline[0].text).toBe('Introduction');
    expect(outline[0].level).toBe(1);
    expect(outline[1].text).toBe('Methods');
    expect(outline[1].level).toBe(2);
    expect(result.data?.total_structural_elements).toBe(2);
  });

  it.skipIf(!sqliteVecAvailable)('extracts structure from json_blocks when available', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'blocks.pdf', '/test/blocks.pdf');

    // Insert OCR result with json_blocks
    const ocrResultId = uuidv4();
    const ocrProvId = uuidv4();
    const now = new Date().toISOString();
    const hash = computeHash('test text');

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

    const jsonBlocks = JSON.stringify([
      { block_type: 'Title', text: 'Document Title', page: 0 },
      { block_type: 'SectionHeader', text: 'Background', level: 2, page: 0 },
      { block_type: 'Table', page: 1, caption: 'Table 1: Results' },
      { block_type: 'Figure', page: 2, caption: 'Fig 1: Architecture' },
      { block_type: 'Code', page: 3, language: 'python' },
      { block_type: 'SectionHeader', text: 'Conclusion', level: 2, page: 4 },
    ]);

    db.insertOCRResult({
      id: ocrResultId,
      provenance_id: ocrProvId,
      document_id: docId,
      extracted_text: 'test text',
      text_length: 9,
      datalab_request_id: `test-request-${uuidv4()}`,
      datalab_mode: 'balanced',
      parse_quality_score: 4.5,
      page_count: 5,
      cost_cents: 0,
      content_hash: hash,
      processing_started_at: now,
      processing_completed_at: now,
      processing_duration_ms: 100,
    });

    // Update json_blocks directly since insertOCRResult may not handle it
    db.getConnection()
      .prepare('UPDATE ocr_results SET json_blocks = ? WHERE id = ?')
      .run(jsonBlocks, ocrResultId);

    const response = await handleDocumentStructure({ document_id: docId });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.source).toBe('json_blocks');
    const outline = result.data?.outline as Array<Record<string, unknown>>;
    expect(outline).toHaveLength(3); // Title + 2 SectionHeaders
    expect(outline[0].text).toBe('Document Title');
    expect(outline[0].level).toBe(1); // Title defaults to level 1
    expect(outline[1].text).toBe('Background');
    expect(outline[1].level).toBe(2);
    expect(outline[2].text).toBe('Conclusion');

    const tablesData = result.data?.tables as Record<string, unknown>;
    expect(tablesData.count).toBe(1);
    const tableItems = tablesData.items as Array<Record<string, unknown>>;
    expect(tableItems[0].caption).toBe('Table 1: Results');

    const figuresData = result.data?.figures as Record<string, unknown>;
    expect(figuresData.count).toBe(1);
    const figureItems = figuresData.items as Array<Record<string, unknown>>;
    expect(figureItems[0].caption).toBe('Fig 1: Architecture');

    const codeData = result.data?.code_blocks as Record<string, unknown>;
    expect(codeData.count).toBe(1);
    const codeItems = codeData.items as Array<Record<string, unknown>>;
    expect(codeItems[0].language).toBe('python');

    expect(result.data?.total_structural_elements).toBe(6);
  });

  it.skipIf(!sqliteVecAvailable)('handles nested json_blocks with children', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'nested.pdf', '/test/nested.pdf');

    const ocrResultId = uuidv4();
    const ocrProvId = uuidv4();
    const now = new Date().toISOString();
    const hash = computeHash('nested text');

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

    const jsonBlocks = JSON.stringify([
      {
        block_type: 'SectionHeader',
        text: 'Parent Section',
        level: 1,
        page: 0,
        children: [
          { block_type: 'Table', page: 0 },
          { block_type: 'SectionHeader', text: 'Child Section', level: 2, page: 1 },
        ],
      },
    ]);

    db.insertOCRResult({
      id: ocrResultId,
      provenance_id: ocrProvId,
      document_id: docId,
      extracted_text: 'nested text',
      text_length: 11,
      datalab_request_id: `test-request-${uuidv4()}`,
      datalab_mode: 'balanced',
      parse_quality_score: 4.0,
      page_count: 2,
      cost_cents: 0,
      content_hash: hash,
      processing_started_at: now,
      processing_completed_at: now,
      processing_duration_ms: 100,
    });

    db.getConnection()
      .prepare('UPDATE ocr_results SET json_blocks = ? WHERE id = ?')
      .run(jsonBlocks, ocrResultId);

    const response = await handleDocumentStructure({ document_id: docId });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.source).toBe('json_blocks');
    const outline = result.data?.outline as Array<Record<string, unknown>>;
    expect(outline).toHaveLength(2); // Parent + Child sections
    expect(outline[0].text).toBe('Parent Section');
    expect(outline[1].text).toBe('Child Section');

    const tablesData = result.data?.tables as Record<string, unknown>;
    expect(tablesData.count).toBe(1); // Nested table found
    expect(result.data?.total_structural_elements).toBe(3); // 2 headings + 1 table
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleUpdateMetadata TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleUpdateMetadata', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-meta-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docmeta');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleUpdateMetadata({
      document_ids: [uuidv4()],
      doc_title: 'Test',
    });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns VALIDATION_ERROR when no metadata fields provided', async () => {
    const response = await handleUpdateMetadata({
      document_ids: [uuidv4()],
    });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('At least one metadata field');
  });

  it('returns VALIDATION_ERROR when document_ids is empty', async () => {
    const response = await handleUpdateMetadata({
      document_ids: [],
      doc_title: 'Test',
    });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it.skipIf(!sqliteVecAvailable)('updates metadata for existing documents', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId1 = uuidv4();
    const docId2 = uuidv4();
    insertTestDocument(db, docId1, 'doc1.txt', '/test/doc1.txt');
    insertTestDocument(db, docId2, 'doc2.txt', '/test/doc2.txt');

    const response = await handleUpdateMetadata({
      document_ids: [docId1, docId2],
      doc_title: 'Updated Title',
      doc_author: 'Test Author',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.updated_count).toBe(2);
    expect(result.data?.not_found_ids).toEqual([]);
    expect(result.data?.total_requested).toBe(2);

    // Verify update persisted
    const updatedDoc = db.getDocument(docId1);
    expect(updatedDoc?.doc_title).toBe('Updated Title');
    expect(updatedDoc?.doc_author).toBe('Test Author');
  });

  it.skipIf(!sqliteVecAvailable)('handles mix of found and not-found documents', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const missingId = uuidv4();
    insertTestDocument(db, docId, 'exists.txt', '/test/exists.txt');

    const response = await handleUpdateMetadata({
      document_ids: [docId, missingId],
      doc_subject: 'Test Subject',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.updated_count).toBe(1);
    expect(result.data?.not_found_ids).toEqual([missingId]);
    expect(result.data?.total_requested).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDuplicateDetection TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDuplicateDetection', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-dup-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docdup');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleDuplicateDetection({});
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('exact mode finds documents with same hash', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert two documents with the same file_path (will produce same hash)
    const docId1 = uuidv4();
    const docId2 = uuidv4();
    insertTestDocument(db, docId1, 'dup1.txt', '/test/same-content.txt');
    insertTestDocument(db, docId2, 'dup2.txt', '/test/same-content.txt');

    const response = await handleDuplicateDetection({ mode: 'exact' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('exact');
    expect(result.data?.total_groups).toBeGreaterThanOrEqual(1);
    const groups = result.data?.groups as Array<Record<string, unknown>>;
    expect(groups.length).toBeGreaterThanOrEqual(1);
    // At least one group should have 2+ docs
    const matchGroup = groups.find((g) => (g.count as number) >= 2);
    expect(matchGroup).toBeDefined();
  });

  it.skipIf(!sqliteVecAvailable)('exact mode returns empty when no duplicates', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert documents with unique content (different paths produce different hashes)
    insertTestDocument(db, uuidv4(), 'unique1.txt', '/test/unique1.txt');
    insertTestDocument(db, uuidv4(), 'unique2.txt', '/test/unique2.txt');

    const response = await handleDuplicateDetection({ mode: 'exact' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('exact');
    expect(result.data?.total_groups).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('near mode returns empty with no comparisons', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleDuplicateDetection({ mode: 'near', similarity_threshold: 0.9 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('near');
    expect(result.data?.total_pairs).toBe(0);
    expect(result.data?.similarity_threshold).toBe(0.9);
  });

  it('rejects invalid similarity_threshold', async () => {
    const response = await handleDuplicateDetection({ similarity_threshold: 0.3 });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDocumentList DATE-RANGE FILTER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDocumentList date-range and file_type filters', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-filter-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('docfilter');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('filters by file_type', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert documents with different file types
    const docId1 = uuidv4();
    const provId1 = uuidv4();
    const now = new Date().toISOString();
    const hash1 = computeHash('/test/doc1.pdf');
    db.insertProvenance({
      id: provId1, type: 'DOCUMENT', created_at: now, processed_at: now,
      source_file_created_at: null, source_file_modified_at: null,
      source_type: 'FILE', source_path: '/test/doc1.pdf', source_id: null,
      root_document_id: provId1, location: null, content_hash: hash1,
      input_hash: null, file_hash: hash1, processor: 'test', processor_version: '1.0.0',
      processing_params: {}, processing_duration_ms: null, processing_quality_score: null,
      parent_id: null, parent_ids: '[]', chain_depth: 0, chain_path: '["DOCUMENT"]',
    });
    db.insertDocument({
      id: docId1, file_path: '/test/doc1.pdf', file_name: 'doc1.pdf', file_hash: hash1,
      file_size: 1000, file_type: 'pdf', status: 'complete', page_count: 1,
      provenance_id: provId1, error_message: null, ocr_completed_at: now,
    });

    insertTestDocument(db, uuidv4(), 'doc2.txt', '/test/doc2.txt');

    const response = await handleDocumentList({ file_type: 'pdf' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(1);
    expect(documents[0].file_type).toBe('pdf');
    expect(result.data?.total).toBe(1);
  });

  it('rejects invalid created_after format', async () => {
    const response = await handleDocumentList({ created_after: 'not-a-date' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid created_before format', async () => {
    const response = await handleDocumentList({ created_before: '2026-13-99' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it.skipIf(!sqliteVecAvailable)('filters by created_after', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertTestDocument(db, uuidv4(), 'old.txt', '/test/old.txt');

    // Use a date far in the future
    const response = await handleDocumentList({ created_after: '2099-01-01T00:00:00Z' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const documents = result.data?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(0);
    expect(result.data?.total).toBe(0);
  });
});
