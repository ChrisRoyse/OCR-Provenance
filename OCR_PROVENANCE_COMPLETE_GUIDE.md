# OCR Provenance MCP Server: Complete System Guide

## Table of Contents

1. [What This System Is](#what-this-system-is)
2. [What It Can Do](#what-it-can-do)
3. [Setup & Connection](#setup--connection)
4. [Tool Inventory (111 Tools)](#tool-inventory-111-tools)
5. [Controlling the AI Agent](#controlling-the-ai-agent)
6. [Core Workflows](#core-workflows)
7. [Use Cases](#use-cases)
8. [Case Study: 13,688 Commercial Driver Logs](#case-study-13688-commercial-driver-logs)
9. [Performance & Scaling](#performance--scaling)
10. [Configuration Reference](#configuration-reference)

---

## What This System Is

OCR Provenance is a **Model Context Protocol (MCP) server** that gives AI agents (Claude, etc.) the ability to ingest, OCR, search, analyze, compare, cluster, and reason over large document collections -- all with **cryptographic audit trails** proving exactly where every piece of data came from.

| Attribute | Value |
|-----------|-------|
| **MCP Tools** | 111 |
| **Schema Version** | 31 |
| **Architecture** | TypeScript MCP server + 9 Python workers |
| **Storage** | SQLite + sqlite-vec (vectors) + FTS5 (full-text) |
| **Embedding Model** | nomic-embed-text-v1.5 (local GPU, 768-dim) |
| **VLM Model** | Gemini 3 Flash (image analysis only) |
| **OCR Engine** | Datalab API (PDF, DOCX, images, presentations) |
| **Reranking** | Local cross-encoder (ms-marco-MiniLM-L-12-v2) |
| **Tests** | 2,344 passing across 109 test files |

The system runs entirely locally (except for Datalab OCR API calls and Gemini VLM calls). Embeddings, search, reranking, clustering, and all database operations are local.

---

## What It Can Do

### Document Ingestion & Processing
- **Ingest 18 file types**: PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, PNG, JPG, JPEG, TIFF, TIF, BMP, GIF, WEBP, TXT, CSV, MD
- **Three OCR accuracy modes**: fast, balanced, accurate
- **Automatic pipeline**: Ingest -> OCR -> Chunk -> Embed -> Index (FTS + vector) -> Optional VLM + Clustering
- **Version tracking**: Re-ingesting a file detects changes by hash comparison
- **Concurrent processing**: Configurable parallel OCR jobs (1-10)

### Search & Retrieval
- **Unified search** with three modes in one tool:
  - **Keyword (BM25)**: Exact terms, case numbers, names, codes via FTS5
  - **Semantic**: Meaning-based vector similarity via nomic embeddings
  - **Hybrid** (recommended): RRF fusion of both with auto-routing
- **Always-on intelligence**: Quality-weighted ranking, query expansion, deduplication, header/footer exclusion
- **Local reranking**: Cross-encoder model (no API calls) for precision
- **Rich filtering**: By page range, section path, heading, content type, document metadata, cluster, quality score
- **Cross-database search**: BM25 across all databases simultaneously
- **RAG context assembly**: Pre-formatted markdown blocks for LLM injection

### Document Analysis
- **Structure analysis**: Headings, tables, figures, code blocks, lists, complexity scoring
- **Table extraction**: Parse structured table data (cells, rows, columns)
- **Page-by-page navigation**: View all chunks on any page
- **Document profiles**: has_tables, has_figures, has_code, density metrics
- **Extras access**: Charts, links, tracked changes, infographics from OCR

### Document Comparison
- **Text diff**: Line-by-line comparison with Sorensen-Dice similarity ratio
- **Structural diff**: Compare heading/table/figure structure
- **Batch comparison**: Multiple pairs in one call
- **Discovery**: Auto-find similar document pairs before comparing
- **NxN similarity matrix**: Pairwise cosine similarity across documents

### Document Clustering
- **Three algorithms**: HDBSCAN (auto k), agglomerative, k-means
- **Auto-clustering**: Triggers after processing when threshold met
- **Cluster management**: Reassign, merge, delete clusters
- **Embedding-based**: Uses average chunk embeddings per document

### Vision Language Model (VLM)
- **Image description**: Gemini 3 Flash analyzes extracted images
- **Batch processing**: Process all images in a document or system-wide
- **Direct PDF analysis**: Send PDF to Gemini for multimodal analysis
- **Custom prompts**: Re-analyze images with specific questions
- **VLM text in search**: Extracted text from images is searchable via FTS

### Provenance (Audit Trail)
- **Cryptographic chain**: SHA-256 hashes at every processing step
- **Full lineage**: DOCUMENT -> OCR_RESULT -> CHUNK -> EMBEDDING (4 depth levels)
- **Verification**: Re-hash and validate the entire chain for any item
- **W3C PROV export**: Standard provenance format for compliance
- **12+ query filters**: By processor, type, depth, quality, date, document
- **Timeline view**: Processing duration at every step

### Structured Extraction
- **Schema-based extraction**: Define JSON schema, extract matching data from OCR text
- **Search extractions**: Full-text search within extracted structured data
- **Form filling**: Fill PDF/image forms programmatically via Datalab

### Tagging & Workflow
- **Cross-entity tags**: Apply to documents, chunks, images, extractions, clusters
- **Tag search**: Find entities by tag (match all or any)
- **Workflow states**: draft/review/approved/published/archived with history
- **Color-coded tags**: Visual organization with descriptions

### Reporting & Analytics
- **Quality reports**: OCR quality distribution, trends over time
- **Performance reports**: Pipeline throughput, bottleneck analysis
- **Cost analytics**: Spending by document, mode, month
- **Error analytics**: Failure rates, common error patterns
- **Timeline analytics**: Volume trends (hourly/daily/weekly/monthly)
- **Health checks**: Detect and auto-fix missing embeddings, orphaned data

### Multi-Database Isolation
- **Independent databases**: One per case, project, or client
- **Full isolation**: Each database has its own schema, indexes, vectors
- **Easy switching**: Select database, all tools operate on it
- **Cross-database search**: BM25 across all databases without switching
- **Storage location**: `~/.ocr-provenance/databases/{name}/`

---

## Setup & Connection

### Prerequisites

```bash
# Node.js 20+, Python 3.10+, npm
node --version   # v20+
python3 --version # 3.10+
```

### Installation

```bash
npm install
npm run build
```

### Environment Variables

Create a `.env` file:

```bash
# Required
DATALAB_API_KEY=your_datalab_key        # From datalab.to
GEMINI_API_KEY=your_gemini_key          # From Google AI Studio

# Optional
DATALAB_DEFAULT_MODE=balanced           # fast | balanced | accurate
DATALAB_MAX_CONCURRENT=3               # Parallel OCR jobs (1-10)
EMBEDDING_DEVICE=auto                   # auto | cuda | mps | cpu
EMBEDDING_BATCH_SIZE=512               # GPU batch size
CHUNKING_SIZE=2000                     # Characters per chunk
CHUNKING_OVERLAP_PERCENT=10            # Overlap between chunks
AUTO_CLUSTER_ENABLED=false             # Auto-cluster after processing
AUTO_CLUSTER_THRESHOLD=10             # Min docs to trigger
AUTO_CLUSTER_ALGORITHM=hdbscan        # hdbscan | agglomerative | kmeans
STORAGE_DATABASES_PATH=~/.ocr-provenance/databases/
```

### Connecting to Claude Code

```bash
claude mcp add ocr-provenance -s user \
  -e OCR_PROVENANCE_ENV_FILE=/absolute/path/to/.env \
  -- ocr-provenance-mcp
```

### Connecting to Claude Desktop

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "ocr-provenance": {
      "command": "ocr-provenance-mcp",
      "env": {
        "OCR_PROVENANCE_ENV_FILE": "/absolute/path/to/.env"
      }
    }
  }
}
```

### Connecting to Any MCP Client

The server communicates via JSON-RPC over stdin/stdout (stdio transport). Any MCP-compatible client can connect by spawning the server as a subprocess.

---

## Tool Inventory (111 Tools)

> **Note**: The tool count was reduced from 122 to 111 via V3 Agent Optimization (2026-02-22):
> removed 4 redundant tools, consolidated 7 tools into 3 (unified action params),
> consolidated 5 report tools into 2 (section params), and added nested `filters` object for search.

### Tier 1: Essential Tools (17) -- Start Here

| Tool | Purpose |
|------|---------|
| `ocr_guide` | System navigator -- shows state, recommends next actions |
| `ocr_db_create` | Create a new isolated database |
| `ocr_db_list` | List all databases |
| `ocr_db_select` | Activate a database for all operations |
| `ocr_db_stats` | Comprehensive database overview |
| `ocr_ingest_directory` | Scan a folder and register documents |
| `ocr_ingest_files` | Register specific files |
| `ocr_process_pending` | Run full pipeline (OCR -> Chunk -> Embed) |
| `ocr_status` | Check processing progress |
| `ocr_search` | Unified search (keyword/semantic/hybrid) |
| `ocr_document_list` | Browse documents with filtering |
| `ocr_document_get` | Full document details |
| `ocr_cluster_get` | Inspect cluster contents |
| `ocr_tag_list` | Browse tags |
| `ocr_health_check` | Detect and fix data integrity gaps |
| `ocr_provenance_get` | Get audit trail for any item |
| `ocr_rag_context` | Assemble search results for LLM context |

### Database Management (5)

| Tool | Description |
|------|-------------|
| `ocr_db_create` | Create isolated database |
| `ocr_db_list` | List all databases with optional stats |
| `ocr_db_select` | Activate database for all operations |
| `ocr_db_stats` | Comprehensive overview (file types, quality, clusters) |
| `ocr_db_delete` | Permanently delete database with cascade |

### Ingestion & Processing (7)

| Tool | Description |
|------|-------------|
| `ocr_ingest_directory` | Scan folder recursively, register 18 file types |
| `ocr_ingest_files` | Ingest specific files by path |
| `ocr_process_pending` | Full pipeline: OCR -> Chunk -> Embed -> VLM -> Cluster |
| `ocr_status` | Check pending/processing/complete/failed counts |
| `ocr_retry_failed` | Reset failed documents for reprocessing |
| `ocr_reprocess` | Re-OCR with different accuracy settings |
| `ocr_convert_raw` | One-off OCR without database storage |

### Search & Retrieval (8)

| Tool | Description |
|------|-------------|
| `ocr_search` | **Unified search**: mode=keyword/semantic/hybrid, nested `filters` object |
| `ocr_rag_context` | Assemble results as markdown for LLM injection |
| `ocr_search_export` | Export results as CSV or JSON |
| `ocr_benchmark_compare` | Compare results across databases |
| `ocr_fts_manage` | Rebuild/check FTS5 index |
| `ocr_search_save` | Persist a search query by name |
| `ocr_search_saved` | Unified: action='list'\|'get'\|'execute' (consolidated from 3 tools) |
| `ocr_search_cross_db` | BM25 across all databases simultaneously |

### Document Management (11)

| Tool | Description |
|------|-------------|
| `ocr_document_list` | List with status filtering and pagination |
| `ocr_document_get` | Full details (text, chunks, blocks, provenance) |
| `ocr_document_delete` | Cascade delete with FK ordering |
| `ocr_document_find_similar` | Find by embedding centroid similarity |
| `ocr_document_structure` | Analyze structure: format='structure'\|'tree'\|'outline' (includes sections) |
| `ocr_document_update_metadata` | Batch update title/author/subject |
| `ocr_document_duplicates` | Detect exact (hash) and near (similarity) |
| `ocr_document_export` | JSON or markdown export |
| `ocr_corpus_export` | Entire corpus archive |
| `ocr_document_versions` | All versions of a re-ingested file |
| `ocr_document_workflow` | State management (draft/review/approved/published/archived) |

### Provenance (6)

| Tool | Description |
|------|-------------|
| `ocr_provenance_get` | Complete chain for any item |
| `ocr_provenance_verify` | SHA-256 hash chain verification |
| `ocr_provenance_export` | JSON, W3C PROV-JSON, or CSV |
| `ocr_provenance_query` | Query with 12+ filters |
| `ocr_provenance_timeline` | Processing timeline with durations |
| `ocr_provenance_processor_stats` | Per-processor performance stats |

### VLM / Vision Analysis (5)

| Tool | Description |
|------|-------------|
| `ocr_vlm_describe` | Describe image with optional thinking mode |
| `ocr_vlm_process_document` | VLM all images in a document |
| `ocr_vlm_process_pending` | VLM all pending images system-wide |
| `ocr_vlm_analyze_pdf` | Direct PDF analysis via Gemini (max 20MB) |
| `ocr_vlm_status` | Service health check |

### Image Operations (10)

| Tool | Description |
|------|-------------|
| `ocr_image_list` | List extracted images from document |
| `ocr_image_get` | Image details (path, dimensions, VLM description) |
| `ocr_image_stats` | Processing statistics |
| `ocr_image_delete` | Delete single image |
| `ocr_image_delete_by_document` | Delete all images for document |
| `ocr_image_reset_failed` | Retry failed VLM processing |
| `ocr_image_pending` | List pending VLM processing |
| `ocr_image_search` | 7 filters (type, size, confidence, page) |
| `ocr_image_semantic_search` | Semantic search over VLM descriptions |
| `ocr_image_reanalyze` | Re-run VLM with custom prompt |

### Chunks & Page Navigation (4)

| Tool | Description |
|------|-------------|
| `ocr_chunk_get` | Get chunk by ID with full metadata |
| `ocr_chunk_list` | List with filtering (content type, section, page) |
| `ocr_chunk_context` | Get chunk + N neighbors for context |
| `ocr_document_page` | Page-by-page navigation |

### Embeddings (4)

| Tool | Description |
|------|-------------|
| `ocr_embedding_list` | List with filtering by document/source/model |
| `ocr_embedding_stats` | Coverage and device stats |
| `ocr_embedding_get` | Details by ID |
| `ocr_embedding_rebuild` | Re-generate embeddings (include_vlm param for VLM re-embedding) |

### Structured Extraction & Image Extraction (4)

| Tool | Description |
|------|-------------|
| `ocr_extract_structured` | JSON schema extraction from OCR text |
| `ocr_extraction_list` | List extractions for document |
| `ocr_extraction_search` | Full-text search within extractions |
| `ocr_extract_images` | File-based image extraction (PyMuPDF for PDF, zipfile for DOCX) |

### Form Fill (2)

| Tool | Description |
|------|-------------|
| `ocr_form_fill` | Fill PDF/image forms via Datalab |
| `ocr_form_fill_status` | Check operation status |

### File Management (6)

| Tool | Description |
|------|-------------|
| `ocr_file_upload` | Upload to Datalab (deduplicates by SHA-256) |
| `ocr_file_list` | List uploaded with duplicate detection |
| `ocr_file_get` | File metadata |
| `ocr_file_download` | Get download URL |
| `ocr_file_delete` | Delete record |
| `ocr_file_ingest_uploaded` | Bridge uploaded files into pipeline |

### Comparison (6)

| Tool | Description |
|------|-------------|
| `ocr_document_compare` | Text diff + structural diff + similarity |
| `ocr_comparison_list` | Browse comparisons |
| `ocr_comparison_get` | Full diff data |
| `ocr_comparison_discover` | Auto-find similar pairs |
| `ocr_comparison_batch` | Compare multiple pairs |
| `ocr_comparison_matrix` | NxN pairwise similarity matrix |

### Clustering (7)

| Tool | Description |
|------|-------------|
| `ocr_cluster_documents` | Run HDBSCAN/agglomerative/k-means |
| `ocr_cluster_list` | Browse clusters |
| `ocr_cluster_get` | Cluster details with members |
| `ocr_cluster_assign` | Auto-classify document into cluster |
| `ocr_cluster_reassign` | Move between clusters |
| `ocr_cluster_merge` | Merge two clusters |
| `ocr_cluster_delete` | Delete clustering run |

### Tags (6)

| Tool | Description |
|------|-------------|
| `ocr_tag_create` | Create tag with color/description |
| `ocr_tag_list` | List tags with usage counts |
| `ocr_tag_apply` | Apply to documents/chunks/images/clusters |
| `ocr_tag_remove` | Remove from entity |
| `ocr_tag_search` | Find entities by tag |
| `ocr_tag_delete` | Delete tag |

### Intelligence & Guidance (4)

| Tool | Description |
|------|-------------|
| `ocr_guide` | System state inspector and next-action recommender |
| `ocr_document_tables` | Extract structured table data |
| `ocr_document_recommend` | Related document recommendations |
| `ocr_document_extras` | Access OCR extras (charts, links, etc.) |

### Reports & Analytics (7)

| Tool | Description |
|------|-------------|
| `ocr_report_overview` | Consolidated: section='quality'\|'corpus'\|'all' |
| `ocr_report_performance` | Consolidated: section='pipeline'\|'throughput'\|'bottlenecks'\|'all' |
| `ocr_evaluation_report` | OCR + VLM quality metrics |
| `ocr_document_report` | Single document full report |
| `ocr_cost_summary` | Cost analytics by document/mode/month |
| `ocr_error_analytics` | Error rates and failure patterns |
| `ocr_quality_trends` | Quality over time |

### Timeline (1)

| Tool | Description |
|------|-------------|
| `ocr_timeline_analytics` | Processing volume over time (hourly/daily/weekly/monthly) |

### Configuration (2)

| Tool | Description |
|------|-------------|
| `ocr_config_get` | View system configuration |
| `ocr_config_set` | Update at runtime |

### Health (1)

| Tool | Description |
|------|-------------|
| `ocr_health_check` | Detect and auto-fix integrity gaps |

### Evaluation (3)

| Tool | Description |
|------|-------------|
| `ocr_evaluate_single` | Evaluate single image quality |
| `ocr_evaluate_document` | Evaluate all images in document |
| `ocr_evaluate_pending` | Bulk evaluate all pending images |

---

## Controlling the AI Agent

### The Agent-Tool Relationship

When you connect this MCP server to Claude (or any MCP-compatible AI), the agent gains access to all 111 tools. The agent can call any tool by name with the right parameters. **You control the agent through natural language instructions.**

### How to Give Effective Instructions

#### 1. Start with `ocr_guide`

Always begin a session by asking the agent to call `ocr_guide`. This gives the agent a snapshot of system state (active database, document counts, processing status) and recommended next actions.

```
"Start by running ocr_guide to see what's available."
```

#### 2. Be Explicit About the Database

The system supports multiple isolated databases. Always tell the agent which database to use:

```
"Create a database called 'trucking-case-2024' and select it."
"Switch to the 'contract-review' database."
```

#### 3. Give Multi-Step Workflow Instructions

The agent performs best when you describe the full workflow upfront:

```
"Ingest all PDFs from /data/driver-logs/, process them with accurate OCR mode,
then search for all annotations mentioning 'violation' or 'hours of service'."
```

#### 4. Use Tags for Organization

Tell the agent to tag documents as it finds relevant items:

```
"Create tags for 'violation-found', 'compliant', and 'needs-review'.
As you find driver logs with violations, tag them accordingly."
```

#### 5. Request Exports When Needed

```
"Export all search results for 'hours of service violation' as CSV."
"Export the full provenance chain for document X in W3C PROV format."
```

#### 6. Request Reports for Summaries

```
"Run a corpus profile report to see document type distribution."
"Show me error analytics to see if any documents failed OCR."
"Run quality trends to see if OCR quality varies across batches."
```

### Agent Behavior Patterns

| Pattern | How to Invoke |
|---------|---------------|
| **Guided exploration** | "Run ocr_guide, then follow its recommendations" |
| **Batch processing** | "Ingest everything in /path/ and process all pending" |
| **Targeted search** | "Search for [exact term] using keyword mode" |
| **Conceptual search** | "Find documents discussing [concept]" -- agent uses semantic mode |
| **Combined search** | "Search for [term] and related concepts" -- agent uses hybrid mode |
| **Quality assurance** | "Run health check and fix any gaps" |
| **Provenance audit** | "Verify the provenance chain for document [id]" |
| **Comparative analysis** | "Compare documents A and B, show the differences" |
| **Clustering** | "Cluster all documents to find natural groupings" |
| **Structured extraction** | "Extract [field names] from all invoices using this schema: {...}" |

### Controlling Processing Parameters

```
"Set OCR mode to 'accurate' for this batch -- these are low-quality scans."
"Set chunk size to 1500 for these short documents."
"Enable auto-clustering with HDBSCAN after processing."
```

### Monitoring Progress

```
"Check processing status -- how many are still pending?"
"Show me error analytics for this batch."
"Run a performance report to see throughput."
```

---

## Core Workflows

### Workflow 1: Basic Ingest -> Search

```
Step 1: Create database
  ocr_db_create { name: "my-project" }

Step 2: Select it
  ocr_db_select { name: "my-project" }

Step 3: Ingest documents
  ocr_ingest_directory { directory_path: "/path/to/documents", recursive: true }

Step 4: Process everything
  ocr_process_pending { ocr_mode: "balanced" }

Step 5: Search
  ocr_search { query: "contract termination clause", mode: "hybrid" }

Step 6: Get context for LLM
  ocr_rag_context { query: "What are the termination conditions?" }
```

### Workflow 2: Deep Analysis

```
Step 1-4: Same as Workflow 1

Step 5: Cluster documents
  ocr_cluster_documents { algorithm: "hdbscan" }

Step 6: Inspect clusters
  ocr_cluster_list {}
  ocr_cluster_get { cluster_id: "..." }

Step 7: Compare similar documents
  ocr_comparison_discover { min_similarity: 0.7 }
  ocr_comparison_batch { pairs: [...discovered pairs...] }

Step 8: Tag findings
  ocr_tag_create { name: "anomaly", color: "#ff0000" }
  ocr_tag_apply { tag_name: "anomaly", entity_id: "doc-123", entity_type: "document" }
```

### Workflow 3: Legal Discovery with Provenance

```
Step 1-4: Same as Workflow 1 (use "accurate" OCR mode)

Step 5: Search with provenance
  ocr_search { query: "breach of fiduciary duty", mode: "hybrid", include_provenance: true }

Step 6: Verify chain of custody
  ocr_provenance_verify { item_id: "chunk-456" }

Step 7: Export for court
  ocr_provenance_export { scope: "document", format: "w3c-prov", document_id: "doc-123" }
  ocr_search_export { query: "breach", format: "csv" }

Step 8: Generate document report
  ocr_document_report { document_id: "doc-123" }
```

### Workflow 4: Image-Heavy Documents

```
Step 1-4: Same as Workflow 1

Step 5: Process images with VLM
  ocr_vlm_process_pending {}

Step 6: Search images semantically
  ocr_image_semantic_search { query: "signature on contract" }

Step 7: Re-analyze specific image
  ocr_image_reanalyze { image_id: "img-789", prompt: "Is this signature authentic?" }

Step 8: Extract tables
  ocr_document_tables { document_id: "doc-123" }
```

---

## Use Cases

### 1. Legal Document Review

**Scenario**: Law firms processing thousands of documents for litigation, discovery, or compliance.

**Approach**:
- Create a database per case
- Ingest all case documents with `accurate` OCR mode
- Use keyword search for specific legal terms, case numbers, names
- Use semantic search for conceptual queries ("breach of duty")
- Cluster documents to find natural groupings (contracts vs. correspondence vs. filings)
- Tag documents by relevance (relevant, privileged, non-responsive)
- Export provenance in W3C PROV format for chain-of-custody documentation
- Use comparison tools to detect duplicate or near-duplicate filings
- Generate cost reports for billing

### 2. Medical Records Processing

**Scenario**: Processing patient records, lab results, imaging reports for research or insurance.

**Approach**:
- Ingest medical records (PDFs, scanned images)
- Use structured extraction with JSON schemas for lab values, diagnoses, medications
- Search for specific conditions, treatments, outcomes
- Cluster patients by condition similarity
- Tag records by study group, condition type
- Use VLM for analyzing medical images (X-rays, charts)
- Export structured data for statistical analysis

### 3. Financial Audit

**Scenario**: Auditing financial statements, invoices, receipts across years.

**Approach**:
- Create databases per fiscal year or client
- Ingest all financial documents
- Use structured extraction for invoice amounts, dates, vendors
- Search for specific amounts, account numbers, vendor names
- Compare year-over-year financial statements
- Cluster invoices by vendor or category
- Tag anomalies for review
- Generate cost and quality reports

### 4. Research Paper Analysis

**Scenario**: Academic researchers processing hundreds of papers for systematic review.

**Approach**:
- Ingest all papers (PDFs)
- Use semantic search for research themes and methodologies
- Cluster papers by topic similarity
- Compare methodology sections across papers
- Tag papers by inclusion/exclusion criteria
- Extract structured data (sample sizes, p-values, findings)
- Generate corpus profile for overview statistics

### 5. Contract Management

**Scenario**: Companies managing thousands of vendor contracts, leases, agreements.

**Approach**:
- Create database per contract type or vendor
- Ingest all contracts
- Use keyword search for specific clauses, dates, amounts
- Use semantic search for "termination conditions" or "liability limits"
- Compare contract versions to detect changes
- Use workflow states (draft/review/approved) to track status
- Extract key terms using structured extraction
- Tag by renewal date, risk level, department

### 6. Insurance Claims Processing

**Scenario**: Processing claims documents, adjuster reports, photos.

**Approach**:
- Ingest claims packages (forms, photos, reports)
- Use VLM to analyze damage photos
- Search for specific claim numbers, policy numbers, dates
- Extract structured claim data (amounts, dates, descriptions)
- Compare similar claims to detect patterns
- Cluster claims by type for batch processing
- Tag by status (open, under review, settled, denied)

### 7. Regulatory Compliance

**Scenario**: Ensuring document compliance with industry regulations.

**Approach**:
- Ingest compliance documents
- Search for required regulatory language
- Compare documents against template/standard versions
- Verify provenance chain for audit purposes
- Tag documents by compliance status
- Generate reports for regulators
- Export W3C PROV for formal audit trail

---

## Case Study: 13,688 Commercial Driver Logs

### The Scenario

An eight-figure legal case in logistics/commercial trucking requiring analysis of **13,688 PDF driver logs** (each 36-40 pages) seeking **specific annotations**. This represents approximately **500,000-550,000 pages** of material.

### Why This System is Ideal

1. **Scale**: The system handles unlimited documents per database, with SQLite scaling efficiently to millions of chunks
2. **Structured data**: Driver logs have consistent formats -- perfect for structured extraction
3. **Annotations**: VLM (vision) can detect handwritten annotations that OCR might miss
4. **Provenance**: Legal cases require chain-of-custody -- every finding traces back to exact page and location
5. **Search**: Find specific violations across 500K+ pages in seconds
6. **Clustering**: Group similar log patterns automatically

### Recommended Approach: Phase-by-Phase

#### Phase 0: Environment Setup (15 minutes)

```
Tell the agent:

"Set up for a large-scale legal document processing project.
Create a database called 'trucking-case-cdl-logs'.
Set OCR mode to 'accurate' since these are scanned driver logs.
Set max concurrent OCR to 5 for throughput.
Enable auto-clustering with threshold 100."
```

Agent actions:
```
ocr_db_create { name: "trucking-case-cdl-logs" }
ocr_db_select { name: "trucking-case-cdl-logs" }
ocr_config_set { key: "datalab_default_mode", value: "accurate" }
ocr_config_set { key: "datalab_max_concurrent", value: "5" }
ocr_config_set { key: "auto_cluster_enabled", value: "true" }
ocr_config_set { key: "auto_cluster_threshold", value: "100" }
ocr_config_set { key: "auto_cluster_algorithm", value: "hdbscan" }
```

#### Phase 1: Batch Ingestion (30-60 minutes)

Organize the 13,688 PDFs into batch directories if possible (by driver, by date range, by terminal). Then:

```
Tell the agent:

"Ingest all driver log PDFs from /data/cdl-logs/ recursively.
These are 36-40 page PDFs, approximately 13,688 files."
```

Agent actions:
```
ocr_ingest_directory { directory_path: "/data/cdl-logs/", recursive: true }
```

This registers all 13,688 documents. No OCR happens yet -- this is fast.

#### Phase 2: OCR Processing (Ongoing -- days for full corpus)

**Processing 13,688 documents at ~5 concurrent jobs will take time.** At 3 pages/second with accurate mode, expect:

- ~500,000 pages / 3 pages/sec = ~46 hours of OCR time
- With 5 concurrent: ~9-10 hours of wall-clock time

```
Tell the agent:

"Start processing all pending documents.
Check status periodically and report progress."
```

Agent actions:
```
ocr_process_pending { batch_size: 50 }  -- processes in batches
ocr_status {}                            -- check progress
```

**Strategy for large batches**: Process in stages. You can work with completed documents while others are still processing.

```
"Process the next 500 pending documents."
"How many are complete vs pending now?"
"While those process, let me search what's already done."
```

#### Phase 3: Define Annotation Search Strategy

Commercial driver logs (Form 395.8) have specific fields and annotations to look for. Define your search strategy:

**Keyword searches** (exact regulatory terms):
- "hours of service" / "HOS"
- "violation" / "out of service"
- "false log" / "falsification"
- "driving time exceeded"
- "on-duty not driving"
- "sleeper berth"
- "personal conveyance"
- Specific CFR references: "395.8", "395.3", "392.3"

**Semantic searches** (conceptual):
- "annotations indicating driver fatigue"
- "handwritten corrections to log entries"
- "discrepancies between electronic and paper logs"
- "time gaps in driving records"
- "excessive consecutive driving hours"

**Structured extraction** (form fields):
- Driver name, license number
- Date, start/end times
- Total driving hours, on-duty hours
- Carrier name, vehicle number
- Annotations, remarks, exceptions

#### Phase 4: Targeted Searches Across Processed Documents

```
Tell the agent:

"Search all processed driver logs for 'hours of service violation'
using hybrid mode. Show me the top 50 results with provenance."
```

Agent actions:
```
ocr_search {
  query: "hours of service violation",
  mode: "hybrid",
  limit: 50,
  include_provenance: true,
  rerank: true
}
```

**For exact regulatory terms:**
```
"Search for '395.8' using keyword mode with phrase search enabled."
```

```
ocr_search {
  query: "395.8",
  mode: "keyword",
  phrase_search: true,
  limit: 100
}
```

**For annotations on specific pages:**
```
"Search for handwritten annotations or corrections in driver logs."
```

```
ocr_search {
  query: "annotation correction amendment handwritten note",
  mode: "hybrid",
  auto_route: true,
  limit: 100
}
```

#### Phase 5: Structured Extraction for Log Data

Define a JSON schema matching the CDL log format:

```
Tell the agent:

"For each processed driver log, extract structured data using this schema:
- driver_name (string)
- driver_license_number (string)
- date (string)
- carrier_name (string)
- vehicle_number (string)
- total_driving_hours (number)
- total_on_duty_hours (number)
- annotations (array of strings)
- violations_noted (array of strings)
- remarks (string)

Start with the first 100 documents to validate the schema."
```

Agent actions:
```
ocr_extract_structured {
  document_id: "doc-001",
  page_schema: {
    "driver_name": { "type": "string" },
    "driver_license_number": { "type": "string" },
    "date": { "type": "string" },
    "carrier_name": { "type": "string" },
    "vehicle_number": { "type": "string" },
    "total_driving_hours": { "type": "number" },
    "total_on_duty_hours": { "type": "number" },
    "annotations": { "type": "array", "items": { "type": "string" } },
    "violations_noted": { "type": "array", "items": { "type": "string" } },
    "remarks": { "type": "string" }
  }
}
```

Then search extractions:
```
ocr_extraction_search { query: "violation" }
ocr_extraction_search { query: "annotation" }
```

#### Phase 6: VLM Analysis for Handwritten Annotations

Driver logs often have handwritten annotations that OCR may not capture perfectly. Use VLM to analyze images:

```
Tell the agent:

"Process all pending images with VLM to detect handwritten annotations.
Then search images semantically for 'handwritten annotation' or
'written note on driver log'."
```

Agent actions:
```
ocr_vlm_process_pending {}
ocr_image_semantic_search { query: "handwritten annotation on driver log form" }
ocr_image_semantic_search { query: "written correction or amendment to log entry" }
ocr_image_search { block_type: "Picture" }  -- find non-diagram images
```

For specific suspicious images:
```
ocr_image_reanalyze {
  image_id: "img-456",
  prompt: "Describe any handwritten annotations, corrections, or notes visible on this driver log page. Note any crossed-out entries, margin notes, or alterations."
}
```

#### Phase 7: Clustering and Pattern Detection

```
Tell the agent:

"Cluster all processed driver logs to find natural groupings.
Use HDBSCAN to auto-detect the number of clusters."
```

Agent actions:
```
ocr_cluster_documents { algorithm: "hdbscan" }
ocr_cluster_list {}
```

Inspect clusters to find patterns:
```
ocr_cluster_get { cluster_id: "cluster-001" }
```

Clusters might reveal:
- Logs from the same driver (similar handwriting patterns)
- Logs with similar violation types
- Logs from specific time periods or routes
- Outlier logs (noise cluster in HDBSCAN = unusual documents)

#### Phase 8: Tagging and Workflow Management

```
Tell the agent:

"Create the following tags:
- 'hos-violation' (red) -- Hours of service violations found
- 'annotation-found' (orange) -- Contains handwritten annotations
- 'falsification-suspect' (red) -- Suspected falsified entries
- 'compliant' (green) -- No issues found
- 'needs-expert-review' (yellow) -- Ambiguous, needs human review
- 'key-evidence' (purple) -- Critical evidence for the case

Tag documents as we identify them through search results."
```

Agent actions:
```
ocr_tag_create { name: "hos-violation", color: "#ff0000", description: "HOS violation found" }
ocr_tag_create { name: "annotation-found", color: "#ff8800", description: "Contains annotations" }
ocr_tag_create { name: "falsification-suspect", color: "#ff0000", description: "Suspected falsification" }
ocr_tag_create { name: "compliant", color: "#00cc00", description: "No issues found" }
ocr_tag_create { name: "needs-expert-review", color: "#ffcc00", description: "Needs human review" }
ocr_tag_create { name: "key-evidence", color: "#9900cc", description: "Critical evidence" }

-- Then as documents are reviewed:
ocr_tag_apply { tag_name: "hos-violation", entity_id: "doc-123", entity_type: "document" }
```

Find all documents with a specific tag:
```
ocr_tag_search { tags: ["hos-violation"], entity_type: "document" }
ocr_tag_search { tags: ["key-evidence"], entity_type: "document" }
```

#### Phase 9: Comparison and Duplicate Detection

```
Tell the agent:

"Check for duplicate or near-duplicate driver logs in the corpus.
Then compare logs from the same driver across different dates
to detect pattern changes."
```

Agent actions:
```
ocr_document_duplicates { min_similarity: 0.85 }
ocr_comparison_discover { min_similarity: 0.7 }
ocr_comparison_matrix { document_ids: ["doc-a", "doc-b", "doc-c", "doc-d"] }
```

#### Phase 10: Provenance and Export for Legal Use

```
Tell the agent:

"For all documents tagged 'key-evidence':
1. Verify the provenance chain for each
2. Export provenance in W3C PROV-JSON format
3. Export search results as CSV
4. Generate a document report for each"
```

Agent actions:
```
-- For each key-evidence document:
ocr_provenance_verify { item_id: "doc-123" }
ocr_provenance_export { scope: "document", document_id: "doc-123", format: "w3c-prov" }
ocr_document_report { document_id: "doc-123" }

-- Bulk export:
ocr_search_export { query: "hours of service violation", format: "csv" }
ocr_corpus_export { format: "json" }
```

#### Phase 11: Ongoing Monitoring and Reporting

```
Tell the agent:

"Generate a full status report:
- How many documents processed vs pending vs failed?
- What's the OCR quality distribution?
- How many violations found so far?
- What are the error rates?
- Show me the cost summary."
```

Agent actions:
```
ocr_status {}
ocr_report_overview { include: "both" }
ocr_quality_trends { granularity: "daily" }
ocr_error_analytics {}
ocr_cost_summary { group_by: "total" }
ocr_tag_list {}  -- shows count per tag
```

### Expected Outcomes

| Metric | Estimate |
|--------|----------|
| **Total pages processed** | ~500,000-550,000 |
| **Total chunks created** | ~1,500,000-2,000,000 |
| **Total embeddings** | ~1,500,000-2,000,000 |
| **Database size** | ~15-30 GB (with embeddings) |
| **OCR processing time** | ~9-10 hours (5 concurrent, accurate mode) |
| **Search latency** | <100ms per query (BM25), <500ms (hybrid) |
| **Provenance records** | ~5,000,000+ (every transformation tracked) |

### Tips for This Scale

1. **Process in batches**: Don't try to process all 13,688 at once. Do batches of 500-1000 and start searching early.
2. **Use keyword mode first**: For regulatory terms like "395.8" or "violation", keyword (BM25) is faster and more precise.
3. **Save searches**: Use `ocr_search_save` to persist important queries. Re-run them as more documents complete.
4. **Monitor errors**: Some scans may be poor quality. Use `ocr_retry_failed` with `accurate` mode for those.
5. **Tag aggressively**: Tags are cheap and make retrieval trivial later.
6. **Export incrementally**: Don't wait until the end. Export findings as you go.
7. **Use cross-database search**: If you split logs across databases (by year, by driver), you can still search all at once.

---

## Performance & Scaling

### Throughput

| Component | Rate | Notes |
|-----------|------|-------|
| **OCR (Datalab)** | ~5 docs/min per job | Configurable 1-10 concurrent |
| **Embedding (CUDA)** | 2000+ chunks/sec | Batch size 512 |
| **Embedding (MPS)** | ~100 chunks/sec | Apple Silicon |
| **Embedding (CPU)** | ~20 chunks/sec | Fallback |
| **BM25 search** | <10ms | FTS5 on-disk |
| **Vector search** | <20ms for 100K vectors | sqlite-vec cosine |
| **Hybrid search** | <500ms | BM25 + vector + RRF + rerank |
| **VLM (Gemini)** | ~1 image/sec | Rate limited |
| **Clustering** | <5s for 100 docs | scikit-learn |
| **Provenance verify** | <100ms | Re-hash chain |

### Database Sizing

| Documents | Pages | Chunks | DB Size (approx) |
|-----------|-------|--------|-------------------|
| 100 | 3,000 | 10,000 | ~200 MB |
| 1,000 | 30,000 | 100,000 | ~2 GB |
| 10,000 | 300,000 | 1,000,000 | ~15 GB |
| 13,688 | 500,000 | 1,700,000 | ~25 GB |

### Scaling Strategies

1. **Multiple databases**: Split by case, year, or document type for parallel processing
2. **Batch processing**: Process in groups of 500-1000 for manageability
3. **Incremental search**: Start searching completed documents while others process
4. **Cross-DB search**: Search all databases simultaneously with `ocr_search_cross_db`
5. **Health checks**: Run periodically to catch and fix gaps

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATALAB_API_KEY` | Yes | -- | Datalab OCR API key |
| `GEMINI_API_KEY` | Yes | -- | Google Gemini API key |
| `DATALAB_DEFAULT_MODE` | No | balanced | OCR accuracy: fast/balanced/accurate |
| `DATALAB_MAX_CONCURRENT` | No | 3 | Parallel OCR jobs (1-10) |
| `EMBEDDING_DEVICE` | No | auto | auto/cuda/mps/cpu |
| `EMBEDDING_BATCH_SIZE` | No | 512 | GPU batch size |
| `CHUNKING_SIZE` | No | 2000 | Characters per chunk |
| `CHUNKING_OVERLAP_PERCENT` | No | 10 | Overlap percentage |
| `AUTO_CLUSTER_ENABLED` | No | false | Auto-cluster after processing |
| `AUTO_CLUSTER_THRESHOLD` | No | 10 | Min docs to trigger |
| `AUTO_CLUSTER_ALGORITHM` | No | hdbscan | Clustering algorithm |
| `STORAGE_DATABASES_PATH` | No | ~/.ocr-provenance/databases/ | Database directory |

### Runtime Configuration (via `ocr_config_set`)

All environment variables above can be changed at runtime without restarting the server.

```
ocr_config_set { key: "datalab_default_mode", value: "accurate" }
ocr_config_set { key: "embedding_device", value: "cuda" }
ocr_config_set { key: "auto_cluster_enabled", value: "true" }
```

### Search Mode Quick Reference

| Mode | Best For | Speed | Precision |
|------|----------|-------|-----------|
| `keyword` | Exact terms, codes, names, case numbers | Fastest | High for exact matches |
| `semantic` | Concepts, paraphrases, meaning-based | Medium | High for conceptual |
| `hybrid` | General queries, mixed exact+conceptual | Slowest | Highest overall |

### Provenance Export Formats

| Format | Use Case |
|--------|----------|
| `json` | Machine-readable, integration with other systems |
| `w3c-prov` | W3C PROV-JSON standard, regulatory compliance |
| `csv` | Spreadsheet analysis, simple reporting |

---

## Quick Reference Card

### First 5 Minutes

```
1. ocr_guide                              -- See system state
2. ocr_db_create { name: "my-project" }   -- Create database
3. ocr_db_select { name: "my-project" }   -- Activate it
4. ocr_ingest_directory { directory_path: "/path/" }  -- Register files
5. ocr_process_pending {}                  -- OCR + chunk + embed
```

### Essential Search Patterns

```
-- Exact term
ocr_search { query: "case number 2024-1234", mode: "keyword" }

-- Conceptual
ocr_search { query: "What were the settlement terms?", mode: "semantic" }

-- Best of both
ocr_search { query: "breach of contract damages", mode: "hybrid" }

-- With page filter
ocr_search { query: "signature", mode: "hybrid", page_range_filter: { min_page: 35, max_page: 40 } }

-- Export results
ocr_search_export { query: "violation", format: "csv" }
```

### Essential Analysis Patterns

```
-- Cluster documents
ocr_cluster_documents { algorithm: "hdbscan" }

-- Compare two documents
ocr_document_compare { document_id_1: "...", document_id_2: "..." }

-- Find duplicates
ocr_document_duplicates { min_similarity: 0.85 }

-- Verify provenance
ocr_provenance_verify { item_id: "..." }

-- Health check
ocr_health_check { fix: true }
```

---

*Document generated: 2026-02-22*
*System version: Schema v31, 111 MCP tools*
*Repository: https://github.com/anthropics/datalab (OCR Provenance MCP Server)*
