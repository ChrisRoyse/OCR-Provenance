/**
 * Task 17 Full State Verification Test
 *
 * CRITICAL: Uses REAL DatabaseService - NO MOCKS
 * Verifies physical database state after all operations
 *
 * This test proves:
 * 1. DOCUMENT uses file_hash (not content_hash)
 * 2. OCR_RESULT uses content_hash
 * 3. CHUNK uses text_hash (not content_hash)
 * 4. EMBEDDING uses content_hash
 * 5. Chain verification works end-to-end
 * 6. Tamper detection works
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../src/services/storage/database/index.js';
import {
  ProvenanceTracker,
  ProvenanceVerifier,
  VerifierError,
  VerifierErrorCode,
  resetProvenanceTracker,
} from '../../src/services/provenance/index.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import { computeHash, hashFile } from '../../src/utils/hash.js';

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

describe('Task 17 Full State Verification', () => {
  let testDir: string;
  let db: DatabaseService | undefined;
  let tracker: ProvenanceTracker;
  let verifier: ProvenanceVerifier;
  let testFilePath: string;
  let testFileHash: string;

  // Synthetic test data
  const SYNTHETIC = {
    fileContent: 'Task 17 verification document content.',
    ocrText: 'OCR extracted text for Task 17 verification.',
    chunkText: 'First chunk of text for Task 17.',
    embeddingText: 'First chunk of text for Task 17.',
  };

  beforeAll(async () => {
    if (!sqliteVecAvailable) {
      console.warn('sqlite-vec not available, skipping tests');
      return;
    }

    testDir = mkdtempSync(join(tmpdir(), 'task17-verify-'));
    testFilePath = join(testDir, 'task17-doc.txt');
    writeFileSync(testFilePath, SYNTHETIC.fileContent);
    testFileHash = await hashFile(testFilePath);

    console.log('\n' + '='.repeat(80));
    console.log('TASK 17 FULL STATE VERIFICATION');
    console.log('='.repeat(80));
    console.log('\n[SYNTHETIC DATA]');
    console.log(`  File: ${testFilePath}`);
    console.log(`  File hash: ${testFileHash}`);
    console.log(`  OCR hash: ${computeHash(SYNTHETIC.ocrText)}`);
    console.log(`  Chunk hash (text_hash): ${computeHash(SYNTHETIC.chunkText)}`);
    console.log(`  Embedding hash: ${computeHash(SYNTHETIC.embeddingText)}`);
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  beforeEach(() => {
    if (!sqliteVecAvailable) return;
    resetProvenanceTracker();
    const dbName = `task17-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = DatabaseService.create(dbName, undefined, testDir);
    tracker = new ProvenanceTracker(db);
    verifier = new ProvenanceVerifier(db, tracker);
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore
      }
    }
  });

  // Helper to create full chain
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
    if (!db) throw new Error('DB not initialized');
    const rawDb = db.getConnection();

    // DOCUMENT
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

    const docId = uuidv4();
    rawDb.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docId, testFilePath, 'task17-doc.txt', testFileHash, SYNTHETIC.fileContent.length, 'txt', 'complete', docProvId, new Date().toISOString());

    // OCR_RESULT
    const ocrHash = computeHash(SYNTHETIC.ocrText);
    const ocrProvId = tracker.createProvenance({
      type: ProvenanceType.OCR_RESULT,
      source_type: 'OCR',
      source_id: docProvId,
      root_document_id: docProvId,
      content_hash: ocrHash,
      processor: 'datalab-ocr',
      processor_version: '1.0.0',
      processing_params: { mode: 'accurate' },
    });

    const ocrId = uuidv4();
    rawDb.prepare(`
      INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id,
        datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ocrId, ocrProvId, docId, SYNTHETIC.ocrText, SYNTHETIC.ocrText.length, 'req-17',
      'accurate', 1, ocrHash, new Date().toISOString(), new Date().toISOString(), 100);

    // CHUNK - CRITICAL: uses text_hash
    const chunkHash = computeHash(SYNTHETIC.chunkText);
    const chunkProvId = tracker.createProvenance({
      type: ProvenanceType.CHUNK,
      source_type: 'CHUNKING',
      source_id: ocrProvId,
      root_document_id: docProvId,
      content_hash: chunkHash,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { chunk_size: 2000 },
    });

    const chunkId = uuidv4();
    rawDb.prepare(`
      INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end,
        overlap_previous, overlap_next, provenance_id, created_at, embedding_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chunkId, docId, ocrId, SYNTHETIC.chunkText, chunkHash, 0, 0, SYNTHETIC.chunkText.length,
      0, 0, chunkProvId, new Date().toISOString(), 'complete');

    // EMBEDDING
    const embHash = computeHash(SYNTHETIC.embeddingText);
    const embProvId = tracker.createProvenance({
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: chunkProvId,
      root_document_id: docProvId,
      content_hash: embHash,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { dimensions: 768 },
    });

    const embId = uuidv4();
    rawDb.prepare(`
      INSERT INTO embeddings (id, chunk_id, document_id, original_text, original_text_length, source_file_path,
        source_file_name, source_file_hash, character_start, character_end, chunk_index, total_chunks,
        model_name, model_version, task_type, inference_mode, provenance_id, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(embId, chunkId, docId, SYNTHETIC.embeddingText, SYNTHETIC.embeddingText.length, testFilePath,
      'task17-doc.txt', testFileHash, 0, SYNTHETIC.embeddingText.length, 0, 1,
      'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local', embProvId, embHash, new Date().toISOString());

    return { docId, docProvId, ocrId, ocrProvId, chunkId, chunkProvId, embId, embProvId };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // CRITICAL: Verify hash field mappings
  // ═══════════════════════════════════════════════════════════════════════════════

  it.skipIf(!sqliteVecAvailable)('DOCUMENT uses file_hash from documents table', async () => {
    const { docProvId } = createFullChain();
    const rawDb = db!.getConnection();

    const result = await verifier.verifyContentHash(docProvId);

    // Physical verification
    const docRow = rawDb.prepare('SELECT file_hash, file_path FROM documents WHERE provenance_id = ?').get(docProvId) as { file_hash: string; file_path: string };
    const actualFileHash = await hashFile(docRow.file_path);

    console.log('\n[SOURCE OF TRUTH: DOCUMENT]');
    console.log(`  DB file_hash: ${docRow.file_hash}`);
    console.log(`  Actual file hash: ${actualFileHash}`);
    console.log(`  Verifier computed: ${result.computed_hash}`);
    console.log(`  All match: ${docRow.file_hash === actualFileHash && actualFileHash === result.computed_hash ? '✓' : '✗'}`);

    expect(result.valid).toBe(true);
    expect(result.expected_hash).toBe(docRow.file_hash);
    expect(result.computed_hash).toBe(actualFileHash);
  });

  it.skipIf(!sqliteVecAvailable)('OCR_RESULT uses content_hash from ocr_results table', async () => {
    const { ocrProvId } = createFullChain();
    const rawDb = db!.getConnection();

    const result = await verifier.verifyContentHash(ocrProvId);

    // Physical verification
    const ocrRow = rawDb.prepare('SELECT content_hash, extracted_text FROM ocr_results WHERE provenance_id = ?').get(ocrProvId) as { content_hash: string; extracted_text: string };
    const recomputedHash = computeHash(ocrRow.extracted_text);

    console.log('\n[SOURCE OF TRUTH: OCR_RESULT]');
    console.log(`  DB content_hash: ${ocrRow.content_hash}`);
    console.log(`  Recomputed from text: ${recomputedHash}`);
    console.log(`  Verifier computed: ${result.computed_hash}`);
    console.log(`  All match: ${ocrRow.content_hash === recomputedHash && recomputedHash === result.computed_hash ? '✓' : '✗'}`);

    expect(result.valid).toBe(true);
    expect(result.expected_hash).toBe(ocrRow.content_hash);
    expect(result.computed_hash).toBe(recomputedHash);
  });

  it.skipIf(!sqliteVecAvailable)('CHUNK uses text_hash (NOT content_hash) from chunks table', async () => {
    const { chunkProvId } = createFullChain();
    const rawDb = db!.getConnection();

    const result = await verifier.verifyContentHash(chunkProvId);

    // Physical verification - CRITICAL: text_hash not content_hash
    const chunkRow = rawDb.prepare('SELECT text_hash, text FROM chunks WHERE provenance_id = ?').get(chunkProvId) as { text_hash: string; text: string };
    const recomputedHash = computeHash(chunkRow.text);

    console.log('\n[SOURCE OF TRUTH: CHUNK - uses text_hash]');
    console.log(`  DB text_hash: ${chunkRow.text_hash}`);
    console.log(`  Recomputed from text: ${recomputedHash}`);
    console.log(`  Verifier expected: ${result.expected_hash}`);
    console.log(`  All match: ${chunkRow.text_hash === recomputedHash && recomputedHash === result.expected_hash ? '✓' : '✗'}`);

    expect(result.valid).toBe(true);
    expect(result.expected_hash).toBe(chunkRow.text_hash);
    expect(result.computed_hash).toBe(recomputedHash);
  });

  it.skipIf(!sqliteVecAvailable)('EMBEDDING uses content_hash from embeddings table', async () => {
    const { embProvId } = createFullChain();
    const rawDb = db!.getConnection();

    const result = await verifier.verifyContentHash(embProvId);

    // Physical verification
    const embRow = rawDb.prepare('SELECT content_hash, original_text FROM embeddings WHERE provenance_id = ?').get(embProvId) as { content_hash: string; original_text: string };
    const recomputedHash = computeHash(embRow.original_text);

    console.log('\n[SOURCE OF TRUTH: EMBEDDING]');
    console.log(`  DB content_hash: ${embRow.content_hash}`);
    console.log(`  Recomputed from original_text: ${recomputedHash}`);
    console.log(`  Verifier computed: ${result.computed_hash}`);
    console.log(`  All match: ${embRow.content_hash === recomputedHash && recomputedHash === result.computed_hash ? '✓' : '✗'}`);

    expect(result.valid).toBe(true);
    expect(result.expected_hash).toBe(embRow.content_hash);
    expect(result.computed_hash).toBe(recomputedHash);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Chain and Database verification
  // ═══════════════════════════════════════════════════════════════════════════════

  it.skipIf(!sqliteVecAvailable)('verifyChain validates complete 4-level provenance chain', async () => {
    const { embProvId, docProvId } = createFullChain();
    const rawDb = db!.getConnection();

    const result = await verifier.verifyChain(embProvId);

    // Physical verification of chain in DB
    const chainRecords = rawDb.prepare(`
      SELECT id, type, chain_depth FROM provenance ORDER BY chain_depth ASC
    `).all() as Array<{ id: string; type: string; chain_depth: number }>;

    console.log('\n[SOURCE OF TRUTH: CHAIN]');
    console.log(`  Provenance records in DB: ${chainRecords.length}`);
    chainRecords.forEach(r => console.log(`    - ${r.type} (depth ${r.chain_depth}): ${r.id}`));
    console.log(`  Chain result length: ${result.chain_length}`);
    console.log(`  Chain result depth: ${result.chain_depth}`);
    console.log(`  All hashes verified: ${result.hashes_verified}`);
    console.log(`  Failed hashes: ${result.hashes_failed}`);
    console.log(`  Valid: ${result.valid ? '✓' : '✗'}`);

    expect(result.valid).toBe(true);
    expect(result.chain_length).toBe(4);
    expect(result.chain_depth).toBe(3);
    expect(result.hashes_verified).toBe(4);
    expect(result.hashes_failed).toBe(0);
    expect(result.root_document_id).toBe(docProvId);
  });

  it.skipIf(!sqliteVecAvailable)('verifyDatabase validates all records in database', async () => {
    createFullChain();
    const rawDb = db!.getConnection();

    const result = await verifier.verifyDatabase();

    // Physical verification
    const counts = {
      provenance: (rawDb.prepare('SELECT COUNT(*) as c FROM provenance').get() as { c: number }).c,
      documents: (rawDb.prepare('SELECT COUNT(*) as c FROM documents').get() as { c: number }).c,
      ocr_results: (rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results').get() as { c: number }).c,
      chunks: (rawDb.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c,
      embeddings: (rawDb.prepare('SELECT COUNT(*) as c FROM embeddings').get() as { c: number }).c,
    };

    console.log('\n[SOURCE OF TRUTH: DATABASE]');
    console.log(`  DB provenance count: ${counts.provenance}`);
    console.log(`  DB documents count: ${counts.documents}`);
    console.log(`  DB ocr_results count: ${counts.ocr_results}`);
    console.log(`  DB chunks count: ${counts.chunks}`);
    console.log(`  DB embeddings count: ${counts.embeddings}`);
    console.log(`  Verifier documents_verified: ${result.documents_verified}`);
    console.log(`  Verifier total hashes_verified: ${result.hashes_verified}`);
    console.log(`  Valid: ${result.valid ? '✓' : '✗'}`);

    expect(result.valid).toBe(true);
    expect(result.documents_verified).toBe(counts.documents);
    expect(result.ocr_results_verified).toBe(counts.ocr_results);
    expect(result.chunks_verified).toBe(counts.chunks);
    expect(result.embeddings_verified).toBe(counts.embeddings);
    expect(result.hashes_verified).toBe(counts.provenance);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Edge cases and tamper detection
  // ═══════════════════════════════════════════════════════════════════════════════

  it.skipIf(!sqliteVecAvailable)('detects tampered hash in OCR_RESULT', async () => {
    const { ocrProvId } = createFullChain();
    const rawDb = db!.getConnection();

    // Tamper with the hash
    const tamperedHash = 'sha256:' + '0'.repeat(64);
    rawDb.prepare('UPDATE ocr_results SET content_hash = ? WHERE provenance_id = ?').run(tamperedHash, ocrProvId);

    const result = await verifier.verifyContentHash(ocrProvId);

    console.log('\n[EDGE CASE: TAMPER DETECTION]');
    console.log(`  Tampered hash: ${tamperedHash}`);
    console.log(`  Actual computed: ${result.computed_hash}`);
    console.log(`  Valid (should be false): ${result.valid ? '✗ FAILED' : '✓ correctly detected'}`);

    expect(result.valid).toBe(false);
    expect(result.expected_hash).toBe(tamperedHash);
    expect(result.computed_hash).not.toBe(tamperedHash);
  });

  it.skipIf(!sqliteVecAvailable)('detects tampered hash in CHUNK (text_hash)', async () => {
    const { chunkProvId } = createFullChain();
    const rawDb = db!.getConnection();

    // Tamper with text_hash
    const tamperedHash = 'sha256:' + 'f'.repeat(64);
    rawDb.prepare('UPDATE chunks SET text_hash = ? WHERE provenance_id = ?').run(tamperedHash, chunkProvId);

    const result = await verifier.verifyContentHash(chunkProvId);

    console.log('\n[EDGE CASE: CHUNK TAMPER DETECTION]');
    console.log(`  Tampered text_hash: ${tamperedHash}`);
    console.log(`  Actual computed: ${result.computed_hash}`);
    console.log(`  Valid (should be false): ${result.valid ? '✗ FAILED' : '✓ correctly detected'}`);

    expect(result.valid).toBe(false);
    expect(result.expected_hash).toBe(tamperedHash);
  });

  it.skipIf(!sqliteVecAvailable)('handles empty string content hash correctly', async () => {
    const emptyHash = computeHash('');

    console.log('\n[EDGE CASE: EMPTY STRING]');
    console.log(`  Empty string hash: ${emptyHash}`);
    console.log(`  Expected known value: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`);

    // SHA-256 of empty string is a known value
    expect(emptyHash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
