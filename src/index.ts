/**
 * OCR Provenance MCP Server
 *
 * Entry point for the MCP server using stdio transport.
 * Exposes 47 OCR, search, and provenance tools via JSON-RPC.
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

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const server = new McpServer({
  name: 'ocr-provenance-mcp',
  version: '1.0.0',
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE TOOLS (5) - Extracted to src/tools/database.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register database tools from extracted module
for (const [name, tool] of Object.entries(databaseTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INGESTION TOOLS (4) - Extracted to src/tools/ingestion.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register ingestion tools from extracted module
for (const [name, tool] of Object.entries(ingestionTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOLS (7) - Extracted to src/tools/search.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register search tools from extracted module
for (const [name, tool] of Object.entries(searchTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT TOOLS (3) - Extracted to src/tools/documents.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register document tools from extracted module
for (const [name, tool] of Object.entries(documentTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE TOOLS (3) - Extracted to src/tools/provenance.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register provenance tools from extracted module
for (const [name, tool] of Object.entries(provenanceTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG TOOLS (2) - New in src/tools/config.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register config tools from new module
for (const [name, tool] of Object.entries(configTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VLM TOOLS (6) - Extracted to src/tools/vlm.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register VLM tools from extracted module
for (const [name, tool] of Object.entries(vlmTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE TOOLS (8) - Extracted to src/tools/images.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register image tools from extracted module
for (const [name, tool] of Object.entries(imageTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATION TOOLS (3) - Extracted to src/tools/evaluation.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register evaluation tools from extracted module
for (const [name, tool] of Object.entries(evaluationTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTION TOOLS (3) - Extracted to src/tools/extraction.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register extraction tools from extracted module
for (const [name, tool] of Object.entries(extractionTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT TOOLS (3) - Extracted to src/tools/reports.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register report tools from extracted module
for (const [name, tool] of Object.entries(reportTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OCR Provenance MCP Server running on stdio');
  console.error('Tools registered: 47');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
