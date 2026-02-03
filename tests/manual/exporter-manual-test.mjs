/**
 * Manual verification test for ProvenanceExporter
 *
 * This script performs full state verification with known inputs/outputs.
 * NOT A TEST FILE - Run directly with: node tests/manual/exporter-manual-test.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

// Import compiled modules
import { DatabaseService } from '../../dist/services/storage/database/index.js';
import { ProvenanceTracker, ProvenanceExporter, resetProvenanceTracker } from '../../dist/services/provenance/index.js';
import { ProvenanceType } from '../../dist/models/provenance.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC DATA - Known inputs with predetermined expected outputs
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC = {
  fileContent: 'Invoice #12345 dated 2026-02-03 for $1,500.00',
  ocrText: 'Invoice #12345 dated 2026-02-03 for $1,500.00 - OCR extracted',
  chunkText: 'Invoice #12345 dated',
  embeddingText: 'Invoice #12345 dated',
};

function computeHash(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

async function runManualTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  MANUAL VERIFICATION: ProvenanceExporter');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let testDir;
  let db;
  let errors = 0;

  try {
    // Setup
    testDir = mkdtempSync(join(tmpdir(), 'exporter-manual-'));
    const testFilePath = join(testDir, 'invoice.txt');
    writeFileSync(testFilePath, SYNTHETIC.fileContent);
    const fileHash = computeHash(SYNTHETIC.fileContent);

    console.log('[SETUP] Test directory:', testDir);
    console.log('[SETUP] Test file:', testFilePath);
    console.log('[SETUP] File hash:', fileHash);

    // Pre-compute expected hashes
    const HASHES = {
      file: fileHash,
      ocr: computeHash(SYNTHETIC.ocrText),
      chunk: computeHash(SYNTHETIC.chunkText),
      embedding: computeHash(SYNTHETIC.embeddingText),
    };

    console.log('\n[EXPECTED HASHES]');
    console.log('  File:', HASHES.file);
    console.log('  OCR:', HASHES.ocr);
    console.log('  Chunk:', HASHES.chunk);
    console.log('  Embedding:', HASHES.embedding);

    // Initialize database
    resetProvenanceTracker();
    db = DatabaseService.create('manual-test', undefined, testDir);
    const tracker = new ProvenanceTracker(db);
    const exporter = new ProvenanceExporter(db, tracker);
    const rawDb = db.getConnection();

    console.log('\n[DATABASE] Initialized successfully');

    // ═══════════════════════════════════════════════════════════════════════════
    // CREATE FULL CHAIN WITH KNOWN DATA
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  CREATING PROVENANCE CHAIN');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // 1. DOCUMENT
    const docProvId = tracker.createProvenance({
      type: ProvenanceType.DOCUMENT,
      source_type: 'FILE',
      root_document_id: '',
      content_hash: HASHES.file,
      file_hash: HASHES.file,
      source_path: testFilePath,
      processor: 'file-ingestion',
      processor_version: '1.0.0',
      processing_params: { format: 'txt' },
    });
    console.log('[CREATED] DOCUMENT provenance:', docProvId);

    // Insert document record
    const docId = crypto.randomUUID();
    rawDb.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docId, testFilePath, 'invoice.txt', HASHES.file, SYNTHETIC.fileContent.length, 'txt', 'complete', docProvId, new Date().toISOString());

    // 2. OCR_RESULT
    const ocrProvId = tracker.createProvenance({
      type: ProvenanceType.OCR_RESULT,
      source_type: 'OCR',
      source_id: docProvId,
      root_document_id: docProvId,
      content_hash: HASHES.ocr,
      input_hash: HASHES.file,
      processor: 'datalab-ocr',
      processor_version: '1.0.0',
      processing_params: { mode: 'accurate' },
    });
    console.log('[CREATED] OCR_RESULT provenance:', ocrProvId);

    const ocrId = crypto.randomUUID();
    rawDb.prepare(`
      INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id,
        datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ocrId, ocrProvId, docId, SYNTHETIC.ocrText, SYNTHETIC.ocrText.length, 'req-manual-test',
      'accurate', 1, HASHES.ocr, new Date().toISOString(), new Date().toISOString(), 150);

    // 3. CHUNK
    const chunkProvId = tracker.createProvenance({
      type: ProvenanceType.CHUNK,
      source_type: 'CHUNKING',
      source_id: ocrProvId,
      root_document_id: docProvId,
      content_hash: HASHES.chunk,
      input_hash: HASHES.ocr,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { chunk_size: 2000, overlap_percent: 10 },
      location: { chunk_index: 0, character_start: 0, character_end: SYNTHETIC.chunkText.length },
    });
    console.log('[CREATED] CHUNK provenance:', chunkProvId);

    const chunkId = crypto.randomUUID();
    rawDb.prepare(`
      INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end,
        overlap_previous, overlap_next, provenance_id, created_at, embedding_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chunkId, docId, ocrId, SYNTHETIC.chunkText, HASHES.chunk, 0, 0, SYNTHETIC.chunkText.length,
      0, 0, chunkProvId, new Date().toISOString(), 'complete');

    // 4. EMBEDDING
    const embProvId = tracker.createProvenance({
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: chunkProvId,
      root_document_id: docProvId,
      content_hash: HASHES.embedding,
      input_hash: HASHES.chunk,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { dimensions: 768, device: 'cuda:0' },
    });
    console.log('[CREATED] EMBEDDING provenance:', embProvId);

    const embId = crypto.randomUUID();
    rawDb.prepare(`
      INSERT INTO embeddings (id, chunk_id, document_id, original_text, original_text_length, source_file_path,
        source_file_name, source_file_hash, character_start, character_end, chunk_index, total_chunks,
        model_name, model_version, task_type, inference_mode, provenance_id, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(embId, chunkId, docId, SYNTHETIC.embeddingText, SYNTHETIC.embeddingText.length, testFilePath,
      'invoice.txt', HASHES.file, 0, SYNTHETIC.embeddingText.length, 0, 1,
      'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local', embProvId, HASHES.embedding, new Date().toISOString());

    // ═══════════════════════════════════════════════════════════════════════════
    // VERIFY DATABASE STATE (Source of Truth)
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  SOURCE OF TRUTH VERIFICATION');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const dbCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance').get();
    console.log('[DB STATE] Provenance records:', dbCount.cnt);

    const byType = rawDb.prepare('SELECT type, COUNT(*) as cnt FROM provenance GROUP BY type ORDER BY type').all();
    console.log('[DB STATE] By type:');
    byType.forEach(row => console.log(`  ${row.type}: ${row.cnt}`));

    if (dbCount.cnt !== 4) {
      console.error('[ERROR] Expected 4 provenance records, got:', dbCount.cnt);
      errors++;
    } else {
      console.log('[PASS] Provenance count correct: 4');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: exportJSON
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  TEST: exportJSON()');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const jsonResult = await exporter.exportJSON('document', docProvId);

    console.log('[JSON EXPORT] record_count:', jsonResult.record_count);
    console.log('[JSON EXPORT] format:', jsonResult.format);
    console.log('[JSON EXPORT] scope:', jsonResult.scope);
    console.log('[JSON EXPORT] document_id:', jsonResult.document_id);

    // Verify count matches database
    const dbDocCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM provenance WHERE root_document_id = ?').get(docProvId);
    if (jsonResult.record_count !== dbDocCount.cnt) {
      console.error('[ERROR] JSON record_count mismatch:', jsonResult.record_count, '!=', dbDocCount.cnt);
      errors++;
    } else {
      console.log('[PASS] JSON record_count matches database:', jsonResult.record_count);
    }

    // Verify all types present
    const types = jsonResult.records.map(r => r.type);
    const expectedTypes = ['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING'];
    for (const t of expectedTypes) {
      if (!types.includes(t)) {
        console.error('[ERROR] Missing type in JSON export:', t);
        errors++;
      }
    }
    console.log('[PASS] All 4 types present in JSON export');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: exportW3CPROV
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  TEST: exportW3CPROV()');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const provResult = await exporter.exportW3CPROV('document', docProvId);

    console.log('[PROV EXPORT] entity_count:', provResult.entity_count);
    console.log('[PROV EXPORT] activity_count:', provResult.activity_count);
    console.log('[PROV EXPORT] agent_count:', provResult.agent_count);

    // Verify entity count matches record count
    if (provResult.entity_count !== 4) {
      console.error('[ERROR] PROV entity_count should be 4, got:', provResult.entity_count);
      errors++;
    } else {
      console.log('[PASS] PROV entity_count correct: 4');
    }

    // Verify activity count (non-DOCUMENT = 3)
    if (provResult.activity_count !== 3) {
      console.error('[ERROR] PROV activity_count should be 3, got:', provResult.activity_count);
      errors++;
    } else {
      console.log('[PASS] PROV activity_count correct: 3 (non-DOCUMENT types)');
    }

    // Verify required W3C PROV keys
    const provDoc = provResult.prov_document;
    const requiredKeys = ['prefix', 'entity', 'activity', 'agent', 'wasDerivedFrom', 'wasGeneratedBy', 'wasAttributedTo'];
    for (const key of requiredKeys) {
      if (!(key in provDoc)) {
        console.error('[ERROR] Missing PROV-JSON key:', key);
        errors++;
      }
    }
    console.log('[PASS] All W3C PROV-JSON keys present');

    // Verify wasDerivedFrom count (3 derivations)
    const wdfCount = Object.keys(provDoc.wasDerivedFrom).length;
    if (wdfCount !== 3) {
      console.error('[ERROR] wasDerivedFrom count should be 3, got:', wdfCount);
      errors++;
    } else {
      console.log('[PASS] wasDerivedFrom count correct: 3');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: exportCSV
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  TEST: exportCSV()');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const csvResult = await exporter.exportCSV('document', docProvId);

    console.log('[CSV EXPORT] record_count:', csvResult.record_count);

    const csvLines = csvResult.csv_content.split('\n').filter(l => l.trim());
    const dataLines = csvLines.length - 1; // minus header

    console.log('[CSV EXPORT] total lines:', csvLines.length);
    console.log('[CSV EXPORT] data lines:', dataLines);

    if (dataLines !== csvResult.record_count) {
      console.error('[ERROR] CSV line count mismatch:', dataLines, '!=', csvResult.record_count);
      errors++;
    } else {
      console.log('[PASS] CSV line count matches record_count');
    }

    // Verify header contains required fields
    const headers = csvLines[0].split(',');
    const requiredHeaders = ['id', 'type', 'content_hash', 'processor', 'chain_depth'];
    for (const h of requiredHeaders) {
      if (!headers.includes(h)) {
        console.error('[ERROR] Missing CSV header:', h);
        errors++;
      }
    }
    console.log('[PASS] All required CSV headers present');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: exportToFile
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  TEST: exportToFile()');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const exportDir = join(testDir, 'exports');

    // Test JSON file export
    const jsonPath = join(exportDir, 'provenance.json');
    const jsonFileResult = await exporter.exportToFile(jsonPath, 'json', 'document', docProvId);

    console.log('[FILE EXPORT] JSON path:', jsonPath);
    console.log('[FILE EXPORT] JSON exists:', existsSync(jsonPath));
    console.log('[FILE EXPORT] JSON bytes:', jsonFileResult.bytes_written);

    if (!existsSync(jsonPath)) {
      console.error('[ERROR] JSON file not created');
      errors++;
    } else {
      const content = readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(content);
      console.log('[PASS] JSON file readable and valid');
      console.log('[VERIFY] JSON file record_count:', parsed.record_count);
    }

    // Test W3C PROV file export
    const provPath = join(exportDir, 'provenance-w3c.json');
    const provFileResult = await exporter.exportToFile(provPath, 'w3c-prov', 'document', docProvId);

    console.log('\n[FILE EXPORT] W3C PROV path:', provPath);
    console.log('[FILE EXPORT] W3C PROV exists:', existsSync(provPath));

    if (!existsSync(provPath)) {
      console.error('[ERROR] W3C PROV file not created');
      errors++;
    } else {
      const content = readFileSync(provPath, 'utf-8');
      const parsed = JSON.parse(content);
      console.log('[PASS] W3C PROV file readable and valid');
      console.log('[VERIFY] W3C PROV entity_count:', parsed.entity_count);
    }

    // Test CSV file export
    const csvPath = join(exportDir, 'provenance.csv');
    const csvFileResult = await exporter.exportToFile(csvPath, 'csv', 'document', docProvId);

    console.log('\n[FILE EXPORT] CSV path:', csvPath);
    console.log('[FILE EXPORT] CSV exists:', existsSync(csvPath));

    if (!existsSync(csvPath)) {
      console.error('[ERROR] CSV file not created');
      errors++;
    } else {
      const content = readFileSync(csvPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      console.log('[PASS] CSV file readable');
      console.log('[VERIFY] CSV file lines:', lines.length);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL SUMMARY
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  VERIFICATION SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════\n');

    if (errors === 0) {
      console.log('✓ ALL MANUAL TESTS PASSED');
      console.log('  - Database state verified');
      console.log('  - JSON export verified');
      console.log('  - W3C PROV export verified');
      console.log('  - CSV export verified');
      console.log('  - File exports verified');
    } else {
      console.log('✗ ERRORS FOUND:', errors);
    }

    return errors;

  } finally {
    // Cleanup
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}

// Run tests
runManualTests()
  .then(errors => {
    process.exit(errors > 0 ? 1 : 0);
  })
  .catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
  });
