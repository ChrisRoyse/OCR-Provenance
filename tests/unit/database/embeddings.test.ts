/**
 * Embedding Operations Tests
 *
 * Tests for embedding CRUD operations and batch inserts.
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
import { DatabaseError, DatabaseErrorCode } from '../../../src/services/storage/database.js';

describe('DatabaseService - Embedding Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-emb-ops-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-emb');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  /**
   * Helper to set up prerequisite data for embedding tests
   */
  function setupEmbeddingPrerequisites(): {
    doc: ReturnType<typeof createTestDocument>;
    chunk: ReturnType<typeof createTestChunk>;
    embProv: ReturnType<typeof createTestProvenance>;
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

    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    dbService!.insertChunk(chunk);

    const embProv = createTestProvenance({
      type: ProvenanceType.EMBEDDING,
      root_document_id: doc.id,
    });
    dbService!.insertProvenance(embProv);

    return { doc, chunk, embProv };
  }

  describe('insertEmbedding()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and returns ID', () => {
      const { doc, chunk, embProv } = setupEmbeddingPrerequisites();

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      const returnedId = dbService!.insertEmbedding(embedding);

      expect(returnedId).toBe(embedding.id);

      // Verify via raw database
      const rawDb = dbService!.getConnection();
      const row = rawDb.prepare('SELECT * FROM embeddings WHERE id = ?').get(embedding.id);
      expect(row).toBeDefined();
    });

    it.skipIf(!sqliteVecAvailable)('throws FOREIGN_KEY_VIOLATION if references invalid', () => {
      const embedding = createTestEmbedding('invalid-chunk', 'invalid-doc', 'invalid-prov');

      expect(() => {
        dbService!.insertEmbedding(embedding);
      }).toThrow(DatabaseError);

      try {
        dbService!.insertEmbedding(embedding);
      } catch (error) {
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
      }
    });
  });

  describe('insertEmbeddings()', () => {
    it.skipIf(!sqliteVecAvailable)('batch insert in transaction', () => {
      const { doc } = setupEmbeddingPrerequisites();

      // Get the chunk we created
      const chunks = dbService!.getChunksByDocumentId(doc.id);
      const chunk = chunks[0];

      // Create multiple embeddings for the same chunk
      const embeddings = [];
      for (let i = 0; i < 3; i++) {
        const embProv = createTestProvenance({
          type: ProvenanceType.EMBEDDING,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(embProv);

        embeddings.push(
          createTestEmbedding(chunk.id, doc.id, embProv.id, {
            original_text: `Embedding ${String(i)} text`,
          })
        );
      }

      const ids = dbService!.insertEmbeddings(embeddings);

      expect(ids.length).toBe(3);
    });
  });

  describe('getEmbedding()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID (without vector)', () => {
      const { doc, chunk, embProv } = setupEmbeddingPrerequisites();

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService!.insertEmbedding(embedding);

      const retrieved = dbService!.getEmbedding(embedding.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.original_text).toBe(embedding.original_text);
      expect(retrieved!.model_name).toBe(embedding.model_name);
      // vector should not be included
      expect('vector' in (retrieved as object)).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService!.getEmbedding('nonexistent-emb-id');
      expect(result).toBeNull();
    });
  });

  describe('getEmbeddingByChunkId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by chunk_id', () => {
      const { doc, chunk, embProv } = setupEmbeddingPrerequisites();

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService!.insertEmbedding(embedding);

      const retrieved = dbService!.getEmbeddingByChunkId(chunk.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(embedding.id);
    });
  });

  describe('getEmbeddingsByDocumentId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all for document', () => {
      const { doc, chunk } = setupEmbeddingPrerequisites();

      for (let i = 0; i < 3; i++) {
        const embProv = createTestProvenance({
          type: ProvenanceType.EMBEDDING,
          root_document_id: doc.id,
        });
        dbService!.insertProvenance(embProv);

        const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id, { chunk_index: i });
        dbService!.insertEmbedding(embedding);
      }

      const embeddings = dbService!.getEmbeddingsByDocumentId(doc.id);
      expect(embeddings.length).toBe(3);
    });
  });
});
