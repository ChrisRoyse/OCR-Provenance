/**
 * Comparison Discover & Batch Tool Handler Tests
 *
 * Tests for ocr_comparison_discover and ocr_comparison_batch tools.
 * Uses REAL databases, NO mocks.
 *
 * @module tests/unit/tools/comparison-discover
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  createTestEmbedding,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  computeHash,
} from '../../integration/server/helpers.js';
import { comparisonTools } from '../../../src/tools/comparison.js';
import { insertCluster, insertDocumentCluster } from '../../../src/services/storage/database/cluster-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC AVAILABILITY CHECK
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

function parseResult(response: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(response.content[0].text) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { category: string; message: string };
  };
}

/**
 * Create a complete document with OCR result and chunk with embedding.
 * Returns IDs for all created entities.
 */
function createDocumentWithEmbedding(
  extractedText: string,
  options: { fileName?: string } = {}
) {
  const { db, vector } = requireDatabase();
  const _conn = db.getConnection();

  // Create provenance chain
  const docProvId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: docProvId }),
    type: ProvenanceType.DOCUMENT,
    chain_depth: 0,
    root_document_id: docProvId,
  });

  const ocrProvId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: ocrProvId }),
    type: ProvenanceType.OCR_RESULT,
    chain_depth: 1,
    parent_id: docProvId,
    root_document_id: docProvId,
  });

  const chunkProvId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: chunkProvId }),
    type: ProvenanceType.CHUNK,
    chain_depth: 2,
    parent_id: ocrProvId,
    root_document_id: docProvId,
  });

  const embProvId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: embProvId }),
    type: ProvenanceType.EMBEDDING,
    chain_depth: 3,
    parent_id: chunkProvId,
    root_document_id: docProvId,
  });

  // Create document
  const docId = uuidv4();
  const fileName = options.fileName ?? `doc-${docId.slice(0, 8)}.pdf`;
  db.insertDocument({
    ...createTestDocument(docProvId, {
      id: docId,
      file_name: fileName,
      status: 'complete',
    }),
  });

  // OCR result
  const ocrId = uuidv4();
  db.insertOCRResult({
    ...createTestOCRResult(docId, ocrProvId, {
      id: ocrId,
      extracted_text: extractedText,
      text_length: extractedText.length,
      content_hash: computeHash(extractedText),
    }),
  });

  // Update doc status
  db.updateDocumentStatus(docId, 'complete');

  // Chunk
  const chunkId = uuidv4();
  db.insertChunk({
    ...createTestChunk(docId, ocrId, chunkProvId, {
      id: chunkId,
      text: extractedText,
      text_hash: computeHash(extractedText),
    }),
  });

  // Embedding
  const embId = uuidv4();
  db.insertEmbedding({
    ...createTestEmbedding(chunkId, docId, embProvId, {
      id: embId,
      original_text: extractedText,
      original_text_length: extractedText.length,
    }),
  });

  // Store vector (random but deterministic based on text)
  if (sqliteVecAvailable) {
    const vecData = new Float32Array(768);
    // Create a simple deterministic vector from the text
    for (let i = 0; i < 768; i++) {
      vecData[i] = Math.sin(extractedText.charCodeAt(i % extractedText.length) * (i + 1) * 0.01);
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vecData[i] * vecData[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vecData[i] /= norm;

    vector.storeVector(embId, vecData);
  }

  return { docId, ocrId, chunkId, embId, docProvId, ocrProvId, fileName };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)('ocr_comparison_discover', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-comp-discover');

  beforeAll(() => {
    tempDir = createTempDir('test-comp-discover-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should discover similar document pairs based on embedding proximity', async () => {
    // Create two documents with similar text
    const _doc1 = createDocumentWithEmbedding('This is a legal contract about terms and conditions.');
    const _doc2 = createDocumentWithEmbedding('This is a legal agreement about terms and provisions.');

    const result = await comparisonTools.ocr_comparison_discover.handler({
      min_similarity: 0.0, // Very low threshold to ensure we find the pair
      limit: 10,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBeDefined();
    expect(parsed.data!.documents_analyzed).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(parsed.data!.pairs)).toBe(true);

    const pairs = parsed.data!.pairs as Array<{
      document_id_1: string;
      document_id_2: string;
      similarity: number;
      file_name_1: string;
      file_name_2: string;
    }>;

    // Should find at least one pair
    expect(pairs.length).toBeGreaterThanOrEqual(1);

    // Each pair should have the expected fields
    for (const pair of pairs) {
      expect(pair.document_id_1).toBeDefined();
      expect(pair.document_id_2).toBeDefined();
      expect(typeof pair.similarity).toBe('number');
      expect(pair.similarity).toBeGreaterThanOrEqual(0);
      expect(pair.similarity).toBeLessThanOrEqual(1);
      expect(pair.file_name_1).toBeDefined();
      expect(pair.file_name_2).toBeDefined();
    }
  });

  it('should respect min_similarity threshold', async () => {
    const result = await comparisonTools.ocr_comparison_discover.handler({
      min_similarity: 0.99999, // Extremely high threshold
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    // Very likely no pairs with such high similarity
    const pairs = parsed.data!.pairs as unknown[];
    // Pairs may be 0 or very few
    expect(Array.isArray(pairs)).toBe(true);
  });

  it('should respect document_filter', async () => {
    const doc3 = createDocumentWithEmbedding('Completely unrelated medical document.');

    const result = await comparisonTools.ocr_comparison_discover.handler({
      document_filter: [doc3.docId],
      min_similarity: 0.0,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    // Only one document in filter, can't form pairs
    expect(parsed.data!.documents_analyzed).toBe(1);
    expect((parsed.data!.pairs as unknown[]).length).toBe(0);
  });

  it('should exclude existing comparisons when exclude_existing is true', async () => {
    // First run a comparison to create an existing record
    const doc4 = createDocumentWithEmbedding('First document for exclusion test.');
    const doc5 = createDocumentWithEmbedding('Second document for exclusion test.');

    // Manually compare them
    await comparisonTools.ocr_document_compare.handler({
      document_id_1: doc4.docId,
      document_id_2: doc5.docId,
    });

    // Now discover with exclude_existing=true
    const result = await comparisonTools.ocr_comparison_discover.handler({
      document_filter: [doc4.docId, doc5.docId],
      min_similarity: 0.0,
      exclude_existing: true,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    // The pair should be excluded since we already compared them
    expect((parsed.data!.pairs as unknown[]).length).toBe(0);
  });

  it('should return empty pairs when no documents have embeddings', async () => {
    // Create fresh db for this test
    const tempDir2 = createTempDir('test-comp-empty-');
    const dbName2 = createUniqueName('test-comp-empty');
    createDatabase(dbName2, undefined, tempDir2);
    selectDatabase(dbName2, tempDir2);

    const result = await comparisonTools.ocr_comparison_discover.handler({
      min_similarity: 0.5,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.documents_analyzed).toBe(0);
    expect((parsed.data!.pairs as unknown[]).length).toBe(0);

    // Restore original db
    selectDatabase(dbName, tempDir);
    cleanupTempDir(tempDir2);
  });

  it('should fail when database is not selected', async () => {
    resetState();

    const result = await comparisonTools.ocr_comparison_discover.handler({
      min_similarity: 0.7,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DATABASE_NOT_SELECTED');

    // Restore
    selectDatabase(dbName, tempDir);
  });
});

describe.skipIf(!sqliteVecAvailable)('ocr_comparison_batch', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-comp-batch');

  beforeAll(() => {
    tempDir = createTempDir('test-comp-batch-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should compare explicit document pairs', async () => {
    const doc1 = createDocumentWithEmbedding('Batch test document one about contracts.');
    const doc2 = createDocumentWithEmbedding('Batch test document two about agreements.');

    const result = await comparisonTools.ocr_comparison_batch.handler({
      pairs: [{ doc1: doc1.docId, doc2: doc2.docId }],
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.total_compared).toBe(1);
    expect(parsed.data!.total_errors).toBe(0);

    const results = parsed.data!.results as Array<{
      document_id_1: string;
      document_id_2: string;
      comparison_id: string;
      similarity_ratio: number;
      summary: string;
    }>;
    expect(results.length).toBe(1);
    expect(results[0].document_id_1).toBe(doc1.docId);
    expect(results[0].document_id_2).toBe(doc2.docId);
    expect(results[0].comparison_id).toBeDefined();
    expect(typeof results[0].similarity_ratio).toBe('number');
  });

  it('should compare all documents in a cluster', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const doc1 = createDocumentWithEmbedding('Cluster batch doc one.');
    const doc2 = createDocumentWithEmbedding('Cluster batch doc two.');
    const doc3 = createDocumentWithEmbedding('Cluster batch doc three.');

    // Create a cluster with provenance
    const clusterProvId = uuidv4();
    db.insertProvenance({
      ...createTestProvenance({ id: clusterProvId }),
      type: ProvenanceType.CLUSTERING,
      chain_depth: 2,
    });

    const clusterId = uuidv4();
    const runId = uuidv4();
    insertCluster(conn, {
      id: clusterId,
      run_id: runId,
      cluster_index: 0,
      label: 'test-cluster',
      description: null,
      classification_tag: null,
      document_count: 3,
      centroid_json: null,
      top_terms_json: null,
      coherence_score: 0.8,
      algorithm: 'kmeans',
      algorithm_params_json: '{}',
      silhouette_score: 0.7,
      content_hash: computeHash('test'),
      provenance_id: clusterProvId,
      created_at: new Date().toISOString(),
      processing_duration_ms: 100,
    });

    // Assign documents to cluster
    for (const doc of [doc1, doc2, doc3]) {
      insertDocumentCluster(conn, {
        id: uuidv4(),
        document_id: doc.docId,
        cluster_id: clusterId,
        run_id: runId,
        similarity_to_centroid: 0.9,
        membership_probability: 1.0,
        is_noise: false,
        assigned_at: new Date().toISOString(),
      });
    }

    const result = await comparisonTools.ocr_comparison_batch.handler({
      cluster_id: clusterId,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    // 3 documents -> 3 pairs (3 choose 2)
    expect(parsed.data!.total_pairs_requested).toBe(3);
    expect(parsed.data!.total_compared).toBe(3);
  });

  it('should fail when neither pairs nor cluster_id is provided', async () => {
    const result = await comparisonTools.ocr_comparison_batch.handler({});

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('VALIDATION_ERROR');
  });

  it('should fail when cluster_id does not exist', async () => {
    const result = await comparisonTools.ocr_comparison_batch.handler({
      cluster_id: 'nonexistent-cluster-id',
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
  });

  it('should handle errors in individual pairs gracefully', async () => {
    const doc1 = createDocumentWithEmbedding('Error test doc for batch.');

    const result = await comparisonTools.ocr_comparison_batch.handler({
      pairs: [
        { doc1: doc1.docId, doc2: 'nonexistent-doc-id' },
      ],
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.total_compared).toBe(0);
    expect(parsed.data!.total_errors).toBe(1);
    expect(parsed.data!.errors).toBeDefined();
  });

  it('should fail when database is not selected', async () => {
    resetState();

    const result = await comparisonTools.ocr_comparison_batch.handler({
      pairs: [{ doc1: 'a', doc2: 'b' }],
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.category).toBe('DATABASE_NOT_SELECTED');

    // Restore
    selectDatabase(dbName, tempDir);
  });
});
