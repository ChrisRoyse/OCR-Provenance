/**
 * DatabaseService class for all database operations
 *
 * Provides CRUD operations for documents, OCR results, chunks, embeddings,
 * and provenance records. Uses prepared statements for security and performance.
 */

import Database from 'better-sqlite3';
import { Document, DocumentStatus, OCRResult } from '../../../models/document.js';
import { Chunk } from '../../../models/chunk.js';
import { Embedding } from '../../../models/embedding.js';
import { ProvenanceRecord } from '../../../models/provenance.js';
import { DatabaseInfo, DatabaseStats, ListDocumentsOptions } from './types.js';
import {
  createDatabase,
  openDatabase,
  listDatabases,
  deleteDatabase,
  databaseExists,
} from './static-operations.js';
import {
  getStats,
  updateMetadataCounts,
  updateMetadataModified,
} from './stats-operations.js';
import * as docOps from './document-operations.js';
import * as ocrOps from './ocr-operations.js';
import * as chunkOps from './chunk-operations.js';
import * as embOps from './embedding-operations.js';
import * as provOps from './provenance-operations.js';
import * as extOps from './extraction-operations.js';
import * as ffOps from './form-fill-operations.js';
import { updateImageProvenance } from './image-operations.js';
import type { Extraction } from '../../../models/extraction.js';
import type { FormFill } from '../../../models/form-fill.js';

/**
 * DatabaseService class for all database operations
 */
export class DatabaseService {
  private db: Database.Database;
  private readonly name: string;
  private readonly path: string;

  private constructor(db: Database.Database, name: string, path: string) {
    this.db = db;
    this.name = name;
    this.path = path;
  }

  static create(name: string, description?: string, storagePath?: string): DatabaseService {
    const result = createDatabase(name, description, storagePath);
    return new DatabaseService(result.db, result.name, result.path);
  }

  static open(name: string, storagePath?: string): DatabaseService {
    const result = openDatabase(name, storagePath);
    return new DatabaseService(result.db, result.name, result.path);
  }

  static list(storagePath?: string): DatabaseInfo[] {
    return listDatabases(storagePath);
  }

  static delete(name: string, storagePath?: string): void {
    deleteDatabase(name, storagePath);
  }

  static exists(name: string, storagePath?: string): boolean {
    return databaseExists(name, storagePath);
  }

  getStats(): DatabaseStats {
    return getStats(this.db, this.name, this.path);
  }

  close(): void {
    this.db.close();
  }

  getName(): string {
    return this.name;
  }

  getPath(): string {
    return this.path;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getConnection(): Database.Database {
    return this.db;
  }

  // ==================== DOCUMENT OPERATIONS ====================

  insertDocument(doc: Omit<Document, 'created_at'>): string {
    return docOps.insertDocument(this.db, doc, () => { updateMetadataCounts(this.db); });
  }

  getDocument(id: string): Document | null {
    return docOps.getDocument(this.db, id);
  }

  getDocumentByPath(filePath: string): Document | null {
    return docOps.getDocumentByPath(this.db, filePath);
  }

  getDocumentByHash(fileHash: string): Document | null {
    return docOps.getDocumentByHash(this.db, fileHash);
  }

  listDocuments(options?: ListDocumentsOptions): Document[] {
    return docOps.listDocuments(this.db, options);
  }

  updateDocumentStatus(id: string, status: DocumentStatus, errorMessage?: string): void {
    docOps.updateDocumentStatus(this.db, id, status, errorMessage, () => { updateMetadataModified(this.db); });
  }

  updateDocumentOCRComplete(id: string, pageCount: number, ocrCompletedAt: string): void {
    docOps.updateDocumentOCRComplete(this.db, id, pageCount, ocrCompletedAt, () => { updateMetadataModified(this.db); });
  }

  deleteDocument(id: string): void {
    this.transaction(() => {
      docOps.deleteDocument(this.db, id, () => { updateMetadataCounts(this.db); });
    });
  }

  cleanDocumentDerivedData(id: string): void {
    this.transaction(() => {
      docOps.cleanDocumentDerivedData(this.db, id);
    });
  }

  // ==================== OCR RESULT OPERATIONS ====================

  insertOCRResult(result: OCRResult): string {
    return ocrOps.insertOCRResult(this.db, result, () => { updateMetadataCounts(this.db); });
  }

  getOCRResult(id: string): OCRResult | null {
    return ocrOps.getOCRResult(this.db, id);
  }

  getOCRResultByDocumentId(documentId: string): OCRResult | null {
    return ocrOps.getOCRResultByDocumentId(this.db, documentId);
  }

  // ==================== CHUNK OPERATIONS ====================

  insertChunk(chunk: Omit<Chunk, 'created_at' | 'embedding_status' | 'embedded_at'>): string {
    return chunkOps.insertChunk(this.db, chunk, () => { updateMetadataCounts(this.db); });
  }

  insertChunks(chunks: Omit<Chunk, 'created_at' | 'embedding_status' | 'embedded_at'>[]): string[] {
    return chunkOps.insertChunks(this.db, chunks, () => { updateMetadataCounts(this.db); }, (fn) => this.transaction(fn));
  }

  getChunk(id: string): Chunk | null {
    return chunkOps.getChunk(this.db, id);
  }

  hasChunksByDocumentId(documentId: string): boolean {
    return chunkOps.hasChunksByDocumentId(this.db, documentId);
  }

  getChunksByDocumentId(documentId: string): Chunk[] {
    return chunkOps.getChunksByDocumentId(this.db, documentId);
  }

  getChunksByOCRResultId(ocrResultId: string): Chunk[] {
    return chunkOps.getChunksByOCRResultId(this.db, ocrResultId);
  }

  getPendingEmbeddingChunks(limit?: number): Chunk[] {
    return chunkOps.getPendingEmbeddingChunks(this.db, limit);
  }

  updateChunkEmbeddingStatus(id: string, status: 'pending' | 'complete' | 'failed', embeddedAt?: string): void {
    chunkOps.updateChunkEmbeddingStatus(this.db, id, status, embeddedAt, () => { updateMetadataModified(this.db); });
  }

  // ==================== EMBEDDING OPERATIONS ====================

  insertEmbedding(embedding: Omit<Embedding, 'created_at' | 'vector'>): string {
    return embOps.insertEmbedding(this.db, embedding, () => { updateMetadataCounts(this.db); });
  }

  insertEmbeddings(embeddings: Omit<Embedding, 'created_at' | 'vector'>[]): string[] {
    return embOps.insertEmbeddings(this.db, embeddings, () => { updateMetadataCounts(this.db); }, (fn) => this.transaction(fn));
  }

  getEmbedding(id: string): Omit<Embedding, 'vector'> | null {
    return embOps.getEmbedding(this.db, id);
  }

  getEmbeddingByChunkId(chunkId: string): Omit<Embedding, 'vector'> | null {
    return embOps.getEmbeddingByChunkId(this.db, chunkId);
  }

  getEmbeddingsByDocumentId(documentId: string): Omit<Embedding, 'vector'>[] {
    return embOps.getEmbeddingsByDocumentId(this.db, documentId);
  }

  // ==================== PROVENANCE OPERATIONS ====================

  insertProvenance(record: ProvenanceRecord): string {
    return provOps.insertProvenance(this.db, record);
  }

  getProvenance(id: string): ProvenanceRecord | null {
    return provOps.getProvenance(this.db, id);
  }

  getProvenanceChain(id: string): ProvenanceRecord[] {
    return provOps.getProvenanceChain(this.db, id);
  }

  getProvenanceByRootDocument(rootDocumentId: string): ProvenanceRecord[] {
    return provOps.getProvenanceByRootDocument(this.db, rootDocumentId);
  }

  getProvenanceChildren(parentId: string): ProvenanceRecord[] {
    return provOps.getProvenanceChildren(this.db, parentId);
  }

  // ==================== EXTRACTION OPERATIONS ====================

  insertExtraction(extraction: Extraction): string {
    return extOps.insertExtraction(this.db, extraction, () => { updateMetadataCounts(this.db); });
  }

  getExtractionsByDocument(documentId: string): Extraction[] {
    return extOps.getExtractionsByDocument(this.db, documentId);
  }

  // ==================== FORM FILL OPERATIONS ====================

  insertFormFill(formFill: FormFill): string {
    return ffOps.insertFormFill(this.db, formFill, () => { updateMetadataCounts(this.db); });
  }

  getFormFill(id: string): FormFill | null {
    return ffOps.getFormFill(this.db, id);
  }

  listFormFills(options?: { status?: string; limit?: number; offset?: number }): FormFill[] {
    return ffOps.listFormFills(this.db, options);
  }

  searchFormFills(query: string, options?: { limit?: number; offset?: number }): FormFill[] {
    return ffOps.searchFormFills(this.db, query, options);
  }

  deleteFormFill(id: string): boolean {
    return ffOps.deleteFormFill(this.db, id);
  }

  // ==================== DOCUMENT METADATA ====================

  updateDocumentMetadata(id: string, metadata: { docTitle?: string | null; docAuthor?: string | null; docSubject?: string | null }): void {
    docOps.updateDocumentMetadata(this.db, id, metadata, () => { updateMetadataModified(this.db); });
  }

  // ==================== IMAGE OPERATIONS ====================

  updateImageProvenance(id: string, provenanceId: string): void {
    updateImageProvenance(this.db, id, provenanceId);
  }
}
