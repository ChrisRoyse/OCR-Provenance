/**
 * Search MCP Tools
 *
 * Tools: ocr_search, ocr_search_semantic, ocr_search_hybrid, ocr_fts_manage, ocr_rag_context
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
import { RRFFusion, type RankedResult } from '../services/search/fusion.js';
import { expandQueryWithKG, expandQueryWithCoMentioned, expandQueryTextForSemantic, findMatchingNodeIds, getExpandedTerms, findQuerySuggestions } from '../services/search/query-expander.js';
import { rerankResults, type EdgeInfo } from '../services/search/reranker.js';
import { getEntitiesForChunks, getDocumentIdsForEntities, getEdgesForNode, getKnowledgeNode, getEntityMentionFrequencyByDocument, getRelatedDocumentsByEntityOverlap, resolveEntityNodeIdsFromKG, type ChunkEntityInfo } from '../services/storage/database/knowledge-graph-operations.js';
import { findGraphPaths } from '../services/knowledge-graph/graph-service.js';

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

/**
 * Build edge context from entity map for reranking.
 * Collects unique node IDs from all entities in the results, queries edges between
 * those nodes, and returns a capped list sorted by weight for the reranker prompt.
 *
 * @param conn - Database connection
 * @param entityMap - Map of chunk_id -> entity info from getEntitiesForChunks()
 * @returns Array of EdgeInfo for reranking, or undefined if no edges found
 */
function buildEdgeContext(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entityMap: Map<string, ChunkEntityInfo[]>,
): EdgeInfo[] | undefined {
  // Collect unique node IDs from all entities in the results
  const nodeIdSet = new Set<string>();
  for (const entities of entityMap.values()) {
    for (const e of entities) {
      nodeIdSet.add(e.node_id);
    }
  }

  if (nodeIdSet.size === 0) return undefined;

  // Build a map of node_id -> canonical_name for resolving edge endpoints
  const nodeNameMap = new Map<string, string>();
  for (const entities of entityMap.values()) {
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
  if (edgeInfoList.length === 0) return undefined;
  edgeInfoList.sort((a, b) => b.weight - a.weight);
  return edgeInfoList.slice(0, 30);
}

/**
 * Build cross-document entity summary from an entity map.
 * Aggregates entities across all search results and returns a summary
 * sorted by how many results mention each entity.
 */
function buildCrossDocumentEntitySummary(
  entityMap: Map<string, ChunkEntityInfo[]>,
): Array<{
  node_id: string;
  canonical_name: string;
  entity_type: string;
  aliases: string[];
  mentioned_in_results: number;
  document_count: number;
}> {
  const nodeResultCount = new Map<string, number>();
  const nodeInfo = new Map<string, { canonical_name: string; entity_type: string; aliases: string[]; document_count: number }>();

  for (const entities of entityMap.values()) {
    const seenInChunk = new Set<string>();
    for (const e of entities) {
      if (!seenInChunk.has(e.node_id)) {
        seenInChunk.add(e.node_id);
        nodeResultCount.set(e.node_id, (nodeResultCount.get(e.node_id) ?? 0) + 1);
      }
      if (!nodeInfo.has(e.node_id)) {
        nodeInfo.set(e.node_id, {
          canonical_name: e.canonical_name,
          entity_type: e.entity_type,
          aliases: e.aliases,
          document_count: e.document_count,
        });
      }
    }
  }

  const summary = [];
  for (const [nodeId, count] of nodeResultCount.entries()) {
    const info = nodeInfo.get(nodeId);
    if (!info) continue;
    summary.push({
      node_id: nodeId,
      canonical_name: info.canonical_name,
      entity_type: info.entity_type,
      aliases: info.aliases,
      mentioned_in_results: count,
      document_count: info.document_count,
    });
  }

  summary.sort((a, b) => b.mentioned_in_results - a.mentioned_in_results);
  return summary.slice(0, 20);
}

/**
 * Resolve entity_filter to a narrowed document filter.
 * Intersects entity-matching document IDs with any existing document filter.
 * Returns null if the filter yields zero results (caller should return early with empty results).
 * Returns undefined if no entity_filter is provided (pass-through).
 */
function resolveEntityFilter(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entityFilter: { entity_names?: string[]; entity_types?: string[]; include_related?: boolean } | undefined,
  existingDocFilter: string[] | undefined,
  timeRange?: { from?: string; to?: string },
): { documentFilter: string[] | undefined; empty: boolean } {
  if (!entityFilter) return { documentFilter: existingDocFilter, empty: false };

  let entityDocIds = getDocumentIdsForEntities(
    conn,
    entityFilter.entity_names,
    entityFilter.entity_types,
    entityFilter.include_related,
  );

  // F-13: Semantic fallback via entity_embeddings when standard lookup returns empty
  if (entityDocIds.length === 0 && entityFilter.entity_names && entityFilter.entity_names.length > 0) {
    try {
      const semanticEntityDocIds = searchEntityEmbeddingsForDocuments(conn, entityFilter.entity_names);
      if (semanticEntityDocIds.length > 0) {
        entityDocIds = semanticEntityDocIds;
      }
    } catch {
      // entity_embeddings tables may not exist yet
    }
  }

  if (entityDocIds.length === 0) return { documentFilter: undefined, empty: true };

  // F-8: Temporal filtering - narrow related documents by temporally-valid edges
  if (timeRange && (timeRange.from || timeRange.to) && entityFilter.include_related) {
    try {
      const fromDate = timeRange.from ?? '0000-01-01';
      const toDate = timeRange.to ?? '9999-12-31';
      const temporalRows = conn.prepare(`
        SELECT DISTINCT ke.source_node_id, ke.target_node_id
        FROM knowledge_edges ke
        WHERE (ke.valid_from IS NULL OR ke.valid_from <= ?)
          AND (ke.valid_until IS NULL OR ke.valid_until >= ?)
      `).all(toDate, fromDate) as Array<{ source_node_id: string; target_node_id: string }>;

      if (temporalRows.length > 0) {
        // Build set of node IDs connected by temporally-valid edges
        const validNodeIds = new Set<string>();
        for (const row of temporalRows) {
          validNodeIds.add(row.source_node_id);
          validNodeIds.add(row.target_node_id);
        }
        // Re-filter entityDocIds to only documents whose entities have valid temporal edges
        const entityNodeIds = [...resolveEntityNodeIdsFromKG(conn, entityFilter.entity_names, entityFilter.entity_types, false)];
        if (entityNodeIds.length > 0) {
          const hasTemporalConnection = entityNodeIds.some(nid => validNodeIds.has(nid));
          if (!hasTemporalConnection) {
            // No temporally-valid connections - narrow to direct entity docs only
            entityDocIds = getDocumentIdsForEntities(conn, entityFilter.entity_names, entityFilter.entity_types, false);
          }
        }
      }
    } catch {
      // Temporal columns may not exist in older schema versions
    }
  }

  if (existingDocFilter && existingDocFilter.length > 0) {
    const entitySet = new Set(entityDocIds);
    const intersected = existingDocFilter.filter(id => entitySet.has(id));
    if (intersected.length === 0) return { documentFilter: undefined, empty: true };
    return { documentFilter: intersected, empty: false };
  }

  return { documentFilter: entityDocIds, empty: false };
}

/**
 * Build entity context map for reranking from a chunk-based entity map.
 * Converts chunk_id-keyed entity map to result-index-keyed context map.
 */
function buildEntityContextForRerank(
  results: Array<{ chunk_id?: string | null; image_id?: string | null }>,
  entityMap: Map<string, ChunkEntityInfo[]>,
): Map<number, Array<{ entity_type: string; canonical_name: string; document_count: number; aliases?: string[] }>> | undefined {
  const contextMap = new Map<number, Array<{ entity_type: string; canonical_name: string; document_count: number; aliases?: string[] }>>();
  for (let i = 0; i < results.length; i++) {
    const entityKey = results[i].chunk_id ?? results[i].image_id;
    if (!entityKey) continue;
    const entities = entityMap.get(entityKey);
    if (!entities) continue;
    contextMap.set(i, entities.map(e => ({
      entity_type: e.entity_type,
      canonical_name: e.canonical_name,
      document_count: e.document_count,
      aliases: e.aliases,
    })));
  }
  return contextMap.size > 0 ? contextMap : undefined;
}

/**
 * Enrich entity map with page co-occurrence entities for VLM/image results.
 * For results that have no chunk_id but have image_id and page_number,
 * queries entities on that page and merges them into the entity map keyed by image_id.
 * This enables entity enrichment for VLM search results that lack text chunks.
 */
function enrichEntityMapWithPageEntities(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entityMap: Map<string, ChunkEntityInfo[]>,
  results: Array<{ chunk_id?: string | null; image_id?: string | null; document_id: string; page_number?: number | null }>,
): void {
  const pageRequests = new Map<string, { document_id: string; page_number: number; image_ids: string[] }>();

  for (const r of results) {
    if (r.chunk_id || !r.image_id || r.page_number == null) continue;
    const key = `${r.document_id}:${r.page_number}`;
    const existing = pageRequests.get(key);
    if (existing) {
      existing.image_ids.push(r.image_id);
    } else {
      pageRequests.set(key, { document_id: r.document_id, page_number: r.page_number, image_ids: [r.image_id] });
    }
  }

  if (pageRequests.size === 0) return;

  for (const [, { document_id, page_number, image_ids }] of pageRequests) {
    const rows = conn.prepare(`
      SELECT DISTINCT kn.id as node_id, kn.canonical_name, kn.entity_type,
             kn.aliases, kn.avg_confidence, kn.document_count
      FROM entity_mentions em
      JOIN entities e ON e.id = em.entity_id
      JOIN node_entity_links nel ON nel.entity_id = e.id
      JOIN knowledge_nodes kn ON kn.id = nel.node_id
      JOIN chunks c ON c.id = em.chunk_id
      WHERE c.document_id = ? AND c.page_number = ?
    `).all(document_id, page_number) as Array<{
      node_id: string; canonical_name: string; entity_type: string;
      aliases: string | null; avg_confidence: number; document_count: number;
    }>;

    const seen = new Set<string>();
    const entities: ChunkEntityInfo[] = [];
    for (const r of rows) {
      if (seen.has(r.node_id)) continue;
      seen.add(r.node_id);
      entities.push({
        node_id: r.node_id,
        canonical_name: r.canonical_name,
        entity_type: r.entity_type,
        aliases: r.aliases ? JSON.parse(r.aliases) : [],
        confidence: r.avg_confidence,
        document_count: r.document_count,
      });
    }

    if (entities.length > 0) {
      for (const imageId of image_ids) {
        entityMap.set(imageId, entities);
      }
    }
  }
}

/**
 * Build rerank metadata for the response.
 */
function buildRerankInfo(
  entityContext: Map<number, unknown[]> | undefined,
  edgeContext: EdgeInfo[] | undefined,
  candidatesEvaluated: number,
  resultsReturned: number,
): Record<string, unknown> {
  return {
    reranked: true,
    entity_aware: !!entityContext && entityContext.size > 0,
    edge_aware: !!edgeContext && edgeContext.length > 0,
    edge_count: edgeContext?.length ?? 0,
    candidates_evaluated: Math.min(candidatesEvaluated, 20),
    results_returned: resultsReturned,
  };
}

/**
 * Apply entity mention frequency boost to search result scores.
 * Multiplies scores by (1 + log(1 + mention_count) * 0.1) for results
 * whose documents have entity mentions matching the active entity_filter.
 */
function boostResultsByMentionFrequency(
  results: Array<Record<string, unknown>>,
  scoreField: string,
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  nodeIds: string[],
): { boosted_results: number; max_mention_count: number } | undefined {
  const docIds = [...new Set(results.map(r => r.document_id as string).filter(Boolean))];
  if (docIds.length === 0) return undefined;

  const freqMap = getEntityMentionFrequencyByDocument(conn, docIds, nodeIds);
  if (freqMap.size === 0) return undefined;

  let boostedCount = 0;
  let maxMentionCount = 0;

  for (const r of results) {
    const docId = r.document_id as string;
    const mentionCount = freqMap.get(docId) ?? 0;
    r.entity_mention_count = mentionCount;

    if (mentionCount > 0) {
      const boostFactor = 1 + Math.log(1 + mentionCount) * 0.1;
      const currentScore = r[scoreField] as number;
      if (typeof currentScore === 'number') {
        r[scoreField] = currentScore * boostFactor;
        boostedCount++;
      }
      if (mentionCount > maxMentionCount) maxMentionCount = mentionCount;
    }
  }

  if (boostedCount === 0) return undefined;
  return { boosted_results: boostedCount, max_mention_count: maxMentionCount };
}

function applyEntityFrequencyBoost(
  results: Array<Record<string, unknown>>,
  scoreField: string,
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entityFilter: { entity_names?: string[]; entity_types?: string[] },
): { boosted_results: number; max_mention_count: number } | undefined {
  if (results.length === 0) return undefined;

  const entityNodeIds = [...resolveEntityNodeIdsFromKG(conn, entityFilter.entity_names, entityFilter.entity_types, false)];
  if (entityNodeIds.length === 0) return undefined;

  return boostResultsByMentionFrequency(results, scoreField, conn, entityNodeIds);
}

function applyQueryDerivedFrequencyBoost(
  results: Array<Record<string, unknown>>,
  scoreField: string,
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  query: string,
): { boosted_results: number; max_mention_count: number } | undefined {
  if (results.length === 0) return undefined;

  try {
    const nodeIds = findMatchingNodeIds(query, conn);
    if (nodeIds.length === 0) return undefined;

    return boostResultsByMentionFrequency(results, scoreField, conn, nodeIds);
  } catch {
    // KG tables may not exist - skip query-derived frequency boost
    return undefined;
  }
}

/**
 * Apply chunk proximity boost to hybrid search results.
 * Results from the same document whose chunk indexes are within 2 of each other
 * get their rrf_score multiplied by (1 + 0.1 * nearbyCount), rewarding
 * clusters of nearby relevant chunks.
 */
function applyChunkProximityBoost(
  results: Array<Record<string, unknown>>,
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
      const nearbyCount = entries.filter(e =>
        Math.abs(e.chunkIndex - entry.chunkIndex) <= 2 &&
        e.chunkIndex !== entry.chunkIndex
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
 * Search entity_embeddings table for document IDs matching entity names.
 * Used as a semantic fallback when getDocumentIdsForEntities returns empty.
 * Nodes with embeddings are more likely to be important entities.
 */
function searchEntityEmbeddingsForDocuments(
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
  entityNames: string[],
): string[] {
  const placeholders = entityNames.map(() => '?').join(',');
  const rows = conn.prepare(`
    SELECT DISTINCT e.document_id
    FROM entity_embeddings ee
    JOIN knowledge_nodes kn ON ee.node_id = kn.id
    JOIN node_entity_links nel ON nel.node_id = kn.id
    JOIN entities e ON nel.entity_id = e.id
    WHERE LOWER(kn.canonical_name) IN (${placeholders})
       OR LOWER(kn.normalized_name) IN (${placeholders})
  `).all(...entityNames.map(n => n.toLowerCase()), ...entityNames.map(n => n.toLowerCase())) as Array<{ document_id: string }>;
  return rows.map(r => r.document_id);
}

/**
 * Convert BM25 results (with bm25_score and rank) to ranked format for RRF fusion.
 */
function toBm25Ranked(
  results: Array<{ chunk_id: string | null; image_id: string | null; extraction_id: string | null; embedding_id: string | null; document_id: string; original_text: string; result_type: 'chunk' | 'vlm' | 'extraction'; source_file_path: string; source_file_name: string; source_file_hash: string; page_number: number | null; character_start: number; character_end: number; chunk_index: number; provenance_id: string; content_hash: string; rank: number; bm25_score: number }>,
): RankedResult[] {
  return results.map(r => ({
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
}

/**
 * Convert semantic search results (with similarity_score) to ranked format for RRF fusion.
 */
function toSemanticRanked(
  results: Array<{ chunk_id: string | null; image_id: string | null; extraction_id: string | null; embedding_id: string; document_id: string; original_text: string; result_type: 'chunk' | 'vlm' | 'extraction'; source_file_path: string; source_file_name: string; source_file_hash: string; page_number: number | null; character_start: number; character_end: number; chunk_index: number; provenance_id: string; content_hash: string; similarity_score: number }>,
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
  }));
}

/**
 * Deduplicate results by primary entity node.
 * Keeps at most maxPerEntity results for each primary entity (first entity in the list).
 * Results without entities are always kept.
 */
function deduplicateByPrimaryEntity(
  results: Array<Record<string, unknown>>,
  entityMap: Map<string, ChunkEntityInfo[]>,
  maxPerEntity: number = 2,
): { results: Array<Record<string, unknown>>; removed_count: number } {
  const entityGroupCounts = new Map<string, number>();
  let removedCount = 0;
  const filtered = results.filter(r => {
    const entityKey = (r.chunk_id as string) ?? (r.image_id as string);
    if (!entityKey) return true;
    const chunkEntities = entityMap.get(entityKey);
    if (!chunkEntities || chunkEntities.length === 0) return true;
    const primaryEntity = chunkEntities[0].node_id;
    const count = entityGroupCounts.get(primaryEntity) ?? 0;
    if (count >= maxPerEntity) {
      removedCount++;
      return false;
    }
    entityGroupCounts.set(primaryEntity, count + 1);
    return true;
  });
  return { results: filtered, removed_count: removedCount };
}

/** KG integration metrics shape tracked per search handler */
interface KGIntegrationMetrics {
  entity_filter_applied: boolean;
  entity_filter_documents_matched: number;
  expand_query_terms_added: number;
  entity_boost_results_boosted: number;
  rerank_entity_aware: boolean;
  frequency_boost_results_boosted: number;
  entity_rescue_count: number;
  deduplication_removed: number;
  did_you_mean_suggestions: number;
}

/** Create a fresh KG integration metrics object with all fields zeroed */
function createKGMetrics(): KGIntegrationMetrics {
  return {
    entity_filter_applied: false,
    entity_filter_documents_matched: 0,
    expand_query_terms_added: 0,
    entity_boost_results_boosted: 0,
    rerank_entity_aware: false,
    frequency_boost_results_boosted: 0,
    entity_rescue_count: 0,
    deduplication_removed: 0,
    did_you_mean_suggestions: 0,
  };
}

/**
 * Attach optional provenance chain and entity mentions to a search result object.
 * Shared by BM25, semantic, and hybrid handlers (both reranked and non-reranked paths).
 *
 * @param provenanceKey - Response field name for provenance chain ('provenance' or 'provenance_chain')
 */
function attachProvenanceAndEntities(
  result: Record<string, unknown>,
  db: ReturnType<typeof requireDatabase>['db'],
  provenanceId: string,
  includeProvenance: boolean,
  includeEntities: boolean,
  entityMap: Map<string, ChunkEntityInfo[]> | undefined,
  chunkId: string | null | undefined,
  imageId: string | null | undefined,
  provenanceKey: 'provenance' | 'provenance_chain' = 'provenance',
): void {
  if (includeProvenance) {
    result[provenanceKey] = formatProvenanceChain(db, provenanceId);
  }
  if (includeEntities && entityMap) {
    const entityKey = chunkId ?? imageId;
    if (entityKey) {
      result.entities_mentioned = entityMap.get(entityKey) ?? [];
    }
  }
}

/**
 * Append "did you mean?" suggestions to response when results are empty.
 * Queries KG entity names for fuzzy matches to the query.
 */
function appendDidYouMean(
  responseData: Record<string, unknown>,
  kgMetrics: KGIntegrationMetrics,
  query: string,
  conn: ReturnType<ReturnType<typeof requireDatabase>['db']['getConnection']>,
): void {
  try {
    const suggestions = findQuerySuggestions(query, conn);
    if (suggestions.length > 0) {
      responseData.did_you_mean = suggestions;
      kgMetrics.did_you_mean_suggestions = suggestions.length;
    }
  } catch {
    // KG not available - skip suggestions
  }
}

/**
 * Append entity filter metadata and frequency boost info to response.
 */
function appendEntityFilterResponse(
  responseData: Record<string, unknown>,
  kgMetrics: KGIntegrationMetrics,
  entityFilter: { entity_names?: string[]; entity_types?: string[] },
  documentFilter: string[] | undefined,
  freqBoostInfo: { boosted_results: number; max_mention_count: number } | undefined,
): void {
  responseData.entity_filter_applied = true;
  responseData.entity_filter_document_count = documentFilter?.length ?? 0;
  responseData.related_entities_included = (entityFilter as { include_related?: boolean }).include_related ?? false;
  if (freqBoostInfo) {
    responseData.frequency_boost = freqBoostInfo;
    kgMetrics.frequency_boost_results_boosted = freqBoostInfo.boosted_results;
  }
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

    const kgMetricsSemantic = createKGMetrics();

    // Resolve metadata filter to document IDs, then chain through quality filter
    let documentFilter = resolveQualityFilter(db, input.min_quality_score,
      resolveMetadataFilter(db, input.metadata_filter, input.document_filter));

    // Entity filter: resolve entity names/types to document IDs
    const entityFilterResult = resolveEntityFilter(conn, input.entity_filter, documentFilter, input.time_range);
    if (entityFilterResult.empty) {
      return formatResponse(successResult({
        query: input.query,
        results: [],
        total: 0,
        threshold: input.similarity_threshold ?? 0.7,
        entity_filter_applied: true,
        entity_filter_document_count: 0,
        related_entities_included: input.entity_filter?.include_related ?? false,
      }));
    }
    documentFilter = entityFilterResult.documentFilter;
    if (input.entity_filter) {
      kgMetricsSemantic.entity_filter_applied = true;
      kgMetricsSemantic.entity_filter_documents_matched = documentFilter?.length ?? 0;
    }

    // Expand query text for semantic embedding if requested
    let semanticQueryText = input.query;
    let semanticExpansionInfo: { original: string; expanded_text: string } | undefined;
    if (input.expand_query) {
      const expandedText = expandQueryTextForSemantic(input.query, conn);
      if (expandedText !== input.query) {
        semanticQueryText = expandedText;
        semanticExpansionInfo = { original: input.query, expanded_text: expandedText };
        // Count added terms (expanded words minus original words)
        const origWords = new Set(input.query.toLowerCase().split(/\s+/));
        kgMetricsSemantic.expand_query_terms_added = expandedText.toLowerCase().split(/\s+/).filter(w => !origWords.has(w)).length;
      }
    }

    // Generate query embedding (using expanded text if expand_query was active)
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(semanticQueryText);

    const limit = input.limit ?? 10;
    const searchLimit = input.rerank ? Math.max(limit * 2, 20) : limit;

    // Lower threshold when entity_rescue enabled to catch borderline results
    const threshold = input.similarity_threshold ?? 0.7;
    const effectiveThreshold = input.entity_rescue
      ? Math.max(0, threshold - 0.1)
      : threshold;

    // Search for similar vectors
    const results = vector.searchSimilar(queryVector, {
      limit: searchLimit,
      threshold: effectiveThreshold,
      documentFilter,
    });

    // Entity enrichment: collect chunk IDs and fetch entities if requested
    let entityMap: Map<string, ChunkEntityInfo[]> | undefined;
    if (input.include_entities || input.rerank) {
      const chunkIds = results.map(r => r.chunk_id).filter((id): id is string => id != null);
      if (chunkIds.length > 0) {
        entityMap = getEntitiesForChunks(conn, chunkIds, input.min_entity_confidence);
      }
      // Enrich VLM/image results with page co-occurrence entities
      if (!entityMap) entityMap = new Map();
      enrichEntityMapWithPageEntities(conn, entityMap, results);
    }

    // Entity rescue - filter borderline results that lack matching entities
    let entityRescueInfo: { rescued_count: number } | undefined;
    let filteredSemanticResults = results;
    if (input.entity_rescue && entityMap && entityMap.size > 0) {
      const queryTermsLower = input.query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      let rescuedCount = 0;
      filteredSemanticResults = results.filter(r => {
        if (r.similarity_score >= threshold) return true;
        const entityKey = r.chunk_id ?? r.image_id;
        const entities = entityKey ? (entityMap!.get(entityKey) || []) : [];
        const hasMatch = entities.some(e =>
          queryTermsLower.some(term => e.canonical_name.toLowerCase().includes(term))
        );
        if (hasMatch) rescuedCount++;
        return hasMatch;
      });
      if (rescuedCount > 0) {
        entityRescueInfo = { rescued_count: rescuedCount };
        kgMetricsSemantic.entity_rescue_count = rescuedCount;
      }
    }

    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && filteredSemanticResults.length > 0) {
      const entityContextForRerank = entityMap ? buildEntityContextForRerank(filteredSemanticResults, entityMap) : undefined;
      const edgeContextForRerank = entityMap ? buildEdgeContext(conn, entityMap) : undefined;

      const rerankInput = filteredSemanticResults.map(r => ({
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

      const reranked = await rerankResults(input.query, rerankInput, limit, entityContextForRerank, edgeContextForRerank);
      finalResults = reranked.map(r => {
        const original = filteredSemanticResults[r.original_index];
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
        // OPT-5: Mark per-result entity_rescued flag for borderline results
        if (input.entity_rescue && original.similarity_score < threshold) {
          result.entity_rescued = true;
        }
        attachProvenanceAndEntities(result, db, original.provenance_id, !!input.include_provenance, !!input.include_entities, entityMap, original.chunk_id, original.image_id);
        return result;
      });
      rerankInfo = buildRerankInfo(entityContextForRerank, edgeContextForRerank, filteredSemanticResults.length, finalResults.length);
      kgMetricsSemantic.rerank_entity_aware = !!(entityContextForRerank && entityContextForRerank.size > 0);
    } else {
      finalResults = filteredSemanticResults.map(r => {
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
        // OPT-5: Mark per-result entity_rescued flag for borderline results
        if (input.entity_rescue && r.similarity_score < threshold) {
          result.entity_rescued = true;
        }
        attachProvenanceAndEntities(result, db, r.provenance_id, !!input.include_provenance, !!input.include_entities, entityMap, r.chunk_id, r.image_id);
        return result;
      });
    }

    // Deduplicate by primary entity
    let semanticDeduplicationInfo: { removed_count: number } | undefined;
    if (input.deduplicate_by_entity && entityMap && entityMap.size > 0) {
      const deduped = deduplicateByPrimaryEntity(finalResults, entityMap);
      finalResults = deduped.results;
      if (deduped.removed_count > 0) {
        semanticDeduplicationInfo = { removed_count: deduped.removed_count };
        kgMetricsSemantic.deduplication_removed = deduped.removed_count;
      }
    }

    // Apply entity mention frequency boost
    const semanticFreqBoostInfo = input.entity_filter
      ? applyEntityFrequencyBoost(finalResults, 'similarity_score', conn, input.entity_filter)
      : applyQueryDerivedFrequencyBoost(finalResults, 'similarity_score', conn, input.query);

    // Re-sort after frequency boost may have changed scores
    if (semanticFreqBoostInfo) {
      finalResults.sort((a, b) => (b.similarity_score as number) - (a.similarity_score as number));
    }

    const responseData: Record<string, unknown> = {
      query: input.query,
      results: finalResults,
      total: finalResults.length,
      threshold: threshold,
    };

    if (semanticExpansionInfo) {
      responseData.query_expansion = semanticExpansionInfo;
    }

    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    if (entityRescueInfo) {
      responseData.entity_rescue = entityRescueInfo;
    }

    if (semanticDeduplicationInfo) {
      responseData.deduplication = semanticDeduplicationInfo;
    }

    if (input.entity_filter) {
      appendEntityFilterResponse(responseData, kgMetricsSemantic, input.entity_filter, documentFilter, semanticFreqBoostInfo);
    } else if (semanticFreqBoostInfo) {
      responseData.frequency_boost = semanticFreqBoostInfo;
      kgMetricsSemantic.frequency_boost_results_boosted = semanticFreqBoostInfo.boosted_results;
    }

    if (input.include_entities && entityMap && entityMap.size > 0) {
      responseData.cross_document_entities = buildCrossDocumentEntitySummary(entityMap);
    }

    if (finalResults.length === 0) {
      appendDidYouMean(responseData, kgMetricsSemantic, input.query, conn);
    }
    responseData.kg_integration_metrics = kgMetricsSemantic;

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

    const kgMetricsBm25 = createKGMetrics();

    // Resolve metadata filter to document IDs, then chain through quality filter
    let documentFilter = resolveQualityFilter(db, input.min_quality_score,
      resolveMetadataFilter(db, input.metadata_filter, input.document_filter));

    // Entity filter: resolve entity names/types to document IDs
    const bm25EntityFilterResult = resolveEntityFilter(conn, input.entity_filter, documentFilter, input.time_range);
    if (bm25EntityFilterResult.empty) {
      return formatResponse(successResult({
        query: input.query,
        search_type: 'bm25',
        results: [],
        total: 0,
        sources: { chunk_count: 0, vlm_count: 0, extraction_count: 0 },
        entity_filter_applied: true,
        entity_filter_document_count: 0,
        related_entities_included: input.entity_filter?.include_related ?? false,
      }));
    }
    documentFilter = bm25EntityFilterResult.documentFilter;
    if (input.entity_filter) {
      kgMetricsBm25.entity_filter_applied = true;
      kgMetricsBm25.entity_filter_documents_matched = documentFilter?.length ?? 0;
    }

    const bm25Query = input.expand_query ? expandQueryWithKG(input.query, conn) : input.query;
    const expansionInfo = input.expand_query ? getExpandedTerms(input.query) : undefined;
    if (expansionInfo && expansionInfo.expanded) {
      kgMetricsBm25.expand_query_terms_added = expansionInfo.expanded.length;
    }

    const bm25 = new BM25SearchService(conn);
    const limit = input.limit ?? 10;

    // Over-fetch from both sources (limit * 2) since we merge and truncate
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

    // Search extractions FTS
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
        bm25EntityMap = getEntitiesForChunks(conn, chunkIds, input.min_entity_confidence);
      }
      // Enrich VLM/image results with page co-occurrence entities
      if (!bm25EntityMap) bm25EntityMap = new Map();
      enrichEntityMapWithPageEntities(conn, bm25EntityMap, rankedResults);
    }

    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && rankedResults.length > 0) {
      const entityContextForRerank = bm25EntityMap ? buildEntityContextForRerank(rankedResults, bm25EntityMap) : undefined;
      const edgeContextForRerank = bm25EntityMap ? buildEdgeContext(conn, bm25EntityMap) : undefined;

      const rerankInput = rankedResults.map(r => ({ ...r }));
      const reranked = await rerankResults(input.query, rerankInput, limit, entityContextForRerank, edgeContextForRerank);
      finalResults = reranked.map(r => {
        const original = rankedResults[r.original_index];
        const base: Record<string, unknown> = {
          ...original,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        attachProvenanceAndEntities(base, db, original.provenance_id, !!input.include_provenance, !!input.include_entities, bm25EntityMap, original.chunk_id, original.image_id, 'provenance_chain');
        return base;
      });
      rerankInfo = buildRerankInfo(entityContextForRerank, edgeContextForRerank, rankedResults.length, finalResults.length);
      kgMetricsBm25.rerank_entity_aware = !!(entityContextForRerank && entityContextForRerank.size > 0);
    } else {
      finalResults = rankedResults.map(r => {
        const base: Record<string, unknown> = { ...r };
        attachProvenanceAndEntities(base, db, r.provenance_id, !!input.include_provenance, !!input.include_entities, bm25EntityMap, r.chunk_id, r.image_id, 'provenance_chain');
        return base;
      });
    }

    // Deduplicate by primary entity
    let bm25DeduplicationInfo: { removed_count: number } | undefined;
    if (input.deduplicate_by_entity && bm25EntityMap && bm25EntityMap.size > 0) {
      const deduped = deduplicateByPrimaryEntity(finalResults, bm25EntityMap);
      finalResults = deduped.results;
      if (deduped.removed_count > 0) {
        bm25DeduplicationInfo = { removed_count: deduped.removed_count };
        kgMetricsBm25.deduplication_removed = deduped.removed_count;
      }
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

    // Apply entity mention frequency boost
    const bm25FreqBoostInfo = input.entity_filter
      ? applyEntityFrequencyBoost(finalResults, 'bm25_score', conn, input.entity_filter)
      : applyQueryDerivedFrequencyBoost(finalResults, 'bm25_score', conn, input.query);

    // Re-sort after frequency boost may have changed scores
    if (bm25FreqBoostInfo) {
      finalResults.sort((a, b) => (b.bm25_score as number) - (a.bm25_score as number));
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

    if (bm25DeduplicationInfo) {
      responseData.deduplication = bm25DeduplicationInfo;
    }

    if (input.entity_filter) {
      appendEntityFilterResponse(responseData, kgMetricsBm25, input.entity_filter, documentFilter, bm25FreqBoostInfo);
    } else if (bm25FreqBoostInfo) {
      responseData.frequency_boost = bm25FreqBoostInfo;
      kgMetricsBm25.frequency_boost_results_boosted = bm25FreqBoostInfo.boosted_results;
    }

    if (input.include_entities && bm25EntityMap && bm25EntityMap.size > 0) {
      responseData.cross_document_entities = buildCrossDocumentEntitySummary(bm25EntityMap);
    }

    if (finalResults.length === 0) {
      appendDidYouMean(responseData, kgMetricsBm25, input.query, conn);
    }
    responseData.kg_integration_metrics = kgMetricsBm25;

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

    const kgMetricsHybrid = createKGMetrics();

    // Resolve metadata filter to document IDs, then chain through quality filter
    let documentFilter = resolveQualityFilter(db, input.min_quality_score,
      resolveMetadataFilter(db, input.metadata_filter, input.document_filter));

    // Entity filter: resolve entity names/types to document IDs
    const hybridEntityFilterResult = resolveEntityFilter(conn, input.entity_filter, documentFilter, input.time_range);
    if (hybridEntityFilterResult.empty) {
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
        related_entities_included: input.entity_filter?.include_related ?? false,
      }));
    }
    documentFilter = hybridEntityFilterResult.documentFilter;
    if (input.entity_filter) {
      kgMetricsHybrid.entity_filter_applied = true;
      kgMetricsHybrid.entity_filter_documents_matched = documentFilter?.length ?? 0;
    }

    // Expand with co-mentioned entities for hybrid (broadest expansion -- RRF de-ranks noise)
    const bm25Query = input.expand_query ? expandQueryWithCoMentioned(input.query, conn) : input.query;
    const expansionInfo = input.expand_query ? getExpandedTerms(input.query) : undefined;
    if (expansionInfo && expansionInfo.expanded) {
      kgMetricsHybrid.expand_query_terms_added = expansionInfo.expanded.length;
    }

    // Get BM25 results (chunks + VLM + extractions)
    const bm25 = new BM25SearchService(db.getConnection());
    // includeHighlight: false -- hybrid discards BM25 highlights (RRF doesn't surface snippets)
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
      // Lower threshold than standalone (0.7) -- RRF de-ranks low-quality results
      threshold: 0.3,
      documentFilter,
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

    // Apply entity_boost to RRF scores if requested
    const entityBoostFactor = input.entity_boost ?? 0;
    let entityBoostInfo: { boosted_results: number; matching_nodes: number } | undefined;
    if (entityBoostFactor > 0 && rawResults.length > 0) {
      try {
        // Find KG nodes matching query terms
        const matchedNodeIds = findMatchingNodeIds(input.query, conn);
        if (matchedNodeIds.length > 0) {
          // Get entities for all result chunks
          const boostChunkIds = rawResults.map(r => r.chunk_id).filter((id): id is string => id != null);
          if (boostChunkIds.length > 0) {
            const boostEntityMap = getEntitiesForChunks(conn, boostChunkIds, input.min_entity_confidence);
            const matchedNodeSet = new Set(matchedNodeIds);
            let boostedCount = 0;

            for (const r of rawResults) {
              let entities = r.chunk_id ? boostEntityMap.get(r.chunk_id) : undefined;

              // For VLM results without chunk_id, find entities via page co-occurrence
              if (!entities && r.image_id && r.document_id) {
                const pageChunks = conn.prepare(
                  'SELECT id FROM chunks WHERE document_id = ? AND page_number = ?'
                ).all(r.document_id, r.page_number) as Array<{id: string}>;
                for (const pc of pageChunks) {
                  const chunkEntities = boostEntityMap.get(pc.id);
                  if (chunkEntities && chunkEntities.length > 0) {
                    entities = chunkEntities;
                    break;
                  }
                }
              }

              if (!entities || entities.length === 0) continue;

              const matchedCount = entities.filter(e => matchedNodeSet.has(e.node_id)).length;
              if (matchedCount > 0) {
                const boost = entityBoostFactor * (matchedCount / entities.length);
                r.rrf_score += boost;
                boostedCount++;
              }
            }

            if (boostedCount > 0) {
              // Re-sort by boosted rrf_score
              rawResults.sort((a, b) => b.rrf_score - a.rrf_score);
              entityBoostInfo = { boosted_results: boostedCount, matching_nodes: matchedNodeIds.length };
              kgMetricsHybrid.entity_boost_results_boosted = boostedCount;
            }
          }
        }
      } catch (error) {
        console.error(`[WARN] Entity boost failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Entity enrichment: collect chunk IDs and fetch entities
    let hybridEntityMap: Map<string, ChunkEntityInfo[]> | undefined;
    if (input.include_entities || input.rerank) {
      const chunkIds = rawResults.map(r => r.chunk_id).filter((id): id is string => id != null);
      if (chunkIds.length > 0) {
        hybridEntityMap = getEntitiesForChunks(conn, chunkIds, input.min_entity_confidence);
      }
      // Enrich VLM/image results with page co-occurrence entities
      if (!hybridEntityMap) hybridEntityMap = new Map();
      enrichEntityMapWithPageEntities(conn, hybridEntityMap, rawResults);
    }

    let finalResults: Array<Record<string, unknown>>;
    let rerankInfo: Record<string, unknown> | undefined;

    if (input.rerank && rawResults.length > 0) {
      const entityContextForRerank = hybridEntityMap ? buildEntityContextForRerank(rawResults, hybridEntityMap) : undefined;
      const edgeContextForRerank = hybridEntityMap ? buildEdgeContext(conn, hybridEntityMap) : undefined;

      const rerankInput = rawResults.map(r => ({ ...r }));
      const reranked = await rerankResults(input.query, rerankInput, limit, entityContextForRerank, edgeContextForRerank);
      finalResults = reranked.map(r => {
        const original = rawResults[r.original_index];
        const base: Record<string, unknown> = {
          ...original,
          rerank_score: r.relevance_score,
          rerank_reasoning: r.reasoning,
        };
        attachProvenanceAndEntities(base, db, original.provenance_id, !!input.include_provenance, !!input.include_entities, hybridEntityMap, original.chunk_id, original.image_id, 'provenance_chain');
        return base;
      });
      rerankInfo = buildRerankInfo(entityContextForRerank, edgeContextForRerank, rawResults.length, finalResults.length);
      kgMetricsHybrid.rerank_entity_aware = !!(entityContextForRerank && entityContextForRerank.size > 0);
    } else {
      finalResults = rawResults.map(r => {
        const base: Record<string, unknown> = { ...r };
        attachProvenanceAndEntities(base, db, r.provenance_id, !!input.include_provenance, !!input.include_entities, hybridEntityMap, r.chunk_id, r.image_id, 'provenance_chain');
        return base;
      });
    }

    // Deduplicate by primary entity
    let hybridDeduplicationInfo: { removed_count: number } | undefined;
    if (input.deduplicate_by_entity && hybridEntityMap && hybridEntityMap.size > 0) {
      const deduped = deduplicateByPrimaryEntity(finalResults, hybridEntityMap);
      finalResults = deduped.results;
      if (deduped.removed_count > 0) {
        hybridDeduplicationInfo = { removed_count: deduped.removed_count };
        kgMetricsHybrid.deduplication_removed = deduped.removed_count;
      }
    }

    // F-15: Chunk proximity boost - reward clusters of nearby relevant chunks
    const chunkProximityInfo = finalResults.length > 0
      ? applyChunkProximityBoost(finalResults)
      : undefined;

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

    if (expansionInfo) {
      responseData.query_expansion = expansionInfo;
    }

    if (rerankInfo) {
      responseData.rerank = rerankInfo;
    }

    if (entityBoostInfo) {
      responseData.entity_boost = entityBoostInfo;
    }

    if (chunkProximityInfo) {
      responseData.chunk_proximity_boost = chunkProximityInfo;
    }

    if (hybridDeduplicationInfo) {
      responseData.deduplication = hybridDeduplicationInfo;
    }

    if (input.entity_filter) {
      const hybridFreqBoostInfo = applyEntityFrequencyBoost(
        finalResults, 'rrf_score', conn, input.entity_filter,
      );
      appendEntityFilterResponse(responseData, kgMetricsHybrid, input.entity_filter, documentFilter, hybridFreqBoostInfo);
    } else {
      const hybridQueryFreqBoostInfo = applyQueryDerivedFrequencyBoost(
        finalResults, 'rrf_score', conn, input.query,
      );
      if (hybridQueryFreqBoostInfo) {
        responseData.frequency_boost = hybridQueryFreqBoostInfo;
        kgMetricsHybrid.frequency_boost_results_boosted = hybridQueryFreqBoostInfo.boosted_results;
      }
    }

    // Re-sort after frequency boost may have changed rrf_scores
    finalResults.sort((a, b) => (b.rrf_score as number) - (a.rrf_score as number));

    if (input.include_entities && hybridEntityMap && hybridEntityMap.size > 0) {
      responseData.cross_document_entities = buildCrossDocumentEntitySummary(hybridEntityMap);
    }

    if (finalResults.length === 0) {
      appendDidYouMean(responseData, kgMetricsHybrid, input.query, conn);
    }
    responseData.kg_integration_metrics = kgMetricsHybrid;

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
// RAG CONTEXT ASSEMBLY HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * RAG Context Input schema - validated inline (not exported to validation.ts
 * since this is a self-contained tool with a unique schema).
 */
const RagContextInput = z.object({
  question: z.string().min(1).max(2000).describe('The question to build context for'),
  limit: z.number().int().min(1).max(20).default(5)
    .describe('Maximum search results to include in context'),
  include_entity_context: z.boolean().default(true)
    .describe('Include knowledge graph entity information'),
  include_kg_paths: z.boolean().default(true)
    .describe('Include knowledge graph relationship paths between mentioned entities'),
  document_filter: z.array(z.string()).optional()
    .describe('Restrict to specific documents'),
  max_context_length: z.number().int().min(500).max(50000).default(8000)
    .describe('Maximum total context length in characters'),
  include_relationship_summary: z.boolean().default(false)
    .describe('Include narrative summary of entity relationships'),
  min_entity_confidence: z.number().min(0).max(1).optional()
    .describe('Minimum entity confidence for included entities'),
});

/**
 * Handle ocr_rag_context - Assemble a RAG context block for LLM consumption.
 *
 * Runs hybrid search with query expansion + entity enrichment + KG path expansion,
 * then assembles a single markdown context block optimized for LLM consumption.
 *
 * Pipeline:
 * 1. Hybrid search (BM25 + semantic + RRF) with expand_query + include_entities
 * 2. Collect unique entity node_ids from search results
 * 3. Find KG paths between top entity pairs (up to 3 pairs)
 * 4. Assemble markdown: excerpts + entity context + relationships
 * 5. Truncate to max_context_length
 */
async function handleRagContext(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(RagContextInput, params);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();
    const limit = input.limit ?? 5;
    const maxContextLength = input.max_context_length ?? 8000;

    // ── Step 1: Run hybrid search (BM25 + semantic + RRF) ──────────────────
    // Expand BM25 query with KG co-mentioned entities for broader recall
    const bm25Query = expandQueryWithCoMentioned(input.question, conn);

    const bm25 = new BM25SearchService(conn);
    const fetchLimit = limit * 2;

    const bm25ChunkResults = bm25.search({
      query: bm25Query,
      limit: fetchLimit,
      documentFilter: input.document_filter,
      includeHighlight: false,
    });
    const bm25VlmResults = bm25.searchVLM({
      query: bm25Query,
      limit: fetchLimit,
      documentFilter: input.document_filter,
      includeHighlight: false,
    });
    const bm25ExtractionResults = bm25.searchExtractions({
      query: bm25Query,
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
      const emptyContext = '## Relevant Document Excerpts\n\nNo relevant documents found for the given question.';
      return formatResponse(successResult({
        question: input.question,
        context: emptyContext,
        context_length: emptyContext.length,
        search_results_used: 0,
        entities_found: 0,
        kg_paths_found: 0,
        sources: [],
      }));
    }

    // ── Step 2: Entity enrichment ──────────────────────────────────────────
    let entityMap: Map<string, ChunkEntityInfo[]> | undefined;
    if (input.include_entity_context || input.include_kg_paths) {
      const chunkIds = fusedResults
        .map(r => r.chunk_id)
        .filter((id): id is string => id != null);
      if (chunkIds.length > 0) {
        try {
          entityMap = getEntitiesForChunks(conn, chunkIds, input.min_entity_confidence);
        } catch (err) {
          console.error(`[RAG] Entity enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Enrich VLM/image results with page co-occurrence entities
      if (!entityMap) entityMap = new Map();
      enrichEntityMapWithPageEntities(conn, entityMap, fusedResults);
    }

    // Collect unique entities across all results
    const uniqueEntities = new Map<string, ChunkEntityInfo>();
    if (entityMap) {
      for (const entities of entityMap.values()) {
        for (const e of entities) {
          if (!uniqueEntities.has(e.node_id)) {
            uniqueEntities.set(e.node_id, e);
          }
        }
      }
    }

    // ── Step 3: KG path finding between top entities ───────────────────────
    interface RagPathEdge {
      source_name: string;
      target_name: string;
      relationship_type: string;
      weight: number;
    }
    const kgPaths: RagPathEdge[] = [];

    if (input.include_kg_paths && uniqueEntities.size >= 2) {
      // Pick top entities by document_count (most important)
      const topEntities = [...uniqueEntities.values()]
        .sort((a, b) => b.document_count - a.document_count)
        .slice(0, 4);

      // Generate pairs (up to 3)
      const pairs: Array<[ChunkEntityInfo, ChunkEntityInfo]> = [];
      for (let i = 0; i < topEntities.length && pairs.length < 3; i++) {
        for (let j = i + 1; j < topEntities.length && pairs.length < 3; j++) {
          pairs.push([topEntities[i], topEntities[j]]);
        }
      }

      for (const [source, target] of pairs) {
        try {
          const pathResult = findGraphPaths(db, source.node_id, target.node_id, {
            max_hops: 2,
          });
          // Extract edges from all found paths
          for (const p of pathResult.paths) {
            for (let edgeIdx = 0; edgeIdx < p.edges.length; edgeIdx++) {
              const edge = p.edges[edgeIdx];
              // Resolve source/target node names from the path nodes
              const srcNode = p.nodes[edgeIdx];
              const tgtNode = p.nodes[edgeIdx + 1];
              if (srcNode && tgtNode) {
                // Deduplicate edges by source+target+type
                const edgeKey = `${srcNode.canonical_name}|${edge.relationship_type}|${tgtNode.canonical_name}`;
                if (!kgPaths.some(e =>
                  `${e.source_name}|${e.relationship_type}|${e.target_name}` === edgeKey
                )) {
                  kgPaths.push({
                    source_name: srcNode.canonical_name,
                    target_name: tgtNode.canonical_name,
                    relationship_type: edge.relationship_type,
                    weight: edge.weight,
                  });
                }
              }
            }
          }
        } catch {
          // Entity not found in KG or no paths - skip gracefully
        }
      }
    }

    // ── Step 4: Assemble markdown context ──────────────────────────────────
    const contextParts: string[] = [];

    // Document excerpts
    contextParts.push('## Relevant Document Excerpts\n');
    const sources: Array<{ file_name: string; page_number: number | null; document_id: string }> = [];

    for (let i = 0; i < fusedResults.length; i++) {
      const r = fusedResults[i];
      const score = Math.round(r.rrf_score * 1000) / 1000;
      const fileName = r.source_file_name || path.basename(r.source_file_path || 'unknown');
      const pageInfo = r.page_number != null ? `, Page ${r.page_number}` : '';

      contextParts.push(`### Result ${i + 1} (Score: ${score})`);
      contextParts.push(`**Source:** ${fileName}${pageInfo}`);
      contextParts.push(`> ${r.original_text.replace(/\n/g, '\n> ')}\n`);

      sources.push({
        file_name: fileName,
        page_number: r.page_number,
        document_id: r.document_id,
      });
    }

    // Entity context
    if (input.include_entity_context && uniqueEntities.size > 0) {
      contextParts.push('## Entity Context');
      // Sort by document_count descending, cap at 15
      const sortedEntities = [...uniqueEntities.values()]
        .sort((a, b) => b.document_count - a.document_count)
        .slice(0, 15);

      for (const e of sortedEntities) {
        let line = `- **${e.canonical_name}** (${e.entity_type}, ${e.document_count} document${e.document_count !== 1 ? 's' : ''})`;
        if (e.aliases.length > 0) {
          line += ` - also known as: ${e.aliases.join(', ')}`;
        }
        contextParts.push(line);
      }
      contextParts.push('');
    }

    // Entity relationships
    if (kgPaths.length > 0) {
      contextParts.push('## Entity Relationships');
      // Sort by weight descending
      const sortedPaths = [...kgPaths].sort((a, b) => b.weight - a.weight);
      for (const edge of sortedPaths) {
        const weight = Math.round(edge.weight * 100) / 100;
        contextParts.push(`- ${edge.source_name} --[${edge.relationship_type}]--> ${edge.target_name} (weight: ${weight})`);
      }
      contextParts.push('');
    }

    // Generate entity relationship narrative summary
    if (input.include_relationship_summary && kgPaths.length > 0) {
      const remainingBudget = maxContextLength - contextParts.join('\n').length;
      if (remainingBudget > 200) {
        // Group edges by relationship type for narrative structure
        const edgesByType = new Map<string, RagPathEdge[]>();
        for (const edge of kgPaths) {
          const existing = edgesByType.get(edge.relationship_type) || [];
          existing.push(edge);
          edgesByType.set(edge.relationship_type, existing);
        }

        const narrativeParts: string[] = ['## Entity Relationship Summary\n'];

        for (const [relType, edges] of edgesByType) {
          const readableType = relType.replace(/_/g, ' ');
          if (edges.length === 1) {
            const e = edges[0];
            narrativeParts.push(`${e.source_name} is ${readableType} ${e.target_name}.`);
          } else {
            // Group by source entity
            const bySource = new Map<string, string[]>();
            for (const e of edges) {
              const targets = bySource.get(e.source_name) || [];
              targets.push(e.target_name);
              bySource.set(e.source_name, targets);
            }
            for (const [source, targets] of bySource) {
              if (targets.length === 1) {
                narrativeParts.push(`${source} is ${readableType} ${targets[0]}.`);
              } else {
                const allTargets = [...targets];
                const last = allTargets.pop()!;
                narrativeParts.push(`${source} is ${readableType} ${allTargets.join(', ')} and ${last}.`);
              }
            }
          }
        }

        const narrativeText = narrativeParts.join('\n');
        if (narrativeText.length <= remainingBudget) {
          contextParts.push(narrativeText);
        }
      }
    }

    // ── Step 5: Truncate to max_context_length ─────────────────────────────
    let assembledMarkdown = contextParts.join('\n');
    if (assembledMarkdown.length > maxContextLength) {
      assembledMarkdown = assembledMarkdown.slice(0, maxContextLength - 3) + '...';
    }

    // ── Step 6: Return structured response ─────────────────────────────────
    return formatResponse(successResult({
      question: input.question,
      context: assembledMarkdown,
      context_length: assembledMarkdown.length,
      search_results_used: fusedResults.length,
      entities_found: uniqueEntities.size,
      kg_paths_found: kgPaths.length,
      relationship_summary_included: input.include_relationship_summary && kgPaths.length > 0,
      sources,
    }));
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

    // Collect entity canonical names per database for cross-database overlap
    const dbEntitySets = new Map<string, Set<string>>();

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

        // Query KG metrics for this database
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

        // Collect entity canonical names for cross-database overlap
        try {
          const nodes = conn.prepare('SELECT canonical_name FROM knowledge_nodes').all() as Array<{ canonical_name: string }>;
          dbEntitySets.set(dbName, new Set(nodes.map(n => n.canonical_name.toLowerCase())));
        } catch {
          dbEntitySets.set(dbName, new Set());
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

    // Compute pairwise entity overlap between databases
    const entityOverlap: Record<string, unknown> = {};
    const dbNamesList = [...dbEntitySets.keys()];
    for (let i = 0; i < dbNamesList.length; i++) {
      for (let j = i + 1; j < dbNamesList.length; j++) {
        const setA = dbEntitySets.get(dbNamesList[i])!;
        const setB = dbEntitySets.get(dbNamesList[j])!;
        const shared = [...setA].filter(name => setB.has(name));
        const union = new Set([...setA, ...setB]);
        entityOverlap[`${dbNamesList[i]}_vs_${dbNamesList[j]}`] = {
          shared_count: shared.length,
          shared_entity_names: shared.slice(0, 20),
          db1_unique: setA.size - shared.length,
          db2_unique: setB.size - shared.length,
          jaccard_similarity: union.size > 0 ? Math.round((shared.length / union.size) * 1000) / 1000 : 0,
        };
      }
    }

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
      entity_overlap: entityOverlap,
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
    // Extract cross-document entity summary from search response
    const crossDocEntities = parsedResponse.data?.cross_document_entities || [];

    // Ensure output directory exists
    const outputDir = path.dirname(input.output_path);
    fs.mkdirSync(outputDir, { recursive: true });

    if (input.format === 'json') {
      // JSON export includes cross_document_entities alongside results
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
          if (input.include_entities && r.entities_mentioned) {
            row.entities_mentioned = r.entities_mentioned;
          }
          return row;
        }),
        cross_document_entities: crossDocEntities,
      };
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
      // Append cross-document entity summary to CSV
      if (crossDocEntities.length > 0) {
        csvLines.push('');
        csvLines.push('# Cross-Document Entity Summary');
        csvLines.push('entity_name,entity_type,mention_count,document_count');
        for (const e of crossDocEntities) {
          const rec = e as Record<string, unknown>;
          csvLines.push(`"${((rec.canonical_name as string) || '').replace(/"/g, '""')}",${rec.entity_type || ''},${rec.mentioned_in_results || 0},${rec.document_count || 0}`);
        }
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
      cross_document_entities_count: crossDocEntities.length,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RELATED DOCUMENTS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_related_documents - Find documents related by shared KG entities
 */
async function handleRelatedDocuments(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(z.object({
      document_id: z.string().min(1).describe('Document ID to find related documents for'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum related documents to return'),
      min_shared_entities: z.number().int().min(1).default(1).describe('Minimum shared entities to include document'),
    }), params);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify the document exists
    const doc = conn.prepare('SELECT id FROM documents WHERE id = ?').get(input.document_id) as { id: string } | undefined;
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    const results = getRelatedDocumentsByEntityOverlap(conn, input.document_id, {
      limit: input.limit,
      min_shared_entities: input.min_shared_entities,
    });

    return formatResponse(successResult({
      document_id: input.document_id,
      related_documents: results,
      total: results.length,
      limit: input.limit,
      min_shared_entities: input.min_shared_entities,
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
        include_related: z.boolean().default(false)
          .describe('Include documents from 1-hop related entities via KG edges'),
      }).optional().describe('Filter results by knowledge graph entities'),
      time_range: z.object({
        from: z.string().optional().describe('ISO date - only include results from entities active after this date'),
        to: z.string().optional().describe('ISO date - only include results from entities active before this date'),
      }).optional().describe('Temporal filter for entity relationships'),
      rerank: z.boolean().default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
      deduplicate_by_entity: z.boolean().default(false)
        .describe('Deduplicate results by primary entity (max 2 results per entity)'),
      min_entity_confidence: z.number().min(0).max(1).optional()
        .describe('Minimum entity confidence score (0-1) for including entities in results'),
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
      expand_query: z.boolean().default(false)
        .describe('Expand query with domain-specific legal/medical synonyms and knowledge graph aliases'),
      entity_filter: z.object({
        entity_names: z.array(z.string()).optional(),
        entity_types: z.array(z.string()).optional(),
        include_related: z.boolean().default(false)
          .describe('Include documents from 1-hop related entities via KG edges'),
      }).optional().describe('Filter results by knowledge graph entities'),
      time_range: z.object({
        from: z.string().optional().describe('ISO date - only include results from entities active after this date'),
        to: z.string().optional().describe('ISO date - only include results from entities active before this date'),
      }).optional().describe('Temporal filter for entity relationships'),
      rerank: z.boolean().default(false)
        .describe('Re-rank results using Gemini AI for contextual relevance scoring'),
      entity_rescue: z.boolean().default(false)
        .describe('Rescue borderline results (within 0.1 of threshold) if they contain entities matching query terms'),
      deduplicate_by_entity: z.boolean().default(false)
        .describe('Deduplicate results by primary entity (max 2 results per entity)'),
      min_entity_confidence: z.number().min(0).max(1).optional()
        .describe('Minimum entity confidence score (0-1) for including entities in results'),
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
        include_related: z.boolean().default(false)
          .describe('Include documents from 1-hop related entities via KG edges'),
      }).optional().describe('Filter results by knowledge graph entities'),
      time_range: z.object({
        from: z.string().optional().describe('ISO date - only include results from entities active after this date'),
        to: z.string().optional().describe('ISO date - only include results from entities active before this date'),
      }).optional().describe('Temporal filter for entity relationships'),
      entity_boost: z.number().min(0).max(2).default(0)
        .describe('Entity boost factor: results containing entities matching query terms get score boost in RRF fusion'),
      deduplicate_by_entity: z.boolean().default(false)
        .describe('Deduplicate results by primary entity (max 2 results per entity)'),
      min_entity_confidence: z.number().min(0).max(1).optional()
        .describe('Minimum entity confidence score (0-1) for including entities in results'),
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
  ocr_related_documents: {
    description: 'Find documents related to a given document by shared knowledge graph entities. Returns documents ranked by entity overlap with shared entity details and edge weights.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to find related documents for'),
      limit: z.number().int().min(1).max(100).default(10)
        .describe('Maximum related documents to return'),
      min_shared_entities: z.number().int().min(1).default(1)
        .describe('Minimum shared entities to include document'),
    },
    handler: handleRelatedDocuments,
  },
  ocr_rag_context: {
    description: 'Assemble a RAG (Retrieval-Augmented Generation) context block for LLM consumption. Runs hybrid search + entity enrichment + KG path expansion and returns a single markdown context block.',
    inputSchema: {
      question: z.string().min(1).max(2000).describe('The question to build context for'),
      limit: z.number().int().min(1).max(20).default(5)
        .describe('Maximum search results to include in context'),
      include_entity_context: z.boolean().default(true)
        .describe('Include knowledge graph entity information'),
      include_kg_paths: z.boolean().default(true)
        .describe('Include knowledge graph relationship paths between mentioned entities'),
      document_filter: z.array(z.string()).optional()
        .describe('Restrict to specific documents'),
      max_context_length: z.number().int().min(500).max(50000).default(8000)
        .describe('Maximum total context length in characters'),
      include_relationship_summary: z.boolean().default(false)
        .describe('Include AI-generated narrative summary of entity relationships'),
      min_entity_confidence: z.number().min(0).max(1).optional()
        .describe('Minimum entity confidence for included entities'),
    },
    handler: handleRagContext,
  },
};
