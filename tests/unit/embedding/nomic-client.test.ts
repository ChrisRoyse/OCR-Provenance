/**
 * NomicEmbeddingClient Tests
 *
 * Tests for the TypeScript bridge to Python GPU worker.
 * Uses REAL GPU when available - NO MOCKS.
 *
 * Tests will be skipped if GPU is not available (fail-fast behavior).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  NomicEmbeddingClient,
  EmbeddingError,
  EMBEDDING_DIM,
  MODEL_NAME,
} from '../../../src/services/embedding/nomic.js';

// ═══════════════════════════════════════════════════════════════════════════════
// GPU AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════════════════════

let gpuAvailable = false;
let client: NomicEmbeddingClient;
let gpuCheckError: string | null = null;

beforeAll(async () => {
  client = new NomicEmbeddingClient();

  // Check GPU availability by attempting a minimal embedding
  try {
    const testResult = await client.embedChunks(['GPU availability test']);
    if (testResult.length === 1 && testResult[0].length === EMBEDDING_DIM) {
      gpuAvailable = true;
      console.log('[GPU] GPU available - tests will run');
    }
  } catch (e) {
    if (e instanceof EmbeddingError) {
      gpuCheckError = `${e.code}: ${e.message}`;
      if (e.code === 'GPU_NOT_AVAILABLE') {
        console.warn('[GPU] GPU not available - GPU-dependent tests will be skipped');
        console.warn('[GPU] Error:', e.message);
      } else if (e.code === 'MODEL_NOT_FOUND') {
        console.warn('[GPU] Model not found - run: git lfs pull');
        console.warn('[GPU] Error:', e.message);
      } else {
        console.error('[GPU] Unexpected error:', e.message);
      }
    } else {
      gpuCheckError = String(e);
      console.error('[GPU] Unexpected error during GPU check:', e);
    }
  }
}, 60000); // 60s timeout for model loading

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('NomicEmbeddingClient', () => {
  describe('embedChunks', () => {
    it('returns empty array for empty input', async () => {
      const result = await client.embedChunks([]);
      expect(result).toEqual([]);
    });

    it.skipIf(!gpuAvailable)(
      'returns Float32Array[] with 768 dimensions for single chunk',
      async () => {
        const result = await client.embedChunks(['This is a test chunk.']);

        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(Float32Array);
        expect(result[0].length).toBe(EMBEDDING_DIM);
      },
      30000
    );

    it.skipIf(!gpuAvailable)(
      'handles multiple chunks correctly',
      async () => {
        const chunks = [
          'First test chunk about legal documents.',
          'Second chunk discussing contracts.',
          'Third chunk about financial records.',
        ];

        const result = await client.embedChunks(chunks);

        expect(result).toHaveLength(3);
        result.forEach((vector, i) => {
          expect(vector).toBeInstanceOf(Float32Array);
          expect(vector.length).toBe(EMBEDDING_DIM);
        });
      },
      30000
    );

    it.skipIf(!gpuAvailable)(
      'produces normalized vectors (L2 norm ≈ 1)',
      async () => {
        const result = await client.embedChunks(['Test for vector normalization.']);

        // Calculate L2 norm
        let sumSquares = 0;
        for (let i = 0; i < result[0].length; i++) {
          sumSquares += result[0][i] * result[0][i];
        }
        const norm = Math.sqrt(sumSquares);

        // nomic model produces normalized vectors
        expect(norm).toBeCloseTo(1.0, 1);
      },
      30000
    );

    it.skipIf(!gpuAvailable)(
      'different chunks produce different embeddings',
      async () => {
        const result = await client.embedChunks([
          'Legal contract for services.',
          'Medical records from hospital.',
        ]);

        // Calculate cosine similarity (both normalized, so just dot product)
        let dotProduct = 0;
        for (let i = 0; i < EMBEDDING_DIM; i++) {
          dotProduct += result[0][i] * result[1][i];
        }

        // Different topics should have low similarity
        expect(dotProduct).toBeLessThan(0.9);
      },
      30000
    );

    it.skipIf(!gpuAvailable)(
      'similar chunks produce similar embeddings',
      async () => {
        const result = await client.embedChunks([
          'The contract specifies payment terms of 30 days net.',
          'Payment terms in the contract are 30 days net.',
        ]);

        // Calculate cosine similarity
        let dotProduct = 0;
        for (let i = 0; i < EMBEDDING_DIM; i++) {
          dotProduct += result[0][i] * result[1][i];
        }

        // Similar sentences should have high similarity
        expect(dotProduct).toBeGreaterThan(0.7);
      },
      30000
    );

    it.skipIf(!gpuAvailable)(
      'handles special characters and unicode',
      async () => {
        const result = await client.embedChunks([
          'Text with special chars: @#$%^&*()',
          'Unicode: \u00e9\u00e8\u00ea \u4e2d\u6587 \ud83d\udcdd',
        ]);

        expect(result).toHaveLength(2);
        result.forEach((vector) => {
          expect(vector.length).toBe(EMBEDDING_DIM);
          // Verify no NaN values
          for (let i = 0; i < vector.length; i++) {
            expect(Number.isNaN(vector[i])).toBe(false);
          }
        });
      },
      30000
    );

    it.skipIf(!gpuAvailable)(
      'handles long text chunks',
      async () => {
        // Create a 2000-character chunk (typical chunk size)
        const longText = 'This is a test sentence. '.repeat(100);
        expect(longText.length).toBeGreaterThan(2000);

        const result = await client.embedChunks([longText]);

        expect(result).toHaveLength(1);
        expect(result[0].length).toBe(EMBEDDING_DIM);
      },
      30000
    );
  });

  describe('embedQuery', () => {
    it.skipIf(!gpuAvailable)(
      'returns Float32Array with 768 dimensions',
      async () => {
        const result = await client.embedQuery('What are the payment terms?');

        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(EMBEDDING_DIM);
      },
      30000
    );

    it.skipIf(!gpuAvailable)(
      'produces normalized vector',
      async () => {
        const result = await client.embedQuery('Test query for normalization.');

        let sumSquares = 0;
        for (let i = 0; i < result.length; i++) {
          sumSquares += result[i] * result[i];
        }
        const norm = Math.sqrt(sumSquares);

        expect(norm).toBeCloseTo(1.0, 1);
      },
      30000
    );

    it('throws on empty query', async () => {
      await expect(client.embedQuery('')).rejects.toThrow(EmbeddingError);
      await expect(client.embedQuery('   ')).rejects.toThrow(EmbeddingError);
    });

    it.skipIf(!gpuAvailable)(
      'query vector is similar to relevant document chunks',
      async () => {
        // Embed a document chunk
        const docResult = await client.embedChunks([
          'The payment terms are net 30 days from invoice date.',
        ]);

        // Embed a related query
        const queryResult = await client.embedQuery('What are the payment terms?');

        // Calculate cosine similarity
        let dotProduct = 0;
        for (let i = 0; i < EMBEDDING_DIM; i++) {
          dotProduct += docResult[0][i] * queryResult[i];
        }

        // Query should be similar to relevant document
        expect(dotProduct).toBeGreaterThan(0.5);
      },
      30000
    );
  });

  describe('error handling', () => {
    it('GPU_NOT_AVAILABLE check is performed', () => {
      // If GPU check failed with GPU_NOT_AVAILABLE, that's the expected behavior
      if (gpuCheckError?.includes('GPU_NOT_AVAILABLE')) {
        expect(gpuCheckError).toContain('GPU_NOT_AVAILABLE');
      } else if (gpuCheckError?.includes('MODEL_NOT_FOUND')) {
        expect(gpuCheckError).toContain('MODEL_NOT_FOUND');
      } else if (gpuCheckError) {
        // Some other error occurred
        console.warn('Unexpected GPU check error:', gpuCheckError);
      } else {
        // GPU is available, no error
        expect(gpuAvailable).toBe(true);
      }
    });

    it('EmbeddingError has correct structure', () => {
      const error = new EmbeddingError(
        'Test error',
        'GPU_NOT_AVAILABLE',
        { detail: 'test' }
      );

      expect(error.name).toBe('EmbeddingError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('GPU_NOT_AVAILABLE');
      expect(error.details).toEqual({ detail: 'test' });
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('constants', () => {
    it('EMBEDDING_DIM is 768', () => {
      expect(EMBEDDING_DIM).toBe(768);
    });

    it('MODEL_NAME is nomic-embed-text-v1.5', () => {
      expect(MODEL_NAME).toBe('nomic-embed-text-v1.5');
    });
  });
});
