/**
 * Unit tests for Gemini Client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GeminiClient,
  GeminiRateLimiter,
  CircuitBreaker,
  CircuitState,
  loadGeminiConfig,
  GEMINI_MODELS,
  RATE_LIMITS,
  estimateTokens,
} from '../../../src/services/gemini/index.js';

describe('Gemini Config', () => {
  it('should have correct model IDs', () => {
    expect(GEMINI_MODELS.FLASH_2).toBe('gemini-2.0-flash');
    expect(GEMINI_MODELS.FLASH_3).toBe('gemini-3-flash-preview');
    expect(GEMINI_MODELS.PRO).toBe('gemini-2.5-pro');
  });

  it('should have correct rate limits for PayAsYouGo tier', () => {
    const limits = RATE_LIMITS.payAsYouGo;
    expect(limits.flashRPM).toBe(1000);
    expect(limits.flashTPM).toBe(4_000_000);
    expect(limits.flashRPD).toBe(10_000);
  });

  it('should load config from environment', () => {
    // Mock env
    const originalEnv = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';

    const config = loadGeminiConfig();
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe(GEMINI_MODELS.FLASH_3);
    expect(config.tier).toBe('payAsYouGo');

    // Restore
    if (originalEnv) {
      process.env.GEMINI_API_KEY = originalEnv;
    }
  });
});

describe('GeminiRateLimiter', () => {
  let limiter: GeminiRateLimiter;

  beforeEach(() => {
    limiter = new GeminiRateLimiter('payAsYouGo');
  });

  it('should start with full capacity', () => {
    const status = limiter.getStatus();
    expect(status.requestsRemaining).toBe(1000);
    expect(status.tokensRemaining).toBe(4_000_000);
  });

  it('should allow acquiring tokens', async () => {
    const acquired = limiter.tryAcquire(1000);
    expect(acquired).toBe(true);

    const status = limiter.getStatus();
    expect(status.requestsRemaining).toBe(999);
    expect(status.tokensRemaining).toBe(3_999_000);
  });

  it('should track token usage accurately', () => {
    limiter.tryAcquire(1000);
    limiter.recordUsage(1000, 1500); // Actual was 500 more

    const status = limiter.getStatus();
    expect(status.tokensRemaining).toBe(3_998_500);
  });

  it('should not be limited initially', () => {
    expect(limiter.isLimited()).toBe(false);
  });

  it('should reset correctly', () => {
    limiter.tryAcquire(1000);
    limiter.reset();

    const status = limiter.getStatus();
    expect(status.requestsRemaining).toBe(1000);
  });
});

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeMs: 1000,
      halfOpenSuccessThreshold: 2,
    });
  });

  it('should start in CLOSED state', () => {
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should stay CLOSED on success', async () => {
    await breaker.execute(async () => 'success');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should open after threshold failures', async () => {
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error('fail');
        });
      } catch {
        // Expected
      }
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it('should reject requests when OPEN', async () => {
    breaker.forceOpen();

    await expect(
      breaker.execute(async () => 'test')
    ).rejects.toThrow('Circuit breaker is OPEN');
  });

  it('should provide time to recovery when OPEN', () => {
    breaker.forceOpen();
    const status = breaker.getStatus();

    expect(status.state).toBe(CircuitState.OPEN);
    expect(status.timeToRecovery).toBeGreaterThan(0);
  });

  it('should reset correctly', () => {
    breaker.forceOpen();
    breaker.reset();

    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getStatus().failureCount).toBe(0);
  });
});

describe('Token Estimation', () => {
  it('should estimate text tokens at ~4 chars per token', () => {
    const tokens = estimateTokens(400, 0, false);
    expect(tokens).toBe(100); // 400 / 4 = 100
  });

  it('should add 280 tokens per high-res image', () => {
    const tokens = estimateTokens(0, 2, true);
    expect(tokens).toBe(560); // 2 * 280
  });

  it('should add 70 tokens per low-res image', () => {
    const tokens = estimateTokens(0, 2, false);
    expect(tokens).toBe(140); // 2 * 70
  });

  it('should combine text and image tokens', () => {
    const tokens = estimateTokens(400, 1, true);
    expect(tokens).toBe(380); // 100 + 280
  });
});

describe('GeminiClient', () => {
  it('should throw if no API key', () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    expect(() => new GeminiClient({ apiKey: '' })).toThrow('GEMINI_API_KEY is required');

    if (originalKey) {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it('should create client with valid API key', () => {
    const client = new GeminiClient({ apiKey: 'test-key' });
    expect(client).toBeDefined();

    const status = client.getStatus();
    expect(status.model).toBe(GEMINI_MODELS.FLASH_3);
    expect(status.tier).toBe('payAsYouGo');
  });

  it('should create FileRef from buffer', () => {
    const buffer = Buffer.from('test image data');
    const fileRef = GeminiClient.fileRefFromBuffer(buffer, 'image/png');

    expect(fileRef.mimeType).toBe('image/png');
    expect(fileRef.sizeBytes).toBe(buffer.length);
    expect(fileRef.data).toBe(buffer.toString('base64'));
  });

  it('should reject unsupported MIME types', () => {
    const buffer = Buffer.from('test');
    expect(() =>
      GeminiClient.fileRefFromBuffer(buffer, 'text/plain' as any)
    ).toThrow('Unsupported MIME type');
  });
});
