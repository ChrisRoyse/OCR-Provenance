/**
 * Unit Tests for QW-3: Cost Analytics Tool (ocr_cost_summary)
 *
 * Tests the handleCostSummary handler in src/tools/reports.ts.
 * Uses real SQLite databases with synthetic data via actual DB operations.
 *
 * @module tests/unit/tools/reports-cost
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { reportTools } from '../../../src/tools/reports.js';
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

const handleCostSummary = reportTools['ocr_cost_summary'].handler;

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function insertDocWithOCR(
  db: DatabaseService,
  costCents: number,
  mode: string,
  completedAt: string,
  fileName?: string
): string {
  const docId = uuidv4();
  const provId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(docId);
  const text = `document content for ${docId}`;
  const textHash = computeHash(text);

  db.insertProvenance({
    id: provId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: `/tmp/${fileName || docId}.pdf`,
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
    file_path: `/tmp/${fileName || docId}.pdf`,
    file_name: fileName || `${docId}.pdf`,
    file_hash: fileHash,
    file_size: 1000,
    file_type: 'pdf',
    status: 'complete',
    page_count: 5,
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
    extracted_text: text,
    text_length: text.length,
    datalab_request_id: `test-${uuidv4()}`,
    datalab_mode: mode as 'fast' | 'balanced' | 'accurate',
    parse_quality_score: 4.0,
    page_count: 5,
    cost_cents: costCents,
    content_hash: textHash,
    processing_started_at: now,
    processing_completed_at: completedAt,
    processing_duration_ms: 100,
  });

  return docId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('QW-3: Cost Analytics Tool (ocr_cost_summary)', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('qw3-cost-summary-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('qw3');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('should have ocr_cost_summary in reportTools', () => {
    expect(reportTools['ocr_cost_summary']).toBeDefined();
    expect(reportTools['ocr_cost_summary'].description).toContain('cost');
  });

  it.skipIf(!sqliteVecAvailable)(
    'should return zeros for empty database with group_by=total',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleCostSummary({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.total_cost_cents).toBe(0);
      expect(parsed.data!.total_cost_dollars).toBe('0.00');
      expect((parsed.data!.ocr as Record<string, unknown>).total_cents).toBe(0);
      expect((parsed.data!.form_fill as Record<string, unknown>).total_cents).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)('should return correct totals with group_by=total', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertDocWithOCR(db, 150, 'accurate', '2026-01-15T10:00:00Z');
    insertDocWithOCR(db, 50, 'fast', '2026-01-15T11:00:00Z');

    const response = await handleCostSummary({ group_by: 'total' });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.total_cost_cents).toBe(200);
    expect(parsed.data!.total_cost_dollars).toBe('2.00');
    expect((parsed.data!.ocr as Record<string, unknown>).total_cents).toBe(200);
    expect((parsed.data!.ocr as Record<string, unknown>).document_count).toBe(2);
  });

  it.skipIf(!sqliteVecAvailable)('should group by mode correctly', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertDocWithOCR(db, 150, 'accurate', '2026-01-15T10:00:00Z');
    insertDocWithOCR(db, 100, 'accurate', '2026-01-15T11:00:00Z');
    insertDocWithOCR(db, 50, 'fast', '2026-01-15T12:00:00Z');

    const response = await handleCostSummary({ group_by: 'mode' });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    const byMode = parsed.data!.by_mode as Array<Record<string, unknown>>;
    expect(byMode).toBeDefined();
    expect(byMode.length).toBe(2);

    const accurateRow = byMode.find((r) => r.mode === 'accurate');
    expect(accurateRow).toBeDefined();
    expect(accurateRow!.count).toBe(2);
    expect(accurateRow!.total_cents).toBe(250);

    const fastRow = byMode.find((r) => r.mode === 'fast');
    expect(fastRow).toBeDefined();
    expect(fastRow!.count).toBe(1);
    expect(fastRow!.total_cents).toBe(50);
  });

  it.skipIf(!sqliteVecAvailable)('should group by document correctly', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertDocWithOCR(db, 300, 'accurate', '2026-01-15T10:00:00Z', 'expensive.pdf');
    insertDocWithOCR(db, 50, 'fast', '2026-01-15T11:00:00Z', 'cheap.pdf');

    const response = await handleCostSummary({ group_by: 'document' });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    const byDoc = parsed.data!.by_document as Array<Record<string, unknown>>;
    expect(byDoc).toBeDefined();
    expect(byDoc.length).toBe(2);
    expect(byDoc[0].file_name).toBe('expensive.pdf');
    expect(byDoc[0].cost_cents).toBe(300);
    expect(byDoc[1].file_name).toBe('cheap.pdf');
    expect(byDoc[1].cost_cents).toBe(50);
  });

  it.skipIf(!sqliteVecAvailable)('should group by month correctly', async () => {
    const db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    insertDocWithOCR(db, 100, 'accurate', '2026-01-15T10:00:00Z');
    insertDocWithOCR(db, 200, 'accurate', '2026-01-20T10:00:00Z');
    insertDocWithOCR(db, 75, 'fast', '2026-02-05T10:00:00Z');

    const response = await handleCostSummary({ group_by: 'month' });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    const byMonth = parsed.data!.by_month as Array<Record<string, unknown>>;
    expect(byMonth).toBeDefined();
    expect(byMonth.length).toBe(2);
    expect(byMonth[0].month).toBe('2026-02');
    expect(byMonth[0].total_cents).toBe(75);
    expect(byMonth[1].month).toBe('2026-01');
    expect(byMonth[1].total_cents).toBe(300);
  });

  it.skipIf(!sqliteVecAvailable)(
    'should exclude zero-cost documents from grouped results',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, 0, 'fast', '2026-01-15T10:00:00Z');
      insertDocWithOCR(db, 100, 'accurate', '2026-01-15T10:00:00Z');

      const response = await handleCostSummary({ group_by: 'mode' });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      const byMode = parsed.data!.by_mode as Array<Record<string, unknown>>;
      expect(byMode.length).toBe(1);
      expect(byMode[0].mode).toBe('accurate');
    }
  );
});
