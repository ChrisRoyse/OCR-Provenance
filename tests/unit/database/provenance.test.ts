/**
 * Provenance Operations Tests
 *
 * Tests for provenance CRUD operations and chain traversal.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestProvenance,
  createFreshDatabase,
  safeCloseDatabase,
  DatabaseService,
  ProvenanceType,
  uuidv4,
} from './helpers.js';

describe('DatabaseService - Provenance Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-prov-ops-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-prov');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  describe('insertProvenance()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and returns ID', () => {
      const prov = createTestProvenance();
      const returnedId = dbService!.insertProvenance(prov);

      expect(returnedId).toBe(prov.id);
    });

    it.skipIf(!sqliteVecAvailable)('stringifies JSON fields correctly', () => {
      const prov = createTestProvenance({
        processing_params: { mode: 'balanced', quality: 0.95 },
        location: { page_number: 1, character_start: 0, character_end: 100 },
      });
      dbService!.insertProvenance(prov);

      // Verify via raw query
      const rawDb = dbService!.getConnection();
      const row = rawDb.prepare('SELECT processing_params, location FROM provenance WHERE id = ?').get(prov.id) as {
        processing_params: string;
        location: string;
      };

      expect(row.processing_params).toBe(JSON.stringify({ mode: 'balanced', quality: 0.95 }));
      expect(row.location).toBe(JSON.stringify({ page_number: 1, character_start: 0, character_end: 100 }));
    });
  });

  describe('getProvenance()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID with parsed JSON fields', () => {
      const prov = createTestProvenance({
        processing_params: { mode: 'accurate', threshold: 0.8 },
        location: { page_number: 2, chunk_index: 5 },
      });
      dbService!.insertProvenance(prov);

      const retrieved = dbService!.getProvenance(prov.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.processing_params).toEqual({ mode: 'accurate', threshold: 0.8 });
      expect(retrieved!.location).toEqual({ page_number: 2, chunk_index: 5 });
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService!.getProvenance('nonexistent-prov-id');
      expect(result).toBeNull();
    });
  });

  describe('getProvenanceChain()', () => {
    it.skipIf(!sqliteVecAvailable)('returns full ancestor chain', () => {
      // Create chain: doc -> ocr -> chunk -> embedding
      const docProv = createTestProvenance({
        type: ProvenanceType.DOCUMENT,
        chain_depth: 0,
      });
      dbService!.insertProvenance(docProv);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 1,
      });
      dbService!.insertProvenance(ocrProv);

      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 2,
      });
      dbService!.insertProvenance(chunkProv);

      const embProv = createTestProvenance({
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 3,
      });
      dbService!.insertProvenance(embProv);

      // Get chain from embedding
      const chain = dbService!.getProvenanceChain(embProv.id);

      expect(chain.length).toBe(4);
      expect(chain[0].id).toBe(embProv.id);
      expect(chain[1].id).toBe(chunkProv.id);
      expect(chain[2].id).toBe(ocrProv.id);
      expect(chain[3].id).toBe(docProv.id);
    });

    it.skipIf(!sqliteVecAvailable)('returns empty array if not found', () => {
      const chain = dbService!.getProvenanceChain('nonexistent-id');
      expect(chain).toEqual([]);
    });
  });

  describe('getProvenanceByRootDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all for root document', () => {
      const rootId = uuidv4();

      // Create multiple provenance records with same root
      const docProv = createTestProvenance({
        root_document_id: rootId,
        chain_depth: 0,
      });
      dbService!.insertProvenance(docProv);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        root_document_id: rootId,
        chain_depth: 1,
      });
      dbService!.insertProvenance(ocrProv);

      const records = dbService!.getProvenanceByRootDocument(rootId);

      expect(records.length).toBe(2);
      expect(records[0].chain_depth).toBe(0); // Ordered by chain_depth
      expect(records[1].chain_depth).toBe(1);
    });
  });

  describe('getProvenanceChildren()', () => {
    it.skipIf(!sqliteVecAvailable)('returns children by parent_id', () => {
      const parentProv = createTestProvenance({ chain_depth: 0 });
      dbService!.insertProvenance(parentProv);

      // Create multiple children
      for (let i = 0; i < 3; i++) {
        const childProv = createTestProvenance({
          type: ProvenanceType.OCR_RESULT,
          parent_id: parentProv.id,
          root_document_id: parentProv.root_document_id,
          chain_depth: 1,
        });
        dbService!.insertProvenance(childProv);
      }

      const children = dbService!.getProvenanceChildren(parentProv.id);
      expect(children.length).toBe(3);
      expect(children.every((c) => c.parent_id === parentProv.id)).toBe(true);
    });
  });
});
