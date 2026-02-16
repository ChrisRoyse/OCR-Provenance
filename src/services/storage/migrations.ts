/**
 * Database Schema Migrations for OCR Provenance MCP System
 *
 * This module handles SQLite schema initialization and migrations.
 * Uses better-sqlite3 with sqlite-vec extension for vector storage.
 *
 * Security: All SQL uses parameterized queries via db.prepare()
 * Performance: WAL mode, proper indexes, foreign key constraints
 *
 * NOTE: This file is a facade for backwards compatibility.
 * The implementation has been modularized into the migrations/ directory.
 *
 * @module migrations
 */

// Re-export all public APIs from the modularized implementation
export {
  MigrationError,
  initializeDatabase,
  migrateToLatest,
  checkSchemaVersion,
  getCurrentSchemaVersion,
  configurePragmas,
  verifySchema,
} from './migrations/index.js';
