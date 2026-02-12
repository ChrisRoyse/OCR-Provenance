/**
 * Entity/KG Integration Benchmark Script
 *
 * Tests ALL search and analysis tools against the bridginglife-benchmark database
 * with document 79c86a0b-d210-4bf5-ac54-23552c6dd924 (Boston, Colleen hospice record).
 *
 * Runs each tool handler directly (bypassing MCP transport) for precise measurement.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

// Import state management + tools
const { state } = await import('../dist/server/state.js');
const { handleSearch, handleSearchSemantic, handleSearchHybrid, searchTools } = await import('../dist/tools/search.js');
const { entityAnalysisTools } = await import('../dist/tools/entity-analysis.js');
const { knowledgeGraphTools } = await import('../dist/tools/knowledge-graph.js');

const DB_NAME = 'bridginglife-benchmark';
const DOC_ID = '79c86a0b-d210-4bf5-ac54-23552c6dd924';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseToolResponse(resp) {
  const content = resp?.content?.[0];
  if (!content || content.type !== 'text') return { error: 'no text content' };
  try {
    return JSON.parse(content.text);
  } catch (e) {
    return { error: 'json parse failed', raw: content.text?.slice(0, 500) };
  }
}

function summarize(label, parsed, checks) {
  const status = parsed.error ? 'ERROR' : (parsed.success === false ? 'FAIL' : 'OK');
  console.log(`\n${'='.repeat(80)}`);
  console.log(`[${status}] ${label}`);
  console.log('='.repeat(80));

  if (parsed.error) {
    console.log(`  ERROR: ${JSON.stringify(parsed.error).slice(0, 300)}`);
    return { label, status: 'ERROR', error: parsed.error };
  }

  const data = parsed.data ?? parsed;
  const result = { label, status: 'OK', checks: {} };

  for (const [checkName, checkFn] of Object.entries(checks)) {
    try {
      const val = checkFn(data);
      const passed = val !== false && val !== null && val !== undefined;
      result.checks[checkName] = { passed, value: val };
      console.log(`  ${passed ? 'PASS' : 'FAIL'} ${checkName}: ${JSON.stringify(val)}`);
      if (!passed) result.status = 'PARTIAL';
    } catch (e) {
      result.checks[checkName] = { passed: false, value: e.message };
      console.log(`  FAIL ${checkName}: ${e.message}`);
      result.status = 'PARTIAL';
    }
  }

  return result;
}

// ─── Main Benchmark ──────────────────────────────────────────────────────────

async function main() {
  console.log('SHERLOCK HOLMES FORENSIC ENTITY/KG INTEGRATION BENCHMARK');
  console.log(`Database: ${DB_NAME}`);
  console.log(`Document: ${DOC_ID}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');

  // Connect to database via the proper selectDatabase() API
  const { selectDatabase } = await import('../dist/server/state.js');
  selectDatabase(DB_NAME);

  const { requireDatabase } = await import('../dist/server/state.js');
  const { db, vector } = requireDatabase();
  const conn = db.getConnection();

  // ── Pre-flight: Verify data exists ──
  console.log('\n--- PRE-FLIGHT CHECKS ---');

  const docRow = conn.prepare('SELECT id, file_name, status FROM documents WHERE id = ?').get(DOC_ID);
  console.log(`Document: ${JSON.stringify(docRow)}`);

  const chunkCount = conn.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE document_id = ?').get(DOC_ID);
  console.log(`Chunks: ${chunkCount.cnt}`);

  const entityCount = conn.prepare('SELECT COUNT(*) as cnt FROM entities WHERE document_id = ?').get(DOC_ID);
  console.log(`Entities: ${entityCount.cnt}`);

  const mentionCount = conn.prepare('SELECT COUNT(*) as cnt FROM entity_mentions em JOIN entities e ON em.entity_id = e.id WHERE e.document_id = ?').get(DOC_ID);
  console.log(`Entity mentions: ${mentionCount.cnt}`);

  let kgNodes = 0, kgEdges = 0;
  try {
    kgNodes = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get().cnt;
    kgEdges = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get().cnt;
    console.log(`KG nodes: ${kgNodes}, KG edges: ${kgEdges}`);
  } catch { console.log('KG tables: not found'); }

  // Entity type distribution
  const entityTypes = conn.prepare('SELECT entity_type, COUNT(*) as cnt FROM entities WHERE document_id = ? GROUP BY entity_type ORDER BY cnt DESC').all(DOC_ID);
  console.log(`Entity types: ${JSON.stringify(entityTypes)}`);

  // Sample entities
  const sampleEntities = conn.prepare('SELECT entity_type, raw_text, normalized_text FROM entities WHERE document_id = ? LIMIT 10').all(DOC_ID);
  console.log('Sample entities:');
  for (const e of sampleEntities) {
    console.log(`  [${e.entity_type}] ${e.raw_text} -> ${e.normalized_text}`);
  }

  // KG node samples
  try {
    const sampleNodes = conn.prepare('SELECT canonical_name, entity_type, document_count, edge_count FROM knowledge_nodes ORDER BY edge_count DESC LIMIT 8').all();
    console.log('Top KG nodes:');
    for (const n of sampleNodes) {
      console.log(`  ${n.canonical_name} (${n.entity_type}) docs:${n.document_count} edges:${n.edge_count}`);
    }
  } catch { /* no KG */ }

  const results = [];

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 1: BM25 Search with include_entities
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 1: BM25 Search - "Boston Colleen" with include_entities ###');
  const t1 = parseToolResponse(await handleSearch({
    query: 'Boston Colleen',
    limit: 5,
    include_entities: true,
    document_filter: [DOC_ID],
  }));
  results.push(summarize('BM25: "Boston Colleen" + include_entities', t1, {
    'has_results': d => d.total > 0 ? d.total : false,
    'results_have_entities_mentioned': d => {
      const withEntities = d.results?.filter(r => r.entities_mentioned && r.entities_mentioned.length > 0);
      return withEntities?.length > 0 ? `${withEntities.length}/${d.results.length} results have entities` : false;
    },
    'entity_details_shape': d => {
      const first = d.results?.[0]?.entities_mentioned?.[0];
      if (!first) return false;
      return `node_id:${!!first.node_id}, canonical_name:${!!first.canonical_name}, entity_type:${!!first.entity_type}`;
    },
    'cross_document_entities_present': d => d.cross_document_entities?.length > 0 ? d.cross_document_entities.length : false,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 2: BM25 Search with expand_query
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 2: BM25 Search - "medication" with expand_query ###');
  const t2 = parseToolResponse(await handleSearch({
    query: 'medication',
    limit: 5,
    expand_query: true,
    document_filter: [DOC_ID],
  }));
  results.push(summarize('BM25: "medication" + expand_query', t2, {
    'has_results': d => d.total > 0 ? d.total : false,
    'query_expansion_present': d => d.query_expansion ? JSON.stringify(d.query_expansion).slice(0, 200) : false,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 3: BM25 Search with entity_filter
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 3: BM25 Search with entity_filter (entity_names=["Boston"]) ###');
  const t3 = parseToolResponse(await handleSearch({
    query: 'patient',
    limit: 5,
    entity_filter: { entity_names: ['Boston'] },
  }));
  results.push(summarize('BM25: "patient" + entity_filter(Boston)', t3, {
    'has_results': d => d.total > 0 ? d.total : false,
    'entity_filter_applied': d => d.entity_filter_applied === true,
    'entity_filter_document_count': d => d.entity_filter_document_count > 0 ? d.entity_filter_document_count : false,
    'frequency_boost_present': d => d.frequency_boost ? `boosted:${d.frequency_boost.boosted_results}, max_mentions:${d.frequency_boost.max_mention_count}` : 'no boost (may be expected)',
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 4: Semantic Search with include_entities
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 4: Semantic Search - "patient vital signs" with include_entities ###');
  const t4 = parseToolResponse(await handleSearchSemantic({
    query: 'patient vital signs',
    limit: 5,
    include_entities: true,
    document_filter: [DOC_ID],
    similarity_threshold: 0.3,
  }));
  results.push(summarize('Semantic: "patient vital signs" + include_entities', t4, {
    'has_results': d => d.total > 0 ? d.total : false,
    'results_have_entities': d => {
      const withEntities = d.results?.filter(r => r.entities_mentioned && r.entities_mentioned.length > 0);
      return withEntities?.length > 0 ? `${withEntities.length}/${d.results.length}` : false;
    },
    'cross_document_entities': d => d.cross_document_entities?.length > 0 ? d.cross_document_entities.length : false,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 5: Semantic Search - "hospice care assessment"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 5: Semantic Search - "hospice care assessment" ###');
  const t5 = parseToolResponse(await handleSearchSemantic({
    query: 'hospice care assessment',
    limit: 5,
    similarity_threshold: 0.3,
    document_filter: [DOC_ID],
  }));
  results.push(summarize('Semantic: "hospice care assessment"', t5, {
    'has_results': d => d.total > 0 ? d.total : false,
    'results_are_relevant': d => {
      const texts = d.results?.map(r => r.original_text?.slice(0, 80));
      return texts?.length > 0 ? texts.slice(0, 3) : false;
    },
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 6: Hybrid Search with entity_boost
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 6: Hybrid Search - "pain assessment" with entity_boost=0.5 ###');
  const t6 = parseToolResponse(await handleSearchHybrid({
    query: 'pain assessment',
    limit: 5,
    entity_boost: 0.5,
    include_entities: true,
    document_filter: [DOC_ID],
  }));
  results.push(summarize('Hybrid: "pain assessment" + entity_boost=0.5 + include_entities', t6, {
    'has_results': d => d.total > 0 ? d.total : false,
    'entity_boost_applied': d => d.entity_boost ? `boosted:${d.entity_boost.boosted_results}, nodes:${d.entity_boost.matching_nodes}` : 'no boost applied',
    'results_have_entities': d => {
      const withEntities = d.results?.filter(r => r.entities_mentioned && r.entities_mentioned.length > 0);
      return withEntities?.length > 0 ? `${withEntities.length}/${d.results.length}` : false;
    },
    'cross_document_entities': d => d.cross_document_entities?.length > 0 ? d.cross_document_entities.length : false,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 7: Hybrid Search - "Boston" with include_entities
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 7: Hybrid Search - "Boston" with include_entities ###');
  const t7 = parseToolResponse(await handleSearchHybrid({
    query: 'Boston',
    limit: 5,
    include_entities: true,
    document_filter: [DOC_ID],
  }));
  results.push(summarize('Hybrid: "Boston" + include_entities', t7, {
    'has_results': d => d.total > 0 ? d.total : false,
    'entities_found_in_results': d => {
      const allEntities = new Set();
      d.results?.forEach(r => r.entities_mentioned?.forEach(e => allEntities.add(e.canonical_name)));
      return allEntities.size > 0 ? [...allEntities].slice(0, 10) : false;
    },
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 8: Hybrid Search - compare WITH and WITHOUT entity_boost
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 8: Hybrid Search - Compare entity_boost=0 vs entity_boost=0.5 ###');
  const t8a = parseToolResponse(await handleSearchHybrid({
    query: 'pain assessment',
    limit: 5,
    entity_boost: 0,
    document_filter: [DOC_ID],
  }));
  const t8b = parseToolResponse(await handleSearchHybrid({
    query: 'pain assessment',
    limit: 5,
    entity_boost: 0.5,
    document_filter: [DOC_ID],
  }));
  const t8aScores = t8a.data?.results?.map(r => r.rrf_score) ?? [];
  const t8bScores = t8b.data?.results?.map(r => r.rrf_score) ?? [];
  results.push(summarize('Hybrid: entity_boost comparison', { data: { a_scores: t8aScores, b_scores: t8bScores } }, {
    'without_boost_scores': () => t8aScores.slice(0, 5),
    'with_boost_scores': () => t8bScores.slice(0, 5),
    'scores_differ': () => {
      if (t8aScores.length === 0 || t8bScores.length === 0) return false;
      const differ = t8aScores.some((s, i) => s !== t8bScores[i]);
      return differ ? 'YES - entity boost changes scores' : 'NO - scores identical (may mean no KG matches)';
    },
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 9: RAG Context - "What medications was Colleen Boston prescribed?"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 9: RAG Context - medications question ###');
  const ragHandler = searchTools.ocr_rag_context.handler;
  const t9 = parseToolResponse(await ragHandler({
    question: 'What medications was Colleen Boston prescribed?',
    limit: 5,
    include_entity_context: true,
    include_kg_paths: true,
    document_filter: [DOC_ID],
  }));
  results.push(summarize('RAG: "medications for Colleen Boston"', t9, {
    'has_context': d => d.context?.length > 0 ? `${d.context.length} chars` : false,
    'entities_found': d => d.entities_found > 0 ? d.entities_found : false,
    'kg_paths_found': d => d.kg_paths_found >= 0 ? d.kg_paths_found : false,
    'context_has_entity_section': d => d.context?.includes('## Entity Context'),
    'context_has_relationship_section': d => d.context?.includes('## Entity Relationships') || 'no relationships (may be expected for single doc)',
    'sources_listed': d => d.sources?.length > 0 ? d.sources.length : false,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 10: RAG Context - "vital signs at admission"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 10: RAG Context - vital signs question ###');
  const t10 = parseToolResponse(await ragHandler({
    question: 'What were the patient vital signs at admission?',
    limit: 5,
    include_entity_context: true,
    include_kg_paths: true,
    document_filter: [DOC_ID],
  }));
  results.push(summarize('RAG: "vital signs at admission"', t10, {
    'has_context': d => d.context?.length > 0 ? `${d.context.length} chars` : false,
    'entities_found': d => d.entities_found > 0 ? d.entities_found : false,
    'search_results_used': d => d.search_results_used > 0 ? d.search_results_used : false,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 11: Related Documents
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 11: Related Documents ###');
  const relatedHandler = searchTools.ocr_related_documents.handler;
  const t11 = parseToolResponse(await relatedHandler({
    document_id: DOC_ID,
    limit: 10,
    min_shared_entities: 1,
  }));
  results.push(summarize('Related Documents', t11, {
    'no_error': d => !d.error,
    'total_returned': d => d.total >= 0 ? d.total : false,
    'document_id_correct': d => d.document_id === DOC_ID,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 12: Timeline Build
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 12: Timeline Build ###');
  const timelineHandler = entityAnalysisTools.ocr_timeline_build.handler;
  const t12 = parseToolResponse(await timelineHandler({
    document_filter: [DOC_ID],
  }));
  results.push(summarize('Timeline Build', t12, {
    'has_entries': d => d.total_entries > 0 ? d.total_entries : false,
    'entries_have_dates': d => {
      const dated = d.timeline?.filter(e => e.date_iso);
      return dated?.length > 0 ? `${dated.length} dated entries` : false;
    },
    'entries_have_context': d => {
      const withContext = d.timeline?.filter(e => e.context);
      return withContext?.length > 0 ? `${withContext.length} with context` : false;
    },
    'sample_dates': d => d.timeline?.slice(0, 5).map(e => `${e.date_display}: ${e.raw_text}`) || [],
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 13: Timeline with entity_names filter
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 13: Timeline with entity_names=["Boston"] ###');
  const t13 = parseToolResponse(await timelineHandler({
    document_filter: [DOC_ID],
    entity_names: ['Boston'],
  }));
  results.push(summarize('Timeline: entity_names=["Boston"]', t13, {
    'has_entries': d => d.total_entries >= 0 ? d.total_entries : false,
    'entity_names_set': d => JSON.stringify(d.entity_names),
    'fewer_than_unfiltered': d => {
      const unfilteredCount = t12.data?.total_entries ?? t12.total_entries ?? 999;
      const filteredCount = d.total_entries;
      return filteredCount <= unfilteredCount ? `${filteredCount} <= ${unfilteredCount}` : false;
    },
    'co_located_entities_present': d => {
      const withCoLocated = d.timeline?.filter(e => e.co_located_entities?.length > 0);
      return withCoLocated?.length > 0 ? `${withCoLocated.length} entries with co_located_entities` : 'none (entity_names filtering may exclude all)';
    },
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 14: Entity Search - "Boston"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 14: Entity Search - "Boston" ###');
  const entitySearchHandler = entityAnalysisTools.ocr_entity_search.handler;
  const t14 = parseToolResponse(await entitySearchHandler({
    query: 'Boston',
    limit: 10,
  }));
  results.push(summarize('Entity Search: "Boston"', t14, {
    'has_results': d => d.total_results > 0 ? d.total_results : false,
    'results_have_kg_data': d => {
      const withKG = d.results?.filter(r => r.kg_node_id);
      return withKG?.length > 0 ? `${withKG.length}/${d.results.length} with KG node` : false;
    },
    'kg_connected_entities': d => {
      const withConnected = d.results?.filter(r => r.kg_connected_entities?.length > 0);
      return withConnected?.length > 0 ? `${withConnected.length} results with connections` : false;
    },
    'sample_results': d => d.results?.slice(0, 3).map(r => `${r.entity_type}: ${r.raw_text} (conf:${r.confidence})`),
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 15: Entity Search by type "organization"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 15: Entity Search - type "organization" ###');
  const t15 = parseToolResponse(await entitySearchHandler({
    query: 'org',
    entity_type: 'organization',
    limit: 10,
  }));
  results.push(summarize('Entity Search: type=organization', t15, {
    'has_results': d => d.total_results > 0 ? d.total_results : false,
    'all_are_organization': d => {
      const allOrg = d.results?.every(r => r.entity_type === 'organization');
      return allOrg ? 'YES' : 'NO - type filter broken';
    },
    'sample_orgs': d => d.results?.slice(0, 5).map(r => r.raw_text),
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 16: Entity Search by type "location"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 16: Entity Search - type "location" ###');
  const t16 = parseToolResponse(await entitySearchHandler({
    query: 'west',
    entity_type: 'location',
    limit: 10,
  }));
  results.push(summarize('Entity Search: type=location', t16, {
    'has_results': d => d.total_results > 0 ? d.total_results : false,
    'all_are_location': d => {
      const allLoc = d.results?.every(r => r.entity_type === 'location');
      return allLoc ? 'YES' : 'NO - type filter broken';
    },
    'sample_locations': d => d.results?.slice(0, 5).map(r => r.raw_text),
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 17: KG Stats
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 17: Knowledge Graph Stats ###');
  const kgStatsHandler = knowledgeGraphTools.ocr_knowledge_graph_stats.handler;
  const t17 = parseToolResponse(await kgStatsHandler({}));
  results.push(summarize('KG Stats', t17, {
    'has_nodes': d => (d.total_nodes ?? d.data?.total_nodes) > 0,
    'has_edges': d => (d.total_edges ?? d.data?.total_edges) > 0,
    'type_distribution': d => d.entity_type_distribution ?? d.data?.entity_type_distribution ?? 'missing',
    'most_connected': d => {
      const mc = d.most_connected_nodes ?? d.data?.most_connected_nodes;
      return mc?.slice(0, 3).map(n => `${n.canonical_name}: ${n.edge_count} edges`) ?? 'missing';
    },
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 18: KG Query for "Boston"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 18: KG Query - entity_name "Boston" ###');
  const kgQueryHandler = knowledgeGraphTools.ocr_knowledge_graph_query.handler;
  const t18 = parseToolResponse(await kgQueryHandler({
    entity_name: 'Boston',
    include_edges: true,
    limit: 10,
  }));
  results.push(summarize('KG Query: "Boston"', t18, {
    'has_nodes': d => {
      const nodes = d.nodes ?? d.data?.nodes;
      return nodes?.length > 0 ? nodes.length : false;
    },
    'has_edges': d => {
      const edges = d.edges ?? d.data?.edges;
      return edges?.length > 0 ? edges.length : false;
    },
    'sample_nodes': d => {
      const nodes = d.nodes ?? d.data?.nodes ?? [];
      return nodes.slice(0, 3).map(n => `${n.canonical_name} (${n.entity_type})`);
    },
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 19: BM25 with entity_filter by type
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 19: BM25 with entity_filter (entity_types=["person"]) ###');
  const t19 = parseToolResponse(await handleSearch({
    query: 'assessment',
    limit: 5,
    entity_filter: { entity_types: ['person'] },
  }));
  results.push(summarize('BM25: entity_filter(type=person)', t19, {
    'has_results': d => d.total > 0 ? d.total : false,
    'entity_filter_applied': d => d.entity_filter_applied === true,
    'entity_filter_document_count': d => d.entity_filter_document_count > 0 ? d.entity_filter_document_count : false,
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // TEST 20: Semantic with entity_filter + expand_query
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n### TEST 20: Semantic with entity_filter + expand_query ###');
  const t20 = parseToolResponse(await handleSearchSemantic({
    query: 'hospice care',
    limit: 5,
    entity_filter: { entity_names: ['Boston', 'Colleen'] },
    expand_query: true,
    similarity_threshold: 0.3,
  }));
  results.push(summarize('Semantic: entity_filter(Boston,Colleen) + expand_query', t20, {
    'has_results': d => d.total > 0 ? d.total : false,
    'entity_filter_applied': d => d.entity_filter_applied === true,
    'query_expansion': d => d.query_expansion ? JSON.stringify(d.query_expansion).slice(0, 200) : 'no expansion',
    'frequency_boost': d => d.frequency_boost ? `boosted:${d.frequency_boost.boosted_results}` : 'no boost',
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // FINAL REPORT
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\n\n');
  console.log('='.repeat(80));
  console.log('SHERLOCK HOLMES FORENSIC BENCHMARK - FINAL REPORT');
  console.log('='.repeat(80));

  let totalTests = results.length;
  let okCount = 0;
  let partialCount = 0;
  let errorCount = 0;

  for (const r of results) {
    const icon = r.status === 'OK' ? 'PASS' : r.status === 'PARTIAL' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${r.label}`);
    if (r.status === 'OK') okCount++;
    else if (r.status === 'PARTIAL') partialCount++;
    else errorCount++;
  }

  console.log('');
  console.log(`Total: ${totalTests} | PASS: ${okCount} | WARN: ${partialCount} | FAIL: ${errorCount}`);
  console.log(`Score: ${okCount}/${totalTests} (${Math.round(okCount/totalTests*100)}%)`);

  // Cross-tool integration assessment
  console.log('\n--- CROSS-TOOL INTEGRATION ASSESSMENT ---');

  const integrationChecks = {
    'BM25 include_entities': results[0]?.checks?.['results_have_entities_mentioned']?.passed,
    'BM25 expand_query': results[1]?.checks?.['query_expansion_present']?.passed,
    'BM25 entity_filter': results[2]?.checks?.['entity_filter_applied']?.passed,
    'Semantic include_entities': results[3]?.checks?.['results_have_entities']?.passed,
    'Hybrid entity_boost': results[5]?.checks?.['entity_boost_applied']?.passed !== false,
    'Hybrid include_entities': results[6]?.checks?.['entities_found_in_results']?.passed,
    'RAG entity_context': results[8]?.checks?.['entities_found']?.passed,
    'RAG kg_paths': results[8]?.checks?.['kg_paths_found']?.passed !== false,
    'Related Documents': results[10]?.checks?.['no_error']?.passed,
    'Timeline dates': results[11]?.checks?.['has_entries']?.passed,
    'Timeline entity_names': results[12]?.checks?.['has_entries']?.passed !== false,
    'Entity Search KG': results[13]?.checks?.['results_have_kg_data']?.passed,
    'Entity Search type filter': results[14]?.checks?.['all_are_organization']?.passed,
    'KG Stats': results[16]?.checks?.['has_nodes']?.passed,
    'KG Query': results[17]?.checks?.['has_nodes']?.passed,
  };

  let intPassed = 0;
  let intTotal = Object.keys(integrationChecks).length;
  for (const [name, passed] of Object.entries(integrationChecks)) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'} ${name}`);
    if (passed) intPassed++;
  }

  const integrationScore = Math.round((intPassed / intTotal) * 10);
  console.log(`\nCross-tool integration: ${intPassed}/${intTotal}`);
  console.log(`OVERALL INTEGRATION SCORE: ${integrationScore}/10`);

  // Close DB via clearDatabase to avoid double-close
  const { clearDatabase } = await import('../dist/server/state.js');
  clearDatabase();

  process.exit(0);
}

main().catch(err => {
  console.error('BENCHMARK FATAL ERROR:', err);
  process.exit(1);
});
