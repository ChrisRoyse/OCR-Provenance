/**
 * MCP Server State Management
 *
 * Manages global server state including current database connection and configuration.
 * FAIL FAST: All state access throws immediately if preconditions not met.
 *
 * @module server/state
 */

import { DatabaseService } from '../services/storage/database/index.js';
import { VectorService } from '../services/storage/vector.js';
import { DEFAULT_STORAGE_PATH } from '../services/storage/database/helpers.js';
import {
  databaseNotSelectedError,
  databaseNotFoundError,
  databaseAlreadyExistsError,
} from './errors.js';
import type { ServerState, ServerConfig } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default server configuration
 */
const defaultConfig: ServerConfig = {
  defaultStoragePath: DEFAULT_STORAGE_PATH,
  defaultOCRMode: 'balanced',
  maxConcurrent: 3,
  embeddingBatchSize: 32,
  embeddingDevice: 'auto',
  chunkSize: 2000,
  chunkOverlapPercent: 10,
  imageOptimization: {
    enabled: true,
    ocrMaxWidth: 4800,
    vlmMaxDimension: 2048,
    vlmSkipBelowSize: 50,
    vlmMinRelevance: 0.3,
    vlmSkipLogosIcons: true,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Global server state
 * Mutable state for current database and configuration
 */
export const state: ServerState = {
  currentDatabase: null,
  currentDatabaseName: null,
  config: { ...defaultConfig },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE ACCESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Services returned from requireDatabase
 */
interface DatabaseServices {
  db: DatabaseService;
  vector: VectorService;
  /** Generation counter for detecting stale references */
  generation: number;
}

/**
 * Cached VectorService instance - cleared on database change
 */
let _cachedVectorService: VectorService | null = null;

/**
 * Generation counter - incremented on every database switch/clear.
 */
let _dbGeneration = 0;

/**
 * Require database to be selected - FAIL FAST if not
 *
 * @returns Database service, vector service, and generation counter
 * @throws MCPError with DATABASE_NOT_SELECTED if no database is selected
 */
export function requireDatabase(): DatabaseServices {
  if (!state.currentDatabase) {
    throw databaseNotSelectedError();
  }

  if (!_cachedVectorService) {
    _cachedVectorService = new VectorService(state.currentDatabase.getConnection());
  }
  return { db: state.currentDatabase, vector: _cachedVectorService, generation: _dbGeneration };
}

/**
 * Validate that the database generation matches the expected value.
 *
 * The generation counter increments on every database switch/clear. A mismatch
 * means the database was switched between the time a caller obtained the
 * generation and the time it validates -- indicating a race condition where
 * the caller's database reference is stale.
 *
 * Callers can optionally use this at critical points (e.g., before writing
 * results back to the database) to detect and fail fast on stale references.
 *
 * @param expectedGeneration - The generation value obtained from requireDatabase()
 * @throws Error if the current generation does not match
 */
export function validateGeneration(expectedGeneration: number): void {
  if (_dbGeneration !== expectedGeneration) {
    throw new Error(
      `Database generation mismatch: expected ${expectedGeneration}, current ${_dbGeneration}. ` +
        `The database was switched during this operation. Retry with the current database.`
    );
  }
}

/**
 * Check if a database is currently selected
 */
export function hasDatabase(): boolean {
  return state.currentDatabase !== null;
}

/**
 * Get current database name or null
 */
export function getCurrentDatabaseName(): string | null {
  return state.currentDatabaseName;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Select a database by name - opens connection and sets as current
 *
 * FAIL FAST: Throws immediately if database doesn't exist
 *
 * @param name - Database name to select
 * @param storagePath - Optional storage path override
 * @throws MCPError with DATABASE_NOT_FOUND if database doesn't exist
 */
export function selectDatabase(name: string, storagePath?: string): void {
  const path = storagePath ?? state.config.defaultStoragePath;

  // Close existing connection first
  if (state.currentDatabase) {
    state.currentDatabase.close();
    state.currentDatabase = null;
    state.currentDatabaseName = null;
    _cachedVectorService = null;
  }
  _dbGeneration++;

  // Verify database exists - FAIL FAST
  if (!DatabaseService.exists(name, path)) {
    throw databaseNotFoundError(name, path);
  }

  // Open the database
  state.currentDatabase = DatabaseService.open(name, path);
  state.currentDatabaseName = name;
}

/**
 * Create a new database and optionally select it
 *
 * FAIL FAST: Throws immediately if database already exists
 *
 * @param name - Database name to create
 * @param description - Optional description
 * @param storagePath - Optional storage path override
 * @param autoSelect - Whether to select the database after creation (default: true)
 * @returns The created database service
 * @throws MCPError with DATABASE_ALREADY_EXISTS if database exists
 */
export function createDatabase(
  name: string,
  description?: string,
  storagePath?: string,
  autoSelect: boolean = true
): DatabaseService {
  const path = storagePath ?? state.config.defaultStoragePath;

  // Check if database already exists - FAIL FAST
  if (DatabaseService.exists(name, path)) {
    throw databaseAlreadyExistsError(name);
  }

  // Create the database
  const db = DatabaseService.create(name, description, path);

  if (autoSelect) {
    // Close any existing connection first
    if (state.currentDatabase) {
      state.currentDatabase.close();
    }
    _cachedVectorService = null;
    _dbGeneration++;
    state.currentDatabase = db;
    state.currentDatabaseName = name;
  }
  // When autoSelect=false, return the open DB -- caller manages lifecycle.
  // Previously the DB was closed here making the returned service dead.

  return db;
}

/**
 * Delete a database
 *
 * FAIL FAST: Throws if database doesn't exist
 *
 * @param name - Database name to delete
 * @param storagePath - Optional storage path override
 * @throws MCPError with DATABASE_NOT_FOUND if database doesn't exist
 */
export function deleteDatabase(name: string, storagePath?: string): void {
  const path = storagePath ?? state.config.defaultStoragePath;

  // Verify database exists - FAIL FAST
  if (!DatabaseService.exists(name, path)) {
    throw databaseNotFoundError(name, path);
  }

  // If this is the current database, clear state first
  if (state.currentDatabaseName === name) {
    clearDatabase();
  }

  // Delete the database
  DatabaseService.delete(name, path);
}

/**
 * Clear current database selection - closes connection
 */
export function clearDatabase(): void {
  if (state.currentDatabase) {
    state.currentDatabase.close();
    state.currentDatabase = null;
    state.currentDatabaseName = null;
    _cachedVectorService = null;
    _dbGeneration++;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current server configuration
 */
export function getConfig(): ServerConfig {
  return { ...state.config };
}

/**
 * Update server configuration (deep merges nested objects like imageOptimization)
 */
export function updateConfig(updates: Partial<ServerConfig>): void {
  // Deep merge imageOptimization if both existing and update have it
  if (updates.imageOptimization && state.config.imageOptimization) {
    updates = {
      ...updates,
      imageOptimization: {
        ...state.config.imageOptimization,
        ...updates.imageOptimization,
      },
    };
  }
  state.config = { ...state.config, ...updates };
}

/**
 * Reset configuration to defaults
 */
export function resetConfig(): void {
  state.config = { ...defaultConfig };
}

/**
 * Get default storage path
 */
export function getDefaultStoragePath(): string {
  return state.config.defaultStoragePath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE RESET (FOR TESTING)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset all server state - ONLY USE IN TESTS
 */
export function resetState(): void {
  clearDatabase();
  _cachedVectorService = null;
  _dbGeneration = 0;
  state.config = { ...defaultConfig };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS EXIT CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * L-5: Clean up database connections on process exit.
 * Ensures WAL/SHM files are properly checkpointed.
 */
process.on('exit', () => {
  if (state.currentDatabase) {
    try {
      state.currentDatabase.close();
    } catch (error) {
      console.error(
        '[state] database close on exit failed:',
        error instanceof Error ? error.message : String(error)
      );
      // Continue exit cleanup despite error
    }
    state.currentDatabase = null;
    state.currentDatabaseName = null;
  }
});
