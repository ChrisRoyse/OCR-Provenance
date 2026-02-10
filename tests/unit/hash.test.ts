/**
 * Unit tests for SHA-256 hash utilities - Facade
 *
 * This file has been modularized. Tests are now split across:
 * - hash/constants.test.ts - Hash constants tests
 * - hash/compute-hash.test.ts - computeHash function tests
 * - hash/validation.test.ts - isValidHashFormat tests
 * - hash/file-operations.test.ts - hashFile tests
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
  isValidHashFormat,
  computeFileHashSync,
} from '../../src/utils/hash.js';

// Re-export kept hash utilities for backwards compatibility
export {
  computeHash,
  hashFile,
  isValidHashFormat,
  computeFileHashSync,
};

describe('Hash Module Facade', () => {
  it('should compute a valid hash', () => {
    const hash = computeHash('hello');
    expect(isValidHashFormat(hash)).toBe(true);
  });
});
