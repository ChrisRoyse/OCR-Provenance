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
import { successResult, type ServerConfig } from '../server/types.js';
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

/** Map config keys to their state property names */
const CONFIG_KEY_MAP: Record<string, string> = {
  datalab_default_mode: 'defaultOCRMode',
  datalab_max_concurrent: 'maxConcurrent',
  embedding_batch_size: 'embeddingBatchSize',
  embedding_device: 'embeddingDevice',
  chunk_size: 'chunkSize',
  chunk_overlap_percent: 'chunkOverlapPercent',
  log_level: 'logLevel',
};

function getConfigValue(key: z.infer<typeof ConfigKey>): unknown {
  const config = getConfig();
  const mappedKey = CONFIG_KEY_MAP[key];

  if (mappedKey && mappedKey in config) {
    return config[mappedKey as keyof typeof config];
  }
  throw validationError(`Unknown configuration key: ${key}`, { key });
}

/** Validation rules per config key */
const CONFIG_VALIDATORS: Record<string, (value: unknown) => void> = {
  datalab_default_mode: (v) => {
    if (typeof v !== 'string' || !['fast', 'balanced', 'accurate'].includes(v))
      throw validationError('datalab_default_mode must be "fast", "balanced", or "accurate"', { value: v });
  },
  datalab_max_concurrent: (v) => {
    if (typeof v !== 'number' || v < 1 || v > 10)
      throw validationError('datalab_max_concurrent must be a number between 1 and 10', { value: v });
  },
  embedding_batch_size: (v) => {
    if (typeof v !== 'number' || v < 1 || v > 1024)
      throw validationError('embedding_batch_size must be a number between 1 and 1024', { value: v });
  },
  embedding_device: (v) => {
    if (typeof v !== 'string')
      throw validationError('embedding_device must be a string', { value: v });
  },
  chunk_size: (v) => {
    if (typeof v !== 'number' || v < 100 || v > 10000)
      throw validationError('chunk_size must be a number between 100 and 10000', { value: v });
  },
  chunk_overlap_percent: (v) => {
    if (typeof v !== 'number' || v < 0 || v > 50)
      throw validationError('chunk_overlap_percent must be a number between 0 and 50', { value: v });
  },
  log_level: (v) => {
    if (typeof v !== 'string' || !['debug', 'info', 'warn', 'error'].includes(v))
      throw validationError('log_level must be "debug", "info", "warn", or "error"', { value: v });
  },
};

function setConfigValue(key: z.infer<typeof ConfigKey>, value: string | number | boolean): void {
  const mappedKey = CONFIG_KEY_MAP[key];
  if (!mappedKey) {
    throw validationError(`Unknown configuration key: ${key}`, { key });
  }

  const validator = CONFIG_VALIDATORS[key];
  if (validator) validator(value);

  updateConfig({ [mappedKey]: value } as Partial<ServerConfig>);
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

      // Mutable config values from state
      embedding_device: config.embeddingDevice,
      chunk_size: config.chunkSize,
      chunk_overlap_percent: config.chunkOverlapPercent,
      log_level: config.logLevel,
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
