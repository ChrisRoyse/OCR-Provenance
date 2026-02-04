/**
 * Database Module - Public API
 *
 * Re-exports all public types, classes, and functions from the database module.
 * This file serves as the facade for backwards compatibility.
 */

// Re-export MigrationError from migrations for convenience
export { MigrationError } from '../migrations.js';

// Export types and error handling
export type { DatabaseInfo, DatabaseStats, ListDocumentsOptions } from './types.js';
export { DatabaseErrorCode, DatabaseError } from './types.js';

// Export the main service class
export { DatabaseService } from './service.js';
