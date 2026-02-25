/**
 * Exponential Backoff with Jitter
 *
 * Replaces fixed waits for rate limits with exponential backoff.
 * Base delay doubles each attempt: 1s, 2s, 4s, 8s, 16s (capped at 30s).
 * Jitter adds +/-25% randomness to prevent thundering herd.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module utils/backoff
 */

export interface BackoffConfig {
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Jitter fraction +/- (default: 0.25 = +/-25%) */
  jitterFraction: number;
}

const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 3,
  jitterFraction: 0.25,
};

/**
 * Calculate delay for a given attempt (0-indexed) with jitter.
 *
 * Formula: min(baseDelay * 2^attempt, maxDelay) +/- jitter
 *
 * @param attempt - Zero-indexed attempt number
 * @param config - Optional partial backoff configuration
 * @returns Delay in milliseconds (always >= 0)
 */
export function calculateBackoffDelay(attempt: number, config?: Partial<BackoffConfig>): number {
  const cfg = { ...DEFAULT_BACKOFF, ...config };
  const exponentialDelay = cfg.baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, cfg.maxDelayMs);

  // Add jitter: +/-jitterFraction
  const jitterRange = cappedDelay * cfg.jitterFraction;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Sleep for the backoff duration.
 *
 * @param attempt - Zero-indexed attempt number
 * @param config - Optional partial backoff configuration
 * @returns Promise that resolves after the delay
 */
export function backoffSleep(attempt: number, config?: Partial<BackoffConfig>): Promise<void> {
  const delay = calculateBackoffDelay(attempt, config);
  console.error(`[Backoff] Attempt ${attempt + 1}: waiting ${delay}ms`);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Execute a function with automatic retry and exponential backoff.
 *
 * Retries on errors that pass the shouldRetry predicate, up to maxAttempts.
 * Non-retryable errors are re-thrown immediately.
 *
 * @param fn - Async function to execute
 * @param shouldRetry - Predicate to determine if an error is retryable
 * @param config - Optional partial backoff configuration
 * @returns The result of fn on success
 * @throws The last error if all attempts fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  config?: Partial<BackoffConfig>
): Promise<T> {
  const cfg = { ...DEFAULT_BACKOFF, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
      if (attempt < cfg.maxAttempts - 1) {
        await backoffSleep(attempt, cfg);
      }
    }
  }

  throw lastError;
}
