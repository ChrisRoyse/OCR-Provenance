/**
 * Chunking Service Tests
 *
 * Comprehensive tests for the text chunking service.
 * NO MOCKS - uses real data and verifies actual outputs.
 *
 * @see Task 12: Implement Text Chunking Service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chunkText,
  chunkWithPageTracking,
  createChunkProvenance,
  ChunkProvenanceParams,
} from '../../../src/services/chunking/chunker.js';
import {
  DEFAULT_CHUNKING_CONFIG,
  getOverlapCharacters,
  getStepSize,
  ChunkingConfig,
} from '../../../src/models/chunk.js';
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
// TEST DATA GENERATORS - DETERMINISTIC, NO RANDOMNESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate deterministic test text of specified length
 * Uses a repeating pattern for predictable reconstruction
 */
function generateTestText(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[i % chars.length];
  }
  return result;
}

/**
 * Calculate expected number of chunks for a given text length
 *
 * With the algorithm that breaks when endOffset >= text.length:
 * - First chunk covers 0 to min(chunkSize, textLength)
 * - Each subsequent chunk starts at previous_start + stepSize
 * - We stop when a chunk reaches the end
 */
function calculateExpectedChunks(textLength: number): number {
  if (textLength === 0) return 0;
  if (textLength <= CHUNK_SIZE) return 1;
  // Count chunks: 1 + number of additional chunks needed
  // After first chunk (0-chunkSize), remaining uncovered = textLength - chunkSize
  // Each step adds stepSize new chars, so additional chunks = ceil(remaining / stepSize)
  const remaining = textLength - CHUNK_SIZE;
  return 1 + Math.ceil(remaining / STEP_SIZE);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CASES WITH KNOWN EXPECTED OUTPUTS
// ═══════════════════════════════════════════════════════════════════════════════

const TEST_CASES = {
  empty: { input: '', expectedChunks: 0 },
  short: { input: generateTestText(500), expectedChunks: 1 },
  exactSize: { input: generateTestText(2000), expectedChunks: 1 },
  onePlusOne: { input: generateTestText(2001), expectedChunks: 2 },
  threeChunks: { input: generateTestText(4000), expectedChunks: 3 },
  fiveChunks: { input: generateTestText(7600), expectedChunks: 5 },
  largeText: { input: generateTestText(20000), expectedChunks: 11 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS - CHUNKING ALGORITHM
// ═══════════════════════════════════════════════════════════════════════════════

describe('chunkText', () => {
  describe('config helpers', () => {
    it('getOverlapCharacters returns correct value', () => {
      const overlap = getOverlapCharacters(DEFAULT_CHUNKING_CONFIG);
      expect(overlap).toBe(OVERLAP_CHARS);
      console.log(`[VERIFIED] Overlap characters: ${overlap}`);
    });

    it('getStepSize returns correct value', () => {
      const step = getStepSize(DEFAULT_CHUNKING_CONFIG);
      expect(step).toBe(STEP_SIZE);
      console.log(`[VERIFIED] Step size: ${step}`);
    });

    it('DEFAULT_CHUNKING_CONFIG has correct values', () => {
      expect(DEFAULT_CHUNKING_CONFIG.chunkSize).toBe(CHUNK_SIZE);
      expect(DEFAULT_CHUNKING_CONFIG.overlapPercent).toBe(OVERLAP_PERCENT);
      console.log(`[VERIFIED] Config: chunkSize=${CHUNK_SIZE}, overlapPercent=${OVERLAP_PERCENT}`);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const input = TEST_CASES.empty.input;
      console.log(`[BEFORE] Input length: ${input.length}`);

      const chunks = chunkText(input);

      console.log(`[AFTER] Chunks: ${chunks.length}`);
      expect(chunks).toEqual([]);
      expect(chunks.length).toBe(TEST_CASES.empty.expectedChunks);
    });

    it('handles text shorter than chunk size', () => {
      const input = TEST_CASES.short.input;
      console.log(`[BEFORE] Input length: ${input.length}`);

      const chunks = chunkText(input);

      console.log(`[AFTER] Chunks: ${chunks.length}, Chunk length: ${chunks[0]?.text.length}`);
      expect(chunks.length).toBe(1);
      expect(chunks[0].text.length).toBe(500);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe(500);
      expect(chunks[0].overlapWithPrevious).toBe(0);
      expect(chunks[0].overlapWithNext).toBe(0);
      expect(chunks[0].index).toBe(0);
    });

    it('handles exact chunk size (2000 chars)', () => {
      const input = TEST_CASES.exactSize.input;
      console.log(`[BEFORE] Input length: ${input.length}`);

      const chunks = chunkText(input);

      console.log(
        `[AFTER] Chunks: ${chunks.length}, First chunk length: ${chunks[0]?.text.length}`
      );
      console.log(
        `[STATE] overlapWithPrevious: ${chunks[0]?.overlapWithPrevious}, overlapWithNext: ${chunks[0]?.overlapWithNext}`
      );

      expect(chunks.length).toBe(1);
      expect(chunks[0].text.length).toBe(2000);
      expect(chunks[0].overlapWithPrevious).toBe(0);
      expect(chunks[0].overlapWithNext).toBe(0);
    });

    it('handles 2001 chars (creates 2 chunks)', () => {
      const input = TEST_CASES.onePlusOne.input;
      console.log(`[BEFORE] Input length: ${input.length}`);

      const chunks = chunkText(input);

      console.log(`[AFTER] Chunks: ${chunks.length}`);
      console.log(
        `[CHUNK 0] length: ${chunks[0]?.text.length}, overlap: prev=${chunks[0]?.overlapWithPrevious}, next=${chunks[0]?.overlapWithNext}`
      );
      console.log(
        `[CHUNK 1] length: ${chunks[1]?.text.length}, overlap: prev=${chunks[1]?.overlapWithPrevious}, next=${chunks[1]?.overlapWithNext}`
      );

      expect(chunks.length).toBe(2);
      expect(chunks[0].overlapWithNext).toBe(OVERLAP_CHARS);
      expect(chunks[1].overlapWithPrevious).toBe(OVERLAP_CHARS);
      expect(chunks[1].overlapWithNext).toBe(0);
    });

    it('handles unicode content (emojis)', () => {
      const emoji = '🔥';
      // Note: Each emoji is 2 UTF-16 code units (surrogate pair), so 500 emojis = 1000 string length
      const input = emoji.repeat(500);
      console.log(`[BEFORE] Input length: ${input.length}, First emoji: ${input.slice(0, 2)}`);

      const chunks = chunkText(input);

      console.log(`[AFTER] Chunks: ${chunks.length}`);
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe(input);
      // 500 emojis × 2 chars each = 1000 string length
      expect(chunks[0].text.length).toBe(1000);
    });

    it('handles CJK characters', () => {
      const cjk = '中文测试文本';
      const input = cjk.repeat(300); // 1800 chars
      console.log(`[BEFORE] Input length: ${input.length}`);

      const chunks = chunkText(input);

      console.log(`[AFTER] Chunks: ${chunks.length}`);
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe(input);
    });
  });

  describe('chunking correctness', () => {
    it('produces correct number of chunks for 4000 chars', () => {
      const input = TEST_CASES.threeChunks.input;
      const chunks = chunkText(input);

      expect(chunks.length).toBe(TEST_CASES.threeChunks.expectedChunks);
      console.log(`[VERIFIED] 4000 chars -> ${chunks.length} chunks`);
    });

    it('produces correct number of chunks for 7600 chars', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      expect(chunks.length).toBe(TEST_CASES.fiveChunks.expectedChunks);
      console.log(`[VERIFIED] 7600 chars -> ${chunks.length} chunks`);
    });

    it('produces correct number of chunks for large text', () => {
      const input = TEST_CASES.largeText.input;
      const chunks = chunkText(input);

      // Calculate expected: (20000 - 200) / 1800 = 11.0 -> ceiling = 11, but need to verify
      // Actually: first chunk is 0-2000, then 1800-3800, etc.
      // Positions: 0, 1800, 3600, 5400, 7200, 9000, 10800, 12600, 14400, 16200, 18000, 19800
      // At 19800, chunk would be 19800-20000 (200 chars) - that's still a chunk
      // So we have 12 chunks

      const expectedChunks = calculateExpectedChunks(input.length);
      expect(chunks.length).toBe(expectedChunks);
      console.log(`[VERIFIED] 20000 chars -> ${chunks.length} chunks (expected ${expectedChunks})`);
    });

    it('all chunks have correct indices', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
      console.log(`[VERIFIED] All ${chunks.length} chunks have correct indices`);
    });

    it('first chunk has no previous overlap', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      expect(chunks[0].overlapWithPrevious).toBe(0);
    });

    it('last chunk has no next overlap', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      expect(chunks[chunks.length - 1].overlapWithNext).toBe(0);
    });

    it('middle chunks have correct overlap values', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      for (let i = 1; i < chunks.length - 1; i++) {
        expect(chunks[i].overlapWithPrevious).toBe(OVERLAP_CHARS);
        expect(chunks[i].overlapWithNext).toBe(OVERLAP_CHARS);
      }
      console.log(`[VERIFIED] Middle chunks have 200-char overlap on both sides`);
    });
  });

  describe('reconstruction verification', () => {
    it('can reconstruct original text from chunks', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      // Reconstruct: take first chunk, then skip overlap portion from subsequent chunks
      let reconstructed = chunks[0].text;
      for (let i = 1; i < chunks.length; i++) {
        reconstructed += chunks[i].text.slice(OVERLAP_CHARS);
      }

      expect(reconstructed).toBe(input);
      console.log(`[VERIFIED] Reconstruction matches original (${input.length} chars)`);
    });

    it('can reconstruct large text from chunks', () => {
      const input = TEST_CASES.largeText.input;
      const chunks = chunkText(input);

      let reconstructed = chunks[0].text;
      for (let i = 1; i < chunks.length; i++) {
        reconstructed += chunks[i].text.slice(OVERLAP_CHARS);
      }

      expect(reconstructed).toBe(input);
      console.log(`[VERIFIED] Large text reconstruction matches original (${input.length} chars)`);
    });

    it('chunk offsets are contiguous with step size', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      for (let i = 1; i < chunks.length; i++) {
        const expectedStart = chunks[i - 1].startOffset + STEP_SIZE;
        expect(chunks[i].startOffset).toBe(expectedStart);
      }
      console.log(`[VERIFIED] Chunk offsets follow step size pattern`);
    });

    it('overlapping portions are identical', () => {
      const input = TEST_CASES.fiveChunks.input;
      const chunks = chunkText(input);

      for (let i = 1; i < chunks.length; i++) {
        const prevOverlapEnd = chunks[i - 1].text.slice(-OVERLAP_CHARS);
        const currOverlapStart = chunks[i].text.slice(0, OVERLAP_CHARS);
        expect(currOverlapStart).toBe(prevOverlapEnd);
      }
      console.log(`[VERIFIED] Overlapping portions match between adjacent chunks`);
    });
  });

  describe('custom config', () => {
    it('respects custom chunk size', () => {
      const customConfig: ChunkingConfig = { chunkSize: 1000, overlapPercent: 10 };
      const input = generateTestText(3000);

      const chunks = chunkText(input, customConfig);

      // With 1000 chunk size and 10% overlap (100 chars), step is 900
      // 3000 chars: 0-1000, 900-1900, 1800-2800, 2700-3000
      expect(chunks[0].text.length).toBe(1000);
      console.log(`[VERIFIED] Custom chunk size respected: ${chunks.length} chunks`);
    });

    it('respects custom overlap percent', () => {
      const customConfig: ChunkingConfig = { chunkSize: 2000, overlapPercent: 20 };
      const input = generateTestText(4000);
      const expectedOverlap = 400; // 20% of 2000

      const chunks = chunkText(input, customConfig);

      expect(chunks[1].overlapWithPrevious).toBe(expectedOverlap);
      console.log(`[VERIFIED] Custom overlap respected: ${expectedOverlap} chars`);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS - PAGE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

describe('chunkWithPageTracking', () => {
  it('returns null page info when no pageOffsets provided', () => {
    const input = TEST_CASES.short.input;
    const chunks = chunkWithPageTracking(input, []);

    expect(chunks[0].pageNumber).toBeNull();
    expect(chunks[0].pageRange).toBeNull();
    console.log(`[VERIFIED] No page offsets -> null page info`);
  });

  it('assigns correct page number for single-page chunk', () => {
    const input = generateTestText(1500);
    const pageOffsets: PageOffset[] = [{ page: 1, charStart: 0, charEnd: 2000 }];

    const chunks = chunkWithPageTracking(input, pageOffsets);

    expect(chunks[0].pageNumber).toBe(1);
    expect(chunks[0].pageRange).toBeNull();
    console.log(`[VERIFIED] Single page chunk: pageNumber=1, pageRange=null`);
  });

  it('assigns page range for chunk spanning two pages', () => {
    const input = generateTestText(2500);
    const pageOffsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 1500 },
      { page: 2, charStart: 1500, charEnd: 3000 },
    ];

    const chunks = chunkWithPageTracking(input, pageOffsets);

    // Chunk 0: chars 0-2000, spans pages 1-2
    expect(chunks[0].pageNumber).toBe(1);
    expect(chunks[0].pageRange).toBe('1-2');
    console.log(`[VERIFIED] Multi-page chunk: pageNumber=1, pageRange='1-2'`);
  });

  it('handles three-page document correctly', () => {
    const input = generateTestText(4500);
    const pageOffsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 1500 },
      { page: 2, charStart: 1500, charEnd: 3000 },
      { page: 3, charStart: 3000, charEnd: 4500 },
    ];

    const chunks = chunkWithPageTracking(input, pageOffsets);

    console.log(`[DEBUG] Chunks created: ${chunks.length}`);
    for (const c of chunks) {
      console.log(
        `  Chunk ${c.index}: [${c.startOffset}-${c.endOffset}] pageNumber=${c.pageNumber}, pageRange=${c.pageRange}`
      );
    }

    // Chunk 0: chars 0-2000 spans pages 1-2
    expect(chunks[0].pageRange).toBe('1-2');

    // Chunk 1: chars 1800-3800 spans pages 2-3
    expect(chunks[1].pageRange).toBe('2-3');

    // Chunk 2: chars 3600-4500 is on page 3
    expect(chunks[2].pageNumber).toBe(3);
    expect(chunks[2].pageRange).toBeNull();
  });

  it('assigns correct page number when chunk fully within one page', () => {
    const input = generateTestText(1000);
    const pageOffsets: PageOffset[] = [{ page: 5, charStart: 0, charEnd: 2000 }];

    const chunks = chunkWithPageTracking(input, pageOffsets);

    expect(chunks[0].pageNumber).toBe(5);
    expect(chunks[0].pageRange).toBeNull();
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
    console.log(`[VERIFIED] Provenance type=${prov.type}, source_type=${prov.source_type}`);
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
    expect(prov.processor_version).toBe('1.0.0');
    console.log(`[VERIFIED] Processor info correct`);
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
    expect(pp.overlap_characters).toBe(OVERLAP_CHARS);
    expect(pp.chunk_index).toBe(0);
    expect(pp.total_chunks).toBe(1);
    expect(pp.character_start).toBe(0);
    expect(pp.character_end).toBe(500);
    console.log(`[VERIFIED] All processing_params present`);
  });

  it('includes location with chunk_index and offsets', () => {
    const chunks = chunkText(generateTestText(4000));
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
    expect(prov.location!.character_start).toBe(STEP_SIZE);
    expect(prov.location!.character_end).toBe(STEP_SIZE + CHUNK_SIZE);
    console.log(`[VERIFIED] Location info correct for chunk 1`);
  });

  it('includes page info in location when available', () => {
    const pageOffsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 1500 },
      { page: 2, charStart: 1500, charEnd: 3000 },
    ];
    const chunks = chunkWithPageTracking(generateTestText(2500), pageOffsets);
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
    expect(prov.location!.page_range).toBe('1-2');
    console.log(`[VERIFIED] Page info included in location`);
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
    console.log(`[VERIFIED] Source and root document IDs correct`);
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
    console.log(`[VERIFIED] All hashes valid and correct`);
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
    console.log(`[SETUP] Test directory: ${testDir}`);
  });

  afterAll(() => {
    cleanupTestDir(testDir);
    console.log(`[CLEANUP] Removed test directory`);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'chunk-test');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  it('stores chunks in database and verifies retrieval', () => {
    if (!dbService) {
      console.log('[SKIP] sqlite-vec not available');
      return;
    }

    // Setup: Create document provenance chain
    const docProv = createTestProvenance({ type: ProvenanceType.DOCUMENT });
    dbService.insertProvenance(docProv);
    console.log(`[SETUP] Document provenance: ${docProv.id}`);

    const doc = createTestDocument(docProv.id);
    dbService.insertDocument(doc);
    console.log(`[SETUP] Document: ${doc.id}`);

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
    console.log(`[SETUP] OCR provenance: ${ocrProv.id}`);

    // OCR result with known text
    const ocrText = generateTestText(5000);
    const ocrResult = createTestOCRResult(doc.id, ocrProv.id, {
      extracted_text: ocrText,
      text_length: ocrText.length,
      content_hash: computeHash(ocrText),
    });
    dbService.insertOCRResult(ocrResult);
    console.log(`[SETUP] OCR result: ${ocrResult.id}, text length: ${ocrText.length}`);

    // Execute: Chunk the text
    const startTime = Date.now();
    const chunks = chunkText(ocrResult.extracted_text);
    const processingTime = Date.now() - startTime;
    console.log(`[EXECUTE] Created ${chunks.length} chunks in ${processingTime}ms`);

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
      });
      storedIds.push(chunkId);
    }
    console.log(`[EXECUTE] Stored ${storedIds.length} chunks in database`);

    // VERIFY: Read back from database and check each chunk
    const retrieved = dbService.getChunksByDocumentId(doc.id);
    expect(retrieved.length).toBe(chunks.length);
    console.log(`[VERIFY] Retrieved ${retrieved.length} chunks from database`);

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

      // Verify hash integrity
      expect(isValidHashFormat(stored!.text_hash)).toBe(true);
      expect(computeHash(stored!.text)).toBe(stored!.text_hash);
    }

    console.log(`[VERIFIED] All ${retrieved.length} chunks verified with correct data and hashes`);
  });

  it('verifies provenance chain integrity for chunks', () => {
    if (!dbService) {
      console.log('[SKIP] sqlite-vec not available');
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
    console.log(`[VERIFIED] Chunk provenance chain depth is 2`);
    console.log(`[VERIFIED] Chunk provenance links to OCR result (depth 1)`);
    console.log(`[VERIFIED] Chunk provenance references root document (depth 0)`);
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
    console.log(`[VERIFIED] Hash format: ${hash.substring(0, 20)}...`);
  });

  it('same content produces same hash', () => {
    const text = generateTestText(1000);
    const hash1 = computeHash(text);
    const hash2 = computeHash(text);

    expect(hash1).toBe(hash2);
    console.log(`[VERIFIED] Hash is deterministic`);
  });

  it('different content produces different hash', () => {
    const text1 = generateTestText(1000);
    const text2 = generateTestText(1001);
    const hash1 = computeHash(text1);
    const hash2 = computeHash(text2);

    expect(hash1).not.toBe(hash2);
    console.log(`[VERIFIED] Different content -> different hash`);
  });

  it('chunk hashes are unique for different chunks', () => {
    const chunks = chunkText(generateTestText(5000));
    const hashes = chunks.map((c) => computeHash(c.text));
    const uniqueHashes = new Set(hashes);

    expect(uniqueHashes.size).toBe(chunks.length);
    console.log(`[VERIFIED] All ${chunks.length} chunk hashes are unique`);
  });
});

// Pattern for regex test
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
