/**
 * Clustering Service - Orchestrates document clustering pipeline
 *
 * Pipeline:
 *   1. Fetch document-level embeddings (average-pool chunk embeddings, L2-normalize)
 *   2. Call Python clustering worker (HDBSCAN / agglomerative / kmeans)
 *   3. Store cluster + document_cluster records with provenance
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module services/clustering/clustering-service
 */

import { v4 as uuidv4 } from 'uuid';
import { PythonShell, Options as PythonShellOptions } from 'python-shell';
import path from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../storage/database/index.js';
import { VectorService } from '../storage/vector.js';
import { getProvenanceTracker } from '../provenance/index.js';
import { ProvenanceType } from '../../models/provenance.js';
import type { SourceType } from '../../models/provenance.js';
import type {
  Cluster,
  DocumentCluster,
  ClusterRunConfig,
  ClusterRunResult,
  ClusterResultItem,
} from '../../models/cluster.js';
import {
  insertCluster,
  insertDocumentCluster,
} from '../storage/database/cluster-operations.js';
import { computeHash } from '../../utils/hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════════════════════════════════

export type ClusteringErrorCode =
  | 'INSUFFICIENT_DOCUMENTS'
  | 'NO_EMBEDDINGS'
  | 'WORKER_FAILED'
  | 'WORKER_TIMEOUT'
  | 'WORKER_PARSE_ERROR';

export class ClusteringError extends Error {
  constructor(
    message: string,
    public readonly code: ClusteringErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ClusteringError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Raw result from Python clustering_worker.py */
interface WorkerResult {
  success: boolean;
  labels?: number[];
  probabilities?: number[];
  centroids?: number[][];
  n_clusters?: number;
  noise_count?: number;
  noise_indices?: number[];
  silhouette_score?: number;
  coherence_scores?: number[];
  elapsed_ms?: number;
  error?: string;
  error_type?: string;
}

/** Document with its average-pooled embedding */
interface DocumentEmbedding {
  document_id: string;
  embedding: Float32Array;
  chunk_count: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

/** Worker timeout: 5 minutes */
const WORKER_TIMEOUT_MS = 300_000;

/** Max stderr accumulation: 10KB */
const MAX_STDERR_LENGTH = 10_240;

/**
 * Compute document-level embeddings by average-pooling chunk embeddings.
 *
 * For each document that has embeddings, fetches all chunk-based vectors
 * from vec_embeddings, computes the element-wise mean, and L2-normalizes.
 *
 * sqlite-vec has NO native vector averaging -- we extract to TypeScript.
 *
 * @param conn - Raw better-sqlite3 connection (for direct vec_embeddings queries)
 * @param documentIds - Optional filter; if empty, includes all documents with embeddings
 * @returns Array of DocumentEmbedding with 768-dim Float32Array per document
 */
export function computeDocumentEmbeddings(
  conn: Database.Database,
  documentIds?: string[]
): DocumentEmbedding[] {
  // chunk_id IS NOT NULL ensures we only get chunk embeddings (not VLM or extraction)
  const hasFilter = documentIds && documentIds.length > 0;
  const filterClause = hasFilter
    ? ` AND e.document_id IN (${documentIds.map(() => '?').join(', ')})`
    : '';

  const rows = conn.prepare(`
    SELECT e.document_id, v.vector
    FROM vec_embeddings v
    JOIN embeddings e ON e.id = v.embedding_id
    WHERE e.chunk_id IS NOT NULL${filterClause}
    ORDER BY e.document_id, e.chunk_index
  `).all(...(hasFilter ? documentIds : [])) as Array<{
    document_id: string;
    vector: Buffer;
  }>;

  // Group by document_id
  const docVectors = new Map<string, Buffer[]>();
  for (const row of rows) {
    const existing = docVectors.get(row.document_id);
    if (existing) {
      existing.push(row.vector);
    } else {
      docVectors.set(row.document_id, [row.vector]);
    }
  }

  // Average-pool + L2-normalize per document
  const results: DocumentEmbedding[] = [];
  for (const [docId, vectors] of docVectors) {
    const averaged = averageVectors(vectors);
    results.push({
      document_id: docId,
      embedding: averaged,
      chunk_count: vectors.length,
    });
  }

  return results;
}

/**
 * Average-pool vectors and L2-normalize the result.
 *
 * @param vectors - Array of 768-dim vectors as Buffers (from sqlite-vec)
 * @returns L2-normalized 768-dim Float32Array
 */
function averageVectors(vectors: Buffer[]): Float32Array {
  if (vectors.length === 0) {
    return new Float32Array(768);
  }

  const dim = 768;
  const sum = new Float64Array(dim); // Use float64 for accumulation precision

  for (const buf of vectors) {
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, dim);
    for (let i = 0; i < dim; i++) {
      sum[i] += f32[i];
    }
  }

  // Mean
  const n = vectors.length;
  const result = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    result[i] = sum[i] / n;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

/**
 * Run the Python clustering worker via python-shell.
 *
 * Sends JSON to stdin, parses JSON from stdout.
 * Uses the same PythonShell pattern as embedding_worker.py.
 *
 * @param embeddings - 2D array of embeddings [n_docs][768]
 * @param documentIds - Document IDs matching embedding order
 * @param config - Clustering algorithm configuration
 * @returns WorkerResult from Python
 */
async function runClusteringWorker(
  embeddings: number[][],
  documentIds: string[],
  config: ClusterRunConfig
): Promise<WorkerResult> {
  const workerPath = path.join(process.cwd(), 'python', 'clustering_worker.py');

  const input = JSON.stringify({
    embeddings,
    document_ids: documentIds,
    algorithm: config.algorithm,
    n_clusters: config.n_clusters,
    min_cluster_size: config.min_cluster_size,
    distance_threshold: config.distance_threshold,
    linkage: config.linkage,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const options: PythonShellOptions = {
      mode: 'text',
      pythonOptions: ['-u'],
      args: [],
    };

    const shell = new PythonShell(workerPath, options);
    let output = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { shell.kill(); } catch { /* ignore */ }
      reject(
        new ClusteringError(
          `Clustering worker timeout after ${WORKER_TIMEOUT_MS}ms`,
          'WORKER_TIMEOUT',
          { stderr: stderr.substring(0, 1000) }
        )
      );
    }, WORKER_TIMEOUT_MS);

    shell.on('message', (msg: string) => {
      output += msg;
    });

    shell.on('stderr', (err: string) => {
      if (stderr.length < MAX_STDERR_LENGTH) {
        stderr += err + '\n';
      }
    });

    const handleEnd = (err?: Error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (err) {
        console.error('[ClusterWorker] Error:', err.message);
        if (stderr) console.error('[ClusterWorker] Stderr:', stderr.substring(0, 1000));
      }

      if (!output.trim()) {
        if (err) {
          reject(new ClusteringError(
            `Clustering worker failed: ${err.message}`,
            'WORKER_FAILED',
            { stderr: stderr.substring(0, 1000) }
          ));
        } else {
          reject(new ClusteringError(
            'Clustering worker produced no output',
            'WORKER_FAILED',
            { stderr: stderr.substring(0, 1000) }
          ));
        }
        return;
      }

      // Parse the last JSON line
      const lines = output.trim().split('\n');
      let parsed: WorkerResult | undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          parsed = JSON.parse(lines[i]) as WorkerResult;
          break;
        } catch { /* not JSON, try previous line */ }
      }

      if (parsed !== undefined) {
        resolve(parsed);
      } else {
        reject(new ClusteringError(
          'Failed to parse clustering worker output as JSON',
          'WORKER_PARSE_ERROR',
          { output: output.substring(0, 1000) }
        ));
      }
    };

    shell.send(input);
    shell.end(handleEnd);
  });
}

/**
 * Compute cosine similarity between a document embedding and a centroid.
 * Both vectors are assumed to be L2-normalized, so similarity = dot product.
 */
export function cosineSimilarity(a: Float32Array | number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  // Clamp to [0, 1] to handle floating point drift
  return Math.max(0, Math.min(1, dot));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CLUSTERING PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the full clustering pipeline:
 *   1. Compute document-level embeddings
 *   2. Validate minimum document count
 *   3. Call Python clustering worker
 *   4. Create provenance records
 *   5. Store clusters + document_cluster assignments
 *
 * @param db - DatabaseService instance
 * @param vector - VectorService instance (unused directly but validates vec loaded)
 * @param config - Clustering configuration
 * @param documentIds - Optional filter (empty = all documents with embeddings)
 * @returns ClusterRunResult with full results
 */
export async function runClustering(
  db: DatabaseService,
  _vector: VectorService,
  config: ClusterRunConfig,
  documentIds?: string[]
): Promise<ClusterRunResult> {
  const startTime = performance.now();
  const runId = uuidv4();
  const conn = db.getConnection();

  // Step 1: Compute document-level embeddings
  console.error(`[CLUSTER] Computing document embeddings...`);
  const docEmbeddings = computeDocumentEmbeddings(conn, documentIds);

  if (docEmbeddings.length < 2) {
    throw new ClusteringError(
      `At least 2 documents with embeddings required for clustering, got ${docEmbeddings.length}`,
      'INSUFFICIENT_DOCUMENTS',
      { found: docEmbeddings.length, requested: documentIds?.length ?? 'all' }
    );
  }

  console.error(`[CLUSTER] ${docEmbeddings.length} documents with embeddings`);

  // Step 2: Prepare data for Python worker
  const orderedDocIds = docEmbeddings.map((d) => d.document_id);
  const embeddingMatrix = docEmbeddings.map((d) => Array.from(d.embedding));

  // Step 3: Call Python clustering worker
  console.error(`[CLUSTER] Running ${config.algorithm} clustering...`);
  const workerResult = await runClusteringWorker(embeddingMatrix, orderedDocIds, config);

  if (!workerResult.success) {
    throw new ClusteringError(
      `Clustering worker failed: ${workerResult.error}`,
      'WORKER_FAILED',
      { error_type: workerResult.error_type, error: workerResult.error }
    );
  }

  // Step 4: Store results in database
  console.error(`[CLUSTER] Found ${workerResult.n_clusters} clusters, storing results...`);
  const tracker = getProvenanceTracker(db);
  const now = new Date().toISOString();
  const processingDurationMs = Math.round(performance.now() - startTime);
  const algorithmParamsJson = JSON.stringify({
    algorithm: config.algorithm,
    n_clusters: config.n_clusters,
    min_cluster_size: config.min_cluster_size,
    distance_threshold: config.distance_threshold,
    linkage: config.linkage,
  });

  // Build cluster result items and store cluster records
  const clusterItems: ClusterResultItem[] = [];
  const labels = workerResult.labels!;
  const probabilities = workerResult.probabilities!;
  const centroids = workerResult.centroids!;
  const coherenceScores = workerResult.coherence_scores!;

  // Group documents by cluster label
  const clusterGroups = new Map<number, number[]>(); // label -> doc indices
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === -1) continue; // Skip noise
    const existing = clusterGroups.get(label);
    if (existing) {
      existing.push(i);
    } else {
      clusterGroups.set(label, [i]);
    }
  }

  // Sort cluster labels
  const sortedLabels = Array.from(clusterGroups.keys()).sort((a, b) => a - b);
  const clusterIdMap = new Map<number, string>(); // label -> cluster UUID

  // Use a transaction to store everything atomically
  const storeTransaction = conn.transaction(() => {
    for (let ci = 0; ci < sortedLabels.length; ci++) {
      const label = sortedLabels[ci];
      const docIndices = clusterGroups.get(label)!;
      const centroid = centroids[ci];
      const coherence = coherenceScores[ci];

      const clusterId = uuidv4();
      clusterIdMap.set(label, clusterId);

      // Content hash from centroid + run_id
      const contentHash = computeHash(JSON.stringify(centroid) + ':' + runId);

      // Find any document's provenance_id as the source_id for the cluster provenance
      // Use the first document in this cluster
      const firstDocId = orderedDocIds[docIndices[0]];
      const firstDoc = db.getDocument(firstDocId);
      const sourceProvId = firstDoc?.provenance_id ?? null;

      // Create CLUSTERING provenance record
      const provId = tracker.createProvenance({
        type: ProvenanceType.CLUSTERING,
        source_type: 'CLUSTERING' as SourceType,
        source_id: sourceProvId,
        root_document_id: firstDoc?.provenance_id ?? runId,
        content_hash: contentHash,
        input_hash: computeHash(algorithmParamsJson + ':' + docIndices.length),
        processor: 'clustering-service',
        processor_version: '1.0.0',
        processing_params: {
          algorithm: config.algorithm,
          run_id: runId,
          cluster_index: ci,
          document_count: docIndices.length,
        },
        processing_duration_ms: processingDurationMs,
        processing_quality_score: coherence,
      });

      // Insert cluster record
      const cluster: Cluster = {
        id: clusterId,
        run_id: runId,
        cluster_index: ci,
        label: null,
        description: null,
        classification_tag: null,
        document_count: docIndices.length,
        centroid_json: JSON.stringify(centroid),
        top_terms_json: null,
        coherence_score: coherence,
        algorithm: config.algorithm,
        algorithm_params_json: algorithmParamsJson,
        silhouette_score: workerResult.silhouette_score ?? null,
        content_hash: contentHash,
        provenance_id: provId,
        created_at: now,
        processing_duration_ms: processingDurationMs,
      };

      insertCluster(conn, cluster);

      // Build result item
      const itemDocIds: string[] = [];
      const itemSimilarities: number[] = [];
      const itemProbabilities: number[] = [];

      for (const idx of docIndices) {
        itemDocIds.push(orderedDocIds[idx]);
        itemSimilarities.push(cosineSimilarity(docEmbeddings[idx].embedding, centroid));
        itemProbabilities.push(probabilities[idx]);
      }

      clusterItems.push({
        cluster_index: ci,
        document_count: docIndices.length,
        coherence_score: coherence,
        centroid,
        document_ids: itemDocIds,
        similarities: itemSimilarities,
        probabilities: itemProbabilities,
      });
    }

    // Store document-cluster assignments (both clustered and noise documents)
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const isNoise = label === -1;
      const clusterId = isNoise ? null : (clusterIdMap.get(label) ?? null);
      const centroid = isNoise ? null : centroids[sortedLabels.indexOf(label)];
      const similarity = centroid
        ? cosineSimilarity(docEmbeddings[i].embedding, centroid)
        : 0;

      const dc: DocumentCluster = {
        id: uuidv4(),
        document_id: orderedDocIds[i],
        cluster_id: clusterId,
        run_id: runId,
        similarity_to_centroid: Math.round(similarity * 1000000) / 1000000,
        membership_probability: probabilities[i],
        is_noise: isNoise,
        assigned_at: now,
      };

      insertDocumentCluster(conn, dc);
    }
  });

  storeTransaction();

  const noiseDocIds = orderedDocIds.filter((_, i) => labels[i] === -1);

  const totalDurationMs = Math.round(performance.now() - startTime);
  console.error(`[CLUSTER] Done: ${workerResult.n_clusters} clusters, ${noiseDocIds.length} noise docs, ${totalDurationMs}ms`);

  return {
    run_id: runId,
    algorithm: config.algorithm,
    n_clusters: workerResult.n_clusters!,
    total_documents: docEmbeddings.length,
    noise_document_ids: noiseDocIds,
    silhouette_score: workerResult.silhouette_score ?? 0,
    clusters: clusterItems,
    processing_duration_ms: totalDurationMs,
  };
}
