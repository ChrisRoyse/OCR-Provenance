/**
 * Pre-Migration Backup Tests
 *
 * Tests for the automatic database backup system that protects user data
 * when Docker images are updated and schema migrations run.
 *
 * Uses REAL better-sqlite3 databases with full schema. NO MOCKS.
 *
 * @module tests/unit/pre-migration-backup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import {
  createPreMigrationBackup,
  cleanupOldBackups,
} from '../../src/services/storage/database/pre-migration-backup.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

/** Create a minimal SQLite database with a schema_version table at the given version.
 *  Returns { dbPath, db } — caller must close the db when done. */
function createTestDb(dir: string, name: string, version: number): { dbPath: string; db: InstanceType<typeof Database> } {
  const dbPath = join(dir, `${name}.db`);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER, created_at TEXT, updated_at TEXT)`);
  db.prepare(`INSERT INTO schema_version (id, version, created_at, updated_at) VALUES (1, ?, ?, ?)`).run(
    version,
    new Date().toISOString(),
    new Date().toISOString()
  );
  // Add a data table so we can verify backup integrity
  db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, name TEXT)`);
  db.prepare(`INSERT INTO documents (id, name) VALUES (?, ?)`).run('doc-1', 'test-document');
  return { dbPath, db };
}

/** Read the schema version from a database file */
function readVersion(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
  db.close();
  return row.version;
}

/** Read document count from a database file */
function readDocCount(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
  db.close();
  return row.cnt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 1: createPreMigrationBackup — core logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('createPreMigrationBackup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('pre-migrate-backup-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('creates backup when migration is needed (version < target)', () => {
    const { dbPath, db } = createTestDb(tempDir, 'mydb', 28);
    const result = createPreMigrationBackup(db, dbPath, 28, 32);
    db.close();

    expect(result.created).toBe(true);
    expect(result.fromVersion).toBe(28);
    expect(result.toVersion).toBe(32);
    expect(result.backupPath).toBe(join(tempDir, 'mydb.db.pre-migrate-v28'));
    expect(existsSync(result.backupPath!)).toBe(true);
  });

  it('backup contains identical data to original', () => {
    const { dbPath, db } = createTestDb(tempDir, 'mydb', 20);
    const result = createPreMigrationBackup(db, dbPath, 20, 32);
    db.close();

    expect(result.created).toBe(true);
    // Verify the backup has the same schema version and data
    expect(readVersion(result.backupPath!)).toBe(20);
    expect(readDocCount(result.backupPath!)).toBe(1);
  });

  it('skips backup for fresh database (version 0)', () => {
    const { dbPath, db } = createTestDb(tempDir, 'fresh', 0);
    const result = createPreMigrationBackup(db, dbPath, 0, 32);
    db.close();

    expect(result.created).toBe(false);
    expect(result.reason).toBe('fresh_database');
    expect(result.backupPath).toBeNull();
  });

  it('skips backup when already at target version', () => {
    const { dbPath, db } = createTestDb(tempDir, 'current', 32);
    const result = createPreMigrationBackup(db, dbPath, 32, 32);
    db.close();

    expect(result.created).toBe(false);
    expect(result.reason).toBe('already_current');
    expect(result.backupPath).toBeNull();
  });

  it('skips backup when ahead of target version', () => {
    const { dbPath, db } = createTestDb(tempDir, 'future', 99);
    const result = createPreMigrationBackup(db, dbPath, 99, 32);
    db.close();

    expect(result.created).toBe(false);
    expect(result.reason).toBe('already_current');
    expect(result.backupPath).toBeNull();
  });

  it('does not overwrite existing backup for same version', () => {
    const { dbPath, db } = createTestDb(tempDir, 'mydb', 25);

    // Create first backup
    const result1 = createPreMigrationBackup(db, dbPath, 25, 32);
    expect(result1.created).toBe(true);
    const backupMtime1 = statSync(result1.backupPath!).mtimeMs;

    // Modify the original DB
    db.prepare(`INSERT INTO documents (id, name) VALUES (?, ?)`).run('doc-2', 'new-document');

    // Attempt second backup for same version — should skip
    const result2 = createPreMigrationBackup(db, dbPath, 25, 32);
    db.close();
    expect(result2.created).toBe(false);
    expect(result2.reason).toBe('backup_exists');
    expect(result2.backupPath).toBe(result1.backupPath);

    // Backup file should not have been modified (still has original mtime)
    const backupMtime2 = statSync(result2.backupPath!).mtimeMs;
    expect(backupMtime2).toBe(backupMtime1);

    // Backup should still have only 1 document (the pristine copy)
    expect(readDocCount(result2.backupPath!)).toBe(1);
  });

  it('handles missing source file gracefully', () => {
    // Use a real db connection but point to a nonexistent path for the file copy
    const { db } = createTestDb(tempDir, 'dummy', 10);
    const fakePath = join(tempDir, 'nonexistent.db');
    const result = createPreMigrationBackup(db, fakePath, 10, 32);
    db.close();

    expect(result.created).toBe(false);
    expect(result.reason).toBe('source_not_found');
  });

  it('creates backups for different versions independently', () => {
    const { dbPath, db } = createTestDb(tempDir, 'mydb', 25);

    // Backup for v25
    const result1 = createPreMigrationBackup(db, dbPath, 25, 30);
    expect(result1.created).toBe(true);
    expect(result1.backupPath).toContain('pre-migrate-v25');

    // Simulate version bump to 30, then backup for v30
    const result2 = createPreMigrationBackup(db, dbPath, 30, 32);
    db.close();
    expect(result2.created).toBe(true);
    expect(result2.backupPath).toContain('pre-migrate-v30');

    // Both backups should exist
    expect(existsSync(result1.backupPath!)).toBe(true);
    expect(existsSync(result2.backupPath!)).toBe(true);
  });

  it('copies WAL and SHM files when they exist', () => {
    const { dbPath, db } = createTestDb(tempDir, 'waldb', 15);
    db.close();

    // Create fake WAL and SHM files (in real usage SQLite creates these)
    writeFileSync(`${dbPath}-wal`, 'wal-data');
    writeFileSync(`${dbPath}-shm`, 'shm-data');

    // Reopen to get a connection for the checkpoint call
    const db2 = new Database(dbPath);
    const result = createPreMigrationBackup(db2, dbPath, 15, 32);
    db2.close();
    expect(result.created).toBe(true);
    expect(existsSync(`${result.backupPath!}-wal`)).toBe(true);
    expect(existsSync(`${result.backupPath!}-shm`)).toBe(true);
  });

  it('succeeds even without WAL/SHM files', () => {
    const { dbPath, db } = createTestDb(tempDir, 'nowal', 10);
    // Checkpoint to flush WAL, then close (removes WAL/SHM)
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();

    // Reopen — WAL files might not exist after TRUNCATE + close
    const db2 = new Database(dbPath);
    const result = createPreMigrationBackup(db2, dbPath, 10, 32);
    db2.close();
    expect(result.created).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 2: cleanupOldBackups — retention policy
// ═══════════════════════════════════════════════════════════════════════════════

describe('cleanupOldBackups', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('backup-cleanup-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('keeps only the most recent N backups', () => {
    const dbFile = 'testdb.db';

    // Create 5 backup files with staggered mtimes
    for (let v = 1; v <= 5; v++) {
      const backupPath = join(tempDir, `${dbFile}.pre-migrate-v${String(v)}`);
      writeFileSync(backupPath, `backup-v${String(v)}`);
    }

    cleanupOldBackups(tempDir, dbFile, 3);

    const remaining = readdirSync(tempDir).filter((f) => f.startsWith(`${dbFile}.pre-migrate-v`));
    expect(remaining.length).toBe(3);
    // The oldest (v1, v2) should be deleted, newest (v3, v4, v5) kept
    expect(remaining).toContain(`${dbFile}.pre-migrate-v3`);
    expect(remaining).toContain(`${dbFile}.pre-migrate-v4`);
    expect(remaining).toContain(`${dbFile}.pre-migrate-v5`);
  });

  it('cleans up WAL/SHM files alongside main backup', () => {
    const dbFile = 'testdb.db';

    for (let v = 1; v <= 4; v++) {
      const backupPath = join(tempDir, `${dbFile}.pre-migrate-v${String(v)}`);
      writeFileSync(backupPath, `backup-v${String(v)}`);
      writeFileSync(`${backupPath}-wal`, 'wal');
      writeFileSync(`${backupPath}-shm`, 'shm');
    }

    cleanupOldBackups(tempDir, dbFile, 2);

    // v1 and v2 should be fully deleted (main + wal + shm)
    expect(existsSync(join(tempDir, `${dbFile}.pre-migrate-v1`))).toBe(false);
    expect(existsSync(join(tempDir, `${dbFile}.pre-migrate-v1-wal`))).toBe(false);
    expect(existsSync(join(tempDir, `${dbFile}.pre-migrate-v1-shm`))).toBe(false);

    // v3 and v4 should remain
    expect(existsSync(join(tempDir, `${dbFile}.pre-migrate-v3`))).toBe(true);
    expect(existsSync(join(tempDir, `${dbFile}.pre-migrate-v4`))).toBe(true);
  });

  it('does nothing when backup count is within limit', () => {
    const dbFile = 'testdb.db';

    writeFileSync(join(tempDir, `${dbFile}.pre-migrate-v10`), 'backup');
    writeFileSync(join(tempDir, `${dbFile}.pre-migrate-v20`), 'backup');

    cleanupOldBackups(tempDir, dbFile, 3);

    const remaining = readdirSync(tempDir).filter((f) => f.startsWith(`${dbFile}.pre-migrate-v`));
    expect(remaining.length).toBe(2);
  });

  it('does not delete backups from other databases', () => {
    writeFileSync(join(tempDir, 'db-a.db.pre-migrate-v1'), 'backup-a');
    writeFileSync(join(tempDir, 'db-b.db.pre-migrate-v1'), 'backup-b');
    writeFileSync(join(tempDir, 'db-b.db.pre-migrate-v2'), 'backup-b2');
    writeFileSync(join(tempDir, 'db-b.db.pre-migrate-v3'), 'backup-b3');
    writeFileSync(join(tempDir, 'db-b.db.pre-migrate-v4'), 'backup-b4');

    cleanupOldBackups(tempDir, 'db-b.db', 2);

    // db-a backup should be untouched
    expect(existsSync(join(tempDir, 'db-a.db.pre-migrate-v1'))).toBe(true);
    // db-b should have only 2 remaining
    const dbBBackups = readdirSync(tempDir).filter((f) => f.startsWith('db-b.db.pre-migrate-v'));
    expect(dbBBackups.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 3: Integration — openDatabase triggers backup
// ═══════════════════════════════════════════════════════════════════════════════

describe('openDatabase integration with pre-migration backup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('open-db-backup-');
  });

  afterEach(async () => {
    // Reset global state to prevent module-level state leaking between test groups
    const { resetState } = await import('../../src/server/state.js');
    resetState();
    cleanupTempDir(tempDir);
  });

  it('openDatabase creates backup when schema version is behind', async () => {
    // Import the real modules
    const { createDatabase, openDatabase } = await import(
      '../../src/services/storage/database/static-operations.js'
    );
    const { getCurrentSchemaVersion } = await import(
      '../../src/services/storage/migrations.js'
    );

    const targetVersion = getCurrentSchemaVersion();

    // Create a database at current version first
    const { db: db1, path: dbPath } = createDatabase('backup-integration-test', undefined, tempDir);
    db1.close();

    // Now manually downgrade the schema_version in the file to simulate an older DB
    const rawDb = new Database(dbPath);
    rawDb.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(targetVersion - 1);
    rawDb.close();

    // Open the database — this should trigger pre-migration backup, then migrate
    const { db: db2 } = openDatabase('backup-integration-test', tempDir);

    // Verify the backup file was created
    const backupPath = `${dbPath}.pre-migrate-v${String(targetVersion - 1)}`;
    expect(existsSync(backupPath)).toBe(true);

    // Verify the backup has the old version
    const backupDb = new Database(backupPath);
    const row = backupDb.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    backupDb.close();
    expect(row.version).toBe(targetVersion - 1);

    db2.close();
  });

  it('openDatabase does NOT create backup when already at current version', async () => {
    const { createDatabase, openDatabase } = await import(
      '../../src/services/storage/database/static-operations.js'
    );

    // Create a database at current version
    const { db: db1 } = createDatabase('no-backup-test', undefined, tempDir);
    db1.close();

    // Reopen — should NOT create a backup
    const { db: db2, path: dbPath } = openDatabase('no-backup-test', tempDir);

    const backupFiles = readdirSync(tempDir).filter((f) => f.includes('.pre-migrate-v'));
    expect(backupFiles.length).toBe(0);

    db2.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 4: WAL/mmap conflict — same-DB reopen after external modification
// ═══════════════════════════════════════════════════════════════════════════════

describe('selectDatabase WAL/mmap safety on same-DB reopen', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('wal-conflict-');
  });

  afterEach(async () => {
    // Reset global state so other tests aren't affected
    const { resetState } = await import('../../src/server/state.js');
    resetState();
    cleanupTempDir(tempDir);
  });

  it('re-selecting same DB after external modification succeeds', async () => {
    const { createDatabase: createDb, selectDatabase, requireDatabase } = await import(
      '../../src/server/state.js'
    );

    const dbName = 'wal-conflict-test';
    createDb(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    // Verify initial state via the active connection
    const { db: dbSvc1 } = requireDatabase();
    const conn1 = dbSvc1.getConnection();
    const docs1 = conn1.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
    expect(docs1.cnt).toBe(0);

    // Get the DB file path
    const dbPath = join(tempDir, `${dbName}.db`);

    // Simulate external modification (e.g., another process or old Docker container):
    // Open with a separate better-sqlite3 connection, modify, close
    const externalDb = new Database(dbPath);
    externalDb.exec("PRAGMA journal_mode = WAL");
    externalDb.exec(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('ext-prov-001', 'DOCUMENT', datetime('now'), datetime('now'), 'FILE', 'ext-doc-001', 'hash1', 'external', '1.0', '{}', '[]', 0)
    `);
    externalDb.exec(`
      INSERT INTO documents (id, file_path, file_name, file_type, file_hash, file_size, status, provenance_id, created_at)
      VALUES ('ext-doc-001', '/test/external.pdf', 'external.pdf', 'pdf', 'exthash', 1024, 'complete', 'ext-prov-001', datetime('now'))
    `);
    externalDb.pragma('wal_checkpoint(TRUNCATE)');
    externalDb.close();

    // Re-select the SAME database — this previously caused "database disk image is malformed"
    // because the old connection's mmap was stale while the new connection tried to open
    selectDatabase(dbName, tempDir);

    // Verify the new connection sees the externally inserted data
    const { db: dbSvc2 } = requireDatabase();
    const conn2 = dbSvc2.getConnection();
    const docs2 = conn2.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
    expect(docs2.cnt).toBe(1);

    const doc = conn2.prepare('SELECT file_name FROM documents WHERE id = ?').get('ext-doc-001') as { file_name: string };
    expect(doc.file_name).toBe('external.pdf');
  });

  it('switching to a DIFFERENT DB still uses atomic swap (no null window)', async () => {
    const { createDatabase: createDb, selectDatabase, requireDatabase } = await import(
      '../../src/server/state.js'
    );

    // Create two databases
    createDb('db-alpha', undefined, tempDir);
    createDb('db-beta', undefined, tempDir);

    // Select first
    selectDatabase('db-alpha', tempDir);
    const { db: dbSvcA } = requireDatabase();
    const connA = dbSvcA.getConnection();
    connA.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-a', 'DOCUMENT', datetime('now'), datetime('now'), 'FILE', 'doc-a', 'h1', 'test', '1.0', '{}', '[]', 0)
    `).run();
    connA.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_type, file_hash, file_size, status, provenance_id, created_at)
      VALUES ('doc-a', '/a.pdf', 'a.pdf', 'pdf', 'ha', 100, 'complete', 'prov-a', datetime('now'))
    `).run();

    // Switch to second — atomic swap should work (different file)
    selectDatabase('db-beta', tempDir);
    const { db: dbSvcB } = requireDatabase();
    const connB = dbSvcB.getConnection();
    const docs = connB.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
    expect(docs.cnt).toBe(0); // db-beta has no docs

    // Switch back to first
    selectDatabase('db-alpha', tempDir);
    const { db: dbSvcA2 } = requireDatabase();
    const connA2 = dbSvcA2.getConnection();
    const docsA = connA2.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
    expect(docsA.cnt).toBe(1); // db-alpha still has its doc
  });

  it('re-selecting same DB with downgraded schema creates backup and migrates', async () => {
    const { createDatabase: createDb, selectDatabase, requireDatabase } = await import(
      '../../src/server/state.js'
    );
    const { getCurrentSchemaVersion } = await import(
      '../../src/services/storage/migrations.js'
    );

    const dbName = 'wal-backup-trigger';
    const dbPath = join(tempDir, `${dbName}.db`);
    createDb(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    // Externally downgrade schema version to simulate old Docker image DB
    const extDb = new Database(dbPath);
    extDb.exec("PRAGMA journal_mode = WAL");
    const targetVersion = getCurrentSchemaVersion();
    extDb.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(targetVersion - 1);
    extDb.pragma('wal_checkpoint(TRUNCATE)');
    extDb.close();

    // Re-select — should close old mmap, create backup, then migrate
    selectDatabase(dbName, tempDir);

    // Verify backup was created
    const backupPath = `${dbPath}.pre-migrate-v${String(targetVersion - 1)}`;
    expect(existsSync(backupPath)).toBe(true);

    // Verify backup has old version
    const backupDb = new Database(backupPath);
    const backupVersion = (backupDb.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version;
    backupDb.close();
    expect(backupVersion).toBe(targetVersion - 1);

    // Verify main DB was migrated to current
    const { db: dbSvc } = requireDatabase();
    const conn = dbSvc.getConnection();
    const mainVersion = (conn.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version;
    expect(mainVersion).toBe(targetVersion);
  });
});
