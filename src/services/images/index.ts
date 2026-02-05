/**
 * Image Services - Public API
 *
 * Exports image extraction and processing services.
 */

export {
  ImageExtractor,
  type ExtractionResult,
  type ExtractorConfig,
} from './extractor.js';

export {
  ImageOptimizer,
  getImageOptimizer,
  type ImageOptimizerConfig,
  type ImageAnalysisResult,
  type ImageCategory,
  type ResizeResult,
  type SkipResult,
  type DirectoryAnalysisResult,
} from './optimizer.js';
