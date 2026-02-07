/**
 * Search MCP Tools
 *
 * Tools: ocr_search, ocr_search_semantic, ocr_search_hybrid, ocr_fts_manage
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/search
 */

import { z } from 'zod';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  SearchSemanticInput,
  SearchInput,
  SearchHybridInput,
  FTSManageInput,
} from '../utils/validation.js';
import {
  formatResponse,
  handleError,
  type ToolResponse,
  type ToolDefinition,
} from './shared.js';
import { BM25SearchService } from '../services/search/bm25.js';
import { RRFFusion } from '../services/search/fusion.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** Provenance record summary for search results */
interface ProvenanceSummary {
  id: string;
  type: string;
  chain_depth: number;
  processor: string;
  content_hash: string;
}

/**
 * Format provenance chain as summary array
 */
function formatProvenanceChain(db: ReturnType<typeof requireDatabase>['db'], provenanceId: string): ProvenanceSummary[] {
  const chain = db.getProvenanceChain(provenanceId);
  return chain.map(p => ({
    id: p.id,
    type: p.type,
    chain_depth: p.chain_depth,
    processor: p.processor,
    content_hash: p.content_hash,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_search_semantic - Semantic vector search
 */
export async function handleSearchSemantic(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSemanticInput, params);
    const { db, vector } = requireDatabase();

    // Generate query embedding
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(input.query);

    // Search for similar vectors
    const results = vector.searchSimilar(queryVector, {
      limit: input.limit,
      threshold: input.similarity_threshold,
      documentFilter: input.document_filter,
    });

    // Format results with optional provenance
    const formattedResults = results.map(r => {
      const result: Record<string, unknown> = {
        embedding_id: r.embedding_id,
        chunk_id: r.chunk_id,
        image_id: r.image_id,
        document_id: r.document_id,
        result_type: r.result_type,
        similarity_score: r.similarity_score,
        original_text: r.original_text,
        source_file_path: r.source_file_path,
        source_file_name: r.source_file_name,
        page_number: r.page_number,
        character_start: r.character_start,
        character_end: r.character_end,
        chunk_index: r.chunk_index,
        total_chunks: r.total_chunks,
      };

      if (input.include_provenance) {
        result.provenance = formatProvenanceChain(db, r.provenance_id);
      }

      return result;
    });

    return formatResponse(successResult({
      query: input.query,
      results: formattedResults,
      total: formattedResults.length,
      threshold: input.similarity_threshold,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_search - BM25 full-text keyword search
 * Searches both chunks (text) and VLM descriptions (images)
 */
export async function handleSearch(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchInput, params);
    const { db } = requireDatabase();

    const bm25 = new BM25SearchService(db.getConnection());
    const limit = input.limit ?? 10;

    // Search chunks FTS
    const chunkResults = bm25.search({
      query: input.query,
      limit,
      phraseSearch: input.phrase_search,
      documentFilter: input.document_filter,
      includeHighlight: input.include_highlight,
    });

    // Search VLM FTS
    const vlmResults = bm25.searchVLM({
      query: input.query,
      limit,
      phraseSearch: input.phrase_search,
      documentFilter: input.document_filter,
      includeHighlight: input.include_highlight,
    });

    // Merge by score (higher is better), apply combined limit
    const allResults = [...chunkResults, ...vlmResults]
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, limit);

    // Re-rank after merge
    const rankedResults = allResults.map((r, i) => ({ ...r, rank: i + 1 }));

    const results = rankedResults.map(r => {
      if (!input.include_provenance) return r;
      return { ...r, provenance_chain: formatProvenanceChain(db, r.provenance_id) };
    });

    return formatResponse(successResult({
      query: input.query,
      search_type: 'bm25',
      results,
      total: results.length,
      sources: {
        chunk_count: chunkResults.length,
        vlm_count: vlmResults.length,
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_search_hybrid - Hybrid search using Reciprocal Rank Fusion
 * BM25 side now includes both chunk and VLM results
 */
export async function handleSearchHybrid(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchHybridInput, params);
    const { db, vector } = requireDatabase();
    const limit = input.limit ?? 10;

    // Get BM25 results (chunks + VLM)
    const bm25 = new BM25SearchService(db.getConnection());
    const bm25ChunkResults = bm25.search({
      query: input.query,
      limit: limit * 2,
      documentFilter: input.document_filter,
    });
    const bm25VlmResults = bm25.searchVLM({
      query: input.query,
      limit: limit * 2,
      documentFilter: input.document_filter,
    });

    // Merge BM25 results by score
    const allBm25 = [...bm25ChunkResults, ...bm25VlmResults]
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, limit * 2)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // Get semantic results
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(input.query);
    const semanticResults = vector.searchSimilar(queryVector, {
      limit: limit * 2,
      documentFilter: input.document_filter,
    });

    // Convert to ranked format for RRF
    const bm25Ranked = allBm25.map(r => ({
      chunk_id: r.chunk_id,
      image_id: r.image_id,
      embedding_id: r.embedding_id ?? `bm25-${r.result_type}-${r.chunk_id ?? r.image_id}`,
      document_id: r.document_id,
      original_text: r.original_text,
      result_type: r.result_type,
      source_file_path: r.source_file_path,
      source_file_name: r.source_file_name,
      source_file_hash: r.source_file_hash,
      page_number: r.page_number,
      character_start: r.character_start,
      character_end: r.character_end,
      chunk_index: r.chunk_index,
      provenance_id: r.provenance_id,
      content_hash: r.content_hash,
      rank: r.rank,
      score: r.bm25_score,
    }));

    const semanticRanked = semanticResults.map((r, i) => ({
      chunk_id: r.chunk_id,
      image_id: r.image_id,
      embedding_id: r.embedding_id,
      document_id: r.document_id,
      original_text: r.original_text,
      result_type: r.result_type,
      source_file_path: r.source_file_path,
      source_file_name: r.source_file_name,
      source_file_hash: r.source_file_hash,
      page_number: r.page_number,
      character_start: r.character_start,
      character_end: r.character_end,
      chunk_index: r.chunk_index,
      provenance_id: r.provenance_id,
      content_hash: r.content_hash,
      rank: i + 1,
      score: r.similarity_score,
    }));

    // Fuse with RRF
    const fusion = new RRFFusion({
      k: input.rrf_k,
      bm25Weight: input.bm25_weight,
      semanticWeight: input.semantic_weight,
    });

    const rawResults = fusion.fuse(bm25Ranked, semanticRanked, limit);

    const results = rawResults.map(r => {
      if (!input.include_provenance) return r;
      return { ...r, provenance_chain: formatProvenanceChain(db, r.provenance_id) };
    });

    return formatResponse(successResult({
      query: input.query,
      search_type: 'rrf_hybrid',
      config: {
        bm25_weight: input.bm25_weight,
        semantic_weight: input.semantic_weight,
        rrf_k: input.rrf_k,
      },
      results,
      total: results.length,
      sources: {
        bm25_chunk_count: bm25ChunkResults.length,
        bm25_vlm_count: bm25VlmResults.length,
        semantic_count: semanticResults.length,
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_fts_manage - Manage FTS5 indexes (rebuild or check status)
 * Covers both chunks FTS and VLM FTS indexes
 */
export async function handleFTSManage(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(FTSManageInput, params);
    const { db } = requireDatabase();
    const bm25 = new BM25SearchService(db.getConnection());

    if (input.action === 'rebuild') {
      const result = bm25.rebuildIndex();
      return formatResponse(successResult({ operation: 'fts_rebuild', ...result }));
    }

    const status = bm25.getStatus();
    return formatResponse(successResult(status));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Search tools collection for MCP server registration
 */
export const searchTools: Record<string, ToolDefinition> = {
  ocr_search: {
    description: 'Search documents using BM25 full-text ranking (best for exact terms, codes, IDs)',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum results'),
      phrase_search: z.boolean().default(false).describe('Treat as exact phrase'),
      include_highlight: z.boolean().default(true).describe('Include highlighted snippets'),
      include_provenance: z.boolean().default(false).describe('Include provenance chain'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
    },
    handler: handleSearch,
  },
  ocr_search_semantic: {
    description: 'Search documents using semantic similarity (vector search)',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
      similarity_threshold: z.number().min(0).max(1).default(0.7).describe('Minimum similarity score (0-1)'),
      include_provenance: z.boolean().default(false).describe('Include provenance chain in results'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
    },
    handler: handleSearchSemantic,
  },
  ocr_search_hybrid: {
    description: 'Hybrid search using Reciprocal Rank Fusion (BM25 + semantic)',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum results'),
      bm25_weight: z.number().min(0).max(2).default(1.0).describe('BM25 result weight'),
      semantic_weight: z.number().min(0).max(2).default(1.0).describe('Semantic result weight'),
      rrf_k: z.number().int().min(1).max(100).default(60).describe('RRF smoothing constant'),
      include_provenance: z.boolean().default(false).describe('Include provenance chain'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
    },
    handler: handleSearchHybrid,
  },
  ocr_fts_manage: {
    description: 'Manage FTS5 full-text search index (rebuild or check status)',
    inputSchema: {
      action: z.enum(['rebuild', 'status']).describe('Action: rebuild index or check status'),
    },
    handler: handleFTSManage,
  },
};

export default searchTools;
