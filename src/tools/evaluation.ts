/**
 * VLM Evaluation MCP Tools
 *
 * Tools for evaluating VLM (Gemini) performance on image analysis.
 * Uses the universal evaluation prompt with NO CONTEXT for consistent testing.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/evaluation
 */

import { z } from 'zod';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { GeminiClient, getSharedClient } from '../services/gemini/client.js';
import {
  UNIVERSAL_EVALUATION_PROMPT,
  UNIVERSAL_EVALUATION_SCHEMA,
} from '../services/vlm/prompts.js';
import {
  getImage,
  getPendingImages,
  getImagesByDocument,
  setImageProcessing,
  updateImageVLMResult,
  setImageVLMFailed,
  getImageStats,
} from '../services/storage/database/image-operations.js';
import { getEmbeddingClient, MODEL_NAME as EMBEDDING_MODEL } from '../services/embedding/nomic.js';
import { computeHash } from '../utils/hash.js';
import type { VLMResult } from '../models/image.js';
import { ProvenanceType } from '../models/provenance.js';
import type { ProvenanceRecord } from '../models/provenance.js';

// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const EvaluateInput = z.object({
  image_id: z.string().optional(),
  document_id: z.string().optional(),
  save_to_db: z.boolean().default(true),
  reference_text: z.string().optional(),
  batch_size: z.number().int().min(1).max(50).default(10),
  limit: z.number().int().min(1).max(500).default(100),
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATION TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Internal handler for evaluating a single image with universal prompt (NO CONTEXT)
 */
async function evaluateSingleImage(imageId: string, saveToDb: boolean): Promise<ToolResponse> {
  try {
    const { db, vector } = requireDatabase();

    // Get image record
    const image = getImage(db.getConnection(), imageId);
    if (!image) {
      throw new MCPError('VALIDATION_ERROR', `Image not found: ${imageId}`, { image_id: imageId });
    }

    // Validate image file exists
    if (!image.extracted_path || !fs.existsSync(image.extracted_path)) {
      throw new MCPError('PATH_NOT_FOUND', `Image file not found: ${image.extracted_path}`, {
        image_id: imageId,
        path: image.extracted_path,
      });
    }

    console.error(`[INFO] Evaluating image: ${imageId} (${image.extracted_path})`);

    // Mark as processing
    if (saveToDb) {
      setImageProcessing(db.getConnection(), imageId);
    }

    const startTime = Date.now();

    try {
      // Use shared Gemini client (singleton) for rate limiter/config reuse
      const client = getSharedClient();
      const fileRef = GeminiClient.fileRefFromPath(image.extracted_path);

      const response = await client.analyzeImage(UNIVERSAL_EVALUATION_PROMPT, fileRef, {
        schema: UNIVERSAL_EVALUATION_SCHEMA,
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
      });

      // Parse the response
      const analysis = parseEvaluationResponse(response.text);
      const processingTimeMs = Date.now() - startTime;

      // Build description from paragraphs
      const description = [analysis.paragraph1, analysis.paragraph2, analysis.paragraph3]
        .filter(Boolean)
        .join('\n\n');

      // Generate embedding for the description
      let embeddingId: string | null = null;
      if (saveToDb && description) {
        embeddingId = await generateAndStoreEmbedding(db, vector, description, image);
      }

      // Build VLM result
      const vlmResult: VLMResult = {
        description,
        structuredData: {
          imageType: analysis.imageType,
          primarySubject: analysis.primarySubject,
          extractedText: analysis.extractedText,
          dates: analysis.dates,
          names: analysis.names,
          numbers: analysis.numbers,
          paragraph1: analysis.paragraph1,
          paragraph2: analysis.paragraph2,
          paragraph3: analysis.paragraph3,
        },
        embeddingId: embeddingId || '',
        model: response.model,
        confidence: analysis.confidence,
        tokensUsed: response.usage.totalTokens,
      };

      // Save to database
      if (saveToDb) {
        updateImageVLMResult(db.getConnection(), imageId, vlmResult);
      }

      console.error(
        `[INFO] Evaluation complete: confidence=${analysis.confidence}, tokens=${response.usage.totalTokens}`
      );

      return formatResponse(
        successResult({
          image_id: imageId,
          success: true,
          image_type: analysis.imageType,
          primary_subject: analysis.primarySubject,
          description,
          confidence: analysis.confidence,
          tokens_used: response.usage.totalTokens,
          processing_time_ms: processingTimeMs,
          model: response.model,
          embedding_id: embeddingId,
          extracted_data: {
            text_count: analysis.extractedText.length,
            dates_count: analysis.dates.length,
            names_count: analysis.names.length,
            numbers_count: analysis.numbers.length,
          },
          next_steps: [
            { tool: 'ocr_image_get', description: 'View the evaluated image details' },
            {
              tool: 'ocr_evaluate',
              description: 'Evaluate more images (pass document_id or omit for all pending)',
            },
          ],
        })
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (saveToDb) {
        setImageVLMFailed(db.getConnection(), imageId, errorMsg);
      }
      throw error;
    }
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Internal handler for evaluating all images in a document
 */
async function evaluateDocument(documentId: string, batchSize: number): Promise<ToolResponse> {
  try {
    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`, {
        document_id: documentId,
      });
    }

    // Get all pending images for this document, excluding header/footer decorative images
    const images = getImagesByDocument(db.getConnection(), documentId);
    const pendingImages = images.filter(
      (img) => img.vlm_status === 'pending' && !img.is_header_footer
    );

    if (pendingImages.length === 0) {
      return formatResponse(
        successResult({
          document_id: documentId,
          file_name: doc.file_name,
          total_images: images.length,
          pending: 0,
          processed: images.filter((i) => i.vlm_status === 'complete').length,
          failed: images.filter((i) => i.vlm_status === 'failed').length,
          message: 'No pending images to evaluate',
          next_steps: [
            { tool: 'ocr_evaluation_report', description: 'Generate a full evaluation report' },
            {
              tool: 'ocr_evaluate',
              description: 'Evaluate remaining images (omit params for all pending)',
            },
          ],
        })
      );
    }

    console.error(
      `[INFO] Evaluating ${pendingImages.length} images for document: ${doc.file_name}`
    );

    const results: Array<{
      image_id: string;
      success: boolean;
      confidence?: number;
      tokens_used?: number;
      error?: string;
    }> = [];

    let totalTokens = 0;
    const startTime = Date.now();

    // Process images sequentially to avoid thundering herd on Gemini API.
    // Each image is processed one at a time, matching the VLMPipeline pattern.
    for (let i = 0; i < pendingImages.length; i += batchSize) {
      const batch = pendingImages.slice(i, i + batchSize);
      let batchSuccessful = 0;

      for (const img of batch) {
        try {
          const result = await evaluateSingleImage(img.id, true);

          // Parse result
          if (!result.content || result.content.length === 0) {
            throw new Error('Gemini returned empty content for image evaluation');
          }
          const data = JSON.parse(result.content[0].text);
          if (data.success && data.data) {
            results.push({
              image_id: img.id,
              success: true,
              confidence: data.data.confidence,
              tokens_used: data.data.tokens_used,
            });
            totalTokens += data.data.tokens_used || 0;
            batchSuccessful++;
          } else {
            results.push({
              image_id: img.id,
              success: false,
              error: data.error?.message || 'Unknown error',
            });
          }
        } catch (error) {
          results.push({
            image_id: img.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      console.error(
        `[INFO] Batch ${Math.floor(i / batchSize) + 1} complete: ${batchSuccessful}/${batch.length} successful`
      );
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const avgConfidence = results
      .filter((r) => r.success && r.confidence)
      .reduce((sum, r, _, arr) => sum + (r.confidence || 0) / arr.length, 0);

    return formatResponse(
      successResult({
        document_id: documentId,
        file_name: doc.file_name,
        total_images: images.length,
        evaluated: results.length,
        successful,
        failed,
        total_tokens: totalTokens,
        processing_time_ms: Date.now() - startTime,
        average_confidence: avgConfidence,
        total_processed: results.length,
        total_failed: results.filter(r => !r.success).length,
        results, // M-13: Return ALL results - truncation hides failures beyond cutoff
        next_steps: [
          { tool: 'ocr_evaluation_report', description: 'Generate a full evaluation report' },
          {
            tool: 'ocr_evaluate',
            description: 'Evaluate remaining images (omit params for all pending)',
          },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Internal handler for evaluating all pending images across all documents
 */
async function evaluatePending(limit: number, batchSize: number): Promise<ToolResponse> {
  try {
    const { db } = requireDatabase();

    // Get pending images
    const pendingImages = getPendingImages(db.getConnection(), limit);

    if (pendingImages.length === 0) {
      const stats = getImageStats(db.getConnection());
      return formatResponse(
        successResult({
          processed: 0,
          stats,
          message: 'No pending images to evaluate',
          next_steps: [
            {
              tool: 'ocr_evaluation_report',
              description: 'Generate a comprehensive evaluation report',
            },
            { tool: 'ocr_image_stats', description: 'Check image processing statistics' },
          ],
        })
      );
    }

    console.error(`[INFO] Evaluating ${pendingImages.length} pending images`);

    const results: Array<{
      image_id: string;
      document_id: string;
      success: boolean;
      confidence?: number;
      error?: string;
    }> = [];

    let totalTokens = 0;
    const startTime = Date.now();

    // Process in batches
    for (let i = 0; i < pendingImages.length; i += batchSize) {
      const batch = pendingImages.slice(i, i + batchSize);

      for (const img of batch) {
        try {
          const result = await evaluateSingleImage(img.id, true);

          const data = JSON.parse(result.content[0].text);
          if (data.success && data.data) {
            results.push({
              image_id: img.id,
              document_id: img.document_id,
              success: true,
              confidence: data.data.confidence,
            });
            totalTokens += data.data.tokens_used || 0;
          } else {
            results.push({
              image_id: img.id,
              document_id: img.document_id,
              success: false,
              error: data.error?.message,
            });
          }
        } catch (error) {
          results.push({
            image_id: img.id,
            document_id: img.document_id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const batchSuccessful = results.slice(-batch.length).filter((r) => r.success).length;
      console.error(
        `[INFO] Processed ${i + batch.length}/${pendingImages.length} images (${batchSuccessful}/${batch.length} successful)`
      );
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const stats = getImageStats(db.getConnection());

    return formatResponse(
      successResult({
        processed: results.length,
        successful,
        failed,
        total_tokens: totalTokens,
        processing_time_ms: Date.now() - startTime,
        stats,
        next_steps: [
          {
            tool: 'ocr_evaluation_report',
            description: 'Generate a comprehensive evaluation report',
          },
          { tool: 'ocr_image_stats', description: 'Check image processing statistics' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED EVALUATION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_evaluate - Unified evaluation dispatcher
 *
 * If image_id provided: evaluate single image
 * If document_id provided: evaluate all images in document
 * If neither: evaluate all pending images
 */
export async function handleEvaluate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(EvaluateInput, params);

    if (input.image_id) {
      return evaluateSingleImage(input.image_id, input.save_to_db ?? true);
    } else if (input.document_id) {
      return evaluateDocument(input.document_id, input.batch_size ?? 10);
    } else {
      return evaluatePending(input.limit ?? 100, input.batch_size ?? 10);
    }
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

interface EvaluationAnalysis {
  imageType: string;
  primarySubject: string;
  paragraph1: string;
  paragraph2: string;
  paragraph3: string;
  extractedText: string[];
  dates: string[];
  names: string[];
  numbers: string[];
  confidence: number;
}

function parseEvaluationResponse(text: string): EvaluationAnalysis {
  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean) as Partial<EvaluationAnalysis>;

    return {
      imageType: parsed.imageType || 'other',
      primarySubject: parsed.primarySubject || '',
      paragraph1: parsed.paragraph1 || '',
      paragraph2: parsed.paragraph2 || '',
      paragraph3: parsed.paragraph3 || '',
      extractedText: parsed.extractedText || [],
      dates: parsed.dates || [],
      names: parsed.names || [],
      numbers: parsed.numbers || [],
      confidence: parsed.confidence ?? 0.5,
    };
  } catch (error) {
    throw new Error(`Failed to parse VLM analysis response as JSON. Raw response (first 500 chars): ${text.slice(0, 500)}. Parse error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function generateAndStoreEmbedding(
  db: ReturnType<typeof requireDatabase>['db'],
  vector: ReturnType<typeof requireDatabase>['vector'],
  description: string,
  image: {
    id: string;
    document_id: string;
    page_number: number;
    image_index: number;
    extracted_path: string | null;
    provenance_id: string | null;
  }
): Promise<string> {
  const embeddingClient = getEmbeddingClient();
  const vectors = await embeddingClient.embedChunks([description], 1);

  if (vectors.length === 0) {
    throw new Error('Embedding generation returned empty result');
  }

  const embeddingId = uuidv4();
  const now = new Date().toISOString();
  const descriptionHash = computeHash(description);

  // Step 1: Get IMAGE provenance to build chain
  if (!image.provenance_id) {
    throw new Error(
      `Image ${image.id} has no provenance_id — cannot create VLM_DESCRIPTION provenance`
    );
  }

  const imageProv = db.getProvenance(image.provenance_id);
  if (!imageProv) {
    throw new Error(
      `Image provenance not found: ${image.provenance_id} — provenance chain is broken`
    );
  }

  // Step 2: Create VLM_DESCRIPTION provenance (depth 3)
  const vlmDescProvId = uuidv4();
  const imageParentIds = JSON.parse(imageProv.parent_ids) as string[];
  const vlmParentIds = [...imageParentIds, image.provenance_id];

  const vlmDescProv: ProvenanceRecord = {
    id: vlmDescProvId,
    type: ProvenanceType.VLM_DESCRIPTION,
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'VLM',
    source_path: image.extracted_path,
    source_id: image.provenance_id,
    root_document_id: imageProv.root_document_id,
    location: {
      page_number: image.page_number,
      chunk_index: image.image_index,
    },
    content_hash: descriptionHash,
    input_hash: imageProv.content_hash,
    file_hash: imageProv.file_hash,
    processor: 'gemini-vlm:universal-evaluation',
    processor_version: '3.0',
    processing_params: {
      type: 'vlm_description',
      prompt: 'UNIVERSAL_EVALUATION_PROMPT',
    },
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: image.provenance_id,
    parent_ids: JSON.stringify(vlmParentIds),
    chain_depth: 3,
    chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION']),
  };

  db.insertProvenance(vlmDescProv);

  // Step 3: Create EMBEDDING provenance (depth 4)
  const embeddingProvId = uuidv4();
  const embeddingParentIds = [...vlmParentIds, vlmDescProvId];

  const embeddingProv: ProvenanceRecord = {
    id: embeddingProvId,
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
      page_number: image.page_number,
      chunk_index: image.image_index,
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
    parent_ids: JSON.stringify(embeddingParentIds),
    chain_depth: 4,
    chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING']),
  };

  db.insertProvenance(embeddingProv);

  // Step 4: Store embedding record with EMBEDDING provenance ID
  db.insertEmbedding({
    id: embeddingId,
    chunk_id: null,
    image_id: image.id,
    extraction_id: null,
    document_id: image.document_id,
    original_text: description,
    original_text_length: description.length,
    source_file_path: image.extracted_path ?? 'unknown',
    source_file_name: image.extracted_path?.split('/').pop() ?? 'vlm_description',
    source_file_hash: 'vlm_generated',
    page_number: image.page_number,
    page_range: null,
    character_start: 0,
    character_end: description.length,
    chunk_index: image.image_index,
    total_chunks: 1,
    model_name: EMBEDDING_MODEL,
    model_version: '1.5.0',
    task_type: 'search_document',
    inference_mode: 'local',
    gpu_device: 'cuda:0',
    provenance_id: embeddingProvId,
    content_hash: descriptionHash,
    generation_duration_ms: null,
  });

  // Step 5: Store vector
  vector.storeVector(embeddingId, vectors[0]);

  console.error(
    `[INFO] Provenance chain created: IMAGE(${image.provenance_id}) → VLM_DESC(${vlmDescProvId}) → EMBED(${embeddingProvId})`
  );

  return embeddingId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluation tools collection for MCP server registration
 */
export const evaluationTools: Record<string, ToolDefinition> = {
  ocr_evaluate: {
    description:
      '[STATUS] Use to evaluate VLM description quality. Pass image_id for one image, document_id for all in a document, or neither for all pending.',
    inputSchema: {
      image_id: z.string().optional().describe('Image ID (single image evaluation)'),
      document_id: z.string().optional().describe('Document ID (evaluate all images in document)'),
      save_to_db: z
        .boolean()
        .default(true)
        .describe('Save results to database (single image mode)'),
      reference_text: z
        .string()
        .optional()
        .describe('Reference text for comparison (single image mode)'),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Images per batch (document/pending mode)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Maximum images to process (pending mode)'),
    },
    handler: handleEvaluate,
  },
};
