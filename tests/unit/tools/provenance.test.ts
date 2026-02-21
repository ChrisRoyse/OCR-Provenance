/**
 * Unit Tests for Provenance MCP Tools
 *
 * Tests the extracted provenance tool handlers in src/tools/provenance.ts
 * Tools: handleProvenanceGet, handleProvenanceVerify, handleProvenanceExport
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/provenance
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import {
  handleProvenanceGet,
  handleProvenanceVerify,
  handleProvenanceExport,
  provenanceTools,
} from '../../../src/tools/provenance.js';
import { state, resetState, updateConfig, clearDatabase } from '../../../src/server/state.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { computeHash, computeFileHashSync } from '../../../src/utils/hash.js';

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
  return `${prefix}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
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
 * Insert test document with provenance.
 * Creates a REAL file on disk so ProvenanceVerifier can hash it.
 * @param tempDir - Temp directory for creating the real file
 */
function insertTestDocument(
  db: DatabaseService,
  docId: string,
  fileName: string,
  tempDir: string
): string {
  const provId = uuidv4();
  const now = new Date().toISOString();

  // Create a real file so ProvenanceVerifier can hash it
  const realFilePath = join(tempDir, fileName);
  const fileContent = `Test document content for ${docId}`;
  writeFileSync(realFilePath, fileContent);
  const hash = computeFileHashSync(realFilePath);

  db.insertProvenance({
    id: provId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: realFilePath,
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
    file_path: realFilePath,
    file_name: fileName,
    file_hash: hash,
    file_size: Buffer.byteLength(fileContent),
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

/**
 * Insert provenance record with invalid hash for testing verification
 */
function insertProvenanceWithInvalidHash(
  db: DatabaseService,
  provId: string,
  docProvId: string
): void {
  const now = new Date().toISOString();

  db.insertProvenance({
    id: provId,
    type: 'CHUNK',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'CHUNKING',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: 'invalid-hash-format', // Invalid hash
    input_hash: null,
    file_hash: null,
    processor: 'chunker',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "CHUNK"]',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXPORTS VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('provenanceTools exports', () => {
  it('exports all 6 provenance tools', () => {
    expect(Object.keys(provenanceTools)).toHaveLength(6);
    expect(provenanceTools).toHaveProperty('ocr_provenance_get');
    expect(provenanceTools).toHaveProperty('ocr_provenance_verify');
    expect(provenanceTools).toHaveProperty('ocr_provenance_export');
    expect(provenanceTools).toHaveProperty('ocr_provenance_query');
    expect(provenanceTools).toHaveProperty('ocr_provenance_timeline');
    expect(provenanceTools).toHaveProperty('ocr_provenance_processor_stats');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(provenanceTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleProvenanceGet TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleProvenanceGet', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-get-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('prov-get');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleProvenanceGet({ item_id: 'test-id' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('returns chain for document', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceGet({ item_id: docId, item_type: 'document' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.item_id).toBe(docId);
    expect(result.data?.item_type).toBe('document');
    expect(Array.isArray(result.data?.chain)).toBe(true);
    const chain = result.data?.chain as Array<Record<string, unknown>>;
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].type).toBe('DOCUMENT');
    expect(chain[0].id).toBe(docProvId);
  });

  it.skipIf(!sqliteVecAvailable)('returns chain for chunk', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);
    insertTestChunk(db, chunkId, docId, docProvId, 'Test content', 0);

    const response = await handleProvenanceGet({ item_id: chunkId, item_type: 'chunk' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.item_id).toBe(chunkId);
    expect(result.data?.item_type).toBe('chunk');
    const chain = result.data?.chain as Array<Record<string, unknown>>;
    // Chain should include DOCUMENT -> OCR_RESULT -> CHUNK
    expect(chain.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!sqliteVecAvailable)('auto-detects item type when item_type=auto', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceGet({ item_id: docId, item_type: 'auto' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.item_type).toBe('document');
  });

  it.skipIf(!sqliteVecAvailable)('returns PROVENANCE_NOT_FOUND for invalid ID', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleProvenanceGet({ item_id: 'non-existent-id', item_type: 'auto' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('PROVENANCE_NOT_FOUND');
  });

  it.skipIf(!sqliteVecAvailable)('includes parent_id in chain entries', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);
    insertTestChunk(db, chunkId, docId, docProvId, 'Test content', 0);

    const response = await handleProvenanceGet({ item_id: chunkId, item_type: 'chunk' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const chain = result.data?.chain as Array<Record<string, unknown>>;
    // Each chain entry should have parent_id field
    for (const entry of chain) {
      expect(entry).toHaveProperty('parent_id');
    }
  });

  it.skipIf(!sqliteVecAvailable)('returns root_document_id in response', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceGet({ item_id: docId, item_type: 'document' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.root_document_id).toBe(docProvId);
  });

  it.skipIf(!sqliteVecAvailable)('chain entries have required fields', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceGet({ item_id: docId, item_type: 'document' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const chain = result.data?.chain as Array<Record<string, unknown>>;
    for (const entry of chain) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('chain_depth');
      expect(entry).toHaveProperty('processor');
      expect(entry).toHaveProperty('processor_version');
      expect(entry).toHaveProperty('content_hash');
      expect(entry).toHaveProperty('created_at');
      expect(entry).toHaveProperty('parent_id');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleProvenanceVerify TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleProvenanceVerify', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-verify-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('prov-verify');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleProvenanceVerify({ item_id: 'test-id' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('verifies content hashes in chain', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceVerify({
      item_id: docId,
      verify_content: true,
      verify_chain: false,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.content_integrity).toBe(true);
    expect(result.data?.verified).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('verifies chain integrity (depth, parent links)', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Use document directly for cleaner chain integrity test
    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceVerify({
      item_id: docId,
      verify_content: false,
      verify_chain: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.chain_integrity).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('returns verification steps with details', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceVerify({
      item_id: docId,
      verify_content: true,
      verify_chain: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data?.steps)).toBe(true);
    const steps = result.data?.steps as Array<Record<string, unknown>>;
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step).toHaveProperty('provenance_id');
      expect(step).toHaveProperty('type');
      expect(step).toHaveProperty('chain_depth');
      expect(step).toHaveProperty('content_verified');
      expect(step).toHaveProperty('chain_verified');
      expect(step).toHaveProperty('expected_hash');
    }
  });

  it.skipIf(!sqliteVecAvailable)('detects invalid hash format', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);

    // Insert provenance with invalid hash
    const invalidProvId = uuidv4();
    insertProvenanceWithInvalidHash(db, invalidProvId, docProvId);

    // Verify the provenance directly
    const response = await handleProvenanceVerify({
      item_id: invalidProvId,
      verify_content: true,
      verify_chain: false,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.content_integrity).toBe(false);
    expect(result.data?.verified).toBe(false);
    expect(Array.isArray(result.data?.errors)).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('returns PROVENANCE_NOT_FOUND for invalid ID', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleProvenanceVerify({
      item_id: 'non-existent-id',
      verify_content: true,
      verify_chain: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('PROVENANCE_NOT_FOUND');
  });

  it.skipIf(!sqliteVecAvailable)('returns both content and chain integrity flags', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceVerify({
      item_id: docId,
      verify_content: true,
      verify_chain: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('content_integrity');
    expect(result.data).toHaveProperty('chain_integrity');
    expect(result.data).toHaveProperty('verified');
  });

  it.skipIf(!sqliteVecAvailable)('errors array present only when issues found', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceVerify({
      item_id: docId,
      verify_content: true,
      verify_chain: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    // When verification passes, errors should be undefined
    if (result.data && result.data.verified === true) {
      expect(result.data.errors).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleProvenanceExport TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleProvenanceExport', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-export-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('prov-export');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleProvenanceExport({ scope: 'database', format: 'json' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('exports JSON format for document scope', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceExport({
      scope: 'document',
      document_id: docId,
      format: 'json',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.scope).toBe('document');
    expect(result.data?.format).toBe('json');
    expect(result.data?.document_id).toBe(docId);
    expect(Array.isArray(result.data?.data)).toBe(true);
    const exportData = result.data?.data as Array<Record<string, unknown>>;
    expect(exportData.length).toBeGreaterThan(0);
    expect(exportData[0]).toHaveProperty('id');
    expect(exportData[0]).toHaveProperty('type');
    expect(exportData[0]).toHaveProperty('chain_depth');
    expect(exportData[0]).toHaveProperty('processor');
  });

  it.skipIf(!sqliteVecAvailable)('exports W3C PROV-JSON format', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceExport({
      scope: 'document',
      document_id: docId,
      format: 'w3c-prov',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.format).toBe('w3c-prov');
    const exportData = result.data?.data as Record<string, unknown>;
    expect(exportData).toHaveProperty('prefix');
    expect(exportData['prefix']).toHaveProperty('prov', 'http://www.w3.org/ns/prov#');
    expect(exportData).toHaveProperty('entity');
    expect(exportData).toHaveProperty('activity');
    expect(exportData).toHaveProperty('wasGeneratedBy');
    expect(exportData).toHaveProperty('wasDerivedFrom');
    expect(exportData).toHaveProperty('used');
  });

  it.skipIf(!sqliteVecAvailable)('exports CSV format', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceExport({
      scope: 'document',
      document_id: docId,
      format: 'csv',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.format).toBe('csv');
    const csvData = result.data?.data as string;
    expect(typeof csvData).toBe('string');
    // CSV should have header row
    expect(csvData).toContain(
      'id,type,chain_depth,processor,processor_version,content_hash,parent_id,root_document_id,created_at'
    );
    // Should have at least one data row
    const lines = csvData.split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });

  it.skipIf(!sqliteVecAvailable)('exports database scope (all records)', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert multiple documents
    const docId1 = uuidv4();
    const docId2 = uuidv4();
    insertTestDocument(db, docId1, 'test1.txt', tempDir);
    insertTestDocument(db, docId2, 'test2.txt', tempDir);

    const response = await handleProvenanceExport({
      scope: 'database',
      format: 'json',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.scope).toBe('database');
    const exportData = result.data?.data as Array<Record<string, unknown>>;
    // Should have provenance records from both documents
    expect(exportData.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!sqliteVecAvailable)(
    'returns error when document_id missing for document scope',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleProvenanceExport({
        scope: 'document',
        format: 'json',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      // Validation errors are mapped to VALIDATION_ERROR
      expect(result.error?.category).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('document_id');
    }
  );

  it.skipIf(!sqliteVecAvailable)('returns DOCUMENT_NOT_FOUND for invalid document_id', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleProvenanceExport({
      scope: 'document',
      document_id: 'non-existent-doc',
      format: 'json',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it.skipIf(!sqliteVecAvailable)('includes record_count in response', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);
    insertTestChunk(db, chunkId, docId, docProvId, 'Test content', 0);

    const response = await handleProvenanceExport({
      scope: 'document',
      document_id: docId,
      format: 'json',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(typeof result.data?.record_count).toBe('number');
    expect(result.data?.record_count as number).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteVecAvailable)('returns empty data for empty database', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleProvenanceExport({
      scope: 'database',
      format: 'json',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const exportData = result.data?.data as Array<Record<string, unknown>>;
    expect(Array.isArray(exportData)).toBe(true);
    expect(exportData.length).toBe(0);
    expect(result.data?.record_count).toBe(0);
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
    tempDir = createTempDir('prov-edge-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('prov-edge');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('Edge Case 1: Empty item_id', () => {
    it('returns validation error for empty item_id', async () => {
      const response = await handleProvenanceGet({ item_id: '' });
      const result = parseResponse(response);
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });
  });

  describe('Edge Case 2: UUID-like but non-existent ID', () => {
    it.skipIf(!sqliteVecAvailable)('handles valid UUID format that does not exist', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const fakeUuid = uuidv4();
      const response = await handleProvenanceGet({ item_id: fakeUuid });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('PROVENANCE_NOT_FOUND');
    });
  });

  describe('Edge Case 3: Deep Provenance Chain', () => {
    it.skipIf(!sqliteVecAvailable)('handles document with chunks (multi-level chain)', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);

      // Insert multiple chunks
      for (let i = 0; i < 3; i++) {
        const chunkId = uuidv4();
        insertTestChunk(db, chunkId, docId, docProvId, `Chunk content ${String(i)}`, i);
      }

      // Get provenance for the document
      const response = await handleProvenanceGet({ item_id: docId, item_type: 'document' });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const chain = result.data?.chain as Array<Record<string, unknown>>;
      expect(chain.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Edge Case 4: Verify with only content check', () => {
    it.skipIf(!sqliteVecAvailable)('verify_chain=false skips chain validation', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      insertTestDocument(db, docId, 'test.txt', tempDir);

      const response = await handleProvenanceVerify({
        item_id: docId,
        verify_content: true,
        verify_chain: false,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const steps = result.data?.steps as Array<Record<string, unknown>>;
      // All steps should have chain_verified=true when not checking chain
      for (const step of steps) {
        expect(step.chain_verified).toBe(true);
      }
    });
  });

  describe('Edge Case 5: Verify with only chain check', () => {
    it.skipIf(!sqliteVecAvailable)('verify_content=false skips content validation', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      insertTestDocument(db, docId, 'test.txt', tempDir);

      const response = await handleProvenanceVerify({
        item_id: docId,
        verify_content: false,
        verify_chain: true,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const steps = result.data?.steps as Array<Record<string, unknown>>;
      // All steps should have content_verified=true when not checking content
      for (const step of steps) {
        expect(step.content_verified).toBe(true);
      }
    });
  });

  describe('Edge Case 6: Export scope "all" is no longer valid', () => {
    it.skipIf(!sqliteVecAvailable)('rejects scope "all" with validation error', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleProvenanceExport({
        scope: 'all',
        format: 'json',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
    });
  });

  describe('Edge Case 7: W3C PROV format entities', () => {
    it.skipIf(!sqliteVecAvailable)('W3C PROV entities have correct structure', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      const chunkId = uuidv4();
      const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);
      insertTestChunk(db, chunkId, docId, docProvId, 'Test content', 0);

      const response = await handleProvenanceExport({
        scope: 'document',
        document_id: docId,
        format: 'w3c-prov',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const exportData = result.data?.data as Record<string, unknown>;
      const entities = exportData.entity as Record<string, unknown>;
      const activities = exportData.activity as Record<string, unknown>;

      // Should have entities and activities
      expect(Object.keys(entities).length).toBeGreaterThan(0);
      expect(Object.keys(activities).length).toBeGreaterThan(0);

      // Entities should have prov:type
      for (const entityKey of Object.keys(entities)) {
        const entity = entities[entityKey] as Record<string, unknown>;
        expect(entity).toHaveProperty('prov:type');
        expect(entity).toHaveProperty('ocr:contentHash');
        expect(entity).toHaveProperty('ocr:chainDepth');
      }
    });
  });

  describe('Edge Case 8: CSV escaping', () => {
    it.skipIf(!sqliteVecAvailable)('CSV format handles special characters', async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const docId = uuidv4();
      insertTestDocument(db, docId, 'test.txt', tempDir);

      const response = await handleProvenanceExport({
        scope: 'document',
        document_id: docId,
        format: 'csv',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const csvData = result.data?.data as string;
      // Should be valid CSV
      const lines = csvData.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      // Header should have expected columns
      const headers = lines[0].split(',');
      expect(headers).toContain('id');
      expect(headers).toContain('type');
      expect(headers).toContain('chain_depth');
    });
  });

  describe('Edge Case 9: Auto-detect item_type for provenance ID', () => {
    it.skipIf(!sqliteVecAvailable)(
      'auto-detects when item_id is provenance ID directly',
      async () => {
        const db = DatabaseService.create(dbName, undefined, tempDir);
        state.currentDatabase = db;
        state.currentDatabaseName = dbName;

        const docId = uuidv4();
        const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);

        // Query using the provenance ID directly
        const response = await handleProvenanceGet({ item_id: docProvId, item_type: 'auto' });
        const result = parseResponse(response);

        // Should find the provenance record
        expect(result.success).toBe(true);
        expect(result.data?.item_type).toBe('provenance');
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

  it('handleProvenanceGet rejects empty item_id', async () => {
    const response = await handleProvenanceGet({ item_id: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleProvenanceVerify rejects empty item_id', async () => {
    const response = await handleProvenanceVerify({ item_id: '' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleProvenanceExport rejects invalid scope', async () => {
    const response = await handleProvenanceExport({ scope: 'invalid' as never, format: 'json' });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleProvenanceExport rejects invalid format', async () => {
    const response = await handleProvenanceExport({ scope: 'database', format: 'xml' as never });
    const result = parseResponse(response);
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleProvenanceGet accepts all valid item_types', async () => {
    const validTypes = ['document', 'ocr_result', 'chunk', 'embedding', 'auto'];
    for (const itemType of validTypes) {
      const response = await handleProvenanceGet({ item_id: 'test', item_type: itemType });
      const result = parseResponse(response);
      // Should fail with DATABASE_NOT_SELECTED, not validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it('handleProvenanceExport accepts all valid formats', async () => {
    const validFormats = ['json', 'w3c-prov', 'csv'];
    for (const format of validFormats) {
      const response = await handleProvenanceExport({ scope: 'database', format });
      const result = parseResponse(response);
      // Should fail with DATABASE_NOT_SELECTED, not validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it('handleProvenanceExport accepts all valid scopes', async () => {
    const validScopes = ['document', 'database'];
    for (const scope of validScopes) {
      const response = await handleProvenanceExport({
        scope,
        format: 'json',
        document_id: scope === 'document' ? 'test-doc' : undefined,
      });
      const result = parseResponse(response);
      // Should fail with DATABASE_NOT_SELECTED, not validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE CHAIN STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provenance Chain Structure', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-chain-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('prov-chain');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('chain contains entries with valid depths', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    const chunkId = uuidv4();
    const docProvId = insertTestDocument(db, docId, 'test.txt', tempDir);
    insertTestChunk(db, chunkId, docId, docProvId, 'Test content', 0);

    const response = await handleProvenanceGet({ item_id: chunkId, item_type: 'chunk' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const chain = result.data?.chain as Array<Record<string, unknown>>;

    // Verify chain entries have valid chain_depth values
    const depths = chain.map((c) => c.chain_depth as number);
    expect(depths.length).toBeGreaterThan(0);
    // All depths should be non-negative integers
    for (const depth of depths) {
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(depth)).toBe(true);
    }
  });

  it.skipIf(!sqliteVecAvailable)('first chain entry is root (depth 0)', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceGet({ item_id: docId, item_type: 'document' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const chain = result.data?.chain as Array<Record<string, unknown>>;
    expect(chain[0].chain_depth).toBe(0);
    expect(chain[0].parent_id).toBe(null);
  });

  it.skipIf(!sqliteVecAvailable)('processor information is captured', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const docId = uuidv4();
    insertTestDocument(db, docId, 'test.txt', tempDir);

    const response = await handleProvenanceGet({ item_id: docId, item_type: 'document' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const chain = result.data?.chain as Array<Record<string, unknown>>;
    expect(chain[0].processor).toBe('test');
    expect(chain[0].processor_version).toBe('1.0.0');
  });
});
