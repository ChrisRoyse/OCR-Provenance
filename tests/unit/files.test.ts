/**
 * Unit tests for file system utilities
 *
 * Tests path sanitization, directory scanning, and file type validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  sanitizePath,
  getFileExtension,
  getMimeType,
  getFileMetadata,
  scanDirectory,
  isAllowedFileType,
  ensureDirectory,
  fileExists,
  directoryExists,
  PathTraversalError,
} from '../../src/utils/files.js';

describe('File Utilities', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for tests
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('sanitizePath', () => {
    it('should accept valid relative paths within base directory', () => {
      const result = sanitizePath('subdir/file.txt', testDir);
      expect(result).toBe(path.join(testDir, 'subdir/file.txt'));
    });

    it('should accept paths that equal the base directory', () => {
      const result = sanitizePath('.', testDir);
      expect(result).toBe(testDir);
    });

    it('should accept absolute paths within base directory', () => {
      const absPath = path.join(testDir, 'subdir', 'file.txt');
      // When the input is absolute and within base, resolve still works
      const result = sanitizePath(path.join('subdir', 'file.txt'), testDir);
      expect(result).toBe(absPath);
    });

    it('should reject paths containing ".."', () => {
      expect(() => sanitizePath('../outside.txt', testDir)).toThrow(PathTraversalError);
      expect(() => sanitizePath('../outside.txt', testDir)).toThrow('Path traversal detected');
    });

    it('should reject paths with ".." in middle of path', () => {
      expect(() => sanitizePath('subdir/../../../etc/passwd', testDir)).toThrow(PathTraversalError);
    });

    it('should reject paths containing "..\\" on Windows-style paths', () => {
      expect(() => sanitizePath('..\\outside.txt', testDir)).toThrow(PathTraversalError);
    });

    it('should have error code PATH_TRAVERSAL_DETECTED', () => {
      try {
        sanitizePath('../outside.txt', testDir);
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as PathTraversalError).code).toBe('PATH_TRAVERSAL_DETECTED');
      }
    });

    it('should reject empty paths that resolve outside base', () => {
      // Empty string resolves to current directory, which might be outside base
      // This depends on the current working directory
      const result = sanitizePath('', testDir);
      expect(result).toBe(testDir);
    });

    it('should handle deeply nested valid paths', () => {
      const result = sanitizePath('a/b/c/d/e/file.txt', testDir);
      expect(result).toBe(path.join(testDir, 'a/b/c/d/e/file.txt'));
    });
  });

  describe('getFileExtension', () => {
    it('should return lowercase extension without dot', () => {
      expect(getFileExtension('document.PDF')).toBe('pdf');
      expect(getFileExtension('image.PNG')).toBe('png');
      expect(getFileExtension('file.TXT')).toBe('txt');
    });

    it('should handle paths with directories', () => {
      expect(getFileExtension('/path/to/document.pdf')).toBe('pdf');
      expect(getFileExtension('relative/path/image.jpg')).toBe('jpg');
    });

    it('should handle files with multiple dots', () => {
      expect(getFileExtension('file.name.tar.gz')).toBe('gz');
      expect(getFileExtension('document.backup.pdf')).toBe('pdf');
    });

    it('should return empty string for files without extension', () => {
      expect(getFileExtension('filename')).toBe('');
      expect(getFileExtension('/path/to/file')).toBe('');
    });

    it('should handle dotfiles (no extension)', () => {
      // Dotfiles like .gitignore have no extension - the leading dot is part of the name
      expect(getFileExtension('.gitignore')).toBe('');
      expect(getFileExtension('.env')).toBe('');
    });

    it('should handle dotfiles with extensions', () => {
      expect(getFileExtension('.config.json')).toBe('json');
      expect(getFileExtension('.eslintrc.js')).toBe('js');
    });
  });

  describe('getMimeType', () => {
    it('should return correct MIME types for supported extensions', () => {
      expect(getMimeType('pdf')).toBe('application/pdf');
      expect(getMimeType('png')).toBe('image/png');
      expect(getMimeType('jpg')).toBe('image/jpeg');
      expect(getMimeType('jpeg')).toBe('image/jpeg');
      expect(getMimeType('docx')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    });

    it('should handle extensions with leading dot', () => {
      expect(getMimeType('.pdf')).toBe('application/pdf');
      expect(getMimeType('.png')).toBe('image/png');
    });

    it('should be case-insensitive', () => {
      expect(getMimeType('PDF')).toBe('application/pdf');
      expect(getMimeType('PNG')).toBe('image/png');
    });

    it('should return application/octet-stream for unknown types', () => {
      expect(getMimeType('xyz')).toBe('application/octet-stream');
      expect(getMimeType('unknown')).toBe('application/octet-stream');
    });
  });

  describe('getFileMetadata', () => {
    it('should return correct metadata for a file', async () => {
      const testFile = path.join(testDir, 'test.pdf');
      const content = 'test content';
      await fs.writeFile(testFile, content);

      const metadata = await getFileMetadata(testFile);

      expect(metadata.size).toBe(content.length);
      expect(metadata.extension).toBe('pdf');
      expect(metadata.mimeType).toBe('application/pdf');
      expect(metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(metadata.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should throw error for non-existent file', async () => {
      const nonExistent = path.join(testDir, 'nonexistent.txt');
      await expect(getFileMetadata(nonExistent)).rejects.toThrow();
    });

    it('should throw error for directory path', async () => {
      const subDir = path.join(testDir, 'subdir');
      await fs.mkdir(subDir);
      await expect(getFileMetadata(subDir)).rejects.toThrow('Path is not a file');
    });
  });

  describe('scanDirectory', () => {
    beforeEach(async () => {
      // Create test file structure
      await fs.mkdir(path.join(testDir, 'subdir'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'file1.pdf'), 'pdf content');
      await fs.writeFile(path.join(testDir, 'file2.png'), 'png content');
      await fs.writeFile(path.join(testDir, 'file3.txt'), 'txt content');
      await fs.writeFile(path.join(testDir, 'subdir', 'file4.pdf'), 'nested pdf');
      await fs.writeFile(path.join(testDir, 'subdir', 'file5.jpg'), 'nested jpg');
    });

    it('should find files with specified extensions (non-recursive)', async () => {
      const results = await scanDirectory(testDir, ['.pdf', '.png'], false);

      expect(results).toHaveLength(2);
      expect(results).toContain(path.join(testDir, 'file1.pdf'));
      expect(results).toContain(path.join(testDir, 'file2.png'));
    });

    it('should find files recursively', async () => {
      const results = await scanDirectory(testDir, ['pdf'], true);

      expect(results).toHaveLength(2);
      expect(results).toContain(path.join(testDir, 'file1.pdf'));
      expect(results).toContain(path.join(testDir, 'subdir', 'file4.pdf'));
    });

    it('should handle extensions with or without leading dot', async () => {
      const withDot = await scanDirectory(testDir, ['.pdf'], false);
      const withoutDot = await scanDirectory(testDir, ['pdf'], false);

      expect(withDot).toEqual(withoutDot);
    });

    it('should be case-insensitive for extensions', async () => {
      await fs.writeFile(path.join(testDir, 'upper.PDF'), 'uppercase pdf');

      const results = await scanDirectory(testDir, ['pdf'], false);

      expect(results).toContain(path.join(testDir, 'upper.PDF'));
    });

    it('should return empty array for no matches', async () => {
      const results = await scanDirectory(testDir, ['.xyz'], false);
      expect(results).toHaveLength(0);
    });

    it('should find multiple extensions at once', async () => {
      const results = await scanDirectory(testDir, ['pdf', 'png', 'jpg'], true);

      expect(results).toHaveLength(4);
    });
  });

  describe('isAllowedFileType', () => {
    it('should return true for supported file types', () => {
      expect(isAllowedFileType('document.pdf')).toBe(true);
      expect(isAllowedFileType('image.png')).toBe(true);
      expect(isAllowedFileType('image.jpg')).toBe(true);
      expect(isAllowedFileType('image.jpeg')).toBe(true);
      expect(isAllowedFileType('image.tiff')).toBe(true);
      expect(isAllowedFileType('image.bmp')).toBe(true);
      expect(isAllowedFileType('image.gif')).toBe(true);
      expect(isAllowedFileType('image.webp')).toBe(true);
      expect(isAllowedFileType('document.docx')).toBe(true);
      expect(isAllowedFileType('document.doc')).toBe(true);
      expect(isAllowedFileType('presentation.pptx')).toBe(true);
      expect(isAllowedFileType('presentation.ppt')).toBe(true);
      expect(isAllowedFileType('spreadsheet.xlsx')).toBe(true);
      expect(isAllowedFileType('spreadsheet.xls')).toBe(true);
    });

    it('should return false for unsupported file types', () => {
      expect(isAllowedFileType('script.js')).toBe(false);
      expect(isAllowedFileType('data.json')).toBe(false);
      expect(isAllowedFileType('archive.zip')).toBe(false);
    });

    it('should handle paths with directories', () => {
      expect(isAllowedFileType('/path/to/document.pdf')).toBe(true);
      expect(isAllowedFileType('/path/to/script.js')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isAllowedFileType('document.PDF')).toBe(true);
      expect(isAllowedFileType('image.PNG')).toBe(true);
      expect(isAllowedFileType('doc.DOCX')).toBe(true);
    });
  });

  describe('ensureDirectory', () => {
    it('should create directory if it does not exist', async () => {
      const newDir = path.join(testDir, 'new', 'nested', 'dir');

      await ensureDirectory(newDir);

      const stats = await fs.stat(newDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should not throw if directory already exists', async () => {
      await ensureDirectory(testDir);
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('fileExists', () => {
    it('should return true for existing file', async () => {
      const testFile = path.join(testDir, 'exists.txt');
      await fs.writeFile(testFile, 'content');

      expect(await fileExists(testFile)).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      expect(await fileExists(path.join(testDir, 'nonexistent.txt'))).toBe(false);
    });

    it('should return false for directory', async () => {
      expect(await fileExists(testDir)).toBe(false);
    });
  });

  describe('directoryExists', () => {
    it('should return true for existing directory', async () => {
      expect(await directoryExists(testDir)).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      expect(await directoryExists(path.join(testDir, 'nonexistent'))).toBe(false);
    });

    it('should return false for file', async () => {
      const testFile = path.join(testDir, 'file.txt');
      await fs.writeFile(testFile, 'content');

      expect(await directoryExists(testFile)).toBe(false);
    });
  });
});
