/**
 * VLM Service - Gemini 3 Multimodal Image Analysis
 *
 * Provides high-level API for analyzing images from legal and medical documents
 * using Google Gemini 3 Flash multimodal capabilities.
 *
 * @module services/vlm/service
 */

import {
  GeminiClient,
  type FileRef,
} from '../gemini/index.js';
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
  /** KG entity names known to be on this page for entity-aware descriptions */
  entityHints?: string[];
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
    this.client = client ?? new GeminiClient();
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
      mediaResolution: options.highResolution !== false
        ? 'MEDIA_RESOLUTION_HIGH'
        : 'MEDIA_RESOLUTION_LOW',
    });

    const analysis = this.parseAnalysis(response.text);
    const description = [
      analysis.paragraph1,
      analysis.paragraph2,
      analysis.paragraph3,
    ].filter(Boolean).join('\n\n');

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
      return { prompt: createContextPrompt(options.contextText, options.entityHints), schema: IMAGE_ANALYSIS_SCHEMA };
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

    const response = await this.client.analyzeImage(
      CLASSIFY_IMAGE_PROMPT,
      fileRef,
      {
        schema: CLASSIFICATION_SCHEMA,
        mediaResolution: 'MEDIA_RESOLUTION_LOW', // Low res for classification
      }
    );

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

    const response = await this.client.analyzeImage(
      DEEP_ANALYSIS_PROMPT,
      fileRef,
      {
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        thinkingConfig: { thinkingLevel: 'HIGH' },
      }
    );

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
   * Parse JSON response into ImageAnalysis structure.
   */
  private parseAnalysis(text: string): ImageAnalysis {
    try {
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(clean) as Partial<ImageAnalysis>;

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
    } catch (err) {
      // Log the parse failure so operators can detect Gemini returning malformed JSON.
      // Use raw text as description but flag it clearly via primarySubject.
      console.error(`[VLMService] Failed to parse analysis JSON: ${err instanceof Error ? err.message : err}`);
      return {
        imageType: 'unknown',
        primarySubject: '[PARSE_ERROR] Raw Gemini response used as fallback',
        paragraph1: text.slice(0, 500),
        paragraph2: text.slice(500, 1000),
        paragraph3: text.slice(1000, 1500),
        extractedText: [],
        dates: [],
        names: [],
        numbers: [],
        confidence: 0,
      };
    }
  }

  /**
   * Parse classification response.
   */
  private parseClassification(text: string): ImageClassification {
    try {
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(clean) as Partial<ImageClassification>;

      return {
        type: parsed.type || 'other',
        hasText: parsed.hasText ?? false,
        textDensity: parsed.textDensity || 'unknown',
        complexity: parsed.complexity || 'medium',
        confidence: parsed.confidence ?? 0.5,
      };
    } catch (err) {
      console.error(`[VLMService] Failed to parse classification JSON: ${err instanceof Error ? err.message : err}`);
      return {
        type: 'other',
        hasText: false,
        textDensity: 'unknown',
        complexity: 'medium',
        confidence: 0,
      };
    }
  }

  /**
   * Parse deep analysis response.
   */
  private parseDeepAnalysis(text: string): DeepAnalysisResult {
    try {
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(clean) as Partial<DeepAnalysisResult>;

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
    } catch (err) {
      console.error(`[VLMService] Failed to parse deep analysis JSON: ${err instanceof Error ? err.message : err}`);
      return {
        thinkingSteps: [],
        imageType: 'unknown',
        fullDescription: text,
        extractedData: {
          text: [],
          dates: [],
          amounts: [],
          names: [],
          references: [],
        },
        legalSignificance: '',
        uncertainties: ['Failed to parse structured response'],
        confidence: 0,
      };
    }
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
