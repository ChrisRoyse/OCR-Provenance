/**
 * Pragma Verification Tests for Database Migrations
 *
 * Tests SQLite pragma settings after database initialization.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  getPragmaValue,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('Pragma Verification', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-pragma');
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

  it.skipIf(!sqliteVecAvailable)('should set journal_mode to WAL', () => {
    const journalMode = getPragmaValue(ctx.db!, 'journal_mode');
    expect(journalMode).toBe('wal');
  });

  it.skipIf(!sqliteVecAvailable)('should enable foreign_keys', () => {
    const foreignKeys = getPragmaValue(ctx.db!, 'foreign_keys');
    expect(foreignKeys).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('should set synchronous to NORMAL', () => {
    const synchronous = getPragmaValue(ctx.db!, 'synchronous');
    // NORMAL = 1
    expect(synchronous).toBe(1);
  });
});
