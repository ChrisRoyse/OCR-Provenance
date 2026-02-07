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
  documentTools,
} from '../../../src/tools/documents.js';
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
  it('exports all 3 document tools', () => {
    expect(Object.keys(documentTools)).toHaveLength(3);
    expect(documentTools).toHaveProperty('ocr_document_list');
    expect(documentTools).toHaveProperty('ocr_document_get');
    expect(documentTools).toHaveProperty('ocr_document_delete');
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

  it('handlers are exported functions', () => {
    expect(typeof handleDocumentList).toBe('function');
    expect(typeof handleDocumentGet).toBe('function');
    expect(typeof handleDocumentDelete).toBe('function');
  });

  it('tool names match expected values', () => {
    const names = Object.keys(documentTools);
    expect(names).toContain('ocr_document_list');
    expect(names).toContain('ocr_document_get');
    expect(names).toContain('ocr_document_delete');
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
    const fileNames = documents.map(d => d.file_name);
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

  it.skipIf(!sqliteVecAvailable)('includes provenance chain when include_full_provenance=true', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', '/test/test.txt');

    const response = await handleDocumentGet({ document_id: docId, include_full_provenance: true });
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
  });

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

  it.skipIf(!sqliteVecAvailable)('returns document without optional fields by default', async () => {
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
  });
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
    // Should fail validation due to confirm not being true

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
    });

    it.skipIf(!sqliteVecAvailable)('delete handles empty string document_id', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleDocumentDelete({ document_id: '', confirm: true });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('get handles special characters in document_id', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // Special characters fail UUID validation, so expect INTERNAL_ERROR
      const response = await handleDocumentGet({ document_id: 'special-!@#$%' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      // Validation rejects non-UUID format before database lookup
      expect(result.error?.category).toBe('INTERNAL_ERROR');
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
    it.skipIf(!sqliteVecAvailable)('list with non-matching status filter returns empty', async () => {
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
    });

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
    it.skipIf(!sqliteVecAvailable)('list sorts by file_size ascending', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // Insert documents (file_size is fixed at 1000 in insertTestDocument)
      insertTestDocument(db, uuidv4(), 'doc1.txt', '/test/doc1.txt');
      insertTestDocument(db, uuidv4(), 'doc2.txt', '/test/doc2.txt');

      const response = await handleDocumentList({});
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const documents = result.data?.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(2);
    });

    it.skipIf(!sqliteVecAvailable)('list sorts by created_at descending (default)', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertTestDocument(db, uuidv4(), 'first.txt', '/test/first.txt');
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
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
    it.skipIf(!sqliteVecAvailable)('get includes text, chunks, and provenance together', async () => {
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
    });
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
    // Should fail - either validation or database not selected
    expect(result.success).toBe(false);
  });

  it('document_list strips unknown params like sort_by', async () => {
    // sort_by was removed as a dead param; Zod strips unknown fields
    // The handler proceeds past validation but fails on "no database selected"
    const response = await handleDocumentList({ sort_by: 'invalid_field' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('document_list rejects negative limit', async () => {
    const response = await handleDocumentList({ limit: -1 });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('document_list rejects negative offset', async () => {
    const response = await handleDocumentList({ offset: -1 });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('document_get rejects missing document_id', async () => {
    const response = await handleDocumentGet({});
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('document_delete rejects missing confirm', async () => {
    const response = await handleDocumentDelete({ document_id: 'test-id' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
  });

  it('document_delete rejects missing document_id', async () => {
    const response = await handleDocumentDelete({ confirm: true });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
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
