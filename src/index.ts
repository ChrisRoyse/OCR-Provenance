/**
 * OCR Provenance MCP Server
 *
 * Entry point for the MCP server using stdio transport.
 * Exposes 20 OCR, search, and provenance tools via JSON-RPC.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module index
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { databaseTools } from './tools/database.js';
import { ingestionTools } from './tools/ingestion.js';
import { searchTools } from './tools/search.js';
import { documentTools } from './tools/documents.js';
import { provenanceTools } from './tools/provenance.js';
import { configTools } from './tools/config.js';

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
// SEARCH TOOLS (3) - Extracted to src/tools/search.ts
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
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OCR Provenance MCP Server running on stdio');
  console.error('Tools registered: 20');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
