/**
 * Knowledge graph operations for DatabaseService
 *
 * Handles CRUD operations for knowledge_nodes, knowledge_edges,
 * and node_entity_links tables. Includes graph query functions
 * (BFS path finding, graph stats) and cascade delete helpers.
 */

import Database from 'better-sqlite3';
import type { KnowledgeNode, KnowledgeEdge, NodeEntityLink } from '../../../models/knowledge-graph.js';
import { runWithForeignKeyCheck } from './helpers.js';

// ============================================================
// Knowledge Nodes CRUD
// ============================================================

/**
 * Insert a knowledge node
 */
export function insertKnowledgeNode(
  db: Database.Database,
  node: KnowledgeNode,
): string {
  const stmt = db.prepare(`
    INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
      aliases, document_count, mention_count, avg_confidence, metadata,
      provenance_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      node.id,
      node.entity_type,
      node.canonical_name,
      node.normalized_name,
      node.aliases,
      node.document_count,
      node.mention_count,
      node.avg_confidence,
      node.metadata,
      node.provenance_id,
      node.created_at,
      node.updated_at,
    ],
    `inserting knowledge_node: FK violation for provenance_id="${node.provenance_id}"`,
  );

  return node.id;
}

/**
 * Get a knowledge node by ID
 */
export function getKnowledgeNode(
  db: Database.Database,
  id: string,
): KnowledgeNode | null {
  const row = db.prepare(
    'SELECT * FROM knowledge_nodes WHERE id = ?',
  ).get(id) as KnowledgeNode | undefined;
  return row ?? null;
}

/**
 * Update a knowledge node (document_count, mention_count, avg_confidence, aliases, metadata, updated_at)
 */
export function updateKnowledgeNode(
  db: Database.Database,
  id: string,
  updates: Partial<Pick<KnowledgeNode, 'document_count' | 'mention_count' | 'avg_confidence' | 'aliases' | 'metadata' | 'updated_at'>>,
): void {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.document_count !== undefined) {
    setClauses.push('document_count = ?');
    params.push(updates.document_count);
  }
  if (updates.mention_count !== undefined) {
    setClauses.push('mention_count = ?');
    params.push(updates.mention_count);
  }
  if (updates.avg_confidence !== undefined) {
    setClauses.push('avg_confidence = ?');
    params.push(updates.avg_confidence);
  }
  if (updates.aliases !== undefined) {
    setClauses.push('aliases = ?');
    params.push(updates.aliases);
  }
  if (updates.metadata !== undefined) {
    setClauses.push('metadata = ?');
    params.push(updates.metadata);
  }
  if (updates.updated_at !== undefined) {
    setClauses.push('updated_at = ?');
    params.push(updates.updated_at);
  }

  if (setClauses.length === 0) return;

  params.push(id);
  db.prepare(
    `UPDATE knowledge_nodes SET ${setClauses.join(', ')} WHERE id = ?`,
  ).run(...params);
}

/**
 * Delete a knowledge node by ID
 */
export function deleteKnowledgeNode(
  db: Database.Database,
  id: string,
): void {
  db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(id);
}

/**
 * List knowledge nodes with optional filters
 */
export function listKnowledgeNodes(
  db: Database.Database,
  options?: {
    entity_type?: string;
    entity_name?: string;
    min_document_count?: number;
    document_filter?: string[];
    limit?: number;
    offset?: number;
  },
): KnowledgeNode[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.entity_type) {
    conditions.push('kn.entity_type = ?');
    params.push(options.entity_type);
  }

  if (options?.entity_name) {
    conditions.push('kn.canonical_name LIKE ?');
    params.push(`%${options.entity_name}%`);
  }

  if (options?.min_document_count !== undefined) {
    conditions.push('kn.document_count >= ?');
    params.push(options.min_document_count);
  }

  let joinClause = '';
  if (options?.document_filter && options.document_filter.length > 0) {
    const placeholders = options.document_filter.map(() => '?').join(',');
    joinClause = `JOIN node_entity_links nel ON nel.node_id = kn.id`;
    conditions.push(`nel.document_id IN (${placeholders})`);
    params.push(...options.document_filter);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  params.push(limit, offset);

  const distinctClause = joinClause ? 'DISTINCT' : '';

  const sql = `SELECT ${distinctClause} kn.* FROM knowledge_nodes kn ${joinClause} ${where} ORDER BY kn.document_count DESC, kn.canonical_name ASC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params) as KnowledgeNode[];
}

/**
 * Count total knowledge nodes
 */
export function countKnowledgeNodes(db: Database.Database): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM knowledge_nodes',
  ).get() as { cnt: number };
  return row.cnt;
}

// ============================================================
// Knowledge Edges CRUD
// ============================================================

/**
 * Insert a knowledge edge
 */
export function insertKnowledgeEdge(
  db: Database.Database,
  edge: KnowledgeEdge,
): string {
  const stmt = db.prepare(`
    INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relationship_type,
      weight, evidence_count, document_ids, metadata, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      edge.id,
      edge.source_node_id,
      edge.target_node_id,
      edge.relationship_type,
      edge.weight,
      edge.evidence_count,
      edge.document_ids,
      edge.metadata,
      edge.provenance_id,
      edge.created_at,
    ],
    `inserting knowledge_edge: FK violation for source_node_id="${edge.source_node_id}" or target_node_id="${edge.target_node_id}"`,
  );

  return edge.id;
}

/**
 * Get edge by ID
 */
export function getKnowledgeEdge(
  db: Database.Database,
  id: string,
): KnowledgeEdge | null {
  const row = db.prepare(
    'SELECT * FROM knowledge_edges WHERE id = ?',
  ).get(id) as KnowledgeEdge | undefined;
  return row ?? null;
}

/**
 * Get edges for a node (both directions)
 */
export function getEdgesForNode(
  db: Database.Database,
  nodeId: string,
  options?: {
    relationship_type?: string;
    limit?: number;
  },
): KnowledgeEdge[] {
  const conditions: string[] = ['(source_node_id = ? OR target_node_id = ?)'];
  const params: (string | number)[] = [nodeId, nodeId];

  if (options?.relationship_type) {
    conditions.push('relationship_type = ?');
    params.push(options.relationship_type);
  }

  const limit = options?.limit ?? 100;
  params.push(limit);

  const sql = `SELECT * FROM knowledge_edges WHERE ${conditions.join(' AND ')} ORDER BY weight DESC LIMIT ?`;
  return db.prepare(sql).all(...params) as KnowledgeEdge[];
}

/**
 * Update edge (increment evidence_count, merge document_ids, update weight)
 */
export function updateKnowledgeEdge(
  db: Database.Database,
  id: string,
  updates: {
    weight?: number;
    evidence_count?: number;
    document_ids?: string;
    metadata?: string | null;
  },
): void {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.weight !== undefined) {
    setClauses.push('weight = ?');
    params.push(updates.weight);
  }
  if (updates.evidence_count !== undefined) {
    setClauses.push('evidence_count = ?');
    params.push(updates.evidence_count);
  }
  if (updates.document_ids !== undefined) {
    setClauses.push('document_ids = ?');
    params.push(updates.document_ids);
  }
  if (updates.metadata !== undefined) {
    setClauses.push('metadata = ?');
    params.push(updates.metadata);
  }

  if (setClauses.length === 0) return;

  params.push(id);
  db.prepare(
    `UPDATE knowledge_edges SET ${setClauses.join(', ')} WHERE id = ?`,
  ).run(...params);
}

/**
 * Find existing edge by source, target, and relationship type (for dedup)
 */
export function findEdge(
  db: Database.Database,
  sourceNodeId: string,
  targetNodeId: string,
  relationshipType: string,
): KnowledgeEdge | null {
  const row = db.prepare(
    'SELECT * FROM knowledge_edges WHERE source_node_id = ? AND target_node_id = ? AND relationship_type = ?',
  ).get(sourceNodeId, targetNodeId, relationshipType) as KnowledgeEdge | undefined;
  return row ?? null;
}

/**
 * Delete edge by ID
 */
export function deleteKnowledgeEdge(
  db: Database.Database,
  id: string,
): void {
  db.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(id);
}

/**
 * Delete all edges for a node (both directions)
 */
export function deleteEdgesForNode(
  db: Database.Database,
  nodeId: string,
): void {
  db.prepare(
    'DELETE FROM knowledge_edges WHERE source_node_id = ? OR target_node_id = ?',
  ).run(nodeId, nodeId);
}

/**
 * Count total edges
 */
export function countKnowledgeEdges(db: Database.Database): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM knowledge_edges',
  ).get() as { cnt: number };
  return row.cnt;
}

/**
 * Get edges grouped by relationship type with counts
 */
export function getEdgeTypeCounts(db: Database.Database): Record<string, number> {
  const rows = db.prepare(
    'SELECT relationship_type, COUNT(*) as cnt FROM knowledge_edges GROUP BY relationship_type ORDER BY cnt DESC',
  ).all() as { relationship_type: string; cnt: number }[];

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.relationship_type] = row.cnt;
  }
  return result;
}

// ============================================================
// Node-Entity Links CRUD
// ============================================================

/**
 * Insert a node-entity link
 */
export function insertNodeEntityLink(
  db: Database.Database,
  link: NodeEntityLink,
): string {
  const stmt = db.prepare(`
    INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      link.id,
      link.node_id,
      link.entity_id,
      link.document_id,
      link.similarity_score,
      link.created_at,
    ],
    `inserting node_entity_link: FK violation for node_id="${link.node_id}" or entity_id="${link.entity_id}" or document_id="${link.document_id}"`,
  );

  return link.id;
}

/**
 * Get links for a node
 */
export function getLinksForNode(
  db: Database.Database,
  nodeId: string,
): NodeEntityLink[] {
  return db.prepare(
    'SELECT * FROM node_entity_links WHERE node_id = ? ORDER BY similarity_score DESC',
  ).all(nodeId) as NodeEntityLink[];
}

/**
 * Get link for an entity (entity_id is UNIQUE in the schema)
 */
export function getLinkForEntity(
  db: Database.Database,
  entityId: string,
): NodeEntityLink | null {
  const row = db.prepare(
    'SELECT * FROM node_entity_links WHERE entity_id = ?',
  ).get(entityId) as NodeEntityLink | undefined;
  return row ?? null;
}

/**
 * Get links for a document
 */
export function getLinksForDocument(
  db: Database.Database,
  documentId: string,
): NodeEntityLink[] {
  return db.prepare(
    'SELECT * FROM node_entity_links WHERE document_id = ? ORDER BY created_at ASC',
  ).all(documentId) as NodeEntityLink[];
}

/**
 * Delete links for a node
 */
export function deleteLinksForNode(
  db: Database.Database,
  nodeId: string,
): void {
  db.prepare('DELETE FROM node_entity_links WHERE node_id = ?').run(nodeId);
}

/**
 * Delete links for a document
 */
export function deleteLinksForDocument(
  db: Database.Database,
  documentId: string,
): void {
  db.prepare('DELETE FROM node_entity_links WHERE document_id = ?').run(documentId);
}

/**
 * Count total links
 */
export function countNodeEntityLinks(db: Database.Database): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM node_entity_links',
  ).get() as { cnt: number };
  return row.cnt;
}

// ============================================================
// Graph Query Functions
// ============================================================

/**
 * Get nodes with their edges for graph visualization
 */
export function getGraphData(
  db: Database.Database,
  nodeIds: string[],
): {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
} {
  if (nodeIds.length === 0) {
    return { nodes: [], edges: [] };
  }

  const placeholders = nodeIds.map(() => '?').join(',');

  const nodes = db.prepare(
    `SELECT * FROM knowledge_nodes WHERE id IN (${placeholders})`,
  ).all(...nodeIds) as KnowledgeNode[];

  // Get all edges where both endpoints are in the requested set
  const edges = db.prepare(
    `SELECT * FROM knowledge_edges WHERE source_node_id IN (${placeholders}) AND target_node_id IN (${placeholders})`,
  ).all(...nodeIds, ...nodeIds) as KnowledgeEdge[];

  return { nodes, edges };
}

/**
 * BFS path finding between two nodes.
 * Returns all paths up to max_hops, capped at 20 paths.
 * Uses a per-path visited set to allow different paths through the same node.
 */
export function findPaths(
  db: Database.Database,
  sourceNodeId: string,
  targetNodeId: string,
  options?: {
    max_hops?: number;
    relationship_filter?: string[];
  },
): Array<{
  length: number;
  node_ids: string[];
  edge_ids: string[];
}> {
  const maxHops = Math.min(options?.max_hops ?? 3, 6);
  const maxPaths = 20;

  // Build adjacency list from all edges (or filtered edges)
  let edgeRows: KnowledgeEdge[];
  if (options?.relationship_filter && options.relationship_filter.length > 0) {
    const placeholders = options.relationship_filter.map(() => '?').join(',');
    edgeRows = db.prepare(
      `SELECT * FROM knowledge_edges WHERE relationship_type IN (${placeholders})`,
    ).all(...options.relationship_filter) as KnowledgeEdge[];
  } else {
    edgeRows = db.prepare('SELECT * FROM knowledge_edges').all() as KnowledgeEdge[];
  }

  // Adjacency: nodeId -> Array<{ neighbor: string; edgeId: string }>
  const adjacency = new Map<string, Array<{ neighbor: string; edgeId: string }>>();

  for (const edge of edgeRows) {
    // Bidirectional: edges can be traversed in either direction
    if (!adjacency.has(edge.source_node_id)) {
      adjacency.set(edge.source_node_id, []);
    }
    adjacency.get(edge.source_node_id)!.push({
      neighbor: edge.target_node_id,
      edgeId: edge.id,
    });

    if (!adjacency.has(edge.target_node_id)) {
      adjacency.set(edge.target_node_id, []);
    }
    adjacency.get(edge.target_node_id)!.push({
      neighbor: edge.source_node_id,
      edgeId: edge.id,
    });
  }

  const results: Array<{
    length: number;
    node_ids: string[];
    edge_ids: string[];
  }> = [];

  // BFS with path tracking
  // Each queue entry carries its own visited set to allow multiple paths through same node
  interface QueueEntry {
    nodeId: string;
    nodePath: string[];
    edgePath: string[];
    visited: Set<string>;
  }

  const initialVisited = new Set<string>([sourceNodeId]);
  const queue: QueueEntry[] = [{
    nodeId: sourceNodeId,
    nodePath: [sourceNodeId],
    edgePath: [],
    visited: initialVisited,
  }];

  while (queue.length > 0 && results.length < maxPaths) {
    const entry = queue.shift()!;

    // Stop expanding if we've reached max hops
    if (entry.edgePath.length >= maxHops) {
      continue;
    }

    const neighbors = adjacency.get(entry.nodeId);
    if (!neighbors) continue;

    for (const { neighbor, edgeId } of neighbors) {
      if (entry.visited.has(neighbor)) continue;

      const newNodePath = [...entry.nodePath, neighbor];
      const newEdgePath = [...entry.edgePath, edgeId];

      if (neighbor === targetNodeId) {
        results.push({
          length: newEdgePath.length,
          node_ids: newNodePath,
          edge_ids: newEdgePath,
        });
        if (results.length >= maxPaths) break;
      } else {
        // Continue BFS with a new visited set for this path branch
        const newVisited = new Set(entry.visited);
        newVisited.add(neighbor);
        queue.push({
          nodeId: neighbor,
          nodePath: newNodePath,
          edgePath: newEdgePath,
          visited: newVisited,
        });
      }
    }
  }

  // Sort by path length (shortest first)
  results.sort((a, b) => a.length - b.length);
  return results;
}

/**
 * Get graph statistics
 */
export function getGraphStats(db: Database.Database): {
  total_nodes: number;
  total_edges: number;
  total_links: number;
  nodes_by_type: Record<string, number>;
  edges_by_type: Record<string, number>;
  cross_document_nodes: number;
  most_connected_nodes: Array<{
    id: string;
    canonical_name: string;
    entity_type: string;
    edge_count: number;
    document_count: number;
  }>;
  documents_covered: number;
  avg_edges_per_node: number;
} {
  const totalNodes = countKnowledgeNodes(db);
  const totalEdges = countKnowledgeEdges(db);
  const totalLinks = countNodeEntityLinks(db);

  // Nodes by type
  const nodeTypeRows = db.prepare(
    'SELECT entity_type, COUNT(*) as cnt FROM knowledge_nodes GROUP BY entity_type ORDER BY cnt DESC',
  ).all() as { entity_type: string; cnt: number }[];
  const nodesByType: Record<string, number> = {};
  for (const row of nodeTypeRows) {
    nodesByType[row.entity_type] = row.cnt;
  }

  // Edges by type
  const edgesByType = getEdgeTypeCounts(db);

  // Cross-document nodes (document_count > 1)
  const crossDocRow = db.prepare(
    'SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE document_count > 1',
  ).get() as { cnt: number };

  // Most connected nodes (by edge count)
  const mostConnected = db.prepare(
    `SELECT kn.id, kn.canonical_name, kn.entity_type, kn.document_count,
            (SELECT COUNT(*) FROM knowledge_edges
             WHERE source_node_id = kn.id OR target_node_id = kn.id) as edge_count
     FROM knowledge_nodes kn
     ORDER BY edge_count DESC, kn.document_count DESC
     LIMIT 10`,
  ).all() as Array<{
    id: string;
    canonical_name: string;
    entity_type: string;
    edge_count: number;
    document_count: number;
  }>;

  // Documents covered (distinct document_ids across all links)
  const docsCoveredRow = db.prepare(
    'SELECT COUNT(DISTINCT document_id) as cnt FROM node_entity_links',
  ).get() as { cnt: number };

  // Average edges per node
  const avgEdgesPerNode = totalNodes > 0 ? (totalEdges * 2) / totalNodes : 0;

  return {
    total_nodes: totalNodes,
    total_edges: totalEdges,
    total_links: totalLinks,
    nodes_by_type: nodesByType,
    edges_by_type: edgesByType,
    cross_document_nodes: crossDocRow.cnt,
    most_connected_nodes: mostConnected,
    documents_covered: docsCoveredRow.cnt,
    avg_edges_per_node: Math.round(avgEdgesPerNode * 100) / 100,
  };
}

/**
 * Get knowledge node summaries for a document (for document get/report integration)
 */
export function getKnowledgeNodeSummariesByDocument(
  db: Database.Database,
  documentId: string,
): Array<{
  node_id: string;
  canonical_name: string;
  entity_type: string;
  document_count: number;
  edge_count: number;
}> {
  return db.prepare(
    `SELECT kn.id as node_id, kn.canonical_name, kn.entity_type, kn.document_count,
            (SELECT COUNT(*) FROM knowledge_edges
             WHERE source_node_id = kn.id OR target_node_id = kn.id) as edge_count
     FROM knowledge_nodes kn
     JOIN node_entity_links nel ON nel.node_id = kn.id
     WHERE nel.document_id = ?
     GROUP BY kn.id
     ORDER BY edge_count DESC, kn.document_count DESC`,
  ).all(documentId) as Array<{
    node_id: string;
    canonical_name: string;
    entity_type: string;
    document_count: number;
    edge_count: number;
  }>;
}

// ============================================================
// Cascade Delete Helpers
// ============================================================

/**
 * Clean up knowledge graph data when a document is deleted.
 *
 * Steps:
 * 1. Delete node_entity_links for document
 * 2. Decrement document_count on affected nodes
 * 3. Delete edges where both nodes now have document_count <= 0
 * 4. Delete nodes with document_count <= 0 and no remaining links
 * 5. Return counts of what was deleted
 */
export function cleanupGraphForDocument(
  db: Database.Database,
  documentId: string,
): {
  links_deleted: number;
  nodes_deleted: number;
  edges_deleted: number;
} {
  // Step 1: Find affected node IDs before deleting links
  const affectedNodeIds = db.prepare(
    'SELECT DISTINCT node_id FROM node_entity_links WHERE document_id = ?',
  ).all(documentId) as { node_id: string }[];

  // Delete links for this document
  const linkResult = db.prepare(
    'DELETE FROM node_entity_links WHERE document_id = ?',
  ).run(documentId);
  const linksDeleted = linkResult.changes;

  if (affectedNodeIds.length === 0) {
    return { links_deleted: linksDeleted, nodes_deleted: 0, edges_deleted: 0 };
  }

  // Step 2: Decrement document_count on affected nodes
  for (const { node_id } of affectedNodeIds) {
    db.prepare(
      'UPDATE knowledge_nodes SET document_count = document_count - 1 WHERE id = ?',
    ).run(node_id);
  }

  // Step 3: Find nodes that should be deleted (document_count <= 0 and no remaining links)
  const nodeIdsToCheck = affectedNodeIds.map((r) => r.node_id);
  const placeholders = nodeIdsToCheck.map(() => '?').join(',');

  const nodesToDelete = db.prepare(
    `SELECT id FROM knowledge_nodes
     WHERE id IN (${placeholders})
       AND document_count <= 0
       AND id NOT IN (SELECT DISTINCT node_id FROM node_entity_links)`,
  ).all(...nodeIdsToCheck) as { id: string }[];

  const nodeIdsToDelete = nodesToDelete.map((r) => r.id);

  // Step 4: Delete edges where at least one endpoint is being deleted
  let edgesDeleted = 0;
  if (nodeIdsToDelete.length > 0) {
    const delPlaceholders = nodeIdsToDelete.map(() => '?').join(',');
    const edgeResult = db.prepare(
      `DELETE FROM knowledge_edges
       WHERE source_node_id IN (${delPlaceholders}) OR target_node_id IN (${delPlaceholders})`,
    ).run(...nodeIdsToDelete, ...nodeIdsToDelete);
    edgesDeleted = edgeResult.changes;
  }

  // Also delete edges where BOTH endpoints now have document_count <= 0
  // (even if those nodes aren't fully orphaned yet)
  const additionalEdgeResult = db.prepare(
    `DELETE FROM knowledge_edges
     WHERE id IN (
       SELECT ke.id FROM knowledge_edges ke
       JOIN knowledge_nodes src ON src.id = ke.source_node_id
       JOIN knowledge_nodes tgt ON tgt.id = ke.target_node_id
       WHERE src.document_count <= 0 AND tgt.document_count <= 0
     )`,
  ).run();
  edgesDeleted += additionalEdgeResult.changes;

  // Step 5: Delete the orphaned nodes
  let nodesDeleted = 0;
  if (nodeIdsToDelete.length > 0) {
    const delPlaceholders = nodeIdsToDelete.map(() => '?').join(',');
    const nodeResult = db.prepare(
      `DELETE FROM knowledge_nodes WHERE id IN (${delPlaceholders})`,
    ).run(...nodeIdsToDelete);
    nodesDeleted = nodeResult.changes;
  }

  return {
    links_deleted: linksDeleted,
    nodes_deleted: nodesDeleted,
    edges_deleted: edgesDeleted,
  };
}

/**
 * Delete all graph data (for rebuild)
 */
export function deleteAllGraphData(db: Database.Database): {
  nodes_deleted: number;
  edges_deleted: number;
  links_deleted: number;
} {
  // Order matters due to FKs: links -> edges -> nodes
  const linksResult = db.prepare('DELETE FROM node_entity_links').run();
  const edgesResult = db.prepare('DELETE FROM knowledge_edges').run();
  const nodesResult = db.prepare('DELETE FROM knowledge_nodes').run();

  return {
    nodes_deleted: nodesResult.changes,
    edges_deleted: edgesResult.changes,
    links_deleted: linksResult.changes,
  };
}

/**
 * Delete graph data for specific documents
 */
export function deleteGraphDataForDocuments(
  db: Database.Database,
  documentIds: string[],
): {
  nodes_deleted: number;
  edges_deleted: number;
  links_deleted: number;
} {
  let totalNodes = 0;
  let totalEdges = 0;
  let totalLinks = 0;

  for (const docId of documentIds) {
    const result = cleanupGraphForDocument(db, docId);
    totalLinks += result.links_deleted;
    totalNodes += result.nodes_deleted;
    totalEdges += result.edges_deleted;
  }

  return {
    nodes_deleted: totalNodes,
    edges_deleted: totalEdges,
    links_deleted: totalLinks,
  };
}
