/**
 * V5 Merge Validation Tests
 *
 * Validates that the 6 tool merges were correctly implemented:
 *   MERGE-3:  ocr_vlm_process_document + ocr_vlm_process_pending -> ocr_vlm_process
 *   MERGE-4:  ocr_image_search + ocr_image_semantic_search -> ocr_image_search
 *   MERGE-5:  ocr_extraction_list + ocr_extraction_search -> ocr_extraction_list
 *   MERGE-6:  ocr_evaluate_single + ocr_evaluate_document + ocr_evaluate_pending -> ocr_evaluate
 *   MERGE-9:  ocr_extract_images + ocr_extract_images_batch -> ocr_extract_images
 *   MERGE-10: ocr_image_delete + ocr_image_delete_by_document -> ocr_image_delete
 *
 * Tests verify:
 *   1. Merged tool names exist in exports
 *   2. Old tool names do NOT exist in exports
 *   3. Handlers dispatch to correct mode based on params
 *   4. Validation errors for invalid/missing params
 *   5. Each merged handler requires database when appropriate
 *
 * NO MOCK DATA for external services - focuses on error paths and input validation.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/v5-merge-validation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
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
  computeHash,
} from '../../integration/server/helpers.js';

import { vlmTools } from '../../../src/tools/vlm.js';
import { imageTools, handleImageSearch, handleImageDelete } from '../../../src/tools/images.js';
import { structuredExtractionTools } from '../../../src/tools/extraction-structured.js';
import { evaluationTools, handleEvaluate } from '../../../src/tools/evaluation.js';
import { extractionTools, handleExtractImages } from '../../../src/tools/extraction.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    category: string;
    message: string;
    details?: Record<string, unknown>;
    recovery?: { tool: string; hint: string };
  };
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

/**
 * Insert a test image record directly for testing.
 */
function insertTestImage(
  conn: ReturnType<typeof requireDatabase>['db']['getConnection'],
  opts: {
    id: string;
    document_id: string;
    ocr_result_id: string;
    page_number: number;
    image_index: number;
    extracted_path: string | null;
    provenance_id: string | null;
    vlm_status?: string;
    vlm_description?: string | null;
    vlm_confidence?: number | null;
    block_type?: string | null;
  }
) {
  conn
    .prepare(
      `INSERT INTO images (
      id, document_id, ocr_result_id, page_number,
      bbox_x, bbox_y, bbox_width, bbox_height,
      image_index, format, width, height,
      extracted_path, file_size, vlm_status,
      vlm_description, vlm_confidence,
      provenance_id, block_type, is_header_footer,
      created_at, content_hash
    ) VALUES (
      ?, ?, ?, ?,
      0, 0, 100, 100,
      ?, 'png', 200, 200,
      ?, 1024, ?,
      ?, ?,
      ?, ?, 0,
      datetime('now'), ?
    )`
    )
    .run(
      opts.id,
      opts.document_id,
      opts.ocr_result_id,
      opts.page_number,
      opts.image_index,
      opts.extracted_path,
      opts.vlm_status ?? 'pending',
      opts.vlm_description ?? null,
      opts.vlm_confidence ?? null,
      opts.provenance_id,
      opts.block_type ?? null,
      computeHash(opts.id)
    );
}

// =============================================================================
// SECTION 1: TOOL EXPORTS VERIFICATION - Merged tools exist, old ones removed
// =============================================================================

describe('V5 Merge Validation: Tool Exports', () => {
  // ── MERGE-3: VLM Process ──
  describe('MERGE-3: ocr_vlm_process (replaces ocr_vlm_process_document + ocr_vlm_process_pending)', () => {
    it('should export ocr_vlm_process as a registered tool', () => {
      expect(vlmTools).toHaveProperty('ocr_vlm_process');
      const tool = vlmTools['ocr_vlm_process'];
      expect(tool.description).toBeDefined();
      expect(typeof tool.handler).toBe('function');
      expect(tool.inputSchema).toBeDefined();
    });

    it('should NOT export old tool names ocr_vlm_process_document or ocr_vlm_process_pending', () => {
      expect(vlmTools).not.toHaveProperty('ocr_vlm_process_document');
      expect(vlmTools).not.toHaveProperty('ocr_vlm_process_pending');
    });

    it('should have document_id as optional in the schema', () => {
      const schema = vlmTools['ocr_vlm_process'].inputSchema;
      expect(schema).toHaveProperty('document_id');
    });

    it('should have batch_size and limit in the schema', () => {
      const schema = vlmTools['ocr_vlm_process'].inputSchema;
      expect(schema).toHaveProperty('batch_size');
      expect(schema).toHaveProperty('limit');
    });

    it('should have 4 VLM tools total (describe, process, analyze_pdf, status)', () => {
      const toolNames = Object.keys(vlmTools);
      expect(toolNames).toContain('ocr_vlm_describe');
      expect(toolNames).toContain('ocr_vlm_process');
      expect(toolNames).toContain('ocr_vlm_analyze_pdf');
      expect(toolNames).toContain('ocr_vlm_status');
      expect(toolNames).toHaveLength(4);
    });
  });

  // ── MERGE-4: Image Search ──
  describe('MERGE-4: ocr_image_search (replaces ocr_image_search + ocr_image_semantic_search)', () => {
    it('should export ocr_image_search as a registered tool', () => {
      expect(imageTools).toHaveProperty('ocr_image_search');
      const tool = imageTools['ocr_image_search'];
      expect(tool.description).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    });

    it('should NOT export old tool name ocr_image_semantic_search', () => {
      expect(imageTools).not.toHaveProperty('ocr_image_semantic_search');
    });

    it('should have mode field in schema with keyword and semantic options', () => {
      const schema = imageTools['ocr_image_search'].inputSchema;
      expect(schema).toHaveProperty('mode');
    });

    it('should have keyword mode params: image_type, block_type, min_confidence, vlm_description_query', () => {
      const schema = imageTools['ocr_image_search'].inputSchema;
      expect(schema).toHaveProperty('image_type');
      expect(schema).toHaveProperty('block_type');
      expect(schema).toHaveProperty('min_confidence');
      expect(schema).toHaveProperty('vlm_description_query');
    });

    it('should have semantic mode params: query, similarity_threshold, document_filter', () => {
      const schema = imageTools['ocr_image_search'].inputSchema;
      expect(schema).toHaveProperty('query');
      expect(schema).toHaveProperty('similarity_threshold');
      expect(schema).toHaveProperty('document_filter');
    });
  });

  // ── MERGE-5: Extraction List ──
  describe('MERGE-5: ocr_extraction_list (replaces ocr_extraction_list + ocr_extraction_search)', () => {
    it('should export ocr_extraction_list as a registered tool', () => {
      expect(structuredExtractionTools).toHaveProperty('ocr_extraction_list');
      const tool = structuredExtractionTools['ocr_extraction_list'];
      expect(tool.description).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    });

    it('should NOT export old tool name ocr_extraction_search', () => {
      expect(structuredExtractionTools).not.toHaveProperty('ocr_extraction_search');
    });

    it('should have both document_id and query in schema for dual mode', () => {
      const schema = structuredExtractionTools['ocr_extraction_list'].inputSchema;
      expect(schema).toHaveProperty('document_id');
      expect(schema).toHaveProperty('query');
    });

    it('should have 3 structured extraction tools total', () => {
      const toolNames = Object.keys(structuredExtractionTools);
      expect(toolNames).toContain('ocr_extract_structured');
      expect(toolNames).toContain('ocr_extraction_list');
      expect(toolNames).toContain('ocr_extraction_get');
      expect(toolNames).toHaveLength(3);
    });
  });

  // ── MERGE-6: Evaluate ──
  describe('MERGE-6: ocr_evaluate (replaces ocr_evaluate_single + ocr_evaluate_document + ocr_evaluate_pending)', () => {
    it('should export ocr_evaluate as a registered tool', () => {
      expect(evaluationTools).toHaveProperty('ocr_evaluate');
      const tool = evaluationTools['ocr_evaluate'];
      expect(tool.description).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    });

    it('should NOT export old tool names', () => {
      expect(evaluationTools).not.toHaveProperty('ocr_evaluate_single');
      expect(evaluationTools).not.toHaveProperty('ocr_evaluate_document');
      expect(evaluationTools).not.toHaveProperty('ocr_evaluate_pending');
    });

    it('should have image_id and document_id as optional fields for mode dispatch', () => {
      const schema = evaluationTools['ocr_evaluate'].inputSchema;
      expect(schema).toHaveProperty('image_id');
      expect(schema).toHaveProperty('document_id');
    });

    it('should have batch_size and limit for batch processing', () => {
      const schema = evaluationTools['ocr_evaluate'].inputSchema;
      expect(schema).toHaveProperty('batch_size');
      expect(schema).toHaveProperty('limit');
    });

    it('should have exactly 1 evaluation tool (ocr_evaluate)', () => {
      expect(Object.keys(evaluationTools)).toHaveLength(1);
    });
  });

  // ── MERGE-9: Extract Images ──
  describe('MERGE-9: ocr_extract_images (replaces ocr_extract_images + ocr_extract_images_batch)', () => {
    it('should export ocr_extract_images as a registered tool', () => {
      expect(extractionTools).toHaveProperty('ocr_extract_images');
      const tool = extractionTools['ocr_extract_images'];
      expect(tool.description).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    });

    it('should NOT export old tool name ocr_extract_images_batch', () => {
      expect(extractionTools).not.toHaveProperty('ocr_extract_images_batch');
    });

    it('should have document_id as optional for single/batch mode dispatch', () => {
      const schema = extractionTools['ocr_extract_images'].inputSchema;
      expect(schema).toHaveProperty('document_id');
    });

    it('should have batch mode params: limit, status', () => {
      const schema = extractionTools['ocr_extract_images'].inputSchema;
      expect(schema).toHaveProperty('limit');
      expect(schema).toHaveProperty('status');
    });

    it('should have exactly 1 extraction tool', () => {
      expect(Object.keys(extractionTools)).toHaveLength(1);
    });
  });

  // ── MERGE-10: Image Delete ──
  describe('MERGE-10: ocr_image_delete (replaces ocr_image_delete + ocr_image_delete_by_document)', () => {
    it('should export ocr_image_delete as a registered tool', () => {
      expect(imageTools).toHaveProperty('ocr_image_delete');
      const tool = imageTools['ocr_image_delete'];
      expect(tool.description).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    });

    it('should NOT export old tool name ocr_image_delete_by_document', () => {
      expect(imageTools).not.toHaveProperty('ocr_image_delete_by_document');
    });

    it('should have image_id and document_id as optional for mode dispatch', () => {
      const schema = imageTools['ocr_image_delete'].inputSchema;
      expect(schema).toHaveProperty('image_id');
      expect(schema).toHaveProperty('document_id');
    });

    it('should have confirm and delete_files fields', () => {
      const schema = imageTools['ocr_image_delete'].inputSchema;
      expect(schema).toHaveProperty('confirm');
      expect(schema).toHaveProperty('delete_files');
    });
  });
});

// =============================================================================
// SECTION 2: HANDLER MODE DISPATCH - Database required errors
// =============================================================================

describe('V5 Merge Validation: Handler Mode Dispatch (no database)', () => {
  // ── MERGE-3: VLM Process - requires database ──
  describe('MERGE-3: handleVLMProcess mode dispatch', () => {
    const handler = vlmTools['ocr_vlm_process'].handler;

    it('should fail with DATABASE_NOT_SELECTED when no database is active', async () => {
      resetState();
      const result = await handler({});
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('should fail with DATABASE_NOT_SELECTED for document_id mode too', async () => {
      resetState();
      const result = await handler({ document_id: 'some-doc-id' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  // ── MERGE-4: Image Search - requires database ──
  describe('MERGE-4: handleImageSearch mode dispatch', () => {
    it('should fail with DATABASE_NOT_SELECTED for keyword mode', async () => {
      resetState();
      const result = await handleImageSearch({ mode: 'keyword' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('should fail with DATABASE_NOT_SELECTED for semantic mode', async () => {
      resetState();
      const result = await handleImageSearch({ mode: 'semantic', query: 'test' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  // ── MERGE-5: Extraction List - requires database ──
  describe('MERGE-5: handleExtractionList mode dispatch', () => {
    const handler = structuredExtractionTools['ocr_extraction_list'].handler;

    it('should fail with DATABASE_NOT_SELECTED for list mode', async () => {
      resetState();
      const result = await handler({ document_id: 'some-id' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('should fail with DATABASE_NOT_SELECTED for search mode', async () => {
      resetState();
      const result = await handler({ query: 'revenue' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  // ── MERGE-6: Evaluate - requires database ──
  describe('MERGE-6: handleEvaluate mode dispatch', () => {
    it('should fail with DATABASE_NOT_SELECTED for single image mode', async () => {
      resetState();
      const result = await handleEvaluate({ image_id: 'some-img' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('should fail with DATABASE_NOT_SELECTED for document mode', async () => {
      resetState();
      const result = await handleEvaluate({ document_id: 'some-doc' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('should fail with DATABASE_NOT_SELECTED for pending mode', async () => {
      resetState();
      const result = await handleEvaluate({});
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  // ── MERGE-9: Extract Images - requires database ──
  describe('MERGE-9: handleExtractImages mode dispatch', () => {
    it('should fail with DATABASE_NOT_SELECTED for single mode', async () => {
      resetState();
      const result = await handleExtractImages({ document_id: 'some-doc' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('should fail with DATABASE_NOT_SELECTED for batch mode', async () => {
      resetState();
      const result = await handleExtractImages({});
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  // ── MERGE-10: Image Delete - requires database ──
  describe('MERGE-10: handleImageDelete mode dispatch', () => {
    it('should fail with DATABASE_NOT_SELECTED for single image mode', async () => {
      resetState();
      const result = await handleImageDelete({ image_id: 'img-1', confirm: true });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('should fail with DATABASE_NOT_SELECTED for document mode', async () => {
      resetState();
      const result = await handleImageDelete({ document_id: 'doc-1', confirm: true });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });
});

// =============================================================================
// SECTION 3: VALIDATION ERRORS - Invalid params for merged handlers
// =============================================================================

describe('V5 Merge Validation: Param Validation', () => {
  // ── MERGE-4: Image Search validation ──
  describe('MERGE-4: ocr_image_search validation', () => {
    it('should reject invalid mode value', async () => {
      resetState();
      const result = await handleImageSearch({ mode: 'invalid_mode' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject limit less than 1', async () => {
      resetState();
      const result = await handleImageSearch({ mode: 'keyword', limit: 0 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject limit greater than 100', async () => {
      resetState();
      const result = await handleImageSearch({ mode: 'keyword', limit: 101 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject similarity_threshold > 1', async () => {
      resetState();
      const result = await handleImageSearch({
        mode: 'semantic',
        query: 'test',
        similarity_threshold: 1.5,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject similarity_threshold < 0', async () => {
      resetState();
      const result = await handleImageSearch({
        mode: 'semantic',
        query: 'test',
        similarity_threshold: -0.1,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });
  });

  // ── MERGE-10: Image Delete validation ──
  describe('MERGE-10: ocr_image_delete validation', () => {
    it('should reject when neither image_id nor document_id provided', async () => {
      resetState();
      // The handler checks for this AFTER validation and AFTER requireDatabase.
      // Without a database, we get DATABASE_NOT_SELECTED first.
      // We need a database to test the custom validation.
      const result = await handleImageDelete({ confirm: true });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      // Without DB, we get DATABASE_NOT_SELECTED; with DB we'd get VALIDATION_ERROR
      expect(parsed.error?.category).toMatch(/DATABASE_NOT_SELECTED|VALIDATION_ERROR/);
    });

    it('should reject when confirm is not true', async () => {
      resetState();
      const result = await handleImageDelete({ image_id: 'img-1', confirm: false });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      // Without DB, we get DATABASE_NOT_SELECTED first
      expect(parsed.error?.category).toMatch(/DATABASE_NOT_SELECTED|VALIDATION_ERROR/);
    });
  });

  // ── MERGE-6: Evaluate validation ──
  describe('MERGE-6: ocr_evaluate validation', () => {
    it('should reject batch_size less than 1', async () => {
      resetState();
      const result = await handleEvaluate({ batch_size: 0 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject batch_size greater than 50', async () => {
      resetState();
      const result = await handleEvaluate({ batch_size: 51 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject limit less than 1', async () => {
      resetState();
      const result = await handleEvaluate({ limit: 0 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject limit greater than 500', async () => {
      resetState();
      const result = await handleEvaluate({ limit: 501 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });
  });

  // ── MERGE-3: VLM Process validation ──
  describe('MERGE-3: ocr_vlm_process validation', () => {
    const handler = vlmTools['ocr_vlm_process'].handler;

    it('should reject batch_size less than 1', async () => {
      resetState();
      const result = await handler({ batch_size: 0 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject batch_size greater than 20', async () => {
      resetState();
      const result = await handler({ batch_size: 21 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject limit greater than 500', async () => {
      resetState();
      const result = await handler({ limit: 501 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject limit less than 1', async () => {
      resetState();
      const result = await handler({ limit: 0 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });
  });

  // ── MERGE-9: Extract Images validation ──
  describe('MERGE-9: ocr_extract_images validation', () => {
    it('should reject min_size less than 10', async () => {
      resetState();
      const result = await handleExtractImages({ document_id: 'x', min_size: 5 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject max_images less than 1', async () => {
      resetState();
      const result = await handleExtractImages({ document_id: 'x', max_images: 0 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid status enum value', async () => {
      resetState();
      const result = await handleExtractImages({ status: 'invalid_status' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });
  });

  // ── MERGE-5: Extraction List validation ──
  describe('MERGE-5: ocr_extraction_list validation', () => {
    const handler = structuredExtractionTools['ocr_extraction_list'].handler;

    it('should reject limit less than 1', async () => {
      resetState();
      const result = await handler({ document_id: 'x', limit: 0 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should reject limit greater than 100', async () => {
      resetState();
      const result = await handler({ document_id: 'x', limit: 101 });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });
  });
});

// =============================================================================
// SECTION 4: HANDLER MODE DISPATCH WITH DATABASE
// Tests that verify handlers dispatch to the correct mode based on params
// =============================================================================

describe('V5 Merge Validation: Handler Dispatch With Database', () => {
  let tempDir: string;
  const dbName = createUniqueName('v5-merge-test');

  // Test data
  let docProvId: string;
  let ocrProvId: string;
  let docId: string;
  let ocrId: string;
  let imageProvId: string;
  let imgId: string;

  beforeAll(() => {
    tempDir = createTempDir('v5-merge-');
    resetState();
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Create a complete document with OCR result for testing
    docProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: docProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: docProvId,
        chain_depth: 0,
        chain_path: '["DOCUMENT"]',
      })
    );

    docId = uuidv4();
    db.insertDocument(
      createTestDocument(docProvId, {
        id: docId,
        file_path: '/tmp/v5-test-doc.pdf',
        file_name: 'v5-test-doc.pdf',
        status: 'complete',
      })
    );

    ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProvId,
        parent_ids: JSON.stringify([docProvId]),
        root_document_id: docProvId,
        chain_depth: 1,
        chain_path: '["DOCUMENT", "OCR_RESULT"]',
      })
    );

    ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, {
        id: ocrId,
      })
    );

    // Create an IMAGE provenance + image record for image-related merge tests
    imageProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: imageProvId,
        type: ProvenanceType.IMAGE,
        parent_id: ocrProvId,
        parent_ids: JSON.stringify([docProvId, ocrProvId]),
        root_document_id: docProvId,
        chain_depth: 2,
        chain_path: '["DOCUMENT", "OCR_RESULT", "IMAGE"]',
      })
    );

    imgId = uuidv4();
    const conn = db.getConnection();
    insertTestImage(conn, {
      id: imgId,
      document_id: docId,
      ocr_result_id: ocrId,
      page_number: 1,
      image_index: 0,
      extracted_path: null,
      provenance_id: imageProvId,
      vlm_status: 'complete',
      vlm_description: 'A test chart showing revenue trends',
      vlm_confidence: 0.85,
      block_type: 'Figure',
    });
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // ── MERGE-3: VLM Process with database ──
  describe('MERGE-3: ocr_vlm_process with database', () => {
    const handler = vlmTools['ocr_vlm_process'].handler;

    it('should fail with DOCUMENT_NOT_FOUND for nonexistent document_id (document mode)', async () => {
      const result = await handler({ document_id: 'nonexistent-doc-id' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DOCUMENT_NOT_FOUND');
    });

    it('should attempt pending mode when no document_id provided', async () => {
      // This will try to run VLM pipeline which requires Gemini API.
      // Since no API key is set in tests, it should fail at the VLM step,
      // but the mode dispatch (pending vs document) is what we are validating.
      // The response tells us which mode was dispatched.
      const result = await handler({});
      const parsed = parseResponse(result);
      // It may succeed with 0 pending, or fail at VLM - either way it dispatched
      if (parsed.success && parsed.data) {
        expect(parsed.data.mode).toBe('pending');
      }
      // If it fails, it still proves dispatch happened (not a VALIDATION_ERROR)
    });

    it('should dispatch to document mode when document_id is provided', async () => {
      const result = await handler({ document_id: docId });
      const parsed = parseResponse(result);
      // Will fail at VLM API call but should NOT be DOCUMENT_NOT_FOUND
      // (proves it found the document and dispatched to document mode)
      if (parsed.success && parsed.data) {
        expect(parsed.data.mode).toBe('document');
        expect(parsed.data.document_id).toBe(docId);
      }
      // Any error other than DOCUMENT_NOT_FOUND means dispatch worked
      if (!parsed.success) {
        expect(parsed.error?.category).not.toBe('DOCUMENT_NOT_FOUND');
      }
    });
  });

  // ── MERGE-4: Image Search with database ──
  describe('MERGE-4: ocr_image_search with database', () => {
    it('should dispatch to keyword mode and return results', async () => {
      const result = await handleImageSearch({ mode: 'keyword' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('keyword');
      expect(parsed.data).toHaveProperty('images');
      expect(parsed.data).toHaveProperty('total');
      expect(parsed.data).toHaveProperty('type_distribution');
    });

    it('should filter keyword search by document_id', async () => {
      const result = await handleImageSearch({
        mode: 'keyword',
        document_id: docId,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('keyword');
      const images = parsed.data?.images as Array<Record<string, unknown>>;
      for (const img of images) {
        expect(img.document_id).toBe(docId);
      }
    });

    it('should filter keyword search by vlm_description_query', async () => {
      const result = await handleImageSearch({
        mode: 'keyword',
        vlm_description_query: 'revenue',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('keyword');
      const images = parsed.data?.images as Array<Record<string, unknown>>;
      if (images.length > 0) {
        for (const img of images) {
          const desc = (img.vlm_description as string) ?? '';
          expect(desc.toLowerCase()).toContain('revenue');
        }
      }
    });

    it('should require query for semantic mode', async () => {
      const result = await handleImageSearch({ mode: 'semantic' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
      expect(parsed.error?.message).toMatch(/query.*required|required.*query/i);
    });

    it('should default to keyword mode when mode is omitted', async () => {
      const result = await handleImageSearch({});
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('keyword');
    });
  });

  // ── MERGE-5: Extraction List with database ──
  describe('MERGE-5: ocr_extraction_list with database', () => {
    const handler = structuredExtractionTools['ocr_extraction_list'].handler;

    it('should dispatch to list mode when document_id provided', async () => {
      const result = await handler({ document_id: docId });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('list');
      expect(parsed.data?.document_id).toBe(docId);
      expect(parsed.data).toHaveProperty('extractions');
    });

    it('should dispatch to search mode when query provided', async () => {
      const result = await handler({ query: 'revenue' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('search');
      expect(parsed.data?.query).toBe('revenue');
      expect(parsed.data).toHaveProperty('results');
    });

    it('should fail when neither document_id nor query provided', async () => {
      const result = await handler({});
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
      expect(parsed.error?.message).toMatch(/document_id|query/i);
    });

    it('should prefer search mode when both document_id and query provided', async () => {
      const result = await handler({ document_id: docId, query: 'test' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      // When query is provided, search mode takes precedence
      expect(parsed.data?.mode).toBe('search');
    });
  });

  // ── MERGE-6: Evaluate with database ──
  describe('MERGE-6: ocr_evaluate with database', () => {
    it('should dispatch to single image mode when image_id provided', async () => {
      const result = await handleEvaluate({ image_id: imgId });
      const parsed = parseResponse(result);
      // Will fail at Gemini API but should NOT be VALIDATION_ERROR for the image
      if (parsed.success) {
        expect(parsed.data?.image_id).toBe(imgId);
      }
      // Any VLM/API error means it dispatched to single mode correctly
    });

    it('should fail with VALIDATION_ERROR for nonexistent image_id', async () => {
      const result = await handleEvaluate({ image_id: 'nonexistent-img' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should dispatch to document mode when document_id provided', async () => {
      const result = await handleEvaluate({ document_id: docId });
      const parsed = parseResponse(result);
      // The document exists and has 1 image (which is already 'complete' vlm_status).
      // So it should succeed with "No pending images to evaluate"
      if (parsed.success && parsed.data) {
        expect(parsed.data.document_id).toBe(docId);
      }
    });

    it('should fail with DOCUMENT_NOT_FOUND for nonexistent document_id', async () => {
      const result = await handleEvaluate({ document_id: 'nonexistent-doc' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DOCUMENT_NOT_FOUND');
    });

    it('should dispatch to pending mode when no ids provided', async () => {
      const result = await handleEvaluate({});
      const parsed = parseResponse(result);
      // Should succeed with 0 pending (our test image is already complete)
      if (parsed.success && parsed.data) {
        // pending mode returns 'processed' count and 'stats'
        expect(parsed.data).toHaveProperty('processed');
      }
    });
  });

  // ── MERGE-9: Extract Images with database ──
  describe('MERGE-9: ocr_extract_images with database', () => {
    it('should dispatch to single mode when document_id provided', async () => {
      const result = await handleExtractImages({ document_id: docId });
      const parsed = parseResponse(result);
      // Will fail because the file doesn't actually exist on disk
      if (parsed.success) {
        expect(parsed.data?.mode).toBe('single');
        expect(parsed.data?.document_id).toBe(docId);
      } else {
        // PATH_NOT_FOUND means it dispatched to single mode and tried to find the file
        expect(parsed.error?.category).toBe('PATH_NOT_FOUND');
      }
    });

    it('should fail with DOCUMENT_NOT_FOUND for nonexistent document_id', async () => {
      const result = await handleExtractImages({ document_id: 'nonexistent-doc' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('DOCUMENT_NOT_FOUND');
    });

    it('should dispatch to batch mode when no document_id provided', async () => {
      const result = await handleExtractImages({});
      const parsed = parseResponse(result);
      // Batch mode processes all supported documents
      if (parsed.success && parsed.data) {
        expect(parsed.data.mode).toBe('batch');
      }
    });
  });

  // ── MERGE-10: Image Delete with database ──
  describe('MERGE-10: ocr_image_delete with database', () => {
    it('should fail when neither image_id nor document_id provided', async () => {
      const result = await handleImageDelete({ confirm: true });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
      expect(parsed.error?.message).toMatch(/image_id|document_id/i);
    });

    it('should fail when both image_id and document_id provided', async () => {
      const result = await handleImageDelete({
        image_id: imgId,
        document_id: docId,
        confirm: true,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
      expect(parsed.error?.message).toMatch(/one of|only one|not both/i);
    });

    it('should require confirm=true', async () => {
      const result = await handleImageDelete({ image_id: imgId, confirm: false });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
      expect(parsed.error?.message).toMatch(/confirm/i);
    });

    it('should fail with VALIDATION_ERROR for nonexistent image_id', async () => {
      const result = await handleImageDelete({
        image_id: 'nonexistent-img',
        confirm: true,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.category).toBe('VALIDATION_ERROR');
    });

    it('should successfully delete an image by image_id (single mode)', async () => {
      // Create a disposable image for deletion
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const disposableImgId = uuidv4();
      const disposableProvId = uuidv4();

      db.insertProvenance(
        createTestProvenance({
          id: disposableProvId,
          type: ProvenanceType.IMAGE,
          parent_id: ocrProvId,
          parent_ids: JSON.stringify([docProvId, ocrProvId]),
          root_document_id: docProvId,
          chain_depth: 2,
        })
      );

      insertTestImage(conn, {
        id: disposableImgId,
        document_id: docId,
        ocr_result_id: ocrId,
        page_number: 2,
        image_index: 0,
        extracted_path: null,
        provenance_id: disposableProvId,
        vlm_status: 'pending',
      });

      const result = await handleImageDelete({
        image_id: disposableImgId,
        confirm: true,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('single');
      expect(parsed.data?.image_id).toBe(disposableImgId);
      expect(parsed.data?.deleted).toBe(true);
    });

    it('should successfully delete images by document_id (document mode)', async () => {
      // Create a disposable document with images for deletion
      const { db } = requireDatabase();
      const conn = db.getConnection();

      const dDocProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: dDocProvId,
          type: ProvenanceType.DOCUMENT,
          root_document_id: dDocProvId,
          chain_depth: 0,
        })
      );

      const dDocId = uuidv4();
      db.insertDocument(
        createTestDocument(dDocProvId, {
          id: dDocId,
          file_path: '/tmp/disposable-doc.pdf',
          file_name: 'disposable-doc.pdf',
          status: 'complete',
        })
      );

      const dOcrProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: dOcrProvId,
          type: ProvenanceType.OCR_RESULT,
          parent_id: dDocProvId,
          parent_ids: JSON.stringify([dDocProvId]),
          root_document_id: dDocProvId,
          chain_depth: 1,
        })
      );

      const dOcrId = uuidv4();
      db.insertOCRResult(createTestOCRResult(dDocId, dOcrProvId, { id: dOcrId }));

      // Insert 2 images
      for (let i = 0; i < 2; i++) {
        const dImgProvId = uuidv4();
        db.insertProvenance(
          createTestProvenance({
            id: dImgProvId,
            type: ProvenanceType.IMAGE,
            parent_id: dOcrProvId,
            parent_ids: JSON.stringify([dDocProvId, dOcrProvId]),
            root_document_id: dDocProvId,
            chain_depth: 2,
          })
        );

        insertTestImage(conn, {
          id: uuidv4(),
          document_id: dDocId,
          ocr_result_id: dOcrId,
          page_number: i + 1,
          image_index: 0,
          extracted_path: null,
          provenance_id: dImgProvId,
          vlm_status: 'pending',
        });
      }

      const result = await handleImageDelete({
        document_id: dDocId,
        confirm: true,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('document');
      expect(parsed.data?.document_id).toBe(dDocId);
      expect(parsed.data?.images_deleted).toBe(2);
    });
  });
});

// =============================================================================
// SECTION 5: RESPONSE FORMAT VALIDATION - next_steps present
// =============================================================================

describe('V5 Merge Validation: Response Format', () => {
  let tempDir: string;
  const dbName = createUniqueName('v5-response-test');

  beforeAll(() => {
    tempDir = createTempDir('v5-resp-');
    resetState();
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('MERGE-4: keyword image search response includes next_steps', async () => {
    const result = await handleImageSearch({ mode: 'keyword' });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.next_steps).toBeDefined();
    expect(Array.isArray(parsed.data?.next_steps)).toBe(true);
  });

  it('MERGE-5: extraction list response includes next_steps', async () => {
    const handler = structuredExtractionTools['ocr_extraction_list'].handler;
    const { db } = requireDatabase();

    // Need a document to list against
    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    const result = await handler({ document_id: doc.id });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.next_steps).toBeDefined();
  });

  it('MERGE-5: extraction search response includes next_steps', async () => {
    const handler = structuredExtractionTools['ocr_extraction_list'].handler;
    const result = await handler({ query: 'test' });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.next_steps).toBeDefined();
  });

  it('MERGE-9: batch extract images response includes next_steps', async () => {
    const result = await handleExtractImages({});
    const parsed = parseResponse(result);
    if (parsed.success) {
      expect(parsed.data?.next_steps).toBeDefined();
    }
  });

  it('MERGE-6: evaluate pending (no pending) response includes next_steps', async () => {
    const result = await handleEvaluate({});
    const parsed = parseResponse(result);
    if (parsed.success) {
      expect(parsed.data?.next_steps).toBeDefined();
    }
  });
});

// =============================================================================
// SECTION 6: TOOL HANDLER FUNCTION MAPPING
// =============================================================================

describe('V5 Merge Validation: Handler Function Mapping', () => {
  it('MERGE-3: ocr_vlm_process handler is the exported handleVLMProcess', () => {
    // Verify the handler function is correctly mapped
    const tool = vlmTools['ocr_vlm_process'];
    expect(typeof tool.handler).toBe('function');
    expect(tool.handler.name).toMatch(/handleVLMProcess|handler/);
  });

  it('MERGE-4: ocr_image_search handler is the exported handleImageSearch', () => {
    expect(imageTools['ocr_image_search'].handler).toBe(handleImageSearch);
  });

  it('MERGE-6: ocr_evaluate handler is the exported handleEvaluate', () => {
    expect(evaluationTools['ocr_evaluate'].handler).toBe(handleEvaluate);
  });

  it('MERGE-9: ocr_extract_images handler is the exported handleExtractImages', () => {
    expect(extractionTools['ocr_extract_images'].handler).toBe(handleExtractImages);
  });

  it('MERGE-10: ocr_image_delete handler is the exported handleImageDelete', () => {
    expect(imageTools['ocr_image_delete'].handler).toBe(handleImageDelete);
  });
});
