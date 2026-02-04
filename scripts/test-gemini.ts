#!/usr/bin/env npx ts-node
/**
 * Manual test script for Gemini API integration
 * Run with: npx ts-node scripts/test-gemini.ts
 */

import { GeminiClient } from '../src/services/gemini/index.js';

async function main() {
  console.log('=== Gemini API Integration Test ===\n');

  // Check API key
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY not set in environment');
    process.exit(1);
  }

  const client = new GeminiClient();
  console.log('Client Status:', JSON.stringify(client.getStatus(), null, 2));
  console.log('');

  // Test 1: Fast mode (simple text)
  console.log('--- Test 1: Fast Mode ---');
  try {
    const response = await client.fast(
      'Return a JSON object with a greeting. Format: {"message": "hello", "timestamp": "ISO date string"}'
    );
    console.log('Response:', response.text);
    console.log('Tokens:', response.usage);
    console.log('Time:', response.processingTimeMs, 'ms');
    console.log('✓ Fast mode test passed\n');
  } catch (error) {
    console.error('✗ Fast mode test failed:', error);
  }

  // Test 2: Thinking mode
  console.log('--- Test 2: Thinking Mode ---');
  try {
    const response = await client.thinking(
      'What is 15 * 17? Show your reasoning step by step, then provide the final answer as JSON: {"result": number, "steps": ["step1", "step2", ...]}'
    );
    console.log('Response:', response.text.slice(0, 500) + (response.text.length > 500 ? '...' : ''));
    console.log('Tokens:', response.usage);
    console.log('Thinking tokens:', response.usage.thinkingTokens);
    console.log('Time:', response.processingTimeMs, 'ms');
    console.log('✓ Thinking mode test passed\n');
  } catch (error) {
    console.error('✗ Thinking mode test failed:', error);
  }

  // Final status
  console.log('--- Final Status ---');
  console.log(JSON.stringify(client.getStatus(), null, 2));
}

main().catch(console.error);
