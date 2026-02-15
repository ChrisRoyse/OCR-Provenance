#!/usr/bin/env npx tsx
/**
 * VLM Process Pending Images
 *
 * Processes pending images with automatic relevance filtering.
 * Skips logos, icons, and decorative elements to save API tokens.
 *
 * Usage:
 *   npx tsx scripts/vlm-process-pending.ts --db mydb --limit 100
 *   npx tsx scripts/vlm-process-pending.ts --db mydb --dry-run
 */

import dotenv from 'dotenv';
dotenv.config();

import { DatabaseService } from '../src/services/storage/database/index.js';
import { VectorService } from '../src/services/storage/vector.js';
import { VLMPipeline, createVLMPipeline } from '../src/services/vlm/pipeline.js';
import { getPendingImages } from '../src/services/storage/database/image-operations.js';

// Parse CLI args
const args = process.argv.slice(2);
const dbName = args.find((_, i) => args[i - 1] === '--db') || process.env.OCR_DATABASE || 'default';
const limit = parseInt(args.find((_, i) => args[i - 1] === '--limit') || '50', 10);
const dryRun = args.includes('--dry-run');
const batchSize = parseInt(args.find((_, i) => args[i - 1] === '--batch') || '10', 10);

async function main() {
  console.log('='.repeat(60));
  console.log('VLM Pending Image Processor');
  console.log('='.repeat(60));
  console.log(`Database: ${dbName}`);
  console.log(`Limit: ${limit}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  // Open database
  const storagePath = process.env.OCR_STORAGE_PATH ||
    `${process.env.HOME}/.ocr-provenance/databases`;

  if (!DatabaseService.exists(dbName, storagePath)) {
    console.error(`Database not found: ${dbName}`);
    process.exit(1);
  }

  const dbService = DatabaseService.open(dbName, storagePath);
  const vectorService = new VectorService(dbService.getConnection());

  try {
    // Get pending images
    const pending = getPendingImages(dbService.getConnection(), limit);
    console.log(`Found ${pending.length} pending images`);

    // Analyze what would be filtered
    let worthProcessing = 0;
    let tooSmall = 0;
    let likelyIcon = 0;
    let extremeRatio = 0;

    for (const img of pending) {
      const w = img.dimensions?.width || 0;
      const h = img.dimensions?.height || 0;
      const maxDim = Math.max(w, h);
      const minDim = Math.min(w, h);
      const ratio = minDim > 0 ? maxDim / minDim : 999;

      if (maxDim < 50) {
        tooSmall++;
      } else if (maxDim < 100) {
        likelyIcon++;
      } else if (ratio > 6) {
        extremeRatio++;
      } else {
        worthProcessing++;
      }
    }

    console.log('');
    console.log('Dimension Analysis (quick filter):');
    console.log(`  Worth processing: ${worthProcessing}`);
    console.log(`  Too small (<50px): ${tooSmall}`);
    console.log(`  Likely icons (<100px): ${likelyIcon}`);
    console.log(`  Extreme aspect ratio: ${extremeRatio}`);
    console.log('');
    console.log('Note: Full analysis with color diversity will filter more.');
    console.log('');

    if (dryRun) {
      console.log('DRY RUN - No images will be processed.');
      console.log('');
      console.log('Sample pending images:');
      for (const img of pending.slice(0, 5)) {
        const w = img.dimensions?.width || 0;
        const h = img.dimensions?.height || 0;
        console.log(`  ${img.id.slice(0, 8)}... ${w}x${h} ${img.extracted_path?.split('/').pop()}`);
      }
      return;
    }

    // Create pipeline with filtering enabled
    const pipeline = createVLMPipeline(dbService, vectorService, {
      batchSize,
      imageOptimization: {
        enabled: true,
        ocrMaxWidth: 4800,
        vlmMaxDimension: 2048,
        vlmSkipBelowSize: 50,
        vlmMinRelevance: 0.3,
        vlmSkipLogosIcons: true,
      },
    });

    console.log('Starting VLM processing...');
    console.log('');

    const startTime = Date.now();
    const result = await pipeline.processPending(limit);

    const elapsed = (Date.now() - startTime) / 1000;

    console.log('');
    console.log('='.repeat(60));
    console.log('Processing Complete');
    console.log('='.repeat(60));
    console.log(`Total processed: ${result.total}`);
    console.log(`Successful: ${result.successful}`);
    console.log(`Skipped (filtered): ${result.skipped}`);
    console.log(`Failed: ${result.failed}`);
    console.log(`Total tokens used: ${result.totalTokens}`);
    console.log(`Time: ${elapsed.toFixed(1)}s`);
    console.log('');

    if (result.failed > 0) {
      console.log('Failed images:');
      for (const r of result.results.filter(r => !r.success && !r.error?.startsWith('Skipped:'))) {
        console.log(`  ${r.imageId.slice(0, 8)}... - ${r.error}`);
      }
    }

  } finally {
    dbService.close();
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
