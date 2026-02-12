/**
 * Knowledge Graph Service - Orchestration layer
 *
 * Ties together entity resolution, co-occurrence analysis, and graph storage
 * to build and query knowledge graphs across documents.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module services/knowledge-graph/graph-service
 */

import { DatabaseService } from '../storage/database/index.js';
import type { Entity, EntityMention } from '../../models/entity.js';
import {
  RELATIONSHIP_TYPES,
  type KnowledgeNode,
  type KnowledgeEdge,
  type RelationshipType,
} from '../../models/knowledge-graph.js';
import { ProvenanceType } from '../../models/provenance.js';
import { getProvenanceTracker } from '../provenance/tracker.js';
import { resolveEntities, type ResolutionMode, type ClusterContext } from './resolution-service.js';
import { classifyByRules, classifyByExtractionSchema, classifyByClusterHint } from './rule-classifier.js';
import { v4 as uuidv4 } from 'uuid';
import { computeHash } from '../../utils/hash.js';
import {
  insertKnowledgeNode,
  insertKnowledgeEdge,
  insertNodeEntityLink,
  findEdge,
  updateKnowledgeEdge,
  deleteAllGraphData,
  deleteGraphDataForDocuments,
  getGraphStats as getGraphStatsFromDb,
  listKnowledgeNodes,
  getEdgesForNode,
  getKnowledgeNode,
  getLinksForNode,
  findPaths as findPathsFromDb,
  countKnowledgeNodes,
  searchKnowledgeNodesFTS,
  getEvidenceChunksForEdge,
} from '../storage/database/knowledge-graph-operations.js';
import {
  getEntitiesByDocument,
  getEntityMentions,
} from '../storage/database/entity-operations.js';
import { GeminiClient } from '../gemini/client.js';

// ============================================================
// Types
// ============================================================

/** Maximum entities per document for co-occurrence to avoid O(n^2) blowup */
const MAX_COOCCURRENCE_ENTITIES = 200;

interface BuildGraphOptions {
  document_filter?: string[];
  resolution_mode?: ResolutionMode;
  classify_relationships?: boolean;
  rebuild?: boolean;
}

interface BuildGraphResult {
  total_nodes: number;
  total_edges: number;
  entities_resolved: number;
  cross_document_nodes: number;
  single_document_nodes: number;
  relationship_types: Record<string, number>;
  documents_covered: number;
  resolution_mode: string;
  provenance_id: string;
  processing_duration_ms: number;
}

interface QueryGraphOptions {
  entity_name?: string;
  entity_type?: string;
  document_filter?: string[];
  min_document_count?: number;
  include_edges?: boolean;
  include_documents?: boolean;
  max_depth?: number;
  limit?: number;
}

interface QueryGraphResult {
  query: Record<string, unknown>;
  total_nodes: number;
  total_edges: number;
  nodes: Array<{
    id: string;
    entity_type: string;
    canonical_name: string;
    aliases: string[];
    document_count: number;
    mention_count: number;
    avg_confidence: number;
    documents?: Array<{ id: string; file_name: string }>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    relationship_type: string;
    weight: number;
    evidence_count: number;
    document_ids: string[];
  }>;
}

interface NodeDetailsResult {
  node: KnowledgeNode;
  member_entities: Array<{
    entity_id: string;
    document_id: string;
    document_name: string;
    raw_text: string;
    confidence: number;
    similarity_score: number;
    mentions?: EntityMention[];
  }>;
  edges: Array<{
    id: string;
    relationship_type: string;
    weight: number;
    evidence_count: number;
    connected_node: { id: string; entity_type: string; canonical_name: string };
  }>;
  provenance?: unknown;
}

interface EvidenceChunk {
  chunk_id: string;
  document_id: string;
  text_excerpt: string;
  page_number: number | null;
  source_file: string;
}

interface PathResult {
  source: { id: string; canonical_name: string; entity_type: string };
  target: { id: string; canonical_name: string; entity_type: string };
  paths: Array<{
    length: number;
    nodes: Array<{ id: string; canonical_name: string; entity_type: string }>;
    edges: Array<{
      id: string;
      relationship_type: string;
      weight: number;
      evidence_chunks?: EvidenceChunk[];
    }>;
  }>;
  total_paths: number;
}

// ============================================================
// buildKnowledgeGraph - Main orchestrator
// ============================================================

/**
 * Build a knowledge graph from entities extracted across documents.
 *
 * Steps:
 * 1. Collect entities from target documents
 * 2. Resolve entities into unified nodes (exact/fuzzy/AI)
 * 3. Store nodes and entity links
 * 4. Build co-occurrence edges from shared documents and chunks
 * 5. Optionally classify relationships with Gemini
 *
 * @param db - DatabaseService instance
 * @param options - Build options
 * @returns Build result with statistics
 * @throws Error if no entities found or graph already exists without rebuild
 */
export async function buildKnowledgeGraph(
  db: DatabaseService,
  options: BuildGraphOptions,
): Promise<BuildGraphResult> {
  const startTime = Date.now();
  const conn = db.getConnection();
  const resolutionMode = options.resolution_mode ?? 'fuzzy';
  const classifyRelationships = options.classify_relationships ?? false;
  const rebuild = options.rebuild ?? false;

  // Step 1: Handle rebuild vs existing graph
  if (rebuild) {
    if (options.document_filter && options.document_filter.length > 0) {
      deleteGraphDataForDocuments(conn, options.document_filter);
    } else {
      deleteAllGraphData(conn);
    }
  } else {
    const existingCount = countKnowledgeNodes(conn);
    if (existingCount > 0) {
      throw new Error(
        'Graph already exists. Use rebuild: true to overwrite.',
      );
    }
  }

  // Step 2: Collect entities from target documents
  let documentIds: string[];
  if (options.document_filter && options.document_filter.length > 0) {
    documentIds = options.document_filter;
  } else {
    const rows = conn.prepare(
      'SELECT DISTINCT document_id FROM entities',
    ).all() as { document_id: string }[];
    documentIds = rows.map(r => r.document_id);
  }

  if (documentIds.length === 0) {
    throw new Error('No entities found. Run ocr_entity_extract first.');
  }

  const allEntities: Entity[] = [];
  for (const docId of documentIds) {
    const docEntities = getEntitiesByDocument(conn, docId);
    allEntities.push(...docEntities);
  }

  if (allEntities.length === 0) {
    throw new Error('No entities found. Run ocr_entity_extract first.');
  }

  // Step 3: Create provenance record
  const tracker = getProvenanceTracker(db);

  // Find the first document's OCR_RESULT provenance to use as parent
  const firstDoc = db.getDocument(documentIds[0]);
  const sourceProvId = firstDoc?.provenance_id ?? null;

  // Content hash = sha256 of sorted entity IDs
  const sortedEntityIds = allEntities.map(e => e.id).sort();
  const contentHash = computeHash(JSON.stringify(sortedEntityIds));

  const provenanceId = tracker.createProvenance({
    type: ProvenanceType.KNOWLEDGE_GRAPH,
    source_type: 'KNOWLEDGE_GRAPH',
    source_id: sourceProvId,
    root_document_id: firstDoc?.provenance_id ?? documentIds[0],
    content_hash: contentHash,
    input_hash: computeHash(JSON.stringify({
      resolution_mode: resolutionMode,
      document_count: documentIds.length,
      entity_count: allEntities.length,
    })),
    processor: 'knowledge-graph-builder',
    processor_version: '1.0.0',
    processing_params: {
      resolution_mode: resolutionMode,
      classify_relationships: classifyRelationships,
      document_count: documentIds.length,
      entity_count: allEntities.length,
    },
  });

  // Step 4: Build cluster context for resolution boost
  const clusterContext: ClusterContext = { clusterMap: new Map() };
  try {
    const clusterPlaceholders = documentIds.map(() => '?').join(',');
    const clusterRows = conn.prepare(`
      SELECT document_id, cluster_id FROM document_clusters WHERE document_id IN (${clusterPlaceholders})
    `).all(...documentIds) as Array<{ document_id: string; cluster_id: string }>;
    for (const row of clusterRows) {
      clusterContext.clusterMap.set(row.document_id, row.cluster_id);
    }
  } catch {
    // Cluster tables may not exist in older schemas - skip
  }

  // Step 5: Resolve entities into nodes
  const resolutionResult = await resolveEntities(
    allEntities,
    resolutionMode,
    provenanceId,
    undefined, // geminiClassifier
    clusterContext,
  );

  // Step 5: Store nodes and links with per-node provenance (P1.1)
  for (const node of resolutionResult.nodes) {
    insertKnowledgeNode(conn, node);

    // Count entity links for this node
    const nodeLinks = resolutionResult.links.filter(l => l.node_id === node.id);
    const resolutionAlgorithm = nodeLinks.length > 0 && nodeLinks[0].resolution_method
      ? nodeLinks[0].resolution_method
      : 'exact';

    tracker.createProvenance({
      type: ProvenanceType.KNOWLEDGE_GRAPH,
      source_type: 'KNOWLEDGE_GRAPH',
      source_id: provenanceId,
      root_document_id: firstDoc?.provenance_id ?? documentIds[0],
      content_hash: computeHash(JSON.stringify({ node_id: node.id, canonical_name: node.canonical_name })),
      input_hash: computeHash(JSON.stringify({ entity_count: nodeLinks.length })),
      processor: 'entity-resolution',
      processor_version: '1.0.0',
      processing_params: {
        resolution_mode: resolutionMode,
        matched_by: resolutionAlgorithm,
        node_id: node.id,
      },
    });
  }

  for (const link of resolutionResult.links) {
    insertNodeEntityLink(conn, link);
  }

  // Step 6: Build co-occurrence edges
  buildCoOccurrenceEdges(db, resolutionResult.nodes, provenanceId);

  // Step 7: Optionally classify relationships (rule-based first, then Gemini)
  if (classifyRelationships) {
    // Collect co_located edges for classification
    const coLocatedEdges: KnowledgeEdge[] = [];
    for (const node of resolutionResult.nodes) {
      const nodeEdges = getEdgesForNode(conn, node.id, { relationship_type: 'co_located' });
      for (const edge of nodeEdges) {
        // Avoid duplicates (edges appear in both directions)
        if (!coLocatedEdges.some(e => e.id === edge.id)) {
          coLocatedEdges.push(edge);
        }
      }
    }

    if (coLocatedEdges.length > 0) {
      // P4.1: Apply rule-based classification BEFORE Gemini
      // Query cluster context for document-level hints
      const clusterTagMap = new Map<string, string | null>();
      try {
        const allDocIds = [...new Set(documentIds)];
        if (allDocIds.length > 0) {
          const placeholders = allDocIds.map(() => '?').join(',');
          const clusterRows = conn.prepare(
            `SELECT dc.document_id, c.classification_tag
             FROM document_clusters dc
             JOIN clusters c ON dc.cluster_id = c.id
             WHERE dc.document_id IN (${placeholders})`,
          ).all(...allDocIds) as { document_id: string; classification_tag: string | null }[];
          for (const row of clusterRows) {
            clusterTagMap.set(row.document_id, row.classification_tag);
          }
        }
      } catch {
        // Cluster tables may not exist in older schemas - skip
      }

      const unclassifiedEdges: KnowledgeEdge[] = [];

      for (const edge of coLocatedEdges) {
        const sourceNode = getKnowledgeNode(conn, edge.source_node_id);
        const targetNode = getKnowledgeNode(conn, edge.target_node_id);
        if (!sourceNode || !targetNode) {
          unclassifiedEdges.push(edge);
          continue;
        }

        const srcType = sourceNode.entity_type;
        const tgtType = targetNode.entity_type;

        // Try rule-based classification in priority order
        // (a) Extraction schema context
        let ruleResult = classifyByExtractionSchema(
          sourceNode.metadata, targetNode.metadata, srcType, tgtType,
        );
        let ruleType = 'extraction_schema';

        // (b) Cluster hint context
        if (!ruleResult) {
          // Find shared cluster tag between source and target documents
          const srcLinks = getLinksForNode(conn, sourceNode.id);
          const tgtLinks = getLinksForNode(conn, targetNode.id);
          const srcDocIds = new Set(srcLinks.map(l => l.document_id));
          let sharedClusterTag: string | null = null;
          for (const tgtLink of tgtLinks) {
            if (srcDocIds.has(tgtLink.document_id)) {
              const tag = clusterTagMap.get(tgtLink.document_id);
              if (tag) {
                sharedClusterTag = tag;
                break;
              }
            }
          }
          ruleResult = classifyByClusterHint(sharedClusterTag, srcType, tgtType);
          ruleType = 'cluster_hint';
        }

        // (c) Type-pair rule matrix
        if (!ruleResult) {
          ruleResult = classifyByRules(srcType, tgtType);
          ruleType = 'type_rule';
        }

        if (ruleResult) {
          // Apply rule-based classification
          const existingMeta = edge.metadata ? JSON.parse(edge.metadata) : {};
          updateKnowledgeEdge(conn, edge.id, {
            metadata: JSON.stringify({
              ...existingMeta,
              classified_by: 'rule',
              rule_type: ruleType,
              confidence: ruleResult.confidence,
              classification_history: [{
                original_type: 'co_located',
                classified_type: ruleResult.type,
                classified_by: 'rule',
                rule_type: ruleType,
                confidence: ruleResult.confidence,
                classified_at: new Date().toISOString(),
              }],
            }),
          });
          conn.prepare(
            'UPDATE knowledge_edges SET relationship_type = ? WHERE id = ?',
          ).run(ruleResult.type, edge.id);
        } else {
          unclassifiedEdges.push(edge);
        }
      }

      // P4.2: Only pass unclassified edges to Gemini
      if (unclassifiedEdges.length > 0) {
        if (process.env.GEMINI_API_KEY) {
          await classifyRelationshipsWithGemini(db, unclassifiedEdges);
        } else {
          console.error('[KnowledgeGraph] classify_relationships=true but GEMINI_API_KEY not set, skipping AI classification');
        }
      }

      console.error(
        `[KnowledgeGraph] Classification: ${coLocatedEdges.length - unclassifiedEdges.length} rule-based, ${unclassifiedEdges.length} sent to Gemini`,
      );
    }
  }

  // Step 8: Gather stats and return result
  const processingDurationMs = Date.now() - startTime;
  const stats = getGraphStatsFromDb(conn);

  return {
    total_nodes: stats.total_nodes,
    total_edges: stats.total_edges,
    entities_resolved: allEntities.length,
    cross_document_nodes: resolutionResult.stats.cross_document_nodes,
    single_document_nodes: resolutionResult.stats.single_document_nodes,
    relationship_types: stats.edges_by_type,
    documents_covered: stats.documents_covered,
    resolution_mode: resolutionMode,
    provenance_id: provenanceId,
    processing_duration_ms: processingDurationMs,
  };
}

// ============================================================
// buildCoOccurrenceEdges - Deterministic edge creation
// ============================================================

/**
 * Build co-occurrence edges between nodes that share documents or chunks.
 *
 * For each pair of nodes:
 * - co_mentioned: share at least one document
 *   weight = shared_documents / max(doc_count_a, doc_count_b)
 * - co_located: share at least one chunk (higher weight, 1.5x boost)
 *
 * Direction convention: sort node IDs alphabetically, lower = source.
 * Cap at MAX_COOCCURRENCE_ENTITIES per document to avoid O(n^2) blowup.
 *
 * @param db - DatabaseService instance
 * @param nodes - Resolved knowledge nodes
 * @param provenanceId - Provenance record ID for edge creation
 * @returns Number of edges created
 */
function buildCoOccurrenceEdges(
  db: DatabaseService,
  nodes: KnowledgeNode[],
  provenanceId: string,
): number {
  const conn = db.getConnection();
  const now = new Date().toISOString();
  let edgeCount = 0;

  if (nodes.length < 2) {
    return 0;
  }

  // Build a map of node ID -> set of document IDs (via node_entity_links)
  const nodeDocMap = new Map<string, Set<string>>();
  // Build a map of node ID -> set of chunk IDs (via entity_mentions)
  const nodeChunkMap = new Map<string, Set<string>>();

  for (const node of nodes) {
    const links = getLinksForNode(conn, node.id);
    const docSet = new Set<string>();
    const chunkSet = new Set<string>();

    for (const link of links) {
      docSet.add(link.document_id);

      // Get entity mentions to find chunk_ids
      const mentions = getEntityMentions(conn, link.entity_id);
      for (const mention of mentions) {
        if (mention.chunk_id) {
          chunkSet.add(mention.chunk_id);
        }
      }
    }

    nodeDocMap.set(node.id, docSet);
    nodeChunkMap.set(node.id, chunkSet);
  }

  // Build co_mentioned and co_located edges between node pairs
  // Cap at MAX_COOCCURRENCE_ENTITIES nodes to avoid O(n^2) blowup
  const nodeList = nodes.length > MAX_COOCCURRENCE_ENTITIES
    ? [...nodes].sort((a, b) => b.document_count - a.document_count).slice(0, MAX_COOCCURRENCE_ENTITIES)
    : [...nodes];

  if (nodes.length > MAX_COOCCURRENCE_ENTITIES) {
    console.error(
      `[KnowledgeGraph] Capping co-occurrence analysis to ${MAX_COOCCURRENCE_ENTITIES} nodes (had ${nodes.length})`,
    );
  }

  for (let i = 0; i < nodeList.length; i++) {
    const nodeA = nodeList[i];
    const docsA = nodeDocMap.get(nodeA.id)!;
    const chunksA = nodeChunkMap.get(nodeA.id)!;

    for (let j = i + 1; j < nodeList.length; j++) {
      const nodeB = nodeList[j];
      const docsB = nodeDocMap.get(nodeB.id)!;
      const chunksB = nodeChunkMap.get(nodeB.id)!;

      // Shared documents
      const sharedDocs: string[] = [];
      for (const docId of docsA) {
        if (docsB.has(docId)) {
          sharedDocs.push(docId);
        }
      }

      if (sharedDocs.length === 0) {
        continue;
      }

      // Direction convention: sort node IDs alphabetically
      const [sourceId, targetId] = nodeA.id < nodeB.id
        ? [nodeA.id, nodeB.id]
        : [nodeB.id, nodeA.id];

      // co_mentioned edge
      const maxDocCount = Math.max(docsA.size, docsB.size);
      const coMentionedWeight = maxDocCount > 0
        ? Math.round((sharedDocs.length / maxDocCount) * 10000) / 10000
        : 0;

      const existingCoMentioned = findEdge(conn, sourceId, targetId, 'co_mentioned');
      if (!existingCoMentioned) {
        const edge: KnowledgeEdge = {
          id: uuidv4(),
          source_node_id: sourceId,
          target_node_id: targetId,
          relationship_type: 'co_mentioned',
          weight: coMentionedWeight,
          evidence_count: sharedDocs.length,
          document_ids: JSON.stringify(sharedDocs),
          metadata: null,
          provenance_id: provenanceId,
          created_at: now,
        };
        insertKnowledgeEdge(conn, edge);
        edgeCount++;
      }

      // Check for shared chunks (co_located)
      const sharedChunks: string[] = [];
      for (const chunkId of chunksA) {
        if (chunksB.has(chunkId)) {
          sharedChunks.push(chunkId);
        }
      }

      if (sharedChunks.length > 0) {
        // co_located edge with 1.5x weight boost
        const baseWeight = maxDocCount > 0
          ? sharedDocs.length / maxDocCount
          : 0;
        const coLocatedWeight = Math.round(Math.min(baseWeight * 1.5, 1.0) * 10000) / 10000;

        const existingCoLocated = findEdge(conn, sourceId, targetId, 'co_located');
        if (!existingCoLocated) {
          const edge: KnowledgeEdge = {
            id: uuidv4(),
            source_node_id: sourceId,
            target_node_id: targetId,
            relationship_type: 'co_located',
            weight: coLocatedWeight,
            evidence_count: sharedChunks.length,
            document_ids: JSON.stringify(sharedDocs),
            metadata: JSON.stringify({ shared_chunk_ids: sharedChunks }),
            provenance_id: provenanceId,
            created_at: now,
          };
          insertKnowledgeEdge(conn, edge);
          edgeCount++;
        }
      }
    }
  }

  return edgeCount;
}

// ============================================================
// classifyRelationshipsWithGemini - Optional Gemini classification
// ============================================================

/**
 * Classify co_located edge relationships using Gemini AI.
 *
 * For each co_located edge, sends entity pair info to Gemini to determine
 * the specific relationship type. On failure, keeps the edge as co_located.
 *
 * @param db - DatabaseService instance
 * @param edges - Co-located edges to classify
 */
async function classifyRelationshipsWithGemini(
  db: DatabaseService,
  edges: KnowledgeEdge[],
): Promise<void> {
  const conn = db.getConnection();

  let client: GeminiClient;
  try {
    client = new GeminiClient();
  } catch (error) {
    console.error('[KnowledgeGraph] Failed to initialize Gemini client:', error);
    return;
  }

  for (const edge of edges) {
    try {
      const sourceNode = getKnowledgeNode(conn, edge.source_node_id);
      const targetNode = getKnowledgeNode(conn, edge.target_node_id);

      if (!sourceNode || !targetNode) {
        continue;
      }

      // Get chunk context from metadata
      let chunkContext = '';
      if (edge.metadata) {
        try {
          const meta = JSON.parse(edge.metadata) as { shared_chunk_ids?: string[] };
          if (meta.shared_chunk_ids && meta.shared_chunk_ids.length > 0) {
            // Get text from the first shared chunk
            const chunkRow = conn.prepare(
              'SELECT text FROM chunks WHERE id = ?',
            ).get(meta.shared_chunk_ids[0]) as { text: string } | undefined;
            if (chunkRow) {
              chunkContext = chunkRow.text.slice(0, 2000);
            }
          }
        } catch {
          // Ignore metadata parse errors
        }
      }

      const prompt = `Given two entities that co-occur in the same text, classify their relationship.

Entity A: "${sourceNode.canonical_name}" (type: ${sourceNode.entity_type})
Entity B: "${targetNode.canonical_name}" (type: ${targetNode.entity_type})

${chunkContext ? `Context: "${chunkContext}"` : ''}

Choose EXACTLY ONE relationship type from this list:
- works_at: person employed by/works at organization
- represents: person represents/is attorney for entity
- located_in: entity is located in a place
- filed_in: case filed in court/jurisdiction
- cites: document/case cites another
- references: entity references another entity
- party_to: person/org is party to a case
- related_to: general relationship (use only if no other type fits)
- co_located: entities merely co-occur without clear relationship

Respond with ONLY the relationship type, nothing else.`;

      const response = await client.fast(prompt);
      const classifiedType = response.text.trim().toLowerCase().replace(/[^a-z_]/g, '') as RelationshipType;

      // Validate the classified type against the canonical list
      if (RELATIONSHIP_TYPES.includes(classifiedType) && classifiedType !== 'co_located') {
        const existingMeta = edge.metadata ? JSON.parse(edge.metadata) : {};
        updateKnowledgeEdge(conn, edge.id, {
          metadata: JSON.stringify({
            ...existingMeta,
            classified_by: 'gemini',
            original_type: 'co_located',
            classification_history: [
              ...(existingMeta.classification_history ?? []),
              {
                original_type: 'co_located',
                classified_type: classifiedType,
                classified_by: 'gemini',
                model: 'gemini-2.5-flash',
                classified_at: new Date().toISOString(),
              },
            ],
          }),
        });
        // Update the relationship_type directly
        conn.prepare(
          'UPDATE knowledge_edges SET relationship_type = ? WHERE id = ?',
        ).run(classifiedType, edge.id);
      }
    } catch (error) {
      // On failure, keep the edge as co_located and store error info
      let existingMeta: Record<string, unknown> = {};
      if (edge.metadata) {
        try { existingMeta = JSON.parse(edge.metadata); } catch { /* malformed metadata */ }
      }
      updateKnowledgeEdge(conn, edge.id, {
        metadata: JSON.stringify({
          ...existingMeta,
          classification_failed: {
            error: error instanceof Error ? error.message : String(error),
            attempted_at: new Date().toISOString(),
          },
        }),
      });
      console.error(
        `[KnowledgeGraph] Failed to classify edge ${edge.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

// ============================================================
// queryGraph - Flexible graph query
// ============================================================

/**
 * Query the knowledge graph with flexible filters.
 *
 * Supports filtering by entity name, type, document, and minimum document count.
 * Optionally expands to neighboring nodes up to max_depth hops.
 *
 * @param db - DatabaseService instance
 * @param options - Query options
 * @returns Nodes and edges matching the query
 */
export function queryGraph(
  db: DatabaseService,
  options: QueryGraphOptions,
): QueryGraphResult {
  const conn = db.getConnection();
  const includeEdges = options.include_edges ?? true;
  const includeDocuments = options.include_documents ?? false;
  const maxDepth = Math.min(options.max_depth ?? 1, 3);
  const limit = Math.min(options.limit ?? 50, 200);

  // Step 1: Get initial nodes with filters
  const initialNodes = listKnowledgeNodes(conn, {
    entity_type: options.entity_type,
    entity_name: options.entity_name,
    min_document_count: options.min_document_count,
    document_filter: options.document_filter,
    limit,
  });

  // Step 2: Expand by following edges to neighboring nodes
  const nodeMap = new Map<string, KnowledgeNode>();
  for (const node of initialNodes) {
    nodeMap.set(node.id, node);
  }

  if (maxDepth > 1 && initialNodes.length > 0) {
    let frontier = new Set(initialNodes.map(n => n.id));

    for (let depth = 1; depth < maxDepth; depth++) {
      const nextFrontier = new Set<string>();

      for (const nodeId of frontier) {
        if (nodeMap.size >= limit) break;

        const edges = getEdgesForNode(conn, nodeId);
        for (const edge of edges) {
          const neighborId = edge.source_node_id === nodeId
            ? edge.target_node_id
            : edge.source_node_id;

          if (!nodeMap.has(neighborId) && nodeMap.size < limit) {
            const neighbor = getKnowledgeNode(conn, neighborId);
            if (neighbor) {
              nodeMap.set(neighborId, neighbor);
              nextFrontier.add(neighborId);
            }
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }
  }

  // Step 3: Collect all edges between result nodes
  const allEdges: KnowledgeEdge[] = [];
  const edgeIds = new Set<string>();

  if (includeEdges) {
    for (const nodeId of nodeMap.keys()) {
      const nodeEdges = getEdgesForNode(conn, nodeId);
      for (const edge of nodeEdges) {
        // Only include edges where both endpoints are in our result set
        if (
          !edgeIds.has(edge.id) &&
          nodeMap.has(edge.source_node_id) &&
          nodeMap.has(edge.target_node_id)
        ) {
          edgeIds.add(edge.id);
          allEdges.push(edge);
        }
      }
    }
  }

  // Step 4: Build output nodes
  const outputNodes = [];
  for (const node of nodeMap.values()) {
    const outputNode: QueryGraphResult['nodes'][0] = {
      id: node.id,
      entity_type: node.entity_type,
      canonical_name: node.canonical_name,
      aliases: parseJsonArray(node.aliases),
      document_count: node.document_count,
      mention_count: node.mention_count,
      avg_confidence: node.avg_confidence,
    };

    if (includeDocuments) {
      const links = getLinksForNode(conn, node.id);
      const docIds = [...new Set(links.map(l => l.document_id))];
      const documents: Array<{ id: string; file_name: string }> = [];
      for (const docId of docIds) {
        const doc = db.getDocument(docId);
        if (doc) {
          documents.push({ id: doc.id, file_name: doc.file_name });
        }
      }
      outputNode.documents = documents;
    }

    outputNodes.push(outputNode);
  }

  // Step 5: Build output edges
  const outputEdges = allEdges.map(edge => ({
    id: edge.id,
    source: edge.source_node_id,
    target: edge.target_node_id,
    relationship_type: edge.relationship_type,
    weight: edge.weight,
    evidence_count: edge.evidence_count,
    document_ids: parseJsonArray(edge.document_ids),
  }));

  return {
    query: {
      entity_name: options.entity_name ?? null,
      entity_type: options.entity_type ?? null,
      document_filter: options.document_filter ?? null,
      min_document_count: options.min_document_count ?? null,
      max_depth: maxDepth,
      limit,
    },
    total_nodes: outputNodes.length,
    total_edges: outputEdges.length,
    nodes: outputNodes,
    edges: outputEdges,
  };
}

// ============================================================
// getNodeDetails - Single node with relationships
// ============================================================

/**
 * Get detailed information about a knowledge graph node including
 * its member entities, edges, and optional provenance.
 *
 * @param db - DatabaseService instance
 * @param nodeId - Knowledge node ID
 * @param options - Include mentions, provenance
 * @returns Node details with member entities and edges
 * @throws Error if node not found
 */
export function getNodeDetails(
  db: DatabaseService,
  nodeId: string,
  options?: { include_mentions?: boolean; include_provenance?: boolean },
): NodeDetailsResult {
  const conn = db.getConnection();
  const includeMentions = options?.include_mentions ?? false;
  const includeProvenance = options?.include_provenance ?? false;

  const node = getKnowledgeNode(conn, nodeId);
  if (!node) {
    throw new Error(`Knowledge node not found: ${nodeId}`);
  }

  // Get member entities via node_entity_links
  const links = getLinksForNode(conn, node.id);
  const memberEntities: NodeDetailsResult['member_entities'] = [];

  for (const link of links) {
    // Get the entity details
    const entityRow = conn.prepare(
      'SELECT * FROM entities WHERE id = ?',
    ).get(link.entity_id) as Entity | undefined;

    if (!entityRow) continue;

    // Get document name
    const doc = db.getDocument(link.document_id);
    const documentName = doc?.file_name ?? 'unknown';

    const member: NodeDetailsResult['member_entities'][0] = {
      entity_id: entityRow.id,
      document_id: entityRow.document_id,
      document_name: documentName,
      raw_text: entityRow.raw_text,
      confidence: entityRow.confidence,
      similarity_score: link.similarity_score,
    };

    if (includeMentions) {
      const mentions = getEntityMentions(conn, entityRow.id);
      member.mentions = mentions;
    }

    memberEntities.push(member);
  }

  // Get edges with connected node info
  const rawEdges = getEdgesForNode(conn, node.id);
  const edges: NodeDetailsResult['edges'] = [];

  for (const edge of rawEdges) {
    const connectedNodeId = edge.source_node_id === node.id
      ? edge.target_node_id
      : edge.source_node_id;

    const connectedNode = getKnowledgeNode(conn, connectedNodeId);
    if (!connectedNode) continue;

    edges.push({
      id: edge.id,
      relationship_type: edge.relationship_type,
      weight: edge.weight,
      evidence_count: edge.evidence_count,
      connected_node: {
        id: connectedNode.id,
        entity_type: connectedNode.entity_type,
        canonical_name: connectedNode.canonical_name,
      },
    });
  }

  // Optional provenance
  let provenance: unknown = undefined;
  if (includeProvenance) {
    try {
      const tracker = getProvenanceTracker(db);
      provenance = tracker.getProvenanceChain(node.provenance_id);
    } catch {
      // Ignore provenance errors, return without provenance
    }
  }

  return {
    node,
    member_entities: memberEntities,
    edges,
    provenance,
  };
}

// ============================================================
// findGraphPaths - BFS path finding wrapper
// ============================================================

/**
 * Find paths between two entities in the knowledge graph.
 *
 * Accepts node IDs or entity names (LIKE match).
 *
 * @param db - DatabaseService instance
 * @param sourceEntity - Node ID or entity name
 * @param targetEntity - Node ID or entity name
 * @param options - Max hops and relationship filter
 * @returns Path result with node and edge details
 * @throws Error if source or target not found
 */
export function findGraphPaths(
  db: DatabaseService,
  sourceEntity: string,
  targetEntity: string,
  options?: {
    max_hops?: number;
    relationship_filter?: string[];
    include_evidence_chunks?: boolean;
  },
): PathResult {
  const conn = db.getConnection();
  const includeEvidence = options?.include_evidence_chunks ?? false;

  // Resolve source node
  const sourceNode = resolveNodeReference(conn, sourceEntity);
  if (!sourceNode) {
    throw new Error(`Source entity not found: "${sourceEntity}"`);
  }

  // Resolve target node
  const targetNode = resolveNodeReference(conn, targetEntity);
  if (!targetNode) {
    throw new Error(`Target entity not found: "${targetEntity}"`);
  }

  // Find paths using BFS
  const rawPaths = findPathsFromDb(conn, sourceNode.id, targetNode.id, {
    max_hops: options?.max_hops,
    relationship_filter: options?.relationship_filter,
  });

  // Enrich paths with node/edge details
  const enrichedPaths: PathResult['paths'] = [];

  for (const rawPath of rawPaths) {
    const pathNodes: Array<{ id: string; canonical_name: string; entity_type: string }> = [];
    for (const nid of rawPath.node_ids) {
      const n = getKnowledgeNode(conn, nid);
      if (n) {
        pathNodes.push({
          id: n.id,
          canonical_name: n.canonical_name,
          entity_type: n.entity_type,
        });
      }
    }

    const pathEdges: PathResult['paths'][0]['edges'] = [];
    for (let i = 0; i < rawPath.edge_ids.length; i++) {
      const eid = rawPath.edge_ids[i];
      const row = conn.prepare(
        'SELECT id, relationship_type, weight, source_node_id, target_node_id FROM knowledge_edges WHERE id = ?',
      ).get(eid) as {
        id: string;
        relationship_type: string;
        weight: number;
        source_node_id: string;
        target_node_id: string;
      } | undefined;

      if (row) {
        const edgeEntry: PathResult['paths'][0]['edges'][0] = {
          id: row.id,
          relationship_type: row.relationship_type,
          weight: row.weight,
        };

        if (includeEvidence) {
          edgeEntry.evidence_chunks = getEvidenceChunksForEdge(
            conn,
            row.source_node_id,
            row.target_node_id,
            5,
          );
        }

        pathEdges.push(edgeEntry);
      }
    }

    enrichedPaths.push({
      length: rawPath.length,
      nodes: pathNodes,
      edges: pathEdges,
    });
  }

  return {
    source: {
      id: sourceNode.id,
      canonical_name: sourceNode.canonical_name,
      entity_type: sourceNode.entity_type,
    },
    target: {
      id: targetNode.id,
      canonical_name: targetNode.canonical_name,
      entity_type: targetNode.entity_type,
    },
    paths: enrichedPaths,
    total_paths: enrichedPaths.length,
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Resolve a node reference that can be either a UUID or an entity name.
 *
 * If the input looks like a UUID (contains hyphens and is 36 chars), looks up by ID.
 * Otherwise, searches using FTS5 first for performance, falling back to LIKE match.
 *
 * @param conn - Raw database connection
 * @param reference - Node ID or entity name
 * @returns Resolved node or null
 */
function resolveNodeReference(
  conn: ReturnType<DatabaseService['getConnection']>,
  reference: string,
): KnowledgeNode | null {
  // Check if it looks like a UUID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(reference)) {
    return getKnowledgeNode(conn, reference);
  }

  // Try FTS5 search first for performance
  const ftsResults = searchKnowledgeNodesFTS(conn, reference, 1);
  if (ftsResults.length > 0) {
    return getKnowledgeNode(conn, ftsResults[0].id);
  }

  // Fall back to LIKE match
  const nodes = listKnowledgeNodes(conn, {
    entity_name: reference,
    limit: 1,
  });
  return nodes.length > 0 ? nodes[0] : null;
}

/**
 * Parse a JSON string as an array, returning empty array on null/error.
 *
 * @param json - JSON string or null
 * @returns Parsed array or empty array
 */
function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
