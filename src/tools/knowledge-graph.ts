/**
 * Knowledge Graph MCP Tools
 *
 * Tools: ocr_knowledge_graph_build, ocr_knowledge_graph_query,
 *        ocr_knowledge_graph_node, ocr_knowledge_graph_paths,
 *        ocr_knowledge_graph_stats, ocr_knowledge_graph_delete
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
} from '../services/storage/database/knowledge-graph-operations.js';

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
};
