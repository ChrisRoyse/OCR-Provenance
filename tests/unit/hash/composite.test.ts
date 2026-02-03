/**
 * Unit tests for composite hash computation
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import {
  describe,
  it,
  expect,
  computeHash,
  computeCompositeHash,
  isValidHashFormat,
} from './helpers.js';

describe('computeCompositeHash', () => {
  it('should compute hash of multiple strings', () => {
    const hash = computeCompositeHash(['part1', 'part2', 'part3']);
    expect(isValidHashFormat(hash)).toBe(true);
  });

  it('should produce different hash for different order', () => {
    const hash1 = computeCompositeHash(['a', 'b']);
    const hash2 = computeCompositeHash(['b', 'a']);
    expect(hash1).not.toBe(hash2);
  });

  it('should be equivalent to concatenated hash', () => {
    const parts = ['hello', ' ', 'world'];
    const compositeHash = computeCompositeHash(parts);
    const concatenatedHash = computeHash('hello world');
    expect(compositeHash).toBe(concatenatedHash);
  });

  it('should handle empty array', () => {
    const hash = computeCompositeHash([]);
    // Should be hash of empty string
    expect(hash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should handle mixed string and Buffer', () => {
    const hash1 = computeCompositeHash(['hello', Buffer.from(' '), 'world']);
    const hash2 = computeHash('hello world');
    expect(hash1).toBe(hash2);
  });
});
