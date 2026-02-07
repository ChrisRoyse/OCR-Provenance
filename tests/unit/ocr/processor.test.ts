/**
 * OCRProcessor Integration Tests
 *
 * REAL API TESTS - requires DATALAB_API_KEY environment variable
 * Uses actual files from ./data/bench/ and real database operations.
 * NO MOCKS - tests the complete pipeline.
 *
 * FULL STATE VERIFICATION - verifies data exists in database after operations
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { OCRProcessor, type ProcessResult } from '../../../src/services/ocr/index.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { computeHash } from '../../../src/utils/hash.js';
import { hashFile } from '../../../src/utils/hash.js';

// Test files from ./data/bench/
const TEST_PDF = resolve('./data/bench/doc_0005.pdf');

// Skip all tests if API key is not available
const hasApiKey = !!process.env.DATALAB_API_KEY;

// Check if sqlite-vec is available
let sqliteVecAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('sqlite-vec');
  sqliteVecAvailable = true;
} catch {
  console.warn('sqlite-vec not available - processor tests will be skipped');
}

const canRunTests = hasApiKey && sqliteVecAvailable;

describe('OCRProcessor', () => {
  let testDir: string;
  let db: DatabaseService | undefined;
  let processor: OCRProcessor | undefined;

  beforeAll(() => {
    if (!hasApiKey) {
      console.warn('DATALAB_API_KEY not set - OCRProcessor tests will be skipped');
    }

    // Verify test file exists
    if (!existsSync(TEST_PDF)) {
      throw new Error(`Test file not found: ${TEST_PDF}`);
    }
  });

  beforeEach(() => {
    if (!canRunTests) return;

    testDir = mkdtempSync(join(tmpdir(), 'ocr-processor-test-'));
    const dbName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = DatabaseService.create(dbName, undefined, testDir);
    processor = new OCRProcessor(db, { defaultMode: 'fast' });
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('processDocument', () => {
    it.skipIf(!canRunTests)('creates OCR_RESULT provenance with chain_depth=1', async () => {
      // ========================================
      // SETUP: Create document with provenance
      // ========================================
      const docProvId = uuidv4();
      const fileHash = await hashFile(TEST_PDF);

      // Create document provenance (depth 0)
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

      // Create document record
      const docId = uuidv4();
      db!.insertDocument({
        id: docId,
        file_path: TEST_PDF,
        file_name: 'doc_0005.pdf',
        file_hash: fileHash,
        file_size: 1805,
        file_type: 'pdf',
        status: 'pending',
        page_count: null,
        provenance_id: docProvId,
        modified_at: null,
        ocr_completed_at: null,
        error_message: null,
      });

      // ========================================
      // VERIFY BEFORE STATE
      // ========================================
      const docBefore = db!.getDocument(docId);
      console.log('[BEFORE] Document status:', docBefore!.status);
      expect(docBefore!.status).toBe('pending');

      // ========================================
      // EXECUTE: Process document
      // ========================================
      console.log('[EXECUTE] Processing document...');
      const result = await processor!.processDocument(docId);
      console.log('[RESULT]', JSON.stringify(result, null, 2));

      // ========================================
      // FULL STATE VERIFICATION
      // ========================================
      expect(result.success).toBe(true);
      expect(result.ocrResultId).toBeTruthy();
      expect(result.provenanceId).toBeTruthy();

      // Verify OCR result in database
      const ocrResult = db!.getOCRResultByDocumentId(docId);
      expect(ocrResult).not.toBeNull();
      console.log('[DB STATE] OCR Result exists:', !!ocrResult);
      console.log('[DB STATE] OCR text_length:', ocrResult!.text_length);
      expect(ocrResult!.text_length).toBeGreaterThan(0);
      expect(ocrResult!.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Verify provenance in database
      const provenance = db!.getProvenance(result.provenanceId!);
      expect(provenance).not.toBeNull();
      console.log('[DB STATE] Provenance exists:', !!provenance);
      console.log('[DB STATE] Provenance type:', provenance!.type);
      console.log('[DB STATE] Provenance chain_depth:', provenance!.chain_depth);
      expect(provenance!.type).toBe(ProvenanceType.OCR_RESULT);
      expect(provenance!.chain_depth).toBe(1);
      expect(provenance!.source_id).toBe(docProvId);
      expect(provenance!.root_document_id).toBe(docProvId);

      // Verify document status updated
      const updatedDoc = db!.getDocument(docId);
      console.log('[DB STATE] Document status:', updatedDoc!.status);
      console.log('[DB STATE] Document page_count:', updatedDoc!.page_count);
      expect(updatedDoc!.status).toBe('processing');
      expect(updatedDoc!.page_count).toBeGreaterThan(0);
      expect(updatedDoc!.ocr_completed_at).toBeTruthy();

      // ========================================
      // HASH INTEGRITY VERIFICATION
      // ========================================
      const recomputedHash = computeHash(ocrResult!.extracted_text);
      console.log('[HASH] Stored:', ocrResult!.content_hash);
      console.log('[HASH] Computed:', recomputedHash);
      console.log('[HASH] Match:', recomputedHash === ocrResult!.content_hash);
      expect(recomputedHash).toBe(ocrResult!.content_hash);

      // ========================================
      // PROVENANCE CHAIN VERIFICATION
      // ========================================
      const chain = db!.getProvenanceChain(result.provenanceId!);
      console.log('[CHAIN] Length:', chain.length);
      console.log('[CHAIN] Depths:', chain.map(p => p.chain_depth));

      // Chain should have: OCR_RESULT (depth=1) -> DOCUMENT (depth=0)
      expect(chain.length).toBe(2);
      expect(chain[0].type).toBe(ProvenanceType.OCR_RESULT);
      expect(chain[0].chain_depth).toBe(1);
      expect(chain[1].type).toBe(ProvenanceType.DOCUMENT);
      expect(chain[1].chain_depth).toBe(0);

    }, 180000); // 3 minute timeout for API call

    it.skipIf(!canRunTests)('updates status to failed on error', async () => {
      // Setup: Create document pointing to non-existent file
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

      // Execute
      const result = await processor!.processDocument(docId);

      // Verify failure
      console.log('[FAILURE TEST] Success:', result.success);
      console.log('[FAILURE TEST] Error:', result.error);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();

      // Verify document status in database
      const updatedDoc = db!.getDocument(docId);
      console.log('[DB STATE] Document status:', updatedDoc!.status);
      console.log('[DB STATE] Error message:', updatedDoc!.error_message);
      expect(updatedDoc!.status).toBe('failed');
      expect(updatedDoc!.error_message).toBeTruthy();
    });

    it.skipIf(!canRunTests)('returns error for non-existent document', async () => {
      const result = await processor!.processDocument('nonexistent-document-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Document not found');
    });
  });

  describe('processPending', () => {
    it.skipIf(!canRunTests)('returns empty result when no pending documents', async () => {
      const result = await processor!.processPending();

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.remaining).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });
});
