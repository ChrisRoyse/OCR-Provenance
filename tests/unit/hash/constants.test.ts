/**
 * Unit tests for hash constants
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import {
  describe,
  it,
  expect,
  HASH_PREFIX,
  HASH_HEX_LENGTH,
  HASH_TOTAL_LENGTH,
  HASH_PATTERN,
} from './helpers.js';

describe('Hash Constants', () => {
  it('should have correct hash prefix', () => {
    expect(HASH_PREFIX).toBe('sha256:');
  });

  it('should have correct hex length for SHA-256', () => {
    expect(HASH_HEX_LENGTH).toBe(64);
  });

  it('should have correct total length', () => {
    expect(HASH_TOTAL_LENGTH).toBe(7 + 64); // 'sha256:' + 64 hex chars
  });

  it('should have valid hash pattern regex', () => {
    expect(
      HASH_PATTERN.test('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    ).toBe(true);
    expect(HASH_PATTERN.test('sha256:abc123')).toBe(false);
  });
});
