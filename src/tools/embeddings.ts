/**
 * Embedding Management Tools
 *
 * MCP tools for listing, inspecting, and rebuilding embeddings.
 * Provides visibility into embedding state, source context, and provenance.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/embeddings
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  formatResponse,
  handleError,
  fetchProvenanceChain,
  type ToolResponse,
  type ToolDefinition,
} from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import { getImage } from '../services/storage/database/image-operations.js';
import { getEmbeddingService, EmbeddingService } from '../services/embedding/embedder.js';
import { getEmbeddingClient } from '../services/embedding/nomic.js';
import { computeHash } from '../utils/hash.js';
import { ProvenanceType as ProvType } from '../models/provenance.js';
import type {
  ProvenanceRecord,
  ProvenanceType,
  SourceType,
  ProvenanceLocation,
} from '../models/provenance.js';
import { EMBEDDING_MODEL } from '../models/embedding.js';
import { documentNotFoundError } from '../server/errors.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: determine source type from FK fields
// ═══════════════════════════════════════════════════════════════════════════════

function determineSourceType(
  chunkId: string | null,
  imageId: string | null,
  extractionId: string | null
): 'chunk' | 'image' | 'extraction' | 'unknown' {
  if (chunkId && !imageId && !extractionId) return 'chunk';
  if (imageId) return 'image';
  if (extractionId) return 'extraction';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 4.1: ocr_embedding_list
// ═══════════════════════════════════════════════════════════════════════════════

const EmbeddingListInput = z.object({
  document_id: z.string().min(1).optional(),
  source_type: z.enum(['chunk', 'image', 'extraction']).optional(),
  model_name: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

async function handleEmbeddingList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(EmbeddingListInput, params);
    const { db } = requireDatabase();

    const result = db.getEmbeddingsFiltered({
      document_id: input.document_id,
      source_type: input.source_type,
      model_name: input.model_name,
      limit: input.limit,
      offset: input.offset,
    });

    const enriched = result.embeddings.map((emb) => {
      const sourceType = determineSourceType(emb.chunk_id, emb.image_id, emb.extraction_id);

      const entry: Record<string, unknown> = {
        id: emb.id,
        document_id: emb.document_id,
        source_type: sourceType,
        chunk_id: emb.chunk_id,
        image_id: emb.image_id,
        extraction_id: emb.extraction_id,
        model_name: emb.model_name,
        model_version: emb.model_version,
        original_text_length: emb.original_text_length,
        original_text_preview: emb.original_text.slice(0, 200),
        page_number: emb.page_number,
        page_range: emb.page_range,
        gpu_device: emb.gpu_device,
        generation_duration_ms: emb.generation_duration_ms,
        provenance_id: emb.provenance_id,
        created_at: emb.created_at,
      };

      // Enrich with source context
      if (sourceType === 'chunk' && emb.chunk_id) {
        const chunk = db.getChunk(emb.chunk_id);
        if (chunk) {
          entry.chunk_heading_context = chunk.heading_context;
          entry.chunk_section_path = chunk.section_path;
          entry.chunk_index = chunk.chunk_index;
        }
      } else if (sourceType === 'image' && emb.image_id) {
        const conn = db.getConnection();
        const img = getImage(conn, emb.image_id);
        if (img) {
          entry.image_extracted_path = img.extracted_path;
          entry.image_page_number = img.page_number;
          entry.image_block_type = img.block_type;
        }
      } else if (sourceType === 'extraction' && emb.extraction_id) {
        const extraction = db.getExtraction(emb.extraction_id);
        if (extraction) {
          entry.extraction_schema = extraction.schema_json;
        }
      }

      return entry;
    });

    return formatResponse(
      successResult({
        embeddings: enriched,
        total: result.total,
        limit: input.limit,
        offset: input.offset,
        filters_applied: {
          document_id: input.document_id ?? null,
          source_type: input.source_type ?? null,
          model_name: input.model_name ?? null,
        },
        next_steps: [
          { tool: 'ocr_embedding_get', description: 'Inspect a specific embedding' },
          { tool: 'ocr_embedding_stats', description: 'Check overall embedding coverage' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 4.2: ocr_embedding_stats
// ═══════════════════════════════════════════════════════════════════════════════

const EmbeddingStatsInput = z.object({
  document_id: z.string().min(1).optional(),
});

async function handleEmbeddingStats(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(EmbeddingStatsInput, params);
    const { db } = requireDatabase();

    const stats = db.getEmbeddingStats(input.document_id);

    return formatResponse(
      successResult({
        document_id: input.document_id ?? null,
        ...stats,
        next_steps:
          stats.total_embeddings === 0
            ? [
                {
                  tool: 'ocr_process_pending',
                  description: 'Run processing to generate embeddings',
                },
                { tool: 'ocr_document_list', description: 'Check if documents exist to process' },
              ]
            : [
                {
                  tool: 'ocr_embedding_rebuild',
                  description: 'Rebuild embeddings for items with gaps',
                },
                { tool: 'ocr_embedding_list', description: 'Browse individual embeddings' },
              ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 4.3: ocr_embedding_get
// ═══════════════════════════════════════════════════════════════════════════════

const EmbeddingGetInput = z.object({
  embedding_id: z.string().min(1),
  include_provenance: z.boolean().default(false),
});

async function handleEmbeddingGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(EmbeddingGetInput, params);
    const { db } = requireDatabase();

    const embedding = db.getEmbedding(input.embedding_id);
    if (!embedding) {
      throw new Error(`Embedding not found: ${input.embedding_id}`);
    }

    const sourceType = determineSourceType(
      embedding.chunk_id,
      embedding.image_id,
      embedding.extraction_id
    );

    const result: Record<string, unknown> = {
      id: embedding.id,
      document_id: embedding.document_id,
      source_type: sourceType,
      chunk_id: embedding.chunk_id,
      image_id: embedding.image_id,
      extraction_id: embedding.extraction_id,
      original_text: embedding.original_text,
      original_text_length: embedding.original_text_length,
      source_file_path: embedding.source_file_path,
      source_file_name: embedding.source_file_name,
      source_file_hash: embedding.source_file_hash,
      page_number: embedding.page_number,
      page_range: embedding.page_range,
      character_start: embedding.character_start,
      character_end: embedding.character_end,
      chunk_index: embedding.chunk_index,
      total_chunks: embedding.total_chunks,
      model_name: embedding.model_name,
      model_version: embedding.model_version,
      task_type: embedding.task_type,
      inference_mode: embedding.inference_mode,
      gpu_device: embedding.gpu_device,
      content_hash: embedding.content_hash,
      generation_duration_ms: embedding.generation_duration_ms,
      provenance_id: embedding.provenance_id,
      created_at: embedding.created_at,
    };

    // Enrich with source context
    if (sourceType === 'chunk' && embedding.chunk_id) {
      const chunk = db.getChunk(embedding.chunk_id);
      if (chunk) {
        result.source_context = {
          type: 'chunk',
          chunk_index: chunk.chunk_index,
          heading_context: chunk.heading_context,
          section_path: chunk.section_path,
          content_types: chunk.content_types,
          embedding_status: chunk.embedding_status,
          page_number: chunk.page_number,
        };
      }
    } else if (sourceType === 'image' && embedding.image_id) {
      const conn = db.getConnection();
      const img = getImage(conn, embedding.image_id);
      if (img) {
        result.source_context = {
          type: 'image',
          extracted_path: img.extracted_path,
          page_number: img.page_number,
          block_type: img.block_type,
          format: img.format,
          dimensions: img.dimensions,
          vlm_status: img.vlm_status,
          vlm_confidence: img.vlm_confidence,
        };
      }
    } else if (sourceType === 'extraction' && embedding.extraction_id) {
      const extraction = db.getExtraction(embedding.extraction_id);
      if (extraction) {
        result.source_context = {
          type: 'extraction',
          schema_json: extraction.schema_json,
          content_hash: extraction.content_hash,
          created_at: extraction.created_at,
        };
      }
    }

    // Document context
    const doc = db.getDocument(embedding.document_id);
    if (doc) {
      result.document_context = {
        file_path: doc.file_path,
        file_name: doc.file_name,
        file_type: doc.file_type,
        status: doc.status,
      };
    }

    // Provenance chain
    if (input.include_provenance) {
      result.provenance_chain = fetchProvenanceChain(
        db,
        embedding.provenance_id,
        '[embedding_get]'
      );
    }

    result.next_steps = [
      { tool: 'ocr_chunk_context', description: 'View the source chunk with surrounding text' },
      { tool: 'ocr_embedding_rebuild', description: 'Regenerate this embedding' },
    ];

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 4.4: ocr_embedding_rebuild
// ═══════════════════════════════════════════════════════════════════════════════

const EmbeddingRebuildInput = z.object({
  document_id: z.string().min(1).optional(),
  chunk_id: z.string().min(1).optional(),
  image_id: z.string().min(1).optional(),
  include_vlm: z.boolean().default(false).optional(),
});

async function handleEmbeddingRebuild(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(EmbeddingRebuildInput, params);
    const { db, vector } = requireDatabase();

    // Validate exactly one target specified
    const targets = [input.document_id, input.chunk_id, input.image_id].filter(Boolean);
    if (targets.length === 0) {
      throw new Error('Exactly one of document_id, chunk_id, or image_id must be provided');
    }
    if (targets.length > 1) {
      throw new Error(
        'Exactly one of document_id, chunk_id, or image_id must be provided, got multiple'
      );
    }

    const embeddingService = getEmbeddingService();
    const rebuiltIds: string[] = [];
    const provenanceIds: string[] = [];
    let vlmEmbedFailures = 0;

    if (input.chunk_id) {
      // Rebuild embedding for a single chunk
      const chunk = db.getChunk(input.chunk_id);
      if (!chunk) {
        throw new Error(`Chunk not found: ${input.chunk_id}`);
      }

      const doc = db.getDocument(chunk.document_id);
      if (!doc) {
        throw new Error(`Document not found for chunk: ${chunk.document_id}`);
      }

      // Delete old embedding, its provenance, and vector for this chunk
      const oldEmbedding = db.getEmbeddingByChunkId(input.chunk_id);
      if (oldEmbedding) {
        const oldProvId = oldEmbedding.provenance_id;
        vector.deleteVector(oldEmbedding.id);
        db.deleteEmbeddingsByChunkId(input.chunk_id);
        // Delete orphaned provenance record AFTER removing the FK reference
        if (oldProvId) {
          const conn = db.getConnection();
          conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldProvId);
        }
      }

      // Reset chunk embedding status
      db.updateChunkEmbeddingStatus(input.chunk_id, 'pending');

      // Regenerate embedding
      const result = await embeddingService.embedDocumentChunks(db, vector, [chunk], {
        documentId: chunk.document_id,
        filePath: doc.file_path,
        fileName: doc.file_name,
        fileHash: doc.file_hash,
        documentProvenanceId: doc.provenance_id,
      });

      rebuiltIds.push(...result.embeddingIds);
      provenanceIds.push(...result.provenanceIds);
    } else if (input.image_id) {
      // Rebuild VLM embedding for a single image
      const conn = db.getConnection();
      const img = getImage(conn, input.image_id);
      if (!img) {
        throw new Error(`Image not found: ${input.image_id}`);
      }

      if (!img.vlm_description) {
        throw new Error(`Image ${input.image_id} has no VLM description to embed`);
      }

      const doc = db.getDocument(img.document_id);
      if (!doc) {
        throw new Error(`Document not found for image: ${img.document_id}`);
      }

      // Delete old VLM embedding and its provenance
      if (img.vlm_embedding_id) {
        // Capture provenance ID before deleting the embedding
        const oldVlmEmb = conn.prepare('SELECT provenance_id FROM embeddings WHERE id = ?').get(img.vlm_embedding_id) as { provenance_id: string | null } | undefined;
        const oldVlmProvId = oldVlmEmb?.provenance_id ?? null;
        vector.deleteVector(img.vlm_embedding_id);
        db.deleteEmbeddingsByImageId(input.image_id);
        // Clear vlm_embedding_id on image
        conn.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?').run(input.image_id);
        // Delete orphaned provenance record AFTER removing the FK reference
        if (oldVlmProvId) {
          conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldVlmProvId);
        }
      }

      // Generate new embedding for VLM description
      const embeddingId = uuidv4();
      const provenanceId = uuidv4();
      const now = new Date().toISOString();

      // Create provenance
      const provRecord: ProvenanceRecord = {
        id: provenanceId,
        type: 'EMBEDDING' as ProvenanceType,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'EMBEDDING' as SourceType,
        source_path: null,
        source_id: img.provenance_id ?? null,
        root_document_id: doc.provenance_id,
        location: {
          page_number: img.page_number,
          image_index: img.image_index,
        } as ProvenanceLocation,
        content_hash: computeHash(img.vlm_description),
        input_hash: null,
        file_hash: doc.file_hash,
        processor: EMBEDDING_MODEL.name,
        processor_version: EMBEDDING_MODEL.version,
        processing_params: {
          dimensions: EMBEDDING_MODEL.dimensions,
          task_type: 'search_document',
          inference_mode: 'local',
          source: 'vlm_description_rebuild',
        },
        processing_duration_ms: null,
        processing_quality_score: null,
        parent_id: img.provenance_id ?? null,
        parent_ids: img.provenance_id ? JSON.stringify([img.provenance_id]) : '[]',
        chain_depth: 4,
        chain_path: JSON.stringify([
          'DOCUMENT',
          'OCR_RESULT',
          'IMAGE',
          'VLM_DESCRIPTION',
          'EMBEDDING',
        ]),
      };
      db.insertProvenance(provRecord);
      provenanceIds.push(provenanceId);

      // Generate the vector using embedChunks (search_document prefix for storage)
      const embClient = getEmbeddingClient();
      const [embVector] = await embClient.embedChunks([img.vlm_description], 1);

      // Insert embedding record
      db.insertEmbedding({
        id: embeddingId,
        chunk_id: null,
        image_id: input.image_id,
        extraction_id: null,
        document_id: img.document_id,
        original_text: img.vlm_description,
        original_text_length: img.vlm_description.length,
        source_file_path: doc.file_path,
        source_file_name: doc.file_name,
        source_file_hash: doc.file_hash,
        page_number: img.page_number,
        page_range: null,
        character_start: 0,
        character_end: img.vlm_description.length,
        chunk_index: 0,
        total_chunks: 0,
        model_name: EMBEDDING_MODEL.name,
        model_version: EMBEDDING_MODEL.version,
        task_type: 'search_document',
        inference_mode: 'local',
        gpu_device: 'cuda:0',
        provenance_id: provenanceId,
        content_hash: computeHash(img.vlm_description),
        generation_duration_ms: null,
      });

      // Store vector
      vector.storeVector(embeddingId, embVector);

      // Update image record
      conn
        .prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?')
        .run(embeddingId, input.image_id);

      rebuiltIds.push(embeddingId);
    } else if (input.document_id) {
      // Rebuild all chunk embeddings for a document
      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }

      const conn = db.getConnection();
      const chunks = db.getChunksByDocumentId(input.document_id);
      if (chunks.length === 0 && !input.include_vlm) {
        throw new Error(`No chunks found for document: ${input.document_id}`);
      }

      // Delete old embeddings and vectors for all chunks
      if (chunks.length > 0) {
        // Only delete chunk-based embeddings, not image/extraction ones
        const chunkEmbeddings = db
          .getEmbeddingsByDocumentId(input.document_id)
          .filter((e) => e.chunk_id && !e.image_id && !e.extraction_id);

        // Collect provenance IDs before deletion, then delete vectors
        const oldChunkProvIds = chunkEmbeddings.map((e) => e.provenance_id);
        for (const emb of chunkEmbeddings) {
          vector.deleteVector(emb.id);
        }

        // Delete chunk embeddings from embeddings table (removes FK references)
        conn
          .prepare(
            'DELETE FROM embeddings WHERE document_id = ? AND chunk_id IS NOT NULL AND image_id IS NULL AND extraction_id IS NULL'
          )
          .run(input.document_id);

        // Delete orphaned provenance records AFTER removing the FK references
        for (const provId of oldChunkProvIds) {
          conn.prepare('DELETE FROM provenance WHERE id = ?').run(provId);
        }

        // Reset all chunk embedding statuses
        for (const chunk of chunks) {
          db.updateChunkEmbeddingStatus(chunk.id, 'pending');
        }

        // Regenerate embeddings
        const result = await embeddingService.embedDocumentChunks(db, vector, chunks, {
          documentId: input.document_id,
          filePath: doc.file_path,
          fileName: doc.file_name,
          fileHash: doc.file_hash,
          documentProvenanceId: doc.provenance_id,
        });

        rebuiltIds.push(...result.embeddingIds);
        provenanceIds.push(...result.provenanceIds);
      }

      // Rebuild VLM embeddings for images when include_vlm is true
      if (input.include_vlm) {
        const vlmEmbeddingService = new EmbeddingService();
        const vlmImages = conn
          .prepare(
            `SELECT id, vlm_description, vlm_embedding_id, provenance_id, page_number,
                    extracted_path, format
             FROM images
             WHERE document_id = ? AND vlm_status = 'complete'
               AND vlm_description IS NOT NULL AND vlm_description != '[SKIPPED]'`
          )
          .all(input.document_id) as Array<{
          id: string;
          vlm_description: string;
          vlm_embedding_id: string | null;
          provenance_id: string | null;
          page_number: number;
          extracted_path: string | null;
          format: string | null;
        }>;

        for (const img of vlmImages) {
          try {
            // Delete old VLM embedding and its provenance if exists
            if (img.vlm_embedding_id) {
              // Capture provenance ID before deleting the embedding
              const oldVlmEmb = conn.prepare('SELECT provenance_id FROM embeddings WHERE id = ?').get(img.vlm_embedding_id) as { provenance_id: string | null } | undefined;
              const oldVlmProvId = oldVlmEmb?.provenance_id ?? null;
              vector.deleteVector(img.vlm_embedding_id);
              conn.prepare('DELETE FROM embeddings WHERE id = ?').run(img.vlm_embedding_id);
              // Null out the reference on the image
              conn.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?').run(img.id);
              // Delete orphaned provenance record AFTER removing the FK reference
              if (oldVlmProvId) {
                conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldVlmProvId);
              }
            }

            // Generate new embedding for VLM description
            const vlmEmbedResult = await vlmEmbeddingService.embedSearchQuery(img.vlm_description);

            // Create EMBEDDING provenance (depth 4, parent = VLM_DESCRIPTION provenance)
            const embProvId = uuidv4();
            const now = new Date().toISOString();

            // Find VLM description provenance (depth 3) for this image
            const vlmProvRecords = conn
              .prepare(
                `SELECT id, parent_ids FROM provenance
                 WHERE root_document_id = ? AND type = 'VLM_DESCRIPTION'
                   AND source_id = ?
                 ORDER BY created_at DESC LIMIT 1`
              )
              .all(doc.provenance_id, img.provenance_id) as Array<{
              id: string;
              parent_ids: string;
            }>;

            const vlmProvId = vlmProvRecords.length > 0 ? vlmProvRecords[0].id : img.provenance_id;
            const existingParents =
              vlmProvRecords.length > 0
                ? (JSON.parse(vlmProvRecords[0].parent_ids) as string[])
                : [];
            const parentIds = [...existingParents, vlmProvId];

            db.insertProvenance({
              id: embProvId,
              type: ProvType.EMBEDDING,
              created_at: now,
              processed_at: now,
              source_file_created_at: null,
              source_file_modified_at: null,
              source_type: 'EMBEDDING',
              source_path: null,
              source_id: vlmProvId,
              root_document_id: doc.provenance_id,
              location: { page_number: img.page_number },
              content_hash: computeHash(img.vlm_description),
              input_hash: computeHash(img.vlm_description),
              file_hash: doc.file_hash,
              processor: 'nomic-embed-text-v1.5',
              processor_version: '1.5.0',
              processing_params: {
                task_type: 'search_document',
                inference_mode: 'local',
                source: 'vlm_description_reembed',
              },
              processing_duration_ms: null,
              processing_quality_score: null,
              parent_id: vlmProvId,
              parent_ids: JSON.stringify(parentIds),
              chain_depth: 4,
              chain_path: JSON.stringify([
                'DOCUMENT',
                'OCR_RESULT',
                'IMAGE',
                'VLM_DESCRIPTION',
                'EMBEDDING',
              ]),
            });

            // Insert embedding record (matches VLM pipeline pattern)
            const embId = uuidv4();
            db.insertEmbedding({
              id: embId,
              chunk_id: null,
              image_id: img.id,
              extraction_id: null,
              document_id: doc.id,
              original_text: img.vlm_description,
              original_text_length: img.vlm_description.length,
              source_file_path: img.extracted_path ?? 'unknown',
              source_file_name: img.extracted_path?.split('/').pop() ?? 'vlm_description',
              source_file_hash: 'vlm_generated',
              page_number: img.page_number,
              page_range: null,
              character_start: 0,
              character_end: img.vlm_description.length,
              chunk_index: 0,
              total_chunks: 1,
              model_name: 'nomic-embed-text-v1.5',
              model_version: '1.5.0',
              task_type: 'search_document',
              inference_mode: 'local',
              gpu_device: 'cuda:0',
              provenance_id: embProvId,
              content_hash: computeHash(img.vlm_description),
              generation_duration_ms: null,
            });

            // Store vector
            vector.storeVector(embId, vlmEmbedResult);

            // Update image with new VLM embedding ID
            conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(embId, img.id);

            rebuiltIds.push(embId);
            provenanceIds.push(embProvId);
          } catch (vlmError) {
            const errMsg = vlmError instanceof Error ? vlmError.message : String(vlmError);
            vlmEmbedFailures++;
            console.error(`[EMBEDDING_REBUILD] VLM embedding failed for image ${img.id}: ${errMsg}`);
            // Non-fatal: continue with remaining images
          }
        }

        // If ALL VLM embeddings failed, throw an error
        if (vlmEmbedFailures > 0 && vlmEmbedFailures === vlmImages.length) {
          throw new Error(`All ${vlmEmbedFailures} VLM embedding(s) failed during rebuild for document ${input.document_id}`);
        }
      }
    }

    let target: { type: string; id: string | undefined };
    if (input.document_id) {
      target = { type: 'document', id: input.document_id };
    } else if (input.chunk_id) {
      target = { type: 'chunk', id: input.chunk_id };
    } else {
      target = { type: 'image', id: input.image_id };
    }

    return formatResponse(
      successResult({
        rebuilt_count: rebuiltIds.length,
        new_embedding_ids: rebuiltIds,
        provenance_ids: provenanceIds,
        vlm_embed_failures: vlmEmbedFailures > 0 ? vlmEmbedFailures : undefined,
        target,
        next_steps: [
          { tool: 'ocr_embedding_stats', description: 'Verify embedding coverage after rebuild' },
          { tool: 'ocr_search', description: 'Search using the rebuilt embeddings' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const embeddingTools: Record<string, ToolDefinition> = {
  ocr_embedding_list: {
    description:
      '[STATUS] Use to browse embeddings with filtering by document, source type (chunk/image/extraction), and model. Returns embedding metadata with source context.',
    inputSchema: {
      document_id: z.string().min(1).optional().describe('Filter by document ID'),
      source_type: z
        .enum(['chunk', 'image', 'extraction'])
        .optional()
        .describe('Filter by source type'),
      model_name: z.string().min(1).optional().describe('Filter by model name'),
      limit: z.number().int().min(1).max(100).default(50).describe('Max results (default: 50)'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    handler: handleEmbeddingList,
  },

  ocr_embedding_stats: {
    description:
      '[STATUS] Use to check embedding coverage and performance. Returns total count, breakdown by source type, device stats, and counts of unembedded chunks/images.',
    inputSchema: {
      document_id: z.string().min(1).optional().describe('Scope stats to a specific document'),
    },
    handler: handleEmbeddingStats,
  },

  ocr_embedding_get: {
    description:
      '[STATUS] Use to inspect a specific embedding by ID. Returns source context (chunk, image, or extraction), document context, model info, and optional provenance chain.',
    inputSchema: {
      embedding_id: z.string().min(1).describe('Embedding ID to retrieve'),
      include_provenance: z.boolean().default(false).describe('Include full provenance chain'),
    },
    handler: handleEmbeddingGet,
  },

  ocr_embedding_rebuild: {
    description:
      '[SETUP] Rebuild embeddings for a document, chunk, or image. Use after config changes or VLM re-analysis. include_vlm=true for VLM image embeddings.',
    inputSchema: {
      document_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Rebuild all chunk embeddings for this document (add include_vlm=true for VLM image embeddings too)'
        ),
      chunk_id: z.string().min(1).optional().describe('Rebuild embedding for this specific chunk'),
      image_id: z
        .string()
        .min(1)
        .optional()
        .describe('Rebuild VLM embedding for this specific image'),
      include_vlm: z
        .boolean()
        .default(false)
        .optional()
        .describe('When true with document_id, also rebuild VLM embeddings for images'),
    },
    handler: handleEmbeddingRebuild,
  },
};
