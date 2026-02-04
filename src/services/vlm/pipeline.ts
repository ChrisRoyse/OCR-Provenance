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
  private readonly vectorService: VectorService | null;

  constructor(
    db: Database.Database,
    options: {
      config?: Partial<PipelineConfig>;
      vlmService?: VLMService;
      embeddingClient?: NomicEmbeddingClient;
      dbService?: DatabaseService;
      vectorService?: VectorService;
    } = {}
  ) {
    this.db = db;
    this.vlm = options.vlmService ?? new VLMService();
    this.embeddingClient = options.embeddingClient ?? getEmbeddingClient();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.dbService = options.dbService ?? null;
    this.vectorService = options.vectorService ?? null;
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
   * Process a batch of images concurrently.
   */
  private async processBatch(images: ImageReference[]): Promise<ProcessingResult[]> {
    // Mark all as processing
    for (const img of images) {
      try {
        setImageProcessing(this.db, img.id);
      } catch {
        // Ignore if already processing
      }
    }

    // Process with concurrency control
    const results: ProcessingResult[] = [];

    for (let i = 0; i < images.length; i += this.config.concurrency) {
      const concurrent = images.slice(i, i + this.config.concurrency);
      const settled = await Promise.allSettled(
        concurrent.map((img) => this.processImage(img))
      );

      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            imageId: concurrent[j].id,
            success: false,
            error: result.reason?.message || 'Unknown error',
            processingTimeMs: 0,
          });
        }
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
      });

      // Check confidence threshold
      if (vlmResult.analysis.confidence < this.config.minConfidence) {
        console.warn(
          `[VLMPipeline] Low confidence (${vlmResult.analysis.confidence}) for image ${image.id}`
        );
      }

      // Generate embedding for description
      let embeddingId: string | null = null;

      if (!this.config.skipEmbeddings && vlmResult.description) {
        embeddingId = await this.generateAndStoreEmbedding(
          vlmResult.description,
          image
        );
      }

      // Track provenance
      if (!this.config.skipProvenance && this.dbService) {
        this.trackProvenance(image, vlmResult);
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
   */
  private async generateAndStoreEmbedding(
    description: string,
    image: ImageReference
  ): Promise<string> {
    // Generate embedding vector
    const vectors = await this.embeddingClient.embedChunks([description], 1);

    if (vectors.length === 0) {
      throw new Error('Embedding generation returned empty result');
    }

    const vector = vectors[0];
    const embeddingId = uuidv4();

    // Store in database and vector storage if services available
    if (this.dbService && this.vectorService) {
      // Create embedding record (VLM description embeddings use a simplified schema)
      this.dbService.insertEmbedding({
        id: embeddingId,
        chunk_id: image.id, // Use image ID as chunk reference
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
        provenance_id: image.provenance_id ?? embeddingId,
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
   * Track provenance for VLM processing.
   * Uses EMBEDDING type since VLM_DESCRIPTION is not a valid ProvenanceType.
   */
  private trackProvenance(image: ImageReference, vlmResult: VLMAnalysisResult): void {
    if (!this.dbService) return;

    const provenanceId = uuidv4();
    const now = new Date().toISOString();

    // Note: Using EMBEDDING type for VLM descriptions since it's the closest
    // semantic match - both represent derived content from document processing
    const record: ProvenanceRecord = {
      id: provenanceId,
      type: ProvenanceType.EMBEDDING, // VLM description is depth 3 like embeddings
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EMBEDDING', // Using EMBEDDING as closest match
      source_path: image.extracted_path,
      source_id: image.provenance_id,
      root_document_id: image.document_id,
      location: {
        page_number: image.page_number,
        chunk_index: image.image_index, // Using chunk_index for image index
      },
      content_hash: computeHash(vlmResult.description),
      input_hash: null,
      file_hash: null,
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
      parent_ids: JSON.stringify(image.provenance_id ? [image.provenance_id] : []),
      chain_depth: 3,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION']),
    };

    this.dbService.insertProvenance(record);
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
