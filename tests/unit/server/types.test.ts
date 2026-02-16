/**
 * Unit tests for MCP Server Type Definitions
 *
 * Tests successResult helper function.
 *
 * @module tests/unit/server/types
 */

import { describe, it, expect } from 'vitest';
import { successResult, type ToolResultSuccess } from '../../../src/server/types.js';

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
});
