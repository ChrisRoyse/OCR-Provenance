/**
 * Migration v22 to v23 Tests
 *
 * Tests the v22->v23 migration which:
 * - Recreates knowledge_edges table with expanded CHECK constraint
 * - Adds 4 medical relationship types: treated_with, administered_via, managed_by, interacts_with
 * - Preserves all existing edge data
 * - Recreates indexes on knowledge_edges
 * - Runs PRAGMA foreign_key_check after migration
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
  getIndexNames,
} from './helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('Migration v22 to v23 (Medical Relationship Types)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v23');
    const result = createTestDb(tmpDir);
    db = result.db;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal v22 schema with the old knowledge_edges CHECK constraint
   * (12 relationship types, missing the 4 medical types).
   */
  function createV22Schema(): void {
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
      INSERT INTO schema_version VALUES (1, 22, datetime('now'), datetime('now'));
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
        resolution_type TEXT,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      )
    `);

    // v22 knowledge_edges: 12 relationship types (pre-medical)
    db.exec(`
      CREATE TABLE knowledge_edges (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL CHECK (relationship_type IN (
          'co_mentioned', 'co_located', 'works_at', 'represents',
          'located_in', 'filed_in', 'cites', 'references',
          'party_to', 'related_to', 'precedes', 'occurred_at'
        )),
        weight REAL NOT NULL DEFAULT 1.0,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        document_ids TEXT NOT NULL,
        metadata TEXT,
        provenance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        normalized_weight REAL DEFAULT 0,
        contradiction_count INTEGER DEFAULT 0,
        FOREIGN KEY (source_node_id) REFERENCES knowledge_nodes(id),
        FOREIGN KEY (target_node_id) REFERENCES knowledge_nodes(id),
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      )
    `);

    db.exec('CREATE INDEX idx_ke_source_node ON knowledge_edges(source_node_id)');
    db.exec('CREATE INDEX idx_ke_target_node ON knowledge_edges(target_node_id)');
    db.exec('CREATE INDEX idx_ke_relationship_type ON knowledge_edges(relationship_type)');

    // FTS (already in v22 format with porter tokenizer)
    db.exec(`CREATE VIRTUAL TABLE knowledge_nodes_fts USING fts5(canonical_name, content='knowledge_nodes', content_rowid='rowid', tokenize='porter unicode61')`);
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_ai AFTER INSERT ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`);
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_ad AFTER DELETE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); END`);
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_au AFTER UPDATE OF canonical_name ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`);
  }

  /**
   * Insert test provenance, nodes, and edges into the v22 schema.
   */
  function insertTestData(): void {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO provenance VALUES ('prov-kg-1', 'KNOWLEDGE_GRAPH', ?, ?, 'KNOWLEDGE_GRAPH', 'doc1', 'hash1', 'test', '1.0', '{}', '[]', 2)`).run(now, now);
    db.prepare(`INSERT INTO knowledge_nodes VALUES ('n1', 'person', 'Dr. Smith', 'dr. smith', NULL, 1, 5, 2, 0.9, NULL, 'prov-kg-1', ?, ?, NULL, NULL)`).run(now, now);
    db.prepare(`INSERT INTO knowledge_nodes VALUES ('n2', 'medication', 'Aspirin', 'aspirin', NULL, 1, 3, 1, 0.85, NULL, 'prov-kg-1', ?, ?, NULL, NULL)`).run(now, now);
    db.prepare(`INSERT INTO knowledge_nodes VALUES ('n3', 'organization', 'City Hospital', 'city hospital', NULL, 2, 10, 3, 0.88, NULL, 'prov-kg-1', ?, ?, NULL, NULL)`).run(now, now);

    // Insert edges with existing relationship types
    db.prepare(`INSERT INTO knowledge_edges VALUES ('e1', 'n1', 'n3', 'works_at', 1.5, 3, '["doc1"]', NULL, 'prov-kg-1', ?, NULL, NULL, 0.5, 0)`).run(now);
    db.prepare(`INSERT INTO knowledge_edges VALUES ('e2', 'n1', 'n2', 'co_mentioned', 1.0, 1, '["doc1"]', NULL, 'prov-kg-1', ?, NULL, NULL, 0.3, 0)`).run(now);
    db.prepare(`INSERT INTO knowledge_edges VALUES ('e3', 'n2', 'n3', 'related_to', 0.8, 2, '["doc1"]', '{"context":"prescription"}', 'prov-kg-1', ?, '2026-01-01', '2026-12-31', 0.2, 1)`).run(now);
  }

  function getEdgeCheckSQL(): string {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_edges' AND type = 'table'").get() as { sql: string } | undefined;
    return row?.sql ?? '';
  }

  it.skipIf(!sqliteVecAvailable)('migrates to schema version 23', () => {
    createV22Schema();
    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(23);
  });

  it.skipIf(!sqliteVecAvailable)('CHECK constraint includes medical relationship types after migration', () => {
    createV22Schema();
    migrateToLatest(db);

    const sql = getEdgeCheckSQL();
    expect(sql).toContain('treated_with');
    expect(sql).toContain('administered_via');
    expect(sql).toContain('managed_by');
    expect(sql).toContain('interacts_with');
  });

  it.skipIf(!sqliteVecAvailable)('CHECK constraint still includes all 12 original relationship types', () => {
    createV22Schema();
    migrateToLatest(db);

    const sql = getEdgeCheckSQL();
    const originalTypes = [
      'co_mentioned', 'co_located', 'works_at', 'represents',
      'located_in', 'filed_in', 'cites', 'references',
      'party_to', 'related_to', 'precedes', 'occurred_at',
    ];
    for (const t of originalTypes) {
      expect(sql).toContain(t);
    }
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing edge data after migration', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);

    const edges = db.prepare('SELECT * FROM knowledge_edges ORDER BY id').all() as Array<{
      id: string;
      source_node_id: string;
      target_node_id: string;
      relationship_type: string;
      weight: number;
      evidence_count: number;
      document_ids: string;
      metadata: string | null;
      valid_from: string | null;
      valid_until: string | null;
      normalized_weight: number;
      contradiction_count: number;
    }>;
    expect(edges.length).toBe(3);

    // e1: works_at
    expect(edges[0].id).toBe('e1');
    expect(edges[0].source_node_id).toBe('n1');
    expect(edges[0].target_node_id).toBe('n3');
    expect(edges[0].relationship_type).toBe('works_at');
    expect(edges[0].weight).toBe(1.5);
    expect(edges[0].evidence_count).toBe(3);

    // e2: co_mentioned
    expect(edges[1].id).toBe('e2');
    expect(edges[1].relationship_type).toBe('co_mentioned');

    // e3: related_to with metadata and temporal bounds
    expect(edges[2].id).toBe('e3');
    expect(edges[2].relationship_type).toBe('related_to');
    expect(edges[2].metadata).toBe('{"context":"prescription"}');
    expect(edges[2].valid_from).toBe('2026-01-01');
    expect(edges[2].valid_until).toBe('2026-12-31');
    expect(edges[2].normalized_weight).toBe(0.2);
    expect(edges[2].contradiction_count).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('new medical relationship types can be inserted after migration', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);

    const now = new Date().toISOString();
    const medicalTypes = ['treated_with', 'administered_via', 'managed_by', 'interacts_with'];

    for (let i = 0; i < medicalTypes.length; i++) {
      const edgeId = `e-med-${String(i)}`;
      expect(() => {
        db.prepare(
          `INSERT INTO knowledge_edges VALUES (?, 'n1', 'n2', ?, 1.0, 1, '["doc1"]', NULL, 'prov-kg-1', ?, NULL, NULL, 0, 0)`
        ).run(edgeId, medicalTypes[i], now);
      }).not.toThrow();
    }

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }).cnt;
    expect(count).toBe(7); // 3 original + 4 new medical
  });

  it.skipIf(!sqliteVecAvailable)('rejects invalid relationship types after migration', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);

    const now = new Date().toISOString();
    expect(() => {
      db.prepare(
        `INSERT INTO knowledge_edges VALUES ('e-bad', 'n1', 'n2', 'invalid_type', 1.0, 1, '["doc1"]', NULL, 'prov-kg-1', ?, NULL, NULL, 0, 0)`
      ).run(now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('indexes are recreated after migration', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);

    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_ke_source_node');
    expect(indexes).toContain('idx_ke_target_node');
    expect(indexes).toContain('idx_ke_relationship_type');
  });

  it.skipIf(!sqliteVecAvailable)('foreign key integrity passes after migration', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('preserves node data after migration', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);

    const nodes = db.prepare('SELECT * FROM knowledge_nodes ORDER BY id').all() as Array<{
      id: string;
      entity_type: string;
      canonical_name: string;
    }>;
    expect(nodes.length).toBe(3);
    expect(nodes[0].id).toBe('n1');
    expect(nodes[0].canonical_name).toBe('Dr. Smith');
    expect(nodes[1].entity_type).toBe('medication');
    expect(nodes[2].canonical_name).toBe('City Hospital');
  });

  it.skipIf(!sqliteVecAvailable)('handles empty knowledge_edges table', () => {
    createV22Schema();
    // Insert provenance only, no edges
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO provenance VALUES ('prov-kg-1', 'KNOWLEDGE_GRAPH', ?, ?, 'KNOWLEDGE_GRAPH', 'doc1', 'hash1', 'test', '1.0', '{}', '[]', 2)`).run(now, now);

    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(23);

    const sql = getEdgeCheckSQL();
    expect(sql).toContain('treated_with');
    expect(sql).toContain('administered_via');
    expect(sql).toContain('managed_by');
    expect(sql).toContain('interacts_with');
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running twice does not error', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(23);
  });

  it.skipIf(!sqliteVecAvailable)('migration skips gracefully when knowledge_edges table does not exist', () => {
    // Create a v22 schema without any KG tables
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
      INSERT INTO schema_version VALUES (1, 22, datetime('now'), datetime('now'));
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

    // No knowledge_nodes or knowledge_edges tables
    expect(() => migrateToLatest(db)).not.toThrow();

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(23);
  });

  it.skipIf(!sqliteVecAvailable)('FKs enforced on new medical edges', () => {
    createV22Schema();
    insertTestData();
    migrateToLatest(db);

    const now = new Date().toISOString();
    // Try to insert a medical edge referencing non-existent nodes - should fail FK check
    // Note: SQLite only enforces FK on INSERT when foreign_keys is ON
    db.pragma('foreign_keys = ON');
    expect(() => {
      db.prepare(
        `INSERT INTO knowledge_edges VALUES ('e-fk-bad', 'nonexistent-node', 'n2', 'treated_with', 1.0, 1, '["doc1"]', NULL, 'prov-kg-1', ?, NULL, NULL, 0, 0)`
      ).run(now);
    }).toThrow();
  });
});
