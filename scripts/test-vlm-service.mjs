#!/usr/bin/env node
/**
 * Test script for VLM Service
 *
 * Tests the Phase 3 VLM service implementation against real documents
 * from ./data/geminidata/
 *
 * Usage:
 *   node scripts/test-vlm-service.mjs
 *   node scripts/test-vlm-service.mjs --pdf-only
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data', 'geminidata');
const OUTPUT_DIR = path.join(ROOT_DIR, 'tmp', 'vlm-test-output');

// Dynamic imports for compiled code
async function loadModules() {
  const { VLMService } = await import('../dist/services/vlm/service.js');
  const { GeminiClient } = await import('../dist/services/gemini/client.js');
  return { VLMService, GeminiClient };
}

async function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

async function listTestFiles() {
  const files = fs.readdirSync(DATA_DIR);
  return files.filter(f =>
    f.endsWith('.pdf') ||
    f.endsWith('.png') ||
    f.endsWith('.jpg') ||
    f.endsWith('.jpeg')
  );
}

async function testDirectPDFAnalysis(GeminiClient) {
  console.log('\n=== Testing Direct PDF Analysis with Gemini ===\n');

  const results = [];
  const client = new GeminiClient();

  // Get PDF files
  const files = await listTestFiles();
  const pdfs = files.filter(f => f.endsWith('.pdf'));

  if (pdfs.length === 0) {
    console.log('No PDF files found in', DATA_DIR);
    return results;
  }

  // Test with a smaller PDF - Sinai is ~10MB
  const testPdf = pdfs.find(f => f.includes('Sinai')) || pdfs[0];
  const pdfPath = path.join(DATA_DIR, testPdf);
  const fileSize = fs.statSync(pdfPath).size;

  console.log(`Testing PDF: ${testPdf}`);
  console.log(`File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

  // Skip files over 20MB (Gemini limit)
  if (fileSize > 20 * 1024 * 1024) {
    console.log('⚠ File too large for Gemini (max 20MB). Skipping.');
    results.push({
      file: testPdf,
      success: false,
      error: 'File exceeds 20MB Gemini limit',
    });
    return results;
  }

  try {
    const fileRef = GeminiClient.fileRefFromPath(pdfPath);
    console.log(`Loaded PDF as base64 (${(fileRef.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);

    console.log('Sending to Gemini for analysis...');
    const start = Date.now();
    const response = await client.analyzePDF(
      `You are analyzing a legal/medical document. Describe what type of document this is.
       List any key information visible including:
       - Document type and purpose
       - Patient or case information (names, dates, identifiers)
       - Key sections or findings
       Respond in JSON format with fields: documentType, summary, keyDates, keyNames`,
      fileRef
    );

    const elapsed = Date.now() - start;

    console.log(`\n✓ Analysis completed in ${elapsed}ms`);
    console.log(`Model: ${response.model}`);
    console.log(`Tokens used: ${response.usage.totalTokens} (input: ${response.usage.inputTokens}, output: ${response.usage.outputTokens})`);
    console.log(`\nResponse:\n${'─'.repeat(50)}`);
    console.log(response.text.slice(0, 1000));
    if (response.text.length > 1000) {
      console.log(`\n... (${response.text.length - 1000} more characters)`);
    }

    results.push({
      file: testPdf,
      success: true,
      description: response.text.slice(0, 500),
      tokensUsed: response.usage.totalTokens,
      processingTimeMs: elapsed,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`\n✗ Failed: ${errorMsg}`);
    results.push({
      file: testPdf,
      success: false,
      error: errorMsg,
    });
  }

  return results;
}

async function testVLMServiceStatus(VLMService) {
  console.log('\n=== Testing VLM Service Status ===\n');

  const vlm = new VLMService();
  const status = vlm.getStatus();

  console.log('VLM Service Status:');
  console.log(`  Model: ${status.model}`);
  console.log(`  Tier: ${status.tier}`);
  console.log(`  Rate Limiter: ${JSON.stringify(status.rateLimiter)}`);
  console.log(`  Circuit Breaker: ${status.circuitBreaker.state}`);

  return status;
}

async function printSummary(results) {
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`\nTotal tests: ${results.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);

  if (successful.length > 0) {
    const totalTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);
    const avgTime = successful.reduce((sum, r) => sum + (r.processingTimeMs || 0), 0) / successful.length;
    console.log(`\nTotal tokens used: ${totalTokens}`);
    console.log(`Average processing time: ${avgTime.toFixed(0)}ms`);
  }

  if (failed.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failed) {
      console.log(`  - ${f.file}: ${f.error}`);
    }
  }

  // Save results to file
  await ensureOutputDir();
  const resultsPath = path.join(OUTPUT_DIR, 'test-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsPath}`);
}

async function main() {
  console.log('VLM Service Test Suite');
  console.log('='.repeat(60));
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);

  // Check if data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`\n✗ Data directory not found: ${DATA_DIR}`);
    process.exit(1);
  }

  // Check for GEMINI_API_KEY
  if (!process.env.GEMINI_API_KEY) {
    console.error('\n✗ GEMINI_API_KEY not set. Please set it in .env file.');
    console.log('   Run: export GEMINI_API_KEY=your_key_here');
    process.exit(1);
  }

  console.log(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY.slice(0, 10)}...`);

  try {
    // Load compiled modules
    console.log('\nLoading compiled modules...');
    const { VLMService, GeminiClient } = await loadModules();
    console.log('✓ Modules loaded successfully');

    const allResults = [];

    // Test VLM Service status
    await testVLMServiceStatus(VLMService);

    // Test PDF analysis
    const pdfResults = await testDirectPDFAnalysis(GeminiClient);
    allResults.push(...pdfResults);

    await printSummary(allResults);
  } catch (error) {
    console.error('\n✗ Test suite failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
