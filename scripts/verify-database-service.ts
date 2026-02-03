#!/usr/bin/env npx tsx
/**
 * Manual verification script for DatabaseService
 *
 * This script performs full state verification by:
 * 1. Creating a real database with known synthetic data
 * 2. Performing all CRUD operations
 * 3. Verifying database state directly via raw SQL
 * 4. Testing edge cases
 *
 * Run: npx tsx scripts/verify-database-service.ts
 */

import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  DatabaseService,
  DatabaseError,
  DatabaseErrorCode,
} from '../src/services/storage/database.js';
import { ProvenanceType } from '../src/models/provenance.js';
import { computeHash } from '../src/utils/hash.js';

// Test result tracking
let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    errors.push(message);
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    errors.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.error(`  ✗ ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotNull<T>(value: T | null, message: string): void {
  if (value !== null) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    errors.push(`${message}: expected non-null value`);
    console.error(`  ✗ ${message}: expected non-null value`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC DATA GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC = {
  document: {
    id: 'doc-synth-001',
    file_path: '/test/synthetic/document.pdf',
    file_name: 'document.pdf',
    file_hash: 'sha256:a'.repeat(64),
    file_size: 12345,
    file_type: 'pdf',
    status: 'pending' as const,
    page_count: null,
    provenance_id: 'prov-synth-001',
    modified_at: null,
    ocr_completed_at: null,
    error_message: null,
  },
  provenance: {
    id: 'prov-synth-001',
    type: ProvenanceType.DOCUMENT,
    created_at: '2026-02-01T00:00:00.000Z',
    processed_at: '2026-02-01T00:00:01.000Z',
    source_file_created_at: '2026-01-15T00:00:00.000Z',
    source_file_modified_at: '2026-01-20T00:00:00.000Z',
    source_type: 'FILE' as const,
    source_path: '/test/synthetic/document.pdf',
    source_id: null,
    root_document_id: 'doc-synth-001',
    location: null,
    content_hash: 'sha256:b'.repeat(64),
    input_hash: null,
    file_hash: 'sha256:a'.repeat(64),
    processor: 'ingest',
    processor_version: '1.0.0',
    processing_params: { mode: 'test' },
    processing_duration_ms: 100,
    processing_quality_score: 0.95,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: null,
  },
};

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  DATABASE SERVICE MANUAL VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const testDir = mkdtempSync(join(tmpdir(), 'db-verify-'));
  console.log(`Test directory: ${testDir}\n`);

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 1: Database Creation
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('TEST 1: Database Creation');
    console.log('─'.repeat(60));

    const dbName = 'test-verify';
    const dbService = DatabaseService.create(dbName, 'Verification test', testDir);

    // Verify file exists
    const dbPath = join(testDir, `${dbName}.db`);
    assert(existsSync(dbPath), 'Database file created');

    // Verify file permissions (Unix only)
    if (platform() !== 'win32') {
      const stats = statSync(dbPath);
      const permissions = stats.mode & 0o777;
      assertEqual(permissions, 0o600, 'File permissions are 0o600');
    }

    // Verify schema via raw connection
    const rawDb = dbService.getConnection();
    const tables = rawDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    assert(tableNames.includes('documents'), 'documents table exists');
    assert(tableNames.includes('provenance'), 'provenance table exists');
    assert(tableNames.includes('chunks'), 'chunks table exists');
    assert(tableNames.includes('embeddings'), 'embeddings table exists');
    assert(tableNames.includes('ocr_results'), 'ocr_results table exists');
    assert(tableNames.includes('database_metadata'), 'database_metadata table exists');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 2: Provenance Insert and Retrieval
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 2: Provenance Insert and Retrieval');
    console.log('─'.repeat(60));

    const provId = dbService.insertProvenance(SYNTHETIC.provenance);
    assertEqual(provId, SYNTHETIC.provenance.id, 'insertProvenance returns correct ID');

    // Verify via getProvenance
    const prov = dbService.getProvenance(provId);
    assertNotNull(prov, 'getProvenance returns record');
    assertEqual(prov!.type, ProvenanceType.DOCUMENT, 'Provenance type matches');
    assertEqual(prov!.processor, 'ingest', 'Provenance processor matches');
    assertEqual(prov!.processing_params.mode, 'test', 'Provenance processing_params parsed correctly');

    // Verify via raw SQL (SOURCE OF TRUTH)
    const provRow = rawDb.prepare('SELECT * FROM provenance WHERE id = ?').get(provId) as any;
    assert(provRow !== undefined, 'Provenance exists in database (raw SQL)');
    assertEqual(provRow.processor, 'ingest', 'Provenance processor in DB matches');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 3: Document Insert and Retrieval
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 3: Document Insert and Retrieval');
    console.log('─'.repeat(60));

    const docId = dbService.insertDocument(SYNTHETIC.document);
    assertEqual(docId, SYNTHETIC.document.id, 'insertDocument returns correct ID');

    // Verify via getDocument
    const doc = dbService.getDocument(docId);
    assertNotNull(doc, 'getDocument returns record');
    assertEqual(doc!.file_path, SYNTHETIC.document.file_path, 'Document file_path matches');
    assertEqual(doc!.file_size, SYNTHETIC.document.file_size, 'Document file_size matches');
    assert(doc!.created_at !== undefined && doc!.created_at.length > 0, 'Document created_at was set');

    // Verify via getDocumentByPath
    const docByPath = dbService.getDocumentByPath(SYNTHETIC.document.file_path);
    assertNotNull(docByPath, 'getDocumentByPath returns record');
    assertEqual(docByPath!.id, docId, 'getDocumentByPath returns correct document');

    // Verify via getDocumentByHash
    const docByHash = dbService.getDocumentByHash(SYNTHETIC.document.file_hash);
    assertNotNull(docByHash, 'getDocumentByHash returns record');
    assertEqual(docByHash!.id, docId, 'getDocumentByHash returns correct document');

    // Verify via raw SQL (SOURCE OF TRUTH)
    const docRow = rawDb.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    assert(docRow !== undefined, 'Document exists in database (raw SQL)');
    assertEqual(docRow.file_path, SYNTHETIC.document.file_path, 'Document file_path in DB matches');

    // Verify metadata count updated
    const metadata = rawDb.prepare('SELECT total_documents FROM database_metadata WHERE id = 1').get() as any;
    assertEqual(metadata.total_documents, 1, 'Metadata total_documents updated to 1');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 4: Document Status Update
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 4: Document Status Update');
    console.log('─'.repeat(60));

    dbService.updateDocumentStatus(docId, 'processing');
    const docProcessing = dbService.getDocument(docId);
    assertEqual(docProcessing!.status, 'processing', 'Status updated to processing');

    dbService.updateDocumentStatus(docId, 'failed', 'Test error message');
    const docFailed = dbService.getDocument(docId);
    assertEqual(docFailed!.status, 'failed', 'Status updated to failed');
    assertEqual(docFailed!.error_message, 'Test error message', 'Error message set correctly');

    // Verify via raw SQL
    const docFailedRow = rawDb.prepare('SELECT status, error_message FROM documents WHERE id = ?').get(docId) as any;
    assertEqual(docFailedRow.status, 'failed', 'Status in DB is failed');
    assertEqual(docFailedRow.error_message, 'Test error message', 'Error message in DB matches');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 5: OCR Result, Chunk, Embedding Chain
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 5: OCR Result, Chunk, Embedding Chain');
    console.log('─'.repeat(60));

    // Create OCR provenance
    const ocrProv = {
      id: 'prov-synth-002',
      type: ProvenanceType.OCR_RESULT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'OCR' as const,
      source_path: null,
      source_id: SYNTHETIC.provenance.id,
      root_document_id: docId,
      location: null,
      content_hash: 'sha256:c'.repeat(64),
      input_hash: 'sha256:a'.repeat(64),
      file_hash: null,
      processor: 'datalab-ocr',
      processor_version: '1.0.0',
      processing_params: { mode: 'balanced' },
      processing_duration_ms: 5000,
      processing_quality_score: 4.5,
      parent_id: SYNTHETIC.provenance.id,
      parent_ids: JSON.stringify([SYNTHETIC.provenance.id]),
      chain_depth: 1,
      chain_path: null,
    };
    dbService.insertProvenance(ocrProv);

    // Create OCR result
    const ocrResult = {
      id: 'ocr-synth-001',
      provenance_id: ocrProv.id,
      document_id: docId,
      extracted_text: 'This is synthetic OCR text for testing.',
      text_length: 40,
      datalab_request_id: 'req-test-001',
      datalab_mode: 'balanced' as const,
      parse_quality_score: 4.5,
      page_count: 3,
      cost_cents: 5,
      content_hash: 'sha256:d'.repeat(64),
      processing_started_at: new Date().toISOString(),
      processing_completed_at: new Date().toISOString(),
      processing_duration_ms: 5000,
    };
    const ocrId = dbService.insertOCRResult(ocrResult);
    assertEqual(ocrId, ocrResult.id, 'insertOCRResult returns correct ID');

    // Verify OCR result exists
    const ocr = dbService.getOCRResult(ocrId);
    assertNotNull(ocr, 'getOCRResult returns record');
    assertEqual(ocr!.extracted_text, ocrResult.extracted_text, 'OCR text matches');

    // Verify via raw SQL
    const ocrRow = rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results WHERE id = ?').get(ocrId) as { c: number };
    assertEqual(ocrRow.c, 1, 'OCR result exists in database (raw SQL)');

    // Create chunk provenance
    const chunkProv = {
      id: 'prov-synth-003',
      type: ProvenanceType.CHUNK,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'CHUNKING' as const,
      source_path: null,
      source_id: ocrProv.id,
      root_document_id: docId,
      location: { page_number: 1, character_start: 0, character_end: 40 },
      content_hash: 'sha256:e'.repeat(64),
      input_hash: 'sha256:c'.repeat(64),
      file_hash: null,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { chunkSize: 2000, overlap: 200 },
      processing_duration_ms: 10,
      processing_quality_score: null,
      parent_id: ocrProv.id,
      parent_ids: JSON.stringify([SYNTHETIC.provenance.id, ocrProv.id]),
      chain_depth: 2,
      chain_path: null,
    };
    dbService.insertProvenance(chunkProv);

    // Create chunk
    const chunk = {
      id: 'chunk-synth-001',
      document_id: docId,
      ocr_result_id: ocrId,
      text: 'This is synthetic OCR text for testing.',
      text_hash: 'sha256:e'.repeat(64),
      chunk_index: 0,
      character_start: 0,
      character_end: 40,
      page_number: 1,
      page_range: null,
      overlap_previous: 0,
      overlap_next: 0,
      provenance_id: chunkProv.id,
    };
    const chunkId = dbService.insertChunk(chunk);
    assertEqual(chunkId, chunk.id, 'insertChunk returns correct ID');

    // Verify chunk
    const chunkRetrieved = dbService.getChunk(chunkId);
    assertNotNull(chunkRetrieved, 'getChunk returns record');
    assertEqual(chunkRetrieved!.embedding_status, 'pending', 'Chunk embedding_status is pending');

    // Verify chunk via raw SQL
    const chunkRow = rawDb.prepare('SELECT embedding_status FROM chunks WHERE id = ?').get(chunkId) as any;
    assertEqual(chunkRow.embedding_status, 'pending', 'Chunk embedding_status in DB is pending');

    // Create embedding provenance
    const embProv = {
      id: 'prov-synth-004',
      type: ProvenanceType.EMBEDDING,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EMBEDDING' as const,
      source_path: null,
      source_id: chunkProv.id,
      root_document_id: docId,
      location: { page_number: 1, chunk_index: 0 },
      content_hash: 'sha256:f'.repeat(64),
      input_hash: 'sha256:e'.repeat(64),
      file_hash: null,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { dimensions: 768, device: 'cuda:0' },
      processing_duration_ms: 50,
      processing_quality_score: null,
      parent_id: chunkProv.id,
      parent_ids: JSON.stringify([SYNTHETIC.provenance.id, ocrProv.id, chunkProv.id]),
      chain_depth: 3,
      chain_path: null,
    };
    dbService.insertProvenance(embProv);

    // Create embedding
    const embedding = {
      id: 'emb-synth-001',
      chunk_id: chunkId,
      document_id: docId,
      original_text: chunk.text,
      original_text_length: chunk.text.length,
      source_file_path: SYNTHETIC.document.file_path,
      source_file_name: SYNTHETIC.document.file_name,
      source_file_hash: SYNTHETIC.document.file_hash,
      page_number: 1,
      page_range: null,
      character_start: 0,
      character_end: 40,
      chunk_index: 0,
      total_chunks: 1,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document' as const,
      inference_mode: 'local' as const,
      gpu_device: 'cuda:0',
      provenance_id: embProv.id,
      content_hash: 'sha256:f'.repeat(64),
      generation_duration_ms: 50,
    };
    const embId = dbService.insertEmbedding(embedding);
    assertEqual(embId, embedding.id, 'insertEmbedding returns correct ID');

    // Verify embedding
    const embRetrieved = dbService.getEmbedding(embId);
    assertNotNull(embRetrieved, 'getEmbedding returns record');
    assertEqual(embRetrieved!.original_text, chunk.text, 'Embedding original_text matches');

    // Verify embedding via raw SQL
    const embRow = rawDb.prepare('SELECT original_text FROM embeddings WHERE id = ?').get(embId) as any;
    assertEqual(embRow.original_text, chunk.text, 'Embedding original_text in DB matches');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 6: Provenance Chain Traversal
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 6: Provenance Chain Traversal');
    console.log('─'.repeat(60));

    const chain = dbService.getProvenanceChain(embProv.id);
    assertEqual(chain.length, 4, 'Chain has 4 records');
    assertEqual(chain[0].type, ProvenanceType.EMBEDDING, 'Chain[0] is EMBEDDING');
    assertEqual(chain[1].type, ProvenanceType.CHUNK, 'Chain[1] is CHUNK');
    assertEqual(chain[2].type, ProvenanceType.OCR_RESULT, 'Chain[2] is OCR_RESULT');
    assertEqual(chain[3].type, ProvenanceType.DOCUMENT, 'Chain[3] is DOCUMENT');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 7: Statistics
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 7: Statistics');
    console.log('─'.repeat(60));

    const stats = dbService.getStats();
    assertEqual(stats.total_documents, 1, 'Stats total_documents is 1');
    assertEqual(stats.total_ocr_results, 1, 'Stats total_ocr_results is 1');
    assertEqual(stats.total_chunks, 1, 'Stats total_chunks is 1');
    assertEqual(stats.total_embeddings, 1, 'Stats total_embeddings is 1');
    assertEqual(stats.chunks_by_embedding_status.pending, 1, 'Stats pending chunks is 1');
    assert(stats.storage_size_bytes > 0, 'Stats storage_size_bytes > 0');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 8: Cascade Delete
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 8: Cascade Delete');
    console.log('─'.repeat(60));

    // Before delete counts
    const beforeCounts = {
      docs: (rawDb.prepare('SELECT COUNT(*) as c FROM documents').get() as { c: number }).c,
      ocrs: (rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results').get() as { c: number }).c,
      chunks: (rawDb.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c,
      embeddings: (rawDb.prepare('SELECT COUNT(*) as c FROM embeddings').get() as { c: number }).c,
      provenance: (rawDb.prepare('SELECT COUNT(*) as c FROM provenance WHERE root_document_id = ?').get(docId) as { c: number }).c,
    };

    assertEqual(beforeCounts.docs, 1, 'Before delete: 1 document');
    assertEqual(beforeCounts.ocrs, 1, 'Before delete: 1 OCR result');
    assertEqual(beforeCounts.chunks, 1, 'Before delete: 1 chunk');
    assertEqual(beforeCounts.embeddings, 1, 'Before delete: 1 embedding');
    assertEqual(beforeCounts.provenance, 4, 'Before delete: 4 provenance records');

    // Delete document
    dbService.deleteDocument(docId);

    // After delete counts
    const afterCounts = {
      docs: (rawDb.prepare('SELECT COUNT(*) as c FROM documents WHERE id = ?').get(docId) as { c: number }).c,
      ocrs: (rawDb.prepare('SELECT COUNT(*) as c FROM ocr_results WHERE document_id = ?').get(docId) as { c: number }).c,
      chunks: (rawDb.prepare('SELECT COUNT(*) as c FROM chunks WHERE document_id = ?').get(docId) as { c: number }).c,
      embeddings: (rawDb.prepare('SELECT COUNT(*) as c FROM embeddings WHERE document_id = ?').get(docId) as { c: number }).c,
      provenance: (rawDb.prepare('SELECT COUNT(*) as c FROM provenance WHERE root_document_id = ?').get(docId) as { c: number }).c,
    };

    assertEqual(afterCounts.docs, 0, 'After delete: 0 documents');
    assertEqual(afterCounts.ocrs, 0, 'After delete: 0 OCR results');
    assertEqual(afterCounts.chunks, 0, 'After delete: 0 chunks');
    assertEqual(afterCounts.embeddings, 0, 'After delete: 0 embeddings');
    assertEqual(afterCounts.provenance, 0, 'After delete: 0 provenance records');

    // Verify metadata counts updated
    const metadataAfter = rawDb.prepare('SELECT total_documents, total_embeddings FROM database_metadata WHERE id = 1').get() as any;
    assertEqual(metadataAfter.total_documents, 0, 'After delete: metadata total_documents is 0');
    assertEqual(metadataAfter.total_embeddings, 0, 'After delete: metadata total_embeddings is 0');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 9: Error Handling
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\nTEST 9: Error Handling');
    console.log('─'.repeat(60));

    // Test DATABASE_NOT_FOUND
    try {
      DatabaseService.open('nonexistent-db-xyz', testDir);
      assert(false, 'Should throw DATABASE_NOT_FOUND');
    } catch (error) {
      assert(error instanceof DatabaseError, 'Throws DatabaseError');
      assertEqual((error as DatabaseError).code, DatabaseErrorCode.DATABASE_NOT_FOUND, 'Error code is DATABASE_NOT_FOUND');
    }

    // Test DATABASE_ALREADY_EXISTS
    try {
      DatabaseService.create(dbName, undefined, testDir);
      assert(false, 'Should throw DATABASE_ALREADY_EXISTS');
    } catch (error) {
      assertEqual((error as DatabaseError).code, DatabaseErrorCode.DATABASE_ALREADY_EXISTS, 'Error code is DATABASE_ALREADY_EXISTS');
    }

    // Test DOCUMENT_NOT_FOUND
    try {
      dbService.updateDocumentStatus('nonexistent-doc', 'processing');
      assert(false, 'Should throw DOCUMENT_NOT_FOUND');
    } catch (error) {
      assertEqual((error as DatabaseError).code, DatabaseErrorCode.DOCUMENT_NOT_FOUND, 'Error code is DOCUMENT_NOT_FOUND');
    }

    // Test INVALID_NAME
    try {
      DatabaseService.create('invalid name!@#', undefined, testDir);
      assert(false, 'Should throw INVALID_NAME');
    } catch (error) {
      assertEqual((error as DatabaseError).code, DatabaseErrorCode.INVALID_NAME, 'Error code is INVALID_NAME');
    }

    // Close database
    dbService.close();

    // ═══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('  VERIFICATION SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);

    if (errors.length > 0) {
      console.log('\nErrors:');
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
    }

    if (failed === 0) {
      console.log('\n  ✓ ALL VERIFICATIONS PASSED\n');
    } else {
      console.log('\n  ✗ SOME VERIFICATIONS FAILED\n');
      process.exit(1);
    }

  } finally {
    // Cleanup
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

main().catch(error => {
  console.error('Verification failed with error:', error);
  process.exit(1);
});
