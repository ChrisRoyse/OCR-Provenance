/**
 * Phase 3 Test Script - OCR Processing Pipeline
 * Sends MCP JSON-RPC requests via stdin/stdout to the server process.
 */
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let messageId = 0;

function nextId() { return ++messageId; }

function startServer() {
  const proc = spawn('node', [resolve(ROOT, 'dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: ROOT,
  });

  let buffer = '';
  const pending = new Map();

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    // Try to parse complete JSON messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch (e) {
        // Skip non-JSON lines (like startup banner)
      }
    }
  });

  proc.stderr.on('data', (data) => {
    // Log stderr for debugging
    const text = data.toString().trim();
    if (text) {
      for (const line of text.split('\n')) {
        console.error(`  [server] ${line}`);
      }
    }
  });

  function send(msg) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(msg.id);
        reject(new Error(`Timeout waiting for response to id=${msg.id} method=${msg.method}`));
      }, 300000); // 5 min timeout for OCR processing

      pending.set(msg.id, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });

      proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  function notify(msg) {
    proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  async function init() {
    const resp = await send({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-phase3', version: '1.0' },
      },
    });
    notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return resp;
  }

  async function callTool(name, args) {
    const resp = await send({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return resp;
  }

  function close() {
    proc.stdin.end();
    proc.kill();
  }

  return { init, callTool, close, proc };
}

function extractContent(resp) {
  if (resp.error) return { error: resp.error };
  const content = resp.result?.content;
  if (!content || !content.length) return null;
  const text = content[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  console.log('Starting MCP server...');
  const server = startServer();

  try {
    const initResp = await server.init();
    console.log('Server initialized:', initResp.result?.serverInfo?.name || 'ok');

    // Select database
    console.log('\n--- Selecting database: test-legal-docs ---');
    const dbResp = await server.callTool('ocr_db_select', { database_name: 'test-legal-docs' });
    const dbResult = extractContent(dbResp);
    console.log('DB select result:', JSON.stringify(dbResult, null, 2)?.substring(0, 500));

    // Check status before processing
    console.log('\n--- Pre-processing status ---');
    const statusBefore = await server.callTool('ocr_status', {});
    const statusBeforeData = extractContent(statusBefore);
    console.log('Status before:', JSON.stringify(statusBeforeData, null, 2)?.substring(0, 800));

    // ========================================
    // TEST 3.1: Process Single Pending Document
    // ========================================
    console.log('\n=== TEST 3.1: Process Single Pending Document ===');
    console.log('Calling ocr_process_pending with max_concurrent=1...');
    const processResp = await server.callTool('ocr_process_pending', { max_concurrent: 1 });
    const processResult = extractContent(processResp);
    console.log('Process result:', JSON.stringify(processResult, null, 2)?.substring(0, 2000));

    if (processResp.error) {
      console.error('ERROR in ocr_process_pending:', JSON.stringify(processResp.error, null, 2));
      server.close();
      process.exit(1);
    }

    // Check status after processing
    console.log('\n--- Post-processing status ---');
    const statusAfter = await server.callTool('ocr_status', {});
    const statusAfterData = extractContent(statusAfter);
    console.log('Status after:', JSON.stringify(statusAfterData, null, 2)?.substring(0, 800));

    // Get db stats
    console.log('\n--- DB Stats ---');
    const statsResp = await server.callTool('ocr_db_stats', {});
    const statsData = extractContent(statsResp);
    console.log('DB Stats:', JSON.stringify(statsData, null, 2)?.substring(0, 1000));

    // Find a completed document
    const completedDocs = statusAfterData?.documents?.filter(d => d.status === 'complete') || [];
    console.log(`\nCompleted documents: ${completedDocs.length}`);

    if (completedDocs.length === 0) {
      console.error('NO documents completed! Test 3.1 FAILED.');
      // Try to process more to see what happens
      console.log('\n--- Attempting to process all remaining ---');
      const processAll = await server.callTool('ocr_process_pending', { max_concurrent: 5 });
      console.log('Process all result:', JSON.stringify(extractContent(processAll), null, 2)?.substring(0, 2000));
      server.close();
      process.exit(1);
    }

    const docId = completedDocs[0].id || completedDocs[0].document_id;
    console.log(`Using completed doc: ${docId} (${completedDocs[0].file_name})`);

    // Get document with text
    console.log('\n--- Get document with text ---');
    const docTextResp = await server.callTool('ocr_document_get', { document_id: docId, include_text: true });
    const docTextData = extractContent(docTextResp);
    const hasText = docTextData?.document?.ocr_text?.length > 0 || docTextData?.ocr_text?.length > 0;
    console.log(`Has OCR text: ${hasText}`);
    if (docTextData?.document?.ocr_text) {
      console.log(`Text length: ${docTextData.document.ocr_text.length}`);
      console.log(`Text preview: ${docTextData.document.ocr_text.substring(0, 200)}...`);
    }

    // Get document with chunks
    console.log('\n--- Get document with chunks ---');
    const docChunksResp = await server.callTool('ocr_document_get', { document_id: docId, include_chunks: true });
    const docChunksData = extractContent(docChunksResp);
    const chunks = docChunksData?.chunks || docChunksData?.document?.chunks || [];
    console.log(`Chunks count: ${chunks.length}`);

    // Get provenance
    console.log('\n--- Get provenance ---');
    const provResp = await server.callTool('ocr_provenance_get', { entity_id: docId });
    const provData = extractContent(provResp);
    console.log('Provenance:', JSON.stringify(provData, null, 2)?.substring(0, 1000));

    console.log('\n=== TEST 3.1 RESULTS ===');
    console.log(`  [${completedDocs.length > 0 ? 'PASS' : 'FAIL'}] At least 1 doc complete`);
    console.log(`  [${hasText ? 'PASS' : 'FAIL'}] Has OCR text`);
    console.log(`  [${chunks.length > 0 ? 'PASS' : 'FAIL'}] Has chunks`);
    const chunkCount = statsData?.chunk_count || statsData?.chunks || 0;
    const embeddingCount = statsData?.embedding_count || statsData?.embeddings || 0;
    console.log(`  [${chunkCount > 0 ? 'PASS' : 'FAIL'}] chunk_count > 0 (${chunkCount})`);
    console.log(`  [${embeddingCount > 0 ? 'PASS' : 'FAIL'}] embedding_count > 0 (${embeddingCount})`);
    console.log(`  [${provData ? 'PASS' : 'FAIL'}] Provenance record exists`);

    // ========================================
    // TEST 3.2: Verify Chunk Content
    // ========================================
    console.log('\n=== TEST 3.2: Verify Chunk Content ===');
    const docFullResp = await server.callTool('ocr_document_get', { document_id: docId, include_text: true, include_chunks: true });
    const docFullData = extractContent(docFullResp);
    const fullText = docFullData?.document?.ocr_text || docFullData?.ocr_text || '';
    const fullChunks = docFullData?.chunks || docFullData?.document?.chunks || [];

    console.log(`Full text length: ${fullText.length}`);
    console.log(`Chunks array length: ${fullChunks.length}`);

    let chunk0Valid = false;
    if (fullChunks.length > 0) {
      const c0 = fullChunks[0];
      console.log(`Chunk[0] keys: ${Object.keys(c0).join(', ')}`);
      console.log(`Chunk[0] text preview: ${(c0.text || c0.content || '').substring(0, 200)}...`);
      console.log(`Chunk[0] char_start: ${c0.character_start ?? c0.char_start ?? 'N/A'}`);
      console.log(`Chunk[0] char_end: ${c0.character_end ?? c0.char_end ?? 'N/A'}`);
      console.log(`Chunk[0] chunk_index: ${c0.chunk_index ?? c0.index ?? 'N/A'}`);

      const chunkText = c0.text || c0.content || '';
      chunk0Valid = fullText.includes(chunkText.trim().substring(0, 50));
      console.log(`Chunk[0] text is substring of full text: ${chunk0Valid}`);
    }

    console.log('\n=== TEST 3.2 RESULTS ===');
    console.log(`  [${fullChunks.length > 0 ? 'PASS' : 'FAIL'}] Chunks array non-empty`);
    if (fullChunks.length > 0) {
      const c0 = fullChunks[0];
      const hasFields = (c0.text || c0.content) &&
        (c0.character_start !== undefined || c0.char_start !== undefined) &&
        (c0.character_end !== undefined || c0.char_end !== undefined) &&
        (c0.chunk_index !== undefined || c0.index !== undefined);
      console.log(`  [${hasFields ? 'PASS' : 'FAIL'}] Chunk has required fields`);
      console.log(`  [${chunk0Valid ? 'PASS' : 'FAIL'}] Chunk[0] text is substring of OCR text`);
    }

    // ========================================
    // TEST 3.3: Verify Embeddings (Semantic Search)
    // ========================================
    console.log('\n=== TEST 3.3: Verify Embeddings (Semantic Search) ===');
    // Use a generic query that should match any legal document
    const searchQuery = completedDocs[0].file_name?.includes('Conflict')
      ? 'conflict of interest policy'
      : completedDocs[0].file_name?.includes('Injunction')
        ? 'preliminary injunction court order'
        : 'legal document';

    console.log(`Search query: "${searchQuery}"`);
    const searchResp = await server.callTool('ocr_search_semantic', { query: searchQuery, limit: 5 });
    const searchData = extractContent(searchResp);
    console.log('Search result:', JSON.stringify(searchData, null, 2)?.substring(0, 2000));

    const results = searchData?.results || [];
    const hasOriginalText = results.length > 0 && (results[0].original_text || results[0].text);
    const similarity = results.length > 0 ? (results[0].similarity || results[0].score || 0) : 0;

    console.log('\n=== TEST 3.3 RESULTS ===');
    console.log(`  [${results.length > 0 ? 'PASS' : 'FAIL'}] Search returned results (${results.length})`);
    console.log(`  [${hasOriginalText ? 'PASS' : 'FAIL'}] Result has original_text`);
    console.log(`  [${similarity > 0.7 ? 'PASS' : 'FAIL'}] Similarity > 0.7 (${similarity})`);

    // ========================================
    // Now process remaining documents for Tests 3.5 and 3.6
    // ========================================
    console.log('\n=== Processing remaining documents ===');
    const processAllResp = await server.callTool('ocr_process_pending', { max_concurrent: 4 });
    const processAllResult = extractContent(processAllResp);
    console.log('Process remaining:', JSON.stringify(processAllResult, null, 2)?.substring(0, 2000));

    // ========================================
    // TEST 3.5: Process When Nothing is Pending
    // ========================================
    console.log('\n=== TEST 3.5: Process When Nothing is Pending ===');
    const processNoneResp = await server.callTool('ocr_process_pending', { max_concurrent: 1 });
    const processNoneResult = extractContent(processNoneResp);
    console.log('Process none result:', JSON.stringify(processNoneResult, null, 2)?.substring(0, 1000));

    const noPendingOk = !processNoneResp.error;
    const zeroProcessed = processNoneResult?.processed === 0 ||
      processNoneResult?.summary?.processed === 0 ||
      (typeof processNoneResult === 'string' && processNoneResult.includes('0'));

    console.log('\n=== TEST 3.5 RESULTS ===');
    console.log(`  [${noPendingOk ? 'PASS' : 'FAIL'}] No error returned`);
    console.log(`  [${zeroProcessed ? 'PASS' : 'FAIL'}] 0 documents processed`);

    // ========================================
    // TEST 3.6: Chunk Complete on Already-Chunked Doc
    // ========================================
    console.log('\n=== TEST 3.6: Chunk Complete on Already-Chunked Doc ===');
    const chunkResp = await server.callTool('ocr_chunk_complete', {});
    const chunkResult = extractContent(chunkResp);
    console.log('Chunk complete result:', JSON.stringify(chunkResult, null, 2)?.substring(0, 1000));

    const chunkNoError = !chunkResp.error;
    const zeroNewChunks = chunkResult?.new_chunks === 0 ||
      chunkResult?.chunks_created === 0 ||
      (typeof chunkResult === 'string' && chunkResult.includes('0'));

    console.log('\n=== TEST 3.6 RESULTS ===');
    console.log(`  [${chunkNoError ? 'PASS' : 'FAIL'}] No error`);
    console.log(`  [${zeroNewChunks ? 'PASS' : 'FAIL'}] 0 new chunks`);

    // Final DB stats
    console.log('\n--- Final DB Stats ---');
    const finalStats = await server.callTool('ocr_db_stats', {});
    console.log('Final stats:', JSON.stringify(extractContent(finalStats), null, 2)?.substring(0, 1000));

    // Final status
    console.log('\n--- Final Status ---');
    const finalStatus = await server.callTool('ocr_status', {});
    console.log('Final status:', JSON.stringify(extractContent(finalStatus), null, 2)?.substring(0, 1500));

    server.close();
    console.log('\n=== ALL PHASE 3 TESTS COMPLETE ===');

  } catch (err) {
    console.error('FATAL ERROR:', err.message);
    console.error('Stack:', err.stack);
    server.close();
    process.exit(1);
  }
}

main();
