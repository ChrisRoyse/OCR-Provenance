/**
 * OCR Provenance MCP Server
 *
 * Entry point for the MCP server using stdio transport.
 * Exposes 104 OCR, search, provenance, clustering, and knowledge graph tools via JSON-RPC.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module index
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root before anything else reads process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { ToolDefinition } from './tools/shared.js';
import { databaseTools } from './tools/database.js';
import { ingestionTools } from './tools/ingestion.js';
import { searchTools } from './tools/search.js';
import { documentTools } from './tools/documents.js';
import { provenanceTools } from './tools/provenance.js';
import { configTools } from './tools/config.js';
import { vlmTools } from './tools/vlm.js';
import { imageTools } from './tools/images.js';
import { evaluationTools } from './tools/evaluation.js';
import { extractionTools } from './tools/extraction.js';
import { reportTools } from './tools/reports.js';
import { formFillTools } from './tools/form-fill.js';
import { structuredExtractionTools } from './tools/extraction-structured.js';
import { fileManagementTools } from './tools/file-management.js';
import { entityAnalysisTools } from './tools/entity-analysis.js';
import { comparisonTools } from './tools/comparison.js';
import { clusteringTools } from './tools/clustering.js';
import { knowledgeGraphTools } from './tools/knowledge-graph.js';
import { questionAnswerTools } from './tools/question-answer.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const server = new McpServer({
  name: 'ocr-provenance-mcp',
  version: '1.0.0',
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

// All tool modules in registration order
const allToolModules: Record<string, ToolDefinition>[] = [
  databaseTools,            // 5 tools
  ingestionTools,           // 8 tools
  searchTools,              // 8 tools
  documentTools,            // 3 tools
  provenanceTools,          // 3 tools
  configTools,              // 2 tools
  vlmTools,                 // 6 tools
  imageTools,               // 8 tools
  evaluationTools,          // 3 tools
  extractionTools,          // 3 tools
  reportTools,              // 4 tools
  formFillTools,            // 3 tools
  structuredExtractionTools, // 2 tools
  fileManagementTools,      // 5 tools
  entityAnalysisTools,      // 10 tools
  comparisonTools,          // 3 tools
  clusteringTools,          // 5 tools
  knowledgeGraphTools,      // 22 tools
  questionAnswerTools,      // 1 tool
];

for (const toolModule of allToolModules) {
  for (const [name, tool] of Object.entries(toolModule)) {
    server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OCR Provenance MCP Server running on stdio');
  console.error('Tools registered: 104');
}

// Log memory usage every 5 minutes for observability (stderr only - safe for MCP)
setInterval(() => {
  const mem = process.memoryUsage();
  console.error(
    `[Memory] RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB ` +
    `Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}/${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB ` +
    `External=${(mem.external / 1024 / 1024).toFixed(1)}MB`
  );
}, 300_000).unref();

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
