#!/usr/bin/env node
/**
 * OCR Provenance MCP Server — Interactive Setup Wizard
 *
 * Usage:
 *   npm install -g ocr-provenance-mcp && ocr-provenance-mcp-setup
 *   -- or --
 *   npx -p ocr-provenance-mcp ocr-provenance-mcp-setup
 */

import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, spawn } from 'node:child_process';

// ─── Terminal formatting ─────────────────────────────────────────────────────

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

function printBanner(): void {
  console.log('');
  console.log(bold('  OCR Provenance MCP Server — Setup'));
  console.log(dim('  ─────────────────────────────────'));
  console.log('');
}

// ─── Input helpers ───────────────────────────────────────────────────────────

function readInput(prompt: string, mask: boolean): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    if (!process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (chunk: string) => {
        resolve(chunk.trim().split('\n')[0]);
      });
      process.stdin.resume();
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';

    const handler = (ch: string): void => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += ch;
        process.stdout.write(mask ? '*' : ch);
      }
    };

    process.stdin.on('data', handler);
  });
}

function readLine(prompt: string): Promise<string> {
  return readInput(prompt, false);
}

function readSecret(prompt: string): Promise<string> {
  return readInput(prompt, true);
}

// ─── API key validation ──────────────────────────────────────────────────────

function httpsRequest(
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });

    req.on('error', (err: Error) => reject(err));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out (15s)')); });

    if (body) req.write(body);
    req.end();
  });
}

async function validateDatalabKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await httpsRequest({
      hostname: 'www.datalab.to',
      path: '/api/v1/marker',
      method: 'POST',
      headers: {
        'X-Api-Key': key,
        'Content-Type': 'application/json',
      },
    }, '{}');

    // 401/403 = bad key. Any other status (400, 422, 405, 200) = key accepted
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: `Invalid API key (HTTP ${res.status})` };
    }
    return { valid: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Connection failed: ${msg}` };
  }
}

async function validateGeminiKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models?key=${encodeURIComponent(key)}`,
      method: 'GET',
    });

    if (res.status === 200) {
      return { valid: true };
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { valid: false, error: `Invalid API key (HTTP ${res.status})` };
    }
    return { valid: false, error: `Unexpected response (HTTP ${res.status})` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Connection failed: ${msg}` };
  }
}

// ─── System detection ────────────────────────────────────────────────────────

function hasDocker(): boolean {
  try {
    execSync('docker --version', { stdio: 'pipe' });
    // Also check if Docker daemon is running
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasClaude(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getConfigDir(): string {
  const dir = path.join(os.homedir(), '.ocr-provenance');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getEnvFilePath(): string {
  return path.join(getConfigDir(), '.env');
}

function loadExistingKeys(): { datalab?: string; gemini?: string } {
  const envPath = getEnvFilePath();
  if (!fs.existsSync(envPath)) return {};

  const content = fs.readFileSync(envPath, 'utf8');
  const keys: { datalab?: string; gemini?: string } = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    const val = rest.join('=');
    if (key === 'DATALAB_API_KEY' && val && !val.includes('your_')) keys.datalab = val;
    if (key === 'GEMINI_API_KEY' && val && !val.includes('your_')) keys.gemini = val;
  }

  return keys;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function saveEnvFile(datalabKey: string, geminiKey: string): void {
  const envPath = getEnvFilePath();
  const content = [
    '# OCR Provenance MCP Server - API Keys',
    `# Generated by ocr-provenance-mcp-setup on ${new Date().toISOString()}`,
    '',
    `DATALAB_API_KEY=${datalabKey}`,
    `GEMINI_API_KEY=${geminiKey}`,
    '',
  ].join('\n');

  fs.writeFileSync(envPath, content, { mode: 0o600 });
  console.log(`  ${green('Saved')} ${dim(envPath)} ${dim('(mode 0600)')}`);
}

function pullDockerImage(): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`  Pulling ${cyan('ghcr.io/chrisroyse/ocr-provenance:latest')} ...`);
    console.log(dim('  (this downloads ~6GB on first run — Node.js, Python, PyTorch, model)'));
    console.log('');

    const proc = spawn('docker', ['pull', 'ghcr.io/chrisroyse/ocr-provenance:latest'], {
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`\n  ${green('Image ready')}`);
        resolve(true);
      } else {
        console.error(`\n  ${red('Docker pull failed')} (exit code ${code})`);
        console.error(`  Make sure Docker Desktop is running and you have internet access.`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      console.error(`\n  ${red('Failed to run docker pull:')} ${err.message}`);
      resolve(false);
    });
  });
}

function registerClaudeCode(datalabKey: string, geminiKey: string, imageRef: string): boolean {
  const homePath = os.homedir();
  const hostMount = `${homePath}:/host:ro`;

  try {
    // Remove existing registration if present (idempotent)
    try { execSync('claude mcp remove ocr-provenance', { stdio: 'pipe' }); } catch { /* not registered yet */ }

    const args = [
      'mcp', 'add', 'ocr-provenance',
      '-s', 'user',
      '-e', `DATALAB_API_KEY=${datalabKey}`,
      '-e', `GEMINI_API_KEY=${geminiKey}`,
      '--',
      'docker', 'run', '-i', '--rm',
      '-v', hostMount,
      '-v', 'ocr-data:/data',
      imageRef,
    ];

    execSync(`claude ${args.join(' ')}`, { stdio: 'pipe' });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${red('Registration failed:')} ${msg}`);
    return false;
  }
}

interface ClientConfig {
  configPath: string;
  configKey: string;
}

const CLIENT_INFO: Record<string, ClientConfig> = {
  'claude-desktop-mac': {
    configPath: path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    configKey: 'mcpServers',
  },
  'claude-desktop-win': {
    configPath: path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json'),
    configKey: 'mcpServers',
  },
  'cursor': {
    configPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
    configKey: 'mcpServers',
  },
  'windsurf': {
    configPath: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    configKey: 'mcpServers',
  },
};

function generateJsonConfig(datalabKey: string, geminiKey: string, configKey: string, imageRef: string): object {
  const homePath = os.homedir();
  return {
    [configKey]: {
      'ocr-provenance': {
        command: 'docker',
        args: [
          'run', '-i', '--rm',
          '-e', 'DATALAB_API_KEY',
          '-e', 'GEMINI_API_KEY',
          '-v', `${homePath}:/host:ro`,
          '-v', 'ocr-data:/data',
          imageRef,
        ],
        env: {
          DATALAB_API_KEY: datalabKey,
          GEMINI_API_KEY: geminiKey,
        },
      },
    },
  };
}

function generateVsCodeConfig(imageRef: string): object {
  const homePath = os.homedir();
  return {
    inputs: [
      { id: 'datalab-key', type: 'promptString', description: 'Datalab API key', password: true },
      { id: 'gemini-key', type: 'promptString', description: 'Gemini API key', password: true },
    ],
    servers: {
      'ocr-provenance': {
        type: 'stdio',
        command: 'docker',
        args: [
          'run', '-i', '--rm',
          '-v', `${homePath}:/host:ro`,
          '-v', 'ocr-data:/data',
          '-e', 'DATALAB_API_KEY', '-e', 'GEMINI_API_KEY',
          imageRef,
        ],
        env: {
          DATALAB_API_KEY: '${input:datalab-key}',
          GEMINI_API_KEY: '${input:gemini-key}',
        },
      },
    },
  };
}

function verifyDocker(datalabKey: string, geminiKey: string, imageRef: string): Promise<boolean> {
  return new Promise((resolve) => {
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'setup-verify', version: '1.0' },
      },
    });

    const proc = spawn('docker', [
      'run', '-i', '--rm',
      '-e', `DATALAB_API_KEY=${datalabKey}`,
      '-e', `GEMINI_API_KEY=${geminiKey}`,
      '-v', 'ocr-data:/data',
      imageRef,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    const timeout = setTimeout(() => { proc.kill(); }, 20000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Got a response — kill the container
      if (stdout.includes('"result"')) {
        clearTimeout(timeout);
        proc.kill();
      }
    });

    proc.on('close', () => {
      clearTimeout(timeout);
      try {
        const firstLine = stdout.trim().split('\n')[0];
        const response = JSON.parse(firstLine);
        if (response.result?.serverInfo?.name === 'ocr-provenance-mcp') {
          const toolCount = response.result.capabilities?.tools ? 'tools available' : '';
          console.log(`  ${green('Connected')} — ${response.result.serverInfo.name} v${response.result.serverInfo.version} ${toolCount}`);
          resolve(true);
          return;
        }
      } catch { /* parse error */ }
      console.error(`  ${red('Verification failed')} — server did not respond correctly`);
      if (stdout) console.error(`  Response: ${stdout.slice(0, 200)}`);
      resolve(false);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`  ${red('Failed to start container:')} ${err.message}`);
      resolve(false);
    });

    proc.stdin.write(initMsg + '\n');
    proc.stdin.end();
  });
}

// ─── Main wizard ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  // ── Check for existing config ──────────────────────────────────────────
  const existing = loadExistingKeys();
  if (existing.datalab && existing.gemini) {
    console.log(`  ${dim('Existing API keys found at')} ${dim(getEnvFilePath())}`);
    const reuse = await readLine('  Keep existing keys? [Y/n] ');
    if (reuse.toLowerCase() !== 'n') {
      console.log(`  ${green('Using existing keys')}\n`);
    } else {
      existing.datalab = undefined;
      existing.gemini = undefined;
    }
  }

  // ── Step 1: API Keys ──────────────────────────────────────────────────
  console.log(bold('  Step 1: API Keys'));
  console.log('');

  let datalabKey = existing.datalab ?? '';
  if (!datalabKey) {
    console.log(dim('  Get your key at: https://www.datalab.to/account'));
    datalabKey = await readSecret('  Datalab API key: ');
    if (!datalabKey) {
      console.error(`  ${red('Error:')} Datalab API key is required.`);
      process.exit(1);
    }

    process.stdout.write('  Validating Datalab key... ');
    const datalabResult = await validateDatalabKey(datalabKey);
    if (!datalabResult.valid) {
      console.log(red('FAILED'));
      console.error(`  ${red('Error:')} ${datalabResult.error}`);
      console.error(`  Get a valid key at ${cyan('https://www.datalab.to/account')}`);
      process.exit(1);
    }
    console.log(green('valid'));
  }

  let geminiKey = existing.gemini ?? '';
  if (!geminiKey) {
    console.log('');
    console.log(dim('  Get your key at: https://aistudio.google.com/apikey'));
    geminiKey = await readSecret('  Gemini API key: ');
    if (!geminiKey) {
      console.error(`  ${red('Error:')} Gemini API key is required.`);
      process.exit(1);
    }

    process.stdout.write('  Validating Gemini key... ');
    const geminiResult = await validateGeminiKey(geminiKey);
    if (!geminiResult.valid) {
      console.log(red('FAILED'));
      console.error(`  ${red('Error:')} ${geminiResult.error}`);
      console.error(`  Get a valid key at ${cyan('https://aistudio.google.com/apikey')}`);
      process.exit(1);
    }
    console.log(green('valid'));
  }

  console.log('');

  // Save keys
  saveEnvFile(datalabKey, geminiKey);
  console.log('');

  // ── Step 2: Install Method ────────────────────────────────────────────
  console.log(bold('  Step 2: Installation'));
  console.log('');

  const dockerAvailable = hasDocker();
  if (!dockerAvailable) {
    console.error(`  ${red('Docker not found or not running.')}`);
    console.error(`  Install Docker Desktop: ${cyan('https://docker.com/products/docker-desktop')}`);
    console.error(`  Then re-run: ${bold('ocr-provenance-mcp-setup')}`);
    console.error('');
    console.error(dim('  Alternatively, install natively (requires Python 3.12+):'));
    console.error(dim('  See: https://github.com/ChrisRoyse/OCR-Provenance#installation'));
    process.exit(1);
  }

  console.log(`  ${green('Docker detected')}`);

  // Check if image is already available
  let imageReady = false;
  try {
    const output = execSync(
      'docker images ghcr.io/chrisroyse/ocr-provenance:latest --format "{{.Repository}}:{{.Tag}}"',
      { stdio: 'pipe' }
    ).toString().trim();
    imageReady = output.includes('ghcr.io/chrisroyse/ocr-provenance');
  } catch { /* not available */ }

  if (imageReady) {
    console.log(`  ${green('Docker image already available')}`);
  } else {
    // Also check local build
    try {
      const output = execSync(
        'docker images ocr-provenance-mcp:cpu --format "{{.Repository}}:{{.Tag}}"',
        { stdio: 'pipe' }
      ).toString().trim();
      if (output.includes('ocr-provenance-mcp:cpu')) {
        console.log(`  ${green('Local Docker image available')} ${dim('(ocr-provenance-mcp:cpu)')}`);
        imageReady = true;
      }
    } catch { /* not available */ }
  }

  if (!imageReady) {
    console.log('');
    const pulled = await pullDockerImage();
    if (!pulled) {
      process.exit(1);
    }
  }

  console.log('');

  // ── Step 3: Register with AI Client ───────────────────────────────────
  console.log(bold('  Step 3: Register with AI Client'));
  console.log('');
  console.log('  [1] Claude Code (CLI)');
  console.log('  [2] Claude Desktop');
  console.log('  [3] Cursor');
  console.log('  [4] VS Code / GitHub Copilot');
  console.log('  [5] Windsurf');
  console.log('  [6] Print config (manual setup)');
  console.log('');
  const clientChoice = await readLine('  Choose [1-6]: ');

  console.log('');

  let imageRef = 'ghcr.io/chrisroyse/ocr-provenance:latest';
  if (imageReady) {
    try {
      const ghcrOutput = execSync(
        'docker images ghcr.io/chrisroyse/ocr-provenance:latest --format "{{.Repository}}"',
        { stdio: 'pipe' }
      ).toString().trim();
      if (!ghcrOutput.includes('ghcr.io')) {
        imageRef = 'ocr-provenance-mcp:cpu';
      }
    } catch {
      imageRef = 'ocr-provenance-mcp:cpu';
    }
  }

  switch (clientChoice) {
    case '1': {
      if (!hasClaude()) {
        console.error(`  ${red('Claude Code CLI not found.')}`);
        console.error(`  Install: ${cyan('npm install -g @anthropic-ai/claude-code')}`);
        console.error(`  Then re-run this setup.`);
        process.exit(1);
      }
      process.stdout.write('  Registering with Claude Code... ');
      if (registerClaudeCode(datalabKey, geminiKey, imageRef)) {
        console.log(green('done'));
      } else {
        process.exit(1);
      }
      break;
    }
    case '2': {
      const isMac = process.platform === 'darwin';
      const info = isMac ? CLIENT_INFO['claude-desktop-mac'] : CLIENT_INFO['claude-desktop-win'];
      const config = generateJsonConfig(datalabKey, geminiKey, info.configKey, imageRef);
      console.log(`  Add to ${cyan(info.configPath)}:`);
      console.log('');
      console.log(JSON.stringify(config, null, 2));
      console.log('');
      break;
    }
    case '3': {
      const config = generateJsonConfig(datalabKey, geminiKey, 'mcpServers', imageRef);
      console.log(`  Add to ${cyan('~/.cursor/mcp.json')}:`);
      console.log('');
      console.log(JSON.stringify(config, null, 2));
      console.log('');
      break;
    }
    case '4': {
      const config = generateVsCodeConfig(imageRef);
      console.log(`  Add to ${cyan('.vscode/mcp.json')} in your workspace:`);
      console.log('');
      console.log(JSON.stringify(config, null, 2));
      console.log('');
      break;
    }
    case '5': {
      const config = generateJsonConfig(datalabKey, geminiKey, 'mcpServers', imageRef);
      console.log(`  Add to ${cyan('~/.codeium/windsurf/mcp_config.json')}:`);
      console.log('');
      console.log(JSON.stringify(config, null, 2));
      console.log('');
      break;
    }
    default: {
      console.log('  Docker command (stdio):');
      const home = os.homedir();
      console.log(cyan(`  docker run -i --rm \\
    -e DATALAB_API_KEY=${datalabKey} \\
    -e GEMINI_API_KEY=${geminiKey} \\
    -v ${home}:/host:ro \\
    -v ocr-data:/data \\
    ${imageRef}`));
      console.log('');
      break;
    }
  }

  // ── Step 4: Verify ────────────────────────────────────────────────────
  console.log(bold('  Step 4: Verification'));
  console.log('');
  process.stdout.write('  Starting server... ');

  const verified = await verifyDocker(datalabKey, geminiKey, imageRef);
  if (!verified) {
    console.error(`\n  ${red('Verification failed.')} The server did not respond.`);
    console.error(`  Try running manually: docker run -i --rm -e DATALAB_API_KEY=test -e GEMINI_API_KEY=test -v ocr-data:/data ${imageRef}`);
    process.exit(1);
  }

  // ── Done ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('  ─────────────────────────────────'));
  console.log(`  ${green('Setup complete!')}`);
  console.log('');
  console.log('  Try asking your AI assistant:');
  console.log(cyan('  "Ingest all PDFs in ~/Documents and search for contracts"'));
  console.log('');
  console.log(dim(`  Config: ${getEnvFilePath()}`));
  console.log(dim('  Docs:   https://github.com/ChrisRoyse/OCR-Provenance'));
  console.log('');
}

main().catch((err: Error) => {
  console.error(`\n${red('Error:')} ${err.message}`);
  process.exit(1);
});
