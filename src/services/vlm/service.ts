/**
 * VLM Service - Gemini 3 Multimodal Image Analysis
 *
 * Provides high-level API for analyzing images from legal and medical documents
 * using Google Gemini 3 Flash multimodal capabilities.
 *
 * @module services/vlm/service
 */

import { GeminiClient, getSharedClient, type FileRef } from '../gemini/index.js';
import {
  LEGAL_IMAGE_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  DEEP_ANALYSIS_PROMPT,
  UNIVERSAL_EVALUATION_PROMPT,
  UNIVERSAL_EVALUATION_SCHEMA,
  createContextPrompt,
  IMAGE_ANALYSIS_SCHEMA,
  CLASSIFICATION_SCHEMA,
} from './prompts.js';

/**
 * Structured analysis result from VLM
 */
export interface ImageAnalysis {
  imageType: string;
  primarySubject: string;
  paragraph1: string;
  paragraph2: string;
  paragraph3: string;
  extractedText: string[];
  dates: string[];
  names: string[];
  numbers: string[];
  confidence: number;
}

/**
 * Complete VLM result with metadata
 */
export interface VLMAnalysisResult {
  /** Combined description paragraphs */
  description: string;
  /** Structured analysis data */
  analysis: ImageAnalysis;
  /** Model used for analysis */
  model: string;
  /** Processing time in milliseconds */
  processingTimeMs: number;
  /** Total tokens used */
  tokensUsed: number;
}

/**
 * Quick classification result
 */
export interface ImageClassification {
  type: string;
  hasText: boolean;
  textDensity: string;
  complexity: string;
  confidence: number;
}

/**
 * Deep analysis result with reasoning steps
 */
export interface DeepAnalysisResult {
  thinkingSteps: string[];
  imageType: string;
  fullDescription: string;
  extractedData: {
    text: string[];
    dates: string[];
    amounts: string[];
    names: string[];
    references: string[];
  };
  legalSignificance: string;
  medicalSignificance?: string;
  uncertainties: string[];
  confidence: number;
}

/**
 * Options for image description
 */
export interface DescribeImageOptions {
  /** Surrounding text context from document */
  contextText?: string;
  /** Use high resolution mode */
  highResolution?: boolean;
  /** Use universal blind-person-detail prompt (default: true) */
  useUniversalPrompt?: boolean;
}

/**
 * VLMService - High-level Gemini multimodal image analysis
 *
 * Provides methods for:
 * - describeImage: Detailed legal/medical image analysis
 * - classifyImage: Quick categorization
 * - analyzeDeep: Extended reasoning analysis
 * - batch operations for multiple images
 */
export class VLMService {
  private readonly client: GeminiClient;

  constructor(client?: GeminiClient) {
    this.client = client ?? getSharedClient();
  }

  /**
   * Generate detailed description of an image from a legal/medical document.
   *
   * @param imagePath - Path to the image file
   * @param options - Analysis options
   * @returns VLMAnalysisResult with description and structured data
   */
  async describeImage(
    imagePath: string,
    options: DescribeImageOptions = {}
  ): Promise<VLMAnalysisResult> {
    const fileRef = GeminiClient.fileRefFromPath(imagePath);
    return this.analyzeFileRef(fileRef, options);
  }

  /**
   * Analyze image from a FileRef (already loaded buffer).
   *
   * @param fileRef - Pre-loaded file reference
   * @param options - Analysis options
   * @returns VLMAnalysisResult
   */
  async describeImageFromRef(
    fileRef: FileRef,
    options: DescribeImageOptions = {}
  ): Promise<VLMAnalysisResult> {
    return this.analyzeFileRef(fileRef, options);
  }

  /**
   * Core analysis logic shared by describeImage and describeImageFromRef.
   */
  private async analyzeFileRef(
    fileRef: FileRef,
    options: DescribeImageOptions
  ): Promise<VLMAnalysisResult> {
    const { prompt, schema } = this.selectPromptAndSchema(options);

    const response = await this.client.analyzeImage(prompt, fileRef, {
      schema,
      mediaResolution:
        options.highResolution !== false ? 'MEDIA_RESOLUTION_HIGH' : 'MEDIA_RESOLUTION_LOW',
    });

    const analysis = this.parseAnalysis(response.text);
    const description = [analysis.paragraph1, analysis.paragraph2, analysis.paragraph3]
      .filter(Boolean)
      .join('\n\n');

    return {
      description,
      analysis,
      model: response.model,
      processingTimeMs: response.processingTimeMs,
      tokensUsed: response.usage.totalTokens,
    };
  }

  /**
   * Select prompt and schema based on analysis options.
   * Universal prompt is the default for all images.
   */
  private selectPromptAndSchema(options: DescribeImageOptions): { prompt: string; schema: object } {
    if (options.useUniversalPrompt !== false) {
      return { prompt: UNIVERSAL_EVALUATION_PROMPT, schema: UNIVERSAL_EVALUATION_SCHEMA };
    }
    if (options.contextText) {
      return {
        prompt: createContextPrompt(options.contextText),
        schema: IMAGE_ANALYSIS_SCHEMA,
      };
    }
    return { prompt: LEGAL_IMAGE_PROMPT, schema: IMAGE_ANALYSIS_SCHEMA };
  }

  /**
   * Quick classification of an image.
   *
   * @param imagePath - Path to the image file
   * @returns ImageClassification with type and complexity
   */
  async classifyImage(imagePath: string): Promise<ImageClassification> {
    const fileRef = GeminiClient.fileRefFromPath(imagePath);

    const response = await this.client.analyzeImage(CLASSIFY_IMAGE_PROMPT, fileRef, {
      schema: CLASSIFICATION_SCHEMA,
      mediaResolution: 'MEDIA_RESOLUTION_LOW', // Low res for classification
    });

    return this.parseClassification(response.text);
  }

  /**
   * Deep analysis using extended reasoning.
   *
   * @param imagePath - Path to the image file
   * @returns DeepAnalysisResult with reasoning steps
   */
  async analyzeDeep(imagePath: string): Promise<VLMAnalysisResult> {
    const fileRef = GeminiClient.fileRefFromPath(imagePath);

    const response = await this.client.analyzeImage(DEEP_ANALYSIS_PROMPT, fileRef, {
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
      thinkingConfig: { thinkingLevel: 'HIGH' },
    });

    const deepResult = this.parseDeepAnalysis(response.text);
    const analysis = this.convertDeepToStandardAnalysis(deepResult);

    return {
      description: deepResult.fullDescription || '',
      analysis,
      model: response.model,
      processingTimeMs: response.processingTimeMs,
      tokensUsed: response.usage.totalTokens,
    };
  }

  /**
   * Get service status including Gemini client status.
   */
  getStatus() {
    return this.client.getStatus();
  }

  /**
   * Parse a VLM JSON response, stripping markdown fences.
   *
   * When thinking mode is enabled, responseMimeType: 'application/json' is incompatible,
   * so Gemini may include reasoning preamble before the JSON block. This method handles
   * that by: (0) rejecting empty/blank responses immediately, (1) stripping code fences,
   * (2) trying full text parse, (3) extracting the outermost JSON object from mixed text,
   * (4) throwing with diagnostics on failure.
   */
  private parseVLMJson<T>(text: string, label: string): T {
    // Step 0: Reject empty/blank responses immediately with a clear error
    if (!text || text.trim().length === 0) {
      console.error(`[VLMService] Gemini returned empty response for ${label}`);
      throw new Error(
        `VLM ${label} failed: Gemini returned an empty response. ` +
          `The image may be too small, corrupted, or unprocessable by the model.`
      );
    }

    // Step 1: Strip markdown code fences
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();

    // Step 2: Try parsing the full cleaned text
    try {
      return JSON.parse(clean) as T;
    } catch (error) {
      console.error(`[VLMService] Failed to parse full cleaned text as JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Step 3: Extract JSON object from mixed text (reasoning preamble + JSON)
    // Find the first '{' and last '}' to isolate the JSON block
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const jsonCandidate = clean.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(jsonCandidate) as T;
      } catch (error) {
        console.error(`[VLMService] Failed to parse extracted JSON substring for ${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Step 4: All extraction attempts failed - throw with diagnostics
    console.error(`[VLMService] Failed to parse ${label} JSON from response`);
    throw new Error(
      `VLM ${label} JSON parse failed: could not extract valid JSON from response. ` +
        `Raw response (first 500 chars): ${text.slice(0, 500)}`
    );
  }

  /**
   * Parse JSON response into ImageAnalysis structure.
   */
  private parseAnalysis(text: string): ImageAnalysis {
    const parsed = this.parseVLMJson<Partial<ImageAnalysis>>(text, 'analysis');

    return {
      imageType: parsed.imageType || 'unknown',
      primarySubject: parsed.primarySubject || '',
      paragraph1: parsed.paragraph1 || '',
      paragraph2: parsed.paragraph2 || '',
      paragraph3: parsed.paragraph3 || '',
      extractedText: parsed.extractedText || [],
      dates: parsed.dates || [],
      names: parsed.names || [],
      numbers: parsed.numbers || [],
      confidence: parsed.confidence ?? 0.5,
    };
  }

  /**
   * Parse classification response.
   */
  private parseClassification(text: string): ImageClassification {
    const parsed = this.parseVLMJson<Partial<ImageClassification>>(text, 'classification');

    return {
      type: parsed.type || 'other',
      hasText: parsed.hasText ?? false,
      textDensity: parsed.textDensity || 'unknown',
      complexity: parsed.complexity || 'medium',
      confidence: parsed.confidence ?? 0.5,
    };
  }

  /**
   * Parse deep analysis response.
   */
  private parseDeepAnalysis(text: string): DeepAnalysisResult {
    const parsed = this.parseVLMJson<Partial<DeepAnalysisResult>>(text, 'deep analysis');

    return {
      thinkingSteps: parsed.thinkingSteps || [],
      imageType: parsed.imageType || 'unknown',
      fullDescription: parsed.fullDescription || text,
      extractedData: {
        text: parsed.extractedData?.text || [],
        dates: parsed.extractedData?.dates || [],
        amounts: parsed.extractedData?.amounts || [],
        names: parsed.extractedData?.names || [],
        references: parsed.extractedData?.references || [],
      },
      legalSignificance: parsed.legalSignificance || '',
      medicalSignificance: parsed.medicalSignificance,
      uncertainties: parsed.uncertainties || [],
      confidence: parsed.confidence ?? 0.5,
    };
  }

  /**
   * Convert deep analysis to standard ImageAnalysis format.
   */
  private convertDeepToStandardAnalysis(deep: DeepAnalysisResult): ImageAnalysis {
    return {
      imageType: deep.imageType,
      primarySubject: deep.fullDescription.slice(0, 200),
      paragraph1: deep.thinkingSteps.slice(0, 3).join(' ') || deep.fullDescription.slice(0, 300),
      paragraph2: deep.fullDescription,
      paragraph3: [deep.legalSignificance, deep.medicalSignificance].filter(Boolean).join(' '),
      extractedText: deep.extractedData.text,
      dates: deep.extractedData.dates,
      names: deep.extractedData.names,
      numbers: [...deep.extractedData.amounts, ...deep.extractedData.references],
      confidence: deep.confidence,
    };
  }
}

// Singleton management
let _service: VLMService | null = null;

/**
 * Get or create VLMService singleton.
 */
export function getVLMService(): VLMService {
  if (!_service) {
    _service = new VLMService();
  }
  return _service;
}

/**
 * Reset singleton for testing.
 */
export function resetVLMService(): void {
  _service = null;
}
