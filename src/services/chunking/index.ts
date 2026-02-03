/**
 * Chunking Service Module Exports
 *
 * Public API for the text chunking service.
 *
 * @module services/chunking
 */

// Main functions
export {
  chunkText,
  chunkWithPageTracking,
  createChunkProvenance,
  ChunkProvenanceParams,
} from './chunker.js';

// Re-export model types for convenience
export {
  ChunkResult,
  Chunk,
  ChunkingConfig,
  DEFAULT_CHUNKING_CONFIG,
  getOverlapCharacters,
  getStepSize,
} from '../../models/chunk.js';
