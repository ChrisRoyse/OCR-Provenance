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
import { loadPersistedConfig } from '../utils/config-persistence.js';
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
  maxChunkSize: 8000,
  autoClusterEnabled: false,
  autoClusterThreshold: 10,
  autoClusterAlgorithm: 'hdbscan',
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
 * Active operation counter - tracks in-flight async database operations.
 * selectDatabase() and clearDatabase() refuse to proceed when > 0.
 */
let _activeOperations = 0;

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

// ═══════════════════════════════════════════════════════════════════════════════
// OPERATION TRACKING (H-1, H-2, M-9)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Begin tracking an in-flight database operation.
 *
 * Increments the active operation counter and returns the current generation.
 * While any operations are active, selectDatabase() and clearDatabase() will
 * throw to prevent database switches during async work.
 *
 * @returns Current database generation for later validation
 * @throws MCPError if no database is selected
 */
export function beginDatabaseOperation(): number {
  if (!state.currentDatabase) {
    throw databaseNotSelectedError();
  }
  _activeOperations++;
  return _dbGeneration;
}

/**
 * End tracking an in-flight database operation.
 *
 * Decrements the active operation counter. Counter never goes below 0.
 */
export function endDatabaseOperation(): void {
  if (_activeOperations > 0) {
    _activeOperations--;
  }
}

/**
 * Get the number of active database operations (for diagnostics/testing).
 */
export function getActiveOperationCount(): number {
  return _activeOperations;
}

/**
 * Execute an async function within a tracked database operation scope.
 *
 * Calls beginDatabaseOperation() before the function and endDatabaseOperation()
 * in a finally block, guaranteeing the counter is decremented even on error.
 * Also validates the generation after the function completes to detect any
 * mid-operation database switch.
 *
 * Use this for async tool handlers that do database writes across multiple
 * await points. Read-only synchronous handlers do not need this wrapper
 * because the event loop does not yield.
 *
 * @param fn - Async function receiving DatabaseServices
 * @returns The result of fn
 * @throws MCPError if no database is selected
 * @throws Error if the database was switched during the operation
 */
export async function withDatabaseOperation<T>(
  fn: (services: DatabaseServices) => Promise<T>
): Promise<T> {
  const generation = beginDatabaseOperation();
  try {
    const services = requireDatabase();
    const result = await fn(services);
    validateGeneration(generation);
    return result;
  } finally {
    endDatabaseOperation();
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
 * Apply persisted config from a database's config_json column.
 *
 * Called after database selection to restore config values that were
 * saved by handleConfigSet in a previous session.
 *
 * @param db - The newly opened DatabaseService
 */
function applyPersistedConfig(db: DatabaseService): void {
  try {
    const persisted = loadPersistedConfig(db.getConnection());
    if (Object.keys(persisted).length > 0) {
      // Apply each persisted config key using updateConfig
      const CONFIG_KEY_TO_STATE: Record<string, string> = {
        datalab_default_mode: 'defaultOCRMode',
        datalab_max_concurrent: 'maxConcurrent',
        embedding_batch_size: 'embeddingBatchSize',
        embedding_device: 'embeddingDevice',
        chunk_size: 'chunkSize',
        chunk_overlap_percent: 'chunkOverlapPercent',
        max_chunk_size: 'maxChunkSize',
        auto_cluster_enabled: 'autoClusterEnabled',
        auto_cluster_threshold: 'autoClusterThreshold',
        auto_cluster_algorithm: 'autoClusterAlgorithm',
      };

      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(persisted)) {
        const stateKey = CONFIG_KEY_TO_STATE[key];
        if (stateKey) {
          updates[stateKey] = value;
        }
      }

      if (Object.keys(updates).length > 0) {
        updateConfig(updates as Partial<ServerConfig>);
        console.error(
          `[state] Loaded ${Object.keys(updates).length} persisted config value(s) from database`
        );
      }
    }
  } catch (error) {
    console.error(
      `[state] Failed to apply persisted config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Select a database by name - opens connection and sets as current
 *
 * FAIL FAST: Throws immediately if database doesn't exist or if operations
 * are in-flight (H-2 guard). Uses atomic swap (M-9 fix): opens new DB first,
 * then swaps state, then closes old DB -- no null window.
 *
 * @param name - Database name to select
 * @param storagePath - Optional storage path override
 * @throws MCPError with DATABASE_NOT_FOUND if database doesn't exist
 * @throws Error if database operations are in-flight
 */
export function selectDatabase(name: string, storagePath?: string): void {
  const path = storagePath ?? state.config.defaultStoragePath;

  // H-2: Refuse to switch while async operations are in-flight
  if (_activeOperations > 0) {
    throw new Error(
      `Cannot switch databases while ${_activeOperations} operation(s) are in-flight. ` +
        `Wait for active operations to complete before switching databases.`
    );
  }

  // Verify database exists BEFORE any state changes - FAIL FAST
  // If the new DB doesn't exist, the old connection stays open and usable.
  if (!DatabaseService.exists(name, path)) {
    throw databaseNotFoundError(name, path);
  }

  // WAL/mmap safety: When re-opening the SAME database file, the old connection's
  // memory-mapped SHM region must be released BEFORE opening a new connection.
  // Two concurrent connections to the same file with mmap_size > 0 can cause
  // "database disk image is malformed" if the file was modified externally.
  // For DIFFERENT databases, use M-9 atomic swap (open new → swap → close old)
  // to avoid a null window in state.currentDatabase.
  const oldDb = state.currentDatabase;
  const isSameDb = oldDb && state.currentDatabaseName === name;

  if (isSameDb) {
    // Same DB: close old connection FIRST to release mmap/SHM locks
    state.currentDatabase = null;
    state.currentDatabaseName = null;
    _cachedVectorService = null;
    oldDb.close();
  }

  let newDb: DatabaseService;
  try {
    newDb = DatabaseService.open(name, path);
  } catch (error) {
    // If opening fails after we already closed the old connection (same-DB path),
    // state is already null — the error propagates and the caller sees it.
    // For the different-DB path, the old connection is still intact.
    throw error;
  }

  // Close old connection for the different-DB path (M-9 atomic swap)
  if (!isSameDb && oldDb) {
    oldDb.close();
  }

  // Update state to point to the new connection
  state.currentDatabase = newDb;
  state.currentDatabaseName = name;
  _cachedVectorService = null;
  _dbGeneration++;

  // Load persisted config from the database (if any)
  applyPersistedConfig(newDb);
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
    // H-3: Refuse to switch while async operations are in-flight
    if (_activeOperations > 0) {
      // Close the newly created DB since we can't switch to it
      db.close();
      throw new Error(
        `Cannot auto-select newly created database "${name}" while ${_activeOperations} operation(s) are in-flight. ` +
          `Wait for active operations to complete, then select the database manually.`
      );
    }

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
 * Clear current database selection - closes connection.
 *
 * FAIL FAST: Throws if async operations are in-flight (H-2 guard).
 * The forceClose parameter bypasses the guard for internal use only
 * (resetState in tests, process exit cleanup).
 *
 * @param forceClose - Skip operation guard (internal use only)
 * @throws Error if database operations are in-flight and forceClose is false
 */
export function clearDatabase(forceClose: boolean = false): void {
  // H-2: Refuse to clear while async operations are in-flight
  if (!forceClose && _activeOperations > 0) {
    throw new Error(
      `Cannot clear database while ${_activeOperations} operation(s) are in-flight. ` +
        `Wait for active operations to complete before clearing the database.`
    );
  }

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
 *
 * Uses forceClose=true to bypass the operation guard since tests
 * need to reset state unconditionally between test cases.
 */
export function resetState(): void {
  clearDatabase(/* forceClose */ true);
  _cachedVectorService = null;
  _dbGeneration = 0;
  _activeOperations = 0;
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
