/**
 * OCR-related Constraint Tests for Database Migrations
 *
 * Tests datalab_mode check constraints and OCR result validation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('OCR Constraints', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-ocr-constraints');
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

  /**
   * Helper to set up document and provenance for OCR tests
   */
  function setupDocumentForOcr(db: Database.Database, suffix: string = '') {
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `prov-doc${suffix}`,
      'DOCUMENT',
      now,
      now,
      'FILE',
      `doc${suffix}`,
      `sha256:doc${suffix}`,
      'file-ingester',
      '1.0.0',
      '{}',
      '[]',
      0
    );

    db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `doc${suffix}`,
      `/test/file${suffix}.pdf`,
      `file${suffix}.pdf`,
      `sha256:hash${suffix}`,
      1024,
      'pdf',
      'pending',
      `prov-doc${suffix}`,
      now
    );

    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `prov-ocr${suffix}`,
      'OCR_RESULT',
      now,
      now,
      'OCR',
      `doc${suffix}`,
      `sha256:ocr${suffix}`,
      'datalab',
      '1.0.0',
      '{}',
      `["prov-doc${suffix}"]`,
      1
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
      `).run(
        'ocr-001',
        'prov-ocr',
        'doc',
        'Extracted text',
        14,
        'req-123',
        'invalid_mode',
        1,
        'sha256:text',
        now,
        now,
        1000
      );
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
        `).run(
          `ocr${suffix}`,
          `prov-ocr${suffix}`,
          `doc${suffix}`,
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
