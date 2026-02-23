/**
 * Cross-Platform Device Detection Tests (TypeScript side)
 *
 * Tests that:
 * 1. Python resolve_device() and detect_best_device() are callable
 * 2. DEFAULT_DEVICE constant is 'auto'
 * 3. CLI --device flag is accepted for cpu/auto
 * 4. CPU embeddings produce correct dimensions
 * 5. CPU and auto-detected device produce cosine-similar embeddings
 *
 * Split into:
 * - Unit tests (fast, no model): constant checks, function signatures
 * - Integration tests (slow, needs model): actual embedding generation
 *
 * Requires: Python 3.10+, PyTorch, sentence-transformers, nomic model
 * Integration tests are skipped if model not present.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const PROJECT_ROOT = resolve(__dirname, '../../..');
const EMBEDDING_WORKER = resolve(PROJECT_ROOT, 'python/embedding_worker.py');
const MODEL_PATH = resolve(PROJECT_ROOT, 'models/nomic-embed-text-v1.5');

// Check if model is available for integration tests
const MODEL_AVAILABLE = existsSync(resolve(MODEL_PATH, 'config.json'));

/**
 * Run a Python expression and return stdout.
 */
function pyEval(code: string): string {
  return execFileSync(PYTHON, ['-c', code], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: resolve(PROJECT_ROOT, 'python') },
  }).trim();
}

/**
 * Run embedding worker CLI and return parsed JSON.
 */
function runWorker(args: string[], timeout = 120000): Record<string, unknown> {
  const stdout = execFileSync(PYTHON, [EMBEDDING_WORKER, ...args, '--json'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

// =============================================================================
// Unit tests — no model required, fast
// =============================================================================

describe('Cross-platform device detection (unit)', () => {
  describe('DEFAULT_DEVICE constant', () => {
    it('is set to "auto"', () => {
      const device = pyEval(`
import sys; sys.path.insert(0, 'python')
from embedding_worker import DEFAULT_DEVICE
print(DEFAULT_DEVICE)
`);
      expect(device).toBe('auto');
    });
  });

  describe('resolve_device()', () => {
    it('returns a valid device for "auto"', () => {
      const device = pyEval(`
import sys; sys.path.insert(0, 'python')
from embedding_worker import resolve_device
print(resolve_device('auto'))
`);
      expect(['cuda:0', 'mps', 'cpu']).toContain(device);
    });

    it('returns "cpu" for explicit cpu request', () => {
      const device = pyEval(`
import sys; sys.path.insert(0, 'python')
from embedding_worker import resolve_device
print(resolve_device('cpu'))
`);
      expect(device).toBe('cpu');
    });

    it('passes through unknown device strings', () => {
      const device = pyEval(`
import sys; sys.path.insert(0, 'python')
from embedding_worker import resolve_device
print(resolve_device('xpu:0'))
`);
      expect(device).toBe('xpu:0');
    });

    it('gracefully handles unavailable mps', () => {
      const device = pyEval(`
import sys; sys.path.insert(0, 'python')
from embedding_worker import resolve_device
print(resolve_device('mps'))
`);
      // Falls back to auto -> whatever is available
      expect(['cuda:0', 'mps', 'cpu']).toContain(device);
    });
  });

  describe('detect_best_device()', () => {
    it('returns a recognized device string', () => {
      const device = pyEval(`
import sys; sys.path.insert(0, 'python')
from gpu_utils import detect_best_device
print(detect_best_device())
`);
      expect(['cuda:0', 'mps', 'cpu']).toContain(device);
    });
  });

  describe('verify_gpu()', () => {
    it('returns GPUInfo dict without raising', () => {
      const output = pyEval(`
import sys, json; sys.path.insert(0, 'python')
from gpu_utils import verify_gpu
info = verify_gpu()
print(json.dumps(info))
`);
      const info = JSON.parse(output) as Record<string, unknown>;
      expect(info).toHaveProperty('available');
      expect(info).toHaveProperty('name');
      expect(info).toHaveProperty('vram_gb');
      expect(typeof info.available).toBe('boolean');
      expect(typeof info.name).toBe('string');
    });
  });
});

// =============================================================================
// Integration tests — require embedding model
// =============================================================================

describe.skipIf(!MODEL_AVAILABLE)('Cross-platform embedding (integration)', () => {
  describe('CLI --device cpu', () => {
    it('generates 768-dim query embedding on CPU', () => {
      const result = runWorker(['--query', 'cross platform test', '--device', 'cpu']);
      expect(result.success).toBe(true);
      expect(result.device).toBe('cpu');
      expect((result.embedding as number[]).length).toBe(768);
    }, 120000);

    it('generates chunk embeddings on CPU', () => {
      const result = runWorker(['--chunks', 'chunk one', 'chunk two', '--device', 'cpu']);
      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect((result.embeddings as number[][]).length).toBe(2);
      expect((result.embeddings as number[][])[0].length).toBe(768);
    }, 120000);
  });

  describe('CLI --device auto', () => {
    it('generates 768-dim query embedding', () => {
      const result = runWorker(['--query', 'auto device test', '--device', 'auto']);
      expect(result.success).toBe(true);
      // L-1 fix: device field now contains the resolved device (e.g. "cuda:0", "mps", "cpu")
      // instead of the raw input parameter "auto"
      expect(result.device).not.toBe('auto');
      expect(typeof result.device).toBe('string');
      expect((result.embedding as number[]).length).toBe(768);
    }, 120000);
  });

  describe('Cross-device consistency', () => {
    it('CPU and auto produce cosine-similar embeddings (>0.99)', () => {
      const cpuResult = runWorker(['--query', 'consistency test phrase', '--device', 'cpu']);
      const autoResult = runWorker(['--query', 'consistency test phrase', '--device', 'auto']);

      expect(cpuResult.success).toBe(true);
      expect(autoResult.success).toBe(true);

      const cpuEmb = cpuResult.embedding as number[];
      const autoEmb = autoResult.embedding as number[];

      // Cosine similarity — normalized vectors, so dot product = cosine
      let dot = 0;
      for (let i = 0; i < 768; i++) {
        dot += cpuEmb[i] * autoEmb[i];
      }
      // Same model, same text: >0.99 even with CPU/GPU float precision diffs
      expect(dot).toBeGreaterThan(0.99);
    }, 240000);
  });
});
