/**
 * OCR Result Operations Tests
 *
 * Tests for OCR result CRUD operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
} from './helpers.js';
import { DatabaseError, DatabaseErrorCode } from '../../../src/services/storage/database.js';

describe('DatabaseService - OCR Result Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-ocr-ops-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-ocr');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  describe('insertOCRResult()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and returns ID', () => {
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
      const returnedId = dbService!.insertOCRResult(ocr);

      expect(returnedId).toBe(ocr.id);

      // Verify via raw database query
      const rawDb = dbService!.getConnection();
      const row = rawDb.prepare('SELECT * FROM ocr_results WHERE id = ?').get(ocr.id);
      expect(row).toBeDefined();
    });

    it.skipIf(!sqliteVecAvailable)('throws FOREIGN_KEY_VIOLATION if document_id invalid', () => {
      const ocrProv = createTestProvenance({ type: ProvenanceType.OCR_RESULT });
      dbService!.insertProvenance(ocrProv);

      const ocr = createTestOCRResult('invalid-doc-id', ocrProv.id);

      expect(() => {
        dbService!.insertOCRResult(ocr);
      }).toThrow(DatabaseError);

      try {
        dbService!.insertOCRResult(ocr);
      } catch (error) {
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
      }
    });
  });

  describe('getOCRResult()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID', () => {
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

      const retrieved = dbService!.getOCRResult(ocr.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.extracted_text).toBe(ocr.extracted_text);
      expect(retrieved!.datalab_mode).toBe(ocr.datalab_mode);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService!.getOCRResult('nonexistent-ocr-id');
      expect(result).toBeNull();
    });
  });

  describe('getOCRResultByDocumentId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by document_id', () => {
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

      const retrieved = dbService!.getOCRResultByDocumentId(doc.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(ocr.id);
    });
  });

  describe('json_blocks and extras_json', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and retrieves with json_blocks and extras_json', () => {
      const docProv = createTestProvenance();
      dbService!.insertProvenance(docProv);
      const doc = createTestDocument(docProv.id);
      dbService!.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService!.insertProvenance(ocrProv);

      const blocksJson = JSON.stringify({ children: [{ type: 'Text' }] });
      const extrasJson = JSON.stringify({ metadata: { title: 'Test' } });

      const ocr = createTestOCRResult(doc.id, ocrProv.id, {
        json_blocks: blocksJson,
        extras_json: extrasJson,
      });
      dbService!.insertOCRResult(ocr);

      const retrieved = dbService!.getOCRResult(ocr.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.json_blocks).toBe(blocksJson);
      expect(retrieved!.extras_json).toBe(extrasJson);
    });

    it.skipIf(!sqliteVecAvailable)('defaults to null when not provided', () => {
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

      const retrieved = dbService!.getOCRResult(ocr.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.json_blocks).toBeNull();
      expect(retrieved!.extras_json).toBeNull();
    });
  });
});
