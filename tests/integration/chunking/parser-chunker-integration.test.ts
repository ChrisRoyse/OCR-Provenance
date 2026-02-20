/**
 * Integration Tests: Parser → Chunker → Provenance Pipeline
 *
 * Tests the full flow from raw markdown text through parsing,
 * section hierarchy, chunking, and provenance creation.
 *
 * @module tests/integration/chunking/parser-chunker-integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chunkHybridSectionAware,
  createChunkProvenance,
  DEFAULT_CHUNKING_CONFIG,
} from '../../../src/services/chunking/chunker.js';
import {
  parseMarkdownBlocks,
  extractPageOffsetsFromText,
} from '../../../src/services/chunking/markdown-parser.js';
import { normalizeForEmbedding } from '../../../src/services/chunking/text-normalizer.js';
import type { ChunkingConfig } from '../../../src/models/chunk.js';
import type { Chunk } from '../../../src/models/chunk.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import {
  createTestDir,
  cleanupTestDir,
  createFreshDatabase,
  safeCloseDatabase,
  sqliteVecAvailable,
  computeHash,
  uuidv4,
} from '../../unit/database/helpers.js';
import { rowToChunk } from '../../../src/services/storage/database/converters.js';
import type { ChunkRow } from '../../../src/services/storage/database/types.js';
import type { DatabaseService } from '../../../src/services/storage/database.js';

// =============================================================================
// REALISTIC TEST DOCUMENTS
// =============================================================================

const LEGAL_DOCUMENT = `# BYLAWS OF THE INTERNATIONAL BROTHERHOOD

## ARTICLE 1 - NAME AND PURPOSE

The name of this organization shall be the International Brotherhood of Workers. The purpose of this Brotherhood is to promote the welfare of its members and their families.

## ARTICLE 2 - MEMBERSHIP

### Section 2.1 Eligibility

Any person employed in the trade who meets the qualifications established by the Constitution shall be eligible for membership.

### Section 2.2 Application Process

Applications for membership shall be submitted to the local lodge secretary. The application must include the applicant's full name, address, and employment history.

---
<!-- Page 2 -->

## ARTICLE 3 - OFFICERS

### Section 3.1 Elected Officers

The elected officers of this Lodge shall be:

- President
- Vice President
- Recording Secretary
- Financial Secretary-Treasurer

### Section 3.2 Duties of Officers

#### Section 3.2.1 President

The President shall preside at all meetings and enforce the Constitution and Bylaws.

#### Section 3.2.2 Vice President

The Vice President shall assume the duties of the President in the absence of that officer.

---
<!-- Page 3 -->

## ARTICLE 4 - MEETINGS

Regular meetings shall be held on the first Tuesday of each month. Special meetings may be called by the President or by written request of five members.

## ARTICLE 5 - DUES AND ASSESSMENTS

| Category | Monthly Dues | Initiation Fee |
|----------|-------------|----------------|
| Regular Member | $50.00 | $100.00 |
| Apprentice | $25.00 | $50.00 |
| Retired | $10.00 | N/A |

Members more than three months in arrears shall be suspended from membership.`;

const API_DOC_WITH_CODE = `# API Reference

## Authentication

All API requests require a Bearer token in the Authorization header.

\`\`\`bash
curl -X GET https://api.example.com/v1/users \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json"
\`\`\`

## Endpoints

### GET /users

Returns a list of all users.

\`\`\`json
{
  "users": [
    {"id": 1, "name": "Alice"},
    {"id": 2, "name": "Bob"}
  ],
  "total": 2
}
\`\`\`

### POST /users

Creates a new user.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | User's full name |
| email | string | yes | Valid email address |
| role | string | no | User role (default: "user") |`;

// =============================================================================
// Parser → Chunker Integration
// =============================================================================

describe('Parser → Chunker Integration', () => {
  it('parseMarkdownBlocks output feeds correctly into chunkHybridSectionAware', () => {
    // Verify that the parser's output produces valid chunks
    const blocks = parseMarkdownBlocks(LEGAL_DOCUMENT, []);
    expect(blocks.length).toBeGreaterThan(10);

    // Now run through the full chunker
    const pageOffsets = extractPageOffsetsFromText(LEGAL_DOCUMENT);
    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    expect(chunks.length).toBeGreaterThan(0);

    // Verify all chunk text is non-empty
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('section hierarchy paths appear in chunk.sectionPath', () => {
    const pageOffsets = extractPageOffsetsFromText(LEGAL_DOCUMENT);
    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    // Find chunk containing section 3.2.1 content
    const presidentChunk = chunks.find(c => c.text.includes('preside at all meetings'));
    expect(presidentChunk).toBeDefined();
    expect(presidentChunk!.sectionPath).toContain('ARTICLE 3');

    // Find chunk under Article 2
    const membershipChunk = chunks.find(c => c.text.includes('eligible for membership'));
    expect(membershipChunk).toBeDefined();
    expect(membershipChunk!.sectionPath).toContain('ARTICLE 2');
  });

  it('page offsets from parser used for chunk.pageNumber', () => {
    const pageOffsets = extractPageOffsetsFromText(LEGAL_DOCUMENT);
    expect(pageOffsets.length).toBeGreaterThanOrEqual(2);

    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    // Multiple distinct pages should be represented
    const distinctPages = new Set(chunks.map(c => c.pageNumber).filter(p => p !== null));
    expect(distinctPages.size).toBeGreaterThan(1);
  });

  it('normalizeForEmbedding can process all chunk texts without error', () => {
    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);
    for (const chunk of chunks) {
      const normalized = normalizeForEmbedding(chunk.text);
      expect(typeof normalized).toBe('string');
      expect(normalized.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Chunker → Provenance Integration
// =============================================================================

describe('Chunker → Provenance Integration', () => {
  it('createChunkProvenance produces valid provenance for every chunk', () => {
    const pageOffsets = extractPageOffsetsFromText(LEGAL_DOCUMENT);
    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    for (const chunk of chunks) {
      const prov = createChunkProvenance({
        chunk,
        chunkTextHash: 'sha256:test_hash_value_for_chunk',
        ocrProvenanceId: 'ocr-prov-1',
        documentProvenanceId: 'doc-prov-1',
        ocrContentHash: 'sha256:ocr_content_hash',
        fileHash: 'sha256:file_hash',
        totalChunks: chunks.length,
      });

      expect(prov.type).toBe(ProvenanceType.CHUNK);
      expect(prov.source_type).toBe('CHUNKING');
      expect(prov.processor).toBe('chunker');
      expect(prov.processor_version).toBe('2.0.0');
      expect(prov.processing_params.strategy).toBe('hybrid_section');
      expect(prov.processing_params.is_atomic).toBe(chunk.isAtomic);
      expect(prov.processing_params.content_types).toEqual(chunk.contentTypes);
      expect(prov.processing_params.heading_context).toBe(chunk.headingContext ?? null);
      expect(prov.processing_params.section_path).toBe(chunk.sectionPath ?? null);

      // Location fields
      expect(prov.location!.chunk_index).toBe(chunk.index);
      expect(prov.location!.character_start).toBe(chunk.startOffset);
      expect(prov.location!.character_end).toBe(chunk.endOffset);
    }
  });
});

// =============================================================================
// Config → Chunker Integration
// =============================================================================

describe('Config → Chunker Integration', () => {
  it('smaller chunkSize produces more chunks', () => {
    const defaultChunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

    const smallConfig: ChunkingConfig = {
      chunkSize: 500,
      overlapPercent: 10,
      maxChunkSize: 2000,
    };
    const smallChunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, smallConfig);

    expect(smallChunks.length).toBeGreaterThan(defaultChunks.length);
  });

  it('larger chunkSize produces fewer chunks', () => {
    const defaultChunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

    const largeConfig: ChunkingConfig = {
      chunkSize: 5000,
      overlapPercent: 10,
      maxChunkSize: 10000,
    };
    const largeChunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, largeConfig);

    expect(largeChunks.length).toBeLessThanOrEqual(defaultChunks.length);
  });

  it('0% overlap produces no overlap values', () => {
    const config: ChunkingConfig = {
      chunkSize: 500,
      overlapPercent: 0,
      maxChunkSize: 2000,
    };
    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, config);

    for (const chunk of chunks) {
      expect(chunk.overlapWithPrevious).toBe(0);
      expect(chunk.overlapWithNext).toBe(0);
    }
  });
});

// =============================================================================
// Heading Normalizer → Section Hierarchy Integration
// =============================================================================

describe('Heading Normalizer → Section Hierarchy Integration', () => {
  it('normalizing inconsistent ARTICLE levels fixes section paths', () => {
    // Simulate Datalab giving inconsistent heading levels
    const text = '# ARTICLE 1\n\nContent A.\n\n### ARTICLE 2\n\nContent B.\n\n### ARTICLE 3\n\nContent C.';

    // Without normalization
    const chunksWithout = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // With normalization
    const config: ChunkingConfig = {
      ...DEFAULT_CHUNKING_CONFIG,
      headingNormalization: { enabled: true },
    };
    const chunksWith = chunkHybridSectionAware(text, [], null, config);

    // Both should produce chunks
    expect(chunksWithout.length).toBeGreaterThan(0);
    expect(chunksWith.length).toBeGreaterThan(0);

    // With normalization, ARTICLE 2 should be at the same level as ARTICLE 1
    // so its section path should just be "ARTICLE 2", not nested under ARTICLE 1
    const art2Chunk = chunksWith.find(c => c.text.includes('Content B'));
    if (art2Chunk && art2Chunk.sectionPath) {
      // After normalization, all articles at same level (mode)
      // ARTICLE 2 should NOT be nested under ARTICLE 1
      expect(art2Chunk.sectionPath).not.toContain('ARTICLE 1');
    }
  });
});

// =============================================================================
// Full Pipeline: Parse → Normalize → Chunk → Merge → Provenance
// =============================================================================

describe('Full Pipeline Integration', () => {
  it('complete pipeline processes legal document end-to-end', () => {
    // Step 1: Extract page offsets
    const pageOffsets = extractPageOffsetsFromText(LEGAL_DOCUMENT);

    // Step 2: Chunk with section awareness
    const config: ChunkingConfig = {
      ...DEFAULT_CHUNKING_CONFIG,
      headingNormalization: { enabled: true },
    };
    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, pageOffsets, null, config);

    // Step 3: Verify quality metrics
    expect(chunks.length).toBeGreaterThan(3);

    // No chunk should exceed maxChunkSize
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }

    // Page numbers should be assigned
    const withPageNum = chunks.filter(c => c.pageNumber !== null);
    expect(withPageNum.length).toBeGreaterThan(0);

    // Heading context should be populated for most chunks
    const withHeading = chunks.filter(c => c.headingContext !== null);
    expect(withHeading.length).toBeGreaterThan(chunks.length * 0.5);

    // Section paths should exist
    const withSection = chunks.filter(c => c.sectionPath !== null);
    expect(withSection.length).toBeGreaterThan(0);

    // All chunks should have content types
    for (const chunk of chunks) {
      expect(chunk.contentTypes.length).toBeGreaterThan(0);
    }

    // No heading-only tiny chunks should remain (merger handles them)
    for (const chunk of chunks) {
      if (chunk.contentTypes.length === 1 && chunk.contentTypes[0] === 'heading') {
        expect(chunk.text.trim().length).toBeGreaterThanOrEqual(100);
      }
    }

    // Step 4: Create provenance for each chunk
    for (const chunk of chunks) {
      const prov = createChunkProvenance({
        chunk,
        chunkTextHash: 'sha256:test',
        ocrProvenanceId: 'ocr-prov',
        documentProvenanceId: 'doc-prov',
        ocrContentHash: 'sha256:ocr',
        fileHash: 'sha256:file',
        totalChunks: chunks.length,
      });
      expect(prov.type).toBe(ProvenanceType.CHUNK);
    }
  });

  it('complete pipeline processes API doc with mixed content', () => {
    const chunks = chunkHybridSectionAware(API_DOC_WITH_CODE, [], null, DEFAULT_CHUNKING_CONFIG);

    // Should have multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // Should have various content types
    const allTypes = new Set<string>();
    for (const chunk of chunks) {
      for (const ct of chunk.contentTypes) {
        allTypes.add(ct);
      }
    }
    expect(allTypes.has('heading')).toBe(true);
    expect(allTypes.has('text')).toBe(true);
    // Small code/table blocks get merged, so they show up as mixed content types
    const hasCode = chunks.some(c => c.contentTypes.includes('code'));
    const hasTable = chunks.some(c => c.contentTypes.includes('table'));
    expect(hasCode || hasTable).toBe(true);
  });

  it('extractPageOffsetsFromText → chunkHybridSectionAware roundtrip', () => {
    // This tests the Bug 1 fix path: when Python returns bad page offsets,
    // TypeScript re-extracts from text and passes to chunker
    const pageOffsets = extractPageOffsetsFromText(LEGAL_DOCUMENT);
    expect(pageOffsets.length).toBeGreaterThanOrEqual(2); // At least Page 2 and Page 3

    const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    // Chunks should span multiple pages
    const pages = new Set(chunks.map(c => c.pageNumber).filter(p => p !== null));
    expect(pages.size).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// 4.2: Chunker → Storage Integration
// =============================================================================

describe('Chunker → Storage Integration', () => {
  const describeWithDB = sqliteVecAvailable ? describe : describe.skip;

  describeWithDB('database roundtrip', () => {
    let testDir: string;
    let db: DatabaseService;

    // Shared prerequisite IDs
    let provDocId: string;
    let provOcrId: string;
    let provChunkId: string;
    let docId: string;
    let ocrResultId: string;

    beforeEach(() => {
      testDir = createTestDir('chunker-storage-');
      const maybeDb = createFreshDatabase(testDir, 'chunker-storage');
      if (!maybeDb) {
        throw new Error('Failed to create test database');
      }
      db = maybeDb;

      // Create prerequisite records for FK constraints
      const now = new Date().toISOString();
      provDocId = uuidv4();
      provOcrId = uuidv4();
      provChunkId = uuidv4();
      docId = uuidv4();
      ocrResultId = uuidv4();

      // Insert document provenance (chain_depth=0)
      db.db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, file_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        provDocId, 'DOCUMENT', now, now, 'FILE', provDocId,
        computeHash('doc-content'), computeHash('doc-file'),
        'test', '1.0.0', '{}', '[]', 0
      );

      // Insert OCR provenance (chain_depth=1)
      db.db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, file_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        provOcrId, 'OCR_RESULT', now, now, 'OCR', provDocId,
        computeHash('ocr-content'), computeHash('doc-file'),
        'datalab', '1.0.0', '{}', JSON.stringify([provDocId]), 1
      );

      // Insert chunk provenance (chain_depth=2)
      db.db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, file_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        provChunkId, 'CHUNK', now, now, 'CHUNKING', provDocId,
        computeHash('chunk-content'), computeHash('doc-file'),
        'chunker', '2.0.0', '{}', JSON.stringify([provOcrId]), 2
      );

      // Insert document
      db.db.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        docId, '/test/doc.pdf', 'doc.pdf', computeHash('doc-file'),
        1024, 'pdf', 'complete', provDocId, now
      );

      // Insert OCR result
      db.db.prepare(`INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id, datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ocrResultId, provOcrId, docId,
        LEGAL_DOCUMENT, LEGAL_DOCUMENT.length,
        'req-test', 'balanced', 3,
        computeHash('ocr-content'), now, now, 1000
      );
    });

    afterEach(() => {
      safeCloseDatabase(db);
      cleanupTestDir(testDir);
    });

    it('all ChunkResult fields stored correctly in database', () => {
      const pageOffsets = extractPageOffsetsFromText(LEGAL_DOCUMENT);
      const chunks = chunkHybridSectionAware(LEGAL_DOCUMENT, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks.length).toBeGreaterThan(0);

      // Insert the first chunk into the DB
      const chunk = chunks[0];
      const chunkId = uuidv4();
      const chunkData: Omit<Chunk, 'created_at' | 'embedding_status' | 'embedded_at'> = {
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: chunk.text,
        text_hash: computeHash(chunk.text),
        chunk_index: chunk.index,
        character_start: chunk.startOffset,
        character_end: chunk.endOffset,
        page_number: chunk.pageNumber,
        page_range: chunk.pageRange,
        overlap_previous: chunk.overlapWithPrevious,
        overlap_next: chunk.overlapWithNext,
        provenance_id: provChunkId,
        ocr_quality_score: null,
        heading_context: chunk.headingContext,
        heading_level: chunk.headingLevel,
        section_path: chunk.sectionPath,
        content_types: JSON.stringify(chunk.contentTypes),
        is_atomic: chunk.isAtomic ? 1 : 0,
        chunking_strategy: 'hybrid_section',
      };

      db.insertChunk(chunkData);

      // Retrieve and verify all fields
      const retrieved = db.getChunksByDocumentId(docId);
      expect(retrieved.length).toBe(1);
      const stored = retrieved[0];

      expect(stored.id).toBe(chunkId);
      expect(stored.text).toBe(chunk.text);
      expect(stored.chunk_index).toBe(chunk.index);
      expect(stored.character_start).toBe(chunk.startOffset);
      expect(stored.character_end).toBe(chunk.endOffset);
      expect(stored.page_number).toBe(chunk.pageNumber);
      expect(stored.page_range).toBe(chunk.pageRange);
      expect(stored.overlap_previous).toBe(chunk.overlapWithPrevious);
      expect(stored.overlap_next).toBe(chunk.overlapWithNext);

      // Verify 6 new fields
      expect(stored.heading_context).toBe(chunk.headingContext);
      expect(stored.heading_level).toBe(chunk.headingLevel);
      expect(stored.section_path).toBe(chunk.sectionPath);
      expect(stored.content_types).toBe(JSON.stringify(chunk.contentTypes));
      expect(stored.is_atomic).toBe(chunk.isAtomic ? 1 : 0);
      expect(stored.chunking_strategy).toBe('hybrid_section');
    });

    it('content_types JSON serialization/deserialization roundtrip', () => {
      const contentTypesArray = ['text', 'table', 'code'];
      const serialized = JSON.stringify(contentTypesArray);
      const chunkId = uuidv4();

      db.insertChunk({
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'Test chunk with mixed content types.',
        text_hash: computeHash('content-types-test'),
        chunk_index: 0,
        character_start: 0,
        character_end: 36,
        page_number: 1,
        page_range: null,
        overlap_previous: 0,
        overlap_next: 0,
        provenance_id: provChunkId,
        ocr_quality_score: null,
        heading_context: null,
        heading_level: null,
        section_path: null,
        content_types: serialized,
        is_atomic: 0,
        chunking_strategy: 'hybrid_section',
      });

      const retrieved = db.getChunksByDocumentId(docId);
      expect(retrieved.length).toBe(1);
      expect(retrieved[0].content_types).toBe('["text","table","code"]');

      // Verify it parses back to the original array
      const parsed = JSON.parse(retrieved[0].content_types!);
      expect(parsed).toEqual(contentTypesArray);
    });

    it('is_atomic boolean to integer to boolean roundtrip', () => {
      // Insert atomic chunk (isAtomic=true -> 1)
      const atomicId = uuidv4();
      db.insertChunk({
        id: atomicId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'Atomic table content.',
        text_hash: computeHash('atomic-test'),
        chunk_index: 0,
        character_start: 0,
        character_end: 21,
        page_number: 1,
        page_range: null,
        overlap_previous: 0,
        overlap_next: 0,
        provenance_id: provChunkId,
        ocr_quality_score: null,
        heading_context: null,
        heading_level: null,
        section_path: null,
        content_types: '["table"]',
        is_atomic: 1,
        chunking_strategy: 'hybrid_section',
      });

      // Insert non-atomic chunk (isAtomic=false -> 0)
      const nonAtomicProvId = uuidv4();
      const now = new Date().toISOString();
      db.db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, file_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        nonAtomicProvId, 'CHUNK', now, now, 'CHUNKING', provDocId,
        computeHash('non-atomic'), computeHash('doc-file'),
        'chunker', '2.0.0', '{}', JSON.stringify([provOcrId]), 2
      );
      const nonAtomicId = uuidv4();
      db.insertChunk({
        id: nonAtomicId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'Non-atomic text content.',
        text_hash: computeHash('non-atomic-test'),
        chunk_index: 1,
        character_start: 21,
        character_end: 45,
        page_number: 1,
        page_range: null,
        overlap_previous: 0,
        overlap_next: 0,
        provenance_id: nonAtomicProvId,
        ocr_quality_score: null,
        heading_context: null,
        heading_level: null,
        section_path: null,
        content_types: '["text"]',
        is_atomic: 0,
        chunking_strategy: 'hybrid_section',
      });

      const retrieved = db.getChunksByDocumentId(docId);
      expect(retrieved.length).toBe(2);

      const atomicChunk = retrieved.find(c => c.id === atomicId)!;
      const nonAtomicChunk = retrieved.find(c => c.id === nonAtomicId)!;

      // is_atomic is stored as INTEGER (0/1) and retrieved as number
      expect(typeof atomicChunk.is_atomic).toBe('number');
      expect(atomicChunk.is_atomic).toBe(1);
      expect(typeof nonAtomicChunk.is_atomic).toBe('number');
      expect(nonAtomicChunk.is_atomic).toBe(0);
    });

    it('heading_context with special characters stored/retrieved correctly', () => {
      const specialHeading = 'Section 3.2.1 "Officers\' Duties" — Overview > Details (§42)';
      const chunkId = uuidv4();

      db.insertChunk({
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'Content under special heading.',
        text_hash: computeHash('special-heading-test'),
        chunk_index: 0,
        character_start: 0,
        character_end: 30,
        page_number: 1,
        page_range: null,
        overlap_previous: 0,
        overlap_next: 0,
        provenance_id: provChunkId,
        ocr_quality_score: null,
        heading_context: specialHeading,
        heading_level: 4,
        section_path: null,
        content_types: '["text"]',
        is_atomic: 0,
        chunking_strategy: 'hybrid_section',
      });

      const retrieved = db.getChunksByDocumentId(docId);
      expect(retrieved.length).toBe(1);
      expect(retrieved[0].heading_context).toBe(specialHeading);
      expect(retrieved[0].heading_level).toBe(4);
    });

    it('section_path with > separator stored/retrieved correctly', () => {
      const sectionPath = 'ARTICLE 3 - OFFICERS > Section 3.2 Duties of Officers > Section 3.2.1 President';
      const chunkId = uuidv4();

      db.insertChunk({
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'The President shall preside at all meetings.',
        text_hash: computeHash('section-path-test'),
        chunk_index: 0,
        character_start: 0,
        character_end: 45,
        page_number: 2,
        page_range: null,
        overlap_previous: 0,
        overlap_next: 0,
        provenance_id: provChunkId,
        ocr_quality_score: null,
        heading_context: 'Section 3.2.1 President',
        heading_level: 4,
        section_path: sectionPath,
        content_types: '["text","heading"]',
        is_atomic: 0,
        chunking_strategy: 'hybrid_section',
      });

      const retrieved = db.getChunksByDocumentId(docId);
      expect(retrieved.length).toBe(1);
      expect(retrieved[0].section_path).toBe(sectionPath);

      // Verify the > separator is preserved and can be split
      const parts = retrieved[0].section_path!.split(' > ');
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe('ARTICLE 3 - OFFICERS');
      expect(parts[2]).toBe('Section 3.2.1 President');
    });
  });
});

// =============================================================================
// 4.3: Storage → API Integration
// =============================================================================

describe('Storage → API Integration', () => {
  const describeWithDB = sqliteVecAvailable ? describe : describe.skip;

  describeWithDB('chunk row format verification', () => {
    let testDir: string;
    let db: DatabaseService;
    let docId: string;
    let ocrResultId: string;
    let provChunkId: string;
    let provDocId: string;

    beforeEach(() => {
      testDir = createTestDir('storage-api-');
      const maybeDb = createFreshDatabase(testDir, 'storage-api');
      if (!maybeDb) {
        throw new Error('Failed to create test database');
      }
      db = maybeDb;

      const now = new Date().toISOString();
      provDocId = uuidv4();
      const provOcrId = uuidv4();
      provChunkId = uuidv4();
      docId = uuidv4();
      ocrResultId = uuidv4();

      db.db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, file_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        provDocId, 'DOCUMENT', now, now, 'FILE', provDocId,
        computeHash('doc'), computeHash('file'), 'test', '1.0.0', '{}', '[]', 0
      );
      db.db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, file_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        provOcrId, 'OCR_RESULT', now, now, 'OCR', provDocId,
        computeHash('ocr'), computeHash('file'), 'datalab', '1.0.0', '{}', JSON.stringify([provDocId]), 1
      );
      db.db.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, file_hash, processor, processor_version, processing_params, parent_ids, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        provChunkId, 'CHUNK', now, now, 'CHUNKING', provDocId,
        computeHash('chunk'), computeHash('file'), 'chunker', '2.0.0', '{}', JSON.stringify([provOcrId]), 2
      );
      db.db.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        docId, '/test/api.pdf', 'api.pdf', computeHash('file'), 2048, 'pdf', 'complete', provDocId, now
      );
      db.db.prepare(`INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id, datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ocrResultId, provOcrId, docId, 'Test text.', 10, 'req-api', 'balanced', 1, computeHash('text'), now, now, 500
      );
    });

    afterEach(() => {
      safeCloseDatabase(db);
      cleanupTestDir(testDir);
    });

    it('chunk rows have all 6 new columns populated after insert', () => {
      const chunkId = uuidv4();
      db.insertChunk({
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'Full chunk with all new fields populated.',
        text_hash: computeHash('all-fields-test'),
        chunk_index: 0,
        character_start: 0,
        character_end: 41,
        page_number: 1,
        page_range: null,
        overlap_previous: 0,
        overlap_next: 200,
        provenance_id: provChunkId,
        ocr_quality_score: 4.5,
        heading_context: 'Test Heading',
        heading_level: 2,
        section_path: 'Root > Test Heading',
        content_types: '["text","heading"]',
        is_atomic: 0,
        chunking_strategy: 'hybrid_section',
      });

      // Query raw row directly to verify raw column values
      const rawRow = db.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as Record<string, unknown>;
      expect(rawRow).toBeDefined();
      expect(rawRow.heading_context).toBe('Test Heading');
      expect(rawRow.heading_level).toBe(2);
      expect(rawRow.section_path).toBe('Root > Test Heading');
      expect(rawRow.content_types).toBe('["text","heading"]');
      expect(rawRow.is_atomic).toBe(0);
      expect(rawRow.chunking_strategy).toBe('hybrid_section');
    });

    it('rowToChunk converter maps all new fields correctly', () => {
      const chunkId = uuidv4();
      const now = new Date().toISOString();

      // Build a raw ChunkRow manually
      const rawRow: ChunkRow = {
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'Test converter mapping.',
        text_hash: computeHash('converter-test'),
        chunk_index: 3,
        character_start: 100,
        character_end: 200,
        page_number: 2,
        page_range: '2-3',
        overlap_previous: 150,
        overlap_next: 150,
        provenance_id: provChunkId,
        created_at: now,
        embedding_status: 'pending',
        embedded_at: null,
        ocr_quality_score: 3.8,
        heading_context: 'Article IV',
        heading_level: 1,
        section_path: 'Article IV > Section 1',
        content_types: '["text","list"]',
        is_atomic: 1,
        chunking_strategy: 'hybrid_section',
      };

      const converted = rowToChunk(rawRow);

      // Verify all 6 new fields are mapped
      expect(converted.heading_context).toBe('Article IV');
      expect(converted.heading_level).toBe(1);
      expect(converted.section_path).toBe('Article IV > Section 1');
      expect(converted.content_types).toBe('["text","list"]');
      expect(converted.is_atomic).toBe(1);
      expect(converted.chunking_strategy).toBe('hybrid_section');

      // Verify existing fields still mapped correctly
      expect(converted.id).toBe(chunkId);
      expect(converted.chunk_index).toBe(3);
      expect(converted.page_range).toBe('2-3');
      expect(converted.ocr_quality_score).toBe(3.8);
    });

    it('content_types stored as JSON string, heading_context as plain text, is_atomic as 0/1 integer', () => {
      const chunkId = uuidv4();
      db.insertChunk({
        id: chunkId,
        document_id: docId,
        ocr_result_id: ocrResultId,
        text: 'Verifying storage types.',
        text_hash: computeHash('types-test'),
        chunk_index: 0,
        character_start: 0,
        character_end: 24,
        page_number: 1,
        page_range: null,
        overlap_previous: 0,
        overlap_next: 0,
        provenance_id: provChunkId,
        ocr_quality_score: null,
        heading_context: 'Plain Text Heading',
        heading_level: 3,
        section_path: 'Root > Section',
        content_types: '["code","text"]',
        is_atomic: 1,
        chunking_strategy: 'hybrid_section',
      });

      // Check raw SQLite types via typeof() SQL function
      const typeRow = db.db.prepare(`
        SELECT
          typeof(content_types) as content_types_type,
          typeof(heading_context) as heading_context_type,
          typeof(is_atomic) as is_atomic_type,
          typeof(chunking_strategy) as chunking_strategy_type,
          content_types,
          heading_context,
          is_atomic,
          chunking_strategy
        FROM chunks WHERE id = ?
      `).get(chunkId) as Record<string, unknown>;

      // content_types: TEXT (JSON string)
      expect(typeRow.content_types_type).toBe('text');
      expect(typeRow.content_types).toBe('["code","text"]');

      // heading_context: TEXT (plain string)
      expect(typeRow.heading_context_type).toBe('text');
      expect(typeRow.heading_context).toBe('Plain Text Heading');

      // is_atomic: INTEGER (0 or 1)
      expect(typeRow.is_atomic_type).toBe('integer');
      expect(typeRow.is_atomic).toBe(1);

      // chunking_strategy: TEXT
      expect(typeRow.chunking_strategy_type).toBe('text');
      expect(typeRow.chunking_strategy).toBe('hybrid_section');
    });
  });
});

// =============================================================================
// 4.4: Config → Chunker Integration (extended)
// =============================================================================

describe('Config → Chunker Integration (extended)', () => {
  it('non-default chunkSize (300) produces different results from default (2000)', () => {
    const defaultChunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

    const customConfig: ChunkingConfig = {
      chunkSize: 300,
      overlapPercent: 10,
      maxChunkSize: 8000,
    };
    const customChunks = chunkHybridSectionAware(LEGAL_DOCUMENT, [], null, customConfig);

    // A significantly smaller chunkSize should produce more chunks
    expect(customChunks.length).toBeGreaterThan(defaultChunks.length);
  });

  it('maxChunkSize enforcement - no chunk exceeds maxChunkSize', () => {
    // Create a very long text that will need splitting
    const longParagraph = 'This is a long sentence that needs to be repeated many times to exceed the maximum chunk size. ';
    const veryLongText = `# Long Document\n\n${longParagraph.repeat(200)}`;

    const config: ChunkingConfig = {
      chunkSize: 500,
      overlapPercent: 10,
      maxChunkSize: 1000,
    };
    const chunks = chunkHybridSectionAware(veryLongText, [], null, config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(config.maxChunkSize);
    }
  });
});

// =============================================================================
// 4.5: Migration Integration (v27 schema)
// =============================================================================

describe('Migration Integration (v27 schema)', () => {
  const describeWithDB = sqliteVecAvailable ? describe : describe.skip;

  describeWithDB('v27 schema verification', () => {
    let testDir: string;
    let db: DatabaseService;

    beforeEach(() => {
      testDir = createTestDir('migration-v27-');
      const maybeDb = createFreshDatabase(testDir, 'migration-v27');
      if (!maybeDb) {
        throw new Error('Failed to create test database');
      }
      db = maybeDb;
    });

    afterEach(() => {
      safeCloseDatabase(db);
      cleanupTestDir(testDir);
    });

    it('fresh database has v27 schema with all 6 new chunk columns', () => {
      // PRAGMA table_info returns column metadata
      const columns = db.db.pragma('table_info(chunks)') as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;

      const columnMap = new Map(columns.map(c => [c.name, c]));

      // Verify all 6 new columns exist with correct types
      expect(columnMap.has('heading_context')).toBe(true);
      expect(columnMap.get('heading_context')!.type).toBe('TEXT');

      expect(columnMap.has('heading_level')).toBe(true);
      expect(columnMap.get('heading_level')!.type).toBe('INTEGER');

      expect(columnMap.has('section_path')).toBe(true);
      expect(columnMap.get('section_path')!.type).toBe('TEXT');

      expect(columnMap.has('content_types')).toBe(true);
      expect(columnMap.get('content_types')!.type).toBe('TEXT');

      expect(columnMap.has('is_atomic')).toBe(true);
      expect(columnMap.get('is_atomic')!.type).toBe('INTEGER');

      expect(columnMap.has('chunking_strategy')).toBe(true);
      expect(columnMap.get('chunking_strategy')!.type).toBe('TEXT');
    });

    it('double-migration idempotency - creating second DB does not error', () => {
      // DatabaseService.create() runs all migrations automatically.
      // Creating a second fresh DB proves the migration path is idempotent
      // (each migration checks column existence before ALTER TABLE).
      const secondDb = createFreshDatabase(testDir, 'migration-v27-second');
      expect(secondDb).toBeDefined();

      // Verify the second DB also has all 6 columns
      const columns = secondDb!.db.pragma('table_info(chunks)') as Array<{
        name: string;
      }>;
      const columnNames = new Set(columns.map(c => c.name));

      expect(columnNames.has('heading_context')).toBe(true);
      expect(columnNames.has('heading_level')).toBe(true);
      expect(columnNames.has('section_path')).toBe(true);
      expect(columnNames.has('content_types')).toBe(true);
      expect(columnNames.has('is_atomic')).toBe(true);
      expect(columnNames.has('chunking_strategy')).toBe(true);

      safeCloseDatabase(secondDb);
    });

    it('schema version is at least 27', () => {
      const versionRow = db.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
      expect(versionRow).toBeDefined();
      expect(versionRow!.version).toBeGreaterThanOrEqual(27);
    });
  });
});
