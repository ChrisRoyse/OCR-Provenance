/**
 * Unit Tests for Config MCP Tools
 *
 * Tests the extracted config tool handlers in src/tools/config.ts
 * Tools: handleConfigGet, handleConfigSet
 *
 * NO MOCK DATA - Uses real state configuration.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/config
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleConfigGet, handleConfigSet, configTools } from '../../../src/tools/config.js';
import {
  state,
  resetState,
  updateConfig,
  getConfig,
  clearDatabase,
} from '../../../src/server/state.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    category: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXPORTS VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('configTools exports', () => {
  it('exports all 2 config tools', () => {
    expect(Object.keys(configTools)).toHaveLength(2);
    expect(configTools).toHaveProperty('ocr_config_get');
    expect(configTools).toHaveProperty('ocr_config_set');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(configTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleConfigGet TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleConfigGet', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns all config when no key specified', async () => {
    const response = await handleConfigGet({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('datalab_default_mode');
    expect(result.data).toHaveProperty('datalab_max_concurrent');
    expect(result.data).toHaveProperty('embedding_batch_size');
    expect(result.data).toHaveProperty('storage_path');
    expect(result.data).toHaveProperty('current_database');
    expect(result.data).toHaveProperty('chunk_size');
    expect(result.data).toHaveProperty('chunk_overlap_percent');
    expect(result.data).toHaveProperty('max_chunk_size');
  });

  it('returns specific value when key specified', async () => {
    const response = await handleConfigGet({ key: 'datalab_default_mode' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.key).toBe('datalab_default_mode');
    expect(result.data?.value).toBe('balanced'); // Default value
  });

  it('includes immutable values in full config', async () => {
    const response = await handleConfigGet({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('embedding_model');
    expect(result.data?.embedding_model).toBe('nomic-embed-text-v1.5');
    expect(result.data).toHaveProperty('embedding_dimensions');
    expect(result.data?.embedding_dimensions).toBe(768);
    expect(result.data).toHaveProperty('hash_algorithm');
    expect(result.data?.hash_algorithm).toBe('sha256');
  });

  it('returns current_database name (null when none selected)', async () => {
    const response = await handleConfigGet({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.current_database).toBe(null);
    expect(state.currentDatabaseName).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleConfigSet TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleConfigSet', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('updates mutable config key (datalab_default_mode)', async () => {
    const response = await handleConfigSet({ key: 'datalab_default_mode', value: 'fast' });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.key).toBe('datalab_default_mode');
    expect(result.data?.value).toBe('fast');
    expect(result.data?.updated).toBe(true);

    // STATE VERIFICATION: Check actual config state
    const config = getConfig();
    expect(config.defaultOCRMode).toBe('fast');
  });

  it('updates mutable config key (datalab_max_concurrent)', async () => {
    const response = await handleConfigSet({ key: 'datalab_max_concurrent', value: 5 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.key).toBe('datalab_max_concurrent');
    expect(result.data?.value).toBe(5);
    expect(result.data?.updated).toBe(true);

    // STATE VERIFICATION: Check actual config state
    const config = getConfig();
    expect(config.maxConcurrent).toBe(5);
  });

  it('updates mutable config key (embedding_batch_size)', async () => {
    const response = await handleConfigSet({ key: 'embedding_batch_size', value: 64 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.key).toBe('embedding_batch_size');
    expect(result.data?.value).toBe(64);
    expect(result.data?.updated).toBe(true);

    // STATE VERIFICATION: Check actual config state
    const config = getConfig();
    expect(config.embeddingBatchSize).toBe(64);
  });

  it('rejects immutable key (embedding_model) - not in allowed enum', async () => {
    // Immutable keys are not in the ConfigKey enum, so Zod validation fails first
    const response = await handleConfigSet({ key: 'embedding_model', value: 'other-model' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Zod validation rejects invalid enum value with VALIDATION_ERROR
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Invalid enum value');
  });

  it('rejects immutable key (embedding_dimensions) - not in allowed enum', async () => {
    // Immutable keys are not in the ConfigKey enum, so Zod validation fails first
    const response = await handleConfigSet({ key: 'embedding_dimensions', value: 512 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Zod validation rejects invalid enum value with VALIDATION_ERROR
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Invalid enum value');
  });

  it('rejects immutable key (hash_algorithm) - not in allowed enum', async () => {
    // Immutable keys are not in the ConfigKey enum, so Zod validation fails first
    const response = await handleConfigSet({ key: 'hash_algorithm', value: 'md5' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Zod validation rejects invalid enum value with VALIDATION_ERROR
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Invalid enum value');
  });

  it('validates value type for datalab_default_mode (must be fast/balanced/accurate)', async () => {
    const response = await handleConfigSet({ key: 'datalab_default_mode', value: 'invalid_mode' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('fast');
    expect(result.error?.message).toContain('balanced');
    expect(result.error?.message).toContain('accurate');
  });

  it('validates value range for datalab_max_concurrent (1-10)', async () => {
    // Test value below range
    const responseLow = await handleConfigSet({ key: 'datalab_max_concurrent', value: 0 });
    const resultLow = parseResponse(responseLow);

    expect(resultLow.success).toBe(false);
    expect(resultLow.error?.category).toBe('VALIDATION_ERROR');
    expect(resultLow.error?.message).toContain('1');
    expect(resultLow.error?.message).toContain('10');

    // Test value above range
    const responseHigh = await handleConfigSet({ key: 'datalab_max_concurrent', value: 11 });
    const resultHigh = parseResponse(responseHigh);

    expect(resultHigh.success).toBe(false);
    expect(resultHigh.error?.category).toBe('VALIDATION_ERROR');
    expect(resultHigh.error?.message).toContain('1');
    expect(resultHigh.error?.message).toContain('10');
  });

  it('persists change to state and verifies with getConfig()', async () => {
    // Set multiple config values
    await handleConfigSet({ key: 'datalab_default_mode', value: 'accurate' });
    await handleConfigSet({ key: 'datalab_max_concurrent', value: 7 });
    await handleConfigSet({ key: 'embedding_batch_size', value: 128 });

    // VERIFICATION: Get config and verify all values persisted
    const config = getConfig();
    expect(config.defaultOCRMode).toBe('accurate');
    expect(config.maxConcurrent).toBe(7);
    expect(config.embeddingBatchSize).toBe(128);

    // Also verify via handleConfigGet
    const response = await handleConfigGet({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.datalab_default_mode).toBe('accurate');
    expect(result.data?.datalab_max_concurrent).toBe(7);
    expect(result.data?.embedding_batch_size).toBe(128);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('Edge Case 1: Getting config with valid key', () => {
    it('returns specific config value for each valid key', async () => {
      // Set known values first
      updateConfig({ defaultOCRMode: 'fast', maxConcurrent: 5, embeddingBatchSize: 64 });

      // Test getting each valid key
      const modeResponse = await handleConfigGet({ key: 'datalab_default_mode' });
      const modeResult = parseResponse(modeResponse);
      expect(modeResult.success).toBe(true);
      expect(modeResult.data?.key).toBe('datalab_default_mode');
      expect(modeResult.data?.value).toBe('fast');

      const concurrentResponse = await handleConfigGet({ key: 'datalab_max_concurrent' });
      const concurrentResult = parseResponse(concurrentResponse);
      expect(concurrentResult.success).toBe(true);
      expect(concurrentResult.data?.key).toBe('datalab_max_concurrent');
      expect(concurrentResult.data?.value).toBe(5);

      const batchResponse = await handleConfigGet({ key: 'embedding_batch_size' });
      const batchResult = parseResponse(batchResponse);
      expect(batchResult.success).toBe(true);
      expect(batchResult.data?.key).toBe('embedding_batch_size');
      expect(batchResult.data?.value).toBe(64);
    });
  });

  describe('Edge Case 2: Getting config with empty object', () => {
    it('returns full config when called with empty object', async () => {
      const response = await handleConfigGet({});
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      // Should have all expected properties
      expect(result.data).toHaveProperty('datalab_default_mode');
      expect(result.data).toHaveProperty('datalab_max_concurrent');
      expect(result.data).toHaveProperty('embedding_batch_size');
      expect(result.data).toHaveProperty('embedding_model');
      expect(result.data).toHaveProperty('embedding_dimensions');
      expect(result.data).toHaveProperty('hash_algorithm');
      expect(result.data).toHaveProperty('current_database');
      expect(result.data).toHaveProperty('chunk_size');
      expect(result.data).toHaveProperty('chunk_overlap_percent');
      expect(result.data).toHaveProperty('max_chunk_size');
    });
  });

  describe('Edge Case 3: Setting config with invalid value type', () => {
    it('rejects string value for numeric config key', async () => {
      const response = await handleConfigSet({ key: 'datalab_max_concurrent', value: 'five' });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('rejects numeric value for datalab_default_mode', async () => {
      const response = await handleConfigSet({ key: 'datalab_default_mode', value: 123 });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('VALIDATION_ERROR');
    });

    it('validates embedding_batch_size range (1-1024)', async () => {
      // Below range
      const responseLow = await handleConfigSet({ key: 'embedding_batch_size', value: 0 });
      const resultLow = parseResponse(responseLow);
      expect(resultLow.success).toBe(false);
      expect(resultLow.error?.category).toBe('VALIDATION_ERROR');

      // Above range
      const responseHigh = await handleConfigSet({ key: 'embedding_batch_size', value: 1025 });
      const resultHigh = parseResponse(responseHigh);
      expect(resultHigh.success).toBe(false);
      expect(resultHigh.error?.category).toBe('VALIDATION_ERROR');
    });
  });

  describe('Edge Case 4: Setting immutable keys should fail', () => {
    it('rejects all immutable key updates and preserves original values', async () => {
      // Immutable keys are not in the ConfigKey enum, so Zod validation fails
      const immutableKeys = ['embedding_model', 'embedding_dimensions', 'hash_algorithm'];
      const testValues = ['new-model', 1024, 'sha512'];

      for (let i = 0; i < immutableKeys.length; i++) {
        const response = await handleConfigSet({
          key: immutableKeys[i],
          value: testValues[i],
        });
        const result = parseResponse(response);

        // FAIL FAST: Should reject immediately with Zod enum validation error
        expect(result.success).toBe(false);
        expect(result.error?.category).toBe('VALIDATION_ERROR');
        expect(result.error?.message).toContain('Invalid enum value');

        // STATE VERIFICATION: Original values unchanged (via handleConfigGet)
        const fullConfig = await handleConfigGet({});
        const fullResult = parseResponse(fullConfig);
        expect(fullResult.data?.embedding_model).toBe('nomic-embed-text-v1.5');
        expect(fullResult.data?.embedding_dimensions).toBe(768);
        expect(fullResult.data?.hash_algorithm).toBe('sha256');
      }
    });
  });

  describe('Edge Case 5: Config state isolation', () => {
    it('resetState restores default configuration', async () => {
      // Modify config
      await handleConfigSet({ key: 'datalab_default_mode', value: 'accurate' });
      await handleConfigSet({ key: 'datalab_max_concurrent', value: 10 });
      await handleConfigSet({ key: 'embedding_batch_size', value: 256 });

      // Verify changes
      let config = getConfig();
      expect(config.defaultOCRMode).toBe('accurate');
      expect(config.maxConcurrent).toBe(10);
      expect(config.embeddingBatchSize).toBe(256);

      // Reset state
      resetState();

      // Verify defaults restored
      config = getConfig();
      expect(config.defaultOCRMode).toBe('balanced');
      expect(config.maxConcurrent).toBe(3);
      expect(config.embeddingBatchSize).toBe(32);
    });
  });

  describe('Edge Case 6: Boundary value testing', () => {
    it('accepts boundary values for datalab_max_concurrent', async () => {
      // Test minimum boundary (1)
      const minResponse = await handleConfigSet({ key: 'datalab_max_concurrent', value: 1 });
      const minResult = parseResponse(minResponse);
      expect(minResult.success).toBe(true);
      expect(getConfig().maxConcurrent).toBe(1);

      // Test maximum boundary (10)
      const maxResponse = await handleConfigSet({ key: 'datalab_max_concurrent', value: 10 });
      const maxResult = parseResponse(maxResponse);
      expect(maxResult.success).toBe(true);
      expect(getConfig().maxConcurrent).toBe(10);
    });

    it('accepts boundary values for embedding_batch_size', async () => {
      // Test minimum boundary (1)
      const minResponse = await handleConfigSet({ key: 'embedding_batch_size', value: 1 });
      const minResult = parseResponse(minResponse);
      expect(minResult.success).toBe(true);
      expect(getConfig().embeddingBatchSize).toBe(1);

      // Test maximum boundary (1024)
      const maxResponse = await handleConfigSet({ key: 'embedding_batch_size', value: 1024 });
      const maxResult = parseResponse(maxResponse);
      expect(maxResult.success).toBe(true);
      expect(getConfig().embeddingBatchSize).toBe(1024);
    });

    it('accepts all valid datalab_default_mode values', async () => {
      const validModes = ['fast', 'balanced', 'accurate'];

      for (const mode of validModes) {
        const response = await handleConfigSet({ key: 'datalab_default_mode', value: mode });
        const result = parseResponse(response);
        expect(result.success).toBe(true);
        expect(getConfig().defaultOCRMode).toBe(mode);
      }
    });
  });
});
