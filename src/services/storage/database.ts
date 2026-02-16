/**
 * DatabaseService for OCR Provenance MCP System
 *
 * This file serves as a facade for backwards compatibility.
 * All implementations have been modularized into src/services/storage/database/
 *
 * Provides all database operations for documents, OCR results, chunks,
 * embeddings, and provenance records.
 *
 * Security: All SQL uses parameterized queries via db.prepare() (SEC-006)
 * Performance: WAL mode, proper indexes, foreign key constraints
 * Permissions: Database files created with mode 0o600 (SEC-003)
 */

// Re-export everything from the modular database package
export type { DatabaseInfo, DatabaseStats, ListDocumentsOptions } from './database/index.js';
export {
  DatabaseErrorCode,
  DatabaseError,
  MigrationError,
  DatabaseService,
} from './database/index.js';
