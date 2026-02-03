/**
 * Table Creation Tests for Database Migrations
 *
 * Tests that all required tables are created during database initialization.
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
  virtualTableExists,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('Table Creation', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-table-creation');
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
    'should create all 8 required tables after initialization',
    () => {
      initializeDatabase(ctx.db);

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

      // vec_embeddings is a virtual table, check separately
      expect(virtualTableExists(ctx.db!, 'vec_embeddings')).toBe(true);
    }
  );

  it.skipIf(!sqliteVecAvailable)('should create schema_version table', () => {
    initializeDatabase(ctx.db);
    expect(getTableNames(ctx.db!)).toContain('schema_version');
  });

  it.skipIf(!sqliteVecAvailable)('should create provenance table', () => {
    initializeDatabase(ctx.db);
    expect(getTableNames(ctx.db!)).toContain('provenance');
  });

  it.skipIf(!sqliteVecAvailable)('should create database_metadata table', () => {
    initializeDatabase(ctx.db);
    expect(getTableNames(ctx.db!)).toContain('database_metadata');
  });

  it.skipIf(!sqliteVecAvailable)('should create documents table', () => {
    initializeDatabase(ctx.db);
    expect(getTableNames(ctx.db!)).toContain('documents');
  });

  it.skipIf(!sqliteVecAvailable)('should create ocr_results table', () => {
    initializeDatabase(ctx.db);
    expect(getTableNames(ctx.db!)).toContain('ocr_results');
  });

  it.skipIf(!sqliteVecAvailable)('should create chunks table', () => {
    initializeDatabase(ctx.db);
    expect(getTableNames(ctx.db!)).toContain('chunks');
  });

  it.skipIf(!sqliteVecAvailable)('should create embeddings table', () => {
    initializeDatabase(ctx.db);
    expect(getTableNames(ctx.db!)).toContain('embeddings');
  });

  it.skipIf(!sqliteVecAvailable)('should create vec_embeddings virtual table', () => {
    initializeDatabase(ctx.db);
    expect(virtualTableExists(ctx.db!, 'vec_embeddings')).toBe(true);
  });
});
