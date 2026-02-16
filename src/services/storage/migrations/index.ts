/**
 * Database Schema Migrations for OCR Provenance MCP System
 *
 * This module handles SQLite schema initialization and migrations.
 * Uses better-sqlite3 with sqlite-vec extension for vector storage.
 *
 * Security: All SQL uses parameterized queries via db.prepare()
 * Performance: WAL mode, proper indexes, foreign key constraints
 *
 * @module migrations
 */

// Re-export types
export { MigrationError } from './types.js';

// Re-export main operations
export {
  initializeDatabase,
  migrateToLatest,
  checkSchemaVersion,
  getCurrentSchemaVersion,
} from './operations.js';

// Re-export schema helpers needed by static-operations
export { configurePragmas } from './schema-helpers.js';

// Re-export verification
export { verifySchema } from './verification.js';
