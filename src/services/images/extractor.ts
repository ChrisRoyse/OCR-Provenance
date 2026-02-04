/**
 * Image Extractor Service
 *
 * TypeScript wrapper for the Python image extraction script.
 * Extracts images from PDF documents for VLM analysis.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ExtractedImage, ImageExtractionOptions } from '../../models/image.js';

/**
 * Result from image extraction
 */
export interface ExtractionResult {
  success: boolean;
  count: number;
  images: ExtractedImage[];
  warnings?: string[];
  error?: string;
}

/**
 * Configuration for the image extractor
 */
export interface ExtractorConfig {
  /** Path to Python executable */
  pythonPath: string;
  /** Path to the extraction script (defaults to python/image_extractor.py) */
  scriptPath?: string;
  /** Timeout in milliseconds (default: 120000 = 2 minutes) */
  timeout?: number;
}

const DEFAULT_CONFIG: ExtractorConfig = {
  pythonPath: 'python',
  timeout: 120000,
};

/**
 * Service for extracting images from PDF documents
 */
export class ImageExtractor {
  private readonly config: ExtractorConfig;
  private readonly scriptPath: string;

  constructor(config: Partial<ExtractorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scriptPath =
      this.config.scriptPath ||
      path.join(process.cwd(), 'python', 'image_extractor.py');
  }

  /**
   * Extract images from a PDF document
   *
   * @param pdfPath - Path to the PDF file
   * @param options - Extraction options
   * @returns Promise<ExtractedImage[]> - Array of extracted images
   * @throws Error if extraction fails
   */
  async extractFromPDF(
    pdfPath: string,
    options: ImageExtractionOptions
  ): Promise<ExtractedImage[]> {
    // Validate PDF exists
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file not found: ${pdfPath}`);
    }

    // Validate script exists
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(
        `Image extractor script not found: ${this.scriptPath}. ` +
          `Ensure python/image_extractor.py exists.`
      );
    }

    // Create output directory if it doesn't exist
    if (!fs.existsSync(options.outputDir)) {
      fs.mkdirSync(options.outputDir, { recursive: true });
    }

    const result = await this.runPythonScript(pdfPath, options);

    if (!result.success) {
      throw new Error(`Image extraction failed: ${result.error}`);
    }

    if (result.warnings && result.warnings.length > 0) {
      console.warn(
        `[ImageExtractor] Warnings during extraction: ${result.warnings.join('; ')}`
      );
    }

    return result.images;
  }

  /**
   * Check if the Python environment is properly configured
   *
   * @returns Promise<boolean> - True if Python and dependencies are available
   */
  async checkEnvironment(): Promise<{
    available: boolean;
    pythonVersion?: string;
    missingDependencies: string[];
  }> {
    const missingDeps: string[] = [];

    // Check Python version
    let pythonVersion: string | undefined;
    try {
      pythonVersion = await this.runCommand(
        this.config.pythonPath,
        ['--version']
      );
    } catch {
      return {
        available: false,
        missingDependencies: ['python'],
      };
    }

    // Check PyMuPDF
    try {
      await this.runCommand(this.config.pythonPath, [
        '-c',
        'import fitz; print(fitz.version)',
      ]);
    } catch {
      missingDeps.push('PyMuPDF');
    }

    // Check Pillow
    try {
      await this.runCommand(this.config.pythonPath, [
        '-c',
        'from PIL import Image; print("OK")',
      ]);
    } catch {
      missingDeps.push('Pillow');
    }

    return {
      available: missingDeps.length === 0,
      pythonVersion: pythonVersion?.trim(),
      missingDependencies: missingDeps,
    };
  }

  /**
   * Run the Python extraction script
   */
  private runPythonScript(
    pdfPath: string,
    options: ImageExtractionOptions
  ): Promise<ExtractionResult> {
    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        '--input',
        pdfPath,
        '--output',
        options.outputDir,
        '--min-size',
        String(options.minSize ?? 50),
        '--max-images',
        String(options.maxImages ?? 100),
      ];

      const proc = spawn(this.config.pythonPath, args, {
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
        reject(new Error(`Failed to start Python process: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (stderr) {
          console.warn(`[ImageExtractor] stderr: ${stderr}`);
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result as ExtractionResult);
        } catch (parseError) {
          if (code !== 0) {
            reject(
              new Error(
                `Python script exited with code ${code}: ${stderr || stdout}`
              )
            );
          } else {
            reject(
              new Error(`Failed to parse extraction result: ${parseError}`)
            );
          }
        }
      });
    });
  }

  /**
   * Run a simple command and return output
   */
  private runCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { timeout: 10000 });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Exit code ${code}`));
        }
      });
    });
  }

  /**
   * Clean up extracted images for a document
   *
   * @param outputDir - Directory containing extracted images
   * @returns number - Number of files deleted
   */
  cleanupExtractedImages(outputDir: string): number {
    if (!fs.existsSync(outputDir)) {
      return 0;
    }

    let count = 0;
    const files = fs.readdirSync(outputDir);

    for (const file of files) {
      // Only delete image files matching our naming pattern
      if (/^p\d{3}_i\d{3}\.\w+$/.test(file)) {
        fs.unlinkSync(path.join(outputDir, file));
        count++;
      }
    }

    return count;
  }

  /**
   * Get the default output directory for a document
   *
   * @param documentId - Document ID
   * @returns string - Path to output directory
   */
  static getOutputDir(documentId: string, baseDir?: string): string {
    const base =
      baseDir ||
      process.env.IMAGE_OUTPUT_DIR ||
      path.join(process.cwd(), '.ocr-provenance', 'images');
    return path.join(base, documentId);
  }
}
