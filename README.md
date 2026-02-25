# OCR Provenance MCP Server

**Give your AI the power to read, search, and reason over any document.**

[![npm](https://img.shields.io/npm/v/ocr-provenance-mcp)](https://www.npmjs.com/package/ocr-provenance-mcp)
[![License: Dual](https://img.shields.io/badge/License-Free_Non--Commercial-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple)](https://modelcontextprotocol.io/)
[![Tools](https://img.shields.io/badge/MCP_Tools-141-orange)](#tool-reference-141-tools)
[![Tests](https://img.shields.io/badge/Tests-2%2C639_passing-brightgreen)](#development)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-blue)](https://github.com/ChrisRoyse/OCR-Provenance/pkgs/container/ocr-provenance)

---

## Install

Two commands. That's it.

```bash
npm install -g ocr-provenance-mcp
ocr-provenance-mcp-setup
```

The setup wizard walks you through everything: API keys, Docker image, and connecting to your AI client. Takes about 5 minutes.

**Prerequisites:** [Docker Desktop](https://docker.com/products/docker-desktop) and [Node.js](https://nodejs.org/) >= 20. No Python install, no GPU drivers, no model downloads -- the Docker image handles all of that.

---

## Getting Your API Keys

You need two free API keys. The setup wizard will ask for both and validate them automatically.

### 1. Datalab API Key (for OCR)

Datalab handles the document-to-text conversion -- 18 file types including PDFs, Word docs, spreadsheets, presentations, and images.

1. Go to [datalab.to](https://www.datalab.to)
2. Click **Sign Up** (or log in if you have an account)
3. Go to your [Account page](https://www.datalab.to/account)
4. Copy your API key

Datalab offers free credits to start. Their OCR supports three accuracy modes (fast, balanced, accurate) and handles scanned documents, handwriting, tables, charts, and multi-column layouts.

### 2. Gemini API Key (for vision AI)

Gemini Flash 3 analyzes images extracted from your documents -- describing charts, diagrams, photos, and figures so they become searchable too.

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Sign in with your Google account
3. Click **Get API Key** in the left sidebar
4. Click **Create API Key** and select a project (or create one)
5. Copy your API key

The free tier is generous and more than enough to get started. The server uses the `gemini-3-flash-preview` model for fast, low-cost image analysis.

---

## The Problem This Solves

AI is powerful, but it can't work with messy data. And real-world data is always messy.

Your documents are trapped in PDFs, scanned images, Word files, spreadsheets, and presentations. Claude can't natively read a 500-page contract PDF. It can't search across 3,000 discovery documents. It can't compare two versions of a lease agreement or find every mention of a specific clause across a corpus of legal filings.

**This server is a data cleaning pipeline that makes your documents AI-ready.** It takes your messy files -- all 18 supported formats -- and converts them into clean, chunked, embedded, searchable text with full provenance tracking. Then it exposes 141 tools that let the AI search, navigate, compare, and reason over that data.

You don't need clean data. You need this system. It gives the AI the tools to clean the data itself.

### What Happens When You Point It at a Folder

```
Your messy files (PDF, DOCX, XLSX, scanned images, presentations...)
    |
    v
  OCR extracts text from every page (Datalab API, 3 accuracy modes)
    |
    v
  Smart chunking splits text into searchable sections
  (respects headings, tables, page boundaries -- not arbitrary splits)
    |
    v
  Each chunk gets a vector embedding (nomic-embed-text-v1.5, 768-dim)
    |
    v
  Images extracted and described by AI (Gemini Flash 3)
    |
    v
  Full-text search index built (BM25 + FTS5)
    |
    v
  SHA-256 provenance chain on every artifact
  (you can prove exactly where every answer came from)
    |
    v
  141 tools available to your AI -- search, compare, cluster, tag,
  extract tables, fill forms, track obligations, verify integrity
```

The AI can now search your entire document collection with keyword search (exact terms, case numbers, names), semantic search (conceptual queries, paraphrases), or hybrid search (both combined -- recommended). Every result links back to its exact source page and document through the provenance chain.

---

## Who Is This For

### Lawyers and Legal Teams

This is where the system has the highest impact. Legal work is document work, and legal documents are notoriously messy -- scanned contracts, discovery dumps with thousands of files, handwritten notes, exhibits in every format imaginable.

With this server, you can tell Claude:

- *"Search all 3,000 discovery documents for references to the March 2024 amendment"*
- *"Compare the original contract with the signed version -- what changed?"*
- *"Find every document mentioning Dr. Rivera and cluster them by topic"*
- *"Which invoices were submitted after the termination date?"*
- *"Extract all obligation deadlines from these contracts and show me what's due this month"*

The provenance chain is critical for legal work. Every search result traces back to its exact source page and document -- supporting admissibility, audit, and compliance requirements. Export provenance in W3C PROV-JSON format for regulatory filings.

### Insurance and Claims

Adjusters reviewing hundreds of pages across multiple providers: medical records, engineering reports, contractor estimates, policy documents. Search semantically across all of them, compare assessments, and cluster findings by category.

### Finance and Compliance

Forensic accountants and compliance teams reviewing years of financial records. Cross-reference bank statements, tax returns, and invoices. Flag duplicates, compare year-over-year, and generate compliance reports (SOC2, SOX, HIPAA).

### Research and Due Diligence

Literature reviews, real estate due diligence, HR investigations -- any work that requires reading, searching, and comparing large volumes of documents. The AI does the reading; you do the thinking.

---

## Supported File Types (18)

| Category | Formats |
|----------|---------|
| Documents | PDF, DOCX, DOC, TXT, CSV, MD |
| Spreadsheets | XLSX, XLS |
| Presentations | PPTX, PPT |
| Images | PNG, JPG, JPEG, TIFF, TIF, BMP, GIF, WEBP |

Scanned documents, handwriting, multi-column layouts, tables, and charts are all handled by the Datalab OCR engine.

---

## Quick Start

Once installed, open your AI client and tell it:

```
"Create a database called my-case, ingest all the PDFs in ~/Documents/case-files, and process everything"
```

Or step by step with tool calls:

```
1. ocr_db_create { name: "my-case" }
2. ocr_db_select { database_name: "my-case" }
3. ocr_ingest_directory { directory_path: "/path/to/docs" }
4. ocr_process_pending {}
5. ocr_search { query: "breach of contract" }
6. ocr_rag_context { question: "What were the settlement terms?" }
```

Each database is fully isolated. Create one per case, project, or client.

---

## How Search Works

Three modes, all built-in:

| Mode | Best For | How It Works |
|------|----------|--------------|
| **Keyword** (BM25) | Exact terms, case numbers, names, dates | FTS5 full-text with porter stemming |
| **Semantic** | Conceptual queries, paraphrases, "find documents about X" | Vector similarity via nomic-embed-text-v1.5 |
| **Hybrid** (default) | Everything else | Keyword + semantic combined via Reciprocal Rank Fusion |

All modes support: local cross-encoder reranking, query expansion (legal/medical synonyms), auto-routing, quality-weighted ranking, page/section/heading filters, document grouping, header/footer exclusion, and provenance inclusion.

---

## Platform Setup

### Docker Desktop

| Platform | Install |
|----------|---------|
| **Windows** | [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) (requires WSL2) |
| **macOS** | [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) (Intel and Apple Silicon) |
| **Linux** | [Docker Engine](https://docs.docker.com/engine/install/) -- add your user to the docker group: `sudo usermod -aG docker $USER` |

### Supported AI Clients

The setup wizard auto-detects your platform and registers the server. Supported clients:

| Client | How It's Configured |
|--------|---------------------|
| **Claude Code** | Automatic via `claude mcp add` |
| **Claude Desktop** | JSON config (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`) |
| **Cursor** | `~/.cursor/mcp.json` |
| **VS Code** | `.vscode/mcp.json` (per-project) |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |

---

## Backup and Restore

Your databases live in the `ocr-data` Docker volume and persist across container restarts.

```bash
# Backup all databases to ./backup/
docker run --rm -v ocr-data:/data:ro -v $(pwd)/backup:/backup alpine cp -a /data/. /backup/

# Restore from ./backup/
docker run --rm -v ocr-data:/data -v $(pwd)/backup:/backup:ro alpine cp -a /backup/. /data/
```

---

## Configuration

API keys are stored at `~/.ocr-provenance/.env` (created by the setup wizard, permissions 0600). All other settings can be changed at runtime via the `ocr_config_set` tool.

| Setting | Default | Description |
|---------|---------|-------------|
| `DATALAB_DEFAULT_MODE` | `accurate` | OCR mode: `fast`, `balanced`, or `accurate` |
| `DATALAB_MAX_CONCURRENT` | `3` | Max concurrent OCR API requests |
| `EMBEDDING_DEVICE` | `cpu` | `cpu`, `cuda`, or `mps` (auto-detected in Docker) |
| `EMBEDDING_BATCH_SIZE` | `512` | Batch size for embedding generation |
| `CHUNKING_SIZE` | `2000` | Target chunk size in characters |
| `CHUNKING_OVERLAP_PERCENT` | `10` | Overlap between adjacent chunks |
| `AUTO_CLUSTER_ENABLED` | `false` | Auto-cluster documents after processing |
| `AUTO_CLUSTER_THRESHOLD` | `5` | Minimum documents to trigger auto-clustering |

### Environment Variables (Docker)

Override via `-e` flags when needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATALAB_API_KEY` | (required) | Datalab OCR API key |
| `GEMINI_API_KEY` | (required) | Google Gemini API key |
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_HTTP_PORT` | `3100` | HTTP server port (when using `http` transport) |
| `OCR_PROVENANCE_DATABASES_PATH` | `/data` | Database storage path inside container |
| `OCR_PROVENANCE_ALLOWED_DIRS` | `/host,/data` | Allowed directories for file access |

### HTTP Mode (Remote/Shared Deployment)

```bash
docker compose up -d          # CPU mode
docker compose -f docker-compose.gpu.yml up -d   # GPU mode (NVIDIA CUDA)
```

Health endpoint: `GET /health` -- MCP endpoint: `POST /mcp` -- Port: 3100

---

## Tool Reference (141 Tools)

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
<summary><strong>Ingestion & Processing (9)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_ingest_directory` | Scan directory and register documents (18 file types, recursive) |
| `ocr_ingest_files` | Ingest specific files by path |
| `ocr_process_pending` | Full pipeline: OCR -> Chunk -> Embed -> Vector -> VLM (with auto-clustering) |
| `ocr_status` | Check processing status |
| `ocr_retry_failed` | Reset failed documents for reprocessing |
| `ocr_reprocess` | Reprocess with different OCR settings |
| `ocr_chunk_complete` | Repair documents missing chunks/embeddings |
| `ocr_convert_raw` | One-off OCR conversion without storing |
| `ocr_reembed_document` | Re-generate embeddings for a document without re-OCRing |

</details>

<details>
<summary><strong>Search & Retrieval (7)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_search` | Unified search -- `mode`: `keyword` (BM25), `semantic` (vector), or `hybrid` (default) |
| `ocr_rag_context` | Assemble hybrid search results into a markdown context block for LLMs |
| `ocr_search_export` | Export results to CSV or JSON |
| `ocr_fts_manage` | Rebuild or check FTS5 index status |
| `ocr_search_saved` | Save, list, get, or execute named searches |
| `ocr_search_cross_db` | BM25 search across all databases simultaneously |
| `ocr_benchmark_compare` | Compare search results across databases |

</details>

<details>
<summary><strong>Document Management (12)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_document_list` | List documents with status filtering |
| `ocr_document_get` | Full document details (text, chunks, blocks, provenance) |
| `ocr_document_delete` | Delete document and all derived data (cascade) |
| `ocr_document_find_similar` | Find similar documents via embedding centroid similarity |
| `ocr_document_structure` | Analyze document structure (headings, tables, figures, code blocks) |
| `ocr_document_sections` | Get section hierarchy tree from chunk section paths |
| `ocr_document_update_metadata` | Batch update document metadata fields |
| `ocr_document_duplicates` | Detect exact (hash) and near (similarity) duplicates |
| `ocr_document_export` | Export document to JSON or markdown |
| `ocr_corpus_export` | Export entire corpus to JSON or markdown archive |
| `ocr_document_versions` | List all versions of a document by file path |
| `ocr_document_workflow` | Manage workflow states (draft/review/approved/published/archived) |

</details>

<details>
<summary><strong>Provenance (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_provenance_get` | Get the complete provenance chain for any item |
| `ocr_provenance_verify` | Verify integrity through SHA-256 hash chain |
| `ocr_provenance_export` | Export provenance (JSON, W3C PROV-JSON, CSV) |
| `ocr_provenance_query` | Query provenance records with 12+ filters |
| `ocr_provenance_timeline` | View document processing timeline |
| `ocr_provenance_processor_stats` | Aggregate statistics per processor type |

</details>

<details>
<summary><strong>Document Comparison (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_document_compare` | Text diff + structural metadata diff + similarity ratio |
| `ocr_comparison_list` | List comparisons with optional filtering |
| `ocr_comparison_get` | Full comparison details with diff operations |
| `ocr_comparison_discover` | Auto-discover similar document pairs for comparison |
| `ocr_comparison_batch` | Batch compare multiple document pairs |
| `ocr_comparison_matrix` | NxN pairwise cosine similarity matrix across documents |

</details>

<details>
<summary><strong>Document Clustering (7)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_cluster_documents` | Cluster by semantic similarity (HDBSCAN / agglomerative / k-means) |
| `ocr_cluster_list` | List clusters with filtering by run ID or tag |
| `ocr_cluster_get` | Cluster details with member documents |
| `ocr_cluster_assign` | Auto-assign a document to the nearest cluster |
| `ocr_cluster_reassign` | Move a document to a different cluster |
| `ocr_cluster_merge` | Merge two clusters into one |
| `ocr_cluster_delete` | Delete a clustering run |

</details>

<details>
<summary><strong>VLM / Vision Analysis (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_vlm_describe` | Describe an image using Gemini 3 Flash |
| `ocr_vlm_classify` | Classify image type, complexity, text density |
| `ocr_vlm_process_document` | VLM-process all images in a document |
| `ocr_vlm_process_pending` | VLM-process all pending images across all documents |
| `ocr_vlm_analyze_pdf` | Analyze a PDF directly with Gemini 3 Flash (max 20MB) |
| `ocr_vlm_status` | Service status (API config, rate limits, circuit breaker) |

</details>

<details>
<summary><strong>Image Operations (11)</strong></summary>

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
| `ocr_image_search` | Search images with 7 filters |
| `ocr_image_semantic_search` | Semantic search over VLM image descriptions |
| `ocr_image_reanalyze` | Re-run VLM analysis with a custom prompt |

</details>

<details>
<summary><strong>Image Extraction (3)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_extract_images` | Extract images locally (PyMuPDF for PDF, zipfile for DOCX) |
| `ocr_extract_images_batch` | Batch extract from all processed documents |
| `ocr_extraction_check` | Verify Python environment has required packages |

</details>

<details>
<summary><strong>Chunks & Pages (4)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_chunk_get` | Get a chunk by ID with full metadata |
| `ocr_chunk_list` | List chunks with filtering (content type, section path, page, heading) |
| `ocr_chunk_context` | Get a chunk with N neighboring chunks for context |
| `ocr_document_page` | Get all chunks for a specific page number |

</details>

<details>
<summary><strong>Embeddings (4)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_embedding_list` | List embeddings with filtering |
| `ocr_embedding_stats` | Embedding statistics (counts, models, coverage) |
| `ocr_embedding_get` | Get embedding details by ID |
| `ocr_embedding_rebuild` | Re-generate embeddings for specific targets |

</details>

<details>
<summary><strong>Structured Extraction (4)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_extract_structured` | Extract structured data using a JSON schema |
| `ocr_extraction_list` | List structured extractions for a document |
| `ocr_extraction_get` | Get a structured extraction by ID |
| `ocr_extraction_search` | Search across extraction content |

</details>

<details>
<summary><strong>Form Fill (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_form_fill` | Fill PDF/image forms via Datalab |
| `ocr_form_fill_status` | Form fill operation status and results |

</details>

<details>
<summary><strong>File Management (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_file_upload` | Upload to Datalab cloud (deduplicates by SHA-256) |
| `ocr_file_list` | List uploaded files with duplicate detection |
| `ocr_file_get` | File metadata |
| `ocr_file_download` | Get download URL |
| `ocr_file_delete` | Delete file record |
| `ocr_file_ingest_uploaded` | Bridge uploaded files into the document pipeline |

</details>

<details>
<summary><strong>Tags (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_tag_create` | Create a tag with optional color and description |
| `ocr_tag_list` | List tags with usage counts |
| `ocr_tag_apply` | Apply a tag to any entity (document, chunk, image, cluster, etc.) |
| `ocr_tag_remove` | Remove a tag from an entity |
| `ocr_tag_search` | Find entities by tag name |
| `ocr_tag_delete` | Delete a tag and all associations |

</details>

<details>
<summary><strong>Intelligence & Navigation (4)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_guide` | AI agent navigation -- inspects system state and recommends next actions |
| `ocr_document_tables` | Extract and parse tables from OCR JSON blocks |
| `ocr_document_recommend` | Get related document recommendations |
| `ocr_document_extras` | Access OCR extras data (charts, links, tracked changes) |

</details>

<details>
<summary><strong>Evaluation (3)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_evaluate_single` | Evaluate a single image with VLM |
| `ocr_evaluate_document` | Evaluate all images in a document |
| `ocr_evaluate_pending` | Evaluate all pending images system-wide |

</details>

<details>
<summary><strong>Reports & Analytics (9)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_evaluation_report` | Comprehensive OCR + VLM metrics report |
| `ocr_document_report` | Single document report |
| `ocr_quality_summary` | Quality summary across all documents |
| `ocr_cost_summary` | Cost analytics by document, mode, month, or total |
| `ocr_pipeline_analytics` | Pipeline throughput and duration breakdown |
| `ocr_corpus_profile` | Corpus content profile |
| `ocr_error_analytics` | Error/recovery analytics and failure rates |
| `ocr_provenance_bottlenecks` | Processing bottleneck analysis |
| `ocr_quality_trends` | Quality trends over time |

</details>

<details>
<summary><strong>Timeline & Analytics (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_timeline_analytics` | Volume metrics over time |
| `ocr_throughput_analytics` | Processing throughput per time bucket |

</details>

<details>
<summary><strong>Users & RBAC (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_user_info` | Get, create, or list users (viewer/reviewer/editor/admin roles) |
| `ocr_audit_query` | Query the user action audit log with filters |

</details>

<details>
<summary><strong>Collaboration (11)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_annotation_create` | Add comments, suggestions, or highlights on documents |
| `ocr_annotation_list` | List annotations with filtering |
| `ocr_annotation_get` | Get annotation details with thread replies |
| `ocr_annotation_update` | Edit an annotation |
| `ocr_annotation_delete` | Delete an annotation |
| `ocr_annotation_summary` | Summary stats for annotations on a document |
| `ocr_document_lock` | Lock a document (exclusive or shared) |
| `ocr_document_unlock` | Release a document lock |
| `ocr_document_lock_status` | Check lock status and holder |
| `ocr_search_alert_enable` | Set up alerts for new content matching a query |
| `ocr_search_alert_check` | Check for new matches since last alert |

</details>

<details>
<summary><strong>Workflow & Approvals (8)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_workflow_submit` | Submit a document for review |
| `ocr_workflow_review` | Approve, reject, or request changes |
| `ocr_workflow_assign` | Assign a reviewer to a document |
| `ocr_workflow_status` | Get current workflow state and history |
| `ocr_workflow_queue` | List documents pending review |
| `ocr_approval_chain_create` | Create multi-step approval chains |
| `ocr_approval_chain_apply` | Apply an approval chain to a document |
| `ocr_approval_step_decide` | Record an approval/rejection decision on a step |

</details>

<details>
<summary><strong>Events & Webhooks (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_webhook_create` | Register a webhook endpoint (HMAC-SHA256 signed) |
| `ocr_webhook_list` | List registered webhooks |
| `ocr_webhook_delete` | Remove a webhook |
| `ocr_export_obligations_csv` | Export obligations to CSV |
| `ocr_export_audit_log` | Export audit log entries |
| `ocr_export_annotations` | Export document annotations |

</details>

<details>
<summary><strong>Contract Lifecycle Management (9)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_contract_extract` | Extract contract clauses and terms from OCR text |
| `ocr_obligation_list` | List obligations with status filtering |
| `ocr_obligation_update` | Update obligation status or details |
| `ocr_obligation_calendar` | View obligations by due date range |
| `ocr_playbook_create` | Create a clause comparison playbook |
| `ocr_playbook_compare` | Compare document clauses against a playbook |
| `ocr_playbook_list` | List available playbooks |
| `ocr_document_summarize` | Algorithmic document summarization |
| `ocr_corpus_summarize` | Summarize across multiple documents |

</details>

<details>
<summary><strong>Compliance (3)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_compliance_report` | Generate compliance report (SOC2/SOX) |
| `ocr_compliance_hipaa` | HIPAA-specific compliance checks and export |
| `ocr_compliance_export` | Export provenance with PROV-AGENT metadata and chain-hash verification |

</details>

<details>
<summary><strong>Health & Config (3)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_health_check` | Detect data integrity gaps with optional auto-fix |
| `ocr_config_get` | Get current system configuration |
| `ocr_config_set` | Update configuration at runtime |

</details>

---

## Troubleshooting

<details>
<summary><strong>Docker not running</strong></summary>

Make sure Docker Desktop is running. On Linux, check with `docker info`. On Windows/macOS, open Docker Desktop from the system tray.
</details>

<details>
<summary><strong>Setup wizard can't find Docker</strong></summary>

Ensure `docker` is on your PATH: `docker --version`. On Windows, you may need to restart your terminal after installing Docker Desktop.
</details>

<details>
<summary><strong>Server not appearing in AI client</strong></summary>

Restart your AI client after running `ocr-provenance-mcp-setup`. MCP clients only load server configs at startup.
</details>

<details>
<summary><strong>API key validation fails</strong></summary>

- **Datalab**: Make sure your key is from [datalab.to](https://www.datalab.to) (not the docs site). Run the setup wizard again to re-enter.
- **Gemini**: Make sure your key is from [Google AI Studio](https://aistudio.google.com/). Free tier keys work fine.
</details>

<details>
<summary><strong>GPU acceleration in Docker</strong></summary>

The default image uses CPU (works great, just slower for embeddings). For GPU:
```bash
docker compose -f docker-compose.gpu.yml up -d
```
Or build a GPU image yourself:
```bash
docker build --build-arg COMPUTE=cu124 \
  --build-arg RUNTIME_BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
  -t ocr-provenance-mcp:gpu .
```
</details>

---

## Architecture

<details>
<summary><strong>System overview</strong></summary>

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server (stdio/http)                    │
│  TypeScript + @modelcontextprotocol/sdk                     │
│  141 tools across 28 tool modules                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Ingestion│  │  Search  │  │ Analysis │  │  Reports │   │
│  │ 9 tools  │  │ 12 tools │  │ 35 tools │  │  9 tools │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   VLM    │  │  Images  │  │  Tags    │  │  Intel   │   │
│  │ 6 tools  │  │ 14 tools │  │ 6 tools  │  │  4 tools │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │          │
│  ┌────┴──────────────┴──────────────┴──────────────┴────┐   │
│  │             Service Layer (11 domains)                │   │
│  │  OCR · Chunking · Embedding · Search · VLM          │   │
│  │  Provenance · Comparison · Clustering · Gemini      │   │
│  │  Images · Storage                                    │   │
│  └────┬──────────────┬──────────────┬───────────────────┘   │
│       │              │              │                         │
│  ┌────┴────┐   ┌────┴────┐   ┌────┴─────┐                  │
│  │ SQLite  │   │sqlite-vec│   │ FTS5     │                  │
│  │ 28 tbls │   │ vectors  │   │ indexes  │                  │
│  └─────────┘   └─────────┘   └──────────┘                  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            Python Workers (9 processes)               │   │
│  │  OCR · Embedding · Clustering · Image Extraction    │   │
│  │  DOCX Extraction · Image Optimizer · Form Fill      │   │
│  │  File Manager · Local Reranker                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            External APIs                              │   │
│  │  Datalab (OCR/Forms) · Gemini 3 Flash (VLM/AI)     │   │
│  │  Nomic embed v1.5 (local, 768-dim)                  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

</details>

<details>
<summary><strong>Processing pipeline detail</strong></summary>

```
File on disk
  │
  ├─ 1. REGISTER ──► documents table (status: pending)
  │                  ├─ file_hash computed (SHA-256)
  │                  ├─ version detection (new vs re-ingested)
  │                  └─ provenance record (type: DOCUMENT, depth: 0)
  │
  ├─ 2. OCR ──────► ocr_results table
  │                  ├─ Datalab API call (fast/balanced/accurate)
  │                  ├─ extracted_text (markdown)
  │                  ├─ json_blocks (structural hierarchy)
  │                  └─ provenance record (type: OCR_RESULT, depth: 1)
  │
  ├─ 3. CHUNK ────► chunks table
  │                  ├─ Hybrid section-aware chunking
  │                  ├─ 2000 chars with 10% overlap
  │                  ├─ section_path, heading_context, content_types
  │                  └─ provenance records (type: CHUNK, depth: 2)
  │
  ├─ 4. EMBED ────► embeddings + vec_embeddings tables
  │                  ├─ Nomic embed v1.5 (768-dim)
  │                  └─ provenance records (type: EMBEDDING, depth: 3)
  │
  ├─ 5. FTS ──────► fts_index (FTS5 virtual table)
  │
  ├─ 6. IMAGES ───► images table
  │   └─ 7. VLM ──► VLM descriptions + embeddings
  │
  ├─ 8. AUTO-CLUSTER (when configured)
  │
  └─ documents.status = 'complete'
```

</details>

<details>
<summary><strong>Data architecture (schema v32, 28 tables)</strong></summary>

| Table | Purpose |
|-------|---------|
| `documents` | Source files, file hash, status, page count |
| `ocr_results` | Extracted text, JSON blocks, quality score |
| `chunks` | Text segments with section path, heading, content types |
| `embeddings` | 768-dim vectors with source metadata |
| `images` | Extracted images with VLM descriptions |
| `extractions` | Structured data extractions |
| `form_fills` | Form filling results |
| `comparisons` | Document pair diffs |
| `clusters` | Document groupings by similarity |
| `document_clusters` | Cluster membership |
| `provenance` | Full audit trail with chain hash |
| `tags` | Cross-entity labels |
| `entity_tags` | Tag associations |
| `saved_searches` | Saved search configurations |
| `uploaded_files` | Cloud file tracking |
| `database_metadata` | DB-level settings |
| `schema_version` | Migration tracking |
| `fts_index_metadata` | FTS index state |
| `users` | Multi-user accounts with RBAC |
| `audit_log` | User action audit trail |
| `annotations` | Document annotations (comments, suggestions, highlights) |
| `document_locks` | Collaborative locking |
| `workflow_states` | Document lifecycle state machine |
| `approval_chains` | Multi-step approval workflows |
| `approval_steps` | Individual approval decisions |
| `obligations` | Contract obligations with due dates |
| `playbooks` | Clause comparison playbooks |
| `webhooks` | Event notification endpoints |

</details>

---

## Development

```bash
npm run build             # Build TypeScript
npm test                  # All tests (2,639 across 115 test suites)
npm run lint:all          # TypeScript + Python linting
npm run check             # typecheck + lint + test
```

<details>
<summary><strong>Project structure</strong></summary>

```
src/
  index.ts              # MCP server entry point
  bin.ts                # CLI entry point (stdio)
  bin-http.ts           # HTTP entry point
  bin-setup.ts          # Setup wizard
  tools/                # 28 tool files + shared.ts
  services/             # Core services (11 domains, 64 files)
  models/               # Zod schemas and TypeScript types
  utils/                # Hash, validation, path sanitization
  server/               # Server state, types, errors
python/                 # 9 Python workers + GPU utils
tests/                  # Unit, integration, e2e, benchmark tests
docs/                   # System documentation and reports
```

</details>

---

## License

This project uses a **dual-license** model:

- **Free for non-commercial use** -- personal projects, academic research, education, non-profits, evaluation, and contributions to this project are all permitted at no cost.
- **Commercial license required for revenue-generating use** -- if you use this software to make money (paid services, SaaS, internal tools at for-profit companies, etc.), you must obtain a commercial license from the copyright holder. Terms are negotiated case-by-case and may include revenue sharing or flat-rate arrangements.

See [LICENSE](LICENSE) for full details. For commercial licensing inquiries, contact Chris Royse at [chrisroyseai@gmail.com](mailto:chrisroyseai@gmail.com) or via [GitHub](https://github.com/ChrisRoyse).
