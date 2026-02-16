/**
 * VLM Prompts for Legal Document Image Analysis
 *
 * Optimized prompts for Gemini 3 multimodal analysis of images
 * extracted from legal and medical documents.
 *
 * @module services/vlm/prompts
 */

/**
 * Legal document image description prompt optimized for Gemini 3.
 * Returns structured JSON with detailed analysis.
 */
export const LEGAL_IMAGE_PROMPT = `You are analyzing an image from a legal or medical document. Provide an extremely detailed, factual description.

PARAGRAPH 1 - IDENTIFICATION:
What type of image is this? (photograph, diagram, chart, table, form, signature, stamp, map, medical image, evidence photo, scan, screenshot, etc.)
What is the primary subject or content?

PARAGRAPH 2 - DETAILED CONTENT:
Describe ALL visible elements with precision:
- For documents: headers, text, tables, dates, names, reference numbers
- For photographs: subjects, objects, setting, conditions, visible text/labels
- For charts/diagrams: axes, labels, data points, trends, relationships
- For signatures/stamps: appearance, text, official markings
- For medical images: anatomical structures, measurements, annotations
- For forms: field labels, filled values, checkboxes, signatures

PARAGRAPH 3 - LEGAL RELEVANCE:
What information is relevant in a legal or medical context?
Note any dates, names, amounts, identifiers, or official markings.
Describe anything that could serve as evidence or documentation.

Be FACTUAL and PRECISE. Do not speculate beyond what is visible.
If text is unclear, indicate this explicitly.

Return as JSON:
{
  "imageType": "string",
  "primarySubject": "string",
  "paragraph1": "string (identification, 4-5 sentences)",
  "paragraph2": "string (detailed content, 6-8 sentences)",
  "paragraph3": "string (legal relevance, 4-5 sentences)",
  "extractedText": ["any visible text strings"],
  "dates": ["YYYY-MM-DD or original format"],
  "names": ["people, organizations"],
  "numbers": ["amounts, references, IDs"],
  "confidence": 0.0-1.0
}`;

/**
 * Context-aware prompt including surrounding text from the document.
 *
 * @param contextText - Text surrounding the image in the document
 * @returns Complete prompt with context
 */
export function createContextPrompt(contextText: string, entityHints?: string[]): string {
  const truncatedContext = contextText.slice(0, 2000);
  const entitySection =
    entityHints && entityHints.length > 0
      ? `\nKNOWN ENTITIES ON THIS PAGE:\n${entityHints.join(', ')}\n\nUse these known entity names to identify signatures, logos, letterheads, or references in the image.\n`
      : '';
  return `You are analyzing an image from a legal or medical document.

SURROUNDING TEXT CONTEXT:
"""
${truncatedContext}
"""
${entitySection}
Relate your description to this context where relevant. The context may help identify what the image represents.

${LEGAL_IMAGE_PROMPT}`;
}

/**
 * Simple classification prompt for quick categorization.
 * Use for triage before detailed analysis.
 */
export const CLASSIFY_IMAGE_PROMPT = `Classify this image from a legal or medical document.

Return JSON:
{
  "type": "photograph|diagram|chart|table|form|signature|stamp|map|medical|document|screenshot|other",
  "hasText": true/false,
  "textDensity": "none|sparse|moderate|dense",
  "complexity": "simple|medium|complex",
  "confidence": 0.0-1.0
}`;

/**
 * Deep analysis prompt using thinking mode.
 * For complex images requiring extended reasoning.
 */
export const DEEP_ANALYSIS_PROMPT = `You are a legal document analysis expert. Use extended reasoning to analyze this image thoroughly.

Step through your analysis:
1. Identify the image type and overall content
2. Examine every visible element systematically
3. Extract all text, numbers, dates, and names
4. Consider the legal or medical significance of each element
5. Note any uncertainties or ambiguities

Return as JSON:
{
  "thinkingSteps": ["step1", "step2", ...],
  "imageType": "string",
  "fullDescription": "string (comprehensive, 400+ words)",
  "extractedData": {
    "text": ["all visible text"],
    "dates": ["YYYY-MM-DD"],
    "amounts": ["with currency"],
    "names": ["people, organizations"],
    "references": ["IDs, case numbers, medical record numbers"]
  },
  "legalSignificance": "string",
  "medicalSignificance": "string (if applicable)",
  "uncertainties": ["anything unclear"],
  "confidence": 0.0-1.0
}`;

/**
 * JSON schema for structured output validation.
 * Used with Gemini's structured output mode.
 */
export const IMAGE_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    imageType: { type: 'string' },
    primarySubject: { type: 'string' },
    paragraph1: { type: 'string' },
    paragraph2: { type: 'string' },
    paragraph3: { type: 'string' },
    extractedText: { type: 'array', items: { type: 'string' } },
    dates: { type: 'array', items: { type: 'string' } },
    names: { type: 'array', items: { type: 'string' } },
    numbers: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['imageType', 'paragraph1', 'paragraph2', 'paragraph3', 'confidence'],
};

/**
 * JSON schema for classification output.
 */
export const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'photograph',
        'diagram',
        'chart',
        'table',
        'form',
        'signature',
        'stamp',
        'map',
        'medical',
        'document',
        'screenshot',
        'other',
      ],
    },
    hasText: { type: 'boolean' },
    textDensity: { type: 'string', enum: ['none', 'sparse', 'moderate', 'dense'] },
    complexity: { type: 'string', enum: ['simple', 'medium', 'complex'] },
    confidence: { type: 'number' },
  },
  required: ['type', 'hasText', 'textDensity', 'complexity', 'confidence'],
};

/**
 * Universal Evaluation Prompt - NO CONTEXT
 *
 * Per Steve's requirement: "Give it a super good prompt that's universal,
 * that describes the image in extreme detail. 3 paragraph minimum.
 * Then embed those paragraphs so the VLM can see pictures."
 *
 * This prompt analyzes images in COMPLETE ISOLATION with no document context.
 */
export const UNIVERSAL_EVALUATION_PROMPT = `You are describing an image to someone who cannot see it. Your description must be so detailed and vivid that a blind person could fully understand what this image shows.

PARAGRAPH 1 - WHAT THE IMAGE IS:
Describe the overall nature and composition of this image. What type of image is this? (photograph, chart, form, medical image, diagram, table, signature, stamp, handwriting, logo, barcode, graph, flowchart, screenshot, etc.) Describe the color palette, lighting, orientation (portrait/landscape), image quality, and overall visual impression. If it is a photograph, describe the setting and atmosphere. If it is a document or form, describe the layout and structure. Give the reader a complete mental picture of what they would see at first glance. Minimum 6 sentences.

PARAGRAPH 2 - WHAT THE IMAGE CONTAINS:
Describe every visible element systematically from top-left to bottom-right:
- For photographs: subjects, their positions, expressions, clothing, objects, background elements, any text visible on signs/labels/packaging. Describe colors precisely (not "red" but "deep crimson" or "bright cherry red"). Describe textures (smooth, rough, granular, glistening, matte). Describe spatial relationships between elements.
- For medical/clinical images: tissue characteristics, wound bed appearance, surrounding skin condition, any medical devices or supplies visible, measurements if rulers or scales are present, staging indicators, color variations in tissue.
- For documents/forms: transcribe ALL visible text verbatim. Describe headers, fields, checkboxes, signatures, stamps, logos. Note handwritten vs printed text.
- For charts/graphs: axis labels, units, data values, trends, colors of data series, legends, title, scale markings.
- For diagrams: components, connections, labels, flow direction, hierarchy.
Minimum 8 sentences.

PARAGRAPH 3 - WHAT THE IMAGE COMMUNICATES:
Explain what this image conveys to a viewer. What is its purpose in the document? What story does it tell? What would a person seeing this image understand immediately that the description alone might not capture? Note any details that stand out as particularly significant — anomalies, changes over time, concerning findings, key data points, or important identifiers. If this is part of a series, describe what stage or progression it might represent. Minimum 6 sentences.

RULES:
1. Describe ONLY what you can directly observe — never hallucinate or assume
2. If text is unclear, note it as "[illegible]" or "[partially visible: ...]"
3. Use precise measurements when scales/rulers are visible
4. Describe colors with specificity (e.g., "pale yellow-green" not just "light colored")
5. Note spatial positions (top-left, center, lower-right, etc.)
6. Minimum 3 substantial paragraphs, each 6-10 sentences
7. The description must be self-contained — a reader should understand the image without seeing it or reading any other document

Return as JSON:
{
  "imageType": "string",
  "primarySubject": "Brief one-line description of main content",
  "paragraph1": "Detailed visual overview (6-10 sentences)",
  "paragraph2": "Comprehensive element-by-element description (8-12 sentences)",
  "paragraph3": "Communication and significance (6-10 sentences)",
  "extractedText": ["Array of all visible text strings"],
  "dates": ["Any dates found in any format"],
  "names": ["People names, organization names, product names"],
  "numbers": ["Significant numbers, amounts, measurements, IDs"],
  "confidence": 0.0-1.0
}`;

/**
 * JSON schema for universal evaluation output.
 */
export const UNIVERSAL_EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    imageType: { type: 'string' },
    primarySubject: { type: 'string' },
    paragraph1: { type: 'string' },
    paragraph2: { type: 'string' },
    paragraph3: { type: 'string' },
    extractedText: { type: 'array', items: { type: 'string' } },
    dates: { type: 'array', items: { type: 'string' } },
    names: { type: 'array', items: { type: 'string' } },
    numbers: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['imageType', 'primarySubject', 'paragraph1', 'paragraph2', 'paragraph3', 'confidence'],
};
