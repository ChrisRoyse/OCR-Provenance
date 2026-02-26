/**
 * VLM (Vision Language Model) MCP Tools
 *
 * Tools for Gemini 3 multimodal image analysis of legal and medical documents.
 * Uses the VLMService for analysis and VLMPipeline for batch processing.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/vlm
 */

import { z } from 'zod';
import * as fs from 'fs';
import { requireDatabase, withDatabaseOperation } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { logAudit } from '../services/audit.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput, sanitizePath } from '../utils/validation.js';
import { getVLMService } from '../services/vlm/service.js';
import { VLMPipeline } from '../services/vlm/pipeline.js';
import { GeminiClient, getSharedClient } from '../services/gemini/client.js';

// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const VLMDescribeInput = z.object({
  image_path: z.string().min(1),
  context_text: z.string().optional(),
  use_thinking: z.boolean().default(false),
});

const VLMProcessInput = z.object({
  document_id: z.string().optional(),
  batch_size: z.number().int().min(1).max(20).default(5),
  limit: z.number().int().min(1).max(500).default(50),
});

const VLMAnalyzePDFInput = z.object({
  pdf_path: z.string().min(1),
  prompt: z.string().optional(),
});

const VLMStatusInput = z.object({});

// ═══════════════════════════════════════════════════════════════════════════════
// VLM TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_vlm_describe - Generate detailed description of an image using Gemini 3
 *
 * If the image is a database-tracked image (matched by extracted_path), this tool
 * will also generate an embedding with full provenance chain for searchability.
 * For arbitrary images not in the database, only the description is returned.
 */
export async function handleVLMDescribe(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMDescribeInput, params);
    const imagePath = sanitizePath(input.image_path);
    const contextText = input.context_text;
    const useThinking = input.use_thinking;

    // Validate image path exists
    if (!fs.existsSync(imagePath)) {
      throw new MCPError('PATH_NOT_FOUND', `Image file not found: ${imagePath}`, {
        image_path: imagePath,
      });
    }

    return await withDatabaseOperation(async () => {
      const vlm = getVLMService();

      // Enrich context with table metadata for database-tracked images
      let enrichedContext = contextText;
      try {
        const { db } = requireDatabase();
        const conn = db.getConnection();
        // Look up image by path to get page number
        const imgRow = conn
          .prepare('SELECT document_id, page_number FROM images WHERE extracted_path = ?')
          .get(imagePath) as { document_id: string; page_number: number | null } | undefined;

        if (imgRow != null && imgRow.page_number != null) {
          // Find table provenance for this document
          const tableRows = conn
            .prepare(
              "SELECT processing_params FROM provenance WHERE root_document_id IN (SELECT provenance_id FROM documents WHERE id = ?) AND processing_params LIKE '%table_columns%' AND json_extract(processing_params, '$.character_start') IS NOT NULL"
            )
            .all(imgRow.document_id) as Array<{ processing_params: string }>;

          const tableContextParts: string[] = [];
          for (const row of tableRows) {
            try {
              const params = JSON.parse(row.processing_params) as Record<string, unknown>;
              const cols = params.table_columns as string[] | undefined;
              const summary = params.table_summary as string | undefined;
              if (cols && cols.length > 0) {
                const part = summary ?? `Table with columns: ${cols.join(', ')}`;
                tableContextParts.push(part);
              }
            } catch (error) {
              console.error(
                `[vlm] Failed to parse table processing_params for row: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }

          if (tableContextParts.length > 0) {
            const tableContext = `This page contains structured table data. ${tableContextParts.join('. ')}`;
            enrichedContext = enrichedContext
              ? `${enrichedContext}\n\n${tableContext}`
              : tableContext;
          }
        }
      } catch (error) {
        console.error(
          `[vlm] Failed to enrich VLM context from database for image ${imagePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      let result;
      if (useThinking) {
        // Use deep analysis with extended reasoning
        result = await vlm.analyzeDeep(imagePath);
      } else {
        result = await vlm.describeImage(imagePath, {
          contextText: enrichedContext,
          highResolution: true,
        });
      }

      // Try to generate embedding for database-tracked images
      let embeddingId: string | null = null;
      let embeddingGenerated = false;
      try {
        const { db, vector } = requireDatabase();
        const conn = db.getConnection();

        // Look up image by extracted_path
        const dbImage = conn
          .prepare(
            'SELECT id, document_id, page_number, image_index, extracted_path, provenance_id FROM images WHERE extracted_path = ?'
          )
          .get(imagePath) as
          | {
              id: string;
              document_id: string;
              page_number: number;
              image_index: number;
              extracted_path: string | null;
              provenance_id: string | null;
            }
          | undefined;

        if (dbImage && dbImage.provenance_id && result.description) {
          const { getEmbeddingClient, MODEL_NAME: EMBEDDING_MODEL } =
            await import('../services/embedding/nomic.js');
          const { v4: uuidv4 } = await import('uuid');
          const { computeHash } = await import('../utils/hash.js');
          const { ProvenanceType } = await import('../models/provenance.js');

          const embeddingClient = getEmbeddingClient();
          const vectors = await embeddingClient.embedChunks([result.description], 1);

          if (vectors.length > 0) {
            const embId = uuidv4();
            const now = new Date().toISOString();
            const descriptionHash = computeHash(result.description);

            // Get IMAGE provenance to build chain
            const imageProv = db.getProvenance(dbImage.provenance_id);
            if (imageProv) {
              // Create VLM_DESCRIPTION provenance (depth 3)
              const vlmDescProvId = uuidv4();
              const imageParentIds = JSON.parse(imageProv.parent_ids) as string[];
              const vlmParentIds = [...imageParentIds, dbImage.provenance_id];

              db.insertProvenance({
                id: vlmDescProvId,
                type: ProvenanceType.VLM_DESCRIPTION,
                created_at: now,
                processed_at: now,
                source_file_created_at: null,
                source_file_modified_at: null,
                source_type: 'VLM',
                source_path: dbImage.extracted_path,
                source_id: dbImage.provenance_id,
                root_document_id: imageProv.root_document_id,
                location: {
                  page_number: dbImage.page_number,
                  chunk_index: dbImage.image_index,
                },
                content_hash: descriptionHash,
                input_hash: imageProv.content_hash,
                file_hash: imageProv.file_hash,
                processor: 'gemini-vlm:describe',
                processor_version: '3.0',
                processing_params: { type: 'vlm_describe', use_thinking: useThinking },
                processing_duration_ms: result.processingTimeMs ?? null,
                processing_quality_score: null,
                parent_id: dbImage.provenance_id,
                parent_ids: JSON.stringify(vlmParentIds),
                chain_depth: 3,
                chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION']),
              });

              // Create EMBEDDING provenance (depth 4)
              const embProvId = uuidv4();
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
                  page_number: dbImage.page_number,
                  chunk_index: dbImage.image_index,
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
                chain_path: JSON.stringify([
                  'DOCUMENT',
                  'OCR_RESULT',
                  'IMAGE',
                  'VLM_DESCRIPTION',
                  'EMBEDDING',
                ]),
              });

              // Insert embedding record
              db.insertEmbedding({
                id: embId,
                chunk_id: null,
                image_id: dbImage.id,
                extraction_id: null,
                document_id: dbImage.document_id,
                original_text: result.description,
                original_text_length: result.description.length,
                source_file_path: dbImage.extracted_path ?? 'unknown',
                source_file_name: dbImage.extracted_path?.split('/').pop() ?? 'vlm_description',
                source_file_hash: 'vlm_generated',
                page_number: dbImage.page_number,
                page_range: null,
                character_start: 0,
                character_end: result.description.length,
                chunk_index: dbImage.image_index,
                total_chunks: 1,
                model_name: EMBEDDING_MODEL,
                model_version: '1.5.0',
                task_type: 'search_document',
                inference_mode: 'local',
                gpu_device: 'cuda:0',
                provenance_id: embProvId,
                content_hash: descriptionHash,
                generation_duration_ms: null,
              });

              // Store vector
              vector.storeVector(embId, vectors[0]);

              // Update image.vlm_embedding_id
              conn
                .prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?')
                .run(embId, dbImage.id);

              embeddingId = embId;
              embeddingGenerated = true;
              console.error(
                `[INFO] VLM describe embedding generated for image ${dbImage.id}: ${embId}`
              );
            }
          }
        }
      } catch (embError) {
        const errMsg = embError instanceof Error ? embError.message : String(embError);
        console.error(`[ERROR] VLM describe embedding generation failed: ${errMsg}`);
        throw new Error(`VLM description stored but embedding failed: ${errMsg}. Description is not searchable.`);
      }

      logAudit({
        action: 'vlm_describe',
        entityType: 'image',
        entityId: imagePath,
        details: { model: result.model, tokens_used: result.tokensUsed, embedding_generated: embeddingGenerated },
      });

      return formatResponse(
        successResult({
          description: result.description,
          analysis: result.analysis,
          model: result.model,
          processing_time_ms: result.processingTimeMs,
          tokens_used: result.tokensUsed,
          confidence: result.analysis.confidence,
          embedding_id: embeddingId,
          embedding_generated: embeddingGenerated,
          next_steps: [
            {
              tool: 'ocr_image_get',
              description: 'View image details including the new description',
            },
            {
              tool: 'ocr_image_search',
              description: 'Search for similar images (mode=semantic for meaning-based)',
            },
          ],
        })
      );
    }); // end withDatabaseOperation
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_process - Process VLM on a single document or all pending images
 *
 * If document_id is provided, processes all images in that document.
 * If document_id is omitted, processes all pending images across all documents.
 */
export async function handleVLMProcess(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMProcessInput, params);
    const documentId = input.document_id;
    const batchSize = input.batch_size ?? 5;
    const limit = input.limit ?? 50;

    return await withDatabaseOperation(async () => {
      const { db, vector } = requireDatabase();
      const conn = db.getConnection();

      if (documentId) {
        // Single document mode
        const doc = db.getDocument(documentId);
        if (!doc) {
          throw new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`, {
            document_id: documentId,
          });
        }

        const pipeline = new VLMPipeline(conn, {
          config: {
            batchSize,
            concurrency: 5,
            minConfidence: 0.5,
            skipEmbeddings: false,
            skipProvenance: false,
          },
          dbService: db,
          vectorService: vector,
        });

        const result = await pipeline.processDocument(documentId);

        logAudit({
          action: 'vlm_process',
          entityType: 'document',
          entityId: documentId,
          details: { total: result.total, successful: result.successful, failed: result.failed, total_tokens: result.totalTokens },
        });

        const responseData: Record<string, unknown> = {
          mode: 'document',
          document_id: documentId,
          total: result.total,
          successful: result.successful,
          failed: result.failed,
          total_tokens: result.totalTokens,
          processing_time_ms: result.totalTimeMs,
          results: result.results.map((r) => ({
            image_id: r.imageId,
            success: r.success,
            confidence: r.confidence,
            tokens_used: r.tokensUsed,
            error: r.error,
          })),
          next_steps: [
            { tool: 'ocr_image_list', description: 'Browse all images for this document' },
            { tool: 'ocr_vlm_status', description: 'Check VLM service health' },
          ],
        };

        return formatResponse(successResult(responseData));
      } else {
        // All pending mode
        const pipeline = new VLMPipeline(conn, {
          config: {
            batchSize,
            concurrency: 5,
            minConfidence: 0.5,
            skipEmbeddings: false,
            skipProvenance: false,
          },
          dbService: db,
          vectorService: vector,
        });

        const result = await pipeline.processPending(limit);

        logAudit({
          action: 'vlm_process_pending',
          entityType: 'image',
          details: { processed: result.total, successful: result.successful, failed: result.failed, total_tokens: result.totalTokens },
        });

        const responseData: Record<string, unknown> = {
          mode: 'pending',
          processed: result.total,
          successful: result.successful,
          failed: result.failed,
          total_tokens: result.totalTokens,
          processing_time_ms: result.totalTimeMs,
          next_steps: [
            { tool: 'ocr_document_list', description: 'Browse all documents in the database' },
            { tool: 'ocr_vlm_status', description: 'Check VLM service health' },
          ],
        };

        return formatResponse(successResult(responseData));
      }
    }); // end withDatabaseOperation
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_analyze_pdf - Analyze a PDF document directly with Gemini 3
 */
export async function handleVLMAnalyzePDF(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMAnalyzePDFInput, params);
    const pdfPath = sanitizePath(input.pdf_path);
    const prompt = input.prompt;

    // Validate PDF path exists
    if (!fs.existsSync(pdfPath)) {
      throw new MCPError('PATH_NOT_FOUND', `PDF file not found: ${pdfPath}`, { pdf_path: pdfPath });
    }

    // Check file size (max 20MB for Gemini)
    const stats = fs.statSync(pdfPath);
    if (stats.size > 20 * 1024 * 1024) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `PDF file exceeds 20MB Gemini limit: ${(stats.size / 1024 / 1024).toFixed(2)}MB`,
        { pdf_path: pdfPath, size_mb: stats.size / 1024 / 1024 }
      );
    }

    const client = getSharedClient();
    const fileRef = GeminiClient.fileRefFromPath(pdfPath);

    const defaultPrompt = `Analyze this legal/medical document. Provide:
1. Document type and purpose
2. Key information (names, dates, identifiers)
3. Summary of content
4. Any notable findings

Return as JSON with fields: documentType, summary, keyDates, keyNames, findings`;

    const response = await client.analyzePDF(prompt || defaultPrompt, fileRef);

    logAudit({
      action: 'vlm_analyze_pdf',
      entityType: 'document',
      entityId: pdfPath,
      details: { model: response.model, tokens_used: response.usage.totalTokens },
    });

    return formatResponse(
      successResult({
        pdf_path: pdfPath,
        analysis: response.text,
        model: response.model,
        processing_time_ms: response.processingTimeMs,
        tokens_used: response.usage.totalTokens,
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        next_steps: [
          {
            tool: 'ocr_ingest_files',
            description: 'Ingest the PDF for full OCR pipeline processing',
          },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_status - Get VLM service status and statistics
 */
export async function handleVLMStatus(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    validateInput(VLMStatusInput, params);
    const vlm = getVLMService();
    const status = vlm.getStatus();

    // Check if GEMINI_API_KEY is configured
    const apiKeyConfigured = !!process.env.GEMINI_API_KEY?.trim();

    return formatResponse(
      successResult({
        api_key_configured: apiKeyConfigured,
        model: status.model,
        rate_limiter: {
          requests_remaining: status.rateLimiter.requestsRemaining,
          tokens_remaining: status.rateLimiter.tokensRemaining,
          reset_in_ms: status.rateLimiter.resetInMs,
        },
        circuit_breaker: {
          state: status.circuitBreaker.state,
          failure_count: status.circuitBreaker.failureCount,
          time_to_recovery: status.circuitBreaker.timeToRecovery,
        },
        next_steps: [
          { tool: 'ocr_vlm_process', description: 'Process pending VLM images' },
          { tool: 'ocr_image_pending', description: 'List images awaiting VLM processing' },
          { tool: 'ocr_vlm_analyze_pdf', description: 'Analyze a PDF directly with Gemini AI' },
        ],
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
 * VLM tools collection for MCP server registration
 */
export const vlmTools: Record<string, ToolDefinition> = {
  ocr_vlm_describe: {
    description:
      '[PROCESSING] Use to generate a detailed AI description of a single image file. Returns multi-paragraph description with optional embedding. Requires GEMINI_API_KEY.',
    inputSchema: {
      image_path: z.string().min(1).describe('Path to image file (PNG, JPG, JPEG, GIF, WEBP)'),
      context_text: z.string().optional().describe('Surrounding text context from document'),
      use_thinking: z
        .boolean()
        .default(false)
        .describe('Use extended reasoning (thinking mode) for complex analysis'),
    },
    handler: handleVLMDescribe,
  },

  ocr_vlm_process: {
    description:
      '[PROCESSING] Use to run VLM analysis on document images. Pass document_id for one document, omit for all pending. Requires GEMINI_API_KEY.',
    inputSchema: {
      document_id: z.string().optional().describe('Document ID (omit to process all pending)'),
      batch_size: z.number().int().min(1).max(20).default(5).describe('Images per batch'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('Maximum images to process (pending mode only)'),
    },
    handler: handleVLMProcess,
  },

  ocr_vlm_analyze_pdf: {
    description:
      '[PROCESSING] Use to analyze a PDF directly with Gemini 3 multimodal AI (max 20MB). Returns AI analysis with optional custom prompt. No database needed.',
    inputSchema: {
      pdf_path: z.string().min(1).describe('Path to PDF file'),
      prompt: z
        .string()
        .optional()
        .describe('Custom analysis prompt (default: general legal/medical analysis)'),
    },
    handler: handleVLMAnalyzePDF,
  },

  ocr_vlm_status: {
    description:
      '[STATUS] Use to check VLM service health (API config, rate limits, circuit breaker state). Returns service status. Use to diagnose VLM failures.',
    inputSchema: {},
    handler: handleVLMStatus,
  },
};
