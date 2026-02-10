/**
 * Cluster operations for DatabaseService
 *
 * Handles CRUD operations for the clusters and document_clusters tables.
 */

import Database from 'better-sqlite3';
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
 * Update cluster labels, description, and classification tag
 */
export function updateClusterLabels(
  db: Database.Database,
  id: string,
  label: string,
  description: string,
  tag: string
): void {
  db.prepare(
    'UPDATE clusters SET label = ?, description = ?, classification_tag = ? WHERE id = ?'
  ).run(label, description, tag, id);
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
 * Get all cluster assignments for a document
 */
export function getDocumentClusters(db: Database.Database, documentId: string): DocumentCluster[] {
  const rows = db.prepare(
    'SELECT * FROM document_clusters WHERE document_id = ?'
  ).all(documentId) as Array<Omit<DocumentCluster, 'is_noise'> & { is_noise: number }>;

  return rows.map((row) => ({
    ...row,
    is_noise: row.is_noise === 1,
  }));
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

/**
 * Delete all cluster assignments for a document (for cascade delete)
 */
export function deleteDocumentClustersByDocId(db: Database.Database, documentId: string): number {
  const result = db.prepare('DELETE FROM document_clusters WHERE document_id = ?').run(documentId);
  return result.changes;
}

/**
 * Delete all document-cluster assignments for a run
 */
export function deleteDocumentClustersByRunId(db: Database.Database, runId: string): number {
  const result = db.prepare('DELETE FROM document_clusters WHERE run_id = ?').run(runId);
  return result.changes;
}

// --- Summaries ---

/**
 * Lightweight cluster summary (excludes large JSON fields)
 */
export interface ClusterSummary {
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
