/**
 * Static operations for DatabaseService - database lifecycle: create, open, list, delete, exists.
 */

import Database from 'better-sqlite3';
import { statSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, chmodSync } from 'fs';
import { createRequire } from 'module';
import { initializeDatabase, migrateToLatest, verifySchema } from '../migrations.js';
import { SqliteVecModule } from '../types.js';
import { DatabaseInfo, DatabaseError, DatabaseErrorCode, MetadataRow } from './types.js';
import { DEFAULT_STORAGE_PATH, validateName, getDatabasePath } from './helpers.js';

const require = createRequire(import.meta.url);

/**
 * Create a new database
 * @throws DatabaseError if name is invalid or database already exists
 */
export function createDatabase(
  name: string,
  description?: string,
  storagePath?: string
): { db: Database.Database; name: string; path: string } {
  validateName(name);
  const basePath = storagePath ?? DEFAULT_STORAGE_PATH;
  const dbPath = getDatabasePath(name, storagePath);

  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true, mode: 0o700 });
  }

  if (existsSync(dbPath)) {
    throw new DatabaseError(
      `Database "${name}" already exists at ${dbPath}`,
      DatabaseErrorCode.DATABASE_ALREADY_EXISTS
    );
  }

  writeFileSync(dbPath, '', { mode: 0o600 });
  chmodSync(dbPath, 0o600);

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (error) {
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    throw new DatabaseError(
      `Failed to create database "${name}": ${String(error)}`,
      DatabaseErrorCode.PERMISSION_DENIED,
      error
    );
  }

  try {
    initializeDatabase(db);
  } catch (error) {
    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    throw error;
  }

  try {
    const stmt = db.prepare(`UPDATE database_metadata SET database_name = ?, database_version = ? WHERE id = 1`);
    stmt.run(description ? `${name}: ${description}` : name, '1.0.0');
  } catch (error) {
    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    throw new DatabaseError(`Failed to set database metadata: ${String(error)}`, DatabaseErrorCode.SCHEMA_MISMATCH, error);
  }

  return { db, name, path: dbPath };
}

/**
 * Open an existing database
 * @throws DatabaseError if database doesn't exist or schema is invalid
 */
export function openDatabase(
  name: string,
  storagePath?: string
): { db: Database.Database; name: string; path: string } {
  validateName(name);
  const dbPath = getDatabasePath(name, storagePath);

  if (!existsSync(dbPath)) {
    throw new DatabaseError(`Database "${name}" not found at ${dbPath}`, DatabaseErrorCode.DATABASE_NOT_FOUND);
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (error) {
    throw new DatabaseError(`Failed to open database "${name}": ${String(error)}`, DatabaseErrorCode.DATABASE_LOCKED, error);
  }

  try {
    const sqliteVec = require('sqlite-vec') as SqliteVecModule;
    sqliteVec.load(db);
  } catch (error) {
    db.close();
    throw new DatabaseError(
      `Failed to load sqlite-vec extension: ${String(error)}. Ensure sqlite-vec is installed.`,
      DatabaseErrorCode.SCHEMA_MISMATCH,
      error
    );
  }

  try {
    migrateToLatest(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const verification = verifySchema(db);
  if (!verification.valid) {
    db.close();
    throw new DatabaseError(
      `Database schema verification failed. Missing tables: ${verification.missingTables.join(', ')}. Missing indexes: ${verification.missingIndexes.join(', ')}`,
      DatabaseErrorCode.SCHEMA_MISMATCH
    );
  }

  return { db, name, path: dbPath };
}

/** List all available databases */
export function listDatabases(storagePath?: string): DatabaseInfo[] {
  const basePath = storagePath ?? DEFAULT_STORAGE_PATH;
  if (!existsSync(basePath)) return [];

  const files = readdirSync(basePath).filter((f) => f.endsWith('.db'));
  const databases: DatabaseInfo[] = [];

  for (const file of files) {
    const name = file.replace('.db', '');
    const dbPath = `${basePath}/${file}`;
    try {
      const stats = statSync(dbPath);
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare(`
          SELECT database_name, created_at, last_modified_at,
                 total_documents, total_ocr_results, total_chunks, total_embeddings
          FROM database_metadata WHERE id = 1
        `).get() as MetadataRow | undefined;
        if (row) {
          databases.push({
            name,
            path: dbPath,
            size_bytes: stats.size,
            created_at: row.created_at,
            last_modified_at: row.last_modified_at,
            total_documents: row.total_documents,
            total_ocr_results: row.total_ocr_results,
            total_chunks: row.total_chunks,
            total_embeddings: row.total_embeddings,
          });
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return databases;
}

/** Delete a database - throws DatabaseError if database doesn't exist */
export function deleteDatabase(name: string, storagePath?: string): void {
  validateName(name);
  const dbPath = getDatabasePath(name, storagePath);

  if (!existsSync(dbPath)) {
    throw new DatabaseError(`Database "${name}" not found at ${dbPath}`, DatabaseErrorCode.DATABASE_NOT_FOUND);
  }

  unlinkSync(dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Check if a database exists */
export function databaseExists(name: string, storagePath?: string): boolean {
  try { validateName(name); } catch { return false; }
  return existsSync(getDatabasePath(name, storagePath));
}
