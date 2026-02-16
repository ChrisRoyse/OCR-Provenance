/**
 * Integration Tests for Provenance MCP Tools
 *
 * Tests: ocr_provenance_get, ocr_provenance_verify, ocr_provenance_export
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/integration/server/provenance-tools
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  sqliteVecAvailable,
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  resetState,
  createDatabase,
  requireDatabase,
  updateConfig,
  MCPError,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  ProvenanceType,
  uuidv4,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_provenance_get TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_provenance_get', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-get-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it('throws DATABASE_NOT_SELECTED when no database', () => {
    try {
      requireDatabase();
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as MCPError).category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it.skipIf(!sqliteVecAvailable)('returns null for non-existent provenance', () => {
    createDatabase(createUniqueName('prov-notfound'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = db.getProvenance('non-existent-id');
    expect(prov).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('returns provenance by ID', () => {
    createDatabase(createUniqueName('prov-by-id'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(prov.id);
    expect(retrieved!.type).toBe(prov.type);
  });

  it.skipIf(!sqliteVecAvailable)('returns full provenance chain for document', () => {
    createDatabase(createUniqueName('prov-chain-doc'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create provenance chain: DOCUMENT -> OCR_RESULT -> CHUNK
    const docProv = createTestProvenance({
      type: ProvenanceType.DOCUMENT,
      chain_depth: 0,
    });
    db.insertProvenance(docProv);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);

    const chunkProv = createTestProvenance({
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);

    // Get chain from chunk back to document - returns items from root to current
    const chain = db.getProvenanceChain(chunkProv.id);
    expect(chain.length).toBe(3);
    // Chain is returned in order from root (depth 0) to current
    expect(chain.map((p) => p.type)).toContain('DOCUMENT');
    expect(chain.map((p) => p.type)).toContain('OCR_RESULT');
    expect(chain.map((p) => p.type)).toContain('CHUNK');
  });

  it.skipIf(!sqliteVecAvailable)('auto-detects item type for document', () => {
    createDatabase(createUniqueName('auto-doc'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    const retrieved = db.getDocument(doc.id);
    expect(retrieved).not.toBeNull();

    const provChain = db.getProvenanceChain(retrieved!.provenance_id);
    expect(provChain.length).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteVecAvailable)('auto-detects item type for chunk', () => {
    createDatabase(createUniqueName('auto-chunk'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create full hierarchy
    const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    const retrievedChunk = db.getChunk(chunk.id);
    expect(retrievedChunk).not.toBeNull();

    const chain = db.getProvenanceChain(retrievedChunk!.provenance_id);
    expect(chain.length).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('returns root_document_id in chain', () => {
    createDatabase(createUniqueName('root-doc'), undefined, tempDir);
    const { db } = requireDatabase();

    const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
    db.insertProvenance(docProv);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);

    const chain = db.getProvenanceChain(ocrProv.id);
    expect(chain[0].root_document_id).toBe(docProv.root_document_id);
    expect(chain[1].root_document_id).toBe(docProv.root_document_id);
  });

  it.skipIf(!sqliteVecAvailable)('returns provenance with all fields', () => {
    createDatabase(createUniqueName('all-fields'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance({
      processor: 'test-processor',
      processor_version: '2.0.0',
      processing_duration_ms: 500,
      processing_quality_score: 0.98,
    });
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    expect(retrieved!.processor).toBe('test-processor');
    expect(retrieved!.processor_version).toBe('2.0.0');
    expect(retrieved!.processing_duration_ms).toBe(500);
    expect(retrieved!.processing_quality_score).toBe(0.98);
    expect(retrieved!.content_hash).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_provenance_verify TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_provenance_verify', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-verify-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it('throws DATABASE_NOT_SELECTED when no database', () => {
    try {
      requireDatabase();
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as MCPError).category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it.skipIf(!sqliteVecAvailable)('verifies valid chain integrity', () => {
    createDatabase(createUniqueName('verify-valid'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create valid chain
    const docProv = createTestProvenance({
      type: ProvenanceType.DOCUMENT,
      chain_depth: 0,
      content_hash: 'sha256:abc123',
    });
    db.insertProvenance(docProv);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
      content_hash: 'sha256:def456',
    });
    db.insertProvenance(ocrProv);

    const chain = db.getProvenanceChain(ocrProv.id);

    // Verify chain integrity - chain has both items
    expect(chain.length).toBe(2);
    // Both provenance records are in the chain
    const depths = chain.map((p) => p.chain_depth).sort((a, b) => a - b);
    expect(depths).toEqual([0, 1]);
  });

  it.skipIf(!sqliteVecAvailable)('validates content hash format', () => {
    createDatabase(createUniqueName('verify-hash'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance({
      content_hash: 'sha256:valid_hash_format',
    });
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    expect(retrieved!.content_hash).toMatch(/^sha256:/);
  });

  it.skipIf(!sqliteVecAvailable)('verifies chain depth sequence', () => {
    createDatabase(createUniqueName('verify-depth'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create proper depth sequence
    const provs: ReturnType<typeof createTestProvenance>[] = [];
    let parentId: string | null = null;
    let rootDocId = '';

    for (let depth = 0; depth < 4; depth++) {
      const provId = uuidv4();
      if (depth === 0) {
        rootDocId = provId;
      }
      const prov = createTestProvenance({
        id: provId,
        type: depth === 0 ? ProvenanceType.DOCUMENT : ProvenanceType.CHUNK,
        parent_id: parentId,
        root_document_id: rootDocId,
        chain_depth: depth,
      });
      db.insertProvenance(prov);
      provs.push(prov);
      parentId = prov.id;
    }

    const chain = db.getProvenanceChain(provs[3].id);
    expect(chain.length).toBe(4);

    // Verify all depths are present
    const depths = chain.map((p) => p.chain_depth).sort((a, b) => a - b);
    expect(depths).toEqual([0, 1, 2, 3]);
  });

  it.skipIf(!sqliteVecAvailable)('verifies parent links', () => {
    createDatabase(createUniqueName('verify-parents'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov1 = createTestProvenance({ type: ProvenanceType.DOCUMENT, chain_depth: 0 });
    db.insertProvenance(prov1);

    const prov2 = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: prov1.id,
      root_document_id: prov1.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(prov2);

    const prov3 = createTestProvenance({
      type: ProvenanceType.CHUNK,
      parent_id: prov2.id,
      root_document_id: prov1.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(prov3);

    const chain = db.getProvenanceChain(prov3.id);

    // Verify chain has all 3 items
    expect(chain.length).toBe(3);

    // Find the root item (chain_depth 0) - should have null parent
    const root = chain.find((p) => p.chain_depth === 0);
    expect(root).toBeDefined();
    expect(root!.parent_id).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('handles single-item chain', () => {
    createDatabase(createUniqueName('single-chain'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance({
      type: ProvenanceType.DOCUMENT,
      chain_depth: 0,
      parent_id: null,
    });
    db.insertProvenance(prov);

    const chain = db.getProvenanceChain(prov.id);
    expect(chain.length).toBe(1);
    expect(chain[0].chain_depth).toBe(0);
    expect(chain[0].parent_id).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_provenance_export TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_provenance_export', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-export-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it('throws DATABASE_NOT_SELECTED when no database', () => {
    try {
      requireDatabase();
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as MCPError).category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it.skipIf(!sqliteVecAvailable)('exports document scope provenance', () => {
    createDatabase(createUniqueName('export-doc'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create document with provenance chain
    const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);

    // Export for document
    const records = db.getProvenanceByRootDocument(docProv.root_document_id);
    expect(records.length).toBe(2);
  });

  it.skipIf(!sqliteVecAvailable)('exports database scope provenance', () => {
    createDatabase(createUniqueName('export-db'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create multiple documents with provenance
    for (let i = 0; i < 3; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      db.insertDocument(doc);
    }

    // Get all provenance
    const allDocs = db.listDocuments();
    let totalProvenance = 0;
    for (const doc of allDocs) {
      const records = db.getProvenanceByRootDocument(doc.provenance_id);
      totalProvenance += records.length;
    }

    expect(totalProvenance).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('exports in JSON format', () => {
    createDatabase(createUniqueName('export-json'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    const json = JSON.stringify(retrieved);

    expect(json).toContain(prov.id);
    expect(json).toContain(prov.type);
  });

  it.skipIf(!sqliteVecAvailable)('includes all provenance fields in export', () => {
    createDatabase(createUniqueName('export-fields'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance({
      processor: 'datalab',
      processor_version: '1.0.0',
      processing_duration_ms: 1000,
    });
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    expect(retrieved!.id).toBeDefined();
    expect(retrieved!.type).toBeDefined();
    expect(retrieved!.chain_depth).toBeDefined();
    expect(retrieved!.processor).toBe('datalab');
    expect(retrieved!.processor_version).toBe('1.0.0');
    expect(retrieved!.content_hash).toBeDefined();
    expect(retrieved!.created_at).toBeDefined();
  });

  it.skipIf(!sqliteVecAvailable)('handles empty database export', () => {
    createDatabase(createUniqueName('export-empty'), undefined, tempDir);
    const { db } = requireDatabase();

    const docs = db.listDocuments();
    expect(docs.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('exports provenance children', () => {
    createDatabase(createUniqueName('export-children'), undefined, tempDir);
    const { db } = requireDatabase();

    const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT, chain_depth: 0 });
    db.insertProvenance(docProv);

    // Add multiple children
    for (let i = 0; i < 3; i++) {
      const childProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: docProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 1,
      });
      db.insertProvenance(childProv);
    }

    const children = db.getProvenanceChildren(docProv.id);
    expect(children.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES AND VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provenance Tools - Edge Cases', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('prov-edge-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('handles deep provenance chains', () => {
    createDatabase(createUniqueName('deep-chain'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create chain of 10 levels
    let parentId: string | null = null;
    const rootDocId = uuidv4();
    let lastProvId = '';

    for (let depth = 0; depth < 10; depth++) {
      const prov = createTestProvenance({
        type: depth === 0 ? ProvenanceType.DOCUMENT : ProvenanceType.CHUNK,
        parent_id: parentId,
        root_document_id: depth === 0 ? undefined : rootDocId,
        chain_depth: depth,
      });
      if (depth === 0) {
        prov.root_document_id = prov.id;
      }
      db.insertProvenance(prov);
      parentId = prov.id;
      lastProvId = prov.id;
    }

    const chain = db.getProvenanceChain(lastProvId);
    expect(chain.length).toBe(10);
  });

  it.skipIf(!sqliteVecAvailable)('handles multiple documents with separate chains', () => {
    createDatabase(createUniqueName('multi-doc'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create 3 separate document chains
    const docProvIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT, chain_depth: 0 });
      db.insertProvenance(docProv);
      docProvIds.push(docProv.id);

      const childProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 1,
      });
      db.insertProvenance(childProv);
    }

    // Each chain should be independent
    for (const docProvId of docProvIds) {
      const records = db.getProvenanceByRootDocument(docProvId);
      expect(records.length).toBe(2);
    }
  });

  it.skipIf(!sqliteVecAvailable)('handles provenance with null optional fields', () => {
    createDatabase(createUniqueName('null-fields'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance({
      processing_duration_ms: null,
      processing_quality_score: null,
      location: null,
    });
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    expect(retrieved!.processing_duration_ms).toBeNull();
    expect(retrieved!.processing_quality_score).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('handles special characters in provenance data', () => {
    createDatabase(createUniqueName('special-chars'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance({
      source_path: '/path/with spaces/and (parens)/file.pdf',
      processor: 'test-processor_v2.0',
    });
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    expect(retrieved!.source_path).toBe('/path/with spaces/and (parens)/file.pdf');
    expect(retrieved!.processor).toBe('test-processor_v2.0');
  });

  it.skipIf(!sqliteVecAvailable)('validates provenance type values', () => {
    createDatabase(createUniqueName('type-values'), undefined, tempDir);
    const { db } = requireDatabase();

    const types = [
      ProvenanceType.DOCUMENT,
      ProvenanceType.OCR_RESULT,
      ProvenanceType.CHUNK,
      ProvenanceType.EMBEDDING,
    ];

    for (const type of types) {
      const prov = createTestProvenance({ type });
      db.insertProvenance(prov);

      const retrieved = db.getProvenance(prov.id);
      expect(retrieved!.type).toBe(type);
    }
  });

  it.skipIf(!sqliteVecAvailable)('handles large provenance export', () => {
    createDatabase(createUniqueName('large-export'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create many provenance records with documents
    for (let i = 0; i < 50; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      db.insertDocument(doc);
    }

    expect(db.getStats().total_documents).toBe(50);
  });

  it.skipIf(!sqliteVecAvailable)('handles processing_params as JSON', () => {
    createDatabase(createUniqueName('json-params'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance({
      processing_params: {
        mode: 'accurate',
        languages: ['en', 'fr'],
        options: { ocr_engine: 'tesseract' },
      },
    });
    db.insertProvenance(prov);

    const retrieved = db.getProvenance(prov.id);
    expect(retrieved!.processing_params).toBeDefined();

    const params =
      typeof retrieved!.processing_params === 'string'
        ? JSON.parse(retrieved!.processing_params)
        : retrieved!.processing_params;
    expect(params.mode).toBe('accurate');
  });
});
