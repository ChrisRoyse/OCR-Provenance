# Full Case Indexing Guide

## Overview

This document describes the complete process for indexing the `./fullcase/` directory using the OCR Provenance MCP system. The system provides a fully automated pipeline for:

1. **Document Ingestion** - Scanning and registering files
2. **OCR Processing** - Extracting text via Datalab API
3. **Chunking** - Splitting text into searchable segments
4. **Embedding Generation** - Creating vector embeddings via local GPU
5. **Image Extraction** - Extracting images from PDFs/DOCXs
6. **VLM Processing** - Generating image descriptions via Gemini

---

## Final Statistics

| Metric | Count |
|--------|-------|
| **Total Documents** | 731 |
| **Documents Complete** | 731 (100%) |
| **Documents Failed** | 0 |
| **Total Chunks** | 13,837 |
| **Total Embeddings** | 15,561+ |
| **Total Images** | 3,482 |
| **Images VLM Processed** | 1,662+ |
| **Images Skipped** | 312 (icons/banners filtered) |
| **Provenance Records** | 936+ |
| **Database Size** | ~260 MB |

---

## Process Steps

### Step 1: Create Database

```bash
# Via MCP tool
ocr_db_create(name="fullcase", description="Complete case documents")
```

Creates a new SQLite database with sqlite-vec extension for vector storage.

### Step 2: Ingest Documents

```bash
# Ingest entire directory recursively
ocr_ingest_directory(
  directory_path="/path/to/fullcase",
  recursive=true,
  auto_process=false
)
```

This scans the directory and registers all supported files:
- PDF, DOCX, DOC
- PNG, JPG, JPEG, TIFF, BMP, GIF, WEBP

Each file gets:
- Unique document ID (UUID)
- SHA-256 content hash
- File metadata (size, type, path)
- Initial provenance record (DOCUMENT, chain_depth=0)

### Step 3: OCR Processing

```bash
# Process pending documents
ocr_process_pending(max_concurrent=3, ocr_mode="balanced")
```

For each document:
1. Sends file to Datalab API for OCR
2. Receives markdown text + page count + images
3. Creates OCR_RESULT provenance (chain_depth=1)
4. Extracts images from PDF/DOCX if Datalab didn't return any
5. Chunks text into ~2000 character segments
6. Creates CHUNK provenance for each chunk (chain_depth=2)
7. Generates embeddings via local GPU (nomic-embed-text-v1.5)
8. Creates EMBEDDING provenance (chain_depth=3)
9. Stores vectors in sqlite-vec for similarity search

### Step 4: VLM Image Processing

```bash
# Process images with Gemini VLM
ocr_vlm_process_pending(limit=100)
```

For each extracted image:
1. **Quality Filter** - Skips images that won't provide useful content:
   - Icons (both dimensions < 100px)
   - Banners/separators (extreme aspect ratio > 7:1)
   - Too small (< 50px in any dimension)
2. Sends to Gemini API for analysis
3. Generates detailed 3+ paragraph description
4. Creates VLM_DESCRIPTION provenance
5. Generates embedding for description
6. Enables semantic search over image content

**Note**: Skipped images are marked as "failed" in statistics but this is intentional filtering, not errors.

---

## Bugs Fixed During Indexing

### Bug 1: CUDA OOM on Large Documents

**Problem**: Documents with 3000+ chunks caused "CUDA driver error: out of memory" even though GPU had plenty of VRAM.

**Root Cause**: The TypeScript embedding client passed ALL chunks to Python worker in a single call. For a 5000-chunk document, the Python process needed to:
- Parse 10MB JSON payload
- Hold all text in memory
- Generate and hold all 5000 embeddings
- Return 15MB JSON response

**Fix**: Modified `src/services/embedding/nomic.ts` to batch calls to Python worker at 500 chunks max per call:

```typescript
private static readonly MAX_CHUNKS_PER_CALL = 500;

async embedChunks(chunks: string[], batchSize: number): Promise<Float32Array[]> {
  if (chunks.length > NomicEmbeddingClient.MAX_CHUNKS_PER_CALL) {
    return this.embedChunksInBatches(chunks, batchSize);
  }
  return this.embedChunksSingle(chunks, batchSize);
}

private async embedChunksInBatches(chunks: string[], batchSize: number): Promise<Float32Array[]> {
  const allEmbeddings: Float32Array[] = [];
  const maxPerCall = NomicEmbeddingClient.MAX_CHUNKS_PER_CALL;

  for (let i = 0; i < chunks.length; i += maxPerCall) {
    const batch = chunks.slice(i, i + maxPerCall);
    const embeddings = await this.embedChunksSingle(batch, batchSize);
    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}
```

**Result**: Documents with 5000+ chunks now process successfully.

### Bug 2: Datalab Subscription Error Message

**Problem**: HTTP 403 errors showed generic "access denied" instead of helpful subscription renewal message.

**Root Cause**: Datalab SDK's error object doesn't include response body in `str(e)`, so the word "subscription" wasn't detected.

**Fix**: Modified `python/ocr_worker.py` to treat 403 as subscription issue:

```python
if "subscription" in message.lower() or "expired" in message.lower() or status_code == 403:
    detailed_msg = (
        f"Datalab API subscription inactive (HTTP {status_code}). {message} "
        "Action: Renew subscription at https://www.datalab.to/settings"
    )
```

---

## Architecture

### Provenance Chain

Every piece of data has a complete provenance chain:

```
DOCUMENT (depth 0)
    └── OCR_RESULT (depth 1)
            ├── CHUNK (depth 2)
            │       └── EMBEDDING (depth 3)
            └── IMAGE (depth 2)
                    └── VLM_DESCRIPTION (depth 3)
                            └── EMBEDDING (depth 4)
```

Each provenance record includes:
- SHA-256 content hash
- Processor name and version
- Processing parameters
- Timestamps
- Parent/child relationships

### Database Schema

**Core Tables**:
- `documents` - Source files with metadata
- `ocr_results` - Extracted text and page info
- `chunks` - Text segments for search
- `embeddings` - Vector representations
- `images` - Extracted images with VLM descriptions
- `provenance` - Complete audit trail

**Vector Table**:
- `embeddings_vec` - sqlite-vec virtual table for similarity search

---

## Search Capabilities

### Semantic Search

```bash
ocr_search_semantic(
  query="conflict of interest policy",
  limit=10,
  similarity_threshold=0.7,
  include_provenance=true
)
```

Returns chunks ranked by vector similarity with full provenance chain.

### Text Search

```bash
ocr_search_text(
  query="whistleblower",
  match_type="fuzzy",
  limit=10
)
```

Keyword-based search with exact, fuzzy, or regex matching.

### Hybrid Search

```bash
ocr_search_hybrid(
  query="travel expense reimbursement",
  semantic_weight=0.7,
  keyword_weight=0.3,
  limit=10
)
```

Combines semantic and keyword search for best results.

---

## Hardware Requirements

- **GPU**: NVIDIA RTX 5090 (or compatible CUDA GPU)
- **VRAM**: 8GB+ recommended (actual usage ~2.5GB for embeddings)
- **RAM**: 16GB+ for large documents
- **Storage**: 300MB+ per 1000 documents

---

## API Keys Required

1. **DATALAB_API_KEY** - For OCR processing (https://www.datalab.to)
2. **GEMINI_API_KEY** - For VLM image descriptions

Store in `.env` file:
```
DATALAB_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here
```

---

## Monitoring Progress

```bash
# Check overall status
ocr_db_stats(database_name="fullcase")

# Check document status
ocr_status(status_filter="pending")  # or "complete", "failed", "all"

# Check image processing
ocr_image_stats()

# Get quality summary
ocr_quality_summary()
```

---

## Troubleshooting

### "CUDA driver error: out of memory"
- Fixed in v1.1.0 with sub-batching
- If still occurring, reduce `MAX_CHUNKS_PER_CALL` in nomic.ts

### "Datalab API subscription inactive"
- Renew subscription at https://www.datalab.to/settings

### "Input width exceeds maximum width of 4800 pixels"
- Screenshot too wide for Datalab
- Resize image before ingestion

### "Database connection is not open"
- Multiple agents accessing same database
- Kill stale processes: `pkill -f "node dist/index"`

---

## Files Modified

| File | Change |
|------|--------|
| `src/services/embedding/nomic.ts` | Sub-batching for large documents |
| `python/ocr_worker.py` | Better subscription error messages |
| `src/services/storage/migrations/operations.ts` | FK migration fix |
| `src/tools/config.ts` | Config persistence fix |

---

## Version

- OCR Provenance MCP: 1.0.0
- Schema Version: 3
- Embedding Model: nomic-embed-text-v1.5
- VLM Model: gemini-3-flash-preview
