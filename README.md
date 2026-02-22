# OCR Provenance MCP Server

**Turn thousands of documents into a searchable, AI-queryable knowledge base -- with full provenance.**

Point this at a folder of PDFs, Word docs, spreadsheets, images, or presentations. Minutes later, Claude can search, analyze, compare, and answer questions across your entire document collection -- with a cryptographic audit trail proving exactly where every answer came from.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple)](https://modelcontextprotocol.io/)
[![Tools](https://img.shields.io/badge/MCP_Tools-127-orange)](#tool-reference-127-tools)
[![Tests](https://img.shields.io/badge/Tests-2%2C382_passing-brightgreen)](#development)

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
5. Search                    ->  ocr_search_hybrid { query: "breach of contract" }
6. Ask questions             ->  ocr_rag_context { question: "What were the settlement terms?" }
7. Verify provenance         ->  ocr_provenance_verify { item_id: "doc-id" }
```

Each database is fully isolated. Create one per case, project, or client.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server (stdio)                        │
│  TypeScript + @modelcontextprotocol/sdk                     │
│  127 tools across 22 tool modules                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Ingestion│  │  Search  │  │ Analysis │  │  Reports │   │
│  │ 9 tools  │  │ 12 tools │  │ 37 tools │  │  9 tools │   │
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
│  │ 18 tbls │   │ vectors  │   │ indexes  │                  │
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

- **TypeScript MCP Server** -- 127 tools across 22 modules, Zod validation, provenance tracking
- **Python Workers** (9) -- OCR, GPU embedding, image extraction, clustering, form fill, file management, local reranking
- **SQLite + sqlite-vec** -- 18 tables, FTS5 full-text search, vector similarity search, WAL mode
- **Gemini 3 Flash** -- vision analysis, search re-ranking, query expansion, document classification, cluster labeling, schema suggestion
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
| **Hybrid** (recommended) | General questions | BM25 + semantic fused, optional Gemini re-ranking |

#### Search Enhancement Stack

All three search modes support a shared enhancement stack:

- **Query classification** -- heuristic analysis auto-routes queries between exact/semantic/mixed modes (`auto_route` on hybrid)
- **Query expansion** -- legal/medical synonym injection for broader recall (`expand_query`, default on for hybrid)
- **Gemini AI re-ranking** -- re-scores results using Gemini 3 Flash for relevance (`rerank`)
- **Local reranking** -- Python-based cross-encoder reranker for fast local re-scoring without API calls
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

| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | >= 20 | MCP server runtime |
| Python | >= 3.10 | Worker processes |
| PyTorch | >= 2.0 | Embedding model inference |
| GPU | Optional | CUDA or Apple MPS; CPU works fine, just slower |

### API Keys

| Key | Get From | Used For |
|-----|----------|----------|
| `DATALAB_API_KEY` | [datalab.to](https://www.datalab.to) | OCR, form fill, file upload, structured extraction |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/) | Vision analysis, re-ranking, classification, labeling |

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
ocr-provenance-mcp  # Should print "Tools registered: 127" on stderr
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

# Auto-clustering (triggers after processing when enabled)
AUTO_CLUSTER_ENABLED=false
AUTO_CLUSTER_THRESHOLD=5               # Minimum documents to trigger
AUTO_CLUSTER_ALGORITHM=hdbscan

# Storage
STORAGE_DATABASES_PATH=~/.ocr-provenance/databases/
```

---

## Tool Reference (127 Tools)

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
<summary><strong>Search & Retrieval (12)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_search` | BM25 full-text search (exact terms, codes, IDs) |
| `ocr_search_semantic` | Vector similarity search (conceptual queries) |
| `ocr_search_hybrid` | Reciprocal Rank Fusion of BM25 + semantic (recommended) |
| `ocr_rag_context` | Assemble hybrid search results into a markdown context block for LLMs |
| `ocr_search_export` | Export results to CSV or JSON |
| `ocr_benchmark_compare` | Compare search results across databases |
| `ocr_fts_manage` | Rebuild or check FTS5 index status |
| `ocr_search_save` | Save a search by name for later retrieval |
| `ocr_search_saved_list` | List all saved searches |
| `ocr_search_saved_get` | Retrieve a saved search and its parameters |
| `ocr_search_saved_execute` | Re-execute a saved search with optional parameter overrides |
| `ocr_search_cross_db` | BM25 search across all databases simultaneously |

**Enhancement options:** Gemini re-ranking (`rerank`), local reranking, query expansion (`expand_query`), auto-routing (`auto_route`), quality-weighted ranking, chunk-level filters (content type, section path, heading, page range, table columns), metadata filters, cluster filtering, group by document, header/footer exclusion, context chunks, VLM image enrichment, provenance inclusion.

</details>

<details>
<summary><strong>Document Management (13)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_document_list` | List documents with status filtering |
| `ocr_document_get` | Full document details (text, chunks, blocks, provenance) |
| `ocr_document_delete` | Delete document and all derived data (cascade) |
| `ocr_document_find_similar` | Find similar documents via embedding centroid similarity |
| `ocr_document_classify` | AI classification using Gemini (type, domain, topics) |
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
<summary><strong>Document Clustering (8)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_cluster_documents` | Cluster by semantic similarity (HDBSCAN / agglomerative / k-means) |
| `ocr_cluster_list` | List clusters with filtering by run ID or tag |
| `ocr_cluster_get` | Cluster details with member documents |
| `ocr_cluster_assign` | Auto-assign a document to the nearest cluster |
| `ocr_cluster_label` | Auto-label cluster using Gemini AI |
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
<summary><strong>Structured Extraction (5)</strong></summary>

| Tool | Description |
|------|-------------|
| `ocr_extract_structured` | Extract structured data from OCR'd documents using a JSON schema |
| `ocr_extraction_list` | List structured extractions for a document |
| `ocr_extraction_get` | Get a structured extraction by ID |
| `ocr_extraction_search` | Search across extraction content |
| `ocr_suggest_extraction_schema` | AI-suggested extraction schema based on document content (Gemini) |

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

## Data Architecture (Schema v31)

18 core tables + FTS5 virtual tables + vec_embeddings:

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
| `provenance` | Full audit trail | type, processor, chain_depth, content_hash |
| `tags` | Cross-entity labels | name, color, description |
| `entity_tags` | Tag associations | tag_id, entity_type, entity_id |
| `saved_searches` | Search persistence | name, search_type, parameters |
| `uploaded_files` | Cloud file tracking | datalab_id, file_hash, upload status |
| `database_metadata` | DB-level settings | key-value pairs |
| `schema_version` | Migration tracking | version, applied_at |
| `fts_index_metadata` | FTS index state | last_rebuild, chunk count |

---

## AI/ML Capabilities

| Capability | Technology | Tool(s) |
|-----------|-----------|---------|
| Document OCR | Datalab API (3 modes) | `ocr_process_pending`, `ocr_convert_raw` |
| Text Embeddings | Nomic embed v1.5 (local GPU) | Auto during ingestion, `ocr_reembed_document` |
| Image Description | Gemini 3 Flash | `ocr_vlm_describe`, `ocr_vlm_process_*` |
| Image Classification | Gemini 3 Flash | `ocr_vlm_classify` |
| Document Classification | Gemini 3 Flash | `ocr_document_classify` |
| Search Reranking (AI) | Gemini 3 Flash | `rerank` parameter on all search tools |
| Search Reranking (Local) | Python cross-encoder | Local reranker worker (no API calls) |
| Query Expansion | Heuristic synonyms | `expand_query` parameter |
| Query Classification | Heuristic patterns | `auto_route` parameter (hybrid search) |
| Cluster Auto-Labeling | Gemini 3 Flash | `ocr_cluster_label` |
| Schema Suggestion | Gemini 3 Flash | `ocr_suggest_extraction_schema` |
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
npm test                  # All tests (2,382 across 109 test suites)
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
  tools/                # 22 tool files + shared.ts
    database.ts         # Database CRUD (5 tools)
    ingestion.ts        # Ingest + process pipeline (9 tools)
    search.ts           # BM25, semantic, hybrid, RAG, cross-DB (12 tools)
    documents.ts        # Document ops, versions, workflow (13 tools)
    provenance.ts       # Audit trail, verification (6 tools)
    comparison.ts       # Diff, batch compare, matrix (6 tools)
    clustering.ts       # Cluster, label, merge (8 tools)
    vlm.ts              # Gemini vision analysis (6 tools)
    images.ts           # Image ops, semantic search (11 tools)
    reports.ts          # Analytics + quality reports (9 tools)
    tags.ts             # Cross-entity tagging (6 tools)
    intelligence.ts     # AI guide, tables, recommendations, extras (4 tools)
    embeddings.ts       # Embedding management (4 tools)
    extraction-structured.ts  # JSON schema extraction (5 tools)
    extraction.ts       # Local image extraction (3 tools)
    file-management.ts  # Cloud file ops (6 tools)
    chunks.ts           # Chunk inspection + page navigation (4 tools)
    timeline.ts         # Time-series analytics (2 tools)
    form-fill.ts        # PDF form filling (2 tools)
    evaluation.ts       # VLM evaluation (3 tools)
    config.ts           # Runtime config (2 tools)
    health.ts           # Data integrity check (1 tool)
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
| MCP tools | 127 |
| Tool modules | 22 |
| Database tables | 18 core + FTS + vec |
| Schema version | v31 (31 migrations) |
| Database operation files | 19 |
| Service domains | 11 |
| Test suites | 109 |
| Tests passing | 2,382 |
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

<details>
<summary><strong>Data integrity issues</strong></summary>

Run `ocr_health_check { fix: true }` to detect and auto-fix common issues like chunks missing embeddings or orphaned records.
</details>

---

## License

[MIT](LICENSE)
