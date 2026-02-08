/**
 * File Type Alignment Tests
 *
 * Verifies that DEFAULT_FILE_TYPES in validation.ts matches SUPPORTED_FILE_TYPES
 * in document.ts and includes all 18 Datalab-supported types.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_FILE_TYPES } from '../../../src/utils/validation.js';
import { SUPPORTED_FILE_TYPES } from '../../../src/models/document.js';

describe('File Type Alignment', () => {
  const EXPECTED_TYPES = new Set([
    'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls',
    'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp',
    'txt', 'csv', 'md',
  ]);

  it('DEFAULT_FILE_TYPES includes all Datalab-supported document types', () => {
    for (const type of ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls']) {
      expect(DEFAULT_FILE_TYPES).toContain(type);
    }
  });

  it('DEFAULT_FILE_TYPES includes all image types', () => {
    for (const type of ['png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp']) {
      expect(DEFAULT_FILE_TYPES).toContain(type);
    }
  });

  it('DEFAULT_FILE_TYPES includes text format types', () => {
    for (const type of ['txt', 'csv', 'md']) {
      expect(DEFAULT_FILE_TYPES).toContain(type);
    }
  });

  it('DEFAULT_FILE_TYPES matches SUPPORTED_FILE_TYPES from document model', () => {
    expect(new Set(DEFAULT_FILE_TYPES)).toEqual(new Set(SUPPORTED_FILE_TYPES));
  });

  it('DEFAULT_FILE_TYPES matches expected canonical set', () => {
    expect(new Set(DEFAULT_FILE_TYPES)).toEqual(EXPECTED_TYPES);
  });

  it('has exactly 18 types', () => {
    expect(new Set(DEFAULT_FILE_TYPES).size).toBe(18);
  });
});
