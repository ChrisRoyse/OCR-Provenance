/**
 * Provenance Service Module
 *
 * Exports the ProvenanceTracker and ProvenanceVerifier for high-level provenance operations.
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

// Export verifier and related types
export {
  ProvenanceVerifier,
  VerifierError,
  VerifierErrorCode,
  type VerifierErrorCodeType,
  type ItemVerificationResult,
  type ChainVerificationResult,
  type DatabaseVerificationResult,
} from './verifier.js';

// Export exporter and related types
export {
  ProvenanceExporter,
  ExporterError,
  ExporterErrorCode,
  type ExporterErrorCodeType,
  type ExportScope,
  type ExportFormat,
  type PROVDocument,
  type JSONExportResult,
  type W3CPROVExportResult,
  type CSVExportResult,
  type FileExportResult,
} from './exporter.js';

// Re-export models for convenience
export type {
  ProvenanceRecord,
  CreateProvenanceParams,
  ProvenanceChain,
  VerificationResult,
  ProvenanceLocation,
  SourceType,
  W3CProvDocument,
} from '../../models/provenance.js';
export { ProvenanceType, PROVENANCE_CHAIN_DEPTH } from '../../models/provenance.js';
