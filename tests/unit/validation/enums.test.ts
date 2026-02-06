/**
 * Unit Tests for Validation Enums
 *
 * Tests OCRMode, ProcessingStatus, ItemType, and ConfigKey enums
 */

import { describe, it, expect } from 'vitest';
import {
  OCRMode,
  ProcessingStatus,
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

  describe('ProcessingStatus', () => {
    it('should accept valid statuses', () => {
      expect(ProcessingStatus.parse('pending')).toBe('pending');
      expect(ProcessingStatus.parse('processing')).toBe('processing');
      expect(ProcessingStatus.parse('complete')).toBe('complete');
      expect(ProcessingStatus.parse('failed')).toBe('failed');
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
      expect(ConfigKey.parse('log_level')).toBe('log_level');
    });
  });
});
