/**
 * Integration Test: AI Knowledge Synthesis Pipeline
 *
 * End-to-end tests for the 3-tier AI synthesis pipeline:
 *   Tier 1: Corpus Intelligence (bird's eye view)
 *   Tier 2: Document Narratives + Relationship Inference
 *   Tier 3: Evidence Grounding + Entity Role Classification
 *
 * Uses a fresh database with synthetic medical data, mocked Gemini responses,
 * and verifies physical database state after each operation.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module tests/integration/synthesis-pipeline
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK SETUP - Must be before imports that use these modules
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mock Gemini client: deterministic responses for each synthesis stage.
 * The mock detects which prompt was sent and returns the appropriate JSON.
 */
const mockFastFn = vi.fn();
vi.mock('../../src/services/gemini/client.js', () => ({
  getSharedClient: () => ({
    fast: mockFastFn,
  }),
}));

vi.mock('../../src/services/gemini/config.js', () => ({
  loadGeminiConfig: () => ({ model: 'test-model', apiKey: 'test-key' }),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════════════════════════════

import { DatabaseService } from '../../src/services/storage/database/index.js';
import { computeHash } from '../../src/utils/hash.js';
import {
  insertEntity,
  insertEntityMention,
} from '../../src/services/storage/database/entity-operations.js';
import {
  insertKnowledgeNode,
  insertKnowledgeEdge,
  insertNodeEntityLink,
} from '../../src/services/storage/database/knowledge-graph-operations.js';
import {
  generateCorpusMap,
  generateDocumentNarrative,
  inferDocumentRelationships,
  classifyEntityRoles,
  groundEvidence,
  synthesizeDocument,
  synthesizeCorpus,
} from '../../src/services/knowledge-graph/synthesis-service.js';
import type {
  KnowledgeNode,
  KnowledgeEdge,
  NodeEntityLink,
  CorpusIntelligence,
  DocumentNarrative,
  EntityRole,
} from '../../src/models/knowledge-graph.js';
import type { Entity, EntityMention } from '../../src/models/entity.js';
import type Database from 'better-sqlite3';

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK GEMINI RESPONSE DATA (Medical Discharge Scenario)
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_CORPUS_MAP = {
  corpus_summary: 'Medical discharge documentation for Robert James Smith, a 62-year-old male with Type 2 Diabetes Mellitus, treated at Memorial General Hospital under the care of Dr. Sarah Chen.',
  key_actors: [
    { name: 'Robert James Smith', type: 'person', importance: 20, reason: 'Primary patient in discharge documentation' },
    { name: 'Dr. Sarah Chen', type: 'person', importance: 18, reason: 'Attending physician overseeing treatment' },
    { name: 'Memorial General Hospital', type: 'organization', importance: 15, reason: 'Primary treatment facility' },
    { name: 'Type 2 Diabetes Mellitus', type: 'diagnosis', importance: 14, reason: 'Primary diagnosis driving treatment plan' },
    { name: 'Metformin', type: 'medication', importance: 12, reason: 'Primary prescribed medication' },
  ],
  themes: [
    {
      name: 'Diabetes Management',
      core_entities: ['Robert James Smith', 'Type 2 Diabetes Mellitus', 'Metformin', 'Dr. Sarah Chen'],
      description: 'Ongoing management of Type 2 Diabetes through medication and lifestyle modifications',
    },
    {
      name: 'Hospital Care',
      core_entities: ['Memorial General Hospital', 'Dr. Sarah Chen', 'Robert James Smith'],
      description: 'Inpatient treatment and discharge planning at Memorial General Hospital',
    },
    {
      name: 'Follow-up Planning',
      core_entities: ['Dr. Sarah Chen', 'Robert James Smith', '2025-03-15'],
      description: 'Post-discharge follow-up scheduling and medication adjustments',
    },
  ],
  narrative_arcs: [
    {
      name: 'Treatment Timeline',
      entity_names: ['Robert James Smith', 'Dr. Sarah Chen', 'Memorial General Hospital'],
      description: 'Patient admission through discharge with treatment milestones',
      document_ids: [],
    },
  ],
};

const MOCK_NARRATIVE = {
  narrative_text: 'Robert James Smith, a 62-year-old male, was admitted to Memorial General Hospital on 2025-02-01 under the care of Dr. Sarah Chen for management of Type 2 Diabetes Mellitus. During his stay, Dr. Chen prescribed Metformin 500mg twice daily and ordered comprehensive metabolic panels. The patient responded well to treatment, with blood glucose levels stabilizing within target range. Discharge was planned for 2025-02-10, with a follow-up appointment scheduled with Dr. Chen on 2025-03-15.',
};

const MOCK_RELATIONSHIPS: Array<{
  source_entity: string; target_entity: string; relationship_type: string;
  confidence: number; evidence: string;
  temporal?: { from: string | null; until: string | null } | null;
}> = [
  {
    source_entity: 'Robert James Smith',
    target_entity: 'Type 2 Diabetes Mellitus',
    relationship_type: 'diagnosed_with',
    confidence: 0.95,
    evidence: 'Patient Robert James Smith was diagnosed with Type 2 Diabetes Mellitus as the primary condition.',
    temporal: { from: '2025-02-01T00:00:00Z', until: null },
  },
  {
    source_entity: 'Metformin',
    target_entity: 'Dr. Sarah Chen',
    relationship_type: 'prescribed_by',
    confidence: 0.90,
    evidence: 'Dr. Sarah Chen prescribed Metformin 500mg twice daily for diabetes management.',
  },
  {
    source_entity: 'Robert James Smith',
    target_entity: 'Memorial General Hospital',
    relationship_type: 'admitted_to',
    confidence: 0.92,
    evidence: 'Robert James Smith was admitted to Memorial General Hospital for inpatient treatment.',
    temporal: { from: '2025-02-01T00:00:00Z', until: '2025-02-10T00:00:00Z' },
  },
  {
    source_entity: 'Dr. Sarah Chen',
    target_entity: 'Memorial General Hospital',
    relationship_type: 'works_at',
    confidence: 0.88,
    evidence: 'Dr. Sarah Chen is the attending physician at Memorial General Hospital.',
  },
];

const MOCK_ENTITY_ROLES = [
  { entity_name: 'Robert James Smith', role: 'patient', theme: 'Diabetes Management', importance_rank: 1, context_summary: 'Primary patient receiving treatment for Type 2 Diabetes' },
  { entity_name: 'Dr. Sarah Chen', role: 'attending_physician', theme: 'Hospital Care', importance_rank: 2, context_summary: 'Lead physician overseeing patient care and prescriptions' },
  { entity_name: 'Memorial General Hospital', role: 'treatment_facility', theme: 'Hospital Care', importance_rank: 3, context_summary: 'Primary facility where patient was admitted and treated' },
  { entity_name: 'Type 2 Diabetes Mellitus', role: 'primary_diagnosis', theme: 'Diabetes Management', importance_rank: 4, context_summary: 'Primary medical condition requiring treatment' },
  { entity_name: 'Metformin', role: 'primary_medication', theme: 'Diabetes Management', importance_rank: 5, context_summary: 'Key medication prescribed for diabetes management' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ocr-synthesis-test-'));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

interface TestDataIds {
  docId: string;
  docProvId: string;
  ocrProvId: string;
  ocrResultId: string;
  entityExtProvId: string;
  chunkIds: string[];
  entityIds: string[];
  nodeIds: string[];
  edgeIds: string[];
  kgProvId: string;
}

/**
 * Configure the Gemini mock to return the right response based on prompt content.
 */
function setupGeminiMock(): void {
  mockFastFn.mockImplementation(async (prompt: string) => {
    // Detect which synthesis stage is calling by examining the prompt
    if (prompt.includes('Entity Census')) {
      return { text: JSON.stringify(MOCK_CORPUS_MAP), inputTokens: 200, outputTokens: 150 };
    }
    if (prompt.includes('Analyze document') && prompt.includes('narrative')) {
      return { text: JSON.stringify(MOCK_NARRATIVE), inputTokens: 300, outputTokens: 200 };
    }
    if (prompt.includes('Identify ALL meaningful relationships')) {
      return { text: JSON.stringify({ relationships: MOCK_RELATIONSHIPS }), inputTokens: 250, outputTokens: 180 };
    }
    if (prompt.includes('Cross-document relationship analysis')) {
      // Cross-document relationships: return empty for single-doc tests
      return { text: JSON.stringify({ relationships: [] }), inputTokens: 100, outputTokens: 20 };
    }
    if (prompt.includes('role') && prompt.includes('importance_rank')) {
      return { text: JSON.stringify({ roles: MOCK_ENTITY_ROLES }), inputTokens: 200, outputTokens: 150 };
    }
    // Fallback: return empty object
    return { text: '{}', inputTokens: 10, outputTokens: 10 };
  });
}

/**
 * Insert a full document chain with provenance, OCR, chunks, entities,
 * entity mentions, KG nodes, node-entity links, and KG edges.
 */
function insertTestData(conn: Database.Database, dbService: DatabaseService): TestDataIds {
  const now = new Date().toISOString();
  const docId = uuidv4();
  const docProvId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const entityExtProvId = uuidv4();
  const kgProvId = uuidv4();

  const fileName = 'discharge-summary-smith.pdf';
  const ocrText = `DISCHARGE SUMMARY\n\nPatient: Robert James Smith\nDOB: 1963-05-22\nAge: 62\nAdmission Date: 2025-02-01\nDischarge Date: 2025-02-10\n\nAttending Physician: Dr. Sarah Chen\nFacility: Memorial General Hospital\n\nPrimary Diagnosis: Type 2 Diabetes Mellitus\n\nMedications:\n- Metformin 500mg BID\n\nFollow-up: 2025-03-15 with Dr. Chen\n\nThe patient was admitted for management of uncontrolled Type 2 Diabetes. During hospitalization, blood glucose was brought under control with Metformin therapy. Patient tolerated medications well with no adverse effects noted.`;
  const fileHash = computeHash(fileName);

  // DOCUMENT provenance
  dbService.insertProvenance({
    id: docProvId, type: 'DOCUMENT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'FILE', source_path: `/test/${fileName}`, source_id: null,
    root_document_id: docProvId, location: null, content_hash: fileHash,
    input_hash: null, file_hash: fileHash, processor: 'test', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: null, processing_quality_score: null,
    parent_id: null, parent_ids: '[]', chain_depth: 0, chain_path: '["DOCUMENT"]',
  });

  // Document record
  dbService.insertDocument({
    id: docId, file_path: `/test/${fileName}`, file_name: fileName,
    file_hash: fileHash, file_size: ocrText.length, file_type: 'pdf',
    status: 'complete', page_count: 1, provenance_id: docProvId,
    error_message: null, ocr_completed_at: now,
  });

  // OCR_RESULT provenance
  dbService.insertProvenance({
    id: ocrProvId, type: 'OCR_RESULT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'OCR', source_path: null, source_id: docProvId,
    root_document_id: docProvId, location: null, content_hash: computeHash(ocrText),
    input_hash: null, file_hash: null, processor: 'datalab-marker',
    processor_version: '1.0.0', processing_params: { mode: 'balanced' },
    processing_duration_ms: 1000, processing_quality_score: 4.5,
    parent_id: docProvId, parent_ids: JSON.stringify([docProvId]), chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  // OCR result
  dbService.insertOCRResult({
    id: ocrResultId, provenance_id: ocrProvId, document_id: docId,
    extracted_text: ocrText, text_length: ocrText.length,
    datalab_request_id: `req-${ocrResultId}`, datalab_mode: 'balanced',
    parse_quality_score: 4.5, page_count: 1, cost_cents: 5,
    processing_duration_ms: 1000, processing_started_at: now,
    processing_completed_at: now, json_blocks: null, content_hash: computeHash(ocrText),
    extras_json: null,
  });

  // Create 2 chunks
  const chunkIds: string[] = [];
  const chunkTexts = [
    `DISCHARGE SUMMARY Patient: Robert James Smith DOB: 1963-05-22 Age: 62 Admission Date: 2025-02-01 Discharge Date: 2025-02-10 Attending Physician: Dr. Sarah Chen Facility: Memorial General Hospital`,
    `Primary Diagnosis: Type 2 Diabetes Mellitus Medications: Metformin 500mg BID Follow-up: 2025-03-15 with Dr. Chen The patient was admitted for management of uncontrolled Type 2 Diabetes. During hospitalization, blood glucose was brought under control with Metformin therapy.`,
  ];

  for (let ci = 0; ci < chunkTexts.length; ci++) {
    const chunkId = uuidv4();
    const chunkProvId = uuidv4();
    const chunkText = chunkTexts[ci];

    dbService.insertProvenance({
      id: chunkProvId, type: 'CHUNK', created_at: now, processed_at: now,
      source_file_created_at: null, source_file_modified_at: null,
      source_type: 'CHUNKING', source_path: null, source_id: ocrProvId,
      root_document_id: docProvId, location: null, content_hash: computeHash(chunkText),
      input_hash: null, file_hash: null, processor: 'chunker',
      processor_version: '1.0.0', processing_params: {},
      processing_duration_ms: 10, processing_quality_score: null,
      parent_id: ocrProvId, parent_ids: JSON.stringify([docProvId, ocrProvId]),
      chain_depth: 2, chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
    });

    dbService.insertChunk({
      id: chunkId, document_id: docId, ocr_result_id: ocrResultId,
      text: chunkText, text_hash: computeHash(chunkText), chunk_index: ci,
      character_start: ci * 250, character_end: (ci + 1) * 250,
      page_number: 1, page_range: null, overlap_previous: 0, overlap_next: 0,
      provenance_id: chunkProvId,
    });

    chunkIds.push(chunkId);
  }

  // ENTITY_EXTRACTION provenance
  dbService.insertProvenance({
    id: entityExtProvId, type: 'ENTITY_EXTRACTION', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION', source_path: null, source_id: ocrProvId,
    root_document_id: docProvId, location: null,
    content_hash: computeHash(`entities-${docId}`), input_hash: null, file_hash: null,
    processor: 'gemini-entity-extractor', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: 2000, processing_quality_score: null,
    parent_id: ocrProvId, parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2, chain_path: '["DOCUMENT", "OCR_RESULT", "ENTITY_EXTRACTION"]',
  });

  // KNOWLEDGE_GRAPH provenance (for nodes/edges)
  dbService.insertProvenance({
    id: kgProvId, type: 'KNOWLEDGE_GRAPH', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'KNOWLEDGE_GRAPH', source_path: null, source_id: ocrProvId,
    root_document_id: docProvId, location: null,
    content_hash: computeHash(`kg-${docId}`), input_hash: null, file_hash: null,
    processor: 'kg-builder', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: 500, processing_quality_score: null,
    parent_id: ocrProvId, parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2, chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
  });

  // Define entities (matching medical discharge scenario)
  const entitiesData = [
    { type: 'person', raw: 'Robert James Smith', normalized: 'robert james smith', conf: 0.95 },
    { type: 'person', raw: 'Dr. Sarah Chen', normalized: 'dr. sarah chen', conf: 0.93 },
    { type: 'organization', raw: 'Memorial General Hospital', normalized: 'memorial general hospital', conf: 0.92 },
    { type: 'diagnosis', raw: 'Type 2 Diabetes Mellitus', normalized: 'type 2 diabetes mellitus', conf: 0.96 },
    { type: 'medication', raw: 'Metformin', normalized: 'metformin', conf: 0.94 },
    { type: 'date', raw: '2025-02-01', normalized: '2025-02-01', conf: 0.99 },
    { type: 'date', raw: '2025-02-10', normalized: '2025-02-10', conf: 0.99 },
    { type: 'date', raw: '2025-03-15', normalized: '2025-03-15', conf: 0.98 },
  ];

  // Insert entities
  const entityIds: string[] = [];
  for (let ei = 0; ei < entitiesData.length; ei++) {
    const ent = entitiesData[ei];
    const entityId = uuidv4();
    insertEntity(conn, {
      id: entityId, document_id: docId,
      entity_type: ent.type as Entity['entity_type'],
      raw_text: ent.raw, normalized_text: ent.normalized,
      confidence: ent.conf, metadata: null,
      provenance_id: entityExtProvId, created_at: now,
    });

    // Entity mention linked to a chunk (alternating chunks for co-location testing)
    insertEntityMention(conn, {
      id: uuidv4(), entity_id: entityId, document_id: docId,
      chunk_id: chunkIds[ei % chunkIds.length],
      page_number: 1, character_start: ei * 30,
      character_end: (ei + 1) * 30,
      context_text: `...${ent.raw}...`, created_at: now,
    });

    entityIds.push(entityId);
  }

  // Create KG nodes (one per entity)
  const nodeIds: string[] = [];
  for (let ni = 0; ni < entitiesData.length; ni++) {
    const ent = entitiesData[ni];
    const nodeId = uuidv4();
    const node: KnowledgeNode = {
      id: nodeId, entity_type: ent.type as KnowledgeNode['entity_type'],
      canonical_name: ent.raw, normalized_name: ent.normalized,
      aliases: null, document_count: 1, mention_count: 1, edge_count: 0,
      avg_confidence: ent.conf, importance_score: 0.5 + (ni * 0.05),
      metadata: null, provenance_id: kgProvId, created_at: now, updated_at: now,
    };
    insertKnowledgeNode(conn, node);

    // Link node to entity
    const link: NodeEntityLink = {
      id: uuidv4(), node_id: nodeId, entity_id: entityIds[ni],
      document_id: docId, similarity_score: 1.0,
      resolution_method: 'exact', created_at: now,
    };
    insertNodeEntityLink(conn, link);

    nodeIds.push(nodeId);
  }

  // Create a few KG edges (co_mentioned between key entities)
  const edgeIds: string[] = [];
  const edgePairs = [
    [0, 1, 'co_mentioned'],  // Smith <-> Dr. Chen
    [0, 2, 'co_mentioned'],  // Smith <-> Hospital
    [0, 3, 'co_mentioned'],  // Smith <-> Diabetes
    [1, 4, 'co_mentioned'],  // Dr. Chen <-> Metformin
  ];
  for (const [srcIdx, tgtIdx, relType] of edgePairs) {
    const edgeId = uuidv4();
    const edge: KnowledgeEdge = {
      id: edgeId, source_node_id: nodeIds[srcIdx as number],
      target_node_id: nodeIds[tgtIdx as number],
      relationship_type: relType as KnowledgeEdge['relationship_type'],
      weight: 0.7, evidence_count: 1,
      document_ids: JSON.stringify([docId]),
      metadata: null, provenance_id: kgProvId,
      created_at: now,
    };
    insertKnowledgeEdge(conn, edge);
    edgeIds.push(edgeId);
  }

  return { docId, docProvId, ocrProvId, ocrResultId, entityExtProvId, chunkIds, entityIds, nodeIds, edgeIds, kgProvId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('AI Knowledge Synthesis Pipeline - Integration Tests', () => {
  let tempDir: string;
  let dbService: DatabaseService;
  let conn: Database.Database;
  let testData: TestDataIds;
  const tempDirs: string[] = [];

  beforeAll(() => {
    setupGeminiMock();
  });

  beforeEach(() => {
    tempDir = createTempDir();
    tempDirs.push(tempDir);
    const dbName = `synthesis-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbService = DatabaseService.create(dbName, undefined, tempDir);
    conn = dbService.getConnection();
    testData = insertTestData(conn, dbService);
    mockFastFn.mockClear();
    setupGeminiMock();
  });

  afterEach(() => {
    try { dbService.close(); } catch { /* ignore */ }
  });

  afterAll(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // PRECONDITION CHECKS
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Preconditions: Synthetic data is properly inserted', () => {
    it('should have 1 document', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
      expect(row.cnt).toBe(1);
    });

    it('should have 1 OCR result', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM ocr_results').get() as { cnt: number };
      expect(row.cnt).toBe(1);
    });

    it('should have 2 chunks', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
      expect(row.cnt).toBe(2);
    });

    it('should have 8 entities', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number };
      expect(row.cnt).toBe(8);
    });

    it('should have 8 entity mentions linked to chunks', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM entity_mentions WHERE chunk_id IS NOT NULL').get() as { cnt: number };
      expect(row.cnt).toBe(8);
    });

    it('should have 8 knowledge nodes', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number };
      expect(row.cnt).toBe(8);
    });

    it('should have 8 node-entity links', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as { cnt: number };
      expect(row.cnt).toBe(8);
    });

    it('should have 4 knowledge edges', () => {
      const row = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number };
      expect(row.cnt).toBe(4);
    });

    it('should have empty synthesis tables initially', () => {
      const ci = conn.prepare('SELECT COUNT(*) as cnt FROM corpus_intelligence').get() as { cnt: number };
      const dn = conn.prepare('SELECT COUNT(*) as cnt FROM document_narratives').get() as { cnt: number };
      const er = conn.prepare('SELECT COUNT(*) as cnt FROM entity_roles').get() as { cnt: number };
      expect(ci.cnt).toBe(0);
      expect(dn.cnt).toBe(0);
      expect(er.cnt).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // TIER 1: CORPUS INTELLIGENCE
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Tier 1: generateCorpusMap', () => {
    it('should create a corpus intelligence record with correct fields', async () => {
      const result = await generateCorpusMap(conn, 'test-db');

      // Verify return value
      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.database_name).toBe('test-db');
      expect(result.corpus_summary).toBe(MOCK_CORPUS_MAP.corpus_summary);
      expect(result.entity_count).toBe(8);
      expect(result.document_count).toBe(1);
      expect(result.model).toBe('test-model');

      // Verify physical DB row
      const row = conn.prepare('SELECT * FROM corpus_intelligence WHERE database_name = ?').get('test-db') as CorpusIntelligence | undefined;
      expect(row).toBeDefined();
      expect(row!.corpus_summary).toBe(MOCK_CORPUS_MAP.corpus_summary);
      expect(row!.entity_count).toBe(8);
      expect(row!.document_count).toBe(1);

      // Verify JSON fields parse correctly
      const keyActors = JSON.parse(row!.key_actors);
      expect(keyActors).toHaveLength(5);
      expect(keyActors[0].name).toBe('Robert James Smith');

      const themes = JSON.parse(row!.themes);
      expect(themes).toHaveLength(3);
      expect(themes[0].name).toBe('Diabetes Management');

      const arcs = JSON.parse(row!.narrative_arcs!);
      expect(arcs).toHaveLength(1);
      expect(arcs[0].name).toBe('Treatment Timeline');
    });

    it('should create a provenance record for the corpus map', async () => {
      const result = await generateCorpusMap(conn, 'test-db');

      const prov = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(result.provenance_id) as { type: string; processor: string; chain_depth: number } | undefined;
      expect(prov).toBeDefined();
      expect(prov!.type).toBe('CORPUS_INTELLIGENCE');
      expect(prov!.processor).toBe('synthesis-service');
      expect(prov!.chain_depth).toBe(2);
    });

    it('should return cached result on second call without force', async () => {
      const result1 = await generateCorpusMap(conn, 'test-db');
      mockFastFn.mockClear();

      const result2 = await generateCorpusMap(conn, 'test-db');
      expect(result2.id).toBe(result1.id);
      // Should NOT have called Gemini again
      expect(mockFastFn).not.toHaveBeenCalled();
    });

    it('should regenerate when force=true', async () => {
      const result1 = await generateCorpusMap(conn, 'test-db');
      mockFastFn.mockClear();
      setupGeminiMock();

      const result2 = await generateCorpusMap(conn, 'test-db', true);
      expect(result2.id).not.toBe(result1.id);
      expect(mockFastFn).toHaveBeenCalled();

      // Old row should be deleted, only one row should exist
      const rows = conn.prepare('SELECT COUNT(*) as cnt FROM corpus_intelligence WHERE database_name = ?').get('test-db') as { cnt: number };
      expect(rows.cnt).toBe(1);
    });

    it('should throw when no KG nodes exist', async () => {
      // Create an empty database
      const emptyTempDir = createTempDir();
      tempDirs.push(emptyTempDir);
      const emptyDb = DatabaseService.create(`empty-${Date.now()}`, undefined, emptyTempDir);
      const emptyConn = emptyDb.getConnection();

      try {
        await expect(generateCorpusMap(emptyConn, 'empty-db')).rejects.toThrow('No KG nodes found');
      } finally {
        emptyDb.close();
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // TIER 2: DOCUMENT NARRATIVES
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Tier 2: generateDocumentNarrative', () => {
    it('should create a document narrative with correct fields', async () => {
      const result = await generateDocumentNarrative(conn, testData.docId);

      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.document_id).toBe(testData.docId);
      expect(result.narrative_text).toBe(MOCK_NARRATIVE.narrative_text);
      expect(result.model).toBe('test-model');
      expect(result.synthesis_count).toBe(0);

      // Verify physical DB row
      const row = conn.prepare('SELECT * FROM document_narratives WHERE document_id = ?').get(testData.docId) as DocumentNarrative | undefined;
      expect(row).toBeDefined();
      expect(row!.narrative_text).toBe(MOCK_NARRATIVE.narrative_text);
      expect(row!.document_id).toBe(testData.docId);

      // Verify entity_roster is valid JSON with correct entities
      const roster = JSON.parse(row!.entity_roster);
      expect(Array.isArray(roster)).toBe(true);
      expect(roster.length).toBeGreaterThan(0);
      const rosterNames = roster.map((r: { name: string }) => r.name);
      expect(rosterNames).toContain('Robert James Smith');
    });

    it('should create a provenance record for the narrative', async () => {
      const result = await generateDocumentNarrative(conn, testData.docId);

      const prov = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(result.provenance_id) as { type: string; root_document_id: string } | undefined;
      expect(prov).toBeDefined();
      expect(prov!.type).toBe('CORPUS_INTELLIGENCE');
      expect(prov!.root_document_id).toBe(testData.docId);
    });

    it('should return cached narrative on second call', async () => {
      const result1 = await generateDocumentNarrative(conn, testData.docId);
      mockFastFn.mockClear();

      const result2 = await generateDocumentNarrative(conn, testData.docId);
      expect(result2.id).toBe(result1.id);
      expect(mockFastFn).not.toHaveBeenCalled();
    });

    it('should throw for non-existent document_id', async () => {
      await expect(generateDocumentNarrative(conn, 'non-existent-doc-id')).rejects.toThrow('Document not found');
    });

    it('should include corpus context when provided', async () => {
      const corpus = await generateCorpusMap(conn, 'test-db');
      mockFastFn.mockClear();
      setupGeminiMock();

      const result = await generateDocumentNarrative(conn, testData.docId, corpus);
      expect(result.corpus_context).toBeDefined();

      const ctx = JSON.parse(result.corpus_context!);
      expect(ctx.summary).toBe(MOCK_CORPUS_MAP.corpus_summary);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // TIER 2: RELATIONSHIP INFERENCE
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Tier 2: inferDocumentRelationships', () => {
    it('should create inferred edges in the database', async () => {
      const narrative = await generateDocumentNarrative(conn, testData.docId);
      mockFastFn.mockClear();
      setupGeminiMock();

      const edgesBefore = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }).cnt;
      const edges = await inferDocumentRelationships(conn, testData.docId, narrative);

      expect(edges.length).toBeGreaterThan(0);

      // Verify physical DB: more edges than before
      const edgesAfter = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }).cnt;
      expect(edgesAfter).toBeGreaterThan(edgesBefore);

      // Verify each new edge has ai_synthesis metadata
      for (const edge of edges) {
        const row = conn.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get(edge.id) as KnowledgeEdge | undefined;
        expect(row).toBeDefined();
        const meta = JSON.parse(row!.metadata!);
        expect(meta.source).toBe('ai_synthesis');
        expect(meta.synthesis_level).toBe('document');
        expect(meta.evidence_summary).toBeTruthy();
        expect(meta.model).toBe('test-model');
      }
    });

    it('should create edges with correct relationship types from mock data', async () => {
      const narrative = await generateDocumentNarrative(conn, testData.docId);
      mockFastFn.mockClear();
      setupGeminiMock();

      const edges = await inferDocumentRelationships(conn, testData.docId, narrative);

      const relTypes = edges.map(e => e.relationship_type);
      // Check for at least some of the expected relationship types
      const expectedTypes = ['diagnosed_with', 'prescribed_by', 'admitted_to', 'works_at'];
      for (const expected of expectedTypes) {
        expect(relTypes).toContain(expected);
      }
    });

    it('should set temporal bounds on edges that have them', async () => {
      const narrative = await generateDocumentNarrative(conn, testData.docId);
      mockFastFn.mockClear();
      setupGeminiMock();

      const edges = await inferDocumentRelationships(conn, testData.docId, narrative);

      // diagnosed_with should have temporal from the mock
      const diagEdge = edges.find(e => e.relationship_type === 'diagnosed_with');
      if (diagEdge) {
        const row = conn.prepare('SELECT valid_from, valid_until FROM knowledge_edges WHERE id = ?').get(diagEdge.id) as { valid_from: string | null; valid_until: string | null } | undefined;
        expect(row).toBeDefined();
        expect(row!.valid_from).toBe('2025-02-01T00:00:00Z');
      }

      // admitted_to should have both from and until
      const admitEdge = edges.find(e => e.relationship_type === 'admitted_to');
      if (admitEdge) {
        const row = conn.prepare('SELECT valid_from, valid_until FROM knowledge_edges WHERE id = ?').get(admitEdge.id) as { valid_from: string | null; valid_until: string | null } | undefined;
        expect(row).toBeDefined();
        expect(row!.valid_from).toBe('2025-02-01T00:00:00Z');
        expect(row!.valid_until).toBe('2025-02-10T00:00:00Z');
      }
    });

    it('should update synthesis_count on the narrative', async () => {
      const narrative = await generateDocumentNarrative(conn, testData.docId);
      const edges = await inferDocumentRelationships(conn, testData.docId, narrative);

      if (edges.length > 0) {
        const updatedNarr = conn.prepare('SELECT synthesis_count FROM document_narratives WHERE id = ?').get(narrative.id) as { synthesis_count: number } | undefined;
        expect(updatedNarr).toBeDefined();
        expect(updatedNarr!.synthesis_count).toBe(edges.length);
      }
    });

    it('should return empty array when document has fewer than 2 entities', async () => {
      // Create a minimal document with only 1 entity linked in KG
      const minTempDir = createTempDir();
      tempDirs.push(minTempDir);
      const minDb = DatabaseService.create(`min-${Date.now()}`, undefined, minTempDir);
      const minConn = minDb.getConnection();
      const minData = insertMinimalDocWithOneEntity(minConn, minDb);

      try {
        const narrative: DocumentNarrative = {
          id: uuidv4(), document_id: minData.docId,
          narrative_text: 'Single entity document.', entity_roster: '[]',
          corpus_context: null, synthesis_count: 0, model: 'test-model',
          provenance_id: minData.provId, created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        const edges = await inferDocumentRelationships(minConn, minData.docId, narrative);
        expect(edges).toHaveLength(0);
      } finally {
        minDb.close();
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // ENTITY ROLE CLASSIFICATION
  // ═════════════════════════════════════════════════════════════════════════════

  describe('classifyEntityRoles', () => {
    it('should create entity roles in the database (document scope)', async () => {
      const roles = await classifyEntityRoles(conn, 'test-db', 'document', testData.docId);

      expect(roles.length).toBeGreaterThan(0);

      // Verify physical DB rows
      const dbRows = conn.prepare('SELECT * FROM entity_roles WHERE scope = ? AND scope_id = ?').all('document', testData.docId) as EntityRole[];
      expect(dbRows.length).toBe(roles.length);

      // Verify each role has correct fields
      for (const role of dbRows) {
        expect(role.node_id).toBeTruthy();
        expect(role.role).toBeTruthy();
        expect(role.scope).toBe('document');
        expect(role.scope_id).toBe(testData.docId);
        expect(role.model).toBe('test-model');
        expect(role.provenance_id).toBeTruthy();
      }
    });

    it('should create entity roles in the database (database scope)', async () => {
      const roles = await classifyEntityRoles(conn, 'test-db', 'database');

      expect(roles.length).toBeGreaterThan(0);

      const dbRows = conn.prepare('SELECT * FROM entity_roles WHERE scope = ?').all('database') as EntityRole[];
      expect(dbRows.length).toBe(roles.length);
    });

    it('should assign correct roles matching the mock data', async () => {
      const roles = await classifyEntityRoles(conn, 'test-db', 'document', testData.docId);

      // Map node IDs back to names for verification
      const rolesByName = new Map<string, EntityRole>();
      for (const r of roles) {
        const node = conn.prepare('SELECT canonical_name FROM knowledge_nodes WHERE id = ?').get(r.node_id) as { canonical_name: string } | undefined;
        if (node) rolesByName.set(node.canonical_name, r);
      }

      // Verify key roles
      const smithRole = rolesByName.get('Robert James Smith');
      if (smithRole) {
        expect(smithRole.role).toBe('patient');
        expect(smithRole.importance_rank).toBe(1);
      }

      const chenRole = rolesByName.get('Dr. Sarah Chen');
      if (chenRole) {
        expect(chenRole.role).toBe('attending_physician');
      }
    });

    it('should delete old roles before re-classification (same scope)', async () => {
      // First classification
      await classifyEntityRoles(conn, 'test-db', 'document', testData.docId);
      const countBefore = (conn.prepare('SELECT COUNT(*) as cnt FROM entity_roles WHERE scope = ? AND scope_id = ?').get('document', testData.docId) as { cnt: number }).cnt;

      // Second classification (should replace, not accumulate)
      mockFastFn.mockClear();
      setupGeminiMock();
      await classifyEntityRoles(conn, 'test-db', 'document', testData.docId);
      const countAfter = (conn.prepare('SELECT COUNT(*) as cnt FROM entity_roles WHERE scope = ? AND scope_id = ?').get('document', testData.docId) as { cnt: number }).cnt;

      expect(countAfter).toBe(countBefore);
    });

    it('should return empty array when no entities exist', async () => {
      const emptyTempDir = createTempDir();
      tempDirs.push(emptyTempDir);
      const emptyDb = DatabaseService.create(`empty-roles-${Date.now()}`, undefined, emptyTempDir);
      const emptyConn = emptyDb.getConnection();

      try {
        const roles = await classifyEntityRoles(emptyConn, 'empty-db', 'database');
        expect(roles).toHaveLength(0);

        // Verify no DB rows
        const row = emptyConn.prepare('SELECT COUNT(*) as cnt FROM entity_roles').get() as { cnt: number };
        expect(row.cnt).toBe(0);
      } finally {
        emptyDb.close();
      }
    });

    it('should create provenance record for role classification', async () => {
      const roles = await classifyEntityRoles(conn, 'test-db', 'document', testData.docId);

      if (roles.length > 0) {
        const prov = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(roles[0].provenance_id) as { type: string; processor: string } | undefined;
        expect(prov).toBeDefined();
        expect(prov!.type).toBe('CORPUS_INTELLIGENCE');
        expect(prov!.processor).toBe('synthesis-service');
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // TIER 3: EVIDENCE GROUNDING
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Tier 3: groundEvidence', () => {
    it('should link synthesized edges to evidence chunks', async () => {
      // First create synthesized edges
      const narrative = await generateDocumentNarrative(conn, testData.docId);
      const inferredEdges = await inferDocumentRelationships(conn, testData.docId, narrative);

      // Now ground the evidence
      const result = groundEvidence(conn, testData.docId);

      expect(result).toBeDefined();
      expect(typeof result.boosted).toBe('number');
      expect(typeof result.linked).toBe('number');

      // Verify edges with ai_synthesis metadata now have evidence_grounded flag
      if (result.linked > 0) {
        const groundedEdges = conn.prepare(
          `SELECT * FROM knowledge_edges WHERE metadata LIKE '%"evidence_grounded":true%'`
        ).all() as KnowledgeEdge[];
        expect(groundedEdges.length).toBeGreaterThan(0);

        for (const edge of groundedEdges) {
          const meta = JSON.parse(edge.metadata!);
          expect(meta.evidence_grounded).toBe(true);
          expect(meta.grounded_at).toBeTruthy();
          if (meta.evidence_chunks) {
            expect(Array.isArray(meta.evidence_chunks)).toBe(true);
          }
        }
      }
    });

    it('should return zeros when no ai_synthesis edges exist', () => {
      const result = groundEvidence(conn, testData.docId);
      expect(result.boosted).toBe(0);
      expect(result.linked).toBe(0);
    });

    it('should boost edge weights when evidence is found', async () => {
      const narrative = await generateDocumentNarrative(conn, testData.docId);
      await inferDocumentRelationships(conn, testData.docId, narrative);

      const result = groundEvidence(conn, testData.docId);

      if (result.boosted > 0) {
        // Check that at least one edge had its weight increased
        const boostedEdges = conn.prepare(
          `SELECT weight FROM knowledge_edges WHERE metadata LIKE '%"evidence_grounded":true%' AND weight > 0.5`
        ).all() as { weight: number }[];
        expect(boostedEdges.length).toBeGreaterThan(0);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // ORCHESTRATOR: synthesizeDocument
  // ═════════════════════════════════════════════════════════════════════════════

  describe('synthesizeDocument (full pipeline)', () => {
    it('should run the complete synthesis pipeline and populate all tables', async () => {
      const result = await synthesizeDocument(conn, testData.docId, { databaseName: 'test-db' });

      // Verify return structure
      expect(result.narrative).toBeDefined();
      expect(result.narrative.document_id).toBe(testData.docId);
      expect(typeof result.edges_created).toBe('number');
      expect(typeof result.evidence_grounded.boosted).toBe('number');
      expect(typeof result.evidence_grounded.linked).toBe('number');
      expect(typeof result.roles_assigned).toBe('number');

      // Verify corpus_intelligence table has a row
      const ciCount = (conn.prepare('SELECT COUNT(*) as cnt FROM corpus_intelligence').get() as { cnt: number }).cnt;
      expect(ciCount).toBeGreaterThanOrEqual(1);

      // Verify document_narratives table has a row
      const dnRow = conn.prepare('SELECT * FROM document_narratives WHERE document_id = ?').get(testData.docId) as DocumentNarrative | undefined;
      expect(dnRow).toBeDefined();
      expect(dnRow!.narrative_text).toBeTruthy();

      // Verify entity_roles table has rows
      const erCount = (conn.prepare('SELECT COUNT(*) as cnt FROM entity_roles WHERE scope_id = ?').get(testData.docId) as { cnt: number }).cnt;
      expect(erCount).toBeGreaterThan(0);

      // Verify synthesized edges have evidence_summary in metadata
      const synthEdges = conn.prepare(
        `SELECT * FROM knowledge_edges WHERE metadata LIKE '%"source":"ai_synthesis"%'`
      ).all() as KnowledgeEdge[];
      for (const edge of synthEdges) {
        const meta = JSON.parse(edge.metadata!);
        expect(meta.evidence_summary).toBeTruthy();
        expect(meta.model).toBe('test-model');
      }
    });

    it('should handle force_narrative option', async () => {
      // First synthesis
      const result1 = await synthesizeDocument(conn, testData.docId, { databaseName: 'test-db' });
      const narrativeId1 = result1.narrative.id;

      // Force re-synthesis
      mockFastFn.mockClear();
      setupGeminiMock();
      const result2 = await synthesizeDocument(conn, testData.docId, {
        databaseName: 'test-db',
        force_narrative: true,
      });

      // New narrative should be different
      expect(result2.narrative.id).not.toBe(narrativeId1);

      // Only one narrative row should exist (old deleted)
      const narrCount = (conn.prepare('SELECT COUNT(*) as cnt FROM document_narratives WHERE document_id = ?').get(testData.docId) as { cnt: number }).cnt;
      expect(narrCount).toBe(1);
    });

    it('should handle non-existent document_id gracefully', async () => {
      await expect(
        synthesizeDocument(conn, 'non-existent-doc-id', { databaseName: 'test-db' })
      ).rejects.toThrow();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // ORCHESTRATOR: synthesizeCorpus
  // ═════════════════════════════════════════════════════════════════════════════

  describe('synthesizeCorpus (full corpus pipeline)', () => {
    it('should synthesize the entire corpus and return comprehensive results', async () => {
      const result = await synthesizeCorpus(conn, 'test-db');

      expect(result).toBeDefined();
      expect(result.corpus_intelligence).toBeDefined();
      expect(result.corpus_intelligence.corpus_summary).toBeTruthy();
      expect(result.documents_synthesized).toBe(1);
      expect(typeof result.total_edges_created).toBe('number');
      expect(typeof result.cross_document_edges).toBe('number');
      expect(typeof result.total_evidence_grounded.boosted).toBe('number');
      expect(typeof result.corpus_roles_assigned).toBe('number');

      // Verify corpus_intelligence in DB
      const ciRow = conn.prepare('SELECT * FROM corpus_intelligence WHERE database_name = ?').get('test-db') as CorpusIntelligence | undefined;
      expect(ciRow).toBeDefined();

      // Verify document narrative exists
      const dnRow = conn.prepare('SELECT * FROM document_narratives WHERE document_id = ?').get(testData.docId) as DocumentNarrative | undefined;
      expect(dnRow).toBeDefined();

      // Verify corpus-level entity roles exist
      const dbRoles = conn.prepare('SELECT COUNT(*) as cnt FROM entity_roles WHERE scope = ?').get('database') as { cnt: number };
      expect(dbRoles.cnt).toBeGreaterThan(0);
    });

    it('should handle force option for re-synthesis', async () => {
      await synthesizeCorpus(conn, 'test-db');

      // Force re-synthesis
      mockFastFn.mockClear();
      setupGeminiMock();
      const result2 = await synthesizeCorpus(conn, 'test-db', { force: true });

      expect(result2.documents_synthesized).toBe(1);
      // Gemini should have been called again
      expect(mockFastFn).toHaveBeenCalled();
    });

    it('should handle empty corpus (no documents with entities)', async () => {
      const emptyTempDir = createTempDir();
      tempDirs.push(emptyTempDir);
      const emptyDb = DatabaseService.create(`empty-corpus-${Date.now()}`, undefined, emptyTempDir);
      const emptyConn = emptyDb.getConnection();

      try {
        await expect(synthesizeCorpus(emptyConn, 'empty-db')).rejects.toThrow('No KG nodes found');
      } finally {
        emptyDb.close();
      }
    });

    it('should handle document_filter to synthesize subset', async () => {
      const result = await synthesizeCorpus(conn, 'test-db', { document_filter: [testData.docId] });
      expect(result.documents_synthesized).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('should handle Gemini returning markdown-wrapped JSON', async () => {
      mockFastFn.mockImplementationOnce(async () => ({
        text: '```json\n' + JSON.stringify(MOCK_CORPUS_MAP) + '\n```',
        inputTokens: 200,
        outputTokens: 150,
      }));

      const result = await generateCorpusMap(conn, 'test-db');
      expect(result.corpus_summary).toBe(MOCK_CORPUS_MAP.corpus_summary);
    });

    it('should throw on invalid Gemini JSON response', async () => {
      mockFastFn.mockImplementationOnce(async () => ({
        text: 'This is not valid JSON at all',
        inputTokens: 10,
        outputTokens: 10,
      }));

      await expect(generateCorpusMap(conn, 'test-db')).rejects.toThrow(/Failed to parse Gemini response/);
    });

    it('should skip unresolved entities in relationship inference', async () => {
      // Mock relationships with unknown entity names
      mockFastFn.mockImplementation(async (prompt: string) => {
        if (prompt.includes('Analyze document') && prompt.includes('narrative')) {
          return { text: JSON.stringify(MOCK_NARRATIVE), inputTokens: 100, outputTokens: 50 };
        }
        if (prompt.includes('Identify ALL meaningful relationships')) {
          return {
            text: JSON.stringify({ relationships: [{
              source_entity: 'Unknown Person XYZ',
              target_entity: 'Robert James Smith',
              relationship_type: 'related_to',
              confidence: 0.5,
              evidence: 'test evidence',
            }] }),
            inputTokens: 100,
            outputTokens: 50,
          };
        }
        // Fallback
        return { text: '{}', inputTokens: 10, outputTokens: 10 };
      });

      const narrative = await generateDocumentNarrative(conn, testData.docId);

      // Delete the cached narrative so we can use the fresh mock
      conn.prepare('DELETE FROM document_narratives').run();
      mockFastFn.mockClear();

      // Re-setup with the unresolved entity mock
      mockFastFn.mockImplementation(async (prompt: string) => {
        if (prompt.includes('Analyze document') && prompt.includes('narrative')) {
          return { text: JSON.stringify(MOCK_NARRATIVE), inputTokens: 100, outputTokens: 50 };
        }
        if (prompt.includes('Identify ALL meaningful relationships')) {
          return {
            text: JSON.stringify({ relationships: [{
              source_entity: 'Unknown Person XYZ',
              target_entity: 'Robert James Smith',
              relationship_type: 'related_to',
              confidence: 0.5,
              evidence: 'test evidence',
            }] }),
            inputTokens: 100,
            outputTokens: 50,
          };
        }
        return { text: '{}', inputTokens: 10, outputTokens: 10 };
      });

      const newNarrative = await generateDocumentNarrative(conn, testData.docId);
      const edges = await inferDocumentRelationships(conn, testData.docId, newNarrative);

      // Should return 0 edges because "Unknown Person XYZ" cannot be resolved
      expect(edges).toHaveLength(0);
    });

    it('should not create duplicate edges on repeated inference', async () => {
      const narrative = await generateDocumentNarrative(conn, testData.docId);

      const edges1 = await inferDocumentRelationships(conn, testData.docId, narrative);
      mockFastFn.mockClear();
      setupGeminiMock();

      const edges2 = await inferDocumentRelationships(conn, testData.docId, narrative);

      // Second call should return fewer or zero edges (duplicates skipped by findEdge)
      expect(edges2.length).toBeLessThanOrEqual(edges1.length);

      // Total unique edges should not be doubled
      const totalEdges = conn.prepare(
        `SELECT COUNT(*) as cnt FROM knowledge_edges WHERE metadata LIKE '%"source":"ai_synthesis"%'`
      ).all() as { cnt: number }[];
      expect(totalEdges[0].cnt).toBe(edges1.length);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // MCP TOOL HANDLERS
  // ═════════════════════════════════════════════════════════════════════════════

  describe('MCP Tool Handler Registration', () => {
    it('should verify tool definitions exist', async () => {
      // Dynamic import to avoid issues with the mocked modules
      const { knowledgeGraphTools } = await import('../../src/tools/knowledge-graph.js');

      expect(knowledgeGraphTools.ocr_knowledge_graph_synthesize).toBeDefined();
      expect(knowledgeGraphTools.ocr_knowledge_graph_synthesize.description).toContain('AI synthesis');
      expect(knowledgeGraphTools.ocr_knowledge_graph_synthesize.handler).toBeDefined();

      expect(knowledgeGraphTools.ocr_knowledge_graph_corpus_map).toBeDefined();
      expect(knowledgeGraphTools.ocr_knowledge_graph_corpus_map.description).toContain('corpus-level intelligence');
      expect(knowledgeGraphTools.ocr_knowledge_graph_corpus_map.handler).toBeDefined();

      expect(knowledgeGraphTools.ocr_knowledge_graph_organize).toBeDefined();
      expect(knowledgeGraphTools.ocr_knowledge_graph_organize.description).toContain('entity roles');
      expect(knowledgeGraphTools.ocr_knowledge_graph_organize.handler).toBeDefined();
    });

    it('should verify synthesize tool has correct input schema fields', async () => {
      const { knowledgeGraphTools } = await import('../../src/tools/knowledge-graph.js');
      const schema = knowledgeGraphTools.ocr_knowledge_graph_synthesize.inputSchema;

      // Check that key properties exist in the Zod shape
      expect(schema).toHaveProperty('scope');
      expect(schema).toHaveProperty('document_id');
      expect(schema).toHaveProperty('force');
    });

    it('should verify corpus_map tool has force parameter', async () => {
      const { knowledgeGraphTools } = await import('../../src/tools/knowledge-graph.js');
      const schema = knowledgeGraphTools.ocr_knowledge_graph_corpus_map.inputSchema;
      expect(schema).toHaveProperty('force');
    });

    it('should verify organize tool has scope and document_id', async () => {
      const { knowledgeGraphTools } = await import('../../src/tools/knowledge-graph.js');
      const schema = knowledgeGraphTools.ocr_knowledge_graph_organize.inputSchema;
      expect(schema).toHaveProperty('scope');
      expect(schema).toHaveProperty('document_id');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // DATABASE SCHEMA VERIFICATION
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Database schema verification', () => {
    it('should have corpus_intelligence table with correct columns', () => {
      const columns = conn.prepare("PRAGMA table_info(corpus_intelligence)").all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('database_name');
      expect(colNames).toContain('corpus_summary');
      expect(colNames).toContain('key_actors');
      expect(colNames).toContain('themes');
      expect(colNames).toContain('narrative_arcs');
      expect(colNames).toContain('entity_count');
      expect(colNames).toContain('document_count');
      expect(colNames).toContain('model');
      expect(colNames).toContain('provenance_id');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');
    });

    it('should have document_narratives table with correct columns', () => {
      const columns = conn.prepare("PRAGMA table_info(document_narratives)").all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('document_id');
      expect(colNames).toContain('narrative_text');
      expect(colNames).toContain('entity_roster');
      expect(colNames).toContain('corpus_context');
      expect(colNames).toContain('synthesis_count');
      expect(colNames).toContain('model');
      expect(colNames).toContain('provenance_id');
    });

    it('should have entity_roles table with correct columns', () => {
      const columns = conn.prepare("PRAGMA table_info(entity_roles)").all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('node_id');
      expect(colNames).toContain('role');
      expect(colNames).toContain('theme');
      expect(colNames).toContain('importance_rank');
      expect(colNames).toContain('context_summary');
      expect(colNames).toContain('scope');
      expect(colNames).toContain('scope_id');
      expect(colNames).toContain('model');
      expect(colNames).toContain('provenance_id');
    });

    it('should have synthesis indexes', () => {
      const indexes = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_corpus_intelligence_database');
      expect(indexNames).toContain('idx_document_narratives_document');
      expect(indexNames).toContain('idx_entity_roles_node');
      expect(indexNames).toContain('idx_entity_roles_theme');
      expect(indexNames).toContain('idx_entity_roles_role');
      expect(indexNames).toContain('idx_entity_roles_scope');
    });

    it('should have schema version 25', () => {
      const row = conn.prepare('SELECT version FROM schema_version').get() as { version: number };
      expect(row.version).toBe(25);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // COMPREHENSIVE DATA INTEGRITY
  // ═════════════════════════════════════════════════════════════════════════════

  describe('Data integrity after full pipeline', () => {
    it('should maintain referential integrity across all synthesis tables', async () => {
      await synthesizeDocument(conn, testData.docId, { databaseName: 'test-db' });

      // All corpus_intelligence provenance_ids should exist
      const ciRows = conn.prepare('SELECT provenance_id FROM corpus_intelligence').all() as Array<{ provenance_id: string }>;
      for (const row of ciRows) {
        const prov = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(row.provenance_id);
        expect(prov).toBeDefined();
      }

      // All document_narratives provenance_ids should exist
      const dnRows = conn.prepare('SELECT provenance_id, document_id FROM document_narratives').all() as Array<{ provenance_id: string; document_id: string }>;
      for (const row of dnRows) {
        const prov = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(row.provenance_id);
        expect(prov).toBeDefined();
        const doc = conn.prepare('SELECT id FROM documents WHERE id = ?').get(row.document_id);
        expect(doc).toBeDefined();
      }

      // All entity_roles node_ids should exist in knowledge_nodes
      const erRows = conn.prepare('SELECT node_id, provenance_id FROM entity_roles').all() as Array<{ node_id: string; provenance_id: string }>;
      for (const row of erRows) {
        const node = conn.prepare('SELECT id FROM knowledge_nodes WHERE id = ?').get(row.node_id);
        expect(node).toBeDefined();
        const prov = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(row.provenance_id);
        expect(prov).toBeDefined();
      }

      // All synthesized edges should have valid source_node_id and target_node_id
      const synthEdges = conn.prepare(
        `SELECT source_node_id, target_node_id, provenance_id FROM knowledge_edges WHERE metadata LIKE '%"source":"ai_synthesis"%'`
      ).all() as Array<{ source_node_id: string; target_node_id: string; provenance_id: string }>;
      for (const edge of synthEdges) {
        const src = conn.prepare('SELECT id FROM knowledge_nodes WHERE id = ?').get(edge.source_node_id);
        expect(src).toBeDefined();
        const tgt = conn.prepare('SELECT id FROM knowledge_nodes WHERE id = ?').get(edge.target_node_id);
        expect(tgt).toBeDefined();
        const prov = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(edge.provenance_id);
        expect(prov).toBeDefined();
      }
    });

    it('should have consistent Gemini call count for full synthesis', async () => {
      mockFastFn.mockClear();
      setupGeminiMock();

      await synthesizeDocument(conn, testData.docId, { databaseName: 'test-db' });

      // Expected calls: corpus_map + narrative + relationships + roles = 4
      // (groundEvidence does not call Gemini)
      expect(mockFastFn.mock.calls.length).toBe(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Minimal document with 1 entity (for edge case tests)
// ═══════════════════════════════════════════════════════════════════════════════

function insertMinimalDocWithOneEntity(
  conn: Database.Database,
  dbService: DatabaseService
): { docId: string; provId: string } {
  const now = new Date().toISOString();
  const docId = uuidv4();
  const docProvId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const entityExtProvId = uuidv4();
  const kgProvId = uuidv4();
  const fileHash = computeHash('minimal.pdf');
  const text = 'Single entity test document.';

  // DOCUMENT provenance
  dbService.insertProvenance({
    id: docProvId, type: 'DOCUMENT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'FILE', source_path: '/test/minimal.pdf', source_id: null,
    root_document_id: docProvId, location: null, content_hash: fileHash,
    input_hash: null, file_hash: fileHash, processor: 'test', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: null, processing_quality_score: null,
    parent_id: null, parent_ids: '[]', chain_depth: 0, chain_path: '["DOCUMENT"]',
  });

  dbService.insertDocument({
    id: docId, file_path: '/test/minimal.pdf', file_name: 'minimal.pdf',
    file_hash: fileHash, file_size: text.length, file_type: 'pdf',
    status: 'complete', page_count: 1, provenance_id: docProvId,
    error_message: null, ocr_completed_at: now,
  });

  // OCR provenance + result
  dbService.insertProvenance({
    id: ocrProvId, type: 'OCR_RESULT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'OCR', source_path: null, source_id: docProvId,
    root_document_id: docProvId, location: null, content_hash: computeHash(text),
    input_hash: null, file_hash: null, processor: 'datalab-marker',
    processor_version: '1.0.0', processing_params: { mode: 'balanced' },
    processing_duration_ms: 100, processing_quality_score: 4.0,
    parent_id: docProvId, parent_ids: JSON.stringify([docProvId]), chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  dbService.insertOCRResult({
    id: ocrResultId, provenance_id: ocrProvId, document_id: docId,
    extracted_text: text, text_length: text.length,
    datalab_request_id: `req-${ocrResultId}`, datalab_mode: 'balanced',
    parse_quality_score: 4.0, page_count: 1, cost_cents: 1,
    processing_duration_ms: 100, processing_started_at: now,
    processing_completed_at: now, json_blocks: null, content_hash: computeHash(text),
    extras_json: null,
  });

  // ENTITY_EXTRACTION provenance
  dbService.insertProvenance({
    id: entityExtProvId, type: 'ENTITY_EXTRACTION', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION', source_path: null, source_id: ocrProvId,
    root_document_id: docProvId, location: null,
    content_hash: computeHash(`entities-${docId}`), input_hash: null, file_hash: null,
    processor: 'gemini-entity-extractor', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: 100, processing_quality_score: null,
    parent_id: ocrProvId, parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2, chain_path: '["DOCUMENT", "OCR_RESULT", "ENTITY_EXTRACTION"]',
  });

  // KG provenance
  dbService.insertProvenance({
    id: kgProvId, type: 'KNOWLEDGE_GRAPH', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'KNOWLEDGE_GRAPH', source_path: null, source_id: ocrProvId,
    root_document_id: docProvId, location: null,
    content_hash: computeHash(`kg-${docId}`), input_hash: null, file_hash: null,
    processor: 'kg-builder', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: 50, processing_quality_score: null,
    parent_id: ocrProvId, parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2, chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
  });

  // One entity + node
  const entityId = uuidv4();
  insertEntity(conn, {
    id: entityId, document_id: docId, entity_type: 'person',
    raw_text: 'Solo Person', normalized_text: 'solo person',
    confidence: 0.9, metadata: null,
    provenance_id: entityExtProvId, created_at: now,
  });

  const nodeId = uuidv4();
  insertKnowledgeNode(conn, {
    id: nodeId, entity_type: 'person', canonical_name: 'Solo Person',
    normalized_name: 'solo person', aliases: null,
    document_count: 1, mention_count: 1, edge_count: 0,
    avg_confidence: 0.9, importance_score: 0.5,
    metadata: null, provenance_id: kgProvId,
    created_at: now, updated_at: now,
  });

  insertNodeEntityLink(conn, {
    id: uuidv4(), node_id: nodeId, entity_id: entityId,
    document_id: docId, similarity_score: 1.0,
    resolution_method: 'exact', created_at: now,
  });

  return { docId, provId: kgProvId };
}
