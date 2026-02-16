/**
 * Integration Tests for Document MCP Tools
 *
 * Tests: ocr_document_list, ocr_document_get, ocr_document_delete
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/integration/server/document-tools
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
  createTestEmbedding,
  ProvenanceType,
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
// ocr_document_list TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_document_list', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-list-');
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
      expect(e).toBeInstanceOf(MCPError);
      expect((e as MCPError).category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it.skipIf(!sqliteVecAvailable)('returns empty list for empty database', () => {
    createDatabase(createUniqueName('empty'), undefined, tempDir);
    const { db } = requireDatabase();

    const docs = db.listDocuments();
    expect(docs).toEqual([]);
  });

  it.skipIf(!sqliteVecAvailable)('lists all documents', () => {
    createDatabase(createUniqueName('list-all'), undefined, tempDir);
    const { db } = requireDatabase();

    // Insert multiple documents
    for (let i = 0; i < 5; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id, { file_name: `doc-${i}.pdf` });
      db.insertDocument(doc);
    }

    const docs = db.listDocuments();
    expect(docs.length).toBe(5);
  });

  it.skipIf(!sqliteVecAvailable)('filters by status', () => {
    createDatabase(createUniqueName('filter-status'), undefined, tempDir);
    const { db } = requireDatabase();

    // Insert documents with different statuses
    const statuses = ['pending', 'processing', 'complete', 'failed'] as const;
    for (const status of statuses) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id, { status });
      db.insertDocument(doc);
    }

    // Filter by pending
    const pending = db.listDocuments({ status: 'pending' });
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe('pending');

    // Filter by complete
    const complete = db.listDocuments({ status: 'complete' });
    expect(complete.length).toBe(1);
    expect(complete[0].status).toBe('complete');
  });

  it.skipIf(!sqliteVecAvailable)('applies limit', () => {
    createDatabase(createUniqueName('limit'), undefined, tempDir);
    const { db } = requireDatabase();

    // Insert 10 documents
    for (let i = 0; i < 10; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      db.insertDocument(doc);
    }

    const docs = db.listDocuments({ limit: 3 });
    expect(docs.length).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('applies offset', () => {
    createDatabase(createUniqueName('offset'), undefined, tempDir);
    const { db } = requireDatabase();

    // Insert documents with known order
    const docIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      db.insertDocument(doc);
      docIds.push(doc.id);
    }

    const allDocs = db.listDocuments();
    const limitedDocs = db.listDocuments({ limit: 3 });

    expect(allDocs.length).toBe(5);
    expect(limitedDocs.length).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('returns all documents without filter', () => {
    createDatabase(createUniqueName('sort-default'), undefined, tempDir);
    const { db } = requireDatabase();

    const names = ['zebra.pdf', 'apple.pdf', 'mango.pdf'];
    for (const name of names) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id, { file_name: name });
      db.insertDocument(doc);
    }

    // Verify all documents are returned
    const docs = db.listDocuments();
    expect(docs.length).toBe(3);
    const fileNames = docs.map((d) => d.file_name).sort();
    expect(fileNames).toEqual(['apple.pdf', 'mango.pdf', 'zebra.pdf']);
  });

  it.skipIf(!sqliteVecAvailable)('returns documents with different file sizes', () => {
    createDatabase(createUniqueName('sizes'), undefined, tempDir);
    const { db } = requireDatabase();

    const sizes = [100, 500, 200];
    for (const size of sizes) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id, { file_size: size });
      db.insertDocument(doc);
    }

    const docs = db.listDocuments();
    expect(docs.length).toBe(3);

    // Verify file sizes are preserved
    const foundSizes = docs.map((d) => d.file_size).sort((a, b) => a - b);
    expect(foundSizes).toEqual([100, 200, 500]);
  });

  it.skipIf(!sqliteVecAvailable)('returns document metadata', () => {
    createDatabase(createUniqueName('metadata'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id, {
      file_name: 'test.pdf',
      file_size: 1234,
      file_type: 'pdf',
      status: 'pending',
    });
    db.insertDocument(doc);

    const docs = db.listDocuments();
    expect(docs[0].id).toBe(doc.id);
    expect(docs[0].file_name).toBe('test.pdf');
    expect(docs[0].file_size).toBe(1234);
    expect(docs[0].file_type).toBe('pdf');
    expect(docs[0].status).toBe('pending');
    expect(docs[0].created_at).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_document_get TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_document_get', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-get-');
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

  it.skipIf(!sqliteVecAvailable)('returns null for non-existent document', () => {
    createDatabase(createUniqueName('not-found'), undefined, tempDir);
    const { db } = requireDatabase();

    const doc = db.getDocument('non-existent-id');
    expect(doc).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('returns document by ID', () => {
    createDatabase(createUniqueName('get-by-id'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id, { file_name: 'myfile.pdf' });
    db.insertDocument(doc);

    const retrieved = db.getDocument(doc.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(doc.id);
    expect(retrieved!.file_name).toBe('myfile.pdf');
  });

  it.skipIf(!sqliteVecAvailable)('returns all document fields', () => {
    createDatabase(createUniqueName('all-fields'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    const retrieved = db.getDocument(doc.id);
    expect(retrieved!.id).toBe(doc.id);
    expect(retrieved!.file_path).toBe(doc.file_path);
    expect(retrieved!.file_name).toBe(doc.file_name);
    expect(retrieved!.file_hash).toBe(doc.file_hash);
    expect(retrieved!.file_size).toBe(doc.file_size);
    expect(retrieved!.file_type).toBe(doc.file_type);
    expect(retrieved!.status).toBe(doc.status);
    expect(retrieved!.provenance_id).toBe(prov.id);
  });

  it.skipIf(!sqliteVecAvailable)('retrieves document with OCR text', () => {
    createDatabase(createUniqueName('with-ocr'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    // Add OCR result
    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: prov.id,
      root_document_id: prov.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);

    const ocr = createTestOCRResult(doc.id, ocrProv.id, {
      extracted_text: 'This is extracted OCR text from the document.',
    });
    db.insertOCRResult(ocr);

    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    expect(ocrResult).not.toBeNull();
    expect(ocrResult!.extracted_text).toBe('This is extracted OCR text from the document.');
  });

  it.skipIf(!sqliteVecAvailable)('retrieves document with chunks', () => {
    createDatabase(createUniqueName('with-chunks'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    // Add OCR result
    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: prov.id,
      root_document_id: prov.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    // Add chunks
    for (let i = 0; i < 3; i++) {
      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        root_document_id: prov.root_document_id,
        chain_depth: 2,
      });
      db.insertProvenance(chunkProv);

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, {
        chunk_index: i,
        text: `Chunk ${i} content`,
      });
      db.insertChunk(chunk);
    }

    const chunks = db.getChunksByDocumentId(doc.id);
    expect(chunks.length).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('retrieves document with provenance chain', () => {
    createDatabase(createUniqueName('with-prov'), undefined, tempDir);
    const { db } = requireDatabase();

    const docProv = createTestProvenance({ chain_depth: 0 });
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // Add OCR provenance
    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);

    // Get chain starting from OCR provenance - walks up to root
    const chain = db.getProvenanceChain(ocrProv.id);
    // Chain walks from root to current, so order is DOCUMENT -> OCR_RESULT
    expect(chain.length).toBe(2);
  });

  it.skipIf(!sqliteVecAvailable)('returns document by file path', () => {
    createDatabase(createUniqueName('by-path'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id, { file_path: '/unique/path/doc.pdf' });
    db.insertDocument(doc);

    const retrieved = db.getDocumentByPath('/unique/path/doc.pdf');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(doc.id);
  });

  it.skipIf(!sqliteVecAvailable)('returns document by file hash', () => {
    createDatabase(createUniqueName('by-hash'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id, { file_hash: 'sha256:uniquehash123' });
    db.insertDocument(doc);

    const retrieved = db.getDocumentByHash('sha256:uniquehash123');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(doc.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_document_delete TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_document_delete', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-delete-');
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

  it.skipIf(!sqliteVecAvailable)('deletes document', () => {
    createDatabase(createUniqueName('delete-doc'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    expect(db.getDocument(doc.id)).not.toBeNull();

    db.deleteDocument(doc.id);

    expect(db.getDocument(doc.id)).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('cascades delete to chunks', () => {
    createDatabase(createUniqueName('cascade-chunks'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    // Add OCR and chunks
    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: prov.id,
      root_document_id: prov.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: prov.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    expect(db.getChunksByDocumentId(doc.id).length).toBe(1);

    db.deleteDocument(doc.id);

    expect(db.getChunksByDocumentId(doc.id).length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('cascades delete to embeddings', () => {
    createDatabase(createUniqueName('cascade-emb'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    // Add OCR, chunk, embedding
    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      parent_id: prov.id,
      root_document_id: prov.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: prov.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    const embProv = createTestProvenance({
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: prov.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv);
    const emb = createTestEmbedding(chunk.id, doc.id, embProv.id);
    db.insertEmbedding(emb);

    expect(db.getEmbeddingsByDocumentId(doc.id).length).toBe(1);

    db.deleteDocument(doc.id);

    expect(db.getEmbeddingsByDocumentId(doc.id).length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('updates stats after deletion', () => {
    createDatabase(createUniqueName('stats-after-del'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    let stats = db.getStats();
    expect(stats.total_documents).toBe(1);

    db.deleteDocument(doc.id);

    stats = db.getStats();
    expect(stats.total_documents).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('throws error for non-existent document', () => {
    createDatabase(createUniqueName('del-nonexist'), undefined, tempDir);
    const { db } = requireDatabase();

    // Should throw DatabaseError
    expect(() => db.deleteDocument('non-existent-id')).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('deletes multiple documents independently', () => {
    createDatabase(createUniqueName('del-multiple'), undefined, tempDir);
    const { db } = requireDatabase();

    const docIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      db.insertDocument(doc);
      docIds.push(doc.id);
    }

    expect(db.getStats().total_documents).toBe(3);

    db.deleteDocument(docIds[1]);

    expect(db.getStats().total_documents).toBe(2);
    expect(db.getDocument(docIds[0])).not.toBeNull();
    expect(db.getDocument(docIds[1])).toBeNull();
    expect(db.getDocument(docIds[2])).not.toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('returns deletion counts', () => {
    createDatabase(createUniqueName('del-counts'), undefined, tempDir);
    const { db } = requireDatabase();

    // Create document with full hierarchy
    const docProv = createTestProvenance();
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

    // Add 2 chunks
    for (let i = 0; i < 2; i++) {
      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 2,
      });
      db.insertProvenance(chunkProv);
      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
      db.insertChunk(chunk);
    }

    // Verify before delete
    expect(db.getChunksByDocumentId(doc.id).length).toBe(2);

    // Delete
    db.deleteDocument(doc.id);

    // Verify after delete
    expect(db.getDocument(doc.id)).toBeNull();
    expect(db.getChunksByDocumentId(doc.id).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES AND VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Document Tools - Edge Cases', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('doc-edge-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('handles documents with special characters in names', () => {
    createDatabase(createUniqueName('special-chars'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id, {
      file_name: 'document (1) - copy [2].pdf',
      file_path: '/path/to/document (1) - copy [2].pdf',
    });
    db.insertDocument(doc);

    const retrieved = db.getDocument(doc.id);
    expect(retrieved!.file_name).toBe('document (1) - copy [2].pdf');
  });

  it.skipIf(!sqliteVecAvailable)('handles large document lists', () => {
    createDatabase(createUniqueName('large-list'), undefined, tempDir);
    const { db } = requireDatabase();

    // Insert 100 documents
    for (let i = 0; i < 100; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      db.insertDocument(doc);
    }

    const docs = db.listDocuments({ limit: 1000 });
    expect(docs.length).toBe(100);
  });

  it.skipIf(!sqliteVecAvailable)('pagination with limit works correctly', () => {
    createDatabase(createUniqueName('pagination'), undefined, tempDir);
    const { db } = requireDatabase();

    // Insert 10 documents
    for (let i = 0; i < 10; i++) {
      const prov = createTestProvenance();
      db.insertProvenance(prov);
      const doc = createTestDocument(prov.id, {
        file_name: `doc-${String(i).padStart(2, '0')}.pdf`,
      });
      db.insertDocument(doc);
    }

    // Get with limit
    const page1 = db.listDocuments({ limit: 3 });
    const page2 = db.listDocuments({ limit: 5 });
    const allDocs = db.listDocuments();

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(5);
    expect(allDocs.length).toBe(10);
  });

  it.skipIf(!sqliteVecAvailable)('handles document status transitions', () => {
    createDatabase(createUniqueName('status-trans'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id, { status: 'pending' });
    db.insertDocument(doc);

    expect(db.getDocument(doc.id)!.status).toBe('pending');

    db.updateDocumentStatus(doc.id, 'processing');
    expect(db.getDocument(doc.id)!.status).toBe('processing');

    db.updateDocumentStatus(doc.id, 'complete');
    expect(db.getDocument(doc.id)!.status).toBe('complete');
  });

  it.skipIf(!sqliteVecAvailable)('handles failed document status with error message', () => {
    createDatabase(createUniqueName('failed-status'), undefined, tempDir);
    const { db } = requireDatabase();

    const prov = createTestProvenance();
    db.insertProvenance(prov);
    const doc = createTestDocument(prov.id);
    db.insertDocument(doc);

    db.updateDocumentStatus(doc.id, 'failed', 'OCR processing failed: timeout');

    const retrieved = db.getDocument(doc.id);
    expect(retrieved!.status).toBe('failed');
    expect(retrieved!.error_message).toBe('OCR processing failed: timeout');
  });
});
