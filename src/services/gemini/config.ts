/**
 * Gemini API Configuration
 * Based on gemini-flash-3-dev-guide.md patterns
 */

import { z } from 'zod';

// Model IDs from the guide
export const GEMINI_MODELS = {
  FLASH_2: 'gemini-2.0-flash',
  FLASH_3: 'gemini-3-flash-preview',
  PRO: 'gemini-2.5-pro',
} as const;

export type GeminiModelId = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS];

// Subscription tiers with rate limits (December 2025 - Official)
export const RATE_LIMITS = {
  free: {
    flashRPM: 15,
    flashTPM: 1_000_000,
    flashRPD: 1_500,
    proRPM: 5,
    proRPD: 100,
  },
  payAsYouGo: {
    flashRPM: 1_000,
    flashTPM: 4_000_000,
    flashRPD: 10_000,
    proRPM: 150,
    proRPD: 10_000,
  },
  enterprise: {
    flashRPM: 2_000,
    flashTPM: 4_000_000,
    flashRPD: Infinity,
    proRPM: 1_000,
    proRPD: Infinity,
  },
} as const;

export type SubscriptionTier = keyof typeof RATE_LIMITS;

// Thinking levels for Gemini 3
export type ThinkingLevel = 'HIGH' | 'MINIMAL';

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
  model: z.enum([GEMINI_MODELS.FLASH_2, GEMINI_MODELS.FLASH_3, GEMINI_MODELS.PRO]).default(GEMINI_MODELS.FLASH_3),
  tier: z.enum(['free', 'payAsYouGo', 'enterprise']).default('payAsYouGo'),

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
 * Load configuration from environment variables
 */
export function loadGeminiConfig(overrides?: Partial<GeminiConfig>): GeminiConfig {
  const envConfig = {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || GEMINI_MODELS.FLASH_3,
    tier: (process.env.GEMINI_TIER as SubscriptionTier) || 'payAsYouGo',
    maxOutputTokens: process.env.GEMINI_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10)
      : 8192,
    temperature: process.env.GEMINI_TEMPERATURE
      ? parseFloat(process.env.GEMINI_TEMPERATURE)
      : 0.0,
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
  fast: {
    temperature: 0.0,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json' as const,
  },

  // Thinking mode: <8s target, extended reasoning
  thinking: (level: ThinkingLevel = 'HIGH') => ({
    temperature: 0.0,
    maxOutputTokens: 16384,
    thinkingConfig: { thinkingLevel: level },
  }),

  // Multimodal mode: 5-15s target
  multimodal: {
    temperature: 0.3,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json' as const,
  },
} as const;

