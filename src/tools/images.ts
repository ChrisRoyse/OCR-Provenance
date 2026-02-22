/**
 * Image Extraction and Management MCP Tools
 *
 * Tools for extracting images from PDFs and managing image records in the database.
 * Uses PyMuPDF for extraction and integrates with VLM pipeline.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/images
 */

import { z } from 'zod';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, fetchProvenanceChain, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import {
  getImage,
  getImagesByDocument,
  getPendingImages,
  getImageStats,
  deleteImageCascade,
  deleteImagesByDocumentCascade,
  resetFailedImages,
  resetProcessingImages,
  updateImageVLMResult,
} from '../services/storage/database/image-operations.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';
import { getEmbeddingService } from '../services/embedding/embedder.js';
import { getVLMService } from '../services/vlm/service.js';

// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const ImageListInput = z.object({
  document_id: z.string().min(1),
  include_descriptions: z.boolean().default(false),
  vlm_status: z.enum(['pending', 'processing', 'complete', 'failed']).optional(),
});

const ImageGetInput = z.object({
  image_id: z.string().min(1),
});

const ImageStatsInput = z.object({});

const ImageDeleteInput = z.object({
  image_id: z.string().optional(),
  document_id: z.string().optional(),
  confirm: z.boolean().default(false),
  delete_files: z.boolean().default(false),
});

const ImageResetFailedInput = z.object({
  document_id: z.string().optional(),
});

const ImagePendingInput = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
});

const ImageSearchInput = z.object({
  mode: z.enum(['keyword', 'semantic']).default('keyword'),
  // keyword mode params
  image_type: z.string().optional(),
  block_type: z.string().optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  document_id: z.string().optional(),
  exclude_headers_footers: z.boolean().default(false),
  page_number: z.number().int().min(1).optional(),
  vlm_description_query: z.string().optional(),
  // semantic mode params
  query: z.string().optional(),
  document_filter: z.array(z.string().min(1)).optional(),
  similarity_threshold: z.number().min(0).max(1).default(0.5),
  include_provenance: z.boolean().default(false),
  // shared
  limit: z.number().int().min(1).max(100).default(50),
});

const ImageReanalyzeInput = z.object({
  image_id: z.string().min(1),
  custom_prompt: z.string().optional(),
  use_thinking: z.boolean().default(false),
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_image_list - List all images in a document
 */
export async function handleImageList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageListInput, params);
    const documentId = input.document_id;
    const includeDescriptions = input.include_descriptions ?? false;
    const vlmStatusFilter = input.vlm_status;

    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`, {
        document_id: documentId,
      });
    }

    const images = getImagesByDocument(
      db.getConnection(),
      documentId,
      vlmStatusFilter ? { vlmStatus: vlmStatusFilter } : undefined
    );

    return formatResponse(
      successResult({
        document_id: documentId,
        count: images.length,
        images: images.map((img) => ({
          id: img.id,
          page: img.page_number,
          index: img.image_index,
          format: img.format,
          dimensions: img.dimensions,
          vlm_status: img.vlm_status,
          has_vlm: img.vlm_status === 'complete',
          confidence: img.vlm_confidence,
          ...(includeDescriptions &&
            img.vlm_description && {
              description: img.vlm_description,
            }),
        })),
        next_steps: [
          { tool: 'ocr_image_get', description: 'Get full details for a specific image' },
          { tool: 'ocr_vlm_process', description: 'Run VLM analysis on document images' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_get - Get details of a specific image
 */
export async function handleImageGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageGetInput, params);
    const imageId = input.image_id;

    const { db } = requireDatabase();

    const img = getImage(db.getConnection(), imageId);
    if (!img) {
      throw new MCPError('VALIDATION_ERROR', `Image not found: ${imageId}`, { image_id: imageId });
    }

    const responseData: Record<string, unknown> = {
      image: {
        id: img.id,
        document_id: img.document_id,
        ocr_result_id: img.ocr_result_id,
        page: img.page_number,
        index: img.image_index,
        format: img.format,
        dimensions: img.dimensions,
        bounding_box: img.bounding_box,
        path: img.extracted_path,
        file_size: img.file_size,
        vlm_status: img.vlm_status,
        vlm:
          img.vlm_status === 'complete'
            ? {
                description: img.vlm_description,
                structured_data: img.vlm_structured_data,
                model: img.vlm_model,
                confidence: img.vlm_confidence,
                tokens_used: img.vlm_tokens_used,
                processed_at: img.vlm_processed_at,
                embedding_id: img.vlm_embedding_id,
              }
            : null,
        error_message: img.error_message,
        created_at: img.created_at,
      },
      next_steps: [
        { tool: 'ocr_image_search', description: 'Find similar images (mode=semantic for meaning-based)' },
        { tool: 'ocr_image_reanalyze', description: 'Re-run VLM analysis with custom prompt' },
        { tool: 'ocr_document_page', description: 'View the page containing this image' },
      ],
    };

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_stats - Get image processing statistics
 */
export async function handleImageStats(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    validateInput(ImageStatsInput, params);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const stats = getImageStats(conn);

    return formatResponse(
      successResult({
        stats: {
          total: stats.total,
          processed: stats.processed,
          pending: stats.pending,
          processing: stats.processing,
          failed: stats.failed,
          processing_rate:
            stats.total > 0 ? ((stats.processed / stats.total) * 100).toFixed(1) + '%' : '0%',
        },
        next_steps: [
          { tool: 'ocr_vlm_process', description: 'Process pending VLM images' },
          { tool: 'ocr_image_pending', description: 'List images awaiting processing' },
          { tool: 'ocr_image_search', description: 'Search images by type or filter' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_delete - Delete images by image_id (single) or document_id (all for document)
 *
 * Must provide exactly one of image_id or document_id. Requires confirm=true.
 */
export async function handleImageDelete(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageDeleteInput, params);
    const { image_id: imageId, document_id: documentId, confirm, delete_files: deleteFiles } = input;

    if (!imageId && !documentId) {
      throw new MCPError('VALIDATION_ERROR', 'Must provide either image_id or document_id', {});
    }
    if (imageId && documentId) {
      throw new MCPError('VALIDATION_ERROR', 'Provide only one of image_id or document_id, not both', {});
    }
    if (!confirm) {
      throw new MCPError('VALIDATION_ERROR', 'Destructive operation requires confirm=true', {});
    }

    const { db } = requireDatabase();

    if (imageId) {
      // ── Single image delete ──
      const img = getImage(db.getConnection(), imageId);
      if (!img) {
        throw new MCPError('VALIDATION_ERROR', `Image not found: ${imageId}`, { image_id: imageId });
      }

      if (deleteFiles && img.extracted_path && fs.existsSync(img.extracted_path)) {
        fs.unlinkSync(img.extracted_path);
      }

      deleteImageCascade(db.getConnection(), imageId);

      return formatResponse(
        successResult({
          mode: 'single',
          image_id: imageId,
          deleted: true,
          file_deleted: !!(deleteFiles && img.extracted_path),
          next_steps: [
            { tool: 'ocr_image_list', description: 'List remaining images for the document' },
          ],
        })
      );
    } else {
      // ── Delete all images for document ──
      let filesDeleted = 0;
      if (deleteFiles) {
        const images = getImagesByDocument(db.getConnection(), documentId!);
        for (const img of images) {
          if (img.extracted_path && fs.existsSync(img.extracted_path)) {
            fs.unlinkSync(img.extracted_path);
            filesDeleted++;
          }
        }
      }

      const count = deleteImagesByDocumentCascade(db.getConnection(), documentId!);

      return formatResponse(
        successResult({
          mode: 'document',
          document_id: documentId,
          images_deleted: count,
          files_deleted: filesDeleted,
          next_steps: [
            { tool: 'ocr_extract_images', description: 'Re-extract images for the document' },
            { tool: 'ocr_document_get', description: 'View the document after image cleanup' },
          ],
        })
      );
    }
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_reset_failed - Reset failed and stuck processing images to pending status
 */
export async function handleImageResetFailed(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageResetFailedInput, params);
    const documentId = input.document_id;

    const { db } = requireDatabase();

    const failedCount = resetFailedImages(db.getConnection(), documentId);
    const processingCount = resetProcessingImages(db.getConnection(), documentId);

    return formatResponse(
      successResult({
        document_id: documentId ?? 'all',
        images_reset: failedCount + processingCount,
        failed_reset: failedCount,
        processing_reset: processingCount,
        next_steps: [
          { tool: 'ocr_vlm_process', description: 'Process the reset images' },
          { tool: 'ocr_image_pending', description: 'Check pending images after reset' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_search - Search images by keyword filters or semantic similarity
 *
 * mode=keyword: SQL LIKE search on VLM descriptions and metadata filters
 * mode=semantic: Vector similarity search on VLM embeddings
 */
export async function handleImageSearch(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageSearchInput, params);
    const mode = input.mode ?? 'keyword';

    if (mode === 'semantic') {
      // ── Semantic search mode ──
      if (!input.query) {
        throw new MCPError('VALIDATION_ERROR', 'query is required for mode=semantic', {});
      }

      const { db, vector } = requireDatabase();

      const embeddingService = getEmbeddingService();
      const queryVector = await embeddingService.embedSearchQuery(input.query);

      const limit = input.limit ?? 10;
      const searchResults = vector.searchSimilar(queryVector, {
        limit: limit * 3,
        threshold: input.similarity_threshold,
        documentFilter: input.document_filter,
      });

      const vlmResults = searchResults.filter(r => r.image_id !== null);

      const results = [];
      for (const r of vlmResults) {
        if (results.length >= limit) break;

        const img = getImage(db.getConnection(), r.image_id as string);
        if (!img) continue;

        const doc = db.getDocument(r.document_id);

        const result: Record<string, unknown> = {
          image_id: img.id,
          document_id: img.document_id,
          document_file_path: doc?.file_path ?? null,
          document_file_name: doc?.file_name ?? null,
          extracted_path: img.extracted_path,
          page_number: img.page_number,
          image_index: img.image_index,
          format: img.format,
          dimensions: img.dimensions,
          block_type: img.block_type,
          vlm_description: img.vlm_description,
          vlm_confidence: img.vlm_confidence,
          similarity_score: r.similarity_score,
          embedding_id: r.embedding_id,
        };

        if (img.vlm_structured_data) {
          const structured = img.vlm_structured_data;
          result.image_type = structured.imageType ?? null;
          result.vlm_extracted_text = structured.extractedText ?? [];
          result.vlm_dates = structured.dates ?? [];
          result.vlm_names = structured.names ?? [];
          result.vlm_numbers = structured.numbers ?? [];
          result.vlm_primary_subject = structured.primarySubject ?? null;
        }

        if (input.include_provenance && img.provenance_id) {
          result.provenance_chain = fetchProvenanceChain(db, img.provenance_id, '[image_search_semantic]');
        }

        results.push(result);
      }

      return formatResponse(successResult({
        mode: 'semantic',
        query: input.query,
        total: results.length,
        similarity_threshold: input.similarity_threshold,
        results,
        next_steps: [
          { tool: 'ocr_image_get', description: 'Get full details for a matched image' },
          { tool: 'ocr_document_page', description: 'View the page containing a matched image' },
        ],
      }));
    } else {
      // ── Keyword search mode ──
      const { db } = requireDatabase();
      const conn = db.getConnection();

      let sql = `SELECT id, document_id, page_number, image_index, format, width, height,
        vlm_confidence, vlm_description, vlm_structured_data, block_type,
        is_header_footer, extracted_path, file_size
        FROM images WHERE vlm_status = 'complete'`;
      const sqlParams: unknown[] = [];

      if (input.image_type) {
        sql += ` AND json_extract(vlm_structured_data, '$.imageType') = ?`;
        sqlParams.push(input.image_type);
      }
      if (input.block_type) {
        sql += ` AND block_type = ?`;
        sqlParams.push(input.block_type);
      }
      if (input.min_confidence !== undefined) {
        sql += ` AND vlm_confidence >= ?`;
        sqlParams.push(input.min_confidence);
      }
      if (input.document_id) {
        sql += ` AND document_id = ?`;
        sqlParams.push(input.document_id);
      }
      if (input.exclude_headers_footers) {
        sql += ` AND is_header_footer = 0`;
      }
      if (input.page_number !== undefined) {
        sql += ` AND page_number = ?`;
        sqlParams.push(input.page_number);
      }
      if (input.vlm_description_query) {
        sql += ` AND vlm_description LIKE '%' || ? || '%'`;
        sqlParams.push(input.vlm_description_query);
      }

      sql += ` ORDER BY document_id, page_number, image_index LIMIT ?`;
      sqlParams.push(input.limit);

      const rows = conn.prepare(sql).all(...sqlParams) as Record<string, unknown>[];

      const results = rows.map(r => {
        let structured: Record<string, unknown> | null = null;
        if (r.vlm_structured_data) {
          try {
            structured = JSON.parse(r.vlm_structured_data as string);
          } catch {
            console.error(`[T1.1] Failed to parse vlm_structured_data for image ${r.id}: malformed JSON`);
          }
        }

        const base: Record<string, unknown> = {
          id: r.id,
          document_id: r.document_id,
          page_number: r.page_number,
          image_index: r.image_index,
          format: r.format,
          dimensions: { width: r.width, height: r.height },
          vlm_confidence: r.vlm_confidence,
          vlm_description: r.vlm_description,
          vlm_structured_data: structured,
          block_type: r.block_type,
          is_header_footer: r.is_header_footer === 1,
          extracted_path: r.extracted_path,
          file_size: r.file_size,
        };

        if (structured) {
          base.image_type = structured.imageType ?? null;
          base.vlm_extracted_text = structured.extractedText ?? [];
          base.vlm_dates = structured.dates ?? [];
          base.vlm_names = structured.names ?? [];
          base.vlm_numbers = structured.numbers ?? [];
          base.vlm_primary_subject = structured.primarySubject ?? null;
        }

        return base;
      });

      const typeCounts: Record<string, number> = {};
      for (const r of results) {
        const type = (r.image_type as string) || 'unknown';
        typeCounts[type] = (typeCounts[type] || 0) + 1;
      }

      return formatResponse(
        successResult({
          mode: 'keyword',
          images: results,
          total: results.length,
          type_distribution: typeCounts,
          next_steps: [
            { tool: 'ocr_image_get', description: 'Get full details for a specific image' },
            { tool: 'ocr_image_search', description: 'Try mode=semantic for meaning-based search' },
          ],
        })
      );
    }
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_pending - Get images pending VLM processing
 */
export async function handleImagePending(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImagePendingInput, params);
    const limit = input.limit ?? 100;

    const { db } = requireDatabase();

    const images = getPendingImages(db.getConnection(), limit);

    return formatResponse(
      successResult({
        count: images.length,
        limit,
        images: images.map((img) => ({
          id: img.id,
          document_id: img.document_id,
          page: img.page_number,
          index: img.image_index,
          format: img.format,
          path: img.extracted_path,
          created_at: img.created_at,
        })),
        next_steps: [
          { tool: 'ocr_vlm_process', description: 'Process all pending VLM images' },
          { tool: 'ocr_vlm_process', description: 'Process images for a specific document' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_reanalyze - Re-run VLM analysis on a specific image with optional custom prompt
 */
export async function handleImageReanalyze(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageReanalyzeInput, params);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    // Get image record
    const img = getImage(conn, input.image_id);
    if (!img) {
      throw new MCPError('VALIDATION_ERROR', `Image not found: ${input.image_id}`, { image_id: input.image_id });
    }

    // Verify extracted_path exists on disk
    if (!img.extracted_path || !fs.existsSync(img.extracted_path)) {
      throw new MCPError('PATH_NOT_FOUND', `Image file not found on disk: ${img.extracted_path ?? '(no path)'}`, {
        image_id: input.image_id,
        extracted_path: img.extracted_path,
      });
    }

    // Store previous description
    const previousDescription = img.vlm_description;

    // Run VLM analysis
    const vlm = getVLMService();
    const startMs = Date.now();

    let vlmResult;
    if (input.use_thinking) {
      vlmResult = await vlm.analyzeDeep(img.extracted_path);
    } else if (input.custom_prompt) {
      // Use describeImage with context as a way to inject custom prompt context
      vlmResult = await vlm.describeImage(img.extracted_path, {
        contextText: input.custom_prompt,
        highResolution: true,
      });
    } else {
      vlmResult = await vlm.describeImage(img.extracted_path, {
        highResolution: true,
      });
    }

    const processingDurationMs = Date.now() - startMs;

    // Generate new embedding for the VLM description
    const { getEmbeddingClient, MODEL_NAME: EMBEDDING_MODEL } = await import('../services/embedding/nomic.js');
    const embeddingClient = getEmbeddingClient();
    const vectors = await embeddingClient.embedChunks([vlmResult.description], 1);

    if (vectors.length === 0) {
      throw new MCPError('EMBEDDING_FAILED', 'Failed to generate embedding for VLM description', {
        image_id: input.image_id,
      });
    }

    const embId = uuidv4();
    const now = new Date().toISOString();
    const descriptionHash = computeHash(vlmResult.description);

    // Build provenance chain
    let vlmDescProvId: string | null = null;
    let embProvId: string | null = null;

    if (img.provenance_id) {
      const imageProv = db.getProvenance(img.provenance_id);
      if (imageProv) {
        const imageParentIds = JSON.parse(imageProv.parent_ids) as string[];

        // Create VLM_DESCRIPTION provenance (depth 3)
        vlmDescProvId = uuidv4();
        const vlmParentIds = [...imageParentIds, img.provenance_id];

        db.insertProvenance({
          id: vlmDescProvId,
          type: ProvenanceType.VLM_DESCRIPTION,
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'VLM',
          source_path: img.extracted_path,
          source_id: img.provenance_id,
          root_document_id: imageProv.root_document_id,
          location: {
            page_number: img.page_number,
            chunk_index: img.image_index,
          },
          content_hash: descriptionHash,
          input_hash: imageProv.content_hash,
          file_hash: imageProv.file_hash,
          processor: 'gemini-vlm:reanalyze',
          processor_version: '3.0',
          processing_params: {
            type: 'vlm_reanalyze',
            use_thinking: input.use_thinking,
            custom_prompt: !!input.custom_prompt,
          },
          processing_duration_ms: processingDurationMs,
          processing_quality_score: vlmResult.analysis?.confidence ?? null,
          parent_id: img.provenance_id,
          parent_ids: JSON.stringify(vlmParentIds),
          chain_depth: 3,
          chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION']),
        });

        // Create EMBEDDING provenance (depth 4)
        embProvId = uuidv4();
        const embParentIds = [...vlmParentIds, vlmDescProvId];

        db.insertProvenance({
          id: embProvId,
          type: ProvenanceType.EMBEDDING,
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'EMBEDDING',
          source_path: null,
          source_id: vlmDescProvId,
          root_document_id: imageProv.root_document_id,
          location: {
            page_number: img.page_number,
            chunk_index: img.image_index,
          },
          content_hash: descriptionHash,
          input_hash: descriptionHash,
          file_hash: imageProv.file_hash,
          processor: EMBEDDING_MODEL,
          processor_version: '1.5.0',
          processing_params: { task_type: 'search_document', dimensions: 768 },
          processing_duration_ms: null,
          processing_quality_score: null,
          parent_id: vlmDescProvId,
          parent_ids: JSON.stringify(embParentIds),
          chain_depth: 4,
          chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING']),
        });
      }
    }

    // Insert embedding record
    db.insertEmbedding({
      id: embId,
      chunk_id: null,
      image_id: img.id,
      extraction_id: null,
      document_id: img.document_id,
      original_text: vlmResult.description,
      original_text_length: vlmResult.description.length,
      source_file_path: img.extracted_path ?? 'unknown',
      source_file_name: img.extracted_path?.split('/').pop() ?? 'vlm_description',
      source_file_hash: 'vlm_generated',
      page_number: img.page_number,
      page_range: null,
      character_start: 0,
      character_end: vlmResult.description.length,
      chunk_index: img.image_index,
      total_chunks: 1,
      model_name: EMBEDDING_MODEL,
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProvId ?? uuidv4(),
      content_hash: descriptionHash,
      generation_duration_ms: null,
    });

    // Store vector
    vector.storeVector(embId, vectors[0]);

    // Update image record with new VLM results
    updateImageVLMResult(conn, img.id, {
      description: vlmResult.description,
      structuredData: { ...vlmResult.analysis, imageType: vlmResult.analysis?.imageType ?? 'unknown' },
      embeddingId: embId,
      model: vlmResult.model,
      confidence: vlmResult.analysis?.confidence ?? 0,
      tokensUsed: vlmResult.tokensUsed,
    });

    return formatResponse(successResult({
      image_id: img.id,
      extracted_path: img.extracted_path,
      previous_description: previousDescription,
      new_description: vlmResult.description,
      new_confidence: vlmResult.analysis?.confidence ?? null,
      new_embedding_id: embId,
      provenance_id: vlmDescProvId,
      processing_time_ms: processingDurationMs,
      tokens_used: vlmResult.tokensUsed,
      next_steps: [
        { tool: 'ocr_image_get', description: 'View the updated image details' },
        { tool: 'ocr_image_search', description: 'Search for similar images (mode=semantic for meaning-based)' },
      ],
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Image tools collection for MCP server registration
 */
export const imageTools: Record<string, ToolDefinition> = {
  ocr_image_list: {
    description: '[ANALYSIS] Use to list all images from a document with optional VLM status filter. Returns image metadata and optionally descriptions.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      include_descriptions: z.boolean().default(false).describe('Include VLM descriptions'),
      vlm_status: z
        .enum(['pending', 'processing', 'complete', 'failed'])
        .optional()
        .describe('Filter by VLM status'),
    },
    handler: handleImageList,
  },

  ocr_image_get: {
    description: '[ANALYSIS] Use to get full details for a single image (path, dimensions, VLM description, confidence, provenance). Returns complete image record.',
    inputSchema: {
      image_id: z.string().min(1).describe('Image ID'),
    },
    handler: handleImageGet,
  },

  ocr_image_stats: {
    description: '[STATUS] Use to get image processing statistics (total, by status, by type). Returns aggregate counts across all documents.',
    inputSchema: {},
    handler: handleImageStats,
  },

  ocr_image_delete: {
    description: '[DESTRUCTIVE] Use to delete images. Pass image_id for one image, or document_id for all document images. Requires confirm=true.',
    inputSchema: {
      image_id: z.string().optional().describe('Image ID (for single image delete)'),
      document_id: z.string().optional().describe('Document ID (to delete all images for document)'),
      confirm: z.boolean().default(false).describe('Must be true to confirm deletion'),
      delete_files: z.boolean().default(false).describe('Also delete the extracted image files from disk'),
    },
    handler: handleImageDelete,
  },

  ocr_image_reset_failed: {
    description: '[PROCESSING] Use to reset failed VLM images back to pending for retry. Returns reset count. Follow with ocr_vlm_process.',
    inputSchema: {
      document_id: z.string().optional().describe('Document ID (omit for all documents)'),
    },
    handler: handleImageResetFailed,
  },

  ocr_image_pending: {
    description: '[STATUS] Use to list images that still need VLM processing. Returns pending image IDs and metadata. Check before running ocr_vlm_process.',
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximum images to return'),
    },
    handler: handleImagePending,
  },

  ocr_image_search: {
    description: '[SEARCH] Use to find images by keyword in descriptions (mode=keyword) or by semantic similarity (mode=semantic). Returns image metadata with VLM data.',
    inputSchema: {
      mode: z.enum(['keyword', 'semantic']).default('keyword')
        .describe('Search mode: keyword for SQL filters, semantic for vector similarity'),
      // keyword mode params
      image_type: z.string().optional()
        .describe('Filter by VLM image type (keyword mode, e.g., "chart", "diagram", "photograph")'),
      block_type: z.string().optional()
        .describe('Filter by Datalab block type (keyword mode)'),
      min_confidence: z.number().min(0).max(1).optional()
        .describe('Minimum VLM confidence score (keyword mode)'),
      document_id: z.string().optional()
        .describe('Filter to specific document (keyword mode)'),
      exclude_headers_footers: z.boolean().default(false)
        .describe('Exclude header/footer images (keyword mode)'),
      page_number: z.number().int().min(1).optional()
        .describe('Filter to specific page (keyword mode)'),
      vlm_description_query: z.string().optional()
        .describe('Filter by VLM description text LIKE match (keyword mode)'),
      // semantic mode params
      query: z.string().optional()
        .describe('Search query (required for semantic mode)'),
      document_filter: z.array(z.string().min(1)).optional()
        .describe('Filter to specific document IDs (semantic mode)'),
      similarity_threshold: z.number().min(0).max(1).default(0.5)
        .describe('Minimum similarity score (semantic mode)'),
      include_provenance: z.boolean().default(false)
        .describe('Include provenance chain (semantic mode)'),
      // shared
      limit: z.number().int().min(1).max(100).default(50).describe('Maximum results'),
    },
    handler: handleImageSearch,
  },

  ocr_image_reanalyze: {
    description: '[PROCESSING] Use to re-run VLM analysis on a specific image with optional custom prompt. Returns new description while preserving audit trail.',
    inputSchema: {
      image_id: z.string().min(1).describe('Image ID to reanalyze'),
      custom_prompt: z.string().optional()
        .describe('Custom context/prompt for the VLM analysis'),
      use_thinking: z.boolean().default(false)
        .describe('Use extended reasoning (thinking mode) for deeper analysis'),
    },
    handler: handleImageReanalyze,
  },
};
