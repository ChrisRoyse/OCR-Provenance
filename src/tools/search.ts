/**
 * Search MCP Tools
 *
 * Tools: ocr_search, ocr_search_semantic, ocr_search_hybrid, ocr_fts_manage,
 *        ocr_search_export, ocr_benchmark_compare, ocr_rag_context,
 *        ocr_search_save, ocr_search_saved_list, ocr_search_saved_get
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/search
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { DatabaseService } from '../services/storage/database/index.js';
import { VectorService } from '../services/storage/vector.js';
import { requireDatabase, getDefaultStoragePath } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  sanitizePath,
  escapeLikePattern,
  SearchSemanticInput,
  SearchInput,
  SearchHybridInput,
  FTSManageInput,
} from '../utils/validation.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { BM25SearchService } from '../services/search/bm25.js';
import { RRFFusion, type RankedResult } from '../services/search/fusion.js';
import { rerankResults } from '../services/search/reranker.js';
import { expandQuery, getExpandedTerms } from '../services/search/query-expander.js';
import { classifyQuery } from '../services/search/query-classifier.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getImage } from '../services/storage/database/image-operations.js';

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
  existingDocFilter?: string[]
): string[] | undefined {
  if (!metadataFilter) return existingDocFilter;
  const { doc_title, doc_author, doc_subject } = metadataFilter;
  if (!doc_title && !doc_author && !doc_subject) return existingDocFilter;

  let sql = 'SELECT id FROM documents WHERE 1=1';
  const params: string[] = [];
  if (doc_title) {
    sql += " AND doc_title LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLikePattern(doc_title)}%`);
  }
  if (doc_author) {
    sql += " AND doc_author LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLikePattern(doc_author)}%`);
  }
  if (doc_subject) {
    sql += " AND doc_subject LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLikePattern(doc_subject)}%`);
  }

  // If existing doc filter, intersect with it
  if (existingDocFilter && existingDocFilter.length > 0) {
    sql += ` AND id IN (${existingDocFilter.map(() => '?').join(',')})`;
    params.push(...existingDocFilter);
  }

  const rows = db
    .getConnection()
    .prepare(sql)
    .all(...params) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Resolve min_quality_score to filtered document IDs.
 * If minQualityScore is undefined, returns existingDocFilter unchanged.
 * If set, queries for documents with OCR quality >= threshold and intersects with existing filter.
 */
function resolveQualityFilter(
  db: ReturnType<typeof requireDatabase>['db'],
  minQualityScore: number | undefined,
  existingDocFilter: string[] | undefined
): string[] | undefined {
  if (minQualityScore === undefined) return existingDocFilter;
  const rows = db
    .getConnection()
    .prepare(
      `SELECT DISTINCT d.id FROM documents d
     JOIN ocr_results o ON o.document_id = d.id
     WHERE o.parse_quality_score >= ?`
    )
    .all(minQualityScore) as { id: string }[];
  const qualityIds = new Set(rows.map((r) => r.id));
  if (!existingDocFilter) {
    // Return sentinel non-matchable ID when no documents pass quality filter,
    // so BM25/semantic/hybrid search applies the empty IN() filter correctly.
    if (qualityIds.size === 0) return ['__no_match__'];
    return [...qualityIds];
  }
  const filtered = existingDocFilter.filter((id) => qualityIds.has(id));
  if (filtered.length === 0) return ['__no_match__'];
  return filtered;
}

/**
 * Format provenance chain as summary array
 */
function formatProvenanceChain(
  db: ReturnType<typeof requireDatabase>['db'],
  provenanceId: string
): ProvenanceSummary[] {
  const chain = db.getProvenanceChain(provenanceId);
  return chain.map((p) => ({
    id: p.id,
    type: p.type,
    chain_depth: p.chain_depth,
    processor: p.processor,
    content_hash: p.content_hash,
  }));
}

/**
 * Resolve cluster_id filter to document IDs.
 * Queries document_clusters to find all documents in the specified cluster,
 * then intersects with any existing document filter.
 */
function resolveClusterFilter(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  clusterId: string | undefined,
  existingDocFilter: string[] | undefined
): string[] | undefined {
  if (!clusterId) return existingDocFilter;

  const rows = conn
    .prepare('SELECT document_id FROM document_clusters WHERE cluster_id = ?')
    .all(clusterId) as Array<{ document_id: string }>;

  const clusterDocIds = rows.map((r) => r.document_id);
  if (clusterDocIds.length === 0) return ['__no_match__'];

  if (existingDocFilter && existingDocFilter.length > 0) {
    const clusterSet = new Set(clusterDocIds);
    const intersected = existingDocFilter.filter((id) => clusterSet.has(id));
    return intersected.length === 0 ? ['__no_match__'] : intersected;
  }

  return clusterDocIds;
}

/**
 * Chunk-level filter SQL conditions and params.
 * Built by resolveChunkFilter, consumed by BM25 and vector search.
 */
interface ChunkFilterSQL {
  conditions: string[];
  params: unknown[];
}

/**
 * Resolve chunk-level filters to SQL WHERE clause fragments.
 * Filters apply to the chunks table (alias 'c' in BM25, 'ch' in vector).
 * The caller is responsible for alias translation if needed.
 */
function resolveChunkFilter(
  filters: {
    content_type_filter?: string[];
    section_path_filter?: string;
    heading_filter?: string;
    page_range_filter?: { min_page?: number; max_page?: number };
  }
): ChunkFilterSQL {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.content_type_filter && filters.content_type_filter.length > 0) {
    // content_types is JSON array like '["table","text"]'
    // Match if ANY of the requested types appear
    const typeConditions = filters.content_type_filter.map(() => "c.content_types LIKE '%' || ? || '%'");
    conditions.push(`(${typeConditions.join(' OR ')})`);
    params.push(...filters.content_type_filter.map(t => `"${t}"`));
  }

  if (filters.section_path_filter) {
    conditions.push("c.section_path LIKE ? || '%'");
    params.push(filters.section_path_filter);
  }

  if (filters.heading_filter) {
    conditions.push("c.heading_context LIKE '%' || ? || '%'");
    params.push(filters.heading_filter);
  }

  if (filters.page_range_filter) {
    if (filters.page_range_filter.min_page !== undefined) {
      conditions.push('c.page_number >= ?');
      params.push(filters.page_range_filter.min_page);
    }
    if (filters.page_range_filter.max_page !== undefined) {
      conditions.push('c.page_number <= ?');
      params.push(filters.page_range_filter.max_page);
    }
  }

  return { conditions, params };
}

/**
 * Attach cluster context to search results.
 * For each unique document_id in results, queries cluster membership
 * and attaches cluster_context array to each result.
 */
function attachClusterContext(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  results: Array<Record<string, unknown>>
): void {
  const docIds = [...new Set(results.map((r) => r.document_id as string).filter(Boolean))];
  if (docIds.length === 0) return;

  const clusterCache = new Map<
    string,
    Array<{ cluster_id: string; cluster_label: string | null; run_id: string }>
  >();
  for (const docId of docIds) {
    try {
      const summaries = getClusterSummariesForDocument(conn, docId);
      clusterCache.set(
        docId,
        summaries.map((s) => ({
          cluster_id: s.id,
          cluster_label: s.label,
          run_id: s.run_id,
        }))
      );
    } catch (error) {
      console.error(
        `[Search] Failed to get cluster summaries for document ${docId}: ${String(error)}`
      );
      clusterCache.set(docId, []);
    }
  }

  for (const r of results) {
    const docId = r.document_id as string;
    if (docId) {
      r.cluster_context = clusterCache.get(docId) ?? [];
    }
  }
}

/**
 * Enrich VLM search results with image metadata (extracted_path, page_number, dimensions, etc.).
 * For results with an image_id, looks up the image record and attaches its metadata.
 * Non-VLM results and results with missing images are left unchanged.
 */
function enrichVLMResultsWithImageMetadata(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  results: Array<Record<string, unknown>>
): void {
  for (const result of results) {
    if (result.image_id) {
      const image = getImage(conn, result.image_id as string);
      if (image) {
        result.image_extracted_path = image.extracted_path;
        result.image_page_number = image.page_number;
        result.image_dimensions = { width: image.dimensions.width, height: image.dimensions.height };
        result.image_block_type = image.block_type;
        result.image_format = image.format;
      }
    }
  }
}

/**
 * Attach optional provenance chain to a search result object.
 * Shared by BM25, semantic, and hybrid handlers (both reranked and non-reranked paths).
 *
 * @param provenanceKey - Response field name for provenance chain ('provenance' or 'provenance_chain')
 */
function attachProvenance(
  result: Record<string, unknown>,
  db: ReturnType<typeof requireDatabase>['db'],
  provenanceId: string,
  includeProvenance: boolean,
  provenanceKey: 'provenance' | 'provenance_chain' = 'provenance'
): void {
  if (includeProvenance) {
    result[provenanceKey] = formatProvenanceChain(db, provenanceId);
  }
}

/**
 * Apply chunk proximity boost to hybrid search results.
 * Results from the same document whose chunk indexes are within 2 of each other
 * get their rrf_score multiplied by (1 + 0.1 * nearbyCount), rewarding
 * clusters of nearby relevant chunks.
 */
function applyChunkProximityBoost(
  results: Array<Record<string, unknown>>
): { boosted_results: number } | undefined {
  const byDoc = new Map<string, Array<{ idx: number; chunkIndex: number }>>();
  for (let i = 0; i < results.length; i++) {
    const docId = results[i].document_id as string;
    const chunkIndex = results[i].chunk_index as number | undefined;
    if (docId && chunkIndex !== undefined && chunkIndex !== null) {
      if (!byDoc.has(docId)) byDoc.set(docId, []);
      byDoc.get(docId)!.push({ idx: i, chunkIndex });
    }
  }

  let boostedCount = 0;
  for (const entries of byDoc.values()) {
    if (entries.length < 2) continue;
    for (const entry of entries) {
      const nearbyCount = entries.filter(
        (e) => Math.abs(e.chunkIndex - entry.chunkIndex) <= 2 && e.chunkIndex !== entry.chunkIndex
      ).length;
      if (nearbyCount > 0) {
        const currentScore = results[entry.idx].rrf_score as number;
        if (typeof currentScore === 'number') {
          results[entry.idx].rrf_score = currentScore * (1 + 0.1 * nearbyCount);
          boostedCount++;
        }
      }
    }
  }
  return boostedCount > 0 ? { boosted_results: boostedCount } : undefined;
}

/**
 * Convert BM25 results (with bm25_score and rank) to ranked format for RRF fusion.
 */
function toBm25Ranked(
  results: Array<{
    chunk_id: string | null;
    image_id: string | null;
    extraction_id: string | null;
    embedding_id: string | null;
    document_id: string;
    original_text: string;
    result_type: 'chunk' | 'vlm' | 'extraction';
    source_file_path: string;
    source_file_name: string;
    source_file_hash: string;
    page_number: number | null;
    character_start: number;
    character_end: number;
    chunk_index: number;
    provenance_id: string;
    content_hash: string;
    rank: number;
    bm25_score: number;
    heading_context?: string | null;
    section_path?: string | null;
    content_types?: string | null;
    is_atomic?: boolean;
    page_range?: string | null;
    heading_level?: number | null;
    ocr_quality_score?: number | null;
  }>
): RankedResult[] {
  return results.map((r) => ({
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
    heading_context: r.heading_context ?? null,
    section_path: r.section_path ?? null,
    content_types: r.content_types ?? null,
    is_atomic: r.is_atomic ?? false,
    page_range: r.page_range ?? null,
    heading_level: r.heading_level ?? null,
    ocr_quality_score: r.ocr_quality_score ?? null,
  }));
}

/**
 * Convert semantic search results (with similarity_score) to ranked format for RRF fusion.
 */
function toSemanticRanked(
  results: Array<{
    chunk_id: string | null;
    image_id: string | null;
    extraction_id: string | null;
    embedding_id: string;
    document_id: string;
    original_text: string;
    result_type: 'chunk' | 'vlm' | 'extraction';
    source_file_path: string;
    source_file_name: string;
    source_file_hash: string;
    page_number: number | null;
    character_start: number;
    character_end: number;
    chunk_index: number;
    provenance_id: string;
    content_hash: string;
    similarity_score: number;
    heading_context?: string | null;
    section_path?: string | null;
    content_types?: string | null;
    is_atomic?: boolean;
    chunk_page_range?: string | null;
    heading_level?: number | null;
    ocr_quality_score?: number | null;
  }>
): RankedResult[] {
  return results.map((r, i) => ({
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
    heading_context: r.heading_context ?? null,
    section_path: r.section_path ?? null,
    content_types: r.content_types ?? null,
    is_atomic: r.is_atomic ?? false,
    page_range: r.chunk_page_range ?? null,
    heading_level: r.heading_level ?? null,
    ocr_quality_score: r.ocr_quality_score ?? null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_search_semantic - Semantic vector search
 */
export async function handleSearchSemantic(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSemanticInput, params);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    // Expand query with domain-specific synonyms if requested
    let searchQuery = input.query;
    let queryExpansion: { original: string; expanded: string[]; synonyms_found: Record<string, string[]> } | undefined;
    if (input.expand_query) {
      searchQuery = expandQuery(input.query);
      queryExpansion = getExpandedTerms(input.query);
    }

    // Resolve metadata filter to document IDs, then chain through quality + cluster filters
    const documentFilter = resolveClusterFilter(
      conn,
      input.cluster_id,
      resolveQualityFilter(
        db,
        input.min_quality_score,
        resolveMetadataFilter(db, input.metadata_filter, input.document_filter)
      )
    );

    // Resolve chunk-level filters
    const chunkFilter = resolveChunkFilter({
      content_type_filter: input.content_type_filter,
      section_path_filter: input.section_path_filter,
      heading_filter: input.heading_filter,
      page_range_filter: input.page_range_filter,
    });

    // Generate query embedding (use expanded query for better semantic coverage)
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(searchQuery);

    const limit = input.limit ?? 10;
    const searchLimit = input.rerank ? Math.max(limit * 2, 20) : limit;
    const threshold = input.similarity_threshold ?? 0.7;

    // Search for similar vectors
    const results = vector.searchSimilar(queryVector, {
      limit: searchLimit,
      threshold,
      documentFilter,
      chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
      qualityBoost: input.quality_boost,
      pageRangeFilter: input.page_range_filter,
    });

    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && results.length > 0) {
      const rerankInput = results.map((r) => ({
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

      const reranked = await rerankResults(input.query, rerankInput, limit);
      finalResults = reranked.map((r) => {
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
          heading_context: original.heading_context ?? null,
          section_path: original.section_path ?? null,
          content_types: original.content_types ?? null,
          is_atomic: original.is_atomic ?? false,
          chunk_page_range: original.chunk_page_range ?? null,
          heading_level: original.heading_level ?? null,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        attachProvenance(result, db, original.provenance_id, !!input.include_provenance);
        return result;
      });
      rerankInfo = {
        reranked: true,
        candidates_evaluated: Math.min(results.length, 20),
        results_returned: finalResults.length,
      };
    } else {
      finalResults = results.map((r) => {
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
          heading_context: r.heading_context ?? null,
          section_path: r.section_path ?? null,
          content_types: r.content_types ?? null,
          is_atomic: r.is_atomic ?? false,
          chunk_page_range: r.chunk_page_range ?? null,
          heading_level: r.heading_level ?? null,
        };
        attachProvenance(result, db, r.provenance_id, !!input.include_provenance);
        return result;
      });
    }

    // Enrich VLM results with image metadata
    enrichVLMResultsWithImageMetadata(conn, finalResults);

    const responseData: Record<string, unknown> = {
      query: input.query,
      results: finalResults,
      total: finalResults.length,
      threshold: threshold,
    };

    if (queryExpansion) {
      responseData.query_expansion = queryExpansion;
    }

    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    if (input.include_cluster_context && finalResults.length > 0) {
      attachClusterContext(conn, finalResults);
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
export async function handleSearch(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Expand query with domain-specific synonyms if requested
    let searchQuery = input.query;
    let queryExpansion: { original: string; expanded: string[]; synonyms_found: Record<string, string[]> } | undefined;
    if (input.expand_query) {
      searchQuery = expandQuery(input.query);
      queryExpansion = getExpandedTerms(input.query);
    }

    // Resolve metadata filter to document IDs, then chain through quality + cluster filters
    const documentFilter = resolveClusterFilter(
      conn,
      input.cluster_id,
      resolveQualityFilter(
        db,
        input.min_quality_score,
        resolveMetadataFilter(db, input.metadata_filter, input.document_filter)
      )
    );

    // Resolve chunk-level filters
    const chunkFilter = resolveChunkFilter({
      content_type_filter: input.content_type_filter,
      section_path_filter: input.section_path_filter,
      heading_filter: input.heading_filter,
      page_range_filter: input.page_range_filter,
    });

    const bm25 = new BM25SearchService(conn);
    const limit = input.limit ?? 10;

    // Over-fetch from both sources (limit * 2) since we merge and truncate
    const fetchLimit = input.rerank ? Math.max(limit * 2, 20) : limit * 2;

    // Search chunks FTS
    const chunkResults = bm25.search({
      query: searchQuery,
      limit: fetchLimit,
      phraseSearch: input.phrase_search,
      documentFilter,
      includeHighlight: input.include_highlight,
      chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
      qualityBoost: input.quality_boost,
    });

    // Search VLM FTS
    const vlmResults = bm25.searchVLM({
      query: searchQuery,
      limit: fetchLimit,
      phraseSearch: input.phrase_search,
      documentFilter,
      includeHighlight: input.include_highlight,
      pageRangeFilter: input.page_range_filter,
      qualityBoost: input.quality_boost,
    });

    // Search extractions FTS
    const extractionResults = bm25.searchExtractions({
      query: searchQuery,
      limit: fetchLimit,
      phraseSearch: input.phrase_search,
      documentFilter,
      includeHighlight: input.include_highlight,
      qualityBoost: input.quality_boost,
    });

    // Merge by score (higher is better), apply combined limit
    const mergeLimit = input.rerank ? Math.max(limit * 2, 20) : limit;
    const allResults = [...chunkResults, ...vlmResults, ...extractionResults]
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, mergeLimit);

    // Re-rank after merge
    const rankedResults = allResults.map((r, i) => ({ ...r, rank: i + 1 }));

    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && rankedResults.length > 0) {
      const rerankInput = rankedResults.map((r) => ({ ...r }));
      const reranked = await rerankResults(input.query, rerankInput, limit);
      finalResults = reranked.map((r) => {
        const original = rankedResults[r.original_index];
        const base: Record<string, unknown> = {
          ...original,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        attachProvenance(base, db, original.provenance_id, !!input.include_provenance, 'provenance_chain');
        return base;
      });
      rerankInfo = {
        reranked: true,
        candidates_evaluated: Math.min(rankedResults.length, 20),
        results_returned: finalResults.length,
      };
    } else {
      finalResults = rankedResults.map((r) => {
        const base: Record<string, unknown> = { ...r };
        attachProvenance(base, db, r.provenance_id, !!input.include_provenance, 'provenance_chain');
        return base;
      });
    }

    // Enrich VLM results with image metadata
    enrichVLMResultsWithImageMetadata(conn, finalResults);

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

    if (queryExpansion) {
      responseData.query_expansion = queryExpansion;
    }

    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    if (input.include_cluster_context && finalResults.length > 0) {
      attachClusterContext(conn, finalResults);
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
export async function handleSearchHybrid(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchHybridInput, params);
    const { db, vector } = requireDatabase();
    const limit = input.limit ?? 10;
    const conn = db.getConnection();

    // Auto-route: classify query and adjust weights
    let queryClassification: ReturnType<typeof classifyQuery> | undefined;
    if (input.auto_route) {
      queryClassification = classifyQuery(input.query);
      if (queryClassification.query_type === 'exact') {
        input.bm25_weight = 1.5;
        input.semantic_weight = 0.5;
      } else if (queryClassification.query_type === 'semantic') {
        input.bm25_weight = 0.5;
        input.semantic_weight = 1.5;
      }
      // 'mixed' keeps defaults (1.0/1.0)
    }

    // Expand query with domain-specific synonyms if requested
    let searchQuery = input.query;
    let queryExpansion: { original: string; expanded: string[]; synonyms_found: Record<string, string[]> } | undefined;
    if (input.expand_query) {
      searchQuery = expandQuery(input.query);
      queryExpansion = getExpandedTerms(input.query);
    }

    // Resolve metadata filter to document IDs, then chain through quality + cluster filters
    const documentFilter = resolveClusterFilter(
      conn,
      input.cluster_id,
      resolveQualityFilter(
        db,
        input.min_quality_score,
        resolveMetadataFilter(db, input.metadata_filter, input.document_filter)
      )
    );

    // Resolve chunk-level filters
    const chunkFilter = resolveChunkFilter({
      content_type_filter: input.content_type_filter,
      section_path_filter: input.section_path_filter,
      heading_filter: input.heading_filter,
      page_range_filter: input.page_range_filter,
    });

    // Get BM25 results (chunks + VLM + extractions)
    const bm25 = new BM25SearchService(db.getConnection());
    // includeHighlight: false -- hybrid discards BM25 highlights (RRF doesn't surface snippets)
    const bm25ChunkResults = bm25.search({
      query: searchQuery,
      limit: limit * 2,
      documentFilter,
      includeHighlight: false,
      chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
      qualityBoost: input.quality_boost,
    });
    const bm25VlmResults = bm25.searchVLM({
      query: searchQuery,
      limit: limit * 2,
      documentFilter,
      includeHighlight: false,
      pageRangeFilter: input.page_range_filter,
      qualityBoost: input.quality_boost,
    });
    const bm25ExtractionResults = bm25.searchExtractions({
      query: searchQuery,
      limit: limit * 2,
      documentFilter,
      includeHighlight: false,
      qualityBoost: input.quality_boost,
    });

    // Merge BM25 results by score
    const allBm25 = [...bm25ChunkResults, ...bm25VlmResults, ...bm25ExtractionResults]
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, limit * 2)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // Get semantic results (use expanded query for better semantic coverage)
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(searchQuery);
    const semanticResults = vector.searchSimilar(queryVector, {
      limit: limit * 2,
      // Lower threshold than standalone (0.7) -- RRF de-ranks low-quality results
      threshold: 0.3,
      documentFilter,
      chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
      qualityBoost: input.quality_boost,
      pageRangeFilter: input.page_range_filter,
    });

    // Convert to ranked format and fuse with RRF
    const bm25Ranked = toBm25Ranked(allBm25);
    const semanticRanked = toSemanticRanked(semanticResults);

    const fusion = new RRFFusion({
      k: input.rrf_k,
      bm25Weight: input.bm25_weight,
      semanticWeight: input.semantic_weight,
    });

    const fusionLimit = input.rerank ? Math.max(limit * 2, 20) : limit;
    const rawResults = fusion.fuse(bm25Ranked, semanticRanked, fusionLimit, {
      qualityBoost: input.quality_boost,
    });

    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && rawResults.length > 0) {
      const rerankInput = rawResults.map((r) => ({ ...r }));
      const reranked = await rerankResults(input.query, rerankInput, limit);
      finalResults = reranked.map((r) => {
        const original = rawResults[r.original_index];
        const base: Record<string, unknown> = {
          ...original,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        attachProvenance(base, db, original.provenance_id, !!input.include_provenance, 'provenance_chain');
        return base;
      });
      rerankInfo = {
        reranked: true,
        candidates_evaluated: Math.min(rawResults.length, 20),
        results_returned: finalResults.length,
      };
    } else {
      finalResults = rawResults.map((r) => {
        const base: Record<string, unknown> = { ...r };
        attachProvenance(base, db, r.provenance_id, !!input.include_provenance, 'provenance_chain');
        return base;
      });
    }

    // Chunk proximity boost - reward clusters of nearby relevant chunks
    const chunkProximityInfo =
      finalResults.length > 0 ? applyChunkProximityBoost(finalResults) : undefined;

    // Enrich VLM results with image metadata
    enrichVLMResultsWithImageMetadata(conn, finalResults);

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

    if (queryExpansion) {
      responseData.query_expansion = queryExpansion;
    }

    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    if (chunkProximityInfo) {
      responseData.chunk_proximity_boost = chunkProximityInfo;
    }

    if (queryClassification) {
      responseData.query_classification = queryClassification;
    }

    // Re-sort by rrf_score after proximity boost may have changed scores
    finalResults.sort((a, b) => (b.rrf_score as number) - (a.rrf_score as number));

    if (input.include_cluster_context && finalResults.length > 0) {
      attachClusterContext(conn, finalResults);
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
export async function handleFTSManage(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(FTSManageInput, params);
    const { db } = requireDatabase();
    const bm25 = new BM25SearchService(db.getConnection());

    if (input.action === 'rebuild') {
      const result = bm25.rebuildIndex();
      return formatResponse(successResult({ operation: 'fts_rebuild', ...result }));
    }

    const status = bm25.getStatus();

    // Detect chunks without embeddings (invisible to semantic search)
    try {
      const conn = db.getConnection();
      const gapRow = conn
        .prepare(
          `SELECT COUNT(*) as cnt FROM chunks c
         LEFT JOIN embeddings e ON e.chunk_id = c.id
         WHERE e.id IS NULL`
        )
        .get() as { cnt: number };
      (status as Record<string, unknown>).chunks_without_embeddings = gapRow.cnt;
    } catch (error) {
      console.error(`[Search] Failed to query chunks without embeddings: ${String(error)}`);
    }

    return formatResponse(successResult(status));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAG CONTEXT ASSEMBLY HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * RAG Context Input schema - validated inline (not exported to validation.ts
 * since this is a self-contained tool with a unique schema).
 */
const RagContextInput = z.object({
  question: z.string().min(1).max(2000).describe('The question to build context for'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum search results to include in context'),
  document_filter: z.array(z.string()).optional().describe('Restrict to specific documents'),
  max_context_length: z
    .number()
    .int()
    .min(500)
    .max(50000)
    .default(8000)
    .describe('Maximum total context length in characters'),
});

/**
 * Handle ocr_rag_context - Assemble a RAG context block for LLM consumption.
 *
 * Runs hybrid search (BM25 + semantic + RRF) and assembles a single markdown
 * context block optimized for LLM consumption.
 *
 * Pipeline:
 * 1. Hybrid search (BM25 + semantic + RRF)
 * 2. Assemble markdown: excerpts
 * 3. Truncate to max_context_length
 */
async function handleRagContext(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(RagContextInput, params);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();
    const limit = input.limit ?? 5;
    const maxContextLength = input.max_context_length ?? 8000;

    // ── Step 1: Run hybrid search (BM25 + semantic + RRF) ──────────────────
    const bm25 = new BM25SearchService(conn);
    const fetchLimit = limit * 2;

    const bm25ChunkResults = bm25.search({
      query: input.question,
      limit: fetchLimit,
      documentFilter: input.document_filter,
      includeHighlight: false,
    });
    const bm25VlmResults = bm25.searchVLM({
      query: input.question,
      limit: fetchLimit,
      documentFilter: input.document_filter,
      includeHighlight: false,
    });
    const bm25ExtractionResults = bm25.searchExtractions({
      query: input.question,
      limit: fetchLimit,
      documentFilter: input.document_filter,
      includeHighlight: false,
    });

    const allBm25 = [...bm25ChunkResults, ...bm25VlmResults, ...bm25ExtractionResults]
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, fetchLimit)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // Semantic search
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(input.question);
    const semanticResults = vector.searchSimilar(queryVector, {
      limit: fetchLimit,
      threshold: 0.3,
      documentFilter: input.document_filter,
    });

    // Convert to ranked format and fuse with RRF (default weights)
    const bm25Ranked = toBm25Ranked(allBm25);
    const semanticRanked = toSemanticRanked(semanticResults);

    const fusion = new RRFFusion({ k: 60, bm25Weight: 1.0, semanticWeight: 1.0 });
    const fusedResults = fusion.fuse(bm25Ranked, semanticRanked, limit);

    // Handle empty results
    if (fusedResults.length === 0) {
      const emptyContext =
        '## Relevant Document Excerpts\n\nNo relevant documents found for the given question.';
      return formatResponse(
        successResult({
          question: input.question,
          context: emptyContext,
          context_length: emptyContext.length,
          search_results_used: 0,
          sources: [],
        })
      );
    }

    // Enrich VLM results with image metadata
    const enrichedFused = fusedResults as unknown as Array<Record<string, unknown>>;
    enrichVLMResultsWithImageMetadata(conn, enrichedFused);

    // ── Step 2: Assemble markdown context ──────────────────────────────────
    const contextParts: string[] = [];

    // Document excerpts
    contextParts.push('## Relevant Document Excerpts\n');
    const sources: Array<{ file_name: string; page_number: number | null; document_id: string }> =
      [];

    for (let i = 0; i < fusedResults.length; i++) {
      const r = fusedResults[i];
      const enriched = enrichedFused[i];
      const score = Math.round(r.rrf_score * 1000) / 1000;
      const fileName = r.source_file_name || path.basename(r.source_file_path || 'unknown');
      const pageInfo =
        r.page_number !== null && r.page_number !== undefined ? `, Page ${r.page_number}` : '';

      contextParts.push(`### Result ${i + 1} (Score: ${score})`);
      contextParts.push(`**Source:** ${fileName}${pageInfo}`);
      if (r.section_path) {
        contextParts.push(`**Section:** ${r.section_path}`);
      }
      if (r.heading_context) {
        contextParts.push(`**Heading:** ${r.heading_context}`);
      }

      // For VLM results with image metadata, include image context
      if (enriched.image_extracted_path) {
        const blockType = enriched.image_block_type || 'Image';
        const imgPage = enriched.image_page_number ?? r.page_number ?? 'unknown';
        contextParts.push(`> **[Image: ${blockType} on page ${imgPage}]**`);
        contextParts.push(`> File: ${enriched.image_extracted_path}`);
        contextParts.push(`> Description: ${r.original_text.replace(/\n/g, '\n> ')}\n`);
      } else {
        contextParts.push(`> ${r.original_text.replace(/\n/g, '\n> ')}\n`);
      }

      sources.push({
        file_name: fileName,
        page_number: r.page_number,
        document_id: r.document_id,
      });
    }

    // ── Step 3: Truncate to max_context_length ─────────────────────────────
    let assembledMarkdown = contextParts.join('\n');
    if (assembledMarkdown.length > maxContextLength) {
      assembledMarkdown = assembledMarkdown.slice(0, maxContextLength - 3) + '...';
    }

    // ── Step 4: Return structured response ─────────────────────────────────
    const ragResponse: Record<string, unknown> = {
      question: input.question,
      context: assembledMarkdown,
      context_length: assembledMarkdown.length,
      search_results_used: fusedResults.length,
      sources,
    };
    return formatResponse(successResult(ragResponse));
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
    const input = validateInput(
      z.object({
        query: z.string().min(1).max(1000),
        database_names: z.array(z.string().min(1)).min(2),
        search_type: z.enum(['bm25', 'semantic']).default('bm25'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      params
    );

    const storagePath = getDefaultStoragePath();
    const dbResults: Array<{
      database_name: string;
      result_count: number;
      top_scores: number[];
      avg_score: number;
      document_ids: string[];
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
          scores = results.map((r) => r.bm25_score);
          documentIds = results.map((r) => r.document_id);
        } else {
          const vectorSvc = new VectorService(conn);
          const embedder = getEmbeddingService();
          const queryVector = await embedder.embedSearchQuery(input.query);
          const results = vectorSvc.searchSimilar(queryVector, {
            limit: input.limit,
            threshold: 0.3,
          });
          scores = results.map((r) => r.similarity_score);
          documentIds = results.map((r) => r.document_id);
        }

        const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

        dbResults.push({
          database_name: dbName,
          result_count: scores.length,
          top_scores: scores.slice(0, 5),
          avg_score: Math.round(avgScore * 1000) / 1000,
          document_ids: documentIds,
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

    return formatResponse(
      successResult({
        query: input.query,
        search_type: input.search_type,
        limit: input.limit,
        databases: dbResults,
        overlap_analysis: {
          overlapping_document_ids: overlapping,
          overlap_count: Object.keys(overlapping).length,
          total_unique_documents: allDocIds.size,
        },
      })
    );
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
    const input = validateInput(
      z.object({
        query: z.string().min(1).max(1000),
        search_type: z.enum(['bm25', 'semantic', 'hybrid']).default('hybrid'),
        limit: z.number().int().min(1).max(1000).default(100),
        format: z.enum(['csv', 'json']).default('csv'),
        output_path: z.string().min(1),
        include_text: z.boolean().default(true),
      }),
      params
    );

    // Run the appropriate search
    let searchResult: ToolResponse;
    const searchParams: Record<string, unknown> = {
      query: input.query,
      limit: input.limit,
      include_provenance: false,
    };

    if (input.search_type === 'bm25') {
      searchResult = await handleSearch(searchParams);
    } else if (input.search_type === 'semantic') {
      searchResult = await handleSearchSemantic(searchParams);
    } else {
      searchResult = await handleSearchHybrid(searchParams);
    }

    // Parse search results from the ToolResponse
    if (!searchResult.content || searchResult.content.length === 0) {
      throw new Error('Search returned empty content');
    }
    const responseContent = searchResult.content[0];
    if (responseContent.type !== 'text') throw new Error('Unexpected search response format');
    let parsedResponse: Record<string, unknown>;
    try {
      parsedResponse = JSON.parse(responseContent.text) as Record<string, unknown>;
    } catch (error) {
      console.error(
        '[search] handleSearchExport failed to parse search response as JSON:',
        error instanceof Error ? error.message : String(error)
      );
      throw new Error('Failed to parse search response as JSON');
    }
    if (!parsedResponse.success) {
      const errObj = parsedResponse.error as Record<string, unknown> | undefined;
      throw new Error(`Search failed: ${errObj?.message || 'Unknown error'}`);
    }
    const dataObj = parsedResponse.data as Record<string, unknown> | undefined;
    const results: Array<Record<string, unknown>> = Array.isArray(dataObj?.results)
      ? (dataObj.results as Array<Record<string, unknown>>)
      : [];

    // Sanitize output path to prevent directory traversal
    const safeOutputPath = sanitizePath(input.output_path);

    // Ensure output directory exists
    const outputDir = path.dirname(safeOutputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    if (input.format === 'json') {
      const exportData = {
        results: results.map((r: Record<string, unknown>) => {
          const row: Record<string, unknown> = {
            document_id: r.document_id,
            source_file: r.source_file_name || r.source_file_path,
            page_number: r.page_number,
            score: r.bm25_score ?? r.similarity_score ?? r.rrf_score,
            result_type: r.result_type,
          };
          if (input.include_text) row.text = r.original_text;
          return row;
        }),
      };
      fs.writeFileSync(safeOutputPath, JSON.stringify(exportData, null, 2));
    } else {
      // CSV - RFC 4180 compliant: all fields double-quoted, internal quotes doubled
      const csvQuote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
      const headers = ['document_id', 'source_file', 'page_number', 'score', 'result_type'];
      if (input.include_text) headers.push('text');
      const csvLines = [headers.map(csvQuote).join(',')];
      for (const r of results) {
        const row = [
          csvQuote(String(r.document_id ?? '')),
          csvQuote(String(r.source_file_name || r.source_file_path || '')),
          csvQuote(r.page_number !== null && r.page_number !== undefined ? String(r.page_number) : ''),
          csvQuote(String(r.bm25_score ?? r.similarity_score ?? r.rrf_score ?? '')),
          csvQuote(String(r.result_type || '')),
        ];
        if (input.include_text) {
          row.push(csvQuote(String(r.original_text || '')));
        }
        csvLines.push(row.join(','));
      }
      fs.writeFileSync(safeOutputPath, csvLines.join('\n'));
    }

    return formatResponse(
      successResult({
        output_path: safeOutputPath,
        format: input.format,
        result_count: results.length,
        search_type: input.search_type,
        query: input.query,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVED SEARCH HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

const SearchSaveInput = z.object({
  name: z.string().min(1).max(200).describe('Name for the saved search'),
  query: z.string().min(1).max(1000).describe('The search query'),
  search_type: z.enum(['bm25', 'semantic', 'hybrid']).describe('Search method used'),
  search_params: z.record(z.unknown()).optional().describe('All search parameters as JSON'),
  result_count: z.number().int().min(0).describe('Number of results'),
  result_ids: z.array(z.string()).optional().describe('Array of chunk/embedding IDs from results'),
  notes: z.string().optional().describe('Optional notes about this search'),
});

const SearchSavedListInput = z.object({
  search_type: z.enum(['bm25', 'semantic', 'hybrid']).optional().describe('Filter by search type'),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

const SearchSavedGetInput = z.object({
  saved_search_id: z.string().min(1).describe('ID of the saved search to retrieve'),
});

const SearchSavedExecuteInput = z.object({
  saved_search_id: z.string().min(1).describe('ID of the saved search to re-execute'),
  override_limit: z.number().int().min(1).max(100).optional()
    .describe('Override the original result limit'),
});

/**
 * Handle ocr_search_save - Save search results with a name for later retrieval
 */
async function handleSearchSave(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSaveInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const id = uuidv4();
    const now = new Date().toISOString();

    conn.prepare(`
      INSERT INTO saved_searches (id, name, query, search_type, search_params, result_count, result_ids, created_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.query,
      input.search_type,
      JSON.stringify(input.search_params ?? {}),
      input.result_count,
      JSON.stringify(input.result_ids ?? []),
      now,
      input.notes ?? null,
    );

    return formatResponse(successResult({
      saved_search_id: id,
      name: input.name,
      query: input.query,
      search_type: input.search_type,
      result_count: input.result_count,
      created_at: now,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_search_saved_list - List saved searches with optional type filtering
 */
async function handleSearchSavedList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSavedListInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    let sql = 'SELECT id, name, query, search_type, result_count, created_at, notes FROM saved_searches';
    const sqlParams: unknown[] = [];

    if (input.search_type) {
      sql += ' WHERE search_type = ?';
      sqlParams.push(input.search_type);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    sqlParams.push(input.limit, input.offset);

    const rows = conn.prepare(sql).all(...sqlParams) as Array<{
      id: string; name: string; query: string; search_type: string;
      result_count: number; created_at: string; notes: string | null;
    }>;

    const totalRow = conn.prepare(
      input.search_type
        ? 'SELECT COUNT(*) as count FROM saved_searches WHERE search_type = ?'
        : 'SELECT COUNT(*) as count FROM saved_searches'
    ).get(...(input.search_type ? [input.search_type] : [])) as { count: number };

    return formatResponse(successResult({
      saved_searches: rows,
      total: totalRow.count,
      limit: input.limit,
      offset: input.offset,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_search_saved_get - Retrieve a saved search by ID including all parameters and result IDs
 */
async function handleSearchSavedGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSavedGetInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const row = conn.prepare(
      'SELECT * FROM saved_searches WHERE id = ?'
    ).get(input.saved_search_id) as {
      id: string; name: string; query: string; search_type: string;
      search_params: string; result_count: number; result_ids: string;
      created_at: string; notes: string | null;
    } | undefined;

    if (!row) {
      throw new Error(`Saved search not found: ${input.saved_search_id}`);
    }

    return formatResponse(successResult({
      id: row.id,
      name: row.name,
      query: row.query,
      search_type: row.search_type,
      search_params: JSON.parse(row.search_params),
      result_count: row.result_count,
      result_ids: JSON.parse(row.result_ids),
      created_at: row.created_at,
      notes: row.notes,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_search_saved_execute - Re-execute a saved search with current data
 *
 * Reads the saved search parameters and dispatches to the appropriate search handler
 * (handleSearch, handleSearchSemantic, or handleSearchHybrid) based on the saved search_type.
 */
async function handleSearchSavedExecute(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSavedExecuteInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Retrieve saved search
    const row = conn.prepare(
      'SELECT * FROM saved_searches WHERE id = ?'
    ).get(input.saved_search_id) as {
      id: string; name: string; query: string; search_type: string;
      search_params: string; result_count: number; result_ids: string;
      created_at: string; notes: string | null;
    } | undefined;

    if (!row) {
      throw new MCPError('VALIDATION_ERROR', `Saved search not found: ${input.saved_search_id}`);
    }

    // Parse stored search parameters
    let searchParams: Record<string, unknown>;
    try {
      searchParams = JSON.parse(row.search_params) as Record<string, unknown>;
    } catch (parseErr) {
      throw new MCPError('INTERNAL_ERROR', `Failed to parse saved search params: ${String(parseErr)}`);
    }

    // Override limit if requested
    if (input.override_limit !== undefined) {
      searchParams.limit = input.override_limit;
    }

    // Ensure query is set in params
    searchParams.query = row.query;

    // Dispatch to appropriate handler based on search_type
    let searchResult: ToolResponse;
    switch (row.search_type) {
      case 'bm25':
        searchResult = await handleSearch(searchParams as Record<string, unknown>);
        break;
      case 'semantic':
        searchResult = await handleSearchSemantic(searchParams as Record<string, unknown>);
        break;
      case 'hybrid':
        searchResult = await handleSearchHybrid(searchParams as Record<string, unknown>);
        break;
      default:
        throw new MCPError('VALIDATION_ERROR', `Unknown search type: ${row.search_type}`);
    }

    // Parse the search result to wrap with saved search metadata
    const searchResultData = JSON.parse(searchResult.content[0].text) as Record<string, unknown>;

    return formatResponse(successResult({
      saved_search: {
        id: row.id,
        name: row.name,
        query: row.query,
        search_type: row.search_type,
        original_result_count: row.result_count,
        created_at: row.created_at,
        notes: row.notes,
      },
      re_executed_at: new Date().toISOString(),
      search_results: searchResultData,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-DATABASE SEARCH HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

const CrossDbSearchInput = z.object({
  query: z.string().min(1).describe('Search query'),
  database_names: z.array(z.string()).optional()
    .describe('Database names to search (default: all databases)'),
  limit_per_db: z.number().int().min(1).max(50).default(10)
    .describe('Maximum results per database'),
});

/**
 * Handle ocr_search_cross_db - Search across multiple databases using BM25
 */
async function handleCrossDbSearch(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(CrossDbSearchInput, params);

    const { listDatabases } = await import('../services/storage/database/static-operations.js');
    const Database = (await import('better-sqlite3')).default;

    // Get list of databases
    let databases = listDatabases();

    // Filter to requested database_names if provided
    if (input.database_names && input.database_names.length > 0) {
      const nameSet = new Set(input.database_names);
      databases = databases.filter((db) => nameSet.has(db.name));
    }

    const allResults: Array<{
      database_name: string;
      document_id: string;
      file_name: string | null;
      chunk_id: string;
      chunk_index: number;
      text_preview: string;
      bm25_score: number;
    }> = [];
    const skippedDbs: Array<{ name: string; reason: string }> = [];

    for (const dbInfo of databases) {
      let conn: import('better-sqlite3').Database | null = null;
      try {
        conn = new Database(dbInfo.path, { readonly: true });

        // Check if FTS table exists
        const ftsCheck = conn
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
          .get() as { name: string } | undefined;

        if (!ftsCheck) {
          skippedDbs.push({ name: dbInfo.name, reason: 'No FTS index (chunks_fts table not found)' });
          continue;
        }

        // Run BM25 search
        const rows = conn
          .prepare(
            `SELECT c.id, c.document_id, c.text, c.chunk_index, rank
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             WHERE chunks_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(input.query, input.limit_per_db) as Array<{
          id: string;
          document_id: string;
          text: string;
          chunk_index: number;
          rank: number;
        }>;

        for (const row of rows) {
          // Get document info
          const docInfo = conn
            .prepare('SELECT file_name, file_path FROM documents WHERE id = ?')
            .get(row.document_id) as { file_name: string; file_path: string } | undefined;

          allResults.push({
            database_name: dbInfo.name,
            document_id: row.document_id,
            file_name: docInfo?.file_name ?? null,
            chunk_id: row.id,
            chunk_index: row.chunk_index,
            text_preview: row.text.substring(0, 300),
            bm25_score: row.rank,
          });
        }
      } catch (dbError) {
        const errMsg = dbError instanceof Error ? dbError.message : String(dbError);
        console.error(`[CrossDbSearch] Failed to search database ${dbInfo.name}: ${errMsg}`);
        skippedDbs.push({ name: dbInfo.name, reason: errMsg });
      } finally {
        if (conn) {
          try {
            conn.close();
          } catch (closeErr) {
            console.error(`[CrossDbSearch] Failed to close connection to ${dbInfo.name}: ${String(closeErr)}`);
          }
        }
      }
    }

    // Sort by absolute BM25 rank (BM25 scores are negative, lower=better)
    allResults.sort((a, b) => a.bm25_score - b.bm25_score);

    return formatResponse(
      successResult({
        query: input.query,
        databases_searched: databases.length - skippedDbs.length,
        total_results: allResults.length,
        results: allResults,
        databases_skipped: skippedDbs.length > 0 ? skippedDbs : undefined,
      })
    );
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
      metadata_filter: z
        .object({
          doc_title: z.string().optional(),
          doc_author: z.string().optional(),
          doc_subject: z.string().optional(),
        })
        .optional()
        .describe('Filter by document metadata (LIKE match)'),
      min_quality_score: z
        .number()
        .min(0)
        .max(5)
        .optional()
        .describe('Minimum OCR quality score (0-5)'),
      expand_query: z
        .boolean()
        .default(false)
        .describe('Expand query with domain-specific legal/medical synonyms'),
      rerank: z
        .boolean()
        .default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
      cluster_id: z.string().optional().describe('Filter results to documents in this cluster'),
      include_cluster_context: z
        .boolean()
        .default(false)
        .describe('Include cluster membership info for each result'),
      content_type_filter: z
        .array(z.string())
        .optional()
        .describe('Filter by chunk content types (e.g., ["table", "code", "heading"])'),
      section_path_filter: z
        .string()
        .optional()
        .describe('Filter by section path prefix (e.g., "Section 3" matches "Section 3 > 3.1 > Definitions")'),
      heading_filter: z
        .string()
        .optional()
        .describe('Filter by heading context text (LIKE match)'),
      page_range_filter: z
        .object({
          min_page: z.number().int().min(1).optional(),
          max_page: z.number().int().min(1).optional(),
        })
        .optional()
        .describe('Filter results to specific page range'),
      quality_boost: z
        .boolean()
        .default(false)
        .describe('Boost results from higher-quality OCR pages in ranking'),
    },
    handler: handleSearch,
  },
  ocr_search_semantic: {
    description: 'Search documents using semantic similarity (vector search)',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
      similarity_threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe('Minimum similarity score (0-1)'),
      include_provenance: z
        .boolean()
        .default(false)
        .describe('Include provenance chain in results'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
      metadata_filter: z
        .object({
          doc_title: z.string().optional(),
          doc_author: z.string().optional(),
          doc_subject: z.string().optional(),
        })
        .optional()
        .describe('Filter by document metadata (LIKE match)'),
      min_quality_score: z
        .number()
        .min(0)
        .max(5)
        .optional()
        .describe('Minimum OCR quality score (0-5)'),
      expand_query: z
        .boolean()
        .default(false)
        .describe('Expand query with domain-specific legal/medical synonyms'),
      rerank: z
        .boolean()
        .default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
      cluster_id: z.string().optional().describe('Filter results to documents in this cluster'),
      include_cluster_context: z
        .boolean()
        .default(false)
        .describe('Include cluster membership info for each result'),
      content_type_filter: z
        .array(z.string())
        .optional()
        .describe('Filter by chunk content types (e.g., ["table", "code", "heading"])'),
      section_path_filter: z
        .string()
        .optional()
        .describe('Filter by section path prefix (e.g., "Section 3" matches "Section 3 > 3.1 > Definitions")'),
      heading_filter: z
        .string()
        .optional()
        .describe('Filter by heading context text (LIKE match)'),
      page_range_filter: z
        .object({
          min_page: z.number().int().min(1).optional(),
          max_page: z.number().int().min(1).optional(),
        })
        .optional()
        .describe('Filter results to specific page range'),
      quality_boost: z
        .boolean()
        .default(false)
        .describe('Boost results from higher-quality OCR pages in ranking'),
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
      metadata_filter: z
        .object({
          doc_title: z.string().optional(),
          doc_author: z.string().optional(),
          doc_subject: z.string().optional(),
        })
        .optional()
        .describe('Filter by document metadata (LIKE match)'),
      min_quality_score: z
        .number()
        .min(0)
        .max(5)
        .optional()
        .describe('Minimum OCR quality score (0-5)'),
      expand_query: z
        .boolean()
        .default(false)
        .describe('Expand query with domain-specific legal/medical synonyms'),
      rerank: z
        .boolean()
        .default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
      cluster_id: z.string().optional().describe('Filter results to documents in this cluster'),
      include_cluster_context: z
        .boolean()
        .default(false)
        .describe('Include cluster membership info for each result'),
      content_type_filter: z
        .array(z.string())
        .optional()
        .describe('Filter by chunk content types (e.g., ["table", "code", "heading"])'),
      section_path_filter: z
        .string()
        .optional()
        .describe('Filter by section path prefix (e.g., "Section 3" matches "Section 3 > 3.1 > Definitions")'),
      heading_filter: z
        .string()
        .optional()
        .describe('Filter by heading context text (LIKE match)'),
      page_range_filter: z
        .object({
          min_page: z.number().int().min(1).optional(),
          max_page: z.number().int().min(1).optional(),
        })
        .optional()
        .describe('Filter results to specific page range'),
      quality_boost: z
        .boolean()
        .default(false)
        .describe('Boost results from higher-quality OCR pages in ranking'),
      auto_route: z
        .boolean()
        .default(false)
        .describe('Auto-adjust BM25/semantic weights based on query classification'),
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
      search_type: z
        .enum(['bm25', 'semantic', 'hybrid'])
        .default('hybrid')
        .describe('Search method to use'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximum results'),
      format: z.enum(['csv', 'json']).default('csv').describe('Export file format'),
      output_path: z.string().min(1).describe('File path to save export'),
      include_text: z.boolean().default(true).describe('Include full text in export'),
    },
    handler: handleSearchExport,
  },
  ocr_benchmark_compare: {
    description: 'Compare search results across multiple databases for benchmarking',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      database_names: z
        .array(z.string().min(1))
        .min(2)
        .describe('Database names to compare (minimum 2)'),
      search_type: z.enum(['bm25', 'semantic']).default('bm25').describe('Search method to use'),
      limit: z.number().int().min(1).max(50).default(10).describe('Maximum results per database'),
    },
    handler: handleBenchmarkCompare,
  },
  ocr_rag_context: {
    description:
      'Assemble a RAG (Retrieval-Augmented Generation) context block for LLM consumption. Runs hybrid search and returns a single markdown context block.',
    inputSchema: {
      question: z.string().min(1).max(2000).describe('The question to build context for'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Maximum search results to include in context'),
      document_filter: z.array(z.string()).optional().describe('Restrict to specific documents'),
      max_context_length: z
        .number()
        .int()
        .min(500)
        .max(50000)
        .default(8000)
        .describe('Maximum total context length in characters'),
    },
    handler: handleRagContext,
  },
  ocr_search_save: {
    description: 'Save search results with a name for later retrieval',
    inputSchema: SearchSaveInput.shape,
    handler: handleSearchSave,
  },
  ocr_search_saved_list: {
    description: 'List saved searches with optional type filtering',
    inputSchema: SearchSavedListInput.shape,
    handler: handleSearchSavedList,
  },
  ocr_search_saved_get: {
    description: 'Retrieve a saved search by ID including all parameters and result IDs',
    inputSchema: SearchSavedGetInput.shape,
    handler: handleSearchSavedGet,
  },
  ocr_search_saved_execute: {
    description: 'Re-execute a saved search with current data. Reads saved parameters and dispatches to the original search handler (BM25, semantic, or hybrid).',
    inputSchema: SearchSavedExecuteInput.shape,
    handler: handleSearchSavedExecute,
  },
  ocr_search_cross_db: {
    description:
      'Search across multiple databases using BM25 full-text search. Opens each database independently as read-only. Returns merged results sorted by BM25 rank.',
    inputSchema: CrossDbSearchInput.shape,
    handler: handleCrossDbSearch,
  },
};
