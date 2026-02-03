/**
 * DatalabClient Integration Tests
 *
 * REAL API TESTS - requires DATALAB_API_KEY environment variable
 * Uses actual files from ./data/bench/ for testing.
 * NO MOCKS - all tests use the real Datalab API.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { DatalabClient } from '../../../src/services/ocr/index.js';

// Test files from ./data/bench/
const TEST_PDF = resolve('./data/bench/doc_0005.pdf');
const TEST_DOCX = resolve('./data/bench/doc_0005.docx');

// Skip all tests if API key is not available
const hasApiKey = !!process.env.DATALAB_API_KEY;

describe('DatalabClient', () => {
  beforeAll(() => {
    if (!hasApiKey) {
      console.warn('DATALAB_API_KEY not set - DatalabClient tests will be skipped');
    }

    // Verify test files exist
    if (!existsSync(TEST_PDF)) {
      throw new Error(`Test file not found: ${TEST_PDF}`);
    }
    if (!existsSync(TEST_DOCX)) {
      throw new Error(`Test file not found: ${TEST_DOCX}`);
    }
  });

  describe('processDocument', () => {
    it.skipIf(!hasApiKey)('processes real PDF and returns OCRResult', async () => {
      const client = new DatalabClient();
      const result = await client.processDocument(
        TEST_PDF,
        'test-doc-id',
        'test-prov-id',
        'fast' // Use fast mode for tests to minimize cost
      );

      // VERIFY OUTPUT EXISTS - required fields must be present
      expect(result.result.id).toBeTruthy();
      expect(typeof result.result.id).toBe('string');

      // Verify extracted text is present and non-empty
      expect(result.result.extracted_text).toBeTruthy();
      expect(result.result.extracted_text.length).toBeGreaterThan(0);
      expect(result.result.text_length).toBe(result.result.extracted_text.length);

      // Verify content hash format matches sha256:...
      expect(result.result.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Verify page offsets are populated
      expect(result.pageOffsets.length).toBeGreaterThan(0);

      // Verify page count matches page offsets count
      expect(result.result.page_count).toBe(result.pageOffsets.length);

      // Verify IDs were passed through correctly
      expect(result.result.document_id).toBe('test-doc-id');
      expect(result.result.provenance_id).toBe('test-prov-id');

      // Verify datalab mode
      expect(result.result.datalab_mode).toBe('fast');

      // Verify timing fields are present
      expect(result.result.processing_started_at).toBeTruthy();
      expect(result.result.processing_completed_at).toBeTruthy();
      expect(result.result.processing_duration_ms).toBeGreaterThan(0);

      // Verify request ID is present
      expect(result.result.datalab_request_id).toBeTruthy();

      // Log actual values for manual verification
      console.log('[DATALAB TEST] PDF processed successfully:');
      console.log('  - ID:', result.result.id);
      console.log('  - Pages:', result.result.page_count);
      console.log('  - Text length:', result.result.text_length);
      console.log('  - Duration:', result.result.processing_duration_ms, 'ms');
      console.log('  - Content hash:', result.result.content_hash.substring(0, 30) + '...');
    }, 120000); // 2 minute timeout for API call

    it.skipIf(!hasApiKey)('converts snake_case page_offsets to camelCase', async () => {
      const client = new DatalabClient();
      const result = await client.processDocument(
        TEST_PDF,
        'test-doc-id-2',
        'test-prov-id-2',
        'fast'
      );

      // Verify camelCase conversion
      expect(result.pageOffsets[0]).toHaveProperty('charStart');
      expect(result.pageOffsets[0]).toHaveProperty('charEnd');
      expect(result.pageOffsets[0]).toHaveProperty('page');

      // Verify snake_case was converted (should NOT have these)
      expect(result.pageOffsets[0]).not.toHaveProperty('char_start');
      expect(result.pageOffsets[0]).not.toHaveProperty('char_end');

      // Verify offset values are reasonable
      const firstOffset = result.pageOffsets[0];
      expect(firstOffset.page).toBe(1);
      expect(firstOffset.charStart).toBe(0);
      expect(firstOffset.charEnd).toBeGreaterThan(0);

      console.log('[DATALAB TEST] Page offsets (camelCase):');
      result.pageOffsets.forEach(offset => {
        console.log(`  - Page ${offset.page}: ${offset.charStart}-${offset.charEnd}`);
      });
    }, 120000);

    it.skipIf(!hasApiKey)('processes DOCX files', async () => {
      const client = new DatalabClient();
      const result = await client.processDocument(
        TEST_DOCX,
        'test-doc-id-docx',
        'test-prov-id-docx',
        'fast'
      );

      expect(result.result.extracted_text.length).toBeGreaterThan(0);
      expect(result.result.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

      console.log('[DATALAB TEST] DOCX processed:');
      console.log('  - Text length:', result.result.text_length);
      console.log('  - Pages:', result.result.page_count);
    }, 120000);

    it.skipIf(!hasApiKey)('throws OCRFileError for non-existent file', async () => {
      const client = new DatalabClient();

      await expect(
        client.processDocument(
          '/nonexistent/path/to/file.pdf',
          'test-doc-id',
          'test-prov-id',
          'fast'
        )
      ).rejects.toThrow();
    });
  });
});
