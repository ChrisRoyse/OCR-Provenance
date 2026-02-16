/**
 * ProvenanceTracker Tests
 *
 * CRITICAL: Uses REAL DatabaseService - NO MOCKS
 * Verifies physical database state after all operations
 *
 * Constitution Compliance Tests:
 * - CP-001: Complete provenance chain for every data item
 * - CP-003: SHA-256 content hashing
 * - CP-005: Full reproducibility via processing params
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import {
  ProvenanceTracker,
  ProvenanceError,
  ProvenanceErrorCode,
  resetProvenanceTracker,
} from '../../../src/services/provenance/index.js';
import { ProvenanceType, PROVENANCE_CHAIN_DEPTH } from '../../../src/models/provenance.js';
import { computeHash } from '../../../src/utils/hash.js';

// Check sqlite-vec availability
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

if (!sqliteVecAvailable) {
  console.warn('WARNING: sqlite-vec not available. ProvenanceTracker tests will be skipped.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC TEST DATA
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC_CONTENT = {
  document: 'This is a test document for provenance verification.',
  ocrText: 'Extracted OCR text from the document.',
  chunk: 'First chunk of the OCR text.',
  embedding: 'First chunk of the OCR text.',
};

const EXPECTED_HASHES = {
  document: computeHash(SYNTHETIC_CONTENT.document),
  ocrText: computeHash(SYNTHETIC_CONTENT.ocrText),
  chunk: computeHash(SYNTHETIC_CONTENT.chunk),
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('ProvenanceTracker', () => {
  let testDir: string;
  let db: DatabaseService | undefined;
  let tracker: ProvenanceTracker;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'prov-tracker-test-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (!sqliteVecAvailable) return;

    resetProvenanceTracker();
    const dbName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = DatabaseService.create(dbName, undefined, testDir);
    tracker = new ProvenanceTracker(db);
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // createProvenance() tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('createProvenance()', () => {
    it.skipIf(!sqliteVecAvailable)(
      'creates DOCUMENT provenance with chain_depth=0 and empty parent_ids',
      () => {
        const id = tracker.createProvenance({
          type: ProvenanceType.DOCUMENT,
          source_type: 'FILE',
          root_document_id: '', // Will be overridden to self
          content_hash: EXPECTED_HASHES.document,
          file_hash: computeHash('test file'),
          source_path: '/test/file.pdf',
          processor: 'file-ingestion',
          processor_version: '1.0.0',
          processing_params: { ingestion_source: 'manual' },
        });

        // VERIFY: Read from database to confirm physical state
        const rawDb = db!.getConnection();
        const row = rawDb.prepare('SELECT * FROM provenance WHERE id = ?').get(id) as {
          id: string;
          type: string;
          chain_depth: number;
          parent_ids: string;
          root_document_id: string;
          content_hash: string;
        };

        console.log('\n[VERIFY] Created DOCUMENT provenance:', id);
        console.log(
          `  - chain_depth: ${row.chain_depth} (expected: 0) ${row.chain_depth === 0 ? '✓' : '✗'}`
        );
        console.log(
          `  - parent_ids: ${row.parent_ids} (expected: []) ${row.parent_ids === '[]' ? '✓' : '✗'}`
        );
        console.log(
          `  - root_document_id: ${row.root_document_id} (expected: ${id}) ${row.root_document_id === id ? '✓' : '✗'}`
        );

        expect(row).not.toBeNull();
        expect(row.type).toBe(ProvenanceType.DOCUMENT);
        expect(row.chain_depth).toBe(0);
        expect(JSON.parse(row.parent_ids)).toEqual([]);
        expect(row.root_document_id).toBe(id); // Self-referencing for DOCUMENT
        expect(row.content_hash).toBe(EXPECTED_HASHES.document);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'creates OCR_RESULT provenance with chain_depth=1 and [docId] in parent_ids',
      () => {
        // First create DOCUMENT
        const docId = tracker.createProvenance({
          type: ProvenanceType.DOCUMENT,
          source_type: 'FILE',
          root_document_id: '',
          content_hash: EXPECTED_HASHES.document,
          processor: 'ingestion',
          processor_version: '1.0.0',
          processing_params: {},
        });

        // Then create OCR_RESULT
        const ocrId = tracker.createProvenance({
          type: ProvenanceType.OCR_RESULT,
          source_type: 'OCR',
          source_id: docId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.ocrText,
          input_hash: EXPECTED_HASHES.document,
          processor: 'datalab-ocr',
          processor_version: '1.0.0',
          processing_params: { mode: 'accurate' },
        });

        // VERIFY: Physical database state
        const rawDb = db!.getConnection();
        const row = rawDb.prepare('SELECT * FROM provenance WHERE id = ?').get(ocrId) as {
          chain_depth: number;
          parent_ids: string;
          parent_id: string;
          root_document_id: string;
        };

        console.log('\n[VERIFY] Created OCR_RESULT provenance:', ocrId);
        console.log(
          `  - chain_depth: ${row.chain_depth} (expected: 1) ${row.chain_depth === 1 ? '✓' : '✗'}`
        );
        console.log(
          `  - parent_ids: ${row.parent_ids} (expected: ["${docId}"]) ${row.parent_ids === JSON.stringify([docId]) ? '✓' : '✗'}`
        );
        console.log(
          `  - parent_id: ${row.parent_id} (expected: ${docId}) ${row.parent_id === docId ? '✓' : '✗'}`
        );

        expect(row.chain_depth).toBe(1);
        expect(JSON.parse(row.parent_ids)).toEqual([docId]);
        expect(row.parent_id).toBe(docId);
        expect(row.root_document_id).toBe(docId);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'creates CHUNK provenance with chain_depth=2 and [docId, ocrId] in parent_ids',
      () => {
        // Create chain: DOC -> OCR
        const docId = tracker.createProvenance({
          type: ProvenanceType.DOCUMENT,
          source_type: 'FILE',
          root_document_id: '',
          content_hash: EXPECTED_HASHES.document,
          processor: 'ingestion',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const ocrId = tracker.createProvenance({
          type: ProvenanceType.OCR_RESULT,
          source_type: 'OCR',
          source_id: docId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.ocrText,
          processor: 'datalab-ocr',
          processor_version: '1.0.0',
          processing_params: {},
        });

        // Create CHUNK
        const chunkId = tracker.createProvenance({
          type: ProvenanceType.CHUNK,
          source_type: 'CHUNKING',
          source_id: ocrId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.chunk,
          input_hash: EXPECTED_HASHES.ocrText,
          processor: 'chunker',
          processor_version: '1.0.0',
          processing_params: { chunk_size: 2000, overlap_percent: 10 },
          location: { chunk_index: 0, character_start: 0, character_end: 2000 },
        });

        // VERIFY
        const rawDb = db!.getConnection();
        const row = rawDb.prepare('SELECT * FROM provenance WHERE id = ?').get(chunkId) as {
          chain_depth: number;
          parent_ids: string;
          chain_path: string;
        };

        console.log('\n[VERIFY] Created CHUNK provenance:', chunkId);
        console.log(
          `  - chain_depth: ${row.chain_depth} (expected: 2) ${row.chain_depth === 2 ? '✓' : '✗'}`
        );
        console.log(
          `  - parent_ids: ${row.parent_ids} (expected: ["${docId}","${ocrId}"]) ${row.parent_ids === JSON.stringify([docId, ocrId]) ? '✓' : '✗'}`
        );

        expect(row.chain_depth).toBe(2);
        expect(JSON.parse(row.parent_ids)).toEqual([docId, ocrId]);
        expect(JSON.parse(row.chain_path)).toEqual(['DOCUMENT', 'OCR_RESULT', 'CHUNK']);
      }
    );

    it.skipIf(!sqliteVecAvailable)(
      'creates EMBEDDING provenance with chain_depth=3 and [docId, ocrId, chunkId] in parent_ids',
      () => {
        // Create full chain
        const docId = tracker.createProvenance({
          type: ProvenanceType.DOCUMENT,
          source_type: 'FILE',
          root_document_id: '',
          content_hash: EXPECTED_HASHES.document,
          processor: 'ingestion',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const ocrId = tracker.createProvenance({
          type: ProvenanceType.OCR_RESULT,
          source_type: 'OCR',
          source_id: docId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.ocrText,
          processor: 'datalab-ocr',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const chunkId = tracker.createProvenance({
          type: ProvenanceType.CHUNK,
          source_type: 'CHUNKING',
          source_id: ocrId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.chunk,
          processor: 'chunker',
          processor_version: '1.0.0',
          processing_params: {},
        });

        // Create EMBEDDING
        const embId = tracker.createProvenance({
          type: ProvenanceType.EMBEDDING,
          source_type: 'EMBEDDING',
          source_id: chunkId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.chunk,
          input_hash: EXPECTED_HASHES.chunk,
          processor: 'nomic-embed-text-v1.5',
          processor_version: '1.5.0',
          processing_params: { dimensions: 768, device: 'cuda:0' },
        });

        // VERIFY
        const rawDb = db!.getConnection();
        const row = rawDb.prepare('SELECT * FROM provenance WHERE id = ?').get(embId) as {
          chain_depth: number;
          parent_ids: string;
          chain_path: string;
          root_document_id: string;
        };

        console.log('\n[VERIFY] Created EMBEDDING provenance:', embId);
        console.log(
          `  - chain_depth: ${row.chain_depth} (expected: 3) ${row.chain_depth === 3 ? '✓' : '✗'}`
        );
        console.log(`  - parent_ids: ${row.parent_ids}`);
        console.log(`    expected: ["${docId}","${ocrId}","${chunkId}"]`);
        const parentIdsMatch = row.parent_ids === JSON.stringify([docId, ocrId, chunkId]);
        console.log(`    match: ${parentIdsMatch ? '✓' : '✗'}`);
        console.log(`  - chain_path: ${row.chain_path}`);

        expect(row.chain_depth).toBe(3);
        expect(JSON.parse(row.parent_ids)).toEqual([docId, ocrId, chunkId]);
        expect(JSON.parse(row.chain_path)).toEqual([
          'DOCUMENT',
          'OCR_RESULT',
          'CHUNK',
          'EMBEDDING',
        ]);
        expect(row.root_document_id).toBe(docId);
      }
    );

    it.skipIf(!sqliteVecAvailable)('throws CHAIN_BROKEN when source_id does not exist', () => {
      const nonexistentId = uuidv4();

      expect(() =>
        tracker.createProvenance({
          type: ProvenanceType.OCR_RESULT,
          source_type: 'OCR',
          source_id: nonexistentId,
          root_document_id: nonexistentId,
          content_hash: computeHash('test'),
          processor: 'test',
          processor_version: '1.0',
          processing_params: {},
        })
      ).toThrow(ProvenanceError);

      // Verify error details
      try {
        tracker.createProvenance({
          type: ProvenanceType.OCR_RESULT,
          source_type: 'OCR',
          source_id: nonexistentId,
          root_document_id: nonexistentId,
          content_hash: computeHash('test'),
          processor: 'test',
          processor_version: '1.0',
          processing_params: {},
        });
      } catch (e) {
        expect(e).toBeInstanceOf(ProvenanceError);
        const error = e as ProvenanceError;
        expect(error.code).toBe(ProvenanceErrorCode.CHAIN_BROKEN);
        expect(error.details?.sourceId).toBe(nonexistentId);
        console.log('\n[VERIFY] CHAIN_BROKEN error thrown correctly for nonexistent source_id ✓');
      }
    });

    it.skipIf(!sqliteVecAvailable)('throws INVALID_TYPE for invalid provenance type', () => {
      expect(() =>
        tracker.createProvenance({
          type: 'INVALID_TYPE' as ProvenanceType,
          source_type: 'FILE',
          root_document_id: '',
          content_hash: computeHash('test'),
          processor: 'test',
          processor_version: '1.0',
          processing_params: {},
        })
      ).toThrow(ProvenanceError);

      try {
        tracker.createProvenance({
          type: 'INVALID_TYPE' as ProvenanceType,
          source_type: 'FILE',
          root_document_id: '',
          content_hash: computeHash('test'),
          processor: 'test',
          processor_version: '1.0',
          processing_params: {},
        });
      } catch (e) {
        expect(e).toBeInstanceOf(ProvenanceError);
        expect((e as ProvenanceError).code).toBe(ProvenanceErrorCode.INVALID_TYPE);
        console.log('\n[VERIFY] INVALID_TYPE error thrown correctly ✓');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getProvenanceById() tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('getProvenanceById()', () => {
    it.skipIf(!sqliteVecAvailable)('returns provenance record by ID', () => {
      const id = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: EXPECTED_HASHES.document,
        processor: 'test',
        processor_version: '1.0',
        processing_params: { key: 'value' },
      });

      const record = tracker.getProvenanceById(id);

      expect(record.id).toBe(id);
      expect(record.type).toBe(ProvenanceType.DOCUMENT);
      expect(record.processing_params).toEqual({ key: 'value' });
    });

    it.skipIf(!sqliteVecAvailable)('throws NOT_FOUND for nonexistent ID', () => {
      const nonexistentId = uuidv4();

      expect(() => tracker.getProvenanceById(nonexistentId)).toThrow(ProvenanceError);

      try {
        tracker.getProvenanceById(nonexistentId);
      } catch (e) {
        expect((e as ProvenanceError).code).toBe(ProvenanceErrorCode.NOT_FOUND);
        console.log('\n[VERIFY] NOT_FOUND error thrown correctly ✓');
      }
    });
  });

  describe('getProvenanceByIdOrNull()', () => {
    it.skipIf(!sqliteVecAvailable)('returns null for nonexistent ID', () => {
      const result = tracker.getProvenanceByIdOrNull(uuidv4());
      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getProvenanceChain() tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('getProvenanceChain()', () => {
    it.skipIf(!sqliteVecAvailable)(
      'returns complete 4-depth chain from EMBEDDING to DOCUMENT',
      () => {
        // Build full chain
        const docId = tracker.createProvenance({
          type: ProvenanceType.DOCUMENT,
          source_type: 'FILE',
          root_document_id: '',
          content_hash: EXPECTED_HASHES.document,
          processor: 'ingestion',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const ocrId = tracker.createProvenance({
          type: ProvenanceType.OCR_RESULT,
          source_type: 'OCR',
          source_id: docId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.ocrText,
          processor: 'datalab',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const chunkId = tracker.createProvenance({
          type: ProvenanceType.CHUNK,
          source_type: 'CHUNKING',
          source_id: ocrId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.chunk,
          processor: 'chunker',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const embId = tracker.createProvenance({
          type: ProvenanceType.EMBEDDING,
          source_type: 'EMBEDDING',
          source_id: chunkId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.chunk,
          processor: 'nomic',
          processor_version: '1.5.0',
          processing_params: {},
        });

        // Get chain from embedding
        const chain = tracker.getProvenanceChain(embId);

        console.log('\n[VERIFY] Complete chain traversal from EMBEDDING:');
        console.log(
          `  - current.id: ${chain.current.id} (expected: ${embId}) ${chain.current.id === embId ? '✓' : '✗'}`
        );
        console.log(
          `  - ancestors.length: ${chain.ancestors.length} (expected: 3) ${chain.ancestors.length === 3 ? '✓' : '✗'}`
        );
        console.log(
          `  - ancestors[0].id: ${chain.ancestors[0]?.id} (expected: ${chunkId}) ${chain.ancestors[0]?.id === chunkId ? '✓' : '✗'}`
        );
        console.log(
          `  - ancestors[1].id: ${chain.ancestors[1]?.id} (expected: ${ocrId}) ${chain.ancestors[1]?.id === ocrId ? '✓' : '✗'}`
        );
        console.log(
          `  - ancestors[2].id: ${chain.ancestors[2]?.id} (expected: ${docId}) ${chain.ancestors[2]?.id === docId ? '✓' : '✗'}`
        );
        console.log(
          `  - root.id: ${chain.root.id} (expected: ${docId}) ${chain.root.id === docId ? '✓' : '✗'}`
        );
        console.log(
          `  - isComplete: ${chain.isComplete} (expected: true) ${chain.isComplete ? '✓' : '✗'}`
        );
        console.log(`  - depth: ${chain.depth} (expected: 3) ${chain.depth === 3 ? '✓' : '✗'}`);

        expect(chain.current.id).toBe(embId);
        expect(chain.ancestors.length).toBe(3);
        expect(chain.ancestors[0].id).toBe(chunkId); // Immediate parent first
        expect(chain.ancestors[1].id).toBe(ocrId);
        expect(chain.ancestors[2].id).toBe(docId); // Root last
        expect(chain.root.id).toBe(docId);
        expect(chain.isComplete).toBe(true);
        expect(chain.depth).toBe(3);
        expect(chain.chainPath).toEqual(['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING']);
      }
    );

    it.skipIf(!sqliteVecAvailable)('returns single-element chain for DOCUMENT', () => {
      const docId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: EXPECTED_HASHES.document,
        processor: 'ingestion',
        processor_version: '1.0.0',
        processing_params: {},
      });

      const chain = tracker.getProvenanceChain(docId);

      expect(chain.current.id).toBe(docId);
      expect(chain.ancestors.length).toBe(0);
      expect(chain.root.id).toBe(docId);
      expect(chain.isComplete).toBe(true);
      expect(chain.depth).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('throws NOT_FOUND for nonexistent ID', () => {
      expect(() => tracker.getProvenanceChain(uuidv4())).toThrow(ProvenanceError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getRootDocument() tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('getRootDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('returns root document from any depth', () => {
      const docId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: EXPECTED_HASHES.document,
        source_path: '/test/important.pdf',
        processor: 'ingestion',
        processor_version: '1.0.0',
        processing_params: {},
      });

      const ocrId = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.ocrText,
        processor: 'datalab',
        processor_version: '1.0.0',
        processing_params: {},
      });

      const chunkId = tracker.createProvenance({
        type: ProvenanceType.CHUNK,
        source_type: 'CHUNKING',
        source_id: ocrId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.chunk,
        processor: 'chunker',
        processor_version: '1.0.0',
        processing_params: {},
      });

      // Get root from CHUNK depth
      const root = tracker.getRootDocument(chunkId);

      expect(root.id).toBe(docId);
      expect(root.type).toBe(ProvenanceType.DOCUMENT);
      expect(root.source_path).toBe('/test/important.pdf');
      console.log('\n[VERIFY] getRootDocument from CHUNK returns DOCUMENT ✓');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getProvenanceByRootDocument() tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('getProvenanceByRootDocument()', () => {
    it.skipIf(!sqliteVecAvailable)(
      'returns all provenance for a document ordered by chain_depth',
      () => {
        const docId = tracker.createProvenance({
          type: ProvenanceType.DOCUMENT,
          source_type: 'FILE',
          root_document_id: '',
          content_hash: EXPECTED_HASHES.document,
          processor: 'ingestion',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const ocrId = tracker.createProvenance({
          type: ProvenanceType.OCR_RESULT,
          source_type: 'OCR',
          source_id: docId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.ocrText,
          processor: 'datalab',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const _chunkId = tracker.createProvenance({
          type: ProvenanceType.CHUNK,
          source_type: 'CHUNKING',
          source_id: ocrId,
          root_document_id: docId,
          content_hash: EXPECTED_HASHES.chunk,
          processor: 'chunker',
          processor_version: '1.0.0',
          processing_params: {},
        });

        const records = tracker.getProvenanceByRootDocument(docId);

        console.log('\n[VERIFY] getProvenanceByRootDocument:');
        console.log(
          `  - total records: ${records.length} (expected: 3) ${records.length === 3 ? '✓' : '✗'}`
        );
        console.log(
          `  - records[0].chain_depth: ${records[0].chain_depth} (expected: 0) ${records[0].chain_depth === 0 ? '✓' : '✗'}`
        );
        console.log(
          `  - records[1].chain_depth: ${records[1].chain_depth} (expected: 1) ${records[1].chain_depth === 1 ? '✓' : '✗'}`
        );
        console.log(
          `  - records[2].chain_depth: ${records[2].chain_depth} (expected: 2) ${records[2].chain_depth === 2 ? '✓' : '✗'}`
        );

        expect(records.length).toBe(3);
        expect(records[0].chain_depth).toBe(0); // Ordered by chain_depth
        expect(records[1].chain_depth).toBe(1);
        expect(records[2].chain_depth).toBe(2);
        expect(records[0].type).toBe(ProvenanceType.DOCUMENT);
        expect(records[1].type).toBe(ProvenanceType.OCR_RESULT);
        expect(records[2].type).toBe(ProvenanceType.CHUNK);
      }
    );

    it.skipIf(!sqliteVecAvailable)('returns empty array for nonexistent root document', () => {
      const records = tracker.getProvenanceByRootDocument(uuidv4());
      expect(records).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getProvenanceChildren() tests
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('getProvenanceChildren()', () => {
    it.skipIf(!sqliteVecAvailable)('returns children by parent_id', () => {
      const docId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: EXPECTED_HASHES.document,
        processor: 'ingestion',
        processor_version: '1.0.0',
        processing_params: {},
      });

      // Create two OCR results from same document (e.g., reprocessed)
      const ocrId1 = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docId,
        root_document_id: docId,
        content_hash: computeHash('ocr1'),
        processor: 'datalab',
        processor_version: '1.0.0',
        processing_params: { mode: 'fast' },
      });

      const ocrId2 = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docId,
        root_document_id: docId,
        content_hash: computeHash('ocr2'),
        processor: 'datalab',
        processor_version: '1.0.0',
        processing_params: { mode: 'accurate' },
      });

      const children = tracker.getProvenanceChildren(docId);

      expect(children.length).toBe(2);
      expect(children.every((c) => c.parent_id === docId)).toBe(true);
      expect(children.map((c) => c.id).sort()).toEqual([ocrId1, ocrId2].sort());
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it.skipIf(!sqliteVecAvailable)('handles empty inputs correctly', () => {
      // Empty processing_params
      const id = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: EXPECTED_HASHES.document,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const record = tracker.getProvenanceById(id);
      expect(record.processing_params).toEqual({});
    });

    it.skipIf(!sqliteVecAvailable)('handles maximum chain depth correctly', () => {
      // Verify PROVENANCE_CHAIN_DEPTH constant
      expect(PROVENANCE_CHAIN_DEPTH[ProvenanceType.DOCUMENT]).toBe(0);
      expect(PROVENANCE_CHAIN_DEPTH[ProvenanceType.OCR_RESULT]).toBe(1);
      expect(PROVENANCE_CHAIN_DEPTH[ProvenanceType.CHUNK]).toBe(2);
      expect(PROVENANCE_CHAIN_DEPTH[ProvenanceType.EMBEDDING]).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('correctly builds parent_ids for deep chain', () => {
      // Create full chain and verify all parent_ids arrays
      const docId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: EXPECTED_HASHES.document,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const ocrId = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.ocrText,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const chunkId = tracker.createProvenance({
        type: ProvenanceType.CHUNK,
        source_type: 'CHUNKING',
        source_id: ocrId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.chunk,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const embId = tracker.createProvenance({
        type: ProvenanceType.EMBEDDING,
        source_type: 'EMBEDDING',
        source_id: chunkId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.chunk,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      // Verify each level's parent_ids using raw SQL
      const rawDb = db!.getConnection();

      const docRow = rawDb.prepare('SELECT parent_ids FROM provenance WHERE id = ?').get(docId) as {
        parent_ids: string;
      };
      const ocrRow = rawDb.prepare('SELECT parent_ids FROM provenance WHERE id = ?').get(ocrId) as {
        parent_ids: string;
      };
      const chunkRow = rawDb
        .prepare('SELECT parent_ids FROM provenance WHERE id = ?')
        .get(chunkId) as { parent_ids: string };
      const embRow = rawDb.prepare('SELECT parent_ids FROM provenance WHERE id = ?').get(embId) as {
        parent_ids: string;
      };

      console.log('\n[VERIFY] parent_ids accumulation across chain:');
      console.log(`  DOCUMENT:   ${docRow.parent_ids}`);
      console.log(`  OCR_RESULT: ${ocrRow.parent_ids}`);
      console.log(`  CHUNK:      ${chunkRow.parent_ids}`);
      console.log(`  EMBEDDING:  ${embRow.parent_ids}`);

      expect(JSON.parse(docRow.parent_ids)).toEqual([]);
      expect(JSON.parse(ocrRow.parent_ids)).toEqual([docId]);
      expect(JSON.parse(chunkRow.parent_ids)).toEqual([docId, ocrId]);
      expect(JSON.parse(embRow.parent_ids)).toEqual([docId, ocrId, chunkId]);

      console.log('  All parent_ids arrays verified correctly ✓');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // CHAIN_PATH VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('chain_path verification', () => {
    it.skipIf(!sqliteVecAvailable)('sets correct chain_path for each type', () => {
      const docId = tracker.createProvenance({
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        root_document_id: '',
        content_hash: EXPECTED_HASHES.document,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const ocrId = tracker.createProvenance({
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.ocrText,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const chunkId = tracker.createProvenance({
        type: ProvenanceType.CHUNK,
        source_type: 'CHUNKING',
        source_id: ocrId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.chunk,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const embId = tracker.createProvenance({
        type: ProvenanceType.EMBEDDING,
        source_type: 'EMBEDDING',
        source_id: chunkId,
        root_document_id: docId,
        content_hash: EXPECTED_HASHES.chunk,
        processor: 'test',
        processor_version: '1.0',
        processing_params: {},
      });

      const rawDb = db!.getConnection();

      const docRow = rawDb.prepare('SELECT chain_path FROM provenance WHERE id = ?').get(docId) as {
        chain_path: string;
      };
      const ocrRow = rawDb.prepare('SELECT chain_path FROM provenance WHERE id = ?').get(ocrId) as {
        chain_path: string;
      };
      const chunkRow = rawDb
        .prepare('SELECT chain_path FROM provenance WHERE id = ?')
        .get(chunkId) as { chain_path: string };
      const embRow = rawDb.prepare('SELECT chain_path FROM provenance WHERE id = ?').get(embId) as {
        chain_path: string;
      };

      expect(JSON.parse(docRow.chain_path)).toEqual(['DOCUMENT']);
      expect(JSON.parse(ocrRow.chain_path)).toEqual(['DOCUMENT', 'OCR_RESULT']);
      expect(JSON.parse(chunkRow.chain_path)).toEqual(['DOCUMENT', 'OCR_RESULT', 'CHUNK']);
      expect(JSON.parse(embRow.chain_path)).toEqual([
        'DOCUMENT',
        'OCR_RESULT',
        'CHUNK',
        'EMBEDDING',
      ]);
    });
  });
});
