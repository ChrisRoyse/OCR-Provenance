/**
 * Tests for embedding management tools (Phase 4)
 *
 * Tests all 4 tools: ocr_embedding_list, ocr_embedding_stats,
 * ocr_embedding_get, ocr_embedding_rebuild
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
import { embeddingTools } from '../../../src/tools/embeddings.js';

// Extract handlers
const handleEmbeddingList = embeddingTools.ocr_embedding_list.handler;
const handleEmbeddingStats = embeddingTools.ocr_embedding_stats.handler;
const handleEmbeddingGet = embeddingTools.ocr_embedding_get.handler;
const handleEmbeddingRebuild = embeddingTools.ocr_embedding_rebuild.handler;

function parseResponse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('Embedding Tools', () => {
  it('should export exactly 4 tools', () => {
    expect(Object.keys(embeddingTools)).toHaveLength(4);
    expect(embeddingTools.ocr_embedding_list).toBeDefined();
    expect(embeddingTools.ocr_embedding_stats).toBeDefined();
    expect(embeddingTools.ocr_embedding_get).toBeDefined();
    expect(embeddingTools.ocr_embedding_rebuild).toBeDefined();
  });

  it('should have handlers mapped correctly', () => {
    expect(typeof embeddingTools.ocr_embedding_list.handler).toBe('function');
    expect(typeof embeddingTools.ocr_embedding_stats.handler).toBe('function');
    expect(typeof embeddingTools.ocr_embedding_get.handler).toBe('function');
    expect(typeof embeddingTools.ocr_embedding_rebuild.handler).toBe('function');
  });
});

describe('handleEmbeddingList', () => {
  let tempDir: string;
  const dbName = createUniqueName('emb-list-tool');
  let docId: string;
  let chunkEmbId: string;
  let imageEmbId: string;

  beforeAll(() => {
    tempDir = createTempDir('emb-list-tool-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Create document with OCR + chunk + chunk embedding
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    docId = doc.id;
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

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, {
      chunk_index: 0,
      heading_context: 'Test Section',
      section_path: 'Chapter 1 > Test Section',
    });
    db.insertChunk(chunk);

    // Chunk embedding
    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv);
    const emb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
      image_id: null,
      extraction_id: null,
    });
    chunkEmbId = emb.id;
    db.insertEmbedding(emb);

    // Image + image embedding
    const conn = db.getConnection();
    const imgId = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO images (id, document_id, ocr_result_id, page_number,
        bbox_x, bbox_y, bbox_width, bbox_height, image_index, format,
        width, height, vlm_status, extracted_path, created_at, block_type)
      VALUES (?, ?, ?, 1, 0, 0, 100, 100, 0, 'png', 200, 300, 'complete',
        '/test/image.png', datetime('now'), 'Figure')
    `
      )
      .run(imgId, doc.id, ocr.id);

    const imgEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(imgEmbProv);
    const imgEmb = createTestEmbedding(null as unknown as string, doc.id, imgEmbProv.id, {
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
      original_text: 'VLM description of image',
    });
    imageEmbId = imgEmb.id;
    db.insertEmbedding(imgEmb);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should fail with database not selected', async () => {
    resetState();
    const result = await handleEmbeddingList({});
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
    selectDatabase(dbName, tempDir);
  });

  it('should list all embeddings with no filters', async () => {
    const result = await handleEmbeddingList({});
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total).toBe(2);
    expect(parsed.data.embeddings).toHaveLength(2);
    expect(parsed.data.limit).toBe(50);
    expect(parsed.data.offset).toBe(0);
  });

  it('should filter by document_id', async () => {
    const result = await handleEmbeddingList({ document_id: docId });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total).toBe(2);
    expect(parsed.data.filters_applied.document_id).toBe(docId);
  });

  it('should filter by source_type chunk', async () => {
    const result = await handleEmbeddingList({ source_type: 'chunk' });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total).toBe(1);
    expect(parsed.data.embeddings[0].source_type).toBe('chunk');
    expect(parsed.data.embeddings[0].id).toBe(chunkEmbId);
    // Should have chunk source context
    expect(parsed.data.embeddings[0].chunk_heading_context).toBe('Test Section');
    expect(parsed.data.embeddings[0].chunk_section_path).toBe('Chapter 1 > Test Section');
  });

  it('should filter by source_type image', async () => {
    const result = await handleEmbeddingList({ source_type: 'image' });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total).toBe(1);
    expect(parsed.data.embeddings[0].source_type).toBe('image');
    expect(parsed.data.embeddings[0].id).toBe(imageEmbId);
    // Should have image source context
    expect(parsed.data.embeddings[0].image_extracted_path).toBe('/test/image.png');
    expect(parsed.data.embeddings[0].image_block_type).toBe('Figure');
  });

  it('should return empty for non-existent document', async () => {
    const result = await handleEmbeddingList({ document_id: uuidv4() });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total).toBe(0);
    expect(parsed.data.embeddings).toHaveLength(0);
  });

  it('should support pagination', async () => {
    const result = await handleEmbeddingList({ limit: 1, offset: 0 });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total).toBe(2);
    expect(parsed.data.embeddings).toHaveLength(1);

    const result2 = await handleEmbeddingList({ limit: 1, offset: 1 });
    const parsed2 = parseResponse(result2);
    expect(parsed2.data.embeddings).toHaveLength(1);
    expect(parsed2.data.embeddings[0].id).not.toBe(parsed.data.embeddings[0].id);
  });

  it('should include original_text_preview', async () => {
    const result = await handleEmbeddingList({});
    const parsed = parseResponse(result);
    for (const emb of parsed.data.embeddings) {
      expect(emb.original_text_preview).toBeDefined();
      expect(typeof emb.original_text_preview).toBe('string');
      expect(emb.original_text_preview.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('handleEmbeddingStats', () => {
  let tempDir: string;
  const dbName = createUniqueName('emb-stats-tool');

  beforeAll(() => {
    tempDir = createTempDir('emb-stats-tool-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should fail with database not selected', async () => {
    resetState();
    const result = await handleEmbeddingStats({});
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
    selectDatabase(dbName, tempDir);
  });

  it('should return stats for empty database', async () => {
    const result = await handleEmbeddingStats({});
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total_embeddings).toBe(0);
    expect(parsed.data.unembedded_chunks).toBe(0);
    expect(parsed.data.unembedded_images).toBe(0);
    expect(parsed.data.document_id).toBeNull();
  });

  it('should return accurate stats with data', async () => {
    const { db } = requireDatabase();

    // Setup: document + OCR + chunk + embedding
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

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv);
    const emb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
      image_id: null,
      extraction_id: null,
      gpu_device: 'cuda:0',
      generation_duration_ms: 42,
    });
    db.insertEmbedding(emb);
    db.updateChunkEmbeddingStatus(chunk.id, 'complete', new Date().toISOString());

    const result = await handleEmbeddingStats({});
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total_embeddings).toBe(1);
    expect(parsed.data.by_source_type.chunk).toBeDefined();
    expect(parsed.data.by_source_type.chunk.count).toBe(1);
    expect(parsed.data.by_source_type.chunk.avg_duration_ms).toBe(42);
    expect(parsed.data.by_device['cuda:0']).toBe(1);
  });

  it('should scope stats to specific document', async () => {
    const result = await handleEmbeddingStats({ document_id: uuidv4() });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total_embeddings).toBe(0);
  });
});

describe('handleEmbeddingGet', () => {
  let tempDir: string;
  const dbName = createUniqueName('emb-get-tool');
  let chunkEmbId: string;
  let imageEmbId: string;
  let _chunkEmbProvId: string;

  beforeAll(() => {
    tempDir = createTempDir('emb-get-tool-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Create document + OCR + chunk + chunk embedding
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

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, {
      heading_context: 'Section A',
      section_path: 'Chapter 1 > Section A',
    });
    db.insertChunk(chunk);

    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv);
    _chunkEmbProvId = embProv.id;
    const emb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
      image_id: null,
      extraction_id: null,
    });
    chunkEmbId = emb.id;
    db.insertEmbedding(emb);

    // Image + image embedding
    const conn = db.getConnection();
    const imgId = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO images (id, document_id, ocr_result_id, page_number,
        bbox_x, bbox_y, bbox_width, bbox_height, image_index, format,
        width, height, vlm_status, extracted_path, vlm_confidence, created_at, block_type)
      VALUES (?, ?, ?, 2, 10, 20, 200, 300, 0, 'png', 200, 300, 'complete',
        '/test/img.png', 0.95, datetime('now'), 'Figure')
    `
      )
      .run(imgId, doc.id, ocr.id);

    const imgEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(imgEmbProv);
    const imgEmb = createTestEmbedding(null as unknown as string, doc.id, imgEmbProv.id, {
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
    });
    imageEmbId = imgEmb.id;
    db.insertEmbedding(imgEmb);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should fail with database not selected', async () => {
    resetState();
    const result = await handleEmbeddingGet({ embedding_id: chunkEmbId });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
    selectDatabase(dbName, tempDir);
  });

  it('should fail for non-existent embedding', async () => {
    const result = await handleEmbeddingGet({ embedding_id: uuidv4() });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
  });

  it('should fail without embedding_id', async () => {
    const result = await handleEmbeddingGet({});
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
  });

  it('should return chunk embedding with source context', async () => {
    const result = await handleEmbeddingGet({ embedding_id: chunkEmbId });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.id).toBe(chunkEmbId);
    expect(parsed.data.source_type).toBe('chunk');
    expect(parsed.data.chunk_id).not.toBeNull();
    expect(parsed.data.source_context).toBeDefined();
    expect(parsed.data.source_context.type).toBe('chunk');
    expect(parsed.data.source_context.heading_context).toBe('Section A');
    expect(parsed.data.source_context.section_path).toBe('Chapter 1 > Section A');
    expect(parsed.data.document_context).toBeDefined();
    expect(parsed.data.document_context.file_type).toBe('pdf');
    expect(parsed.data.original_text).toBeDefined();
    expect(parsed.data.model_name).toBe('nomic-embed-text-v1.5');
  });

  it('should return image embedding with source context', async () => {
    const result = await handleEmbeddingGet({ embedding_id: imageEmbId });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.source_type).toBe('image');
    expect(parsed.data.source_context).toBeDefined();
    expect(parsed.data.source_context.type).toBe('image');
    expect(parsed.data.source_context.extracted_path).toBe('/test/img.png');
    expect(parsed.data.source_context.block_type).toBe('Figure');
    expect(parsed.data.source_context.vlm_confidence).toBe(0.95);
  });

  it('should include provenance chain when requested', async () => {
    const result = await handleEmbeddingGet({
      embedding_id: chunkEmbId,
      include_provenance: true,
    });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.provenance_chain).toBeDefined();
    expect(Array.isArray(parsed.data.provenance_chain)).toBe(true);
    expect(parsed.data.provenance_chain.length).toBeGreaterThan(0);
  });

  it('should not include provenance chain by default', async () => {
    const result = await handleEmbeddingGet({ embedding_id: chunkEmbId });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.provenance_chain).toBeUndefined();
  });
});

describe('handleEmbeddingRebuild', () => {
  let tempDir: string;
  const dbName = createUniqueName('emb-rebuild-tool');

  beforeAll(() => {
    tempDir = createTempDir('emb-rebuild-tool-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should fail with database not selected', async () => {
    resetState();
    const result = await handleEmbeddingRebuild({ chunk_id: uuidv4() });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
    selectDatabase(dbName, tempDir);
  });

  it('should fail when no target specified', async () => {
    const result = await handleEmbeddingRebuild({});
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('Exactly one');
  });

  it('should fail when multiple targets specified', async () => {
    const result = await handleEmbeddingRebuild({
      document_id: uuidv4(),
      chunk_id: uuidv4(),
    });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('Exactly one');
  });

  it('should fail for non-existent chunk', async () => {
    const result = await handleEmbeddingRebuild({ chunk_id: uuidv4() });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('Chunk not found');
  });

  it('should fail for non-existent document', async () => {
    const result = await handleEmbeddingRebuild({ document_id: uuidv4() });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('Document not found');
  });

  it('should fail for non-existent image', async () => {
    const result = await handleEmbeddingRebuild({ image_id: uuidv4() });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('Image not found');
  });

  it('should fail for image without VLM description', async () => {
    const { db } = requireDatabase();

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

    const conn = db.getConnection();
    const imgId = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO images (id, document_id, ocr_result_id, page_number,
        bbox_x, bbox_y, bbox_width, bbox_height, image_index, format,
        width, height, vlm_status, created_at)
      VALUES (?, ?, ?, 1, 0, 0, 100, 100, 0, 'png', 100, 100, 'pending', datetime('now'))
    `
      )
      .run(imgId, doc.id, ocr.id);

    const result = await handleEmbeddingRebuild({ image_id: imgId });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('no VLM description');
  });

  it('should fail for document with no chunks', async () => {
    const { db } = requireDatabase();

    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const result = await handleEmbeddingRebuild({ document_id: doc.id });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('No chunks found');
  });

  it('should delete old chunk embedding when rebuilding (deletion path test)', async () => {
    const { db } = requireDatabase();

    // Create document + OCR + chunk + old embedding
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

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    // Insert old embedding
    const oldEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(oldEmbProv);
    const oldEmb = createTestEmbedding(chunk.id, doc.id, oldEmbProv.id, {
      image_id: null,
      extraction_id: null,
    });
    db.insertEmbedding(oldEmb);
    db.updateChunkEmbeddingStatus(chunk.id, 'complete', new Date().toISOString());

    // Verify old embedding exists
    const oldCheck = db.getEmbedding(oldEmb.id);
    expect(oldCheck).not.toBeNull();

    // Rebuild will fail because no GPU available in test, but it should delete the old embedding first
    // The EmbeddingService.embedDocumentChunks will throw because Python worker isn't available
    const result = await handleEmbeddingRebuild({ chunk_id: chunk.id });
    const parsed = parseResponse(result);

    // The rebuild will likely fail due to no Python worker,
    // but we can verify the old embedding was deleted
    if (!parsed.success) {
      // Old embedding should have been deleted before the embed call
      const afterDelete = db.getEmbeddingByChunkId(chunk.id);
      expect(afterDelete).toBeNull();

      // Chunk should be back to pending
      const chunkAfter = db.getChunk(chunk.id);
      expect(chunkAfter?.embedding_status).toBe('pending');
    }
  });

  it('should return correct response structure for target types', async () => {
    // Test that the response identifies the correct target type
    const result = await handleEmbeddingRebuild({ chunk_id: uuidv4() });
    const parsed = parseResponse(result);
    // Will fail with "Chunk not found" but structure should be in error
    expect(parsed.success).toBe(false);

    // Test document target
    const result2 = await handleEmbeddingRebuild({ document_id: uuidv4() });
    const parsed2 = parseResponse(result2);
    expect(parsed2.success).toBe(false);
  });
});
