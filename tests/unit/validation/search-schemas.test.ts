/**
 * Unit Tests for Search Schemas
 *
 * Tests SearchSemanticInput, SearchInput, SearchHybridInput, FTSManageInput
 */

import { describe, it, expect } from 'vitest';
import { SearchSemanticInput, SearchInput, SearchHybridInput, FTSManageInput } from './fixtures.js';

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

  describe('SearchInput', () => {
    it('should accept valid query', () => {
      const result = SearchInput.parse({ query: 'termination clause' });
      expect(result.query).toBe('termination clause');
    });

    it('should provide defaults', () => {
      const result = SearchInput.parse({ query: 'test' });
      expect(result.limit).toBe(10);
      expect(result.phrase_search).toBe(false);
      expect(result.include_highlight).toBe(true);
      expect(result.include_provenance).toBe(false);
    });

    it('should reject empty query', () => {
      expect(() => SearchInput.parse({ query: '' })).toThrow('required');
    });

    it('should accept phrase_search flag', () => {
      const result = SearchInput.parse({ query: 'exact phrase', phrase_search: true });
      expect(result.phrase_search).toBe(true);
    });

    it('should accept document_filter', () => {
      const result = SearchInput.parse({
        query: 'test',
        document_filter: ['doc1'],
      });
      expect(result.document_filter).toEqual(['doc1']);
    });
  });

  describe('SearchHybridInput', () => {
    it('should accept valid input with defaults', () => {
      const result = SearchHybridInput.parse({ query: 'test' });
      expect(result.bm25_weight).toBe(1.0);
      expect(result.semantic_weight).toBe(1.0);
      expect(result.rrf_k).toBe(60);
    });

    it('should accept custom weights (no sum constraint)', () => {
      const result = SearchHybridInput.parse({
        query: 'test',
        bm25_weight: 1.5,
        semantic_weight: 0.5,
      });
      expect(result.bm25_weight).toBe(1.5);
      expect(result.semantic_weight).toBe(0.5);
    });

    it('should reject weights above 2', () => {
      expect(() => SearchHybridInput.parse({ query: 'test', bm25_weight: 2.5 })).toThrow();
    });

    it('should accept custom rrf_k', () => {
      const result = SearchHybridInput.parse({ query: 'test', rrf_k: 30 });
      expect(result.rrf_k).toBe(30);
    });

    it('should reject rrf_k below 1', () => {
      expect(() => SearchHybridInput.parse({ query: 'test', rrf_k: 0 })).toThrow();
    });
  });

  describe('FTSManageInput', () => {
    it('should accept rebuild action', () => {
      const result = FTSManageInput.parse({ action: 'rebuild' });
      expect(result.action).toBe('rebuild');
    });

    it('should accept status action', () => {
      const result = FTSManageInput.parse({ action: 'status' });
      expect(result.action).toBe('status');
    });

    it('should reject invalid action', () => {
      expect(() => FTSManageInput.parse({ action: 'invalid' })).toThrow();
    });

    it('should reject missing action', () => {
      expect(() => FTSManageInput.parse({})).toThrow();
    });
  });
});
