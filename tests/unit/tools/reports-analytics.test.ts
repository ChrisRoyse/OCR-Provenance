/**
 * Unit Tests for Analytics Report Tools
 *
 * Tests: handlePipelineAnalytics, handleCorpusProfile, handleErrorAnalytics
 * in src/tools/reports.ts using real SQLite databases with synthetic data.
 *
 * @module tests/unit/tools/reports-analytics
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import {
  handlePipelineAnalytics,
  handleCorpusProfile,
  handleErrorAnalytics,
} from '../../../src/tools/reports.js';
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

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function insertDocWithOCR(
  db: DatabaseService,
  opts: {
    costCents?: number;
    mode?: string;
    durationMs?: number;
    pageCount?: number;
    quality?: number;
    fileType?: string;
    fileName?: string;
    status?: string;
    errorMessage?: string | null;
  } = {}
): { docId: string; ocrResultId: string; docProvId: string } {
  const {
    costCents = 10,
    mode = 'balanced',
    durationMs = 500,
    pageCount = 5,
    quality = 4.0,
    fileType = 'pdf',
    fileName,
    status = 'complete',
    errorMessage = null,
  } = opts;

  const docId = uuidv4();
  const provId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(docId);
  const text = `document content for ${docId}`;
  const textHash = computeHash(text);
  const actualFileName = fileName || `${docId}.${fileType}`;

  db.insertProvenance({
    id: provId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: `/tmp/${actualFileName}`,
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
    file_path: `/tmp/${actualFileName}`,
    file_name: actualFileName,
    file_hash: fileHash,
    file_size: 10000,
    file_type: fileType,
    status: status as 'pending' | 'processing' | 'complete' | 'failed',
    page_count: pageCount,
    provenance_id: provId,
    error_message: errorMessage,
    ocr_completed_at: status === 'complete' ? now : null,
  });

  if (status === 'complete' || status === 'failed') {
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
      processing_duration_ms: durationMs,
      processing_quality_score: quality,
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
      parse_quality_score: quality,
      page_count: pageCount,
      cost_cents: costCents,
      content_hash: textHash,
      processing_started_at: now,
      processing_completed_at: now,
      processing_duration_ms: durationMs,
    });
  }

  return { docId, ocrResultId, docProvId: provId };
}

function insertChunk(
  db: DatabaseService,
  docId: string,
  ocrResultId: string,
  docProvId: string,
  opts: {
    headingContext?: string | null;
    contentTypes?: string[];
    isAtomic?: boolean;
    chunkIndex?: number;
    text?: string;
  } = {}
): string {
  const {
    headingContext = null,
    contentTypes = [],
    isAtomic = false,
    chunkIndex = 0,
    text = 'Some chunk text content here.',
  } = opts;
  const chunkId = uuidv4();
  const chunkProvId = uuidv4();
  const now = new Date().toISOString();
  const textHash = computeHash(text);

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
    location: null,
    content_hash: textHash,
    input_hash: null,
    file_hash: null,
    processor: 'chunker',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 10,
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
    text_hash: textHash,
    chunk_index: chunkIndex,
    character_start: 0,
    character_end: text.length,
    page_number: 1,
    page_range: null,
    overlap_previous: 0,
    overlap_next: 0,
    provenance_id: chunkProvId,
    ocr_quality_score: 4.0,
    heading_context: headingContext,
    heading_level: headingContext ? 2 : null,
    section_path: headingContext ? `["${headingContext}"]` : null,
    content_types: JSON.stringify(contentTypes),
    is_atomic: isAtomic ? 1 : 0,
    chunking_strategy: 'hybrid_section',
  });

  return chunkId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// handlePipelineAnalytics TESTS (with real DB)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pipeline Analytics (ocr_pipeline_analytics) with DB', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('analytics-pipeline-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('pipeline');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)(
    'should return zeros for empty database with group_by=total',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handlePipelineAnalytics({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const ocr = parsed.data!.ocr as Record<string, unknown>;
      expect(ocr.total_docs).toBe(0);
      expect(ocr.total_pages).toBe(0);

      const embeddings = parsed.data!.embeddings as Record<string, unknown>;
      expect(embeddings.total_embeddings).toBe(0);

      const vlm = parsed.data!.vlm as Record<string, unknown>;
      expect(vlm.total_images).toBe(0);

      const throughput = parsed.data!.throughput as Record<string, unknown>;
      expect(throughput.pages_per_minute).toBe(0);
      expect(throughput.embeddings_per_second).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return correct OCR stats with documents',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { durationMs: 1000, pageCount: 10, quality: 4.5, mode: 'accurate' });
      insertDocWithOCR(db, { durationMs: 500, pageCount: 5, quality: 3.5, mode: 'fast' });

      const response = await handlePipelineAnalytics({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const ocr = parsed.data!.ocr as Record<string, unknown>;
      expect(ocr.total_docs).toBe(2);
      expect(ocr.total_pages).toBe(15);
      expect(ocr.avg_duration_ms).toBe(750);
      expect(ocr.min_duration_ms).toBe(500);
      expect(ocr.max_duration_ms).toBe(1000);
      expect(ocr.total_duration_ms).toBe(1500);
      // avg_ms_per_page = 1500 / 15 = 100
      expect(ocr.avg_ms_per_page).toBe(100);
      expect(ocr.avg_quality).toBe(4.0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return group_by=mode breakdown',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { mode: 'accurate', costCents: 100 });
      insertDocWithOCR(db, { mode: 'accurate', costCents: 200 });
      insertDocWithOCR(db, { mode: 'fast', costCents: 20 });

      const response = await handlePipelineAnalytics({ group_by: 'mode' });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const byMode = parsed.data!.by_mode as Array<Record<string, unknown>>;
      expect(byMode).toBeDefined();
      expect(byMode.length).toBe(2);

      const accurateRow = byMode.find((r) => r.mode === 'accurate');
      expect(accurateRow).toBeDefined();
      expect(accurateRow!.count).toBe(2);

      const fastRow = byMode.find((r) => r.mode === 'fast');
      expect(fastRow).toBeDefined();
      expect(fastRow!.count).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return group_by=file_type breakdown',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { fileType: 'pdf' });
      insertDocWithOCR(db, { fileType: 'pdf' });
      insertDocWithOCR(db, { fileType: 'docx' });

      const response = await handlePipelineAnalytics({ group_by: 'file_type' });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const byFileType = parsed.data!.by_file_type as Array<Record<string, unknown>>;
      expect(byFileType).toBeDefined();
      expect(byFileType.length).toBe(2);

      const pdfRow = byFileType.find((r) => r.file_type === 'pdf');
      expect(pdfRow!.count).toBe(2);

      const docxRow = byFileType.find((r) => r.file_type === 'docx');
      expect(docxRow!.count).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return group_by=document breakdown with chunk/image counts',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const { docId, ocrResultId, docProvId } = insertDocWithOCR(db, {
        durationMs: 2000,
        fileName: 'big.pdf',
      });
      insertChunk(db, docId, ocrResultId, docProvId, { chunkIndex: 0 });
      insertChunk(db, docId, ocrResultId, docProvId, { chunkIndex: 1 });

      insertDocWithOCR(db, { durationMs: 100, fileName: 'small.pdf' });

      const response = await handlePipelineAnalytics({ group_by: 'document', limit: 10 });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const byDoc = parsed.data!.by_document as Array<Record<string, unknown>>;
      expect(byDoc).toBeDefined();
      expect(byDoc.length).toBe(2);
      // Ordered by processing_duration_ms DESC
      expect(byDoc[0].file_name).toBe('big.pdf');
      expect(byDoc[0].processing_duration_ms).toBe(2000);
      expect(byDoc[0].chunk_count).toBe(2);
      expect(byDoc[1].file_name).toBe('small.pdf');
      expect(byDoc[1].chunk_count).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should calculate throughput correctly',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      // 10 pages in 1000ms = 600 pages/min
      insertDocWithOCR(db, { durationMs: 1000, pageCount: 10 });

      const response = await handlePipelineAnalytics({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const throughput = parsed.data!.throughput as Record<string, unknown>;
      expect(throughput.pages_per_minute).toBe(600);
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleCorpusProfile TESTS (with real DB)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Corpus Profile (ocr_corpus_profile) with DB', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('analytics-corpus-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('corpus');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)(
    'should return zeros for empty database',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleCorpusProfile({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const docs = parsed.data!.documents as Record<string, unknown>;
      expect(docs.total_complete).toBe(0);

      const chunks = parsed.data!.chunks as Record<string, unknown>;
      expect(chunks.total_chunks).toBe(0);

      const fileTypes = parsed.data!.file_types as Array<unknown>;
      expect(fileTypes).toEqual([]);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return correct document size distribution',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { pageCount: 10, fileType: 'pdf' });
      insertDocWithOCR(db, { pageCount: 20, fileType: 'pdf' });
      insertDocWithOCR(db, { pageCount: 5, fileType: 'docx' });
      // Pending doc should NOT be counted in complete docs
      insertDocWithOCR(db, { pageCount: 100, fileType: 'pdf', status: 'pending' });

      const response = await handleCorpusProfile({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const docs = parsed.data!.documents as Record<string, unknown>;
      // Only 3 complete docs
      expect(docs.total_complete).toBe(3);
      // avg(10,20,5) ≈ 11.67
      expect(docs.min_page_count).toBe(5);
      expect(docs.max_page_count).toBe(20);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return file type distribution',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { fileType: 'pdf' });
      insertDocWithOCR(db, { fileType: 'pdf' });
      insertDocWithOCR(db, { fileType: 'docx' });

      const response = await handleCorpusProfile({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const fileTypes = parsed.data!.file_types as Array<Record<string, unknown>>;
      expect(fileTypes.length).toBe(2);
      expect(fileTypes[0].file_type).toBe('pdf');
      expect(fileTypes[0].count).toBe(2);
      expect(fileTypes[1].file_type).toBe('docx');
      expect(fileTypes[1].count).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return chunk statistics with headings and atomic chunks',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const { docId, ocrResultId, docProvId } = insertDocWithOCR(db);
      insertChunk(db, docId, ocrResultId, docProvId, {
        headingContext: 'Introduction',
        contentTypes: ['text'],
        chunkIndex: 0,
      });
      insertChunk(db, docId, ocrResultId, docProvId, {
        headingContext: 'Methods',
        contentTypes: ['text', 'table'],
        isAtomic: true,
        chunkIndex: 1,
      });
      insertChunk(db, docId, ocrResultId, docProvId, {
        headingContext: null,
        contentTypes: [],
        chunkIndex: 2,
      });

      const response = await handleCorpusProfile({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const chunks = parsed.data!.chunks as Record<string, unknown>;
      expect(chunks.total_chunks).toBe(3);
      expect(chunks.atomic_chunks).toBe(1);
      expect(chunks.chunks_with_headings).toBe(2);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return section frequency when enabled',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const doc1 = insertDocWithOCR(db);
      const doc2 = insertDocWithOCR(db);
      // "Introduction" in both docs
      insertChunk(db, doc1.docId, doc1.ocrResultId, doc1.docProvId, {
        headingContext: 'Introduction',
        chunkIndex: 0,
      });
      insertChunk(db, doc2.docId, doc2.ocrResultId, doc2.docProvId, {
        headingContext: 'Introduction',
        chunkIndex: 0,
      });
      // "Methods" only in doc1
      insertChunk(db, doc1.docId, doc1.ocrResultId, doc1.docProvId, {
        headingContext: 'Methods',
        chunkIndex: 1,
      });

      const response = await handleCorpusProfile({ include_section_frequency: true });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const sections = parsed.data!.section_frequency as Array<Record<string, unknown>>;
      expect(sections).toBeDefined();
      expect(sections.length).toBe(2);
      // Introduction: 2 occurrences across 2 docs
      const intro = sections.find((s) => s.heading_context === 'Introduction');
      expect(intro!.occurrence_count).toBe(2);
      expect(intro!.document_count).toBe(2);
      // Methods: 1 occurrence across 1 doc
      const methods = sections.find((s) => s.heading_context === 'Methods');
      expect(methods!.occurrence_count).toBe(1);
      expect(methods!.document_count).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should omit section frequency when disabled',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db);

      const response = await handleCorpusProfile({ include_section_frequency: false });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      expect(parsed.data!.section_frequency).toBeUndefined();
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return content type distribution when enabled',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const { docId, ocrResultId, docProvId } = insertDocWithOCR(db);
      insertChunk(db, docId, ocrResultId, docProvId, {
        contentTypes: ['text', 'table'],
        chunkIndex: 0,
      });
      insertChunk(db, docId, ocrResultId, docProvId, {
        contentTypes: ['text', 'code'],
        chunkIndex: 1,
      });
      insertChunk(db, docId, ocrResultId, docProvId, {
        contentTypes: ['text'],
        chunkIndex: 2,
      });

      const response = await handleCorpusProfile({ include_content_type_distribution: true });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const ctDist = parsed.data!.content_type_distribution as Array<Record<string, unknown>>;
      expect(ctDist).toBeDefined();
      // text appears 3 times, table 1, code 1
      const textEntry = ctDist.find((e) => e.content_type === 'text');
      expect(textEntry!.count).toBe(3);
      const tableEntry = ctDist.find((e) => e.content_type === 'table');
      expect(tableEntry!.count).toBe(1);
      const codeEntry = ctDist.find((e) => e.content_type === 'code');
      expect(codeEntry!.count).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should omit content type distribution when disabled',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db);

      const response = await handleCorpusProfile({ include_content_type_distribution: false });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      expect(parsed.data!.content_type_distribution).toBeUndefined();
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should respect limit parameter for section frequency',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const { docId, ocrResultId, docProvId } = insertDocWithOCR(db);
      for (let i = 0; i < 5; i++) {
        insertChunk(db, docId, ocrResultId, docProvId, {
          headingContext: `Section ${i}`,
          chunkIndex: i,
        });
      }

      const response = await handleCorpusProfile({
        include_section_frequency: true,
        limit: 3,
      });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const sections = parsed.data!.section_frequency as Array<Record<string, unknown>>;
      expect(sections.length).toBe(3);
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleErrorAnalytics TESTS (with real DB)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Error Analytics (ocr_error_analytics) with DB', () => {
  let tempDir: string;
  let dbName: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('analytics-errors-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('errors');
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)(
    'should return zeros for empty database',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const response = await handleErrorAnalytics({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const docs = parsed.data!.documents as Record<string, unknown>;
      expect(docs.total).toBe(0);
      expect(docs.failed).toBe(0);
      expect(docs.failure_rate_pct).toBe(0);

      const vlm = parsed.data!.vlm as Record<string, unknown>;
      expect(vlm.total_images).toBe(0);
      expect(vlm.failure_rate_pct).toBe(0);

      const embeddings = parsed.data!.embeddings as Record<string, unknown>;
      expect(embeddings.total_chunks).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should calculate document failure rates correctly',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { status: 'complete' });
      insertDocWithOCR(db, { status: 'complete' });
      insertDocWithOCR(db, {
        status: 'failed',
        errorMessage: 'OCR timeout',
      });
      insertDocWithOCR(db, {
        status: 'failed',
        errorMessage: 'OCR timeout',
      });
      insertDocWithOCR(db, { status: 'pending' });

      const response = await handleErrorAnalytics({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const docs = parsed.data!.documents as Record<string, unknown>;
      expect(docs.total).toBe(5);
      expect(docs.failed).toBe(2);
      expect(docs.complete).toBe(2);
      expect(docs.pending).toBe(1);
      // failure_rate = 2/5 * 100 = 40
      expect(docs.failure_rate_pct).toBe(40);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return failure by file type',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { fileType: 'pdf', status: 'complete' });
      insertDocWithOCR(db, { fileType: 'pdf', status: 'failed', errorMessage: 'bad pdf' });
      insertDocWithOCR(db, { fileType: 'docx', status: 'complete' });

      const response = await handleErrorAnalytics({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const byFileType = parsed.data!.failure_by_file_type as Array<Record<string, unknown>>;
      expect(byFileType).toBeDefined();
      expect(byFileType.length).toBe(2);

      const pdfRow = byFileType.find((r) => r.file_type === 'pdf');
      expect(pdfRow!.total).toBe(2);
      expect(pdfRow!.failed).toBe(1);
      expect(pdfRow!.failure_rate_pct).toBe(50);

      const docxRow = byFileType.find((r) => r.file_type === 'docx');
      expect(docxRow!.total).toBe(1);
      expect(docxRow!.failed).toBe(0);
      expect(docxRow!.failure_rate_pct).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return common error messages when enabled',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { status: 'failed', errorMessage: 'OCR timeout' });
      insertDocWithOCR(db, { status: 'failed', errorMessage: 'OCR timeout' });
      insertDocWithOCR(db, { status: 'failed', errorMessage: 'Invalid format' });

      const response = await handleErrorAnalytics({ include_error_messages: true });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const commonErrors = parsed.data!.common_document_errors as Array<Record<string, unknown>>;
      expect(commonErrors).toBeDefined();
      expect(commonErrors.length).toBe(2);
      // Ordered by count DESC
      expect(commonErrors[0].error_message).toBe('OCR timeout');
      expect(commonErrors[0].count).toBe(2);
      expect(commonErrors[1].error_message).toBe('Invalid format');
      expect(commonErrors[1].count).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should omit error messages when disabled',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      insertDocWithOCR(db, { status: 'failed', errorMessage: 'OCR timeout' });

      const response = await handleErrorAnalytics({ include_error_messages: false });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      expect(parsed.data!.common_document_errors).toBeUndefined();
      expect(parsed.data!.common_vlm_errors).toBeUndefined();
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should return embedding failure stats from chunks',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      const { docId, ocrResultId, docProvId } = insertDocWithOCR(db);
      insertChunk(db, docId, ocrResultId, docProvId, { chunkIndex: 0 });
      insertChunk(db, docId, ocrResultId, docProvId, { chunkIndex: 1 });
      insertChunk(db, docId, ocrResultId, docProvId, { chunkIndex: 2 });

      const response = await handleErrorAnalytics({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const embeddings = parsed.data!.embeddings as Record<string, unknown>;
      expect(embeddings.total_chunks).toBe(3);
      // All chunks start as 'pending' status
      expect(embeddings.pending).toBe(3);
      expect(embeddings.failed).toBe(0);
      expect(embeddings.complete).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should respect limit parameter for error messages',
    async () => {
      const db = DatabaseService.create(dbName, undefined, tempDir);
      state.currentDatabase = db;
      state.currentDatabaseName = dbName;

      for (let i = 0; i < 5; i++) {
        insertDocWithOCR(db, { status: 'failed', errorMessage: `Error type ${i}` });
      }

      const response = await handleErrorAnalytics({ include_error_messages: true, limit: 3 });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);

      const commonErrors = parsed.data!.common_document_errors as Array<Record<string, unknown>>;
      expect(commonErrors.length).toBe(3);
    }
  );
});
