/**
 * Cluster Operations Tests
 *
 * Tests CRUD operations for the clusters and document_clusters tables
 * via the standalone functions in cluster-operations.ts.
 * Uses REAL databases (better-sqlite3 temp files), NO mocks.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  insertTestProvenance,
  insertTestDocument,
  isSqliteVecAvailable,
} from '../../migrations/helpers.js';
import { migrateToLatest } from '../../../../src/services/storage/migrations/operations.js';
import {
  insertCluster,
  getCluster,
  listClusters,
  deleteClustersByRunId,
  insertDocumentCluster,
  getClusterDocuments,
  getClusterSummariesByRunId,
  getClusterSummariesForDocument,
  getClusteringStats,
} from '../../../../src/services/storage/database/cluster-operations.js';
import { computeEntityOverlapMatrix } from '../../../../src/services/clustering/clustering-service.js';
import { DatabaseService } from '../../../../src/services/storage/database/index.js';
import { computeHash } from '../../../../src/utils/hash.js';
import type { Cluster, DocumentCluster } from '../../../../src/models/cluster.js';

const sqliteVecAvailable = isSqliteVecAvailable();

// ===============================================================================
// HELPERS
// ===============================================================================

let tmpDir: string;
let db: Database.Database;

function setupDatabase(): void {
  tmpDir = createTestDir('cluster-ops-');
  const result = createTestDb(tmpDir);
  db = result.db;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
  } catch {
    // sqlite-vec not available; tests that need it will be skipped
  }
  migrateToLatest(db);
}

/**
 * Build a Cluster object with sensible defaults, overridable.
 */
function buildCluster(provenanceId: string, overrides: Partial<Cluster> = {}): Cluster {
  const id = uuidv4();
  const now = new Date().toISOString();
  return {
    id,
    run_id: uuidv4(),
    cluster_index: 0,
    label: null,
    description: null,
    classification_tag: null,
    document_count: 3,
    centroid_json: JSON.stringify([0.1, 0.2, 0.3]),
    top_terms_json: JSON.stringify(['term1', 'term2']),
    coherence_score: 0.85,
    algorithm: 'hdbscan',
    algorithm_params_json: JSON.stringify({ min_cluster_size: 5 }),
    silhouette_score: 0.72,
    content_hash: `sha256:${id}`,
    provenance_id: provenanceId,
    created_at: now,
    processing_duration_ms: 1500,
    ...overrides,
  };
}

/**
 * Build a DocumentCluster object with sensible defaults, overridable.
 */
function buildDocumentCluster(
  documentId: string,
  clusterId: string | null,
  runId: string,
  overrides: Partial<DocumentCluster> = {}
): DocumentCluster {
  return {
    id: uuidv4(),
    document_id: documentId,
    cluster_id: clusterId,
    run_id: runId,
    similarity_to_centroid: 0.92,
    membership_probability: 0.88,
    is_noise: false,
    assigned_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Insert a CLUSTERING provenance record for test clusters.
 */
function insertClusteringProvenance(rootDocId: string = 'doc-root'): string {
  const provId = uuidv4();
  insertTestProvenance(db, provId, 'CLUSTERING', rootDocId);
  return provId;
}

// ===============================================================================
// TEST SUITE
// ===============================================================================

describe('Cluster Operations', () => {
  beforeEach(() => {
    setupDatabase();
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  // =============================================================================
  // insertCluster
  // =============================================================================

  describe('insertCluster', () => {
    it.skipIf(!sqliteVecAvailable)('stores and retrieves correctly', () => {
      const provId = insertClusteringProvenance();
      const cluster = buildCluster(provId);

      const returnedId = insertCluster(db, cluster);
      expect(returnedId).toBe(cluster.id);

      // Source of Truth: raw SQL verification
      const row = db.prepare('SELECT * FROM clusters WHERE id = ?').get(cluster.id) as Record<
        string,
        unknown
      >;
      expect(row).toBeDefined();
      expect(row.run_id).toBe(cluster.run_id);
      expect(row.cluster_index).toBe(0);
      expect(row.algorithm).toBe('hdbscan');
      expect(row.document_count).toBe(3);
      expect(row.coherence_score).toBe(0.85);
      expect(row.silhouette_score).toBe(0.72);
      expect(row.content_hash).toBe(cluster.content_hash);
      expect(row.provenance_id).toBe(provId);
      expect(row.processing_duration_ms).toBe(1500);
    });

    it.skipIf(!sqliteVecAvailable)('FK violation on bad provenance_id throws', () => {
      const cluster = buildCluster('nonexistent-provenance-id');

      expect(() => insertCluster(db, cluster)).toThrow(/Foreign key violation/);

      // Verify row was NOT inserted
      const row = db.prepare('SELECT * FROM clusters WHERE id = ?').get(cluster.id);
      expect(row).toBeUndefined();
    });
  });

  // =============================================================================
  // getCluster
  // =============================================================================

  describe('getCluster', () => {
    it.skipIf(!sqliteVecAvailable)('returns null for nonexistent ID', () => {
      const result = getCluster(db, 'nonexistent-id');
      expect(result).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('returns full Cluster object with all fields', () => {
      const provId = insertClusteringProvenance();
      const cluster = buildCluster(provId, {
        label: 'Legal contracts',
        description: 'Cluster of contract documents',
        classification_tag: 'contracts',
      });
      insertCluster(db, cluster);

      const result = getCluster(db, cluster.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(cluster.id);
      expect(result!.run_id).toBe(cluster.run_id);
      expect(result!.label).toBe('Legal contracts');
      expect(result!.description).toBe('Cluster of contract documents');
      expect(result!.classification_tag).toBe('contracts');
      expect(result!.centroid_json).toBe(cluster.centroid_json);
      expect(result!.top_terms_json).toBe(cluster.top_terms_json);
      expect(result!.algorithm_params_json).toBe(cluster.algorithm_params_json);
    });
  });

  // =============================================================================
  // listClusters
  // =============================================================================

  describe('listClusters', () => {
    it.skipIf(!sqliteVecAvailable)('filters by run_id', () => {
      const runA = uuidv4();
      const runB = uuidv4();

      const provA = insertClusteringProvenance();
      const provB = insertClusteringProvenance();
      const provC = insertClusteringProvenance();

      insertCluster(db, buildCluster(provA, { run_id: runA }));
      insertCluster(db, buildCluster(provB, { run_id: runA }));
      insertCluster(db, buildCluster(provC, { run_id: runB }));

      const resultsA = listClusters(db, { run_id: runA });
      expect(resultsA.length).toBe(2);
      resultsA.forEach((c) => expect(c.run_id).toBe(runA));

      const resultsB = listClusters(db, { run_id: runB });
      expect(resultsB.length).toBe(1);
      expect(resultsB[0].run_id).toBe(runB);
    });

    it.skipIf(!sqliteVecAvailable)('filters by classification_tag', () => {
      const prov1 = insertClusteringProvenance();
      const prov2 = insertClusteringProvenance();
      const prov3 = insertClusteringProvenance();

      insertCluster(db, buildCluster(prov1, { classification_tag: 'legal' }));
      insertCluster(db, buildCluster(prov2, { classification_tag: 'medical' }));
      insertCluster(db, buildCluster(prov3, { classification_tag: 'legal' }));

      const results = listClusters(db, { classification_tag: 'legal' });
      expect(results.length).toBe(2);
      results.forEach((c) => expect(c.classification_tag).toBe('legal'));
    });

    it.skipIf(!sqliteVecAvailable)('respects limit and offset', () => {
      const provIds = Array.from({ length: 5 }, () => insertClusteringProvenance());
      const runId = uuidv4();
      for (let i = 0; i < 5; i++) {
        insertCluster(
          db,
          buildCluster(provIds[i], {
            run_id: runId,
            cluster_index: i,
            created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
          })
        );
      }

      // limit=2, offset=0 -> 2 most recent
      const page1 = listClusters(db, { run_id: runId, limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      // limit=2, offset=2 -> next 2
      const page2 = listClusters(db, { run_id: runId, limit: 2, offset: 2 });
      expect(page2.length).toBe(2);

      // limit=2, offset=4 -> last 1
      const page3 = listClusters(db, { run_id: runId, limit: 2, offset: 4 });
      expect(page3.length).toBe(1);

      // No overlap between pages
      const allIds = [...page1, ...page2, ...page3].map((c) => c.id);
      expect(new Set(allIds).size).toBe(5);
    });

    it.skipIf(!sqliteVecAvailable)('returns empty array when no clusters exist', () => {
      const results = listClusters(db);
      expect(results).toEqual([]);
    });
  });

  // =============================================================================
  // deleteClustersByRunId
  // =============================================================================

  describe('deleteClustersByRunId', () => {
    it.skipIf(!sqliteVecAvailable)('removes correct clusters and their document_clusters', () => {
      const runToDelete = uuidv4();
      const runToKeep = uuidv4();

      // Setup documents
      const docProvId = uuidv4();
      insertTestProvenance(db, docProvId, 'DOCUMENT', docProvId);
      insertTestDocument(db, 'doc-1', docProvId);

      // Clusters for runToDelete
      const prov1 = insertClusteringProvenance();
      const prov2 = insertClusteringProvenance();
      const cluster1 = buildCluster(prov1, { run_id: runToDelete });
      const cluster2 = buildCluster(prov2, { run_id: runToDelete });
      insertCluster(db, cluster1);
      insertCluster(db, cluster2);

      // Document-cluster assignment in the run to delete
      const dc1 = buildDocumentCluster('doc-1', cluster1.id, runToDelete);
      insertDocumentCluster(db, dc1);

      // Cluster for runToKeep
      const prov3 = insertClusteringProvenance();
      const cluster3 = buildCluster(prov3, { run_id: runToKeep });
      insertCluster(db, cluster3);

      const deletedCount = deleteClustersByRunId(db, runToDelete);
      expect(deletedCount).toBe(2);

      // Verify deleted clusters gone (raw SQL)
      const remaining = db.prepare('SELECT id FROM clusters WHERE run_id = ?').all(runToDelete);
      expect(remaining.length).toBe(0);

      // Verify document_clusters also removed
      const dcRemaining = db
        .prepare('SELECT id FROM document_clusters WHERE run_id = ?')
        .all(runToDelete);
      expect(dcRemaining.length).toBe(0);

      // Verify runToKeep cluster still exists
      const kept = db.prepare('SELECT id FROM clusters WHERE id = ?').get(cluster3.id);
      expect(kept).toBeDefined();
    });
  });

  // =============================================================================
  // insertDocumentCluster
  // =============================================================================

  describe('insertDocumentCluster', () => {
    it.skipIf(!sqliteVecAvailable)('stores assignment with is_noise integer conversion', () => {
      // Setup: document + cluster
      const docProvId = uuidv4();
      insertTestProvenance(db, docProvId, 'DOCUMENT', docProvId);
      insertTestDocument(db, 'doc-1', docProvId);

      const clusterProvId = insertClusteringProvenance();
      const cluster = buildCluster(clusterProvId);
      insertCluster(db, cluster);

      const dc = buildDocumentCluster('doc-1', cluster.id, cluster.run_id, {
        is_noise: false,
        similarity_to_centroid: 0.95,
        membership_probability: 0.88,
      });

      const returnedId = insertDocumentCluster(db, dc);
      expect(returnedId).toBe(dc.id);

      // Source of Truth: raw SQL - is_noise stored as INTEGER 0
      const row = db.prepare('SELECT * FROM document_clusters WHERE id = ?').get(dc.id) as Record<
        string,
        unknown
      >;
      expect(row).toBeDefined();
      expect(row.document_id).toBe('doc-1');
      expect(row.cluster_id).toBe(cluster.id);
      expect(row.is_noise).toBe(0);
      expect(row.similarity_to_centroid).toBe(0.95);
      expect(row.membership_probability).toBe(0.88);
    });

    it.skipIf(!sqliteVecAvailable)(
      'stores noise assignment (is_noise=true, cluster_id=null)',
      () => {
        const docProvId = uuidv4();
        insertTestProvenance(db, docProvId, 'DOCUMENT', docProvId);
        insertTestDocument(db, 'doc-noise', docProvId);

        const dc = buildDocumentCluster('doc-noise', null, uuidv4(), {
          is_noise: true,
          similarity_to_centroid: 0.0,
          membership_probability: 0.0,
        });

        insertDocumentCluster(db, dc);

        // Source of Truth: raw SQL - is_noise stored as INTEGER 1, cluster_id is NULL
        const row = db.prepare('SELECT * FROM document_clusters WHERE id = ?').get(dc.id) as Record<
          string,
          unknown
        >;
        expect(row.is_noise).toBe(1);
        expect(row.cluster_id).toBeNull();
      }
    );
  });

  // =============================================================================
  // getClusterDocuments
  // =============================================================================

  describe('getClusterDocuments', () => {
    it.skipIf(!sqliteVecAvailable)('joins with documents table for file_name', () => {
      // Setup two documents
      const docProvA = uuidv4();
      insertTestProvenance(db, docProvA, 'DOCUMENT', docProvA);
      insertTestDocument(db, 'doc-a', docProvA);

      const docProvB = uuidv4();
      insertTestProvenance(db, docProvB, 'DOCUMENT', docProvB);
      insertTestDocument(db, 'doc-b', docProvB);

      // Create cluster and assign both documents
      const clusterProv = insertClusteringProvenance();
      const cluster = buildCluster(clusterProv);
      insertCluster(db, cluster);

      const dc1 = buildDocumentCluster('doc-a', cluster.id, cluster.run_id, {
        similarity_to_centroid: 0.95,
        membership_probability: 0.9,
      });
      const dc2 = buildDocumentCluster('doc-b', cluster.id, cluster.run_id, {
        similarity_to_centroid: 0.8,
        membership_probability: 0.75,
      });
      insertDocumentCluster(db, dc1);
      insertDocumentCluster(db, dc2);

      const results = getClusterDocuments(db, cluster.id);
      expect(results.length).toBe(2);

      // Ordered by similarity_to_centroid DESC
      expect(results[0].document_id).toBe('doc-a');
      expect(results[0].file_name).toBe('doc-a.pdf');
      expect(results[0].similarity_to_centroid).toBe(0.95);
      expect(results[0].membership_probability).toBe(0.9);

      expect(results[1].document_id).toBe('doc-b');
      expect(results[1].file_name).toBe('doc-b.pdf');
      expect(results[1].similarity_to_centroid).toBe(0.8);
    });

    it.skipIf(!sqliteVecAvailable)('returns empty array for cluster with no documents', () => {
      const results = getClusterDocuments(db, 'nonexistent-cluster');
      expect(results).toEqual([]);
    });
  });

  // =============================================================================
  // getClusterSummariesByRunId
  // =============================================================================

  describe('getClusterSummariesByRunId', () => {
    it.skipIf(!sqliteVecAvailable)('returns summaries without centroid_json', () => {
      const runId = uuidv4();

      const prov1 = insertClusteringProvenance();
      const prov2 = insertClusteringProvenance();

      insertCluster(
        db,
        buildCluster(prov1, {
          run_id: runId,
          cluster_index: 0,
          label: 'Cluster A',
          classification_tag: 'legal',
          coherence_score: 0.9,
        })
      );
      insertCluster(
        db,
        buildCluster(prov2, {
          run_id: runId,
          cluster_index: 1,
          label: 'Cluster B',
          classification_tag: 'medical',
          coherence_score: 0.8,
        })
      );

      const summaries = getClusterSummariesByRunId(db, runId);
      expect(summaries.length).toBe(2);

      // Ordered by cluster_index ASC
      expect(summaries[0].cluster_index).toBe(0);
      expect(summaries[0].label).toBe('Cluster A');
      expect(summaries[0].classification_tag).toBe('legal');
      expect(summaries[0].coherence_score).toBe(0.9);

      expect(summaries[1].cluster_index).toBe(1);
      expect(summaries[1].label).toBe('Cluster B');

      // Summaries should NOT contain centroid_json or top_terms_json
      summaries.forEach((s) => {
        expect(s).not.toHaveProperty('centroid_json');
        expect(s).not.toHaveProperty('top_terms_json');
        expect(s).not.toHaveProperty('algorithm_params_json');
      });
    });

    it.skipIf(!sqliteVecAvailable)('returns empty array for unknown run_id', () => {
      const summaries = getClusterSummariesByRunId(db, 'nonexistent-run');
      expect(summaries).toEqual([]);
    });
  });

  // =============================================================================
  // getClusterSummariesForDocument
  // =============================================================================

  describe('getClusterSummariesForDocument', () => {
    it.skipIf(!sqliteVecAvailable)('returns clusters containing this document', () => {
      const docProvId = uuidv4();
      insertTestProvenance(db, docProvId, 'DOCUMENT', docProvId);
      insertTestDocument(db, 'doc-summary', docProvId);

      const runId1 = uuidv4();
      const runId2 = uuidv4();

      const prov1 = insertClusteringProvenance();
      const cluster1 = buildCluster(prov1, { run_id: runId1, label: 'Run1 Cluster' });
      insertCluster(db, cluster1);

      const prov2 = insertClusteringProvenance();
      const cluster2 = buildCluster(prov2, { run_id: runId2, label: 'Run2 Cluster' });
      insertCluster(db, cluster2);

      // Assign document to both clusters
      insertDocumentCluster(db, buildDocumentCluster('doc-summary', cluster1.id, runId1));
      insertDocumentCluster(db, buildDocumentCluster('doc-summary', cluster2.id, runId2));

      const summaries = getClusterSummariesForDocument(db, 'doc-summary');
      expect(summaries.length).toBe(2);

      // Summaries should be lightweight (no JSON blobs)
      summaries.forEach((s) => {
        expect(s).toHaveProperty('id');
        expect(s).toHaveProperty('run_id');
        expect(s).toHaveProperty('label');
        expect(s).not.toHaveProperty('centroid_json');
      });
    });

    it.skipIf(!sqliteVecAvailable)(
      'does not include noise assignments (cluster_id is NULL)',
      () => {
        const docProvId = uuidv4();
        insertTestProvenance(db, docProvId, 'DOCUMENT', docProvId);
        insertTestDocument(db, 'doc-noise-test', docProvId);

        // Noise assignment (no cluster_id)
        insertDocumentCluster(
          db,
          buildDocumentCluster('doc-noise-test', null, uuidv4(), { is_noise: true })
        );

        // This should not return anything since there is no cluster to join with
        const summaries = getClusterSummariesForDocument(db, 'doc-noise-test');
        expect(summaries.length).toBe(0);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'returns empty array for document with no cluster assignments',
      () => {
        const summaries = getClusterSummariesForDocument(db, 'nonexistent-doc');
        expect(summaries).toEqual([]);
      }
    );
  });

  // =============================================================================
  // getClusteringStats
  // =============================================================================

  describe('getClusteringStats', () => {
    it.skipIf(!sqliteVecAvailable)('returns correct totals and averages', () => {
      const run1 = uuidv4();
      const run2 = uuidv4();

      const prov1 = insertClusteringProvenance();
      const prov2 = insertClusteringProvenance();
      const prov3 = insertClusteringProvenance();

      insertCluster(db, buildCluster(prov1, { run_id: run1, coherence_score: 0.8 }));
      insertCluster(db, buildCluster(prov2, { run_id: run1, coherence_score: 0.9 }));
      insertCluster(db, buildCluster(prov3, { run_id: run2, coherence_score: 0.7 }));

      const stats = getClusteringStats(db);
      expect(stats.total_clusters).toBe(3);
      expect(stats.total_runs).toBe(2);
      expect(stats.avg_coherence).toBeCloseTo(0.8, 5);
    });

    it.skipIf(!sqliteVecAvailable)('returns zeros and null for empty database', () => {
      const stats = getClusteringStats(db);
      expect(stats.total_clusters).toBe(0);
      expect(stats.total_runs).toBe(0);
      expect(stats.avg_coherence).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('handles null coherence_score values', () => {
      const prov1 = insertClusteringProvenance();
      const prov2 = insertClusteringProvenance();

      insertCluster(db, buildCluster(prov1, { coherence_score: null }));
      insertCluster(db, buildCluster(prov2, { coherence_score: 0.9 }));

      const stats = getClusteringStats(db);
      expect(stats.total_clusters).toBe(2);
      // AVG should only consider non-null values
      expect(stats.avg_coherence).toBeCloseTo(0.9, 5);
    });
  });
});

// =============================================================================
// Entity Overlap Matrix (merged from entity-overlap.test.ts)
// =============================================================================

const overlapTempDirs: string[] = [];

afterAll(() => {
  for (const dir of overlapTempDirs) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
});

function insertDocumentChain(
  dbSvc: DatabaseService,
  fileName: string,
  filePath: string
): { docId: string; docProvId: string } {
  const docId = uuidv4();
  const docProvId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(filePath);

  dbSvc.insertProvenance({
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

  dbSvc.insertDocument({
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

function createOverlapKGProvenance(dbSvc: DatabaseService, rootProvId: string): string {
  const provId = uuidv4();
  const now = new Date().toISOString();
  dbSvc.insertProvenance({
    id: provId,
    type: 'KNOWLEDGE_GRAPH',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'KNOWLEDGE_GRAPH',
    source_path: null,
    source_id: rootProvId,
    root_document_id: rootProvId,
    location: null,
    content_hash: computeHash(`kg-${provId}`),
    input_hash: null,
    file_hash: null,
    processor: 'knowledge-graph-builder',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 50,
    processing_quality_score: null,
    parent_id: rootProvId,
    parent_ids: JSON.stringify([rootProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
  });
  return provId;
}

function createKGNodeForDoc(
  conn: Database.Database,
  provId: string,
  docId: string,
  canonicalName: string,
  entityType: string
): string {
  const nodeId = uuidv4();
  const now = new Date().toISOString();

  conn
    .prepare(
      `
    INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
      aliases, document_count, mention_count, edge_count, avg_confidence, metadata,
      provenance_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      nodeId,
      entityType,
      canonicalName,
      canonicalName.toLowerCase(),
      null,
      1,
      1,
      0,
      0.9,
      null,
      provId,
      now,
      now
    );

  const entityId = uuidv4();
  conn
    .prepare(
      `
    INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
      confidence, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(entityId, docId, entityType, canonicalName, canonicalName.toLowerCase(), 0.9, provId, now);

  conn
    .prepare(
      `
    INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(uuidv4(), nodeId, entityId, docId, 1.0, 'exact', now);

  return nodeId;
}

describe('Entity Overlap Computation', () => {
  let overlapTmpDir: string;
  let dbService: DatabaseService;
  let conn: Database.Database;

  beforeEach(() => {
    overlapTmpDir = mkdtempSync(join(tmpdir(), 'entity-overlap-'));
    overlapTempDirs.push(overlapTmpDir);
    const dbName = `overlap-test-${Date.now()}`;
    dbService = DatabaseService.create(dbName, undefined, overlapTmpDir);
    conn = dbService.getConnection();
  });

  afterEach(() => {
    dbService?.close();
  });

  it.skipIf(!sqliteVecAvailable)('throws when no KG data exists for any document', () => {
    const doc1 = insertDocumentChain(dbService, 'a.pdf', '/test/a.pdf');
    const doc2 = insertDocumentChain(dbService, 'b.pdf', '/test/b.pdf');

    expect(() => computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId])).toThrow(
      'entity_weight > 0 but no knowledge graph data found'
    );
  });

  it.skipIf(!sqliteVecAvailable)('self-overlap is always 1.0', () => {
    const doc1 = insertDocumentChain(dbService, 'self.pdf', '/test/self.pdf');
    const doc2 = insertDocumentChain(dbService, 'other.pdf', '/test/other.pdf');
    const kgProvId = createOverlapKGProvenance(dbService, doc1.docProvId);

    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alice', 'person');
    createKGNodeForDoc(conn, kgProvId, doc2.docId, 'Bob', 'person');

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    expect(matrix[0][0]).toBe(1.0);
    expect(matrix[1][1]).toBe(1.0);
  });

  it.skipIf(!sqliteVecAvailable)('matrix is symmetric', () => {
    const doc1 = insertDocumentChain(dbService, 'sym1.pdf', '/test/sym1.pdf');
    const doc2 = insertDocumentChain(dbService, 'sym2.pdf', '/test/sym2.pdf');
    const kgProvId = createOverlapKGProvenance(dbService, doc1.docProvId);

    const sharedNodeId = createKGNodeForDoc(
      conn,
      kgProvId,
      doc1.docId,
      'SharedCorp',
      'organization'
    );
    const entityId2 = uuidv4();
    const now = new Date().toISOString();
    conn
      .prepare(
        `
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(entityId2, doc2.docId, 'organization', 'SharedCorp', 'sharedcorp', 0.9, kgProvId, now);
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), sharedNodeId, entityId2, doc2.docId, 1.0, 'exact', now);

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    expect(matrix[0][1]).toBe(matrix[1][0]);
  });

  it.skipIf(!sqliteVecAvailable)('no shared nodes yields 0 overlap', () => {
    const doc1 = insertDocumentChain(dbService, 'no-share1.pdf', '/test/no-share1.pdf');
    const doc2 = insertDocumentChain(dbService, 'no-share2.pdf', '/test/no-share2.pdf');
    const kgProvId = createOverlapKGProvenance(dbService, doc1.docProvId);

    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alice', 'person');
    createKGNodeForDoc(conn, kgProvId, doc2.docId, 'Bob', 'person');

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    expect(matrix[0][1]).toBe(0);
    expect(matrix[1][0]).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('shared node yields correct overlap ratio', () => {
    const doc1 = insertDocumentChain(dbService, 'ratio1.pdf', '/test/ratio1.pdf');
    const doc2 = insertDocumentChain(dbService, 'ratio2.pdf', '/test/ratio2.pdf');
    const kgProvId = createOverlapKGProvenance(dbService, doc1.docProvId);
    const now = new Date().toISOString();

    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alice', 'person');
    const sharedNodeId = createKGNodeForDoc(
      conn,
      kgProvId,
      doc1.docId,
      'SharedCorp',
      'organization'
    );

    const entityId2 = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(entityId2, doc2.docId, 'organization', 'SharedCorp', 'sharedcorp', 0.9, kgProvId, now);
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), sharedNodeId, entityId2, doc2.docId, 1.0, 'exact', now);

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    // |shared| = 1, max(|doc1_nodes|, |doc2_nodes|) = max(2, 1) = 2
    // overlap = 1 / 2 = 0.5
    expect(matrix[0][1]).toBe(0.5);
    expect(matrix[1][0]).toBe(0.5);
  });

  it.skipIf(!sqliteVecAvailable)('3x3 matrix for three documents', () => {
    const doc1 = insertDocumentChain(dbService, 'd1.pdf', '/test/d1.pdf');
    const doc2 = insertDocumentChain(dbService, 'd2.pdf', '/test/d2.pdf');
    const doc3 = insertDocumentChain(dbService, 'd3.pdf', '/test/d3.pdf');
    const kgProvId = createOverlapKGProvenance(dbService, doc1.docProvId);

    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alpha', 'person');
    createKGNodeForDoc(conn, kgProvId, doc2.docId, 'Beta', 'person');
    createKGNodeForDoc(conn, kgProvId, doc3.docId, 'Gamma', 'person');

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId, doc3.docId]);

    expect(matrix.length).toBe(3);
    expect(matrix[0].length).toBe(3);
    expect(matrix[1].length).toBe(3);
    expect(matrix[2].length).toBe(3);

    expect(matrix[0][0]).toBe(1.0);
    expect(matrix[1][1]).toBe(1.0);
    expect(matrix[2][2]).toBe(1.0);

    expect(matrix[0][1]).toBe(0);
    expect(matrix[0][2]).toBe(0);
    expect(matrix[1][2]).toBe(0);
  });
});
