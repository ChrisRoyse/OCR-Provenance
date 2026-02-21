/**
 * Chunk-Level MCP Tools
 *
 * Tools for inspecting individual chunks, browsing document structure
 * at chunk granularity, and building context windows from neighboring chunks.
 *
 * Tools: ocr_chunk_get, ocr_chunk_list, ocr_chunk_context
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/chunks
 */

import { z } from 'zod';
import { formatResponse, handleError, fetchProvenanceChain, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import { basename } from 'path';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const ChunkGetInput = z.object({
  chunk_id: z.string().min(1).describe('Chunk ID'),
  include_provenance: z.boolean().default(false).describe('Include full provenance chain'),
  include_embedding_info: z.boolean().default(false).describe('Include embedding metadata'),
});

const ChunkListInput = z.object({
  document_id: z.string().min(1).describe('Document ID'),
  section_path_filter: z.string().optional()
    .describe('Filter by section path prefix (LIKE match)'),
  heading_filter: z.string().optional()
    .describe('Filter by heading context (LIKE match)'),
  content_type_filter: z.array(z.string()).optional()
    .describe('Filter chunks containing these content types'),
  min_quality_score: z.number().min(0).max(5).optional()
    .describe('Minimum OCR quality score (0-5)'),
  embedding_status: z.enum(['pending', 'complete', 'failed']).optional()
    .describe('Filter by embedding status'),
  is_atomic: z.boolean().optional()
    .describe('Filter atomic chunks only'),
  page_range: z.object({
    min_page: z.number().int().min(1).optional(),
    max_page: z.number().int().min(1).optional(),
  }).optional().describe('Filter results to specific page range'),
  limit: z.number().int().min(1).max(1000).default(50)
    .describe('Maximum results'),
  offset: z.number().int().min(0).default(0)
    .describe('Offset for pagination'),
  include_text: z.boolean().default(false)
    .describe('Include full chunk text'),
});

const ChunkContextInput = z.object({
  chunk_id: z.string().min(1).describe('Center chunk ID'),
  neighbors: z.number().int().min(0).max(20).default(2)
    .describe('Number of chunks before and after'),
  include_provenance: z.boolean().default(false)
    .describe('Include provenance for each chunk'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHUNK TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_chunk_get - Get detailed information about a specific chunk
 */
async function handleChunkGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ChunkGetInput, params);
    const { db } = requireDatabase();

    const chunk = db.getChunk(input.chunk_id);
    if (!chunk) {
      throw new Error(`Chunk not found: ${input.chunk_id}`);
    }

    // Get document for file_path context
    const doc = db.getDocument(chunk.document_id);

    const result: Record<string, unknown> = {
      id: chunk.id,
      document_id: chunk.document_id,
      document_file_path: doc?.file_path ?? null,
      document_file_name: doc ? basename(doc.file_path) : null,
      ocr_result_id: chunk.ocr_result_id,
      text: chunk.text,
      text_length: chunk.text.length,
      text_hash: chunk.text_hash,
      chunk_index: chunk.chunk_index,
      character_start: chunk.character_start,
      character_end: chunk.character_end,
      page_number: chunk.page_number,
      page_range: chunk.page_range,
      overlap_previous: chunk.overlap_previous,
      overlap_next: chunk.overlap_next,
      heading_context: chunk.heading_context ?? null,
      heading_level: chunk.heading_level ?? null,
      section_path: chunk.section_path ?? null,
      content_types: chunk.content_types ?? null,
      is_atomic: chunk.is_atomic,
      ocr_quality_score: chunk.ocr_quality_score ?? null,
      embedding_status: chunk.embedding_status,
      embedded_at: chunk.embedded_at,
      provenance_id: chunk.provenance_id,
      created_at: chunk.created_at,
      chunking_strategy: chunk.chunking_strategy,
    };

    // Optionally include embedding info
    if (input.include_embedding_info) {
      const embedding = db.getEmbeddingByChunkId(chunk.id);
      result.embedding_info = embedding
        ? {
            embedding_id: embedding.id,
            model_name: embedding.model_name,
            model_version: embedding.model_version,
            inference_mode: embedding.inference_mode,
            gpu_device: embedding.gpu_device,
            generation_duration_ms: embedding.generation_duration_ms,
            content_hash: embedding.content_hash,
            created_at: embedding.created_at,
          }
        : null;
    }

    // Optionally include provenance chain
    if (input.include_provenance) {
      result.provenance_chain = fetchProvenanceChain(db, chunk.provenance_id, '[ChunkGet]');
    }

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_chunk_list - List chunks for a document with filtering
 */
async function handleChunkList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ChunkListInput, params);
    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    const { chunks, total } = db.getChunksFiltered(input.document_id, {
      section_path_filter: input.section_path_filter,
      heading_filter: input.heading_filter,
      content_type_filter: input.content_type_filter,
      min_quality_score: input.min_quality_score,
      embedding_status: input.embedding_status,
      is_atomic: input.is_atomic,
      page_range: input.page_range,
      limit: input.limit,
      offset: input.offset,
      include_text: input.include_text,
    });

    const chunkData = chunks.map((c) => {
      const entry: Record<string, unknown> = {
        id: c.id,
        chunk_index: c.chunk_index,
        text_length: c.text.length,
        page_number: c.page_number,
        page_range: c.page_range,
        character_start: c.character_start,
        character_end: c.character_end,
        heading_context: c.heading_context ?? null,
        heading_level: c.heading_level ?? null,
        section_path: c.section_path ?? null,
        content_types: c.content_types ?? null,
        is_atomic: c.is_atomic,
        ocr_quality_score: c.ocr_quality_score ?? null,
        embedding_status: c.embedding_status,
        chunking_strategy: c.chunking_strategy,
      };

      if (input.include_text) {
        entry.text = c.text;
      }

      return entry;
    });

    return formatResponse(
      successResult({
        document_id: input.document_id,
        chunks: chunkData,
        total,
        limit: input.limit,
        offset: input.offset,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_chunk_context - Get a chunk with its neighboring chunks for context
 */
async function handleChunkContext(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ChunkContextInput, params);
    const { db } = requireDatabase();

    // Get the center chunk
    const centerChunk = db.getChunk(input.chunk_id);
    if (!centerChunk) {
      throw new Error(`Chunk not found: ${input.chunk_id}`);
    }

    // Get document for file_path context
    const doc = db.getDocument(centerChunk.document_id);

    // Get neighbors (including center chunk)
    const neighborCount = input.neighbors ?? 2;
    const allChunks = db.getChunkNeighbors(
      centerChunk.document_id,
      centerChunk.chunk_index,
      neighborCount
    );

    // Split into before, center, and after
    const before = allChunks.filter((c) => c.chunk_index < centerChunk.chunk_index);
    const after = allChunks.filter((c) => c.chunk_index > centerChunk.chunk_index);

    // Build combined text
    const combinedText = allChunks.map((c) => c.text).join('\n\n');

    // Compute combined page range
    const allPages = allChunks
      .map((c) => c.page_number)
      .filter((p): p is number => p !== null);
    const minPage = allPages.length > 0 ? Math.min(...allPages) : null;
    const maxPage = allPages.length > 0 ? Math.max(...allPages) : null;
    const combinedPageRange =
      minPage !== null && maxPage !== null
        ? minPage === maxPage
          ? String(minPage)
          : `${minPage}-${maxPage}`
        : null;

    // Format chunk data
    const formatChunk = (c: typeof centerChunk) => {
      const entry: Record<string, unknown> = {
        id: c.id,
        chunk_index: c.chunk_index,
        text: c.text,
        text_length: c.text.length,
        page_number: c.page_number,
        heading_context: c.heading_context ?? null,
        section_path: c.section_path ?? null,
        content_types: c.content_types ?? null,
      };

      if (input.include_provenance) {
        entry.provenance_chain = fetchProvenanceChain(db, c.provenance_id, '[ChunkContext]');
      }

      return entry;
    };

    return formatResponse(
      successResult({
        document_id: centerChunk.document_id,
        document_file_path: doc?.file_path ?? null,
        center_chunk: formatChunk(centerChunk),
        before: before.map(formatChunk),
        after: after.map(formatChunk),
        combined_text: combinedText,
        combined_text_length: combinedText.length,
        combined_page_range: combinedPageRange,
        total_chunks: allChunks.length,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chunk tools collection for MCP server registration
 */
export const chunkTools: Record<string, ToolDefinition> = {
  ocr_chunk_get: {
    description:
      'Get detailed information about a specific chunk including text, metadata, section context, and provenance chain.',
    inputSchema: ChunkGetInput.shape,
    handler: handleChunkGet,
  },
  ocr_chunk_list: {
    description:
      'List chunks for a document with filtering by section, heading, content type, quality, and embedding status.',
    inputSchema: ChunkListInput.shape,
    handler: handleChunkList,
  },
  ocr_chunk_context: {
    description:
      'Expand a search result with neighboring chunks. Use after search to get surrounding text for a specific chunk_id with configurable context_size (number of neighbors).',
    inputSchema: ChunkContextInput.shape,
    handler: handleChunkContext,
  },
};
