/**
 * Helper functions for DatabaseService
 *
 * Contains utility functions for validation, path resolution,
 * and foreign key error handling.
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseError, DatabaseErrorCode } from './types.js';

/**
 * Default storage path for databases
 */
export const DEFAULT_STORAGE_PATH = join(homedir(), '.ocr-provenance', 'databases');

/**
 * Valid database name pattern: alphanumeric, underscores, hyphens
 */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate database name format
 */
export function validateName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new DatabaseError(
      'Database name is required and must be a string',
      DatabaseErrorCode.INVALID_NAME
    );
  }
  if (!VALID_NAME_PATTERN.test(name)) {
    throw new DatabaseError(
      `Invalid database name "${name}". Only alphanumeric characters, underscores, and hyphens are allowed.`,
      DatabaseErrorCode.INVALID_NAME
    );
  }
}

/**
 * Get full database path
 */
export function getDatabasePath(name: string, storagePath?: string): string {
  const basePath = storagePath ?? DEFAULT_STORAGE_PATH;
  return join(basePath, `${name}.db`);
}

/**
 * Helper function to run a statement with foreign key error handling.
 * Converts SQLite FK constraint errors to DatabaseError with proper code.
 *
 * @param stmt - Prepared statement to run
 * @param params - Parameters to bind
 * @param context - Error context message (e.g., "inserting document: provenance_id does not exist")
 */
export function runWithForeignKeyCheck(
  stmt: Database.Statement,
  params: unknown[],
  context: string
): Database.RunResult {
  try {
    return stmt.run(...params);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('FOREIGN KEY constraint failed')
    ) {
      throw new DatabaseError(
        `Foreign key violation ${context}`,
        DatabaseErrorCode.FOREIGN_KEY_VIOLATION,
        error
      );
    }
    throw error;
  }
}
