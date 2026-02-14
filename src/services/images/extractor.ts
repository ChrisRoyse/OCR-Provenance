/**
 * Image Extractor Service
 *
 * TypeScript wrapper for Python image extraction scripts.
 * Extracts images from PDF and DOCX documents for VLM analysis.
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

/** Max stderr accumulation: 10KB (matches nomic.ts pattern) */
const MAX_STDERR_LENGTH = 10_240;

/** Supported file types for image extraction */
const SUPPORTED_EXTRACTION_TYPES = new Set(['.pdf', '.docx']);

const DEFAULT_CONFIG: ExtractorConfig = {
  pythonPath: 'python3',
  timeout: 120000,
};

/**
 * Service for extracting images from PDF documents
 */
export class ImageExtractor {
  private readonly config: ExtractorConfig;
  private readonly pdfScriptPath: string;
  private readonly docxScriptPath: string;

  constructor(config: Partial<ExtractorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pdfScriptPath =
      this.config.scriptPath ||
      path.join(process.cwd(), 'python', 'image_extractor.py');
    this.docxScriptPath =
      path.join(process.cwd(), 'python', 'docx_image_extractor.py');
  }

  /**
   * Extract images from any supported document type.
   * Routes to the correct extractor based on file extension.
   *
   * @param filePath - Path to the document file
   * @param options - Extraction options
   * @returns Promise<ExtractedImage[]> - Array of extracted images
   * @throws Error if file type is unsupported or extraction fails
   */
  async extractImages(
    filePath: string,
    options: ImageExtractionOptions
  ): Promise<ExtractedImage[]> {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
      case '.pdf':
        return this.extractFromPDF(filePath, options);
      case '.docx':
        return this.extractFromDOCX(filePath, options);
      default:
        throw new Error(
          `Unsupported file type for image extraction: '${ext}'. ` +
          `Supported types: ${[...SUPPORTED_EXTRACTION_TYPES].join(', ')}`
        );
    }
  }

  /**
   * Check if a file type is supported for image extraction.
   */
  static isSupported(filePath: string): boolean {
    return SUPPORTED_EXTRACTION_TYPES.has(path.extname(filePath).toLowerCase());
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
    if (!fs.existsSync(this.pdfScriptPath)) {
      throw new Error(
        `Image extractor script not found: ${this.pdfScriptPath}. ` +
          `Ensure python/image_extractor.py exists.`
      );
    }

    // Create output directory if it doesn't exist
    if (!fs.existsSync(options.outputDir)) {
      fs.mkdirSync(options.outputDir, { recursive: true });
    }

    const result = await this.runPythonExtractorScript(
      this.pdfScriptPath,
      pdfPath,
      options
    );

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
   * Extract images from a DOCX document
   *
   * @param docxPath - Path to the DOCX file
   * @param options - Extraction options
   * @returns Promise<ExtractedImage[]> - Array of extracted images
   * @throws Error if extraction fails
   */
  async extractFromDOCX(
    docxPath: string,
    options: ImageExtractionOptions
  ): Promise<ExtractedImage[]> {
    if (!fs.existsSync(docxPath)) {
      throw new Error(`DOCX file not found: ${docxPath}`);
    }

    if (!fs.existsSync(this.docxScriptPath)) {
      throw new Error(
        `DOCX image extractor script not found: ${this.docxScriptPath}. ` +
          `Ensure python/docx_image_extractor.py exists.`
      );
    }

    if (!fs.existsSync(options.outputDir)) {
      fs.mkdirSync(options.outputDir, { recursive: true });
    }

    const result = await this.runPythonExtractorScript(
      this.docxScriptPath,
      docxPath,
      options
    );

    if (!result.success) {
      throw new Error(`DOCX image extraction failed: ${result.error}`);
    }

    if (result.warnings && result.warnings.length > 0) {
      console.warn(
        `[ImageExtractor] DOCX extraction warnings: ${result.warnings.join('; ')}`
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
   * Run a Python extraction script (works for both PDF and DOCX extractors)
   */
  private runPythonExtractorScript(
    scriptPath: string,
    inputPath: string,
    options: ImageExtractionOptions
  ): Promise<ExtractionResult> {
    return new Promise((resolve, reject) => {
      const args = [
        scriptPath,
        '--input',
        inputPath,
        '--output',
        options.outputDir,
        '--min-size',
        String(options.minSize ?? 50),
        '--max-images',
        String(options.maxImages ?? 100),
      ];

      const timeout = this.config.timeout ?? 120000;
      const proc = spawn(this.config.pythonPath, args, {
        timeout,
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
        reject(new Error(`Failed to start Python process: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        cleanup();
        if (settled) return;
        settled = true;

        if (stderr) {
          console.warn(`[ImageExtractor] stderr: ${stderr.substring(0, 2000)}`);
        }

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          reject(
            new Error(`Python process killed by ${signal} (timeout: ${timeout}ms)`)
          );
          return;
        }

        try {
          // Python may output debug/warning lines before the JSON. Find the last
          // valid JSON line (starts with '{' or '[') to handle multi-line output.
          const lines = stdout.trim().split('\n');
          let parsed: ExtractionResult | undefined;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('{') || line.startsWith('[')) {
              try {
                parsed = JSON.parse(line) as ExtractionResult;
                break;
              } catch { /* not valid JSON, try previous line */ }
            }
          }
          if (parsed === undefined) {
            // Fallback: try parsing the entire stdout as one JSON blob
            parsed = JSON.parse(stdout) as ExtractionResult;
          }
          resolve(parsed);
        } catch (parseError) {
          if (code !== 0) {
            // M-14: Truncate stderr/stdout in error messages to prevent holding megabytes
            reject(
              new Error(
                `Python script exited with code ${code}: ${(stderr || stdout).substring(0, 2000)}`
              )
            );
          } else {
            reject(
              new Error(`Failed to parse extraction result: ${parseError}`)
            );
          }
        }
      });

      // H-4: SIGKILL escalation - if Node.js timeout sends SIGTERM and process
      // doesn't exit within 5s, escalate to SIGKILL (matches optimizer.ts pattern)
      if (timeout > 0) {
        sigkillTimer = setTimeout(() => {
          if (!settled && !proc.killed) {
            console.error(`[ImageExtractor] Process did not exit after SIGTERM, sending SIGKILL (pid: ${proc.pid})`);
            try {
              proc.kill('SIGKILL');
            } catch {
              // Process may already be gone
            }
          }
        }, timeout + 5000);
      }
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

}
