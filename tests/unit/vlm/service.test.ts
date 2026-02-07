/**
 * Unit tests for VLM Service
 *
 * Tests the VLMService class for image analysis functionality.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  VLMService,
  getVLMService,
  resetVLMService,
  type ImageAnalysis,
  type VLMAnalysisResult,
} from '../../../src/services/vlm/service.js';
import { GeminiClient, type GeminiResponse, type FileRef } from '../../../src/services/gemini/index.js';

// Mock the GeminiClient
vi.mock('../../../src/services/gemini/client.js', () => {
  return {
    GeminiClient: vi.fn().mockImplementation(() => ({
      analyzeImage: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        model: 'gemini-3-flash-preview',
        tier: 'payAsYouGo',
        rateLimiter: { requestsRemaining: 1000, tokensRemaining: 4000000 },
        circuitBreaker: { state: 'CLOSED' },
      }),
    })),
  };
});

// Mock static method
const mockFileRefFromPath = vi.fn();
(GeminiClient as unknown as { fileRefFromPath: Mock }).fileRefFromPath = mockFileRefFromPath;

describe('VLMService', () => {
  let service: VLMService;
  let mockClient: { analyzeImage: Mock; getStatus: Mock };

  const mockAnalysisResponse: GeminiResponse = {
    text: JSON.stringify({
      imageType: 'medical_document',
      primarySubject: 'Lab results',
      paragraph1: 'This is a medical laboratory report.',
      paragraph2: 'The report shows blood test results including CBC and metabolic panel.',
      paragraph3: 'Results indicate normal values for most parameters.',
      extractedText: ['Patient Name: John Doe', 'Date: 2023-09-15'],
      dates: ['2023-09-15'],
      names: ['John Doe'],
      numbers: ['12.5', '140'],
      confidence: 0.92,
    }),
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 0,
      thinkingTokens: 0,
      totalTokens: 1200,
    },
    model: 'gemini-3-flash-preview',
    processingTimeMs: 2500,
  };

  const mockFileRef: FileRef = {
    mimeType: 'image/png',
    data: 'base64encodeddata',
    sizeBytes: 1024,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetVLMService();

    mockFileRefFromPath.mockReturnValue(mockFileRef);

    // Get mock instance
    service = new VLMService();
    mockClient = (service as unknown as { client: typeof mockClient }).client;
    mockClient.analyzeImage.mockResolvedValue(mockAnalysisResponse);
  });

  describe('constructor', () => {
    it('should create a new VLMService instance', () => {
      expect(service).toBeInstanceOf(VLMService);
    });

    it('should accept a custom GeminiClient', () => {
      const customClient = new GeminiClient();
      const customService = new VLMService(customClient);
      expect(customService).toBeInstanceOf(VLMService);
    });
  });

  describe('describeImage', () => {
    it('should analyze an image and return structured result', async () => {
      const result = await service.describeImage('/path/to/image.png');

      expect(mockFileRefFromPath).toHaveBeenCalledWith('/path/to/image.png');
      expect(mockClient.analyzeImage).toHaveBeenCalled();
      expect(result.description).toBeDefined();
      expect(result.description).toContain('medical laboratory report');
      expect(result.analysis.imageType).toBe('medical_document');
      expect(result.analysis.confidence).toBe(0.92);
      expect(result.tokensUsed).toBe(1200);
    });

    it('should use universal prompt by default', async () => {
      await service.describeImage('/path/to/image.png');

      expect(mockClient.analyzeImage).toHaveBeenCalled();
      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[0]).toContain('blind person');
    });

    it('should use context prompt when contextText is provided and universal is disabled', async () => {
      await service.describeImage('/path/to/image.png', {
        contextText: 'This image appears after a medication list.',
        useUniversalPrompt: false,
      });

      expect(mockClient.analyzeImage).toHaveBeenCalled();
      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[0]).toContain('SURROUNDING TEXT CONTEXT');
    });

    it('should use medical prompt when useMedicalPrompt is true and universal is disabled', async () => {
      await service.describeImage('/path/to/image.png', {
        useMedicalPrompt: true,
        useUniversalPrompt: false,
      });

      expect(mockClient.analyzeImage).toHaveBeenCalled();
      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[0]).toContain('medical document');
    });

    it('should handle parse errors gracefully with zero confidence', async () => {
      mockClient.analyzeImage.mockResolvedValue({
        ...mockAnalysisResponse,
        text: 'Invalid JSON response that cannot be parsed',
      });

      const result = await service.describeImage('/path/to/image.png');

      expect(result.analysis.imageType).toBe('unknown');
      expect(result.analysis.confidence).toBe(0);
      expect(result.analysis.primarySubject).toContain('[PARSE_ERROR]');
      expect(result.analysis.paragraph1).toContain('Invalid JSON');
    });
  });

  describe('classifyImage', () => {
    const mockClassificationResponse: GeminiResponse = {
      text: JSON.stringify({
        type: 'form',
        hasText: true,
        textDensity: 'dense',
        complexity: 'medium',
        confidence: 0.88,
      }),
      usage: {
        inputTokens: 500,
        outputTokens: 50,
        cachedTokens: 0,
        thinkingTokens: 0,
        totalTokens: 550,
      },
      model: 'gemini-3-flash-preview',
      processingTimeMs: 800,
    };

    it('should classify an image', async () => {
      mockClient.analyzeImage.mockResolvedValue(mockClassificationResponse);

      const result = await service.classifyImage('/path/to/image.png');

      expect(result.type).toBe('form');
      expect(result.hasText).toBe(true);
      expect(result.textDensity).toBe('dense');
      expect(result.complexity).toBe('medium');
      expect(result.confidence).toBe(0.88);
    });

    it('should use low resolution for classification', async () => {
      mockClient.analyzeImage.mockResolvedValue(mockClassificationResponse);

      await service.classifyImage('/path/to/image.png');

      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[2].mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
    });
  });

  describe('describeImageBatch', () => {
    it('should process multiple images', async () => {
      const images = [
        { path: '/path/to/image1.png' },
        { path: '/path/to/image2.png' },
        { path: '/path/to/image3.png' },
      ];

      const results = await service.describeImageBatch(images, { concurrency: 2 });

      expect(results).toHaveLength(3);
      expect(mockClient.analyzeImage).toHaveBeenCalledTimes(3);
    });

    it('should respect concurrency limit', async () => {
      const images = Array.from({ length: 10 }, (_, i) => ({
        path: `/path/to/image${i}.png`,
      }));

      // Track call timing
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      mockClient.analyzeImage.mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(resolve => setTimeout(resolve, 10));
        currentConcurrent--;
        return mockAnalysisResponse;
      });

      await service.describeImageBatch(images, { concurrency: 3 });

      // Should not exceed concurrency of 3
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });
  });

  describe('getStatus', () => {
    it('should return client status', () => {
      const status = service.getStatus();

      expect(status.model).toBe('gemini-3-flash-preview');
      expect(status.tier).toBe('payAsYouGo');
      expect(status.circuitBreaker.state).toBe('CLOSED');
    });
  });

  describe('singleton management', () => {
    it('should return same instance from getVLMService', () => {
      resetVLMService();
      const service1 = getVLMService();
      const service2 = getVLMService();
      expect(service1).toBe(service2);
    });

    it('should create new instance after resetVLMService', () => {
      const service1 = getVLMService();
      resetVLMService();
      const service2 = getVLMService();
      expect(service1).not.toBe(service2);
    });
  });
});

describe('ImageAnalysis parsing', () => {
  let service: VLMService;
  let mockClient: { analyzeImage: Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    resetVLMService();
    mockFileRefFromPath.mockReturnValue({ mimeType: 'image/png', data: 'test', sizeBytes: 100 });
    service = new VLMService();
    mockClient = (service as unknown as { client: typeof mockClient }).client;
  });

  it('should handle JSON wrapped in markdown code blocks', async () => {
    mockClient.analyzeImage.mockResolvedValue({
      text: '```json\n{"imageType":"chart","confidence":0.85}\n```',
      usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, thinkingTokens: 0, totalTokens: 150 },
      model: 'gemini-3-flash-preview',
      processingTimeMs: 1000,
    });

    const result = await service.describeImage('/test.png');
    expect(result.analysis.imageType).toBe('chart');
    expect(result.analysis.confidence).toBe(0.85);
  });

  it('should provide defaults for missing fields', async () => {
    mockClient.analyzeImage.mockResolvedValue({
      text: '{"imageType":"document"}',
      usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, thinkingTokens: 0, totalTokens: 150 },
      model: 'gemini-3-flash-preview',
      processingTimeMs: 1000,
    });

    const result = await service.describeImage('/test.png');
    expect(result.analysis.imageType).toBe('document');
    expect(result.analysis.extractedText).toEqual([]);
    expect(result.analysis.dates).toEqual([]);
    expect(result.analysis.confidence).toBe(0.5); // Default
  });
});
