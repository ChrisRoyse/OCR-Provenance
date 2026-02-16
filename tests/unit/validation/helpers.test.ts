/**
 * Unit Tests for Validation Helper Functions
 *
 * Tests validateInput helper function
 */

import { describe, it, expect } from 'vitest';
import { validateInput, ValidationError, DatabaseCreateInput } from './fixtures.js';

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
