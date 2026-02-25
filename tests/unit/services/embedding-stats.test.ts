/**
 * Tests for embedding-operations.ts: getEmbeddingsFiltered and getEmbeddingStats
 *
 * Uses real DatabaseService instances with temp databases.
 * NO MOCK DATA.
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
} from '../../integration/server/helpers.js';

describe('getEmbeddingsFiltered', () => {
  let tempDir: string;
  const dbName = createUniqueName('emb-filter-test');

  // Shared test data IDs
  let docId1: string;
  let _docId2: string;
  let chunkEmbId1: string;
  let _chunkEmbId2: string;
  let imageEmbId: string;

  beforeAll(() => {
    tempDir = createTempDir('emb-filter-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Create doc1 with chunk embedding
    const docProv1 = createTestProvenance();
    db.insertProvenance(docProv1);
    const doc1 = createTestDocument(docProv1.id);
    docId1 = doc1.id;
    db.insertDocument(doc1);

    const ocrProv1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv1.id,
      root_document_id: docProv1.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv1);
    const ocr1 = createTestOCRResult(doc1.id, ocrProv1.id);
    db.insertOCRResult(ocr1);

    const chunkProv1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv1.id,
      root_document_id: docProv1.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv1);
    const chunk1 = createTestChunk(doc1.id, ocr1.id, chunkProv1.id, { chunk_index: 0 });
    db.insertChunk(chunk1);

    const embProv1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv1.id,
      root_document_id: docProv1.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv1);
    const emb1 = createTestEmbedding(chunk1.id, doc1.id, embProv1.id, {
      image_id: null,
      extraction_id: null,
      model_name: 'nomic-embed-text-v1.5',
      generation_duration_ms: 25,
    });
    chunkEmbId1 = emb1.id;
    db.insertEmbedding(emb1);

    // Create doc2 with chunk embedding
    const docProv2 = createTestProvenance();
    db.insertProvenance(docProv2);
    const doc2 = createTestDocument(docProv2.id);
    _docId2 = doc2.id;
    db.insertDocument(doc2);

    const ocrProv2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv2.id,
      root_document_id: docProv2.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv2);
    const ocr2 = createTestOCRResult(doc2.id, ocrProv2.id);
    db.insertOCRResult(ocr2);

    const chunkProv2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv2.id,
      root_document_id: docProv2.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv2);
    const chunk2 = createTestChunk(doc2.id, ocr2.id, chunkProv2.id, { chunk_index: 0 });
    db.insertChunk(chunk2);

    const embProv2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv2.id,
      root_document_id: docProv2.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv2);
    const emb2 = createTestEmbedding(chunk2.id, doc2.id, embProv2.id, {
      image_id: null,
      extraction_id: null,
      model_name: 'nomic-embed-text-v1.5',
      generation_duration_ms: 30,
    });
    _chunkEmbId2 = emb2.id;
    db.insertEmbedding(emb2);

    // Create an image embedding for doc1 (no chunk, has image_id)
    // We need an image record first
    const conn = db.getConnection();
    const imgId = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO images (id, document_id, ocr_result_id, page_number,
        bbox_x, bbox_y, bbox_width, bbox_height, image_index, format,
        width, height, vlm_status, created_at)
      VALUES (?, ?, ?, 1, 0, 0, 100, 100, 0, 'png', 100, 100, 'complete', datetime('now'))
    `
      )
      .run(imgId, doc1.id, ocr1.id);

    const imgEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: ocrProv1.id,
      root_document_id: docProv1.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(imgEmbProv);
    const imgEmb = createTestEmbedding(null as unknown as string, doc1.id, imgEmbProv.id, {
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
      model_name: 'nomic-embed-text-v1.5',
      generation_duration_ms: 40,
    });
    imageEmbId = imgEmb.id;
    db.insertEmbedding(imgEmb);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should return all embeddings with no filters', () => {
    const { db } = requireDatabase();
    const result = db.getEmbeddingsFiltered({});
    expect(result.total).toBe(3);
    expect(result.embeddings).toHaveLength(3);
  });

  it('should filter by document_id', () => {
    const { db } = requireDatabase();
    const result = db.getEmbeddingsFiltered({ document_id: docId1 });
    expect(result.total).toBe(2); // chunk + image embedding
    expect(result.embeddings.every((e) => e.document_id === docId1)).toBe(true);
  });

  it('should filter by source_type chunk', () => {
    const { db } = requireDatabase();
    const result = db.getEmbeddingsFiltered({ source_type: 'chunk' });
    expect(result.total).toBe(2); // Two chunk embeddings
    for (const emb of result.embeddings) {
      expect(emb.chunk_id).not.toBeNull();
      expect(emb.image_id).toBeNull();
    }
  });

  it('should filter by source_type image', () => {
    const { db } = requireDatabase();
    const result = db.getEmbeddingsFiltered({ source_type: 'image' });
    expect(result.total).toBe(1);
    expect(result.embeddings[0].image_id).not.toBeNull();
    expect(result.embeddings[0].id).toBe(imageEmbId);
  });

  it('should filter by model_name', () => {
    const { db } = requireDatabase();
    const result = db.getEmbeddingsFiltered({ model_name: 'nomic-embed-text-v1.5' });
    expect(result.total).toBe(3);

    const result2 = db.getEmbeddingsFiltered({ model_name: 'nonexistent-model' });
    expect(result2.total).toBe(0);
    expect(result2.embeddings).toHaveLength(0);
  });

  it('should support pagination', () => {
    const { db } = requireDatabase();
    const page1 = db.getEmbeddingsFiltered({ limit: 2, offset: 0 });
    expect(page1.total).toBe(3);
    expect(page1.embeddings).toHaveLength(2);

    const page2 = db.getEmbeddingsFiltered({ limit: 2, offset: 2 });
    expect(page2.total).toBe(3);
    expect(page2.embeddings).toHaveLength(1);

    // IDs should not overlap
    const page1Ids = page1.embeddings.map((e) => e.id);
    const page2Ids = page2.embeddings.map((e) => e.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });

  it('should combine filters', () => {
    const { db } = requireDatabase();
    const result = db.getEmbeddingsFiltered({
      document_id: docId1,
      source_type: 'chunk',
    });
    expect(result.total).toBe(1);
    expect(result.embeddings[0].id).toBe(chunkEmbId1);
  });
});

describe('getEmbeddingStats', () => {
  let tempDir: string;
  const dbName = createUniqueName('emb-stats-test');

  beforeAll(() => {
    tempDir = createTempDir('emb-stats-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should return zeroes on empty database', () => {
    const { db } = requireDatabase();
    const stats = db.getEmbeddingStats();
    expect(stats.total_embeddings).toBe(0);
    expect(Object.keys(stats.by_source_type)).toHaveLength(0);
    expect(Object.keys(stats.by_device)).toHaveLength(0);
    expect(stats.unembedded_chunks).toBe(0);
    expect(stats.unembedded_images).toBe(0);
  });

  it('should return accurate counts with data', () => {
    const { db } = requireDatabase();

    // Insert a document + OCR result + 2 chunks (one pending, one complete) + 1 embedding
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    // Chunk 1 - will have embedding
    const chunkProv1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv1);
    const chunk1 = createTestChunk(doc.id, ocr.id, chunkProv1.id, { chunk_index: 0 });
    db.insertChunk(chunk1);

    // Chunk 2 - no embedding (stays pending)
    const chunkProv2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv2);
    const chunk2 = createTestChunk(doc.id, ocr.id, chunkProv2.id, { chunk_index: 1 });
    db.insertChunk(chunk2);

    // Embedding for chunk1
    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv1.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv);
    const emb = createTestEmbedding(chunk1.id, doc.id, embProv.id, {
      image_id: null,
      extraction_id: null,
      gpu_device: 'cuda:0',
      generation_duration_ms: 50,
    });
    db.insertEmbedding(emb);
    db.updateChunkEmbeddingStatus(chunk1.id, 'complete', new Date().toISOString());

    // Image with vlm_status=complete but no embedding (unembedded)
    const conn = db.getConnection();
    const imgId = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO images (id, document_id, ocr_result_id, page_number,
        bbox_x, bbox_y, bbox_width, bbox_height, image_index, format,
        width, height, vlm_status, vlm_description, created_at)
      VALUES (?, ?, ?, 1, 0, 0, 100, 100, 0, 'png', 100, 100, 'complete', 'test description', datetime('now'))
    `
      )
      .run(imgId, doc.id, ocr.id);

    const stats = db.getEmbeddingStats();
    expect(stats.total_embeddings).toBe(1);
    expect(stats.by_source_type['chunk']).toBeDefined();
    expect(stats.by_source_type['chunk'].count).toBe(1);
    expect(stats.by_source_type['chunk'].avg_duration_ms).toBe(50);
    expect(stats.by_device['cuda:0']).toBe(1);
    expect(stats.unembedded_chunks).toBe(1); // chunk2 is still pending
    expect(stats.unembedded_images).toBe(1); // image has no vlm_embedding_id
  });

  it('should scope stats to a specific document', () => {
    const { db } = requireDatabase();

    // Create a second document with no embeddings
    const docProv2 = createTestProvenance();
    db.insertProvenance(docProv2);
    const doc2 = createTestDocument(docProv2.id);
    db.insertDocument(doc2);

    const stats = db.getEmbeddingStats(doc2.id);
    expect(stats.total_embeddings).toBe(0);
    expect(stats.unembedded_chunks).toBe(0);
    expect(stats.unembedded_images).toBe(0);
  });
});
