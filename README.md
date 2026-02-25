# OCR Provenance MCP Server

**Turn thousands of documents into a searchable, AI-queryable knowledge base -- with full provenance.**

Point this at a folder of PDFs, Word docs, spreadsheets, images, or presentations. Minutes later, Claude can search, analyze, compare, and answer questions across your entire document collection -- with a cryptographic audit trail proving exactly where every answer came from.

[![npm](https://img.shields.io/npm/v/ocr-provenance-mcp)](https://www.npmjs.com/package/ocr-provenance-mcp)
[![License: Dual](https://img.shields.io/badge/License-Free_Non--Commercial-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple)](https://modelcontextprotocol.io/)
[![Tools](https://img.shields.io/badge/MCP_Tools-141-orange)](#tool-reference-141-tools)
[![Tests](https://img.shields.io/badge/Tests-2%2C639_passing-brightgreen)](#development)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-blue)](https://github.com/ChrisRoyse/OCR-Provenance/pkgs/container/ocr-provenance)

---

## Why This Exists

AI assistants can't read your files natively. They can't search across 500 PDFs, compare contract versions, or find the one email buried in a discovery dump. This server bridges that gap.

It's a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude (or any MCP client) the ability to **ingest, OCR, search, compare, cluster, tag, version-track, and reason over** your documents -- with a cryptographic audit trail proving exactly where every answer came from.

### What Happens When You Ingest Documents

```
Your files (PDF, DOCX, XLSX, images, presentations...)
    -> OCR text extraction via Datalab API (3 accuracy modes)
    -> Hybrid section-aware chunking with markdown parsing
    -> GPU vector embeddings (nomic-embed-text-v1.5, 768-dim)
    -> Image extraction + AI vision analysis (Gemini 3 Flash)
    -> Full-text + semantic + hybrid search indexes
    -> Document clustering by similarity (HDBSCAN / agglomerative / k-means)
    -> Cross-entity tagging system
    -> Document version tracking (re-ingestion detects changes)
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
5. Search                    ->  ocr_search { query: "breach of contract" }
6. Ask questions             ->  ocr_rag_context { question: "What were the settlement terms?" }
7. Verify provenance         ->  ocr_provenance_verify { item_id: "doc-id" }
```

Each database is fully isolated. Create one per case, project, or client.

---

## Architecture

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
│  │  Nomic embed v1.5 (local GPU, 768-dim)              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

- **TypeScript MCP Server** -- 141 tools across 28 modules, Zod validation, provenance tracking
- **Python Workers** (9) -- OCR, GPU embedding, image extraction, clustering, form fill, file management, local reranking
- **SQLite + sqlite-vec** -- 28 tables, FTS5 full-text search, vector similarity search, WAL mode
- **Gemini 3 Flash** -- vision analysis (image description, classification, PDF analysis)
- **Datalab API** -- document OCR, form filling, structured extraction, cloud storage
- **nomic-embed-text-v1.5** -- 768-dim local embeddings (CUDA / MPS / CPU)

### Hybrid Section-Aware Chunking

The chunking pipeline produces semantically coherent chunks that respect document structure:

```
OCR text (markdown)
  │
  ├─ Text Normalization ──── Clean whitespace, normalize line breaks
  ├─ Heading Normalization ─ Fix skipped heading levels (h1→h3 becomes h1→h2)
  ├─ Markdown Parsing ────── Parse into heading/paragraph/table/code/list blocks
  ├─ JSON Block Analysis ──── Detect atomic regions (tables, figures) from OCR blocks
  ├─ Section-Aware Splitting ─ Chunk at heading boundaries, respect atomic regions
  ├─ Page Tracking ────────── Assign page numbers via Datalab page separators
  ├─ Chunk Merging ────────── Merge heading-only chunks into their content
  ├─ Chunk Deduplication ──── Remove near-duplicate chunks via fuzzy matching
  ├─ Header/Footer Tagging ── Auto-tag header/footer chunks for search exclusion
  └─ Metadata Enrichment ──── section_path, heading_context, content_types per chunk
```

Each chunk carries: `section_path` (e.g., "Introduction > Background"), `heading_context`, `content_types` (table/code/text/list), and `page_number` -- all searchable as filters.

### How Search Works

Three search modes, combinable via Reciprocal Rank Fusion:

| Mode | Best For | How It Works |
|------|----------|--------------|
| **BM25** | Exact terms, case numbers, names | FTS5 full-text with porter stemming |
| **Semantic** | Conceptual queries, paraphrases | Vector similarity via nomic-embed-text-v1.5 |
| **Hybrid** (recommended) | General questions | BM25 + semantic fused, optional local re-ranking |

#### Search Enhancement Stack

All three search modes support a shared enhancement stack:

- **Query classification** -- heuristic analysis auto-routes queries between exact/semantic/mixed modes (`auto_route` on hybrid)
- **Query expansion** -- legal/medical synonym injection for broader recall (`expand_query`, default on for hybrid)
- **Local cross-encoder reranking** -- Python-based cross-encoder model (ms-marco-MiniLM-L-12-v2) re-scores results locally for relevance (`rerank`)
- **Quality-weighted ranking** -- always-on quality score multiplier (0.8x--1.0x) boosts higher-quality OCR results
- **Chunk-level filters** -- `content_type_filter`, `section_path_filter` (prefix match), `heading_filter` (LIKE), `page_range_filter`, `quality_boost`, `table_columns_contain`
- **Metadata filters** -- title/author/subject LIKE matching, document ID filtering, cluster filtering, quality score threshold
- **VLM image enrichment** -- search results from VLM descriptions include image metadata (path, dimensions, type)
- **Table metadata** -- search results include table column headers and row/column counts from OCR blocks
- **Context chunks** -- surrounding chunks automatically included with results for broader context
- **Group by document** -- deduplicate results by document, returning only the best match per document (`group_by_document`)
- **Header/footer exclusion** -- header/footer chunks auto-tagged during ingestion and excluded from search by default (`include_headers_footers`)
- **Document context** -- optionally attach cluster labels and comparison info to results (`include_document_context`)
- **Provenance inclusion** -- attach full provenance chain to each search result
- **Search persistence** -- save, list, retrieve, and re-execute named searches
- **Cross-database search** -- BM25 search across all databases simultaneously

### Provenance Chain

Every artifact carries a SHA-256 hash chain back to its source document:

```
DOCUMENT (depth 0)
  +-- OCR_RESULT (depth 1)
  |     +-- CHUNK (depth 2) -> EMBEDDING (depth 3)
  |     +-- IMAGE (depth 2) -> VLM_DESCRIPTION (depth 3) -> EMBEDDING (depth 4)
  |     +-- EXTRACTION (depth 2) -> EMBEDDING (depth 3)
  +-- FORM_FILL (depth 0)
  +-- COMPARISON (depth 2)
  +-- CLUSTERING (depth 2)
```

Export in JSON, W3C PROV-JSON, or CSV for regulatory compliance. Query provenance with 12+ filters, view processing timelines, and analyze per-processor statistics.

### Document Version Tracking

When you re-ingest a file, the system detects changes automatically:

- **Same hash** -- skip (already processed)
- **Different hash** -- creates a new version linked to the previous via `previous_version_id`
- **Version history** -- retrieve all versions of a document ordered by creation date

### Document Workflow

Tag-based workflow state management for document lifecycle:

- **States:** draft, review, approved, published, archived
- **History:** every state change is preserved (append-only)
- **Actions:** get current state, set new state, view full state history

---

## Requirements

| Requirement | Details |
|-------------|---------|
| [Docker Desktop](https://docker.com/products/docker-desktop) | Required. Available for Windows, macOS, and Linux |
| [Node.js](https://nodejs.org/) >= 20 | Required for the install command |
| `DATALAB_API_KEY` | Get from [datalab.to](https://www.datalab.to) -- OCR, form fill, structured extraction |
| `GEMINI_API_KEY` | Get from [Google AI Studio](https://aistudio.google.com/) -- VLM image description |

No Python install, no GPU drivers, no model downloads needed -- the Docker image bundles everything.

---

## Installation

```bash
npm install -g ocr-provenance-mcp
ocr-provenance-mcp-setup
```

The setup wizard will:

1. Prompt for your **Datalab** and **Gemini** API keys (masked input)
2. Validate both keys against the real APIs
3. Pull the Docker image (~6GB, includes Python, PyTorch, and the embedding model)
4. Register the server with your AI client (Claude Code, Claude Desktop, Cursor, VS Code, or Windsurf)
5. Verify the server starts and responds

That's it. After setup completes, restart your AI client and the `ocr-provenance` MCP server will be available.

### What Gets Installed Where

| Item | Location |
|------|----------|
| npm package | Global `node_modules` (the `ocr-provenance-mcp` command) |
| API keys | `~/.ocr-provenance/.env` (file permissions 0600) |
| Docker image | `ocr-provenance-mcp:cpu` (~6GB, pulled from GHCR) |
| Databases | Docker volume `ocr-data` (persists across container restarts) |
| Client config | Depends on your client (see below) |

### Platform Differences

**Windows:**
- Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) -- requires WSL2 backend
- Config files use `%APPDATA%` paths (e.g., `%APPDATA%\Claude\claude_desktop_config.json`)
- The setup wizard auto-detects Windows paths

**macOS:**
- Install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) -- works on both Intel and Apple Silicon
- Config files use `~/Library/Application Support/` paths
- The setup wizard auto-detects macOS paths

**Linux:**
- Install [Docker Engine](https://docs.docker.com/engine/install/) or Docker Desktop
- Ensure your user is in the `docker` group: `sudo usermod -aG docker $USER`
- Config files use `~/.config/` or `~/` paths depending on the client

### Client Config Locations

The setup wizard writes the config automatically. If you need to edit manually:

| Client | Config File |
|--------|-------------|
| Claude Code | Run: `claude mcp add ocr-provenance ...` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` (per-project) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

### Environment Variables

These are set automatically by the Docker image. Override via `-e` flags if needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATALAB_API_KEY` | (required) | Datalab OCR API key |
| `GEMINI_API_KEY` | (required) | Google Gemini API key |
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_HTTP_PORT` | `3100` | HTTP server port (when using `http` transport) |
| `EMBEDDING_DEVICE` | `cpu` | Embedding device: `cpu`, `cuda`, `mps` |
| `OCR_PROVENANCE_DATABASES_PATH` | `/data` | Database storage path inside container |
| `OCR_PROVENANCE_ALLOWED_DIRS` | `/host,/data` | Allowed directories for file access |

### Backup and Restore

Your databases live in the `ocr-data` Docker volume and persist across container restarts.

```bash
# Backup all databases to ./backup/
docker run --rm -v ocr-data:/data:ro -v $(pwd)/backup:/backup alpine cp -a /data/. /backup/

# Restore from ./backup/
docker run --rm -v ocr-data:/data -v $(pwd)/backup:/backup:ro alpine cp -a /backup/. /data/
```

### HTTP Mode (Remote/Shared Deployment)

For remote or multi-user deployments, run the server in HTTP mode:

```bash
docker compose up -d          # CPU mode
docker compose -f docker-compose.gpu.yml up -d   # GPU mode (NVIDIA CUDA)
```

Health endpoint: `GET /health` -- MCP endpoint: `POST /mcp` -- Port: 3100

---

## Configuration

API keys are stored at `~/.ocr-provenance/.env` (created by the setup wizard). All other settings can be changed at runtime via the `ocr_config_set` tool or by passing environment variables to the Docker container.

| Setting | Default | Description |
|---------|---------|-------------|
| `DATALAB_DEFAULT_MODE` | `accurate` | OCR mode: `fast`, `balanced`, or `accurate` |
| `DATALAB_MAX_CONCURRENT` | `3` | Max concurrent OCR API requests |
| `EMBEDDING_DEVICE` | `cpu` | `cpu`, `cuda`, or `mps` (auto-detected in Docker) |
| `EMBEDDING_BATCH_SIZE` | `512` | Batch size for embedding generation |
| `CHUNKING_SIZE` | `2000` | Target chunk size in characters |
| `CHUNKING_OVERLAP_PERCENT` | `10` | Overlap between chunks |
| `AUTO_CLUSTER_ENABLED` | `false` | Auto-cluster after processing |
| `AUTO_CLUSTER_THRESHOLD` | `5` | Minimum documents to trigger auto-clustering |
| `AUTO_CLUSTER_ALGORITHM` | `hdbscan` | `hdbscan`, `agglomerative`, or `kmeans` |

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

**Processing options:** `ocr_mode` (fast/balanced/accurate), `chunking_strategy` (hybrid section-aware), `page_range`, `max_pages`, `extras` (track_changes, chart_understanding, extract_links, table_row_bboxes, infographic, new_block_types)

**Version tracking:** Re-ingesting a file with a different hash creates a new version linked via `previous_version_id`.

</details>

<details>
<summary><strong>Search & Retrieval (7)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_search` | Unified search -- `mode`: `keyword` (BM25), `semantic` (vector), or `hybrid` (default, recommended) |
| `ocr_rag_context` | Assemble hybrid search results into a markdown context block for LLMs |
| `ocr_search_export` | Export results to CSV or JSON |
| `ocr_fts_manage` | Rebuild or check FTS5 index status |
| `ocr_search_saved` | Save, list, get, or execute named searches (`action`: save/list/get/execute) |
| `ocr_search_cross_db` | BM25 search across all databases simultaneously |
| `ocr_benchmark_compare` | Compare search results across databases |

**Enhancement options:** Local cross-encoder reranking (`rerank`), query expansion (`expand_query`), auto-routing (`auto_route`), quality-weighted ranking, chunk-level filters (content type, section path, heading, page range, table columns), metadata filters, cluster filtering, group by document, header/footer exclusion, context chunks, VLM image enrichment, provenance inclusion, compact mode (77% token reduction).

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
| `ocr_vlm_describe` | Describe an image using Gemini 3 Flash (supports thinking mode) |
| `ocr_vlm_classify` | Classify image type, complexity, text density |
| `ocr_vlm_process_document` | VLM-process all images in a document |
| `ocr_vlm_process_pending` | VLM-process all pending images across all documents |
| `ocr_vlm_analyze_pdf` | Analyze a PDF directly with Gemini 3 Flash (max 20MB) |
| `ocr_vlm_status` | Service status (API config, rate limits, circuit breaker) |

VLM descriptions automatically generate searchable embeddings for semantic image search.

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
| `ocr_image_search` | Search images with 7 filters (type, size, status, confidence, etc.) |
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
| `ocr_document_page` | Get all chunks for a specific page number (page-by-page navigation) |

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
| `ocr_extract_structured` | Extract structured data from OCR'd documents using a JSON schema |
| `ocr_extraction_list` | List structured extractions for a document |
| `ocr_extraction_get` | Get a structured extraction by ID |
| `ocr_extraction_search` | Search across extraction content |

</details>

<details>
<summary><strong>Form Fill (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_form_fill` | Fill PDF/image forms via Datalab with field name-value mapping |
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
| `ocr_guide` | AI agent navigation -- inspects system state and recommends next tools/actions |
| `ocr_document_tables` | Extract and parse tables from OCR JSON blocks |
| `ocr_document_recommend` | Get related document recommendations via embedding similarity |
| `ocr_document_extras` | Access OCR extras data (charts, links, tracked changes, infographics) |

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
| `ocr_evaluation_report` | Comprehensive OCR + VLM metrics report (markdown) |
| `ocr_document_report` | Single document report (images, extractions, comparisons, clusters) |
| `ocr_quality_summary` | Quality summary across all documents |
| `ocr_cost_summary` | Cost analytics by document, mode, month, or total |
| `ocr_pipeline_analytics` | Pipeline throughput, duration, per-mode/type breakdown |
| `ocr_corpus_profile` | Corpus content profile (doc sizes, content types, section frequency) |
| `ocr_error_analytics` | Error/recovery analytics and failure rates |
| `ocr_provenance_bottlenecks` | Processing bottleneck analysis by processor |
| `ocr_quality_trends` | Quality trends over time (hourly/daily/weekly/monthly) |

</details>

<details>
<summary><strong>Timeline & Analytics (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_timeline_analytics` | Volume metrics over time |
| `ocr_throughput_analytics` | Processing throughput per time bucket |

</details>

<details>
<summary><strong>Health & Diagnostics (1)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_health_check` | Detect data integrity gaps (missing embeddings, orphaned chunks, etc.) with optional auto-fix |

</details>

<details>
<summary><strong>Configuration (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_config_get` | Get current system configuration |
| `ocr_config_set` | Update configuration at runtime |

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
| `ocr_compliance_export` | Export provenance chain with PROV-AGENT metadata and chain-hash verification |

</details>

---

## Processing Pipeline

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
  │                  ├─ extras_json (charts, links, track changes)
  │                  ├─ page_offsets (page boundaries)
  │                  └─ provenance record (type: OCR_RESULT, depth: 1)
  │
  ├─ 3. CHUNK ────► chunks table
  │                  ├─ Hybrid section-aware chunking
  │                  │   ├─ Text + heading normalization
  │                  │   ├─ Markdown structure parsing
  │                  │   ├─ Atomic region detection (tables, figures)
  │                  │   ├─ Heading-only chunk merging
  │                  │   ├─ Near-duplicate deduplication
  │                  │   └─ Header/footer auto-tagging
  │                  ├─ 2000 chars with 10% overlap
  │                  ├─ section_path, heading_context, content_types
  │                  ├─ page_number assignment via page separators
  │                  └─ provenance records (type: CHUNK, depth: 2)
  │
  ├─ 4. EMBED ────► embeddings + vec_embeddings tables
  │                  ├─ Nomic embed v1.5 (768-dim, local GPU)
  │                  ├─ "search_document: " prefix
  │                  └─ provenance records (type: EMBEDDING, depth: 3)
  │
  ├─ 5. FTS ──────► fts_index (FTS5 virtual table)
  │                  └─ External content index on chunk text
  │
  ├─ 6. IMAGES ───► images table
  │   │              ├─ PyMuPDF extraction (PDF) / zip extraction (DOCX)
  │   │              ├─ Image optimization (resize, format)
  │   │              └─ provenance records (type: IMAGE, depth: 2)
  │   │
  │   └─ 7. VLM ──► images updated + embeddings table
  │                  ├─ Gemini 3 Flash multimodal analysis
  │                  ├─ Description, structured data, confidence
  │                  ├─ VLM description embedding generated (searchable)
  │                  └─ provenance records (type: VLM_DESCRIPTION, depth: 3→4)
  │
  ├─ 8. AUTO-CLUSTER ──► clusters table (when configured)
  │                  └─ Triggers when threshold met and >1hr since last run
  │
  └─ documents.status = 'complete'
```

---

## Data Architecture (Schema v32)

28 core tables + FTS5 virtual tables + vec_embeddings:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `documents` | Source files | file_hash, status, page_count, metadata |
| `ocr_results` | Extracted text | extracted_text, json_blocks, quality_score, cost |
| `chunks` | Text segments | text (2000 chars), section_path, heading_context, content_types |
| `embeddings` | 768-dim vectors | original_text, model_name, source metadata |
| `images` | Extracted images | extracted_path, bbox, VLM description, confidence |
| `extractions` | Structured data | schema_json, extraction_json |
| `form_fills` | Form filling results | field mapping, output path |
| `comparisons` | Document pair diffs | similarity_ratio, diff_operations |
| `clusters` | Document groupings | label, classification_tag, coherence_score |
| `document_clusters` | Cluster membership | document_id, cluster_id |
| `provenance` | Full audit trail | type, processor, chain_depth, content_hash, chain_hash |
| `tags` | Cross-entity labels | name, color, description |
| `entity_tags` | Tag associations | tag_id, entity_type, entity_id |
| `saved_searches` | Search persistence | name, search_type, parameters |
| `uploaded_files` | Cloud file tracking | datalab_id, file_hash, upload status |
| `database_metadata` | DB-level settings | key-value pairs |
| `schema_version` | Migration tracking | version, applied_at |
| `fts_index_metadata` | FTS index state | last_rebuild, chunk count |
| `users` | Multi-user accounts | display_name, email, role (viewer/reviewer/editor/admin) |
| `audit_log` | User action audit trail | user_id, action, entity_type, details |
| `annotations` | Document annotations | type (comment/suggestion/highlight), threaded replies |
| `document_locks` | Collaborative locking | exclusive/shared, auto-expiry |
| `workflow_states` | Document lifecycle | state machine (draft→submitted→approved→executed) |
| `approval_chains` | Multi-step approvals | ordered approval steps with decisions |
| `approval_steps` | Individual approval steps | approver, decision, comments |
| `obligations` | Contract obligations | title, due_date, status, extracted from CLM |
| `playbooks` | Clause comparison playbooks | name, clauses, comparison templates |
| `webhooks` | Event notifications | url, events, HMAC-SHA256 signing |

---

## AI/ML Capabilities

| Capability | Technology | Tool(s) |
|-----------|-----------|---------|
| Document OCR | Datalab API (3 modes) | `ocr_process_pending`, `ocr_convert_raw` |
| Text Embeddings | Nomic embed v1.5 (local GPU) | Auto during ingestion, `ocr_reembed_document` |
| Image Description | Gemini 3 Flash | `ocr_vlm_describe`, `ocr_vlm_process_*` |
| Search Reranking | Python cross-encoder (local) | `rerank` parameter on search (ms-marco-MiniLM-L-12-v2, no API) |
| Query Expansion | Heuristic synonyms | `expand_query` parameter |
| Query Classification | Heuristic patterns | `auto_route` parameter (hybrid search) |
| Document Clustering | scikit-learn | `ocr_cluster_documents` (HDBSCAN/agglomerative/k-means) |
| Auto-Clustering | scikit-learn | Configurable auto-trigger after `ocr_process_pending` |
| Similarity Detection | Embedding centroids | `ocr_document_find_similar`, `ocr_document_recommend` |
| Duplicate Detection | File hash + embedding similarity | `ocr_document_duplicates` |
| Comparison Discovery | Embedding similarity | `ocr_comparison_discover` |
| Comparison Matrix | Pairwise cosine similarity | `ocr_comparison_matrix` |
| Text Comparison | npm diff (Sorensen-Dice) | `ocr_document_compare` |
| RAG Context Assembly | Hybrid search + markdown | `ocr_rag_context` |
| Semantic Image Search | VLM description embeddings | `ocr_image_semantic_search` |
| PDF Direct Analysis | Gemini 3 Flash multimodal | `ocr_vlm_analyze_pdf` |
| Table Extraction | OCR JSON block parsing | `ocr_document_tables` |
| Cross-DB Search | BM25 across all databases | `ocr_search_cross_db` |
| Chunk Deduplication | Fuzzy text matching | Automatic during chunking pipeline |
| AI Agent Navigation | System state analysis | `ocr_guide` |
| Health Diagnostics | Data integrity analysis | `ocr_health_check` |

---

## Development

```bash
npm run build             # Build TypeScript
npm test                  # All tests (2,639 across 115 test suites)
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
npm run lint:all          # TypeScript + Python linting
npm run check             # typecheck + lint + test
```

### Project Structure

```
src/
  index.ts              # MCP server entry point (tool registration, lifecycle)
  bin.ts                # CLI entry point
  tools/                # 28 tool files + shared.ts
    database.ts         # Database CRUD (5 tools)
    ingestion.ts        # Ingest + process pipeline (9 tools)
    search.ts           # Unified search, RAG, cross-DB (7 tools)
    documents.ts        # Document ops, versions, workflow (12 tools)
    provenance.ts       # Audit trail, verification (6 tools)
    comparison.ts       # Diff, batch compare, matrix (6 tools)
    clustering.ts       # Cluster, reassign, merge (7 tools)
    vlm.ts              # Gemini vision analysis (6 tools)
    images.ts           # Image ops, semantic search (11 tools)
    reports.ts          # Analytics + quality reports (9 tools)
    tags.ts             # Cross-entity tagging (6 tools)
    intelligence.ts     # AI guide, tables, recommendations, extras (4 tools)
    embeddings.ts       # Embedding management (4 tools)
    extraction-structured.ts  # JSON schema extraction (4 tools)
    extraction.ts       # Local image extraction (3 tools)
    file-management.ts  # Cloud file ops (6 tools)
    chunks.ts           # Chunk inspection + page navigation (4 tools)
    timeline.ts         # Time-series analytics (2 tools)
    form-fill.ts        # PDF form filling (2 tools)
    evaluation.ts       # VLM evaluation (3 tools)
    config.ts           # Runtime config (2 tools)
    health.ts           # Data integrity check (1 tool)
    users.ts            # User management + RBAC (2 tools)
    collaboration.ts    # Annotations, locking, search alerts (11 tools)
    workflow.ts         # State machine, approval chains (8 tools)
    events.ts           # Webhooks, event subscriptions (6 tools)
    clm.ts              # Contract lifecycle management (9 tools)
    compliance.ts       # HIPAA/SOC2/SOX exports, chain-hash verification (3 tools)
    shared.ts           # Shared utilities (formatResponse, handleError, etc.)
  services/             # Core services (11 domains, 64 files)
    chunking/           # Hybrid section-aware chunking pipeline
      chunker.ts        # Main chunking orchestrator
      markdown-parser.ts
      heading-normalizer.ts
      text-normalizer.ts
      chunk-merger.ts
      chunk-deduplicator.ts
      json-block-analyzer.ts
    search/             # BM25, semantic, hybrid, fusion, reranker (AI + local), query expansion/classification, quality weighting
    gemini/             # Gemini client with caching, circuit breaker, rate limiting
    storage/            # SQLite database + migrations (19 operation files)
    ...                 # OCR, embedding, VLM, provenance, comparison, clustering, images
  models/               # Zod schemas and TypeScript types
  utils/                # Hash, validation, path sanitization
  server/               # Server state, types, errors (14 custom error classes)
python/                 # 9 Python workers + GPU utils
tests/
  unit/                 # Unit tests
  integration/          # Integration tests
  e2e/                  # End-to-end pipeline tests
  manual/               # Verification tests
  benchmark/            # Chunking benchmark
  fixtures/             # Test fixtures and sample documents
docs/                   # System documentation and reports
```

### Key Metrics

| Metric | Value |
|--------|-------|
| MCP tools | 141 |
| Tool modules | 28 |
| Database tables | 28 core + FTS + vec |
| Schema version | v32 (32 migrations) |
| Database operation files | 19 |
| Service domains | 11 |
| Test suites | 115 |
| Tests passing | 2,639 |
| TypeScript source | ~46,000 lines |
| Python source | ~4,700 lines |
| Test code | ~65,000 lines |
| Production deps | 9 packages |
| Python workers | 9 |
| External APIs | 3 (Datalab, Gemini, Nomic local) |
| Custom error classes | 14 |
| File types supported | 18 |

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
<summary><strong>Data integrity issues</strong></summary>

Run `ocr_health_check { fix: true }` to detect and auto-fix common issues like chunks missing embeddings or orphaned records.
</details>

<details>
<summary><strong>GPU acceleration in Docker</strong></summary>

The default image uses CPU. For GPU, rebuild with CUDA support:
```bash
docker build --build-arg COMPUTE=cu124 \
  --build-arg RUNTIME_BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
  -t ocr-provenance-mcp:gpu .
```
Or use `docker compose -f docker-compose.gpu.yml up -d`.
</details>

---

## License

This project uses a **dual-license** model:

- **Free for non-commercial use** -- personal projects, academic research, education, non-profits, evaluation, and contributions to this project are all permitted at no cost.
- **Commercial license required for revenue-generating use** -- if you use this software to make money (paid services, SaaS, internal tools at for-profit companies, etc.), you must obtain a commercial license from the copyright holder. Terms are negotiated case-by-case and may include revenue sharing or flat-rate arrangements.

See [LICENSE](LICENSE) for full details. For commercial licensing inquiries, contact Chris Royse at [chrisroyseai@gmail.com](mailto:chrisroyseai@gmail.com) or via [GitHub](https://github.com/ChrisRoyse).
