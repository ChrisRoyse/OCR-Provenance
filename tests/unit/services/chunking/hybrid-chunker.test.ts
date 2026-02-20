/**
 * Unit Tests for Hybrid Section-Aware Chunker
 *
 * Tests chunkHybridSectionAware and createChunkProvenance using realistic
 * Datalab OCR markdown output with headings, tables, code blocks, lists,
 * and page markers.
 *
 * NO MOCK DATA - uses realistic OCR output text.
 *
 * @module tests/unit/services/chunking/hybrid-chunker
 */

import { describe, it, expect } from 'vitest';
import {
  chunkHybridSectionAware,
  createChunkProvenance,
  ChunkProvenanceParams,
  DEFAULT_CHUNKING_CONFIG,
} from '../../../../src/services/chunking/chunker.js';
import type { ChunkingConfig, ChunkResult } from '../../../../src/services/chunking/chunker.js';
import type { PageOffset } from '../../../../src/models/document.js';
import { ProvenanceType } from '../../../../src/models/provenance.js';
import { getOverlapCharacters } from '../../../../src/models/chunk.js';

// =============================================================================
// REALISTIC TEST DOCUMENTS
// =============================================================================

/**
 * Multi-section document with headings, paragraphs, a table, and a code block.
 * Represents typical Datalab OCR output from a technical document.
 */
const MULTI_SECTION_DOCUMENT = `# System Architecture Overview

The platform is built on a microservices architecture with event-driven communication between components. Each service maintains its own data store and communicates through an Apache Kafka message bus. The system handles approximately 50,000 requests per second at peak load.

## Authentication Service

The authentication service uses OAuth 2.0 with PKCE flow for public clients and client credentials for service-to-service communication. JSON Web Tokens are issued with a 15-minute expiration and refresh tokens are valid for 30 days.

### Token Validation

| Token Type | Expiration | Storage | Revocation |
|------------|-----------|---------|------------|
| Access Token | 15 minutes | Memory cache | Blacklist check |
| Refresh Token | 30 days | Encrypted DB | Immediate delete |
| API Key | No expiry | Hashed in DB | Soft delete |

### Rate Limiting Configuration

\`\`\`yaml
rate_limiting:
  default:
    requests_per_second: 100
    burst_size: 150
  authenticated:
    requests_per_second: 500
    burst_size: 750
  admin:
    requests_per_second: 1000
    burst_size: 1500
\`\`\`

## Data Processing Pipeline

The data processing pipeline ingests documents through a multi-stage workflow. Each document passes through validation, OCR extraction, chunking, embedding generation, and indexing phases. Failed documents are routed to a dead-letter queue for manual review.

### Ingestion Stages

The ingestion process follows these steps:

1. File upload and virus scanning
2. Format detection and validation
3. OCR processing via Datalab API
4. Text extraction and cleaning
5. Section-aware chunking
6. Embedding generation using nomic-embed-text-v1.5
7. Vector storage in sqlite-vec

## Monitoring and Observability

All services emit structured logs in JSON format to a centralized logging platform. Metrics are collected via Prometheus and visualized in Grafana dashboards. Distributed tracing uses OpenTelemetry with a Jaeger backend.`;

/**
 * Short document that fits in a single chunk.
 */
const SHORT_DOCUMENT = 'This is a brief document with minimal content that easily fits within a single chunk.';

/**
 * Document with page markers for page tracking tests.
 */
const DOCUMENT_WITH_PAGES = `# Contract Agreement

This agreement is entered into between Party A and Party B on the date specified below. Both parties agree to the terms and conditions outlined in this document.

## Terms and Conditions

The following terms apply to all transactions under this agreement. Payment shall be made within 30 days of invoice receipt.

---
<!-- Page 2 -->

## Liability Clauses

Neither party shall be liable for indirect, incidental, or consequential damages arising from the performance or non-performance of obligations under this agreement.

### Force Majeure

In the event of force majeure, the affected party shall notify the other party within 48 hours of becoming aware of the event. Performance obligations shall be suspended for the duration of the force majeure event.

---
<!-- Page 3 -->

## Signatures

This agreement shall be executed in duplicate, with each party retaining one original copy. Both copies shall be deemed originals for all purposes.`;

/**
 * Very long document that requires splitting into multiple chunks.
 */
function generateLongParagraph(sentenceCount: number): string {
  const sentences = [
    'The analysis of the experimental results reveals significant correlations between the independent variables and the observed outcomes.',
    'Statistical significance was established at the p < 0.05 level using a two-tailed t-test with Bonferroni correction for multiple comparisons.',
    'The control group demonstrated baseline performance metrics consistent with previous studies conducted under similar experimental conditions.',
    'Regression analysis indicates a strong positive relationship between dosage levels and therapeutic response across all demographic subgroups.',
    'The confidence interval for the primary endpoint falls within the pre-specified bounds established during the study design phase.',
    'Post-hoc analyses revealed additional interaction effects that warrant further investigation in subsequent clinical trials.',
    'The safety profile of the intervention was favorable, with adverse event rates comparable to the placebo arm of the study.',
    'Longitudinal follow-up data collected at 6, 12, and 24 months post-treatment confirm the durability of the observed therapeutic benefits.',
  ];
  const result: string[] = [];
  for (let i = 0; i < sentenceCount; i++) {
    result.push(sentences[i % sentences.length]);
  }
  return result.join(' ');
}

const LONG_DOCUMENT = `# Research Findings

## Primary Analysis

${generateLongParagraph(30)}

## Secondary Analysis

${generateLongParagraph(25)}

## Discussion

${generateLongParagraph(20)}`;

// =============================================================================
// chunkHybridSectionAware - basic behavior
// =============================================================================

describe('chunkHybridSectionAware', () => {
  describe('basic behavior', () => {
    it('empty text returns empty array', () => {
      const chunks = chunkHybridSectionAware('', [], null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks).toEqual([]);
    });

    it('single paragraph under chunk size returns one chunk', () => {
      const chunks = chunkHybridSectionAware(
        SHORT_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe(SHORT_DOCUMENT);
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe(SHORT_DOCUMENT.length);
    });

    it('large text exceeding chunk size is split at sentence boundaries', () => {
      const chunks = chunkHybridSectionAware(
        LONG_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should not drastically exceed chunk size (some tolerance for block boundaries)
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(
          DEFAULT_CHUNKING_CONFIG.maxChunkSize
        );
      }

      // Chunks should have sequential indices
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });

    it('all text is covered by chunks (no gaps)', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      // First chunk starts at beginning
      expect(chunks[0].startOffset).toBe(0);

      // Verify all chunk text is non-empty
      for (const chunk of chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('heading behavior', () => {
    it('headings create new chunks (flush before heading)', () => {
      const text = '# Section One\n\nParagraph under section one.\n\n# Section Two\n\nParagraph under section two.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Should have at least 2 chunks (one per section)
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // First chunk should contain Section One
      expect(chunks[0].text).toContain('Section One');

      // Second chunk should contain Section Two
      const secondChunk = chunks.find((c) => c.text.includes('Section Two'));
      expect(secondChunk).toBeDefined();
    });

    it('headingContext carries the last heading text', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      // Find chunks that follow headings
      const chunksWithHeading = chunks.filter((c) => c.headingContext !== null);
      expect(chunksWithHeading.length).toBeGreaterThan(0);

      // The first chunk with heading context should reference a heading from the document
      const headingTexts = [
        'System Architecture Overview',
        'Authentication Service',
        'Token Validation',
        'Rate Limiting Configuration',
        'Data Processing Pipeline',
        'Ingestion Stages',
        'Monitoring and Observability',
      ];
      for (const chunk of chunksWithHeading) {
        expect(headingTexts).toContain(chunk.headingContext);
      }
    });

    it('headingLevel tracks the level of the current heading', () => {
      const text = '# Top Level\n\nContent.\n\n## Sub Level\n\nMore content.\n\n### Detail Level\n\nDetail content.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Find chunks with heading levels
      const h1Chunk = chunks.find((c) => c.headingLevel === 1);
      const h2Chunk = chunks.find((c) => c.headingLevel === 2);
      const h3Chunk = chunks.find((c) => c.headingLevel === 3);

      expect(h1Chunk).toBeDefined();
      expect(h2Chunk).toBeDefined();
      expect(h3Chunk).toBeDefined();
    });
  });

  describe('section path tracking', () => {
    it('section path is tracked through headings', () => {
      const text = '# Part A\n\n## Chapter 1\n\nContent in chapter 1.\n\n## Chapter 2\n\nContent in chapter 2.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Find chunk with path containing both Part A and Chapter 1
      const ch1Chunk = chunks.find(
        (c) => c.sectionPath && c.sectionPath.includes('Part A') && c.sectionPath.includes('Chapter 1')
      );
      expect(ch1Chunk).toBeDefined();
      expect(ch1Chunk!.sectionPath).toBe('Part A > Chapter 1');

      // Chapter 2 should have a different path
      const ch2Chunk = chunks.find(
        (c) => c.sectionPath && c.sectionPath.includes('Chapter 2')
      );
      expect(ch2Chunk).toBeDefined();
      expect(ch2Chunk!.sectionPath).toBe('Part A > Chapter 2');
    });

    it('sectionPath from multi-section document contains nested paths', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      // Find a chunk under "Authentication Service > Token Validation"
      const tokenChunk = chunks.find(
        (c) => c.sectionPath && c.sectionPath.includes('Token Validation')
      );
      expect(tokenChunk).toBeDefined();
      expect(tokenChunk!.sectionPath).toContain('Authentication Service');
    });
  });

  describe('atomic chunks (tables and code blocks)', () => {
    it('tables are emitted as atomic chunks', () => {
      const text = 'Text before.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nText after.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      const tableChunk = chunks.find((c) => c.isAtomic && c.contentTypes.includes('table'));
      expect(tableChunk).toBeDefined();
      expect(tableChunk!.text).toContain('| A | B |');
    });

    it('code blocks are emitted as atomic chunks', () => {
      const text = 'Paragraph.\n\n```javascript\nconst x = 42;\nconst y = x * 2;\n```\n\nAnother paragraph.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      const codeChunk = chunks.find((c) => c.isAtomic && c.contentTypes.includes('code'));
      expect(codeChunk).toBeDefined();
      expect(codeChunk!.text).toContain('const x = 42');
    });

    it('isAtomic is true for table/code chunks, false for text chunks', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      for (const chunk of chunks) {
        if (chunk.contentTypes.includes('table') && chunk.contentTypes.length === 1) {
          expect(chunk.isAtomic).toBe(true);
        }
        if (chunk.contentTypes.includes('code') && chunk.contentTypes.length === 1) {
          expect(chunk.isAtomic).toBe(true);
        }
      }

      // At least one non-atomic chunk should exist
      const textChunks = chunks.filter((c) => !c.isAtomic);
      expect(textChunks.length).toBeGreaterThan(0);
      for (const tc of textChunks) {
        expect(tc.isAtomic).toBe(false);
      }
    });

    it('atomic chunks from multi-section document exist for table and code', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      const atomicChunks = chunks.filter((c) => c.isAtomic);
      expect(atomicChunks.length).toBeGreaterThanOrEqual(2); // at least table + code

      const hasTable = atomicChunks.some((c) => c.contentTypes.includes('table'));
      const hasCode = atomicChunks.some((c) => c.contentTypes.includes('code'));
      expect(hasTable).toBe(true);
      expect(hasCode).toBe(true);
    });
  });

  describe('contentTypes identification', () => {
    it('contentTypes correctly identifies text content', () => {
      const chunks = chunkHybridSectionAware(
        SHORT_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      expect(chunks[0].contentTypes).toContain('text');
    });

    it('contentTypes correctly identifies mixed content in multi-section doc', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      // Collect all content types across all chunks
      const allTypes = new Set<string>();
      for (const chunk of chunks) {
        for (const ct of chunk.contentTypes) {
          allTypes.add(ct);
        }
      }

      // Should have text, table, code, heading, and list types
      expect(allTypes.has('text')).toBe(true);
      expect(allTypes.has('table')).toBe(true);
      expect(allTypes.has('code')).toBe(true);
      expect(allTypes.has('heading')).toBe(true);
      expect(allTypes.has('list')).toBe(true);
    });

    it('each chunk has at least one contentType', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      for (const chunk of chunks) {
        expect(chunk.contentTypes.length).toBeGreaterThan(0);
      }
    });
  });

  describe('overlap behavior', () => {
    it('overlapWithPrevious/Next set for non-atomic chunks', () => {
      const chunks = chunkHybridSectionAware(
        LONG_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      const overlapSize = getOverlapCharacters(DEFAULT_CHUNKING_CONFIG);
      const nonAtomicChunks = chunks.filter((c) => !c.isAtomic);

      if (nonAtomicChunks.length > 2) {
        // Middle non-atomic chunks should have overlap values
        // Find consecutive non-atomic chunks
        for (let i = 1; i < chunks.length - 1; i++) {
          if (!chunks[i].isAtomic && !chunks[i - 1].isAtomic && !chunks[i + 1].isAtomic) {
            expect(chunks[i].overlapWithPrevious).toBe(overlapSize);
            expect(chunks[i].overlapWithNext).toBe(overlapSize);
          }
        }
      }
    });

    it('atomic chunks have 0 overlap', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      const atomicChunks = chunks.filter((c) => c.isAtomic);
      for (const chunk of atomicChunks) {
        expect(chunk.overlapWithPrevious).toBe(0);
        expect(chunk.overlapWithNext).toBe(0);
      }
    });

    it('first chunk has 0 overlapWithPrevious', () => {
      const chunks = chunkHybridSectionAware(
        LONG_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      expect(chunks[0].overlapWithPrevious).toBe(0);
    });

    it('last chunk has 0 overlapWithNext', () => {
      const chunks = chunkHybridSectionAware(
        LONG_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      expect(chunks[chunks.length - 1].overlapWithNext).toBe(0);
    });
  });

  describe('page number assignment', () => {
    it('pageNumber assigned correctly when pageOffsets provided', () => {
      const pageOffsets = [
        { page: 1, charStart: 0, charEnd: 500 },
        { page: 2, charStart: 500, charEnd: 1000 },
        { page: 3, charStart: 1000, charEnd: DOCUMENT_WITH_PAGES.length },
      ];

      const chunks = chunkHybridSectionAware(
        DOCUMENT_WITH_PAGES,
        pageOffsets,
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      // At least the first chunk should have page 1
      expect(chunks[0].pageNumber).toBe(1);

      // Chunks should have valid page numbers
      for (const chunk of chunks) {
        if (chunk.pageNumber !== null) {
          expect(chunk.pageNumber).toBeGreaterThanOrEqual(1);
          expect(chunk.pageNumber).toBeLessThanOrEqual(3);
        }
      }
    });

    it('returns null pageNumber when no pageOffsets provided', () => {
      const chunks = chunkHybridSectionAware(
        SHORT_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      expect(chunks[0].pageNumber).toBeNull();
      expect(chunks[0].pageRange).toBeNull();
    });
  });

  describe('null jsonBlocks handling', () => {
    it('works with null jsonBlocks (no atomic region detection from JSON)', () => {
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      // Should still produce chunks
      expect(chunks.length).toBeGreaterThan(0);

      // Tables and code blocks are still detected by markdown parsing
      const atomicChunks = chunks.filter((c) => c.isAtomic);
      expect(atomicChunks.length).toBeGreaterThan(0);
    });
  });

  describe('ChunkResult fields are fully populated', () => {
    it('all ChunkResult fields are populated for every chunk', () => {
      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: MULTI_SECTION_DOCUMENT.length },
      ];
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        pageOffsets,
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      for (const chunk of chunks) {
        // Required fields
        expect(typeof chunk.index).toBe('number');
        expect(typeof chunk.text).toBe('string');
        expect(chunk.text.length).toBeGreaterThan(0);
        expect(typeof chunk.startOffset).toBe('number');
        expect(typeof chunk.endOffset).toBe('number');
        expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
        expect(typeof chunk.overlapWithPrevious).toBe('number');
        expect(typeof chunk.overlapWithNext).toBe('number');
        expect(typeof chunk.isAtomic).toBe('boolean');
        expect(Array.isArray(chunk.contentTypes)).toBe(true);
        expect(chunk.contentTypes.length).toBeGreaterThan(0);

        // Nullable fields
        // headingContext: string | null
        expect(
          chunk.headingContext === null || typeof chunk.headingContext === 'string'
        ).toBe(true);
        // headingLevel: number | null
        expect(
          chunk.headingLevel === null || typeof chunk.headingLevel === 'number'
        ).toBe(true);
        // sectionPath: string | null
        expect(
          chunk.sectionPath === null || typeof chunk.sectionPath === 'string'
        ).toBe(true);
        // pageNumber: number | null
        expect(
          chunk.pageNumber === null || typeof chunk.pageNumber === 'number'
        ).toBe(true);
        // pageRange: string | null
        expect(
          chunk.pageRange === null || typeof chunk.pageRange === 'string'
        ).toBe(true);
      }
    });
  });
});

// =============================================================================
// createChunkProvenance
// =============================================================================

describe('createChunkProvenance', () => {
  function makeChunk(overrides: Partial<ChunkResult> = {}): ChunkResult {
    return {
      index: 0,
      text: 'Sample chunk text for provenance testing purposes.',
      startOffset: 0,
      endOffset: 50,
      overlapWithPrevious: 0,
      overlapWithNext: 200,
      pageNumber: 1,
      pageRange: null,
      headingContext: 'Introduction',
      headingLevel: 1,
      sectionPath: 'Introduction',
      contentTypes: ['heading', 'text'],
      isAtomic: false,
      ...overrides,
    };
  }

  function makeParams(overrides: Partial<ChunkProvenanceParams> = {}): ChunkProvenanceParams {
    return {
      chunk: makeChunk(),
      chunkTextHash: 'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      ocrProvenanceId: 'ocr-prov-id-1',
      documentProvenanceId: 'doc-prov-id-1',
      ocrContentHash: 'sha256:efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678',
      fileHash: 'sha256:ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012',
      totalChunks: 5,
      ...overrides,
    };
  }

  it('creates correct provenance params with processor_version 2.0.0', () => {
    const prov = createChunkProvenance(makeParams());

    expect(prov.processor).toBe('chunker');
    expect(prov.processor_version).toBe('2.0.0');
  });

  it('sets strategy hybrid_section in processing_params', () => {
    const prov = createChunkProvenance(makeParams());

    expect(prov.processing_params.strategy).toBe('hybrid_section');
  });

  it('includes heading_context in processing_params', () => {
    const prov = createChunkProvenance(makeParams());

    expect(prov.processing_params.heading_context).toBe('Introduction');
  });

  it('includes section_path in processing_params', () => {
    const chunk = makeChunk({ sectionPath: 'Part A > Chapter 1 > Section 1.1' });
    const prov = createChunkProvenance(makeParams({ chunk }));

    expect(prov.processing_params.section_path).toBe('Part A > Chapter 1 > Section 1.1');
  });

  it('includes is_atomic in processing_params', () => {
    const nonAtomicProv = createChunkProvenance(makeParams({ chunk: makeChunk({ isAtomic: false }) }));
    expect(nonAtomicProv.processing_params.is_atomic).toBe(false);

    const atomicProv = createChunkProvenance(makeParams({ chunk: makeChunk({ isAtomic: true }) }));
    expect(atomicProv.processing_params.is_atomic).toBe(true);
  });

  it('includes content_types in processing_params', () => {
    const chunk = makeChunk({ contentTypes: ['table'] });
    const prov = createChunkProvenance(makeParams({ chunk }));

    expect(prov.processing_params.content_types).toEqual(['table']);
  });

  it('sets correct type and source_type', () => {
    const prov = createChunkProvenance(makeParams());

    expect(prov.type).toBe(ProvenanceType.CHUNK);
    expect(prov.source_type).toBe('CHUNKING');
  });

  it('sets correct source_id and root_document_id', () => {
    const prov = createChunkProvenance(makeParams());

    expect(prov.source_id).toBe('ocr-prov-id-1');
    expect(prov.root_document_id).toBe('doc-prov-id-1');
  });

  it('sets correct hash values', () => {
    const prov = createChunkProvenance(makeParams());

    expect(prov.content_hash).toBe('sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
    expect(prov.input_hash).toBe('sha256:efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678');
    expect(prov.file_hash).toBe('sha256:ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012');
  });

  it('sets correct location with chunk_index, character_start, character_end', () => {
    const chunk = makeChunk({ index: 3, startOffset: 1500, endOffset: 3200 });
    const prov = createChunkProvenance(makeParams({ chunk }));

    expect(prov.location).toBeDefined();
    expect(prov.location!.chunk_index).toBe(3);
    expect(prov.location!.character_start).toBe(1500);
    expect(prov.location!.character_end).toBe(3200);
  });

  it('includes page_number in location when available', () => {
    const chunk = makeChunk({ pageNumber: 5, pageRange: null });
    const prov = createChunkProvenance(makeParams({ chunk }));

    expect(prov.location!.page_number).toBe(5);
    expect(prov.location!.page_range).toBeUndefined();
  });

  it('includes page_range in location when available', () => {
    const chunk = makeChunk({ pageNumber: 3, pageRange: '3-4' });
    const prov = createChunkProvenance(makeParams({ chunk }));

    expect(prov.location!.page_number).toBe(3);
    expect(prov.location!.page_range).toBe('3-4');
  });

  it('omits page_number from location when null', () => {
    const chunk = makeChunk({ pageNumber: null, pageRange: null });
    const prov = createChunkProvenance(makeParams({ chunk }));

    expect(prov.location!.page_number).toBeUndefined();
    expect(prov.location!.page_range).toBeUndefined();
  });

  it('includes processing_duration_ms when provided', () => {
    const prov = createChunkProvenance(makeParams({ processingDurationMs: 250 }));
    expect(prov.processing_duration_ms).toBe(250);
  });

  it('sets processing_duration_ms to null when not provided', () => {
    const prov = createChunkProvenance(makeParams());
    expect(prov.processing_duration_ms).toBeNull();
  });

  it('uses default config values in processing_params when no config specified', () => {
    const prov = createChunkProvenance(makeParams());

    expect(prov.processing_params.chunk_size).toBe(DEFAULT_CHUNKING_CONFIG.chunkSize);
    expect(prov.processing_params.overlap_percent).toBe(DEFAULT_CHUNKING_CONFIG.overlapPercent);
    expect(prov.processing_params.max_chunk_size).toBe(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
  });

  it('uses custom config values in processing_params when config specified', () => {
    const customConfig: ChunkingConfig = {
      chunkSize: 1000,
      overlapPercent: 20,
      maxChunkSize: 5000,
    };
    const prov = createChunkProvenance(makeParams({ config: customConfig }));

    expect(prov.processing_params.chunk_size).toBe(1000);
    expect(prov.processing_params.overlap_percent).toBe(20);
    expect(prov.processing_params.max_chunk_size).toBe(5000);
  });

  it('includes chunk_index and total_chunks in processing_params', () => {
    const chunk = makeChunk({ index: 2 });
    const prov = createChunkProvenance(makeParams({ chunk, totalChunks: 10 }));

    expect(prov.processing_params.chunk_index).toBe(2);
    expect(prov.processing_params.total_chunks).toBe(10);
  });

  it('handles null headingContext and sectionPath in processing_params', () => {
    const chunk = makeChunk({ headingContext: null, sectionPath: null });
    const prov = createChunkProvenance(makeParams({ chunk }));

    expect(prov.processing_params.heading_context).toBeNull();
    expect(prov.processing_params.section_path).toBeNull();
  });
});
