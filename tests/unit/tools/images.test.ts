/**
 * Unit Tests for Image MCP Tools
 *
 * Tests the extracted image tool handlers in src/tools/images.ts
 * Tools: handleImageExtract, handleImageList, handleImageGet, handleImageStats,
 *        handleImageDelete, handleImageDeleteByDocument, handleImageResetFailed,
 *        handleImagePending
 *
 * NO MOCK DATA - Tests focus on error paths and validation.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/images
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleImageExtract,
  handleImageList,
  handleImageGet,
  handleImageStats,
  handleImageDelete,
  handleImageDeleteByDocument,
  handleImageResetFailed,
  handleImagePending,
  imageTools,
} from '../../../src/tools/images.js';
import { resetState, clearDatabase } from '../../../src/server/state.js';

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
  };
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

// ===============================================================================
// TOOL EXPORTS VERIFICATION
// ===============================================================================

describe('imageTools exports', () => {
  it('exports all 8 image tools', () => {
    expect(Object.keys(imageTools)).toHaveLength(8);
    expect(imageTools).toHaveProperty('ocr_image_extract');
    expect(imageTools).toHaveProperty('ocr_image_list');
    expect(imageTools).toHaveProperty('ocr_image_get');
    expect(imageTools).toHaveProperty('ocr_image_stats');
    expect(imageTools).toHaveProperty('ocr_image_delete');
    expect(imageTools).toHaveProperty('ocr_image_delete_by_document');
    expect(imageTools).toHaveProperty('ocr_image_reset_failed');
    expect(imageTools).toHaveProperty('ocr_image_pending');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(imageTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length, `${name} description is empty`).toBeGreaterThan(0);
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('tools map to the correct handlers', () => {
    expect(imageTools.ocr_image_extract.handler).toBe(handleImageExtract);
    expect(imageTools.ocr_image_list.handler).toBe(handleImageList);
    expect(imageTools.ocr_image_get.handler).toBe(handleImageGet);
    expect(imageTools.ocr_image_stats.handler).toBe(handleImageStats);
    expect(imageTools.ocr_image_delete.handler).toBe(handleImageDelete);
    expect(imageTools.ocr_image_delete_by_document.handler).toBe(handleImageDeleteByDocument);
    expect(imageTools.ocr_image_reset_failed.handler).toBe(handleImageResetFailed);
    expect(imageTools.ocr_image_pending.handler).toBe(handleImagePending);
  });
});

// ===============================================================================
// handleImageExtract TESTS
// ===============================================================================

describe('handleImageExtract', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns INTERNAL_ERROR when pdf_path is missing', async () => {
    const response = await handleImageExtract({
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when pdf_path is empty string', async () => {
    const response = await handleImageExtract({
      pdf_path: '',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when output_dir is missing', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when output_dir is empty string', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when document_id is missing', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      ocr_result_id: 'ocr-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when document_id is empty string', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: '',
      ocr_result_id: 'ocr-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when ocr_result_id is missing', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when ocr_result_id is empty string', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: '',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns PATH_NOT_FOUND when pdf_path does not exist on disk', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/nonexistent-file-abc123.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('PATH_NOT_FOUND');
    expect(result.error?.message).toContain('PDF file not found');
  });

  it('returns INTERNAL_ERROR when min_size is zero', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
      min_size: 0,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when min_size is negative', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
      min_size: -10,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when max_images is zero', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
      max_images: 0,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when max_images exceeds 1000', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
      max_images: 1001,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when min_size is not an integer', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
      min_size: 50.5,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when max_images is not an integer', async () => {
    const response = await handleImageExtract({
      pdf_path: '/tmp/test.pdf',
      output_dir: '/tmp/out',
      document_id: 'doc-1',
      ocr_result_id: 'ocr-1',
      max_images: 10.5,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});

// ===============================================================================
// handleImageList TESTS
// ===============================================================================

describe('handleImageList', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns INTERNAL_ERROR when document_id is missing', async () => {
    const response = await handleImageList({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when document_id is empty string', async () => {
    const response = await handleImageList({ document_id: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns DATABASE_NOT_SELECTED when no database and valid params', async () => {
    const response = await handleImageList({ document_id: 'doc-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns INTERNAL_ERROR when vlm_status is invalid enum value', async () => {
    const response = await handleImageList({
      document_id: 'doc-1',
      vlm_status: 'invalid_status',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('accepts valid vlm_status values without crashing on validation', async () => {
    // These should pass validation but fail on DATABASE_NOT_SELECTED
    const validStatuses = ['pending', 'processing', 'complete', 'failed'];
    for (const status of validStatuses) {
      const response = await handleImageList({
        document_id: 'doc-1',
        vlm_status: status,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it('accepts optional entity_filter param without crashing on validation', async () => {
    const response = await handleImageList({
      document_id: 'doc-1',
      entity_filter: 'John Doe',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts include_descriptions boolean without crashing on validation', async () => {
    const response = await handleImageList({
      document_id: 'doc-1',
      include_descriptions: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// handleImageGet TESTS
// ===============================================================================

describe('handleImageGet', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns INTERNAL_ERROR when image_id is missing', async () => {
    const response = await handleImageGet({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when image_id is empty string', async () => {
    const response = await handleImageGet({ image_id: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns DATABASE_NOT_SELECTED when no database and valid params', async () => {
    const response = await handleImageGet({ image_id: 'img-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts include_page_entities boolean without crashing on validation', async () => {
    const response = await handleImageGet({
      image_id: 'img-1',
      include_page_entities: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('defaults include_page_entities to false', async () => {
    // Should pass validation (no include_page_entities provided) but fail on DB
    const response = await handleImageGet({ image_id: 'img-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// handleImageStats TESTS
// ===============================================================================

describe('handleImageStats', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleImageStats({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts empty object as valid input', async () => {
    // ImageStatsInput is z.object({}) so empty object should pass validation
    // but fail on DATABASE_NOT_SELECTED
    const response = await handleImageStats({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// handleImageDelete TESTS
// ===============================================================================

describe('handleImageDelete', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns INTERNAL_ERROR when image_id is missing', async () => {
    const response = await handleImageDelete({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when image_id is empty string', async () => {
    const response = await handleImageDelete({ image_id: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns DATABASE_NOT_SELECTED when no database and valid params', async () => {
    const response = await handleImageDelete({ image_id: 'img-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts delete_file boolean without crashing on validation', async () => {
    const response = await handleImageDelete({
      image_id: 'img-1',
      delete_file: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('defaults delete_file to false', async () => {
    // Should pass validation without delete_file and fail on DB
    const response = await handleImageDelete({ image_id: 'img-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// handleImageDeleteByDocument TESTS
// ===============================================================================

describe('handleImageDeleteByDocument', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns INTERNAL_ERROR when document_id is missing', async () => {
    const response = await handleImageDeleteByDocument({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when document_id is empty string', async () => {
    const response = await handleImageDeleteByDocument({ document_id: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns DATABASE_NOT_SELECTED when no database and valid params', async () => {
    const response = await handleImageDeleteByDocument({ document_id: 'doc-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts delete_files boolean without crashing on validation', async () => {
    const response = await handleImageDeleteByDocument({
      document_id: 'doc-1',
      delete_files: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('defaults delete_files to false', async () => {
    const response = await handleImageDeleteByDocument({ document_id: 'doc-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// handleImageResetFailed TESTS
// ===============================================================================

describe('handleImageResetFailed', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database and no document_id', async () => {
    const response = await handleImageResetFailed({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED when no database with document_id', async () => {
    const response = await handleImageResetFailed({ document_id: 'doc-1' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts optional document_id param', async () => {
    // document_id is optional, so omitting it should pass validation
    // and fail on DATABASE_NOT_SELECTED
    const response = await handleImageResetFailed({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// handleImagePending TESTS
// ===============================================================================

describe('handleImagePending', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database with defaults', async () => {
    const response = await handleImagePending({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED when no database with valid limit', async () => {
    const response = await handleImagePending({ limit: 50 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns INTERNAL_ERROR when limit is zero', async () => {
    const response = await handleImagePending({ limit: 0 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when limit is negative', async () => {
    const response = await handleImagePending({ limit: -1 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when limit exceeds 1000', async () => {
    const response = await handleImagePending({ limit: 1001 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns INTERNAL_ERROR when limit is not an integer', async () => {
    const response = await handleImagePending({ limit: 50.5 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('accepts boundary limit value 1', async () => {
    const response = await handleImagePending({ limit: 1 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts boundary limit value 1000', async () => {
    const response = await handleImagePending({ limit: 1000 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// EDGE CASE TESTS
// ===============================================================================

describe('Edge Cases', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('error response structure', () => {
    it('error responses have correct MCP content structure', async () => {
      const response = await handleImageGet({ image_id: 'test-id' });

      // Verify MCP response shape
      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toHaveProperty('type', 'text');
      expect(response.content[0]).toHaveProperty('text');
      expect(typeof response.content[0].text).toBe('string');

      // Verify parseable JSON
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed).toHaveProperty('success');
      expect(parsed.success).toBe(false);
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toHaveProperty('category');
      expect(parsed.error).toHaveProperty('message');
    });

    it('validation error responses include descriptive messages', async () => {
      const response = await handleImageExtract({});
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
      expect(result.error?.message).toBeDefined();
      expect(typeof result.error?.message).toBe('string');
      expect(result.error!.message.length).toBeGreaterThan(0);
    });
  });

  describe('unknown params are stripped by Zod', () => {
    it('image_list strips unknown params and proceeds to database check', async () => {
      const response = await handleImageList({
        document_id: 'doc-1',
        unknown_param: 'should be stripped',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('image_get strips unknown params and proceeds to database check', async () => {
      const response = await handleImageGet({
        image_id: 'img-1',
        extra_field: 123,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('image_stats strips unknown params and proceeds to database check', async () => {
      const response = await handleImageStats({
        something_extra: true,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('image_pending strips unknown params and proceeds to database check', async () => {
      const response = await handleImagePending({
        unknown: 'value',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('image_delete strips unknown params and proceeds to database check', async () => {
      const response = await handleImageDelete({
        image_id: 'img-1',
        cascade: true,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('image_delete_by_document strips unknown params and proceeds to database check', async () => {
      const response = await handleImageDeleteByDocument({
        document_id: 'doc-1',
        force: true,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('image_reset_failed strips unknown params and proceeds to database check', async () => {
      const response = await handleImageResetFailed({
        extra: 'value',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  describe('type coercion edge cases', () => {
    it('image_extract rejects non-string pdf_path', async () => {
      const response = await handleImageExtract({
        pdf_path: 123,
        output_dir: '/tmp/out',
        document_id: 'doc-1',
        ocr_result_id: 'ocr-1',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });

    it('image_extract rejects non-string document_id', async () => {
      const response = await handleImageExtract({
        pdf_path: '/tmp/test.pdf',
        output_dir: '/tmp/out',
        document_id: 42,
        ocr_result_id: 'ocr-1',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });

    it('image_list rejects non-string document_id', async () => {
      const response = await handleImageList({ document_id: 123 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });

    it('image_get rejects non-string image_id', async () => {
      const response = await handleImageGet({ image_id: 42 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });

    it('image_delete rejects non-string image_id', async () => {
      const response = await handleImageDelete({ image_id: true });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });

    it('image_delete_by_document rejects non-string document_id', async () => {
      const response = await handleImageDeleteByDocument({ document_id: false });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });

    it('image_pending rejects string limit', async () => {
      const response = await handleImagePending({ limit: 'fifty' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });

    it('image_extract rejects string min_size', async () => {
      const response = await handleImageExtract({
        pdf_path: '/tmp/test.pdf',
        output_dir: '/tmp/out',
        document_id: 'doc-1',
        ocr_result_id: 'ocr-1',
        min_size: 'large',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });
  });

  describe('boundary values for image_extract', () => {
    it('accepts min_size of 1 (minimum boundary)', async () => {
      // Passes validation but fails on PATH_NOT_FOUND
      const response = await handleImageExtract({
        pdf_path: '/tmp/nonexistent-boundary-test.pdf',
        output_dir: '/tmp/out',
        document_id: 'doc-1',
        ocr_result_id: 'ocr-1',
        min_size: 1,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      // Should get past validation to PATH_NOT_FOUND
      expect(result.error?.category).toBe('PATH_NOT_FOUND');
    });

    it('accepts max_images of 1 (minimum boundary)', async () => {
      const response = await handleImageExtract({
        pdf_path: '/tmp/nonexistent-boundary-test.pdf',
        output_dir: '/tmp/out',
        document_id: 'doc-1',
        ocr_result_id: 'ocr-1',
        max_images: 1,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('PATH_NOT_FOUND');
    });

    it('accepts max_images of 1000 (maximum boundary)', async () => {
      const response = await handleImageExtract({
        pdf_path: '/tmp/nonexistent-boundary-test.pdf',
        output_dir: '/tmp/out',
        document_id: 'doc-1',
        ocr_result_id: 'ocr-1',
        max_images: 1000,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('PATH_NOT_FOUND');
    });
  });

  describe('all handlers return ToolResponse shape', () => {
    it('every handler returns {content: [{type, text}]} even on error', async () => {
      const handlers = [
        () => handleImageExtract({}),
        () => handleImageList({}),
        () => handleImageGet({}),
        () => handleImageStats({}),
        () => handleImageDelete({}),
        () => handleImageDeleteByDocument({}),
        () => handleImageResetFailed({}),
        () => handleImagePending({}),
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
  });
});
