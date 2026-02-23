/**
 * Tests for ocr_document_export and ocr_corpus_export tools (Phase 10)
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
} from '../../integration/server/helpers.js';
import { handleExport } from '../../../src/tools/documents.js';

// Wrappers that route through the unified handler (MERGE-A)
const handleDocumentExport = (params: Record<string, unknown>) =>
  handleExport(params);
const handleCorpusExport = (params: Record<string, unknown>) =>
  handleExport(params);

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_document_export TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_document_export', () => {
  let tempDir: string;
  let exportDir: string;
  const dbName = createUniqueName('test-doc-export');

  beforeAll(() => {
    tempDir = createTempDir('test-doc-export-');
    exportDir = join(tempDir, 'exports');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should export document in JSON format with chunks', async () => {
    const { db } = requireDatabase();

    // Create document with OCR + chunks
    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const docId = uuidv4();
    db.insertDocument(
      createTestDocument(provId, {
        id: docId,
        status: 'complete',
        page_count: 2,
      })
    );

    const ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: provId,
        chain_depth: 1,
      })
    );
    const ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, {
        id: ocrId,
        extracted_text: 'Hello world. This is test content.',
        text_length: 34,
      })
    );

    const chunkProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: chunkProvId,
        type: ProvenanceType.CHUNK,
        parent_id: ocrProvId,
        chain_depth: 2,
      })
    );
    db.insertChunk(
      createTestChunk(docId, ocrId, chunkProvId, {
        text: 'Hello world.',
        chunk_index: 0,
        page_number: 1,
      })
    );

    const chunkProvId2 = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: chunkProvId2,
        type: ProvenanceType.CHUNK,
        parent_id: ocrProvId,
        chain_depth: 2,
      })
    );
    db.insertChunk(
      createTestChunk(docId, ocrId, chunkProvId2, {
        text: 'This is test content.',
        chunk_index: 1,
        page_number: 2,
      })
    );

    const outputPath = join(exportDir, 'doc-export.json');
    const result = await handleDocumentExport({
      document_id: docId,
      format: 'json',
      output_path: outputPath,
      include_images: false,
      include_extractions: false,
      include_provenance: false,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.output_path).toBe(outputPath);
    expect(parsed.data.format).toBe('json');
    expect(parsed.data.document_id).toBe(docId);
    expect(parsed.data.stats.chunk_count).toBe(2);
    expect(parsed.data.stats.image_count).toBe(0);
    expect(parsed.data.stats.extraction_count).toBe(0);

    // Verify file exists and contains correct data
    expect(existsSync(outputPath)).toBe(true);
    const fileContent = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(fileContent.document.id).toBe(docId);
    expect(fileContent.document.status).toBe('complete');
    expect(fileContent.ocr_results).not.toBeNull();
    expect(fileContent.ocr_results.extracted_text).toBe('Hello world. This is test content.');
    expect(fileContent.chunks).toHaveLength(2);
    expect(fileContent.chunks[0].text).toBe('Hello world.');
    expect(fileContent.chunks[1].text).toBe('This is test content.');
    // No images or extractions
    expect(fileContent.images).toBeUndefined();
    expect(fileContent.extractions).toBeUndefined();
  });

  it('should export document in markdown format', async () => {
    const { db } = requireDatabase();

    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const docId = uuidv4();
    db.insertDocument(
      createTestDocument(provId, {
        id: docId,
        file_name: 'test-markdown.pdf',
        status: 'complete',
        page_count: 1,
      })
    );

    const ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: provId,
        chain_depth: 1,
      })
    );
    const ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, {
        id: ocrId,
        extracted_text: 'Markdown test content.',
        text_length: 22,
      })
    );

    const chunkProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: chunkProvId,
        type: ProvenanceType.CHUNK,
        parent_id: ocrProvId,
        chain_depth: 2,
      })
    );
    db.insertChunk(
      createTestChunk(docId, ocrId, chunkProvId, {
        text: 'Markdown test content.',
        chunk_index: 0,
        page_number: 1,
        heading_context: 'Introduction',
      })
    );

    const outputPath = join(exportDir, 'doc-export.md');
    const result = await handleDocumentExport({
      document_id: docId,
      format: 'markdown',
      output_path: outputPath,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.format).toBe('markdown');

    // Verify markdown file
    expect(existsSync(outputPath)).toBe(true);
    const md = readFileSync(outputPath, 'utf-8');
    expect(md).toContain('# Document Export: test-markdown.pdf');
    expect(md).toContain('## Metadata');
    expect(md).toContain('**Status:** complete');
    expect(md).toContain('## Content');
    expect(md).toContain('### Chunk 0 (Page 1) - Introduction');
    expect(md).toContain('Markdown test content.');
  });

  it('should include images=false omits images section in JSON', async () => {
    const { db } = requireDatabase();

    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const docId = uuidv4();
    db.insertDocument(createTestDocument(provId, { id: docId, status: 'complete' }));

    const ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: provId,
        chain_depth: 1,
      })
    );
    db.insertOCRResult(createTestOCRResult(docId, ocrProvId));

    const outputPath = join(exportDir, 'no-images.json');
    const result = await handleDocumentExport({
      document_id: docId,
      format: 'json',
      output_path: outputPath,
      include_images: false,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.stats.image_count).toBe(0);

    const fileContent = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(fileContent.images).toBeUndefined();
  });

  it('should include provenance when include_provenance=true', async () => {
    const { db } = requireDatabase();

    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const docId = uuidv4();
    db.insertDocument(createTestDocument(provId, { id: docId, status: 'complete' }));

    const ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: provId,
        chain_depth: 1,
      })
    );
    db.insertOCRResult(createTestOCRResult(docId, ocrProvId));

    const outputPath = join(exportDir, 'with-prov.json');
    const result = await handleDocumentExport({
      document_id: docId,
      format: 'json',
      output_path: outputPath,
      include_provenance: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const fileContent = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(fileContent.provenance).toBeDefined();
    expect(Array.isArray(fileContent.provenance)).toBe(true);
    expect(fileContent.provenance.length).toBeGreaterThan(0);
  });

  it('should fail for non-existent document', async () => {
    const outputPath = join(exportDir, 'not-found.json');
    const result = await handleDocumentExport({
      document_id: 'non-existent-id',
      format: 'json',
      output_path: outputPath,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DOCUMENT_NOT_FOUND');
  });

  it('should fail with database not selected', async () => {
    resetState();

    const result = await handleDocumentExport({
      document_id: 'some-id',
      format: 'json',
      output_path: '/tmp/test-export.json',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

    // Re-select for remaining tests
    selectDatabase(dbName, tempDir);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_corpus_export TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_corpus_export', () => {
  let tempDir: string;
  let exportDir: string;
  const dbName = createUniqueName('test-corpus-export');

  beforeAll(() => {
    tempDir = createTempDir('test-corpus-export-');
    exportDir = join(tempDir, 'exports');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  function insertDocWithChunks(
    db: ReturnType<typeof requireDatabase>['db'],
    fileName: string,
    chunkTexts: string[]
  ): string {
    const provId = uuidv4();
    db.insertProvenance(createTestProvenance({ id: provId }));
    const docId = uuidv4();
    db.insertDocument(
      createTestDocument(provId, {
        id: docId,
        file_name: fileName,
        status: 'complete',
        page_count: chunkTexts.length,
      })
    );

    const ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: provId,
        chain_depth: 1,
      })
    );
    const ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, {
        id: ocrId,
        extracted_text: chunkTexts.join(' '),
        text_length: chunkTexts.join(' ').length,
      })
    );

    chunkTexts.forEach((text, i) => {
      const chunkProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: chunkProvId,
          type: ProvenanceType.CHUNK,
          parent_id: ocrProvId,
          chain_depth: 2,
        })
      );
      db.insertChunk(
        createTestChunk(docId, ocrId, chunkProvId, {
          text,
          chunk_index: i,
          page_number: i + 1,
        })
      );
    });

    return docId;
  }

  it('should export corpus in JSON format with 3 documents', async () => {
    const { db } = requireDatabase();

    const _doc1 = insertDocWithChunks(db, 'doc1.pdf', ['Chunk A1', 'Chunk A2']);
    const _doc2 = insertDocWithChunks(db, 'doc2.pdf', ['Chunk B1']);
    const _doc3 = insertDocWithChunks(db, 'doc3.pdf', ['Chunk C1', 'Chunk C2', 'Chunk C3']);

    const outputPath = join(exportDir, 'corpus.json');
    const result = await handleCorpusExport({
      output_path: outputPath,
      format: 'json',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.output_path).toBe(outputPath);
    expect(parsed.data.format).toBe('json');
    expect(parsed.data.document_count).toBe(3);
    expect(parsed.data.total_chunks).toBe(6); // 2 + 1 + 3

    // Verify file
    expect(existsSync(outputPath)).toBe(true);
    const fileContent = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(Array.isArray(fileContent)).toBe(true);
    expect(fileContent).toHaveLength(3);

    // Each document should have chunk_count and image_count
    const docNames = fileContent.map((d: Record<string, unknown>) => d.file_name);
    expect(docNames).toContain('doc1.pdf');
    expect(docNames).toContain('doc2.pdf');
    expect(docNames).toContain('doc3.pdf');

    const doc1Entry = fileContent.find(
      (d: Record<string, unknown>) => d.file_name === 'doc1.pdf'
    );
    expect(doc1Entry.chunk_count).toBe(2);
    expect(doc1Entry.image_count).toBe(0);
  });

  it('should export corpus in CSV format with header and data rows', async () => {
    const outputPath = join(exportDir, 'corpus.csv');
    const result = await handleCorpusExport({
      output_path: outputPath,
      format: 'csv',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.format).toBe('csv');
    expect(parsed.data.document_count).toBe(3);

    // Verify CSV
    expect(existsSync(outputPath)).toBe(true);
    const csvContent = readFileSync(outputPath, 'utf-8');
    const lines = csvContent.split('\n');

    // Header + 3 data rows
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain('"id"');
    expect(lines[0]).toContain('"file_path"');
    expect(lines[0]).toContain('"file_name"');
    expect(lines[0]).toContain('"chunk_count"');
    expect(lines[0]).toContain('"image_count"');

    // Data rows should contain document names
    const dataContent = lines.slice(1).join('\n');
    expect(dataContent).toContain('doc1.pdf');
    expect(dataContent).toContain('doc2.pdf');
    expect(dataContent).toContain('doc3.pdf');
  });

  it('should handle empty corpus', async () => {
    // Create a separate empty database
    const emptyDbName = createUniqueName('test-empty-corpus');
    createDatabase(emptyDbName, undefined, tempDir);
    selectDatabase(emptyDbName, tempDir);

    const outputPath = join(exportDir, 'empty-corpus.json');
    const result = await handleCorpusExport({
      output_path: outputPath,
      format: 'json',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.document_count).toBe(0);
    expect(parsed.data.total_chunks).toBe(0);
    expect(parsed.data.total_images).toBe(0);

    const fileContent = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(fileContent).toEqual([]);

    // Re-select main database
    selectDatabase(dbName, tempDir);
  });

  it('should include chunks when include_chunks=true', async () => {
    const outputPath = join(exportDir, 'corpus-with-chunks.json');
    const result = await handleCorpusExport({
      output_path: outputPath,
      format: 'json',
      include_chunks: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const fileContent = JSON.parse(readFileSync(outputPath, 'utf-8'));
    // Each document should have a chunks array
    for (const doc of fileContent) {
      expect(doc.chunks).toBeDefined();
      expect(Array.isArray(doc.chunks)).toBe(true);
    }

    const doc1Entry = fileContent.find(
      (d: Record<string, unknown>) => d.file_name === 'doc1.pdf'
    );
    expect(doc1Entry.chunks).toHaveLength(2);
    expect(doc1Entry.chunks[0].text).toBeDefined();
  });

  it('should fail with database not selected', async () => {
    resetState();

    const result = await handleCorpusExport({
      output_path: '/tmp/test-corpus.json',
      format: 'json',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

    // Re-select for remaining tests
    selectDatabase(dbName, tempDir);
  });
});
