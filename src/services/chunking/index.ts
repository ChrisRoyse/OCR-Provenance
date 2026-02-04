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
} from './chunker.js';
export type { ChunkProvenanceParams } from './chunker.js';

// Re-export model types for convenience
export type { ChunkResult, Chunk, ChunkingConfig } from '../../models/chunk.js';
export { DEFAULT_CHUNKING_CONFIG, getOverlapCharacters, getStepSize } from '../../models/chunk.js';
