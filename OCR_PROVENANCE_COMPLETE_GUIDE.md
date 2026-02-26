# OCR Provenance MCP Server: AI Agent Guide

## System Overview

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0.5 |
| **MCP Tools** | 141 |
| **Schema Version** | 32 |
| **Architecture** | TypeScript MCP server + 9 Python workers |
| **Storage** | SQLite + sqlite-vec (768-dim vectors) + FTS5 (full-text) |
| **Embedding** | nomic-embed-text-v1.5 (local GPU/CPU, 768-dim) |
| **VLM** | Gemini 3 Flash (image analysis ONLY) |
| **OCR Engine** | Datalab API (PDF, DOCX, images, presentations) |
| **Reranking** | Local cross-encoder ms-marco-MiniLM-L-12-v2 (no API) |
| **Transport** | stdio (default) or HTTP/SSE (Docker) |
| **Tests** | 2,639 passing across 115 test files |

An MCP server that gives AI agents document ingestion, OCR, search, analysis, comparison, clustering, collaboration, contract lifecycle management, and compliance auditing -- all with cryptographic provenance chains. Runs locally except Datalab OCR API and Gemini VLM API calls.

---

## Capabilities

**Ingestion**: 18 file types (PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, PNG, JPG, JPEG, TIFF, TIF, BMP, GIF, WEBP, TXT, CSV, MD). Three OCR modes: fast/balanced/accurate. Auto-pipeline: Ingest -> OCR -> Chunk -> Embed -> Index -> optional VLM + Clustering. Version tracking via hash comparison.

**Search**: Unified `ocr_search` with keyword (BM25 via FTS5), semantic (vector cosine), hybrid (RRF fusion + auto-routing). Always-on: quality-weighted ranking, query expansion, dedup, header/footer exclusion. Local reranking. Rich filters (page, section, heading, content type, metadata, cluster, quality). Cross-database BM25. RAG context assembly.

**Analysis**: Structure analysis, table extraction/export, page navigation, document profiles, OCR extras (charts, links, tracked changes).

**Comparison**: Text diff (Sorensen-Dice), structural diff, batch comparison, auto-discovery of similar pairs, NxN similarity matrix.

**Clustering**: HDBSCAN (auto-k), agglomerative, k-means. Auto-cluster, reassign, merge.

**VLM**: Gemini 3 Flash image descriptions, batch processing, direct PDF analysis, custom prompts, VLM text searchable via FTS.

**Provenance**: SHA-256 chain at every step. 4-depth lineage (DOCUMENT -> OCR_RESULT -> CHUNK -> EMBEDDING). Chain verification, W3C PROV export, 12+ query filters, timeline view. Merkle-like chain-hash verification.

**Collaboration**: Threaded annotations (comments/suggestions/highlights), exclusive/shared document locking with auto-expiry, search alerts.

**Workflow**: State machine (draft -> submitted -> in_review -> approved/rejected/changes_requested -> executed -> archived). Approval chains with ordered steps and roles.

**Contract Lifecycle (CLM)**: Contract clause extraction, obligation tracking (CRUD + calendar + overdue), playbook clause comparison, algorithmic document/corpus summarization.

**Compliance**: PROV-AGENT metadata, chain-hash verification, HIPAA/SOC2/SOX compliance exports.

**Events**: Webhook delivery (HMAC-SHA256, exponential backoff, auto-disable), audit log export, obligation CSV export, annotation export.

**Multi-User**: RBAC (6 scopes, 4 roles), audit logging, user management.

**Structured Extraction**: JSON schema extraction from OCR text. Form filling via Datalab.

**Tagging**: Cross-entity tags (documents, chunks, images, extractions, clusters) with color/description.

**Multi-Database**: Full isolation per case/project/client. Cross-DB search without switching.

---

## Setup

### Prerequisites

Node.js 20+, Python 3.10+, npm.

### Environment Variables (.env)

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
AUTO_CLUSTER_THRESHOLD=10              # Min docs to trigger
AUTO_CLUSTER_ALGORITHM=hdbscan         # hdbscan | agglomerative | kmeans
STORAGE_DATABASES_PATH=~/.ocr-provenance/databases/
OCR_PROVENANCE_ALLOWED_DIRS=/host,/data # Extra allowed directories (see File Access Permissions)
```

### Connection Methods

**Claude Code (stdio)**:
```bash
claude mcp add ocr-provenance -s user \
  -e OCR_PROVENANCE_ENV_FILE=/absolute/path/to/.env \
  -- ocr-provenance-mcp
```

**Claude Desktop (stdio)**:
```json
{
  "mcpServers": {
    "ocr-provenance": {
      "command": "ocr-provenance-mcp",
      "env": { "OCR_PROVENANCE_ENV_FILE": "/absolute/path/to/.env" }
    }
  }
}
```

**Docker (stdio)**:
```json
{
  "mcpServers": {
    "ocr-provenance": {
      "command": "docker",
      "args": ["run", "-i", "--rm",
        "-v", "/your/docs:/host:ro",
        "-v", "ocr-data:/data",
        "-e", "DATALAB_API_KEY=...",
        "-e", "GEMINI_API_KEY=...",
        "ocr-provenance-mcp:cpu"]
    }
  }
}
```

**Docker HTTP mode** (for multi-session/remote):
```bash
docker run -d -p 3100:3100 \
  -e MCP_TRANSPORT=http \
  -e DATALAB_API_KEY=... -e GEMINI_API_KEY=... \
  -v ocr-data:/data \
  ocr-provenance-mcp:cpu
# Health: GET /health  |  MCP: POST /mcp (SSE)
```

**npm (local build)**:
```bash
npm install && npm run build
```

---

## Tool Reference (141 Tools)

### Tier 1: Start Here (17 essential tools)

| Tool | Purpose |
|------|---------|
| `ocr_guide` | System navigator -- shows state, recommends next actions |
| `ocr_db_create` | Create a new isolated database |
| `ocr_db_list` | List all databases |
| `ocr_db_select` | Activate a database for all operations |
| `ocr_db_stats` | Comprehensive database overview |
| `ocr_ingest_directory` | Scan folder, register 18 file types |
| `ocr_ingest_files` | Register specific files |
| `ocr_process_pending` | Full pipeline: OCR -> Chunk -> Embed -> VLM -> Cluster |
| `ocr_status` | Check pending/processing/complete/failed counts |
| `ocr_search` | **Unified search**: keyword/semantic/hybrid with nested `filters` |
| `ocr_document_list` | Browse documents with filtering |
| `ocr_document_get` | Full document details |
| `ocr_health_check` | Detect and auto-fix data integrity gaps |
| `ocr_provenance_get` | Get audit trail for any item |
| `ocr_rag_context` | Assemble search results as markdown for LLM context |
| `ocr_tag_list` | Browse tags |
| `ocr_cluster_get` | Inspect cluster contents |

### Database Management (5)

| Tool | Description |
|------|-------------|
| `ocr_db_create` | Create isolated database |
| `ocr_db_list` | List all databases with optional stats |
| `ocr_db_select` | Activate database for all operations |
| `ocr_db_stats` | Overview: file types, quality, clusters, counts |
| `ocr_db_delete` | Permanently delete database with cascade |

### Ingestion & Processing (7)

| Tool | Description |
|------|-------------|
| `ocr_ingest_directory` | Scan folder recursively |
| `ocr_ingest_files` | Ingest specific files by path |
| `ocr_process_pending` | Full pipeline on all pending docs |
| `ocr_status` | Processing progress counts |
| `ocr_retry_failed` | Reset failed documents for reprocessing |
| `ocr_reprocess` | Re-OCR with different accuracy settings |
| `ocr_convert_raw` | One-off OCR without database storage |

### Search & Retrieval (7)

| Tool | Description |
|------|-------------|
| `ocr_search` | **Unified**: mode=keyword/semantic/hybrid, nested `filters` object |
| `ocr_rag_context` | Assemble results as markdown for LLM injection |
| `ocr_search_export` | Export results as CSV or JSON |
| `ocr_benchmark_compare` | Compare results across databases |
| `ocr_fts_manage` | Rebuild/check FTS5 index |
| `ocr_search_saved` | action='save'\|'list'\|'get'\|'execute' |
| `ocr_search_cross_db` | BM25 across all databases simultaneously |

### Document Management (10)

| Tool | Description |
|------|-------------|
| `ocr_document_list` | List with status filtering and pagination |
| `ocr_document_get` | Full details (text, chunks, blocks, provenance) |
| `ocr_document_delete` | Cascade delete with FK ordering |
| `ocr_document_find_similar` | Find by embedding centroid similarity |
| `ocr_document_structure` | format='structure'\|'tree'\|'outline' |
| `ocr_document_update_metadata` | Batch update title/author/subject |
| `ocr_document_duplicates` | Detect exact (hash) and near (similarity) |
| `ocr_export` | Unified: scope='document'\|'corpus', format=json/markdown |
| `ocr_document_versions` | All versions of a re-ingested file |
| `ocr_document_workflow` | State management (draft/review/approved/published/archived) |

### Provenance (6)

| Tool | Description |
|------|-------------|
| `ocr_provenance_get` | Complete chain for any item |
| `ocr_provenance_verify` | SHA-256 + chain-hash verification |
| `ocr_provenance_export` | JSON, W3C PROV-JSON, or CSV |
| `ocr_provenance_query` | Query with 12+ filters |
| `ocr_provenance_timeline` | Processing timeline with durations |
| `ocr_provenance_processor_stats` | Per-processor performance stats |

### VLM / Vision (4)

| Tool | Description |
|------|-------------|
| `ocr_vlm_describe` | Describe image with optional thinking mode |
| `ocr_vlm_process` | Process single document or all pending VLM images |
| `ocr_vlm_analyze_pdf` | Direct PDF analysis via Gemini (max 20MB) |
| `ocr_vlm_status` | VLM service health check |

### Image Operations (8)

| Tool | Description |
|------|-------------|
| `ocr_image_list` | List extracted images from document |
| `ocr_image_get` | Image details (path, dimensions, VLM description) |
| `ocr_image_stats` | Processing statistics |
| `ocr_image_delete` | Delete single image |
| `ocr_image_reset_failed` | Retry failed VLM processing |
| `ocr_image_pending` | List pending VLM processing |
| `ocr_image_search` | 7 filters (type, size, confidence, page, semantic) |
| `ocr_image_reanalyze` | Re-run VLM with custom prompt |

### Chunks & Page Navigation (4)

| Tool | Description |
|------|-------------|
| `ocr_chunk_get` | Chunk by ID with full metadata |
| `ocr_chunk_list` | Filter by content type, section, page |
| `ocr_chunk_context` | Chunk + N neighbors for context |
| `ocr_document_page` | Page-by-page navigation |

### Embeddings (4)

| Tool | Description |
|------|-------------|
| `ocr_embedding_list` | List with filtering by document/source/model |
| `ocr_embedding_stats` | Coverage and device stats |
| `ocr_embedding_get` | Details by ID |
| `ocr_embedding_rebuild` | Re-generate (include_vlm param for VLM re-embedding) |

### Structured Extraction (3)

| Tool | Description |
|------|-------------|
| `ocr_extract_structured` | JSON schema extraction from OCR text |
| `ocr_extraction_list` | List extractions for document |
| `ocr_extraction_get` | Get extraction by ID |

### Image Extraction (1)

| Tool | Description |
|------|-------------|
| `ocr_extract_images` | File-based extraction (PyMuPDF for PDF, zipfile for DOCX) |

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
| `ocr_tag_search` | Find entities by tag (match all or any) |
| `ocr_tag_delete` | Delete tag |

### Intelligence & Guidance (5)

| Tool | Description |
|------|-------------|
| `ocr_guide` | System state inspector + next-action recommender |
| `ocr_document_tables` | Extract structured table data |
| `ocr_table_export` | Export tables as CSV/JSON/markdown |
| `ocr_document_recommend` | Related document recommendations |
| `ocr_document_extras` | Access OCR extras (charts, links, etc.) |

### Collaboration (11)

| Tool | Description |
|------|-------------|
| `ocr_annotation_create` | Create comment/suggestion/highlight on document |
| `ocr_annotation_list` | List annotations with filters |
| `ocr_annotation_get` | Get annotation by ID |
| `ocr_annotation_update` | Update annotation content/status |
| `ocr_annotation_delete` | Delete annotation |
| `ocr_annotation_summary` | Summary of annotations for document |
| `ocr_document_lock` | Acquire exclusive/shared lock (auto-expiry 30min default) |
| `ocr_document_unlock` | Release lock |
| `ocr_document_lock_status` | Check lock state |
| `ocr_search_alert_enable` | Set up alert for new matches to a query |
| `ocr_search_alert_check` | Check for new alert matches |

### Workflow & Approvals (8)

| Tool | Description |
|------|-------------|
| `ocr_workflow_submit` | Submit document for review |
| `ocr_workflow_review` | Move document through review states |
| `ocr_workflow_assign` | Assign reviewer to document |
| `ocr_workflow_status` | Get workflow state + history |
| `ocr_workflow_queue` | List documents in a given workflow state |
| `ocr_approval_chain_create` | Create multi-step approval chain |
| `ocr_approval_chain_apply` | Apply approval chain to document |
| `ocr_approval_step_decide` | Approve/reject at a step |

### Contract Lifecycle Management (9)

| Tool | Description |
|------|-------------|
| `ocr_contract_extract` | Extract contract clauses using schema |
| `ocr_obligation_list` | List obligations with filters |
| `ocr_obligation_update` | Update obligation status/details |
| `ocr_obligation_calendar` | View obligations by date range + overdue |
| `ocr_playbook_create` | Create clause comparison playbook |
| `ocr_playbook_compare` | Compare contract against playbook |
| `ocr_playbook_list` | List playbooks |
| `ocr_document_summarize` | Algorithmic single-document summary |
| `ocr_corpus_summarize` | Algorithmic corpus-wide summary |

### Compliance & Audit (3)

| Tool | Description |
|------|-------------|
| `ocr_compliance_report` | PROV-AGENT compliance report |
| `ocr_compliance_hipaa` | HIPAA compliance check |
| `ocr_compliance_export` | SOC2/SOX/HIPAA export package |

### Events & Webhooks (6)

| Tool | Description |
|------|-------------|
| `ocr_webhook_create` | Register webhook (HMAC-SHA256 signed) |
| `ocr_webhook_list` | List active webhooks |
| `ocr_webhook_delete` | Remove webhook |
| `ocr_export_obligations_csv` | Export obligations as CSV |
| `ocr_export_audit_log` | Export audit log |
| `ocr_export_annotations` | Export annotations |

### Users & Audit (2)

| Tool | Description |
|------|-------------|
| `ocr_user_info` | Current user/session info |
| `ocr_audit_query` | Query audit log with filters |

### Reports & Analytics (8)

| Tool | Description |
|------|-------------|
| `ocr_report_overview` | Consolidated: section='quality'\|'corpus'\|'all' |
| `ocr_report_performance` | section='pipeline'\|'throughput'\|'bottlenecks'\|'all' |
| `ocr_evaluation_report` | OCR + VLM quality metrics |
| `ocr_document_report` | Single document full report |
| `ocr_cost_summary` | Cost by document/mode/month |
| `ocr_error_analytics` | Error rates and failure patterns |
| `ocr_trends` | Unified: metric='quality'\|'volume', granularity=hourly/daily/weekly/monthly |
| `ocr_evaluate` | Unified: scope='single'\|'document'\|'pending' |

### Configuration (2)

| Tool | Description |
|------|-------------|
| `ocr_config_get` | View system configuration |
| `ocr_config_set` | Update at runtime |

### Health (1)

| Tool | Description |
|------|-------------|
| `ocr_health_check` | Detect and auto-fix integrity gaps |

---

## Search Deep Dive

### Mode Selection

| Mode | Best For | Speed |
|------|----------|-------|
| `keyword` | Exact terms, codes, names, case numbers, CFR refs | Fastest (<10ms) |
| `semantic` | Concepts, paraphrases, meaning-based queries | Medium |
| `hybrid` | General queries, mixed exact+conceptual (recommended default) | <500ms |

### Search Parameters

```
ocr_search {
  query: "...",
  mode: "hybrid",           // keyword | semantic | hybrid
  limit: 20,
  rerank: true,             // Local cross-encoder reranking
  include_provenance: true,
  compact: true,            // 77% token reduction in response

  // Nested filters object
  filters: {
    document_filter: "invoice",
    metadata_filter: { author: "..." },
    content_type_filter: "table",
    heading_filter: "Section 3",
    page_range_filter: { min_page: 1, max_page: 10 },
    section_path_filter: "Introduction/"
  },

  // Mode-specific params
  phrase_search: true,      // keyword mode: exact phrase match
  similarity_threshold: 0.5,// semantic mode: min cosine similarity
  bm25_weight: 0.4,        // hybrid: BM25 weight (default auto-routed)
  semantic_weight: 0.6,     // hybrid: semantic weight
  auto_route: true          // hybrid: auto-adjust weights by query type
}
```

### Auto-Routing (hybrid mode)

`auto_route=true` (default) classifies queries:
- Exact terms/codes -> higher BM25 weight
- Conceptual questions -> higher semantic weight
- Mixed -> balanced RRF fusion

### Always-On Defaults

Quality-weighted ranking, query expansion, chunk deduplication, header/footer exclusion, cluster context. No configuration needed.

---

## Core Workflows

### Workflow 1: Ingest -> Search

```
ocr_db_create { name: "my-project" }
ocr_db_select { name: "my-project" }
ocr_ingest_directory { directory_path: "/path/to/docs", recursive: true }
ocr_process_pending { ocr_mode: "balanced" }
ocr_search { query: "termination clause", mode: "hybrid" }
ocr_rag_context { query: "What are the termination conditions?" }
```

### Workflow 2: Deep Analysis

```
(After ingest + process)
ocr_cluster_documents { algorithm: "hdbscan" }
ocr_cluster_list {}
ocr_cluster_get { cluster_id: "..." }
ocr_comparison_discover { min_similarity: 0.7 }
ocr_comparison_batch { pairs: [...discovered pairs...] }
ocr_tag_create { name: "anomaly", color: "#ff0000" }
ocr_tag_apply { tag_name: "anomaly", entity_id: "doc-123", entity_type: "document" }
```

### Workflow 3: Legal Discovery with Provenance

```
(After ingest with ocr_mode: "accurate")
ocr_search { query: "breach of fiduciary duty", mode: "hybrid", include_provenance: true }
ocr_provenance_verify { item_id: "chunk-456" }
ocr_provenance_export { scope: "document", format: "w3c-prov", document_id: "doc-123" }
ocr_search_export { query: "breach", format: "csv" }
ocr_compliance_export { standard: "soc2", document_id: "doc-123" }
```

### Workflow 4: Image-Heavy Documents

```
(After ingest + process)
ocr_vlm_process { scope: "pending" }
ocr_image_search { query: "signature on contract" }
ocr_image_reanalyze { image_id: "img-789", prompt: "Is this signature authentic?" }
ocr_document_tables { document_id: "doc-123" }
ocr_table_export { document_id: "doc-123", format: "csv" }
```

### Workflow 5: Contract Lifecycle Management

```
(After ingest + process)
ocr_contract_extract { document_id: "doc-123" }
ocr_obligation_list { document_id: "doc-123" }
ocr_obligation_calendar { start_date: "2026-01-01", end_date: "2026-12-31" }
ocr_playbook_create { name: "standard-nda", clauses: [...] }
ocr_playbook_compare { document_id: "doc-456", playbook_id: "pb-001" }
ocr_document_summarize { document_id: "doc-123" }
```

### Workflow 6: Collaborative Review

```
ocr_document_lock { document_id: "doc-123", lock_type: "exclusive" }
ocr_annotation_create { document_id: "doc-123", type: "comment", content: "Review this clause", page: 5 }
ocr_workflow_submit { document_id: "doc-123" }
ocr_approval_chain_create { name: "legal-review", steps: [...] }
ocr_approval_chain_apply { document_id: "doc-123", chain_id: "chain-001" }
ocr_approval_step_decide { step_id: "step-001", decision: "approved" }
ocr_document_unlock { document_id: "doc-123" }
```

### Workflow 7: Compliance Audit

```
ocr_provenance_verify { item_id: "doc-123" }
ocr_compliance_report { document_id: "doc-123" }
ocr_compliance_hipaa { document_id: "doc-123" }
ocr_audit_query { action: "document_access", start_date: "2026-01-01" }
ocr_export_audit_log { start_date: "2026-01-01", end_date: "2026-02-26" }
```

---

## Use Cases

### Legal Document Review
- DB per case. `accurate` OCR. Keyword for case numbers/terms, semantic for concepts. Cluster for groupings. Tag by relevance (relevant/privileged/non-responsive). W3C PROV export for chain-of-custody. Compare for duplicate filings. Cost reports for billing. Compliance exports for court.

### Contract Management
- DB per contract type. Extract clauses, track obligations, compare against playbooks. Workflow states for approval pipeline. Calendar view for renewals/deadlines. Tag by risk level. Summarize for executive review.

### Medical Records
- Structured extraction for lab values, diagnoses, medications. Cluster by condition. VLM for medical images. HIPAA compliance checks. Annotation for clinical notes.

### Financial Audit
- DB per fiscal year. Structured extraction for invoice fields. Compare year-over-year statements. Cluster invoices by vendor. Tag anomalies. Audit log export for regulators.

### Research Papers
- Semantic search for themes. Cluster by topic. Compare methodology sections. Tag by inclusion/exclusion criteria. Structured extraction for sample sizes, p-values. Corpus summary.

### Insurance Claims
- VLM for damage photos. Structured extraction for claim fields. Compare similar claims. Cluster by type. Workflow states for claim lifecycle.

---

## Case Study: 13,688 Commercial Driver Logs

**Scenario**: ~500K pages of 36-40 page PDF driver logs for litigation.

### Phase-by-Phase Approach

**Phase 0: Setup**
```
ocr_db_create { name: "trucking-case-cdl-logs" }
ocr_db_select { name: "trucking-case-cdl-logs" }
ocr_config_set { key: "datalab_default_mode", value: "accurate" }
ocr_config_set { key: "datalab_max_concurrent", value: "5" }
ocr_config_set { key: "auto_cluster_enabled", value: "true" }
ocr_config_set { key: "auto_cluster_threshold", value: "100" }
```

**Phase 1: Ingest** (fast -- registration only, no OCR yet)
```
ocr_ingest_directory { directory_path: "/data/cdl-logs/", recursive: true }
```

**Phase 2: Process** (~9-10 hours at 5 concurrent, accurate mode)
```
ocr_process_pending { batch_size: 50 }
ocr_status {}   // Check progress. Search completed docs while others process.
```

**Phase 3: Search Strategy**

Keyword (exact regulatory terms):
```
ocr_search { query: "395.8", mode: "keyword", phrase_search: true, limit: 100 }
ocr_search { query: "hours of service violation", mode: "keyword" }
```

Semantic (conceptual):
```
ocr_search { query: "annotations indicating driver fatigue", mode: "semantic" }
ocr_search { query: "discrepancies between electronic and paper logs", mode: "hybrid" }
```

**Phase 4: Structured Extraction**
```
ocr_extract_structured {
  document_id: "doc-001",
  page_schema: {
    "driver_name": { "type": "string" },
    "date": { "type": "string" },
    "total_driving_hours": { "type": "number" },
    "violations_noted": { "type": "array", "items": { "type": "string" } },
    "annotations": { "type": "array", "items": { "type": "string" } }
  }
}
```

**Phase 5: VLM for Handwritten Annotations**
```
ocr_vlm_process { scope: "pending" }
ocr_image_search { query: "handwritten annotation on driver log form" }
ocr_image_reanalyze { image_id: "img-456", prompt: "Describe handwritten annotations, corrections, margin notes, or alterations." }
```

**Phase 6: Cluster + Compare**
```
ocr_cluster_documents { algorithm: "hdbscan" }
ocr_document_duplicates { min_similarity: 0.85 }
ocr_comparison_discover { min_similarity: 0.7 }
```

**Phase 7: Tag + Export**
```
ocr_tag_create { name: "hos-violation", color: "#ff0000" }
ocr_tag_create { name: "key-evidence", color: "#9900cc" }
ocr_tag_apply { tag_name: "hos-violation", entity_id: "doc-123", entity_type: "document" }
ocr_provenance_verify { item_id: "doc-123" }
ocr_provenance_export { scope: "document", document_id: "doc-123", format: "w3c-prov" }
ocr_search_export { query: "hours of service violation", format: "csv" }
```

### Expected Scale

| Metric | Estimate |
|--------|----------|
| Pages processed | ~500,000 |
| Chunks | ~1,500,000-2,000,000 |
| Embeddings | ~1,500,000-2,000,000 |
| Database size | ~15-30 GB |
| Search latency | <10ms BM25, <500ms hybrid |
| Provenance records | ~5,000,000+ |

### Tips for Large Scale
1. Process in batches of 500-1000. Search completed docs while others process.
2. Use keyword mode for regulatory terms -- faster and more precise.
3. Save searches via `ocr_search_saved { action: "save", ... }`. Re-run as more docs complete.
4. Use `ocr_retry_failed` with `accurate` mode for poor-quality scans.
5. Tag aggressively -- tags are cheap.
6. Export incrementally, don't wait for completion.
7. Split across databases by year/driver; use `ocr_search_cross_db` to search all at once.

---

## Performance

| Component | Rate | Notes |
|-----------|------|-------|
| OCR (Datalab) | ~5 docs/min per job | 1-10 concurrent configurable |
| Embedding (CUDA) | 2000+ chunks/sec | Batch size 512 |
| Embedding (MPS) | ~100 chunks/sec | Apple Silicon |
| Embedding (CPU) | ~20 chunks/sec | Fallback |
| BM25 search | <10ms | FTS5 on-disk |
| Vector search | <20ms / 100K vectors | sqlite-vec cosine |
| Hybrid search | <500ms | BM25 + vector + RRF + rerank |
| VLM (Gemini) | ~1 image/sec | Rate limited |
| Clustering | <5s / 100 docs | scikit-learn |
| Provenance verify | <100ms | Re-hash chain |

### Database Sizing

| Documents | Pages | Chunks | DB Size |
|-----------|-------|--------|---------|
| 100 | 3,000 | 10,000 | ~200 MB |
| 1,000 | 30,000 | 100,000 | ~2 GB |
| 10,000 | 300,000 | 1,000,000 | ~15 GB |

---

## Configuration Reference

All environment variables can be changed at runtime via `ocr_config_set` without restarting.

```
ocr_config_set { key: "datalab_default_mode", value: "accurate" }
ocr_config_set { key: "embedding_device", value: "cuda" }
ocr_config_set { key: "auto_cluster_enabled", value: "true" }
```

### Search Mode Quick Reference

| Mode | Best For |
|------|----------|
| `keyword` | Exact terms, codes, names, case numbers |
| `semantic` | Concepts, paraphrases, meaning-based |
| `hybrid` | General queries (recommended default) |

### Provenance Export Formats

| Format | Use Case |
|--------|----------|
| `json` | Machine-readable integration |
| `w3c-prov` | W3C PROV-JSON regulatory compliance |
| `csv` | Spreadsheet analysis |

---

## Provenance Chain

Every processing step creates a cryptographic record:

```
DOCUMENT (depth 0)
  -> OCR_RESULT (depth 1) / FORM_FILL (depth 0)
    -> CHUNK (depth 2) / IMAGE (depth 2) / EXTRACTION (depth 2) / COMPARISON (depth 2) / CLUSTERING (depth 2)
      -> EMBEDDING (depth 3) / VLM_DESC (depth 3)
        -> EMBEDDING (depth 4, from VLM text)
```

Each record has: SHA-256 content hash, chain-hash (Merkle-like linking parent hashes), processor name, timestamps, quality scores, and parent/source references. Verify any chain with `ocr_provenance_verify`.

---

## Workflow State Machine

```
(none) -> draft -> submitted -> in_review -> approved -> executed -> archived
                                          -> rejected
                                          -> changes_requested -> submitted (loop)
```

Valid transitions are enforced. Use `ocr_workflow_submit` to start, `ocr_workflow_review` to advance states.

---

## Quick Start Card

```
1. ocr_guide                                        // System state
2. ocr_db_create { name: "my-project" }             // Create DB
3. ocr_db_select { name: "my-project" }             // Activate
4. ocr_ingest_directory { directory_path: "/path/" } // Register files
5. ocr_process_pending {}                            // OCR + chunk + embed
6. ocr_search { query: "...", mode: "hybrid" }       // Search
7. ocr_rag_context { query: "..." }                  // LLM-ready context
```

**Exact term**: `ocr_search { query: "case 2024-1234", mode: "keyword" }`
**Concept**: `ocr_search { query: "settlement terms", mode: "semantic" }`
**Best of both**: `ocr_search { query: "breach of contract", mode: "hybrid" }`
**With page filter**: `ocr_search { query: "signature", mode: "hybrid", filters: { page_range_filter: { min_page: 35, max_page: 40 } } }`
**Export**: `ocr_search_export { query: "violation", format: "csv" }`
**Cluster**: `ocr_cluster_documents { algorithm: "hdbscan" }`
**Compare**: `ocr_document_compare { document_id_1: "...", document_id_2: "..." }`
**Duplicates**: `ocr_document_duplicates { min_similarity: 0.85 }`
**Verify**: `ocr_provenance_verify { item_id: "..." }`
**Fix gaps**: `ocr_health_check { fix: true }`

---

*Version 1.0.5 | Schema v32 | 141 MCP tools | 2026-02-26*
