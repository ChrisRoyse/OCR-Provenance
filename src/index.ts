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
import fs from 'fs';
import { fileURLToPath } from 'url';

// Load .env from multiple candidate locations (first found wins):
// 1. OCR_PROVENANCE_ENV_FILE env var (explicit override)
// 2. CWD/.env (project-local)
// 3. Package root/.env (development)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  process.env.OCR_PROVENANCE_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '.env'),
].filter((p): p is string => typeof p === 'string');

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { ToolDefinition } from './tools/shared.js';
import { updateConfig } from './server/state.js';
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
  databaseTools, // 5 tools
  ingestionTools, // 8 tools
  searchTools, // 8 tools
  documentTools, // 3 tools
  provenanceTools, // 3 tools
  configTools, // 2 tools
  vlmTools, // 6 tools
  imageTools, // 8 tools
  evaluationTools, // 3 tools
  extractionTools, // 3 tools
  reportTools, // 4 tools
  formFillTools, // 3 tools
  structuredExtractionTools, // 2 tools
  fileManagementTools, // 5 tools
  entityAnalysisTools, // 10 tools
  comparisonTools, // 3 tools
  clusteringTools, // 5 tools
  knowledgeGraphTools, // 22 tools
  questionAnswerTools, // 1 tool
];

// Register tools with duplicate detection
const registeredToolNames = new Set<string>();
let toolCount = 0;

for (const toolModule of allToolModules) {
  for (const [name, tool] of Object.entries(toolModule)) {
    if (registeredToolNames.has(name)) {
      console.error(
        `[FATAL] Duplicate tool name detected: "${name}". Each tool must have a unique name.`
      );
      process.exit(1);
    }
    registeredToolNames.add(name);
    server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
    toolCount++;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate startup dependencies before serving requests.
 * Fail-fast: if anything is missing, log a clear error and exit.
 */
function validateStartupDependencies(): void {
  const warnings: string[] = [];

  if (!process.env.DATALAB_API_KEY) {
    warnings.push(
      'DATALAB_API_KEY is not set. OCR processing will fail. Get one at https://www.datalab.to'
    );
  }
  if (!process.env.GEMINI_API_KEY) {
    warnings.push(
      'GEMINI_API_KEY is not set. Entity extraction, VLM, and QA will fail. Get one at https://aistudio.google.com/'
    );
  }

  if (warnings.length > 0) {
    console.error('=== STARTUP WARNINGS ===');
    for (const w of warnings) {
      console.error(`  - ${w}`);
    }
    console.error('========================');
  }

  // Apply environment-driven config overrides
  const embeddingDevice = process.env.EMBEDDING_DEVICE;
  if (embeddingDevice) {
    updateConfig({ embeddingDevice });
    console.error(`[Config] EMBEDDING_DEVICE=${embeddingDevice}`);
  }
}

async function main(): Promise<void> {
  validateStartupDependencies();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`OCR Provenance MCP Server running on stdio`);
  console.error(`Tools registered: ${toolCount}`);
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

// Graceful shutdown handler
function handleShutdown(signal: string): void {
  console.error(`[Shutdown] Received ${signal}, shutting down gracefully...`);
  // Close the MCP server connection
  server
    .close()
    .then(() => {
      console.error('[Shutdown] Server closed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[Shutdown] Error closing server: ${err}`);
      process.exit(1);
    });
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    console.error('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
