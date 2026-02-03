/**
 * Schema Verification Tests for Database Migrations
 *
 * Tests the verifySchema function for detecting missing tables and indexes.
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

describe('Schema Verification', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-schema-verification');
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

    // Drop an index
    ctx.db!.exec('DROP INDEX IF EXISTS idx_documents_file_path');

    const result = verifySchema(ctx.db);
    expect(result.missingIndexes).toContain('idx_documents_file_path');
  });

  it.skipIf(!sqliteVecAvailable)('should detect missing tables', () => {
    initializeDatabase(ctx.db);

    // Drop a table (need to disable FK first)
    ctx.db!.exec('PRAGMA foreign_keys = OFF');
    ctx.db!.exec('DROP TABLE IF EXISTS chunks');
    ctx.db!.exec('PRAGMA foreign_keys = ON');

    const result = verifySchema(ctx.db);
    expect(result.missingTables).toContain('chunks');
  });
});
