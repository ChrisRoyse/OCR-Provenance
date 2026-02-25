/**
 * Cluster and Document Clustering interfaces
 *
 * Types for document clustering and auto-classification.
 * Clusters group semantically similar documents using HDBSCAN or agglomerative algorithms.
 *
 * @module models/cluster
 */

/**
 * A cluster of semantically similar documents
 */
export interface Cluster {
  id: string;
  run_id: string;
  cluster_index: number;
  label: string | null;
  description: string | null;
  classification_tag: string | null;
  document_count: number;
  centroid_json: string | null;
  top_terms_json: string | null;
  coherence_score: number | null;
  algorithm: string;
  algorithm_params_json: string;
  silhouette_score: number | null;
  content_hash: string;
  provenance_id: string;
  created_at: string;
  processing_duration_ms: number | null;
}

/**
 * Assignment of a document to a cluster within a specific run
 */
export interface DocumentCluster {
  id: string;
  document_id: string;
  cluster_id: string | null;
  run_id: string;
  similarity_to_centroid: number;
  membership_probability: number;
  is_noise: boolean;
  assigned_at: string;
}

/**
 * Configuration for a clustering run
 */
export interface ClusterRunConfig {
  algorithm: 'hdbscan' | 'agglomerative' | 'kmeans';
  n_clusters: number | null;
  min_cluster_size: number;
  distance_threshold: number | null;
  linkage: 'average' | 'complete' | 'single';
}

/**
 * Result of a clustering run
 */
export interface ClusterRunResult {
  run_id: string;
  algorithm: string;
  n_clusters: number;
  total_documents: number;
  noise_document_ids: string[];
  silhouette_score: number;
  clusters: ClusterResultItem[];
  processing_duration_ms: number;
}

/**
 * A single cluster within a run result
 */
export interface ClusterResultItem {
  cluster_index: number;
  document_count: number;
  coherence_score: number;
  centroid: number[];
  document_ids: string[];
  similarities: number[];
  probabilities: number[];
}
