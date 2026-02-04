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
export function createContextPrompt(contextText: string): string {
  const truncatedContext = contextText.slice(0, 2000);
  return `You are analyzing an image from a legal or medical document.

SURROUNDING TEXT CONTEXT:
"""
${truncatedContext}
"""

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
 * Medical document specific prompt.
 * For images from medical records, charts, or clinical documents.
 */
export const MEDICAL_IMAGE_PROMPT = `You are analyzing an image from a medical document. Provide detailed clinical analysis.

IDENTIFICATION:
What type of medical image or document is this? (lab results, vitals chart, medication list, assessment form, imaging study, wound photo, equipment diagram, etc.)

CLINICAL CONTENT:
Describe all visible clinical information:
- Patient identifiers (redact actual values but note their presence)
- Dates of service, procedures, or observations
- Measurements, values, ranges, units
- Medications, dosages, frequencies
- Diagnoses, conditions, assessments
- Provider names, credentials, signatures

DOCUMENTATION VALUE:
What information is relevant for medical-legal purposes?
Note any standard of care indicators.
Identify any anomalies or concerning findings.

Be FACTUAL. Do not provide medical advice or diagnoses.
Note if any text is illegible.

Return as JSON:
{
  "imageType": "string",
  "documentCategory": "clinical|administrative|diagnostic|pharmaceutical|other",
  "paragraph1": "string (identification)",
  "paragraph2": "string (clinical content)",
  "paragraph3": "string (documentation value)",
  "extractedText": ["visible text strings"],
  "dates": ["service dates"],
  "medications": ["medication names if visible"],
  "measurements": ["values with units"],
  "providers": ["names, credentials"],
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
      enum: ['photograph', 'diagram', 'chart', 'table', 'form', 'signature', 'stamp', 'map', 'medical', 'document', 'screenshot', 'other'],
    },
    hasText: { type: 'boolean' },
    textDensity: { type: 'string', enum: ['none', 'sparse', 'moderate', 'dense'] },
    complexity: { type: 'string', enum: ['simple', 'medium', 'complex'] },
    confidence: { type: 'number' },
  },
  required: ['type', 'hasText', 'textDensity', 'complexity', 'confidence'],
};

/**
 * JSON schema for deep analysis output.
 */
export const DEEP_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    thinkingSteps: { type: 'array', items: { type: 'string' } },
    imageType: { type: 'string' },
    fullDescription: { type: 'string' },
    extractedData: {
      type: 'object',
      properties: {
        text: { type: 'array', items: { type: 'string' } },
        dates: { type: 'array', items: { type: 'string' } },
        amounts: { type: 'array', items: { type: 'string' } },
        names: { type: 'array', items: { type: 'string' } },
        references: { type: 'array', items: { type: 'string' } },
      },
    },
    legalSignificance: { type: 'string' },
    medicalSignificance: { type: 'string' },
    uncertainties: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['imageType', 'fullDescription', 'confidence'],
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
export const UNIVERSAL_EVALUATION_PROMPT = `You are an expert document analyst specializing in medical, legal, and business documents. Analyze this image extracted from a document with NO PRIOR CONTEXT. Describe what you observe in extreme detail.

PARAGRAPH 1 - VISUAL OVERVIEW:
Describe the overall composition, layout, and visual structure. What type of image is this? (chart, form, signature, photo, diagram, table, handwriting, stamp, logo, barcode, medical imaging, graph, flowchart, etc.) Describe colors, orientation, quality, and any visual artifacts or issues.

PARAGRAPH 2 - CONTENT ANALYSIS:
Extract and describe ALL visible content with extreme precision:
- For text: transcribe all readable text, noting font styles, emphasis, and positioning
- For charts/graphs: describe axes, labels, data points, values, trends, and scale
- For forms: describe every field label, filled value, checkbox state, and signature area
- For signatures: describe style (cursive, initials), legibility, date if present, witness marks
- For medical content: note measurements, readings, annotations, anatomical references
- For tables: describe columns, rows, headers, and cell contents
- For photographs: describe subjects, objects, setting, lighting, visible text or labels

PARAGRAPH 3 - SIGNIFICANCE & INTERPRETATION:
Explain what this image likely represents in a document context. What purpose does it serve? What information does it convey that would be important for legal, medical, or business purposes? Note any:
- Anomalies, redactions, or modifications
- Official stamps, seals, or certifications
- Handwritten annotations or corrections
- Quality issues that affect readability
- Potential evidentiary value

CRITICAL RULES:
1. Describe ONLY what you can directly observe - never assume or hallucinate
2. If text is unclear, note it as "[illegible]" or "[partially visible: ...]"
3. Be SPECIFIC with numbers, dates, and names when visible
4. Note the approximate location of elements (top-left, center, bottom, etc.)
5. Minimum 3 substantial paragraphs required

Return as JSON:
{
  "imageType": "chart|form|signature|photo|diagram|table|handwriting|stamp|logo|barcode|medical|graph|flowchart|screenshot|other",
  "primarySubject": "Brief one-line description of main content",
  "paragraph1": "Detailed visual overview (4-6 sentences)",
  "paragraph2": "Comprehensive content analysis (6-10 sentences)",
  "paragraph3": "Significance and interpretation (4-6 sentences)",
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
    imageType: {
      type: 'string',
      enum: ['chart', 'form', 'signature', 'photo', 'diagram', 'table', 'handwriting', 'stamp', 'logo', 'barcode', 'medical', 'graph', 'flowchart', 'screenshot', 'other'],
    },
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
