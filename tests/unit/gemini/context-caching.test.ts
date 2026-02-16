/**
 * Unit tests for Gemini Context Caching (AI-1) and Batch API (AI-2)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeminiClient } from '../../../src/services/gemini/client.js';

describe('GeminiClient Context Caching (AI-1)', () => {
  let client: GeminiClient;

  beforeEach(() => {
    client = new GeminiClient({ apiKey: 'test-key-for-caching' });
  });

  describe('createCachedContent', () => {
    it('should create cache with valid text (>= 4096 chars)', async () => {
      const longText = 'A'.repeat(5000);
      const cacheId = await client.createCachedContent(longText);

      expect(cacheId).toBeDefined();
      expect(typeof cacheId).toBe('string');
      expect(cacheId.startsWith('cache_')).toBe(true);
    });

    it('should throw for text shorter than 4096 chars', async () => {
      const shortText = 'Short text';

      await expect(client.createCachedContent(shortText)).rejects.toThrow(
        'Context text too short for caching'
      );
    });

    it('should create cache with custom TTL', async () => {
      const longText = 'B'.repeat(5000);
      const cacheId = await client.createCachedContent(longText, 7200);

      expect(cacheId).toBeDefined();
      expect(cacheId.startsWith('cache_')).toBe(true);
    });

    it('should create unique cache IDs for different calls', async () => {
      const text = 'C'.repeat(5000);
      const id1 = await client.createCachedContent(text);
      const id2 = await client.createCachedContent(text);

      expect(id1).not.toBe(id2);
    });
  });

  describe('generateWithCache', () => {
    it('should throw for non-existent cache ID', async () => {
      const fakeFile = {
        mimeType: 'image/png' as const,
        data: 'base64data',
        sizeBytes: 100,
      };

      await expect(
        client.generateWithCache('nonexistent_cache', 'describe this', fakeFile)
      ).rejects.toThrow('Cache not found: nonexistent_cache');
    });

    it('should throw for expired cache', async () => {
      const longText = 'D'.repeat(5000);
      // Create with 0-second TTL (immediately expired)
      const cacheId = await client.createCachedContent(longText, 0);

      // Wait a tiny bit to ensure expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      const fakeFile = {
        mimeType: 'image/png' as const,
        data: 'base64data',
        sizeBytes: 100,
      };

      await expect(client.generateWithCache(cacheId, 'describe this', fakeFile)).rejects.toThrow(
        'Cache expired'
      );
    });
  });

  describe('deleteCachedContent', () => {
    it('should return true when deleting existing cache', async () => {
      const longText = 'E'.repeat(5000);
      const cacheId = await client.createCachedContent(longText);

      const result = client.deleteCachedContent(cacheId);
      expect(result).toBe(true);
    });

    it('should return false when deleting non-existent cache', () => {
      const result = client.deleteCachedContent('nonexistent');
      expect(result).toBe(false);
    });

    it('should make cache unavailable after deletion', async () => {
      const longText = 'F'.repeat(5000);
      const cacheId = await client.createCachedContent(longText);
      client.deleteCachedContent(cacheId);

      const fakeFile = {
        mimeType: 'image/png' as const,
        data: 'base64data',
        sizeBytes: 100,
      };

      await expect(client.generateWithCache(cacheId, 'describe this', fakeFile)).rejects.toThrow(
        'Cache not found'
      );
    });
  });
});

describe('GeminiClient Batch API (AI-2)', () => {
  let client: GeminiClient;

  beforeEach(() => {
    client = new GeminiClient({ apiKey: 'test-key-for-batch' });
  });

  describe('batchAnalyzeImages', () => {
    it('should return empty array for empty requests', async () => {
      const results = await client.batchAnalyzeImages([]);
      expect(results).toEqual([]);
    });

    it('should call onProgress callback for each item', async () => {
      // Mock analyzeImage to throw (we cannot make real API calls in tests)
      const mockAnalyze = vi
        .spyOn(client, 'analyzeImage')
        .mockRejectedValue(new Error('Test error'));

      const progressCalls: Array<[number, number]> = [];
      const requests = [
        { prompt: 'test1', file: { mimeType: 'image/png' as const, data: 'a', sizeBytes: 1 } },
        { prompt: 'test2', file: { mimeType: 'image/png' as const, data: 'b', sizeBytes: 1 } },
      ];

      const results = await client.batchAnalyzeImages(requests, (completed, total) =>
        progressCalls.push([completed, total])
      );

      expect(results).toHaveLength(2);
      expect(progressCalls).toEqual([
        [1, 2],
        [2, 2],
      ]);

      // Each result should have an error since analyzeImage is mocked to fail
      expect(results[0].index).toBe(0);
      expect(results[0].error).toBe('Test error');
      expect(results[1].index).toBe(1);
      expect(results[1].error).toBe('Test error');

      mockAnalyze.mockRestore();
    });

    it('should capture errors per item without failing entire batch', async () => {
      const mockAnalyze = vi
        .spyOn(client, 'analyzeImage')
        .mockResolvedValueOnce({
          text: 'description',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            thinkingTokens: 0,
            totalTokens: 15,
          },
          model: 'test-model',
          processingTimeMs: 100,
        })
        .mockRejectedValueOnce(new Error('Rate limited'))
        .mockResolvedValueOnce({
          text: 'another desc',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            thinkingTokens: 0,
            totalTokens: 15,
          },
          model: 'test-model',
          processingTimeMs: 200,
        });

      const requests = [
        { prompt: 'p1', file: { mimeType: 'image/png' as const, data: 'a', sizeBytes: 1 } },
        { prompt: 'p2', file: { mimeType: 'image/png' as const, data: 'b', sizeBytes: 1 } },
        { prompt: 'p3', file: { mimeType: 'image/png' as const, data: 'c', sizeBytes: 1 } },
      ];

      const results = await client.batchAnalyzeImages(requests);

      expect(results).toHaveLength(3);
      expect(results[0].result).toBeDefined();
      expect(results[0].error).toBeUndefined();
      expect(results[1].result).toBeUndefined();
      expect(results[1].error).toBe('Rate limited');
      expect(results[2].result).toBeDefined();
      expect(results[2].error).toBeUndefined();

      mockAnalyze.mockRestore();
    });

    it('should preserve request indices in results', async () => {
      const mockAnalyze = vi.spyOn(client, 'analyzeImage').mockRejectedValue(new Error('fail'));

      const requests = Array.from({ length: 5 }, (_, i) => ({
        prompt: `prompt_${i}`,
        file: { mimeType: 'image/png' as const, data: 'x', sizeBytes: 1 },
      }));

      const results = await client.batchAnalyzeImages(requests);
      expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);

      mockAnalyze.mockRestore();
    });
  });
});
