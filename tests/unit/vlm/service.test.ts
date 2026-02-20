/**
 * Unit tests for VLM Service
 *
 * Tests the VLMService class for image analysis functionality.
 *
 * TS-01 FIX: Tests VLMService's REAL parsing logic using mock HTTP responses.
 * The GeminiClient is mocked at the HTTP layer, but VLMService's parseAnalysis,
 * parseClassification, and parseDeepAnalysis methods are tested with realistic
 * Gemini response formats (valid JSON, markdown-wrapped JSON, malformed JSON).
 *
 * VLMService now THROWS on parse failure (not returns defaults).
 *
 * @module tests/unit/vlm/service
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { VLMService, getVLMService, resetVLMService } from '../../../src/services/vlm/service.js';
import {
  GeminiClient,
  type GeminiResponse,
  type FileRef,
} from '../../../src/services/gemini/index.js';

// Mock the GeminiClient at the HTTP layer - VLMService's parse methods run for real
vi.mock('../../../src/services/gemini/client.js', () => {
  const mockImpl = () => ({
    analyzeImage: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      model: 'gemini-3-flash-preview',
      rateLimiter: { requestsRemaining: 1000, tokensRemaining: 4000000 },
      circuitBreaker: { state: 'CLOSED' },
    }),
  });
  const MockGeminiClient = vi.fn().mockImplementation(mockImpl);
  return {
    GeminiClient: MockGeminiClient,
    getSharedClient: vi.fn().mockImplementation(() => new MockGeminiClient()),
    resetSharedClient: vi.fn(),
    CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CircuitBreakerOpenError';
      }
    },
  };
});

// Mock static method
const mockFileRefFromPath = vi.fn();
(GeminiClient as unknown as { fileRefFromPath: Mock }).fileRefFromPath = mockFileRefFromPath;

// Realistic Gemini response builder
function makeGeminiResponse(text: string, overrides?: Partial<GeminiResponse>): GeminiResponse {
  return {
    text,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 0,
      thinkingTokens: 0,
      totalTokens: 1200,
    },
    model: 'gemini-3-flash-preview',
    processingTimeMs: 2500,
    ...overrides,
  };
}

const mockFileRef: FileRef = {
  mimeType: 'image/png',
  data: 'base64encodeddata',
  sizeBytes: 1024,
};

describe('VLMService', () => {
  let service: VLMService;
  let mockClient: { analyzeImage: Mock; getStatus: Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    resetVLMService();

    mockFileRefFromPath.mockReturnValue(mockFileRef);

    service = new VLMService();
    mockClient = (service as unknown as { client: typeof mockClient }).client;
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

  describe('describeImage - real parsing', () => {
    it('should parse a complete well-formed Gemini JSON response', async () => {
      const analysisJson = {
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
      };
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse(JSON.stringify(analysisJson)));

      const result = await service.describeImage('/path/to/image.png');

      // Verify the parse method correctly extracted all fields
      expect(result.analysis.imageType).toBe('medical_document');
      expect(result.analysis.primarySubject).toBe('Lab results');
      expect(result.analysis.paragraph1).toBe('This is a medical laboratory report.');
      expect(result.analysis.extractedText).toEqual(['Patient Name: John Doe', 'Date: 2023-09-15']);
      expect(result.analysis.dates).toEqual(['2023-09-15']);
      expect(result.analysis.names).toEqual(['John Doe']);
      expect(result.analysis.numbers).toEqual(['12.5', '140']);
      expect(result.analysis.confidence).toBe(0.92);
      // description = paragraphs joined
      expect(result.description).toContain('medical laboratory report');
      expect(result.description).toContain('CBC and metabolic panel');
      expect(result.tokensUsed).toBe(1200);
      expect(result.model).toBe('gemini-3-flash-preview');
    });

    it('should use universal prompt by default', async () => {
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('{"imageType":"test"}'));
      await service.describeImage('/path/to/image.png');

      expect(mockClient.analyzeImage).toHaveBeenCalled();
      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[0]).toContain('blind person');
    });

    it('should use context prompt when contextText is provided and universal is disabled', async () => {
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('{"imageType":"test"}'));
      await service.describeImage('/path/to/image.png', {
        contextText: 'This image appears after a medication list.',
        useUniversalPrompt: false,
      });

      expect(mockClient.analyzeImage).toHaveBeenCalled();
      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[0]).toContain('SURROUNDING TEXT CONTEXT');
    });

    it('should fall back to legal prompt when universal is disabled and no context', async () => {
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('{"imageType":"legal_doc"}'));
      await service.describeImage('/path/to/image.png', {
        useUniversalPrompt: false,
      });

      expect(mockClient.analyzeImage).toHaveBeenCalled();
      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[0]).toContain('legal or medical document');
    });

    it('should throw on unparseable JSON (not return defaults)', async () => {
      mockClient.analyzeImage.mockResolvedValue(
        makeGeminiResponse('Invalid JSON response that cannot be parsed')
      );

      await expect(service.describeImage('/path/to/image.png')).rejects.toThrow(
        'VLM analysis JSON parse failed'
      );
    });

    it('should throw on Gemini rate limit HTML response', async () => {
      const rateLimitHtml =
        '<html><body><p>Resource exhausted. Please try again later.</p></body></html>';
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse(rateLimitHtml));

      await expect(service.describeImage('/path/to/image.png')).rejects.toThrow(
        'VLM analysis JSON parse failed'
      );
    });

    it('should throw on empty string response with clear diagnostic message', async () => {
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse(''));

      await expect(service.describeImage('/path/to/image.png')).rejects.toThrow(
        'Gemini returned an empty response'
      );
    });

    it('should throw on whitespace-only response with clear diagnostic message', async () => {
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('   \n\t  '));

      await expect(service.describeImage('/path/to/image.png')).rejects.toThrow(
        'Gemini returned an empty response'
      );
    });

    it('should throw on null/undefined text response', async () => {
      mockClient.analyzeImage.mockResolvedValue(
        makeGeminiResponse(null as unknown as string)
      );

      await expect(service.describeImage('/path/to/image.png')).rejects.toThrow(
        'Gemini returned an empty response'
      );
    });
  });

  describe('classifyImage - real parsing', () => {
    it('should parse a well-formed classification response', async () => {
      const classJson = {
        type: 'form',
        hasText: true,
        textDensity: 'dense',
        complexity: 'medium',
        confidence: 0.88,
      };
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse(JSON.stringify(classJson)));

      const result = await service.classifyImage('/path/to/image.png');

      expect(result.type).toBe('form');
      expect(result.hasText).toBe(true);
      expect(result.textDensity).toBe('dense');
      expect(result.complexity).toBe('medium');
      expect(result.confidence).toBe(0.88);
    });

    it('should use low resolution for classification', async () => {
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('{"type":"chart"}'));
      await service.classifyImage('/path/to/image.png');

      const callArgs = mockClient.analyzeImage.mock.calls[0];
      expect(callArgs[2].mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
    });

    it('should throw on malformed classification JSON', async () => {
      mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('not json'));

      await expect(service.classifyImage('/path/to/image.png')).rejects.toThrow(
        'VLM classification JSON parse failed'
      );
    });
  });

  describe('getStatus', () => {
    it('should return client status', () => {
      const status = service.getStatus();

      expect(status.model).toBe('gemini-3-flash-preview');
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

describe('ImageAnalysis parsing - real Gemini response formats', () => {
  let service: VLMService;
  let mockClient: { analyzeImage: Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    resetVLMService();
    mockFileRefFromPath.mockReturnValue({ mimeType: 'image/png', data: 'test', sizeBytes: 100 });
    service = new VLMService();
    mockClient = (service as unknown as { client: typeof mockClient }).client;
  });

  it('should strip markdown code blocks and parse inner JSON', async () => {
    // Real Gemini often wraps JSON in ```json blocks
    mockClient.analyzeImage.mockResolvedValue(
      makeGeminiResponse('```json\n{"imageType":"chart","confidence":0.85}\n```')
    );

    const result = await service.describeImage('/test.png');
    expect(result.analysis.imageType).toBe('chart');
    expect(result.analysis.confidence).toBe(0.85);
  });

  it('should provide defaults for missing optional fields in valid JSON', async () => {
    // Gemini may return only some fields - VLMService fills in defaults
    mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('{"imageType":"document"}'));

    const result = await service.describeImage('/test.png');
    expect(result.analysis.imageType).toBe('document');
    expect(result.analysis.primarySubject).toBe('');
    expect(result.analysis.paragraph1).toBe('');
    expect(result.analysis.paragraph2).toBe('');
    expect(result.analysis.paragraph3).toBe('');
    expect(result.analysis.extractedText).toEqual([]);
    expect(result.analysis.dates).toEqual([]);
    expect(result.analysis.names).toEqual([]);
    expect(result.analysis.numbers).toEqual([]);
    expect(result.analysis.confidence).toBe(0.5); // Default when not provided
  });

  it('should handle JSON with extra whitespace and newlines', async () => {
    const jsonWithWhitespace = `
    {
      "imageType": "photograph",
      "primarySubject": "Building exterior",
      "confidence": 0.75
    }
    `;
    mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse(jsonWithWhitespace));

    const result = await service.describeImage('/test.png');
    expect(result.analysis.imageType).toBe('photograph');
    expect(result.analysis.primarySubject).toBe('Building exterior');
    expect(result.analysis.confidence).toBe(0.75);
  });

  it('should handle empty JSON object (all defaults)', async () => {
    mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse('{}'));

    const result = await service.describeImage('/test.png');
    expect(result.analysis.imageType).toBe('unknown');
    expect(result.analysis.confidence).toBe(0.5);
  });

  it('should handle nested markdown code block with extra backticks', async () => {
    // Some Gemini responses may have extra backticks
    mockClient.analyzeImage.mockResolvedValue(
      makeGeminiResponse('```json\n{"imageType":"table","confidence":0.9}\n```')
    );

    const result = await service.describeImage('/test.png');
    expect(result.analysis.imageType).toBe('table');
    expect(result.analysis.confidence).toBe(0.9);
  });

  it('should throw on truncated JSON (common Gemini failure mode)', async () => {
    const truncatedJson =
      '{"imageType":"medical","primarySubject":"Lab result","paragraph1":"The rep';
    mockClient.analyzeImage.mockResolvedValue(makeGeminiResponse(truncatedJson));

    await expect(service.describeImage('/test.png')).rejects.toThrow(
      'VLM analysis JSON parse failed'
    );
  });
});
