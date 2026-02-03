/**
 * Integration Scenario Tests for Database Migrations
 *
 * Tests full document processing pipeline and cross-table queries.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('Database Migrations - Integration Scenarios', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-integration');
  });

  afterAll(() => {
    cleanupTestDir(ctx.testDir);
  });

  beforeEach(() => {
    const { db, dbPath } = createTestDb(ctx.testDir);
    ctx.db = db;
    ctx.dbPath = dbPath;
  });

  afterEach(() => {
    closeDb(ctx.db);
    ctx.db = undefined;
  });

  it.skipIf(!isSqliteVecAvailable())(
    'should support full document processing pipeline schema',
    () => {
      initializeDatabase(ctx.db);

      const now = new Date().toISOString();

      // 1. Create document provenance
      ctx.db!.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'prov-doc-001',
        'DOCUMENT',
        now,
        now,
        'FILE',
        'doc-001',
        'sha256:file123',
        'file-ingester',
        '1.0.0',
        '{}',
        '[]',
        0
      );

      // 2. Create document
      ctx.db!.prepare(`
        INSERT INTO documents (
          id, file_path, file_name, file_hash, file_size, file_type,
          status, provenance_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'doc-001',
        '/test/contract.pdf',
        'contract.pdf',
        'sha256:file123',
        10240,
        'pdf',
        'pending',
        'prov-doc-001',
        now
      );

      // 3. Create OCR provenance
      ctx.db!.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth, parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'prov-ocr-001',
        'OCR_RESULT',
        now,
        now,
        'OCR',
        'doc-001',
        'sha256:ocr123',
        'datalab-marker',
        '1.0.0',
        '{"mode":"balanced"}',
        '["prov-doc-001"]',
        1,
        'prov-doc-001'
      );

      // 4. Create OCR result
      ctx.db!.prepare(`
        INSERT INTO ocr_results (
          id, provenance_id, document_id, extracted_text, text_length,
          datalab_request_id, datalab_mode, page_count, content_hash,
          processing_started_at, processing_completed_at, processing_duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'ocr-001',
        'prov-ocr-001',
        'doc-001',
        'This is the extracted text from the contract.',
        44,
        'req-12345',
        'balanced',
        3,
        'sha256:ocr123',
        now,
        now,
        2500
      );

      // 5. Create chunk provenance
      ctx.db!.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth, parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'prov-chunk-001',
        'CHUNK',
        now,
        now,
        'CHUNKING',
        'doc-001',
        'sha256:chunk123',
        'text-chunker',
        '1.0.0',
        '{"chunk_size":2000,"overlap":0.1}',
        '["prov-doc-001","prov-ocr-001"]',
        2,
        'prov-ocr-001'
      );

      // 6. Create chunk
      ctx.db!.prepare(`
        INSERT INTO chunks (
          id, document_id, ocr_result_id, text, text_hash, chunk_index,
          character_start, character_end, overlap_previous, overlap_next,
          provenance_id, created_at, embedding_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'chunk-001',
        'doc-001',
        'ocr-001',
        'This is the extracted text from the contract.',
        'sha256:chunk123',
        0,
        0,
        44,
        0,
        0,
        'prov-chunk-001',
        now,
        'pending'
      );

      // 7. Create embedding provenance
      ctx.db!.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth, parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'prov-emb-001',
        'EMBEDDING',
        now,
        now,
        'EMBEDDING',
        'doc-001',
        'sha256:emb123',
        'nomic-embed-text-v1.5',
        '1.5.0',
        '{"task_type":"search_document"}',
        '["prov-doc-001","prov-ocr-001","prov-chunk-001"]',
        3,
        'prov-chunk-001'
      );

      // 8. Create embedding
      ctx.db!.prepare(`
        INSERT INTO embeddings (
          id, chunk_id, document_id, original_text, original_text_length,
          source_file_path, source_file_name, source_file_hash,
          character_start, character_end, chunk_index, total_chunks,
          model_name, model_version, task_type, inference_mode,
          provenance_id, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'emb-001',
        'chunk-001',
        'doc-001',
        'This is the extracted text from the contract.',
        44,
        '/test/contract.pdf',
        'contract.pdf',
        'sha256:file123',
        0,
        44,
        0,
        1,
        'nomic-embed-text-v1.5',
        '1.5.0',
        'search_document',
        'local',
        'prov-emb-001',
        'sha256:emb123',
        now
      );

      // 9. Insert vector
      const vector = new Float32Array(768).fill(0.1);
      ctx.db!.prepare(`
        INSERT INTO vec_embeddings (embedding_id, vector)
        VALUES (?, ?)
      `).run('emb-001', Buffer.from(vector.buffer));

      // Verify the full chain exists
      const docCount = (ctx.db!.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number }).cnt;
      const ocrCount = (ctx.db!.prepare('SELECT COUNT(*) as cnt FROM ocr_results').get() as { cnt: number }).cnt;
      const chunkCount = (ctx.db!.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt;
      const embCount = (ctx.db!.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number }).cnt;
      const provCount = (ctx.db!.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number }).cnt;
      const vecCount = (ctx.db!.prepare('SELECT COUNT(*) as cnt FROM vec_embeddings').get() as { cnt: number }).cnt;

      expect(docCount).toBe(1);
      expect(ocrCount).toBe(1);
      expect(chunkCount).toBe(1);
      expect(embCount).toBe(1);
      expect(provCount).toBe(4); // doc + ocr + chunk + embedding
      expect(vecCount).toBe(1);

      // Verify provenance chain depth
      const maxDepth = ctx.db!.prepare('SELECT MAX(chain_depth) as max_depth FROM provenance').get() as { max_depth: number };
      expect(maxDepth.max_depth).toBe(3);
    }
  );

  it.skipIf(!isSqliteVecAvailable())(
    'should support querying across related tables',
    () => {
      initializeDatabase(ctx.db);

      const now = new Date().toISOString();

      // Insert minimal test data
      ctx.db!.prepare(`
        INSERT INTO provenance (
          id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('prov-1', 'DOCUMENT', now, now, 'FILE', 'doc-1', 'sha256:a', 'p', '1', '{}', '[]', 0);

      ctx.db!.prepare(`
        INSERT INTO documents (
          id, file_path, file_name, file_hash, file_size, file_type,
          status, provenance_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('doc-1', '/path/file.pdf', 'file.pdf', 'sha256:a', 1024, 'pdf', 'complete', 'prov-1', now);

      // Test join query
      const result = ctx.db!.prepare(`
        SELECT d.id as doc_id, d.file_name, p.chain_depth
        FROM documents d
        JOIN provenance p ON d.provenance_id = p.id
        WHERE d.status = ?
      `).get('complete') as { doc_id: string; file_name: string; chain_depth: number };

      expect(result).toBeDefined();
      expect(result.doc_id).toBe('doc-1');
      expect(result.file_name).toBe('file.pdf');
      expect(result.chain_depth).toBe(0);
    }
  );
});
