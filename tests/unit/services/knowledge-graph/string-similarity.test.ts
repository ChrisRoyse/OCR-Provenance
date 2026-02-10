/**
 * String Similarity Tests
 *
 * Tests all 7 exported functions from string-similarity.ts with real inputs.
 * NO mocks, NO stubs.
 *
 * @module tests/unit/services/knowledge-graph/string-similarity
 */

import { describe, it, expect } from 'vitest';
import {
  sorensenDice,
  tokenSortedSimilarity,
  initialMatch,
  expandAbbreviations,
  normalizeCaseNumber,
  amountsMatch,
  locationContains,
} from '../../../../src/services/knowledge-graph/string-similarity.js';

// =============================================================================
// sorensenDice
// =============================================================================

describe('sorensenDice', () => {
  it('returns 1.0 for identical strings', () => {
    expect(sorensenDice('hello', 'hello')).toBe(1.0);
  });

  it('returns 1.0 for identical strings with different case', () => {
    expect(sorensenDice('Hello', 'hello')).toBe(1.0);
  });

  it('returns 1.0 for identical strings with leading/trailing whitespace', () => {
    expect(sorensenDice('  hello  ', 'hello')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(sorensenDice('abc', 'xyz')).toBe(0.0);
  });

  it('returns high score for similar strings', () => {
    const score = sorensenDice('John Smith', 'John Smyth');
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1.0);
  });

  it('is case insensitive', () => {
    const score1 = sorensenDice('ABC', 'abc');
    expect(score1).toBe(1.0);
  });

  it('returns 0.0 for strings shorter than 2 chars', () => {
    expect(sorensenDice('a', 'b')).toBe(0.0);
  });

  it('returns 1.0 for single char identical strings (exact match short-circuit)', () => {
    expect(sorensenDice('a', 'a')).toBe(1.0);
  });

  it('handles empty strings', () => {
    expect(sorensenDice('', '')).toBe(1.0);
    expect(sorensenDice('', 'abc')).toBe(0.0);
    expect(sorensenDice('abc', '')).toBe(0.0);
  });

  it('computes correct score for known bigram example', () => {
    // "night" bigrams: ni, ig, gh, ht (4)
    // "nacht" bigrams: na, ac, ch, ht (4)
    // intersection: ht (1)
    // dice = 2*1 / (4+4) = 0.25
    expect(sorensenDice('night', 'nacht')).toBe(0.25);
  });
});

// =============================================================================
// tokenSortedSimilarity
// =============================================================================

describe('tokenSortedSimilarity', () => {
  it('matches "John Smith" and "Smith John"', () => {
    const score = tokenSortedSimilarity('John Smith', 'Smith John');
    expect(score).toBe(1.0);
  });

  it('matches "Smith, John" and "John Smith"', () => {
    const score = tokenSortedSimilarity('Smith, John', 'John Smith');
    expect(score).toBe(1.0);
  });

  it('returns 1.0 for identical after sorting', () => {
    const score = tokenSortedSimilarity('Alice Bob Charlie', 'Charlie Alice Bob');
    expect(score).toBe(1.0);
  });

  it('handles semicolons as delimiters', () => {
    const score = tokenSortedSimilarity('Smith; John', 'John Smith');
    expect(score).toBe(1.0);
  });

  it('returns high score for similar names after sorting', () => {
    const score = tokenSortedSimilarity('John A. Smith', 'John B. Smith');
    expect(score).toBeGreaterThan(0.7);
  });

  it('returns low score for completely different names', () => {
    const score = tokenSortedSimilarity('John Smith', 'Alice Wonderland');
    expect(score).toBeLessThan(0.5);
  });
});

// =============================================================================
// initialMatch
// =============================================================================

describe('initialMatch', () => {
  it('matches "J. Smith" with "John Smith"', () => {
    expect(initialMatch('J. Smith', 'John Smith')).toBe(true);
  });

  it('matches "J Smith" with "John Smith"', () => {
    expect(initialMatch('J Smith', 'John Smith')).toBe(true);
  });

  it('does not match "Jane Smith" with "John Smith"', () => {
    expect(initialMatch('Jane Smith', 'John Smith')).toBe(false);
  });

  it('matches "J. D. Smith" with "John D. Smith"', () => {
    // "j d smith" vs "john d smith": tokens same length (3 each)
    // j matches john (initial), d matches d (exact), smith matches smith (exact)
    expect(initialMatch('J. D. Smith', 'John D. Smith')).toBe(true);
  });

  it('returns false for completely different names', () => {
    expect(initialMatch('Alice Johnson', 'Bob Williams')).toBe(false);
  });

  it('returns true for identical names (but only if at least one initial present)', () => {
    // identical strings return true via the normA === normB short-circuit,
    // but the function still requires hasInitial=true for non-identical
    expect(initialMatch('John Smith', 'John Smith')).toBe(true);
  });

  it('returns false for different token counts', () => {
    // "J Smith" (2 tokens) vs "John David Smith" (3 tokens)
    expect(initialMatch('J Smith', 'John David Smith')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(initialMatch('', '')).toBe(true);
    expect(initialMatch('', 'John')).toBe(false);
  });

  it('matches reversed initial: "John Smith" with "J. Smith"', () => {
    expect(initialMatch('John Smith', 'J. Smith')).toBe(true);
  });
});

// =============================================================================
// expandAbbreviations
// =============================================================================

describe('expandAbbreviations', () => {
  it('expands Corp. to Corporation', () => {
    const result = expandAbbreviations('Acme Corp.');
    expect(result).toContain('corporation');
  });

  it('expands LLC to Limited Liability Company', () => {
    const result = expandAbbreviations('Acme LLC');
    expect(result).toContain('limited liability company');
  });

  it('preserves non-abbreviated text', () => {
    const result = expandAbbreviations('John Smith');
    expect(result).toBe('john smith');
  });

  it('handles multiple abbreviations', () => {
    const result = expandAbbreviations('Natl. Corp.');
    expect(result).toContain('national');
    expect(result).toContain('corporation');
  });

  it('expands Inc. to Incorporated', () => {
    const result = expandAbbreviations('Widget Inc.');
    expect(result).toContain('incorporated');
  });

  it('expands Ltd. to Limited', () => {
    const result = expandAbbreviations('Company Ltd.');
    expect(result).toContain('limited');
  });

  it('expands LLP to Limited Liability Partnership', () => {
    const result = expandAbbreviations('Firm LLP');
    expect(result).toContain('limited liability partnership');
  });

  it('expands Dept. to Department', () => {
    const result = expandAbbreviations('Dept. of Justice');
    expect(result).toContain('department');
  });

  it('is case insensitive', () => {
    const result = expandAbbreviations('ACME CORP.');
    expect(result).toContain('corporation');
  });
});

// =============================================================================
// normalizeCaseNumber
// =============================================================================

describe('normalizeCaseNumber', () => {
  it('strips whitespace', () => {
    expect(normalizeCaseNumber('  2024 CV 12345  ')).toBe('2024cv12345');
  });

  it('normalizes separators', () => {
    // En-dash (\u2013) and em-dash (\u2014) should become hyphens
    const result = normalizeCaseNumber('2024\u201312345');
    expect(result).toBe('2024-12345');
  });

  it('normalizes colon to hyphen', () => {
    expect(normalizeCaseNumber('2024:12345')).toBe('2024-12345');
  });

  it('lowercases', () => {
    expect(normalizeCaseNumber('ABC-123')).toBe('abc-123');
  });

  it('collapses multiple hyphens', () => {
    expect(normalizeCaseNumber('2024--12345')).toBe('2024-12345');
  });

  it('handles complex case numbers', () => {
    const result = normalizeCaseNumber('  CV\u20142024 : 00123  ');
    expect(result).toBe('cv-2024-00123');
  });
});

// =============================================================================
// amountsMatch
// =============================================================================

describe('amountsMatch', () => {
  it('matches identical amounts', () => {
    expect(amountsMatch('100', '100')).toBe(true);
  });

  it('matches $1,000.00 and $1000', () => {
    expect(amountsMatch('$1,000.00', '$1000')).toBe(true);
  });

  it('does not match $100 and $200', () => {
    expect(amountsMatch('$100', '$200')).toBe(false);
  });

  it('matches amounts within 1% tolerance', () => {
    expect(amountsMatch('$1000', '$1005')).toBe(true);
    expect(amountsMatch('$1000', '$1010')).toBe(true);
  });

  it('does not match amounts outside 1% tolerance', () => {
    expect(amountsMatch('$1000', '$1020')).toBe(false);
  });

  it('returns false for non-numeric strings', () => {
    expect(amountsMatch('not a number', '100')).toBe(false);
    expect(amountsMatch('100', 'xyz')).toBe(false);
    expect(amountsMatch('abc', 'xyz')).toBe(false);
  });

  it('handles zero amounts', () => {
    expect(amountsMatch('$0', '$0.00')).toBe(true);
  });

  it('respects custom tolerance', () => {
    // 10% tolerance
    expect(amountsMatch('$1000', '$1100', 0.10)).toBe(true);
    expect(amountsMatch('$1000', '$1100', 0.05)).toBe(false);
  });

  it('handles euro and pound symbols', () => {
    expect(amountsMatch('\u20AC1000', '\u00A31000')).toBe(true);
  });
});

// =============================================================================
// locationContains
// =============================================================================

describe('locationContains', () => {
  it('matches "New York" and "New York City"', () => {
    expect(locationContains('New York', 'New York City')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(locationContains('new york', 'NEW YORK')).toBe(true);
  });

  it('does not match unrelated locations', () => {
    expect(locationContains('London', 'Paris')).toBe(false);
  });

  it('handles exact match', () => {
    expect(locationContains('Chicago', 'Chicago')).toBe(true);
  });

  it('matches reverse containment', () => {
    expect(locationContains('New York City', 'New York')).toBe(true);
  });

  it('handles empty strings', () => {
    // empty is substring of everything
    expect(locationContains('', 'New York')).toBe(true);
    expect(locationContains('New York', '')).toBe(true);
    expect(locationContains('', '')).toBe(true);
  });
});
