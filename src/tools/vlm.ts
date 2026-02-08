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
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { getVLMService } from '../services/vlm/service.js';
import { VLMPipeline } from '../services/vlm/pipeline.js';
import { GeminiClient } from '../services/gemini/client.js';


// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const VLMDescribeInput = z.object({
  image_path: z.string().min(1),
  context_text: z.string().optional(),
  use_thinking: z.boolean().default(false),
});

const VLMClassifyInput = z.object({
  image_path: z.string().min(1),
});

const VLMProcessDocumentInput = z.object({
  document_id: z.string().min(1),
  batch_size: z.number().int().min(1).max(20).default(5),
});

const VLMProcessPendingInput = z.object({
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
 */
export async function handleVLMDescribe(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(VLMDescribeInput, params);
    const imagePath = input.image_path;
    const contextText = input.context_text;
    const useThinking = input.use_thinking ?? false;

    // Validate image path exists
    if (!fs.existsSync(imagePath)) {
      throw new MCPError(
        'PATH_NOT_FOUND',
        `Image file not found: ${imagePath}`,
        { image_path: imagePath }
      );
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

    const pipeline = new VLMPipeline(db.getConnection(), {
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

    return formatResponse(successResult({
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
    }));
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

    const pipeline = new VLMPipeline(db.getConnection(), {
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

    return formatResponse(successResult({
      processed: result.total,
      successful: result.successful,
      failed: result.failed,
      total_tokens: result.totalTokens,
      processing_time_ms: result.totalTimeMs,
    }));
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
    },
    handler: handleVLMProcessDocument,
  },

  'ocr_vlm_process_pending': {
    description: 'Process all images pending VLM description across all documents',
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(50).describe('Maximum images to process'),
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
