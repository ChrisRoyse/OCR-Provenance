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
import { BM25SearchService, sanitizeFTS5Query } from '../services/search/bm25.js';
import { RRFFusion, type RankedResult } from '../services/search/fusion.js';
import { rerankResults } from '../services/search/reranker.js';
import { expandQuery, getExpandedTerms } from '../services/search/query-expander.js';
import { classifyQuery } from '../services/search/query-classifier.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getImage } from '../services/storage/database/image-operations.js';
import { computeBlockConfidence, isRepeatedHeaderFooter } from '../services/chunking/json-block-analyzer.js';

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
function groupResultsByDocument(
  results: Array<Record<string, unknown>>
): { grouped: DocumentGroup[]; total_documents: number } {
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
    is_atomic_filter?: boolean;
    heading_level_filter?: { min_level?: number; max_level?: number };
    min_page_count?: number;
    max_page_count?: number;
    table_columns_contain?: string;
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
    conditions.push(`EXISTS (SELECT 1 FROM provenance p WHERE p.id = c.provenance_id AND LOWER(p.processing_params) LIKE '%' || LOWER(?) || '%')`);
    params.push(filters.table_columns_contain);
  }

  return { conditions, params };
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
  const primaryChunkIds = new Set(
    results.map(r => r.chunk_id as string).filter(Boolean)
  );

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
    const allIndices = docResults.map(r => r.chunk_index as number);
    const minIdx = Math.min(...allIndices) - contextSize;
    const maxIdx = Math.max(...allIndices) + contextSize;

    const neighbors = conn.prepare(
      `SELECT id, text, chunk_index, page_number, heading_context, section_path, content_types
       FROM chunks
       WHERE document_id = ? AND chunk_index BETWEEN ? AND ?
       ORDER BY chunk_index`
    ).all(docId, minIdx, maxIdx) as Array<{
      id: string;
      text: string;
      chunk_index: number;
      page_number: number | null;
      heading_context: string | null;
      section_path: string | null;
      content_types: string | null;
    }>;

    const neighborMap = new Map(neighbors.map(n => [n.chunk_index, n]));

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
 * Sets both top-level fields (table_columns, table_row_count, table_column_count) and
 * a nested table_metadata object for backward compatibility.
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
  const rows = conn.prepare(
    `SELECT c.id AS chunk_id, p.processing_params
     FROM chunks c
     INNER JOIN provenance p ON c.provenance_id = p.id
     WHERE c.id IN (${placeholders})`
  ).all(...tableChunkIds) as Array<{ chunk_id: string; processing_params: string }>;

  // Build map: chunk_id -> table metadata
  const metadataMap = new Map<string, { table_columns: string[]; table_row_count: number; table_column_count: number }>();
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
    } catch {
      // Skip unparseable processing_params
    }
  }

  // Attach to results: top-level fields + nested table_metadata for backward compat
  for (const r of results) {
    const meta = r.chunk_id ? metadataMap.get(r.chunk_id as string) : undefined;
    if (meta) {
      r.table_columns = meta.table_columns;
      r.table_row_count = meta.table_row_count;
      r.table_column_count = meta.table_column_count;
      r.table_metadata = meta;
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
  const taggedChunks = conn.prepare(
    `SELECT et.entity_id FROM entity_tags et
     JOIN tags t ON t.id = et.tag_id
     WHERE t.name = 'system:repeated_header_footer' AND et.entity_type = 'chunk'`
  ).all() as Array<{ entity_id: string }>;

  if (taggedChunks.length === 0) return results;

  const excludeChunkIds = new Set(taggedChunks.map(t => t.entity_id));
  return results.filter(r => {
    const chunkId = r.chunk_id as string | null;
    return !chunkId || !excludeChunkIds.has(chunkId);
  });
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
  const docIds = [...new Set(
    results.map(r => (r.document_id ?? r.source_document_id) as string).filter(Boolean)
  )];
  if (docIds.length === 0) return;

  const contextMap = new Map<string, Record<string, unknown>>();

  for (const docId of docIds) {
    try {
      // Get cluster memberships
      const clusters = conn.prepare(
        `SELECT c.id, c.label, c.classification_tag, dc.similarity_to_centroid
         FROM document_clusters dc JOIN clusters c ON c.id = dc.cluster_id
         WHERE dc.document_id = ? LIMIT 3`
      ).all(docId) as Array<Record<string, unknown>>;

      // Get comparison summaries (documents already compared to this one)
      const comparisons = conn.prepare(
        `SELECT
           CASE WHEN document_id_1 = ? THEN document_id_2 ELSE document_id_1 END as related_doc_id,
           similarity_ratio, summary
         FROM comparisons
         WHERE document_id_1 = ? OR document_id_2 = ?
         ORDER BY similarity_ratio DESC LIMIT 3`
      ).all(docId, docId, docId) as Array<Record<string, unknown>>;

      contextMap.set(docId, {
        clusters: clusters.length > 0 ? clusters : null,
        related_documents: comparisons.length > 0 ? comparisons : null,
      });
    } catch (error) {
      console.error(
        `[Search] Failed to get cross-document context for ${docId}: ${String(error)}`
      );
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
        result.image_dimensions = { width: image.dimensions.width, height: image.dimensions.height };
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
      boost *= 1 + (0.1 * (4 - clampedLevel));
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
        if (/\b(table|data|statistic|row|column|figure|chart)\b/.test(q) && contentTypes.includes('"table"')) {
          boost *= 1.2;
        }
        if (/\b(code|function|class|method|import|variable|api)\b/.test(q) && contentTypes.includes('"code"')) {
          boost *= 1.2;
        }
        if (/\b(list|items|steps|requirements|criteria)\b/.test(q) && contentTypes.includes('"list"')) {
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
          boost *= 0.8 + (0.4 * blockConf); // range: 0.8x to 1.16x
        }
      }
    } catch { /* ignore parse errors */ }

    // Task 7.1: Header/footer penalty - demote chunks matching repeated headers/footers
    // Two-tier detection:
    // 1. Explicit: caller provides known repeated texts from detectRepeatedHeadersFooters()
    // 2. Heuristic: short chunks with typical header/footer patterns get penalized
    const chunkText = (r.original_text as string) ?? '';
    if (options.repeatedHeaderFooterTexts && options.repeatedHeaderFooterTexts.length > 0) {
      if (chunkText.length > 0 && isRepeatedHeaderFooter(chunkText, options.repeatedHeaderFooterTexts)) {
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

    // Apply boost to whichever score field exists
    if (r.bm25_score != null) r.bm25_score = (r.bm25_score as number) * boost;
    if (r.similarity_score != null) r.similarity_score = (r.similarity_score as number) * boost;
    if (r.rrf_score != null) r.rrf_score = (r.rrf_score as number) * boost;
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
  const docIds = [...new Set(results.map(r => r.document_id as string).filter(Boolean))];
  if (docIds.length <= 1) return; // No normalization needed for single-document results

  const placeholders = docIds.map(() => '?').join(',');
  const rows = db.getConnection()
    .prepare(`SELECT document_id, COUNT(*) as chunk_count FROM chunks WHERE document_id IN (${placeholders}) GROUP BY document_id`)
    .all(...docIds) as Array<{ document_id: string; chunk_count: number }>;

  const chunkCounts = new Map(rows.map(r => [r.document_id, r.chunk_count]));
  const counts = [...chunkCounts.values()].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] || 1;

  for (const r of results) {
    const docChunks = chunkCounts.get(r.document_id as string) ?? median;
    const factor = Math.sqrt(median / Math.max(docChunks, 1));
    const clampedFactor = Math.max(0.7, Math.min(1.0, factor));

    if (r.bm25_score != null) r.bm25_score = (r.bm25_score as number) * clampedFactor;
    if (r.similarity_score != null) r.similarity_score = (r.similarity_score as number) * clampedFactor;
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
  return results.filter(r => {
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
 * Handle ocr_search_semantic - Semantic vector search
 */
export async function handleSearchSemantic(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSemanticInput, params);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    // Expand query with domain-specific synonyms + corpus cluster terms if requested
    let searchQuery = input.query;
    let queryExpansion: QueryExpansionInfo | undefined;
    if (input.expand_query) {
      searchQuery = expandQuery(input.query, db);
      queryExpansion = getExpandedTerms(input.query, db);
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

    // Generate query embedding (use expanded query for better semantic coverage)
    // Prepend section prefix to query when section_path_filter is set for section-aware matching
    const embedder = getEmbeddingService();
    let embeddingQuery = searchQuery;
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
      qualityBoost: input.quality_boost,
      pageRangeFilter: input.page_range_filter,
    });

    // Task 3.5: Compute adaptive threshold from result distribution
    let effectiveThreshold = requestedThreshold;
    let thresholdInfo: Record<string, unknown> | undefined;
    if (useAdaptiveThreshold && results.length > 1) {
      const scores = results.map(r => r.similarity_score);
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
      .filter(r => r.similarity_score >= effectiveThreshold)
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

    if (input.group_by_document) {
      const { grouped, total_documents } = groupResultsByDocument(finalResults);
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

    // Expand query with domain-specific synonyms + corpus cluster terms if requested
    let searchQuery = input.query;
    let queryExpansion: QueryExpansionInfo | undefined;
    if (input.expand_query) {
      searchQuery = expandQuery(input.query, db);
      queryExpansion = getExpandedTerms(input.query, db);
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
    try {
      const metadataResults = bm25.searchDocumentMetadata({
        query: input.query,
        limit: 5,
        phraseSearch: input.phrase_search,
      });
      if (metadataResults.length > 0) {
        documentMetadataMatches = metadataResults;
      }
    } catch {
      // documents_fts may not exist on older schema versions - silently skip
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

    if (input.group_by_document) {
      const { grouped, total_documents } = groupResultsByDocument(finalResults);
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

    // Expand query with domain-specific synonyms + corpus cluster terms if requested
    let searchQuery = input.query;
    let queryExpansion: QueryExpansionInfo | undefined;
    if (input.expand_query) {
      searchQuery = expandQuery(input.query, db);
      queryExpansion = getExpandedTerms(input.query, db);
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
    // Prepend section prefix to query when section_path_filter is set for section-aware matching
    const embedder = getEmbeddingService();
    let hybridEmbeddingQuery = searchQuery;
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
      next_steps: [
        { tool: 'ocr_chunk_context', description: 'Expand a result with neighboring chunks for more context' },
        { tool: 'ocr_document_get', description: 'Deep-dive into a specific source document' },
        { tool: 'ocr_document_page', description: 'Read the full page a result came from' },
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

    if (input.group_by_document) {
      const { grouped, total_documents } = groupResultsByDocument(finalResults);
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
    if (charStart == null || charEnd == null) { deduplicated.push(result); continue; }

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
        if (thisLen > 0 && overlapLen / thisLen > 0.5) { isDuplicate = true; break; }
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
          source_diversity: { max_per_document: input.max_results_per_document ?? 3, before: 0, after: 0 },
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
    const sources: Array<{ file_name: string; page_number: number | null; document_id: string }> =
      [];

    for (let i = 0; i < finalFused.length; i++) {
      const r = finalFused[i];
      const score = Math.round((r.rrf_score as number) * 1000) / 1000;
      const fileName = (r.source_file_name as string) || path.basename((r.source_file_path as string) || 'unknown');
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
        contextParts.push(`> Description: ${(r.original_text as string).replace(/\n/g, '\n> ')}\n`);
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

    let sql = 'SELECT id, name, query, search_type, result_count, created_at, notes, last_executed_at, execution_count FROM saved_searches';
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
      last_executed_at: string | null; execution_count: number | null;
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

    // Task 6.4: Update saved search analytics (execution tracking)
    try {
      conn.prepare(
        'UPDATE saved_searches SET last_executed_at = ?, execution_count = COALESCE(execution_count, 0) + 1 WHERE id = ?'
      ).run(new Date().toISOString(), row.id);
    } catch (analyticsErr) {
      // Non-fatal: schema v29 databases may not have these columns yet
      console.error(
        '[search] Failed to update saved search analytics:',
        analyticsErr instanceof Error ? analyticsErr.message : String(analyticsErr)
      );
    }

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

        // Run BM25 search (sanitize query for FTS5 safety)
        const ftsQuery = sanitizeFTS5Query(input.query);
        const rows = conn
          .prepare(
            `SELECT c.id, c.document_id, c.text, c.chunk_index, rank
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             WHERE chunks_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(ftsQuery, input.limit_per_db) as Array<{
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
            bm25_score: Math.abs(row.rank),
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

    // Sort by BM25 score (higher=better, already Math.abs'd)
    allResults.sort((a, b) => b.bm25_score - a.bm25_score);

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
    description: '[SEARCH] Use for exact keyword/phrase matching (IDs, codes, names, quoted phrases). Returns chunks ranked by term frequency. For general questions, use ocr_search_hybrid instead.',
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
        .default(true)
        .describe('Include cluster membership info for each result (default: true)'),
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
      exclude_duplicate_chunks: z
        .boolean()
        .default(false)
        .describe('Remove duplicate chunks (same text_hash) from results'),
      is_atomic_filter: z.boolean().optional()
        .describe('When true, return only atomic chunks (tables, figures, code). When false, exclude them.'),
      heading_level_filter: z
        .object({
          min_level: z.number().int().min(1).max(6).optional(),
          max_level: z.number().int().min(1).max(6).optional(),
        })
        .optional()
        .describe('Filter by heading level (1=h1, 6=h6)'),
      min_page_count: z.number().int().min(1).optional()
        .describe('Only results from documents with at least this many pages'),
      max_page_count: z.number().int().min(1).optional()
        .describe('Only results from documents with at most this many pages'),
      include_context_chunks: z.number().int().min(0).max(3).default(0)
        .describe('Number of neighboring chunks before/after each result (0=none, max 3)'),
      table_columns_contain: z.string().optional()
        .describe('Filter to table chunks whose column headers contain this text (case-insensitive match on stored table_columns in processing_params)'),
      include_headers_footers: z.boolean().default(false)
        .describe('Include repeated page headers/footers in search results (excluded by default)'),
      group_by_document: z.boolean().default(false)
        .describe('Group results by source document with document-level statistics'),
      include_document_context: z.boolean().default(false)
        .describe('Include cluster membership and related document comparisons for each source document (first result per doc)'),
    },
    handler: handleSearch,
  },
  ocr_search_semantic: {
    description: '[SEARCH] Use for conceptual/meaning-based queries where exact terms may not appear. Returns chunks ranked by vector similarity. For general questions, use ocr_search_hybrid instead.',
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
        .default(true)
        .describe('Include cluster membership info for each result (default: true)'),
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
      exclude_duplicate_chunks: z
        .boolean()
        .default(false)
        .describe('Remove duplicate chunks (same text_hash) from results'),
      is_atomic_filter: z.boolean().optional()
        .describe('When true, return only atomic chunks (tables, figures, code). When false, exclude them.'),
      heading_level_filter: z
        .object({
          min_level: z.number().int().min(1).max(6).optional(),
          max_level: z.number().int().min(1).max(6).optional(),
        })
        .optional()
        .describe('Filter by heading level (1=h1, 6=h6)'),
      min_page_count: z.number().int().min(1).optional()
        .describe('Only results from documents with at least this many pages'),
      max_page_count: z.number().int().min(1).optional()
        .describe('Only results from documents with at most this many pages'),
      include_context_chunks: z.number().int().min(0).max(3).default(0)
        .describe('Number of neighboring chunks before/after each result (0=none, max 3)'),
      table_columns_contain: z.string().optional()
        .describe('Filter to table chunks whose column headers contain this text (case-insensitive match on stored table_columns in processing_params)'),
      include_headers_footers: z.boolean().default(false)
        .describe('Include repeated page headers/footers in search results (excluded by default)'),
      group_by_document: z.boolean().default(false)
        .describe('Group results by source document with document-level statistics'),
      include_document_context: z.boolean().default(false)
        .describe('Include cluster membership and related document comparisons for each source document (first result per doc)'),
    },
    handler: handleSearchSemantic,
  },
  ocr_search_hybrid: {
    description: '[CORE] Default search tool. Use for any search query -- combines keyword and semantic matching. Returns ranked chunks with metadata. Prefer this over ocr_search or ocr_search_semantic.',
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
        .default(true)
        .describe('Expand query with domain-specific legal/medical synonyms (default: true for hybrid search)'),
      rerank: z
        .boolean()
        .default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
      cluster_id: z.string().optional().describe('Filter results to documents in this cluster'),
      include_cluster_context: z
        .boolean()
        .default(true)
        .describe('Include cluster membership info for each result (default: true)'),
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
      exclude_duplicate_chunks: z
        .boolean()
        .default(false)
        .describe('Remove duplicate chunks (same text_hash) from results'),
      is_atomic_filter: z.boolean().optional()
        .describe('When true, return only atomic chunks (tables, figures, code). When false, exclude them.'),
      heading_level_filter: z
        .object({
          min_level: z.number().int().min(1).max(6).optional(),
          max_level: z.number().int().min(1).max(6).optional(),
        })
        .optional()
        .describe('Filter by heading level (1=h1, 6=h6)'),
      min_page_count: z.number().int().min(1).optional()
        .describe('Only results from documents with at least this many pages'),
      max_page_count: z.number().int().min(1).optional()
        .describe('Only results from documents with at most this many pages'),
      include_context_chunks: z.number().int().min(0).max(3).default(0)
        .describe('Number of neighboring chunks before/after each result (0=none, max 3)'),
      table_columns_contain: z.string().optional()
        .describe('Filter to table chunks whose column headers contain this text (case-insensitive match on stored table_columns in processing_params)'),
      include_headers_footers: z.boolean().default(false)
        .describe('Include repeated page headers/footers in search results (excluded by default)'),
      group_by_document: z.boolean().default(false)
        .describe('Group results by source document with document-level statistics'),
      include_document_context: z.boolean().default(false)
        .describe('Include cluster membership and related document comparisons for each source document (first result per doc)'),
    },
    handler: handleSearchHybrid,
  },
  ocr_fts_manage: {
    description: '[ADMIN] Use to rebuild or check status of the FTS5 full-text index. Returns index health. Use after bulk ingestion if search results seem stale.',
    inputSchema: {
      action: z.enum(['rebuild', 'status']).describe('Action: rebuild index or check status'),
    },
    handler: handleFTSManage,
  },
  ocr_search_export: {
    description: '[SEARCH] Use to export search results to a CSV or JSON file on disk. Returns file path and result count.',
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
    description: '[SEARCH] Use to compare search results across multiple databases side-by-side. Returns per-database results for benchmarking. Requires 2+ database names.',
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
      '[CORE] Use when answering a user question about document content. Returns pre-assembled, deduplicated markdown context from hybrid search. Best for RAG workflows.',
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
  ocr_search_save: {
    description: '[SEARCH] Use to save search results for later retrieval or re-execution. Returns saved search ID. Retrieve with ocr_search_saved_get.',
    inputSchema: SearchSaveInput.shape,
    handler: handleSearchSave,
  },
  ocr_search_saved_list: {
    description: '[SEARCH] Use to list all saved searches with optional type filtering. Returns saved search names, types, and IDs.',
    inputSchema: SearchSavedListInput.shape,
    handler: handleSearchSavedList,
  },
  ocr_search_saved_get: {
    description: '[SEARCH] Use to retrieve a saved search by ID. Returns original parameters and result IDs. Use ocr_search_saved_execute to re-run it.',
    inputSchema: SearchSavedGetInput.shape,
    handler: handleSearchSavedGet,
  },
  ocr_search_saved_execute: {
    description: '[SEARCH] Use to re-run a previously saved search against current data. Returns fresh results using the saved parameters.',
    inputSchema: SearchSavedExecuteInput.shape,
    handler: handleSearchSavedExecute,
  },
  ocr_search_cross_db: {
    description:
      '[SEARCH] Use to search across ALL databases at once using BM25 keyword matching. Returns merged results with database source. No need to switch databases.',
    inputSchema: CrossDbSearchInput.shape,
    handler: handleCrossDbSearch,
  },
};
