/**
 * Unit Tests for Config Schemas
 *
 * Tests ConfigGetInput, ConfigSetInput
 */

import { describe, it, expect } from 'vitest';
import {
  ConfigGetInput,
  ConfigSetInput,
} from './fixtures.js';

describe('Config Schemas', () => {
  describe('ConfigGetInput', () => {
    it('should accept empty input', () => {
      const result = ConfigGetInput.parse({});
      expect(result.key).toBeUndefined();
    });

    it('should accept specific key', () => {
      const result = ConfigGetInput.parse({ key: 'chunk_size' });
      expect(result.key).toBe('chunk_size');
    });

    it('should reject invalid key', () => {
      expect(() => ConfigGetInput.parse({ key: 'invalid_key' })).toThrow();
    });
  });

  describe('ConfigSetInput', () => {
    it('should accept string value', () => {
      const result = ConfigSetInput.parse({
        key: 'datalab_default_mode',
        value: 'accurate',
      });
      expect(result.value).toBe('accurate');
    });

    it('should accept number value', () => {
      const result = ConfigSetInput.parse({ key: 'chunk_size', value: 2000 });
      expect(result.value).toBe(2000);
    });

    it('should accept boolean value', () => {
      const result = ConfigSetInput.parse({ key: 'log_level', value: true });
      expect(result.value).toBe(true);
    });

    it('should require key', () => {
      expect(() => ConfigSetInput.parse({ value: 'test' })).toThrow();
    });

    it('should require value', () => {
      expect(() => ConfigSetInput.parse({ key: 'chunk_size' })).toThrow();
    });
  });
});
