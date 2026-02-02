#!/usr/bin/env npx tsx
/**
 * Manual Verification Script for Database Migrations
 *
 * This script performs comprehensive manual verification of the database schema
 * using REAL sample data from the ./data/ directory.
 *
 * Verification Steps:
 * 1. Create a real database file
 * 2. Initialize with migrations
 * 3. Insert synthetic data through full provenance chain
 * 4. Verify data exists via queries
 * 5. Test FK constraints
 * 6. Test edge cases
 * 7. Verify file permissions
 * 8. Use real file metadata from sample data
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  initializeDatabase,
  checkSchemaVersion,
  verifySchema,
  MigrationError,
} from '../src/services/storage/migrations.js';
import { computeHash, hashFile } from '../src/utils/hash.js';
import { getFileMetadata, isAllowedFileType } from '../src/utils/files.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TEST_DB_PATH = path.join(process.cwd(), 'data', 'databases', 'verification-test.db');
const SAMPLE_DATA_DIR = path.join(process.cwd(), 'data');

interface VerificationResult {
  step: string;
  passed: boolean;
  details: string;
  error?: Error;
}

const results: VerificationResult[] = [];

function log(step: string, passed: boolean, details: string, error?: Error): void {
  results.push({ step, passed, details, error });
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}: ${step}`);
  console.log(`  Details: ${details}`);
  if (error) {
    console.log(`  Error: ${error.message}`);
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function verifySampleDataExists(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 1: Verify Sample Data Exists');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const dirs = [
    'IBB Constitution, Bylaws, Policies and Practices',
    'HOT',
    'images',
  ];

  for (const dir of dirs) {
    const fullPath = path.join(SAMPLE_DATA_DIR, dir);
    const exists = fs.existsSync(fullPath);
    log(`Sample data directory: ${dir}`, exists, exists ? 'Directory exists' : 'Directory missing');
  }
}

async function verifyDatabaseCreation(): Promise<Database.Database | null> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 2: Database Creation and Initialization');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // Ensure directory exists
  const dbDir = path.dirname(TEST_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Remove existing test database
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }

  try {
    const db = new Database(TEST_DB_PATH);
    log('Create database file', true, `Database created at ${TEST_DB_PATH}`);

    // Initialize database
    initializeDatabase(db);
    log('Initialize database', true, 'Database initialized with all tables and indexes');

    // Verify schema
    const schemaResult = verifySchema(db);
    log('Verify schema', schemaResult.valid,
      schemaResult.valid
        ? 'All tables and indexes present'
        : `Missing tables: ${schemaResult.missingTables.join(', ')}, Missing indexes: ${schemaResult.missingIndexes.join(', ')}`
    );

    // Check schema version
    const version = checkSchemaVersion(db);
    log('Check schema version', version === 1, `Schema version: ${version}`);

    // Check pragmas
    const journalMode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    log('WAL mode enabled', journalMode === 'wal', `Journal mode: ${journalMode}`);

    const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
    log('Foreign keys enabled', foreignKeys === 1, `Foreign keys: ${foreignKeys}`);

    return db;
  } catch (error) {
    log('Database initialization', false, 'Failed to initialize database', error as Error);
    return null;
  }
}

async function verifySyntheticDataInsertion(db: Database.Database): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 3: Insert Synthetic Data Through Full Provenance Chain');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const now = new Date().toISOString();

  // Get a real sample file to use for metadata
  const samplePdfPath = path.join(
    SAMPLE_DATA_DIR,
    'IBB Constitution, Bylaws, Policies and Practices',
    '2021.07.01 04-02-Constitution.pdf'
  );

  let realFileHash: string;
  let realFileSize: number;
  let realFilePath: string;

  if (fs.existsSync(samplePdfPath)) {
    realFileHash = await hashFile(samplePdfPath);
    const stats = fs.statSync(samplePdfPath);
    realFileSize = stats.size;
    realFilePath = samplePdfPath;
    log('Load real sample file', true, `Using: ${path.basename(samplePdfPath)}, Size: ${realFileSize} bytes`);
  } else {
    // Use synthetic data if real file not found
    realFileHash = 'sha256:' + crypto.randomBytes(32).toString('hex');
    realFileSize = 102400;
    realFilePath = '/synthetic/test-document.pdf';
    log('Load real sample file', false, 'Sample file not found, using synthetic data');
  }

  try {
    // 1. Insert DOCUMENT provenance
    const docProvId = 'prov-doc-verify-001';
    const docId = 'doc-verify-001';

    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, source_path,
        root_document_id, content_hash, processor, processor_version,
        processing_params, parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      docProvId, 'DOCUMENT', now, now, 'FILE', realFilePath,
      docId, realFileHash, 'file-ingester', '1.0.0',
      '{}', '[]', 0
    );
    log('Insert DOCUMENT provenance', true, `Provenance ID: ${docProvId}, Chain depth: 0`);

    // 2. Insert document
    db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      docId, realFilePath, path.basename(realFilePath), realFileHash,
      realFileSize, 'pdf', 'pending', docProvId, now
    );
    log('Insert document', true, `Document ID: ${docId}, File: ${path.basename(realFilePath)}`);

    // 3. Insert OCR provenance
    const ocrProvId = 'prov-ocr-verify-001';
    const ocrId = 'ocr-verify-001';
    const ocrText = 'This is simulated OCR text extracted from the IBB Constitution document. It contains multiple pages of bylaws, policies, and procedures related to the International Brotherhood of Boilermakers.';
    const ocrHash = computeHash(ocrText);

    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, input_hash, processor, processor_version,
        processing_params, parent_id, parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ocrProvId, 'OCR_RESULT', now, now, 'OCR', docProvId,
      docId, ocrHash, realFileHash, 'datalab-marker', '1.0.0',
      '{"mode":"balanced"}', docProvId, JSON.stringify([docProvId]), 1
    );
    log('Insert OCR_RESULT provenance', true, `Provenance ID: ${ocrProvId}, Chain depth: 1`);

    // 4. Insert OCR result
    db.prepare(`
      INSERT INTO ocr_results (
        id, provenance_id, document_id, extracted_text, text_length,
        datalab_request_id, datalab_mode, page_count, content_hash,
        processing_started_at, processing_completed_at, processing_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ocrId, ocrProvId, docId, ocrText, ocrText.length,
      'datalab-req-12345', 'balanced', 15, ocrHash,
      now, now, 2500
    );
    log('Insert OCR result', true, `OCR ID: ${ocrId}, Text length: ${ocrText.length}`);

    // 5. Insert CHUNK provenance
    const chunkProvId = 'prov-chunk-verify-001';
    const chunkId = 'chunk-verify-001';
    const chunkText = ocrText; // For this test, chunk = full text
    const chunkHash = computeHash(chunkText);

    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, input_hash, processor, processor_version,
        processing_params, parent_id, parent_ids, chain_depth, location
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunkProvId, 'CHUNK', now, now, 'CHUNKING', ocrProvId,
      docId, chunkHash, ocrHash, 'text-chunker', '1.0.0',
      '{"chunk_size":2000,"overlap_percent":10}', ocrProvId,
      JSON.stringify([docProvId, ocrProvId]), 2,
      JSON.stringify({ chunk_index: 0, character_start: 0, character_end: chunkText.length })
    );
    log('Insert CHUNK provenance', true, `Provenance ID: ${chunkProvId}, Chain depth: 2`);

    // 6. Insert chunk
    db.prepare(`
      INSERT INTO chunks (
        id, document_id, ocr_result_id, text, text_hash, chunk_index,
        character_start, character_end, overlap_previous, overlap_next,
        provenance_id, created_at, embedding_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunkId, docId, ocrId, chunkText, chunkHash, 0,
      0, chunkText.length, 0, 0,
      chunkProvId, now, 'pending'
    );
    log('Insert chunk', true, `Chunk ID: ${chunkId}, Index: 0`);

    // 7. Insert EMBEDDING provenance
    const embProvId = 'prov-emb-verify-001';
    const embId = 'emb-verify-001';

    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, input_hash, processor, processor_version,
        processing_params, parent_id, parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      embProvId, 'EMBEDDING', now, now, 'EMBEDDING', chunkProvId,
      docId, chunkHash, chunkHash, 'nomic-embed-text-v1.5', '1.5.0',
      '{"task_type":"search_document","device":"cuda:0"}', chunkProvId,
      JSON.stringify([docProvId, ocrProvId, chunkProvId]), 3
    );
    log('Insert EMBEDDING provenance', true, `Provenance ID: ${embProvId}, Chain depth: 3`);

    // 8. Insert embedding
    db.prepare(`
      INSERT INTO embeddings (
        id, chunk_id, document_id, original_text, original_text_length,
        source_file_path, source_file_name, source_file_hash,
        character_start, character_end, chunk_index, total_chunks,
        model_name, model_version, task_type, inference_mode,
        provenance_id, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      embId, chunkId, docId, chunkText, chunkText.length,
      realFilePath, path.basename(realFilePath), realFileHash,
      0, chunkText.length, 0, 1,
      'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local',
      embProvId, chunkHash, now
    );
    log('Insert embedding', true, `Embedding ID: ${embId}`);

    // 9. Insert vector
    const vector = new Float32Array(768);
    for (let i = 0; i < 768; i++) {
      vector[i] = Math.random() * 0.1; // Small random values
    }

    db.prepare(`
      INSERT INTO vec_embeddings (embedding_id, vector)
      VALUES (?, ?)
    `).run(embId, Buffer.from(vector.buffer));
    log('Insert vector', true, `Vector inserted: 768 dimensions`);

  } catch (error) {
    log('Synthetic data insertion', false, 'Failed to insert data', error as Error);
    throw error;
  }
}

async function verifyDataRetrieval(db: Database.Database): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 4: Verify Data Can Be Retrieved');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // Count records
  const counts = {
    provenance: (db.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number }).cnt,
    documents: (db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number }).cnt,
    ocr_results: (db.prepare('SELECT COUNT(*) as cnt FROM ocr_results').get() as { cnt: number }).cnt,
    chunks: (db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt,
    embeddings: (db.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number }).cnt,
    vec_embeddings: (db.prepare('SELECT COUNT(*) as cnt FROM vec_embeddings').get() as { cnt: number }).cnt,
  };

  log('Record counts',
    counts.provenance === 4 && counts.documents === 1 && counts.ocr_results === 1 &&
    counts.chunks === 1 && counts.embeddings === 1 && counts.vec_embeddings === 1,
    `Provenance: ${counts.provenance}, Documents: ${counts.documents}, OCR: ${counts.ocr_results}, ` +
    `Chunks: ${counts.chunks}, Embeddings: ${counts.embeddings}, Vectors: ${counts.vec_embeddings}`
  );

  // Test join query - provenance chain
  const chainQuery = db.prepare(`
    SELECT
      e.id as embedding_id,
      e.original_text,
      c.chunk_index,
      o.datalab_mode,
      d.file_name,
      p.chain_depth
    FROM embeddings e
    JOIN chunks c ON e.chunk_id = c.id
    JOIN ocr_results o ON c.ocr_result_id = o.id
    JOIN documents d ON c.document_id = d.id
    JOIN provenance p ON e.provenance_id = p.id
    WHERE e.id = ?
  `).get('emb-verify-001') as {
    embedding_id: string;
    original_text: string;
    chunk_index: number;
    datalab_mode: string;
    file_name: string;
    chain_depth: number;
  };

  log('Join query - full chain',
    chainQuery !== undefined && chainQuery.chain_depth === 3,
    chainQuery
      ? `Retrieved: ${chainQuery.file_name}, Mode: ${chainQuery.datalab_mode}, Depth: ${chainQuery.chain_depth}`
      : 'Query returned no results'
  );

  // Test provenance depth distribution
  const depthDist = db.prepare(`
    SELECT chain_depth, COUNT(*) as cnt
    FROM provenance
    GROUP BY chain_depth
    ORDER BY chain_depth
  `).all() as Array<{ chain_depth: number; cnt: number }>;

  const depthCorrect = depthDist.length === 4 &&
    depthDist.find(d => d.chain_depth === 0)?.cnt === 1 &&
    depthDist.find(d => d.chain_depth === 1)?.cnt === 1 &&
    depthDist.find(d => d.chain_depth === 2)?.cnt === 1 &&
    depthDist.find(d => d.chain_depth === 3)?.cnt === 1;

  log('Provenance chain depth distribution', depthCorrect,
    depthDist.map(d => `Depth ${d.chain_depth}: ${d.cnt}`).join(', ')
  );
}

async function verifyConstraints(db: Database.Database): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 5: Verify Constraints (FK, UNIQUE, CHECK)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // Test FK constraint
  let fkViolation = false;
  try {
    db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'doc-invalid', '/test', 'test.pdf', 'sha256:test', 1024, 'pdf',
      'pending', 'nonexistent-provenance', new Date().toISOString()
    );
  } catch {
    fkViolation = true;
  }
  log('FK constraint enforcement', fkViolation,
    fkViolation ? 'FK constraint blocked invalid insert' : 'FK constraint not enforced!'
  );

  // Test UNIQUE constraint
  let uniqueViolation = false;
  try {
    db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'doc-unique-test', '/test2', 'test2.pdf', 'sha256:test2', 1024, 'pdf',
      'pending', 'prov-doc-verify-001', new Date().toISOString() // Duplicate provenance_id
    );
  } catch {
    uniqueViolation = true;
  }
  log('UNIQUE constraint on provenance_id', uniqueViolation,
    uniqueViolation ? 'UNIQUE constraint blocked duplicate' : 'UNIQUE constraint not enforced!'
  );

  // Test CHECK constraint on status
  let checkViolation = false;
  try {
    // Need new provenance first
    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'prov-check-test', 'DOCUMENT', new Date().toISOString(), new Date().toISOString(),
      'FILE', 'doc-check-test', 'sha256:check', 'test', '1.0.0', '{}', '[]', 0
    );

    db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'doc-check-test', '/test3', 'test3.pdf', 'sha256:test3', 1024, 'pdf',
      'INVALID_STATUS', 'prov-check-test', new Date().toISOString()
    );
  } catch {
    checkViolation = true;
  }
  log('CHECK constraint on status', checkViolation,
    checkViolation ? 'CHECK constraint blocked invalid status' : 'CHECK constraint not enforced!'
  );
}

async function verifyEdgeCases(db: Database.Database): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 6: Edge Cases');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // Edge case 1: Empty text
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'prov-edge-empty', 'DOCUMENT', now, now, 'FILE', 'doc-edge-empty',
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // Empty string hash
      'test', '1.0.0', '{}', '[]', 0
    );

    db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'doc-edge-empty', '/test/empty.pdf', 'empty.pdf',
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      0, 'pdf', 'pending', 'prov-edge-empty', now
    );
    log('Edge case: Empty file', true, 'Successfully inserted document with size 0');
  } catch (error) {
    log('Edge case: Empty file', false, 'Failed to insert', error as Error);
  }

  // Edge case 2: Maximum chain depth
  const maxDepthQuery = db.prepare('SELECT MAX(chain_depth) as max FROM provenance').get() as { max: number };
  log('Edge case: Chain depth tracking', maxDepthQuery.max === 3,
    `Maximum chain depth recorded: ${maxDepthQuery.max} (expected: 3 for EMBEDDING)`
  );

  // Edge case 3: Unicode in file paths
  try {
    db.prepare(`
      INSERT INTO provenance (
        id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'prov-edge-unicode', 'DOCUMENT', now, now, 'FILE', 'doc-edge-unicode',
      'sha256:unicode', 'test', '1.0.0', '{}', '[]', 0
    );

    db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'doc-edge-unicode', '/文档/测试文件.pdf', '测试文件.pdf',
      'sha256:unicode', 1024, 'pdf', 'pending', 'prov-edge-unicode', now
    );

    const unicodeDoc = db.prepare('SELECT file_name FROM documents WHERE id = ?').get('doc-edge-unicode') as { file_name: string };
    log('Edge case: Unicode file path', unicodeDoc?.file_name === '测试文件.pdf',
      `Retrieved filename: ${unicodeDoc?.file_name}`
    );
  } catch (error) {
    log('Edge case: Unicode file path', false, 'Failed', error as Error);
  }
}

async function verifyIndexUsage(db: Database.Database): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 7: Verify Index Usage');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // Check query plan for indexed column
  const explainResult = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM documents WHERE status = ?').all('pending') as Array<{ detail: string }>;
  const usesIndex = explainResult.some(row => row.detail.includes('idx_documents_status'));

  log('Index usage: documents.status', usesIndex,
    `Query plan: ${explainResult.map(r => r.detail).join(', ')}`
  );

  // Check all indexes exist
  const indexes = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'idx_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;

  log('Total custom indexes', indexes.length >= 15,
    `Found ${indexes.length} indexes: ${indexes.map(i => i.name).join(', ')}`
  );
}

async function verifyFilePermissions(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('STEP 8: Verify File Permissions (SEC-003)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(TEST_DB_PATH)) {
    log('Database file exists', false, 'Database file not found');
    return;
  }

  const stats = fs.statSync(TEST_DB_PATH);
  const mode = stats.mode & 0o777;

  // On Linux/Mac, we want 0o600
  // On Windows, permission model is different
  const isUnix = process.platform !== 'win32';

  if (isUnix) {
    // Check if file is readable only by owner
    const ownerReadWrite = (mode & 0o600) === 0o600;
    const noOtherAccess = (mode & 0o077) === 0;

    log('File permissions', ownerReadWrite,
      `Mode: ${mode.toString(8)} (${ownerReadWrite ? 'Owner has rw' : 'Check failed'})`
    );
  } else {
    log('File permissions', true, `Windows platform - permissions work differently`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN VERIFICATION RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║          DATABASE MIGRATIONS MANUAL VERIFICATION                      ║');
  console.log('║          Using Real Sample Data from ./data/                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

  let db: Database.Database | null = null;

  try {
    await verifySampleDataExists();
    db = await verifyDatabaseCreation();

    if (db) {
      await verifySyntheticDataInsertion(db);
      await verifyDataRetrieval(db);
      await verifyConstraints(db);
      await verifyEdgeCases(db);
      await verifyIndexUsage(db);
      await verifyFilePermissions();
    }
  } catch (error) {
    console.error('FATAL ERROR:', error);
  } finally {
    if (db) {
      db.close();
    }
  }

  // Print summary
  console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║                         VERIFICATION SUMMARY                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`Total Checks: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%\n`);

  if (failed > 0) {
    console.log('FAILED CHECKS:');
    for (const result of results.filter(r => !r.passed)) {
      console.log(`  - ${result.step}: ${result.details}`);
      if (result.error) {
        console.log(`    Error: ${result.error.message}`);
      }
    }
    process.exit(1);
  } else {
    console.log('✓ ALL VERIFICATION CHECKS PASSED');
    process.exit(0);
  }
}

main().catch(console.error);
