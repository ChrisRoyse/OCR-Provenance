/**
 * Manual test script for Gemini API integration
 * Run with: node scripts/test-gemini.mjs
 */

import { config } from 'dotenv';
import { GeminiClient } from '../dist/services/gemini/index.js';

// Load .env
config();

async function main() {
  console.log('=== Gemini API Integration Test ===\n');

  // Check API key
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  console.log('API Key loaded:', process.env.GEMINI_API_KEY.slice(0, 15) + '...');

  const client = new GeminiClient();
  console.log('\nClient Status:', JSON.stringify(client.getStatus(), null, 2));

  // Test 1: Fast mode (simple text)
  console.log('\n--- Test 1: Fast Mode ---');
  try {
    const response = await client.fast(
      'Return a JSON object: {"message": "Hello from Gemini", "status": "working"}'
    );
    console.log('Response:', response.text);
    console.log('Tokens:', response.usage);
    console.log('Time:', response.processingTimeMs, 'ms');
    console.log('✓ Fast mode test passed');
  } catch (error) {
    console.error('✗ Fast mode test failed:', error.message);
    process.exit(1);
  }

  // Test 2: Thinking mode (if using Flash 3)
  console.log('\n--- Test 2: Thinking Mode ---');
  try {
    const response = await client.thinking(
      'What is 123 + 456? Return JSON: {"answer": number}',
      'MINIMAL' // Use minimal for speed
    );
    console.log('Response:', response.text);
    console.log('Tokens:', response.usage);
    console.log('Time:', response.processingTimeMs, 'ms');
    console.log('✓ Thinking mode test passed');
  } catch (error) {
    console.error('✗ Thinking mode test failed:', error.message);
    // Don't exit - thinking might not be available on all models
  }

  // Final status
  console.log('\n--- Final Status ---');
  console.log(JSON.stringify(client.getStatus(), null, 2));
  console.log('\n✅ All tests completed!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
