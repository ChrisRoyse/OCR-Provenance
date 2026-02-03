/**
 * Embedding Service Module
 *
 * Provides GPU-based embedding generation using nomic-embed-text-v1.5.
 *
 * @module services/embedding
 */

// Re-export from nomic.ts
export {
  NomicEmbeddingClient,
  EmbeddingError,
  getEmbeddingClient,
  resetEmbeddingClient,
  EMBEDDING_DIM,
  MODEL_NAME,
  MODEL_VERSION,
  DEFAULT_BATCH_SIZE,
  DEFAULT_DEVICE,
} from './nomic.js';

export type {
  EmbeddingErrorCode,
  EmbeddingResult,
  QueryEmbeddingResult,
} from './nomic.js';

// Re-export from embedder.ts
export {
  EmbeddingService,
  getEmbeddingService,
  resetEmbeddingService,
} from './embedder.js';

export type {
  DocumentInfo,
  EmbedResult,
} from './embedder.js';
