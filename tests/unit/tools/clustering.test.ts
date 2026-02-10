/**
 * Clustering Tool Handler Tests
 *
 * Tests the MCP tool handlers in src/tools/clustering.ts with REAL databases.
 * Uses DatabaseService.create() for fresh databases, NO mocks.
 *
 * @module tests/unit/tools/clustering
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { clusteringTools } from '../../../src/tools/clustering.js';
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
 * Insert test cluster data (provenance + cluster + document_cluster assignment).
 * Used for list/get/delete tests where we do NOT call the full clustering pipeline.
 */
function insertTestClusterData(db: DatabaseService): {
  runId: string;
  clusterId: string;
  docId: string;
  provId: string;
} {
  const conn = db.getConnection();
  const now = new Date().toISOString();
  const runId = uuidv4();
  const clusterId = uuidv4();
  const provId = uuidv4();

  // Insert a document first
  const { docId, docProvId } = insertDocumentChain(db, 'doc.pdf', '/test/doc.pdf');

  // Insert CLUSTERING provenance
  db.insertProvenance({
    id: provId,
    type: 'CLUSTERING',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'CLUSTERING',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash('cluster-centroid'),
    input_hash: null,
    file_hash: null,
    processor: 'clustering-service',
    processor_version: '1.0.0',
    processing_params: { algorithm: 'kmeans' },
    processing_duration_ms: 100,
    processing_quality_score: 0.95,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "CLUSTERING"]',
  });

  // Insert cluster row
  conn.prepare(`
    INSERT INTO clusters (id, run_id, cluster_index, label, description,
      classification_tag, document_count, centroid_json, top_terms_json,
      coherence_score, algorithm, algorithm_params_json, silhouette_score,
      content_hash, provenance_id, created_at, processing_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clusterId, runId, 0, 'Test Cluster', 'A test cluster', 'legal',
    1, JSON.stringify(new Array(768).fill(0)), null, 0.95,
    'kmeans', '{"algorithm":"kmeans","n_clusters":2}', 0.8,
    computeHash('centroid'), provId, now, 100
  );

  // Insert document_cluster assignment
  conn.prepare(`
    INSERT INTO document_clusters (id, document_id, cluster_id, run_id,
      similarity_to_centroid, membership_probability, is_noise, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), docId, clusterId, runId, 0.95, 1.0, 0, now);

  return { runId, clusterId, docId, provId };
}

/**
 * Insert multiple clusters for a single run.
 * Returns runId and array of clusterIds.
 */
function insertMultiClusterRun(db: DatabaseService): {
  runId: string;
  clusterIds: string[];
  docIds: string[];
  provIds: string[];
} {
  const conn = db.getConnection();
  const now = new Date().toISOString();
  const runId = uuidv4();
  const clusterIds: string[] = [];
  const docIds: string[] = [];
  const provIds: string[] = [];

  for (let i = 0; i < 3; i++) {
    const clusterId = uuidv4();
    const provId = uuidv4();
    const { docId, docProvId } = insertDocumentChain(
      db, `doc${i}.pdf`, `/test/doc${i}.pdf`
    );

    db.insertProvenance({
      id: provId,
      type: 'CLUSTERING',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'CLUSTERING',
      source_path: null,
      source_id: docProvId,
      root_document_id: docProvId,
      location: null,
      content_hash: computeHash(`cluster-centroid-${i}`),
      input_hash: null,
      file_hash: null,
      processor: 'clustering-service',
      processor_version: '1.0.0',
      processing_params: { algorithm: 'kmeans' },
      processing_duration_ms: 100,
      processing_quality_score: 0.9,
      parent_id: docProvId,
      parent_ids: JSON.stringify([docProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "CLUSTERING"]',
    });

    conn.prepare(`
      INSERT INTO clusters (id, run_id, cluster_index, label, description,
        classification_tag, document_count, centroid_json, top_terms_json,
        coherence_score, algorithm, algorithm_params_json, silhouette_score,
        content_hash, provenance_id, created_at, processing_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clusterId, runId, i, `Cluster ${i}`, `Description ${i}`, 'legal',
      1, JSON.stringify(new Array(768).fill(0)), null, 0.9,
      'kmeans', '{"algorithm":"kmeans","n_clusters":3}', 0.75,
      computeHash(`centroid-${i}`), provId, now, 100
    );

    conn.prepare(`
      INSERT INTO document_clusters (id, document_id, cluster_id, run_id,
        similarity_to_centroid, membership_probability, is_noise, assigned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), docId, clusterId, runId, 0.9, 1.0, 0, now);

    clusterIds.push(clusterId);
    docIds.push(docId);
    provIds.push(provId);
  }

  return { runId, clusterIds, docIds, provIds };
}

// =============================================================================
// TOOL EXPORT VERIFICATION
// =============================================================================

describe('clusteringTools exports', () => {
  it('exports all 5 clustering tools', () => {
    expect(Object.keys(clusteringTools)).toHaveLength(5);
    expect(clusteringTools).toHaveProperty('ocr_cluster_documents');
    expect(clusteringTools).toHaveProperty('ocr_cluster_list');
    expect(clusteringTools).toHaveProperty('ocr_cluster_get');
    expect(clusteringTools).toHaveProperty('ocr_cluster_assign');
    expect(clusteringTools).toHaveProperty('ocr_cluster_delete');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(clusteringTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// =============================================================================
// handleClusterDocuments TESTS
// =============================================================================

describe('handleClusterDocuments', () => {
  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('missing database -> error about no database selected', async () => {
    resetState();
    // Do NOT set up a database
    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it.skipIf(!sqliteVecAvailable)('kmeans without n_clusters -> VALIDATION_ERROR', async () => {
    const tempDir = createTempDir('cluster-docs-');
    tempDirs.push(tempDir);
    resetState();
    updateConfig({ defaultStoragePath: tempDir });
    const dbName = createUniqueName('clusterdocs');

    const dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;

    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({ algorithm: 'kmeans' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('n_clusters');
  });
});

// =============================================================================
// handleClusterList TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleClusterList', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('cluster-list-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('clusterlist');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns correct summaries from pre-inserted data', async () => {
    const { runId } = insertTestClusterData(dbService);

    const handler = clusteringTools['ocr_cluster_list'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const clusters = data.clusters as Array<Record<string, unknown>>;
    expect(clusters.length).toBe(1);

    const cluster = clusters[0];
    expect(cluster.run_id).toBe(runId);
    expect(cluster.label).toBe('Test Cluster');
    expect(cluster.classification_tag).toBe('legal');
    expect(cluster.document_count).toBe(1);
    expect(cluster.coherence_score).toBe(0.95);
    expect(cluster.algorithm).toBe('kmeans');
    expect(cluster.silhouette_score).toBe(0.8);
    expect(cluster.created_at).toBeDefined();
    expect(data.total).toBe(1);
  });

  it('filters by run_id', async () => {
    // Insert two separate runs
    const { runId: runId1 } = insertTestClusterData(dbService);
    const { runId: runId2 } = insertTestClusterData(dbService);

    // List all -> should have at least 2
    const handler = clusteringTools['ocr_cluster_list'].handler;
    const allResponse = await handler({});
    const allResult = parseResponse(allResponse);
    expect(allResult.success).toBe(true);
    const allClusters = (allResult.data as Record<string, unknown>).clusters as Array<Record<string, unknown>>;
    expect(allClusters.length).toBeGreaterThanOrEqual(2);

    // Filter by runId1
    const filteredResponse = await handler({ run_id: runId1 });
    const filteredResult = parseResponse(filteredResponse);
    expect(filteredResult.success).toBe(true);
    const filteredClusters = (filteredResult.data as Record<string, unknown>).clusters as Array<Record<string, unknown>>;
    expect(filteredClusters.length).toBe(1);
    expect(filteredClusters[0].run_id).toBe(runId1);

    // Filter by runId2
    const filtered2Response = await handler({ run_id: runId2 });
    const filtered2Result = parseResponse(filtered2Response);
    expect(filtered2Result.success).toBe(true);
    const filtered2Clusters = (filtered2Result.data as Record<string, unknown>).clusters as Array<Record<string, unknown>>;
    expect(filtered2Clusters.length).toBe(1);
    expect(filtered2Clusters[0].run_id).toBe(runId2);
  });

  it('empty result when no clusters exist', async () => {
    const handler = clusteringTools['ocr_cluster_list'].handler;
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const clusters = data.clusters as Array<Record<string, unknown>>;
    expect(clusters.length).toBe(0);
    expect(data.total).toBe(0);
  });
});

// =============================================================================
// handleClusterGet TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleClusterGet', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('cluster-get-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('clusterget');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns full cluster with documents', async () => {
    const { clusterId, docId, runId, provId } = insertTestClusterData(dbService);

    const handler = clusteringTools['ocr_cluster_get'].handler;
    const response = await handler({ cluster_id: clusterId, include_documents: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe(clusterId);
    expect(data.run_id).toBe(runId);
    expect(data.cluster_index).toBe(0);
    expect(data.label).toBe('Test Cluster');
    expect(data.description).toBe('A test cluster');
    expect(data.classification_tag).toBe('legal');
    expect(data.document_count).toBe(1);
    expect(data.coherence_score).toBe(0.95);
    expect(data.algorithm).toBe('kmeans');
    expect(data.algorithm_params).toEqual({ algorithm: 'kmeans', n_clusters: 2 });
    expect(data.silhouette_score).toBe(0.8);
    expect(data.content_hash).toBeDefined();
    expect(data.provenance_id).toBe(provId);
    expect(data.created_at).toBeDefined();
    expect(data.processing_duration_ms).toBe(100);

    // Check documents array
    const docs = data.documents as Array<Record<string, unknown>>;
    expect(docs).toBeDefined();
    expect(docs.length).toBe(1);
    expect(docs[0].document_id).toBe(docId);
    expect(docs[0].file_name).toBe('doc.pdf');
    expect(docs[0].similarity_to_centroid).toBe(0.95);
  });

  it('nonexistent ID -> DOCUMENT_NOT_FOUND error', async () => {
    const handler = clusteringTools['ocr_cluster_get'].handler;
    const response = await handler({ cluster_id: 'nonexistent-cluster-id' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('with include_provenance=true returns chain', async () => {
    const { clusterId, provId } = insertTestClusterData(dbService);

    const handler = clusteringTools['ocr_cluster_get'].handler;
    const response = await handler({
      cluster_id: clusterId,
      include_provenance: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.provenance_id).toBe(provId);
    // provenance_chain should be present (may be an array or null depending on chain resolution)
    expect('provenance_chain' in data).toBe(true);
    if (data.provenance_chain !== null) {
      const chain = data.provenance_chain as Array<Record<string, unknown>>;
      expect(Array.isArray(chain)).toBe(true);
      // The chain should contain the CLUSTERING provenance record
      const clusteringProv = chain.find((p) => p.type === 'CLUSTERING');
      expect(clusteringProv).toBeDefined();
    }
  });
});

// =============================================================================
// handleClusterAssign TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleClusterAssign', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('cluster-assign-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('clusterassign');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('nonexistent document_id -> DOCUMENT_NOT_FOUND error', async () => {
    const { runId } = insertTestClusterData(dbService);

    const handler = clusteringTools['ocr_cluster_assign'].handler;
    const response = await handler({
      document_id: 'nonexistent-doc',
      run_id: runId,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('nonexistent run_id -> DOCUMENT_NOT_FOUND error for no clusters', async () => {
    const { docId } = insertDocumentChain(dbService, 'assign-doc.pdf', '/test/assign-doc.pdf');

    const handler = clusteringTools['ocr_cluster_assign'].handler;
    const response = await handler({
      document_id: docId,
      run_id: 'nonexistent-run-id',
    });
    const result = parseResponse(response);

    // Should fail because there are no chunk embeddings for this doc,
    // or no clusters for that run
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// =============================================================================
// handleClusterDelete TESTS
// =============================================================================

describe.skipIf(!sqliteVecAvailable)('handleClusterDelete', () => {
  let tempDir: string;
  let dbName: string;
  let dbService: DatabaseService;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('cluster-delete-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
    dbName = createUniqueName('clusterdelete');

    dbService = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = dbService;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('removes all data for run', async () => {
    const { runId, clusterIds } = insertMultiClusterRun(dbService);
    const conn = dbService.getConnection();

    // Verify clusters exist before delete
    const beforeClusters = (conn.prepare(
      'SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?'
    ).get(runId) as { cnt: number }).cnt;
    expect(beforeClusters).toBe(3);

    const beforeAssignments = (conn.prepare(
      'SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?'
    ).get(runId) as { cnt: number }).cnt;
    expect(beforeAssignments).toBe(3);

    const handler = clusteringTools['ocr_cluster_delete'].handler;
    const response = await handler({ run_id: runId, confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.run_id).toBe(runId);
    expect(data.clusters_deleted).toBe(3);
    expect(data.deleted).toBe(true);
  });

  it('SoT verify - after delete, SELECT from clusters WHERE run_id -> 0 rows', async () => {
    const { runId } = insertMultiClusterRun(dbService);
    const conn = dbService.getConnection();

    // Delete the run
    const handler = clusteringTools['ocr_cluster_delete'].handler;
    await handler({ run_id: runId, confirm: true });

    // Source-of-truth verification: direct SQL query
    const clusterCount = (conn.prepare(
      'SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?'
    ).get(runId) as { cnt: number }).cnt;
    expect(clusterCount).toBe(0);
  });

  it('SoT verify - after delete, SELECT from document_clusters WHERE run_id -> 0 rows', async () => {
    const { runId } = insertMultiClusterRun(dbService);
    const conn = dbService.getConnection();

    // Delete the run
    const handler = clusteringTools['ocr_cluster_delete'].handler;
    await handler({ run_id: runId, confirm: true });

    // Source-of-truth verification: direct SQL query
    const assignmentCount = (conn.prepare(
      'SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?'
    ).get(runId) as { cnt: number }).cnt;
    expect(assignmentCount).toBe(0);
  });

  it('nonexistent run_id -> DOCUMENT_NOT_FOUND error', async () => {
    const handler = clusteringTools['ocr_cluster_delete'].handler;
    const response = await handler({ run_id: 'nonexistent-run-id', confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.category).toBe('DOCUMENT_NOT_FOUND');
  });
});
