/**
 * Probe: Why do semantic search results have chunk_id=undefined?
 * This is the root cause of entities being empty for semantic search.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const { selectDatabase, requireDatabase, clearDatabase } = await import('../dist/server/state.js');

const DB_NAME = 'bridginglife-benchmark';
const DOC_ID = '79c86a0b-d210-4bf5-ac54-23552c6dd924';

selectDatabase(DB_NAME);
const { db, vector } = requireDatabase();
const conn = db.getConnection();

console.log('=== PROBE: Semantic Search chunk_id analysis ===\n');

// Check what types of embeddings exist (by chunk_id vs image_id presence)
const embTypes = conn.prepare(`
  SELECT
    CASE
      WHEN chunk_id IS NOT NULL THEN 'chunk'
      WHEN image_id IS NOT NULL THEN 'image'
      WHEN extraction_id IS NOT NULL THEN 'extraction'
      ELSE 'unknown'
    END as emb_type,
    COUNT(*) as cnt
  FROM embeddings
  WHERE document_id = ?
  GROUP BY emb_type
`).all(DOC_ID);
console.log('Embedding types for document:');
for (const et of embTypes) {
  console.log(`  ${et.emb_type}: ${et.cnt}`);
}

// Check how many embeddings with chunk_id exist
const chunkEmbeddings = conn.prepare(`
  SELECT COUNT(*) as cnt FROM embeddings
  WHERE document_id = ? AND chunk_id IS NOT NULL
`).get(DOC_ID);
console.log(`\nEmbeddings with chunk_id: ${chunkEmbeddings.cnt}`);

// Get the actual vector search results with raw data
const { getEmbeddingService } = await import('../dist/services/embedding/embedder.js');
const embedder = getEmbeddingService();
const queryVector = await embedder.embedSearchQuery('patient vital signs');

const results = vector.searchSimilar(queryVector, {
  limit: 5,
  threshold: 0.3,
  documentFilter: [DOC_ID],
});

console.log('\nSemantic search raw results:');
for (const r of results) {
  console.log(`  chunk_id: ${r.chunk_id ?? 'NULL'}`);
  console.log(`  image_id: ${r.image_id ?? 'NULL'}`);
  console.log(`  result_type: ${r.result_type}`);
  console.log(`  similarity: ${r.similarity_score}`);
  console.log(`  text: ${(r.original_text ?? '').slice(0, 80)}...`);
  console.log('');
}

// Check: are VLM embeddings (image_id set, chunk_id null) the majority?
const vlmCount = results.filter(r => r.image_id && !r.chunk_id).length;
const chunkCount = results.filter(r => r.chunk_id).length;
console.log(`Results breakdown: ${chunkCount} chunk-based, ${vlmCount} VLM/image-based`);

console.log('\nDIAGNOSIS: Semantic search returns VLM image description embeddings (chunk_id=NULL).');
console.log('getEntitiesForChunks requires chunk_ids, so VLM results have no entities attached.');
console.log('This is a KNOWN LIMITATION: entity enrichment only works for chunk-type results.');

// Now test with a query that should match text chunks
console.log('\n--- Testing with text-focused query ---');
const queryVector2 = await embedder.embedSearchQuery('Boston, Colleen patient assessment');
const results2 = vector.searchSimilar(queryVector2, {
  limit: 10,
  threshold: 0.3,
  documentFilter: [DOC_ID],
});
const chunkResults2 = results2.filter(r => r.chunk_id);
const vlmResults2 = results2.filter(r => !r.chunk_id);
console.log(`"Boston, Colleen patient assessment": ${chunkResults2.length} chunk, ${vlmResults2.length} VLM results`);

// Check if entity mentions exist for those chunks
if (chunkResults2.length > 0) {
  const { getEntitiesForChunks } = await import('../dist/services/storage/database/knowledge-graph-operations.js');
  const chunkIds = chunkResults2.map(r => r.chunk_id);
  const entityMap = getEntitiesForChunks(conn, chunkIds);
  console.log(`Entities found for ${chunkIds.length} chunks: ${entityMap.size} chunks have entities`);
  for (const [cid, entities] of entityMap) {
    console.log(`  chunk ${cid.slice(0,8)}: ${entities.map(e => `${e.canonical_name}(${e.entity_type})`).join(', ')}`);
  }
}

clearDatabase();
process.exit(0);
