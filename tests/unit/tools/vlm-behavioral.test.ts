/**
 * Behavioral Tests for VLM (Vision Language Model) MCP Tools
 *
 * Tests the VLM tool handlers in src/tools/vlm.ts:
 * - handleVLMDescribe: Image description with Gemini + embedding generation
 * - handleVLMProcess: Batch VLM processing for documents or pending images
 * - handleVLMAnalyzePDF: Direct PDF analysis with Gemini
 * - handleVLMStatus: VLM service status and statistics
 *
 * Tests verify error paths, validation, database state requirements, and
 * the withDatabaseOperation wrapper behavior (H-1/H-2 fixes).
 *
 * NO MOCK DATA - Tests use real database instances and verify actual error
 * propagation behavior. External services (Gemini API) are tested via error
 * paths since they require network access.
 *
 * @module tests/unit/tools/vlm-behavioral
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
} from '../../integration/server/helpers.js';
import {
  handleVLMDescribe,
  handleVLMProcess,
  handleVLMAnalyzePDF,
  handleVLMStatus,
  vlmTools,
} from '../../../src/tools/vlm.js';

// ===============================================================================
// TEST HELPERS
// ===============================================================================

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    category: string;
    message: string;
    details?: Record<string, unknown>;
    recovery?: {
      tool: string;
      hint: string;
    };
  };
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

// ===============================================================================
// TOOL EXPORTS VERIFICATION
// ===============================================================================

describe('vlmTools exports', () => {
  it('exports all 4 VLM tools', () => {
    expect(Object.keys(vlmTools)).toHaveLength(4);
    expect(vlmTools).toHaveProperty('ocr_vlm_describe');
    expect(vlmTools).toHaveProperty('ocr_vlm_process');
    expect(vlmTools).toHaveProperty('ocr_vlm_analyze_pdf');
    expect(vlmTools).toHaveProperty('ocr_vlm_status');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(vlmTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length, `${name} description is empty`).toBeGreaterThan(0);
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('tools map to the correct handlers', () => {
    expect(vlmTools.ocr_vlm_describe.handler).toBe(handleVLMDescribe);
    expect(vlmTools.ocr_vlm_process.handler).toBe(handleVLMProcess);
    expect(vlmTools.ocr_vlm_analyze_pdf.handler).toBe(handleVLMAnalyzePDF);
    expect(vlmTools.ocr_vlm_status.handler).toBe(handleVLMStatus);
  });

  it('descriptions contain category tags', () => {
    expect(vlmTools.ocr_vlm_describe.description).toContain('[PROCESSING]');
    expect(vlmTools.ocr_vlm_process.description).toContain('[PROCESSING]');
    expect(vlmTools.ocr_vlm_analyze_pdf.description).toContain('[PROCESSING]');
    expect(vlmTools.ocr_vlm_status.description).toContain('[STATUS]');
  });
});

// ===============================================================================
// handleVLMDescribe TESTS
// ===============================================================================

describe('handleVLMDescribe', () => {
  // NOTE: No beforeEach/afterEach resetState here because nested describes
  // manage their own database state via beforeAll/afterAll.

  describe('without database', () => {
    beforeEach(() => {
      resetState();
    });

    afterEach(() => {
      resetState();
    });

    it('returns VALIDATION_ERROR when image_path is missing', async () => {
      const response = await handleVLMDescribe({});
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when image_path is empty string', async () => {
      const response = await handleVLMDescribe({ image_path: '' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when image_path is non-string type', async () => {
      const response = await handleVLMDescribe({ image_path: 123 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('returns PATH_NOT_FOUND when image file does not exist within allowed dir', async () => {
      // Use /tmp path which is in the allowed base directories
      const response = await handleVLMDescribe({
        image_path: '/tmp/nonexistent-vlm-test-image.png',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('PATH_NOT_FOUND');
      expect(result.error?.message).toContain('Image file not found');
      expect(result.error?.details).toBeDefined();
    });

    it('returns PATH_NOT_FOUND with recovery hint', async () => {
      const response = await handleVLMDescribe({
        image_path: '/tmp/nonexistent-vlm-test-image.png',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('PATH_NOT_FOUND');
      // Error recovery hints (from forensic audit fix) should be present
      expect(result.error?.recovery).toBeDefined();
      expect(result.error?.recovery?.tool).toBeDefined();
      expect(result.error?.recovery?.hint).toBeDefined();
    });

    it('returns VALIDATION_ERROR for paths outside allowed directories', async () => {
      // sanitizePath rejects paths outside home, /tmp, cwd, storage path
      const response = await handleVLMDescribe({ image_path: '/nonexistent/image.png' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('outside allowed directories');
    });

    it('validates use_thinking boolean parameter', async () => {
      // Non-boolean use_thinking should still work (Zod coerces or defaults)
      const response = await handleVLMDescribe({
        image_path: '/tmp/nonexistent-vlm-test-image.png',
        use_thinking: 'yes',
      });
      const result = parseResponse(response);

      // Should fail on path, not validation - Zod strips unknown strings for boolean
      expect(result.success).toBe(false);
    });

    it('accepts optional context_text parameter without validation error', async () => {
      const response = await handleVLMDescribe({
        image_path: '/tmp/nonexistent-vlm-test-image.png',
        context_text: 'This is surrounding document context',
      });
      const result = parseResponse(response);

      // Should fail on path (within allowed dir), not validation
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('PATH_NOT_FOUND');
    });

    it('strips unknown parameters and proceeds', async () => {
      const response = await handleVLMDescribe({
        image_path: '/tmp/nonexistent-vlm-test-image.png',
        unknown_param: 'should be stripped',
        another_extra: 42,
      });
      const result = parseResponse(response);

      // Should fail on path, not validation
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('PATH_NOT_FOUND');
    });
  }); // end describe('without database')

  describe('with real database and image file', () => {
    let tempDir: string;
    let imgPath: string;
    const dbName = createUniqueName('test-vlm-describe');

    beforeAll(() => {
      resetState();
      tempDir = createTempDir('test-vlm-describe-');
      createDatabase(dbName, undefined, tempDir);
      selectDatabase(dbName, tempDir);

      // Create a dummy image file (not a real image, but fs.existsSync will pass)
      const imgDir = join(tempDir, 'images');
      mkdirSync(imgDir, { recursive: true });
      imgPath = join(imgDir, 'test-image.png');
      writeFileSync(imgPath, Buffer.from('fake-png-data'));
    });

    afterAll(() => {
      resetState();
      cleanupTempDir(tempDir);
    });

    it('passes validation and file check with real image path and database', async () => {
      // This will pass validation and fs.existsSync, then enter withDatabaseOperation.
      // It will fail on Gemini API call (no valid API key in test env) but
      // verifies the handler gets past validation, path check, and DB wrapper.
      const response = await handleVLMDescribe({ image_path: imgPath });
      const result = parseResponse(response);

      // Should fail on Gemini API or VLM service, NOT on validation or DB
      expect(result.success).toBe(false);
      // The error should NOT be VALIDATION_ERROR or DATABASE_NOT_SELECTED
      expect(result.error?.category).not.toBe('VALIDATION_ERROR');
      expect(result.error?.category).not.toBe('DATABASE_NOT_SELECTED');
    });

    it('withDatabaseOperation protects against DB switch during operation', async () => {
      // The handler is wrapped in withDatabaseOperation, which means
      // it calls beginDatabaseOperation and endDatabaseOperation.
      // This test verifies the handler enters the DB operation scope correctly.
      const response = await handleVLMDescribe({ image_path: imgPath });
      const result = parseResponse(response);

      // Even if VLM fails, the DB operation tracking should clean up properly.
      // If it didn't, subsequent tests would fail because activeOperations > 0.
      expect(result.success).toBe(false);
      // Verify we can still use requireDatabase (no leaked operation counter)
      expect(() => requireDatabase()).not.toThrow();
    });
  });
});

// ===============================================================================
// handleVLMProcess TESTS
// ===============================================================================

describe('handleVLMProcess', () => {
  // NOTE: No beforeEach/afterEach resetState here because nested describes
  // manage their own database state via beforeAll/afterAll.

  describe('without database', () => {
    beforeEach(() => {
      resetState();
    });

    afterEach(() => {
      resetState();
    });

    it('returns DATABASE_NOT_SELECTED when no database', async () => {
      const response = await handleVLMProcess({});
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('returns DATABASE_NOT_SELECTED when no database with document_id', async () => {
      const response = await handleVLMProcess({ document_id: 'doc-123' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('returns DATABASE_NOT_SELECTED with recovery hint', async () => {
      const response = await handleVLMProcess({});
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
      expect(result.error?.recovery).toBeDefined();
      expect(result.error?.recovery?.tool).toBeDefined();
    });

    it('accepts optional batch_size parameter', async () => {
      const response = await handleVLMProcess({ batch_size: 10 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('returns VALIDATION_ERROR when batch_size exceeds max', async () => {
      const response = await handleVLMProcess({ batch_size: 21 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when batch_size is zero', async () => {
      const response = await handleVLMProcess({ batch_size: 0 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when batch_size is negative', async () => {
      const response = await handleVLMProcess({ batch_size: -1 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('accepts optional limit parameter', async () => {
      const response = await handleVLMProcess({ limit: 100 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('returns VALIDATION_ERROR when limit exceeds max (500)', async () => {
      const response = await handleVLMProcess({ limit: 501 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when limit is zero', async () => {
      const response = await handleVLMProcess({ limit: 0 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('accepts boundary batch_size value 1', async () => {
      const response = await handleVLMProcess({ batch_size: 1 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts boundary batch_size value 20', async () => {
      const response = await handleVLMProcess({ batch_size: 20 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts boundary limit value 1', async () => {
      const response = await handleVLMProcess({ limit: 1 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts boundary limit value 500', async () => {
      const response = await handleVLMProcess({ limit: 500 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('returns VALIDATION_ERROR when batch_size is not an integer', async () => {
      const response = await handleVLMProcess({ batch_size: 5.5 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when limit is not an integer', async () => {
      const response = await handleVLMProcess({ limit: 50.5 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('strips unknown parameters and proceeds', async () => {
      const response = await handleVLMProcess({
        unknown_param: 'should be stripped',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  }); // end describe('without database')

  describe('with database selected', () => {
    let tempDir: string;
    const dbName = createUniqueName('test-vlm-process');

    beforeAll(() => {
      resetState();
      tempDir = createTempDir('test-vlm-process-');
      createDatabase(dbName, undefined, tempDir);
      selectDatabase(dbName, tempDir);
    });

    afterAll(() => {
      resetState();
      cleanupTempDir(tempDir);
    });

    it('returns DOCUMENT_NOT_FOUND when document does not exist', async () => {
      const response = await handleVLMProcess({ document_id: 'nonexistent-doc-id' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
      expect(result.error?.message).toContain('nonexistent-doc-id');
    });

    it('DOCUMENT_NOT_FOUND includes recovery hint', async () => {
      const response = await handleVLMProcess({ document_id: 'nonexistent-doc-id' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
      expect(result.error?.recovery).toBeDefined();
    });

    it('processes pending mode when no document_id (empty database)', async () => {
      // No images in the database, so processPending should succeed with 0 processed
      // This tests the VLMPipeline creation and execution path.
      // It may fail on VLM service initialization (Gemini API key), but we test
      // whether it gets past the DB check.
      const response = await handleVLMProcess({});
      const result = parseResponse(response);

      // If VLM service fails to initialize (no Gemini API key), it will be an error
      // but NOT DATABASE_NOT_SELECTED. If it succeeds (service can init without
      // API key), it should return 0 processed.
      if (result.success) {
        expect(result.data?.mode).toBe('pending');
        expect(result.data?.processed).toBe(0);
        expect(result.data?.next_steps).toBeDefined();
      } else {
        // VLM service init failure - should NOT be a DB error
        expect(result.error?.category).not.toBe('DATABASE_NOT_SELECTED');
        expect(result.error?.category).not.toBe('VALIDATION_ERROR');
      }
    });

    it('processes document mode with valid document but no images', async () => {
      const { db } = requireDatabase();

      // Create a document
      const docProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: docProvId,
          type: ProvenanceType.DOCUMENT,
          root_document_id: docProvId,
          chain_depth: 0,
        })
      );

      const docId = uuidv4();
      db.insertDocument(
        createTestDocument(docProvId, {
          id: docId,
          file_path: '/test/vlm-process-test.pdf',
          file_name: 'vlm-process-test.pdf',
          status: 'complete',
        })
      );

      const response = await handleVLMProcess({ document_id: docId });
      const result = parseResponse(response);

      // With a valid document but no images, should either succeed with 0
      // or fail on VLM service init (no Gemini key)
      if (result.success) {
        expect(result.data?.mode).toBe('document');
        expect(result.data?.document_id).toBe(docId);
        expect(result.data?.total).toBe(0);
        expect(result.data?.successful).toBe(0);
        expect(result.data?.failed).toBe(0);
        expect(result.data?.next_steps).toBeDefined();
        expect(Array.isArray(result.data?.next_steps)).toBe(true);
      } else {
        // VLM service init failure - should NOT be DB/validation error
        expect(result.error?.category).not.toBe('DATABASE_NOT_SELECTED');
        expect(result.error?.category).not.toBe('VALIDATION_ERROR');
        expect(result.error?.category).not.toBe('DOCUMENT_NOT_FOUND');
      }
    });

    it('withDatabaseOperation cleans up even on VLM service failure', async () => {
      // Call the handler - even if it fails, operation counter should be zero after
      await handleVLMProcess({ document_id: 'nonexistent-doc-id' });

      // If withDatabaseOperation leaked, this would throw
      // "Cannot switch databases while operations are in-flight"
      expect(() => requireDatabase()).not.toThrow();
    });
  });
});

// ===============================================================================
// handleVLMAnalyzePDF TESTS
// ===============================================================================

describe('handleVLMAnalyzePDF', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  it('returns VALIDATION_ERROR when pdf_path is missing', async () => {
    const response = await handleVLMAnalyzePDF({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR when pdf_path is empty string', async () => {
    const response = await handleVLMAnalyzePDF({ pdf_path: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR when pdf_path is non-string type', async () => {
    const response = await handleVLMAnalyzePDF({ pdf_path: 42 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns PATH_NOT_FOUND when PDF file does not exist within allowed dir', async () => {
    // Use /tmp path which is in the allowed base directories
    const response = await handleVLMAnalyzePDF({ pdf_path: '/tmp/nonexistent-vlm-test-doc.pdf' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('PATH_NOT_FOUND');
    expect(result.error?.message).toContain('PDF file not found');
  });

  it('does NOT require database selection (no DB needed)', async () => {
    // handleVLMAnalyzePDF explicitly does NOT use the database.
    // It should fail on path/API issues, never on DATABASE_NOT_SELECTED.
    const response = await handleVLMAnalyzePDF({ pdf_path: '/tmp/nonexistent-vlm-test-doc.pdf' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).not.toBe('DATABASE_NOT_SELECTED');
  });

  it('returns VALIDATION_ERROR for paths outside allowed directories', async () => {
    // sanitizePath rejects paths outside home, /tmp, cwd, storage path
    const response = await handleVLMAnalyzePDF({ pdf_path: '/nonexistent/document.pdf' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('outside allowed directories');
  });

  it('accepts optional prompt parameter without validation error', async () => {
    const response = await handleVLMAnalyzePDF({
      pdf_path: '/tmp/nonexistent-vlm-test-doc.pdf',
      prompt: 'Summarize the key legal findings.',
    });
    const result = parseResponse(response);

    // Should fail on path, not validation
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('PATH_NOT_FOUND');
  });

  it('strips unknown parameters and proceeds', async () => {
    const response = await handleVLMAnalyzePDF({
      pdf_path: '/tmp/nonexistent-vlm-test-doc.pdf',
      unknown: 'should be stripped',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('PATH_NOT_FOUND');
  });

  describe('file size validation', () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir('test-vlm-pdf-');
    });

    afterAll(() => {
      cleanupTempDir(tempDir);
    });

    it('rejects PDF larger than 20MB', async () => {
      // Create a file larger than 20MB
      const largePdf = join(tempDir, 'large.pdf');
      // Write 21MB of data
      const buf = Buffer.alloc(21 * 1024 * 1024, 'x');
      writeFileSync(largePdf, buf);

      const response = await handleVLMAnalyzePDF({ pdf_path: largePdf });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('20MB');
    });

    it('accepts PDF within 20MB limit (fails on Gemini API, not size)', async () => {
      // Create a small valid-ish file
      const smallPdf = join(tempDir, 'small.pdf');
      writeFileSync(smallPdf, '%PDF-1.4 fake content');

      const response = await handleVLMAnalyzePDF({ pdf_path: smallPdf });
      const result = parseResponse(response);

      // Should fail on Gemini API (no key), NOT on size validation
      expect(result.success).toBe(false);
      expect(result.error?.category).not.toBe('VALIDATION_ERROR');
      expect(result.error?.category).not.toBe('PATH_NOT_FOUND');
    });
  });
});

// ===============================================================================
// handleVLMStatus TESTS
// ===============================================================================

describe('handleVLMStatus', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  it('does NOT require database selection', async () => {
    // VLMStatus should work without a database since it just checks Gemini API status
    const response = await handleVLMStatus({});
    const result = parseResponse(response);

    // Should either succeed or fail on VLM service init, never DATABASE_NOT_SELECTED
    if (!result.success) {
      expect(result.error?.category).not.toBe('DATABASE_NOT_SELECTED');
    }
  });

  it('accepts empty object as valid input', async () => {
    const response = await handleVLMStatus({});
    const result = parseResponse(response);

    // Should not fail on validation
    if (!result.success) {
      expect(result.error?.category).not.toBe('VALIDATION_ERROR');
    }
  });

  it('strips unknown parameters and proceeds', async () => {
    const response = await handleVLMStatus({
      extra_param: 'should be stripped',
      another: 42,
    });
    const result = parseResponse(response);

    // Should not fail on validation
    if (!result.success) {
      expect(result.error?.category).not.toBe('VALIDATION_ERROR');
    }
  });

  it('returns correct MCP response structure', async () => {
    const response = await handleVLMStatus({});

    // Verify MCP response shape
    expect(response).toHaveProperty('content');
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0]).toHaveProperty('type', 'text');
    expect(response.content[0]).toHaveProperty('text');
    expect(typeof response.content[0].text).toBe('string');

    // Must be valid JSON
    expect(() => JSON.parse(response.content[0].text)).not.toThrow();
  });

  it('response includes success field and either data or error', async () => {
    const response = await handleVLMStatus({});
    const result = parseResponse(response);

    expect(typeof result.success).toBe('boolean');
    if (result.success) {
      expect(result.data).toBeDefined();
      expect(result.data?.api_key_configured).toBeDefined();
      expect(typeof result.data?.api_key_configured).toBe('boolean');
      expect(result.data?.model).toBeDefined();
      expect(result.data?.rate_limiter).toBeDefined();
      expect(result.data?.circuit_breaker).toBeDefined();
      expect(result.data?.next_steps).toBeDefined();
      expect(Array.isArray(result.data?.next_steps)).toBe(true);
    } else {
      expect(result.error).toBeDefined();
      expect(result.error?.category).toBeDefined();
      expect(result.error?.message).toBeDefined();
    }
  });

  it('includes api_key_configured boolean when successful', async () => {
    const response = await handleVLMStatus({});
    const result = parseResponse(response);

    if (result.success) {
      // api_key_configured should reflect whether GEMINI_API_KEY env var is set
      expect(typeof result.data?.api_key_configured).toBe('boolean');

      // Rate limiter should have numeric fields
      const rateLimiter = result.data?.rate_limiter as Record<string, unknown>;
      expect(typeof rateLimiter?.requests_remaining).toBe('number');
      expect(typeof rateLimiter?.tokens_remaining).toBe('number');
      expect(typeof rateLimiter?.reset_in_ms).toBe('number');

      // Circuit breaker should have state field
      const circuitBreaker = result.data?.circuit_breaker as Record<string, unknown>;
      expect(typeof circuitBreaker?.state).toBe('string');
      expect(typeof circuitBreaker?.failure_count).toBe('number');
    }
  });
});

// ===============================================================================
// DATABASE INTERACTION BEHAVIORAL TESTS
// ===============================================================================

describe('VLM handlers database interaction', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-vlm-db-interaction');

  beforeAll(() => {
    resetState();
    tempDir = createTempDir('test-vlm-db-interaction-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  describe('handleVLMProcess with database state', () => {
    it('can find documents in the database', async () => {
      const { db } = requireDatabase();

      // Create a document
      const docProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: docProvId,
          type: ProvenanceType.DOCUMENT,
          root_document_id: docProvId,
          chain_depth: 0,
        })
      );

      const docId = uuidv4();
      db.insertDocument(
        createTestDocument(docProvId, {
          id: docId,
          file_path: '/test/vlm-db-test.pdf',
          file_name: 'vlm-db-test.pdf',
          status: 'complete',
        })
      );

      // Verify document exists via getDocument
      const doc = db.getDocument(docId);
      expect(doc).toBeDefined();
      expect(doc?.id).toBe(docId);

      // handleVLMProcess should find the document (not throw DOCUMENT_NOT_FOUND)
      const response = await handleVLMProcess({ document_id: docId });
      const result = parseResponse(response);

      // Should NOT be DOCUMENT_NOT_FOUND since the doc exists
      if (!result.success) {
        expect(result.error?.category).not.toBe('DOCUMENT_NOT_FOUND');
      }
    });

    it('images table is queried for VLM processing', async () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();

      // Create a document with an image
      const docProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: docProvId,
          type: ProvenanceType.DOCUMENT,
          root_document_id: docProvId,
          chain_depth: 0,
        })
      );

      const docId = uuidv4();
      db.insertDocument(
        createTestDocument(docProvId, {
          id: docId,
          file_path: '/test/vlm-image-test.pdf',
          file_name: 'vlm-image-test.pdf',
          status: 'complete',
        })
      );

      const ocrProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: ocrProvId,
          type: ProvenanceType.OCR_RESULT,
          parent_id: docProvId,
          root_document_id: docProvId,
          chain_depth: 1,
        })
      );

      const ocrId = uuidv4();
      db.insertOCRResult(
        createTestOCRResult(docId, ocrProvId, {
          id: ocrId,
        })
      );

      // Insert an image with pending VLM status
      const imgProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: imgProvId,
          type: ProvenanceType.IMAGE,
          parent_id: ocrProvId,
          root_document_id: docProvId,
          chain_depth: 2,
        })
      );

      const imgId = uuidv4();
      conn
        .prepare(
          `
        INSERT INTO images (id, document_id, ocr_result_id, page_number, bbox_x, bbox_y,
          bbox_width, bbox_height, image_index, format, width, height,
          extracted_path, vlm_status, provenance_id, created_at)
        VALUES (?, ?, ?, 1, 0.0, 0.0, 100.0, 100.0, 0, 'png', 200, 200,
          '/tmp/test-vlm-img.png', 'pending', ?, datetime('now'))
      `
        )
        .run(imgId, docId, ocrId, imgProvId);

      // Verify image was inserted
      const imgRow = conn.prepare('SELECT id, vlm_status FROM images WHERE id = ?').get(imgId) as
        | {
            id: string;
            vlm_status: string;
          }
        | undefined;
      expect(imgRow).toBeDefined();
      expect(imgRow?.vlm_status).toBe('pending');

      // handleVLMProcess with this document should find the image
      // It will try to process it (and likely fail on VLM init), but
      // should not return DOCUMENT_NOT_FOUND
      const response = await handleVLMProcess({ document_id: docId });
      const result = parseResponse(response);

      if (!result.success) {
        expect(result.error?.category).not.toBe('DOCUMENT_NOT_FOUND');
        expect(result.error?.category).not.toBe('DATABASE_NOT_SELECTED');
      }
    });
  });
});

// ===============================================================================
// MCP RESPONSE STRUCTURE TESTS
// ===============================================================================

describe('All VLM handlers return correct MCP response structure', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  it('every handler returns {content: [{type, text}]} even on error', async () => {
    const handlers = [
      () => handleVLMDescribe({}),
      () => handleVLMProcess({}),
      () => handleVLMAnalyzePDF({}),
      () => handleVLMStatus({}),
    ];

    for (const handler of handlers) {
      const response = await handler();
      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.content[0]).toHaveProperty('type', 'text');
      expect(response.content[0]).toHaveProperty('text');
      // Must be valid JSON
      expect(() => JSON.parse(response.content[0].text)).not.toThrow();
    }
  });

  it('error responses have isError flag set', async () => {
    // These should all fail (no DB, no paths, etc.)
    const handlers = [
      () => handleVLMDescribe({}),
      () => handleVLMProcess({}),
      () => handleVLMAnalyzePDF({}),
    ];

    for (const handler of handlers) {
      const response = await handler();
      const result = parseResponse(response);
      if (!result.success) {
        // isError flag should be set on error responses
        expect(response.isError).toBe(true);
      }
    }
  });

  it('error responses include category, message, and recovery fields', async () => {
    // Test validation errors
    const response1 = await handleVLMDescribe({});
    const result1 = parseResponse(response1);
    expect(result1.success).toBe(false);
    expect(result1.error?.category).toBeDefined();
    expect(result1.error?.message).toBeDefined();
    expect(typeof result1.error?.message).toBe('string');
    expect(result1.error!.message.length).toBeGreaterThan(0);

    // Test PATH_NOT_FOUND errors (use /tmp which is in allowed dirs)
    const response2 = await handleVLMAnalyzePDF({ pdf_path: '/tmp/nonexistent-vlm-test.pdf' });
    const result2 = parseResponse(response2);
    expect(result2.success).toBe(false);
    expect(result2.error?.category).toBe('PATH_NOT_FOUND');
    expect(result2.error?.recovery).toBeDefined();

    // Test DATABASE_NOT_SELECTED errors
    const response3 = await handleVLMProcess({});
    const result3 = parseResponse(response3);
    expect(result3.success).toBe(false);
    expect(result3.error?.category).toBe('DATABASE_NOT_SELECTED');
    expect(result3.error?.recovery).toBeDefined();
  });
});

// ===============================================================================
// withDatabaseOperation WRAPPER TESTS
// ===============================================================================

describe('withDatabaseOperation wrapper behavior', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-vlm-wrapper');

  beforeAll(() => {
    resetState();
    tempDir = createTempDir('test-vlm-wrapper-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('handleVLMDescribe operation counter is cleaned up on error', async () => {
    const imgDir = join(tempDir, 'wrapper-test-images');
    if (!existsSync(imgDir)) {
      mkdirSync(imgDir, { recursive: true });
    }
    const imgPath = join(imgDir, 'wrapper-test.png');
    writeFileSync(imgPath, Buffer.from('fake-png'));

    // This will pass validation and file check, fail on VLM service
    await handleVLMDescribe({ image_path: imgPath });

    // Operation counter should be back to 0
    // If it wasn't, selectDatabase would throw
    const { db } = requireDatabase();
    expect(db).toBeDefined();
  });

  it('handleVLMProcess operation counter is cleaned up on error', async () => {
    // Try to process a nonexistent document
    await handleVLMProcess({ document_id: 'nonexistent-doc' });

    // Operation counter should be back to 0
    const { db } = requireDatabase();
    expect(db).toBeDefined();
  });

  it('handleVLMAnalyzePDF does NOT use withDatabaseOperation', async () => {
    // VLM Analyze PDF should work even without a database selected
    // Clear the database to verify
    resetState();

    // Use /tmp path which is in the allowed base directories
    const response = await handleVLMAnalyzePDF({
      pdf_path: '/tmp/nonexistent-vlm-wrapper-test.pdf',
    });
    const result = parseResponse(response);

    // Should fail on PATH_NOT_FOUND, not DATABASE_NOT_SELECTED
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('PATH_NOT_FOUND');
  });

  it('handleVLMStatus does NOT use withDatabaseOperation', async () => {
    // VLM Status should work even without a database selected
    resetState();

    const response = await handleVLMStatus({});
    const result = parseResponse(response);

    // Should not be DATABASE_NOT_SELECTED
    if (!result.success) {
      expect(result.error?.category).not.toBe('DATABASE_NOT_SELECTED');
    }
  });
});

// ===============================================================================
// TYPE COERCION EDGE CASES
// ===============================================================================

describe('Type coercion edge cases', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  it('handleVLMDescribe rejects non-string image_path', async () => {
    const response = await handleVLMDescribe({ image_path: true });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleVLMDescribe rejects null image_path', async () => {
    const response = await handleVLMDescribe({ image_path: null });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleVLMProcess rejects non-string document_id', async () => {
    const response = await handleVLMProcess({ document_id: 123 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleVLMProcess rejects string batch_size', async () => {
    const response = await handleVLMProcess({ batch_size: 'five' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleVLMProcess rejects string limit', async () => {
    const response = await handleVLMProcess({ limit: 'many' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleVLMAnalyzePDF rejects non-string pdf_path', async () => {
    const response = await handleVLMAnalyzePDF({ pdf_path: false });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('handleVLMAnalyzePDF rejects null pdf_path', async () => {
    const response = await handleVLMAnalyzePDF({ pdf_path: null });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });
});
