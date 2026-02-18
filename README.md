# OCR Provenance MCP Server

**Turn thousands of documents into a searchable, AI-queryable knowledge base -- with full provenance.**

Point this at a folder of PDFs, Word docs, spreadsheets, images, or presentations. Minutes later, Claude can search, analyze, compare, and answer questions across your entire document collection.

[![License: Dual](https://img.shields.io/badge/License-Free_Non--Commercial-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple)](https://modelcontextprotocol.io/)

---

## Why This Exists

AI assistants can't read your files natively. They can't search across 500 PDFs, compare contract versions, or find the one email buried in a discovery dump. This server bridges that gap.

It's a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude (or any MCP client) the ability to **ingest, OCR, search, compare, cluster, and reason over** your documents -- with a cryptographic audit trail proving exactly where every answer came from.

### What Happens When You Ingest Documents

```
Your files (PDF, DOCX, XLSX, images, presentations...)
    -> OCR text extraction via Datalab API
    -> Text chunking + GPU vector embeddings
    -> Image extraction + AI vision analysis
    -> Full-text + semantic + hybrid search indexes
    -> Document clustering by similarity
    -> SHA-256 provenance chain on every artifact
```

**18 supported file types:** PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, PNG, JPG, JPEG, TIFF, TIF, BMP, GIF, WEBP, TXT, CSV, MD

---

## Real-World Use Cases

### Litigation & Legal Discovery

You have 3,000 documents from a civil case -- contracts, emails, depositions, medical records, invoices, and correspondence spanning 8 years. Normally this takes a team of paralegals weeks to organize.

```
"Search all documents for references to the March 2024 amendment"
"Compare the original contract with the signed version -- what changed?"
"Find every document mentioning Dr. Rivera and cluster them by topic"
"Which invoices were submitted after the termination date?"
"Build me a timeline of all communications between Smith and Davis Corp"
```

The provenance chain means you can trace every search result back to its exact source page and document -- critical for legal admissibility and audit.

### Medical Records Review

An insurance adjuster needs to review 800+ pages of medical records across 15 providers for a personal injury claim.

```
"Find all references to lumbar spine across every provider's records"
"What medications were prescribed between June and December 2024?"
"Compare the initial ER report with the orthopedic surgeon's assessment"
"Extract all diagnosis codes and dates from the treatment records"
"Cluster these records by provider and summarize each provider's findings"
```

### Financial Audit & Compliance

A forensic accountant is reviewing 5 years of financial records for a fraud investigation -- bank statements, tax returns, invoices, receipts, and internal reports.

```
"Find all transactions over $10,000 across every bank statement"
"Compare this year's tax return with last year's -- what changed?"
"Search for any mention of offshore accounts or shell companies"
"Cluster all invoices by vendor and flag any with duplicate amounts"
"Which expense reports don't have matching receipts?"
```

### Insurance Claims Processing

An adjuster is handling a commercial property damage claim with engineering reports, contractor estimates, photographs, and policy documents.

```
"What is the total estimated repair cost across all contractor bids?"
"Compare the policyholder's damage report with the independent adjuster's assessment"
"Find all photos showing water damage and describe what's in each one"
"Does the policy cover the type of damage described in the engineering report?"
"Cluster all documents by damage category -- structural, electrical, plumbing"
```

### Academic Research

A PhD student is doing a literature review across 200+ papers, supplementary materials, and datasets.

```
"Find all papers that discuss transformer architectures for protein folding"
"Which papers cite the 2023 AlphaFold study?"
"Compare the methodology sections of these three competing approaches"
"Cluster these papers by research topic and list the top 5 clusters"
"Build me a RAG context block about attention mechanisms for my thesis"
```

### Real Estate Due Diligence

A commercial real estate firm is evaluating a property acquisition -- title reports, environmental assessments, lease agreements, zoning documents, and inspection reports.

```
"Are there any environmental liens or violations in the Phase I report?"
"Compare the rent rolls from 2023 and 2024 -- which tenants left?"
"Find all lease clauses related to early termination or renewal options"
"What does the zoning report say about permitted commercial uses?"
"Cluster all inspection findings by severity -- critical, major, minor"
```

### HR & Employment Investigations

An HR director is investigating a workplace complaint with emails, performance reviews, chat logs, and policy documents.

```
"Find all communications between the complainant and the respondent"
"When was the anti-harassment policy last updated and what does it say?"
"Compare the employee's performance reviews from 2023 and 2024"
"Search for any prior complaints or disciplinary actions in these records"
```

---

## Quick Start

```
1. Create a database         ->  ocr_db_create { name: "my-case" }
2. Select it                 ->  ocr_db_select { database_name: "my-case" }
3. Ingest a folder           ->  ocr_ingest_directory { directory_path: "/path/to/docs" }
4. Process everything        ->  ocr_process_pending {}
5. Search                    ->  ocr_search_hybrid { query: "breach of contract" }
6. Ask questions             ->  ocr_rag_context { question: "What were the settlement terms?" }
7. Verify provenance         ->  ocr_provenance_verify { item_id: "doc-id" }
```

Each database is fully isolated. Create one per case, project, or client.

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
| 15 tables   |   | 8 workers|  | VLM vision |  | OCR engine |
| FTS5 search |   | GPU embed|  | re-ranking |  | form fill  |
| vec search  |   | clustering  | PDF analyze|  | file mgmt  |
+-------------+   | img extract +------------+  +------------+
                  +----------+
```

- **TypeScript MCP Server** -- 69 tools, Zod validation, provenance tracking
- **Python Workers** (8) -- OCR, GPU embedding, image extraction, clustering, form fill
- **SQLite + sqlite-vec** -- 15 tables, FTS5 full-text search, vector similarity search, WAL mode
- **Gemini 3 Flash** -- vision analysis, search re-ranking, query expansion, PDF analysis
- **Datalab API** -- document OCR, form filling, cloud storage
- **nomic-embed-text-v1.5** -- 768-dim local embeddings (CUDA / MPS / CPU)

### How Search Works

Three search modes, combinable via Reciprocal Rank Fusion:

| Mode | Best For | How It Works |
|------|----------|--------------|
| **BM25** | Exact terms, case numbers, names | FTS5 full-text with porter stemming |
| **Semantic** | Conceptual queries, paraphrases | Vector similarity via nomic-embed-text-v1.5 |
| **Hybrid** (recommended) | General questions | BM25 + semantic fused, optional Gemini re-ranking |

All search modes support filtering by document cluster, quality score, metadata, and specific document IDs.

### Provenance Chain

Every artifact carries a SHA-256 hash chain back to its source document:

```
DOCUMENT (depth 0)
  +-- OCR_RESULT (depth 1)
  |     +-- CHUNK (depth 2) -> EMBEDDING (depth 3)
  |     +-- IMAGE (depth 2) -> VLM_DESCRIPTION (depth 3) -> EMBEDDING (depth 4)
  |     +-- EXTRACTION (depth 2)
  +-- FORM_FILL (depth 0)
  +-- COMPARISON (depth 2)
  +-- CLUSTERING (depth 2)
```

Export in JSON or W3C PROV-JSON for regulatory compliance.

---

## Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | >= 20 | MCP server runtime |
| Python | >= 3.10 | Worker processes |
| PyTorch | >= 2.0 | Embedding model inference |
| GPU | Optional | CUDA or Apple MPS; CPU works fine, just slower |

### API Keys

| Key | Get From | Used For |
|-----|----------|----------|
| `DATALAB_API_KEY` | [datalab.to](https://www.datalab.to) | OCR, form fill, file upload |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/) | Vision analysis, re-ranking |

---

## Installation

```bash
# Clone and build
git clone https://github.com/ChrisRoyse/OCR-Provenance.git
cd OCR-Provenance
npm install && npm run build

# Install globally (makes `ocr-provenance-mcp` available everywhere)
npm link

# Python dependencies
pip install torch transformers sentence-transformers numpy scikit-learn hdbscan pymupdf pillow python-docx requests

# Download embedding model (~270MB, one-time)
pip install huggingface_hub
huggingface-cli download nomic-ai/nomic-embed-text-v1.5 --local-dir models/nomic-embed-text-v1.5

# Configure API keys
cp .env.example .env
# Edit .env with your DATALAB_API_KEY and GEMINI_API_KEY

# Verify
ocr-provenance-mcp  # Should print "Tools registered: 69" on stderr
```

> **PyTorch GPU note:** If `pip install torch` gives you CPU-only, install the CUDA version explicitly:
> ```bash
> pip install torch --index-url https://download.pytorch.org/whl/cu124
> ```

<details>
<summary><strong>Platform-specific notes</strong></summary>

**Linux / WSL2:** Install NVIDIA drivers and CUDA toolkit. For WSL2, install the [NVIDIA CUDA on WSL driver](https://developer.nvidia.com/cuda/wsl) from the Windows side.

**macOS (Apple Silicon):** MPS acceleration works automatically. Just `pip install torch torchvision torchaudio`.

**Windows:** Use WSL2 for best compatibility. Native Windows works too -- the server auto-detects `python` vs `python3`.

</details>

<details>
<summary><strong>Custom embedding model location</strong></summary>

If you install globally and want the model elsewhere:

```bash
# In your .env file:
EMBEDDING_MODEL_PATH=/path/to/nomic-embed-text-v1.5
```

The server checks: `EMBEDDING_MODEL_PATH` env var -> `models/` in the package directory -> `~/.ocr-provenance/models/`

</details>

---

## Connecting to Claude

### Claude Code

```bash
# Register globally (available in all projects)
claude mcp add ocr-provenance -s user \
  -e OCR_PROVENANCE_ENV_FILE=/path/to/OCR-Provenance/.env \
  -e NODE_OPTIONS=--max-semi-space-size=64 \
  -- ocr-provenance-mcp
```

### Claude Desktop

Add to your config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

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

### Any MCP Client

The server uses stdio transport (JSON-RPC over stdin/stdout):

```bash
ocr-provenance-mcp                    # Global command (after npm link)
node /path/to/dist/index.js           # Direct invocation
```

Environment variables can be provided via `OCR_PROVENANCE_ENV_FILE`, direct env vars, or a `.env` file in the working directory.

---

## Configuration

```bash
# .env file
DATALAB_API_KEY=your_key
GEMINI_API_KEY=your_key

# OCR settings
DATALAB_DEFAULT_MODE=accurate          # fast | balanced | accurate
DATALAB_MAX_CONCURRENT=3

# Embeddings (auto-detects CUDA > MPS > CPU)
EMBEDDING_DEVICE=auto
EMBEDDING_BATCH_SIZE=512

# Chunking
CHUNKING_SIZE=2000
CHUNKING_OVERLAP_PERCENT=10

# Storage
STORAGE_DATABASES_PATH=~/.ocr-provenance/databases/
```

---

## Tool Reference (69 Tools)

<details>
<summary><strong>Database Management (5)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_db_create` | Create a new isolated database |
| `ocr_db_list` | List all databases with optional stats |
| `ocr_db_select` | Select the active database |
| `ocr_db_stats` | Detailed statistics (documents, chunks, embeddings, images, clusters) |
| `ocr_db_delete` | Permanently delete a database |

</details>

<details>
<summary><strong>Ingestion & Processing (8)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_ingest_directory` | Scan directory and register documents (18 file types, recursive) |
| `ocr_ingest_files` | Ingest specific files by path |
| `ocr_process_pending` | Full pipeline: OCR -> Chunk -> Embed -> Vector Index |
| `ocr_status` | Check processing status |
| `ocr_retry_failed` | Reset failed documents for reprocessing |
| `ocr_reprocess` | Reprocess with different OCR settings |
| `ocr_chunk_complete` | Repair documents missing chunks/embeddings |
| `ocr_convert_raw` | One-off OCR conversion without storing |

**Processing options:** `ocr_mode` (fast/balanced/accurate), `chunking_strategy` (fixed/page_aware), `page_range`, `max_pages`, `extras` (track_changes, chart_understanding, extract_links, table_row_bboxes, infographic, new_block_types)

</details>

<details>
<summary><strong>Search & Retrieval (7)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_search` | BM25 full-text search (exact terms, codes, IDs) |
| `ocr_search_semantic` | Vector similarity search (conceptual queries) |
| `ocr_search_hybrid` | Reciprocal Rank Fusion of BM25 + semantic (recommended) |
| `ocr_rag_context` | Assemble hybrid search results into a markdown context block for LLMs |
| `ocr_search_export` | Export results to CSV or JSON |
| `ocr_benchmark_compare` | Compare search results across databases |
| `ocr_fts_manage` | Rebuild or check FTS5 index status |

**Enhancement options:** Gemini re-ranking, cluster filtering, quality score filtering, metadata filtering, provenance inclusion.

</details>

<details>
<summary><strong>Document Management (3)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_document_list` | List documents with status filtering |
| `ocr_document_get` | Full document details (text, chunks, blocks, provenance) |
| `ocr_document_delete` | Delete document and all derived data (cascade) |

</details>

<details>
<summary><strong>Document Comparison (3)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_document_compare` | Text diff + structural metadata diff + similarity ratio |
| `ocr_comparison_list` | List comparisons with optional filtering |
| `ocr_comparison_get` | Full comparison details with diff operations |

</details>

<details>
<summary><strong>Document Clustering (5)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_cluster_documents` | Cluster by semantic similarity (HDBSCAN / agglomerative / k-means) |
| `ocr_cluster_list` | List clusters with filtering by run ID or tag |
| `ocr_cluster_get` | Cluster details with member documents |
| `ocr_cluster_assign` | Auto-assign a document to the nearest cluster |
| `ocr_cluster_delete` | Delete a clustering run |

</details>

<details>
<summary><strong>VLM / Vision Analysis (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_vlm_describe` | Describe an image using Gemini 3 Flash (supports thinking mode) |
| `ocr_vlm_classify` | Classify image type, complexity, text density |
| `ocr_vlm_process_document` | VLM-process all images in a document |
| `ocr_vlm_process_pending` | VLM-process all pending images across all documents |
| `ocr_vlm_analyze_pdf` | Analyze a PDF directly with Gemini 3 Flash (max 20MB) |
| `ocr_vlm_status` | Service status (API config, rate limits, circuit breaker) |

</details>

<details>
<summary><strong>Image Management (8) & Image Extraction (3)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_image_extract` | Extract images from a PDF via Datalab OCR |
| `ocr_image_list` | List images extracted from a document |
| `ocr_image_get` | Get image details |
| `ocr_image_stats` | Processing statistics |
| `ocr_image_delete` | Delete an image record |
| `ocr_image_delete_by_document` | Delete all images for a document |
| `ocr_image_reset_failed` | Reset failed images for reprocessing |
| `ocr_image_pending` | List images pending VLM processing |
| `ocr_extract_images` | Extract images locally (PyMuPDF for PDF, zipfile for DOCX) |
| `ocr_extract_images_batch` | Batch extract from all processed documents |
| `ocr_extraction_check` | Verify Python environment has required packages |

</details>

<details>
<summary><strong>Form Fill (2) & Structured Extraction (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_form_fill` | Fill PDF/image forms via Datalab with field name-value mapping |
| `ocr_form_fill_status` | Form fill operation status and results |
| `ocr_extract_structured` | Extract structured data from OCR'd documents using a JSON schema |
| `ocr_extraction_list` | List structured extractions for a document |

</details>

<details>
<summary><strong>File Management (5)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_file_upload` | Upload to Datalab cloud (deduplicates by SHA-256) |
| `ocr_file_list` | List uploaded files with duplicate detection |
| `ocr_file_get` | File metadata |
| `ocr_file_download` | Get download URL |
| `ocr_file_delete` | Delete file record |

</details>

<details>
<summary><strong>Evaluation & Reports (7)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_evaluate_single` | Evaluate a single image with VLM |
| `ocr_evaluate_document` | Evaluate all images in a document |
| `ocr_evaluate_pending` | Evaluate all pending images |
| `ocr_evaluation_report` | Comprehensive OCR + VLM metrics report (markdown) |
| `ocr_document_report` | Single document report (images, extractions, comparisons, clusters) |
| `ocr_quality_summary` | Quality summary across all documents |
| `ocr_cost_summary` | Cost analytics by document, mode, month, or total |

</details>

<details>
<summary><strong>Provenance (3) & Configuration (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_provenance_get` | Get the complete provenance chain for any item |
| `ocr_provenance_verify` | Verify integrity through SHA-256 hash chain |
| `ocr_provenance_export` | Export provenance (JSON, W3C PROV-JSON, CSV) |
| `ocr_config_get` | Get current system configuration |
| `ocr_config_set` | Update configuration at runtime |

</details>

---

## Development

```bash
npm run build             # Build TypeScript
npm test                  # All tests (1500+ across 79 files)
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
npm run lint:all          # TypeScript + Python linting
npm run check             # typecheck + lint + test
```

### Project Structure

```
src/
  index.ts              # MCP server entry point
  tools/                # 16 tool files + shared.ts
  services/             # Core services (OCR, embedding, search, VLM, clustering, etc.)
  models/               # Zod schemas and TypeScript types
  utils/                # Hash, validation helpers
  server/               # Server state, types, errors
python/                 # 8 Python workers + GPU utils
tests/
  unit/                 # Unit tests
  integration/          # Integration tests
  fixtures/             # Test fixtures and sample documents
```

---

## Troubleshooting

<details>
<summary><strong>sqlite-vec loading errors</strong></summary>

Run `npm install` -- sqlite-vec uses a prebuilt binary that must match your platform and Node.js version.
</details>

<details>
<summary><strong>Python not found (Windows)</strong></summary>

The server auto-detects `python` vs `python3`. Ensure Python is on your PATH: `python --version`.
</details>

<details>
<summary><strong>GPU not detected</strong></summary>

```bash
python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('MPS:', hasattr(torch.backends, 'mps') and torch.backends.mps.is_available())"
```
If both are False, install the CUDA version of PyTorch: `pip install torch --index-url https://download.pytorch.org/whl/cu124`
</details>

<details>
<summary><strong>Embedding model not found</strong></summary>

Download the model (see [Installation](#installation)). Verify `config.json`, `model.safetensors`, and `tokenizer.json` are present in the model directory.
</details>

<details>
<summary><strong>API key warnings at startup</strong></summary>

Copy `.env.example` to `.env` and fill in your `DATALAB_API_KEY` and `GEMINI_API_KEY`.
</details>

---

## License

This project uses a **dual-license** model:

- **Free for non-commercial use** -- personal projects, academic research, education, non-profits, evaluation, and contributions to this project are all permitted at no cost.
- **Commercial license required for revenue-generating use** -- if you use this software to make money (paid services, SaaS, internal tools at for-profit companies, etc.), you must obtain a commercial license from the copyright holder. Terms are negotiated case-by-case and may include revenue sharing or flat-rate arrangements.

See [LICENSE](LICENSE) for full details. For commercial licensing inquiries, contact Chris Royse at [chrisroyseai@gmail.com](mailto:chrisroyseai@gmail.com) or via [GitHub](https://github.com/ChrisRoyse).