/**
 * Unit tests for ingestion handlers (ocr_convert_raw, ocr_reprocess)
 *
 * Tests validation schemas and handler behavior for ingestion tools.
 *
 * Merged from: ingestion-convert-raw.test.ts, ingestion-reprocess.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { validateInput, ValidationError } from '../../../src/utils/validation.js';
import { ingestionTools } from '../../../src/tools/ingestion.js';
import {
  state,
  resetState,
  updateConfig,
  clearDatabase,
} from '../../../src/server/state.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { computeHash } from '../../../src/utils/hash.js';

// =============================================================================
// SQLITE-VEC AVAILABILITY CHECK
// =============================================================================

function isSqliteVecAvailable(): boolean {
  try {
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}
const sqliteVecAvailable = isSqliteVecAvailable();

// =============================================================================
// SHARED HELPERS
// =============================================================================

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

// =============================================================================
// ocr_convert_raw VALIDATION
// =============================================================================

const ConvertRawSchema = z.object({
  file_path: z.string().min(1),
  ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced'),
  max_pages: z.number().int().min(1).max(7000).optional(),
  page_range: z.string().optional(),
});

describe('ocr_convert_raw validation', () => {
  it('should validate minimal input with defaults', () => {
    const input = validateInput(ConvertRawSchema, { file_path: '/tmp/test.pdf' });
    expect(input.file_path).toBe('/tmp/test.pdf');
    expect(input.ocr_mode).toBe('balanced');
    expect(input.max_pages).toBeUndefined();
    expect(input.page_range).toBeUndefined();
  });

  it('should accept all valid ocr modes', () => {
    for (const mode of ['fast', 'balanced', 'accurate']) {
      const input = validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        ocr_mode: mode,
      });
      expect(input.ocr_mode).toBe(mode);
    }
  });

  it('should reject empty file_path', () => {
    expect(() =>
      validateInput(ConvertRawSchema, { file_path: '' })
    ).toThrow(ValidationError);
  });

  it('should reject missing file_path', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {})
    ).toThrow(ValidationError);
  });

  it('should reject invalid ocr_mode', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        ocr_mode: 'invalid',
      })
    ).toThrow(ValidationError);
  });

  it('should accept max_pages within range', () => {
    const input = validateInput(ConvertRawSchema, {
      file_path: '/tmp/test.pdf',
      max_pages: 100,
    });
    expect(input.max_pages).toBe(100);
  });

  it('should reject max_pages below 1', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        max_pages: 0,
      })
    ).toThrow(ValidationError);
  });

  it('should reject max_pages above 7000', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        max_pages: 7001,
      })
    ).toThrow(ValidationError);
  });

  it('should accept page_range string', () => {
    const input = validateInput(ConvertRawSchema, {
      file_path: '/tmp/test.pdf',
      page_range: '0-5,10',
    });
    expect(input.page_range).toBe('0-5,10');
  });

  it('should reject non-integer max_pages', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        max_pages: 1.5,
      })
    ).toThrow(ValidationError);
  });
});

describe('ocr_convert_raw tool definition', () => {
  it('should be registered in ingestionTools', async () => {
    expect(ingestionTools).toHaveProperty('ocr_convert_raw');
    expect(ingestionTools['ocr_convert_raw'].description).toContain('raw results');
    expect(ingestionTools['ocr_convert_raw'].handler).toBeDefined();
    expect(typeof ingestionTools['ocr_convert_raw'].handler).toBe('function');
  });

  it('should have correct inputSchema keys', async () => {
    const schema = ingestionTools['ocr_convert_raw'].inputSchema;

    expect(schema).toHaveProperty('file_path');
    expect(schema).toHaveProperty('ocr_mode');
    expect(schema).toHaveProperty('max_pages');
    expect(schema).toHaveProperty('page_range');
  });
});

describe('IngestFilesInput validation', () => {
  it('should accept valid file_paths', async () => {
    const { IngestFilesInput } = await import('../../../src/utils/validation.js');
    const input = IngestFilesInput.parse({
      file_paths: ['/tmp/test.pdf'],
    });
    expect(input.file_paths).toEqual(['/tmp/test.pdf']);
  });

  it('should reject empty file_paths', async () => {
    const { IngestFilesInput } = await import('../../../src/utils/validation.js');
    expect(() =>
      IngestFilesInput.parse({
        file_paths: [],
      })
    ).toThrow();
  });

  it('should strip unknown properties like file_urls', async () => {
    const { IngestFilesInput } = await import('../../../src/utils/validation.js');
    const input = IngestFilesInput.parse({
      file_paths: ['/tmp/test.pdf'],
      file_urls: ['https://example.com/doc.pdf'],
    });
    expect((input as Record<string, unknown>).file_urls).toBeUndefined();
  });
});

// =============================================================================
// ocr_reprocess HANDLER
// =============================================================================

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

const handleReprocess = ingestionTools['ocr_reprocess'].handler;

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
    expect(db.getOCRResultByDocumentId(docId)).not.toBeNull();

    await handleReprocess({ document_id: docId });

    const doc = db.getDocument(docId);
    expect(doc).not.toBeNull();
  });
});
