/**
 * Unit Tests for Search Schemas
 *
 * Tests SearchSemanticInput, SearchTextInput, SearchHybridInput
 */

import { describe, it, expect } from 'vitest';
import {
  SearchSemanticInput,
  SearchTextInput,
  SearchHybridInput,
} from './fixtures.js';

describe('Search Schemas', () => {
  describe('SearchSemanticInput', () => {
    it('should accept valid query', () => {
      const result = SearchSemanticInput.parse({ query: 'contract termination' });
      expect(result.query).toBe('contract termination');
    });

    it('should provide defaults', () => {
      const result = SearchSemanticInput.parse({ query: 'test' });
      expect(result.limit).toBe(10);
      expect(result.similarity_threshold).toBe(0.7);
      expect(result.include_provenance).toBe(false);
    });

    it('should reject empty query', () => {
      expect(() => SearchSemanticInput.parse({ query: '' })).toThrow('required');
    });

    it('should reject query exceeding max length', () => {
      const longQuery = 'a'.repeat(1001);
      expect(() => SearchSemanticInput.parse({ query: longQuery })).toThrow('1000');
    });

    it('should accept similarity threshold between 0 and 1', () => {
      const result = SearchSemanticInput.parse({
        query: 'test',
        similarity_threshold: 0.5,
      });
      expect(result.similarity_threshold).toBe(0.5);
    });

    it('should reject similarity threshold above 1', () => {
      expect(() =>
        SearchSemanticInput.parse({ query: 'test', similarity_threshold: 1.5 })
      ).toThrow();
    });

    it('should accept document_filter', () => {
      const result = SearchSemanticInput.parse({
        query: 'test',
        document_filter: ['doc1', 'doc2'],
      });
      expect(result.document_filter).toEqual(['doc1', 'doc2']);
    });
  });

  describe('SearchTextInput', () => {
    it('should accept valid input', () => {
      const result = SearchTextInput.parse({ query: 'termination clause' });
      expect(result.query).toBe('termination clause');
      expect(result.match_type).toBe('fuzzy');
    });

    it('should accept different match types', () => {
      expect(SearchTextInput.parse({ query: 'test', match_type: 'exact' }).match_type).toBe(
        'exact'
      );
      expect(SearchTextInput.parse({ query: 'test', match_type: 'regex' }).match_type).toBe(
        'regex'
      );
    });
  });

  describe('SearchHybridInput', () => {
    it('should accept valid input with default weights', () => {
      const result = SearchHybridInput.parse({ query: 'test' });
      expect(result.semantic_weight).toBe(0.7);
      expect(result.keyword_weight).toBe(0.3);
    });

    it('should accept custom weights that sum to 1', () => {
      const result = SearchHybridInput.parse({
        query: 'test',
        semantic_weight: 0.5,
        keyword_weight: 0.5,
      });
      expect(result.semantic_weight).toBe(0.5);
      expect(result.keyword_weight).toBe(0.5);
    });

    it('should reject weights that do not sum to 1', () => {
      expect(() =>
        SearchHybridInput.parse({
          query: 'test',
          semantic_weight: 0.5,
          keyword_weight: 0.3,
        })
      ).toThrow('sum to 1.0');
    });
  });
});
