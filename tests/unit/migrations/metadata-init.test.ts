/**
 * Database Metadata Initialization Tests for Database Migrations
 *
 * Tests the database_metadata table initialization and defaults.
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

describe('Database Metadata Initialization', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-metadata');
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
    'should initialize database_metadata with default values',
    () => {
      initializeDatabase(ctx.db);

      const metadata = ctx.db!.prepare('SELECT * FROM database_metadata WHERE id = 1').get() as {
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
      initializeDatabase(ctx.db);
      initializeDatabase(ctx.db);

      const count = ctx.db!.prepare('SELECT COUNT(*) as cnt FROM database_metadata').get() as {
        cnt: number;
      };
      expect(count.cnt).toBe(1);
    }
  );
});
