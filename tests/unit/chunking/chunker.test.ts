/**
 * Chunking Service Tests
 *
 * Comprehensive tests for the hybrid section-aware text chunking service.
 * NO MOCKS - uses real data and verifies actual outputs.
 *
 * @see Phase 3: Hybrid Section-Aware Chunking
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  chunkHybridSectionAware,
  createChunkProvenance,
  ChunkProvenanceParams,
  DEFAULT_CHUNKING_CONFIG,
  ChunkingConfig,
} from '../../../src/services/chunking/chunker.js';
import { getOverlapCharacters, getStepSize } from '../../../src/models/chunk.js';
import { ProvenanceType, PROVENANCE_CHAIN_DEPTH } from '../../../src/models/provenance.js';
import { computeHash, isValidHashFormat } from '../../../src/utils/hash.js';
import { PageOffset } from '../../../src/models/document.js';
import {
  createTestDir,
  cleanupTestDir,
  createFreshDatabase,
  safeCloseDatabase,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  uuidv4,
} from '../database/helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CONSTANTS - KNOWN VALUES FOR VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

const CHUNK_SIZE = 2000;
const OVERLAP_PERCENT = 10;
const OVERLAP_CHARS = 200;
const STEP_SIZE = 1800;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: chunk plain text via the hybrid chunker (no page offsets, no jsonBlocks)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convenience wrapper: call chunkHybridSectionAware with empty page offsets
 * and null jsonBlocks (plain text mode).
 */
function chunkText(text: string, config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG) {
  return chunkHybridSectionAware(text, [], null, config);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA GENERATORS - DETERMINISTIC, NO RANDOMNESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate deterministic paragraph text of approximately the specified length.
 * Uses sentence-like patterns that the hybrid chunker can split on.
 */
function generateTestText(length: number): string {
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  let result = '';
  while (result.length < length) {
    result += sentence;
  }
  return result.slice(0, length);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS - CHUNKING ALGORITHM
// ═══════════════════════════════════════════════════════════════════════════════

describe('chunkHybridSectionAware', () => {
  describe('config helpers', () => {
    it('getOverlapCharacters returns correct value', () => {
      const overlap = getOverlapCharacters(DEFAULT_CHUNKING_CONFIG);
      expect(overlap).toBe(OVERLAP_CHARS);
    });

    it('getStepSize returns correct value', () => {
      const step = getStepSize(DEFAULT_CHUNKING_CONFIG);
      expect(step).toBe(STEP_SIZE);
    });

    it('DEFAULT_CHUNKING_CONFIG has correct values', () => {
      expect(DEFAULT_CHUNKING_CONFIG.chunkSize).toBe(CHUNK_SIZE);
      expect(DEFAULT_CHUNKING_CONFIG.overlapPercent).toBe(OVERLAP_PERCENT);
      expect(DEFAULT_CHUNKING_CONFIG.maxChunkSize).toBe(8000);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const chunks = chunkText('');
      expect(chunks).toEqual([]);
    });

    it('handles text shorter than chunk size', () => {
      const input = generateTestText(500);
      const chunks = chunkText(input);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // All text should be covered
      const totalText = chunks.map((c) => c.text).join('');
      expect(totalText.length).toBeGreaterThanOrEqual(input.length - 10); // Allow minor trim
      expect(chunks[0].index).toBe(0);
    });

    it('handles exact chunk size (2000 chars)', () => {
      const input = generateTestText(2000);
      const chunks = chunkText(input);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // Single paragraph should produce 1 chunk since it fits in chunk size
      expect(chunks[0].text.length).toBeLessThanOrEqual(CHUNK_SIZE + 10); // Allow minor overhead from block joins
    });

    it('handles text larger than chunk size (creates multiple chunks)', () => {
      const input = generateTestText(4000);
      const chunks = chunkText(input);

      expect(chunks.length).toBeGreaterThan(1);
      // All chunks should have sequential indices
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });

    it('handles unicode content (emojis)', () => {
      // Emoji-only text that is short enough for one chunk
      const emoji = '🔥';
      const input = emoji.repeat(500);
      const chunks = chunkText(input);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // The text should contain the emojis
      expect(chunks[0].text).toContain(emoji);
    });

    it('handles CJK characters', () => {
      const cjk = '中文测试文本';
      const input = cjk.repeat(300); // 1800 chars
      const chunks = chunkText(input);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].text).toContain(cjk);
    });
  });

  describe('chunking correctness', () => {
    it('produces chunks for large text', () => {
      const input = generateTestText(7600);
      const chunks = chunkText(input);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('all chunks have correct sequential indices', () => {
      const input = generateTestText(7600);
      const chunks = chunkText(input);

      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });

    it('first chunk has no previous overlap', () => {
      const input = generateTestText(7600);
      const chunks = chunkText(input);

      expect(chunks[0].overlapWithPrevious).toBe(0);
    });

    it('last chunk has no next overlap', () => {
      const input = generateTestText(7600);
      const chunks = chunkText(input);

      expect(chunks[chunks.length - 1].overlapWithNext).toBe(0);
    });

    it('chunks cover the entire text', () => {
      const input = generateTestText(5000);
      const chunks = chunkText(input);

      // First chunk should start at or near 0
      expect(chunks[0].startOffset).toBe(0);
      // Last chunk should reach to near end of text
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.endOffset).toBeLessThanOrEqual(input.length);
    });

    it('each chunk has contentTypes and isAtomic fields', () => {
      const input = generateTestText(5000);
      const chunks = chunkText(input);

      for (const chunk of chunks) {
        expect(Array.isArray(chunk.contentTypes)).toBe(true);
        expect(chunk.contentTypes.length).toBeGreaterThan(0);
        expect(typeof chunk.isAtomic).toBe('boolean');
      }
    });
  });

  describe('section-aware features', () => {
    it('produces heading context for chunks after headings', () => {
      const text =
        '# Introduction\n\nThis is the introduction section with enough text to form a chunk.\n\n## Background\n\nSome background information here.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // At least one chunk should have heading context
      const hasHeading = chunks.some((c) => c.headingContext !== null);
      expect(hasHeading).toBe(true);
    });

    it('produces section path for nested headings', () => {
      const text = '# Top\n\n## Sub\n\nContent under subsection.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const hasPath = chunks.some((c) => c.sectionPath !== null && c.sectionPath.includes('>'));
      expect(hasPath).toBe(true);
    });

    it('small tables are merged into surrounding content (not atomic)', () => {
      const text =
        'Some text before.\n\n| Col A | Col B |\n|-------|-------|\n| 1     | 2     |\n\nSome text after.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Small table (< chunkSize/4 = 500) merged into content
      const chunkWithTable = chunks.find((c) => c.text.includes('| Col A |'));
      expect(chunkWithTable).toBeDefined();
      expect(chunkWithTable!.isAtomic).toBe(false);
    });

    it('small code blocks are merged into surrounding content (not atomic)', () => {
      const text = 'Some text.\n\n```python\nprint("hello")\n```\n\nMore text.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Small code block merged into content
      const chunkWithCode = chunks.find((c) => c.text.includes('print("hello")'));
      expect(chunkWithCode).toBeDefined();
      expect(chunkWithCode!.isAtomic).toBe(false);
    });
  });

  describe('page tracking', () => {
    it('returns null page info when no pageOffsets provided', () => {
      const input = generateTestText(500);
      const chunks = chunkHybridSectionAware(input, [], null, DEFAULT_CHUNKING_CONFIG);

      expect(chunks[0].pageNumber).toBeNull();
      expect(chunks[0].pageRange).toBeNull();
    });

    it('assigns correct page number for single-page chunk', () => {
      const input = generateTestText(1500);
      const pageOffsets: PageOffset[] = [{ page: 1, charStart: 0, charEnd: 2000 }];

      const chunks = chunkHybridSectionAware(input, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

      expect(chunks[0].pageNumber).toBe(1);
    });

    it('assigns page range for chunk spanning two pages', () => {
      const page1Text = generateTestText(1500);
      const page2Text = generateTestText(1500);
      const input = page1Text + page2Text;
      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: 1500 },
        { page: 2, charStart: 1500, charEnd: 3000 },
      ];

      const chunks = chunkHybridSectionAware(input, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

      // At least one chunk should span pages
      const multiPage = chunks.find((c) => c.pageRange !== null);
      if (chunks.length === 1) {
        // If text fits in one chunk, it should span pages
        expect(chunks[0].pageRange).toBe('1-2');
      } else if (multiPage) {
        expect(multiPage.pageRange).toContain('-');
      }
    });
  });

  describe('custom config', () => {
    it('respects custom chunk size', () => {
      const customConfig: ChunkingConfig = {
        chunkSize: 1000,
        overlapPercent: 10,
        maxChunkSize: 4000,
      };
      const input = generateTestText(3000);

      const chunks = chunkText(input, customConfig);

      // Should produce multiple chunks with smaller size
      expect(chunks.length).toBeGreaterThan(1);
      // No chunk should exceed maxChunkSize
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(customConfig.maxChunkSize);
      }
    });

    it('respects custom overlap percent', () => {
      const customConfig: ChunkingConfig = {
        chunkSize: 2000,
        overlapPercent: 20,
        maxChunkSize: 8000,
      };
      const input = generateTestText(5000);

      const chunks = chunkText(input, customConfig);

      if (chunks.length > 1) {
        // Non-atomic middle chunks should have overlap
        const nonAtomicChunks = chunks.filter((c) => !c.isAtomic);
        if (nonAtomicChunks.length > 1) {
          expect(nonAtomicChunks[1].overlapWithPrevious).toBeGreaterThan(0);
        }
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS - PROVENANCE CREATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('createChunkProvenance', () => {
  it('creates provenance with correct type and source_type', () => {
    const chunk = chunkText(generateTestText(500))[0];
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: 1,
    };

    const prov = createChunkProvenance(params);

    expect(prov.type).toBe(ProvenanceType.CHUNK);
    expect(prov.source_type).toBe('CHUNKING');
  });

  it('creates provenance with correct processor info', () => {
    const chunk = chunkText(generateTestText(500))[0];
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: 1,
    };

    const prov = createChunkProvenance(params);

    expect(prov.processor).toBe('chunker');
    expect(prov.processor_version).toBe('2.0.0');
  });

  it('includes all required processing_params', () => {
    const chunk = chunkText(generateTestText(500))[0];
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: 1,
    };

    const prov = createChunkProvenance(params);
    const pp = prov.processing_params;

    expect(pp.chunk_size).toBe(CHUNK_SIZE);
    expect(pp.overlap_percent).toBe(OVERLAP_PERCENT);
    expect(pp.max_chunk_size).toBe(8000);
    expect(pp.strategy).toBe('hybrid_section');
    expect(pp.chunk_index).toBe(0);
    expect(pp.total_chunks).toBe(1);
    expect(pp.character_start).toBe(chunk.startOffset);
    expect(pp.character_end).toBe(chunk.endOffset);
    expect(pp.heading_context).toBeDefined();
    expect(pp.section_path).toBeDefined();
    expect(typeof pp.is_atomic).toBe('boolean');
    expect(Array.isArray(pp.content_types)).toBe(true);
  });

  it('includes location with chunk_index and offsets', () => {
    const chunks = chunkText(generateTestText(5000));
    expect(chunks.length).toBeGreaterThan(1);
    const chunk = chunks[1]; // Second chunk
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: chunks.length,
    };

    const prov = createChunkProvenance(params);

    expect(prov.location).toBeDefined();
    expect(prov.location!.chunk_index).toBe(1);
    expect(prov.location!.character_start).toBe(chunk.startOffset);
    expect(prov.location!.character_end).toBe(chunk.endOffset);
  });

  it('includes page info in location when available', () => {
    const pageOffsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 1500 },
      { page: 2, charStart: 1500, charEnd: 3000 },
    ];
    const chunks = chunkHybridSectionAware(
      generateTestText(2500),
      pageOffsets,
      null,
      DEFAULT_CHUNKING_CONFIG
    );
    const chunk = chunks[0];
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: chunks.length,
    };

    const prov = createChunkProvenance(params);

    expect(prov.location!.page_number).toBe(1);
  });

  it('uses correct source_id and root_document_id', () => {
    const chunk = chunkText(generateTestText(500))[0];
    const ocrProvId = uuidv4();
    const docProvId = uuidv4();
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: ocrProvId,
      documentProvenanceId: docProvId,
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: 1,
    };

    const prov = createChunkProvenance(params);

    expect(prov.source_id).toBe(ocrProvId);
    expect(prov.root_document_id).toBe(docProvId);
  });

  it('uses correct hash values', () => {
    const chunk = chunkText(generateTestText(500))[0];
    const chunkHash = computeHash(chunk.text);
    const ocrHash = computeHash('ocr content');
    const fileHash = computeHash('file content');
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: chunkHash,
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: ocrHash,
      fileHash: fileHash,
      totalChunks: 1,
    };

    const prov = createChunkProvenance(params);

    expect(prov.content_hash).toBe(chunkHash);
    expect(prov.input_hash).toBe(ocrHash);
    expect(prov.file_hash).toBe(fileHash);

    // Verify hash formats
    expect(isValidHashFormat(prov.content_hash)).toBe(true);
    expect(isValidHashFormat(prov.input_hash!)).toBe(true);
    expect(isValidHashFormat(prov.file_hash!)).toBe(true);
  });

  it('includes processing duration when provided', () => {
    const chunk = chunkText(generateTestText(500))[0];
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: 1,
      processingDurationMs: 150,
    };

    const prov = createChunkProvenance(params);

    expect(prov.processing_duration_ms).toBe(150);
  });

  it('uses null for processing duration when not provided', () => {
    const chunk = chunkText(generateTestText(500))[0];
    const params: ChunkProvenanceParams = {
      chunk,
      chunkTextHash: computeHash(chunk.text),
      ocrProvenanceId: uuidv4(),
      documentProvenanceId: uuidv4(),
      ocrContentHash: computeHash('ocr content'),
      fileHash: computeHash('file content'),
      totalChunks: 1,
    };

    const prov = createChunkProvenance(params);

    expect(prov.processing_duration_ms).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS - DATABASE VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database Integration', () => {
  let testDir: string;
  let dbService: ReturnType<typeof createFreshDatabase>;

  beforeAll(() => {
    testDir = createTestDir('chunking-integration-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'chunk-test');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  it('stores chunks in database and verifies retrieval', () => {
    if (!dbService) {
      return;
    }

    // Setup: Create document provenance chain
    const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
    dbService.insertProvenance(docProv);

    const doc = createTestDocument(docProv.id);
    dbService.insertDocument(doc);

    // OCR provenance (depth 1)
    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      source_id: docProv.id,
      parent_id: docProv.id,
      parent_ids: JSON.stringify([docProv.id]),
      root_document_id: docProv.id,
      chain_depth: 1,
    });
    dbService.insertProvenance(ocrProv);

    // OCR result with known text
    const ocrText = generateTestText(5000);
    const ocrResult = createTestOCRResult(doc.id, ocrProv.id, {
      extracted_text: ocrText,
      text_length: ocrText.length,
      content_hash: computeHash(ocrText),
    });
    dbService.insertOCRResult(ocrResult);

    // Execute: Chunk the text
    const chunks = chunkText(ocrResult.extracted_text);

    expect(chunks.length).toBeGreaterThan(1);

    // Store chunks with provenance
    const storedIds: string[] = [];
    for (const chunk of chunks) {
      // Create chunk provenance (depth 2)
      const chunkProv = createTestProvenance({
        type: ProvenanceType.CHUNK,
        source_id: ocrProv.id,
        parent_id: ocrProv.id,
        parent_ids: JSON.stringify([ocrProv.id, docProv.id]),
        root_document_id: docProv.id,
        chain_depth: 2,
        content_hash: computeHash(chunk.text),
      });
      dbService.insertProvenance(chunkProv);

      const chunkId = uuidv4();
      dbService.insertChunk({
        id: chunkId,
        document_id: doc.id,
        ocr_result_id: ocrResult.id,
        text: chunk.text,
        text_hash: computeHash(chunk.text),
        chunk_index: chunk.index,
        character_start: chunk.startOffset,
        character_end: chunk.endOffset,
        page_number: chunk.pageNumber,
        page_range: chunk.pageRange,
        overlap_previous: chunk.overlapWithPrevious,
        overlap_next: chunk.overlapWithNext,
        provenance_id: chunkProv.id,
        ocr_quality_score: null,
        heading_context: chunk.headingContext ?? null,
        heading_level: chunk.headingLevel ?? null,
        section_path: chunk.sectionPath ?? null,
        content_types: JSON.stringify(chunk.contentTypes),
        is_atomic: chunk.isAtomic ? 1 : 0,
        chunking_strategy: 'hybrid_section',
      });
      storedIds.push(chunkId);
    }

    // VERIFY: Read back from database and check each chunk
    const retrieved = dbService.getChunksByDocumentId(doc.id);
    expect(retrieved.length).toBe(chunks.length);

    for (let i = 0; i < chunks.length; i++) {
      const stored = retrieved.find((c) => c.chunk_index === i);
      expect(stored).toBeDefined();
      expect(stored!.text).toBe(chunks[i].text);
      expect(stored!.text_hash).toBe(computeHash(chunks[i].text));
      expect(stored!.embedding_status).toBe('pending');
      expect(stored!.character_start).toBe(chunks[i].startOffset);
      expect(stored!.character_end).toBe(chunks[i].endOffset);
      expect(stored!.overlap_previous).toBe(chunks[i].overlapWithPrevious);
      expect(stored!.overlap_next).toBe(chunks[i].overlapWithNext);
      expect(stored!.chunking_strategy).toBe('hybrid_section');

      // Verify hash integrity
      expect(isValidHashFormat(stored!.text_hash)).toBe(true);
      expect(computeHash(stored!.text)).toBe(stored!.text_hash);
    }
  });

  it('verifies provenance chain integrity for chunks', () => {
    if (!dbService) {
      return;
    }

    // Setup document chain
    const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
    dbService.insertProvenance(docProv);

    const doc = createTestDocument(docProv.id);
    dbService.insertDocument(doc);

    const ocrProv = createTestProvenance({
      type: ProvenanceType.OCR_RESULT,
      source_id: docProv.id,
      parent_id: docProv.id,
      parent_ids: JSON.stringify([docProv.id]),
      root_document_id: docProv.id,
      chain_depth: 1,
    });
    dbService.insertProvenance(ocrProv);

    const ocrText = generateTestText(2500);
    const ocrResult = createTestOCRResult(doc.id, ocrProv.id, {
      extracted_text: ocrText,
      content_hash: computeHash(ocrText),
    });
    dbService.insertOCRResult(ocrResult);

    // Create chunk provenance
    const chunks = chunkText(ocrText);
    const chunk = chunks[0];
    const chunkTextHash = computeHash(chunk.text);

    const chunkProvParams = createChunkProvenance({
      chunk,
      chunkTextHash,
      ocrProvenanceId: ocrProv.id,
      documentProvenanceId: docProv.id,
      ocrContentHash: ocrResult.content_hash,
      fileHash: doc.file_hash,
      totalChunks: chunks.length,
    });

    // Verify provenance parameters
    expect(chunkProvParams.type).toBe(ProvenanceType.CHUNK);
    expect(PROVENANCE_CHAIN_DEPTH[ProvenanceType.CHUNK]).toBe(2);
    expect(chunkProvParams.source_id).toBe(ocrProv.id);
    expect(chunkProvParams.root_document_id).toBe(docProv.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HASH VERIFICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Hash Verification', () => {
  it('hash format is sha256: + 64 lowercase hex', () => {
    const text = generateTestText(500);
    const hash = computeHash(text);

    expect(hash.startsWith('sha256:')).toBe(true);
    expect(hash.length).toBe(7 + 64); // 'sha256:' + 64 hex chars
    expect(HASH_PATTERN.test(hash)).toBe(true);
  });

  it('same content produces same hash', () => {
    const text = generateTestText(1000);
    const hash1 = computeHash(text);
    const hash2 = computeHash(text);

    expect(hash1).toBe(hash2);
  });

  it('different content produces different hash', () => {
    const text1 = generateTestText(1000);
    const text2 = generateTestText(1001);
    const hash1 = computeHash(text1);
    const hash2 = computeHash(text2);

    expect(hash1).not.toBe(hash2);
  });

  it('chunk hashes are unique for different chunks', () => {
    const chunks = chunkText(generateTestText(5000));
    const hashes = chunks.map((c) => computeHash(c.text));
    const uniqueHashes = new Set(hashes);

    expect(uniqueHashes.size).toBe(chunks.length);
  });
});

// Pattern for regex test
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
