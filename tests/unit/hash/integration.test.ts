/**
 * Integration tests for hash provenance use cases
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import {
  describe,
  it,
  expect,
  computeHash,
  verifyHash,
  verifyHashDetailed,
  isValidHashFormat,
} from './helpers.js';

describe('Integration: Provenance Use Cases', () => {
  it('should support document hash tracking', () => {
    const documentContent = 'This is a PDF document content extracted via OCR.';
    const documentHash = computeHash(documentContent);

    // Verify format matches provenance record requirements
    expect(isValidHashFormat(documentHash)).toBe(true);
    expect(documentHash.startsWith('sha256:')).toBe(true);
  });

  it('should support chunk hash computation', () => {
    const ocrText = 'Full OCR extracted text from document.';
    const chunk1 = 'Full OCR extracted';
    const chunk2 = 'text from document.';

    const ocrHash = computeHash(ocrText);
    const chunk1Hash = computeHash(chunk1);
    const chunk2Hash = computeHash(chunk2);

    // Each should have unique valid hash
    expect(isValidHashFormat(ocrHash)).toBe(true);
    expect(isValidHashFormat(chunk1Hash)).toBe(true);
    expect(isValidHashFormat(chunk2Hash)).toBe(true);

    // All should be different
    expect(ocrHash).not.toBe(chunk1Hash);
    expect(ocrHash).not.toBe(chunk2Hash);
    expect(chunk1Hash).not.toBe(chunk2Hash);
  });

  it('should support input/output hash verification', () => {
    const inputText = 'Input to processor';
    const outputText = 'Processed output';

    const inputHash = computeHash(inputText);
    const outputHash = computeHash(outputText);

    // Simulate verifying processing did not tamper with input
    expect(verifyHash(inputText, inputHash)).toBe(true);
    expect(verifyHash(outputText, outputHash)).toBe(true);
  });

  it('should detect tampered content in provenance chain', () => {
    const originalContent = 'Original document content that must not change.';
    const storedHash = computeHash(originalContent);

    // Simulate tampered content
    const tamperedContent = 'Original document content that must not change!'; // Added !

    // Verification should fail
    expect(verifyHash(tamperedContent, storedHash)).toBe(false);

    // Detailed verification provides forensic info
    const result = verifyHashDetailed(tamperedContent, storedHash);
    expect(result.valid).toBe(false);
    expect(result.expected).toBe(storedHash);
    expect(result.computed).not.toBe(storedHash);
  });
});
