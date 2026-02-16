/**
 * Migration v21 to v22 Tests
 *
 * Tests the v21->v22 migration which:
 * - Drops and recreates knowledge_nodes_fts with 'porter unicode61' tokenizer
 * - Standardizes trigger naming to _ai/_ad/_au convention
 * - Scopes update trigger to AFTER UPDATE OF canonical_name only
 *
 * Uses REAL databases (better-sqlite3 temp files), NO mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
} from '../unit/migrations/helpers.js';
import { migrateToLatest } from '../../src/services/storage/migrations/operations.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('Migration v21 to v22 (FTS Tokenizer/Trigger Fix)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v22');
    const result = createTestDb(tmpDir);
    db = result.db;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal v21 schema with the v18-style FTS (no porter tokenizer,
   * wrong trigger names, overly broad update trigger).
   */
  function createV21SchemaWithOldFTS(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_version VALUES (1, 21, datetime('now'), datetime('now'));
    `);

    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_type TEXT NOT NULL,
        root_document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        processor TEXT NOT NULL,
        processor_version TEXT NOT NULL,
        processing_params TEXT NOT NULL,
        parent_ids TEXT NOT NULL,
        chain_depth INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        aliases TEXT,
        document_count INTEGER NOT NULL DEFAULT 1,
        mention_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        avg_confidence REAL NOT NULL DEFAULT 0.0,
        metadata TEXT,
        provenance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        importance_score REAL,
        resolution_type TEXT
      )
    `);

    // v18-style FTS: NO porter tokenizer
    db.exec(
      `CREATE VIRTUAL TABLE knowledge_nodes_fts USING fts5(canonical_name, content='knowledge_nodes', content_rowid='rowid')`
    );

    // v18-style triggers: _insert/_delete/_update naming, broad update trigger
    db.exec(
      `CREATE TRIGGER knowledge_nodes_fts_insert AFTER INSERT ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`
    );
    db.exec(
      `CREATE TRIGGER knowledge_nodes_fts_delete AFTER DELETE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); END`
    );
    db.exec(
      `CREATE TRIGGER knowledge_nodes_fts_update AFTER UPDATE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`
    );
  }

  function getTriggerNames(database: Database.Database): string[] {
    return (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
  }

  function getFTSCreateSQL(database: Database.Database): string {
    const row = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'knowledge_nodes_fts' AND type = 'table'"
      )
      .get() as { sql: string } | undefined;
    return row?.sql ?? '';
  }

  it.skipIf(!sqliteVecAvailable)('migrates to schema version 22', () => {
    createV21SchemaWithOldFTS();
    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number })
      .version;
    expect(version).toBe(24);
  });

  it.skipIf(!sqliteVecAvailable)(
    'FTS table uses porter unicode61 tokenizer after migration',
    () => {
      createV21SchemaWithOldFTS();
      migrateToLatest(db);

      const sql = getFTSCreateSQL(db);
      expect(sql).toContain('porter unicode61');
    }
  );

  it.skipIf(!sqliteVecAvailable)('old trigger names (_insert/_delete/_update) are removed', () => {
    createV21SchemaWithOldFTS();
    migrateToLatest(db);

    const triggers = getTriggerNames(db);
    expect(triggers).not.toContain('knowledge_nodes_fts_insert');
    expect(triggers).not.toContain('knowledge_nodes_fts_delete');
    expect(triggers).not.toContain('knowledge_nodes_fts_update');
  });

  it.skipIf(!sqliteVecAvailable)('new trigger names (_ai/_ad/_au) exist', () => {
    createV21SchemaWithOldFTS();
    migrateToLatest(db);

    const triggers = getTriggerNames(db);
    expect(triggers).toContain('knowledge_nodes_fts_ai');
    expect(triggers).toContain('knowledge_nodes_fts_ad');
    expect(triggers).toContain('knowledge_nodes_fts_au');
  });

  it.skipIf(!sqliteVecAvailable)('update trigger scoped to canonical_name only', () => {
    createV21SchemaWithOldFTS();
    migrateToLatest(db);

    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'knowledge_nodes_fts_au' AND type = 'trigger'"
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toContain('UPDATE OF canonical_name');
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing FTS data after migration', () => {
    createV21SchemaWithOldFTS();

    // Insert test data
    db.prepare(
      `INSERT INTO provenance VALUES ('p1', 'KNOWLEDGE_GRAPH', datetime('now'), datetime('now'), 'KNOWLEDGE_GRAPH', 'doc1', 'hash1', 'test', '1.0', '{}', '[]', 2)`
    ).run();
    db.prepare(
      `INSERT INTO knowledge_nodes VALUES ('n1', 'person', 'John Smith', 'john smith', NULL, 1, 5, 2, 0.9, NULL, 'p1', datetime('now'), datetime('now'), NULL, NULL)`
    ).run();
    db.prepare(
      `INSERT INTO knowledge_nodes VALUES ('n2', 'organization', 'Acme Corp', 'acme corp', NULL, 2, 10, 3, 0.85, NULL, 'p1', datetime('now'), datetime('now'), NULL, NULL)`
    ).run();

    migrateToLatest(db);

    // FTS search should work with porter stemming
    const results = db
      .prepare(
        `SELECT canonical_name FROM knowledge_nodes WHERE rowid IN (SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?)`
      )
      .all('john') as Array<{ canonical_name: string }>;
    expect(results.length).toBe(1);
    expect(results[0].canonical_name).toBe('John Smith');
  });

  it.skipIf(!sqliteVecAvailable)(
    'porter stemming works after migration (organizations matches organization)',
    () => {
      createV21SchemaWithOldFTS();

      db.prepare(
        `INSERT INTO provenance VALUES ('p1', 'KNOWLEDGE_GRAPH', datetime('now'), datetime('now'), 'KNOWLEDGE_GRAPH', 'doc1', 'hash1', 'test', '1.0', '{}', '[]', 2)`
      ).run();
      db.prepare(
        `INSERT INTO knowledge_nodes VALUES ('n1', 'organization', 'Test Organization', 'test organization', NULL, 1, 1, 0, 0.8, NULL, 'p1', datetime('now'), datetime('now'), NULL, NULL)`
      ).run();

      migrateToLatest(db);

      // With porter stemming, "organizations" should match "organization"
      const results = db
        .prepare(
          `SELECT canonical_name FROM knowledge_nodes WHERE rowid IN (SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?)`
        )
        .all('organizations') as Array<{ canonical_name: string }>;
      expect(results.length).toBe(1);
      expect(results[0].canonical_name).toBe('Test Organization');
    }
  );

  it.skipIf(!sqliteVecAvailable)('insert trigger works after migration', () => {
    createV21SchemaWithOldFTS();
    migrateToLatest(db);

    db.prepare(
      `INSERT INTO provenance VALUES ('p1', 'KNOWLEDGE_GRAPH', datetime('now'), datetime('now'), 'KNOWLEDGE_GRAPH', 'doc1', 'hash1', 'test', '1.0', '{}', '[]', 2)`
    ).run();
    db.prepare(
      `INSERT INTO knowledge_nodes VALUES ('n1', 'person', 'Alice Jones', 'alice jones', NULL, 1, 1, 0, 0.9, NULL, 'p1', datetime('now'), datetime('now'), NULL, NULL)`
    ).run();

    const results = db
      .prepare(
        `SELECT canonical_name FROM knowledge_nodes WHERE rowid IN (SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?)`
      )
      .all('alice') as Array<{ canonical_name: string }>;
    expect(results.length).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('delete trigger works after migration', () => {
    createV21SchemaWithOldFTS();

    db.prepare(
      `INSERT INTO provenance VALUES ('p1', 'KNOWLEDGE_GRAPH', datetime('now'), datetime('now'), 'KNOWLEDGE_GRAPH', 'doc1', 'hash1', 'test', '1.0', '{}', '[]', 2)`
    ).run();
    db.prepare(
      `INSERT INTO knowledge_nodes VALUES ('n1', 'person', 'Bob Test', 'bob test', NULL, 1, 1, 0, 0.9, NULL, 'p1', datetime('now'), datetime('now'), NULL, NULL)`
    ).run();

    migrateToLatest(db);

    // Verify it's in FTS
    let results = db
      .prepare(
        `SELECT canonical_name FROM knowledge_nodes WHERE rowid IN (SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?)`
      )
      .all('bob') as Array<{ canonical_name: string }>;
    expect(results.length).toBe(1);

    // Delete and verify FTS updated
    db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run('n1');
    results = db
      .prepare(
        `SELECT canonical_name FROM knowledge_nodes WHERE rowid IN (SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?)`
      )
      .all('bob') as Array<{ canonical_name: string }>;
    expect(results.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('update trigger fires only for canonical_name changes', () => {
    createV21SchemaWithOldFTS();

    db.prepare(
      `INSERT INTO provenance VALUES ('p1', 'KNOWLEDGE_GRAPH', datetime('now'), datetime('now'), 'KNOWLEDGE_GRAPH', 'doc1', 'hash1', 'test', '1.0', '{}', '[]', 2)`
    ).run();
    db.prepare(
      `INSERT INTO knowledge_nodes VALUES ('n1', 'person', 'Charlie Brown', 'charlie brown', NULL, 1, 1, 0, 0.9, NULL, 'p1', datetime('now'), datetime('now'), NULL, NULL)`
    ).run();

    migrateToLatest(db);

    // Update canonical_name should update FTS
    db.prepare(
      "UPDATE knowledge_nodes SET canonical_name = ?, updated_at = datetime('now') WHERE id = ?"
    ).run('Charles Brown', 'n1');

    const results = db
      .prepare(
        `SELECT canonical_name FROM knowledge_nodes WHERE rowid IN (SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?)`
      )
      .all('charles') as Array<{ canonical_name: string }>;
    expect(results.length).toBe(1);

    // Old name should no longer match
    const oldResults = db
      .prepare(
        `SELECT canonical_name FROM knowledge_nodes WHERE rowid IN (SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?)`
      )
      .all('charlie') as Array<{ canonical_name: string }>;
    expect(oldResults.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running twice does not error', () => {
    createV21SchemaWithOldFTS();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number })
      .version;
    expect(version).toBe(24);
  });

  it.skipIf(!sqliteVecAvailable)('handles fresh DB with _ai/_ad/_au triggers', () => {
    // Simulate a fresh DB that already has correct trigger names
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_version VALUES (1, 21, datetime('now'), datetime('now'));
    `);

    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_type TEXT NOT NULL,
        root_document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        processor TEXT NOT NULL,
        processor_version TEXT NOT NULL,
        processing_params TEXT NOT NULL,
        parent_ids TEXT NOT NULL,
        chain_depth INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        aliases TEXT,
        document_count INTEGER NOT NULL DEFAULT 1,
        mention_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        avg_confidence REAL NOT NULL DEFAULT 0.0,
        metadata TEXT,
        provenance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        importance_score REAL,
        resolution_type TEXT
      )
    `);

    // Fresh-schema style with porter tokenizer and _ai/_ad/_au naming
    db.exec(
      `CREATE VIRTUAL TABLE knowledge_nodes_fts USING fts5(canonical_name, content='knowledge_nodes', content_rowid='rowid', tokenize='porter unicode61')`
    );
    db.exec(
      `CREATE TRIGGER knowledge_nodes_fts_ai AFTER INSERT ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`
    );
    db.exec(
      `CREATE TRIGGER knowledge_nodes_fts_ad AFTER DELETE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); END`
    );
    db.exec(
      `CREATE TRIGGER knowledge_nodes_fts_au AFTER UPDATE OF canonical_name ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`
    );

    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number })
      .version;
    expect(version).toBe(24);

    // Should still have correct triggers
    const triggers = getTriggerNames(db);
    expect(triggers).toContain('knowledge_nodes_fts_ai');
    expect(triggers).toContain('knowledge_nodes_fts_ad');
    expect(triggers).toContain('knowledge_nodes_fts_au');

    // FTS should still use porter
    const sql = getFTSCreateSQL(db);
    expect(sql).toContain('porter unicode61');
  });
});
