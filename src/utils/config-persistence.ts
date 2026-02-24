/**
 * Configuration Persistence Utilities
 *
 * Handles reading/writing config to the database_metadata table's config_json column.
 * Separated from tools/config.ts and server/state.ts to avoid circular dependencies.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module utils/config-persistence
 */

import type Database from 'better-sqlite3';

/**
 * Persist a config value to the database_metadata table's config_json column.
 *
 * Idempotently adds the config_json column if it doesn't exist.
 * Reads existing persisted config, merges the new value, and writes back.
 *
 * @param conn - better-sqlite3 Database connection
 * @param key - Config key name
 * @param value - Config value to persist
 */
export function persistConfigValue(
  conn: Database.Database,
  key: string,
  value: string | number | boolean,
): void {
  // Ensure config_json column exists (idempotent)
  const cols = conn.prepare('PRAGMA table_info(database_metadata)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'config_json')) {
    conn.exec("ALTER TABLE database_metadata ADD COLUMN config_json TEXT DEFAULT '{}'");
  }

  // Read existing config, merge, write back
  const row = conn.prepare('SELECT config_json FROM database_metadata WHERE id = 1').get() as
    | { config_json: string | null }
    | undefined;
  const existing: Record<string, unknown> = row?.config_json
    ? (JSON.parse(row.config_json) as Record<string, unknown>)
    : {};
  existing[key] = value;
  conn.prepare('UPDATE database_metadata SET config_json = ? WHERE id = 1').run(
    JSON.stringify(existing),
  );
}

/**
 * Load persisted config from the database_metadata table.
 *
 * Called when a database is selected to restore config changes
 * that were persisted from a previous session.
 *
 * @param conn - better-sqlite3 Database connection
 * @returns Record of persisted config key-value pairs, or empty object
 */
export function loadPersistedConfig(
  conn: Database.Database,
): Record<string, unknown> {
  try {
    // Check if config_json column exists
    const cols = conn.prepare('PRAGMA table_info(database_metadata)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'config_json')) {
      return {};
    }

    const row = conn.prepare('SELECT config_json FROM database_metadata WHERE id = 1').get() as
      | { config_json: string | null }
      | undefined;

    if (!row?.config_json) return {};
    return JSON.parse(row.config_json) as Record<string, unknown>;
  } catch (error) {
    console.error(
      `[config-persistence] Failed to load persisted config: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}
