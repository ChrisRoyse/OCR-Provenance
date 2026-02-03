/**
 * Idempotent Initialization Tests for Database Migrations
 *
 * Tests that database initialization can be called multiple times safely.
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
import {
  initializeDatabase,
  verifySchema,
} from '../../../src/services/storage/migrations.js';

describe('Idempotent Initialization', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-idempotent');
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

  it.skipIf(!sqliteVecAvailable)(
    'should not error when calling initializeDatabase twice',
    () => {
      // First initialization
      expect(() => {
        initializeDatabase(ctx.db);
      }).not.toThrow();

      // Second initialization (should be idempotent)
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

      // Insert test data
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

      // Re-initialize
      initializeDatabase(ctx.db);

      // Verify data still exists
      const row = ctx.db!.prepare('SELECT id FROM provenance WHERE id = ?').get('test-prov');
      expect(row).toBeDefined();
    }
  );
});
