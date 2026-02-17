/**
 * End-to-end manual verification of joint extraction pipeline.
 *
 * This test:
 * 1. Creates a test database with schema v25
 * 2. Inserts a synthetic document with known entities
 * 3. Calls extractEntitiesAndRelationships() with REAL Gemini API
 * 4. Calls storeJointExtractionResults() to persist results
 * 5. Verifies database state matches expected entities and relationships
 *
 * Requires: GEMINI_API_KEY environment variable
 *
 * Run with: npx vitest run --config vitest.config.all.ts tests/manual/joint-extraction-e2e.test.ts --reporter=verbose
 *
 * IMPORTANT: All Gemini API calls run sequentially in beforeAll to avoid
 * rate limiting / timeout issues from concurrent requests.
 *
 * @module tests/manual/joint-extraction-e2e
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from 'dotenv';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  insertTestProvenance,
  insertTestDocument,
} from '../unit/migrations/helpers.js';
import { migrateToLatest } from '../../src/services/storage/migrations/operations.js';
import {
  extractEntitiesAndRelationships,
  storeJointExtractionResults,
  buildKGEntityHints,
  type JointExtractionResult,
} from '../../src/utils/entity-extraction-helpers.js';
import { GeminiClient, resetSharedClient } from '../../src/services/gemini/client.js';

// Load .env for GEMINI_API_KEY
config();

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC_TEXT = `Dr. Robert Smith, a cardiologist at Memorial General Hospital in Springfield, IL, evaluated patient Jane Marie Doe (DOB: 1985-03-15) on 2024-04-10.

Ms. Doe presented with a diagnosis of essential hypertension (ICD-10: I10) and type 2 diabetes mellitus (ICD-10: E11.9). She was prescribed Metoprolol Tartrate 50mg twice daily for blood pressure management and Metformin 1000mg daily for glucose control.

Attorney Michael Johnson of Johnson & Associates filed Case No. 2024-CV-0042 in Cook County Circuit Court on behalf of Ms. Doe on 2024-05-20, alleging medical malpractice by Dr. Smith regarding delayed diagnosis.

Dr. Sarah Williams, Chief of Cardiology at Memorial General Hospital, supervised Dr. Smith during the relevant treatment period from 2024-01-01 to 2024-06-30.`;

const EMPTY_TEXT = 'No meaningful content here.';
const NOISE_ONLY_TEXT =
  'Patient BP: 120/80, HR: 72, SSN: 123-45-6789, Phone: (555) 123-4567, Time: 14:30';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface EntityTypeCount { entity_type: string; count: number }
interface MentionRow { entity_id: string; entity_type: string; raw_text: string; mention_count: number }
interface NodeTypeCount { entity_type: string; count: number }
interface EdgeTypeCount { relationship_type: string; count: number }
interface SegmentRow { id: string; document_id: string; extraction_status: string; entity_count: number; text_length: number }
interface ProvenanceRow { id: string; type: string; chain_depth: number }

/** Delay helper to avoid Gemini rate limiting between sequential calls */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Set up a test database with full schema, a document record, OCR result,
 * provenance chain, and chunks covering the full text.
 */
function setupTestDatabase(text: string): {
  db: Database.Database;
  testDir: string;
  documentId: string;
  ocrResultId: string;
  entityProvId: string;
  kgProvId: string;
} {
  const testDir = createTestDir('joint-e2e');
  const { db } = createTestDb(testDir);

  // Full schema migration
  migrateToLatest(db);

  // IDs
  const documentId = uuidv4();
  const ocrResultId = uuidv4();
  const entityProvId = uuidv4();
  const kgProvId = uuidv4();
  const docProvId = uuidv4();
  const ocrProvId = uuidv4();
  const now = new Date().toISOString();

  // Provenance chain
  insertTestProvenance(db, docProvId, 'DOCUMENT', documentId);
  insertTestProvenance(db, ocrProvId, 'OCR_RESULT', documentId);
  insertTestProvenance(db, entityProvId, 'ENTITY_EXTRACTION', documentId);
  insertTestProvenance(db, kgProvId, 'KNOWLEDGE_GRAPH', documentId);

  // Document
  insertTestDocument(db, documentId, docProvId, 'complete');

  // OCR result
  db.prepare(
    `INSERT INTO ocr_results (
      id, provenance_id, document_id, extracted_text, text_length,
      datalab_request_id, datalab_mode, parse_quality_score, page_count,
      cost_cents, content_hash, processing_started_at, processing_completed_at,
      processing_duration_ms, json_blocks, extras_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ocrResultId, ocrProvId, documentId, text, text.length,
    'test-request-001', 'balanced', 4.5, 1, 0.01,
    `sha256:${ocrResultId}`, now, now, 100, null, null
  );

  // Create chunks covering the full text (~500 chars each)
  // Each chunk needs its own unique provenance_id (UNIQUE constraint on chunks table)
  const chunkSize = 500;
  const overlap = 50;
  let pos = 0;
  let chunkIndex = 0;
  while (pos < text.length) {
    const end = Math.min(pos + chunkSize, text.length);
    const chunkId = uuidv4();
    const thisChunkProvId = uuidv4();
    insertTestProvenance(db, thisChunkProvId, 'CHUNK', documentId);

    db.prepare(
      `INSERT INTO chunks (
        id, document_id, ocr_result_id, text, text_hash,
        chunk_index, character_start, character_end,
        page_number, page_range, overlap_previous, overlap_next,
        provenance_id, created_at, embedding_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chunkId, documentId, ocrResultId,
      text.slice(pos, end), `sha256:chunk-${chunkIndex}`,
      chunkIndex, pos, end,
      1, null,
      chunkIndex > 0 ? overlap : 0,
      end < text.length ? overlap : 0,
      thisChunkProvId, now, 'pending'
    );
    pos = end - (end < text.length ? overlap : 0);
    chunkIndex++;
  }

  return { db, testDir, documentId, ocrResultId, entityProvId, kgProvId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE - All Gemini calls happen sequentially in a single beforeAll
// to avoid rate limiting / concurrent timeout issues.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Joint Extraction E2E Pipeline', () => {
  // Shared state populated by beforeAll
  let client: GeminiClient;
  let db: Database.Database;
  let testDir: string;
  let documentId: string;
  let ocrResultId: string;
  let entityProvId: string;
  let kgProvId: string;
  let extractionResult: JointExtractionResult;
  let storeResult: {
    totalEntities: number;
    totalMentions: number;
    totalNodes: number;
    totalEdges: number;
    entitiesByType: Record<string, number>;
  };
  let emptyResult: JointExtractionResult;
  let noiseResult: JointExtractionResult;
  // Idempotency test state
  let idempDb: Database.Database;
  let idempTestDir: string;
  let idempStore1: typeof storeResult;
  let idempStore2: typeof storeResult;
  let idempDocumentId: string;

  beforeAll(async () => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        'GEMINI_API_KEY must be set. Copy .env.example to .env and add your key.'
      );
    }

    // Reset shared client state to avoid poisoned circuit breaker from previous runs
    resetSharedClient();
    client = new GeminiClient();

    // ── CALL 1: Main synthetic document extraction ───────────────────────
    console.error('\n========================================');
    console.error('CALL 1: Extracting from synthetic document...');
    console.error('========================================');

    const setup = setupTestDatabase(SYNTHETIC_TEXT);
    db = setup.db;
    testDir = setup.testDir;
    documentId = setup.documentId;
    ocrResultId = setup.ocrResultId;
    entityProvId = setup.entityProvId;
    kgProvId = setup.kgProvId;

    const startTime = Date.now();
    extractionResult = await extractEntitiesAndRelationships(client, SYNTHETIC_TEXT);
    const extractionTime = Date.now() - startTime;

    console.error('\n=== EXTRACTION RESULTS ===');
    console.error(`Entities: ${extractionResult.entities.length}`);
    console.error(`Relationships: ${extractionResult.relationships.length}`);
    console.error(
      `Token usage: ${extractionResult.token_usage.inputTokens} input, ${extractionResult.token_usage.outputTokens} output`
    );
    console.error(`Processing time: ${extractionTime}ms`);
    console.error(`Was chunked: ${extractionResult.was_chunked}`);
    console.error('\n--- Entities ---');
    for (const e of extractionResult.entities) {
      console.error(
        `  [${e.type}] ${e.canonical_name} (id=${e.id}, conf=${e.confidence}${e.aliases?.length ? `, aliases=${e.aliases.join('; ')}` : ''})`
      );
    }
    console.error('\n--- Relationships ---');
    for (const r of extractionResult.relationships) {
      console.error(
        `  ${r.source_id} --[${r.relationship_type}]--> ${r.target_id} (conf=${r.confidence}${r.evidence ? `, evidence="${r.evidence}"` : ''}${r.temporal ? `, temporal="${r.temporal}"` : ''})`
      );
    }

    // Store results
    storeResult = storeJointExtractionResults(
      db, documentId, ocrResultId, SYNTHETIC_TEXT,
      extractionResult, entityProvId, kgProvId
    );

    console.error('\n=== STORAGE RESULTS ===');
    console.error(`Total entities stored: ${storeResult.totalEntities}`);
    console.error(`Total mentions stored: ${storeResult.totalMentions}`);
    console.error(`Total KG nodes: ${storeResult.totalNodes}`);
    console.error(`Total KG edges: ${storeResult.totalEdges}`);
    console.error(`Entities by type: ${JSON.stringify(storeResult.entitiesByType)}`);

    // ── CALL 2: Empty text (wait 5s to avoid rate limit) ────────────────
    await delay(5000);
    console.error('\n========================================');
    console.error('CALL 2: Extracting from empty text...');
    console.error('========================================');

    emptyResult = await extractEntitiesAndRelationships(client, EMPTY_TEXT);

    console.error('\n=== EDGE CASE: EMPTY TEXT ===');
    console.error(`Entities: ${emptyResult.entities.length}`);
    console.error(`Relationships: ${emptyResult.relationships.length}`);

    // ── CALL 3: Noise-only text (wait 5s) ───────────────────────────────
    await delay(5000);
    console.error('\n========================================');
    console.error('CALL 3: Extracting from noise-only text...');
    console.error('========================================');

    noiseResult = await extractEntitiesAndRelationships(client, NOISE_ONLY_TEXT);

    console.error('\n=== EDGE CASE: NOISE-ONLY TEXT ===');
    console.error(`Entities after filter: ${noiseResult.entities.length}`);
    for (const e of noiseResult.entities) {
      console.error(`  [${e.type}] ${e.canonical_name} (conf=${e.confidence})`);
    }
    console.error(`Relationships: ${noiseResult.relationships.length}`);

    // ── CALL 4+5: Idempotency test (two extractions, wait 5s between) ──
    await delay(5000);
    console.error('\n========================================');
    console.error('CALL 4: Idempotency test - first extraction...');
    console.error('========================================');

    const idempSetup = setupTestDatabase(SYNTHETIC_TEXT);
    idempDb = idempSetup.db;
    idempTestDir = idempSetup.testDir;
    idempDocumentId = idempSetup.documentId;

    const idempResult1 = await extractEntitiesAndRelationships(client, SYNTHETIC_TEXT);
    idempStore1 = storeJointExtractionResults(
      idempDb, idempDocumentId, idempSetup.ocrResultId, SYNTHETIC_TEXT,
      idempResult1, idempSetup.entityProvId, idempSetup.kgProvId
    );

    await delay(5000);
    console.error('\n========================================');
    console.error('CALL 5: Idempotency test - second extraction...');
    console.error('========================================');

    const idempResult2 = await extractEntitiesAndRelationships(client, SYNTHETIC_TEXT);
    const entityProv2 = uuidv4();
    const kgProv2 = uuidv4();
    insertTestProvenance(idempDb, entityProv2, 'ENTITY_EXTRACTION', idempDocumentId);
    insertTestProvenance(idempDb, kgProv2, 'KNOWLEDGE_GRAPH', idempDocumentId);

    idempStore2 = storeJointExtractionResults(
      idempDb, idempDocumentId, idempSetup.ocrResultId, SYNTHETIC_TEXT,
      idempResult2, entityProv2, kgProv2
    );

    console.error('\n=== IDEMPOTENCY TEST ===');
    console.error(`First run: ${idempStore1.totalEntities} entities, ${idempStore1.totalMentions} mentions`);
    console.error(`Second run: ${idempStore2.totalEntities} entities, ${idempStore2.totalMentions} mentions`);
  }, 600_000); // 10 min timeout for all sequential Gemini calls

  afterAll(() => {
    closeDb(db);
    if (testDir) cleanupTestDir(testDir);
    closeDb(idempDb);
    if (idempTestDir) cleanupTestDir(idempTestDir);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1: Full pipeline with synthetic medical-legal document
  // ─────────────────────────────────────────────────────────────────────────
  describe('Full pipeline with synthetic document', () => {
    it('should extract a reasonable number of entities (8-25)', () => {
      expect(extractionResult.entities.length).toBeGreaterThanOrEqual(8);
      expect(extractionResult.entities.length).toBeLessThanOrEqual(25);
    });

    it('should extract relationships', () => {
      expect(extractionResult.relationships.length).toBeGreaterThanOrEqual(3);
    });

    it('should include expected entity types', () => {
      const types = new Set(extractionResult.entities.map((e) => e.type));
      console.error(`\n--- Entity types found: ${[...types].join(', ')}`);
      expect(types.has('person')).toBe(true);
      expect(types.has('organization')).toBe(true);
      expect(types.has('date')).toBe(true);
      expect(types.has('medication')).toBe(true);
    });

    it('should include relationship types like works_at, diagnosed_with, treated_with', () => {
      const relTypes = new Set(
        extractionResult.relationships.map((r) => r.relationship_type)
      );
      console.error(`\n--- Relationship types found: ${[...relTypes].join(', ')}`);
      const expectedRelTypes = [
        'works_at', 'diagnosed_with', 'treated_with', 'supervised_by',
        'represents', 'filed_in', 'located_in', 'prescribed_by',
        'party_to', 'filed_by',
      ];
      const foundExpected = expectedRelTypes.filter((t) => relTypes.has(t));
      console.error(`  Expected types found: ${foundExpected.join(', ')}`);
      expect(foundExpected.length).toBeGreaterThanOrEqual(3);
    });

    it('should NOT have co_mentioned or co_located edges (old system)', () => {
      const relTypes = new Set(
        extractionResult.relationships.map((r) => r.relationship_type)
      );
      expect(relTypes.has('co_mentioned')).toBe(false);
      expect(relTypes.has('co_located')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Verification SQL Queries (V1-V8)
  // ─────────────────────────────────────────────────────────────────────────
  describe('Database verification queries', () => {
    it('V1: Entity count by type should match stored counts', () => {
      const rows = db
        .prepare(
          `SELECT entity_type, COUNT(*) as count FROM entities
           WHERE document_id = ? GROUP BY entity_type ORDER BY count DESC`
        )
        .all(documentId) as EntityTypeCount[];

      console.error('\n=== V1: ENTITY COUNT BY TYPE ===');
      for (const row of rows) {
        console.error(`  ${row.entity_type}: ${row.count}`);
      }

      const totalFromDb = rows.reduce((sum, r) => sum + r.count, 0);
      expect(totalFromDb).toBe(storeResult.totalEntities);
    });

    it('V2: Entity mentions should map to chunks', () => {
      const rows = db
        .prepare(
          `SELECT e.id as entity_id, e.entity_type, e.raw_text,
                  COUNT(em.id) as mention_count
           FROM entities e
           JOIN entity_mentions em ON em.entity_id = e.id
           WHERE e.document_id = ?
           GROUP BY e.id ORDER BY mention_count DESC`
        )
        .all(documentId) as MentionRow[];

      console.error('\n=== V2: ENTITY MENTIONS ===');
      for (const row of rows) {
        console.error(`  [${row.entity_type}] "${row.raw_text}": ${row.mention_count} mention(s)`);
      }

      const totalMentionsFromDb = rows.reduce((sum, r) => sum + r.mention_count, 0);
      expect(totalMentionsFromDb).toBe(storeResult.totalMentions);

      for (const row of rows) {
        expect(row.mention_count).toBeGreaterThanOrEqual(1);
      }
    });

    it('V3: KG nodes should exist per entity type', () => {
      const rows = db
        .prepare(
          `SELECT entity_type, COUNT(*) as count FROM knowledge_nodes
           WHERE provenance_id = ? GROUP BY entity_type ORDER BY count DESC`
        )
        .all(kgProvId) as NodeTypeCount[];

      console.error('\n=== V3: KG NODES BY TYPE ===');
      for (const row of rows) {
        console.error(`  ${row.entity_type}: ${row.count}`);
      }

      const totalNodesFromDb = rows.reduce((sum, r) => sum + r.count, 0);
      expect(totalNodesFromDb).toBe(storeResult.totalNodes);
    });

    it('V4: KG edges should have semantic relationship types', () => {
      const rows = db
        .prepare(
          `SELECT relationship_type, COUNT(*) as count FROM knowledge_edges
           WHERE provenance_id = ? GROUP BY relationship_type ORDER BY count DESC`
        )
        .all(kgProvId) as EdgeTypeCount[];

      console.error('\n=== V4: KG EDGES BY RELATIONSHIP TYPE ===');
      for (const row of rows) {
        console.error(`  ${row.relationship_type}: ${row.count}`);
      }

      const totalEdgesFromDb = rows.reduce((sum, r) => sum + r.count, 0);
      expect(totalEdgesFromDb).toBe(storeResult.totalEdges);

      const edgeTypes = rows.map((r) => r.relationship_type);
      expect(edgeTypes).not.toContain('co_mentioned');
      expect(edgeTypes).not.toContain('co_located');
    });

    it('V5: Node-entity links should connect all entities to nodes', () => {
      const linkCount = db
        .prepare('SELECT COUNT(*) as count FROM node_entity_links WHERE document_id = ?')
        .get(documentId) as { count: number };

      console.error(`\n=== V5: NODE-ENTITY LINKS: ${linkCount.count} ===`);
      expect(linkCount.count).toBe(storeResult.totalEntities);
    });

    it('V6: Extraction segment should have 1 row with status=complete', () => {
      const rows = db
        .prepare(
          `SELECT id, document_id, extraction_status, entity_count, text_length
           FROM entity_extraction_segments WHERE document_id = ?`
        )
        .all(documentId) as SegmentRow[];

      console.error('\n=== V6: EXTRACTION SEGMENTS ===');
      for (const row of rows) {
        console.error(`  status=${row.extraction_status}, entity_count=${row.entity_count}, text_length=${row.text_length}`);
      }

      expect(rows.length).toBe(1);
      expect(rows[0].extraction_status).toBe('complete');
      expect(rows[0].entity_count).toBe(extractionResult.entities.length);
      expect(rows[0].text_length).toBe(SYNTHETIC_TEXT.length);
    });

    it('V7: Provenance chain should be intact', () => {
      const rows = db
        .prepare(
          `SELECT id, type, chain_depth FROM provenance
           WHERE root_document_id = ? ORDER BY chain_depth`
        )
        .all(documentId) as ProvenanceRow[];

      console.error('\n=== V7: PROVENANCE CHAIN ===');
      for (const row of rows) {
        console.error(`  type=${row.type}, depth=${row.chain_depth}`);
      }

      expect(rows.length).toBeGreaterThanOrEqual(5);
      const types = rows.map((r) => r.type);
      expect(types).toContain('DOCUMENT');
      expect(types).toContain('OCR_RESULT');
      expect(types).toContain('ENTITY_EXTRACTION');
      expect(types).toContain('KNOWLEDGE_GRAPH');
    });

    it('V8: buildKGEntityHints should return hints from stored KG nodes', () => {
      const hints = buildKGEntityHints(db);
      console.error(`\n=== V8: KG ENTITY HINTS ===`);
      console.error(hints ?? '(no hints)');

      expect(hints).toBeDefined();
      expect(hints!.length).toBeGreaterThan(0);
      expect(hints).toContain('Known entities from other documents:');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge cases (results already computed in beforeAll)
  // ─────────────────────────────────────────────────────────────────────────
  describe('Edge case: empty/minimal text', () => {
    it('should return 0 or very few entities for meaningless text', () => {
      expect(emptyResult.entities.length).toBeLessThanOrEqual(2);
      expect(emptyResult.relationships.length).toBe(0);
    });
  });

  describe('Edge case: noise-only text', () => {
    it('should filter most noise entities (BP, SSN, phone, time)', () => {
      expect(noiseResult.entities.length).toBeLessThanOrEqual(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Idempotency test (results already computed in beforeAll)
  // ─────────────────────────────────────────────────────────────────────────
  describe('Storage idempotency', () => {
    it('should overwrite previous extraction cleanly on re-run', () => {
      const entityCount = idempDb
        .prepare('SELECT COUNT(*) as count FROM entities WHERE document_id = ?')
        .get(idempDocumentId) as { count: number };
      const segmentCount = idempDb
        .prepare('SELECT COUNT(*) as count FROM entity_extraction_segments WHERE document_id = ?')
        .get(idempDocumentId) as { count: number };

      console.error(`\nDB entity count: ${entityCount.count} (should equal second run: ${idempStore2.totalEntities})`);
      console.error(`DB segment count: ${segmentCount.count} (should be 1)`);

      expect(entityCount.count).toBe(idempStore2.totalEntities);
      expect(segmentCount.count).toBe(1);
    });
  });
});
