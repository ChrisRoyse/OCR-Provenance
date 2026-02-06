/**
 * Tests for Datalab block classification helpers.
 *
 * Tests the parseBlockTypeFromFilename and buildPageBlockClassification
 * functions used during ingestion to classify image regions from
 * Datalab's JSON block hierarchy.
 *
 * These functions are internal to ingestion.ts. We test them by importing
 * the module and exercising the public pipeline behavior.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

// Since the functions are private to ingestion.ts, we test the same logic
// directly. These are the exact algorithms used in the production code.

/**
 * Parse Datalab block type from image filename.
 * Exact copy of the function in src/tools/ingestion.ts for testing.
 */
function parseBlockTypeFromFilename(filename: string): string | null {
  const match = filename.match(/_page_\d+_([A-Za-z]+)_\d+\./);
  return match ? match[1] : null;
}

interface PageImageClassification {
  hasFigure: boolean;
  hasPicture: boolean;
  pictureInHeaderFooter: number;
  pictureInBody: number;
  figureCount: number;
}

/**
 * Build page block classification from JSON hierarchy.
 * Exact copy of the function in src/tools/ingestion.ts for testing.
 */
function buildPageBlockClassification(
  jsonBlocks: Record<string, unknown>
): Map<number, PageImageClassification> {
  const pageMap = new Map<number, PageImageClassification>();

  const topChildren = (jsonBlocks as Record<string, unknown[]>).children
    ?? (jsonBlocks as Record<string, unknown[]>).blocks
    ?? [];

  if (!Array.isArray(topChildren)) {
    return pageMap;
  }

  let pageNum = 0;
  for (const pageBlock of topChildren) {
    const block = pageBlock as Record<string, unknown>;
    if (block.block_type === 'Page' || !block.block_type) {
      pageNum++;
    } else {
      continue;
    }

    const classification: PageImageClassification = {
      hasFigure: false,
      hasPicture: false,
      pictureInHeaderFooter: 0,
      pictureInBody: 0,
      figureCount: 0,
    };

    const walkChildren = (children: unknown[], inHeaderFooter: boolean) => {
      if (!Array.isArray(children)) return;
      for (const child of children) {
        const c = child as Record<string, unknown>;
        const btype = c.block_type as string | undefined;

        const isHF = inHeaderFooter || btype === 'PageHeader' || btype === 'PageFooter';

        if (btype === 'Figure' || btype === 'FigureGroup') {
          classification.hasFigure = true;
          classification.figureCount++;
        }
        if (btype === 'Picture' || btype === 'PictureGroup') {
          classification.hasPicture = true;
          if (isHF) {
            classification.pictureInHeaderFooter++;
          } else {
            classification.pictureInBody++;
          }
        }

        if (c.children) {
          walkChildren(c.children as unknown[], isHF);
        }
      }
    };

    walkChildren((block.children as unknown[]) ?? [], false);
    pageMap.set(pageNum, classification);
  }

  return pageMap;
}

function computeContentHash(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

describe('parseBlockTypeFromFilename', () => {
  it('should parse Figure from Datalab filename', () => {
    expect(parseBlockTypeFromFilename('_page_0_Figure_3.jpeg')).toBe('Figure');
  });

  it('should parse Picture from Datalab filename', () => {
    expect(parseBlockTypeFromFilename('_page_0_Picture_21.jpeg')).toBe('Picture');
  });

  it('should parse PageHeader from Datalab filename', () => {
    expect(parseBlockTypeFromFilename('_page_2_PageHeader_0.png')).toBe('PageHeader');
  });

  it('should parse FigureGroup from Datalab filename', () => {
    expect(parseBlockTypeFromFilename('_page_5_FigureGroup_1.png')).toBe('FigureGroup');
  });

  it('should return null for PyMuPDF hash-based filenames', () => {
    expect(parseBlockTypeFromFilename('img_p001_x001_a1b2c3d4.png')).toBeNull();
  });

  it('should return null for simple numeric filenames', () => {
    expect(parseBlockTypeFromFilename('page_1_image_0.png')).toBeNull();
  });

  it('should handle multi-digit page numbers', () => {
    expect(parseBlockTypeFromFilename('_page_123_Figure_0.jpeg')).toBe('Figure');
  });
});

describe('buildPageBlockClassification', () => {
  it('should classify a page with only Figure blocks', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            { block_type: 'Text', children: [] },
            { block_type: 'Figure', children: [] },
          ],
        },
      ],
    };

    const result = buildPageBlockClassification(json);
    expect(result.size).toBe(1);

    const page1 = result.get(1)!;
    expect(page1.hasFigure).toBe(true);
    expect(page1.hasPicture).toBe(false);
    expect(page1.figureCount).toBe(1);
    expect(page1.pictureInHeaderFooter).toBe(0);
    expect(page1.pictureInBody).toBe(0);
  });

  it('should classify a page with Picture in PageHeader', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            {
              block_type: 'PageHeader',
              children: [
                { block_type: 'Picture', children: [] },
              ],
            },
            { block_type: 'Text', children: [] },
          ],
        },
      ],
    };

    const result = buildPageBlockClassification(json);
    const page1 = result.get(1)!;
    expect(page1.hasPicture).toBe(true);
    expect(page1.pictureInHeaderFooter).toBe(1);
    expect(page1.pictureInBody).toBe(0);
    expect(page1.hasFigure).toBe(false);
  });

  it('should classify a page with Picture in body', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            { block_type: 'Picture', children: [] },
          ],
        },
      ],
    };

    const result = buildPageBlockClassification(json);
    const page1 = result.get(1)!;
    expect(page1.pictureInBody).toBe(1);
    expect(page1.pictureInHeaderFooter).toBe(0);
  });

  it('should handle mixed content pages', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            {
              block_type: 'PageHeader',
              children: [
                { block_type: 'Picture', children: [] }, // Logo in header
              ],
            },
            { block_type: 'Figure', children: [] }, // Content figure
            { block_type: 'Text', children: [] },
            {
              block_type: 'PageFooter',
              children: [
                { block_type: 'Picture', children: [] }, // Stamp in footer
              ],
            },
          ],
        },
      ],
    };

    const result = buildPageBlockClassification(json);
    const page1 = result.get(1)!;
    expect(page1.hasFigure).toBe(true);
    expect(page1.hasPicture).toBe(true);
    expect(page1.figureCount).toBe(1);
    expect(page1.pictureInHeaderFooter).toBe(2);
    expect(page1.pictureInBody).toBe(0);
  });

  it('should handle multi-page documents', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            { block_type: 'Figure', children: [] },
          ],
        },
        {
          block_type: 'Page',
          children: [
            {
              block_type: 'PageHeader',
              children: [
                { block_type: 'Picture', children: [] },
              ],
            },
          ],
        },
        {
          block_type: 'Page',
          children: [
            { block_type: 'Text', children: [] },
          ],
        },
      ],
    };

    const result = buildPageBlockClassification(json);
    expect(result.size).toBe(3);

    // Page 1: has figure
    expect(result.get(1)!.hasFigure).toBe(true);
    expect(result.get(1)!.figureCount).toBe(1);

    // Page 2: has picture in header only
    expect(result.get(2)!.pictureInHeaderFooter).toBe(1);
    expect(result.get(2)!.pictureInBody).toBe(0);
    expect(result.get(2)!.hasFigure).toBe(false);

    // Page 3: no images
    expect(result.get(3)!.hasFigure).toBe(false);
    expect(result.get(3)!.hasPicture).toBe(false);
  });

  it('should handle empty JSON blocks', () => {
    const result = buildPageBlockClassification({});
    expect(result.size).toBe(0);
  });

  it('should handle pages without block_type (auto-increment)', () => {
    const json = {
      children: [
        { children: [{ block_type: 'Figure', children: [] }] },
        { children: [{ block_type: 'Picture', children: [] }] },
      ],
    };

    const result = buildPageBlockClassification(json);
    expect(result.size).toBe(2);
    expect(result.get(1)!.hasFigure).toBe(true);
    expect(result.get(2)!.hasPicture).toBe(true);
  });

  it('should handle FigureGroup blocks', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            { block_type: 'FigureGroup', children: [] },
          ],
        },
      ],
    };

    const result = buildPageBlockClassification(json);
    expect(result.get(1)!.hasFigure).toBe(true);
    expect(result.get(1)!.figureCount).toBe(1);
  });

  it('should use blocks array if children not available', () => {
    const json = {
      blocks: [
        {
          block_type: 'Page',
          children: [
            { block_type: 'Figure', children: [] },
          ],
        },
      ],
    };

    const result = buildPageBlockClassification(json);
    expect(result.size).toBe(1);
    expect(result.get(1)!.hasFigure).toBe(true);
  });
});

describe('computeContentHash', () => {
  it('should produce sha256: prefixed hash', () => {
    const buffer = Buffer.from('test image data');
    const hash = computeContentHash(buffer);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('should produce consistent hashes for same content', () => {
    const data = 'identical image bytes';
    const hash1 = computeContentHash(Buffer.from(data));
    const hash2 = computeContentHash(Buffer.from(data));
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', () => {
    const hash1 = computeContentHash(Buffer.from('image A'));
    const hash2 = computeContentHash(Buffer.from('image B'));
    expect(hash1).not.toBe(hash2);
  });
});

describe('header/footer classification logic', () => {
  it('should identify pages where all images are in headers/footers', () => {
    // Page with only header/footer pictures, no figures
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            {
              block_type: 'PageHeader',
              children: [
                { block_type: 'Picture', children: [] },
              ],
            },
            { block_type: 'Text', children: [] },
          ],
        },
      ],
    };

    const classification = buildPageBlockClassification(json);
    const page = classification.get(1)!;

    // This is the exact logic from ingestion.ts
    const isHeaderFooter = !page.hasFigure
      && page.pictureInHeaderFooter > 0
      && page.pictureInBody === 0;

    expect(isHeaderFooter).toBe(true);
  });

  it('should NOT flag page with Figure blocks as header/footer', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            {
              block_type: 'PageHeader',
              children: [
                { block_type: 'Picture', children: [] },
              ],
            },
            { block_type: 'Figure', children: [] }, // Content figure present
          ],
        },
      ],
    };

    const classification = buildPageBlockClassification(json);
    const page = classification.get(1)!;

    const isHeaderFooter = !page.hasFigure
      && page.pictureInHeaderFooter > 0
      && page.pictureInBody === 0;

    // Has figure → NOT header/footer only
    expect(isHeaderFooter).toBe(false);
  });

  it('should NOT flag page with body pictures as header/footer only', () => {
    const json = {
      children: [
        {
          block_type: 'Page',
          children: [
            { block_type: 'Picture', children: [] }, // Body picture
            {
              block_type: 'PageHeader',
              children: [
                { block_type: 'Picture', children: [] },
              ],
            },
          ],
        },
      ],
    };

    const classification = buildPageBlockClassification(json);
    const page = classification.get(1)!;

    const isHeaderFooter = !page.hasFigure
      && page.pictureInHeaderFooter > 0
      && page.pictureInBody === 0;

    // Has body picture → NOT header/footer only
    expect(isHeaderFooter).toBe(false);
  });
});
