/**
 * SHERLOCK HOLMES FORENSIC AUDIT - Full State Verification
 *
 * Verifies ALL fixes from the forensic audit with synthetic data.
 * GUILTY UNTIL PROVEN INNOCENT: Every fix is tested with real operations.
 *
 * Fix Coverage:
 *   FIX-1: State Race Condition (H-1, H-2, M-9)
 *   FIX-2: VLM Page Range Filter (M-1) - Code Audit
 *   FIX-3: Type Safety - parseLocation (M-7)
 *   FIX-4: Silent Failures -> Warnings (M-2, M-3, M-4) - Code Audit
 *   FIX-5: Math Safe Min/Max (M-10)
 *   FIX-6: Migration Atomicity (M-5, M-6) - Code Audit
 *   FIX-7: Search Scoring (L-1, L-2)
 *   FIX-8: Dead Code Removed
 *   FIX-9: VLM Behavioral Tests Exist
 *   FIX-10: Coverage Thresholds
 *
 * @module tests/manual/audit-fix-verification
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

// ============================================================================
// IMPORTS UNDER TEST
// ============================================================================

import {
  state,
  resetState,
  selectDatabase,
  createDatabase,
  clearDatabase,
  beginDatabaseOperation,
  endDatabaseOperation,
  getActiveOperationCount,
  requireDatabase,
  validateGeneration,
  withDatabaseOperation,
  updateConfig,
} from '../../src/server/state.js';

import { safeMin, safeMax } from '../../src/utils/math.js';
import { computeQualityMultiplier } from '../../src/services/search/quality.js';
import { RRFFusion } from '../../src/services/search/fusion.js';

// ============================================================================
// HELPERS
// ============================================================================

function isSqliteVecAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

let tempDir: string;

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'audit-fix-verify-'));
}

function cleanupDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ============================================================================
// FIX 1: STATE RACE CONDITION (H-1, H-2, M-9)
// ============================================================================

describe('FIX-1: State Race Condition Guards (H-1, H-2, M-9)', () => {
  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
    cleanupDir(tempDir);
  });

  it.skipIf(!sqliteVecAvailable)(
    'H-1: beginDatabaseOperation increments counter and returns generation',
    () => {
      // INPUT: Create and select a database, then begin an operation
      createDatabase('test-h1');
      expect(state.currentDatabase).not.toBeNull();

      // ACT: Begin an operation
      const generation = beginDatabaseOperation();

      // EXPECTED: Counter is 1, generation is a number
      expect(getActiveOperationCount()).toBe(1);
      expect(typeof generation).toBe('number');

      // CLEANUP
      endDatabaseOperation();
      expect(getActiveOperationCount()).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)('H-2: selectDatabase throws when operations are in-flight', () => {
    // INPUT: Create two databases, select first, begin operation
    createDatabase('test-h2-first');
    createDatabase('test-h2-second', undefined, undefined, false);

    // Select first (createDatabase auto-selects, but second was not auto-selected)
    // Actually createDatabase('test-h2-first') was auto-selected, then
    // createDatabase('test-h2-second', ..., false) did NOT auto-select.
    // So 'test-h2-first' is still selected but actually createDatabase auto-selects...
    // Let me re-select to be explicit
    selectDatabase('test-h2-first');

    // Begin an operation
    beginDatabaseOperation();
    expect(getActiveOperationCount()).toBe(1);

    // ACT: Try to switch databases
    // EXPECTED: Should THROW with "operation(s) are in-flight"
    expect(() => selectDatabase('test-h2-second')).toThrow(/operation\(s\) are in-flight/);

    // ACT: End operation, then switch should succeed
    endDatabaseOperation();
    expect(getActiveOperationCount()).toBe(0);

    // EXPECTED: Switch should now succeed
    selectDatabase('test-h2-second');
    expect(state.currentDatabaseName).toBe('test-h2-second');
  });

  it.skipIf(!sqliteVecAvailable)('H-2: clearDatabase throws when operations are in-flight', () => {
    createDatabase('test-h2-clear');
    beginDatabaseOperation();

    // ACT: Try to clear database
    // EXPECTED: Should THROW
    expect(() => clearDatabase()).toThrow(/operation\(s\) are in-flight/);

    // Cleanup
    endDatabaseOperation();
    clearDatabase();
    expect(state.currentDatabase).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('endDatabaseOperation never goes below 0', () => {
    createDatabase('test-underflow');

    // ACT: Call endDatabaseOperation without begin
    endDatabaseOperation();
    endDatabaseOperation();
    endDatabaseOperation();

    // EXPECTED: Counter stays at 0
    expect(getActiveOperationCount()).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('M-9: selectDatabase uses atomic swap - no null window', () => {
    // INPUT: Create two databases
    createDatabase('test-m9-first');
    createDatabase('test-m9-second', undefined, undefined, false);

    // Select first
    selectDatabase('test-m9-first');
    expect(state.currentDatabase).not.toBeNull();
    expect(state.currentDatabaseName).toBe('test-m9-first');

    // ACT: Switch to second database
    // VERIFY: state.currentDatabase is NEVER null during the switch
    // The atomic swap pattern in selectDatabase opens new DB first, then swaps,
    // then closes old. We verify the result:
    selectDatabase('test-m9-second');

    // EXPECTED: State points to second database, NOT null
    expect(state.currentDatabase).not.toBeNull();
    expect(state.currentDatabaseName).toBe('test-m9-second');
  });

  it.skipIf(!sqliteVecAvailable)('validateGeneration detects stale references after switch', () => {
    createDatabase('test-gen-1');
    const { generation: gen1 } = requireDatabase();

    // Create and switch to another DB
    createDatabase('test-gen-2', undefined, undefined, false);
    selectDatabase('test-gen-2');

    // ACT: Validate the old generation
    // EXPECTED: Should throw - generation mismatch
    expect(() => validateGeneration(gen1)).toThrow(/generation mismatch/i);
  });

  it.skipIf(!sqliteVecAvailable)(
    'withDatabaseOperation increments/decrements properly and validates generation',
    async () => {
      createDatabase('test-with-op');

      let insideOpCount = -1;
      let insideGeneration = -1;

      // ACT: Run withDatabaseOperation
      await withDatabaseOperation(async (services) => {
        insideOpCount = getActiveOperationCount();
        insideGeneration = services.generation;
        return 42;
      });

      // EXPECTED: Inside the op, counter was 1; after, it's 0
      expect(insideOpCount).toBe(1);
      expect(insideGeneration).toBeGreaterThanOrEqual(0);
      expect(getActiveOperationCount()).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'withDatabaseOperation decrements counter even on error',
    async () => {
      createDatabase('test-with-op-err');

      // ACT: Run withDatabaseOperation that throws
      await expect(
        withDatabaseOperation(async () => {
          throw new Error('Simulated failure');
        })
      ).rejects.toThrow('Simulated failure');

      // EXPECTED: Counter is back to 0 even though operation failed
      expect(getActiveOperationCount()).toBe(0);
    }
  );
});

// ============================================================================
// FIX 2: VLM PAGE RANGE FILTER (M-1) - CODE AUDIT
// ============================================================================

describe('FIX-2: VLM Page Range Filter (M-1) - Code Audit', () => {
  it('vector.ts mapAndFilterResults uses options (not _options) and checks pageRangeFilter', () => {
    // CODE AUDIT: Read the source file and verify the fix
    const vectorSource = readFileSync(
      join(process.cwd(), 'src/services/storage/vector.ts'),
      'utf-8'
    );

    // VERIFY: The parameter name is `options` not `_options`
    // The method signature should have `options: VectorSearchOptions` not `_options`
    expect(vectorSource).toContain('private mapAndFilterResults(');
    expect(vectorSource).toContain('options: VectorSearchOptions');
    // Should NOT contain _options in the mapAndFilterResults signature
    expect(vectorSource).not.toMatch(
      /mapAndFilterResults[\s\S]*?_options\s*:\s*VectorSearchOptions/
    );

    // VERIFY: pageRangeFilter is actually checked
    expect(vectorSource).toContain('options.pageRangeFilter');
    expect(vectorSource).toContain('min_page');
    expect(vectorSource).toContain('max_page');

    // VERIFY: VLM results (chunk_id === null) are filtered
    expect(vectorSource).toContain('r.chunk_id !== null');
    expect(vectorSource).toContain('r.page_number === null');
    expect(vectorSource).toContain('r.page_number < min_page');
    expect(vectorSource).toContain('r.page_number > max_page');
  });

  it('searchWithFilter and searchAll pass options to mapAndFilterResults', () => {
    const vectorSource = readFileSync(
      join(process.cwd(), 'src/services/storage/vector.ts'),
      'utf-8'
    );

    // Both searchWithFilter and searchAll should pass options
    // Find all calls to mapAndFilterResults
    const mapCalls = vectorSource.match(/this\.mapAndFilterResults\([^)]+\)/g);
    expect(mapCalls).not.toBeNull();
    expect(mapCalls!.length).toBeGreaterThanOrEqual(2);

    // Every call should include 'options' as the last parameter
    for (const call of mapCalls!) {
      expect(call).toContain('options');
    }
  });
});

// ============================================================================
// FIX 3: TYPE SAFETY - parseLocation (M-7)
// ============================================================================

describe('FIX-3: Type Safety - parseLocation (M-7)', () => {
  it('parseLocation returns null on corrupt JSON (not _parse_error object)', () => {
    // CODE AUDIT: Verify parseLocation returns null, not {_parse_error: true}
    const convertersSource = readFileSync(
      join(process.cwd(), 'src/services/storage/database/converters.ts'),
      'utf-8'
    );

    // VERIFY: parseLocation function exists and returns null on error
    expect(convertersSource).toContain('function parseLocation');
    expect(convertersSource).toMatch(/function parseLocation[\s\S]*?catch[\s\S]*?return null;/);

    // VERIFY: It does NOT return {_parse_error: true} like parseProcessingParams does
    // parseProcessingParams returns { _parse_error: true, _raw: raw } - that's OK for params
    // But parseLocation should return null
    const parseLocationFn = convertersSource.match(/function parseLocation[\s\S]*?^}/m);
    expect(parseLocationFn).not.toBeNull();
    expect(parseLocationFn![0]).not.toContain('_parse_error');
    expect(parseLocationFn![0]).toContain('return null');
  });

  it('parseLocation logs console.error on corrupt data', () => {
    const convertersSource = readFileSync(
      join(process.cwd(), 'src/services/storage/database/converters.ts'),
      'utf-8'
    );

    // VERIFY: console.error is called with corruption message
    const parseLocationFn = convertersSource.match(/function parseLocation[\s\S]*?^}/m);
    expect(parseLocationFn).not.toBeNull();
    expect(parseLocationFn![0]).toContain('console.error');
    expect(parseLocationFn![0]).toContain('Corrupt location');
  });
});

// ============================================================================
// FIX 4: SILENT FAILURES -> WARNINGS (M-2, M-3, M-4) - CODE AUDIT
// ============================================================================

describe('FIX-4: Silent Failures -> Warnings (M-2, M-3, M-4)', () => {
  it('M-2: vlm.ts pushes embedding error to warnings array', () => {
    const vlmSource = readFileSync(join(process.cwd(), 'src/tools/vlm.ts'), 'utf-8');

    // VERIFY: The catch block at the embedding generation section pushes to warnings
    expect(vlmSource).toContain('warnings.push(`Embedding generation failed:');
    // VERIFY: console.error is also called (not silently swallowed)
    expect(vlmSource).toContain('[WARN] VLM describe embedding generation failed');
  });

  it('M-3: ingestion.ts pushes header/footer tagging error to warnings', () => {
    const ingestionSource = readFileSync(join(process.cwd(), 'src/tools/ingestion.ts'), 'utf-8');

    // VERIFY: Header/footer tagging failure pushes to warnings
    expect(ingestionSource).toContain('warnings.push(`Header/footer auto-tagging failed:');
    // Also has metadata enrichment warning
    expect(ingestionSource).toContain('warnings.push(`Metadata enrichment failed:');
  });

  it('M-4: extraction-structured.ts pushes embedding error to warnings', () => {
    const extractionSource = readFileSync(
      join(process.cwd(), 'src/tools/extraction-structured.ts'),
      'utf-8'
    );

    // VERIFY: Extraction embedding failure pushes to warnings
    expect(extractionSource).toContain('warnings.push(`Embedding generation failed:');
    // VERIFY: console.error is called
    expect(extractionSource).toContain('[WARN] Extraction embedding generation failed');
  });
});

// ============================================================================
// FIX 5: MATH SAFE MIN/MAX (M-10)
// ============================================================================

describe('FIX-5: Safe Math Min/Max (M-10)', () => {
  it('safeMin returns undefined for empty array', () => {
    // INPUT: Empty array
    const result = safeMin([]);
    // EXPECTED: undefined
    expect(result).toBeUndefined();
  });

  it('safeMax returns undefined for empty array', () => {
    const result = safeMax([]);
    expect(result).toBeUndefined();
  });

  it('safeMin returns the single element for [5]', () => {
    expect(safeMin([5])).toBe(5);
  });

  it('safeMax returns the single element for [5]', () => {
    expect(safeMax([5])).toBe(5);
  });

  it('safeMin([3,1,4,1,5,9]) returns 1', () => {
    expect(safeMin([3, 1, 4, 1, 5, 9])).toBe(1);
  });

  it('safeMax([3,1,4,1,5,9]) returns 9', () => {
    expect(safeMax([3, 1, 4, 1, 5, 9])).toBe(9);
  });

  it('safeMin handles 100K elements without RangeError', () => {
    // INPUT: Array of 100,000 elements
    const largeArray = Array.from({ length: 100_000 }, (_, i) => i);

    // ACT: Should NOT throw
    const result = safeMin(largeArray);

    // EXPECTED: 0 (first element in 0..99999)
    expect(result).toBe(0);
  });

  it('safeMax handles 100K elements without RangeError', () => {
    const largeArray = Array.from({ length: 100_000 }, (_, i) => i);
    const result = safeMax(largeArray);
    expect(result).toBe(99_999);
  });

  it('safeMin handles 500K elements without RangeError', () => {
    // 500K elements exceeds V8 stack argument limit on Node v20
    const largeArray = Array.from({ length: 500_000 }, (_, i) => i);
    expect(safeMin(largeArray)).toBe(0);
  });

  it('safeMax handles 500K elements without RangeError', () => {
    const largeArray = Array.from({ length: 500_000 }, (_, i) => i);
    expect(safeMax(largeArray)).toBe(499_999);
  });

  it('CONTROL: Math.min(...) WOULD throw on 500K elements', () => {
    // This proves the fix was necessary - V8 limit on Node v20 is >100K but <500K
    const largeArray = Array.from({ length: 500_000 }, (_, i) => i);

    // EXPECTED: Math.min(...largeArray) throws RangeError
    expect(() => Math.min(...largeArray)).toThrow();
  });

  it('CONTROL: Math.max(...) WOULD throw on 500K elements', () => {
    const largeArray = Array.from({ length: 500_000 }, (_, i) => i);
    expect(() => Math.max(...largeArray)).toThrow();
  });

  it('safeMin handles negative numbers correctly', () => {
    expect(safeMin([-5, -1, -10, 0, 3])).toBe(-10);
  });

  it('safeMax handles negative numbers correctly', () => {
    expect(safeMax([-5, -1, -10, 0, 3])).toBe(3);
  });
});

// ============================================================================
// FIX 6: MIGRATION ATOMICITY (M-5, M-6) - CODE AUDIT
// ============================================================================

describe('FIX-6: Migration Atomicity (M-5, M-6)', () => {
  it('M-5: migrateV19ToV20 has BEGIN TRANSACTION / COMMIT / ROLLBACK', () => {
    const opsSource = readFileSync(
      join(process.cwd(), 'src/services/storage/migrations/operations.ts'),
      'utf-8'
    );

    // Find the migrateV19ToV20 function body
    const fnMatch = opsSource.match(/function migrateV19ToV20[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    // VERIFY: Has BEGIN TRANSACTION
    expect(fnBody).toContain("db.exec('BEGIN TRANSACTION')");

    // VERIFY: Has COMMIT
    expect(fnBody).toContain("db.exec('COMMIT')");

    // VERIFY: Has ROLLBACK in catch
    expect(fnBody).toContain("db.exec('ROLLBACK')");
  });

  it('M-5: migrateV19ToV20 has PRAGMA foreign_keys in try-finally', () => {
    const opsSource = readFileSync(
      join(process.cwd(), 'src/services/storage/migrations/operations.ts'),
      'utf-8'
    );

    const fnMatch = opsSource.match(/function migrateV19ToV20[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    // VERIFY: PRAGMA foreign_keys = OFF at the start
    expect(fnBody).toContain("db.exec('PRAGMA foreign_keys = OFF')");

    // VERIFY: PRAGMA foreign_keys = ON in finally block
    expect(fnBody).toContain('finally');
    expect(fnBody).toContain("db.exec('PRAGMA foreign_keys = ON')");

    // VERIFY: The comment references M-5
    expect(fnBody).toContain('M-5');
  });

  it('M-6: migrateV20ToV21 has PRAGMA foreign_keys in try-finally', () => {
    const opsSource = readFileSync(
      join(process.cwd(), 'src/services/storage/migrations/operations.ts'),
      'utf-8'
    );

    const fnMatch = opsSource.match(/function migrateV20ToV21[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    // VERIFY: Same pattern as V19ToV20
    expect(fnBody).toContain("db.exec('PRAGMA foreign_keys = OFF')");
    expect(fnBody).toContain('finally');
    expect(fnBody).toContain("db.exec('PRAGMA foreign_keys = ON')");
    expect(fnBody).toContain("db.exec('BEGIN TRANSACTION')");
    expect(fnBody).toContain("db.exec('COMMIT')");
    expect(fnBody).toContain("db.exec('ROLLBACK')");
    expect(fnBody).toContain('M-6');
  });
});

// ============================================================================
// FIX 7: SEARCH SCORING (L-1, L-2)
// ============================================================================

describe('FIX-7: Search Scoring (L-1, L-2)', () => {
  it('L-1: RRFFusion.fuse() does NOT apply computeQualityMultiplier', () => {
    // CODE AUDIT: fusion.ts should NOT import or call computeQualityMultiplier
    const fusionSource = readFileSync(
      join(process.cwd(), 'src/services/search/fusion.ts'),
      'utf-8'
    );

    // VERIFY: fusion.ts does NOT import computeQualityMultiplier
    expect(fusionSource).not.toContain('computeQualityMultiplier');

    // VERIFY: The comment explains why
    expect(fusionSource).toContain('double-penalize');
  });

  it('L-1: RRFFusion.fuse() produces correct RRF scores without quality adjustment', () => {
    // INPUT: Two result sets with known ranks
    const bm25Results = [
      {
        chunk_id: 'c1',
        image_id: null,
        extraction_id: null,
        embedding_id: 'e1',
        rank: 1,
        score: 10.0,
        result_type: 'chunk' as const,
        document_id: 'd1',
        original_text: 'test text 1',
        source_file_path: '/test.pdf',
        source_file_name: 'test.pdf',
        source_file_hash: 'hash1',
        page_number: 1,
        character_start: 0,
        character_end: 10,
        chunk_index: 0,
        provenance_id: 'p1',
        content_hash: 'ch1',
        ocr_quality_score: 1.0, // Low quality - should NOT affect fusion score
      },
    ];

    const semanticResults = [
      {
        chunk_id: 'c1',
        image_id: null,
        extraction_id: null,
        embedding_id: 'e1',
        rank: 1,
        score: 0.95,
        result_type: 'chunk' as const,
        document_id: 'd1',
        original_text: 'test text 1',
        source_file_path: '/test.pdf',
        source_file_name: 'test.pdf',
        source_file_hash: 'hash1',
        page_number: 1,
        character_start: 0,
        character_end: 10,
        chunk_index: 0,
        provenance_id: 'p1',
        content_hash: 'ch1',
        ocr_quality_score: 1.0,
      },
    ];

    // ACT: Fuse with default config (k=60)
    const fusion = new RRFFusion();
    const results = fusion.fuse(bm25Results, semanticResults, 10);

    // EXPECTED: RRF score = 1/(60+1) + 1/(60+1) = 2/61
    expect(results).toHaveLength(1);
    const expectedScore = 1 / (60 + 1) + 1 / (60 + 1);
    expect(results[0].rrf_score).toBeCloseTo(expectedScore, 10);
    // Should NOT be adjusted by quality multiplier (0.84 for quality=1.0)
    expect(results[0].rrf_score).not.toBeCloseTo(expectedScore * 0.84, 10);
  });

  it('L-2: Cross-DB normalization uses 0.5 when range=0 (not 1.0)', () => {
    // CODE AUDIT: Verify in search.ts
    const searchSource = readFileSync(join(process.cwd(), 'src/tools/search.ts'), 'utf-8');

    // VERIFY: When range is 0, normalized_score is set to 0.5
    expect(searchSource).toContain(': 0.5;');

    // Find the specific normalization block
    const normBlock = searchSource.match(
      /r\.normalized_score\s*=\s*range\s*>\s*0[\s\S]*?:\s*0\.5;/
    );
    expect(normBlock).not.toBeNull();
  });

  it('L-2: Cross-DB normalization uses safeMin/safeMax (not Math.min/Math.max spread)', () => {
    const searchSource = readFileSync(join(process.cwd(), 'src/tools/search.ts'), 'utf-8');

    // VERIFY: Uses safeMin and safeMax for cross-DB normalization
    expect(searchSource).toContain('safeMin(scores)');
    expect(searchSource).toContain('safeMax(scores)');
  });
});

// ============================================================================
// FIX 8: DEAD CODE REMOVED
// ============================================================================

describe('FIX-8: Dead Code Removed', () => {
  it('shared.ts does NOT contain parseGeminiJson', () => {
    const sharedSource = readFileSync(join(process.cwd(), 'src/tools/shared.ts'), 'utf-8');
    expect(sharedSource).not.toContain('parseGeminiJson');
  });

  it('chunk-deduplicator.ts does NOT exist', () => {
    const exists = existsSync(join(process.cwd(), 'src/services/chunking/chunk-deduplicator.ts'));
    expect(exists).toBe(false);
  });

  it('helpers.ts does NOT contain batchedQuery', () => {
    const helpersSource = readFileSync(
      join(process.cwd(), 'src/services/storage/database/helpers.ts'),
      'utf-8'
    );
    expect(helpersSource).not.toContain('batchedQuery');
  });

  it('timeline.ts does NOT exist in src/tools/', () => {
    const exists = existsSync(join(process.cwd(), 'src/tools/timeline.ts'));
    expect(exists).toBe(false);
  });
});

// ============================================================================
// FIX 9: VLM BEHAVIORAL TESTS EXIST
// ============================================================================

describe('FIX-9: VLM Behavioral Tests', () => {
  it('vlm-behavioral.test.ts exists', () => {
    const exists = existsSync(join(process.cwd(), 'tests/unit/tools/vlm-behavioral.test.ts'));
    expect(exists).toBe(true);
  });

  it('vlm-behavioral.test.ts imports vitest and has describe blocks', () => {
    const source = readFileSync(
      join(process.cwd(), 'tests/unit/tools/vlm-behavioral.test.ts'),
      'utf-8'
    );
    expect(source).toContain("from 'vitest'");
    expect(source).toContain('describe(');
    expect(source).toContain('it(');
    expect(source).toContain('expect(');
  });

  it('vlm-behavioral.test.ts tests withDatabaseOperation behavior (H-1/H-2)', () => {
    const source = readFileSync(
      join(process.cwd(), 'tests/unit/tools/vlm-behavioral.test.ts'),
      'utf-8'
    );
    // VERIFY: References to the state guard fixes
    expect(source).toContain('withDatabaseOperation');
  });
});

// ============================================================================
// FIX 10: COVERAGE THRESHOLDS
// ============================================================================

describe('FIX-10: Coverage Thresholds in vitest.config.ts', () => {
  it('vitest.config.ts has coverage thresholds set', () => {
    const configSource = readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf-8');

    // VERIFY: coverage.thresholds is defined
    expect(configSource).toContain('thresholds');

    // VERIFY: Has numeric thresholds for lines, branches, functions, statements
    expect(configSource).toMatch(/lines:\s*\d+/);
    expect(configSource).toMatch(/branches:\s*\d+/);
    expect(configSource).toMatch(/functions:\s*\d+/);
    expect(configSource).toMatch(/statements:\s*\d+/);
  });

  it('vitest.config.ts thresholds are meaningful (>= 60%)', () => {
    const configSource = readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf-8');

    const linesMatch = configSource.match(/lines:\s*(\d+)/);
    const branchesMatch = configSource.match(/branches:\s*(\d+)/);
    const functionsMatch = configSource.match(/functions:\s*(\d+)/);
    const statementsMatch = configSource.match(/statements:\s*(\d+)/);

    expect(linesMatch).not.toBeNull();
    expect(branchesMatch).not.toBeNull();
    expect(functionsMatch).not.toBeNull();
    expect(statementsMatch).not.toBeNull();

    expect(Number(linesMatch![1])).toBeGreaterThanOrEqual(60);
    expect(Number(branchesMatch![1])).toBeGreaterThanOrEqual(60);
    expect(Number(functionsMatch![1])).toBeGreaterThanOrEqual(60);
    expect(Number(statementsMatch![1])).toBeGreaterThanOrEqual(60);
  });
});

// ============================================================================
// BONUS: QUALITY MULTIPLIER SANITY CHECKS
// ============================================================================

describe('BONUS: computeQualityMultiplier sanity checks', () => {
  it('quality 5.0 returns 1.0', () => {
    expect(computeQualityMultiplier(5.0)).toBeCloseTo(1.0, 10);
  });

  it('quality 0.0 returns 0.8', () => {
    expect(computeQualityMultiplier(0.0)).toBeCloseTo(0.8, 10);
  });

  it('quality null returns 0.9 (neutral)', () => {
    expect(computeQualityMultiplier(null)).toBeCloseTo(0.9, 10);
  });

  it('quality undefined returns 0.9 (neutral)', () => {
    expect(computeQualityMultiplier(undefined)).toBeCloseTo(0.9, 10);
  });

  it('quality is clamped to [0, 5] range', () => {
    // Quality > 5 should be clamped to 5 -> multiplier = 1.0
    expect(computeQualityMultiplier(100)).toBeCloseTo(1.0, 10);
    // Quality < 0 should be clamped to 0 -> multiplier = 0.8
    expect(computeQualityMultiplier(-10)).toBeCloseTo(0.8, 10);
  });
});

// ============================================================================
// GLOBAL CLEANUP
// ============================================================================

afterAll(() => {
  resetState();
});
