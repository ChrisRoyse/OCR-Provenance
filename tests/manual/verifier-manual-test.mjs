/**
 * Manual Test Script for ProvenanceVerifier (Task 17)
 * Run with: node tests/manual/verifier-manual-test.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../dist/services/storage/database/index.js';
import {
  ProvenanceTracker,
  ProvenanceVerifier,
  resetProvenanceTracker,
} from '../../dist/services/provenance/index.js';
import { ProvenanceType } from '../../dist/models/provenance.js';
import { computeHash, hashFile, isValidHashFormat } from '../../dist/utils/hash.js';

// Synthetic test data with known values
const SYNTHETIC = {
  fileContent: 'MANUAL TEST: Document content for verification.',
  ocrText: 'MANUAL TEST: Extracted OCR text.',
  chunkText: 'MANUAL TEST: Chunk text.',
  embeddingText: 'MANUAL TEST: Chunk text.'
};

async function main() {
  console.log('\n' + '▓'.repeat(80));
  console.log('MANUAL TEST SUITE: ProvenanceVerifier (Task 17)');
  console.log('▓'.repeat(80));

  // Setup
  const testDir = mkdtempSync(join(tmpdir(), 'manual-verifier-'));
  const testFilePath = join(testDir, 'test-doc.txt');
  writeFileSync(testFilePath, SYNTHETIC.fileContent);

  const expectedHashes = {
    file: await hashFile(testFilePath),
    ocr: computeHash(SYNTHETIC.ocrText),
    chunk: computeHash(SYNTHETIC.chunkText),
    embedding: computeHash(SYNTHETIC.embeddingText)
  };

  console.log('\n[SYNTHETIC DATA - KNOWN EXPECTED HASHES]');
  console.log('  File hash:', expectedHashes.file);
  console.log('  OCR hash:', expectedHashes.ocr);
  console.log('  Chunk hash:', expectedHashes.chunk);
  console.log('  Embedding hash:', expectedHashes.embedding);

  resetProvenanceTracker();
  const db = DatabaseService.create('manual-test-' + Date.now(), undefined, testDir);
  const tracker = new ProvenanceTracker(db);
  const verifier = new ProvenanceVerifier(db, tracker);
  const rawDb = db.getConnection();

  // Create full 4-level chain
  console.log('\n' + '═'.repeat(80));
  console.log('CREATING FULL PROVENANCE CHAIN (DOC→OCR→CHUNK→EMBEDDING)');
  console.log('═'.repeat(80));

  // 1. DOCUMENT
  const docProvId = tracker.createProvenance({
    type: ProvenanceType.DOCUMENT,
    source_type: 'FILE',
    root_document_id: '',
    content_hash: expectedHashes.file,
    file_hash: expectedHashes.file,
    source_path: testFilePath,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {}
  });

  const docId = uuidv4();
  rawDb.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(docId, testFilePath, 'test-doc.txt', expectedHashes.file, SYNTHETIC.fileContent.length, 'txt', 'complete', docProvId, new Date().toISOString());

  // 2. OCR_RESULT
  const ocrProvId = tracker.createProvenance({
    type: ProvenanceType.OCR_RESULT,
    source_type: 'OCR',
    source_id: docProvId,
    root_document_id: docProvId,
    content_hash: expectedHashes.ocr,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {}
  });

  const ocrId = uuidv4();
  rawDb.prepare(`INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id,
    datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ocrId, ocrProvId, docId, SYNTHETIC.ocrText, SYNTHETIC.ocrText.length, 'req-123', 'accurate', 1, expectedHashes.ocr, new Date().toISOString(), new Date().toISOString(), 100);

  // 3. CHUNK
  const chunkProvId = tracker.createProvenance({
    type: ProvenanceType.CHUNK,
    source_type: 'CHUNKING',
    source_id: ocrProvId,
    root_document_id: docProvId,
    content_hash: expectedHashes.chunk,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {}
  });

  const chunkId = uuidv4();
  rawDb.prepare(`INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end,
    overlap_previous, overlap_next, provenance_id, created_at, embedding_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chunkId, docId, ocrId, SYNTHETIC.chunkText, expectedHashes.chunk, 0, 0, SYNTHETIC.chunkText.length, 0, 0, chunkProvId, new Date().toISOString(), 'complete');

  // 4. EMBEDDING
  const embProvId = tracker.createProvenance({
    type: ProvenanceType.EMBEDDING,
    source_type: 'EMBEDDING',
    source_id: chunkProvId,
    root_document_id: docProvId,
    content_hash: expectedHashes.embedding,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {}
  });

  const embId = uuidv4();
  rawDb.prepare(`INSERT INTO embeddings (id, chunk_id, document_id, original_text, original_text_length, source_file_path,
    source_file_name, source_file_hash, character_start, character_end, chunk_index, total_chunks,
    model_name, model_version, task_type, inference_mode, provenance_id, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(embId, chunkId, docId, SYNTHETIC.embeddingText, SYNTHETIC.embeddingText.length, testFilePath, 'test-doc.txt', expectedHashes.file, 0, SYNTHETIC.embeddingText.length, 0, 1, 'test-model', '1.0', 'search_document', 'local', embProvId, expectedHashes.embedding, new Date().toISOString());

  console.log('\n[CREATED IDs]');
  console.log('  Document ID:', docId);
  console.log('  Doc Provenance ID:', docProvId);
  console.log('  OCR Provenance ID:', ocrProvId);
  console.log('  Chunk Provenance ID:', chunkProvId);
  console.log('  Embedding Provenance ID:', embProvId);

  // ═══════════════════════════════════════════════════════════════════════════════
  // PHYSICAL DATABASE STATE VERIFICATION (SOURCE OF TRUTH)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('PHYSICAL DATABASE STATE VERIFICATION (SOURCE OF TRUTH)');
  console.log('═'.repeat(80));

  console.log('\n[DOCUMENTS TABLE] - file_hash field');
  const docs = rawDb.prepare('SELECT id, file_hash, provenance_id FROM documents').all();
  docs.forEach(d => {
    console.log('  id=' + d.id.slice(0,8) + '... file_hash=' + d.file_hash);
  });

  console.log('\n[PROVENANCE TABLE] - content_hash field');
  const provs = rawDb.prepare('SELECT id, type, content_hash, chain_depth, parent_id FROM provenance ORDER BY chain_depth').all();
  provs.forEach(p => {
    console.log('  depth=' + p.chain_depth + ' type=' + p.type.padEnd(12) + ' content_hash=' + (p.content_hash || 'null'));
  });

  console.log('\n[OCR_RESULTS TABLE] - content_hash field');
  const ocrs = rawDb.prepare('SELECT id, content_hash, extracted_text FROM ocr_results').all();
  ocrs.forEach(o => {
    console.log('  content_hash=' + o.content_hash);
    console.log('  extracted_text="' + o.extracted_text + '"');
  });

  console.log('\n[CHUNKS TABLE] - text_hash field (NOT content_hash!)');
  const chunks = rawDb.prepare('SELECT id, text_hash, text FROM chunks').all();
  chunks.forEach(c => {
    console.log('  text_hash=' + c.text_hash);
    console.log('  text="' + c.text + '"');
  });

  console.log('\n[EMBEDDINGS TABLE] - content_hash field');
  const embs = rawDb.prepare('SELECT id, content_hash, original_text FROM embeddings').all();
  embs.forEach(e => {
    console.log('  content_hash=' + e.content_hash);
    console.log('  original_text="' + e.original_text + '"');
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 1: verifyContentHash() - All 4 Types
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('TEST 1: verifyContentHash() - All 4 Types');
  console.log('═'.repeat(80));

  let test1Passed = true;

  // 1.1 DOCUMENT
  console.log('\n[1.1 DOCUMENT]');
  const docResult = await verifier.verifyContentHash(docProvId);
  console.log('  Expected hash:', expectedHashes.file);
  console.log('  Computed hash:', docResult.computed_hash);
  console.log('  Match:', docResult.computed_hash === expectedHashes.file ? '✓' : '✗');
  console.log('  valid:', docResult.valid);
  console.log('  format_valid:', docResult.format_valid);
  if (!docResult.valid) test1Passed = false;

  // 1.2 OCR_RESULT
  console.log('\n[1.2 OCR_RESULT]');
  const ocrResult = await verifier.verifyContentHash(ocrProvId);
  console.log('  Expected hash:', expectedHashes.ocr);
  console.log('  Computed hash:', ocrResult.computed_hash);
  console.log('  Match:', ocrResult.computed_hash === expectedHashes.ocr ? '✓' : '✗');
  console.log('  valid:', ocrResult.valid);
  if (!ocrResult.valid) test1Passed = false;

  // 1.3 CHUNK (CRITICAL: uses text_hash)
  console.log('\n[1.3 CHUNK - uses text_hash field]');
  const chunkResult = await verifier.verifyContentHash(chunkProvId);
  console.log('  Expected hash:', expectedHashes.chunk);
  console.log('  Computed hash:', chunkResult.computed_hash);
  console.log('  Match:', chunkResult.computed_hash === expectedHashes.chunk ? '✓' : '✗');
  console.log('  valid:', chunkResult.valid);
  if (!chunkResult.valid) test1Passed = false;

  // 1.4 EMBEDDING
  console.log('\n[1.4 EMBEDDING]');
  const embResult = await verifier.verifyContentHash(embProvId);
  console.log('  Expected hash:', expectedHashes.embedding);
  console.log('  Computed hash:', embResult.computed_hash);
  console.log('  Match:', embResult.computed_hash === expectedHashes.embedding ? '✓' : '✗');
  console.log('  valid:', embResult.valid);
  if (!embResult.valid) test1Passed = false;

  console.log('\n[TEST 1 RESULT]', test1Passed ? '✓ PASSED' : '✗ FAILED');

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 2: verifyChain() - Full Chain Verification
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('TEST 2: verifyChain() - Full 4-Level Chain');
  console.log('═'.repeat(80));

  let test2Passed = true;

  const chainResult = await verifier.verifyChain(embProvId);
  console.log('\n[CHAIN VERIFICATION FROM EMBEDDING]');
  console.log('  chain_length:', chainResult.chain_length, '(expected: 4)', chainResult.chain_length === 4 ? '✓' : '✗');
  console.log('  chain_depth:', chainResult.chain_depth, '(expected: 3)', chainResult.chain_depth === 3 ? '✓' : '✗');
  console.log('  hashes_verified:', chainResult.hashes_verified, '(expected: 4)', chainResult.hashes_verified === 4 ? '✓' : '✗');
  console.log('  hashes_failed:', chainResult.hashes_failed, '(expected: 0)', chainResult.hashes_failed === 0 ? '✓' : '✗');
  console.log('  chain_intact:', chainResult.chain_intact);
  console.log('  valid:', chainResult.valid);
  console.log('  root_document_id:', chainResult.root_document_id);
  console.log('  expected root:', docProvId);
  console.log('  root match:', chainResult.root_document_id === docProvId ? '✓' : '✗');

  if (chainResult.chain_length !== 4 || chainResult.chain_depth !== 3 || !chainResult.valid) {
    test2Passed = false;
  }

  console.log('\n[TEST 2 RESULT]', test2Passed ? '✓ PASSED' : '✗ FAILED');

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 3: verifyDatabase() - Full Database Scan
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('TEST 3: verifyDatabase() - Full Database Scan');
  console.log('═'.repeat(80));

  let test3Passed = true;

  const dbResult = await verifier.verifyDatabase();
  console.log('\n[DATABASE VERIFICATION]');
  console.log('  documents_verified:', dbResult.documents_verified, '(expected: 1)');
  console.log('  ocr_results_verified:', dbResult.ocr_results_verified, '(expected: 1)');
  console.log('  chunks_verified:', dbResult.chunks_verified, '(expected: 1)');
  console.log('  embeddings_verified:', dbResult.embeddings_verified, '(expected: 1)');
  console.log('  hashes_verified:', dbResult.hashes_verified, '(expected: 4)');
  console.log('  hashes_failed:', dbResult.hashes_failed, '(expected: 0)');
  console.log('  duration_ms:', dbResult.duration_ms);
  console.log('  valid:', dbResult.valid);

  if (!dbResult.valid || dbResult.hashes_verified !== 4) {
    test3Passed = false;
  }

  console.log('\n[TEST 3 RESULT]', test3Passed ? '✓ PASSED' : '✗ FAILED');

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 4: verifyFileIntegrity()
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('TEST 4: verifyFileIntegrity()');
  console.log('═'.repeat(80));

  let test4Passed = true;

  const fileResult = await verifier.verifyFileIntegrity(docId);
  console.log('\n[FILE INTEGRITY]');
  console.log('  file:', testFilePath);
  console.log('  expected_hash:', fileResult.expected_hash);
  console.log('  computed_hash:', fileResult.computed_hash);
  console.log('  valid:', fileResult.valid);

  if (!fileResult.valid) test4Passed = false;

  console.log('\n[TEST 4 RESULT]', test4Passed ? '✓ PASSED' : '✗ FAILED');

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 5: Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('TEST 5: Edge Cases');
  console.log('═'.repeat(80));

  let test5Passed = true;

  // Edge Case 5.1: Empty string hash
  console.log('\n[5.1 EMPTY STRING HASH]');
  const emptyHash = computeHash('');
  const expectedEmpty = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  console.log('  Computed:', emptyHash);
  console.log('  Expected:', expectedEmpty);
  console.log('  Match:', emptyHash === expectedEmpty ? '✓ PASS' : '✗ FAIL');
  if (emptyHash !== expectedEmpty) test5Passed = false;

  // Edge Case 5.2: Tampered hash detection
  console.log('\n[5.2 TAMPERED HASH DETECTION]');
  console.log('  BEFORE: Check OCR content_hash in database');
  const beforeOcr = rawDb.prepare('SELECT content_hash FROM ocr_results WHERE provenance_id = ?').get(ocrProvId);
  console.log('  Stored hash:', beforeOcr.content_hash);

  console.log('\n  TAMPERING: Setting bad hash...');
  rawDb.prepare('UPDATE ocr_results SET content_hash = ? WHERE provenance_id = ?').run('sha256:' + '0'.repeat(64), ocrProvId);

  console.log('\n  AFTER: Check OCR content_hash in database');
  const afterOcr = rawDb.prepare('SELECT content_hash FROM ocr_results WHERE provenance_id = ?').get(ocrProvId);
  console.log('  Stored hash:', afterOcr.content_hash);

  console.log('\n  VERIFICATION: Running verifyContentHash...');
  const tamperedResult = await verifier.verifyContentHash(ocrProvId);
  console.log('  valid:', tamperedResult.valid, '(expected: false)');
  console.log('  Tamper detected:', !tamperedResult.valid ? '✓ PASS' : '✗ FAIL');
  if (tamperedResult.valid) test5Passed = false;

  // Edge Case 5.3: Invalid hash format
  console.log('\n[5.3 INVALID HASH FORMAT]');
  rawDb.prepare('UPDATE ocr_results SET content_hash = ? WHERE provenance_id = ?').run('not-a-valid-hash', ocrProvId);
  const invalidResult = await verifier.verifyContentHash(ocrProvId);
  console.log('  format_valid:', invalidResult.format_valid, '(expected: false)');
  console.log('  valid:', invalidResult.valid, '(expected: false)');
  console.log('  Invalid format detected:', !invalidResult.format_valid ? '✓ PASS' : '✗ FAIL');
  if (invalidResult.format_valid) test5Passed = false;

  // Edge Case 5.4: Nonexistent ID throws
  console.log('\n[5.4 NONEXISTENT ID]');
  try {
    await verifier.verifyContentHash(uuidv4());
    console.log('  ✗ FAIL - Should have thrown');
    test5Passed = false;
  } catch (e) {
    console.log('  Error thrown:', e.name);
    console.log('  ✓ PASS');
  }

  // Edge Case 5.5: Unicode content
  console.log('\n[5.5 UNICODE CONTENT]');
  const unicodeContent = '日本語テキスト 🎉 émojis';
  const unicodeHash = computeHash(unicodeContent);
  console.log('  Content:', unicodeContent);
  console.log('  Hash:', unicodeHash);
  console.log('  Valid format:', isValidHashFormat(unicodeHash) ? '✓ PASS' : '✗ FAIL');
  if (!isValidHashFormat(unicodeHash)) test5Passed = false;

  console.log('\n[TEST 5 RESULT]', test5Passed ? '✓ PASSED' : '✗ FAILED');

  // Cleanup
  db.close();
  rmSync(testDir, { recursive: true, force: true });

  // ═══════════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '▓'.repeat(80));
  console.log('FINAL RESULTS');
  console.log('▓'.repeat(80));

  const results = [
    { test: 'TEST 1: verifyContentHash()', passed: test1Passed },
    { test: 'TEST 2: verifyChain()', passed: test2Passed },
    { test: 'TEST 3: verifyDatabase()', passed: test3Passed },
    { test: 'TEST 4: verifyFileIntegrity()', passed: test4Passed },
    { test: 'TEST 5: Edge Cases', passed: test5Passed }
  ];

  results.forEach(r => {
    console.log('  ' + (r.passed ? '✓' : '✗') + ' ' + r.test);
  });

  const allPassed = results.every(r => r.passed);
  console.log('\n' + (allPassed ? '✓✓✓ ALL TESTS PASSED ✓✓✓' : '✗✗✗ SOME TESTS FAILED ✗✗✗'));
  console.log('▓'.repeat(80) + '\n');

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
