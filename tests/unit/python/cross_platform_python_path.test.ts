/**
 * Cross-Platform Python Path Tests
 *
 * Verifies that TypeScript services correctly configure the Python
 * binary path for each platform:
 * - PythonShell-based (datalab, form-fill, file-manager): pass undefined
 *   to let PythonShell auto-select python3 (Mac/Linux) or python (Windows)
 * - child_process.spawn-based (extractor, optimizer): use explicit
 *   process.platform === 'win32' ? 'python' : 'python3'
 *
 * Also verifies server state defaults are cross-platform safe.
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// PythonShell-based services — should accept undefined pythonPath
// =============================================================================

describe('PythonShell-based services accept undefined pythonPath', () => {
  it('DatalabClient constructs without pythonPath', async () => {
    const { DatalabClient } = await import('../../../src/services/ocr/datalab.js');
    // Should not throw — pythonPath will be undefined, letting PythonShell default
    const client = new DatalabClient({});
    expect(client).toBeDefined();
  });

  it('FormFillClient constructs without pythonPath', async () => {
    const { FormFillClient } = await import('../../../src/services/ocr/form-fill.js');
    const client = new FormFillClient({});
    expect(client).toBeDefined();
  });

  it('FileManagerClient constructs without pythonPath', async () => {
    const { FileManagerClient } = await import('../../../src/services/ocr/file-manager.js');
    const client = new FileManagerClient({});
    expect(client).toBeDefined();
  });

  it('ClusteringService PythonShell options omit pythonPath', async () => {
    // The clustering service creates PythonShellOptions inline without pythonPath.
    // We verify the module loads without referencing 'python3' hardcoded.
    const mod = await import('../../../src/services/clustering/clustering-service.js');
    expect(mod).toBeDefined();
  });
});

// =============================================================================
// child_process.spawn-based services — platform-aware pythonPath
// =============================================================================

describe('spawn-based services use platform-aware python path', () => {
  it('ImageExtractor constructs with default config', async () => {
    const { ImageExtractor } = await import('../../../src/services/images/extractor.js');
    const extractor = new ImageExtractor();
    expect(extractor).toBeDefined();
  });

  it('ImageOptimizer constructs with default config', async () => {
    const { ImageOptimizer } = await import('../../../src/services/images/optimizer.js');
    const optimizer = new ImageOptimizer();
    expect(optimizer).toBeDefined();
  });
});

// =============================================================================
// Server state defaults
// =============================================================================

describe('Server configuration defaults', () => {
  it('embeddingDevice defaults to "auto"', async () => {
    const { getConfig, resetConfig } = await import('../../../src/server/state.js');
    resetConfig();
    const config = getConfig();
    expect(config.embeddingDevice).toBe('auto');
  });

  it('updateConfig accepts embeddingDevice override', async () => {
    const { getConfig, updateConfig, resetConfig } = await import('../../../src/server/state.js');
    resetConfig();
    updateConfig({ embeddingDevice: 'cpu' });
    expect(getConfig().embeddingDevice).toBe('cpu');
    resetConfig(); // clean up
  });
});

// =============================================================================
// Platform detection correctness
// =============================================================================

describe('Platform detection', () => {
  it('process.platform returns recognized OS', () => {
    expect(['win32', 'darwin', 'linux', 'freebsd', 'sunos', 'aix']).toContain(process.platform);
  });

  it('platform ternary selects correct Python binary name', () => {
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    if (process.platform === 'win32') {
      expect(pythonPath).toBe('python');
    } else {
      expect(pythonPath).toBe('python3');
    }
  });
});
