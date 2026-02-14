/**
 * Unit Tests for Validation Enums
 *
 * Tests OCRMode, ItemType, and ConfigKey enums
 */

import { describe, it, expect } from 'vitest';
import {
  OCRMode,
  ItemType,
  ConfigKey,
} from './fixtures.js';

describe('Enums', () => {
  describe('OCRMode', () => {
    it('should accept valid modes', () => {
      expect(OCRMode.parse('fast')).toBe('fast');
      expect(OCRMode.parse('balanced')).toBe('balanced');
      expect(OCRMode.parse('accurate')).toBe('accurate');
    });

    it('should reject invalid modes', () => {
      expect(() => OCRMode.parse('invalid')).toThrow();
    });
  });

  describe('ItemType', () => {
    it('should accept valid item types', () => {
      expect(ItemType.parse('document')).toBe('document');
      expect(ItemType.parse('ocr_result')).toBe('ocr_result');
      expect(ItemType.parse('chunk')).toBe('chunk');
      expect(ItemType.parse('embedding')).toBe('embedding');
      expect(ItemType.parse('auto')).toBe('auto');
    });
  });

  describe('ConfigKey', () => {
    it('should accept valid config keys', () => {
      expect(ConfigKey.parse('datalab_default_mode')).toBe('datalab_default_mode');
      expect(ConfigKey.parse('chunk_size')).toBe('chunk_size');
      expect(ConfigKey.parse('chunk_overlap_percent')).toBe('chunk_overlap_percent');
    });
  });
});
