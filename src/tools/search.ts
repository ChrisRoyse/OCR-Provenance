/**
 * Search MCP Tools
 *
 * Tools: ocr_search (unified: keyword/semantic/hybrid), ocr_fts_manage,
 *        ocr_search_export, ocr_benchmark_compare, ocr_rag_context,
 *        ocr_search_saved (unified: save/list/get/execute)
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/search
 */

import * as fs from 'fs';
import * as path from 'path';
import { safeMin, safeMax } from '../utils/math.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { DatabaseService } from '../services/storage/database/index.js';
import { VectorService } from '../services/storage/vector.js';
import { requireDatabase, getDefaultStoragePath, withDatabaseOperation } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  sanitizePath,
  escapeLikePattern,
  SearchUnifiedInput,
  FTSManageInput,
} from '../utils/validation.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { BM25SearchService, sanitizeFTS5Query } from '../services/search/bm25.js';
import { RRFFusion, type RankedResult } from '../services/search/fusion.js';
import { rerankResults } from '../services/search/reranker.js';
import { expandQuery, getExpandedTerms } from '../services/search/query-expander.js';
import { classifyQuery, isTableQuery } from '../services/search/query-classifier.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getImage } from '../services/storage/database/image-operations.js';
import {
  computeBlockConfidence,
  isRepeatedHeaderFooter,
} from '../services/chunking/json-block-analyzer.js';

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

/** Query expansion details returned by getExpandedTerms */
interface QueryExpansionInfo {
  original: string;
  expanded: string[];
  synonyms_found: Record<string, string[]>;
  corpus_terms?: Record<string, string[]>;
}

/**
 * Internal search params type used by the internal handlers.
 * Includes all unified schema fields plus always-on fields injected by handleSearchUnified.
 */
interface InternalSearchParams {
  query: string;
  mode: 'keyword' | 'semantic' | 'hybrid';
  limit: number;
  include_provenance: boolean;
  document_filter?: string[];
  metadata_filter?: { doc_title?: string; doc_author?: string; doc_subject?: string };
  min_quality_score?: number;
  rerank: boolean;
  cluster_id?: string;
  content_type_filter?: string[];
  section_path_filter?: string;
  heading_filter?: string;
  page_range_filter?: { min_page?: number; max_page?: number };
  is_atomic_filter?: boolean;
  heading_level_filter?: { min_level?: number; max_level?: number };
  min_page_count?: number;
  max_page_count?: number;
  include_context_chunks: number;
  table_columns_contain?: string;
  group_by_document: boolean;
  // Keyword-mode specific
  phrase_search: boolean;
  include_highlight: boolean;
  // Semantic-mode specific
  similarity_threshold: number;
  // Hybrid-mode specific
  bm25_weight: number;
  semantic_weight: number;
  rrf_k: number;
  auto_route: boolean;
  // Always-on fields injected by unified handler
  /** @deprecated Quality boost is always applied. Field retained for schema compatibility. */
  quality_boost: boolean;
  expand_query: boolean;
  exclude_duplicate_chunks: boolean;
  include_headers_footers: boolean;
  include_cluster_context: boolean;
  include_document_context: boolean;
  // V7 Intelligence Optimization
  compact: boolean;
  include_provenance_summary: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT GROUPING HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/** A group of search results belonging to a single source document */
interface DocumentGroup {
  document_id: string;
  file_name: string;
  file_path: string;
  doc_title: string | null;
  doc_author: string | null;
  total_pages: number | null;
  total_chunks: number;
  ocr_quality_score: number | null;
  result_count: number;
  results: Array<Record<string, unknown>>;
}

/**
 * Group flat search results by their source document.
 * Each group contains document-level metadata and the subset of results
 * belonging to that document. Groups are sorted by result_count descending.
 */
function groupResultsByDocument(results: Array<Record<string, unknown>>): {
  grouped: DocumentGroup[];
  total_documents: number;
} {
  const groups = new Map<string, DocumentGroup>();

  for (const r of results) {
    const docId = (r.document_id ?? r.source_document_id) as string;
    if (!docId) continue;

    if (!groups.has(docId)) {
      groups.set(docId, {
        document_id: docId,
        file_name: (r.source_file_name as string) ?? '',
        file_path: (r.source_file_path as string) ?? '',
        doc_title: (r.doc_title as string) ?? null,
        doc_author: (r.doc_author as string) ?? null,
        total_pages: (r.doc_page_count as number) ?? null,
        total_chunks: (r.total_chunks as number) ?? 0,
        ocr_quality_score: (r.ocr_quality_score as number) ?? null,
        result_count: 0,
        results: [],
      });
    }
    const group = groups.get(docId)!;
    group.result_count++;
    group.results.push(r);
  }

  return {
    grouped: Array.from(groups.values()).sort((a, b) => b.result_count - a.result_count),
    total_documents: groups.size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// METADATA FILTER RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve metadata_filter to document IDs.
 * Returns existingDocFilter unchanged if no metadata filter is specified.
 * Returns ['__no_match__'] sentinel if filter is specified but matches zero documents,
 * ensuring downstream filters (e.g. resolveClusterFilter) correctly block all results.
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
  const ids = rows.map((r) => r.id);
  // Return sentinel when metadata filter was specified but matched zero documents,
  // so downstream filters (e.g. resolveClusterFilter) correctly intersect with empty set
  // instead of treating it as "no filter".
  if (ids.length === 0) return ['__no_match__'];
  return ids;
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
  if (minQualityScore === undefined || minQualityScore === 0) return existingDocFilter;
  const rows = db
    .getConnection()
    .prepare(
      `SELECT DISTINCT d.id FROM documents d
     JOIN ocr_results o ON o.document_id = d.id
     WHERE o.parse_quality_score IS NOT NULL AND o.parse_quality_score >= ?`
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
function resolveChunkFilter(filters: {
  content_type_filter?: string[];
  section_path_filter?: string;
  heading_filter?: string;
  page_range_filter?: { min_page?: number; max_page?: number };
  is_atomic_filter?: boolean;
  heading_level_filter?: { min_level?: number; max_level?: number };
  min_page_count?: number;
  max_page_count?: number;
  table_columns_contain?: string;
}): ChunkFilterSQL {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.content_type_filter && filters.content_type_filter.length > 0) {
    // content_types is JSON array like '["table","text"]'
    // Match if ANY of the requested types appear
    const typeConditions = filters.content_type_filter.map(
      () => "c.content_types LIKE '%' || ? || '%'"
    );
    conditions.push(`(${typeConditions.join(' OR ')})`);
    params.push(...filters.content_type_filter.map((t) => `"${t}"`));
  }

  if (filters.section_path_filter) {
    conditions.push("c.section_path LIKE ? || '%' ESCAPE '\\'");
    params.push(escapeLikePattern(filters.section_path_filter));
  }

  if (filters.heading_filter) {
    const escaped = escapeLikePattern(filters.heading_filter);
    conditions.push("(c.heading_context LIKE '%' || ? || '%' ESCAPE '\\' OR c.section_path LIKE '%' || ? || '%' ESCAPE '\\')");
    params.push(escaped, escaped);
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

  if (filters.is_atomic_filter !== undefined) {
    conditions.push(`c.is_atomic = ?`);
    params.push(filters.is_atomic_filter ? 1 : 0);
  }

  if (filters.heading_level_filter) {
    if (filters.heading_level_filter.min_level !== undefined) {
      conditions.push('c.heading_level >= ?');
      params.push(filters.heading_level_filter.min_level);
    }
    if (filters.heading_level_filter.max_level !== undefined) {
      conditions.push('c.heading_level <= ?');
      params.push(filters.heading_level_filter.max_level);
    }
  }

  if (filters.min_page_count !== undefined) {
    conditions.push('(SELECT page_count FROM documents WHERE id = c.document_id) >= ?');
    params.push(filters.min_page_count);
  }

  if (filters.max_page_count !== undefined) {
    conditions.push('(SELECT page_count FROM documents WHERE id = c.document_id) <= ?');
    params.push(filters.max_page_count);
  }

  if (filters.table_columns_contain) {
    // Filter to atomic table chunks with matching column headers in provenance processing_params
    conditions.push(`c.is_atomic = 1`);
    conditions.push(
      `EXISTS (SELECT 1 FROM provenance p WHERE p.id = c.provenance_id AND LOWER(p.processing_params) LIKE '%' || LOWER(?) || '%')`
    );
    params.push(filters.table_columns_contain);
  }

  return { conditions, params };
}

/**
 * Determine whether VLM search results should be skipped based on chunk-level filters.
 * VLM results don't have content_type, heading, or section_path columns,
 * so they must be excluded when the user explicitly filters by those fields.
 */
function shouldSkipVlmSearch(input: InternalSearchParams): boolean {
  // If content_type_filter is set and does NOT include 'vlm' or 'image', skip VLM
  if (input.content_type_filter && input.content_type_filter.length > 0) {
    const hasVlmType = input.content_type_filter.some(
      (t) => t === 'vlm' || t === 'image'
    );
    if (!hasVlmType) {
      console.error('[Search] Skipping VLM results: content_type_filter excludes image/vlm content');
      return true;
    }
  }

  // VLM results don't have heading/section data, so skip when those filters are set
  if (input.heading_filter) {
    console.error('[Search] Skipping VLM results: heading_filter set but VLM results lack heading data');
    return true;
  }
  if (input.section_path_filter) {
    console.error('[Search] Skipping VLM results: section_path_filter set but VLM results lack section data');
    return true;
  }

  return false;
}

/**
 * Attach neighboring chunk context to search results.
 * For each result with a chunk_id and chunk_index, fetches N neighbors before and after.
 * Deduplicates: skips neighbors that are already primary results.
 */
function attachContextChunks(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  results: Array<Record<string, unknown>>,
  contextSize: number
): void {
  if (contextSize <= 0 || results.length === 0) return;

  // Build set of primary result chunk IDs for dedup
  const primaryChunkIds = new Set(results.map((r) => r.chunk_id as string).filter(Boolean));

  // Group results by document_id for batch queries
  const byDoc = new Map<string, Array<Record<string, unknown>>>();
  for (const r of results) {
    const docId = r.document_id as string;
    const chunkIndex = r.chunk_index as number | undefined;
    if (!docId || chunkIndex === undefined) {
      r.context_before = [];
      r.context_after = [];
      continue;
    }
    if (!byDoc.has(docId)) byDoc.set(docId, []);
    byDoc.get(docId)!.push(r);
  }

  for (const [docId, docResults] of byDoc) {
    // Batch query: get all potentially needed chunks for this doc
    const allIndices = docResults.map((r) => r.chunk_index as number);
    const minIdx = (safeMin(allIndices) ?? 0) - contextSize;
    const maxIdx = (safeMax(allIndices) ?? 0) + contextSize;

    const neighbors = conn
      .prepare(
        `SELECT id, text, chunk_index, page_number, heading_context, section_path, content_types
       FROM chunks
       WHERE document_id = ? AND chunk_index BETWEEN ? AND ?
       ORDER BY chunk_index`
      )
      .all(docId, minIdx, maxIdx) as Array<{
      id: string;
      text: string;
      chunk_index: number;
      page_number: number | null;
      heading_context: string | null;
      section_path: string | null;
      content_types: string | null;
    }>;

    const neighborMap = new Map(neighbors.map((n) => [n.chunk_index, n]));

    for (const r of docResults) {
      const idx = r.chunk_index as number;
      const before: Array<Record<string, unknown>> = [];
      const after: Array<Record<string, unknown>> = [];

      for (let i = idx - contextSize; i < idx; i++) {
        const n = neighborMap.get(i);
        if (n && !primaryChunkIds.has(n.id)) {
          before.push({
            chunk_id: n.id,
            chunk_index: n.chunk_index,
            text: n.text.substring(0, 500),
            page_number: n.page_number,
            heading_context: n.heading_context,
            is_context: true,
          });
        }
      }

      for (let i = idx + 1; i <= idx + contextSize; i++) {
        const n = neighborMap.get(i);
        if (n && !primaryChunkIds.has(n.id)) {
          after.push({
            chunk_id: n.id,
            chunk_index: n.chunk_index,
            text: n.text.substring(0, 500),
            page_number: n.page_number,
            heading_context: n.heading_context,
            is_context: true,
          });
        }
      }

      r.context_before = before;
      r.context_after = after;
    }
  }
}

/**
 * Attach table metadata to search results for table chunks.
 * For each result where content_types contains "table",
 * queries provenance processing_params to extract table_columns, table_row_count, table_column_count.
 * Batches queries by chunk_id.
 */
function attachTableMetadata(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  results: Array<Record<string, unknown>>
): void {
  // Find table chunk IDs (any chunk with "table" in content_types, not just atomic)
  const tableChunkIds: string[] = [];
  for (const r of results) {
    if (r.chunk_id && typeof r.content_types === 'string' && r.content_types.includes('"table"')) {
      tableChunkIds.push(r.chunk_id as string);
    }
  }
  if (tableChunkIds.length === 0) return;

  // Batch query provenance for table metadata via chunks.provenance_id -> provenance.id
  const placeholders = tableChunkIds.map(() => '?').join(',');
  const rows = conn
    .prepare(
      `SELECT c.id AS chunk_id, p.processing_params
     FROM chunks c
     INNER JOIN provenance p ON c.provenance_id = p.id
     WHERE c.id IN (${placeholders})`
    )
    .all(...tableChunkIds) as Array<{ chunk_id: string; processing_params: string }>;

  // Build map: chunk_id -> table metadata
  const metadataMap = new Map<
    string,
    { table_columns: string[]; table_row_count: number; table_column_count: number }
  >();
  for (const row of rows) {
    if (metadataMap.has(row.chunk_id)) continue;
    try {
      const params = JSON.parse(row.processing_params);
      if (params.table_columns) {
        metadataMap.set(row.chunk_id, {
          table_columns: params.table_columns,
          table_row_count: params.table_row_count ?? 0,
          table_column_count: params.table_column_count ?? 0,
        });
      }
    } catch (error) {
      console.error(
        `[search] Failed to parse processing_params for chunk ${row.chunk_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Attach to results as top-level fields
  for (const r of results) {
    const meta = r.chunk_id ? metadataMap.get(r.chunk_id as string) : undefined;
    if (meta) {
      r.table_columns = meta.table_columns;
      r.table_row_count = meta.table_row_count;
      r.table_column_count = meta.table_column_count;
    }
  }
}

/**
 * Exclude chunks tagged as repeated headers/footers (T2.8).
 * Queries entity_tags for the system:repeated_header_footer tag
 * and filters them out of the results array.
 * Returns a new filtered array.
 */
function excludeRepeatedHeaderFooterChunks(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  results: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const taggedChunks = conn
    .prepare(
      `SELECT et.entity_id FROM entity_tags et
     JOIN tags t ON t.id = et.tag_id
     WHERE t.name = 'system:repeated_header_footer' AND et.entity_type = 'chunk'`
    )
    .all() as Array<{ entity_id: string }>;

  if (taggedChunks.length === 0) return results;

  const excludeChunkIds = new Set(taggedChunks.map((t) => t.entity_id));
  return results.filter((r) => {
    const chunkId = r.chunk_id as string | null;
    return !chunkId || !excludeChunkIds.has(chunkId);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// V7 INTELLIGENCE OPTIMIZATION - COMPACT MODE & PROVENANCE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map a full search result to compact format, keeping only essential fields.
 * Reduces token count by ~77% per result.
 */
function compactResult(r: Record<string, unknown>, mode: string): Record<string, unknown> {
  let scoreField: string;
  switch (mode) {
    case 'keyword':
      scoreField = 'bm25_score';
      break;
    case 'hybrid':
      scoreField = 'rrf_score';
      break;
    default:
      scoreField = 'similarity_score';
      break;
  }
  return {
    document_id: r.document_id,
    chunk_id: r.chunk_id,
    original_text: r.original_text,
    source_file_name: r.source_file_name,
    page_number: r.page_number,
    score: r[scoreField] ?? r.similarity_score ?? r.bm25_score ?? r.rrf_score,
    result_type: r.result_type,
  };
}

/**
 * Build a one-line provenance summary string from the provenance chain.
 * Format: "FILE → OCR (marker, 92% quality) → Chunk 3 → Embedding"
 */
function buildProvenanceSummary(
  db: ReturnType<typeof requireDatabase>['db'],
  provenanceId: string | null | undefined
): string | undefined {
  if (!provenanceId) return undefined;
  try {
    const chain = db.getProvenanceChain(provenanceId);
    if (!chain || chain.length === 0) return undefined;
    const parts: string[] = [];
    for (const link of chain) {
      switch (link.type) {
        case 'DOCUMENT': {
          const sourceType = link.source_type;
          parts.push(sourceType?.toUpperCase() ?? 'DOCUMENT');
          break;
        }
        case 'OCR_RESULT': {
          const qualityScore = link.processing_quality_score;
          const qualityStr = qualityScore != null ? `, quality ${qualityScore.toFixed(1)}/5.0` : '';
          parts.push(`OCR (${link.processor ?? 'unknown'}${qualityStr})`);
          break;
        }
        case 'CHUNK': {
          const chunkIndex = link.location?.chunk_index;
          const chunkStr = chunkIndex !== undefined ? ` ${chunkIndex + 1}` : '';
          parts.push(`Chunk${chunkStr}`);
          break;
        }
        case 'EMBEDDING':
          parts.push('Embedding');
          break;
        case 'VLM_DESCRIPTION':
          parts.push('VLM');
          break;
        default:
          parts.push(link.type);
          break;
      }
    }
    return parts.join(' \u2192 ');
  } catch (err) {
    console.error(
      `[search] Failed to build provenance summary for ${provenanceId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * Apply V7 compact mode and provenance summary to response data.
 * Modifies responseData.results in place. Must be called BEFORE grouping.
 */
function applyV7Transforms(
  responseData: Record<string, unknown>,
  input: InternalSearchParams,
  db: ReturnType<typeof requireDatabase>['db'],
  mode: string
): void {
  // V7: Attach provenance summary one-liners BEFORE compact (compact strips provenance_id)
  if (input.include_provenance_summary) {
    for (const r of responseData.results as Array<Record<string, unknown>>) {
      r.provenance_summary = buildProvenanceSummary(
        db,
        r.provenance_id as string | null | undefined
      );
    }
  }

  // V7: Apply compact mode - strip results to essential fields only
  if (input.compact) {
    responseData.results = (responseData.results as Array<Record<string, unknown>>).map((r) => {
      const compacted = compactResult(r, mode);
      // Preserve provenance_summary if it was attached above
      if (r.provenance_summary) compacted.provenance_summary = r.provenance_summary;
      return compacted;
    });
    responseData.compact = true;
  }
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
 * Attach cross-document context (cluster memberships and related comparisons)
 * to the first result per document. This gives callers awareness of how each
 * source document relates to the wider corpus without bloating every result.
 */
function attachCrossDocumentContext(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  results: Array<Record<string, unknown>>
): void {
  const docIds = [
    ...new Set(
      results.map((r) => (r.document_id ?? r.source_document_id) as string).filter(Boolean)
    ),
  ];
  if (docIds.length === 0) return;

  const contextMap = new Map<string, Record<string, unknown>>();

  for (const docId of docIds) {
    try {
      // Get cluster memberships
      const clusters = conn
        .prepare(
          `SELECT c.id, c.label, c.classification_tag, dc.similarity_to_centroid
         FROM document_clusters dc JOIN clusters c ON c.id = dc.cluster_id
         WHERE dc.document_id = ? LIMIT 3`
        )
        .all(docId) as Array<Record<string, unknown>>;

      // Get comparison summaries (documents already compared to this one)
      const comparisons = conn
        .prepare(
          `SELECT
           CASE WHEN document_id_1 = ? THEN document_id_2 ELSE document_id_1 END as related_doc_id,
           similarity_ratio, summary
         FROM comparisons
         WHERE document_id_1 = ? OR document_id_2 = ?
         ORDER BY similarity_ratio DESC LIMIT 3`
        )
        .all(docId, docId, docId) as Array<Record<string, unknown>>;

      contextMap.set(docId, {
        clusters: clusters.length > 0 ? clusters : null,
        related_documents: comparisons.length > 0 ? comparisons : null,
      });
    } catch (error) {
      console.error(`[Search] Failed to get cross-document context for ${docId}: ${String(error)}`);
    }
  }

  // Attach to first result per document (not every result to reduce noise)
  const seen = new Set<string>();
  for (const r of results) {
    const docId = (r.document_id ?? r.source_document_id) as string;
    if (docId && !seen.has(docId)) {
      seen.add(docId);
      const ctx = contextMap.get(docId);
      if (ctx) {
        r.document_context = ctx;
      }
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
        result.image_dimensions = {
          width: image.dimensions.width,
          height: image.dimensions.height,
        };
        result.image_block_type = image.block_type;
        result.image_format = image.format;
      }
    }
  }
}

/**
 * Apply post-retrieval score boosting based on chunk metadata.
 *
 * Tasks 2.1-2.3 + 4.3 integration:
 * - Heading level boost: H1=1.3x, H2=1.2x, H3=1.1x, body=1.0x
 * - Atomic chunk boost: complete semantic units get 1.1x
 * - Content-type preference: query keyword matching boosts table/code/list results
 * - Block confidence: computed from content types via computeBlockConfidence (0.8x-1.16x)
 *
 * Mutates score fields (bm25_score, similarity_score, rrf_score) in place.
 */
function applyMetadataBoosts(
  results: Array<Record<string, unknown>>,
  options: {
    headingBoost?: boolean;
    atomicBoost?: boolean;
    contentTypeQuery?: string;
    repeatedHeaderFooterTexts?: string[];
  }
): void {
  for (const r of results) {
    let boost = 1.0;

    // Task 2.1: Heading level boost: H1=1.3x, H2=1.2x, H3=1.1x, body=1.0x
    if (options.headingBoost !== false) {
      const level = (r.heading_level as number) ?? 5;
      const clampedLevel = Math.min(Math.max(level, 1), 4);
      boost *= 1 + 0.1 * (4 - clampedLevel);
    }

    // Task 2.2: Atomic chunk boost: complete semantic units get 1.1x
    if (options.atomicBoost !== false && r.is_atomic) {
      boost *= 1.1;
    }

    // Task 2.3: Content-type preference based on query keywords
    if (options.contentTypeQuery) {
      const q = options.contentTypeQuery.toLowerCase();
      const contentTypes = r.content_types as string | null;
      if (contentTypes) {
        if (
          /\b(table|data|statistic|row|column|figure|chart)\b/.test(q) &&
          contentTypes.includes('"table"')
        ) {
          boost *= 1.2;
        }
        if (
          /\b(code|function|class|method|import|variable|api)\b/.test(q) &&
          contentTypes.includes('"code"')
        ) {
          boost *= 1.2;
        }
        if (
          /\b(list|items|steps|requirements|criteria)\b/.test(q) &&
          contentTypes.includes('"list"')
        ) {
          boost *= 1.15;
        }
      }
    }

    // Task 4.3 integration: Block confidence from content types (computed on-the-fly)
    try {
      const contentTypesRaw = r.content_types as string | null;
      if (contentTypesRaw) {
        const parsed = JSON.parse(contentTypesRaw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const blockConf = computeBlockConfidence(parsed);
          boost *= 0.8 + 0.4 * blockConf; // range: 0.8x to 1.16x
        }
      }
    } catch (error) {
      console.error(
        `[search] Failed to parse content_types for chunk ${r.chunk_id ?? 'unknown'} during quality boost: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Task 7.1: Header/footer penalty - demote chunks matching repeated headers/footers
    // Two-tier detection:
    // 1. Explicit: caller provides known repeated texts from detectRepeatedHeadersFooters()
    // 2. Heuristic: short chunks with typical header/footer patterns get penalized
    const chunkText = (r.original_text as string) ?? '';
    if (options.repeatedHeaderFooterTexts && options.repeatedHeaderFooterTexts.length > 0) {
      if (
        chunkText.length > 0 &&
        isRepeatedHeaderFooter(chunkText, options.repeatedHeaderFooterTexts)
      ) {
        boost *= 0.5;
      }
    }

    // Heuristic header/footer detection for short, boilerplate-like chunks
    const trimmed = chunkText.trim();
    if (trimmed.length > 0 && trimmed.length < 80) {
      const lowerText = trimmed.toLowerCase();
      const isLikelyBoilerplate =
        /^page\s+\d+(\s+of\s+\d+)?$/i.test(trimmed) ||
        /^\d+$/.test(trimmed) ||
        /^-\s*\d+\s*-$/.test(trimmed) ||
        lowerText.includes('confidential') ||
        lowerText.includes('all rights reserved') ||
        /^copyright\s/i.test(trimmed) ||
        /^\u00a9\s/.test(trimmed);
      if (isLikelyBoilerplate) {
        boost *= 0.5;
      }
    }

    // Clamp aggregate multiplier to [0.5, 2.0] to prevent compounding penalties (M-9)
    // from overwhelming relevance scores and to cap the max boost ratio at 4x (M-11).
    const clampedBoost = Math.max(0.5, Math.min(2.0, boost));

    // Apply clamped boost to whichever score field exists
    if (r.bm25_score != null) r.bm25_score = (r.bm25_score as number) * clampedBoost;
    if (r.similarity_score != null)
      r.similarity_score = (r.similarity_score as number) * clampedBoost;
    if (r.rrf_score != null) r.rrf_score = (r.rrf_score as number) * clampedBoost;
  }
}

/**
 * Apply document length normalization to gently penalize results from very long documents.
 * Uses sqrt(median/docChunks) clamped to [0.7, 1.0] so short documents are unaffected
 * and very long documents get a modest penalty.
 *
 * Mutates score fields (bm25_score, similarity_score, rrf_score) in place.
 * Skips normalization when all results come from a single document.
 */
function applyLengthNormalization(
  results: Array<Record<string, unknown>>,
  db: DatabaseService
): void {
  const docIds = [...new Set(results.map((r) => r.document_id as string).filter(Boolean))];
  if (docIds.length <= 1) return; // No normalization needed for single-document results

  const placeholders = docIds.map(() => '?').join(',');
  const rows = db
    .getConnection()
    .prepare(
      `SELECT document_id, COUNT(*) as chunk_count FROM chunks WHERE document_id IN (${placeholders}) GROUP BY document_id`
    )
    .all(...docIds) as Array<{ document_id: string; chunk_count: number }>;

  const chunkCounts = new Map(rows.map((r) => [r.document_id, r.chunk_count]));
  const counts = [...chunkCounts.values()].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] || 1;

  for (const r of results) {
    const docChunks = chunkCounts.get(r.document_id as string) ?? median;
    const factor = Math.sqrt(median / Math.max(docChunks, 1));
    const clampedFactor = Math.max(0.7, Math.min(1.0, factor));

    if (r.bm25_score != null) r.bm25_score = (r.bm25_score as number) * clampedFactor;
    if (r.similarity_score != null)
      r.similarity_score = (r.similarity_score as number) * clampedFactor;
    if (r.rrf_score != null) r.rrf_score = (r.rrf_score as number) * clampedFactor;
  }
}

/**
 * Remove duplicate chunks from search results by content_hash (Task 7.3).
 * Keeps only the first occurrence of each hash value. Results without a hash
 * are always kept. Returns a new array (does not mutate the input).
 */
function deduplicateByContentHash(
  results: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return results.filter((r) => {
    const hash = (r.content_hash as string) ?? null;
    if (!hash) return true;
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
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
    doc_title?: string | null;
    doc_author?: string | null;
    doc_subject?: string | null;
    overlap_previous?: number;
    overlap_next?: number;
    chunking_strategy?: string | null;
    embedding_status?: string;
    doc_page_count?: number | null;
    datalab_mode?: string | null;
    total_chunks?: number;
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
    doc_title: r.doc_title ?? null,
    doc_author: r.doc_author ?? null,
    doc_subject: r.doc_subject ?? null,
    overlap_previous: r.overlap_previous ?? 0,
    overlap_next: r.overlap_next ?? 0,
    chunking_strategy: r.chunking_strategy ?? null,
    embedding_status: r.embedding_status ?? 'pending',
    doc_page_count: r.doc_page_count ?? null,
    datalab_mode: r.datalab_mode ?? null,
    total_chunks: r.total_chunks ?? 0,
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
    total_chunks?: number;
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
    doc_title?: string | null;
    doc_author?: string | null;
    doc_subject?: string | null;
    overlap_previous?: number;
    overlap_next?: number;
    chunking_strategy?: string | null;
    embedding_status?: string;
    doc_page_count?: number | null;
    datalab_mode?: string | null;
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
    total_chunks: r.total_chunks ?? 0,
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
    doc_title: r.doc_title ?? null,
    doc_author: r.doc_author ?? null,
    doc_subject: r.doc_subject ?? null,
    overlap_previous: r.overlap_previous ?? 0,
    overlap_next: r.overlap_next ?? 0,
    chunking_strategy: r.chunking_strategy ?? null,
    embedding_status: r.embedding_status ?? 'pending',
    doc_page_count: r.doc_page_count ?? null,
    datalab_mode: r.datalab_mode ?? null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Internal: Semantic vector search logic (called by unified handler)
 */
async function handleSearchSemanticInternal(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    return await withDatabaseOperation(async ({ db, vector }) => {
      // Params already validated and enriched by handleSearchUnified
      const input = params as unknown as InternalSearchParams;
      const conn = db.getConnection();

      // Semantic mode: skip query expansion entirely.
      // expand_query produces FTS5 OR-joined terms which have zero effect on vector search.
      // The embedding is always generated from the original query.

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
        is_atomic_filter: input.is_atomic_filter,
        heading_level_filter: input.heading_level_filter,
        min_page_count: input.min_page_count,
        max_page_count: input.max_page_count,
        table_columns_contain: input.table_columns_contain,
      });

      // Generate query embedding from original query
      const embedder = getEmbeddingService();
      let embeddingQuery = input.query;
      if (input.section_path_filter) {
        embeddingQuery = `[Section: ${input.section_path_filter}] ${embeddingQuery}`;
      }
      const queryVector = await embedder.embedSearchQuery(embeddingQuery);

      const limit = input.limit ?? 10;
      const searchLimit = input.rerank ? Math.max(limit * 2, 20) : limit;
      const requestedThreshold = input.similarity_threshold ?? 0.7;

      // Task 3.5: Adaptive similarity threshold
      // When user does NOT explicitly provide a threshold, use adaptive mode:
      // fetch extra candidates with low floor, then compute threshold from distribution
      const userExplicitlySetThreshold = params.similarity_threshold !== undefined;
      const useAdaptiveThreshold = !userExplicitlySetThreshold;

      const searchThreshold = useAdaptiveThreshold ? 0.1 : requestedThreshold;
      const adaptiveFetchLimit = useAdaptiveThreshold ? Math.max(searchLimit * 3, 30) : searchLimit;

      // Search for similar vectors
      const results = vector.searchSimilar(queryVector, {
        limit: adaptiveFetchLimit,
        threshold: searchThreshold,
        documentFilter,
        chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
        pageRangeFilter: input.page_range_filter,
      });

      // Task 3.5: Compute adaptive threshold from result distribution
      let effectiveThreshold = requestedThreshold;
      let thresholdInfo: Record<string, unknown> | undefined;
      if (useAdaptiveThreshold && results.length > 1) {
        const scores = results.map((r) => r.similarity_score);
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
        const stddev = Math.sqrt(variance);
        const adaptiveRaw = mean - stddev;
        effectiveThreshold = Math.max(0.15, Math.min(0.5, adaptiveRaw));
        thresholdInfo = {
          mode: 'adaptive',
          requested: requestedThreshold,
          effective: Math.round(effectiveThreshold * 1000) / 1000,
          adaptive_raw: Math.round(adaptiveRaw * 1000) / 1000,
          distribution: {
            mean: Math.round(mean * 1000) / 1000,
            stddev: Math.round(stddev * 1000) / 1000,
            candidates_evaluated: results.length,
          },
        };
      } else if (useAdaptiveThreshold) {
        // Too few results for stats, fall back to default
        effectiveThreshold = requestedThreshold;
        thresholdInfo = {
          mode: 'adaptive_fallback',
          requested: requestedThreshold,
          effective: requestedThreshold,
          reason: 'too_few_results_for_adaptive',
        };
      } else {
        thresholdInfo = {
          mode: 'explicit',
          requested: requestedThreshold,
          effective: requestedThreshold,
        };
      }

      // Filter results by effective threshold and apply final limit
      const thresholdFiltered = results
        .filter((r) => r.similarity_score >= effectiveThreshold)
        .slice(0, searchLimit);

      let finalResults: Array<Record<string, unknown>>;
      let rerankInfo: Record<string, unknown> | undefined;

      if (input.rerank && thresholdFiltered.length > 0) {
        const rerankInput = thresholdFiltered.map((r) => ({
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
          const original = thresholdFiltered[r.original_index];
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
            ocr_quality_score: original.ocr_quality_score ?? null,
            doc_title: original.doc_title ?? null,
            doc_author: original.doc_author ?? null,
            doc_subject: original.doc_subject ?? null,
            overlap_previous: original.overlap_previous ?? 0,
            overlap_next: original.overlap_next ?? 0,
            chunking_strategy: original.chunking_strategy ?? null,
            embedding_status: original.embedding_status ?? 'pending',
            doc_page_count: original.doc_page_count ?? null,
            datalab_mode: original.datalab_mode ?? null,
            rerank_score: r.relevance_score,
            rerank_reasoning: r.reasoning,
          };
          attachProvenance(result, db, original.provenance_id, !!input.include_provenance);
          return result;
        });
        rerankInfo = {
          reranked: true,
          candidates_evaluated: Math.min(thresholdFiltered.length, 20),
          results_returned: finalResults.length,
        };
      } else {
        finalResults = thresholdFiltered.map((r) => {
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
            ocr_quality_score: r.ocr_quality_score ?? null,
            doc_title: r.doc_title ?? null,
            doc_author: r.doc_author ?? null,
            doc_subject: r.doc_subject ?? null,
            overlap_previous: r.overlap_previous ?? 0,
            overlap_next: r.overlap_next ?? 0,
            chunking_strategy: r.chunking_strategy ?? null,
            embedding_status: r.embedding_status ?? 'pending',
            doc_page_count: r.doc_page_count ?? null,
            datalab_mode: r.datalab_mode ?? null,
          };
          attachProvenance(result, db, r.provenance_id, !!input.include_provenance);
          return result;
        });
      }

      // Apply metadata-based score boosts and length normalization
      applyMetadataBoosts(finalResults, { contentTypeQuery: input.query });
      applyLengthNormalization(finalResults, db);

      // Re-sort by similarity_score after boosts
      finalResults.sort((a, b) => (b.similarity_score as number) - (a.similarity_score as number));

      // Enrich VLM results with image metadata
      enrichVLMResultsWithImageMetadata(conn, finalResults);

      // Task 7.3: Deduplicate by content_hash if requested
      if (input.exclude_duplicate_chunks) {
        finalResults = deduplicateByContentHash(finalResults);
      }

      // T2.8: Exclude system:repeated_header_footer tagged chunks by default
      if (!input.include_headers_footers) {
        finalResults = excludeRepeatedHeaderFooterChunks(conn, finalResults);
      }

      // Task 3.1: Cluster context included by default (unless explicitly false)
      const clusterContextIncluded = input.include_cluster_context && finalResults.length > 0;
      if (clusterContextIncluded) {
        attachClusterContext(conn, finalResults);
      }

      // Phase 4: Attach neighbor context chunks if requested
      const contextChunkCount = input.include_context_chunks ?? 0;
      if (contextChunkCount > 0) {
        attachContextChunks(conn, finalResults, contextChunkCount);
      }

      // Phase 5: Attach table metadata for atomic table chunks
      attachTableMetadata(conn, finalResults);

      // T2.12: Attach cross-document context if requested
      if (input.include_document_context) {
        attachCrossDocumentContext(conn, finalResults);
      }

      const responseData: Record<string, unknown> = {
        query: input.query,
        results: finalResults,
        total: finalResults.length,
        threshold: effectiveThreshold,
        threshold_info: thresholdInfo,
        metadata_boosts_applied: true,
        cluster_context_included: clusterContextIncluded,
        next_steps:
          finalResults.length === 0
            ? [
                {
                  tool: 'ocr_search',
                  description: 'Try different keywords, mode, or broader query',
                },
                {
                  tool: 'ocr_ingest_files',
                  description: 'Add more documents to expand searchable content',
                },
              ]
            : finalResults.length === 1
              ? [
                  {
                    tool: 'ocr_chunk_context',
                    description: 'Expand a result with neighboring chunks for more context',
                  },
                  {
                    tool: 'ocr_document_get',
                    description: 'Deep-dive into a specific source document',
                  },
                  { tool: 'ocr_document_find_similar', description: 'Find related documents' },
                ]
              : [
                  {
                    tool: 'ocr_chunk_context',
                    description: 'Expand a result with neighboring chunks for more context',
                  },
                  {
                    tool: 'ocr_document_get',
                    description: 'Deep-dive into a specific source document',
                  },
                  {
                    tool: 'ocr_document_page',
                    description: 'Read the full page a result came from',
                  },
                ],
      };

      // No query_expansion in semantic mode — expansion only applies to BM25/hybrid.

      if (rerankInfo) {
        responseData.rerank = rerankInfo;
      }

      // V7: Apply compact mode and provenance summaries before grouping
      applyV7Transforms(responseData, input, db, 'semantic');

      if (input.group_by_document) {
        const { grouped, total_documents } = groupResultsByDocument(
          responseData.results as Array<Record<string, unknown>>
        );
        const groupedResponse: Record<string, unknown> = {
          ...responseData,
          total_results: finalResults.length,
          total_documents,
          documents: grouped,
        };
        delete groupedResponse.results;
        delete groupedResponse.total;
        return formatResponse(successResult(groupedResponse));
      }

      return formatResponse(successResult(responseData));
    }); // end withDatabaseOperation
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Internal: BM25 full-text keyword search logic (called by unified handler)
 */
async function handleSearchKeywordInternal(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    return await withDatabaseOperation(async ({ db }) => {
      // Params already validated and enriched by handleSearchUnified
      const input = params as unknown as InternalSearchParams;
      const conn = db.getConnection();

      // Expand query with domain-specific synonyms + corpus cluster terms if requested
      const tableQueryDetected = isTableQuery(input.query);
      let searchQuery = input.query;
      let queryExpansion: QueryExpansionInfo | undefined;
      if (input.expand_query) {
        searchQuery = expandQuery(input.query, db, tableQueryDetected);
        queryExpansion = getExpandedTerms(input.query, db, tableQueryDetected);
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
        is_atomic_filter: input.is_atomic_filter,
        heading_level_filter: input.heading_level_filter,
        min_page_count: input.min_page_count,
        max_page_count: input.max_page_count,
        table_columns_contain: input.table_columns_contain,
      });

      const bm25 = new BM25SearchService(conn);
      const limit = input.limit ?? 10;

      // Over-fetch from both sources (limit * 2) since we merge and truncate
      const fetchLimit = input.rerank ? Math.max(limit * 2, 20) : limit * 2;

      // Search chunks FTS
      // When expand_query produced an OR-joined FTS5 expression, pass preSanitized
      // to prevent sanitizeFTS5Query from inserting implicit AND (H-2 fix).
      const preSanitized = !!input.expand_query;
      const chunkResults = bm25.search({
        query: searchQuery,
        limit: fetchLimit,
        phraseSearch: input.phrase_search,
        documentFilter,
        includeHighlight: input.include_highlight,
        chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
        preSanitized,
      });

      // Search VLM FTS (skip if chunk-level filters exclude VLM content)
      const vlmResults = shouldSkipVlmSearch(input)
        ? []
        : bm25.searchVLM({
            query: searchQuery,
            limit: fetchLimit,
            phraseSearch: input.phrase_search,
            documentFilter,
            includeHighlight: input.include_highlight,
            pageRangeFilter: input.page_range_filter,
            preSanitized,
          });

      // Search extractions FTS
      const extractionResults = bm25.searchExtractions({
        query: searchQuery,
        limit: fetchLimit,
        phraseSearch: input.phrase_search,
        documentFilter,
        includeHighlight: input.include_highlight,
        preSanitized,
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
          attachProvenance(
            base,
            db,
            original.provenance_id,
            !!input.include_provenance,
            'provenance_chain'
          );
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
          attachProvenance(
            base,
            db,
            r.provenance_id,
            !!input.include_provenance,
            'provenance_chain'
          );
          return base;
        });
      }

      // Apply metadata-based score boosts and length normalization
      applyMetadataBoosts(finalResults, { contentTypeQuery: input.query });
      applyLengthNormalization(finalResults, db);

      // Re-sort by bm25_score after boosts
      finalResults.sort((a, b) => (b.bm25_score as number) - (a.bm25_score as number));

      // Enrich VLM results with image metadata
      enrichVLMResultsWithImageMetadata(conn, finalResults);

      // Task 7.3: Deduplicate by content_hash if requested
      if (input.exclude_duplicate_chunks) {
        finalResults = deduplicateByContentHash(finalResults);
      }

      // T2.8: Exclude system:repeated_header_footer tagged chunks by default
      if (!input.include_headers_footers) {
        finalResults = excludeRepeatedHeaderFooterChunks(conn, finalResults);
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

      // Task 3.1: Cluster context included by default (unless explicitly false)
      const clusterContextIncluded = input.include_cluster_context && finalResults.length > 0;
      if (clusterContextIncluded) {
        attachClusterContext(conn, finalResults);
      }

      // Phase 4: Attach neighbor context chunks if requested
      const contextChunkCount = input.include_context_chunks ?? 0;
      if (contextChunkCount > 0) {
        attachContextChunks(conn, finalResults, contextChunkCount);
      }

      // Phase 5: Attach table metadata for atomic table chunks
      attachTableMetadata(conn, finalResults);

      // T2.12: Attach cross-document context if requested
      if (input.include_document_context) {
        attachCrossDocumentContext(conn, finalResults);
      }

      // Document metadata matches (v30 FTS5 on doc_title/author/subject)
      let documentMetadataMatches: Array<Record<string, unknown>> | undefined;
      const metadataResults = bm25.searchDocumentMetadata({
        query: input.query,
        limit: 5,
        phraseSearch: input.phrase_search,
      });
      if (metadataResults.length > 0) {
        documentMetadataMatches = metadataResults;
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
        metadata_boosts_applied: true,
        cluster_context_included: clusterContextIncluded,
        next_steps:
          finalResults.length === 0
            ? [
                {
                  tool: 'ocr_search',
                  description: 'Try different keywords, mode, or broader query',
                },
                {
                  tool: 'ocr_ingest_files',
                  description: 'Add more documents to expand searchable content',
                },
              ]
            : finalResults.length === 1
              ? [
                  {
                    tool: 'ocr_chunk_context',
                    description: 'Expand a result with neighboring chunks for more context',
                  },
                  {
                    tool: 'ocr_document_get',
                    description: 'Deep-dive into a specific source document',
                  },
                  { tool: 'ocr_document_find_similar', description: 'Find related documents' },
                ]
              : [
                  {
                    tool: 'ocr_chunk_context',
                    description: 'Expand a result with neighboring chunks for more context',
                  },
                  {
                    tool: 'ocr_document_get',
                    description: 'Deep-dive into a specific source document',
                  },
                  {
                    tool: 'ocr_document_page',
                    description: 'Read the full page a result came from',
                  },
                ],
      };

      if (documentMetadataMatches) {
        responseData.document_metadata_matches = documentMetadataMatches;
      }

      // Task 3.2: Standardized query expansion details
      if (queryExpansion) {
        responseData.query_expansion = {
          original_query: queryExpansion.original,
          expanded_query: searchQuery,
          synonyms_found: queryExpansion.synonyms_found,
          terms_added: queryExpansion.expanded.length,
          corpus_terms: queryExpansion.corpus_terms,
        };
      }

      if (rerankInfo) {
        responseData.rerank = rerankInfo;
      }

      // V7: Apply compact mode and provenance summaries before grouping
      applyV7Transforms(responseData, input, db, 'keyword');

      if (input.group_by_document) {
        const { grouped, total_documents } = groupResultsByDocument(
          responseData.results as Array<Record<string, unknown>>
        );
        const groupedResponse: Record<string, unknown> = {
          ...responseData,
          total_results: finalResults.length,
          total_documents,
          documents: grouped,
        };
        delete groupedResponse.results;
        delete groupedResponse.total;
        return formatResponse(successResult(groupedResponse));
      }

      return formatResponse(successResult(responseData));
    }); // end withDatabaseOperation
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Internal: Hybrid search using Reciprocal Rank Fusion (called by unified handler)
 */
async function handleSearchHybridInternal(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    return await withDatabaseOperation(async ({ db, vector }) => {
      // Params already validated and enriched by handleSearchUnified
      const input = params as unknown as InternalSearchParams;
      const limit = (input.limit as number) ?? 10;
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

      // Expand query with domain-specific synonyms + corpus cluster terms if requested
      const tableQueryDetected = isTableQuery(input.query);
      let searchQuery = input.query;
      let queryExpansion: QueryExpansionInfo | undefined;
      if (input.expand_query) {
        searchQuery = expandQuery(input.query, db, tableQueryDetected);
        queryExpansion = getExpandedTerms(input.query, db, tableQueryDetected);
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
        is_atomic_filter: input.is_atomic_filter,
        heading_level_filter: input.heading_level_filter,
        min_page_count: input.min_page_count,
        max_page_count: input.max_page_count,
        table_columns_contain: input.table_columns_contain,
      });

      // Get BM25 results (chunks + VLM + extractions)
      const bm25 = new BM25SearchService(db.getConnection());
      // When expand_query produced an OR-joined FTS5 expression, pass preSanitized
      // to prevent sanitizeFTS5Query from inserting implicit AND (H-2 fix).
      const preSanitized = !!input.expand_query;
      // includeHighlight: false -- hybrid discards BM25 highlights (RRF doesn't surface snippets)
      const bm25ChunkResults = bm25.search({
        query: searchQuery,
        limit: limit * 2,
        documentFilter,
        includeHighlight: false,
        chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
        preSanitized,
      });
      // Search VLM FTS (skip if chunk-level filters exclude VLM content)
      const bm25VlmResults = shouldSkipVlmSearch(input)
        ? []
        : bm25.searchVLM({
            query: searchQuery,
            limit: limit * 2,
            documentFilter,
            includeHighlight: false,
            pageRangeFilter: input.page_range_filter,
            preSanitized,
          });
      const bm25ExtractionResults = bm25.searchExtractions({
        query: searchQuery,
        limit: limit * 2,
        documentFilter,
        includeHighlight: false,
        preSanitized,
      });

      // Merge BM25 results by score
      const allBm25 = [...bm25ChunkResults, ...bm25VlmResults, ...bm25ExtractionResults]
        .sort((a, b) => b.bm25_score - a.bm25_score)
        .slice(0, limit * 2)
        .map((r, i) => ({ ...r, rank: i + 1 }));

      // Get semantic results using ORIGINAL query (not FTS5-expanded)
      // The expanded query contains OR operators that contaminate embedding vectors
      const embedder = getEmbeddingService();
      let hybridEmbeddingQuery = input.query;
      if (input.section_path_filter) {
        hybridEmbeddingQuery = `[Section: ${input.section_path_filter}] ${hybridEmbeddingQuery}`;
      }
      const queryVector = await embedder.embedSearchQuery(hybridEmbeddingQuery);
      const semanticResults = vector.searchSimilar(queryVector, {
        limit: limit * 2,
        // Lower threshold than standalone (0.7) -- RRF de-ranks low-quality results
        threshold: 0.3,
        documentFilter,
        chunkFilter: chunkFilter.conditions.length > 0 ? chunkFilter : undefined,
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
      const rawResults = fusion.fuse(bm25Ranked, semanticRanked, fusionLimit);

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
          attachProvenance(
            base,
            db,
            original.provenance_id,
            !!input.include_provenance,
            'provenance_chain'
          );
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
          attachProvenance(
            base,
            db,
            r.provenance_id,
            !!input.include_provenance,
            'provenance_chain'
          );
          return base;
        });
      }

      // Chunk proximity boost - reward clusters of nearby relevant chunks
      const chunkProximityInfo =
        finalResults.length > 0 ? applyChunkProximityBoost(finalResults) : undefined;

      // Apply metadata-based score boosts and length normalization
      applyMetadataBoosts(finalResults, { contentTypeQuery: input.query });
      applyLengthNormalization(finalResults, db);

      // Enrich VLM results with image metadata
      enrichVLMResultsWithImageMetadata(conn, finalResults);

      // Re-sort by rrf_score after proximity boost and metadata boosts may have changed scores
      finalResults.sort((a, b) => (b.rrf_score as number) - (a.rrf_score as number));

      // Task 7.3: Deduplicate by content_hash if requested
      if (input.exclude_duplicate_chunks) {
        finalResults = deduplicateByContentHash(finalResults);
      }

      // T2.8: Exclude system:repeated_header_footer tagged chunks by default
      if (!input.include_headers_footers) {
        finalResults = excludeRepeatedHeaderFooterChunks(conn, finalResults);
      }

      // Task 3.1: Cluster context included by default (unless explicitly false)
      const clusterContextIncluded = input.include_cluster_context && finalResults.length > 0;
      if (clusterContextIncluded) {
        attachClusterContext(conn, finalResults);
      }

      // Phase 4: Attach neighbor context chunks if requested
      const contextChunkCount = input.include_context_chunks ?? 0;
      if (contextChunkCount > 0) {
        attachContextChunks(conn, finalResults, contextChunkCount);
      }

      // Phase 5: Attach table metadata for atomic table chunks
      attachTableMetadata(db.getConnection(), finalResults);

      // T2.12: Attach cross-document context if requested
      if (input.include_document_context) {
        attachCrossDocumentContext(conn, finalResults);
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
        metadata_boosts_applied: true,
        cluster_context_included: clusterContextIncluded,
        next_steps:
          finalResults.length === 0
            ? [
                {
                  tool: 'ocr_search',
                  description: 'Try different keywords, mode, or broader query',
                },
                {
                  tool: 'ocr_ingest_files',
                  description: 'Add more documents to expand searchable content',
                },
              ]
            : finalResults.length === 1
              ? [
                  {
                    tool: 'ocr_chunk_context',
                    description: 'Expand a result with neighboring chunks for more context',
                  },
                  {
                    tool: 'ocr_document_get',
                    description: 'Deep-dive into a specific source document',
                  },
                  { tool: 'ocr_document_find_similar', description: 'Find related documents' },
                ]
              : [
                  {
                    tool: 'ocr_chunk_context',
                    description: 'Expand a result with neighboring chunks for more context',
                  },
                  {
                    tool: 'ocr_document_get',
                    description: 'Deep-dive into a specific source document',
                  },
                  {
                    tool: 'ocr_document_page',
                    description: 'Read the full page a result came from',
                  },
                ],
      };

      // Task 3.2: Standardized query expansion details
      if (queryExpansion) {
        responseData.query_expansion = {
          original_query: queryExpansion.original,
          expanded_query: searchQuery,
          synonyms_found: queryExpansion.synonyms_found,
          terms_added: queryExpansion.expanded.length,
          corpus_terms: queryExpansion.corpus_terms,
        };
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

      // V7: Apply compact mode and provenance summaries before grouping
      applyV7Transforms(responseData, input, db, 'hybrid');

      if (input.group_by_document) {
        const { grouped, total_documents } = groupResultsByDocument(
          responseData.results as Array<Record<string, unknown>>
        );
        const groupedResponse: Record<string, unknown> = {
          ...responseData,
          total_results: finalResults.length,
          total_documents,
          documents: grouped,
        };
        delete groupedResponse.results;
        delete groupedResponse.total;
        return formatResponse(successResult(groupedResponse));
      }

      return formatResponse(successResult(responseData));
    }); // end withDatabaseOperation
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED SEARCH HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_search - Unified search across keyword (BM25), semantic (vector),
 * and hybrid (BM25+semantic RRF fusion) modes.
 *
 * Always-on optimizations (hardcoded, no parameters needed):
 * - quality_boost: true (quality-weighted ranking)
 * - expand_query: true (domain synonym + corpus term expansion)
 * - exclude_duplicate_chunks: true (deduplicate by content hash)
 * - exclude headers/footers: true (filter repeated header/footer chunks)
 * - include_cluster_context: true (cluster membership in results)
 */
export async function handleSearchUnified(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchUnifiedInput, params);

    // Flatten filters from nested object into top-level params for internal handlers.
    // Internal handlers (InternalSearchParams) expect flat params, not nested filters.
    const filters = input.filters ?? {};
    // Pass similarity_threshold through ONLY if the user explicitly provided it.
    // The Zod schema uses .optional() (NOT .default()) so input.similarity_threshold
    // is undefined when omitted. The internal semantic handler uses adaptive threshold
    // when similarity_threshold is undefined.
    const userSetThreshold = input.similarity_threshold !== undefined;

    const enrichedParams: Record<string, unknown> = {
      // Spread validated top-level params
      query: input.query,
      mode: input.mode,
      limit: input.limit,
      include_provenance: input.include_provenance,
      rerank: input.rerank,
      include_context_chunks: input.include_context_chunks,
      group_by_document: input.group_by_document,
      phrase_search: input.phrase_search,
      include_highlight: input.include_highlight,
      ...(userSetThreshold ? { similarity_threshold: input.similarity_threshold } : {}),
      bm25_weight: input.bm25_weight,
      semantic_weight: input.semantic_weight,
      rrf_k: input.rrf_k,
      auto_route: input.auto_route,
      // Flatten nested filters to top-level for internal handlers
      document_filter: filters.document_filter,
      metadata_filter: filters.metadata_filter,
      min_quality_score: filters.min_quality_score,
      cluster_id: filters.cluster_id,
      content_type_filter: filters.content_type_filter,
      section_path_filter: filters.section_path_filter,
      heading_filter: filters.heading_filter,
      page_range_filter: filters.page_range_filter,
      is_atomic_filter: filters.is_atomic_filter,
      heading_level_filter: filters.heading_level_filter,
      min_page_count: filters.min_page_count,
      max_page_count: filters.max_page_count,
      table_columns_contain: filters.table_columns_contain,
      // Hardcode always-on defaults
      quality_boost: true,
      expand_query: true,
      exclude_duplicate_chunks: true,
      include_headers_footers: false,
      include_cluster_context: true,
      include_document_context: true,
      // V7 Intelligence Optimization params
      compact: input.compact,
      include_provenance_summary: input.include_provenance_summary,
    };

    // Route to internal handler based on mode
    switch (input.mode) {
      case 'keyword':
        return await handleSearchKeywordInternal(enrichedParams);
      case 'semantic':
        return await handleSearchSemanticInternal(enrichedParams);
      case 'hybrid':
      default:
        return await handleSearchHybridInternal(enrichedParams);
    }
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
    return await withDatabaseOperation(async ({ db }) => {
      const bm25 = new BM25SearchService(db.getConnection());

      if (input.action === 'rebuild') {
        const result = bm25.rebuildIndex();
        return formatResponse(
          successResult({
            operation: 'fts_rebuild',
            ...result,
            next_steps: [
              { tool: 'ocr_search', description: 'Search using the rebuilt index' },
              { tool: 'ocr_db_stats', description: 'Check database statistics' },
            ],
          })
        );
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

      (status as Record<string, unknown>).next_steps = [
        { tool: 'ocr_search', description: 'Search using the rebuilt index' },
        { tool: 'ocr_db_stats', description: 'Check database statistics' },
      ];
      return formatResponse(successResult(status));
    }); // end withDatabaseOperation
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAG CONTEXT ASSEMBLY HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Task 3.3: Deduplicate overlapping chunks in RAG context.
 * Two chunks from the same document overlap if their character ranges
 * overlap by >50%. The higher-scored chunk is kept.
 * Results must be pre-sorted by score (descending) before calling.
 */
function deduplicateOverlappingResults(
  results: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (results.length <= 1) return results;
  const deduplicated: Array<Record<string, unknown>> = [];
  for (const result of results) {
    const docId = result.document_id as string;
    const charStart = (result.character_start ?? result.char_start) as number | undefined;
    const charEnd = (result.character_end ?? result.char_end) as number | undefined;
    if (charStart == null || charEnd == null) {
      deduplicated.push(result);
      continue;
    }

    let isDuplicate = false;
    for (const prev of deduplicated) {
      if (prev.document_id !== docId) continue;
      const prevStart = (prev.character_start ?? prev.char_start) as number | undefined;
      const prevEnd = (prev.character_end ?? prev.char_end) as number | undefined;
      if (prevStart == null || prevEnd == null) continue;
      const overlapStart = Math.max(charStart, prevStart);
      const overlapEnd = Math.min(charEnd, prevEnd);
      if (overlapEnd > overlapStart) {
        const overlapLen = overlapEnd - overlapStart;
        const thisLen = charEnd - charStart;
        if (thisLen > 0 && overlapLen / thisLen > 0.5) {
          isDuplicate = true;
          break;
        }
      }
    }
    if (!isDuplicate) deduplicated.push(result);
  }
  return deduplicated;
}

/**
 * Task 3.4: Enforce source diversity in RAG context.
 * Limits the maximum number of chunks per document to prevent
 * a single long document from dominating context.
 */
function enforceSourceDiversity(
  results: Array<Record<string, unknown>>,
  maxPerDocument: number = 3
): Array<Record<string, unknown>> {
  const docCounts = new Map<string, number>();
  const diversified: Array<Record<string, unknown>> = [];
  for (const result of results) {
    const docId = result.document_id as string;
    const count = docCounts.get(docId) ?? 0;
    if (count < maxPerDocument) {
      diversified.push(result);
      docCounts.set(docId, count + 1);
    }
  }
  return diversified;
}

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
  max_results_per_document: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .describe('Maximum chunks per document for source diversity (default: 3)'),
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
    return await withDatabaseOperation(async ({ db, vector }) => {
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
      // Over-fetch to allow room for dedup + diversity filtering
      const bm25Ranked = toBm25Ranked(allBm25);
      const semanticRanked = toSemanticRanked(semanticResults);

      const fusion = new RRFFusion({ k: 60, bm25Weight: 1.0, semanticWeight: 1.0 });
      const fusedResults = fusion.fuse(bm25Ranked, semanticRanked, limit * 3);

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
            deduplication: { before: 0, after: 0, removed: 0 },
            source_diversity: {
              max_per_document: input.max_results_per_document ?? 3,
              before: 0,
              after: 0,
            },
            next_steps: [{ tool: 'ocr_search', description: 'Try a broader search query' }],
          })
        );
      }

      // ── Step 1b: Deduplicate overlapping chunks (Task 3.3) ──────────────
      const preDedupResults = fusedResults as unknown as Array<Record<string, unknown>>;
      const deduplicated = deduplicateOverlappingResults(preDedupResults);
      const dedupStats = {
        before: preDedupResults.length,
        after: deduplicated.length,
        removed: preDedupResults.length - deduplicated.length,
      };

      // ── Step 1c: Enforce source diversity (Task 3.4) ────────────────────
      const maxPerDoc = input.max_results_per_document ?? 3;
      const diversified = enforceSourceDiversity(deduplicated, maxPerDoc);
      const diversityStats = {
        max_per_document: maxPerDoc,
        before: deduplicated.length,
        after: diversified.length,
      };

      // Apply final limit after dedup + diversity
      const finalFused = diversified.slice(0, limit);

      // Enrich VLM results with image metadata
      enrichVLMResultsWithImageMetadata(conn, finalFused);

      // ── Step 2: Assemble markdown context ──────────────────────────────────
      const contextParts: string[] = [];

      // Document excerpts
      contextParts.push('## Relevant Document Excerpts\n');
      const sources: Array<{
        file_name: string;
        page_number: number | null;
        document_id: string;
      }> = [];

      for (let i = 0; i < finalFused.length; i++) {
        const r = finalFused[i];
        const score = Math.round((r.rrf_score as number) * 1000) / 1000;
        const fileName =
          (r.source_file_name as string) ||
          path.basename((r.source_file_path as string) || 'unknown');
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
        if (r.image_extracted_path) {
          const blockType = r.image_block_type || 'Image';
          const imgPage = r.image_page_number ?? r.page_number ?? 'unknown';
          contextParts.push(`> **[Image: ${blockType} on page ${imgPage}]**`);
          contextParts.push(`> File: ${r.image_extracted_path}`);
          contextParts.push(
            `> Description: ${(r.original_text as string).replace(/\n/g, '\n> ')}\n`
          );
        } else {
          contextParts.push(`> ${(r.original_text as string).replace(/\n/g, '\n> ')}\n`);
        }

        sources.push({
          file_name: fileName,
          page_number: r.page_number as number | null,
          document_id: r.document_id as string,
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
        search_results_used: finalFused.length,
        sources,
        deduplication: dedupStats,
        source_diversity: diversityStats,
      };
      ragResponse.next_steps = [
        { tool: 'ocr_search', description: 'Run a more detailed search with filters' },
        { tool: 'ocr_document_get', description: 'Get full details for a source document' },
        { tool: 'ocr_chunk_context', description: 'Expand a specific chunk with surrounding text' },
      ];
      return formatResponse(successResult(ragResponse));
    }); // end withDatabaseOperation
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

    // FIX-6: If every database had an error, return an error instead of success with 0 results
    const allFailed = dbResults.length > 0 && dbResults.every((r) => 'error' in r && r.error);
    if (allFailed) {
      const errors = dbResults.map((r) => `${r.database_name}: ${r.error}`).join('; ');
      return handleError(new Error(`All databases failed: ${errors}`));
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
        next_steps: [
          { tool: 'ocr_search', description: 'Search in the current database' },
          { tool: 'ocr_db_select', description: 'Switch to a different database' },
        ],
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

    // Run the appropriate search, routing through unified handler with appropriate mode
    const searchParams: Record<string, unknown> = {
      query: input.query,
      limit: input.limit,
      include_provenance: false,
      mode: input.search_type === 'bm25' ? 'keyword' : input.search_type,
    };
    const searchResult = await handleSearchUnified(searchParams);

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
          csvQuote(
            r.page_number !== null && r.page_number !== undefined ? String(r.page_number) : ''
          ),
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
        next_steps: [
          { tool: 'ocr_search', description: 'Run another search with different parameters' },
          { tool: 'ocr_document_get', description: 'Get details for a document from the results' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVED SEARCH HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

const SearchSavedInput = z.object({
  action: z
    .enum(['list', 'get', 'execute', 'save'])
    .describe(
      'Action: list saved searches, get by ID, execute a saved search, or save a new search'
    ),
  saved_search_id: z
    .string()
    .min(1)
    .optional()
    .describe('ID of the saved search (required for get and execute actions)'),
  search_type: z
    .enum(['bm25', 'semantic', 'hybrid'])
    .optional()
    .describe('Filter by search type (list) or search method (save)'),
  limit: z.number().int().min(1).max(100).default(50).describe('Max results for list action'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset for list action'),
  override_limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Override the original result limit (execute action only)'),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Name for saved search (required for save action)'),
  query: z.string().min(1).max(1000).optional().describe('Search query (required for save action)'),
  search_params: z.record(z.unknown()).optional().describe('Search parameters JSON (save action)'),
  result_count: z.number().int().min(0).optional().describe('Number of results (save action)'),
  result_ids: z.array(z.string()).optional().describe('Result IDs array (save action)'),
  notes: z.string().optional().describe('Notes about this search (save action)'),
});

/**
 * Handle ocr_search_saved - Unified saved search management (MERGE-B: includes save action)
 *
 * Actions:
 * - save: Save search results for later retrieval
 * - list: List saved searches with optional type filtering
 * - get: Retrieve a saved search by ID including all parameters and result IDs
 * - execute: Re-execute a saved search with current data via handleSearchUnified
 */
async function handleSearchSaved(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSavedInput, params);
    return await withDatabaseOperation(async ({ db }) => {
      const conn = db.getConnection();

      if (input.action === 'save') {
        // Validate required fields for save
        if (!input.name)
          throw new MCPError('VALIDATION_ERROR', 'name is required for save action');
        if (!input.query)
          throw new MCPError('VALIDATION_ERROR', 'query is required for save action');
        if (!input.search_type)
          throw new MCPError('VALIDATION_ERROR', 'search_type is required for save action');
        if (input.result_count === undefined)
          throw new MCPError('VALIDATION_ERROR', 'result_count is required for save action');

        const id = uuidv4();
        const now = new Date().toISOString();

        conn
          .prepare(
            `
          INSERT INTO saved_searches (id, name, query, search_type, search_params, result_count, result_ids, created_at, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
          )
          .run(
            id,
            input.name,
            input.query,
            input.search_type,
            JSON.stringify(input.search_params ?? {}),
            input.result_count,
            JSON.stringify(input.result_ids ?? []),
            now,
            input.notes ?? null
          );

        return formatResponse(
          successResult({
            saved_search_id: id,
            name: input.name,
            query: input.query,
            search_type: input.search_type,
            result_count: input.result_count,
            created_at: now,
            next_steps: [
              { tool: 'ocr_search_saved', description: 'List or re-execute saved searches' },
            ],
          })
        );
      }

      if (input.action === 'list') {
        let sql =
          'SELECT id, name, query, search_type, result_count, created_at, notes, last_executed_at, execution_count FROM saved_searches';
        const sqlParams: unknown[] = [];

        if (input.search_type) {
          sql += ' WHERE search_type = ?';
          sqlParams.push(input.search_type);
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        sqlParams.push(input.limit, input.offset);

        const rows = conn.prepare(sql).all(...sqlParams) as Array<{
          id: string;
          name: string;
          query: string;
          search_type: string;
          result_count: number;
          created_at: string;
          notes: string | null;
          last_executed_at: string | null;
          execution_count: number | null;
        }>;

        const totalRow = conn
          .prepare(
            input.search_type
              ? 'SELECT COUNT(*) as count FROM saved_searches WHERE search_type = ?'
              : 'SELECT COUNT(*) as count FROM saved_searches'
          )
          .get(...(input.search_type ? [input.search_type] : [])) as { count: number };

        return formatResponse(
          successResult({
            action: 'list',
            saved_searches: rows,
            total: totalRow.count,
            limit: input.limit,
            offset: input.offset,
            next_steps: [
              { tool: 'ocr_search', description: 'Run a new search' },
              { tool: 'ocr_search_saved', description: 'Save a search (action=save) for later' },
            ],
          })
        );
      }

      // Both 'get' and 'execute' require saved_search_id
      if (!input.saved_search_id) {
        throw new MCPError(
          'VALIDATION_ERROR',
          'saved_search_id is required for get and execute actions'
        );
      }

      if (input.action === 'get') {
        const row = conn
          .prepare('SELECT * FROM saved_searches WHERE id = ?')
          .get(input.saved_search_id) as
          | {
              id: string;
              name: string;
              query: string;
              search_type: string;
              search_params: string;
              result_count: number;
              result_ids: string;
              created_at: string;
              notes: string | null;
            }
          | undefined;

        if (!row) {
          throw new MCPError('VALIDATION_ERROR', `Saved search not found: ${input.saved_search_id}`);
        }

        return formatResponse(
          successResult({
            action: 'get',
            id: row.id,
            name: row.name,
            query: row.query,
            search_type: row.search_type,
            search_params: JSON.parse(row.search_params),
            result_count: row.result_count,
            result_ids: JSON.parse(row.result_ids),
            created_at: row.created_at,
            notes: row.notes,
            next_steps: [
              { tool: 'ocr_search', description: 'Run a new search' },
              { tool: 'ocr_search_saved', description: 'Save a search (action=save) for later' },
            ],
          })
        );
      }

      // action === 'execute'
      const row = conn
        .prepare('SELECT * FROM saved_searches WHERE id = ?')
        .get(input.saved_search_id) as
        | {
            id: string;
            name: string;
            query: string;
            search_type: string;
            search_params: string;
            result_count: number;
            result_ids: string;
            created_at: string;
            notes: string | null;
          }
        | undefined;

      if (!row) {
        throw new MCPError(
          'VALIDATION_ERROR',
          `Saved search not found: ${input.saved_search_id}`
        );
      }

      // Parse stored search parameters
      let searchParams: Record<string, unknown>;
      try {
        searchParams = JSON.parse(row.search_params) as Record<string, unknown>;
      } catch (parseErr) {
        throw new MCPError(
          'INTERNAL_ERROR',
          `Failed to parse saved search params: ${String(parseErr)}`
        );
      }

      // Override limit if requested
      if (input.override_limit !== undefined) {
        searchParams.limit = input.override_limit;
      }

      // Ensure query is set in params
      searchParams.query = row.query;

      // Dispatch through unified handler with appropriate mode
      const modeMap: Record<string, string> = {
        bm25: 'keyword',
        semantic: 'semantic',
        hybrid: 'hybrid',
      };
      const mode = modeMap[row.search_type];
      if (!mode) {
        throw new MCPError('VALIDATION_ERROR', `Unknown search type: ${row.search_type}`);
      }
      searchParams.mode = mode;
      const searchResult: ToolResponse = await handleSearchUnified(
        searchParams as Record<string, unknown>
      );

      // Parse the search result to wrap with saved search metadata
      const searchResultData = JSON.parse(searchResult.content[0].text) as Record<
        string,
        unknown
      >;

      // Task 6.4: Update saved search analytics (execution tracking)
      let analyticsWarning: string | undefined;
      try {
        conn
          .prepare(
            'UPDATE saved_searches SET last_executed_at = ?, execution_count = COALESCE(execution_count, 0) + 1 WHERE id = ?'
          )
          .run(new Date().toISOString(), row.id);
      } catch (analyticsErr) {
        // Non-fatal: schema pre-v30 databases may not have these columns yet
        const msg = analyticsErr instanceof Error ? analyticsErr.message : String(analyticsErr);
        console.error('[search] Failed to update saved search analytics:', msg);
        analyticsWarning = `Analytics tracking unavailable: database schema may be pre-v30. ${msg}`;
      }

      const result: Record<string, unknown> = {
        action: 'execute',
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
        next_steps: [
          { tool: 'ocr_search', description: 'Run a new search' },
          { tool: 'ocr_search_saved', description: 'Save a search (action=save) for later' },
        ],
      };
      if (analyticsWarning) {
        result.warning = analyticsWarning;
      }

      return formatResponse(successResult(result));
    }); // end withDatabaseOperation
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-DATABASE SEARCH HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

const CrossDbSearchInput = z.object({
  query: z.string().min(1).describe('Search query'),
  database_names: z
    .array(z.string())
    .optional()
    .describe('Database names to search (default: all databases)'),
  limit_per_db: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum results per database'),
});

/** Result from cross-database BM25 search with normalized score for cross-DB ranking. */
interface CrossDBSearchResult {
  database_name: string;
  document_id: string;
  file_name: string | null;
  chunk_id: string;
  chunk_index: number;
  text_preview: string;
  bm25_score: number;
  /** Min-max normalized score [0, 1] for cross-database comparability. */
  normalized_score: number;
}

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

    const allResults: CrossDBSearchResult[] = [];
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
          skippedDbs.push({
            name: dbInfo.name,
            reason: 'No FTS index (chunks_fts table not found)',
          });
          continue;
        }

        // Run BM25 search (sanitize query for FTS5 safety)
        const ftsQuery = sanitizeFTS5Query(input.query);
        const rows = conn
          .prepare(
            `SELECT c.id, c.document_id, c.text, c.chunk_index, bm25(chunks_fts) AS bm25_score
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             WHERE chunks_fts MATCH ?
             ORDER BY bm25(chunks_fts)
             LIMIT ?`
          )
          .all(ftsQuery, input.limit_per_db) as Array<{
          id: string;
          document_id: string;
          text: string;
          chunk_index: number;
          bm25_score: number;
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
            bm25_score: Math.abs(row.bm25_score),
            normalized_score: 0, // Set during per-database normalization below
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
            console.error(
              `[CrossDbSearch] Failed to close connection to ${dbInfo.name}: ${String(closeErr)}`
            );
          }
        }
      }
    }

    // Normalize BM25 scores per-database before merging.
    // BM25 scores from different databases use different corpus statistics (IDF, avgdl)
    // so raw scores are not comparable. Min-max normalize each database's scores to [0, 1].
    const byDatabase = new Map<string, typeof allResults>();
    for (const r of allResults) {
      if (!byDatabase.has(r.database_name)) byDatabase.set(r.database_name, []);
      byDatabase.get(r.database_name)!.push(r);
    }
    for (const dbResults of byDatabase.values()) {
      const scores = dbResults.map((r) => r.bm25_score);
      const minScore = safeMin(scores) ?? 0;
      const maxScore = safeMax(scores) ?? 0;
      const range = maxScore - minScore;
      for (const r of dbResults) {
        r.normalized_score = range > 0 ? (r.bm25_score - minScore) / range : 1.0;
      }
    }

    // Sort by normalized score (higher=better)
    allResults.sort((a, b) => b.normalized_score - a.normalized_score);

    return formatResponse(
      successResult({
        query: input.query,
        databases_searched: databases.length - skippedDbs.length,
        total_results: allResults.length,
        results: allResults,
        score_normalization: 'per_database_min_max',
        databases_skipped: skippedDbs.length > 0 ? skippedDbs : undefined,
        next_steps: [
          { tool: 'ocr_db_select', description: 'Switch to a specific database for deeper search' },
          {
            tool: 'ocr_search',
            description: 'Search within the current database with full features',
          },
        ],
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
    description:
      '[ESSENTIAL] Primary search. mode="keyword" (BM25), "semantic" (vector), or "hybrid" (default, best). Quality-weighted, query-expanded, deduplicated.',
    inputSchema: SearchUnifiedInput.shape,
    handler: handleSearchUnified,
  },
  ocr_fts_manage: {
    description:
      '[SETUP] FTS5 index maintenance. action="status" checks health; "rebuild" recreates index. Use when keyword search returns unexpected zero results.',
    inputSchema: {
      action: z.enum(['rebuild', 'status']).describe('Action: rebuild index or check status'),
    },
    handler: handleFTSManage,
  },
  ocr_search_export: {
    description:
      '[STATUS] Use to export search results to a CSV or JSON file on disk. Returns file path and result count.',
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
    description:
      '[SEARCH] Use when you have the same documents in separate databases and want to compare search quality. Returns per-database results for the same query.',
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
      '[ESSENTIAL] Use when answering a user question about document content. Returns pre-assembled, deduplicated markdown context from hybrid search. Best for RAG workflows.',
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
      max_results_per_document: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe('Maximum chunks per document for source diversity (default: 3)'),
    },
    handler: handleRagContext,
  },
  ocr_search_saved: {
    description:
      '[SEARCH] Manage saved searches. action="save"|"list"|"get"|"execute". Save requires name, query, search_type, result_count.',
    inputSchema: SearchSavedInput.shape,
    handler: handleSearchSaved,
  },
  ocr_search_cross_db: {
    description:
      '[SEARCH] Use to search across ALL databases at once using BM25 keyword matching. Returns merged results with database source. No need to switch databases.',
    inputSchema: CrossDbSearchInput.shape,
    handler: handleCrossDbSearch,
  },
};
