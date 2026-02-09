/**
 * Unit Tests for SE-1: Query Expansion
 *
 * Tests the expandQuery and getExpandedTerms functions for
 * legal/medical domain synonym expansion.
 *
 * @module tests/unit/services/search/query-expander
 */

import { describe, it, expect } from 'vitest';
import {
  expandQuery,
  getExpandedTerms,
  getSynonymMap,
} from '../../../../src/services/search/query-expander.js';

describe('Query Expander', () => {
  describe('expandQuery', () => {
    it('expands a single known legal term with synonyms', () => {
      const result = expandQuery('injury');
      // Should contain the original word plus synonyms joined with OR
      expect(result).toContain('injury');
      expect(result).toContain('wound');
      expect(result).toContain('trauma');
      expect(result).toContain('harm');
      expect(result).toContain('damage');
      expect(result).toContain(' OR ');
    });

    it('expands a single known medical term with synonyms', () => {
      const result = expandQuery('fracture');
      expect(result).toContain('fracture');
      expect(result).toContain('break');
      expect(result).toContain('crack');
      expect(result).toContain('rupture');
    });

    it('passes through unknown terms unchanged', () => {
      const result = expandQuery('xylophone');
      expect(result).toBe('xylophone');
    });

    it('expands multiple words in a query', () => {
      const result = expandQuery('injury treatment');
      expect(result).toContain('injury');
      expect(result).toContain('wound');
      expect(result).toContain('treatment');
      expect(result).toContain('therapy');
      expect(result).toContain('care');
    });

    it('handles mixed known and unknown terms', () => {
      const result = expandQuery('severe injury report');
      expect(result).toContain('severe');
      expect(result).toContain('injury');
      expect(result).toContain('wound');
      expect(result).toContain('report');
      // 'severe' and 'report' should not have synonyms added
    });

    it('is case insensitive', () => {
      const lower = expandQuery('injury');
      const upper = expandQuery('INJURY');
      const mixed = expandQuery('Injury');
      // All should produce the same expansion
      expect(lower).toBe(upper);
      expect(lower).toBe(mixed);
    });

    it('deduplicates when synonyms overlap', () => {
      // "surgery" has "intervention" and "treatment" has "intervention"
      const result = expandQuery('surgery treatment');
      const parts = result.split(' OR ');
      const interventionCount = parts.filter(p => p === 'intervention').length;
      // Set-based dedup means intervention should appear only once
      expect(interventionCount).toBe(1);
    });

    it('handles empty input', () => {
      const result = expandQuery('');
      expect(result).toBe('');
    });

    it('handles whitespace-only input', () => {
      const result = expandQuery('   ');
      expect(result).toBe('');
    });

    it('returns OR-joined format for BM25 FTS5', () => {
      const result = expandQuery('plaintiff');
      const parts = result.split(' OR ');
      expect(parts.length).toBeGreaterThan(1);
      expect(parts).toContain('plaintiff');
      expect(parts).toContain('claimant');
      expect(parts).toContain('complainant');
      expect(parts).toContain('petitioner');
    });
  });

  describe('getExpandedTerms', () => {
    it('returns correct structure for a known term', () => {
      const result = getExpandedTerms('injury');
      expect(result.original).toBe('injury');
      expect(result.expanded).toEqual(expect.arrayContaining(['wound', 'trauma', 'harm', 'damage']));
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

  describe('getSynonymMap', () => {
    it('returns a non-empty map', () => {
      const map = getSynonymMap();
      expect(Object.keys(map).length).toBeGreaterThan(10);
    });

    it('contains expected legal terms', () => {
      const map = getSynonymMap();
      expect(map).toHaveProperty('injury');
      expect(map).toHaveProperty('plaintiff');
      expect(map).toHaveProperty('defendant');
      expect(map).toHaveProperty('contract');
      expect(map).toHaveProperty('negligence');
    });

    it('contains expected medical terms', () => {
      const map = getSynonymMap();
      expect(map).toHaveProperty('fracture');
      expect(map).toHaveProperty('surgery');
      expect(map).toHaveProperty('diagnosis');
      expect(map).toHaveProperty('medication');
      expect(map).toHaveProperty('pain');
    });

    it('returns a copy (not the original)', () => {
      const map1 = getSynonymMap();
      const map2 = getSynonymMap();
      map1.injury = ['modified'];
      expect(map2.injury).not.toEqual(['modified']);
    });
  });
});
