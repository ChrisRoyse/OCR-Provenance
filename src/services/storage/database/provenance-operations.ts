/**
 * Provenance operations for DatabaseService
 *
 * Handles all CRUD operations for provenance records including
 * chain traversal and tree queries.
 */

import Database from 'better-sqlite3';
import { ProvenanceRecord } from '../../../models/provenance.js';
import { ProvenanceRow } from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToProvenance } from './converters.js';

/**
 * Insert a provenance record
 *
 * @param db - Database connection
 * @param record - Provenance record data
 * @returns string - The provenance record ID
 */
export function insertProvenance(
  db: Database.Database,
  record: ProvenanceRecord
): string {
  const stmt = db.prepare(`
    INSERT INTO provenance (
      id, type, created_at, processed_at, source_file_created_at,
      source_file_modified_at, source_type, source_path, source_id,
      root_document_id, location, content_hash, input_hash, file_hash,
      processor, processor_version, processing_params, processing_duration_ms,
      processing_quality_score, parent_id, parent_ids, chain_depth, chain_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      record.id,
      record.type,
      record.created_at,
      record.processed_at,
      record.source_file_created_at,
      record.source_file_modified_at,
      record.source_type,
      record.source_path,
      record.source_id,
      record.root_document_id,
      record.location ? JSON.stringify(record.location) : null,
      record.content_hash,
      record.input_hash,
      record.file_hash,
      record.processor,
      record.processor_version,
      JSON.stringify(record.processing_params),
      record.processing_duration_ms,
      record.processing_quality_score,
      record.parent_id,
      record.parent_ids,
      record.chain_depth,
      record.chain_path,
    ],
    'inserting provenance: source_id or parent_id does not exist'
  );

  return record.id;
}

/**
 * Get a provenance record by ID
 *
 * @param db - Database connection
 * @param id - Provenance record ID
 * @returns ProvenanceRecord | null - The provenance record or null if not found
 */
export function getProvenance(
  db: Database.Database,
  id: string
): ProvenanceRecord | null {
  const stmt = db.prepare('SELECT * FROM provenance WHERE id = ?');
  const row = stmt.get(id) as ProvenanceRow | undefined;
  return row ? rowToProvenance(row) : null;
}

/**
 * Get the complete provenance chain for a record
 * Walks parent_id links from the given record to the root document
 *
 * @param db - Database connection
 * @param id - Starting provenance record ID
 * @returns ProvenanceRecord[] - Array ordered from current to root
 */
export function getProvenanceChain(
  db: Database.Database,
  id: string
): ProvenanceRecord[] {
  const chain: ProvenanceRecord[] = [];
  let currentId: string | null = id;

  while (currentId !== null) {
    const record = getProvenance(db, currentId);
    if (!record) {
      break;
    }
    chain.push(record);
    currentId = record.parent_id;
  }

  return chain;
}

/**
 * Get all provenance records for a root document
 *
 * @param db - Database connection
 * @param rootDocumentId - The root document ID
 * @returns ProvenanceRecord[] - Array of all provenance records
 */
export function getProvenanceByRootDocument(
  db: Database.Database,
  rootDocumentId: string
): ProvenanceRecord[] {
  const stmt = db.prepare(
    'SELECT * FROM provenance WHERE root_document_id = ? ORDER BY chain_depth'
  );
  const rows = stmt.all(rootDocumentId) as ProvenanceRow[];
  return rows.map(rowToProvenance);
}

/**
 * Get child provenance records for a parent
 *
 * @param db - Database connection
 * @param parentId - Parent provenance record ID
 * @returns ProvenanceRecord[] - Array of child records
 */
export function getProvenanceChildren(
  db: Database.Database,
  parentId: string
): ProvenanceRecord[] {
  const stmt = db.prepare(
    'SELECT * FROM provenance WHERE parent_id = ? ORDER BY created_at'
  );
  const rows = stmt.all(parentId) as ProvenanceRow[];
  return rows.map(rowToProvenance);
}
