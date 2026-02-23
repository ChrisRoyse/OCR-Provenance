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

  return db
    .prepare(`SELECT * FROM clusters ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as Cluster[];
}

/**
 * Delete all clusters and their document assignments for a run.
 * First deletes document_clusters, then clusters.
 * Returns the number of clusters deleted.
 */
export function deleteClustersByRunId(db: Database.Database, runId: string): number {
  // Collect provenance IDs before deleting clusters (clusters.provenance_id NOT NULL REFERENCES provenance(id))
  const provenanceIds = db
    .prepare('SELECT provenance_id FROM clusters WHERE run_id = ?')
    .all(runId) as { provenance_id: string }[];

  db.prepare('DELETE FROM document_clusters WHERE run_id = ?').run(runId);
  const result = db.prepare('DELETE FROM clusters WHERE run_id = ?').run(runId);

  // Clean up orphaned provenance records now that the FK references are gone
  if (provenanceIds.length > 0) {
    const deleteProvStmt = db.prepare('DELETE FROM provenance WHERE id = ?');
    for (const { provenance_id } of provenanceIds) {
      try {
        deleteProvStmt.run(provenance_id);
      } catch (e: unknown) {
        // Log but don't fail if provenance record is still referenced elsewhere
        console.error(
          `[cluster-operations] Failed to delete provenance ${provenance_id}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  }

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
  return db
    .prepare(
      `SELECT dc.document_id, d.file_name, dc.similarity_to_centroid, dc.membership_probability
     FROM document_clusters dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.cluster_id = ?
     ORDER BY dc.similarity_to_centroid DESC`
    )
    .all(clusterId) as Array<{
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
export function getClusterSummariesByRunId(db: Database.Database, runId: string): ClusterSummary[] {
  return db
    .prepare(
      `SELECT id, run_id, cluster_index, label, classification_tag, document_count,
            coherence_score, created_at
     FROM clusters
     WHERE run_id = ?
     ORDER BY cluster_index ASC`
    )
    .all(runId) as ClusterSummary[];
}

/**
 * Get cluster summaries for a document (via document_clusters join)
 */
export function getClusterSummariesForDocument(
  db: Database.Database,
  documentId: string
): ClusterSummary[] {
  return db
    .prepare(
      `SELECT c.id, c.run_id, c.cluster_index, c.label, c.classification_tag,
            c.document_count, c.coherence_score, c.created_at
     FROM clusters c
     JOIN document_clusters dc ON dc.cluster_id = c.id
     WHERE dc.document_id = ?
     ORDER BY c.created_at DESC`
    )
    .all(documentId) as ClusterSummary[];
}

// --- Reassign & Merge ---

/**
 * Reassign a document from its current cluster to a different target cluster.
 * Deletes existing document_clusters entries for this document within the same run,
 * inserts a new assignment, and updates member_count on both old and new clusters.
 *
 * @returns Object with old_cluster_id (null if not previously assigned) and run_id
 */
export function reassignDocument(
  db: Database.Database,
  documentId: string,
  targetClusterId: string
): { old_cluster_id: string | null; run_id: string } {
  // Get the target cluster to know the run_id
  const targetCluster = getCluster(db, targetClusterId);
  if (!targetCluster) {
    throw new Error(`Target cluster "${targetClusterId}" not found`);
  }

  const runId = targetCluster.run_id;

  // Find existing assignment for this document in this run
  const existing = db
    .prepare(
      'SELECT id, cluster_id FROM document_clusters WHERE document_id = ? AND run_id = ?'
    )
    .get(documentId, runId) as { id: string; cluster_id: string | null } | undefined;

  const oldClusterId = existing?.cluster_id ?? null;

  if (oldClusterId === targetClusterId) {
    // Already in the target cluster, no-op
    return { old_cluster_id: oldClusterId, run_id: runId };
  }

  // Delete existing assignment for this document in this run
  if (existing) {
    db.prepare('DELETE FROM document_clusters WHERE id = ?').run(existing.id);

    // Decrement old cluster's document_count (if it was in a cluster, not noise)
    if (oldClusterId) {
      db.prepare(
        'UPDATE clusters SET document_count = MAX(0, document_count - 1) WHERE id = ?'
      ).run(oldClusterId);
    }
  }

  // Insert new assignment
  const now = new Date().toISOString();
  const dcId = uuidv4();
  db.prepare(`
    INSERT INTO document_clusters (id, document_id, cluster_id, run_id,
      similarity_to_centroid, membership_probability, is_noise, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(dcId, documentId, targetClusterId, runId, 0, 1.0, 0, now);

  // Increment target cluster's document_count
  db.prepare(
    'UPDATE clusters SET document_count = document_count + 1 WHERE id = ?'
  ).run(targetClusterId);

  return { old_cluster_id: oldClusterId, run_id: runId };
}

/**
 * Merge two clusters into one. All documents from cluster2 are moved to cluster1.
 * cluster2 is deleted after the merge.
 *
 * Both clusters must belong to the same run_id.
 *
 * @returns Object with merged_cluster_id and documents_moved count
 */
export function mergeClusters(
  db: Database.Database,
  clusterId1: string,
  clusterId2: string
): { merged_cluster_id: string; documents_moved: number } {
  // Validation outside transaction - read-only lookups
  const cluster1 = getCluster(db, clusterId1);
  if (!cluster1) {
    throw new Error(`Cluster "${clusterId1}" not found`);
  }

  const cluster2 = getCluster(db, clusterId2);
  if (!cluster2) {
    throw new Error(`Cluster "${clusterId2}" not found`);
  }

  if (cluster1.run_id !== cluster2.run_id) {
    throw new Error(
      `Cannot merge clusters from different runs: "${cluster1.run_id}" vs "${cluster2.run_id}"`
    );
  }

  // M-8: Wrap all mutations in a transaction so a crash mid-merge
  // cannot leave cluster state inconsistent (e.g., documents moved
  // but old cluster not deleted, or count not updated).
  const cluster2ProvId = cluster2.provenance_id;

  const runInTransaction = db.transaction(() => {
    // Move all document_clusters from cluster2 to cluster1
    const moveResult = db
      .prepare('UPDATE document_clusters SET cluster_id = ? WHERE cluster_id = ?')
      .run(clusterId1, clusterId2);

    const documentsMoved = moveResult.changes;

    // Update cluster1's document_count
    db.prepare(
      'UPDATE clusters SET document_count = document_count + ? WHERE id = ?'
    ).run(documentsMoved, clusterId1);

    // Delete cluster2 record
    db.prepare('DELETE FROM clusters WHERE id = ?').run(clusterId2);

    // Clean up cluster2's provenance record
    try {
      db.prepare('DELETE FROM provenance WHERE id = ?').run(cluster2ProvId);
    } catch (e: unknown) {
      console.error(
        `[cluster-operations] Failed to delete provenance ${cluster2ProvId}:`,
        e instanceof Error ? e.message : String(e)
      );
    }

    return documentsMoved;
  });

  const documentsMoved = runInTransaction();

  return { merged_cluster_id: clusterId1, documents_moved: documentsMoved };
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
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total_clusters,
            COUNT(DISTINCT run_id) AS total_runs,
            AVG(coherence_score) AS avg_coherence
     FROM clusters`
    )
    .get() as { total_clusters: number; total_runs: number; avg_coherence: number | null };

  return row;
}

