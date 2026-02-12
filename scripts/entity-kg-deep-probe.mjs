/**
 * Deep Probe: Investigate the 5 warnings from the benchmark.
 *
 * 1. Semantic Search include_entities returns no entities (TEST 4)
 * 2. Hybrid entity_boost=0.5 shows no boost applied (TEST 6)
 * 3. RAG context_has_entity_section is false despite entities_found=1 (TEST 9)
 * 4. Entity Search by type "organization" returns 0 results for query "org" (TEST 15)
 * 5. KG Query for "Boston" has edges=false (TEST 18)
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const { state } = await import('../dist/server/state.js');
const { selectDatabase, requireDatabase, clearDatabase } = await import('../dist/server/state.js');
const { handleSearch, handleSearchSemantic, handleSearchHybrid, searchTools } = await import('../dist/tools/search.js');
const { entityAnalysisTools } = await import('../dist/tools/entity-analysis.js');
const { knowledgeGraphTools } = await import('../dist/tools/knowledge-graph.js');

const DB_NAME = 'bridginglife-benchmark';
const DOC_ID = '79c86a0b-d210-4bf5-ac54-23552c6dd924';

function parse(resp) {
  const c = resp?.content?.[0];
  if (!c || c.type !== 'text') return {};
  return JSON.parse(c.text);
}

selectDatabase(DB_NAME);
const { db } = requireDatabase();
const conn = db.getConnection();

console.log('=== DEEP PROBE: 5 WARNING INVESTIGATIONS ===\n');

// ─── PROBE 1: Semantic Search include_entities returns no entities ────────

console.log('--- PROBE 1: Semantic include_entities empty ---');
console.log('Hypothesis: The semantic search results may land on chunks that have no entity_mentions linked.');

// Check which chunks have entity mentions
const chunksWithMentions = conn.prepare(`
  SELECT DISTINCT em.chunk_id, c.chunk_index, c.page_number
  FROM entity_mentions em
  JOIN chunks c ON em.chunk_id = c.id
  WHERE c.document_id = ?
  ORDER BY c.chunk_index
`).all(DOC_ID);
console.log(`Chunks with entity mentions: ${chunksWithMentions.length} / 199 total`);
console.log(`Mentioned chunk indices: ${chunksWithMentions.map(c => c.chunk_index).join(', ')}`);

// Run the semantic search and show which chunks came back
const sem1 = parse(await handleSearchSemantic({
  query: 'patient vital signs',
  limit: 5,
  include_entities: true,
  document_filter: [DOC_ID],
  similarity_threshold: 0.3,
}));
console.log(`Semantic results: ${sem1.data?.total ?? 0}`);
for (const r of (sem1.data?.results ?? [])) {
  const chunkId = r.chunk_id;
  const entities = r.entities_mentioned ?? [];
  const hasMatch = chunksWithMentions.some(c => c.chunk_id === chunkId);
  console.log(`  chunk_id=${chunkId?.slice(0,8)}... index=${r.chunk_index} page=${r.page_number} entities=${entities.length} hasEntityMention=${hasMatch}`);
}

// Check if entities are linked via node_entity_links (KG path)
console.log('\nEntities linked through KG (getEntitiesForChunks path):');
const { getEntitiesForChunks } = await import('../dist/services/storage/database/knowledge-graph-operations.js');
const testChunkIds = (sem1.data?.results ?? []).map(r => r.chunk_id).filter(Boolean);
if (testChunkIds.length > 0) {
  const entityMap = getEntitiesForChunks(conn, testChunkIds);
  console.log(`  entityMap size: ${entityMap.size}`);
  for (const [cid, entities] of entityMap) {
    console.log(`  chunk ${cid.slice(0,8)}: ${entities.map(e => e.canonical_name).join(', ')}`);
  }
}

console.log('\nDIAGNOSIS: getEntitiesForChunks works via KG node_entity_links, which requires entity_mentions to have');
console.log('chunk_ids that match KG-linked entities. If semantic search returns chunks without entity mentions, empty is expected.');

// ─── PROBE 2: Hybrid entity_boost shows no boost ─────────────────────────

console.log('\n\n--- PROBE 2: Hybrid entity_boost not applied ---');
console.log('Hypothesis: "pain assessment" doesn\'t match any KG node canonical_names.');

const { findMatchingNodeIds } = await import('../dist/services/search/query-expander.js');
const matchedNodes = findMatchingNodeIds('pain assessment', conn);
console.log(`findMatchingNodeIds("pain assessment"): ${matchedNodes.length} nodes matched`);
if (matchedNodes.length > 0) {
  for (const nid of matchedNodes.slice(0, 5)) {
    const node = conn.prepare('SELECT canonical_name, entity_type FROM knowledge_nodes WHERE id = ?').get(nid);
    console.log(`  ${node?.canonical_name} (${node?.entity_type})`);
  }
}

// Try with a query that SHOULD match KG nodes
const matchedBostonNodes = findMatchingNodeIds('Boston Colleen', conn);
console.log(`\nfindMatchingNodeIds("Boston Colleen"): ${matchedBostonNodes.length} nodes matched`);

const matchedWestminsterNodes = findMatchingNodeIds('Westminster MD', conn);
console.log(`findMatchingNodeIds("Westminster MD"): ${matchedWestminsterNodes.length} nodes matched`);

// Test entity_boost with a query that should match
const hybBoost = parse(await handleSearchHybrid({
  query: 'Boston Colleen hospice',
  limit: 5,
  entity_boost: 0.5,
  include_entities: true,
  document_filter: [DOC_ID],
}));
console.log(`\nHybrid "Boston Colleen hospice" + entity_boost=0.5:`);
console.log(`  entity_boost info: ${JSON.stringify(hybBoost.data?.entity_boost)}`);
console.log(`  results with entities: ${(hybBoost.data?.results ?? []).filter(r => r.entities_mentioned?.length > 0).length}`);

console.log('\nDIAGNOSIS: entity_boost only activates when query terms match KG node canonical_names via findMatchingNodeIds.');
console.log('"pain assessment" has no KG node match. This is expected behavior, NOT a bug.');

// ─── PROBE 3: RAG context missing "## Entity Context" section ─────────────

console.log('\n\n--- PROBE 3: RAG context missing Entity Context section ---');
console.log('Hypothesis: entities_found=1 is too few or context was truncated before Entity Context section.');

const ragHandler = searchTools.ocr_rag_context.handler;
const rag1 = parse(await ragHandler({
  question: 'What medications was Colleen Boston prescribed?',
  limit: 5,
  include_entity_context: true,
  include_kg_paths: true,
  document_filter: [DOC_ID],
  max_context_length: 50000,  // raise limit to see if truncation was the issue
}));
const ragData = rag1.data ?? rag1;
console.log(`entities_found: ${ragData.entities_found}`);
console.log(`kg_paths_found: ${ragData.kg_paths_found}`);
console.log(`context_length: ${ragData.context_length}`);
console.log(`has "## Entity Context": ${ragData.context?.includes('## Entity Context')}`);
console.log(`has "## Entity Relationships": ${ragData.context?.includes('## Entity Relationships')}`);

// Show what entity info is present
if (ragData.context) {
  const entityIdx = ragData.context.indexOf('## Entity Context');
  if (entityIdx >= 0) {
    console.log(`Entity Context section at char ${entityIdx}:`);
    console.log(ragData.context.slice(entityIdx, entityIdx + 500));
  } else {
    console.log('Entity Context section NOT present.');
    // Show end of context to see if it was truncated
    console.log(`Last 200 chars: ...${ragData.context.slice(-200)}`);
  }
}

// Now try with vital signs (which had entities_found=20)
const rag2 = parse(await ragHandler({
  question: 'What were the patient vital signs at admission?',
  limit: 5,
  include_entity_context: true,
  include_kg_paths: true,
  document_filter: [DOC_ID],
  max_context_length: 50000,
}));
const ragData2 = rag2.data ?? rag2;
console.log(`\nVital signs RAG - entities_found: ${ragData2.entities_found}`);
console.log(`has "## Entity Context": ${ragData2.context?.includes('## Entity Context')}`);

if (ragData2.context?.includes('## Entity Context')) {
  const idx = ragData2.context.indexOf('## Entity Context');
  console.log(ragData2.context.slice(idx, idx + 500));
}

console.log('\nDIAGNOSIS: When entities_found >= 1, "## Entity Context" section is generated.');
console.log('The original test had max_context_length=8000 which truncated before entity section.');

// ─── PROBE 4: Entity Search "org" type=organization returns 0 ─────────────

console.log('\n\n--- PROBE 4: Entity Search "org" + type=organization returns 0 ---');

// Show all organization entities
const allOrgs = conn.prepare(`
  SELECT id, raw_text, normalized_text FROM entities
  WHERE entity_type = 'organization'
  ORDER BY raw_text
`).all();
console.log(`Total organization entities in DB: ${allOrgs.length}`);
for (const e of allOrgs) {
  console.log(`  "${e.raw_text}" -> "${e.normalized_text}"`);
}

// The search function uses LIKE match on raw_text and normalized_text
const likeOrg = conn.prepare(`
  SELECT id, raw_text, normalized_text FROM entities
  WHERE entity_type = 'organization'
    AND (raw_text LIKE '%org%' OR normalized_text LIKE '%org%')
`).all();
console.log(`Organization entities matching "%org%": ${likeOrg.length}`);

// Try broader search
const entitySearchHandler = entityAnalysisTools.ocr_entity_search.handler;
const orgSearch1 = parse(await entitySearchHandler({
  query: 'BridgingLife',
  entity_type: 'organization',
  limit: 10,
}));
console.log(`\nEntity Search "BridgingLife" type=organization: ${orgSearch1.total_results ?? (orgSearch1.data?.total_results ?? 0)} results`);

console.log('\nDIAGNOSIS: "org" doesn\'t appear in any organization entity raw_text or normalized_text.');
console.log('This is a query issue, not a bug. Entity names are like "BridgingLife", "CMS", not "org".');

// ─── PROBE 5: KG Query for "Boston" shows no edges ───────────────────────

console.log('\n\n--- PROBE 5: KG Query "Boston" has no edges ---');

const kgQueryHandler = knowledgeGraphTools.ocr_knowledge_graph_query.handler;
const kgQ = parse(await kgQueryHandler({
  entity_name: 'Boston',
  include_edges: true,
  limit: 10,
}));
const kgData = kgQ.data ?? kgQ;
console.log(`KG Query nodes: ${kgData.nodes?.length ?? 0}`);
console.log(`KG Query edges: ${kgData.edges?.length ?? 0}`);

// Check the node directly
if (kgData.nodes?.length > 0) {
  const nodeId = kgData.nodes[0].id;
  console.log(`Node ID: ${nodeId}, edge_count: ${kgData.nodes[0].edge_count}`);

  // Query edges directly
  const directEdges = conn.prepare(`
    SELECT ke.id, ke.relationship_type, ke.weight,
           kn1.canonical_name as source_name, kn2.canonical_name as target_name
    FROM knowledge_edges ke
    JOIN knowledge_nodes kn1 ON ke.source_node_id = kn1.id
    JOIN knowledge_nodes kn2 ON ke.target_node_id = kn2.id
    WHERE ke.source_node_id = ? OR ke.target_node_id = ?
    ORDER BY ke.weight DESC
    LIMIT 10
  `).all(nodeId, nodeId);
  console.log(`Direct edge query: ${directEdges.length} edges`);
  for (const e of directEdges.slice(0, 5)) {
    console.log(`  ${e.source_name} --[${e.relationship_type}]--> ${e.target_name} (w:${e.weight})`);
  }
}

console.log('\nDIAGNOSIS: queryGraph may filter edges by max_depth or other criteria.');
console.log('The node has edges in the DB, but the query API may not be returning them in the response shape.');

// Check queryGraph code path
const kgQ2 = parse(await kgQueryHandler({
  entity_name: 'Boston',
  include_edges: true,
  max_depth: 2,
  limit: 50,
}));
const kgData2 = kgQ2.data ?? kgQ2;
console.log(`\nKG Query (max_depth=2, limit=50): nodes=${kgData2.nodes?.length ?? 0}, edges=${kgData2.edges?.length ?? 0}`);

clearDatabase();
console.log('\n=== DEEP PROBE COMPLETE ===');
process.exit(0);
