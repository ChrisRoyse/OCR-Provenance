/**
 * Shared Test Helpers for Database Migrations Tests
 *
 * Provides common utilities, fixtures, and setup/teardown helpers
 * for all migration test modules.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Helper to check if sqlite-vec extension is available
 */
export function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper to get table info from SQLite
 */
export function getTableColumns(db: Database.Database, tableName: string): string[] {
  const result = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return result.map((row) => row.name);
}

/**
 * Helper to get all table names from database
 */
export function getTableNames(db: Database.Database): string[] {
  const result = db
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `
    )
    .all() as Array<{ name: string }>;
  return result.map((row) => row.name);
}

/**
 * Helper to get all index names from database
 */
export function getIndexNames(db: Database.Database): string[] {
  const result = db
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `
    )
    .all() as Array<{ name: string }>;
  return result.map((row) => row.name);
}

/**
 * Helper to check if a virtual table exists
 */
export function virtualTableExists(db: Database.Database, tableName: string): boolean {
  const result = db
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `
    )
    .get(tableName) as { name: string } | undefined;
  return result !== undefined;
}

/**
 * Helper to get pragma value
 */
export function getPragmaValue(db: Database.Database, pragma: string): unknown {
  const result = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  return result ? Object.values(result)[0] : undefined;
}

/**
 * Test context interface for shared test state
 */
export interface TestContext {
  testDir: string;
  db: Database.Database | undefined;
  dbPath: string;
}

/**
 * Create a unique test directory
 */
export function createTestDir(prefix: string): string {
  const testDir = path.join(os.tmpdir(), `${prefix}-${String(Date.now())}-${String(process.pid)}`);
  fs.mkdirSync(testDir, { recursive: true });
  return testDir;
}

/**
 * Clean up test directory
 */
export function cleanupTestDir(testDir: string): void {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a fresh database for testing
 */
export function createTestDb(testDir: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(
    testDir,
    `test-${String(Date.now())}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(dbPath);
  return { db, dbPath };
}

/**
 * Close database safely
 */
export function closeDb(db: Database.Database | undefined): void {
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Insert a provenance record for testing
 */
export function insertTestProvenance(
  db: Database.Database,
  id: string,
  type: string = 'DOCUMENT',
  rootDocumentId: string = 'doc-001'
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO provenance (
      id, type, created_at, processed_at, source_type, root_document_id,
      content_hash, processor, processor_version, processing_params,
      parent_ids, chain_depth
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    type,
    now,
    now,
    'FILE',
    rootDocumentId,
    `sha256:${id}`,
    'file-ingester',
    '1.0.0',
    '{}',
    '[]',
    0
  );
}

/**
 * Insert a document record for testing
 */
export function insertTestDocument(
  db: Database.Database,
  docId: string,
  provenanceId: string,
  status: string = 'pending'
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO documents (
      id, file_path, file_name, file_hash, file_size, file_type,
      status, provenance_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    docId,
    `/test/${docId}.pdf`,
    `${docId}.pdf`,
    `sha256:${docId}`,
    1024,
    'pdf',
    status,
    provenanceId,
    now
  );
}

// Track if sqlite-vec is available for conditional tests
export const sqliteVecAvailable = isSqliteVecAvailable();

// Log warning if sqlite-vec is not available
if (!sqliteVecAvailable) {
  console.warn(
    'WARNING: sqlite-vec extension not available. Vector-related tests will be skipped.'
  );
}
