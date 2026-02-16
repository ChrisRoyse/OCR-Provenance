# OCR Provenance MCP Server

A comprehensive [Model Context Protocol](https://modelcontextprotocol.io/) server for document OCR processing, semantic search, entity extraction, knowledge graph construction, and full provenance tracking.

Built with TypeScript and Python, backed by SQLite with vector search extensions. Designed for use with Claude Desktop, Claude Code, and any MCP-compatible client.

[![License: Dual](https://img.shields.io/badge/License-Free_Non--Commercial-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple)](https://modelcontextprotocol.io/)

---

## What It Does

Drop documents into the system and get back a fully searchable, entity-linked, provenance-tracked knowledge base:

```
Documents (PDF, DOCX, images)
    -> OCR text extraction (Datalab API)
    -> Text chunking + GPU embeddings (nomic-embed-text-v1.5)
    -> Named entity extraction (Gemini AI)
    -> Knowledge graph construction
    -> Hybrid search (BM25 + vector + entity-aware)
    -> Question answering with RAG
```

Every piece of data carries a SHA-256 provenance chain from source document through every derived artifact.

## Key Features

- **104 MCP Tools** across 19 categories for end-to-end document intelligence
- **Hybrid Search** combining BM25 keyword, semantic vector, and entity-aware retrieval
- **Knowledge Graph** with 3-tier entity resolution (exact, fuzzy, AI), temporal reasoning, and contradiction detection
- **Full Provenance** with SHA-256 content hashes and W3C PROV export
- **GPU Embeddings** via local nomic-embed-text-v1.5 (768-dim, auto-detects CUDA / MPS / CPU)
- **Auto-Pipeline** processing from OCR through entity extraction, KG build, and clustering in one call
- **11 Entity Types** including medical (medication, diagnosis, medical_device)
- **Document Clustering** via HDBSCAN, agglomerative, or k-means with entity overlap weighting
- **VLM Image Analysis** using Gemini vision for image descriptions and classification
- **Form Filling** via Datalab API with KG-based field validation

---

## Architecture

```
                    +-----------------------+
                    |   MCP Client (Claude) |
                    +-----------+-----------+
                                | JSON-RPC over stdio
                    +-----------v-----------+
                    |   MCP Server (Node)   |
                    |   104 registered tools|
                    +-----------+-----------+
                       |        |        |
          +------------+   +----+----+   +----------+
          |                |         |              |
+---------v---+   +-------v--+  +---v--------+  +-v----------+
|   SQLite    |   |  Python  |  |   Gemini   |  |  Datalab   |
| + sqlite-vec|   |  Workers |  |    API     |  |    API     |
+-------------+   +----------+  +------------+  +------------+
| 28 tables   |   | 8 workers|  | entities   |  | OCR        |
| 58 indexes  |   | GPU embed|  | VLM vision |  | form fill  |
| FTS5 search |   | clustering  | classify   |  | file mgmt  |
| vec search  |   | img extract | QA answers |  |            |
+-------------+   +----------+  +------------+  +------------+
```

**Components:**
- **TypeScript MCP Server** -- 104 tools, Zod schema validation, provenance tracking
- **Python Workers** (8) -- OCR, embedding (GPU), image extraction, clustering, form fill, file management
- **SQLite + sqlite-vec** -- 28 tables, 58 indexes, FTS5 full-text search, vector similarity
- **Gemini API** -- Entity extraction, relationship classification, VLM image descriptions, QA
- **Datalab API** -- Document OCR, form filling, cloud file storage
- **nomic-embed-text-v1.5** -- 768-dim embeddings, local inference (CUDA, MPS, or CPU)

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
| `GEMINI_API_KEY` | Entity extraction, VLM, QA, relationship classification | [Google AI Studio](https://aistudio.google.com/) |

---

## Installation

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/ChrisRoyse/datalab.git
cd datalab
npm install
```

### 2. Install Python Dependencies

```bash
pip install torch transformers sentence-transformers numpy scikit-learn hdbscan pymupdf pillow python-docx requests
```

> **PyTorch GPU note:** If the above installs CPU-only PyTorch, install the CUDA version explicitly:
> ```bash
> pip install torch --index-url https://download.pytorch.org/whl/cu124
> ```

### 3. Download the Embedding Model

The system uses [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (768-dim, ~270MB) for local GPU vector embeddings. You need to download it once:

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

### 4. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys (see Configuration below)
```

### 5. Build

```bash
npm run build
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

### Claude Desktop

Add to your Claude Desktop config file:

| Platform | Config File Location |
|----------|---------------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "ocr-provenance": {
      "command": "node",
      "args": ["--max-semi-space-size=64", "/absolute/path/to/datalab/dist/index.js"],
      "env": {
        "DATALAB_API_KEY": "your_key",
        "GEMINI_API_KEY": "your_key"
      }
    }
  }
}
```

Replace `/absolute/path/to/datalab` with the full path to your cloned repo. On Windows, use forward slashes (e.g., `C:/Users/you/datalab/dist/index.js`).

Restart Claude Desktop after saving.

### Claude Code CLI

```bash
claude mcp add ocr-provenance -- node --max-semi-space-size=64 /path/to/datalab/dist/index.js
```

Then restart your Claude Code session. All 104 tools will be available immediately.

---

## Quick Start

```
1. Create a database         ->  ocr_db_create { name: "my-project" }
2. Select it                 ->  ocr_db_select { database_name: "my-project" }
3. Ingest documents          ->  ocr_ingest_directory { directory_path: "/path/to/docs" }
4. Process through pipeline  ->  ocr_process_pending { auto_extract_entities: true, auto_build_kg: true }
5. Search your documents     ->  ocr_search_hybrid { query: "your question" }
6. Ask questions             ->  ocr_question_answer { question: "What happened on March 15?" }
7. Explore the graph         ->  ocr_knowledge_graph_query { entity_name: "Dr. Smith" }
8. Verify provenance         ->  ocr_provenance_verify { item_id: "doc-id" }
```

### One-Shot Auto-Pipeline

Process everything in one call:

```json
{
  "tool": "ocr_process_pending",
  "arguments": {
    "auto_extract_entities": true,
    "auto_build_kg": true,
    "auto_extract_vlm_entities": true,
    "auto_coreference_resolve": true,
    "auto_scan_contradictions": true
  }
}
```

This runs: OCR -> Chunk -> Embed -> Entity Extract -> KG Build -> Coreference -> Contradiction Scan

---

## Tool Reference

### Overview (104 Tools)

| Category | Count | Tools |
|----------|-------|-------|
| [Database Management](#database-management) | 5 | create, list, select, stats, delete |
| [Ingestion & Processing](#ingestion--processing) | 8 | ingest_directory, ingest_files, process_pending, status, retry_failed, reprocess, chunk_complete, convert_raw |
| [Document Management](#document-management) | 3 | document_list, document_get, document_delete |
| [Search & Retrieval](#search--retrieval) | 8 | search (BM25), search_semantic, search_hybrid, fts_manage, search_export, benchmark_compare, related_documents, rag_context |
| [Question Answering](#question-answering) | 1 | question_answer (RAG + Gemini) |
| [Entity Analysis](#entity-analysis) | 10 | entity_extract, entity_search, timeline_build, legal_witness_analysis, entity_extract_from_vlm, entity_extract_from_extractions, entity_extraction_stats, coreference_resolve, entity_dossier, entity_update_confidence |
| [Knowledge Graph](#knowledge-graph) | 22 | build, incremental_build, query, node, paths, stats, delete, export, merge, split, enrich, classify_relationships, normalize_weights, prune_edges, set_edge_temporal, contradictions, scan_contradictions, embed_entities, search_entities, entity_export, entity_import, visualize |
| [Document Comparison](#document-comparison) | 3 | document_compare, comparison_list, comparison_get |
| [Document Clustering](#document-clustering) | 5 | cluster_documents, cluster_list, cluster_get, cluster_assign, cluster_delete |
| [VLM / Vision](#vlm--vision-analysis) | 6 | vlm_describe, vlm_classify, vlm_process_document, vlm_process_pending, vlm_analyze_pdf, vlm_status |
| [Image Management](#image-management) | 8 | image_extract, image_list, image_get, image_stats, image_delete, image_delete_by_document, image_reset_failed, image_pending |
| [Form Fill](#form-fill) | 3 | form_fill, form_fill_status, form_fill_suggest_fields |
| [Structured Extraction](#structured-extraction) | 2 | extract_structured, extraction_list |
| [File Extraction](#file-extraction) | 3 | extract_images, extract_images_batch, extraction_check |
| [File Management](#file-management) | 5 | file_upload, file_list, file_get, file_download, file_delete |
| [Evaluation](#evaluation) | 3 | evaluate_single, evaluate_document, evaluate_pending |
| [Reports & Analytics](#reports--analytics) | 4 | evaluation_report, document_report, quality_summary, cost_summary |
| [Provenance](#provenance) | 3 | provenance_get, provenance_verify, provenance_export |
| [Configuration](#configuration) | 2 | config_get, config_set |

All tools are prefixed with `ocr_`. For example: `ocr_db_create`, `ocr_search_hybrid`, `ocr_knowledge_graph_build`.

---

### Database Management

| Tool | Description |
|------|-------------|
| `ocr_db_create` | Create a new isolated database |
| `ocr_db_list` | List all databases with optional stats |
| `ocr_db_select` | Select the active database for all operations |
| `ocr_db_stats` | Detailed statistics including KG health metrics |
| `ocr_db_delete` | Permanently delete a database |


### Ingestion & Processing

| Tool | Description |
|------|-------------|
| `ocr_ingest_directory` | Scan directory and register documents (PDF, DOCX, images) |
| `ocr_ingest_files` | Ingest specific files by path |
| `ocr_process_pending` | Full OCR pipeline with auto-pipeline flags |
| `ocr_status` | Check processing status |
| `ocr_retry_failed` | Reset failed documents for reprocessing |
| `ocr_reprocess` | Reprocess with different OCR settings |
| `ocr_chunk_complete` | Repair documents missing chunks/embeddings |
| `ocr_convert_raw` | Convert via OCR without storing results |

### Search & Retrieval

| Tool | Best For | Method |
|------|----------|--------|
| `ocr_search` | Exact terms, codes, IDs, phrases | BM25 full-text (FTS5, porter stemming) |
| `ocr_search_semantic` | Conceptual queries, paraphrases | Vector similarity (nomic-embed-text-v1.5) |
| `ocr_search_hybrid` | General queries (recommended) | Reciprocal Rank Fusion (BM25 + semantic) |
| `ocr_rag_context` | LLM context assembly | Hybrid + entity enrichment + KG paths |
| `ocr_related_documents` | Find connected documents | Knowledge graph entity overlap |
| `ocr_search_export` | Export results to file | CSV or JSON export |
| `ocr_benchmark_compare` | Cross-database comparison | Multi-database search benchmarking |
| `ocr_fts_manage` | Index maintenance | FTS5 rebuild/status |

**Search enhancement features** (all three search modes):
- `entity_filter` -- Filter by entity names, types, or related entities
- `time_range` -- Temporal filtering via KG edge dates
- `cluster_id` -- Restrict to a document cluster
- `expand_query` -- Semantic query expansion using KG entities
- `rerank` -- Entity-frequency reranking
- `include_entities` / `include_provenance` / `include_cluster_context`

### Entity Analysis

| Tool | Description |
|------|-------------|
| `ocr_entity_extract` | Extract entities via Gemini AI (segmented, 50K char chunks) |
| `ocr_entity_search` | Search entities by name, type, or document |
| `ocr_timeline_build` | Build chronological timeline from date entities |
| `ocr_legal_witness_analysis` | Expert witness analysis using Gemini thinking mode |
| `ocr_entity_extract_from_vlm` | Extract entities from VLM image descriptions |
| `ocr_entity_extract_from_extractions` | Create entities from structured extraction fields |
| `ocr_entity_extraction_stats` | Entity extraction quality analytics |
| `ocr_coreference_resolve` | Resolve pronouns/abbreviations to named entities |
| `ocr_entity_dossier` | Comprehensive entity profile (mentions, relationships, timeline) |
| `ocr_entity_update_confidence` | Recalculate confidence scores |

**Supported entity types:** `person`, `organization`, `date`, `amount`, `location`, `case_number`, `statute`, `exhibit`, `medication`, `diagnosis`, `medical_device`

### Knowledge Graph

22 tools for building, querying, and managing an entity-based knowledge graph.

| Tool | Description |
|------|-------------|
| `ocr_knowledge_graph_build` | Build/rebuild graph with entity resolution |
| `ocr_knowledge_graph_incremental_build` | Add documents without full rebuild |
| `ocr_knowledge_graph_query` | Query with entity/relationship filtering |
| `ocr_knowledge_graph_node` | Get detailed node information |
| `ocr_knowledge_graph_paths` | Find paths between entities |
| `ocr_knowledge_graph_stats` | Graph-wide statistics |
| `ocr_knowledge_graph_delete` | Delete graph data |
| `ocr_knowledge_graph_export` | Export as GraphML, CSV, or JSON-LD |
| `ocr_knowledge_graph_merge` | Merge duplicate nodes |
| `ocr_knowledge_graph_split` | Split a node by entity links |
| `ocr_knowledge_graph_enrich` | Enrich nodes from multiple sources |
| `ocr_knowledge_graph_classify_relationships` | Classify edges via Gemini + rules |
| `ocr_knowledge_graph_normalize_weights` | Normalize edge weights |
| `ocr_knowledge_graph_prune_edges` | Remove low-quality edges |
| `ocr_knowledge_graph_set_edge_temporal` | Set temporal bounds on edges |
| `ocr_knowledge_graph_contradictions` | Query contradictory edges |
| `ocr_knowledge_graph_scan_contradictions` | Proactive contradiction detection |
| `ocr_knowledge_graph_embed_entities` | Generate node embeddings (GPU) |
| `ocr_knowledge_graph_search_entities` | Semantic entity search |
| `ocr_knowledge_graph_entity_export` | Export entity data |
| `ocr_knowledge_graph_entity_import` | Import external entities with matching |
| `ocr_knowledge_graph_visualize` | Generate Mermaid diagrams |

**Entity resolution modes:**
- **exact** -- String-identical entities only
- **fuzzy** -- Sorensen-Dice similarity >= 0.85 (0.75 for persons)
- **ai** -- Gemini semantic matching for the 0.70-0.85 similarity range

**Relationship types:** `co_mentioned`, `co_located`, `employed_by`, `located_in`, `filed_on`, `prescribed`, `treated_with`, `diagnosed_with`, `administered_via`, `managed_by`, `interacts_with`, and more via rule-based + Gemini classification

### Document Comparison

| Tool | Description |
|------|-------------|
| `ocr_document_compare` | Compare two documents (text diff, entity diff, contradictions) |
| `ocr_comparison_list` | List comparisons |
| `ocr_comparison_get` | Get full comparison details |

### Document Clustering

| Tool | Description |
|------|-------------|
| `ocr_cluster_documents` | Cluster by semantic + entity similarity (HDBSCAN/agglomerative/k-means) |
| `ocr_cluster_list` | List clusters with optional entity counts |
| `ocr_cluster_get` | Detailed cluster info with shared entities |
| `ocr_cluster_assign` | Auto-assign document to nearest cluster |
| `ocr_cluster_delete` | Delete a clustering run |

### VLM / Vision Analysis

| Tool | Description |
|------|-------------|
| `ocr_vlm_describe` | Describe an image using Gemini vision |
| `ocr_vlm_classify` | Classify image type and complexity |
| `ocr_vlm_process_document` | Process all images in a document |
| `ocr_vlm_process_pending` | Process all pending images |
| `ocr_vlm_analyze_pdf` | Direct PDF analysis with Gemini vision |
| `ocr_vlm_status` | VLM service status |

### Form Fill

| Tool | Description |
|------|-------------|
| `ocr_form_fill` | Fill PDF/image forms via Datalab with KG validation |
| `ocr_form_fill_status` | Get form fill operation status |
| `ocr_form_fill_suggest_fields` | Suggest field values from entities and KG |

### Additional Tool Categories

**Structured Extraction** (2): Extract structured data using JSON schemas
**File Extraction** (3): Extract images from PDFs/DOCX using local Python tools (PyMuPDF)
**File Management** (5): Upload/download files via Datalab cloud storage
**Evaluation** (3): Evaluate image descriptions and OCR quality
**Reports & Analytics** (4): Quality reports, cost summaries, document reports
**Provenance** (3): Get, verify, and export provenance chains (JSON, W3C PROV, CSV)
**Configuration** (2): Get/set runtime configuration

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
|   |   +-- EVALUATION (depth 3)
|   +-- ENTITY_EXTRACTION (depth 2)
|   |   +-- ENTITY_EMBEDDING (depth 3)
|   +-- EXTRACTION (depth 2)
+-- FORM_FILL (depth 0)
+-- COMPARISON (depth 2)
+-- CLUSTERING (depth 2)
+-- KNOWLEDGE_GRAPH (depth 2)
```

**28 tables** covering documents, OCR results, chunks, embeddings, images, entities, knowledge graph nodes/edges, extractions, comparisons, clusters, form fills, uploaded files, provenance, FTS5 search index, and configuration.

---

## Python Workers

Eight Python workers handle computationally intensive tasks:

| Worker | Purpose |
|--------|---------|
| `ocr_worker.py` | Datalab API OCR processing |
| `embedding_worker.py` | nomic-embed-text-v1.5 GPU inference |
| `image_extractor.py` | PyMuPDF PDF image extraction |
| `docx_image_extractor.py` | python-docx image extraction |
| `image_optimizer.py` | Image format conversion and optimization |
| `form_fill_worker.py` | Datalab form fill API |
| `file_manager_worker.py` | Datalab cloud file operations |
| `clustering_worker.py` | scikit-learn clustering (HDBSCAN/agglomerative/k-means) |

All workers output JSON to stdout and log to stderr. They are invoked by the TypeScript server via `child_process.spawn`.

---

## Development

```bash
# Build
npm run build

# Run tests
npm test                  # Unit + integration tests
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
  index.ts                  # MCP server entry point
  tools/                    # 19 tool files + shared.ts
  services/                 # OCR, embedding, storage, chunking, KG, entity services
  models/                   # Zod schemas and TypeScript types
  utils/                    # Helpers (hash, entity extraction, etc.)
python/                     # 8 Python workers
tests/
  unit/                     # Unit tests
  integration/              # Integration tests
  gpu/                      # GPU-specific tests
  manual/                   # Manual verification tests
```

---

## Troubleshooting

### sqlite-vec loading errors
```
Error: Cannot find module 'sqlite-vec'
```
Run `npm install` — sqlite-vec uses a prebuilt binary that must match your platform and Node.js version.

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