/**
 * File System Utilities for OCR Provenance MCP System
 *
 * Provides secure file operations with path sanitization to prevent
 * directory traversal attacks. Implements SEC-002 requirements.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { FileMetadata, SUPPORTED_FILE_TYPES } from '../models/document.js';

/**
 * MIME type mapping for supported file types
 */
const MIME_TYPE_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  gif: 'image/gif',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};

/**
 * Error class for path traversal detection
 */
export class PathTraversalError extends Error {
  code: string;

  constructor(message: string = 'Path traversal detected') {
    super(message);
    this.name = 'PathTraversalError';
    this.code = 'PATH_TRAVERSAL_DETECTED';
  }
}

/**
 * Sanitize and validate a file path
 *
 * Security requirements (SEC-002):
 * 1. Resolve paths to absolute before use
 * 2. Reject paths containing ".."
 * 3. Validate paths are within allowed directories
 *
 * @param inputPath - User-provided path (may be relative or absolute)
 * @param baseDir - Base directory that path must be within
 * @returns Resolved absolute path if valid
 * @throws PathTraversalError with code 'PATH_TRAVERSAL_DETECTED' if path escapes baseDir
 */
export function sanitizePath(inputPath: string, baseDir: string): string {
  // Reject obvious traversal attempts immediately
  if (inputPath.includes('..')) {
    throw new PathTraversalError('Path traversal detected: contains ".."');
  }

  // Resolve both paths to absolute
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(baseDir, inputPath);

  // Ensure resolved path is within base directory
  // Must either equal the base or be a subdirectory of it
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + path.sep)) {
    throw new PathTraversalError('Path traversal detected: path escapes base directory');
  }

  return resolvedPath;
}

/**
 * Get file extension (normalized, lowercase, without dot)
 *
 * @param filePath - Path to file
 * @returns Extension like 'pdf', 'png' (without dot, lowercase)
 */
export function getFileExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  // Remove the leading dot if present
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/**
 * Get MIME type for a file extension
 *
 * @param extension - File extension (with or without dot)
 * @returns MIME type string or 'application/octet-stream' if unknown
 */
export function getMimeType(extension: string): string {
  const ext = extension.startsWith('.') ? extension.slice(1) : extension;
  return MIME_TYPE_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Get metadata for a file
 *
 * @param filePath - Absolute path to file
 * @returns FileMetadata object
 * @throws Error if file does not exist or cannot be accessed
 */
export async function getFileMetadata(filePath: string): Promise<FileMetadata> {
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  const extension = getFileExtension(filePath);
  const mimeType = getMimeType(extension);

  return {
    size: stats.size,
    mimeType,
    extension,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
  };
}

/**
 * Scan a directory for files matching extensions
 *
 * @param dirPath - Directory to scan
 * @param extensions - File extensions to match (e.g., ['.pdf', '.png'] or ['pdf', 'png'])
 * @param recursive - Whether to scan subdirectories
 * @returns Array of absolute file paths
 */
export async function scanDirectory(
  dirPath: string,
  extensions: string[],
  recursive: boolean
): Promise<string[]> {
  // Normalize extensions to lowercase without dots for comparison
  const normalizedExtensions = extensions.map((ext) =>
    ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase()
  );

  const results: string[] = [];
  const resolvedDir = path.resolve(dirPath);

  // Read directory entries
  const entries = await fs.readdir(resolvedDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(resolvedDir, entry.name);

    if (entry.isFile()) {
      const ext = getFileExtension(entry.name);
      if (normalizedExtensions.includes(ext)) {
        results.push(fullPath);
      }
    } else if (entry.isDirectory() && recursive) {
      // Recursively scan subdirectories
      const subResults = await scanDirectory(fullPath, extensions, recursive);
      results.push(...subResults);
    }
  }

  return results;
}

/**
 * Check if file type is allowed for OCR processing
 *
 * @param filePath - Path to check
 * @returns true if extension is in SUPPORTED_FILE_TYPES
 */
export function isAllowedFileType(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return (SUPPORTED_FILE_TYPES as readonly string[]).includes(ext);
}

/**
 * Ensure a directory exists, creating it if necessary
 *
 * @param dirPath - Directory path to ensure exists
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Check if a path exists and is a file
 *
 * @param filePath - Path to check
 * @returns true if path exists and is a file
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a path exists and is a directory
 *
 * @param dirPath - Path to check
 * @returns true if path exists and is a directory
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read file contents as a buffer
 *
 * @param filePath - Path to file
 * @returns File contents as Buffer
 */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}

/**
 * Read file contents as text
 *
 * @param filePath - Path to file
 * @param encoding - Text encoding (default: utf-8)
 * @returns File contents as string
 */
export async function readFileText(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<string> {
  return fs.readFile(filePath, { encoding });
}
