/**
 * Datalab File Manager Bridge
 *
 * Invokes python/file_manager_worker.py via python-shell.
 * NO MOCKS, NO FALLBACKS - real API calls only.
 */

import { PythonShell, Options } from 'python-shell';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OCRError, mapPythonError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Max stderr accumulation: 10KB (matches datalab.ts pattern) */
const MAX_STDERR_LENGTH = 10_240;

interface FileUploadResult {
  fileId: string;
  reference: string | null;
  fileName: string;
  fileHash: string;
  fileSize: number;
  contentType: string;
  status: 'complete' | 'failed';
  error: string | null;
  processingDurationMs: number;
}

interface FileInfo {
  fileId: string;
  fileName: string | null;
  fileSize: number | null;
  contentType: string | null;
  createdAt: string | null;
  reference: string | null;
  status: string | null;
}

interface FileListResult {
  files: Record<string, unknown>[];
  total: number;
}

interface PythonUploadResponse {
  file_id: string;
  reference: string | null;
  file_name: string;
  file_hash: string;
  file_size: number;
  content_type: string;
  status: string;
  error: string | null;
  processing_duration_ms: number;
}

interface PythonFileInfoResponse {
  file_id: string;
  file_name: string | null;
  file_size: number | null;
  content_type: string | null;
  created_at: string | null;
  reference: string | null;
  status: string | null;
}

interface PythonFileListResponse {
  files: Record<string, unknown>[];
  total: number;
}

interface PythonErrorResponse {
  error: string;
  category: string;
  details?: Record<string, unknown>;
}

interface FileManagerClientConfig {
  pythonPath?: string;
  timeout?: number;
}

export class FileManagerClient {
  private readonly pythonPath: string | undefined;
  private readonly workerPath: string;
  private readonly timeout: number;

  constructor(config: FileManagerClientConfig = {}) {
    this.pythonPath = config.pythonPath;
    this.workerPath = resolve(__dirname, '../../../python/file_manager_worker.py');
    const parsedTimeout = parseInt(process.env.DATALAB_TIMEOUT || '330000');
    this.timeout = config.timeout ?? (Number.isNaN(parsedTimeout) ? 330000 : parsedTimeout);
  }

  /**
   * Upload a file to Datalab cloud storage
   *
   * FAIL-FAST: Throws on any error, no fallbacks
   */
  async uploadFile(filePath: string): Promise<FileUploadResult> {
    const args = ['--action', 'upload', '--file', filePath];
    const response = await this.runWorker<PythonUploadResponse>(args);
    return {
      fileId: String(response.file_id),
      reference: response.reference,
      fileName: response.file_name,
      fileHash: response.file_hash,
      fileSize: response.file_size,
      contentType: response.content_type,
      status: response.status as 'complete' | 'failed',
      error: response.error,
      processingDurationMs: response.processing_duration_ms ?? 0,
    };
  }

  /**
   * List files in Datalab cloud storage
   */
  async listFiles(limit: number = 50, offset: number = 0): Promise<FileListResult> {
    const args = ['--action', 'list', '--limit', String(limit), '--offset', String(offset)];
    const response = await this.runWorker<PythonFileListResponse>(args);
    return {
      files: response.files ?? [],
      total: response.total ?? 0,
    };
  }

  /**
   * Get file metadata by ID
   */
  async getFile(fileId: string): Promise<FileInfo> {
    const args = ['--action', 'get', '--file-id', fileId];
    const response = await this.runWorker<PythonFileInfoResponse>(args);
    return {
      fileId: String(response.file_id),
      fileName: response.file_name,
      fileSize: response.file_size,
      contentType: response.content_type,
      createdAt: response.created_at,
      reference: response.reference,
      status: response.status,
    };
  }

  /**
   * Get download URL for a file
   */
  async getDownloadUrl(fileId: string): Promise<string> {
    const args = ['--action', 'download-url', '--file-id', fileId];
    const response = await this.runWorker<{ download_url: string }>(args);
    return response.download_url;
  }

  /**
   * Delete a file from Datalab cloud storage
   */
  async deleteFile(fileId: string): Promise<boolean> {
    const args = ['--action', 'delete', '--file-id', fileId];
    const response = await this.runWorker<{ deleted: boolean }>(args);
    return response.deleted;
  }

  /**
   * Run the Python worker with given args and parse JSON output
   */
  private runWorker<T>(args: string[]): Promise<T> {
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

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          shell.kill();
        } catch (error) {
          console.error(
            '[FileManager] Failed to kill shell on timeout:',
            error instanceof Error ? error.message : String(error)
          );
          /* ignore */
        }
        reject(new OCRError(`File manager timeout after ${this.timeout}ms`, 'OCR_TIMEOUT'));
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
        if (settled) return;
        settled = true;

        const output = outputChunks.join('\n');
        outputChunks.length = 0;

        if (err) {
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
                '[FileManager] JSON parse failed for error output line, skipping:',
                error instanceof Error ? error.message : String(error)
              );
              /* not JSON, skip */
            }
          }
          const detail = stderr ? `${err.message}\nPython stderr:\n${stderr}` : err.message;
          reject(new OCRError(`File manager worker failed: ${detail}`, 'OCR_API_ERROR'));
          return;
        }

        const lines = output
          .trim()
          .split('\n')
          .filter((l) => l.trim());
        if (lines.length === 0) {
          reject(new OCRError('No output from file manager worker', 'OCR_API_ERROR'));
          return;
        }

        let response: unknown;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            response = JSON.parse(lines[i].trim());
            break;
          } catch (error) {
            console.error(
              '[FileManager] JSON parse failed for output line, trying previous:',
              error instanceof Error ? error.message : String(error)
            );
            /* not JSON, try previous line */
          }
        }

        if (!response) {
          reject(
            new OCRError(
              `Failed to parse file manager output as JSON. Last line: ${lines[lines.length - 1]?.substring(0, 200)}`,
              'OCR_API_ERROR'
            )
          );
          return;
        }

        if (this.isErrorResponse(response)) {
          reject(mapPythonError(response.category, response.error, response.details ?? {}));
          return;
        }

        promiseResolve(response as T);
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
}
