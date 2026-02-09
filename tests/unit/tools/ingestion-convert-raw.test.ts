/**
 * Unit tests for ocr_convert_raw tool (AI-4)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateInput, ValidationError } from '../../../src/utils/validation.js';

// Test the validation schema used by handleConvertRaw
const ConvertRawSchema = z.object({
  file_path: z.string().min(1),
  ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced'),
  max_pages: z.number().int().min(1).max(7000).optional(),
  page_range: z.string().optional(),
});

describe('ocr_convert_raw validation', () => {
  it('should validate minimal input with defaults', () => {
    const input = validateInput(ConvertRawSchema, { file_path: '/tmp/test.pdf' });
    expect(input.file_path).toBe('/tmp/test.pdf');
    expect(input.ocr_mode).toBe('balanced');
    expect(input.max_pages).toBeUndefined();
    expect(input.page_range).toBeUndefined();
  });

  it('should accept all valid ocr modes', () => {
    for (const mode of ['fast', 'balanced', 'accurate']) {
      const input = validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        ocr_mode: mode,
      });
      expect(input.ocr_mode).toBe(mode);
    }
  });

  it('should reject empty file_path', () => {
    expect(() =>
      validateInput(ConvertRawSchema, { file_path: '' })
    ).toThrow(ValidationError);
  });

  it('should reject missing file_path', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {})
    ).toThrow(ValidationError);
  });

  it('should reject invalid ocr_mode', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        ocr_mode: 'invalid',
      })
    ).toThrow(ValidationError);
  });

  it('should accept max_pages within range', () => {
    const input = validateInput(ConvertRawSchema, {
      file_path: '/tmp/test.pdf',
      max_pages: 100,
    });
    expect(input.max_pages).toBe(100);
  });

  it('should reject max_pages below 1', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        max_pages: 0,
      })
    ).toThrow(ValidationError);
  });

  it('should reject max_pages above 7000', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        max_pages: 7001,
      })
    ).toThrow(ValidationError);
  });

  it('should accept page_range string', () => {
    const input = validateInput(ConvertRawSchema, {
      file_path: '/tmp/test.pdf',
      page_range: '0-5,10',
    });
    expect(input.page_range).toBe('0-5,10');
  });

  it('should reject non-integer max_pages', () => {
    expect(() =>
      validateInput(ConvertRawSchema, {
        file_path: '/tmp/test.pdf',
        max_pages: 1.5,
      })
    ).toThrow(ValidationError);
  });
});

describe('ocr_convert_raw tool definition', () => {
  it('should be registered in ingestionTools', async () => {
    // Dynamic import to check the tool is registered
    const { ingestionTools } = await import('../../../src/tools/ingestion.js');

    expect(ingestionTools).toHaveProperty('ocr_convert_raw');
    expect(ingestionTools['ocr_convert_raw'].description).toContain('raw results');
    expect(ingestionTools['ocr_convert_raw'].handler).toBeDefined();
    expect(typeof ingestionTools['ocr_convert_raw'].handler).toBe('function');
  });

  it('should have correct inputSchema keys', async () => {
    const { ingestionTools } = await import('../../../src/tools/ingestion.js');
    const schema = ingestionTools['ocr_convert_raw'].inputSchema;

    expect(schema).toHaveProperty('file_path');
    expect(schema).toHaveProperty('ocr_mode');
    expect(schema).toHaveProperty('max_pages');
    expect(schema).toHaveProperty('page_range');
  });
});

describe('IngestFilesInput with file_urls', () => {
  it('should accept file_urls as optional array of URLs', async () => {
    const { IngestFilesInput } = await import('../../../src/utils/validation.js');
    const input = IngestFilesInput.parse({
      file_paths: ['/tmp/test.pdf'],
      file_urls: ['https://example.com/doc.pdf'],
    });
    expect(input.file_urls).toEqual(['https://example.com/doc.pdf']);
  });

  it('should accept input without file_urls', async () => {
    const { IngestFilesInput } = await import('../../../src/utils/validation.js');
    const input = IngestFilesInput.parse({
      file_paths: ['/tmp/test.pdf'],
    });
    expect(input.file_urls).toBeUndefined();
  });

  it('should reject invalid URLs in file_urls', async () => {
    const { IngestFilesInput } = await import('../../../src/utils/validation.js');
    expect(() =>
      IngestFilesInput.parse({
        file_paths: ['/tmp/test.pdf'],
        file_urls: ['not-a-url'],
      })
    ).toThrow();
  });
});
