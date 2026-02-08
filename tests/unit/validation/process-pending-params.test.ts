/**
 * ProcessPendingInput New Parameter Validation Tests
 *
 * Tests the 7 new optional Datalab parameters added to ProcessPendingInput:
 * max_pages, page_range, skip_cache, disable_image_extraction, extras,
 * page_schema, additional_config.
 */

import { describe, it, expect } from 'vitest';
import { ProcessPendingInput } from '../../../src/utils/validation.js';

describe('ProcessPendingInput new parameters', () => {
  describe('max_pages', () => {
    it('accepts valid max_pages', () => {
      const result = ProcessPendingInput.parse({ max_pages: 100 });
      expect(result.max_pages).toBe(100);
    });

    it('accepts max_pages=1', () => {
      const result = ProcessPendingInput.parse({ max_pages: 1 });
      expect(result.max_pages).toBe(1);
    });

    it('accepts max_pages=7000', () => {
      const result = ProcessPendingInput.parse({ max_pages: 7000 });
      expect(result.max_pages).toBe(7000);
    });

    it('rejects max_pages=0', () => {
      expect(() => ProcessPendingInput.parse({ max_pages: 0 })).toThrow();
    });

    it('rejects max_pages=7001', () => {
      expect(() => ProcessPendingInput.parse({ max_pages: 7001 })).toThrow();
    });

    it('rejects negative max_pages', () => {
      expect(() => ProcessPendingInput.parse({ max_pages: -1 })).toThrow();
    });

    it('rejects non-integer max_pages', () => {
      expect(() => ProcessPendingInput.parse({ max_pages: 1.5 })).toThrow();
    });

    it('is optional', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.max_pages).toBeUndefined();
    });
  });

  describe('page_range', () => {
    it('accepts valid page_range', () => {
      const result = ProcessPendingInput.parse({ page_range: '0-5,10' });
      expect(result.page_range).toBe('0-5,10');
    });

    it('accepts single page', () => {
      const result = ProcessPendingInput.parse({ page_range: '3' });
      expect(result.page_range).toBe('3');
    });

    it('accepts page range with spaces', () => {
      const result = ProcessPendingInput.parse({ page_range: '0-5, 10' });
      expect(result.page_range).toBe('0-5, 10');
    });

    it('rejects invalid characters', () => {
      expect(() => ProcessPendingInput.parse({ page_range: 'abc' })).toThrow();
    });

    it('rejects special characters', () => {
      expect(() => ProcessPendingInput.parse({ page_range: '1;DROP TABLE' })).toThrow();
    });

    it('is optional', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.page_range).toBeUndefined();
    });
  });

  describe('skip_cache', () => {
    it('accepts true', () => {
      const result = ProcessPendingInput.parse({ skip_cache: true });
      expect(result.skip_cache).toBe(true);
    });

    it('accepts false', () => {
      const result = ProcessPendingInput.parse({ skip_cache: false });
      expect(result.skip_cache).toBe(false);
    });

    it('is optional', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.skip_cache).toBeUndefined();
    });
  });

  describe('disable_image_extraction', () => {
    it('accepts true', () => {
      const result = ProcessPendingInput.parse({ disable_image_extraction: true });
      expect(result.disable_image_extraction).toBe(true);
    });

    it('accepts false', () => {
      const result = ProcessPendingInput.parse({ disable_image_extraction: false });
      expect(result.disable_image_extraction).toBe(false);
    });

    it('is optional', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.disable_image_extraction).toBeUndefined();
    });
  });

  describe('extras', () => {
    it('accepts valid extras array', () => {
      const result = ProcessPendingInput.parse({ extras: ['track_changes', 'chart_understanding'] });
      expect(result.extras).toEqual(['track_changes', 'chart_understanding']);
    });

    it('accepts all valid extras', () => {
      const allExtras = [
        'track_changes', 'chart_understanding', 'extract_links',
        'table_row_bboxes', 'infographic', 'new_block_types',
      ];
      const result = ProcessPendingInput.parse({ extras: allExtras });
      expect(result.extras).toEqual(allExtras);
    });

    it('accepts single extra', () => {
      const result = ProcessPendingInput.parse({ extras: ['extract_links'] });
      expect(result.extras).toEqual(['extract_links']);
    });

    it('accepts empty array', () => {
      const result = ProcessPendingInput.parse({ extras: [] });
      expect(result.extras).toEqual([]);
    });

    it('rejects invalid extras', () => {
      expect(() => ProcessPendingInput.parse({ extras: ['invalid_extra'] })).toThrow();
    });

    it('rejects mixed valid and invalid extras', () => {
      expect(() => ProcessPendingInput.parse({ extras: ['track_changes', 'bogus'] })).toThrow();
    });

    it('is optional', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.extras).toBeUndefined();
    });
  });

  describe('page_schema', () => {
    it('accepts JSON schema string', () => {
      const schema = '{"title": "string", "author": "string"}';
      const result = ProcessPendingInput.parse({ page_schema: schema });
      expect(result.page_schema).toBe(schema);
    });

    it('accepts empty string', () => {
      const result = ProcessPendingInput.parse({ page_schema: '' });
      expect(result.page_schema).toBe('');
    });

    it('is optional', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.page_schema).toBeUndefined();
    });
  });

  describe('additional_config', () => {
    it('accepts record of unknown values', () => {
      const config = { keep_pageheader_in_output: true, keep_pagefooter_in_output: false };
      const result = ProcessPendingInput.parse({ additional_config: config });
      expect(result.additional_config).toEqual(config);
    });

    it('accepts empty object', () => {
      const result = ProcessPendingInput.parse({ additional_config: {} });
      expect(result.additional_config).toEqual({});
    });

    it('accepts nested values', () => {
      const config = { nested: { key: 'value' }, number: 42 };
      const result = ProcessPendingInput.parse({ additional_config: config });
      expect(result.additional_config).toEqual(config);
    });

    it('is optional', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.additional_config).toBeUndefined();
    });
  });

  describe('defaults', () => {
    it('has correct defaults when no params given', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.max_concurrent).toBe(3);
      expect(result.ocr_mode).toBeUndefined();
      expect(result.max_pages).toBeUndefined();
      expect(result.page_range).toBeUndefined();
      expect(result.skip_cache).toBeUndefined();
      expect(result.disable_image_extraction).toBeUndefined();
      expect(result.extras).toBeUndefined();
      expect(result.page_schema).toBeUndefined();
      expect(result.additional_config).toBeUndefined();
    });
  });

  describe('combined parameters', () => {
    it('accepts all new parameters together', () => {
      const result = ProcessPendingInput.parse({
        max_concurrent: 5,
        ocr_mode: 'accurate',
        max_pages: 500,
        page_range: '0-10',
        skip_cache: true,
        disable_image_extraction: false,
        extras: ['track_changes', 'chart_understanding'],
        page_schema: '{"title": "string"}',
        additional_config: { keep_pageheader_in_output: true },
      });
      expect(result.max_concurrent).toBe(5);
      expect(result.ocr_mode).toBe('accurate');
      expect(result.max_pages).toBe(500);
      expect(result.page_range).toBe('0-10');
      expect(result.skip_cache).toBe(true);
      expect(result.disable_image_extraction).toBe(false);
      expect(result.extras).toEqual(['track_changes', 'chart_understanding']);
      expect(result.page_schema).toBe('{"title": "string"}');
      expect(result.additional_config).toEqual({ keep_pageheader_in_output: true });
    });
  });
});
