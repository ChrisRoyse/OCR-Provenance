/**
 * Unit Tests for SE-3: Page-Aware Chunking
 *
 * Tests the chunkTextPageAware function which chunks text
 * respecting page boundaries so no chunks span across pages.
 *
 * @module tests/unit/services/chunking/page-aware
 */

import { describe, it, expect } from 'vitest';
import { chunkTextPageAware } from '../../../../src/services/chunking/chunker.js';
import type { PageOffset } from '../../../../src/models/document.js';

describe('Page-Aware Chunking', () => {
  describe('chunkTextPageAware', () => {
    it('falls back to standard chunking with empty page offsets', () => {
      const text = 'A'.repeat(3000);
      const chunks = chunkTextPageAware(text, []);
      // Standard chunking with default config (2000 chars, 10% overlap)
      expect(chunks.length).toBeGreaterThan(0);
      // First chunk should be 2000 chars
      expect(chunks[0].text.length).toBe(2000);
    });

    it('creates separate chunks per page for small pages', () => {
      const page1 = 'Page one content. ';
      const page2 = 'Page two content. ';
      const page3 = 'Page three content. ';
      const text = page1 + page2 + page3;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: page1.length + page2.length },
        { page: 3, charStart: page1.length + page2.length, charEnd: text.length },
      ];

      // Use small chunk size to get one chunk per page
      const chunks = chunkTextPageAware(text, pageOffsets, { chunkSize: 2000, overlapPercent: 10 });

      // Each page is small enough to fit in one chunk
      expect(chunks.length).toBe(3);
      expect(chunks[0].text).toBe(page1);
      expect(chunks[0].pageNumber).toBe(1);
      expect(chunks[1].text).toBe(page2);
      expect(chunks[1].pageNumber).toBe(2);
      expect(chunks[2].text).toBe(page3);
      expect(chunks[2].pageNumber).toBe(3);
    });

    it('chunks within a page when page content exceeds chunk size', () => {
      const page1 = 'A'.repeat(5000); // 5000 chars -- needs multiple chunks
      const page2 = 'B'.repeat(500);  // 500 chars -- fits in one chunk
      const text = page1 + page2;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets, { chunkSize: 2000, overlapPercent: 10 });

      // Page 1 should produce multiple chunks
      const page1Chunks = chunks.filter(c => c.pageNumber === 1);
      expect(page1Chunks.length).toBeGreaterThan(1);

      // Page 2 should produce exactly one chunk
      const page2Chunks = chunks.filter(c => c.pageNumber === 2);
      expect(page2Chunks.length).toBe(1);
      expect(page2Chunks[0].text).toBe(page2);
    });

    it('ensures no chunks span page boundaries', () => {
      const page1 = 'X'.repeat(3000);
      const page2 = 'Y'.repeat(3000);
      const text = page1 + page2;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets, { chunkSize: 2000, overlapPercent: 10 });

      for (const chunk of chunks) {
        if (chunk.pageNumber === 1) {
          // All content should be from page 1 only (X characters)
          expect(chunk.text).toMatch(/^X+$/);
          expect(chunk.endOffset).toBeLessThanOrEqual(page1.length);
        } else if (chunk.pageNumber === 2) {
          // All content should be from page 2 only (Y characters)
          expect(chunk.text).toMatch(/^Y+$/);
          expect(chunk.startOffset).toBeGreaterThanOrEqual(page1.length);
        }
      }
    });

    it('handles a single page', () => {
      const text = 'Single page content that is short.';
      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets);
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe(text);
      expect(chunks[0].pageNumber).toBe(1);
    });

    it('skips empty pages', () => {
      const page1 = 'Page one has content. ';
      const page2 = '   '; // whitespace-only page
      const page3 = 'Page three has content. ';
      const text = page1 + page2 + page3;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: page1.length + page2.length },
        { page: 3, charStart: page1.length + page2.length, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets);
      // Page 2 is whitespace-only, should be skipped
      const pageNumbers = chunks.map(c => c.pageNumber);
      expect(pageNumbers).not.toContain(2);
      expect(pageNumbers).toContain(1);
      expect(pageNumbers).toContain(3);
    });

    it('sets correct startOffset and endOffset relative to full text', () => {
      const page1 = 'First page. ';
      const page2 = 'Second page content here. ';
      const text = page1 + page2;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe(page1.length);
      expect(chunks[1].startOffset).toBe(page1.length);
      expect(chunks[1].endOffset).toBe(text.length);
    });

    it('assigns sequential indices across pages', () => {
      const page1 = 'Page one. ';
      const page2 = 'Page two. ';
      const page3 = 'Page three. ';
      const text = page1 + page2 + page3;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: page1.length + page2.length },
        { page: 3, charStart: page1.length + page2.length, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });

    it('sets overlapWithNext correctly for consecutive chunks', () => {
      const page1 = 'A'.repeat(5000); // Will produce multiple chunks
      const text = page1;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets, { chunkSize: 2000, overlapPercent: 10 });
      expect(chunks.length).toBeGreaterThan(1);

      // All chunks except the last should have overlapWithNext = 200 (10% of 2000)
      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i].overlapWithNext).toBe(200);
      }
      // Last chunk should have overlapWithNext = 0
      expect(chunks[chunks.length - 1].overlapWithNext).toBe(0);
    });

    it('handles pages of varying lengths', () => {
      const page1 = 'Short.';
      const page2 = 'M'.repeat(1500);
      const page3 = 'L'.repeat(4000);
      const text = page1 + page2 + page3;

      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length },
        { page: 2, charStart: page1.length, charEnd: page1.length + page2.length },
        { page: 3, charStart: page1.length + page2.length, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets, { chunkSize: 2000, overlapPercent: 10 });

      // Page 1 (6 chars) -> 1 chunk
      const p1 = chunks.filter(c => c.pageNumber === 1);
      expect(p1.length).toBe(1);

      // Page 2 (1500 chars) -> 1 chunk (fits in 2000)
      const p2 = chunks.filter(c => c.pageNumber === 2);
      expect(p2.length).toBe(1);

      // Page 3 (4000 chars) -> multiple chunks
      const p3 = chunks.filter(c => c.pageNumber === 3);
      expect(p3.length).toBeGreaterThan(1);
    });

    it('uses custom chunk size and overlap', () => {
      const text = 'A'.repeat(1000);
      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: text.length },
      ];

      const chunks = chunkTextPageAware(text, pageOffsets, { chunkSize: 300, overlapPercent: 20 });

      // First chunk should be 300 chars
      expect(chunks[0].text.length).toBe(300);
      // Overlap should be 60 (20% of 300)
      if (chunks.length > 1) {
        expect(chunks[1].overlapWithPrevious).toBe(60);
      }
    });
  });
});
