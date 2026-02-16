/**
 * File Management MCP Tools
 *
 * Tools for uploading, listing, retrieving, downloading, and deleting
 * files in Datalab cloud storage.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/file-management
 */

import { statSync } from 'fs';
import { basename } from 'path';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  formatResponse,
  handleError,
  queryEntitiesForDocuments,
  fetchProvenanceChain,
  type ToolDefinition,
} from './shared.js';
import { successResult } from '../server/types.js';
import { validateInput, sanitizePath } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { FileManagerClient } from '../services/ocr/file-manager.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash, hashFile } from '../utils/hash.js';
import {
  insertUploadedFile,
  getUploadedFile,
  getUploadedFileByHash,
  listUploadedFiles,
  updateUploadedFileStatus,
  updateUploadedFileDatalabInfo,
  deleteUploadedFile,
} from '../services/storage/database/upload-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const FileUploadInput = z.object({
  file_path: z.string().min(1).describe('Absolute path to file to upload'),
});

const FileListInput = z.object({
  status_filter: z
    .enum(['pending', 'uploading', 'confirming', 'complete', 'failed', 'all'])
    .default('all'),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  include_duplicate_check: z
    .boolean()
    .default(false)
    .describe(
      'When true, group files by similar sizes (within 10%) and flag groups with 3+ files as potential duplicates. Informational only.'
    ),
});

const FileGetInput = z.object({
  file_id: z.string().min(1).describe('Uploaded file record ID'),
  include_entities: z
    .boolean()
    .default(false)
    .describe('Include entities associated with this file'),
  include_provenance: z.boolean().default(false).describe('Include provenance chain for this file'),
});

const FileDownloadInput = z.object({
  file_id: z.string().min(1).describe('Uploaded file record ID'),
});

const FileDeleteInput = z.object({
  file_id: z.string().min(1).describe('Uploaded file record ID'),
  delete_from_datalab: z.boolean().default(false).describe('Also delete from Datalab cloud'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleFileUpload(params: Record<string, unknown>) {
  try {
    const input = validateInput(FileUploadInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const safeFilePath = sanitizePath(input.file_path);

    // Compute file hash for dedup check
    const fileHash = await hashFile(safeFilePath);

    // Check for existing upload with same hash
    const existing = getUploadedFileByHash(conn, fileHash);
    if (existing) {
      return formatResponse(
        successResult({
          deduplicated: true,
          existing_upload: {
            id: existing.id,
            file_name: existing.file_name,
            datalab_file_id: existing.datalab_file_id,
            datalab_reference: existing.datalab_reference,
            upload_status: existing.upload_status,
            created_at: existing.created_at,
          },
          message: 'File with identical hash already uploaded',
        })
      );
    }

    // Create provenance record
    const provId = uuidv4();
    const uploadId = uuidv4();
    const now = new Date().toISOString();

    const contentHash = computeHash(fileHash);

    db.insertProvenance({
      id: provId,
      type: ProvenanceType.DOCUMENT,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: safeFilePath,
      source_id: null,
      root_document_id: provId,
      location: null,
      content_hash: contentHash,
      input_hash: fileHash,
      file_hash: fileHash,
      processor: 'datalab-file-upload',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: JSON.stringify([]),
      chain_depth: 0,
      chain_path: JSON.stringify(['DOCUMENT']),
    });

    // Insert pending record
    const stats = statSync(safeFilePath);

    insertUploadedFile(conn, {
      id: uploadId,
      local_path: safeFilePath,
      file_name: basename(safeFilePath),
      file_hash: fileHash,
      file_size: stats.size,
      content_type: 'application/octet-stream',
      datalab_file_id: null,
      datalab_reference: null,
      upload_status: 'uploading',
      error_message: null,
      created_at: now,
      completed_at: null,
      provenance_id: provId,
    });

    // Perform upload
    const client = new FileManagerClient();
    try {
      const result = await client.uploadFile(safeFilePath);

      // Update record with Datalab info
      updateUploadedFileDatalabInfo(conn, uploadId, result.fileId, result.reference);
      updateUploadedFileStatus(conn, uploadId, 'complete');

      const nextSteps: string[] = [
        'Use ocr_ingest_document to create a document record and start OCR processing',
        'Use ocr_process_pending to OCR process the ingested document',
        'Use ocr_entity_extract to extract entities after OCR completes',
        'Use ocr_kg_build to build knowledge graph from extracted entities',
      ];

      return formatResponse(
        successResult({
          id: uploadId,
          datalab_file_id: result.fileId,
          datalab_reference: result.reference,
          file_name: result.fileName,
          file_hash: result.fileHash,
          file_size: result.fileSize,
          content_type: result.contentType,
          upload_status: 'complete',
          provenance_id: provId,
          processing_duration_ms: result.processingDurationMs,
          next_steps: nextSteps,
        })
      );
    } catch (uploadError) {
      const errorMsg = uploadError instanceof Error ? uploadError.message : String(uploadError);
      updateUploadedFileStatus(conn, uploadId, 'failed', errorMsg);
      throw uploadError;
    }
  } catch (error) {
    return handleError(error);
  }
}

async function handleFileList(params: Record<string, unknown>) {
  try {
    const input = validateInput(FileListInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const statusFilter = input.status_filter === 'all' ? undefined : input.status_filter;
    const files = listUploadedFiles(conn, {
      status: statusFilter,
      limit: input.limit,
      offset: input.offset,
    });

    const response: Record<string, unknown> = {
      total: files.length,
      uploaded_files: files.map((f) => ({
        id: f.id,
        file_name: f.file_name,
        file_hash: f.file_hash,
        file_size: f.file_size,
        content_type: f.content_type,
        datalab_file_id: f.datalab_file_id,
        upload_status: f.upload_status,
        created_at: f.created_at,
        completed_at: f.completed_at,
        error_message: f.error_message,
      })),
    };

    // File size-based duplicate detection
    if (input.include_duplicate_check && files.length >= 3) {
      const sizeGroups = new Map<
        string,
        Array<{ id: string; file_name: string; file_size: number; file_hash: string }>
      >();

      for (const f of files) {
        if (!f.file_size || f.file_size === 0) continue;

        // Round size to nearest 10% bucket for grouping
        // Files within 10% of each other share the same bucket key
        const bucketSize = Math.max(1, Math.round(f.file_size * 0.1));
        const bucketKey = String(Math.round(f.file_size / bucketSize));

        const group = sizeGroups.get(bucketKey);
        const entry = {
          id: f.id,
          file_name: f.file_name,
          file_size: f.file_size,
          file_hash: f.file_hash,
        };
        if (group) {
          group.push(entry);
        } else {
          sizeGroups.set(bucketKey, [entry]);
        }
      }

      // Flag groups with 3+ files as potential duplicates
      const potentialDuplicates: Array<{
        group_size: number;
        avg_file_size: number;
        files: Array<{ id: string; file_name: string; file_size: number; file_hash: string }>;
        has_hash_matches: boolean;
      }> = [];

      for (const [, group] of sizeGroups) {
        if (group.length >= 3) {
          const avgSize = Math.round(group.reduce((sum, f) => sum + f.file_size, 0) / group.length);
          // Check if any files in group share the same hash (true duplicates)
          const hashCounts = new Map<string, number>();
          for (const f of group) {
            hashCounts.set(f.file_hash, (hashCounts.get(f.file_hash) ?? 0) + 1);
          }
          const hasHashMatches = [...hashCounts.values()].some((c) => c > 1);

          potentialDuplicates.push({
            group_size: group.length,
            avg_file_size: avgSize,
            files: group,
            has_hash_matches: hasHashMatches,
          });
        }
      }

      if (potentialDuplicates.length > 0) {
        response.potential_duplicates = potentialDuplicates;
      }
    }

    return formatResponse(successResult(response));
  } catch (error) {
    return handleError(error);
  }
}

async function handleFileGet(params: Record<string, unknown>) {
  try {
    const input = validateInput(FileGetInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const file = getUploadedFile(conn, input.file_id);
    if (!file) {
      throw new Error(`Uploaded file not found: ${input.file_id}`);
    }

    const response: Record<string, unknown> = { uploaded_file: file };

    if (input.include_entities) {
      try {
        const doc = conn
          .prepare('SELECT id FROM documents WHERE file_hash = ? LIMIT 1')
          .get(file.file_hash) as { id: string } | undefined;
        if (doc) {
          response.entities = queryEntitiesForDocuments(conn, [doc.id]);
        }
      } catch (entErr) {
        console.error(
          `[file-management] Entity query failed: ${entErr instanceof Error ? entErr.message : String(entErr)}`
        );
      }
    }

    if (input.include_provenance) {
      response.provenance_chain = fetchProvenanceChain(db, file.provenance_id, 'file-management');
    }

    return formatResponse(successResult(response));
  } catch (error) {
    return handleError(error);
  }
}

async function handleFileDownload(params: Record<string, unknown>) {
  try {
    const input = validateInput(FileDownloadInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const file = getUploadedFile(conn, input.file_id);
    if (!file) {
      throw new Error(`Uploaded file not found: ${input.file_id}`);
    }

    if (!file.datalab_file_id) {
      throw new Error(`File has no Datalab file ID (upload may not be complete)`);
    }

    const client = new FileManagerClient();
    const downloadUrl = await client.getDownloadUrl(file.datalab_file_id);

    return formatResponse(
      successResult({
        file_id: input.file_id,
        datalab_file_id: file.datalab_file_id,
        file_name: file.file_name,
        download_url: downloadUrl,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

async function handleFileDelete(params: Record<string, unknown>) {
  try {
    const input = validateInput(FileDeleteInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const file = getUploadedFile(conn, input.file_id);
    if (!file) {
      throw new Error(`Uploaded file not found: ${input.file_id}`);
    }

    // Optionally delete from Datalab cloud
    let datalabDeleteSucceeded = false;
    let datalabDeleteError: string | undefined;
    if (input.delete_from_datalab && file.datalab_file_id) {
      try {
        const client = new FileManagerClient();
        await client.deleteFile(file.datalab_file_id);
        console.error(`[INFO] Deleted file from Datalab: ${file.datalab_file_id}`);
        datalabDeleteSucceeded = true;
      } catch (datalabError) {
        const msg = datalabError instanceof Error ? datalabError.message : String(datalabError);
        console.error(`[WARN] Failed to delete from Datalab: ${msg}`);
        datalabDeleteError = msg;
      }
    }

    // Delete from local DB
    const deleted = deleteUploadedFile(conn, input.file_id);

    const response: Record<string, unknown> = {
      deleted,
      file_id: input.file_id,
      datalab_file_id: file.datalab_file_id,
      deleted_from_datalab: datalabDeleteSucceeded,
    };
    if (datalabDeleteError) {
      response.datalab_delete_error = datalabDeleteError;
    }
    return formatResponse(successResult(response));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const fileManagementTools: Record<string, ToolDefinition> = {
  ocr_file_upload: {
    description:
      'Upload a file to Datalab cloud storage. Deduplicates by file hash - returns existing upload if hash matches.',
    inputSchema: FileUploadInput.shape,
    handler: handleFileUpload,
  },
  ocr_file_list: {
    description:
      'List uploaded files with optional status filter (pending, uploading, confirming, complete, failed). Set include_duplicate_check=true to flag potential duplicates by similar file sizes.',
    inputSchema: FileListInput.shape,
    handler: handleFileList,
  },
  ocr_file_get: {
    description: 'Get metadata for a specific uploaded file by ID',
    inputSchema: FileGetInput.shape,
    handler: handleFileGet,
  },
  ocr_file_download: {
    description: 'Get a download URL for a file uploaded to Datalab cloud',
    inputSchema: FileDownloadInput.shape,
    handler: handleFileDownload,
  },
  ocr_file_delete: {
    description: 'Delete an uploaded file record. Optionally also delete from Datalab cloud.',
    inputSchema: FileDeleteInput.shape,
    handler: handleFileDelete,
  },
};
