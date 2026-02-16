/**
 * Tests for QW-1 (thinkingConfig in analyzeImage), QW-7 (mediaResolution in buildGenerationConfig)
 *
 * Uses real GeminiClient class but mocks @google/genai to capture
 * the generation config passed to generateContent().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @google/genai BEFORE importing GeminiClient
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent,
      },
    })),
  };
});

import { GeminiClient } from '../../../src/services/gemini/client.js';
import { GENERATION_PRESETS } from '../../../src/services/gemini/config.js';

describe('GeminiClient analyzeImage options', () => {
  let client: GeminiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GeminiClient({ apiKey: 'test-key-for-mock' });

    // Default mock response - new SDK: text is a property, not a method
    mockGenerateContent.mockResolvedValue({
      text: '{"imageType":"test","primarySubject":"test"}',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 0,
        totalTokenCount: 150,
      },
    });
  });

  describe('QW-1: thinkingConfig wiring', () => {
    it('should NOT include responseMimeType when thinkingConfig is present', async () => {
      const fileRef = GeminiClient.fileRefFromBuffer(Buffer.from('fake-image-data'), 'image/png');

      await client.analyzeImage('test prompt', fileRef, {
        thinkingConfig: { thinkingLevel: 'HIGH' },
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      // thinkingConfig must be present
      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });

      // responseMimeType must NOT be present (incompatible with thinking)
      expect(generationConfig.responseMimeType).toBeUndefined();

      // responseSchema must NOT be present either
      expect(generationConfig.responseSchema).toBeUndefined();

      // temperature should be 0.0 for thinking mode
      expect(generationConfig.temperature).toBe(0.0);

      // maxOutputTokens should be 16384 for thinking mode
      expect(generationConfig.maxOutputTokens).toBe(16384);
    });

    it('should keep multimodal preset with JSON responseMimeType when thinkingConfig is absent', async () => {
      const fileRef = GeminiClient.fileRefFromBuffer(Buffer.from('fake-image-data'), 'image/png');

      const testSchema = { type: 'object', properties: { foo: { type: 'string' } } };

      await client.analyzeImage('test prompt', fileRef, {
        schema: testSchema,
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      // Should use multimodal preset with JSON output
      expect(generationConfig.responseMimeType).toBe('application/json');
      expect(generationConfig.responseSchema).toEqual(testSchema);

      // Temperature from multimodal preset
      expect(generationConfig.temperature).toBe(GENERATION_PRESETS.multimodal.temperature);

      // thinkingConfig must NOT be present
      expect(generationConfig.thinkingConfig).toBeUndefined();
    });

    it('should use MINIMAL thinking level when specified', async () => {
      const fileRef = GeminiClient.fileRefFromBuffer(Buffer.from('fake-image-data'), 'image/png');

      await client.analyzeImage('test prompt', fileRef, {
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
      expect(generationConfig.responseMimeType).toBeUndefined();
    });

    it('should pass mediaResolution through when thinkingConfig is present', async () => {
      const fileRef = GeminiClient.fileRefFromBuffer(Buffer.from('fake-image-data'), 'image/png');

      await client.analyzeImage('test prompt', fileRef, {
        thinkingConfig: { thinkingLevel: 'HIGH' },
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
      expect(generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH');
    });
  });

  describe('QW-7: mediaResolution in buildGenerationConfig', () => {
    it('should include mediaResolution in generation config when provided', async () => {
      const fileRef = GeminiClient.fileRefFromBuffer(Buffer.from('fake-image-data'), 'image/png');

      await client.analyzeImage('test prompt', fileRef, {
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      expect(generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH');
    });

    it('should include mediaResolution LOW in generation config', async () => {
      const fileRef = GeminiClient.fileRefFromBuffer(Buffer.from('fake-image-data'), 'image/png');

      await client.analyzeImage('test prompt', fileRef, {
        mediaResolution: 'MEDIA_RESOLUTION_LOW',
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      expect(generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
    });

    it('should use default mediaResolution from config when not specified in options', async () => {
      const fileRef = GeminiClient.fileRefFromBuffer(Buffer.from('fake-image-data'), 'image/png');

      // Do not pass mediaResolution -- client defaults to config.mediaResolution
      await client.analyzeImage('test prompt', fileRef, {});

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      // Default config mediaResolution is MEDIA_RESOLUTION_HIGH
      expect(generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH');
    });

    it('should NOT include mediaResolution in fast mode', async () => {
      // fast() does not pass mediaResolution
      await client.fast('test prompt');

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const generationConfig = callArgs.config;

      expect(generationConfig.mediaResolution).toBeUndefined();
    });
  });
});
