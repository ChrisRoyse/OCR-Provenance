import { defineConfig } from 'vitest/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Load .env file manually
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        process.env[key] = valueParts.join('=');
      }
    }
  }
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      'tests/manual/**',           // One-time verification tests (run with test:manual)
      'tests/unit/embedding/**',   // GPU embedding tests (run with test:gpu)
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts'],
    },
    globalTeardown: ['./tests/global-teardown.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
