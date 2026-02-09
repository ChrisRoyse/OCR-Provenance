/**
 * ProvenanceTracker - High-level service for provenance chain management
 *
 * Constitution Compliance:
 * - CP-001: Complete provenance chain for every data item
 * - CP-003: SHA-256 content hashing
 * - CP-005: Full reproducibility via processing params
 *
 * FAIL FAST: All errors throw immediately, no silent failures
 */

import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../storage/database/index.js';
import {
  ProvenanceRecord,
  ProvenanceType,
  CreateProvenanceParams,
  PROVENANCE_CHAIN_DEPTH,
} from '../../models/provenance.js';

/** Error codes for provenance operations */
export const ProvenanceErrorCode = {
  NOT_FOUND: 'PROVENANCE_NOT_FOUND',
  CHAIN_BROKEN: 'PROVENANCE_CHAIN_BROKEN',
  ROOT_NOT_FOUND: 'ROOT_DOCUMENT_NOT_FOUND',
  INVALID_TYPE: 'INVALID_PROVENANCE_TYPE',
  INVALID_PARAMS: 'INVALID_PROVENANCE_PARAMS',
} as const;

export type ProvenanceErrorCodeType = typeof ProvenanceErrorCode[keyof typeof ProvenanceErrorCode];

/**
 * ProvenanceError - Typed error for provenance operations
 * FAIL FAST: Always throw with detailed error information
 */
export class ProvenanceError extends Error {
  constructor(
    message: string,
    public readonly code: ProvenanceErrorCodeType,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProvenanceError';
    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ProvenanceError.prototype);
  }
}

/** Result of getProvenanceChain */
export interface ProvenanceChainResult {
  /** The record we started from */
  current: ProvenanceRecord;
  /** Ancestors ordered: immediate parent first, root last */
  ancestors: ProvenanceRecord[];
  /** The root DOCUMENT record */
  root: ProvenanceRecord;
  /** Chain depth of current record */
  depth: number;
  /** Human-readable chain path */
  chainPath: string[];
  /** Whether chain has expected number of records */
  isComplete: boolean;
}

/**
 * ProvenanceTracker - High-level provenance chain management
 *
 * Provides clean API for:
 * 1. Creating provenance records with automatic parent_ids chain building
 * 2. Traversing provenance chains from any item to root document
 * 3. Querying provenance by type, root document, or ID
 */
export class ProvenanceTracker {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Create provenance record with automatic parent_ids chain building
   *
   * For DOCUMENT type: parent_ids=[], chain_depth=0, root_document_id=self
   * For OCR_RESULT type: parent_ids=[docId], chain_depth=1
   * For CHUNK type: parent_ids=[docId, ocrId], chain_depth=2
   * For EMBEDDING type: parent_ids=[docId, ocrId, chunkId], chain_depth=3
   *
   * @param params - Creation parameters
   * @returns Created provenance record ID
   * @throws ProvenanceError if parent not found or params invalid
   */
  createProvenance(params: CreateProvenanceParams): string {
    // Validate type is a known ProvenanceType
    const validTypes = Object.values(ProvenanceType);
    if (!validTypes.includes(params.type)) {
      throw new ProvenanceError(
        `Invalid provenance type: ${params.type}. Valid types: ${validTypes.join(', ')}`,
        ProvenanceErrorCode.INVALID_TYPE,
        { providedType: params.type, validTypes }
      );
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const chainDepth = PROVENANCE_CHAIN_DEPTH[params.type];

    // Build parent_ids array by walking the parent chain
    const parentIds = this.buildParentIds(params.source_id ?? null);

    // For DOCUMENT type, root_document_id is self
    // For other types, root_document_id comes from params
    const rootDocumentId = params.type === ProvenanceType.DOCUMENT
      ? id
      : params.root_document_id;

    // Build chain_path based on type
    const chainPath = this.buildChainPath(params.type);

    const record: ProvenanceRecord = {
      id,
      type: params.type,
      created_at: now,
      processed_at: now,
      source_file_created_at: params.source_file_created_at ?? null,
      source_file_modified_at: params.source_file_modified_at ?? null,
      source_type: params.source_type,
      source_path: params.source_path ?? null,
      source_id: params.source_id ?? null,
      root_document_id: rootDocumentId,
      location: params.location ?? null,
      content_hash: params.content_hash,
      input_hash: params.input_hash ?? null,
      file_hash: params.file_hash ?? null,
      processor: params.processor,
      processor_version: params.processor_version,
      processing_params: params.processing_params,
      processing_duration_ms: params.processing_duration_ms ?? null,
      processing_quality_score: params.processing_quality_score ?? null,
      parent_id: params.source_id ?? null,
      parent_ids: JSON.stringify(parentIds),
      chain_depth: chainDepth,
      chain_path: JSON.stringify(chainPath),
    };

    return this.db.insertProvenance(record);
  }

  /**
   * Get provenance record by ID
   * @throws ProvenanceError if not found
   */
  getProvenanceById(id: string): ProvenanceRecord {
    const record = this.db.getProvenance(id);
    if (!record) {
      throw new ProvenanceError(
        `Provenance record not found: ${id}`,
        ProvenanceErrorCode.NOT_FOUND,
        { id }
      );
    }
    return record;
  }

  /**
   * Get provenance record by ID, returns null if not found
   */
  getProvenanceByIdOrNull(id: string): ProvenanceRecord | null {
    return this.db.getProvenance(id);
  }

  /**
   * Get complete provenance chain from item to root
   *
   * Returns ProvenanceChainResult with:
   * - current: the starting record
   * - ancestors: all ancestors from immediate parent to root
   * - root: the DOCUMENT type root record
   * - isComplete: whether chain has expected depth
   *
   * @throws ProvenanceError if record not found
   */
  getProvenanceChain(id: string): ProvenanceChainResult {
    // getProvenanceChain returns array ordered current→root
    const chain = this.db.getProvenanceChain(id);

    if (chain.length === 0) {
      throw new ProvenanceError(
        `Provenance record not found: ${id}`,
        ProvenanceErrorCode.NOT_FOUND,
        { id }
      );
    }

    const current = chain[0];
    const ancestors = chain.slice(1);
    const root = chain[chain.length - 1];

    // Verify chain completeness based on type's expected depth
    // DOCUMENT (depth=0) expects 1 record (itself)
    // OCR_RESULT (depth=1) expects 2 records
    // CHUNK (depth=2) expects 3 records
    // EMBEDDING (depth=3) expects 4 records
    const expectedChainLength = current.chain_depth + 1;
    const isComplete = chain.length === expectedChainLength;

    // Parse chain_path or reconstruct from chain
    let chainPath: string[];
    if (current.chain_path) {
      chainPath = JSON.parse(current.chain_path) as string[];
    } else {
      chainPath = chain.map(r => r.type).reverse();
    }

    return {
      current,
      ancestors,
      root,
      depth: current.chain_depth,
      chainPath,
      isComplete,
    };
  }

  /**
   * Get root document provenance for any item
   *
   * @param provenanceId - Any provenance record ID in the chain
   * @returns The root DOCUMENT type record
   * @throws ProvenanceError if not found or root is not DOCUMENT type
   */
  getRootDocument(provenanceId: string): ProvenanceRecord {
    const chain = this.getProvenanceChain(provenanceId);

    if (chain.root.type !== ProvenanceType.DOCUMENT) {
      throw new ProvenanceError(
        `Root record is not DOCUMENT type. Found: ${chain.root.type}`,
        ProvenanceErrorCode.ROOT_NOT_FOUND,
        { rootId: chain.root.id, rootType: chain.root.type }
      );
    }

    return chain.root;
  }

  /**
   * Get all provenance records for a root document
   * Returns records ordered by chain_depth (DOCUMENT first, then OCR_RESULT, etc.)
   */
  getProvenanceByRootDocument(rootDocumentId: string): ProvenanceRecord[] {
    return this.db.getProvenanceByRootDocument(rootDocumentId);
  }

  /**
   * Get child provenance records for a parent
   */
  getProvenanceChildren(parentId: string): ProvenanceRecord[] {
    return this.db.getProvenanceChildren(parentId);
  }

  /**
   * Build parent_ids array from source_id
   * Returns array of ALL ancestor IDs ordered from oldest to most recent
   * Example: For EMBEDDING, returns [docId, ocrId, chunkId]
   *
   * @param sourceId - Immediate parent provenance ID (null for DOCUMENT)
   * @returns Array of all ancestor IDs
   * @throws ProvenanceError if parent not found (CHAIN_BROKEN)
   */
  private buildParentIds(sourceId: string | null): string[] {
    if (sourceId === null) {
      // DOCUMENT type has no parents
      return [];
    }

    const parent = this.db.getProvenance(sourceId);
    if (!parent) {
      throw new ProvenanceError(
        `Parent provenance not found: ${sourceId}. Cannot build provenance chain.`,
        ProvenanceErrorCode.CHAIN_BROKEN,
        { sourceId }
      );
    }

    // Parse parent's parent_ids and append parent to get full chain
    const parentParentIds = JSON.parse(parent.parent_ids) as string[];
    return [...parentParentIds, sourceId];
  }

  /**
   * Build chain_path array based on type
   * Returns human-readable path from root to current type
   *
   * Note: For EMBEDDING, the chain_path depends on the parent type.
   * This method returns the default CHUNK->EMBEDDING path.
   * For VLM_DESCRIPTION->EMBEDDING, the chain_path is built dynamically from parent.
   */
  private buildChainPath(type: ProvenanceType): string[] {
    switch (type) {
      case ProvenanceType.DOCUMENT:
        return ['DOCUMENT'];
      case ProvenanceType.OCR_RESULT:
        return ['DOCUMENT', 'OCR_RESULT'];
      case ProvenanceType.CHUNK:
        return ['DOCUMENT', 'OCR_RESULT', 'CHUNK'];
      case ProvenanceType.IMAGE:
        return ['DOCUMENT', 'OCR_RESULT', 'IMAGE'];
      case ProvenanceType.VLM_DESCRIPTION:
        return ['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION'];
      case ProvenanceType.EXTRACTION:
        return ['DOCUMENT', 'OCR_RESULT', 'EXTRACTION'];
      case ProvenanceType.FORM_FILL:
        return ['DOCUMENT', 'FORM_FILL'];
      case ProvenanceType.ENTITY_EXTRACTION:
        return ['DOCUMENT', 'OCR_RESULT', 'ENTITY_EXTRACTION'];
      case ProvenanceType.COMPARISON:
        return ['DOCUMENT', 'OCR_RESULT', 'COMPARISON'];
      case ProvenanceType.EMBEDDING:
        // Default path is from CHUNK (depth 3). VLM description embeddings
        // (depth 4) bypass createProvenance() and build chain_path directly
        // in pipeline.ts generateAndStoreEmbedding().
        return ['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING'];
      default:
        // This should never happen due to type validation above
        // but TypeScript needs exhaustive handling
        throw new ProvenanceError(
          `Unknown provenance type: ${type}`,
          ProvenanceErrorCode.INVALID_TYPE,
          { type }
        );
    }
  }
}

// Singleton management
let _tracker: ProvenanceTracker | null = null;
let _trackerDb: DatabaseService | null = null;

/**
 * Get or create ProvenanceTracker singleton
 * @param db - DatabaseService instance
 */
export function getProvenanceTracker(db: DatabaseService): ProvenanceTracker {
  // If the database instance has changed, recreate the tracker
  if (_tracker && _trackerDb !== db) {
    _tracker = null;
  }
  if (!_tracker) {
    _tracker = new ProvenanceTracker(db);
    _trackerDb = db;
  }
  return _tracker;
}

/**
 * Reset singleton for testing
 */
export function resetProvenanceTracker(): void {
  _tracker = null;
  _trackerDb = null;
}
