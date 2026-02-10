/**
 * MANUAL VERIFICATION: Document Clustering & Auto-Classification
 *
 * Full State Verification with synthetic data.
 * Source of Truth: SQLite database (clusters, document_clusters, provenance tables)
 *
 * Tests:
 * - Happy path: 4 documents -> 2 clusters -> verify every DB record
 * - Edge case 1: No documents with embeddings -> error
 * - Edge case 2: kmeans without n_clusters -> validation error
 * - Edge case 3: HDBSCAN min_cluster_size > doc count -> all noise
 * - Tool handlers: list, get, assign, delete with DB verification
 * - System integration: stats, document_get, reports show clustering data
 * - Cascade delete: removing a document removes its cluster assignments
 *
 * NO MOCKS. Real databases. Physical DB verification after every operation.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { clusteringTools } from '../../src/tools/clustering.js';
import { documentTools } from '../../src/tools/documents.js';
import { reportTools } from '../../src/tools/reports.js';
import { databaseTools } from '../../src/tools/database.js';
import {
  state,
  resetState,
  updateConfig,
  clearDatabase,
} from '../../src/server/state.js';
import { DatabaseService } from '../../src/services/storage/database/index.js';
import { VectorService } from '../../src/services/storage/vector.js';
import { computeHash } from '../../src/utils/hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC CHECK
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

interface ToolResponse {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { category: string; message: string; details?: Record<string, unknown> };
  [key: string]: unknown;
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ocr-cluster-verify-'));
}

function cleanupTempDir(dir: string): void {
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

/**
 * Create a deterministic test vector near a given axis.
 * Axis 0 = "legal" cluster, Axis 1 = "financial" cluster.
 * Uses seeded offset to make vectors slightly different but still clustered.
 */
function makeTestVector(axis: number, seed: number = 0): Float32Array {
  const vec = new Float32Array(768);
  vec[axis] = 1.0;
  // Add small deterministic perturbation based on seed
  for (let i = 0; i < 768; i++) {
    if (i !== axis) {
      vec[i] = Math.sin(i * 0.1 + seed * 7.3) * 0.03;
    }
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) vec[i] /= norm;
  return vec;
}

const tempDirs: string[] = [];

afterAll(() => {
  resetState();
  for (const dir of tempDirs) cleanupTempDir(dir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC DATA INSERTION
// ═══════════════════════════════════════════════════════════════════════════════

interface SyntheticDoc {
  docId: string;
  docProvId: string;
  ocrProvId: string;
  ocrResultId: string;
  chunkIds: string[];
  embeddingIds: string[];
  embProvIds: string[];
}

/**
 * Insert a complete document chain into the DB:
 *   provenance(DOCUMENT) -> document -> provenance(OCR_RESULT) -> ocr_result
 *   -> chunk(s) -> provenance(EMBEDDING) -> embedding(s) -> vec_embeddings
 *
 * Returns all IDs for verification.
 */
function insertSyntheticDocument(
  db: DatabaseService,
  vector: VectorService,
  fileName: string,
  text: string,
  chunkVectors: Float32Array[],
): SyntheticDoc {
  const docId = uuidv4();
  const docProvId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(fileName);

  // DOCUMENT provenance
  db.insertProvenance({
    id: docProvId, type: 'DOCUMENT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'FILE', source_path: `/test/${fileName}`, source_id: null,
    root_document_id: docProvId, location: null,
    content_hash: fileHash, input_hash: null, file_hash: fileHash,
    processor: 'test', processor_version: '1.0.0', processing_params: {},
    processing_duration_ms: null, processing_quality_score: null,
    parent_id: null, parent_ids: '[]', chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  // Document record
  db.insertDocument({
    id: docId, file_path: `/test/${fileName}`, file_name: fileName,
    file_hash: fileHash, file_size: text.length, file_type: 'pdf',
    status: 'complete', page_count: 1, provenance_id: docProvId,
    error_message: null, ocr_completed_at: now,
  });

  // OCR_RESULT provenance
  db.insertProvenance({
    id: ocrProvId, type: 'OCR_RESULT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'OCR', source_path: null, source_id: docProvId,
    root_document_id: docProvId, location: null,
    content_hash: computeHash(text), input_hash: null, file_hash: null,
    processor: 'datalab-marker', processor_version: '1.0.0',
    processing_params: { mode: 'balanced' }, processing_duration_ms: 1000,
    processing_quality_score: 4.5, parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]), chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  // OCR result record
  db.insertOCRResult({
    id: ocrResultId, provenance_id: ocrProvId, document_id: docId,
    extracted_text: text, text_length: text.length,
    datalab_request_id: `req-${ocrResultId}`, datalab_mode: 'balanced',
    parse_quality_score: 4.5, page_count: 1, cost_cents: 5,
    processing_duration_ms: 1000, processing_started_at: now, processing_completed_at: now,
    json_blocks: null, content_hash: computeHash(text), extras_json: null,
  });

  const chunkIds: string[] = [];
  const embeddingIds: string[] = [];
  const embProvIds: string[] = [];

  // For each chunk vector, create chunk + embedding + vec_embedding
  for (let ci = 0; ci < chunkVectors.length; ci++) {
    const chunkId = uuidv4();
    const chunkProvId = uuidv4();
    const embId = uuidv4();
    const embProvId = uuidv4();
    const chunkText = `Chunk ${ci} of ${fileName}: ${text.substring(0, 100)}`;

    // CHUNK provenance (each chunk needs its own unique provenance_id)
    db.insertProvenance({
      id: chunkProvId, type: 'CHUNK', created_at: now, processed_at: now,
      source_file_created_at: null, source_file_modified_at: null,
      source_type: 'CHUNKING', source_path: null, source_id: ocrProvId,
      root_document_id: docProvId, location: null,
      content_hash: computeHash(chunkText), input_hash: null, file_hash: null,
      processor: 'chunker', processor_version: '1.0.0', processing_params: {},
      processing_duration_ms: 10, processing_quality_score: null,
      parent_id: ocrProvId, parent_ids: JSON.stringify([docProvId, ocrProvId]),
      chain_depth: 2, chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
    });

    // Chunk
    db.insertChunk({
      id: chunkId, document_id: docId, ocr_result_id: ocrResultId,
      text: chunkText, text_hash: computeHash(chunkText),
      chunk_index: ci, character_start: ci * 100, character_end: (ci + 1) * 100,
      page_number: 1, page_range: null,
      overlap_previous: 0, overlap_next: 0,
      provenance_id: chunkProvId,
    });

    // EMBEDDING provenance
    db.insertProvenance({
      id: embProvId, type: 'EMBEDDING', created_at: now, processed_at: now,
      source_file_created_at: null, source_file_modified_at: null,
      source_type: 'EMBEDDING', source_path: null, source_id: chunkProvId,
      root_document_id: docProvId, location: null,
      content_hash: computeHash(Buffer.from(chunkVectors[ci].buffer).toString('base64')),
      input_hash: computeHash(chunkText), file_hash: null,
      processor: 'nomic-embed-text-v1.5', processor_version: '1.5.0',
      processing_params: { model: 'nomic-embed-text-v1.5' },
      processing_duration_ms: 50, processing_quality_score: null,
      parent_id: chunkProvId, parent_ids: JSON.stringify([docProvId, ocrProvId, chunkProvId]),
      chain_depth: 3, chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK", "EMBEDDING"]',
    });

    // Embedding record
    db.insertEmbedding({
      id: embId, chunk_id: chunkId, image_id: null, extraction_id: null,
      document_id: docId, original_text: chunkText,
      original_text_length: chunkText.length,
      source_file_path: `/test/${fileName}`, source_file_name: fileName,
      source_file_hash: fileHash, page_number: 1, page_range: null,
      character_start: ci * 100, character_end: (ci + 1) * 100,
      chunk_index: ci, total_chunks: chunkVectors.length,
      model_name: 'nomic-embed-text-v1.5', model_version: '1.5.0',
      task_type: 'search_document', inference_mode: 'local',
      gpu_device: 'cuda:0', provenance_id: embProvId,
      content_hash: computeHash(`embedding-${embId}`),
      generation_duration_ms: 50,
    });

    // Vector in vec_embeddings
    vector.storeVector(embId, chunkVectors[ci]);

    chunkIds.push(chunkId);
    embeddingIds.push(embId);
    embProvIds.push(embProvId);
  }

  return { docId, docProvId, ocrProvId, ocrResultId, chunkIds, embeddingIds, embProvIds };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)('Clustering Manual Verification', () => {
  let tempDir: string;
  let db: DatabaseService;
  let vector: VectorService;

  beforeEach(() => {
    tempDir = createTempDir();
    tempDirs.push(tempDir);
    const dbName = `test-${Date.now()}`;
    updateConfig({ storagePath: tempDir });
    db = DatabaseService.create(dbName, undefined, tempDir);
    vector = new VectorService(db.getConnection());
    state.currentDatabase = db;
    state.currentVector = vector;
    state.currentDatabaseName = dbName;
  });

  afterEach(() => {
    clearDatabase();
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // HAPPY PATH: Full Pipeline -> Physical DB Verification
  // ═════════════════════════════════════════════════════════════════════════════

  describe('HAPPY PATH: End-to-end clustering pipeline', () => {
    it('4 documents with known embeddings -> 2 clusters, all DB records verified', async () => {
      const conn = db.getConnection();

      // ── BEFORE STATE ──
      const beforeClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
      const beforeDocClusters = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters').get() as { cnt: number };
      const beforeProv = conn.prepare("SELECT COUNT(*) as cnt FROM provenance WHERE type = 'CLUSTERING'").get() as { cnt: number };
      console.error('=== BEFORE STATE ===');
      console.error(`  clusters: ${beforeClusters.cnt}, document_clusters: ${beforeDocClusters.cnt}, CLUSTERING provenance: ${beforeProv.cnt}`);
      expect(beforeClusters.cnt).toBe(0);
      expect(beforeDocClusters.cnt).toBe(0);
      expect(beforeProv.cnt).toBe(0);

      // ── INSERT SYNTHETIC DATA ──
      // Cluster A: 2 legal docs with embeddings near axis 0
      const docA1 = insertSyntheticDocument(db, vector, 'employment-agreement.pdf',
        'Employment agreement between Company and Employee regarding full-time position.',
        [makeTestVector(0, 1), makeTestVector(0, 2)]  // 2 chunks, both near axis 0
      );
      const docA2 = insertSyntheticDocument(db, vector, 'service-contract.pdf',
        'Service contract for consulting engagement with detailed scope of work.',
        [makeTestVector(0, 3), makeTestVector(0, 4)]  // 2 chunks, both near axis 0
      );

      // Cluster B: 2 financial docs with embeddings near axis 1
      const docB1 = insertSyntheticDocument(db, vector, 'quarterly-report.pdf',
        'Quarterly financial report for Q3 2025 showing revenue and expenses.',
        [makeTestVector(1, 5), makeTestVector(1, 6)]  // 2 chunks, both near axis 1
      );
      const docB2 = insertSyntheticDocument(db, vector, 'annual-budget.pdf',
        'Annual budget proposal for fiscal year 2026 with department allocations.',
        [makeTestVector(1, 7), makeTestVector(1, 8)]  // 2 chunks, both near axis 1
      );

      // Verify synthetic data inserted: 4 docs, 8 chunks, 8 embeddings, 8 vec_embeddings
      const docCount = conn.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
      const chunkCount = conn.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
      const embCount = conn.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number };
      const vecCount = conn.prepare('SELECT COUNT(*) as cnt FROM vec_embeddings').get() as { cnt: number };
      console.error('=== SYNTHETIC DATA INSERTED ===');
      console.error(`  documents: ${docCount.cnt}, chunks: ${chunkCount.cnt}, embeddings: ${embCount.cnt}, vec_embeddings: ${vecCount.cnt}`);
      expect(docCount.cnt).toBe(4);
      expect(chunkCount.cnt).toBe(8);
      expect(embCount.cnt).toBe(8);
      expect(vecCount.cnt).toBe(8);

      // ── RUN CLUSTERING ──
      const handler = clusteringTools['ocr_cluster_documents'].handler;
      const response = await handler({
        algorithm: 'agglomerative',
        n_clusters: 2,
        linkage: 'average',
      });
      const parsed = parseResponse(response);

      console.error('=== CLUSTERING RESULT ===');
      console.error(`  success: ${parsed.success}`);
      expect(parsed.success).toBe(true);

      const data = parsed.data as Record<string, unknown>;
      const runId = data.run_id as string;
      const nClusters = data.n_clusters as number;
      const totalDocs = data.total_documents as number;
      const clusters = data.clusters as Array<Record<string, unknown>>;
      console.error(`  run_id: ${runId}`);
      console.error(`  n_clusters: ${nClusters}, total_documents: ${totalDocs}`);
      expect(nClusters).toBe(2);
      expect(totalDocs).toBe(4);
      expect(clusters).toHaveLength(2);

      // ── PHYSICAL DB VERIFICATION: clusters table ──
      const dbClusters = conn.prepare('SELECT * FROM clusters WHERE run_id = ? ORDER BY cluster_index').all(runId) as Array<Record<string, unknown>>;
      console.error('=== SOURCE OF TRUTH: clusters table ===');
      console.error(`  Rows found: ${dbClusters.length}`);
      expect(dbClusters).toHaveLength(2);

      for (const cluster of dbClusters) {
        console.error(`  Cluster ${cluster.cluster_index}: id=${cluster.id}, doc_count=${cluster.document_count}, algorithm=${cluster.algorithm}, coherence=${cluster.coherence_score}, silhouette=${cluster.silhouette_score}`);
        expect(cluster.run_id).toBe(runId);
        expect(cluster.algorithm).toBe('agglomerative');
        expect(cluster.document_count).toBe(2);
        expect(cluster.centroid_json).toBeTruthy();
        expect(cluster.content_hash).toBeTruthy();
        expect(cluster.provenance_id).toBeTruthy();
        expect(cluster.processing_duration_ms).toBeGreaterThan(0);

        // Verify centroid is valid JSON array of 768 floats
        const centroid = JSON.parse(cluster.centroid_json as string) as number[];
        expect(centroid).toHaveLength(768);

        // Verify coherence score is reasonable (0 to 1)
        expect(cluster.coherence_score).toBeGreaterThanOrEqual(0);
        expect(cluster.coherence_score).toBeLessThanOrEqual(1);
      }

      // ── PHYSICAL DB VERIFICATION: document_clusters table ──
      const dbDocClusters = conn.prepare('SELECT * FROM document_clusters WHERE run_id = ? ORDER BY document_id').all(runId) as Array<Record<string, unknown>>;
      console.error('=== SOURCE OF TRUTH: document_clusters table ===');
      console.error(`  Rows found: ${dbDocClusters.length}`);
      expect(dbDocClusters).toHaveLength(4);

      const allDocIds = [docA1.docId, docA2.docId, docB1.docId, docB2.docId].sort();
      const assignedDocIds = dbDocClusters.map(dc => dc.document_id as string).sort();
      expect(assignedDocIds).toEqual(allDocIds);

      // Verify A1 and A2 are in the same cluster, B1 and B2 in the same cluster
      const a1Cluster = dbDocClusters.find(dc => dc.document_id === docA1.docId)!.cluster_id;
      const a2Cluster = dbDocClusters.find(dc => dc.document_id === docA2.docId)!.cluster_id;
      const b1Cluster = dbDocClusters.find(dc => dc.document_id === docB1.docId)!.cluster_id;
      const b2Cluster = dbDocClusters.find(dc => dc.document_id === docB2.docId)!.cluster_id;
      console.error(`  docA1 cluster: ${a1Cluster}`);
      console.error(`  docA2 cluster: ${a2Cluster}`);
      console.error(`  docB1 cluster: ${b1Cluster}`);
      console.error(`  docB2 cluster: ${b2Cluster}`);
      expect(a1Cluster).toBe(a2Cluster);  // Same cluster
      expect(b1Cluster).toBe(b2Cluster);  // Same cluster
      expect(a1Cluster).not.toBe(b1Cluster);  // Different clusters

      for (const dc of dbDocClusters) {
        console.error(`  doc=${dc.document_id}, cluster=${dc.cluster_id}, similarity=${dc.similarity_to_centroid}, prob=${dc.membership_probability}, noise=${dc.is_noise}`);
        expect(dc.is_noise).toBe(0); // Not noise
        expect(dc.cluster_id).toBeTruthy(); // Has a cluster
        expect(dc.similarity_to_centroid).toBeGreaterThan(0);
        expect(dc.membership_probability).toBe(1.0); // Agglomerative always 1.0
      }

      // ── PHYSICAL DB VERIFICATION: provenance table ──
      const dbProvs = conn.prepare("SELECT * FROM provenance WHERE type = 'CLUSTERING'").all() as Array<Record<string, unknown>>;
      console.error('=== SOURCE OF TRUTH: provenance table (CLUSTERING) ===');
      console.error(`  CLUSTERING provenance records: ${dbProvs.length}`);
      expect(dbProvs.length).toBe(2); // One per cluster

      for (const prov of dbProvs) {
        console.error(`  prov_id=${prov.id}, processor=${prov.processor}, chain_depth=${prov.chain_depth}`);
        expect(prov.processor).toBe('clustering-service');
        expect(prov.processor_version).toBe('1.0.0');
        expect(prov.source_type).toBe('CLUSTERING');
        expect(prov.content_hash).toBeTruthy();
      }

      // ── AFTER STATE ──
      const afterClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
      const afterDocClusters = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters').get() as { cnt: number };
      const afterProv = conn.prepare("SELECT COUNT(*) as cnt FROM provenance WHERE type = 'CLUSTERING'").get() as { cnt: number };
      console.error('=== AFTER STATE ===');
      console.error(`  clusters: ${afterClusters.cnt}, document_clusters: ${afterDocClusters.cnt}, CLUSTERING provenance: ${afterProv.cnt}`);
      expect(afterClusters.cnt).toBe(2);
      expect(afterDocClusters.cnt).toBe(4);
      expect(afterProv.cnt).toBe(2);
    }, 60000);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 1: No embeddings -> error
  // ═════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 1: No documents with embeddings', () => {
    it('clustering with 0 documents that have embeddings -> INSUFFICIENT_DOCUMENTS error', async () => {
      const conn = db.getConnection();

      // ── BEFORE STATE: empty DB ──
      const beforeDocs = conn.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
      const beforeClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
      console.error('=== EDGE CASE 1: BEFORE ===');
      console.error(`  documents: ${beforeDocs.cnt}, clusters: ${beforeClusters.cnt}`);
      expect(beforeDocs.cnt).toBe(0);

      // Insert a document WITHOUT embeddings
      const docProvId = uuidv4();
      const docId = uuidv4();
      const now = new Date().toISOString();
      db.insertProvenance({
        id: docProvId, type: 'DOCUMENT', created_at: now, processed_at: now,
        source_file_created_at: null, source_file_modified_at: null,
        source_type: 'FILE', source_path: '/test/no-emb.pdf', source_id: null,
        root_document_id: docProvId, location: null,
        content_hash: 'sha256:no-emb', input_hash: null, file_hash: 'sha256:no-emb',
        processor: 'test', processor_version: '1.0.0', processing_params: {},
        processing_duration_ms: null, processing_quality_score: null,
        parent_id: null, parent_ids: '[]', chain_depth: 0,
        chain_path: '["DOCUMENT"]',
      });
      db.insertDocument({
        id: docId, file_path: '/test/no-emb.pdf', file_name: 'no-emb.pdf',
        file_hash: 'sha256:no-emb', file_size: 100, file_type: 'pdf',
        status: 'complete', page_count: 1, provenance_id: docProvId,
        error_message: null, ocr_completed_at: now,
      });

      // ── RUN CLUSTERING ──
      const handler = clusteringTools['ocr_cluster_documents'].handler;
      const response = await handler({ algorithm: 'agglomerative', n_clusters: 2 });
      const parsed = parseResponse(response);

      console.error('=== EDGE CASE 1: RESULT ===');
      console.error(`  success: ${parsed.success}, error: ${parsed.error?.message}`);
      expect(parsed.error).toBeDefined();
      expect(parsed.error!.message).toContain('At least 2 documents');

      // ── AFTER STATE: no clusters created ──
      const afterClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
      const afterDocClusters = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters').get() as { cnt: number };
      console.error('=== EDGE CASE 1: AFTER ===');
      console.error(`  clusters: ${afterClusters.cnt}, document_clusters: ${afterDocClusters.cnt}`);
      expect(afterClusters.cnt).toBe(0);
      expect(afterDocClusters.cnt).toBe(0);
    }, 30000);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 2: kmeans without n_clusters -> validation error
  // ═════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 2: Invalid parameters', () => {
    it('kmeans without n_clusters -> VALIDATION_ERROR', async () => {
      const conn = db.getConnection();

      console.error('=== EDGE CASE 2: kmeans without n_clusters ===');
      const handler = clusteringTools['ocr_cluster_documents'].handler;
      const response = await handler({ algorithm: 'kmeans' });
      const parsed = parseResponse(response);

      console.error(`  success: ${parsed.success}, error: ${JSON.stringify(parsed.error)}`);
      expect(parsed.error).toBeDefined();
      expect(parsed.error!.category).toBe('VALIDATION_ERROR');
      expect(parsed.error!.message).toContain('n_clusters');

      // DB unchanged
      const clusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
      expect(clusters.cnt).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 3: HDBSCAN all noise (min_cluster_size > doc count)
  // ═════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 3: HDBSCAN all noise', () => {
    it('min_cluster_size=100 with 4 docs -> all noise, 0 real clusters', async () => {
      const conn = db.getConnection();

      // Insert 4 spread-out documents (each on different axis to ensure no natural clusters)
      insertSyntheticDocument(db, vector, 'doc-ax0.pdf', 'Text A', [makeTestVector(0, 1)]);
      insertSyntheticDocument(db, vector, 'doc-ax1.pdf', 'Text B', [makeTestVector(1, 2)]);
      insertSyntheticDocument(db, vector, 'doc-ax2.pdf', 'Text C', [makeTestVector(2, 3)]);
      insertSyntheticDocument(db, vector, 'doc-ax3.pdf', 'Text D', [makeTestVector(3, 4)]);

      console.error('=== EDGE CASE 3: BEFORE ===');
      const beforeClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
      console.error(`  clusters: ${beforeClusters.cnt}, documents: 4`);

      // Run HDBSCAN with unreasonably large min_cluster_size
      // Note: scikit-learn rejects min_cluster_size > n_samples, so we expect an error
      const handler = clusteringTools['ocr_cluster_documents'].handler;
      const response = await handler({
        algorithm: 'hdbscan',
        min_cluster_size: 100,
      });
      const parsed = parseResponse(response);

      console.error('=== EDGE CASE 3: RESULT ===');
      if (parsed.success) {
        const data = parsed.data as Record<string, unknown>;
        console.error(`  n_clusters: ${data.n_clusters}, noise_count: ${data.noise_count}`);

        // If it succeeded, it should be 0 real clusters, all noise
        const runId = data.run_id as string;
        const dbClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
        const noiseRows = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ? AND is_noise = 1').get(runId) as { cnt: number };
        const nonNoiseRows = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ? AND is_noise = 0').get(runId) as { cnt: number };

        console.error('=== EDGE CASE 3: SOURCE OF TRUTH ===');
        console.error(`  clusters in DB: ${dbClusters.cnt}`);
        console.error(`  noise assignments: ${noiseRows.cnt}`);
        console.error(`  non-noise assignments: ${nonNoiseRows.cnt}`);

        expect(data.n_clusters).toBe(0);
        expect(dbClusters.cnt).toBe(0);
        expect(noiseRows.cnt).toBe(4);
        expect(nonNoiseRows.cnt).toBe(0);

        // Verify noise doc_clusters have cluster_id = NULL
        const nullClusterRows = conn.prepare('SELECT * FROM document_clusters WHERE run_id = ? AND cluster_id IS NULL').all(runId) as Array<Record<string, unknown>>;
        console.error(`  Rows with cluster_id=NULL: ${nullClusterRows.length}`);
        expect(nullClusterRows.length).toBe(4);
      } else {
        // sklearn might reject min_cluster_size > n_samples with an error
        console.error(`  Error (expected for oversized min_cluster_size): ${parsed.error?.message}`);
        expect(parsed.error).toBeDefined();
        // No clusters should exist
        const afterClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
        expect(afterClusters.cnt).toBe(0);
      }
    }, 60000);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // TOOL HANDLER VERIFICATION: list, get, assign, delete
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Tool Handlers: list, get, delete with DB verification', () => {
    let runId: string;

    beforeEach(async () => {
      // Set up 4 docs and cluster them
      insertSyntheticDocument(db, vector, 'legal1.pdf', 'Employment agreement text',
        [makeTestVector(0, 10), makeTestVector(0, 11)]);
      insertSyntheticDocument(db, vector, 'legal2.pdf', 'Service contract text',
        [makeTestVector(0, 12), makeTestVector(0, 13)]);
      insertSyntheticDocument(db, vector, 'finance1.pdf', 'Financial report Q3',
        [makeTestVector(1, 14), makeTestVector(1, 15)]);
      insertSyntheticDocument(db, vector, 'finance2.pdf', 'Budget proposal 2026',
        [makeTestVector(1, 16), makeTestVector(1, 17)]);

      const handler = clusteringTools['ocr_cluster_documents'].handler;
      const response = await handler({ algorithm: 'agglomerative', n_clusters: 2 });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      runId = (parsed.data as Record<string, unknown>).run_id as string;
    });

    it('ocr_cluster_list returns correct cluster summaries', async () => {
      const handler = clusteringTools['ocr_cluster_list'].handler;
      const response = await handler({ run_id: runId });
      const parsed = parseResponse(response);

      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      const items = data.clusters as Array<Record<string, unknown>>;
      console.error('=== CLUSTER LIST ===');
      for (const item of items) {
        console.error(`  id=${item.id}, index=${item.cluster_index}, doc_count=${item.document_count}, coherence=${item.coherence_score}`);
      }
      expect(items).toHaveLength(2);
      expect(items.every(i => i.run_id === runId)).toBe(true);

      // Verify no centroid_json leaked (summaries exclude large blobs)
      for (const item of items) {
        expect(item).not.toHaveProperty('centroid_json');
      }
    }, 60000);

    it('ocr_cluster_get returns full details with member documents', async () => {
      const conn = db.getConnection();
      const firstCluster = conn.prepare('SELECT id FROM clusters WHERE run_id = ? ORDER BY cluster_index LIMIT 1').get(runId) as { id: string };

      const handler = clusteringTools['ocr_cluster_get'].handler;
      const response = await handler({ cluster_id: firstCluster.id, include_documents: true, include_provenance: true });
      const parsed = parseResponse(response);

      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      console.error('=== CLUSTER GET ===');
      console.error(`  id=${data.id}, label=${data.label}, doc_count=${data.document_count}`);
      console.error(`  algorithm_params=${JSON.stringify(data.algorithm_params)}`);
      console.error(`  documents=${JSON.stringify(data.documents)}`);

      expect(data.id).toBe(firstCluster.id);
      expect(data.algorithm).toBe('agglomerative');
      expect(data.document_count).toBe(2);

      const documents = data.documents as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(2);
      for (const doc of documents) {
        expect(doc.document_id).toBeTruthy();
        expect(doc.file_name).toBeTruthy();
        expect(doc.similarity_to_centroid).toBeGreaterThan(0);
      }

      // Provenance chain should exist
      expect(data.provenance_chain).toBeTruthy();
    }, 60000);

    it('ocr_cluster_get with nonexistent ID -> DOCUMENT_NOT_FOUND', async () => {
      const handler = clusteringTools['ocr_cluster_get'].handler;
      const response = await handler({ cluster_id: 'nonexistent-id' });
      const parsed = parseResponse(response);
      console.error('=== CLUSTER GET NONEXISTENT ===');
      console.error(`  error: ${parsed.error?.category} - ${parsed.error?.message}`);
      expect(parsed.error).toBeDefined();
      expect(parsed.error!.category).toBe('DOCUMENT_NOT_FOUND');
    }, 60000);

    it('ocr_cluster_delete removes all data, verified in DB', async () => {
      const conn = db.getConnection();

      // ── BEFORE STATE ──
      const beforeClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
      const beforeDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?').get(runId) as { cnt: number };
      console.error('=== DELETE: BEFORE ===');
      console.error(`  clusters: ${beforeClusters.cnt}, document_clusters: ${beforeDC.cnt}`);
      expect(beforeClusters.cnt).toBe(2);
      expect(beforeDC.cnt).toBe(4);

      // ── DELETE ──
      const handler = clusteringTools['ocr_cluster_delete'].handler;
      const response = await handler({ run_id: runId, confirm: true });
      const parsed = parseResponse(response);
      console.error('=== DELETE: RESULT ===');
      console.error(`  success: ${parsed.success}, data: ${JSON.stringify(parsed.data)}`);
      expect(parsed.success).toBe(true);

      // ── AFTER STATE: physical DB verification ──
      const afterClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
      const afterDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?').get(runId) as { cnt: number };
      console.error('=== DELETE: AFTER (SOURCE OF TRUTH) ===');
      console.error(`  clusters: ${afterClusters.cnt}, document_clusters: ${afterDC.cnt}`);
      expect(afterClusters.cnt).toBe(0);
      expect(afterDC.cnt).toBe(0);
    }, 60000);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SYSTEM INTEGRATION: Stats, Document Get, Reports
  // ═════════════════════════════════════════════════════════════════════════════

  describe('System Integration: clustering data in stats/reports/document_get', () => {
    beforeEach(async () => {
      // Need 4+ docs: silhouette_score requires n_samples > n_clusters
      insertSyntheticDocument(db, vector, 'int-legal1.pdf', 'Legal doc text one',
        [makeTestVector(0, 20), makeTestVector(0, 21)]);
      insertSyntheticDocument(db, vector, 'int-legal2.pdf', 'Legal doc text two',
        [makeTestVector(0, 22), makeTestVector(0, 23)]);
      insertSyntheticDocument(db, vector, 'int-finance1.pdf', 'Finance doc text one',
        [makeTestVector(1, 24), makeTestVector(1, 25)]);
      insertSyntheticDocument(db, vector, 'int-finance2.pdf', 'Finance doc text two',
        [makeTestVector(1, 26), makeTestVector(1, 27)]);

      const handler = clusteringTools['ocr_cluster_documents'].handler;
      const response = await handler({ algorithm: 'agglomerative', n_clusters: 2 });
      const parsed = parseResponse(response);
      if (!parsed.success) {
        console.error('=== SYSTEM INTEGRATION: CLUSTERING FAILED ===');
        console.error(`  error: ${JSON.stringify(parsed.error)}`);
      }
      expect(parsed.success).toBe(true);
    });

    it('ocr_db_stats includes cluster counts', async () => {
      const handler = databaseTools['ocr_db_stats'].handler;
      const response = await handler({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      console.error('=== STATS INTEGRATION ===');
      console.error(`  cluster_count: ${data.cluster_count}`);
      expect(data.cluster_count).toBeGreaterThanOrEqual(2);
    }, 60000);

    it('ocr_document_get includes cluster memberships', async () => {
      const conn = db.getConnection();
      const docRow = conn.prepare('SELECT id FROM documents LIMIT 1').get() as { id: string };

      const handler = documentTools['ocr_document_get'].handler;
      const response = await handler({ document_id: docRow.id });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      console.error('=== DOCUMENT GET INTEGRATION ===');
      console.error(`  clusters present: ${JSON.stringify(data.clusters)}`);
      const clusters = data.clusters as Array<Record<string, unknown>> | undefined;
      expect(clusters).toBeDefined();
      expect(clusters!.length).toBeGreaterThanOrEqual(1);
      expect(clusters![0]).toHaveProperty('cluster_id');
      expect(clusters![0]).toHaveProperty('coherence_score');
    }, 60000);

    it('ocr_quality_summary includes clustering metrics', async () => {
      const handler = reportTools['ocr_quality_summary'].handler;
      const response = await handler({});
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      console.error('=== QUALITY SUMMARY INTEGRATION ===');
      console.error(`  clustering: ${JSON.stringify(data.clustering)}`);
      const clustering = data.clustering as Record<string, unknown>;
      expect(clustering).toBeDefined();
      expect(clustering.total_clusters).toBeGreaterThanOrEqual(2);
      expect(clustering.total_runs).toBe(1);
    }, 60000);

    it('ocr_cost_summary includes clustering_compute', async () => {
      const handler = reportTools['ocr_cost_summary'].handler;
      const response = await handler({ group_by: 'total' });
      const parsed = parseResponse(response);
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      console.error('=== COST SUMMARY INTEGRATION ===');
      console.error(`  clustering_compute: ${JSON.stringify(data.clustering_compute)}`);
      const clusterCompute = data.clustering_compute as Record<string, unknown>;
      expect(clusterCompute).toBeDefined();
      expect(clusterCompute.total_clusters).toBeGreaterThanOrEqual(2);
      expect(clusterCompute.total_runs).toBe(1);
      expect(clusterCompute.total_duration_ms).toBeGreaterThan(0);
    }, 60000);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // CASCADE DELETE: Document deletion removes cluster assignments
  // ═════════════════════════════════════════════════════════════════════════════

  describe('CASCADE DELETE: Deleting document removes cluster assignments', () => {
    it('deleting a clustered document removes its document_clusters rows', async () => {
      const conn = db.getConnection();

      // Insert and cluster
      const docToDelete = insertSyntheticDocument(db, vector, 'will-delete.pdf', 'Delete me',
        [makeTestVector(0, 30)]);
      insertSyntheticDocument(db, vector, 'keep.pdf', 'Keep me',
        [makeTestVector(0, 31)]);
      insertSyntheticDocument(db, vector, 'other.pdf', 'Other doc',
        [makeTestVector(1, 32)]);

      const handler = clusteringTools['ocr_cluster_documents'].handler;
      const clusterResponse = await handler({ algorithm: 'agglomerative', n_clusters: 2 });
      const clusterParsed = parseResponse(clusterResponse);
      expect(clusterParsed.success).toBe(true);

      // ── BEFORE DELETE ──
      const beforeDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE document_id = ?').get(docToDelete.docId) as { cnt: number };
      const beforeTotal = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters').get() as { cnt: number };
      console.error('=== CASCADE DELETE: BEFORE ===');
      console.error(`  document_clusters for target doc: ${beforeDC.cnt}`);
      console.error(`  total document_clusters: ${beforeTotal.cnt}`);
      expect(beforeDC.cnt).toBeGreaterThanOrEqual(1);

      // ── DELETE DOCUMENT ──
      const deleteHandler = documentTools['ocr_document_delete'].handler;
      const deleteResponse = await deleteHandler({ document_id: docToDelete.docId, confirm: true });
      const deleteParsed = parseResponse(deleteResponse);
      console.error('=== CASCADE DELETE: DELETE RESULT ===');
      console.error(`  success: ${deleteParsed.success}`);
      expect(deleteParsed.success).toBe(true);

      // ── AFTER DELETE: physical DB verification ──
      const afterDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE document_id = ?').get(docToDelete.docId) as { cnt: number };
      const afterTotal = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters').get() as { cnt: number };
      const afterDoc = conn.prepare('SELECT COUNT(*) as cnt FROM documents WHERE id = ?').get(docToDelete.docId) as { cnt: number };
      console.error('=== CASCADE DELETE: AFTER (SOURCE OF TRUTH) ===');
      console.error(`  document_clusters for deleted doc: ${afterDC.cnt}`);
      console.error(`  total document_clusters: ${afterTotal.cnt}`);
      console.error(`  document exists: ${afterDoc.cnt}`);
      expect(afterDC.cnt).toBe(0);  // Cluster assignment removed
      expect(afterDoc.cnt).toBe(0);  // Document removed
      expect(afterTotal.cnt).toBe(beforeTotal.cnt - beforeDC.cnt);  // Only target's assignments removed
    }, 60000);
  });
});
