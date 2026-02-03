/**
 * Unit Tests for Validation Helper Functions
 *
 * Tests validateInput and safeValidateInput helper functions
 */

import { describe, it, expect } from 'vitest';
import {
  validateInput,
  safeValidateInput,
  ValidationError,
  DatabaseCreateInput,
} from './fixtures.js';

describe('validateInput', () => {
  it('should return validated data for valid input', () => {
    const input = { name: 'test_db' };
    const result = validateInput(DatabaseCreateInput, input);
    expect(result.name).toBe('test_db');
  });

  it('should throw ValidationError for invalid input', () => {
    const input = { name: '' };
    expect(() => validateInput(DatabaseCreateInput, input)).toThrow(ValidationError);
  });

  it('should include field path in error message', () => {
    const input = { name: '' };
    expect(() => validateInput(DatabaseCreateInput, input)).toThrow('name:');
  });
});

describe('safeValidateInput', () => {
  it('should return success: true for valid input', () => {
    const input = { name: 'test_db' };
    const result = safeValidateInput(DatabaseCreateInput, input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('test_db');
    }
  });

  it('should return success: false for invalid input', () => {
    const input = { name: '' };
    const result = safeValidateInput(DatabaseCreateInput, input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });
});
