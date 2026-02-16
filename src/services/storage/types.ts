/**
 * Shared types for storage services
 */

import Database from 'better-sqlite3';

/**
 * Type definition for sqlite-vec module
 * Used by both migrations.ts and database.ts for loading the vector extension
 */
export interface SqliteVecModule {
  load: (db: Database.Database) => void;
}
