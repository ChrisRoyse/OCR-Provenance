/**
 * Knowledge Graph MCP Tools
 *
 * Tools: ocr_knowledge_graph_build, ocr_knowledge_graph_query,
 *        ocr_knowledge_graph_node, ocr_knowledge_graph_paths,
 *        ocr_knowledge_graph_stats, ocr_knowledge_graph_delete,
 *        ocr_knowledge_graph_export, ocr_knowledge_graph_merge,
 *        ocr_knowledge_graph_split, ocr_knowledge_graph_enrich,
 *        ocr_knowledge_graph_incremental_build,
 *        ocr_knowledge_graph_normalize_weights, ocr_knowledge_graph_prune_edges
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
import { ProvenanceType } from '../models/provenance.js';
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
import { classifyEdgesWithGemini } from '../services/knowledge-graph/rule-classifier.js';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { getEmbeddingClient } from '../services/embedding/nomic.js';
import { computeHash } from '../utils/hash.js';

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
    'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other',
  ]).optional(),
  document_filter: z.array(z.string()).optional(),
  min_document_count: z.number().int().min(1).default(1),
  include_edges: z.boolean().default(true),
  include_documents: z.boolean().default(false),
  max_depth: z.number().int().min(1).max(5).default(1),
  limit: z.number().int().min(1).max(200).default(50),
  time_range: z.object({
    from: z.string().optional().describe('ISO date string - only include edges valid after this date'),
    until: z.string().optional().describe('ISO date string - only include edges valid before this date'),
  }).optional().describe('Filter edges by temporal validity range'),
});

const SetEdgeTemporalInput = z.object({
  edge_id: z.string().min(1).describe('Edge ID to update'),
  valid_from: z.string().optional().describe('ISO date when relationship becomes valid (e.g., employment start)'),
  valid_until: z.string().optional().describe('ISO date when relationship ends (null = still valid)'),
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
  include_evidence_chunks: z.boolean().default(false)
    .describe('Include document chunks that provide evidence for each edge in the path'),
  include_contradictions: z.boolean().default(false)
    .describe('Flag edges with known contradictions from document comparisons'),
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
    'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other',
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

const ClassifyRelationshipsInput = z.object({
  edge_ids: z.array(z.string()).optional()
    .describe('Specific edge IDs to classify (default: all co_mentioned/co_located edges)'),
  limit: z.number().int().min(1).max(1000).default(100)
    .describe('Maximum edges to classify'),
  batch_size: z.number().int().min(1).max(50).default(20)
    .describe('Edges per Gemini API call'),
});
const NormalizeWeightsInput = z.object({
  type_multipliers: z.record(z.number()).optional()
    .describe('Custom multipliers per relationship type (default: co_located=1.5, co_mentioned=1.0, works_at=2.0, represents=2.0)'),
  document_filter: z.array(z.string()).optional()
    .describe('Only normalize edges referencing these documents'),
});

const PruneEdgesInput = z.object({
  min_weight: z.number().min(0).optional()
    .describe('Remove edges with normalized_weight below this threshold'),
  min_evidence_count: z.number().int().min(1).optional()
    .describe('Remove edges with evidence_count below this value'),
  relationship_types: z.array(z.string()).optional()
    .describe('Only prune edges of these types'),
  dry_run: z.boolean().default(true)
    .describe('If true, report what would be pruned without deleting'),
  confirm: z.literal(true).optional()
    .describe('Must be true for actual deletion (when dry_run=false)'),
});

const ContradictionsInput = z.object({
  entity_name: z.string().optional().describe('Filter by entity name'),
  entity_type: z.enum([
    'person', 'organization', 'date', 'amount', 'case_number',
    'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other',
  ]).optional(),
  min_contradiction_count: z.number().int().min(1).default(1)
    .describe('Minimum contradiction count on edges'),
  document_filter: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const EntityEmbedInput = z.object({
  document_filter: z.array(z.string()).optional()
    .describe('Only embed nodes from these documents'),
  limit: z.number().int().min(1).max(5000).default(500)
    .describe('Maximum nodes to embed'),
  force: z.boolean().default(false)
    .describe('Re-embed nodes that already have embeddings'),
});

const EntitySearchSemanticInput = z.object({
  query: z.string().min(1).max(500).describe('Search query for entity similarity'),
  entity_type: z.enum([
    'person', 'organization', 'date', 'amount', 'case_number',
    'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other',
  ]).optional(),
  similarity_threshold: z.number().min(0).max(1).default(0.7),
  limit: z.number().int().min(1).max(100).default(20),
  include_documents: z.boolean().default(false),
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

    // Post-filter edges by time_range
    if (input.time_range && result.edges) {
      const conn = db.getConnection();
      result.edges = result.edges.filter(edge => {
        try {
          const temporal = conn.prepare(
            'SELECT valid_from, valid_until FROM knowledge_edges WHERE id = ?'
          ).get(edge.id) as { valid_from: string | null; valid_until: string | null } | undefined;
          if (!temporal) return true;
          if (input.time_range!.from && temporal.valid_until && temporal.valid_until < input.time_range!.from) return false;
          if (input.time_range!.until && temporal.valid_from && temporal.valid_from > input.time_range!.until) return false;
          return true;
        } catch { return true; }
      });
      result.total_edges = result.edges.length;
    }

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_set_edge_temporal - Set temporal bounds on an edge
 */
async function handleSetEdgeTemporal(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SetEdgeTemporalInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify edge exists
    const edge = conn.prepare(
      'SELECT id, source_node_id, target_node_id, relationship_type, valid_from, valid_until FROM knowledge_edges WHERE id = ?'
    ).get(input.edge_id) as {
      id: string;
      source_node_id: string;
      target_node_id: string;
      relationship_type: string;
      valid_from: string | null;
      valid_until: string | null;
    } | undefined;

    if (!edge) {
      throw new Error(`Edge not found: ${input.edge_id}`);
    }

    const now = new Date().toISOString();
    conn.prepare(
      'UPDATE knowledge_edges SET valid_from = ?, valid_until = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.valid_from ?? null,
      input.valid_until ?? null,
      now,
      input.edge_id,
    );

    return formatResponse(successResult({
      edge_id: input.edge_id,
      source_node_id: edge.source_node_id,
      target_node_id: edge.target_node_id,
      relationship_type: edge.relationship_type,
      valid_from: input.valid_from ?? null,
      valid_until: input.valid_until ?? null,
      previous_valid_from: edge.valid_from,
      previous_valid_until: edge.valid_until,
      updated_at: now,
    }));
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
      include_evidence_chunks: input.include_evidence_chunks,
    });

    // Annotate edges with contradiction info if requested
    if (input.include_contradictions && result.paths) {
      const conn = db.getConnection();
      for (const p of result.paths) {
        for (const edge of (p.edges || [])) {
          const edgeRow = conn.prepare(
            `SELECT contradiction_count FROM knowledge_edges WHERE id = ?`
          ).get(edge.id) as { contradiction_count: number } | undefined;
          if (edgeRow) {
            (edge as Record<string, unknown>).has_contradiction = edgeRow.contradiction_count > 0;
            (edge as Record<string, unknown>).contradiction_count = edgeRow.contradiction_count;
          }
        }
      }
    }

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

    // Clean up orphaned provenance from source node
    // The source node has been deleted but its provenance record remains
    try {
      conn.prepare('DELETE FROM provenance WHERE id = ?').run(sourceNode.provenance_id);
    } catch {
      // Ignore if provenance record doesn't exist or is still referenced
    }

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

      // Create new provenance record for split node (PROV-1)
      const splitProvId = uuidv4();
      db.insertProvenance({
        id: splitProvId,
        type: ProvenanceType.KNOWLEDGE_GRAPH,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'KNOWLEDGE_GRAPH',
        source_path: null,
        source_id: node.provenance_id,
        root_document_id: node.provenance_id,
        location: null,
        content_hash: '',
        input_hash: null,
        file_hash: null,
        processor: 'knowledge-graph-split',
        processor_version: '1.0.0',
        processing_params: {
          original_node_id: node.id,
          entity_ids_moved: splitLinks.map(l => l.entity_id),
        },
        processing_duration_ms: null,
        processing_quality_score: null,
        parent_id: node.provenance_id,
        parent_ids: JSON.stringify([node.provenance_id]),
        chain_depth: 2,
        chain_path: '["DOCUMENT","KNOWLEDGE_GRAPH","KNOWLEDGE_GRAPH"]',
      });

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
        provenance_id: splitProvId,
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

    // Create provenance record for enrichment event (PROV-3)
    const enrichProvId = uuidv4();
    db.insertProvenance({
      id: enrichProvId,
      type: ProvenanceType.KNOWLEDGE_GRAPH,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'KNOWLEDGE_GRAPH',
      source_path: null,
      source_id: node.provenance_id,
      root_document_id: node.provenance_id,
      location: null,
      content_hash: '',
      input_hash: null,
      file_hash: null,
      processor: 'knowledge-graph-enrich',
      processor_version: '1.0.0',
      processing_params: {
        node_id: node.id,
        sources: input.sources,
      },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: node.provenance_id,
      parent_ids: JSON.stringify([node.provenance_id]),
      chain_depth: 2,
      chain_path: '["DOCUMENT","KNOWLEDGE_GRAPH","KNOWLEDGE_GRAPH"]',
    });

    return formatResponse(successResult({
      node_id: node.id,
      canonical_name: node.canonical_name,
      sources_queried: input.sources,
      enrichment,
      provenance_id: enrichProvId,
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

/**
 * Handle ocr_knowledge_graph_classify_relationships - Semantic edge classification via Gemini
 */
async function handleKnowledgeGraphClassifyRelationships(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ClassifyRelationshipsInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const result = await classifyEdgesWithGemini(conn, {
      edge_ids: input.edge_ids,
      limit: input.limit,
      batch_size: input.batch_size,
    });

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}


/**
 * Handle ocr_knowledge_graph_normalize_weights - Normalize edge weights
 * using log(evidence_count + 1) * type_multiplier formula
 */
async function handleKnowledgeGraphNormalizeWeights(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(NormalizeWeightsInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const defaultMultipliers: Record<string, number> = {
      co_located: 1.5,
      co_mentioned: 1.0,
      works_at: 2.0,
      represents: 2.0,
      located_in: 1.5,
      filed_in: 1.5,
      cites: 1.5,
      references: 1.0,
      party_to: 2.0,
      related_to: 1.0,
      precedes: 1.0,
      occurred_at: 1.0,
    };

    const multipliers = { ...defaultMultipliers, ...input.type_multipliers };

    let edgeSql = 'SELECT id, relationship_type, evidence_count FROM knowledge_edges';
    const edgeParams: string[] = [];

    if (input.document_filter && input.document_filter.length > 0) {
      const docPlaceholders = input.document_filter.map(() => '?').join(',');
      edgeSql += ` WHERE EXISTS (
        SELECT 1 FROM json_each(document_ids) jd
        WHERE jd.value IN (${docPlaceholders})
      )`;
      edgeParams.push(...input.document_filter);
    }

    const edges = conn.prepare(edgeSql).all(...edgeParams) as Array<{
      id: string;
      relationship_type: string;
      evidence_count: number;
    }>;

    const updateStmt = conn.prepare(
      'UPDATE knowledge_edges SET normalized_weight = ? WHERE id = ?'
    );

    let edgesNormalized = 0;
    const typeCounts: Record<string, number> = {};

    conn.transaction(() => {
      for (const edge of edges) {
        const typeMultiplier = multipliers[edge.relationship_type] ?? 1.0;
        const normalizedWeight = Math.log(edge.evidence_count + 1) * typeMultiplier;

        updateStmt.run(normalizedWeight, edge.id);
        edgesNormalized++;

        typeCounts[edge.relationship_type] =
          (typeCounts[edge.relationship_type] || 0) + 1;
      }
    })();

    return formatResponse(successResult({
      edges_normalized: edgesNormalized,
      multipliers_used: multipliers,
      type_distribution: typeCounts,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_prune_edges - Remove low-quality edges
 * by normalized_weight threshold and/or minimum evidence count
 */
async function handleKnowledgeGraphPruneEdges(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(PruneEdgesInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    if (!input.min_weight && !input.min_evidence_count) {
      throw new Error(
        'At least one of min_weight or min_evidence_count must be specified'
      );
    }

    const conditions: string[] = [];
    const queryParams: (string | number)[] = [];

    if (input.min_weight !== undefined) {
      conditions.push('(normalized_weight IS NULL OR normalized_weight < ?)');
      queryParams.push(input.min_weight);
    }

    if (input.min_evidence_count !== undefined) {
      conditions.push('evidence_count < ?');
      queryParams.push(input.min_evidence_count);
    }

    if (input.relationship_types && input.relationship_types.length > 0) {
      const typePlaceholders = input.relationship_types.map(() => '?').join(',');
      conditions.push(`relationship_type IN (${typePlaceholders})`);
      queryParams.push(...input.relationship_types);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const totalEdges = (
      conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as {
        cnt: number;
      }
    ).cnt;

    const matchSql = `SELECT id, source_node_id, target_node_id, relationship_type,
                             weight, evidence_count, normalized_weight
                      FROM knowledge_edges ${whereClause}`;
    const matchingEdges = conn.prepare(matchSql).all(...queryParams) as Array<{
      id: string;
      source_node_id: string;
      target_node_id: string;
      relationship_type: string;
      weight: number;
      evidence_count: number;
      normalized_weight: number | null;
    }>;

    if (input.dry_run) {
      const typeSummary: Record<string, number> = {};
      for (const edge of matchingEdges) {
        typeSummary[edge.relationship_type] =
          (typeSummary[edge.relationship_type] || 0) + 1;
      }

      return formatResponse(successResult({
        dry_run: true,
        edges_analyzed: totalEdges,
        edges_would_be_pruned: matchingEdges.length,
        edges_would_remain: totalEdges - matchingEdges.length,
        prune_percentage: totalEdges > 0
          ? Math.round((matchingEdges.length / totalEdges) * 10000) / 100
          : 0,
        type_distribution: typeSummary,
        sample_edges: matchingEdges.slice(0, 20).map((e) => ({
          id: e.id,
          source_node_id: e.source_node_id,
          target_node_id: e.target_node_id,
          relationship_type: e.relationship_type,
          weight: e.weight,
          evidence_count: e.evidence_count,
          normalized_weight: e.normalized_weight,
        })),
      }));
    }

    if (!input.confirm) {
      throw new Error(
        'Must set confirm=true to delete edges (when dry_run=false)'
      );
    }

    const affectedNodeIds = new Set<string>();
    const deleteStmt = conn.prepare('DELETE FROM knowledge_edges WHERE id = ?');

    let edgesPruned = 0;
    conn.transaction(() => {
      for (const edge of matchingEdges) {
        deleteStmt.run(edge.id);
        affectedNodeIds.add(edge.source_node_id);
        affectedNodeIds.add(edge.target_node_id);
        edgesPruned++;
      }

      const updateEdgeCount = conn.prepare(
        `UPDATE knowledge_nodes SET edge_count = (
           SELECT COUNT(*) FROM knowledge_edges
           WHERE source_node_id = knowledge_nodes.id
              OR target_node_id = knowledge_nodes.id
         ) WHERE id = ?`
      );
      for (const nodeId of affectedNodeIds) {
        updateEdgeCount.run(nodeId);
      }
    })();

    return formatResponse(successResult({
      dry_run: false,
      edges_analyzed: totalEdges,
      edges_pruned: edgesPruned,
      edges_remaining: totalEdges - edgesPruned,
      nodes_affected: affectedNodeIds.size,
    }));
  } catch (error) {
    return handleError(error);
  }
}
/**
 * Handle ocr_knowledge_graph_contradictions - Query contradictions across KG
 */
async function handleKnowledgeGraphContradictions(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ContradictionsInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Query edges with contradiction_count > 0
    let sql = `
      SELECT ke.id, ke.source_node_id, ke.target_node_id,
             ke.relationship_type, ke.evidence_count, ke.contradiction_count,
             ke.weight, ke.normalized_weight,
             sn.canonical_name as source_name, sn.entity_type as source_type,
             tn.canonical_name as target_name, tn.entity_type as target_type
      FROM knowledge_edges ke
      JOIN knowledge_nodes sn ON ke.source_node_id = sn.id
      JOIN knowledge_nodes tn ON ke.target_node_id = tn.id
      WHERE ke.contradiction_count >= ?
    `;
    const params_list: unknown[] = [input.min_contradiction_count ?? 1];

    if (input.entity_name) {
      sql += ` AND (sn.canonical_name LIKE ? OR tn.canonical_name LIKE ?)`;
      params_list.push(`%${input.entity_name}%`, `%${input.entity_name}%`);
    }
    if (input.entity_type) {
      sql += ` AND (sn.entity_type = ? OR tn.entity_type = ?)`;
      params_list.push(input.entity_type, input.entity_type);
    }
    if (input.document_filter && input.document_filter.length > 0) {
      const docPlaceholders = input.document_filter.map(() => '?').join(',');
      sql += ` AND (sn.id IN (SELECT DISTINCT nel.node_id FROM node_entity_links nel JOIN entities e ON nel.entity_id = e.id WHERE e.document_id IN (${docPlaceholders}))
               OR tn.id IN (SELECT DISTINCT nel.node_id FROM node_entity_links nel JOIN entities e ON nel.entity_id = e.id WHERE e.document_id IN (${docPlaceholders})))`;
      params_list.push(...input.document_filter, ...input.document_filter);
    }

    sql += ` ORDER BY ke.contradiction_count DESC LIMIT ?`;
    params_list.push(input.limit ?? 50);

    const rows = conn.prepare(sql).all(...params_list) as Array<{
      id: string; source_node_id: string; target_node_id: string;
      relationship_type: string; evidence_count: number; contradiction_count: number;
      weight: number; normalized_weight: number | null;
      source_name: string; source_type: string;
      target_name: string; target_type: string;
    }>;

    return formatResponse(successResult({
      total: rows.length,
      contradictions: rows.map(r => ({
        edge_id: r.id,
        source: { node_id: r.source_node_id, name: r.source_name, type: r.source_type },
        target: { node_id: r.target_node_id, name: r.target_name, type: r.target_type },
        relationship_type: r.relationship_type,
        contradiction_count: r.contradiction_count,
        evidence_count: r.evidence_count,
        weight: r.weight,
      })),
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_embed_entities - Generate embeddings for KG nodes
 */
async function handleKnowledgeGraphEmbedEntities(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(EntityEmbedInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Get nodes to embed
    let sql = `
      SELECT kn.id, kn.canonical_name, kn.entity_type, kn.aliases,
             kn.document_count, kn.avg_confidence
      FROM knowledge_nodes kn
    `;
    const sqlParams: unknown[] = [];

    if (input.document_filter && input.document_filter.length > 0) {
      const placeholders = input.document_filter.map(() => '?').join(',');
      sql += ` WHERE kn.id IN (
        SELECT DISTINCT nel.node_id FROM node_entity_links nel
        JOIN entities e ON nel.entity_id = e.id
        WHERE e.document_id IN (${placeholders})
      )`;
      sqlParams.push(...input.document_filter);
    }

    if (!input.force) {
      sql += input.document_filter ? ' AND' : ' WHERE';
      sql += ` kn.id NOT IN (SELECT node_id FROM entity_embeddings)`;
    }

    sql += ` ORDER BY kn.document_count DESC LIMIT ?`;
    sqlParams.push(input.limit ?? 500);

    const nodes = conn.prepare(sql).all(...sqlParams) as Array<{
      id: string; canonical_name: string; entity_type: string;
      aliases: string | null; document_count: number; avg_confidence: number;
    }>;

    if (nodes.length === 0) {
      return formatResponse(successResult({
        embedded: 0, skipped: 0, errors: 0,
        message: 'No nodes to embed (all already embedded or no nodes found)',
      }));
    }

    // Build texts for embedding
    const texts: string[] = [];
    for (const node of nodes) {
      let aliases: string[] = [];
      if (node.aliases) {
        try { aliases = JSON.parse(node.aliases); } catch { /* ignore */ }
      }
      const aliasText = aliases.length > 0 ? ` Also known as: ${aliases.join(', ')}.` : '';
      texts.push(`${node.canonical_name} (${node.entity_type}).${aliasText}`);
    }

    // Generate embeddings via nomic
    const client = getEmbeddingClient();
    const embedResults = await client.embedChunks(texts);

    // Store embeddings
    let embedded = 0;
    let errors = 0;

    const insertEmb = conn.prepare(`
      INSERT OR REPLACE INTO entity_embeddings (id, node_id, original_text, original_text_length,
        entity_type, document_count, model_name, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'nomic-embed-text-v1.5', ?, datetime('now'))
    `);
    const insertVec = conn.prepare(`
      INSERT OR REPLACE INTO vec_entity_embeddings (entity_embedding_id, vector)
      VALUES (?, ?)
    `);

    const transaction = conn.transaction(() => {
      for (let i = 0; i < nodes.length; i++) {
        try {
          const vector = embedResults[i];
          if (!vector || vector.length === 0) { errors++; continue; }

          const embId = uuidv4();
          const contentHash = computeHash(texts[i]);
          insertEmb.run(embId, nodes[i].id, texts[i], texts[i].length,
            nodes[i].entity_type, nodes[i].document_count, contentHash);
          insertVec.run(embId, Buffer.from(vector.buffer));
          embedded++;
        } catch {
          errors++;
        }
      }
    });
    transaction();

    return formatResponse(successResult({
      embedded,
      skipped: nodes.length - embedded - errors,
      errors,
      total_nodes_processed: nodes.length,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_knowledge_graph_search_entities - Semantic entity search
 */
async function handleKnowledgeGraphSearchEntities(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(EntitySearchSemanticInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Embed the query
    const embedService = getEmbeddingService();
    const queryVector = await embedService.embedSearchQuery(input.query);
    if (!queryVector) {
      return formatResponse({ error: 'Failed to embed query' });
    }

    // Search vec_entity_embeddings
    let sql = `
      SELECT vee.distance,
             ee.id as embedding_id, ee.node_id, ee.original_text, ee.entity_type,
             ee.document_count,
             kn.canonical_name, kn.aliases, kn.avg_confidence, kn.edge_count
      FROM vec_entity_embeddings vee
      JOIN entity_embeddings ee ON vee.entity_embedding_id = ee.id
      JOIN knowledge_nodes kn ON ee.node_id = kn.id
      WHERE vee.vector MATCH ?
        AND vee.k = ?
    `;
    const sqlParams: unknown[] = [Buffer.from(queryVector.buffer), (input.limit ?? 20) * 2];

    if (input.entity_type) {
      sql += ` AND ee.entity_type = ?`;
      sqlParams.push(input.entity_type);
    }

    const rows = conn.prepare(sql).all(...sqlParams) as Array<{
      distance: number; embedding_id: string; node_id: string;
      original_text: string; entity_type: string; document_count: number;
      canonical_name: string; aliases: string | null;
      avg_confidence: number; edge_count: number;
    }>;

    // Filter by similarity threshold (distance is cosine distance, lower = more similar)
    const threshold = input.similarity_threshold ?? 0.7;
    const filtered = rows
      .filter(r => (1 - r.distance) >= threshold)
      .slice(0, input.limit ?? 20);

    const results = filtered.map(r => {
      let aliases: string[] = [];
      if (r.aliases) {
        try { aliases = JSON.parse(r.aliases); } catch { /* ignore */ }
      }

      const result: Record<string, unknown> = {
        node_id: r.node_id,
        canonical_name: r.canonical_name,
        entity_type: r.entity_type,
        similarity: Number((1 - r.distance).toFixed(4)),
        aliases,
        avg_confidence: r.avg_confidence,
        document_count: r.document_count,
        edge_count: r.edge_count,
      };

      if (input.include_documents) {
        const docs = conn.prepare(`
          SELECT DISTINCT e.document_id
          FROM node_entity_links nel
          JOIN entities e ON nel.entity_id = e.id
          WHERE nel.node_id = ?
        `).all(r.node_id) as Array<{ document_id: string }>;
        result.document_ids = docs.map(d => d.document_id);
      }

      return result;
    });

    return formatResponse(successResult({
      query: input.query,
      total: results.length,
      results,
    }));
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
  'ocr_knowledge_graph_classify_relationships': {
    description: 'Classify knowledge graph edge relationships using Gemini semantic analysis. Analyzes text context where entities co-occur to assign specific relationship types (works_at, represents, located_in, etc.) instead of generic co_mentioned/co_located.',
    inputSchema: ClassifyRelationshipsInput.shape,
    handler: handleKnowledgeGraphClassifyRelationships,
  },
  'ocr_knowledge_graph_normalize_weights': {
    description: 'Normalize edge weights using log(evidence_count+1) * type_multiplier formula. Updates normalized_weight on all matching edges. Supports custom multipliers per relationship type and optional document filtering.',
    inputSchema: NormalizeWeightsInput.shape,
    handler: handleKnowledgeGraphNormalizeWeights,
  },
  'ocr_knowledge_graph_prune_edges': {
    description: 'Prune low-quality edges from the knowledge graph by normalized_weight threshold and/or minimum evidence count. Supports dry_run mode to preview before deleting.',
    inputSchema: PruneEdgesInput.shape,
    handler: handleKnowledgeGraphPruneEdges,
  },
  'ocr_knowledge_graph_set_edge_temporal': {
    description: 'Set temporal bounds (valid_from, valid_until) on a knowledge graph edge to track when relationships are valid',
    inputSchema: SetEdgeTemporalInput.shape,
    handler: handleSetEdgeTemporal,
  },
  'ocr_knowledge_graph_contradictions': {
    description: 'Query edges with contradictions detected from document comparisons. Filter by entity name, type, or document.',
    inputSchema: ContradictionsInput.shape,
    handler: handleKnowledgeGraphContradictions,
  },
  'ocr_knowledge_graph_embed_entities': {
    description: 'Generate semantic embeddings for KG nodes using nomic-embed-text-v1.5. Enables entity-level semantic search via ocr_knowledge_graph_search_entities.',
    inputSchema: EntityEmbedInput.shape,
    handler: handleKnowledgeGraphEmbedEntities,
  },
  'ocr_knowledge_graph_search_entities': {
    description: 'Search knowledge graph entities by semantic similarity. Requires embeddings generated via ocr_knowledge_graph_embed_entities.',
    inputSchema: EntitySearchSemanticInput.shape,
    handler: handleKnowledgeGraphSearchEntities,
  },
};
