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
  private readonly pythonPath: string;
  private readonly workerPath: string;
  private readonly timeout: number;

  constructor(config: DatalabClientConfig = {}) {
    this.pythonPath = config.pythonPath ?? 'python3';
    this.workerPath = resolve(__dirname, '../../../python/ocr_worker.py');
    const parsedTimeout = parseInt(process.env.DATALAB_TIMEOUT || '900000');
    this.timeout = config.timeout ?? (Number.isNaN(parsedTimeout) ? 900000 : parsedTimeout); // 15 minutes
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
      '--file', filePath,
      '--mode', mode,
      '--doc-id', documentId,
      '--prov-id', provenanceId,
      '--json',
    ];
    if (ocrOptions?.maxPages) args.push('--max-pages', String(ocrOptions.maxPages));
    if (ocrOptions?.pageRange) args.push('--page-range', ocrOptions.pageRange);
    if (ocrOptions?.skipCache) args.push('--skip-cache');
    if (ocrOptions?.disableImageExtraction) args.push('--disable-image-extraction');
    if (ocrOptions?.extras?.length) args.push('--extras', ocrOptions.extras.join(','));
    if (ocrOptions?.pageSchema) args.push('--page-schema', ocrOptions.pageSchema);
    if (ocrOptions?.additionalConfig) args.push('--additional-config', JSON.stringify(ocrOptions.additionalConfig));

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

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Kill the Python process to prevent orphans
        try { shell.kill(); } catch { /* ignore */ }
        reject(new OCRError(`OCR timeout after ${this.timeout}ms`, 'OCR_TIMEOUT'));
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

        // H-3: Join chunks once instead of repeated string concatenation
        const output = outputChunks.join('\n');
        // M-12: Allow early GC of chunk array
        outputChunks.length = 0;

        if (err) {
          // Try to parse JSON from output for structured error
          const lines = output.trim().split('\n').filter(l => l.trim());
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]) as unknown;
              if (this.isErrorResponse(parsed)) {
                reject(mapPythonError(parsed.category, parsed.error, parsed.details));
                return;
              }
            } catch { /* not JSON, skip */ }
          }
          const detail = stderr ? `${err.message}\nPython stderr:\n${stderr}` : err.message;
          reject(new OCRError(`Python worker failed: ${detail}`, 'OCR_API_ERROR'));
          return;
        }

        // Parse the last JSON line from stdout (Python may output non-JSON logging)
        const lines = output.trim().split('\n').filter(l => l.trim());
        if (lines.length === 0) {
          reject(new OCRError('No output from OCR worker', 'OCR_API_ERROR'));
          return;
        }

        let response: unknown;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            response = JSON.parse(lines[i]);
            break;
          } catch { /* not JSON, try previous line */ }
        }

        if (!response) {
          reject(new OCRError(
            `Failed to parse OCR worker output as JSON. Last line: ${lines[lines.length - 1]?.substring(0, 200)}`,
            'OCR_API_ERROR'
          ));
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
          reject(new OCRError(
            `Invalid OCR response: missing required fields. Got: ${JSON.stringify(Object.keys(ocrResponse))}`,
            'OCR_API_ERROR'
          ));
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

  private isErrorResponse(response: unknown): response is PythonErrorResponse {
    return typeof response === 'object' && response !== null && 'error' in response && 'category' in response;
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
    return offsets.map(o => ({ page: o.page, charStart: o.char_start, charEnd: o.char_end }));
  }
}
