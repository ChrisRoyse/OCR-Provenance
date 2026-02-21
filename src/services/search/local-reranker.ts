/**
 * Local Cross-Encoder Reranker - TypeScript bridge to python/reranker_worker.py
 *
 * Spawns the Python cross-encoder worker to rerank search results locally
 * using ms-marco-MiniLM-L-12-v2. No cloud API calls.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/search/local-reranker
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Max stderr accumulation: 10KB */
const MAX_STDERR_LENGTH = 10_240;

/** Timeout for reranker process: 30 seconds */
const RERANKER_TIMEOUT_MS = 30_000;

/** SIGKILL grace period after SIGTERM: 5 seconds */
const SIGKILL_GRACE_MS = 5_000;

interface LocalRerankInput {
  index: number;
  text: string;
  original_score: number;
}

interface LocalRerankResult {
  index: number;
  relevance_score: number;
  original_score: number;
}

/**
 * Rerank passages locally using the Python cross-encoder worker.
 *
 * @param query - The search query
 * @param passages - Passages to rerank with index, text, and original_score
 * @returns Reranked results sorted by relevance_score descending, or null if unavailable
 */
export async function localRerank(
  query: string,
  passages: LocalRerankInput[]
): Promise<LocalRerankResult[] | null> {
  const scriptPath = path.resolve(__dirname, '../../../python/reranker_worker.py');

  if (!fs.existsSync(scriptPath)) {
    console.error('[local-reranker] Python reranker script not found:', scriptPath);
    return null;
  }

  const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
  const inputPayload = JSON.stringify({ query, passages });

  return new Promise((resolve) => {
    const proc = spawn(pythonPath, [scriptPath], {
      timeout: RERANKER_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
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

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_STDERR_LENGTH) {
        stderr += data.toString();
      }
    });

    proc.on('error', (err: Error) => {
      cleanup();
      if (settled) return;
      settled = true;
      console.error('[local-reranker] Process error:', err.message);
      resolve(null);
    });

    proc.on('close', (code: number | null, signal: string | null) => {
      cleanup();
      if (settled) return;
      settled = true;

      if (stderr.trim()) {
        console.error('[local-reranker] stderr:', stderr.trim().slice(0, 500));
      }

      if (code !== 0) {
        console.error(
          `[local-reranker] Process exited with code ${String(code)}, signal ${String(signal)}`
        );
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);

        // Check for error response
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          console.error('[local-reranker] Worker error:', parsed.error);
          resolve(null);
          return;
        }

        if (!Array.isArray(parsed)) {
          console.error('[local-reranker] Expected array, got:', typeof parsed);
          resolve(null);
          return;
        }

        resolve(parsed as LocalRerankResult[]);
      } catch (parseErr) {
        console.error(
          '[local-reranker] JSON parse failed:',
          parseErr instanceof Error ? parseErr.message : String(parseErr),
          'stdout preview:',
          stdout.slice(0, 200)
        );
        resolve(null);
      }
    });

    // M-6: SIGKILL escalation after SIGTERM timeout
    proc.on('exit', () => {
      cleanup();
    });

    // Write input and close stdin
    proc.stdin.write(inputPayload);
    proc.stdin.end();

    // Set up SIGKILL escalation if the process doesn't exit after SIGTERM (from timeout)
    setTimeout(() => {
      if (!settled && !proc.killed) {
        console.error('[local-reranker] Timeout reached, sending SIGTERM');
        proc.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!settled && !proc.killed) {
            console.error('[local-reranker] SIGKILL escalation after grace period');
            proc.kill('SIGKILL');
          }
        }, SIGKILL_GRACE_MS);
      }
    }, RERANKER_TIMEOUT_MS);
  });
}
