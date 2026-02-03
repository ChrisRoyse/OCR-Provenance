/**
 * Chunk Operations Tests
 *
 * Tests for chunk CRUD operations, batch inserts, and embedding status updates.
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
  createFreshDatabase,
  safeCloseDatabase,
  DatabaseService,
  ProvenanceType,
} from './helpers.js';
import { DatabaseError, DatabaseErrorCode } from '../../../src/services/storage/database.js';

describe('DatabaseService - Chunk Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-chunk-ops-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-chunk');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  /**
   * Helper to set up prerequisite data for chunk tests
   */
  function setupChunkPrerequisites(): {
    doc: ReturnType<typeof createTestDocument>;
    ocr: ReturnType<typeof createTestOCRResult>;
    chunkProv: ReturnType<typeof createTestProvenance>;
  } {
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

    const chunkProv = createTestProvenance({
      type: ProvenanceType.CHUNK,
      root_document_id: doc.id,
    });
    dbService!.insertProvenance(chunkProv);

    return { doc, ocr, chunkProv };
  }

  describe('insertChunk()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts with embedding_status=pending', () => {
      const { doc, ocr, chunkProv } = setupChunkPrerequisites();

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      const returnedId = dbService!.insertChunk(chunk);

      expect(returnedId).toBe(chunk.id);

      const retrieved = dbService!.getChunk(chunk.id);
      expect(retrieved!.embedding_status).toBe('pending');
      expect(retrieved!.embedded_at).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)(
      'throws FOREIGN_KEY_VIOLATION if references invalid',
      () => {
        const chunk = createTestChunk('invalid-doc', 'invalid-ocr', 'invalid-prov');

        expect(() => {
          dbService!.insertChunk(chunk);
        }).toThrow(DatabaseError);

        try {
          dbService!.insertChunk(chunk);
        } catch (error) {
          expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
        }
      }
    );
  });

  describe('insertChunks()', () => {
    it.skipIf(!sqliteVecAvailable)('batch insert in transaction', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      // Create multiple chunk provenance records and chunks
      const chunks = [];
      for (let i = 0; i < 5; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(chunkProv);

        chunks.push(
          createTestChunk(doc.id, ocr.id, chunkProv.id, {
            chunk_index: i,
            text: `Chunk ${String(i)} content`,
          })
        );
      }

      const ids = dbService!.insertChunks(chunks);

      expect(ids.length).toBe(5);

      // Verify all inserted
      const retrieved = dbService!.getChunksByDocumentId(doc.id);
      expect(retrieved.length).toBe(5);
    });
  });

  describe('getChunk()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID', () => {
      const { doc, ocr, chunkProv } = setupChunkPrerequisites();

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService!.insertChunk(chunk);

      const retrieved = dbService!.getChunk(chunk.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.text).toBe(chunk.text);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService!.getChunk('nonexistent-chunk-id');
      expect(result).toBeNull();
    });
  });

  describe('getChunksByDocumentId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all chunks for document', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService!.insertChunk(chunk);
      }

      const chunks = dbService!.getChunksByDocumentId(doc.id);
      expect(chunks.length).toBe(3);

      // Should be ordered by chunk_index
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[1].chunk_index).toBe(1);
      expect(chunks[2].chunk_index).toBe(2);
    });
  });

  describe('getChunksByOCRResultId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all chunks for OCR result', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService!.insertChunk(chunk);
      }

      const chunks = dbService!.getChunksByOCRResultId(ocr.id);
      expect(chunks.length).toBe(3);
    });
  });

  describe('getPendingEmbeddingChunks()', () => {
    it.skipIf(!sqliteVecAvailable)('returns chunks with status=pending', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      // Create chunks with different statuses
      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService!.insertChunk(chunk);
      }

      // Update one to complete
      const allChunks = dbService!.getChunksByDocumentId(doc.id);
      dbService!.updateChunkEmbeddingStatus(allChunks[0].id, 'complete', new Date().toISOString());

      const pending = dbService!.getPendingEmbeddingChunks();
      expect(pending.length).toBe(2);
      expect(pending.every((c) => c.embedding_status === 'pending')).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('respects limit', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      for (let i = 0; i < 10; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService!.insertChunk(chunk);
      }

      const pending = dbService!.getPendingEmbeddingChunks(5);
      expect(pending.length).toBe(5);
    });
  });

  describe('updateChunkEmbeddingStatus()', () => {
    it.skipIf(!sqliteVecAvailable)('updates status and embedded_at', () => {
      const { doc, ocr, chunkProv } = setupChunkPrerequisites();

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService!.insertChunk(chunk);

      const embeddedAt = new Date().toISOString();
      dbService!.updateChunkEmbeddingStatus(chunk.id, 'complete', embeddedAt);

      const retrieved = dbService!.getChunk(chunk.id);
      expect(retrieved!.embedding_status).toBe('complete');
      expect(retrieved!.embedded_at).toBe(embeddedAt);
    });

    it.skipIf(!sqliteVecAvailable)('throws CHUNK_NOT_FOUND if not exists', () => {
      expect(() => {
        dbService!.updateChunkEmbeddingStatus('nonexistent-chunk', 'complete');
      }).toThrow(DatabaseError);

      try {
        dbService!.updateChunkEmbeddingStatus('nonexistent-chunk', 'complete');
      } catch (error) {
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.CHUNK_NOT_FOUND);
      }
    });
  });
});
