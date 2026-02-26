/**
 * Python Worker Process Pool
 *
 * Maintains warm Python processes to amortize import costs (torch, transformers).
 * Workers accept JSON commands on stdin, return JSON on stdout.
 * Auto-restart on crash, health checks via heartbeat.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module services/python-pool
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PoolConfig {
  /** Number of worker processes to maintain (default: 3) */
  poolSize: number;
  /** Restart worker after this many tasks (default: 100) */
  maxTasksPerWorker: number;
  /** Health check interval in ms (default: 30000) */
  healthCheckIntervalMs: number;
  /** Task timeout in ms (default: 120000) */
  taskTimeoutMs: number;
}

interface PooledWorker {
  process: ChildProcess;
  busy: boolean;
  taskCount: number;
  lastHeartbeat: number;
  scriptPath: string;
}

interface PoolTask {
  command: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

export interface PoolStatus {
  total: number;
  busy: number;
  idle: number;
  queued: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

export class PythonPool extends EventEmitter {
  private workers: Map<number, PooledWorker> = new Map();
  private taskQueue: PoolTask[] = [];
  private readonly config: PoolConfig;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private nextWorkerId = 0;
  private shuttingDown = false;
  private readonly pythonCommand: string;

  constructor(config?: Partial<PoolConfig>) {
    super();
    this.config = {
      poolSize: config?.poolSize ?? 3,
      maxTasksPerWorker: config?.maxTasksPerWorker ?? 100,
      healthCheckIntervalMs: config?.healthCheckIntervalMs ?? 30000,
      taskTimeoutMs: config?.taskTimeoutMs ?? 120000,
    };
    this.pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
  }

  /**
   * Start the pool with the given Python script.
   *
   * @param scriptPath - Path to the Python worker script
   * @throws Error if pool is shutting down
   */
  start(scriptPath: string): void {
    if (this.shuttingDown) throw new Error('Pool is shutting down');
    for (let i = 0; i < this.config.poolSize; i++) {
      this.spawnWorker(scriptPath);
    }
    this.healthCheckTimer = setInterval(
      () => this.healthCheck(),
      this.config.healthCheckIntervalMs
    );
    this.healthCheckTimer.unref();
    console.error(`[PythonPool] Started with ${this.config.poolSize} workers for ${scriptPath}`);
  }

  /**
   * Execute a command on the next available worker.
   *
   * If all workers are busy, the task is queued and dispatched when
   * a worker becomes available.
   *
   * @param command - JSON-serializable command object
   * @returns Promise resolving with the worker's JSON response
   * @throws Error if pool is shutting down or task times out
   */
  async execute(command: Record<string, unknown>): Promise<unknown> {
    if (this.shuttingDown) throw new Error('Pool is shutting down');

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Python pool task timed out after ${this.config.taskTimeoutMs}ms`));
      }, this.config.taskTimeoutMs);

      const task: PoolTask = { command, resolve, reject, timeoutId };

      // Try to dispatch immediately to a free worker
      const worker = this.getAvailableWorker();
      if (worker) {
        this.dispatchTask(worker, task);
      } else {
        this.taskQueue.push(task);
      }
    });
  }

  /**
   * Shut down all workers and reject queued tasks.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Reject all queued tasks
    for (const task of this.taskQueue) {
      clearTimeout(task.timeoutId);
      task.reject(new Error('Pool shutting down'));
    }
    this.taskQueue = [];

    // Kill all workers
    for (const [, worker] of this.workers) {
      try {
        worker.process.kill('SIGTERM');
        // Force kill after 5s
        const forceTimer = setTimeout(() => {
          try {
            worker.process.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 5000);
        forceTimer.unref();
      } catch {
        // Worker already dead
      }
    }
    this.workers.clear();
    console.error('[PythonPool] Shut down');
  }

  /**
   * Get pool status for diagnostics.
   */
  getStatus(): PoolStatus {
    let busy = 0;
    let idle = 0;
    for (const w of this.workers.values()) {
      if (w.busy) busy++;
      else idle++;
    }
    return {
      total: this.workers.size,
      busy,
      idle,
      queued: this.taskQueue.length,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═════════════════════════════════════════════════════════════════════════════

  private spawnWorker(scriptPath: string): void {
    const id = this.nextWorkerId++;
    const proc = spawn(this.pythonCommand, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const worker: PooledWorker = {
      process: proc,
      busy: false,
      taskCount: 0,
      lastHeartbeat: Date.now(),
      scriptPath,
    };

    // Capture stderr for logging
    let stderrBuf = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) console.error(`[PythonPool:${id}] ${line}`);
      }
    });

    proc.on('exit', (code) => {
      console.error(`[PythonPool] Worker ${id} exited with code ${code}`);
      this.workers.delete(id);
      // Auto-restart if not shutting down
      if (!this.shuttingDown) {
        console.error(`[PythonPool] Restarting worker ${id}...`);
        this.spawnWorker(scriptPath);
      }
    });

    proc.on('error', (err) => {
      console.error(`[PythonPool] Worker ${id} error: ${err.message}`);
    });

    this.workers.set(id, worker);
  }

  private getAvailableWorker(): [number, PooledWorker] | null {
    for (const [id, worker] of this.workers) {
      if (!worker.busy) return [id, worker];
    }
    return null;
  }

  private dispatchTask(entry: [number, PooledWorker], task: PoolTask): void {
    const [id, worker] = entry;
    worker.busy = true;
    worker.taskCount++;

    let stdoutBuf = '';

    const onData = (data: Buffer): void => {
      stdoutBuf += data.toString();
      // Try to parse complete JSON response (newline-delimited)
      const newlineIdx = stdoutBuf.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = stdoutBuf.substring(0, newlineIdx);
        stdoutBuf = stdoutBuf.substring(newlineIdx + 1);

        cleanup();
        clearTimeout(task.timeoutId);

        try {
          const result = JSON.parse(line) as Record<string, unknown>;
          if (!result.success) {
            task.reject(new Error(result.error ? String(result.error) : 'Python worker returned success=false with no error message'));
          } else {
            task.resolve(result);
          }
        } catch {
          task.reject(new Error(`Failed to parse worker response: ${line.substring(0, 200)}`));
        }

        worker.busy = false;
        worker.lastHeartbeat = Date.now();

        // Restart worker if it hit max tasks
        if (worker.taskCount >= this.config.maxTasksPerWorker) {
          console.error(
            `[PythonPool] Worker ${id} hit max tasks (${this.config.maxTasksPerWorker}), recycling`
          );
          worker.process.kill('SIGTERM');
        } else {
          // Process next task in queue
          this.processQueue();
        }
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      clearTimeout(task.timeoutId);
      worker.busy = false;
      task.reject(err);
    };

    const cleanup = (): void => {
      worker.process.stdout?.removeListener('data', onData);
      worker.process.removeListener('error', onError);
    };

    worker.process.stdout?.on('data', onData);
    worker.process.on('error', onError);

    // Send command as newline-delimited JSON
    const cmdStr = JSON.stringify(task.command) + '\n';
    worker.process.stdin?.write(cmdStr, (err) => {
      if (err) {
        cleanup();
        clearTimeout(task.timeoutId);
        worker.busy = false;
        task.reject(new Error(`Failed to write to worker: ${err.message}`));
      }
    });
  }

  private processQueue(): void {
    while (this.taskQueue.length > 0) {
      const worker = this.getAvailableWorker();
      if (!worker) break;
      const task = this.taskQueue.shift()!;
      this.dispatchTask(worker, task);
    }
  }

  private healthCheck(): void {
    const now = Date.now();
    for (const [id, worker] of this.workers) {
      if (worker.busy && now - worker.lastHeartbeat > this.config.taskTimeoutMs * 2) {
        console.error(`[PythonPool] Worker ${id} appears hung, killing`);
        worker.process.kill('SIGKILL');
      }
    }
  }
}
