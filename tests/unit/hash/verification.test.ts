/**
 * Unit tests for hash verification functions
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import {
  describe,
  it,
  expect,
  computeHash,
  verifyHash,
  verifyHashDetailed,
  compareHashes,
} from './helpers.js';

describe('verifyHash', () => {
  it('should return true for matching hash', () => {
    const content = 'hello';
    const hash = computeHash(content);
    expect(verifyHash(content, hash)).toBe(true);
  });

  it('should return false for non-matching hash', () => {
    const content = 'hello';
    const wrongHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    expect(verifyHash(content, wrongHash)).toBe(false);
  });

  it('should return false for invalid hash format', () => {
    expect(verifyHash('content', 'invalid-hash')).toBe(false);
    expect(verifyHash('content', 'sha256:short')).toBe(false);
  });

  it('should detect single character change in content', () => {
    const original = 'hello world';
    const modified = 'hello World'; // Capital W
    const hash = computeHash(original);

    expect(verifyHash(original, hash)).toBe(true);
    expect(verifyHash(modified, hash)).toBe(false);
  });

  it('should work with Buffer content', () => {
    const buffer = Buffer.from([1, 2, 3, 4, 5]);
    const hash = computeHash(buffer);
    expect(verifyHash(buffer, hash)).toBe(true);
  });
});

describe('verifyHashDetailed', () => {
  it('should return detailed result for valid match', () => {
    const content = 'test content';
    const hash = computeHash(content);
    const result = verifyHashDetailed(content, hash);

    expect(result.valid).toBe(true);
    expect(result.formatValid).toBe(true);
    expect(result.expected).toBe(hash);
    expect(result.computed).toBe(hash);
  });

  it('should return detailed result for mismatch', () => {
    const content = 'test content';
    const wrongHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const result = verifyHashDetailed(content, wrongHash);

    expect(result.valid).toBe(false);
    expect(result.formatValid).toBe(true);
    expect(result.expected).toBe(wrongHash);
    expect(result.computed).not.toBe(wrongHash);
  });

  it('should indicate invalid format in result', () => {
    const result = verifyHashDetailed('content', 'invalid');

    expect(result.valid).toBe(false);
    expect(result.formatValid).toBe(false);
    expect(result.expected).toBe('invalid');
  });
});

describe('compareHashes', () => {
  it('should return true for identical hashes', () => {
    const hash = computeHash('test');
    expect(compareHashes(hash, hash)).toBe(true);
  });

  it('should return false for different hashes', () => {
    const hash1 = computeHash('test1');
    const hash2 = computeHash('test2');
    expect(compareHashes(hash1, hash2)).toBe(false);
  });

  it('should return false if either hash is invalid format', () => {
    const validHash = computeHash('test');
    expect(compareHashes(validHash, 'invalid')).toBe(false);
    expect(compareHashes('invalid', validHash)).toBe(false);
    expect(compareHashes('invalid', 'invalid')).toBe(false);
  });
});
