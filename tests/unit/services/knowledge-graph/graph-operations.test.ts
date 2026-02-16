/**
 * Knowledge Graph Operations Tests
 *
 * Tests all CRUD operations, BFS path finding, graph stats, and cascade delete
 * using a REAL SQLite database with full schema v16 migration.
 * NO mocks, NO stubs.
 *
 * @module tests/unit/services/knowledge-graph/graph-operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { migrateToLatest } from '../../../../src/services/storage/migrations/operations.js';
import {
  insertKnowledgeNode,
  getKnowledgeNode,
  updateKnowledgeNode,
  deleteKnowledgeNode,
  listKnowledgeNodes,
  countKnowledgeNodes,
  insertKnowledgeEdge,
  getKnowledgeEdge,
  getEdgesForNode,
  findEdge,
  deleteKnowledgeEdge,
  countKnowledgeEdges,
  getEdgeTypeCounts,
  insertNodeEntityLink,
  getLinksForNode,
  getLinkForEntity,
  countNodeEntityLinks,
  getGraphStats,
  findPaths,
  cleanupGraphForDocument,
  deleteAllGraphData,
  getKnowledgeNodeSummariesByDocument,
} from '../../../../src/services/storage/database/knowledge-graph-operations.js';
import type {
  KnowledgeNode,
  KnowledgeEdge,
  NodeEntityLink,
} from '../../../../src/models/knowledge-graph.js';

// =============================================================================
// SQLITE-VEC AVAILABILITY CHECK
// =============================================================================

function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

// =============================================================================
// HELPERS
// =============================================================================

let tmpDir: string;
let db: Database.Database;

function setupDb(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'kg-ops-'));
  const dbPath = join(tmpDir, 'test.db');
  db = new Database(dbPath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(db);
  migrateToLatest(db);
}

function teardownDb(): void {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const now = new Date().toISOString();

function makeProvenance(id: string, type: string = 'KNOWLEDGE_GRAPH', rootDocId?: string): void {
  db.prepare(
    `
    INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
      content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    type,
    now,
    now,
    type === 'DOCUMENT' ? 'FILE' : type,
    rootDocId ?? id,
    `sha256:${id}`,
    'test',
    '1.0.0',
    '{}',
    '[]',
    type === 'DOCUMENT' ? 0 : 2
  );
}

function makeDocument(docId: string, provId: string): void {
  db.prepare(
    `
    INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type,
      status, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    docId,
    `/test/${docId}.pdf`,
    `${docId}.pdf`,
    `sha256:${docId}`,
    1024,
    'pdf',
    'complete',
    provId,
    now
  );
}

function makeEntity(
  entityId: string,
  docId: string,
  provId: string,
  entityType: string = 'person'
): void {
  db.prepare(
    `
    INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence,
      provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(entityId, docId, entityType, `Entity ${entityId}`, `entity_${entityId}`, 0.9, provId, now);
}

function makeNode(overrides?: Partial<KnowledgeNode>): KnowledgeNode {
  const provId = uuidv4();
  makeProvenance(provId);
  return {
    id: uuidv4(),
    entity_type: 'person',
    canonical_name: 'Test Node',
    normalized_name: 'test node',
    aliases: null,
    document_count: 1,
    mention_count: 1,
    avg_confidence: 0.9,
    metadata: null,
    provenance_id: provId,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeEdge(
  sourceNodeId: string,
  targetNodeId: string,
  overrides?: Partial<KnowledgeEdge>
): KnowledgeEdge {
  const provId = uuidv4();
  makeProvenance(provId);
  return {
    id: uuidv4(),
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    relationship_type: 'co_mentioned',
    weight: 1.0,
    evidence_count: 1,
    document_ids: JSON.stringify(['doc-1']),
    metadata: null,
    provenance_id: provId,
    created_at: now,
    ...overrides,
  };
}

// =============================================================================
// Knowledge Nodes CRUD
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('Knowledge Graph Operations', () => {
  beforeEach(() => {
    setupDb();
  });
  afterEach(() => {
    teardownDb();
  });

  describe('Knowledge Nodes CRUD', () => {
    it('inserts and retrieves a node', () => {
      const node = makeNode({ canonical_name: 'John Smith', normalized_name: 'john smith' });
      insertKnowledgeNode(db, node);

      const retrieved = getKnowledgeNode(db, node.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(node.id);
      expect(retrieved!.canonical_name).toBe('John Smith');
      expect(retrieved!.entity_type).toBe('person');
    });

    it('returns null for nonexistent node', () => {
      const retrieved = getKnowledgeNode(db, 'nonexistent-id');
      expect(retrieved).toBeNull();
    });

    it('updates a node', () => {
      const node = makeNode();
      insertKnowledgeNode(db, node);

      updateKnowledgeNode(db, node.id, {
        document_count: 5,
        mention_count: 10,
        avg_confidence: 0.95,
        aliases: JSON.stringify(['Alias 1', 'Alias 2']),
      });

      const updated = getKnowledgeNode(db, node.id)!;
      expect(updated.document_count).toBe(5);
      expect(updated.mention_count).toBe(10);
      expect(updated.avg_confidence).toBe(0.95);
      expect(JSON.parse(updated.aliases!)).toEqual(['Alias 1', 'Alias 2']);
    });

    it('deletes a node', () => {
      const node = makeNode();
      insertKnowledgeNode(db, node);

      deleteKnowledgeNode(db, node.id);
      expect(getKnowledgeNode(db, node.id)).toBeNull();
    });

    it('lists nodes with filters', () => {
      const nodeA = makeNode({
        entity_type: 'person',
        canonical_name: 'Alice',
        normalized_name: 'alice',
        document_count: 3,
      });
      const nodeB = makeNode({
        entity_type: 'organization',
        canonical_name: 'Acme Corp',
        normalized_name: 'acme corp',
        document_count: 1,
      });
      const nodeC = makeNode({
        entity_type: 'person',
        canonical_name: 'Bob',
        normalized_name: 'bob',
        document_count: 5,
      });
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);
      insertKnowledgeNode(db, nodeC);

      // Filter by entity_type
      const persons = listKnowledgeNodes(db, { entity_type: 'person' });
      expect(persons).toHaveLength(2);

      // Filter by entity_name (LIKE)
      const alice = listKnowledgeNodes(db, { entity_name: 'Alice' });
      expect(alice).toHaveLength(1);
      expect(alice[0].canonical_name).toBe('Alice');

      // Filter by min_document_count
      const highDoc = listKnowledgeNodes(db, { min_document_count: 3 });
      expect(highDoc).toHaveLength(2);
    });

    it('counts nodes', () => {
      expect(countKnowledgeNodes(db)).toBe(0);

      insertKnowledgeNode(db, makeNode());
      insertKnowledgeNode(db, makeNode());
      expect(countKnowledgeNodes(db)).toBe(2);
    });
  });

  // =============================================================================
  // Knowledge Edges CRUD
  // =============================================================================

  describe('Knowledge Edges CRUD', () => {
    it('inserts and retrieves an edge', () => {
      const nodeA = makeNode();
      const nodeB = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);

      const edge = makeEdge(nodeA.id, nodeB.id);
      insertKnowledgeEdge(db, edge);

      const retrieved = getKnowledgeEdge(db, edge.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.source_node_id).toBe(nodeA.id);
      expect(retrieved!.target_node_id).toBe(nodeB.id);
      expect(retrieved!.relationship_type).toBe('co_mentioned');
    });

    it('returns null for nonexistent edge', () => {
      expect(getKnowledgeEdge(db, 'nonexistent')).toBeNull();
    });

    it('gets edges for a node in both directions', () => {
      const nodeA = makeNode();
      const nodeB = makeNode();
      const nodeC = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);
      insertKnowledgeNode(db, nodeC);

      // A -> B and C -> A
      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id));
      insertKnowledgeEdge(db, makeEdge(nodeC.id, nodeA.id));

      const edgesForA = getEdgesForNode(db, nodeA.id);
      expect(edgesForA).toHaveLength(2);
    });

    it('filters edges by relationship_type', () => {
      const nodeA = makeNode();
      const nodeB = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);

      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id, { relationship_type: 'co_mentioned' }));
      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id, { relationship_type: 'co_located' }));

      const coMentioned = getEdgesForNode(db, nodeA.id, { relationship_type: 'co_mentioned' });
      expect(coMentioned).toHaveLength(1);
      expect(coMentioned[0].relationship_type).toBe('co_mentioned');
    });

    it('finds edge by source, target, and type (dedup)', () => {
      const nodeA = makeNode();
      const nodeB = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);

      const edge = makeEdge(nodeA.id, nodeB.id, { relationship_type: 'co_mentioned' });
      insertKnowledgeEdge(db, edge);

      const found = findEdge(db, nodeA.id, nodeB.id, 'co_mentioned');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(edge.id);

      // Not found with different type
      const notFound = findEdge(db, nodeA.id, nodeB.id, 'works_at');
      expect(notFound).toBeNull();
    });

    it('deletes an edge', () => {
      const nodeA = makeNode();
      const nodeB = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);

      const edge = makeEdge(nodeA.id, nodeB.id);
      insertKnowledgeEdge(db, edge);

      deleteKnowledgeEdge(db, edge.id);
      expect(getKnowledgeEdge(db, edge.id)).toBeNull();
    });

    it('counts edges', () => {
      expect(countKnowledgeEdges(db)).toBe(0);

      const nodeA = makeNode();
      const nodeB = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);

      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id));
      expect(countKnowledgeEdges(db)).toBe(1);
    });

    it('gets edge type counts', () => {
      const nodeA = makeNode();
      const nodeB = makeNode();
      const nodeC = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);
      insertKnowledgeNode(db, nodeC);

      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id, { relationship_type: 'co_mentioned' }));
      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeC.id, { relationship_type: 'co_mentioned' }));
      insertKnowledgeEdge(db, makeEdge(nodeB.id, nodeC.id, { relationship_type: 'co_located' }));

      const counts = getEdgeTypeCounts(db);
      expect(counts['co_mentioned']).toBe(2);
      expect(counts['co_located']).toBe(1);
    });
  });

  // =============================================================================
  // Node-Entity Links CRUD
  // =============================================================================

  describe('Node-Entity Links CRUD', () => {
    it('inserts and retrieves links for a node', () => {
      // Create full chain: provenance -> document -> entity -> node -> link
      const docProvId = uuidv4();
      makeProvenance(docProvId, 'DOCUMENT');
      const docId = uuidv4();
      makeDocument(docId, docProvId);

      const entityProvId = uuidv4();
      makeProvenance(entityProvId, 'ENTITY_EXTRACTION', docProvId);
      const entityId = uuidv4();
      makeEntity(entityId, docId, entityProvId);

      const node = makeNode();
      insertKnowledgeNode(db, node);

      const link: NodeEntityLink = {
        id: uuidv4(),
        node_id: node.id,
        entity_id: entityId,
        document_id: docId,
        similarity_score: 0.95,
        created_at: now,
      };
      insertNodeEntityLink(db, link);

      const links = getLinksForNode(db, node.id);
      expect(links).toHaveLength(1);
      expect(links[0].entity_id).toBe(entityId);
      expect(links[0].similarity_score).toBe(0.95);
    });

    it('gets link for entity', () => {
      const docProvId = uuidv4();
      makeProvenance(docProvId, 'DOCUMENT');
      const docId = uuidv4();
      makeDocument(docId, docProvId);

      const entityProvId = uuidv4();
      makeProvenance(entityProvId, 'ENTITY_EXTRACTION', docProvId);
      const entityId = uuidv4();
      makeEntity(entityId, docId, entityProvId);

      const node = makeNode();
      insertKnowledgeNode(db, node);

      const link: NodeEntityLink = {
        id: uuidv4(),
        node_id: node.id,
        entity_id: entityId,
        document_id: docId,
        similarity_score: 1.0,
        created_at: now,
      };
      insertNodeEntityLink(db, link);

      const found = getLinkForEntity(db, entityId);
      expect(found).not.toBeNull();
      expect(found!.node_id).toBe(node.id);

      // Not found for nonexistent entity
      expect(getLinkForEntity(db, 'nonexistent')).toBeNull();
    });

    it('counts links', () => {
      expect(countNodeEntityLinks(db)).toBe(0);
    });
  });

  // =============================================================================
  // BFS Path Finding
  // =============================================================================

  describe('BFS Path Finding', () => {
    // Build a known graph:
    // A -> B -> C -> D
    //       \-> E
    // F (disconnected)
    let nodeA: KnowledgeNode;
    let nodeB: KnowledgeNode;
    let nodeC: KnowledgeNode;
    let nodeD: KnowledgeNode;
    let nodeE: KnowledgeNode;
    let nodeF: KnowledgeNode;

    function buildTestGraph(): void {
      nodeA = makeNode({ canonical_name: 'A', normalized_name: 'a' });
      nodeB = makeNode({ canonical_name: 'B', normalized_name: 'b' });
      nodeC = makeNode({ canonical_name: 'C', normalized_name: 'c' });
      nodeD = makeNode({ canonical_name: 'D', normalized_name: 'd' });
      nodeE = makeNode({ canonical_name: 'E', normalized_name: 'e' });
      nodeF = makeNode({ canonical_name: 'F', normalized_name: 'f' });

      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);
      insertKnowledgeNode(db, nodeC);
      insertKnowledgeNode(db, nodeD);
      insertKnowledgeNode(db, nodeE);
      insertKnowledgeNode(db, nodeF);

      // A -> B
      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id, { relationship_type: 'co_mentioned' }));
      // B -> C
      insertKnowledgeEdge(db, makeEdge(nodeB.id, nodeC.id, { relationship_type: 'co_mentioned' }));
      // C -> D
      insertKnowledgeEdge(db, makeEdge(nodeC.id, nodeD.id, { relationship_type: 'co_mentioned' }));
      // B -> E
      insertKnowledgeEdge(db, makeEdge(nodeB.id, nodeE.id, { relationship_type: 'co_located' }));
    }

    it('finds path from A to D', () => {
      buildTestGraph();
      const paths = findPaths(db, nodeA.id, nodeD.id);

      expect(paths.length).toBeGreaterThanOrEqual(1);
      const shortestPath = paths[0];
      expect(shortestPath.length).toBe(3); // A->B->C->D = 3 edges
      expect(shortestPath.node_ids).toEqual([nodeA.id, nodeB.id, nodeC.id, nodeD.id]);
    });

    it('finds path from A to E', () => {
      buildTestGraph();
      const paths = findPaths(db, nodeA.id, nodeE.id);

      expect(paths.length).toBeGreaterThanOrEqual(1);
      const shortestPath = paths[0];
      expect(shortestPath.length).toBe(2); // A->B->E = 2 edges
      expect(shortestPath.node_ids).toEqual([nodeA.id, nodeB.id, nodeE.id]);
    });

    it('returns no path to unconnected node F', () => {
      buildTestGraph();
      const paths = findPaths(db, nodeA.id, nodeF.id);

      expect(paths).toHaveLength(0);
    });

    it('respects max_hops=1 from A (should not reach D)', () => {
      buildTestGraph();
      const paths = findPaths(db, nodeA.id, nodeD.id, { max_hops: 1 });

      // D is 3 hops from A, so with max_hops=1, no path
      expect(paths).toHaveLength(0);
    });

    it('finds path with max_hops=2 from A to C', () => {
      buildTestGraph();
      const paths = findPaths(db, nodeA.id, nodeC.id, { max_hops: 2 });

      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0].length).toBe(2);
    });

    it('traverses edges bidirectionally', () => {
      buildTestGraph();
      // Path from D to A should work (edges are traversed in both directions)
      const paths = findPaths(db, nodeD.id, nodeA.id);

      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0].node_ids[0]).toBe(nodeD.id);
      expect(paths[0].node_ids[paths[0].node_ids.length - 1]).toBe(nodeA.id);
    });

    it('filters by relationship_type', () => {
      buildTestGraph();
      // B->E is co_located, everything else is co_mentioned
      // With filter = ['co_mentioned'], should not reach E from A
      const pathsToE = findPaths(db, nodeA.id, nodeE.id, { relationship_filter: ['co_mentioned'] });
      expect(pathsToE).toHaveLength(0);

      // With filter including co_located, should reach E
      const pathsWithCoLocated = findPaths(db, nodeA.id, nodeE.id, {
        relationship_filter: ['co_mentioned', 'co_located'],
      });
      expect(pathsWithCoLocated.length).toBeGreaterThanOrEqual(1);
    });

    it('handles self-referential path (source == target)', () => {
      buildTestGraph();
      const paths = findPaths(db, nodeA.id, nodeA.id);
      // Source == target, visited set prevents revisiting source, so no path
      expect(paths).toHaveLength(0);
    });
  });

  // =============================================================================
  // Graph Stats
  // =============================================================================

  describe('Graph Stats', () => {
    it('returns correct stats for empty graph', () => {
      const stats = getGraphStats(db);

      expect(stats.total_nodes).toBe(0);
      expect(stats.total_edges).toBe(0);
      expect(stats.total_links).toBe(0);
      expect(stats.cross_document_nodes).toBe(0);
      expect(stats.most_connected_nodes).toHaveLength(0);
      expect(stats.documents_covered).toBe(0);
      expect(stats.avg_edges_per_node).toBe(0);
    });

    it('returns correct stats for populated graph', () => {
      const nodeA = makeNode({ entity_type: 'person', document_count: 2 });
      const nodeB = makeNode({ entity_type: 'person', document_count: 1 });
      const nodeC = makeNode({ entity_type: 'organization', document_count: 3 });
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);
      insertKnowledgeNode(db, nodeC);

      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id, { relationship_type: 'co_mentioned' }));
      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeC.id, { relationship_type: 'works_at' }));

      const stats = getGraphStats(db);

      expect(stats.total_nodes).toBe(3);
      expect(stats.total_edges).toBe(2);
      expect(stats.nodes_by_type['person']).toBe(2);
      expect(stats.nodes_by_type['organization']).toBe(1);
      expect(stats.edges_by_type['co_mentioned']).toBe(1);
      expect(stats.edges_by_type['works_at']).toBe(1);
      expect(stats.cross_document_nodes).toBe(2); // nodeA (2), nodeC (3)
      expect(stats.most_connected_nodes.length).toBeGreaterThanOrEqual(1);
      // avg_edges_per_node = (2 * 2) / 3 = 1.33
      expect(stats.avg_edges_per_node).toBeCloseTo(1.33, 1);
    });
  });

  // =============================================================================
  // getKnowledgeNodeSummariesByDocument
  // =============================================================================

  describe('getKnowledgeNodeSummariesByDocument', () => {
    it('returns summaries for a document with linked nodes', () => {
      // Create doc chain
      const docProvId = uuidv4();
      makeProvenance(docProvId, 'DOCUMENT');
      const docId = uuidv4();
      makeDocument(docId, docProvId);

      // Create entity
      const entityProvId = uuidv4();
      makeProvenance(entityProvId, 'ENTITY_EXTRACTION', docProvId);
      const entityId = uuidv4();
      makeEntity(entityId, docId, entityProvId);

      // Create node and link
      const node = makeNode({
        canonical_name: 'Test Person',
        entity_type: 'person',
        document_count: 2,
      });
      insertKnowledgeNode(db, node);

      insertNodeEntityLink(db, {
        id: uuidv4(),
        node_id: node.id,
        entity_id: entityId,
        document_id: docId,
        similarity_score: 1.0,
        created_at: now,
      });

      const summaries = getKnowledgeNodeSummariesByDocument(db, docId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].canonical_name).toBe('Test Person');
      expect(summaries[0].entity_type).toBe('person');
      expect(summaries[0].document_count).toBe(2);
    });

    it('returns empty array for document with no linked nodes', () => {
      const summaries = getKnowledgeNodeSummariesByDocument(db, 'nonexistent-doc');
      expect(summaries).toHaveLength(0);
    });
  });

  // =============================================================================
  // Cascade Delete
  // =============================================================================

  describe('Cascade Delete', () => {
    it('cleanupGraphForDocument deletes links and orphaned nodes/edges', () => {
      // Setup: doc -> entity -> node_entity_link -> node, plus edge
      const docProvId = uuidv4();
      makeProvenance(docProvId, 'DOCUMENT');
      const docId = uuidv4();
      makeDocument(docId, docProvId);

      const entityProvId = uuidv4();
      makeProvenance(entityProvId, 'ENTITY_EXTRACTION', docProvId);
      const entityId = uuidv4();
      makeEntity(entityId, docId, entityProvId);

      const nodeA = makeNode({ document_count: 1 });
      const nodeB = makeNode({ document_count: 1 });
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);

      // Link nodeA to doc
      insertNodeEntityLink(db, {
        id: uuidv4(),
        node_id: nodeA.id,
        entity_id: entityId,
        document_id: docId,
        similarity_score: 1.0,
        created_at: now,
      });

      // Edge between A and B
      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id));

      // Before cleanup
      expect(countNodeEntityLinks(db)).toBe(1);
      expect(countKnowledgeNodes(db)).toBe(2);
      expect(countKnowledgeEdges(db)).toBe(1);

      // Cleanup
      const result = cleanupGraphForDocument(db, docId);

      expect(result.links_deleted).toBe(1);
      // nodeA had document_count 1, decremented to 0, no remaining links -> deleted
      expect(result.nodes_deleted).toBe(1);
      // Edge to deleted nodeA should be removed
      expect(result.edges_deleted).toBeGreaterThanOrEqual(1);

      // nodeB is still there (not linked to this doc)
      expect(getKnowledgeNode(db, nodeB.id)).not.toBeNull();
    });

    it('cleanupGraphForDocument preserves cross-document nodes', () => {
      // Create two docs
      const docProv1 = uuidv4();
      makeProvenance(docProv1, 'DOCUMENT');
      const doc1 = uuidv4();
      makeDocument(doc1, docProv1);

      const docProv2 = uuidv4();
      makeProvenance(docProv2, 'DOCUMENT');
      const doc2 = uuidv4();
      makeDocument(doc2, docProv2);

      // Create entities for both docs
      const entProv1 = uuidv4();
      makeProvenance(entProv1, 'ENTITY_EXTRACTION', docProv1);
      const entity1 = uuidv4();
      makeEntity(entity1, doc1, entProv1);

      const entProv2 = uuidv4();
      makeProvenance(entProv2, 'ENTITY_EXTRACTION', docProv2);
      const entity2 = uuidv4();
      makeEntity(entity2, doc2, entProv2);

      // Create a cross-document node
      const crossNode = makeNode({ document_count: 2 });
      insertKnowledgeNode(db, crossNode);

      insertNodeEntityLink(db, {
        id: uuidv4(),
        node_id: crossNode.id,
        entity_id: entity1,
        document_id: doc1,
        similarity_score: 1.0,
        created_at: now,
      });
      insertNodeEntityLink(db, {
        id: uuidv4(),
        node_id: crossNode.id,
        entity_id: entity2,
        document_id: doc2,
        similarity_score: 0.9,
        created_at: now,
      });

      // Delete doc1 data
      const result = cleanupGraphForDocument(db, doc1);

      expect(result.links_deleted).toBe(1);
      // Node should NOT be deleted because it still has a link from doc2
      expect(result.nodes_deleted).toBe(0);
      expect(getKnowledgeNode(db, crossNode.id)).not.toBeNull();
      // Document count decremented
      expect(getKnowledgeNode(db, crossNode.id)!.document_count).toBe(1);
    });

    it('deleteAllGraphData removes everything', () => {
      const nodeA = makeNode();
      const nodeB = makeNode();
      insertKnowledgeNode(db, nodeA);
      insertKnowledgeNode(db, nodeB);
      insertKnowledgeEdge(db, makeEdge(nodeA.id, nodeB.id));

      const result = deleteAllGraphData(db);

      expect(result.nodes_deleted).toBe(2);
      expect(result.edges_deleted).toBe(1);
      expect(countKnowledgeNodes(db)).toBe(0);
      expect(countKnowledgeEdges(db)).toBe(0);
      expect(countNodeEntityLinks(db)).toBe(0);
    });
  });
});
