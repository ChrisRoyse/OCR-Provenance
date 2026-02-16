/**
 * OCR Errors Unit Tests
 *
 * Tests error classes and mapPythonError function.
 * These tests do not require API calls - pure unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  OCRError,
  OCRAPIError,
  OCRRateLimitError,
  OCRTimeoutError,
  OCRFileError,
  OCRAuthenticationError,
  mapPythonError,
} from '../../../src/services/ocr/errors.js';

describe('OCR Errors', () => {
  describe('OCRError', () => {
    it('stores category and requestId', () => {
      const error = new OCRError('Test error', 'OCR_API_ERROR', 'req-123');

      expect(error.message).toBe('Test error');
      expect(error.category).toBe('OCR_API_ERROR');
      expect(error.requestId).toBe('req-123');
    });

    it('extends Error with correct name', () => {
      const error = new OCRError('Test', 'OCR_TIMEOUT');

      expect(error instanceof Error).toBe(true);
      expect(error.name).toBe('OCRError');
    });

    it('allows undefined requestId', () => {
      const error = new OCRError('Test', 'OCR_FILE_ERROR');

      expect(error.requestId).toBeUndefined();
    });
  });

  describe('OCRAPIError', () => {
    it('sets OCR_SERVER_ERROR for status >= 500', () => {
      const error = new OCRAPIError('Server error', 500);
      expect(error.category).toBe('OCR_SERVER_ERROR');
      expect(error.statusCode).toBe(500);

      const error502 = new OCRAPIError('Bad gateway', 502);
      expect(error502.category).toBe('OCR_SERVER_ERROR');
    });

    it('sets OCR_API_ERROR for status < 500', () => {
      const error = new OCRAPIError('Bad request', 400);
      expect(error.category).toBe('OCR_API_ERROR');
      expect(error.statusCode).toBe(400);

      const error404 = new OCRAPIError('Not found', 404);
      expect(error404.category).toBe('OCR_API_ERROR');
    });

    it('extends OCRError with correct name', () => {
      const error = new OCRAPIError('Test', 500);

      expect(error instanceof OCRError).toBe(true);
      expect(error.name).toBe('OCRAPIError');
    });

    it('stores requestId', () => {
      const error = new OCRAPIError('Test', 500, 'req-abc');
      expect(error.requestId).toBe('req-abc');
    });
  });

  describe('OCRRateLimitError', () => {
    it('uses default values', () => {
      const error = new OCRRateLimitError();

      expect(error.message).toBe('Rate limit exceeded');
      expect(error.category).toBe('OCR_RATE_LIMIT');
      expect(error.retryAfter).toBe(60);
    });

    it('accepts custom values', () => {
      const error = new OCRRateLimitError('Custom message', 120);

      expect(error.message).toBe('Custom message');
      expect(error.retryAfter).toBe(120);
    });

    it('extends OCRError with correct name', () => {
      const error = new OCRRateLimitError();

      expect(error instanceof OCRError).toBe(true);
      expect(error.name).toBe('OCRRateLimitError');
    });
  });

  describe('OCRTimeoutError', () => {
    it('stores message and requestId', () => {
      const error = new OCRTimeoutError('Timeout after 30s', 'req-xyz');

      expect(error.message).toBe('Timeout after 30s');
      expect(error.category).toBe('OCR_TIMEOUT');
      expect(error.requestId).toBe('req-xyz');
    });

    it('extends OCRError with correct name', () => {
      const error = new OCRTimeoutError('Test');

      expect(error instanceof OCRError).toBe(true);
      expect(error.name).toBe('OCRTimeoutError');
    });
  });

  describe('OCRFileError', () => {
    it('stores filePath', () => {
      const error = new OCRFileError('File not found', '/path/to/file.pdf');

      expect(error.message).toBe('File not found');
      expect(error.category).toBe('OCR_FILE_ERROR');
      expect(error.filePath).toBe('/path/to/file.pdf');
    });

    it('extends OCRError with correct name', () => {
      const error = new OCRFileError('Test', '/test');

      expect(error instanceof OCRError).toBe(true);
      expect(error.name).toBe('OCRFileError');
    });
  });

  describe('OCRAuthenticationError', () => {
    it('stores statusCode', () => {
      const error = new OCRAuthenticationError('Unauthorized', 401);

      expect(error.message).toBe('Unauthorized');
      expect(error.category).toBe('OCR_AUTHENTICATION_ERROR');
      expect(error.statusCode).toBe(401);
    });

    it('extends OCRError with correct name', () => {
      const error = new OCRAuthenticationError('Test', 403);

      expect(error instanceof OCRError).toBe(true);
      expect(error.name).toBe('OCRAuthenticationError');
    });
  });

  describe('mapPythonError', () => {
    it('maps OCR_API_ERROR correctly', () => {
      const error = mapPythonError('OCR_API_ERROR', 'Bad request', { status_code: 400 });

      expect(error instanceof OCRAPIError).toBe(true);
      expect((error as OCRAPIError).statusCode).toBe(400);
    });

    it('maps OCR_SERVER_ERROR correctly', () => {
      const error = mapPythonError('OCR_SERVER_ERROR', 'Internal error', {
        status_code: 500,
        request_id: 'req-123',
      });

      expect(error instanceof OCRAPIError).toBe(true);
      expect((error as OCRAPIError).statusCode).toBe(500);
      expect(error.requestId).toBe('req-123');
    });

    it('maps OCR_RATE_LIMIT with retryAfter', () => {
      const error = mapPythonError('OCR_RATE_LIMIT', 'Rate limited', { retry_after: 120 });

      expect(error instanceof OCRRateLimitError).toBe(true);
      expect((error as OCRRateLimitError).retryAfter).toBe(120);
    });

    it('maps OCR_TIMEOUT correctly', () => {
      const error = mapPythonError('OCR_TIMEOUT', 'Timed out', { request_id: 'req-456' });

      expect(error instanceof OCRTimeoutError).toBe(true);
      expect(error.requestId).toBe('req-456');
    });

    it('maps OCR_FILE_ERROR correctly', () => {
      const error = mapPythonError('OCR_FILE_ERROR', 'File missing', { file_path: '/test.pdf' });

      expect(error instanceof OCRFileError).toBe(true);
      expect((error as OCRFileError).filePath).toBe('/test.pdf');
    });

    it('maps OCR_AUTHENTICATION_ERROR correctly', () => {
      const error = mapPythonError('OCR_AUTHENTICATION_ERROR', 'Auth failed', { status_code: 401 });

      expect(error instanceof OCRAuthenticationError).toBe(true);
      expect((error as OCRAuthenticationError).statusCode).toBe(401);
    });

    it('throws on unknown category', () => {
      expect(() => {
        mapPythonError('UNKNOWN_CATEGORY', 'Unknown error', {});
      }).toThrow(OCRError);

      try {
        mapPythonError('UNKNOWN_CATEGORY', 'Unknown error', {});
      } catch (e) {
        expect((e as OCRError).message).toContain('Unknown error category');
        expect((e as OCRError).message).toContain('UNKNOWN_CATEGORY');
      }
    });

    it('uses default values when details are missing', () => {
      const apiError = mapPythonError('OCR_API_ERROR', 'Error', {});
      expect((apiError as OCRAPIError).statusCode).toBe(500);

      const rateLimitError = mapPythonError('OCR_RATE_LIMIT', 'Limited', {});
      expect((rateLimitError as OCRRateLimitError).retryAfter).toBe(60);

      const fileError = mapPythonError('OCR_FILE_ERROR', 'File error', {});
      expect((fileError as OCRFileError).filePath).toBe('unknown');

      const authError = mapPythonError('OCR_AUTHENTICATION_ERROR', 'Auth', {});
      expect((authError as OCRAuthenticationError).statusCode).toBe(401);
    });
  });
});
