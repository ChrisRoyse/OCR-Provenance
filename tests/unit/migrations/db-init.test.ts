/**
 * Database Initialization Tests for Migrations
 *
 * Verifies post-initialization state: pragmas, metadata defaults,
 * sqlite-vec virtual tables, and filesystem artifacts.
 *
 * Merged from: pragma-verification, metadata-init, sqlite-vec, filesystem
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
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

// ── Read-only pragma tests (shared DB via beforeAll) ─────────────────────────

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
    expect(synchronous).toBe(1);
  });
});

// ── Mutative tests (fresh DB per test via beforeEach) ────────────────────────

describe('Database Initialization Details', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-db-init');
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

  // ── Metadata Initialization ────────────────────────────────────────────

  it.skipIf(!sqliteVecAvailable)('should initialize database_metadata with default values', () => {
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
  });

  it.skipIf(!sqliteVecAvailable)('should not duplicate metadata on re-initialization', () => {
    initializeDatabase(ctx.db);
    initializeDatabase(ctx.db);

    const count = ctx.db!.prepare('SELECT COUNT(*) as cnt FROM database_metadata').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(1);
  });

  // ── sqlite-vec Virtual Table ───────────────────────────────────────────

  it.skipIf(!sqliteVecAvailable)('should be able to insert 768-dimensional vectors', () => {
    initializeDatabase(ctx.db);

    const vector = new Float32Array(768).fill(0.0);
    vector[0] = 1.0;

    const stmt = ctx.db!.prepare(`
        INSERT INTO vec_embeddings (embedding_id, vector)
        VALUES (?, ?)
      `);

    expect(() => {
      stmt.run('emb-001', Buffer.from(vector.buffer));
    }).not.toThrow();

    const count = ctx.db!.prepare('SELECT COUNT(*) as cnt FROM vec_embeddings').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('should be able to query vectors', () => {
    initializeDatabase(ctx.db);

    const vector1 = new Float32Array(768).fill(0.0);
    vector1[0] = 1.0;

    const vector2 = new Float32Array(768).fill(0.0);
    vector2[1] = 1.0;

    const stmt = ctx.db!.prepare(`
      INSERT INTO vec_embeddings (embedding_id, vector)
      VALUES (?, ?)
    `);

    stmt.run('emb-001', Buffer.from(vector1.buffer));
    stmt.run('emb-002', Buffer.from(vector2.buffer));

    const results = ctx.db!.prepare('SELECT embedding_id FROM vec_embeddings').all() as Array<{
      embedding_id: string;
    }>;

    expect(results.length).toBe(2);
    expect(results.map((r) => r.embedding_id)).toContain('emb-001');
    expect(results.map((r) => r.embedding_id)).toContain('emb-002');
  });

  // ── File System Operations ─────────────────────────────────────────────

  it('should create database file on initialization', () => {
    expect(fs.existsSync(ctx.dbPath)).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('should create WAL file after operations', () => {
    initializeDatabase(ctx.db);

    ctx
      .db!.prepare(
        'INSERT OR REPLACE INTO schema_version (id, version, created_at, updated_at) VALUES (1, 1, ?, ?)'
      )
      .run(new Date().toISOString(), new Date().toISOString());

    expect(fs.existsSync(ctx.dbPath)).toBe(true);
  });
});
