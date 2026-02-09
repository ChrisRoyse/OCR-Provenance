/**
 * Unit Tests for SE-2: Gemini Re-ranking
 *
 * Tests the reranker module's structure and prompt construction.
 * Since we cannot call the actual Gemini API in unit tests, we test
 * the prompt builder, schema structure, and empty-input handling.
 *
 * @module tests/unit/services/search/reranker
 */

import { describe, it, expect } from 'vitest';
import {
  buildRerankPrompt,
  getRerankSchema,
  rerankResults,
} from '../../../../src/services/search/reranker.js';

describe('Reranker', () => {
  describe('buildRerankPrompt', () => {
    it('includes the query in the prompt', () => {
      const prompt = buildRerankPrompt('injury claim', ['Text about injuries']);
      expect(prompt).toContain('injury claim');
    });

    it('includes all excerpts with indices', () => {
      const excerpts = [
        'First document about injuries',
        'Second document about treatment',
        'Third document about recovery',
      ];
      const prompt = buildRerankPrompt('medical treatment', excerpts);
      expect(prompt).toContain('[0]');
      expect(prompt).toContain('[1]');
      expect(prompt).toContain('[2]');
      expect(prompt).toContain('First document about injuries');
      expect(prompt).toContain('Second document about treatment');
      expect(prompt).toContain('Third document about recovery');
    });

    it('truncates long excerpts to 500 chars', () => {
      const longText = 'A'.repeat(1000);
      const prompt = buildRerankPrompt('query', [longText]);
      // The excerpt in the prompt should be at most 500 chars
      const match = prompt.match(/\[0\] (A+)/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBe(500);
    });

    it('handles empty excerpts array', () => {
      const prompt = buildRerankPrompt('query', []);
      expect(prompt).toContain('query');
      // Should not contain any index markers
      expect(prompt).not.toContain('[0]');
    });

    it('includes instruction to return JSON rankings', () => {
      const prompt = buildRerankPrompt('test', ['excerpt']);
      expect(prompt).toContain('rankings');
      expect(prompt).toContain('relevance_score');
      expect(prompt).toContain('reasoning');
    });
  });

  describe('getRerankSchema', () => {
    it('returns a valid JSON schema object', () => {
      const schema = getRerankSchema() as Record<string, unknown>;
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema).toHaveProperty('required');
    });

    it('has rankings array in schema', () => {
      const schema = getRerankSchema() as Record<string, Record<string, unknown>>;
      expect(schema.properties).toHaveProperty('rankings');
      const rankings = schema.properties.rankings as Record<string, unknown>;
      expect(rankings).toHaveProperty('type', 'array');
    });

    it('ranking items have required fields', () => {
      const schema = getRerankSchema() as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
      const items = schema.properties.rankings.items as Record<string, unknown>;
      expect(items).toHaveProperty('required');
      const required = items.required as string[];
      expect(required).toContain('index');
      expect(required).toContain('relevance_score');
      expect(required).toContain('reasoning');
    });
  });

  describe('rerankResults', () => {
    it('returns empty array for empty results', async () => {
      const result = await rerankResults('query', []);
      expect(result).toEqual([]);
    });

    // Note: Testing with actual Gemini API calls is intentionally skipped
    // because unit tests should not depend on external services.
    // The rerankResults function with actual results is tested in integration tests.
  });
});
