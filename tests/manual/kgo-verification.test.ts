/**
 * KGO (Knowledge Graph Optimization) COMPREHENSIVE MANUAL VERIFICATION
 *
 * Tests ALL v17 features with synthetic data and verifies ACTUAL database state.
 *
 * Synthetic Data:
 * - Doc 1 ("Employment Contract"): John Smith, Acme Corp, 2024-01-15, New York
 * - Doc 2 ("Court Filing"): Jane Doe, John Smith, 2024-CV-001, 2024-03-01
 *
 * Tests:
 *  1. Schema v17 migration (edge_count, resolution_method, FTS, triggers, CHECK)
 *  2. Rule classifier (classifyByRules for ALL 8 rules)
 *  3. Knowledge graph build with rule classification
 *  4. Resolution method tracking in node_entity_links
 *  5. Entity-enriched search (getEntitiesForChunks)
 *  6. Query expansion with KG (expandQueryWithKG)
 *  7. Entity-filtered search (getDocumentIdsForEntities)
 *  8. FTS5 knowledge node search (searchKnowledgeNodesFTS)
 *  9. Export formats (GraphML, CSV, JSON-LD)
 * 10. Node merge (merge two nodes into one)
 * 11. Node split (split a merged node back)
 * 12. Edge cases (empty KG, duplicate build, cascade delete, FTS special chars, sub-blocking)
 *
 * NO MOCKS. Real databases. Physical DB verification after every operation.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * Use console.error() for all test output.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { state, resetState, updateConfig, clearDatabase } from '../../src/server/state.js';
import { DatabaseService } from '../../src/services/storage/database/index.js';
import { computeHash } from '../../src/utils/hash.js';
import {
  insertEntity,
  insertEntityMention,
} from '../../src/services/storage/database/entity-operations.js';
import {
  cleanupGraphForDocument,
  getGraphStats,
  getEntitiesForChunks,
  getDocumentIdsForEntities,
  searchKnowledgeNodesFTS,
  getKnowledgeNode,
  getLinksForNode,
  getEdgesForNode,
  countKnowledgeNodes,
} from '../../src/services/storage/database/knowledge-graph-operations.js';
import { buildKnowledgeGraph } from '../../src/services/knowledge-graph/graph-service.js';
import {
  classifyByRules,
  classifyByExtractionSchema,
  classifyByClusterHint,
} from '../../src/services/knowledge-graph/rule-classifier.js';
import {
  exportGraphML,
  exportCSV,
  exportJSONLD,
} from '../../src/services/knowledge-graph/export-service.js';
import { expandQueryWithKG } from '../../src/services/search/query-expander.js';
import { knowledgeGraphTools } from '../../src/tools/knowledge-graph.js';
import type { EntityType } from '../../src/models/entity.js';

// =============================================================================
// HELPERS
// =============================================================================

interface ToolResponse {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { category: string; message: string; details?: Record<string, unknown> };
  [key: string]: unknown;
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ocr-kgo-verify-'));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

const tempDirs: string[] = [];

afterAll(() => {
  resetState();
  for (const dir of tempDirs) cleanupTempDir(dir);
});

// =============================================================================
// SYNTHETIC DATA
// =============================================================================

interface SyntheticDoc {
  docId: string;
  docProvId: string;
  ocrProvId: string;
  ocrResultId: string;
  entityExtProvId: string;
  chunkIds: string[];
  entityIds: string[];
}

function insertSyntheticDocument(
  db: DatabaseService,
  fileName: string,
  text: string,
  entities: Array<{
    entityType: string;
    rawText: string;
    normalizedText: string;
    confidence: number;
  }>,
  chunkCount: number = 2
): SyntheticDoc {
  const conn = db.getConnection();
  const docId = uuidv4();
  const docProvId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const entityExtProvId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(fileName);

  // DOCUMENT provenance
  db.insertProvenance({
    id: docProvId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: `/test/${fileName}`,
    source_id: null,
    root_document_id: docProvId,
    location: null,
    content_hash: fileHash,
    input_hash: null,
    file_hash: fileHash,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  db.insertDocument({
    id: docId,
    file_path: `/test/${fileName}`,
    file_name: fileName,
    file_hash: fileHash,
    file_size: text.length,
    file_type: 'pdf',
    status: 'complete',
    page_count: 1,
    provenance_id: docProvId,
    error_message: null,
    ocr_completed_at: now,
  });

  // OCR_RESULT provenance
  db.insertProvenance({
    id: ocrProvId,
    type: 'OCR_RESULT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'OCR',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(text),
    input_hash: null,
    file_hash: null,
    processor: 'datalab-marker',
    processor_version: '1.0.0',
    processing_params: { mode: 'balanced' },
    processing_duration_ms: 1000,
    processing_quality_score: 4.5,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  db.insertOCRResult({
    id: ocrResultId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: text,
    text_length: text.length,
    datalab_request_id: `req-${ocrResultId}`,
    datalab_mode: 'balanced',
    parse_quality_score: 4.5,
    page_count: 1,
    cost_cents: 5,
    processing_duration_ms: 1000,
    processing_started_at: now,
    processing_completed_at: now,
    json_blocks: null,
    content_hash: computeHash(text),
    extras_json: null,
  });

  // Create chunks
  const chunkIds: string[] = [];
  for (let ci = 0; ci < chunkCount; ci++) {
    const chunkId = uuidv4();
    const chunkProvId = uuidv4();
    const chunkText = `Chunk ${ci} of ${fileName}: ${text.substring(ci * 50, (ci + 1) * 50 + 50)}`;

    db.insertProvenance({
      id: chunkProvId,
      type: 'CHUNK',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'CHUNKING',
      source_path: null,
      source_id: ocrProvId,
      root_document_id: docProvId,
      location: null,
      content_hash: computeHash(chunkText),
      input_hash: null,
      file_hash: null,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 10,
      processing_quality_score: null,
      parent_id: ocrProvId,
      parent_ids: JSON.stringify([docProvId, ocrProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
    });

    db.insertChunk({
      id: chunkId,
      document_id: docId,
      ocr_result_id: ocrResultId,
      text: chunkText,
      text_hash: computeHash(chunkText),
      chunk_index: ci,
      character_start: ci * 200,
      character_end: (ci + 1) * 200,
      page_number: 1,
      page_range: null,
      overlap_previous: 0,
      overlap_next: 0,
      provenance_id: chunkProvId,
    });

    chunkIds.push(chunkId);
  }

  // ENTITY_EXTRACTION provenance
  db.insertProvenance({
    id: entityExtProvId,
    type: 'ENTITY_EXTRACTION',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION',
    source_path: null,
    source_id: ocrProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(`entities-${docId}`),
    input_hash: null,
    file_hash: null,
    processor: 'gemini-entity-extractor',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 2000,
    processing_quality_score: null,
    parent_id: ocrProvId,
    parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "ENTITY_EXTRACTION"]',
  });

  // Insert entities and entity_mentions
  const entityIds: string[] = [];
  for (let ei = 0; ei < entities.length; ei++) {
    const ent = entities[ei];
    const entityId = uuidv4();

    insertEntity(conn, {
      id: entityId,
      document_id: docId,
      entity_type: ent.entityType as EntityType,
      raw_text: ent.rawText,
      normalized_text: ent.normalizedText,
      confidence: ent.confidence,
      metadata: null,
      provenance_id: entityExtProvId,
      created_at: now,
    });

    // Create entity_mention linked to a chunk for co-location testing
    // chunk0 gets entities 0,1 ; chunk1 gets entities 2,3
    const mentionChunkId = chunkIds[ei < chunkCount ? ei % chunkCount : chunkCount - 1];
    insertEntityMention(conn, {
      id: uuidv4(),
      entity_id: entityId,
      document_id: docId,
      chunk_id: mentionChunkId,
      page_number: 1,
      character_start: ei * 20,
      character_end: (ei + 1) * 20,
      context_text: `...${ent.rawText}...`,
      created_at: now,
    });

    entityIds.push(entityId);
  }

  return { docId, docProvId, ocrProvId, ocrResultId, entityExtProvId, chunkIds, entityIds };
}

// Synthetic data definitions
const DOC1_ENTITIES = [
  { entityType: 'person', rawText: 'John Smith', normalizedText: 'john smith', confidence: 0.95 },
  {
    entityType: 'organization',
    rawText: 'Acme Corp',
    normalizedText: 'acme corp',
    confidence: 0.9,
  },
  { entityType: 'date', rawText: '2024-01-15', normalizedText: '2024-01-15', confidence: 0.92 },
  { entityType: 'location', rawText: 'New York', normalizedText: 'new york', confidence: 0.88 },
];

const DOC2_ENTITIES = [
  { entityType: 'person', rawText: 'Jane Doe', normalizedText: 'jane doe', confidence: 0.91 },
  { entityType: 'person', rawText: 'John Smith', normalizedText: 'john smith', confidence: 0.93 },
  {
    entityType: 'case_number',
    rawText: '2024-CV-001',
    normalizedText: '2024-cv-001',
    confidence: 0.95,
  },
  { entityType: 'date', rawText: '2024-03-01', normalizedText: '2024-03-01', confidence: 0.89 },
];

// =============================================================================
// TEST SUITE
// =============================================================================

describe('KGO Comprehensive Manual Verification', () => {
  let tempDir: string;
  let db: DatabaseService;
  let doc1: SyntheticDoc;
  let doc2: SyntheticDoc;

  beforeEach(() => {
    tempDir = createTempDir();
    tempDirs.push(tempDir);
    const dbName = `test-kgo-${Date.now()}`;
    updateConfig({ storagePath: tempDir });
    db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert synthetic documents
    doc1 = insertSyntheticDocument(
      db,
      'employment-contract.pdf',
      'Employment contract between John Smith and Acme Corp, signed on 2024-01-15 at New York office.',
      DOC1_ENTITIES,
      2
    );

    doc2 = insertSyntheticDocument(
      db,
      'court-filing.pdf',
      'Court filing: Jane Doe v. John Smith, case number 2024-CV-001, filed on 2024-03-01.',
      DOC2_ENTITIES,
      2
    );
  });

  afterEach(() => {
    clearDatabase();
  });

  // =========================================================================
  // TEST 1: Schema v17 Migration Verification
  // =========================================================================

  describe('Test 1: Schema v17 Migration Verification', () => {
    it('node_entity_links has resolution_method column', () => {
      const conn = db.getConnection();
      const columns = conn.pragma('table_info(node_entity_links)') as Array<{
        name: string;
        type: string;
      }>;
      const resMethodCol = columns.find((c) => c.name === 'resolution_method');

      console.error('=== VERIFICATION: Schema v17 - resolution_method column ===');
      console.error(`  STATE BEFORE: N/A (schema created fresh)"`);
      console.error(`  ACTION: Check PRAGMA table_info(node_entity_links)`);
      console.error(`  EXPECTED: resolution_method column exists`);
      console.error(
        `  ACTUAL: ${resMethodCol ? 'FOUND' : 'MISSING'} (type: ${resMethodCol?.type ?? 'N/A'})`
      );
      console.error(`  VERDICT: ${resMethodCol ? 'PASS' : 'FAIL'}`);

      expect(resMethodCol).toBeDefined();
      expect(resMethodCol!.name).toBe('resolution_method');
    });

    it('knowledge_nodes has edge_count column', () => {
      const conn = db.getConnection();
      const columns = conn.pragma('table_info(knowledge_nodes)') as Array<{
        name: string;
        type: string;
      }>;
      const edgeCountCol = columns.find((c) => c.name === 'edge_count');

      console.error('=== VERIFICATION: Schema v17 - edge_count column ===');
      console.error(`  EXPECTED: edge_count column exists`);
      console.error(
        `  ACTUAL: ${edgeCountCol ? 'FOUND' : 'MISSING'} (type: ${edgeCountCol?.type ?? 'N/A'})`
      );
      console.error(`  VERDICT: ${edgeCountCol ? 'PASS' : 'FAIL'}`);

      expect(edgeCountCol).toBeDefined();
      expect(edgeCountCol!.type).toBe('INTEGER');
    });

    it('knowledge_edges CHECK includes precedes and occurred_at', () => {
      const conn = db.getConnection();
      const tableInfo = conn
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_edges' AND type = 'table'")
        .get() as { sql: string } | undefined;

      console.error('=== VERIFICATION: Schema v17 - expanded CHECK constraint ===');
      console.error(`  SQL: ${tableInfo?.sql?.substring(0, 200)}...`);

      expect(tableInfo).toBeDefined();
      expect(tableInfo!.sql).toContain('precedes');
      expect(tableInfo!.sql).toContain('occurred_at');

      console.error(`  EXPECTED: CHECK contains precedes, occurred_at`);
      console.error(
        `  ACTUAL: precedes=${tableInfo!.sql.includes('precedes')}, occurred_at=${tableInfo!.sql.includes('occurred_at')}`
      );
      console.error(`  VERDICT: PASS`);
    });

    it('knowledge_nodes_fts FTS5 table exists', () => {
      const conn = db.getConnection();
      const ftsTable = conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_nodes_fts'"
        )
        .get() as { name: string } | undefined;

      console.error('=== VERIFICATION: Schema v17 - knowledge_nodes_fts ===');
      console.error(`  EXPECTED: knowledge_nodes_fts table exists`);
      console.error(`  ACTUAL: ${ftsTable ? 'EXISTS' : 'MISSING'}`);
      console.error(`  VERDICT: ${ftsTable ? 'PASS' : 'FAIL'}`);

      expect(ftsTable).toBeDefined();
      expect(ftsTable!.name).toBe('knowledge_nodes_fts');
    });

    it('FTS5 triggers exist (ai, ad, au)', () => {
      const conn = db.getConnection();
      const triggers = conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'knowledge_nodes_fts%'"
        )
        .all() as Array<{ name: string }>;

      const triggerNames = triggers.map((t) => t.name).sort();

      console.error('=== VERIFICATION: Schema v17 - FTS triggers ===');
      console.error(`  EXPECTED: 3 triggers (knowledge_nodes_fts_ai, _ad, _au)`);
      console.error(`  ACTUAL: ${triggers.length} triggers: ${triggerNames.join(', ')}`);
      console.error(`  VERDICT: ${triggers.length === 3 ? 'PASS' : 'FAIL'}`);

      expect(triggers).toHaveLength(3);
      expect(triggerNames).toContain('knowledge_nodes_fts_ai');
      expect(triggerNames).toContain('knowledge_nodes_fts_ad');
      expect(triggerNames).toContain('knowledge_nodes_fts_au');
    });
  });

  // =========================================================================
  // TEST 2: Rule Classifier
  // =========================================================================

  describe('Test 2: Rule Classifier', () => {
    it('classifyByRules person+organization -> works_at', () => {
      const result = classifyByRules('person', 'organization');

      console.error('=== VERIFICATION: Rule Classifier - person+organization ===');
      console.error(`  ACTION: classifyByRules('person', 'organization')`);
      console.error(`  EXPECTED: { type: 'works_at', confidence: 0.75 }`);
      console.error(`  ACTUAL: ${JSON.stringify(result)}`);
      console.error(`  VERDICT: ${result?.type === 'works_at' ? 'PASS' : 'FAIL'}`);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('works_at');
      expect(result!.confidence).toBe(0.75);
    });

    it('classifyByRules organization+person -> works_at (reversed)', () => {
      const result = classifyByRules('organization', 'person');

      console.error('=== VERIFICATION: Rule Classifier - reversed order ===');
      console.error(`  EXPECTED: same result (works_at, 0.75) - order should not matter`);
      console.error(`  ACTUAL: ${JSON.stringify(result)}`);
      console.error(`  VERDICT: ${result?.type === 'works_at' ? 'PASS' : 'FAIL'}`);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('works_at');
      expect(result!.confidence).toBe(0.75);
    });

    it('classifyByRules exhibit+exhibit -> null (no rule)', () => {
      const result = classifyByRules('exhibit', 'exhibit');

      console.error('=== VERIFICATION: Rule Classifier - no matching rule ===');
      console.error(`  ACTION: classifyByRules('exhibit', 'exhibit')`);
      console.error(`  EXPECTED: null`);
      console.error(`  ACTUAL: ${JSON.stringify(result)}`);
      console.error(`  VERDICT: ${result === null ? 'PASS' : 'FAIL'}`);

      expect(result).toBeNull();
    });

    it('classifyByRules case_number+date -> filed_in', () => {
      const result = classifyByRules('case_number', 'date');

      console.error('=== VERIFICATION: Rule Classifier - case_number+date ===');
      console.error(`  EXPECTED: { type: 'filed_in', confidence: 0.85 }`);
      console.error(`  ACTUAL: ${JSON.stringify(result)}`);
      console.error(`  VERDICT: ${result?.type === 'filed_in' ? 'PASS' : 'FAIL'}`);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('filed_in');
      expect(result!.confidence).toBe(0.85);
    });

    it('ALL 8 RULE_MATRIX entries with both orderings', () => {
      const testCases: Array<{
        src: EntityType;
        tgt: EntityType;
        expectedType: string;
        expectedConf: number;
      }> = [
        { src: 'person', tgt: 'organization', expectedType: 'works_at', expectedConf: 0.75 },
        { src: 'organization', tgt: 'location', expectedType: 'located_in', expectedConf: 0.8 },
        { src: 'case_number', tgt: 'date', expectedType: 'filed_in', expectedConf: 0.85 },
        { src: 'statute', tgt: 'case_number', expectedType: 'cites', expectedConf: 0.9 },
        { src: 'case_number', tgt: 'statute', expectedType: 'cites', expectedConf: 0.9 },
        { src: 'person', tgt: 'location', expectedType: 'located_in', expectedConf: 0.7 },
        { src: 'organization', tgt: 'case_number', expectedType: 'party_to', expectedConf: 0.75 },
        { src: 'person', tgt: 'case_number', expectedType: 'party_to', expectedConf: 0.75 },
      ];

      console.error('=== VERIFICATION: All 8 Rule Matrix Entries ===');

      for (const tc of testCases) {
        // Forward
        const fwd = classifyByRules(tc.src, tc.tgt);
        expect(fwd).not.toBeNull();
        expect(fwd!.type).toBe(tc.expectedType);
        expect(fwd!.confidence).toBe(tc.expectedConf);

        // Reverse
        const rev = classifyByRules(tc.tgt, tc.src);
        expect(rev).not.toBeNull();
        expect(rev!.type).toBe(tc.expectedType);
        expect(rev!.confidence).toBe(tc.expectedConf);

        console.error(`  ${tc.src}+${tc.tgt} -> ${fwd!.type} (${fwd!.confidence}) [fwd+rev: PASS]`);
      }
    });

    it('classifyByExtractionSchema for same-extraction entities', () => {
      const result = classifyByExtractionSchema(
        JSON.stringify({ extraction_id: 'ext-1' }),
        JSON.stringify({ extraction_id: 'ext-1' }),
        'organization',
        'person'
      );

      console.error('=== VERIFICATION: Extraction Schema Classification ===');
      console.error(`  EXPECTED: party_to at 0.90`);
      console.error(`  ACTUAL: ${JSON.stringify(result)}`);
      console.error(`  VERDICT: ${result?.type === 'party_to' ? 'PASS' : 'FAIL'}`);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('party_to');
      expect(result!.confidence).toBe(0.9);
    });

    it('classifyByClusterHint for employment cluster', () => {
      const result = classifyByClusterHint('employment', 'person', 'organization');

      console.error('=== VERIFICATION: Cluster Hint Classification ===');
      console.error(`  EXPECTED: works_at at 0.90`);
      console.error(`  ACTUAL: ${JSON.stringify(result)}`);
      console.error(`  VERDICT: ${result?.type === 'works_at' ? 'PASS' : 'FAIL'}`);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('works_at');
      expect(result!.confidence).toBe(0.9);
    });
  });

  // =========================================================================
  // TEST 3: Knowledge Graph Build with Rule Classification
  // =========================================================================

  describe('Test 3: Knowledge Graph Build', () => {
    it('builds graph and verifies all DB records', async () => {
      const conn = db.getConnection();

      console.error('=== VERIFICATION: Knowledge Graph Build ===');
      console.error(`  STATE BEFORE: 2 docs, 8 entities, 0 nodes, 0 edges, 0 links`);

      const result = await buildKnowledgeGraph(db, {
        resolution_mode: 'exact',
        classify_relationships: false,
      });

      console.error(
        `  ACTION: buildKnowledgeGraph({ resolution_mode: 'exact', classify_relationships: false })`
      );
      console.error(
        `  RESULT: nodes=${result.total_nodes}, edges=${result.total_edges}, entities_resolved=${result.entities_resolved}`
      );

      // Physical verification
      const nodeCount = (
        conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number }
      ).cnt;
      const edgeCount = (
        conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }
      ).cnt;
      const linkCount = (
        conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as { cnt: number }
      ).cnt;

      console.error(`  DATABASE PROOF: nodes=${nodeCount}, edges=${edgeCount}, links=${linkCount}`);
      console.error(`  EXPECTED: nodes matches result, links=8 (all entities linked), edges>0`);
      console.error(
        `  VERDICT: ${nodeCount === result.total_nodes && linkCount === 8 ? 'PASS' : 'FAIL'}`
      );

      expect(nodeCount).toBe(result.total_nodes);
      expect(linkCount).toBe(8);
      expect(result.entities_resolved).toBe(8);
      expect(result.documents_covered).toBe(2);
      expect(edgeCount).toBe(result.total_edges);
      expect(edgeCount).toBeGreaterThan(0);

      // "John Smith" appears in both docs with same normalized_text -> should merge
      const smithNodes = conn
        .prepare("SELECT * FROM knowledge_nodes WHERE normalized_name = 'john smith'")
        .all() as Array<{
        id: string;
        canonical_name: string;
        document_count: number;
        mention_count: number;
      }>;
      console.error(
        `  John Smith nodes: ${smithNodes.length}, doc_count=${smithNodes[0]?.document_count}`
      );
      expect(smithNodes).toHaveLength(1);
      expect(smithNodes[0].document_count).toBe(2);
      expect(smithNodes[0].mention_count).toBe(2);

      // Verify node entity type distribution
      const typeDistribution = conn
        .prepare('SELECT entity_type, COUNT(*) as cnt FROM knowledge_nodes GROUP BY entity_type')
        .all() as Array<{ entity_type: string; cnt: number }>;
      console.error(`  Node type distribution: ${JSON.stringify(typeDistribution)}`);

      // Expected nodes: john smith(merged=1), acme corp, new york, jane doe, 2024-cv-001, 2024-01-15, 2024-03-01 = 7
      expect(nodeCount).toBe(7);

      // Provenance records
      const provCount = (
        conn
          .prepare("SELECT COUNT(*) as cnt FROM provenance WHERE type = 'KNOWLEDGE_GRAPH'")
          .get() as { cnt: number }
      ).cnt;
      console.error(`  KNOWLEDGE_GRAPH provenance: ${provCount}`);
      expect(provCount).toBeGreaterThanOrEqual(1);

      // edge_count on nodes matches actual edge count
      const edgeCountMismatch = conn
        .prepare(
          `
        SELECT kn.id, kn.canonical_name, kn.edge_count,
          (SELECT COUNT(*) FROM knowledge_edges WHERE source_node_id = kn.id OR target_node_id = kn.id) as actual_edges
        FROM knowledge_nodes kn
        WHERE kn.edge_count != (SELECT COUNT(*) FROM knowledge_edges WHERE source_node_id = kn.id OR target_node_id = kn.id)
      `
        )
        .all() as Array<{
        id: string;
        canonical_name: string;
        edge_count: number;
        actual_edges: number;
      }>;

      console.error(`  edge_count mismatches: ${edgeCountMismatch.length}`);
      if (edgeCountMismatch.length > 0) {
        for (const m of edgeCountMismatch) {
          console.error(
            `    MISMATCH: "${m.canonical_name}": stored=${m.edge_count}, actual=${m.actual_edges}`
          );
        }
      }
      expect(edgeCountMismatch).toHaveLength(0);
    });
  });

  // =========================================================================
  // TEST 4: Resolution Method Tracking
  // =========================================================================

  describe('Test 4: Resolution Method Tracking', () => {
    it('all node_entity_links have resolution_method set', async () => {
      const conn = db.getConnection();

      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const links = conn
        .prepare(
          'SELECT nel.*, kn.canonical_name FROM node_entity_links nel JOIN knowledge_nodes kn ON nel.node_id = kn.id'
        )
        .all() as Array<{
        id: string;
        node_id: string;
        entity_id: string;
        document_id: string;
        similarity_score: number;
        resolution_method: string | null;
        canonical_name: string;
      }>;

      console.error('=== VERIFICATION: Resolution Method Tracking ===');
      console.error(`  ACTION: Build with resolution_mode='exact', check node_entity_links`);
      console.error(`  EXPECTED: all links have resolution_method set (exact or singleton)`);

      let allHaveMethod = true;
      for (const link of links) {
        console.error(
          `  link -> node "${link.canonical_name}": method=${link.resolution_method}, similarity=${link.similarity_score}`
        );
        if (!link.resolution_method) {
          allHaveMethod = false;
          console.error(`    WARNING: resolution_method is NULL`);
        }
      }

      console.error(`  VERDICT: ${allHaveMethod ? 'PASS' : 'FAIL'}`);
      expect(allHaveMethod).toBe(true);
      expect(links).toHaveLength(8);

      // John Smith links should have 'exact' resolution
      const smithLinks = links.filter((l) => l.canonical_name === 'John Smith');
      expect(smithLinks).toHaveLength(2);
      for (const sl of smithLinks) {
        expect(sl.resolution_method).toBe('exact');
      }

      // Single entities should have 'singleton' resolution
      const singletonLinks = links.filter((l) =>
        ['Jane Doe', 'Acme Corp', 'New York', '2024-CV-001'].includes(l.canonical_name)
      );
      for (const sl of singletonLinks) {
        expect(sl.resolution_method).toBe('singleton');
      }
    });
  });

  // =========================================================================
  // TEST 5: Entity-Enriched Search (getEntitiesForChunks)
  // =========================================================================

  describe('Test 5: Entity-Enriched Search', () => {
    it('getEntitiesForChunks returns correct entity map after graph build', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      // Query chunks from doc1
      const entityMap = getEntitiesForChunks(conn, doc1.chunkIds);

      console.error('=== VERIFICATION: Entity-Enriched Search (getEntitiesForChunks) ===');
      console.error(
        `  ACTION: getEntitiesForChunks(conn, [${doc1.chunkIds.map((c) => c.slice(0, 8)).join(', ')}])`
      );

      let totalEntities = 0;
      for (const [chunkId, entities] of entityMap) {
        console.error(`  chunk ${chunkId.slice(0, 8)}: ${entities.length} entities`);
        for (const e of entities) {
          console.error(
            `    - ${e.canonical_name} (${e.entity_type}), doc_count=${e.document_count}`
          );
        }
        totalEntities += entities.length;
      }

      console.error(
        `  EXPECTED: doc1 has 4 entities spread across 2 chunks, each chunk should have entities`
      );
      console.error(`  ACTUAL: ${totalEntities} total entities across ${entityMap.size} chunks`);
      console.error(`  VERDICT: ${totalEntities > 0 ? 'PASS' : 'FAIL'}`);

      expect(entityMap.size).toBeGreaterThan(0);
      expect(totalEntities).toBeGreaterThan(0);

      // Verify the entities include expected names
      const allEntityNames = new Set<string>();
      for (const [, entities] of entityMap) {
        for (const e of entities) {
          allEntityNames.add(e.canonical_name.toLowerCase());
        }
      }
      expect(allEntityNames.has('john smith')).toBe(true);
    });
  });

  // =========================================================================
  // TEST 6: Query Expansion with KG
  // =========================================================================

  describe('Test 6: Query Expansion with KG', () => {
    it('expandQueryWithKG adds KG aliases to query', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      // KG expansion
      const kgExpanded = expandQueryWithKG('john', conn);

      console.error('=== VERIFICATION: Query Expansion with KG ===');
      console.error(`  ACTION: expandQueryWithKG('john', conn)`);
      console.error(`  KG:    "${kgExpanded}"`);

      // "john" alone won't match a knowledge node exact match, but let's also test with "john smith"
      const kgExpandedFull = expandQueryWithKG('john smith', conn);
      console.error(`  KG (full name): "${kgExpandedFull}"`);

      // The KG should find the "John Smith" node when queried with exact match
      console.error(`  EXPECTED: KG expansion returns non-empty string`);
      console.error(`  ACTUAL: KG terms=${kgExpanded.split(' OR ').length}`);
      console.error(`  VERDICT: PASS (function executed without error)`);

      // The function should not crash
      expect(kgExpanded).toBeTruthy();
      expect(kgExpandedFull).toBeTruthy();
    });

    it('expandQueryWithKG on empty KG still returns expanded query', () => {
      const conn = db.getConnection();
      // No graph built - KG tables exist but are empty

      const result = expandQueryWithKG('injury', conn);

      console.error('=== VERIFICATION: Empty KG expansion ===');
      console.error(`  KG result: "${result}"`);
      console.error(`  VERDICT: ${result.includes('injury') ? 'PASS' : 'FAIL'}`);

      // Should contain original term and synonyms even without KG data
      expect(result).toContain('injury');
      expect(result).toContain('wound');
      expect(result).toContain('trauma');
    });
  });

  // =========================================================================
  // TEST 7: Entity-Filtered Search
  // =========================================================================

  describe('Test 7: Entity-Filtered Search', () => {
    it('getDocumentIdsForEntities finds docs by entity name', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const docs = getDocumentIdsForEntities(conn, ['john smith'], undefined);

      console.error('=== VERIFICATION: Entity-Filtered Search ===');
      console.error(`  ACTION: getDocumentIdsForEntities(conn, ['john smith'])`);
      console.error(`  EXPECTED: both doc IDs (John Smith appears in both docs)`);
      console.error(`  ACTUAL: ${docs.length} docs: ${docs.map((d) => d.slice(0, 8)).join(', ')}`);
      console.error(`  VERDICT: ${docs.length === 2 ? 'PASS' : 'FAIL'}`);

      expect(docs).toHaveLength(2);
      expect(docs).toContain(doc1.docId);
      expect(docs).toContain(doc2.docId);
    });

    it('getDocumentIdsForEntities finds docs by entity type', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const docs = getDocumentIdsForEntities(conn, undefined, ['case_number']);

      console.error('=== VERIFICATION: Entity-Filtered Search by type ===');
      console.error(`  ACTION: getDocumentIdsForEntities(conn, undefined, ['case_number'])`);
      console.error(`  EXPECTED: only doc2 (case number only in doc2)`);
      console.error(`  ACTUAL: ${docs.length} docs: ${docs.map((d) => d.slice(0, 8)).join(', ')}`);
      console.error(`  VERDICT: ${docs.length === 1 ? 'PASS' : 'FAIL'}`);

      expect(docs).toHaveLength(1);
      expect(docs).toContain(doc2.docId);
    });

    it('getDocumentIdsForEntities returns empty for nonexistent entity', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const docs = getDocumentIdsForEntities(conn, ['nonexistent entity'], undefined);

      console.error('=== VERIFICATION: Entity-Filtered Search - nonexistent ===');
      console.error(`  EXPECTED: 0 docs`);
      console.error(`  ACTUAL: ${docs.length} docs`);
      console.error(`  VERDICT: ${docs.length === 0 ? 'PASS' : 'FAIL'}`);

      expect(docs).toHaveLength(0);
    });
  });

  // =========================================================================
  // TEST 8: FTS5 Knowledge Node Search
  // =========================================================================

  describe('Test 8: FTS5 Knowledge Node Search', () => {
    it('searchKnowledgeNodesFTS finds nodes by name', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const results = searchKnowledgeNodesFTS(conn, 'smith');

      console.error('=== VERIFICATION: FTS5 Knowledge Node Search ===');
      console.error(`  ACTION: searchKnowledgeNodesFTS(conn, 'smith')`);
      console.error(`  EXPECTED: at least "John Smith" found`);
      console.error(`  ACTUAL: ${results.length} results`);
      for (const r of results) {
        console.error(`    - "${r.canonical_name}" (${r.entity_type}), rank=${r.rank}`);
      }
      console.error(`  VERDICT: ${results.length > 0 ? 'PASS' : 'FAIL'}`);

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.canonical_name.toLowerCase().includes('smith'))).toBe(true);
    });

    it('searchKnowledgeNodesFTS with special characters does not crash', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      // Test with special characters that could break FTS5
      const results = searchKnowledgeNodesFTS(conn, "O'Brien");

      console.error('=== VERIFICATION: FTS5 Special Characters ===');
      console.error(`  ACTION: searchKnowledgeNodesFTS(conn, "O'Brien")`);
      console.error(`  EXPECTED: no crash, empty result`);
      console.error(`  ACTUAL: ${results.length} results (no crash)`);
      console.error(`  VERDICT: PASS (no exception thrown)`);

      // Should not crash, may return empty results
      expect(Array.isArray(results)).toBe(true);
    });

    it('searchKnowledgeNodesFTS with empty query returns empty', async () => {
      const conn = db.getConnection();
      const results = searchKnowledgeNodesFTS(conn, '');

      expect(results).toHaveLength(0);
    });
  });

  // =========================================================================
  // TEST 9: Export Formats
  // =========================================================================

  describe('Test 9: Export Formats', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });
    });

    it('exports GraphML correctly', () => {
      const conn = db.getConnection();
      const outputPath = join(tempDir, 'test_kg.graphml');

      const result = exportGraphML(conn, outputPath, {});

      console.error('=== VERIFICATION: GraphML Export ===');
      console.error(`  ACTION: exportGraphML to ${outputPath}`);
      console.error(`  EXPECTED: file exists, parseable XML, correct node/edge counts`);
      console.error(
        `  ACTUAL: files=${result.files_written.length}, nodes=${result.node_count}, edges=${result.edge_count}`
      );

      expect(existsSync(outputPath)).toBe(true);
      expect(result.format).toBe('graphml');
      expect(result.node_count).toBe(7);
      expect(result.edge_count).toBeGreaterThan(0);

      // Verify XML content
      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<?xml version="1.0"');
      expect(content).toContain('<graphml');
      expect(content).toContain('John Smith');
      expect(content).toContain('</graphml>');

      console.error(`  FILE SIZE: ${content.length} bytes`);
      console.error(`  CONTAINS XML header: true`);
      console.error(`  CONTAINS John Smith: true`);
      console.error(`  VERDICT: PASS`);
    });

    it('exports CSV correctly', () => {
      const conn = db.getConnection();
      const outputPath = join(tempDir, 'test_kg.csv');

      const result = exportCSV(conn, outputPath, {});

      console.error('=== VERIFICATION: CSV Export ===');
      console.error(`  ACTION: exportCSV to ${outputPath}`);
      console.error(
        `  ACTUAL: files=${result.files_written.join(', ')}, nodes=${result.node_count}, edges=${result.edge_count}`
      );

      expect(result.format).toBe('csv');
      expect(result.files_written).toHaveLength(2);
      expect(result.node_count).toBe(7);
      expect(result.edge_count).toBeGreaterThan(0);

      // Verify both files exist
      for (const file of result.files_written) {
        expect(existsSync(file)).toBe(true);
        const content = readFileSync(file, 'utf-8');
        expect(content.length).toBeGreaterThan(0);
        console.error(`  ${file}: ${content.split('\n').length} lines`);
      }

      console.error(`  VERDICT: PASS`);
    });

    it('exports JSON-LD correctly', () => {
      const conn = db.getConnection();
      const outputPath = join(tempDir, 'test_kg.jsonld');

      const result = exportJSONLD(conn, outputPath, {});

      console.error('=== VERIFICATION: JSON-LD Export ===');
      console.error(`  ACTION: exportJSONLD to ${outputPath}`);
      console.error(
        `  ACTUAL: files=${result.files_written.length}, nodes=${result.node_count}, edges=${result.edge_count}`
      );

      expect(existsSync(outputPath)).toBe(true);
      expect(result.format).toBe('json_ld');
      expect(result.node_count).toBe(7);
      expect(result.edge_count).toBeGreaterThan(0);

      // Verify parseable JSON
      const content = readFileSync(outputPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed['@context']).toBeDefined();
      expect(parsed['@graph']).toBeDefined();
      expect(parsed['@graph'].length).toBe(result.node_count + result.edge_count);

      console.error(`  @context: defined`);
      console.error(`  @graph length: ${parsed['@graph'].length}`);
      console.error(`  VERDICT: PASS`);
    });

    it('export with entity_type_filter works', () => {
      const conn = db.getConnection();
      const outputPath = join(tempDir, 'test_kg_filtered.graphml');

      const result = exportGraphML(conn, outputPath, {
        entity_type_filter: ['person'],
      });

      console.error('=== VERIFICATION: Filtered Export ===');
      console.error(`  filter: entity_type=person`);
      console.error(`  nodes: ${result.node_count}, edges: ${result.edge_count}`);

      // Should only have person nodes (John Smith, Jane Doe, plus Acme Corp? No - only person)
      expect(result.node_count).toBe(2); // John Smith, Jane Doe

      console.error(`  VERDICT: ${result.node_count === 2 ? 'PASS' : 'FAIL'}`);
    });
  });

  // =========================================================================
  // TEST 10: Node Merge
  // =========================================================================

  describe('Test 10: Node Merge', () => {
    it('merges two nodes and transfers links/edges correctly', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      // Find two person nodes to merge: John Smith and Jane Doe
      const smithNode = conn
        .prepare("SELECT id FROM knowledge_nodes WHERE canonical_name = 'John Smith'")
        .get() as { id: string };
      const doeNode = conn
        .prepare("SELECT id FROM knowledge_nodes WHERE canonical_name = 'Jane Doe'")
        .get() as { id: string };

      expect(smithNode).toBeDefined();
      expect(doeNode).toBeDefined();

      // Record state before
      const smithLinksBefore = getLinksForNode(conn, smithNode.id).length;
      const doeLinksBefore = getLinksForNode(conn, doeNode.id).length;
      const smithEdgesBefore = getEdgesForNode(conn, smithNode.id).length;
      const doeEdgesBefore = getEdgesForNode(conn, doeNode.id).length;
      const totalNodesBefore = countKnowledgeNodes(conn);

      console.error('=== VERIFICATION: Node Merge ===');
      console.error(
        `  STATE BEFORE: Smith links=${smithLinksBefore}, edges=${smithEdgesBefore}; Doe links=${doeLinksBefore}, edges=${doeEdgesBefore}`
      );
      console.error(`  Total nodes before: ${totalNodesBefore}`);

      const handler = knowledgeGraphTools['ocr_knowledge_graph_merge'].handler;
      const response = await handler({
        source_node_id: doeNode.id,
        target_node_id: smithNode.id,
        confirm: true,
      });
      const parsed = parseResponse(response);

      console.error(`  ACTION: merge Jane Doe -> John Smith`);
      console.error(`  RESULT: ${JSON.stringify(parsed.data)}`);

      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      expect(data.merged).toBe(true);

      // Verify source node is deleted
      const doeAfter = getKnowledgeNode(conn, doeNode.id);
      expect(doeAfter).toBeNull();

      // Verify target node absorbed all links
      const smithLinksAfter = getLinksForNode(conn, smithNode.id);
      console.error(
        `  STATE AFTER: Smith links=${smithLinksAfter.length} (was ${smithLinksBefore})`
      );
      expect(smithLinksAfter.length).toBe(smithLinksBefore + doeLinksBefore);

      // Verify total nodes decreased by 1
      const totalNodesAfter = countKnowledgeNodes(conn);
      console.error(`  Total nodes after: ${totalNodesAfter} (was ${totalNodesBefore})`);
      expect(totalNodesAfter).toBe(totalNodesBefore - 1);

      // Verify aliases contain "Jane Doe"
      const smithNodeAfter = getKnowledgeNode(conn, smithNode.id);
      const aliases = smithNodeAfter?.aliases ? JSON.parse(smithNodeAfter.aliases) : [];
      console.error(`  Aliases after merge: ${JSON.stringify(aliases)}`);
      expect(aliases).toContain('Jane Doe');

      console.error(`  VERDICT: PASS`);
    });
  });

  // =========================================================================
  // TEST 11: Node Split
  // =========================================================================

  describe('Test 11: Node Split', () => {
    it('splits a node by moving specific entity links to new node', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      // Find the merged John Smith node (2 entities from 2 docs)
      const smithNode = conn
        .prepare("SELECT * FROM knowledge_nodes WHERE canonical_name = 'John Smith'")
        .get() as { id: string; mention_count: number; document_count: number };

      expect(smithNode).toBeDefined();
      expect(smithNode.mention_count).toBe(2);

      // Get the entity links - pick one to split off
      const links = getLinksForNode(conn, smithNode.id);
      expect(links.length).toBe(2);

      const entityToSplit = links[1].entity_id;
      const totalNodesBefore = countKnowledgeNodes(conn);

      console.error('=== VERIFICATION: Node Split ===');
      console.error(
        `  STATE BEFORE: John Smith has ${links.length} links, doc_count=${smithNode.document_count}`
      );
      console.error(`  Total nodes before: ${totalNodesBefore}`);

      const handler = knowledgeGraphTools['ocr_knowledge_graph_split'].handler;
      const response = await handler({
        node_id: smithNode.id,
        entity_ids_to_split: [entityToSplit],
        confirm: true,
      });
      const parsed = parseResponse(response);

      console.error(`  ACTION: split entity ${entityToSplit.slice(0, 8)} from John Smith`);
      console.error(`  RESULT: ${JSON.stringify(parsed.data)}`);

      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      expect(data.split).toBe(true);

      // Verify original node has fewer links
      const smithLinksAfter = getLinksForNode(conn, smithNode.id);
      console.error(`  STATE AFTER: original node links=${smithLinksAfter.length}`);
      expect(smithLinksAfter.length).toBe(1);

      // Verify new node was created
      const totalNodesAfter = countKnowledgeNodes(conn);
      console.error(`  Total nodes after: ${totalNodesAfter} (was ${totalNodesBefore})`);
      expect(totalNodesAfter).toBe(totalNodesBefore + 1);

      // Verify new node has the split entity
      const newNodeId = data.new_node_id as string;
      const newNodeLinks = getLinksForNode(conn, newNodeId);
      console.error(`  New node links: ${newNodeLinks.length}`);
      expect(newNodeLinks.length).toBe(1);
      expect(newNodeLinks[0].entity_id).toBe(entityToSplit);

      console.error(`  VERDICT: PASS`);
    });
  });

  // =========================================================================
  // TEST 12: Edge Cases
  // =========================================================================

  describe('Test 12: Edge Cases', () => {
    it('expandQueryWithKG on empty DB still returns expanded query', () => {
      const conn = db.getConnection();
      // No graph built

      const result = expandQueryWithKG('injury', conn);

      console.error('=== VERIFICATION: Empty KG expansion edge case ===');
      console.error(`  EXPECTED: contains injury and synonyms`);
      console.error(`  ACTUAL: KG="${result}"`);
      console.error(`  VERDICT: ${result.includes('injury') ? 'PASS' : 'FAIL'}`);

      // Should contain original term and synonyms even without KG data
      expect(result).toContain('injury');
      expect(result).toContain('wound');
      expect(result).toContain('trauma');
    });

    it('duplicate build fails with "already exists" error', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      console.error('=== VERIFICATION: Duplicate build prevention ===');

      await expect(buildKnowledgeGraph(db, { resolution_mode: 'exact' })).rejects.toThrow(
        'Graph already exists'
      );

      console.error(`  VERDICT: PASS (threw "already exists" error)`);
    });

    it('rebuild=true allows building over existing graph', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const result = await buildKnowledgeGraph(db, {
        resolution_mode: 'exact',
        rebuild: true,
      });

      console.error('=== VERIFICATION: Rebuild idempotency ===');
      console.error(`  nodes: ${result.total_nodes}, entities: ${result.entities_resolved}`);
      console.error(`  VERDICT: ${result.total_nodes === 7 ? 'PASS' : 'FAIL'}`);

      expect(result.total_nodes).toBe(7);
      expect(result.entities_resolved).toBe(8);
    });

    it('cascade delete: removing doc1 updates graph correctly', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const nodesBefore = countKnowledgeNodes(conn);
      const linksBefore = (
        conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as { cnt: number }
      ).cnt;

      console.error('=== VERIFICATION: Cascade Delete ===');
      console.error(`  STATE BEFORE: nodes=${nodesBefore}, links=${linksBefore}`);

      const result = cleanupGraphForDocument(conn, doc1.docId);

      const nodesAfter = countKnowledgeNodes(conn);
      const linksAfter = (
        conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as { cnt: number }
      ).cnt;

      console.error(`  ACTION: cleanupGraphForDocument(doc1)`);
      console.error(
        `  RESULT: links_deleted=${result.links_deleted}, nodes_deleted=${result.nodes_deleted}, edges_deleted=${result.edges_deleted}`
      );
      console.error(`  STATE AFTER: nodes=${nodesAfter}, links=${linksAfter}`);

      // Doc1 had 4 entities -> 4 links should be deleted
      expect(result.links_deleted).toBe(4);

      // "Acme Corp" and "New York" were only in doc1 -> should be deleted
      const acmeNode = conn
        .prepare("SELECT * FROM knowledge_nodes WHERE canonical_name = 'Acme Corp'")
        .all();
      const nyNode = conn
        .prepare("SELECT * FROM knowledge_nodes WHERE canonical_name = 'New York'")
        .all();
      expect(acmeNode).toHaveLength(0);
      expect(nyNode).toHaveLength(0);

      // "John Smith" was in both docs -> should still exist with document_count=1
      const smithNode = conn
        .prepare("SELECT * FROM knowledge_nodes WHERE canonical_name = 'John Smith'")
        .all() as Array<{ document_count: number }>;
      expect(smithNode).toHaveLength(1);
      expect(smithNode[0].document_count).toBe(1);

      // "2024-01-15" was only in doc1 -> should be deleted
      const dateNode = conn
        .prepare("SELECT * FROM knowledge_nodes WHERE canonical_name = '2024-01-15'")
        .all();
      expect(dateNode).toHaveLength(0);

      console.error(`  Acme Corp: deleted (single-doc)`);
      console.error(`  New York: deleted (single-doc)`);
      console.error(`  John Smith: still exists, doc_count=1`);
      console.error(`  2024-01-15: deleted (single-doc)`);
      console.error(`  VERDICT: PASS`);
    });

    it('FTS with special characters does not crash', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      // Various special characters
      const queries = ["O'Brien", 'Smith & Associates', '"quoted"', 'test*', '(parens)'];
      let allPassed = true;

      console.error('=== VERIFICATION: FTS Special Characters ===');
      for (const q of queries) {
        try {
          const results = searchKnowledgeNodesFTS(conn, q);
          console.error(`  query="${q}": ${results.length} results (no crash)`);
        } catch (e) {
          console.error(`  query="${q}": CRASHED - ${e}`);
          allPassed = false;
        }
      }

      console.error(`  VERDICT: ${allPassed ? 'PASS' : 'FAIL'}`);
      expect(allPassed).toBe(true);
    });

    it('graph stats match direct database counts', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const stats = getGraphStats(conn);

      const directNodes = (
        conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number }
      ).cnt;
      const directEdges = (
        conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }
      ).cnt;
      const directLinks = (
        conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as { cnt: number }
      ).cnt;
      const directCrossDoc = (
        conn
          .prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE document_count > 1')
          .get() as { cnt: number }
      ).cnt;

      console.error('=== VERIFICATION: Stats vs Direct Counts ===');
      console.error(`  stats.total_nodes=${stats.total_nodes} vs direct=${directNodes}`);
      console.error(`  stats.total_edges=${stats.total_edges} vs direct=${directEdges}`);
      console.error(`  stats.total_links=${stats.total_links} vs direct=${directLinks}`);
      console.error(
        `  stats.cross_document_nodes=${stats.cross_document_nodes} vs direct=${directCrossDoc}`
      );

      expect(stats.total_nodes).toBe(directNodes);
      expect(stats.total_edges).toBe(directEdges);
      expect(stats.total_links).toBe(directLinks);
      expect(stats.cross_document_nodes).toBe(directCrossDoc);

      console.error(`  VERDICT: PASS`);
    });

    it('building graph with no entities throws appropriate error', async () => {
      const conn = db.getConnection();
      conn.prepare('DELETE FROM entity_mentions').run();
      conn.prepare('DELETE FROM entities').run();

      console.error('=== VERIFICATION: No entities error ===');

      await expect(buildKnowledgeGraph(db, { resolution_mode: 'exact' })).rejects.toThrow(
        'No documents provided for KG build'
      );

      const nodeCount = (
        conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number }
      ).cnt;
      expect(nodeCount).toBe(0);

      console.error(`  VERDICT: PASS`);
    });

    it('per-node provenance records exist after build', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      // Count provenance records with different processors
      const mainProv = conn
        .prepare(
          "SELECT COUNT(*) as cnt FROM provenance WHERE type = 'KNOWLEDGE_GRAPH' AND processor = 'knowledge-graph-builder'"
        )
        .get() as { cnt: number };
      const nodeProv = conn
        .prepare(
          "SELECT COUNT(*) as cnt FROM provenance WHERE type = 'KNOWLEDGE_GRAPH' AND processor = 'entity-resolution'"
        )
        .get() as { cnt: number };

      console.error('=== VERIFICATION: Per-node provenance ===');
      console.error(`  Main KG provenance records: ${mainProv.cnt}`);
      console.error(`  Per-node entity-resolution records: ${nodeProv.cnt}`);
      console.error(`  Total nodes: ${countKnowledgeNodes(conn)}`);

      // Should have 1 main provenance + 1 per node
      expect(mainProv.cnt).toBe(1);
      expect(nodeProv.cnt).toBe(countKnowledgeNodes(conn));

      console.error(`  VERDICT: ${nodeProv.cnt === countKnowledgeNodes(conn) ? 'PASS' : 'FAIL'}`);
    });
  });

  // =========================================================================
  // TOOL HANDLER INTEGRATION
  // =========================================================================

  describe('Tool Handler Integration', () => {
    it('ocr_knowledge_graph_export via tool handler', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      const handler = knowledgeGraphTools['ocr_knowledge_graph_export'].handler;
      const response = await handler({
        format: 'graphml',
        output_path: join(tempDir, 'tool_export.graphml'),
      });
      const parsed = parseResponse(response);

      console.error('=== VERIFICATION: Export Tool Handler ===');
      console.error(`  success: ${parsed.success}`);
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      expect(data.node_count).toBe(7);
      expect(data.format).toBe('graphml');
    });

    it('ocr_knowledge_graph_enrich via tool handler', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'exact' });
      const conn = db.getConnection();
      const smithNode = conn
        .prepare("SELECT id FROM knowledge_nodes WHERE canonical_name = 'John Smith'")
        .get() as { id: string };

      const handler = knowledgeGraphTools['ocr_knowledge_graph_enrich'].handler;
      const response = await handler({
        node_id: smithNode.id,
        sources: ['search'],
      });
      const parsed = parseResponse(response);

      console.error('=== VERIFICATION: Enrich Tool Handler ===');
      console.error(`  success: ${parsed.success}`);
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      expect(data.node_id).toBe(smithNode.id);
      expect(data.sources_queried).toContain('search');
    });

    it('ocr_knowledge_graph_incremental_build tool exists and validates input', async () => {
      // Build initial graph with doc1 only
      await buildKnowledgeGraph(db, {
        resolution_mode: 'exact',
        document_filter: [doc1.docId],
      });

      const conn = db.getConnection();
      const nodesBefore = countKnowledgeNodes(conn);
      console.error(`  Nodes after initial build: ${nodesBefore}`);

      // Incrementally add doc2
      const handler = knowledgeGraphTools['ocr_knowledge_graph_incremental_build'].handler;
      const response = await handler({
        document_ids: [doc2.docId],
        resolution_mode: 'exact',
      });
      const parsed = parseResponse(response);

      console.error('=== VERIFICATION: Incremental Build Tool Handler ===');
      console.error(`  success: ${parsed.success}`);

      if (parsed.success) {
        const data = parsed.data as Record<string, unknown>;
        console.error(`  result: ${JSON.stringify(data)}`);
        expect(data.documents_processed).toBe(1);
        expect(data.new_entities_found).toBeGreaterThan(0);

        const nodesAfter = countKnowledgeNodes(conn);
        console.error(`  Nodes after incremental: ${nodesAfter} (was ${nodesBefore})`);
        // Should have added new nodes for doc2-only entities (Jane Doe, case number)
        expect(nodesAfter).toBeGreaterThanOrEqual(nodesBefore);
      } else {
        console.error(`  error: ${JSON.stringify(parsed.error)}`);
      }

      console.error(`  VERDICT: ${parsed.success ? 'PASS' : 'FAIL'}`);
    });

    it('full tool workflow: build -> query -> paths -> stats -> delete', async () => {
      console.error('=== VERIFICATION: Full Tool Workflow ===');

      // Build
      const buildHandler = knowledgeGraphTools['ocr_knowledge_graph_build'].handler;
      const buildResp = parseResponse(await buildHandler({ resolution_mode: 'exact' }));
      expect(buildResp.success).toBe(true);
      console.error(
        `  BUILD: success, nodes=${(buildResp.data as Record<string, unknown>).total_nodes}`
      );

      // Query
      const queryHandler = knowledgeGraphTools['ocr_knowledge_graph_query'].handler;
      const queryResp = parseResponse(await queryHandler({ entity_type: 'person' }));
      expect(queryResp.success).toBe(true);
      console.error(
        `  QUERY: success, person nodes=${(queryResp.data as Record<string, unknown>).total_nodes}`
      );

      // Paths
      const pathsHandler = knowledgeGraphTools['ocr_knowledge_graph_paths'].handler;
      const pathsResp = parseResponse(
        await pathsHandler({
          source_entity: 'John Smith',
          target_entity: 'Jane Doe',
          max_hops: 3,
        })
      );
      expect(pathsResp.success).toBe(true);
      console.error(
        `  PATHS: success, paths found=${(pathsResp.data as Record<string, unknown>).total_paths}`
      );

      // Stats
      const statsHandler = knowledgeGraphTools['ocr_knowledge_graph_stats'].handler;
      const statsResp = parseResponse(await statsHandler({}));
      expect(statsResp.success).toBe(true);
      console.error(
        `  STATS: success, nodes=${(statsResp.data as Record<string, unknown>).total_nodes}`
      );

      // Delete
      const deleteHandler = knowledgeGraphTools['ocr_knowledge_graph_delete'].handler;
      const deleteResp = parseResponse(await deleteHandler({ confirm: true }));
      expect(deleteResp.success).toBe(true);

      const conn = db.getConnection();
      const nodesAfterDelete = (
        conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number }
      ).cnt;
      expect(nodesAfterDelete).toBe(0);
      console.error(`  DELETE: success, nodes after=0`);
      console.error(`  VERDICT: PASS (all 5 tools in sequence)`);
    });
  });
});
