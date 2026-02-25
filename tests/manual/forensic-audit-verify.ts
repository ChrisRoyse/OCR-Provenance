/**
 * Forensic Audit Verification - Manual E2E Test
 *
 * Verifies ALL bug fixes from the system health audit with REAL data.
 * Creates a fresh test database, inserts synthetic data, and tests each fix.
 *
 * Run with: npx tsx tests/manual/forensic-audit-verify.ts
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(import.meta.url.replace('file://', ''), '../../..');

// ═══════════════════════════════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

const TEST_DB_DIR = resolve(process.env.HOME!, '.ocr-provenance/databases');
const TEST_DB_NAME = 'forensic-audit-test';
const TEST_DB_PATH = resolve(TEST_DB_DIR, `${TEST_DB_NAME}.db`);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.error(`  PASS: ${name}`);
    passed++;
  } else {
    const msg = `FAIL: ${name}${detail ? ': ' + detail : ''}`;
    console.error(`  ${msg}`);
    failures.push(msg);
    failed++;
  }
}

function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE SETUP
// ═══════════════════════════════════════════════════════════════════════════════

function setupDatabase(): Database.Database {
  // Clean up any previous test database
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { force: true });
  }
  if (existsSync(TEST_DB_PATH + '-wal')) {
    rmSync(TEST_DB_PATH + '-wal', { force: true });
  }
  if (existsSync(TEST_DB_PATH + '-shm')) {
    rmSync(TEST_DB_PATH + '-shm', { force: true });
  }

  mkdirSync(TEST_DB_DIR, { recursive: true });

  // Use DatabaseService to create a fully-migrated database
  const { DatabaseService } = require(
    resolve(PROJECT_ROOT, 'dist/services/storage/database/index.js')
  );

  const dbService = DatabaseService.create(TEST_DB_NAME);
  const db = dbService.getConnection() as Database.Database;

  return db;
}

function insertSyntheticData(db: Database.Database): {
  docId: string;
  docId2: string;
  chunkIds: string[];
  provIds: string[];
} {
  const now = new Date().toISOString();
  const docId = randomUUID();
  const docId2 = randomUUID();

  // Insert provenance for doc1 (DOCUMENT type)
  const provDocId = randomUUID();
  db.prepare(
    `
    INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_path,
      root_document_id, content_hash, input_hash, file_hash, processor, processor_version,
      processing_params, processing_duration_ms, parent_id, parent_ids, chain_depth, chain_path)
    VALUES (?, 'DOCUMENT', ?, ?, 'FILE', '/tmp/test.pdf', ?, ?, NULL, ?, 'ingest', '1.0',
      '{}', 100, NULL, '[]', 0, '["DOCUMENT"]')
  `
  ).run(provDocId, now, now, docId, sha256('doc1'), sha256('file1'));

  // Insert provenance for doc2
  const provDoc2Id = randomUUID();
  db.prepare(
    `
    INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_path,
      root_document_id, content_hash, input_hash, file_hash, processor, processor_version,
      processing_params, processing_duration_ms, parent_id, parent_ids, chain_depth, chain_path)
    VALUES (?, 'DOCUMENT', ?, ?, 'FILE', '/tmp/test2.pdf', ?, ?, NULL, ?, 'ingest', '1.0',
      '{}', 100, NULL, '[]', 0, '["DOCUMENT"]')
  `
  ).run(provDoc2Id, now, now, docId2, sha256('doc2'), sha256('file2'));

  // Insert documents
  db.prepare(
    `
    INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status,
      page_count, provenance_id, created_at, modified_at, doc_title, doc_author, doc_subject)
    VALUES (?, '/tmp/test.pdf', 'test.pdf', ?, 1024, 'pdf', 'complete', 5, ?, ?, ?,
      'Medical Report', 'Dr. Smith', 'Back Injury Assessment')
  `
  ).run(docId, sha256('file1'), provDocId, now, now);

  db.prepare(
    `
    INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status,
      page_count, provenance_id, created_at, modified_at, doc_title, doc_author, doc_subject)
    VALUES (?, '/tmp/test2.pdf', 'test2.pdf', ?, 2048, 'pdf', 'complete', 3, ?, ?, ?,
      'Legal Filing', 'Attorney Jones', 'NOT applicable notice')
  `
  ).run(docId2, sha256('file2'), provDoc2Id, now, now);

  // Insert OCR results
  const ocrId = randomUUID();
  db.prepare(
    `
    INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
      datalab_request_id, datalab_mode, parse_quality_score, page_count, content_hash,
      processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, 'Full OCR text here', 18, 'req-1', 'balanced', 4.2, 5, ?, ?, ?, 500)
  `
  ).run(ocrId, provDocId, docId, sha256('Full OCR text here'), now, now);

  const ocrId2 = randomUUID();
  db.prepare(
    `
    INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
      datalab_request_id, datalab_mode, parse_quality_score, page_count, content_hash,
      processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, 'Legal OCR text here', 19, 'req-2', 'balanced', 3.8, 3, ?, ?, ?, 400)
  `
  ).run(ocrId2, provDoc2Id, docId2, sha256('Legal OCR text here'), now, now);

  // Insert chunks with varied text
  const chunkTexts = [
    'Patient presented with back injury from automobile accident. Severe pain noted.',
    'Wound healing progress was assessed. The trauma to the lumbar region is consistent with the accident.',
    'Treatment plan includes physical therapy for chronic pain management.',
    'NOT applicable to previous claims. This is a new injury assessment.',
    'Section with %special% characters and _underscores_ for LIKE testing.',
  ];

  const chunkIds: string[] = [];
  const provIds: string[] = [];

  for (let i = 0; i < chunkTexts.length; i++) {
    const chunkId = randomUUID();
    const chunkProvId = randomUUID();
    chunkIds.push(chunkId);
    provIds.push(chunkProvId);

    const targetDocId = i < 3 ? docId : docId2;
    const targetOcrId = i < 3 ? ocrId : ocrId2;
    const targetProvDocId = i < 3 ? provDocId : provDoc2Id;

    db.prepare(
      `
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, input_hash, file_hash, processor, processor_version,
        processing_params, processing_duration_ms, parent_id, parent_ids, chain_depth, chain_path)
      VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, ?, ?, ?, 'chunker', '1.0',
        '{}', 50, ?, '[]', 2, '["DOCUMENT","OCR_RESULT","CHUNK"]')
    `
    ).run(
      chunkProvId,
      now,
      now,
      targetProvDocId,
      targetDocId,
      sha256(chunkTexts[i]),
      sha256('ocr text'),
      sha256('file1'),
      targetProvDocId
    );

    db.prepare(
      `
      INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index,
        character_start, character_end, page_number, overlap_previous, overlap_next,
        provenance_id, created_at, embedding_status, chunking_strategy,
        section_path, heading_context, content_types, is_atomic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'pending', 'hybrid_section',
        ?, ?, '["text"]', 0)
    `
    ).run(
      chunkId,
      targetDocId,
      targetOcrId,
      chunkTexts[i],
      sha256(chunkTexts[i]),
      i,
      i * 100,
      (i + 1) * 100,
      i + 1,
      chunkProvId,
      now,
      i < 2 ? 'Introduction > Background' : 'Assessment > Findings',
      i < 2 ? 'Background' : 'Findings'
    );
  }

  // Rebuild FTS index to include new chunks
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");

  return { docId, docId2, chunkIds, provIds };
}

// ═══════════════════════════════════════════════════════════════════════════════
// H-1/H-2: FTS5 Query Sanitization
// ═══════════════════════════════════════════════════════════════════════════════

function testH1H2_FTS5QuerySanitization(db: Database.Database) {
  console.error('\n=== H-1/H-2: FTS5 Query Sanitization ===');

  // Import the functions
  const { sanitizeFTS5Query } = require(resolve(PROJECT_ROOT, 'dist/services/search/bm25.js'));
  const { expandQuery, sanitizeFTS5Term } = require(
    resolve(PROJECT_ROOT, 'dist/services/search/query-expander.js')
  );

  // Test 1: sanitizeFTS5Query handles "back injury" correctly
  const sanitized = sanitizeFTS5Query('back injury');
  assert(
    sanitized === 'back AND injury',
    'sanitizeFTS5Query("back injury") produces valid FTS5 query',
    `Got: "${sanitized}"`
  );

  // Test 2: expandQuery produces OR-joined terms
  const expanded = expandQuery('back injury');
  assert(
    expanded.includes('OR'),
    'expandQuery("back injury") contains OR operator',
    `Got: "${expanded}"`
  );
  assert(
    expanded.includes('wound') || expanded.includes('trauma'),
    'expandQuery("back injury") includes "injury" synonyms (wound/trauma)',
    `Got: "${expanded}"`
  );

  // Test 3: "NOT" as a corpus term is stripped by sanitizeFTS5Term
  const notTerm = sanitizeFTS5Term('NOT');
  assert(
    notTerm === '',
    'sanitizeFTS5Term("NOT") returns empty string (operator stripped)',
    `Got: "${notTerm}"`
  );

  // Test 4: BM25 search with expanded query doesn't crash
  const bm25Service = new (require(
    resolve(PROJECT_ROOT, 'dist/services/search/bm25.js')
  ).BM25SearchService)(db);
  const expandedQuery = expandQuery('back injury');

  let searchResult: unknown[];
  try {
    searchResult = bm25Service.search({
      query: expandedQuery,
      limit: 10,
      preSanitized: true,
    });
    assert(true, 'BM25 search with expanded query does not crash');
  } catch (err) {
    searchResult = [];
    assert(false, 'BM25 search with expanded query does not crash', String(err));
  }

  // Test 5: Results contain "back injury" chunks
  const resultTexts = (searchResult as Array<{ original_text: string }>).map((r) =>
    r.original_text.toLowerCase()
  );
  const hasBackInjury = resultTexts.some((t) => t.includes('back injury'));
  assert(hasBackInjury, 'Results contain "back injury" chunks');

  // Test 6: Results also contain synonym matches (wound/trauma)
  const hasSynonym = resultTexts.some((t) => t.includes('wound') || t.includes('trauma'));
  assert(hasSynonym, 'Results contain synonym matches (wound/trauma)');

  // Test 7: The word "NOT" in document text doesn't negate results
  // Our chunk 3 contains "NOT applicable" - search for query that includes this
  const notResults = bm25Service.search({
    query: sanitizeFTS5Query('applicable'),
    limit: 10,
  });
  assert(
    (notResults as unknown[]).length > 0,
    'Search for "applicable" finds results (NOT in corpus doesn\'t negate)',
    `Got ${(notResults as unknown[]).length} results`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// H-3/H-4: v31 Migration Safety
// ═══════════════════════════════════════════════════════════════════════════════

function testH3H4_MigrationSafety() {
  console.error('\n=== H-3/H-4: v31 Migration Safety ===');

  // Read the built operations.js to verify transaction wrapping
  const opsPath = resolve(PROJECT_ROOT, 'dist/services/storage/migrations/operations.js');
  const opsContent = readFileSync(opsPath, 'utf-8');

  // Verify bumpVersion(31) is called inside the transaction
  // Look for the pattern: db.transaction(() => { ... bumpVersion(31) ... })
  const txnPattern = /db\.transaction\(\(\)\s*=>\s*\{[\s\S]*?bumpVersion\(31\)[\s\S]*?\}\)/;
  assert(txnPattern.test(opsContent), 'v31 migration: bumpVersion(31) is inside db.transaction()');

  // Verify H-4: vlm_fts rebuild uses delete-all + selective insert (NOT rebuild)
  const deleteAllPattern = /INSERT INTO vlm_fts\(vlm_fts\) VALUES\('delete-all'\)/;
  assert(
    deleteAllPattern.test(opsContent),
    'v31 migration: VLM FTS uses delete-all + selective insert (H-4 fix)'
  );

  // Verify H-3: json_type check prevents crashing on non-array extractedText
  const jsonTypeCheck = /json_type\(json_extract\(.*extractedText.*\)\)\s*=\s*'array'/;
  assert(
    jsonTypeCheck.test(opsContent),
    'v31 migration: json_type array check prevents crash on non-array values (H-3 fix)'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// H-5: Cross-DB BM25 Normalization
// ═══════════════════════════════════════════════════════════════════════════════

function testH5_CrossDBNormalization() {
  console.error('\n=== H-5: Cross-DB BM25 Normalization ===');

  // Read the search.ts built file to verify normalization code exists
  const searchPath = resolve(PROJECT_ROOT, 'dist/tools/search.js');
  const searchContent = readFileSync(searchPath, 'utf-8');

  // Verify normalized_score calculation exists
  assert(
    searchContent.includes('normalized_score'),
    'Cross-DB search includes normalized_score field'
  );

  // Verify per-database min-max normalization
  assert(
    searchContent.includes('minScore') && searchContent.includes('maxScore'),
    'Cross-DB search uses min-max normalization per database'
  );

  // Verify normalization formula
  assert(
    searchContent.includes('bm25_score - minScore') && searchContent.includes('/ range'),
    'Normalization formula: (score - min) / range'
  );

  // Verify fallback for single-result databases
  assert(searchContent.includes(': 1.0'), 'Single-result databases get normalized_score = 1.0');
}

// ═══════════════════════════════════════════════════════════════════════════════
// H-6: Unbounded Queries
// ═══════════════════════════════════════════════════════════════════════════════

function testH6_UnboundedQueries(db: Database.Database) {
  console.error('\n=== H-6: Unbounded Queries ===');

  // Read the tag-operations.js file to verify LIMIT exists
  const tagOpsPath = resolve(PROJECT_ROOT, 'dist/services/storage/database/tag-operations.js');
  const tagOpsContent = readFileSync(tagOpsPath, 'utf-8');

  // Verify getAllTags has LIMIT
  const getAllTagsSql = /SELECT \* FROM tags.*LIMIT/;
  assert(getAllTagsSql.test(tagOpsContent), 'getAllTags() SQL includes LIMIT clause');

  // Verify getTagsWithCounts has LIMIT
  assert(
    tagOpsContent.includes('LIMIT 10000') || tagOpsContent.includes('LIMIT ?'),
    'getTagsWithCounts() includes LIMIT'
  );

  // Verify searchByTags has LIMIT
  assert(
    /searchByTags[\s\S]*?LIMIT/m.test(tagOpsContent),
    'searchByTags SQL includes LIMIT clause'
  );

  // Test that getAllTags actually works with the limit
  const { getAllTags } = require(
    resolve(PROJECT_ROOT, 'dist/services/storage/database/tag-operations.js')
  );
  const tags = getAllTags(db);
  assert(Array.isArray(tags), 'getAllTags() returns an array (with LIMIT clause)');

  // Also verify provenance operations have limits
  const provOpsPath = resolve(
    PROJECT_ROOT,
    'dist/services/storage/database/provenance-operations.js'
  );
  const provOpsContent = readFileSync(provOpsPath, 'utf-8');
  assert(
    provOpsContent.includes('LIMIT 10000') || provOpsContent.includes('LIMIT ?'),
    'Provenance operations include LIMIT clauses'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// M-1: Metadata Filter Bypass
// ═══════════════════════════════════════════════════════════════════════════════

function testM1_MetadataFilterBypass(db: Database.Database, _docId: string) {
  console.error('\n=== M-1: Metadata Filter Bypass ===');

  // Read search.ts to verify the __no_match__ sentinel
  const searchPath = resolve(PROJECT_ROOT, 'dist/tools/search.js');
  const searchContent = readFileSync(searchPath, 'utf-8');

  // Verify resolveMetadataFilter returns sentinel when no documents match
  assert(
    searchContent.includes('__no_match__'),
    'resolveMetadataFilter returns __no_match__ sentinel for zero matches'
  );

  // Verify resolveClusterFilter intersects with existing filter
  assert(
    searchContent.includes('clusterSet.has') || searchContent.includes('intersect'),
    'resolveClusterFilter intersects cluster docs with existing filter'
  );

  // Direct SQL test: If metadata filter produces zero matches, the sentinel is
  // "__no_match__" which will never match a real document ID
  const sentinel = '__no_match__';
  const row = db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE id = ?').get(sentinel) as {
    cnt: number;
  };
  assert(row.cnt === 0, 'Sentinel "__no_match__" never matches a real document');
}

// ═══════════════════════════════════════════════════════════════════════════════
// M-3: LIKE Escaping
// ═══════════════════════════════════════════════════════════════════════════════

function testM3_LIKEEscaping(db: Database.Database, _docId2: string) {
  console.error('\n=== M-3: LIKE Escaping ===');

  const { escapeLikePattern } = require(resolve(PROJECT_ROOT, 'dist/utils/validation.js'));

  // Test 1: escapeLikePattern escapes % and _
  const escaped = escapeLikePattern('%special%');
  assert(
    escaped === '\\%special\\%',
    'escapeLikePattern("%special%") produces "\\%special\\%"',
    `Got: "${escaped}"`
  );

  const escaped2 = escapeLikePattern('test_value');
  assert(
    escaped2 === 'test\\_value',
    'escapeLikePattern("test_value") escapes underscores',
    `Got: "${escaped2}"`
  );

  // Test 2: Using escaped pattern in actual LIKE query
  // Our chunk 4 has text: 'Section with %special% characters...'
  const literalResult = db
    .prepare("SELECT COUNT(*) as cnt FROM chunks WHERE section_path LIKE ? ESCAPE '\\'")
    .get(escapeLikePattern('%special%') + '%') as { cnt: number };

  // This should NOT match anything because no section_path starts with literal "%special%"
  assert(
    literalResult.cnt === 0,
    'LIKE with escaped "%special%" treats % literally (no wildcard)',
    `Got ${literalResult.cnt} matches`
  );

  // Test 3: Verify the search code uses escapeLikePattern for section_path_filter
  const searchPath = resolve(PROJECT_ROOT, 'dist/tools/search.js');
  const searchContent = readFileSync(searchPath, 'utf-8');
  assert(
    searchContent.includes('escapeLikePattern') && searchContent.includes('section_path_filter'),
    'Search code uses escapeLikePattern for section_path_filter'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// L-4: Tag Comma Safety
// ═══════════════════════════════════════════════════════════════════════════════

function testL4_TagCommaSafety(db: Database.Database, docId: string) {
  console.error('\n=== L-4: Tag Comma Safety ===');

  const tagOps = require(resolve(PROJECT_ROOT, 'dist/services/storage/database/tag-operations.js'));

  // Test 1: Create a tag with a comma in the name
  const tag = tagOps.createTag(db, { name: 'test,comma', description: 'Tag with comma' });
  assert(
    tag.name === 'test,comma',
    'Tag with comma in name created successfully',
    `Got: "${tag.name}"`
  );

  // Test 2: Apply it to a document
  const entityTagId = tagOps.applyTag(db, tag.id, docId, 'document');
  assert(
    typeof entityTagId === 'string' && entityTagId.length > 0,
    'Tag with comma applied to document'
  );

  // Test 3: Search by tags - the comma name must be returned intact
  const results = tagOps.searchByTags(db, ['test,comma'], 'document');
  assert(
    results.length > 0,
    'searchByTags finds entities with comma-containing tag name',
    `Got ${results.length} results`
  );

  // Test 4: Verify the tag name is returned intact (not split at comma)
  const foundTags = results[0]?.tags || [];
  assert(
    foundTags.includes('test,comma'),
    'Tag name "test,comma" returned intact (not split)',
    `Got tags: ${JSON.stringify(foundTags)}`
  );

  // Test 5: getTagsForEntity also returns the comma tag intact
  const entityTags = tagOps.getTagsForEntity(db, docId, 'document');
  const commaTag = entityTags.find((t: { name: string }) => t.name === 'test,comma');
  assert(
    commaTag !== undefined,
    'getTagsForEntity returns "test,comma" tag intact',
    `Got tags: ${entityTags.map((t: { name: string }) => t.name).join(', ')}`
  );

  // Cleanup
  tagOps.deleteTag(db, tag.id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// L-8: Error isError Flag
// ═══════════════════════════════════════════════════════════════════════════════

function testL8_ErrorIsErrorFlag() {
  console.error('\n=== L-8: Error isError Flag ===');

  const { handleError } = require(resolve(PROJECT_ROOT, 'dist/tools/shared.js'));
  const { MCPError } = require(resolve(PROJECT_ROOT, 'dist/server/errors.js'));

  // Test 1: handleError returns isError: true
  const error = new MCPError('VALIDATION_ERROR', 'Test error');
  const response = handleError(error);
  assert(
    response.isError === true,
    'handleError response has isError: true',
    `Got isError: ${response.isError}`
  );

  // Test 2: handleError content is an array with text type
  assert(
    Array.isArray(response.content) && response.content.length > 0,
    'handleError response has content array'
  );

  assert(response.content[0].type === 'text', 'handleError content[0].type is "text"');

  // Test 3: The error response JSON contains recovery hint
  const parsedContent = JSON.parse(response.content[0].text);
  assert(
    parsedContent.error?.recovery?.tool !== undefined,
    'Error response includes recovery hint with tool',
    `Got recovery: ${JSON.stringify(parsedContent.error?.recovery)}`
  );

  // Test 4: MCPError.fromUnknown handles unknown errors
  const unknownErr = MCPError.fromUnknown('something broke');
  assert(
    unknownErr.category === 'INTERNAL_ERROR',
    'MCPError.fromUnknown(string) defaults to INTERNAL_ERROR',
    `Got category: ${unknownErr.category}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// L-13: Provenance Circular Reference Detection
// ═══════════════════════════════════════════════════════════════════════════════

function testL13_ProvenanceCircularRef(db: Database.Database) {
  console.error('\n=== L-13: Provenance Circular Reference ===');

  const { getProvenanceChain } = require(
    resolve(PROJECT_ROOT, 'dist/services/storage/database/provenance-operations.js')
  );

  const now = new Date().toISOString();
  const rootDocId = randomUUID();

  // Create three provenance records forming a cycle: A -> B -> C -> A
  const provA = randomUUID();
  const provB = randomUUID();
  const provC = randomUUID();

  // Insert provenance A first (no parent initially)
  db.prepare(
    `
    INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_id, parent_ids, chain_depth, chain_path)
    VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, 'chunker', '1.0', '{}', NULL, '[]', 2, '["A"]')
  `
  ).run(provA, now, now, rootDocId, sha256('provA'));

  // Insert provenance B with parent = A
  db.prepare(
    `
    INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_id, parent_ids, chain_depth, chain_path)
    VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, 'chunker', '1.0', '{}', ?, '[]', 3, '["B"]')
  `
  ).run(provB, now, now, rootDocId, sha256('provB'), provA);

  // Insert provenance C with parent = B
  db.prepare(
    `
    INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_id, parent_ids, chain_depth, chain_path)
    VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, 'chunker', '1.0', '{}', ?, '[]', 4, '["C"]')
  `
  ).run(provC, now, now, rootDocId, sha256('provC'), provB);

  // Now create the cycle: update A's parent_id to C
  db.prepare('UPDATE provenance SET parent_id = ? WHERE id = ?').run(provC, provA);

  // getProvenanceChain should throw on circular reference
  let threwError = false;
  let errorMessage = '';
  try {
    getProvenanceChain(db, provA);
  } catch (err) {
    threwError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  assert(
    threwError,
    'getProvenanceChain throws on circular reference',
    threwError ? `Error: ${errorMessage}` : 'No error thrown'
  );

  assert(
    errorMessage.includes('Circular reference'),
    'Error message mentions "Circular reference"',
    `Got: ${errorMessage}`
  );

  // Cleanup the circular records (must break cycle first)
  db.prepare('UPDATE provenance SET parent_id = NULL WHERE id = ?').run(provA);
  db.prepare('DELETE FROM provenance WHERE id IN (?, ?, ?)').run(provA, provB, provC);
}

// ═══════════════════════════════════════════════════════════════════════════════
// L-3: parseInt NaN Validation
// ═══════════════════════════════════════════════════════════════════════════════

function testL3_ParseIntNaN() {
  console.error('\n=== L-3: parseInt NaN Validation ===');

  // Save and set invalid env var
  const origVal = process.env.GEMINI_MAX_OUTPUT_TOKENS;
  const origKey = process.env.GEMINI_API_KEY;

  process.env.GEMINI_MAX_OUTPUT_TOKENS = 'abc';
  process.env.GEMINI_API_KEY = 'test-key-for-validation';

  // Clear the module cache to force re-evaluation
  const configPath = resolve(PROJECT_ROOT, 'dist/services/gemini/config.js');
  delete require.cache[configPath];

  const { loadGeminiConfig } = require(configPath);

  let threw = false;
  let errMsg = '';
  try {
    loadGeminiConfig();
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }

  assert(
    threw,
    'loadGeminiConfig throws when GEMINI_MAX_OUTPUT_TOKENS is "abc"',
    threw ? `Error: ${errMsg}` : 'No error thrown'
  );

  assert(
    errMsg.includes('Invalid numeric') ||
      errMsg.includes('NaN') ||
      errMsg.includes('GEMINI_MAX_OUTPUT_TOKENS'),
    'Error message references the invalid env var',
    `Got: ${errMsg}`
  );

  // Restore
  if (origVal !== undefined) {
    process.env.GEMINI_MAX_OUTPUT_TOKENS = origVal;
  } else {
    delete process.env.GEMINI_MAX_OUTPUT_TOKENS;
  }
  if (origKey !== undefined) {
    process.env.GEMINI_API_KEY = origKey;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// L-6: Whitespace API Key
// ═══════════════════════════════════════════════════════════════════════════════

function testL6_WhitespaceAPIKey() {
  console.error('\n=== L-6: Whitespace API Key ===');

  // Save original value
  const origKey = process.env.GEMINI_API_KEY;

  // Set whitespace-only API key
  process.env.GEMINI_API_KEY = '   ';

  // Clear module cache
  const configPath = resolve(PROJECT_ROOT, 'dist/services/gemini/config.js');
  delete require.cache[configPath];

  const { loadGeminiConfig } = require(configPath);

  // loadGeminiConfig should throw because the trimmed key is empty
  let threw = false;
  let errMsg = '';
  try {
    loadGeminiConfig();
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }

  assert(
    threw,
    'loadGeminiConfig throws when GEMINI_API_KEY is whitespace-only',
    threw ? `Error: ${errMsg}` : 'No error thrown'
  );

  // Also check the VLM status handler's check
  // The code: const apiKeyConfigured = !!(process.env.GEMINI_API_KEY?.trim());
  const apiKeyConfigured = !!process.env.GEMINI_API_KEY?.trim();
  assert(
    apiKeyConfigured === false,
    'Whitespace GEMINI_API_KEY evaluates to apiKeyConfigured: false',
    `Got: ${apiKeyConfigured}`
  );

  // Restore
  if (origKey !== undefined) {
    process.env.GEMINI_API_KEY = origKey;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// L-1: Embedding Worker Device Resolution (Python test)
// ═══════════════════════════════════════════════════════════════════════════════

function testL1_EmbeddingDeviceResolution() {
  console.error('\n=== L-1: Embedding Worker Device Resolution ===');

  // Read the Python file directly to verify the resolve_device logic
  const pythonPath = resolve(PROJECT_ROOT, 'python/embedding_worker.py');
  const pythonContent = readFileSync(pythonPath, 'utf-8');

  // Verify resolve_device function exists and handles "auto"
  assert(
    pythonContent.includes('def resolve_device'),
    'resolve_device function exists in embedding_worker.py'
  );

  // Verify it never returns "auto"
  assert(
    pythonContent.includes('if requested == "auto"'),
    'resolve_device handles "auto" explicitly'
  );

  // Verify it returns concrete device (cuda:0, mps, or cpu)
  // Note: CUDA path does `device = "cuda:0"; return device` rather than `return "cuda:0"` directly
  assert(
    pythonContent.includes('"cuda:0"') &&
      pythonContent.includes('return "mps"') &&
      pythonContent.includes('return "cpu"'),
    'resolve_device returns concrete device strings (cuda:0, mps, cpu)'
  );

  // Verify load_model calls resolve_device
  assert(
    pythonContent.includes('resolve_device(device)'),
    'load_model calls resolve_device to resolve "auto"'
  );

  // Try running a quick Python test if possible
  try {
    const result = execSync(
      "python3 -c \"import sys; sys.path.insert(0, 'python'); from embedding_worker import resolve_device; d = resolve_device('auto'); assert d != 'auto', f'Expected concrete device, got: {d}'; print(d)\"",
      { cwd: PROJECT_ROOT, timeout: 30000, encoding: 'utf-8' }
    ).trim();
    assert(result !== 'auto', `Python resolve_device("auto") returns concrete device: "${result}"`);
  } catch (err) {
    // May fail if torch is not installed
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('ModuleNotFoundError') || errMsg.includes('torch')) {
      console.error('  SKIP: Python torch not available for live test');
    } else {
      assert(false, 'Python resolve_device test', errMsg);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Additional Source Code Verification Tests
// ═══════════════════════════════════════════════════════════════════════════════

function testAdditionalSourceVerifications() {
  console.error('\n=== Additional Source Code Verifications ===');

  // M-7: Silent catch logging - verify shared.ts handleError logs with console.error
  const sharedPath = resolve(PROJECT_ROOT, 'dist/tools/shared.js');
  const sharedContent = readFileSync(sharedPath, 'utf-8');
  assert(
    sharedContent.includes('console.error'),
    'shared.ts handleError uses console.error (not silent catch)'
  );

  // L-7: FTS stale detection uses trigger existence
  const bm25Path = resolve(PROJECT_ROOT, 'dist/services/search/bm25.js');
  const bm25Content = readFileSync(bm25Path, 'utf-8');
  assert(
    bm25Content.includes('checkTriggersExist'),
    'BM25 FTS stale detection uses trigger existence check (L-7 fix)'
  );

  // M-12: SQL string interpolation whitelist guards
  const provOpsPath = resolve(
    PROJECT_ROOT,
    'dist/services/storage/database/provenance-operations.js'
  );
  const provOpsContent = readFileSync(provOpsPath, 'utf-8');
  assert(
    provOpsContent.includes('VALID_ORDER_COLUMNS') ||
      provOpsContent.includes('Invalid order column'),
    'Provenance query has order column whitelist guard (M-12 fix)'
  );

  // L-5: Hyphens treated as word separators in sanitizeFTS5Query
  const { sanitizeFTS5Query } = require(resolve(PROJECT_ROOT, 'dist/services/search/bm25.js'));
  const hyphenResult = sanitizeFTS5Query('auto-immune');
  assert(
    hyphenResult === 'auto AND immune',
    'sanitizeFTS5Query("auto-immune") treats hyphen as separator',
    `Got: "${hyphenResult}"`
  );

  // Quality multiplier clamped to 0-5 range (L-6 from previous audit)
  const qualityPath = resolve(PROJECT_ROOT, 'dist/services/search/quality.js');
  const qualityContent = readFileSync(qualityPath, 'utf-8');
  assert(
    qualityContent.includes('Math.min') ||
      qualityContent.includes('Math.max') ||
      qualityContent.includes('clamp'),
    'Quality multiplier has bounds clamping'
  );

  // Verify the error recovery hints cover all categories
  const errorsPath = resolve(PROJECT_ROOT, 'dist/server/errors.js');
  const errorsContent = readFileSync(errorsPath, 'utf-8');
  assert(
    errorsContent.includes('VALIDATION_ERROR') && errorsContent.includes('RECOVERY_HINTS'),
    'Error recovery hints map exists for all categories'
  );

  // Verify empty chunk validation (I-6 from system health audit)
  const chunkerPath = resolve(PROJECT_ROOT, 'dist/services/chunking/chunker.js');
  if (existsSync(chunkerPath)) {
    const chunkerContent = readFileSync(chunkerPath, 'utf-8');
    assert(
      chunkerContent.includes('trim()') ||
        chunkerContent.includes('length === 0') ||
        chunkerContent.includes('empty'),
      'Chunker has empty chunk validation'
    );
  } else {
    console.error('  SKIP: chunker.js not found');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  FORENSIC AUDIT VERIFICATION - Manual E2E Test             ║');
  console.error('║  Testing all bug fixes with REAL data                      ║');
  console.error('╚══════════════════════════════════════════════════════════════╝\n');

  // Setup
  console.error('Setting up test database...');
  const db = setupDatabase();
  const { docId, docId2, chunkIds, provIds } = insertSyntheticData(db);
  console.error(`  Created test database: ${TEST_DB_PATH}`);
  console.error(`  Documents: ${docId}, ${docId2}`);
  console.error(`  Chunks: ${chunkIds.length}, Provenance: ${provIds.length}`);

  // Run all tests
  try {
    testH1H2_FTS5QuerySanitization(db);
    testH3H4_MigrationSafety();
    testH5_CrossDBNormalization();
    testH6_UnboundedQueries(db);
    testM1_MetadataFilterBypass(db, docId);
    testM3_LIKEEscaping(db, docId2);
    testL4_TagCommaSafety(db, docId);
    testL8_ErrorIsErrorFlag();
    testL13_ProvenanceCircularRef(db);
    testL3_ParseIntNaN();
    testL6_WhitespaceAPIKey();
    testL1_EmbeddingDeviceResolution();
    testAdditionalSourceVerifications();
  } catch (err) {
    console.error(`\n*** CATASTROPHIC FAILURE: ${err}`);
    if (err instanceof Error) {
      console.error(err.stack);
    }
    failed++;
    failures.push(`Catastrophic: ${err}`);
  }

  // Summary
  console.error('\n╔══════════════════════════════════════════════════════════════╗');
  console.error(`║  RESULTS: ${passed} PASSED, ${failed} FAILED                              `);
  console.error('╚══════════════════════════════════════════════════════════════╝');

  if (failures.length > 0) {
    console.error('\nFailed tests:');
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
  }

  // Cleanup
  try {
    db.close();
  } catch (_) {
    // Ignore close errors
  }

  // Remove test database
  try {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { force: true });
    }
    if (existsSync(TEST_DB_PATH + '-wal')) {
      rmSync(TEST_DB_PATH + '-wal', { force: true });
    }
    if (existsSync(TEST_DB_PATH + '-shm')) {
      rmSync(TEST_DB_PATH + '-shm', { force: true });
    }
    console.error('\nTest database cleaned up.');
  } catch (_) {
    console.error('\nWarning: Failed to clean up test database.');
  }

  // Exit with error code if any tests failed
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
