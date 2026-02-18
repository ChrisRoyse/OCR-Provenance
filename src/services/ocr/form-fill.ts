/**
 * Datalab Form Fill Bridge
 *
 * Invokes python/form_fill_worker.py via python-shell.
 * NO MOCKS, NO FALLBACKS - real API calls only.
 */

import { PythonShell, Options } from 'python-shell';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OCRError, mapPythonError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Max stderr accumulation: 10KB (matches datalab.ts pattern) */
const MAX_STDERR_LENGTH = 10_240;

interface FormFillOptions {
  fieldData: Record<string, { value: string; description?: string }>;
  context?: string;
  confidenceThreshold?: number;
  pageRange?: string;
}

interface FormFillResult {
  id: string;
  sourceFilePath: string;
  sourceFileHash: string;
  outputBase64: string | null;
  fieldsFilled: string[];
  fieldsNotFound: string[];
  pageCount: number | null;
  costCents: number | null;
  status: 'complete' | 'failed';
  error: string | null;
  processingDurationMs: number;
}

interface PythonFormFillResponse {
  id: string;
  source_file_path: string;
  source_file_hash: string;
  output_base64: string | null;
  fields_filled: string[];
  fields_not_found: string[];
  page_count: number | null;
  cost_cents: number | null;
  status: string;
  error: string | null;
  processing_duration_ms: number;
}

interface PythonErrorResponse {
  error: string;
  category: string;
  details?: Record<string, unknown>;
}

interface FormFillClientConfig {
  pythonPath?: string;
  timeout?: number;
}

export class FormFillClient {
  private readonly pythonPath: string | undefined;
  private readonly workerPath: string;
  private readonly timeout: number;

  constructor(config: FormFillClientConfig = {}) {
    this.pythonPath = config.pythonPath;
    this.workerPath = resolve(__dirname, '../../../python/form_fill_worker.py');
    const parsedTimeout = parseInt(process.env.DATALAB_TIMEOUT || '330000');
    this.timeout = config.timeout ?? (Number.isNaN(parsedTimeout) ? 330000 : parsedTimeout);
  }

  /**
   * Fill a form document through Datalab API
   *
   * FAIL-FAST: Throws on any error, no fallbacks
   */
  async fillForm(filePath: string, options: FormFillOptions): Promise<FormFillResult> {
    const args = ['--file', filePath, '--field-data', JSON.stringify(options.fieldData), '--json'];
    if (options.context) args.push('--context', options.context);
    if (options.confidenceThreshold !== undefined)
      args.push('--confidence-threshold', String(options.confidenceThreshold));
    if (options.pageRange) args.push('--page-range', options.pageRange);

    const shellOptions: Options = {
      mode: 'text',
      pythonPath: this.pythonPath,
      pythonOptions: ['-u'],
      args,
    };

    return new Promise((promiseResolve, reject) => {
      let settled = false;
      const shell = new PythonShell(this.workerPath, shellOptions);
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
            '[FormFill] Failed to kill shell on timeout:',
            error instanceof Error ? error.message : String(error)
          );
          /* ignore */
        }
        // M-6: SIGKILL escalation if SIGTERM doesn't exit within 5s
        sigkillTimer = setTimeout(() => {
          if (!settled) {
            console.error(
              `[FormFill] Process did not exit after SIGTERM, sending SIGKILL (pid: ${shell.childProcess?.pid})`
            );
            try {
              shell.childProcess?.kill('SIGKILL');
            } catch (error) {
              console.error(
                '[FormFill] Failed to SIGKILL process (may already be gone):',
                error instanceof Error ? error.message : String(error)
              );
            }
          }
          if (!settled) {
            settled = true;
            reject(new OCRError(`Form fill timeout after ${this.timeout}ms (SIGKILL after 5s grace)`, 'FORM_FILL_TIMEOUT'));
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

        // Join chunks once instead of repeated string concatenation
        const output = outputChunks.join('\n');
        // Allow early GC of chunk array
        outputChunks.length = 0;

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
                reject(mapPythonError(parsed.category, parsed.error, parsed.details ?? {}));
                return;
              }
            } catch (error) {
              console.error(
                '[FormFill] JSON parse failed for error output line, skipping:',
                error instanceof Error ? error.message : String(error)
              );
              /* not JSON, skip */
            }
          }
          const detail = stderr ? `${err.message}\nPython stderr:\n${stderr}` : err.message;
          reject(new OCRError(`Form fill worker failed: ${detail}`, 'FORM_FILL_API_ERROR'));
          return;
        }

        // Parse the last JSON line from stdout (Python may output non-JSON logging)
        const lines = output
          .trim()
          .split('\n')
          .filter((l) => l.trim());
        if (lines.length === 0) {
          reject(new OCRError('No output from form fill worker', 'FORM_FILL_API_ERROR'));
          return;
        }

        let response: unknown;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            response = JSON.parse(lines[i].trim());
            break;
          } catch (error) {
            console.error(
              '[FormFill] JSON parse failed for output line, trying previous:',
              error instanceof Error ? error.message : String(error)
            );
            /* not JSON, try previous line */
          }
        }

        if (!response) {
          reject(
            new OCRError(
              `Failed to parse form fill output as JSON. Last line: ${lines[lines.length - 1]?.substring(0, 200)}`,
              'FORM_FILL_API_ERROR'
            )
          );
          return;
        }

        // Check for error response
        if (this.isErrorResponse(response)) {
          const resp = response as unknown as Record<string, unknown>;
          const category = (resp.category as string) ?? 'FORM_FILL_API_ERROR';
          const error = (resp.error as string) ?? 'Form fill failed';
          reject(mapPythonError(category, error, (resp.details as Record<string, unknown>) ?? {}));
          return;
        }

        // Validate required fields before casting
        const resp = response as Record<string, unknown>;
        if (
          typeof resp.id !== 'string' ||
          typeof resp.source_file_path !== 'string' ||
          typeof resp.status !== 'string'
        ) {
          reject(
            new OCRError(
              `Form fill worker response missing required fields (id, source_file_path, status). Got keys: ${Object.keys(resp).join(', ')}`,
              'FORM_FILL_API_ERROR'
            )
          );
          return;
        }
        promiseResolve(this.toFormFillResult(response as PythonFormFillResponse));
      });
    });
  }

  private isErrorResponse(response: unknown): response is PythonErrorResponse {
    if (typeof response !== 'object' || response === null) return false;
    // Standard error response with error + category (from Python worker error paths)
    if ('error' in response && 'category' in response) return true;
    // NOTE: Do NOT treat status='failed' FormFillResult as an error — it is a valid
    // partial-failure response containing fields_filled/fields_not_found data.
    return false;
  }

  private toFormFillResult(r: PythonFormFillResponse): FormFillResult {
    return {
      id: r.id,
      sourceFilePath: r.source_file_path,
      sourceFileHash: r.source_file_hash,
      outputBase64: r.output_base64,
      fieldsFilled: r.fields_filled ?? [],
      fieldsNotFound: r.fields_not_found ?? [],
      pageCount: r.page_count,
      costCents: r.cost_cents,
      status: r.status as 'complete' | 'failed',
      error: r.error,
      processingDurationMs: r.processing_duration_ms ?? 0,
    };
  }
}
