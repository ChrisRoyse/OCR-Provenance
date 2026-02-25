/**
 * Local Cross-Encoder Search Re-ranker
 *
 * Re-ranks search results using a local cross-encoder model (ms-marco-MiniLM-L-12-v2)
 * via the Python reranker worker. NO Gemini/cloud dependency.
 *
 * If the local model is not available (sentence-transformers not installed, model not
 * downloaded, Python error), returns results as-is with a console.error() warning.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/search/reranker
 */

import { localRerank } from './local-reranker.js';

/**
 * Re-rank search results using a local cross-encoder model.
 *
 * Takes the top results (max 20), sends them to the local Python cross-encoder
 * for relevance scoring, and returns sorted results.
 *
 * If the local model is unavailable, returns the original results in their existing
 * order with reasoning indicating no reranking was performed.
 *
 * @param query - The original search query
 * @param results - Search results with original_text field
 * @param maxResults - Maximum results to return after re-ranking (default: 10)
 * @returns Re-ranked results with scores and reasoning
 */
export async function rerankResults(
  query: string,
  results: Array<{ original_text: string; [key: string]: unknown }>,
  maxResults: number = 10
): Promise<Array<{ original_index: number; relevance_score: number; reasoning: string }>> {
  if (results.length === 0) return [];

  // Take top results to re-rank (max 20 to stay within token limits)
  const toRerank = results.slice(0, Math.min(results.length, 20));

  // Build passages for the local reranker
  const passages = toRerank.map((r, i) => {
    let originalScore = 0;
    if (typeof r.bm25_score === 'number') {
      originalScore = r.bm25_score;
    } else if (typeof r.score === 'number') {
      originalScore = r.score;
    }
    return { index: i, text: String(r.original_text), original_score: originalScore };
  });

  const localResults = await localRerank(query, passages);

  if (localResults === null) {
    // Local model not available - return results as-is in original order
    console.error(
      '[reranker] Local cross-encoder unavailable. Returning results without reranking. ' +
        'Install sentence-transformers for local reranking: pip install sentence-transformers'
    );
    return toRerank.slice(0, maxResults).map((_, i) => ({
      original_index: i,
      relevance_score: 0,
      reasoning: 'local cross-encoder unavailable, original order preserved',
    }));
  }

  // Filter to valid indices only
  const validResults = localResults.filter((r) => r.index >= 0 && r.index < toRerank.length);

  if (validResults.length === 0 && toRerank.length > 0) {
    console.error(
      `[reranker] Cross-encoder returned 0 valid results from ${toRerank.length} inputs. ` +
        'Returning results without reranking.'
    );
    return toRerank.slice(0, maxResults).map((_, i) => ({
      original_index: i,
      relevance_score: 0,
      reasoning: 'cross-encoder returned no valid results, original order preserved',
    }));
  }

  // Sort by relevance score descending, take maxResults
  return validResults
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, maxResults)
    .map((r) => ({
      original_index: r.index,
      relevance_score: r.relevance_score,
      reasoning: `cross-encoder score: ${r.relevance_score.toFixed(4)}`,
    }));
}

/**
 * Build a re-rank prompt string (legacy helper, used only by unit tests).
 *
 * @param query - Search query
 * @param excerpts - Array of text excerpts
 * @returns Formatted prompt string
 */
export function buildRerankPrompt(query: string, excerpts: string[]): string {
  const formattedExcerpts = excerpts.map((text, i) => `[${i}] ${text.slice(0, 500)}`).join('\n\n');

  return `You are a legal document search relevance expert. Given a search query and a list of document excerpts, score each excerpt's relevance to the query on a scale of 0-10.

Query: "${query}"

Excerpts:
${formattedExcerpts}

Score each excerpt's relevance to the query. Return a JSON object with a "rankings" array containing objects with "index" (number), "relevance_score" (0-10), and "reasoning" (string).`;
}
