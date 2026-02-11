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
} from './service.js';

// Pipeline
export {
  VLMPipeline,
  createVLMPipeline,
  type BatchResult,
} from './pipeline.js';

// Prompts
export {
  LEGAL_IMAGE_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  DEEP_ANALYSIS_PROMPT,
  createContextPrompt,
  IMAGE_ANALYSIS_SCHEMA,
  CLASSIFICATION_SCHEMA,
} from './prompts.js';
