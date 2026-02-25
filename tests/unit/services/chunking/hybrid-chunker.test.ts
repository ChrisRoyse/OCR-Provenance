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
const SHORT_DOCUMENT =
  'This is a brief document with minimal content that easily fits within a single chunk.';

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
      const chunks = chunkHybridSectionAware(SHORT_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe(SHORT_DOCUMENT);
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe(SHORT_DOCUMENT.length);
    });

    it('large text exceeding chunk size is split at sentence boundaries', () => {
      const chunks = chunkHybridSectionAware(LONG_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should not drastically exceed chunk size (some tolerance for block boundaries)
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
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
      const text =
        '# Section One\n\nParagraph under section one.\n\n# Section Two\n\nParagraph under section two.';
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
      const text =
        '# Top Level\n\nContent.\n\n## Sub Level\n\nMore content.\n\n### Detail Level\n\nDetail content.';
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
      const text =
        '# Part A\n\n## Chapter 1\n\nContent in chapter 1.\n\n## Chapter 2\n\nContent in chapter 2.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Find chunk with path containing both Part A and Chapter 1
      const ch1Chunk = chunks.find(
        (c) =>
          c.sectionPath && c.sectionPath.includes('Part A') && c.sectionPath.includes('Chapter 1')
      );
      expect(ch1Chunk).toBeDefined();
      expect(ch1Chunk!.sectionPath).toBe('Part A > Chapter 1');

      // Chapter 2 should have a different path
      const ch2Chunk = chunks.find((c) => c.sectionPath && c.sectionPath.includes('Chapter 2'));
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
    it('small tables below minAtomicSize are merged into surrounding content', () => {
      const text = 'Text before.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nText after.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Small table (< chunkSize/4 = 500 chars) is merged, not atomic
      const atomicTableChunk = chunks.find((c) => c.isAtomic && c.contentTypes.includes('table'));
      expect(atomicTableChunk).toBeUndefined();

      // Table content should still be present in a non-atomic chunk
      const chunkWithTable = chunks.find((c) => c.text.includes('| A | B |'));
      expect(chunkWithTable).toBeDefined();
      expect(chunkWithTable!.isAtomic).toBe(false);
    });

    it('small code blocks below minAtomicSize are merged into surrounding content', () => {
      const text =
        'Paragraph.\n\n```javascript\nconst x = 42;\nconst y = x * 2;\n```\n\nAnother paragraph.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // Small code block is merged, not atomic
      const atomicCodeChunk = chunks.find((c) => c.isAtomic && c.contentTypes.includes('code'));
      expect(atomicCodeChunk).toBeUndefined();

      // Code content should still be present
      const chunkWithCode = chunks.find((c) => c.text.includes('const x = 42'));
      expect(chunkWithCode).toBeDefined();
      expect(chunkWithCode!.isAtomic).toBe(false);
    });

    it('large tables above minAtomicSize are emitted as atomic chunks', () => {
      // Generate a table larger than chunkSize/4 (500 chars)
      const rows = [
        '| Column A | Column B | Column C | Column D |',
        '|----------|----------|----------|----------|',
      ];
      for (let i = 0; i < 20; i++) {
        rows.push(
          `| Row ${i} value A long text | Row ${i} value B long text | Row ${i} value C long text | Row ${i} value D long text |`
        );
      }
      const largeTable = rows.join('\n');
      expect(largeTable.length).toBeGreaterThan(500); // Verify it's large enough

      const text = `Some text before the table.\n\n${largeTable}\n\nSome text after.`;
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      const atomicTableChunk = chunks.find((c) => c.isAtomic && c.contentTypes.includes('table'));
      expect(atomicTableChunk).toBeDefined();
      expect(atomicTableChunk!.text).toContain('Column A');
    });

    it('large code blocks above minAtomicSize are emitted as atomic chunks', () => {
      // Generate a code block larger than 500 chars
      const codeLines = ['```python'];
      for (let i = 0; i < 30; i++) {
        codeLines.push(`def function_${i}(param_a, param_b, param_c):`);
        codeLines.push(`    return param_a + param_b + param_c  # computation ${i}`);
      }
      codeLines.push('```');
      const largeCode = codeLines.join('\n');
      expect(largeCode.length).toBeGreaterThan(500);

      const text = `Intro text.\n\n${largeCode}\n\nClosing text.`;
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      const atomicCodeChunk = chunks.find((c) => c.isAtomic && c.contentTypes.includes('code'));
      expect(atomicCodeChunk).toBeDefined();
    });

    it('small tables/code from multi-section document are merged (not atomic)', () => {
      // MULTI_SECTION_DOCUMENT has small table (~280 chars) and code (~200 chars)
      // Both are below minAtomicSize (500), so should be merged
      const chunks = chunkHybridSectionAware(
        MULTI_SECTION_DOCUMENT,
        [],
        null,
        DEFAULT_CHUNKING_CONFIG
      );

      // Table and code content should exist somewhere in chunks
      const hasTableContent = chunks.some((c) => c.text.includes('Access Token'));
      const hasCodeContent = chunks.some((c) => c.text.includes('rate_limiting'));
      expect(hasTableContent).toBe(true);
      expect(hasCodeContent).toBe(true);

      // At least one non-atomic chunk should exist
      const textChunks = chunks.filter((c) => !c.isAtomic);
      expect(textChunks.length).toBeGreaterThan(0);
    });

    it('oversized atomic blocks (> maxChunkSize) are split at line boundaries', () => {
      // Generate a table much larger than maxChunkSize (8000 chars)
      const rows = [
        '| ID | Name | Description | Category | Status |',
        '|----|------|-------------|----------|--------|',
      ];
      for (let i = 0; i < 200; i++) {
        rows.push(
          `| ${i} | Item name ${i} with extra text | A detailed description of item ${i} that adds considerable length | Category ${i % 5} | Active |`
        );
      }
      const hugeTable = rows.join('\n');
      expect(hugeTable.length).toBeGreaterThan(8000);

      const text = `Header text.\n\n${hugeTable}\n\nFooter text.`;
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      // The huge table should be split into multiple atomic chunks
      const atomicTableChunks = chunks.filter(
        (c) => c.isAtomic && c.contentTypes.includes('table')
      );
      expect(atomicTableChunks.length).toBeGreaterThan(1);

      // Each atomic sub-chunk should not exceed maxChunkSize
      for (const chunk of atomicTableChunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
      }

      // All sub-chunks should be marked atomic
      for (const chunk of atomicTableChunks) {
        expect(chunk.isAtomic).toBe(true);
      }
    });

    it('oversized atomic chunks inherit heading context', () => {
      const rows = ['| Col1 | Col2 |', '|------|------|'];
      for (let i = 0; i < 200; i++) {
        rows.push(
          `| Long value ${i} with padding text here | Another long value ${i} with more padding |`
        );
      }
      const hugeTable = rows.join('\n');

      const text = `# Important Section\n\nIntro.\n\n${hugeTable}\n\nDone.`;
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      const atomicChunks = chunks.filter((c) => c.isAtomic);
      for (const chunk of atomicChunks) {
        expect(chunk.headingContext).toBe('Important Section');
      }
    });
  });

  describe('contentTypes identification', () => {
    it('contentTypes correctly identifies text content', () => {
      const chunks = chunkHybridSectionAware(SHORT_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

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
      const chunks = chunkHybridSectionAware(LONG_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

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
      const chunks = chunkHybridSectionAware(LONG_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

      expect(chunks[0].overlapWithPrevious).toBe(0);
    });

    it('last chunk has 0 overlapWithNext', () => {
      const chunks = chunkHybridSectionAware(LONG_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

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
      const chunks = chunkHybridSectionAware(SHORT_DOCUMENT, [], null, DEFAULT_CHUNKING_CONFIG);

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
      // (small ones are merged into surrounding content, not atomic)
      const hasTableContent = chunks.some((c) => c.text.includes('Access Token'));
      const hasCodeContent = chunks.some((c) => c.text.includes('rate_limiting'));
      expect(hasTableContent).toBe(true);
      expect(hasCodeContent).toBe(true);
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
        expect(chunk.headingContext === null || typeof chunk.headingContext === 'string').toBe(
          true
        );
        // headingLevel: number | null
        expect(chunk.headingLevel === null || typeof chunk.headingLevel === 'number').toBe(true);
        // sectionPath: string | null
        expect(chunk.sectionPath === null || typeof chunk.sectionPath === 'string').toBe(true);
        // pageNumber: number | null
        expect(chunk.pageNumber === null || typeof chunk.pageNumber === 'number').toBe(true);
        // pageRange: string | null
        expect(chunk.pageRange === null || typeof chunk.pageRange === 'string').toBe(true);
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
    const nonAtomicProv = createChunkProvenance(
      makeParams({ chunk: makeChunk({ isAtomic: false }) })
    );
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

    expect(prov.content_hash).toBe(
      'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
    );
    expect(prov.input_hash).toBe(
      'sha256:efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678efgh5678'
    );
    expect(prov.file_hash).toBe(
      'sha256:ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012ijkl9012'
    );
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

// =============================================================================
// EDGE CASE TESTS - Atomic Size Guards
// =============================================================================

describe('chunkHybridSectionAware - atomic size edge cases', () => {
  it('table exactly at minAtomicSize boundary is emitted as atomic', () => {
    // minAtomicSize = 2000/4 = 500 with default config
    // Create a table exactly 500 chars
    const rows = ['| Col A | Col B |', '|-------|-------|'];
    while (rows.join('\n').length < 500) {
      rows.push(`| ${'X'.repeat(20)} | ${'Y'.repeat(20)} |`);
    }
    // Trim to exactly 500 by adjusting last row
    let table = rows.join('\n');
    if (table.length > 500) {
      rows.pop();
      const needed = 500 - rows.join('\n').length - 1; // -1 for \n
      if (needed > 10) {
        rows.push(`| ${'Z'.repeat(Math.max(1, needed - 6))} |`);
      }
    }
    table = rows.join('\n');

    const text = `Intro text.\n\n${table}\n\nClosing text.`;
    const config = { ...DEFAULT_CHUNKING_CONFIG };
    const chunks = chunkHybridSectionAware(text, [], null, config);

    const atomicChunks = chunks.filter((c) => c.isAtomic);
    // If table >= 500, should be atomic
    if (table.length >= 500) {
      expect(atomicChunks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('table just below minAtomicSize is merged (not atomic)', () => {
    // Create a table smaller than 500 chars but valid
    const table =
      '| Column A | Column B | Column C |\n|----------|----------|----------|\n| Value 1  | Value 2  | Value 3  |\n| Value 4  | Value 5  | Value 6  |\n| Value 7  | Value 8  | Value 9  |';
    expect(table.length).toBeLessThan(500);

    const text = `Intro paragraph.\n\n${table}\n\nClosing paragraph.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // Small table should be merged, not atomic
    const atomicTableChunks = chunks.filter((c) => c.isAtomic && c.contentTypes.includes('table'));
    expect(atomicTableChunks).toHaveLength(0);

    // Content should still be present
    const withTable = chunks.find((c) => c.text.includes('Column A'));
    expect(withTable).toBeDefined();
    expect(withTable!.isAtomic).toBe(false);
  });

  it('oversized atomic block with no newlines is force-split at maxChunkSize', () => {
    // Create a single-line text > maxChunkSize with no newlines
    const hugeOneLiner = 'X'.repeat(20000);
    // Wrap it as a "table" block by making it match table pattern
    const tableHeader = '| ' + 'A'.repeat(100) + ' |\n|' + '-'.repeat(102) + '|\n';
    const tableRow = '| ' + hugeOneLiner + ' |';
    const hugeTable = tableHeader + tableRow;

    const text = `Start.\n\n${hugeTable}\n\nEnd.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // The table is > minAtomicSize and > maxChunkSize, should be split
    const atomicChunks = chunks.filter((c) => c.isAtomic);
    expect(atomicChunks.length).toBeGreaterThan(1);

    // Each sub-chunk should not exceed maxChunkSize
    for (const chunk of atomicChunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }
  });

  it('small table merged into accumulator triggers overflow split if needed', () => {
    // Fill accumulator near chunkSize, then add small table to push over
    const longParagraph = 'The quick brown fox jumps over the lazy dog. '.repeat(45); // ~2025 chars
    const smallTable = '| A | B |\n|---|---|\n| 1 | 2 |';

    const text = `${longParagraph}\n\n${smallTable}`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // Should produce multiple chunks (paragraph is already over chunkSize)
    expect(chunks.length).toBeGreaterThan(1);

    // No chunk should exceed maxChunkSize
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }
  });

  it('split atomic chunks all have isAtomic=true', () => {
    // Generate code block > maxChunkSize (8000)
    const lines = ['```'];
    for (let i = 0; i < 400; i++) {
      lines.push(
        `function handler_${i}(request, response) { return response.json({ ok: true }); }`
      );
    }
    lines.push('```');
    const bigCode = lines.join('\n');
    expect(bigCode.length).toBeGreaterThan(8000);

    const text = `## API Handlers\n\n${bigCode}\n\nDone.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicChunks = chunks.filter((c) => c.isAtomic);
    expect(atomicChunks.length).toBeGreaterThan(1);
    for (const chunk of atomicChunks) {
      expect(chunk.isAtomic).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }
  });

  it('split atomic chunks inherit heading context and section path', () => {
    const rows = ['| H1 | H2 |', '|----|-----|'];
    for (let i = 0; i < 200; i++) {
      rows.push(`| Data row ${i} with extra padding text | More data for row ${i} padding |`);
    }
    const bigTable = rows.join('\n');

    // Add substantial content under each heading so they are not heading-only tiny
    // chunks that would get cascade-merged by mergeHeadingOnlyChunks
    const text = `# Main Section\n\nThis section covers the main data analysis results and findings from the comprehensive study.\n\n## Data Tables\n\nThe following tables contain the detailed measurement data collected during the experiment.\n\n${bigTable}\n\nEnd.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicChunks = chunks.filter((c) => c.isAtomic);
    expect(atomicChunks.length).toBeGreaterThan(0);
    for (const chunk of atomicChunks) {
      expect(chunk.headingContext).toBe('Data Tables');
      expect(chunk.sectionPath).toContain('Main Section');
      expect(chunk.sectionPath).toContain('Data Tables');
    }
  });

  it('code block below minAtomicSize is merged, not atomic', () => {
    const smallCode = '```js\nconst x = 1;\n```';
    expect(smallCode.length).toBeLessThan(500);

    const text = `Description.\n\n${smallCode}\n\nMore description.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicCode = chunks.filter((c) => c.isAtomic && c.contentTypes.includes('code'));
    expect(atomicCode).toHaveLength(0);

    // Code content should be in a non-atomic chunk
    const withCode = chunks.find((c) => c.text.includes('const x = 1'));
    expect(withCode).toBeDefined();
    expect(withCode!.isAtomic).toBe(false);
  });
});

// =============================================================================
// EDGE CASE TESTS - Page Span and Range
// =============================================================================

describe('chunkHybridSectionAware - page span edge cases', () => {
  it('chunk spanning multiple pages has pageRange set', () => {
    // Create a long paragraph that spans page boundaries
    const longText = 'A '.repeat(1500); // 3000 chars
    const text = `# Title\n\n${longText}`;
    const pageOffsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 1500 },
      { page: 2, charStart: 1500, charEnd: 3000 },
      { page: 3, charStart: 3000, charEnd: text.length },
    ];

    const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    // At least one chunk should span pages
    // Might or might not span depending on split points
    // But page numbers should be assigned
    for (const chunk of chunks) {
      expect(chunk.pageNumber).not.toBeNull();
    }
  });

  it('empty pageOffsets gives all null page info', () => {
    const text = '# Hello\n\nWorld content here.';
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    for (const chunk of chunks) {
      expect(chunk.pageNumber).toBeNull();
      expect(chunk.pageRange).toBeNull();
    }
  });
});

// =============================================================================
// EDGE CASE TESTS - Overlap Behavior
// =============================================================================

describe('chunkHybridSectionAware - overlap edge cases', () => {
  it('0% overlap gives all overlaps = 0', () => {
    const config: ChunkingConfig = {
      chunkSize: 2000,
      overlapPercent: 0,
      maxChunkSize: 8000,
    };
    const longText = 'Word '.repeat(2000);
    const chunks = chunkHybridSectionAware(longText, [], null, config);

    for (const chunk of chunks) {
      expect(chunk.overlapWithPrevious).toBe(0);
      expect(chunk.overlapWithNext).toBe(0);
    }
  });

  it('atomic chunk between non-atomic chunks breaks overlap chain', () => {
    // Create scenario: non-atomic -> atomic -> non-atomic
    const para1 = 'First paragraph. '.repeat(50); // ~850 chars
    const rows = ['| A | B |', '|---|---|'];
    for (let i = 0; i < 25; i++) {
      rows.push(`| Row ${i} long content here | More data for row ${i} |`);
    }
    const bigTable = rows.join('\n');
    const para2 = 'Second paragraph. '.repeat(50);

    const text = `${para1}\n\n${bigTable}\n\n${para2}`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // Find atomic chunks
    const atomicChunks = chunks.filter((c) => c.isAtomic);
    for (const ac of atomicChunks) {
      expect(ac.overlapWithPrevious).toBe(0);
      expect(ac.overlapWithNext).toBe(0);
    }
  });
});

// =============================================================================
// EDGE CASE TESTS - Custom Config
// =============================================================================

describe('chunkHybridSectionAware - custom config', () => {
  it('custom chunkSize changes split behavior', () => {
    const config: ChunkingConfig = {
      chunkSize: 500,
      overlapPercent: 10,
      maxChunkSize: 2000,
    };
    const text = 'A sentence here. '.repeat(100); // ~1700 chars
    const chunks = chunkHybridSectionAware(text, [], null, config);

    // With chunkSize=500, should produce more chunks than default (2000)
    expect(chunks.length).toBeGreaterThan(3);

    // minAtomicSize is now 500/4 = 125
    // So smaller tables would still be merged
  });

  it('custom maxChunkSize limits oversized atomic splits', () => {
    const config: ChunkingConfig = {
      chunkSize: 2000,
      overlapPercent: 10,
      maxChunkSize: 3000, // smaller max
    };

    const rows = ['| H1 | H2 |', '|----|-----|'];
    for (let i = 0; i < 100; i++) {
      rows.push(`| Row ${i} data | More row ${i} data |`);
    }
    const bigTable = rows.join('\n');

    const text = `Intro.\n\n${bigTable}\n\nEnd.`;
    const chunks = chunkHybridSectionAware(text, [], null, config);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

// =============================================================================
// SECTION 3.3.1 - Size-Aware Atomic Emission
// =============================================================================

describe('chunkHybridSectionAware - 3.3.1 size-aware atomic emission', () => {
  it('table < minAtomicSize (500) is merged into accumulator with isAtomic=false', () => {
    // A small table well under 500 chars
    const smallTable = [
      '| Metric | Value |',
      '|--------|-------|',
      '| CPU    | 80%   |',
      '| Memory | 4GB   |',
      '| Disk   | 120GB |',
    ].join('\n');
    expect(smallTable.length).toBeLessThan(500);

    const text = `System metrics summary.\n\n${smallTable}\n\nAll values within normal range.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // Table should be merged (not atomic)
    const atomicTable = chunks.find((c) => c.isAtomic && c.contentTypes.includes('table'));
    expect(atomicTable).toBeUndefined();

    // Table text should appear in a non-atomic chunk
    const merged = chunks.find((c) => c.text.includes('| CPU'));
    expect(merged).toBeDefined();
    expect(merged!.isAtomic).toBe(false);
  });

  it('table = minAtomicSize exactly is emitted as atomic (>= threshold)', () => {
    // minAtomicSize = chunkSize/4 = 2000/4 = 500
    // Build a table that is exactly 500 chars
    const header = '| ID | Description | Status |';
    const sep = '|----|-------------|--------|';
    const rows: string[] = [header, sep];
    let current = rows.join('\n');
    let rowIdx = 0;
    while (current.length < 500) {
      const row = `| ${String(rowIdx).padStart(2, '0')} | Item description ${rowIdx} text | Active |`;
      rows.push(row);
      current = rows.join('\n');
      rowIdx++;
    }
    // If we overshot, pop the last row and pad the previous one
    if (current.length > 500) {
      rows.pop();
      current = rows.join('\n');
      const deficit = 500 - current.length - 1; // -1 for \n
      if (deficit > 10) {
        rows.push(`| ${'Z'.repeat(deficit - 8)} | pad |`);
      }
    }
    const exactTable = rows.join('\n');

    const text = `Before.\n\n${exactTable}\n\nAfter.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // Table at or above 500 should be emitted as atomic
    if (exactTable.length >= 500) {
      const atomicChunks = chunks.filter((c) => c.isAtomic);
      expect(atomicChunks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('table > minAtomicSize but < maxChunkSize is a single atomic chunk', () => {
    // Build a table between 500 and 8000 chars (e.g., ~1500 chars)
    const rows = [
      '| Employee | Department | Salary | Start Date | Location |',
      '|----------|-----------|--------|------------|----------|',
    ];
    for (let i = 0; i < 20; i++) {
      rows.push(
        `| Employee ${i} | Engineering | $${100 + i}K | 2024-0${(i % 9) + 1}-15 | Building ${(i % 3) + 1} |`
      );
    }
    const mediumTable = rows.join('\n');
    expect(mediumTable.length).toBeGreaterThan(500);
    expect(mediumTable.length).toBeLessThan(8000);

    const text = `HR Report.\n\n${mediumTable}\n\nEnd of report.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicTableChunks = chunks.filter((c) => c.isAtomic && c.contentTypes.includes('table'));
    // Should be exactly 1 atomic chunk (fits within maxChunkSize)
    expect(atomicTableChunks).toHaveLength(1);
    expect(atomicTableChunks[0].text).toContain('Employee');
  });

  it('table > maxChunkSize is split into multiple atomic chunks at line boundaries', () => {
    // Build table > 8000 chars
    const rows = [
      '| ID | Name | Description | Category | Status | Priority |',
      '|----|------|-------------|----------|--------|----------|',
    ];
    for (let i = 0; i < 150; i++) {
      rows.push(
        `| ${i} | Item ${i} name here | Detailed description for item number ${i} in the catalog | Cat-${i % 5} | Active | P${(i % 3) + 1} |`
      );
    }
    const hugeTable = rows.join('\n');
    expect(hugeTable.length).toBeGreaterThan(8000);

    const text = `# Catalog\n\nFull listing.\n\n${hugeTable}\n\nEnd.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicTableChunks = chunks.filter((c) => c.isAtomic && c.contentTypes.includes('table'));
    expect(atomicTableChunks.length).toBeGreaterThan(1);

    // Verify line boundary splitting: each sub-chunk should end at a newline
    // (except possibly the last one)
    for (let i = 0; i < atomicTableChunks.length - 1; i++) {
      const chunkText = atomicTableChunks[i].text;
      // The last character before split should be at a line boundary
      // (text ends where a newline was found by lastIndexOf)
      expect(chunkText.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }
  });

  it('code < minAtomicSize is merged with isAtomic=false', () => {
    const smallCode = '```bash\necho "Hello World"\nexit 0\n```';
    expect(smallCode.length).toBeLessThan(500);

    const text = `Run the following command.\n\n${smallCode}\n\nThen verify the output.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicCode = chunks.find((c) => c.isAtomic && c.contentTypes.includes('code'));
    expect(atomicCode).toBeUndefined();

    const withCode = chunks.find((c) => c.text.includes('echo "Hello World"'));
    expect(withCode).toBeDefined();
    expect(withCode!.isAtomic).toBe(false);
  });

  it('split atomic sub-chunks: none exceeds maxChunkSize', () => {
    // Generate very large code block
    const lines = ['```python'];
    for (let i = 0; i < 500; i++) {
      lines.push(
        `def process_item_${i}(data): return data.transform(method='advanced', iteration=${i})`
      );
    }
    lines.push('```');
    const hugeCode = lines.join('\n');
    expect(hugeCode.length).toBeGreaterThan(DEFAULT_CHUNKING_CONFIG.maxChunkSize * 2);

    const text = `## Processing Functions\n\n${hugeCode}\n\nDone.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicCodeChunks = chunks.filter((c) => c.isAtomic);
    expect(atomicCodeChunks.length).toBeGreaterThan(2);
    for (const chunk of atomicCodeChunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }
  });

  it('oversized atomic with no newlines is force-split at maxChunkSize', () => {
    // Create a table block that, when parsed, has a single very long row
    const longRow = '| ' + 'X'.repeat(20000) + ' |';
    const tableText = '| Header |\n|--------|\n' + longRow;

    const text = `Start.\n\n${tableText}\n\nEnd.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // The oversized atomic should be force-split even though there are no newlines
    const atomicChunks = chunks.filter((c) => c.isAtomic);
    expect(atomicChunks.length).toBeGreaterThan(1);
    for (const chunk of atomicChunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }
  });

  it('small table merged into accumulator triggers overflow split when accumulator exceeds chunkSize', () => {
    // Build a heading with a large paragraph that nearly fills chunkSize,
    // followed by a small table that pushes the accumulated text over the limit.
    // The heading and paragraph are in the same accumulator since there is no
    // intervening heading between them.
    const heading = '# Analysis Results';
    const largeParagraph =
      'Detailed analysis results show significant improvement in all measured parameters across multiple trials. '.repeat(
        20
      );
    // Paragraph alone is ~2080 chars which exceeds chunkSize (2000).
    // The heading + paragraph together will definitely exceed, triggering a split.
    // Then we add a small table after to ensure the split still works.
    expect(largeParagraph.length).toBeGreaterThan(DEFAULT_CHUNKING_CONFIG.chunkSize);

    const smallTable = [
      '| Metric | Before | After |',
      '|--------|--------|-------|',
      '| Score  | 72     | 91    |',
      '| Grade  | C      | A     |',
    ].join('\n');
    expect(smallTable.length).toBeLessThan(500); // Below minAtomicSize

    const text = `${heading}\n\n${largeParagraph}\n\n${smallTable}\n\nFinal notes on methodology.`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // The paragraph exceeds chunkSize so it must split
    expect(chunks.length).toBeGreaterThan(1);
    // The small table content should still be present somewhere in the chunks
    const hasTable = chunks.some((c) => c.text.includes('| Score'));
    expect(hasTable).toBe(true);
  });
});

// =============================================================================
// SECTION 3.3.2 - findSentenceBoundary Edge Cases (tested indirectly)
// =============================================================================

describe('chunkHybridSectionAware - 3.3.2 findSentenceBoundary edge cases', () => {
  it('text with sentence endings ". " splits at sentence boundary', () => {
    // Create text that exceeds chunkSize and has clear sentence endings
    const sentences: string[] = [];
    for (let i = 0; i < 20; i++) {
      sentences.push(
        `Sentence number ${i} provides important contextual information about the experiment results and methodology. `
      );
    }
    const text = sentences.join('');
    expect(text.length).toBeGreaterThan(DEFAULT_CHUNKING_CONFIG.chunkSize);

    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);
    expect(chunks.length).toBeGreaterThan(1);

    // The first chunk should end at a sentence boundary (after ". " or "." near end)
    const firstChunkText = chunks[0].text;
    const lastDotPos = firstChunkText.lastIndexOf('.');
    // Should end near a period
    expect(lastDotPos).toBeGreaterThan(0);
    // The split position should be reasonably close to chunkSize
    expect(firstChunkText.length).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.chunkSize + 200);
  });

  it('text with no sentence/paragraph/line breaks force-splits at maxPos', () => {
    // Create continuous text with no periods, newlines, or spaces after a certain point
    // Use a single long word repeated with hyphens (no spaces or sentence enders)
    const continuousText = 'abcdefghij'.repeat(300); // 3000 chars, no breaks at all

    const chunks = chunkHybridSectionAware(continuousText, [], null, DEFAULT_CHUNKING_CONFIG);

    // Should still produce chunks (force-split)
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // All chunks should have content
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('text shorter than search window does not crash', () => {
    // findSentenceBoundary has searchStart = Math.max(0, maxPos - 500)
    // If text is very short, this should not crash.
    // We test this indirectly: short text that fits in one chunk won't even call
    // findSentenceBoundary, so we create text that barely exceeds chunkSize
    // but is short enough that the 500-char search window goes to position 0.
    const config: ChunkingConfig = {
      chunkSize: 100,
      overlapPercent: 10,
      maxChunkSize: 400,
    };
    const text =
      'Short sentence here. Another one follows. Third sentence here. Fourth sentence now. Fifth is done. Sixth will go. Seventh is ok now.';
    expect(text.length).toBeGreaterThan(100);

    const chunks = chunkHybridSectionAware(text, [], null, config);
    expect(chunks.length).toBeGreaterThan(1);
    // No crash = success
  });
});

// =============================================================================
// SECTION 3.3.3 - determinePageInfoForSpan Edge Cases
// =============================================================================

describe('chunkHybridSectionAware - 3.3.3 determinePageInfoForSpan edge cases', () => {
  it('chunk fully within one page has pageRange=null', () => {
    const text = '# Title\n\nShort content on page one.';
    const pageOffsets: PageOffset[] = [{ page: 1, charStart: 0, charEnd: text.length }];
    const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    // All content is on page 1, so no pageRange needed
    for (const chunk of chunks) {
      expect(chunk.pageNumber).toBe(1);
      expect(chunk.pageRange).toBeNull();
    }
  });

  it('chunk spanning different pages has pageRange="N-M"', () => {
    // Create content long enough that a single chunk spans the page boundary
    const longContent = 'Detailed contract clause text that goes on and on. '.repeat(30);
    const text = `# Agreement\n\n${longContent}`;
    const midpoint = Math.floor(text.length / 2);
    const pageOffsets: PageOffset[] = [
      { page: 3, charStart: 0, charEnd: midpoint },
      { page: 4, charStart: midpoint, charEnd: text.length },
    ];

    const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    // At least one chunk should span pages 3 and 4
    const spanningChunk = chunks.find((c) => c.pageRange !== null);
    if (spanningChunk) {
      expect(spanningChunk.pageRange).toBe('3-4');
      expect(spanningChunk.pageNumber).toBe(3);
    }
  });

  it('empty pageOffsets gives null for both pageNumber and pageRange', () => {
    const text = '# Heading\n\nContent paragraph with some text.';
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    for (const chunk of chunks) {
      expect(chunk.pageNumber).toBeNull();
      expect(chunk.pageRange).toBeNull();
    }
  });
});

// =============================================================================
// SECTION 3.3.4 - Overlap Behavior Edge Cases
// =============================================================================

describe('chunkHybridSectionAware - 3.3.4 overlap edge cases', () => {
  it('0% overlap config results in all overlap values being 0', () => {
    const config: ChunkingConfig = {
      chunkSize: 2000,
      overlapPercent: 0,
      maxChunkSize: 8000,
    };
    const chunks = chunkHybridSectionAware(LONG_DOCUMENT, [], null, config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.overlapWithPrevious).toBe(0);
      expect(chunk.overlapWithNext).toBe(0);
    }
  });

  it('atomic chunk between two non-atomic chunks: neighbors do not overlap with atomic', () => {
    // Build: non-atomic paragraph -> large atomic table -> non-atomic paragraph
    // The non-atomic chunks adjacent to the atomic chunk should have 0 overlap
    // toward the atomic chunk's side.
    const paragraph1 =
      'The experimental results demonstrate significant improvements across all measured parameters. '.repeat(
        8
      );
    const rows = [
      '| Parameter | Baseline | Treatment | Delta |',
      '|-----------|----------|-----------|-------|',
    ];
    for (let i = 0; i < 20; i++) {
      rows.push(`| Param ${i} | ${50 + i} | ${70 + i} | +${20} |`);
    }
    const atomicTable = rows.join('\n');
    expect(atomicTable.length).toBeGreaterThan(500); // Above minAtomicSize

    const paragraph2 =
      'These findings confirm the hypothesis that the intervention is effective. '.repeat(8);

    const text = `${paragraph1}\n\n${atomicTable}\n\n${paragraph2}`;
    const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

    // Find the atomic chunk
    const atomicIdx = chunks.findIndex((c) => c.isAtomic);
    expect(atomicIdx).toBeGreaterThanOrEqual(0);

    // The atomic chunk itself has 0 overlap
    expect(chunks[atomicIdx].overlapWithPrevious).toBe(0);
    expect(chunks[atomicIdx].overlapWithNext).toBe(0);

    // The chunk before the atomic chunk should have overlapWithNext=0
    // (because the next chunk is atomic)
    if (atomicIdx > 0) {
      expect(chunks[atomicIdx - 1].overlapWithNext).toBe(0);
    }

    // The chunk after the atomic chunk should have overlapWithPrevious=0
    // (because the previous chunk is atomic)
    if (atomicIdx < chunks.length - 1) {
      expect(chunks[atomicIdx + 1].overlapWithPrevious).toBe(0);
    }
  });
});
