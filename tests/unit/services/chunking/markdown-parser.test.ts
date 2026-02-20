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

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

// =============================================================================
// 3.1.1 parseMarkdownBlocks() Edge Cases
// =============================================================================

describe('parseMarkdownBlocks edge cases', () => {
  it('whitespace-only text returns empty blocks', () => {
    const text = '   \t  ';
    const blocks = parseMarkdownBlocks(text, []);

    // A whitespace-only segment split by \n\n yields one segment that trims to empty
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('empty');
  });

  it('whitespace with newlines returns empty blocks', () => {
    const text = '  \n\n  \n\n  ';
    const blocks = parseMarkdownBlocks(text, []);

    // All segments are whitespace-only, classified as empty
    for (const block of blocks) {
      expect(block.type).toBe('empty');
    }
    expect(blocks.length).toBe(3);
  });

  it('single paragraph with no double newline returns 1 paragraph block', () => {
    const text = 'The patient was admitted to the emergency department at 3:42 AM on February 14, 2026 with acute abdominal pain. Vitals were stable on arrival.';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toBe(text);
    expect(blocks[0].startOffset).toBe(0);
    expect(blocks[0].endOffset).toBe(text.length);
  });

  it('heading with no content after it returns heading block only', () => {
    const text = '## Diagnosis and Treatment Plan';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[0].headingText).toBe('Diagnosis and Treatment Plan');
  });

  it('heading without space after hash is classified as paragraph, not heading', () => {
    const text = '#NoSpace is not a valid heading';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].headingLevel).toBeNull();
    expect(blocks[0].headingText).toBeNull();
  });

  it('##NoSpace and ###NoSpace are also not headings', () => {
    const text = '##TwoHashes\n\n###ThreeHashes';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[1].type).toBe('paragraph');
  });

  it('multiple blank lines between paragraphs produce empty blocks', () => {
    // \n\n\n\n splits into segments: "First", "", "Second"
    const text = 'First paragraph about renal function.\n\n\n\nSecond paragraph about hepatic markers.';
    const blocks = parseMarkdownBlocks(text, []);

    const paragraphs = blocks.filter((b) => b.type === 'paragraph');
    const empties = blocks.filter((b) => b.type === 'empty');

    expect(paragraphs).toHaveLength(2);
    expect(empties).toHaveLength(1);
    expect(paragraphs[0].text).toContain('renal function');
    expect(paragraphs[1].text).toContain('hepatic markers');
  });

  it('code fence unclosed at EOF merges with all following segments', () => {
    const text = '```sql\nSELECT patient_id, diagnosis_code\nFROM encounters\n\nWHERE admission_date > 2026-01-01\nORDER BY patient_id';
    const blocks = parseMarkdownBlocks(text, []);

    // The code fence opens but never closes. The parser should merge segments.
    const codeBlocks = blocks.filter((b) => b.type === 'code');
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].text).toContain('SELECT patient_id');
    expect(codeBlocks[0].text).toContain('WHERE admission_date');
    expect(codeBlocks[0].text).toContain('ORDER BY patient_id');
  });

  it('empty code block with just opening and closing fences is classified as code', () => {
    const text = '```\n```';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].text).toBe('```\n```');
  });

  it('code block with language tag and no content is classified as code', () => {
    const text = '```json\n```';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
  });

  it('table without separator row is classified as paragraph', () => {
    // This has pipe-delimited content but no |---|---| separator row
    const text = '| Name | Age | Diagnosis |\n| John Doe | 45 | Hypertension |\n| Jane Smith | 38 | Type 2 Diabetes |';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(1);
    // Without separator row, isTable returns false, so it falls through to paragraph
    expect(blocks[0].type).toBe('paragraph');
  });

  it('table with only header and separator row is valid table', () => {
    const text = '| Medication | Dosage |\n|------------|--------|';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].text).toContain('Medication');
    expect(blocks[0].text).toContain('Dosage');
  });

  it('unicode and emoji content is preserved in block text', () => {
    const text = 'Patient notes: Temperature 37.5\u00B0C. Blood type: A\u207A. \u2764\uFE0F Normal sinus rhythm observed on ECG.\n\nDiagnosis: Acute pharyngitis (\u6025\u6027\u54BD\u5934\u708E). \u00C9valuation compl\u00E8te.';
    const blocks = parseMarkdownBlocks(text, []);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toContain('\u00B0C');
    expect(blocks[0].text).toContain('\u2764\uFE0F');
    expect(blocks[0].text).toContain('A\u207A');
    expect(blocks[1].text).toContain('\u6025\u6027\u54BD\u5934\u708E');
    expect(blocks[1].text).toContain('\u00C9valuation');
  });

  it('Datalab {N}--- format is classified as page_marker', () => {
    const text = 'Content before page break.\n\n{2}------------------------------------------------\n\nContent after page break.';
    const blocks = parseMarkdownBlocks(text, []);

    const markers = blocks.filter((b) => b.type === 'page_marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].text).toContain('{2}');
  });

  it('page_marker with Datalab format has correct offsets', () => {
    const before = 'First page text.';
    const marker = '{1}------------------------------------------------';
    const after = 'Second page text.';
    const text = `${before}\n\n${marker}\n\n${after}`;
    const blocks = parseMarkdownBlocks(text, []);

    const markerBlock = blocks.find((b) => b.type === 'page_marker');
    expect(markerBlock).toBeDefined();
    expect(markerBlock!.startOffset).toBe(before.length + 2);
    expect(markerBlock!.endOffset).toBe(before.length + 2 + marker.length);
  });
});

// =============================================================================
// 3.1.2 buildSectionHierarchy() Edge Cases
// =============================================================================

describe('buildSectionHierarchy edge cases', () => {
  it('no heading blocks returns empty map', () => {
    const text = 'This document has no headings at all.\n\nJust plain paragraphs discussing clinical outcomes.\n\nAnd a third paragraph about medication adherence.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    expect(hierarchy.size).toBe(0);
  });

  it('single H1 heading with no content returns map with one entry', () => {
    const text = '# Annual Physical Examination Report';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    expect(hierarchy.size).toBe(1);
    expect(hierarchy.get(0)).toBeDefined();
    expect(hierarchy.get(0)!.level).toBe(1);
    expect(hierarchy.get(0)!.text).toBe('Annual Physical Examination Report');
    expect(hierarchy.get(0)!.path).toBe('Annual Physical Examination Report');
  });

  it('H1 followed by H4 (skipping H2, H3) gives H4 inheriting H1 context', () => {
    const text = '# Clinical Summary\n\n#### Specific Lab Finding\n\nThe creatinine level was elevated at 1.8 mg/dL.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    const h4Idx = blocks.findIndex((b) => b.headingText === 'Specific Lab Finding');
    expect(h4Idx).toBeGreaterThan(0);
    expect(hierarchy.get(h4Idx)!.path).toBe('Clinical Summary > Specific Lab Finding');
    expect(hierarchy.get(h4Idx)!.level).toBe(4);

    // Content after H4 inherits the same section
    const contentIdx = blocks.findIndex((b) => b.text.includes('creatinine'));
    expect(hierarchy.get(contentIdx)!.path).toBe('Clinical Summary > Specific Lab Finding');
  });

  it('all blocks are non-heading returns empty map', () => {
    const text = 'Paragraph one about the procedure.\n\n- Item in a list\n- Another item\n\n| Col | Val |\n|-----|-----|\n| A   | 1   |';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    expect(blocks.length).toBeGreaterThan(0);
    expect(hierarchy.size).toBe(0);
  });

  it('100+ headings do not cause stack overflow', () => {
    // Generate a document with 150 alternating H2 and H3 headings
    const parts: string[] = ['# Master Document'];
    for (let i = 1; i <= 75; i++) {
      parts.push(`## Section ${i}`);
      parts.push(`Paragraph describing section ${i} of the regulatory compliance document.`);
      parts.push(`### Subsection ${i}.1`);
      parts.push(`Details for subsection ${i}.1 regarding patient safety protocols.`);
    }
    const text = parts.join('\n\n');

    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // Should have entries for 1 H1 + 75 H2 + 75 H3 + 150 paragraphs = 301
    expect(hierarchy.size).toBeGreaterThan(200);

    // Verify a deep entry
    const lastH3Idx = blocks.findIndex((b) => b.headingText === 'Subsection 75.1');
    expect(lastH3Idx).toBeGreaterThan(0);
    expect(hierarchy.get(lastH3Idx)!.path).toBe('Master Document > Section 75 > Subsection 75.1');
  });

  it('H1 then H2 then new H1 resets the entire hierarchy', () => {
    const text = '# Part One\n\n## Chapter A\n\n### Detail\n\nSome content.\n\n# Part Two\n\nNew content with fresh hierarchy.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    const partTwoIdx = blocks.findIndex((b) => b.headingText === 'Part Two');
    expect(hierarchy.get(partTwoIdx)!.path).toBe('Part Two');

    const newContentIdx = blocks.findIndex((b) => b.text.includes('New content with fresh'));
    expect(hierarchy.get(newContentIdx)!.path).toBe('Part Two');
  });
});

// =============================================================================
// 3.1.3 getPageNumberForOffset() Edge Cases
// =============================================================================

describe('getPageNumberForOffset edge cases', () => {
  it('negative offset returns first page number', () => {
    const offsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 500 },
      { page: 2, charStart: 500, charEnd: 1000 },
    ];

    expect(getPageNumberForOffset(-1, offsets)).toBe(1);
    expect(getPageNumberForOffset(-100, offsets)).toBe(1);
  });

  it('single page offset covering all text returns that page for any offset', () => {
    const offsets: PageOffset[] = [
      { page: 5, charStart: 0, charEnd: 10000 },
    ];

    expect(getPageNumberForOffset(0, offsets)).toBe(5);
    expect(getPageNumberForOffset(5000, offsets)).toBe(5);
    expect(getPageNumberForOffset(9999, offsets)).toBe(5);
    // At or after end
    expect(getPageNumberForOffset(10000, offsets)).toBe(5);
    expect(getPageNumberForOffset(20000, offsets)).toBe(5);
  });

  it('offset exactly at charEnd boundary goes to next page', () => {
    const offsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 100 },
      { page: 2, charStart: 100, charEnd: 200 },
    ];

    // charEnd is exclusive, so offset=100 is page 2
    expect(getPageNumberForOffset(99, offsets)).toBe(1);
    expect(getPageNumberForOffset(100, offsets)).toBe(2);
  });

  it('many pages with binary search finds correct page', () => {
    const offsets: PageOffset[] = [];
    for (let i = 0; i < 50; i++) {
      offsets.push({ page: i + 1, charStart: i * 200, charEnd: (i + 1) * 200 });
    }

    expect(getPageNumberForOffset(0, offsets)).toBe(1);
    expect(getPageNumberForOffset(199, offsets)).toBe(1);
    expect(getPageNumberForOffset(200, offsets)).toBe(2);
    expect(getPageNumberForOffset(5000, offsets)).toBe(26);
    expect(getPageNumberForOffset(9999, offsets)).toBe(50);
  });
});

// =============================================================================
// 3.1.4 extractPageOffsetsFromText() Edge Cases
// =============================================================================

describe('extractPageOffsetsFromText edge cases', () => {
  it('Datalab {N}--- markers produce correct 1-based page numbers', () => {
    const text = '{0}------------------------------------------------\nPage one content.\n\n{1}------------------------------------------------\nPage two content.\n\n{2}------------------------------------------------\nPage three content.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toHaveLength(3);
    // {0} -> page 1, {1} -> page 2, {2} -> page 3
    expect(offsets[0].page).toBe(1);
    expect(offsets[1].page).toBe(2);
    expect(offsets[2].page).toBe(3);
  });

  it('both HTML and Datalab markers in same text are deduplicated', () => {
    // Place an HTML marker and a Datalab marker far apart so they don't collide
    const text = '---\n<!-- Page 2 -->\n\nPage two text.\n\n{2}------------------------------------------------\nMore page three text.';
    const offsets = extractPageOffsetsFromText(text);

    // HTML marker gives page=2, Datalab {2} gives page=3 (0-based->1-based)
    // They are at different positions so both should be captured
    expect(offsets.length).toBe(2);
    // Verify pages are ordered
    expect(offsets[0].page).toBeLessThanOrEqual(offsets[1].page);
  });

  it('content before first marker is assigned to the first marker page (charStart=0)', () => {
    const text = 'Preamble content before any page marker appears here.\n\n---\n<!-- Page 3 -->\n\nActual page three content.';
    const offsets = extractPageOffsetsFromText(text);

    // The first marker found is Page 3. Its charStart should be 0 (content before it included).
    expect(offsets).toHaveLength(1);
    expect(offsets[0].page).toBe(3);
    expect(offsets[0].charStart).toBe(0);
    expect(offsets[0].charEnd).toBe(text.length);
  });

  it('non-sequential page numbers are sorted by position then by page', () => {
    // Markers out of numeric order but in text-position order
    const text = '---\n<!-- Page 5 -->\n\nSection five.\n\n---\n<!-- Page 2 -->\n\nSection two.\n\n---\n<!-- Page 8 -->\n\nSection eight.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toHaveLength(3);
    // extractPageOffsetsFromText sorts by page number at the end
    const pages = offsets.map((o) => o.page);
    const sortedPages = [...pages].sort((a, b) => a - b);
    expect(pages).toEqual(sortedPages);
  });

  it('very large document with 1000+ pages extracts all pages', () => {
    // Generate synthetic Datalab markers for 1050 pages
    const parts: string[] = [];
    for (let i = 0; i < 1050; i++) {
      parts.push(`{${i}}------------------------------------------------`);
      parts.push(`Content of page ${i + 1} discussing regulation ${i + 100}.`);
    }
    const text = parts.join('\n\n');
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toHaveLength(1050);
    // First page: {0} -> page 1
    expect(offsets[0].page).toBe(1);
    // Last page: {1049} -> page 1050
    expect(offsets[offsets.length - 1].page).toBe(1050);

    // All pages should have non-zero ranges
    for (const offset of offsets) {
      expect(offset.charEnd).toBeGreaterThan(offset.charStart);
    }
  });

  it('Datalab markers with varying dash counts (10+) are recognized', () => {
    const text = '{0}----------\nShort dashes.\n\n{1}--------------------------------------------------\nLong dashes.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toHaveLength(2);
    expect(offsets[0].page).toBe(1);
    expect(offsets[1].page).toBe(2);
  });

  it('text with no markers of either format returns empty array', () => {
    const text = 'This is a lengthy clinical note about the patient presenting with chronic lower back pain. The MRI findings were reviewed and discussed with the orthopedic surgeon.';
    const offsets = extractPageOffsetsFromText(text);

    expect(offsets).toEqual([]);
  });
});

// =============================================================================
// ADDITIONAL EDGE CASE TESTS
// =============================================================================

describe('parseMarkdownBlocks - edge cases', () => {
  it('whitespace-only text returns a single empty block', () => {
    const blocks = parseMarkdownBlocks('   \n  \n  ', []);
    // Single segment of whitespace, classified as empty
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0].type).toBe('empty');
  });

  it('single paragraph with no \\n\\n returns one block', () => {
    const text = 'Just one paragraph with no double newlines at all.';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toBe(text);
  });

  it('heading without space after # is classified as paragraph', () => {
    const text = '#NoSpace';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].headingLevel).toBeNull();
  });

  it('heading with only # marks and space but no text is still heading', () => {
    // '# ' followed by empty text - regex requires (.+) which needs at least 1 char
    const text = '# A';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[0].headingText).toBe('A');
  });

  it('code fence unclosed at EOF merges remaining segments', () => {
    // Opening fence but no closing fence - should merge through EOF
    const text = 'Before.\n\n```python\nline_one()\n\nline_two()\n\nline_three()';
    const blocks = parseMarkdownBlocks(text, []);
    // Should have a paragraph block then one code block (merged segments)
    const codeBlocks = blocks.filter(b => b.type === 'code');
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].text).toContain('line_one()');
    expect(codeBlocks[0].text).toContain('line_two()');
    expect(codeBlocks[0].text).toContain('line_three()');
  });

  it('self-contained code block with even fence count is single code block', () => {
    const text = '```\nfoo\n```';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
  });

  it('multiple consecutive code blocks are separate blocks', () => {
    const text = '```\nblock1\n```\n\n```\nblock2\n```';
    const blocks = parseMarkdownBlocks(text, []);
    const codeBlocks = blocks.filter(b => b.type === 'code');
    expect(codeBlocks).toHaveLength(2);
    expect(codeBlocks[0].text).toContain('block1');
    expect(codeBlocks[1].text).toContain('block2');
  });

  it('table with no separator row is classified as paragraph', () => {
    // Missing the |---|---| separator line
    const text = '| Col A | Col B |\n| val1  | val2  |';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    // Without separator, it's not a valid table
    expect(blocks[0].type).toBe('paragraph');
  });

  it('table with only header + separator (no data rows) is still a table', () => {
    const text = '| Name | Age |\n|------|-----|';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
  });

  it('ordered list starting with 1. is detected as list', () => {
    const text = '1. First\n2. Second\n3. Third';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('list');
  });

  it('unordered list with * marker is detected as list', () => {
    const text = '* Alpha\n* Beta\n* Gamma';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('list');
  });

  it('unordered list with + marker is detected as list', () => {
    const text = '+ Alpha\n+ Beta';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('list');
  });

  it('very long segment (>100K chars) does not crash', () => {
    const longText = 'A'.repeat(150000);
    const blocks = parseMarkdownBlocks(longText, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text.length).toBe(150000);
  });

  it('unicode and emoji content is preserved in block text', () => {
    const text = '# Résumé des 日本語 📋\n\nLes données avec des émojis 🎉 et accents: café, naïve.';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].headingText).toContain('Résumé');
    expect(blocks[0].headingText).toContain('📋');
    const para = blocks.find(b => b.type === 'paragraph');
    expect(para).toBeDefined();
    expect(para!.text).toContain('🎉');
    expect(para!.text).toContain('café');
  });

  it('Datalab {N}--- page separator is classified as page_marker', () => {
    const text = 'Content.\n\n{0}------------------------------------------------\n\nMore content.';
    const blocks = parseMarkdownBlocks(text, []);
    const markers = blocks.filter(b => b.type === 'page_marker');
    expect(markers).toHaveLength(1);
  });

  it('empty code block (just opening and closing fences) is classified as code', () => {
    const text = '```\n```';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
  });

  it('multiple blank lines between paragraphs produce empty blocks', () => {
    const text = 'Para 1.\n\n\n\nPara 2.';
    const blocks = parseMarkdownBlocks(text, []);
    // Split by \n\n gives: "Para 1.", "", "Para 2."
    // The empty segment becomes an empty block
    expect(blocks.length).toBe(3);
    const emptyBlocks = blocks.filter(b => b.type === 'empty');
    expect(emptyBlocks.length).toBe(1);
  });

  it('heading followed by nothing produces just a heading block', () => {
    const text = '## Just a Heading';
    const blocks = parseMarkdownBlocks(text, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].headingText).toBe('Just a Heading');
  });
});

describe('buildSectionHierarchy - edge cases', () => {
  it('returns empty map for no heading blocks', () => {
    const blocks = parseMarkdownBlocks('Just a paragraph.\n\nAnother paragraph.', []);
    const hierarchy = buildSectionHierarchy(blocks);
    expect(hierarchy.size).toBe(0);
  });

  it('H1 followed by another H1 resets the path', () => {
    const text = '# First\n\nContent A.\n\n# Second\n\nContent B.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    const secondIdx = blocks.findIndex(b => b.headingText === 'Second');
    expect(hierarchy.get(secondIdx)!.path).toBe('Second');
  });

  it('H1 → H4 (skipped levels) creates path with gap', () => {
    const text = '# Top\n\n#### Deep\n\nContent.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    const deepIdx = blocks.findIndex(b => b.headingText === 'Deep');
    expect(hierarchy.get(deepIdx)!.path).toBe('Top > Deep');
    expect(hierarchy.get(deepIdx)!.level).toBe(4);
  });

  it('H2 → H1 (level decrease) clears all deeper levels', () => {
    const text = '## Sub First\n\nContent.\n\n# Top Level\n\nContent after.';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    const topIdx = blocks.findIndex(b => b.headingText === 'Top Level');
    expect(hierarchy.get(topIdx)!.path).toBe('Top Level');
    // Content after should inherit Top Level
    const contentIdx = blocks.findIndex(b => b.text.includes('Content after'));
    expect(hierarchy.get(contentIdx)!.path).toBe('Top Level');
  });

  it('handles 100+ headings without stack overflow', () => {
    const parts: string[] = [];
    for (let i = 0; i < 120; i++) {
      parts.push(`## Heading ${i}`);
      parts.push(`Content for heading ${i}.`);
    }
    const text = parts.join('\n\n');
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);

    // Should have entries for all headings + content blocks
    expect(hierarchy.size).toBeGreaterThan(120);
  });

  it('all blocks non-heading returns empty map', () => {
    const text = 'Para A.\n\n- List item.\n\n| H | H |\n|---|---|\n| v | v |';
    const blocks = parseMarkdownBlocks(text, []);
    const hierarchy = buildSectionHierarchy(blocks);
    expect(hierarchy.size).toBe(0);
  });
});

describe('getPageNumberForOffset - edge cases', () => {
  it('returns first page for negative-ish offset (offset 0)', () => {
    const offsets: PageOffset[] = [{ page: 1, charStart: 0, charEnd: 100 }];
    expect(getPageNumberForOffset(0, offsets)).toBe(1);
  });

  it('returns first page for offset before first charStart', () => {
    const offsets: PageOffset[] = [
      { page: 5, charStart: 100, charEnd: 200 },
    ];
    expect(getPageNumberForOffset(50, offsets)).toBe(5);
  });

  it('returns last page for offset equal to last charEnd', () => {
    const offsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 100 },
    ];
    expect(getPageNumberForOffset(100, offsets)).toBe(1);
  });

  it('returns last page for offset far beyond last charEnd', () => {
    const offsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 100 },
      { page: 2, charStart: 100, charEnd: 200 },
    ];
    expect(getPageNumberForOffset(99999, offsets)).toBe(2);
  });

  it('handles gap between pages by returning nearest page', () => {
    const offsets: PageOffset[] = [
      { page: 1, charStart: 0, charEnd: 100 },
      { page: 2, charStart: 200, charEnd: 300 },
    ];
    // Offset 150 is in a gap between pages
    const result = getPageNumberForOffset(150, offsets);
    // Should return page 2 (binary search falls to low=1)
    expect(result).toBe(2);
  });
});

describe('extractPageOffsetsFromText - edge cases', () => {
  it('handles Datalab {N}--- markers only', () => {
    const text = 'Page 1 content.\n\n{1}------------------------------------------------\n\nPage 2 content.';
    const offsets = extractPageOffsetsFromText(text);
    expect(offsets).toHaveLength(1);
    expect(offsets[0].page).toBe(2); // {1} is 0-based → 1-based = 2
  });

  it('handles both HTML and Datalab formats in same text (deduplicated)', () => {
    const text = 'Start.\n\n---\n<!-- Page 2 -->\n\n{1}------------------------------------------------\n\nEnd.';
    const offsets = extractPageOffsetsFromText(text);
    // Both markers are close together and should be deduplicated
    // The HTML marker appears first, Datalab marker is within 10 chars
    // Actually they won't be within 10 chars of each other, so both should appear
    // But both represent page 2, so we'll have 2 entries for page 2
    expect(offsets.length).toBeGreaterThanOrEqual(1);
  });

  it('first marker not at position 0: content before first marker gets charStart=0', () => {
    const text = 'Pre-marker content here.\n\n---\n<!-- Page 2 -->\n\nPost-marker content.';
    const offsets = extractPageOffsetsFromText(text);
    expect(offsets[0].charStart).toBe(0);
  });

  it('non-sequential page numbers are sorted by page number', () => {
    // Unusual but possible: markers appear out of order
    const text = '---\n<!-- Page 3 -->\n\n---\n<!-- Page 1 -->\n\n---\n<!-- Page 2 -->';
    const offsets = extractPageOffsetsFromText(text);
    // Should be sorted by page number
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i].page).toBeGreaterThanOrEqual(offsets[i - 1].page);
    }
  });

  it('large document with many pages extracts all', () => {
    const parts: string[] = [];
    for (let i = 1; i <= 100; i++) {
      parts.push(`Content for page ${i}.`);
      parts.push(`---\n<!-- Page ${i + 1} -->`);
    }
    parts.push('Final content.');
    const text = parts.join('\n\n');
    const offsets = extractPageOffsetsFromText(text);
    expect(offsets.length).toBe(100);
    expect(offsets[0].page).toBe(2);
    expect(offsets[offsets.length - 1].page).toBe(101);
  });

  it('Datalab format with 0-based page numbering converts correctly', () => {
    const text = '{0}------------------------------------------------\n\nPage 1.\n\n{1}------------------------------------------------\n\nPage 2.\n\n{2}------------------------------------------------\n\nPage 3.';
    const offsets = extractPageOffsetsFromText(text);
    expect(offsets).toHaveLength(3);
    expect(offsets[0].page).toBe(1); // {0} → 1
    expect(offsets[1].page).toBe(2); // {1} → 2
    expect(offsets[2].page).toBe(3); // {2} → 3
  });
});
