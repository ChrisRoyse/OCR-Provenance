/**
 * VectorService Tests
 *
 * Tests for vector storage and similarity search operations.
 * Uses real SQLite database with sqlite-vec - NO MOCKS.
 *
 * Test count: 28+ tests as required by task specification.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import {
  VectorService,
  VectorError,
  VectorErrorCode,
} from '../../../src/services/storage/vector.js';
import { DatabaseService } from '../../../src/services/storage/database.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { computeHash } from '../../../src/utils/hash.js';

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

if (!sqliteVecAvailable) {
  console.warn(
    'WARNING: sqlite-vec extension not available. Vector tests will be skipped.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a random 768-dimensional vector
 */
function createRandomVector(): Float32Array {
  const vector = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vector[i] = Math.random() * 2 - 1; // Random values between -1 and 1
  }
  return vector;
}

/**
 * Create a normalized vector (unit length)
 */
function createNormalizedVector(seed: number = 0): Float32Array {
  const vector = new Float32Array(768);
  let sumSquares = 0;

  // Generate deterministic values based on seed
  for (let i = 0; i < 768; i++) {
    vector[i] = Math.sin(seed + i * 0.1);
    sumSquares += vector[i] * vector[i];
  }

  // Normalize to unit length
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < 768; i++) {
    vector[i] /= norm;
  }

  return vector;
}

/**
 * Create a similar vector (small perturbation)
 */
function createSimilarVector(base: Float32Array, noise: number = 0.1): Float32Array {
  const vector = new Float32Array(768);
  let sumSquares = 0;

  for (let i = 0; i < 768; i++) {
    vector[i] = base[i] + (Math.random() - 0.5) * noise;
    sumSquares += vector[i] * vector[i];
  }

  // Normalize
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < 768; i++) {
    vector[i] /= norm;
  }

  return vector;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('VectorService', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;
  let vectorService: VectorService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'vector-service-test-'));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (!sqliteVecAvailable) return;

    const dbName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbService = DatabaseService.create(dbName, undefined, testDir);
    vectorService = new VectorService(dbService.getConnection());
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  /**
   * Helper to create full provenance chain and embedding
   * Returns the embedding ID and document ID for testing
   */
  function createTestEmbedding(overrides: {
    originalText?: string;
  } = {}): { embeddingId: string; documentId: string; chunkId: string } {
    const now = new Date().toISOString();
    const provId = uuidv4();
    const docId = uuidv4();
    const chunkId = uuidv4();
    const embId = uuidv4();
    const originalText = overrides.originalText || 'Test document content for vector search testing.';

    // Insert document provenance
    dbService!.insertProvenance({
      id: provId,
      type: ProvenanceType.DOCUMENT,
      source_type: 'FILE',
      source_id: null,
      root_document_id: provId,
      content_hash: computeHash('test' + docId),
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      parent_ids: '[]',
      chain_depth: 0,
      created_at: now,
      processed_at: now,
      source_file_created_at: now,
      source_file_modified_at: now,
      source_path: '/test/doc.pdf',
      location: null,
      input_hash: null,
      file_hash: computeHash('file' + docId),
      processing_duration_ms: 0,
      processing_quality_score: null,
      parent_id: null,
      chain_path: null,
    });

    dbService!.insertDocument({
      id: docId,
      file_path: '/test/doc.pdf',
      file_name: 'doc.pdf',
      file_hash: computeHash('file' + docId),
      file_size: 1000,
      file_type: 'pdf',
      status: 'complete',
      provenance_id: provId,
    });

    // OCR provenance
    const ocrProvId = uuidv4();
    dbService!.insertProvenance({
      id: ocrProvId,
      type: ProvenanceType.OCR_RESULT,
      source_type: 'OCR',
      source_id: provId,
      root_document_id: provId,
      content_hash: computeHash('ocr' + docId),
      processor: 'datalab-ocr',
      processor_version: '1.0.0',
      processing_params: { mode: 'accurate' },
      parent_ids: JSON.stringify([provId]),
      parent_id: provId,
      chain_depth: 1,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_path: null,
      location: null,
      input_hash: computeHash('test' + docId),
      file_hash: computeHash('file' + docId),
      processing_duration_ms: 1000,
      processing_quality_score: 0.95,
      chain_path: null,
    });

    const ocrId = uuidv4();
    dbService!.insertOCRResult({
      id: ocrId,
      provenance_id: ocrProvId,
      document_id: docId,
      extracted_text: originalText,
      text_length: originalText.length,
      datalab_request_id: 'req-test',
      datalab_mode: 'accurate',
      page_count: 1,
      content_hash: computeHash(originalText),
      processing_started_at: now,
      processing_completed_at: now,
      processing_duration_ms: 1000,
    });

    // Chunk provenance
    const chunkProvId = uuidv4();
    dbService!.insertProvenance({
      id: chunkProvId,
      type: ProvenanceType.CHUNK,
      source_type: 'CHUNKING',
      source_id: ocrProvId,
      root_document_id: provId,
      content_hash: computeHash('chunk' + chunkId),
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { size: 2000 },
      parent_ids: JSON.stringify([provId, ocrProvId]),
      parent_id: ocrProvId,
      chain_depth: 2,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_path: null,
      location: null,
      input_hash: computeHash('ocr' + docId),
      file_hash: computeHash('file' + docId),
      processing_duration_ms: 10,
      processing_quality_score: null,
      chain_path: null,
    });

    dbService!.insertChunk({
      id: chunkId,
      document_id: docId,
      ocr_result_id: ocrId,
      text: originalText,
      text_hash: computeHash(originalText),
      chunk_index: 0,
      character_start: 0,
      character_end: originalText.length,
      page_number: 1,
      overlap_previous: 0,
      overlap_next: 0,
      provenance_id: chunkProvId,
    });

    // Embedding provenance
    const embProvId = uuidv4();
    dbService!.insertProvenance({
      id: embProvId,
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: chunkProvId,
      root_document_id: provId,
      content_hash: computeHash('embedding' + embId),
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { dimensions: 768 },
      parent_ids: JSON.stringify([provId, ocrProvId, chunkProvId]),
      parent_id: chunkProvId,
      chain_depth: 3,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_path: null,
      location: null,
      input_hash: computeHash('chunk' + chunkId),
      file_hash: computeHash('file' + docId),
      processing_duration_ms: 50,
      processing_quality_score: null,
      chain_path: null,
    });

    dbService!.insertEmbedding({
      id: embId,
      chunk_id: chunkId,
      document_id: docId,
      original_text: originalText,
      original_text_length: originalText.length,
      source_file_path: '/test/doc.pdf',
      source_file_name: 'doc.pdf',
      source_file_hash: computeHash('file' + docId),
      page_number: 1,
      page_range: null,
      character_start: 0,
      character_end: originalText.length,
      chunk_index: 0,
      total_chunks: 1,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProvId,
      content_hash: computeHash('embedding' + embId),
      generation_duration_ms: 50,
    });

    return { embeddingId: embId, documentId: docId, chunkId };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // STORE OPERATIONS (8 tests)
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Store Operations', () => {
    it.skipIf(!sqliteVecAvailable)('1. Store single vector successfully', () => {
      const { embeddingId } = createTestEmbedding();
      const vector = createRandomVector();

      // Should not throw
      vectorService!.storeVector(embeddingId, vector);

      // Verify via utility method
      expect(vectorService!.vectorExists(embeddingId)).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('2. Verify vector exists in database after store', () => {
      const { embeddingId } = createTestEmbedding();
      const vector = createRandomVector();

      vectorService!.storeVector(embeddingId, vector);

      // PHYSICAL VERIFICATION: Query database directly
      const conn = dbService!.getConnection();
      const row = conn
        .prepare('SELECT * FROM vec_embeddings WHERE embedding_id = ?')
        .get(embeddingId) as { embedding_id: string; vector: Buffer } | undefined;

      expect(row).toBeDefined();
      expect(row!.embedding_id).toBe(embeddingId);
      expect(row!.vector).toBeInstanceOf(Buffer);
      expect(row!.vector.length).toBe(768 * 4); // 768 floats * 4 bytes each
    });

    it.skipIf(!sqliteVecAvailable)('3. Reject vector with wrong dimensions (not 768)', () => {
      const { embeddingId } = createTestEmbedding();
      const badVector = new Float32Array(512); // Wrong size

      expect(() => vectorService!.storeVector(embeddingId, badVector)).toThrow(VectorError);

      try {
        vectorService!.storeVector(embeddingId, badVector);
      } catch (error) {
        expect((error as VectorError).code).toBe(VectorErrorCode.INVALID_VECTOR_DIMENSIONS);
        expect((error as VectorError).details?.actualDimensions).toBe(512);
        expect((error as VectorError).details?.expectedDimensions).toBe(768);
      }
    });

    it.skipIf(!sqliteVecAvailable)('4. Reject store when embedding ID does not exist', () => {
      const fakeId = 'nonexistent-embedding-id';
      const vector = createRandomVector();

      expect(() => vectorService!.storeVector(fakeId, vector)).toThrow(VectorError);

      try {
        vectorService!.storeVector(fakeId, vector);
      } catch (error) {
        expect((error as VectorError).code).toBe(VectorErrorCode.EMBEDDING_NOT_FOUND);
        expect((error as VectorError).details?.embeddingId).toBe(fakeId);
      }
    });

    it.skipIf(!sqliteVecAvailable)('5. Batch store multiple vectors', () => {
      const items: Array<{ embeddingId: string; vector: Float32Array }> = [];

      for (let i = 0; i < 5; i++) {
        const { embeddingId } = createTestEmbedding({ originalText: `Batch test text ${i}` });
        items.push({ embeddingId, vector: createRandomVector() });
      }

      const count = vectorService!.batchStoreVectors(items);

      expect(count).toBe(5);
      expect(vectorService!.getVectorCount()).toBe(5);
    });

    it.skipIf(!sqliteVecAvailable)('6. Batch store validates dimensions before insert', () => {
      const { embeddingId: validId } = createTestEmbedding();

      const items = [
        { embeddingId: validId, vector: createRandomVector() },
        { embeddingId: 'will-never-reach', vector: new Float32Array(512) }, // Wrong dims
      ];

      // Should throw due to dimension validation before any DB operations
      expect(() => vectorService!.batchStoreVectors(items)).toThrow(VectorError);

      try {
        vectorService!.batchStoreVectors(items);
      } catch (error) {
        expect((error as VectorError).code).toBe(VectorErrorCode.INVALID_VECTOR_DIMENSIONS);
      }

      // Verify nothing was stored (validation happens first)
      expect(vectorService!.getVectorCount()).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('7. Store preserves vector precision (float32)', () => {
      const { embeddingId } = createTestEmbedding();
      const originalVector = createRandomVector();

      // Store specific known values
      originalVector[0] = 0.123456789;
      originalVector[100] = -0.987654321;
      originalVector[767] = 0.555555555;

      vectorService!.storeVector(embeddingId, originalVector);

      // Retrieve and verify precision
      const retrieved = vectorService!.getVector(embeddingId);
      expect(retrieved).not.toBeNull();

      // Float32 has ~7 decimal digits of precision
      expect(retrieved![0]).toBeCloseTo(0.123456789, 5);
      expect(retrieved![100]).toBeCloseTo(-0.987654321, 5);
      expect(retrieved![767]).toBeCloseTo(0.555555555, 5);
    });

    it.skipIf(!sqliteVecAvailable)('8. Vector count increments after store', () => {
      expect(vectorService!.getVectorCount()).toBe(0);

      const { embeddingId: id1 } = createTestEmbedding({ originalText: 'Text 1' });
      vectorService!.storeVector(id1, createRandomVector());
      expect(vectorService!.getVectorCount()).toBe(1);

      const { embeddingId: id2 } = createTestEmbedding({ originalText: 'Text 2' });
      vectorService!.storeVector(id2, createRandomVector());
      expect(vectorService!.getVectorCount()).toBe(2);

      const { embeddingId: id3 } = createTestEmbedding({ originalText: 'Text 3' });
      vectorService!.storeVector(id3, createRandomVector());
      expect(vectorService!.getVectorCount()).toBe(3);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SEARCH OPERATIONS (12 tests)
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Search Operations', () => {
    it.skipIf(!sqliteVecAvailable)('9. Search returns results ordered by similarity (highest first)', () => {
      // Create base vector and variations
      const baseVector = createNormalizedVector(42);

      // Create embeddings with different similarity to base
      const { embeddingId: id1 } = createTestEmbedding({ originalText: 'Very similar text' });
      const vec1 = createSimilarVector(baseVector, 0.05); // Very similar
      vectorService!.storeVector(id1, vec1);

      const { embeddingId: id2 } = createTestEmbedding({ originalText: 'Somewhat similar text' });
      const vec2 = createSimilarVector(baseVector, 0.3); // Somewhat similar
      vectorService!.storeVector(id2, vec2);

      const { embeddingId: id3 } = createTestEmbedding({ originalText: 'Less similar text' });
      const vec3 = createSimilarVector(baseVector, 0.6); // Less similar
      vectorService!.storeVector(id3, vec3);

      // Search with base vector
      const results = vectorService!.searchSimilar(baseVector, { limit: 10 });

      expect(results.length).toBe(3);
      // Results should be ordered by similarity (highest first = lowest distance)
      expect(results[0].similarity_score).toBeGreaterThanOrEqual(results[1].similarity_score);
      expect(results[1].similarity_score).toBeGreaterThanOrEqual(results[2].similarity_score);
    });

    it.skipIf(!sqliteVecAvailable)('10. Search respects limit parameter', () => {
      // Create more embeddings than limit and store with the same base vector
      // to ensure they all have similar enough distances to be returned
      const baseVector = createNormalizedVector(777);
      const embeddingIds: string[] = [];

      for (let i = 0; i < 10; i++) {
        const { embeddingId } = createTestEmbedding({ originalText: `Limit test text ${i}` });
        // Use similar vectors to ensure they all pass any threshold
        const vec = createSimilarVector(baseVector, 0.1);
        vectorService!.storeVector(embeddingId, vec);
        embeddingIds.push(embeddingId);
      }

      // Search with base vector - should find all similar vectors
      // Search with limit=3
      const results = vectorService!.searchSimilar(baseVector, { limit: 3 });
      expect(results.length).toBe(3);

      // Search with limit=5
      const results5 = vectorService!.searchSimilar(baseVector, { limit: 5 });
      expect(results5.length).toBe(5);

      // Search with limit=10 (should get all)
      const results10 = vectorService!.searchSimilar(baseVector, { limit: 10 });
      expect(results10.length).toBe(10);
    });

    it.skipIf(!sqliteVecAvailable)('11. Search respects threshold parameter', () => {
      const baseVector = createNormalizedVector(123);

      // Create one very similar embedding
      const { embeddingId: id1 } = createTestEmbedding({ originalText: 'High similarity text' });
      const vec1 = createSimilarVector(baseVector, 0.01); // Very similar
      vectorService!.storeVector(id1, vec1);

      // Create one dissimilar embedding
      const { embeddingId: id2 } = createTestEmbedding({ originalText: 'Low similarity text' });
      const vec2 = createNormalizedVector(999); // Different
      vectorService!.storeVector(id2, vec2);

      // Search with high threshold (only very similar results)
      const highThreshold = vectorService!.searchSimilar(baseVector, { threshold: 0.95 });

      // At most 1 result should pass high threshold
      expect(highThreshold.length).toBeLessThanOrEqual(1);

      // All results should be above threshold
      for (const result of highThreshold) {
        expect(result.similarity_score).toBeGreaterThanOrEqual(0.95);
      }
    });

    it.skipIf(!sqliteVecAvailable)('12. Search with document filter returns only matching docs', () => {
      // Create embedding in document 1
      const { embeddingId: id1, documentId: docId1 } = createTestEmbedding({ originalText: 'Doc 1 text A' });
      const vec1 = createNormalizedVector(111);
      vectorService!.storeVector(id1, vec1);

      // Create embedding in document 2
      const { embeddingId: id2, documentId: docId2 } = createTestEmbedding({ originalText: 'Doc 2 text' });
      const vec2 = createNormalizedVector(222);
      vectorService!.storeVector(id2, vec2);

      // Verify both vectors are stored
      expect(vectorService!.getVectorCount()).toBe(2);

      // Search only in document 1 using vec1 as query
      const results = vectorService!.searchSimilar(vec1, {
        documentFilter: [docId1],
      });

      expect(results.length).toBe(1);
      // All results should be from document 1
      for (const result of results) {
        expect(result.document_id).toBe(docId1);
      }

      // Verify that searching with document 2 filter returns doc 2
      const results2 = vectorService!.searchSimilar(vec2, {
        documentFilter: [docId2],
      });
      expect(results2.length).toBe(1);
      expect(results2[0].document_id).toBe(docId2);
    });

    it.skipIf(!sqliteVecAvailable)('13. CP-002: Search ALWAYS returns original_text', () => {
      const testText = 'This is the specific original text that must be returned.';
      const { embeddingId } = createTestEmbedding({ originalText: testText });
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      // Search using the same vector to guarantee finding it
      const results = vectorService!.searchSimilar(storedVector, { limit: 10 });

      expect(results.length).toBeGreaterThan(0);

      // CRITICAL CP-002 VERIFICATION
      for (const result of results) {
        expect(result.original_text).toBeDefined();
        expect(typeof result.original_text).toBe('string');
        expect(result.original_text.length).toBeGreaterThan(0);
      }

      // Verify specific text is found
      const found = results.find((r) => r.original_text === testText);
      expect(found).toBeDefined();
    });

    it.skipIf(!sqliteVecAvailable)('14. Search returns source_file_path', () => {
      const { embeddingId } = createTestEmbedding();
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      const results = vectorService!.searchSimilar(storedVector);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].source_file_path).toBe('/test/doc.pdf');
    });

    it.skipIf(!sqliteVecAvailable)('15. Search returns source_file_name', () => {
      const { embeddingId } = createTestEmbedding();
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      const results = vectorService!.searchSimilar(storedVector);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].source_file_name).toBe('doc.pdf');
    });

    it.skipIf(!sqliteVecAvailable)('16. Search returns page_number', () => {
      const { embeddingId } = createTestEmbedding();
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      const results = vectorService!.searchSimilar(storedVector);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].page_number).toBe(1);
    });

    it.skipIf(!sqliteVecAvailable)('17. Search returns character_start/end', () => {
      const testText = 'Character position test text.';
      const { embeddingId } = createTestEmbedding({ originalText: testText });
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      const results = vectorService!.searchSimilar(storedVector);
      const result = results.find((r) => r.original_text === testText);

      expect(result).toBeDefined();
      expect(result!.character_start).toBe(0);
      expect(result!.character_end).toBe(testText.length);
    });

    it.skipIf(!sqliteVecAvailable)('18. Search returns provenance_id', () => {
      const { embeddingId } = createTestEmbedding();
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      const results = vectorService!.searchSimilar(storedVector);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].provenance_id).toBeDefined();
      expect(typeof results[0].provenance_id).toBe('string');
      expect(results[0].provenance_id.length).toBeGreaterThan(0);
    });

    it.skipIf(!sqliteVecAvailable)('19. Search on empty database returns empty array', () => {
      // No embeddings stored
      const results = vectorService!.searchSimilar(createRandomVector());

      expect(results).toEqual([]);
      expect(results.length).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('20. Search similarity_score = 1 - distance', () => {
      const { embeddingId } = createTestEmbedding();
      const vector = createRandomVector();
      vectorService!.storeVector(embeddingId, vector);

      // Search with the exact same vector
      const results = vectorService!.searchSimilar(vector);

      expect(results.length).toBeGreaterThan(0);

      // For each result, verify similarity_score = 1 - distance
      for (const result of results) {
        const expectedSimilarity = 1 - result.distance;
        expect(result.similarity_score).toBeCloseTo(expectedSimilarity, 10);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // DELETE OPERATIONS (4 tests)
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Delete Operations', () => {
    it.skipIf(!sqliteVecAvailable)('21. Delete single vector', () => {
      const { embeddingId } = createTestEmbedding();
      vectorService!.storeVector(embeddingId, createRandomVector());

      expect(vectorService!.vectorExists(embeddingId)).toBe(true);

      const deleted = vectorService!.deleteVector(embeddingId);

      expect(deleted).toBe(true);
      expect(vectorService!.vectorExists(embeddingId)).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('22. Delete nonexistent vector returns false', () => {
      const deleted = vectorService!.deleteVector('nonexistent-id');
      expect(deleted).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('23. Delete vectors by document ID', () => {
      // Create embedding and get its document ID
      const { embeddingId, documentId } = createTestEmbedding({ originalText: 'Delete by doc test' });
      vectorService!.storeVector(embeddingId, createRandomVector());

      const countBefore = vectorService!.getVectorCount();
      expect(countBefore).toBe(1);

      const deleted = vectorService!.deleteVectorsByDocumentId(documentId);

      expect(deleted).toBe(1);
      expect(vectorService!.getVectorCount()).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('24. Verify vector removed from database after delete', () => {
      const { embeddingId } = createTestEmbedding();
      vectorService!.storeVector(embeddingId, createRandomVector());

      // Verify in physical database before delete
      const conn = dbService!.getConnection();
      const before = conn
        .prepare('SELECT 1 FROM vec_embeddings WHERE embedding_id = ?')
        .get(embeddingId);
      expect(before).toBeDefined();

      // Delete
      vectorService!.deleteVector(embeddingId);

      // Verify removed from physical database
      const after = conn
        .prepare('SELECT 1 FROM vec_embeddings WHERE embedding_id = ?')
        .get(embeddingId);
      expect(after).toBeUndefined();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // UTILITY TESTS (4 tests)
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Utility Methods', () => {
    it.skipIf(!sqliteVecAvailable)('25. getVectorCount returns accurate count', () => {
      expect(vectorService!.getVectorCount()).toBe(0);

      // Add 5 vectors
      for (let i = 0; i < 5; i++) {
        const { embeddingId } = createTestEmbedding({ originalText: `Count test ${i}` });
        vectorService!.storeVector(embeddingId, createRandomVector());
      }

      expect(vectorService!.getVectorCount()).toBe(5);
    });

    it.skipIf(!sqliteVecAvailable)('26. vectorExists returns true for existing', () => {
      const { embeddingId } = createTestEmbedding();
      vectorService!.storeVector(embeddingId, createRandomVector());

      expect(vectorService!.vectorExists(embeddingId)).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('27. vectorExists returns false for nonexistent', () => {
      expect(vectorService!.vectorExists('nonexistent-id')).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('28. getVector retrieves correct Float32Array', () => {
      const { embeddingId } = createTestEmbedding();
      const original = createRandomVector();

      // Set some specific values
      original[0] = 0.5;
      original[383] = -0.25;
      original[767] = 0.75;

      vectorService!.storeVector(embeddingId, original);

      const retrieved = vectorService!.getVector(embeddingId);

      expect(retrieved).not.toBeNull();
      expect(retrieved).toBeInstanceOf(Float32Array);
      expect(retrieved!.length).toBe(768);

      // Verify values
      expect(retrieved![0]).toBeCloseTo(0.5, 5);
      expect(retrieved![383]).toBeCloseTo(-0.25, 5);
      expect(retrieved![767]).toBeCloseTo(0.75, 5);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // EDGE CASES (Additional tests)
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it.skipIf(!sqliteVecAvailable)('29. Empty batch store returns 0', () => {
      const count = vectorService!.batchStoreVectors([]);
      expect(count).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('30. Search with empty documentFilter searches all', () => {
      const { embeddingId } = createTestEmbedding();
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      const results = vectorService!.searchSimilar(storedVector, {
        documentFilter: [],
      });

      // Empty filter should be treated as no filter and return results
      expect(results.length).toBeGreaterThan(0);
    });

    it.skipIf(!sqliteVecAvailable)('31. Search rejects wrong dimension query vector', () => {
      const badQuery = new Float32Array(512);

      expect(() => vectorService!.searchSimilar(badQuery)).toThrow(VectorError);

      try {
        vectorService!.searchSimilar(badQuery);
      } catch (error) {
        expect((error as VectorError).code).toBe(VectorErrorCode.INVALID_VECTOR_DIMENSIONS);
      }
    });

    it.skipIf(!sqliteVecAvailable)('32. getVector returns null for nonexistent', () => {
      const result = vectorService!.getVector('nonexistent');
      expect(result).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('33. Limit is capped at 100', () => {
      // Create 110 embeddings
      for (let i = 0; i < 110; i++) {
        const { embeddingId } = createTestEmbedding({ originalText: `Max limit test ${i}` });
        vectorService!.storeVector(embeddingId, createRandomVector());
      }

      // Request 200 but should only get 100
      const results = vectorService!.searchSimilar(createRandomVector(), { limit: 200 });
      expect(results.length).toBeLessThanOrEqual(100);
    });

    it.skipIf(!sqliteVecAvailable)('34. Search returns all required fields', () => {
      const { embeddingId } = createTestEmbedding();
      const storedVector = createRandomVector();
      vectorService!.storeVector(embeddingId, storedVector);

      const results = vectorService!.searchSimilar(storedVector);

      expect(results.length).toBeGreaterThan(0);
      const result = results[0];

      // Verify all required fields exist
      expect(result.embedding_id).toBeDefined();
      expect(result.chunk_id).toBeDefined();
      expect(result.document_id).toBeDefined();
      expect(result.similarity_score).toBeDefined();
      expect(result.distance).toBeDefined();
      expect(result.original_text).toBeDefined();
      expect(result.original_text_length).toBeDefined();
      expect(result.source_file_path).toBeDefined();
      expect(result.source_file_name).toBeDefined();
      expect(result.source_file_hash).toBeDefined();
      expect('page_number' in result).toBe(true); // Can be null but must exist
      expect(result.character_start).toBeDefined();
      expect(result.character_end).toBeDefined();
      expect(result.chunk_index).toBeDefined();
      expect(result.total_chunks).toBeDefined();
      expect(result.model_name).toBeDefined();
      expect(result.model_version).toBeDefined();
      expect(result.provenance_id).toBeDefined();
      expect(result.content_hash).toBeDefined();
    });
  });
});
