/**
 * OCR Provenance MCP Server
 *
 * Entry point for the MCP server using stdio transport.
 * Exposes 72 OCR, search, provenance, and clustering tools via JSON-RPC.
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
import { formFillTools } from './tools/form-fill.js';
import { structuredExtractionTools } from './tools/extraction-structured.js';
import { fileManagementTools } from './tools/file-management.js';
import { entityAnalysisTools } from './tools/entity-analysis.js';
import { comparisonTools } from './tools/comparison.js';
import { clusteringTools } from './tools/clustering.js';

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
// INGESTION TOOLS (8) - Extracted to src/tools/ingestion.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register ingestion tools from extracted module
for (const [name, tool] of Object.entries(ingestionTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOLS (5) - Extracted to src/tools/search.ts
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
// REPORT TOOLS (4) - Extracted to src/tools/reports.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register report tools from extracted module
for (const [name, tool] of Object.entries(reportTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORM FILL TOOLS (2) - Extracted to src/tools/form-fill.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register form fill tools from extracted module
for (const [name, tool] of Object.entries(formFillTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURED EXTRACTION TOOLS (2) - Extracted to src/tools/extraction-structured.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register structured extraction tools from extracted module
for (const [name, tool] of Object.entries(structuredExtractionTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE MANAGEMENT TOOLS (5) - Extracted to src/tools/file-management.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register file management tools from extracted module
for (const [name, tool] of Object.entries(fileManagementTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY ANALYSIS TOOLS (4) - Extracted to src/tools/entity-analysis.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register entity analysis tools from extracted module
for (const [name, tool] of Object.entries(entityAnalysisTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISON TOOLS (3) - Extracted to src/tools/comparison.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register comparison tools from extracted module
for (const [name, tool] of Object.entries(comparisonTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLUSTERING TOOLS (5) - Extracted to src/tools/clustering.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register clustering tools from extracted module
for (const [name, tool] of Object.entries(clusteringTools)) {
  server.tool(name, tool.description, tool.inputSchema as Record<string, unknown>, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OCR Provenance MCP Server running on stdio');
  console.error('Tools registered: 72');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
