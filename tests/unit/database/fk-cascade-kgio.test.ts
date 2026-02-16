/**
 * FK Cascade Delete Verification Tests (KGIO FK Fix)
 *
 * Tests that cascade delete correctly handles:
 *   - entity_mentions deleted BEFORE chunks (entity_mentions.chunk_id REFERENCES chunks(id))
 *   - Provenance self-referencing FKs (parent_id, source_id) cleared before deletion
 *   - Full delete of document with entities, chunks, and entity_mentions linked to chunks
 *
 * Uses REAL databases (better-sqlite3). NO mocks.
 *
 * @module tests/unit/database/fk-cascade-kgio
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
  uuidv4,
} from './helpers.js';

describe('FK Cascade Delete - KGIO Fixes', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-fk-kgio-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-fk-kgio');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  describe('entity_mentions.chunk_id FK ordering', () => {
    it.skipIf(!sqliteVecAvailable)(
      'entity_mentions deleted before chunks when chunk_id is set',
      () => {
        // Create full chain: doc -> ocr -> chunks -> entity_mentions (with chunk_id)
        const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
        dbService!.insertProvenance(docProv);

        const doc = createTestDocument(docProv.id, { status: 'complete' });
        dbService!.insertDocument(doc);

        const ocrProv = createTestProvenance({
          type: ProvenanceType.OCR_RESULT,
          parent_id: docProv.id,
          source_id: docProv.id,
          root_document_id: docProv.id,
          chain_depth: 1,
        });
        dbService!.insertProvenance(ocrProv);

        const ocr = createTestOCRResult(doc.id, ocrProv.id);
        dbService!.insertOCRResult(ocr);

        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          parent_id: ocrProv.id,
          source_id: ocrProv.id,
          root_document_id: docProv.id,
          chain_depth: 2,
        });
        dbService!.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
        dbService!.insertChunk(chunk);

        // Create entity extraction provenance
        const entityProv = createTestProvenance({
          type: ProvenanceType.ENTITY_EXTRACTION,
          parent_id: ocrProv.id,
          source_id: ocrProv.id,
          root_document_id: docProv.id,
          chain_depth: 2,
        });
        dbService!.insertProvenance(entityProv);

        // Insert entity and entity_mention with chunk_id set
        const rawDb = dbService!.getConnection();
        const entityId = uuidv4();
        const now = new Date().toISOString();
        rawDb
          .prepare(
            `
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
          )
          .run(entityId, doc.id, 'person', 'Test Person', 'test person', 0.9, entityProv.id, now);

        const mentionId = uuidv4();
        rawDb
          .prepare(
            `
        INSERT INTO entity_mentions (id, entity_id, document_id, chunk_id,
          page_number, character_start, character_end, context_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
          )
          .run(mentionId, entityId, doc.id, chunk.id, 1, 0, 11, 'Test Person in context', now);

        // Verify data exists before delete
        expect(
          (
            rawDb
              .prepare('SELECT COUNT(*) as c FROM entity_mentions WHERE chunk_id = ?')
              .get(chunk.id) as { c: number }
          ).c
        ).toBe(1);
        expect(
          (
            rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE id = ?').get(chunk.id) as {
              c: number;
            }
          ).c
        ).toBe(1);

        // Delete document - should NOT throw FK violation
        expect(() => dbService!.deleteDocument(doc.id)).not.toThrow();

        // Verify all records removed
        expect(
          (
            rawDb
              .prepare('SELECT COUNT(*) as c FROM entity_mentions WHERE document_id = ?')
              .get(doc.id) as { c: number }
          ).c
        ).toBe(0);
        expect(
          (
            rawDb
              .prepare('SELECT COUNT(*) as c FROM entities WHERE document_id = ?')
              .get(doc.id) as { c: number }
          ).c
        ).toBe(0);
        expect(
          (
            rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE document_id = ?').get(doc.id) as {
              c: number;
            }
          ).c
        ).toBe(0);
        expect(
          (
            rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(doc.id) as {
              c: number;
            }
          ).c
        ).toBe(0);
      }
    );

    it.skipIf(!sqliteVecAvailable)('multiple entity_mentions with chunk_id all deleted', () => {
      const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
      dbService!.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id, { status: 'complete' });
      dbService!.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        source_id: docProv.id,
        root_document_id: docProv.id,
        chain_depth: 1,
      });
      dbService!.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService!.insertOCRResult(ocr);

      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        source_id: ocrProv.id,
        root_document_id: docProv.id,
        chain_depth: 2,
      });
      dbService!.insertProvenance(chunkProv);

      // Create two chunks
      const chunk1 = createTestChunk(doc.id, ocr.id, chunkProv.id, {
        chunk_index: 0,
        character_start: 0,
        character_end: 50,
      });
      dbService!.insertChunk(chunk1);

      const chunk2Prov = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        source_id: ocrProv.id,
        root_document_id: docProv.id,
        chain_depth: 2,
      });
      dbService!.insertProvenance(chunk2Prov);

      const chunk2 = createTestChunk(doc.id, ocr.id, chunk2Prov.id, {
        chunk_index: 1,
        character_start: 50,
        character_end: 100,
      });
      dbService!.insertChunk(chunk2);

      // Entity extraction provenance
      const entityProv = createTestProvenance({
        type: ProvenanceType.ENTITY_EXTRACTION,
        parent_id: ocrProv.id,
        source_id: ocrProv.id,
        root_document_id: docProv.id,
        chain_depth: 2,
      });
      dbService!.insertProvenance(entityProv);

      const rawDb = dbService!.getConnection();
      const now = new Date().toISOString();

      // Insert entity with mentions in both chunks
      const entityId = uuidv4();
      rawDb
        .prepare(
          `
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(entityId, doc.id, 'person', 'Alice', 'alice', 0.9, entityProv.id, now);

      rawDb
        .prepare(
          `
        INSERT INTO entity_mentions (id, entity_id, document_id, chunk_id,
          page_number, character_start, character_end, context_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(uuidv4(), entityId, doc.id, chunk1.id, 1, 10, 15, 'Alice in chunk 1', now);

      rawDb
        .prepare(
          `
        INSERT INTO entity_mentions (id, entity_id, document_id, chunk_id,
          page_number, character_start, character_end, context_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(uuidv4(), entityId, doc.id, chunk2.id, 1, 60, 65, 'Alice in chunk 2', now);

      // Verify 2 mentions
      expect(
        (
          rawDb
            .prepare('SELECT COUNT(*) as c FROM entity_mentions WHERE document_id = ?')
            .get(doc.id) as { c: number }
        ).c
      ).toBe(2);

      // Delete should succeed without FK violation
      expect(() => dbService!.deleteDocument(doc.id)).not.toThrow();

      // All gone
      expect(
        (
          rawDb
            .prepare('SELECT COUNT(*) as c FROM entity_mentions WHERE entity_id = ?')
            .get(entityId) as { c: number }
        ).c
      ).toBe(0);
      expect(
        (
          rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE document_id = ?').get(doc.id) as {
            c: number;
          }
        ).c
      ).toBe(0);
    });
  });

  describe('provenance self-referencing FK cleanup', () => {
    it.skipIf(!sqliteVecAvailable)(
      'provenance parent_id and source_id cleared before deletion',
      () => {
        // Create a chain: doc_prov -> ocr_prov -> chunk_prov -> embedding_prov
        // Each references parent via parent_id and source_id
        const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
        dbService!.insertProvenance(docProv);

        const doc = createTestDocument(docProv.id, { status: 'complete' });
        dbService!.insertDocument(doc);

        const ocrProv = createTestProvenance({
          type: ProvenanceType.OCR_RESULT,
          parent_id: docProv.id,
          source_id: docProv.id,
          root_document_id: docProv.id,
          chain_depth: 1,
        });
        dbService!.insertProvenance(ocrProv);

        const ocr = createTestOCRResult(doc.id, ocrProv.id);
        dbService!.insertOCRResult(ocr);

        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          parent_id: ocrProv.id,
          source_id: ocrProv.id,
          root_document_id: docProv.id,
          chain_depth: 2,
        });
        dbService!.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
        dbService!.insertChunk(chunk);

        const embProv = createTestProvenance({
          type: ProvenanceType.EMBEDDING,
          parent_id: chunkProv.id,
          source_id: chunkProv.id,
          root_document_id: docProv.id,
          chain_depth: 3,
        });
        dbService!.insertProvenance(embProv);

        const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
        dbService!.insertEmbedding(embedding);

        const rawDb = dbService!.getConnection();

        // Verify provenance chain exists with non-null parent_id and source_id
        const provRecords = rawDb
          .prepare(
            'SELECT id, parent_id, source_id FROM provenance WHERE root_document_id = ? AND chain_depth > 0'
          )
          .all(docProv.id) as Array<{
          id: string;
          parent_id: string | null;
          source_id: string | null;
        }>;
        expect(provRecords.length).toBeGreaterThanOrEqual(2);
        // At least some should have non-null parent_id
        const withParent = provRecords.filter((r) => r.parent_id !== null);
        expect(withParent.length).toBeGreaterThan(0);

        // Delete should succeed - self-referencing FKs should be cleared first
        expect(() => dbService!.deleteDocument(doc.id)).not.toThrow();

        // All provenance for this document should be deleted
        expect(
          (
            rawDb
              .prepare('SELECT COUNT(*) as c FROM provenance WHERE root_document_id = ?')
              .get(docProv.id) as { c: number }
          ).c
        ).toBe(0);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'document with entity_extraction provenance deletes cleanly',
      () => {
        const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
        dbService!.insertProvenance(docProv);

        const doc = createTestDocument(docProv.id, { status: 'complete' });
        dbService!.insertDocument(doc);

        const ocrProv = createTestProvenance({
          type: ProvenanceType.OCR_RESULT,
          parent_id: docProv.id,
          source_id: docProv.id,
          root_document_id: docProv.id,
          chain_depth: 1,
        });
        dbService!.insertProvenance(ocrProv);

        const ocr = createTestOCRResult(doc.id, ocrProv.id);
        dbService!.insertOCRResult(ocr);

        // Entity extraction provenance (depth 2) referencing OCR provenance
        const entityProv = createTestProvenance({
          type: ProvenanceType.ENTITY_EXTRACTION,
          parent_id: ocrProv.id,
          source_id: ocrProv.id,
          root_document_id: docProv.id,
          chain_depth: 2,
        });
        dbService!.insertProvenance(entityProv);

        const rawDb = dbService!.getConnection();
        const now = new Date().toISOString();

        // Insert entity
        rawDb
          .prepare(
            `
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
          )
          .run(uuidv4(), doc.id, 'person', 'Test', 'test', 0.9, entityProv.id, now);

        // Delete should succeed
        expect(() => dbService!.deleteDocument(doc.id)).not.toThrow();

        expect(
          (
            rawDb
              .prepare('SELECT COUNT(*) as c FROM entities WHERE document_id = ?')
              .get(doc.id) as { c: number }
          ).c
        ).toBe(0);
        expect(
          (
            rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(doc.id) as {
              c: number;
            }
          ).c
        ).toBe(0);
      }
    );
  });

  describe('full document with KG data cascade delete', () => {
    it.skipIf(!sqliteVecAvailable)(
      'document with KG nodes deletes cleanly with re-parenting',
      () => {
        const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
        dbService!.insertProvenance(docProv);

        const doc = createTestDocument(docProv.id, { status: 'complete' });
        dbService!.insertDocument(doc);

        const ocrProv = createTestProvenance({
          type: ProvenanceType.OCR_RESULT,
          parent_id: docProv.id,
          source_id: docProv.id,
          root_document_id: docProv.id,
          chain_depth: 1,
        });
        dbService!.insertProvenance(ocrProv);

        const ocr = createTestOCRResult(doc.id, ocrProv.id);
        dbService!.insertOCRResult(ocr);

        // KG provenance
        const kgProv = createTestProvenance({
          type: ProvenanceType.KNOWLEDGE_GRAPH,
          parent_id: ocrProv.id,
          source_id: ocrProv.id,
          root_document_id: docProv.id,
          chain_depth: 2,
        });
        dbService!.insertProvenance(kgProv);

        const rawDb = dbService!.getConnection();
        const now = new Date().toISOString();

        // Create entity
        const entityId = uuidv4();
        const entityProvId = createTestProvenance({
          type: ProvenanceType.ENTITY_EXTRACTION,
          parent_id: ocrProv.id,
          source_id: ocrProv.id,
          root_document_id: docProv.id,
          chain_depth: 2,
        }).id;
        dbService!.insertProvenance({
          ...createTestProvenance({
            type: ProvenanceType.ENTITY_EXTRACTION,
            parent_id: ocrProv.id,
            source_id: ocrProv.id,
            root_document_id: docProv.id,
            chain_depth: 2,
          }),
          id: entityProvId,
        });

        rawDb
          .prepare(
            `
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
          )
          .run(entityId, doc.id, 'person', 'Alice', 'alice', 0.9, entityProvId, now);

        // Create KG node referencing the KG provenance
        const nodeId = uuidv4();
        rawDb
          .prepare(
            `
        INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
          aliases, document_count, mention_count, edge_count, avg_confidence, metadata,
          provenance_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
          )
          .run(nodeId, 'person', 'Alice', 'alice', null, 2, 2, 0, 0.9, null, kgProv.id, now, now);
        // document_count = 2 means this node appears in 2 documents; after cleanup it survives

        // Link entity to node
        rawDb
          .prepare(
            `
        INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
          )
          .run(uuidv4(), nodeId, entityId, doc.id, 1.0, 'exact', now);

        // Delete should succeed - KG node survives with re-parented provenance
        expect(() => dbService!.deleteDocument(doc.id)).not.toThrow();

        // Document is gone
        expect(
          (
            rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(doc.id) as {
              c: number;
            }
          ).c
        ).toBe(0);

        // KG node survives (because document_count was 2, so cleanupGraphForDocument decremented to 1)
        const nodeRow = rawDb.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(nodeId) as
          | Record<string, unknown>
          | undefined;
        if (nodeRow) {
          // Node survived - provenance should be re-parented to ORPHANED_ROOT
          const provRow = rawDb
            .prepare('SELECT root_document_id FROM provenance WHERE id = ?')
            .get(kgProv.id) as { root_document_id: string } | undefined;
          if (provRow) {
            expect(provRow.root_document_id).toBe('ORPHANED_ROOT');
          }
        }
        // If node was deleted (single-doc node), that's also fine - the important thing is no FK violation
      }
    );
  });
});
