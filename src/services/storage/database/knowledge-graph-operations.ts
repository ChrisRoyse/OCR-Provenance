/**
 * Knowledge graph operations for DatabaseService
 *
 * Handles CRUD operations for knowledge_nodes, knowledge_edges,
 * and node_entity_links tables. Includes graph query functions
 * (BFS path finding, graph stats) and cascade delete helpers.
 */

import Database from 'better-sqlite3';
import type { KnowledgeNode, KnowledgeEdge, NodeEntityLink, RelationshipType } from '../../../models/knowledge-graph.js';
import { runWithForeignKeyCheck, batchedQuery } from './helpers.js';
import { escapeLikePattern } from '../../../utils/validation.js';

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
      aliases, document_count, mention_count, avg_confidence, importance_score,
      metadata, provenance_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      node.importance_score ?? 0,
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
  updates: Partial<Pick<KnowledgeNode, 'document_count' | 'mention_count' | 'avg_confidence' | 'importance_score' | 'aliases' | 'metadata' | 'updated_at'>>,
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
  if (updates.importance_score !== undefined) {
    setClauses.push('importance_score = ?');
    params.push(updates.importance_score);
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
 * List knowledge nodes with optional filters.
 *
 * When entity_name is provided, attempts FTS5 search first for better
 * performance, falling back to LIKE if FTS table is unavailable.
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
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  // Fast path: use FTS5 when entity_name is the primary filter
  // and no document_filter is active (FTS + JOIN is complex)
  if (options?.entity_name && !options?.document_filter?.length) {
    try {
      const sanitized = options.entity_name.replace(/["*()\\+:^-]/g, ' ').trim();
      if (sanitized.length > 0) {
        const ftsConditions: string[] = [];
        const ftsParams: (string | number)[] = [];

        // Base FTS query
        let ftsQuery = `
          SELECT kn.* FROM knowledge_nodes_fts fts
          JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
          WHERE knowledge_nodes_fts MATCH ?`;
        ftsParams.push(sanitized);

        if (options.entity_type) {
          ftsConditions.push('kn.entity_type = ?');
          ftsParams.push(options.entity_type);
        }
        if (options.min_document_count !== undefined) {
          ftsConditions.push('kn.document_count >= ?');
          ftsParams.push(options.min_document_count);
        }
        if (ftsConditions.length > 0) {
          ftsQuery += ` AND ${ftsConditions.join(' AND ')}`;
        }
        ftsQuery += ` ORDER BY rank LIMIT ? OFFSET ?`;
        ftsParams.push(limit, offset);

        const ftsResults = db.prepare(ftsQuery).all(...ftsParams) as KnowledgeNode[];
        if (ftsResults.length > 0) {
          return ftsResults;
        }
        // If FTS returned nothing, fall through to LIKE (handles partial matches)
      }
    } catch {
      // FTS table may not exist in older schemas - fall through to LIKE
    }
  }

  // Standard LIKE-based query path
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.entity_type) {
    conditions.push('kn.entity_type = ?');
    params.push(options.entity_type);
  }

  if (options?.entity_name) {
    conditions.push("kn.canonical_name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(options.entity_name)}%`);
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

  // Maintain edge_count on both endpoint nodes
  db.prepare('UPDATE knowledge_nodes SET edge_count = edge_count + 1 WHERE id = ?').run(edge.source_node_id);
  db.prepare('UPDATE knowledge_nodes SET edge_count = edge_count + 1 WHERE id = ?').run(edge.target_node_id);

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
 * Update just the relationship_type on an edge.
 * Used by the semantic relationship classifier.
 */
export function updateEdgeRelationshipType(
  db: Database.Database,
  edgeId: string,
  newType: RelationshipType,
): void {
  db.prepare('UPDATE knowledge_edges SET relationship_type = ? WHERE id = ?').run(newType, edgeId);
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
 * Delete edge by ID, decrementing edge_count on both endpoint nodes.
 */
export function deleteKnowledgeEdge(
  db: Database.Database,
  id: string,
): void {
  const edge = db.prepare('SELECT source_node_id, target_node_id FROM knowledge_edges WHERE id = ?').get(id) as { source_node_id: string; target_node_id: string } | undefined;
  if (!edge) return;

  db.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(id);
  db.prepare('UPDATE knowledge_nodes SET edge_count = CASE WHEN edge_count > 0 THEN edge_count - 1 ELSE 0 END WHERE id = ?').run(edge.source_node_id);
  db.prepare('UPDATE knowledge_nodes SET edge_count = CASE WHEN edge_count > 0 THEN edge_count - 1 ELSE 0 END WHERE id = ?').run(edge.target_node_id);
}

/**
 * Delete all edges for a node (both directions), decrementing edge_count
 * on connected nodes. The node being deleted does not need its count updated.
 */
export function deleteEdgesForNode(
  db: Database.Database,
  nodeId: string,
): void {
  // Find all connected nodes before deleting edges so we can decrement their counts
  const connectedEdges = db.prepare(
    'SELECT id, source_node_id, target_node_id FROM knowledge_edges WHERE source_node_id = ? OR target_node_id = ?',
  ).all(nodeId, nodeId) as Array<{ id: string; source_node_id: string; target_node_id: string }>;

  // Decrement edge_count on the OTHER endpoint of each edge (not the node being deleted)
  for (const edge of connectedEdges) {
    const otherId = edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id;
    if (otherId !== nodeId) {
      db.prepare(
        'UPDATE knowledge_nodes SET edge_count = CASE WHEN edge_count > 0 THEN edge_count - 1 ELSE 0 END WHERE id = ?',
      ).run(otherId);
    }
  }

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
    INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      link.id,
      link.node_id,
      link.entity_id,
      link.document_id,
      link.similarity_score,
      link.resolution_method,
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

  // Use batched queries to avoid SQLite 999-parameter limit
  const nodes = batchedQuery(nodeIds, (batch) => {
    const placeholders = batch.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM knowledge_nodes WHERE id IN (${placeholders})`,
    ).all(...batch) as KnowledgeNode[];
  });

  // For edges, we need both endpoints in the set. Query edges for batches of source nodes,
  // then filter to ensure target is also in the full set.
  const nodeIdSet = new Set(nodeIds);
  const edges = batchedQuery(nodeIds, (batch) => {
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM knowledge_edges WHERE source_node_id IN (${placeholders})`,
    ).all(...batch) as KnowledgeEdge[];
    return rows.filter(e => nodeIdSet.has(e.target_node_id));
  });

  return { nodes, edges };
}

/**
 * Bidirectional BFS path finding between two nodes.
 * Queries edges per-node during traversal instead of loading all edges into memory.
 * Returns all paths up to max_hops, capped at maxPaths (100).
 *
 * Hard caps prevent OOM on large graphs:
 * - MAX_VISITED_NODES (1000): stops BFS expansion if too many nodes explored
 * - maxPaths (100): stops collecting paths after this count
 * - When either cap is hit, returns what was found with truncated: true
 *
 * The bidirectional approach reduces the search space from O(b^d) to O(b^(d/2))
 * where b is branching factor and d is path depth.
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
  truncated?: boolean;
}> {
  const maxHops = Math.min(options?.max_hops ?? 3, 6);
  const maxPaths = 100;
  const MAX_VISITED_NODES = 1000;

  // Same node: no meaningful path
  if (sourceNodeId === targetNodeId) {
    return [];
  }

  // Query neighbors for a node on-demand instead of loading all edges into memory.
  // This avoids OOM for graphs with 50K+ edges.
  const neighborCache = new Map<string, Array<{ neighbor: string; edgeId: string }>>();

  function getNeighbors(nodeId: string): Array<{ neighbor: string; edgeId: string }> {
    const cached = neighborCache.get(nodeId);
    if (cached) return cached;

    let edgeRows: Array<{ id: string; source_node_id: string; target_node_id: string }>;
    if (options?.relationship_filter && options.relationship_filter.length > 0) {
      const placeholders = options.relationship_filter.map(() => '?').join(',');
      edgeRows = db.prepare(
        `SELECT id, source_node_id, target_node_id FROM knowledge_edges
         WHERE (source_node_id = ? OR target_node_id = ?)
         AND relationship_type IN (${placeholders})`,
      ).all(nodeId, nodeId, ...options.relationship_filter) as typeof edgeRows;
    } else {
      edgeRows = db.prepare(
        `SELECT id, source_node_id, target_node_id FROM knowledge_edges
         WHERE source_node_id = ? OR target_node_id = ?`,
      ).all(nodeId, nodeId) as typeof edgeRows;
    }

    const neighbors: Array<{ neighbor: string; edgeId: string }> = [];
    for (const edge of edgeRows) {
      if (edge.source_node_id === nodeId) {
        neighbors.push({ neighbor: edge.target_node_id, edgeId: edge.id });
      }
      if (edge.target_node_id === nodeId) {
        neighbors.push({ neighbor: edge.source_node_id, edgeId: edge.id });
      }
    }
    neighborCache.set(nodeId, neighbors);
    return neighbors;
  }

  // Bidirectional BFS state
  interface PartialPath {
    nodePath: string[];
    edgePath: string[];
  }

  // Forward: paths from source. Key = frontier node, value = all partial paths reaching it
  const forwardVisited = new Map<string, PartialPath[]>();
  forwardVisited.set(sourceNodeId, [{ nodePath: [sourceNodeId], edgePath: [] }]);
  let forwardFrontier = new Set<string>([sourceNodeId]);

  // Backward: paths from target (stored in reverse). Key = frontier node
  const backwardVisited = new Map<string, PartialPath[]>();
  backwardVisited.set(targetNodeId, [{ nodePath: [targetNodeId], edgePath: [] }]);
  let backwardFrontier = new Set<string>([targetNodeId]);

  const results: Array<{
    length: number;
    node_ids: string[];
    edge_ids: string[];
    truncated?: boolean;
  }> = [];
  const resultKeys = new Set<string>();
  let truncated = false;

  // Total unique nodes visited across both directions
  const allVisitedNodes = new Set<string>([sourceNodeId, targetNodeId]);

  // Expand layer by layer, alternating forward/backward
  let forwardDepth = 0;
  let backwardDepth = 0;

  while (
    (forwardFrontier.size > 0 || backwardFrontier.size > 0) &&
    results.length < maxPaths &&
    forwardDepth + backwardDepth < maxHops
  ) {
    // Hard cap on visited nodes to prevent OOM on dense graphs
    if (allVisitedNodes.size >= MAX_VISITED_NODES) {
      truncated = true;
      break;
    }

    // Expand the smaller frontier for efficiency
    const expandForward = forwardFrontier.size <= backwardFrontier.size
      ? forwardFrontier.size > 0
      : backwardFrontier.size === 0;

    if (expandForward && forwardFrontier.size > 0) {
      const nextFrontier = new Set<string>();
      forwardDepth++;

      for (const nodeId of forwardFrontier) {
        const neighbors = getNeighbors(nodeId);

        const currentPaths = forwardVisited.get(nodeId) ?? [];

        for (const { neighbor, edgeId } of neighbors) {
          for (const partial of currentPaths) {
            // Avoid cycles within this path
            if (partial.nodePath.includes(neighbor)) continue;

            const newNodePath = [...partial.nodePath, neighbor];
            const newEdgePath = [...partial.edgePath, edgeId];

            // Check if backward search has reached this node
            if (backwardVisited.has(neighbor)) {
              // Combine forward + backward paths at meeting node
              const backwardPaths = backwardVisited.get(neighbor)!;
              for (const bPath of backwardPaths) {
                const reversedBackNodes = [...bPath.nodePath].reverse().slice(1);
                const reversedBackEdges = [...bPath.edgePath].reverse();
                const fullNodePath = [...newNodePath, ...reversedBackNodes];
                const fullEdgePath = [...newEdgePath, ...reversedBackEdges];

                if (fullEdgePath.length > maxHops) continue;

                const nodeSet = new Set(fullNodePath);
                if (nodeSet.size !== fullNodePath.length) continue;

                const pathKey = fullNodePath.join('->');
                if (!resultKeys.has(pathKey)) {
                  resultKeys.add(pathKey);
                  results.push({
                    length: fullEdgePath.length,
                    node_ids: fullNodePath,
                    edge_ids: fullEdgePath,
                  });
                  if (results.length >= maxPaths) { truncated = true; break; }
                }
              }
              if (results.length >= maxPaths) break;
            }

            // Store this partial path for future expansion
            if (!forwardVisited.has(neighbor)) {
              forwardVisited.set(neighbor, []);
              nextFrontier.add(neighbor);
              allVisitedNodes.add(neighbor);
            }
            if (forwardDepth + backwardDepth <= maxHops) {
              forwardVisited.get(neighbor)!.push({
                nodePath: newNodePath,
                edgePath: newEdgePath,
              });
              nextFrontier.add(neighbor);
            }
          }
          if (results.length >= maxPaths) break;
        }
        if (results.length >= maxPaths) break;
      }

      forwardFrontier = nextFrontier;
    } else if (backwardFrontier.size > 0) {
      const nextFrontier = new Set<string>();
      backwardDepth++;

      for (const nodeId of backwardFrontier) {
        const neighbors = getNeighbors(nodeId);

        const currentPaths = backwardVisited.get(nodeId) ?? [];

        for (const { neighbor, edgeId } of neighbors) {
          for (const partial of currentPaths) {
            if (partial.nodePath.includes(neighbor)) continue;

            const newNodePath = [...partial.nodePath, neighbor];
            const newEdgePath = [...partial.edgePath, edgeId];

            if (forwardVisited.has(neighbor)) {
              const forwardPaths = forwardVisited.get(neighbor)!;
              for (const fPath of forwardPaths) {
                const reversedBackNodes = [...newNodePath].reverse().slice(1);
                const reversedBackEdges = [...newEdgePath].reverse();
                const fullNodePath = [...fPath.nodePath, ...reversedBackNodes];
                const fullEdgePath = [...fPath.edgePath, ...reversedBackEdges];

                if (fullEdgePath.length > maxHops) continue;

                const nodeSet = new Set(fullNodePath);
                if (nodeSet.size !== fullNodePath.length) continue;

                const pathKey = fullNodePath.join('->');
                if (!resultKeys.has(pathKey)) {
                  resultKeys.add(pathKey);
                  results.push({
                    length: fullEdgePath.length,
                    node_ids: fullNodePath,
                    edge_ids: fullEdgePath,
                  });
                  if (results.length >= maxPaths) { truncated = true; break; }
                }
              }
              if (results.length >= maxPaths) break;
            }

            if (!backwardVisited.has(neighbor)) {
              backwardVisited.set(neighbor, []);
              nextFrontier.add(neighbor);
              allVisitedNodes.add(neighbor);
            }
            if (forwardDepth + backwardDepth <= maxHops) {
              backwardVisited.get(neighbor)!.push({
                nodePath: newNodePath,
                edgePath: newEdgePath,
              });
              nextFrontier.add(neighbor);
            }
          }
          if (results.length >= maxPaths) break;
        }
        if (results.length >= maxPaths) break;
      }

      backwardFrontier = nextFrontier;
    } else {
      break;
    }
  }

  // Sort by path length (shortest first)
  results.sort((a, b) => a.length - b.length);
  const finalResults = results.slice(0, maxPaths);

  // Mark last result with truncated flag if we hit any cap
  if (truncated && finalResults.length > 0) {
    finalResults[finalResults.length - 1].truncated = true;
  }

  return finalResults;
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

  // Most connected nodes (by stored edge_count column)
  const mostConnected = db.prepare(
    `SELECT kn.id, kn.canonical_name, kn.entity_type, kn.document_count, kn.edge_count
     FROM knowledge_nodes kn
     ORDER BY kn.edge_count DESC, kn.document_count DESC
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
    `SELECT kn.id as node_id, kn.canonical_name, kn.entity_type, kn.document_count, kn.edge_count
     FROM knowledge_nodes kn
     JOIN node_entity_links nel ON nel.node_id = kn.id
     WHERE nel.document_id = ?
     GROUP BY kn.id
     ORDER BY kn.edge_count DESC, kn.document_count DESC`,
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
      'UPDATE knowledge_nodes SET document_count = MAX(0, document_count - 1) WHERE id = ?',
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

  // Step 3b: Clean up entity_embeddings for nodes being deleted
  if (nodeIdsToDelete.length > 0) {
    const embPlaceholders = nodeIdsToDelete.map(() => '?').join(',');
    try {
      // Delete vec_entity_embeddings first (references entity_embeddings.id)
      db.prepare(
        `DELETE FROM vec_entity_embeddings WHERE entity_embedding_id IN (
           SELECT id FROM entity_embeddings WHERE node_id IN (${embPlaceholders})
         )`
      ).run(...nodeIdsToDelete);
      // Then delete entity_embeddings
      db.prepare(
        `DELETE FROM entity_embeddings WHERE node_id IN (${embPlaceholders})`
      ).run(...nodeIdsToDelete);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('no such table')) throw e;
    }
  }

  // Step 3c: Decrement edge_count on surviving nodes connected to deleted nodes
  if (nodeIdsToDelete.length > 0) {
    const delPlaceholders = nodeIdsToDelete.map(() => '?').join(',');
    // Find edges where one endpoint is being deleted and the other survives
    const edgesToDelete = db.prepare(
      `SELECT source_node_id, target_node_id FROM knowledge_edges
       WHERE source_node_id IN (${delPlaceholders}) OR target_node_id IN (${delPlaceholders})`
    ).all(...nodeIdsToDelete, ...nodeIdsToDelete) as { source_node_id: string; target_node_id: string }[];

    const nodeIdsToDeleteSet = new Set(nodeIdsToDelete);
    const survivorDecrements = new Map<string, number>();
    for (const edge of edgesToDelete) {
      if (!nodeIdsToDeleteSet.has(edge.source_node_id)) {
        survivorDecrements.set(edge.source_node_id, (survivorDecrements.get(edge.source_node_id) ?? 0) + 1);
      }
      if (!nodeIdsToDeleteSet.has(edge.target_node_id)) {
        survivorDecrements.set(edge.target_node_id, (survivorDecrements.get(edge.target_node_id) ?? 0) + 1);
      }
    }
    const decrementStmt = db.prepare('UPDATE knowledge_nodes SET edge_count = MAX(0, edge_count - ?) WHERE id = ?');
    for (const [nodeId, count] of survivorDecrements) {
      decrementStmt.run(count, nodeId);
    }
  }

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

  // Step 4b: Prune stale document_id from surviving edges' document_ids JSON
  // and recalculate weight proportionally. Edges with empty document_ids are deleted.
  const survivingEdges = db.prepare(
    `SELECT id, document_ids, evidence_count, weight, source_node_id, target_node_id
     FROM knowledge_edges
     WHERE document_ids LIKE ?`,
  ).all(`%${documentId}%`) as Array<{ id: string; document_ids: string; evidence_count: number; weight: number; source_node_id: string; target_node_id: string }>;

  for (const edge of survivingEdges) {
    try {
      const docIds: string[] = JSON.parse(edge.document_ids);
      const filtered = docIds.filter((d: string) => d !== documentId);
      if (filtered.length === 0) {
        // Decrement edge_count on both endpoint nodes before deleting the edge
        db.prepare('UPDATE knowledge_nodes SET edge_count = MAX(0, edge_count - 1) WHERE id = ?').run(edge.source_node_id);
        db.prepare('UPDATE knowledge_nodes SET edge_count = MAX(0, edge_count - 1) WHERE id = ?').run(edge.target_node_id);
        // No documents reference this edge anymore -- delete it
        db.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(edge.id);
        edgesDeleted++;
      } else {
        // Recalculate weight proportionally: scale by remaining/original doc count ratio
        const originalCount = docIds.length;
        const newWeight = originalCount > 0
          ? (edge.weight * filtered.length) / originalCount
          : edge.weight;
        const newEvidenceCount = Math.max(0, edge.evidence_count - 1);
        db.prepare(
          'UPDATE knowledge_edges SET document_ids = ?, evidence_count = ?, weight = ? WHERE id = ?'
        ).run(JSON.stringify(filtered), newEvidenceCount, newWeight, edge.id);
      }
    } catch {
      // Malformed JSON in document_ids -- skip this edge
    }
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
  // Clean up entity_embeddings before deleting nodes
  try {
    db.prepare('DELETE FROM vec_entity_embeddings').run();
    db.prepare('DELETE FROM entity_embeddings').run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('no such table')) throw e;
  }

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

/** Entity info returned per chunk from getEntitiesForChunks */
export interface ChunkEntityInfo {
  node_id: string;
  entity_type: string;
  canonical_name: string;
  aliases: string[];
  confidence: number;
  document_count: number;
}

/**
 * Get knowledge graph entities mentioned in specific chunks.
 * Used to enrich search results with entity context.
 * Includes KG aliases for each entity node.
 *
 * @param db - Database connection
 * @param chunkIds - Array of chunk IDs to look up
 * @returns Map of chunk_id -> array of entity info (with aliases)
 */
export function getEntitiesForChunks(
  db: Database.Database,
  chunkIds: string[],
  minConfidence?: number,
): Map<string, ChunkEntityInfo[]> {
  if (chunkIds.length === 0) return new Map();

  const placeholders = chunkIds.map(() => '?').join(',');
  const confidenceClause = minConfidence != null ? `AND kn.avg_confidence >= ?` : '';
  const params: unknown[] = [...chunkIds];
  if (minConfidence != null) params.push(minConfidence);
  const rows = db.prepare(`
    SELECT em.chunk_id, kn.id as node_id, kn.entity_type, kn.canonical_name,
           kn.aliases as aliases_json, kn.avg_confidence as confidence, kn.document_count
    FROM entity_mentions em
    JOIN entities e ON em.entity_id = e.id
    JOIN node_entity_links nel ON nel.entity_id = e.id
    JOIN knowledge_nodes kn ON nel.node_id = kn.id
    WHERE em.chunk_id IN (${placeholders})
    ${confidenceClause}
  `).all(...params) as Array<{
    chunk_id: string; node_id: string; entity_type: string;
    canonical_name: string; aliases_json: string | null;
    confidence: number; document_count: number;
  }>;

  const result = new Map<string, ChunkEntityInfo[]>();
  for (const row of rows) {
    if (!result.has(row.chunk_id)) result.set(row.chunk_id, []);

    // Parse aliases JSON (stored as JSON string array, e.g. '["alias1","alias2"]')
    let aliases: string[] = [];
    if (row.aliases_json) {
      try {
        const parsed = JSON.parse(row.aliases_json);
        if (Array.isArray(parsed)) {
          aliases = parsed.filter((a: unknown) => typeof a === 'string' && a.length > 0);
        }
      } catch {
        // Malformed JSON - skip aliases
      }
    }

    result.get(row.chunk_id)!.push({
      node_id: row.node_id,
      entity_type: row.entity_type,
      canonical_name: row.canonical_name,
      aliases,
      confidence: row.confidence,
      document_count: row.document_count,
    });
  }
  return result;
}

/**
 * Resolve entity names and types to KG node IDs using a multi-strategy approach:
 *   1. Exact case-insensitive canonical_name match
 *   2. FTS5 MATCH on knowledge_nodes_fts (handles partial/multi-word)
 *   3. Alias JSON LIKE match (when includeAliasSearch is true)
 *
 * After name matching, applies optional entity type filtering (intersection or type-only).
 *
 * Shared core used by getDocumentIdsForEntities and resolveEntityNodeIds (search.ts).
 *
 * @param db - Database connection
 * @param entityNames - Optional array of entity names to match
 * @param entityTypes - Optional array of entity types to filter by
 * @param includeAliasSearch - Whether to include alias JSON LIKE matching (strategy 3)
 * @returns Set of matching KG node IDs
 */
export function resolveEntityNodeIdsFromKG(
  db: Database.Database,
  entityNames?: string[],
  entityTypes?: string[],
  includeAliasSearch: boolean = true,
): Set<string> {
  if (!entityNames?.length && !entityTypes?.length) return new Set();

  const nodeIds = new Set<string>();

  if (entityNames && entityNames.length > 0) {
    for (const name of entityNames) {
      const lowerName = name.toLowerCase();

      // Strategy 1: Exact canonical_name match (case-insensitive)
      const exactRows = db.prepare(
        'SELECT id FROM knowledge_nodes WHERE LOWER(canonical_name) = ?'
      ).all(lowerName) as Array<{ id: string }>;
      for (const row of exactRows) nodeIds.add(row.id);

      // Strategy 2: FTS5 MATCH (handles partial and multi-word)
      try {
        const escaped = name.replace(/["*()\\+:^-]/g, ' ').trim();
        if (escaped.length > 0) {
          const ftsRows = db.prepare(
            `SELECT kn.id FROM knowledge_nodes_fts fts
             JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
             WHERE knowledge_nodes_fts MATCH ?
             LIMIT 20`
          ).all(escaped) as Array<{ id: string }>;
          for (const row of ftsRows) nodeIds.add(row.id);
        }
      } catch {
        // FTS5 table may not exist in older schemas - skip
      }

      // Strategy 3: Alias JSON LIKE match
      if (includeAliasSearch) {
        const aliasRows = db.prepare(
          "SELECT id FROM knowledge_nodes WHERE aliases LIKE ? ESCAPE '\\'"
        ).all(`%${escapeLikePattern(lowerName)}%`) as Array<{ id: string }>;
        for (const row of aliasRows) nodeIds.add(row.id);
      }
    }
  }

  // Apply entity type filter
  if (entityTypes && entityTypes.length > 0) {
    if (nodeIds.size === 0 && !entityNames?.length) {
      // entityTypes is typically small (< 20), no batching needed
      const typePlaceholders = entityTypes.map(() => '?').join(',');
      const typeRows = db.prepare(
        `SELECT id FROM knowledge_nodes WHERE entity_type IN (${typePlaceholders})`
      ).all(...entityTypes) as Array<{ id: string }>;
      for (const row of typeRows) nodeIds.add(row.id);
    } else if (nodeIds.size > 0) {
      // nodeIds can be large -- batch the IN clause
      const nodeIdArray = [...nodeIds];
      const typePlaceholders = entityTypes.map(() => '?').join(',');
      const filteredRows = batchedQuery(nodeIdArray, (batch) => {
        const nodePlaceholders = batch.map(() => '?').join(',');
        return db.prepare(
          `SELECT id FROM knowledge_nodes WHERE id IN (${nodePlaceholders}) AND entity_type IN (${typePlaceholders})`
        ).all(...batch, ...entityTypes) as Array<{ id: string }>;
      });
      nodeIds.clear();
      for (const row of filteredRows) nodeIds.add(row.id);
    }
  }

  return nodeIds;
}

/**
 * Get document IDs containing specified entities.
 * Uses resolveEntityNodeIdsFromKG for node resolution (with alias search enabled),
 * then maps nodes to document IDs via entity links and mentions.
 *
 * When includeRelated is true, performs 1-hop edge traversal to also find
 * documents containing entities related to the matched entities.
 *
 * @param db - Database connection
 * @param entityNames - Optional array of entity names to match (fuzzy)
 * @param entityTypes - Optional array of entity types to match
 * @param includeRelated - When true, traverse 1-hop KG edges to include related entity documents
 * @returns Array of matching document IDs
 */
export function getDocumentIdsForEntities(
  db: Database.Database,
  entityNames?: string[],
  entityTypes?: string[],
  includeRelated?: boolean,
): string[] {
  const nodeIds = resolveEntityNodeIdsFromKG(db, entityNames, entityTypes, true);
  if (nodeIds.size === 0) return [];

  // Get document IDs from matching nodes via entity links (batched to avoid 999-param limit)
  const nodeIdArray = [...nodeIds];
  const docRows = batchedQuery(nodeIdArray, (batch) => {
    const placeholders = batch.map(() => '?').join(',');
    return db.prepare(
      `SELECT DISTINCT em.document_id
       FROM node_entity_links nel
       JOIN entities e ON nel.entity_id = e.id
       JOIN entity_mentions em ON em.entity_id = e.id
       WHERE nel.node_id IN (${placeholders})`
    ).all(...batch) as Array<{ document_id: string }>;
  });

  const documentIds = new Set(docRows.map(r => r.document_id));

  // 1-hop edge traversal for related entities
  if (includeRelated) {
    // Find related node IDs via edges (1-hop neighbors) -- batched
    const relatedNodeIds = new Set<string>();
    const edgeRows = batchedQuery(nodeIdArray, (batch) => {
      const placeholders = batch.map(() => '?').join(',');
      return db.prepare(
        `SELECT DISTINCT source_node_id, target_node_id
         FROM knowledge_edges
         WHERE source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders})`
      ).all(...batch, ...batch) as Array<{ source_node_id: string; target_node_id: string }>;
    });

    for (const row of edgeRows) {
      if (!nodeIds.has(row.target_node_id)) relatedNodeIds.add(row.target_node_id);
      if (!nodeIds.has(row.source_node_id)) relatedNodeIds.add(row.source_node_id);
    }

    // Look up document IDs for related nodes (batched)
    if (relatedNodeIds.size > 0) {
      const relatedArray = [...relatedNodeIds];
      const relatedDocRows = batchedQuery(relatedArray, (batch) => {
        const placeholders = batch.map(() => '?').join(',');
        return db.prepare(
          `SELECT DISTINCT e.document_id
           FROM node_entity_links nel
           JOIN entities e ON nel.entity_id = e.id
           WHERE nel.node_id IN (${placeholders})`
        ).all(...batch) as Array<{ document_id: string }>;
      });

      for (const row of relatedDocRows) {
        documentIds.add(row.document_id);
      }
    }
  }

  return [...documentIds];
}

/**
 * Search knowledge nodes using FTS5 full-text search on canonical_name.
 * Uses the knowledge_nodes_fts virtual table created in schema v17.
 *
 * @param db - Database connection
 * @param query - Search query string
 * @param limit - Maximum results (default 20)
 * @returns Matching nodes with FTS rank scores (lower rank = better match)
 */
export function searchKnowledgeNodesFTS(
  db: Database.Database,
  query: string,
  limit: number = 20,
): Array<{ id: string; entity_type: string; canonical_name: string; document_count: number; edge_count: number; rank: number }> {
  if (!query || query.trim().length === 0) return [];

  // Sanitize query for FTS5: remove quotes and all special FTS5 metacharacters
  const sanitized = query.replace(/["*()\\+:^-]/g, ' ').trim();
  if (sanitized.length === 0) return [];

  try {
    const rows = db.prepare(`
      SELECT kn.id, kn.entity_type, kn.canonical_name, kn.document_count, kn.edge_count,
             rank
      FROM knowledge_nodes_fts fts
      JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
      WHERE knowledge_nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit) as Array<{
      id: string; entity_type: string; canonical_name: string;
      document_count: number; edge_count: number; rank: number;
    }>;

    return rows.map(r => ({ ...r, rank: Math.abs(r.rank) }));
  } catch {
    // FTS table may not exist in older schemas - fall back to LIKE
    return [];
  }
}

/**
 * Get entity mention frequency by document for a set of entity node IDs.
 * Returns a Map of document_id -> total mention count across all matching entities.
 * Used to boost search results that have higher entity mention density.
 *
 * @param conn - Database connection
 * @param documentIds - Document IDs to check
 * @param entityNodeIds - KG node IDs to count mentions for
 * @returns Map<document_id, mention_count>
 */
export function getEntityMentionFrequencyByDocument(
  conn: Database.Database,
  documentIds: string[],
  entityNodeIds: string[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (documentIds.length === 0 || entityNodeIds.length === 0) return result;

  const docPlaceholders = documentIds.map(() => '?').join(',');
  const nodePlaceholders = entityNodeIds.map(() => '?').join(',');

  try {
    const rows = conn.prepare(`
      SELECT em.document_id, COUNT(*) as mention_count
      FROM entity_mentions em
      JOIN entities e ON em.entity_id = e.id
      JOIN node_entity_links nel ON nel.entity_id = e.id
      WHERE em.document_id IN (${docPlaceholders})
        AND nel.node_id IN (${nodePlaceholders})
      GROUP BY em.document_id
    `).all(...documentIds, ...entityNodeIds) as Array<{ document_id: string; mention_count: number }>;

    for (const row of rows) {
      result.set(row.document_id, row.mention_count);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Entity mention frequency query failed: ${msg}`);
  }

  return result;
}

/**
 * Get documents related to a given document by shared knowledge graph entity overlap.
 * Computes Jaccard overlap between the KG node sets of the source document and every
 * other document. Returns ranked list sorted by shared_entity_count descending.
 *
 * @param conn - Database connection
 * @param documentId - Source document ID
 * @param options - Optional limit and minimum shared entity threshold
 * @returns Ranked array of related documents with overlap details
 * @throws Error if no KG data exists for the source document
 */
export function getRelatedDocumentsByEntityOverlap(
  conn: Database.Database,
  documentId: string,
  options?: { limit?: number; min_shared_entities?: number },
): Array<{
  document_id: string;
  file_name: string;
  file_path: string;
  shared_entity_count: number;
  shared_entities: Array<{ node_id: string; canonical_name: string; entity_type: string }>;
  total_edge_weight: number;
  overlap_score: number;
}> {
  const limit = options?.limit ?? 10;
  const minShared = options?.min_shared_entities ?? 1;

  // Get all KG node IDs linked to the source document
  const sourceNodeRows = conn.prepare(`
    SELECT DISTINCT nel.node_id
    FROM node_entity_links nel
    JOIN entities e ON nel.entity_id = e.id
    JOIN entity_mentions em ON em.entity_id = e.id
    WHERE em.document_id = ?
  `).all(documentId) as Array<{ node_id: string }>;

  if (sourceNodeRows.length === 0) {
    throw new Error(
      `No knowledge graph data found for document ${documentId}. Run ocr_entity_extract and ocr_knowledge_graph_build first.`,
    );
  }

  const sourceNodeIds = new Set(sourceNodeRows.map(r => r.node_id));

  // For each OTHER document, find which of these source nodes also appear in it
  const sourceNodeArray = [...sourceNodeIds];
  const nodePlaceholders = sourceNodeArray.map(() => '?').join(',');

  const otherDocRows = conn.prepare(`
    SELECT nel.node_id, em.document_id
    FROM node_entity_links nel
    JOIN entities e ON nel.entity_id = e.id
    JOIN entity_mentions em ON em.entity_id = e.id
    WHERE nel.node_id IN (${nodePlaceholders})
      AND em.document_id != ?
    GROUP BY nel.node_id, em.document_id
  `).all(...sourceNodeArray, documentId) as Array<{ node_id: string; document_id: string }>;

  // Build map: other_document_id -> Set<shared_node_id>
  const docSharedNodes = new Map<string, Set<string>>();
  for (const row of otherDocRows) {
    if (!docSharedNodes.has(row.document_id)) {
      docSharedNodes.set(row.document_id, new Set());
    }
    docSharedNodes.get(row.document_id)!.add(row.node_id);
  }

  // Get total KG node count for each other document (for Jaccard denominator)
  const otherDocIds = [...docSharedNodes.keys()];
  if (otherDocIds.length === 0) {
    return [];
  }

  const otherDocPlaceholders = otherDocIds.map(() => '?').join(',');
  const otherDocNodeCounts = conn.prepare(`
    SELECT em.document_id, COUNT(DISTINCT nel.node_id) as node_count
    FROM node_entity_links nel
    JOIN entities e ON nel.entity_id = e.id
    JOIN entity_mentions em ON em.entity_id = e.id
    WHERE em.document_id IN (${otherDocPlaceholders})
    GROUP BY em.document_id
  `).all(...otherDocIds) as Array<{ document_id: string; node_count: number }>;

  const otherDocNodeCountMap = new Map<string, number>();
  for (const row of otherDocNodeCounts) {
    otherDocNodeCountMap.set(row.document_id, row.node_count);
  }

  // Get node metadata for shared entities
  const allSharedNodeIds = new Set<string>();
  for (const nodeSet of docSharedNodes.values()) {
    for (const nodeId of nodeSet) {
      allSharedNodeIds.add(nodeId);
    }
  }
  const sharedNodeArray = [...allSharedNodeIds];
  const sharedNodePlaceholders = sharedNodeArray.map(() => '?').join(',');
  const nodeMetadataRows = conn.prepare(`
    SELECT id, canonical_name, entity_type
    FROM knowledge_nodes
    WHERE id IN (${sharedNodePlaceholders})
  `).all(...sharedNodeArray) as Array<{ id: string; canonical_name: string; entity_type: string }>;

  const nodeMetadataMap = new Map<string, { canonical_name: string; entity_type: string }>();
  for (const row of nodeMetadataRows) {
    nodeMetadataMap.set(row.id, { canonical_name: row.canonical_name, entity_type: row.entity_type });
  }

  // Get document file info
  const docInfoRows = conn.prepare(`
    SELECT id, file_name, file_path
    FROM documents
    WHERE id IN (${otherDocPlaceholders})
  `).all(...otherDocIds) as Array<{ id: string; file_name: string; file_path: string }>;

  const docInfoMap = new Map<string, { file_name: string; file_path: string }>();
  for (const row of docInfoRows) {
    docInfoMap.set(row.id, { file_name: row.file_name, file_path: row.file_path });
  }

  // Compute edge weights between shared entities
  // Get all edges where both endpoints are in the shared entity set
  let edgeWeightsByPair: Map<string, number>;
  if (sharedNodeArray.length > 0) {
    const edgeRows = conn.prepare(`
      SELECT source_node_id, target_node_id, weight
      FROM knowledge_edges
      WHERE source_node_id IN (${sharedNodePlaceholders})
        AND target_node_id IN (${sharedNodePlaceholders})
    `).all(...sharedNodeArray, ...sharedNodeArray) as Array<{ source_node_id: string; target_node_id: string; weight: number }>;

    edgeWeightsByPair = new Map();
    for (const edge of edgeRows) {
      // Store by both endpoints for easy lookup
      const key1 = `${edge.source_node_id}:${edge.target_node_id}`;
      const key2 = `${edge.target_node_id}:${edge.source_node_id}`;
      edgeWeightsByPair.set(key1, edge.weight);
      edgeWeightsByPair.set(key2, edge.weight);
    }
  } else {
    edgeWeightsByPair = new Map();
  }

  // Build results
  const results: Array<{
    document_id: string;
    file_name: string;
    file_path: string;
    shared_entity_count: number;
    shared_entities: Array<{ node_id: string; canonical_name: string; entity_type: string }>;
    total_edge_weight: number;
    overlap_score: number;
  }> = [];

  const sourceNodeCount = sourceNodeIds.size;

  for (const [docId, sharedNodes] of docSharedNodes.entries()) {
    if (sharedNodes.size < minShared) continue;

    const docInfo = docInfoMap.get(docId);
    if (!docInfo) continue;

    // Build shared entities list
    const sharedEntities: Array<{ node_id: string; canonical_name: string; entity_type: string }> = [];
    for (const nodeId of sharedNodes) {
      const metadata = nodeMetadataMap.get(nodeId);
      if (metadata) {
        sharedEntities.push({ node_id: nodeId, canonical_name: metadata.canonical_name, entity_type: metadata.entity_type });
      }
    }

    // Compute total edge weight between shared entities
    let totalEdgeWeight = 0;
    const sharedNodeList = [...sharedNodes];
    const seenEdges = new Set<string>();
    for (let i = 0; i < sharedNodeList.length; i++) {
      for (let j = i + 1; j < sharedNodeList.length; j++) {
        const key = `${sharedNodeList[i]}:${sharedNodeList[j]}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          const weight = edgeWeightsByPair.get(key);
          if (weight !== undefined) {
            totalEdgeWeight += weight;
          }
        }
      }
    }

    // Jaccard overlap: |intersection| / |union|
    const otherNodeCount = otherDocNodeCountMap.get(docId) ?? sharedNodes.size;
    const unionCount = sourceNodeCount + otherNodeCount - sharedNodes.size;
    const overlapScore = unionCount > 0 ? sharedNodes.size / unionCount : 0;

    results.push({
      document_id: docId,
      file_name: docInfo.file_name,
      file_path: docInfo.file_path,
      shared_entity_count: sharedNodes.size,
      shared_entities: sharedEntities,
      total_edge_weight: Math.round(totalEdgeWeight * 1000) / 1000,
      overlap_score: Math.round(overlapScore * 10000) / 10000,
    });
  }

  // Sort by shared_entity_count descending, then overlap_score descending
  results.sort((a, b) => b.shared_entity_count - a.shared_entity_count || b.overlap_score - a.overlap_score);

  return results.slice(0, limit);
}

/**
 * Get evidence chunks where both entities (from two KG nodes) are mentioned
 * in the same chunk. Proves that an edge between two nodes has textual support.
 *
 * Uses entity_mentions to find chunks shared by entities belonging to each node,
 * then returns chunk text excerpts with document/page info.
 *
 * @param conn - Database connection
 * @param sourceNodeId - First node ID
 * @param targetNodeId - Second node ID
 * @param limit - Maximum chunks to return (default 5)
 * @returns Array of evidence chunks with text excerpts
 */
export function getEvidenceChunksForEdge(
  conn: Database.Database,
  sourceNodeId: string,
  targetNodeId: string,
  limit: number = 5,
): Array<{
  chunk_id: string;
  document_id: string;
  text_excerpt: string;
  page_number: number | null;
  source_file: string;
}> {
  try {
    const rows = conn.prepare(`
      SELECT DISTINCT c.id as chunk_id, c.document_id, SUBSTR(c.text, 1, 500) as text_excerpt,
             c.page_number, d.file_name as source_file
      FROM entity_mentions em1
      JOIN entities e1 ON em1.entity_id = e1.id
      JOIN node_entity_links nel1 ON nel1.entity_id = e1.id AND nel1.node_id = ?
      JOIN entity_mentions em2 ON em2.chunk_id = em1.chunk_id
      JOIN entities e2 ON em2.entity_id = e2.id
      JOIN node_entity_links nel2 ON nel2.entity_id = e2.id AND nel2.node_id = ?
      JOIN chunks c ON c.id = em1.chunk_id
      JOIN documents d ON d.id = c.document_id
      LIMIT ?
    `).all(sourceNodeId, targetNodeId, limit) as Array<{
      chunk_id: string;
      document_id: string;
      text_excerpt: string;
      page_number: number | null;
      source_file: string;
    }>;
    return rows;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Evidence chunk retrieval failed for edge ${sourceNodeId} <-> ${targetNodeId}: ${msg}`);
  }
}

// ============================================================
// Entity Embeddings CRUD
// ============================================================

/**
 * Row shape for entity_embeddings table
 */
export interface EntityEmbeddingRow {
  id: string;
  node_id: string;
  original_text: string;
  original_text_length: number;
  entity_type: string;
  document_count: number;
  model_name: string;
  content_hash: string;
  created_at: string;
  provenance_id: string | null;
}

/**
 * Insert an entity embedding record.
 *
 * @param db - Database connection
 * @param row - Entity embedding data
 * @returns The entity embedding ID
 */
export function insertEntityEmbedding(
  db: Database.Database,
  row: EntityEmbeddingRow,
): string {
  const stmt = db.prepare(`
    INSERT INTO entity_embeddings (id, node_id, original_text, original_text_length,
      entity_type, document_count, model_name, content_hash, created_at, provenance_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      row.id,
      row.node_id,
      row.original_text,
      row.original_text_length,
      row.entity_type,
      row.document_count,
      row.model_name,
      row.content_hash,
      row.created_at,
      row.provenance_id,
    ],
    `inserting entity_embedding: FK violation for node_id="${row.node_id}" or provenance_id="${row.provenance_id}"`,
  );

  return row.id;
}

/**
 * Insert a vector into vec_entity_embeddings virtual table.
 *
 * @param db - Database connection
 * @param entityEmbeddingId - Must match an existing entity_embeddings.id
 * @param vector - 768-dimensional vector as Buffer (from Float32Array)
 */
export function insertVecEntityEmbedding(
  db: Database.Database,
  entityEmbeddingId: string,
  vector: Buffer,
): void {
  db.prepare(
    'INSERT INTO vec_entity_embeddings (entity_embedding_id, vector) VALUES (?, ?)',
  ).run(entityEmbeddingId, vector);
}

/**
 * Delete entity embeddings for a knowledge node (both entity_embeddings and vec_entity_embeddings).
 *
 * @param db - Database connection
 * @param nodeId - Knowledge node ID
 * @returns Count of entity_embeddings records deleted
 */
export function deleteEntityEmbeddingsByNodeId(
  db: Database.Database,
  nodeId: string,
): number {
  // Delete from vec_entity_embeddings first (references entity_embeddings.id)
  db.prepare(
    `DELETE FROM vec_entity_embeddings WHERE entity_embedding_id IN (
       SELECT id FROM entity_embeddings WHERE node_id = ?
     )`,
  ).run(nodeId);

  const result = db.prepare(
    'DELETE FROM entity_embeddings WHERE node_id = ?',
  ).run(nodeId);

  return result.changes;
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
