/**
 * Tool-Level Permission System
 *
 * 6 permission scopes, 4 roles.
 * Each tool declares a required scope.
 * Permission check runs before handler execution.
 *
 * FAIL FAST: Unauthorized access throws immediately.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module server/permissions
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type PermissionScope =
  | 'ocr:read'
  | 'ocr:write'
  | 'ocr:review'
  | 'ocr:configure'
  | 'ocr:delete'
  | 'ocr:admin';

export type UserRole = 'viewer' | 'reviewer' | 'editor' | 'admin';

// ═══════════════════════════════════════════════════════════════════════════════
// ROLE-SCOPE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/** Role to scopes mapping */
const ROLE_SCOPES: Record<UserRole, Set<PermissionScope>> = {
  viewer: new Set(['ocr:read']),
  reviewer: new Set(['ocr:read', 'ocr:review']),
  editor: new Set(['ocr:read', 'ocr:write', 'ocr:review']),
  admin: new Set([
    'ocr:read',
    'ocr:write',
    'ocr:review',
    'ocr:configure',
    'ocr:delete',
    'ocr:admin',
  ]),
};

// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

/** Check if a role has a specific permission scope */
export function hasPermission(role: UserRole, scope: PermissionScope): boolean {
  return ROLE_SCOPES[role]?.has(scope) ?? false;
}

/** Get all scopes for a role */
export function getScopesForRole(role: UserRole): PermissionScope[] {
  return Array.from(ROLE_SCOPES[role] ?? []);
}

/** Validate that a role string is valid */
export function isValidRole(role: string): role is UserRole {
  return role in ROLE_SCOPES;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL-SCOPE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/** Tool name to required scope mapping */
export const TOOL_SCOPES: Record<string, PermissionScope> = {
  // ── Read tools ────────────────────────────────────────────────────────────
  ocr_db_list: 'ocr:read',
  ocr_db_stats: 'ocr:read',
  ocr_search: 'ocr:read',
  ocr_fts_manage: 'ocr:read',
  ocr_search_export: 'ocr:read',
  ocr_benchmark_compare: 'ocr:read',
  ocr_rag_context: 'ocr:read',
  ocr_search_saved: 'ocr:read',
  ocr_search_cross_db: 'ocr:read',
  ocr_document_list: 'ocr:read',
  ocr_document_get: 'ocr:read',
  ocr_document_find_similar: 'ocr:read',
  ocr_document_structure: 'ocr:read',
  ocr_document_duplicates: 'ocr:read',
  ocr_document_versions: 'ocr:read',
  ocr_document_page: 'ocr:read',
  ocr_export: 'ocr:read',
  ocr_provenance_get: 'ocr:read',
  ocr_provenance_verify: 'ocr:read',
  ocr_provenance_export: 'ocr:read',
  ocr_provenance_query: 'ocr:read',
  ocr_provenance_timeline: 'ocr:read',
  ocr_provenance_processor_stats: 'ocr:read',
  ocr_vlm_status: 'ocr:read',
  ocr_image_list: 'ocr:read',
  ocr_image_get: 'ocr:read',
  ocr_image_stats: 'ocr:read',
  ocr_image_pending: 'ocr:read',
  ocr_image_search: 'ocr:read',
  ocr_chunk_get: 'ocr:read',
  ocr_chunk_list: 'ocr:read',
  ocr_chunk_context: 'ocr:read',
  ocr_embedding_list: 'ocr:read',
  ocr_embedding_stats: 'ocr:read',
  ocr_embedding_get: 'ocr:read',
  ocr_tag_list: 'ocr:read',
  ocr_tag_search: 'ocr:read',
  ocr_document_tables: 'ocr:read',
  ocr_document_recommend: 'ocr:read',
  ocr_document_extras: 'ocr:read',
  ocr_table_export: 'ocr:read',
  ocr_config_get: 'ocr:read',
  ocr_health_check: 'ocr:read',
  ocr_guide: 'ocr:read',
  ocr_report_overview: 'ocr:read',
  ocr_report_performance: 'ocr:read',
  ocr_document_report: 'ocr:read',
  ocr_evaluation_report: 'ocr:read',
  ocr_error_analytics: 'ocr:read',
  ocr_trends: 'ocr:read',
  ocr_cost_summary: 'ocr:read',
  ocr_status: 'ocr:read',
  ocr_comparison_list: 'ocr:read',
  ocr_comparison_get: 'ocr:read',
  ocr_cluster_list: 'ocr:read',
  ocr_cluster_get: 'ocr:read',
  ocr_extraction_list: 'ocr:read',
  ocr_extraction_get: 'ocr:read',
  ocr_file_list: 'ocr:read',
  ocr_file_get: 'ocr:read',
  ocr_form_fill_status: 'ocr:read',

  // ── Write tools ───────────────────────────────────────────────────────────
  ocr_db_create: 'ocr:write',
  ocr_db_select: 'ocr:write',
  ocr_ingest_files: 'ocr:write',
  ocr_ingest_directory: 'ocr:write',
  ocr_process_pending: 'ocr:write',
  ocr_reprocess: 'ocr:write',
  ocr_retry_failed: 'ocr:write',
  ocr_convert_raw: 'ocr:write',
  ocr_embedding_rebuild: 'ocr:write',
  ocr_vlm_describe: 'ocr:write',
  ocr_vlm_process: 'ocr:write',
  ocr_vlm_analyze_pdf: 'ocr:write',
  ocr_extract_images: 'ocr:write',
  ocr_extract_structured: 'ocr:write',
  ocr_form_fill: 'ocr:write',
  ocr_file_upload: 'ocr:write',
  ocr_file_download: 'ocr:write',
  ocr_file_ingest_uploaded: 'ocr:write',
  ocr_document_compare: 'ocr:write',
  ocr_comparison_discover: 'ocr:write',
  ocr_comparison_batch: 'ocr:write',
  ocr_comparison_matrix: 'ocr:write',
  ocr_cluster_documents: 'ocr:write',
  ocr_cluster_assign: 'ocr:write',
  ocr_cluster_merge: 'ocr:write',
  ocr_cluster_reassign: 'ocr:write',
  ocr_tag_create: 'ocr:write',
  ocr_tag_apply: 'ocr:write',
  ocr_tag_remove: 'ocr:write',
  ocr_document_update_metadata: 'ocr:write',
  ocr_image_reanalyze: 'ocr:write',
  ocr_image_reset_failed: 'ocr:write',
  ocr_evaluate: 'ocr:write',

  // ── Review tools (future Phase 2/3) ───────────────────────────────────────
  ocr_document_workflow: 'ocr:review',
  ocr_annotation_create: 'ocr:review',
  ocr_annotation_update: 'ocr:review',
  ocr_annotation_list: 'ocr:read',
  ocr_annotation_get: 'ocr:read',
  ocr_annotation_summary: 'ocr:read',
  ocr_workflow_submit: 'ocr:review',
  ocr_workflow_review: 'ocr:review',
  ocr_workflow_assign: 'ocr:review',
  ocr_workflow_status: 'ocr:read',
  ocr_workflow_queue: 'ocr:read',

  // ── Configure tools ───────────────────────────────────────────────────────
  ocr_config_set: 'ocr:configure',

  // ── Delete tools ──────────────────────────────────────────────────────────
  ocr_document_delete: 'ocr:delete',
  ocr_db_delete: 'ocr:delete',
  ocr_tag_delete: 'ocr:delete',
  ocr_cluster_delete: 'ocr:delete',
  ocr_image_delete: 'ocr:delete',
  ocr_file_delete: 'ocr:delete',
  ocr_annotation_delete: 'ocr:delete',
  ocr_document_unlock: 'ocr:delete',

  // ── Admin tools ───────────────────────────────────────────────────────────
  ocr_user_info: 'ocr:admin',
  ocr_audit_query: 'ocr:admin',
  ocr_webhook_create: 'ocr:admin',
  ocr_webhook_list: 'ocr:admin',
  ocr_webhook_delete: 'ocr:admin',
  ocr_compliance_report: 'ocr:admin',
  ocr_compliance_hipaa: 'ocr:admin',
  ocr_compliance_export: 'ocr:admin',
};

// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/** Check permission - returns true if allowed, false if denied. Admin always passes. */
export function checkToolPermission(toolName: string, userRole: UserRole | null): boolean {
  // No user context = local mode = full access
  if (userRole === null) return true;

  const requiredScope = TOOL_SCOPES[toolName];
  // Tools not in the map are allowed (new tools default to accessible)
  if (!requiredScope) return true;

  return hasPermission(userRole, requiredScope);
}
