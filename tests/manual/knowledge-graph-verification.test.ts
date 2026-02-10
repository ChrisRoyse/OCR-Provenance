/**
 * MANUAL VERIFICATION: Knowledge Graph Entity Resolution & Relationship Mapping
 *
 * Full State Verification with synthetic data.
 * Source of Truth: SQLite database (knowledge_nodes, knowledge_edges,
 * node_entity_links, provenance tables)
 *
 * Tests:
 * - Pre-conditions: 3 synthetic documents with 15 entities (overlapping)
 * - Graph build: fuzzy resolution merges cross-document entities correctly
 * - Entity resolution: John Smith + John D. Smith + J. Smith -> 1 node
 * - Entity resolution: Jane Doe (Doc A) + Jane Doe (Doc C) -> 1 node
 * - Entity resolution: Smith & Associates Corp. + Corporation -> 1 node
 * - Entity resolution: New York City + New York -> 1 node (location containment)
 * - Entity resolution: 2024-CV-12345 exact match -> 1 node
 * - Co-occurrence edges between entities sharing documents
 * - Provenance: KNOWLEDGE_GRAPH records with chain_depth 2
 * - Graph query: filter by type, min_document_count
 * - Path finding: BFS between connected entities
 * - Stats: match direct DB counts
 * - Cascade delete: removing a document updates graph correctly
 * - Rebuild idempotency: delete all + rebuild -> consistent state
 * - System integration: stats, document_get, reports include knowledge graph data
 *
 * NO MOCKS. Real databases. Physical DB verification after every operation.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { knowledgeGraphTools } from '../../src/tools/knowledge-graph.js';
import { documentTools } from '../../src/tools/documents.js';
import { reportTools } from '../../src/tools/reports.js';
import { databaseTools } from '../../src/tools/database.js';
import {
  state,
  resetState,
  updateConfig,
  clearDatabase,
} from '../../src/server/state.js';
import { DatabaseService } from '../../src/services/storage/database/index.js';
import { computeHash } from '../../src/utils/hash.js';
import {
  insertEntity,
  insertEntityMention,
} from '../../src/services/storage/database/entity-operations.js';
import {
  cleanupGraphForDocument,
  deleteAllGraphData,
  getGraphStats,
} from '../../src/services/storage/database/knowledge-graph-operations.js';
import {
  buildKnowledgeGraph,
  queryGraph,
  findGraphPaths,
} from '../../src/services/knowledge-graph/graph-service.js';

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
  return mkdtempSync(join(tmpdir(), 'ocr-kg-verify-'));
}

function cleanupTempDir(dir: string): void {
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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
// SYNTHETIC DATA STRUCTURE
// =============================================================================

interface SyntheticEntity {
  entityId: string;
  entityType: string;
  rawText: string;
  normalizedText: string;
  confidence: number;
  documentId: string;
}

interface SyntheticDoc {
  docId: string;
  docProvId: string;
  ocrProvId: string;
  ocrResultId: string;
  entityExtProvId: string;
  chunkIds: string[];
  entityIds: string[];
}

/**
 * Insert a complete document chain:
 *   provenance(DOCUMENT) -> document -> provenance(OCR_RESULT) -> ocr_result
 *   -> provenance(CHUNK) -> chunk(s) -> provenance(ENTITY_EXTRACTION) -> entities
 *   -> entity_mentions (linking entities to chunks for co-location)
 *
 * @returns All IDs for verification
 */
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
  chunkCount: number = 1,
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
    id: docProvId, type: 'DOCUMENT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'FILE', source_path: `/test/${fileName}`, source_id: null,
    root_document_id: docProvId, location: null,
    content_hash: fileHash, input_hash: null, file_hash: fileHash,
    processor: 'test', processor_version: '1.0.0', processing_params: {},
    processing_duration_ms: null, processing_quality_score: null,
    parent_id: null, parent_ids: '[]', chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  // Document record
  db.insertDocument({
    id: docId, file_path: `/test/${fileName}`, file_name: fileName,
    file_hash: fileHash, file_size: text.length, file_type: 'pdf',
    status: 'complete', page_count: 1, provenance_id: docProvId,
    error_message: null, ocr_completed_at: now,
  });

  // OCR_RESULT provenance
  db.insertProvenance({
    id: ocrProvId, type: 'OCR_RESULT', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'OCR', source_path: null, source_id: docProvId,
    root_document_id: docProvId, location: null,
    content_hash: computeHash(text), input_hash: null, file_hash: null,
    processor: 'datalab-marker', processor_version: '1.0.0',
    processing_params: { mode: 'balanced' }, processing_duration_ms: 1000,
    processing_quality_score: 4.5, parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]), chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  // OCR result record
  db.insertOCRResult({
    id: ocrResultId, provenance_id: ocrProvId, document_id: docId,
    extracted_text: text, text_length: text.length,
    datalab_request_id: `req-${ocrResultId}`, datalab_mode: 'balanced',
    parse_quality_score: 4.5, page_count: 1, cost_cents: 5,
    processing_duration_ms: 1000, processing_started_at: now, processing_completed_at: now,
    json_blocks: null, content_hash: computeHash(text), extras_json: null,
  });

  // Create chunks
  const chunkIds: string[] = [];
  for (let ci = 0; ci < chunkCount; ci++) {
    const chunkId = uuidv4();
    const chunkProvId = uuidv4();
    const chunkText = `Chunk ${ci} of ${fileName}: ${text.substring(0, 100)}`;

    db.insertProvenance({
      id: chunkProvId, type: 'CHUNK', created_at: now, processed_at: now,
      source_file_created_at: null, source_file_modified_at: null,
      source_type: 'CHUNKING', source_path: null, source_id: ocrProvId,
      root_document_id: docProvId, location: null,
      content_hash: computeHash(chunkText), input_hash: null, file_hash: null,
      processor: 'chunker', processor_version: '1.0.0', processing_params: {},
      processing_duration_ms: 10, processing_quality_score: null,
      parent_id: ocrProvId, parent_ids: JSON.stringify([docProvId, ocrProvId]),
      chain_depth: 2, chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
    });

    db.insertChunk({
      id: chunkId, document_id: docId, ocr_result_id: ocrResultId,
      text: chunkText, text_hash: computeHash(chunkText),
      chunk_index: ci, character_start: ci * 200, character_end: (ci + 1) * 200,
      page_number: 1, page_range: null,
      overlap_previous: 0, overlap_next: 0,
      provenance_id: chunkProvId,
    });

    chunkIds.push(chunkId);
  }

  // ENTITY_EXTRACTION provenance
  db.insertProvenance({
    id: entityExtProvId, type: 'ENTITY_EXTRACTION', created_at: now, processed_at: now,
    source_file_created_at: null, source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION', source_path: null, source_id: ocrProvId,
    root_document_id: docProvId, location: null,
    content_hash: computeHash(`entities-${docId}`), input_hash: null, file_hash: null,
    processor: 'gemini-entity-extractor', processor_version: '1.0.0',
    processing_params: {}, processing_duration_ms: 2000,
    processing_quality_score: null, parent_id: ocrProvId,
    parent_ids: JSON.stringify([docProvId, ocrProvId]), chain_depth: 2,
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
      entity_type: ent.entityType as any,
      raw_text: ent.rawText,
      normalized_text: ent.normalizedText,
      confidence: ent.confidence,
      metadata: null,
      provenance_id: entityExtProvId,
      created_at: now,
    });

    // Create entity_mention linked to first chunk for co-location testing
    const mentionChunkId = chunkIds[ei % chunkIds.length];
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

// =============================================================================
// SYNTHETIC DATA DEFINITIONS
// =============================================================================

const DOC_A_ENTITIES = [
  { entityType: 'person', rawText: 'John Smith', normalizedText: 'john smith', confidence: 0.95 },
  { entityType: 'person', rawText: 'Jane Doe', normalizedText: 'jane doe', confidence: 0.90 },
  { entityType: 'organization', rawText: 'Smith & Associates Corp.', normalizedText: 'smith & associates corp.', confidence: 0.88 },
  { entityType: 'location', rawText: 'New York City', normalizedText: 'new york city', confidence: 0.92 },
  { entityType: 'case_number', rawText: '2024-CV-12345', normalizedText: '2024-cv-12345', confidence: 0.95 },
];

const DOC_B_ENTITIES = [
  { entityType: 'person', rawText: 'John D. Smith', normalizedText: 'john d. smith', confidence: 0.91 },
  { entityType: 'person', rawText: 'Dr. Robert Johnson', normalizedText: 'dr. robert johnson', confidence: 0.87 },
  { entityType: 'organization', rawText: 'Smith & Associates Corporation', normalizedText: 'smith & associates corporation', confidence: 0.85 },
  { entityType: 'location', rawText: 'New York', normalizedText: 'new york', confidence: 0.90 },
  { entityType: 'date', rawText: '2024-03-15', normalizedText: '2024-03-15', confidence: 0.95 },
];

const DOC_C_ENTITIES = [
  { entityType: 'person', rawText: 'J. Smith', normalizedText: 'j. smith', confidence: 0.80 },
  { entityType: 'person', rawText: 'Jane Doe', normalizedText: 'jane doe', confidence: 0.93 },
  { entityType: 'organization', rawText: 'NYPD', normalizedText: 'nypd', confidence: 0.95 },
  { entityType: 'location', rawText: 'Manhattan', normalizedText: 'manhattan', confidence: 0.88 },
  { entityType: 'case_number', rawText: '2024-CV-12345', normalizedText: '2024-cv-12345', confidence: 0.93 },
];

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Knowledge Graph Manual Verification', () => {
  let tempDir: string;
  let db: DatabaseService;

  // Store IDs for cross-test reference
  let docA: SyntheticDoc;
  let docB: SyntheticDoc;
  let docC: SyntheticDoc;

  beforeEach(() => {
    tempDir = createTempDir();
    tempDirs.push(tempDir);
    const dbName = `test-kg-${Date.now()}`;
    updateConfig({ storagePath: tempDir });
    db = DatabaseService.create(dbName, undefined, tempDir);
    state.currentDatabase = db;
    state.currentDatabaseName = dbName;

    // Insert synthetic documents with overlapping entities
    // Each doc has 2 chunks so entity mentions can share chunks for co-location
    docA = insertSyntheticDocument(
      db, 'legal-filing-alpha.pdf',
      'Legal filing regarding case 2024-CV-12345. John Smith, represented by Smith & Associates Corp., filed against Jane Doe in New York City.',
      DOC_A_ENTITIES, 2,
    );

    docB = insertSyntheticDocument(
      db, 'witness-statement-beta.pdf',
      'Witness statement from Dr. Robert Johnson. John D. Smith was observed at Smith & Associates Corporation offices in New York on 2024-03-15.',
      DOC_B_ENTITIES, 2,
    );

    docC = insertSyntheticDocument(
      db, 'police-report-gamma.pdf',
      'Police report filed by NYPD in Manhattan. J. Smith and Jane Doe are persons of interest regarding case 2024-CV-12345.',
      DOC_C_ENTITIES, 2,
    );
  });

  afterEach(() => {
    clearDatabase();
  });

  // =========================================================================
  // PRE-CONDITIONS: Verify synthetic data is properly inserted
  // =========================================================================

  describe('Pre-conditions: Verify synthetic data setup', () => {
    it('should have 3 documents in the database', () => {
      const conn = db.getConnection();
      const count = (conn.prepare('SELECT COUNT(*) as cnt FROM documents').get() as any).cnt;
      console.error('=== PRE-CONDITION: documents ===');
      console.error(`  count: ${count}`);
      expect(count).toBe(3);
    });

    it('should have 15 entities across 3 documents', () => {
      const conn = db.getConnection();
      const count = (conn.prepare('SELECT COUNT(*) as cnt FROM entities').get() as any).cnt;
      console.error('=== PRE-CONDITION: entities ===');
      console.error(`  count: ${count}`);
      expect(count).toBe(15);

      // Verify per-document counts
      const docACnt = (conn.prepare('SELECT COUNT(*) as cnt FROM entities WHERE document_id = ?').get(docA.docId) as any).cnt;
      const docBCnt = (conn.prepare('SELECT COUNT(*) as cnt FROM entities WHERE document_id = ?').get(docB.docId) as any).cnt;
      const docCCnt = (conn.prepare('SELECT COUNT(*) as cnt FROM entities WHERE document_id = ?').get(docC.docId) as any).cnt;
      console.error(`  Doc A: ${docACnt}, Doc B: ${docBCnt}, Doc C: ${docCCnt}`);
      expect(docACnt).toBe(5);
      expect(docBCnt).toBe(5);
      expect(docCCnt).toBe(5);
    });

    it('should have 15 entity_mentions linked to chunks', () => {
      const conn = db.getConnection();
      const count = (conn.prepare('SELECT COUNT(*) as cnt FROM entity_mentions').get() as any).cnt;
      console.error('=== PRE-CONDITION: entity_mentions ===');
      console.error(`  count: ${count}`);
      expect(count).toBe(15);

      // Verify mentions have chunk_ids
      const withChunks = (conn.prepare('SELECT COUNT(*) as cnt FROM entity_mentions WHERE chunk_id IS NOT NULL').get() as any).cnt;
      console.error(`  with chunk_id: ${withChunks}`);
      expect(withChunks).toBe(15);
    });

    it('should have 6 chunks total (2 per document)', () => {
      const conn = db.getConnection();
      const count = (conn.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as any).cnt;
      console.error('=== PRE-CONDITION: chunks ===');
      console.error(`  count: ${count}`);
      expect(count).toBe(6);
    });

    it('should have correct provenance chain for each document', () => {
      const conn = db.getConnection();
      for (const [label, doc] of [['A', docA], ['B', docB], ['C', docC]] as const) {
        const docProv = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(doc.docProvId) as any;
        const ocrProv = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(doc.ocrProvId) as any;
        const entityProv = conn.prepare('SELECT * FROM provenance WHERE id = ?').get(doc.entityExtProvId) as any;

        console.error(`=== PRE-CONDITION: Doc ${label} provenance chain ===`);
        console.error(`  DOCUMENT: depth=${docProv.chain_depth}, type=${docProv.type}`);
        console.error(`  OCR_RESULT: depth=${ocrProv.chain_depth}, type=${ocrProv.type}`);
        console.error(`  ENTITY_EXTRACTION: depth=${entityProv.chain_depth}, type=${entityProv.type}`);

        expect(docProv.type).toBe('DOCUMENT');
        expect(docProv.chain_depth).toBe(0);
        expect(ocrProv.type).toBe('OCR_RESULT');
        expect(ocrProv.chain_depth).toBe(1);
        expect(entityProv.type).toBe('ENTITY_EXTRACTION');
        expect(entityProv.chain_depth).toBe(2);
      }
    });

    it('knowledge graph tables should be empty before build', () => {
      const conn = db.getConnection();
      const nodes = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      const edges = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as any).cnt;
      const links = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as any).cnt;
      console.error('=== PRE-CONDITION: graph tables ===');
      console.error(`  nodes: ${nodes}, edges: ${edges}, links: ${links}`);
      expect(nodes).toBe(0);
      expect(edges).toBe(0);
      expect(links).toBe(0);
    });
  });

  // =========================================================================
  // GRAPH BUILD: Fuzzy resolution + physical DB verification
  // =========================================================================

  describe('Graph Build Verification', () => {
    it('should build knowledge graph with fuzzy resolution and verify all DB records', async () => {
      const conn = db.getConnection();

      const result = await buildKnowledgeGraph(db, {
        resolution_mode: 'fuzzy',
      });

      console.error('=== GRAPH BUILD RESULT ===');
      console.error(`  total_nodes: ${result.total_nodes}`);
      console.error(`  total_edges: ${result.total_edges}`);
      console.error(`  entities_resolved: ${result.entities_resolved}`);
      console.error(`  documents_covered: ${result.documents_covered}`);
      console.error(`  cross_document_nodes: ${result.cross_document_nodes}`);
      console.error(`  single_document_nodes: ${result.single_document_nodes}`);
      console.error(`  relationship_types: ${JSON.stringify(result.relationship_types)}`);

      // Verify return values
      expect(result.total_nodes).toBeGreaterThan(0);
      expect(result.entities_resolved).toBe(15);
      expect(result.documents_covered).toBe(3);
      expect(result.resolution_mode).toBe('fuzzy');

      // PHYSICAL VERIFICATION: knowledge_nodes table
      const nodeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      console.error(`=== SOURCE OF TRUTH: knowledge_nodes ===`);
      console.error(`  count: ${nodeCount} (matches result.total_nodes: ${nodeCount === result.total_nodes})`);
      expect(nodeCount).toBe(result.total_nodes);

      // PHYSICAL VERIFICATION: All 15 entities should be linked
      const linkCount = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as any).cnt;
      console.error(`=== SOURCE OF TRUTH: node_entity_links ===`);
      console.error(`  count: ${linkCount}`);
      expect(linkCount).toBe(15);

      // PHYSICAL VERIFICATION: knowledge_edges exist
      const edgeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as any).cnt;
      console.error(`=== SOURCE OF TRUTH: knowledge_edges ===`);
      console.error(`  count: ${edgeCount} (matches result.total_edges: ${edgeCount === result.total_edges})`);
      expect(edgeCount).toBe(result.total_edges);
      expect(edgeCount).toBeGreaterThan(0);

      // PHYSICAL VERIFICATION: provenance
      const provCount = (conn.prepare("SELECT COUNT(*) as cnt FROM provenance WHERE type = 'KNOWLEDGE_GRAPH'").get() as any).cnt;
      console.error(`=== SOURCE OF TRUTH: KNOWLEDGE_GRAPH provenance ===`);
      console.error(`  count: ${provCount}`);
      expect(provCount).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // ENTITY RESOLUTION CORRECTNESS: Physical DB verification of merging
  // =========================================================================

  describe('Entity Resolution Correctness', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('should merge "John Smith", "John D. Smith", and "J. Smith" into ONE node', () => {
      const conn = db.getConnection();

      // Query ALL person nodes containing "smith" (excluding jane)
      const allPersonNodes = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'person'"
      ).all() as any[];

      console.error('=== ENTITY RESOLUTION: John Smith variants ===');
      for (const node of allPersonNodes) {
        console.error(`  node: "${node.canonical_name}" (normalized: "${node.normalized_name}"), doc_count=${node.document_count}, mention_count=${node.mention_count}`);
      }

      const smithNodes = allPersonNodes.filter(n =>
        n.canonical_name.toLowerCase().includes('smith') &&
        !n.canonical_name.toLowerCase().includes('jane')
      );

      // John Smith + John D. Smith + J. Smith should be ONE merged node
      expect(smithNodes).toHaveLength(1);
      const smithNode = smithNodes[0];

      // Should reference 3 documents (one variant per document)
      expect(smithNode.document_count).toBe(3);
      expect(smithNode.mention_count).toBe(3);

      // Canonical name should be highest-confidence: "John Smith" at 0.95
      expect(smithNode.canonical_name).toBe('John Smith');

      // PHYSICAL: Check node_entity_links for this node
      const links = conn.prepare(
        'SELECT nel.*, e.raw_text, e.document_id FROM node_entity_links nel JOIN entities e ON e.id = nel.entity_id WHERE nel.node_id = ?'
      ).all(smithNode.id) as any[];
      console.error('=== SOURCE OF TRUTH: node_entity_links for John Smith ===');
      for (const link of links) {
        console.error(`  entity: "${link.raw_text}", doc: ${link.document_id}, similarity: ${link.similarity_score}`);
      }
      expect(links).toHaveLength(3);

      // Verify each link points to a different document
      const linkedDocIds = new Set(links.map((l: any) => l.document_id));
      expect(linkedDocIds.size).toBe(3);
    });

    it('should merge "Jane Doe" entities from Doc A and Doc C into ONE node', () => {
      const conn = db.getConnection();

      const janeDoeNodes = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'person' AND normalized_name LIKE '%jane doe%'"
      ).all() as any[];

      console.error('=== ENTITY RESOLUTION: Jane Doe ===');
      for (const node of janeDoeNodes) {
        console.error(`  node: "${node.canonical_name}", doc_count=${node.document_count}`);
      }

      expect(janeDoeNodes).toHaveLength(1);
      // Exact text match across 2 documents
      expect(janeDoeNodes[0].document_count).toBe(2);
      // Canonical name should be highest-confidence version (Doc C at 0.93)
      expect(janeDoeNodes[0].canonical_name).toBe('Jane Doe');

      // PHYSICAL: Check linked entities
      const links = conn.prepare(
        'SELECT nel.*, e.document_id FROM node_entity_links nel JOIN entities e ON e.id = nel.entity_id WHERE nel.node_id = ?'
      ).all(janeDoeNodes[0].id) as any[];
      expect(links).toHaveLength(2);
      const docIds = new Set(links.map((l: any) => l.document_id));
      expect(docIds.has(docA.docId)).toBe(true);
      expect(docIds.has(docC.docId)).toBe(true);
    });

    it('should merge "Smith & Associates Corp." and "Smith & Associates Corporation" into ONE node', () => {
      const conn = db.getConnection();

      const orgNodes = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'organization' AND normalized_name LIKE '%smith%'"
      ).all() as any[];

      console.error('=== ENTITY RESOLUTION: Smith & Associates variants ===');
      for (const node of orgNodes) {
        console.error(`  node: "${node.canonical_name}" (normalized: "${node.normalized_name}"), doc_count=${node.document_count}, aliases=${node.aliases}`);
      }

      expect(orgNodes).toHaveLength(1);
      expect(orgNodes[0].document_count).toBe(2);

      // Canonical name should be from Doc A (higher confidence 0.88 vs 0.85)
      expect(orgNodes[0].canonical_name).toBe('Smith & Associates Corp.');

      // Should have alias for the other variant
      const aliases = JSON.parse(orgNodes[0].aliases || '[]');
      console.error(`  aliases: ${JSON.stringify(aliases)}`);
      expect(aliases).toContain('Smith & Associates Corporation');
    });

    it('should merge "New York City" and "New York" into ONE node (location containment)', () => {
      const conn = db.getConnection();

      const nyNodes = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'location' AND normalized_name LIKE '%new york%'"
      ).all() as any[];

      console.error('=== ENTITY RESOLUTION: New York variants ===');
      for (const node of nyNodes) {
        console.error(`  node: "${node.canonical_name}" (normalized: "${node.normalized_name}"), doc_count=${node.document_count}`);
      }

      // "New York City" contains "New York" -> locationContains returns true -> merge
      expect(nyNodes).toHaveLength(1);
      expect(nyNodes[0].document_count).toBe(2);
    });

    it('should merge identical case numbers "2024-CV-12345" into ONE node', () => {
      const conn = db.getConnection();

      const caseNodes = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'case_number' AND normalized_name LIKE '%12345%'"
      ).all() as any[];

      console.error('=== ENTITY RESOLUTION: Case Number ===');
      for (const node of caseNodes) {
        console.error(`  node: "${node.canonical_name}", doc_count=${node.document_count}`);
      }

      expect(caseNodes).toHaveLength(1);
      expect(caseNodes[0].document_count).toBe(2);
      // Exact text match
      expect(caseNodes[0].canonical_name).toBe('2024-CV-12345');

      // PHYSICAL: verify links
      const links = conn.prepare(
        'SELECT nel.*, e.document_id FROM node_entity_links nel JOIN entities e ON e.id = nel.entity_id WHERE nel.node_id = ?'
      ).all(caseNodes[0].id) as any[];
      expect(links).toHaveLength(2);
      const docIds = new Set(links.map((l: any) => l.document_id));
      expect(docIds.has(docA.docId)).toBe(true);
      expect(docIds.has(docC.docId)).toBe(true);
    });

    it('should keep "Manhattan" and "NYPD" and "Dr. Robert Johnson" as separate single-document nodes', () => {
      const conn = db.getConnection();

      const manhattan = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE normalized_name LIKE '%manhattan%'"
      ).all() as any[];
      console.error('=== SINGLE-DOC NODES ===');
      console.error(`  Manhattan: ${manhattan.length} node(s), doc_count=${manhattan[0]?.document_count}`);
      expect(manhattan).toHaveLength(1);
      expect(manhattan[0].document_count).toBe(1);

      const nypd = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE normalized_name LIKE '%nypd%'"
      ).all() as any[];
      console.error(`  NYPD: ${nypd.length} node(s), doc_count=${nypd[0]?.document_count}`);
      expect(nypd).toHaveLength(1);
      expect(nypd[0].document_count).toBe(1);

      const robert = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE normalized_name LIKE '%robert%'"
      ).all() as any[];
      console.error(`  Dr. Robert Johnson: ${robert.length} node(s), doc_count=${robert[0]?.document_count}`);
      expect(robert).toHaveLength(1);
      expect(robert[0].document_count).toBe(1);

      const date = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'date'"
      ).all() as any[];
      console.error(`  2024-03-15: ${date.length} node(s), doc_count=${date[0]?.document_count}`);
      expect(date).toHaveLength(1);
      expect(date[0].document_count).toBe(1);
    });

    it('should have correct total node count after resolution', () => {
      const conn = db.getConnection();

      // Expected merged nodes:
      // 1. John Smith (3 entities merged) -> 1 node
      // 2. Jane Doe (2 entities merged) -> 1 node
      // 3. Dr. Robert Johnson -> 1 node
      // 4. Smith & Associates (2 entities merged) -> 1 node
      // 5. NYPD -> 1 node
      // 6. New York City/New York (2 entities merged) -> 1 node
      // 7. Manhattan -> 1 node
      // 8. 2024-CV-12345 (2 entities merged) -> 1 node
      // 9. 2024-03-15 -> 1 node
      // Total: 9 nodes from 15 entities

      const totalNodes = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      console.error('=== TOTAL NODE COUNT ===');
      console.error(`  expected: 9, actual: ${totalNodes}`);
      expect(totalNodes).toBe(9);
    });
  });

  // =========================================================================
  // CO-OCCURRENCE EDGE VERIFICATION
  // =========================================================================

  describe('Co-occurrence Edge Verification', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('should have co_mentioned edges between entities sharing documents', () => {
      const conn = db.getConnection();

      const coMentionedEdges = conn.prepare(
        "SELECT * FROM knowledge_edges WHERE relationship_type = 'co_mentioned'"
      ).all() as any[];

      console.error('=== CO-OCCURRENCE EDGES ===');
      console.error(`  co_mentioned edges: ${coMentionedEdges.length}`);
      expect(coMentionedEdges.length).toBeGreaterThan(0);

      // Each edge should have valid document_ids JSON
      for (const edge of coMentionedEdges) {
        const docIds = JSON.parse(edge.document_ids);
        expect(Array.isArray(docIds)).toBe(true);
        expect(docIds.length).toBeGreaterThan(0);
        console.error(`  edge: ${edge.source_node_id.slice(0, 8)}..${edge.target_node_id.slice(0, 8)} weight=${edge.weight} docs=${docIds.length}`);
      }
    });

    it('should have edges with correct weight calculation (0 < weight <= 1)', () => {
      const conn = db.getConnection();

      const edges = conn.prepare('SELECT * FROM knowledge_edges').all() as any[];
      console.error('=== EDGE WEIGHTS ===');
      for (const edge of edges) {
        console.error(`  ${edge.relationship_type}: weight=${edge.weight}, evidence=${edge.evidence_count}`);
        expect(edge.weight).toBeGreaterThan(0);
        expect(edge.weight).toBeLessThanOrEqual(1);
      }
    });

    it('should have co_located edges for entities sharing chunks', () => {
      const conn = db.getConnection();

      const coLocatedEdges = conn.prepare(
        "SELECT * FROM knowledge_edges WHERE relationship_type = 'co_located'"
      ).all() as any[];

      console.error('=== CO-LOCATED EDGES ===');
      console.error(`  co_located edges: ${coLocatedEdges.length}`);

      // With 2 chunks per doc and 5 entities per doc, some entities share chunks
      // Entities at indices 0,2,4 share chunk[0] and 1,3 share chunk[1]
      // After resolution, nodes that share chunks across documents should have co_located edges
      if (coLocatedEdges.length > 0) {
        for (const edge of coLocatedEdges) {
          const meta = JSON.parse(edge.metadata || '{}');
          console.error(`  edge weight=${edge.weight}, shared_chunks=${meta.shared_chunk_ids?.length || 0}`);
          expect(edge.weight).toBeGreaterThan(0);
          // co_located weight should have 1.5x boost capped at 1.0
          expect(edge.weight).toBeLessThanOrEqual(1.0);
        }
      }
    });
  });

  // =========================================================================
  // PROVENANCE VERIFICATION
  // =========================================================================

  describe('Provenance Verification', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('should have KNOWLEDGE_GRAPH provenance record(s)', () => {
      const conn = db.getConnection();

      const provRecords = conn.prepare(
        "SELECT * FROM provenance WHERE type = 'KNOWLEDGE_GRAPH'"
      ).all() as any[];

      console.error('=== KNOWLEDGE_GRAPH PROVENANCE ===');
      for (const prov of provRecords) {
        console.error(`  id=${prov.id}, processor=${prov.processor}, chain_depth=${prov.chain_depth}, source_type=${prov.source_type}`);
      }

      expect(provRecords.length).toBeGreaterThanOrEqual(1);
      // Main provenance uses 'knowledge-graph-builder', per-node provenance uses 'entity-resolution'
      const validProcessors = ['knowledge-graph-builder', 'entity-resolution'];
      for (const prov of provRecords) {
        expect(validProcessors).toContain(prov.processor);
        expect(prov.processor_version).toBe('1.0.0');
        expect(prov.source_type).toBe('KNOWLEDGE_GRAPH');
        expect(prov.content_hash).toBeTruthy();
      }
      // At least one main provenance record must exist
      const mainRecords = provRecords.filter((p: Record<string, unknown>) => p.processor === 'knowledge-graph-builder');
      expect(mainRecords.length).toBeGreaterThanOrEqual(1);
    });

    it('all knowledge_nodes should reference valid provenance', () => {
      const conn = db.getConnection();

      const orphans = conn.prepare(`
        SELECT kn.id, kn.canonical_name FROM knowledge_nodes kn
        LEFT JOIN provenance p ON kn.provenance_id = p.id
        WHERE p.id IS NULL
      `).all() as any[];

      console.error('=== PROVENANCE INTEGRITY CHECK ===');
      console.error(`  orphaned nodes (no provenance): ${orphans.length}`);
      if (orphans.length > 0) {
        for (const o of orphans) {
          console.error(`  ORPHAN: ${o.canonical_name} (${o.id})`);
        }
      }
      expect(orphans).toHaveLength(0);
    });

    it('all knowledge_edges should reference valid provenance', () => {
      const conn = db.getConnection();

      const orphanEdges = conn.prepare(`
        SELECT ke.id, ke.relationship_type FROM knowledge_edges ke
        LEFT JOIN provenance p ON ke.provenance_id = p.id
        WHERE p.id IS NULL
      `).all() as any[];

      console.error('=== EDGE PROVENANCE INTEGRITY ===');
      console.error(`  orphaned edges (no provenance): ${orphanEdges.length}`);
      expect(orphanEdges).toHaveLength(0);
    });

    it('all node_entity_links should reference valid nodes AND valid entities', () => {
      const conn = db.getConnection();

      const brokenNodeLinks = conn.prepare(`
        SELECT nel.id FROM node_entity_links nel
        LEFT JOIN knowledge_nodes kn ON nel.node_id = kn.id
        WHERE kn.id IS NULL
      `).all() as any[];

      const brokenEntityLinks = conn.prepare(`
        SELECT nel.id FROM node_entity_links nel
        LEFT JOIN entities e ON nel.entity_id = e.id
        WHERE e.id IS NULL
      `).all() as any[];

      console.error('=== LINK INTEGRITY CHECK ===');
      console.error(`  broken node refs: ${brokenNodeLinks.length}`);
      console.error(`  broken entity refs: ${brokenEntityLinks.length}`);
      expect(brokenNodeLinks).toHaveLength(0);
      expect(brokenEntityLinks).toHaveLength(0);
    });
  });

  // =========================================================================
  // GRAPH QUERY VERIFICATION
  // =========================================================================

  describe('Graph Query Verification', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('queryGraph returns expected node/edge structure', () => {
      const result = queryGraph(db, { include_edges: true });

      console.error('=== QUERY GRAPH: all nodes ===');
      console.error(`  total_nodes: ${result.total_nodes}, total_edges: ${result.total_edges}`);
      expect(result.total_nodes).toBeGreaterThan(0);
      expect(result.nodes.length).toBeGreaterThan(0);

      // Verify node structure
      for (const node of result.nodes) {
        expect(node.id).toBeTruthy();
        expect(node.entity_type).toBeTruthy();
        expect(node.canonical_name).toBeTruthy();
        expect(typeof node.document_count).toBe('number');
        expect(typeof node.mention_count).toBe('number');
        expect(typeof node.avg_confidence).toBe('number');
      }

      // Verify edge structure
      for (const edge of result.edges) {
        expect(edge.id).toBeTruthy();
        expect(edge.source).toBeTruthy();
        expect(edge.target).toBeTruthy();
        expect(edge.relationship_type).toBeTruthy();
        expect(typeof edge.weight).toBe('number');
      }
    });

    it('filtering by entity_type returns only matching nodes', () => {
      const result = queryGraph(db, { entity_type: 'person' });

      console.error('=== QUERY GRAPH: person only ===');
      console.error(`  nodes: ${result.total_nodes}`);
      for (const node of result.nodes) {
        console.error(`  ${node.canonical_name} (${node.entity_type})`);
        expect(node.entity_type).toBe('person');
      }
      // Should have 3 person nodes: John Smith, Jane Doe, Dr. Robert Johnson
      expect(result.total_nodes).toBe(3);
    });

    it('filtering by min_document_count=2 excludes single-doc nodes', () => {
      const result = queryGraph(db, { min_document_count: 2 });

      console.error('=== QUERY GRAPH: min_document_count=2 ===');
      console.error(`  nodes: ${result.total_nodes}`);
      for (const node of result.nodes) {
        console.error(`  ${node.canonical_name}: doc_count=${node.document_count}`);
        expect(node.document_count).toBeGreaterThanOrEqual(2);
      }

      // Cross-document nodes: John Smith(3), Jane Doe(2), Smith & Associates(2), New York(2), 2024-CV-12345(2)
      expect(result.total_nodes).toBe(5);
    });

    it('filtering by entity_name finds matching nodes', () => {
      const result = queryGraph(db, { entity_name: 'Smith' });

      console.error('=== QUERY GRAPH: name=Smith ===');
      for (const node of result.nodes) {
        console.error(`  ${node.canonical_name} (${node.entity_type})`);
      }
      // Should find "John Smith" and "Smith & Associates Corp."
      expect(result.total_nodes).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // PATH FINDING VERIFICATION
  // =========================================================================

  describe('Path Finding Verification', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('finds paths between entities sharing documents', () => {
      // John Smith and Jane Doe both appear in Doc A and Doc C
      // They should be connected via co_mentioned edges
      const result = findGraphPaths(db, 'John Smith', 'Jane Doe', { max_hops: 3 });

      console.error('=== PATH FINDING: John Smith -> Jane Doe ===');
      console.error(`  paths found: ${result.total_paths}`);
      console.error(`  source: ${result.source.canonical_name} (${result.source.entity_type})`);
      console.error(`  target: ${result.target.canonical_name} (${result.target.entity_type})`);

      expect(result.paths.length).toBeGreaterThan(0);
      expect(result.source.canonical_name).toBe('John Smith');
      expect(result.target.canonical_name).toBe('Jane Doe');

      // Verify path structure
      for (const path of result.paths) {
        console.error(`  path length=${path.length}, nodes=${path.nodes.map(n => n.canonical_name).join(' -> ')}`);
        expect(path.length).toBeGreaterThan(0);
        expect(path.nodes.length).toBeGreaterThanOrEqual(2);
        expect(path.edges.length).toBeGreaterThan(0);
      }
    });

    it('finds paths between entities in different documents via shared nodes', () => {
      // Dr. Robert Johnson (Doc B only) and NYPD (Doc C only)
      // These may connect via John Smith (all 3 docs) or other shared nodes
      const result = findGraphPaths(db, 'Dr. Robert Johnson', 'NYPD', { max_hops: 4 });

      console.error('=== PATH FINDING: Dr. Robert Johnson -> NYPD ===');
      console.error(`  paths found: ${result.total_paths}`);

      if (result.paths.length > 0) {
        for (const path of result.paths) {
          console.error(`  path: ${path.nodes.map(n => n.canonical_name).join(' -> ')}`);
        }
        expect(result.paths[0].length).toBeGreaterThanOrEqual(2); // At least 2 hops
      }
      // If no path found, that's also valid (they may not be connected via shared docs)
    });

    it('throws error for nonexistent entity', () => {
      expect(() =>
        findGraphPaths(db, 'Nonexistent Person', 'Jane Doe')
      ).toThrow('Source entity not found');
    });
  });

  // =========================================================================
  // GRAPH STATS VERIFICATION
  // =========================================================================

  describe('Graph Stats Verification', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('stats match direct database queries', () => {
      const conn = db.getConnection();
      const stats = getGraphStats(conn);

      // Direct counts
      const directNodeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      const directEdgeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as any).cnt;
      const directLinkCount = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as any).cnt;
      const directCrossDoc = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE document_count > 1').get() as any).cnt;
      const directDocsCovered = (conn.prepare('SELECT COUNT(DISTINCT document_id) as cnt FROM node_entity_links').get() as any).cnt;

      console.error('=== GRAPH STATS vs DIRECT COUNTS ===');
      console.error(`  nodes: stats=${stats.total_nodes}, direct=${directNodeCount}`);
      console.error(`  edges: stats=${stats.total_edges}, direct=${directEdgeCount}`);
      console.error(`  links: stats=${stats.total_links}, direct=${directLinkCount}`);
      console.error(`  cross_doc: stats=${stats.cross_document_nodes}, direct=${directCrossDoc}`);
      console.error(`  docs_covered: stats=${stats.documents_covered}, direct=${directDocsCovered}`);

      expect(stats.total_nodes).toBe(directNodeCount);
      expect(stats.total_edges).toBe(directEdgeCount);
      expect(stats.total_links).toBe(directLinkCount);
      expect(stats.cross_document_nodes).toBe(directCrossDoc);
      expect(stats.documents_covered).toBe(directDocsCovered);
      expect(stats.documents_covered).toBe(3);

      // nodes_by_type should sum to total_nodes
      const nodesByTypeSum = Object.values(stats.nodes_by_type).reduce((a, b) => a + b, 0);
      expect(nodesByTypeSum).toBe(stats.total_nodes);

      // most_connected_nodes should not exceed total nodes
      expect(stats.most_connected_nodes.length).toBeLessThanOrEqual(stats.total_nodes);
    });
  });

  // =========================================================================
  // CASCADE DELETE VERIFICATION
  // =========================================================================

  describe('Cascade Delete Verification', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('deleting a document updates graph correctly', () => {
      const conn = db.getConnection();

      // Store counts before
      const nodeCountBefore = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      const linkCountBefore = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as any).cnt;
      const edgeCountBefore = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as any).cnt;

      console.error('=== CASCADE DELETE: BEFORE ===');
      console.error(`  nodes: ${nodeCountBefore}, links: ${linkCountBefore}, edges: ${edgeCountBefore}`);

      // Delete Doc C (has J. Smith, Jane Doe, NYPD, Manhattan, 2024-CV-12345)
      const result = cleanupGraphForDocument(conn, docC.docId);

      console.error('=== CASCADE DELETE: RESULT ===');
      console.error(`  links_deleted: ${result.links_deleted}, nodes_deleted: ${result.nodes_deleted}, edges_deleted: ${result.edges_deleted}`);

      // Verify links decreased (Doc C had 5 entities)
      const linkCountAfter = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as any).cnt;
      console.error(`  links: before=${linkCountBefore}, after=${linkCountAfter}`);
      expect(linkCountAfter).toBe(linkCountBefore - result.links_deleted);

      // Manhattan and NYPD should be deleted (single-doc nodes only in Doc C)
      const manhattan = conn.prepare("SELECT * FROM knowledge_nodes WHERE normalized_name LIKE '%manhattan%'").all();
      expect(manhattan).toHaveLength(0);

      const nypd = conn.prepare("SELECT * FROM knowledge_nodes WHERE normalized_name LIKE '%nypd%'").all();
      expect(nypd).toHaveLength(0);

      console.error('=== CASCADE DELETE: AFTER - single-doc node removal verified ===');

      // John Smith node should still exist but with document_count = 2 (was 3)
      const smithNode = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'person' AND normalized_name LIKE '%john%smith%'"
      ).all() as any[];
      console.error(`  John Smith: ${smithNode.length} node(s), doc_count=${smithNode[0]?.document_count}`);
      expect(smithNode).toHaveLength(1);
      expect(smithNode[0].document_count).toBe(2);

      // Jane Doe should exist with document_count = 1 (was 2)
      const janeDoe = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE normalized_name LIKE '%jane doe%'"
      ).all() as any[];
      console.error(`  Jane Doe: ${janeDoe.length} node(s), doc_count=${janeDoe[0]?.document_count}`);
      expect(janeDoe).toHaveLength(1);
      expect(janeDoe[0].document_count).toBe(1);

      // Case node should exist with document_count = 1 (was 2)
      const caseNode = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'case_number'"
      ).all() as any[];
      console.error(`  Case 2024-CV-12345: ${caseNode.length} node(s), doc_count=${caseNode[0]?.document_count}`);
      expect(caseNode).toHaveLength(1);
      expect(caseNode[0].document_count).toBe(1);
    });
  });

  // =========================================================================
  // REBUILD IDEMPOTENCY
  // =========================================================================

  describe('Rebuild Idempotency', () => {
    it('rebuild produces consistent graph after full delete', async () => {
      const conn = db.getConnection();

      // Build first time
      const firstBuild = await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
      const firstNodeCount = firstBuild.total_nodes;
      const firstEdgeCount = firstBuild.total_edges;

      console.error('=== REBUILD: FIRST BUILD ===');
      console.error(`  nodes: ${firstNodeCount}, edges: ${firstEdgeCount}`);

      // Delete all graph data
      deleteAllGraphData(conn);

      // Also clean up the provenance record so rebuild works
      conn.prepare("DELETE FROM provenance WHERE type = 'KNOWLEDGE_GRAPH'").run();

      // Verify clean state
      const nodeCountAfterDelete = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      const edgeCountAfterDelete = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as any).cnt;
      console.error('=== REBUILD: AFTER DELETE ===');
      console.error(`  nodes: ${nodeCountAfterDelete}, edges: ${edgeCountAfterDelete}`);
      expect(nodeCountAfterDelete).toBe(0);
      expect(edgeCountAfterDelete).toBe(0);

      // Rebuild
      const secondBuild = await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      console.error('=== REBUILD: SECOND BUILD ===');
      console.error(`  nodes: ${secondBuild.total_nodes}, edges: ${secondBuild.total_edges}`);

      // Physical verification
      const nodeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      expect(nodeCount).toBe(secondBuild.total_nodes);

      // Node and edge counts should be the same as first build
      // (same input data, same resolution mode -> deterministic output)
      expect(secondBuild.total_nodes).toBe(firstNodeCount);
      expect(secondBuild.total_edges).toBe(firstEdgeCount);
    });

    it('rebuild=true flag clears and rebuilds in one step', async () => {
      const conn = db.getConnection();

      // Build first time
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      // Rebuild using the flag (should clear + rebuild)
      const result = await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy', rebuild: true });

      console.error('=== REBUILD FLAG ===');
      console.error(`  nodes: ${result.total_nodes}, edges: ${result.total_edges}`);

      // Physical verification
      const nodeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      expect(nodeCount).toBe(result.total_nodes);
      expect(result.total_nodes).toBe(9);
      expect(result.entities_resolved).toBe(15);
    });
  });

  // =========================================================================
  // TOOL HANDLER VERIFICATION (via MCP handlers)
  // =========================================================================

  describe('Tool Handlers: build, query, node, paths, stats, delete', () => {
    it('ocr_knowledge_graph_build succeeds with tool handler', async () => {
      const handler = knowledgeGraphTools['ocr_knowledge_graph_build'].handler;
      const response = await handler({ resolution_mode: 'fuzzy' });
      const parsed = parseResponse(response);

      console.error('=== TOOL: build ===');
      console.error(`  success: ${parsed.success}`);
      expect(parsed.success).toBe(true);

      const data = parsed.data as Record<string, unknown>;
      expect(data.total_nodes).toBe(9);
      expect(data.entities_resolved).toBe(15);
      expect(data.documents_covered).toBe(3);
    });

    it('ocr_knowledge_graph_query returns nodes via tool handler', async () => {
      // Build first
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      const handler = knowledgeGraphTools['ocr_knowledge_graph_query'].handler;
      const response = await handler({ entity_type: 'person', include_edges: true });
      const parsed = parseResponse(response);

      console.error('=== TOOL: query person ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      expect(data.total_nodes).toBe(3);
    });

    it('ocr_knowledge_graph_node returns detailed node info', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
      const conn = db.getConnection();

      // Get the John Smith node
      const smithNode = conn.prepare(
        "SELECT id FROM knowledge_nodes WHERE canonical_name = 'John Smith'"
      ).get() as { id: string };

      const handler = knowledgeGraphTools['ocr_knowledge_graph_node'].handler;
      const response = await handler({ node_id: smithNode.id, include_mentions: true, include_provenance: true });
      const parsed = parseResponse(response);

      console.error('=== TOOL: node detail ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      const node = data.node as Record<string, unknown>;
      expect(node.canonical_name).toBe('John Smith');
      expect(node.document_count).toBe(3);

      const members = data.member_entities as Array<Record<string, unknown>>;
      expect(members).toHaveLength(3);
    });

    it('ocr_knowledge_graph_paths returns path via tool handler', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      const handler = knowledgeGraphTools['ocr_knowledge_graph_paths'].handler;
      const response = await handler({ source_entity: 'John Smith', target_entity: 'Jane Doe', max_hops: 3 });
      const parsed = parseResponse(response);

      console.error('=== TOOL: paths ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      const paths = data.paths as Array<Record<string, unknown>>;
      expect(paths.length).toBeGreaterThan(0);
    });

    it('ocr_knowledge_graph_stats returns statistics', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      const handler = knowledgeGraphTools['ocr_knowledge_graph_stats'].handler;
      const response = await handler({});
      const parsed = parseResponse(response);

      console.error('=== TOOL: stats ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      expect(data.total_nodes).toBe(9);
      expect(data.documents_covered).toBe(3);
    });

    it('ocr_knowledge_graph_delete removes all data and verifies in DB', async () => {
      const conn = db.getConnection();
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      // Verify graph exists
      const beforeNodes = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      expect(beforeNodes).toBe(9);

      const handler = knowledgeGraphTools['ocr_knowledge_graph_delete'].handler;
      const response = await handler({ confirm: true });
      const parsed = parseResponse(response);

      console.error('=== TOOL: delete ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      expect(data.deleted).toBe(true);

      // PHYSICAL: verify everything is gone
      const afterNodes = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      const afterEdges = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as any).cnt;
      const afterLinks = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as any).cnt;
      console.error(`  after delete: nodes=${afterNodes}, edges=${afterEdges}, links=${afterLinks}`);
      expect(afterNodes).toBe(0);
      expect(afterEdges).toBe(0);
      expect(afterLinks).toBe(0);
    });

    it('ocr_knowledge_graph_build fails with "already exists" when not using rebuild', async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      const handler = knowledgeGraphTools['ocr_knowledge_graph_build'].handler;
      const response = await handler({ resolution_mode: 'fuzzy' });
      const parsed = parseResponse(response);

      console.error('=== TOOL: build when already exists ===');
      expect(parsed.error).toBeDefined();
      expect(parsed.error!.message).toContain('already exists');
    });
  });

  // =========================================================================
  // SYSTEM INTEGRATION: Stats, Document Get, Reports
  // =========================================================================

  describe('System Integration: knowledge graph in stats/reports/document_get', () => {
    beforeEach(async () => {
      await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });
    });

    it('ocr_db_stats includes knowledge graph counts', async () => {
      const handler = databaseTools['ocr_db_stats'].handler;
      const response = await handler({});
      const parsed = parseResponse(response);

      console.error('=== INTEGRATION: db_stats ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      console.error(`  total_knowledge_nodes: ${data.total_knowledge_nodes}`);
      console.error(`  total_knowledge_edges: ${data.total_knowledge_edges}`);
      expect(data.total_knowledge_nodes).toBe(9);
      expect((data.total_knowledge_edges as number)).toBeGreaterThan(0);
    });

    it('ocr_document_get includes knowledge_graph membership', async () => {
      const handler = documentTools['ocr_document_get'].handler;
      const response = await handler({ document_id: docA.docId });
      const parsed = parseResponse(response);

      console.error('=== INTEGRATION: document_get ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      const kg = data.knowledge_graph as Record<string, unknown> | undefined;
      console.error(`  knowledge_graph: ${JSON.stringify(kg)}`);

      expect(kg).toBeDefined();
      const nodes = kg!.nodes as Array<Record<string, unknown>>;
      expect(nodes.length).toBeGreaterThan(0);
      // Doc A has 5 entities -> 5 nodes (some cross-document)
      expect(nodes.length).toBe(5);
      expect(kg!.cross_document_relationships).toBeGreaterThan(0);
    });

    it('ocr_quality_summary includes knowledge_graph metrics', async () => {
      const handler = reportTools['ocr_quality_summary'].handler;
      const response = await handler({});
      const parsed = parseResponse(response);

      console.error('=== INTEGRATION: quality_summary ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      const kg = data.knowledge_graph as Record<string, unknown>;
      console.error(`  knowledge_graph: ${JSON.stringify(kg)}`);
      expect(kg).toBeDefined();
      expect(kg.entities_resolved).toBeGreaterThan(0);
    });

    it('ocr_cost_summary includes knowledge_graph_build metrics', async () => {
      const handler = reportTools['ocr_cost_summary'].handler;
      const response = await handler({ group_by: 'total' });
      const parsed = parseResponse(response);

      console.error('=== INTEGRATION: cost_summary ===');
      expect(parsed.success).toBe(true);
      const data = parsed.data as Record<string, unknown>;
      const kgBuild = data.knowledge_graph_build as Record<string, unknown>;
      console.error(`  knowledge_graph_build: ${JSON.stringify(kgBuild)}`);
      expect(kgBuild).toBeDefined();
      expect(kgBuild.total_builds).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // EDGE CASES
  // =========================================================================

  describe('Edge Cases', () => {
    it('building graph with no entities fails gracefully', async () => {
      const conn = db.getConnection();
      // Delete all entities
      conn.prepare('DELETE FROM entity_mentions').run();
      conn.prepare('DELETE FROM entities').run();

      // Verify no entities
      const entityCount = (conn.prepare('SELECT COUNT(*) as cnt FROM entities').get() as any).cnt;
      expect(entityCount).toBe(0);

      // Build should fail
      await expect(
        buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' })
      ).rejects.toThrow('No entities found');

      // No graph data should exist
      const nodeCount = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as any).cnt;
      expect(nodeCount).toBe(0);
    });

    it('exact resolution mode does not merge fuzzy variants', async () => {
      const conn = db.getConnection();

      const result = await buildKnowledgeGraph(db, { resolution_mode: 'exact' });

      console.error('=== EXACT MODE ===');
      console.error(`  total_nodes: ${result.total_nodes}`);

      // In exact mode, "john smith", "john d. smith", and "j. smith" stay separate
      // Only "jane doe"(A)+"jane doe"(C) and "2024-cv-12345"(A)+"2024-cv-12345"(C) merge
      // That leaves more nodes than fuzzy mode
      expect(result.total_nodes).toBeGreaterThan(9); // Fuzzy produces 9, exact produces more

      // Specifically: "john smith", "john d. smith", "j. smith" should be separate
      const smithPersonNodes = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE entity_type = 'person' AND normalized_name LIKE '%smith%' AND normalized_name NOT LIKE '%jane%'"
      ).all() as any[];
      console.error(`  John Smith variants (exact mode): ${smithPersonNodes.length}`);
      expect(smithPersonNodes.length).toBe(3); // Not merged

      // But exact matches still merge
      const janeDoeNodes = conn.prepare(
        "SELECT * FROM knowledge_nodes WHERE normalized_name = 'jane doe'"
      ).all() as any[];
      console.error(`  Jane Doe nodes (exact mode): ${janeDoeNodes.length}`);
      expect(janeDoeNodes).toHaveLength(1);
      expect(janeDoeNodes[0].document_count).toBe(2);
    });

    it('graph with single document still works', async () => {
      const conn = db.getConnection();
      // Delete doc B and C entities, mentions, and related data
      for (const doc of [docB, docC]) {
        conn.prepare('DELETE FROM entity_mentions WHERE document_id = ?').run(doc.docId);
        conn.prepare('DELETE FROM entities WHERE document_id = ?').run(doc.docId);
        conn.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.docId);
        conn.prepare('DELETE FROM ocr_results WHERE document_id = ?').run(doc.docId);
        conn.prepare('DELETE FROM documents WHERE id = ?').run(doc.docId);
      }

      const result = await buildKnowledgeGraph(db, { resolution_mode: 'fuzzy' });

      console.error('=== SINGLE DOCUMENT GRAPH ===');
      console.error(`  nodes: ${result.total_nodes}, edges: ${result.total_edges}, docs: ${result.documents_covered}`);

      expect(result.total_nodes).toBe(5); // 5 entities in doc A, each unique type
      expect(result.documents_covered).toBe(1);
      // All nodes are single-document
      expect(result.cross_document_nodes).toBe(0);
      expect(result.single_document_nodes).toBe(5);
    });
  });
});
