/**
 * Unit Tests for Markdown Parser (Section-Aware Chunking)
 *
 * Tests parseMarkdownBlocks, buildSectionHierarchy, getPageNumberForOffset,
 * and extractPageOffsetsFromText using realistic Datalab OCR output text.
 *
 * NO MOCK DATA - uses realistic markdown text with actual heading structures,
 * tables, code blocks, page markers.
 *
 * @module tests/unit/services/chunking/markdown-parser
 */

import { describe, it, expect } from 'vitest';
import {
  parseMarkdownBlocks,
  buildSectionHierarchy,
  getPageNumberForOffset,
  extractPageOffsetsFromText,
  MarkdownBlock,
  SectionNode,
} from '../../../../src/services/chunking/markdown-parser.js';
import type { PageOffset } from '../../../../src/models/document.js';

// =============================================================================
// REALISTIC TEST DOCUMENTS
// =============================================================================

/**
 * Realistic OCR output from a multi-page legal/medical document.
 * Contains headings, paragraphs, tables, code blocks, lists, and page markers.
 */
const REALISTIC_OCR_DOCUMENT = `# Patient Health Record Summary

This document contains the summary of clinical findings from the annual health examination conducted on January 15, 2026. The patient presented with mild symptoms of seasonal allergies and reported no significant changes since the previous visit.

## Clinical Observations

The attending physician performed a comprehensive physical examination. Blood pressure was measured at 120/80 mmHg, heart rate at 72 bpm, and respiratory rate at 16 breaths per minute. Temperature was 98.6 degrees Fahrenheit.

### Laboratory Results

| Test Name | Result | Reference Range | Status |
|-----------|--------|-----------------|--------|
| Hemoglobin | 14.2 g/dL | 13.5-17.5 g/dL | Normal |
| White Blood Cell Count | 7,200/mcL | 4,500-11,000/mcL | Normal |
| Platelet Count | 250,000/mcL | 150,000-400,000/mcL | Normal |
| Fasting Glucose | 95 mg/dL | 70-100 mg/dL | Normal |

### Medication Review

The patient is currently on the following medications:

- Cetirizine 10mg daily for allergies
- Vitamin D3 2000 IU daily
- Omega-3 fish oil 1000mg daily

## Treatment Plan

Based on the examination results, the treatment plan includes continuation of current medications and a follow-up visit in six months. The patient was advised to maintain regular exercise and a balanced diet.

---
<!-- Page 2 -->

## Appendix A: Diagnostic Codes

\`\`\`
ICD-10 Codes Applied:
J30.1 - Allergic rhinitis due to pollen
Z00.00 - Encounter for general adult medical examination
Z79.899 - Other long term drug therapy
\`\`\`

### Notes on Coding

The diagnostic codes listed above were assigned based on the clinical findings documented during the visit. All codes are current as of the ICD-10-CM 2026 update.`;

/**
 * Shorter document with deeper heading nesting for hierarchy tests.
 */
const NESTED_HEADINGS_DOCUMENT = `# Introduction

Overview of the research project and objectives.

## Background

Historical context for the study.

### Previous Work

Smith et al. (2024) demonstrated the initial findings.

#### Methodology Details

The methodology follows a double-blind randomized control protocol.

### Current Gaps

Several gaps remain in the existing literature.

## Methods

### Data Collection

#### Survey Design

The survey instrument was validated across three pilot studies.

##### Question Categories

Questions were organized into five thematic categories covering demographics, health status, lifestyle factors, environmental exposures, and genetic history.

###### Sub-category: Demographics

Age, gender, ethnicity, and socioeconomic indicators.

# Conclusions

The study provides evidence supporting the initial hypothesis.`;

// =============================================================================
// parseMarkdownBlocks
// =============================================================================

describe('parseMarkdownBlocks', () => {
  describe('heading parsing', () => {
    it('parses H1 heading with correct type, headingLevel, and headingText', () => {
      const text = '# Patient Health Record Summary';
      const blocks = parseMarkdownBlocks(text, []);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('heading');
      expect(blocks[0].headingLevel).toBe(1);
      expect(blocks[0].headingText).toBe('Patient Health Record Summary');
    });

    it('parses all heading levels 1 through 6', () => {
      const text = [
        '# Level One',
        '## Level Two',
        '### Level Three',
        '#### Level Four',
        '##### Level Five',
        '###### Level Six',
      ].join('\n\n');

      const blocks = parseMarkdownBlocks(text, []);
      const headings = blocks.filter((b) => b.type === 'heading');

      expect(headings).toHaveLength(6);
      for (let i = 0; i < 6; i++) {
        expect(headings[i].headingLevel).toBe(i + 1);
        expect(headings[i].headingText).toBe(`Level ${['One', 'Two', 'Three', 'Four', 'Five', 'Six'][i]}`);
      }
    });

    it('extracts headings from realistic OCR document', () => {
      const blocks = parseMarkdownBlocks(REALISTIC_OCR_DOCUMENT, []);
      const headings = blocks.filter((b) => b.type === 'heading');

      // H1: Patient Health Record Summary
      // H2: Clinical Observations, Treatment Plan, Appendix A: Diagnostic Codes
      // H3: Laboratory Results, Medication Review, Notes on Coding
      expect(headings.length).toBeGreaterThanOrEqual(6);

      const h1 = headings.find((h) => h.headingLevel === 1);
      expect(h1).toBeDefined();
      expect(h1!.headingText).toBe('Patient Health Record Summary');

      const h2s = headings.filter((h) => h.headingLevel === 2);
      expect(h2s.length).toBeGreaterThanOrEqual(3);

      const h3s = headings.filter((h) => h.headingLevel === 3);
      expect(h3s.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('table parsing', () => {
    it('parses a markdown table with pipe delimiters and separator row', () => {
      const text = [
        '| Col A | Col B | Col C |',
        '|-------|-------|-------|',
        '| val1  | val2  | val3  |',
        '| val4  | val5  | val6  |',
      ].join('\n');

      const blocks = parseMarkdownBlocks(text, []);
      const tables = blocks.filter((b) => b.type === 'table');

      expect(tables).toHaveLength(1);
      expect(tables[0].text).toContain('Col A');
      expect(tables[0].text).toContain('val4');
      expect(tables[0].headingLevel).toBeNull();
      expect(tables[0].headingText).toBeNull();
    });

    it('finds the laboratory results table in realistic OCR output', () => {
      const blocks = parseMarkdownBlocks(REALISTIC_OCR_DOCUMENT, []);
      const tables = blocks.filter((b) => b.type === 'table');

      expect(tables.length).toBeGreaterThanOrEqual(1);
      const labTable = tables.find((t) => t.text.includes('Hemoglobin'));
      expect(labTable).toBeDefined();
      expect(labTable!.text).toContain('Platelet Count');
      expect(labTable!.text).toContain('Reference Range');
    });
  });

  describe('code block parsing', () => {
    it('parses a self-contained code block', () => {
      const text = '```python\nprint("hello world")\nresult = 42\n```';
      const blocks = parseMarkdownBlocks(text, []);
      const codeBlocks = blocks.filter((b) => b.type === 'code');

      expect(codeBlocks).toHaveLength(1);
      expect(codeBlocks[0].text).toContain('print("hello world")');
      expect(codeBlocks[0].text).toContain('```');
    });

    it('parses a code fence that spans double-newline boundaries', () => {
      // Simulates a code block with blank lines inside (split by \n\n)
      const text = '```\nline one\n\nline after blank\n\nline after second blank\n```';
      const blocks = parseMarkdownBlocks(text, []);

      // The parser should merge these into a single code block
      const codeBlocks = blocks.filter((b) => b.type === 'code');
      expect(codeBlocks).toHaveLength(1);
      expect(codeBlocks[0].text).toContain('line one');
      expect(codeBlocks[0].text).toContain('line after blank');
      expect(codeBlocks[0].text).toContain('line after second blank');
    });

    it('finds ICD-10 code block in realistic OCR document', () => {
      const blocks = parseMarkdownBlocks(REALISTIC_OCR_DOCUMENT, []);
      const codeBlocks = blocks.filter((b) => b.type === 'code');

      expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
      const icdBlock = codeBlocks.find((c) => c.text.includes('ICD-10'));
      expect(icdBlock).toBeDefined();
      expect(icdBlock!.text).toContain('J30.1');
      expect(icdBlock!.text).toContain('Z00.00');
    });
  });

  describe('list parsing', () => {
    it('parses unordered list items', () => {
      const text = '- First item\n- Second item\n- Third item';
      const blocks = parseMarkdownBlocks(text, []);
      const lists = blocks.filter((b) => b.type === 'list');

      expect(lists).toHaveLength(1);
      expect(lists[0].text).toContain('First item');
      expect(lists[0].text).toContain('Third item');
    });

    it('parses ordered list items', () => {
      const text = '1. Step one\n2. Step two\n3. Step three';
      const blocks = parseMarkdownBlocks(text, []);
      const lists = blocks.filter((b) => b.type === 'list');

      expect(lists).toHaveLength(1);
      expect(lists[0].text).toContain('Step one');
      expect(lists[0].text).toContain('Step three');
    });

    it('finds medication list in realistic OCR document', () => {
      const blocks = parseMarkdownBlocks(REALISTIC_OCR_DOCUMENT, []);
      const lists = blocks.filter((b) => b.type === 'list');

      expect(lists.length).toBeGreaterThanOrEqual(1);
      const medList = lists.find((l) => l.text.includes('Cetirizine'));
      expect(medList).toBeDefined();
      expect(medList!.text).toContain('Vitamin D3');
      expect(medList!.text).toContain('Omega-3');
    });
  });

  describe('paragraph parsing', () => {
    it('parses plain text as paragraphs', () => {
      const text = 'This is a paragraph of text that does not match any other block type.';
      const blocks = parseMarkdownBlocks(text, []);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('paragraph');
      expect(blocks[0].text).toBe(text);
    });

    it('parses multiple paragraphs separated by double newlines', () => {
      const text = 'First paragraph content.\n\nSecond paragraph content.\n\nThird paragraph content.';
      const blocks = parseMarkdownBlocks(text, []);

      const paragraphs = blocks.filter((b) => b.type === 'paragraph');
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[0].text).toBe('First paragraph content.');
      expect(paragraphs[1].text).toBe('Second paragraph content.');
      expect(paragraphs[2].text).toBe('Third paragraph content.');
    });
  });

  describe('page marker detection', () => {
    it('detects Datalab page marker pattern', () => {
      const text = 'Content before.\n\n---\n<!-- Page 3 -->\n\nContent after.';
      const blocks = parseMarkdownBlocks(text, []);

      const markers = blocks.filter((b) => b.type === 'page_marker');
      expect(markers).toHaveLength(1);
      expect(markers[0].text).toContain('Page 3');
    });

    it('finds page marker in realistic OCR document', () => {
      const blocks = parseMarkdownBlocks(REALISTIC_OCR_DOCUMENT, []);
      const markers = blocks.filter((b) => b.type === 'page_marker');

      expect(markers.length).toBeGreaterThanOrEqual(1);
      expect(markers[0].text).toContain('Page 2');
    });
  });

  describe('empty text handling', () => {
    it('returns empty array for empty text', () => {
      const blocks = parseMarkdownBlocks('', []);
      expect(blocks).toEqual([]);
    });
  });

  describe('character offset tracking', () => {
    it('tracks correct startOffset and endOffset for first block', () => {
      const text = 'First paragraph.';
      const blocks = parseMarkdownBlocks(text, []);

      expect(blocks[0].startOffset).toBe(0);
      expect(blocks[0].endOffset).toBe(text.length);
    });

    it('tracks offsets correctly across multiple blocks', () => {
      const para1 = 'First paragraph.';
      const para2 = 'Second paragraph.';
      const para3 = 'Third paragraph.';
      const text = `${para1}\n\n${para2}\n\n${para3}`;

      const blocks = parseMarkdownBlocks(text, []);

      // First block
      expect(blocks[0].startOffset).toBe(0);
      expect(blocks[0].endOffset).toBe(para1.length);

      // Second block: after para1 + \n\n
      expect(blocks[1].startOffset).toBe(para1.length + 2);
      expect(blocks[1].endOffset).toBe(para1.length + 2 + para2.length);

      // Third block: after para1 + \n\n + para2 + \n\n
      expect(blocks[2].startOffset).toBe(para1.length + 2 + para2.length + 2);
      expect(blocks[2].endOffset).toBe(text.length);
    });

    it('offset of each block text matches the original text', () => {
      const blocks = parseMarkdownBlocks(REALISTIC_OCR_DOCUMENT, []);

      for (const block of blocks) {
        // For non-code blocks that were not merged across \n\n boundaries,
        // the text should match the slice of the original document
        const sliced = REALISTIC_OCR_DOCUMENT.slice(block.startOffset, block.endOffset);
        expect(block.text).toBe(sliced);
      }
    });
  });

  describe('page number assignment from pageOffsets', () => {
    it('assigns correct page numbers to blocks using pageOffsets', () => {
      const page1 = 'Content on page one.';
      const page2 = 'Content on page two.';
      const text = `${page1}\n\n${page2}`;
      const pageOffsets: PageOffset[] = [
        { page: 1, charStart: 0, charEnd: page1.length + 2 },
        { page: 2, charStart: page1.length + 2, charEnd: text.length },
      ];

      const blocks = parseMarkdownBlocks(text, pageOffsets);

      expect(blocks[0].pageNumber).toBe(1);
      expect(blocks[1].pageNumber).toBe(2);
    });

    it('returns null page numbers when pageOffsets is empty', () => {
      const text = 'Some content.';
      const blocks = parseMarkdownBlocks(text, []);

      expect(blocks[0].pageNumber).toBeNull();
    });
  });
});

// =============================================================================
// buildSectionHierarchy
// =============================================================================

describe('buildSectionHierarchy', () => {
  it('maps heading blocks to SectionNode with correct level and text', () => {
    const text = '# Introduction\n\nSome text.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // Block 0 is the heading
    expect(hierarchy.has(0)).toBe(true);
    const node = hierarchy.get(0)!;
    expect(node.level).toBe(1);
    expect(node.text).toBe('Introduction');
    expect(node.path).toBe('Introduction');
  });

  it('builds nested paths like "Intro > Background > History"', () => {
    const text = '# Intro\n\n## Background\n\n### History\n\nContent here.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // Find the H3 heading block index
    const h3Idx = blocks.findIndex((b) => b.headingText === 'History');
    expect(h3Idx).toBeGreaterThan(0);

    const node = hierarchy.get(h3Idx)!;
    expect(node.path).toBe('Intro > Background > History');
    expect(node.level).toBe(3);
    expect(node.text).toBe('History');
  });

  it('content blocks inherit section from most recent heading', () => {
    const text = '## Section A\n\nParagraph under A.\n\n## Section B\n\nParagraph under B.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // Find paragraph under Section A
    const paraAIdx = blocks.findIndex((b) => b.text.includes('Paragraph under A'));
    expect(hierarchy.has(paraAIdx)).toBe(true);
    expect(hierarchy.get(paraAIdx)!.text).toBe('Section A');

    // Find paragraph under Section B
    const paraBIdx = blocks.findIndex((b) => b.text.includes('Paragraph under B'));
    expect(hierarchy.has(paraBIdx)).toBe(true);
    expect(hierarchy.get(paraBIdx)!.text).toBe('Section B');
  });

  it('blocks before any heading have no section entry', () => {
    const text = 'Preamble text before any heading.\n\n# First Heading\n\nContent.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // First block (preamble) should have no entry
    expect(hierarchy.has(0)).toBe(false);

    // After the heading, blocks should have entries
    const headingIdx = blocks.findIndex((b) => b.type === 'heading');
    expect(hierarchy.has(headingIdx)).toBe(true);
  });

  it('lower-level heading (H2) clears higher-level entries (H3-H6)', () => {
    const text = '# Top\n\n## Sub A\n\n### Detail\n\nContent under detail.\n\n## Sub B\n\nContent under Sub B.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // After "## Sub A > ### Detail", path is "Top > Sub A > Detail"
    const detailIdx = blocks.findIndex((b) => b.headingText === 'Detail');
    expect(hierarchy.get(detailIdx)!.path).toBe('Top > Sub A > Detail');

    // After "## Sub B", H3 "Detail" is cleared, path is "Top > Sub B"
    const subBIdx = blocks.findIndex((b) => b.headingText === 'Sub B');
    expect(hierarchy.get(subBIdx)!.path).toBe('Top > Sub B');

    // Content under Sub B inherits "Top > Sub B"
    const contentIdx = blocks.findIndex((b) => b.text.includes('Content under Sub B'));
    expect(hierarchy.get(contentIdx)!.path).toBe('Top > Sub B');
  });

  it('builds full hierarchy from nested heading document', () => {
    const blocks = parseMarkdownBlocks(NESTED_HEADINGS_DOCUMENT, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // Find the "#### Methodology Details" block
    const methIdx = blocks.findIndex((b) => b.headingText === 'Methodology Details');
    expect(methIdx).toBeGreaterThan(0);
    expect(hierarchy.get(methIdx)!.path).toBe('Introduction > Background > Previous Work > Methodology Details');

    // After "### Current Gaps", H4 is cleared
    const gapsIdx = blocks.findIndex((b) => b.headingText === 'Current Gaps');
    expect(hierarchy.get(gapsIdx)!.path).toBe('Introduction > Background > Current Gaps');

    // After the final "# Conclusions", everything resets
    const conclusionsIdx = blocks.findIndex((b) => b.headingText === 'Conclusions');
    expect(hierarchy.get(conclusionsIdx)!.path).toBe('Conclusions');
  });
});

// =============================================================================
// getPageNumberForOffset
// =============================================================================

describe('getPageNumberForOffset', () => {
  const threePageOffsets: PageOffset[] = [
    { page: 1, charStart: 0, charEnd: 1000 },
    { page: 2, charStart: 1000, charEnd: 2000 },
    { page: 3, charStart: 2000, charEnd: 3000 },
  ];

  it('returns correct page for offset in middle of page range', () => {
    expect(getPageNumberForOffset(500, threePageOffsets)).toBe(1);
    expect(getPageNumberForOffset(1500, threePageOffsets)).toBe(2);
    expect(getPageNumberForOffset(2500, threePageOffsets)).toBe(3);
  });

  it('returns null for empty pageOffsets', () => {
    expect(getPageNumberForOffset(100, [])).toBeNull();
  });

  it('handles offset before first page (returns first page number)', () => {
    const offsets: PageOffset[] = [
      { page: 3, charStart: 100, charEnd: 500 },
      { page: 4, charStart: 500, charEnd: 1000 },
    ];
    // Offset 50 is before the first page's charStart
    expect(getPageNumberForOffset(50, offsets)).toBe(3);
  });

  it('handles offset at or after last page end (returns last page number)', () => {
    expect(getPageNumberForOffset(3000, threePageOffsets)).toBe(3);
    expect(getPageNumberForOffset(5000, threePageOffsets)).toBe(3);
  });

  it('handles offset at exact page boundary', () => {
    // charStart is inclusive, charEnd is exclusive
    expect(getPageNumberForOffset(0, threePageOffsets)).toBe(1);
    expect(getPageNumberForOffset(1000, threePageOffsets)).toBe(2);
    expect(getPageNumberForOffset(2000, threePageOffsets)).toBe(3);
  });

  it('handles single-page offset', () => {
    const single: PageOffset[] = [{ page: 7, charStart: 0, charEnd: 500 }];
    expect(getPageNumberForOffset(250, single)).toBe(7);
    expect(getPageNumberForOffset(0, single)).toBe(7);
    expect(getPageNumberForOffset(499, single)).toBe(7);
    expect(getPageNumberForOffset(500, single)).toBe(7); // at/after end -> last page
  });
});

// =============================================================================
// extractPageOffsetsFromText
// =============================================================================

describe('extractPageOffsetsFromText', () => {
  it('extracts page boundaries from Datalab page markers in text', () => {
    const text = 'Content of page one.\n\n---\n<!-- Page 2 -->\n\nContent of page two.\n\n---\n<!-- Page 3 -->\n\nContent of page three.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets.length).toBe(2);
    expect(offsets[0].page).toBe(2);
    expect(offsets[1].page).toBe(3);
  });

  it('returns empty array when no markers present', () => {
    const text = 'This is a plain document with no page markers at all.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toEqual([]);
  });

  it('returns correct charStart and charEnd for each page', () => {
    const text = 'Page one content.\n\n---\n<!-- Page 2 -->\n\nPage two content.\n\n---\n<!-- Page 3 -->\n\nPage three content.';
    const offsets = extractPageOffsetsFromText(text);

    // First marker starts from 0 (content before first marker)
    expect(offsets[0].charStart).toBe(0);
    // Second marker starts at its position
    expect(offsets[1].charStart).toBeGreaterThan(offsets[0].charStart);
    // Last marker ends at text length
    expect(offsets[offsets.length - 1].charEnd).toBe(text.length);

    // Verify ordering
    for (let i = 0; i < offsets.length - 1; i++) {
      expect(offsets[i].charEnd).toBeLessThanOrEqual(offsets[i + 1].charStart + 1);
    }
  });

  it('handles multiple consecutive pages', () => {
    const text = '---\n<!-- Page 1 -->\n\nA.\n\n---\n<!-- Page 2 -->\n\nB.\n\n---\n<!-- Page 3 -->\n\nC.\n\n---\n<!-- Page 4 -->\n\nD.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toHaveLength(4);
    expect(offsets[0].page).toBe(1);
    expect(offsets[1].page).toBe(2);
    expect(offsets[2].page).toBe(3);
    expect(offsets[3].page).toBe(4);

    // Each page's range should be non-empty
    for (const offset of offsets) {
      expect(offset.charEnd).toBeGreaterThan(offset.charStart);
    }
  });

  it('extracts page markers from realistic OCR document', () => {
    const offsets = extractPageOffsetsFromText(REALISTIC_OCR_DOCUMENT);

    // The realistic document has one page marker: <!-- Page 2 -->
    expect(offsets.length).toBeGreaterThanOrEqual(1);
    expect(offsets[0].page).toBe(2);
    expect(offsets[0].charEnd).toBe(REALISTIC_OCR_DOCUMENT.length);
  });

  it('handles page markers with extra whitespace', () => {
    const text = 'Content.\n\n---\n<!--  Page  5  -->\n\nMore content.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toHaveLength(1);
    expect(offsets[0].page).toBe(5);
  });
});
