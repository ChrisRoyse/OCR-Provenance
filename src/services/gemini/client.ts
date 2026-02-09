/**
 * Gemini API Client
 * Implements the client patterns from gemini-flash-3-dev-guide.md
 *
 * Modes:
 * - fast(): <2s target, temperature 0.0, JSON output
 * - thinking(): 3-8s target, extended reasoning with thinkingLevel
 * - multimodal(): 5-15s target, image/PDF analysis
 */

import { GoogleGenerativeAI, type GenerativeModel, type Part } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

import {
  type GeminiConfig,
  loadGeminiConfig,
  GENERATION_PRESETS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  type ThinkingLevel,
  type AllowedMimeType,
  type MediaResolution,
} from './config.js';
import { GeminiRateLimiter, estimateTokens } from './rate-limiter.js';
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker.js';

// Re-export error type
export { CircuitBreakerOpenError };

/**
 * Token usage from a Gemini response
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

/**
 * Response from Gemini API
 */
export interface GeminiResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  processingTimeMs: number;
}

/**
 * File reference for multimodal requests
 */
export interface FileRef {
  mimeType: AllowedMimeType;
  data: string; // Base64 encoded
  sizeBytes: number;
}

/**
 * Gemini Client with rate limiting and circuit breaker
 */
export class GeminiClient {
  private readonly client: GoogleGenerativeAI;
  private readonly model: GenerativeModel;
  private readonly config: GeminiConfig;
  private readonly rateLimiter: GeminiRateLimiter;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly _contextCache = new Map<string, { text: string; createdAt: number; ttlMs: number }>();

  constructor(configOverrides?: Partial<GeminiConfig>) {
    this.config = loadGeminiConfig(configOverrides);

    if (!this.config.apiKey) {
      throw new Error('GEMINI_API_KEY is required. Set it in .env file.');
    }

    this.client = new GoogleGenerativeAI(this.config.apiKey);
    this.model = this.client.getGenerativeModel({ model: this.config.model });

    this.rateLimiter = new GeminiRateLimiter(this.config.tier);
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      recoveryTimeMs: this.config.circuitBreaker.recoveryTimeMs,
    });
  }

  /**
   * Fast mode: <2s target, temperature 0.0, JSON output
   * Use for quick analysis tasks
   */
  async fast(prompt: string, schema?: object): Promise<GeminiResponse> {
    return this.generate([{ text: prompt }], {
      ...GENERATION_PRESETS.fast,
      responseSchema: schema,
    });
  }

  /**
   * Thinking mode: 3-8s target, extended reasoning
   * Uses Gemini 3's thinkingLevel (HIGH or MINIMAL)
   */
  async thinking(prompt: string, level: ThinkingLevel = 'HIGH'): Promise<GeminiResponse> {
    const preset = GENERATION_PRESETS.thinking(level);
    return this.generate([{ text: prompt }], preset);
  }

  /**
   * Multimodal mode: analyze image with prompt
   * 5-15s target, supports images and PDFs
   */
  async analyzeImage(
    prompt: string,
    file: FileRef,
    options: {
      schema?: object;
      mediaResolution?: MediaResolution;
      thinkingConfig?: { thinkingLevel: ThinkingLevel };
    } = {}
  ): Promise<GeminiResponse> {
    const parts: Part[] = [
      { text: prompt },
      {
        inlineData: {
          mimeType: file.mimeType,
          data: file.data,
        },
      },
    ];

    const mediaResolution = options.mediaResolution || this.config.mediaResolution;

    // When thinkingConfig is present, do NOT use the multimodal preset
    // because its responseMimeType: 'application/json' is incompatible
    // with thinking mode. Use a minimal config instead.
    if (options.thinkingConfig) {
      return this.generate(parts, {
        temperature: 0.0,
        maxOutputTokens: 16384,
        thinkingConfig: options.thinkingConfig,
        mediaResolution,
      });
    }

    return this.generate(parts, {
      ...GENERATION_PRESETS.multimodal,
      responseSchema: options.schema,
      mediaResolution,
    });
  }

  /**
   * Analyze a PDF document
   */
  async analyzePDF(prompt: string, file: FileRef, schema?: object): Promise<GeminiResponse> {
    if (file.mimeType !== 'application/pdf') {
      throw new Error('File must be a PDF (application/pdf)');
    }

    return this.analyzeImage(prompt, file, {
      schema,
      mediaResolution: 'MEDIA_RESOLUTION_HIGH', // Always high for PDFs
    });
  }

  /**
   * Core generation method with retry logic
   */
  private async generate(parts: Part[], options: GenerationOptions): Promise<GeminiResponse> {
    const startTime = Date.now();

    // Estimate tokens for rate limiting
    const estimatedTokens = this.estimateRequestTokens(parts, options.mediaResolution);

    // Acquire rate limit
    await this.rateLimiter.acquire(estimatedTokens);

    // Execute with circuit breaker and retry
    const response = await this.circuitBreaker.execute(() =>
      this.executeWithRetry(parts, options, estimatedTokens)
    );

    return {
      ...response,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute request with exponential backoff retry
   */
  private async executeWithRetry(
    parts: Part[],
    options: GenerationOptions,
    estimatedTokens: number
  ): Promise<Omit<GeminiResponse, 'processingTimeMs'>> {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.config.retry;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.model.generateContent({
          contents: [{ role: 'user', parts }],
          generationConfig: this.buildGenerationConfig(options),
        });

        const text = result.response.text();
        const usageMetadata = result.response.usageMetadata;

        // Extract thinking tokens if available (Gemini 3 feature)
        const usageAny = usageMetadata as Record<string, unknown> | undefined;
        const thinkingTokens = typeof usageAny?.thoughtsTokenCount === 'number'
          ? usageAny.thoughtsTokenCount
          : 0;

        const usage: TokenUsage = {
          inputTokens: usageMetadata?.promptTokenCount ?? 0,
          outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
          cachedTokens: usageMetadata?.cachedContentTokenCount ?? 0,
          thinkingTokens,
          totalTokens: usageMetadata?.totalTokenCount ?? 0,
        };

        // Update rate limiter with actual usage
        this.rateLimiter.recordUsage(estimatedTokens, usage.totalTokens);

        return { text, usage, model: this.config.model };
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message || String(error);

        console.warn(`[GeminiClient] Attempt ${attempt + 1}/${maxAttempts} failed: ${errorMessage}`);

        // Check for rate limit error (429)
        if (errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate limit')) {
          // Wait longer for rate limit errors
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt + 1), maxDelayMs);
          console.error(`[GeminiClient] Rate limited, waiting ${delay}ms`);
          await this.sleep(delay);
          continue;
        }

        // Check for context length error - don't retry
        if (errorMessage.toLowerCase().includes('context length')) {
          throw new Error('Context length exceeded. Consider batching the request.');
        }

        // For other errors, use exponential backoff
        if (attempt < maxAttempts - 1) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
          console.error(`[GeminiClient] Retrying in ${delay}ms`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('All retry attempts failed');
  }

  /**
   * Build generation config from options
   */
  private buildGenerationConfig(options: GenerationOptions): Record<string, unknown> {
    const config: Record<string, unknown> = {
      temperature: options.temperature ?? this.config.temperature,
      maxOutputTokens: options.maxOutputTokens ?? this.config.maxOutputTokens,
    };

    if (options.responseMimeType) {
      config.responseMimeType = options.responseMimeType;
    }

    if (options.responseSchema) {
      config.responseSchema = options.responseSchema;
    }

    if (options.thinkingConfig) {
      config.thinkingConfig = options.thinkingConfig;
    }

    if (options.mediaResolution) {
      config.mediaResolution = options.mediaResolution;
    }

    return config;
  }

  /**
   * Estimate tokens for a request
   */
  private estimateRequestTokens(parts: Part[], mediaResolution?: MediaResolution): number {
    let textLength = 0;
    let imageCount = 0;

    for (const part of parts) {
      if ('text' in part && part.text) {
        textLength += part.text.length;
      } else if ('inlineData' in part) {
        imageCount++;
      }
    }

    const highRes = mediaResolution !== 'MEDIA_RESOLUTION_LOW';
    return estimateTokens(textLength, imageCount, highRes);
  }

  /**
   * Create FileRef from a file path
   */
  static fileRefFromPath(filePath: string): FileRef {
    const ext = path.extname(filePath).toLowerCase().slice(1);

    const mimeTypes: Record<string, AllowedMimeType> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error(
        `Unsupported image format for VLM: '${ext}' (file: ${path.basename(filePath)}). ` +
        `Gemini accepts: png, jpg, jpeg, gif, webp, pdf. ` +
        `To convert EMF/WMF images, install LibreOffice: sudo apt install libreoffice-core`
      );
    }

    // C-2 fix: Use block scope so buffer is eligible for GC before return.
    // Without this, buffer (raw bytes) and data (base64, 33% larger) coexist
    // in the same scope, causing ~2.33x file size peak memory per call.
    let sizeBytes: number;
    let data: string;
    {
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${buffer.length} bytes. Max: ${MAX_FILE_SIZE} (20MB)`);
      }
      sizeBytes = buffer.length;
      data = buffer.toString('base64');
      // buffer goes out of scope here, eligible for GC
    }

    return { mimeType, data, sizeBytes };
  }

  /**
   * Create FileRef from a buffer
   */
  static fileRefFromBuffer(buffer: Buffer, mimeType: AllowedMimeType): FileRef {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error(`Unsupported MIME type: ${mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${buffer.length} bytes. Max: ${MAX_FILE_SIZE} (20MB)`);
    }

    // C-2 fix: Capture sizeBytes before base64 conversion so callers who
    // release their buffer reference after this call benefit from earlier GC.
    const sizeBytes = buffer.length;
    const data = buffer.toString('base64');

    return { mimeType, data, sizeBytes };
  }

  /**
   * Create cached content for document context.
   * Used when processing multiple images from the same document -
   * cache the OCR text context once, then reference it for each image.
   *
   * @param contextText - Document OCR text to cache
   * @param ttlSeconds - Cache TTL in seconds (default: 3600 = 1 hour)
   * @returns Cache identifier for use with generateWithCache()
   */
  async createCachedContent(contextText: string, ttlSeconds: number = 3600): Promise<string> {
    // Gemini Caching API requires minimum 1024 tokens (~4096 chars)
    if (contextText.length < 4096) {
      throw new Error('Context text too short for caching (minimum ~4096 characters / 1024 tokens). Use direct generation instead.');
    }

    const cacheId = `cache_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Store context in memory for this session
    this._contextCache.set(cacheId, {
      text: contextText,
      createdAt: Date.now(),
      ttlMs: ttlSeconds * 1000,
    });

    console.error(`[GeminiClient] Created context cache ${cacheId} (${contextText.length} chars, TTL ${ttlSeconds}s)`);
    return cacheId;
  }

  /**
   * Generate content using cached context + new image.
   * Prepends cached text context to the image analysis prompt.
   */
  async generateWithCache(
    cacheId: string,
    prompt: string,
    file: FileRef,
    options: { schema?: object; mediaResolution?: MediaResolution } = {}
  ): Promise<GeminiResponse> {
    const cached = this._contextCache.get(cacheId);
    if (!cached) {
      throw new Error(`Cache not found: ${cacheId}. Create a cache first with createCachedContent().`);
    }

    // Check TTL
    if (Date.now() - cached.createdAt > cached.ttlMs) {
      this._contextCache.delete(cacheId);
      throw new Error(`Cache expired: ${cacheId}. Recreate with createCachedContent().`);
    }

    // Prepend cached context to prompt
    const contextualPrompt = `Document context (from OCR):\n${cached.text.slice(0, 8000)}\n\n${prompt}`;
    return this.analyzeImage(contextualPrompt, file, options);
  }

  /**
   * Delete a cached context
   */
  deleteCachedContent(cacheId: string): boolean {
    return this._contextCache.delete(cacheId);
  }

  /**
   * Process multiple image analysis requests efficiently.
   * Handles rate limiting and provides progress tracking.
   * NOT true async batch API (Gemini async batch requires server-side setup) -
   * this is sequential with optimal rate limiting.
   */
  async batchAnalyzeImages(
    requests: Array<{ prompt: string; file: FileRef; options?: { schema?: object; mediaResolution?: MediaResolution } }>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<Array<{ index: number; result?: GeminiResponse; error?: string }>> {
    const results: Array<{ index: number; result?: GeminiResponse; error?: string }> = [];

    for (let i = 0; i < requests.length; i++) {
      try {
        const result = await this.analyzeImage(
          requests[i].prompt,
          requests[i].file,
          requests[i].options || {}
        );
        results.push({ index: i, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[GeminiClient] Batch item ${i}/${requests.length} failed: ${message}`);
        results.push({ index: i, error: message });
      }

      onProgress?.(i + 1, requests.length);
    }

    return results;
  }

  /**
   * Get client status (rate limiter + circuit breaker)
   */
  getStatus() {
    return {
      model: this.config.model,
      tier: this.config.tier,
      rateLimiter: this.rateLimiter.getStatus(),
      circuitBreaker: this.circuitBreaker.getStatus(),
    };
  }

  /**
   * Reset rate limiter and circuit breaker (for testing)
   */
  reset(): void {
    this.rateLimiter.reset();
    this.circuitBreaker.reset();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Internal generation options
 */
interface GenerationOptions {
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: 'application/json' | 'text/plain';
  responseSchema?: object;
  thinkingConfig?: { thinkingLevel: ThinkingLevel };
  mediaResolution?: MediaResolution;
}
