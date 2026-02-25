/**
 * Query Intelligence - Classify queries and recommend search strategy
 *
 * Pure heuristic classification - no Gemini calls needed.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/search/query-classifier
 */

export interface QueryClassification {
  query_type: 'exact' | 'semantic' | 'mixed';
  recommended_strategy: 'bm25' | 'semantic' | 'hybrid';
  confidence: number;
  reasoning: string;
  detected_patterns: string[];
  /** Whether the query contains table-related keywords */
  is_table_query: boolean;
}

// Pattern detection rules (no Gemini needed - pure heuristics)
const EXACT_PATTERNS: RegExp[] = [
  /^["'].*["']$/, // Quoted strings
  /\b[A-Z]{2,}-\d+\b/, // IDs like "ABC-123"
  /\b\d{4}-\d{2}-\d{2}\b/, // Dates
  /\b[A-Z][a-z]+ [A-Z][a-z]+\b/, // Proper names
  /\b\d{3,}\b/, // Long numbers
  /[@#$%]\w+/, // Special tokens
];

const SEMANTIC_INDICATORS: RegExp[] = [
  /\b(about|regarding|related to|similar to|like|concerning)\b/i,
  /\b(what|how|why|when|where|who)\b/i,
  /\b(documents?|files?|papers?|records?) (about|on|regarding)\b/i,
];

/** Patterns indicating the query targets table content */
const TABLE_QUERY_PATTERNS: RegExp[] = [
  /\b(table|tables|tabular)\b/i,
  /\b(column|columns|row|rows|cell|cells)\b/i,
  /\b(spreadsheet|grid|matrix)\b/i,
  /\b(header|headers)\s+(of|in|from)\b/i,
];

/**
 * Check if a query targets table content (columns, rows, etc.).
 * Used to trigger table-aware query expansion.
 */
export function isTableQuery(query: string): boolean {
  return TABLE_QUERY_PATTERNS.some((p) => p.test(query));
}

/**
 * Classify a query string and recommend a search strategy.
 *
 * Uses pure heuristic pattern matching to determine whether a query
 * is best suited for exact (BM25), semantic (vector), or hybrid search.
 *
 * @param query - The search query string to classify
 * @returns Classification with recommended strategy, confidence, and reasoning
 */
export function classifyQuery(query: string): QueryClassification {
  const detectedPatterns: string[] = [];
  let exactScore = 0;
  let semanticScore = 0;
  const tableQuery = isTableQuery(query);

  for (const pattern of EXACT_PATTERNS) {
    if (pattern.test(query)) {
      exactScore += 2;
      detectedPatterns.push(`exact:${pattern.source.slice(0, 20)}`);
    }
  }

  for (const pattern of SEMANTIC_INDICATORS) {
    if (pattern.test(query)) {
      semanticScore += 2;
      detectedPatterns.push(`semantic:${pattern.source.slice(0, 20)}`);
    }
  }

  // Length heuristic
  if (query.split(/\s+/).length <= 2) {
    exactScore += 1;
    detectedPatterns.push('short_query');
  } else if (query.split(/\s+/).length >= 6) {
    semanticScore += 1;
    detectedPatterns.push('long_query');
  }

  const total = exactScore + semanticScore;
  if (total === 0) {
    return {
      query_type: 'mixed',
      recommended_strategy: 'hybrid',
      confidence: 0.5,
      reasoning: 'No strong indicators detected, defaulting to hybrid',
      detected_patterns: [],
      is_table_query: tableQuery,
    };
  }

  const exactRatio = exactScore / total;
  if (exactRatio > 0.7) {
    return {
      query_type: 'exact',
      recommended_strategy: 'bm25',
      confidence: Math.min(exactRatio, 0.95),
      reasoning: `Strong exact-match patterns detected: ${detectedPatterns.join(', ')}`,
      detected_patterns: detectedPatterns,
      is_table_query: tableQuery,
    };
  } else if (exactRatio < 0.3) {
    return {
      query_type: 'semantic',
      recommended_strategy: 'semantic',
      confidence: Math.min(1 - exactRatio, 0.95),
      reasoning: `Semantic query patterns detected: ${detectedPatterns.join(', ')}`,
      detected_patterns: detectedPatterns,
      is_table_query: tableQuery,
    };
  }

  return {
    query_type: 'mixed',
    recommended_strategy: 'hybrid',
    confidence: 0.6,
    reasoning: `Mix of exact and semantic patterns: ${detectedPatterns.join(', ')}`,
    detected_patterns: detectedPatterns,
    is_table_query: tableQuery,
  };
}
