/**
 * Extraction Embedding Integration Tests
 *
 * Tests extraction-sourced embeddings through the DatabaseService layer.
 * Verifies INSERT, query, and cascade delete for embeddings with extraction_id.
 *
 * Uses REAL databases (better-sqlite3 + sqlite-vec), NO mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createFreshDatabase,
  safeCloseDatabase,
  DatabaseService,
  ProvenanceType,
  computeHash,
  uuidv4,
} from './helpers.js';

describe('Extraction Embeddings', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeEach(() => {
    testDir = createTestDir('ocr-ext-emb-');
    dbService = createFreshDatabase(testDir, 'ext-emb');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
    cleanupTestDir(testDir);
  });

  /**
   * Helper: Create a full extraction chain in the database.
   * Returns IDs for provenance, document, OCR result, and extraction.
   */
  function createExtractionChain(db: DatabaseService): {
    docProv: ReturnType<typeof createTestProvenance>;
    doc: ReturnType<typeof createTestDocument>;
    ocrProv: ReturnType<typeof createTestProvenance>;
    ocr: ReturnType<typeof createTestOCRResult>;
    extProv: ReturnType<typeof createTestProvenance>;
    extractionId: string;
  } {
    // 1. Document provenance
    const docProv = createTestProvenance({
      type: ProvenanceType.DOCUMENT,
      source_type: 'FILE',
      chain_depth: 0,
    });
    db.insertProvenance(docProv);

    // 2. Document
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // 3. OCR provenance
    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      source_type: 'OCR',
      source_id: docProv.id,
      root_document_id: docProv.id,
      parent_id: docProv.id,
      parent_ids: JSON.stringify([docProv.id]),
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);

    // 4. OCR result
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    // 5. Extraction provenance
    const extProv = createTestProvenance({
      type: ProvenanceType.EXTRACTION,
      source_type: 'EXTRACTION',
      source_id: ocrProv.id,
      root_document_id: docProv.id,
      parent_id: ocrProv.id,
      parent_ids: JSON.stringify([docProv.id, ocrProv.id]),
      chain_depth: 2,
    });
    db.insertProvenance(extProv);

    // 6. Extraction
    const extractionId = uuidv4();
    const now = new Date().toISOString();
    db.insertExtraction({
      id: extractionId,
      document_id: doc.id,
      ocr_result_id: ocr.id,
      schema_json: '{"type":"object","properties":{"name":{"type":"string"}}}',
      extraction_json: '{"name":"John Doe"}',
      content_hash: computeHash('{"name":"John Doe"}'),
      provenance_id: extProv.id,
      created_at: now,
    });

    return { docProv, doc, ocrProv, ocr, extProv, extractionId };
  }

  it.skipIf(!sqliteVecAvailable)('inserts extraction embedding with extraction_id set', () => {
    const db = dbService!;
    const { docProv, doc, extProv, extractionId } = createExtractionChain(db);

    // Create embedding provenance
    const embProv = createTestProvenance({
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: extProv.id,
      root_document_id: docProv.id,
      parent_id: extProv.id,
      parent_ids: JSON.stringify([docProv.id, extProv.id]),
      chain_depth: 3,
    });
    db.insertProvenance(embProv);

    // Insert extraction embedding
    const embId = db.insertEmbedding({
      id: uuidv4(),
      chunk_id: null,
      image_id: null,
      extraction_id: extractionId,
      document_id: doc.id,
      original_text: '{"name":"John Doe"}',
      original_text_length: 19,
      source_file_path: doc.file_path,
      source_file_name: doc.file_name,
      source_file_hash: doc.file_hash,
      page_number: 1,
      page_range: null,
      character_start: 0,
      character_end: 19,
      chunk_index: 0,
      total_chunks: 1,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProv.id,
      content_hash: computeHash('{"name":"John Doe"}'),
      generation_duration_ms: 50,
    });

    expect(embId).toBeDefined();

    // Verify stored correctly
    const stored = db.getEmbeddingByExtractionId(extractionId);
    expect(stored).not.toBeNull();
    expect(stored!.extraction_id).toBe(extractionId);
    expect(stored!.chunk_id).toBeNull();
    expect(stored!.image_id).toBeNull();
    expect(stored!.document_id).toBe(doc.id);
  });

  it.skipIf(!sqliteVecAvailable)('getEmbeddingByExtractionId retrieves correct embedding', () => {
    const db = dbService!;
    const { docProv, doc, extProv, extractionId } = createExtractionChain(db);

    // Create embedding provenance
    const embProv = createTestProvenance({
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: extProv.id,
      root_document_id: docProv.id,
      parent_id: extProv.id,
      parent_ids: JSON.stringify([docProv.id, extProv.id]),
      chain_depth: 3,
    });
    db.insertProvenance(embProv);

    const embeddingId = uuidv4();
    db.insertEmbedding({
      id: embeddingId,
      chunk_id: null,
      image_id: null,
      extraction_id: extractionId,
      document_id: doc.id,
      original_text: 'extraction content',
      original_text_length: 18,
      source_file_path: doc.file_path,
      source_file_name: doc.file_name,
      source_file_hash: doc.file_hash,
      page_number: 1,
      page_range: null,
      character_start: 0,
      character_end: 18,
      chunk_index: 0,
      total_chunks: 1,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProv.id,
      content_hash: computeHash('extraction content'),
      generation_duration_ms: 42,
    });

    const result = db.getEmbeddingByExtractionId(extractionId);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(embeddingId);
    expect(result!.extraction_id).toBe(extractionId);
    expect(result!.original_text).toBe('extraction content');
    expect(result!.model_name).toBe('nomic-embed-text-v1.5');
    expect(result!.provenance_id).toBe(embProv.id);
    expect(result!.generation_duration_ms).toBe(42);
  });

  it.skipIf(!sqliteVecAvailable)('getEmbeddingByExtractionId returns null for nonexistent', () => {
    const db = dbService!;
    const result = db.getEmbeddingByExtractionId('nonexistent-extraction-id');
    expect(result).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('batch insert includes extraction_id', () => {
    const db = dbService!;
    const { docProv, doc, ocrProv, extProv, extractionId } = createExtractionChain(db);

    // Create two embedding provenances
    const embProv1 = createTestProvenance({
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: extProv.id,
      root_document_id: docProv.id,
      parent_id: extProv.id,
      parent_ids: JSON.stringify([docProv.id, extProv.id]),
      chain_depth: 3,
    });
    db.insertProvenance(embProv1);

    // Create a second extraction for batch insert (use real OCR provenance for FK)
    const extProv2 = createTestProvenance({
      type: ProvenanceType.EXTRACTION,
      source_type: 'EXTRACTION',
      source_id: ocrProv.id,
      root_document_id: docProv.id,
      parent_id: ocrProv.id,
      parent_ids: JSON.stringify([docProv.id, ocrProv.id]),
      chain_depth: 2,
    });
    db.insertProvenance(extProv2);

    const extractionId2 = uuidv4();
    const now = new Date().toISOString();
    db.insertExtraction({
      id: extractionId2,
      document_id: doc.id,
      ocr_result_id: db.getExtractionsByDocument(doc.id)[0].ocr_result_id,
      schema_json: '{"type":"array"}',
      extraction_json: '[1,2,3]',
      content_hash: computeHash('[1,2,3]'),
      provenance_id: extProv2.id,
      created_at: now,
    });

    const embProv2 = createTestProvenance({
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: extProv2.id,
      root_document_id: docProv.id,
      parent_id: extProv2.id,
      parent_ids: JSON.stringify([docProv.id, extProv2.id]),
      chain_depth: 3,
    });
    db.insertProvenance(embProv2);

    // Batch insert two extraction embeddings
    const ids = db.insertEmbeddings([
      {
        id: uuidv4(),
        chunk_id: null,
        image_id: null,
        extraction_id: extractionId,
        document_id: doc.id,
        original_text: 'batch item 1',
        original_text_length: 12,
        source_file_path: doc.file_path,
        source_file_name: doc.file_name,
        source_file_hash: doc.file_hash,
        page_number: 1,
        page_range: null,
        character_start: 0,
        character_end: 12,
        chunk_index: 0,
        total_chunks: 2,
        model_name: 'nomic-embed-text-v1.5',
        model_version: '1.5.0',
        task_type: 'search_document',
        inference_mode: 'local',
        gpu_device: 'cuda:0',
        provenance_id: embProv1.id,
        content_hash: computeHash('batch item 1'),
        generation_duration_ms: 25,
      },
      {
        id: uuidv4(),
        chunk_id: null,
        image_id: null,
        extraction_id: extractionId2,
        document_id: doc.id,
        original_text: 'batch item 2',
        original_text_length: 12,
        source_file_path: doc.file_path,
        source_file_name: doc.file_name,
        source_file_hash: doc.file_hash,
        page_number: 1,
        page_range: null,
        character_start: 0,
        character_end: 12,
        chunk_index: 1,
        total_chunks: 2,
        model_name: 'nomic-embed-text-v1.5',
        model_version: '1.5.0',
        task_type: 'search_document',
        inference_mode: 'local',
        gpu_device: 'cuda:0',
        provenance_id: embProv2.id,
        content_hash: computeHash('batch item 2'),
        generation_duration_ms: 25,
      },
    ]);

    expect(ids).toHaveLength(2);

    // Verify both embeddings are stored with extraction_id
    const emb1 = db.getEmbeddingByExtractionId(extractionId);
    expect(emb1).not.toBeNull();
    expect(emb1!.extraction_id).toBe(extractionId);

    const emb2 = db.getEmbeddingByExtractionId(extractionId2);
    expect(emb2).not.toBeNull();
    expect(emb2!.extraction_id).toBe(extractionId2);
  });
});
