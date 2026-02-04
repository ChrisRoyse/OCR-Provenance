/**
 * Gemini API Service
 * Exports client and configuration for Gemini API integration
 */

// Client
export {
  GeminiClient,
  type GeminiResponse,
  type TokenUsage,
  type FileRef,
  CircuitBreakerOpenError,
} from './client.js';

// Configuration
export {
  type GeminiConfig,
  GeminiConfigSchema,
  loadGeminiConfig,
  GEMINI_MODELS,
  RATE_LIMITS,
  GENERATION_PRESETS,
  MODEL_INFO,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  type GeminiModelId,
  type SubscriptionTier,
  type ThinkingLevel,
  type GeminiMode,
  type AllowedMimeType,
  type MediaResolution,
} from './config.js';

// Rate Limiter
export {
  GeminiRateLimiter,
  estimateTokens,
  type RateLimiterStatus,
} from './rate-limiter.js';

// Circuit Breaker
export {
  CircuitBreaker,
  CircuitState,
  type CircuitBreakerConfig,
  type CircuitBreakerStatus,
} from './circuit-breaker.js';
