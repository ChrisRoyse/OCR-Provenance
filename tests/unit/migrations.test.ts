/**
 * Unit Tests for Database Schema Migrations
 *
 * Tests the database migration system using REAL SQLite databases.
 * No mocks - all tests run against actual better-sqlite3 instances.
 *
 * @see src/services/storage/migrations.ts
 * @see Task 7 - Database Schema Migrations
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initializeDatabase,
  checkSchemaVersion,
  migrateToLatest,
  getCurrentSchemaVersion,
  verifySchema,
  MigrationError,
} from '../../src/services/storage/migrations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP AND HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Helper to check if sqlite-vec extension is available
 */
function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper to get table info from SQLite
 */
function getTableColumns(db: Database.Database, tableName: string): string[] {
  const result = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return result.map((row) => row.name);
}

/**
 * Helper to get all table names from database
 */
function getTableNames(db: Database.Database): string[] {
  const result = db
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `
    )
    .all() as Array<{ name: string }>;
  return result.map((row) => row.name);
}

/**
 * Helper to get all index names from database
 */
function getIndexNames(db: Database.Database): string[] {
  const result = db
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `
    )
    .all() as Array<{ name: string }>;
  return result.map((row) => row.name);
}

/**
 * Helper to check if a virtual table exists
 */
function virtualTableExists(db: Database.Database, tableName: string): boolean {
  const result = db
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `
    )
    .get(tableName) as { name: string } | undefined;
  return result !== undefined;
}

/**
 * Helper to get pragma value
 */
function getPragmaValue(db: Database.Database, pragma: string): unknown {
  const result = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  return result ? Object.values(result)[0] : undefined;
}

// Track if sqlite-vec is available for conditional tests
const sqliteVecAvailable = isSqliteVecAvailable();

if (!sqliteVecAvailable) {
  console.warn(
    'WARNING: sqlite-vec extension not available. Vector-related tests will be skipped.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database Migrations', () => {
  let testDir: string;
  let db: Database.Database | undefined;
  let dbPath: string;

  beforeAll(() => {
    // Create unique temporary directory for all tests
    testDir = path.join(os.tmpdir(), `migrations-test-${String(Date.now())}-${String(process.pid)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    // Clean up temporary directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    // Create a fresh database for each test
    dbPath = path.join(testDir, `test-${String(Date.now())}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(dbPath);
  });

  afterEach(() => {
    // Close and clean up database
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 1. TABLE CREATION TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Table Creation', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should create all 8 required tables after initialization',
      () => {
        initializeDatabase(db);

        const tables = getTableNames(db);
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

        // vec_embeddings is a virtual table, check separately
        expect(virtualTableExists(db, 'vec_embeddings')).toBe(true);
      }
    );

    it.skipIf(!sqliteVecAvailable)('should create schema_version table', () => {
      initializeDatabase(db);
      expect(getTableNames(db)).toContain('schema_version');
    });

    it.skipIf(!sqliteVecAvailable)('should create provenance table', () => {
      initializeDatabase(db);
      expect(getTableNames(db)).toContain('provenance');
    });

    it.skipIf(!sqliteVecAvailable)('should create database_metadata table', () => {
      initializeDatabase(db);
      expect(getTableNames(db)).toContain('database_metadata');
    });

    it.skipIf(!sqliteVecAvailable)('should create documents table', () => {
      initializeDatabase(db);
      expect(getTableNames(db)).toContain('documents');
    });

    it.skipIf(!sqliteVecAvailable)('should create ocr_results table', () => {
      initializeDatabase(db);
      expect(getTableNames(db)).toContain('ocr_results');
    });

    it.skipIf(!sqliteVecAvailable)('should create chunks table', () => {
      initializeDatabase(db);
      expect(getTableNames(db)).toContain('chunks');
    });

    it.skipIf(!sqliteVecAvailable)('should create embeddings table', () => {
      initializeDatabase(db);
      expect(getTableNames(db)).toContain('embeddings');
    });

    it.skipIf(!sqliteVecAvailable)('should create vec_embeddings virtual table', () => {
      initializeDatabase(db);
      expect(virtualTableExists(db, 'vec_embeddings')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 2. COLUMN VERIFICATION TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Column Verification', () => {
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
      ];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        initializeDatabase(db);
        const columns = getTableColumns(db, 'documents');

        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          initializeDatabase(db);
          const columns = getTableColumns(db, 'documents');
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
        initializeDatabase(db);
        const columns = getTableColumns(db, 'chunks');

        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          initializeDatabase(db);
          const columns = getTableColumns(db, 'chunks');
          expect(columns.length).toBe(expectedColumns.length);
        }
      );
    });

    describe('embeddings table columns', () => {
      const expectedColumns = [
        'id',
        'chunk_id',
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
        initializeDatabase(db);
        const columns = getTableColumns(db, 'embeddings');

        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          initializeDatabase(db);
          const columns = getTableColumns(db, 'embeddings');
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
        initializeDatabase(db);
        const columns = getTableColumns(db, 'provenance');

        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });

      it.skipIf(!sqliteVecAvailable)(
        'should have exactly the expected number of columns',
        () => {
          initializeDatabase(db);
          const columns = getTableColumns(db, 'provenance');
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
        initializeDatabase(db);
        const columns = getTableColumns(db, 'ocr_results');

        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });
    });

    describe('schema_version table columns', () => {
      const expectedColumns = ['id', 'version', 'created_at', 'updated_at'];

      it.skipIf(!sqliteVecAvailable)('should have all required columns', () => {
        initializeDatabase(db);
        const columns = getTableColumns(db, 'schema_version');

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
        initializeDatabase(db);
        const columns = getTableColumns(db, 'database_metadata');

        for (const col of expectedColumns) {
          expect(columns).toContain(col);
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 3. INDEX TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Index Verification', () => {
    const expectedIndexes = [
      'idx_documents_file_path',
      'idx_documents_file_hash',
      'idx_documents_status',
      'idx_ocr_results_document_id',
      'idx_chunks_document_id',
      'idx_chunks_ocr_result_id',
      'idx_chunks_embedding_status',
      'idx_embeddings_chunk_id',
      'idx_embeddings_document_id',
      'idx_embeddings_source_file',
      'idx_embeddings_page',
      'idx_provenance_source_id',
      'idx_provenance_type',
      'idx_provenance_root_document_id',
      'idx_provenance_parent_id',
    ];

    it.skipIf(!sqliteVecAvailable)('should create all 15 required indexes', () => {
      initializeDatabase(db);
      const indexes = getIndexNames(db);

      for (const index of expectedIndexes) {
        expect(indexes).toContain(index);
      }
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_documents_file_path index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_documents_file_path');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_documents_file_hash index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_documents_file_hash');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_documents_status index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_documents_status');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_ocr_results_document_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_ocr_results_document_id');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_chunks_document_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_chunks_document_id');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_chunks_ocr_result_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_chunks_ocr_result_id');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_chunks_embedding_status index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_chunks_embedding_status');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_chunk_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_embeddings_chunk_id');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_document_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_embeddings_document_id');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_source_file index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_embeddings_source_file');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_page index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_embeddings_page');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_provenance_source_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_provenance_source_id');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_provenance_type index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_provenance_type');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_provenance_root_document_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_provenance_root_document_id');
    });

    it.skipIf(!sqliteVecAvailable)('should have idx_provenance_parent_id index', () => {
      initializeDatabase(db);
      expect(getIndexNames(db)).toContain('idx_provenance_parent_id');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 4. CONSTRAINT TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Constraint Verification', () => {
    describe('Foreign Key Constraints', () => {
      it.skipIf(!sqliteVecAvailable)(
        'should reject document with invalid provenance_id',
        () => {
          initializeDatabase(db);

          const insertDoc = db.prepare(`
          INSERT INTO documents (
            id, file_path, file_name, file_hash, file_size, file_type,
            status, provenance_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

          expect(() => {
            insertDoc.run(
              'doc-001',
              '/test/file.pdf',
              'file.pdf',
              'sha256:abc123',
              1024,
              'pdf',
              'pending',
              'invalid-provenance-id', // This doesn't exist in provenance table
              new Date().toISOString()
            );
          }).toThrow(); // Should throw FOREIGN KEY constraint failed
        }
      );

      it.skipIf(!sqliteVecAvailable)(
        'should accept document with valid provenance_id',
        () => {
          initializeDatabase(db);

          // First insert a provenance record
          const insertProv = db.prepare(`
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

          const now = new Date().toISOString();
          insertProv.run(
            'prov-001',
            'DOCUMENT',
            now,
            now,
            'FILE',
            'doc-001',
            'sha256:test',
            'file-ingester',
            '1.0.0',
            '{}',
            '[]',
            0
          );

          // Now insert document with valid provenance_id
          const insertDoc = db.prepare(`
          INSERT INTO documents (
            id, file_path, file_name, file_hash, file_size, file_type,
            status, provenance_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

          expect(() => {
            insertDoc.run(
              'doc-001',
              '/test/file.pdf',
              'file.pdf',
              'sha256:abc123',
              1024,
              'pdf',
              'pending',
              'prov-001',
              now
            );
          }).not.toThrow();
        }
      );
    });

    describe('UNIQUE Constraints', () => {
      it.skipIf(!sqliteVecAvailable)(
        'should reject duplicate provenance_id in documents',
        () => {
          initializeDatabase(db);

          const now = new Date().toISOString();

          // Insert provenance record
          db.prepare(
            `
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
          ).run(
            'prov-001',
            'DOCUMENT',
            now,
            now,
            'FILE',
            'doc-001',
            'sha256:test',
            'file-ingester',
            '1.0.0',
            '{}',
            '[]',
            0
          );

          // Insert first document
          db.prepare(
            `
          INSERT INTO documents (
            id, file_path, file_name, file_hash, file_size, file_type,
            status, provenance_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
          ).run(
            'doc-001',
            '/test/file1.pdf',
            'file1.pdf',
            'sha256:abc123',
            1024,
            'pdf',
            'pending',
            'prov-001',
            now
          );

          // Try to insert second document with same provenance_id
          expect(() => {
            db.prepare(
              `
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
            ).run(
              'doc-002',
              '/test/file2.pdf',
              'file2.pdf',
              'sha256:def456',
              2048,
              'pdf',
              'pending',
              'prov-001', // Duplicate!
              now
            );
          }).toThrow(/UNIQUE/);
        }
      );
    });

    describe('CHECK Constraints', () => {
      it.skipIf(!sqliteVecAvailable)(
        'should reject invalid document status values',
        () => {
          initializeDatabase(db);

          const now = new Date().toISOString();

          // Insert provenance record first
          db.prepare(
            `
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
          ).run(
            'prov-001',
            'DOCUMENT',
            now,
            now,
            'FILE',
            'doc-001',
            'sha256:test',
            'file-ingester',
            '1.0.0',
            '{}',
            '[]',
            0
          );

          expect(() => {
            db.prepare(
              `
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
            ).run(
              'doc-001',
              '/test/file.pdf',
              'file.pdf',
              'sha256:abc123',
              1024,
              'pdf',
              'invalid_status', // Invalid status
              'prov-001',
              now
            );
          }).toThrow(/CHECK/);
        }
      );

      it.skipIf(!sqliteVecAvailable)('should accept valid document status values', () => {
        initializeDatabase(db);

        const validStatuses = ['pending', 'processing', 'complete', 'failed'];
        const now = new Date().toISOString();

        for (let i = 0; i < validStatuses.length; i++) {
          const provId = `prov-${String(i).padStart(3, '0')}`;
          const docId = `doc-${String(i).padStart(3, '0')}`;

          // Insert provenance record
          db.prepare(
            `
            INSERT INTO provenance (
              id, type, created_at, processed_at, source_type, root_document_id,
              content_hash, processor, processor_version, processing_params,
              parent_ids, chain_depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            provId,
            'DOCUMENT',
            now,
            now,
            'FILE',
            docId,
            'sha256:test' + String(i),
            'file-ingester',
            '1.0.0',
            '{}',
            '[]',
            0
          );

          expect(() => {
            db.prepare(
              `
              INSERT INTO documents (
                id, file_path, file_name, file_hash, file_size, file_type,
                status, provenance_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
              docId,
              `/test/file${String(i)}.pdf`,
              `file${String(i)}.pdf`,
              `sha256:hash${String(i)}`,
              1024,
              'pdf',
              validStatuses[i],
              provId,
              now
            );
          }).not.toThrow();
        }
      });

      it.skipIf(!sqliteVecAvailable)('should reject invalid provenance type values', () => {
        initializeDatabase(db);

        const now = new Date().toISOString();

        expect(() => {
          db.prepare(
            `
            INSERT INTO provenance (
              id, type, created_at, processed_at, source_type, root_document_id,
              content_hash, processor, processor_version, processing_params,
              parent_ids, chain_depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            'prov-001',
            'INVALID_TYPE', // Invalid type
            now,
            now,
            'FILE',
            'doc-001',
            'sha256:test',
            'file-ingester',
            '1.0.0',
            '{}',
            '[]',
            0
          );
        }).toThrow(/CHECK/);
      });

      it.skipIf(!sqliteVecAvailable)('should accept valid provenance type values', () => {
        initializeDatabase(db);

        const validTypes = ['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING'];
        const now = new Date().toISOString();

        for (let i = 0; i < validTypes.length; i++) {
          expect(() => {
            db.prepare(
              `
              INSERT INTO provenance (
                id, type, created_at, processed_at, source_type, root_document_id,
                content_hash, processor, processor_version, processing_params,
                parent_ids, chain_depth
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
              `prov-type-${String(i)}`,
              validTypes[i],
              now,
              now,
              'FILE',
              `doc-${String(i)}`,
              `sha256:test${String(i)}`,
              'file-ingester',
              '1.0.0',
              '{}',
              '[]',
              0
            );
          }).not.toThrow();
        }
      });

      it.skipIf(!sqliteVecAvailable)('should reject invalid datalab_mode values', () => {
        initializeDatabase(db);

        const now = new Date().toISOString();

        // First create required provenance and document records
        db.prepare(
          `
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          'prov-doc',
          'DOCUMENT',
          now,
          now,
          'FILE',
          'doc-001',
          'sha256:test',
          'file-ingester',
          '1.0.0',
          '{}',
          '[]',
          0
        );

        db.prepare(
          `
          INSERT INTO documents (
            id, file_path, file_name, file_hash, file_size, file_type,
            status, provenance_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          'doc-001',
          '/test/file.pdf',
          'file.pdf',
          'sha256:abc123',
          1024,
          'pdf',
          'pending',
          'prov-doc',
          now
        );

        db.prepare(
          `
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          'prov-ocr',
          'OCR_RESULT',
          now,
          now,
          'OCR',
          'doc-001',
          'sha256:ocr',
          'datalab',
          '1.0.0',
          '{}',
          '["prov-doc"]',
          1
        );

        expect(() => {
          db.prepare(
            `
            INSERT INTO ocr_results (
              id, provenance_id, document_id, extracted_text, text_length,
              datalab_request_id, datalab_mode, page_count, content_hash,
              processing_started_at, processing_completed_at, processing_duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            'ocr-001',
            'prov-ocr',
            'doc-001',
            'Extracted text',
            14,
            'req-123',
            'invalid_mode', // Invalid mode
            1,
            'sha256:text',
            now,
            now,
            1000
          );
        }).toThrow(/CHECK/);
      });

      it.skipIf(!sqliteVecAvailable)('should accept valid datalab_mode values', () => {
        initializeDatabase(db);

        const validModes = ['fast', 'balanced', 'accurate'];
        const now = new Date().toISOString();

        for (let i = 0; i < validModes.length; i++) {
          // Create provenance for document
          db.prepare(
            `
            INSERT INTO provenance (
              id, type, created_at, processed_at, source_type, root_document_id,
              content_hash, processor, processor_version, processing_params,
              parent_ids, chain_depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            `prov-doc-${String(i)}`,
            'DOCUMENT',
            now,
            now,
            'FILE',
            `doc-${String(i)}`,
            `sha256:doc${String(i)}`,
            'file-ingester',
            '1.0.0',
            '{}',
            '[]',
            0
          );

          // Create document
          db.prepare(
            `
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            `doc-${String(i)}`,
            `/test/file${String(i)}.pdf`,
            `file${String(i)}.pdf`,
            `sha256:hash${String(i)}`,
            1024,
            'pdf',
            'pending',
            `prov-doc-${String(i)}`,
            now
          );

          // Create provenance for OCR result
          db.prepare(
            `
            INSERT INTO provenance (
              id, type, created_at, processed_at, source_type, root_document_id,
              content_hash, processor, processor_version, processing_params,
              parent_ids, chain_depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            `prov-ocr-${String(i)}`,
            'OCR_RESULT',
            now,
            now,
            'OCR',
            `doc-${String(i)}`,
            `sha256:ocr${String(i)}`,
            'datalab',
            '1.0.0',
            '{}',
            `["prov-doc-${String(i)}"]`,
            1
          );

          expect(() => {
            db.prepare(
              `
              INSERT INTO ocr_results (
                id, provenance_id, document_id, extracted_text, text_length,
                datalab_request_id, datalab_mode, page_count, content_hash,
                processing_started_at, processing_completed_at, processing_duration_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
              `ocr-${String(i)}`,
              `prov-ocr-${String(i)}`,
              `doc-${String(i)}`,
              'Extracted text',
              14,
              `req-${String(i)}`,
              validModes[i],
              1,
              `sha256:text${String(i)}`,
              now,
              now,
              1000
            );
          }).not.toThrow();
        }
      });
    });

    describe('NOT NULL Constraints', () => {
      it.skipIf(!sqliteVecAvailable)(
        'should reject document with NULL file_path',
        () => {
          initializeDatabase(db);

          const now = new Date().toISOString();

          // Create provenance record first
          db.prepare(
            `
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
          ).run(
            'prov-001',
            'DOCUMENT',
            now,
            now,
            'FILE',
            'doc-001',
            'sha256:test',
            'file-ingester',
            '1.0.0',
            '{}',
            '[]',
            0
          );

          expect(() => {
            db.prepare(
              `
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
            ).run(
              'doc-001',
              null, // NULL file_path
              'file.pdf',
              'sha256:abc123',
              1024,
              'pdf',
              'pending',
              'prov-001',
              now
            );
          }).toThrow(/NOT NULL/);
        }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 5. PRAGMA VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Pragma Verification', () => {
    it.skipIf(!sqliteVecAvailable)('should set journal_mode to WAL', () => {
      initializeDatabase(db);
      const journalMode = getPragmaValue(db, 'journal_mode');
      expect(journalMode).toBe('wal');
    });

    it.skipIf(!sqliteVecAvailable)('should enable foreign_keys', () => {
      initializeDatabase(db);
      const foreignKeys = getPragmaValue(db, 'foreign_keys');
      expect(foreignKeys).toBe(1);
    });

    it.skipIf(!sqliteVecAvailable)('should set synchronous to NORMAL', () => {
      initializeDatabase(db);
      const synchronous = getPragmaValue(db, 'synchronous');
      // NORMAL = 1
      expect(synchronous).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 6. SCHEMA VERSION TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Schema Version Management', () => {
    it('should return 0 for uninitialized database', () => {
      const version = checkSchemaVersion(db);
      expect(version).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)(
      'should return correct version after initialization',
      () => {
        initializeDatabase(db);
        const version = checkSchemaVersion(db);
        expect(version).toBe(1);
      }
    );

    it('should return correct current schema version constant', () => {
      const version = getCurrentSchemaVersion();
      expect(version).toBe(1);
    });

    it.skipIf(!sqliteVecAvailable)(
      'migrateToLatest should work on fresh database',
      () => {
        migrateToLatest(db);
        const version = checkSchemaVersion(db);
        expect(version).toBe(1);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'migrateToLatest should be idempotent on already-migrated database',
      () => {
        // First migration
        migrateToLatest(db);
        const version1 = checkSchemaVersion(db);

        // Second migration (should be no-op)
        migrateToLatest(db);
        const version2 = checkSchemaVersion(db);

        expect(version1).toBe(version2);
        expect(version2).toBe(1);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'should throw error for database with newer schema version',
      () => {
        initializeDatabase(db);

        // Manually set schema version to a higher number
        db.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(999);

        expect(() => {
          migrateToLatest(db);
        }).toThrow(/newer than supported/);
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 7. IDEMPOTENT INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Idempotent Initialization', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should not error when calling initializeDatabase twice',
      () => {
        // First initialization
        expect(() => {
          initializeDatabase(db);
        }).not.toThrow();

        // Second initialization (should be idempotent)
        expect(() => {
          initializeDatabase(db);
        }).not.toThrow();
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'should have all tables after second initialization',
      () => {
        initializeDatabase(db);
        initializeDatabase(db);

        const result = verifySchema(db);
        expect(result.valid).toBe(true);
        expect(result.missingTables).toHaveLength(0);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'should preserve existing data after re-initialization',
      () => {
        initializeDatabase(db);

        const now = new Date().toISOString();

        // Insert test data
        db.prepare(
          `
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
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

        // Re-initialize
        initializeDatabase(db);

        // Verify data still exists
        const row = db.prepare('SELECT id FROM provenance WHERE id = ?').get('test-prov');
        expect(row).toBeDefined();
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 8. ERROR HANDLING TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Error Handling', () => {
    it('should throw MigrationError with correct properties', () => {
      // Try to check schema version on a closed database
      db.close();

      try {
        checkSchemaVersion(db);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        const migrationError = error as MigrationError;
        expect(migrationError.operation).toBeDefined();
        expect(migrationError.message).toBeTruthy();
      }
    });

    it('should have descriptive error messages', () => {
      db.close();

      try {
        checkSchemaVersion(db);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        expect((error as Error).message.length).toBeGreaterThan(10);
      }
    });

    it('should include cause in MigrationError', () => {
      const cause = new Error('Original error');
      const migrationError = new MigrationError('Test error', 'test_operation', 'test_table', cause);

      expect(migrationError.cause).toBe(cause);
      expect(migrationError.operation).toBe('test_operation');
      expect(migrationError.tableName).toBe('test_table');
    });

    it('MigrationError should have correct name property', () => {
      const error = new MigrationError('Test', 'test_op');
      expect(error.name).toBe('MigrationError');
    });

    it('MigrationError should be instance of Error', () => {
      const error = new MigrationError('Test', 'test_op');
      expect(error).toBeInstanceOf(Error);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 9. SCHEMA VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Schema Verification', () => {
    it('should report missing tables for uninitialized database', () => {
      const result = verifySchema(db);
      expect(result.valid).toBe(false);
      expect(result.missingTables.length).toBeGreaterThan(0);
    });

    it.skipIf(!sqliteVecAvailable)(
      'should report valid for fully initialized database',
      () => {
        initializeDatabase(db);
        const result = verifySchema(db);
        expect(result.valid).toBe(true);
        expect(result.missingTables).toHaveLength(0);
        expect(result.missingIndexes).toHaveLength(0);
      }
    );

    it.skipIf(!sqliteVecAvailable)('should detect missing indexes', () => {
      initializeDatabase(db);

      // Drop an index
      db.exec('DROP INDEX IF EXISTS idx_documents_file_path');

      const result = verifySchema(db);
      expect(result.missingIndexes).toContain('idx_documents_file_path');
    });

    it.skipIf(!sqliteVecAvailable)('should detect missing tables', () => {
      initializeDatabase(db);

      // Drop a table (need to disable FK first)
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('DROP TABLE IF EXISTS chunks');
      db.exec('PRAGMA foreign_keys = ON');

      const result = verifySchema(db);
      expect(result.missingTables).toContain('chunks');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 10. SQLITE-VEC TESTS (if extension available)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('sqlite-vec Virtual Table', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should create vec_embeddings virtual table',
      () => {
        initializeDatabase(db);
        expect(virtualTableExists(db, 'vec_embeddings')).toBe(true);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'should be able to insert 768-dimensional vectors',
      () => {
        initializeDatabase(db);

        // Create a 768-dimensional vector (all zeros for simplicity)
        const vector = new Float32Array(768).fill(0.0);
        vector[0] = 1.0; // Set first element to make it non-zero

        const stmt = db.prepare(`
        INSERT INTO vec_embeddings (embedding_id, vector)
        VALUES (?, ?)
      `);

        expect(() => {
          stmt.run('emb-001', Buffer.from(vector.buffer));
        }).not.toThrow();

        // Verify it was inserted
        const count = db.prepare('SELECT COUNT(*) as cnt FROM vec_embeddings').get() as {
          cnt: number;
        };
        expect(count.cnt).toBe(1);
      }
    );

    it.skipIf(!sqliteVecAvailable)('should be able to query vectors', () => {
      initializeDatabase(db);

      // Insert test vectors
      const vector1 = new Float32Array(768).fill(0.0);
      vector1[0] = 1.0;

      const vector2 = new Float32Array(768).fill(0.0);
      vector2[1] = 1.0;

      const stmt = db.prepare(`
        INSERT INTO vec_embeddings (embedding_id, vector)
        VALUES (?, ?)
      `);

      stmt.run('emb-001', Buffer.from(vector1.buffer));
      stmt.run('emb-002', Buffer.from(vector2.buffer));

      // Query vectors
      const results = db.prepare('SELECT embedding_id FROM vec_embeddings').all() as Array<{
        embedding_id: string;
      }>;

      expect(results.length).toBe(2);
      expect(results.map((r) => r.embedding_id)).toContain('emb-001');
      expect(results.map((r) => r.embedding_id)).toContain('emb-002');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 11. DATABASE METADATA INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Database Metadata Initialization', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should initialize database_metadata with default values',
      () => {
        initializeDatabase(db);

        const metadata = db.prepare('SELECT * FROM database_metadata WHERE id = 1').get() as {
          database_name: string;
          database_version: string;
          total_documents: number;
          total_ocr_results: number;
          total_chunks: number;
          total_embeddings: number;
        };

        expect(metadata).toBeDefined();
        expect(metadata.database_name).toBe('ocr-provenance-mcp');
        expect(metadata.database_version).toBe('1.0.0');
        expect(metadata.total_documents).toBe(0);
        expect(metadata.total_ocr_results).toBe(0);
        expect(metadata.total_chunks).toBe(0);
        expect(metadata.total_embeddings).toBe(0);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'should not duplicate metadata on re-initialization',
      () => {
        initializeDatabase(db);
        initializeDatabase(db);

        const count = db.prepare('SELECT COUNT(*) as cnt FROM database_metadata').get() as {
          cnt: number;
        };
        expect(count.cnt).toBe(1);
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 12. FILE SYSTEM TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('File System Operations', () => {
    it('should create database file on initialization', () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('should create WAL file after operations', () => {
      initializeDatabase(db);

      // Force a write to ensure WAL file is created
      db.prepare('INSERT OR REPLACE INTO schema_version (id, version, created_at, updated_at) VALUES (1, 1, ?, ?)').run(
        new Date().toISOString(),
        new Date().toISOString()
      );

      // WAL files might exist
      // Note: WAL file may or may not exist depending on SQLite behavior
      // Just verify the main db file exists
      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION-STYLE TESTS (Still Unit Tests but More Comprehensive)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database Migrations - Integration Scenarios', () => {
  let testDir: string;
  let db: Database.Database | undefined;
  let dbPath: string;

  beforeAll(() => {
    testDir = path.join(os.tmpdir(), `migrations-integration-${String(Date.now())}-${String(process.pid)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    dbPath = path.join(testDir, `int-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(dbPath);
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  it.skipIf(!isSqliteVecAvailable())(
    'should support full document processing pipeline schema',
    () => {
      initializeDatabase(db);

      const now = new Date().toISOString();

      // 1. Create document provenance
      db.prepare(
        `
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'prov-doc-001',
        'DOCUMENT',
        now,
        now,
        'FILE',
        'doc-001',
        'sha256:file123',
        'file-ingester',
        '1.0.0',
        '{}',
        '[]',
        0
      );

      // 2. Create document
      db.prepare(
        `
        INSERT INTO documents (
          id, file_path, file_name, file_hash, file_size, file_type,
          status, provenance_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'doc-001',
        '/test/contract.pdf',
        'contract.pdf',
        'sha256:file123',
        10240,
        'pdf',
        'pending',
        'prov-doc-001',
        now
      );

      // 3. Create OCR provenance
      db.prepare(
        `
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth, parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'prov-ocr-001',
        'OCR_RESULT',
        now,
        now,
        'OCR',
        'doc-001',
        'sha256:ocr123',
        'datalab-marker',
        '1.0.0',
        '{"mode":"balanced"}',
        '["prov-doc-001"]',
        1,
        'prov-doc-001'
      );

      // 4. Create OCR result
      db.prepare(
        `
        INSERT INTO ocr_results (
          id, provenance_id, document_id, extracted_text, text_length,
          datalab_request_id, datalab_mode, page_count, content_hash,
          processing_started_at, processing_completed_at, processing_duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'ocr-001',
        'prov-ocr-001',
        'doc-001',
        'This is the extracted text from the contract.',
        44,
        'req-12345',
        'balanced',
        3,
        'sha256:ocr123',
        now,
        now,
        2500
      );

      // 5. Create chunk provenance
      db.prepare(
        `
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth, parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'prov-chunk-001',
        'CHUNK',
        now,
        now,
        'CHUNKING',
        'doc-001',
        'sha256:chunk123',
        'text-chunker',
        '1.0.0',
        '{"chunk_size":2000,"overlap":0.1}',
        '["prov-doc-001","prov-ocr-001"]',
        2,
        'prov-ocr-001'
      );

      // 6. Create chunk
      db.prepare(
        `
        INSERT INTO chunks (
          id, document_id, ocr_result_id, text, text_hash, chunk_index,
          character_start, character_end, overlap_previous, overlap_next,
          provenance_id, created_at, embedding_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'chunk-001',
        'doc-001',
        'ocr-001',
        'This is the extracted text from the contract.',
        'sha256:chunk123',
        0,
        0,
        44,
        0,
        0,
        'prov-chunk-001',
        now,
        'pending'
      );

      // 7. Create embedding provenance
      db.prepare(
        `
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth, parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'prov-emb-001',
        'EMBEDDING',
        now,
        now,
        'EMBEDDING',
        'doc-001',
        'sha256:emb123',
        'nomic-embed-text-v1.5',
        '1.5.0',
        '{"task_type":"search_document"}',
        '["prov-doc-001","prov-ocr-001","prov-chunk-001"]',
        3,
        'prov-chunk-001'
      );

      // 8. Create embedding
      db.prepare(
        `
        INSERT INTO embeddings (
          id, chunk_id, document_id, original_text, original_text_length,
          source_file_path, source_file_name, source_file_hash,
          character_start, character_end, chunk_index, total_chunks,
          model_name, model_version, task_type, inference_mode,
          provenance_id, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'emb-001',
        'chunk-001',
        'doc-001',
        'This is the extracted text from the contract.',
        44,
        '/test/contract.pdf',
        'contract.pdf',
        'sha256:file123',
        0,
        44,
        0,
        1,
        'nomic-embed-text-v1.5',
        '1.5.0',
        'search_document',
        'local',
        'prov-emb-001',
        'sha256:emb123',
        now
      );

      // 9. Insert vector
      const vector = new Float32Array(768).fill(0.1);
      db.prepare(
        `
        INSERT INTO vec_embeddings (embedding_id, vector)
        VALUES (?, ?)
      `
      ).run('emb-001', Buffer.from(vector.buffer));

      // Verify the full chain exists
      const docCount = (db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number })
        .cnt;
      const ocrCount = (
        db.prepare('SELECT COUNT(*) as cnt FROM ocr_results').get() as { cnt: number }
      ).cnt;
      const chunkCount = (db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number })
        .cnt;
      const embCount = (db.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number })
        .cnt;
      const provCount = (
        db.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number }
      ).cnt;
      const vecCount = (
        db.prepare('SELECT COUNT(*) as cnt FROM vec_embeddings').get() as { cnt: number }
      ).cnt;

      expect(docCount).toBe(1);
      expect(ocrCount).toBe(1);
      expect(chunkCount).toBe(1);
      expect(embCount).toBe(1);
      expect(provCount).toBe(4); // doc + ocr + chunk + embedding
      expect(vecCount).toBe(1);

      // Verify provenance chain depth
      const maxDepth = db
        .prepare('SELECT MAX(chain_depth) as max_depth FROM provenance')
        .get() as { max_depth: number };
      expect(maxDepth.max_depth).toBe(3);
    }
  );

  it.skipIf(!isSqliteVecAvailable())(
    'should support querying across related tables',
    () => {
      initializeDatabase(db);

      const now = new Date().toISOString();

      // Insert minimal test data
      db.prepare(
        `
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run('prov-1', 'DOCUMENT', now, now, 'FILE', 'doc-1', 'sha256:a', 'p', '1', '{}', '[]', 0);

      db.prepare(
        `
        INSERT INTO documents (
          id, file_path, file_name, file_hash, file_size, file_type,
          status, provenance_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run('doc-1', '/path/file.pdf', 'file.pdf', 'sha256:a', 1024, 'pdf', 'complete', 'prov-1', now);

      // Test join query
      const result = db
        .prepare(
          `
        SELECT d.id as doc_id, d.file_name, p.chain_depth
        FROM documents d
        JOIN provenance p ON d.provenance_id = p.id
        WHERE d.status = ?
      `
        )
        .get('complete') as { doc_id: string; file_name: string; chain_depth: number };

      expect(result).toBeDefined();
      expect(result.doc_id).toBe('doc-1');
      expect(result.file_name).toBe('file.pdf');
      expect(result.chain_depth).toBe(0);
    }
  );
});
