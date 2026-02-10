/**
 * Knowledge Graph MCP Tools
 *
 * Tools: ocr_knowledge_graph_build, ocr_knowledge_graph_query,
 *        ocr_knowledge_graph_node, ocr_knowledge_graph_paths,
 *        ocr_knowledge_graph_stats, ocr_knowledge_graph_delete,
 *        ocr_knowledge_graph_export, ocr_knowledge_graph_merge,
 *        ocr_knowledge_graph_split, ocr_knowledge_graph_enrich,
 *        ocr_knowledge_graph_incremental_build
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/knowledge-graph
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolDefinition, type ToolResponse } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { v4 as uuidv4 } from 'uuid';
import {
  buildKnowledgeGraph,
  queryGraph,
  getNodeDetails,
  findGraphPaths,
} from '../services/knowledge-graph/graph-service.js';
import {
  getGraphStats,
  deleteAllGraphData,
  deleteGraphDataForDocuments,
  getKnowledgeNode,
  getLinksForNode,
  getEdgesForNode,
  insertKnowledgeNode,
  updateKnowledgeNode,
  updateKnowledgeEdge,
  deleteKnowledgeNode,
} from '../services/storage/database/knowledge-graph-operations.js';
import { exportGraphML, exportCSV, exportJSONLD } from '../services/knowledge-graph/export-service.js';
import { incrementalBuildGraph } from '../services/knowledge-graph/incremental-builder.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const BuildInput = z.object({
  document_filter: z.array(z.string()).optional()
    .describe('Subset of document IDs (default: all with entities)'),
  resolution_mode: z.enum(['exact', 'fuzzy', 'ai']).default('fuzzy')
    .describe("Resolution mode: exact (normalized match), fuzzy (Sorensen-Dice), ai (Gemini disambiguation)"),
  classify_relationships: z.boolean().default(false)
    .describe('Use Gemini AI for relationship type classification'),
  rebuild: z.boolean().default(false)
    .describe('Clear existing graph first'),
});

const QueryInput = z.object({
  entity_name: z.string().optional().describe('Search by name (LIKE match)'),
  entity_type: z.enum([
    'person', 'organization', 'date', 'amount', 'case_number',
    'location', 'statute', 'exhibit', 'other',
  ]).optional(),
  document_filter: z.array(z.string()).optional(),
  min_document_count: z.number().int().min(1).default(1),
  include_edges: z.boolean().default(true),
  include_documents: z.boolean().default(false),
  max_depth: z.number().int().min(1).max(5).default(1),
  limit: z.number().int().min(1).max(200).default(50),
});

const NodeInput = z.object({
  node_id: z.string().min(1).describe('Knowledge node ID'),
  include_mentions: z.boolean().default(false),
  include_provenance: z.boolean().default(false),
});

const PathsInput = z.object({
  source_entity: z.string().min(1).describe('Source node ID or entity name'),
  target_entity: z.string().min(1).describe('Target node ID or entity name'),
  max_hops: z.number().int().min(1).max(6).default(3),
  relationship_filter: z.array(z.string()).optional(),
});

const StatsInput = z.object({});

const DeleteInput = z.object({
  document_filter: z.array(z.string()).optional()
    .describe('Delete only graph data linked to these docs (default: all)'),
  confirm: z.literal(true).describe('Must be true to confirm deletion'),
});

const ExportInput = z.object({
  format: z.enum(['graphml', 'csv', 'json_ld'])
    .describe('Export format: graphml (XML for Gephi/yEd), csv (two files), json_ld (W3C)'),
  output_path: z.string().min(1).describe('Absolute path for the output file(s)'),
  entity_type_filter: z.array(z.enum([
    'person', 'organization', 'date', 'amount', 'case_number',
    'location', 'statute', 'exhibit', 'other',
  ])).optional().describe('Only export nodes of these entity types'),
  relationship_type_filter: z.array(z.enum([
    'co_mentioned', 'co_located', 'works_at', 'represents',
    'located_in', 'filed_in', 'cites', 'references',
    'party_to', 'related_to', 'precedes', 'occurred_at',
  ])).optional().describe('Only export edges of these relationship types'),
  min_confidence: z.number().min(0).max(1).optional()
    .describe('Minimum avg_confidence for nodes'),
  min_document_count: z.number().int().min(1).optional()
    .describe('Minimum document_count for nodes'),
  include_metadata: z.boolean().default(false)
    .describe('Include metadata JSON in export'),
});

const MergeInput = z.object({
  source_node_id: z.string().min(1).describe('Node to merge FROM (will be deleted)'),
  target_node_id: z.string().min(1).describe('Node to merge INTO (will be kept)'),
  confirm: z.literal(true).describe('Must be true to confirm merge'),
});

const SplitInput = z.object({
  node_id: z.string().min(1).describe('Node to split'),
  entity_ids_to_split: z.array(z.string().min(1)).min(1)
    .describe('Entity IDs to move to a new node'),
  confirm: z.literal(true).describe('Must be true to confirm split'),
});

const EnrichInput = z.object({
  node_id: z.string().min(1).describe('Knowledge node to enrich'),
  sources: z.array(z.enum(['vlm', 'extraction', 'clustering', 'search']))
    .min(1).describe('Data sources to query for enrichment'),
});

const IncrementalBuildInput = z.object({
  document_ids: z.array(z.string().min(1)).min(1)
    .describe('Document IDs to add to the knowledge graph incrementally'),
  resolution_mode: z.enum(['exact', 'fuzzy', 'ai']).default('fuzzy')
    .describe('Resolution mode for matching against existing nodes'),
  classify_relationships: z.boolean().default(false)
    .describe('Use Gemini AI for relationship type classification'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_knowledge_graph_build - Build knowledge graph from extracted entities
 */
async function handleKnowledgeGraphBuild(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(BuildInput, params);
    const { db } = requireDatabase();

    const result = await buildKnowledgeGraph(db, {
      document_filter: input.document_filter,
      resolution_mode: input.resolution_mode,
      classify_relationships: input.classify_relationships,
      rebuild: input.rebuild,
    });

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_query - Query the knowledge graph
 */
async function handleKnowledgeGraphQuery(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(QueryInput, params);
    const { db } = requireDatabase();

    const result = queryGraph(db, {
      entity_name: input.entity_name,
      entity_type: input.entity_type,
      document_filter: input.document_filter,
      min_document_count: input.min_document_count,
      include_edges: input.include_edges,
      include_documents: input.include_documents,
      max_depth: input.max_depth,
      limit: input.limit,
    });

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_node - Get detailed node information
 */
async function handleKnowledgeGraphNode(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(NodeInput, params);
    const { db } = requireDatabase();

    const result = getNodeDetails(db, input.node_id, {
      include_mentions: input.include_mentions,
      include_provenance: input.include_provenance,
    });

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_paths - Find paths between entities
 */
async function handleKnowledgeGraphPaths(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(PathsInput, params);
    const { db } = requireDatabase();

    const result = findGraphPaths(db, input.source_entity, input.target_entity, {
      max_hops: input.max_hops,
      relationship_filter: input.relationship_filter,
    });

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_stats - Get graph statistics
 */
async function handleKnowledgeGraphStats(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    validateInput(StatsInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const stats = getGraphStats(conn);

    return formatResponse(successResult(stats));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_delete - Delete graph data
 */
async function handleKnowledgeGraphDelete(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(DeleteInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    let result: { nodes_deleted: number; edges_deleted: number; links_deleted: number };

    if (input.document_filter && input.document_filter.length > 0) {
      result = deleteGraphDataForDocuments(conn, input.document_filter);
    } else {
      result = deleteAllGraphData(conn);
    }

    // Clean up KNOWLEDGE_GRAPH provenance records that are now orphaned
    let provenanceDeleted = 0;
    try {
      const orphanedProv = conn.prepare(
        `DELETE FROM provenance
         WHERE type = 'KNOWLEDGE_GRAPH'
           AND id NOT IN (SELECT provenance_id FROM knowledge_nodes)
           AND id NOT IN (SELECT provenance_id FROM knowledge_edges)`
      ).run();
      provenanceDeleted = orphanedProv.changes;
    } catch {
      // Ignore provenance cleanup failures
    }

    return formatResponse(successResult({
      ...result,
      provenance_deleted: provenanceDeleted,
      deleted: true,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_export - Export graph in standard formats
 */
async function handleKnowledgeGraphExport(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ExportInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const options = {
      entity_type_filter: input.entity_type_filter,
      relationship_type_filter: input.relationship_type_filter,
      min_confidence: input.min_confidence,
      min_document_count: input.min_document_count,
      include_metadata: input.include_metadata,
    };

    let result;
    switch (input.format) {
      case 'graphml':
        result = exportGraphML(conn, input.output_path, options);
        break;
      case 'csv':
        result = exportCSV(conn, input.output_path, options);
        break;
      case 'json_ld':
        result = exportJSONLD(conn, input.output_path, options);
        break;
    }

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_merge - Merge two nodes into one
 *
 * Moves all entity links from source to target, merges aliases,
 * sums counts, transfers edges, deletes source node.
 */
async function handleKnowledgeGraphMerge(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(MergeInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    if (input.source_node_id === input.target_node_id) {
      throw new Error('Cannot merge a node into itself. Source and target must be different nodes.');
    }

    const sourceNode = getKnowledgeNode(conn, input.source_node_id);
    if (!sourceNode) {
      throw new Error(`Source node not found: ${input.source_node_id}`);
    }

    const targetNode = getKnowledgeNode(conn, input.target_node_id);
    if (!targetNode) {
      throw new Error(`Target node not found: ${input.target_node_id}`);
    }

    if (sourceNode.entity_type !== targetNode.entity_type) {
      throw new Error(
        `Cannot merge nodes of different types: ${sourceNode.entity_type} vs ${targetNode.entity_type}`,
      );
    }

    // Execute merge in a transaction
    const mergeResult = conn.transaction(() => {
      const now = new Date().toISOString();

      // 1. Move entity links from source to target
      const sourceLinks = getLinksForNode(conn, sourceNode.id);
      let linksMoved = 0;
      for (const link of sourceLinks) {
        conn.prepare(
          'UPDATE node_entity_links SET node_id = ? WHERE id = ?',
        ).run(targetNode.id, link.id);
        linksMoved++;
      }

      // 2. Merge aliases
      const sourceAliases: string[] = sourceNode.aliases
        ? JSON.parse(sourceNode.aliases)
        : [];
      const targetAliases: string[] = targetNode.aliases
        ? JSON.parse(targetNode.aliases)
        : [];

      // Add source canonical name and its aliases to target aliases
      const mergedAliases = new Set([
        ...targetAliases,
        ...sourceAliases,
        sourceNode.canonical_name,
      ]);
      // Remove the target canonical name from aliases
      mergedAliases.delete(targetNode.canonical_name);

      // 3. Recalculate stats from all links (now on target)
      const allLinks = getLinksForNode(conn, targetNode.id);
      const uniqueDocIds = new Set(allLinks.map((l) => l.document_id));

      let totalConfidence = 0;
      let linkCount = 0;
      for (const l of allLinks) {
        const entity = conn
          .prepare('SELECT confidence FROM entities WHERE id = ?')
          .get(l.entity_id) as { confidence: number } | undefined;
        if (entity) {
          totalConfidence += entity.confidence;
          linkCount++;
        }
      }

      const newAvgConfidence =
        linkCount > 0
          ? Math.round((totalConfidence / linkCount) * 10000) / 10000
          : targetNode.avg_confidence;

      // 4. Transfer edges from source to target (no limit - must get ALL edges)
      const sourceEdges = getEdgesForNode(conn, sourceNode.id, { limit: 1000000 });
      let edgesTransferred = 0;
      let edgesMerged = 0;

      for (const edge of sourceEdges) {
        const isSource = edge.source_node_id === sourceNode.id;
        const otherNodeId = isSource
          ? edge.target_node_id
          : edge.source_node_id;

        // Skip self-loops that would form after merge
        if (otherNodeId === targetNode.id) {
          conn.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(edge.id);
          continue;
        }

        // Determine new source/target with alphabetical ordering
        const [newSource, newTarget] =
          targetNode.id < otherNodeId
            ? [targetNode.id, otherNodeId]
            : [otherNodeId, targetNode.id];

        // Check if target already has an edge of same type to the same neighbor
        const existingEdge = conn.prepare(
          `SELECT * FROM knowledge_edges
           WHERE source_node_id = ? AND target_node_id = ? AND relationship_type = ?`,
        ).get(newSource, newTarget, edge.relationship_type) as { id: string; weight: number; evidence_count: number; document_ids: string; metadata: string | null } | undefined;

        if (existingEdge && existingEdge.id !== edge.id) {
          // Merge edge data
          const existingDocIds: string[] = JSON.parse(existingEdge.document_ids || '[]');
          const edgeDocIds: string[] = JSON.parse(edge.document_ids || '[]');
          const mergedDocIds = [...new Set([...existingDocIds, ...edgeDocIds])];

          updateKnowledgeEdge(conn, existingEdge.id, {
            weight: Math.max(existingEdge.weight, edge.weight),
            evidence_count: existingEdge.evidence_count + edge.evidence_count,
            document_ids: JSON.stringify(mergedDocIds),
          });

          conn.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(edge.id);
          edgesMerged++;
        } else {
          // Transfer edge to target
          conn.prepare(
            'UPDATE knowledge_edges SET source_node_id = ? WHERE id = ? AND source_node_id = ?',
          ).run(targetNode.id, edge.id, sourceNode.id);
          conn.prepare(
            'UPDATE knowledge_edges SET target_node_id = ? WHERE id = ? AND target_node_id = ?',
          ).run(targetNode.id, edge.id, sourceNode.id);
          edgesTransferred++;
        }
      }

      // 5. Update target node stats
      const targetEdges = getEdgesForNode(conn, targetNode.id, { limit: 1000000 });
      updateKnowledgeNode(conn, targetNode.id, {
        document_count: uniqueDocIds.size,
        mention_count: allLinks.length,
        avg_confidence: newAvgConfidence,
        aliases: mergedAliases.size > 0 ? JSON.stringify([...mergedAliases]) : null,
        updated_at: now,
      });
      conn.prepare(
        'UPDATE knowledge_nodes SET edge_count = ? WHERE id = ?',
      ).run(targetEdges.length, targetNode.id);

      // 6. Delete source node (links already moved, edges already transferred/deleted)
      deleteKnowledgeNode(conn, sourceNode.id);

      return {
        merged: true,
        source_node_id: sourceNode.id,
        target_node_id: targetNode.id,
        source_canonical_name: sourceNode.canonical_name,
        target_canonical_name: targetNode.canonical_name,
        links_moved: linksMoved,
        edges_transferred: edgesTransferred,
        edges_merged: edgesMerged,
        new_document_count: uniqueDocIds.size,
        new_mention_count: allLinks.length,
        new_alias_count: mergedAliases.size,
      };
    })();

    return formatResponse(successResult(mergeResult));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_split - Split a node by moving entities to a new node
 *
 * Creates a new node from specified entity links, recalculates stats on both.
 */
async function handleKnowledgeGraphSplit(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SplitInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const node = getKnowledgeNode(conn, input.node_id);
    if (!node) {
      throw new Error(`Node not found: ${input.node_id}`);
    }

    const allLinks = getLinksForNode(conn, node.id);
    const splitEntityIds = new Set(input.entity_ids_to_split);

    // Validate that all specified entities are actually linked to this node
    const linkedEntityIds = new Set(allLinks.map((l) => l.entity_id));
    for (const entityId of splitEntityIds) {
      if (!linkedEntityIds.has(entityId)) {
        throw new Error(
          `Entity ${entityId} is not linked to node ${input.node_id}`,
        );
      }
    }

    // Must keep at least one entity on the original node
    const remainingLinks = allLinks.filter(
      (l) => !splitEntityIds.has(l.entity_id),
    );
    if (remainingLinks.length === 0) {
      throw new Error(
        'Cannot split all entities from a node. At least one entity must remain.',
      );
    }

    const splitResult = conn.transaction(() => {
      const now = new Date().toISOString();

      // 1. Create new node
      const splitLinks = allLinks.filter((l) =>
        splitEntityIds.has(l.entity_id),
      );

      // Get the highest-confidence entity for the new node's canonical name
      let bestEntity: { raw_text: string; normalized_text: string; confidence: number } | null = null;
      for (const link of splitLinks) {
        const entity = conn
          .prepare('SELECT raw_text, normalized_text, confidence FROM entities WHERE id = ?')
          .get(link.entity_id) as { raw_text: string; normalized_text: string; confidence: number } | undefined;
        if (entity && (!bestEntity || entity.confidence > bestEntity.confidence)) {
          bestEntity = entity;
        }
      }

      if (!bestEntity) {
        throw new Error('Could not find entity data for split entities');
      }

      const newNodeId = uuidv4();
      const splitDocIds = new Set(splitLinks.map((l) => l.document_id));

      // Calculate avg confidence for split entities
      let splitTotalConf = 0;
      let splitCount = 0;
      for (const link of splitLinks) {
        const entity = conn
          .prepare('SELECT confidence FROM entities WHERE id = ?')
          .get(link.entity_id) as { confidence: number } | undefined;
        if (entity) {
          splitTotalConf += entity.confidence;
          splitCount++;
        }
      }

      insertKnowledgeNode(conn, {
        id: newNodeId,
        entity_type: node.entity_type,
        canonical_name: bestEntity.raw_text,
        normalized_name: bestEntity.normalized_text,
        aliases: null,
        document_count: splitDocIds.size,
        mention_count: splitLinks.length,
        edge_count: 0,
        avg_confidence: splitCount > 0
          ? Math.round((splitTotalConf / splitCount) * 10000) / 10000
          : 0,
        metadata: JSON.stringify({ split_from: node.id }),
        provenance_id: node.provenance_id,
        created_at: now,
        updated_at: now,
      });

      // 2. Move entity links to new node
      for (const link of splitLinks) {
        conn.prepare(
          'UPDATE node_entity_links SET node_id = ? WHERE id = ?',
        ).run(newNodeId, link.id);
      }

      // 3. Recalculate original node stats
      const remainingDocIds = new Set(remainingLinks.map((l) => l.document_id));
      let remainTotalConf = 0;
      let remainCount = 0;
      for (const link of remainingLinks) {
        const entity = conn
          .prepare('SELECT confidence FROM entities WHERE id = ?')
          .get(link.entity_id) as { confidence: number } | undefined;
        if (entity) {
          remainTotalConf += entity.confidence;
          remainCount++;
        }
      }

      // Rebuild aliases from remaining entities
      const remainingAliases = new Set<string>();
      for (const link of remainingLinks) {
        const entity = conn
          .prepare('SELECT raw_text FROM entities WHERE id = ?')
          .get(link.entity_id) as { raw_text: string } | undefined;
        if (entity && entity.raw_text !== node.canonical_name) {
          remainingAliases.add(entity.raw_text);
        }
      }

      updateKnowledgeNode(conn, node.id, {
        document_count: remainingDocIds.size,
        mention_count: remainingLinks.length,
        avg_confidence: remainCount > 0
          ? Math.round((remainTotalConf / remainCount) * 10000) / 10000
          : node.avg_confidence,
        aliases: remainingAliases.size > 0
          ? JSON.stringify([...remainingAliases])
          : null,
        updated_at: now,
      });

      return {
        split: true,
        original_node_id: node.id,
        original_canonical_name: node.canonical_name,
        new_node_id: newNodeId,
        new_canonical_name: bestEntity.raw_text,
        entities_moved: splitLinks.length,
        entities_remaining: remainingLinks.length,
        original_document_count: remainingDocIds.size,
        new_document_count: splitDocIds.size,
      };
    })();

    return formatResponse(successResult(splitResult));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_enrich - Enrich a node with context from other sources
 *
 * Queries VLM descriptions, extractions, clusters, and search results
 * for additional context about the node's entities.
 */
async function handleKnowledgeGraphEnrich(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(EnrichInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const node = getKnowledgeNode(conn, input.node_id);
    if (!node) {
      throw new Error(`Node not found: ${input.node_id}`);
    }

    const links = getLinksForNode(conn, node.id);
    const entityIds = links.map((l) => l.entity_id);
    const documentIds = [...new Set(links.map((l) => l.document_id))];

    const enrichment: Record<string, unknown> = {};

    for (const source of input.sources) {
      switch (source) {
        case 'vlm': {
          // Find VLM descriptions mentioning this entity's text
          const vlmResults: Array<{ image_id: string; description: string; document_id: string }> = [];
          for (const docId of documentIds) {
            const rows = conn.prepare(`
              SELECT e.image_id, e.original_text as description, e.document_id
              FROM embeddings e
              WHERE e.document_id = ? AND e.image_id IS NOT NULL AND e.original_text IS NOT NULL
                AND LOWER(e.original_text) LIKE ?
              LIMIT 5
            `).all(docId, `%${node.canonical_name.toLowerCase()}%`) as Array<{
              image_id: string;
              description: string;
              document_id: string;
            }>;
            vlmResults.push(...rows);
          }
          enrichment.vlm = {
            descriptions_found: vlmResults.length,
            descriptions: vlmResults.map((r) => ({
              image_id: r.image_id,
              document_id: r.document_id,
              excerpt: r.description.slice(0, 300),
            })),
          };
          break;
        }

        case 'extraction': {
          // Find structured extractions mentioning this entity
          const extractionResults: Array<{
            extraction_id: string;
            field_name: string;
            value: string;
            document_id: string;
          }> = [];
          for (const entityId of entityIds) {
            const entity = conn
              .prepare('SELECT metadata FROM entities WHERE id = ?')
              .get(entityId) as { metadata: string | null } | undefined;
            if (entity?.metadata) {
              try {
                const meta = JSON.parse(entity.metadata);
                if (meta.source === 'extraction' && meta.extraction_id) {
                  const extraction = conn
                    .prepare('SELECT id, extraction_json, document_id FROM extractions WHERE id = ?')
                    .get(meta.extraction_id) as {
                    id: string;
                    extraction_json: string;
                    document_id: string;
                  } | undefined;
                  if (extraction) {
                    extractionResults.push({
                      extraction_id: extraction.id,
                      field_name: meta.field_name || 'unknown',
                      value: extraction.extraction_json.slice(0, 500),
                      document_id: extraction.document_id,
                    });
                  }
                }
              } catch {
                // Skip malformed metadata
              }
            }
          }
          enrichment.extraction = {
            extractions_found: extractionResults.length,
            extractions: extractionResults,
          };
          break;
        }

        case 'clustering': {
          // Find cluster assignments for the node's documents
          const clusterInfo: Array<{
            document_id: string;
            cluster_id: string;
            classification_tag: string | null;
          }> = [];
          try {
            for (const docId of documentIds) {
              const row = conn.prepare(`
                SELECT dc.document_id, dc.cluster_id, c.classification_tag
                FROM document_clusters dc
                JOIN clusters c ON dc.cluster_id = c.id
                WHERE dc.document_id = ?
              `).get(docId) as {
                document_id: string;
                cluster_id: string;
                classification_tag: string | null;
              } | undefined;
              if (row) {
                clusterInfo.push(row);
              }
            }
          } catch {
            // Cluster tables may not exist
          }
          enrichment.clustering = {
            clusters_found: clusterInfo.length,
            clusters: clusterInfo,
          };
          break;
        }

        case 'search': {
          // Find chunks that mention this entity's text
          const chunkResults: Array<{
            chunk_id: string;
            document_id: string;
            text_excerpt: string;
            page_number: number | null;
          }> = [];
          const searchRows = conn.prepare(`
            SELECT c.id as chunk_id, c.document_id, c.text, c.page_number
            FROM chunks c
            WHERE LOWER(c.text) LIKE ?
            LIMIT 10
          `).all(`%${node.canonical_name.toLowerCase()}%`) as Array<{
            chunk_id: string;
            document_id: string;
            text: string;
            page_number: number | null;
          }>;
          for (const row of searchRows) {
            chunkResults.push({
              chunk_id: row.chunk_id,
              document_id: row.document_id,
              text_excerpt: row.text.slice(0, 300),
              page_number: row.page_number,
            });
          }
          enrichment.search = {
            chunks_found: chunkResults.length,
            chunks: chunkResults,
          };
          break;
        }
      }
    }

    // Update node metadata with enrichment data
    const existingMeta = node.metadata ? JSON.parse(node.metadata) : {};
    const now = new Date().toISOString();
    updateKnowledgeNode(conn, node.id, {
      metadata: JSON.stringify({
        ...existingMeta,
        enrichment: {
          ...enrichment,
          enriched_at: now,
          sources: input.sources,
        },
      }),
      updated_at: now,
    });

    return formatResponse(successResult({
      node_id: node.id,
      canonical_name: node.canonical_name,
      sources_queried: input.sources,
      enrichment,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_incremental_build - Add documents to existing graph
 */
async function handleKnowledgeGraphIncrementalBuild(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(IncrementalBuildInput, params);
    const { db } = requireDatabase();

    const result = await incrementalBuildGraph(db, {
      document_ids: input.document_ids,
      resolution_mode: input.resolution_mode,
      classify_relationships: input.classify_relationships,
    });

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export const knowledgeGraphTools: Record<string, ToolDefinition> = {
  'ocr_knowledge_graph_build': {
    description: 'Build a knowledge graph from extracted entities, resolving duplicates across documents using exact, fuzzy, or AI-powered matching',
    inputSchema: BuildInput.shape,
    handler: handleKnowledgeGraphBuild,
  },
  'ocr_knowledge_graph_query': {
    description: 'Query the knowledge graph with filters for entity name, type, document, and minimum document count. Supports depth expansion.',
    inputSchema: QueryInput.shape,
    handler: handleKnowledgeGraphQuery,
  },
  'ocr_knowledge_graph_node': {
    description: 'Get detailed information about a knowledge graph node including member entities, edges, and provenance',
    inputSchema: NodeInput.shape,
    handler: handleKnowledgeGraphNode,
  },
  'ocr_knowledge_graph_paths': {
    description: 'Find paths between two entities in the knowledge graph using BFS traversal',
    inputSchema: PathsInput.shape,
    handler: handleKnowledgeGraphPaths,
  },
  'ocr_knowledge_graph_stats': {
    description: 'Get knowledge graph statistics including node/edge counts, type distributions, and most connected nodes',
    inputSchema: StatsInput.shape,
    handler: handleKnowledgeGraphStats,
  },
  'ocr_knowledge_graph_delete': {
    description: 'Delete knowledge graph data, optionally filtered by document IDs',
    inputSchema: DeleteInput.shape,
    handler: handleKnowledgeGraphDelete,
  },
  'ocr_knowledge_graph_export': {
    description: 'Export the knowledge graph in GraphML (Gephi/yEd), CSV (nodes + edges), or JSON-LD (W3C) format for external analysis',
    inputSchema: ExportInput.shape,
    handler: handleKnowledgeGraphExport,
  },
  'ocr_knowledge_graph_merge': {
    description: 'Merge two knowledge graph nodes into one. Transfers all entity links, edges, and aliases from source to target node.',
    inputSchema: MergeInput.shape,
    handler: handleKnowledgeGraphMerge,
  },
  'ocr_knowledge_graph_split': {
    description: 'Split a knowledge graph node by moving specified entity links to a new node. Recalculates stats on both nodes.',
    inputSchema: SplitInput.shape,
    handler: handleKnowledgeGraphSplit,
  },
  'ocr_knowledge_graph_enrich': {
    description: 'Enrich a knowledge graph node with context from VLM descriptions, structured extractions, cluster assignments, and text search',
    inputSchema: EnrichInput.shape,
    handler: handleKnowledgeGraphEnrich,
  },
  'ocr_knowledge_graph_incremental_build': {
    description: 'Incrementally add new documents to the existing knowledge graph without rebuilding. Matches entities against existing nodes.',
    inputSchema: IncrementalBuildInput.shape,
    handler: handleKnowledgeGraphIncrementalBuild,
  },
};
