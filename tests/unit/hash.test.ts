/**
 * Unit tests for SHA-256 hash utilities
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  computeHash,
  hashFile,
  verifyHash,
  verifyFileHash,
  isValidHashFormat,
  extractHashHex,
  compareHashes,
  computeCompositeHash,
  verifyHashDetailed,
  HASH_PREFIX,
  HASH_HEX_LENGTH,
  HASH_TOTAL_LENGTH,
  HASH_PATTERN,
} from '../../src/utils/hash.js';

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

describe('isValidHashFormat', () => {
  it('should return true for valid hash format', () => {
    expect(
      isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    ).toBe(true);
  });

  it('should return true for hash with all zeros', () => {
    expect(
      isValidHashFormat('sha256:0000000000000000000000000000000000000000000000000000000000000000')
    ).toBe(true);
  });

  it("should return true for hash with all f's", () => {
    expect(
      isValidHashFormat('sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
    ).toBe(true);
  });

  it('should return false for wrong prefix', () => {
    expect(
      isValidHashFormat('md5:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    ).toBe(false);
    expect(
      isValidHashFormat('SHA256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    ).toBe(false);
  });

  it('should return false for too short hash', () => {
    expect(isValidHashFormat('sha256:abc123')).toBe(false);
    expect(isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e')).toBe(false);
  });

  it('should return false for too long hash', () => {
    expect(
      isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824ff')
    ).toBe(false);
  });

  it('should return false for uppercase hex', () => {
    expect(
      isValidHashFormat('sha256:2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824')
    ).toBe(false);
  });

  it('should return false for non-hex characters', () => {
    expect(
      isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b982g')
    ).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isValidHashFormat('')).toBe(false);
  });

  it('should return false for just prefix', () => {
    expect(isValidHashFormat('sha256:')).toBe(false);
  });

  it('should return false for non-string input', () => {
    // @ts-expect-error Testing invalid input
    expect(isValidHashFormat(123)).toBe(false);
    // @ts-expect-error Testing invalid input
    expect(isValidHashFormat(null)).toBe(false);
    // @ts-expect-error Testing invalid input
    expect(isValidHashFormat(undefined)).toBe(false);
  });
});

describe('extractHashHex', () => {
  it('should extract hex portion from valid hash', () => {
    const hash = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    const hex = extractHashHex(hash);
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(hex.length).toBe(64);
  });

  it('should throw for invalid hash format', () => {
    expect(() => extractHashHex('invalid')).toThrow('Invalid hash format');
    expect(() => extractHashHex('sha256:short')).toThrow('Invalid hash format');
  });

  it('should throw with descriptive error message', () => {
    expect(() => extractHashHex('bad:hash')).toThrow("Expected 'sha256:' + 64 hex characters");
  });
});

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

describe('hashFile', () => {
  let testDir: string;
  let testFilePath: string;
  const testContent = 'This is test file content for hashing.';

  beforeAll(async () => {
    // Create temporary test directory and file
    testDir = path.join(os.tmpdir(), `hash-test-${String(Date.now())}`);
    await fs.promises.mkdir(testDir, { recursive: true });
    testFilePath = path.join(testDir, 'test-file.txt');
    await fs.promises.writeFile(testFilePath, testContent);
  });

  afterAll(async () => {
    // Cleanup test files
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should hash file content correctly', async () => {
    const fileHash = await hashFile(testFilePath);
    const contentHash = computeHash(testContent);
    expect(fileHash).toBe(contentHash);
  });

  it('should produce valid hash format', async () => {
    const hash = await hashFile(testFilePath);
    expect(isValidHashFormat(hash)).toBe(true);
  });

  it('should throw for non-existent file', async () => {
    const nonExistentPath = path.join(testDir, 'non-existent.txt');
    await expect(hashFile(nonExistentPath)).rejects.toThrow('File not found');
  });

  it('should throw for relative path', async () => {
    await expect(hashFile('relative/path/file.txt')).rejects.toThrow('Path must be absolute');
  });

  it('should throw for directory path', async () => {
    await expect(hashFile(testDir)).rejects.toThrow('Path is not a file');
  });

  it('should produce consistent results on multiple reads', async () => {
    const hash1 = await hashFile(testFilePath);
    const hash2 = await hashFile(testFilePath);
    expect(hash1).toBe(hash2);
  });
});

describe('verifyFileHash', () => {
  let testDir: string;
  let testFilePath: string;
  const testContent = 'File content for verification test';

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `hash-verify-test-${String(Date.now())}`);
    await fs.promises.mkdir(testDir, { recursive: true });
    testFilePath = path.join(testDir, 'verify-test.txt');
    await fs.promises.writeFile(testFilePath, testContent);
  });

  afterAll(async () => {
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should return true for matching hash', async () => {
    const expectedHash = computeHash(testContent);
    const result = await verifyFileHash(testFilePath, expectedHash);
    expect(result).toBe(true);
  });

  it('should return false for non-matching hash', async () => {
    const wrongHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const result = await verifyFileHash(testFilePath, wrongHash);
    expect(result).toBe(false);
  });

  it('should return false for invalid hash format', async () => {
    const result = await verifyFileHash(testFilePath, 'invalid-hash');
    expect(result).toBe(false);
  });

  it('should detect file content modification', async () => {
    // Get original hash
    const originalHash = await hashFile(testFilePath);

    // Modify file
    const modifiedPath = path.join(testDir, 'modified-test.txt');
    await fs.promises.writeFile(modifiedPath, testContent + ' MODIFIED');

    // Verify original hash no longer matches modified content
    const result = await verifyFileHash(modifiedPath, originalHash);
    expect(result).toBe(false);
  });
});

describe('Integration: Provenance Use Cases', () => {
  it('should support document hash tracking', () => {
    const documentContent = 'This is a PDF document content extracted via OCR.';
    const documentHash = computeHash(documentContent);

    // Verify format matches provenance record requirements
    expect(isValidHashFormat(documentHash)).toBe(true);
    expect(documentHash.startsWith('sha256:')).toBe(true);
  });

  it('should support chunk hash computation', () => {
    const ocrText = 'Full OCR extracted text from document.';
    const chunk1 = 'Full OCR extracted';
    const chunk2 = 'text from document.';

    const ocrHash = computeHash(ocrText);
    const chunk1Hash = computeHash(chunk1);
    const chunk2Hash = computeHash(chunk2);

    // Each should have unique valid hash
    expect(isValidHashFormat(ocrHash)).toBe(true);
    expect(isValidHashFormat(chunk1Hash)).toBe(true);
    expect(isValidHashFormat(chunk2Hash)).toBe(true);

    // All should be different
    expect(ocrHash).not.toBe(chunk1Hash);
    expect(ocrHash).not.toBe(chunk2Hash);
    expect(chunk1Hash).not.toBe(chunk2Hash);
  });

  it('should support input/output hash verification', () => {
    const inputText = 'Input to processor';
    const outputText = 'Processed output';

    const inputHash = computeHash(inputText);
    const outputHash = computeHash(outputText);

    // Simulate verifying processing did not tamper with input
    expect(verifyHash(inputText, inputHash)).toBe(true);
    expect(verifyHash(outputText, outputHash)).toBe(true);
  });

  it('should detect tampered content in provenance chain', () => {
    const originalContent = 'Original document content that must not change.';
    const storedHash = computeHash(originalContent);

    // Simulate tampered content
    const tamperedContent = 'Original document content that must not change!'; // Added !

    // Verification should fail
    expect(verifyHash(tamperedContent, storedHash)).toBe(false);

    // Detailed verification provides forensic info
    const result = verifyHashDetailed(tamperedContent, storedHash);
    expect(result.valid).toBe(false);
    expect(result.expected).toBe(storedHash);
    expect(result.computed).not.toBe(storedHash);
  });
});
