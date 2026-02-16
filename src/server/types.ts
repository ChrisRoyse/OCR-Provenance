/**
 * MCP Server Type Definitions
 *
 * Defines interfaces for tool results, server configuration, and state.
 *
 * @module server/types
 */

import type { DatabaseService } from '../services/storage/database/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Successful tool result
 */
interface ToolResultSuccess<T = unknown> {
  success: true;
  data: T;
}

/**
 * Helper to create success result
 */
export function successResult<T>(data: T): ToolResultSuccess<T> {
  return { success: true, data };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * OCR processing mode
 */
export type OCRMode = 'fast' | 'balanced' | 'accurate';

/**
 * Image optimization configuration
 */
export interface ImageOptimizationConfig {
  /** Enable image optimization (default: true) */
  enabled: boolean;

  /** Maximum width for OCR resize - Datalab API limit (default: 4800) */
  ocrMaxWidth: number;

  /** Maximum dimension for VLM resize - optimize tokens (default: 2048) */
  vlmMaxDimension: number;

  /** Skip images smaller than this for VLM (default: 50) */
  vlmSkipBelowSize: number;

  /** Minimum relevance score for VLM processing (default: 0.3) */
  vlmMinRelevance: number;

  /** Skip images predicted as logos/icons (default: true) */
  vlmSkipLogosIcons: boolean;
}

/**
 * Server configuration options
 */
export interface ServerConfig {
  /** Default path for database storage */
  defaultStoragePath: string;

  /** Default OCR processing mode */
  defaultOCRMode: OCRMode;

  /** Maximum concurrent OCR operations */
  maxConcurrent: number;

  /** Batch size for embedding generation */
  embeddingBatchSize: number;

  /** GPU device for embedding generation */
  embeddingDevice: string;

  /** Chunk size in characters */
  chunkSize: number;

  /** Chunk overlap percentage (0-50) */
  chunkOverlapPercent: number;

  /** Image optimization settings */
  imageOptimization: ImageOptimizationConfig;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Server state tracking
 */
export interface ServerState {
  /** Currently selected database instance */
  currentDatabase: DatabaseService | null;

  /** Name of the currently selected database */
  currentDatabaseName: string | null;

  /** Server configuration */
  config: ServerConfig;
}
