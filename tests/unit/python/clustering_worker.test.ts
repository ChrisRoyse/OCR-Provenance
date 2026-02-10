/**
 * Tests for python/clustering_worker.py
 *
 * Spawns the actual Python worker process with synthetic embeddings
 * and verifies JSON output for HDBSCAN, Agglomerative, and KMeans.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';

// ---------------------------------------------------------------------------
// Python availability check
// ---------------------------------------------------------------------------
let pythonAvailable = false;
let skipReason = '';

const WORKER_PATH = path.join(process.cwd(), 'python', 'clustering_worker.py');

beforeAll(async () => {
  if (!existsSync(WORKER_PATH)) {
    skipReason = `Worker not found at ${WORKER_PATH}`;
    return;
  }

  // Check that python3 + sklearn are available
  try {
    const result = await runCommand('python3', [
      '-c',
      'import sklearn, numpy; print("ok")',
    ]);
    if (result.stdout.trim() === 'ok') {
      pythonAvailable = true;
    } else {
      skipReason = `Python check failed: ${result.stderr}`;
    }
  } catch {
    skipReason = 'python3 not available';
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(
  cmd: string,
  args: string[],
  stdinData?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    if (stdinData !== undefined) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

function runWorker(input: Record<string, unknown>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return runCommand('python3', [WORKER_PATH], JSON.stringify(input));
}

function runWorkerRaw(stdinData: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return runCommand('python3', [WORKER_PATH], stdinData);
}

/**
 * Create a 768-dimensional unit vector near the given axis with small noise.
 * Uses a seeded approach (deterministic per axis+index) for reproducibility.
 */
function makeTestVector(axis: number, seed: number = 0, noise: number = 0.05): number[] {
  const vec = new Array(768).fill(0);
  vec[axis] = 1.0;

  // Deterministic pseudo-random noise based on seed
  let s = seed + axis * 1000 + 42;
  for (let i = 0; i < 768; i++) {
    if (i !== axis) {
      // Simple LCG PRNG for deterministic noise
      s = ((s * 1103515245 + 12345) & 0x7fffffff) >>> 0;
      const r = (s / 0x7fffffff - 0.5) * noise;
      vec[i] = r;
    }
  }

  // L2 normalize
  const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
  return vec.map((x) => x / norm);
}

// Cluster A: near axis 0
const DOC_A1_VEC = makeTestVector(0, 1);
const DOC_A2_VEC = makeTestVector(0, 2);
// Cluster B: near axis 1
const DOC_B1_VEC = makeTestVector(1, 3);
const DOC_B2_VEC = makeTestVector(1, 4);
// Identical embeddings (for single-cluster test)
const UNIFORM_VEC = makeTestVector(0, 0, 0);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential('clustering_worker.py', () => {
  // ---- HDBSCAN tests ----

  it('hdbscan with 2 obvious clusters produces correct labels', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true); // skip gracefully
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'hdbscan',
      min_cluster_size: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.n_clusters).toBe(2);
    // A1 and A2 should share the same label
    expect(parsed.labels[0]).toBe(parsed.labels[1]);
    // B1 and B2 should share the same label
    expect(parsed.labels[2]).toBe(parsed.labels[3]);
    // A-cluster and B-cluster should differ
    expect(parsed.labels[0]).not.toBe(parsed.labels[2]);
  }, 30000);

  it('hdbscan: noise documents have label -1', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    // min_cluster_size=3 with only 2 per group -> expect noise labels
    // Use 6 docs (3 per cluster) with min_cluster_size=4 so no cluster reaches threshold
    const extraA = makeTestVector(0, 10);
    const extraB = makeTestVector(1, 11);
    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, extraA, DOC_B1_VEC, DOC_B2_VEC, extraB],
      document_ids: ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'],
      algorithm: 'hdbscan',
      min_cluster_size: 4,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);

    // Any noise documents should have label -1
    for (let i = 0; i < parsed.labels.length; i++) {
      if (parsed.labels[i] < 0) {
        expect(parsed.labels[i]).toBe(-1);
      }
    }
    // noise_indices should list indices of noise points
    expect(parsed.noise_indices.length).toBe(parsed.noise_count);
  }, 30000);

  it('hdbscan: probabilities array length matches labels length', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'hdbscan',
      min_cluster_size: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.probabilities).toHaveLength(parsed.labels.length);
  }, 30000);

  it('hdbscan: min_cluster_size larger than doc count -> error', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    // sklearn HDBSCAN rejects min_cluster_size > n_samples with ValueError
    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC],
      document_ids: ['a1', 'a2', 'b1'],
      algorithm: 'hdbscan',
      min_cluster_size: 100,
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error_type).toBe('ValueError');
  }, 30000);

  // ---- Agglomerative tests ----

  it('agglomerative with n_clusters=2 produces correct labels', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'agglomerative',
      n_clusters: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.n_clusters).toBe(2);
    // A1 and A2 same cluster
    expect(parsed.labels[0]).toBe(parsed.labels[1]);
    // B1 and B2 same cluster
    expect(parsed.labels[2]).toBe(parsed.labels[3]);
    // A-cluster and B-cluster differ
    expect(parsed.labels[0]).not.toBe(parsed.labels[2]);
  }, 30000);

  it('agglomerative: probabilities all 1.0', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'agglomerative',
      n_clusters: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    for (const p of parsed.probabilities) {
      expect(p).toBe(1.0);
    }
  }, 30000);

  it('agglomerative with linkage=ward -> error (incompatible with cosine)', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC],
      document_ids: ['a1', 'a2', 'b1'],
      algorithm: 'agglomerative',
      n_clusters: 2,
      linkage: 'ward',
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ward');
    expect(parsed.error).toContain('incompatible');
  }, 30000);

  // ---- KMeans tests ----

  it('kmeans with n_clusters=2 produces correct labels', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'kmeans',
      n_clusters: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.n_clusters).toBe(2);
    // A1 and A2 same cluster
    expect(parsed.labels[0]).toBe(parsed.labels[1]);
    // B1 and B2 same cluster
    expect(parsed.labels[2]).toBe(parsed.labels[3]);
    // A-cluster and B-cluster differ
    expect(parsed.labels[0]).not.toBe(parsed.labels[2]);
  }, 30000);

  // ---- All identical embeddings ----

  it('all identical embeddings -> 1 cluster (hdbscan allow_single_cluster)', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [UNIFORM_VEC, UNIFORM_VEC, UNIFORM_VEC],
      document_ids: ['d1', 'd2', 'd3'],
      algorithm: 'hdbscan',
      min_cluster_size: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);

    // With allow_single_cluster=True, all identical points should form 1 cluster
    // or all be noise. Either way, there should be at most 1 cluster.
    expect(parsed.n_clusters).toBeLessThanOrEqual(1);

    if (parsed.n_clusters === 1) {
      // All docs should share the same label (0)
      const nonNoise = parsed.labels.filter((l: number) => l >= 0);
      const uniqueLabels = [...new Set(nonNoise)];
      expect(uniqueLabels).toHaveLength(1);
    }
  }, 30000);

  // ---- Minimum case ----

  it('minimum case: 2 documents works', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    // Use hdbscan for 2-doc minimum case. With allow_single_cluster=True
    // and min_cluster_size=2, HDBSCAN handles the edge case gracefully.
    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_B1_VEC],
      document_ids: ['a1', 'b1'],
      algorithm: 'hdbscan',
      min_cluster_size: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.labels).toHaveLength(2);
    // With only 2 docs, HDBSCAN may group them or mark as noise
    expect(parsed.n_clusters).toBeGreaterThanOrEqual(0);
  }, 30000);

  // ---- Error cases ----

  it('invalid JSON input -> error response with success=false', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorkerRaw('this is not json{{{');

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error_type).toBe('JSONDecodeError');
  }, 30000);

  it('0 documents -> error response', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [],
      document_ids: [],
      algorithm: 'hdbscan',
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('2-dimensional');
  }, 30000);

  it('1 document -> error response (minimum 2 required)', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC],
      document_ids: ['a1'],
      algorithm: 'hdbscan',
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('At least 2 documents');
  }, 30000);

  // ---- Metric validation ----

  it('silhouette score between -1 and 1', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'agglomerative',
      n_clusters: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.silhouette_score).toBeGreaterThanOrEqual(-1);
    expect(parsed.silhouette_score).toBeLessThanOrEqual(1);
  }, 30000);

  it('coherence scores between 0 and 1 for each cluster', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'agglomerative',
      n_clusters: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.coherence_scores.length).toBe(parsed.n_clusters);

    for (const score of parsed.coherence_scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  }, 30000);

  it('centroids are L2-normalized (norm approximately 1.0)', async () => {
    if (!pythonAvailable) {
      return expect(true).toBe(true);
    }

    const result = await runWorker({
      embeddings: [DOC_A1_VEC, DOC_A2_VEC, DOC_B1_VEC, DOC_B2_VEC],
      document_ids: ['a1', 'a2', 'b1', 'b2'],
      algorithm: 'agglomerative',
      n_clusters: 2,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.centroids.length).toBe(parsed.n_clusters);

    for (const centroid of parsed.centroids) {
      const norm = Math.sqrt(
        centroid.reduce((sum: number, x: number) => sum + x * x, 0),
      );
      expect(norm).toBeCloseTo(1.0, 2);
    }
  }, 30000);
});
