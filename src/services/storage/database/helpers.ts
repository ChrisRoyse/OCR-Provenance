/**
 * Helper functions for DatabaseService
 *
 * Contains utility functions for validation, path resolution,
 * foreign key error handling, and batched query execution.
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

/**
 * SQLite maximum parameter count per query. SQLite crashes at ~999 parameters.
 * We use 500 as default batch size to stay well under the limit.
 */
const DEFAULT_BATCH_SIZE = 500;

/**
 * Execute a query callback in batches to avoid SQLite's 999-parameter limit.
 *
 * When building queries with `IN (?, ?, ...)` clauses, SQLite crashes if
 * more than ~999 parameters are bound. This helper splits an array of IDs
 * into batches and calls the provided callback for each batch, concatenating
 * the results.
 *
 * @param ids - Full array of IDs to process
 * @param callback - Function that receives a batch of IDs and returns results
 * @param batchSize - Maximum IDs per batch (default 500)
 * @returns Concatenated results from all batches
 */
export function batchedQuery<T>(
  ids: string[],
  callback: (batch: string[]) => T[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): T[] {
  if (ids.length === 0) return [];
  if (ids.length <= batchSize) return callback(ids);

  const results: T[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    results.push(...callback(batch));
  }
  return results;
}
