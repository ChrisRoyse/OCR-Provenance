#!/usr/bin/env npx ts-node
/**
 * Gemini VLM Evaluation Script
 *
 * End-to-end evaluation pipeline for testing OCR and VLM performance
 * on documents in ./data/geminidata/
 *
 * Usage:
 *   npx ts-node scripts/eval-geminidata.ts [command] [options]
 *
 * Commands:
 *   full          Run the complete evaluation pipeline
 *   setup         Create database and ingest files only
 *   ocr           Run OCR processing only
 *   extract       Extract images from PDFs only
 *   vlm           Run VLM evaluation only
 *   report        Generate evaluation report only
 *   status        Show current status
 *
 * @module scripts/eval-geminidata
 */

import { resolve } from 'path';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { computeHash } from '../src/utils/hash.js';

// Import services directly (not via MCP)
import { DatabaseService } from '../src/services/storage/database/index.js';
import { VectorService } from '../src/services/storage/vector.js';
import { OCRProcessor } from '../src/services/ocr/processor.js';
import { ImageExtractor } from '../src/services/images/extractor.js';
import { VLMPipeline, createVLMPipeline } from '../src/services/vlm/pipeline.js';
import { insertImageBatch, getImageStats, getPendingImages } from '../src/services/storage/database/image-operations.js';
import { v4 as uuidv4 } from 'uuid';
import { ProvenanceType } from '../src/models/provenance.js';
import type { CreateImageReference } from '../src/models/image.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  DATABASE_NAME: 'gemini-evaluation',
  DATA_DIR: resolve(process.cwd(), 'data', 'geminidata'),
  STORAGE_PATH: resolve(process.env.HOME || '/tmp', '.ocr-provenance', 'databases'),
  IMAGES_PATH: resolve(process.env.HOME || '/tmp', '.ocr-provenance', 'images'),
  REPORTS_PATH: resolve(process.cwd(), 'reports'),
  OCR_MODE: 'accurate' as const,
  IMAGE_MIN_SIZE: 100,
  IMAGE_MAX_PER_DOC: 300,
  VLM_BATCH_SIZE: 10,
  VLM_CONCURRENCY: 5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${level}] ${message}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdSetup(): Promise<void> {
  log('INFO', '=== SETUP: Creating database and ingesting files ===');

  // Check if data directory exists
  if (!existsSync(CONFIG.DATA_DIR)) {
    log('ERROR', `Data directory not found: ${CONFIG.DATA_DIR}`);
    process.exit(1);
  }

  // List files to ingest
  const files = readdirSync(CONFIG.DATA_DIR)
    .filter(f => /\.(pdf|docx?|xlsx?)$/i.test(f))
    .map(f => ({
      name: f,
      path: resolve(CONFIG.DATA_DIR, f),
      size: statSync(resolve(CONFIG.DATA_DIR, f)).size,
    }));

  log('INFO', `Found ${files.length} files to ingest:`);
  files.forEach(f => log('INFO', `  - ${f.name} (${formatBytes(f.size)})`));

  // Check if database exists
  const dbExists = DatabaseService.exists(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH);

  let db: DatabaseService;
  if (dbExists) {
    log('WARN', `Database '${CONFIG.DATABASE_NAME}' already exists, opening...`);
    db = DatabaseService.open(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH);
  } else {
    log('INFO', `Creating database '${CONFIG.DATABASE_NAME}'...`);
    db = DatabaseService.create(
      CONFIG.DATABASE_NAME,
      'Gemini VLM evaluation with ./data/geminidata/ files',
      CONFIG.STORAGE_PATH
    );
  }

  // Ingest files
  let ingested = 0;
  let skipped = 0;

  for (const file of files) {
    // Check if already ingested
    const existing = db.getDocumentByPath(file.path);
    if (existing) {
      log('INFO', `  Skipping (already exists): ${file.name}`);
      skipped++;
      continue;
    }

    // Create document record
    const documentId = uuidv4();
    const provenanceId = uuidv4();
    const now = new Date().toISOString();
    const ext = file.name.split('.').pop()?.toLowerCase() || 'unknown';

    // Create provenance
    db.insertProvenance({
      id: provenanceId,
      type: ProvenanceType.DOCUMENT,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: file.path,
      source_id: null,
      root_document_id: provenanceId,
      location: null,
      content_hash: `sha256:pending-${documentId}`,
      input_hash: null,
      file_hash: `sha256:pending-${documentId}`,
      processor: 'eval-setup',
      processor_version: '1.0.0',
      processing_params: { evaluation: true },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: '["DOCUMENT"]',
    });

    // Insert document
    db.insertDocument({
      id: documentId,
      file_path: file.path,
      file_name: file.name,
      file_hash: `sha256:pending-${documentId}`,
      file_size: file.size,
      file_type: ext,
      status: 'pending',
      page_count: null,
      provenance_id: provenanceId,
      error_message: null,
      modified_at: null,
      ocr_completed_at: null,
    });

    log('INFO', `  Ingested: ${file.name}`);
    ingested++;
  }

  const stats = db.getStats();
  log('INFO', `Setup complete: ${ingested} ingested, ${skipped} skipped`);
  log('INFO', `Database stats: ${stats.total_documents} documents`);

  db.close();
}

async function cmdOCR(): Promise<void> {
  log('INFO', '=== OCR: Processing pending documents ===');

  if (!DatabaseService.exists(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH)) {
    log('ERROR', `Database '${CONFIG.DATABASE_NAME}' not found. Run setup first.`);
    process.exit(1);
  }

  const db = DatabaseService.open(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH);
  const pending = db.listDocuments({ status: 'pending' });

  if (pending.length === 0) {
    log('INFO', 'No pending documents to process.');
    db.close();
    return;
  }

  log('INFO', `Processing ${pending.length} documents with OCR mode: ${CONFIG.OCR_MODE}`);

  const processor = new OCRProcessor(db, { defaultMode: CONFIG.OCR_MODE });
  let processed = 0;
  let failed = 0;

  for (const doc of pending) {
    log('INFO', `Processing: ${doc.file_name}...`);
    const start = Date.now();

    try {
      const result = await processor.processDocument(doc.id, CONFIG.OCR_MODE);

      if (result.success) {
        processed++;
        log('INFO', `  Success: ${result.pageCount} pages, ${result.textLength} chars in ${formatDuration(Date.now() - start)}`);
      } else {
        failed++;
        log('ERROR', `  Failed: ${result.error}`);
      }
    } catch (error) {
      failed++;
      log('ERROR', `  Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log('INFO', `OCR complete: ${processed} processed, ${failed} failed`);
  db.close();
}

async function cmdExtract(): Promise<void> {
  log('INFO', '=== EXTRACT: Extracting images from PDFs ===');

  if (!DatabaseService.exists(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH)) {
    log('ERROR', `Database '${CONFIG.DATABASE_NAME}' not found. Run setup first.`);
    process.exit(1);
  }

  const db = DatabaseService.open(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH);

  // Get completed PDF documents
  const docs = db.listDocuments({ status: 'complete' })
    .filter(d => d.file_type.toLowerCase() === 'pdf');

  if (docs.length === 0) {
    log('INFO', 'No completed PDF documents to extract images from.');
    db.close();
    return;
  }

  log('INFO', `Extracting images from ${docs.length} PDF documents`);

  const extractor = new ImageExtractor();
  let totalImages = 0;

  for (const doc of docs) {
    // Check if images already extracted
    const existingImages = getImageStats(db.getConnection());

    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    if (!ocrResult) {
      log('WARN', `  Skipping ${doc.file_name}: No OCR result`);
      continue;
    }

    log('INFO', `Extracting from: ${doc.file_name}...`);

    try {
      const outputDir = resolve(CONFIG.IMAGES_PATH, doc.id);
      const extracted = await extractor.extractFromPDF(doc.file_path, {
        outputDir,
        minSize: CONFIG.IMAGE_MIN_SIZE,
        maxImages: CONFIG.IMAGE_MAX_PER_DOC,
      });

      if (extracted.length === 0) {
        log('INFO', `  No images found (min size: ${CONFIG.IMAGE_MIN_SIZE}px)`);
        continue;
      }

      // Get OCR result provenance to build parent chain
      const ocrProv = db.getProvenance(ocrResult.provenance_id);
      if (!ocrProv) {
        log('WARN', `  Skipping ${doc.file_name}: OCR provenance not found`);
        continue;
      }

      // Store in database with IMAGE provenance records
      const imageRefs: CreateImageReference[] = [];

      for (const img of extracted) {
        const imageProvId = uuidv4();
        const now = new Date().toISOString();
        const imagePath = img.path;

        // Build parent_ids: document provenance + OCR provenance
        const parentIds = JSON.parse(ocrProv.parent_ids) as string[];
        parentIds.push(ocrResult.provenance_id);

        // Compute hash of the actual image file
        const imageContent = readFileSync(imagePath);
        const imageHash = computeHash(imageContent);

        // Create IMAGE provenance record (depth 2, parallel to CHUNK)
        db.insertProvenance({
          id: imageProvId,
          type: ProvenanceType.IMAGE,
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'IMAGE_EXTRACTION',
          source_path: imagePath,
          source_id: ocrResult.provenance_id,
          root_document_id: ocrProv.root_document_id,
          location: {
            page_number: img.page,
            bounding_box: {
              x: img.bbox.x,
              y: img.bbox.y,
              width: img.bbox.width,
              height: img.bbox.height,
              page: img.page,
            },
          },
          content_hash: imageHash,
          input_hash: ocrProv.content_hash,
          file_hash: doc.file_hash,
          processor: 'pymupdf-extractor',
          processor_version: '1.0.0',
          processing_params: { minSize: CONFIG.IMAGE_MIN_SIZE, maxImages: CONFIG.IMAGE_MAX_PER_DOC },
          processing_duration_ms: null,
          processing_quality_score: null,
          parent_id: ocrResult.provenance_id,
          parent_ids: JSON.stringify(parentIds),
          chain_depth: 2,
          chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE']),
        });

        // Create image reference with provenance_id
        imageRefs.push({
          document_id: doc.id,
          ocr_result_id: ocrResult.id,
          page_number: img.page,
          bounding_box: img.bbox,
          image_index: img.index,
          format: img.format,
          dimensions: { width: img.width, height: img.height },
          extracted_path: img.path,
          file_size: img.size,
          context_text: null,
          provenance_id: imageProvId,
        });
      }

      insertImageBatch(db.getConnection(), imageRefs);
      totalImages += extracted.length;

      log('INFO', `  Extracted ${extracted.length} images`);

    } catch (error) {
      log('ERROR', `  Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const finalStats = getImageStats(db.getConnection());
  log('INFO', `Extraction complete: ${totalImages} new images, ${finalStats.total} total in database`);

  db.close();
}

async function cmdVLM(): Promise<void> {
  log('INFO', '=== VLM: Running Gemini evaluation on images ===');

  if (!DatabaseService.exists(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH)) {
    log('ERROR', `Database '${CONFIG.DATABASE_NAME}' not found. Run setup first.`);
    process.exit(1);
  }

  const db = DatabaseService.open(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH);
  const vector = new VectorService(db.getConnection());

  const imageStats = getImageStats(db.getConnection());

  if (imageStats.pending === 0) {
    log('INFO', 'No pending images to evaluate.');
    log('INFO', `Stats: ${imageStats.processed} complete, ${imageStats.failed} failed`);
    db.close();
    return;
  }

  log('INFO', `Evaluating ${imageStats.pending} pending images`);
  log('INFO', `Batch size: ${CONFIG.VLM_BATCH_SIZE}, Concurrency: ${CONFIG.VLM_CONCURRENCY}`);

  const pipeline = createVLMPipeline(db, vector, {
    batchSize: CONFIG.VLM_BATCH_SIZE,
    concurrency: CONFIG.VLM_CONCURRENCY,
    minConfidence: 0.3,
    useMedicalPrompts: false, // Use universal prompt
    skipEmbeddings: false,
    skipProvenance: false,
  });

  const start = Date.now();
  const result = await pipeline.processPending(imageStats.pending);

  log('INFO', `VLM evaluation complete in ${formatDuration(Date.now() - start)}`);
  log('INFO', `  Processed: ${result.total}`);
  log('INFO', `  Successful: ${result.successful}`);
  log('INFO', `  Failed: ${result.failed}`);
  log('INFO', `  Tokens used: ${result.totalTokens}`);

  const finalStats = getImageStats(db.getConnection());
  log('INFO', `Final stats: ${finalStats.processed} complete, ${finalStats.pending} pending, ${finalStats.failed} failed`);

  db.close();
}

async function cmdReport(): Promise<void> {
  log('INFO', '=== REPORT: Generating evaluation report ===');

  if (!DatabaseService.exists(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH)) {
    log('ERROR', `Database '${CONFIG.DATABASE_NAME}' not found. Run setup first.`);
    process.exit(1);
  }

  const db = DatabaseService.open(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH);

  // Import report generator
  const { handleEvaluationReport } = await import('../src/tools/reports.js');

  // Mock the requireDatabase function
  const originalRequireDatabase = (await import('../src/server/state.js')).requireDatabase;

  // Generate report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = resolve(CONFIG.REPORTS_PATH, `gemini-eval-${timestamp}.md`);

  // Ensure reports directory exists
  if (!existsSync(CONFIG.REPORTS_PATH)) {
    const fs = await import('fs');
    fs.mkdirSync(CONFIG.REPORTS_PATH, { recursive: true });
  }

  log('INFO', `Generating report: ${outputPath}`);

  // We need to call the handler with the database context
  // For now, let's generate a simple report

  const stats = db.getStats();
  const imageStats = getImageStats(db.getConnection());
  const documents = db.listDocuments({ limit: 1000 });

  // Calculate confidence stats
  let totalConfidence = 0;
  let confidenceCount = 0;

  for (const doc of documents) {
    const images = (await import('../src/services/storage/database/image-operations.js'))
      .getImagesByDocument(db.getConnection(), doc.id);

    for (const img of images) {
      if (img.vlm_status === 'complete' && img.vlm_confidence !== null) {
        totalConfidence += img.vlm_confidence;
        confidenceCount++;
      }
    }
  }

  const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;

  // Generate report content
  const report = `# Gemini VLM Evaluation Report

Generated: ${new Date().toISOString()}
Database: ${CONFIG.DATABASE_NAME}

## Summary

| Metric | Value |
|--------|-------|
| Total Documents | ${stats.total_documents} |
| Documents Processed | ${stats.documents_by_status.complete} |
| Documents Failed | ${stats.documents_by_status.failed} |
| Total Images | ${imageStats.total} |
| VLM Processed | ${imageStats.processed} |
| VLM Pending | ${imageStats.pending} |
| VLM Failed | ${imageStats.failed} |
| **Average Confidence** | **${(avgConfidence * 100).toFixed(1)}%** |

## Processing Rate

- OCR: ${((stats.documents_by_status.complete / stats.total_documents) * 100).toFixed(1)}% complete
- VLM: ${imageStats.total > 0 ? ((imageStats.processed / imageStats.total) * 100).toFixed(1) : 0}% complete

## Documents

| File | Status | Pages | Images |
|------|--------|-------|--------|
${documents.slice(0, 20).map(d => {
  const images = (require('../src/services/storage/database/image-operations.js') as typeof import('../src/services/storage/database/image-operations.js'))
    .getImagesByDocument(db.getConnection(), d.id);
  return `| ${d.file_name.slice(0, 50)} | ${d.status} | ${d.page_count || 'N/A'} | ${images.length} |`;
}).join('\n')}

---
*Report generated by OCR Provenance MCP System*
`;

  // Write report
  const fs = await import('fs');
  fs.writeFileSync(outputPath, report);

  log('INFO', `Report saved to: ${outputPath}`);
  log('INFO', `Summary: ${stats.total_documents} docs, ${imageStats.total} images, ${(avgConfidence * 100).toFixed(1)}% avg confidence`);

  db.close();
}

async function cmdStatus(): Promise<void> {
  log('INFO', '=== STATUS: Current evaluation state ===');

  if (!DatabaseService.exists(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH)) {
    log('INFO', `Database '${CONFIG.DATABASE_NAME}' does not exist.`);
    log('INFO', 'Run: npx ts-node scripts/eval-geminidata.ts setup');
    return;
  }

  const db = DatabaseService.open(CONFIG.DATABASE_NAME, CONFIG.STORAGE_PATH);

  const stats = db.getStats();
  const imageStats = getImageStats(db.getConnection());

  console.error('');
  console.error('Database:', CONFIG.DATABASE_NAME);
  console.error('');
  console.error('Documents:');
  console.error(`  Total:      ${stats.total_documents}`);
  console.error(`  Pending:    ${stats.documents_by_status.pending}`);
  console.error(`  Processing: ${stats.documents_by_status.processing}`);
  console.error(`  Complete:   ${stats.documents_by_status.complete}`);
  console.error(`  Failed:     ${stats.documents_by_status.failed}`);
  console.error('');
  console.error('Images:');
  console.error(`  Total:    ${imageStats.total}`);
  console.error(`  Pending:  ${imageStats.pending}`);
  console.error(`  Complete: ${imageStats.processed}`);
  console.error(`  Failed:   ${imageStats.failed}`);
  console.error('');
  console.error('Next steps:');

  if (stats.documents_by_status.pending > 0) {
    console.error('  - Run OCR: npx ts-node scripts/eval-geminidata.ts ocr');
  } else if (imageStats.total === 0 && stats.documents_by_status.complete > 0) {
    console.error('  - Extract images: npx ts-node scripts/eval-geminidata.ts extract');
  } else if (imageStats.pending > 0) {
    console.error('  - Run VLM: npx ts-node scripts/eval-geminidata.ts vlm');
  } else if (imageStats.processed > 0) {
    console.error('  - Generate report: npx ts-node scripts/eval-geminidata.ts report');
  } else {
    console.error('  - All done! Run: npx ts-node scripts/eval-geminidata.ts report');
  }

  db.close();
}

async function cmdFull(): Promise<void> {
  log('INFO', '=== FULL EVALUATION PIPELINE ===');
  log('INFO', `Data directory: ${CONFIG.DATA_DIR}`);
  log('INFO', `Database: ${CONFIG.DATABASE_NAME}`);
  console.error('');

  const startTime = Date.now();

  // Step 1: Setup
  await cmdSetup();
  console.error('');

  // Step 2: OCR
  await cmdOCR();
  console.error('');

  // Step 3: Extract images
  await cmdExtract();
  console.error('');

  // Step 4: VLM evaluation
  await cmdVLM();
  console.error('');

  // Step 5: Generate report
  await cmdReport();
  console.error('');

  log('INFO', `=== FULL PIPELINE COMPLETE in ${formatDuration(Date.now() - startTime)} ===`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const command = process.argv[2] || 'status';

  const commands: Record<string, () => Promise<void>> = {
    full: cmdFull,
    setup: cmdSetup,
    ocr: cmdOCR,
    extract: cmdExtract,
    vlm: cmdVLM,
    report: cmdReport,
    status: cmdStatus,
  };

  if (!commands[command]) {
    console.error('Usage: npx ts-node scripts/eval-geminidata.ts [command]');
    console.error('');
    console.error('Commands:');
    console.error('  full      Run the complete evaluation pipeline');
    console.error('  setup     Create database and ingest files');
    console.error('  ocr       Run OCR processing');
    console.error('  extract   Extract images from PDFs');
    console.error('  vlm       Run VLM evaluation');
    console.error('  report    Generate evaluation report');
    console.error('  status    Show current status');
    process.exit(1);
  }

  try {
    await commands[command]();
  } catch (error) {
    log('ERROR', `Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
