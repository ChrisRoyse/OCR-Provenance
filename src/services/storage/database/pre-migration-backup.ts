/**
 * Pre-Migration Backup
 *
 * Automatically creates a backup of a database file before schema migrations
 * are applied. This protects user data when Docker images are updated and
 * the new code runs forward-only migrations on existing databases.
 *
 * Backup naming: {name}.db.pre-migrate-v{oldVersion}
 * - Only created when the DB schema version < current SCHEMA_VERSION
 * - Skips backup for fresh databases (version 0) and already-current databases
 * - If a backup for the same version already exists, it is NOT overwritten
 *   (the first backup is the pristine pre-migration copy)
 * - Old backups are cleaned up: only the most recent N are kept (default 3)
 *
 * @module database/pre-migration-backup
 */

import { copyFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import type Database from 'better-sqlite3';

/** Maximum number of pre-migration backups to retain per database */
const MAX_BACKUPS = 3;

export interface BackupResult {
  /** Whether a backup was created */
  created: boolean;
  /** Path to the backup file (set even if already existed) */
  backupPath: string | null;
  /** Schema version of the database before migration */
  fromVersion: number;
  /** Target schema version */
  toVersion: number;
  /** Reason if backup was skipped */
  reason?: string;
}

/**
 * Create a pre-migration backup of a database file if a migration is needed.
 *
 * Must be called BEFORE migrateToLatest() and AFTER the db connection is open.
 * Checkpoints the WAL internally to ensure the .db file is consistent before copying.
 *
 * @param db - Open database connection (used for WAL checkpoint)
 * @param dbPath - Full path to the .db file
 * @param currentVersion - Current schema version in the database (from checkSchemaVersion)
 * @param targetVersion - Target schema version (SCHEMA_VERSION constant)
 * @returns BackupResult describing what happened
 */
export function createPreMigrationBackup(
  db: Database.Database,
  dbPath: string,
  currentVersion: number,
  targetVersion: number
): BackupResult {
  // Fresh database — nothing to back up
  if (currentVersion === 0) {
    return {
      created: false,
      backupPath: null,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      reason: 'fresh_database',
    };
  }

  // Already at target version — no migration needed
  if (currentVersion >= targetVersion) {
    return {
      created: false,
      backupPath: null,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      reason: 'already_current',
    };
  }

  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const backupName = `${base}.pre-migrate-v${String(currentVersion)}`;
  const backupPath = join(dir, backupName);

  // Don't overwrite an existing backup for the same version
  // (the first backup is the pristine copy before any migration attempt)
  if (existsSync(backupPath)) {
    console.error(
      `[pre-migration-backup] Backup already exists for v${String(currentVersion)}: ${backupPath}`
    );
    return {
      created: false,
      backupPath,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      reason: 'backup_exists',
    };
  }

  // Verify the source file exists
  if (!existsSync(dbPath)) {
    return {
      created: false,
      backupPath: null,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      reason: 'source_not_found',
    };
  }

  try {
    // Checkpoint WAL to flush all committed data into the main .db file.
    // TRUNCATE mode also zeros the WAL, giving us the cleanest possible copy.
    // If the checkpoint can't fully complete (e.g., concurrent reader), we still
    // copy the WAL/SHM files below as a safety net.
    db.pragma('wal_checkpoint(TRUNCATE)');

    // Copy the database file. SQLite in WAL mode may have -wal and -shm files.
    // We copy all three to get a consistent snapshot.
    copyFileSync(dbPath, backupPath);

    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      copyFileSync(walPath, `${backupPath}-wal`);
    }

    const shmPath = `${dbPath}-shm`;
    if (existsSync(shmPath)) {
      copyFileSync(shmPath, `${backupPath}-shm`);
    }

    const stats = statSync(backupPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    console.error(
      `[pre-migration-backup] Created backup before v${String(currentVersion)}→v${String(targetVersion)} migration: ${backupPath} (${sizeMB}MB)`
    );

    // Clean up old backups, keeping only the most recent MAX_BACKUPS
    cleanupOldBackups(dir, base, MAX_BACKUPS);

    return {
      created: true,
      backupPath,
      fromVersion: currentVersion,
      toVersion: targetVersion,
    };
  } catch (error) {
    // Backup failure should NOT prevent migration from proceeding.
    // Log a warning but don't throw.
    console.error(
      `[pre-migration-backup] WARNING: Failed to create backup: ${error instanceof Error ? error.message : String(error)}`
    );
    return {
      created: false,
      backupPath: null,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      reason: `backup_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Remove old pre-migration backups, keeping only the most recent `keep` count.
 * Sorted by version number extracted from filename (lowest version = oldest).
 */
export function cleanupOldBackups(dir: string, dbFileName: string, keep: number): void {
  try {
    const prefix = `${dbFileName}.pre-migrate-v`;
    const backupFiles = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && !f.endsWith('-wal') && !f.endsWith('-shm'))
      .map((f) => {
        // Extract version number from filename: "db.db.pre-migrate-v30" → 30
        const versionStr = f.slice(prefix.length);
        const version = parseInt(versionStr, 10) || 0;
        return { name: f, path: join(dir, f), version };
      })
      .sort((a, b) => a.version - b.version); // lowest version first

    if (backupFiles.length <= keep) {
      return;
    }

    const toDelete = backupFiles.slice(0, backupFiles.length - keep);
    for (const file of toDelete) {
      try {
        unlinkSync(file.path);
        // Also clean up associated WAL/SHM files
        const walFile = `${file.path}-wal`;
        if (existsSync(walFile)) unlinkSync(walFile);
        const shmFile = `${file.path}-shm`;
        if (existsSync(shmFile)) unlinkSync(shmFile);
        console.error(`[pre-migration-backup] Cleaned up old backup: ${file.name}`);
      } catch (err) {
        console.error(
          `[pre-migration-backup] Failed to delete old backup ${file.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (error) {
    // Cleanup failure is non-fatal
    console.error(
      `[pre-migration-backup] Failed to clean up old backups: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
