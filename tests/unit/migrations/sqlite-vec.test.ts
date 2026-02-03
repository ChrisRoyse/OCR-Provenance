/**
 * sqlite-vec Virtual Table Tests for Database Migrations
 *
 * Tests the vec_embeddings virtual table for vector storage and search.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  virtualTableExists,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('sqlite-vec Virtual Table', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-sqlite-vec');
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
    'should create vec_embeddings virtual table',
    () => {
      initializeDatabase(ctx.db);
      expect(virtualTableExists(ctx.db!, 'vec_embeddings')).toBe(true);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'should be able to insert 768-dimensional vectors',
    () => {
      initializeDatabase(ctx.db);

      // Create a 768-dimensional vector (all zeros for simplicity)
      const vector = new Float32Array(768).fill(0.0);
      vector[0] = 1.0; // Set first element to make it non-zero

      const stmt = ctx.db!.prepare(`
        INSERT INTO vec_embeddings (embedding_id, vector)
        VALUES (?, ?)
      `);

      expect(() => {
        stmt.run('emb-001', Buffer.from(vector.buffer));
      }).not.toThrow();

      // Verify it was inserted
      const count = ctx.db!.prepare('SELECT COUNT(*) as cnt FROM vec_embeddings').get() as {
        cnt: number;
      };
      expect(count.cnt).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)('should be able to query vectors', () => {
    initializeDatabase(ctx.db);

    // Insert test vectors
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

    // Query vectors
    const results = ctx.db!.prepare('SELECT embedding_id FROM vec_embeddings').all() as Array<{
      embedding_id: string;
    }>;

    expect(results.length).toBe(2);
    expect(results.map((r) => r.embedding_id)).toContain('emb-001');
    expect(results.map((r) => r.embedding_id)).toContain('emb-002');
  });
});
