/**
 * Unit Tests for Search Schemas
 *
 * Tests SearchUnifiedInput and FTSManageInput
 */

import { describe, it, expect } from 'vitest';
import { SearchUnifiedInput, FTSManageInput } from './fixtures.js';

describe('Search Schemas', () => {
  describe('SearchUnifiedInput - core', () => {
    it('should accept valid query with default mode (hybrid)', () => {
      const result = SearchUnifiedInput.parse({ query: 'contract termination' });
      expect(result.query).toBe('contract termination');
      expect(result.mode).toBe('hybrid');
    });

    it('should provide defaults', () => {
      const result = SearchUnifiedInput.parse({ query: 'test' });
      expect(result.limit).toBe(10);
      expect(result.include_provenance).toBe(false);
      expect(result.similarity_threshold).toBe(0.7);
      expect(result.phrase_search).toBe(false);
      expect(result.include_highlight).toBe(true);
      expect(result.bm25_weight).toBe(1.0);
      expect(result.semantic_weight).toBe(1.0);
      expect(result.rrf_k).toBe(60);
      expect(result.auto_route).toBe(true);
      expect(result.rerank).toBe(false);
      expect(result.group_by_document).toBe(false);
    });

    it('should reject empty query', () => {
      expect(() => SearchUnifiedInput.parse({ query: '' })).toThrow('required');
    });

    it('should reject query exceeding max length', () => {
      const longQuery = 'a'.repeat(1001);
      expect(() => SearchUnifiedInput.parse({ query: longQuery })).toThrow('1000');
    });

    it('should accept document_filter in filters', () => {
      const result = SearchUnifiedInput.parse({
        query: 'test',
        filters: { document_filter: ['doc1', 'doc2'] },
      });
      expect(result.filters.document_filter).toEqual(['doc1', 'doc2']);
    });

    it('should accept min_quality_score in filters', () => {
      const result = SearchUnifiedInput.parse({
        query: 'test',
        filters: { min_quality_score: 3.0 },
      });
      expect(result.filters.min_quality_score).toBe(3.0);
    });

    it('should reject min_quality_score above 5 in filters', () => {
      const result = SearchUnifiedInput.safeParse({
        query: 'test',
        filters: { min_quality_score: 6.0 },
      });
      expect(result.success).toBe(false);
    });

    it('should reject min_quality_score below 0 in filters', () => {
      const result = SearchUnifiedInput.safeParse({
        query: 'test',
        filters: { min_quality_score: -1.0 },
      });
      expect(result.success).toBe(false);
    });

    it('should default filters to empty object', () => {
      const result = SearchUnifiedInput.parse({ query: 'test' });
      expect(result.filters).toBeDefined();
      expect(result.filters.document_filter).toBeUndefined();
      expect(result.filters.min_quality_score).toBeUndefined();
    });
  });

  describe('SearchUnifiedInput - keyword mode', () => {
    it('should accept keyword mode', () => {
      const result = SearchUnifiedInput.parse({ query: 'termination clause', mode: 'keyword' });
      expect(result.query).toBe('termination clause');
      expect(result.mode).toBe('keyword');
    });

    it('should accept phrase_search flag', () => {
      const result = SearchUnifiedInput.parse({ query: 'exact phrase', mode: 'keyword', phrase_search: true });
      expect(result.phrase_search).toBe(true);
    });
  });

  describe('SearchUnifiedInput - semantic mode', () => {
    it('should accept semantic mode', () => {
      const result = SearchUnifiedInput.parse({ query: 'contract termination', mode: 'semantic' });
      expect(result.mode).toBe('semantic');
    });

    it('should accept similarity threshold between 0 and 1', () => {
      const result = SearchUnifiedInput.parse({
        query: 'test',
        mode: 'semantic',
        similarity_threshold: 0.5,
      });
      expect(result.similarity_threshold).toBe(0.5);
    });

    it('should reject similarity threshold above 1', () => {
      expect(() =>
        SearchUnifiedInput.parse({ query: 'test', mode: 'semantic', similarity_threshold: 1.5 })
      ).toThrow();
    });
  });

  describe('SearchUnifiedInput - hybrid mode', () => {
    it('should accept valid input with defaults', () => {
      const result = SearchUnifiedInput.parse({ query: 'test', mode: 'hybrid' });
      expect(result.bm25_weight).toBe(1.0);
      expect(result.semantic_weight).toBe(1.0);
      expect(result.rrf_k).toBe(60);
    });

    it('should accept custom weights (no sum constraint)', () => {
      const result = SearchUnifiedInput.parse({
        query: 'test',
        mode: 'hybrid',
        bm25_weight: 1.5,
        semantic_weight: 0.5,
      });
      expect(result.bm25_weight).toBe(1.5);
      expect(result.semantic_weight).toBe(0.5);
    });

    it('should reject weights above 2', () => {
      expect(() => SearchUnifiedInput.parse({ query: 'test', mode: 'hybrid', bm25_weight: 2.5 })).toThrow();
    });

    it('should accept custom rrf_k', () => {
      const result = SearchUnifiedInput.parse({ query: 'test', mode: 'hybrid', rrf_k: 30 });
      expect(result.rrf_k).toBe(30);
    });

    it('should reject rrf_k below 1', () => {
      expect(() => SearchUnifiedInput.parse({ query: 'test', mode: 'hybrid', rrf_k: 0 })).toThrow();
    });

    it('should accept auto_route', () => {
      const result = SearchUnifiedInput.parse({ query: 'test', mode: 'hybrid', auto_route: true });
      expect(result.auto_route).toBe(true);
    });
  });

  describe('SearchUnifiedInput - mode enum', () => {
    it('should reject invalid mode', () => {
      expect(() => SearchUnifiedInput.parse({ query: 'test', mode: 'invalid' })).toThrow();
    });

    it('should accept all three modes', () => {
      for (const mode of ['keyword', 'semantic', 'hybrid']) {
        const result = SearchUnifiedInput.parse({ query: 'test', mode });
        expect(result.mode).toBe(mode);
      }
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
