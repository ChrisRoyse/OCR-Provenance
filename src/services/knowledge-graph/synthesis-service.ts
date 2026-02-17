/**
 * AI Knowledge Synthesis Service - 3-tier top-down knowledge synthesis:
 * Tier 1: Corpus intelligence (bird's eye) | Tier 2: Document relationships | Tier 3: Evidence grounding
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * @module services/knowledge-graph/synthesis-service
 */
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { getSharedClient } from '../gemini/client.js';
import type Database from 'better-sqlite3';
import type { CorpusIntelligence, DocumentNarrative, EntityRole, KnowledgeEdge, KnowledgeNode, RelationshipType } from '../../models/knowledge-graph.js';
import { RELATIONSHIP_TYPES } from '../../models/knowledge-graph.js';
import {
  insertCorpusIntelligence, getCorpusIntelligence, deleteCorpusIntelligence,
  insertDocumentNarrative, getDocumentNarrative, updateDocumentNarrative, deleteDocumentNarrative,
  insertEntityRole, deleteEntityRolesByScope, listKnowledgeNodes,
  insertKnowledgeEdge, findEdge, updateKnowledgeEdge,
  getLinksForDocument, getEvidenceChunksForEdge,
} from '../storage/database/knowledge-graph-operations.js';

import { loadGeminiConfig } from '../gemini/config.js';
let _model: string | null = null;
function getModel(): string { if (!_model) _model = loadGeminiConfig().model; return _model; }
const VALID_REL_TYPES = RELATIONSHIP_TYPES.filter(t => t !== 'co_mentioned' && t !== 'co_located').join(', ');

// ---- Response Schemas for schema-constrained JSON output ----

const CORPUS_MAP_SCHEMA = {
  type: 'object' as const,
  properties: {
    corpus_summary: { type: 'string' as const },
    key_actors: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          type: { type: 'string' as const },
          importance: { type: 'number' as const },
          reason: { type: 'string' as const },
        },
        required: ['name', 'type', 'importance', 'reason'],
      },
    },
    themes: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          core_entities: { type: 'array' as const, items: { type: 'string' as const } },
          description: { type: 'string' as const },
        },
        required: ['name', 'core_entities', 'description'],
      },
    },
    narrative_arcs: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          entity_names: { type: 'array' as const, items: { type: 'string' as const } },
          description: { type: 'string' as const },
          document_ids: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['name', 'entity_names', 'description', 'document_ids'],
      },
    },
  },
  required: ['corpus_summary', 'key_actors', 'themes', 'narrative_arcs'],
};

const NARRATIVE_SCHEMA = {
  type: 'object' as const,
  properties: {
    narrative_text: { type: 'string' as const },
  },
  required: ['narrative_text'],
};

const RELATIONSHIPS_SCHEMA = {
  type: 'object' as const,
  properties: {
    relationships: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          source_entity: { type: 'string' as const },
          target_entity: { type: 'string' as const },
          relationship_type: { type: 'string' as const },
          confidence: { type: 'number' as const },
          evidence: { type: 'string' as const },
        },
        required: ['source_entity', 'target_entity', 'relationship_type', 'confidence', 'evidence'],
      },
    },
  },
  required: ['relationships'],
};

const ROLES_SCHEMA = {
  type: 'object' as const,
  properties: {
    roles: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          entity_name: { type: 'string' as const },
          role: { type: 'string' as const },
          theme: { type: 'string' as const },
          importance_rank: { type: 'number' as const },
          context_summary: { type: 'string' as const },
        },
        required: ['entity_name', 'role', 'importance_rank', 'context_summary'],
      },
    },
  },
  required: ['roles'],
};

function sha256(content: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

function ts(): string { return new Date().toISOString(); }

function createProvenance(db: Database.Database, rootDocId: string | null, scope: string, hash: string): string {
  const id = uuidv4(); const t = ts();
  // root_document_id is NOT NULL: use self-reference for corpus-level provenance
  const rootId = rootDocId ?? id;
  db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 'CORPUS_INTELLIGENCE', t, t, 'CORPUS_INTELLIGENCE', null, rootId, hash, 'synthesis-service', '1.0.0', JSON.stringify({ scope }), '[]', 2);
  return id;
}

function parseJson<T>(text: string, ctx: string): T {
  let s = text.trim();
  // Strip markdown code fences
  if (s.startsWith('```')) {
    s = s.slice(s.indexOf('\n') + 1);
    const i = s.lastIndexOf('```');
    if (i >= 0) s = s.slice(0, i);
    s = s.trim();
  }
  try { return JSON.parse(s) as T; } catch {
    // Gemini sometimes returns malformed JSON - attempt recovery
    try {
      let fixed = s
        .replace(/,\s*([}\]])/g, '$1')       // trailing commas
        .replace(/'/g, '"')                   // single quotes → double quotes
        .replace(/\/\/[^\n]*/g, '')           // line comments
        .replace(/\/\*[\s\S]*?\*\//g, '');    // block comments
      // Fix unquoted property names: { key: "val" } → { "key": "val" }
      fixed = fixed.replace(/(?<=[\{,]\s*)([a-zA-Z_]\w*)\s*:/g, '"$1":');
      return JSON.parse(fixed) as T;
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      console.error(`[synthesis] JSON parse failed (${ctx}): ${msg}\nRaw: ${text.slice(0, 500)}`);
      throw new Error(`Failed to parse Gemini response for ${ctx}: ${msg}`);
    }
  }
}

function resolveNodeId(db: Database.Database, name: string): string | null {
  const r = db.prepare('SELECT id FROM knowledge_nodes WHERE LOWER(canonical_name) = ?').get(name.toLowerCase()) as { id: string } | undefined;
  if (r) return r.id;
  const escaped = name.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const a = db.prepare("SELECT id FROM knowledge_nodes WHERE aliases LIKE ? ESCAPE '\\'").get(`%${escaped}%`) as { id: string } | undefined;
  return a?.id ?? null;
}

function getDocIdsWithEntities(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT document_id FROM node_entity_links ORDER BY document_id').all() as { document_id: string }[]).map(r => r.document_id);
}

function buildCensus(nodes: KnowledgeNode[], max: number): string {
  const byType = new Map<string, KnowledgeNode[]>();
  for (const n of nodes) { const a = byType.get(n.entity_type) ?? []; a.push(n); byType.set(n.entity_type, a); }
  const lines: string[] = []; let c = 0;
  for (const [type, ns] of byType) {
    ns.sort((a, b) => (b.importance_score ?? 0) - (a.importance_score ?? 0));
    lines.push(`### ${type.toUpperCase()} (${ns.length})`);
    for (const n of ns) {
      if (c >= max) break;
      const al = n.aliases ? JSON.parse(n.aliases) as string[] : [];
      lines.push(`- ${n.canonical_name}${al.length ? ` (aka: ${al.join(', ')})` : ''} [docs:${n.document_count}, mentions:${n.mention_count}]`);
      c++;
    }
  }
  return lines.join('\n');
}

/** Get entity roster for a document: [{name, type, nodeId, mentions}] */
function getDocEntities(db: Database.Database, docId: string, limit = 100): Array<{ name: string; type: string; nodeId: string; mentions: number }> {
  const links = getLinksForDocument(db, docId);
  const nodeIds = [...new Set(links.map(l => l.node_id))];
  const result: Array<{ name: string; type: string; nodeId: string; mentions: number }> = [];
  for (const nid of nodeIds.slice(0, limit)) {
    const n = db.prepare('SELECT id, canonical_name, entity_type, mention_count FROM knowledge_nodes WHERE id = ?').get(nid) as { id: string; canonical_name: string; entity_type: string; mention_count: number } | undefined;
    if (n) result.push({ name: n.canonical_name, type: n.entity_type, nodeId: n.id, mentions: n.mention_count });
  }
  return result;
}

/** Group entities by type into a formatted string. */
function formatRoster(entities: Array<{ name: string; type: string }>, includeMentions = false, mentionMap?: Map<string, number>): string {
  const byType = new Map<string, string[]>();
  for (const e of entities) {
    const arr = byType.get(e.type) ?? []; const suffix = includeMentions && mentionMap ? ` (${mentionMap.get(e.name) ?? 0} mentions)` : '';
    arr.push(`- ${e.name}${suffix}`); byType.set(e.type, arr);
  }
  return [...byType.entries()].map(([t, items]) => `### ${t.toUpperCase()}\n${items.join('\n')}`).join('\n');
}

// maxTokens must account for Gemini 3 thinking tokens (can use 4000-5000+)
// which count toward maxOutputTokens budget. Use max (65K) to avoid truncation.
const GEMINI_MAX_OUTPUT_TOKENS = 65536;
async function gemini(prompt: string, schema?: object): Promise<string> {
  const r = await getSharedClient().fast(prompt, schema, { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS });
  return r.text;
}

/** Store and return an edge if it does not already exist. */
function storeEdge(db: Database.Database, src: string, tgt: string, relType: RelationshipType, weight: number, docIds: string[], meta: Record<string, unknown>, provId: string, temporal?: { from: string | null; until: string | null } | null): KnowledgeEdge | null {
  if (src === tgt || !RELATIONSHIP_TYPES.includes(relType)) return null;
  if (findEdge(db, src, tgt, relType) || findEdge(db, tgt, src, relType)) return null;
  const edge: KnowledgeEdge = {
    id: uuidv4(), source_node_id: src, target_node_id: tgt, relationship_type: relType,
    weight, evidence_count: 1, document_ids: JSON.stringify(docIds), metadata: JSON.stringify(meta),
    provenance_id: provId, created_at: ts(), valid_from: temporal?.from ?? null, valid_until: temporal?.until ?? null,
  };
  insertKnowledgeEdge(db, edge);
  return edge;
}

// ---- Tier 1: Corpus Intelligence ----

interface CorpusMapResult {
  corpus_summary: string;
  key_actors: Array<{ name: string; type: string; importance: number; reason: string }>;
  themes: Array<{ name: string; core_entities: string[]; description: string }>;
  narrative_arcs: Array<{ name: string; entity_names: string[]; description: string; document_ids: string[] }>;
}

export async function generateCorpusMap(db: Database.Database, databaseName: string, force = false): Promise<CorpusIntelligence> {
  if (!force) { const ex = getCorpusIntelligence(db, databaseName); if (ex) return ex; }
  const nodes = listKnowledgeNodes(db, { limit: 10000 });
  if (nodes.length === 0) throw new Error('No KG nodes found. Build the knowledge graph first.');
  const census = buildCensus(nodes, 500);
  const docCount = new Set(getDocIdsWithEntities(db)).size;
  const text = await gemini(`You are analyzing a document corpus. Entity Census (${nodes.length} entities, ${docCount} docs):\n${census}\n\nRules: key_actors top 20 by importance (1=most, 20=least). themes 3-8 themes. narrative_arcs 1-5 arcs. Use EXACT entity names from the census. corpus_summary should be 2-3 sentences.`, CORPUS_MAP_SCHEMA);
  const r = parseJson<CorpusMapResult>(text, 'corpus_map');
  if (force) deleteCorpusIntelligence(db, databaseName);
  const provId = createProvenance(db, null, 'corpus', sha256(JSON.stringify(r)));
  const record: CorpusIntelligence = {
    id: uuidv4(), database_name: databaseName, corpus_summary: r.corpus_summary,
    key_actors: JSON.stringify(r.key_actors), themes: JSON.stringify(r.themes),
    narrative_arcs: JSON.stringify(r.narrative_arcs), entity_count: nodes.length,
    document_count: docCount, model: getModel(), provenance_id: provId, created_at: ts(), updated_at: ts(),
  };
  insertCorpusIntelligence(db, record);
  console.error(`[synthesis] Corpus map: ${r.themes.length} themes, ${r.key_actors.length} actors`);
  return record;
}

// ---- Tier 2: Document Narrative ----

export async function generateDocumentNarrative(db: Database.Database, documentId: string, corpus?: CorpusIntelligence | null): Promise<DocumentNarrative> {
  const ex = getDocumentNarrative(db, documentId); if (ex) return ex;
  const doc = db.prepare('SELECT id, file_name FROM documents WHERE id = ?').get(documentId) as { id: string; file_name: string } | undefined;
  if (!doc) throw new Error(`Document not found: ${documentId}`);
  const ocrRow = db.prepare('SELECT extracted_text FROM ocr_results WHERE document_id = ? LIMIT 1').get(documentId) as { extracted_text: string } | undefined;
  const entities = getDocEntities(db, documentId);
  const mentionMap = new Map(entities.map(e => [e.name, e.mentions]));
  const roster = formatRoster(entities, true, mentionMap);
  const corpusCtx = corpus ? `\nCorpus: ${corpus.corpus_summary}\nThemes: ${corpus.themes}\n` : '';
  const text = await gemini(`Analyze document "${doc.file_name}" in a corpus.${corpusCtx}\nText excerpt:\n${(ocrRow?.extracted_text ?? '').slice(0, 4000)}\n\nEntities:\n${roster}\n\nWrite a 2-4 paragraph narrative (max 2000 chars) of entity interactions. Reference entities by EXACT name. Focus on WHO did WHAT to WHOM and WHEN.`, NARRATIVE_SCHEMA);
  const r = parseJson<{ narrative_text: string }>(text, 'narrative');
  const provId = createProvenance(db, documentId, 'document', sha256(r.narrative_text));
  const record: DocumentNarrative = {
    id: uuidv4(), document_id: documentId, narrative_text: r.narrative_text,
    entity_roster: JSON.stringify(entities.map(e => ({ name: e.name, type: e.type, mentions: e.mentions }))),
    corpus_context: corpus ? JSON.stringify({ summary: corpus.corpus_summary, themes: corpus.themes }) : null,
    synthesis_count: 0, model: getModel(), provenance_id: provId, created_at: ts(), updated_at: ts(),
  };
  insertDocumentNarrative(db, record);
  console.error(`[synthesis] Narrative for ${doc.file_name}: ${r.narrative_text.length} chars`);
  return record;
}

// ---- Tier 2: Relationship Inference ----

interface InferredRel {
  source_entity: string; target_entity: string; relationship_type: string;
  confidence: number; evidence: string;
  temporal?: { from: string | null; until: string | null } | null;
}

export async function inferDocumentRelationships(db: Database.Database, documentId: string, narrative: DocumentNarrative, corpus?: CorpusIntelligence | null): Promise<KnowledgeEdge[]> {
  const entities = getDocEntities(db, documentId);
  if (entities.length < 2) return [];
  const roster = formatRoster(entities);
  const corpusCtx = corpus ? `Corpus: ${corpus.corpus_summary}\nThemes: ${corpus.themes}\n\n` : '';
  const text = await gemini(`${corpusCtx}Document Narrative:\n${narrative.narrative_text.slice(0, 2000)}\n\nEntities:\n${roster}\n\nIdentify ALL meaningful relationships between entities. Use EXACT entity names. relationship_type must be one of: ${VALID_REL_TYPES}. confidence 0.0-1.0. evidence should be 1-2 sentences. No co_mentioned or co_located types.`, RELATIONSHIPS_SCHEMA);
  const parsed = parseJson<{ relationships: InferredRel[] }>(text, 'doc_relationships');
  const rels = Array.isArray(parsed) ? parsed : (parsed.relationships ?? []);
  if (!Array.isArray(rels)) throw new Error('Non-array response for relationship inference');
  const nameMap = new Map(entities.map(e => [e.name.toLowerCase(), e.nodeId]));
  const provId = createProvenance(db, documentId, 'doc_relationships', sha256(JSON.stringify(rels)));
  const edges: KnowledgeEdge[] = [];
  for (const rel of rels) {
    const src = nameMap.get(rel.source_entity.toLowerCase()), tgt = nameMap.get(rel.target_entity.toLowerCase());
    if (!src || !tgt) { console.error(`[synthesis] Skip: unresolved "${rel.source_entity}" -> "${rel.target_entity}"`); continue; }
    const e = storeEdge(db, src, tgt, rel.relationship_type as RelationshipType, rel.confidence, [documentId],
      { source: 'ai_synthesis', synthesis_level: 'document', evidence_summary: rel.evidence, model: getModel(), synthesized_at: ts() }, provId, rel.temporal);
    if (e) edges.push(e);
  }
  if (edges.length > 0) updateDocumentNarrative(db, narrative.id, { synthesis_count: (narrative.synthesis_count ?? 0) + edges.length, updated_at: ts() });
  console.error(`[synthesis] ${edges.length} relationships inferred for doc ${documentId}`);
  return edges;
}

// ---- Cross-Document Relationships ----

export async function inferCrossDocumentRelationships(db: Database.Database, _databaseName: string): Promise<KnowledgeEdge[]> {
  const multiDoc = listKnowledgeNodes(db, { min_document_count: 2, limit: 50 });
  if (multiDoc.length < 2) return [];
  const docIds = getDocIdsWithEntities(db);
  const narrs: string[] = [];
  for (const d of docIds) { const n = getDocumentNarrative(db, d); if (n) narrs.push(`[${d}]: ${n.narrative_text.slice(0, 500)}`); }
  const entList = multiDoc.map(n => { const al = n.aliases ? JSON.parse(n.aliases) as string[] : []; return `- ${n.canonical_name} (${n.entity_type}, ${n.document_count} docs)${al.length ? ` aka: ${al.join(', ')}` : ''}`; }).join('\n');
  const text = await gemini(`Cross-document relationship analysis.\nMulti-doc entities:\n${entList}\n\nDoc summaries:\n${narrs.join('\n').slice(0, 3000)}\n\nIdentify cross-document relationships. Use EXACT entity names. relationship_type must be one of: ${VALID_REL_TYPES}. confidence 0.0-1.0. Focus on connections that span multiple documents.`, RELATIONSHIPS_SCHEMA);
  const parsed = parseJson<{ relationships: InferredRel[] }>(text, 'cross_doc');
  const rels = Array.isArray(parsed) ? parsed : (parsed.relationships ?? []);
  if (!Array.isArray(rels)) throw new Error('Non-array response for cross-doc inference');
  const nameMap = new Map(multiDoc.map(n => [n.canonical_name.toLowerCase(), n.id]));
  const provId = createProvenance(db, null, 'cross_document', sha256(JSON.stringify(rels)));
  const edges: KnowledgeEdge[] = [];
  for (const rel of rels) {
    const src = nameMap.get(rel.source_entity.toLowerCase()), tgt = nameMap.get(rel.target_entity.toLowerCase());
    if (!src || !tgt) continue;
    const e = storeEdge(db, src, tgt, rel.relationship_type as RelationshipType, rel.confidence, [],
      { source: 'ai_synthesis', synthesis_level: 'cross_document', evidence_summary: rel.evidence, model: getModel(), synthesized_at: ts() }, provId);
    if (e) edges.push(e);
  }
  console.error(`[synthesis] ${edges.length} cross-document relationships inferred`);
  return edges;
}

// ---- Entity Role Classification ----

export async function classifyEntityRoles(db: Database.Database, databaseName: string, scope: 'database' | 'document', scopeId?: string): Promise<EntityRole[]> {
  const corpus = getCorpusIntelligence(db, databaseName);
  let nodes: KnowledgeNode[];
  if (scope === 'document' && scopeId) {
    const ids = [...new Set(getLinksForDocument(db, scopeId).map(l => l.node_id))];
    nodes = ids.slice(0, 50).map(id => db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(id) as KnowledgeNode | undefined).filter((n): n is KnowledgeNode => !!n);
  } else { nodes = listKnowledgeNodes(db, { limit: 50 }); }
  if (nodes.length === 0) return [];
  const entList = nodes.map(n => `- ${n.canonical_name} (${n.entity_type}, ${n.document_count} docs, ${n.mention_count} mentions)`).join('\n');
  const ctx = corpus ? `Corpus: ${corpus.corpus_summary}\nThemes: ${corpus.themes}\n\n` : '';
  const text = await gemini(`${ctx}Entities:\n${entList}\n\nDetermine each entity's role in this ${scope}. Use EXACT entity names. importance_rank 1=most important, 50=least. role examples: attending_physician, plaintiff, defendant, medication, primary_diagnosis. context_summary should be 1 sentence.`, ROLES_SCHEMA);
  const parsed = parseJson<{ roles: Array<{ entity_name: string; role: string; theme: string | null; importance_rank: number; context_summary: string }> }>(text, 'roles');
  const roles = Array.isArray(parsed) ? parsed : (parsed.roles ?? []);
  if (!Array.isArray(roles)) throw new Error('Non-array response for role classification');
  deleteEntityRolesByScope(db, scope, scopeId);
  const provId = createProvenance(db, scopeId ?? null, `roles_${scope}`, sha256(JSON.stringify(roles)));
  const created: EntityRole[] = [];
  for (const r of roles) {
    const nid = resolveNodeId(db, r.entity_name);
    if (!nid) { console.error(`[synthesis] Skip role: unresolved "${r.entity_name}"`); continue; }
    const role: EntityRole = { id: uuidv4(), node_id: nid, role: r.role, theme: r.theme ?? null, importance_rank: r.importance_rank, context_summary: r.context_summary, scope, scope_id: scopeId ?? null, model: getModel(), provenance_id: provId, created_at: ts() };
    insertEntityRole(db, role); created.push(role);
  }
  console.error(`[synthesis] ${created.length} roles classified (${scope})`);
  return created;
}

// ---- Tier 3: Evidence Grounding ----

export function groundEvidence(db: Database.Database, documentId: string): { boosted: number; linked: number } {
  const edges = db.prepare(`SELECT * FROM knowledge_edges WHERE metadata LIKE '%"source":"ai_synthesis"%' AND document_ids LIKE ?`).all(`%${documentId}%`) as KnowledgeEdge[];
  let boosted = 0, linked = 0;
  for (const edge of edges) {
    const chunks = getEvidenceChunksForEdge(db, edge.source_node_id, edge.target_node_id, 5);
    if (chunks.length === 0) continue;
    linked++;
    const meta = { ...(edge.metadata ? JSON.parse(edge.metadata) as Record<string, unknown> : {}),
      evidence_chunks: chunks.map(c => ({ chunk_id: c.chunk_id, page_number: c.page_number, source_file: c.source_file })),
      evidence_grounded: true, grounded_at: ts() };
    const w = Math.min(1.0, (edge.weight ?? 0.5) + 0.1);
    if (w > (edge.weight ?? 0.5)) boosted++;
    updateKnowledgeEdge(db, edge.id, { weight: w, evidence_count: chunks.length, metadata: JSON.stringify(meta) });
  }
  console.error(`[synthesis] Evidence grounding ${documentId}: ${boosted} boosted, ${linked} linked`);
  return { boosted, linked };
}

// ---- Orchestrators ----

export interface SynthesizeDocumentResult {
  narrative: DocumentNarrative; edges_created: number;
  evidence_grounded: { boosted: number; linked: number }; roles_assigned: number;
}

export async function synthesizeDocument(db: Database.Database, documentId: string, options?: { databaseName?: string; force_narrative?: boolean }): Promise<SynthesizeDocumentResult> {
  const dbName = options?.databaseName ?? 'default';
  let corpus: CorpusIntelligence | null = null;
  try { corpus = await generateCorpusMap(db, dbName); } catch (e) { console.error(`[synthesis] Corpus map failed: ${e instanceof Error ? e.message : String(e)}`); }
  if (options?.force_narrative) deleteDocumentNarrative(db, documentId);
  const narrative = await generateDocumentNarrative(db, documentId, corpus);
  const edges = await inferDocumentRelationships(db, documentId, narrative, corpus);
  const evidence = groundEvidence(db, documentId);
  const roles = await classifyEntityRoles(db, dbName, 'document', documentId);
  return { narrative, edges_created: edges.length, evidence_grounded: evidence, roles_assigned: roles.length };
}

export interface SynthesizeCorpusResult {
  corpus_intelligence: CorpusIntelligence; documents_synthesized: number;
  total_edges_created: number; total_evidence_grounded: { boosted: number; linked: number };
  cross_document_edges: number; corpus_roles_assigned: number;
}

export async function synthesizeCorpus(db: Database.Database, databaseName: string, options?: { document_filter?: string[]; force?: boolean }): Promise<SynthesizeCorpusResult> {
  const force = options?.force ?? false;
  const corpus = await generateCorpusMap(db, databaseName, force);
  const docIds = options?.document_filter ?? getDocIdsWithEntities(db);
  let totalEdges = 0, totalBoosted = 0, totalLinked = 0, docsOk = 0;
  for (const docId of docIds) {
    try {
      if (force) deleteDocumentNarrative(db, docId);
      const narr = await generateDocumentNarrative(db, docId, corpus);
      const edges = await inferDocumentRelationships(db, docId, narr, corpus);
      const ev = groundEvidence(db, docId);
      totalEdges += edges.length; totalBoosted += ev.boosted; totalLinked += ev.linked; docsOk++;
    } catch (e) { console.error(`[synthesis] Doc ${docId} failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const cross = await inferCrossDocumentRelationships(db, databaseName);
  const roles = await classifyEntityRoles(db, databaseName, 'database');
  console.error(`[synthesis] Corpus done: ${docsOk} docs, ${totalEdges + cross.length} edges, ${roles.length} roles`);
  return { corpus_intelligence: corpus, documents_synthesized: docsOk, total_edges_created: totalEdges + cross.length, total_evidence_grounded: { boosted: totalBoosted, linked: totalLinked }, cross_document_edges: cross.length, corpus_roles_assigned: roles.length };
}
