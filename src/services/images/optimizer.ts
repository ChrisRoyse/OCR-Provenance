/**
 * Image Optimizer Service
 *
 * TypeScript wrapper for Python image optimizer providing:
 * 1. Resize for OCR (max 4800px width for Datalab API)
 * 2. Resize for VLM (optimize token usage, max 2048px)
 * 3. Relevance analysis to filter logos, icons, and decorative elements
 *
 * The relevance analysis uses multi-layer heuristics:
 * - Size filtering (tiny images are likely icons)
 * - Aspect ratio analysis (extreme ratios = banners/logos)
 * - Color diversity (low color count = likely logo/icon)
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Image category classification
 */
export type ImageCategory =
  | 'photo'
  | 'chart'
  | 'document'
  | 'logo'
  | 'icon'
  | 'decorative'
  | 'unknown';

/**
 * Result of image relevance analysis
 */
export interface ImageAnalysisResult {
  success: true;
  path: string;
  width: number;
  height: number;
  aspect_ratio: number;
  unique_colors: number;
  color_diversity_score: number;
  size_score: number;
  aspect_score: number;
  overall_relevance: number;
  predicted_category: ImageCategory;
  should_vlm: boolean;
  skip_reason?: string;
}

/**
 * Result of resize operation
 */
export interface ResizeResult {
  success: true;
  resized: boolean;
  original_width: number;
  original_height: number;
  output_width: number;
  output_height: number;
  scale_factor?: number;
  output_path: string;
}

/**
 * Result when image is skipped (too small)
 */
export interface SkipResult {
  success: true;
  skipped: true;
  skip_reason: string;
  original_width: number;
  original_height: number;
}

/**
 * Directory analysis result
 */
export interface DirectoryAnalysisResult {
  success: true;
  directory: string;
  total: number;
  should_vlm: number;
  skip_too_small: number;
  skip_logo_icon: number;
  skip_decorative: number;
  skip_low_relevance: number;
  images: Array<{
    path: string;
    width?: number;
    height?: number;
    category?: ImageCategory;
    relevance?: number;
    should_vlm: boolean;
    skip_reason?: string;
    error?: string;
  }>;
}

/**
 * Error result from Python script
 */
export interface ErrorResult {
  success: false;
  error: string;
}

/**
 * Configuration for the image optimizer
 */
export interface ImageOptimizerConfig {
  /** Path to Python executable */
  pythonPath: string;
  /** Timeout in milliseconds */
  timeout: number;
  /** Maximum width for OCR resize (default: 4800) */
  ocrMaxWidth: number;
  /** Maximum dimension for VLM resize (default: 2048) */
  vlmMaxDimension: number;
  /** Minimum size to skip for VLM (default: 50) */
  vlmSkipBelowSize: number;
  /** Minimum relevance score for VLM (default: 0.3) */
  minRelevanceScore: number;
}

const DEFAULT_CONFIG: ImageOptimizerConfig = {
  pythonPath: 'python3',
  timeout: 60000, // 1 minute
  ocrMaxWidth: 4800,
  vlmMaxDimension: 2048,
  vlmSkipBelowSize: 50,
  minRelevanceScore: 0.3,
};

/**
 * Service for optimizing images for OCR and VLM processing
 */
export class ImageOptimizer {
  private readonly config: ImageOptimizerConfig;
  private readonly scriptPath: string;

  constructor(config: Partial<ImageOptimizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scriptPath = path.join(process.cwd(), 'python', 'image_optimizer.py');
  }

  /**
   * Analyze an image to determine if it should be processed by VLM.
   *
   * Uses multi-layer heuristics:
   * 1. Size (tiny images = skip)
   * 2. Aspect ratio (extreme ratios = skip)
   * 3. Color diversity (low = likely logo/icon)
   * 4. Category prediction
   *
   * @param imagePath - Path to the image file
   * @returns Analysis result with should_vlm recommendation
   */
  async analyzeImage(
    imagePath: string
  ): Promise<ImageAnalysisResult | ErrorResult> {
    return this.runPython(['--analyze', imagePath]);
  }

  /**
   * Quick check if an image should be processed by VLM.
   * Wrapper around analyzeImage that returns just the boolean.
   *
   * @param imagePath - Path to the image file
   * @returns true if image should be VLM processed
   */
  async shouldProcessVLM(imagePath: string): Promise<boolean> {
    const result = await this.analyzeImage(imagePath);
    if (!result.success) {
      console.warn(`[ImageOptimizer] Analysis failed: ${result.error}`);
      return false;
    }
    return result.should_vlm;
  }

  /**
   * Quick check using only dimensions (no file read).
   * Faster but less accurate than full analysis.
   *
   * @param width - Image width in pixels
   * @param height - Image height in pixels
   * @returns true if dimensions suggest VLM processing worthwhile
   */
  shouldProcessVLMByDimensions(width: number, height: number): boolean {
    const minDim = Math.min(width, height);
    const maxDim = Math.max(width, height);
    const aspectRatio = maxDim / minDim;

    // Skip if too small
    if (maxDim < this.config.vlmSkipBelowSize) {
      return false;
    }

    // Skip if likely icon (both dimensions small)
    if (maxDim < 100 && minDim < 100) {
      return false;
    }

    // Skip if extreme aspect ratio (likely banner/separator)
    if (aspectRatio > 6) {
      return false;
    }

    return true;
  }

  /**
   * Resize an image for OCR processing (Datalab API).
   *
   * @param inputPath - Path to input image
   * @param outputPath - Path for output (optional, creates temp file if not provided)
   * @returns Resize result
   */
  async resizeForOCR(
    inputPath: string,
    outputPath?: string
  ): Promise<ResizeResult | ErrorResult> {
    const output = outputPath ?? this.createTempPath(inputPath, 'ocr');
    return this.runPython([
      '--resize-for-ocr',
      inputPath,
      '--output',
      output,
      '--max-width',
      String(this.config.ocrMaxWidth),
    ]);
  }

  /**
   * Resize an image for VLM processing (Gemini).
   *
   * @param inputPath - Path to input image
   * @param outputPath - Path for output (optional, creates temp file if not provided)
   * @returns Resize result or skip result if too small
   */
  async resizeForVLM(
    inputPath: string,
    outputPath?: string
  ): Promise<ResizeResult | SkipResult | ErrorResult> {
    const output = outputPath ?? this.createTempPath(inputPath, 'vlm');
    return this.runPython([
      '--resize-for-vlm',
      inputPath,
      '--output',
      output,
      '--max-dimension',
      String(this.config.vlmMaxDimension),
    ]);
  }

  /**
   * Analyze all images in a directory.
   *
   * @param dirPath - Path to directory
   * @returns Analysis summary with per-image results
   */
  async analyzeDirectory(
    dirPath: string
  ): Promise<DirectoryAnalysisResult | ErrorResult> {
    return this.runPython([
      '--analyze-dir',
      dirPath,
      '--min-relevance',
      String(this.config.minRelevanceScore),
    ]);
  }

  /**
   * Check if the Python optimizer script exists.
   */
  isAvailable(): boolean {
    return fs.existsSync(this.scriptPath);
  }

  /**
   * Create a temporary file path for resized output.
   */
  private createTempPath(inputPath: string, suffix: string): string {
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    const tmpDir = os.tmpdir();
    return path.join(tmpDir, `${base}_${suffix}_${Date.now()}${ext}`);
  }

  /**
   * Run the Python optimizer script.
   */
  private runPython<T>(args: string[]): Promise<T> {
    return new Promise((resolve) => {
      // Validate script exists
      if (!fs.existsSync(this.scriptPath)) {
        resolve({
          success: false,
          error: `Image optimizer script not found: ${this.scriptPath}`,
        } as T);
        return;
      }

      const proc = spawn(this.config.pythonPath, [this.scriptPath, ...args], {
        timeout: this.config.timeout,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          error: `Failed to start Python process: ${err.message}`,
        } as T);
      });

      proc.on('close', (code) => {
        if (stderr) {
          console.warn(`[ImageOptimizer] stderr: ${stderr}`);
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result as T);
        } catch (parseError) {
          if (code !== 0) {
            resolve({
              success: false,
              error: `Python script exited with code ${code}: ${stderr || stdout}`,
            } as T);
          } else {
            resolve({
              success: false,
              error: `Failed to parse result: ${parseError}`,
            } as T);
          }
        }
      });
    });
  }
}

/**
 * Default global optimizer instance
 */
let defaultOptimizer: ImageOptimizer | null = null;

/**
 * Get or create the default optimizer instance.
 */
export function getImageOptimizer(
  config?: Partial<ImageOptimizerConfig>
): ImageOptimizer {
  if (!defaultOptimizer || config) {
    defaultOptimizer = new ImageOptimizer(config);
  }
  return defaultOptimizer;
}
