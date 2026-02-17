# OCR Provenance MCP Server

A comprehensive [Model Context Protocol](https://modelcontextprotocol.io/) server for document OCR processing, semantic search, VLM image analysis, document clustering, document comparison, and full provenance tracking.

Built with TypeScript and Python, backed by SQLite with vector search extensions. Designed for use with Claude Desktop, Claude Code, and any MCP-compatible client.

[![License: Dual](https://img.shields.io/badge/License-Free_Non--Commercial-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple)](https://modelcontextprotocol.io/)

---

## What It Does

Drop documents into the system and get back a fully searchable, provenance-tracked document intelligence platform:

```
Documents (PDF, DOCX, images, Office files)
    -> OCR text extraction (Datalab API)
    -> Text chunking + GPU embeddings (nomic-embed-text-v1.5)
    -> Image extraction + VLM analysis (Gemini 3 Flash)
    -> Hybrid search (BM25 + vector + Gemini re-ranking)
    -> Document clustering + comparison
    -> RAG context assembly
```

Every piece of data carries a SHA-256 provenance chain from source document through every derived artifact.

## Key Features

- **69 MCP Tools** across 16 categories for end-to-end document intelligence
- **Hybrid Search** combining BM25 keyword, semantic vector, and Gemini-powered re-ranking via Reciprocal Rank Fusion
- **Full Provenance** with SHA-256 content hashes and W3C PROV export at every processing step
- **GPU Embeddings** via local nomic-embed-text-v1.5 (768-dim, auto-detects CUDA / MPS / CPU)
- **VLM Image Analysis** using Gemini 3 Flash for image descriptions, classification, and PDF analysis
- **Document Clustering** via HDBSCAN, agglomerative, or k-means with cosine similarity
- **Document Comparison** with text diff and structural metadata comparison
- **Form Filling** via Datalab API for PDF and image forms
- **Structured Extraction** using JSON schemas for structured data from OCR results
- **Cloud File Management** with Datalab cloud storage, deduplication by SHA-256 hash
- **Cross-Platform** support for Linux (CUDA), macOS (MPS / CPU), and Windows

---

## Architecture

```
                    +-----------------------+
                    |   MCP Client (Claude) |
                    +-----------+-----------+
                                | JSON-RPC over stdio
                    +-----------v-----------+
                    |   MCP Server (Node)   |
                    |   69 registered tools |
                    +-----------+-----------+
                       |        |        |
          +------------+   +----+----+   +----------+
          |                |         |              |
+---------v---+   +-------v--+  +---v--------+  +-v----------+
|   SQLite    |   |  Python  |  |   Gemini   |  |  Datalab   |
| + sqlite-vec|   |  Workers |  |    API     |  |    API     |
+-------------+   +----------+  +------------+  +------------+
| 15 tables   |   | 8 workers|  | VLM vision |  | OCR        |
| FTS5 search |   | GPU embed|  | re-ranking |  | form fill  |
| vec search  |   | clustering  | PDF analyze|  | file mgmt  |
+-------------+   | img extract +------------+  +------------+
                  +----------+
```

**Components:**
- **TypeScript MCP Server** -- 69 tools across 16 tool files, Zod schema validation, provenance tracking
- **Python Workers** (8) -- OCR, embedding (GPU), image extraction (PDF + DOCX), clustering, form fill, file management
- **SQLite + sqlite-vec** -- 15 core tables + FTS5 virtual tables + vector index, WAL mode
- **Gemini API** (gemini-3-flash-preview) -- VLM image descriptions, search re-ranking, query expansion, PDF analysis
- **Datalab API** -- Document OCR, form filling, cloud file storage
- **nomic-embed-text-v1.5** -- 768-dim embeddings, local inference only (CUDA, MPS, or CPU)

---

## Requirements

| Component | Version | Purpose |
|-----------|---------|---------|
| Node.js | >= 20.0.0 | MCP server runtime |
| Python | >= 3.10 | Worker processes |
| PyTorch | >= 2.0 | Embedding model |
| NVIDIA GPU | CUDA-capable (optional) | Fastest embedding generation |
| Apple Silicon | MPS (optional) | GPU acceleration on macOS |

> **No GPU?** The system auto-detects the best available device (CUDA > MPS > CPU). A GPU is recommended for performance but not required.

### API Keys

| Key | Required For | Get From |
|-----|-------------|----------|
| `DATALAB_API_KEY` | OCR processing, form fill, file upload | [datalab.to](https://www.datalab.to) |
| `GEMINI_API_KEY` | VLM image analysis, search re-ranking, query expansion | [Google AI Studio](https://aistudio.google.com/) |

---

## Installation

### Quick Install (Global MCP Server)

Install once and use from any project, targeting any directory on your system:

```bash
# 1. Clone, install, and build
git clone https://github.com/ChrisRoyse/OCR-Provenance.git
cd OCR-Provenance
npm install
npm run build

# 2. Install globally
npm link

# 3. Install Python dependencies
pip install torch transformers sentence-transformers numpy scikit-learn hdbscan pymupdf pillow python-docx requests

# 4. Download the embedding model (~270MB, one-time)
pip install huggingface_hub
huggingface-cli download nomic-ai/nomic-embed-text-v1.5 --local-dir models/nomic-embed-text-v1.5

# 5. Configure API keys
cp .env.example .env
# Edit .env with your DATALAB_API_KEY and GEMINI_API_KEY

# 6. Verify it works
ocr-provenance-mcp  # Should print "Tools registered: 69" on stderr
```

After install, the `ocr-provenance-mcp` command is available system-wide. You can point it at **any directory or file** on your machine for OCR processing.

### Step-by-Step Install

#### 1. Clone and Install Dependencies

```bash
git clone https://github.com/ChrisRoyse/OCR-Provenance.git
cd OCR-Provenance
npm install
```

#### 2. Install Python Dependencies

```bash
pip install torch transformers sentence-transformers numpy scikit-learn hdbscan pymupdf pillow python-docx requests
```

> **PyTorch GPU note:** If the above installs CPU-only PyTorch, install the CUDA version explicitly:
> ```bash
> pip install torch --index-url https://download.pytorch.org/whl/cu124
> ```

#### 3. Download the Embedding Model

The system uses [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (768-dim, ~270MB) for local GPU vector embeddings. Download it once:

```bash
# Option A: Using huggingface-cli (recommended)
pip install huggingface_hub
huggingface-cli download nomic-ai/nomic-embed-text-v1.5 --local-dir models/nomic-embed-text-v1.5

# Option B: Using git lfs
git lfs install
git clone https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 models/nomic-embed-text-v1.5

# Option C: Using Python
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('nomic-ai/nomic-embed-text-v1.5', cache_folder='./models', trust_remote_code=True)"
```

Verify the model loaded correctly:
```bash
python -c "
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('./models/nomic-embed-text-v1.5', trust_remote_code=True)
result = model.encode(['search_query: hello world'])
print(f'Model loaded. Embedding dim: {len(result[0])}')  # Should print 768
"
```

> **Custom model location:** If you install globally and want the model elsewhere, set `EMBEDDING_MODEL_PATH` in your `.env`:
> ```bash
> EMBEDDING_MODEL_PATH=/path/to/nomic-embed-text-v1.5
> ```
> The server checks: `EMBEDDING_MODEL_PATH` env var -> `models/` in the package directory -> `~/.ocr-provenance/models/`

#### 4. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys (see Configuration below)
```

#### 5. Build and Install

```bash
# Build TypeScript
npm run build

# Install globally (makes `ocr-provenance-mcp` command available everywhere)
npm link
```

### Platform-Specific Notes

<details>
<summary><strong>Linux / WSL2</strong></summary>

Standard setup. Ensure NVIDIA drivers and CUDA toolkit are installed:
```bash
nvidia-smi                    # Verify GPU is visible
python -c "import torch; print(torch.cuda.is_available())"  # Should print True
```

For WSL2, install the [NVIDIA CUDA on WSL driver](https://developer.nvidia.com/cuda/wsl) from the Windows side. Inside WSL:
```bash
# The CUDA toolkit inside WSL is handled by the Windows driver
nvidia-smi  # Should show your GPU
```
</details>

<details>
<summary><strong>macOS (Apple Silicon)</strong></summary>

Apple Silicon Macs use MPS (Metal Performance Shaders) automatically when `EMBEDDING_DEVICE=auto`:
```bash
# No changes needed - auto-detection selects MPS
EMBEDDING_DEVICE=auto
```

Install PyTorch with MPS support:
```bash
pip install torch torchvision torchaudio
```

Verify:
```bash
python -c "import torch; print(torch.backends.mps.is_available())"  # Should print True
```

> **Note:** MPS is slower than CUDA but works for moderate document sets. For large-scale processing, a CUDA GPU is recommended.
</details>

<details>
<summary><strong>Windows (Native)</strong></summary>

1. Install Python via the [official installer](https://www.python.org/downloads/) or conda
2. The server auto-detects `python` (Windows) vs `python3` (Linux/macOS)
3. For GPU support, install [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-downloads) and:
   ```powershell
   pip install torch --index-url https://download.pytorch.org/whl/cu124
   ```
4. Without a GPU, `EMBEDDING_DEVICE=auto` will select CPU automatically
5. Use PowerShell or Git Bash for all commands

> **Recommended:** Use WSL2 instead of native Windows for better compatibility. See the Linux/WSL2 section above.
</details>

---

## Configuration

Copy `.env.example` to `.env` and set your values:

```bash
# Required API keys
DATALAB_API_KEY=your_datalab_key
GEMINI_API_KEY=your_gemini_key

# Datalab settings
DATALAB_BASE_URL=https://www.datalab.to/api/v1
DATALAB_DEFAULT_MODE=accurate          # fast | balanced | accurate
DATALAB_MAX_CONCURRENT=3
DATALAB_TIMEOUT=330000                 # 5.5 minutes (aligns with Python 300s + 30s buffer)

# Embedding model (auto-detects CUDA > MPS > CPU)
EMBEDDING_MODEL=./models/nomic-embed-text-v1.5
EMBEDDING_DIMENSIONS=768
EMBEDDING_BATCH_SIZE=512
EMBEDDING_DEVICE=auto                    # auto | cuda | cuda:0 | mps | cpu

# GPU settings
GPU_DEVICE=auto                           # auto | cuda:0 | mps | cpu
GPU_DTYPE=float16
GPU_MEMORY_FRACTION=0.9
FORCE_GPU=false

# Chunking
CHUNKING_SIZE=2000                     # Characters per chunk
CHUNKING_OVERLAP_PERCENT=10            # 0-50

# Storage
STORAGE_DATABASES_PATH=~/.ocr-provenance/databases/

# Provenance
PROVENANCE_HASH_ALGORITHM=sha256
```

---

## Connecting to an MCP Client

### Claude Code (Recommended)

After [global install](#quick-install-global-mcp-server), register as a **user-level** MCP server so it's available in every project:

```bash
# Register globally (available in all projects)
claude mcp add ocr-provenance -s user \
  -e OCR_PROVENANCE_ENV_FILE=/path/to/OCR-Provenance/.env \
  -e NODE_OPTIONS=--max-semi-space-size=64 \
  -- ocr-provenance-mcp
```

Replace `/path/to/OCR-Provenance/.env` with the absolute path to your `.env` file.

Or register for a single project only:

```bash
# Project-level only
claude mcp add ocr-provenance \
  -e OCR_PROVENANCE_ENV_FILE=/path/to/OCR-Provenance/.env \
  -- ocr-provenance-mcp
```

Restart your Claude Code session. All 69 tools will be available immediately.

### Claude Desktop

Add to your Claude Desktop config file:

| Platform | Config File Location |
|----------|---------------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

**Option A: Global command** (after `npm link`):
```json
{
  "mcpServers": {
    "ocr-provenance": {
      "command": "ocr-provenance-mcp",
      "env": {
        "OCR_PROVENANCE_ENV_FILE": "/absolute/path/to/OCR-Provenance/.env",
        "NODE_OPTIONS": "--max-semi-space-size=64"
      }
    }
  }
}
```

**Option B: Direct node invocation** (no global install needed):
```json
{
  "mcpServers": {
    "ocr-provenance": {
      "command": "node",
      "args": ["--max-semi-space-size=64", "/absolute/path/to/OCR-Provenance/dist/index.js"],
      "env": {
        "DATALAB_API_KEY": "your_key",
        "GEMINI_API_KEY": "your_key"
      }
    }
  }
}
```

Replace `/absolute/path/to/OCR-Provenance` with the full path to your cloned repo. On Windows, use forward slashes (e.g., `C:/Users/you/OCR-Provenance/dist/index.js`).

Restart Claude Desktop after saving.

### Any MCP-Compatible Client

The server uses stdio transport (JSON-RPC over stdin/stdout). Launch with:

```bash
ocr-provenance-mcp                    # Global command (after npm link)
node /path/to/dist/index.js           # Direct invocation
npx ocr-provenance-mcp                # Via npx (after npm publish)
```

**Environment variables** can be provided via:
1. `OCR_PROVENANCE_ENV_FILE` pointing to a `.env` file (recommended for global install)
2. Direct env vars (`DATALAB_API_KEY`, `GEMINI_API_KEY`, etc.)
3. A `.env` file in the current working directory
4. A `.env` file in the package root (development)

---

## Quick Start

```
1. Create a database         ->  ocr_db_create { name: "my-project" }
2. Select it                 ->  ocr_db_select { database_name: "my-project" }
3. Ingest documents          ->  ocr_ingest_directory { directory_path: "/path/to/docs" }
4. Process through pipeline  ->  ocr_process_pending {}
5. Search your documents     ->  ocr_search_hybrid { query: "your question" }
6. Build RAG context         ->  ocr_rag_context { question: "What happened on March 15?" }
7. Verify provenance         ->  ocr_provenance_verify { item_id: "doc-id" }
```

The processing pipeline runs: OCR -> Chunk -> Embed -> Vector Index -> FTS Index

For images in documents, use the VLM tools to generate searchable descriptions:

```
8. Extract images            ->  ocr_extract_images { document_id: "doc-id" }
9. Analyze with VLM          ->  ocr_vlm_process_document { document_id: "doc-id" }
```

---

## Tool Reference

### Overview (69 Tools)

| Category | Count | Tools |
|----------|-------|-------|
| [Database Management](#database-management) | 5 | create, list, select, stats, delete |
| [Ingestion & Processing](#ingestion--processing) | 8 | ingest_directory, ingest_files, process_pending, status, retry_failed, reprocess, chunk_complete, convert_raw |
| [Document Management](#document-management) | 3 | document_list, document_get, document_delete |
| [Search & Retrieval](#search--retrieval) | 7 | search (BM25), search_semantic, search_hybrid, fts_manage, search_export, benchmark_compare, rag_context |
| [Document Comparison](#document-comparison) | 3 | document_compare, comparison_list, comparison_get |
| [Document Clustering](#document-clustering) | 5 | cluster_documents, cluster_list, cluster_get, cluster_assign, cluster_delete |
| [VLM / Vision Analysis](#vlm--vision-analysis) | 6 | vlm_describe, vlm_classify, vlm_process_document, vlm_process_pending, vlm_analyze_pdf, vlm_status |
| [Image Management](#image-management) | 8 | image_extract, image_list, image_get, image_stats, image_delete, image_delete_by_document, image_reset_failed, image_pending |
| [Image Extraction](#image-extraction) | 3 | extract_images, extract_images_batch, extraction_check |
| [Form Fill](#form-fill) | 2 | form_fill, form_fill_status |
| [Structured Extraction](#structured-extraction) | 2 | extract_structured, extraction_list |
| [File Management](#file-management) | 5 | file_upload, file_list, file_get, file_download, file_delete |
| [Evaluation](#evaluation) | 3 | evaluate_single, evaluate_document, evaluate_pending |
| [Reports & Analytics](#reports--analytics) | 4 | evaluation_report, document_report, quality_summary, cost_summary |
| [Provenance](#provenance) | 3 | provenance_get, provenance_verify, provenance_export |
| [Configuration](#configuration) | 2 | config_get, config_set |

All tools are prefixed with `ocr_`. For example: `ocr_db_create`, `ocr_search_hybrid`, `ocr_cluster_documents`.

---

### Database Management

| Tool | Description |
|------|-------------|
| `ocr_db_create` | Create a new isolated database |
| `ocr_db_list` | List all databases with optional stats |
| `ocr_db_select` | Select the active database for all operations |
| `ocr_db_stats` | Detailed statistics (documents, chunks, embeddings, images, clusters) |
| `ocr_db_delete` | Permanently delete a database |

### Ingestion & Processing

| Tool | Description |
|------|-------------|
| `ocr_ingest_directory` | Scan directory and register documents (PDF, DOCX, images, Office files) |
| `ocr_ingest_files` | Ingest specific files by path |
| `ocr_process_pending` | Full OCR pipeline: OCR -> Chunk -> Embed -> Vector Index |
| `ocr_status` | Check processing status for documents |
| `ocr_retry_failed` | Reset failed documents for reprocessing |
| `ocr_reprocess` | Reprocess a document with different OCR settings |
| `ocr_chunk_complete` | Repair documents missing chunks/embeddings |
| `ocr_convert_raw` | Convert via OCR without storing results |

**Supported file types (18):** PDF, PNG, JPG, JPEG, TIFF, TIF, BMP, GIF, WEBP, DOCX, DOC, PPTX, PPT, XLSX, XLS, TXT, CSV, MD

**Processing options:** `ocr_mode` (fast/balanced/accurate), `chunking_strategy` (fixed/page_aware), `page_range`, `max_pages`, `extras` (track_changes, chart_understanding, extract_links, table_row_bboxes, infographic, new_block_types)

### Search & Retrieval

| Tool | Best For | Method |
|------|----------|--------|
| `ocr_search` | Exact terms, codes, IDs, phrases | BM25 full-text (FTS5, porter stemming) |
| `ocr_search_semantic` | Conceptual queries, paraphrases | Vector similarity (nomic-embed-text-v1.5) |
| `ocr_search_hybrid` | General queries (recommended) | Reciprocal Rank Fusion (BM25 + semantic) |
| `ocr_rag_context` | LLM context assembly | Hybrid search assembled into markdown context block |
| `ocr_search_export` | Export results to file | CSV or JSON export |
| `ocr_benchmark_compare` | Cross-database comparison | Multi-database search benchmarking |
| `ocr_fts_manage` | Index maintenance | FTS5 rebuild/status |

**Search enhancement features** (available on all search modes):
- `rerank` -- Gemini-powered contextual re-ranking for improved relevance
- `cluster_id` -- Restrict results to a specific document cluster
- `min_quality_score` -- Filter by OCR quality score (0-5)
- `include_provenance` / `include_cluster_context` -- Enrich results with metadata
- `document_filter` -- Restrict to specific document IDs
- `metadata_filter` -- Filter by document title, author, or subject

### Document Comparison

| Tool | Description |
|------|-------------|
| `ocr_document_compare` | Compare two documents: text diff + structural metadata diff + similarity ratio |
| `ocr_comparison_list` | List comparisons with optional filtering by document ID |
| `ocr_comparison_get` | Get full comparison details with diff operations |

### Document Clustering

| Tool | Description |
|------|-------------|
| `ocr_cluster_documents` | Cluster by semantic similarity (HDBSCAN / agglomerative / k-means) |
| `ocr_cluster_list` | List clusters with optional filtering by run ID or tag |
| `ocr_cluster_get` | Detailed cluster info with member documents |
| `ocr_cluster_assign` | Auto-assign a document to the nearest existing cluster |
| `ocr_cluster_delete` | Delete a clustering run |

### VLM / Vision Analysis

| Tool | Description |
|------|-------------|
| `ocr_vlm_describe` | Describe an image using Gemini 3 Flash vision (supports thinking mode) |
| `ocr_vlm_classify` | Classify image type, complexity, and text density |
| `ocr_vlm_process_document` | Process all images in a document with VLM |
| `ocr_vlm_process_pending` | Process all pending images across all documents |
| `ocr_vlm_analyze_pdf` | Analyze a PDF directly with Gemini 3 Flash (max 20MB) |
| `ocr_vlm_status` | VLM service status (API config, rate limits, circuit breaker) |

### Image Management

| Tool | Description |
|------|-------------|
| `ocr_image_extract` | Extract images from a PDF document via Datalab OCR |
| `ocr_image_list` | List all images extracted from a document |
| `ocr_image_get` | Get detailed information about a specific image |
| `ocr_image_stats` | Image processing statistics |
| `ocr_image_delete` | Delete a specific image record |
| `ocr_image_delete_by_document` | Delete all images for a document |
| `ocr_image_reset_failed` | Reset failed images to pending status |
| `ocr_image_pending` | Get images pending VLM processing |

### Image Extraction

| Tool | Description |
|------|-------------|
| `ocr_extract_images` | Extract images from a document using local Python tools (PyMuPDF for PDF, zipfile for DOCX) |
| `ocr_extract_images_batch` | Extract images from all OCR-processed documents |
| `ocr_extraction_check` | Check if Python environment has required packages (PyMuPDF, Pillow) |

### Form Fill

| Tool | Description |
|------|-------------|
| `ocr_form_fill` | Fill PDF/image forms via Datalab API with field name-value mapping |
| `ocr_form_fill_status` | Get form fill operation status and results |

### Structured Extraction

| Tool | Description |
|------|-------------|
| `ocr_extract_structured` | Extract structured data from OCR'd documents using a JSON schema |
| `ocr_extraction_list` | List all structured extractions for a document |

### File Management

| Tool | Description |
|------|-------------|
| `ocr_file_upload` | Upload a file to Datalab cloud storage (deduplicates by SHA-256 hash) |
| `ocr_file_list` | List uploaded files with optional duplicate detection |
| `ocr_file_get` | Get metadata for a specific uploaded file |
| `ocr_file_download` | Get a download URL for an uploaded file |
| `ocr_file_delete` | Delete an uploaded file record |

### Evaluation

| Tool | Description |
|------|-------------|
| `ocr_evaluate_single` | Evaluate a single image with the universal VLM prompt |
| `ocr_evaluate_document` | Evaluate all pending images in a document |
| `ocr_evaluate_pending` | Evaluate all pending images across all documents |

### Reports & Analytics

| Tool | Description |
|------|-------------|
| `ocr_evaluation_report` | Comprehensive evaluation report with OCR and VLM metrics (markdown) |
| `ocr_document_report` | Detailed report for a single document (images, extractions, comparisons, clusters) |
| `ocr_quality_summary` | Quick quality summary across all documents and images |
| `ocr_cost_summary` | Cost analytics for OCR and form fill operations (by document, mode, month, or total) |

### Provenance

| Tool | Description |
|------|-------------|
| `ocr_provenance_get` | Get the complete provenance chain for any item |
| `ocr_provenance_verify` | Verify integrity through SHA-256 hash chain |
| `ocr_provenance_export` | Export provenance data (JSON, W3C PROV-JSON, CSV) |

### Configuration

| Tool | Description |
|------|-------------|
| `ocr_config_get` | Get current system configuration |
| `ocr_config_set` | Update a configuration setting at runtime |

---

## Data Model

Every piece of data is linked through a provenance chain with SHA-256 content hashes:

```
DOCUMENT (depth 0)
+-- OCR_RESULT (depth 1)
|   +-- CHUNK (depth 2)
|   |   +-- EMBEDDING (depth 3)
|   +-- IMAGE (depth 2)
|   |   +-- VLM_DESCRIPTION (depth 3)
|   |       +-- EMBEDDING (depth 4)
|   +-- EXTRACTION (depth 2)
+-- FORM_FILL (depth 0)
+-- COMPARISON (depth 2)
+-- CLUSTERING (depth 2)
```

**15 core tables** covering documents, OCR results, chunks, embeddings, images, extractions, comparisons, clusters, document-cluster assignments, form fills, uploaded files, provenance, database metadata, schema version, and FTS index metadata. Plus FTS5 virtual tables for full-text search and a sqlite-vec virtual table for vector similarity.

---

## Python Workers

Eight Python workers handle computationally intensive tasks:

| Worker | Purpose |
|--------|---------|
| `ocr_worker.py` | Datalab API OCR processing |
| `embedding_worker.py` | nomic-embed-text-v1.5 GPU inference (CUDA / MPS / CPU) |
| `image_extractor.py` | PyMuPDF PDF image extraction |
| `docx_image_extractor.py` | python-docx / zipfile DOCX image extraction |
| `image_optimizer.py` | Image relevance analysis and filtering |
| `form_fill_worker.py` | Datalab form fill API |
| `file_manager_worker.py` | Datalab cloud file operations |
| `clustering_worker.py` | scikit-learn clustering (HDBSCAN / agglomerative / k-means) |

All workers output JSON to stdout and log to stderr. They are invoked by the TypeScript server via `child_process.spawn`.

---

## Development

```bash
# Build
npm run build

# Run tests
npm test                  # Unit + integration tests (1505 tests across 79 files)
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
npm run test:gpu          # GPU-specific tests

# Lint
npm run lint              # TypeScript (ESLint)
npm run lint:py           # Python (ruff)
npm run lint:all          # Both + format check

# Format
npm run format            # Prettier

# Type check
npm run typecheck

# Full check (typecheck + lint + test)
npm run check
```

---

## Project Structure

```
src/
  index.ts                  # MCP server entry point (registers 69 tools)
  tools/                    # 16 tool files + shared.ts
  services/                 # OCR, embedding, storage, chunking, VLM, search, clustering, comparison, provenance, images, gemini
  models/                   # Zod schemas and TypeScript types (11 model files)
  utils/                    # Helpers (hash, validation)
  server/                   # Server state, types, errors
python/                     # 8 Python workers + GPU utils
tests/
  unit/                     # Unit tests
  integration/              # Integration tests
  fixtures/                 # Test fixtures and sample documents
```

---

## Troubleshooting

### sqlite-vec loading errors
```
Error: Cannot find module 'sqlite-vec'
```
Run `npm install` -- sqlite-vec uses a prebuilt binary that must match your platform and Node.js version.

### Python not found (Windows)
```
Error: spawn python3 ENOENT
```
On Windows, Python is typically `python` not `python3`. The server auto-detects the correct binary. Ensure Python is on your PATH: `python --version`.

### GPU not detected
```
Auto-detected device: cpu (no GPU available)
```
- **Linux**: Install CUDA toolkit and `pip install torch --index-url https://download.pytorch.org/whl/cu124`
- **macOS**: `pip install torch` (MPS is built-in for Apple Silicon)
- **Check**: `python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('MPS:', hasattr(torch.backends, 'mps') and torch.backends.mps.is_available())"`

### Embedding model not found
```
Model not found at .../models/nomic-embed-text-v1.5
```
Download the model (see [Installation step 3](#3-download-the-embedding-model)). Verify `config.json`, `model.safetensors`, and `tokenizer.json` are present.

### API key warnings at startup
```
DATALAB_API_KEY is not set. OCR processing will fail.
```
Copy `.env.example` to `.env` and fill in your API keys.

---

## License

This project uses a **dual-license** model:

- **Free for non-commercial use** -- personal projects, academic research, education, non-profits, evaluation, and contributions to this project are all permitted at no cost.
- **Commercial license required for revenue-generating use** -- if you use this software to make money (paid services, SaaS, internal tools at for-profit companies, etc.), you must obtain a commercial license from the copyright holder. Terms are negotiated case-by-case and may include revenue sharing or flat-rate arrangements.

See [LICENSE](LICENSE) for full details. For commercial licensing inquiries, contact Chris Royse at [chrisroyseai@gmail.com](mailto:chrisroyseai@gmail.com) or via [GitHub](https://github.com/ChrisRoyse).