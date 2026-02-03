/**
 * Cascade Delete Tests
 *
 * Tests for document cascade delete operations that remove all derived data.
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

describe('DatabaseService - Cascade Delete', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-cascade-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-cascade');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  describe('deleteDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('cascade deletes all derived data', () => {
      // Create full chain: provenance -> document -> ocr -> chunks -> embeddings
      const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
      dbService!.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id);
      dbService!.insertDocument(doc);

      // Child provenance records use document's provenance_id as root_document_id
      // This matches production behavior (see tracker.ts, processor.ts, chunker.ts, embedder.ts)
      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        source_id: docProv.id,
        root_document_id: docProv.id,  // Use document's provenance ID, not document ID
        chain_depth: 1,
      });
      dbService!.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService!.insertOCRResult(ocr);

      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        source_id: ocrProv.id,
        root_document_id: docProv.id,  // Use document's provenance ID, not document ID
        chain_depth: 2,
      });
      dbService!.insertProvenance(chunkProv);

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService!.insertChunk(chunk);

      const embProv = createTestProvenance({
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProv.id,
        source_id: chunkProv.id,
        root_document_id: docProv.id,  // Use document's provenance ID, not document ID
        chain_depth: 3,
      });
      dbService!.insertProvenance(embProv);

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService!.insertEmbedding(embedding);

      // Verify all records exist before delete
      const rawDb = dbService!.getConnection();
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM embeddings WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);

      // Delete document
      dbService!.deleteDocument(doc.id);

      // Verify all records removed
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM embeddings WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      // Provenance uses document's provenance_id as root_document_id
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM provenance WHERE root_document_id = ?').get(docProv.id) as { c: number }).c
      ).toBe(0);
    });
  });
});
