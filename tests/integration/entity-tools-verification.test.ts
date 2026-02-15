/**
 * SHERLOCK HOLMES FORENSIC VERIFICATION
 * Entity Search, Entity Dossier, Entity Extraction Stats
 *
 * Target database: bridginglife-benchmark
 * Ground Truth: 322 entities, 4580 mentions, 294 KG nodes
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';

// Import tool handlers
import { entityAnalysisTools } from '../../src/tools/entity-analysis.js';
import { selectDatabase } from '../../src/server/state.js';

// ═══════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH CONSTANTS (from raw SQL queries)
// ═══════════════════════════════════════════════════════════════════════════════

const DB_NAME = 'bridginglife-benchmark';
const DB_PATH = join(homedir(), '.ocr-provenance/databases');
const DB_FILE = join(DB_PATH, `${DB_NAME}.db`);

// Boston entities in DB (ordered by confidence DESC)
const BOSTON_ENTITY_IDS = [
  'd6e817fb-bd52-4fc0-8edc-78f9950e283e', // Boston, Colleen (person, 1.0)
  '27decfc8-472b-4f6f-ba1a-6ad1df044398', // Boston (location, 1.0)
  '9e0afb5a-c6f2-4ad3-8869-9559574ada1a', // Colleen Boston (person, 0.959)
  '0a25494f-7b72-46c0-af8b-325ac12d12a1', // Boston (person, 0.95)
];

// Morphine entities (all medication type)
const MORPHINE_ENTITY_IDS = [
  'd584aec3-280c-42c7-8241-2a232a6c6e9a', // morphine (0.989)
  'b63e6a25-d97c-4b20-a9f6-07df4e2cdba6', // Morphine Sulfate (Concentrate) Oral Solution (0.929)
  'e7d9dce2-85d3-4238-91b0-98e379aad510', // Morphine Sulfate ... 20 MG/ML (0.929)
  '2a1dd7ce-a8d3-4980-8a23-770ef6494cd3', // PRN morphine (0.904)
];

// ICD code entity
const ICD_ENTITY_ID = '6d01733d-1046-4d32-a6a2-1ff5db66301e';

// Boston, Colleen KG node
const BOSTON_COLLEEN_NODE_ID = '9cf2a02a-0ca2-4f9f-a481-b109405864b0';

// Type distribution from raw SQL
const TYPE_DISTRIBUTION: Record<string, number> = {
  diagnosis: 105,
  medication: 40,
  person: 39,
  medical_device: 30,
  other: 29,
  date: 26,
  location: 22,
  amount: 15,
  organization: 15,
  case_number: 1,
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

type ToolResponse = { content: Array<{ type: string; text: string }> };

/** Parse MCP tool response -> inner JSON.
 *  Response shape: formatResponse(successResult({...}))
 *    = { content: [{ type: "text", text: JSON.stringify({ success: true, data: { ... } }) }] }
 *  Error shape: handleError(error)
 *    = { content: [{ type: "text", text: JSON.stringify({ success: false, error: { ... } }) }] }
 */
function parseResponse(raw: ToolResponse): { success: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> } {
  const text = raw.content[0]?.text;
  if (!text) throw new Error('Empty MCP response');
  return JSON.parse(text);
}

/** Get raw DB connection for cross-verification */
function getRawDb(): Database.Database {
  const db = new Database(DB_FILE, { readonly: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(db);
  return db;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('SHERLOCK HOLMES: Entity Tools Full State Verification', () => {
  let rawDb: Database.Database;

  beforeAll(() => {
    selectDatabase(DB_NAME);
    rawDb = getRawDb();
  });

  afterAll(() => {
    rawDb?.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1: Entity Search Happy Path - "Boston"
  // ─────────────────────────────────────────────────────────────────────────

  describe('TEST 1: Entity Search Happy Path - query "Boston"', () => {
    let data: Record<string, unknown>;
    let results: Array<Record<string, unknown>>;

    it('should call ocr_entity_search and return success', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: 'Boston' });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      data = resp.data!;
      results = data.results as Array<Record<string, unknown>>;
    });

    it('should return all 4 Boston entities', () => {
      expect(data.total_results).toBe(4);
      expect(data.query).toBe('Boston');
    });

    it('should include "Boston, Colleen" with correct fields', () => {
      const colleen = results.find(r => r.raw_text === 'Boston, Colleen');
      expect(colleen).toBeDefined();
      expect(colleen!.entity_id).toBe('d6e817fb-bd52-4fc0-8edc-78f9950e283e');
      expect(colleen!.entity_type).toBe('person');
      expect(colleen!.confidence).toBe(1.0);
    });

    it('should have mentions array and mention_count for each result', () => {
      for (const r of results) {
        expect(Array.isArray(r.mentions)).toBe(true);
        expect(typeof r.mention_count).toBe('number');
        expect(r.mention_count).toBe((r.mentions as unknown[]).length);
      }
    });

    it('CROSS-CHECK: every entity_id exists in DB', () => {
      const stmt = rawDb.prepare('SELECT COUNT(*) as cnt FROM entities WHERE id = ?');
      for (const r of results) {
        const row = stmt.get(r.entity_id as string) as { cnt: number };
        expect(row.cnt).toBe(1);
      }
    });

    it('CROSS-CHECK: returned entity IDs match DB ground truth', () => {
      const returnedIds = new Set(results.map(r => r.entity_id as string));
      for (const expectedId of BOSTON_ENTITY_IDS) {
        expect(returnedIds.has(expectedId)).toBe(true);
      }
    });

    it('CROSS-CHECK: mention_count for "Boston, Colleen" matches DB', () => {
      const colleen = results.find(r => r.raw_text === 'Boston, Colleen');
      const dbCount = (rawDb.prepare(
        'SELECT COUNT(*) as cnt FROM entity_mentions WHERE entity_id = ?'
      ).get('d6e817fb-bd52-4fc0-8edc-78f9950e283e') as { cnt: number }).cnt;
      expect(colleen!.mention_count).toBe(dbCount);
    });

    it('should order results by confidence DESC', () => {
      const confidences = results.map(r => r.confidence as number);
      for (let i = 1; i < confidences.length; i++) {
        expect(confidences[i]).toBeLessThanOrEqual(confidences[i - 1]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2: Entity Search By Type - "morphine" medication
  // ─────────────────────────────────────────────────────────────────────────

  describe('TEST 2: Entity Search By Type - query "morphine" type "medication"', () => {
    let data: Record<string, unknown>;
    let results: Array<Record<string, unknown>>;

    it('should return only medication entities for "morphine"', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: 'morphine', entity_type: 'medication' });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      data = resp.data!;
      results = data.results as Array<Record<string, unknown>>;
    });

    it('should return exactly 4 morphine medication entities', () => {
      expect(data.total_results).toBe(4);
      expect(data.entity_type_filter).toBe('medication');
    });

    it('should have ALL results as medication type', () => {
      for (const r of results) {
        expect(r.entity_type).toBe('medication');
      }
    });

    it('CROSS-CHECK: returned IDs match DB morphine medications', () => {
      const returnedIds = new Set(results.map(r => r.entity_id as string));
      for (const expectedId of MORPHINE_ENTITY_IDS) {
        expect(returnedIds.has(expectedId)).toBe(true);
      }
    });

    it('CROSS-CHECK: no non-medication morphine entities exist in DB', () => {
      const nonMed = rawDb.prepare(
        "SELECT COUNT(*) as cnt FROM entities WHERE normalized_text LIKE '%morphine%' AND entity_type != 'medication'"
      ).get() as { cnt: number };
      expect(nonMed.cnt).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3: Entity Dossier Happy Path - "Boston, Colleen"
  // ─────────────────────────────────────────────────────────────────────────

  describe('TEST 3: Entity Dossier - "Boston, Colleen"', () => {
    let data: Record<string, unknown>;

    it('should return a dossier for "Boston, Colleen"', async () => {
      const handler = entityAnalysisTools['ocr_entity_dossier'].handler;
      const raw = await handler({
        entity_name: 'Boston, Colleen',
        include_relationships: true,
        include_mentions: true,
        include_timeline: true,
      });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      data = resp.data!;
    });

    it('should have profile from knowledge_graph source', () => {
      const profile = data.profile as Record<string, unknown>;
      expect(profile).toBeDefined();
      expect(profile.source).toBe('knowledge_graph');
      expect(profile.canonical_name).toBe('Boston, Colleen');
      expect(profile.entity_type).toBe('person');
      expect(profile.node_id).toBe(BOSTON_COLLEEN_NODE_ID);
    });

    it('should have aliases including "Colleen Boston"', () => {
      const profile = data.profile as Record<string, unknown>;
      const aliases = profile.aliases as string[];
      expect(aliases).toContain('Colleen Boston');
    });

    it('should have mentions with expected fields', () => {
      const mentions = data.mentions as Array<Record<string, unknown>>;
      expect(Array.isArray(mentions)).toBe(true);
      expect(mentions.length).toBeGreaterThan(0);
      const m = mentions[0];
      expect(m).toHaveProperty('mention_id');
      expect(m).toHaveProperty('document_id');
      expect(m).toHaveProperty('raw_text');
    });

    it('CROSS-CHECK: mention count capped at max_mentions=50', () => {
      const mentions = data.mentions as Array<Record<string, unknown>>;
      // DB has 111 total (103 + 8), default max_mentions=50
      expect(mentions.length).toBeLessThanOrEqual(50);
      expect(mentions.length).toBe(50);
    });

    it('CROSS-CHECK: sample mention_ids exist in entity_mentions table', () => {
      const mentions = data.mentions as Array<Record<string, unknown>>;
      const stmt = rawDb.prepare('SELECT COUNT(*) as cnt FROM entity_mentions WHERE id = ?');
      for (const m of mentions.slice(0, 10)) {
        const row = stmt.get(m.mention_id as string) as { cnt: number };
        expect(row.cnt).toBe(1);
      }
    });

    it('should have relationships array (empty for Boston, Colleen - 0 KG edges)', () => {
      const relationships = data.relationships as Array<Record<string, unknown>>;
      expect(Array.isArray(relationships)).toBe(true);
      expect(data.relationship_count).toBe(0);
    });

    it('should have documents section', () => {
      const documents = data.documents as Array<Record<string, unknown>>;
      expect(Array.isArray(documents)).toBe(true);
      expect(documents.length).toBeGreaterThan(0);
      expect(documents[0]).toHaveProperty('document_id');
      expect(documents[0]).toHaveProperty('file_name');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4: Entity Extraction Stats
  // ─────────────────────────────────────────────────────────────────────────

  describe('TEST 4: Entity Extraction Stats', () => {
    let data: Record<string, unknown>;

    it('should return extraction stats', async () => {
      const handler = entityAnalysisTools['ocr_entity_extraction_stats'].handler;
      const raw = await handler({});
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      data = resp.data!;
    });

    it('CROSS-CHECK: total_entities matches DB (322)', () => {
      expect(data.total_entities).toBe(322);
    });

    it('CROSS-CHECK: total_mentions matches DB (4580)', () => {
      expect(data.total_mentions).toBe(4580);
    });

    it('CROSS-CHECK: entity_type_distribution matches DB exactly', () => {
      const typeDist = data.entity_type_distribution as Array<{ entity_type: string; count: number }>;
      expect(Array.isArray(typeDist)).toBe(true);

      for (const entry of typeDist) {
        const expected = TYPE_DISTRIBUTION[entry.entity_type];
        expect(expected).toBeDefined();
        expect(entry.count).toBe(expected);
      }
    });

    it('CROSS-CHECK: all 10 entity types represented', () => {
      const typeDist = data.entity_type_distribution as Array<{ entity_type: string; count: number }>;
      const types = new Set(typeDist.map(t => t.entity_type));
      expect(types.size).toBe(10);
      for (const expectedType of Object.keys(TYPE_DISTRIBUTION)) {
        expect(types.has(expectedType)).toBe(true);
      }
    });

    it('should include confidence statistics', () => {
      expect(data).toHaveProperty('confidence');
      const conf = data.confidence as Record<string, number | null>;
      expect(conf.min).toBeLessThanOrEqual(conf.max as number);
      expect(conf.avg).toBeGreaterThan(0);
    });

    it('CROSS-CHECK: confidence stats match DB', () => {
      const dbConf = rawDb.prepare(`
        SELECT MIN(confidence) as min_c, MAX(confidence) as max_c, AVG(confidence) as avg_c
        FROM entities
      `).get() as { min_c: number; max_c: number; avg_c: number };

      const conf = data.confidence as Record<string, number | null>;
      expect(conf.min).toBeCloseTo(dbConf.min_c, 3);
      expect(conf.max).toBeCloseTo(dbConf.max_c, 3);
      expect(conf.avg).toBeCloseTo(dbConf.avg_c, 2);
    });

    it('should include segments, document_coverage, knowledge_graph sections', () => {
      expect(data).toHaveProperty('segments');
      expect(data).toHaveProperty('document_coverage');
      expect(data).toHaveProperty('knowledge_graph');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5: Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('TEST 5: Edge Cases', () => {
    it('should return empty results for nonexistent query', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: 'zzzznonexistent99999' });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      expect(resp.data!.total_results).toBe(0);
      expect(resp.data!.results).toEqual([]);
    });

    it('should return error for nonexistent entity dossier', async () => {
      const handler = entityAnalysisTools['ocr_entity_dossier'].handler;
      const raw = await handler({ entity_name: 'DOES_NOT_EXIST_AT_ALL' });
      const resp = parseResponse(raw as ToolResponse);
      // handleError wraps the error; success should be false
      expect(resp.success).not.toBe(true);
    });

    it('should find ICD code "I69398" as diagnosis entity', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: 'I69398' });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      const results = resp.data!.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThanOrEqual(1);

      const icdEntity = results.find(r => (r.entity_id as string) === ICD_ENTITY_ID);
      expect(icdEntity).toBeDefined();
      expect(icdEntity!.entity_type).toBe('diagnosis');
      expect((icdEntity!.raw_text as string)).toContain('I69398');
    });

    it('CROSS-CHECK: ICD entity exists in DB', () => {
      const row = rawDb.prepare('SELECT COUNT(*) as cnt FROM entities WHERE id = ?').get(ICD_ENTITY_ID) as { cnt: number };
      expect(row.cnt).toBe(1);
    });

    it('should handle SQL injection attempt gracefully', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: "'; DROP TABLE entities; --" });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      expect(resp.data!.total_results).toBe(0);

      // Verify entities table still intact
      const count = rawDb.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number };
      expect(count.cnt).toBe(322);
    });

    it('should handle LIKE wildcard characters in query (%, _)', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: '%__%' });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      // Wildcards escaped - should not match everything
    });

    it('should respect limit parameter', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: 'a', limit: 2 });
      const resp = parseResponse(raw as ToolResponse);
      expect(resp.success).toBe(true);
      expect((resp.data!.results as unknown[]).length).toBeLessThanOrEqual(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 6: Full Entity ID Cross-Verification
  // ─────────────────────────────────────────────────────────────────────────

  describe('TEST 6: Full Entity ID Cross-Verification', () => {
    it('should verify all Boston search results exist in DB', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: 'Boston' });
      const resp = parseResponse(raw as ToolResponse);
      const results = resp.data!.results as Array<Record<string, unknown>>;

      const stmt = rawDb.prepare('SELECT id, raw_text, entity_type FROM entities WHERE id = ?');
      for (const r of results) {
        const row = stmt.get(r.entity_id as string) as { id: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.id).toBe(r.entity_id);
      }
    });

    it('should verify all morphine entity IDs exist in DB', async () => {
      const handler = entityAnalysisTools['ocr_entity_search'].handler;
      const raw = await handler({ query: 'morphine', entity_type: 'medication' });
      const resp = parseResponse(raw as ToolResponse);
      const results = resp.data!.results as Array<Record<string, unknown>>;

      const stmt = rawDb.prepare('SELECT COUNT(*) as cnt FROM entities WHERE id = ?');
      for (const r of results) {
        const row = stmt.get(r.entity_id as string) as { cnt: number };
        expect(row.cnt).toBe(1);
      }
    });

    it('should verify all dossier mention IDs exist in entity_mentions', async () => {
      const handler = entityAnalysisTools['ocr_entity_dossier'].handler;
      const raw = await handler({
        entity_name: 'Boston, Colleen',
        include_mentions: true,
        include_relationships: false,
        include_timeline: false,
      });
      const resp = parseResponse(raw as ToolResponse);
      const mentions = resp.data!.mentions as Array<Record<string, unknown>>;

      const stmt = rawDb.prepare('SELECT COUNT(*) as cnt FROM entity_mentions WHERE id = ?');
      for (const m of mentions) {
        const row = stmt.get(m.mention_id as string) as { cnt: number };
        expect(row.cnt).toBe(1);
      }
    });
  });
});
