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
import { v4 as uuidv4 } from 'uuid';

import { VLMService, type VLMAnalysisResult, type ImageAnalysis } from './service.js';
import {
  getImage,
  getImagesByDocument,
  getPendingImages,
  setImageProcessing,
  updateImageVLMResult,
  setImageVLMFailed,
  getImageStats,
} from '../storage/database/image-operations.js';
import { NomicEmbeddingClient, getEmbeddingClient, MODEL_NAME as EMBEDDING_MODEL } from '../embedding/nomic.js';
import { DatabaseService } from '../storage/database/index.js';
import { VectorService } from '../storage/vector.js';
import { computeHash } from '../../utils/hash.js';
import type { ImageReference, VLMResult, VLMStructuredData } from '../../models/image.js';
import { ProvenanceType } from '../../models/provenance.js';
import type { ProvenanceRecord } from '../../models/provenance.js';

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
  /** Use medical-specific prompts */
  useMedicalPrompts: boolean;
  /** Use universal blind-person-detail prompt for all images (default: true) */
  useUniversalPrompt: boolean;
  /** Skip embedding generation */
  skipEmbeddings: boolean;
  /** Skip provenance tracking */
  skipProvenance: boolean;
}

const DEFAULT_CONFIG: PipelineConfig = {
  batchSize: 10,
  concurrency: 5,
  minConfidence: 0.5,
  useMedicalPrompts: false,
  useUniversalPrompt: true,
  skipEmbeddings: false,
  skipProvenance: false,
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
 */
export class VLMPipeline {
  private readonly vlm: VLMService;
  private readonly embeddingClient: NomicEmbeddingClient;
  private readonly config: PipelineConfig;
  private readonly db: Database.Database;
  private readonly dbService: DatabaseService | null;
  private readonly vectorService: VectorService;

  constructor(
    db: Database.Database,
    options: {
      config?: Partial<PipelineConfig>;
      vlmService?: VLMService;
      embeddingClient?: NomicEmbeddingClient;
      dbService?: DatabaseService;
      vectorService: VectorService;
    }
  ) {
    this.db = db;
    this.vlm = options.vlmService ?? new VLMService();
    this.embeddingClient = options.embeddingClient ?? getEmbeddingClient();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.dbService = options.dbService ?? null;
    this.vectorService = options.vectorService;
  }

  /**
   * Process all images in a document.
   *
   * @param documentId - Document UUID
   * @returns BatchResult with processing summary
   */
  async processDocument(documentId: string): Promise<BatchResult> {
    const images = getImagesByDocument(this.db, documentId);
    const pending = images.filter((img) => img.vlm_status === 'pending');

    if (pending.length === 0) {
      return {
        total: 0,
        successful: 0,
        failed: 0,
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
    const images = getPendingImages(this.db, limit ?? this.config.batchSize * 10);
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

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    return {
      total: results.length,
      successful: successful.length,
      failed: failed.length,
      totalTokens: successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0),
      totalTimeMs: Date.now() - startTime,
      results,
    };
  }

  /**
   * Process a batch of images with rate limiting.
   * Gemini free tier: 5 requests/minute = 1 request per 12 seconds.
   * We use 15 seconds between requests for safety margin.
   */
  private async processBatch(images: ImageReference[]): Promise<ProcessingResult[]> {
    const RATE_LIMIT_DELAY_MS = 1000; // 1 second between API calls (paid tier: 1000 RPM)

    // Mark all as processing
    for (const img of images) {
      try {
        setImageProcessing(this.db, img.id);
      } catch {
        // Ignore if already processing
      }
    }

    // Process SEQUENTIALLY with rate limiting (no concurrency)
    const results: ProcessingResult[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      // Rate limit: wait between requests (skip for first request)
      if (i > 0) {
        console.error(`[VLMPipeline] Rate limiting: waiting ${RATE_LIMIT_DELAY_MS / 1000}s before next request...`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
      }

      console.error(`[VLMPipeline] Processing image ${i + 1}/${images.length}: ${img.id}`);

      try {
        const result = await this.processImage(img);
        results.push(result);

        if (result.success) {
          console.error(`[VLMPipeline] Success: ${img.id} (confidence: ${result.confidence?.toFixed(2)})`);
        } else {
          console.error(`[VLMPipeline] Failed: ${img.id} - ${result.error}`);
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
      }
    }

    return results;
  }

  /**
   * Process a single image through the full pipeline.
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

      // Run VLM analysis
      const vlmResult = await this.vlm.describeImage(image.extracted_path, {
        contextText: image.context_text ?? undefined,
        useMedicalPrompt: this.config.useMedicalPrompts,
        useUniversalPrompt: this.config.useUniversalPrompt,
      });

      // Check confidence threshold
      if (vlmResult.analysis.confidence < this.config.minConfidence) {
        console.warn(
          `[VLMPipeline] Low confidence (${vlmResult.analysis.confidence}) for image ${image.id}`
        );
      }

      // Track VLM_DESCRIPTION provenance FIRST (returns provenance ID for embedding chain)
      let vlmProvId: string | undefined;
      if (!this.config.skipProvenance && this.dbService) {
        vlmProvId = this.trackProvenance(image, vlmResult);
      }

      // Generate embedding for description with VLM provenance ID
      let embeddingId: string | null = null;

      if (!this.config.skipEmbeddings && vlmResult.description) {
        embeddingId = await this.generateAndStoreEmbedding(
          vlmResult.description,
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Mark as failed in database
      try {
        setImageVLMFailed(this.db, image.id, errorMessage);
      } catch {
        // Ignore secondary errors
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

    // Store in database and vector storage if database service available
    if (this.dbService) {
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
        }
      }

      // Create embedding record (VLM description embeddings use image_id, not chunk_id)
      this.dbService.insertEmbedding({
        id: embeddingId,
        chunk_id: null, // VLM embeddings don't have a chunk
        image_id: image.id, // Use image ID for VLM embeddings
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
