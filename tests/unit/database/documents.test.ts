/**
 * Document Operations Tests
 *
 * Tests for document CRUD operations and status updates.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestProvenance,
  createTestDocument,
  createFreshDatabase,
  safeCloseDatabase,
  DatabaseService,
  computeHash,
} from './helpers.js';
import { DatabaseError, DatabaseErrorCode } from '../../../src/services/storage/database.js';

describe('DatabaseService - Document Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-doc-ops-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-doc');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  describe('insertDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts document and returns ID', () => {
      const prov = createTestProvenance();
      dbService!.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      const returnedId = dbService!.insertDocument(doc);

      expect(returnedId).toBe(doc.id);

      // Verify via getDocument
      const retrieved = dbService!.getDocument(doc.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(doc.id);
      expect(retrieved!.file_path).toBe(doc.file_path);
    });

    it.skipIf(!sqliteVecAvailable)('sets created_at automatically', () => {
      const prov = createTestProvenance();
      dbService!.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      const beforeInsert = new Date().toISOString();
      dbService!.insertDocument(doc);
      const afterInsert = new Date().toISOString();

      const retrieved = dbService!.getDocument(doc.id);
      expect(retrieved!.created_at).toBeDefined();
      expect(retrieved!.created_at >= beforeInsert).toBe(true);
      expect(retrieved!.created_at <= afterInsert).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('throws FOREIGN_KEY_VIOLATION if provenance_id invalid', () => {
      const doc = createTestDocument('invalid-provenance-id');

      expect(() => {
        dbService!.insertDocument(doc);
      }).toThrow(DatabaseError);

      try {
        dbService!.insertDocument(doc);
      } catch (error) {
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
      }
    });
  });

  describe('getDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('returns document by ID', () => {
      const prov = createTestProvenance();
      dbService!.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      dbService!.insertDocument(doc);

      const retrieved = dbService!.getDocument(doc.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.file_path).toBe(doc.file_path);
      expect(retrieved!.file_name).toBe(doc.file_name);
      expect(retrieved!.file_hash).toBe(doc.file_hash);
      expect(retrieved!.file_size).toBe(doc.file_size);
      expect(retrieved!.file_type).toBe(doc.file_type);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService!.getDocument('nonexistent-doc-id');
      expect(result).toBeNull();
    });
  });

  describe('getDocumentByPath()', () => {
    it.skipIf(!sqliteVecAvailable)('returns document by file_path', () => {
      const prov = createTestProvenance();
      dbService!.insertProvenance(prov);

      const doc = createTestDocument(prov.id, { file_path: '/unique/path/document.pdf' });
      dbService!.insertDocument(doc);

      const retrieved = dbService!.getDocumentByPath('/unique/path/document.pdf');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(doc.id);
    });
  });

  describe('getDocumentByHash()', () => {
    it.skipIf(!sqliteVecAvailable)('returns document by file_hash', () => {
      const prov = createTestProvenance();
      dbService!.insertProvenance(prov);

      const uniqueHash = computeHash('unique-file-content-' + String(Date.now()));
      const doc = createTestDocument(prov.id, { file_hash: uniqueHash });
      dbService!.insertDocument(doc);

      const retrieved = dbService!.getDocumentByHash(uniqueHash);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(doc.id);
    });
  });

  describe('listDocuments()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all documents', () => {
      for (let i = 0; i < 3; i++) {
        const prov = createTestProvenance();
        dbService!.insertProvenance(prov);
        const doc = createTestDocument(prov.id);
        dbService!.insertDocument(doc);
      }

      const documents = dbService!.listDocuments();
      expect(documents.length).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('filters by status', () => {
      const statuses = ['pending', 'processing', 'complete', 'failed'] as const;

      for (const status of statuses) {
        const prov = createTestProvenance();
        dbService!.insertProvenance(prov);
        const doc = createTestDocument(prov.id, { status });
        dbService!.insertDocument(doc);
      }

      const pendingDocs = dbService!.listDocuments({ status: 'pending' });
      expect(pendingDocs.length).toBe(1);
      expect(pendingDocs[0].status).toBe('pending');

      const completeDocs = dbService!.listDocuments({ status: 'complete' });
      expect(completeDocs.length).toBe(1);
      expect(completeDocs[0].status).toBe('complete');
    });

    it.skipIf(!sqliteVecAvailable)('respects limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        const prov = createTestProvenance();
        dbService!.insertProvenance(prov);
        const doc = createTestDocument(prov.id);
        dbService!.insertDocument(doc);
      }

      const limited = dbService!.listDocuments({ limit: 2 });
      expect(limited.length).toBe(2);

      const offset = dbService!.listDocuments({ limit: 2, offset: 2 });
      expect(offset.length).toBe(2);

      const limitedIds = limited.map((d) => d.id);
      const offsetIds = offset.map((d) => d.id);
      for (const id of offsetIds) {
        expect(limitedIds).not.toContain(id);
      }
    });
  });

  describe('updateDocumentStatus()', () => {
    it.skipIf(!sqliteVecAvailable)('updates status', () => {
      const prov = createTestProvenance();
      dbService!.insertProvenance(prov);
      const doc = createTestDocument(prov.id, { status: 'pending' });
      dbService!.insertDocument(doc);

      dbService!.updateDocumentStatus(doc.id, 'processing');

      const retrieved = dbService!.getDocument(doc.id);
      expect(retrieved!.status).toBe('processing');
    });

    it.skipIf(!sqliteVecAvailable)('sets error_message for failed', () => {
      const prov = createTestProvenance();
      dbService!.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      dbService!.insertDocument(doc);

      const errorMsg = 'OCR processing failed: timeout';
      dbService!.updateDocumentStatus(doc.id, 'failed', errorMsg);

      const retrieved = dbService!.getDocument(doc.id);
      expect(retrieved!.status).toBe('failed');
      expect(retrieved!.error_message).toBe(errorMsg);
    });

    it.skipIf(!sqliteVecAvailable)('throws DOCUMENT_NOT_FOUND if not exists', () => {
      expect(() => {
        dbService!.updateDocumentStatus('nonexistent-doc', 'processing');
      }).toThrow(DatabaseError);

      try {
        dbService!.updateDocumentStatus('nonexistent-doc', 'processing');
      } catch (error) {
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DOCUMENT_NOT_FOUND);
      }
    });
  });

  describe('updateDocumentOCRComplete()', () => {
    it.skipIf(!sqliteVecAvailable)(
      'updates status to processing with page_count and ocr_completed_at',
      () => {
        const prov = createTestProvenance();
        dbService!.insertProvenance(prov);
        const doc = createTestDocument(prov.id, { status: 'processing' });
        dbService!.insertDocument(doc);

        const completedAt = new Date().toISOString();
        dbService!.updateDocumentOCRComplete(doc.id, 5, completedAt);

        const retrieved = dbService!.getDocument(doc.id);
        expect(retrieved!.status).toBe('processing');
        expect(retrieved!.page_count).toBe(5);
        expect(retrieved!.ocr_completed_at).toBe(completedAt);
      }
    );
  });
});
