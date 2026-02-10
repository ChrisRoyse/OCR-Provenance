/**
 * ProvenanceExporter - Export provenance records in JSON, W3C PROV-JSON, and CSV
 *
 * Constitution Compliance:
 * - CP-001: Complete provenance chain for every data item
 * - CP-003: SHA-256 content hashing
 * - CP-005: Full reproducibility via processing params
 *
 * FAIL FAST: All errors throw immediately with detailed error info
 * NO MOCKS: Tests use real DatabaseService
 */

import { writeFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../storage/database/index.js';
import { ProvenanceTracker, ProvenanceErrorCode } from './tracker.js';
import { ProvenanceRecord, ProvenanceType } from '../../models/provenance.js';
import { rowToProvenance } from '../storage/database/converters.js';
import { ProvenanceRow } from '../storage/database/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export type ExportScope = 'document' | 'database' | 'all';
export type ExportFormat = 'json' | 'w3c-prov' | 'csv';

/**
 * W3C PROV-JSON Document structure
 * Reference: https://www.w3.org/submissions/prov-json/
 */
interface PROVDocument {
  prefix: Record<string, string>;
  entity: Record<string, Record<string, unknown>>;
  activity: Record<string, Record<string, unknown>>;
  agent: Record<string, Record<string, unknown>>;
  wasDerivedFrom: Record<string, Record<string, unknown>>;
  wasGeneratedBy: Record<string, Record<string, unknown>>;
  wasAttributedTo: Record<string, Record<string, unknown>>;
}

/** Result of JSON export */
interface JSONExportResult {
  format: 'json';
  scope: ExportScope;
  document_id?: string;
  exported_at: string;
  record_count: number;
  records: ProvenanceRecord[];
}

/** Result of W3C PROV-JSON export */
interface W3CPROVExportResult {
  format: 'w3c-prov';
  scope: ExportScope;
  document_id?: string;
  exported_at: string;
  entity_count: number;
  activity_count: number;
  agent_count: number;
  prov_document: PROVDocument;
}

/** Result of CSV export */
interface CSVExportResult {
  format: 'csv';
  scope: ExportScope;
  document_id?: string;
  exported_at: string;
  record_count: number;
  csv_content: string;
}

/** Result of file export */
interface FileExportResult {
  success: boolean;
  format: ExportFormat;
  output_path: string;
  bytes_written: number;
  record_count: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING - FAIL FAST
// ═══════════════════════════════════════════════════════════════════════════════

/** Error codes for exporter operations - extends ProvenanceErrorCode */
export const ExporterErrorCode = {
  ...ProvenanceErrorCode,
  INVALID_SCOPE: 'INVALID_EXPORT_SCOPE',
  INVALID_FORMAT: 'INVALID_EXPORT_FORMAT',
  FILE_WRITE_ERROR: 'FILE_WRITE_ERROR',
  DOCUMENT_REQUIRED: 'DOCUMENT_ID_REQUIRED_FOR_SCOPE',
} as const;

type ExporterErrorCodeType = typeof ExporterErrorCode[keyof typeof ExporterErrorCode];

/**
 * ExporterError - Typed error for export operations
 * FAIL FAST: Always throw with detailed error information
 */
export class ExporterError extends Error {
  constructor(
    message: string,
    public readonly code: ExporterErrorCodeType,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ExporterError';
    Object.setPrototypeOf(this, ExporterError.prototype);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ProvenanceExporter - Export provenance records in multiple formats
 *
 * Supports:
 * - JSON: Internal JSON format with full ProvenanceRecord data
 * - W3C PROV-JSON: Standard W3C PROV-JSON format for interoperability
 * - CSV: Tabular format for spreadsheet/analysis tools
 *
 * Scopes:
 * - document: Export all records for a specific root document
 * - database/all: Export all records in the database
 */
export class ProvenanceExporter {
  private readonly rawDb: Database.Database;

  private static readonly PROV_PREFIX = 'http://www.w3.org/ns/prov#';
  private static readonly OCR_PREFIX = 'http://ocr-provenance.local/ns#';
  private static readonly OCRP_PREFIX = 'http://ocr-provenance.local/prov#';

  constructor(
    db: DatabaseService,
    private readonly tracker: ProvenanceTracker
  ) {
    this.rawDb = db.getConnection();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Export provenance records as internal JSON format
   *
   * @param scope - 'document' (requires documentId), 'database', or 'all'
   * @param documentId - Required when scope='document'
   * @returns JSONExportResult with full ProvenanceRecord array
   * @throws ExporterError if scope invalid or documentId missing when required
   */
  async exportJSON(scope: ExportScope, documentId?: string): Promise<JSONExportResult> {
    this.validateScope(scope, documentId);

    const records = this.getRecordsForScope(scope, documentId);

    return {
      format: 'json',
      scope,
      document_id: documentId,
      exported_at: new Date().toISOString(),
      record_count: records.length,
      records,
    };
  }

  /**
   * Export provenance records as W3C PROV-JSON format
   *
   * Reference: https://www.w3.org/submissions/prov-json/
   *
   * Mapping:
   * - ProvenanceRecord -> prov:Entity
   * - Processing operation -> prov:Activity (non-DOCUMENT types)
   * - Processor -> prov:Agent
   * - source_id relationship -> wasDerivedFrom
   * - Processing creates record -> wasGeneratedBy
   * - Processor attribution -> wasAttributedTo
   *
   * @param scope - 'document' (requires documentId), 'database', or 'all'
   * @param documentId - Required when scope='document'
   * @returns W3CPROVExportResult with PROV-JSON document
   * @throws ExporterError if scope invalid or documentId missing when required
   */
  async exportW3CPROV(scope: ExportScope, documentId?: string): Promise<W3CPROVExportResult> {
    this.validateScope(scope, documentId);

    const records = this.getRecordsForScope(scope, documentId);
    const provDoc = this.transformToPROVJSON(records);

    return {
      format: 'w3c-prov',
      scope,
      document_id: documentId,
      exported_at: new Date().toISOString(),
      entity_count: Object.keys(provDoc.entity).length,
      activity_count: Object.keys(provDoc.activity).length,
      agent_count: Object.keys(provDoc.agent).length,
      prov_document: provDoc,
    };
  }

  /**
   * Export provenance records as CSV format
   *
   * @param scope - 'document' (requires documentId), 'database', or 'all'
   * @param documentId - Required when scope='document'
   * @returns CSVExportResult with CSV content string
   * @throws ExporterError if scope invalid or documentId missing when required
   */
  async exportCSV(scope: ExportScope, documentId?: string): Promise<CSVExportResult> {
    this.validateScope(scope, documentId);

    const records = this.getRecordsForScope(scope, documentId);
    const csvContent = this.transformToCSV(records);

    return {
      format: 'csv',
      scope,
      document_id: documentId,
      exported_at: new Date().toISOString(),
      record_count: records.length,
      csv_content: csvContent,
    };
  }

  /**
   * Export provenance records to a file
   *
   * Creates parent directories if they don't exist.
   *
   * @param outputPath - Absolute path to output file
   * @param format - 'json', 'w3c-prov', or 'csv'
   * @param scope - 'document' (requires documentId), 'database', or 'all'
   * @param documentId - Required when scope='document'
   * @returns FileExportResult with bytes written and path
   * @throws ExporterError if format invalid, scope invalid, or write fails
   */
  async exportToFile(
    outputPath: string,
    format: ExportFormat,
    scope: ExportScope,
    documentId?: string
  ): Promise<FileExportResult> {
    // Get content based on format (export methods validate scope internally)
    let content: string;
    let recordCount: number;

    switch (format) {
      case 'json': {
        const result = await this.exportJSON(scope, documentId);
        content = JSON.stringify(result, null, 2);
        recordCount = result.record_count;
        break;
      }
      case 'w3c-prov': {
        const result = await this.exportW3CPROV(scope, documentId);
        content = JSON.stringify(result, null, 2);
        recordCount = result.entity_count;
        break;
      }
      case 'csv': {
        const result = await this.exportCSV(scope, documentId);
        content = result.csv_content;
        recordCount = result.record_count;
        break;
      }
      default:
        throw new ExporterError(
          `Invalid export format: ${format}. Valid formats: json, w3c-prov, csv`,
          ExporterErrorCode.INVALID_FORMAT,
          { providedFormat: format, validFormats: ['json', 'w3c-prov', 'csv'] }
        );
    }

    // Create parent directories if needed
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write file
    try {
      await writeFile(outputPath, content, 'utf-8');
    } catch (error) {
      throw new ExporterError(
        `Failed to write export file: ${outputPath}`,
        ExporterErrorCode.FILE_WRITE_ERROR,
        {
          outputPath,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );
    }

    const bytesWritten = Buffer.byteLength(content, 'utf-8');

    return {
      success: true,
      format,
      output_path: outputPath,
      bytes_written: bytesWritten,
      record_count: recordCount,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate scope and documentId
   * @throws ExporterError if invalid
   */
  private validateScope(scope: ExportScope, documentId?: string): void {
    const validScopes: ExportScope[] = ['document', 'database', 'all'];

    if (!validScopes.includes(scope)) {
      throw new ExporterError(
        `Invalid export scope: ${scope}. Valid scopes: ${validScopes.join(', ')}`,
        ExporterErrorCode.INVALID_SCOPE,
        { providedScope: scope, validScopes }
      );
    }

    if (scope === 'document' && !documentId) {
      throw new ExporterError(
        'documentId is required when scope is "document"',
        ExporterErrorCode.DOCUMENT_REQUIRED,
        { scope }
      );
    }
  }

  /**
   * Get provenance records for the given scope
   * Note: validateScope() must be called before this to ensure documentId is present when needed
   */
  private getRecordsForScope(scope: ExportScope, documentId?: string): ProvenanceRecord[] {
    if (scope === 'document') {
      return this.tracker.getProvenanceByRootDocument(documentId!);
    }
    // 'database' and 'all' are equivalent - return all records
    return this.getAllProvenance();
  }

  /**
   * Get all provenance records from database
   * Ordered by chain_depth ASC, created_at ASC
   */
  private getAllProvenance(): ProvenanceRecord[] {
    // H-5: Use iterate() to avoid double-allocation (.all() + .map())
    const records: ProvenanceRecord[] = [];
    const stmt = this.rawDb.prepare(
      'SELECT * FROM provenance ORDER BY chain_depth ASC, created_at ASC'
    );
    for (const row of stmt.iterate() as Iterable<ProvenanceRow>) {
      records.push(rowToProvenance(row));
    }
    return records;
  }

  /**
   * Transform provenance records to W3C PROV-JSON format
   *
   * Mapping rules:
   * - Each ProvenanceRecord becomes an entity: ocr:<type>-<id>
   * - Non-DOCUMENT types create an activity: ocr:activity-<id>
   * - Unique agents per processor name
   * - wasDerivedFrom links entities with source_id
   * - wasGeneratedBy links entities to their activities
   * - wasAttributedTo links all entities to their processor agents
   */
  private transformToPROVJSON(records: ProvenanceRecord[]): PROVDocument {
    const doc: PROVDocument = {
      prefix: {
        prov: ProvenanceExporter.PROV_PREFIX,
        ocr: ProvenanceExporter.OCR_PREFIX,
        ocrp: ProvenanceExporter.OCRP_PREFIX,
      },
      entity: {},
      activity: {},
      agent: {},
      wasDerivedFrom: {},
      wasGeneratedBy: {},
      wasAttributedTo: {},
    };

    // M-13: Map-based lookup to avoid O(N^2) find() in wasDerivedFrom
    const recordById = new Map<string, ProvenanceRecord>();
    for (const record of records) {
      recordById.set(record.id, record);
    }

    // Track unique agents
    const agents = new Map<string, string>(); // processor name -> agent ID

    for (const record of records) {
      // 1. Create entity
      const entityId = `ocr:${record.type.toLowerCase()}-${record.id}`;
      doc.entity[entityId] = {
        'prov:type': `ocr:${record.type}`,
        'prov:generatedAtTime': record.created_at,
        'ocr:content_hash': record.content_hash,
        'ocr:chain_depth': record.chain_depth,
        'ocr:root_document_id': record.root_document_id,
        'ocr:processor': record.processor,
        'ocr:processor_version': record.processor_version,
      };

      // Add location if present
      if (record.location) {
        doc.entity[entityId]['ocr:location'] = record.location;
      }

      // Add source_path for DOCUMENT type
      if (record.type === ProvenanceType.DOCUMENT && record.source_path) {
        doc.entity[entityId]['ocr:source_path'] = record.source_path;
      }

      // Add specific attributes for IMAGE type
      if (record.type === ProvenanceType.IMAGE) {
        doc.entity[entityId]['prov:type'] = 'ocrp:Image';
        if (record.location?.bounding_box) {
          doc.entity[entityId]['ocrp:bounding_box'] = record.location.bounding_box;
        }
        if (record.location?.page_number) {
          doc.entity[entityId]['ocrp:page_number'] = record.location.page_number;
        }
      }

      // Add specific attributes for VLM_DESCRIPTION type
      if (record.type === ProvenanceType.VLM_DESCRIPTION) {
        doc.entity[entityId]['prov:type'] = 'ocrp:VLMDescription';
      }

      // Add file_hash if present
      if (record.file_hash) {
        doc.entity[entityId]['ocr:file_hash'] = record.file_hash;
      }

      // 2. Create activity for non-DOCUMENT types
      if (record.type !== ProvenanceType.DOCUMENT) {
        const activityId = `ocr:activity-${record.id}`;
        doc.activity[activityId] = {
          'prov:type': `ocr:${record.source_type}Activity`,
          'prov:startTime': record.created_at,
          'prov:endTime': record.processed_at,
          'ocr:processor': record.processor,
          'ocr:processor_version': record.processor_version,
          'ocr:processing_params': record.processing_params,
        };

        if (record.processing_duration_ms !== null) {
          doc.activity[activityId]['ocr:processing_duration_ms'] = record.processing_duration_ms;
        }

        // 3. wasGeneratedBy - link entity to activity
        const wgbId = `ocr:wgb-${record.id}`;
        doc.wasGeneratedBy[wgbId] = {
          'prov:entity': entityId,
          'prov:activity': activityId,
          'prov:time': record.processed_at,
        };
      }

      // 4. Create/link agent
      const sanitizedProcessor = this.sanitizeAgentId(record.processor);
      const agentId = `ocr:agent-${sanitizedProcessor}`;

      if (!agents.has(record.processor)) {
        agents.set(record.processor, agentId);
        doc.agent[agentId] = {
          'prov:type': 'prov:SoftwareAgent',
          'ocr:name': record.processor,
          'ocr:version': record.processor_version,
        };
      }

      // 5. wasAttributedTo - link entity to agent
      const watId = `ocr:wat-${record.id}`;
      doc.wasAttributedTo[watId] = {
        'prov:entity': entityId,
        'prov:agent': agents.get(record.processor)!,
      };

      // 6. wasDerivedFrom - link to source entity if present
      if (record.source_id) {
        // M-13: Use Map lookup instead of O(N) find()
        const sourceRecord = recordById.get(record.source_id);
        if (sourceRecord) {
          const sourceEntityId = `ocr:${sourceRecord.type.toLowerCase()}-${sourceRecord.id}`;
          const wdfId = `ocr:wdf-${record.id}`;
          doc.wasDerivedFrom[wdfId] = {
            'prov:generatedEntity': entityId,
            'prov:usedEntity': sourceEntityId,
          };
        }
      }
    }

    return doc;
  }

  /**
   * Sanitize processor name for use as agent ID
   * Only allows alphanumeric and hyphens
   */
  private sanitizeAgentId(processor: string): string {
    return processor
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Transform provenance records to CSV format
   */
  private transformToCSV(records: ProvenanceRecord[]): string {
    const headers = [
      'id',
      'type',
      'created_at',
      'processed_at',
      'source_type',
      'source_path',
      'source_id',
      'root_document_id',
      'content_hash',
      'input_hash',
      'file_hash',
      'processor',
      'processor_version',
      'processing_params',
      'processing_duration_ms',
      'processing_quality_score',
      'parent_id',
      'parent_ids',
      'chain_depth',
      'chain_path',
      'location',
    ];

    const headerRow = headers.join(',');

    if (records.length === 0) {
      return headerRow;
    }

    const dataRows = records.map(record => {
      const values = [
        this.escapeCSV(record.id),
        this.escapeCSV(record.type),
        this.escapeCSV(record.created_at),
        this.escapeCSV(record.processed_at),
        this.escapeCSV(record.source_type),
        this.escapeCSV(record.source_path ?? ''),
        this.escapeCSV(record.source_id ?? ''),
        this.escapeCSV(record.root_document_id),
        this.escapeCSV(record.content_hash),
        this.escapeCSV(record.input_hash ?? ''),
        this.escapeCSV(record.file_hash ?? ''),
        this.escapeCSV(record.processor),
        this.escapeCSV(record.processor_version),
        this.escapeCSV(JSON.stringify(record.processing_params)),
        record.processing_duration_ms?.toString() ?? '',
        record.processing_quality_score?.toString() ?? '',
        this.escapeCSV(record.parent_id ?? ''),
        this.escapeCSV(record.parent_ids),
        record.chain_depth.toString(),
        this.escapeCSV(record.chain_path ?? ''),
        this.escapeCSV(record.location ? JSON.stringify(record.location) : ''),
      ];
      return values.join(',');
    });

    return [headerRow, ...dataRows].join('\n');
  }

  /**
   * Escape a value for CSV
   * - Wrap in quotes if contains comma, quote, or newline
   * - Escape quotes by doubling them
   */
  private escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }
}
