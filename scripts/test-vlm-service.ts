#!/usr/bin/env npx ts-node
/**
 * Test script for VLM Service
 *
 * Tests the Phase 3 VLM service implementation against real documents
 * from ./data/geminidata/
 *
 * Usage:
 *   npx ts-node scripts/test-vlm-service.ts
 *   npx ts-node scripts/test-vlm-service.ts --pdf-only
 *   npx ts-node scripts/test-vlm-service.ts --extract-images
 */

import * as fs from 'fs';
import * as path from 'path';
import { VLMService, getVLMService } from '../src/services/vlm/service.js';
import { GeminiClient } from '../src/services/gemini/client.js';
import { ImageExtractor } from '../src/services/images/extractor.js';

const DATA_DIR = path.join(process.cwd(), 'data', 'geminidata');
const OUTPUT_DIR = path.join(process.cwd(), 'tmp', 'vlm-test-output');

interface TestResult {
  file: string;
  success: boolean;
  description?: string;
  confidence?: number;
  tokensUsed?: number;
  processingTimeMs?: number;
  error?: string;
}

async function ensureOutputDir(): Promise<void> {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

async function listTestFiles(): Promise<string[]> {
  const files = fs.readdirSync(DATA_DIR);
  return files.filter(f =>
    f.endsWith('.pdf') ||
    f.endsWith('.png') ||
    f.endsWith('.jpg') ||
    f.endsWith('.jpeg')
  );
}

async function testDirectPDFAnalysis(): Promise<TestResult[]> {
  console.log('\n=== Testing Direct PDF Analysis with Gemini ===\n');

  const results: TestResult[] = [];
  const client = new GeminiClient();

  // Get first small PDF for testing
  const files = await listTestFiles();
  const pdfs = files.filter(f => f.endsWith('.pdf'));

  if (pdfs.length === 0) {
    console.log('No PDF files found in', DATA_DIR);
    return results;
  }

  // Test with the smallest PDF first
  const testPdf = pdfs.find(f => f.includes('Sinai')) || pdfs[0];
  const pdfPath = path.join(DATA_DIR, testPdf);

  console.log(`Testing PDF: ${testPdf}`);
  console.log(`File size: ${(fs.statSync(pdfPath).size / 1024 / 1024).toFixed(2)} MB`);

  try {
    const fileRef = GeminiClient.fileRefFromPath(pdfPath);
    console.log(`Loaded PDF as base64 (${(fileRef.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);

    const start = Date.now();
    const response = await client.analyzePDF(
      'Describe this legal/medical document. What type of document is it? List key information visible on the first few pages.',
      fileRef
    );

    const elapsed = Date.now() - start;

    console.log(`\n✓ Analysis completed in ${elapsed}ms`);
    console.log(`Tokens used: ${response.usage.totalTokens}`);
    console.log(`\nResponse (first 500 chars):\n${response.text.slice(0, 500)}...`);

    results.push({
      file: testPdf,
      success: true,
      description: response.text.slice(0, 200),
      tokensUsed: response.usage.totalTokens,
      processingTimeMs: elapsed,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`✗ Failed: ${errorMsg}`);
    results.push({
      file: testPdf,
      success: false,
      error: errorMsg,
    });
  }

  return results;
}

async function testImageExtraction(): Promise<string[]> {
  console.log('\n=== Testing Image Extraction from PDF ===\n');

  await ensureOutputDir();

  const extractor = new ImageExtractor();
  const files = await listTestFiles();
  const pdfs = files.filter(f => f.endsWith('.pdf'));

  if (pdfs.length === 0) {
    console.log('No PDF files found');
    return [];
  }

  // Use smaller PDF for testing
  const testPdf = pdfs.find(f => f.includes('Sinai')) || pdfs[0];
  const pdfPath = path.join(DATA_DIR, testPdf);
  const outputDir = path.join(OUTPUT_DIR, 'extracted-images');

  console.log(`Extracting images from: ${testPdf}`);

  try {
    const images = await extractor.extractFromPDF(pdfPath, outputDir, {
      minSize: 50,
      maxImages: 10,
    });

    console.log(`\n✓ Extracted ${images.length} images`);

    for (const img of images) {
      console.log(`  - Page ${img.page}, Index ${img.index}: ${img.width}x${img.height} ${img.format}`);
    }

    return images.map(img => img.path);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`✗ Extraction failed: ${errorMsg}`);
    return [];
  }
}

async function testVLMService(imagePaths: string[]): Promise<TestResult[]> {
  console.log('\n=== Testing VLM Service on Extracted Images ===\n');

  const results: TestResult[] = [];
  const vlm = getVLMService();

  for (const imagePath of imagePaths.slice(0, 3)) {
    const fileName = path.basename(imagePath);
    console.log(`\nAnalyzing: ${fileName}`);

    try {
      const start = Date.now();
      const result = await vlm.describeImage(imagePath, {
        useMedicalPrompt: true,
        highResolution: true,
      });
      const elapsed = Date.now() - start;

      console.log(`✓ Analysis completed in ${elapsed}ms`);
      console.log(`  Type: ${result.analysis.imageType}`);
      console.log(`  Confidence: ${result.analysis.confidence}`);
      console.log(`  Tokens: ${result.tokensUsed}`);
      console.log(`  Description (first 200 chars): ${result.description.slice(0, 200)}...`);

      results.push({
        file: fileName,
        success: true,
        description: result.description.slice(0, 200),
        confidence: result.analysis.confidence,
        tokensUsed: result.tokensUsed,
        processingTimeMs: elapsed,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`✗ Failed: ${errorMsg}`);
      results.push({
        file: fileName,
        success: false,
        error: errorMsg,
      });
    }
  }

  return results;
}

async function testClassification(imagePaths: string[]): Promise<void> {
  console.log('\n=== Testing Image Classification ===\n');

  const vlm = getVLMService();

  for (const imagePath of imagePaths.slice(0, 3)) {
    const fileName = path.basename(imagePath);
    console.log(`Classifying: ${fileName}`);

    try {
      const classification = await vlm.classifyImage(imagePath);
      console.log(`  Type: ${classification.type}`);
      console.log(`  Has text: ${classification.hasText}`);
      console.log(`  Text density: ${classification.textDensity}`);
      console.log(`  Complexity: ${classification.complexity}`);
      console.log(`  Confidence: ${classification.confidence}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Failed: ${errorMsg}`);
    }
  }
}

async function printSummary(results: TestResult[]): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`\nTotal tests: ${results.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);

  if (successful.length > 0) {
    const avgTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0) / successful.length;
    const avgTime = successful.reduce((sum, r) => sum + (r.processingTimeMs || 0), 0) / successful.length;
    console.log(`\nAverage tokens per analysis: ${avgTokens.toFixed(0)}`);
    console.log(`Average processing time: ${avgTime.toFixed(0)}ms`);
  }

  if (failed.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failed) {
      console.log(`  - ${f.file}: ${f.error}`);
    }
  }

  // Save results to file
  const resultsPath = path.join(OUTPUT_DIR, 'test-results.json');
  await ensureOutputDir();
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsPath}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pdfOnly = args.includes('--pdf-only');
  const extractOnly = args.includes('--extract-images');

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
    process.exit(1);
  }

  const allResults: TestResult[] = [];

  try {
    // Test 1: Direct PDF analysis
    if (!extractOnly) {
      const pdfResults = await testDirectPDFAnalysis();
      allResults.push(...pdfResults);
    }

    if (pdfOnly) {
      await printSummary(allResults);
      return;
    }

    // Test 2: Extract images from PDF
    const imagePaths = await testImageExtraction();

    if (imagePaths.length > 0) {
      // Test 3: VLM service on extracted images
      const vlmResults = await testVLMService(imagePaths);
      allResults.push(...vlmResults);

      // Test 4: Image classification
      await testClassification(imagePaths);
    }

    await printSummary(allResults);
  } catch (error) {
    console.error('\n✗ Test suite failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
