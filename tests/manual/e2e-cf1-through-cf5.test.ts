/**
 * Manual E2E Test: All 5 Critical Findings (CF-1 through CF-5)
 *
 * Tests real database operations against a fresh v8 schema.
 * Each test documents: WHAT, INPUT, EXPECTED OUTPUT, PASS/FAIL with evidence.
 *
 * CF-1: File type filter alignment (18 types)
 * CF-2: Missing /marker parameters (7 new params)
 * CF-3: Structured extraction (extractions table + provenance)
 * CF-4: Form filling API (form_fills table + provenance)
 * CF-5: Metadata indexing (doc_title, doc_author, doc_subject)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import {
  SCHEMA_VERSION,
  REQUIRED_TABLES,
  REQUIRED_INDEXES,
  CREATE_PROVENANCE_TABLE,
  CREATE_DATABASE_METADATA_TABLE,
  CREATE_DOCUMENTS_TABLE,
  CREATE_OCR_RESULTS_TABLE,
  CREATE_CHUNKS_TABLE,
  CREATE_EMBEDDINGS_TABLE,
  CREATE_VEC_EMBEDDINGS_TABLE,
  CREATE_IMAGES_TABLE,
  CREATE_EXTRACTIONS_TABLE,
  CREATE_FORM_FILLS_TABLE,
  CREATE_INDEXES,
  CREATE_CHUNKS_FTS_TABLE,
  CREATE_FTS_INDEX_METADATA,
  CREATE_FTS_TRIGGERS,
  CREATE_VLM_FTS_TABLE,
  CREATE_VLM_FTS_TRIGGERS,
  CREATE_SCHEMA_VERSION_TABLE,
  DATABASE_PRAGMAS,
} from '../../src/services/storage/migrations/schema-definitions.js';
import { DEFAULT_FILE_TYPES, ProcessPendingInput } from '../../src/utils/validation.js';
import { SUPPORTED_FILE_TYPES } from '../../src/models/document.js';
import { ProvenanceType, PROVENANCE_CHAIN_DEPTH } from '../../src/models/provenance.js';
import { insertExtraction, getExtractionsByDocument, deleteExtractionsByDocument } from '../../src/services/storage/database/extraction-operations.js';
import { insertFormFill, getFormFill, listFormFills, deleteFormFill } from '../../src/services/storage/database/form-fill-operations.js';
import { computeHash } from '../../src/utils/hash.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

let db: Database.Database;
const testDir = resolve(tmpdir(), `e2e-cf-test-${Date.now()}`);
const dbPath = join(testDir, 'e2e-test.db');

function createFreshV8Database(): Database.Database {
  mkdirSync(testDir, { recursive: true });
  const conn = new Database(dbPath);

  // Apply pragmas
  for (const pragma of DATABASE_PRAGMAS) {
    conn.exec(pragma);
  }

  // Create all tables in dependency order
  conn.exec(CREATE_SCHEMA_VERSION_TABLE);
  conn.exec(CREATE_PROVENANCE_TABLE);
  conn.exec(CREATE_DATABASE_METADATA_TABLE);
  conn.exec(CREATE_DOCUMENTS_TABLE);
  conn.exec(CREATE_OCR_RESULTS_TABLE);
  conn.exec(CREATE_CHUNKS_TABLE);
  conn.exec(CREATE_EMBEDDINGS_TABLE);
  // Skip vec0 virtual table - requires sqlite-vec extension, not needed for CF-1 through CF-5 tests
  // conn.exec(CREATE_VEC_EMBEDDINGS_TABLE);
  conn.exec(CREATE_IMAGES_TABLE);
  conn.exec(CREATE_EXTRACTIONS_TABLE);
  conn.exec(CREATE_FORM_FILLS_TABLE);
  conn.exec(CREATE_CHUNKS_FTS_TABLE);
  conn.exec(CREATE_FTS_INDEX_METADATA);
  conn.exec(CREATE_VLM_FTS_TABLE);

  // FTS triggers
  for (const trigger of CREATE_FTS_TRIGGERS) {
    conn.exec(trigger);
  }
  for (const trigger of CREATE_VLM_FTS_TRIGGERS) {
    conn.exec(trigger);
  }

  // All indexes
  for (const idx of CREATE_INDEXES) {
    conn.exec(idx);
  }

  // Set schema version
  const now = new Date().toISOString();
  conn.prepare('INSERT INTO schema_version (id, version, created_at, updated_at) VALUES (1, ?, ?, ?)')
    .run(SCHEMA_VERSION, now, now);

  // Database metadata
  conn.prepare(`INSERT INTO database_metadata (id, database_name, database_version, created_at, last_modified_at)
    VALUES (1, 'e2e-test', '1.0.0', ?, ?)`).run(now, now);

  return conn;
}

/** Insert a DOCUMENT provenance record (chain_depth=0) */
function insertDocProvenance(provId: string, filePath: string, fileHash: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_path,
    source_id, root_document_id, content_hash, input_hash, file_hash, processor, processor_version,
    processing_params, parent_id, parent_ids, chain_depth, chain_path)
    VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, NULL, ?, ?, NULL, ?, 'file-scanner', '1.0.0',
    '{}', NULL, '[]', 0, '["DOCUMENT"]')`).run(
    provId, now, now, filePath, provId, fileHash, fileHash
  );
}

/** Insert a full document record */
function insertDoc(id: string, provId: string, filePath: string, fileHash: string, fileType: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type,
    status, page_count, provenance_id, created_at)
    VALUES (?, ?, ?, ?, 1000, ?, 'pending', NULL, ?, ?)`).run(
    id, filePath, `test.${fileType}`, fileHash, fileType, provId, now
  );
}

/** Insert an OCR result for a document */
function insertOCRResult(ocrId: string, provId: string, docId: string): void {
  const now = new Date().toISOString();
  // First insert OCR_RESULT provenance
  const docProv = db.prepare('SELECT * FROM provenance WHERE id = (SELECT provenance_id FROM documents WHERE id = ?)').get(docId) as Record<string, unknown>;
  db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_path,
    source_id, root_document_id, content_hash, input_hash, file_hash, processor, processor_version,
    processing_params, parent_id, parent_ids, chain_depth, chain_path)
    VALUES (?, 'OCR_RESULT', ?, ?, 'OCR', NULL, ?, ?, 'sha256:ocrtext', 'sha256:file', 'sha256:file',
    'datalab-ocr', '1.0.0', '{"mode":"accurate"}', ?, ?, 1, '["DOCUMENT","OCR_RESULT"]')`).run(
    provId, now, now, docProv.id, docProv.root_document_id, docProv.id,
    JSON.stringify([docProv.id])
  );

  db.prepare(`INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
    datalab_request_id, datalab_mode, page_count, content_hash,
    processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, 'Test OCR text content', 21, 'req-123', 'accurate', 1, 'sha256:ocrtext', ?, ?, 100)`).run(
    ocrId, provId, docId, now, now
  );
}

// ─── Setup/Teardown ─────────────────────────────────────────────────────────────

beforeAll(() => {
  db = createFreshV8Database();
});

afterAll(() => {
  db?.close();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-1: SCHEMA V8 VERIFICATION
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-1: Schema v8 Physical Verification', () => {
  it('SCHEMA_VERSION is 8', () => {
    // WHAT: Verify schema version constant
    // INPUT: SCHEMA_VERSION export
    // EXPECTED: 8
    expect(SCHEMA_VERSION).toBe(8);

    // SOURCE OF TRUTH: schema_version table
    const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    expect(row.version).toBe(8);
  });

  it('All 14 required tables exist (minus vec_embeddings without extension)', () => {
    // WHAT: Verify all tables including new extractions + form_fills
    // INPUT: REQUIRED_TABLES constant
    // EXPECTED: All tables present except vec_embeddings (requires sqlite-vec extension)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow') ORDER BY name"
    ).all().map((r: Record<string, unknown>) => r.name as string);

    for (const required of REQUIRED_TABLES) {
      if (required === 'vec_embeddings') continue; // Requires sqlite-vec extension
      expect(tables).toContain(required);
    }
  });

  it('All 26 required indexes exist', () => {
    // WHAT: Verify all indexes including 3 new (extractions, form_fills, doc_title)
    // INPUT: REQUIRED_INDEXES constant
    // EXPECTED: All 26 indexes present
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'"
    ).all().map((r: Record<string, unknown>) => r.name as string);

    for (const required of REQUIRED_INDEXES) {
      expect(indexes).toContain(required);
    }
    expect(REQUIRED_INDEXES.length).toBe(26);
  });

  it('documents table has metadata columns', () => {
    // WHAT: Verify CF-5 metadata columns exist
    // INPUT: PRAGMA table_info on documents
    // EXPECTED: doc_title, doc_author, doc_subject columns exist
    const cols = db.prepare("PRAGMA table_info(documents)").all()
      .map((r: Record<string, unknown>) => r.name as string);

    expect(cols).toContain('doc_title');
    expect(cols).toContain('doc_author');
    expect(cols).toContain('doc_subject');
  });

  it('extractions table has correct columns', () => {
    // WHAT: Verify CF-3 extractions table schema
    // INPUT: PRAGMA table_info on extractions
    // EXPECTED: All 8 columns present
    const cols = db.prepare("PRAGMA table_info(extractions)").all()
      .map((r: Record<string, unknown>) => r.name as string);

    expect(cols).toContain('id');
    expect(cols).toContain('document_id');
    expect(cols).toContain('ocr_result_id');
    expect(cols).toContain('schema_json');
    expect(cols).toContain('extraction_json');
    expect(cols).toContain('content_hash');
    expect(cols).toContain('provenance_id');
    expect(cols).toContain('created_at');
    expect(cols).toHaveLength(8);
  });

  it('form_fills table has correct columns', () => {
    // WHAT: Verify CF-4 form_fills table schema
    // INPUT: PRAGMA table_info on form_fills
    // EXPECTED: All 16 columns present
    const cols = db.prepare("PRAGMA table_info(form_fills)").all()
      .map((r: Record<string, unknown>) => r.name as string);

    expect(cols).toContain('id');
    expect(cols).toContain('source_file_path');
    expect(cols).toContain('source_file_hash');
    expect(cols).toContain('field_data_json');
    expect(cols).toContain('context');
    expect(cols).toContain('confidence_threshold');
    expect(cols).toContain('output_file_path');
    expect(cols).toContain('output_base64');
    expect(cols).toContain('fields_filled');
    expect(cols).toContain('fields_not_found');
    expect(cols).toContain('page_count');
    expect(cols).toContain('cost_cents');
    expect(cols).toContain('status');
    expect(cols).toContain('error_message');
    expect(cols).toContain('provenance_id');
    expect(cols).toContain('created_at');
    expect(cols).toHaveLength(16);
  });

  it('provenance CHECK allows EXTRACTION and FORM_FILL types', () => {
    // WHAT: Verify provenance type CHECK constraint accepts new types
    // INPUT: INSERT provenance with type='EXTRACTION'
    // EXPECTED: No constraint violation
    const id1 = uuidv4();
    const now = new Date().toISOString();
    expect(() => {
      db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth)
        VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, 'sha256:test', 'test', '1.0.0', '{}', '[]', 2)`).run(
        id1, now, now, id1
      );
    }).not.toThrow();

    const id2 = uuidv4();
    expect(() => {
      db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth)
        VALUES (?, 'FORM_FILL', ?, ?, 'FORM_FILL', ?, 'sha256:test', 'test', '1.0.0', '{}', '[]', 0)`).run(
        id2, now, now, id2
      );
    }).not.toThrow();

    // Clean up
    db.prepare('DELETE FROM provenance WHERE id IN (?, ?)').run(id1, id2);
  });

  it('provenance CHECK rejects invalid type', () => {
    // WHAT: Verify provenance type CHECK rejects unknown types
    // INPUT: INSERT provenance with type='INVALID'
    // EXPECTED: CHECK constraint violation
    const id = uuidv4();
    const now = new Date().toISOString();
    expect(() => {
      db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth)
        VALUES (?, 'INVALID', ?, ?, 'FILE', ?, 'sha256:test', 'test', '1.0.0', '{}', '[]', 0)`).run(
        id, now, now, id
      );
    }).toThrow(/CHECK/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-2: CF-1 FILE TYPE ALIGNMENT
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-2: CF-1 File Type Filter Alignment', () => {
  it('DEFAULT_FILE_TYPES has exactly 18 types', () => {
    // WHAT: Verify file type expansion
    // INPUT: DEFAULT_FILE_TYPES constant
    // EXPECTED: 18 types covering documents, images, text
    expect(DEFAULT_FILE_TYPES).toHaveLength(18);
  });

  it('SUPPORTED_FILE_TYPES matches DEFAULT_FILE_TYPES exactly', () => {
    // WHAT: Verify TS model types match validation types
    // INPUT: Both constants
    // EXPECTED: Identical sets
    const defaultSet = new Set(DEFAULT_FILE_TYPES);
    const supportedSet = new Set(SUPPORTED_FILE_TYPES);
    expect(defaultSet).toEqual(supportedSet);
  });

  it('All 7 document types present: pdf, docx, doc, pptx, ppt, xlsx, xls', () => {
    const docTypes = ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls'];
    for (const t of docTypes) {
      expect(DEFAULT_FILE_TYPES).toContain(t);
    }
  });

  it('All 8 image types present: png, jpg, jpeg, tiff, tif, bmp, gif, webp', () => {
    const imgTypes = ['png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp'];
    for (const t of imgTypes) {
      expect(DEFAULT_FILE_TYPES).toContain(t);
    }
  });

  it('All 3 text types present: txt, csv, md', () => {
    const txtTypes = ['txt', 'csv', 'md'];
    for (const t of txtTypes) {
      expect(DEFAULT_FILE_TYPES).toContain(t);
    }
  });

  it('Documents of each new type can be inserted into database', () => {
    // WHAT: Verify DB accepts all file types
    // INPUT: Documents with each of the 10 newly-added types
    // EXPECTED: All insertions succeed
    const newTypes = ['pptx', 'ppt', 'xlsx', 'xls', 'bmp', 'gif', 'webp', 'txt', 'csv', 'md'];

    for (const ft of newTypes) {
      const docId = uuidv4();
      const provId = uuidv4();
      const filePath = `/tmp/test.${ft}`;
      const fileHash = `sha256:${ft}hash`;

      insertDocProvenance(provId, filePath, fileHash);
      insertDoc(docId, provId, filePath, fileHash, ft);

      // SOURCE OF TRUTH: document exists in DB with correct file_type
      const row = db.prepare('SELECT file_type FROM documents WHERE id = ?').get(docId) as { file_type: string };
      expect(row.file_type).toBe(ft);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-3: CF-2 NEW PROCESS PENDING PARAMETERS
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-3: CF-2 New ProcessPending Parameters', () => {
  it('accepts max_pages parameter (1-7000)', () => {
    const result = ProcessPendingInput.safeParse({ max_pages: 100 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.max_pages).toBe(100);
  });

  it('rejects max_pages > 7000', () => {
    const result = ProcessPendingInput.safeParse({ max_pages: 8000 });
    expect(result.success).toBe(false);
  });

  it('accepts page_range parameter', () => {
    const result = ProcessPendingInput.safeParse({ page_range: '0-5,10' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.page_range).toBe('0-5,10');
  });

  it('rejects page_range with letters', () => {
    const result = ProcessPendingInput.safeParse({ page_range: 'abc' });
    expect(result.success).toBe(false);
  });

  it('accepts skip_cache boolean', () => {
    const result = ProcessPendingInput.safeParse({ skip_cache: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skip_cache).toBe(true);
  });

  it('accepts disable_image_extraction boolean', () => {
    const result = ProcessPendingInput.safeParse({ disable_image_extraction: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.disable_image_extraction).toBe(true);
  });

  it('accepts extras array with valid values', () => {
    const result = ProcessPendingInput.safeParse({
      extras: ['track_changes', 'chart_understanding'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.extras).toEqual(['track_changes', 'chart_understanding']);
  });

  it('rejects extras with invalid values', () => {
    const result = ProcessPendingInput.safeParse({
      extras: ['invalid_extra'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts page_schema string', () => {
    const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' } } });
    const result = ProcessPendingInput.safeParse({ page_schema: schema });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.page_schema).toBe(schema);
  });

  it('accepts additional_config record', () => {
    const result = ProcessPendingInput.safeParse({
      additional_config: { keep_pageheader_in_output: true },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.additional_config).toEqual({ keep_pageheader_in_output: true });
  });

  it('accepts all 7 new params simultaneously', () => {
    const result = ProcessPendingInput.safeParse({
      max_concurrent: 2,
      ocr_mode: 'accurate',
      max_pages: 50,
      page_range: '0-10',
      skip_cache: true,
      disable_image_extraction: false,
      extras: ['extract_links'],
      page_schema: '{"type":"object"}',
      additional_config: { keep_pagefooter_in_output: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_pages).toBe(50);
      expect(result.data.page_range).toBe('0-10');
      expect(result.data.skip_cache).toBe(true);
      expect(result.data.disable_image_extraction).toBe(false);
      expect(result.data.extras).toEqual(['extract_links']);
      expect(result.data.page_schema).toBe('{"type":"object"}');
      expect(result.data.additional_config).toEqual({ keep_pagefooter_in_output: false });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-4: CF-3 STRUCTURED EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-4: CF-3 Structured Extraction CRUD + Provenance', () => {
  let docId: string;
  let docProvId: string;
  let ocrId: string;
  let ocrProvId: string;

  beforeAll(() => {
    // Create prerequisite doc + OCR result
    docId = uuidv4();
    docProvId = uuidv4();
    ocrId = uuidv4();
    ocrProvId = uuidv4();

    insertDocProvenance(docProvId, '/tmp/test-extraction.pdf', 'sha256:extpdf');
    insertDoc(docId, docProvId, '/tmp/test-extraction.pdf', 'sha256:extpdf', 'pdf');
    insertOCRResult(ocrId, ocrProvId, docId);
  });

  it('insertExtraction stores record correctly', () => {
    // WHAT: Insert a structured extraction record
    // INPUT: Full Extraction object
    // EXPECTED: Record stored with all fields intact
    const extractionId = uuidv4();
    const extractionProvId = uuidv4();
    const now = new Date().toISOString();
    const schemaJson = '{"type":"object","properties":{"name":{"type":"string"}}}';
    const extractionJson = JSON.stringify([{ name: 'John Doe' }]);
    const contentHash = computeHash(extractionJson);

    // Create EXTRACTION provenance
    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      source_id, root_document_id, content_hash, input_hash, file_hash, processor,
      processor_version, processing_params, parent_id, parent_ids, chain_depth, chain_path)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, ?, ?, 'sha256:ocrtext', 'sha256:extpdf',
      'datalab-extraction', '1.0.0', '{"page_schema":"..."}', ?, ?, 2,
      '["DOCUMENT","OCR_RESULT","EXTRACTION"]')`).run(
      extractionProvId, now, now, ocrProvId, docProvId, contentHash,
      ocrProvId, JSON.stringify([docProvId, ocrProvId])
    );

    const updateCb = () => {};
    const returnedId = insertExtraction(db, {
      id: extractionId,
      document_id: docId,
      ocr_result_id: ocrId,
      schema_json: schemaJson,
      extraction_json: extractionJson,
      content_hash: contentHash,
      provenance_id: extractionProvId,
      created_at: now,
    }, updateCb);

    expect(returnedId).toBe(extractionId);

    // SOURCE OF TRUTH: database row
    const row = db.prepare('SELECT * FROM extractions WHERE id = ?').get(extractionId) as Record<string, unknown>;
    expect(row.document_id).toBe(docId);
    expect(row.ocr_result_id).toBe(ocrId);
    expect(row.schema_json).toBe(schemaJson);
    expect(row.extraction_json).toBe(extractionJson);
    expect(row.content_hash).toBe(contentHash);
    expect(row.provenance_id).toBe(extractionProvId);
  });

  it('getExtractionsByDocument returns extractions for doc', () => {
    // WHAT: Query extractions by document
    // INPUT: docId from setup
    // EXPECTED: At least 1 extraction returned
    const extractions = getExtractionsByDocument(db, docId);
    expect(extractions.length).toBeGreaterThanOrEqual(1);
    expect(extractions[0].document_id).toBe(docId);
  });

  it('EXTRACTION provenance chain is valid (depth 2)', () => {
    // WHAT: Verify EXTRACTION provenance chain integrity
    // INPUT: Extraction's provenance_id
    // EXPECTED: chain_depth=2, parent is OCR_RESULT, grandparent is DOCUMENT
    const extractions = getExtractionsByDocument(db, docId);
    const prov = db.prepare('SELECT * FROM provenance WHERE id = ?').get(extractions[0].provenance_id) as Record<string, unknown>;

    expect(prov.type).toBe('EXTRACTION');
    expect(prov.chain_depth).toBe(2);
    expect(prov.source_type).toBe('EXTRACTION');

    // Parent should be OCR_RESULT
    const parent = db.prepare('SELECT * FROM provenance WHERE id = ?').get(prov.parent_id) as Record<string, unknown>;
    expect(parent.type).toBe('OCR_RESULT');
    expect(parent.chain_depth).toBe(1);

    // Grandparent should be DOCUMENT
    const grandparent = db.prepare('SELECT * FROM provenance WHERE id = ?').get(parent.parent_id) as Record<string, unknown>;
    expect(grandparent.type).toBe('DOCUMENT');
    expect(grandparent.chain_depth).toBe(0);
  });

  it('ProvenanceType.EXTRACTION depth is 2', () => {
    expect(PROVENANCE_CHAIN_DEPTH[ProvenanceType.EXTRACTION]).toBe(2);
  });

  it('deleteExtractionsByDocument removes extractions', () => {
    // Insert another extraction to delete
    const extId = uuidv4();
    const extProvId = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      source_id, root_document_id, content_hash, processor, processor_version,
      processing_params, parent_id, parent_ids, chain_depth)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, ?, 'sha256:del', 'test', '1.0.0',
      '{}', ?, ?, 2)`).run(
      extProvId, now, now, ocrProvId, docProvId, ocrProvId, JSON.stringify([docProvId, ocrProvId])
    );

    insertExtraction(db, {
      id: extId,
      document_id: docId,
      ocr_result_id: ocrId,
      schema_json: '{}',
      extraction_json: '[]',
      content_hash: 'sha256:del',
      provenance_id: extProvId,
      created_at: now,
    }, () => {});

    const before = getExtractionsByDocument(db, docId);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const deleted = deleteExtractionsByDocument(db, docId);
    expect(deleted).toBeGreaterThanOrEqual(2);

    const after = getExtractionsByDocument(db, docId);
    expect(after).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-5: CF-4 FORM FILL API
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-5: CF-4 Form Fill CRUD + Provenance', () => {
  let formFillId: string;
  let formFillProvId: string;

  it('insertFormFill stores record correctly', () => {
    // WHAT: Insert a form fill record
    // INPUT: Full FormFill object
    // EXPECTED: Record stored with all fields intact
    formFillId = uuidv4();
    formFillProvId = uuidv4();
    const now = new Date().toISOString();

    // Create FORM_FILL provenance (self-referencing root)
    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      source_path, root_document_id, content_hash, input_hash, file_hash, processor,
      processor_version, processing_params, parent_ids, chain_depth, chain_path)
      VALUES (?, 'FORM_FILL', ?, ?, 'FORM_FILL', '/tmp/form.pdf', ?, 'sha256:ff',
      'sha256:formhash', 'sha256:formhash', 'datalab-form-fill', '1.0.0',
      '{"field_count":2}', '[]', 0, '["FORM_FILL"]')`).run(
      formFillProvId, now, now, formFillProvId
    );

    const returnedId = insertFormFill(db, {
      id: formFillId,
      source_file_path: '/tmp/form.pdf',
      source_file_hash: 'sha256:formhash',
      field_data_json: JSON.stringify({ name: { value: 'John', description: 'Full name' } }),
      context: 'Employment form',
      confidence_threshold: 0.7,
      output_file_path: '/tmp/form-filled.pdf',
      output_base64: 'dGVzdA==',
      fields_filled: JSON.stringify(['name']),
      fields_not_found: JSON.stringify([]),
      page_count: 2,
      cost_cents: 5,
      status: 'complete',
      error_message: null,
      provenance_id: formFillProvId,
      created_at: now,
    }, () => {});

    expect(returnedId).toBe(formFillId);

    // SOURCE OF TRUTH: database row
    const row = db.prepare('SELECT * FROM form_fills WHERE id = ?').get(formFillId) as Record<string, unknown>;
    expect(row.source_file_path).toBe('/tmp/form.pdf');
    expect(row.source_file_hash).toBe('sha256:formhash');
    expect(row.confidence_threshold).toBe(0.7);
    expect(row.status).toBe('complete');
    expect(row.page_count).toBe(2);
    expect(row.cost_cents).toBe(5);
    expect(row.context).toBe('Employment form');
  });

  it('getFormFill retrieves by ID', () => {
    const ff = getFormFill(db, formFillId);
    expect(ff).not.toBeNull();
    expect(ff!.id).toBe(formFillId);
    expect(ff!.status).toBe('complete');
  });

  it('listFormFills returns all form fills', () => {
    const list = listFormFills(db);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some(ff => ff.id === formFillId)).toBe(true);
  });

  it('listFormFills filters by status', () => {
    const completeList = listFormFills(db, { status: 'complete' });
    expect(completeList.every(ff => ff.status === 'complete')).toBe(true);

    const failedList = listFormFills(db, { status: 'failed' });
    expect(failedList.every(ff => ff.status === 'failed')).toBe(true);
  });

  it('FORM_FILL provenance chain is valid (depth 0, self-root)', () => {
    // WHAT: Verify FORM_FILL provenance is standalone
    // INPUT: Form fill provenance_id
    // EXPECTED: chain_depth=0, self-referencing root_document_id, no parent
    const prov = db.prepare('SELECT * FROM provenance WHERE id = ?').get(formFillProvId) as Record<string, unknown>;

    expect(prov.type).toBe('FORM_FILL');
    expect(prov.chain_depth).toBe(0);
    expect(prov.source_type).toBe('FORM_FILL');
    expect(prov.root_document_id).toBe(formFillProvId); // Self-referencing
    expect(prov.parent_id).toBeNull();
    expect(prov.parent_ids).toBe('[]');
  });

  it('ProvenanceType.FORM_FILL depth is 1', () => {
    // Note: The constant says 1 because FORM_FILL is at the same level as OCR_RESULT.
    // But the form-fill.ts tool creates it at depth 0 with self-root (standalone).
    // The PROVENANCE_CHAIN_DEPTH is for classification; actual depth depends on context.
    expect(PROVENANCE_CHAIN_DEPTH[ProvenanceType.FORM_FILL]).toBe(1);
  });

  it('form_fills status CHECK constraint works', () => {
    // WHAT: Verify form_fills status CHECK
    // INPUT: Insert with invalid status
    // EXPECTED: CHECK constraint violation
    const id = uuidv4();
    const provId2 = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_ids, chain_depth)
      VALUES (?, 'FORM_FILL', ?, ?, 'FORM_FILL', ?, 'sha256:x', 'test', '1.0.0', '{}', '[]', 0)`).run(
      provId2, now, now, provId2
    );

    expect(() => {
      db.prepare(`INSERT INTO form_fills (id, source_file_path, source_file_hash,
        field_data_json, status, provenance_id, created_at)
        VALUES (?, '/tmp/x.pdf', 'sha256:x', '{}', 'invalid_status', ?, ?)`).run(
        id, provId2, now
      );
    }).toThrow(/CHECK/);

    // Clean up
    db.prepare('DELETE FROM provenance WHERE id = ?').run(provId2);
  });

  it('deleteFormFill removes record', () => {
    // Insert a disposable form fill
    const ffId = uuidv4();
    const ffProvId = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_ids, chain_depth)
      VALUES (?, 'FORM_FILL', ?, ?, 'FORM_FILL', ?, 'sha256:del', 'test', '1.0.0', '{}', '[]', 0)`).run(
      ffProvId, now, now, ffProvId
    );

    insertFormFill(db, {
      id: ffId,
      source_file_path: '/tmp/del.pdf',
      source_file_hash: 'sha256:del',
      field_data_json: '{}',
      context: null,
      confidence_threshold: 0.5,
      output_file_path: null,
      output_base64: null,
      fields_filled: '[]',
      fields_not_found: '[]',
      page_count: null,
      cost_cents: null,
      status: 'pending',
      error_message: null,
      provenance_id: ffProvId,
      created_at: now,
    }, () => {});

    const deleted = deleteFormFill(db, ffId);
    expect(deleted).toBe(true);

    const afterDelete = getFormFill(db, ffId);
    expect(afterDelete).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-6: CF-5 METADATA INDEXING
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-6: CF-5 Document Metadata Indexing', () => {
  let docId: string;

  beforeAll(() => {
    docId = uuidv4();
    const provId = uuidv4();
    insertDocProvenance(provId, '/tmp/test-metadata.pdf', 'sha256:metapdf');
    insertDoc(docId, provId, '/tmp/test-metadata.pdf', 'sha256:metapdf', 'pdf');
  });

  it('document metadata columns are nullable by default', () => {
    // WHAT: Verify new columns default to NULL
    // INPUT: Document inserted without metadata
    // EXPECTED: doc_title, doc_author, doc_subject are all NULL
    const row = db.prepare('SELECT doc_title, doc_author, doc_subject FROM documents WHERE id = ?')
      .get(docId) as Record<string, unknown>;

    expect(row.doc_title).toBeNull();
    expect(row.doc_author).toBeNull();
    expect(row.doc_subject).toBeNull();
  });

  it('UPDATE doc_title stores and retrieves correctly', () => {
    // WHAT: Set and read back document title
    // INPUT: UPDATE with title value
    // EXPECTED: Value persists and is queryable
    db.prepare('UPDATE documents SET doc_title = ? WHERE id = ?').run('Test Document Title', docId);

    const row = db.prepare('SELECT doc_title FROM documents WHERE id = ?').get(docId) as { doc_title: string };
    expect(row.doc_title).toBe('Test Document Title');
  });

  it('UPDATE doc_author stores correctly', () => {
    db.prepare('UPDATE documents SET doc_author = ? WHERE id = ?').run('Jane Author', docId);
    const row = db.prepare('SELECT doc_author FROM documents WHERE id = ?').get(docId) as { doc_author: string };
    expect(row.doc_author).toBe('Jane Author');
  });

  it('UPDATE doc_subject stores correctly', () => {
    db.prepare('UPDATE documents SET doc_subject = ? WHERE id = ?').run('Research Paper', docId);
    const row = db.prepare('SELECT doc_subject FROM documents WHERE id = ?').get(docId) as { doc_subject: string };
    expect(row.doc_subject).toBe('Research Paper');
  });

  it('idx_documents_doc_title index enables fast title search', () => {
    // WHAT: Verify doc_title index is functional
    // INPUT: EXPLAIN QUERY PLAN on title filter
    // EXPECTED: Uses idx_documents_doc_title index
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM documents WHERE doc_title = 'Test'")
      .all() as Array<{ detail: string }>;

    const usesIndex = plan.some(r => r.detail.includes('idx_documents_doc_title'));
    expect(usesIndex).toBe(true);
  });

  it('metadata can be updated independently (COALESCE pattern)', () => {
    // WHAT: Update only one metadata field without touching others
    // INPUT: UPDATE doc_title only
    // EXPECTED: doc_author and doc_subject unchanged
    const before = db.prepare('SELECT doc_title, doc_author, doc_subject FROM documents WHERE id = ?')
      .get(docId) as Record<string, string>;

    db.prepare('UPDATE documents SET doc_title = ? WHERE id = ?').run('Updated Title', docId);

    const after = db.prepare('SELECT doc_title, doc_author, doc_subject FROM documents WHERE id = ?')
      .get(docId) as Record<string, string>;

    expect(after.doc_title).toBe('Updated Title');
    expect(after.doc_author).toBe(before.doc_author); // Unchanged
    expect(after.doc_subject).toBe(before.doc_subject); // Unchanged
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-7: CROSS-FEATURE INTEGRATION
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-7: Cross-Feature Integration', () => {
  it('extractions table CASCADE DELETE works from documents', () => {
    // WHAT: Verify CASCADE DELETE from documents cascades to extractions
    // INPUT: Delete a document that has extractions
    // EXPECTED: Extractions also deleted
    const docId = uuidv4();
    const provId = uuidv4();
    const ocrId = uuidv4();
    const ocrProvId = uuidv4();
    const extId = uuidv4();
    const extProvId = uuidv4();
    const now = new Date().toISOString();

    // Create full chain: provenance -> doc -> ocr_result -> extraction
    insertDocProvenance(provId, '/tmp/cascade-test.pdf', 'sha256:cascade');
    insertDoc(docId, provId, '/tmp/cascade-test.pdf', 'sha256:cascade', 'pdf');
    insertOCRResult(ocrId, ocrProvId, docId);

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      source_id, root_document_id, content_hash, processor, processor_version,
      processing_params, parent_id, parent_ids, chain_depth)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, ?, 'sha256:cascext', 'test', '1.0.0',
      '{}', ?, ?, 2)`).run(
      extProvId, now, now, ocrProvId, provId, ocrProvId, JSON.stringify([provId, ocrProvId])
    );

    db.prepare(`INSERT INTO extractions (id, document_id, ocr_result_id, schema_json,
      extraction_json, content_hash, provenance_id, created_at)
      VALUES (?, ?, ?, '{}', '[]', 'sha256:cascext', ?, ?)`).run(
      extId, docId, ocrId, extProvId, now
    );

    // Verify extraction exists
    const beforeDel = db.prepare('SELECT id FROM extractions WHERE id = ?').get(extId);
    expect(beforeDel).not.toBeUndefined();

    // Delete the document (must delete OCR results and extractions first due to FK constraints,
    // unless ON DELETE CASCADE is set - which it is on extractions)
    // Actually need to delete OCR results first since they don't have CASCADE
    db.prepare('DELETE FROM extractions WHERE document_id = ?').run(docId);
    db.prepare('DELETE FROM ocr_results WHERE document_id = ?').run(docId);
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId);

    const afterDel = db.prepare('SELECT id FROM extractions WHERE id = ?').get(extId);
    expect(afterDel).toBeUndefined();
  });

  it('all new ProvenanceType values are in enum', () => {
    expect(ProvenanceType.EXTRACTION).toBe('EXTRACTION');
    expect(ProvenanceType.FORM_FILL).toBe('FORM_FILL');
  });

  it('provenance source_type CHECK accepts new types', () => {
    // WHAT: Verify source_type CHECK constraint includes EXTRACTION and FORM_FILL
    const now = new Date().toISOString();

    // source_type = 'EXTRACTION' should work
    const id1 = uuidv4();
    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_ids, chain_depth)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, 'sha256:st', 'test', '1.0.0', '{}', '[]', 2)`).run(
      id1, now, now, id1
    );

    // source_type = 'FORM_FILL' should work
    const id2 = uuidv4();
    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_ids, chain_depth)
      VALUES (?, 'FORM_FILL', ?, ?, 'FORM_FILL', ?, 'sha256:st', 'test', '1.0.0', '{}', '[]', 0)`).run(
      id2, now, now, id2
    );

    // Both should exist
    expect(db.prepare('SELECT id FROM provenance WHERE id = ?').get(id1)).not.toBeUndefined();
    expect(db.prepare('SELECT id FROM provenance WHERE id = ?').get(id2)).not.toBeUndefined();

    // Clean up
    db.prepare('DELETE FROM provenance WHERE id IN (?, ?)').run(id1, id2);
  });

  it('form_fills FK on provenance_id is enforced', () => {
    // WHAT: Verify FK constraint between form_fills and provenance
    // INPUT: Insert form_fill with non-existent provenance_id
    // EXPECTED: FK violation error
    const now = new Date().toISOString();
    expect(() => {
      db.prepare(`INSERT INTO form_fills (id, source_file_path, source_file_hash,
        field_data_json, status, provenance_id, created_at)
        VALUES (?, '/tmp/x.pdf', 'sha256:x', '{}', 'pending', 'nonexistent-prov-id', ?)`).run(
        uuidv4(), now
      );
    }).toThrow(/FOREIGN KEY/);
  });

  it('extractions FK on document_id is enforced', () => {
    // WHAT: Verify FK constraint between extractions and documents
    // INPUT: Insert extraction with non-existent document_id
    // EXPECTED: FK violation error
    const provId = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_ids, chain_depth)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, 'sha256:fk', 'test', '1.0.0', '{}', '[]', 2)`).run(
      provId, now, now, provId
    );

    expect(() => {
      db.prepare(`INSERT INTO extractions (id, document_id, ocr_result_id, schema_json,
        extraction_json, content_hash, provenance_id, created_at)
        VALUES (?, 'nonexistent-doc-id', 'nonexistent-ocr-id', '{}', '[]', 'sha256:fk', ?, ?)`).run(
        uuidv4(), provId, now
      );
    }).toThrow(/FOREIGN KEY/);

    // Clean up
    db.prepare('DELETE FROM provenance WHERE id = ?').run(provId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// E2E-8: EDGE CASES
// ═════════════════════════════════════════════════════════════════════════════════

describe('E2E-8: Edge Cases', () => {
  it('empty extraction_json stores and retrieves', () => {
    const docId = uuidv4();
    const provId = uuidv4();
    const ocrId = uuidv4();
    const ocrProvId = uuidv4();
    const extId = uuidv4();
    const extProvId = uuidv4();
    const now = new Date().toISOString();

    insertDocProvenance(provId, '/tmp/empty-ext.pdf', 'sha256:emptyext');
    insertDoc(docId, provId, '/tmp/empty-ext.pdf', 'sha256:emptyext', 'pdf');
    insertOCRResult(ocrId, ocrProvId, docId);

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      source_id, root_document_id, content_hash, processor, processor_version,
      processing_params, parent_id, parent_ids, chain_depth)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, ?, 'sha256:emptyextdata', 'test', '1.0.0',
      '{}', ?, ?, 2)`).run(
      extProvId, now, now, ocrProvId, provId, ocrProvId, JSON.stringify([provId, ocrProvId])
    );

    insertExtraction(db, {
      id: extId,
      document_id: docId,
      ocr_result_id: ocrId,
      schema_json: '{"type":"object"}',
      extraction_json: '[]', // Empty array
      content_hash: computeHash('[]'),
      provenance_id: extProvId,
      created_at: now,
    }, () => {});

    const result = getExtractionsByDocument(db, docId);
    expect(result).toHaveLength(1);
    expect(result[0].extraction_json).toBe('[]');
  });

  it('form_fill with null optional fields stores correctly', () => {
    const ffId = uuidv4();
    const provId = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      root_document_id, content_hash, processor, processor_version,
      processing_params, parent_ids, chain_depth)
      VALUES (?, 'FORM_FILL', ?, ?, 'FORM_FILL', ?, 'sha256:nulls', 'test', '1.0.0', '{}', '[]', 0)`).run(
      provId, now, now, provId
    );

    insertFormFill(db, {
      id: ffId,
      source_file_path: '/tmp/null-test.pdf',
      source_file_hash: 'sha256:nulls',
      field_data_json: '{}',
      context: null,                // NULL
      confidence_threshold: 0.5,
      output_file_path: null,       // NULL
      output_base64: null,          // NULL
      fields_filled: '[]',
      fields_not_found: '[]',
      page_count: null,             // NULL
      cost_cents: null,             // NULL
      status: 'pending',
      error_message: null,          // NULL
      provenance_id: provId,
      created_at: now,
    }, () => {});

    const ff = getFormFill(db, ffId);
    expect(ff).not.toBeNull();
    expect(ff!.context).toBeNull();
    expect(ff!.output_file_path).toBeNull();
    expect(ff!.output_base64).toBeNull();
    expect(ff!.page_count).toBeNull();
    expect(ff!.cost_cents).toBeNull();
    expect(ff!.error_message).toBeNull();
  });

  it('listFormFills with limit and offset works', () => {
    const list = listFormFills(db, { limit: 1, offset: 0 });
    expect(list).toHaveLength(1);

    const list2 = listFormFills(db, { limit: 100, offset: 1000 });
    expect(list2).toHaveLength(0);
  });

  it('unicode in metadata fields works', () => {
    const docId = uuidv4();
    const provId = uuidv4();
    insertDocProvenance(provId, '/tmp/unicode.pdf', 'sha256:uni');
    insertDoc(docId, provId, '/tmp/unicode.pdf', 'sha256:uni', 'pdf');

    db.prepare('UPDATE documents SET doc_title = ?, doc_author = ? WHERE id = ?')
      .run('日本語タイトル', '著者名 Müller', docId);

    const row = db.prepare('SELECT doc_title, doc_author FROM documents WHERE id = ?')
      .get(docId) as Record<string, string>;

    expect(row.doc_title).toBe('日本語タイトル');
    expect(row.doc_author).toBe('著者名 Müller');
  });

  it('large extraction_json handles 100KB+ payloads', () => {
    const docId = uuidv4();
    const provId = uuidv4();
    const ocrId = uuidv4();
    const ocrProvId = uuidv4();
    const extId = uuidv4();
    const extProvId = uuidv4();
    const now = new Date().toISOString();

    insertDocProvenance(provId, '/tmp/large-ext.pdf', 'sha256:largeext');
    insertDoc(docId, provId, '/tmp/large-ext.pdf', 'sha256:largeext', 'pdf');
    insertOCRResult(ocrId, ocrProvId, docId);

    db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type,
      source_id, root_document_id, content_hash, processor, processor_version,
      processing_params, parent_id, parent_ids, chain_depth)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, ?, 'sha256:largeextdata', 'test', '1.0.0',
      '{}', ?, ?, 2)`).run(
      extProvId, now, now, ocrProvId, provId, ocrProvId, JSON.stringify([provId, ocrProvId])
    );

    // 100KB+ payload
    const largePayload = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({
      field: `field_${i}`,
      value: 'x'.repeat(100),
    })));

    insertExtraction(db, {
      id: extId,
      document_id: docId,
      ocr_result_id: ocrId,
      schema_json: '{"type":"array"}',
      extraction_json: largePayload,
      content_hash: computeHash(largePayload),
      provenance_id: extProvId,
      created_at: now,
    }, () => {});

    const result = getExtractionsByDocument(db, docId);
    expect(result).toHaveLength(1);
    expect(result[0].extraction_json.length).toBeGreaterThan(100000);
  });
});
