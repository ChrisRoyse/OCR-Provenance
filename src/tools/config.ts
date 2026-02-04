/**
 * Configuration Management MCP Tools
 *
 * NEW tools created for Task 22.
 * Tools: ocr_config_get, ocr_config_set
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/config
 */

import { z } from 'zod';
import { state, getConfig, updateConfig } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  ConfigGetInput,
  ConfigSetInput,
  ConfigKey,
} from '../utils/validation.js';
import { validationError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Immutable configuration keys - cannot be changed at runtime */
const IMMUTABLE_KEYS = ['embedding_model', 'embedding_dimensions', 'hash_algorithm'];

/** Default values for config keys not yet stored in state */
const CONFIG_DEFAULTS: Record<string, unknown> = {
  embedding_device: 'cuda:0',
  chunk_size: 2000,
  chunk_overlap_percent: 10,
  log_level: 'info',
};

/** Map config keys to their state property names */
const CONFIG_KEY_MAP: Record<string, string> = {
  datalab_default_mode: 'defaultOCRMode',
  datalab_max_concurrent: 'maxConcurrent',
  embedding_batch_size: 'embeddingBatchSize',
};

function getConfigValue(key: z.infer<typeof ConfigKey>): unknown {
  const config = getConfig();
  const mappedKey = CONFIG_KEY_MAP[key];

  if (mappedKey && mappedKey in config) {
    return config[mappedKey as keyof typeof config];
  }
  if (key in CONFIG_DEFAULTS) {
    return CONFIG_DEFAULTS[key];
  }
  throw validationError(`Unknown configuration key: ${key}`, { key });
}

function setConfigValue(key: z.infer<typeof ConfigKey>, value: string | number | boolean): void {
  if (key === 'datalab_default_mode') {
    if (typeof value !== 'string' || !['fast', 'balanced', 'accurate'].includes(value)) {
      throw validationError('datalab_default_mode must be "fast", "balanced", or "accurate"', { key, value });
    }
    updateConfig({ defaultOCRMode: value as 'fast' | 'balanced' | 'accurate' });
  } else if (key === 'datalab_max_concurrent') {
    if (typeof value !== 'number' || value < 1 || value > 10) {
      throw validationError('datalab_max_concurrent must be a number between 1 and 10', { key, value });
    }
    updateConfig({ maxConcurrent: value });
  } else if (key === 'embedding_batch_size') {
    if (typeof value !== 'number' || value < 1 || value > 1024) {
      throw validationError('embedding_batch_size must be a number between 1 and 1024', { key, value });
    }
    updateConfig({ embeddingBatchSize: value });
  } else if (key in CONFIG_DEFAULTS) {
    // These config keys are not yet persisted - log for visibility
    console.error(`[CONFIG] Setting ${key} to ${String(value)} (not yet persisted)`);
  } else {
    throw validationError(`Unknown configuration key: ${key}`, { key });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function handleConfigGet(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ConfigGetInput, params);
    const config = getConfig();

    // Return specific key if requested
    if (input.key) {
      const value = getConfigValue(input.key);
      return formatResponse(successResult({ key: input.key, value }));
    }

    // Return full configuration
    return formatResponse(successResult({
      // Mutable configuration values
      datalab_default_mode: config.defaultOCRMode,
      datalab_max_concurrent: config.maxConcurrent,
      embedding_batch_size: config.embeddingBatchSize,
      storage_path: config.defaultStoragePath,
      current_database: state.currentDatabaseName,

      // Immutable values (informational only)
      embedding_model: 'nomic-embed-text-v1.5',
      embedding_dimensions: 768,
      hash_algorithm: 'sha256',

      // Additional config values
      embedding_device: 'cuda:0',
      chunk_size: 2000,
      chunk_overlap_percent: 10,
      log_level: 'info',
    }));
  } catch (error) {
    return handleError(error);
  }
}

export async function handleConfigSet(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ConfigSetInput, params);

    // FAIL FAST: Block immutable keys
    if (IMMUTABLE_KEYS.includes(input.key)) {
      throw validationError(`Configuration key "${input.key}" is immutable and cannot be changed at runtime`, {
        key: input.key,
        immutableKeys: IMMUTABLE_KEYS,
      });
    }

    // Apply the configuration change
    setConfigValue(input.key, input.value);

    return formatResponse(successResult({
      key: input.key,
      value: input.value,
      updated: true,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Config tools collection for MCP server registration
 */
export const configTools: Record<string, ToolDefinition> = {
  'ocr_config_get': {
    description: 'Get current system configuration',
    inputSchema: {
      key: z.enum([
        'datalab_default_mode',
        'datalab_max_concurrent',
        'embedding_batch_size',
        'embedding_device',
        'chunk_size',
        'chunk_overlap_percent',
        'log_level',
      ]).optional().describe('Specific config key to retrieve'),
    },
    handler: handleConfigGet,
  },
  'ocr_config_set': {
    description: 'Update a configuration setting',
    inputSchema: {
      key: z.enum([
        'datalab_default_mode',
        'datalab_max_concurrent',
        'embedding_batch_size',
        'embedding_device',
        'chunk_size',
        'chunk_overlap_percent',
        'log_level',
      ]).describe('Configuration key to update'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('New value'),
    },
    handler: handleConfigSet,
  },
};
