/**
 * Document Clustering & Auto-Classification MCP Tools
 *
 * Tools: ocr_cluster_documents, ocr_cluster_list, ocr_cluster_get,
 *        ocr_cluster_assign, ocr_cluster_delete
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/clustering
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { formatResponse, handleError, type ToolDefinition, type ToolResponse } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { MCPError } from '../server/errors.js';
import { successResult } from '../server/types.js';
import {
  runClustering,
  computeDocumentEmbeddings,
  cosineSimilarity,
} from '../services/clustering/clustering-service.js';
import {
  getCluster,
  listClusters,
  getClusterDocuments,
  deleteClustersByRunId,
  insertDocumentCluster,
  getClusterSummariesByRunId,
} from '../services/storage/database/cluster-operations.js';
import type { ClusterRunConfig, DocumentCluster } from '../models/cluster.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const ClusterDocumentsInput = z.object({
  algorithm: z.enum(['hdbscan', 'agglomerative', 'kmeans']).default('hdbscan')
    .describe('Clustering algorithm. HDBSCAN auto-detects cluster count.'),
  n_clusters: z.number().int().min(2).max(100).optional()
    .describe('Number of clusters. Required for kmeans/agglomerative. Ignored for hdbscan.'),
  min_cluster_size: z.number().int().min(2).max(100).default(3)
    .describe('HDBSCAN: minimum documents per cluster'),
  distance_threshold: z.number().min(0.1).max(2.0).optional()
    .describe('Agglomerative: distance threshold for auto-detection. Used when n_clusters not set.'),
  linkage: z.enum(['average', 'complete', 'single']).default('average')
    .describe('Agglomerative linkage. Ward excluded (incompatible with cosine).'),
  document_filter: z.array(z.string()).optional()
    .describe('Cluster only these document IDs. Default: all documents with embeddings.'),
});

const ClusterListInput = z.object({
  run_id: z.string().optional().describe('Filter by clustering run ID'),
  classification_tag: z.string().optional().describe('Filter by classification tag'),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

const ClusterGetInput = z.object({
  cluster_id: z.string().min(1).describe('Cluster ID'),
  include_documents: z.boolean().default(true).describe('Include member document list'),
  include_provenance: z.boolean().default(false).describe('Include provenance chain'),
});

const ClusterAssignInput = z.object({
  document_id: z.string().min(1).describe('Document ID to classify'),
  run_id: z.string().min(1).describe('Run ID to classify against'),
});

const ClusterDeleteInput = z.object({
  run_id: z.string().min(1).describe('Clustering run ID to delete'),
  confirm: z.literal(true).describe('Must be true to confirm deletion'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_cluster_documents - Run clustering on documents
 */
async function handleClusterDocuments(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ClusterDocumentsInput, params);
    const { db, vector } = requireDatabase();

    // Validate: kmeans and agglomerative without distance_threshold require n_clusters
    if (input.algorithm === 'kmeans' && !input.n_clusters) {
      throw new MCPError('VALIDATION_ERROR', 'n_clusters is required for kmeans algorithm');
    }

    const config: ClusterRunConfig = {
      algorithm: input.algorithm ?? 'hdbscan',
      n_clusters: input.n_clusters ?? null,
      min_cluster_size: input.min_cluster_size ?? 3,
      distance_threshold: input.distance_threshold ?? null,
      linkage: input.linkage ?? 'average',
    };

    const result = await runClustering(db, vector, config, input.document_filter);

    return formatResponse(successResult({
      run_id: result.run_id,
      algorithm: result.algorithm,
      n_clusters: result.n_clusters,
      total_documents: result.total_documents,
      noise_count: result.noise_document_ids.length,
      noise_document_ids: result.noise_document_ids,
      silhouette_score: result.silhouette_score,
      processing_duration_ms: result.processing_duration_ms,
      clusters: result.clusters.map((c) => ({
        cluster_index: c.cluster_index,
        document_count: c.document_count,
        coherence_score: c.coherence_score,
        document_ids: c.document_ids,
      })),
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_cluster_list - List clusters with filtering
 */
async function handleClusterList(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ClusterListInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const clusters = listClusters(conn, {
      run_id: input.run_id,
      classification_tag: input.classification_tag,
      limit: input.limit,
      offset: input.offset,
    });

    const items = clusters.map((c) => ({
      id: c.id,
      run_id: c.run_id,
      cluster_index: c.cluster_index,
      label: c.label,
      description: c.description,
      classification_tag: c.classification_tag,
      document_count: c.document_count,
      coherence_score: c.coherence_score,
      algorithm: c.algorithm,
      silhouette_score: c.silhouette_score,
      created_at: c.created_at,
    }));

    return formatResponse(successResult({
      clusters: items,
      total: items.length,
      offset: input.offset,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_cluster_get - Get detailed cluster info
 */
async function handleClusterGet(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ClusterGetInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const cluster = getCluster(conn, input.cluster_id);
    if (!cluster) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Cluster "${input.cluster_id}" not found`);
    }

    const result: Record<string, unknown> = {
      id: cluster.id,
      run_id: cluster.run_id,
      cluster_index: cluster.cluster_index,
      label: cluster.label,
      description: cluster.description,
      classification_tag: cluster.classification_tag,
      document_count: cluster.document_count,
      coherence_score: cluster.coherence_score,
      algorithm: cluster.algorithm,
      algorithm_params: cluster.algorithm_params_json ? JSON.parse(cluster.algorithm_params_json) : null,
      silhouette_score: cluster.silhouette_score,
      content_hash: cluster.content_hash,
      provenance_id: cluster.provenance_id,
      created_at: cluster.created_at,
      processing_duration_ms: cluster.processing_duration_ms,
    };

    if (input.include_documents) {
      result.documents = getClusterDocuments(conn, input.cluster_id);
    }

    if (input.include_provenance) {
      try {
        const chain = db.getProvenanceChain(cluster.provenance_id);
        result.provenance_chain = chain;
      } catch {
        result.provenance_chain = null;
      }
    }

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_cluster_assign - Assign a document to nearest cluster
 */
async function handleClusterAssign(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ClusterAssignInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists and has embeddings
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document "${input.document_id}" not found`);
    }

    // Compute document embedding
    const docEmbeddings = computeDocumentEmbeddings(conn, [input.document_id]);
    if (docEmbeddings.length === 0) {
      throw new MCPError('VALIDATION_ERROR', `Document "${input.document_id}" has no chunk embeddings`);
    }

    const docEmb = docEmbeddings[0].embedding;

    // Get all clusters for the specified run
    const clusters = getClusterSummariesByRunId(conn, input.run_id);
    if (clusters.length === 0) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `No clusters found for run "${input.run_id}"`);
    }

    // Load centroids and find nearest cluster
    let bestClusterId: string | null = null;
    let bestSimilarity = -1;
    let bestClusterIndex = -1;

    for (const cluster of clusters) {
      const fullCluster = getCluster(conn, cluster.id);
      if (!fullCluster?.centroid_json) continue;

      const centroid = JSON.parse(fullCluster.centroid_json) as number[];
      const similarity = cosineSimilarity(docEmb, centroid);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestClusterId = cluster.id;
        bestClusterIndex = cluster.cluster_index;
      }
    }

    if (!bestClusterId) {
      throw new MCPError('INTERNAL_ERROR', 'No valid cluster centroids found');
    }

    // Insert document_cluster assignment
    const now = new Date().toISOString();
    const dc: DocumentCluster = {
      id: uuidv4(),
      document_id: input.document_id,
      cluster_id: bestClusterId,
      run_id: input.run_id,
      similarity_to_centroid: Math.round(bestSimilarity * 1000000) / 1000000,
      membership_probability: 1.0,
      is_noise: false,
      assigned_at: now,
    };

    insertDocumentCluster(conn, dc);

    // Update cluster document_count
    conn.prepare(
      'UPDATE clusters SET document_count = document_count + 1 WHERE id = ?'
    ).run(bestClusterId);

    return formatResponse(successResult({
      document_id: input.document_id,
      cluster_id: bestClusterId,
      cluster_index: bestClusterIndex,
      similarity_to_centroid: dc.similarity_to_centroid,
      run_id: input.run_id,
      assigned: true,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_cluster_delete - Delete a clustering run
 */
async function handleClusterDelete(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ClusterDeleteInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Collect provenance IDs before deletion (lightweight: no centroid blobs)
    const provenanceIds = conn.prepare(
      'SELECT provenance_id FROM clusters WHERE run_id = ?'
    ).all(input.run_id) as Array<{ provenance_id: string }>;

    if (provenanceIds.length === 0) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `No clusters found for run "${input.run_id}"`);
    }

    const deletedCount = deleteClustersByRunId(conn, input.run_id);

    // Clean up provenance records for deleted clusters
    const deleteProvStmt = conn.prepare('DELETE FROM provenance WHERE id = ?');
    for (const { provenance_id } of provenanceIds) {
      try {
        deleteProvStmt.run(provenance_id);
      } catch {
        // Ignore provenance cleanup failures
      }
    }

    return formatResponse(successResult({
      run_id: input.run_id,
      clusters_deleted: deletedCount,
      deleted: true,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export const clusteringTools: Record<string, ToolDefinition> = {
  'ocr_cluster_documents': {
    description: 'Cluster documents by semantic similarity using HDBSCAN, agglomerative, or k-means algorithms',
    inputSchema: ClusterDocumentsInput.shape,
    handler: handleClusterDocuments,
  },
  'ocr_cluster_list': {
    description: 'List document clusters with optional filtering by run ID or tag',
    inputSchema: ClusterListInput.shape,
    handler: handleClusterList,
  },
  'ocr_cluster_get': {
    description: 'Get detailed information about a specific cluster including member documents',
    inputSchema: ClusterGetInput.shape,
    handler: handleClusterGet,
  },
  'ocr_cluster_assign': {
    description: 'Auto-classify a document by assigning it to the nearest existing cluster',
    inputSchema: ClusterAssignInput.shape,
    handler: handleClusterAssign,
  },
  'ocr_cluster_delete': {
    description: 'Delete all clusters and assignments for a clustering run',
    inputSchema: ClusterDeleteInput.shape,
    handler: handleClusterDelete,
  },
};
