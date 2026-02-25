/**
 * Clustering Reassign & Merge Tool Handler Tests
 *
 * Tests for ocr_cluster_reassign and ocr_cluster_merge tools.
 * Uses REAL databases, NO mocks.
 *
 * @module tests/unit/tools/clustering-reassign-merge
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  computeHash,
} from '../../integration/server/helpers.js';
import { clusteringTools } from '../../../src/tools/clustering.js';
import {
  insertCluster,
  insertDocumentCluster,
  getCluster,
  getClusterDocuments,
} from '../../../src/services/storage/database/cluster-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseResult(response: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(response.content[0].text) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { category: string; message: string };
  };
}

/**
 * Create a test cluster with provenance and return its ID.
 */
function createTestCluster(runId: string, clusterIndex: number, documentCount: number = 0): string {
  const { db } = requireDatabase();
  const conn = db.getConnection();

  const provId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: provId }),
    type: ProvenanceType.CLUSTERING,
    chain_depth: 2,
  });

  const clusterId = uuidv4();
  insertCluster(conn, {
    id: clusterId,
    run_id: runId,
    cluster_index: clusterIndex,
    label: `cluster-${clusterIndex}`,
    description: null,
    classification_tag: null,
    document_count: documentCount,
    centroid_json: null,
    top_terms_json: null,
    coherence_score: 0.8,
    algorithm: 'kmeans',
    algorithm_params_json: '{}',
    silhouette_score: 0.7,
    content_hash: computeHash(`cluster-${clusterId}`),
    provenance_id: provId,
    created_at: new Date().toISOString(),
    processing_duration_ms: 100,
  });

  return clusterId;
}

/**
 * Create a test document and assign it to a cluster.
 */
function createTestDocInCluster(clusterId: string, runId: string): string {
  const { db } = requireDatabase();
  const conn = db.getConnection();

  const provId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: provId }),
    type: ProvenanceType.DOCUMENT,
    chain_depth: 0,
  });

  const docId = uuidv4();
  db.insertDocument({
    ...createTestDocument(provId, { id: docId }),
  });

  insertDocumentCluster(conn, {
    id: uuidv4(),
    document_id: docId,
    cluster_id: clusterId,
    run_id: runId,
    similarity_to_centroid: 0.85,
    membership_probability: 1.0,
    is_noise: false,
    assigned_at: new Date().toISOString(),
  });

  return docId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: ocr_cluster_reassign
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)('ocr_cluster_reassign', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-cluster-reassign');

  beforeAll(() => {
    tempDir = createTempDir('test-cluster-reassign-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should reassign a document from one cluster to another', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();
    const runId = uuidv4();

    // Create two clusters
    const cluster1Id = createTestCluster(runId, 0, 1);
    const cluster2Id = createTestCluster(runId, 1, 0);

    // Create a document in cluster1
    const docId = createTestDocInCluster(cluster1Id, runId);

    // Update cluster1 count to reflect the document
    conn.prepare('UPDATE clusters SET document_count = 1 WHERE id = ?').run(cluster1Id);

    const result = await clusteringTools.ocr_cluster_reassign.handler({
      document_id: docId,
      target_cluster_id: cluster2Id,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.document_id).toBe(docId);
    expect(parsed.data!.target_cluster_id).toBe(cluster2Id);
    expect(parsed.data!.old_cluster_id).toBe(cluster1Id);
    expect(parsed.data!.reassigned).toBe(true);

    // Verify database state
    const cluster1 = getCluster(conn, cluster1Id);
    const cluster2 = getCluster(conn, cluster2Id);
    expect(cluster1!.document_count).toBe(0);
    expect(cluster2!.document_count).toBe(1);

    // Verify document is now in cluster2
    const docs = getClusterDocuments(conn, cluster2Id);
    expect(docs.length).toBe(1);
    expect(docs[0].document_id).toBe(docId);
  });

  it('should handle reassigning to the same cluster (no-op)', async () => {
    const runId = uuidv4();
    const clusterId = createTestCluster(runId, 0, 1);
    const docId = createTestDocInCluster(clusterId, runId);

    const result = await clusteringTools.ocr_cluster_reassign.handler({
      document_id: docId,
      target_cluster_id: clusterId,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.reassigned).toBe(false);
    expect(parsed.data!.message).toContain('already in the target cluster');
  });

  it('should fail when document does not exist', async () => {
    const runId = uuidv4();
    const clusterId = createTestCluster(runId, 0);

    const result = await clusteringTools.ocr_cluster_reassign.handler({
      document_id: 'nonexistent-doc-id',
      target_cluster_id: clusterId,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('should fail when target cluster does not exist', async () => {
    const { db } = requireDatabase();
    const provId = uuidv4();
    db.insertProvenance({
      ...createTestProvenance({ id: provId }),
      type: ProvenanceType.DOCUMENT,
      chain_depth: 0,
    });
    const docId = uuidv4();
    db.insertDocument({ ...createTestDocument(provId, { id: docId }) });

    const result = await clusteringTools.ocr_cluster_reassign.handler({
      document_id: docId,
      target_cluster_id: 'nonexistent-cluster-id',
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('should fail when database is not selected', async () => {
    resetState();

    const result = await clusteringTools.ocr_cluster_reassign.handler({
      document_id: 'some-doc',
      target_cluster_id: 'some-cluster',
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DATABASE_NOT_SELECTED');

    // Restore
    selectDatabase(dbName, tempDir);
  });

  it('should assign a document that was not previously in any cluster for this run', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();
    const runId = uuidv4();
    const clusterId = createTestCluster(runId, 0, 0);

    // Create a document NOT assigned to any cluster
    const provId = uuidv4();
    db.insertProvenance({
      ...createTestProvenance({ id: provId }),
      type: ProvenanceType.DOCUMENT,
      chain_depth: 0,
    });
    const docId = uuidv4();
    db.insertDocument({ ...createTestDocument(provId, { id: docId }) });

    const result = await clusteringTools.ocr_cluster_reassign.handler({
      document_id: docId,
      target_cluster_id: clusterId,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.old_cluster_id).toBeNull();
    expect(parsed.data!.reassigned).toBe(true);

    // Verify cluster count incremented
    const cluster = getCluster(conn, clusterId);
    expect(cluster!.document_count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: ocr_cluster_merge
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)('ocr_cluster_merge', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-cluster-merge');

  beforeAll(() => {
    tempDir = createTempDir('test-cluster-merge-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should merge two clusters into one', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();
    const runId = uuidv4();

    // Create two clusters with documents
    const cluster1Id = createTestCluster(runId, 0, 0);
    const cluster2Id = createTestCluster(runId, 1, 0);

    const doc1 = createTestDocInCluster(cluster1Id, runId);
    const doc2 = createTestDocInCluster(cluster2Id, runId);
    const doc3 = createTestDocInCluster(cluster2Id, runId);

    // Update document counts
    conn.prepare('UPDATE clusters SET document_count = 1 WHERE id = ?').run(cluster1Id);
    conn.prepare('UPDATE clusters SET document_count = 2 WHERE id = ?').run(cluster2Id);

    const result = await clusteringTools.ocr_cluster_merge.handler({
      cluster_id_1: cluster1Id,
      cluster_id_2: cluster2Id,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.merged_cluster_id).toBe(cluster1Id);
    expect(parsed.data!.deleted_cluster_id).toBe(cluster2Id);
    expect(parsed.data!.documents_moved).toBe(2);
    expect(parsed.data!.new_document_count).toBe(3);
    expect(parsed.data!.run_id).toBe(runId);

    // Verify cluster2 is deleted
    const cluster2 = getCluster(conn, cluster2Id);
    expect(cluster2).toBeNull();

    // Verify cluster1 has all 3 documents
    const cluster1 = getCluster(conn, cluster1Id);
    expect(cluster1!.document_count).toBe(3);

    // Verify all documents are now in cluster1
    const docs = getClusterDocuments(conn, cluster1Id);
    const docIds = docs.map((d) => d.document_id);
    expect(docIds).toContain(doc1);
    expect(docIds).toContain(doc2);
    expect(docIds).toContain(doc3);
  });

  it('should fail when merging a cluster with itself', async () => {
    const runId = uuidv4();
    const clusterId = createTestCluster(runId, 0);

    const result = await clusteringTools.ocr_cluster_merge.handler({
      cluster_id_1: clusterId,
      cluster_id_2: clusterId,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('VALIDATION_ERROR');
  });

  it('should fail when clusters are from different runs', async () => {
    const runId1 = uuidv4();
    const runId2 = uuidv4();
    const cluster1Id = createTestCluster(runId1, 0);
    const cluster2Id = createTestCluster(runId2, 0);

    const result = await clusteringTools.ocr_cluster_merge.handler({
      cluster_id_1: cluster1Id,
      cluster_id_2: cluster2Id,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('VALIDATION_ERROR');
  });

  it('should fail when first cluster does not exist', async () => {
    const runId = uuidv4();
    const cluster2Id = createTestCluster(runId, 0);

    const result = await clusteringTools.ocr_cluster_merge.handler({
      cluster_id_1: 'nonexistent-cluster-1',
      cluster_id_2: cluster2Id,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('should fail when second cluster does not exist', async () => {
    const runId = uuidv4();
    const cluster1Id = createTestCluster(runId, 0);

    const result = await clusteringTools.ocr_cluster_merge.handler({
      cluster_id_1: cluster1Id,
      cluster_id_2: 'nonexistent-cluster-2',
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('should handle merging when cluster2 has no documents', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();
    const runId = uuidv4();

    const cluster1Id = createTestCluster(runId, 0, 0);
    const cluster2Id = createTestCluster(runId, 1, 0);

    // Add one document to cluster1
    createTestDocInCluster(cluster1Id, runId);
    conn.prepare('UPDATE clusters SET document_count = 1 WHERE id = ?').run(cluster1Id);

    const result = await clusteringTools.ocr_cluster_merge.handler({
      cluster_id_1: cluster1Id,
      cluster_id_2: cluster2Id,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.documents_moved).toBe(0);
    expect(parsed.data!.new_document_count).toBe(1);
  });

  it('should fail when database is not selected', async () => {
    resetState();

    const result = await clusteringTools.ocr_cluster_merge.handler({
      cluster_id_1: 'a',
      cluster_id_2: 'b',
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DATABASE_NOT_SELECTED');

    // Restore
    selectDatabase(dbName, tempDir);
  });
});
