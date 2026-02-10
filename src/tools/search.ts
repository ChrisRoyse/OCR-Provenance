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

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { DatabaseService } from '../services/storage/database/index.js';
import { VectorService } from '../services/storage/vector.js';
import { requireDatabase, getDefaultStoragePath } from '../server/state.js';
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
import { expandQueryWithKG, expandQueryWithCoMentioned, getExpandedTerms } from '../services/search/query-expander.js';
import { rerankResults, type EdgeInfo } from '../services/search/reranker.js';
import { getEntitiesForChunks, getDocumentIdsForEntities, getEdgesForNode, getKnowledgeNode, type ChunkEntityInfo } from '../services/storage/database/knowledge-graph-operations.js';

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
 * Resolve metadata_filter to document IDs.
 * Returns undefined if no metadata filter or no matches, allowing all documents.
 * Returns empty array if filter specified but no matches (blocks all results).
 */
function resolveMetadataFilter(
  db: ReturnType<typeof requireDatabase>['db'],
  metadataFilter?: { doc_title?: string; doc_author?: string; doc_subject?: string },
  existingDocFilter?: string[],
): string[] | undefined {
  if (!metadataFilter) return existingDocFilter;
  const { doc_title, doc_author, doc_subject } = metadataFilter;
  if (!doc_title && !doc_author && !doc_subject) return existingDocFilter;

  let sql = 'SELECT id FROM documents WHERE 1=1';
  const params: string[] = [];
  if (doc_title) { sql += ' AND doc_title LIKE ?'; params.push(`%${doc_title}%`); }
  if (doc_author) { sql += ' AND doc_author LIKE ?'; params.push(`%${doc_author}%`); }
  if (doc_subject) { sql += ' AND doc_subject LIKE ?'; params.push(`%${doc_subject}%`); }

  // If existing doc filter, intersect with it
  if (existingDocFilter && existingDocFilter.length > 0) {
    sql += ` AND id IN (${existingDocFilter.map(() => '?').join(',')})`;
    params.push(...existingDocFilter);
  }

  const rows = db.getConnection().prepare(sql).all(...params) as { id: string }[];
  return rows.map(r => r.id);
}

/**
 * Resolve min_quality_score to filtered document IDs.
 * If minQualityScore is undefined, returns existingDocFilter unchanged.
 * If set, queries for documents with OCR quality >= threshold and intersects with existing filter.
 */
function resolveQualityFilter(
  db: ReturnType<typeof requireDatabase>['db'],
  minQualityScore: number | undefined,
  existingDocFilter: string[] | undefined,
): string[] | undefined {
  if (minQualityScore === undefined) return existingDocFilter;
  const rows = db.getConnection().prepare(
    `SELECT DISTINCT d.id FROM documents d
     JOIN ocr_results o ON o.document_id = d.id
     WHERE o.parse_quality_score >= ?`
  ).all(minQualityScore) as { id: string }[];
  const qualityIds = new Set(rows.map(r => r.id));
  if (!existingDocFilter) {
    // Return sentinel non-matchable ID when no documents pass quality filter,
    // so BM25/semantic/hybrid search applies the empty IN() filter correctly.
    if (qualityIds.size === 0) return ['__no_match__'];
    return [...qualityIds];
  }
  const filtered = existingDocFilter.filter(id => qualityIds.has(id));
  if (filtered.length === 0) return ['__no_match__'];
  return filtered;
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
    const conn = db.getConnection();

    // Resolve metadata filter to document IDs, then chain through quality filter
    let documentFilter = resolveQualityFilter(db, input.min_quality_score,
      resolveMetadataFilter(db, input.metadata_filter, input.document_filter));

    // PAR-1: Entity filter - resolve entity names/types to document IDs
    if (input.entity_filter) {
      const entityDocIds = getDocumentIdsForEntities(
        conn,
        input.entity_filter.entity_names,
        input.entity_filter.entity_types,
      );
      if (entityDocIds.length === 0) {
        return formatResponse(successResult({
          query: input.query,
          results: [],
          total: 0,
          threshold: input.similarity_threshold,
          entity_filter_applied: true,
          entity_filter_document_count: 0,
        }));
      }
      if (documentFilter && documentFilter.length > 0) {
        const entitySet = new Set(entityDocIds);
        documentFilter = documentFilter.filter(id => entitySet.has(id));
        if (documentFilter.length === 0) {
          return formatResponse(successResult({
            query: input.query,
            results: [],
            total: 0,
            threshold: input.similarity_threshold,
            entity_filter_applied: true,
            entity_filter_document_count: 0,
          }));
        }
      } else {
        documentFilter = entityDocIds;
      }
    }

    // Generate query embedding
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(input.query);

    // PAR-1: Over-fetch for reranking if needed
    const limit = input.limit ?? 10;
    const searchLimit = input.rerank ? Math.max(limit * 2, 20) : limit;

    // Search for similar vectors
    const results = vector.searchSimilar(queryVector, {
      limit: searchLimit,
      threshold: input.similarity_threshold,
      documentFilter,
    });

    // Entity enrichment: collect chunk IDs and fetch entities if requested
    let entityMap: Map<string, ChunkEntityInfo[]> | undefined;
    if (input.include_entities || input.rerank) {
      const chunkIds = results.map(r => r.chunk_id).filter((id): id is string => id != null);
      if (chunkIds.length > 0) {
        entityMap = getEntitiesForChunks(conn, chunkIds);
      }
    }

    // PAR-1: Re-rank results using Gemini AI if requested
    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && results.length > 0) {
      // Build entity context map for reranking
      let entityContextForRerank: Map<number, Array<{ entity_type: string; canonical_name: string; document_count: number }>> | undefined;
      if (entityMap) {
        entityContextForRerank = new Map();
        results.forEach((r, i) => {
          if (r.chunk_id && entityMap!.has(r.chunk_id)) {
            const entities = entityMap!.get(r.chunk_id)!;
            entityContextForRerank!.set(i, entities.map(e => ({
              entity_type: e.entity_type,
              canonical_name: e.canonical_name,
              document_count: e.document_count,
            })));
          }
        });
      }

      const rerankInput = results.map(r => ({
        chunk_id: r.chunk_id,
        image_id: r.image_id,
        extraction_id: r.extraction_id,
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
        rank: 0,
        score: r.similarity_score,
      }));

      const reranked = await rerankResults(input.query, rerankInput, limit, entityContextForRerank);
      finalResults = reranked.map(r => {
        const original = results[r.original_index];
        const result: Record<string, unknown> = {
          embedding_id: original.embedding_id,
          chunk_id: original.chunk_id,
          image_id: original.image_id,
          extraction_id: original.extraction_id ?? null,
          document_id: original.document_id,
          result_type: original.result_type,
          similarity_score: original.similarity_score,
          original_text: original.original_text,
          source_file_path: original.source_file_path,
          source_file_name: original.source_file_name,
          source_file_hash: original.source_file_hash,
          page_number: original.page_number,
          character_start: original.character_start,
          character_end: original.character_end,
          chunk_index: original.chunk_index,
          total_chunks: original.total_chunks,
          content_hash: original.content_hash,
          provenance_id: original.provenance_id,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        if (input.include_provenance) {
          result.provenance = formatProvenanceChain(db, original.provenance_id);
        }
        if (input.include_entities && entityMap && original.chunk_id) {
          result.entities_mentioned = entityMap.get(original.chunk_id) ?? [];
        }
        return result;
      });
      rerankInfo = {
        reranked: true,
        entity_aware: !!entityContextForRerank && entityContextForRerank.size > 0,
        candidates_evaluated: Math.min(results.length, 20),
        results_returned: finalResults.length,
      };
    } else {
      // Format results with optional provenance (original path)
      finalResults = results.map(r => {
        const result: Record<string, unknown> = {
          embedding_id: r.embedding_id,
          chunk_id: r.chunk_id,
          image_id: r.image_id,
          extraction_id: r.extraction_id ?? null,
          document_id: r.document_id,
          result_type: r.result_type,
          similarity_score: r.similarity_score,
          original_text: r.original_text,
          source_file_path: r.source_file_path,
          source_file_name: r.source_file_name,
          source_file_hash: r.source_file_hash,
          page_number: r.page_number,
          character_start: r.character_start,
          character_end: r.character_end,
          chunk_index: r.chunk_index,
          total_chunks: r.total_chunks,
          content_hash: r.content_hash,
          provenance_id: r.provenance_id,
        };

        if (input.include_provenance) {
          result.provenance = formatProvenanceChain(db, r.provenance_id);
        }

        if (input.include_entities && entityMap && r.chunk_id) {
          result.entities_mentioned = entityMap.get(r.chunk_id) ?? [];
        }

        return result;
      });
    }

    const responseData: Record<string, unknown> = {
      query: input.query,
      results: finalResults,
      total: finalResults.length,
      threshold: input.similarity_threshold,
    };

    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    if (input.entity_filter) {
      responseData.entity_filter_applied = true;
      responseData.entity_filter_document_count = documentFilter?.length ?? 0;
    }

    return formatResponse(successResult(responseData));
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
    const conn = db.getConnection();

    // Resolve metadata filter to document IDs, then chain through quality filter
    let documentFilter = resolveQualityFilter(db, input.min_quality_score,
      resolveMetadataFilter(db, input.metadata_filter, input.document_filter));

    // PAR-1: Entity filter - resolve entity names/types to document IDs
    if (input.entity_filter) {
      const entityDocIds = getDocumentIdsForEntities(
        conn,
        input.entity_filter.entity_names,
        input.entity_filter.entity_types,
      );
      if (entityDocIds.length === 0) {
        return formatResponse(successResult({
          query: input.query,
          search_type: 'bm25',
          results: [],
          total: 0,
          sources: { chunk_count: 0, vlm_count: 0, extraction_count: 0 },
          entity_filter_applied: true,
          entity_filter_document_count: 0,
        }));
      }
      if (documentFilter && documentFilter.length > 0) {
        const entitySet = new Set(entityDocIds);
        documentFilter = documentFilter.filter(id => entitySet.has(id));
        if (documentFilter.length === 0) {
          return formatResponse(successResult({
            query: input.query,
            search_type: 'bm25',
            results: [],
            total: 0,
            sources: { chunk_count: 0, vlm_count: 0, extraction_count: 0 },
            entity_filter_applied: true,
            entity_filter_document_count: 0,
          }));
        }
      } else {
        documentFilter = entityDocIds;
      }
    }

    // PAR-1: Expand query with KG aliases if requested (BM25 benefits from keyword expansion)
    const bm25Query = input.expand_query ? expandQueryWithKG(input.query, conn) : input.query;
    const expansionInfo = input.expand_query ? getExpandedTerms(input.query) : undefined;

    const bm25 = new BM25SearchService(conn);
    const limit = input.limit ?? 10;

    // M-3 fix: Over-fetch from both sources (limit * 2) since we merge and truncate.
    // Without this, requesting limit=10 from each source may yield <10 after merge.
    const fetchLimit = input.rerank ? Math.max(limit * 2, 20) : limit * 2;

    // Search chunks FTS
    const chunkResults = bm25.search({
      query: bm25Query,
      limit: fetchLimit,
      phraseSearch: input.phrase_search,
      documentFilter,
      includeHighlight: input.include_highlight,
    });

    // Search VLM FTS
    const vlmResults = bm25.searchVLM({
      query: bm25Query,
      limit: fetchLimit,
      phraseSearch: input.phrase_search,
      documentFilter,
      includeHighlight: input.include_highlight,
    });

    // Search extractions FTS (F-12)
    const extractionResults = bm25.searchExtractions({
      query: bm25Query,
      limit: fetchLimit,
      phraseSearch: input.phrase_search,
      documentFilter,
      includeHighlight: input.include_highlight,
    });

    // Merge by score (higher is better), apply combined limit
    const mergeLimit = input.rerank ? Math.max(limit * 2, 20) : limit;
    const allResults = [...chunkResults, ...vlmResults, ...extractionResults]
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, mergeLimit);

    // Re-rank after merge
    const rankedResults = allResults.map((r, i) => ({ ...r, rank: i + 1 }));

    // Entity enrichment: collect chunk IDs and fetch entities if requested
    let bm25EntityMap: Map<string, ChunkEntityInfo[]> | undefined;
    if (input.include_entities || input.rerank) {
      const chunkIds = rankedResults.map(r => r.chunk_id).filter((id): id is string => id != null);
      if (chunkIds.length > 0) {
        bm25EntityMap = getEntitiesForChunks(conn, chunkIds);
      }
    }

    // PAR-1: Re-rank results using Gemini AI if requested
    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && rankedResults.length > 0) {
      // Build entity context map for reranking
      let entityContextForRerank: Map<number, Array<{ entity_type: string; canonical_name: string; document_count: number }>> | undefined;
      if (bm25EntityMap) {
        entityContextForRerank = new Map();
        rankedResults.forEach((r, i) => {
          if (r.chunk_id && bm25EntityMap!.has(r.chunk_id)) {
            const entities = bm25EntityMap!.get(r.chunk_id)!;
            entityContextForRerank!.set(i, entities.map(e => ({
              entity_type: e.entity_type,
              canonical_name: e.canonical_name,
              document_count: e.document_count,
            })));
          }
        });
      }

      const rerankInput = rankedResults.map(r => ({ ...r }));
      const reranked = await rerankResults(input.query, rerankInput, limit, entityContextForRerank);
      finalResults = reranked.map(r => {
        const original = rankedResults[r.original_index];
        const base: Record<string, unknown> = {
          ...original,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        if (input.include_provenance) {
          base.provenance_chain = formatProvenanceChain(db, original.provenance_id);
        }
        if (input.include_entities && bm25EntityMap && original.chunk_id) {
          base.entities_mentioned = bm25EntityMap.get(original.chunk_id) ?? [];
        }
        return base;
      });
      rerankInfo = {
        reranked: true,
        entity_aware: !!entityContextForRerank && entityContextForRerank.size > 0,
        candidates_evaluated: Math.min(rankedResults.length, 20),
        results_returned: finalResults.length,
      };
    } else {
      finalResults = rankedResults.map(r => {
        const base: Record<string, unknown> = { ...r };
        if (input.include_provenance) {
          base.provenance_chain = formatProvenanceChain(db, r.provenance_id);
        }
        if (input.include_entities && bm25EntityMap && r.chunk_id) {
          base.entities_mentioned = bm25EntityMap.get(r.chunk_id) ?? [];
        }
        return base;
      });
    }

    // Compute source counts from final merged results (not pre-merge candidates)
    let finalChunkCount = 0;
    let finalVlmCount = 0;
    let finalExtractionCount = 0;
    for (const r of finalResults) {
      if (r.result_type === 'chunk') finalChunkCount++;
      else if (r.result_type === 'vlm') finalVlmCount++;
      else finalExtractionCount++;
    }

    const responseData: Record<string, unknown> = {
      query: input.query,
      search_type: 'bm25',
      results: finalResults,
      total: finalResults.length,
      sources: {
        chunk_count: finalChunkCount,
        vlm_count: finalVlmCount,
        extraction_count: finalExtractionCount,
      },
    };

    if (expansionInfo) {
      responseData.query_expansion = expansionInfo;
    }

    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    if (input.entity_filter) {
      responseData.entity_filter_applied = true;
      responseData.entity_filter_document_count = documentFilter?.length ?? 0;
    }

    return formatResponse(successResult(responseData));
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
    const conn = db.getConnection();

    // Resolve metadata filter to document IDs, then chain through quality filter
    let documentFilter = resolveQualityFilter(db, input.min_quality_score,
      resolveMetadataFilter(db, input.metadata_filter, input.document_filter));

    // P2.4: Entity filter - resolve entity names/types to document IDs
    if (input.entity_filter) {
      const entityDocIds = getDocumentIdsForEntities(
        conn,
        input.entity_filter.entity_names,
        input.entity_filter.entity_types,
      );
      if (entityDocIds.length === 0) {
        // Entity filter matched no documents - return empty results
        return formatResponse(successResult({
          query: input.query,
          search_type: 'rrf_hybrid',
          config: {
            bm25_weight: input.bm25_weight,
            semantic_weight: input.semantic_weight,
            rrf_k: input.rrf_k,
          },
          results: [],
          total: 0,
          sources: { bm25_chunk_count: 0, bm25_vlm_count: 0, bm25_extraction_count: 0, semantic_count: 0 },
          entity_filter_applied: true,
          entity_filter_document_count: 0,
        }));
      }
      // Intersect with existing document filter
      if (documentFilter && documentFilter.length > 0) {
        const entitySet = new Set(entityDocIds);
        documentFilter = documentFilter.filter(id => entitySet.has(id));
        if (documentFilter.length === 0) {
          return formatResponse(successResult({
            query: input.query,
            search_type: 'rrf_hybrid',
            config: {
              bm25_weight: input.bm25_weight,
              semantic_weight: input.semantic_weight,
              rrf_k: input.rrf_k,
            },
            results: [],
            total: 0,
            sources: { bm25_chunk_count: 0, bm25_vlm_count: 0, bm25_extraction_count: 0, semantic_count: 0 },
            entity_filter_applied: true,
            entity_filter_document_count: 0,
          }));
        }
      } else {
        documentFilter = entityDocIds;
      }
    }

    // SE-1: Expand query with domain synonyms if requested (BM25 only -- semantic handles meaning natively)
    // P2.1: Use KG-powered expansion with co-mentioned entities for hybrid search
    // Hybrid search benefits from the broadest expansion since RRF fusion de-ranks noise
    const bm25Query = input.expand_query ? expandQueryWithCoMentioned(input.query, conn) : input.query;
    const expansionInfo = input.expand_query ? getExpandedTerms(input.query) : undefined;

    // Get BM25 results (chunks + VLM + extractions)
    const bm25 = new BM25SearchService(db.getConnection());
    // L-6 fix: Pass includeHighlight: false -- hybrid search discards BM25 highlights
    // since RRF results don't surface snippet() output. Avoids wasted FTS5 computation.
    const bm25ChunkResults = bm25.search({
      query: bm25Query,
      limit: limit * 2,
      documentFilter,
      includeHighlight: false,
    });
    const bm25VlmResults = bm25.searchVLM({
      query: bm25Query,
      limit: limit * 2,
      documentFilter,
      includeHighlight: false,
    });
    const bm25ExtractionResults = bm25.searchExtractions({
      query: bm25Query,
      limit: limit * 2,
      documentFilter,
      includeHighlight: false,
    });

    // Merge BM25 results by score
    const allBm25 = [...bm25ChunkResults, ...bm25VlmResults, ...bm25ExtractionResults]
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, limit * 2)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // Get semantic results
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(input.query);
    const semanticResults = vector.searchSimilar(queryVector, {
      limit: limit * 2,
      // L-9: Intentionally lower than standalone semantic search (0.7).
      // Hybrid uses 0.3 because RRF fusion will de-rank low-quality results anyway.
      // The 0.3 floor ensures we don't miss results that are mediocre semantically
      // but strong in BM25 keyword matching.
      threshold: 0.3,
      documentFilter,
    });

    // Convert to ranked format for RRF
    const bm25Ranked = allBm25.map(r => ({
      chunk_id: r.chunk_id,
      image_id: r.image_id,
      extraction_id: r.extraction_id,
      embedding_id: r.embedding_id ?? '',
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
      extraction_id: r.extraction_id,
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

    // Fetch more results for reranking if needed
    const fusionLimit = input.rerank ? Math.max(limit * 2, 20) : limit;
    const rawResults = fusion.fuse(bm25Ranked, semanticRanked, fusionLimit);

    // P2.2: Entity enrichment - collect chunk IDs and fetch entities
    let hybridEntityMap: Map<string, ChunkEntityInfo[]> | undefined;
    if (input.include_entities || input.rerank) {
      const chunkIds = rawResults.map(r => r.chunk_id).filter((id): id is string => id != null);
      if (chunkIds.length > 0) {
        hybridEntityMap = getEntitiesForChunks(conn, chunkIds);
      }
    }

    // SE-2: Re-rank results using Gemini AI if requested
    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && rawResults.length > 0) {
      // P2.3: Build entity context map for reranking (index-based for the reranker)
      let entityContextForRerank: Map<number, Array<{ entity_type: string; canonical_name: string; document_count: number }>> | undefined;
      if (hybridEntityMap) {
        entityContextForRerank = new Map();
        rawResults.forEach((r, i) => {
          if (r.chunk_id && hybridEntityMap!.has(r.chunk_id)) {
            const entities = hybridEntityMap!.get(r.chunk_id)!;
            entityContextForRerank!.set(i, entities.map(e => ({
              entity_type: e.entity_type,
              canonical_name: e.canonical_name,
              document_count: e.document_count,
            })));
          }
        });
      }

      // ENH-4: Build edge context from entity nodes found in search results
      let edgeContextForRerank: EdgeInfo[] | undefined;
      if (hybridEntityMap) {
        // Collect unique node IDs from all entities in the results
        const nodeIdSet = new Set<string>();
        for (const entities of hybridEntityMap.values()) {
          for (const e of entities) {
            nodeIdSet.add(e.node_id);
          }
        }

        if (nodeIdSet.size > 0) {
          // Build a map of node_id -> canonical_name for resolving edge endpoints
          const nodeNameMap = new Map<string, string>();
          for (const entities of hybridEntityMap.values()) {
            for (const e of entities) {
              nodeNameMap.set(e.node_id, e.canonical_name);
            }
          }

          // Query edges between these nodes (limit per node to avoid explosion)
          const edgesSeen = new Set<string>();
          const edgeInfoList: EdgeInfo[] = [];
          for (const nodeId of nodeIdSet) {
            const edges = getEdgesForNode(conn, nodeId, { limit: 20 });
            for (const edge of edges) {
              // Only include edges where BOTH endpoints are in our result set
              if (!nodeIdSet.has(edge.source_node_id) || !nodeIdSet.has(edge.target_node_id)) continue;
              // Deduplicate edges
              if (edgesSeen.has(edge.id)) continue;
              edgesSeen.add(edge.id);

              // Resolve node names (from map or DB lookup)
              let sourceName = nodeNameMap.get(edge.source_node_id);
              if (!sourceName) {
                const sourceNode = getKnowledgeNode(conn, edge.source_node_id);
                sourceName = sourceNode?.canonical_name ?? edge.source_node_id;
                nodeNameMap.set(edge.source_node_id, sourceName);
              }
              let targetName = nodeNameMap.get(edge.target_node_id);
              if (!targetName) {
                const targetNode = getKnowledgeNode(conn, edge.target_node_id);
                targetName = targetNode?.canonical_name ?? edge.target_node_id;
                nodeNameMap.set(edge.target_node_id, targetName);
              }

              edgeInfoList.push({
                source_name: sourceName,
                target_name: targetName,
                relationship_type: edge.relationship_type,
                weight: edge.weight,
              });
            }
          }

          // Cap at 30 edges to stay within token limits, sorted by weight descending
          if (edgeInfoList.length > 0) {
            edgeInfoList.sort((a, b) => b.weight - a.weight);
            edgeContextForRerank = edgeInfoList.slice(0, 30);
          }
        }
      }

      // Cast rawResults to the shape rerankResults expects (spread drops the index signature issue)
      const rerankInput = rawResults.map(r => ({ ...r }));
      const reranked = await rerankResults(input.query, rerankInput, limit, entityContextForRerank, edgeContextForRerank);
      finalResults = reranked.map(r => {
        const original = rawResults[r.original_index];
        const base: Record<string, unknown> = {
          ...original,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        if (input.include_provenance) {
          base.provenance_chain = formatProvenanceChain(db, original.provenance_id);
        }
        if (input.include_entities && hybridEntityMap && original.chunk_id) {
          base.entities_mentioned = hybridEntityMap.get(original.chunk_id) ?? [];
        }
        return base;
      });
      rerankInfo = {
        reranked: true,
        entity_aware: !!entityContextForRerank && entityContextForRerank.size > 0,
        edge_aware: !!edgeContextForRerank && edgeContextForRerank.length > 0,
        edge_count: edgeContextForRerank?.length ?? 0,
        candidates_evaluated: Math.min(rawResults.length, 20),
        results_returned: finalResults.length,
      };
    } else {
      finalResults = rawResults.map(r => {
        const base: Record<string, unknown> = { ...r };
        if (input.include_provenance) {
          base.provenance_chain = formatProvenanceChain(db, r.provenance_id);
        }
        if (input.include_entities && hybridEntityMap && r.chunk_id) {
          base.entities_mentioned = hybridEntityMap.get(r.chunk_id) ?? [];
        }
        return base;
      });
    }

    const responseData: Record<string, unknown> = {
      query: input.query,
      search_type: 'rrf_hybrid',
      config: {
        bm25_weight: input.bm25_weight,
        semantic_weight: input.semantic_weight,
        rrf_k: input.rrf_k,
      },
      results: finalResults,
      total: finalResults.length,
      sources: {
        bm25_chunk_count: bm25ChunkResults.length,
        bm25_vlm_count: bm25VlmResults.length,
        bm25_extraction_count: bm25ExtractionResults.length,
        semantic_count: semanticResults.length,
      },
    };

    // Include expansion info when expand_query is true
    if (expansionInfo) {
      responseData.query_expansion = expansionInfo;
    }

    // Include rerank info when rerank is true
    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    return formatResponse(successResult(responseData));
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
// BENCHMARK COMPARE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_benchmark_compare - Compare search results across multiple databases
 */
async function handleBenchmarkCompare(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(z.object({
      query: z.string().min(1).max(1000),
      database_names: z.array(z.string().min(1)).min(2),
      search_type: z.enum(['bm25', 'semantic']).default('bm25'),
      limit: z.number().int().min(1).max(50).default(10),
    }), params);

    const storagePath = getDefaultStoragePath();
    const dbResults: Array<{
      database_name: string;
      result_count: number;
      top_scores: number[];
      avg_score: number;
      document_ids: string[];
      kg_metrics?: { nodes: number; edges: number };
      error?: string;
    }> = [];

    for (const dbName of input.database_names) {
      let tempDb: DatabaseService | null = null;
      try {
        tempDb = DatabaseService.open(dbName, storagePath);
        const conn = tempDb.getConnection();

        let scores: number[];
        let documentIds: string[];

        if (input.search_type === 'bm25') {
          const bm25 = new BM25SearchService(conn);
          const results = bm25.search({
            query: input.query,
            limit: input.limit,
            includeHighlight: false,
          });
          scores = results.map(r => r.bm25_score);
          documentIds = results.map(r => r.document_id);
        } else {
          const vector = new VectorService(conn);
          const embedder = getEmbeddingService();
          const queryVector = await embedder.embedSearchQuery(input.query);
          const results = vector.searchSimilar(queryVector, {
            limit: input.limit,
            threshold: 0.3,
          });
          scores = results.map(r => r.similarity_score);
          documentIds = results.map(r => r.document_id);
        }

        const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

        // POL-6: Query KG metrics for this database
        let kgMetrics: { nodes: number; edges: number } = { nodes: 0, edges: 0 };
        try {
          const nodeCount = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number } | undefined;
          const edgeCount = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number } | undefined;
          kgMetrics = {
            nodes: nodeCount?.cnt ?? 0,
            edges: edgeCount?.cnt ?? 0,
          };
        } catch {
          // KG tables may not exist in older databases
        }

        dbResults.push({
          database_name: dbName,
          result_count: scores.length,
          top_scores: scores.slice(0, 5),
          avg_score: Math.round(avgScore * 1000) / 1000,
          document_ids: documentIds,
          kg_metrics: kgMetrics,
        });
      } catch (error) {
        dbResults.push({
          database_name: dbName,
          result_count: 0,
          top_scores: [],
          avg_score: 0,
          document_ids: [],
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        tempDb?.close();
      }
    }

    // Compute overlap analysis: which document_ids appear in multiple databases
    const allDocIds = new Map<string, string[]>(); // doc_id -> list of db names
    for (const dbResult of dbResults) {
      for (const docId of dbResult.document_ids) {
        const existing = allDocIds.get(docId) || [];
        existing.push(dbResult.database_name);
        allDocIds.set(docId, existing);
      }
    }

    const overlapping = Object.fromEntries(
      [...allDocIds.entries()].filter(([, dbs]) => dbs.length > 1)
    );

    return formatResponse(successResult({
      query: input.query,
      search_type: input.search_type,
      limit: input.limit,
      databases: dbResults,
      overlap_analysis: {
        overlapping_document_ids: overlapping,
        overlap_count: Object.keys(overlapping).length,
        total_unique_documents: allDocIds.size,
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH EXPORT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_search_export - Export search results to CSV or JSON file
 */
async function handleSearchExport(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(z.object({
      query: z.string().min(1).max(1000),
      search_type: z.enum(['bm25', 'semantic', 'hybrid']).default('hybrid'),
      limit: z.number().int().min(1).max(1000).default(100),
      format: z.enum(['csv', 'json']).default('csv'),
      output_path: z.string().min(1),
      include_text: z.boolean().default(true),
      include_entities: z.boolean().default(false),
    }), params);

    // Run the appropriate search, passing include_entities when requested
    let searchResult: ToolResponse;
    const searchParams: Record<string, unknown> = {
      query: input.query,
      limit: input.limit,
      include_provenance: false,
      include_entities: input.include_entities,
    };

    if (input.search_type === 'bm25') {
      searchResult = await handleSearch(searchParams);
    } else if (input.search_type === 'semantic') {
      searchResult = await handleSearchSemantic(searchParams);
    } else {
      searchResult = await handleSearchHybrid(searchParams);
    }

    // Parse search results from the ToolResponse
    const responseContent = searchResult.content[0];
    if (responseContent.type !== 'text') throw new Error('Unexpected search response format');
    const parsedResponse = JSON.parse(responseContent.text);
    if (!parsedResponse.success) throw new Error(`Search failed: ${parsedResponse.error?.message || 'Unknown error'}`);
    const results = parsedResponse.data?.results || [];

    // Ensure output directory exists
    const outputDir = path.dirname(input.output_path);
    fs.mkdirSync(outputDir, { recursive: true });

    if (input.format === 'json') {
      const exportData = results.map((r: Record<string, unknown>) => {
        const row: Record<string, unknown> = {
          document_id: r.document_id,
          source_file: r.source_file_name || r.source_file_path,
          page_number: r.page_number,
          score: r.bm25_score ?? r.similarity_score ?? r.rrf_score,
          result_type: r.result_type,
        };
        if (input.include_text) row.text = r.original_text;
        if (input.include_entities && r.entities_mentioned) {
          row.entities_mentioned = r.entities_mentioned;
        }
        return row;
      });
      fs.writeFileSync(input.output_path, JSON.stringify(exportData, null, 2));
    } else {
      // CSV
      const headers = ['document_id', 'source_file', 'page_number', 'score', 'result_type'];
      if (input.include_text) headers.push('text');
      if (input.include_entities) headers.push('entities_mentioned');
      const csvLines = [headers.join(',')];
      for (const r of results) {
        const row = [
          r.document_id,
          (r.source_file_name || r.source_file_path || '').replace(/,/g, ';'),
          r.page_number ?? '',
          r.bm25_score ?? r.similarity_score ?? r.rrf_score ?? '',
          r.result_type || '',
        ];
        if (input.include_text) {
          row.push(`"${(r.original_text || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`);
        }
        if (input.include_entities) {
          // Format entities as semicolon-separated canonical names for CSV
          const entities = r.entities_mentioned as Array<{ canonical_name?: string }> | undefined;
          const entityStr = entities && Array.isArray(entities)
            ? entities.map((e: { canonical_name?: string }) => e.canonical_name ?? '').filter(Boolean).join(';')
            : '';
          row.push(`"${entityStr.replace(/"/g, '""')}"`);
        }
        csvLines.push(row.join(','));
      }
      fs.writeFileSync(input.output_path, csvLines.join('\n'));
    }

    return formatResponse(successResult({
      output_path: input.output_path,
      format: input.format,
      result_count: results.length,
      search_type: input.search_type,
      query: input.query,
      include_entities: input.include_entities,
    }));
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
      include_entities: z.boolean().default(false).describe('Include knowledge graph entities for each result'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
      metadata_filter: z.object({
        doc_title: z.string().optional(),
        doc_author: z.string().optional(),
        doc_subject: z.string().optional(),
      }).optional().describe('Filter by document metadata (LIKE match)'),
      min_quality_score: z.number().min(0).max(5).optional()
        .describe('Minimum OCR quality score (0-5)'),
      expand_query: z.boolean().default(false)
        .describe('Expand query with domain-specific legal/medical synonyms and knowledge graph aliases'),
      entity_filter: z.object({
        entity_names: z.array(z.string()).optional(),
        entity_types: z.array(z.string()).optional(),
      }).optional().describe('Filter results by knowledge graph entities'),
      rerank: z.boolean().default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
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
      include_entities: z.boolean().default(false).describe('Include knowledge graph entities for each result'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
      metadata_filter: z.object({
        doc_title: z.string().optional(),
        doc_author: z.string().optional(),
        doc_subject: z.string().optional(),
      }).optional().describe('Filter by document metadata (LIKE match)'),
      min_quality_score: z.number().min(0).max(5).optional()
        .describe('Minimum OCR quality score (0-5)'),
      entity_filter: z.object({
        entity_names: z.array(z.string()).optional(),
        entity_types: z.array(z.string()).optional(),
      }).optional().describe('Filter results by knowledge graph entities'),
      rerank: z.boolean().default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
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
      include_entities: z.boolean().default(false).describe('Include knowledge graph entities for each result'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
      metadata_filter: z.object({
        doc_title: z.string().optional(),
        doc_author: z.string().optional(),
        doc_subject: z.string().optional(),
      }).optional().describe('Filter by document metadata (LIKE match)'),
      min_quality_score: z.number().min(0).max(5).optional()
        .describe('Minimum OCR quality score (0-5)'),
      expand_query: z.boolean().default(false)
        .describe('Expand query with domain-specific legal/medical synonyms and knowledge graph aliases'),
      rerank: z.boolean().default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring (entity-aware when KG data available)'),
      entity_filter: z.object({
        entity_names: z.array(z.string()).optional(),
        entity_types: z.array(z.string()).optional(),
      }).optional().describe('Filter results by knowledge graph entities'),
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
  ocr_search_export: {
    description: 'Export search results to CSV or JSON file',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      search_type: z.enum(['bm25', 'semantic', 'hybrid']).default('hybrid')
        .describe('Search method to use'),
      limit: z.number().int().min(1).max(1000).default(100)
        .describe('Maximum results'),
      format: z.enum(['csv', 'json']).default('csv')
        .describe('Export file format'),
      output_path: z.string().min(1).describe('File path to save export'),
      include_text: z.boolean().default(true)
        .describe('Include full text in export'),
      include_entities: z.boolean().default(false)
        .describe('Include knowledge graph entities for each result'),
    },
    handler: handleSearchExport,
  },
  ocr_benchmark_compare: {
    description: 'Compare search results across multiple databases for benchmarking',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      database_names: z.array(z.string().min(1)).min(2)
        .describe('Database names to compare (minimum 2)'),
      search_type: z.enum(['bm25', 'semantic']).default('bm25')
        .describe('Search method to use'),
      limit: z.number().int().min(1).max(50).default(10)
        .describe('Maximum results per database'),
    },
    handler: handleBenchmarkCompare,
  },
};
