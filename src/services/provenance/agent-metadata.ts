/**
 * PROV-AGENT Metadata Builder
 *
 * Builds agent metadata for provenance records.
 * Records model names, versions, parameters for AI operations.
 * Records user context for user-triggered actions.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/provenance/agent-metadata
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentMetadata {
  agent_type: 'ai_model' | 'user' | 'system';
  model_name?: string;
  model_version?: string;
  temperature?: number;
  max_tokens?: number;
  token_count?: { input: number; output: number };
  confidence?: number;
  user_id?: string;
  session_id?: string;
  client_type?: string;
  duration_ms?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OCR AGENT METADATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build agent metadata for OCR processing operations.
 *
 * @param params - OCR operation parameters
 * @returns Serialized JSON string of agent metadata
 */
export function buildOCRAgentMetadata(params: {
  mode: string;
  durationMs: number;
  pageCount: number;
}): string {
  const metadata: AgentMetadata = {
    agent_type: 'ai_model',
    model_name: 'datalab-ocr',
    model_version: params.mode,
    duration_ms: params.durationMs,
  };
  return JSON.stringify({ ...metadata, page_count: params.pageCount });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMBEDDING AGENT METADATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build agent metadata for embedding generation operations.
 *
 * @param params - Embedding operation parameters
 * @returns Serialized JSON string of agent metadata
 */
export function buildEmbeddingAgentMetadata(params: {
  model: string;
  device: string;
  batchSize: number;
  chunkCount: number;
  durationMs: number;
}): string {
  const metadata: AgentMetadata = {
    agent_type: 'ai_model',
    model_name: params.model,
    model_version: '1.5',
    duration_ms: params.durationMs,
  };
  return JSON.stringify({
    ...metadata,
    device: params.device,
    batch_size: params.batchSize,
    chunks_processed: params.chunkCount,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VLM AGENT METADATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build agent metadata for VLM (Vision Language Model) operations.
 *
 * @param params - VLM operation parameters
 * @returns Serialized JSON string of agent metadata
 */
export function buildVLMAgentMetadata(params: {
  model: string;
  tokensUsed?: number;
  confidence?: number;
  durationMs?: number;
}): string {
  const metadata: AgentMetadata = {
    agent_type: 'ai_model',
    model_name: params.model,
    confidence: params.confidence,
    duration_ms: params.durationMs,
  };
  if (params.tokensUsed) {
    metadata.token_count = { input: 0, output: params.tokensUsed };
  }
  return JSON.stringify(metadata);
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER AGENT METADATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build agent metadata for user-triggered actions.
 *
 * @param params - User action parameters
 * @returns Serialized JSON string of agent metadata
 */
export function buildUserAgentMetadata(params: {
  userId?: string;
  sessionId?: string;
  action: string;
}): string {
  return JSON.stringify({
    agent_type: 'user',
    user_id: params.userId,
    session_id: params.sessionId,
    action: params.action,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM AGENT METADATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build agent metadata for system-triggered actions (migrations, background tasks).
 *
 * @param action - Description of the system action
 * @returns Serialized JSON string of agent metadata
 */
export function buildSystemAgentMetadata(action: string): string {
  return JSON.stringify({
    agent_type: 'system',
    action,
  });
}
