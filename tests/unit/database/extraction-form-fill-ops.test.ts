/**
 * Extraction and Form Fill Operations Tests
 *
 * Tests the new database operations for extractions and form fills
 * introduced in schema v8. Uses REAL databases (better-sqlite3 temp files),
 * NO mocks.
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

describe('Extraction and Form Fill Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeEach(() => {
    testDir = createTestDir('db-ext-ff-ops-');
    dbService = createFreshDatabase(testDir, 'test-ext-ff');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
    cleanupTestDir(testDir);
  });

  /**
   * Helper: create a full document chain (provenance -> document -> ocr provenance -> ocr_result)
   * Returns IDs needed by extraction and form fill tests.
   */
  function createDocumentChain(): {
    docId: string;
    docProvId: string;
    ocrId: string;
    ocrProvId: string;
  } {
    const docProv = createTestProvenance();
    dbService!.insertProvenance(docProv);

    const doc = createTestDocument(docProv.id, { status: 'complete' });
    dbService!.insertDocument(doc);

    // OCR provenance
    const ocrProvId = uuidv4();
    dbService!.insertProvenance({
      id: ocrProvId,
      type: ProvenanceType.OCR_RESULT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'OCR' as const,
      source_path: null,
      source_id: docProv.id,
      root_document_id: docProv.id,
      location: null,
      content_hash: computeHash('ocr-' + ocrProvId),
      input_hash: null,
      file_hash: null,
      processor: 'datalab-marker',
      processor_version: '1.0.0',
      processing_params: { mode: 'balanced' },
      processing_duration_ms: 1000,
      processing_quality_score: 4.5,
      parent_id: docProv.id,
      parent_ids: JSON.stringify([docProv.id]),
      chain_depth: 1,
      chain_path: null,
    });

    const ocrResult = createTestOCRResult(doc.id, ocrProvId);
    dbService!.insertOCRResult(ocrResult);

    return { docId: doc.id, docProvId: docProv.id, ocrId: ocrResult.id, ocrProvId };
  }

  /**
   * Helper: create an EXTRACTION provenance record
   */
  function createExtractionProvenance(rootDocProvId: string, parentProvId: string): string {
    const provId = uuidv4();
    dbService!.insertProvenance({
      id: provId,
      type: ProvenanceType.EXTRACTION,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EXTRACTION' as const,
      source_path: null,
      source_id: parentProvId,
      root_document_id: rootDocProvId,
      location: null,
      content_hash: computeHash('ext-' + provId),
      input_hash: null,
      file_hash: null,
      processor: 'datalab-extract',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 500,
      processing_quality_score: null,
      parent_id: parentProvId,
      parent_ids: JSON.stringify([rootDocProvId, parentProvId]),
      chain_depth: 2,
      chain_path: null,
    });
    return provId;
  }

  /**
   * Helper: create a FORM_FILL provenance record
   */
  function createFormFillProvenance(): string {
    const provId = uuidv4();
    dbService!.insertProvenance({
      id: provId,
      type: ProvenanceType.FORM_FILL,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FORM_FILL' as const,
      source_path: '/form.pdf',
      source_id: null,
      root_document_id: provId,
      location: null,
      content_hash: computeHash('ff-' + provId),
      input_hash: null,
      file_hash: null,
      processor: 'datalab-fill',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 800,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: null,
    });
    return provId;
  }

  describe('Extraction operations', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and retrieves extraction', () => {
      const { docId, docProvId, ocrId, ocrProvId } = createDocumentChain();
      const extProvId = createExtractionProvenance(docProvId, ocrProvId);

      const extId = uuidv4();
      dbService!.insertExtraction({
        id: extId,
        document_id: docId,
        ocr_result_id: ocrId,
        schema_json: '{"title": "string", "author": "string"}',
        extraction_json: '{"title": "Test Document", "author": "John Doe"}',
        content_hash: computeHash('extraction-data-' + extId),
        provenance_id: extProvId,
        created_at: new Date().toISOString(),
      });

      const results = dbService!.getExtractionsByDocument(docId);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(extId);
      expect(results[0].document_id).toBe(docId);
      expect(results[0].ocr_result_id).toBe(ocrId);
      expect(results[0].schema_json).toBe('{"title": "string", "author": "string"}');
      expect(results[0].extraction_json).toBe('{"title": "Test Document", "author": "John Doe"}');
      expect(results[0].provenance_id).toBe(extProvId);
    });

    it.skipIf(!sqliteVecAvailable)(
      'retrieves multiple extractions ordered by created_at DESC',
      () => {
        const { docId, docProvId, ocrId, ocrProvId } = createDocumentChain();

        // Insert 3 extractions with different timestamps
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const extProvId = createExtractionProvenance(docProvId, ocrProvId);
          const extId = uuidv4();
          ids.push(extId);
          // Small delay to ensure different created_at values
          const created = new Date(Date.now() + i * 1000).toISOString();
          dbService!.insertExtraction({
            id: extId,
            document_id: docId,
            ocr_result_id: ocrId,
            schema_json: `{"index": ${String(i)}}`,
            extraction_json: `{"value": ${String(i)}}`,
            content_hash: computeHash('ext-' + extId),
            provenance_id: extProvId,
            created_at: created,
          });
        }

        const results = dbService!.getExtractionsByDocument(docId);
        expect(results.length).toBe(3);
        // Most recent first (DESC order)
        expect(results[0].id).toBe(ids[2]);
        expect(results[2].id).toBe(ids[0]);
      }
    );

    it.skipIf(!sqliteVecAvailable)('returns empty array for document with no extractions', () => {
      const { docId } = createDocumentChain();
      const results = dbService!.getExtractionsByDocument(docId);
      expect(results).toEqual([]);
    });

    it.skipIf(!sqliteVecAvailable)(
      'extractions are removed when parent document is deleted',
      () => {
        const { docId, docProvId, ocrId, ocrProvId } = createDocumentChain();

        // Insert 2 extractions
        for (let i = 0; i < 2; i++) {
          const extProvId = createExtractionProvenance(docProvId, ocrProvId);
          dbService!.insertExtraction({
            id: uuidv4(),
            document_id: docId,
            ocr_result_id: ocrId,
            schema_json: '{}',
            extraction_json: '{}',
            content_hash: computeHash('del-ext-' + String(i)),
            provenance_id: extProvId,
            created_at: new Date().toISOString(),
          });
        }

        expect(dbService!.getExtractionsByDocument(docId).length).toBe(2);

        // Deleting the document cascades to extractions via deleteDerivedRecords
        dbService!.deleteDocument(docId);
        expect(dbService!.getExtractionsByDocument(docId).length).toBe(0);
      }
    );
  });

  describe('Form fill operations', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and retrieves form fill by ID', () => {
      const ffProvId = createFormFillProvenance();
      const ffId = uuidv4();
      const now = new Date().toISOString();

      dbService!.insertFormFill({
        id: ffId,
        source_file_path: '/forms/application.pdf',
        source_file_hash: computeHash('form-file-content'),
        field_data_json: '{"name": {"value": "John Doe"}, "email": {"value": "john@example.com"}}',
        context: 'Employment application form',
        confidence_threshold: 0.7,
        output_file_path: '/output/filled-application.pdf',
        output_base64: null,
        fields_filled: '["name", "email"]',
        fields_not_found: '["phone"]',
        page_count: 3,
        cost_cents: 10,
        status: 'complete',
        error_message: null,
        provenance_id: ffProvId,
        created_at: now,
      });

      const ff = dbService!.getFormFill(ffId);
      expect(ff).not.toBeNull();
      expect(ff!.id).toBe(ffId);
      expect(ff!.source_file_path).toBe('/forms/application.pdf');
      expect(ff!.field_data_json).toBe(
        '{"name": {"value": "John Doe"}, "email": {"value": "john@example.com"}}'
      );
      expect(ff!.context).toBe('Employment application form');
      expect(ff!.confidence_threshold).toBe(0.7);
      expect(ff!.status).toBe('complete');
      expect(ff!.fields_filled).toBe('["name", "email"]');
      expect(ff!.fields_not_found).toBe('["phone"]');
      expect(ff!.page_count).toBe(3);
      expect(ff!.cost_cents).toBe(10);
    });

    it.skipIf(!sqliteVecAvailable)('returns null for non-existent form fill', () => {
      const ff = dbService!.getFormFill('nonexistent-id');
      expect(ff).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('lists all form fills', () => {
      // Create 3 form fills with different statuses
      for (const status of ['complete', 'failed', 'pending'] as const) {
        const provId = createFormFillProvenance();
        dbService!.insertFormFill({
          id: uuidv4(),
          source_file_path: `/forms/${status}.pdf`,
          source_file_hash: computeHash('form-' + status),
          field_data_json: '{}',
          context: null,
          confidence_threshold: 0.5,
          output_file_path: null,
          output_base64: null,
          fields_filled: '[]',
          fields_not_found: '[]',
          page_count: null,
          cost_cents: null,
          status,
          error_message: status === 'failed' ? 'API error' : null,
          provenance_id: provId,
          created_at: new Date().toISOString(),
        });
      }

      const all = dbService!.listFormFills();
      expect(all.length).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('filters form fills by status', () => {
      for (const status of ['complete', 'failed', 'complete'] as const) {
        const provId = createFormFillProvenance();
        dbService!.insertFormFill({
          id: uuidv4(),
          source_file_path: '/forms/test.pdf',
          source_file_hash: computeHash('form-filter-' + uuidv4()),
          field_data_json: '{}',
          context: null,
          confidence_threshold: 0.5,
          output_file_path: null,
          output_base64: null,
          fields_filled: '[]',
          fields_not_found: '[]',
          page_count: null,
          cost_cents: null,
          status,
          error_message: status === 'failed' ? 'err' : null,
          provenance_id: provId,
          created_at: new Date().toISOString(),
        });
      }

      const completed = dbService!.listFormFills({ status: 'complete' });
      expect(completed.length).toBe(2);
      for (const ff of completed) {
        expect(ff.status).toBe('complete');
      }

      const failed = dbService!.listFormFills({ status: 'failed' });
      expect(failed.length).toBe(1);
      expect(failed[0].status).toBe('failed');
    });

    it.skipIf(!sqliteVecAvailable)('inserts form fill with each valid status', () => {
      for (const status of ['pending', 'processing', 'complete', 'failed'] as const) {
        const provId = createFormFillProvenance();
        const ffId = uuidv4();
        dbService!.insertFormFill({
          id: ffId,
          source_file_path: `/forms/status-${status}.pdf`,
          source_file_hash: computeHash('form-status-' + status),
          field_data_json: '{}',
          context: null,
          confidence_threshold: 0.5,
          output_file_path: null,
          output_base64: null,
          fields_filled: '[]',
          fields_not_found: '[]',
          page_count: null,
          cost_cents: null,
          status,
          error_message: status === 'failed' ? 'test error' : null,
          provenance_id: provId,
          created_at: new Date().toISOString(),
        });

        const ff = dbService!.getFormFill(ffId);
        expect(ff!.status).toBe(status);
        if (status === 'failed') {
          expect(ff!.error_message).toBe('test error');
        }
      }
    });

    it.skipIf(!sqliteVecAvailable)('deletes form fill', () => {
      const provId = createFormFillProvenance();
      const ffId = uuidv4();
      dbService!.insertFormFill({
        id: ffId,
        source_file_path: '/forms/delete-test.pdf',
        source_file_hash: computeHash('form-delete'),
        field_data_json: '{}',
        context: null,
        confidence_threshold: 0.5,
        output_file_path: null,
        output_base64: null,
        fields_filled: '[]',
        fields_not_found: '[]',
        page_count: null,
        cost_cents: null,
        status: 'complete',
        error_message: null,
        provenance_id: provId,
        created_at: new Date().toISOString(),
      });

      expect(dbService!.deleteFormFill(ffId)).toBe(true);
      expect(dbService!.getFormFill(ffId)).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('deleteFormFill returns false for non-existent ID', () => {
      expect(dbService!.deleteFormFill('nonexistent')).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('form fill with null optional fields', () => {
      const provId = createFormFillProvenance();
      const ffId = uuidv4();
      dbService!.insertFormFill({
        id: ffId,
        source_file_path: '/forms/minimal.pdf',
        source_file_hash: computeHash('form-minimal'),
        field_data_json: '{"field1": {"value": "test"}}',
        context: null,
        confidence_threshold: 0.5,
        output_file_path: null,
        output_base64: null,
        fields_filled: '["field1"]',
        fields_not_found: '[]',
        page_count: null,
        cost_cents: null,
        status: 'complete',
        error_message: null,
        provenance_id: provId,
        created_at: new Date().toISOString(),
      });

      const ff = dbService!.getFormFill(ffId);
      expect(ff!.context).toBeNull();
      expect(ff!.output_file_path).toBeNull();
      expect(ff!.output_base64).toBeNull();
      expect(ff!.page_count).toBeNull();
      expect(ff!.cost_cents).toBeNull();
      expect(ff!.error_message).toBeNull();
    });
  });

  describe('Document metadata update', () => {
    it.skipIf(!sqliteVecAvailable)('updates doc_title, doc_author, doc_subject', () => {
      const { docId } = createDocumentChain();

      dbService!.updateDocumentMetadata(docId, {
        docTitle: 'Annual Report 2025',
        docAuthor: 'Finance Department',
        docSubject: 'Q4 Financial Summary',
      });

      const doc = dbService!.getDocument(docId);
      expect(doc).not.toBeNull();
      expect(doc!.doc_title).toBe('Annual Report 2025');
      expect(doc!.doc_author).toBe('Finance Department');
      expect(doc!.doc_subject).toBe('Q4 Financial Summary');
    });

    it.skipIf(!sqliteVecAvailable)(
      'uses COALESCE to preserve existing values when updating partially',
      () => {
        const { docId } = createDocumentChain();

        // Set title first
        dbService!.updateDocumentMetadata(docId, { docTitle: 'Original Title' });
        let doc = dbService!.getDocument(docId);
        expect(doc!.doc_title).toBe('Original Title');
        expect(doc!.doc_author).toBeNull();

        // Set author -- title should be preserved
        dbService!.updateDocumentMetadata(docId, { docAuthor: 'Author Name' });
        doc = dbService!.getDocument(docId);
        expect(doc!.doc_title).toBe('Original Title');
        expect(doc!.doc_author).toBe('Author Name');
      }
    );

    it.skipIf(!sqliteVecAvailable)('metadata defaults to null for new documents', () => {
      const { docId } = createDocumentChain();
      const doc = dbService!.getDocument(docId);
      expect(doc!.doc_title).toBeNull();
      expect(doc!.doc_author).toBeNull();
      expect(doc!.doc_subject).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('updates only specified metadata fields', () => {
      const { docId } = createDocumentChain();

      dbService!.updateDocumentMetadata(docId, { docSubject: 'Test Subject' });

      const doc = dbService!.getDocument(docId);
      expect(doc!.doc_title).toBeNull();
      expect(doc!.doc_author).toBeNull();
      expect(doc!.doc_subject).toBe('Test Subject');
    });
  });
});
