/**
 * Column Verification Tests for Database Migrations
 *
 * Tests that all tables have the required columns with correct definitions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  getTableColumns,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('Column Verification', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-column-verification');
  });

  afterAll(() => {
    cleanupTestDir(ctx.testDir);
  });

  beforeEach(() => {
    const { db, dbPath } = createTestDb(ctx.testDir);
    ctx.db = db;
    ctx.dbPath = dbPath;
  });

  afterEach(() => {
    closeDb(ctx.db);
    ctx.db = undefined;
  });

  describe('documents table columns', () => {
    const expectedColumns = [
      'id',
      'file_path',
      'file_name',
      'file_hash',
      'file_size',
      'file_type',
      'status',
      'page_count',
      'provenance_id',
      'created_at',
      'modified_at',
      'ocr_completed_at',
      'error_message',
      'doc_title',
      'doc_author',
      'doc_subject',
    ];

    it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
      initializeDatabase(ctx.db);
      const columns = getTableColumns(ctx.db!, 'documents');

      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it.skipIf(!sqliteVecAvailable)(
      'should have exactly the expected number of columns',
      () => {
        initializeDatabase(ctx.db);
        const columns = getTableColumns(ctx.db!, 'documents');
        expect(columns.length).toBe(expectedColumns.length);
      }
    );
  });

  describe('chunks table columns', () => {
    const expectedColumns = [
      'id',
      'document_id',
      'ocr_result_id',
      'text',
      'text_hash',
      'chunk_index',
      'character_start',
      'character_end',
      'page_number',
      'page_range',
      'overlap_previous',
      'overlap_next',
      'provenance_id',
      'created_at',
      'embedding_status',
      'embedded_at',
    ];

    it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
      initializeDatabase(ctx.db);
      const columns = getTableColumns(ctx.db!, 'chunks');

      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it.skipIf(!sqliteVecAvailable)(
      'should have exactly the expected number of columns',
      () => {
        initializeDatabase(ctx.db);
        const columns = getTableColumns(ctx.db!, 'chunks');
        expect(columns.length).toBe(expectedColumns.length);
      }
    );
  });

  describe('embeddings table columns', () => {
    const expectedColumns = [
      'id',
      'chunk_id',
      'image_id',
      'extraction_id',
      'document_id',
      'original_text',
      'original_text_length',
      'source_file_path',
      'source_file_name',
      'source_file_hash',
      'page_number',
      'page_range',
      'character_start',
      'character_end',
      'chunk_index',
      'total_chunks',
      'model_name',
      'model_version',
      'task_type',
      'inference_mode',
      'gpu_device',
      'provenance_id',
      'content_hash',
      'created_at',
      'generation_duration_ms',
    ];

    it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
      initializeDatabase(ctx.db);
      const columns = getTableColumns(ctx.db!, 'embeddings');

      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it.skipIf(!sqliteVecAvailable)(
      'should have exactly the expected number of columns',
      () => {
        initializeDatabase(ctx.db);
        const columns = getTableColumns(ctx.db!, 'embeddings');
        expect(columns.length).toBe(expectedColumns.length);
      }
    );
  });

  describe('provenance table columns', () => {
    const expectedColumns = [
      'id',
      'type',
      'created_at',
      'processed_at',
      'source_file_created_at',
      'source_file_modified_at',
      'source_type',
      'source_path',
      'source_id',
      'root_document_id',
      'location',
      'content_hash',
      'input_hash',
      'file_hash',
      'processor',
      'processor_version',
      'processing_params',
      'processing_duration_ms',
      'processing_quality_score',
      'parent_id',
      'parent_ids',
      'chain_depth',
      'chain_path',
    ];

    it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
      initializeDatabase(ctx.db);
      const columns = getTableColumns(ctx.db!, 'provenance');

      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it.skipIf(!sqliteVecAvailable)(
      'should have exactly the expected number of columns',
      () => {
        initializeDatabase(ctx.db);
        const columns = getTableColumns(ctx.db!, 'provenance');
        expect(columns.length).toBe(expectedColumns.length);
      }
    );
  });

  describe('ocr_results table columns', () => {
    const expectedColumns = [
      'id',
      'provenance_id',
      'document_id',
      'extracted_text',
      'text_length',
      'datalab_request_id',
      'datalab_mode',
      'parse_quality_score',
      'page_count',
      'cost_cents',
      'content_hash',
      'processing_started_at',
      'processing_completed_at',
      'processing_duration_ms',
    ];

    it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
      initializeDatabase(ctx.db);
      const columns = getTableColumns(ctx.db!, 'ocr_results');

      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });
  });

  describe('schema_version table columns', () => {
    const expectedColumns = ['id', 'version', 'created_at', 'updated_at'];

    it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
      initializeDatabase(ctx.db);
      const columns = getTableColumns(ctx.db!, 'schema_version');

      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });
  });

  describe('database_metadata table columns', () => {
    const expectedColumns = [
      'id',
      'database_name',
      'database_version',
      'created_at',
      'last_modified_at',
      'total_documents',
      'total_ocr_results',
      'total_chunks',
      'total_embeddings',
    ];

    it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
      initializeDatabase(ctx.db);
      const columns = getTableColumns(ctx.db!, 'database_metadata');

      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });
  });
});
