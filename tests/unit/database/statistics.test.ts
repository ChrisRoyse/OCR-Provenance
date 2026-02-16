/**
 * Statistics and Metadata Tests
 *
 * Tests for database statistics retrieval and metadata updates.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  createTestEmbedding,
  createFreshDatabase,
  safeCloseDatabase,
  DatabaseService,
  ProvenanceType,
} from './helpers.js';

describe('DatabaseService - Statistics', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-stats-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-stats');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  describe('getStats()', () => {
    it.skipIf(!sqliteVecAvailable)('returns correct counts', () => {
      // Insert test data
      const docProv = createTestProvenance();
      dbService!.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id, { status: 'complete' });
      dbService!.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService!.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService!.insertOCRResult(ocr);

      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        root_document_id: doc.id,
      });
      dbService!.insertProvenance(chunkProv);

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService!.insertChunk(chunk);

      const embProv = createTestProvenance({
        type: ProvenanceType.EMBEDDING,
        root_document_id: doc.id,
      });
      dbService!.insertProvenance(embProv);

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService!.insertEmbedding(embedding);

      const stats = dbService!.getStats();

      expect(stats.total_documents).toBe(1);
      expect(stats.total_ocr_results).toBe(1);
      expect(stats.total_chunks).toBe(1);
      expect(stats.total_embeddings).toBe(1);
      expect(stats.documents_by_status.complete).toBe(1);
      expect(stats.chunks_by_embedding_status.pending).toBe(1);
    });

    it.skipIf(!sqliteVecAvailable)('returns correct file size', () => {
      const stats = dbService!.getStats();
      expect(stats.storage_size_bytes).toBeGreaterThan(0);
    });

    it.skipIf(!sqliteVecAvailable)('calculates averages correctly', () => {
      // Insert document with 3 chunks
      const docProv = createTestProvenance();
      dbService!.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id);
      dbService!.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService!.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService!.insertOCRResult(ocr);

      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService!.insertChunk(chunk);
      }

      const stats = dbService!.getStats();

      expect(stats.avg_chunks_per_document).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('handles empty database', () => {
      const stats = dbService!.getStats();

      expect(stats.total_documents).toBe(0);
      expect(stats.total_ocr_results).toBe(0);
      expect(stats.total_chunks).toBe(0);
      expect(stats.total_embeddings).toBe(0);
      expect(stats.avg_chunks_per_document).toBe(0);
      expect(stats.avg_embeddings_per_chunk).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('returns ocr_quality stats', () => {
      // Insert document with OCR result that has parse_quality_score
      const docProv = createTestProvenance();
      dbService!.insertProvenance(docProv);
      const doc = createTestDocument(docProv.id, { status: 'complete' });
      dbService!.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService!.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id, {
        parse_quality_score: 4.2,
        cost_cents: 5.5,
      });
      dbService!.insertOCRResult(ocr);

      const stats = dbService!.getStats();
      expect(stats.ocr_quality).toBeDefined();
      expect(stats.ocr_quality.avg).toBeCloseTo(4.2, 1);
      expect(stats.ocr_quality.min).toBeCloseTo(4.2, 1);
      expect(stats.ocr_quality.max).toBeCloseTo(4.2, 1);
      expect(stats.ocr_quality.scored_count).toBe(1);
    });

    it.skipIf(!sqliteVecAvailable)('returns costs stats', () => {
      const docProv = createTestProvenance();
      dbService!.insertProvenance(docProv);
      const doc = createTestDocument(docProv.id, { status: 'complete' });
      dbService!.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService!.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id, {
        cost_cents: 10.5,
      });
      dbService!.insertOCRResult(ocr);

      const stats = dbService!.getStats();
      expect(stats.costs).toBeDefined();
      expect(stats.costs.total_ocr_cost_cents).toBeCloseTo(10.5, 1);
      expect(stats.costs.total_form_fill_cost_cents).toBe(0);
      expect(stats.costs.total_cost_cents).toBeCloseTo(10.5, 1);
    });

    it.skipIf(!sqliteVecAvailable)('returns zero costs and null quality for empty db', () => {
      const stats = dbService!.getStats();
      expect(stats.ocr_quality.avg).toBeNull();
      expect(stats.ocr_quality.min).toBeNull();
      expect(stats.ocr_quality.max).toBeNull();
      expect(stats.ocr_quality.scored_count).toBe(0);
      expect(stats.costs.total_ocr_cost_cents).toBe(0);
      expect(stats.costs.total_form_fill_cost_cents).toBe(0);
      expect(stats.costs.total_cost_cents).toBe(0);
    });
  });
});

describe('DatabaseService - Metadata Updates', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-meta-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-meta');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  it.skipIf(!sqliteVecAvailable)('updates metadata counts after document insert', () => {
    const prov = createTestProvenance();
    dbService!.insertProvenance(prov);

    const doc = createTestDocument(prov.id);
    dbService!.insertDocument(doc);

    // Verify metadata updated
    const rawDb = dbService!.getConnection();
    const metadata = rawDb
      .prepare('SELECT total_documents FROM database_metadata WHERE id = 1')
      .get() as { total_documents: number };

    expect(metadata.total_documents).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('updates metadata counts after document delete', () => {
    const prov = createTestProvenance();
    dbService!.insertProvenance(prov);

    const doc = createTestDocument(prov.id);
    dbService!.insertDocument(doc);

    dbService!.deleteDocument(doc.id);

    // Verify metadata updated
    const rawDb = dbService!.getConnection();
    const metadata = rawDb
      .prepare('SELECT total_documents FROM database_metadata WHERE id = 1')
      .get() as { total_documents: number };

    expect(metadata.total_documents).toBe(0);
  });
});
