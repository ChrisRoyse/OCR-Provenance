/**
 * Vitest Global Teardown
 *
 * Cleans up leaked temporary directories from test runs.
 * Test cleanup hooks don't execute when processes are killed,
 * so this ensures temp dirs are cleaned up after all tests complete.
 *
 * @module tests/global-teardown
 */

import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Glob-like prefixes of temp directories created by tests */
const TEMP_DIR_PREFIXES = [
  'search-bm25-',
  'vlm-schema-',
  'test-image-semantic-',
  'test-img-search-',
  'test-img-sem-',
  'test-img-reanalyze-',
  'test-chunk-',
  'test-emb-',
  'test-export-',
  'test-prov-',
  'test-tag-',
  'test-health-',
  'test-comp-',
  'test-cluster-',
  'test-doc-',
  'test-workflow-',
  'test-file-',
  'test-search-',
  'test-report-',
  'test-db-',
  'test-ingest-',
  'test-extract-',
  'emb-filter-',
  'emb-get-tool-',
  'emb-list-tool-',
  'emb-stats-tool-',
];

export default function globalTeardown(): void {
  const tmp = tmpdir();
  let entries: string[];

  try {
    entries = readdirSync(tmp);
  } catch {
    // Cannot read tmpdir - nothing to clean
    return;
  }

  let cleaned = 0;
  for (const entry of entries) {
    const isTestDir = TEMP_DIR_PREFIXES.some((prefix) => entry.startsWith(prefix));
    if (isTestDir) {
      try {
        rmSync(join(tmp, entry), { recursive: true, force: true });
        cleaned++;
      } catch {
        // Best-effort cleanup - ignore errors from locked files
      }
    }
  }

  if (cleaned > 0) {
    // Use stderr to avoid polluting JSON-RPC stdout
    console.error(`[global-teardown] Cleaned ${cleaned} leaked temp directories`);
  }
}
