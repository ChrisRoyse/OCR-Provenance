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
} from '../../../src/utils/hash.js';
