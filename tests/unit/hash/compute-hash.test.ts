/**
 * Unit tests for computeHash function
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import {
  describe,
  it,
  expect,
  computeHash,
  isValidHashFormat,
  HASH_TOTAL_LENGTH,
} from './helpers.js';

describe('computeHash', () => {
  it('should compute correct hash for known string', () => {
    // Known SHA-256 hash for 'hello'
    const hash = computeHash('hello');
    expect(hash).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should produce consistent hashes for same input', () => {
    const content = 'test content for hashing';
    const hash1 = computeHash(content);
    const hash2 = computeHash(content);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = computeHash('content A');
    const hash2 = computeHash('content B');
    expect(hash1).not.toBe(hash2);
  });

  it('should start with sha256: prefix', () => {
    const hash = computeHash('any content');
    expect(hash.startsWith('sha256:')).toBe(true);
  });

  it('should have correct total length', () => {
    const hash = computeHash('test');
    expect(hash.length).toBe(HASH_TOTAL_LENGTH);
  });

  it('should produce lowercase hex output', () => {
    const hash = computeHash('TEST');
    const hexPart = hash.slice(7);
    expect(hexPart).toBe(hexPart.toLowerCase());
  });

  it('should handle empty string', () => {
    // SHA-256 of empty string is known
    const hash = computeHash('');
    expect(hash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should handle Buffer input', () => {
    const buffer = Buffer.from('hello');
    const stringHash = computeHash('hello');
    const bufferHash = computeHash(buffer);
    expect(bufferHash).toBe(stringHash);
  });

  it('should handle binary data in Buffer', () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const hash = computeHash(binaryData);
    expect(isValidHashFormat(hash)).toBe(true);
  });

  it('should handle Unicode content correctly', () => {
    const unicodeContent = 'Hello, World';
    const hash = computeHash(unicodeContent);
    expect(isValidHashFormat(hash)).toBe(true);

    // Verify consistency with Unicode
    const hash2 = computeHash(unicodeContent);
    expect(hash).toBe(hash2);
  });

  it('should handle emoji and special characters', () => {
    const emojiContent = 'Test with emojis and symbols';
    const hash1 = computeHash(emojiContent);
    const hash2 = computeHash(emojiContent);
    expect(hash1).toBe(hash2);
    expect(isValidHashFormat(hash1)).toBe(true);
  });

  it('should handle multi-byte UTF-8 characters', () => {
    const multiByteContent = 'Chinese Japanese Korean';
    const hash = computeHash(multiByteContent);
    expect(isValidHashFormat(hash)).toBe(true);
  });

  it('should handle very long strings', () => {
    const longContent = 'x'.repeat(1000000); // 1MB of 'x'
    const hash = computeHash(longContent);
    expect(isValidHashFormat(hash)).toBe(true);
  });

  it('should handle newlines consistently', () => {
    const unixNewlines = 'line1\nline2\nline3';
    const windowsNewlines = 'line1\r\nline2\r\nline3';

    const hash1 = computeHash(unixNewlines);
    const hash2 = computeHash(windowsNewlines);

    // Different newline styles should produce different hashes
    expect(hash1).not.toBe(hash2);
    expect(isValidHashFormat(hash1)).toBe(true);
    expect(isValidHashFormat(hash2)).toBe(true);
  });
});
