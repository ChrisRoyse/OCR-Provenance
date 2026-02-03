/**
 * Schema Version Management Tests for Database Migrations
 *
 * Tests schema version tracking, migration, and version validation.
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
  checkSchemaVersion,
  migrateToLatest,
  getCurrentSchemaVersion,
} from '../../../src/services/storage/migrations.js';

describe('Schema Version Management', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-schema-version');
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

  it('should return 0 for uninitialized database', () => {
    const version = checkSchemaVersion(ctx.db);
    expect(version).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)(
    'should return correct version after initialization',
    () => {
      initializeDatabase(ctx.db);
      const version = checkSchemaVersion(ctx.db);
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
      migrateToLatest(ctx.db);
      const version = checkSchemaVersion(ctx.db);
      expect(version).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'migrateToLatest should be idempotent on already-migrated database',
    () => {
      // First migration
      migrateToLatest(ctx.db);
      const version1 = checkSchemaVersion(ctx.db);

      // Second migration (should be no-op)
      migrateToLatest(ctx.db);
      const version2 = checkSchemaVersion(ctx.db);

      expect(version1).toBe(version2);
      expect(version2).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should throw error for database with newer schema version',
    () => {
      initializeDatabase(ctx.db);

      // Manually set schema version to a higher number
      ctx.db!.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(999);

      expect(() => {
        migrateToLatest(ctx.db);
      }).toThrow(/newer than supported/);
    }
  );
});
