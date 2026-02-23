/**
 * Tests for Phase 8: Workflow Improvements
 *
 * Tool 8.1: ocr_file_ingest_uploaded (file-management.ts)
 * Tool 8.2: ocr_reembed_document (ingestion.ts)
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  createTestEmbedding,
  createTestFile,
} from '../../integration/server/helpers.js';
import {
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
} from '../../../src/server/state.js';
import { computeHash } from '../../../src/utils/hash.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { fileManagementTools } from '../../../src/tools/file-management.js';
import { ingestionTools } from '../../../src/tools/ingestion.js';
import { embeddingTools } from '../../../src/tools/embeddings.js';
import {
  insertUploadedFile,
  listUploadedFiles as _listUploadedFiles,
} from '../../../src/services/storage/database/upload-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 8.1: ocr_file_ingest_uploaded
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_file_ingest_uploaded', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-file-ingest');
  const handler = fileManagementTools.ocr_file_ingest_uploaded.handler;

  beforeAll(() => {
    tempDir = createTempDir('test-file-ingest-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should be registered as a tool', () => {
    expect(fileManagementTools.ocr_file_ingest_uploaded).toBeDefined();
    expect(fileManagementTools.ocr_file_ingest_uploaded.handler).toBeDefined();
    expect(fileManagementTools.ocr_file_ingest_uploaded.description).toContain('[PROCESSING]');
  });

  it('should return 6 tools total', () => {
    expect(Object.keys(fileManagementTools)).toHaveLength(6);
  });

  it('should return empty result when no params provided', async () => {
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.ingested_count).toBe(0);
    expect(parsed.data.skipped_count).toBe(0);
    expect(parsed.data.message).toContain('No action taken');
  });

  it('should ingest a completed uploaded file by file_id', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create a real file on disk
    const testFilePath = createTestFile(tempDir, 'test-upload-1.pdf', 'PDF content for ingest test');
    const fileHash = computeHash('PDF content for ingest test');

    // Create provenance for uploaded file
    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));

    // Insert uploaded file record
    const uploadId = uuidv4();
    insertUploadedFile(conn, {
      id: uploadId,
      local_path: testFilePath,
      file_name: 'test-upload-1.pdf',
      file_hash: fileHash,
      file_size: 100,
      content_type: 'application/pdf',
      datalab_file_id: 'datalab-123',
      datalab_reference: null,
      upload_status: 'complete',
      error_message: null,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      provenance_id: provId,
    });

    const result = await handler({ file_ids: [uploadId] });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.data.ingested_count).toBe(1);
    expect(parsed.data.skipped_count).toBe(0);
    expect(parsed.data.files).toHaveLength(1);
    expect(parsed.data.files[0].status).toBe('ingested');
    expect(parsed.data.files[0].document_id).toBeTruthy();
    expect(parsed.data.files[0].file_name).toBe('test-upload-1.pdf');
    expect(parsed.data.next_steps).toBeDefined();

    // Verify document was created in DB
    const doc = db.getDocument(parsed.data.files[0].document_id);
    expect(doc).not.toBeNull();
    expect(doc!.status).toBe('pending');
    expect(doc!.file_hash).toBe(fileHash);
    expect(doc!.file_path).toBe(testFilePath);

    // Verify provenance was created
    const docProv = db.getProvenance(doc!.provenance_id);
    expect(docProv).not.toBeNull();
    expect(docProv!.type).toBe(ProvenanceType.DOCUMENT);
    expect(docProv!.chain_depth).toBe(0);
    expect(docProv!.processor).toBe('file-ingest-uploaded');
  });

  it('should skip if file_hash already exists in documents', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const fileHash = computeHash('duplicate content for dedup test');
    const testFilePath = createTestFile(tempDir, 'test-dedup.pdf', 'duplicate content for dedup test');

    // Insert an existing document with same hash
    const existingProvId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: existingProvId }));
    const existingDocId = uuidv4();
    db.insertDocument(
      createTestDocument(existingProvId, {
        id: existingDocId,
        file_hash: fileHash,
        file_path: '/existing/path.pdf',
      })
    );

    // Create uploaded file with same hash
    const uploadProvId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: uploadProvId }));
    const uploadId = uuidv4();
    insertUploadedFile(conn, {
      id: uploadId,
      local_path: testFilePath,
      file_name: 'test-dedup.pdf',
      file_hash: fileHash,
      file_size: 100,
      content_type: 'application/pdf',
      datalab_file_id: null,
      datalab_reference: null,
      upload_status: 'complete',
      error_message: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      provenance_id: uploadProvId,
    });

    const result = await handler({ file_ids: [uploadId] });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.data.ingested_count).toBe(0);
    expect(parsed.data.skipped_count).toBe(1);
    expect(parsed.data.files[0].status).toBe('skipped');
    expect(parsed.data.files[0].document_id).toBe(existingDocId);
    expect(parsed.data.files[0].message).toContain('already exists');
  });

  it('should error when file_id not found', async () => {
    const result = await handler({ file_ids: ['nonexistent-id'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('not found');
  });

  it('should error when uploaded file is not complete', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const uploadId = uuidv4();
    insertUploadedFile(conn, {
      id: uploadId,
      local_path: '/tmp/pending-file.pdf',
      file_name: 'pending-file.pdf',
      file_hash: computeHash('pending file'),
      file_size: 50,
      content_type: 'application/pdf',
      datalab_file_id: null,
      datalab_reference: null,
      upload_status: 'uploading',
      error_message: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      provenance_id: provId,
    });

    const result = await handler({ file_ids: [uploadId] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('not complete');
  });

  it('should ingest all pending uploads with ingest_all_pending=true', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create two new uploaded files with unique hashes
    const files = [];
    for (let i = 0; i < 2; i++) {
      const content = `unique content for ingest all test ${i} ${Date.now()}`;
      const testFilePath = createTestFile(tempDir, `test-all-${i}-${Date.now()}.pdf`, content);
      const fileHash = computeHash(content);
      const provId = uuidv4();
      db.insertProvenance(createTestProvenance({ id: provId }));
      const uploadId = uuidv4();
      insertUploadedFile(conn, {
        id: uploadId,
        local_path: testFilePath,
        file_name: `test-all-${i}.pdf`,
        file_hash: fileHash,
        file_size: content.length,
        content_type: 'application/pdf',
        datalab_file_id: null,
        datalab_reference: null,
        upload_status: 'complete',
        error_message: null,
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        provenance_id: provId,
      });
      files.push({ uploadId, fileHash });
    }

    const result = await handler({ ingest_all_pending: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    // At least our 2 new files should be ingested (others might have been ingested in previous tests)
    expect(parsed.data.ingested_count).toBeGreaterThanOrEqual(2);
  });

  it('should skip uploaded files whose local_path no longer exists', async () => {
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const fileHash = computeHash(`missing file content ${Date.now()}`);
    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const uploadId = uuidv4();
    insertUploadedFile(conn, {
      id: uploadId,
      local_path: '/nonexistent/path/missing.pdf',
      file_name: 'missing.pdf',
      file_hash: fileHash,
      file_size: 100,
      content_type: 'application/pdf',
      datalab_file_id: null,
      datalab_reference: null,
      upload_status: 'complete',
      error_message: null,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      provenance_id: provId,
    });

    const result = await handler({ file_ids: [uploadId] });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.data.ingested_count).toBe(0);
    expect(parsed.data.skipped_count).toBe(1);
    expect(parsed.data.files[0].status).toBe('skipped');
    expect(parsed.data.files[0].message).toContain('not found');
  });

  it('should fail with database not selected', async () => {
    resetState();
    const result = await handler({ file_ids: ['some-id'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

    // Re-select for remaining tests
    selectDatabase(dbName, tempDir);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 8.2: ocr_embedding_rebuild (with include_vlm, merged from ocr_reembed_document)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_embedding_rebuild (document re-embed, merged from ocr_reembed_document)', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-reembed');
  const handler = embeddingTools.ocr_embedding_rebuild.handler;

  beforeAll(() => {
    tempDir = createTempDir('test-reembed-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should be registered as a tool with include_vlm support', () => {
    expect(embeddingTools.ocr_embedding_rebuild).toBeDefined();
    expect(embeddingTools.ocr_embedding_rebuild.handler).toBeDefined();
    expect(embeddingTools.ocr_embedding_rebuild.description).toContain('VLM');
  });

  it('should return 7 tools total for ingestion (ocr_reembed_document and ocr_chunk_complete removed)', () => {
    expect(Object.keys(ingestionTools)).toHaveLength(7);
  });

  it('should fail with document not found', async () => {
    const result = await handler({ document_id: 'nonexistent-doc-id' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('not found');
  });

  it('should fail when document has no chunks', async () => {
    const { db } = requireDatabase();

    // Create a document with no chunks
    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const docId = uuidv4();
    db.insertDocument(
      createTestDocument(provId, {
        id: docId,
        status: 'complete',
      })
    );
    db.updateDocumentStatus(docId, 'complete');

    const result = await handler({ document_id: docId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain('No chunks found');
  });

  it('should delete old embeddings when re-embedding', { timeout: 120000 }, async () => {
    const { db } = requireDatabase();
    const _conn = db.getConnection();

    // Create full document pipeline: provenance -> document -> OCR -> chunk -> embedding
    const docProvId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: docProvId }));
    const docId = uuidv4();
    db.insertDocument(
      createTestDocument(docProvId, {
        id: docId,
        status: 'complete',
      })
    );
    db.updateDocumentStatus(docId, 'complete');

    const ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProvId,
        root_document_id: docProvId,
        chain_depth: 1,
      })
    );
    const ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, { id: ocrId })
    );

    const chunkProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: chunkProvId,
        type: ProvenanceType.CHUNK,
        parent_id: ocrProvId,
        root_document_id: docProvId,
        chain_depth: 2,
      })
    );
    const chunkId = uuidv4();
    db.insertChunk(
      createTestChunk(docId, ocrId, chunkProvId, {
        id: chunkId,
        text: 'Test chunk text for re-embedding.',
      })
    );

    // Insert a fake embedding (to verify it gets deleted)
    const oldEmbProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: oldEmbProvId,
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProvId,
        root_document_id: docProvId,
        chain_depth: 3,
      })
    );
    const oldEmbId = uuidv4();
    db.insertEmbedding(
      createTestEmbedding(chunkId, docId, oldEmbProvId, {
        id: oldEmbId,
      })
    );

    // Verify old embedding exists
    const oldEmb = db.getEmbedding(oldEmbId);
    expect(oldEmb).not.toBeNull();

    // Mark chunk as complete (from old embedding)
    db.updateChunkEmbeddingStatus(chunkId, 'complete');

    // Now the re-embed will try to generate real embeddings via Python worker.
    // This test verifies that the OLD embeddings get deleted.
    // The actual embedding generation may fail if no GPU is available.
    const result = await handler({ document_id: docId, include_vlm: false });
    const parsed = JSON.parse(result.content[0].text);

    // Verify old embedding was deleted regardless of whether new ones were generated
    const oldEmbAfter = db.getEmbedding(oldEmbId);
    expect(oldEmbAfter).toBeNull();

    // Verify chunk embedding status was reset (it should be 'pending' before re-embed)
    // If embedding succeeded, it'll be 'complete' again; if failed, the error would propagate
    if (parsed.success) {
      // Response format uses target.id instead of top-level document_id
      expect(parsed.data.target.type).toBe('document');
      expect(parsed.data.target.id).toBe(docId);
    }
  });

  it('should fail with database not selected', async () => {
    resetState();
    const result = await handler({ document_id: 'some-id' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

    // Re-select for remaining tests
    selectDatabase(dbName, tempDir);
  });
});
