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

import { existsSync, statSync } from 'fs';
import { basename, extname } from 'path';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  formatResponse,
  handleError,
  fetchProvenanceChain,
  type ToolDefinition,
} from './shared.js';
import { successResult } from '../server/types.js';
import { validateInput, sanitizePath } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { logAudit } from '../services/audit.js';
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
  include_provenance: z.boolean().default(false).describe('Include provenance chain for this file'),
});

const FileDownloadInput = z.object({
  file_id: z.string().min(1).describe('Uploaded file record ID'),
  expires_in: z
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(3600)
    .describe('Download URL expiry in seconds (default: 3600, min: 60, max: 86400)'),
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
          next_steps: [
            { tool: 'ocr_file_get', description: 'View details of the existing upload' },
          ],
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

      logAudit({
        action: 'file_upload',
        entityType: 'file',
        entityId: uploadId,
        details: { file_name: result.fileName, file_size: result.fileSize, datalab_file_id: result.fileId },
      });

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
          next_steps: [
            {
              tool: 'ocr_file_ingest_uploaded',
              description: 'Convert uploaded file into a document record for OCR',
            },
            {
              tool: 'ocr_process_pending',
              description: 'Process ingested documents through OCR pipeline',
            },
          ],
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

      const potentialDuplicates: Array<{
        group_size: number;
        avg_file_size: number;
        files: Array<{ id: string; file_name: string; file_size: number; file_hash: string }>;
        has_hash_matches: boolean;
      }> = [];

      for (const [, group] of sizeGroups) {
        if (group.length >= 3) {
          const avgSize = Math.round(group.reduce((sum, f) => sum + f.file_size, 0) / group.length);
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

    return formatResponse(
      successResult({
        ...response,
        next_steps: [
          { tool: 'ocr_file_get', description: 'Get details for a specific uploaded file' },
          {
            tool: 'ocr_file_ingest_uploaded',
            description: 'Ingest uploaded files for OCR processing',
          },
        ],
      })
    );
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

    if (input.include_provenance) {
      response.provenance_chain = fetchProvenanceChain(db, file.provenance_id, 'file-management');
    }

    return formatResponse(
      successResult({
        ...response,
        next_steps: [
          { tool: 'ocr_file_ingest_uploaded', description: 'Ingest this file for OCR processing' },
          { tool: 'ocr_file_download', description: 'Get a download URL for this file' },
        ],
      })
    );
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
    const downloadResult = await client.getDownloadUrl(file.datalab_file_id, input.expires_in);

    return formatResponse(
      successResult({
        file_id: input.file_id,
        datalab_file_id: file.datalab_file_id,
        file_name: file.file_name,
        download_url: downloadResult.downloadUrl,
        expires_in: downloadResult.expiresIn,
        next_steps: [{ tool: 'ocr_file_get', description: 'View file metadata' }],
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

    logAudit({
      action: 'file_delete',
      entityType: 'file',
      entityId: input.file_id,
      details: { file_name: file.file_name, deleted_from_datalab: datalabDeleteSucceeded },
    });

    const response: Record<string, unknown> = {
      deleted,
      file_id: input.file_id,
      datalab_file_id: file.datalab_file_id,
      deleted_from_datalab: datalabDeleteSucceeded,
    };
    if (datalabDeleteError) {
      response.datalab_delete_error = datalabDeleteError;
    }
    return formatResponse(
      successResult({
        ...response,
        next_steps: [{ tool: 'ocr_file_list', description: 'List remaining uploaded files' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE INGEST UPLOADED HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

const FileIngestUploadedInput = z.object({
  file_ids: z.array(z.string().min(1)).optional().describe('Specific uploaded file IDs to ingest'),
  ingest_all_pending: z
    .boolean()
    .default(false)
    .describe('Ingest all completed uploads that do not yet have matching document records'),
});

/**
 * Handle ocr_file_ingest_uploaded - Bridge file uploads and document ingestion.
 *
 * Takes uploaded files (from ocr_file_upload) and creates document records
 * for them so they can be processed through the OCR pipeline.
 */
async function handleFileIngestUploaded(params: Record<string, unknown>) {
  try {
    const input = validateInput(FileIngestUploadedInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Collect uploaded files to process
    type UploadedFileRecord = {
      id: string;
      local_path: string;
      file_name: string;
      file_hash: string;
      file_size: number;
      upload_status: string;
      provenance_id: string;
    };

    let uploadedFiles: UploadedFileRecord[] = [];

    if (input.file_ids && input.file_ids.length > 0) {
      // Specific file IDs
      for (const fileId of input.file_ids) {
        const file = getUploadedFile(conn, fileId);
        if (!file) {
          throw new Error(`Uploaded file not found: ${fileId}`);
        }
        if (file.upload_status !== 'complete') {
          throw new Error(
            `Uploaded file ${fileId} is not complete (status: ${file.upload_status})`
          );
        }
        uploadedFiles.push(file);
      }
    } else if (input.ingest_all_pending) {
      // All completed uploads that don't have matching documents
      const allComplete = listUploadedFiles(conn, { status: 'complete', limit: 1000 });
      // Filter out those that already have a document with the same file_hash
      uploadedFiles = allComplete.filter((f) => {
        const existingDoc = db.getDocumentByHash(f.file_hash);
        return !existingDoc;
      });
    } else {
      // Neither file_ids nor ingest_all_pending - return empty result
      return formatResponse(
        successResult({
          ingested_count: 0,
          skipped_count: 0,
          files: [],
          message: 'No action taken. Provide file_ids or set ingest_all_pending=true.',
          next_steps: [
            { tool: 'ocr_file_list', description: 'List uploaded files to select for ingestion' },
          ],
        })
      );
    }

    let ingestedCount = 0;
    let skippedCount = 0;
    const fileDetails: Array<{
      uploaded_file_id: string;
      file_name: string;
      document_id: string | null;
      status: string;
      message?: string;
    }> = [];

    for (const uploadedFile of uploadedFiles) {
      // Dedup check: file_hash already in documents?
      const existingDoc = db.getDocumentByHash(uploadedFile.file_hash);
      if (existingDoc) {
        skippedCount++;
        fileDetails.push({
          uploaded_file_id: uploadedFile.id,
          file_name: uploadedFile.file_name,
          document_id: existingDoc.id,
          status: 'skipped',
          message: `Document already exists with same file hash (${existingDoc.file_path})`,
        });
        continue;
      }

      // Check the local file still exists
      if (!existsSync(uploadedFile.local_path)) {
        skippedCount++;
        fileDetails.push({
          uploaded_file_id: uploadedFile.id,
          file_name: uploadedFile.file_name,
          document_id: null,
          status: 'skipped',
          message: `Local file not found: ${uploadedFile.local_path}`,
        });
        continue;
      }

      // Create document record
      const documentId = uuidv4();
      const provenanceId = uuidv4();
      const now = new Date().toISOString();
      const ext = extname(uploadedFile.file_name).slice(1).toLowerCase();

      // Create DOCUMENT provenance
      db.insertProvenance({
        id: provenanceId,
        type: ProvenanceType.DOCUMENT,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'FILE',
        source_path: uploadedFile.local_path,
        source_id: null,
        root_document_id: provenanceId,
        location: null,
        content_hash: uploadedFile.file_hash,
        input_hash: null,
        file_hash: uploadedFile.file_hash,
        processor: 'file-ingest-uploaded',
        processor_version: '1.0.0',
        processing_params: { uploaded_file_id: uploadedFile.id },
        processing_duration_ms: null,
        processing_quality_score: null,
        parent_id: null,
        parent_ids: '[]',
        chain_depth: 0,
        chain_path: '["DOCUMENT"]',
      });

      // Insert document with status 'pending' (ready for OCR)
      db.insertDocument({
        id: documentId,
        file_path: uploadedFile.local_path,
        file_name: uploadedFile.file_name,
        file_hash: uploadedFile.file_hash,
        file_size: uploadedFile.file_size,
        file_type: ext || 'pdf',
        status: 'pending',
        page_count: null,
        provenance_id: provenanceId,
        error_message: null,
        modified_at: null,
        ocr_completed_at: null,
        doc_title: null,
        doc_author: null,
        doc_subject: null,
        datalab_file_id: null,
      });

      ingestedCount++;
      fileDetails.push({
        uploaded_file_id: uploadedFile.id,
        file_name: uploadedFile.file_name,
        document_id: documentId,
        status: 'ingested',
      });
    }

    logAudit({
      action: 'file_ingest_uploaded',
      entityType: 'file',
      details: { ingested_count: ingestedCount, skipped_count: skippedCount },
    });

    return formatResponse(
      successResult({
        ingested_count: ingestedCount,
        skipped_count: skippedCount,
        files: fileDetails,
        next_steps:
          ingestedCount > 0
            ? [
                {
                  tool: 'ocr_process_pending',
                  description: 'Process ingested documents through OCR pipeline',
                },
              ]
            : [{ tool: 'ocr_file_list', description: 'List uploaded files' }],
      })
    );
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
      '[SETUP] Use to upload a file to Datalab cloud storage. Returns upload ID and Datalab reference. Deduplicates by file hash. Follow with ocr_file_ingest_uploaded.',
    inputSchema: FileUploadInput.shape,
    handler: handleFileUpload,
  },
  ocr_file_list: {
    description:
      '[STATUS] Use to list uploaded files with optional status filter. Returns file names, sizes, and upload status. Set include_duplicate_check=true to detect potential duplicates.',
    inputSchema: FileListInput.shape,
    handler: handleFileList,
  },
  ocr_file_get: {
    description:
      '[STATUS] Use to get metadata for a specific uploaded file by ID. Returns file details, Datalab info, and optional provenance chain.',
    inputSchema: FileGetInput.shape,
    handler: handleFileGet,
  },
  ocr_file_download: {
    description:
      '[STATUS] Use to get a download URL for a file previously uploaded to Datalab cloud. Returns a temporary download URL.',
    inputSchema: FileDownloadInput.shape,
    handler: handleFileDownload,
  },
  ocr_file_delete: {
    description:
      '[DESTRUCTIVE] Use to delete an uploaded file record. Returns confirmation. Set delete_from_datalab=true to also remove from Datalab cloud.',
    inputSchema: FileDeleteInput.shape,
    handler: handleFileDelete,
  },
  ocr_file_ingest_uploaded: {
    description:
      '[PROCESSING] Use to convert uploaded files into document records ready for OCR. Returns ingested document IDs. Deduplicates by file hash. Follow with ocr_process_pending.',
    inputSchema: FileIngestUploadedInput.shape,
    handler: handleFileIngestUploaded,
  },
};
