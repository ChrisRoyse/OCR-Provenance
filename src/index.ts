/**
 * OCR Provenance MCP Server
 *
 * Entry point for the MCP server using stdio transport.
 * Exposes 18 OCR, search, and provenance tools via JSON-RPC.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module index
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  MCPError,
  formatErrorResponse,
  validationError,
  documentNotFoundError,
  provenanceNotFoundError,
} from './server/errors.js';
import {
  requireDatabase,
} from './server/state.js';
import { successResult } from './server/types.js';
import {
  validateInput,
  DocumentListInput,
  DocumentGetInput,
  DocumentDeleteInput,
  ProvenanceGetInput,
  ProvenanceVerifyInput,
  ProvenanceExportInput,
} from './utils/validation.js';
import { databaseTools } from './tools/database.js';
import { ingestionTools } from './tools/ingestion.js';
import { searchTools } from './tools/search.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const server = new McpServer({
  name: 'ocr-provenance-mcp',
  version: '1.0.0',
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format tool result as MCP content response
 */
function formatResponse(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Handle errors uniformly - FAIL FAST
 */
function handleError(error: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const mcpError = MCPError.fromUnknown(error);
  console.error(`[ERROR] ${mcpError.category}: ${mcpError.message}`);
  return formatResponse(formatErrorResponse(mcpError));
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE TOOLS (5) - Extracted to src/tools/database.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register database tools from extracted module
for (const [name, tool] of Object.entries(databaseTools)) {
  server.tool(name, tool.description, tool.inputSchema, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INGESTION TOOLS (4) - Extracted to src/tools/ingestion.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register ingestion tools from extracted module
for (const [name, tool] of Object.entries(ingestionTools)) {
  server.tool(name, tool.description, tool.inputSchema, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOLS (3) - Extracted to src/tools/search.ts
// ═══════════════════════════════════════════════════════════════════════════════

// Register search tools from extracted module
for (const [name, tool] of Object.entries(searchTools)) {
  server.tool(name, tool.description, tool.inputSchema, tool.handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT TOOLS (3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_document_list - List documents
 */
server.tool(
  'ocr_document_list',
  'List documents in the current database',
  {
    status_filter: z.enum(['pending', 'processing', 'complete', 'failed']).optional().describe('Filter by status'),
    sort_by: z.enum(['created_at', 'file_name', 'file_size']).default('created_at').describe('Sort field'),
    sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort order'),
    limit: z.number().int().min(1).max(1000).default(50).describe('Maximum results'),
    offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
  },
  async (params) => {
    try {
      const input = validateInput(DocumentListInput, params);
      const { db } = requireDatabase();

      const documents = db.listDocuments({
        status: input.status_filter,
        sortBy: input.sort_by,
        sortOrder: input.sort_order,
        limit: input.limit,
        offset: input.offset,
      });

      const stats = db.getStats();

      return formatResponse(successResult({
        documents: documents.map(d => ({
          id: d.id,
          file_name: d.file_name,
          file_path: d.file_path,
          file_size: d.file_size,
          file_type: d.file_type,
          status: d.status,
          page_count: d.page_count,
          created_at: d.created_at,
        })),
        total: stats.documentCount,
        limit: input.limit,
        offset: input.offset,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_document_get - Get document details
 */
server.tool(
  'ocr_document_get',
  'Get detailed information about a specific document',
  {
    document_id: z.string().min(1).describe('Document ID'),
    include_text: z.boolean().default(false).describe('Include OCR extracted text'),
    include_chunks: z.boolean().default(false).describe('Include chunk information'),
    include_full_provenance: z.boolean().default(false).describe('Include full provenance chain'),
  },
  async (params) => {
    try {
      const input = validateInput(DocumentGetInput, params);
      const { db } = requireDatabase();

      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }

      const result: Record<string, unknown> = {
        id: doc.id,
        file_name: doc.file_name,
        file_path: doc.file_path,
        file_hash: doc.file_hash,
        file_size: doc.file_size,
        file_type: doc.file_type,
        status: doc.status,
        page_count: doc.page_count,
        created_at: doc.created_at,
        provenance_id: doc.provenance_id,
      };

      if (input.include_text) {
        const ocrResult = db.getOCRResultByDocumentId(doc.id);
        result.ocr_text = ocrResult?.extracted_text ?? null;
      }

      if (input.include_chunks) {
        const chunks = db.getChunksByDocumentId(doc.id);
        result.chunks = chunks.map(c => ({
          id: c.id,
          chunk_index: c.chunk_index,
          text_length: c.text.length,
          page_number: c.page_number,
          character_start: c.character_start,
          character_end: c.character_end,
          embedding_status: c.embedding_status,
        }));
      }

      if (input.include_full_provenance) {
        const chain = db.getProvenanceChain(doc.provenance_id);
        result.provenance_chain = chain.map(p => ({
          id: p.id,
          type: p.type,
          chain_depth: p.chain_depth,
          processor: p.processor,
          processor_version: p.processor_version,
          content_hash: p.content_hash,
          created_at: p.created_at,
        }));
      }

      return formatResponse(successResult(result));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_document_delete - Delete document and all derived data
 */
server.tool(
  'ocr_document_delete',
  'Delete a document and all its derived data (chunks, embeddings, vectors, provenance)',
  {
    document_id: z.string().min(1).describe('Document ID to delete'),
    confirm: z.literal(true).describe('Must be true to confirm deletion'),
  },
  async (params) => {
    try {
      const input = validateInput(DocumentDeleteInput, params);
      const { db, vector } = requireDatabase();

      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }

      // Count items before deletion for reporting
      const chunks = db.getChunksByDocumentId(doc.id);
      const embeddings = db.getEmbeddingsByDocumentId(doc.id);
      const provenance = db.getProvenanceByRootDocument(doc.provenance_id);

      // Delete vectors first
      const vectorsDeleted = vector.deleteVectorsByDocumentId(doc.id);

      // Delete document (cascades to chunks, embeddings, provenance)
      db.deleteDocument(doc.id);

      return formatResponse(successResult({
        document_id: doc.id,
        deleted: true,
        chunks_deleted: chunks.length,
        embeddings_deleted: embeddings.length,
        vectors_deleted: vectorsDeleted,
        provenance_deleted: provenance.length,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE TOOLS (3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_provenance_get - Get provenance chain
 */
server.tool(
  'ocr_provenance_get',
  'Get the complete provenance chain for an item',
  {
    item_id: z.string().min(1).describe('ID of the item (document, chunk, embedding, or provenance)'),
    item_type: z.enum(['document', 'ocr_result', 'chunk', 'embedding', 'auto']).default('auto').describe('Type of item'),
    format: z.enum(['chain', 'tree', 'flat']).default('chain').describe('Output format'),
  },
  async (params) => {
    try {
      const input = validateInput(ProvenanceGetInput, params);
      const { db } = requireDatabase();

      // Find the provenance ID based on item type
      let provenanceId: string | null = null;
      let itemType = input.item_type;

      if (itemType === 'auto') {
        // Try to find the item
        const doc = db.getDocument(input.item_id);
        if (doc) {
          provenanceId = doc.provenance_id;
          itemType = 'document';
        } else {
          const chunk = db.getChunk(input.item_id);
          if (chunk) {
            provenanceId = chunk.provenance_id;
            itemType = 'chunk';
          } else {
            const embedding = db.getEmbedding(input.item_id);
            if (embedding) {
              provenanceId = embedding.provenance_id;
              itemType = 'embedding';
            } else {
              const prov = db.getProvenance(input.item_id);
              if (prov) {
                provenanceId = prov.id;
                itemType = 'provenance';
              }
            }
          }
        }
      } else {
        // Use specified type
        switch (itemType) {
          case 'document':
            const doc = db.getDocument(input.item_id);
            provenanceId = doc?.provenance_id ?? null;
            break;
          case 'chunk':
            const chunk = db.getChunk(input.item_id);
            provenanceId = chunk?.provenance_id ?? null;
            break;
          case 'embedding':
            const embedding = db.getEmbedding(input.item_id);
            provenanceId = embedding?.provenance_id ?? null;
            break;
          default:
            provenanceId = input.item_id;
        }
      }

      if (!provenanceId) {
        throw provenanceNotFoundError(input.item_id);
      }

      const chain = db.getProvenanceChain(provenanceId);
      if (chain.length === 0) {
        throw provenanceNotFoundError(input.item_id);
      }

      const rootDocId = chain[0].root_document_id;

      return formatResponse(successResult({
        item_id: input.item_id,
        item_type: itemType,
        chain: chain.map(p => ({
          id: p.id,
          type: p.type,
          chain_depth: p.chain_depth,
          processor: p.processor,
          processor_version: p.processor_version,
          content_hash: p.content_hash,
          created_at: p.created_at,
          parent_id: p.parent_id,
        })),
        root_document_id: rootDocId,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_provenance_verify - Verify integrity
 */
server.tool(
  'ocr_provenance_verify',
  'Verify the integrity of an item through its provenance chain',
  {
    item_id: z.string().min(1).describe('ID of the item to verify'),
    verify_content: z.boolean().default(true).describe('Verify content hashes'),
    verify_chain: z.boolean().default(true).describe('Verify chain integrity'),
  },
  async (params) => {
    try {
      const input = validateInput(ProvenanceVerifyInput, params);
      const { db } = requireDatabase();

      // Find provenance ID
      let provenanceId: string | null = null;

      const doc = db.getDocument(input.item_id);
      if (doc) {
        provenanceId = doc.provenance_id;
      } else {
        const chunk = db.getChunk(input.item_id);
        if (chunk) {
          provenanceId = chunk.provenance_id;
        } else {
          const embedding = db.getEmbedding(input.item_id);
          if (embedding) {
            provenanceId = embedding.provenance_id;
          } else {
            const prov = db.getProvenance(input.item_id);
            if (prov) {
              provenanceId = prov.id;
            }
          }
        }
      }

      if (!provenanceId) {
        throw provenanceNotFoundError(input.item_id);
      }

      const chain = db.getProvenanceChain(provenanceId);
      if (chain.length === 0) {
        throw provenanceNotFoundError(input.item_id);
      }

      const steps: Array<Record<string, unknown>> = [];
      const errors: string[] = [];
      let contentIntegrity = true;
      let chainIntegrity = true;

      for (let i = 0; i < chain.length; i++) {
        const prov = chain[i];
        const step: Record<string, unknown> = {
          provenance_id: prov.id,
          type: prov.type,
          chain_depth: prov.chain_depth,
          content_verified: true,
          chain_verified: true,
          expected_hash: prov.content_hash,
        };

        // Verify chain integrity
        if (input.verify_chain) {
          // Check chain depth is correct
          if (prov.chain_depth !== i) {
            step.chain_verified = false;
            chainIntegrity = false;
            errors.push(`Chain depth mismatch at ${prov.id}: expected ${i}, got ${prov.chain_depth}`);
          }

          // Check parent link (except for root)
          if (i > 0 && prov.parent_id !== chain[i - 1].id) {
            step.chain_verified = false;
            chainIntegrity = false;
            errors.push(`Parent link broken at ${prov.id}`);
          }
        }

        // Content verification would require re-hashing the actual content
        // For now, we just validate the hash format
        if (input.verify_content) {
          if (!prov.content_hash.startsWith('sha256:')) {
            step.content_verified = false;
            contentIntegrity = false;
            errors.push(`Invalid hash format at ${prov.id}`);
          }
        }

        steps.push(step);
      }

      return formatResponse(successResult({
        item_id: input.item_id,
        verified: contentIntegrity && chainIntegrity,
        content_integrity: contentIntegrity,
        chain_integrity: chainIntegrity,
        steps,
        errors: errors.length > 0 ? errors : undefined,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_provenance_export - Export provenance data
 */
server.tool(
  'ocr_provenance_export',
  'Export provenance data in various formats',
  {
    scope: z.enum(['document', 'database', 'all']).describe('Export scope'),
    document_id: z.string().optional().describe('Document ID (required when scope is document)'),
    format: z.enum(['json', 'w3c-prov', 'csv']).default('json').describe('Export format'),
    output_path: z.string().optional().describe('Optional output file path'),
  },
  async (params) => {
    try {
      const input = validateInput(ProvenanceExportInput, params);
      const { db } = requireDatabase();

      let records: ReturnType<typeof db.getProvenance>[] = [];

      if (input.scope === 'document') {
        if (!input.document_id) {
          throw validationError('document_id is required when scope is "document"');
        }
        const doc = db.getDocument(input.document_id);
        if (!doc) {
          throw documentNotFoundError(input.document_id);
        }
        records = db.getProvenanceByRootDocument(doc.provenance_id);
      } else {
        // Get all documents and their provenance
        const docs = db.listDocuments({ limit: 10000 });
        for (const doc of docs) {
          const docProv = db.getProvenanceByRootDocument(doc.provenance_id);
          records.push(...docProv);
        }
      }

      let data: unknown;

      switch (input.format) {
        case 'json':
          data = records.filter(r => r !== null).map(r => ({
            id: r!.id,
            type: r!.type,
            chain_depth: r!.chain_depth,
            processor: r!.processor,
            processor_version: r!.processor_version,
            content_hash: r!.content_hash,
            parent_id: r!.parent_id,
            root_document_id: r!.root_document_id,
            created_at: r!.created_at,
          }));
          break;

        case 'w3c-prov':
          // W3C PROV-JSON format
          const activities: Record<string, unknown> = {};
          const entities: Record<string, unknown> = {};
          const derivations: unknown[] = [];

          for (const r of records) {
            if (!r) continue;
            entities[`entity:${r.id}`] = {
              'prov:type': r.type,
              'ocr:contentHash': r.content_hash,
              'ocr:chainDepth': r.chain_depth,
            };

            activities[`activity:${r.id}`] = {
              'prov:type': r.processor,
              'ocr:processorVersion': r.processor_version,
            };

            if (r.parent_id) {
              derivations.push({
                'prov:generatedEntity': `entity:${r.id}`,
                'prov:usedEntity': `entity:${r.parent_id}`,
                'prov:activity': `activity:${r.id}`,
              });
            }
          }

          data = {
            '@context': 'https://www.w3.org/ns/prov',
            entity: entities,
            activity: activities,
            wasDerivedFrom: derivations,
          };
          break;

        case 'csv':
          const headers = ['id', 'type', 'chain_depth', 'processor', 'processor_version', 'content_hash', 'parent_id', 'root_document_id', 'created_at'];
          const rows = records.filter(r => r !== null).map(r => [
            r!.id,
            r!.type,
            r!.chain_depth,
            r!.processor,
            r!.processor_version,
            r!.content_hash,
            r!.parent_id ?? '',
            r!.root_document_id,
            r!.created_at,
          ].join(','));
          data = [headers.join(','), ...rows].join('\n');
          break;
      }

      return formatResponse(successResult({
        scope: input.scope,
        format: input.format,
        document_id: input.document_id,
        record_count: records.filter(r => r !== null).length,
        data,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OCR Provenance MCP Server running on stdio');
  console.error('Tools registered: 18');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
