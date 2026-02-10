#!/usr/bin/env python3
"""
Document Clustering Worker for OCR Provenance MCP System

Clusters documents by their embedding vectors using HDBSCAN, Agglomerative,
or K-Means algorithms. Reads JSON from stdin, writes JSON to stdout.

CRITICAL CONSTRAINTS:
- NEVER use print() except for the final JSON output to stdout
- Use sys.stderr.write() for any debug logging
- All numpy types MUST be converted to Python types before JSON output

Dependencies: scikit-learn >= 1.3 (includes HDBSCAN), numpy

Usage:
    echo '{"embeddings": [...], "document_ids": [...], "algorithm": "hdbscan"}' | python clustering_worker.py
"""

from __future__ import annotations

import json
import sys
import time

import numpy as np


def validate_inputs(data: dict) -> tuple[np.ndarray, list[str], str, dict]:
    """
    Validate and extract inputs from the parsed JSON data.

    Returns:
        Tuple of (embeddings, document_ids, algorithm, params)

    Raises:
        ValueError: On invalid inputs
    """
    # Validate embeddings
    if "embeddings" not in data:
        raise ValueError("Missing required field: 'embeddings'")

    embeddings = np.array(data["embeddings"], dtype=np.float32)

    if embeddings.ndim != 2:
        raise ValueError(
            f"Embeddings must be 2-dimensional (N, D), got shape {embeddings.shape}"
        )

    n_docs = embeddings.shape[0]
    if n_docs < 2:
        raise ValueError(
            f"At least 2 documents required for clustering, got {n_docs}"
        )

    # Validate document_ids
    document_ids = data.get("document_ids", [])
    if document_ids and len(document_ids) != n_docs:
        raise ValueError(
            f"document_ids length ({len(document_ids)}) does not match "
            f"embeddings count ({n_docs})"
        )

    # Validate algorithm
    algorithm = data.get("algorithm", "hdbscan")
    valid_algorithms = ("hdbscan", "agglomerative", "kmeans")
    if algorithm not in valid_algorithms:
        raise ValueError(
            f"Unknown algorithm '{algorithm}'. Must be one of: {valid_algorithms}"
        )

    # Extract algorithm parameters
    params = {
        "n_clusters": data.get("n_clusters"),
        "min_cluster_size": data.get("min_cluster_size", 3),
        "distance_threshold": data.get("distance_threshold", 1.0),
        "linkage": data.get("linkage", "average"),
    }

    return embeddings, document_ids, algorithm, params


def cluster_hdbscan(
    embeddings: np.ndarray, min_cluster_size: int
) -> tuple[np.ndarray, np.ndarray]:
    """
    Cluster using HDBSCAN with cosine distance matrix.

    Args:
        embeddings: (N, D) float32 array
        min_cluster_size: Minimum points to form a cluster

    Returns:
        Tuple of (labels, probabilities)
    """
    from sklearn.cluster import HDBSCAN
    from sklearn.metrics.pairwise import cosine_distances

    dist_matrix = cosine_distances(embeddings)

    clusterer = HDBSCAN(
        min_cluster_size=min_cluster_size,
        metric="precomputed",
        cluster_selection_method="eom",
        allow_single_cluster=True,
    )

    # MUST pass .copy() -- sklearn may mutate the input distance matrix
    labels = clusterer.fit_predict(dist_matrix.copy())
    probabilities = clusterer.probabilities_

    return labels, probabilities


def cluster_agglomerative(
    embeddings: np.ndarray,
    n_clusters: int | None,
    distance_threshold: float,
    linkage: str,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Cluster using Agglomerative Clustering with cosine metric.

    Args:
        embeddings: (N, D) float32 array
        n_clusters: Number of clusters (None to use distance_threshold)
        distance_threshold: Max linkage distance (used when n_clusters is None)
        linkage: Linkage criterion ('average', 'complete', 'single')

    Returns:
        Tuple of (labels, probabilities)

    Raises:
        ValueError: If ward linkage is requested (incompatible with cosine)
    """
    from sklearn.cluster import AgglomerativeClustering

    # CRITICAL: ward linkage is INCOMPATIBLE with cosine metric
    if linkage == "ward":
        raise ValueError(
            "Ward linkage is incompatible with cosine distance. "
            "Use 'average', 'complete', or 'single' instead."
        )

    if n_clusters is not None:
        clusterer = AgglomerativeClustering(
            n_clusters=n_clusters,
            metric="cosine",
            linkage=linkage,
        )
    else:
        clusterer = AgglomerativeClustering(
            n_clusters=None,
            metric="cosine",
            linkage=linkage,
            distance_threshold=distance_threshold,
        )

    labels = clusterer.fit_predict(embeddings)
    # Agglomerative does not produce probabilities
    probabilities = np.ones(len(labels), dtype=np.float64)

    return labels, probabilities


def cluster_kmeans(
    embeddings: np.ndarray, n_clusters: int | None
) -> tuple[np.ndarray, np.ndarray]:
    """
    Cluster using K-Means.

    Args:
        embeddings: (N, D) float32 array
        n_clusters: Number of clusters (defaults to sqrt(N) if None)

    Returns:
        Tuple of (labels, probabilities)
    """
    from sklearn.cluster import KMeans

    if n_clusters is None:
        # Reasonable default: sqrt(N), clamped to [2, N-1]
        n_clusters = max(2, min(int(np.sqrt(len(embeddings))), len(embeddings) - 1))

    clusterer = KMeans(n_clusters=n_clusters, n_init="auto")
    labels = clusterer.fit_predict(embeddings)
    # K-Means does not produce probabilities
    probabilities = np.ones(len(labels), dtype=np.float64)

    return labels, probabilities


def compute_centroids(
    embeddings: np.ndarray, labels: np.ndarray
) -> list[list[float]]:
    """
    Compute L2-normalized centroid for each cluster (excluding noise label -1).

    Args:
        embeddings: (N, D) float32 array
        labels: Cluster labels (N,)

    Returns:
        List of centroid vectors, one per cluster (ordered by cluster label)
    """
    unique_labels = sorted(set(labels.tolist()))
    centroids = []

    for k in unique_labels:
        if k == -1:
            continue  # Skip noise
        mask = labels == k
        cluster_embeddings = embeddings[mask]
        centroid = cluster_embeddings.mean(axis=0)
        # L2 normalize
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid = centroid / norm
        centroids.append(centroid.tolist())

    return centroids


def compute_coherence_scores(
    embeddings: np.ndarray, labels: np.ndarray
) -> list[float]:
    """
    Compute average pairwise cosine similarity within each cluster.

    Args:
        embeddings: (N, D) float32 array
        labels: Cluster labels (N,)

    Returns:
        List of coherence scores, one per cluster (ordered by cluster label)
    """
    from sklearn.metrics.pairwise import cosine_similarity

    unique_labels = sorted(set(labels.tolist()))
    scores = []

    for k in unique_labels:
        if k == -1:
            continue  # Skip noise
        mask = labels == k
        cluster_embeddings = embeddings[mask]

        if len(cluster_embeddings) < 2:
            # Single-member cluster has perfect coherence
            scores.append(1.0)
            continue

        sim_matrix = cosine_similarity(cluster_embeddings)
        # Average of upper triangle (excluding diagonal)
        n = len(cluster_embeddings)
        upper_sum = (sim_matrix.sum() - np.trace(sim_matrix)) / 2.0
        n_pairs = n * (n - 1) / 2.0
        avg_sim = float(upper_sum / n_pairs) if n_pairs > 0 else 1.0
        scores.append(round(avg_sim, 6))

    return scores


def compute_silhouette(
    embeddings: np.ndarray, labels: np.ndarray
) -> float:
    """
    Compute silhouette score, excluding noise points (label == -1).

    Returns 0.0 if all docs are noise or only 1 cluster exists.
    """
    from sklearn.metrics import silhouette_score

    # Filter out noise
    non_noise_mask = labels >= 0
    filtered_embeddings = embeddings[non_noise_mask]
    filtered_labels = labels[non_noise_mask]

    # Need at least 2 clusters and 2 samples
    unique_clusters = set(filtered_labels.tolist())
    if len(unique_clusters) < 2 or len(filtered_embeddings) < 2:
        return 0.0

    score = silhouette_score(
        filtered_embeddings, filtered_labels, metric="cosine"
    )
    return round(float(score), 6)


def run_clustering(data: dict) -> dict:
    """
    Main clustering pipeline.

    Args:
        data: Parsed input JSON

    Returns:
        Result dict ready for JSON serialization
    """
    start_time = time.perf_counter()

    # Validate inputs
    embeddings, document_ids, algorithm, params = validate_inputs(data)

    # Dispatch to algorithm
    if algorithm == "hdbscan":
        labels, probabilities = cluster_hdbscan(
            embeddings, params["min_cluster_size"]
        )
    elif algorithm == "agglomerative":
        labels, probabilities = cluster_agglomerative(
            embeddings,
            params["n_clusters"],
            params["distance_threshold"],
            params["linkage"],
        )
    elif algorithm == "kmeans":
        labels, probabilities = cluster_kmeans(
            embeddings, params["n_clusters"]
        )

    # Compute metrics
    labels_list = labels.tolist()
    noise_mask = labels == -1
    noise_indices = [int(i) for i in np.where(noise_mask)[0]]
    noise_count = int(noise_mask.sum())

    # Number of actual clusters (excluding noise label -1)
    unique_clusters = set(labels_list)
    unique_clusters.discard(-1)
    n_clusters = len(unique_clusters)

    centroids = compute_centroids(embeddings, labels)
    coherence_scores = compute_coherence_scores(embeddings, labels)
    silhouette = compute_silhouette(embeddings, labels)

    elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)

    return {
        "success": True,
        "labels": labels_list,
        "probabilities": [round(float(p), 6) for p in probabilities],
        "centroids": centroids,
        "n_clusters": n_clusters,
        "noise_count": noise_count,
        "noise_indices": noise_indices,
        "silhouette_score": silhouette,
        "coherence_scores": coherence_scores,
        "elapsed_ms": elapsed_ms,
    }


def main() -> None:
    """Entry point: read JSON from stdin, write JSON to stdout."""
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            raise ValueError("Empty input on stdin")

        data = json.loads(raw_input)
        result = run_clustering(data)
        print(json.dumps(result))
        sys.exit(0)

    except json.JSONDecodeError as e:
        print(json.dumps({
            "success": False,
            "error": f"Invalid JSON input: {e}",
            "error_type": "JSONDecodeError",
        }))
        sys.exit(1)

    except ValueError as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "error_type": "ValueError",
        }))
        sys.exit(1)

    except ImportError as e:
        print(json.dumps({
            "success": False,
            "error": f"Missing dependency: {e}. Requires scikit-learn >= 1.3 and numpy.",
            "error_type": "ImportError",
        }))
        sys.exit(1)

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__,
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
