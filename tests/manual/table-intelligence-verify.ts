/**
 * Table Intelligence Verification Script
 *
 * Re-ingests the Merit Review Template document after bug fixes in
 * countTableDimensions and flushAccumulator, then verifies all table
 * metadata improvements.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/home/cabdru/datalab/.env' });

import Database from 'better-sqlite3';
import {
  createDatabase as _createDatabase,
  selectDatabase as _selectDatabase,
  requireDatabase as _requireDatabase,
} from '../../src/server/state.js';
import { databaseTools } from '../../src/tools/database.js';
import { ingestionTools } from '../../src/tools/ingestion.js';
import { documentTools } from '../../src/tools/documents.js';
import { intelligenceTools } from '../../src/tools/intelligence.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

type ToolModule = Record<string, { handler: (p: Record<string, unknown>) => Promise<unknown> }>;

async function callTool(tools: ToolModule, name: string, params: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not found: ${name}. Available: ${Object.keys(tools).join(', ')}`);
  const raw = (await tool.handler(params)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(raw.content[0].text) as { success: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };
}

const DB_NAME = 'table-extraction-analysis';
const DB_PATH = `/home/cabdru/.ocr-provenance/databases/${DB_NAME}.db`;
const DOC_FILE = '/home/cabdru/datalab/data/geminidata/Merit Review Template V.3 (3) (1).docx';

async function main() {
  console.error('=== Table Intelligence Verification ===\n');

  // Step 1: Select the database
  console.error('Step 1: Selecting database...');
  const selResult = await callTool(databaseTools, 'ocr_db_select', { database_name: DB_NAME });
  if (!selResult.success) {
    console.error('ERROR: Failed to select database:', selResult.error);
    process.exit(1);
  }
  console.error('  Database selected OK\n');

  // Step 2: Delete ALL existing documents
  console.error('Step 2: Deleting existing documents...');
  const db = new Database(DB_PATH, { readonly: true });
  const existingDocs = db.prepare('SELECT id FROM documents').all() as { id: string }[];
  db.close();

  for (const doc of existingDocs) {
    console.error(`  Deleting document: ${doc.id}`);
    const delResult = await callTool(documentTools, 'ocr_document_delete', {
      document_id: doc.id,
      confirm: true,
    });
    if (!delResult.success) {
      console.error('  WARNING: Failed to delete document:', delResult.error);
    } else {
      console.error('  Deleted OK');
    }
  }
  if (existingDocs.length === 0) {
    console.error('  No existing documents found');
  }
  console.error('');

  // Step 3: Re-ingest
  console.error('Step 3: Ingesting document...');
  const ingestResult = await callTool(ingestionTools, 'ocr_ingest_files', {
    file_paths: [DOC_FILE],
  });
  if (!ingestResult.success) {
    console.error('ERROR: Failed to ingest:', ingestResult.error);
    process.exit(1);
  }
  console.error('  Ingest result:', JSON.stringify(ingestResult.data, null, 2).substring(0, 500));
  console.error('');

  // Step 4: Process pending
  console.error('Step 4: Processing pending...');
  const processResult = await callTool(ingestionTools, 'ocr_process_pending', {});
  if (!processResult.success) {
    console.error('ERROR: Failed to process pending:', processResult.error);
    process.exit(1);
  }
  console.error('  Process result:', JSON.stringify(processResult.data, null, 2).substring(0, 500));
  console.error('');

  // Get new document ID
  const db2 = new Database(DB_PATH, { readonly: true });
  const newDoc = db2.prepare('SELECT id FROM documents LIMIT 1').get() as { id: string };
  if (!newDoc) {
    console.error('ERROR: No document found after ingestion!');
    db2.close();
    process.exit(1);
  }
  const docId = newDoc.id;
  console.error(`  New document ID: ${docId}\n`);

  // Step 5: SQL Verification
  console.error('Step 5: SQL Verification...\n');

  // Query A: Count table chunks with ALL metadata fields
  const queryA = db2.prepare(`
    SELECT
      COUNT(*) as total_table_chunks,
      SUM(CASE WHEN processing_params LIKE '%table_columns%' THEN 1 ELSE 0 END) as with_columns,
      SUM(CASE WHEN json_extract(processing_params, '$.table_row_count') > 0 THEN 1 ELSE 0 END) as with_nonzero_row_count,
      SUM(CASE WHEN processing_params LIKE '%table_summary%' THEN 1 ELSE 0 END) as with_summary
    FROM provenance
    WHERE type = 'CHUNK' AND processing_params LIKE '%table%'
  `).get();
  console.error('  A) Table chunks with metadata:', JSON.stringify(queryA));

  // Query B: Row count distribution
  const queryB = db2.prepare(`
    SELECT json_extract(processing_params, '$.table_row_count') as row_count, COUNT(*) as cnt
    FROM provenance
    WHERE type = 'CHUNK' AND processing_params LIKE '%table_row_count%'
    GROUP BY json_extract(processing_params, '$.table_row_count')
    ORDER BY row_count
  `).all();
  console.error('  B) Row count distribution:', JSON.stringify(queryB));

  // Query C: content_types vs table_columns coverage
  const queryC = db2.prepare(`
    SELECT c.content_types, c.chunk_index,
      CASE WHEN p.processing_params LIKE '%table_columns%' THEN 'YES' ELSE 'NO' END as has_columns
    FROM chunks c
    JOIN provenance p ON c.provenance_id = p.id
    WHERE c.content_types LIKE '%table%'
    ORDER BY c.chunk_index
  `).all();
  console.error('  C) content_types vs table_columns:');
  for (const row of queryC) {
    console.error(`     chunk_index=${(row as any).chunk_index}, content_types=${(row as any).content_types}, has_columns=${(row as any).has_columns}`);
  }

  // Query D: Sample summaries
  const queryD = db2.prepare(`
    SELECT json_extract(processing_params, '$.table_summary') as summary
    FROM provenance
    WHERE type = 'CHUNK' AND processing_params LIKE '%table_summary%'
    LIMIT 5
  `).all();
  console.error('  D) Sample summaries:');
  for (const row of queryD) {
    console.error(`     "${(row as any).summary}"`);
  }

  // Query E: table_continuation_of
  const queryE = db2.prepare(`
    SELECT json_extract(processing_params, '$.table_continuation_of') as continuation
    FROM provenance
    WHERE type = 'CHUNK' AND processing_params LIKE '%table_continuation%'
  `).all();
  console.error('  E) Table continuations:', JSON.stringify(queryE));

  db2.close();
  console.error('');

  // Step 6: Test ocr_document_tables
  console.error('Step 6: Testing ocr_document_tables...');
  const tablesResult = await callTool(intelligenceTools, 'ocr_document_tables', {
    document_id: docId,
  });
  if (!tablesResult.success) {
    console.error('  ERROR:', tablesResult.error);
  } else {
    const data = tablesResult.data as any;
    const tables = data.tables || [];
    const totalTables = tables.length;
    const withPageNumber = tables.filter((t: any) => t.page_number != null).length;
    const withRowCountGt0 = tables.filter((t: any) => (t.row_count || 0) > 0).length;
    console.error(`  Total tables: ${totalTables}`);
    console.error(`  With page_number != null: ${withPageNumber}`);
    console.error(`  With row_count > 0: ${withRowCountGt0}`);

    // Show brief table info
    for (let i = 0; i < Math.min(tables.length, 5); i++) {
      const t = tables[i];
      console.error(`  Table ${i}: rows=${t.row_count}, cols=${t.column_count}, page=${t.page_number}, columns=[${(t.column_headers || []).slice(0, 3).join(', ')}...]`);
    }
  }
  console.error('');

  // Step 7: Test ocr_table_export
  console.error('Step 7: Testing ocr_table_export...');

  // 7a: JSON format, table_index=0
  console.error('  7a: JSON format, table_index=0');
  const export1 = await callTool(intelligenceTools, 'ocr_table_export', {
    document_id: docId,
    format: 'json',
    table_index: 0,
  });
  if (export1.success) {
    const data = export1.data as any;
    const tables = data.tables || [];
    console.error(`    PASS: Got ${tables.length} table(s) with ${JSON.stringify(data).length} bytes of data`);
    if (tables[0]) {
      console.error(`    First table: ${(tables[0].rows || []).length} rows, format=${tables[0].format || 'json'}`);
    }
  } else {
    console.error(`    FAIL: ${JSON.stringify(export1.error)}`);
  }

  // 7b: CSV format, table_index=1
  console.error('  7b: CSV format, table_index=1');
  const export2 = await callTool(intelligenceTools, 'ocr_table_export', {
    document_id: docId,
    format: 'csv',
    table_index: 1,
  });
  if (export2.success) {
    const data = export2.data as any;
    const tables = data.tables || [];
    console.error(`    PASS: Got ${tables.length} table(s)`);
    if (tables[0]) {
      const csvLen = (tables[0].csv || tables[0].content || '').length;
      console.error(`    CSV content length: ${csvLen} chars`);
    }
  } else {
    console.error(`    FAIL: ${JSON.stringify(export2.error)}`);
  }

  // 7c: Markdown format, table_index=0
  console.error('  7c: Markdown format, table_index=0');
  const export3 = await callTool(intelligenceTools, 'ocr_table_export', {
    document_id: docId,
    format: 'markdown',
    table_index: 0,
  });
  if (export3.success) {
    const data = export3.data as any;
    const tables = data.tables || [];
    console.error(`    PASS: Got ${tables.length} table(s)`);
    if (tables[0]) {
      const mdLen = (tables[0].markdown || tables[0].content || '').length;
      console.error(`    Markdown content length: ${mdLen} chars`);
    }
  } else {
    console.error(`    FAIL: ${JSON.stringify(export3.error)}`);
  }
  console.error('');

  // Step 8: Edge cases
  console.error('Step 8: Edge case testing...');

  // 8a: Invalid table_index
  console.error('  8a: Invalid table_index=999');
  const edgeCase1 = await callTool(intelligenceTools, 'ocr_table_export', {
    document_id: docId,
    format: 'json',
    table_index: 999,
  });
  if (!edgeCase1.success) {
    console.error(`    PASS: Got expected error: ${JSON.stringify(edgeCase1.error).substring(0, 200)}`);
  } else {
    // May return success with empty tables - check
    const data = edgeCase1.data as any;
    const tables = data.tables || [];
    if (tables.length === 0) {
      console.error('    PASS: Got empty result for out-of-range table_index');
    } else {
      console.error(`    UNEXPECTED: Got ${tables.length} tables for table_index=999`);
    }
  }

  // 8b: Missing document_id (should fail validation)
  console.error('  8b: Missing document_id');
  try {
    const edgeCase2 = await callTool(intelligenceTools, 'ocr_table_export', {
      format: 'json',
      table_index: 0,
    });
    if (!edgeCase2.success) {
      console.error(`    PASS: Got expected error: ${JSON.stringify(edgeCase2.error).substring(0, 200)}`);
    } else {
      console.error('    FAIL: Should have failed without document_id');
    }
  } catch (e: any) {
    console.error(`    PASS: Got expected exception: ${e.message.substring(0, 200)}`);
  }
  console.error('');

  // ═══════════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════════
  console.error('=== FINAL SUMMARY ===');
  console.error(`Document ID: ${docId}`);
  console.error(`Table chunks total: ${(queryA as any).total_table_chunks}`);
  console.error(`With columns: ${(queryA as any).with_columns}`);
  console.error(`With nonzero row_count: ${(queryA as any).with_nonzero_row_count}`);
  console.error(`With summary: ${(queryA as any).with_summary}`);
  console.error(`Row count distribution: ${JSON.stringify(queryB)}`);
  console.error(`Table continuations: ${queryE.length}`);

  // Output JSON summary to stdout for capture
  const summary = {
    document_id: docId,
    sql_verification: {
      total_table_chunks: (queryA as any).total_table_chunks,
      with_columns: (queryA as any).with_columns,
      with_nonzero_row_count: (queryA as any).with_nonzero_row_count,
      with_summary: (queryA as any).with_summary,
      row_count_distribution: queryB,
      content_types_coverage: queryC,
      sample_summaries: queryD,
      table_continuations: queryE,
    },
    document_tables: tablesResult.success ? {
      total: ((tablesResult.data as any).tables || []).length,
      with_page_number: ((tablesResult.data as any).tables || []).filter((t: any) => t.page_number != null).length,
      with_row_count_gt0: ((tablesResult.data as any).tables || []).filter((t: any) => (t.row_count || 0) > 0).length,
    } : { error: tablesResult.error },
    table_export: {
      json: export1.success ? 'PASS' : 'FAIL',
      csv: export2.success ? 'PASS' : 'FAIL',
      markdown: export3.success ? 'PASS' : 'FAIL',
    },
    edge_cases: {
      invalid_index: !edgeCase1.success || ((edgeCase1.data as any)?.tables || []).length === 0 ? 'PASS' : 'FAIL',
    },
  };

  // Output to stdout
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
