/**
 * Gemini API Configuration
 * Based on gemini-flash-3-dev-guide.md patterns
 */

import { z } from 'zod';

// Model IDs - gemini-3-flash-preview is the required model for ALL Gemini tasks.
// NEVER use gemini-2.0-flash or gemini-2.5-flash — constitution mandates gemini-3-flash only.
export const GEMINI_MODELS = {
  FLASH_3: 'gemini-3-flash-preview', // Required: 1M input, 65K output, thinking mode
} as const;

export type GeminiModelId = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS];

// Fixed rate limits for Gemini Flash API
export const GEMINI_RATE_LIMIT = {
  RPM: 1_000,
  TPM: 4_000_000,
} as const;

// Thinking levels for Gemini 3 (4 levels: minimal, low, medium, high)
export type ThinkingLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL';

// Generation modes from the guide
export type GeminiMode = 'fast' | 'thinking' | 'multimodal';

// Allowed MIME types for FileRef
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

// Max file size: 20MB
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

// Media resolution options
export type MediaResolution = 'MEDIA_RESOLUTION_HIGH' | 'MEDIA_RESOLUTION_LOW';

// Configuration schema
export const GeminiConfigSchema = z.object({
  apiKey: z.string().min(1, 'GEMINI_API_KEY is required'),
  model: z.string().default(GEMINI_MODELS.FLASH_3),

  // Generation defaults
  maxOutputTokens: z.number().default(8192),
  temperature: z.number().min(0).max(2).default(0.0),
  mediaResolution: z
    .enum(['MEDIA_RESOLUTION_HIGH', 'MEDIA_RESOLUTION_LOW'])
    .default('MEDIA_RESOLUTION_HIGH'),

  // Retry configuration (from guide: 3 retries, 500ms base)
  retry: z
    .object({
      maxAttempts: z.number().default(3),
      baseDelayMs: z.number().default(500),
      maxDelayMs: z.number().default(10000),
    })
    .default({}),

  // Circuit breaker (from guide: 5 failures, 60s recovery)
  circuitBreaker: z
    .object({
      failureThreshold: z.number().default(5),
      recoveryTimeMs: z.number().default(60000),
    })
    .default({}),
});

export type GeminiConfig = z.infer<typeof GeminiConfigSchema>;

/**
 * Load configuration from environment variables.
 *
 * Checks for GEMINI_API_KEY before Zod validation to provide a clear,
 * actionable error message instead of a cryptic Zod validation failure.
 */
export function loadGeminiConfig(overrides?: Partial<GeminiConfig>): GeminiConfig {
  const apiKey = overrides?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'GEMINI_API_KEY environment variable is not set. ' +
        'Set it in .env or environment to use Gemini features (VLM, evaluation, re-ranking).'
    );
  }

  const envConfig = {
    apiKey,
    model: process.env.GEMINI_MODEL || GEMINI_MODELS.FLASH_3,
    maxOutputTokens: process.env.GEMINI_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10)
      : 8192,
    temperature: process.env.GEMINI_TEMPERATURE ? parseFloat(process.env.GEMINI_TEMPERATURE) : 0.0,
    mediaResolution:
      (process.env.GEMINI_MEDIA_RESOLUTION as MediaResolution) || 'MEDIA_RESOLUTION_HIGH',
  };

  return GeminiConfigSchema.parse({ ...envConfig, ...overrides });
}

/**
 * Generation config presets from the guide
 */
export const GENERATION_PRESETS = {
  // Fast mode: <2s target, temperature 0.0, JSON output
  // Gemini 3 Flash defaults to HIGH thinking - must set MINIMAL when using JSON mode
  fast: {
    temperature: 0.0,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json' as const,
    thinkingConfig: { thinkingLevel: 'MINIMAL' as ThinkingLevel },
  },

  // Thinking mode: <8s target, extended reasoning
  thinking: (level: ThinkingLevel = 'HIGH') => ({
    temperature: 0.0,
    maxOutputTokens: 16384,
    thinkingConfig: { thinkingLevel: level },
  }),

  // Multimodal mode: 5-15s target
  // Gemini 3 Flash defaults to HIGH thinking which is incompatible with
  // responseMimeType: 'application/json', causing intermittent empty responses.
  // Explicitly set MINIMAL thinking to prevent this known API issue.
  multimodal: {
    temperature: 0.3,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json' as const,
    thinkingConfig: { thinkingLevel: 'MINIMAL' as ThinkingLevel },
  },

  // Fast mode also needs MINIMAL thinking to avoid empty JSON responses
  // from Gemini 3 Flash's default HIGH thinking conflicting with JSON output.
} as const;
