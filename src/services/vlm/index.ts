/**
 * VLM Service Module
 *
 * Gemini 3 multimodal image analysis for legal and medical documents.
 *
 * @module services/vlm
 */

// Service
export {
  VLMService,
  getVLMService,
  resetVLMService,
  type VLMAnalysisResult,
  type ImageAnalysis,
  type ImageClassification,
  type DeepAnalysisResult,
  type DescribeImageOptions,
} from './service.js';

// Pipeline
export {
  VLMPipeline,
  createVLMPipeline,
  type PipelineConfig,
  type ProcessingResult,
  type BatchResult,
} from './pipeline.js';

// Prompts
export {
  LEGAL_IMAGE_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  DEEP_ANALYSIS_PROMPT,
  MEDICAL_IMAGE_PROMPT,
  createContextPrompt,
  IMAGE_ANALYSIS_SCHEMA,
  CLASSIFICATION_SCHEMA,
  DEEP_ANALYSIS_SCHEMA,
} from './prompts.js';
