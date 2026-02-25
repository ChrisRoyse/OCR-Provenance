/**
 * Datalab OCR Bridge
 *
 * Invokes python/ocr_worker.py via python-shell.
 * NO MOCKS, NO FALLBACKS - real API calls only.
 */

import { PythonShell, Options } from 'python-shell';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { OCRResult, PageOffset } from '../../models/document.js';
import { OCRError, mapPythonError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Max stderr accumulation: 10KB (matches nomic.ts pattern) */
const MAX_STDERR_LENGTH = 10_240;

/**
 * Python worker JSON response structure
 * Matches python/ocr_worker.py OCRResult dataclass
 */
interface PythonOCRResponse {
  id: string;
  provenance_id: string;
  document_id: string;
  extracted_text: string;
  text_length: number;
  datalab_request_id: string;
  datalab_mode: 'fast' | 'balanced' | 'accurate';
  parse_quality_score: number | null;
  page_count: number;
  cost_cents: number | null;
  content_hash: string;
  processing_started_at: string;
  processing_completed_at: string;
  processing_duration_ms: number;
  page_offsets: Array<{ page: number; char_start: number; char_end: number }>;
  error: string | null;
  /** Images extracted by Datalab: {filename: base64_data} */
  images: Record<string, string> | null;
  /** JSON block hierarchy from Datalab (when output_format includes 'json') */
  json_blocks: Record<string, unknown> | null;
  /** Datalab metadata (page_stats, block_counts, etc.) */
  metadata: Record<string, unknown> | null;
  /** Structured extraction result from page_schema */
  extraction_json: Record<string, unknown> | unknown[] | null;
  /** Full cost_breakdown dict from Datalab */
  cost_breakdown_full: Record<string, unknown> | null;
  /** Document title from metadata */
  doc_title: string | null;
  /** Document author from metadata */
  doc_author: string | null;
  /** Document subject from metadata */
  doc_subject: string | null;
}

interface PythonErrorResponse {
  error: string;
  category: string;
  details: Record<string, unknown>;
}

export interface DatalabClientConfig {
  pythonPath?: string;
  timeout?: number;
}

export class DatalabClient {
  private readonly pythonPath: string | undefined;
  private readonly workerPath: string;
  private readonly timeout: number;

  constructor(config: DatalabClientConfig = {}) {
    this.pythonPath = config.pythonPath;
    this.workerPath = resolve(__dirname, '../../../python/ocr_worker.py');
    const parsedTimeout = parseInt(process.env.DATALAB_TIMEOUT || '330000');
    this.timeout = config.timeout ?? (Number.isNaN(parsedTimeout) ? 330000 : parsedTimeout); // 5.5 min (FIX-P3-1)
  }

  /**
   * Process document through Datalab OCR
   *
   * FAIL-FAST: Throws on any error, no fallbacks
   */
  async processDocument(
    filePath: string,
    documentId: string,
    provenanceId: string,
    mode: 'fast' | 'balanced' | 'accurate' = 'accurate',
    ocrOptions?: {
      maxPages?: number;
      pageRange?: string;
      skipCache?: boolean;
      disableImageExtraction?: boolean;
      extras?: string[];
      pageSchema?: string;
      additionalConfig?: Record<string, unknown>;
      fileUrl?: string;
    }
  ): Promise<{
    result: OCRResult;
    pageOffsets: PageOffset[];
    images: Record<string, string>;
    jsonBlocks: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    extractionJson: Record<string, unknown> | unknown[] | null;
    docTitle: string | null;
    docAuthor: string | null;
    docSubject: string | null;
  }> {
    const args = [
      '--file',
      filePath,
      '--mode',
      mode,
      '--doc-id',
      documentId,
      '--prov-id',
      provenanceId,
      '--json',
    ];
    if (ocrOptions?.maxPages) args.push('--max-pages', String(ocrOptions.maxPages));
    if (ocrOptions?.pageRange) args.push('--page-range', ocrOptions.pageRange);
    if (ocrOptions?.skipCache) args.push('--skip-cache');
    if (ocrOptions?.disableImageExtraction) args.push('--disable-image-extraction');
    if (ocrOptions?.extras?.length) args.push('--extras', ocrOptions.extras.join(','));
    if (ocrOptions?.pageSchema) args.push('--page-schema', ocrOptions.pageSchema);
    if (ocrOptions?.additionalConfig)
      args.push('--additional-config', JSON.stringify(ocrOptions.additionalConfig));
    if (ocrOptions?.fileUrl) args.push('--file-url', ocrOptions.fileUrl);

    const options: Options = {
      mode: 'text',
      pythonPath: this.pythonPath,
      pythonOptions: ['-u'],
      args,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const shell = new PythonShell(this.workerPath, options);
      const outputChunks: string[] = [];
      let stderr = '';
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        // Kill the Python process to prevent orphans (SIGTERM)
        try {
          shell.kill();
        } catch (error) {
          console.error(
            '[DatalabOCR] Failed to kill shell on timeout:',
            error instanceof Error ? error.message : String(error)
          );
          /* ignore */
        }
        // M-6: SIGKILL escalation if SIGTERM doesn't exit within 5s
        sigkillTimer = setTimeout(() => {
          if (!settled) {
            console.error(
              `[DatalabOCR] Process did not exit after SIGTERM, sending SIGKILL (pid: ${shell.childProcess?.pid})`
            );
            try {
              shell.childProcess?.kill('SIGKILL');
            } catch (error) {
              console.error(
                '[DatalabOCR] Failed to SIGKILL process (may already be gone):',
                error instanceof Error ? error.message : String(error)
              );
            }
          }
          // Settle the promise if close event hasn't fired yet (zombie prevention)
          if (!settled) {
            settled = true;
            reject(
              new OCRError(
                `OCR timeout after ${this.timeout}ms (SIGKILL after 5s grace)`,
                'OCR_TIMEOUT'
              )
            );
          }
        }, 5000);
      }, this.timeout);

      shell.on('message', (msg: string) => {
        outputChunks.push(msg);
      });

      shell.on('stderr', (err: string) => {
        if (stderr.length < MAX_STDERR_LENGTH) {
          stderr += err + '\n';
        }
      });

      shell.end((err?: Error) => {
        clearTimeout(timer);
        cleanup();
        if (settled) return;
        settled = true;

        // Capture exit code/signal for diagnostics
        const exitCode = shell.exitCode ?? null;
        const exitSignal = shell.exitSignal ?? null;

        // H-3: Join chunks once instead of repeated string concatenation
        const output = outputChunks.join('\n');
        // M-12: Allow early GC of chunk array
        outputChunks.length = 0;

        // python-shell bug: when process is killed by signal (SIGTERM/SIGKILL),
        // exitCode is null and exitSignal is set, but err is NOT provided.
        // Detect this and treat signal-killed processes as errors.
        if (!err && exitSignal) {
          const signalDetail = stderr.trim()
            ? `Process killed by ${exitSignal}. Python stderr:\n${stderr.trim()}`
            : `Process killed by ${exitSignal} with no stderr output.`;
          reject(
            new OCRError(
              `OCR worker killed by signal ${exitSignal} (file: ${filePath}). ${signalDetail}`,
              exitSignal === 'SIGTERM' || exitSignal === 'SIGALRM' ? 'OCR_TIMEOUT' : 'OCR_API_ERROR'
            )
          );
          return;
        }

        if (err) {
          // Try to parse JSON from output for structured error
          const lines = output
            .trim()
            .split('\n')
            .filter((l) => l.trim());
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i].trim()) as unknown;
              if (this.isErrorResponse(parsed)) {
                reject(mapPythonError(parsed.category, parsed.error, parsed.details));
                return;
              }
            } catch (error) {
              console.error(
                '[DatalabOCR] JSON parse failed for error output line, skipping:',
                error instanceof Error ? error.message : String(error)
              );
              /* not JSON, skip */
            }
          }
          const detail = stderr ? `${err.message}\nPython stderr:\n${stderr}` : err.message;
          reject(new OCRError(`Python worker failed: ${detail}`, 'OCR_API_ERROR'));
          return;
        }

        // Parse the last JSON line from stdout (Python may output non-JSON logging)
        const lines = output
          .trim()
          .split('\n')
          .filter((l) => l.trim());
        if (lines.length === 0) {
          const diagnostics = [
            'No output from OCR worker.',
            `Exit code: ${exitCode}, signal: ${exitSignal}.`,
            `File: ${filePath}.`,
          ];
          if (stderr.trim()) {
            diagnostics.push(`Python stderr: ${stderr.trim().substring(0, 500)}`);
          } else {
            diagnostics.push('Python stderr was empty (logging suppressed in --json mode).');
          }
          reject(new OCRError(diagnostics.join(' '), 'OCR_API_ERROR'));
          return;
        }

        let response: unknown;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            response = JSON.parse(lines[i].trim());
            break;
          } catch (error) {
            console.error(
              '[DatalabOCR] JSON parse failed for output line, trying previous:',
              error instanceof Error ? error.message : String(error)
            );
            /* not JSON, try previous line */
          }
        }

        if (!response) {
          reject(
            new OCRError(
              `Failed to parse OCR worker output as JSON. Last line: ${lines[lines.length - 1]?.substring(0, 200)}`,
              'OCR_API_ERROR'
            )
          );
          return;
        }

        // Check for error response
        if (this.isErrorResponse(response)) {
          reject(mapPythonError(response.category, response.error, response.details));
          return;
        }

        const ocrResponse = response as PythonOCRResponse;

        // Verify required fields exist
        if (!ocrResponse.id || !ocrResponse.content_hash || !ocrResponse.extracted_text) {
          reject(
            new OCRError(
              `Invalid OCR response: missing required fields. Got: ${JSON.stringify(Object.keys(ocrResponse))}`,
              'OCR_API_ERROR'
            )
          );
          return;
        }

        resolve({
          result: this.toOCRResult(ocrResponse),
          pageOffsets: this.toPageOffsets(ocrResponse.page_offsets),
          images: ocrResponse.images ?? {},
          jsonBlocks: ocrResponse.json_blocks ?? null,
          metadata: ocrResponse.metadata ?? null,
          extractionJson: ocrResponse.extraction_json ?? null,
          docTitle: ocrResponse.doc_title ?? null,
          docAuthor: ocrResponse.doc_author ?? null,
          docSubject: ocrResponse.doc_subject ?? null,
        });
      });
    });
  }

  /**
   * Process a file through Datalab OCR and return raw results without storing in DB.
   * Used by ocr_convert_raw tool for quick one-off conversions.
   *
   * FAIL-FAST: Throws on any error, no fallbacks
   */
  async processRaw(
    filePath: string,
    mode: 'fast' | 'balanced' | 'accurate' = 'balanced',
    ocrOptions?: {
      maxPages?: number;
      pageRange?: string;
      fileUrl?: string;
    }
  ): Promise<{
    markdown: string;
    pageCount: number;
    qualityScore: number | null;
    costCents: number | null;
    durationMs: number;
    metadata: Record<string, unknown> | null;
  }> {
    // Use dummy IDs since we are not storing in DB
    const dummyDocId = 'raw-convert-' + Date.now();
    const dummyProvId = 'raw-convert-prov-' + Date.now();

    const args: string[] = [];
    if (ocrOptions?.fileUrl) {
      args.push('--file-url', ocrOptions.fileUrl);
    } else {
      args.push('--file', filePath);
    }
    args.push('--mode', mode, '--doc-id', dummyDocId, '--prov-id', dummyProvId, '--json');
    if (ocrOptions?.maxPages) args.push('--max-pages', String(ocrOptions.maxPages));
    if (ocrOptions?.pageRange) args.push('--page-range', ocrOptions.pageRange);

    const options: Options = {
      mode: 'text',
      pythonPath: this.pythonPath,
      pythonOptions: ['-u'],
      args,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const shell = new PythonShell(this.workerPath, options);
      const outputChunks: string[] = [];
      let stderr = '';
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        try {
          shell.kill();
        } catch (error) {
          console.error(
            '[DatalabOCR] Failed to kill shell on processRaw timeout:',
            error instanceof Error ? error.message : String(error)
          );
          /* ignore */
        }
        // M-6: SIGKILL escalation if SIGTERM doesn't exit within 5s
        sigkillTimer = setTimeout(() => {
          if (!settled) {
            console.error(
              `[DatalabOCR] processRaw process did not exit after SIGTERM, sending SIGKILL (pid: ${shell.childProcess?.pid})`
            );
            try {
              shell.childProcess?.kill('SIGKILL');
            } catch (error) {
              console.error(
                '[DatalabOCR] Failed to SIGKILL processRaw process (may already be gone):',
                error instanceof Error ? error.message : String(error)
              );
            }
          }
          if (!settled) {
            settled = true;
            reject(
              new OCRError(
                `OCR timeout after ${this.timeout}ms (SIGKILL after 5s grace)`,
                'OCR_TIMEOUT'
              )
            );
          }
        }, 5000);
      }, this.timeout);

      shell.on('message', (msg: string) => {
        outputChunks.push(msg);
      });

      shell.on('stderr', (err: string) => {
        if (stderr.length < MAX_STDERR_LENGTH) {
          stderr += err + '\n';
        }
      });

      shell.end((err?: Error) => {
        clearTimeout(timer);
        cleanup();
        if (settled) return;
        settled = true;

        // Capture exit code/signal for diagnostics
        const exitCode = shell.exitCode ?? null;
        const exitSignal = shell.exitSignal ?? null;

        const output = outputChunks.join('\n');
        outputChunks.length = 0;

        // python-shell bug: when process is killed by signal (SIGTERM/SIGKILL),
        // exitCode is null and exitSignal is set, but err is NOT provided.
        // Detect this and treat signal-killed processes as errors.
        const rawFilePath = ocrOptions?.fileUrl || filePath;
        if (!err && exitSignal) {
          const signalDetail = stderr.trim()
            ? `Process killed by ${exitSignal}. Python stderr:\n${stderr.trim()}`
            : `Process killed by ${exitSignal} with no stderr output.`;
          reject(
            new OCRError(
              `OCR worker killed by signal ${exitSignal} (file: ${rawFilePath}). ${signalDetail}`,
              exitSignal === 'SIGTERM' || exitSignal === 'SIGALRM' ? 'OCR_TIMEOUT' : 'OCR_API_ERROR'
            )
          );
          return;
        }

        if (err) {
          const lines = output
            .trim()
            .split('\n')
            .filter((l) => l.trim());
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i].trim()) as unknown;
              if (this.isErrorResponse(parsed)) {
                reject(mapPythonError(parsed.category, parsed.error, parsed.details));
                return;
              }
            } catch (error) {
              console.error(
                '[DatalabOCR] JSON parse failed for processRaw error output line, skipping:',
                error instanceof Error ? error.message : String(error)
              );
              /* not JSON, skip */
            }
          }
          const detail = stderr ? `${err.message}\nPython stderr:\n${stderr}` : err.message;
          reject(new OCRError(`Python worker failed: ${detail}`, 'OCR_API_ERROR'));
          return;
        }

        const lines = output
          .trim()
          .split('\n')
          .filter((l) => l.trim());
        if (lines.length === 0) {
          const diagnostics = [
            'No output from OCR worker.',
            `Exit code: ${exitCode}, signal: ${exitSignal}.`,
            `File: ${rawFilePath}.`,
          ];
          if (stderr.trim()) {
            diagnostics.push(`Python stderr: ${stderr.trim().substring(0, 500)}`);
          } else {
            diagnostics.push('Python stderr was empty (logging suppressed in --json mode).');
          }
          reject(new OCRError(diagnostics.join(' '), 'OCR_API_ERROR'));
          return;
        }

        let response: unknown;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            response = JSON.parse(lines[i].trim());
            break;
          } catch (error) {
            console.error(
              '[DatalabOCR] JSON parse failed for processRaw output line, trying previous:',
              error instanceof Error ? error.message : String(error)
            );
            /* not JSON, try previous line */
          }
        }

        if (!response) {
          reject(
            new OCRError(
              `Failed to parse OCR worker output as JSON. Last line: ${lines[lines.length - 1]?.substring(0, 200)}`,
              'OCR_API_ERROR'
            )
          );
          return;
        }

        if (this.isErrorResponse(response)) {
          reject(mapPythonError(response.category, response.error, response.details));
          return;
        }

        const ocrResponse = response as PythonOCRResponse;

        resolve({
          markdown: ocrResponse.extracted_text ?? '',
          pageCount: ocrResponse.page_count ?? 0,
          qualityScore: ocrResponse.parse_quality_score ?? null,
          costCents: ocrResponse.cost_cents ?? null,
          durationMs: ocrResponse.processing_duration_ms ?? 0,
          metadata: ocrResponse.metadata ?? null,
        });
      });
    });
  }

  private isErrorResponse(response: unknown): response is PythonErrorResponse {
    return (
      typeof response === 'object' &&
      response !== null &&
      'error' in response &&
      'category' in response
    );
  }

  private toOCRResult(r: PythonOCRResponse): OCRResult {
    // Direct field mapping - Python snake_case matches TS interface
    // Build extras_json from metadata + cost_breakdown
    const extras: Record<string, unknown> = {};
    if (r.metadata) extras.metadata = r.metadata;
    if (r.cost_breakdown_full) extras.cost_breakdown = r.cost_breakdown_full;

    return {
      id: r.id,
      provenance_id: r.provenance_id,
      document_id: r.document_id,
      extracted_text: r.extracted_text,
      text_length: r.text_length,
      datalab_request_id: r.datalab_request_id,
      datalab_mode: r.datalab_mode,
      parse_quality_score: r.parse_quality_score,
      page_count: r.page_count,
      cost_cents: r.cost_cents,
      content_hash: r.content_hash,
      processing_started_at: r.processing_started_at,
      processing_completed_at: r.processing_completed_at,
      processing_duration_ms: r.processing_duration_ms,
      json_blocks: r.json_blocks ? JSON.stringify(r.json_blocks) : null,
      extras_json: Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
    };
  }

  private toPageOffsets(
    offsets: Array<{ page: number; char_start: number; char_end: number }>
  ): PageOffset[] {
    // Convert Python snake_case to TS camelCase
    return offsets.map((o) => ({ page: o.page, charStart: o.char_start, charEnd: o.char_end }));
  }
}
