/**
 * Storage Service Module
 *
 * Provides database initialization, migrations, and storage operations
 * for the OCR Provenance MCP System.
 */

export {
  initializeDatabase,
  checkSchemaVersion,
  migrateToLatest,
  getCurrentSchemaVersion,
  verifySchema,
  MigrationError,
} from './migrations.js';
