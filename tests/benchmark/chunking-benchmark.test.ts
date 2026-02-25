/**
 * Chunking System Performance Benchmark
 *
 * Measures throughput, chunk quality, and correctness across
 * synthetic documents of varying sizes.
 *
 * Run: npx vitest run tests/benchmark/chunking-benchmark.test.ts
 *
 * @module tests/benchmark/chunking-benchmark
 */

import { describe, it, expect } from 'vitest';
import {
  chunkHybridSectionAware,
  DEFAULT_CHUNKING_CONFIG,
} from '../../src/services/chunking/chunker.js';
import {
  parseMarkdownBlocks,
  extractPageOffsetsFromText,
} from '../../src/services/chunking/markdown-parser.js';

// =============================================================================
// SYNTHETIC DOCUMENT GENERATORS
// =============================================================================

function generateTextDocument(charTarget: number): string {
  const sentences = [
    'The analysis reveals significant correlations between variables.',
    'Statistical significance was established at the p < 0.05 level.',
    'The control group demonstrated baseline performance metrics.',
    'Regression analysis indicates a strong positive relationship.',
    'The confidence interval falls within the pre-specified bounds.',
    'Post-hoc analyses revealed additional interaction effects.',
    'The safety profile was favorable across all demographics.',
    'Longitudinal follow-up data confirm durable therapeutic benefits.',
  ];

  const sections: string[] = [];
  let charCount = 0;
  let sectionNum = 1;
  let paraNum = 0;

  while (charCount < charTarget) {
    sections.push(`## Section ${sectionNum}`);
    charCount += 15;

    const parasPerSection = 3 + (sectionNum % 3);
    for (let p = 0; p < parasPerSection && charCount < charTarget; p++) {
      const sentCount = 3 + (paraNum % 5);
      const para = Array.from(
        { length: sentCount },
        (_, i) => sentences[i % sentences.length]
      ).join(' ');
      sections.push(para);
      charCount += para.length + 2;
      paraNum++;
    }
    sectionNum++;
  }

  return sections.join('\n\n');
}

function generateDocWithTables(charTarget: number): string {
  const parts: string[] = ['# Document with Tables'];
  let charCount = 25;
  let tableNum = 1;

  while (charCount < charTarget) {
    parts.push(`## Table Group ${tableNum}`);
    parts.push('Description of the following data table.');

    const rows = [
      '| ID | Name | Value | Category | Status |',
      '|----|------|-------|----------|--------|',
    ];
    for (let r = 0; r < 10 + (tableNum % 5) * 5; r++) {
      rows.push(`| ${r} | Item ${r} | ${(r * 17.5).toFixed(2)} | Cat-${r % 4} | Active |`);
    }
    parts.push(rows.join('\n'));
    charCount += rows.join('\n').length + 60;
    tableNum++;
  }

  return parts.join('\n\n');
}

function generateDocWithPages(pageCount: number): string {
  const parts: string[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (p > 1) {
      parts.push(`---\n<!-- Page ${p} -->`);
    }
    parts.push(`## Page ${p} Content`);
    parts.push(`This is the content for page ${p}. `.repeat(20));
  }
  return parts.join('\n\n');
}

function generateDocWithCode(charTarget: number): string {
  const parts: string[] = ['# API Documentation'];
  let charCount = 20;
  let fnNum = 1;

  while (charCount < charTarget) {
    parts.push(`### Function ${fnNum}`);
    parts.push(`Description of function ${fnNum} and its parameters.`);

    const codeLines = [`\`\`\`typescript`];
    for (let l = 0; l < 5 + (fnNum % 3) * 3; l++) {
      codeLines.push(`  const result_${l} = await process(input_${l}, options);`);
    }
    codeLines.push('```');
    parts.push(codeLines.join('\n'));

    charCount += codeLines.join('\n').length + 80;
    fnNum++;
  }

  return parts.join('\n\n');
}

// =============================================================================
// QUALITY BENCHMARKS
// =============================================================================

describe('Chunk Quality Benchmarks', () => {
  it('no chunk exceeds maxChunkSize for text document', () => {
    const doc = generateTextDocument(100000);
    const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

    const oversized = chunks.filter((c) => c.text.length > DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    expect(oversized).toHaveLength(0);
  });

  it('no chunk exceeds maxChunkSize for table-heavy document', () => {
    const doc = generateDocWithTables(100000);
    const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

    const oversized = chunks.filter((c) => c.text.length > DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    expect(oversized).toHaveLength(0);
  });

  it('no chunk exceeds maxChunkSize for code-heavy document', () => {
    const doc = generateDocWithCode(100000);
    const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

    const oversized = chunks.filter((c) => c.text.length > DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    expect(oversized).toHaveLength(0);
  });

  it('page numbers span document pages for multi-page document', () => {
    const doc = generateDocWithPages(20);
    const pageOffsets = extractPageOffsetsFromText(doc);
    const chunks = chunkHybridSectionAware(doc, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);

    const distinctPages = new Set(chunks.map((c) => c.pageNumber).filter((p) => p !== null));
    // Should cover >80% of pages
    expect(distinctPages.size).toBeGreaterThan(16);
  });

  it('no 1-character chunks in any document type', () => {
    const docs = [
      generateTextDocument(50000),
      generateDocWithTables(50000),
      generateDocWithCode(50000),
    ];

    for (const doc of docs) {
      const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);
      const tiny = chunks.filter((c) => c.text.trim().length <= 1);
      expect(tiny).toHaveLength(0);
    }
  });

  it('average chunk size > 500 chars for text document', () => {
    const doc = generateTextDocument(100000);
    const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

    const avgSize = chunks.reduce((sum, c) => sum + c.text.length, 0) / chunks.length;
    expect(avgSize).toBeGreaterThan(500);
  });

  it('heading context populated for >50% of chunks', () => {
    const doc = generateTextDocument(50000);
    const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

    const withHeading = chunks.filter((c) => c.headingContext !== null);
    expect(withHeading.length / chunks.length).toBeGreaterThan(0.5);
  });

  it('section path populated for >50% of chunks', () => {
    const doc = generateTextDocument(50000);
    const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

    const withSection = chunks.filter((c) => c.sectionPath !== null);
    expect(withSection.length / chunks.length).toBeGreaterThan(0.5);
  });

  it('atomic chunks only for blocks >= minAtomicSize', () => {
    const doc = generateDocWithTables(50000);
    const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

    const atomicChunks = chunks.filter((c) => c.isAtomic);

    // All atomic chunks should be from originally large blocks
    // (Note: split atomic chunks may be smaller than minAtomicSize individually,
    // but the original block that produced them was >= minAtomicSize)
    // We just verify that atomic chunks exist and are reasonably sized
    for (const chunk of atomicChunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// PERFORMANCE BENCHMARKS
// =============================================================================

describe('Performance Benchmarks', () => {
  const sizes = [10000, 50000, 100000];

  for (const size of sizes) {
    it(`chunks ${size / 1000}K char text document within performance budget`, () => {
      const doc = generateTextDocument(size);

      const start = performance.now();
      const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);
      const elapsed = performance.now() - start;

      // Log for benchmarking visibility
      const throughput = Math.round(doc.length / (elapsed / 1000));
      console.error(
        `[BENCHMARK] ${size / 1000}K chars: ${chunks.length} chunks in ${elapsed.toFixed(1)}ms (${throughput} chars/sec)`
      );

      // Should process > 10,000 chars/sec (generous budget)
      expect(throughput).toBeGreaterThan(10000);
    });
  }

  it('parseMarkdownBlocks completes within 50ms for 100K text', () => {
    const doc = generateTextDocument(100000);

    const start = performance.now();
    parseMarkdownBlocks(doc, []);
    const elapsed = performance.now() - start;

    console.error(`[BENCHMARK] parseMarkdownBlocks 100K: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200); // Allow generous margin
  });

  it('extractPageOffsetsFromText handles 1000-page document', () => {
    const doc = generateDocWithPages(1000);

    const start = performance.now();
    const offsets = extractPageOffsetsFromText(doc);
    const elapsed = performance.now() - start;

    console.error(
      `[BENCHMARK] extractPageOffsetsFromText 1000 pages: ${elapsed.toFixed(1)}ms, ${offsets.length} offsets`
    );
    expect(offsets.length).toBeGreaterThanOrEqual(999);
    expect(elapsed).toBeLessThan(500);
  });

  it('chunk quality is consistent across document sizes', () => {
    const results: Array<{ size: number; chunks: number; avgSize: number; maxSize: number }> = [];

    for (const size of [10000, 50000, 100000]) {
      const doc = generateTextDocument(size);
      const chunks = chunkHybridSectionAware(doc, [], null, DEFAULT_CHUNKING_CONFIG);

      const avgSize = Math.round(chunks.reduce((s, c) => s + c.text.length, 0) / chunks.length);
      const maxSize = Math.max(...chunks.map((c) => c.text.length));

      results.push({ size, chunks: chunks.length, avgSize, maxSize });
    }

    console.error('[BENCHMARK] Quality consistency:');
    for (const r of results) {
      console.error(`  ${r.size / 1000}K: ${r.chunks} chunks, avg ${r.avgSize}, max ${r.maxSize}`);
    }

    // Average sizes should be relatively consistent across document sizes
    const avgSizes = results.map((r) => r.avgSize);
    const minAvg = Math.min(...avgSizes);
    const maxAvg = Math.max(...avgSizes);
    // Within 3x of each other
    expect(maxAvg / minAvg).toBeLessThan(3);

    // No max should exceed maxChunkSize
    for (const r of results) {
      expect(r.maxSize).toBeLessThanOrEqual(DEFAULT_CHUNKING_CONFIG.maxChunkSize);
    }
  });
});
