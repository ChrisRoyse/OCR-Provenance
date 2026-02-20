import { describe, it, expect } from 'vitest';
import { normalizeHeadingLevels, HeadingNormalizationConfig } from '../../../../src/services/chunking/heading-normalizer.js';
import { MarkdownBlock } from '../../../../src/services/chunking/markdown-parser.js';
import { buildSectionHierarchy } from '../../../../src/services/chunking/markdown-parser.js';

function makeHeading(text: string, level: number, idx: number): MarkdownBlock {
  return {
    type: 'heading',
    text: `${'#'.repeat(level)} ${text}`,
    startOffset: idx * 100,
    endOffset: idx * 100 + text.length + level + 1,
    headingLevel: level,
    headingText: text,
    pageNumber: 1,
  };
}

function makeParagraph(text: string, idx: number): MarkdownBlock {
  return {
    type: 'paragraph',
    text,
    startOffset: idx * 100,
    endOffset: idx * 100 + text.length,
    headingLevel: null,
    headingText: null,
    pageNumber: 1,
  };
}

describe('normalizeHeadingLevels', () => {
  const enabledConfig: HeadingNormalizationConfig = { enabled: true };

  it('returns blocks unchanged when disabled', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 2, 1),
      makeHeading('ARTICLE 3', 3, 2),
      makeHeading('ARTICLE 4', 2, 3),
    ];
    const config: HeadingNormalizationConfig = { enabled: false };
    normalizeHeadingLevels(blocks, config);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(3);
    expect(blocks[3].headingLevel).toBe(2);
  });

  it('normalizes ARTICLE headings to mode level', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeParagraph('Content for article 1', 1),
      makeHeading('ARTICLE 2', 2, 2),
      makeParagraph('Content for article 2', 3),
      makeHeading('ARTICLE 3', 2, 4),
      makeParagraph('Content for article 3', 5),
      makeHeading('ARTICLE 4', 2, 6),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // Mode is H2 (3 occurrences vs 1 for H1)
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
    expect(blocks[4].headingLevel).toBe(2);
    expect(blocks[6].headingLevel).toBe(2);
    // Non-heading blocks are unaffected
    expect(blocks[1].headingLevel).toBeNull();
  });

  it('respects minPatternCount threshold', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 2, 1),
    ];
    const config: HeadingNormalizationConfig = { enabled: true, minPatternCount: 3 };
    normalizeHeadingLevels(blocks, config);
    // Only 2 ARTICLEs, below threshold of 3 - no change
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
  });

  it('normalizes Section headings independently from Article headings', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('Section 1.1', 3, 1),
      makeHeading('ARTICLE 2', 2, 2),
      makeHeading('Section 2.1', 2, 3),
      makeHeading('ARTICLE 3', 2, 4),
      makeHeading('Section 3.1', 2, 5),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // ARTICLE: mode is H2 (2 vs 1)
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
    expect(blocks[4].headingLevel).toBe(2);
    // Section: mode is H2 (2 vs 1)
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[3].headingLevel).toBe(2);
    expect(blocks[5].headingLevel).toBe(2);
  });

  it('handles bold-wrapped heading text', () => {
    const blocks = [
      makeHeading('**ARTICLE 1**', 1, 0),
      makeHeading('**ARTICLE 2**', 2, 1),
      makeHeading('**ARTICLE 3**', 2, 2),
    ];
    // Manually set headingText with bold markers
    blocks[0].headingText = '**ARTICLE 1**';
    blocks[1].headingText = '**ARTICLE 2**';
    blocks[2].headingText = '**ARTICLE 3**';

    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('handles mixed case heading text', () => {
    const blocks = [
      makeHeading('Article 1', 1, 0),
      makeHeading('article 2', 3, 1),
      makeHeading('ARTICLE 3', 3, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // Mode is H3 (2 occurrences)
    expect(blocks[0].headingLevel).toBe(3);
    expect(blocks[1].headingLevel).toBe(3);
    expect(blocks[2].headingLevel).toBe(3);
  });

  it('does not modify block.text', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 2, 1),
      makeHeading('ARTICLE 3', 2, 2),
    ];
    const originalTexts = blocks.map(b => b.text);
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks.map(b => b.text)).toEqual(originalTexts);
  });

  it('handles empty blocks array', () => {
    const blocks: MarkdownBlock[] = [];
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks).toEqual([]);
  });

  it('leaves non-pattern headings unchanged', () => {
    const blocks = [
      makeHeading('Introduction', 1, 0),
      makeHeading('Background', 2, 1),
      makeHeading('Summary', 3, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(3);
  });

  it('handles Chapter and Part patterns', () => {
    const blocks = [
      makeHeading('CHAPTER 1', 1, 0),
      makeHeading('CHAPTER 2', 2, 1),
      makeHeading('CHAPTER 3', 2, 2),
      makeHeading('PART 1', 1, 3),
      makeHeading('PART 2', 3, 4),
      makeHeading('PART 3', 3, 5),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // CHAPTER: mode H2
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
    // PART: mode H3
    expect(blocks[3].headingLevel).toBe(3);
    expect(blocks[4].headingLevel).toBe(3);
    expect(blocks[5].headingLevel).toBe(3);
  });

  it('integrates correctly with buildSectionHierarchy', () => {
    // Simulate Datalab giving ARTICLE 1 as H1 but rest as H3
    const blocks: MarkdownBlock[] = [
      makeHeading('ARTICLE 1', 1, 0),
      makeParagraph('Content A', 1),
      makeHeading('Section 1.1', 3, 2),
      makeParagraph('Content B', 3),
      makeHeading('ARTICLE 2', 3, 4), // Wrong: should be H1
      makeParagraph('Content C', 5),
      makeHeading('ARTICLE 3', 3, 6), // Wrong: should be H1
    ];

    // Without normalization, ARTICLE 2 and 3 nest under Section 1.1
    const sectionsBefore = buildSectionHierarchy(blocks);
    const pathBefore = sectionsBefore.get(4)?.path;
    // ARTICLE 2 at H3 would be at same level as Section 1.1
    expect(pathBefore).toContain('ARTICLE 1');

    // After normalization, ARTICLEs become H3 (mode), but all at same level
    normalizeHeadingLevels(blocks, enabledConfig);
    const sectionsAfter = buildSectionHierarchy(blocks);

    // ARTICLE 2 should now be a top-level section, not nested under ARTICLE 1
    const pathAfter = sectionsAfter.get(4)?.path;
    expect(pathAfter).toBe('ARTICLE 2');
  });
});

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe('normalizeHeadingLevels - edge cases', () => {
  const enabledConfig: HeadingNormalizationConfig = { enabled: true };

  it('SECTION headings with nested numbering (e.g. 3.2.1) are matched', () => {
    const blocks = [
      makeHeading('SECTION 1', 2, 0),
      makeParagraph('Content', 1),
      makeHeading('SECTION 2.1', 3, 2),
      makeParagraph('Content', 3),
      makeHeading('SECTION 3.2.1', 3, 4),
      makeParagraph('Content', 5),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // All SECTION headings should be normalized to mode level
    // Mode: H3 has 2 entries, H2 has 1 → mode is H3
    expect(blocks[0].headingLevel).toBe(3);
    expect(blocks[2].headingLevel).toBe(3);
    expect(blocks[4].headingLevel).toBe(3);
  });

  it('APPENDIX headings are normalized', () => {
    const blocks = [
      makeHeading('APPENDIX A', 1, 0),
      makeHeading('APPENDIX B', 2, 1),
      makeHeading('APPENDIX C', 2, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('TITLE and EXHIBIT headings are normalized', () => {
    const blocks = [
      makeHeading('TITLE 1', 1, 0),
      makeHeading('TITLE 2', 3, 1),
      makeHeading('TITLE 3', 3, 2),
      makeHeading('EXHIBIT A', 1, 3),
      makeHeading('EXHIBIT B', 4, 4),
      makeHeading('EXHIBIT C', 4, 5),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(3); // TITLE mode H3
    expect(blocks[3].headingLevel).toBe(4); // EXHIBIT mode H4
  });

  it('heading belonging to unknown pattern (SUBSECTION) is not normalized', () => {
    const blocks = [
      makeHeading('SUBSECTION A', 1, 0),
      makeHeading('SUBSECTION B', 3, 1),
      makeHeading('SUBSECTION C', 3, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // "SUBSECTION" doesn't match any pattern → no normalization
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(3);
    expect(blocks[2].headingLevel).toBe(3);
  });

  it('all headings already at same level → no changes', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 2, 0),
      makeHeading('ARTICLE 2', 2, 1),
      makeHeading('ARTICLE 3', 2, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('tie-breaking: smaller level wins when counts equal', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 1, 1),
      makeHeading('ARTICLE 3', 3, 2),
      makeHeading('ARTICLE 4', 3, 3),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // H1 has 2, H3 has 2 → tie → smaller (H1) wins
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(1);
    expect(blocks[2].headingLevel).toBe(1);
    expect(blocks[3].headingLevel).toBe(1);
  });

  it('SCHEDULE headings are normalized', () => {
    const blocks = [
      makeHeading('SCHEDULE A', 2, 0),
      makeHeading('SCHEDULE B', 4, 1),
      makeHeading('SCHEDULE C', 2, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // Mode H2 (2 entries)
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('config.enabled=false returns blocks with no changes at all', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 3, 1),
      makeHeading('ARTICLE 3', 3, 2),
      makeHeading('ARTICLE 4', 3, 3),
    ];
    const disabledConfig: HeadingNormalizationConfig = { enabled: false };
    const result = normalizeHeadingLevels(blocks, disabledConfig);
    // Returns same array reference
    expect(result).toBe(blocks);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(3);
    expect(blocks[2].headingLevel).toBe(3);
    expect(blocks[3].headingLevel).toBe(3);
  });

  it('no heading blocks in array results in no changes', () => {
    const blocks = [
      makeParagraph('First paragraph of content.', 0),
      makeParagraph('Second paragraph of content.', 1),
      makeParagraph('Third paragraph of content.', 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // All paragraphs untouched
    expect(blocks[0].headingLevel).toBeNull();
    expect(blocks[1].headingLevel).toBeNull();
    expect(blocks[2].headingLevel).toBeNull();
  });

  it('5 ARTICLE headings all at H2 stay at H2 (mode=H2)', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 2, 0),
      makeHeading('ARTICLE 2', 2, 1),
      makeHeading('ARTICLE 3', 2, 2),
      makeHeading('ARTICLE 4', 2, 3),
      makeHeading('ARTICLE 5', 2, 4),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    for (const block of blocks) {
      expect(block.headingLevel).toBe(2);
    }
  });

  it('3 ARTICLE at H1 and 2 at H3: mode=H1, H3 ones normalized to H1', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeParagraph('Content', 1),
      makeHeading('ARTICLE 2', 1, 2),
      makeParagraph('Content', 3),
      makeHeading('ARTICLE 3', 1, 4),
      makeParagraph('Content', 5),
      makeHeading('ARTICLE 4', 3, 6),
      makeParagraph('Content', 7),
      makeHeading('ARTICLE 5', 3, 8),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // Mode is H1 (3 occurrences vs 2 for H3)
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[2].headingLevel).toBe(1);
    expect(blocks[4].headingLevel).toBe(1);
    expect(blocks[6].headingLevel).toBe(1); // was H3, normalized to H1
    expect(blocks[8].headingLevel).toBe(1); // was H3, normalized to H1
  });

  it('fewer than minPatternCount (default 3) results in no normalization', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 3, 1),
    ];
    // Default minPatternCount is 3; only 2 ARTICLE headings
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(1); // unchanged
    expect(blocks[1].headingLevel).toBe(3); // unchanged
  });

  it('fewer than explicit minPatternCount=4 results in no normalization for 3 headings', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 2, 1),
      makeHeading('ARTICLE 3', 2, 2),
    ];
    const config: HeadingNormalizationConfig = { enabled: true, minPatternCount: 4 };
    normalizeHeadingLevels(blocks, config);
    // 3 headings but minPatternCount is 4 → no normalization
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('bold-wrapped patterns (**ARTICLE 1**) are stripped for matching', () => {
    const blocks = [
      makeHeading('**ARTICLE 1**', 2, 0),
      makeHeading('**ARTICLE 2**', 2, 1),
      makeHeading('**ARTICLE 3**', 1, 2),
    ];
    // Manually set headingText with bold markers (as OCR might produce)
    blocks[0].headingText = '**ARTICLE 1**';
    blocks[1].headingText = '**ARTICLE 2**';
    blocks[2].headingText = '**ARTICLE 3**';

    normalizeHeadingLevels(blocks, enabledConfig);
    // Mode is H2 (2 entries), so H1 is normalized to H2
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('mixed case "Article 1" vs "ARTICLE 2" matches same pattern (case-insensitive)', () => {
    const blocks = [
      makeHeading('Article 1', 2, 0),
      makeHeading('ARTICLE 2', 1, 1),
      makeHeading('article 3', 2, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // All match ARTICLE pattern (case-insensitive regex); mode is H2 (2 entries)
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('nested section patterns SECTION 3.2.1 are matched and normalized', () => {
    const blocks = [
      makeHeading('SECTION 1', 2, 0),
      makeHeading('SECTION 2.1', 2, 1),
      makeHeading('SECTION 3.2.1', 3, 2),
      makeHeading('SECTION 4.1.2.3', 2, 3),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // All 4 match SECTION pattern; mode is H2 (3 entries vs 1 for H3)
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2); // was H3, normalized to H2
    expect(blocks[3].headingLevel).toBe(2);
  });
});
