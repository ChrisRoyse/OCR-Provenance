/**
 * Knowledge Graph Tool Handler Tests
 *
 * Tests the MCP tool handlers in src/tools/knowledge-graph.ts with REAL databases.
 * Uses DatabaseService.create() for fresh databases, NO mocks.
 *
 * @module tests/unit/tools/knowledge-graph
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { knowledgeGraphTools } from '../../../src/tools/knowledge-graph.js';
import {
  state,
  resetState,
  updateConfig,
  clearDatabase,
} from '../../../src/server/state.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { computeHash } from '../../../src/utils/hash.js';

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
// TEST HELPERS
// =============================================================================

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    category: string;
    message: string;
    details?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

function createUniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

// Track all temp directories for final cleanup
const tempDirs: string[] = [];

afterAll(() => {
  resetState();
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

// =============================================================================
// DATA SETUP HELPERS
// =============================================================================

/**
 * Insert a complete document chain: provenance + document
 */
function insertDocumentChain(
  db: DatabaseService,
  fileName: string,
  filePath: string,
): { docId: string; docProvId: string } {
  const docId = uuidv4();
  const docProvId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(filePath);

  db.insertProvenance({
    id: docProvId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: filePath,
    source_id: null,
    root_document_id: docProvId,
    location: null,
    content_hash: fileHash,
    input_hash: null,
    file_hash: fileHash,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  db.insertDocument({
    id: docId,
    file_path: filePath,
    file_name: fileName,
    file_hash: fileHash,
    file_size: 1024,
    file_type: 'pdf',
    status: 'complete',
    page_count: 1,
    provenance_id: docProvId,
    error_message: null,
    ocr_completed_at: now,
  });

  return { docId, docProvId };
}

/**
 * Insert entities for a document (needed for building the knowledge graph)
 */
function insertEntities(
  db: DatabaseService,
  docId: string,
  docProvId: string,
  entities: Array<{ raw_text: string; normalized_text: string; entity_type: string }>,
): string[] {
  const conn = db.getConnection();
  const now = new Date().toISOString();
  const entityIds: string[] = [];

  // Create ENTITY_EXTRACTION provenance
  const entProvId = uuidv4();
  db.insertProvenance({
    id: entProvId,
    type: 'ENTITY_EXTRACTION',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(`entities-${docId}`),
    input_hash: null,
    file_hash: null,
    processor: 'entity-extractor',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 100,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "ENTITY_EXTRACTION"]',
  });

  for (const ent of entities) {
    const entityId = uuidv4();
    conn.prepare(`
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, docId, ent.entity_type, ent.raw_text, ent.normalized_text, 0.9, entProvId, now);
    entityIds.push(entityId);
  }

  return entityIds;
}

/**
 * Insert graph data directly for query/stats/delete tests
 */
function insertTestGraphData(db: DatabaseService): {
  nodeIds: string[];
  edgeIds: string[];
  provId: string;
  docId: string;
} {
  const conn = db.getConnection();
  const now = new Date().toISOString();

  const { docId, docProvId } = insertDocumentChain(db, 'graph-test.pdf', '/test/graph-test.pdf');

  // Create entity
  const entityProvId = uuidv4();
  db.insertProvenance({
    id: entityProvId,
    type: 'ENTITY_EXTRACTION',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash('ent-hash'),
    input_hash: null,
    file_hash: null,
    processor: 'entity-extractor',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 50,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "ENTITY_EXTRACTION"]',
  });

  const entityId1 = uuidv4();
  const entityId2 = uuidv4();
  conn.prepare(`INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id, created_at)
    VALUES (?, ?, 'person', 'Alice', 'alice', 0.9, ?, ?)`).run(entityId1, docId, entityProvId, now);
  conn.prepare(`INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id, created_at)
    VALUES (?, ?, 'organization', 'Acme Corp', 'acme corp', 0.85, ?, ?)`).run(entityId2, docId, entityProvId, now);

  // Create KG provenance
  const provId = uuidv4();
  db.insertProvenance({
    id: provId,
    type: 'KNOWLEDGE_GRAPH',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'KNOWLEDGE_GRAPH',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash('kg-hash'),
    input_hash: null,
    file_hash: null,
    processor: 'knowledge-graph-builder',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 200,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
  });

  // Insert nodes
  const nodeId1 = uuidv4();
  const nodeId2 = uuidv4();
  conn.prepare(`INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
    aliases, document_count, mention_count, avg_confidence, metadata, provenance_id, created_at, updated_at)
    VALUES (?, 'person', 'Alice', 'alice', NULL, 1, 1, 0.9, NULL, ?, ?, ?)`).run(nodeId1, provId, now, now);
  conn.prepare(`INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
    aliases, document_count, mention_count, avg_confidence, metadata, provenance_id, created_at, updated_at)
    VALUES (?, 'organization', 'Acme Corp', 'acme corp', NULL, 1, 1, 0.85, NULL, ?, ?, ?)`).run(nodeId2, provId, now, now);

  // Insert edge
  const edgeId = uuidv4();
  const [srcId, tgtId] = nodeId1 < nodeId2 ? [nodeId1, nodeId2] : [nodeId2, nodeId1];
  conn.prepare(`INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relationship_type,
    weight, evidence_count, document_ids, metadata, provenance_id, created_at)
    VALUES (?, ?, ?, 'co_mentioned', 1.0, 1, ?, NULL, ?, ?)`).run(
    edgeId, srcId, tgtId, JSON.stringify([docId]), provId, now);

  // Insert node-entity links
  conn.prepare(`INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, created_at)
    VALUES (?, ?, ?, ?, 1.0, ?)`).run(uuidv4(), nodeId1, entityId1, docId, now);
  conn.prepare(`INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, created_at)
    VALUES (?, ?, ?, ?, 1.0, ?)`).run(uuidv4(), nodeId2, entityId2, docId, now);

  return { nodeIds: [nodeId1, nodeId2], edgeIds: [edgeId], provId, docId };
}

// =============================================================================
// TOOL EXPORT VERIFICATION
// =============================================================================

describe('knowledgeGraphTools exports', () => {
  it('exports all 12 knowledge graph tools', () => {
    expect(Object.keys(knowledgeGraphTools)).toHaveLength(12);
    expect(knowledgeGraphTools).toHaveProperty('ocr_knowledge_graph_build');
    expect(knowledgeGraphTools).toHaveProperty('ocr_knowledge_graph_query');
    expect(knowledgeGraphTools).toHaveProperty('ocr_knowledge_graph_node');
    expect(knowledgeGraphTools).toHaveProperty('ocr_knowledge_graph_paths');
    expect(knowledgeGraphTools).toHaveProperty('ocr_knowledge_graph_stats');
    expect(knowledgeGraphTools).toHaveProperty('ocr_knowledge_graph_delete');
    expect(knowledgeGraphTools).toHaveProperty('ocr_knowledge_graph_classify_relationships');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(knowledgeGraphTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// =============================================================================
// handleKnowledgeGraphBuild TESTS
// =============================================================================

describe('handleKnowledgeGraphBuild', () => {
  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('missing database -> error about no database selected', async () => {
    resetState();
    const handler = knowledgeGraphTools['ocr_knowledge_graph_build'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('builds graph from entities and returns stats', async () => {
    const tempDir = createTempDir('kg-build-');
    tempDirs.push(tempDir);
    resetState();
    updateConfig({ defaultStoragePath: tempDir });
    const dbName = createUniqueName('kgbuild');

    const dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;

    // Insert document with entities
    const { docId, docProvId } = insertDocumentChain(dbService, 'build-test.pdf', '/test/build-test.pdf');
    insertEntities(dbService, docId, docProvId, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
      { raw_text: 'Acme Corp', normalized_text: 'acme corp', entity_type: 'organization' },
      { raw_text: 'New York', normalized_text: 'new york', entity_type: 'location' },
    ]);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_build'].handler;
    const response = await handler({ resolution_mode: 'exact' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.total_nodes).toBe(3);
    expect(data.entities_resolved).toBe(3);
    expect(data.provenance_id).toBeDefined();
    expect(data.processing_duration_ms).toBeDefined();
    expect(data.resolution_mode).toBe('exact');
  });

  it.skipIf(!sqliteVecAvailable)('errors when no entities exist', async () => {
    const tempDir = createTempDir('kg-build-noent-');
    tempDirs.push(tempDir);
    resetState();
    updateConfig({ defaultStoragePath: tempDir });
    const dbName = createUniqueName('kgbuildnoent');

    const dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;

    const handler = knowledgeGraphTools['ocr_knowledge_graph_build'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// =============================================================================
// handleKnowledgeGraphQuery TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleKnowledgeGraphQuery', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('kg-query-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('kgquery');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns nodes and edges from pre-inserted data', async () => {
    const { nodeIds } = insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_query'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.total_nodes).toBe(2);
    const nodes = data.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);

    const nodeIdSet = new Set(nodes.map(n => n.id));
    expect(nodeIdSet.has(nodeIds[0])).toBe(true);
    expect(nodeIdSet.has(nodeIds[1])).toBe(true);
  });

  it('filters by entity_type', async () => {
    insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_query'].handler;
    const response = await handler({ entity_type: 'person' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const nodes = data.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].entity_type).toBe('person');
  });

  it('filters by entity_name', async () => {
    insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_query'].handler;
    const response = await handler({ entity_name: 'Alice' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const nodes = data.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].canonical_name).toBe('Alice');
  });

  it('empty result when no graph data exists', async () => {
    const handler = knowledgeGraphTools['ocr_knowledge_graph_query'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.total_nodes).toBe(0);
  });
});

// =============================================================================
// handleKnowledgeGraphNode TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleKnowledgeGraphNode', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('kg-node-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('kgnode');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns detailed node info', async () => {
    const { nodeIds } = insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_node'].handler;
    const response = await handler({ node_id: nodeIds[0] });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    expect(node.id).toBe(nodeIds[0]);
    expect(node.canonical_name).toBe('Alice');

    // Should have member_entities
    const members = data.member_entities as Array<Record<string, unknown>>;
    expect(members).toBeDefined();
    expect(members.length).toBeGreaterThanOrEqual(1);

    // Should have edges
    const edges = data.edges as Array<Record<string, unknown>>;
    expect(edges).toBeDefined();
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('nonexistent node_id -> error', async () => {
    const handler = knowledgeGraphTools['ocr_knowledge_graph_node'].handler;
    const response = await handler({ node_id: 'nonexistent-node-id' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// =============================================================================
// handleKnowledgeGraphPaths TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleKnowledgeGraphPaths', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('kg-paths-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('kgpaths');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns paths between two connected nodes', async () => {
    const { nodeIds } = insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_paths'].handler;
    const response = await handler({
      source_entity: nodeIds[0],
      target_entity: nodeIds[1],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.total_paths).toBeGreaterThanOrEqual(1);

    const paths = data.paths as Array<Record<string, unknown>>;
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0].length).toBe(1); // Direct edge = 1 hop
  });

  it('returns paths by entity name', async () => {
    insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_paths'].handler;
    const response = await handler({
      source_entity: 'Alice',
      target_entity: 'Acme Corp',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.total_paths).toBeGreaterThanOrEqual(1);
  });

  it('nonexistent source -> error', async () => {
    const handler = knowledgeGraphTools['ocr_knowledge_graph_paths'].handler;
    const response = await handler({
      source_entity: 'NonexistentEntity',
      target_entity: 'AlsoNonexistent',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// =============================================================================
// handleKnowledgeGraphStats TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleKnowledgeGraphStats', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('kg-stats-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('kgstats');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns statistics for populated graph', async () => {
    insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_stats'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.total_nodes).toBe(2);
    expect(data.total_edges).toBe(1);
    expect(data.total_links).toBe(2);

    const nodesByType = data.nodes_by_type as Record<string, number>;
    expect(nodesByType['person']).toBe(1);
    expect(nodesByType['organization']).toBe(1);

    const edgesByType = data.edges_by_type as Record<string, number>;
    expect(edgesByType['co_mentioned']).toBe(1);

    expect(data.documents_covered).toBe(1);
  });

  it('returns empty statistics for empty graph', async () => {
    const handler = knowledgeGraphTools['ocr_knowledge_graph_stats'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.total_nodes).toBe(0);
    expect(data.total_edges).toBe(0);
    expect(data.total_links).toBe(0);
  });
});

// =============================================================================
// handleKnowledgeGraphDelete TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleKnowledgeGraphDelete', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('kg-delete-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('kgdelete');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('deletes all graph data with confirm=true', async () => {
    insertTestGraphData(dbService);
    const conn = dbService.getConnection();

    // Verify data exists before delete
    const nodesBefore = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number }).cnt;
    expect(nodesBefore).toBe(2);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_delete'].handler;
    const response = await handler({ confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.nodes_deleted).toBe(2);
    expect(data.edges_deleted).toBe(1);
    expect(data.links_deleted).toBe(2);
    expect(data.deleted).toBe(true);
  });

  it('SoT verify - after delete, SELECT from knowledge_nodes -> 0 rows', async () => {
    insertTestGraphData(dbService);
    const conn = dbService.getConnection();

    const handler = knowledgeGraphTools['ocr_knowledge_graph_delete'].handler;
    await handler({ confirm: true });

    const nodeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number }).cnt;
    expect(nodeCount).toBe(0);

    const edgeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }).cnt;
    expect(edgeCount).toBe(0);

    const linkCount = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as { cnt: number }).cnt;
    expect(linkCount).toBe(0);
  });

  it('deletes graph data filtered by document_ids', async () => {
    const { docId } = insertTestGraphData(dbService);

    const handler = knowledgeGraphTools['ocr_knowledge_graph_delete'].handler;
    const response = await handler({
      document_filter: [docId],
      confirm: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.deleted).toBe(true);
    expect(data.links_deleted).toBeGreaterThanOrEqual(1);
  });

  it('missing confirm -> validation error', async () => {
    const handler = knowledgeGraphTools['ocr_knowledge_graph_delete'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});
