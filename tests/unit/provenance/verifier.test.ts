/**
 * ProvenanceVerifier Tests
 *
 * CRITICAL: Uses REAL DatabaseService - NO MOCKS
 * Verifies physical database state after all operations
 *
 * Constitution Compliance Tests:
 * - CP-003: Immutable Hash Verification
 * - CP-001: Complete Provenance Chain
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import {
  ProvenanceTracker,
  ProvenanceVerifier,
  VerifierError,
  VerifierErrorCode,
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
  console.warn('WARNING: sqlite-vec not available. ProvenanceVerifier tests will be skipped.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC TEST DATA - Known inputs with predetermined hashes
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC = {
  // Document content (simulates file content)
  fileContent: 'Test document content for hash verification.',

  // OCR extracted text
  ocrText: 'Extracted text from test document.',

  // Chunk text
  chunkText: 'First chunk of extracted text.',

  // Embedding original text (same as chunk for simplicity)
  embeddingText: 'First chunk of extracted text.',
};

// Pre-computed hashes
const EXPECTED_HASHES = {
  file: '', // Computed in beforeAll
  ocr: '',
  chunk: '',
  embedding: '',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('ProvenanceVerifier', () => {
  let testDir: string;
  let db: DatabaseService | undefined;
  let tracker: ProvenanceTracker;
  let verifier: ProvenanceVerifier;
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

    testDir = mkdtempSync(join(tmpdir(), 'verifier-test-'));
    testFilePath = join(testDir, 'test-doc.txt');
    writeFileSync(testFilePath, SYNTHETIC.fileContent);

    // Hash the file to verify
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
    const dbName = `verifier-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = DatabaseService.create(dbName, undefined, testDir);
    tracker = new ProvenanceTracker(db);
    verifier = new ProvenanceVerifier(db, tracker);
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
      processing_params: {},
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

    // Insert embedding record (without actual vector for test purposes)
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
  // verifyContentHash() tests - 8 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('verifyContentHash()', () => {
    it.skipIf(!sqliteVecAvailable)('verifies DOCUMENT type with matching file hash', async () => {
      const { docProvId } = createFullChain();

      const result = await verifier.verifyContentHash(docProvId);

      // PHYSICAL VERIFICATION
      const rawDb = db!.getConnection();
      const provRow = rawDb.prepare('SELECT * FROM provenance WHERE id = ?').get(docProvId) as { content_hash: string };
      const docRow = rawDb.prepare('SELECT * FROM documents WHERE provenance_id = ?').get(docProvId) as { file_hash: string; file_path: string };

      console.log('\n[VERIFY] DOCUMENT content hash verification:');
      console.log(`  Provenance content_hash: ${provRow.content_hash}`);
      console.log(`  Document file_hash: ${docRow.file_hash}`);
      console.log(`  Computed hash: ${result.computed_hash}`);
      console.log(`  Valid: ${result.valid ? '✓' : '✗'}`);

      expect(result.valid).toBe(true);
      expect(result.item_type).toBe(ProvenanceType.DOCUMENT);
      expect(result.expected_hash).toBe(testFileHash);
      expect(result.computed_hash).toBe(testFileHash);
      expect(result.format_valid).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('verifies OCR_RESULT type with matching extracted_text hash', async () => {
      const { ocrProvId } = createFullChain();

      const result = await verifier.verifyContentHash(ocrProvId);

      // PHYSICAL VERIFICATION
      const rawDb = db!.getConnection();
      const ocrRow = rawDb.prepare('SELECT extracted_text, content_hash FROM ocr_results WHERE provenance_id = ?').get(ocrProvId) as { extracted_text: string; content_hash: string };
      const computedFromDb = computeHash(ocrRow.extracted_text);

      console.log('\n[VERIFY] OCR_RESULT content hash verification:');
      console.log(`  Stored content_hash: ${ocrRow.content_hash}`);
      console.log(`  Computed from text: ${computedFromDb}`);
      console.log(`  Result computed_hash: ${result.computed_hash}`);
      console.log(`  Match: ${result.computed_hash === ocrRow.content_hash ? '✓' : '✗'}`);

      expect(result.valid).toBe(true);
      expect(result.item_type).toBe(ProvenanceType.OCR_RESULT);
      expect(result.expected_hash).toBe(EXPECTED_HASHES.ocr);
    });

    it.skipIf(!sqliteVecAvailable)('verifies CHUNK type with matching text_hash (NOT content_hash)', async () => {
      const { chunkProvId } = createFullChain();

      const result = await verifier.verifyContentHash(chunkProvId);

      // PHYSICAL VERIFICATION - CRITICAL: CHUNK uses text_hash
      const rawDb = db!.getConnection();
      const chunkRow = rawDb.prepare('SELECT text, text_hash FROM chunks WHERE provenance_id = ?').get(chunkProvId) as { text: string; text_hash: string };
      const computedFromDb = computeHash(chunkRow.text);

      console.log('\n[VERIFY] CHUNK content hash verification (uses text_hash):');
      console.log(`  Stored text_hash: ${chunkRow.text_hash}`);
      console.log(`  Computed from text: ${computedFromDb}`);
      console.log(`  Result expected_hash: ${result.expected_hash}`);
      console.log(`  Match: ${result.computed_hash === chunkRow.text_hash ? '✓' : '✗'}`);

      expect(result.valid).toBe(true);
      expect(result.item_type).toBe(ProvenanceType.CHUNK);
      expect(result.expected_hash).toBe(EXPECTED_HASHES.chunk);
      expect(result.expected_hash).toBe(chunkRow.text_hash);
    });

    it.skipIf(!sqliteVecAvailable)('verifies EMBEDDING type with matching original_text hash', async () => {
      const { embProvId } = createFullChain();

      const result = await verifier.verifyContentHash(embProvId);

      // PHYSICAL VERIFICATION
      const rawDb = db!.getConnection();
      const embRow = rawDb.prepare('SELECT original_text, content_hash FROM embeddings WHERE provenance_id = ?').get(embProvId) as { original_text: string; content_hash: string };
      const computedFromDb = computeHash(embRow.original_text);

      console.log('\n[VERIFY] EMBEDDING content hash verification:');
      console.log(`  Stored content_hash: ${embRow.content_hash}`);
      console.log(`  Computed from original_text: ${computedFromDb}`);
      console.log(`  Match: ${result.computed_hash === embRow.content_hash ? '✓' : '✗'}`);

      expect(result.valid).toBe(true);
      expect(result.item_type).toBe(ProvenanceType.EMBEDDING);
      expect(result.expected_hash).toBe(EXPECTED_HASHES.embedding);
    });

    it.skipIf(!sqliteVecAvailable)('returns valid=false for mismatched hash', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const { ocrProvId } = createFullChain();

      // Tamper with the stored hash
      const badHash = 'sha256:' + '0'.repeat(64);
      rawDb.prepare('UPDATE ocr_results SET content_hash = ? WHERE provenance_id = ?').run(badHash, ocrProvId);

      const result = await verifier.verifyContentHash(ocrProvId);

      console.log('\n[VERIFY] Tampered hash detection:');
      console.log(`  Expected (tampered): ${badHash}`);
      console.log(`  Computed (correct): ${result.computed_hash}`);
      console.log(`  Valid: ${result.valid ? 'FAIL - should be false' : '✓ correctly detected'}`);

      expect(result.valid).toBe(false);
      expect(result.expected_hash).toBe(badHash);
      expect(result.computed_hash).toBe(EXPECTED_HASHES.ocr);
    });

    it.skipIf(!sqliteVecAvailable)('throws NOT_FOUND for nonexistent provenance ID', async () => {
      const nonexistentId = uuidv4();

      await expect(verifier.verifyContentHash(nonexistentId))
        .rejects.toThrow();

      try {
        await verifier.verifyContentHash(nonexistentId);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        console.log('\n[VERIFY] NOT_FOUND thrown for nonexistent provenance ✓');
      }
    });

    it.skipIf(!sqliteVecAvailable)('throws CONTENT_NOT_FOUND when OCR content record missing', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create provenance without corresponding OCR record
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

      // Create OCR provenance WITHOUT the actual OCR record
      const ocrProvId = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docProvId,
        root_document_id: docProvId,
        content_hash: EXPECTED_HASHES.ocr,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      await expect(verifier.verifyContentHash(ocrProvId))
        .rejects.toThrow(VerifierError);

      try {
        await verifier.verifyContentHash(ocrProvId);
      } catch (e) {
        expect(e).toBeInstanceOf(VerifierError);
        expect((e as VerifierError).code).toBe(VerifierErrorCode.CONTENT_NOT_FOUND);
        console.log('\n[VERIFY] CONTENT_NOT_FOUND thrown for missing OCR record ✓');
      }
    });

    it.skipIf(!sqliteVecAvailable)('throws FILE_NOT_FOUND when source file deleted', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create a temporary file that we'll delete
      const tempFilePath = join(testDir, 'temp-delete.txt');
      writeFileSync(tempFilePath, 'temporary content');
      const tempFileHash = await hashFile(tempFilePath);

      // Create provenance pointing to this file
      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: tempFileHash,
        file_hash: tempFileHash,
        source_path: tempFilePath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const docId = uuidv4();
      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, tempFilePath, 'temp-delete.txt', tempFileHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      // Delete the file
      unlinkSync(tempFilePath);
      expect(existsSync(tempFilePath)).toBe(false);

      // Verification should throw FILE_NOT_FOUND
      await expect(verifier.verifyContentHash(docProvId))
        .rejects.toThrow(VerifierError);

      try {
        await verifier.verifyContentHash(docProvId);
      } catch (e) {
        expect(e).toBeInstanceOf(VerifierError);
        expect((e as VerifierError).code).toBe(VerifierErrorCode.FILE_NOT_FOUND);
        console.log('\n[VERIFY] FILE_NOT_FOUND thrown for deleted file ✓');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // verifyChain() tests - 8 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('verifyChain()', () => {
    it.skipIf(!sqliteVecAvailable)('verifies complete 4-level chain (DOC→OCR→CHUNK→EMB)', async () => {
      const { embProvId, docProvId } = createFullChain();

      const result = await verifier.verifyChain(embProvId);

      console.log('\n[VERIFY] Complete 4-level chain verification:');
      console.log(`  Chain length: ${result.chain_length} (expected: 4) ${result.chain_length === 4 ? '✓' : '✗'}`);
      console.log(`  Chain depth: ${result.chain_depth} (expected: 3) ${result.chain_depth === 3 ? '✓' : '✗'}`);
      console.log(`  Hashes verified: ${result.hashes_verified} (expected: 4) ${result.hashes_verified === 4 ? '✓' : '✗'}`);
      console.log(`  Hashes failed: ${result.hashes_failed} (expected: 0) ${result.hashes_failed === 0 ? '✓' : '✗'}`);
      console.log(`  Chain intact: ${result.chain_intact ? '✓' : '✗'}`);
      console.log(`  Valid: ${result.valid ? '✓' : '✗'}`);

      expect(result.valid).toBe(true);
      expect(result.chain_intact).toBe(true);
      expect(result.chain_length).toBe(4);
      expect(result.chain_depth).toBe(3);
      expect(result.hashes_verified).toBe(4);
      expect(result.hashes_failed).toBe(0);
      expect(result.failed_items).toHaveLength(0);
      expect(result.root_document_id).toBe(docProvId);
    });

    it.skipIf(!sqliteVecAvailable)('verifies single DOCUMENT chain', async () => {
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

      const result = await verifier.verifyChain(docProvId);

      expect(result.valid).toBe(true);
      expect(result.chain_length).toBe(1);
      expect(result.chain_depth).toBe(0);
      expect(result.hashes_verified).toBe(1);
    });

    it.skipIf(!sqliteVecAvailable)('reports all failing hashes in failed_items', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const { embProvId, ocrProvId, chunkProvId } = createFullChain();

      // Tamper with OCR and CHUNK hashes
      const badHash = 'sha256:' + 'f'.repeat(64);
      rawDb.prepare('UPDATE ocr_results SET content_hash = ? WHERE provenance_id = ?').run(badHash, ocrProvId);
      rawDb.prepare('UPDATE chunks SET text_hash = ? WHERE provenance_id = ?').run(badHash, chunkProvId);

      const result = await verifier.verifyChain(embProvId);

      console.log('\n[VERIFY] Multiple hash failures detection:');
      console.log(`  Total failures: ${result.hashes_failed}`);
      console.log(`  Failed items: ${result.failed_items.map(f => f.type).join(', ')}`);

      expect(result.valid).toBe(false);
      expect(result.hashes_failed).toBe(2);
      expect(result.failed_items.length).toBe(2);
      expect(result.failed_items.some(f => f.type === ProvenanceType.OCR_RESULT)).toBe(true);
      expect(result.failed_items.some(f => f.type === ProvenanceType.CHUNK)).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('verifies 2-level chain (DOC→OCR)', async () => {
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

      const ocrProvId = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docProvId,
        root_document_id: docProvId,
        content_hash: EXPECTED_HASHES.ocr,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      rawDb.prepare(`
        INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id,
          datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), ocrProvId, docId, SYNTHETIC.ocrText, SYNTHETIC.ocrText.length, 'req-123',
        'accurate', 1, EXPECTED_HASHES.ocr, new Date().toISOString(), new Date().toISOString(), 100);

      const result = await verifier.verifyChain(ocrProvId);

      expect(result.valid).toBe(true);
      expect(result.chain_length).toBe(2);
      expect(result.chain_depth).toBe(1);
      expect(result.hashes_verified).toBe(2);
    });

    it.skipIf(!sqliteVecAvailable)('verifies 3-level chain (DOC→OCR→CHUNK)', async () => {
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

      const ocrProvId = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docProvId,
        root_document_id: docProvId,
        content_hash: EXPECTED_HASHES.ocr,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const ocrId = uuidv4();
      rawDb.prepare(`
        INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id,
          datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ocrId, ocrProvId, docId, SYNTHETIC.ocrText, SYNTHETIC.ocrText.length, 'req-123',
        'accurate', 1, EXPECTED_HASHES.ocr, new Date().toISOString(), new Date().toISOString(), 100);

      const chunkProvId = tracker.createProvenance({
        type: ProvenanceType.CHUNK,
        source_type: 'CHUNKING',
        source_id: ocrProvId,
        root_document_id: docProvId,
        content_hash: EXPECTED_HASHES.chunk,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      rawDb.prepare(`
        INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end,
          overlap_previous, overlap_next, provenance_id, created_at, embedding_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), docId, ocrId, SYNTHETIC.chunkText, EXPECTED_HASHES.chunk, 0, 0, SYNTHETIC.chunkText.length,
        0, 0, chunkProvId, new Date().toISOString(), 'pending');

      const result = await verifier.verifyChain(chunkProvId);

      expect(result.valid).toBe(true);
      expect(result.chain_length).toBe(3);
      expect(result.chain_depth).toBe(2);
      expect(result.hashes_verified).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('throws NOT_FOUND for nonexistent chain start', async () => {
      await expect(verifier.verifyChain(uuidv4()))
        .rejects.toThrow();
    });

    it.skipIf(!sqliteVecAvailable)('reports errors in failed_items when content verification fails', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const { embProvId, ocrProvId } = createFullChain();

      // Tamper with OCR content so hash verification fails
      rawDb.prepare('UPDATE ocr_results SET extracted_text = ? WHERE provenance_id = ?')
        .run('TAMPERED CONTENT - hash will not match', ocrProvId);

      const result = await verifier.verifyChain(embProvId);

      console.log('\n[VERIFY] Tampered content detection in chain:');
      console.log(`  Valid: ${result.valid}`);
      console.log(`  Failed items: ${result.failed_items.length}`);
      console.log(`  Failed types: ${result.failed_items.map(f => f.type).join(', ')}`);

      expect(result.valid).toBe(false);
      expect(result.hashes_failed).toBeGreaterThan(0);
      expect(result.failed_items.some(f => f.type === ProvenanceType.OCR_RESULT)).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('returns correct root_document_id from any chain depth', async () => {
      const { embProvId, docProvId, chunkProvId, ocrProvId } = createFullChain();

      const fromEmb = await verifier.verifyChain(embProvId);
      const fromChunk = await verifier.verifyChain(chunkProvId);
      const fromOcr = await verifier.verifyChain(ocrProvId);

      expect(fromEmb.root_document_id).toBe(docProvId);
      expect(fromChunk.root_document_id).toBe(docProvId);
      expect(fromOcr.root_document_id).toBe(docProvId);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // verifyDatabase() tests - 5 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('verifyDatabase()', () => {
    it.skipIf(!sqliteVecAvailable)('verifies empty database returns valid=true', async () => {
      const result = await verifier.verifyDatabase();

      console.log('\n[VERIFY] Empty database verification:', result);

      expect(result.valid).toBe(true);
      expect(result.hashes_verified).toBe(0);
      expect(result.hashes_failed).toBe(0);
      expect(result.documents_verified).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('verifies database with complete chain', async () => {
      createFullChain();

      const result = await verifier.verifyDatabase();

      console.log('\n[VERIFY] Database with full chain:');
      console.log(`  Documents: ${result.documents_verified}`);
      console.log(`  OCR results: ${result.ocr_results_verified}`);
      console.log(`  Chunks: ${result.chunks_verified}`);
      console.log(`  Embeddings: ${result.embeddings_verified}`);
      console.log(`  Total verified: ${result.hashes_verified}`);
      console.log(`  Duration: ${result.duration_ms}ms`);

      expect(result.valid).toBe(true);
      expect(result.documents_verified).toBe(1);
      expect(result.ocr_results_verified).toBe(1);
      expect(result.chunks_verified).toBe(1);
      expect(result.embeddings_verified).toBe(1);
      expect(result.hashes_verified).toBe(4);
    });

    it.skipIf(!sqliteVecAvailable)('detects tampered records in database scan', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const { ocrProvId } = createFullChain();

      // Tamper with one record
      rawDb.prepare('UPDATE ocr_results SET content_hash = ? WHERE provenance_id = ?')
        .run('sha256:' + '0'.repeat(64), ocrProvId);

      const result = await verifier.verifyDatabase();

      console.log('\n[VERIFY] Tampered database detection:');
      console.log(`  Valid: ${result.valid}`);
      console.log(`  Failed: ${result.hashes_failed}`);

      expect(result.valid).toBe(false);
      expect(result.hashes_failed).toBe(1);
      expect(result.failed_items[0].type).toBe(ProvenanceType.OCR_RESULT);
    });

    it.skipIf(!sqliteVecAvailable)('tracks duration_ms', async () => {
      createFullChain();

      const result = await verifier.verifyDatabase();

      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(typeof result.duration_ms).toBe('number');
    });

    it.skipIf(!sqliteVecAvailable)('includes database_name in result', async () => {
      const result = await verifier.verifyDatabase();

      expect(result.database_name).toBeDefined();
      expect(typeof result.database_name).toBe('string');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // verifyFileIntegrity() tests - 4 tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('verifyFileIntegrity()', () => {
    it.skipIf(!sqliteVecAvailable)('verifies file matches stored hash', async () => {
      const { docId } = createFullChain();

      const result = await verifier.verifyFileIntegrity(docId);

      console.log('\n[VERIFY] File integrity:');
      console.log(`  File path: ${testFilePath}`);
      console.log(`  Expected: ${result.expected_hash}`);
      console.log(`  Computed: ${result.computed_hash}`);
      console.log(`  Valid: ${result.valid ? '✓' : '✗'}`);

      expect(result.valid).toBe(true);
      expect(result.item_type).toBe(ProvenanceType.DOCUMENT);
      expect(result.expected_hash).toBe(testFileHash);
      expect(result.computed_hash).toBe(testFileHash);
    });

    it.skipIf(!sqliteVecAvailable)('throws NOT_FOUND for nonexistent document', async () => {
      await expect(verifier.verifyFileIntegrity(uuidv4()))
        .rejects.toThrow(VerifierError);

      try {
        await verifier.verifyFileIntegrity(uuidv4());
      } catch (e) {
        expect(e).toBeInstanceOf(VerifierError);
        expect((e as VerifierError).code).toBe(VerifierErrorCode.NOT_FOUND);
      }
    });

    it.skipIf(!sqliteVecAvailable)('throws FILE_NOT_FOUND for deleted file', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create a file that we'll delete
      const tempPath = join(testDir, 'to-delete.txt');
      writeFileSync(tempPath, 'delete me');
      const tempHash = await hashFile(tempPath);

      // Create document record
      const docId = uuidv4();
      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: tempHash,
        file_hash: tempHash,
        source_path: tempPath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, tempPath, 'to-delete.txt', tempHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      // Delete file
      unlinkSync(tempPath);

      await expect(verifier.verifyFileIntegrity(docId))
        .rejects.toThrow(VerifierError);

      try {
        await verifier.verifyFileIntegrity(docId);
      } catch (e) {
        expect((e as VerifierError).code).toBe(VerifierErrorCode.FILE_NOT_FOUND);
      }
    });

    it.skipIf(!sqliteVecAvailable)('detects modified file content', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      // Create a file
      const tempPath = join(testDir, 'modify-me.txt');
      writeFileSync(tempPath, 'original content');
      const originalHash = await hashFile(tempPath);

      // Create document record with original hash
      const docId = uuidv4();
      const docProvId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: originalHash,
        file_hash: originalHash,
        source_path: tempPath,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      rawDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, tempPath, 'modify-me.txt', originalHash, 100, 'txt', 'complete', docProvId, new Date().toISOString());

      // Modify the file
      writeFileSync(tempPath, 'MODIFIED content');

      const result = await verifier.verifyFileIntegrity(docId);

      console.log('\n[VERIFY] Modified file detection:');
      console.log(`  Original hash: ${originalHash}`);
      console.log(`  Current hash: ${result.computed_hash}`);
      console.log(`  Valid: ${result.valid}`);

      expect(result.valid).toBe(false);
      expect(result.expected_hash).toBe(originalHash);
      expect(result.computed_hash).not.toBe(originalHash);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASES - 3+ tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it.skipIf(!sqliteVecAvailable)('handles empty string content correctly', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const emptyContent = '';
      const emptyHash = computeHash(emptyContent);

      console.log('\n[EDGE CASE] Empty content:');
      console.log(`  Empty string hash: ${emptyHash}`);

      // Verify hash is computed correctly for empty string
      expect(emptyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(emptyHash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it.skipIf(!sqliteVecAvailable)('detects invalid hash format', async () => {
      if (!db) return;
      const rawDb = db.getConnection();

      const { ocrProvId } = createFullChain();

      // Set invalid hash format (missing sha256: prefix)
      rawDb.prepare('UPDATE ocr_results SET content_hash = ? WHERE provenance_id = ?')
        .run('not-a-valid-hash', ocrProvId);

      const result = await verifier.verifyContentHash(ocrProvId);

      console.log('\n[EDGE CASE] Invalid hash format:');
      console.log(`  Expected (invalid): not-a-valid-hash`);
      console.log(`  Format valid: ${result.format_valid}`);
      console.log(`  Overall valid: ${result.valid}`);

      expect(result.format_valid).toBe(false);
      expect(result.valid).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('verifies maximum depth chain (depth=3)', async () => {
      const { embProvId } = createFullChain();

      const result = await verifier.verifyChain(embProvId);

      console.log('\n[EDGE CASE] Maximum depth chain:');
      console.log(`  Chain depth: ${result.chain_depth}`);
      console.log(`  Chain length: ${result.chain_length}`);
      console.log(`  All verified: ${result.hashes_verified === 4 ? '✓' : '✗'}`);

      expect(result.chain_depth).toBe(3);
      expect(result.chain_length).toBe(4);
      expect(result.valid).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('handles unicode content correctly', async () => {
      const unicodeContent = '日本語テキスト 🎉 émojis and spëcial çharacters';
      const unicodeHash = computeHash(unicodeContent);

      console.log('\n[EDGE CASE] Unicode content:');
      console.log(`  Content: ${unicodeContent}`);
      console.log(`  Hash: ${unicodeHash}`);

      // Verify hash is computed correctly for unicode
      expect(unicodeHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it.skipIf(!sqliteVecAvailable)('verifies multiple independent chains', async () => {
      // Create two separate chains
      createFullChain();

      // Create a second independent chain
      if (!db) return;
      const rawDb = db.getConnection();

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
      `).run(docId2, secondFilePath, 'second-doc.txt', secondFileHash, 100, 'txt', 'complete', docProvId2, new Date().toISOString());

      // Verify database with multiple chains
      const result = await verifier.verifyDatabase();

      console.log('\n[EDGE CASE] Multiple chains:');
      console.log(`  Documents verified: ${result.documents_verified}`);
      console.log(`  Total hashes verified: ${result.hashes_verified}`);

      expect(result.documents_verified).toBe(2);
      expect(result.hashes_verified).toBe(5); // 4 from first chain + 1 document
      expect(result.valid).toBe(true);
    });
  });
});
