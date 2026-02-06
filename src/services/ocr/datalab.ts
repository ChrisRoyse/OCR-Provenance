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
  private readonly pythonPath: string;
  private readonly workerPath: string;
  private readonly timeout: number;

  constructor(config: DatalabClientConfig = {}) {
    this.pythonPath = config.pythonPath ?? 'python3';
    this.workerPath = resolve(__dirname, '../../../python/ocr_worker.py');
    this.timeout = config.timeout ?? parseInt(process.env.DATALAB_TIMEOUT || '900000'); // 15 minutes
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
    mode: 'fast' | 'balanced' | 'accurate' = 'accurate'
  ): Promise<{
    result: OCRResult;
    pageOffsets: PageOffset[];
    images: Record<string, string>;
    jsonBlocks: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  }> {
    const options: Options = {
      mode: 'json',
      pythonPath: this.pythonPath,
      args: [
        '--file', filePath,
        '--mode', mode,
        '--doc-id', documentId,
        '--prov-id', provenanceId,
        '--json'
      ],
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new OCRError(`OCR timeout after ${this.timeout}ms`, 'OCR_TIMEOUT'));
      }, this.timeout);

      PythonShell.run(this.workerPath, options)
        .then((results) => {
          clearTimeout(timeout);

          if (!results || results.length === 0) {
            throw new OCRError('No output from OCR worker', 'OCR_API_ERROR');
          }

          const response = results[0] as unknown;

          // Check for error response
          if (this.isErrorResponse(response)) {
            throw mapPythonError(response.category, response.error, response.details);
          }

          const ocrResponse = response as PythonOCRResponse;

          // Verify required fields exist
          if (!ocrResponse.id || !ocrResponse.content_hash || !ocrResponse.extracted_text) {
            throw new OCRError(
              `Invalid OCR response: missing required fields. Got: ${JSON.stringify(Object.keys(ocrResponse))}`,
              'OCR_API_ERROR'
            );
          }

          resolve({
            result: this.toOCRResult(ocrResponse),
            pageOffsets: this.toPageOffsets(ocrResponse.page_offsets),
            images: ocrResponse.images ?? {},
            jsonBlocks: ocrResponse.json_blocks ?? null,
            metadata: ocrResponse.metadata ?? null,
          });
        })
        .catch((error) => {
          clearTimeout(timeout);
          if (error instanceof OCRError) {
            reject(error);
          } else {
            // PythonShellError puts parsed JSON stdout in error.logs array
            const logs = (error as Record<string, unknown>).logs as unknown[] | undefined;
            if (logs && logs.length > 0) {
              const lastLog = logs[logs.length - 1];
              if (this.isErrorResponse(lastLog)) {
                reject(mapPythonError(lastLog.category, lastLog.error, lastLog.details));
                return;
              }
            }
            const stderr = (error as Record<string, unknown>).traceback ?? (error as Record<string, unknown>).stderr ?? '';
            const detail = stderr ? `${error.message}\nPython stderr:\n${stderr}` : error.message;
            reject(new OCRError(`Python worker failed: ${detail}`, 'OCR_API_ERROR'));
          }
        });
    });
  }

  private isErrorResponse(response: unknown): response is PythonErrorResponse {
    return typeof response === 'object' && response !== null && 'error' in response && 'category' in response;
  }

  private toOCRResult(r: PythonOCRResponse): OCRResult {
    // Direct field mapping - Python snake_case matches TS interface
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
    };
  }

  private toPageOffsets(
    offsets: Array<{ page: number; char_start: number; char_end: number }>
  ): PageOffset[] {
    // Convert Python snake_case to TS camelCase
    return offsets.map(o => ({ page: o.page, charStart: o.char_start, charEnd: o.char_end }));
  }
}
