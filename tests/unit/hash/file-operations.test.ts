/**
 * Unit tests for file-based hash operations
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  fs,
  path,
  os,
  computeHash,
  hashFile,
  isValidHashFormat,
} from './helpers.js';

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

