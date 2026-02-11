/**
 * Task 11 Manual Verification Script
 *
 * FULL STATE VERIFICATION for OCR Processing Orchestrator
 * Run: npx tsx tests/manual/task-11-verification.ts
 *
 * Tests:
 * 1. Happy path - real PDF processing
 * 2. Edge case - non-existent file
 * 3. Edge case - document not in database
 * 4. Hash integrity verification
 * 5. Provenance chain verification
 */

import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';

import { DatabaseService } from '../../src/services/storage/database/index.js';
import { OCRProcessor } from '../../src/services/ocr/processor.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import { computeHash, hashFile } from '../../src/utils/hash.js';

// Test files
const TEST_PDF = resolve('./data/bench/doc_0005.pdf');
const TEST_DOCX = resolve('./data/bench/doc_0005.docx');
const TEST_EMPTY_PDF = resolve('./data/bench/doc_0000.pdf');

interface VerificationResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

const results: VerificationResult[] = [];

function log(msg: string) {
  console.log(msg);
}

function section(title: string) {
  log('\n' + '='.repeat(60));
  log(title);
  log('='.repeat(60));
}

function recordResult(result: VerificationResult) {
  results.push(result);
  const status = result.passed ? '✓ PASS' : '✗ FAIL';
  log(`\n${status}: ${result.name}`);
  if (result.error) {
    log(`  Error: ${result.error}`);
  }
  if (result.details) {
    Object.entries(result.details).forEach(([key, value]) => {
      log(`  ${key}: ${JSON.stringify(value)}`);
    });
  }
}

async function main() {
  section('TASK 11 FULL STATE VERIFICATION');
  log(`Started: ${new Date().toISOString()}`);
  log(`Test PDF: ${TEST_PDF}`);

  // Verify test file exists
  try {
    statSync(TEST_PDF);
    log('Test file exists: YES');
  } catch {
    log('Test file exists: NO - ABORTING');
    process.exit(1);
  }

  // Create test database
  const testDir = mkdtempSync(join(tmpdir(), 'task11-verify-'));
  const dbName = `verify-${Date.now()}`;
  const db = DatabaseService.create(dbName, undefined, testDir);
  const processor = new OCRProcessor(db, { defaultMode: 'fast' });

  try {
    // ========================================
    // TEST 1: Happy Path - Real PDF Processing
    // ========================================
    section('TEST 1: Happy Path - Real PDF Processing');

    const docProvId1 = uuidv4();
    const fileHash1 = await hashFile(TEST_PDF);

    // Create document provenance
    db.insertProvenance({
      id: docProvId1,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: new Date().toISOString(),
      source_file_modified_at: new Date().toISOString(),
      source_type: 'FILE',
      source_path: TEST_PDF,
      source_id: null,
      root_document_id: docProvId1,
      location: null,
      content_hash: fileHash1,
      input_hash: null,
      file_hash: fileHash1,
      processor: 'ingestion',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 10,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: JSON.stringify(['document']),
    });

    const docId1 = uuidv4();
    db.insertDocument({
      id: docId1,
      file_path: TEST_PDF,
      file_name: 'doc_0005.pdf',
      file_hash: fileHash1,
      file_size: statSync(TEST_PDF).size,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId1,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    log('[BEFORE] Document status: ' + db.getDocument(docId1)!.status);

    const result1 = await processor.processDocument(docId1);

    log('[AFTER] Processing result: ' + JSON.stringify(result1, null, 2));

    // Verify database state
    const ocrResult1 = db.getOCRResultByDocumentId(docId1);
    const provenance1 = result1.provenanceId ? db.getProvenance(result1.provenanceId) : null;
    const docAfter1 = db.getDocument(docId1);

    const test1Passed =
      result1.success === true &&
      ocrResult1 !== null &&
      ocrResult1.text_length > 0 &&
      provenance1 !== null &&
      provenance1.chain_depth === 1 &&
      docAfter1!.status === 'complete';

    recordResult({
      name: 'Happy Path - Real PDF Processing',
      passed: test1Passed,
      details: {
        success: result1.success,
        textLength: ocrResult1?.text_length,
        pageCount: ocrResult1?.page_count,
        provenanceChainDepth: provenance1?.chain_depth,
        documentStatus: docAfter1?.status,
      }
    });

    // ========================================
    // TEST 2: Hash Integrity Verification
    // ========================================
    section('TEST 2: Hash Integrity Verification');

    if (ocrResult1) {
      const recomputedHash = computeHash(ocrResult1.extracted_text);
      const hashMatch = recomputedHash === ocrResult1.content_hash;

      log(`[HASH] Stored:   ${ocrResult1.content_hash}`);
      log(`[HASH] Computed: ${recomputedHash}`);
      log(`[HASH] Match:    ${hashMatch}`);

      recordResult({
        name: 'Hash Integrity Verification',
        passed: hashMatch,
        error: hashMatch ? undefined : 'Hash mismatch detected',
        details: {
          storedHash: ocrResult1.content_hash,
          computedHash: recomputedHash,
        }
      });
    } else {
      recordResult({
        name: 'Hash Integrity Verification',
        passed: false,
        error: 'No OCR result to verify',
      });
    }

    // ========================================
    // TEST 3: Provenance Chain Verification
    // ========================================
    section('TEST 3: Provenance Chain Verification');

    if (result1.provenanceId) {
      const chain = db.getProvenanceChain(result1.provenanceId);
      log(`[CHAIN] Length: ${chain.length}`);
      log(`[CHAIN] Types:  ${chain.map(p => p.type).join(' -> ')}`);
      log(`[CHAIN] Depths: ${chain.map(p => p.chain_depth).join(' -> ')}`);

      const chainValid =
        chain.length === 2 &&
        chain[0].type === ProvenanceType.OCR_RESULT &&
        chain[0].chain_depth === 1 &&
        chain[1].type === ProvenanceType.DOCUMENT &&
        chain[1].chain_depth === 0;

      recordResult({
        name: 'Provenance Chain Verification',
        passed: chainValid,
        error: chainValid ? undefined : 'Invalid chain structure',
        details: {
          chainLength: chain.length,
          types: chain.map(p => p.type),
          depths: chain.map(p => p.chain_depth),
        }
      });
    } else {
      recordResult({
        name: 'Provenance Chain Verification',
        passed: false,
        error: 'No provenance ID to verify',
      });
    }

    // ========================================
    // TEST 4: Edge Case - Non-existent File
    // ========================================
    section('TEST 4: Edge Case - Non-existent File');

    const docProvId4 = uuidv4();
    db.insertProvenance({
      id: docProvId4,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/nonexistent/file.pdf',
      source_id: null,
      root_document_id: docProvId4,
      location: null,
      content_hash: computeHash('fake'),
      input_hash: null,
      file_hash: computeHash('fake'),
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: null,
    });

    const docId4 = uuidv4();
    db.insertDocument({
      id: docId4,
      file_path: '/nonexistent/file.pdf',
      file_name: 'nonexistent.pdf',
      file_hash: computeHash('fake'),
      file_size: 0,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId4,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    const result4 = await processor.processDocument(docId4);
    const docAfter4 = db.getDocument(docId4);

    log(`[RESULT] success: ${result4.success}`);
    log(`[RESULT] error: ${result4.error}`);
    log(`[DB STATE] status: ${docAfter4!.status}`);
    log(`[DB STATE] error_message: ${docAfter4!.error_message}`);

    const test4Passed =
      result4.success === false &&
      result4.error !== undefined &&
      docAfter4!.status === 'failed' &&
      docAfter4!.error_message !== null;

    recordResult({
      name: 'Edge Case - Non-existent File',
      passed: test4Passed,
      details: {
        successFalse: result4.success === false,
        hasError: result4.error !== undefined,
        statusFailed: docAfter4!.status === 'failed',
        hasErrorMessage: docAfter4!.error_message !== null,
      }
    });

    // ========================================
    // TEST 5: Edge Case - Document Not in DB
    // ========================================
    section('TEST 5: Edge Case - Document Not in DB');

    const result5 = await processor.processDocument('nonexistent-document-id');

    log(`[RESULT] success: ${result5.success}`);
    log(`[RESULT] error: ${result5.error}`);

    const test5Passed =
      result5.success === false &&
      result5.error !== undefined &&
      result5.error.includes('not found');

    recordResult({
      name: 'Edge Case - Document Not in DB',
      passed: test5Passed,
      details: {
        successFalse: result5.success === false,
        hasError: result5.error !== undefined,
        errorContainsNotFound: result5.error?.includes('not found'),
      }
    });

    // ========================================
    // TEST 6: DOCX File Processing
    // ========================================
    section('TEST 6: DOCX File Processing');

    const docProvId6 = uuidv4();
    const fileHash6 = await hashFile(TEST_DOCX);

    db.insertProvenance({
      id: docProvId6,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: new Date().toISOString(),
      source_file_modified_at: new Date().toISOString(),
      source_type: 'FILE',
      source_path: TEST_DOCX,
      source_id: null,
      root_document_id: docProvId6,
      location: null,
      content_hash: fileHash6,
      input_hash: null,
      file_hash: fileHash6,
      processor: 'ingestion',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 10,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: JSON.stringify(['document']),
    });

    const docId6 = uuidv4();
    db.insertDocument({
      id: docId6,
      file_path: TEST_DOCX,
      file_name: 'doc_0005.docx',
      file_hash: fileHash6,
      file_size: statSync(TEST_DOCX).size,
      file_type: 'docx',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId6,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    const result6 = await processor.processDocument(docId6);
    const ocrResult6 = db.getOCRResultByDocumentId(docId6);

    log(`[RESULT] success: ${result6.success}`);
    log(`[RESULT] textLength: ${result6.textLength}`);

    const test6Passed =
      result6.success === true &&
      ocrResult6 !== null &&
      ocrResult6.text_length > 0;

    recordResult({
      name: 'DOCX File Processing',
      passed: test6Passed,
      details: {
        success: result6.success,
        textLength: ocrResult6?.text_length,
        pageCount: ocrResult6?.page_count,
      }
    });

    // ========================================
    // SUMMARY
    // ========================================
    section('VERIFICATION SUMMARY');

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;

    log(`\nTotal:  ${total}`);
    log(`Passed: ${passed}`);
    log(`Failed: ${failed}`);

    log('\nResults:');
    results.forEach(r => {
      const status = r.passed ? '✓' : '✗';
      log(`  ${status} ${r.name}`);
    });

    log('\n' + '='.repeat(60));
    if (failed === 0) {
      log('ALL VERIFICATIONS PASSED');
    } else {
      log(`${failed} VERIFICATION(S) FAILED`);
    }
    log('='.repeat(60));

    process.exit(failed === 0 ? 0 : 1);

  } finally {
    db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
