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
import { formatResponse, handleError, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
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
  status_filter: z.enum(['pending', 'uploading', 'confirming', 'complete', 'failed', 'all']).default('all'),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

const FileGetInput = z.object({
  file_id: z.string().min(1).describe('Uploaded file record ID'),
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

    // Compute file hash for dedup check
    const fileHash = await hashFile(input.file_path);

    // Check for existing upload with same hash
    const existing = getUploadedFileByHash(conn, fileHash);
    if (existing) {
      return formatResponse({
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
      });
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
      source_path: input.file_path,
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
    const stats = statSync(input.file_path);

    insertUploadedFile(conn, {
      id: uploadId,
      local_path: input.file_path,
      file_name: basename(input.file_path),
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
      const result = await client.uploadFile(input.file_path);

      // Update record with Datalab info
      updateUploadedFileDatalabInfo(conn, uploadId, result.fileId, result.reference);
      updateUploadedFileStatus(conn, uploadId, 'complete');

      return formatResponse({
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
      });
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

    return formatResponse({
      total: files.length,
      uploaded_files: files.map(f => ({
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
    });
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
      return formatResponse({ error: `Uploaded file not found: ${input.file_id}` });
    }

    return formatResponse({ uploaded_file: file });
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
      return formatResponse({ error: `Uploaded file not found: ${input.file_id}` });
    }

    if (!file.datalab_file_id) {
      return formatResponse({ error: `File has no Datalab file ID (upload may not be complete)` });
    }

    const client = new FileManagerClient();
    const downloadUrl = await client.getDownloadUrl(file.datalab_file_id);

    return formatResponse({
      file_id: input.file_id,
      datalab_file_id: file.datalab_file_id,
      file_name: file.file_name,
      download_url: downloadUrl,
    });
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
      return formatResponse({ error: `Uploaded file not found: ${input.file_id}` });
    }

    // Optionally delete from Datalab cloud
    if (input.delete_from_datalab && file.datalab_file_id) {
      try {
        const client = new FileManagerClient();
        await client.deleteFile(file.datalab_file_id);
        console.error(`[INFO] Deleted file from Datalab: ${file.datalab_file_id}`);
      } catch (datalabError) {
        console.error(`[WARN] Failed to delete from Datalab: ${datalabError instanceof Error ? datalabError.message : String(datalabError)}`);
        // Continue with local delete even if Datalab delete fails
      }
    }

    // Delete from local DB
    const deleted = deleteUploadedFile(conn, input.file_id);

    return formatResponse({
      deleted,
      file_id: input.file_id,
      datalab_file_id: file.datalab_file_id,
      deleted_from_datalab: input.delete_from_datalab && !!file.datalab_file_id,
    });
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const fileManagementTools: Record<string, ToolDefinition> = {
  'ocr_file_upload': {
    description: 'Upload a file to Datalab cloud storage. Deduplicates by file hash - returns existing upload if hash matches.',
    inputSchema: FileUploadInput.shape,
    handler: handleFileUpload,
  },
  'ocr_file_list': {
    description: 'List uploaded files with optional status filter (pending, uploading, confirming, complete, failed)',
    inputSchema: FileListInput.shape,
    handler: handleFileList,
  },
  'ocr_file_get': {
    description: 'Get metadata for a specific uploaded file by ID',
    inputSchema: FileGetInput.shape,
    handler: handleFileGet,
  },
  'ocr_file_download': {
    description: 'Get a download URL for a file uploaded to Datalab cloud',
    inputSchema: FileDownloadInput.shape,
    handler: handleFileDownload,
  },
  'ocr_file_delete': {
    description: 'Delete an uploaded file record. Optionally also delete from Datalab cloud.',
    inputSchema: FileDeleteInput.shape,
    handler: handleFileDelete,
  },
};
