/**
 * Unit tests for MCP Server Type Definitions
 *
 * Tests ToolResult types and helper functions (successResult, failureResult).
 *
 * @module tests/unit/server/types
 */

import { describe, it, expect } from 'vitest';
import {
  successResult,
  failureResult,
  type ToolResult,
  type ToolResultSuccess,
  type ToolResultFailure,
  type ToolError,
  type ServerConfig,
  type OCRMode,
} from '../../../src/server/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// successResult HELPER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('successResult', () => {
  it('should create success result with string data', () => {
    const result = successResult('test data');

    expect(result.success).toBe(true);
    expect(result.data).toBe('test data');
  });

  it('should create success result with number data', () => {
    const result = successResult(42);

    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });

  it('should create success result with object data', () => {
    const data = { id: '123', name: 'test' };
    const result = successResult(data);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(data);
    expect(result.data).toBe(data); // Same reference
  });

  it('should create success result with array data', () => {
    const data = [1, 2, 3];
    const result = successResult(data);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('should create success result with null data', () => {
    const result = successResult(null);

    expect(result.success).toBe(true);
    expect(result.data).toBe(null);
  });

  it('should create success result with undefined data', () => {
    const result = successResult(undefined);

    expect(result.success).toBe(true);
    expect(result.data).toBe(undefined);
  });

  it('should create success result with boolean data', () => {
    const resultTrue = successResult(true);
    const resultFalse = successResult(false);

    expect(resultTrue.success).toBe(true);
    expect(resultTrue.data).toBe(true);
    expect(resultFalse.data).toBe(false);
  });

  it('should create success result with nested object', () => {
    const data = {
      user: {
        profile: {
          settings: {
            theme: 'dark',
          },
        },
      },
    };
    const result = successResult(data);

    expect(result.data.user.profile.settings.theme).toBe('dark');
  });

  it('should preserve type information', () => {
    interface User {
      id: string;
      name: string;
    }
    const user: User = { id: '1', name: 'Test' };
    const result: ToolResultSuccess<User> = successResult(user);

    expect(result.data.id).toBe('1');
    expect(result.data.name).toBe('Test');
  });

  it('should create success result with empty object', () => {
    const result = successResult({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('should create success result with empty array', () => {
    const result = successResult([]);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// failureResult HELPER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('failureResult', () => {
  it('should create failure result with category and message', () => {
    const result = failureResult('VALIDATION_ERROR', 'Invalid input');

    expect(result.success).toBe(false);
    expect(result.error.category).toBe('VALIDATION_ERROR');
    expect(result.error.message).toBe('Invalid input');
    expect(result.error.details).toBeUndefined();
  });

  it('should create failure result with details', () => {
    const result = failureResult('DATABASE_NOT_FOUND', 'Not found', {
      databaseName: 'test-db',
    });

    expect(result.success).toBe(false);
    expect(result.error.category).toBe('DATABASE_NOT_FOUND');
    expect(result.error.message).toBe('Not found');
    expect(result.error.details).toEqual({ databaseName: 'test-db' });
  });

  it('should support all error categories', () => {
    const categories = [
      'VALIDATION_ERROR',
      'DATABASE_NOT_FOUND',
      'DATABASE_NOT_SELECTED',
      'DATABASE_ALREADY_EXISTS',
      'DOCUMENT_NOT_FOUND',
      'PROVENANCE_NOT_FOUND',
      'INTERNAL_ERROR',
    ] as const;

    for (const category of categories) {
      const result = failureResult(category, 'Test message');
      expect(result.error.category).toBe(category);
    }
  });

  it('should create failure result with complex details', () => {
    const details = {
      paths: ['/path/a', '/path/b'],
      config: { enabled: true },
      count: 5,
    };
    const result = failureResult('INTERNAL_ERROR', 'Complex error', details);

    expect(result.error.details).toEqual(details);
  });

  it('should create failure result with empty message', () => {
    const result = failureResult('INTERNAL_ERROR', '');

    expect(result.error.message).toBe('');
  });

  it('should create failure result with empty details object', () => {
    const result = failureResult('VALIDATION_ERROR', 'Test', {});

    expect(result.error.details).toEqual({});
  });

  it('should create failure result with null in details', () => {
    const result = failureResult('INTERNAL_ERROR', 'Test', {
      value: null,
      other: 'data',
    });

    expect(result.error.details?.value).toBe(null);
    expect(result.error.details?.other).toBe('data');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ToolResult TYPE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ToolResult type union', () => {
  it('should discriminate success from failure using success flag', () => {
    const success: ToolResult<string> = successResult('data');
    const failure: ToolResult<string> = failureResult('INTERNAL_ERROR', 'Failed');

    if (success.success) {
      expect(success.data).toBe('data');
    }

    if (!failure.success) {
      expect(failure.error.message).toBe('Failed');
    }
  });

  it('should allow narrowing type in conditional', () => {
    function processResult(result: ToolResult<number>): string {
      if (result.success) {
        return `Value: ${result.data}`;
      } else {
        return `Error: ${result.error.message}`;
      }
    }

    expect(processResult(successResult(42))).toBe('Value: 42');
    expect(processResult(failureResult('INTERNAL_ERROR', 'Oops'))).toBe('Error: Oops');
  });

  it('should work with generic types', () => {
    interface Document {
      id: string;
      content: string;
    }

    const docResult: ToolResult<Document> = successResult({
      id: 'doc-1',
      content: 'Hello',
    });

    if (docResult.success) {
      expect(docResult.data.id).toBe('doc-1');
      expect(docResult.data.content).toBe('Hello');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ToolError INTERFACE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ToolError interface', () => {
  it('should have required category and message', () => {
    const error: ToolError = {
      category: 'VALIDATION_ERROR',
      message: 'Required field missing',
    };

    expect(error.category).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Required field missing');
  });

  it('should have optional details', () => {
    const errorWithDetails: ToolError = {
      category: 'DATABASE_NOT_FOUND',
      message: 'Not found',
      details: { name: 'test-db' },
    };

    const errorWithoutDetails: ToolError = {
      category: 'INTERNAL_ERROR',
      message: 'Unknown',
    };

    expect(errorWithDetails.details).toEqual({ name: 'test-db' });
    expect(errorWithoutDetails.details).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ServerConfig INTERFACE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServerConfig interface', () => {
  it('should define all required fields', () => {
    const config: ServerConfig = {
      defaultStoragePath: '/path/to/storage',
      defaultOCRMode: 'balanced',
      maxConcurrent: 5,
      embeddingBatchSize: 32,
    };

    expect(config.defaultStoragePath).toBe('/path/to/storage');
    expect(config.defaultOCRMode).toBe('balanced');
    expect(config.maxConcurrent).toBe(5);
    expect(config.embeddingBatchSize).toBe(32);
  });

  it('should support all OCR modes', () => {
    const modes: OCRMode[] = ['fast', 'balanced', 'accurate'];

    for (const mode of modes) {
      const config: ServerConfig = {
        defaultStoragePath: '/tmp',
        defaultOCRMode: mode,
        maxConcurrent: 1,
        embeddingBatchSize: 16,
      };
      expect(config.defaultOCRMode).toBe(mode);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle successResult with very large array', () => {
    const largeArray = Array(10000).fill({ id: 'test', value: 42 });
    const result = successResult(largeArray);

    expect(result.success).toBe(true);
    expect(result.data.length).toBe(10000);
  });

  it('should handle failureResult with very long message', () => {
    const longMessage = 'Error: ' + 'x'.repeat(10000);
    const result = failureResult('INTERNAL_ERROR', longMessage);

    expect(result.error.message.length).toBe(10007);
  });

  it('should handle successResult with Date object', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    const result = successResult(date);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(date);
  });

  it('should handle successResult with Map', () => {
    const map = new Map([['key', 'value']]);
    const result = successResult(map);

    expect(result.success).toBe(true);
    expect(result.data.get('key')).toBe('value');
  });

  it('should handle successResult with Set', () => {
    const set = new Set([1, 2, 3]);
    const result = successResult(set);

    expect(result.success).toBe(true);
    expect(result.data.has(2)).toBe(true);
  });

  it('should handle failureResult with Unicode in message', () => {
    const result = failureResult(
      'VALIDATION_ERROR',
      'Invalid input: \u4e2d\u6587\u5b57\u7b26'
    );

    expect(result.error.message).toContain('\u4e2d\u6587');
  });

  it('should handle failureResult with special characters in details', () => {
    const result = failureResult('VALIDATION_ERROR', 'Test', {
      path: '/path/with spaces/and\ttabs',
      query: 'SELECT * FROM "table"',
    });

    expect(result.error.details?.path).toBe('/path/with spaces/and\ttabs');
    expect(result.error.details?.query).toBe('SELECT * FROM "table"');
  });
});
