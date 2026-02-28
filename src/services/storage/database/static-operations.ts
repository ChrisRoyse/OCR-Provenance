/**
 * Static operations for DatabaseService - database lifecycle: create, open, list, delete, exists.
 */

import Database from 'better-sqlite3';
import {
  statSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import {
  initializeDatabase,
  migrateToLatest,
  checkSchemaVersion,
  getCurrentSchemaVersion,
  verifySchema,
  configurePragmas,
} from '../migrations.js';
import { createPreMigrationBackup } from './pre-migration-backup.js';
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
    try {
      unlinkSync(dbPath);
    } catch (cleanupErr) {
      console.error(
        '[static-operations] Failed to clean up db file after creation error:',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      );
    }
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
    try {
      unlinkSync(dbPath);
    } catch (cleanupErr) {
      console.error(
        '[static-operations] Failed to clean up db file after init error:',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      );
    }
    throw error;
  }

  try {
    const stmt = db.prepare(
      `UPDATE database_metadata SET database_name = ?, database_version = ? WHERE id = 1`
    );
    stmt.run(description ? `${name}: ${description}` : name, '1.0.0');
  } catch (error) {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch (cleanupErr) {
      console.error(
        '[static-operations] Failed to clean up db file after metadata error:',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      );
    }
    throw new DatabaseError(
      `Failed to set database metadata: ${String(error)}`,
      DatabaseErrorCode.SCHEMA_MISMATCH,
      error
    );
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
    throw new DatabaseError(
      `Database "${name}" not found at ${dbPath}`,
      DatabaseErrorCode.DATABASE_NOT_FOUND
    );
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (error) {
    throw new DatabaseError(
      `Failed to open database "${name}": ${String(error)}`,
      DatabaseErrorCode.DATABASE_LOCKED,
      error
    );
  }

  try {
    const sqliteVec = require('sqlite-vec') as SqliteVecModule;
    sqliteVec.load(db);
  } catch (error) {
    db.close();
    throw new DatabaseError(
      `Failed to load sqlite-vec extension: ${String(error)}. Ensure sqlite-vec is installed for your platform (npm install sqlite-vec-linux-x64 or sqlite-vec-darwin-arm64 or sqlite-vec-win32-x64).`,
      DatabaseErrorCode.EXTENSION_LOAD_FAILED,
      error
    );
  }

  // Configure per-connection pragmas (FK enforcement, synchronous, cache_size)
  // These are NOT persistent in SQLite -- must be set on every connection open
  try {
    configurePragmas(db);
  } catch (error) {
    db.close();
    throw error;
  }

  // Pre-migration backup: snapshot the database file before applying any
  // schema migrations. This protects user data when Docker images are updated
  // and forward-only migrations run on existing databases.
  // createPreMigrationBackup handles all skip logic (fresh DB, already current)
  // and is non-fatal — failure only logs a warning.
  try {
    const currentVersion = checkSchemaVersion(db);
    const targetVersion = getCurrentSchemaVersion();
    createPreMigrationBackup(db, dbPath, currentVersion, targetVersion);
  } catch (error) {
    // Backup failure must NOT prevent the database from opening.
    console.error(
      `[static-operations] Pre-migration backup failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
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
      `Database schema verification failed. Missing tables: ${verification.missingTables.join(', ')}. Missing indexes: ${verification.missingIndexes.join(', ')}. Missing columns: ${verification.missingColumns.join(', ')}`,
      DatabaseErrorCode.SCHEMA_MISMATCH
    );
  }

  return { db, name, path: dbPath };
}

/** List all available databases */
export function listDatabases(storagePath?: string): DatabaseInfo[] {
  const basePath = storagePath ?? DEFAULT_STORAGE_PATH;
  if (!existsSync(basePath)) {
    console.error(`[DATABASE] Storage directory does not exist: ${basePath}. Returning empty database list.`);
    return [];
  }

  const files = readdirSync(basePath).filter((f) => f.endsWith('.db'));
  const databases: DatabaseInfo[] = [];

  for (const file of files) {
    const name = file.replace('.db', '');
    const dbPath = join(basePath, file);
    try {
      const stats = statSync(dbPath);
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            `
          SELECT database_name, created_at, last_modified_at,
                 total_documents, total_ocr_results, total_chunks, total_embeddings
          FROM database_metadata WHERE id = 1
        `
          )
          .get() as MetadataRow | undefined;
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
    } catch (error) {
      console.error(
        `[static-operations] Failed to read database "${file}": ${error instanceof Error ? error.message : String(error)}`
      );
      databases.push({
        name,
        path: dbPath,
        size_bytes: 0,
        created_at: '',
        last_modified_at: '',
        total_documents: 0,
        total_ocr_results: 0,
        total_chunks: 0,
        total_embeddings: 0,
        error: `Failed to read database: ${error instanceof Error ? error.message : String(error)}`,
        corrupt: true,
      } as DatabaseInfo & { error: string; corrupt: boolean });
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
    throw new DatabaseError(
      `Database "${name}" not found at ${dbPath}`,
      DatabaseErrorCode.DATABASE_NOT_FOUND
    );
  }

  // Before deleting the DB file, query for document IDs to clean up image directories
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const basePath = storagePath ?? join(dbPath, '..'); // parent of .db file
      const imagesBaseDir = join(basePath, 'images');
      if (existsSync(imagesBaseDir)) {
        // Query all document IDs — image dirs are created per-document during OCR
        const docs = db.prepare('SELECT id FROM documents').all() as Array<{ id: string }>;
        for (const { id } of docs) {
          const imageDir = join(imagesBaseDir, id);
          if (existsSync(imageDir)) {
            try {
              rmSync(imageDir, { recursive: true, force: true });
            } catch (error) {
              console.error(
                `[static-operations] Failed to delete image directory ${imageDir}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(
      `[static-operations] Failed to query database ${dbPath} for image cleanup (DB may be corrupt or missing tables): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  unlinkSync(dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Check if a database exists */
export function databaseExists(name: string, storagePath?: string): boolean {
  try {
    validateName(name);
  } catch (error) {
    console.error(
      '[static-operations] Invalid database name:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
  return existsSync(getDatabasePath(name, storagePath));
}
