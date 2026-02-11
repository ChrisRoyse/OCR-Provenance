/**
 * Gemini API Service
 * Exports client and configuration for Gemini API integration
 */

// Client
export {
  GeminiClient,
  type GeminiResponse,
  type FileRef,
  CircuitBreakerOpenError,
} from './client.js';

// Configuration
export {
  type GeminiConfig,
  loadGeminiConfig,
  GEMINI_MODELS,
  RATE_LIMITS,
  GENERATION_PRESETS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  type SubscriptionTier,
  type ThinkingLevel,
} from './config.js';

// Rate Limiter
export {
  GeminiRateLimiter,
  estimateTokens,
} from './rate-limiter.js';

// Circuit Breaker
export {
  CircuitBreaker,
} from './circuit-breaker.js';
