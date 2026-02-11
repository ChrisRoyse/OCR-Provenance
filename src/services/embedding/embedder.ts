/**
 * EmbeddingService - Embedding generation orchestrator
 *
 * CP-001: Complete provenance (EMBEDDING records, chain_depth=3)
 * CP-002: original_text denormalized in every embedding
 * CP-004: Local GPU only - NO cloud fallback
 *
 * ATOMIC: All operations succeed or none are stored. FAIL FAST.
 *
 * @module services/embedding/embedder
 */

import { v4 as uuidv4 } from 'uuid';
import {
  NomicEmbeddingClient,
  getEmbeddingClient,
  EmbeddingError,
  EMBEDDING_DIM,
  MODEL_NAME,
  MODEL_VERSION,
  DEFAULT_BATCH_SIZE,
} from './nomic.js';
import { DatabaseService } from '../storage/database/index.js';
import { VectorService } from '../storage/vector.js';
import { computeHash } from '../../utils/hash.js';
import type { Chunk } from '../../models/chunk.js';
import type { Embedding } from '../../models/embedding.js';
import type { ProvenanceRecord, ProvenanceType, SourceType, ProvenanceLocation } from '../../models/provenance.js';

interface DocumentInfo {
  documentId: string;
  filePath: string;
  fileName: string;
  fileHash: string;
  documentProvenanceId: string;
}

interface EmbedResult {
  success: boolean;
  embeddingIds: string[];
  provenanceIds: string[];
  totalChunks: number;
  elapsedMs: number;
  error?: string;
}

const CHAIN_PATH = JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING']);

export class EmbeddingService {
  private readonly client: NomicEmbeddingClient;
  private readonly batchSize: number;

  constructor(options?: { batchSize?: number; client?: NomicEmbeddingClient }) {
    this.client = options?.client ?? getEmbeddingClient();
    this.batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async embedDocumentChunks(
    db: DatabaseService,
    vectorService: VectorService,
    chunks: Chunk[],
    documentInfo: DocumentInfo
  ): Promise<EmbedResult> {
    if (chunks.length === 0) {
      return { success: true, embeddingIds: [], provenanceIds: [], totalChunks: 0, elapsedMs: 0 };
    }

    const startMs = Date.now();
    const vectors = await this.client.embedChunks(chunks.map((c) => c.text), this.batchSize);

    if (vectors.length !== chunks.length) {
      throw new EmbeddingError(
        `Vector count mismatch: got ${vectors.length}, expected ${chunks.length}`,
        'EMBEDDING_FAILED',
        { vectorCount: vectors.length, chunkCount: chunks.length }
      );
    }

    const result = db.transaction(() => {
      const embeddingIds: string[] = [];
      const provenanceIds: string[] = [];
      // H-7/M-16: Sub-batch vector storage to avoid accumulating all Float32Array vectors in memory
      const VECTOR_SUB_BATCH = 50;
      let vectorBatch: Array<{ embeddingId: string; vector: Float32Array }> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = vectors[i];
        const embeddingId = uuidv4();
        const now = new Date().toISOString();

        const provenanceId = this.createProvenance(db, chunk, documentInfo);
        provenanceIds.push(provenanceId);

        const embedding: Omit<Embedding, 'created_at' | 'vector'> = {
          id: embeddingId,
          chunk_id: chunk.id,
          image_id: null, // Text embeddings don't have an image
          extraction_id: null, // Text embeddings don't have an extraction
          document_id: documentInfo.documentId,
          original_text: chunk.text,
          original_text_length: chunk.text.length,
          source_file_path: documentInfo.filePath,
          source_file_name: documentInfo.fileName,
          source_file_hash: documentInfo.fileHash,
          page_number: chunk.page_number,
          page_range: chunk.page_range,
          character_start: chunk.character_start,
          character_end: chunk.character_end,
          chunk_index: chunk.chunk_index,
          total_chunks: chunks.length,
          model_name: MODEL_NAME,
          model_version: MODEL_VERSION,
          task_type: 'search_document',
          inference_mode: 'local',
          gpu_device: 'cuda:0',
          provenance_id: provenanceId,
          content_hash: computeHash(chunk.text),
          generation_duration_ms: null,
        };

        db.insertEmbedding(embedding);
        embeddingIds.push(embeddingId);
        vectorBatch.push({ embeddingId, vector });

        // H-7/M-16: Flush vector sub-batch to avoid accumulating all vectors in memory
        if (vectorBatch.length >= VECTOR_SUB_BATCH) {
          vectorService.batchStoreVectors(vectorBatch);
          vectorBatch = [];
        }

        db.updateChunkEmbeddingStatus(chunk.id, 'complete', now);
      }

      // Flush remaining vectors
      if (vectorBatch.length > 0) {
        vectorService.batchStoreVectors(vectorBatch);
      }
      return { embeddingIds, provenanceIds };
    });

    return {
      success: true,
      embeddingIds: result.embeddingIds,
      provenanceIds: result.provenanceIds,
      totalChunks: chunks.length,
      elapsedMs: Date.now() - startMs,
    };
  }

  async embedSearchQuery(query: string): Promise<Float32Array> {
    return this.client.embedQuery(query);
  }

  async processPendingChunks(
    db: DatabaseService,
    vectorService: VectorService,
    documentInfo: DocumentInfo
  ): Promise<EmbedResult> {
    const allChunks = db.getChunksByDocumentId(documentInfo.documentId);
    const pendingChunks = allChunks.filter((c) => c.embedding_status === 'pending');

    if (pendingChunks.length === 0) {
      return { success: true, embeddingIds: [], provenanceIds: [], totalChunks: 0, elapsedMs: 0 };
    }

    return this.embedDocumentChunks(db, vectorService, pendingChunks, documentInfo);
  }

  private createProvenance(db: DatabaseService, chunk: Chunk, documentInfo: DocumentInfo): string {
    const provenanceId = uuidv4();
    const now = new Date().toISOString();
    const chunkProv = db.getProvenance(chunk.provenance_id);

    const existingParents = chunkProv?.parent_ids ? JSON.parse(chunkProv.parent_ids) as string[] : [];
    const parentIds = [...existingParents, chunk.provenance_id];

    const record: ProvenanceRecord = {
      id: provenanceId,
      type: 'EMBEDDING' as ProvenanceType,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EMBEDDING' as SourceType,
      source_path: null,
      source_id: chunk.provenance_id,
      root_document_id: documentInfo.documentProvenanceId,
      location: {
        chunk_index: chunk.chunk_index,
        character_start: chunk.character_start,
        character_end: chunk.character_end,
        page_number: chunk.page_number ?? undefined,
      } as ProvenanceLocation,
      content_hash: computeHash(chunk.text),
      input_hash: chunk.text_hash,
      file_hash: documentInfo.fileHash,
      processor: MODEL_NAME,
      processor_version: MODEL_VERSION,
      processing_params: {
        dimensions: EMBEDDING_DIM,
        task_type: 'search_document',
        inference_mode: 'local',
        device: 'cuda:0',
        dtype: 'float16',
        batch_size: this.batchSize,
      },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: chunk.provenance_id,
      parent_ids: JSON.stringify(parentIds),
      chain_depth: 3,
      chain_path: CHAIN_PATH,
    };

    db.insertProvenance(record);
    return provenanceId;
  }
}

let _service: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!_service) {
    _service = new EmbeddingService();
  }
  return _service;
}

export function resetEmbeddingService(): void {
  _service = null;
}

export { EmbeddingError };
