/**
 * Unit tests for SHA-256 hash utilities - Facade
 *
 * This file has been modularized. Tests are now split across:
 * - hash/constants.test.ts - Hash constants tests
 * - hash/compute-hash.test.ts - computeHash function tests
 * - hash/validation.test.ts - isValidHashFormat, extractHashHex tests
 * - hash/verification.test.ts - verifyHash, verifyHashDetailed, compareHashes tests
 * - hash/composite.test.ts - computeCompositeHash tests
 * - hash/file-operations.test.ts - hashFile, verifyFileHash tests
 * - hash/integration.test.ts - Provenance use case integration tests
 *
 * Shared helpers and imports are in hash/helpers.ts
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import { describe, it, expect } from 'vitest';
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

// Re-export all hash utilities for backwards compatibility
export {
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
};

describe('Hash Module Facade', () => {
  it('should export all hash utilities', () => {
    // Verify all functions are exported
    expect(typeof computeHash).toBe('function');
    expect(typeof hashFile).toBe('function');
    expect(typeof verifyHash).toBe('function');
    expect(typeof verifyFileHash).toBe('function');
    expect(typeof isValidHashFormat).toBe('function');
    expect(typeof extractHashHex).toBe('function');
    expect(typeof compareHashes).toBe('function');
    expect(typeof computeCompositeHash).toBe('function');
    expect(typeof verifyHashDetailed).toBe('function');

    // Verify all constants are exported
    expect(HASH_PREFIX).toBe('sha256:');
    expect(HASH_HEX_LENGTH).toBe(64);
    expect(HASH_TOTAL_LENGTH).toBe(71);
    expect(HASH_PATTERN).toBeInstanceOf(RegExp);
  });
});
