/**
 * Unit Tests for Page-Aware Chunking via Hybrid Section-Aware Chunker
 *
 * Tests that chunkHybridSectionAware correctly handles page offsets,
 * assigns page numbers, and produces chunks with proper section metadata.
 *
 * @module tests/unit/services/chunking/page-aware
 */

import { describe, it, expect } from 'vitest';
import {
  chunkHybridSectionAware,
  DEFAULT_CHUNKING_CONFIG,
} from '../../../../src/services/chunking/chunker.js';
import type { PageOffset } from '../../../../src/models/document.js';

describe('Hybrid Section-Aware Chunking - Page Tracking', () => {
  describe('basic page tracking', () => {
    it('returns null page info with empty page offsets', () => {
      const text = 'A simple paragraph of text for chunking.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].pageNumber).toBeNull();
      expect(chunks[0].pageRange).toBeNull();
    });

    it('assigns correct page number for single-page content', () => {
      const text = 'Single page content that is short enough for one chunk.';
      const pageOffsets: PageOffset[] = [{ page: 1, charStart: 0, charEnd: text.length }];

      const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks.length).toBe(1);
      expect(chunks[0].pageNumber).toBe(1);
    });

    it('assigns correct page number when page is not page 1', () => {
      const text = 'Content on page five.';
      const pageOffsets: PageOffset[] = [{ page: 5, charStart: 0, charEnd: text.length }];

      const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks[0].pageNumber).toBe(5);
    });

    it('assigns sequential indices across all chunks', () => {
      const page1 = 'Page one content. ';
      const page2 = 'Page two content. ';
      const page3 = 'Page three content. ';
      const text = page1 + page2 + page3;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: page1.length + page2.length },
        { page: 3, charStart: page1.length + page2.length, charEnd: text.length },
      ];

      const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });
  });

  describe('multi-page content', () => {
    it('handles content spanning multiple pages', () => {
      const page1 = 'First page with some content. ';
      const page2 = 'Second page with more content. ';
      const text = page1 + page2;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: text.length },
      ];

      const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // The first chunk should start on page 1
      expect(chunks[0].pageNumber).toBe(1);
    });

    it('handles three-page document', () => {
      const page1 = 'Content for page one with enough text. ';
      const page2 = 'Content for page two with enough text. ';
      const page3 = 'Content for page three with enough text. ';
      const text = page1 + page2 + page3;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: page1.length + page2.length },
        { page: 3, charStart: page1.length + page2.length, charEnd: text.length },
      ];

      const chunks = chunkHybridSectionAware(text, pageOffsets, null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // All page numbers should be valid
      for (const chunk of chunks) {
        if (chunk.pageNumber !== null) {
          expect([1, 2, 3]).toContain(chunk.pageNumber);
        }
      }
    });
  });

  describe('chunk metadata', () => {
    it('all chunks have contentTypes array', () => {
      const text = 'Some paragraph text that will be chunked into pieces.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      for (const chunk of chunks) {
        expect(Array.isArray(chunk.contentTypes)).toBe(true);
        expect(chunk.contentTypes.length).toBeGreaterThan(0);
      }
    });

    it('all chunks have isAtomic boolean', () => {
      const text = 'Regular paragraph text.\n\n| Col | Val |\n|-----|-----|\n| A   | B   |';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      for (const chunk of chunks) {
        expect(typeof chunk.isAtomic).toBe('boolean');
      }
    });

    it('chunks have valid startOffset and endOffset', () => {
      const text =
        'First paragraph of text.\n\nSecond paragraph of text.\n\nThird paragraph of text.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      for (const chunk of chunks) {
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
        expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
      }
    });
  });

  describe('overlap behavior', () => {
    it('first chunk has zero overlapWithPrevious', () => {
      const text = 'A '.repeat(2000); // Generate enough text for multiple chunks
      const chunks = chunkHybridSectionAware(text, [], null, {
        chunkSize: 500,
        overlapPercent: 10,
        maxChunkSize: 2000,
      });

      if (chunks.length > 0) {
        expect(chunks[0].overlapWithPrevious).toBe(0);
      }
    });

    it('last chunk has zero overlapWithNext', () => {
      const text = 'A '.repeat(2000);
      const chunks = chunkHybridSectionAware(text, [], null, {
        chunkSize: 500,
        overlapPercent: 10,
        maxChunkSize: 2000,
      });

      if (chunks.length > 0) {
        expect(chunks[chunks.length - 1].overlapWithNext).toBe(0);
      }
    });

    it('atomic chunks have zero overlap on both sides', () => {
      const text = 'Before table.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter table.';
      const chunks = chunkHybridSectionAware(text, [], null, DEFAULT_CHUNKING_CONFIG);

      const atomicChunks = chunks.filter((c) => c.isAtomic);
      for (const chunk of atomicChunks) {
        expect(chunk.overlapWithPrevious).toBe(0);
        expect(chunk.overlapWithNext).toBe(0);
      }
    });
  });

  describe('empty text handling', () => {
    it('returns empty array for empty text', () => {
      const chunks = chunkHybridSectionAware('', [], null, DEFAULT_CHUNKING_CONFIG);
      expect(chunks).toHaveLength(0);
    });
  });
});
