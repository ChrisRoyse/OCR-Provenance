/**
 * Pragma Verification Tests for Database Migrations
 *
 * Tests SQLite pragma settings after database initialization.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

  it.skipIf(!sqliteVecAvailable)('should set journal_mode to WAL', () => {
    initializeDatabase(ctx.db);
    const journalMode = getPragmaValue(ctx.db!, 'journal_mode');
    expect(journalMode).toBe('wal');
  });

  it.skipIf(!sqliteVecAvailable)('should enable foreign_keys', () => {
    initializeDatabase(ctx.db);
    const foreignKeys = getPragmaValue(ctx.db!, 'foreign_keys');
    expect(foreignKeys).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('should set synchronous to NORMAL', () => {
    initializeDatabase(ctx.db);
    const synchronous = getPragmaValue(ctx.db!, 'synchronous');
    // NORMAL = 1
    expect(synchronous).toBe(1);
  });
});
