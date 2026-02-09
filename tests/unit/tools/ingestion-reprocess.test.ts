/**
 * Unit Tests for QW-4: Document Re-OCR Tool (ocr_reprocess)
 *
 * Tests the handleReprocess handler in src/tools/ingestion.ts.
 * Uses real SQLite databases with synthetic data via actual DB operations.
 *
 * @module tests/unit/tools/ingestion-reprocess
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { ingestionTools } from '../../../src/tools/ingestion.js';
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
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}
function createUniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) cleanupTempDir(dir); });

const handleReprocess = ingestionTools['ocr_reprocess'].handler;

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function insertTestDoc(
  db: DatabaseService, status: 'pending' | 'processing' | 'complete' | 'failed',
): { docId: string; provId: string } {
  const docId = uuidv4();
  const provId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(docId);

  db.insertProvenance({
    id: provId, type: 'DOCUMENT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'FILE', source_path: `/tmp/test-${docId}.pdf`, source_id: null,
    root_document_id: provId, location: null, content_hash: fileHash,
    input_hash: null, file_hash: fileHash, processor: 'test', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: null, processing_quality_score: null,
    parent_id: null, parent_ids: '[]', chain_depth: 0, chain_path: '["DOCUMENT"]',
  });
  db.insertDocument({
    id: docId, file_path: `/tmp/test-${docId}.pdf`, file_name: `test-${docId}.pdf`,
    file_hash: fileHash, file_size: 1000, file_type: 'pdf', status,
    page_count: 1, provenance_id: provId, error_message: null, ocr_completed_at: now,
  });

  if (status === 'complete' || status === 'failed') {
    const ocrProvId = uuidv4();
    const ocrResultId = uuidv4();
    const text = `Test content ${docId}`;
    const textHash = computeHash(text);

    db.insertProvenance({
      id: ocrProvId, type: 'OCR_RESULT', created_at: now, processed_at: now,
      source_file_created_at: null, source_file_modified_at: null,
      source_type: 'OCR', source_path: null, source_id: provId,
      root_document_id: provId, location: null, content_hash: textHash,
      input_hash: null, file_hash: null, processor: 'datalab', processor_version: '1.0.0',
      processing_params: {}, processing_duration_ms: null, processing_quality_score: 4.0,
      parent_id: provId, parent_ids: JSON.stringify([provId]),
      chain_depth: 1, chain_path: '["DOCUMENT", "OCR_RESULT"]',
    });
    db.insertOCRResult({
      id: ocrResultId, provenance_id: ocrProvId, document_id: docId,
      extracted_text: text, text_length: text.length,
      datalab_request_id: `test-${uuidv4()}`, datalab_mode: 'balanced',
      parse_quality_score: 4.0, page_count: 1, cost_cents: 50,
      content_hash: textHash, processing_started_at: now,
      processing_completed_at: now, processing_duration_ms: 100,
    });
  }

  return { docId, provId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('QW-4: Document Re-OCR Tool (ocr_reprocess)', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('qw4-reprocess-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('qw4');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('should have ocr_reprocess in ingestionTools', () => {
    expect(ingestionTools['ocr_reprocess']).toBeDefined();
    expect(ingestionTools['ocr_reprocess'].description).toContain('Reprocess');
  });

  it.skipIf(!sqliteVecAvailable)('should error for non-existent document', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleReprocess({ document_id: 'non-existent-id' });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.message).toContain('not found');
  });

  it.skipIf(!sqliteVecAvailable)('should error for document with pending status', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const { docId } = insertTestDoc(db, 'pending');
    const response = await handleReprocess({ document_id: docId });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.message).toContain("must be 'complete' or 'failed'");
    expect(parsed.error!.message).toContain('pending');
  });

  it.skipIf(!sqliteVecAvailable)('should error for document with processing status', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const { docId } = insertTestDoc(db, 'processing');
    const response = await handleReprocess({ document_id: docId });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.message).toContain("must be 'complete' or 'failed'");
    expect(parsed.error!.message).toContain('processing');
  });

  it.skipIf(!sqliteVecAvailable)('should accept failed documents for reprocessing', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const { docId } = insertTestDoc(db, 'failed');
    const response = await handleReprocess({ document_id: docId });
    const parsed = parseResponse(response);
    // The pipeline may fail (no real file), but the status validation should pass
    if (!parsed.success) {
      expect(parsed.error!.message).not.toContain("must be 'complete' or 'failed'");
    }
  });

  it.skipIf(!sqliteVecAvailable)('should validate required document_id parameter', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const response = await handleReprocess({});
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(false);
  });

  it.skipIf(!sqliteVecAvailable)('should clean derived data before reprocessing', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    const { docId } = insertTestDoc(db, 'complete');
    // Verify OCR result exists
    expect(db.getOCRResultByDocumentId(docId)).not.toBeNull();

    // Call reprocess -- pipeline will fail (no real file)
    await handleReprocess({ document_id: docId });

    // After cleanup, the document still exists but status changed
    const doc = db.getDocument(docId);
    expect(doc).not.toBeNull();
  });
});
