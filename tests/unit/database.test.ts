/**
 * Comprehensive Unit Tests for DatabaseService
 *
 * Tests all database operations using REAL SQLite databases in temp directories.
 * NO MOCKS - verifies actual database state after every operation.
 *
 * @see src/services/storage/database.ts
 * @see Task 8 - Database Service Implementation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { v4 as uuidv4 } from 'uuid';
import {
  DatabaseService,
  DatabaseError,
  DatabaseErrorCode,
} from '../../src/services/storage/database.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import { computeHash } from '../../src/utils/hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS FOR TEST DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Helper to check if sqlite-vec extension is available
 */
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
  console.warn(
    'WARNING: sqlite-vec extension not available. Database tests requiring vectors will be skipped.'
  );
}

/**
 * Create test provenance record with default values
 */
function createTestProvenance(overrides: Record<string, unknown> = {}) {
  const id = uuidv4();
  return {
    id,
    type: ProvenanceType.DOCUMENT,
    created_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    source_file_created_at: new Date().toISOString(),
    source_file_modified_at: new Date().toISOString(),
    source_type: 'FILE' as const,
    source_path: '/test/file.pdf',
    source_id: null,
    root_document_id: id,
    location: null,
    content_hash: computeHash('test content ' + id),
    input_hash: null,
    file_hash: computeHash('test file ' + id),
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: { test: true },
    processing_duration_ms: 100,
    processing_quality_score: 0.95,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: null,
    ...overrides,
  };
}

/**
 * Create test document with default values
 */
function createTestDocument(provenanceId: string, overrides: Record<string, unknown> = {}) {
  const id = uuidv4();
  return {
    id,
    file_path: `/test/document-${id}.pdf`,
    file_name: `document-${id}.pdf`,
    file_hash: computeHash('test file hash ' + id),
    file_size: 1024,
    file_type: 'pdf',
    status: 'pending' as const,
    page_count: null,
    provenance_id: provenanceId,
    modified_at: null,
    ocr_completed_at: null,
    error_message: null,
    ...overrides,
  };
}

/**
 * Create test OCR result with default values
 */
function createTestOCRResult(
  documentId: string,
  provenanceId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = uuidv4();
  const now = new Date().toISOString();
  return {
    id,
    provenance_id: provenanceId,
    document_id: documentId,
    extracted_text: 'This is the extracted text from the document.',
    text_length: 46,
    datalab_request_id: `req-${id}`,
    datalab_mode: 'balanced' as const,
    parse_quality_score: 4.5,
    page_count: 3,
    cost_cents: 5,
    content_hash: computeHash('extracted text ' + id),
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 2500,
    ...overrides,
  };
}

/**
 * Create test chunk with default values
 */
function createTestChunk(
  documentId: string,
  ocrResultId: string,
  provenanceId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = uuidv4();
  return {
    id,
    document_id: documentId,
    ocr_result_id: ocrResultId,
    text: 'This is the chunk text content.',
    text_hash: computeHash('chunk text ' + id),
    chunk_index: 0,
    character_start: 0,
    character_end: 31,
    page_number: 1,
    page_range: null,
    overlap_previous: 0,
    overlap_next: 0,
    provenance_id: provenanceId,
    ...overrides,
  };
}

/**
 * Create test embedding with default values
 */
function createTestEmbedding(
  chunkId: string,
  documentId: string,
  provenanceId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = uuidv4();
  return {
    id,
    chunk_id: chunkId,
    document_id: documentId,
    original_text: 'This is the chunk text content.',
    original_text_length: 31,
    source_file_path: '/test/document.pdf',
    source_file_name: 'document.pdf',
    source_file_hash: computeHash('source file'),
    page_number: 1,
    page_range: null,
    character_start: 0,
    character_end: 31,
    chunk_index: 0,
    total_chunks: 1,
    model_name: 'nomic-embed-text-v1.5',
    model_version: '1.5.0',
    task_type: 'search_document' as const,
    inference_mode: 'local' as const,
    gpu_device: 'cuda:0',
    provenance_id: provenanceId,
    content_hash: computeHash('embedding content ' + id),
    generation_duration_ms: 50,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE LIFECYCLE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Lifecycle', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-lifecycle-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('create()', () => {
    it.skipIf(!sqliteVecAvailable)('creates new database with schema', () => {
      const name = `test-create-${String(Date.now())}`;
      const dbService = DatabaseService.create(name, undefined, testDir);

      try {
        // Verify database file exists
        const dbPath = join(testDir, `${name}.db`);
        expect(existsSync(dbPath)).toBe(true);

        // Verify via raw connection that tables exist
        const rawDb = dbService.getConnection();
        const tables = rawDb
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>;
        const tableNames = tables.map((t) => t.name);

        expect(tableNames).toContain('documents');
        expect(tableNames).toContain('provenance');
        expect(tableNames).toContain('chunks');
        expect(tableNames).toContain('embeddings');
        expect(tableNames).toContain('ocr_results');
        expect(tableNames).toContain('database_metadata');
      } finally {
        dbService.close();
      }
    });

    it.skipIf(!sqliteVecAvailable)('creates storage directory if not exists', () => {
      const newStorageDir = join(testDir, `new-storage-${String(Date.now())}`);
      expect(existsSync(newStorageDir)).toBe(false);

      const name = `test-create-dir-${String(Date.now())}`;
      const dbService = DatabaseService.create(name, undefined, newStorageDir);

      try {
        expect(existsSync(newStorageDir)).toBe(true);
        expect(existsSync(join(newStorageDir, `${name}.db`))).toBe(true);
      } finally {
        dbService.close();
      }
    });

    it('throws DATABASE_ALREADY_EXISTS if exists', () => {
      const name = `test-exists-${String(Date.now())}`;

      // Create first database
      const dbService = DatabaseService.create(name, undefined, testDir);
      dbService.close();

      // Try to create again - should throw
      expect(() => {
        DatabaseService.create(name, undefined, testDir);
      }).toThrow(DatabaseError);

      try {
        DatabaseService.create(name, undefined, testDir);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DATABASE_ALREADY_EXISTS);
      }
    });

    it.skipIf(!sqliteVecAvailable || platform() === 'win32')(
      'sets file permissions to 0o600 (Unix only)',
      () => {
        const name = `test-perms-${String(Date.now())}`;
        const dbService = DatabaseService.create(name, undefined, testDir);

        try {
          const dbPath = join(testDir, `${name}.db`);
          const stats = statSync(dbPath);
          // Check if owner-only read/write (0o600 = 384 decimal)
          // The mode includes the file type bits, so we mask with 0o777
          const permissions = stats.mode & 0o777;
          expect(permissions).toBe(0o600);
        } finally {
          dbService.close();
        }
      }
    );
  });

  describe('open()', () => {
    it.skipIf(!sqliteVecAvailable)('opens existing database', () => {
      const name = `test-open-${String(Date.now())}`;

      // Create and close
      const dbService1 = DatabaseService.create(name, undefined, testDir);
      dbService1.close();

      // Re-open
      const dbService2 = DatabaseService.open(name, testDir);
      try {
        expect(dbService2.getName()).toBe(name);
      } finally {
        dbService2.close();
      }
    });

    it('throws DATABASE_NOT_FOUND if not exists', () => {
      expect(() => {
        DatabaseService.open('nonexistent-db-12345', testDir);
      }).toThrow(DatabaseError);

      try {
        DatabaseService.open('nonexistent-db-12345', testDir);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DATABASE_NOT_FOUND);
      }
    });

    it.skipIf(!sqliteVecAvailable)('verifies schema version', () => {
      const name = `test-schema-${String(Date.now())}`;

      // Create database
      const dbService1 = DatabaseService.create(name, undefined, testDir);
      dbService1.close();

      // Open should verify schema
      const dbService2 = DatabaseService.open(name, testDir);
      try {
        // If we get here, schema was verified successfully
        expect(dbService2).toBeDefined();
      } finally {
        dbService2.close();
      }
    });
  });

  describe('list()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all databases with metadata', () => {
      const listDir = join(testDir, `list-test-${String(Date.now())}`);

      // Create multiple databases
      const names = ['db-one', 'db-two', 'db-three'];
      for (const name of names) {
        const dbService = DatabaseService.create(name, undefined, listDir);
        dbService.close();
      }

      // List databases
      const databases = DatabaseService.list(listDir);

      expect(databases.length).toBe(3);
      for (const name of names) {
        const found = databases.find((db) => db.name === name);
        expect(found).toBeDefined();
        expect(found!.path).toBe(join(listDir, `${name}.db`));
        expect(found!.size_bytes).toBeGreaterThan(0);
        expect(found!.created_at).toBeDefined();
      }
    });

    it('returns empty array if no databases', () => {
      const emptyDir = join(testDir, `empty-${String(Date.now())}`);
      const databases = DatabaseService.list(emptyDir);
      expect(databases).toEqual([]);
    });
  });

  describe('delete()', () => {
    it.skipIf(!sqliteVecAvailable)('removes database file', () => {
      const name = `test-delete-${String(Date.now())}`;
      const dbPath = join(testDir, `${name}.db`);

      // Create database
      const dbService = DatabaseService.create(name, undefined, testDir);
      dbService.close();

      expect(existsSync(dbPath)).toBe(true);

      // Delete
      DatabaseService.delete(name, testDir);

      expect(existsSync(dbPath)).toBe(false);
    });

    it('throws DATABASE_NOT_FOUND if not exists', () => {
      expect(() => {
        DatabaseService.delete('nonexistent-db-67890', testDir);
      }).toThrow(DatabaseError);

      try {
        DatabaseService.delete('nonexistent-db-67890', testDir);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DATABASE_NOT_FOUND);
      }
    });

    it.skipIf(!sqliteVecAvailable)('removes WAL and SHM files', () => {
      const name = `test-delete-wal-${String(Date.now())}`;
      const dbPath = join(testDir, `${name}.db`);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;

      // Create database
      const dbService = DatabaseService.create(name, undefined, testDir);

      // Force WAL file creation by writing data
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);
      dbService.close();

      // Delete should clean up all files
      DatabaseService.delete(name, testDir);

      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(shmPath)).toBe(false);
    });
  });

  describe('exists()', () => {
    it.skipIf(!sqliteVecAvailable)('returns true if database exists', () => {
      const name = `test-exists-check-${String(Date.now())}`;

      // Create database
      const dbService = DatabaseService.create(name, undefined, testDir);
      dbService.close();

      expect(DatabaseService.exists(name, testDir)).toBe(true);
    });

    it('returns false if database does not exist', () => {
      expect(DatabaseService.exists('definitely-not-existing-db', testDir)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT OPERATIONS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Document Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-doc-ops-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-doc-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  describe('insertDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts document and returns ID', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      const returnedId = dbService.insertDocument(doc);

      expect(returnedId).toBe(doc.id);

      // Verify via getDocument
      const retrieved = dbService.getDocument(doc.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(doc.id);
      expect(retrieved!.file_path).toBe(doc.file_path);
    });

    it.skipIf(!sqliteVecAvailable)('sets created_at automatically', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      const beforeInsert = new Date().toISOString();
      dbService.insertDocument(doc);
      const afterInsert = new Date().toISOString();

      const retrieved = dbService.getDocument(doc.id);
      expect(retrieved!.created_at).toBeDefined();
      expect(retrieved!.created_at >= beforeInsert).toBe(true);
      expect(retrieved!.created_at <= afterInsert).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)(
      'throws FOREIGN_KEY_VIOLATION if provenance_id invalid',
      () => {
        const doc = createTestDocument('invalid-provenance-id');

        expect(() => {
          dbService.insertDocument(doc);
        }).toThrow(DatabaseError);

        try {
          dbService.insertDocument(doc);
        } catch (error) {
          expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
        }
      }
    );
  });

  describe('getDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('returns document by ID', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      dbService.insertDocument(doc);

      const retrieved = dbService.getDocument(doc.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.file_path).toBe(doc.file_path);
      expect(retrieved!.file_name).toBe(doc.file_name);
      expect(retrieved!.file_hash).toBe(doc.file_hash);
      expect(retrieved!.file_size).toBe(doc.file_size);
      expect(retrieved!.file_type).toBe(doc.file_type);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService.getDocument('nonexistent-doc-id');
      expect(result).toBeNull();
    });
  });

  describe('getDocumentByPath()', () => {
    it.skipIf(!sqliteVecAvailable)('returns document by file_path', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);

      const doc = createTestDocument(prov.id, { file_path: '/unique/path/document.pdf' });
      dbService.insertDocument(doc);

      const retrieved = dbService.getDocumentByPath('/unique/path/document.pdf');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(doc.id);
    });
  });

  describe('getDocumentByHash()', () => {
    it.skipIf(!sqliteVecAvailable)('returns document by file_hash', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);

      const uniqueHash = computeHash('unique-file-content-' + String(Date.now()));
      const doc = createTestDocument(prov.id, { file_hash: uniqueHash });
      dbService.insertDocument(doc);

      const retrieved = dbService.getDocumentByHash(uniqueHash);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(doc.id);
    });
  });

  describe('listDocuments()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all documents', () => {
      // Insert multiple documents
      for (let i = 0; i < 3; i++) {
        const prov = createTestProvenance();
        dbService.insertProvenance(prov);
        const doc = createTestDocument(prov.id);
        dbService.insertDocument(doc);
      }

      const documents = dbService.listDocuments();
      expect(documents.length).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('filters by status', () => {
      // Create documents with different statuses
      const statuses = ['pending', 'processing', 'complete', 'failed'] as const;

      for (const status of statuses) {
        const prov = createTestProvenance();
        dbService.insertProvenance(prov);
        const doc = createTestDocument(prov.id, { status });
        dbService.insertDocument(doc);
      }

      const pendingDocs = dbService.listDocuments({ status: 'pending' });
      expect(pendingDocs.length).toBe(1);
      expect(pendingDocs[0].status).toBe('pending');

      const completeDocs = dbService.listDocuments({ status: 'complete' });
      expect(completeDocs.length).toBe(1);
      expect(completeDocs[0].status).toBe('complete');
    });

    it.skipIf(!sqliteVecAvailable)('respects limit and offset', () => {
      // Insert 5 documents
      for (let i = 0; i < 5; i++) {
        const prov = createTestProvenance();
        dbService.insertProvenance(prov);
        const doc = createTestDocument(prov.id);
        dbService.insertDocument(doc);
      }

      const limited = dbService.listDocuments({ limit: 2 });
      expect(limited.length).toBe(2);

      const offset = dbService.listDocuments({ limit: 2, offset: 2 });
      expect(offset.length).toBe(2);

      // Verify no overlap (documents are sorted by created_at DESC)
      const limitedIds = limited.map((d) => d.id);
      const offsetIds = offset.map((d) => d.id);
      for (const id of offsetIds) {
        expect(limitedIds).not.toContain(id);
      }
    });
  });

  describe('updateDocumentStatus()', () => {
    it.skipIf(!sqliteVecAvailable)('updates status', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);
      const doc = createTestDocument(prov.id, { status: 'pending' });
      dbService.insertDocument(doc);

      dbService.updateDocumentStatus(doc.id, 'processing');

      const retrieved = dbService.getDocument(doc.id);
      expect(retrieved!.status).toBe('processing');
    });

    it.skipIf(!sqliteVecAvailable)('sets error_message for failed', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);
      const doc = createTestDocument(prov.id);
      dbService.insertDocument(doc);

      const errorMsg = 'OCR processing failed: timeout';
      dbService.updateDocumentStatus(doc.id, 'failed', errorMsg);

      const retrieved = dbService.getDocument(doc.id);
      expect(retrieved!.status).toBe('failed');
      expect(retrieved!.error_message).toBe(errorMsg);
    });

    it.skipIf(!sqliteVecAvailable)('throws DOCUMENT_NOT_FOUND if not exists', () => {
      expect(() => {
        dbService.updateDocumentStatus('nonexistent-doc', 'processing');
      }).toThrow(DatabaseError);

      try {
        dbService.updateDocumentStatus('nonexistent-doc', 'processing');
      } catch (error) {
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DOCUMENT_NOT_FOUND);
      }
    });
  });

  describe('updateDocumentOCRComplete()', () => {
    it.skipIf(!sqliteVecAvailable)('updates page_count, ocr_completed_at, status', () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);
      const doc = createTestDocument(prov.id, { status: 'processing' });
      dbService.insertDocument(doc);

      const completedAt = new Date().toISOString();
      dbService.updateDocumentOCRComplete(doc.id, 5, completedAt);

      const retrieved = dbService.getDocument(doc.id);
      expect(retrieved!.status).toBe('complete');
      expect(retrieved!.page_count).toBe(5);
      expect(retrieved!.ocr_completed_at).toBe(completedAt);
    });
  });

  describe('deleteDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('cascade deletes all derived data', () => {
      // Create full chain: provenance -> document -> ocr -> chunks -> embeddings
      const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
      dbService.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id);
      dbService.insertDocument(doc);

      // Update root_document_id for child provenance records
      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        root_document_id: doc.id,
        chain_depth: 1,
      });
      dbService.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService.insertOCRResult(ocr);

      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        root_document_id: doc.id,
        chain_depth: 2,
      });
      dbService.insertProvenance(chunkProv);

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService.insertChunk(chunk);

      const embProv = createTestProvenance({
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProv.id,
        root_document_id: doc.id,
        chain_depth: 3,
      });
      dbService.insertProvenance(embProv);

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService.insertEmbedding(embedding);

      // Verify all records exist before delete
      const rawDb = dbService.getConnection();
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM embeddings WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(1);

      // Delete document
      dbService.deleteDocument(doc.id);

      // Verify all records removed
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM embeddings WHERE document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
      expect(
        (rawDb.prepare('SELECT COUNT(*) as c FROM provenance WHERE root_document_id = ?').get(doc.id) as { c: number }).c
      ).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OCR RESULT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - OCR Result Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-ocr-ops-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-ocr-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  describe('insertOCRResult()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and returns ID', () => {
      const docProv = createTestProvenance();
      dbService.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id);
      dbService.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      const returnedId = dbService.insertOCRResult(ocr);

      expect(returnedId).toBe(ocr.id);

      // Verify via raw database query
      const rawDb = dbService.getConnection();
      const row = rawDb.prepare('SELECT * FROM ocr_results WHERE id = ?').get(ocr.id);
      expect(row).toBeDefined();
    });

    it.skipIf(!sqliteVecAvailable)(
      'throws FOREIGN_KEY_VIOLATION if document_id invalid',
      () => {
        const ocrProv = createTestProvenance({ type: ProvenanceType.OCR_RESULT });
        dbService.insertProvenance(ocrProv);

        const ocr = createTestOCRResult('invalid-doc-id', ocrProv.id);

        expect(() => {
          dbService.insertOCRResult(ocr);
        }).toThrow(DatabaseError);

        try {
          dbService.insertOCRResult(ocr);
        } catch (error) {
          expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
        }
      }
    );
  });

  describe('getOCRResult()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID', () => {
      const docProv = createTestProvenance();
      dbService.insertProvenance(docProv);
      const doc = createTestDocument(docProv.id);
      dbService.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService.insertOCRResult(ocr);

      const retrieved = dbService.getOCRResult(ocr.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.extracted_text).toBe(ocr.extracted_text);
      expect(retrieved!.datalab_mode).toBe(ocr.datalab_mode);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService.getOCRResult('nonexistent-ocr-id');
      expect(result).toBeNull();
    });
  });

  describe('getOCRResultByDocumentId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by document_id', () => {
      const docProv = createTestProvenance();
      dbService.insertProvenance(docProv);
      const doc = createTestDocument(docProv.id);
      dbService.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService.insertOCRResult(ocr);

      const retrieved = dbService.getOCRResultByDocumentId(doc.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(ocr.id);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHUNK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Chunk Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-chunk-ops-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-chunk-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  /**
   * Helper to set up prerequisite data for chunk tests
   */
  function setupChunkPrerequisites(): {
    doc: ReturnType<typeof createTestDocument>;
    ocr: ReturnType<typeof createTestOCRResult>;
    chunkProv: ReturnType<typeof createTestProvenance>;
  } {
    const docProv = createTestProvenance();
    dbService.insertProvenance(docProv);

    const doc = createTestDocument(docProv.id);
    dbService.insertDocument(doc);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      root_document_id: doc.id,
    });
    dbService.insertProvenance(ocrProv);

    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    dbService.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      type: ProvenanceType.CHUNK,
      root_document_id: doc.id,
    });
    dbService.insertProvenance(chunkProv);

    return { doc, ocr, chunkProv };
  }

  describe('insertChunk()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts with embedding_status=pending', () => {
      const { doc, ocr, chunkProv } = setupChunkPrerequisites();

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      const returnedId = dbService.insertChunk(chunk);

      expect(returnedId).toBe(chunk.id);

      const retrieved = dbService.getChunk(chunk.id);
      expect(retrieved!.embedding_status).toBe('pending');
      expect(retrieved!.embedded_at).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)(
      'throws FOREIGN_KEY_VIOLATION if references invalid',
      () => {
        const chunk = createTestChunk('invalid-doc', 'invalid-ocr', 'invalid-prov');

        expect(() => {
          dbService.insertChunk(chunk);
        }).toThrow(DatabaseError);

        try {
          dbService.insertChunk(chunk);
        } catch (error) {
          expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
        }
      }
    );
  });

  describe('insertChunks()', () => {
    it.skipIf(!sqliteVecAvailable)('batch insert in transaction', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      // Create multiple chunk provenance records and chunks
      const chunks = [];
      for (let i = 0; i < 5; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(chunkProv);

        chunks.push(
          createTestChunk(doc.id, ocr.id, chunkProv.id, {
            chunk_index: i,
            text: `Chunk ${String(i)} content`,
          })
        );
      }

      const ids = dbService.insertChunks(chunks);

      expect(ids.length).toBe(5);

      // Verify all inserted
      const retrieved = dbService.getChunksByDocumentId(doc.id);
      expect(retrieved.length).toBe(5);
    });
  });

  describe('getChunk()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID', () => {
      const { doc, ocr, chunkProv } = setupChunkPrerequisites();

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService.insertChunk(chunk);

      const retrieved = dbService.getChunk(chunk.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.text).toBe(chunk.text);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService.getChunk('nonexistent-chunk-id');
      expect(result).toBeNull();
    });
  });

  describe('getChunksByDocumentId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all chunks for document', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService.insertChunk(chunk);
      }

      const chunks = dbService.getChunksByDocumentId(doc.id);
      expect(chunks.length).toBe(3);

      // Should be ordered by chunk_index
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[1].chunk_index).toBe(1);
      expect(chunks[2].chunk_index).toBe(2);
    });
  });

  describe('getChunksByOCRResultId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all chunks for OCR result', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService.insertChunk(chunk);
      }

      const chunks = dbService.getChunksByOCRResultId(ocr.id);
      expect(chunks.length).toBe(3);
    });
  });

  describe('getPendingEmbeddingChunks()', () => {
    it.skipIf(!sqliteVecAvailable)('returns chunks with status=pending', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      // Create chunks with different statuses
      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService.insertChunk(chunk);
      }

      // Update one to complete
      const allChunks = dbService.getChunksByDocumentId(doc.id);
      dbService.updateChunkEmbeddingStatus(allChunks[0].id, 'complete', new Date().toISOString());

      const pending = dbService.getPendingEmbeddingChunks();
      expect(pending.length).toBe(2);
      expect(pending.every((c) => c.embedding_status === 'pending')).toBe(true);
    });

    it.skipIf(!sqliteVecAvailable)('respects limit', () => {
      const { doc, ocr } = setupChunkPrerequisites();

      for (let i = 0; i < 10; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService.insertChunk(chunk);
      }

      const pending = dbService.getPendingEmbeddingChunks(5);
      expect(pending.length).toBe(5);
    });
  });

  describe('updateChunkEmbeddingStatus()', () => {
    it.skipIf(!sqliteVecAvailable)('updates status and embedded_at', () => {
      const { doc, ocr, chunkProv } = setupChunkPrerequisites();

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService.insertChunk(chunk);

      const embeddedAt = new Date().toISOString();
      dbService.updateChunkEmbeddingStatus(chunk.id, 'complete', embeddedAt);

      const retrieved = dbService.getChunk(chunk.id);
      expect(retrieved!.embedding_status).toBe('complete');
      expect(retrieved!.embedded_at).toBe(embeddedAt);
    });

    it.skipIf(!sqliteVecAvailable)('throws CHUNK_NOT_FOUND if not exists', () => {
      expect(() => {
        dbService.updateChunkEmbeddingStatus('nonexistent-chunk', 'complete');
      }).toThrow(DatabaseError);

      try {
        dbService.updateChunkEmbeddingStatus('nonexistent-chunk', 'complete');
      } catch (error) {
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.CHUNK_NOT_FOUND);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMBEDDING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Embedding Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-emb-ops-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-emb-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  /**
   * Helper to set up prerequisite data for embedding tests
   */
  function setupEmbeddingPrerequisites(): {
    doc: ReturnType<typeof createTestDocument>;
    chunk: ReturnType<typeof createTestChunk>;
    embProv: ReturnType<typeof createTestProvenance>;
  } {
    const docProv = createTestProvenance();
    dbService.insertProvenance(docProv);

    const doc = createTestDocument(docProv.id);
    dbService.insertDocument(doc);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      root_document_id: doc.id,
    });
    dbService.insertProvenance(ocrProv);

    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    dbService.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      type: ProvenanceType.CHUNK,
      root_document_id: doc.id,
    });
    dbService.insertProvenance(chunkProv);

    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    dbService.insertChunk(chunk);

    const embProv = createTestProvenance({
      type: ProvenanceType.EMBEDDING,
      root_document_id: doc.id,
    });
    dbService.insertProvenance(embProv);

    return { doc, chunk, embProv };
  }

  describe('insertEmbedding()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and returns ID', () => {
      const { doc, chunk, embProv } = setupEmbeddingPrerequisites();

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      const returnedId = dbService.insertEmbedding(embedding);

      expect(returnedId).toBe(embedding.id);

      // Verify via raw database
      const rawDb = dbService.getConnection();
      const row = rawDb.prepare('SELECT * FROM embeddings WHERE id = ?').get(embedding.id);
      expect(row).toBeDefined();
    });

    it.skipIf(!sqliteVecAvailable)(
      'throws FOREIGN_KEY_VIOLATION if references invalid',
      () => {
        const embedding = createTestEmbedding('invalid-chunk', 'invalid-doc', 'invalid-prov');

        expect(() => {
          dbService.insertEmbedding(embedding);
        }).toThrow(DatabaseError);

        try {
          dbService.insertEmbedding(embedding);
        } catch (error) {
          expect((error as DatabaseError).code).toBe(DatabaseErrorCode.FOREIGN_KEY_VIOLATION);
        }
      }
    );
  });

  describe('insertEmbeddings()', () => {
    it.skipIf(!sqliteVecAvailable)('batch insert in transaction', () => {
      const { doc } = setupEmbeddingPrerequisites();

      // Get the chunk we created
      const chunks = dbService.getChunksByDocumentId(doc.id);
      const chunk = chunks[0];

      // Create multiple embeddings for the same chunk
      const embeddings = [];
      for (let i = 0; i < 3; i++) {
        const embProv = createTestProvenance({
          type: ProvenanceType.EMBEDDING,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(embProv);

        embeddings.push(
          createTestEmbedding(chunk.id, doc.id, embProv.id, {
            original_text: `Embedding ${String(i)} text`,
          })
        );
      }

      const ids = dbService.insertEmbeddings(embeddings);

      expect(ids.length).toBe(3);
    });
  });

  describe('getEmbedding()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID (without vector)', () => {
      const { doc, chunk, embProv } = setupEmbeddingPrerequisites();

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService.insertEmbedding(embedding);

      const retrieved = dbService.getEmbedding(embedding.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.original_text).toBe(embedding.original_text);
      expect(retrieved!.model_name).toBe(embedding.model_name);
      // vector should not be included
      expect('vector' in (retrieved as object)).toBe(false);
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService.getEmbedding('nonexistent-emb-id');
      expect(result).toBeNull();
    });
  });

  describe('getEmbeddingByChunkId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by chunk_id', () => {
      const { doc, chunk, embProv } = setupEmbeddingPrerequisites();

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService.insertEmbedding(embedding);

      const retrieved = dbService.getEmbeddingByChunkId(chunk.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(embedding.id);
    });
  });

  describe('getEmbeddingsByDocumentId()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all for document', () => {
      const { doc, chunk } = setupEmbeddingPrerequisites();

      for (let i = 0; i < 3; i++) {
        const embProv = createTestProvenance({
          type: ProvenanceType.EMBEDDING,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(embProv);

        const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id, { chunk_index: i });
        dbService.insertEmbedding(embedding);
      }

      const embeddings = dbService.getEmbeddingsByDocumentId(doc.id);
      expect(embeddings.length).toBe(3);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Provenance Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-prov-ops-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-prov-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  describe('insertProvenance()', () => {
    it.skipIf(!sqliteVecAvailable)('inserts and returns ID', () => {
      const prov = createTestProvenance();
      const returnedId = dbService.insertProvenance(prov);

      expect(returnedId).toBe(prov.id);
    });

    it.skipIf(!sqliteVecAvailable)('stringifies JSON fields correctly', () => {
      const prov = createTestProvenance({
        processing_params: { mode: 'balanced', quality: 0.95 },
        location: { page_number: 1, character_start: 0, character_end: 100 },
      });
      dbService.insertProvenance(prov);

      // Verify via raw query
      const rawDb = dbService.getConnection();
      const row = rawDb.prepare('SELECT processing_params, location FROM provenance WHERE id = ?').get(prov.id) as {
        processing_params: string;
        location: string;
      };

      expect(row.processing_params).toBe(JSON.stringify({ mode: 'balanced', quality: 0.95 }));
      expect(row.location).toBe(JSON.stringify({ page_number: 1, character_start: 0, character_end: 100 }));
    });
  });

  describe('getProvenance()', () => {
    it.skipIf(!sqliteVecAvailable)('returns by ID with parsed JSON fields', () => {
      const prov = createTestProvenance({
        processing_params: { mode: 'accurate', threshold: 0.8 },
        location: { page_number: 2, chunk_index: 5 },
      });
      dbService.insertProvenance(prov);

      const retrieved = dbService.getProvenance(prov.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.processing_params).toEqual({ mode: 'accurate', threshold: 0.8 });
      expect(retrieved!.location).toEqual({ page_number: 2, chunk_index: 5 });
    });

    it.skipIf(!sqliteVecAvailable)('returns null if not found', () => {
      const result = dbService.getProvenance('nonexistent-prov-id');
      expect(result).toBeNull();
    });
  });

  describe('getProvenanceChain()', () => {
    it.skipIf(!sqliteVecAvailable)('returns full ancestor chain', () => {
      // Create chain: doc -> ocr -> chunk -> embedding
      const docProv = createTestProvenance({
        type: ProvenanceType.DOCUMENT,
        chain_depth: 0,
      });
      dbService.insertProvenance(docProv);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 1,
      });
      dbService.insertProvenance(ocrProv);

      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 2,
      });
      dbService.insertProvenance(chunkProv);

      const embProv = createTestProvenance({
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 3,
      });
      dbService.insertProvenance(embProv);

      // Get chain from embedding
      const chain = dbService.getProvenanceChain(embProv.id);

      expect(chain.length).toBe(4);
      expect(chain[0].id).toBe(embProv.id);
      expect(chain[1].id).toBe(chunkProv.id);
      expect(chain[2].id).toBe(ocrProv.id);
      expect(chain[3].id).toBe(docProv.id);
    });

    it.skipIf(!sqliteVecAvailable)('returns empty array if not found', () => {
      const chain = dbService.getProvenanceChain('nonexistent-id');
      expect(chain).toEqual([]);
    });
  });

  describe('getProvenanceByRootDocument()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all for root document', () => {
      const rootId = uuidv4();

      // Create multiple provenance records with same root
      const docProv = createTestProvenance({
        root_document_id: rootId,
        chain_depth: 0,
      });
      dbService.insertProvenance(docProv);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProv.id,
        root_document_id: rootId,
        chain_depth: 1,
      });
      dbService.insertProvenance(ocrProv);

      const records = dbService.getProvenanceByRootDocument(rootId);

      expect(records.length).toBe(2);
      expect(records[0].chain_depth).toBe(0); // Ordered by chain_depth
      expect(records[1].chain_depth).toBe(1);
    });
  });

  describe('getProvenanceChildren()', () => {
    it.skipIf(!sqliteVecAvailable)('returns children by parent_id', () => {
      const parentProv = createTestProvenance({ chain_depth: 0 });
      dbService.insertProvenance(parentProv);

      // Create multiple children
      for (let i = 0; i < 3; i++) {
        const childProv = createTestProvenance({
          type: ProvenanceType.OCR_RESULT,
          parent_id: parentProv.id,
          root_document_id: parentProv.root_document_id,
          chain_depth: 1,
        });
        dbService.insertProvenance(childProv);
      }

      const children = dbService.getProvenanceChildren(parentProv.id);
      expect(children.length).toBe(3);
      expect(children.every((c) => c.parent_id === parentProv.id)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Transactions', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-txn-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-txn-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  describe('transaction()', () => {
    it.skipIf(!sqliteVecAvailable)('commits on success', () => {
      const prov1 = createTestProvenance();
      const prov2 = createTestProvenance();

      dbService.transaction(() => {
        dbService.insertProvenance(prov1);
        dbService.insertProvenance(prov2);
      });

      // Both should exist
      expect(dbService.getProvenance(prov1.id)).not.toBeNull();
      expect(dbService.getProvenance(prov2.id)).not.toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('rolls back on error', () => {
      const prov1 = createTestProvenance();
      const prov2 = createTestProvenance({ id: prov1.id }); // Duplicate ID

      try {
        dbService.transaction(() => {
          dbService.insertProvenance(prov1);
          dbService.insertProvenance(prov2); // This will fail due to duplicate ID
        });
      } catch {
        // Expected
      }

      // Neither should exist due to rollback
      expect(dbService.getProvenance(prov1.id)).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('returns result from function', () => {
      const prov = createTestProvenance();

      const result = dbService.transaction(() => {
        dbService.insertProvenance(prov);
        return 'success';
      });

      expect(result).toBe('success');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATISTICS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Statistics', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-stats-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-stats-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  describe('getStats()', () => {
    it.skipIf(!sqliteVecAvailable)('returns correct counts', () => {
      // Insert test data
      const docProv = createTestProvenance();
      dbService.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id, { status: 'complete' });
      dbService.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService.insertOCRResult(ocr);

      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        root_document_id: doc.id,
      });
      dbService.insertProvenance(chunkProv);

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      dbService.insertChunk(chunk);

      const embProv = createTestProvenance({
        type: ProvenanceType.EMBEDDING,
        root_document_id: doc.id,
      });
      dbService.insertProvenance(embProv);

      const embedding = createTestEmbedding(chunk.id, doc.id, embProv.id);
      dbService.insertEmbedding(embedding);

      const stats = dbService.getStats();

      expect(stats.total_documents).toBe(1);
      expect(stats.total_ocr_results).toBe(1);
      expect(stats.total_chunks).toBe(1);
      expect(stats.total_embeddings).toBe(1);
      expect(stats.documents_by_status.complete).toBe(1);
      expect(stats.chunks_by_embedding_status.pending).toBe(1);
    });

    it.skipIf(!sqliteVecAvailable)('returns correct file size', () => {
      const stats = dbService.getStats();
      expect(stats.storage_size_bytes).toBeGreaterThan(0);
    });

    it.skipIf(!sqliteVecAvailable)('calculates averages correctly', () => {
      // Insert document with 3 chunks
      const docProv = createTestProvenance();
      dbService.insertProvenance(docProv);

      const doc = createTestDocument(docProv.id);
      dbService.insertDocument(doc);

      const ocrProv = createTestProvenance({
        type: ProvenanceType.OCR_RESULT,
        root_document_id: doc.id,
      });
      dbService.insertProvenance(ocrProv);

      const ocr = createTestOCRResult(doc.id, ocrProv.id);
      dbService.insertOCRResult(ocr);

      for (let i = 0; i < 3; i++) {
        const chunkProv = createTestProvenance({
          type: ProvenanceType.CHUNK,
          root_document_id: doc.id,
        });
        dbService.insertProvenance(chunkProv);

        const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, { chunk_index: i });
        dbService.insertChunk(chunk);
      }

      const stats = dbService.getStats();

      expect(stats.avg_chunks_per_document).toBe(3);
    });

    it.skipIf(!sqliteVecAvailable)('handles empty database', () => {
      const stats = dbService.getStats();

      expect(stats.total_documents).toBe(0);
      expect(stats.total_ocr_results).toBe(0);
      expect(stats.total_chunks).toBe(0);
      expect(stats.total_embeddings).toBe(0);
      expect(stats.avg_chunks_per_document).toBe(0);
      expect(stats.avg_embeddings_per_chunk).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// METADATA VERIFICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DatabaseService - Metadata Updates', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'db-meta-'));
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    if (sqliteVecAvailable) {
      const name = `test-meta-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      dbService = DatabaseService.create(name, undefined, testDir);
    }
  });

  afterEach(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  it.skipIf(!sqliteVecAvailable)(
    'updates metadata counts after document insert',
    () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      dbService.insertDocument(doc);

      // Verify metadata updated
      const rawDb = dbService.getConnection();
      const metadata = rawDb
        .prepare('SELECT total_documents FROM database_metadata WHERE id = 1')
        .get() as { total_documents: number };

      expect(metadata.total_documents).toBe(1);
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'updates metadata counts after document delete',
    () => {
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);

      const doc = createTestDocument(prov.id);
      dbService.insertDocument(doc);

      dbService.deleteDocument(doc.id);

      // Verify metadata updated
      const rawDb = dbService.getConnection();
      const metadata = rawDb
        .prepare('SELECT total_documents FROM database_metadata WHERE id = 1')
        .get() as { total_documents: number };

      expect(metadata.total_documents).toBe(0);
    }
  );
});
