/**
 * Question-Answering MCP Tools
 *
 * Tools: ocr_question_answer
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/question-answer
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolDefinition, type ToolResponse } from './shared.js';
import { validateInput, EntityFilter } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { GeminiClient } from '../services/gemini/client.js';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { BM25SearchService } from '../services/search/bm25.js';
import { RRFFusion, type RankedResult } from '../services/search/fusion.js';
import {
  getDocumentIdsForEntities,
  getEntitiesForChunks,
  getCorpusIntelligence,
  getDocumentNarrative,
} from '../services/storage/database/knowledge-graph-operations.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getCurrentDatabaseName } from '../server/state.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

const QuestionAnswerInput = z.object({
  question: z.string().min(1).max(2000).describe('The question to answer'),
  document_filter: z.array(z.string()).optional().describe('Restrict to specific documents'),
  include_sources: z.boolean().default(true).describe('Include source chunks in the response'),
  include_entity_context: z
    .boolean()
    .default(true)
    .describe('Include knowledge graph entity information'),
  include_kg_paths: z
    .boolean()
    .default(true)
    .describe('Include knowledge graph relationship paths'),
  max_context_length: z
    .number()
    .int()
    .min(500)
    .max(50000)
    .default(8000)
    .describe('Maximum context length in characters'),
  limit: z.number().int().min(1).max(20).default(5).describe('Maximum search results to include'),
  temperature: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe('Temperature for answer generation (lower = more factual)'),
  search_mode: z
    .enum(['hybrid', 'bm25', 'semantic'])
    .default('hybrid')
    .describe(
      'Search retrieval mode: hybrid (BM25+semantic RRF fusion), bm25 (keyword only), or semantic (vector only)'
    ),
  entity_filter: EntityFilter.describe('Filter results by knowledge graph entities'),
  semantic_weight: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      'Weight for semantic vs BM25 in hybrid mode (0=BM25 only, 1=semantic only, 0.5=balanced)'
    ),
  include_cluster_context: z
    .boolean()
    .default(false)
    .describe('Include cluster membership for result documents'),
  include_contradictions: z
    .boolean()
    .default(false)
    .describe('Include contradiction summaries from document comparisons'),
  prefer_recent: z
    .boolean()
    .default(false)
    .describe('Prefer more recent KG edges when building context (temporal weighting)'),
  include_corpus_context: z
    .boolean()
    .default(false)
    .describe('Include corpus-level intelligence summary in QA context'),
  include_narrative: z
    .boolean()
    .default(false)
    .describe('Include document narrative from AI synthesis in QA context'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Unified search result from any retrieval mode */
interface QASearchResult {
  chunk_id: string | null;
  document_id: string;
  original_text: string;
  page_number: number | null;
  score: number;
}

/** Entity with KG canonical name and grouped by type */
interface QAEntityInfo {
  canonical_name: string;
  raw_text: string;
  entity_type: string;
  confidence: number;
  mention_count: number;
  node_id: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve entity_filter to a narrowed document filter.
 * Returns null if the filter yields zero results (caller should return empty).
 * Returns undefined if no entity_filter is provided (pass-through).
 */
function resolveEntityFilterForQA(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entityFilter:
    | { entity_names?: string[]; entity_types?: string[]; include_related?: boolean }
    | undefined,
  existingDocFilter: string[] | undefined
): { documentFilter: string[] | undefined; empty: boolean } {
  if (!entityFilter) return { documentFilter: existingDocFilter, empty: false };

  const entityDocIds = getDocumentIdsForEntities(
    conn,
    entityFilter.entity_names,
    entityFilter.entity_types,
    entityFilter.include_related
  );

  if (entityDocIds.length === 0) return { documentFilter: undefined, empty: true };

  if (existingDocFilter && existingDocFilter.length > 0) {
    const entitySet = new Set(entityDocIds);
    const intersected = existingDocFilter.filter((id) => entitySet.has(id));
    if (intersected.length === 0) return { documentFilter: undefined, empty: true };
    return { documentFilter: intersected, empty: false };
  }

  return { documentFilter: entityDocIds, empty: false };
}

/**
 * Run BM25 search and return unified QA results.
 */
function runBM25Search(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  query: string,
  searchLimit: number,
  documentFilter: string[] | undefined
): QASearchResult[] {
  const bm25 = new BM25SearchService(conn);
  const chunkResults = bm25.search({
    query,
    limit: searchLimit,
    documentFilter,
    includeHighlight: false,
  });
  return chunkResults.map((r) => ({
    chunk_id: r.chunk_id,
    document_id: r.document_id,
    original_text: r.original_text,
    page_number: r.page_number,
    score: r.bm25_score,
  }));
}

/**
 * Run semantic search and return unified QA results.
 * Returns empty array if embedding service is not available.
 */
async function runSemanticSearch(
  query: string,
  searchLimit: number,
  documentFilter: string[] | undefined
): Promise<QASearchResult[]> {
  try {
    const { vector } = requireDatabase();
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(query);
    const results = vector.searchSimilar(queryVector, {
      limit: searchLimit,
      threshold: 0.3,
      documentFilter,
    });
    return results.map((r) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      original_text: r.original_text,
      page_number: r.page_number,
      score: r.similarity_score,
    }));
  } catch (err) {
    console.error(
      `[WARN] Semantic search failed, falling back: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Run hybrid search (BM25 + semantic with RRF fusion) and return unified QA results.
 * Falls back to BM25-only if semantic search fails.
 */
async function runHybridSearch(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  query: string,
  searchLimit: number,
  documentFilter: string[] | undefined,
  semanticWeight: number
): Promise<{ results: QASearchResult[]; mode_used: string; warnings: string[] }> {
  const warnings: string[] = [];
  // BM25 results
  let bm25Results: Array<{
    chunk_id: string | null;
    document_id: string;
    original_text: string;
    page_number: number | null;
    bm25_score: number;
    rank: number;
    image_id: string | null;
    extraction_id: string | null;
    embedding_id: string | null;
    result_type: 'chunk' | 'vlm' | 'extraction';
    source_file_path: string;
    source_file_name: string;
    source_file_hash: string;
    character_start: number;
    character_end: number;
    chunk_index: number;
    provenance_id: string;
    content_hash: string;
  }> = [];
  try {
    const bm25 = new BM25SearchService(conn);
    const chunkResults = bm25.search({
      query,
      limit: searchLimit,
      documentFilter,
      includeHighlight: false,
    });
    bm25Results = chunkResults.map((r, i) => ({ ...r, rank: i + 1 }));
  } catch (bm25Err) {
    const msg = bm25Err instanceof Error ? bm25Err.message : String(bm25Err);
    console.error(`[ERROR] BM25 search failed in hybrid mode: ${msg}`);
    throw new Error(`BM25 search failed: ${msg}`);
  }

  // Semantic results
  let semanticResults: Array<{
    chunk_id: string | null;
    document_id: string;
    original_text: string;
    page_number: number | null;
    similarity_score: number;
    image_id: string | null;
    extraction_id: string | null;
    embedding_id: string;
    result_type: 'chunk' | 'vlm' | 'extraction';
    source_file_path: string;
    source_file_name: string;
    source_file_hash: string;
    character_start: number;
    character_end: number;
    chunk_index: number;
    provenance_id: string;
    content_hash: string;
  }> = [];
  try {
    const { vector } = requireDatabase();
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(query);
    semanticResults = vector.searchSimilar(queryVector, {
      limit: searchLimit,
      threshold: 0.3,
      documentFilter,
    });
  } catch (err) {
    const semanticMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WARN] Semantic search failed in hybrid mode: ${semanticMsg}`);
    warnings.push(`Semantic search failed: ${semanticMsg}. Results are BM25-only.`);
  }

  // If both are empty, no results
  if (bm25Results.length === 0 && semanticResults.length === 0) {
    return { results: [], mode_used: 'hybrid', warnings };
  }

  // If only one side has results, return that side directly
  if (semanticResults.length === 0) {
    return {
      results: bm25Results.map((r) => ({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        original_text: r.original_text,
        page_number: r.page_number,
        score: r.bm25_score,
      })),
      mode_used: warnings.length > 0 ? 'bm25_only' : 'bm25_fallback',
      warnings,
    };
  }

  if (bm25Results.length === 0) {
    return {
      results: semanticResults.map((r) => ({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        original_text: r.original_text,
        page_number: r.page_number,
        score: r.similarity_score,
      })),
      mode_used: 'semantic_fallback',
      warnings,
    };
  }

  // Convert to RankedResult format for RRF fusion
  const bm25Ranked: RankedResult[] = bm25Results.map((r) => ({
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

  const semanticRanked: RankedResult[] = semanticResults.map((r, i) => ({
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

  // RRF fusion with configurable weights
  const bm25Weight = 1.0 - semanticWeight;
  const fusion = new RRFFusion({
    k: 60,
    bm25Weight: Math.max(0.01, bm25Weight), // Avoid zero weight
    semanticWeight: Math.max(0.01, semanticWeight),
  });

  const fused = fusion.fuse(bm25Ranked, semanticRanked, searchLimit);
  return {
    results: fused.map((r) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      original_text: r.original_text,
      page_number: r.page_number,
      score: r.rrf_score,
    })),
    mode_used: 'hybrid',
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY AND KG CONTEXT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gather enriched entity context from search results using KG canonical names.
 * Groups entities by type, includes confidence and mention counts.
 */
function gatherEntityContext(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  topResults: QASearchResult[]
): { entityContext: string; entities: QAEntityInfo[] } {
  const entities: QAEntityInfo[] = [];
  let entityContext = '';

  try {
    // Get chunk IDs for entity lookup
    const chunkIds = topResults.map((r) => r.chunk_id).filter((id): id is string => id !== null);

    if (chunkIds.length === 0) {
      // Fall back to document-level entity query
      return gatherDocumentLevelEntities(conn, topResults);
    }

    // Use getEntitiesForChunks for KG-enriched entity data
    const entityMap = getEntitiesForChunks(conn, chunkIds);

    // Deduplicate and aggregate entities across all chunks
    const entityAgg = new Map<
      string,
      {
        node_id: string;
        canonical_name: string;
        entity_type: string;
        confidence: number;
        chunk_count: number;
      }
    >();

    for (const chunkEntities of entityMap.values()) {
      for (const e of chunkEntities) {
        const existing = entityAgg.get(e.node_id);
        if (existing) {
          existing.chunk_count++;
          existing.confidence = Math.max(existing.confidence, e.confidence);
        } else {
          entityAgg.set(e.node_id, {
            node_id: e.node_id,
            canonical_name: e.canonical_name,
            entity_type: e.entity_type,
            confidence: e.confidence,
            chunk_count: 1,
          });
        }
      }
    }

    if (entityAgg.size === 0) {
      // Fall back to document-level entity query
      return gatherDocumentLevelEntities(conn, topResults);
    }

    // Get mention counts from entity_mentions for top entities
    const nodeIds = [...entityAgg.keys()];
    const mentionCounts = new Map<string, number>();
    try {
      const placeholders = nodeIds.map(() => '?').join(',');
      const mentionRows = conn
        .prepare(
          `
        SELECT nel.node_id, COUNT(em.id) as mention_count
        FROM node_entity_links nel
        JOIN entity_mentions em ON em.entity_id = nel.entity_id
        WHERE nel.node_id IN (${placeholders})
        GROUP BY nel.node_id
      `
        )
        .all(...nodeIds) as Array<{ node_id: string; mention_count: number }>;
      for (const row of mentionRows) {
        mentionCounts.set(row.node_id, row.mention_count);
      }
    } catch (error) {
      console.error(`[QuestionAnswer] Failed to query entity mention counts: ${String(error)}`);
    }

    // Build sorted entity list: sort by confidence desc, then chunk_count desc
    const sortedEntities = [...entityAgg.values()]
      .sort((a, b) => b.confidence - a.confidence || b.chunk_count - a.chunk_count)
      .slice(0, 30);

    for (const e of sortedEntities) {
      const mentionCount = mentionCounts.get(e.node_id) ?? e.chunk_count;
      entities.push({
        canonical_name: e.canonical_name,
        raw_text: e.canonical_name,
        entity_type: e.entity_type,
        confidence: e.confidence,
        mention_count: mentionCount,
        node_id: e.node_id,
      });
    }

    // Build context string grouped by entity type
    if (entities.length > 0) {
      entityContext = '\n\n## Key Entities:\n';
      const byType = new Map<string, QAEntityInfo[]>();
      for (const e of entities) {
        const list = byType.get(e.entity_type) ?? [];
        list.push(e);
        byType.set(e.entity_type, list);
      }
      for (const [type, typeEntities] of byType) {
        entityContext += `\n### ${type}:\n`;
        for (const e of typeEntities) {
          entityContext += `- ${e.canonical_name} (confidence: ${e.confidence.toFixed(2)}, ${e.mention_count} mentions)\n`;
        }
      }
    }
  } catch (error) {
    console.error(
      `[QA] Chunk-level entity gather failed, falling back to document-level: ${String(error)}`
    );
    return gatherDocumentLevelEntities(conn, topResults);
  }

  return { entityContext, entities };
}

/**
 * Fallback: gather entities at document level when chunk-level lookup fails.
 */
function gatherDocumentLevelEntities(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  topResults: QASearchResult[]
): { entityContext: string; entities: QAEntityInfo[] } {
  const entities: QAEntityInfo[] = [];
  let entityContext = '';

  try {
    const docIds = [...new Set(topResults.map((r) => r.document_id))];
    const placeholders = docIds.map(() => '?').join(',');

    // Query with KG canonical names via node_entity_links
    const entityRows = conn
      .prepare(
        `
      SELECT kn.canonical_name, e.raw_text, e.entity_type,
             kn.avg_confidence as confidence, kn.id as node_id,
             COUNT(em.id) as mention_count
      FROM entities e
      JOIN entity_mentions em ON em.entity_id = e.id
      LEFT JOIN node_entity_links nel ON nel.entity_id = e.id
      LEFT JOIN knowledge_nodes kn ON kn.id = nel.node_id
      WHERE e.document_id IN (${placeholders})
      GROUP BY COALESCE(kn.id, e.raw_text), e.entity_type
      ORDER BY mention_count DESC
      LIMIT 30
    `
      )
      .all(...docIds) as Array<{
      canonical_name: string | null;
      raw_text: string;
      entity_type: string;
      confidence: number | null;
      node_id: string | null;
      mention_count: number;
    }>;

    if (entityRows.length > 0) {
      entityContext = '\n\n## Key Entities:\n';
      const byType = new Map<string, typeof entityRows>();
      for (const e of entityRows) {
        const list = byType.get(e.entity_type) ?? [];
        list.push(e);
        byType.set(e.entity_type, list);
      }
      for (const [type, typeEntities] of byType) {
        entityContext += `\n### ${type}:\n`;
        for (const e of typeEntities) {
          const name = e.canonical_name ?? e.raw_text;
          entityContext += `- ${name} (${e.mention_count} mentions)\n`;
          entities.push({
            canonical_name: name,
            raw_text: e.raw_text,
            entity_type: e.entity_type,
            confidence: e.confidence ?? 0,
            mention_count: e.mention_count,
            node_id: e.node_id ?? '',
          });
        }
      }
    }
  } catch (error) {
    console.error(`[QuestionAnswer] Failed to build entity context: ${String(error)}`);
  }

  return { entityContext, entities };
}

/** Format KG edge rows into a relationship context string. */
function formatKGPathRows(
  pathRows: Array<{
    source_name: string;
    target_name: string;
    relationship_type: string;
    weight: number;
  }>
): string {
  if (pathRows.length === 0) return '';

  let kgContext = '\n\n## Entity Relationships:\n';
  for (const p of pathRows) {
    kgContext += `- ${p.source_name} --[${p.relationship_type}]--> ${p.target_name} (weight: ${p.weight.toFixed(2)})\n`;
  }
  return kgContext;
}

/** Type alias for the edge row shape returned by all KG path queries. */
type KGPathRow = {
  source_name: string;
  target_name: string;
  relationship_type: string;
  weight: number;
};

/**
 * Gather KG relationship context between top entities.
 * Queries knowledge_edges joined with knowledge_nodes for edges
 * that connect any of the top entities from search results.
 */
function gatherKGPathContext(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entities: QAEntityInfo[]
): string {
  if (entities.length < 2) return '';

  try {
    const nodeIds = entities
      .slice(0, 10)
      .map((e) => e.node_id)
      .filter((id) => id !== '');

    if (nodeIds.length < 2) {
      return gatherKGPathsByName(conn, entities);
    }

    const placeholders = nodeIds.map(() => '?').join(',');
    const pathRows = conn
      .prepare(
        `
      SELECT DISTINCT sn.canonical_name as source_name, tn.canonical_name as target_name,
             ke.relationship_type, ke.weight
      FROM knowledge_edges ke
      JOIN knowledge_nodes sn ON ke.source_node_id = sn.id
      JOIN knowledge_nodes tn ON ke.target_node_id = tn.id
      WHERE ke.source_node_id IN (${placeholders})
        AND ke.target_node_id IN (${placeholders})
      ORDER BY ke.weight DESC
      LIMIT 20
    `
      )
      .all(...nodeIds, ...nodeIds) as KGPathRow[];

    if (pathRows.length === 0) {
      return gatherKGPathsBroad(conn, nodeIds);
    }

    return formatKGPathRows(pathRows);
  } catch (error) {
    console.error(`[QA] KG path lookup failed: ${String(error)}`);
    return '';
  }
}

/**
 * Broader KG path lookup: edges where at least one endpoint is in the entity set.
 */
function gatherKGPathsBroad(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  nodeIds: string[]
): string {
  try {
    const placeholders = nodeIds.map(() => '?').join(',');
    const pathRows = conn
      .prepare(
        `
      SELECT DISTINCT sn.canonical_name as source_name, tn.canonical_name as target_name,
             ke.relationship_type, ke.weight
      FROM knowledge_edges ke
      JOIN knowledge_nodes sn ON ke.source_node_id = sn.id
      JOIN knowledge_nodes tn ON ke.target_node_id = tn.id
      WHERE ke.source_node_id IN (${placeholders})
         OR ke.target_node_id IN (${placeholders})
      ORDER BY ke.weight DESC
      LIMIT 20
    `
      )
      .all(...nodeIds, ...nodeIds) as KGPathRow[];

    return formatKGPathRows(pathRows);
  } catch (error) {
    console.error(`[QA] Broad KG path lookup failed: ${String(error)}`);
    return '';
  }
}

/**
 * Fallback name-based KG path lookup when node_ids are not available.
 */
function gatherKGPathsByName(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entities: QAEntityInfo[]
): string {
  try {
    const topEntityNames = entities.slice(0, 5).map((e) => e.canonical_name.toLowerCase());
    const placeholders = topEntityNames.map(() => '?').join(',');
    const pathRows = conn
      .prepare(
        `
      SELECT sn.canonical_name as source_name, tn.canonical_name as target_name,
             ke.relationship_type, ke.weight
      FROM knowledge_edges ke
      JOIN knowledge_nodes sn ON ke.source_node_id = sn.id
      JOIN knowledge_nodes tn ON ke.target_node_id = tn.id
      WHERE LOWER(sn.canonical_name) IN (${placeholders})
         OR LOWER(tn.canonical_name) IN (${placeholders})
      ORDER BY ke.weight DESC
      LIMIT 20
    `
      )
      .all(...topEntityNames, ...topEntityNames) as KGPathRow[];

    return formatKGPathRows(pathRows);
  } catch (error) {
    console.error(`[QA] Name-based KG path lookup failed: ${String(error)}`);
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleQuestionAnswer(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(QuestionAnswerInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const startTime = Date.now();

    // Resolve defaults
    const limit = input.limit ?? 5;
    const maxContextLength = input.max_context_length ?? 8000;
    const searchMode = input.search_mode ?? 'hybrid';
    const semanticWeight = input.semantic_weight ?? 0.5;
    const searchLimit = Math.min(limit * 2, 40);

    // Step 1: Resolve document filter (document_filter + entity_filter intersection)
    let documentFilter = input.document_filter;

    // Apply entity_filter to narrow document set
    let entityFilterApplied = false;
    let entityFilterDocCount = 0;
    if (input.entity_filter) {
      const entityFilterResult = resolveEntityFilterForQA(
        conn,
        input.entity_filter,
        documentFilter
      );
      if (entityFilterResult.empty) {
        return formatResponse(
          successResult({
            question: input.question,
            answer: 'No documents found matching the specified entity filter.',
            confidence: 0,
            search_mode: searchMode,
            entity_filter_applied: true,
            entity_filter_document_count: 0,
            sources: [],
            processing_duration_ms: Date.now() - startTime,
          })
        );
      }
      documentFilter = entityFilterResult.documentFilter;
      entityFilterApplied = true;
      entityFilterDocCount = documentFilter?.length ?? 0;
    }

    // Step 2: Run search based on mode
    let searchResults: QASearchResult[];
    let modeUsed: string = searchMode;
    const responseWarnings: string[] = [];

    if (searchMode === 'bm25') {
      searchResults = runBM25Search(conn, input.question, searchLimit, documentFilter);
    } else if (searchMode === 'semantic') {
      searchResults = await runSemanticSearch(input.question, searchLimit, documentFilter);
      if (searchResults.length === 0) {
        searchResults = runBM25Search(conn, input.question, searchLimit, documentFilter);
        if (searchResults.length > 0) modeUsed = 'bm25_fallback';
      }
    } else {
      const hybridResult = await runHybridSearch(
        conn,
        input.question,
        searchLimit,
        documentFilter,
        semanticWeight
      );
      searchResults = hybridResult.results;
      modeUsed = hybridResult.mode_used;
      if (hybridResult.warnings.length > 0) {
        responseWarnings.push(...hybridResult.warnings);
      }
    }

    // Take top results
    const topResults = searchResults.slice(0, limit);

    if (topResults.length === 0) {
      return formatResponse(
        successResult({
          question: input.question,
          answer:
            'No relevant documents found to answer this question. Please ensure documents have been ingested and processed.',
          confidence: 0,
          search_mode: modeUsed,
          sources: [],
          processing_duration_ms: Date.now() - startTime,
        })
      );
    }

    // Step 3: Build context block from search results
    let context = '';
    const sources: Array<{
      chunk_id: string | null;
      document_id: string;
      page_number: number | null;
      text_excerpt: string;
      relevance_score: number;
    }> = [];

    for (const result of topResults) {
      const excerpt = result.original_text.slice(0, Math.floor(maxContextLength / limit));
      context += `\n---\n[Document: ${result.document_id}, Page: ${result.page_number ?? 'N/A'}]\n${excerpt}\n`;
      if (input.include_sources) {
        sources.push({
          chunk_id: result.chunk_id,
          document_id: result.document_id,
          page_number: result.page_number,
          text_excerpt: excerpt.slice(0, 300),
          relevance_score: result.score,
        });
      }
    }

    // Step 4: Add entity context if requested
    let entityContext = '';
    let entities: QAEntityInfo[] = [];
    if (input.include_entity_context) {
      const entityResult = gatherEntityContext(conn, topResults);
      entityContext = entityResult.entityContext;
      entities = entityResult.entities;
    }

    // Step 5: Add KG path context with optional temporal weighting
    let kgContext = '';
    if (input.include_kg_paths && entities.length >= 2) {
      kgContext = gatherKGPathContext(conn, entities);

      if (input.prefer_recent && entities.length >= 2) {
        try {
          const nodeIds = entities
            .slice(0, 10)
            .map((e) => e.node_id)
            .filter((id) => id !== '');
          if (nodeIds.length >= 2) {
            const placeholders = nodeIds.map(() => '?').join(',');
            const temporalEdges = conn
              .prepare(
                `
              SELECT sn.canonical_name as source_name, tn.canonical_name as target_name,
                     ke.relationship_type, ke.weight, ke.valid_from, ke.valid_until
              FROM knowledge_edges ke
              JOIN knowledge_nodes sn ON ke.source_node_id = sn.id
              JOIN knowledge_nodes tn ON ke.target_node_id = tn.id
              WHERE (ke.source_node_id IN (${placeholders}) OR ke.target_node_id IN (${placeholders}))
                AND ke.valid_from IS NOT NULL
              ORDER BY ke.valid_from DESC
              LIMIT 10
            `
              )
              .all(...nodeIds, ...nodeIds) as Array<{
              source_name: string;
              target_name: string;
              relationship_type: string;
              weight: number;
              valid_from: string | null;
              valid_until: string | null;
            }>;
            if (temporalEdges.length > 0) {
              kgContext += '\n\n## Recent Temporal Relationships:\n';
              for (const e of temporalEdges) {
                kgContext += `- ${e.source_name} --[${e.relationship_type}]--> ${e.target_name} (from: ${e.valid_from ?? 'N/A'})\n`;
              }
            }
          }
        } catch (error) {
          console.error(
            `[QuestionAnswer] Failed to query temporal relationships: ${String(error)}`
          );
        }
      }
    }

    // Step 5b: Add synthesis context (corpus intelligence + document narratives)
    let synthesisContext = '';
    if (input.include_corpus_context || input.include_narrative) {
      try {
        const dbName = getCurrentDatabaseName() ?? 'default';

        if (input.include_corpus_context) {
          const corpus = getCorpusIntelligence(conn, dbName);
          if (corpus) {
            synthesisContext += '\n\n## Corpus Intelligence:\n';
            synthesisContext += corpus.corpus_summary + '\n';
            try {
              const themes = JSON.parse(corpus.themes) as Array<{
                name: string;
                description: string;
              }>;
              if (themes.length > 0) {
                synthesisContext += '\n### Themes:\n';
                for (const t of themes) {
                  synthesisContext += `- **${t.name}**: ${t.description}\n`;
                }
              }
            } catch {
              /* themes not parseable */
            }
          }
        }

        if (input.include_narrative) {
          const docIds = [...new Set(topResults.map((r) => r.document_id))];
          const narratives: string[] = [];
          for (const docId of docIds.slice(0, 3)) {
            const narrative = getDocumentNarrative(conn, docId);
            if (narrative) {
              narratives.push(`[${docId}]: ${narrative.narrative_text.slice(0, 500)}`);
            }
          }
          if (narratives.length > 0) {
            synthesisContext += '\n\n## Document Narratives (AI-Synthesized):\n';
            synthesisContext += narratives.join('\n\n');
          }
        }
      } catch (synthErr) {
        console.error(
          `[qa] Synthesis context failed: ${synthErr instanceof Error ? synthErr.message : String(synthErr)}`
        );
      }
    }

    // Step 6: Generate answer using Gemini
    const fullContext = context + entityContext + kgContext + synthesisContext;
    const truncatedContext = fullContext.slice(0, maxContextLength);

    const gemini = new GeminiClient({ temperature: input.temperature });
    const prompt = `You are a precise document analysis assistant. Answer the following question based ONLY on the provided context. If the context doesn't contain enough information, say so clearly. Be concise and factual.

## Context:
${truncatedContext}

## Question:
${input.question}

## Instructions:
- Answer based ONLY on the provided context
- Cite specific details from the documents
- If the answer is uncertain, indicate your confidence level
- If entities and relationships are provided, use them to inform your answer
- If corpus intelligence or document narratives are provided, use them for broader context
- Be concise but thorough`;

    let answer = '';
    let confidence = 0;
    try {
      const geminiResult = await gemini.fast(prompt);
      answer = geminiResult.text || 'Unable to generate answer.';
      confidence = Math.min(1, topResults.length / limit);
    } catch (geminiError) {
      const geminiMsg = geminiError instanceof Error ? geminiError.message : String(geminiError);
      console.error(`[WARN] Gemini answer generation failed: ${geminiMsg}`);
      answer = `Answer generation failed: ${geminiMsg}. Here is the relevant context:\n\n${truncatedContext.slice(0, 2000)}`;
      confidence = 0;
    }

    const processingDurationMs = Date.now() - startTime;

    // Build response
    const responseData: Record<string, unknown> = {
      question: input.question,
      answer,
      confidence,
      search_mode: modeUsed,
      sources_used: topResults.length,
      entities_found: entities.length,
      processing_duration_ms: processingDurationMs,
    };

    if (input.include_sources) {
      responseData.sources = sources;
    }

    if (input.include_entity_context && entities.length > 0) {
      // Group entities by type for structured output
      const entitiesByType: Record<
        string,
        Array<{
          canonical_name: string;
          confidence: number;
          mention_count: number;
        }>
      > = {};
      for (const e of entities.slice(0, 15)) {
        const list = entitiesByType[e.entity_type] ?? [];
        list.push({
          canonical_name: e.canonical_name,
          confidence: e.confidence,
          mention_count: e.mention_count,
        });
        entitiesByType[e.entity_type] = list;
      }
      responseData.entities_by_type = entitiesByType;
      responseData.entities = entities.slice(0, 10).map((e) => ({
        name: e.canonical_name,
        type: e.entity_type,
        confidence: e.confidence,
        mentions: e.mention_count,
      }));
    }

    if (input.include_cluster_context && topResults.length > 0) {
      try {
        const docClusterMap: Record<
          string,
          Array<{ cluster_id: string; label: string | null; run_id: string }>
        > = {};
        const seenDocs = new Set<string>();
        for (const r of topResults) {
          if (seenDocs.has(r.document_id)) continue;
          seenDocs.add(r.document_id);
          const summaries = getClusterSummariesForDocument(conn, r.document_id);
          if (summaries.length > 0) {
            docClusterMap[r.document_id] = summaries.map((s) => ({
              cluster_id: s.id,
              label: s.label,
              run_id: s.run_id,
            }));
          }
        }
        if (Object.keys(docClusterMap).length > 0) {
          responseData.cluster_context = docClusterMap;
        }
      } catch (clErr) {
        console.error(
          `[qa] Cluster context failed: ${clErr instanceof Error ? clErr.message : String(clErr)}`
        );
      }
    }

    if (input.include_contradictions && topResults.length > 0) {
      try {
        const docIds = [...new Set(topResults.map((r) => r.document_id))];
        const placeholders = docIds.map(() => '?').join(',');
        const contradictions = conn
          .prepare(
            `
          SELECT id, document_id_1, document_id_2, similarity_ratio, summary
          FROM comparisons
          WHERE document_id_1 IN (${placeholders}) OR document_id_2 IN (${placeholders})
          ORDER BY created_at DESC LIMIT 10
        `
          )
          .all(...docIds, ...docIds) as Array<{
          id: string;
          document_id_1: string;
          document_id_2: string;
          similarity_ratio: number;
          summary: string;
        }>;
        if (contradictions.length > 0) {
          responseData.contradictions = contradictions;
        }
      } catch (cErr) {
        console.error(
          `[qa] Contradiction query failed: ${cErr instanceof Error ? cErr.message : String(cErr)}`
        );
      }
    }

    if (input.prefer_recent) {
      responseData.temporal_preference = 'recent';
    }

    if (input.include_corpus_context) {
      responseData.corpus_context_included = synthesisContext.length > 0;
    }
    if (input.include_narrative) {
      responseData.narrative_context_included = synthesisContext.includes('Document Narratives');
    }

    if (entityFilterApplied) {
      responseData.entity_filter_applied = true;
      responseData.entity_filter_document_count = entityFilterDocCount;
    }

    if (responseWarnings.length > 0) {
      responseData.warnings = responseWarnings;
      responseData._degraded = true;
      responseData.actual_mode = modeUsed;
    }

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const questionAnswerTools: Record<string, ToolDefinition> = {
  ocr_question_answer: {
    description:
      'Answer questions about documents using RAG (retrieval-augmented generation). Supports hybrid (BM25+semantic), BM25-only, or semantic-only search modes. Enriches with entity context (grouped by type with KG canonical names) and knowledge graph relationship paths, then generates an answer using Gemini AI. Supports entity_filter to restrict answers to documents containing specific entities.',
    inputSchema: QuestionAnswerInput.shape,
    handler: handleQuestionAnswer,
  },
};
