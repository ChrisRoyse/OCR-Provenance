/**
 * Hash-Chain Verification for Provenance
 *
 * Creates a tamper-evident Merkle-like chain where each provenance record
 * includes SHA-256(content_hash + parent.chain_hash).
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/provenance/chain-hash
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChainVerificationResult {
  valid: boolean;
  total_records: number;
  verified: number;
  broken_at: string | null;
  error?: string;
}

export interface BackfillResult {
  updated: number;
  errors: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HASH COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute chain hash for a provenance record.
 *
 * Chain hash = SHA-256(content_hash + ":" + parent_chain_hash)
 * For root records (no parent): SHA-256(content_hash)
 *
 * @param contentHash - The content hash of the current record
 * @param parentChainHash - The chain hash of the parent record, or null for roots
 * @returns Hex-encoded SHA-256 chain hash
 */
export function computeChainHash(contentHash: string, parentChainHash: string | null): string {
  const input = parentChainHash ? `${contentHash}:${parentChainHash}` : contentHash;
  return createHash('sha256').update(input).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAIN VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify the chain hash integrity for all provenance records of a root document.
 *
 * Walks the provenance chain in depth-first order, recomputing each chain_hash
 * from (content_hash, parent.chain_hash) and comparing against the stored value.
 *
 * Pre-v32 records without chain_hash are considered valid (unverifiable).
 *
 * @param conn - Database connection
 * @param rootDocumentId - The root document provenance ID to verify
 * @returns Verification result with record counts and any breakage point
 */
export function verifyChainHashes(
  conn: Database.Database,
  rootDocumentId: string
): ChainVerificationResult {
  const records = conn
    .prepare(
      `
    SELECT id, content_hash, chain_hash, parent_id
    FROM provenance
    WHERE root_document_id = ?
    ORDER BY chain_depth ASC, created_at ASC
  `
    )
    .all(rootDocumentId) as Array<{
    id: string;
    content_hash: string;
    chain_hash: string | null;
    parent_id: string | null;
  }>;

  if (records.length === 0) {
    return { valid: true, total_records: 0, verified: 0, broken_at: null };
  }

  // Build a map for fast parent lookups
  const recordMap = new Map(records.map((r) => [r.id, r]));
  let verified = 0;

  for (const record of records) {
    if (!record.chain_hash) {
      // Records without chain_hash are pre-v32 (valid, just unverifiable)
      verified++;
      continue;
    }

    const parentRecord = record.parent_id ? recordMap.get(record.parent_id) : null;
    const parentChainHash = parentRecord?.chain_hash ?? null;
    const expectedHash = computeChainHash(record.content_hash, parentChainHash);

    if (record.chain_hash !== expectedHash) {
      return {
        valid: false,
        total_records: records.length,
        verified,
        broken_at: record.id,
        error: `Chain hash mismatch at ${record.id}: expected ${expectedHash}, got ${record.chain_hash}`,
      };
    }
    verified++;
  }

  return {
    valid: true,
    total_records: records.length,
    verified,
    broken_at: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKFILL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Backfill chain hashes for existing provenance records that don't have them.
 *
 * Processes records in depth-first order (chain_depth ASC) so that parent
 * chain hashes are available when computing child hashes.
 *
 * @param conn - Database connection
 * @returns Count of updated records and errors
 */
export function backfillChainHashes(conn: Database.Database): BackfillResult {
  const records = conn
    .prepare(
      `
    SELECT id, content_hash, parent_id, chain_hash
    FROM provenance
    WHERE chain_hash IS NULL
    ORDER BY chain_depth ASC, created_at ASC
  `
    )
    .all() as Array<{
    id: string;
    content_hash: string;
    parent_id: string | null;
    chain_hash: string | null;
  }>;

  let updated = 0;
  let errors = 0;
  const hashMap = new Map<string, string>();

  // Also load existing chain hashes for parent lookups
  const existing = conn
    .prepare('SELECT id, chain_hash FROM provenance WHERE chain_hash IS NOT NULL')
    .all() as Array<{ id: string; chain_hash: string }>;
  for (const r of existing) {
    hashMap.set(r.id, r.chain_hash);
  }

  const updateStmt = conn.prepare('UPDATE provenance SET chain_hash = ? WHERE id = ?');

  for (const record of records) {
    try {
      const parentChainHash = record.parent_id ? (hashMap.get(record.parent_id) ?? null) : null;
      const chainHash = computeChainHash(record.content_hash, parentChainHash);
      updateStmt.run(chainHash, record.id);
      hashMap.set(record.id, chainHash);
      updated++;
    } catch (error) {
      console.error(
        `[ChainHash] Failed to backfill ${record.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      errors++;
    }
  }

  return { updated, errors };
}
