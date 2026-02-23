/**
 * VLM Pipeline - Batch Image Processing with Embedding Integration
 *
 * Orchestrates the full VLM processing pipeline:
 * 1. Fetch pending images from database
 * 2. Analyze with Gemini VLM
 * 3. Generate embeddings for descriptions
 * 4. Track provenance
 * 5. Update database records
 *
 * @module services/vlm/pipeline
 */

import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

import {
  VLMService,
  getVLMService,
  type VLMAnalysisResult,
  type ImageAnalysis,
} from './service.js';
import {
  getImage,
  getImagesByDocument,
  getPendingImages,
  setImageProcessing,
  updateImageVLMResult,
  setImageVLMFailed,
  setImageVLMSkipped,
  getImageStats,
  findByContentHash,
  copyVLMResult,
  resetProcessingImages,
} from '../storage/database/image-operations.js';
import {
  NomicEmbeddingClient,
  getEmbeddingClient,
  MODEL_NAME as EMBEDDING_MODEL,
} from '../embedding/nomic.js';
import { DatabaseService } from '../storage/database/index.js';
import { VectorService } from '../storage/vector.js';
import { computeHash } from '../../utils/hash.js';
import type { ImageReference, VLMResult, VLMStructuredData } from '../../models/image.js';
import { ProvenanceType, type ProvenanceRecord } from '../../models/provenance.js';
import { ImageOptimizer, getImageOptimizer } from '../images/optimizer.js';
import type { ImageOptimizationConfig } from '../../server/types.js';

/**
 * Pipeline configuration options
 */
export interface PipelineConfig {
  /** Number of images per processing batch */
  batchSize: number;
  /** Max concurrent VLM requests */
  concurrency: number;
  /** Minimum confidence threshold */
  minConfidence: number;
  /** Use universal blind-person-detail prompt for all images (default: true) */
  useUniversalPrompt: boolean;
  /** Skip embedding generation */
  skipEmbeddings: boolean;
  /** Skip provenance tracking */
  skipProvenance: boolean;
  /** Image optimization settings */
  imageOptimization: ImageOptimizationConfig;
}

const DEFAULT_CONFIG: PipelineConfig = {
  batchSize: 10,
  concurrency: 5,
  minConfidence: 0.5,
  useUniversalPrompt: true,
  skipEmbeddings: false,
  skipProvenance: false,
  imageOptimization: {
    enabled: true,
    ocrMaxWidth: 4800,
    vlmMaxDimension: 2048,
    vlmSkipBelowSize: 50,
    vlmMinRelevance: 0.3,
    vlmSkipLogosIcons: true,
  },
};

/**
 * Result of processing a single image
 */
export interface ProcessingResult {
  imageId: string;
  success: boolean;
  description?: string;
  embeddingId?: string;
  tokensUsed?: number;
  confidence?: number;
  error?: string;
  processingTimeMs: number;
}

/**
 * Summary of batch processing
 */
export interface BatchResult {
  total: number;
  successful: number;
  failed: number;
  /** Images skipped due to relevance filtering (logos, icons, decorative) */
  skipped: number;
  totalTokens: number;
  totalTimeMs: number;
  results: ProcessingResult[];
}

/**
 * VLMPipeline - Orchestrates image processing workflow
 *
 * Integrates VLM analysis with:
 * - Database operations (image records)
 * - Embedding generation (Nomic)
 * - Vector storage (sqlite-vec)
 * - Provenance tracking
 * - Image relevance filtering (logos, icons, decorative elements)
 */
export class VLMPipeline {
  private readonly vlm: VLMService;
  private readonly embeddingClient: NomicEmbeddingClient;
  private readonly config: PipelineConfig;
  private readonly db: Database.Database;
  private readonly dbService: DatabaseService | null;
  private readonly vectorService: VectorService;
  private readonly optimizer: ImageOptimizer;

  constructor(
    db: Database.Database,
    options: {
      config?: Partial<PipelineConfig>;
      vlmService?: VLMService;
      embeddingClient?: NomicEmbeddingClient;
      dbService?: DatabaseService;
      vectorService: VectorService;
      optimizer?: ImageOptimizer;
    }
  ) {
    this.db = db;
    this.vlm = options.vlmService ?? getVLMService();
    this.embeddingClient = options.embeddingClient ?? getEmbeddingClient();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.dbService = options.dbService ?? null;
    this.vectorService = options.vectorService;
    this.optimizer =
      options.optimizer ??
      getImageOptimizer({
        vlmMaxDimension: this.config.imageOptimization.vlmMaxDimension,
        vlmSkipBelowSize: this.config.imageOptimization.vlmSkipBelowSize,
        minRelevanceScore: this.config.imageOptimization.vlmMinRelevance,
      });
  }

  /**
   * Process all images in a document.
   *
   * @param documentId - Document UUID
   * @returns BatchResult with processing summary
   */
  async processDocument(documentId: string): Promise<BatchResult> {
    // Reset any stuck 'processing' images back to pending (crash recovery)
    const stuckCount = resetProcessingImages(this.db, documentId);
    if (stuckCount > 0) {
      console.error(
        `[VLMPipeline] Reset ${stuckCount} stuck processing images for document ${documentId}`
      );
    }

    const pending = getImagesByDocument(this.db, documentId, { vlmStatus: 'pending' }).filter(
      (img) => !img.is_header_footer
    );

    if (pending.length === 0) {
      return {
        total: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        totalTokens: 0,
        totalTimeMs: 0,
        results: [],
      };
    }

    return this.processImages(pending);
  }

  /**
   * Process all pending images in the database.
   *
   * @param limit - Maximum images to process
   * @returns BatchResult with processing summary
   */
  async processPending(limit?: number): Promise<BatchResult> {
    const images = getPendingImages(this.db, limit ?? this.config.batchSize * 10).filter(
      (img) => !img.is_header_footer
    );
    return this.processImages(images);
  }

  /**
   * Process a single image by ID.
   *
   * @param imageId - Image UUID
   * @returns ProcessingResult
   */
  async processOne(imageId: string): Promise<ProcessingResult> {
    const image = getImage(this.db, imageId);

    if (!image) {
      return {
        imageId,
        success: false,
        error: 'Image not found',
        processingTimeMs: 0,
      };
    }

    const [result] = await this.processBatch([image]);
    return result;
  }

  /**
   * Process array of images in batches.
   */
  private async processImages(images: ImageReference[]): Promise<BatchResult> {
    const startTime = Date.now();
    const results: ProcessingResult[] = [];

    for (let i = 0; i < images.length; i += this.config.batchSize) {
      const batch = images.slice(i, i + this.config.batchSize);
      const batchResults = await this.processBatch(batch);
      results.push(...batchResults);
    }

    // Count successful (processed), skipped (relevance filtered), and failed
    const successful = results.filter((r) => r.success && r.description);
    const skipped = results.filter(
      (r) => r.success && !r.description && r.error?.startsWith('Skipped:')
    );
    const failed = results.filter((r) => !r.success);

    return {
      total: results.length,
      successful: successful.length,
      failed: failed.length,
      skipped: skipped.length,
      totalTokens: successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0),
      totalTimeMs: Date.now() - startTime,
      results,
    };
  }

  /**
   * Process a batch of images with rate limiting and exponential backoff.
   *
   * F-INTEG-9: Uses exponential backoff on 429/5xx errors (1s -> 2s -> 4s -> ... -> 32s max).
   * Aborts batch after 5 consecutive failures to avoid wasting resources.
   */
  private async processBatch(images: ImageReference[]): Promise<ProcessingResult[]> {
    const BASE_DELAY_MS = 100; // 100ms courtesy delay; rate limiter handles throttling (FIX-P0-2)
    const MAX_DELAY_MS = 32000; // 32 second max backoff
    const MAX_CONSECUTIVE_FAILURES = 5; // Abort batch after this many consecutive failures

    // Mark all as processing (returns false if image not in 'pending' state)
    const claimedImages: ImageReference[] = [];
    for (const img of images) {
      const claimed = setImageProcessing(this.db, img.id);
      if (!claimed) {
        console.error(`[WARN] Image ${img.id} is no longer pending, skipping`);
        continue;
      }
      claimedImages.push(img);
    }

    // Process SEQUENTIALLY with rate limiting (no concurrency)
    const results: ProcessingResult[] = [];
    let currentDelay = BASE_DELAY_MS;
    let consecutiveFailures = 0;

    for (let i = 0; i < claimedImages.length; i++) {
      const img = claimedImages[i];

      // Abort batch if too many consecutive failures (likely API outage)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[VLMPipeline] Aborting batch: ${MAX_CONSECUTIVE_FAILURES} consecutive failures. ` +
            `Processed ${results.length}/${claimedImages.length} images.`
        );
        // Mark remaining as failed so they can be retried later
        for (let j = i; j < claimedImages.length; j++) {
          try {
            setImageVLMFailed(
              this.db,
              claimedImages[j].id,
              'Batch aborted: too many consecutive failures'
            );
          } catch (error) {
            console.error(
              `[VLMPipeline] Failed to mark image ${claimedImages[j].id} as failed during batch abort: ${String(error)}`
            );
          }
          results.push({
            imageId: claimedImages[j].id,
            success: false,
            error: 'Batch aborted: too many consecutive failures',
            processingTimeMs: 0,
          });
        }
        break;
      }

      // Rate limit: wait between requests (skip for first request)
      if (i > 0) {
        console.error(
          `[VLMPipeline] Rate limiting: waiting ${currentDelay / 1000}s before next request...`
        );
        await new Promise((resolve) => setTimeout(resolve, currentDelay));
      }

      console.error(`[VLMPipeline] Processing image ${i + 1}/${claimedImages.length}: ${img.id}`);

      try {
        const result = await this.processImage(img);
        results.push(result);

        if (result.success) {
          console.error(
            `[VLMPipeline] Success: ${img.id} (confidence: ${result.confidence?.toFixed(2)})`
          );
          // Reset backoff on success
          currentDelay = BASE_DELAY_MS;
          consecutiveFailures = 0;
        } else {
          console.error(`[VLMPipeline] Failed: ${img.id} - ${result.error}`);
          consecutiveFailures++;
          // Apply exponential backoff on failure (likely 429 or 5xx)
          currentDelay = Math.min(currentDelay * 2, MAX_DELAY_MS);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[VLMPipeline] Error: ${img.id} - ${errorMessage}`);
        results.push({
          imageId: img.id,
          success: false,
          error: errorMessage,
          processingTimeMs: 0,
        });
        consecutiveFailures++;
        // Apply exponential backoff on error
        currentDelay = Math.min(currentDelay * 2, MAX_DELAY_MS);
      }
    }

    return results;
  }

  /**
   * Process a single image through the full pipeline.
   * Includes relevance filtering to skip logos, icons, and decorative elements.
   */
  private async processImage(image: ImageReference): Promise<ProcessingResult> {
    const start = Date.now();

    try {
      // Validate image has extracted file
      if (!image.extracted_path) {
        const error = 'No extracted image file';
        setImageVLMFailed(this.db, image.id, error);
        return {
          imageId: image.id,
          success: false,
          error,
          processingTimeMs: Date.now() - start,
        };
      }

      // Check image relevance if optimization enabled
      if (this.config.imageOptimization.enabled) {
        const shouldProcess = await this.checkImageRelevance(image);
        if (!shouldProcess.process) {
          const skipReason = `Skipped: ${shouldProcess.reason}`;
          console.error(`[VLMPipeline] ${skipReason} - ${image.id}`);

          // Dedup copies are already marked 'complete' by copyVLMResult — don't re-mark
          if (shouldProcess.dedupSource) {
            // Create VLM_DESCRIPTION provenance for the dedup copy
            this.trackDedupProvenance(image, shouldProcess.dedupSource);
          } else {
            // Mark as 'complete' (not 'failed') so retry_failed won't reprocess intentionally-skipped images
            setImageVLMSkipped(this.db, image.id, skipReason);
          }

          return {
            imageId: image.id,
            success: true, // Not a failure, intentionally skipped
            error: skipReason,
            processingTimeMs: Date.now() - start,
          };
        }
      }

      // Verify image file exists on disk before processing
      if (!existsSync(image.extracted_path)) {
        const error = `Image file not found on disk: ${image.extracted_path} (image_id: ${image.id}). The database record exists but the file has been deleted.`;
        setImageVLMFailed(this.db, image.id, error);
        return {
          imageId: image.id,
          success: false,
          error,
          processingTimeMs: Date.now() - start,
        };
      }

      // Optionally resize large images for VLM
      let imagePath = image.extracted_path;
      if (this.config.imageOptimization.enabled) {
        const resized = await this.maybeResizeForVLM(image);
        if (resized) {
          imagePath = resized;
        }
      }

      try {
        // Run VLM analysis
        const vlmResult = await this.vlm.describeImage(imagePath, {
          contextText: image.context_text ?? undefined,
          useUniversalPrompt: this.config.useUniversalPrompt,
        });

        // Check confidence threshold
        if (vlmResult.analysis.confidence < this.config.minConfidence) {
          console.error(
            `[VLMPipeline] Low confidence (${vlmResult.analysis.confidence}) for image ${image.id}`
          );
        }

        // Track VLM_DESCRIPTION provenance FIRST (returns provenance ID for embedding chain)
        let vlmProvId: string | undefined;
        if (!this.config.skipProvenance && this.dbService) {
          vlmProvId = this.trackProvenance(image, vlmResult);
        }

        // Generate embedding for description with VLM provenance ID
        // T2.10: Include VLM extracted text in embedding for FTS searchability
        let embeddingId: string | null = null;

        if (!this.config.skipEmbeddings && vlmResult.description) {
          let textForEmbedding = vlmResult.description;
          if (vlmResult.analysis?.extractedText?.length > 0) {
            textForEmbedding += '\n\nExtracted text: ' + vlmResult.analysis.extractedText.join(', ');
          }
          embeddingId = await this.generateAndStoreEmbedding(
            textForEmbedding,
            image,
            vlmProvId
          );
        }

        // Build VLM result for database
        const dbResult: VLMResult = {
          description: vlmResult.description,
          structuredData: this.convertToStructuredData(vlmResult.analysis),
          embeddingId: embeddingId || '',
          model: vlmResult.model,
          confidence: vlmResult.analysis.confidence,
          tokensUsed: vlmResult.tokensUsed,
        };

        // Update database record
        updateImageVLMResult(this.db, image.id, dbResult);

        return {
          imageId: image.id,
          success: true,
          description: vlmResult.description,
          embeddingId: embeddingId ?? undefined,
          tokensUsed: vlmResult.tokensUsed,
          confidence: vlmResult.analysis.confidence,
          processingTimeMs: Date.now() - start,
        };
      } finally {
        // Clean up temp resized file if it differs from the original
        if (imagePath !== image.extracted_path) {
          try {
            unlinkSync(imagePath);
          } catch (cleanupErr) {
            console.error(
              '[VLMPipeline] Failed to clean up temp resized file:',
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            );
            /* ignore cleanup errors */
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Mark as failed in database
      try {
        setImageVLMFailed(this.db, image.id, errorMessage);
      } catch (secondaryError) {
        console.error(
          '[VLMPipeline] Failed to mark image as failed:',
          image.id,
          secondaryError instanceof Error ? secondaryError.message : String(secondaryError)
        );
      }

      return {
        imageId: image.id,
        success: false,
        error: errorMessage,
        processingTimeMs: Date.now() - start,
      };
    }
  }

  /**
   * Check if an image should be processed by VLM based on relevance analysis.
   *
   * Uses multi-layer heuristics to filter out:
   * - Tiny images (likely icons)
   * - Extreme aspect ratios (likely banners/decorative)
   * - Low color diversity (likely logos)
   *
   * @param image - Image reference with dimensions
   * @returns Object with process flag and reason
   */
  private async checkImageRelevance(
    image: ImageReference
  ): Promise<{ process: boolean; reason: string; dedupSource?: ImageReference }> {
    const { imageOptimization } = this.config;

    // LAYER 1: Header/footer block classification (from Datalab JSON)
    if (image.is_header_footer) {
      return {
        process: false,
        reason: `Header/footer decorative: block_type=${image.block_type ?? 'unknown'}`,
      };
    }

    // LAYER 2: Figure blocks are always content — skip further checks
    if (image.block_type === 'Figure' || image.block_type === 'FigureGroup') {
      return { process: true, reason: 'Figure block — content image' };
    }

    // LAYER 3: Content hash deduplication
    if (image.content_hash) {
      const duplicate = findByContentHash(this.db, image.content_hash, image.id);
      if (duplicate) {
        // Copy VLM results from the existing processed image
        copyVLMResult(this.db, image.id, duplicate);
        return {
          process: false,
          reason: `Duplicate of image ${duplicate.id} — VLM results copied, 0 tokens used`,
          dedupSource: duplicate,
        };
      }
    }

    // LAYER 4: Quick dimension check (no file I/O needed)
    const width = image.dimensions?.width ?? 0;
    const height = image.dimensions?.height ?? 0;

    if (width > 0 && height > 0) {
      if (Math.max(width, height) < imageOptimization.vlmSkipBelowSize) {
        return {
          process: false,
          reason: `Too small: ${width}x${height} < ${imageOptimization.vlmSkipBelowSize}px`,
        };
      }

      if (Math.max(width, height) < 100) {
        return {
          process: false,
          reason: `Likely icon: ${width}x${height} (largest dim < 100px)`,
        };
      }

      const aspectRatio = Math.max(width, height) / Math.min(width, height);
      if (aspectRatio > 6) {
        return {
          process: false,
          reason: `Extreme aspect ratio: ${aspectRatio.toFixed(1)}:1 (likely banner/separator)`,
        };
      }
    }

    // LAYER 5: Full file-based analysis (existing Python optimizer)
    if (imageOptimization.vlmSkipLogosIcons && image.extracted_path) {
      try {
        const analysis = await this.optimizer.analyzeImage(image.extracted_path);

        if (analysis.success && !analysis.should_vlm) {
          return {
            process: false,
            reason: analysis.skip_reason ?? `Low relevance: ${analysis.overall_relevance}`,
          };
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[VLMPipeline] Relevance analysis failed for ${image.id}, skipping to avoid processing potentially irrelevant images: ${errMsg}`
        );
        return {
          process: false,
          reason: `Relevance analysis failed: ${errMsg}. Skipping to avoid processing potentially irrelevant images.`,
        };
      }
    }

    return { process: true, reason: 'Passed all relevance checks' };
  }

  /**
   * Resize an image for VLM if it exceeds the max dimension.
   *
   * @param image - Image reference
   * @returns Path to resized image, or null if no resize needed
   */
  private async maybeResizeForVLM(image: ImageReference): Promise<string | null> {
    if (!image.extracted_path) return null;

    const { vlmMaxDimension } = this.config.imageOptimization;
    const width = image.dimensions?.width ?? 0;
    const height = image.dimensions?.height ?? 0;
    const maxDim = Math.max(width, height);

    // Unknown dimensions (Datalab images) - skip resize
    if (maxDim === 0) {
      return null;
    }

    // Dimensions known but within limit - no resize needed
    if (maxDim <= vlmMaxDimension) {
      return null;
    }

    // Try to resize
    try {
      const result = await this.optimizer.resizeForVLM(image.extracted_path);

      if (result.success && 'output_path' in result) {
        if (result.resized) {
          console.error(
            `[VLMPipeline] Resized image for VLM: ${result.original_width}x${result.original_height} -> ${result.output_width}x${result.output_height}`
          );
        }
        return result.output_path;
      }
    } catch (error) {
      console.error(`[VLMPipeline] Failed to resize image ${image.id}, using original: ${error}`);
    }

    return null;
  }

  /**
   * Generate embedding and store in vector database.
   * Creates EMBEDDING provenance at depth 4 (from VLM_DESCRIPTION).
   *
   * @param description - VLM description text to embed
   * @param image - Source image reference
   * @param vlmDescriptionProvId - VLM_DESCRIPTION provenance ID for chain tracking
   */
  private async generateAndStoreEmbedding(
    description: string,
    image: ImageReference,
    vlmDescriptionProvId?: string
  ): Promise<string> {
    // Generate embedding vector
    const vectors = await this.embeddingClient.embedChunks([description], 1);

    if (vectors.length === 0) {
      throw new Error('Embedding generation returned empty result');
    }

    const vector = vectors[0];
    const embeddingId = uuidv4();

    // Store in database and vector storage - database service is REQUIRED
    if (!this.dbService) {
      throw new Error(
        'VLM embedding storage requires dbService - pipeline was created without database service'
      );
    }

    {
      // Create EMBEDDING provenance if we have VLM_DESCRIPTION provenance
      let embeddingProvId = embeddingId; // Default: use embedding ID as provenance ID

      if (vlmDescriptionProvId) {
        embeddingProvId = uuidv4();
        const vlmProv = this.dbService.getProvenance(vlmDescriptionProvId);

        if (vlmProv) {
          // Build parent_ids: ... + VLM_DESCRIPTION
          const parentIds = JSON.parse(vlmProv.parent_ids) as string[];
          parentIds.push(vlmDescriptionProvId);

          const now = new Date().toISOString();

          const embeddingProvRecord: ProvenanceRecord = {
            id: embeddingProvId,
            type: ProvenanceType.EMBEDDING,
            created_at: now,
            processed_at: now,
            source_file_created_at: null,
            source_file_modified_at: null,
            source_type: 'EMBEDDING',
            source_path: null,
            source_id: vlmDescriptionProvId, // Parent is VLM_DESCRIPTION
            root_document_id: vlmProv.root_document_id,
            location: {
              page_number: image.page_number,
              chunk_index: image.image_index,
            },
            content_hash: computeHash(description),
            input_hash: vlmProv.content_hash,
            file_hash: vlmProv.file_hash,
            processor: EMBEDDING_MODEL,
            processor_version: '1.5.0',
            processing_params: { task_type: 'search_document', dimensions: 768 },
            processing_duration_ms: null,
            processing_quality_score: null,
            parent_id: vlmDescriptionProvId,
            parent_ids: JSON.stringify(parentIds),
            chain_depth: 4, // EMBEDDING from VLM_DESCRIPTION is depth 4
            chain_path: JSON.stringify([
              'DOCUMENT',
              'OCR_RESULT',
              'IMAGE',
              'VLM_DESCRIPTION',
              'EMBEDDING',
            ]),
          };

          this.dbService.insertProvenance(embeddingProvRecord);
        } else {
          // vlmDescriptionProvId was set but provenance not found - fall back
          console.error(
            `[VLMPipeline] VLM description provenance ${vlmDescriptionProvId} not found, using embedding ID as provenance`
          );
          embeddingProvId = embeddingId;
        }
      }

      // Create embedding record (VLM description embeddings use image_id, not chunk_id)
      this.dbService.insertEmbedding({
        id: embeddingId,
        chunk_id: null, // VLM embeddings don't have a chunk
        image_id: image.id, // Use image ID for VLM embeddings
        extraction_id: null, // VLM embeddings don't have an extraction
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
        provenance_id: embeddingProvId, // Use embedding provenance ID
        content_hash: computeHash(description),
        generation_duration_ms: null,
      });

      // Store vector
      this.vectorService.storeVector(embeddingId, vector);
    }

    return embeddingId;
  }

  /**
   * Convert ImageAnalysis to VLMStructuredData format.
   */
  private convertToStructuredData(analysis: ImageAnalysis): VLMStructuredData {
    return {
      imageType: analysis.imageType,
      primarySubject: analysis.primarySubject,
      extractedText: analysis.extractedText,
      dates: analysis.dates,
      names: analysis.names,
      numbers: analysis.numbers,
      paragraph1: analysis.paragraph1,
      paragraph2: analysis.paragraph2,
      paragraph3: analysis.paragraph3,
    };
  }

  /**
   * Track VLM_DESCRIPTION provenance for VLM processing output.
   * Chain: DOCUMENT (0) -> OCR_RESULT (1) -> IMAGE (2) -> VLM_DESCRIPTION (3)
   *
   * @param image - Source image reference with provenance_id
   * @param vlmResult - VLM analysis result
   * @returns Provenance ID for the VLM_DESCRIPTION record (used for embedding chain)
   */
  private trackProvenance(image: ImageReference, vlmResult: VLMAnalysisResult): string {
    if (!this.dbService) {
      throw new Error('DatabaseService required for provenance tracking');
    }

    const provenanceId = uuidv4();
    const now = new Date().toISOString();

    // Get IMAGE provenance to build parent chain
    if (!image.provenance_id) {
      throw new Error(`Image ${image.id} has no provenance_id - cannot track VLM provenance`);
    }

    const imageProv = this.dbService.getProvenance(image.provenance_id);
    if (!imageProv) {
      throw new Error(`Image provenance not found: ${image.provenance_id}`);
    }

    // Build parent_ids: document + OCR + IMAGE
    const parentIds = JSON.parse(imageProv.parent_ids) as string[];
    parentIds.push(image.provenance_id);

    const record: ProvenanceRecord = {
      id: provenanceId,
      type: ProvenanceType.VLM_DESCRIPTION, // CORRECT type for VLM descriptions
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'VLM', // CORRECT source type
      source_path: image.extracted_path,
      source_id: image.provenance_id, // Parent is IMAGE
      root_document_id: imageProv.root_document_id,
      location: {
        page_number: image.page_number,
        chunk_index: image.image_index,
      },
      content_hash: computeHash(vlmResult.description),
      input_hash: imageProv.content_hash, // Input was the image
      file_hash: imageProv.file_hash,
      processor: `gemini-vlm:${vlmResult.model}`,
      processor_version: '3.0',
      processing_params: {
        type: 'vlm_description',
        confidence: vlmResult.analysis.confidence,
        tokensUsed: vlmResult.tokensUsed,
      },
      processing_duration_ms: vlmResult.processingTimeMs,
      processing_quality_score: vlmResult.analysis.confidence,
      parent_id: image.provenance_id,
      parent_ids: JSON.stringify(parentIds),
      chain_depth: 3, // VLM_DESCRIPTION is depth 3
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION']),
    };

    this.dbService.insertProvenance(record);
    return provenanceId; // Return the ID so we can use it for embedding provenance
  }

  /**
   * Track VLM_DESCRIPTION provenance for a deduplicated image.
   * Creates provenance record documenting that VLM results were copied from a source image
   * with identical content hash, preserving full chain: DOCUMENT(0) -> OCR_RESULT(1) -> IMAGE(2) -> VLM_DESCRIPTION(3).
   *
   * @param image - The dedup copy image that received copied VLM results
   * @param source - The source image whose VLM results were copied
   */
  private trackDedupProvenance(image: ImageReference, source: ImageReference): void {
    if (!this.dbService || this.config.skipProvenance) return;

    if (!image.provenance_id) {
      console.error(
        `[VLMPipeline] Cannot track dedup provenance: image ${image.id} has no provenance_id`
      );
      return;
    }

    const imageProv = this.dbService.getProvenance(image.provenance_id);
    if (!imageProv) {
      console.error(`[VLMPipeline] Image provenance not found: ${image.provenance_id}`);
      return;
    }

    const provenanceId = uuidv4();
    const now = new Date().toISOString();

    const parentIds = JSON.parse(imageProv.parent_ids) as string[];
    parentIds.push(image.provenance_id);

    if (!source.vlm_description) {
      console.error(
        `[VLMPipeline] Cannot create dedup provenance: source image ${source.id} has null vlm_description despite vlm_status=complete`
      );
      return;
    }

    const record: ProvenanceRecord = {
      id: provenanceId,
      type: ProvenanceType.VLM_DESCRIPTION,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'VLM_DEDUP',
      source_path: image.extracted_path,
      source_id: image.provenance_id,
      root_document_id: imageProv.root_document_id,
      location: {
        page_number: image.page_number,
        chunk_index: image.image_index,
      },
      content_hash: computeHash(source.vlm_description),
      input_hash: imageProv.content_hash,
      file_hash: imageProv.file_hash,
      processor: 'dedup-copy',
      processor_version: '1.0.0',
      processing_params: {
        type: 'vlm_dedup_copy',
        source_image_id: source.id,
        content_hash: image.content_hash,
      },
      processing_duration_ms: 0,
      processing_quality_score: source.vlm_confidence,
      parent_id: image.provenance_id,
      parent_ids: JSON.stringify(parentIds),
      chain_depth: 3,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION']),
    };

    this.dbService.insertProvenance(record);
    console.error(
      `[VLMPipeline] Created dedup VLM_DESCRIPTION provenance: ${provenanceId} (source: ${source.id})`
    );

    // If source has an embedding, create EMBEDDING provenance linking to target's chain
    // This ensures the dedup target has a complete provenance chain including the shared embedding
    if (source.vlm_embedding_id) {
      const embProvId = uuidv4();
      const embParentIds = [...parentIds, provenanceId];

      const embRecord: ProvenanceRecord = {
        id: embProvId,
        type: ProvenanceType.EMBEDDING,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'EMBEDDING',
        source_path: null,
        source_id: provenanceId, // Parent is the VLM_DESCRIPTION we just created
        root_document_id: imageProv.root_document_id,
        location: {
          page_number: image.page_number,
          chunk_index: image.image_index,
        },
        content_hash: record.content_hash, // Same content as VLM description
        input_hash: record.content_hash,
        file_hash: imageProv.file_hash,
        processor: 'vlm-dedup-embedding-link',
        processor_version: '1.0.0',
        processing_params: {
          source_image_id: source.id,
          source_embedding_id: source.vlm_embedding_id,
          dedup_reason: 'content_hash_match',
        },
        processing_duration_ms: 0,
        processing_quality_score: null,
        parent_id: provenanceId,
        parent_ids: JSON.stringify(embParentIds),
        chain_depth: 4, // EMBEDDING from VLM_DESCRIPTION is depth 4
        chain_path: JSON.stringify([
          'DOCUMENT',
          'OCR_RESULT',
          'IMAGE',
          'VLM_DESCRIPTION',
          'EMBEDDING',
        ]),
      };

      this.dbService.insertProvenance(embRecord);
      console.error(
        `[VLMPipeline] Created dedup EMBEDDING provenance: ${embProvId} (source embedding: ${source.vlm_embedding_id})`
      );
    }
  }

  /**
   * Get processing statistics.
   */
  getStats() {
    return {
      images: getImageStats(this.db),
      vlm: this.vlm.getStatus(),
    };
  }
}

/**
 * Create a VLMPipeline with full service integration.
 */
export function createVLMPipeline(
  dbService: DatabaseService,
  vectorService: VectorService,
  config?: Partial<PipelineConfig>
): VLMPipeline {
  return new VLMPipeline(dbService.getConnection(), {
    config,
    dbService,
    vectorService,
  });
}
