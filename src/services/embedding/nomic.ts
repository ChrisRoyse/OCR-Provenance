/**
 * NomicEmbeddingClient - TypeScript bridge to python/embedding_worker.py
 *
 * CP-004: Local GPU inference ONLY - throws EmbeddingError on GPU unavailable.
 * NO cloud fallback, NO CPU fallback. FAIL FAST with robust error logging.
 *
 * @module services/embedding/nomic
 */

import { PythonShell, Options as PythonShellOptions } from 'python-shell';
import path from 'path';

export type EmbeddingErrorCode =
  | 'GPU_NOT_AVAILABLE'
  | 'EMBEDDING_FAILED'
  | 'PARSE_ERROR'
  | 'WORKER_ERROR'
  | 'MODEL_NOT_FOUND';

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly code: EmbeddingErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'EmbeddingError';
    Error.captureStackTrace?.(this, EmbeddingError);
  }
}

/** Result from batch embedding (matches Python EmbeddingResult dataclass) */
export interface EmbeddingResult {
  success: boolean;
  embeddings: number[][]; // (n, 768) as nested array
  count: number;
  elapsed_ms: number;
  ms_per_chunk: number;
  device: string;
  batch_size: number;
  model: string;
  model_version: string;
  vram_used_gb: number;
  error: string | null;
}

/** Result from single query embedding (matches Python QueryEmbeddingResult dataclass) */
export interface QueryEmbeddingResult {
  success: boolean;
  embedding: number[]; // (768,) as array
  elapsed_ms: number;
  device: string;
  model: string;
  error: string | null;
}

export const EMBEDDING_DIM = 768;
export const MODEL_NAME = 'nomic-embed-text-v1.5';
export const MODEL_VERSION = '1.5.0';
export const DEFAULT_BATCH_SIZE = 512;
export const DEFAULT_DEVICE = 'cuda:0';

export class NomicEmbeddingClient {
  private readonly workerPath: string;
  private readonly pythonPath: string | undefined;

  constructor(options?: { workerPath?: string; pythonPath?: string }) {
    this.workerPath =
      options?.workerPath ??
      path.join(process.cwd(), 'python', 'embedding_worker.py');
    this.pythonPath = options?.pythonPath;
  }

  async embedChunks(
    chunks: string[],
    batchSize: number = DEFAULT_BATCH_SIZE
  ): Promise<Float32Array[]> {
    // Empty input returns empty output
    if (chunks.length === 0) {
      return [];
    }

    // Use stdin for reliability with special characters and large inputs
    const result = await this.runWorker<EmbeddingResult>(
      ['--stdin', '--batch-size', batchSize.toString(), '--json'],
      JSON.stringify(chunks)
    );

    if (!result.success) {
      throw new EmbeddingError(
        result.error ?? 'Embedding generation failed with no error message',
        this.classifyError(result.error),
        {
          count: chunks.length,
          batchSize,
          device: result.device,
          elapsed_ms: result.elapsed_ms,
        }
      );
    }

    // Validate output dimensions
    for (let i = 0; i < result.embeddings.length; i++) {
      if (result.embeddings[i].length !== EMBEDDING_DIM) {
        throw new EmbeddingError(
          `Embedding ${i} has wrong dimensions: ${result.embeddings[i].length}, expected ${EMBEDDING_DIM}`,
          'EMBEDDING_FAILED',
          { index: i, actualDim: result.embeddings[i].length }
        );
      }
    }

    // Convert to Float32Array for efficient storage
    return result.embeddings.map((e) => new Float32Array(e));
  }

  async embedQuery(query: string): Promise<Float32Array> {
    if (!query || query.trim().length === 0) {
      throw new EmbeddingError(
        'Query cannot be empty',
        'EMBEDDING_FAILED',
        { query }
      );
    }

    const result = await this.runWorker<QueryEmbeddingResult>([
      '--query',
      query,
      '--json',
    ]);

    if (!result.success) {
      throw new EmbeddingError(
        result.error ?? 'Query embedding failed with no error message',
        this.classifyError(result.error),
        { query: query.substring(0, 100), device: result.device }
      );
    }

    // Validate dimensions
    if (result.embedding.length !== EMBEDDING_DIM) {
      throw new EmbeddingError(
        `Query embedding has wrong dimensions: ${result.embedding.length}, expected ${EMBEDDING_DIM}`,
        'EMBEDDING_FAILED',
        { actualDim: result.embedding.length }
      );
    }

    return new Float32Array(result.embedding);
  }

  private async runWorker<T>(args: string[], stdin?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const options: PythonShellOptions = {
        mode: 'text',
        pythonPath: this.pythonPath,
        pythonOptions: ['-u'],
        args,
      };

      const shell = new PythonShell(this.workerPath, options);
      let output = '';
      let stderr = '';

      shell.on('message', (msg: string) => {
        output += msg;
      });

      shell.on('stderr', (err: string) => {
        stderr += err + '\n';
      });

      const handleEnd = (err?: Error) => {
        if (err) {
          console.error('[EmbeddingWorker] Error:', err.message);
          if (stderr) console.error('[EmbeddingWorker] Stderr:', stderr);

          reject(
            new EmbeddingError(
              `Worker error: ${err.message}`,
              this.classifyError(stderr || err.message),
              { stderr, stack: err.stack }
            )
          );
          return;
        }

        if (!output.trim()) {
          reject(new EmbeddingError('Worker produced no output', 'WORKER_ERROR', { stderr }));
          return;
        }

        try {
          resolve(JSON.parse(output) as T);
        } catch (parseError) {
          console.error('[EmbeddingWorker] Parse error:', parseError);
          console.error('[EmbeddingWorker] Raw output:', output.substring(0, 500));

          reject(
            new EmbeddingError('Failed to parse worker output as JSON', 'PARSE_ERROR', {
              output: output.substring(0, 1000),
              stderr,
              parseError: String(parseError),
            })
          );
        }
      };

      if (stdin) shell.send(stdin);
      shell.end(handleEnd);
    });
  }

  private classifyError(error: string | null): EmbeddingErrorCode {
    if (!error) return 'EMBEDDING_FAILED';

    const lower = error.toLowerCase();

    if (lower.includes('gpu') || lower.includes('cuda') || lower.includes('no device')) {
      return 'GPU_NOT_AVAILABLE';
    }

    if (lower.includes('model not found') || lower.includes('no such file')) {
      return 'MODEL_NOT_FOUND';
    }

    return 'EMBEDDING_FAILED';
  }
}

let _client: NomicEmbeddingClient | null = null;

export function getEmbeddingClient(): NomicEmbeddingClient {
  if (!_client) {
    _client = new NomicEmbeddingClient();
  }
  return _client;
}

export function resetEmbeddingClient(): void {
  _client = null;
}
