/**
 * SHA-256 Hash Utilities for Provenance Integrity Verification
 *
 * This module provides cryptographic hashing functions for the OCR Provenance MCP System.
 * All hashes use the format: 'sha256:' + 64-character lowercase hex string.
 *
 * @module utils/hash
 * @see CS-PROV-002 Hash Computation standard in constitution.md
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Hash prefix used for all SHA-256 hashes in this system
 */
export const HASH_PREFIX = 'sha256:';

/**
 * Expected length of the hex portion of a hash (SHA-256 produces 32 bytes = 64 hex chars)
 */
export const HASH_HEX_LENGTH = 64;

/**
 * Total length of a complete hash string (prefix + hex)
 */
export const HASH_TOTAL_LENGTH = HASH_PREFIX.length + HASH_HEX_LENGTH;

/**
 * Regular expression for validating hash format
 * Matches: 'sha256:' followed by exactly 64 lowercase hex characters
 */
export const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Compute SHA-256 hash of content
 *
 * @param content - String or Buffer to hash
 * @returns Hash in format 'sha256:' + 64-char lowercase hex string
 * @example
 * computeHash('hello')
 * // Returns: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 *
 * @example
 * computeHash(Buffer.from([0x01, 0x02, 0x03]))
 * // Returns: 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
 */
export function computeHash(content: string | Buffer): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  return HASH_PREFIX + hash;
}

/**
 * Compute SHA-256 hash of a file using streaming (memory efficient)
 *
 * This function reads the file in chunks using a stream, making it suitable
 * for hashing large files without loading them entirely into memory.
 *
 * @param filePath - Absolute path to file
 * @returns Promise resolving to hash in format 'sha256:' + 64-char hex string
 * @throws Error if file doesn't exist, path is not absolute, or can't be read
 *
 * @example
 * const hash = await hashFile('/path/to/document.pdf');
 * // Returns: 'sha256:...'
 */
export async function hashFile(filePath: string): Promise<string> {
  // Validate path is absolute
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`);
  }

  // Check file exists and is accessible
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    if (fsError.code === 'EACCES') {
      throw new Error(`Permission denied: ${filePath}`);
    }
    throw new Error(`Cannot access file: ${filePath} - ${fsError.message}`);
  }

  // Verify it's a file, not a directory
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(HASH_PREFIX + hash.digest('hex'));
    });

    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`File not found: ${filePath}`));
      } else if (error.code === 'EACCES') {
        reject(new Error(`Permission denied: ${filePath}`));
      } else {
        reject(new Error(`Error reading file: ${filePath} - ${error.message}`));
      }
    });
  });
}

/**
 * Verify content matches expected hash
 *
 * @param content - Content to verify
 * @param expectedHash - Expected hash in format 'sha256:...'
 * @returns true if computed hash matches expected, false otherwise
 *
 * @example
 * verifyHash('hello', 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
 * // Returns: true
 *
 * @example
 * verifyHash('hello', 'sha256:0000000000000000000000000000000000000000000000000000000000000000')
 * // Returns: false
 */
export function verifyHash(content: string | Buffer, expectedHash: string): boolean {
  // Invalid hash format always returns false (content cannot match invalid hash)
  if (!isValidHashFormat(expectedHash)) {
    return false;
  }

  const computedHash = computeHash(content);
  return computedHash === expectedHash;
}

/**
 * Verify file content matches expected hash
 *
 * @param filePath - Absolute path to file
 * @param expectedHash - Expected hash in format 'sha256:...'
 * @returns Promise resolving to true if hash matches, false otherwise
 * @throws Error if file cannot be read
 */
export async function verifyFileHash(filePath: string, expectedHash: string): Promise<boolean> {
  // Invalid hash format always returns false
  if (!isValidHashFormat(expectedHash)) {
    return false;
  }

  const computedHash = await hashFile(filePath);
  return computedHash === expectedHash;
}

/**
 * Validate hash format is correct
 *
 * @param hash - Hash string to validate
 * @returns true if format is 'sha256:' + 64 lowercase hex chars, false otherwise
 *
 * @example
 * isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
 * // Returns: true
 *
 * @example
 * isValidHashFormat('sha256:ABC123') // Wrong length, uppercase
 * // Returns: false
 */
export function isValidHashFormat(hash: string): boolean {
  if (typeof hash !== 'string') {
    return false;
  }
  return HASH_PATTERN.test(hash);
}

/**
 * Extract hex portion from full hash
 *
 * @param hash - Full hash string 'sha256:...'
 * @returns 64-char lowercase hex string
 * @throws Error if hash format is invalid
 *
 * @example
 * extractHashHex('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
 * // Returns: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 */
export function extractHashHex(hash: string): string {
  if (!isValidHashFormat(hash)) {
    throw new Error(`Invalid hash format: ${hash}. Expected 'sha256:' + 64 hex characters.`);
  }
  return hash.slice(HASH_PREFIX.length);
}

/**
 * Compare two hashes for equality (constant-time to prevent timing attacks)
 *
 * @param hash1 - First hash to compare
 * @param hash2 - Second hash to compare
 * @returns true if hashes are equal, false otherwise
 */
export function compareHashes(hash1: string, hash2: string): boolean {
  // Both must be valid format
  if (!isValidHashFormat(hash1) || !isValidHashFormat(hash2)) {
    return false;
  }

  // Use crypto.timingSafeEqual for constant-time comparison
  const buf1 = Buffer.from(hash1);
  const buf2 = Buffer.from(hash2);

  if (buf1.length !== buf2.length) {
    return false;
  }

  return crypto.timingSafeEqual(buf1, buf2);
}

/**
 * Create a hash from multiple content pieces (for composite hashing)
 *
 * Useful for creating a combined hash from multiple related pieces of content,
 * such as hashing all chunks together or combining input parameters.
 *
 * @param contents - Array of strings or Buffers to hash together
 * @returns Combined hash in format 'sha256:...'
 *
 * @example
 * computeCompositeHash(['chunk1', 'chunk2', 'chunk3'])
 * // Returns: 'sha256:...' (hash of concatenated content)
 */
export function computeCompositeHash(contents: Array<string | Buffer>): string {
  const hash = crypto.createHash('sha256');

  for (const content of contents) {
    hash.update(content);
  }

  return HASH_PREFIX + hash.digest('hex');
}

/**
 * Hash verification result with details
 */
export interface HashVerificationResult {
  /** Whether the hash matched */
  valid: boolean;

  /** The expected hash that was provided */
  expected: string;

  /** The computed hash from content */
  computed: string;

  /** Whether the expected hash format was valid */
  formatValid: boolean;
}

/**
 * Verify hash with detailed result
 *
 * @param content - Content to verify
 * @param expectedHash - Expected hash
 * @returns Detailed verification result
 */
export function verifyHashDetailed(
  content: string | Buffer,
  expectedHash: string
): HashVerificationResult {
  const formatValid = isValidHashFormat(expectedHash);
  const computed = computeHash(content);

  return {
    valid: formatValid && computed === expectedHash,
    expected: expectedHash,
    computed,
    formatValid,
  };
}
