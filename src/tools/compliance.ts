/**
 * Compliance Reporting MCP Tools
 *
 * Provides 3 MCP tools for compliance and regulatory reporting:
 * - ocr_compliance_report: General compliance overview
 * - ocr_compliance_hipaa: HIPAA-specific compliance report
 * - ocr_compliance_export: Export audit trail in regulatory format (SOC 2, HIPAA, SOX)
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/compliance
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import { verifyChainHashes, backfillChainHashes } from '../services/provenance/chain-hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const ComplianceReportInputSchema = z.object({
  include_hash_verification: z
    .boolean()
    .default(false)
    .describe(
      'When true, sample up to 10 document provenance chains for hash-chain verification (can be slow on large databases)'
    ),
  backfill_chain_hashes: z
    .boolean()
    .default(false)
    .describe(
      'When true, backfill chain_hash values for pre-v32 provenance records before reporting'
    ),
});

const ComplianceHipaaInputSchema = z.object({
  date_from: z.string().optional().describe('Filter from this ISO 8601 datetime'),
  date_to: z.string().optional().describe('Filter up to this ISO 8601 datetime'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('Maximum PHI access entries to return'),
});

const ComplianceExportInputSchema = z.object({
  format: z.enum(['soc2', 'hipaa', 'sox']).describe('Regulatory format to export'),
  date_from: z.string().optional().describe('Filter from this ISO 8601 datetime'),
  date_to: z.string().optional().describe('Filter up to this ISO 8601 datetime'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Safe table existence check
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check whether a table exists in the database.
 * Returns false instead of throwing if the table is missing (pre-v32 databases).
 */
function tableExists(conn: import('better-sqlite3').Database, tableName: string): boolean {
  const row = conn
    .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { cnt: number } | undefined;
  return (row?.cnt ?? 0) > 0;
}

/**
 * Safe count query - returns 0 if table does not exist.
 */
function safeCount(
  conn: import('better-sqlite3').Database,
  tableName: string,
  whereClause?: string,
  params?: (string | number)[]
): number {
  if (!tableExists(conn, tableName)) return 0;
  const sql = whereClause
    ? `SELECT COUNT(*) as cnt FROM ${tableName} WHERE ${whereClause}`
    : `SELECT COUNT(*) as cnt FROM ${tableName}`;
  const row = conn.prepare(sql).get(...(params ?? [])) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 1: ocr_compliance_report
// ═══════════════════════════════════════════════════════════════════════════════

async function handleComplianceReport(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComplianceReportInputSchema, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // -- Document statistics --
    const totalDocuments = safeCount(conn, 'documents');
    const processedDocuments = safeCount(conn, 'documents', "status = 'complete'");
    const failedDocuments = safeCount(conn, 'documents', "status = 'failed'");
    const pendingDocuments = safeCount(conn, 'documents', "status = 'pending'");

    // -- Provenance coverage --
    const totalProvenance = safeCount(conn, 'provenance');
    const provenanceWithHash = safeCount(conn, 'provenance', 'content_hash IS NOT NULL');
    const provenanceWithChainHash = safeCount(conn, 'provenance', 'chain_hash IS NOT NULL');
    const provenanceCoverage =
      totalProvenance > 0 ? Math.round((provenanceWithHash / totalProvenance) * 10000) / 100 : 0;
    const chainHashCoverage =
      totalProvenance > 0
        ? Math.round((provenanceWithChainHash / totalProvenance) * 10000) / 100
        : 0;

    // -- User statistics --
    const totalUsers = safeCount(conn, 'users');
    const activeUsers = safeCount(conn, 'users', "last_active_at > datetime('now', '-30 days')");

    // -- Audit log statistics --
    const totalAuditEntries = safeCount(conn, 'audit_log');
    const recentAuditEntries = safeCount(
      conn,
      'audit_log',
      "created_at > datetime('now', '-7 days')"
    );

    // -- Audit log action breakdown --
    const auditActionBreakdown: Record<string, number> = {};
    if (tableExists(conn, 'audit_log') && totalAuditEntries > 0) {
      const actionRows = conn
        .prepare(
          'SELECT action, COUNT(*) as cnt FROM audit_log GROUP BY action ORDER BY cnt DESC LIMIT 20'
        )
        .all() as Array<{ action: string; cnt: number }>;
      for (const row of actionRows) {
        auditActionBreakdown[row.action] = row.cnt;
      }
    }

    // -- Annotation coverage --
    const totalAnnotations = safeCount(conn, 'annotations');
    const resolvedAnnotations = safeCount(conn, 'annotations', "status = 'resolved'");

    // -- Optional: backfill chain hashes --
    let backfillResult: { updated: number; errors: number } | undefined;
    if (input.backfill_chain_hashes) {
      backfillResult = backfillChainHashes(conn);
    }

    // -- Optional: hash-chain verification (sample up to 10 documents) --
    const hashVerification: Array<{
      document_id: string;
      provenance_id: string;
      valid: boolean;
      total_records: number;
      verified: number;
      error?: string;
    }> = [];

    if (input.include_hash_verification) {
      const docRows = conn
        .prepare('SELECT id, provenance_id FROM documents LIMIT 10')
        .all() as Array<{ id: string; provenance_id: string }>;

      for (const doc of docRows) {
        const result = verifyChainHashes(conn, doc.provenance_id);
        hashVerification.push({
          document_id: doc.id,
          provenance_id: doc.provenance_id,
          valid: result.valid,
          total_records: result.total_records,
          verified: result.verified,
          error: result.error,
        });
      }
    }

    return formatResponse(
      successResult({
        report_type: 'compliance_overview',
        generated_at: new Date().toISOString(),
        documents: {
          total: totalDocuments,
          processed: processedDocuments,
          failed: failedDocuments,
          pending: pendingDocuments,
        },
        provenance: {
          total_records: totalProvenance,
          content_hash_coverage_pct: provenanceCoverage,
          chain_hash_coverage_pct: chainHashCoverage,
        },
        users: {
          total: totalUsers,
          active_last_30_days: activeUsers,
        },
        audit_log: {
          total_entries: totalAuditEntries,
          entries_last_7_days: recentAuditEntries,
          action_breakdown: auditActionBreakdown,
        },
        annotations: {
          total: totalAnnotations,
          resolved: resolvedAnnotations,
        },
        hash_verification:
          hashVerification.length > 0
            ? {
                sampled: hashVerification.length,
                all_valid: hashVerification.every((v) => v.valid),
                details: hashVerification,
              }
            : undefined,
        backfill_result: backfillResult,
        next_steps: [
          {
            tool: 'ocr_compliance_hipaa',
            description: 'Generate HIPAA-specific compliance report',
          },
          {
            tool: 'ocr_compliance_export',
            description: 'Export audit trail in SOC 2, HIPAA, or SOX format',
          },
          {
            tool: 'ocr_provenance_verify',
            description: 'Verify integrity of a specific document provenance chain',
          },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2: ocr_compliance_hipaa
// ═══════════════════════════════════════════════════════════════════════════════

async function handleComplianceHipaa(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComplianceHipaaInputSchema, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // -- Build date filter conditions --
    const conditions: string[] = [];
    const queryParams: (string | number)[] = [];

    if (input.date_from) {
      conditions.push('a.created_at >= ?');
      queryParams.push(input.date_from);
    }
    if (input.date_to) {
      conditions.push('a.created_at <= ?');
      queryParams.push(input.date_to);
    }

    const dateWhereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    // -- PHI access log: searches and document reads --
    let phiAccessLog: Array<Record<string, unknown>> = [];
    if (tableExists(conn, 'audit_log')) {
      const phiRows = conn
        .prepare(
          `SELECT a.id, a.user_id, a.action, a.entity_type, a.entity_id,
                  a.created_at, a.ip_address,
                  u.display_name as user_display_name
           FROM audit_log a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE (a.action LIKE '%search%' OR a.action LIKE '%document.get%'
                  OR a.action LIKE '%document.read%' OR a.action LIKE '%export%')
           ${dateWhereClause}
           ORDER BY a.created_at DESC
           LIMIT ?`
        )
        .all(...queryParams, input.limit) as Array<Record<string, unknown>>;
      phiAccessLog = phiRows;
    }

    // -- Minimum necessary analysis: distinct user count per document --
    let minimumNecessary: Array<{ document_id: string; distinct_users: number }> = [];
    if (tableExists(conn, 'audit_log')) {
      const mnConditions = [...conditions];
      const mnParams = [...queryParams];

      const mnWhere = mnConditions.length > 0 ? `AND ${mnConditions.join(' AND ')}` : '';

      minimumNecessary = conn
        .prepare(
          `SELECT a.entity_id as document_id, COUNT(DISTINCT a.user_id) as distinct_users
           FROM audit_log a
           WHERE a.entity_type = 'document'
           ${mnWhere}
           GROUP BY a.entity_id
           ORDER BY distinct_users DESC
           LIMIT 50`
        )
        .all(...mnParams) as Array<{ document_id: string; distinct_users: number }>;
    }

    // -- Data retention info --
    let oldestDocument: string | null = null;
    let newestDocument: string | null = null;
    const docRange = conn
      .prepare('SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM documents')
      .get() as { oldest: string | null; newest: string | null } | undefined;
    if (docRange) {
      oldestDocument = docRange.oldest;
      newestDocument = docRange.newest;
    }

    // -- Encryption status --
    const encryptionStatus = {
      data_at_rest: 'SQLite database file (encryption depends on filesystem/OS-level encryption)',
      data_in_transit: 'MCP stdio transport (local process communication)',
      content_hashes: 'SHA-256 content hashing enabled for all provenance records',
    };

    // -- User authentication summary --
    const totalUsers = safeCount(conn, 'users');
    const userRoleBreakdown: Record<string, number> = {};
    if (tableExists(conn, 'users') && totalUsers > 0) {
      const roleRows = conn
        .prepare('SELECT role, COUNT(*) as cnt FROM users GROUP BY role')
        .all() as Array<{ role: string; cnt: number }>;
      for (const row of roleRows) {
        userRoleBreakdown[row.role] = row.cnt;
      }
    }

    return formatResponse(
      successResult({
        report_type: 'hipaa_compliance',
        generated_at: new Date().toISOString(),
        date_range: {
          from: input.date_from ?? null,
          to: input.date_to ?? null,
        },
        phi_access_log: {
          total_entries: phiAccessLog.length,
          entries: phiAccessLog,
        },
        minimum_necessary_analysis: {
          description:
            'Documents accessed by multiple distinct users (potential over-sharing indicator)',
          documents: minimumNecessary,
        },
        data_retention: {
          oldest_document: oldestDocument,
          newest_document: newestDocument,
          total_documents: safeCount(conn, 'documents'),
        },
        encryption_status: encryptionStatus,
        user_authentication: {
          total_users: totalUsers,
          role_breakdown: userRoleBreakdown,
        },
        next_steps: [
          {
            tool: 'ocr_compliance_export',
            description: 'Export full HIPAA audit trail with ocr_compliance_export format=hipaa',
          },
          {
            tool: 'ocr_audit_query',
            description: 'Query specific audit log entries for detailed investigation',
          },
          {
            tool: 'ocr_compliance_report',
            description: 'Generate general compliance overview',
          },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 3: ocr_compliance_export
// ═══════════════════════════════════════════════════════════════════════════════

async function handleComplianceExport(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComplianceExportInputSchema, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // -- Build date filter conditions --
    const conditions: string[] = [];
    const queryParams: (string | number)[] = [];

    if (input.date_from) {
      conditions.push('created_at >= ?');
      queryParams.push(input.date_from);
    }
    if (input.date_to) {
      conditions.push('created_at <= ?');
      queryParams.push(input.date_to);
    }

    const auditWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // -- Gather common data --
    const auditEntries = tableExists(conn, 'audit_log')
      ? (conn
          .prepare(
            `SELECT a.*, u.display_name as user_display_name
             FROM audit_log a
             LEFT JOIN users u ON a.user_id = u.id
             ${auditWhereClause}
             ORDER BY a.created_at ASC
             LIMIT 5000`
          )
          .all(...queryParams) as Array<Record<string, unknown>>)
      : [];

    const users = tableExists(conn, 'users')
      ? (conn.prepare('SELECT * FROM users').all() as Array<Record<string, unknown>>)
      : [];

    const totalDocuments = safeCount(conn, 'documents');
    const totalProvenance = safeCount(conn, 'provenance');
    const provenanceWithHash = safeCount(conn, 'provenance', 'content_hash IS NOT NULL');

    let exportData: Record<string, unknown>;

    switch (input.format) {
      case 'soc2':
        exportData = buildSOC2Export(
          auditEntries,
          users,
          totalDocuments,
          totalProvenance,
          provenanceWithHash,
          input
        );
        break;

      case 'hipaa':
        exportData = buildHIPAAExport(conn, auditEntries, users, totalDocuments, input);
        break;

      case 'sox':
        exportData = buildSOXExport(conn, auditEntries, users, totalDocuments, input);
        break;
    }

    return formatResponse(
      successResult({
        format: input.format,
        generated_at: new Date().toISOString(),
        date_range: {
          from: input.date_from ?? null,
          to: input.date_to ?? null,
        },
        export: exportData,
        record_counts: {
          audit_entries: auditEntries.length,
          users: users.length,
          documents: totalDocuments,
          provenance_records: totalProvenance,
        },
        next_steps: [
          {
            tool: 'ocr_compliance_report',
            description: 'Generate compliance overview with hash verification',
          },
          {
            tool: 'ocr_provenance_export',
            description: 'Export raw provenance data in W3C PROV format',
          },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT FORMAT BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildSOC2Export(
  auditEntries: Array<Record<string, unknown>>,
  users: Array<Record<string, unknown>>,
  totalDocuments: number,
  totalProvenance: number,
  provenanceWithHash: number,
  input: { date_from?: string; date_to?: string }
): Record<string, unknown> {
  return {
    framework: 'SOC 2 Type II',
    report_period: {
      from: input.date_from ?? 'inception',
      to: input.date_to ?? new Date().toISOString(),
    },
    access_controls: {
      description: 'Role-based access control with user identity tracking',
      total_users: users.length,
      user_roles: users.map((u) => ({
        user_id: u.id,
        display_name: u.display_name,
        role: u.role,
        created_at: u.created_at,
        last_active_at: u.last_active_at,
      })),
    },
    audit_trail: {
      description: 'Complete audit trail of all user and system actions',
      total_entries: auditEntries.length,
      entries: auditEntries.map((e) => ({
        timestamp: e.created_at,
        user_id: e.user_id,
        user_name: e.user_display_name,
        action: e.action,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
        ip_address: e.ip_address,
      })),
    },
    data_integrity: {
      description: 'SHA-256 content hashing with provenance chain verification',
      total_documents: totalDocuments,
      total_provenance_records: totalProvenance,
      records_with_content_hash: provenanceWithHash,
      hash_coverage_pct:
        totalProvenance > 0 ? Math.round((provenanceWithHash / totalProvenance) * 10000) / 100 : 0,
    },
  };
}

function buildHIPAAExport(
  _conn: import('better-sqlite3').Database,
  auditEntries: Array<Record<string, unknown>>,
  users: Array<Record<string, unknown>>,
  totalDocuments: number,
  input: { date_from?: string; date_to?: string }
): Record<string, unknown> {
  // Filter for PHI-relevant access entries
  const phiActions = auditEntries.filter((e) => {
    const action = String(e.action ?? '');
    return (
      action.includes('search') ||
      action.includes('document.get') ||
      action.includes('document.read') ||
      action.includes('export') ||
      action.includes('download')
    );
  });

  return {
    framework: 'HIPAA Security Rule',
    report_period: {
      from: input.date_from ?? 'inception',
      to: input.date_to ?? new Date().toISOString(),
    },
    phi_access: {
      description: 'Record of all access to potentially protected health information',
      total_access_events: phiActions.length,
      entries: phiActions.map((e) => ({
        timestamp: e.created_at,
        user_id: e.user_id,
        user_name: e.user_display_name,
        action: e.action,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
        ip_address: e.ip_address,
      })),
    },
    encryption_status: {
      content_hashing: 'SHA-256 (all provenance records)',
      chain_verification: 'Merkle-like hash chain (v32+)',
      transport: 'MCP stdio (local process)',
      storage: 'SQLite (filesystem-level encryption recommended)',
    },
    user_authentication: {
      description: 'User identity and role management',
      total_users: users.length,
      users: users.map((u) => ({
        user_id: u.id,
        display_name: u.display_name,
        role: u.role,
        email: u.email,
        created_at: u.created_at,
        last_active_at: u.last_active_at,
      })),
    },
    document_inventory: {
      total_documents: totalDocuments,
      note: 'Use ocr_document_list for full document inventory with metadata',
    },
  };
}

function buildSOXExport(
  conn: import('better-sqlite3').Database,
  auditEntries: Array<Record<string, unknown>>,
  users: Array<Record<string, unknown>>,
  totalDocuments: number,
  input: { date_from?: string; date_to?: string }
): Record<string, unknown> {
  // -- Approval chain evidence --
  let approvalChains: Array<Record<string, unknown>> = [];
  if (tableExists(conn, 'approval_chains')) {
    approvalChains = conn
      .prepare('SELECT * FROM approval_chains ORDER BY created_at DESC LIMIT 100')
      .all() as Array<Record<string, unknown>>;
  }

  let approvalSteps: Array<Record<string, unknown>> = [];
  if (tableExists(conn, 'approval_steps')) {
    approvalSteps = conn
      .prepare(
        `SELECT s.*, u.display_name as decided_by_name
         FROM approval_steps s
         LEFT JOIN users u ON s.decided_by = u.id
         ORDER BY s.decided_at DESC
         LIMIT 200`
      )
      .all() as Array<Record<string, unknown>>;
  }

  // -- Workflow state evidence --
  let workflowStates: Array<Record<string, unknown>> = [];
  if (tableExists(conn, 'workflow_states')) {
    workflowStates = conn
      .prepare('SELECT * FROM workflow_states ORDER BY created_at DESC LIMIT 100')
      .all() as Array<Record<string, unknown>>;
  }

  // Filter for document modification events (financial trail)
  const documentTrail = auditEntries.filter((e) => {
    const action = String(e.action ?? '');
    return (
      action.includes('ingest') ||
      action.includes('process') ||
      action.includes('delete') ||
      action.includes('workflow') ||
      action.includes('approval')
    );
  });

  return {
    framework: 'SOX Section 404',
    report_period: {
      from: input.date_from ?? 'inception',
      to: input.date_to ?? new Date().toISOString(),
    },
    financial_document_trail: {
      description: 'Complete document lifecycle trail for financial records',
      total_documents: totalDocuments,
      modification_events: documentTrail.length,
      entries: documentTrail.map((e) => ({
        timestamp: e.created_at,
        user_id: e.user_id,
        user_name: e.user_display_name,
        action: e.action,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
      })),
    },
    approval_chain_evidence: {
      description: 'Document approval chains and decisions',
      total_chains: approvalChains.length,
      chains: approvalChains,
      total_decisions: approvalSteps.length,
      decisions: approvalSteps,
    },
    workflow_evidence: {
      description: 'Document workflow state transitions',
      total_workflows: workflowStates.length,
      workflows: workflowStates,
    },
    access_controls: {
      total_users: users.length,
      users: users.map((u) => ({
        user_id: u.id,
        display_name: u.display_name,
        role: u.role,
        created_at: u.created_at,
      })),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const complianceTools: Record<string, ToolDefinition> = {
  ocr_compliance_report: {
    description:
      '[STATUS] Use to generate a compliance overview report for the database. Returns document counts, provenance coverage, user activity, audit log summary, annotation coverage, and optional hash-chain verification.',
    inputSchema: {
      include_hash_verification: z
        .boolean()
        .default(false)
        .describe(
          'When true, sample up to 10 document provenance chains for hash-chain verification'
        ),
      backfill_chain_hashes: z
        .boolean()
        .default(false)
        .describe(
          'When true, backfill chain_hash values for pre-v32 provenance records before reporting'
        ),
    },
    handler: handleComplianceReport,
  },

  ocr_compliance_hipaa: {
    description:
      '[STATUS] Use to generate a HIPAA-specific compliance report. Returns PHI access log (search/read events), minimum necessary analysis (document access by distinct users), data retention info, encryption status, and user authentication summary.',
    inputSchema: {
      date_from: z.string().optional().describe('Filter from this ISO 8601 datetime'),
      date_to: z.string().optional().describe('Filter up to this ISO 8601 datetime'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Maximum PHI access entries to return'),
    },
    handler: handleComplianceHipaa,
  },

  ocr_compliance_export: {
    description:
      '[STATUS] Use to export the full audit trail in a regulatory format. Supports SOC 2 (access controls, audit trail, data integrity), HIPAA (PHI access, encryption, user auth), and SOX (financial document trail, approval chain evidence, workflow state).',
    inputSchema: {
      format: z.enum(['soc2', 'hipaa', 'sox']).describe('Regulatory format: soc2, hipaa, or sox'),
      date_from: z.string().optional().describe('Filter from this ISO 8601 datetime'),
      date_to: z.string().optional().describe('Filter up to this ISO 8601 datetime'),
    },
    handler: handleComplianceExport,
  },
};
