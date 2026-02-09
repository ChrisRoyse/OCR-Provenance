/**
 * Gemini-based Search Re-ranker
 *
 * Re-ranks search results using Gemini for contextual relevance scoring.
 * Uses GeminiClient.fast() for low-latency JSON output.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/search/reranker
 */

import { GeminiClient } from '../gemini/client.js';

interface RerankResult {
  index: number;
  relevance_score: number;
  reasoning: string;
}

const RERANK_SCHEMA = {
  type: 'object' as const,
  properties: {
    rankings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          index: { type: 'number' as const },
          relevance_score: { type: 'number' as const },
          reasoning: { type: 'string' as const },
        },
        required: ['index', 'relevance_score', 'reasoning'],
      },
    },
  },
  required: ['rankings'],
};

/**
 * Re-rank search results using Gemini AI for contextual relevance scoring.
 *
 * Takes the top results (max 20 to stay within token limits), sends them
 * to Gemini for relevance scoring, and returns sorted results.
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

  const excerpts = toRerank.map(r => String(r.original_text));
  const prompt = buildRerankPrompt(query, excerpts);

  const client = new GeminiClient();
  const response = await client.fast(prompt, RERANK_SCHEMA);

  const parsed = JSON.parse(response.text);
  const rankings = (parsed.rankings || []) as RerankResult[];

  // Sort by relevance score descending, take maxResults
  return rankings
    .filter(r => r.index >= 0 && r.index < toRerank.length)
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, maxResults)
    .map(r => ({
      original_index: r.index,
      relevance_score: r.relevance_score,
      reasoning: r.reasoning,
    }));
}

/**
 * Build the re-rank prompt (exported for testing without API calls).
 *
 * @param query - Search query
 * @param excerpts - Array of text excerpts
 * @returns Formatted prompt string
 */
export function buildRerankPrompt(
  query: string,
  excerpts: string[]
): string {
  return `You are a legal document search relevance expert. Given a search query and a list of document excerpts, score each excerpt's relevance to the query on a scale of 0-10.

Query: "${query}"

Excerpts:
${excerpts.map((text, i) => `[${i}] ${text.slice(0, 500)}`).join('\n\n')}

Score each excerpt's relevance to the query. Return a JSON object with a "rankings" array containing objects with "index" (number), "relevance_score" (0-10), and "reasoning" (string).`;
}

/**
 * Get the re-rank schema (exported for testing).
 */
export function getRerankSchema(): object {
  return { ...RERANK_SCHEMA };
}
