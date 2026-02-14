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
import { v4 as uuidv4 } from 'uuid';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { getVLMService } from '../services/vlm/service.js';
import { VLMPipeline } from '../services/vlm/pipeline.js';
import { GeminiClient } from '../services/gemini/client.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';
import { extractEntitiesFromVLM } from '../services/knowledge-graph/vlm-entity-extractor.js';


// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const VLMDescribeInput = z.object({
  image_path: z.string().min(1),
  context_text: z.string().optional(),
  use_thinking: z.boolean().default(false),
  enrich_with_entities: z.boolean().default(false),
});

const VLMClassifyInput = z.object({
  image_path: z.string().min(1),
});

const VLMProcessDocumentInput = z.object({
  document_id: z.string().min(1),
  batch_size: z.number().int().min(1).max(20).default(5),
  auto_extract_entities: z.boolean().default(false),
});

const VLMProcessPendingInput = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  auto_extract_entities: z.boolean().default(false),
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
 */
export async function handleVLMDescribe(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMDescribeInput, params);
    const imagePath = input.image_path;
    let contextText = input.context_text;
    const useThinking = input.use_thinking ?? false;
    const enrichWithEntities = input.enrich_with_entities ?? false;

    // Validate image path exists
    if (!fs.existsSync(imagePath)) {
      throw new MCPError(
        'PATH_NOT_FOUND',
        `Image file not found: ${imagePath}`,
        { image_path: imagePath }
      );
    }

    // Enrich context with known entities from the same page
    let entityContextProvided = false;
    if (enrichWithEntities) {
      try {
        const { db } = requireDatabase();
        const conn = db.getConnection();

        // Look up the image record by extracted_path to get document_id and page_number
        const imageRecord = conn.prepare(
          'SELECT document_id, page_number FROM images WHERE extracted_path = ? LIMIT 1'
        ).get(imagePath) as { document_id: string; page_number: number } | undefined;

        if (imageRecord) {
          const pageEntities = conn.prepare(`
            SELECT DISTINCT e.entity_type, e.normalized_text
            FROM entities e
            JOIN entity_mentions em ON e.id = em.entity_id
            WHERE em.document_id = ? AND em.page_number = ?
            ORDER BY e.confidence DESC
            LIMIT 20
          `).all(imageRecord.document_id, imageRecord.page_number) as Array<{ entity_type: string; normalized_text: string }>;

          if (pageEntities.length > 0) {
            const entitySummary = pageEntities
              .map(e => `${e.entity_type}: ${e.normalized_text}`)
              .join(', ');
            contextText = (contextText ?? '') + `\nKnown entities on this page: ${entitySummary}`;
            entityContextProvided = true;
          }
        }
      } catch (err) {
        console.error(`[WARN] Entity enrichment failed: ${(err as Error).message}`);
      }
    }

    const vlm = getVLMService();

    let result;
    if (useThinking) {
      // Use deep analysis with extended reasoning
      result = await vlm.analyzeDeep(imagePath);
    } else {
      result = await vlm.describeImage(imagePath, {
        contextText,
        highResolution: true,
      });
    }

    return formatResponse(successResult({
      description: result.description,
      analysis: result.analysis,
      model: result.model,
      processing_time_ms: result.processingTimeMs,
      tokens_used: result.tokensUsed,
      confidence: result.analysis.confidence,
      entity_context_provided: entityContextProvided,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_classify - Quick classification of an image
 */
export async function handleVLMClassify(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMClassifyInput, params);
    const imagePath = input.image_path;

    // Validate image path exists
    if (!fs.existsSync(imagePath)) {
      throw new MCPError(
        'PATH_NOT_FOUND',
        `Image file not found: ${imagePath}`,
        { image_path: imagePath }
      );
    }

    const vlm = getVLMService();
    const classification = await vlm.classifyImage(imagePath);

    return formatResponse(successResult({
      classification: {
        type: classification.type,
        has_text: classification.hasText,
        text_density: classification.textDensity,
        complexity: classification.complexity,
        confidence: classification.confidence,
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_process_document - Process all images in a document with Gemini 3 VLM
 */
export async function handleVLMProcessDocument(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMProcessDocumentInput, params);
    const documentId = input.document_id;
    const batchSize = input.batch_size ?? 5;

    const { db, vector } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError(
        'DOCUMENT_NOT_FOUND',
        `Document not found: ${documentId}`,
        { document_id: documentId }
      );
    }

    const conn = db.getConnection();
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

    // Auto-extract entities from VLM descriptions if requested
    let vlmEntityResult: { entities_created: number; descriptions_processed: number } | undefined;
    if (input.auto_extract_entities && result.successful > 0) {
      try {
        const now = new Date().toISOString();
        const entityProvId = uuidv4();
        const entityHash = computeHash(JSON.stringify({ document_id: documentId, source: 'vlm-auto' }));

        db.insertProvenance({
          id: entityProvId,
          type: ProvenanceType.ENTITY_EXTRACTION,
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'ENTITY_EXTRACTION',
          source_path: doc.file_path,
          source_id: doc.provenance_id,
          root_document_id: doc.provenance_id,
          location: null,
          content_hash: entityHash,
          input_hash: computeHash(documentId),
          file_hash: doc.file_hash,
          processor: 'vlm-auto-entity-extraction',
          processor_version: '1.0.0',
          processing_params: { auto_extract: true },
          processing_duration_ms: null,
          processing_quality_score: null,
          parent_id: doc.provenance_id,
          parent_ids: JSON.stringify([doc.provenance_id]),
          chain_depth: 2,
          chain_path: JSON.stringify(['DOCUMENT', 'VLM_DESC', 'ENTITY_EXTRACTION']),
        });

        vlmEntityResult = await extractEntitiesFromVLM(conn, documentId, entityProvId);
      } catch (err) {
        console.error(`[WARN] VLM entity extraction failed: ${(err as Error).message}`);
      }
    }

    const responseData: Record<string, unknown> = {
      document_id: documentId,
      total: result.total,
      successful: result.successful,
      failed: result.failed,
      total_tokens: result.totalTokens,
      processing_time_ms: result.totalTimeMs,
      results: result.results.map(r => ({
        image_id: r.imageId,
        success: r.success,
        confidence: r.confidence,
        tokens_used: r.tokensUsed,
        error: r.error,
      })),
    };

    if (vlmEntityResult) {
      responseData.vlm_entity_extraction = {
        entities_created: vlmEntityResult.entities_created,
        descriptions_processed: vlmEntityResult.descriptions_processed,
      };
    }

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_process_pending - Process all images pending VLM description
 */
export async function handleVLMProcessPending(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMProcessPendingInput, params);
    const limit = input.limit ?? 50;

    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    const pipeline = new VLMPipeline(conn, {
      config: {
        batchSize: 10,
        concurrency: 5,
        minConfidence: 0.5,
        skipEmbeddings: false,
        skipProvenance: false,
      },
      dbService: db,
      vectorService: vector,
    });

    const result = await pipeline.processPending(limit);

    // Auto-extract entities from VLM descriptions if requested
    const vlmEntityResults: Array<{ document_id: string; entities_created: number; descriptions_processed: number }> = [];
    if (input.auto_extract_entities && result.successful > 0) {
      try {
        // Find distinct document IDs from successfully processed images
        const successfulImageIds = result.results
          .filter(r => r.success)
          .map(r => r.imageId);

        if (successfulImageIds.length > 0) {
          const placeholders = successfulImageIds.map(() => '?').join(',');
          const documentIds = conn.prepare(
            `SELECT DISTINCT document_id FROM images WHERE id IN (${placeholders})`
          ).all(...successfulImageIds) as Array<{ document_id: string }>;

          for (const { document_id: docId } of documentIds) {
            try {
              const doc = db.getDocument(docId);
              if (!doc) continue;

              const now = new Date().toISOString();
              const entityProvId = uuidv4();
              const entityHash = computeHash(JSON.stringify({ document_id: docId, source: 'vlm-auto-pending' }));

              db.insertProvenance({
                id: entityProvId,
                type: ProvenanceType.ENTITY_EXTRACTION,
                created_at: now,
                processed_at: now,
                source_file_created_at: null,
                source_file_modified_at: null,
                source_type: 'ENTITY_EXTRACTION',
                source_path: doc.file_path,
                source_id: doc.provenance_id,
                root_document_id: doc.provenance_id,
                location: null,
                content_hash: entityHash,
                input_hash: computeHash(docId),
                file_hash: doc.file_hash,
                processor: 'vlm-auto-entity-extraction',
                processor_version: '1.0.0',
                processing_params: { auto_extract: true, source: 'process_pending' },
                processing_duration_ms: null,
                processing_quality_score: null,
                parent_id: doc.provenance_id,
                parent_ids: JSON.stringify([doc.provenance_id]),
                chain_depth: 2,
                chain_path: JSON.stringify(['DOCUMENT', 'VLM_DESC', 'ENTITY_EXTRACTION']),
              });

              const vlmResult = await extractEntitiesFromVLM(conn, docId, entityProvId);
              vlmEntityResults.push({
                document_id: docId,
                entities_created: vlmResult.entities_created,
                descriptions_processed: vlmResult.descriptions_processed,
              });
            } catch (err) {
              console.error(`[WARN] VLM entity extraction failed for document ${docId}: ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        console.error(`[WARN] VLM entity extraction failed: ${(err as Error).message}`);
      }
    }

    const responseData: Record<string, unknown> = {
      processed: result.total,
      successful: result.successful,
      failed: result.failed,
      total_tokens: result.totalTokens,
      processing_time_ms: result.totalTimeMs,
    };

    if (vlmEntityResults.length > 0) {
      responseData.vlm_entity_extraction = vlmEntityResults;
    }

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_analyze_pdf - Analyze a PDF document directly with Gemini 3
 */
export async function handleVLMAnalyzePDF(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMAnalyzePDFInput, params);
    const pdfPath = input.pdf_path;
    const prompt = input.prompt;

    // Validate PDF path exists
    if (!fs.existsSync(pdfPath)) {
      throw new MCPError(
        'PATH_NOT_FOUND',
        `PDF file not found: ${pdfPath}`,
        { pdf_path: pdfPath }
      );
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

    const client = new GeminiClient();
    const fileRef = GeminiClient.fileRefFromPath(pdfPath);

    const defaultPrompt = `Analyze this legal/medical document. Provide:
1. Document type and purpose
2. Key information (names, dates, identifiers)
3. Summary of content
4. Any notable findings

Return as JSON with fields: documentType, summary, keyDates, keyNames, findings`;

    const response = await client.analyzePDF(prompt || defaultPrompt, fileRef);

    return formatResponse(successResult({
      pdf_path: pdfPath,
      analysis: response.text,
      model: response.model,
      processing_time_ms: response.processingTimeMs,
      tokens_used: response.usage.totalTokens,
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_vlm_status - Get VLM service status and statistics
 */
export async function handleVLMStatus(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    validateInput(VLMStatusInput, params);
    const vlm = getVLMService();
    const status = vlm.getStatus();

    // Check if GEMINI_API_KEY is configured
    const apiKeyConfigured = !!process.env.GEMINI_API_KEY;

    return formatResponse(successResult({
      api_key_configured: apiKeyConfigured,
      model: status.model,
      tier: status.tier,
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
    }));
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
  'ocr_vlm_describe': {
    description: 'Generate detailed description of an image using Gemini 3 multimodal analysis',
    inputSchema: {
      image_path: z.string().min(1).describe('Path to image file (PNG, JPG, JPEG, GIF, WEBP)'),
      context_text: z.string().optional().describe('Surrounding text context from document'),
      use_thinking: z.boolean().default(false).describe('Use extended reasoning (thinking mode) for complex analysis'),
      enrich_with_entities: z.boolean().default(false).describe('Enrich VLM context with known entities from the same page'),
    },
    handler: handleVLMDescribe,
  },

  'ocr_vlm_classify': {
    description: 'Quick classification of an image (type, complexity, text density)',
    inputSchema: {
      image_path: z.string().min(1).describe('Path to image file'),
    },
    handler: handleVLMClassify,
  },

  'ocr_vlm_process_document': {
    description: 'Process all extracted images in a document with Gemini 3 VLM, generating descriptions and embeddings',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      batch_size: z.number().int().min(1).max(20).default(5).describe('Images per batch'),
      auto_extract_entities: z.boolean().default(false).describe('Auto-extract entities from VLM descriptions after processing'),
    },
    handler: handleVLMProcessDocument,
  },

  'ocr_vlm_process_pending': {
    description: 'Process all images pending VLM description across all documents',
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(50).describe('Maximum images to process'),
      auto_extract_entities: z.boolean().default(false).describe('Auto-extract entities from VLM descriptions after processing'),
    },
    handler: handleVLMProcessPending,
  },

  'ocr_vlm_analyze_pdf': {
    description: 'Analyze a PDF document directly with Gemini 3 (max 20MB)',
    inputSchema: {
      pdf_path: z.string().min(1).describe('Path to PDF file'),
      prompt: z.string().optional().describe('Custom analysis prompt (default: general legal/medical analysis)'),
    },
    handler: handleVLMAnalyzePDF,
  },

  'ocr_vlm_status': {
    description: 'Get VLM service status including API configuration, rate limits, and circuit breaker state',
    inputSchema: {},
    handler: handleVLMStatus,
  },
};
