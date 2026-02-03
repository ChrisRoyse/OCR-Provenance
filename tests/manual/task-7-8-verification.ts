/**
 * Manual Verification Test for Tasks 7 & 8
 *
 * This script verifies:
 * - Task 7: Database Schema & Migrations (all tables, indexes, constraints)
 * - Task 8: DatabaseService (all CRUD operations)
 *
 * Run with: npx tsx tests/manual/task-7-8-verification.ts
 */

import { DatabaseService } from '../../src/services/storage/database.js';
import { verifySchema } from '../../src/services/storage/migrations.js';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, statSync, unlinkSync } from 'fs';

const TEST_DB_NAME = 'manual-verification-test';

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  evidence?: unknown;
}

const results: TestResult[] = [];

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function addResult(name: string, passed: boolean, details: string, evidence?: unknown): void {
  results.push({ name, passed, details, evidence });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  log(`${status}: ${name}`);
  if (!passed) {
    log(`  Details: ${details}`);
  }
}

async function cleanup(): Promise<void> {
  try {
    if (DatabaseService.exists(TEST_DB_NAME)) {
      DatabaseService.delete(TEST_DB_NAME);
    }
  } catch { /* ignore */ }
}

async function testDatabaseLifecycle(): Promise<void> {
  log('\n=== Testing Database Lifecycle ===');

  // Test 1: Create database
  let db: DatabaseService | null = null;
  try {
    db = DatabaseService.create(TEST_DB_NAME, 'Manual verification test');
    addResult('Create database', true, 'Database created successfully');

    // Verify file exists with correct permissions
    const dbPath = db.getPath();
    if (existsSync(dbPath)) {
      const stats = statSync(dbPath);
      const mode = (stats.mode & 0o777).toString(8);
      addResult('Database file permissions (SEC-003)', mode === '600',
        `File permissions are ${mode} (expected 600)`, { path: dbPath, mode });
    } else {
      addResult('Database file exists', false, 'Database file not found');
    }

    db.close();
  } catch (error) {
    addResult('Create database', false, String(error));
    return;
  }

  // Test 2: Open database
  try {
    db = DatabaseService.open(TEST_DB_NAME);
    addResult('Open database', true, 'Database opened successfully');

    // Verify schema
    const verification = verifySchema(db.getConnection());
    addResult('Schema verification', verification.valid,
      verification.valid ? 'All tables and indexes present' :
      `Missing tables: ${verification.missingTables.join(', ')}, Missing indexes: ${verification.missingIndexes.join(', ')}`,
      verification);

    db.close();
  } catch (error) {
    addResult('Open database', false, String(error));
    return;
  }

  // Test 3: List databases
  try {
    const databases = DatabaseService.list();
    const found = databases.find(d => d.name === TEST_DB_NAME);
    addResult('List databases', !!found,
      found ? 'Database found in list' : 'Database not found in list',
      { databases: databases.map(d => d.name), searching_for: TEST_DB_NAME });
  } catch (error) {
    addResult('List databases', false, String(error));
  }

  // Test 4: Database exists check
  try {
    const exists = DatabaseService.exists(TEST_DB_NAME);
    const notExists = DatabaseService.exists('nonexistent-db-12345');
    addResult('Database exists check', exists && !notExists,
      `exists('${TEST_DB_NAME}')=${exists}, exists('nonexistent')=${notExists}`,
      { exists, notExists });
  } catch (error) {
    addResult('Database exists check', false, String(error));
  }
}

async function testCRUDOperations(): Promise<void> {
  log('\n=== Testing CRUD Operations ===');

  let db: DatabaseService;
  try {
    db = DatabaseService.open(TEST_DB_NAME);
  } catch (error) {
    addResult('Open database for CRUD', false, String(error));
    return;
  }

  try {
    // Create provenance record first (required for FK)
    const provId = uuidv4();
    const now = new Date().toISOString();

    db.insertProvenance({
      id: provId,
      type: 'DOCUMENT',
      source_type: 'FILE',
      source_id: null,
      root_document_id: provId,
      content_hash: 'sha256:' + '0'.repeat(64),
      processor: 'file-import',
      processor_version: '1.0.0',
      processing_params: {},
      parent_ids: [],
      chain_depth: 0,
      created_at: now,
      processed_at: now,
    });
    addResult('Insert provenance', true, 'Provenance record created');

    // Create document
    const docId = uuidv4();
    db.insertDocument({
      id: docId,
      file_path: '/test/sample.pdf',
      file_name: 'sample.pdf',
      file_hash: 'sha256:' + 'a'.repeat(64),
      file_size: 12345,
      file_type: 'application/pdf',
      status: 'pending',
      provenance_id: provId,
    });
    addResult('Insert document', true, 'Document created');

    // Retrieve document and verify
    const retrievedDoc = db.getDocument(docId);
    addResult('Retrieve document', retrievedDoc !== null && retrievedDoc.id === docId,
      retrievedDoc ? 'Document retrieved with correct ID' : 'Document not found',
      { expected: docId, actual: retrievedDoc?.id });

    // Update document status
    db.updateDocumentStatus(docId, 'processing');
    const updatedDoc = db.getDocument(docId);
    addResult('Update document status', updatedDoc?.status === 'processing',
      `Status changed to: ${updatedDoc?.status}`,
      { expected: 'processing', actual: updatedDoc?.status });

    // Create OCR result provenance
    const ocrProvId = uuidv4();
    db.insertProvenance({
      id: ocrProvId,
      type: 'OCR_RESULT',
      source_type: 'OCR',
      source_id: provId,
      root_document_id: provId,
      content_hash: 'sha256:' + 'b'.repeat(64),
      processor: 'datalab-ocr',
      processor_version: '1.0.0',
      processing_params: { mode: 'accurate' },
      parent_ids: [provId],
      chain_depth: 1,
      created_at: now,
      processed_at: now,
    });

    // Create OCR result
    const ocrId = uuidv4();
    db.insertOCRResult({
      id: ocrId,
      provenance_id: ocrProvId,
      document_id: docId,
      extracted_text: 'Sample extracted text from the document.',
      text_length: 42,
      datalab_request_id: 'req_test_12345',
      datalab_mode: 'accurate',
      page_count: 3,
      content_hash: 'sha256:' + 'c'.repeat(64),
      processing_started_at: now,
      processing_completed_at: now,
      processing_duration_ms: 5000,
    });
    addResult('Insert OCR result', true, 'OCR result created');

    // Retrieve OCR result
    const retrievedOcr = db.getOCRResult(ocrId);
    addResult('Retrieve OCR result', retrievedOcr !== null && retrievedOcr.id === ocrId,
      retrievedOcr ? 'OCR result retrieved' : 'OCR result not found',
      { expected: ocrId, actual: retrievedOcr?.id });

    // Get OCR result by document ID
    const ocrByDoc = db.getOCRResultByDocumentId(docId);
    addResult('Get OCR result by document ID', ocrByDoc !== null && ocrByDoc.document_id === docId,
      ocrByDoc ? 'OCR result found by document ID' : 'Not found',
      { expected: docId, actual: ocrByDoc?.document_id });

    // Create chunk provenance
    const chunkProvId = uuidv4();
    db.insertProvenance({
      id: chunkProvId,
      type: 'CHUNK',
      source_type: 'CHUNKING',
      source_id: ocrProvId,
      root_document_id: provId,
      content_hash: 'sha256:' + 'd'.repeat(64),
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { chunk_size: 2000, overlap: 200 },
      parent_ids: [provId, ocrProvId],
      chain_depth: 2,
      created_at: now,
      processed_at: now,
    });

    // Create chunk
    const chunkId = uuidv4();
    db.insertChunk({
      id: chunkId,
      document_id: docId,
      ocr_result_id: ocrId,
      text: 'This is chunk 0 text content.',
      text_hash: 'sha256:' + 'e'.repeat(64),
      chunk_index: 0,
      character_start: 0,
      character_end: 28,
      page_number: 1,
      overlap_previous: 0,
      overlap_next: 0,
      provenance_id: chunkProvId,
    });
    addResult('Insert chunk', true, 'Chunk created');

    // Retrieve chunk
    const retrievedChunk = db.getChunk(chunkId);
    addResult('Retrieve chunk', retrievedChunk !== null && retrievedChunk.id === chunkId,
      retrievedChunk ? 'Chunk retrieved' : 'Chunk not found',
      { expected: chunkId, actual: retrievedChunk?.id, text: retrievedChunk?.text });

    // Get chunks by document ID
    const chunksByDoc = db.getChunksByDocumentId(docId);
    addResult('Get chunks by document ID', chunksByDoc.length > 0,
      `Found ${chunksByDoc.length} chunks for document`,
      { expected: '>=1', actual: chunksByDoc.length });

    // Create embedding provenance
    const embProvId = uuidv4();
    db.insertProvenance({
      id: embProvId,
      type: 'EMBEDDING',
      source_type: 'EMBEDDING',
      source_id: chunkProvId,
      root_document_id: provId,
      content_hash: 'sha256:' + 'f'.repeat(64),
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { dimensions: 768, device: 'cuda:0' },
      parent_ids: [provId, ocrProvId, chunkProvId],
      chain_depth: 3,
      created_at: now,
      processed_at: now,
    });

    // Create embedding (without vector - vector stored separately in vec_embeddings)
    const embId = uuidv4();
    db.insertEmbedding({
      id: embId,
      chunk_id: chunkId,
      document_id: docId,
      original_text: 'This is chunk 0 text content.',
      original_text_length: 29,
      source_file_path: '/test/sample.pdf',
      source_file_name: 'sample.pdf',
      source_file_hash: 'sha256:' + 'a'.repeat(64),
      page_number: 1,
      character_start: 0,
      character_end: 28,
      chunk_index: 0,
      total_chunks: 1,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProvId,
      content_hash: 'sha256:' + 'f'.repeat(64),
    });
    addResult('Insert embedding', true, 'Embedding created');

    // Retrieve embedding
    const retrievedEmb = db.getEmbedding(embId);
    addResult('Retrieve embedding', retrievedEmb !== null && retrievedEmb.id === embId,
      retrievedEmb ? 'Embedding retrieved with original_text' : 'Embedding not found',
      { expected: embId, actual: retrievedEmb?.id, has_original_text: !!retrievedEmb?.original_text });

    // Verify CP-002: Original text always included
    addResult('CP-002: Original text denormalized',
      retrievedEmb?.original_text === 'This is chunk 0 text content.',
      'Embedding includes original_text for self-contained search results',
      { original_text: retrievedEmb?.original_text });

    // Get provenance chain
    const provenanceChain = db.getProvenanceChain(embProvId);
    addResult('Get provenance chain', provenanceChain.length === 4,
      `Chain depth: ${provenanceChain.length} (expected 4: DOC→OCR→CHUNK→EMB)`,
      { chain_length: provenanceChain.length, chain_types: provenanceChain.map(p => p.type) });

    // Verify statistics
    const stats = db.getStats();
    addResult('Database statistics',
      stats.total_documents === 1 &&
      stats.total_ocr_results === 1 &&
      stats.total_chunks === 1 &&
      stats.total_embeddings === 1,
      `docs=${stats.total_documents}, ocr=${stats.total_ocr_results}, chunks=${stats.total_chunks}, emb=${stats.total_embeddings}`,
      stats);

    // Test cascade delete
    db.deleteDocument(docId);
    const deletedDoc = db.getDocument(docId);
    const deletedOcr = db.getOCRResult(ocrId);
    const deletedChunk = db.getChunk(chunkId);
    const deletedEmb = db.getEmbedding(embId);

    addResult('Cascade delete',
      deletedDoc === null && deletedOcr === null && deletedChunk === null && deletedEmb === null,
      'All derived data deleted when document deleted',
      { doc: deletedDoc, ocr: deletedOcr, chunk: deletedChunk, emb: deletedEmb });

    // Verify stats after delete
    const statsAfterDelete = db.getStats();
    addResult('Stats after delete',
      statsAfterDelete.total_documents === 0 &&
      statsAfterDelete.total_ocr_results === 0 &&
      statsAfterDelete.total_chunks === 0 &&
      statsAfterDelete.total_embeddings === 0,
      `After delete: docs=${statsAfterDelete.total_documents}, ocr=${statsAfterDelete.total_ocr_results}, chunks=${statsAfterDelete.total_chunks}, emb=${statsAfterDelete.total_embeddings}`,
      statsAfterDelete);

  } finally {
    db.close();
  }
}

async function testEdgeCases(): Promise<void> {
  log('\n=== Testing Edge Cases ===');

  let db: DatabaseService;
  try {
    db = DatabaseService.open(TEST_DB_NAME);
  } catch (error) {
    addResult('Open database for edge cases', false, String(error));
    return;
  }

  try {
    // Edge Case 1: Get non-existent document
    const nonExistent = db.getDocument('nonexistent-id-12345');
    addResult('Get non-existent document', nonExistent === null,
      'Returns null for non-existent document',
      { result: nonExistent });

    // Edge Case 2: List documents on empty database
    const emptyList = db.listDocuments();
    addResult('List documents (empty database)', Array.isArray(emptyList) && emptyList.length === 0,
      `Returns empty array: length=${emptyList.length}`,
      { result: emptyList });

    // Edge Case 3: Transaction support
    const provId = uuidv4();
    const now = new Date().toISOString();

    try {
      db.transaction(() => {
        db.insertProvenance({
          id: provId,
          type: 'DOCUMENT',
          source_type: 'FILE',
          source_id: null,
          root_document_id: provId,
          content_hash: 'sha256:' + '1'.repeat(64),
          processor: 'test',
          processor_version: '1.0.0',
          processing_params: {},
          parent_ids: [],
          chain_depth: 0,
          created_at: now,
          processed_at: now,
        });

        db.insertDocument({
          id: uuidv4(),
          file_path: '/test/transaction-test.pdf',
          file_name: 'transaction-test.pdf',
          file_hash: 'sha256:' + '2'.repeat(64),
          file_size: 1000,
          file_type: 'application/pdf',
          status: 'pending',
          provenance_id: provId,
        });
      });

      const docs = db.listDocuments();
      addResult('Transaction commit', docs.length > 0,
        'Transaction commits successfully',
        { documents_after_transaction: docs.length });
    } catch (error) {
      addResult('Transaction', false, String(error));
    }

    // Edge Case 4: Invalid FK should fail
    try {
      db.insertDocument({
        id: uuidv4(),
        file_path: '/test/bad-fk.pdf',
        file_name: 'bad-fk.pdf',
        file_hash: 'sha256:' + '3'.repeat(64),
        file_size: 500,
        file_type: 'application/pdf',
        status: 'pending',
        provenance_id: 'invalid-provenance-id', // Invalid FK
      });
      addResult('Foreign key constraint', false, 'Should have thrown FOREIGN_KEY_VIOLATION');
    } catch (error) {
      const msg = String(error);
      addResult('Foreign key constraint', msg.includes('FOREIGN_KEY_VIOLATION'),
        'Foreign key violation detected correctly',
        { error: msg.substring(0, 100) });
    }

    // Edge Case 5: Duplicate provenance_id should fail
    try {
      const existingDocs = db.listDocuments();
      if (existingDocs.length > 0) {
        const existingProvId = existingDocs[0].provenance_id;
        db.insertDocument({
          id: uuidv4(),
          file_path: '/test/dup-prov.pdf',
          file_name: 'dup-prov.pdf',
          file_hash: 'sha256:' + '4'.repeat(64),
          file_size: 500,
          file_type: 'application/pdf',
          status: 'pending',
          provenance_id: existingProvId, // Duplicate
        });
        addResult('Unique constraint on provenance_id', false, 'Should have thrown error');
      } else {
        addResult('Unique constraint on provenance_id', true, 'Skipped - no existing docs');
      }
    } catch (error) {
      addResult('Unique constraint on provenance_id', true,
        'Duplicate provenance_id rejected correctly');
    }

  } finally {
    db.close();
  }
}

async function testSQLiteVec(): Promise<void> {
  log('\n=== Testing sqlite-vec Integration ===');

  let db: DatabaseService;
  try {
    db = DatabaseService.open(TEST_DB_NAME);
  } catch (error) {
    addResult('Open database for sqlite-vec test', false, String(error));
    return;
  }

  try {
    const conn = db.getConnection();

    // Verify vec_embeddings table exists
    const tableExists = conn.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='vec_embeddings'
    `).get();
    addResult('vec_embeddings table exists', !!tableExists,
      tableExists ? 'Virtual table exists' : 'Virtual table not found');

    // Test vector insertion
    const testId = 'test-vec-' + Date.now();
    const testVector = new Float32Array(768);
    for (let i = 0; i < 768; i++) {
      testVector[i] = Math.random();
    }

    try {
      conn.prepare('INSERT INTO vec_embeddings (embedding_id, vector) VALUES (?, ?)').run(
        testId,
        Buffer.from(testVector.buffer)
      );
      addResult('Insert vector', true, 'Successfully inserted 768-dim vector');
    } catch (error) {
      addResult('Insert vector', false, String(error));
    }

    // Test vector query
    try {
      const rows = conn.prepare('SELECT embedding_id FROM vec_embeddings WHERE embedding_id = ?').all(testId);
      addResult('Query vector', rows.length === 1,
        `Found ${rows.length} matching vectors`,
        { expected: 1, actual: rows.length });
    } catch (error) {
      addResult('Query vector', false, String(error));
    }

    // Test vector similarity search (basic structure test)
    try {
      // Create query vector
      const queryVector = new Float32Array(768);
      for (let i = 0; i < 768; i++) {
        queryVector[i] = testVector[i]; // Same as test vector
      }

      const results = conn.prepare(`
        SELECT embedding_id, distance
        FROM vec_embeddings
        WHERE vector MATCH ?
        ORDER BY distance
        LIMIT 5
      `).all(Buffer.from(queryVector.buffer));

      addResult('Vector similarity search', results.length > 0,
        `Found ${results.length} similar vectors`,
        { results_count: results.length });
    } catch (error) {
      addResult('Vector similarity search', false, String(error));
    }

  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  log('=================================================');
  log('MANUAL VERIFICATION TEST - Tasks 7 & 8');
  log('=================================================');

  try {
    await cleanup();
    await testDatabaseLifecycle();
    await testCRUDOperations();
    await testEdgeCases();
    await testSQLiteVec();
  } finally {
    await cleanup();
  }

  // Summary
  log('\n=================================================');
  log('TEST SUMMARY');
  log('=================================================');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  log(`Total: ${results.length} tests`);
  log(`Passed: ${passed}`);
  log(`Failed: ${failed}`);

  if (failed > 0) {
    log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      log(`  - ${r.name}: ${r.details}`);
    }
    process.exit(1);
  } else {
    log('\n✅ ALL TESTS PASSED');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
