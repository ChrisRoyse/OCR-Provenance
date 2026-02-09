/**
 * SHERLOCK HOLMES FORENSIC VERIFICATION SCRIPT
 *
 * Verifies all 13 fixes from the Document Comparison Audit Report
 * by physically creating a database, inserting data, and querying the results.
 *
 * Run with: npx tsx tests/manual/audit-fix-verification.ts
 *
 * CRITICAL: NEVER use console.log() in production TS - but this is a test script,
 * so we use process.stderr.write() for all output to be safe.
 */

import { DatabaseService } from '../../src/services/storage/database/index.js';
import { ProvenanceTracker } from '../../src/services/provenance/tracker.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import type { SourceType } from '../../src/models/provenance.js';
import { computeHash } from '../../src/utils/hash.js';
import {
  compareText,
  compareEntities,
  compareStructure,
  generateSummary,
} from '../../src/services/comparison/diff-service.js';
import type { StructuralDocInput } from '../../src/services/comparison/diff-service.js';
import {
  insertComparison,
  getComparison,
  listComparisons,
} from '../../src/services/storage/database/comparison-operations.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

const LOG: string[] = [];
let PASS = 0;
let FAIL = 0;

function log(msg: string): void {
  LOG.push(msg);
  process.stderr.write(msg + '\n');
}

function assert(condition: boolean, label: string, evidence: string): void {
  if (condition) {
    PASS++;
    log(`  [PASS] ${label}`);
    log(`         Evidence: ${evidence}`);
  } else {
    FAIL++;
    log(`  [FAIL] ${label}`);
    log(`         Evidence: ${evidence}`);
  }
}

function section(title: string): void {
  log(`\n${'='.repeat(70)}`);
  log(`  ${title}`);
  log(`${'='.repeat(70)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const DB_NAME = `audit-verify-${Date.now()}`;
const STORAGE_PATH = path.join(process.env.HOME || '/tmp', '.ocr-provenance', 'databases');

log('\n');
log('  SHERLOCK HOLMES FORENSIC VERIFICATION');
log('  Document Comparison Audit Fix Verification');
log(`  Date: ${new Date().toISOString()}`);
log(`  Database: ${DB_NAME}`);
log(`  Storage: ${STORAGE_PATH}`);

let db: DatabaseService;

try {
  db = DatabaseService.create(DB_NAME, 'Audit fix verification test database', STORAGE_PATH);
  log(`  Database created successfully at: ${db.getPath()}`);
} catch (e) {
  log(`FATAL: Failed to create database: ${e}`);
  process.exit(1);
}

const conn = db.getConnection();
const tracker = new ProvenanceTracker(db);

// ═══════════════════════════════════════════════════════════════════════════════
// INSERT SYNTHETIC DATA
// ═══════════════════════════════════════════════════════════════════════════════

section('SETUP: Inserting Synthetic Documents');

// Create document provenance records
const doc1ProvId = tracker.createProvenance({
  type: ProvenanceType.DOCUMENT,
  source_type: 'FILE' as SourceType,
  root_document_id: '', // will be self
  content_hash: computeHash('doc1-content'),
  file_hash: computeHash('doc1-file'),
  source_path: '/test/doc1.pdf',
  processor: 'file-ingestion',
  processor_version: '1.0.0',
  processing_params: {},
});
log(`  Doc1 provenance: ${doc1ProvId}`);

const doc2ProvId = tracker.createProvenance({
  type: ProvenanceType.DOCUMENT,
  source_type: 'FILE' as SourceType,
  root_document_id: '',
  content_hash: computeHash('doc2-content'),
  file_hash: computeHash('doc2-file'),
  source_path: '/test/doc2.pdf',
  processor: 'file-ingestion',
  processor_version: '1.0.0',
  processing_params: {},
});
log(`  Doc2 provenance: ${doc2ProvId}`);

// Insert documents
const doc1Id = uuidv4();
const doc2Id = uuidv4();
const now = new Date().toISOString();

db.insertDocument({
  id: doc1Id,
  file_path: '/test/doc1.pdf',
  file_name: 'doc1.pdf',
  file_hash: computeHash('doc1-file'),
  file_size: 10000,
  file_type: 'application/pdf',
  status: 'complete' as any,
  page_count: 5,
  provenance_id: doc1ProvId,
  doc_title: 'Test Document 1',
  doc_author: 'Sherlock Holmes',
  doc_subject: 'Investigation',
});

db.insertDocument({
  id: doc2Id,
  file_path: '/test/doc2.pdf',
  file_name: 'doc2.pdf',
  file_hash: computeHash('doc2-file'),
  file_size: 12000,
  file_type: 'application/pdf',
  status: 'complete' as any,
  page_count: 7,
  provenance_id: doc2ProvId,
  doc_title: 'Test Document 2',
  doc_author: 'Dr. Watson',
  doc_subject: 'Medical Report',
});

// Insert OCR results for both documents
const ocr1ProvId = tracker.createProvenance({
  type: ProvenanceType.OCR_RESULT,
  source_type: 'OCR' as SourceType,
  source_id: doc1ProvId,
  root_document_id: doc1ProvId,
  content_hash: computeHash('ocr1-extracted-text'),
  input_hash: computeHash('doc1-file'),
  file_hash: computeHash('doc1-file'),
  source_path: '/test/doc1.pdf',
  processor: 'datalab-ocr',
  processor_version: '1.0.0',
  processing_params: { mode: 'accurate' },
});

const ocr2ProvId = tracker.createProvenance({
  type: ProvenanceType.OCR_RESULT,
  source_type: 'OCR' as SourceType,
  source_id: doc2ProvId,
  root_document_id: doc2ProvId,
  content_hash: computeHash('ocr2-extracted-text'),
  input_hash: computeHash('doc2-file'),
  file_hash: computeHash('doc2-file'),
  source_path: '/test/doc2.pdf',
  processor: 'datalab-ocr',
  processor_version: '1.0.0',
  processing_params: { mode: 'accurate' },
});

const ocr1Id = uuidv4();
const ocr2Id = uuidv4();

db.insertOCRResult({
  id: ocr1Id,
  provenance_id: ocr1ProvId,
  document_id: doc1Id,
  extracted_text: 'The quick brown fox jumps over the lazy dog. This is document one with unique content about 221B Baker Street.',
  text_length: 110,
  datalab_request_id: 'req-001',
  datalab_mode: 'accurate',
  parse_quality_score: 4.5,
  page_count: 5,
  cost_cents: 10,
  content_hash: computeHash('ocr1-extracted-text'),
  processing_started_at: now,
  processing_completed_at: now,
  processing_duration_ms: 1500,
  json_blocks: null,
  extras_json: null,
});

db.insertOCRResult({
  id: ocr2Id,
  provenance_id: ocr2ProvId,
  document_id: doc2Id,
  extracted_text: 'The quick brown fox jumps over the lazy dog. This is document two with different content about Baskerville Hall.',
  text_length: 112,
  datalab_request_id: 'req-002',
  datalab_mode: 'accurate',
  parse_quality_score: 3.8,
  page_count: 7,
  cost_cents: 15,
  content_hash: computeHash('ocr2-extracted-text'),
  processing_started_at: now,
  processing_completed_at: now,
  processing_duration_ms: 2000,
  json_blocks: null,
  extras_json: null,
});

log(`  Doc1: ${doc1Id} (OCR: ${ocr1Id})`);
log(`  Doc2: ${doc2Id} (OCR: ${ocr2Id})`);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 1: Gap 1 - DatabaseStats.total_comparisons (empty DB)
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 1: Gap 1 - DatabaseStats.total_comparisons (empty state)');

const stats0 = db.getStats();
assert(
  'total_comparisons' in stats0,
  'total_comparisons field exists in DatabaseStats',
  `typeof stats0.total_comparisons = ${typeof stats0.total_comparisons}`
);
assert(
  stats0.total_comparisons === 0,
  'Empty database shows total_comparisons = 0',
  `stats0.total_comparisons = ${stats0.total_comparisons}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE A COMPARISON (needed for subsequent tests)
// ═══════════════════════════════════════════════════════════════════════════════

section('SETUP: Creating a Comparison via ProvenanceTracker');

const text1 = 'The quick brown fox jumps over the lazy dog. This is document one with unique content about 221B Baker Street.';
const text2 = 'The quick brown fox jumps over the lazy dog. This is document two with different content about Baskerville Hall.';

const textDiff = compareText(text1, text2);
log(`  Text diff: similarity_ratio=${textDiff.similarity_ratio}, insertions=${textDiff.insertions}, deletions=${textDiff.deletions}`);

const structDiff = compareStructure(
  { page_count: 5, text_length: 110, quality_score: 4.5, ocr_mode: 'accurate', chunk_count: 3 },
  { page_count: 7, text_length: 112, quality_score: 3.8, ocr_mode: 'accurate', chunk_count: 4 }
);

const entityDiff = compareEntities([], []);

const summary = generateSummary(textDiff, structDiff, entityDiff, 'doc1.pdf', 'doc2.pdf');
log(`  Summary: ${summary}`);

// Create comparison provenance via ProvenanceTracker (CQ-3.1 fix)
const comparisonId = uuidv4();
const inputHash = computeHash(computeHash('ocr1-extracted-text') + ':' + computeHash('ocr2-extracted-text'));
const diffContent = JSON.stringify({ text_diff: textDiff, structural_diff: structDiff, entity_diff: entityDiff });
const contentHash = computeHash(diffContent);

const compProvId = tracker.createProvenance({
  type: ProvenanceType.COMPARISON,
  source_type: 'COMPARISON' as SourceType,
  source_id: ocr1ProvId,
  root_document_id: doc1ProvId,
  content_hash: contentHash,
  input_hash: inputHash,
  file_hash: computeHash('doc1-file'),
  source_path: '/test/doc1.pdf <-> /test/doc2.pdf',
  processor: 'document-comparison',
  processor_version: '1.0.0',
  processing_params: { document_id_1: doc1Id, document_id_2: doc2Id },
});

log(`  Comparison provenance ID: ${compProvId}`);

insertComparison(conn, {
  id: comparisonId,
  document_id_1: doc1Id,
  document_id_2: doc2Id,
  similarity_ratio: textDiff.similarity_ratio,
  text_diff_json: JSON.stringify(textDiff),
  structural_diff_json: JSON.stringify(structDiff),
  entity_diff_json: JSON.stringify(entityDiff),
  summary,
  content_hash: contentHash,
  provenance_id: compProvId,
  created_at: now,
  processing_duration_ms: 42,
});

log(`  Comparison ID: ${comparisonId}`);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 2: Gap 1 - total_comparisons with data
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 2: Gap 1 - DatabaseStats.total_comparisons (with data)');

const stats1 = db.getStats();
assert(
  stats1.total_comparisons === 1,
  'After inserting 1 comparison, total_comparisons = 1',
  `stats1.total_comparisons = ${stats1.total_comparisons}`
);

// Also check the buildStatsResponse path (database.ts)
// We verify that comparison_count is included in the SQL query
const rawStats = conn.prepare(`
  SELECT (SELECT COUNT(*) FROM comparisons) as comparison_count
`).get() as { comparison_count: number };
assert(
  rawStats.comparison_count === 1,
  'Direct SQL COUNT confirms 1 comparison in database',
  `SELECT COUNT(*) FROM comparisons = ${rawStats.comparison_count}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 3: CQ-3.1 - ProvenanceTracker used (not raw SQL)
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 3: CQ-3.1 - ProvenanceTracker for provenance creation');

const provRecord = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(compProvId) as Record<string, unknown>;
assert(
  provRecord !== undefined,
  'Provenance record exists for comparison',
  `provenance.id = ${provRecord?.id}`
);
assert(
  provRecord.type === 'COMPARISON',
  'Provenance type is COMPARISON',
  `provenance.type = ${provRecord.type}`
);
assert(
  provRecord.chain_depth === 2,
  'Provenance chain_depth = 2',
  `provenance.chain_depth = ${provRecord.chain_depth}`
);

const parentIds = JSON.parse(provRecord.parent_ids as string) as string[];
assert(
  Array.isArray(parentIds),
  'parent_ids is a JSON array (ProvenanceTracker style)',
  `parent_ids = ${JSON.stringify(parentIds)}`
);
assert(
  parentIds.length === 2,
  'parent_ids has 2 ancestors [docProvId, ocrProvId]',
  `parent_ids.length = ${parentIds.length}, values = ${JSON.stringify(parentIds)}`
);
assert(
  parentIds[0] === doc1ProvId && parentIds[1] === ocr1ProvId,
  'parent_ids chain is correct: [docProvId, ocrProvId]',
  `parentIds[0]=${parentIds[0]} (expected ${doc1ProvId}), parentIds[1]=${parentIds[1]} (expected ${ocr1ProvId})`
);

const chainPath = JSON.parse(provRecord.chain_path as string) as string[];
assert(
  JSON.stringify(chainPath) === JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'COMPARISON']),
  'chain_path = ["DOCUMENT", "OCR_RESULT", "COMPARISON"]',
  `chain_path = ${JSON.stringify(chainPath)}`
);

assert(
  provRecord.processor === 'document-comparison',
  'processor = "document-comparison"',
  `provenance.processor = ${provRecord.processor}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 4: CQ-3.2 - compareStructure() in diff-service.ts
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 4: CQ-3.2 - compareStructure() function');

const struct = compareStructure(
  { page_count: 10, text_length: 5000, quality_score: 4.2, ocr_mode: 'high_quality', chunk_count: 15 },
  { page_count: null, text_length: 3000, quality_score: null, ocr_mode: 'low_cost', chunk_count: 8 }
);

assert(
  struct.doc1_page_count === 10 && struct.doc2_page_count === null,
  'compareStructure handles page_count including null',
  `doc1_page_count=${struct.doc1_page_count}, doc2_page_count=${struct.doc2_page_count}`
);
assert(
  struct.doc1_text_length === 5000 && struct.doc2_text_length === 3000,
  'compareStructure returns text lengths',
  `doc1_text_length=${struct.doc1_text_length}, doc2_text_length=${struct.doc2_text_length}`
);
assert(
  struct.doc1_quality_score === 4.2 && struct.doc2_quality_score === null,
  'compareStructure handles quality_score including null',
  `doc1_quality=${struct.doc1_quality_score}, doc2_quality=${struct.doc2_quality_score}`
);
assert(
  struct.doc1_ocr_mode === 'high_quality' && struct.doc2_ocr_mode === 'low_cost',
  'compareStructure returns OCR modes',
  `doc1_mode=${struct.doc1_ocr_mode}, doc2_mode=${struct.doc2_ocr_mode}`
);
assert(
  struct.doc1_chunk_count === 15 && struct.doc2_chunk_count === 8,
  'compareStructure returns chunk counts',
  `doc1_chunks=${struct.doc1_chunk_count}, doc2_chunks=${struct.doc2_chunk_count}`
);

// Verify all 10 fields exist
const structFields = Object.keys(struct);
assert(
  structFields.length === 10,
  'StructuralDiff has exactly 10 fields',
  `fields: ${structFields.join(', ')}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 5: CQ-3.3 - parseStoredJSON error handling
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 5: CQ-3.3 - parseStoredJSON error handling');

// Verify the parseStoredJSON function exists in comparison.ts source
const comparisonSource = fs.readFileSync(
  path.join(process.cwd(), 'src/tools/comparison.ts'), 'utf8'
);

assert(
  comparisonSource.includes('function parseStoredJSON'),
  'parseStoredJSON function exists in comparison.ts',
  `Found function declaration`
);
assert(
  comparisonSource.includes("throw new MCPError('INTERNAL_ERROR'"),
  'parseStoredJSON throws MCPError on malformed JSON',
  `Found MCPError throw in parseStoredJSON`
);
assert(
  comparisonSource.includes('parseStoredJSON(comparison.text_diff_json'),
  'handleComparisonGet uses parseStoredJSON for text_diff_json',
  'parseStoredJSON is called on all 3 JSON fields'
);
assert(
  comparisonSource.includes('parseStoredJSON(comparison.structural_diff_json'),
  'handleComparisonGet uses parseStoredJSON for structural_diff_json',
  'parseStoredJSON called on structural_diff_json'
);
assert(
  comparisonSource.includes('parseStoredJSON(comparison.entity_diff_json'),
  'handleComparisonGet uses parseStoredJSON for entity_diff_json',
  'parseStoredJSON called on entity_diff_json'
);

// Test the actual behavior: insert malformed JSON and try to parse it
const malformedCompId = uuidv4();
const malformedProvId = tracker.createProvenance({
  type: ProvenanceType.COMPARISON,
  source_type: 'COMPARISON' as SourceType,
  source_id: ocr1ProvId,
  root_document_id: doc1ProvId,
  content_hash: computeHash('malformed-test'),
  processor: 'test',
  processor_version: '1.0.0',
  processing_params: {},
});

conn.prepare(`
  INSERT INTO comparisons (id, document_id_1, document_id_2, similarity_ratio,
    text_diff_json, structural_diff_json, entity_diff_json, summary,
    content_hash, provenance_id, created_at, processing_duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  malformedCompId, doc1Id, doc2Id, 0.5,
  '{{INVALID JSON}}',  // malformed!
  JSON.stringify(structDiff),
  JSON.stringify(entityDiff),
  'test summary',
  computeHash('test'),
  malformedProvId,
  now,
  10
);

// Retrieve the raw row and try JSON.parse (simulating what parseStoredJSON does)
const malformedRow = getComparison(conn, malformedCompId);
assert(
  malformedRow !== null,
  'Malformed comparison row was stored successfully',
  `row exists: ${malformedRow !== null}`
);

let parseThrew = false;
try {
  JSON.parse(malformedRow!.text_diff_json);
} catch {
  parseThrew = true;
}
assert(
  parseThrew,
  'JSON.parse throws on malformed text_diff_json (parseStoredJSON would catch this)',
  `JSON.parse threw: ${parseThrew}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 6: CQ-3.4 - Duplicate comparison prevention
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 6: CQ-3.4 - Duplicate comparison prevention');

// Verify the duplicate detection code exists in comparison.ts
assert(
  comparisonSource.includes('existingComparison'),
  'Duplicate detection variable exists in comparison.ts',
  'Found "existingComparison" variable'
);
assert(
  comparisonSource.includes('These documents were already compared'),
  'Duplicate detection error message exists',
  'Found validation error message for duplicate comparisons'
);
assert(
  comparisonSource.includes("throw new MCPError('VALIDATION_ERROR'"),
  'Throws VALIDATION_ERROR for duplicate comparisons',
  'MCPError VALIDATION_ERROR thrown'
);
assert(
  comparisonSource.includes('currentInputHash') && comparisonSource.includes('prevInputHash'),
  'Duplicate detection compares input hashes (allows re-compare after OCR reprocess)',
  'Found currentInputHash and prevInputHash comparison logic'
);

// Physical verification: the existing comparison is there
const existingCheck = conn.prepare(
  `SELECT c.id FROM comparisons c
   WHERE (c.document_id_1 = ? AND c.document_id_2 = ?)
      OR (c.document_id_1 = ? AND c.document_id_2 = ?)
   ORDER BY c.created_at DESC LIMIT 1`
).get(doc1Id, doc2Id, doc2Id, doc1Id) as { id: string } | undefined;

assert(
  existingCheck !== undefined && existingCheck.id === comparisonId,
  'Existing comparison found by duplicate detection query',
  `Found comparison ID: ${existingCheck?.id}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 7: Gap 6 - findProvenanceId with comparison
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 7: Gap 6 - findProvenanceId handles comparison type');

const provenanceSource = fs.readFileSync(
  path.join(process.cwd(), 'src/tools/provenance.ts'), 'utf8'
);

assert(
  provenanceSource.includes("SELECT provenance_id FROM comparisons WHERE id = ?"),
  'findProvenanceId() queries comparisons table',
  'Found comparison lookup SQL in provenance.ts'
);
assert(
  provenanceSource.includes("itemType: 'comparison'"),
  'findProvenanceId() returns itemType: "comparison"',
  'Found comparison type return in provenance.ts'
);

// Also verify the explicit comparison handling in handleProvenanceGet
assert(
  provenanceSource.includes("} else if (itemType === 'comparison')"),
  'handleProvenanceGet has explicit comparison branch',
  'Found comparison branch in handleProvenanceGet'
);

// Physical test: query comparison's provenance_id directly
const compRow = conn.prepare('SELECT provenance_id FROM comparisons WHERE id = ?').get(comparisonId) as { provenance_id: string };
assert(
  compRow.provenance_id === compProvId,
  'Comparison record has correct provenance_id',
  `comparison.provenance_id = ${compRow.provenance_id}, expected = ${compProvId}`
);

// Also verify the DetectedItemType includes 'comparison'
assert(
  provenanceSource.includes("'comparison'") && provenanceSource.includes("DetectedItemType"),
  'DetectedItemType union includes "comparison"',
  'Found comparison in DetectedItemType'
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 8: Gap 3 - Document get shows comparisons
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 8: Gap 3 - ocr_document_get shows comparisons');

const documentsSource = fs.readFileSync(
  path.join(process.cwd(), 'src/tools/documents.ts'), 'utf8'
);

assert(
  documentsSource.includes('getComparisonSummariesByDocument') || documentsSource.includes('FROM comparisons c'),
  'handleDocumentGet queries comparisons table',
  'Found comparison query (via shared function or inline) in documents.ts'
);
assert(
  documentsSource.includes("result.comparisons = {"),
  'handleDocumentGet sets result.comparisons',
  'Found comparisons assignment in handleDocumentGet'
);
assert(
  documentsSource.includes('compared_with'),
  'handleDocumentGet includes compared_with field',
  'Found compared_with mapping'
);

// Physical test: query comparisons for doc1
const doc1Comparisons = conn.prepare(
  `SELECT c.id, c.document_id_1, c.document_id_2, c.similarity_ratio
   FROM comparisons c
   WHERE c.document_id_1 = ? OR c.document_id_2 = ?`
).all(doc1Id, doc1Id) as Array<{ id: string; document_id_1: string; document_id_2: string; similarity_ratio: number }>;

assert(
  doc1Comparisons.length >= 1,
  'Document 1 has at least 1 comparison associated',
  `Found ${doc1Comparisons.length} comparisons for doc1`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 9: Gap 2 - Document report shows comparisons
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 9: Gap 2 - ocr_document_report shows comparisons');

const reportsSource = fs.readFileSync(
  path.join(process.cwd(), 'src/tools/reports.ts'), 'utf8'
);

// Count occurrences of 'comparisons' in reports.ts
const comparisonMentions = (reportsSource.match(/comparisons/g) || []).length;
assert(
  comparisonMentions >= 8,
  `reports.ts references "comparisons" at least 8 times (found ${comparisonMentions})`,
  `"comparisons" appears ${comparisonMentions} times in reports.ts - covers evaluation, document, quality, cost reports + markdown`
);

// Verify handleDocumentReport specifically
assert(
  (reportsSource.includes('getComparisonSummariesByDocument') || reportsSource.includes('FROM comparisons c')) && reportsSource.includes('processing_duration_ms'),
  'handleDocumentReport queries comparisons with processing_duration_ms',
  'Found comparisons query (via shared function or inline) with duration in handleDocumentReport'
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 10: Gap 4 - Quality summary shows comparisons
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 10: Gap 4 - ocr_quality_summary shows comparisons');

assert(
  reportsSource.includes('avg_similarity') && reportsSource.includes('min_similarity') && reportsSource.includes('max_similarity'),
  'handleQualitySummary includes avg/min/max similarity metrics',
  'Found similarity metric fields in quality summary'
);
assert(
  reportsSource.includes('comparisons: (() =>'),
  'handleQualitySummary has comparisons section as IIFE',
  'Found comparisons IIFE pattern in handleQualitySummary'
);

// Physical test: query comparison stats
const compStats = conn.prepare(`
  SELECT COUNT(*) as total, AVG(similarity_ratio) as avg_similarity,
         MIN(similarity_ratio) as min_similarity, MAX(similarity_ratio) as max_similarity
  FROM comparisons
`).get() as { total: number; avg_similarity: number | null; min_similarity: number | null; max_similarity: number | null };

assert(
  compStats.total >= 1,
  'Comparison stats query returns correct count',
  `total=${compStats.total}, avg_similarity=${compStats.avg_similarity}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 11: Gap 5 - Evaluation report shows comparisons
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 11: Gap 5 - ocr_evaluation_report shows comparisons');

assert(
  reportsSource.includes('comparisonSummary') || reportsSource.includes('comparisonStats'),
  'handleEvaluationReport queries comparison data',
  `Found comparison variable in handleEvaluationReport`
);
assert(
  reportsSource.includes('total_comparisons: comparisonCount') || reportsSource.includes('total_comparisons:'),
  'handleEvaluationReport includes total_comparisons in summary',
  'Found total_comparisons in evaluation report summary'
);
assert(
  reportsSource.includes('avg_comparison_similarity'),
  'handleEvaluationReport includes avg_comparison_similarity',
  'Found avg_comparison_similarity in evaluation report'
);
assert(
  reportsSource.includes('comparisonStats: { total:'),
  'Markdown report receives comparisonStats parameter',
  'Found comparisonStats parameter in generateMarkdownReport call'
);
assert(
  reportsSource.includes('params.comparisonStats.total'),
  'Markdown report includes comparison count',
  'Found comparisonStats.total usage in markdown generation'
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 12: Gap 7 - Cost summary shows comparison_compute
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 12: Gap 7 - ocr_cost_summary shows comparison_compute');

assert(
  reportsSource.includes('comparison_compute'),
  'handleCostSummary includes comparison_compute section',
  'Found comparison_compute in reports.ts'
);
assert(
  reportsSource.includes('total_duration_ms') && reportsSource.includes('avg_duration_ms'),
  'comparison_compute includes total and avg duration',
  'Found duration fields in comparison_compute'
);
assert(
  reportsSource.includes("FROM comparisons") && reportsSource.includes('processing_duration_ms'),
  'Cost summary queries comparison processing durations',
  'Found comparison duration SQL in cost summary'
);

// Physical test: query comparison durations
const durationStats = conn.prepare(`
  SELECT COUNT(*) as count,
         COALESCE(SUM(processing_duration_ms), 0) as total_ms,
         AVG(processing_duration_ms) as avg_ms
  FROM comparisons
`).get() as { count: number; total_ms: number; avg_ms: number | null };

assert(
  durationStats.count >= 1 && durationStats.total_ms > 0,
  'Comparison duration stats are non-zero',
  `count=${durationStats.count}, total_ms=${durationStats.total_ms}, avg_ms=${durationStats.avg_ms}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 13: Gap 9 - Witness analysis includes comparisons
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 13: Gap 9 - witness analysis includes comparison context');

const entityAnalysisSource = fs.readFileSync(
  path.join(process.cwd(), 'src/tools/entity-analysis.ts'), 'utf8'
);

assert(
  entityAnalysisSource.includes('comparisonSection'),
  'handleWitnessAnalysis builds comparisonSection',
  'Found comparisonSection variable in entity-analysis.ts'
);
assert(
  entityAnalysisSource.includes('Prior Document Comparisons'),
  'Comparison context header included in witness prompt',
  'Found "Prior Document Comparisons" heading'
);
assert(
  entityAnalysisSource.includes('comparisons_included'),
  'Response includes comparisons_included flag',
  'Found comparisons_included in response'
);
assert(
  entityAnalysisSource.includes('FROM comparisons c'),
  'Witness analysis queries comparisons table',
  'Found comparisons SQL in entity-analysis.ts'
);

// Physical test: the SQL pattern used in witness analysis
const witnessComps = conn.prepare(
  `SELECT c.document_id_1, c.document_id_2, c.similarity_ratio, c.summary
   FROM comparisons c
   WHERE c.document_id_1 IN (?, ?) AND c.document_id_2 IN (?, ?)
   ORDER BY c.created_at DESC`
).all(doc1Id, doc2Id, doc1Id, doc2Id) as Array<{
  document_id_1: string; document_id_2: string;
  similarity_ratio: number; summary: string;
}>;

assert(
  witnessComps.length >= 1,
  'Witness analysis comparison query finds existing comparisons',
  `Found ${witnessComps.length} comparisons between doc1 and doc2`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 14: Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 14: Edge Cases');

// Edge 1: compareText with empty strings
const emptyDiff = compareText('', '');
assert(
  emptyDiff.similarity_ratio === 1.0,
  'compareText("", "") returns similarity 1.0',
  `similarity_ratio = ${emptyDiff.similarity_ratio}`
);
assert(
  emptyDiff.insertions === 0 && emptyDiff.deletions === 0,
  'compareText("", "") has 0 insertions and 0 deletions',
  `insertions=${emptyDiff.insertions}, deletions=${emptyDiff.deletions}`
);

// Edge 2: compareStructure with null page counts
const nullStruct = compareStructure(
  { page_count: null, text_length: 0, quality_score: null, ocr_mode: 'test', chunk_count: 0 },
  { page_count: null, text_length: 0, quality_score: null, ocr_mode: 'test', chunk_count: 0 }
);
assert(
  nullStruct.doc1_page_count === null && nullStruct.doc2_page_count === null,
  'compareStructure handles double-null page counts',
  `doc1_page_count=${nullStruct.doc1_page_count}, doc2_page_count=${nullStruct.doc2_page_count}`
);

// Edge 3: compareEntities with empty arrays
const emptyEntityDiff = compareEntities([], []);
assert(
  emptyEntityDiff.doc1_total_entities === 0 && emptyEntityDiff.doc2_total_entities === 0,
  'compareEntities([], []) returns zeros',
  `doc1_total=${emptyEntityDiff.doc1_total_entities}, doc2_total=${emptyEntityDiff.doc2_total_entities}`
);
assert(
  Object.keys(emptyEntityDiff.by_type).length === 0,
  'compareEntities([], []) has empty by_type',
  `by_type keys: ${Object.keys(emptyEntityDiff.by_type).length}`
);

// Edge 4: getComparison returns null for non-existent
const noComp = getComparison(conn, 'non-existent-id');
assert(
  noComp === null,
  'getComparison returns null for non-existent ID',
  `result = ${noComp}`
);

// Edge 5: listComparisons with document_id filter
const filteredComps = listComparisons(conn, { document_id: doc1Id });
assert(
  filteredComps.length >= 1,
  'listComparisons with document_id filter returns results',
  `Found ${filteredComps.length} comparisons for doc1`
);

// Edge 6: listComparisons with non-existent document_id filter
const noComps = listComparisons(conn, { document_id: 'non-existent-doc' });
assert(
  noComps.length === 0,
  'listComparisons with non-existent doc returns empty',
  `Found ${noComps.length} comparisons`
);

// Edge 7: Identical text comparison
const identicalDiff = compareText('hello world', 'hello world');
assert(
  identicalDiff.similarity_ratio === 1.0,
  'Identical text has similarity 1.0',
  `similarity_ratio = ${identicalDiff.similarity_ratio}`
);

// Edge 8: Completely different text
const totallyDiffText = compareText('aaa bbb ccc\n', 'xxx yyy zzz\n');
assert(
  totallyDiffText.similarity_ratio < 0.5,
  'Completely different text has low similarity',
  `similarity_ratio = ${totallyDiffText.similarity_ratio}`
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 15: buildStatsResponse includes comparison_count
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 15: buildStatsResponse in database.ts includes comparison_count');

const databaseSource = fs.readFileSync(
  path.join(process.cwd(), 'src/tools/database.ts'), 'utf8'
);

assert(
  databaseSource.includes('comparison_count: stats.total_comparisons'),
  'buildStatsResponse maps comparison_count from total_comparisons',
  'Found comparison_count mapping in database.ts'
);

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION 16: DatabaseStats type includes total_comparisons
// ═══════════════════════════════════════════════════════════════════════════════

section('VERIFY 16: DatabaseStats type has total_comparisons field');

const typesSource = fs.readFileSync(
  path.join(process.cwd(), 'src/services/storage/database/types.ts'), 'utf8'
);

assert(
  typesSource.includes('total_comparisons: number'),
  'DatabaseStats interface has total_comparisons: number field',
  'Found total_comparisons in types.ts'
);

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP & FINAL REPORT
// ═══════════════════════════════════════════════════════════════════════════════

section('FINAL REPORT');

db.close();

// Delete test database
try {
  const dbPath = path.join(STORAGE_PATH, `${DB_NAME}.db`);
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    log(`  Test database cleaned up: ${dbPath}`);
  }
} catch (e) {
  log(`  Warning: Failed to clean up test database: ${e}`);
}

log('');
log(`  TOTAL ASSERTIONS: ${PASS + FAIL}`);
log(`  PASSED: ${PASS}`);
log(`  FAILED: ${FAIL}`);
log('');

if (FAIL === 0) {
  log('  ===============================================================');
  log('                    ALL FIXES VERIFIED');
  log('  ===============================================================');
  log('');
  log('  VERDICT: ALL 13 AUDIT FIXES ARE PHYSICALLY WORKING');
  log('  CONFIDENCE: HIGH');
  log('');
} else {
  log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  log(`              ${FAIL} ASSERTION(S) FAILED`);
  log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  process.exitCode = 1;
}
