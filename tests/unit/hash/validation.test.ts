/**
 * Unit tests for hash validation functions
 *
 * @see src/utils/hash.ts
 * @see CS-PROV-002 Hash Computation standard
 */

import { describe, it, expect, isValidHashFormat } from './helpers.js';

describe('isValidHashFormat', () => {
  it('should return true for valid hash format', () => {
    expect(
      isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    ).toBe(true);
  });

  it('should return true for hash with all zeros', () => {
    expect(
      isValidHashFormat('sha256:0000000000000000000000000000000000000000000000000000000000000000')
    ).toBe(true);
  });

  it("should return true for hash with all f's", () => {
    expect(
      isValidHashFormat('sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
    ).toBe(true);
  });

  it('should return false for wrong prefix', () => {
    expect(
      isValidHashFormat('md5:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    ).toBe(false);
    expect(
      isValidHashFormat('SHA256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    ).toBe(false);
  });

  it('should return false for too short hash', () => {
    expect(isValidHashFormat('sha256:abc123')).toBe(false);
    expect(isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e')).toBe(false);
  });

  it('should return false for too long hash', () => {
    expect(
      isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824ff')
    ).toBe(false);
  });

  it('should return false for uppercase hex', () => {
    expect(
      isValidHashFormat('sha256:2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824')
    ).toBe(false);
  });

  it('should return false for non-hex characters', () => {
    expect(
      isValidHashFormat('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b982g')
    ).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isValidHashFormat('')).toBe(false);
  });

  it('should return false for just prefix', () => {
    expect(isValidHashFormat('sha256:')).toBe(false);
  });

  it('should return false for non-string input', () => {
    // @ts-expect-error Testing invalid input
    expect(isValidHashFormat(123)).toBe(false);
    // @ts-expect-error Testing invalid input
    expect(isValidHashFormat(null)).toBe(false);
    // @ts-expect-error Testing invalid input
    expect(isValidHashFormat(undefined)).toBe(false);
  });
});
