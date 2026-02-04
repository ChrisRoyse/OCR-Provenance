/**
 * Rate Limiter for Gemini API
 * Implements RPM (requests per minute) and TPM (tokens per minute) limits
 * Based on gemini-flash-3-dev-guide.md rate limits
 */

import { RATE_LIMITS, type SubscriptionTier } from './config.js';

export interface RateLimiterStatus {
  requestsRemaining: number;
  tokensRemaining: number;
  resetInMs: number;
}

export class GeminiRateLimiter {
  private requestCount: number = 0;
  private tokenCount: number = 0;
  private windowStart: number = Date.now();
  private readonly windowMs: number = 60000; // 1 minute window

  private readonly maxRPM: number;
  private readonly maxTPM: number;

  constructor(tier: SubscriptionTier = 'payAsYouGo') {
    const limits = RATE_LIMITS[tier];
    this.maxRPM = limits.flashRPM;
    this.maxTPM = limits.flashTPM;
  }

  /**
   * Check if we need to reset the window
   */
  private checkWindow(): void {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.requestCount = 0;
      this.tokenCount = 0;
      this.windowStart = now;
    }
  }

  /**
   * Acquire permission to make a request
   * Returns wait time in ms if rate limited, 0 if ok
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
    this.checkWindow();

    // Check if we would exceed limits
    if (this.requestCount >= this.maxRPM || this.tokenCount + estimatedTokens > this.maxTPM) {
      const waitTime = this.windowMs - (Date.now() - this.windowStart);
      if (waitTime > 0) {
        console.log(`[RateLimiter] Rate limit reached, waiting ${waitTime}ms`);
        await this.sleep(waitTime);
        // Reset after waiting
        this.requestCount = 0;
        this.tokenCount = 0;
        this.windowStart = Date.now();
      }
    }

    // Reserve the request and tokens
    this.requestCount++;
    this.tokenCount += estimatedTokens;
  }

  /**
   * Try to acquire without blocking
   * Returns true if acquired, false if would need to wait
   */
  tryAcquire(estimatedTokens: number = 1000): boolean {
    this.checkWindow();

    if (this.requestCount >= this.maxRPM || this.tokenCount + estimatedTokens > this.maxTPM) {
      return false;
    }

    this.requestCount++;
    this.tokenCount += estimatedTokens;
    return true;
  }

  /**
   * Record actual token usage after a request completes
   * Adjusts the count if estimate was wrong
   */
  recordUsage(estimatedTokens: number, actualTokens: number): void {
    const diff = actualTokens - estimatedTokens;
    this.tokenCount += diff;
  }

  /**
   * Get current rate limiter status
   */
  getStatus(): RateLimiterStatus {
    this.checkWindow();
    return {
      requestsRemaining: Math.max(0, this.maxRPM - this.requestCount),
      tokensRemaining: Math.max(0, this.maxTPM - this.tokenCount),
      resetInMs: Math.max(0, this.windowMs - (Date.now() - this.windowStart)),
    };
  }

  /**
   * Check if currently rate limited
   */
  isLimited(): boolean {
    this.checkWindow();
    return this.requestCount >= this.maxRPM;
  }

  /**
   * Reset the rate limiter (for testing)
   */
  reset(): void {
    this.requestCount = 0;
    this.tokenCount = 0;
    this.windowStart = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Estimate tokens for a request
 * Rough estimate: ~4 characters per token for text, 280 tokens per image (HIGH res)
 */
export function estimateTokens(
  textLength: number,
  imageCount: number = 0,
  highResolution: boolean = true
): number {
  const textTokens = Math.ceil(textLength / 4);
  const imageTokens = imageCount * (highResolution ? 280 : 70);
  return textTokens + imageTokens;
}
