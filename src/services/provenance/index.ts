/**
 * Provenance Service Module
 *
 * Exports the ProvenanceTracker for high-level provenance operations.
 *
 * Constitution Compliance:
 * - CP-001: Complete provenance chain for every data item
 * - CP-003: SHA-256 content hashing via hash utilities
 */

// Export tracker and related types
export {
  ProvenanceTracker,
  ProvenanceError,
  ProvenanceErrorCode,
  getProvenanceTracker,
  resetProvenanceTracker,
  type ProvenanceChainResult,
  type ProvenanceErrorCodeType,
} from './tracker.js';

// Re-export models for convenience
export {
  ProvenanceRecord,
  ProvenanceType,
  CreateProvenanceParams,
  ProvenanceChain,
  VerificationResult,
  ProvenanceLocation,
  SourceType,
  PROVENANCE_CHAIN_DEPTH,
  W3CProvDocument,
} from '../../models/provenance.js';
