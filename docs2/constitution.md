# Constitution: OCR Provenance MCP System

## Test Data

**Location:** `./data/` (~1.7GB, 406 files)

- `Creeden_Witness_Folders 1/` - 1.6GB legal case PDFs (60+ witness folders)
- `IBB Constitution, Bylaws, Policies and Practices/` - 33MB policy documents
- `HOT/` - 83MB high-priority documents
- `bench/` - 2.6MB benchmark files (`doc_XXXX.{docx,pdf,txt}`)
- `images/` - 508KB screenshot PNGs

---

```xml
<constitution version="6.0">
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                              METADATA                                            -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <metadata>
    <project_name>OCR Provenance MCP System</project_name>
    <version>6.0.0</version>
    <created_date>2026-02-02</created_date>
    <last_updated>2026-02-17</last_updated>
    <schema_version>26</schema_version>
    <description>
      MCP server providing document OCR, VLM image analysis, document clustering,
      document comparison, and hybrid search with complete data provenance tracking.
      Every piece of extracted text AND every image description maintains a complete
      chain back to the exact file, page, and character offset it came from. Built
      on Datalab API for OCR, Gemini API for VLM image analysis, nomic-embed-text-v1.5
      for local GPU embeddings, and SQLite with sqlite-vec for vector storage.
    </description>
    <domain>Document Intelligence / OCR / VLM / Provenance Tracking / Hybrid Search / Document Clustering / Legal Analysis</domain>
    <authors>
      <author role="specification">PRD Document</author>
    </authors>
    <repository>ocr-provenance-mcp</repository>
    <license>MIT</license>
    <stats>
      <mcp_tools>69</mcp_tools>
      <tool_files>16 + shared.ts</tool_files>
      <tables>19 (15 physical + 4 virtual)</tables>
      <indexes>39</indexes>
      <python_workers>8</python_workers>
      <test_count>1505 passed, 0 failed</test_count>
      <test_files>79</test_files>
      <supported_platforms>Windows, macOS (ARM + Intel), Linux</supported_platforms>
    </stats>
  </metadata>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                           CORE PRINCIPLES                                        -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <core_principles>
    <principle id="CP-001" priority="critical">
      <name>Complete Provenance Chain</name>
      <description>
        Every piece of data MUST maintain a complete chain back to its origin.
        No data exists without knowing exactly where it came from, what page,
        what character offset, and through what processing steps.
      </description>
      <enforcement>All data storage operations must include provenance records</enforcement>
    </principle>

    <principle id="CP-002" priority="critical">
      <name>Original Text Always Included</name>
      <description>
        Every search result MUST include the original text that was embedded.
        Users should NEVER need to make a follow-up query to retrieve the source text.
      </description>
      <enforcement>Embedding storage must denormalize original_text field</enforcement>
    </principle>

    <principle id="CP-003" priority="critical">
      <name>Immutable Hash Verification</name>
      <description>
        SHA-256 hashes at every processing step enable tamper detection.
        Any modification to data must be detectable through hash verification.
      </description>
      <enforcement>All content_hash fields must be computed and verified</enforcement>
    </principle>

    <principle id="CP-004" priority="high">
      <name>Local Inference Only</name>
      <description>
        Embedding generation runs locally — NEVER via cloud API.
        No data leaves the local machine for embedding generation.
        The compute device is auto-detected: CUDA (NVIDIA GPU) > MPS
        (Apple Silicon) > CPU. All devices produce identical embeddings.
      </description>
      <enforcement>
        embedding.inferenceMode must always be "local".
        EMBEDDING_DEVICE defaults to "auto" (resolve_device() in embedding_worker.py).
        Cloud embedding APIs are NEVER used regardless of device.
      </enforcement>
    </principle>

    <principle id="CP-005" priority="high">
      <name>Full Reproducibility</name>
      <description>
        All processing parameters are stored so identical inputs produce identical outputs.
        Processor versions, settings, and timestamps are always captured.
      </description>
      <enforcement>Provenance records must include processor, processor_version, processing_params</enforcement>
    </principle>

    <principle id="CP-006" priority="critical">
      <name>Images Become Searchable Text</name>
      <description>
        Every image found during OCR MUST be analyzed by a VLM which produces a
        multi-paragraph text description. That description is then embedded and
        stored so that semantic search can "see" images. This makes the entire
        document — text AND images — searchable through a single query interface.
      </description>
      <enforcement>
        Images get provenance type IMAGE (depth 2), VLM descriptions get
        VLM_DESCRIPTION (depth 3), and their embeddings get EMBEDDING (depth 4).
      </enforcement>
    </principle>

    <principle id="CP-007" priority="high">
      <name>Cloud API Permitted for VLM Only</name>
      <description>
        VLM image analysis uses cloud API calls (Gemini).
        OCR uses Datalab cloud API. Embeddings MUST still be local only
        (CUDA, MPS, or CPU — never a cloud API).
      </description>
      <enforcement>VLM calls go to Gemini API. Embedding calls NEVER go to cloud.</enforcement>
    </principle>

    <principle id="CP-008" priority="high">
      <name>Embedding Model Per Database</name>
      <description>
        The embedding model is locked per database (all vectors in one DB must use
        the same model/dimensions). But different databases CAN use different
        embedding models to enable benchmarking.
      </description>
      <enforcement>Store model name and dimensions in database metadata. Reject embeddings from wrong model.</enforcement>
    </principle>

    <principle id="CP-009" priority="medium">
      <name>Smart Image Filtering</name>
      <description>
        Not all images are worth VLM processing. A multi-layer heuristic filter
        screens images BEFORE VLM processing based on size, aspect ratio, color
        diversity, and category prediction.
      </description>
      <enforcement>
        Images failing relevance threshold (vlmMinRelevance) are skipped.
      </enforcement>
    </principle>

    <principle id="CP-010" priority="high">
      <name>Hybrid Search (BM25 + Semantic)</name>
      <description>
        Full-text keyword search via SQLite FTS5 with BM25 ranking complements
        semantic vector search. Reciprocal Rank Fusion (RRF) combines both for
        hybrid search. Gemini-powered re-ranking further enhances results.
      </description>
      <enforcement>
        BM25 search results include same provenance fields as semantic search.
        RRF fusion verifies provenance consistency between sources.
      </enforcement>
    </principle>

    <principle id="CP-011" priority="high">
      <name>Datalab File Deduplication</name>
      <description>
        Files uploaded to Datalab cloud storage are deduplicated by SHA-256
        hash. If an identical file has already been uploaded, the existing
        datalab:// reference is returned instead of re-uploading.
      </description>
      <enforcement>
        uploaded_files table tracks file_hash. Upload handler checks
        getUploadedFileByHash() before initiating upload.
      </enforcement>
    </principle>

    <principle id="CP-014" priority="medium">
      <name>Gemini Thinking Mode for Complex Analysis</name>
      <description>
        Complex image analysis uses Gemini's thinking mode for deeper,
        more accurate descriptions with chain-of-thought reasoning.
      </description>
      <enforcement>
        use_thinking parameter on ocr_vlm_describe activates thinking preset.
      </enforcement>
    </principle>

    <principle id="CP-016" priority="medium">
      <name>Document Clustering</name>
      <description>
        Documents can be clustered by semantic similarity using HDBSCAN,
        agglomerative, or k-means algorithms. Pure embedding-based clustering
        using cosine similarity.
      </description>
      <enforcement>
        Python clustering_worker.py via scikit-learn. Ward linkage excluded
        (incompatible with cosine distance). Cluster provenance tracked.
      </enforcement>
    </principle>

    <principle id="CP-017" priority="medium">
      <name>Document Comparison</name>
      <description>
        Document pairs can be compared for text diff and structural metadata diff.
        Duplicate detection via input_hash.
      </description>
      <enforcement>
        diff npm package v8.0.3, Sorensen-Dice similarity ratio.
        Comparison provenance tracked.
      </enforcement>
    </principle>
  </core_principles>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                           TECHNOLOGY STACK                                       -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <tech_stack>
    <!-- Primary Languages -->
    <languages>
      <language name="TypeScript" version="5.x" purpose="MCP server implementation">
        <config>strict mode enabled, ES2022 target</config>
      </language>
      <language name="Python" version="3.10+" purpose="OCR worker, embedding worker, clustering, image extraction">
        <config>Type hints required, async/await for I/O operations</config>
      </language>
    </languages>

    <!-- Runtime Environments -->
    <runtimes>
      <runtime name="Node.js" version="20+ LTS" purpose="MCP server runtime">
        <constraints>ES modules, native fetch API</constraints>
      </runtime>
      <runtime name="CUDA" version="12.0+" purpose="GPU acceleration (optional)">
        <constraints>
          Auto-detected when available. Not required — MPS and CPU are supported.
          For Blackwell/sm_120: requires PyTorch nightly with cu131 or building
          from source with TORCH_CUDA_ARCH_LIST="12.0".
        </constraints>
      </runtime>
    </runtimes>

    <!-- Core Frameworks & SDKs -->
    <frameworks>
      <framework name="@modelcontextprotocol/sdk" version="latest" purpose="MCP protocol implementation">
        <usage>Server creation, tool registration, transport handling</usage>
      </framework>
      <framework name="sentence-transformers" version=">=2.7.0" purpose="Embedding model loading">
        <usage>Load and run nomic-embed-text-v1.5 model</usage>
      </framework>
      <framework name="PyTorch" version="2.0+" purpose="Local inference runtime">
        <usage>CUDA tensors, MPS tensors, or CPU tensors (auto-detected)</usage>
      </framework>
      <framework name="scikit-learn" version=">=1.3.0" purpose="Document clustering algorithms">
        <usage>HDBSCAN, AgglomerativeClustering, KMeans, silhouette_score</usage>
      </framework>
    </frameworks>

    <!-- Database & Storage -->
    <databases>
      <database name="SQLite" version="3.45+" purpose="Primary data storage">
        <constraints>WAL mode, restricted file permissions (600)</constraints>
      </database>
      <database name="sqlite-vec" version="0.1+" purpose="Vector similarity search">
        <constraints>768-dimensional float32 vectors, cosine similarity</constraints>
      </database>
    </databases>

    <!-- ML Models -->
    <ml_models>
      <model name="nomic-embed-text-v1.5" version="1.5.x" purpose="Default text embeddings">
        <specifications>
          <dimension>768</dimension>
          <max_sequence_length>8192</max_sequence_length>
          <task_types>search_document, search_query</task_types>
          <inference_mode>local only (auto-detect: CUDA > MPS > CPU)</inference_mode>
        </specifications>
      </model>
      <model name="Gemini" version="gemini-3-flash-preview (ALL tasks, mandatory)" purpose="VLM image analysis, re-ranking, query expansion">
        <specifications>
          <inference_mode>cloud API</inference_mode>
          <model_id>gemini-3-flash-preview</model_id>
          <forbidden_models>gemini-2.0-flash, gemini-2.5-flash (NEVER use these)</forbidden_models>
          <input_context>1M tokens (enough for any single document)</input_context>
          <output_tokens>65K tokens max (responseSchema for structured JSON)</output_tokens>
          <thinking_mode>thinkingConfig: { thinkingLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL' }</thinking_mode>
          <input>Images (base64)</input>
          <output>structured JSON with descriptions, confidence</output>
          <prompts>legal, medical, universal (context-dependent selection)</prompts>
          <critical_note>
            Thinking tokens share the output token budget. Always set
            maxOutputTokens to 65536 to prevent truncated JSON responses.
          </critical_note>
        </specifications>
      </model>
    </ml_models>

    <!-- Hardware Requirements -->
    <hardware>
      <component name="GPU" required="false">
        <minimum>Any CUDA-capable GPU or Apple Silicon (MPS)</minimum>
        <recommended>NVIDIA RTX 4090/5090 (24-32GB VRAM)</recommended>
        <purpose>Accelerated embedding generation (falls back to CPU if unavailable)</purpose>
        <platforms>
          <platform name="Linux">CUDA (NVIDIA GPU)</platform>
          <platform name="macOS (ARM)">MPS (Apple Silicon)</platform>
          <platform name="macOS (Intel)">CPU only</platform>
          <platform name="Windows">CUDA (NVIDIA GPU) or CPU</platform>
        </platforms>
      </component>
      <component name="System RAM" required="true">
        <minimum>16 GB</minimum>
        <recommended>32+ GB</recommended>
      </component>
      <component name="Storage" required="true">
        <minimum>SSD</minimum>
        <recommended>NVMe SSD</recommended>
        <purpose>Database storage with fast random access</purpose>
      </component>
    </hardware>

    <!-- Validation & Utilities -->
    <libraries>
      <library name="Zod" version="3.25+" purpose="Schema validation">
        <usage>Input validation for all MCP tool parameters</usage>
      </library>
      <library name="crypto" version="built-in" purpose="SHA-256 hashing">
        <usage>Content hashing for provenance integrity</usage>
      </library>
      <library name="PyMuPDF (fitz)" version="latest" purpose="PDF image extraction">
        <usage>Extract images with bounding boxes from PDFs</usage>
      </library>
      <library name="Pillow" version="latest" purpose="Image processing">
        <usage>Image format conversion, resizing, color analysis for optimization</usage>
      </library>
      <library name="better-sqlite3" version="11.0+" purpose="SQLite with FTS5">
        <usage>Synchronous SQLite with FTS5 full-text search support</usage>
      </library>
      <library name="diff" version="8.0.3" purpose="Document comparison">
        <usage>Text diff operations and Sorensen-Dice similarity computation</usage>
      </library>
      <library name="uuid" version="11.0+" purpose="UUID generation">
        <usage>Generate v4 UUIDs for all entity IDs</usage>
      </library>
      <library name="dotenv" version="16.0+" purpose="Environment variable loading">
        <usage>Load .env at startup in src/index.ts</usage>
      </library>
    </libraries>

    <!-- System Dependencies (apt/brew) -->
    <system_dependencies>
      <dependency name="inkscape" purpose="EMF/WMF vector image conversion">
        <install>sudo apt install inkscape</install>
        <usage>Convert Windows metafile formats (EMF/WMF from DOCX) to PNG for VLM processing</usage>
      </dependency>
    </system_dependencies>

    <!-- External APIs -->
    <external_apis>
      <api name="Datalab API" version="1.0" base_url="https://www.datalab.to/api/v1">
        <endpoints>
          <endpoint path="/marker" method="POST" purpose="Document OCR conversion"/>
          <endpoint path="/marker/{request_id}" method="GET" purpose="Check processing status"/>
          <endpoint path="/fill" method="POST" purpose="Form filling"/>
          <endpoint path="/fill/{request_id}" method="GET" purpose="Get filled form result"/>
          <endpoint path="/files/upload" method="POST" purpose="Get presigned upload URL"/>
          <endpoint path="/files" method="GET" purpose="List uploaded files"/>
          <endpoint path="/files/{file_id}" method="GET" purpose="Get file metadata"/>
          <endpoint path="/files/{file_id}" method="DELETE" purpose="Delete file"/>
          <endpoint path="/files/{file_id}/confirm" method="GET" purpose="Confirm upload"/>
          <endpoint path="/files/{file_id}/download" method="GET" purpose="Get download URL"/>
        </endpoints>
        <authentication>API key via X-Api-Key header</authentication>
        <rate_limits>200 req/min, based on subscription tier</rate_limits>
        <file_size_limit>200 MB</file_size_limit>
        <pages_per_request_limit>7000</pages_per_request_limit>
      </api>
      <api name="Gemini API" purpose="VLM image analysis, search re-ranking, query expansion">
        <authentication>API key via env:GEMINI_API_KEY</authentication>
        <models>
          <model id="gemini-3-flash-preview" purpose="All tasks: VLM, re-ranking, query expansion"/>
        </models>
        <usage>
          Analyze images, re-rank search results, expand search queries.
        </usage>
        <rate_limits>1000 RPM, 4M TPM (managed by GeminiRateLimiter)</rate_limits>
        <capabilities>
          <capability name="thinking_mode" status="implemented">
            thinkingConfig: { thinkingLevel: 'HIGH' } for extended reasoning.
          </capability>
          <capability name="response_schema" status="implemented">
            response_mime_type: 'application/json' with response_schema.
          </capability>
        </capabilities>
        <prompt_types>
          <prompt name="legal">Legal document focus</prompt>
          <prompt name="medical">Clinical content, medical records</prompt>
          <prompt name="universal">Context-independent 3-paragraph description</prompt>
        </prompt_types>
      </api>
    </external_apis>
  </tech_stack>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                         DIRECTORY STRUCTURE                                      -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <directory_structure>
    <root name="ocr-provenance-mcp">
      <!-- Configuration Files -->
      <file name="package.json" purpose="Node.js project configuration"/>
      <file name="tsconfig.json" purpose="TypeScript configuration"/>
      <file name=".env.example" purpose="Environment variable template"/>

      <!-- Source Code -->
      <directory name="src" purpose="TypeScript source code">
        <file name="index.ts" purpose="MCP server entry point (loads dotenv, registers 69 tools)"/>

        <directory name="server" purpose="Server state and configuration">
          <file name="state.ts" purpose="Global state (selected database, config)"/>
          <file name="types.ts" purpose="ServerConfig interface with all config keys"/>
          <file name="errors.ts" purpose="MCPError class, error codes"/>
        </directory>

        <directory name="tools" purpose="MCP tool implementations (16 files)">
          <file name="shared.ts" purpose="formatResponse, handleError, ToolDefinition type"/>
          <file name="database.ts" purpose="db_create, db_list, db_select, db_stats, db_delete (5)"/>
          <file name="ingestion.ts" purpose="ingest_directory, ingest_files, process_pending, status, chunk_complete, retry_failed, reprocess, convert_raw (8)"/>
          <file name="search.ts" purpose="search, search_semantic, search_hybrid, fts_manage, search_export, benchmark_compare, rag_context (7)"/>
          <file name="documents.ts" purpose="document_list, document_get, document_delete (3)"/>
          <file name="provenance.ts" purpose="provenance_get, provenance_verify, provenance_export (3)"/>
          <file name="config.ts" purpose="config_get, config_set (2)"/>
          <file name="vlm.ts" purpose="vlm_describe, vlm_classify, vlm_process_document, vlm_process_pending, vlm_analyze_pdf, vlm_status (6)"/>
          <file name="images.ts" purpose="image_extract, image_list, image_get, image_delete, image_delete_by_document, image_reset_failed, image_pending, image_stats (8)"/>
          <file name="extraction.ts" purpose="extract_images, extract_images_batch, extraction_check (3)"/>
          <file name="evaluation.ts" purpose="evaluate_single, evaluate_document, evaluate_pending (3)"/>
          <file name="reports.ts" purpose="evaluation_report, document_report, quality_summary, cost_summary (4)"/>
          <file name="extraction-structured.ts" purpose="extract_structured, extraction_list (2)"/>
          <file name="form-fill.ts" purpose="form_fill, form_fill_status (2)"/>
          <file name="file-management.ts" purpose="file_upload, file_list, file_get, file_download, file_delete (5)"/>
          <file name="clustering.ts" purpose="cluster_documents, cluster_list, cluster_get, cluster_assign, cluster_delete (5)"/>
          <file name="comparison.ts" purpose="document_compare, comparison_list, comparison_get (3)"/>
        </directory>

        <directory name="services" purpose="Core business logic">
          <directory name="ocr" purpose="Datalab OCR integration">
            <file name="datalab.ts" purpose="Datalab API client"/>
            <file name="processor.ts" purpose="OCR processing orchestration"/>
            <file name="errors.ts" purpose="OCR-specific error types"/>
            <file name="form-fill.ts" purpose="Form fill service"/>
            <file name="file-manager.ts" purpose="File upload/download service"/>
          </directory>
          <directory name="chunking" purpose="Text chunking service">
            <file name="chunker.ts" purpose="2000-char chunks with 10% overlap"/>
          </directory>
          <directory name="embedding" purpose="Embedding generation">
            <file name="nomic.ts" purpose="Nomic embedding client (GPU)"/>
            <file name="embedder.ts" purpose="Embedding orchestration"/>
          </directory>
          <directory name="gemini" purpose="Gemini API integration">
            <file name="client.ts" purpose="Gemini API client"/>
            <file name="config.ts" purpose="Gemini configuration"/>
            <file name="rate-limiter.ts" purpose="Request rate limiting"/>
            <file name="circuit-breaker.ts" purpose="Circuit breaker for API resilience"/>
          </directory>
          <directory name="vlm" purpose="Vision Language Model orchestration">
            <file name="service.ts" purpose="VLM service"/>
            <file name="pipeline.ts" purpose="Batch VLM processing"/>
            <file name="prompts.ts" purpose="Legal, medical, universal prompt templates"/>
          </directory>
          <directory name="images" purpose="Image extraction and optimization">
            <file name="extractor.ts" purpose="Unified image extraction (PDF, DOCX)"/>
            <file name="optimizer.ts" purpose="Image relevance filtering"/>
          </directory>
          <directory name="search" purpose="Search services">
            <file name="bm25.ts" purpose="BM25 full-text search via FTS5"/>
            <file name="fusion.ts" purpose="RRF fusion for hybrid search"/>
            <file name="query-expander.ts" purpose="Gemini-powered query expansion"/>
            <file name="reranker.ts" purpose="Gemini-based contextual re-ranking"/>
          </directory>
          <directory name="clustering" purpose="Document clustering">
            <file name="clustering-service.ts" purpose="Clustering orchestration, centroid computation"/>
          </directory>
          <directory name="comparison" purpose="Document comparison">
            <file name="diff-service.ts" purpose="Text diff, structural metadata diff"/>
          </directory>
          <directory name="provenance" purpose="Provenance tracking">
            <file name="tracker.ts" purpose="Provenance chain construction"/>
            <file name="verifier.ts" purpose="Integrity verification"/>
            <file name="exporter.ts" purpose="W3C PROV, JSON, CSV export"/>
          </directory>
          <directory name="storage" purpose="Data persistence">
            <file name="database.ts" purpose="Main DatabaseService class"/>
            <file name="vector.ts" purpose="sqlite-vec operations"/>
            <file name="types.ts" purpose="Storage type definitions"/>
            <directory name="database" purpose="Database operation modules (16 files)">
              <file name="service.ts" purpose="DatabaseService implementation"/>
              <file name="document-operations.ts" purpose="Document CRUD and cascade delete"/>
              <file name="chunk-operations.ts" purpose="Chunk CRUD"/>
              <file name="embedding-operations.ts" purpose="Embedding CRUD"/>
              <file name="image-operations.ts" purpose="Image CRUD"/>
              <file name="provenance-operations.ts" purpose="Provenance CRUD"/>
              <file name="ocr-operations.ts" purpose="OCR result CRUD"/>
              <file name="extraction-operations.ts" purpose="Structured extraction CRUD"/>
              <file name="form-fill-operations.ts" purpose="Form fill CRUD"/>
              <file name="upload-operations.ts" purpose="Uploaded file CRUD"/>
              <file name="cluster-operations.ts" purpose="Cluster and document_cluster CRUD"/>
              <file name="comparison-operations.ts" purpose="Comparison CRUD"/>
              <file name="stats-operations.ts" purpose="Database statistics"/>
              <file name="static-operations.ts" purpose="Static database operations"/>
              <file name="converters.ts" purpose="Row to model converters"/>
              <file name="helpers.ts" purpose="Database helpers"/>
            </directory>
            <directory name="migrations" purpose="Schema migrations (v1-v26)">
              <file name="schema-definitions.ts" purpose="Table DDL, indexes, FTS5, SCHEMA_VERSION=26"/>
              <file name="operations.ts" purpose="Migration execution (v1-v26)"/>
              <file name="verification.ts" purpose="Schema verification"/>
              <file name="schema-helpers.ts" purpose="Migration helpers"/>
            </directory>
          </directory>
        </directory>

        <directory name="models" purpose="TypeScript interfaces (11 files)">
          <file name="index.ts" purpose="Re-exports all model types"/>
          <file name="document.ts" purpose="Document interfaces"/>
          <file name="chunk.ts" purpose="Chunk interfaces"/>
          <file name="embedding.ts" purpose="Embedding interfaces"/>
          <file name="provenance.ts" purpose="Provenance interfaces and enum"/>
          <file name="image.ts" purpose="Image, VLMResult, ExtractedImage interfaces"/>
          <file name="cluster.ts" purpose="Cluster, DocumentCluster, ClusterRunConfig interfaces"/>
          <file name="comparison.ts" purpose="Comparison interfaces"/>
          <file name="extraction.ts" purpose="Extraction interfaces"/>
          <file name="form-fill.ts" purpose="FormFill interfaces"/>
          <file name="uploaded-file.ts" purpose="UploadedFile interfaces"/>
        </directory>

        <directory name="utils" purpose="Utility functions">
          <file name="hash.ts" purpose="SHA-256 utilities (computeFileHashSync with 64KB chunks)"/>
          <file name="validation.ts" purpose="Zod schemas, validateInput helper"/>
        </directory>
      </directory>

      <!-- Python Workers -->
      <directory name="python" purpose="Python workers (8 workers + GPU utils)">
        <file name="requirements.txt" purpose="Python dependencies (CUDA/MPS/CPU)"/>
        <file name="__init__.py" purpose="Python package marker"/>
        <file name="ocr_worker.py" purpose="Datalab OCR worker (outputs JSON to stdout)"/>
        <file name="embedding_worker.py" purpose="Nomic embedding worker (CUDA/MPS/CPU auto-detect)"/>
        <file name="gpu_utils.py" purpose="Device detection (CUDA/MPS/CPU) and monitoring"/>
        <file name="image_extractor.py" purpose="PDF image extraction (PyMuPDF + inkscape)"/>
        <file name="docx_image_extractor.py" purpose="DOCX image extraction (zipfile + Pillow + inkscape)"/>
        <file name="image_optimizer.py" purpose="Image relevance analysis and filtering"/>
        <file name="form_fill_worker.py" purpose="Datalab form fill worker"/>
        <file name="file_manager_worker.py" purpose="Datalab file upload/download worker"/>
        <file name="clustering_worker.py" purpose="Document clustering (HDBSCAN/agglomerative/kmeans)"/>
      </directory>

      <!-- Tests -->
      <directory name="tests" purpose="Test suites (79 files, 1505 tests)">
        <directory name="unit" purpose="Unit tests"/>
        <directory name="integration" purpose="Integration tests"/>
        <directory name="fixtures" purpose="Test fixtures and sample documents"/>
      </directory>
    </root>
  </directory_structure>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                           CODING STANDARDS                                       -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <coding_standards>
    <!-- Naming Conventions -->
    <naming_conventions>
      <files>kebab-case for all files (e.g., clustering-service.ts)</files>
      <variables>camelCase variables, SCREAMING_SNAKE for constants</variables>
      <functions>camelCase, verb-first (e.g., computeDocumentEmbeddings)</functions>
      <types>PascalCase for interfaces and types (e.g., ToolDefinition, ClusterRunConfig)</types>
      <tools>snake_case with ocr_ prefix (e.g., ocr_cluster_documents)</tools>
    </naming_conventions>

    <!-- TypeScript Standards -->
    <standard id="CS-TS-001" language="typescript">
      <name>Strict Mode Required</name>
      <rule>All TypeScript files must use strict mode with noImplicitAny enabled</rule>
    </standard>

    <standard id="CS-TS-002" language="typescript">
      <name>Zod Schema Validation</name>
      <rule>All MCP tool inputs must be validated using Zod schemas via validateInput()</rule>
      <example>
        const input = validateInput(ClusterDocumentsInput, params);
      </example>
    </standard>

    <standard id="CS-TS-003" language="typescript">
      <name>Tool Handler Pattern</name>
      <rule>All MCP tool handlers follow: validateInput -> business logic -> formatResponse(successResult({...})) or handleError(error)</rule>
      <example>
        async function handleTool(params: Record&lt;string, unknown&gt;): Promise&lt;ToolResponse&gt; {
          try {
            const input = validateInput(Schema, params);
            const { db } = requireDatabase();
            // ... business logic ...
            return formatResponse(successResult({ result }));
          } catch (error) {
            return handleError(error);
          }
        }
      </example>
    </standard>

    <standard id="CS-TS-004" language="typescript">
      <name>No Console.log (CRITICAL)</name>
      <rule>NEVER use console.log() in TypeScript — stdout is reserved for JSON-RPC protocol. Use console.error() for debugging.</rule>
    </standard>

    <standard id="CS-TS-005" language="typescript">
      <name>Async/Await Pattern</name>
      <rule>Use async/await for all asynchronous operations, never raw Promises with .then()</rule>
    </standard>

    <!-- Python Standards -->
    <standard id="CS-PY-001" language="python">
      <name>Type Hints Required</name>
      <rule>All function parameters and return types must have type hints</rule>
    </standard>

    <standard id="CS-PY-002" language="python">
      <name>Device Memory Management</name>
      <rule>Clear CUDA cache after batch operations and on errors (when on CUDA device). Guard torch.cuda calls with is_cuda checks for cross-platform safety.</rule>
    </standard>

    <standard id="CS-PY-003" language="python">
      <name>JSON Output Protocol</name>
      <rule>Python workers output JSON to stdout, called by TS via child_process.spawn</rule>
    </standard>

    <!-- Provenance Standards -->
    <standard id="CS-PROV-001" language="all">
      <name>Provenance Record Creation</name>
      <rule>Every data transformation must create a provenance record with all required fields</rule>
      <required_fields>
        <field>id</field>
        <field>type</field>
        <field>source_id</field>
        <field>root_document_id</field>
        <field>content_hash</field>
        <field>processor</field>
        <field>processor_version</field>
        <field>processing_params</field>
        <field>created_at</field>
      </required_fields>
    </standard>

    <standard id="CS-PROV-002" language="all">
      <name>Hash Computation</name>
      <rule>SHA-256 hashes must be computed for all content before storage. Use computeFileHashSync() for files (64KB chunks).</rule>
    </standard>

    <!-- Database Standards -->
    <standard id="CS-DB-001" language="sql">
      <name>Foreign Key Constraints</name>
      <rule>All relationships must be enforced with foreign key constraints. PRAGMA foreign_keys = ON.</rule>
    </standard>

    <standard id="CS-DB-002" language="sql">
      <name>Cascade Delete FK Ordering</name>
      <rule>Document deletion must follow strict FK ordering: vec_embeddings -> NULL vlm_embedding_id -> embeddings -> images -> clusters decrement -> document_clusters -> comparisons -> chunks -> extractions -> ocr_results -> FTS metadata -> document -> provenance</rule>
      <critical_gotchas>
        <gotcha>Circular FK: embeddings.image_id -> images AND images.vlm_embedding_id -> embeddings (NULL first)</gotcha>
        <gotcha>Cluster FK: clusters.provenance_id -> provenance (NOT NULL, skip+detach)</gotcha>
        <gotcha>Provenance self-refs: Pre-clear parent_id/source_id on batch before deletion loop</gotcha>
      </critical_gotchas>
    </standard>

    <standard id="CS-DB-003" language="sql">
      <name>Index Optimization</name>
      <rule>Create indexes on all frequently queried columns. Current total: 39 indexes across 19 tables.</rule>
    </standard>

    <!-- Cross-Platform Standards -->
    <standard id="CS-XPLAT-001" language="typescript">
      <name>Platform-Aware Python Path</name>
      <rule>
        Never hardcode 'python3'. PythonShell-based services omit pythonPath
        (PythonShell auto-detects: python3 on Linux/Mac, python on Windows).
        child_process.spawn services use: process.platform === 'win32' ? 'python' : 'python3'.
      </rule>
    </standard>

    <standard id="CS-XPLAT-002" language="python">
      <name>Device Auto-Detection</name>
      <rule>
        Use resolve_device('auto') for compute device selection.
        Priority: CUDA > MPS > CPU. Guard all torch.cuda.* calls
        behind is_cuda checks. Never hard-fail on missing CUDA.
      </rule>
    </standard>

    <!-- Error Handling -->
    <standard id="CS-ERR-001" language="all">
      <name>Typed Error Categories</name>
      <rule>Use MCPError class with enumerated error categories</rule>
      <categories>
        <category>OCR_API_ERROR</category>
        <category>OCR_RATE_LIMIT</category>
        <category>OCR_TIMEOUT</category>
        <category>EMBEDDING_MODEL_ERROR</category>
        <category>GPU_OUT_OF_MEMORY</category>
        <category>GPU_NOT_AVAILABLE</category>
        <category>DATABASE_NOT_FOUND</category>
        <category>DOCUMENT_NOT_FOUND</category>
        <category>VALIDATION_ERROR</category>
        <category>INTERNAL_ERROR</category>
        <category>PROVENANCE_CHAIN_BROKEN</category>
        <category>INTEGRITY_VERIFICATION_FAILED</category>
        <category>VLM_API_ERROR</category>
        <category>VLM_RATE_LIMIT</category>
        <category>IMAGE_EXTRACTION_FAILED</category>
        <category>FORM_FILL_API_ERROR</category>
        <category>CLUSTERING_ERROR</category>
      </categories>
    </standard>
  </coding_standards>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                           ANTI-PATTERNS                                          -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <anti_patterns>
    <anti_pattern id="AP-001" severity="critical">
      <name>Missing Provenance</name>
      <description>Storing data without creating a corresponding provenance record</description>
    </anti_pattern>

    <anti_pattern id="AP-002" severity="critical">
      <name>Separate Text Retrieval</name>
      <description>Requiring a second query to get the original text for a search result. Search results MUST include original_text.</description>
    </anti_pattern>

    <anti_pattern id="AP-003" severity="high">
      <name>Cloud Embedding Fallback</name>
      <description>Falling back to a cloud API for EMBEDDINGS. Embedding generation must ALWAYS be local (CUDA, MPS, or CPU). Using a slower local device (CPU) is acceptable; using a cloud embedding API is never acceptable.</description>
    </anti_pattern>

    <anti_pattern id="AP-004" severity="high">
      <name>Uncached Hash Recomputation</name>
      <description>Recomputing hashes for content that hasn't changed. Store hash once, verify only when requested.</description>
    </anti_pattern>

    <anti_pattern id="AP-005" severity="medium">
      <name>Unbatched Embedding Generation</name>
      <description>Generating embeddings one at a time instead of batching (batch_size=512 for GPU efficiency)</description>
    </anti_pattern>

    <anti_pattern id="AP-006" severity="medium">
      <name>Missing Page Number Tracking</name>
      <description>Losing page number information during chunking. Each chunk must have page_number, char_start, char_end.</description>
    </anti_pattern>

    <anti_pattern id="AP-007" severity="critical">
      <name>API Key in Code</name>
      <description>Hardcoding Datalab or Gemini API keys in source files. Use process.env only.</description>
    </anti_pattern>

    <anti_pattern id="AP-008" severity="critical">
      <name>Flash Attention Usage</name>
      <description>Using flash-attn in any part of the system. FA3 excludes Blackwell/sm_120 architecture and is unavailable on MPS/CPU.</description>
      <enforcement>
        - Do NOT add flash-attn to requirements.txt
        - Set use_flash_attn: false in all model configs
        - Do NOT import flash_attn anywhere
      </enforcement>
    </anti_pattern>

    <anti_pattern id="AP-009" severity="critical">
      <name>Missing dotenv Loading</name>
      <description>Forgetting to load .env file at application startup. dotenv.config() MUST be called at the top of src/index.ts.</description>
    </anti_pattern>

    <anti_pattern id="AP-010" severity="high">
      <name>Silent VLM Token Waste</name>
      <description>Processing logos, icons, and decorative images with VLM. Filter irrelevant images first.</description>
    </anti_pattern>

    <anti_pattern id="AP-011" severity="high">
      <name>Foreign Keys During Migration</name>
      <description>Leaving foreign key constraints ON during table recreation migrations. Use PRAGMA foreign_keys = OFF.</description>
    </anti_pattern>

    <anti_pattern id="AP-012" severity="critical">
      <name>Console.log in TypeScript</name>
      <description>Using console.log() anywhere in TypeScript code. stdout is the JSON-RPC protocol channel. Any console.log corrupts the MCP protocol stream.</description>
      <enforcement>Use console.error() for debug logging. NEVER console.log().</enforcement>
    </anti_pattern>

    <anti_pattern id="AP-016" severity="critical">
      <name>Using Old Gemini Models</name>
      <description>Using gemini-2.0-flash or gemini-2.5-flash anywhere in the system. ALL Gemini API calls MUST use gemini-3-flash-preview. This includes VLM image analysis, re-ranking, and any other AI task. The model ID in GEMINI_MODELS must be 'gemini-3-flash-preview'. The .env GEMINI_MODEL must be gemini-3-flash-preview. No fallback to older models.</description>
      <enforcement>
        - GEMINI_MODELS constant must only contain FLASH_3: 'gemini-3-flash-preview'
        - .env GEMINI_MODEL=gemini-3-flash-preview
        - No hardcoded references to gemini-2.0-flash or gemini-2.5-flash in source
        - maxOutputTokens MUST be 65536 (thinking tokens share output budget)
        - HTTP timeout MUST be 600s (10 min) to accommodate thinking mode
      </enforcement>
    </anti_pattern>
  </anti_patterns>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                        SECURITY REQUIREMENTS                                     -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <security_requirements>
    <requirement id="SEC-001" priority="critical">
      <name>API Key Protection</name>
      <description>Datalab and Gemini API keys must never be stored in code, databases, or logs</description>
      <implementation>
        <rule>Store in environment variables only</rule>
        <rule>Never log API key values</rule>
        <rule>Use .env files excluded from version control</rule>
      </implementation>
    </requirement>

    <requirement id="SEC-002" priority="critical">
      <name>Path Sanitization</name>
      <description>All file paths must be sanitized to prevent directory traversal</description>
      <implementation>
        <rule>Resolve paths to absolute before use</rule>
        <rule>Reject paths containing ".."</rule>
        <rule>Validate paths are within allowed directories</rule>
      </implementation>
    </requirement>

    <requirement id="SEC-003" priority="high">
      <name>Database File Permissions</name>
      <description>Database files must have restricted permissions (mode 600)</description>
    </requirement>

    <requirement id="SEC-004" priority="high">
      <name>No Network Exposure</name>
      <description>MCP server must not expose network endpoints by default. Use stdio transport. Embedding generation is local-only.</description>
    </requirement>

    <requirement id="SEC-005" priority="medium">
      <name>Input Validation</name>
      <description>All MCP tool inputs must be validated against Zod schemas. Sanitize string inputs for SQL injection.</description>
    </requirement>

    <requirement id="SEC-006" priority="medium">
      <name>Audit Logging</name>
      <description>All operations logged with timestamps. Provenance provides complete audit trail for data.</description>
    </requirement>

    <requirement id="SEC-007" priority="high">
      <name>Integrity Verification</name>
      <description>SHA-256 hashes stored with all content. Verification endpoint to re-hash and compare. Broken chains detectable.</description>
    </requirement>
  </security_requirements>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                        PERFORMANCE BUDGETS                                       -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <performance_budgets>
    <budget id="PERF-001" component="ocr">
      <metric>OCR Throughput</metric>
      <target>5 documents/minute</target>
      <constraint>Datalab API rate limits</constraint>
    </budget>

    <budget id="PERF-002" component="embedding">
      <metric>Embedding Throughput</metric>
      <target>2,000+ chunks/second (CUDA), ~100 chunks/second (MPS), ~20 chunks/second (CPU)</target>
      <hardware>NVIDIA RTX 5090 (32GB VRAM) / Apple Silicon / CPU</hardware>
    </budget>

    <budget id="PERF-003" component="search">
      <metric>Vector Search Latency</metric>
      <target>&lt;20ms for 100K vectors</target>
    </budget>

    <budget id="PERF-004" component="search">
      <metric>BM25 Search Latency</metric>
      <target>&lt;10ms for FTS5 queries</target>
    </budget>

    <budget id="PERF-005" component="provenance">
      <metric>Provenance Chain Verification</metric>
      <target>&lt;100ms per complete chain</target>
    </budget>

    <budget id="PERF-008" component="clustering">
      <metric>Clustering Time</metric>
      <target>&lt;5s for 100 documents</target>
      <constraint>Python scikit-learn worker</constraint>
    </budget>

    <budget id="PERF-009" component="vlm">
      <metric>VLM Throughput</metric>
      <target>~1 image/second</target>
      <constraint>Gemini API rate limits + 1s delay</constraint>
    </budget>

    <budget id="PERF-010" component="storage">
      <metric>Storage per Chunk</metric>
      <target>~5.5 KB per chunk (2KB text + 3KB vector + 0.5KB metadata)</target>
    </budget>

    <budget id="PERF-011" component="gpu">
      <metric>VRAM Usage (Batch 512)</metric>
      <target>14.2 GB (CUDA)</target>
      <available>32 GB (RTX 5090). MPS/CPU use system RAM instead.</available>
    </budget>
  </performance_budgets>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                        TESTING REQUIREMENTS                                      -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <testing_requirements>
    <test_category id="TEST-UNIT" name="Unit Tests">
      <coverage_target>80%</coverage_target>
      <areas>
        <area name="Chunking Algorithm">
          <test>Correct chunk sizes, overlap, character offsets, edge cases</test>
        </area>
        <area name="Hash Computation">
          <test>SHA-256 consistency, format validation, unicode handling</test>
        </area>
        <area name="Provenance Chain">
          <test>Chain construction, parent linking, root propagation, depth calculation</test>
        </area>
        <area name="Database Operations">
          <test>CRUD for all 15 physical tables, foreign key constraints, index usage</test>
        </area>
        <area name="Input Validation">
          <test>Zod schema validation, path sanitization, SQL injection prevention</test>
        </area>
      </areas>
    </test_category>

    <test_category id="TEST-INT" name="Integration Tests">
      <areas>
        <area name="Datalab API Integration">
          <test>Document submission, status polling, result retrieval, error handling</test>
        </area>
        <area name="GPU Embedding">
          <test>Model loading, batch embedding, CUDA memory, OOM recovery</test>
        </area>
        <area name="End-to-End Pipeline">
          <test>Ingest -> OCR -> Chunk -> Embed -> Search (text and image branches)</test>
        </area>
        <area name="Document Clustering">
          <test>Embedding computation -> Python worker -> cluster assignment -> auto-classify</test>
        </area>
        <area name="Document Comparison">
          <test>Text diff -> similarity scoring</test>
        </area>
        <area name="Search Integration">
          <test>BM25, semantic, hybrid, rerank, rag_context</test>
        </area>
      </areas>
    </test_category>

    <test_category id="TEST-GPU" name="Device-Specific Tests">
      <areas>
        <area name="Device Detection">
          <test>CUDA availability, MPS availability, CPU fallback, resolve_device() auto-detection</test>
        </area>
        <area name="Performance Benchmarks">
          <test>Embedding throughput on detected device, batch latency</test>
        </area>
      </areas>
    </test_category>

    <test_commands>
      <command purpose="Run all tests">npm test</command>
      <command purpose="Build project">npm run build</command>
      <command purpose="Lint code">npm run lint</command>
      <command purpose="Device verification">python python/gpu_utils.py --verify</command>
    </test_commands>

    <test_protocol>
      After ANY code changes: pkill -f "node dist/index" then npm run build then npm test.
      MCP client caches tool list at session start; new tools need server restart.
    </test_protocol>
  </testing_requirements>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                           DATA MODEL                                             -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <data_model>
    <!-- Provenance Types (as defined in schema CHECK constraint) -->
    <enum name="ProvenanceType">
      <value name="DOCUMENT" depth="0" description="Original source file"/>
      <value name="OCR_RESULT" depth="1" description="Text extracted via Datalab OCR"/>
      <value name="FORM_FILL" depth="0" description="Form fill operation (root-level)"/>
      <value name="CHUNK" depth="2" description="Text segment with overlap"/>
      <value name="IMAGE" depth="2" description="Image extracted from document page"/>
      <value name="EXTRACTION" depth="2" description="Structured JSON extraction"/>
      <value name="COMPARISON" depth="2" description="Document comparison result"/>
      <value name="CLUSTERING" depth="2" description="Clustering run result"/>
      <value name="EMBEDDING" depth="3+" description="Vector from embedding model"/>
      <value name="VLM_DESCRIPTION" depth="3" description="Multi-paragraph text from VLM"/>
    </enum>

    <!--
      Full provenance tree:
      DOCUMENT(0) -> OCR_RESULT(1) -> CHUNK(2) -> EMBEDDING(3)
                                    -> IMAGE(2) -> VLM_DESCRIPTION(3) -> EMBEDDING(4)
                                    -> EXTRACTION(2) -> EMBEDDING(3)
                                    -> COMPARISON(2)
                                    -> CLUSTERING(2)
      FORM_FILL(0) (independent root)
    -->

    <!-- Tables: 15 physical + 4 virtual = 19 total -->
    <tables>
      <!-- Physical tables (15) -->
      <table name="schema_version" purpose="Schema version tracking"/>
      <table name="provenance" purpose="Complete data lineage chain"/>
      <table name="database_metadata" purpose="Database metadata storage"/>
      <table name="documents" purpose="Source document tracking"/>
      <table name="ocr_results" purpose="OCR extraction results"/>
      <table name="chunks" purpose="Text segments with overlap"/>
      <table name="embeddings" purpose="Vector embeddings with original_text"/>
      <table name="fts_index_metadata" purpose="FTS sync tracking"/>
      <table name="images" purpose="Extracted images with VLM status"/>
      <table name="extractions" purpose="Structured JSON extractions"/>
      <table name="form_fills" purpose="Form fill operations"/>
      <table name="uploaded_files" purpose="Datalab cloud file uploads"/>
      <table name="comparisons" purpose="Document comparison results"/>
      <table name="clusters" purpose="Document cluster definitions"/>
      <table name="document_clusters" purpose="Document-to-cluster assignments"/>
      <!-- Virtual tables (4) -->
      <table name="vec_embeddings" purpose="sqlite-vec virtual table for vector search" virtual="true"/>
      <table name="chunks_fts" purpose="FTS5 full-text search index on chunks" virtual="true"/>
      <table name="vlm_fts" purpose="FTS5 index on VLM descriptions" virtual="true"/>
      <table name="extractions_fts" purpose="FTS5 index on structured extractions" virtual="true"/>
    </tables>
  </data_model>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                           MCP TOOLS (69 registered)                              -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <mcp_tools>
    <!-- Database Management (5) -->
    <tool_group name="Database Management" count="5">
      <tool name="ocr_db_create"/>
      <tool name="ocr_db_list"/>
      <tool name="ocr_db_select"/>
      <tool name="ocr_db_stats"/>
      <tool name="ocr_db_delete"/>
    </tool_group>

    <!-- Document Ingestion (8) -->
    <tool_group name="Document Ingestion" count="8">
      <tool name="ocr_ingest_directory"/>
      <tool name="ocr_ingest_files"/>
      <tool name="ocr_process_pending"/>
      <tool name="ocr_status"/>
      <tool name="ocr_chunk_complete"/>
      <tool name="ocr_retry_failed"/>
      <tool name="ocr_reprocess"/>
      <tool name="ocr_convert_raw"/>
    </tool_group>

    <!-- Search (7) -->
    <tool_group name="Search" count="7">
      <tool name="ocr_search" note="BM25 with rerank, cluster_id, min_quality_score"/>
      <tool name="ocr_search_semantic" note="Vector search with rerank"/>
      <tool name="ocr_search_hybrid" note="RRF fusion with rerank"/>
      <tool name="ocr_fts_manage"/>
      <tool name="ocr_search_export"/>
      <tool name="ocr_benchmark_compare"/>
      <tool name="ocr_rag_context" note="Hybrid search context assembly"/>
    </tool_group>

    <!-- Document Management (3) -->
    <tool_group name="Document Management" count="3">
      <tool name="ocr_document_list"/>
      <tool name="ocr_document_get"/>
      <tool name="ocr_document_delete"/>
    </tool_group>

    <!-- Provenance (3) -->
    <tool_group name="Provenance" count="3">
      <tool name="ocr_provenance_get"/>
      <tool name="ocr_provenance_verify"/>
      <tool name="ocr_provenance_export"/>
    </tool_group>

    <!-- Image Management (8) -->
    <tool_group name="Image Management" count="8">
      <tool name="ocr_image_extract" note="Extract images from PDF (Datalab OCR path)"/>
      <tool name="ocr_image_list"/>
      <tool name="ocr_image_get"/>
      <tool name="ocr_image_delete"/>
      <tool name="ocr_image_delete_by_document"/>
      <tool name="ocr_image_reset_failed"/>
      <tool name="ocr_image_pending"/>
      <tool name="ocr_image_stats"/>
    </tool_group>

    <!-- Image Extraction (3) -->
    <tool_group name="Image Extraction" count="3">
      <tool name="ocr_extract_images"/>
      <tool name="ocr_extract_images_batch"/>
      <tool name="ocr_extraction_check"/>
    </tool_group>

    <!-- VLM Analysis (6) -->
    <tool_group name="VLM Analysis" count="6">
      <tool name="ocr_vlm_describe"/>
      <tool name="ocr_vlm_classify"/>
      <tool name="ocr_vlm_process_document"/>
      <tool name="ocr_vlm_process_pending"/>
      <tool name="ocr_vlm_analyze_pdf"/>
      <tool name="ocr_vlm_status"/>
    </tool_group>

    <!-- Evaluation (3) -->
    <tool_group name="Evaluation" count="3">
      <tool name="ocr_evaluate_single"/>
      <tool name="ocr_evaluate_document"/>
      <tool name="ocr_evaluate_pending"/>
    </tool_group>

    <!-- Reports (4) -->
    <tool_group name="Reports" count="4">
      <tool name="ocr_evaluation_report"/>
      <tool name="ocr_document_report"/>
      <tool name="ocr_quality_summary"/>
      <tool name="ocr_cost_summary"/>
    </tool_group>

    <!-- Structured Extraction (2) -->
    <tool_group name="Structured Extraction" count="2">
      <tool name="ocr_extract_structured"/>
      <tool name="ocr_extraction_list"/>
    </tool_group>

    <!-- Form Filling (2) -->
    <tool_group name="Form Filling" count="2">
      <tool name="ocr_form_fill"/>
      <tool name="ocr_form_fill_status"/>
    </tool_group>

    <!-- File Management (5) -->
    <tool_group name="File Management" count="5">
      <tool name="ocr_file_upload"/>
      <tool name="ocr_file_list"/>
      <tool name="ocr_file_get"/>
      <tool name="ocr_file_download"/>
      <tool name="ocr_file_delete"/>
    </tool_group>

    <!-- Configuration (2) -->
    <tool_group name="Configuration" count="2">
      <tool name="ocr_config_get"/>
      <tool name="ocr_config_set"/>
    </tool_group>

    <!-- Document Clustering (5) -->
    <tool_group name="Document Clustering" count="5">
      <tool name="ocr_cluster_documents" note="HDBSCAN/agglomerative/kmeans"/>
      <tool name="ocr_cluster_list"/>
      <tool name="ocr_cluster_get"/>
      <tool name="ocr_cluster_assign" note="Auto-classify document to nearest cluster"/>
      <tool name="ocr_cluster_delete"/>
    </tool_group>

    <!-- Document Comparison (3) -->
    <tool_group name="Document Comparison" count="3">
      <tool name="ocr_document_compare" note="Text diff + structural metadata diff"/>
      <tool name="ocr_comparison_list"/>
      <tool name="ocr_comparison_get"/>
    </tool_group>
  </mcp_tools>

  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <!--                        CONFIGURATION SCHEMA                                      -->
  <!-- ═══════════════════════════════════════════════════════════════════════════════ -->
  <configuration>
    <config_group name="datalab">
      <setting name="apiKey" type="string" source="env:DATALAB_API_KEY" required="true"/>
      <setting name="baseUrl" type="string" default="https://www.datalab.to/api/v1"/>
      <setting name="defaultMode" type="enum" values="fast,balanced,accurate" default="accurate"/>
      <setting name="maxConcurrent" type="integer" default="3"/>
      <setting name="timeout" type="integer" default="300000" unit="ms"/>
    </config_group>

    <config_group name="embedding">
      <setting name="model" type="string" default="nomic-embed-text-v1.5"/>
      <setting name="dimensions" type="integer" default="768"/>
      <setting name="inferenceMode" type="string" default="local" immutable="true"/>
      <setting name="batchSize" type="integer" default="512"/>
      <setting name="device" type="string" default="auto" note="auto | cuda:0 | mps | cpu"/>
    </config_group>

    <config_group name="vlm">
      <setting name="apiKey" type="string" source="env:GEMINI_API_KEY" required="true"/>
      <setting name="model" type="string" default="gemini-3-flash-preview" immutable="false" note="MUST be gemini-3-flash-preview. NEVER gemini-2.0-flash or gemini-2.5-flash."/>
      <setting name="minDelayBetweenRequests" type="integer" default="1000" unit="ms"/>
    </config_group>

    <config_group name="chunking">
      <setting name="chunkSize" type="integer" default="2000" unit="characters"/>
      <setting name="overlapPercent" type="integer" default="10"/>
      <setting name="strategy" type="enum" values="fixed,page_aware" default="fixed"/>
    </config_group>

    <config_group name="storage">
      <setting name="databasesPath" type="string" default="~/.ocr-provenance/databases/"/>
    </config_group>

    <config_group name="fts5">
      <setting name="tokenizer" type="string" default="porter unicode61" immutable="true"/>
      <setting name="rrf_k" type="integer" default="60"/>
    </config_group>
  </configuration>

</constitution>
```

---

## Appendix: Quick Reference

### Supported File Types (18 total)
- PDF (`.pdf`)
- Images (`.png`, `.jpg`, `.jpeg`, `.tiff`, `.tif`, `.bmp`, `.gif`, `.webp`)
- Office Documents (`.docx`, `.doc`, `.pptx`, `.ppt`, `.xlsx`, `.xls`)
- Text (`.txt`, `.csv`, `.md`)

### Provenance Chain Depth (All Branches)
| Depth | Type | Description |
|-------|------|-------------|
| 0 | DOCUMENT | Original source file |
| 0 | FORM_FILL | Form fill operation |
| 1 | OCR_RESULT | Extracted text from Datalab |
| 2 | CHUNK | 2000-char segment with overlap |
| 2 | IMAGE | Image extracted from document |
| 2 | EXTRACTION | Structured JSON extraction |
| 2 | COMPARISON | Document comparison result |
| 2 | CLUSTERING | Clustering run result |
| 3 | EMBEDDING | Vector from text chunk |
| 3 | VLM_DESCRIPTION | Multi-paragraph VLM description |
| 4 | EMBEDDING | Vector from VLM description |

### Critical Invariants (Must Always Be True)
1. Every embedding has `original_text` stored with it
2. Every data item has a complete provenance chain to source file
3. Every content item has a SHA-256 hash for verification
4. Embedding generation ALWAYS runs locally (CUDA/MPS/CPU -- never cloud)
5. Search results ALWAYS include source file path and page number
6. NEVER use console.log() in TypeScript (stdout = JSON-RPC)
7. Migrations use bumpVersion() and FK integrity checks
8. FTS5 index stays in sync via database triggers
9. ALL Gemini API calls use gemini-3-flash-preview (NEVER gemini-2.0-flash or gemini-2.5-flash)
10. maxOutputTokens ALWAYS set to 65536 (thinking tokens share output budget)

### Known Issues & Workarounds
| Issue | Workaround |
|-------|------------|
| Flash Attention incompatible with RTX 5090/MPS/CPU | Disabled -- use standard PyTorch attention |
| Gemini 3 Flash thinking tokens consume output budget | Always set maxOutputTokens=65536 and HTTP timeout=600s |
| EMF images in DOCX | inkscape auto-converts to PNG |
| Circular FK (embeddings<->images) | NULL vlm_embedding_id first, then delete embeddings |
| Migration foreign key failure | PRAGMA foreign_keys = OFF during migration |
| Windows: python3 not found | Auto-detect: python (Win) vs python3 (Linux/Mac) |
| macOS: No CUDA | EMBEDDING_DEVICE=auto selects MPS on Apple Silicon, CPU on Intel |

### Test Database
- Location: `~/.ocr-provenance/databases/`
