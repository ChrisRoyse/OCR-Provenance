/**
 * DatabaseService for OCR Provenance MCP System
 *
 * Provides all database operations for documents, OCR results, chunks,
 * embeddings, and provenance records.
 *
 * Security: All SQL uses parameterized queries via db.prepare() (SEC-006)
 * Performance: WAL mode, proper indexes, foreign key constraints
 * Permissions: Database files created with mode 0o600 (SEC-003)
 */

import Database from 'better-sqlite3';
import {
  statSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import {
  initializeDatabase,
  migrateToLatest,
  verifySchema,
  MigrationError,
} from './migrations.js';
import { Document, DocumentStatus, OCRResult } from '../../models/document.js';
import { Chunk } from '../../models/chunk.js';
import { Embedding } from '../../models/embedding.js';
import {
  ProvenanceRecord,
  ProvenanceType,
  ProvenanceLocation,
} from '../../models/provenance.js';
import { SqliteVecModule } from './types.js';

// Create require function for CommonJS modules in ESM context
const require = createRequire(import.meta.url);

// Re-export MigrationError for convenience
export { MigrationError };

/**
 * Default storage path for databases
 */
const DEFAULT_STORAGE_PATH = join(homedir(), '.ocr-provenance', 'databases');

/**
 * Valid database name pattern: alphanumeric, underscores, hyphens
 */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Database information interface
 */
export interface DatabaseInfo {
  name: string;
  path: string;
  size_bytes: number;
  created_at: string;
  last_modified_at: string;
  total_documents: number;
  total_ocr_results: number;
  total_chunks: number;
  total_embeddings: number;
}

/**
 * Database statistics interface
 */
export interface DatabaseStats {
  name: string;
  total_documents: number;
  documents_by_status: {
    pending: number;
    processing: number;
    complete: number;
    failed: number;
  };
  total_ocr_results: number;
  total_chunks: number;
  chunks_by_embedding_status: {
    pending: number;
    complete: number;
    failed: number;
  };
  total_embeddings: number;
  storage_size_bytes: number;
  avg_chunks_per_document: number;
  avg_embeddings_per_chunk: number;
}

/**
 * Document list options
 */
export interface ListDocumentsOptions {
  status?: DocumentStatus;
  limit?: number;
  offset?: number;
}

/**
 * Error codes for database operations
 */
export enum DatabaseErrorCode {
  DATABASE_NOT_FOUND = 'DATABASE_NOT_FOUND',
  DATABASE_ALREADY_EXISTS = 'DATABASE_ALREADY_EXISTS',
  DATABASE_LOCKED = 'DATABASE_LOCKED',
  DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
  OCR_RESULT_NOT_FOUND = 'OCR_RESULT_NOT_FOUND',
  CHUNK_NOT_FOUND = 'CHUNK_NOT_FOUND',
  EMBEDDING_NOT_FOUND = 'EMBEDDING_NOT_FOUND',
  PROVENANCE_NOT_FOUND = 'PROVENANCE_NOT_FOUND',
  FOREIGN_KEY_VIOLATION = 'FOREIGN_KEY_VIOLATION',
  SCHEMA_MISMATCH = 'SCHEMA_MISMATCH',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INVALID_NAME = 'INVALID_NAME',
}

/**
 * Custom error class for database operations
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code: DatabaseErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/**
 * Helper function to run a statement with foreign key error handling.
 * Converts SQLite FK constraint errors to DatabaseError with proper code.
 *
 * @param stmt - Prepared statement to run
 * @param params - Parameters to bind
 * @param context - Error context message (e.g., "inserting document: provenance_id does not exist")
 */
function runWithForeignKeyCheck(
  stmt: Database.Statement,
  params: unknown[],
  context: string
): Database.RunResult {
  try {
    return stmt.run(...params);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('FOREIGN KEY constraint failed')
    ) {
      throw new DatabaseError(
        `Foreign key violation ${context}`,
        DatabaseErrorCode.FOREIGN_KEY_VIOLATION,
        error
      );
    }
    throw error;
  }
}

/**
 * Database row type for metadata
 */
interface MetadataRow {
  database_name: string;
  database_version: string;
  created_at: string;
  last_modified_at: string;
  total_documents: number;
  total_ocr_results: number;
  total_chunks: number;
  total_embeddings: number;
}

/**
 * Database row type for documents
 */
interface DocumentRow {
  id: string;
  file_path: string;
  file_name: string;
  file_hash: string;
  file_size: number;
  file_type: string;
  status: string;
  page_count: number | null;
  provenance_id: string;
  created_at: string;
  modified_at: string | null;
  ocr_completed_at: string | null;
  error_message: string | null;
}

/**
 * Database row type for OCR results
 */
interface OCRResultRow {
  id: string;
  provenance_id: string;
  document_id: string;
  extracted_text: string;
  text_length: number;
  datalab_request_id: string;
  datalab_mode: string;
  parse_quality_score: number | null;
  page_count: number;
  cost_cents: number | null;
  content_hash: string;
  processing_started_at: string;
  processing_completed_at: string;
  processing_duration_ms: number;
}

/**
 * Database row type for chunks
 */
interface ChunkRow {
  id: string;
  document_id: string;
  ocr_result_id: string;
  text: string;
  text_hash: string;
  chunk_index: number;
  character_start: number;
  character_end: number;
  page_number: number | null;
  page_range: string | null;
  overlap_previous: number;
  overlap_next: number;
  provenance_id: string;
  created_at: string;
  embedding_status: string;
  embedded_at: string | null;
}

/**
 * Database row type for embeddings (without vector)
 */
interface EmbeddingRow {
  id: string;
  chunk_id: string;
  document_id: string;
  original_text: string;
  original_text_length: number;
  source_file_path: string;
  source_file_name: string;
  source_file_hash: string;
  page_number: number | null;
  page_range: string | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  total_chunks: number;
  model_name: string;
  model_version: string;
  task_type: string;
  inference_mode: string;
  gpu_device: string | null;
  provenance_id: string;
  content_hash: string;
  created_at: string;
  generation_duration_ms: number | null;
}

/**
 * Database row type for provenance
 */
interface ProvenanceRow {
  id: string;
  type: string;
  created_at: string;
  processed_at: string;
  source_file_created_at: string | null;
  source_file_modified_at: string | null;
  source_type: string;
  source_path: string | null;
  source_id: string | null;
  root_document_id: string;
  location: string | null;
  content_hash: string;
  input_hash: string | null;
  file_hash: string | null;
  processor: string;
  processor_version: string;
  processing_params: string;
  processing_duration_ms: number | null;
  processing_quality_score: number | null;
  parent_id: string | null;
  parent_ids: string;
  chain_depth: number;
  chain_path: string | null;
}

/**
 * Validate database name format
 */
function validateName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new DatabaseError(
      'Database name is required and must be a string',
      DatabaseErrorCode.INVALID_NAME
    );
  }
  if (!VALID_NAME_PATTERN.test(name)) {
    throw new DatabaseError(
      `Invalid database name "${name}". Only alphanumeric characters, underscores, and hyphens are allowed.`,
      DatabaseErrorCode.INVALID_NAME
    );
  }
}

/**
 * Get full database path
 */
function getDatabasePath(name: string, storagePath?: string): string {
  const basePath = storagePath ?? DEFAULT_STORAGE_PATH;
  return join(basePath, `${name}.db`);
}

/**
 * Convert document row to Document interface
 */
function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    file_path: row.file_path,
    file_name: row.file_name,
    file_hash: row.file_hash,
    file_size: row.file_size,
    file_type: row.file_type,
    status: row.status as DocumentStatus,
    page_count: row.page_count,
    provenance_id: row.provenance_id,
    created_at: row.created_at,
    modified_at: row.modified_at,
    ocr_completed_at: row.ocr_completed_at,
    error_message: row.error_message,
  };
}

/**
 * Convert OCR result row to OCRResult interface
 */
function rowToOCRResult(row: OCRResultRow): OCRResult {
  return {
    id: row.id,
    provenance_id: row.provenance_id,
    document_id: row.document_id,
    extracted_text: row.extracted_text,
    text_length: row.text_length,
    datalab_request_id: row.datalab_request_id,
    datalab_mode: row.datalab_mode as 'fast' | 'balanced' | 'accurate',
    parse_quality_score: row.parse_quality_score,
    page_count: row.page_count,
    cost_cents: row.cost_cents,
    content_hash: row.content_hash,
    processing_started_at: row.processing_started_at,
    processing_completed_at: row.processing_completed_at,
    processing_duration_ms: row.processing_duration_ms,
  };
}

/**
 * Convert chunk row to Chunk interface
 */
function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    document_id: row.document_id,
    ocr_result_id: row.ocr_result_id,
    text: row.text,
    text_hash: row.text_hash,
    chunk_index: row.chunk_index,
    character_start: row.character_start,
    character_end: row.character_end,
    page_number: row.page_number,
    page_range: row.page_range,
    overlap_previous: row.overlap_previous,
    overlap_next: row.overlap_next,
    provenance_id: row.provenance_id,
    created_at: row.created_at,
    embedding_status: row.embedding_status as 'pending' | 'complete' | 'failed',
    embedded_at: row.embedded_at,
  };
}

/**
 * Convert embedding row to Embedding interface (without vector)
 */
function rowToEmbedding(row: EmbeddingRow): Omit<Embedding, 'vector'> {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    original_text: row.original_text,
    original_text_length: row.original_text_length,
    source_file_path: row.source_file_path,
    source_file_name: row.source_file_name,
    source_file_hash: row.source_file_hash,
    page_number: row.page_number,
    page_range: row.page_range,
    character_start: row.character_start,
    character_end: row.character_end,
    chunk_index: row.chunk_index,
    total_chunks: row.total_chunks,
    model_name: row.model_name,
    model_version: row.model_version,
    task_type: row.task_type as 'search_document' | 'search_query',
    inference_mode: row.inference_mode as 'local',
    gpu_device: row.gpu_device ?? '',
    provenance_id: row.provenance_id,
    content_hash: row.content_hash,
    created_at: row.created_at,
    generation_duration_ms: row.generation_duration_ms,
  };
}

/**
 * Convert provenance row to ProvenanceRecord interface
 */
function rowToProvenance(row: ProvenanceRow): ProvenanceRecord {
  return {
    id: row.id,
    type: row.type as ProvenanceType,
    created_at: row.created_at,
    processed_at: row.processed_at,
    source_file_created_at: row.source_file_created_at,
    source_file_modified_at: row.source_file_modified_at,
    source_type: row.source_type as 'FILE' | 'OCR' | 'CHUNKING' | 'EMBEDDING',
    source_path: row.source_path,
    source_id: row.source_id,
    root_document_id: row.root_document_id,
    location: row.location
      ? (JSON.parse(row.location) as ProvenanceLocation)
      : null,
    content_hash: row.content_hash,
    input_hash: row.input_hash,
    file_hash: row.file_hash,
    processor: row.processor,
    processor_version: row.processor_version,
    processing_params: JSON.parse(row.processing_params) as Record<
      string,
      unknown
    >,
    processing_duration_ms: row.processing_duration_ms,
    processing_quality_score: row.processing_quality_score,
    parent_id: row.parent_id,
    parent_ids: row.parent_ids,
    chain_depth: row.chain_depth,
    chain_path: row.chain_path,
  };
}

/**
 * DatabaseService class for all database operations
 *
 * Provides CRUD operations for documents, OCR results, chunks, embeddings,
 * and provenance records. Uses prepared statements for security and performance.
 */
export class DatabaseService {
  private db: Database.Database;
  private readonly name: string;
  private readonly path: string;

  /**
   * Private constructor - use static create() or open() methods
   */
  private constructor(db: Database.Database, name: string, path: string) {
    this.db = db;
    this.name = name;
    this.path = path;
  }

  /**
   * Create a new database
   *
   * @param name - Database name (alphanumeric, underscores, hyphens only)
   * @param description - Optional database description
   * @param storagePath - Optional custom storage path (default: ~/.ocr-provenance/databases/)
   * @returns DatabaseService - New database service instance
   * @throws DatabaseError if name is invalid or database already exists
   */
  static create(
    name: string,
    description?: string,
    storagePath?: string
  ): DatabaseService {
    // Validate name
    validateName(name);

    const basePath = storagePath ?? DEFAULT_STORAGE_PATH;
    const dbPath = getDatabasePath(name, storagePath);

    // Create storage directory if needed
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true, mode: 0o700 });
    }

    // Check database doesn't already exist
    if (existsSync(dbPath)) {
      throw new DatabaseError(
        `Database "${name}" already exists at ${dbPath}`,
        DatabaseErrorCode.DATABASE_ALREADY_EXISTS
      );
    }

    // Create empty file with secure permissions (SEC-003)
    writeFileSync(dbPath, '', { mode: 0o600 });

    // Ensure permissions are set (writeFileSync mode may not work on all systems)
    chmodSync(dbPath, 0o600);

    // Open database connection
    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch (error) {
      // Clean up the file we created
      try {
        unlinkSync(dbPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new DatabaseError(
        `Failed to create database "${name}": ${String(error)}`,
        DatabaseErrorCode.PERMISSION_DENIED,
        error
      );
    }

    // Initialize database schema
    try {
      initializeDatabase(db);
    } catch (error) {
      db.close();
      try {
        unlinkSync(dbPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }

    // Update database_metadata with database name and description
    try {
      const stmt = db.prepare(`
        UPDATE database_metadata
        SET database_name = ?, database_version = ?
        WHERE id = 1
      `);
      stmt.run(description ? `${name}: ${description}` : name, '1.0.0');
    } catch (error) {
      db.close();
      try {
        unlinkSync(dbPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new DatabaseError(
        `Failed to set database metadata: ${String(error)}`,
        DatabaseErrorCode.SCHEMA_MISMATCH,
        error
      );
    }

    return new DatabaseService(db, name, dbPath);
  }

  /**
   * Open an existing database
   *
   * @param name - Database name
   * @param storagePath - Optional custom storage path
   * @returns DatabaseService - Database service instance
   * @throws DatabaseError if database doesn't exist or schema is invalid
   */
  static open(name: string, storagePath?: string): DatabaseService {
    // Validate name
    validateName(name);

    const dbPath = getDatabasePath(name, storagePath);

    // Check database exists
    if (!existsSync(dbPath)) {
      throw new DatabaseError(
        `Database "${name}" not found at ${dbPath}`,
        DatabaseErrorCode.DATABASE_NOT_FOUND
      );
    }

    // Open database connection
    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch (error) {
      throw new DatabaseError(
        `Failed to open database "${name}": ${String(error)}`,
        DatabaseErrorCode.DATABASE_LOCKED,
        error
      );
    }

    // Load sqlite-vec extension
    try {
      const sqliteVec = require('sqlite-vec') as SqliteVecModule;
      sqliteVec.load(db);
    } catch (error) {
      db.close();
      throw new DatabaseError(
        `Failed to load sqlite-vec extension: ${String(error)}. Ensure sqlite-vec is installed.`,
        DatabaseErrorCode.SCHEMA_MISMATCH,
        error
      );
    }

    // Migrate to latest schema
    try {
      migrateToLatest(db);
    } catch (error) {
      db.close();
      throw error;
    }

    // Verify schema
    const verification = verifySchema(db);
    if (!verification.valid) {
      db.close();
      throw new DatabaseError(
        `Database schema verification failed. Missing tables: ${verification.missingTables.join(', ')}. ` +
          `Missing indexes: ${verification.missingIndexes.join(', ')}`,
        DatabaseErrorCode.SCHEMA_MISMATCH
      );
    }

    return new DatabaseService(db, name, dbPath);
  }

  /**
   * List all available databases
   *
   * @param storagePath - Optional custom storage path
   * @returns DatabaseInfo[] - Array of database information
   */
  static list(storagePath?: string): DatabaseInfo[] {
    const basePath = storagePath ?? DEFAULT_STORAGE_PATH;

    // Check if storage directory exists
    if (!existsSync(basePath)) {
      return [];
    }

    // Find all .db files
    const files = readdirSync(basePath).filter((f) => f.endsWith('.db'));
    const databases: DatabaseInfo[] = [];

    for (const file of files) {
      const name = file.replace('.db', '');
      const dbPath = join(basePath, file);

      try {
        // Get file stats
        const stats = statSync(dbPath);

        // Open database temporarily to read metadata
        const db = new Database(dbPath, { readonly: true });

        try {
          const row = db
            .prepare(
              `
            SELECT database_name, created_at, last_modified_at,
                   total_documents, total_ocr_results, total_chunks, total_embeddings
            FROM database_metadata WHERE id = 1
          `
            )
            .get() as MetadataRow | undefined;

          if (row) {
            databases.push({
              name,
              path: dbPath,
              size_bytes: stats.size,
              created_at: row.created_at,
              last_modified_at: row.last_modified_at,
              total_documents: row.total_documents,
              total_ocr_results: row.total_ocr_results,
              total_chunks: row.total_chunks,
              total_embeddings: row.total_embeddings,
            });
          }
        } finally {
          db.close();
        }
      } catch {
        // Skip databases that can't be read
        continue;
      }
    }

    return databases;
  }

  /**
   * Delete a database
   *
   * @param name - Database name to delete
   * @param storagePath - Optional custom storage path
   * @throws DatabaseError if database doesn't exist
   */
  static delete(name: string, storagePath?: string): void {
    validateName(name);

    const dbPath = getDatabasePath(name, storagePath);

    if (!existsSync(dbPath)) {
      throw new DatabaseError(
        `Database "${name}" not found at ${dbPath}`,
        DatabaseErrorCode.DATABASE_NOT_FOUND
      );
    }

    // Delete main database file and WAL/SHM files if they exist
    unlinkSync(dbPath);
    for (const suffix of ['-wal', '-shm']) {
      const path = `${dbPath}${suffix}`;
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }

  /**
   * Check if a database exists
   *
   * @param name - Database name
   * @param storagePath - Optional custom storage path
   * @returns boolean - True if database exists
   */
  static exists(name: string, storagePath?: string): boolean {
    try {
      validateName(name);
    } catch {
      return false;
    }
    const dbPath = getDatabasePath(name, storagePath);
    return existsSync(dbPath);
  }

  // ==================== INSTANCE METHODS ====================

  /**
   * Get database statistics
   *
   * @returns DatabaseStats - Live statistics from database
   */
  getStats(): DatabaseStats {
    // Get document counts by status
    const docStats = this.db
      .prepare(
        `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing,
        COUNT(*) FILTER (WHERE status = 'complete') as complete,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) as total
      FROM documents
    `
      )
      .get() as {
      pending: number;
      processing: number;
      complete: number;
      failed: number;
      total: number;
    };

    // Get chunk counts by embedding status
    const chunkStats = this.db
      .prepare(
        `
      SELECT
        COUNT(*) FILTER (WHERE embedding_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE embedding_status = 'complete') as complete,
        COUNT(*) FILTER (WHERE embedding_status = 'failed') as failed,
        COUNT(*) as total
      FROM chunks
    `
      )
      .get() as {
      pending: number;
      complete: number;
      failed: number;
      total: number;
    };

    // Get OCR result count
    const ocrCount = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM ocr_results')
        .get() as { count: number }
    ).count;

    // Get embedding count
    const embeddingCount = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM embeddings')
        .get() as { count: number }
    ).count;

    // Get file size
    const stats = statSync(this.path);

    // Calculate averages
    const avgChunksPerDocument =
      docStats.total > 0 ? chunkStats.total / docStats.total : 0;
    const avgEmbeddingsPerChunk =
      chunkStats.total > 0 ? embeddingCount / chunkStats.total : 0;

    return {
      name: this.name,
      total_documents: docStats.total,
      documents_by_status: {
        pending: docStats.pending,
        processing: docStats.processing,
        complete: docStats.complete,
        failed: docStats.failed,
      },
      total_ocr_results: ocrCount,
      total_chunks: chunkStats.total,
      chunks_by_embedding_status: {
        pending: chunkStats.pending,
        complete: chunkStats.complete,
        failed: chunkStats.failed,
      },
      total_embeddings: embeddingCount,
      storage_size_bytes: stats.size,
      avg_chunks_per_document: avgChunksPerDocument,
      avg_embeddings_per_chunk: avgEmbeddingsPerChunk,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get database name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get database file path
   */
  getPath(): string {
    return this.path;
  }

  /**
   * Execute a function within a transaction
   *
   * @param fn - Function to execute within transaction
   * @returns T - Result of the function
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Get the underlying database connection
   * Use with caution - prefer using provided methods
   *
   * @returns Database.Database - The better-sqlite3 database instance
   */
  getConnection(): Database.Database {
    return this.db;
  }

  // ==================== DOCUMENT OPERATIONS ====================

  /**
   * Insert a new document
   *
   * @param doc - Document data (created_at will be generated)
   * @returns string - The document ID
   */
  insertDocument(doc: Omit<Document, 'created_at'>): string {
    const created_at = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_hash, file_size, file_type,
        status, page_count, provenance_id, created_at, modified_at,
        ocr_completed_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    runWithForeignKeyCheck(
      stmt,
      [
        doc.id,
        doc.file_path,
        doc.file_name,
        doc.file_hash,
        doc.file_size,
        doc.file_type,
        doc.status,
        doc.page_count,
        doc.provenance_id,
        created_at,
        doc.modified_at,
        doc.ocr_completed_at,
        doc.error_message,
      ],
      `inserting document: provenance_id "${doc.provenance_id}" does not exist`
    );

    this.updateMetadataCounts();
    return doc.id;
  }

  /**
   * Get a document by ID
   *
   * @param id - Document ID
   * @returns Document | null - The document or null if not found
   */
  getDocument(id: string): Document | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE id = ?');
    const row = stmt.get(id) as DocumentRow | undefined;
    return row ? rowToDocument(row) : null;
  }

  /**
   * Get a document by file path
   *
   * @param filePath - Full file path
   * @returns Document | null - The document or null if not found
   */
  getDocumentByPath(filePath: string): Document | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE file_path = ?');
    const row = stmt.get(filePath) as DocumentRow | undefined;
    return row ? rowToDocument(row) : null;
  }

  /**
   * Get a document by file hash
   *
   * @param fileHash - SHA-256 file hash
   * @returns Document | null - The document or null if not found
   */
  getDocumentByHash(fileHash: string): Document | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE file_hash = ?');
    const row = stmt.get(fileHash) as DocumentRow | undefined;
    return row ? rowToDocument(row) : null;
  }

  /**
   * List documents with optional filtering
   *
   * @param options - Optional filter options (status, limit, offset)
   * @returns Document[] - Array of documents
   */
  listDocuments(options?: ListDocumentsOptions): Document[] {
    let query = 'SELECT * FROM documents';
    const params: (string | number)[] = [];

    if (options?.status) {
      query += ' WHERE status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset !== undefined) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as DocumentRow[];
    return rows.map(rowToDocument);
  }

  /**
   * Update document status
   *
   * @param id - Document ID
   * @param status - New status
   * @param errorMessage - Optional error message (for 'failed' status)
   */
  updateDocumentStatus(
    id: string,
    status: DocumentStatus,
    errorMessage?: string
  ): void {
    const modified_at = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE documents
      SET status = ?, error_message = ?, modified_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(status, errorMessage ?? null, modified_at, id);

    if (result.changes === 0) {
      throw new DatabaseError(
        `Document "${id}" not found`,
        DatabaseErrorCode.DOCUMENT_NOT_FOUND
      );
    }

    this.updateMetadataModified();
  }

  /**
   * Update document when OCR completes
   *
   * @param id - Document ID
   * @param pageCount - Number of pages processed
   * @param ocrCompletedAt - ISO 8601 completion timestamp
   */
  updateDocumentOCRComplete(
    id: string,
    pageCount: number,
    ocrCompletedAt: string
  ): void {
    const modified_at = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE documents
      SET page_count = ?, ocr_completed_at = ?, status = 'complete', modified_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(pageCount, ocrCompletedAt, modified_at, id);

    if (result.changes === 0) {
      throw new DatabaseError(
        `Document "${id}" not found`,
        DatabaseErrorCode.DOCUMENT_NOT_FOUND
      );
    }

    this.updateMetadataModified();
  }

  /**
   * Delete a document and all related data (CASCADE DELETE)
   *
   * @param id - Document ID to delete
   */
  deleteDocument(id: string): void {
    this.transaction(() => {
      // First check document exists
      const doc = this.getDocument(id);
      if (!doc) {
        throw new DatabaseError(
          `Document "${id}" not found`,
          DatabaseErrorCode.DOCUMENT_NOT_FOUND
        );
      }

      // Get all embedding IDs for this document
      const embeddingIds = this.db
        .prepare('SELECT id FROM embeddings WHERE document_id = ?')
        .all(id) as { id: string }[];

      // Delete from vec_embeddings for each embedding
      const deleteVecStmt = this.db.prepare(
        'DELETE FROM vec_embeddings WHERE embedding_id = ?'
      );
      for (const { id: embeddingId } of embeddingIds) {
        deleteVecStmt.run(embeddingId);
      }

      // Delete from embeddings
      this.db
        .prepare('DELETE FROM embeddings WHERE document_id = ?')
        .run(id);

      // Delete from chunks
      this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);

      // Delete from ocr_results
      this.db
        .prepare('DELETE FROM ocr_results WHERE document_id = ?')
        .run(id);

      // Delete the document itself BEFORE provenance
      // (document has FK to provenance via provenance_id)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);

      // Delete from provenance - must delete in reverse chain_depth order
      // due to self-referential FKs on source_id and parent_id
      const provenanceIds = this.db
        .prepare(
          'SELECT id FROM provenance WHERE root_document_id = ? ORDER BY chain_depth DESC'
        )
        .all(id) as { id: string }[];

      const deleteProvStmt = this.db.prepare('DELETE FROM provenance WHERE id = ?');
      for (const { id: provId } of provenanceIds) {
        deleteProvStmt.run(provId);
      }

      // Update metadata counts
      this.updateMetadataCounts();
    });
  }

  // ==================== OCR RESULT OPERATIONS ====================

  /**
   * Insert an OCR result
   *
   * @param result - OCR result data
   * @returns string - The OCR result ID
   */
  insertOCRResult(result: OCRResult): string {
    const stmt = this.db.prepare(`
      INSERT INTO ocr_results (
        id, provenance_id, document_id, extracted_text, text_length,
        datalab_request_id, datalab_mode, parse_quality_score, page_count,
        cost_cents, content_hash, processing_started_at, processing_completed_at,
        processing_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    runWithForeignKeyCheck(
      stmt,
      [
        result.id,
        result.provenance_id,
        result.document_id,
        result.extracted_text,
        result.text_length,
        result.datalab_request_id,
        result.datalab_mode,
        result.parse_quality_score,
        result.page_count,
        result.cost_cents,
        result.content_hash,
        result.processing_started_at,
        result.processing_completed_at,
        result.processing_duration_ms,
      ],
      `inserting OCR result: document_id "${result.document_id}" or provenance_id "${result.provenance_id}" does not exist`
    );

    this.updateMetadataCounts();
    return result.id;
  }

  /**
   * Get an OCR result by ID
   *
   * @param id - OCR result ID
   * @returns OCRResult | null - The OCR result or null if not found
   */
  getOCRResult(id: string): OCRResult | null {
    const stmt = this.db.prepare('SELECT * FROM ocr_results WHERE id = ?');
    const row = stmt.get(id) as OCRResultRow | undefined;
    return row ? rowToOCRResult(row) : null;
  }

  /**
   * Get OCR result by document ID
   *
   * @param documentId - Document ID
   * @returns OCRResult | null - The OCR result or null if not found
   */
  getOCRResultByDocumentId(documentId: string): OCRResult | null {
    const stmt = this.db.prepare(
      'SELECT * FROM ocr_results WHERE document_id = ?'
    );
    const row = stmt.get(documentId) as OCRResultRow | undefined;
    return row ? rowToOCRResult(row) : null;
  }

  // ==================== CHUNK OPERATIONS ====================

  /**
   * Insert a chunk
   *
   * @param chunk - Chunk data (created_at, embedding_status, embedded_at will be generated)
   * @returns string - The chunk ID
   */
  insertChunk(
    chunk: Omit<Chunk, 'created_at' | 'embedding_status' | 'embedded_at'>
  ): string {
    const created_at = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO chunks (
        id, document_id, ocr_result_id, text, text_hash, chunk_index,
        character_start, character_end, page_number, page_range,
        overlap_previous, overlap_next, provenance_id, created_at,
        embedding_status, embedded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    runWithForeignKeyCheck(
      stmt,
      [
        chunk.id,
        chunk.document_id,
        chunk.ocr_result_id,
        chunk.text,
        chunk.text_hash,
        chunk.chunk_index,
        chunk.character_start,
        chunk.character_end,
        chunk.page_number,
        chunk.page_range,
        chunk.overlap_previous,
        chunk.overlap_next,
        chunk.provenance_id,
        created_at,
        'pending',
        null,
      ],
      'inserting chunk: document_id, ocr_result_id, or provenance_id does not exist'
    );

    this.updateMetadataCounts();
    return chunk.id;
  }

  /**
   * Insert multiple chunks in a batch transaction
   *
   * @param chunks - Array of chunk data
   * @returns string[] - Array of chunk IDs
   */
  insertChunks(
    chunks: Omit<Chunk, 'created_at' | 'embedding_status' | 'embedded_at'>[]
  ): string[] {
    if (chunks.length === 0) {
      return [];
    }

    return this.transaction(() => {
      const created_at = new Date().toISOString();
      const ids: string[] = [];

      const stmt = this.db.prepare(`
        INSERT INTO chunks (
          id, document_id, ocr_result_id, text, text_hash, chunk_index,
          character_start, character_end, page_number, page_range,
          overlap_previous, overlap_next, provenance_id, created_at,
          embedding_status, embedded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of chunks) {
        runWithForeignKeyCheck(
          stmt,
          [
            chunk.id,
            chunk.document_id,
            chunk.ocr_result_id,
            chunk.text,
            chunk.text_hash,
            chunk.chunk_index,
            chunk.character_start,
            chunk.character_end,
            chunk.page_number,
            chunk.page_range,
            chunk.overlap_previous,
            chunk.overlap_next,
            chunk.provenance_id,
            created_at,
            'pending',
            null,
          ],
          `inserting chunk "${chunk.id}"`
        );
        ids.push(chunk.id);
      }

      this.updateMetadataCounts();
      return ids;
    });
  }

  /**
   * Get a chunk by ID
   *
   * @param id - Chunk ID
   * @returns Chunk | null - The chunk or null if not found
   */
  getChunk(id: string): Chunk | null {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE id = ?');
    const row = stmt.get(id) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  /**
   * Get all chunks for a document
   *
   * @param documentId - Document ID
   * @returns Chunk[] - Array of chunks ordered by chunk_index
   */
  getChunksByDocumentId(documentId: string): Chunk[] {
    const stmt = this.db.prepare(
      'SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index'
    );
    const rows = stmt.all(documentId) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Get all chunks for an OCR result
   *
   * @param ocrResultId - OCR result ID
   * @returns Chunk[] - Array of chunks ordered by chunk_index
   */
  getChunksByOCRResultId(ocrResultId: string): Chunk[] {
    const stmt = this.db.prepare(
      'SELECT * FROM chunks WHERE ocr_result_id = ? ORDER BY chunk_index'
    );
    const rows = stmt.all(ocrResultId) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Get chunks pending embedding generation
   *
   * @param limit - Optional maximum number of chunks to return
   * @returns Chunk[] - Array of pending chunks
   */
  getPendingEmbeddingChunks(limit?: number): Chunk[] {
    const baseQuery = "SELECT * FROM chunks WHERE embedding_status = 'pending' ORDER BY created_at";
    const query = limit !== undefined ? `${baseQuery} LIMIT ?` : baseQuery;
    const stmt = this.db.prepare(query);
    const rows = (limit !== undefined ? stmt.all(limit) : stmt.all()) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Update chunk embedding status
   *
   * @param id - Chunk ID
   * @param status - New embedding status
   * @param embeddedAt - Optional ISO 8601 timestamp when embedded
   */
  updateChunkEmbeddingStatus(
    id: string,
    status: 'pending' | 'complete' | 'failed',
    embeddedAt?: string
  ): void {
    const stmt = this.db.prepare(`
      UPDATE chunks
      SET embedding_status = ?, embedded_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(status, embeddedAt ?? null, id);

    if (result.changes === 0) {
      throw new DatabaseError(
        `Chunk "${id}" not found`,
        DatabaseErrorCode.CHUNK_NOT_FOUND
      );
    }

    this.updateMetadataModified();
  }

  // ==================== EMBEDDING OPERATIONS ====================

  /**
   * Insert an embedding (vector stored separately in vec_embeddings by VectorService)
   *
   * @param embedding - Embedding data (created_at will be generated, vector excluded)
   * @returns string - The embedding ID
   */
  insertEmbedding(embedding: Omit<Embedding, 'created_at' | 'vector'>): string {
    const created_at = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO embeddings (
        id, chunk_id, document_id, original_text, original_text_length,
        source_file_path, source_file_name, source_file_hash,
        page_number, page_range, character_start, character_end,
        chunk_index, total_chunks, model_name, model_version,
        task_type, inference_mode, gpu_device, provenance_id,
        content_hash, created_at, generation_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    runWithForeignKeyCheck(
      stmt,
      [
        embedding.id,
        embedding.chunk_id,
        embedding.document_id,
        embedding.original_text,
        embedding.original_text_length,
        embedding.source_file_path,
        embedding.source_file_name,
        embedding.source_file_hash,
        embedding.page_number,
        embedding.page_range,
        embedding.character_start,
        embedding.character_end,
        embedding.chunk_index,
        embedding.total_chunks,
        embedding.model_name,
        embedding.model_version,
        embedding.task_type,
        embedding.inference_mode,
        embedding.gpu_device,
        embedding.provenance_id,
        embedding.content_hash,
        created_at,
        embedding.generation_duration_ms,
      ],
      'inserting embedding: chunk_id, document_id, or provenance_id does not exist'
    );

    this.updateMetadataCounts();
    return embedding.id;
  }

  /**
   * Insert multiple embeddings in a batch transaction
   *
   * @param embeddings - Array of embedding data
   * @returns string[] - Array of embedding IDs
   */
  insertEmbeddings(
    embeddings: Omit<Embedding, 'created_at' | 'vector'>[]
  ): string[] {
    if (embeddings.length === 0) {
      return [];
    }

    return this.transaction(() => {
      const created_at = new Date().toISOString();
      const ids: string[] = [];

      const stmt = this.db.prepare(`
        INSERT INTO embeddings (
          id, chunk_id, document_id, original_text, original_text_length,
          source_file_path, source_file_name, source_file_hash,
          page_number, page_range, character_start, character_end,
          chunk_index, total_chunks, model_name, model_version,
          task_type, inference_mode, gpu_device, provenance_id,
          content_hash, created_at, generation_duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const embedding of embeddings) {
        runWithForeignKeyCheck(
          stmt,
          [
            embedding.id,
            embedding.chunk_id,
            embedding.document_id,
            embedding.original_text,
            embedding.original_text_length,
            embedding.source_file_path,
            embedding.source_file_name,
            embedding.source_file_hash,
            embedding.page_number,
            embedding.page_range,
            embedding.character_start,
            embedding.character_end,
            embedding.chunk_index,
            embedding.total_chunks,
            embedding.model_name,
            embedding.model_version,
            embedding.task_type,
            embedding.inference_mode,
            embedding.gpu_device,
            embedding.provenance_id,
            embedding.content_hash,
            created_at,
            embedding.generation_duration_ms,
          ],
          `inserting embedding "${embedding.id}"`
        );
        ids.push(embedding.id);
      }

      this.updateMetadataCounts();
      return ids;
    });
  }

  /**
   * Get an embedding by ID (without vector)
   *
   * @param id - Embedding ID
   * @returns Omit<Embedding, 'vector'> | null - The embedding or null if not found
   */
  getEmbedding(id: string): Omit<Embedding, 'vector'> | null {
    const stmt = this.db.prepare('SELECT * FROM embeddings WHERE id = ?');
    const row = stmt.get(id) as EmbeddingRow | undefined;
    return row ? rowToEmbedding(row) : null;
  }

  /**
   * Get embedding by chunk ID (without vector)
   *
   * @param chunkId - Chunk ID
   * @returns Omit<Embedding, 'vector'> | null - The embedding or null if not found
   */
  getEmbeddingByChunkId(chunkId: string): Omit<Embedding, 'vector'> | null {
    const stmt = this.db.prepare(
      'SELECT * FROM embeddings WHERE chunk_id = ?'
    );
    const row = stmt.get(chunkId) as EmbeddingRow | undefined;
    return row ? rowToEmbedding(row) : null;
  }

  /**
   * Get all embeddings for a document (without vectors)
   *
   * @param documentId - Document ID
   * @returns Omit<Embedding, 'vector'>[] - Array of embeddings
   */
  getEmbeddingsByDocumentId(
    documentId: string
  ): Omit<Embedding, 'vector'>[] {
    const stmt = this.db.prepare(
      'SELECT * FROM embeddings WHERE document_id = ? ORDER BY chunk_index'
    );
    const rows = stmt.all(documentId) as EmbeddingRow[];
    return rows.map(rowToEmbedding);
  }

  // ==================== PROVENANCE OPERATIONS ====================

  /**
   * Insert a provenance record
   *
   * @param record - Provenance record data
   * @returns string - The provenance record ID
   */
  insertProvenance(record: ProvenanceRecord): string {
    const stmt = this.db.prepare(`
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
   * @param id - Provenance record ID
   * @returns ProvenanceRecord | null - The provenance record or null if not found
   */
  getProvenance(id: string): ProvenanceRecord | null {
    const stmt = this.db.prepare('SELECT * FROM provenance WHERE id = ?');
    const row = stmt.get(id) as ProvenanceRow | undefined;
    return row ? rowToProvenance(row) : null;
  }

  /**
   * Get the complete provenance chain for a record
   * Walks parent_id links from the given record to the root document
   *
   * @param id - Starting provenance record ID
   * @returns ProvenanceRecord[] - Array ordered from current to root
   */
  getProvenanceChain(id: string): ProvenanceRecord[] {
    const chain: ProvenanceRecord[] = [];
    let currentId: string | null = id;

    while (currentId !== null) {
      const record = this.getProvenance(currentId);
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
   * @param rootDocumentId - The root document ID
   * @returns ProvenanceRecord[] - Array of all provenance records
   */
  getProvenanceByRootDocument(rootDocumentId: string): ProvenanceRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM provenance WHERE root_document_id = ? ORDER BY chain_depth'
    );
    const rows = stmt.all(rootDocumentId) as ProvenanceRow[];
    return rows.map(rowToProvenance);
  }

  /**
   * Get child provenance records for a parent
   *
   * @param parentId - Parent provenance record ID
   * @returns ProvenanceRecord[] - Array of child records
   */
  getProvenanceChildren(parentId: string): ProvenanceRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM provenance WHERE parent_id = ? ORDER BY created_at'
    );
    const rows = stmt.all(parentId) as ProvenanceRow[];
    return rows.map(rowToProvenance);
  }

  // ==================== PRIVATE HELPERS ====================

  /**
   * Update metadata counts from actual table counts
   */
  private updateMetadataCounts(): void {
    const now = new Date().toISOString();
    const getCount = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;

    const stmt = this.db.prepare(`
      UPDATE database_metadata
      SET total_documents = ?, total_ocr_results = ?, total_chunks = ?,
          total_embeddings = ?, last_modified_at = ?
      WHERE id = 1
    `);

    stmt.run(
      getCount('documents'),
      getCount('ocr_results'),
      getCount('chunks'),
      getCount('embeddings'),
      now
    );
  }

  /**
   * Update metadata last_modified_at timestamp
   */
  private updateMetadataModified(): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE database_metadata SET last_modified_at = ? WHERE id = 1
    `);
    stmt.run(now);
  }
}
