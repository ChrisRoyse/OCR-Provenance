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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Image category classification
 */
type ImageCategory = 'photo' | 'chart' | 'document' | 'logo' | 'icon' | 'decorative' | 'unknown';

/**
 * Result of image relevance analysis
 */
interface ImageAnalysisResult {
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
interface ResizeResult {
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
interface SkipResult {
  success: true;
  skipped: true;
  skip_reason: string;
  original_width: number;
  original_height: number;
}

/**
 * Error result from Python script
 */
interface ErrorResult {
  success: false;
  error: string;
}

/**
 * Configuration for the image optimizer
 */
interface ImageOptimizerConfig {
  /** Path to Python executable */
  pythonPath: string;
  /** Timeout in milliseconds */
  timeout: number;
  /** Maximum dimension for VLM resize (default: 2048) */
  vlmMaxDimension: number;
  /** Minimum size to skip for VLM (default: 50) */
  vlmSkipBelowSize: number;
  /** Minimum relevance score for VLM (default: 0.3) */
  minRelevanceScore: number;
}

/** Max stderr accumulation: 10KB (matches nomic.ts pattern) */
const MAX_STDERR_LENGTH = 10_240;

const DEFAULT_CONFIG: ImageOptimizerConfig = {
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  timeout: 60000, // 1 minute
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
    this.scriptPath = path.resolve(__dirname, '../../../python/image_optimizer.py');
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
  async analyzeImage(imagePath: string): Promise<ImageAnalysisResult | ErrorResult> {
    return this.runPython(['--analyze', imagePath]);
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
   * M-14: Sends SIGKILL after 5s if SIGTERM from Node.js timeout didn't terminate the process.
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
      let settled = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
      };

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // H-9: Cap stderr accumulation to prevent unbounded memory growth
      proc.stderr.on('data', (data) => {
        if (stderr.length < MAX_STDERR_LENGTH) {
          stderr += data.toString();
        }
      });

      proc.on('error', (err) => {
        cleanup();
        if (settled) return;
        settled = true;

        // The bottom-of-function SIGKILL timer at timeout+5000ms already covers
        // the case where SIGTERM fails to terminate the process. No need for a
        // second timer here (which would leak since cleanup() already ran).

        resolve({
          success: false,
          error: `Failed to start Python process: ${err.message}`,
        } as T);
      });

      proc.on('close', (code, signal) => {
        cleanup();
        if (settled) return;
        settled = true;

        if (stderr) {
          console.error(`[ImageOptimizer] stderr: ${stderr}`);
        }

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          resolve({
            success: false,
            error: `Python process killed by ${signal} (timeout: ${this.config.timeout}ms)`,
          } as T);
          return;
        }

        try {
          // Python may output debug/warning lines before the JSON. Find the last
          // valid JSON line (starts with '{' or '[') to handle multi-line output.
          const lines = stdout.trim().split('\n');
          let parsed: T | undefined;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('{') || line.startsWith('[')) {
              try {
                parsed = JSON.parse(line) as T;
                break;
              } catch (error) {
                console.error(
                  '[ImageOptimizer] JSON parse failed for output line, trying previous:',
                  error instanceof Error ? error.message : String(error)
                );
                /* not valid JSON, try previous line */
              }
            }
          }
          if (parsed === undefined) {
            // Fallback: try parsing the entire stdout as one JSON blob
            parsed = JSON.parse(stdout) as T;
          }
          resolve(parsed);
        } catch (parseError) {
          if (code !== 0) {
            resolve({
              success: false,
              error: `Python script exited with code ${code}: ${(stderr || stdout).substring(0, 2000)}`,
            } as T);
          } else {
            resolve({
              success: false,
              error: `Failed to parse result: ${parseError}`,
            } as T);
          }
        }
      });

      // SIGKILL fallback: if Node.js timeout sends SIGTERM and process doesn't exit within 5s, SIGKILL it
      // The spawn timeout option sends SIGTERM. We set a timer to escalate to SIGKILL.
      if (this.config.timeout > 0) {
        sigkillTimer = setTimeout(() => {
          if (!settled && !proc.killed) {
            console.error(
              `[ImageOptimizer] Process did not exit after SIGTERM, sending SIGKILL (pid: ${proc.pid})`
            );
            try {
              proc.kill('SIGKILL');
            } catch (error) {
              console.error(
                '[ImageOptimizer] Failed to SIGKILL process (may already be gone):',
                error instanceof Error ? error.message : String(error)
              );
              // Process may already be gone
            }
          }
        }, this.config.timeout + 5000);
      }
    });
  }
}

/**
 * Cached default optimizer instance (used when no config is provided)
 */
let cachedOptimizer: ImageOptimizer | null = null;

/**
 * Get an optimizer instance.
 * When config is provided, always creates a new instance and updates the cache.
 * When no config is provided, returns the cached instance (creating one if needed).
 */
export function getImageOptimizer(config?: Partial<ImageOptimizerConfig>): ImageOptimizer {
  if (config) {
    cachedOptimizer = new ImageOptimizer(config);
    return cachedOptimizer;
  }
  if (!cachedOptimizer) {
    cachedOptimizer = new ImageOptimizer();
  }
  return cachedOptimizer;
}
