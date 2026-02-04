/**
 * Search MCP Tools
 *
 * Extracted from src/index.ts Task 21.
 * Tools: ocr_search_semantic, ocr_search_text, ocr_search_hybrid
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/search
 */

import { z } from 'zod';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  SearchSemanticInput,
  SearchTextInput,
  SearchHybridInput,
} from '../utils/validation.js';
import { MCPError, formatErrorResponse, validationError } from '../server/errors.js';
import type { Document } from '../models/document.js';
import type { Chunk } from '../models/chunk.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** MCP tool response format */
type ToolResponse = { content: Array<{ type: 'text'; text: string }> };

/** Tool handler function signature */
type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResponse>;

/** Tool definition with description, schema, and handler */
interface ToolDefinition {
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

/** Chunk match for hybrid search */
interface ChunkMatch {
  chunk: Pick<Chunk, 'id' | 'document_id' | 'text' | 'chunk_index' | 'page_number' | 'character_start' | 'character_end' | 'provenance_id'>;
  doc: Pick<Document, 'id' | 'file_name' | 'file_path'>;
}

/** Combined search score result */
interface CombinedScore {
  score: number;
  semantic_score: number;
  keyword_score: number;
  chunk_id: string;
  document_id: string;
  original_text: string;
  source_file_name: string;
  source_file_path: string;
  page_number: number | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  provenance_id: string;
}

/** Provenance record summary for search results */
interface ProvenanceSummary {
  id: string;
  type: string;
  chain_depth: number;
  processor: string;
  content_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function formatResponse(result: unknown): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

function handleError(error: unknown): ToolResponse {
  const mcpError = MCPError.fromUnknown(error);
  console.error(`[ERROR] ${mcpError.category}: ${mcpError.message}`);
  return formatResponse(formatErrorResponse(mcpError));
}

/**
 * Format provenance chain as summary array
 */
function formatProvenanceChain(db: ReturnType<typeof requireDatabase>['db'], provenanceId: string): ProvenanceSummary[] {
  const chain = db.getProvenanceChain(provenanceId);
  return chain.map(p => ({
    id: p.id,
    type: p.type,
    chain_depth: p.chain_depth,
    processor: p.processor,
    content_hash: p.content_hash,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_search_semantic - Semantic vector search
 */
export async function handleSearchSemantic(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchSemanticInput, params);
    const { db, vector } = requireDatabase();

    // Generate query embedding
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(input.query);

    // Search for similar vectors
    const results = vector.searchSimilar(queryVector, {
      limit: input.limit,
      threshold: input.similarity_threshold,
      documentFilter: input.document_filter,
    });

    // Format results with optional provenance
    const formattedResults = results.map(r => {
      const result: Record<string, unknown> = {
        embedding_id: r.embedding_id,
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        similarity_score: r.similarity_score,
        original_text: r.original_text,
        source_file_path: r.source_file_path,
        source_file_name: r.source_file_name,
        page_number: r.page_number,
        character_start: r.character_start,
        character_end: r.character_end,
        chunk_index: r.chunk_index,
        total_chunks: r.total_chunks,
      };

      if (input.include_provenance) {
        result.provenance = formatProvenanceChain(db, r.provenance_id);
      }

      return result;
    });

    return formatResponse(successResult({
      query: input.query,
      results: formattedResults,
      total: formattedResults.length,
      threshold: input.similarity_threshold,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_search_text - Keyword/text search
 */
export async function handleSearchText(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchTextInput, params);
    const { db } = requireDatabase();

    // Extract with defaults (Zod provides these, but TypeScript needs explicit handling)
    const limit = input.limit ?? 10;
    const matchType = input.match_type ?? 'fuzzy';

    // Get all chunks and search by text
    const allDocs = db.listDocuments({ status: 'complete', limit: 1000 });
    const results: Array<Record<string, unknown>> = [];

    // Validate regex pattern early to fail fast
    if (matchType === 'regex') {
      try {
        new RegExp(input.query, 'i');
      } catch {
        throw validationError(`Invalid regex pattern: ${input.query}`);
      }
    }

    for (const doc of allDocs) {
      if (results.length >= limit) break;

      const chunks = db.getChunksByDocumentId(doc.id);
      for (const chunk of chunks) {
        if (results.length >= limit) break;

        const matches = matchText(chunk.text, input.query, matchType);
        if (!matches) continue;

        const result: Record<string, unknown> = {
          chunk_id: chunk.id,
          document_id: chunk.document_id,
          original_text: chunk.text,
          source_file_name: doc.file_name,
          source_file_path: doc.file_path,
          page_number: chunk.page_number,
          character_start: chunk.character_start,
          character_end: chunk.character_end,
          chunk_index: chunk.chunk_index,
        };

        if (input.include_provenance) {
          result.provenance = formatProvenanceChain(db, chunk.provenance_id);
        }

        results.push(result);
      }
    }

    return formatResponse(successResult({
      query: input.query,
      match_type: matchType,
      results,
      total: results.length,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Match text against query using specified match type
 */
function matchText(text: string, query: string, matchType: 'exact' | 'fuzzy' | 'regex'): boolean {
  switch (matchType) {
    case 'exact':
      return text.includes(query);
    case 'fuzzy':
      return text.toLowerCase().includes(query.toLowerCase());
    case 'regex':
      return new RegExp(query, 'i').test(text);
  }
}

/**
 * Handle ocr_search_hybrid - Combined semantic + keyword search
 */
export async function handleSearchHybrid(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(SearchHybridInput, params);
    const { db, vector } = requireDatabase();

    // Extract with defaults (Zod provides these, but TypeScript needs explicit handling)
    const limit = input.limit ?? 10;
    const semanticWeight = input.semantic_weight ?? 0.7;
    const keywordWeight = input.keyword_weight ?? 0.3;

    // Get semantic results
    const embedder = getEmbeddingService();
    const queryVector = await embedder.embedSearchQuery(input.query);
    const semanticResults = vector.searchSimilar(queryVector, { limit: limit * 2 });

    // Get text results
    const allDocs = db.listDocuments({ status: 'complete', limit: 1000 });
    const textMatches: Map<string, ChunkMatch> = new Map();

    for (const doc of allDocs) {
      const chunks = db.getChunksByDocumentId(doc.id);
      for (const chunk of chunks) {
        if (chunk.text.toLowerCase().includes(input.query.toLowerCase())) {
          textMatches.set(chunk.id, {
            chunk: {
              id: chunk.id,
              document_id: chunk.document_id,
              text: chunk.text,
              chunk_index: chunk.chunk_index,
              page_number: chunk.page_number,
              character_start: chunk.character_start,
              character_end: chunk.character_end,
              provenance_id: chunk.provenance_id,
            },
            doc: { id: doc.id, file_name: doc.file_name, file_path: doc.file_path },
          });
        }
      }
    }

    // Combine and score results
    const combinedScores: Map<string, CombinedScore> = new Map();

    for (const r of semanticResults) {
      const hasKeywordMatch = textMatches.has(r.chunk_id);
      const semanticScoreVal = r.similarity_score * semanticWeight;
      const keywordScoreVal = hasKeywordMatch ? keywordWeight : 0;

      combinedScores.set(r.chunk_id, {
        score: semanticScoreVal + keywordScoreVal,
        semantic_score: r.similarity_score,
        keyword_score: hasKeywordMatch ? 1 : 0,
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        original_text: r.original_text,
        source_file_name: r.source_file_name,
        source_file_path: r.source_file_path,
        page_number: r.page_number,
        character_start: r.character_start,
        character_end: r.character_end,
        chunk_index: r.chunk_index,
        provenance_id: r.provenance_id,
      });
    }

    // Add text-only matches (not found in semantic results)
    for (const [chunkId, { chunk, doc }] of textMatches) {
      if (!combinedScores.has(chunkId)) {
        combinedScores.set(chunkId, {
          score: keywordWeight,
          semantic_score: 0,
          keyword_score: 1,
          chunk_id: chunk.id,
          document_id: chunk.document_id,
          original_text: chunk.text,
          source_file_name: doc.file_name,
          source_file_path: doc.file_path,
          page_number: chunk.page_number,
          character_start: chunk.character_start,
          character_end: chunk.character_end,
          chunk_index: chunk.chunk_index,
          provenance_id: chunk.provenance_id,
        });
      }
    }

    // Sort by combined score and limit
    const sortedResults = Array.from(combinedScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const formattedResults = sortedResults.map(r => {
      const result: Record<string, unknown> = {
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        original_text: r.original_text,
        source_file_name: r.source_file_name,
        source_file_path: r.source_file_path,
        page_number: r.page_number,
        character_start: r.character_start,
        character_end: r.character_end,
        chunk_index: r.chunk_index,
        combined_score: r.score,
        semantic_score: r.semantic_score,
        keyword_score: r.keyword_score,
      };

      if (input.include_provenance) {
        result.provenance = formatProvenanceChain(db, r.provenance_id);
      }

      return result;
    });

    return formatResponse(successResult({
      query: input.query,
      semantic_weight: semanticWeight,
      keyword_weight: keywordWeight,
      results: formattedResults,
      total: formattedResults.length,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Search tools collection for MCP server registration
 */
export const searchTools: Record<string, ToolDefinition> = {
  ocr_search_semantic: {
    description: 'Search documents using semantic similarity (vector search)',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
      similarity_threshold: z.number().min(0).max(1).default(0.7).describe('Minimum similarity score (0-1)'),
      include_provenance: z.boolean().default(false).describe('Include provenance chain in results'),
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
    },
    handler: handleSearchSemantic,
  },
  ocr_search_text: {
    description: 'Search documents using keyword/text matching',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      match_type: z.enum(['exact', 'fuzzy', 'regex']).default('fuzzy').describe('Match type'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
      include_provenance: z.boolean().default(false).describe('Include provenance chain in results'),
    },
    handler: handleSearchText,
  },
  ocr_search_hybrid: {
    description: 'Search using combined semantic and keyword matching',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query'),
      semantic_weight: z.number().min(0).max(1).default(0.7).describe('Weight for semantic results (0-1)'),
      keyword_weight: z.number().min(0).max(1).default(0.3).describe('Weight for keyword results (0-1)'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
      include_provenance: z.boolean().default(false).describe('Include provenance chain in results'),
    },
    handler: handleSearchHybrid,
  },
};

export default searchTools;
