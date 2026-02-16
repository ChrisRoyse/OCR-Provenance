/**
 * Unit tests for MCP Server Error Handling
 *
 * Tests MCPError class, error factories, and error response formatting.
 * FAIL FAST: All errors should throw immediately with full context.
 *
 * @module tests/unit/server/errors
 */

import { describe, it, expect } from 'vitest';
import {
  MCPError,
  formatErrorResponse,
  validationError,
  databaseNotSelectedError,
  databaseNotFoundError,
  databaseAlreadyExistsError,
  documentNotFoundError,
  provenanceNotFoundError,
  pathNotFoundError,
  pathNotDirectoryError,
  type ErrorCategory,
} from '../../../src/server/errors.js';

// ═══════════════════════════════════════════════════════════════════════════════
// MCPError CLASS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('MCPError', () => {
  describe('constructor', () => {
    it('should create error with category and message', () => {
      const error = new MCPError('VALIDATION_ERROR', 'Invalid input');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(MCPError);
      expect(error.name).toBe('MCPError');
      expect(error.category).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Invalid input');
      expect(error.details).toBeUndefined();
    });

    it('should create error with category, message, and details', () => {
      const details = { field: 'name', received: null };
      const error = new MCPError('VALIDATION_ERROR', 'Name is required', details);

      expect(error.category).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Name is required');
      expect(error.details).toEqual(details);
    });

    it('should have stack trace', () => {
      const error = new MCPError('INTERNAL_ERROR', 'Something failed');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('MCPError');
    });

    it('should support all error categories', () => {
      const categories: ErrorCategory[] = [
        'VALIDATION_ERROR',
        'DATABASE_NOT_FOUND',
        'DATABASE_NOT_SELECTED',
        'DATABASE_ALREADY_EXISTS',
        'DOCUMENT_NOT_FOUND',
        'PROVENANCE_NOT_FOUND',
        'PROVENANCE_CHAIN_BROKEN',
        'INTEGRITY_VERIFICATION_FAILED',
        'OCR_API_ERROR',
        'OCR_RATE_LIMIT',
        'OCR_TIMEOUT',
        'GPU_NOT_AVAILABLE',
        'EMBEDDING_FAILED',
        'PATH_NOT_FOUND',
        'PATH_NOT_DIRECTORY',
        'PERMISSION_DENIED',
        'INTERNAL_ERROR',
      ];

      for (const category of categories) {
        const error = new MCPError(category, `Test ${category}`);
        expect(error.category).toBe(category);
        expect(error.message).toBe(`Test ${category}`);
      }
    });
  });

  describe('fromUnknown', () => {
    it('should return same MCPError if passed an MCPError', () => {
      const original = new MCPError('DATABASE_NOT_FOUND', 'Not found');
      const result = MCPError.fromUnknown(original);

      expect(result).toBe(original);
      expect(result.category).toBe('DATABASE_NOT_FOUND');
    });

    it('should wrap Error with default category', () => {
      const original = new Error('Standard error');
      const result = MCPError.fromUnknown(original);

      expect(result).toBeInstanceOf(MCPError);
      expect(result.category).toBe('INTERNAL_ERROR');
      expect(result.message).toBe('Standard error');
      expect(result.details).toHaveProperty('originalName', 'Error');
      expect(result.details).toHaveProperty('stack');
    });

    it('should wrap Error with specified category', () => {
      const original = new TypeError('Type mismatch');
      const result = MCPError.fromUnknown(original, 'VALIDATION_ERROR');

      expect(result.category).toBe('VALIDATION_ERROR');
      expect(result.message).toBe('Type mismatch');
      expect(result.details?.originalName).toBe('TypeError');
    });

    it('should wrap string', () => {
      const result = MCPError.fromUnknown('String error message');

      expect(result).toBeInstanceOf(MCPError);
      expect(result.category).toBe('INTERNAL_ERROR');
      expect(result.message).toBe('String error message');
      expect(result.details?.originalValue).toBe('String error message');
    });

    it('should wrap number', () => {
      const result = MCPError.fromUnknown(404);

      expect(result.message).toBe('404');
      expect(result.details?.originalValue).toBe(404);
    });

    it('should wrap null', () => {
      const result = MCPError.fromUnknown(null);

      expect(result.message).toBe('null');
      expect(result.details?.originalValue).toBe(null);
    });

    it('should wrap undefined', () => {
      const result = MCPError.fromUnknown(undefined);

      expect(result.message).toBe('undefined');
      expect(result.details?.originalValue).toBe(undefined);
    });

    it('should wrap object', () => {
      const obj = { code: 500, message: 'Server error' };
      const result = MCPError.fromUnknown(obj);

      expect(result.message).toBe('[object Object]');
      expect(result.details?.originalValue).toBe(obj);
    });

    it('should wrap array', () => {
      const arr = ['error1', 'error2'];
      const result = MCPError.fromUnknown(arr);

      expect(result.message).toBe('error1,error2');
      expect(result.details?.originalValue).toBe(arr);
    });

    it('should wrap boolean', () => {
      const result = MCPError.fromUnknown(false);

      expect(result.message).toBe('false');
      expect(result.details?.originalValue).toBe(false);
    });

    it('should wrap custom Error subclass', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      const original = new CustomError('Custom failure');
      const result = MCPError.fromUnknown(original, 'OCR_API_ERROR');

      expect(result.category).toBe('OCR_API_ERROR');
      expect(result.message).toBe('Custom failure');
      expect(result.details?.originalName).toBe('CustomError');
    });

    it('should preserve MCPError with details', () => {
      const original = new MCPError('DOCUMENT_NOT_FOUND', 'Missing', {
        documentId: 'doc-123',
      });
      const result = MCPError.fromUnknown(original);

      expect(result.details).toEqual({ documentId: 'doc-123' });
    });
  });

  describe('toJSON', () => {
    it('should serialize basic error', () => {
      const error = new MCPError('VALIDATION_ERROR', 'Bad input');
      const json = error.toJSON();

      expect(json.name).toBe('MCPError');
      expect(json.category).toBe('VALIDATION_ERROR');
      expect(json.message).toBe('Bad input');
      expect(json.details).toBeUndefined();
      expect(json.stack).toBeDefined();
    });

    it('should serialize error with details', () => {
      const error = new MCPError('DATABASE_NOT_FOUND', 'Not found', {
        name: 'test-db',
        path: '/tmp/test',
      });
      const json = error.toJSON();

      expect(json.details).toEqual({
        name: 'test-db',
        path: '/tmp/test',
      });
    });

    it('should be JSON.stringify compatible', () => {
      const error = new MCPError('INTERNAL_ERROR', 'Test', { count: 42 });
      const jsonString = JSON.stringify(error.toJSON());
      const parsed = JSON.parse(jsonString);

      expect(parsed.category).toBe('INTERNAL_ERROR');
      expect(parsed.message).toBe('Test');
      expect(parsed.details.count).toBe(42);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR RESPONSE FORMATTING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatErrorResponse', () => {
  it('should format basic error', () => {
    const error = new MCPError('VALIDATION_ERROR', 'Invalid');
    const response = formatErrorResponse(error);

    expect(response.success).toBe(false);
    expect(response.error.category).toBe('VALIDATION_ERROR');
    expect(response.error.message).toBe('Invalid');
    expect(response.error.details).toBeUndefined();
  });

  it('should format error with details', () => {
    const error = new MCPError('DATABASE_NOT_FOUND', 'Not found', {
      databaseName: 'mydb',
    });
    const response = formatErrorResponse(error);

    expect(response.success).toBe(false);
    expect(response.error.details).toEqual({ databaseName: 'mydb' });
  });

  it('should always return success: false', () => {
    const error = new MCPError('INTERNAL_ERROR', 'Test');
    const response = formatErrorResponse(error);

    expect(response.success).toBe(false);
    expect(response).toHaveProperty('error');
  });

  it('should preserve complex details', () => {
    const details = {
      path: '/some/path',
      expected: ['a', 'b'],
      config: { nested: true },
    };
    const error = new MCPError('VALIDATION_ERROR', 'Complex', details);
    const response = formatErrorResponse(error);

    expect(response.error.details).toEqual(details);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR FACTORY FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('validationError', () => {
  it('should create VALIDATION_ERROR with message', () => {
    const error = validationError('Field is required');

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Field is required');
    expect(error.details).toBeUndefined();
  });

  it('should create VALIDATION_ERROR with details', () => {
    const error = validationError('Invalid value', {
      field: 'email',
      value: 'not-an-email',
    });

    expect(error.details).toEqual({
      field: 'email',
      value: 'not-an-email',
    });
  });

  it('should handle empty message', () => {
    const error = validationError('');

    expect(error.message).toBe('');
    expect(error.category).toBe('VALIDATION_ERROR');
  });
});

describe('databaseNotSelectedError', () => {
  it('should create DATABASE_NOT_SELECTED with standard message', () => {
    const error = databaseNotSelectedError();

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('DATABASE_NOT_SELECTED');
    expect(error.message).toBe('No database selected. Use ocr_db_select first.');
    expect(error.details).toBeUndefined();
  });

  it('should always return same message', () => {
    const error1 = databaseNotSelectedError();
    const error2 = databaseNotSelectedError();

    expect(error1.message).toBe(error2.message);
    expect(error1.category).toBe(error2.category);
  });
});

describe('databaseNotFoundError', () => {
  it('should create DATABASE_NOT_FOUND with name', () => {
    const error = databaseNotFoundError('test-db');

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('DATABASE_NOT_FOUND');
    expect(error.message).toBe('Database "test-db" not found');
    expect(error.details).toEqual({ databaseName: 'test-db' });
  });

  it('should create DATABASE_NOT_FOUND with name and path', () => {
    const error = databaseNotFoundError('mydb', '/custom/path');

    expect(error.message).toBe('Database "mydb" not found');
    expect(error.details).toEqual({
      databaseName: 'mydb',
      storagePath: '/custom/path',
    });
  });

  it('should handle special characters in name', () => {
    const error = databaseNotFoundError('test-db_123');

    expect(error.message).toBe('Database "test-db_123" not found');
    expect(error.details?.databaseName).toBe('test-db_123');
  });

  it('should handle empty name', () => {
    const error = databaseNotFoundError('');

    expect(error.message).toBe('Database "" not found');
    expect(error.details?.databaseName).toBe('');
  });
});

describe('databaseAlreadyExistsError', () => {
  it('should create DATABASE_ALREADY_EXISTS with name', () => {
    const error = databaseAlreadyExistsError('existing-db');

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('DATABASE_ALREADY_EXISTS');
    expect(error.message).toBe('Database "existing-db" already exists');
    expect(error.details).toEqual({ databaseName: 'existing-db' });
  });

  it('should handle various name formats', () => {
    const names = ['simple', 'with-dash', 'with_underscore', 'Mixed123'];

    for (const name of names) {
      const error = databaseAlreadyExistsError(name);
      expect(error.message).toBe(`Database "${name}" already exists`);
      expect(error.details?.databaseName).toBe(name);
    }
  });
});

describe('documentNotFoundError', () => {
  it('should create DOCUMENT_NOT_FOUND with id', () => {
    const error = documentNotFoundError('doc-uuid-123');

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('DOCUMENT_NOT_FOUND');
    expect(error.message).toBe('Document "doc-uuid-123" not found');
    expect(error.details).toEqual({ documentId: 'doc-uuid-123' });
  });

  it('should handle UUID format', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const error = documentNotFoundError(uuid);

    expect(error.details?.documentId).toBe(uuid);
  });
});

describe('provenanceNotFoundError', () => {
  it('should create PROVENANCE_NOT_FOUND with item id', () => {
    const error = provenanceNotFoundError('prov-123');

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('PROVENANCE_NOT_FOUND');
    expect(error.message).toBe('Provenance for "prov-123" not found');
    expect(error.details).toEqual({ itemId: 'prov-123' });
  });
});

describe('pathNotFoundError', () => {
  it('should create PATH_NOT_FOUND with path', () => {
    const error = pathNotFoundError('/nonexistent/path');

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('PATH_NOT_FOUND');
    expect(error.message).toBe('Path does not exist: /nonexistent/path');
    expect(error.details).toEqual({ path: '/nonexistent/path' });
  });

  it('should handle relative paths', () => {
    const error = pathNotFoundError('./relative/path');

    expect(error.message).toContain('./relative/path');
    expect(error.details?.path).toBe('./relative/path');
  });

  it('should handle Windows-style paths', () => {
    const error = pathNotFoundError('C:\\Users\\test\\file.txt');

    expect(error.details?.path).toBe('C:\\Users\\test\\file.txt');
  });
});

describe('pathNotDirectoryError', () => {
  it('should create PATH_NOT_DIRECTORY with path', () => {
    const error = pathNotDirectoryError('/path/to/file.txt');

    expect(error).toBeInstanceOf(MCPError);
    expect(error.category).toBe('PATH_NOT_DIRECTORY');
    expect(error.message).toBe('Path is not a directory: /path/to/file.txt');
    expect(error.details).toEqual({ path: '/path/to/file.txt' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES AND BOUNDARY CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle null in details values', () => {
    const error = new MCPError('VALIDATION_ERROR', 'Test', {
      nullField: null,
      undefinedField: undefined,
    });

    expect(error.details?.nullField).toBe(null);
    expect(error.details?.undefinedField).toBe(undefined);
  });

  it('should handle symbols in fromUnknown', () => {
    const sym = Symbol('test');
    const result = MCPError.fromUnknown(sym);

    expect(result.message).toBe('Symbol(test)');
    expect(result.details?.originalValue).toBe(sym);
  });

  it('should handle BigInt in fromUnknown', () => {
    const bigint = BigInt(9007199254740991);
    const result = MCPError.fromUnknown(bigint);

    expect(result.message).toBe('9007199254740991');
    expect(result.details?.originalValue).toBe(bigint);
  });
});
