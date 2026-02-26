/**
 * Gemini API Client
 * Implements the client patterns from gemini-flash-3-dev-guide.md
 *
 * Modes:
 * - fast(): <2s target, temperature 0.0, JSON output
 * - thinking(): 3-8s target, extended reasoning with thinkingLevel
 * - multimodal(): 5-15s target, image/PDF analysis
 */

import { GoogleGenAI, type Part, type GenerateContentResponse } from '@google/genai';
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

/** Maximum number of entries in the in-memory context cache. */
const MAX_CACHE_SIZE = 50;

// ---- Shared singletons for rate limiting and circuit breaking ----
// These MUST be shared across all GeminiClient instances so that
// rate limits and circuit breaker state accumulate correctly.
let _sharedRateLimiter: GeminiRateLimiter | null = null;
let _sharedCircuitBreaker: CircuitBreaker | null = null;
let _sharedClient: GeminiClient | null = null;

function getSharedRateLimiter(): GeminiRateLimiter {
  if (!_sharedRateLimiter) {
    _sharedRateLimiter = new GeminiRateLimiter();
  }
  return _sharedRateLimiter;
}

function getSharedCircuitBreaker(config: {
  failureThreshold: number;
  recoveryTimeMs: number;
}): CircuitBreaker {
  if (!_sharedCircuitBreaker) {
    _sharedCircuitBreaker = new CircuitBreaker(config);
  }
  return _sharedCircuitBreaker;
}

/**
 * Get a shared GeminiClient singleton.
 * Use this instead of `new GeminiClient()` for default config.
 * Rate limiter and circuit breaker state persist across calls.
 */
export function getSharedClient(): GeminiClient {
  if (!_sharedClient) {
    _sharedClient = new GeminiClient();
  }
  return _sharedClient;
}

/** Reset all shared state (for testing) */
export function resetSharedClient(): void {
  _sharedRateLimiter = null;
  _sharedCircuitBreaker = null;
  _sharedClient = null;
}

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
  private readonly client: GoogleGenAI;
  private readonly config: GeminiConfig;
  private readonly rateLimiter: GeminiRateLimiter;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly _contextCache = new Map<
    string,
    { text: string; createdAt: number; ttlMs: number }
  >();

  constructor(configOverrides?: Partial<GeminiConfig>) {
    this.config = loadGeminiConfig(configOverrides);

    if (!this.config.apiKey) {
      throw new Error('GEMINI_API_KEY is required. Set it in .env file.');
    }

    this.client = new GoogleGenAI({
      apiKey: this.config.apiKey,
      httpOptions: { timeout: 600_000 },
    });

    // Use shared singletons so rate limits and circuit breaker state
    // accumulate across all callers (tools, services, etc.)
    this.rateLimiter = getSharedRateLimiter();
    this.circuitBreaker = getSharedCircuitBreaker({
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      recoveryTimeMs: this.config.circuitBreaker.recoveryTimeMs,
    });
  }

  /**
   * Fast mode: <2s target, temperature 0.0, JSON output
   * Use for quick analysis tasks
   *
   * @param prompt - Text prompt
   * @param schema - Optional JSON response schema
   * @param options - Optional overrides (e.g. maxOutputTokens for large structured extraction)
   */
  async fast(
    prompt: string,
    schema?: object,
    options?: { maxOutputTokens?: number; requestTimeout?: number }
  ): Promise<GeminiResponse> {
    return this.generate([{ text: prompt }], {
      ...GENERATION_PRESETS.fast,
      maxOutputTokens: options?.maxOutputTokens ?? GENERATION_PRESETS.fast.maxOutputTokens,
      responseSchema: schema,
      requestTimeout: options?.requestTimeout,
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
        // Estimate input size for logging
        const inputChars = parts.reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
        console.error(
          `[GeminiClient] Attempt ${attempt + 1}/${maxAttempts}: ${inputChars} input chars, maxOutputTokens=${options.maxOutputTokens ?? 'default'}`
        );

        const requestConfig = this.buildGenerationConfig(options);

        // Per-request timeout override via httpOptions
        if (options.requestTimeout) {
          requestConfig.httpOptions = { timeout: options.requestTimeout };
        }

        const response: GenerateContentResponse = await this.client.models.generateContent({
          model: this.config.model,
          contents: [{ role: 'user', parts }],
          config: requestConfig,
        });

        const text = response.text ?? '';
        const usageMetadata = response.usageMetadata;

        const usage: TokenUsage = {
          inputTokens: usageMetadata?.promptTokenCount ?? 0,
          outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
          cachedTokens: usageMetadata?.cachedContentTokenCount ?? 0,
          thinkingTokens: usageMetadata?.thoughtsTokenCount ?? 0,
          totalTokens: usageMetadata?.totalTokenCount ?? 0,
        };

        // Update rate limiter with actual usage
        this.rateLimiter.recordUsage(estimatedTokens, usage.totalTokens);

        // Gemini 3 Flash known issue: returns HTTP 200 with finishReason=STOP
        // but empty content parts or malformed JSON. Retry on bad responses
        // instead of returning garbage that will cause downstream parse failures.
        const hasJsonMode =
          options.responseMimeType === 'application/json' || options.responseSchema;

        if (!text || text.trim().length === 0) {
          if (hasJsonMode && attempt < maxAttempts - 1) {
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
            console.error(
              `[GeminiClient] Empty response from Gemini (attempt ${attempt + 1}/${maxAttempts}, ` +
                `inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}). ` +
                `Known Gemini 3 Flash issue. Retrying in ${delay}ms...`
            );
            await this.sleep(delay);
            continue;
          }
          // Last attempt or non-JSON mode: return whatever we got
          console.error(
            `[GeminiClient] Empty response on final attempt (${attempt + 1}/${maxAttempts}). ` +
              `inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}`
          );
        } else if (hasJsonMode && attempt < maxAttempts - 1) {
          // Validate JSON when JSON mode is active. Gemini sometimes returns
          // truncated or whitespace-padded JSON that passes the empty check
          // but fails JSON.parse. Retry instead of returning garbage.
          const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
          try {
            JSON.parse(cleaned);
          } catch (parseError) {
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
            console.error(
              `[GeminiClient] Malformed JSON response from Gemini (attempt ${attempt + 1}/${maxAttempts}, ` +
                `inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}, ` +
                `responseLength=${text.length}, parseError=${parseError instanceof Error ? parseError.message : String(parseError)}). Retrying in ${delay}ms...`
            );
            await this.sleep(delay);
            continue;
          }
        } else if (hasJsonMode && attempt === maxAttempts - 1) {
          // Last attempt: still validate JSON but don't retry - just log the failure
          const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
          try {
            JSON.parse(cleaned);
          } catch (parseError) {
            console.error(
              `[GeminiClient] Final attempt (${attempt + 1}/${maxAttempts}) returned invalid JSON. ` +
                `responseLength=${text.length}, ` +
                `parseError=${parseError instanceof Error ? parseError.message : String(parseError)}, ` +
                `responsePreview=${JSON.stringify(text.slice(0, 200))}`
            );
            // Don't retry, let caller's parser attempt more robust extraction
          }
        }

        return { text, usage, model: this.config.model };
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message || String(error);

        // Log detailed cause chain for network errors
        const cause = (error as { cause?: Error })?.cause;
        const causeMsg = cause ? ` cause=${cause.message || cause.constructor?.name}` : '';
        const causeCode = (cause as { code?: string })?.code
          ? ` code=${(cause as { code?: string }).code}`
          : '';
        console.error(
          `[GeminiClient] Attempt ${attempt + 1}/${maxAttempts} failed: ${errorMessage}${causeMsg}${causeCode}`
        );

        // Check for rate limit error (429) or server errors (500/502/503).
        // These all indicate server-side issues and get extended backoff.
        const isServerStatus =
          /\b(429|500|502|503)\b/.test(errorMessage) ||
          errorMessage.toLowerCase().includes('rate limit') ||
          /server.?(error|overloaded|unavailable)|service.?unavailable|internal.?server/i.test(
            errorMessage
          );

        if (isServerStatus) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt + 1), maxDelayMs);
          const statusMatch = errorMessage.match(/\b(429|500|502|503)\b/);
          const label = statusMatch ? `HTTP ${statusMatch[1]}` : 'server error';
          console.error(`[GeminiClient] ${label}, waiting ${delay}ms`);
          await this.sleep(delay);
          continue;
        }

        // Check for context length error - don't retry
        if (errorMessage.toLowerCase().includes('context length')) {
          throw new Error('Context length exceeded. Consider batching the request.');
        }

        // Network errors get longer retry delays
        const isNetworkError = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(
          `${errorMessage} ${cause?.message ?? ''}`
        );

        if (attempt < maxAttempts - 1) {
          const multiplier = isNetworkError ? 3 : 1;
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt) * multiplier, maxDelayMs);
          console.error(
            `[GeminiClient] ${isNetworkError ? 'Network error, ' : ''}retrying in ${delay}ms`
          );
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
      if (part.text) {
        textLength += part.text.length;
      } else if (part.inlineData) {
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
          `Install inkscape (apt install inkscape) or imagemagick (apt install imagemagick) ` +
          `in the container. The image extraction pipeline converts EMF/WMF to PNG ` +
          `automatically when either tool is available.`
      );
    }

    // Block scope lets buffer be GC'd before the base64 string is returned,
    // avoiding ~2.33x file-size peak memory per call.
    let sizeBytes: number;
    let data: string;
    {
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${buffer.length} bytes. Max: ${MAX_FILE_SIZE} (20MB)`);
      }
      sizeBytes = buffer.length;
      data = buffer.toString('base64');
    }

    return { mimeType, data, sizeBytes };
  }

  /**
   * Create FileRef from a buffer
   */
  static fileRefFromBuffer(buffer: Buffer, mimeType: AllowedMimeType): FileRef {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error(
        `Unsupported MIME type: ${mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`
      );
    }

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${buffer.length} bytes. Max: ${MAX_FILE_SIZE} (20MB)`);
    }

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
      throw new Error(
        'Context text too short for caching (minimum ~4096 characters / 1024 tokens). Use direct generation instead.'
      );
    }

    // Periodic TTL cleanup: evict any expired entries before adding new ones
    this.cleanExpiredCacheEntries();

    // Evict oldest entry if at capacity
    if (this._contextCache.size >= MAX_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this._contextCache) {
        if (entry.createdAt < oldestTime) {
          oldestTime = entry.createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this._contextCache.delete(oldestKey);
        console.error(
          `[GeminiClient] Cache at capacity (${MAX_CACHE_SIZE}), evicted oldest entry: ${oldestKey}`
        );
      }
    }

    const cacheId = `cache_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Store context in memory for this session
    this._contextCache.set(cacheId, {
      text: contextText,
      createdAt: Date.now(),
      ttlMs: ttlSeconds * 1000,
    });

    console.error(
      `[GeminiClient] Created context cache ${cacheId} (${contextText.length} chars, TTL ${ttlSeconds}s, size=${this._contextCache.size}/${MAX_CACHE_SIZE})`
    );
    return cacheId;
  }

  /**
   * Remove all expired entries from the context cache.
   * Called as periodic cleanup when createCachedContent is invoked.
   */
  private cleanExpiredCacheEntries(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this._contextCache) {
      if (now - entry.createdAt > entry.ttlMs) {
        this._contextCache.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      console.error(`[GeminiClient] TTL cleanup: evicted ${evicted} expired cache entries`);
    }
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
      throw new Error(
        `Cache not found: ${cacheId}. Create a cache first with createCachedContent().`
      );
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
    requests: Array<{
      prompt: string;
      file: FileRef;
      options?: { schema?: object; mediaResolution?: MediaResolution };
    }>,
    onProgress?: (completed: number, total: number) => void
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
  /** Per-request timeout in ms. Default: 600_000 (10 min). */
  requestTimeout?: number;
}
