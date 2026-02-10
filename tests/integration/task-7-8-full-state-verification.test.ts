/**
 * Full State Verification Test for Tasks 7 & 8
 *
 * This test performs end-to-end verification of:
 * - Task 7: Database Schema & Migrations
 * - Task 8: DatabaseService CRUD operations
 *
 * It verifies:
 * 1. Source of Truth: Data is correctly stored in SQLite database
 * 2. Execute & Inspect: Run operations and verify results
 * 3. Edge Cases: Empty inputs, invalid data, boundary conditions
 * 4. Evidence: Physical database state after operations
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { DatabaseService, DatabaseError, DatabaseErrorCode } from '../../src/services/storage/database.js';
import { initializeDatabase, verifySchema, getCurrentSchemaVersion } from '../../src/services/storage/migrations.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import { computeHash } from '../../src/utils/hash.js';

// Skip if sqlite-vec not available
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

describe('FULL STATE VERIFICATION: Tasks 7 & 8', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'task-7-8-verification-'));
    console.log(`\n[VERIFICATION] Test directory: ${testDir}`);
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Task 7: Database Schema & Migrations', () => {
    it.skipIf(!sqliteVecAvailable)('should create all 9 tables with correct structure', () => {
      const dbPath = join(testDir, 'schema-test.db');
      const db = new Database(dbPath);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);

      initializeDatabase(db);

      // VERIFY: Source of Truth - Check tables exist
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map(t => t.name);
      // Filter out sqlite-vec internal tables
      // Filter out sqlite-vec internal tables and FTS5 shadow tables
      const coreTables = tableNames.filter(name =>
        !name.includes('_chunks') &&
        !name.includes('_info') &&
        !name.includes('_rowids') &&
        !name.includes('_vector_chunks') &&
        !name.startsWith('chunks_fts_')  // FTS5 shadow tables
      );
      console.log('\n[EVIDENCE] Core tables created:', coreTables.join(', '));
      console.log('[EVIDENCE] All tables (including vec/fts internals):', tableNames.join(', '));

      expect(coreTables).toContain('schema_version');
      expect(coreTables).toContain('provenance');
      expect(coreTables).toContain('database_metadata');
      expect(coreTables).toContain('documents');
      expect(coreTables).toContain('ocr_results');
      expect(coreTables).toContain('chunks');
      expect(coreTables).toContain('embeddings');
      expect(coreTables).toContain('vec_embeddings');
      expect(coreTables).toContain('images');
      expect(coreTables).toContain('chunks_fts');
      expect(coreTables).toContain('fts_index_metadata');
      expect(coreTables).toContain('vlm_fts');
      // 12 defined tables + FTS5/vec0 shadow tables
      expect(coreTables.length).toBeGreaterThanOrEqual(12);

      db.close();
    });

    it.skipIf(!sqliteVecAvailable)('should create all required indexes', () => {
      const dbPath = join(testDir, 'index-test.db');
      const db = new Database(dbPath);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);

      initializeDatabase(db);

      const indexes = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name LIKE 'idx_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      console.log('\n[EVIDENCE] Indexes created:', indexNames.length);
      indexNames.forEach(name => console.log(`  - ${name}`));

      expect(indexNames.length).toBe(53);
      expect(indexNames).toContain('idx_documents_file_path');
      expect(indexNames).toContain('idx_documents_file_hash');
      expect(indexNames).toContain('idx_documents_status');
      expect(indexNames).toContain('idx_images_document_id');
      expect(indexNames).toContain('idx_images_ocr_result_id');
      expect(indexNames).toContain('idx_images_vlm_status');
      expect(indexNames).toContain('idx_images_page');
      expect(indexNames).toContain('idx_images_pending');
      expect(indexNames).toContain('idx_images_provenance_id');
      expect(indexNames).toContain('idx_images_content_hash');
      expect(indexNames).toContain('idx_provenance_root_document_id');
      expect(indexNames).toContain('idx_provenance_type');

      db.close();
    });

    it.skipIf(!sqliteVecAvailable)('should set database pragmas correctly (WAL mode, foreign keys)', () => {
      const dbPath = join(testDir, 'pragma-test.db');
      const db = new Database(dbPath);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);

      initializeDatabase(db);

      // VERIFY: WAL mode
      const journalMode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      console.log('\n[EVIDENCE] Journal mode:', journalMode.journal_mode);
      expect(journalMode.journal_mode).toBe('wal');

      // VERIFY: Foreign keys enabled
      const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      console.log('[EVIDENCE] Foreign keys enabled:', foreignKeys.foreign_keys === 1);
      expect(foreignKeys.foreign_keys).toBe(1);

      db.close();
    });

    it.skipIf(!sqliteVecAvailable)('should verify schema integrity', () => {
      const dbPath = join(testDir, 'verify-test.db');
      const db = new Database(dbPath);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);

      initializeDatabase(db);

      const verification = verifySchema(db);
      console.log('\n[EVIDENCE] Schema verification:');
      console.log('  - Valid:', verification.valid);
      console.log('  - Missing tables:', verification.missingTables.length === 0 ? 'none' : verification.missingTables.join(', '));
      console.log('  - Missing indexes:', verification.missingIndexes.length === 0 ? 'none' : verification.missingIndexes.join(', '));

      expect(verification.valid).toBe(true);
      expect(verification.missingTables.length).toBe(0);
      expect(verification.missingIndexes.length).toBe(0);

      db.close();
    });
  });

  describe('Task 8: DatabaseService Operations', () => {
    it.skipIf(!sqliteVecAvailable)('should create database with correct file permissions (SEC-003)', () => {
      const dbName = `perm-test-${Date.now()}`;
      const dbService = DatabaseService.create(dbName, 'Permission test', testDir);

      const dbPath = dbService.getPath();
      expect(existsSync(dbPath)).toBe(true);

      // VERIFY: File permissions (Unix only)
      if (platform() !== 'win32') {
        const stats = statSync(dbPath);
        const mode = (stats.mode & 0o777).toString(8);
        console.log('\n[EVIDENCE] Database file permissions:', mode);
        expect(mode).toBe('600');
      }

      dbService.close();
    });

    it.skipIf(!sqliteVecAvailable)('should perform full CRUD lifecycle and verify physical state', () => {
      const dbName = `crud-test-${Date.now()}`;
      const dbService = DatabaseService.create(dbName, 'CRUD test', testDir);

      console.log('\n[EXECUTE & INSPECT] Starting CRUD lifecycle test');

      // ============ CREATE ============
      // Create provenance
      const provId = uuidv4();
      const now = new Date().toISOString();

      dbService.insertProvenance({
        id: provId,
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        source_id: null,
        root_document_id: provId,
        content_hash: computeHash('test document'),
        processor: 'file-import',
        processor_version: '1.0.0',
        processing_params: { test: true },
        parent_ids: '[]', // JSON string, not array
        chain_depth: 0,
        created_at: now,
        processed_at: now,
        source_file_created_at: now,
        source_file_modified_at: now,
        source_path: '/test/verification-doc.pdf',
        location: null,
        input_hash: null,
        file_hash: computeHash('test file'),
        processing_duration_ms: 0,
        processing_quality_score: null,
        parent_id: null,
        chain_path: null,
      });
      console.log('[CREATE] Provenance inserted:', provId);

      // Create document
      const docId = uuidv4();
      dbService.insertDocument({
        id: docId,
        file_path: '/test/verification-doc.pdf',
        file_name: 'verification-doc.pdf',
        file_hash: computeHash('verification file'),
        file_size: 5000,
        file_type: 'application/pdf',
        status: 'pending',
        provenance_id: provId,
      });
      console.log('[CREATE] Document inserted:', docId);

      // ============ VERIFY PHYSICAL STATE AFTER CREATE ============
      const conn = dbService.getConnection();

      const docRow = conn.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as Record<string, unknown>;
      console.log('\n[SOURCE OF TRUTH] Document row in database:');
      console.log('  - id:', docRow.id);
      console.log('  - file_path:', docRow.file_path);
      console.log('  - status:', docRow.status);
      console.log('  - provenance_id:', docRow.provenance_id);

      expect(docRow.id).toBe(docId);
      expect(docRow.file_path).toBe('/test/verification-doc.pdf');
      expect(docRow.status).toBe('pending');
      expect(docRow.provenance_id).toBe(provId);

      // ============ READ ============
      const retrievedDoc = dbService.getDocument(docId);
      console.log('\n[READ] Document retrieved via service:');
      console.log('  - id:', retrievedDoc?.id);
      console.log('  - status:', retrievedDoc?.status);

      expect(retrievedDoc).not.toBeNull();
      expect(retrievedDoc?.id).toBe(docId);

      // ============ UPDATE ============
      dbService.updateDocumentStatus(docId, 'processing');

      // VERIFY: Physical state after update
      const updatedRow = conn.prepare('SELECT status, modified_at FROM documents WHERE id = ?').get(docId) as Record<string, unknown>;
      console.log('\n[UPDATE] Document after status change:');
      console.log('  - status:', updatedRow.status);
      console.log('  - modified_at:', updatedRow.modified_at);

      expect(updatedRow.status).toBe('processing');
      expect(updatedRow.modified_at).not.toBeNull();

      // ============ VERIFY STATISTICS ============
      const stats = dbService.getStats();
      console.log('\n[EVIDENCE] Database statistics:');
      console.log('  - total_documents:', stats.total_documents);
      console.log('  - documents_by_status:', JSON.stringify(stats.documents_by_status));

      expect(stats.total_documents).toBe(1);
      expect(stats.documents_by_status.processing).toBe(1);

      // ============ DELETE ============
      dbService.deleteDocument(docId);

      // VERIFY: Physical state after delete
      const deletedRow = conn.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
      console.log('\n[DELETE] Document after deletion:', deletedRow === undefined ? 'DELETED' : 'STILL EXISTS');

      expect(deletedRow).toBeUndefined();

      // VERIFY: Stats updated
      const statsAfterDelete = dbService.getStats();
      console.log('[EVIDENCE] Stats after delete:');
      console.log('  - total_documents:', statsAfterDelete.total_documents);

      expect(statsAfterDelete.total_documents).toBe(0);

      dbService.close();
    });

    it.skipIf(!sqliteVecAvailable)('should verify provenance chain with 4-depth (DOC→OCR→CHUNK→EMB)', () => {
      const dbName = `chain-test-${Date.now()}`;
      const dbService = DatabaseService.create(dbName, 'Chain test', testDir);
      const now = new Date().toISOString();

      console.log('\n[EXECUTE] Creating full provenance chain');

      // Depth 0: Document
      const docProvId = uuidv4();
      dbService.insertProvenance({
        id: docProvId,
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        source_id: null,
        root_document_id: docProvId,
        content_hash: computeHash('doc'),
        processor: 'file-import',
        processor_version: '1.0.0',
        processing_params: {},
        parent_ids: '[]',
        chain_depth: 0,
        created_at: now,
        processed_at: now,
        source_file_created_at: now,
        source_file_modified_at: now,
        source_path: '/chain/test.pdf',
        location: null,
        input_hash: null,
        file_hash: computeHash('test'),
        processing_duration_ms: 0,
        processing_quality_score: null,
        parent_id: null,
        chain_path: null,
      });

      const docId = uuidv4();
      dbService.insertDocument({
        id: docId,
        file_path: '/chain/test.pdf',
        file_name: 'test.pdf',
        file_hash: computeHash('test'),
        file_size: 1000,
        file_type: 'application/pdf',
        status: 'complete',
        provenance_id: docProvId,
      });

      // Depth 1: OCR Result
      const ocrProvId = uuidv4();
      dbService.insertProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: docProvId,
        root_document_id: docProvId,
        content_hash: computeHash('ocr'),
        processor: 'datalab-ocr',
        processor_version: '1.0.0',
        processing_params: { mode: 'accurate' },
        parent_ids: JSON.stringify([docProvId]),
        parent_id: docProvId,
        chain_depth: 1,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_path: null,
        location: null,
        input_hash: computeHash('doc'),
        file_hash: computeHash('test'),
        processing_duration_ms: 1000,
        processing_quality_score: 0.95,
        chain_path: null,
      });

      const ocrId = uuidv4();
      dbService.insertOCRResult({
        id: ocrId,
        provenance_id: ocrProvId,
        document_id: docId,
        extracted_text: 'Sample OCR text',
        text_length: 15,
        datalab_request_id: 'req_test',
        datalab_mode: 'accurate',
        page_count: 1,
        content_hash: computeHash('Sample OCR text'),
        processing_started_at: now,
        processing_completed_at: now,
        processing_duration_ms: 1000,
      });

      // Depth 2: Chunk
      const chunkProvId = uuidv4();
      dbService.insertProvenance({
        id: chunkProvId,
        type: ProvenanceType.CHUNK,
        source_type: 'CHUNKING',
        source_id: ocrProvId,
        root_document_id: docProvId,
        content_hash: computeHash('chunk'),
        processor: 'chunker',
        processor_version: '1.0.0',
        processing_params: { size: 2000, overlap: 200 },
        parent_ids: JSON.stringify([docProvId, ocrProvId]),
        parent_id: ocrProvId,
        chain_depth: 2,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_path: null,
        location: null,
        input_hash: computeHash('ocr'),
        file_hash: computeHash('test'),
        processing_duration_ms: 10,
        processing_quality_score: null,
        chain_path: null,
      });

      const chunkId = uuidv4();
      dbService.insertChunk({
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrId,
        text: 'Sample chunk text',
        text_hash: computeHash('Sample chunk text'),
        chunk_index: 0,
        character_start: 0,
        character_end: 17,
        page_number: 1,
        overlap_previous: 0,
        overlap_next: 0,
        provenance_id: chunkProvId,
      });

      // Depth 3: Embedding
      const embProvId = uuidv4();
      dbService.insertProvenance({
        id: embProvId,
        type: ProvenanceType.EMBEDDING,
        source_type: 'EMBEDDING',
        source_id: chunkProvId,
        root_document_id: docProvId,
        content_hash: computeHash('embedding'),
        processor: 'nomic-embed-text-v1.5',
        processor_version: '1.5.0',
        processing_params: { dimensions: 768 },
        parent_ids: JSON.stringify([docProvId, ocrProvId, chunkProvId]),
        parent_id: chunkProvId,
        chain_depth: 3,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_path: null,
        location: null,
        input_hash: computeHash('chunk'),
        file_hash: computeHash('test'),
        processing_duration_ms: 50,
        processing_quality_score: null,
        chain_path: null,
      });

      const embId = uuidv4();
      dbService.insertEmbedding({
        id: embId,
        chunk_id: chunkId,
        document_id: docId,
        original_text: 'Sample chunk text', // CP-002: Original text denormalized
        original_text_length: 17,
        source_file_path: '/chain/test.pdf',
        source_file_name: 'test.pdf',
        source_file_hash: computeHash('test'),
        page_number: 1,
        character_start: 0,
        character_end: 17,
        chunk_index: 0,
        total_chunks: 1,
        model_name: 'nomic-embed-text-v1.5',
        model_version: '1.5.0',
        task_type: 'search_document',
        inference_mode: 'local',
        gpu_device: 'cuda:0',
        provenance_id: embProvId,
        content_hash: computeHash('embedding'),
      });

      // VERIFY: Get provenance chain
      const chain = dbService.getProvenanceChain(embProvId);
      console.log('\n[EVIDENCE] Provenance chain from embedding:');
      chain.forEach((p, i) => {
        console.log(`  ${i}: ${p.type} (depth ${p.chain_depth})`);
      });

      expect(chain.length).toBe(4);
      expect(chain[0].type).toBe(ProvenanceType.EMBEDDING);
      expect(chain[1].type).toBe(ProvenanceType.CHUNK);
      expect(chain[2].type).toBe(ProvenanceType.OCR_RESULT);
      expect(chain[3].type).toBe(ProvenanceType.DOCUMENT);

      // VERIFY: CP-002 - Original text always included
      const embedding = dbService.getEmbedding(embId);
      console.log('\n[EVIDENCE] CP-002 Verification - Original text in embedding:');
      console.log('  - original_text:', embedding?.original_text);

      expect(embedding?.original_text).toBe('Sample chunk text');

      dbService.close();
    });
  });

  describe('Edge Cases & Boundary Conditions', () => {
    it.skipIf(!sqliteVecAvailable)('should return null for non-existent document', () => {
      const dbName = `edge-null-${Date.now()}`;
      const dbService = DatabaseService.create(dbName, 'Edge test', testDir);

      const doc = dbService.getDocument('nonexistent-id-12345');
      console.log('\n[EDGE CASE] Get non-existent document:', doc === null ? 'null (correct)' : 'unexpected value');

      expect(doc).toBeNull();

      dbService.close();
    });

    it.skipIf(!sqliteVecAvailable)('should enforce foreign key constraints', () => {
      const dbName = `edge-fk-${Date.now()}`;
      const dbService = DatabaseService.create(dbName, 'FK test', testDir);

      console.log('\n[EDGE CASE] Testing foreign key constraint violation');

      expect(() => {
        dbService.insertDocument({
          id: uuidv4(),
          file_path: '/test/fk.pdf',
          file_name: 'fk.pdf',
          file_hash: computeHash('fk'),
          file_size: 100,
          file_type: 'application/pdf',
          status: 'pending',
          provenance_id: 'invalid-provenance-id',
        });
      }).toThrow(DatabaseError);

      console.log('[EVIDENCE] Foreign key constraint enforced correctly');

      dbService.close();
    });

    it.skipIf(!sqliteVecAvailable)('should handle empty list results', () => {
      const dbName = `edge-empty-${Date.now()}`;
      const dbService = DatabaseService.create(dbName, 'Empty test', testDir);

      const docs = dbService.listDocuments();
      console.log('\n[EDGE CASE] List documents on empty database:', docs.length);

      expect(docs).toEqual([]);

      dbService.close();
    });

    it.skipIf(!sqliteVecAvailable)('should cascade delete all derived data', () => {
      const dbName = `edge-cascade-${Date.now()}`;
      const dbService = DatabaseService.create(dbName, 'Cascade test', testDir);
      const now = new Date().toISOString();

      // Create full chain
      const provId = uuidv4();
      dbService.insertProvenance({
        id: provId,
        type: ProvenanceType.DOCUMENT,
        source_type: 'FILE',
        source_id: null,
        root_document_id: provId,
        content_hash: computeHash('cascade'),
        processor: 'test',
        processor_version: '1.0.0',
        processing_params: {},
        parent_ids: '[]',
        chain_depth: 0,
        created_at: now,
        processed_at: now,
        source_file_created_at: now,
        source_file_modified_at: now,
        source_path: '/cascade/test.pdf',
        location: null,
        input_hash: null,
        file_hash: computeHash('cascade'),
        processing_duration_ms: 0,
        processing_quality_score: null,
        parent_id: null,
        chain_path: null,
      });

      const docId = uuidv4();
      dbService.insertDocument({
        id: docId,
        file_path: '/cascade/test.pdf',
        file_name: 'test.pdf',
        file_hash: computeHash('cascade'),
        file_size: 100,
        file_type: 'application/pdf',
        status: 'complete',
        provenance_id: provId,
      });

      const ocrProvId = uuidv4();
      dbService.insertProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        source_type: 'OCR',
        source_id: provId,
        root_document_id: provId,
        content_hash: computeHash('ocr'),
        processor: 'ocr',
        processor_version: '1.0.0',
        processing_params: {},
        parent_ids: JSON.stringify([provId]),
        parent_id: provId,
        chain_depth: 1,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_path: null,
        location: null,
        input_hash: computeHash('cascade'),
        file_hash: computeHash('cascade'),
        processing_duration_ms: 100,
        processing_quality_score: null,
        chain_path: null,
      });

      const ocrId = uuidv4();
      dbService.insertOCRResult({
        id: ocrId,
        provenance_id: ocrProvId,
        document_id: docId,
        extracted_text: 'text',
        text_length: 4,
        datalab_request_id: 'req',
        datalab_mode: 'fast',
        page_count: 1,
        content_hash: computeHash('text'),
        processing_started_at: now,
        processing_completed_at: now,
        processing_duration_ms: 100,
      });

      // Get stats before delete
      const statsBefore = dbService.getStats();
      console.log('\n[EDGE CASE] Before cascade delete:');
      console.log('  - documents:', statsBefore.total_documents);
      console.log('  - ocr_results:', statsBefore.total_ocr_results);

      // Delete document (should cascade)
      dbService.deleteDocument(docId);

      // Verify cascade
      const statsAfter = dbService.getStats();
      const ocrAfter = dbService.getOCRResult(ocrId);

      console.log('[EVIDENCE] After cascade delete:');
      console.log('  - documents:', statsAfter.total_documents);
      console.log('  - ocr_results:', statsAfter.total_ocr_results);
      console.log('  - OCR result found:', ocrAfter === null ? 'null (deleted)' : 'still exists');

      expect(statsAfter.total_documents).toBe(0);
      expect(statsAfter.total_ocr_results).toBe(0);
      expect(ocrAfter).toBeNull();

      dbService.close();
    });
  });
});
