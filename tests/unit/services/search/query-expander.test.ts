/**
 * Unit Tests for SE-1: Query Expansion
 *
 * Tests the expandQuery and getExpandedTerms functions for
 * legal/medical domain synonym expansion.
 *
 * @module tests/unit/services/search/query-expander
 */

import { describe, it, expect } from 'vitest';
import { getExpandedTerms } from '../../../../src/services/search/query-expander.js';

describe('Query Expander', () => {
  describe('getExpandedTerms', () => {
    it('returns correct structure for a known term', () => {
      const result = getExpandedTerms('injury');
      expect(result.original).toBe('injury');
      expect(result.expanded).toEqual(
        expect.arrayContaining(['wound', 'trauma', 'harm', 'damage'])
      );
      expect(result.synonyms_found).toHaveProperty('injury');
      expect(result.synonyms_found.injury).toEqual(['wound', 'trauma', 'harm', 'damage']);
    });

    it('returns empty expanded array for unknown terms', () => {
      const result = getExpandedTerms('xylophone');
      expect(result.original).toBe('xylophone');
      expect(result.expanded).toEqual([]);
      expect(Object.keys(result.synonyms_found)).toHaveLength(0);
    });

    it('returns multiple synonym groups for multi-word query', () => {
      const result = getExpandedTerms('injury treatment');
      expect(result.synonyms_found).toHaveProperty('injury');
      expect(result.synonyms_found).toHaveProperty('treatment');
      expect(result.expanded.length).toBeGreaterThan(4); // Both sets of synonyms
    });

    it('is case insensitive', () => {
      const lower = getExpandedTerms('injury');
      const upper = getExpandedTerms('INJURY');
      expect(lower.synonyms_found).toEqual(upper.synonyms_found);
    });

    it('preserves original query', () => {
      const result = getExpandedTerms('Complex INJURY Query');
      expect(result.original).toBe('Complex INJURY Query');
    });
  });
});
