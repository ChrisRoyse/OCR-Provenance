/**
 * Cluster operations for DatabaseService
 *
 * Handles CRUD operations for the clusters and document_clusters tables.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Cluster, DocumentCluster } from '../../../models/cluster.js';
import { runWithForeignKeyCheck } from './helpers.js';

// --- Cluster CRUD ---

/**
 * Insert a cluster record
 */
export function insertCluster(db: Database.Database, cluster: Cluster): string {
  const stmt = db.prepare(`
    INSERT INTO clusters (id, run_id, cluster_index, label, description,
      classification_tag, document_count, centroid_json, top_terms_json,
      coherence_score, algorithm, algorithm_params_json, silhouette_score,
      content_hash, provenance_id, created_at, processing_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      cluster.id,
      cluster.run_id,
      cluster.cluster_index,
      cluster.label,
      cluster.description,
      cluster.classification_tag,
      cluster.document_count,
      cluster.centroid_json,
      cluster.top_terms_json,
      cluster.coherence_score,
      cluster.algorithm,
      cluster.algorithm_params_json,
      cluster.silhouette_score,
      cluster.content_hash,
      cluster.provenance_id,
      cluster.created_at,
      cluster.processing_duration_ms,
    ],
    `inserting cluster: FK violation for provenance_id="${cluster.provenance_id}"`
  );

  return cluster.id;
}

/**
 * Get a cluster by ID
 */
export function getCluster(db: Database.Database, id: string): Cluster | null {
  const row = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id) as Cluster | undefined;
  return row ?? null;
}

/**
 * List clusters with optional filters and pagination
 */
export function listClusters(
  db: Database.Database,
  options?: { run_id?: string; classification_tag?: string; limit?: number; offset?: number }
): Cluster[] {
  const params: (string | number)[] = [];
  const conditions: string[] = [];

  if (options?.run_id) {
    conditions.push('run_id = ?');
    params.push(options.run_id);
  }

  if (options?.classification_tag) {
    conditions.push('classification_tag = ?');
    params.push(options.classification_tag);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(options?.limit ?? 50, options?.offset ?? 0);

  return db.prepare(
    `SELECT * FROM clusters ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params) as Cluster[];
}

/**
 * Delete all clusters and their document assignments for a run.
 * First deletes document_clusters, then clusters.
 * Returns the number of clusters deleted.
 */
export function deleteClustersByRunId(db: Database.Database, runId: string): number {
  db.prepare('DELETE FROM document_clusters WHERE run_id = ?').run(runId);
  const result = db.prepare('DELETE FROM clusters WHERE run_id = ?').run(runId);
  return result.changes;
}

// --- DocumentCluster CRUD ---

/**
 * Insert a document-cluster assignment
 */
export function insertDocumentCluster(db: Database.Database, dc: DocumentCluster): string {
  const stmt = db.prepare(`
    INSERT INTO document_clusters (id, document_id, cluster_id, run_id,
      similarity_to_centroid, membership_probability, is_noise, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      dc.id,
      dc.document_id,
      dc.cluster_id,
      dc.run_id,
      dc.similarity_to_centroid,
      dc.membership_probability,
      dc.is_noise ? 1 : 0,
      dc.assigned_at,
    ],
    `inserting document_cluster: FK violation for document_id="${dc.document_id}" or cluster_id="${dc.cluster_id}"`
  );

  return dc.id;
}

/**
 * Get all documents in a cluster, joined with documents for file_name
 */
export function getClusterDocuments(
  db: Database.Database,
  clusterId: string
): Array<{
  document_id: string;
  file_name: string;
  similarity_to_centroid: number;
  membership_probability: number;
}> {
  return db.prepare(
    `SELECT dc.document_id, d.file_name, dc.similarity_to_centroid, dc.membership_probability
     FROM document_clusters dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.cluster_id = ?
     ORDER BY dc.similarity_to_centroid DESC`
  ).all(clusterId) as Array<{
    document_id: string;
    file_name: string;
    similarity_to_centroid: number;
    membership_probability: number;
  }>;
}

// --- Summaries ---

/**
 * Lightweight cluster summary (excludes large JSON fields)
 */
interface ClusterSummary {
  id: string;
  run_id: string;
  cluster_index: number;
  label: string | null;
  classification_tag: string | null;
  document_count: number;
  coherence_score: number | null;
  created_at: string;
}

/**
 * Get cluster summaries for a run (lightweight: no JSON blobs)
 */
export function getClusterSummariesByRunId(
  db: Database.Database,
  runId: string
): ClusterSummary[] {
  return db.prepare(
    `SELECT id, run_id, cluster_index, label, classification_tag, document_count,
            coherence_score, created_at
     FROM clusters
     WHERE run_id = ?
     ORDER BY cluster_index ASC`
  ).all(runId) as ClusterSummary[];
}

/**
 * Get cluster summaries for a document (via document_clusters join)
 */
export function getClusterSummariesForDocument(
  db: Database.Database,
  documentId: string
): ClusterSummary[] {
  return db.prepare(
    `SELECT c.id, c.run_id, c.cluster_index, c.label, c.classification_tag,
            c.document_count, c.coherence_score, c.created_at
     FROM clusters c
     JOIN document_clusters dc ON dc.cluster_id = c.id
     WHERE dc.document_id = ?
     ORDER BY c.created_at DESC`
  ).all(documentId) as ClusterSummary[];
}

// --- Stats ---

/**
 * Get aggregate clustering statistics
 */
export function getClusteringStats(db: Database.Database): {
  total_clusters: number;
  total_runs: number;
  avg_coherence: number | null;
} {
  const row = db.prepare(
    `SELECT COUNT(*) AS total_clusters,
            COUNT(DISTINCT run_id) AS total_runs,
            AVG(coherence_score) AS avg_coherence
     FROM clusters`
  ).get() as { total_clusters: number; total_runs: number; avg_coherence: number | null };

  return row;
}

/**
 * Get all KG node IDs linked to documents in a cluster
 */
export function getClusterDocumentEntityNodes(
  db: Database.Database,
  clusterId: string,
): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT nel.node_id
    FROM document_clusters dc
    JOIN entity_mentions em ON em.document_id = dc.document_id
    JOIN entities e ON em.entity_id = e.id
    JOIN node_entity_links nel ON nel.entity_id = e.id
    WHERE dc.cluster_id = ?
  `).all(clusterId) as Array<{ node_id: string }>;
  return new Set(rows.map(r => r.node_id));
}

/**
 * Get all KG node IDs linked to a specific document
 */
export function getDocumentEntityNodeIds(
  db: Database.Database,
  documentId: string,
): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT nel.node_id
    FROM entity_mentions em
    JOIN entities e ON em.entity_id = e.id
    JOIN node_entity_links nel ON nel.entity_id = e.id
    WHERE em.document_id = ?
  `).all(documentId) as Array<{ node_id: string }>;
  return new Set(rows.map(r => r.node_id));
}

// --- Cluster Reassignment ---

/** Minimum Jaccard overlap required to reassign a document to a cluster */
const REASSIGNMENT_JACCARD_THRESHOLD = 0.05;

export interface ClusterReassignmentResult {
  document_id: string;
  reassigned: boolean;
  cluster_id?: string;
  overlap_score?: number;
  previous_cluster_id?: string | null;
  reason?: string;
  best_overlap?: number;
  error?: string;
}

/**
 * Compute Jaccard similarity between two sets.
 */
function computeJaccard(a: Set<string>, b: Set<string>): number {
  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

/**
 * Get KG node IDs for all documents in a cluster (for a specific run).
 */
function getClusterNodeIds(
  db: Database.Database,
  clusterId: string,
  runId: string,
): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT nel.node_id FROM node_entity_links nel
    JOIN entities e ON nel.entity_id = e.id
    JOIN document_clusters dc ON dc.document_id = e.document_id
    WHERE dc.cluster_id = ? AND dc.run_id = ?
  `).all(clusterId, runId) as Array<{ node_id: string }>;
  return new Set(rows.map(r => r.node_id));
}

/**
 * Reassign a single document to the best-matching cluster by Jaccard overlap
 * on KG entity nodes. Returns the reassignment result.
 *
 * Shared by ingestion.ts (process_pending) and entity-analysis.ts (entity extraction).
 */
export function reassignDocumentToCluster(
  db: Database.Database,
  documentId: string,
): ClusterReassignmentResult {
  const clusterCount = (db.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number }).cnt;
  if (clusterCount === 0) {
    return { document_id: documentId, reassigned: false, reason: 'no clusters exist' };
  }

  const runRow = db.prepare(
    'SELECT DISTINCT run_id FROM document_clusters ORDER BY ROWID DESC LIMIT 1'
  ).get() as { run_id: string } | undefined;

  if (!runRow) {
    return { document_id: documentId, reassigned: false, reason: 'no cluster runs found' };
  }

  const docNodeIds = db.prepare(`
    SELECT DISTINCT nel.node_id FROM node_entity_links nel
    JOIN entities e ON nel.entity_id = e.id
    WHERE e.document_id = ?
  `).all(documentId) as Array<{ node_id: string }>;

  if (docNodeIds.length === 0) {
    return { document_id: documentId, reassigned: false, reason: 'no KG nodes' };
  }

  const docNodeSet = new Set(docNodeIds.map(r => r.node_id));

  const existing = db.prepare(
    'SELECT cluster_id FROM document_clusters WHERE document_id = ? AND run_id = ?'
  ).get(documentId, runRow.run_id) as { cluster_id: string } | undefined;

  const clusterRows = db.prepare(`
    SELECT DISTINCT dc.cluster_id FROM document_clusters dc
    WHERE dc.run_id = ? AND dc.document_id != ?
  `).all(runRow.run_id, documentId) as Array<{ cluster_id: string }>;

  let bestClusterId: string | null = null;
  let bestOverlap = 0;
  for (const cr of clusterRows) {
    const clusterNodeSet = getClusterNodeIds(db, cr.cluster_id, runRow.run_id);
    const jaccard = computeJaccard(docNodeSet, clusterNodeSet);
    if (jaccard > bestOverlap) {
      bestOverlap = jaccard;
      bestClusterId = cr.cluster_id;
    }
  }

  const roundedOverlap = Math.round(bestOverlap * 1000) / 1000;

  if (bestClusterId && bestOverlap > REASSIGNMENT_JACCARD_THRESHOLD) {
    if (existing) {
      db.prepare('DELETE FROM document_clusters WHERE document_id = ? AND run_id = ?')
        .run(documentId, runRow.run_id);
    }
    db.prepare(
      'INSERT INTO document_clusters (id, document_id, cluster_id, run_id, similarity_to_centroid, membership_probability, is_noise, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), documentId, bestClusterId, runRow.run_id, roundedOverlap, 1.0, 0, new Date().toISOString());

    return {
      document_id: documentId,
      reassigned: true,
      cluster_id: bestClusterId,
      overlap_score: roundedOverlap,
      previous_cluster_id: existing?.cluster_id ?? null,
    };
  }

  return {
    document_id: documentId,
    reassigned: false,
    reason: bestClusterId ? 'overlap too low' : 'no clusters with entity overlap',
    best_overlap: roundedOverlap,
  };
}
