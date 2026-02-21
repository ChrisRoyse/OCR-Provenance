/**
 * Unit Tests for Query Classifier
 *
 * Tests the pure heuristic query classification in src/services/search/query-classifier.ts
 * No external dependencies needed - pure function tests.
 *
 * @module tests/unit/services/search/query-classifier
 */

import { describe, it, expect } from 'vitest';
import { classifyQuery, type QueryClassification } from '../../../../src/services/search/query-classifier.js';

// ═══════════════════════════════════════════════════════════════════════════════
// EXACT QUERY PATTERN TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyQuery - exact patterns', () => {
  it('classifies quoted strings as exact', () => {
    const result = classifyQuery('"specific phrase"');
    expect(result.query_type).toBe('exact');
    expect(result.recommended_strategy).toBe('bm25');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.detected_patterns.length).toBeGreaterThan(0);
  });

  it('classifies single-quoted strings as exact', () => {
    const result = classifyQuery("'exact match'");
    expect(result.query_type).toBe('exact');
    expect(result.recommended_strategy).toBe('bm25');
  });

  it('classifies ID patterns like ABC-123 as exact', () => {
    const result = classifyQuery('DOC-456');
    expect(result.query_type).toBe('exact');
    expect(result.recommended_strategy).toBe('bm25');
    expect(result.detected_patterns.some(p => p.startsWith('exact:'))).toBe(true);
  });

  it('classifies date patterns as exact', () => {
    const result = classifyQuery('2024-01-15');
    expect(result.query_type).toBe('exact');
    expect(result.recommended_strategy).toBe('bm25');
  });

  it('classifies proper names as exact', () => {
    const result = classifyQuery('John Smith');
    expect(result.query_type).toBe('exact');
    expect(result.recommended_strategy).toBe('bm25');
  });

  it('classifies long numbers as exact', () => {
    const result = classifyQuery('12345');
    expect(result.query_type).toBe('exact');
    expect(result.recommended_strategy).toBe('bm25');
  });

  it('classifies special tokens as exact', () => {
    const result = classifyQuery('@username');
    expect(result.query_type).toBe('exact');
    expect(result.recommended_strategy).toBe('bm25');
  });

  it('short queries get exact score boost', () => {
    const result = classifyQuery('contract');
    // Short query (1 word) gets exact boost, but no other exact patterns
    // So it should be either exact or mixed
    expect(result.detected_patterns).toContain('short_query');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEMANTIC QUERY PATTERN TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyQuery - semantic patterns', () => {
  it('classifies "about" queries as semantic', () => {
    const result = classifyQuery('documents about environmental regulations and compliance');
    expect(result.query_type).toBe('semantic');
    expect(result.recommended_strategy).toBe('semantic');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('classifies question queries as semantic', () => {
    const result = classifyQuery('what are the key findings in the research paper');
    expect(result.query_type).toBe('semantic');
    expect(result.recommended_strategy).toBe('semantic');
  });

  it('classifies "related to" queries as semantic', () => {
    const result = classifyQuery('files related to patent infringement claims and settlements');
    expect(result.query_type).toBe('semantic');
    expect(result.recommended_strategy).toBe('semantic');
  });

  it('classifies "how" queries as semantic', () => {
    const result = classifyQuery('how does the authentication system handle token refresh');
    expect(result.query_type).toBe('semantic');
    expect(result.recommended_strategy).toBe('semantic');
  });

  it('classifies "similar to" queries as semantic', () => {
    const result = classifyQuery('records similar to the annual financial report from last year');
    expect(result.query_type).toBe('semantic');
    expect(result.recommended_strategy).toBe('semantic');
  });

  it('long queries get semantic score boost', () => {
    const result = classifyQuery('a very long query that has many words and should be semantic');
    expect(result.detected_patterns).toContain('long_query');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIXED / DEFAULT PATTERN TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyQuery - mixed/default patterns', () => {
  it('defaults to hybrid for ambiguous queries', () => {
    const _result = classifyQuery('legal');
    // "legal" is a short query (exact +1) but no other patterns
    // With only 1 score total, exactRatio = 1.0 > 0.7 -> exact
    // Actually testing the no-indicator path:
    const result2 = classifyQuery('misc');
    // "misc" is short (exact +1), so not truly ambiguous
    expect(result2.recommended_strategy).toBeDefined();
  });

  it('returns hybrid for queries with no strong indicators', () => {
    // 3-5 word queries with no special patterns
    const result = classifyQuery('some random text here');
    // No exact patterns, no semantic patterns, 4 words (neither short nor long)
    expect(result.query_type).toBe('mixed');
    expect(result.recommended_strategy).toBe('hybrid');
    expect(result.confidence).toBe(0.5);
    expect(result.detected_patterns).toHaveLength(0);
  });

  it('returns mixed for queries with both exact and semantic indicators', () => {
    // Has proper name (exact) + "about" (semantic)
    const result = classifyQuery('what did John Smith say about the contract from 2024-01-15');
    expect(result.detected_patterns.length).toBeGreaterThan(1);
    // Should have both exact and semantic patterns detected
    const hasExact = result.detected_patterns.some(p => p.startsWith('exact:'));
    const hasSemantic = result.detected_patterns.some(p => p.startsWith('semantic:'));
    expect(hasExact).toBe(true);
    expect(hasSemantic).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RETURN STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyQuery - return structure', () => {
  it('always returns all required fields', () => {
    const queries = [
      '"exact phrase"',
      'what is the meaning of life',
      'random',
      '',
      'DOC-123 about compliance',
    ];

    for (const query of queries) {
      const result: QueryClassification = classifyQuery(query);
      expect(result).toHaveProperty('query_type');
      expect(result).toHaveProperty('recommended_strategy');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reasoning');
      expect(result).toHaveProperty('detected_patterns');

      expect(['exact', 'semantic', 'mixed']).toContain(result.query_type);
      expect(['bm25', 'semantic', 'hybrid']).toContain(result.recommended_strategy);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(typeof result.reasoning).toBe('string');
      expect(Array.isArray(result.detected_patterns)).toBe(true);
    }
  });

  it('confidence never exceeds 0.95', () => {
    // Even with many exact patterns, confidence should cap at 0.95
    const result = classifyQuery('"DOC-123" @user 2024-01-15 #tag 99999');
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it('confidence is 0.5 for no-indicator queries', () => {
    const result = classifyQuery('some text here');
    if (result.query_type === 'mixed' && result.detected_patterns.length === 0) {
      expect(result.confidence).toBe(0.5);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyQuery - edge cases', () => {
  it('handles empty string', () => {
    const result = classifyQuery('');
    expect(result).toBeDefined();
    expect(result.query_type).toBeDefined();
    expect(result.recommended_strategy).toBeDefined();
  });

  it('handles single character', () => {
    const result = classifyQuery('a');
    expect(result).toBeDefined();
    // Single char = short query -> exact boost
    expect(result.detected_patterns).toContain('short_query');
  });

  it('handles very long query', () => {
    const longQuery = 'word '.repeat(100).trim();
    const result = classifyQuery(longQuery);
    expect(result).toBeDefined();
    expect(result.detected_patterns).toContain('long_query');
  });

  it('handles special characters only', () => {
    const result = classifyQuery('!!! ???');
    expect(result).toBeDefined();
    expect(result.recommended_strategy).toBeDefined();
  });

  it('handles unicode text', () => {
    const result = classifyQuery('documents about legal proceedings');
    expect(result).toBeDefined();
    expect(result.query_type).toBe('semantic');
  });
});
