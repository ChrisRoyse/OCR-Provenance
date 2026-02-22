/**
 * Unit Tests for Local Cross-Encoder Re-ranking
 *
 * Tests the reranker module's prompt builder and empty-input handling.
 * Reranking uses a local cross-encoder model (ms-marco-MiniLM-L-12-v2)
 * via the Python reranker worker. No Gemini/cloud dependency.
 *
 * @module tests/unit/services/search/reranker
 */

import { describe, it, expect } from 'vitest';
import { buildRerankPrompt, rerankResults } from '../../../../src/services/search/reranker.js';

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

  describe('rerankResults', () => {
    it('returns empty array for empty results', async () => {
      const result = await rerankResults('query', []);
      expect(result).toEqual([]);
    });

    // Note: Testing with the actual Python cross-encoder is intentionally skipped
    // in unit tests to avoid dependency on sentence-transformers installation.
    // The rerankResults function with actual results is tested in integration tests.
  });
});
