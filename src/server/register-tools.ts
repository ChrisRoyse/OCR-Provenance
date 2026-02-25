/**
 * Shared Tool Registration
 *
 * Registers all MCP tools on a given McpServer instance.
 * Used by both src/index.ts (stdio) and src/bin-http.ts (unified Docker entry).
 *
 * CRITICAL: NEVER use console.log() - stdout may be reserved for JSON-RPC protocol.
 *
 * @module server/register-tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition } from '../tools/shared.js';

import { databaseTools } from '../tools/database.js';
import { ingestionTools } from '../tools/ingestion.js';
import { searchTools } from '../tools/search.js';
import { documentTools } from '../tools/documents.js';
import { provenanceTools } from '../tools/provenance.js';
import { configTools } from '../tools/config.js';
import { vlmTools } from '../tools/vlm.js';
import { imageTools } from '../tools/images.js';
import { evaluationTools } from '../tools/evaluation.js';
import { extractionTools } from '../tools/extraction.js';
import { reportTools } from '../tools/reports.js';
import { formFillTools } from '../tools/form-fill.js';
import { structuredExtractionTools } from '../tools/extraction-structured.js';
import { fileManagementTools } from '../tools/file-management.js';
import { comparisonTools } from '../tools/comparison.js';
import { clusteringTools } from '../tools/clustering.js';
import { chunkTools } from '../tools/chunks.js';
import { embeddingTools } from '../tools/embeddings.js';
import { tagTools } from '../tools/tags.js';
import { intelligenceTools } from '../tools/intelligence.js';
import { healthTools } from '../tools/health.js';
import { userTools } from '../tools/users.js';
import { collaborationTools } from '../tools/collaboration.js';
import { workflowTools } from '../tools/workflow.js';
import { eventTools } from '../tools/events.js';
import { clmTools } from '../tools/clm.js';
import { complianceTools } from '../tools/compliance.js';

/** All tool modules in registration order */
const allToolModules: Record<string, ToolDefinition>[] = [
  databaseTools,
  ingestionTools,
  searchTools,
  documentTools,
  provenanceTools,
  configTools,
  vlmTools,
  imageTools,
  evaluationTools,
  extractionTools,
  reportTools,
  formFillTools,
  structuredExtractionTools,
  fileManagementTools,
  comparisonTools,
  clusteringTools,
  chunkTools,
  embeddingTools,
  tagTools,
  intelligenceTools,
  healthTools,
  userTools,
  collaborationTools,
  workflowTools,
  eventTools,
  clmTools,
  complianceTools,
];

/**
 * Register all tools on the given MCP server instance.
 *
 * @param server - McpServer instance to register tools on
 * @returns Number of tools registered
 * @throws Exits process with code 1 if duplicate tool names are detected
 */
export function registerAllTools(server: McpServer): number {
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

  return toolCount;
}

/**
 * Get total tool count without registering on a server instance.
 * Used by HTTP mode health endpoint to avoid creating a throwaway McpServer.
 */
export function getToolCount(): number {
  let count = 0;
  for (const toolModule of allToolModules) {
    count += Object.keys(toolModule).length;
  }
  return count;
}
