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
