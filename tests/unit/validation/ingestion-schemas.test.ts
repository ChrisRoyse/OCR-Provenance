/**
 * Unit Tests for Document Ingestion Schemas
 *
 * Tests IngestDirectoryInput, IngestFilesInput, ProcessPendingInput, OCRStatusInput
 */

import { describe, it, expect } from 'vitest';
import {
  IngestDirectoryInput,
  IngestFilesInput,
  ProcessPendingInput,
  OCRStatusInput,
  DEFAULT_FILE_TYPES,
} from './fixtures.js';

describe('Document Ingestion Schemas', () => {
  describe('IngestDirectoryInput', () => {
    it('should accept valid directory path', () => {
      const result = IngestDirectoryInput.parse({
        directory_path: '/home/user/docs',
      });
      expect(result.directory_path).toBe('/home/user/docs');
    });

    it('should provide defaults', () => {
      const result = IngestDirectoryInput.parse({
        directory_path: '/home/user/docs',
      });
      expect(result.recursive).toBe(true);
      expect(result.ocr_mode).toBe('balanced');
      expect(result.auto_process).toBe(false);
      expect(result.file_types).toEqual(DEFAULT_FILE_TYPES);
    });

    it('should reject empty directory path', () => {
      expect(() => IngestDirectoryInput.parse({ directory_path: '' })).toThrow('required');
    });

    it('should accept custom file types', () => {
      const result = IngestDirectoryInput.parse({
        directory_path: '/docs',
        file_types: ['pdf', 'docx'],
      });
      expect(result.file_types).toEqual(['pdf', 'docx']);
    });
  });

  describe('IngestFilesInput', () => {
    it('should accept valid file paths', () => {
      const result = IngestFilesInput.parse({
        file_paths: ['/home/user/doc.pdf', '/home/user/image.png'],
      });
      expect(result.file_paths).toHaveLength(2);
    });

    it('should reject empty file_paths array', () => {
      expect(() => IngestFilesInput.parse({ file_paths: [] })).toThrow('At least one');
    });

    it('should reject array with empty strings', () => {
      expect(() => IngestFilesInput.parse({ file_paths: [''] })).toThrow('empty');
    });
  });

  describe('ProcessPendingInput', () => {
    it('should provide defaults', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.max_concurrent).toBe(3);
    });

    it('should accept valid max_concurrent', () => {
      const result = ProcessPendingInput.parse({ max_concurrent: 5 });
      expect(result.max_concurrent).toBe(5);
    });

    it('should reject max_concurrent below 1', () => {
      expect(() => ProcessPendingInput.parse({ max_concurrent: 0 })).toThrow();
    });

    it('should reject max_concurrent above 10', () => {
      expect(() => ProcessPendingInput.parse({ max_concurrent: 11 })).toThrow();
    });
  });

  describe('OCRStatusInput', () => {
    it('should provide defaults', () => {
      const result = OCRStatusInput.parse({});
      expect(result.status_filter).toBe('all');
    });

    it('should accept valid status filter', () => {
      const result = OCRStatusInput.parse({ status_filter: 'pending' });
      expect(result.status_filter).toBe('pending');
    });
  });
});
