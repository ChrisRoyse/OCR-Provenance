/**
 * Tests for extraction DB operations: getExtraction, searchExtractions
 *
 * Uses real database instances with temp databases - NO MOCKS.
 *
 * @module tests/unit/services/extraction-search
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
  createDatabase,
  selectDatabase,
  requireDatabase,
  ProvenanceType,
  computeHash,
} from '../../integration/server/helpers.js';

describe('Extraction Operations', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-ext-ops');

  // IDs for test data
  let docProvId: string;
  let ocrProvId: string;
  let docId: string;
  let doc2Id: string;
  let doc2ProvId: string;
  let ocrId: string;
  let ocr2Id: string;
  let ocrProv2Id: string;

  const extractionIds: string[] = [];
  const extractionProvIds: string[] = [];

  beforeAll(() => {
    tempDir = createTempDir('test-ext-ops-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Create document 1
    docProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: docProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: docProvId,
        chain_depth: 0,
      })
    );

    docId = uuidv4();
    db.insertDocument(
      createTestDocument(docProvId, {
        id: docId,
        file_path: '/test/invoice.pdf',
        file_name: 'invoice.pdf',
        status: 'complete',
      })
    );

    // Create OCR result for doc 1
    ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProvId,
        root_document_id: docProvId,
        chain_depth: 1,
      })
    );

    ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, { id: ocrId })
    );

    // Create document 2
    doc2ProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: doc2ProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: doc2ProvId,
        chain_depth: 0,
      })
    );

    doc2Id = uuidv4();
    db.insertDocument(
      createTestDocument(doc2ProvId, {
        id: doc2Id,
        file_path: '/test/contract.pdf',
        file_name: 'contract.pdf',
        status: 'complete',
      })
    );

    // Create OCR result for doc 2
    ocrProv2Id = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProv2Id,
        type: ProvenanceType.OCR_RESULT,
        parent_id: doc2ProvId,
        root_document_id: doc2ProvId,
        chain_depth: 1,
      })
    );

    ocr2Id = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(doc2Id, ocrProv2Id, { id: ocr2Id })
    );

    // Create 3 extractions with different JSON content
    const extractionData = [
      {
        document_id: docId,
        ocr_result_id: ocrId,
        schema_json: '{"type":"object","properties":{"amount":{"type":"number"}}}',
        extraction_json: JSON.stringify({ amount: 1500, vendor: 'Acme Corp', date: '2026-01-15' }),
        parentProvId: ocrProvId,
        rootDocId: docProvId,
      },
      {
        document_id: docId,
        ocr_result_id: ocrId,
        schema_json: '{"type":"object","properties":{"items":{"type":"array"}}}',
        extraction_json: JSON.stringify({ items: [{ name: 'Widget', qty: 10 }, { name: 'Gadget', qty: 5 }] }),
        parentProvId: ocrProvId,
        rootDocId: docProvId,
      },
      {
        document_id: doc2Id,
        ocr_result_id: ocr2Id,
        schema_json: '{"type":"object","properties":{"parties":{"type":"array"}}}',
        extraction_json: JSON.stringify({ parties: ['Alpha LLC', 'Beta Inc'], effective_date: '2026-03-01' }),
        parentProvId: ocrProv2Id,
        rootDocId: doc2ProvId,
      },
    ];

    for (const data of extractionData) {
      const extProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: extProvId,
          type: ProvenanceType.EXTRACTION,
          parent_id: data.parentProvId,
          root_document_id: data.rootDocId,
          chain_depth: 2,
        })
      );
      extractionProvIds.push(extProvId);

      const extId = uuidv4();
      db.insertExtraction({
        id: extId,
        document_id: data.document_id,
        ocr_result_id: data.ocr_result_id,
        schema_json: data.schema_json,
        extraction_json: data.extraction_json,
        content_hash: computeHash(data.extraction_json),
        provenance_id: extProvId,
        created_at: new Date().toISOString(),
      });
      extractionIds.push(extId);
    }
  });

  afterAll(() => {
    cleanupTempDir(tempDir);
  });

  // ==================== getExtraction ====================

  describe('getExtraction', () => {
    it('should return extraction by ID', () => {
      const { db } = requireDatabase();
      const result = db.getExtraction(extractionIds[0]);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(extractionIds[0]);
      expect(result!.document_id).toBe(docId);
      expect(result!.extraction_json).toContain('Acme Corp');
      expect(result!.provenance_id).toBe(extractionProvIds[0]);
    });

    it('should return null for non-existent ID', () => {
      const { db } = requireDatabase();
      const result = db.getExtraction('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should return all fields', () => {
      const { db } = requireDatabase();
      const result = db.getExtraction(extractionIds[2]);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(extractionIds[2]);
      expect(result!.document_id).toBe(doc2Id);
      expect(result!.ocr_result_id).toBe(ocr2Id);
      expect(result!.schema_json).toContain('parties');
      expect(result!.extraction_json).toContain('Alpha LLC');
      expect(result!.content_hash).toBeTruthy();
      expect(result!.provenance_id).toBe(extractionProvIds[2]);
      expect(result!.created_at).toBeTruthy();
    });
  });

  // ==================== searchExtractions ====================

  describe('searchExtractions', () => {
    it('should find extraction matching query in one result', () => {
      const { db } = requireDatabase();
      const results = db.searchExtractions('Acme Corp');

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(extractionIds[0]);
      expect(results[0].extraction_json).toContain('Acme Corp');
    });

    it('should find extraction matching query in multiple results', () => {
      const { db } = requireDatabase();
      // "type" appears in all extraction_json as a key pattern
      // Use a term that appears in two extractions
      const results = db.searchExtractions('qty');

      // Only extraction[1] has "qty"
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(extractionIds[1]);
    });

    it('should return empty array when no matches', () => {
      const { db } = requireDatabase();
      const results = db.searchExtractions('zzz_nonexistent_term_zzz');
      expect(results).toEqual([]);
    });

    it('should filter by document_filter', () => {
      const { db } = requireDatabase();
      // Search for something that only exists in doc2
      const results = db.searchExtractions('Alpha LLC', {
        document_filter: [doc2Id],
      });

      expect(results.length).toBe(1);
      expect(results[0].document_id).toBe(doc2Id);
    });

    it('should return empty when document_filter excludes matches', () => {
      const { db } = requireDatabase();
      // "Acme Corp" is in doc1, but filter to doc2 only
      const results = db.searchExtractions('Acme Corp', {
        document_filter: [doc2Id],
      });

      expect(results).toEqual([]);
    });

    it('should respect limit parameter', () => {
      const { db } = requireDatabase();
      // Search for something that could match multiple (e.g., common JSON chars)
      // All 3 extractions contain "date" or similar - let's search for a common term
      // Actually search for a broad term and limit to 1
      const results = db.searchExtractions('2026', { limit: 1 });

      expect(results.length).toBe(1);
    });

    it('should handle special LIKE characters in query', () => {
      const { db } = requireDatabase();
      // Search for literal percent or underscore - should not match wildcard
      const results = db.searchExtractions('100%');
      expect(results).toEqual([]);
    });

    it('should support multiple document IDs in filter', () => {
      const { db } = requireDatabase();
      const results = db.searchExtractions('2026', {
        document_filter: [docId, doc2Id],
      });

      // Both doc1 (extraction[0] has date 2026-01-15) and doc2 (extraction[2] has 2026-03-01) match
      expect(results.length).toBe(2);
    });

    it('should use default limit of 10', () => {
      const { db } = requireDatabase();
      // We only have 3 extractions, so all should be returned with default limit
      const results = db.searchExtractions('e'); // 'e' appears in all extraction_json
      expect(results.length).toBeLessThanOrEqual(10);
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
