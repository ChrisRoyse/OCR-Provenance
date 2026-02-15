/**
 * Consolidated Schema State Tests for Database Migrations
 *
 * Verifies the final schema state after initializeDatabase():
 * - Table creation (tables + virtual tables)
 * - Column definitions per table
 * - Index creation
 * - verifySchema() correctness (destructive tests use per-test DBs)
 *
 * Merged from: table-creation, column-verification, index-verification, schema-verification
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  getTableNames,
  getTableColumns,
  getIndexNames,
  virtualTableExists,
  getPragmaValue,
  TestContext,
} from './helpers.js';
import {
  initializeDatabase,
  verifySchema,
} from '../../../src/services/storage/migrations.js';

// ── Read-only tests sharing a single initialized DB ──────────────────────────

describe('Schema State (read-only)', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-schema-state');
    if (sqliteVecAvailable) {
      const { db, dbPath } = createTestDb(ctx.testDir);
      ctx.db = db;
      ctx.dbPath = dbPath;
      initializeDatabase(ctx.db);
    }
  });

  afterAll(() => {
    closeDb(ctx.db);
    cleanupTestDir(ctx.testDir);
  });

  // ── Table Creation ───────────────────────────────────────────────────────

  describe('Table Creation', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should create all required tables after initialization',
      () => {
        const tables = getTableNames(ctx.db!);
        const requiredTables = [
          'schema_version',
          'provenance',
          'database_metadata',
          'documents',
          'ocr_results',
          'chunks',
          'embeddings',
        ];

        for (const table of requiredTables) {
          expect(tables).toContain(table);
        }

        expect(virtualTableExists(ctx.db!, 'vec_embeddings')).toBe(true);
      }
    );

  });

  // ── Column Verification ──────────────────────────────────────────────────

  describe('Column Verification', () => {
    describe('documents table columns', () => {
      const expectedColumns = [
        'id', 'file_path', 'file_name', 'file_hash', 'file_size', 'file_type',
        'status', 'page_count', 'provenance_id', 'created_at', 'modified_at',
        'ocr_completed_at', 'error_message', 'doc_title', 'doc_author',
        'doc_subject', 'datalab_file_id',
      ];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        const columns = getTableColumns(ctx.db!, 'documents');
        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          const columns = getTableColumns(ctx.db!, 'documents');
          expect(columns.length).toBe(expectedColumns.length);
        }
      );
    });

    describe('chunks table columns', () => {
      const expectedColumns = [
        'id', 'document_id', 'ocr_result_id', 'text', 'text_hash', 'chunk_index',
        'character_start', 'character_end', 'page_number', 'page_range',
        'overlap_previous', 'overlap_next', 'provenance_id', 'created_at',
        'embedding_status', 'embedded_at', 'ocr_quality_score',
      ];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        const columns = getTableColumns(ctx.db!, 'chunks');
        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          const columns = getTableColumns(ctx.db!, 'chunks');
          expect(columns.length).toBe(expectedColumns.length);
        }
      );
    });

    describe('embeddings table columns', () => {
      const expectedColumns = [
        'id', 'chunk_id', 'image_id', 'extraction_id', 'document_id',
        'original_text', 'original_text_length', 'source_file_path',
        'source_file_name', 'source_file_hash', 'page_number', 'page_range',
        'character_start', 'character_end', 'chunk_index', 'total_chunks',
        'model_name', 'model_version', 'task_type', 'inference_mode',
        'gpu_device', 'provenance_id', 'content_hash', 'created_at',
        'generation_duration_ms',
      ];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        const columns = getTableColumns(ctx.db!, 'embeddings');
        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          const columns = getTableColumns(ctx.db!, 'embeddings');
          expect(columns.length).toBe(expectedColumns.length);
        }
      );
    });

    describe('provenance table columns', () => {
      const expectedColumns = [
        'id', 'type', 'created_at', 'processed_at', 'source_file_created_at',
        'source_file_modified_at', 'source_type', 'source_path', 'source_id',
        'root_document_id', 'location', 'content_hash', 'input_hash',
        'file_hash', 'processor', 'processor_version', 'processing_params',
        'processing_duration_ms', 'processing_quality_score', 'parent_id',
        'parent_ids', 'chain_depth', 'chain_path',
      ];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        const columns = getTableColumns(ctx.db!, 'provenance');
        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          const columns = getTableColumns(ctx.db!, 'provenance');
          expect(columns.length).toBe(expectedColumns.length);
        }
      );
    });

    describe('ocr_results table columns', () => {
      const expectedColumns = [
        'id', 'provenance_id', 'document_id', 'extracted_text', 'text_length',
        'datalab_request_id', 'datalab_mode', 'parse_quality_score', 'page_count',
        'cost_cents', 'content_hash', 'processing_started_at',
        'processing_completed_at', 'processing_duration_ms',
      ];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        const columns = getTableColumns(ctx.db!, 'ocr_results');
        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });
    });

    describe('schema_version table columns', () => {
      const expectedColumns = ['id', 'version', 'created_at', 'updated_at'];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        const columns = getTableColumns(ctx.db!, 'schema_version');
        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });
    });

    describe('database_metadata table columns', () => {
      const expectedColumns = [
        'id', 'database_name', 'database_version', 'created_at',
        'last_modified_at', 'total_documents', 'total_ocr_results',
        'total_chunks', 'total_embeddings',
      ];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        const columns = getTableColumns(ctx.db!, 'database_metadata');
        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });
    });
  });

  // ── Index Verification ───────────────────────────────────────────────────

  describe('Index Verification', () => {
    const expectedIndexes = [
      'idx_documents_file_path', 'idx_documents_file_hash', 'idx_documents_status',
      'idx_ocr_results_document_id',
      'idx_chunks_document_id', 'idx_chunks_ocr_result_id', 'idx_chunks_embedding_status',
      'idx_embeddings_chunk_id', 'idx_embeddings_image_id', 'idx_embeddings_document_id',
      'idx_embeddings_source_file', 'idx_embeddings_page',
      'idx_images_document_id', 'idx_images_ocr_result_id', 'idx_images_vlm_status',
      'idx_images_page', 'idx_images_pending', 'idx_images_provenance_id',
      'idx_images_content_hash',
      'idx_provenance_source_id', 'idx_provenance_type', 'idx_provenance_root_document_id',
      'idx_provenance_parent_id',
    ];

    it.skipIf(!sqliteVecAvailable)('should create all 23 required indexes', () => {
      const indexes = getIndexNames(ctx.db!);
      for (const index of expectedIndexes) {
        expect(indexes).toContain(index);
      }
    });

  });
});

// ── Schema Verification (destructive — needs fresh DB per test) ──────────────

describe('Schema Verification', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-schema-verify');
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

  it('should report missing tables for uninitialized database', () => {
    const result = verifySchema(ctx.db);
    expect(result.valid).toBe(false);
    expect(result.missingTables.length).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteVecAvailable)(
    'should report valid for fully initialized database',
    () => {
      initializeDatabase(ctx.db);
      const result = verifySchema(ctx.db);
      expect(result.valid).toBe(true);
      expect(result.missingTables).toHaveLength(0);
      expect(result.missingIndexes).toHaveLength(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)('should detect missing indexes', () => {
    initializeDatabase(ctx.db);
    ctx.db!.exec('DROP INDEX IF EXISTS idx_documents_file_path');
    const result = verifySchema(ctx.db);
    expect(result.missingIndexes).toContain('idx_documents_file_path');
  });

  it.skipIf(!sqliteVecAvailable)('should detect missing tables', () => {
    initializeDatabase(ctx.db);
    ctx.db!.exec('PRAGMA foreign_keys = OFF');
    ctx.db!.exec('DROP TABLE IF EXISTS chunks');
    ctx.db!.exec('PRAGMA foreign_keys = ON');
    const result = verifySchema(ctx.db);
    expect(result.missingTables).toContain('chunks');
  });

  // ── Idempotent Initialization ──────────────────────────────────────────

  it.skipIf(!sqliteVecAvailable)(
    'should not error when calling initializeDatabase twice',
    () => {
      expect(() => {
        initializeDatabase(ctx.db);
      }).not.toThrow();

      expect(() => {
        initializeDatabase(ctx.db);
      }).not.toThrow();
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should have all tables after second initialization',
    () => {
      initializeDatabase(ctx.db);
      initializeDatabase(ctx.db);

      const result = verifySchema(ctx.db);
      expect(result.valid).toBe(true);
      expect(result.missingTables).toHaveLength(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should preserve existing data after re-initialization',
    () => {
      initializeDatabase(ctx.db);

      const now = new Date().toISOString();

      ctx.db!.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'test-prov',
        'DOCUMENT',
        now,
        now,
        'FILE',
        'test-doc',
        'sha256:test',
        'test',
        '1.0.0',
        '{}',
        '[]',
        0
      );

      initializeDatabase(ctx.db);

      const row = ctx.db!.prepare('SELECT id FROM provenance WHERE id = ?').get('test-prov');
      expect(row).toBeDefined();
    }
  );
});
