/**
 * NomicEmbeddingClient Tests
 *
 * Tests for the TypeScript bridge to Python GPU worker.
 * Uses REAL GPU - NO MOCKS. Tests FAIL FAST if GPU unavailable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  NomicEmbeddingClient,
  EmbeddingError,
  EMBEDDING_DIM,
  MODEL_NAME,
} from '../../../src/services/embedding/nomic.js';

let client: NomicEmbeddingClient;

beforeAll(async () => {
  client = new NomicEmbeddingClient();

  // Verify GPU is available - fail fast if not
  const testResult = await client.embedChunks(['GPU availability test']);
  if (testResult.length !== 1 || testResult[0].length !== EMBEDDING_DIM) {
    throw new Error('GPU check failed: unexpected embedding result');
  }
  console.log('[GPU] GPU available - tests will run');
}, 60000);

describe('NomicEmbeddingClient', () => {
  describe('embedChunks', () => {
    it('returns empty array for empty input', async () => {
      const result = await client.embedChunks([]);
      expect(result).toEqual([]);
    });

    it('returns Float32Array[] with 768 dimensions for single chunk', async () => {
      const result = await client.embedChunks(['This is a test chunk.']);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Float32Array);
      expect(result[0].length).toBe(EMBEDDING_DIM);
    }, 30000);

    it('handles multiple chunks correctly', async () => {
      const chunks = [
        'First test chunk about legal documents.',
        'Second chunk discussing contracts.',
        'Third chunk about financial records.',
      ];

      const result = await client.embedChunks(chunks);

      expect(result).toHaveLength(3);
      result.forEach((vector) => {
        expect(vector).toBeInstanceOf(Float32Array);
        expect(vector.length).toBe(EMBEDDING_DIM);
      });
    }, 30000);

    it('produces normalized vectors (L2 norm ≈ 1)', async () => {
      const result = await client.embedChunks(['Test for vector normalization.']);

      let sumSquares = 0;
      for (let i = 0; i < result[0].length; i++) {
        sumSquares += result[0][i] * result[0][i];
      }
      const norm = Math.sqrt(sumSquares);

      expect(norm).toBeCloseTo(1.0, 1);
    }, 30000);

    it('different chunks produce different embeddings', async () => {
      const result = await client.embedChunks([
        'Legal contract for services.',
        'Medical records from hospital.',
      ]);

      let dotProduct = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        dotProduct += result[0][i] * result[1][i];
      }

      expect(dotProduct).toBeLessThan(0.9);
    }, 30000);

    it('similar chunks produce similar embeddings', async () => {
      const result = await client.embedChunks([
        'The contract specifies payment terms of 30 days net.',
        'Payment terms in the contract are 30 days net.',
      ]);

      let dotProduct = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        dotProduct += result[0][i] * result[1][i];
      }

      expect(dotProduct).toBeGreaterThan(0.7);
    }, 30000);

    it('handles special characters and unicode', async () => {
      const result = await client.embedChunks([
        'Text with special chars: @#$%^&*()',
        'Unicode: éèê 中文 📝',
      ]);

      expect(result).toHaveLength(2);
      result.forEach((vector) => {
        expect(vector.length).toBe(EMBEDDING_DIM);
        for (let i = 0; i < vector.length; i++) {
          expect(Number.isNaN(vector[i])).toBe(false);
        }
      });
    }, 30000);

    it('handles long text chunks', async () => {
      const longText = 'This is a test sentence. '.repeat(100);
      expect(longText.length).toBeGreaterThan(2000);

      const result = await client.embedChunks([longText]);

      expect(result).toHaveLength(1);
      expect(result[0].length).toBe(EMBEDDING_DIM);
    }, 30000);
  });

  describe('embedQuery', () => {
    it('returns Float32Array with 768 dimensions', async () => {
      const result = await client.embedQuery('What are the payment terms?');

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(EMBEDDING_DIM);
    }, 30000);

    it('produces normalized vector', async () => {
      const result = await client.embedQuery('Test query for normalization.');

      let sumSquares = 0;
      for (let i = 0; i < result.length; i++) {
        sumSquares += result[i] * result[i];
      }
      const norm = Math.sqrt(sumSquares);

      expect(norm).toBeCloseTo(1.0, 1);
    }, 30000);

    it('throws on empty query', async () => {
      await expect(client.embedQuery('')).rejects.toThrow(EmbeddingError);
      await expect(client.embedQuery('   ')).rejects.toThrow(EmbeddingError);
    });

    it('query vector is similar to relevant document chunks', async () => {
      const docResult = await client.embedChunks([
        'The payment terms are net 30 days from invoice date.',
      ]);

      const queryResult = await client.embedQuery('What are the payment terms?');

      let dotProduct = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        dotProduct += docResult[0][i] * queryResult[i];
      }

      expect(dotProduct).toBeGreaterThan(0.5);
    }, 60000);
  });

  describe('error handling', () => {
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
