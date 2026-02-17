/**
 * Tests for joint entity + relationship extraction functions
 *
 * Tests storeJointExtractionResults() with real SQLite databases.
 * Tests extractEntitiesAndRelationships() as integration test (requires GEMINI_API_KEY).
 *
 * Uses REAL databases (better-sqlite3 temp files), NO mocks.
 *
 * @module tests/unit/utils/joint-extraction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
} from '../migrations/helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';
import {
  storeJointExtractionResults,
  type JointExtractionResult,
} from '../../../src/utils/entity-extraction-helpers.js';

const sqliteVecAvailable = isSqliteVecAvailable();

// =============================================================================
// SYNTHETIC OCR TEXT
// =============================================================================

const SYNTHETIC_OCR_TEXT = `Dr. Robert Smith, a cardiologist at Memorial General Hospital in Springfield, IL, evaluated patient Jane Marie Doe (DOB: 1985-03-15) on 2024-04-10.

Ms. Doe presented with a diagnosis of essential hypertension (ICD-10: I10) and type 2 diabetes mellitus (ICD-10: E11.9). She was prescribed Metoprolol Tartrate 50mg twice daily for blood pressure management and Metformin 1000mg daily for glucose control.

Attorney Michael Johnson of Johnson & Associates filed Case No. 2024-CV-0042 in Cook County Circuit Court on behalf of Ms. Doe on 2024-05-20, alleging medical malpractice by Dr. Smith regarding delayed diagnosis.

Dr. Sarah Williams, Chief of Cardiology at Memorial General Hospital, supervised Dr. Smith during the relevant treatment period from 2024-01-01 to 2024-06-30.`;

// =============================================================================
// SYNTHETIC EXTRACTION RESULT
// =============================================================================

const syntheticResult: JointExtractionResult = {
  entities: [
    { id: 'e1', canonical_name: 'Dr. Robert Smith', type: 'person', aliases: ['Dr. Smith'], confidence: 0.95 },
    { id: 'e2', canonical_name: 'Jane Marie Doe', type: 'person', aliases: ['Ms. Doe'], confidence: 0.92 },
    { id: 'e3', canonical_name: 'Memorial General Hospital', type: 'organization', aliases: [], confidence: 0.98 },
    { id: 'e4', canonical_name: 'Springfield, IL', type: 'location', aliases: [], confidence: 0.90 },
    { id: 'e5', canonical_name: '2024-04-10', type: 'date', aliases: [], confidence: 0.99 },
    { id: 'e6', canonical_name: 'essential hypertension', type: 'diagnosis', aliases: ['I10'], confidence: 0.93 },
    { id: 'e7', canonical_name: 'type 2 diabetes mellitus', type: 'diagnosis', aliases: ['E11.9'], confidence: 0.94 },
    { id: 'e8', canonical_name: 'Metoprolol Tartrate', type: 'medication', aliases: [], confidence: 0.97 },
    { id: 'e9', canonical_name: 'Metformin', type: 'medication', aliases: [], confidence: 0.96 },
    { id: 'e10', canonical_name: 'Michael Johnson', type: 'person', aliases: [], confidence: 0.91 },
    { id: 'e11', canonical_name: 'Johnson & Associates', type: 'organization', aliases: [], confidence: 0.89 },
    { id: 'e12', canonical_name: '2024-CV-0042', type: 'case_number', aliases: [], confidence: 0.99 },
    { id: 'e13', canonical_name: 'Cook County Circuit Court', type: 'organization', aliases: [], confidence: 0.95 },
    { id: 'e14', canonical_name: 'Dr. Sarah Williams', type: 'person', aliases: [], confidence: 0.93 },
  ],
  relationships: [
    { source_id: 'e1', target_id: 'e3', relationship_type: 'works_at', confidence: 0.90, evidence: 'cardiologist at Memorial General Hospital' },
    { source_id: 'e2', target_id: 'e6', relationship_type: 'diagnosed_with', confidence: 0.95, evidence: 'diagnosis of essential hypertension' },
    { source_id: 'e2', target_id: 'e7', relationship_type: 'diagnosed_with', confidence: 0.94, evidence: 'type 2 diabetes mellitus' },
    { source_id: 'e6', target_id: 'e8', relationship_type: 'treated_with', confidence: 0.92, evidence: 'prescribed Metoprolol Tartrate for blood pressure' },
    { source_id: 'e7', target_id: 'e9', relationship_type: 'treated_with', confidence: 0.91, evidence: 'Metformin for glucose control' },
    { source_id: 'e10', target_id: 'e11', relationship_type: 'works_at', confidence: 0.88, evidence: 'Michael Johnson of Johnson & Associates' },
    { source_id: 'e10', target_id: 'e2', relationship_type: 'represents', confidence: 0.93, evidence: 'on behalf of Ms. Doe' },
    { source_id: 'e12', target_id: 'e13', relationship_type: 'filed_in', confidence: 0.97, evidence: 'filed in Cook County Circuit Court' },
    { source_id: 'e14', target_id: 'e1', relationship_type: 'supervised_by', confidence: 0.90, evidence: 'supervised Dr. Smith' },
    { source_id: 'e14', target_id: 'e3', relationship_type: 'works_at', confidence: 0.92, evidence: 'Chief of Cardiology at Memorial General Hospital' },
    { source_id: 'e3', target_id: 'e4', relationship_type: 'located_in', confidence: 0.85, evidence: 'in Springfield, IL' },
  ],
  token_usage: { inputTokens: 500, outputTokens: 1200 },
  processing_time_ms: 3500,
  was_chunked: false,
};

// =============================================================================
// TEST IDS
// =============================================================================

const DOC_ID = 'doc-joint-test-1';
const OCR_RESULT_ID = 'ocr-joint-test-1';
const PROV_DOC_ID = 'prov-joint-doc-1';
const PROV_OCR_ID = 'prov-joint-ocr-1';
const PROV_CHUNK_ID = 'prov-joint-chunk-1';
const PROV_ENTITY_ID = 'prov-joint-entity-1';
const PROV_KG_ID = 'prov-joint-kg-1';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Map provenance type to valid source_type CHECK constraint value.
 * The provenance.source_type CHECK constraint allows:
 *   FILE, OCR, CHUNKING, IMAGE_EXTRACTION, VLM, VLM_DEDUP, EMBEDDING,
 *   EXTRACTION, FORM_FILL, ENTITY_EXTRACTION, COMPARISON, CLUSTERING,
 *   KNOWLEDGE_GRAPH, CORPUS_INTELLIGENCE
 */
function typeToSourceType(type: string): string {
  const mapping: Record<string, string> = {
    DOCUMENT: 'FILE',
    OCR_RESULT: 'OCR',
    CHUNK: 'CHUNKING',
    ENTITY_EXTRACTION: 'ENTITY_EXTRACTION',
    KNOWLEDGE_GRAPH: 'KNOWLEDGE_GRAPH',
  };
  return mapping[type] ?? type;
}

function makeProvenance(
  db: Database.Database,
  id: string,
  type: string,
  rootDocId: string,
  chainDepth: number = 0,
  parentIds: string = '[]'
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
      content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, type, now, now, typeToSourceType(type), rootDocId,
    `sha256:${id}`, 'test', '1.0.0', '{}', parentIds, chainDepth);
}

function makeDocument(db: Database.Database, docId: string, provId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(docId, `/test/${docId}.pdf`, `${docId}.pdf`, `sha256:${docId}`, 4096, 'pdf', 'complete', provId, now);
}

function makeOcrResult(db: Database.Database, ocrId: string, docId: string, provId: string, text: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
      datalab_request_id, datalab_mode, page_count, content_hash,
      processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ocrId, provId, docId, text, text.length, 'req-test', 'accurate', 1, `sha256:${ocrId}`, now, now, 100);
}

/**
 * Create chunks that cover the full OCR text.
 * Splits into roughly equal-sized chunks with known character offsets.
 */
function makeChunks(
  db: Database.Database,
  docId: string,
  ocrId: string,
  rootDocProvId: string,
  text: string,
  chunkSize: number = 300
): string[] {
  const now = new Date().toISOString();
  const chunkIds: string[] = [];
  let index = 0;
  let charStart = 0;

  while (charStart < text.length) {
    const charEnd = Math.min(charStart + chunkSize, text.length);
    const chunkText = text.slice(charStart, charEnd);
    const chunkId = uuidv4();
    const chunkProvId = uuidv4();
    chunkIds.push(chunkId);

    // Each chunk needs its own unique provenance_id (UNIQUE constraint on chunks.provenance_id)
    makeProvenance(db, chunkProvId, 'CHUNK', rootDocProvId, 2, '[]');

    db.prepare(
      `INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index,
        character_start, character_end, page_number, page_range,
        overlap_previous, overlap_next, provenance_id, created_at,
        embedding_status, embedded_at, ocr_quality_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chunkId, docId, ocrId, chunkText, `sha256:chunk-${index}`, index,
      charStart, charEnd, 1, null,
      0, 0, chunkProvId, now,
      'pending', null, null
    );

    charStart = charEnd;
    index++;
  }

  return chunkIds;
}

// =============================================================================
// TESTS
// =============================================================================

describe('storeJointExtractionResults', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    if (!sqliteVecAvailable) return;

    tmpDir = createTestDir('ocr-joint-extraction');
    const result = createTestDb(tmpDir);
    db = result.db;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Run full migration
    migrateToLatest(db);

    // Set up provenance chain: DOCUMENT -> OCR_RESULT -> ENTITY_EXTRACTION, KNOWLEDGE_GRAPH
    // Chunk provenance records are created per-chunk inside makeChunks() (UNIQUE constraint)
    makeProvenance(db, PROV_DOC_ID, 'DOCUMENT', PROV_DOC_ID, 0);
    makeProvenance(db, PROV_OCR_ID, 'OCR_RESULT', PROV_DOC_ID, 1, `["${PROV_DOC_ID}"]`);
    makeProvenance(db, PROV_ENTITY_ID, 'ENTITY_EXTRACTION', PROV_DOC_ID, 2, `["${PROV_OCR_ID}"]`);
    makeProvenance(db, PROV_KG_ID, 'KNOWLEDGE_GRAPH', PROV_DOC_ID, 2, `["${PROV_ENTITY_ID}"]`);

    // Insert document and OCR result
    makeDocument(db, DOC_ID, PROV_DOC_ID);
    makeOcrResult(db, OCR_RESULT_ID, DOC_ID, PROV_OCR_ID, SYNTHETIC_OCR_TEXT);

    // Create chunks covering the full text (each chunk gets its own provenance record)
    makeChunks(db, DOC_ID, OCR_RESULT_ID, PROV_DOC_ID, SYNTHETIC_OCR_TEXT);
  });

  afterEach(() => {
    closeDb(db);
    if (tmpDir) cleanupTestDir(tmpDir);
  });

  it.skipIf(!sqliteVecAvailable)('stores entities in entities table', () => {
    const counts = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Verify total entity count
    expect(counts.totalEntities).toBe(14);

    const dbCount = db.prepare('SELECT COUNT(*) as cnt FROM entities WHERE document_id = ?')
      .get(DOC_ID) as { cnt: number };
    expect(dbCount.cnt).toBe(14);

    // Verify entity type distribution
    expect(counts.entitiesByType).toEqual({
      person: 4,
      organization: 3,
      location: 1,
      date: 1,
      diagnosis: 2,
      medication: 2,
      case_number: 1,
    });

    // Verify entity types in DB
    const typeCounts = db.prepare(
      `SELECT entity_type, COUNT(*) as cnt FROM entities
       WHERE document_id = ? GROUP BY entity_type ORDER BY entity_type`
    ).all(DOC_ID) as Array<{ entity_type: string; cnt: number }>;

    const typeMap: Record<string, number> = {};
    for (const row of typeCounts) {
      typeMap[row.entity_type] = row.cnt;
    }
    expect(typeMap['person']).toBe(4);
    expect(typeMap['organization']).toBe(3);
    expect(typeMap['medication']).toBe(2);
    expect(typeMap['diagnosis']).toBe(2);
    expect(typeMap['case_number']).toBe(1);
    expect(typeMap['date']).toBe(1);
    expect(typeMap['location']).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('stores entity mentions mapped to chunks', () => {
    const counts = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Should have at least 1 mention per entity (14 entities -> at least 14 mentions)
    expect(counts.totalMentions).toBeGreaterThanOrEqual(14);

    const dbMentionCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM entity_mentions WHERE document_id = ?'
    ).get(DOC_ID) as { cnt: number };
    expect(dbMentionCount.cnt).toBeGreaterThanOrEqual(14);

    // Entities that appear multiple times in the text should have multiple mentions.
    // "Dr. Smith" appears multiple times; "Memorial General Hospital" appears twice.
    // Check that at least some entities have multiple mentions via aliases.
    const drSmithEntity = db.prepare(
      `SELECT id FROM entities WHERE document_id = ? AND raw_text = 'Dr. Robert Smith'`
    ).get(DOC_ID) as { id: string } | undefined;

    if (drSmithEntity) {
      const drSmithMentions = db.prepare(
        'SELECT COUNT(*) as cnt FROM entity_mentions WHERE entity_id = ?'
      ).get(drSmithEntity.id) as { cnt: number };
      // "Dr. Robert Smith" appears once, "Dr. Smith" (alias) appears multiple times
      expect(drSmithMentions.cnt).toBeGreaterThanOrEqual(2);
    }

    // Check that mentions have chunk_id set (not null) for text matches
    const mentionsWithChunks = db.prepare(
      `SELECT COUNT(*) as cnt FROM entity_mentions
       WHERE document_id = ? AND chunk_id IS NOT NULL`
    ).get(DOC_ID) as { cnt: number };
    expect(mentionsWithChunks.cnt).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteVecAvailable)('creates KG nodes from entities', () => {
    const counts = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    expect(counts.totalNodes).toBe(14);

    const nodeCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE provenance_id = ?'
    ).get(PROV_KG_ID) as { cnt: number };
    expect(nodeCount.cnt).toBe(14);

    // Verify node data: canonical_name, entity_type, importance_score > 0
    const sampleNode = db.prepare(
      `SELECT * FROM knowledge_nodes WHERE canonical_name = 'Dr. Robert Smith'`
    ).get() as Record<string, unknown> | undefined;
    expect(sampleNode).toBeDefined();
    expect(sampleNode!.entity_type).toBe('person');
    expect(sampleNode!.document_count).toBe(1);
    expect(Number(sampleNode!.importance_score)).toBeGreaterThan(0);
    expect(Number(sampleNode!.avg_confidence)).toBeCloseTo(0.95, 1);
  });

  it.skipIf(!sqliteVecAvailable)('creates KG edges from relationships', () => {
    const counts = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    expect(counts.totalEdges).toBe(11);

    const edgeCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM knowledge_edges WHERE provenance_id = ?'
    ).get(PROV_KG_ID) as { cnt: number };
    expect(edgeCount.cnt).toBe(11);

    // Verify edge types distribution
    const edgeTypes = db.prepare(
      `SELECT relationship_type, COUNT(*) as cnt FROM knowledge_edges
       WHERE provenance_id = ? GROUP BY relationship_type ORDER BY relationship_type`
    ).all(PROV_KG_ID) as Array<{ relationship_type: string; cnt: number }>;

    const edgeTypeMap: Record<string, number> = {};
    for (const row of edgeTypes) {
      edgeTypeMap[row.relationship_type] = row.cnt;
    }
    expect(edgeTypeMap['works_at']).toBe(3);
    expect(edgeTypeMap['diagnosed_with']).toBe(2);
    expect(edgeTypeMap['treated_with']).toBe(2);
    expect(edgeTypeMap['represents']).toBe(1);
    expect(edgeTypeMap['filed_in']).toBe(1);
    expect(edgeTypeMap['supervised_by']).toBe(1);
    expect(edgeTypeMap['located_in']).toBe(1);

    // Verify edges have document_ids, evidence metadata
    const sampleEdge = db.prepare(
      `SELECT * FROM knowledge_edges WHERE relationship_type = 'filed_in' AND provenance_id = ?`
    ).get(PROV_KG_ID) as Record<string, unknown> | undefined;
    expect(sampleEdge).toBeDefined();
    expect(JSON.parse(sampleEdge!.document_ids as string)).toContain(DOC_ID);
    const edgeMeta = JSON.parse(sampleEdge!.metadata as string);
    expect(edgeMeta.evidence).toBe('filed in Cook County Circuit Court');
  });

  it.skipIf(!sqliteVecAvailable)('creates node_entity_links mapping', () => {
    storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    const linkCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM node_entity_links WHERE document_id = ?'
    ).get(DOC_ID) as { cnt: number };

    // 14 entities -> 14 node-entity links (one per entity)
    expect(linkCount.cnt).toBe(14);

    // Verify link has correct resolution_method
    const sampleLink = db.prepare(
      `SELECT * FROM node_entity_links WHERE document_id = ? LIMIT 1`
    ).get(DOC_ID) as Record<string, unknown> | undefined;
    expect(sampleLink).toBeDefined();
    expect(sampleLink!.resolution_method).toBe('gemini_coreference');
    expect(Number(sampleLink!.similarity_score)).toBe(1.0);
  });

  it.skipIf(!sqliteVecAvailable)('stores single extraction segment record', () => {
    storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    const segments = db.prepare(
      `SELECT * FROM entity_extraction_segments WHERE document_id = ?`
    ).all(DOC_ID) as Array<Record<string, unknown>>;

    expect(segments).toHaveLength(1);

    const seg = segments[0];
    expect(seg.segment_index).toBe(0);
    expect(seg.extraction_status).toBe('complete');
    expect(seg.entity_count).toBe(14);
    expect(seg.character_start).toBe(0);
    expect(seg.character_end).toBe(SYNTHETIC_OCR_TEXT.length);
    expect(seg.text_length).toBe(SYNTHETIC_OCR_TEXT.length);
    expect(seg.ocr_result_id).toBe(OCR_RESULT_ID);
    expect(seg.provenance_id).toBe(PROV_ENTITY_ID);
  });

  it.skipIf(!sqliteVecAvailable)('handles re-extraction idempotently', () => {
    // First extraction
    const counts1 = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Before re-extraction: clean up KG data that references old entities.
    // In production, cleanupGraphForDocument() handles this. The
    // storeJointExtractionResults function only cleans entities/mentions/segments,
    // not KG nodes/edges/links (those are managed separately).
    db.prepare('DELETE FROM node_entity_links WHERE document_id = ?').run(DOC_ID);
    db.prepare(
      `DELETE FROM knowledge_edges WHERE provenance_id = ?`
    ).run(PROV_KG_ID);
    db.prepare(
      `DELETE FROM knowledge_nodes WHERE provenance_id = ?`
    ).run(PROV_KG_ID);

    // Second extraction (re-extraction) -- should delete old entities/mentions/segments first
    const counts2 = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Return counts should be the same
    expect(counts2.totalEntities).toBe(counts1.totalEntities);
    expect(counts2.totalMentions).toBe(counts1.totalMentions);
    expect(counts2.totalNodes).toBe(counts1.totalNodes);
    expect(counts2.totalEdges).toBe(counts1.totalEdges);

    // Database should NOT have duplicates: entities should be exactly 14
    const entityCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM entities WHERE document_id = ?'
    ).get(DOC_ID) as { cnt: number };
    expect(entityCount.cnt).toBe(14);

    // Segments should be exactly 1
    const segmentCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM entity_extraction_segments WHERE document_id = ?'
    ).get(DOC_ID) as { cnt: number };
    expect(segmentCount.cnt).toBe(1);

    // KG nodes should be exactly 14 (not 28) after proper cleanup + re-extraction
    const nodeCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE provenance_id = ?'
    ).get(PROV_KG_ID) as { cnt: number };
    expect(nodeCount.cnt).toBe(14);
  });

  it.skipIf(!sqliteVecAvailable)('handles empty extraction result gracefully', () => {
    const emptyResult: JointExtractionResult = {
      entities: [],
      relationships: [],
      token_usage: { inputTokens: 100, outputTokens: 50 },
      processing_time_ms: 500,
      was_chunked: false,
    };

    const counts = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      emptyResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    expect(counts.totalEntities).toBe(0);
    expect(counts.totalMentions).toBe(0);
    expect(counts.totalNodes).toBe(0);
    expect(counts.totalEdges).toBe(0);
    expect(counts.entitiesByType).toEqual({});

    // Should still create 1 segment record
    const segmentCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM entity_extraction_segments WHERE document_id = ?'
    ).get(DOC_ID) as { cnt: number };
    expect(segmentCount.cnt).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('skips relationships with invalid types', () => {
    const resultWithBadRels: JointExtractionResult = {
      entities: [
        { id: 'e1', canonical_name: 'Alice', type: 'person', aliases: [], confidence: 0.9 },
        { id: 'e2', canonical_name: 'Bob', type: 'person', aliases: [], confidence: 0.9 },
      ],
      relationships: [
        { source_id: 'e1', target_id: 'e2', relationship_type: 'works_at', confidence: 0.9, evidence: 'valid rel' },
        { source_id: 'e1', target_id: 'e2', relationship_type: 'INVENTED_TYPE', confidence: 0.9, evidence: 'bad rel' },
      ],
      token_usage: { inputTokens: 100, outputTokens: 50 },
      processing_time_ms: 200,
      was_chunked: false,
    };

    const counts = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      resultWithBadRels, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Only the valid relationship should be stored
    expect(counts.totalEdges).toBe(1);
    expect(counts.totalEntities).toBe(2);
  });

  it.skipIf(!sqliteVecAvailable)('skips relationships with missing source/target ids', () => {
    const resultWithMissingRefs: JointExtractionResult = {
      entities: [
        { id: 'e1', canonical_name: 'Alice', type: 'person', aliases: [], confidence: 0.9 },
      ],
      relationships: [
        // e2 does not exist in entities
        { source_id: 'e1', target_id: 'e2', relationship_type: 'works_at', confidence: 0.9, evidence: 'bad ref' },
        { source_id: 'e99', target_id: 'e1', relationship_type: 'works_at', confidence: 0.9, evidence: 'bad source' },
      ],
      token_usage: { inputTokens: 100, outputTokens: 50 },
      processing_time_ms: 200,
      was_chunked: false,
    };

    const counts = storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      resultWithMissingRefs, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Both relationships should be skipped (missing node IDs)
    expect(counts.totalEdges).toBe(0);
    expect(counts.totalEntities).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('stores entity aliases in metadata JSON', () => {
    storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Dr. Robert Smith has alias "Dr. Smith"
    const entity = db.prepare(
      `SELECT metadata FROM entities WHERE document_id = ? AND raw_text = 'Dr. Robert Smith'`
    ).get(DOC_ID) as { metadata: string | null } | undefined;

    expect(entity).toBeDefined();
    expect(entity!.metadata).not.toBeNull();
    const meta = JSON.parse(entity!.metadata!);
    expect(meta.aliases).toContain('Dr. Smith');
  });

  it.skipIf(!sqliteVecAvailable)('normalizes entity text correctly', () => {
    storeJointExtractionResults(
      db, DOC_ID, OCR_RESULT_ID, SYNTHETIC_OCR_TEXT,
      syntheticResult, PROV_ENTITY_ID, PROV_KG_ID
    );

    // Person: lowercased
    const personEntity = db.prepare(
      `SELECT normalized_text FROM entities WHERE document_id = ? AND raw_text = 'Dr. Robert Smith'`
    ).get(DOC_ID) as { normalized_text: string } | undefined;
    expect(personEntity).toBeDefined();
    expect(personEntity!.normalized_text).toBe('dr. robert smith');

    // Medication: lowercased
    const medEntity = db.prepare(
      `SELECT normalized_text FROM entities WHERE document_id = ? AND raw_text = 'Metoprolol Tartrate'`
    ).get(DOC_ID) as { normalized_text: string } | undefined;
    expect(medEntity).toBeDefined();
    expect(medEntity!.normalized_text).toBe('metoprolol tartrate');

    // Date: normalized to YYYY-MM-DD
    const dateEntity = db.prepare(
      `SELECT normalized_text FROM entities WHERE document_id = ? AND entity_type = 'date'`
    ).get(DOC_ID) as { normalized_text: string } | undefined;
    expect(dateEntity).toBeDefined();
    expect(dateEntity!.normalized_text).toBe('2024-04-10');
  });
});
