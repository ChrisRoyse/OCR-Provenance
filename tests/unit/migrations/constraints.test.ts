/**
 * Constraint Verification Tests for Database Migrations
 *
 * Tests foreign key, unique, check, and not null constraints.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  insertTestProvenance,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('Constraint Verification', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-constraints');
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

  describe('Foreign Key Constraints', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should reject document with invalid provenance_id',
      () => {
        initializeDatabase(ctx.db);

        const insertDoc = ctx.db!.prepare(`
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
            'invalid-provenance-id',
            new Date().toISOString()
          );
        }).toThrow();
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'should accept document with valid provenance_id',
      () => {
        initializeDatabase(ctx.db);
        insertTestProvenance(ctx.db!, 'prov-001', 'DOCUMENT', 'doc-001');

        const insertDoc = ctx.db!.prepare(`
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
            new Date().toISOString()
          );
        }).not.toThrow();
      }
    );
  });

  describe('UNIQUE Constraints', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should reject duplicate provenance_id in documents',
      () => {
        initializeDatabase(ctx.db);
        const now = new Date().toISOString();

        insertTestProvenance(ctx.db!, 'prov-001', 'DOCUMENT', 'doc-001');

        ctx.db!.prepare(`
          INSERT INTO documents (
            id, file_path, file_name, file_hash, file_size, file_type,
            status, provenance_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
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

        expect(() => {
          ctx.db!.prepare(`
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            'doc-002',
            '/test/file2.pdf',
            'file2.pdf',
            'sha256:def456',
            2048,
            'pdf',
            'pending',
            'prov-001',
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
        initializeDatabase(ctx.db);
        const now = new Date().toISOString();

        insertTestProvenance(ctx.db!, 'prov-001', 'DOCUMENT', 'doc-001');

        expect(() => {
          ctx.db!.prepare(`
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            'doc-001',
            '/test/file.pdf',
            'file.pdf',
            'sha256:abc123',
            1024,
            'pdf',
            'invalid_status',
            'prov-001',
            now
          );
        }).toThrow(/CHECK/);
      }
    );

    it.skipIf(!sqliteVecAvailable)('should accept valid document status values', () => {
      initializeDatabase(ctx.db);
      const validStatuses = ['pending', 'processing', 'complete', 'failed'];
      const now = new Date().toISOString();

      for (let i = 0; i < validStatuses.length; i++) {
        const provId = `prov-${String(i).padStart(3, '0')}`;
        const docId = `doc-${String(i).padStart(3, '0')}`;

        insertTestProvenance(ctx.db!, provId, 'DOCUMENT', docId);

        expect(() => {
          ctx.db!.prepare(`
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
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
      initializeDatabase(ctx.db);
      const now = new Date().toISOString();

      expect(() => {
        ctx.db!.prepare(`
          INSERT INTO provenance (
            id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params,
            parent_ids, chain_depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'prov-001',
          'INVALID_TYPE',
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
      initializeDatabase(ctx.db);
      const validTypes = ['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING'];
      const now = new Date().toISOString();

      for (let i = 0; i < validTypes.length; i++) {
        expect(() => {
          ctx.db!.prepare(`
            INSERT INTO provenance (
              id, type, created_at, processed_at, source_type, root_document_id,
              content_hash, processor, processor_version, processing_params,
              parent_ids, chain_depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
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
  });

  describe('OCR Constraints', () => {
    function setupDocumentForOcr(db: Database.Database, suffix: string = '') {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `prov-doc${suffix}`, 'DOCUMENT', now, now, 'FILE', `doc${suffix}`,
        `sha256:doc${suffix}`, 'file-ingester', '1.0.0', '{}', '[]', 0
      );
      db.prepare(`
        INSERT INTO documents (
          id, file_path, file_name, file_hash, file_size, file_type,
          status, provenance_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `doc${suffix}`, `/test/file${suffix}.pdf`, `file${suffix}.pdf`,
        `sha256:hash${suffix}`, 1024, 'pdf', 'pending', `prov-doc${suffix}`, now
      );
      db.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `prov-ocr${suffix}`, 'OCR_RESULT', now, now, 'OCR', `doc${suffix}`,
        `sha256:ocr${suffix}`, 'datalab', '1.0.0', '{}', `["prov-doc${suffix}"]`, 1
      );
      return now;
    }

    it.skipIf(!sqliteVecAvailable)('should reject invalid datalab_mode values', () => {
      initializeDatabase(ctx.db);
      const now = setupDocumentForOcr(ctx.db!);
      expect(() => {
        ctx.db!.prepare(`
          INSERT INTO ocr_results (
            id, provenance_id, document_id, extracted_text, text_length,
            datalab_request_id, datalab_mode, page_count, content_hash,
            processing_started_at, processing_completed_at, processing_duration_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('ocr-001', 'prov-ocr', 'doc', 'Extracted text', 14,
          'req-123', 'invalid_mode', 1, 'sha256:text', now, now, 1000);
      }).toThrow(/CHECK/);
    });

    it.skipIf(!sqliteVecAvailable)('should accept valid datalab_mode values', () => {
      initializeDatabase(ctx.db);
      const validModes = ['fast', 'balanced', 'accurate'];
      for (let i = 0; i < validModes.length; i++) {
        const suffix = `-${String(i)}`;
        const now = setupDocumentForOcr(ctx.db!, suffix);
        expect(() => {
          ctx.db!.prepare(`
            INSERT INTO ocr_results (
              id, provenance_id, document_id, extracted_text, text_length,
              datalab_request_id, datalab_mode, page_count, content_hash,
              processing_started_at, processing_completed_at, processing_duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(`ocr${suffix}`, `prov-ocr${suffix}`, `doc${suffix}`,
            'Extracted text', 14, `req-${String(i)}`, validModes[i],
            1, `sha256:text${String(i)}`, now, now, 1000);
        }).not.toThrow();
      }
    });
  });

  describe('NOT NULL Constraints', () => {
    it.skipIf(!sqliteVecAvailable)(
      'should reject document with NULL file_path',
      () => {
        initializeDatabase(ctx.db);
        const now = new Date().toISOString();

        insertTestProvenance(ctx.db!, 'prov-001', 'DOCUMENT', 'doc-001');

        expect(() => {
          ctx.db!.prepare(`
            INSERT INTO documents (
              id, file_path, file_name, file_hash, file_size, file_type,
              status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            'doc-001',
            null,
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
