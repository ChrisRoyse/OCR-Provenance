/**
 * Vitest global setup/teardown — cleans stale test databases from the default storage path.
 *
 * Runs AFTER all test suites complete. Deletes .db/.wal/.shm files in
 * ~/.ocr-provenance/databases/ that:
 *   1. Match common test-database naming patterns, AND
 *   2. Were modified within the last hour (i.e., created during this run)
 *
 * This prevents unbounded accumulation of throwaway databases from test runs.
 */

import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TEST_DB_PATTERNS = [
  /^contra-test-/,
  /^task\d+-verify-/,
  /-test-\d+/,
  /-verify-\d+/,
  /^test-/,
  /^temp-/,
  /^tmp-/,
];

const DB_DIR = join(homedir(), '.ocr-provenance', 'databases');
const ONE_HOUR_MS = 60 * 60 * 1000;

function isTestDatabase(name: string): boolean {
  return TEST_DB_PATTERNS.some((pattern) => pattern.test(name));
}

export function teardown(): void {
  let entries: string[];
  try {
    entries = readdirSync(DB_DIR);
  } catch {
    return; // Directory doesn't exist — nothing to clean
  }

  const cutoff = Date.now() - ONE_HOUR_MS;
  let cleaned = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.db') && !entry.endsWith('.db-wal') && !entry.endsWith('.db-shm')) {
      continue;
    }

    const baseName = entry.replace(/\.db(-wal|-shm)?$/, '');
    if (!isTestDatabase(baseName)) continue;

    const fullPath = join(DB_DIR, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.mtimeMs >= cutoff) {
        unlinkSync(fullPath);
        cleaned++;
      }
    } catch {
      // File may have been deleted by another process
    }
  }

  if (cleaned > 0) {
    console.log(`[global-teardown] Cleaned ${cleaned} stale test database files from ${DB_DIR}`);
  }
}
