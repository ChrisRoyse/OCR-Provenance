/**
 * ProvenanceExporter Tests
 *
 * CRITICAL: Uses REAL DatabaseService - NO MOCKS
 * Verifies physical database state after all operations
 *
 * Constitution Compliance Tests:
 * - CP-001: Complete provenance chain for every data item
 * - CP-003: SHA-256 content hashing
 *
 * Test Categories (30+ tests total):
 * - exportJSON(): 8 tests
 * - exportW3CPROV(): 10 tests
 * - exportCSV(): 5 tests
 * - exportToFile(): 7 tests
 * - Edge Cases: 3+ tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import {
  ProvenanceTracker,
  ProvenanceExporter,
  ExporterError,
  ExporterErrorCode,
  resetProvenanceTracker,
} from '../../../src/services/provenance/index.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { computeHash, hashFile } from '../../../src/utils/hash.js';

// Check sqlite-vec availability
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

if (!sqliteVecAvailable) {
  console.warn('WARNING: sqlite-vec not available. ProvenanceExporter tests will be skipped.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC TEST DATA - Known inputs with predetermined hashes
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC = {
  // Document content (simulates file content)
  fileContent: 'Test document content for export testing - v1',

  // OCR extracted text
  ocrText: 'Extracted OCR text from the test document.',

  // Chunk text
  chunkText: 'First chunk of the extracted text.',

  // Embedding original text
  embeddingText: 'First chunk of the extracted text.',
};

// Pre-computed hashes (computed in beforeAll)
const EXPECTED_HASHES = {
  file: '',
  ocr: '',
  chunk: '',
  embedding: '',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('ProvenanceExporter', () => {
  let testDir: string;
  let db: DatabaseService | undefined;
  let tracker: ProvenanceTracker;
  let exporter: ProvenanceExporter;
  let testFilePath: string;
  let testFileHash: string;

  beforeAll(async () => {
    // Pre-compute expected hashes
    EXPECTED_HASHES.file = computeHash(SYNTHETIC.fileContent);
    EXPECTED_HASHES.ocr = computeHash(SYNTHETIC.ocrText);
    EXPECTED_HASHES.chunk = computeHash(SYNTHETIC.chunkText);
    EXPECTED_HASHES.embedding = computeHash(SYNTHETIC.embeddingText);

    console.log('\n[SYNTHETIC TEST DATA]');
    console.log(`  File content hash: ${EXPECTED_HASHES.file}`);
    console.log(`  OCR text hash: ${EXPECTED_HASHES.ocr}`);
    console.log(`  Chunk text hash: ${EXPECTED_HASHES.chunk}`);
    console.log(`  Embedding text hash: ${EXPECTED_HASHES.embedding}`);

    testDir = mkdtempSync(join(tmpdir(), 'exporter-test-'));
    testFilePath = join(testDir, 'test-doc.txt');
    writeFileSync(testFilePath, SYNTHETIC.fileContent);

    testFileHash = await hashFile(testFilePath);
    console.log(`  Test file path: ${testFilePath}`);
    console.log(`  Test file hash: ${testFileHash}`);
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (!sqliteVecAvailable) return;

    resetProvenanceTracker();
    const dbName = `exporter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = DatabaseService.create(dbName, undefined, testDir);
    tracker = new ProvenanceTracker(db);
    exporter = new ProvenanceExporter(db, tracker);
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // HELPER: Create full provenance chain with real records
  // ═══════════════════════════════════════════════════════════════════════════════

  function createFullChain(): {
    docId: string;
    docProvId: string;
    ocrId: string;
    ocrProvId: string;
    chunkId: string;
    chunkProvId: string;
    embId: string;
    embProvId: string;
  } {
    if (!db) throw new Error('Database not initialized');
    const rawDb = db.getConnection();

    // 1. Create DOCUMENT provenance
    const docProvId = tracker.createProvenance({
      type: ProvenanceType.DOCUMENT,
      source_type: 'FILE',
      root_document_id: '',
      content_hash: testFileHash,
      file_hash: testFileHash,
      source_path: testFilePath,
      processor: 'file-ingestion',
      processor_version: '1.0.0',
      processing_params: { originalFormat: 'txt' },
    });

    // Insert document record
    const docId = uuidv4();
    rawDb.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docId, testFilePath, 'test-doc.txt', testFileHash, SYNTHETIC.fileContent.length, 'txt', 'complete', docProvId, new Date().toISOString());

    // 2. Create OCR_RESULT provenance
    const ocrProvId = tracker.createProvenance({
      type: ProvenanceType.OCR_RESULT,
      source_type: 'OCR',
      source_id: docProvId,
      root_document_id: docProvId,
      content_hash: EXPECTED_HASHES.ocr,
      input_hash: testFileHash,
      processor: 'datalab-ocr',
      processor_version: '1.0.0',
      processing_params: { mode: 'accurate' },
    });

    // Insert OCR result record
    const ocrId = uuidv4();
    rawDb.prepare(`
      INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id,
        datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ocrId, ocrProvId, docId, SYNTHETIC.ocrText, SYNTHETIC.ocrText.length, 'req-123',
      'accurate', 1, EXPECTED_HASHES.ocr, new Date().toISOString(), new Date().toISOString(), 100);

    // 3. Create CHUNK provenance
    const chunkProvId = tracker.createProvenance({
      type: ProvenanceType.CHUNK,
      source_type: 'CHUNKING',
      source_id: ocrProvId,
      root_document_id: docProvId,
      content_hash: EXPECTED_HASHES.chunk,
      input_hash: EXPECTED_HASHES.ocr,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { chunk_size: 2000, overlap_percent: 10 },
      location: { chunk_index: 0, character_start: 0, character_end: SYNTHETIC.chunkText.length },
    });

    // Insert chunk record
    const chunkId = uuidv4();
    rawDb.prepare(`
      INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end,
        overlap_previous, overlap_next, provenance_id, created_at, embedding_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chunkId, docId, ocrId, SYNTHETIC.chunkText, EXPECTED_HASHES.chunk, 0, 0, SYNTHETIC.chunkText.length,
      0, 0, chunkProvId, new Date().toISOString(), 'complete');

    // 4. Create EMBEDDING provenance
    const embProvId = tracker.createProvenance({
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: chunkProvId,
      root_document_id: docProvId,
      content_hash: EXPECTED_HASHES.embedding,
      input_hash: EXPECTED_HASHES.chunk,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { dimensions: 768, device: 'cuda:0' },
    });

    // Insert embedding record
    const embId = uuidv4();
    rawDb.prepare(`
      INSERT INTO embeddings (id, chunk_id, document_id, original_text, original_text_length, source_file_path,
        source_file_name, source_file_hash, character_start, character_end, chunk_index, total_chunks,
        model_name, model_version, task_type, inference_mode, provenance_id, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(embId, chunkId, docId, SYNTHETIC.embeddingText, SYNTHETIC.embeddingText.length, testFilePath,
      'test-doc.txt', testFileHash, 0, SYNTHETIC.embeddingText.length, 0, 1,
      'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local', embProvId, EXPECTED_HASHES.embedding, new Date().toISOString());

    return { docId, docProvId, ocrId, ocrProvId, chunkId, chunkProvId, embId, embProvId };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // exportJSON() tests - 8 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('exportJSON()', () => {
    it.skipIf(!sqliteVecAvailable)('returns empty records for empty database', async () => {
      const result = await exporter.exportJSON('database');

      // PHYSICAL VERIFICATION
      const rawDb = db!.getConnection();
      const dbCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number };

      console.log('\n[PHYSICAL VERIFICATION] Empty database JSON export:');
      console.log(`  Database record count: ${dbCount.cnt}`);
      console.log(`  Export record count: ${result.record_count}`);
      console.log(`  Match: ${dbCount.cnt === result.record_count ? '✓' : '✗'}`);

      expect(result.record_count).toBe(0);
      expect(result.records).toEqual([]);
      expect(result.format).toBe('json');
      expect(dbCount.cnt).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('exports single DOCUMENT correctly', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: testFileHash,
        file_hash: testFileHash,
        source_path: testFilePath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const docId = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, testFilePath, 'test.txt', testFileHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      const result = await exporter.exportJSON('document', docProvId);

      // PHYSICAL VERIFICATION
      const dbCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance WHERE root_document_id = ?').get(docProvId) as { cnt: number };

      console.log('\n[PHYSICAL VERIFICATION] Single DOCUMENT export:');
      console.log(`  Database record count: ${dbCount.cnt}`);
      console.log(`  Export record count: ${result.record_count}`);
      console.log(`  Match: ${dbCount.cnt === result.record_count ? '✓' : '✗'}`);

      expect(result.record_count).toBe(1);
      expect(result.records[0].type).toBe(ProvenanceType.DOCUMENT);
      expect(result.document_id).toBe(docProvId);
      expect(dbCount.cnt).toBe(result.record_count);
    });

    it.skipIf(!sqliteVecAvailable)('exports full 4-level chain (DOC→OCR→CHUNK→EMBEDDING)', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportJSON('document', docProvId);

      // PHYSICAL VERIFICATION
      const rawDb = db!.getConnection();
      const dbCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance WHERE root_document_id = ?').get(docProvId) as { cnt: number };

      console.log('\n[PHYSICAL VERIFICATION] Full 4-level chain export:');
      console.log(`  Database record count: ${dbCount.cnt}`);
      console.log(`  Export record count: ${result.record_count}`);
      console.log(`  Types found: ${result.records.map(r => r.type).join(', ')}`);
      console.log(`  Match: ${dbCount.cnt === result.record_count ? '✓' : '✗'}`);

      expect(result.record_count).toBe(4);
      expect(result.records.map(r => r.type)).toContain(ProvenanceType.DOCUMENT);
      expect(result.records.map(r => r.type)).toContain(ProvenanceType.OCR_RESULT);
      expect(result.records.map(r => r.type)).toContain(ProvenanceType.CHUNK);
      expect(result.records.map(r => r.type)).toContain(ProvenanceType.EMBEDDING);
      expect(dbCount.cnt).toBe(4);
    });

    it.skipIf(!sqliteVecAvailable)('throws DOCUMENT_REQUIRED when scope=document without documentId', async () => {
      await expect(exporter.exportJSON('document'))
        .rejects.toThrow(ExporterError);

      try {
        await exporter.exportJSON('document');
      } catch (e) {
        expect(e).toBeInstanceOf(ExporterError);
        expect((e as ExporterError).code).toBe(ExporterErrorCode.DOCUMENT_REQUIRED);
        console.log('\n[VERIFY] DOCUMENT_REQUIRED thrown for missing documentId ✓');
      }
    });

    it.skipIf(!sqliteVecAvailable)('database scope returns all records across multiple documents', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create two separate document chains
      const chain1 = createFullChain();

      // Second document
      const secondFilePath = join(testDir, 'second-doc.txt');
      writeFileSync(secondFilePath, 'Second document content');
      const secondFileHash = await hashFile(secondFilePath);

      const docProvId2 = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: secondFileHash,
        file_hash: secondFileHash,
        source_path: secondFilePath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const docId2 = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId2, secondFilePath, 'second.txt', secondFileHash, 100, 'txt', 'complete', docProvId2, new Date().toISOString());

      const result = await exporter.exportJSON('database');

      // PHYSICAL VERIFICATION
      const dbCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number };

      console.log('\n[PHYSICAL VERIFICATION] Multiple documents export:');
      console.log(`  Database record count: ${dbCount.cnt}`);
      console.log(`  Export record count: ${result.record_count}`);
      console.log(`  Match: ${dbCount.cnt === result.record_count ? '✓' : '✗'}`);

      expect(result.record_count).toBe(5); // 4 from chain1 + 1 document
      expect(result.scope).toBe('database');
      expect(dbCount.cnt).toBe(5);
    });

    it.skipIf(!sqliteVecAvailable)('all scope behaves same as database', async () => {
      createFullChain();

      const dbResult = await exporter.exportJSON('database');
      const allResult = await exporter.exportJSON('all');

      console.log('\n[VERIFY] "all" scope equivalence:');
      console.log(`  database scope count: ${dbResult.record_count}`);
      console.log(`  all scope count: ${allResult.record_count}`);
      console.log(`  Match: ${dbResult.record_count === allResult.record_count ? '✓' : '✗'}`);

      expect(allResult.record_count).toBe(dbResult.record_count);
      expect(allResult.records.length).toBe(dbResult.records.length);
    });

    it.skipIf(!sqliteVecAvailable)('includes valid exported_at ISO timestamp', async () => {
      createFullChain();

      const result = await exporter.exportJSON('database');

      const timestamp = new Date(result.exported_at);
      const now = new Date();

      console.log('\n[VERIFY] Timestamp validity:');
      console.log(`  exported_at: ${result.exported_at}`);
      console.log(`  Is valid date: ${!isNaN(timestamp.getTime()) ? '✓' : '✗'}`);

      expect(!isNaN(timestamp.getTime())).toBe(true);
      expect(timestamp.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(result.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it.skipIf(!sqliteVecAvailable)('preserves processing_params in output', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportJSON('document', docProvId);

      const docRecord = result.records.find(r => r.type === ProvenanceType.DOCUMENT);
      const ocrRecord = result.records.find(r => r.type === ProvenanceType.OCR_RESULT);

      console.log('\n[VERIFY] processing_params preservation:');
      console.log(`  DOCUMENT params: ${JSON.stringify(docRecord?.processing_params)}`);
      console.log(`  OCR_RESULT params: ${JSON.stringify(ocrRecord?.processing_params)}`);

      expect(docRecord?.processing_params).toHaveProperty('originalFormat');
      expect(ocrRecord?.processing_params).toHaveProperty('mode');
      expect(ocrRecord?.processing_params.mode).toBe('accurate');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // exportW3CPROV() tests - 10 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('exportW3CPROV()', () => {
    it.skipIf(!sqliteVecAvailable)('produces valid PROV-JSON with all required top-level keys', async () => {
      createFullChain();

      const result = await exporter.exportW3CPROV('database');
      const doc = result.prov_document;

      console.log('\n[VERIFY] PROV-JSON structure:');
      console.log(`  Has prefix: ${'prefix' in doc ? '✓' : '✗'}`);
      console.log(`  Has entity: ${'entity' in doc ? '✓' : '✗'}`);
      console.log(`  Has activity: ${'activity' in doc ? '✓' : '✗'}`);
      console.log(`  Has agent: ${'agent' in doc ? '✓' : '✗'}`);
      console.log(`  Has wasDerivedFrom: ${'wasDerivedFrom' in doc ? '✓' : '✗'}`);
      console.log(`  Has wasGeneratedBy: ${'wasGeneratedBy' in doc ? '✓' : '✗'}`);
      console.log(`  Has wasAttributedTo: ${'wasAttributedTo' in doc ? '✓' : '✗'}`);

      expect(doc).toHaveProperty('prefix');
      expect(doc).toHaveProperty('entity');
      expect(doc).toHaveProperty('activity');
      expect(doc).toHaveProperty('agent');
      expect(doc).toHaveProperty('wasDerivedFrom');
      expect(doc).toHaveProperty('wasGeneratedBy');
      expect(doc).toHaveProperty('wasAttributedTo');
    });

    it.skipIf(!sqliteVecAvailable)('creates prov:Entity for each provenance record', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);

      // PHYSICAL VERIFICATION
      const rawDb = db!.getConnection();
      const dbCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance WHERE root_document_id = ?').get(docProvId) as { cnt: number };

      console.log('\n[PHYSICAL VERIFICATION] Entity count:');
      console.log(`  Database records: ${dbCount.cnt}`);
      console.log(`  Entities created: ${result.entity_count}`);
      console.log(`  Match: ${dbCount.cnt === result.entity_count ? '✓' : '✗'}`);

      expect(result.entity_count).toBe(4);
      expect(result.entity_count).toBe(dbCount.cnt);
    });

    it.skipIf(!sqliteVecAvailable)('creates prov:Activity for non-DOCUMENT types only', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);

      // Should have 3 activities (OCR, CHUNK, EMBEDDING) - not DOCUMENT
      console.log('\n[VERIFY] Activity count (non-DOCUMENT):');
      console.log(`  Activity count: ${result.activity_count} (expected: 3)`);
      console.log(`  Activity IDs: ${Object.keys(result.prov_document.activity).slice(0, 3).join(', ')}`);

      expect(result.activity_count).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('creates unique prov:Agent for each processor', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);
      const agents = result.prov_document.agent;
      const agentIds = Object.keys(agents);

      console.log('\n[VERIFY] Unique agents:');
      console.log(`  Agent count: ${result.agent_count}`);
      console.log(`  Agent IDs: ${agentIds.join(', ')}`);

      // We have: file-ingestion, datalab-ocr, chunker, nomic-embed-text-v1.5
      expect(result.agent_count).toBe(4);
      expect(agentIds.some(id => id.includes('file-ingestion'))).toBe(true);
      expect(agentIds.some(id => id.includes('datalab-ocr'))).toBe(true);
      expect(agentIds.some(id => id.includes('chunker'))).toBe(true);
      expect(agentIds.some(id => id.includes('nomic-embed-text'))).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('creates wasDerivedFrom for records with source_id', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);
      const wdf = result.prov_document.wasDerivedFrom;
      const wdfCount = Object.keys(wdf).length;

      console.log('\n[VERIFY] wasDerivedFrom relationships:');
      console.log(`  Count: ${wdfCount} (expected: 3 - OCR←DOC, CHUNK←OCR, EMB←CHUNK)`);

      // 3 derivations: OCR from DOC, CHUNK from OCR, EMBEDDING from CHUNK
      expect(wdfCount).toBe(3);

      // Each derivation should have generatedEntity and usedEntity
      for (const derivation of Object.values(wdf)) {
        expect(derivation).toHaveProperty('prov:generatedEntity');
        expect(derivation).toHaveProperty('prov:usedEntity');
      }
    });

    it.skipIf(!sqliteVecAvailable)('creates wasGeneratedBy for non-DOCUMENT entities', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);
      const wgb = result.prov_document.wasGeneratedBy;
      const wgbCount = Object.keys(wgb).length;

      console.log('\n[VERIFY] wasGeneratedBy relationships:');
      console.log(`  Count: ${wgbCount} (expected: 3 - OCR, CHUNK, EMBEDDING)`);

      expect(wgbCount).toBe(3);

      for (const gen of Object.values(wgb)) {
        expect(gen).toHaveProperty('prov:entity');
        expect(gen).toHaveProperty('prov:activity');
        expect(gen).toHaveProperty('prov:time');
      }
    });

    it.skipIf(!sqliteVecAvailable)('creates wasAttributedTo for all entities', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);
      const wat = result.prov_document.wasAttributedTo;
      const watCount = Object.keys(wat).length;

      console.log('\n[VERIFY] wasAttributedTo relationships:');
      console.log(`  Count: ${watCount} (expected: 4 - all entities)`);

      expect(watCount).toBe(4);

      for (const attr of Object.values(wat)) {
        expect(attr).toHaveProperty('prov:entity');
        expect(attr).toHaveProperty('prov:agent');
      }
    });

    it.skipIf(!sqliteVecAvailable)('includes prov:generatedAtTime in entities', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);
      const entities = result.prov_document.entity;

      console.log('\n[VERIFY] generatedAtTime in entities:');
      let allHaveTime = true;
      for (const [id, entity] of Object.entries(entities)) {
        if (!entity['prov:generatedAtTime']) {
          allHaveTime = false;
          console.log(`  Missing in: ${id}`);
        }
      }
      console.log(`  All have generatedAtTime: ${allHaveTime ? '✓' : '✗'}`);

      for (const entity of Object.values(entities)) {
        expect(entity).toHaveProperty('prov:generatedAtTime');
      }
    });

    it.skipIf(!sqliteVecAvailable)('includes ocr:content_hash in entities', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);
      const entities = result.prov_document.entity;

      console.log('\n[VERIFY] content_hash in entities:');
      for (const [id, entity] of Object.entries(entities)) {
        console.log(`  ${id}: ${(entity['ocr:content_hash'] as string)?.slice(0, 20)}...`);
        expect(entity).toHaveProperty('ocr:content_hash');
        expect(typeof entity['ocr:content_hash']).toBe('string');
      }
    });

    it.skipIf(!sqliteVecAvailable)('handles full 4-level chain correctly (counts match)', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportW3CPROV('document', docProvId);

      // PHYSICAL VERIFICATION
      const rawDb = db!.getConnection();
      const dbCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance WHERE root_document_id = ?').get(docProvId) as { cnt: number };

      console.log('\n[PHYSICAL VERIFICATION] Full chain PROV counts:');
      console.log(`  DB records: ${dbCount.cnt}`);
      console.log(`  Entities: ${result.entity_count}`);
      console.log(`  Activities: ${result.activity_count} (should be ${dbCount.cnt - 1})`);
      console.log(`  Agents: ${result.agent_count}`);

      expect(result.entity_count).toBe(4);
      expect(result.activity_count).toBe(3); // non-DOCUMENT types
      expect(result.entity_count).toBe(dbCount.cnt);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // exportCSV() tests - 5 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('exportCSV()', () => {
    it.skipIf(!sqliteVecAvailable)('produces valid CSV with correct headers', async () => {
      createFullChain();

      const result = await exporter.exportCSV('database');
      const lines = result.csv_content.split('\n');
      const headers = lines[0].split(',');

      console.log('\n[VERIFY] CSV headers:');
      console.log(`  Header count: ${headers.length}`);
      console.log(`  First few headers: ${headers.slice(0, 5).join(', ')}`);

      expect(headers).toContain('id');
      expect(headers).toContain('type');
      expect(headers).toContain('content_hash');
      expect(headers).toContain('processor');
      expect(headers).toContain('chain_depth');
    });

    it.skipIf(!sqliteVecAvailable)('escapes values containing commas', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create record with comma in processing_params
      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: testFileHash,
        file_hash: testFileHash,
        source_path: testFilePath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: { note: 'value, with, commas' },
      });

      const docId = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, testFilePath, 'test.txt', testFileHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      const result = await exporter.exportCSV('database');

      console.log('\n[VERIFY] Comma escaping:');
      console.log(`  CSV contains quoted field: ${result.csv_content.includes('"') ? '✓' : '✗'}`);

      // Should have processing_params wrapped in quotes
      expect(result.csv_content).toContain('"');
      // The JSON should be escaped with doubled quotes
      expect(result.csv_content).toMatch(/".*value, with, commas.*"/);
    });

    it.skipIf(!sqliteVecAvailable)('escapes values containing quotes', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create record with quote in path
      const pathWithQuote = join(testDir, 'file"with"quotes.txt');
      writeFileSync(pathWithQuote, 'content');
      const fileHash = await hashFile(pathWithQuote);

      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: fileHash,
        file_hash: fileHash,
        source_path: pathWithQuote,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const docId = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, pathWithQuote, 'file.txt', fileHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      const result = await exporter.exportCSV('database');

      console.log('\n[VERIFY] Quote escaping:');
      // Quotes should be doubled
      expect(result.csv_content).toContain('""');
    });

    it.skipIf(!sqliteVecAvailable)('record_count matches actual data lines (minus header)', async () => {
      createFullChain();

      const result = await exporter.exportCSV('database');
      const lines = result.csv_content.split('\n').filter(l => l.trim());
      const dataLineCount = lines.length - 1; // minus header

      console.log('\n[VERIFY] CSV line count:');
      console.log(`  Total lines: ${lines.length}`);
      console.log(`  Data lines: ${dataLineCount}`);
      console.log(`  record_count: ${result.record_count}`);
      console.log(`  Match: ${dataLineCount === result.record_count ? '✓' : '✗'}`);

      expect(dataLineCount).toBe(result.record_count);
    });

    it.skipIf(!sqliteVecAvailable)('empty database produces header-only CSV', async () => {
      const result = await exporter.exportCSV('database');
      const lines = result.csv_content.split('\n').filter(l => l.trim());

      console.log('\n[VERIFY] Empty database CSV:');
      console.log(`  Line count: ${lines.length} (expected: 1 - header only)`);
      console.log(`  record_count: ${result.record_count}`);

      expect(lines.length).toBe(1); // header only
      expect(result.record_count).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // exportToFile() tests - 7 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('exportToFile()', () => {
    it.skipIf(!sqliteVecAvailable)('writes JSON file readable from disk', async () => {
      createFullChain();

      const outputPath = join(testDir, 'export-test.json');
      const result = await exporter.exportToFile(outputPath, 'json', 'database');

      // PHYSICAL VERIFICATION
      console.log('\n[FILE VERIFICATION] JSON export:');
      console.log(`  Path: ${outputPath}`);
      console.log(`  Exists: ${existsSync(outputPath) ? '✓' : '✗'}`);

      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      const parsed = JSON.parse(content);

      console.log(`  Readable: ✓`);
      console.log(`  Record count in file: ${parsed.record_count}`);
      console.log(`  Bytes written: ${result.bytes_written}`);

      expect(parsed.format).toBe('json');
      expect(parsed.record_count).toBe(4);
      expect(result.success).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('writes W3C PROV file readable from disk', async () => {
      createFullChain();

      const outputPath = join(testDir, 'export-test-prov.json');
      const result = await exporter.exportToFile(outputPath, 'w3c-prov', 'database');

      // PHYSICAL VERIFICATION
      console.log('\n[FILE VERIFICATION] W3C PROV export:');
      console.log(`  Path: ${outputPath}`);
      console.log(`  Exists: ${existsSync(outputPath) ? '✓' : '✗'}`);

      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      const parsed = JSON.parse(content);

      console.log(`  Readable: ✓`);
      console.log(`  Entity count: ${parsed.entity_count}`);

      expect(parsed.format).toBe('w3c-prov');
      expect(parsed.prov_document).toBeDefined();
      expect(result.success).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('writes CSV file readable from disk', async () => {
      createFullChain();

      const outputPath = join(testDir, 'export-test.csv');
      const result = await exporter.exportToFile(outputPath, 'csv', 'database');

      // PHYSICAL VERIFICATION
      console.log('\n[FILE VERIFICATION] CSV export:');
      console.log(`  Path: ${outputPath}`);
      console.log(`  Exists: ${existsSync(outputPath) ? '✓' : '✗'}`);

      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      console.log(`  Readable: ✓`);
      console.log(`  Lines: ${lines.length}`);

      expect(lines.length).toBe(5); // header + 4 records
      expect(result.success).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('creates parent directories if needed', async () => {
      createFullChain();

      const nestedPath = join(testDir, 'nested', 'deeply', 'export.json');

      // Verify directories don't exist yet
      expect(existsSync(join(testDir, 'nested'))).toBe(false);

      const result = await exporter.exportToFile(nestedPath, 'json', 'database');

      // PHYSICAL VERIFICATION
      console.log('\n[FILE VERIFICATION] Nested directory creation:');
      console.log(`  Path: ${nestedPath}`);
      console.log(`  Directory created: ${existsSync(join(testDir, 'nested', 'deeply')) ? '✓' : '✗'}`);
      console.log(`  File exists: ${existsSync(nestedPath) ? '✓' : '✗'}`);

      expect(existsSync(nestedPath)).toBe(true);
      expect(result.success).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('returns correct bytes_written', async () => {
      createFullChain();

      const outputPath = join(testDir, 'bytes-test.json');
      const result = await exporter.exportToFile(outputPath, 'json', 'database');

      const content = readFileSync(outputPath, 'utf-8');
      const actualBytes = Buffer.byteLength(content, 'utf-8');

      console.log('\n[VERIFY] Bytes written accuracy:');
      console.log(`  Reported bytes: ${result.bytes_written}`);
      console.log(`  Actual bytes: ${actualBytes}`);
      console.log(`  Match: ${result.bytes_written === actualBytes ? '✓' : '✗'}`);

      expect(result.bytes_written).toBe(actualBytes);
    });

    it.skipIf(!sqliteVecAvailable)('throws INVALID_FORMAT for unknown format', async () => {
      await expect(exporter.exportToFile('/tmp/test.txt', 'txt' as any, 'database'))
        .rejects.toThrow(ExporterError);

      try {
        await exporter.exportToFile('/tmp/test.txt', 'xml' as any, 'database');
      } catch (e) {
        expect(e).toBeInstanceOf(ExporterError);
        expect((e as ExporterError).code).toBe(ExporterErrorCode.INVALID_FORMAT);
        console.log('\n[VERIFY] INVALID_FORMAT thrown for unknown format ✓');
      }
    });

    it.skipIf(!sqliteVecAvailable)('throws DOCUMENT_REQUIRED when scope=document without documentId', async () => {
      await expect(exporter.exportToFile('/tmp/test.json', 'json', 'document'))
        .rejects.toThrow(ExporterError);

      try {
        await exporter.exportToFile('/tmp/test.json', 'json', 'document');
      } catch (e) {
        expect(e).toBeInstanceOf(ExporterError);
        expect((e as ExporterError).code).toBe(ExporterErrorCode.DOCUMENT_REQUIRED);
        console.log('\n[VERIFY] DOCUMENT_REQUIRED thrown for file export ✓');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASES - 3+ tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it.skipIf(!sqliteVecAvailable)('handles empty database correctly', async () => {
      // State BEFORE
      const rawDb = db!.getConnection();
      const beforeCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number };

      console.log('\n[EDGE CASE] Empty database:');
      console.log(`  Before: ${beforeCount.cnt} records`);

      const jsonResult = await exporter.exportJSON('database');
      const provResult = await exporter.exportW3CPROV('database');
      const csvResult = await exporter.exportCSV('database');

      console.log(`  JSON record_count: ${jsonResult.record_count}`);
      console.log(`  PROV entity_count: ${provResult.entity_count}`);
      console.log(`  CSV record_count: ${csvResult.record_count}`);

      expect(jsonResult.record_count).toBe(0);
      expect(jsonResult.records).toEqual([]);
      expect(provResult.entity_count).toBe(0);
      expect(csvResult.record_count).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('sanitizes special characters in PROV agent IDs', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create record with special chars in processor name
      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: testFileHash,
        file_hash: testFileHash,
        source_path: testFilePath,
        processor: 'my-processor/v2.0@beta!#$%',
        processor_version: '2.0.0-beta',
        processing_params: {},
      });

      const docId = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, testFilePath, 'test.txt', testFileHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      const result = await exporter.exportW3CPROV('document', docProvId);
      const agentIds = Object.keys(result.prov_document.agent);

      console.log('\n[EDGE CASE] Agent ID sanitization:');
      console.log(`  Original processor: my-processor/v2.0@beta!#$%`);
      console.log(`  Agent IDs: ${agentIds.join(', ')}`);

      // Agent ID should only contain alphanumeric and hyphens
      for (const id of agentIds) {
        expect(id).toMatch(/^ocr:agent-[a-zA-Z0-9-]+$/);
      }
    });

    it.skipIf(!sqliteVecAvailable)('handles maximum chain depth (4 levels)', async () => {
      const { docProvId } = createFullChain();

      const result = await exporter.exportJSON('document', docProvId);

      // Verify chain_path array length for EMBEDDING
      const embedding = result.records.find(r => r.type === ProvenanceType.EMBEDDING);
      expect(embedding).toBeDefined();

      const chainPath = JSON.parse(embedding!.chain_path!);

      console.log('\n[EDGE CASE] Maximum chain depth:');
      console.log(`  Chain path: ${chainPath.join(' → ')}`);
      console.log(`  Depth: ${chainPath.length}`);

      expect(chainPath.length).toBe(4);
      expect(chainPath).toEqual(['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING']);
    });

    it.skipIf(!sqliteVecAvailable)('throws INVALID_SCOPE for unknown scope', async () => {
      await expect(exporter.exportJSON('invalid' as any))
        .rejects.toThrow(ExporterError);

      try {
        await exporter.exportJSON('unknown' as any);
      } catch (e) {
        expect(e).toBeInstanceOf(ExporterError);
        expect((e as ExporterError).code).toBe(ExporterErrorCode.INVALID_SCOPE);
        console.log('\n[EDGE CASE] INVALID_SCOPE thrown for unknown scope ✓');
      }
    });

    it.skipIf(!sqliteVecAvailable)('exports document with no descendants correctly', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Document-only, no OCR/chunks/embeddings
      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: testFileHash,
        file_hash: testFileHash,
        source_path: testFilePath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const docId = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, testFilePath, 'test.txt', testFileHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      const result = await exporter.exportJSON('document', docProvId);

      console.log('\n[EDGE CASE] Document with no descendants:');
      console.log(`  Record count: ${result.record_count}`);
      console.log(`  Type: ${result.records[0]?.type}`);

      expect(result.record_count).toBe(1);
      expect(result.records[0].type).toBe(ProvenanceType.DOCUMENT);
    });

    it.skipIf(!sqliteVecAvailable)('exports PROV document with single entity correctly', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: testFileHash,
        file_hash: testFileHash,
        source_path: testFilePath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const docId = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, testFilePath, 'test.txt', testFileHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      const result = await exporter.exportW3CPROV('document', docProvId);

      console.log('\n[EDGE CASE] PROV with single entity (DOCUMENT):');
      console.log(`  Entity count: ${result.entity_count}`);
      console.log(`  Activity count: ${result.activity_count} (expected: 0 - DOCUMENT has no activity)`);
      console.log(`  Agent count: ${result.agent_count}`);

      expect(result.entity_count).toBe(1);
      expect(result.activity_count).toBe(0); // DOCUMENT doesn't create activity
      expect(result.agent_count).toBe(1);
    });
  });
});
