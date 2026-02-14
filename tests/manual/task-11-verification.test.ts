/**
 * Task 11 Manual Verification Test
 *
 * FULL STATE VERIFICATION for OCR Processing Orchestrator
 * Run: npx vitest run tests/manual/task-11-verification.test.ts
 *
 * Tests:
 * 1. Happy path - real PDF processing
 * 2. Edge case - non-existent file
 * 3. Edge case - document not in database
 * 4. Hash integrity verification
 * 5. Provenance chain verification
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

// Skip all tests if API key is not available
const hasApiKey = !!process.env.DATALAB_API_KEY;

// Check if sqlite-vec is available
let sqliteVecAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('sqlite-vec');
  sqliteVecAvailable = true;
} catch {
  console.warn('sqlite-vec not available');
}

const canRunTests = hasApiKey && sqliteVecAvailable;

describe('Task 11 Full State Verification', () => {
  let testDir: string;
  let db: DatabaseService | undefined;
  let processor: OCRProcessor | undefined;

  beforeAll(() => {
    if (!canRunTests) return;

    testDir = mkdtempSync(join(tmpdir(), 'task11-verify-'));
    const dbName = `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = DatabaseService.create(dbName, undefined, testDir);
    processor = new OCRProcessor(db, { defaultMode: 'fast' });
  });

  afterAll(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore
      }
    }
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  it.skipIf(!canRunTests)('Happy Path: processes real PDF and stores in database', async () => {
    const docProvId = uuidv4();
    const fileHash = await hashFile(TEST_PDF);

    // Create document provenance
    db!.insertProvenance({
      id: docProvId,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: new Date().toISOString(),
      source_file_modified_at: new Date().toISOString(),
      source_type: 'FILE',
      source_path: TEST_PDF,
      source_id: null,
      root_document_id: docProvId,
      location: null,
      content_hash: fileHash,
      input_hash: null,
      file_hash: fileHash,
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

    const docId = uuidv4();
    db!.insertDocument({
      id: docId,
      file_path: TEST_PDF,
      file_name: 'doc_0005.pdf',
      file_hash: fileHash,
      file_size: statSync(TEST_PDF).size,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    // Before state
    console.log('[BEFORE] Document status:', db!.getDocument(docId)!.status);

    // Execute
    const result = await processor!.processDocument(docId);
    console.log('[RESULT]', JSON.stringify(result, null, 2));

    // Full state verification
    expect(result.success).toBe(true);

    // Verify OCR result in database
    const ocrResult = db!.getOCRResultByDocumentId(docId);
    expect(ocrResult).not.toBeNull();
    console.log('[DB] OCR text_length:', ocrResult!.text_length);
    expect(ocrResult!.text_length).toBeGreaterThan(0);

    // Verify provenance in database
    const provenance = db!.getProvenance(result.provenanceId!);
    expect(provenance).not.toBeNull();
    console.log('[DB] Provenance chain_depth:', provenance!.chain_depth);
    expect(provenance!.type).toBe(ProvenanceType.OCR_RESULT);
    expect(provenance!.chain_depth).toBe(1);

    // Verify document status
    const docAfter = db!.getDocument(docId);
    console.log('[DB] Document status:', docAfter!.status);
    expect(docAfter!.status).toBe('processing');
    expect(docAfter!.page_count).toBeGreaterThan(0);
  }, 180000);

  it.skipIf(!canRunTests)('Hash Integrity: stored hash matches computed hash', async () => {
    const docProvId = uuidv4();
    const fileHash = await hashFile(TEST_PDF);

    db!.insertProvenance({
      id: docProvId,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: new Date().toISOString(),
      source_file_modified_at: new Date().toISOString(),
      source_type: 'FILE',
      source_path: TEST_PDF,
      source_id: null,
      root_document_id: docProvId,
      location: null,
      content_hash: fileHash,
      input_hash: null,
      file_hash: fileHash,
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

    const docId = uuidv4();
    db!.insertDocument({
      id: docId,
      file_path: TEST_PDF,
      file_name: 'doc_0005.pdf',
      file_hash: fileHash,
      file_size: statSync(TEST_PDF).size,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    await processor!.processDocument(docId);

    const ocrResult = db!.getOCRResultByDocumentId(docId);
    expect(ocrResult).not.toBeNull();

    // Recompute hash and compare
    const recomputed = computeHash(ocrResult!.extracted_text);
    console.log('[HASH] Stored:', ocrResult!.content_hash);
    console.log('[HASH] Computed:', recomputed);
    console.log('[HASH] Match:', recomputed === ocrResult!.content_hash);

    expect(recomputed).toBe(ocrResult!.content_hash);
  }, 180000);

  it.skipIf(!canRunTests)('Provenance Chain: OCR_RESULT -> DOCUMENT with correct depths', async () => {
    const docProvId = uuidv4();
    const fileHash = await hashFile(TEST_PDF);

    db!.insertProvenance({
      id: docProvId,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: new Date().toISOString(),
      source_file_modified_at: new Date().toISOString(),
      source_type: 'FILE',
      source_path: TEST_PDF,
      source_id: null,
      root_document_id: docProvId,
      location: null,
      content_hash: fileHash,
      input_hash: null,
      file_hash: fileHash,
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

    const docId = uuidv4();
    db!.insertDocument({
      id: docId,
      file_path: TEST_PDF,
      file_name: 'doc_0005.pdf',
      file_hash: fileHash,
      file_size: statSync(TEST_PDF).size,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    const result = await processor!.processDocument(docId);
    expect(result.provenanceId).toBeTruthy();

    const chain = db!.getProvenanceChain(result.provenanceId!);
    console.log('[CHAIN] Length:', chain.length);
    console.log('[CHAIN] Types:', chain.map(p => p.type).join(' -> '));
    console.log('[CHAIN] Depths:', chain.map(p => p.chain_depth).join(' -> '));

    expect(chain.length).toBe(2);
    expect(chain[0].type).toBe(ProvenanceType.OCR_RESULT);
    expect(chain[0].chain_depth).toBe(1);
    expect(chain[1].type).toBe(ProvenanceType.DOCUMENT);
    expect(chain[1].chain_depth).toBe(0);
  }, 180000);

  it.skipIf(!canRunTests)('Edge Case: non-existent file sets status to failed', async () => {
    const docProvId = uuidv4();

    db!.insertProvenance({
      id: docProvId,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/nonexistent/file.pdf',
      source_id: null,
      root_document_id: docProvId,
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

    const docId = uuidv4();
    db!.insertDocument({
      id: docId,
      file_path: '/nonexistent/file.pdf',
      file_name: 'nonexistent.pdf',
      file_hash: computeHash('fake'),
      file_size: 0,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    // processDocument now THROWS on file errors (Agent 2 change)
    await expect(
      processor!.processDocument(docId)
    ).rejects.toThrow();

    const docAfter = db!.getDocument(docId);
    expect(docAfter!.status).toBe('failed');
    expect(docAfter!.error_message).toBeTruthy();
  });

  it.skipIf(!canRunTests)('Edge Case: document not in database returns error', async () => {
    // processDocument now THROWS on missing document (Agent 2 change)
    await expect(
      processor!.processDocument('nonexistent-document-id')
    ).rejects.toThrow(/not found/i);
  });

  it.skipIf(!canRunTests)('DOCX Processing: processes DOCX files correctly', async () => {
    const docProvId = uuidv4();
    const fileHash = await hashFile(TEST_DOCX);

    db!.insertProvenance({
      id: docProvId,
      type: ProvenanceType.DOCUMENT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: new Date().toISOString(),
      source_file_modified_at: new Date().toISOString(),
      source_type: 'FILE',
      source_path: TEST_DOCX,
      source_id: null,
      root_document_id: docProvId,
      location: null,
      content_hash: fileHash,
      input_hash: null,
      file_hash: fileHash,
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

    const docId = uuidv4();
    db!.insertDocument({
      id: docId,
      file_path: TEST_DOCX,
      file_name: 'doc_0005.docx',
      file_hash: fileHash,
      file_size: statSync(TEST_DOCX).size,
      file_type: 'docx',
      status: 'pending',
      page_count: null,
      provenance_id: docProvId,
      modified_at: null,
      ocr_completed_at: null,
      error_message: null,
    });

    const result = await processor!.processDocument(docId);
    console.log('[RESULT] success:', result.success);
    console.log('[RESULT] textLength:', result.textLength);

    expect(result.success).toBe(true);

    const ocrResult = db!.getOCRResultByDocumentId(docId);
    expect(ocrResult).not.toBeNull();
    expect(ocrResult!.text_length).toBeGreaterThan(0);
  }, 180000);
});
