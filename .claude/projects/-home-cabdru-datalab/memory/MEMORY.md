# Datalab Project Memory

## Architecture
- MCP tool system: tools defined in `src/tools/*.ts` as `Record<string, ToolDefinition>` objects, auto-registered in `src/index.ts`
- Database ops split into `src/services/storage/database/*-operations.ts` files
- OCR pipeline: `processor.ts` orchestrates `datalab.ts` (Python bridge) -> provenance -> DB storage
- `handleProcessPending` in `ingestion.ts` is the full pipeline: OCR -> Images -> Chunk -> Embed -> VLM -> Complete

## Key Patterns
- All tools use `formatResponse(successResult(...))` for success, `handleError(error)` for errors
- `requireDatabase()` returns `{ db, vector }` from server state
- Provenance chain: DOCUMENT(0) -> OCR_RESULT(1) -> CHUNK(2)/IMAGE(2) -> EMBEDDING(3)/VLM_DESC(3)
- `hashFile()` in `src/utils/hash.ts` is streaming/async, `computeHash()` is sync for strings
- `EntityFilter` Zod schema shared across BM25/semantic/hybrid search inputs (validation.ts)
- `resolveEntityFilter()` helper consolidates entity-to-doc-ID resolution in search.ts

## Pre-existing Test Failures (not bugs we introduced)
- `tests/unit/ocr/datalab.test.ts` and `processor.test.ts`: Need real Python3 + Datalab API
- `tests/unit/migrations/column-verification.test.ts`: Column count outdated (expects 23, has 24)
- `tests/integration/task-7-8-full-state-verification.test.ts`: Index count outdated (expects 20, has 21)

## Fixes Applied (2026-02-04)
- `updateDocumentOCRComplete` no longer sets status='complete' — caller handles final status
- OCR timeout increased to 15min via DATALAB_TIMEOUT env var
- Retry-on-timeout (1 retry) added to `processor.ts`
- File hashing now uses real SHA-256 via `hashFile()` instead of `sha256:pending-*` placeholders
- New tools: `ocr_chunk_complete`, `ocr_retry_failed`

## Forensic Audit Fixes (2026-02-15)
- 21 findings fixed from `docs/FORENSIC_SYSTEM_AUDIT_2026-02-15.md`
- **F1 (P0)**: cluster-operations.ts INSERT now includes all 8 NOT NULL columns
- **F2 (P1)**: form-fill.ts validates document_id against `documents` table (was `provenance`)
- **F3-F6 (P1)**: 4 silent catch blocks now have console.error() logging
- **F7-F8 (P2)**: Migration FK + PRAGMA safety patterns
- **F9 (P2)**: Coreference resolution includes page_number from chunks
- **F10 (P2)**: 4 Python worker paths use __dirname (not process.cwd())
- **F11 (P2)**: FILE_MANAGER error categories mapped in mapPythonError()
- **F12-F13 (P2)**: ALL tools use formatResponse(successResult({...})) + throws for errors
- **F14 (P2)**: 26 silent catch blocks in 5 service files now have console.error()
- **F15 (P2)**: knowledge_nodes.resolution_type populated on KG build (exact/fuzzy/ai/singleton)
- **F16 (P3)**: v22-v23 migration test (13 tests)
- **F17 (P3)**: 3 dead functions removed
- **F21 (P3)**: Python workers all have stream=sys.stderr in logging.basicConfig()
- **Tests**: 2145 passed, 0 failed across 130 files (129 passed + 1 skipped)
- **Verification**: 23 manual tests in `tests/manual/forensic-verification-2026-02-15.test.ts`
- **Simplifier**: VE-FORENSIC-1 through VE-FORENSIC-3 (comments, imports, switch collapse)
- Coordination: `memory/forensic-fix-coordination.md`

## GAP Integration (2026-02-11)
- 9 GAPs implemented from `docs/ENTITY_KG_SEARCH_INTEGRATION_REPORT.md`
- **New tools**: `ocr_related_documents`, `ocr_rag_context` (total MCP tools: 88)
- **Search enhancements**: expand_query (semantic), entity_boost (hybrid), mention frequency boost, cross_document_entities
- **KG enhancements**: evidence_chunks on path edges, timeline entity filtering (co-location + path-based)
- **Pipeline**: auto_extract_vlm_entities param in process_pending
- **Manual verification**: 19/19 PASS against entity-opt-verify DB
- **Code simplifier**: VE-GAP-1 through VE-GAP-8 (~150 lines removed)
- Coordination: `memory/gap-integration-coordination.md`
