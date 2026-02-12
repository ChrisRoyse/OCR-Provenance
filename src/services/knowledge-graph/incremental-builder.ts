/**
 * Incremental Knowledge Graph Builder
 *
 * Builds or updates the knowledge graph incrementally for new documents
 * without requiring a full rebuild. Matches new entities against existing
 * nodes using the same resolution pipeline.
 *
 * Algorithm:
 * 1. Verify entities exist for specified documents
 * 2. Collect entities for new documents only
 * 3. Fetch ALL existing knowledge_nodes from DB
 * 4. For each new entity, compute similarity against existing nodes
 * 5. If match found: insert node_entity_link, increment counts
 * 6. If no match: group remaining new entities, resolve among themselves
 * 7. Build co-occurrence edges for new documents' nodes only
 * 8. Update existing edge weights if new evidence found
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module services/knowledge-graph/incremental-builder
 */

import { DatabaseService } from '../storage/database/index.js';
import type { Entity, EntityType } from '../../models/entity.js';
import type { KnowledgeNode, KnowledgeEdge, NodeEntityLink } from '../../models/knowledge-graph.js';
import { ProvenanceType } from '../../models/provenance.js';
import { getProvenanceTracker } from '../provenance/tracker.js';
import {
  resolveEntities,
  computeTypeSimilarity,
  type ResolutionMode,
  type ClusterContext,
} from './resolution-service.js';
import { v4 as uuidv4 } from 'uuid';
import { computeHash } from '../../utils/hash.js';
import {
  insertKnowledgeNode,
  insertKnowledgeEdge,
  insertNodeEntityLink,
  getLinksForNode,
  getEdgesForNode,
  findEdge,
  updateKnowledgeEdge,
  updateKnowledgeNode,
  listKnowledgeNodes,
} from '../storage/database/knowledge-graph-operations.js';
import {
  getEntitiesByDocument,
  getEntityMentions,
} from '../storage/database/entity-operations.js';

// ============================================================
// Types
// ============================================================

/** Fuzzy merge threshold (same as resolution-service) */
const FUZZY_MERGE_THRESHOLD = 0.85;

/** Maximum entities per document for co-occurrence */
const MAX_COOCCURRENCE_ENTITIES = 200;

interface IncrementalBuildOptions {
  document_ids: string[];
  resolution_mode?: ResolutionMode;
  classify_relationships?: boolean;
}

interface IncrementalBuildResult {
  documents_processed: number;
  new_entities_found: number;
  entities_matched_to_existing: number;
  new_nodes_created: number;
  existing_nodes_updated: number;
  new_edges_created: number;
  existing_edges_updated: number;
  provenance_id: string;
  processing_duration_ms: number;
}

// ============================================================
// incrementalBuildGraph - Main entry point
// ============================================================

/**
 * Incrementally build/update the knowledge graph for new documents.
 *
 * Unlike buildKnowledgeGraph which rebuilds everything, this function:
 * - Only processes specified documents
 * - Matches new entities against existing graph nodes
 * - Creates new nodes only for truly novel entities
 * - Updates edge weights when new evidence is found
 *
 * @param db - DatabaseService instance
 * @param options - Incremental build options
 * @returns Build result with statistics
 * @throws Error if no entities found for specified documents
 */
export async function incrementalBuildGraph(
  db: DatabaseService,
  options: IncrementalBuildOptions,
): Promise<IncrementalBuildResult> {
  const startTime = Date.now();
  const conn = db.getConnection();
  const resolutionMode = options.resolution_mode ?? 'fuzzy';
  const documentIds = options.document_ids;

  if (documentIds.length === 0) {
    throw new Error('At least one document_id is required.');
  }

  // Step 1: Verify entities exist and are not already in graph
  const newEntities: Entity[] = [];
  const alreadyLinkedDocIds: string[] = [];

  for (const docId of documentIds) {
    const docEntities = getEntitiesByDocument(conn, docId);
    if (docEntities.length === 0) {
      throw new Error(
        `No entities found for document ${docId}. Run ocr_entity_extract first.`,
      );
    }

    // Check if any entities from this doc are already linked
    const existingLinks = conn
      .prepare(
        'SELECT COUNT(*) as cnt FROM node_entity_links WHERE document_id = ?',
      )
      .get(docId) as { cnt: number };

    if (existingLinks.cnt > 0) {
      alreadyLinkedDocIds.push(docId);
      continue;
    }

    newEntities.push(...docEntities);
  }

  if (alreadyLinkedDocIds.length > 0) {
    console.error(
      `[IncrementalBuilder] Skipping ${alreadyLinkedDocIds.length} document(s) already in graph: ${alreadyLinkedDocIds.join(', ')}`,
    );
  }

  if (newEntities.length === 0) {
    throw new Error(
      'All specified documents are already in the knowledge graph. Use rebuild: true on ocr_knowledge_graph_build to rebuild.',
    );
  }

  // Step 2: Create provenance record
  const tracker = getProvenanceTracker(db);
  const firstDoc = db.getDocument(documentIds[0]);
  const sourceProvId = firstDoc?.provenance_id ?? null;

  const sortedEntityIds = newEntities.map((e) => e.id).sort();
  const contentHash = computeHash(JSON.stringify(sortedEntityIds));

  const provenanceId = tracker.createProvenance({
    type: ProvenanceType.KNOWLEDGE_GRAPH,
    source_type: 'KNOWLEDGE_GRAPH',
    source_id: sourceProvId,
    root_document_id: firstDoc?.provenance_id ?? documentIds[0],
    content_hash: contentHash,
    input_hash: computeHash(
      JSON.stringify({
        resolution_mode: resolutionMode,
        document_count: documentIds.length,
        entity_count: newEntities.length,
        incremental: true,
      }),
    ),
    processor: 'incremental-graph-builder',
    processor_version: '1.0.0',
    processing_params: {
      resolution_mode: resolutionMode,
      document_count: documentIds.length,
      entity_count: newEntities.length,
      incremental: true,
    },
  });

  // Step 3: Fetch all existing knowledge nodes
  const existingNodes = listKnowledgeNodes(conn, { limit: 10000 });

  // Step 4: Build cluster context
  const clusterContext: ClusterContext = { clusterMap: new Map() };
  try {
    const clusterPlaceholders = documentIds.map(() => '?').join(',');
    const clusterRows = conn
      .prepare(
        `SELECT document_id, cluster_id FROM document_clusters WHERE document_id IN (${clusterPlaceholders})`,
      )
      .all(...documentIds) as Array<{
      document_id: string;
      cluster_id: string;
    }>;
    for (const row of clusterRows) {
      clusterContext.clusterMap.set(row.document_id, row.cluster_id);
    }
  } catch {
    // Cluster tables may not exist
  }

  // Step 5: Match new entities against existing nodes
  let entitiesMatchedToExisting = 0;
  let existingNodesUpdated = 0;
  const unmatchedEntities: Entity[] = [];
  const touchedNodeIds = new Set<string>();

  // Group entities by type for efficient matching
  const entitiesByType = new Map<EntityType, Entity[]>();
  for (const entity of newEntities) {
    if (!entitiesByType.has(entity.entity_type)) {
      entitiesByType.set(entity.entity_type, []);
    }
    entitiesByType.get(entity.entity_type)!.push(entity);
  }

  // Group existing nodes by type
  const existingNodesByType = new Map<string, KnowledgeNode[]>();
  for (const node of existingNodes) {
    if (!existingNodesByType.has(node.entity_type)) {
      existingNodesByType.set(node.entity_type, []);
    }
    existingNodesByType.get(node.entity_type)!.push(node);
  }

  for (const [entityType, entities] of entitiesByType) {
    const typeNodes = existingNodesByType.get(entityType) || [];

    for (const entity of entities) {
      let bestMatch: { node: KnowledgeNode; score: number } | null = null;

      // Check exact match first (fast path)
      for (const node of typeNodes) {
        if (node.normalized_name === entity.normalized_text) {
          bestMatch = { node, score: 1.0 };
          break;
        }
      }

      // Fuzzy match if no exact match and mode supports it
      if (!bestMatch && resolutionMode !== 'exact') {
        for (const node of typeNodes) {
          // Create a proxy entity from the node for similarity comparison
          const proxyEntity: Entity = {
            id: node.id,
            document_id: '',
            entity_type: node.entity_type,
            raw_text: node.canonical_name,
            normalized_text: node.normalized_name,
            confidence: node.avg_confidence,
            metadata: null,
            provenance_id: node.provenance_id,
            created_at: node.created_at,
          };

          const score = computeTypeSimilarity(
            entity,
            proxyEntity,
            clusterContext,
          );
          if (score >= FUZZY_MERGE_THRESHOLD) {
            if (!bestMatch || score > bestMatch.score) {
              bestMatch = { node, score };
            }
          }
        }
      }

      if (bestMatch) {
        // Match found: link entity to existing node
        const now = new Date().toISOString();
        const link: NodeEntityLink = {
          id: uuidv4(),
          node_id: bestMatch.node.id,
          entity_id: entity.id,
          document_id: entity.document_id,
          similarity_score: bestMatch.score,
          resolution_method:
            bestMatch.score === 1.0 ? 'exact_incremental' : 'fuzzy_incremental',
          created_at: now,
        };
        insertNodeEntityLink(conn, link);

        // Update node counts
        const currentLinks = getLinksForNode(conn, bestMatch.node.id);
        const uniqueDocIds = new Set(currentLinks.map((l) => l.document_id));
        const newMentionCount = currentLinks.length;
        const newDocCount = uniqueDocIds.size;

        // Recalculate avg_confidence from all linked entities
        let totalConfidence = 0;
        let linkCount = 0;
        for (const l of currentLinks) {
          const linkedEntity = conn
            .prepare('SELECT confidence FROM entities WHERE id = ?')
            .get(l.entity_id) as { confidence: number } | undefined;
          if (linkedEntity) {
            totalConfidence += linkedEntity.confidence;
            linkCount++;
          }
        }
        const newAvgConfidence =
          linkCount > 0
            ? Math.round((totalConfidence / linkCount) * 10000) / 10000
            : bestMatch.node.avg_confidence;

        // Merge aliases
        const existingAliases: string[] = bestMatch.node.aliases
          ? JSON.parse(bestMatch.node.aliases)
          : [];
        if (
          entity.raw_text !== bestMatch.node.canonical_name &&
          !existingAliases.includes(entity.raw_text)
        ) {
          existingAliases.push(entity.raw_text);
        }

        updateKnowledgeNode(conn, bestMatch.node.id, {
          document_count: newDocCount,
          mention_count: newMentionCount,
          avg_confidence: newAvgConfidence,
          aliases:
            existingAliases.length > 0
              ? JSON.stringify(existingAliases)
              : null,
          updated_at: now,
        });

        if (!touchedNodeIds.has(bestMatch.node.id)) {
          touchedNodeIds.add(bestMatch.node.id);
          existingNodesUpdated++;
        }
        entitiesMatchedToExisting++;
      } else {
        unmatchedEntities.push(entity);
      }
    }
  }

  // Step 6: Resolve unmatched entities among themselves to create new nodes
  let newNodesCreated = 0;
  const newNodeIds: string[] = [];

  if (unmatchedEntities.length > 0) {
    const resolutionResult = await resolveEntities(
      unmatchedEntities,
      resolutionMode,
      provenanceId,
      undefined,
      clusterContext,
    );

    for (const node of resolutionResult.nodes) {
      insertKnowledgeNode(conn, node);
      newNodesCreated++;
      newNodeIds.push(node.id);
      touchedNodeIds.add(node.id);

      // Per-node provenance
      const nodeLinks = resolutionResult.links.filter(
        (l) => l.node_id === node.id,
      );
      const resolutionAlgorithm =
        nodeLinks.length > 0 && nodeLinks[0].resolution_method
          ? nodeLinks[0].resolution_method
          : 'exact';

      tracker.createProvenance({
        type: ProvenanceType.KNOWLEDGE_GRAPH,
        source_type: 'KNOWLEDGE_GRAPH',
        source_id: provenanceId,
        root_document_id: firstDoc?.provenance_id ?? documentIds[0],
        content_hash: computeHash(
          JSON.stringify({
            node_id: node.id,
            canonical_name: node.canonical_name,
          }),
        ),
        input_hash: computeHash(
          JSON.stringify({ entity_count: nodeLinks.length }),
        ),
        processor: 'entity-resolution-incremental',
        processor_version: '1.0.0',
        processing_params: {
          resolution_mode: resolutionMode,
          matched_by: resolutionAlgorithm,
          node_id: node.id,
          incremental: true,
        },
      });
    }

    for (const link of resolutionResult.links) {
      insertNodeEntityLink(conn, link);
    }
  }

  // Step 7: Build co-occurrence edges for touched nodes
  const { newEdges, updatedEdges } = buildIncrementalEdges(
    db,
    touchedNodeIds,
    provenanceId,
  );

  const processingDurationMs = Date.now() - startTime;

  return {
    documents_processed:
      documentIds.length - alreadyLinkedDocIds.length,
    new_entities_found: newEntities.length,
    entities_matched_to_existing: entitiesMatchedToExisting,
    new_nodes_created: newNodesCreated,
    existing_nodes_updated: existingNodesUpdated,
    new_edges_created: newEdges,
    existing_edges_updated: updatedEdges,
    provenance_id: provenanceId,
    processing_duration_ms: processingDurationMs,
  };
}

// ============================================================
// buildIncrementalEdges - Edge creation/update for new docs
// ============================================================

/**
 * Build co-occurrence edges for touched nodes.
 *
 * For each pair of touched nodes (or a touched node + any connected node),
 * check if they share documents/chunks and create or update edges.
 *
 * @param db - DatabaseService
 * @param touchedNodeIds - Node IDs that were created or updated
 * @param provenanceId - Provenance ID for new edges
 * @returns Count of new and updated edges
 */
function buildIncrementalEdges(
  db: DatabaseService,
  touchedNodeIds: Set<string>,
  provenanceId: string,
): { newEdges: number; updatedEdges: number } {
  const conn = db.getConnection();
  const now = new Date().toISOString();
  let newEdges = 0;
  let updatedEdges = 0;

  if (touchedNodeIds.size < 1) {
    return { newEdges: 0, updatedEdges: 0 };
  }

  // Collect all node IDs we need to check (touched + their existing neighbors)
  const allRelevantNodeIds = new Set<string>(touchedNodeIds);
  for (const nodeId of touchedNodeIds) {
    const edges = getEdgesForNode(conn, nodeId);
    for (const edge of edges) {
      const neighborId =
        edge.source_node_id === nodeId
          ? edge.target_node_id
          : edge.source_node_id;
      allRelevantNodeIds.add(neighborId);
    }
  }

  // Build document/chunk maps for all relevant nodes
  const nodeDocMap = new Map<string, Set<string>>();
  const nodeChunkMap = new Map<string, Set<string>>();

  for (const nodeId of allRelevantNodeIds) {
    const links = getLinksForNode(conn, nodeId);
    const docSet = new Set<string>();
    const chunkSet = new Set<string>();

    for (const link of links) {
      docSet.add(link.document_id);
      const mentions = getEntityMentions(conn, link.entity_id);
      for (const mention of mentions) {
        if (mention.chunk_id) {
          chunkSet.add(mention.chunk_id);
        }
      }
    }

    nodeDocMap.set(nodeId, docSet);
    nodeChunkMap.set(nodeId, chunkSet);
  }

  // Detect single-document graph: skip co_mentioned edges when all nodes
  // share exactly one document (would create a useless complete graph)
  const allDocumentIds = new Set<string>();
  for (const docSet of nodeDocMap.values()) {
    for (const docId of docSet) {
      allDocumentIds.add(docId);
    }
  }
  const isSingleDocumentGraph = allDocumentIds.size === 1;
  if (isSingleDocumentGraph) {
    console.error(
      `[KnowledgeGraph] Single-document graph detected in incremental build. Skipping co_mentioned edges.`,
    );
  }

  // Only process pairs where at least one node is touched
  const touchedArr = [...touchedNodeIds];
  const allArr = [...allRelevantNodeIds];

  // Cap to avoid O(n^2) blowup
  const cappedTouched = touchedArr.slice(0, MAX_COOCCURRENCE_ENTITIES);

  const processedPairs = new Set<string>();

  for (const touchedId of cappedTouched) {
    const docsA = nodeDocMap.get(touchedId);
    const chunksA = nodeChunkMap.get(touchedId);
    if (!docsA || docsA.size === 0) continue;

    for (const otherId of allArr) {
      if (touchedId === otherId) continue;

      // Avoid processing same pair twice
      const pairKey =
        touchedId < otherId
          ? `${touchedId}:${otherId}`
          : `${otherId}:${touchedId}`;
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      const docsB = nodeDocMap.get(otherId);
      if (!docsB || docsB.size === 0) continue;

      // Find shared documents
      const sharedDocs: string[] = [];
      for (const docId of docsA) {
        if (docsB.has(docId)) {
          sharedDocs.push(docId);
        }
      }

      if (sharedDocs.length === 0) continue;

      // Direction convention: sort node IDs alphabetically
      const [sourceId, targetId] =
        touchedId < otherId
          ? [touchedId, otherId]
          : [otherId, touchedId];

      // co_mentioned edge — skip for single-document graphs (useless clique)
      const maxDocCount = Math.max(docsA.size, docsB.size);

      if (!isSingleDocumentGraph) {
        const coMentionedWeight =
          maxDocCount > 0
            ? Math.round((sharedDocs.length / maxDocCount) * 10000) / 10000
            : 0;

        const existingCoMentioned = findEdge(
          conn,
          sourceId,
          targetId,
          'co_mentioned',
        );
        if (existingCoMentioned) {
          // Update existing edge with new evidence
          const existingDocIds: string[] = JSON.parse(
            existingCoMentioned.document_ids || '[]',
          );
          const mergedDocIds = [
            ...new Set([...existingDocIds, ...sharedDocs]),
          ];
          updateKnowledgeEdge(conn, existingCoMentioned.id, {
            weight: coMentionedWeight,
            evidence_count: mergedDocIds.length,
            document_ids: JSON.stringify(mergedDocIds),
          });
          updatedEdges++;
        } else {
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
          newEdges++;
        }
      }

      // co_located edge (shared chunks)
      const chunksB = nodeChunkMap.get(otherId);
      if (chunksA && chunksB) {
        const sharedChunks: string[] = [];
        for (const chunkId of chunksA) {
          if (chunksB.has(chunkId)) {
            sharedChunks.push(chunkId);
          }
        }

        if (sharedChunks.length > 0) {
          const baseWeight =
            maxDocCount > 0 ? sharedDocs.length / maxDocCount : 0;
          const coLocatedWeight =
            Math.round(Math.min(baseWeight * 1.5, 1.0) * 10000) / 10000;

          const existingCoLocated = findEdge(
            conn,
            sourceId,
            targetId,
            'co_located',
          );
          if (existingCoLocated) {
            const existingMeta = existingCoLocated.metadata
              ? JSON.parse(existingCoLocated.metadata)
              : {};
            const existingChunks: string[] =
              existingMeta.shared_chunk_ids || [];
            const mergedChunks = [
              ...new Set([...existingChunks, ...sharedChunks]),
            ];

            const existingDocIds: string[] = JSON.parse(
              existingCoLocated.document_ids || '[]',
            );
            const mergedDocIds = [
              ...new Set([...existingDocIds, ...sharedDocs]),
            ];

            updateKnowledgeEdge(conn, existingCoLocated.id, {
              weight: coLocatedWeight,
              evidence_count: mergedChunks.length,
              document_ids: JSON.stringify(mergedDocIds),
              metadata: JSON.stringify({
                ...existingMeta,
                shared_chunk_ids: mergedChunks,
              }),
            });
            updatedEdges++;
          } else {
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
            newEdges++;
          }
        }
      }
    }
  }

  // Update edge_count on all touched nodes
  for (const nodeId of touchedNodeIds) {
    const nodeEdges = getEdgesForNode(conn, nodeId);
    conn
      .prepare('UPDATE knowledge_nodes SET edge_count = ? WHERE id = ?')
      .run(nodeEdges.length, nodeId);
  }

  return { newEdges, updatedEdges };
}
