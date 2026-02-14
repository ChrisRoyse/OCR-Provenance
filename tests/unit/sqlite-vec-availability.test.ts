/**
 * TS-03: sqlite-vec Availability Check
 *
 * Many tests use `skipIf(!sqliteVecAvailable)` which silently skips critical
 * test coverage when sqlite-vec is not installed. This test makes the skip
 * VISIBLE by logging which test categories are affected.
 *
 * @module tests/unit/sqlite-vec-availability
 */

import { describe, it, expect } from 'vitest';

function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

// Test categories that depend on sqlite-vec
const SQLITE_VEC_DEPENDENT_CATEGORIES = [
  'tests/unit/migrations/ (12+ migration test files)',
  'tests/unit/tools/search.test.ts (semantic + hybrid search)',
  'tests/unit/tools/knowledge-graph.test.ts',
  'tests/unit/tools/entity-analysis.test.ts',
  'tests/unit/tools/comparison.test.ts',
  'tests/unit/tools/clustering.test.ts',
  'tests/unit/tools/documents.test.ts',
  'tests/unit/tools/provenance.test.ts',
  'tests/unit/tools/search-export.test.ts',
  'tests/unit/tools/reports-cost.test.ts',
  'tests/unit/tools/file-management.test.ts',
  'tests/unit/tools/ingestion-reprocess.test.ts',
  'tests/unit/tools/database.test.ts',
  'tests/unit/database/ (lifecycle, chunks, embeddings, etc.)',
  'tests/unit/vector/vector-service.test.ts',
  'tests/unit/services/search/vlm-search-integration.test.ts',
  'tests/unit/services/search/quality-filter.test.ts',
  'tests/unit/services/clustering/',
  'tests/unit/services/comparison/',
  'tests/unit/services/knowledge-graph/',
  'tests/unit/services/storage/kg-archive.test.ts',
  'tests/integration/server/ (database, document, provenance, ingestion tools)',
  'tests/integration/value-enhancement-verification.test.ts',
  'tests/integration/task-7-8-full-state-verification.test.ts',
  'tests/manual/ (multiple verification test files)',
];

describe('sqlite-vec availability', () => {
  it('reports sqlite-vec availability status', () => {
    if (sqliteVecAvailable) {
      // sqlite-vec is available - all dependent tests will run
      expect(sqliteVecAvailable).toBe(true);
    } else {
      // sqlite-vec is NOT available - log which tests are being skipped
      console.error('');
      console.error('='.repeat(78));
      console.error('[WARNING] sqlite-vec is NOT available in this environment');
      console.error('='.repeat(78));
      console.error('');
      console.error('The following test categories use skipIf(!sqliteVecAvailable) and');
      console.error('will SILENTLY SKIP many critical tests:');
      console.error('');
      for (const category of SQLITE_VEC_DEPENDENT_CATEGORIES) {
        console.error(`  - ${category}`);
      }
      console.error('');
      console.error('To install sqlite-vec: npm install sqlite-vec');
      console.error('='.repeat(78));
      console.error('');

      // Test passes but with visible warning - we do not fail the build
      // because sqlite-vec may not be available in all CI environments
      expect(sqliteVecAvailable).toBe(false);
    }
  });
});
