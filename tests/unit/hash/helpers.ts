/**
 * Shared test helpers and imports for hash tests
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

export { describe, it, expect, beforeAll, afterAll } from 'vitest';
export { default as fs } from 'fs';
export { default as path } from 'path';
export { default as os } from 'os';

export {
  computeHash,
  hashFile,
  isValidHashFormat,
  computeFileHashSync,
} from '../../../src/utils/hash.js';
