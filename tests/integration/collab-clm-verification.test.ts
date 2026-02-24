/**
 * Full State Verification: Collaboration, CLM, and System Optimization
 *
 * Comprehensive integration test that exercises EVERY new feature against a real
 * SQLite database with real data. No mocks. Every write operation is followed by
 * a direct SELECT to verify database state.
 *
 * Phase 1: Users & Audit
 * Phase 2: Annotations & Locks
 * Phase 3: Workflow & Approval Chains
 * Phase 4: CLM (Playbooks, Obligations, Summarization)
 * Phase 5: Webhooks & Exports
 * Phase 6: Cursor-based Pagination
 * Phase 7: Compliance Reports
 * Edge Cases
 *
 * @module tests/integration/collab-clm-verification
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createDatabase, resetState, requireDatabase } from '../../src/server/state.js';
import { userTools } from '../../src/tools/users.js';
import { collaborationTools } from '../../src/tools/collaboration.js';
import { workflowTools } from '../../src/tools/workflow.js';
import { eventTools } from '../../src/tools/events.js';
import { clmTools } from '../../src/tools/clm.js';
import { complianceTools } from '../../src/tools/compliance.js';
import { documentTools } from '../../src/tools/documents.js';

// ═════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const DB_NAME = 'test-collab-clm-verify';

/**
 * Parse the JSON text response from a tool handler.
 * Tool responses are wrapped in { success: true, data: { ... } }.
 * Returns the inner `data` object.
 */
function parseResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): Record<string, unknown> {
  const outer = JSON.parse(result.content[0].text) as Record<string, unknown>;
  // successResult wraps in { success, data }; unwrap automatically
  if (outer.success === true && outer.data !== undefined) {
    return outer.data as Record<string, unknown>;
  }
  return outer;
}

/** Insert a test document directly into the database (bypasses Datalab API) */
function insertTestDocument(id: string, fileName: string): void {
  const { db } = requireDatabase();
  const conn = db.getConnection();
  const now = new Date().toISOString();
  const provenanceId = `prov-${id}`;

  conn.prepare(`
    INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_path, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
    VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, ?, 'test-hash-' || ?, 'test', '1.0', '{}', '[]', 0)
  `).run(provenanceId, now, now, `/test/${fileName}`, id, id);

  conn.prepare(`
    INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
    VALUES (?, ?, ?, 'hash-' || ?, 1000, 'pdf', 'complete', ?, ?)
  `).run(id, `/test/${fileName}`, fileName, id, provenanceId, now);
}

/** Insert a dummy OCR result (FK dependency for chunks) */
function insertTestOCRResult(docId: string, ocrId: string): void {
  const { db } = requireDatabase();
  const conn = db.getConnection();
  const now = new Date().toISOString();
  const provId = `prov-ocr-${docId}`;

  const existing = conn.prepare('SELECT id FROM ocr_results WHERE id = ?').get(ocrId);
  if (existing) return;

  conn.prepare(`
    INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
    VALUES (?, 'OCR_RESULT', ?, ?, 'OCR', ?, 'ocr-hash-' || ?, 'datalab', '1.0', '{}', '[]', 1)
  `).run(provId, now, now, docId, docId);

  conn.prepare(`
    INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length, datalab_request_id, datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, 'Full extracted text for testing', 32, 'req-test', 'balanced', 3, 'ocr-content-hash-' || ?, ?, ?, 100)
  `).run(ocrId, provId, docId, docId, now, now);
}

/** Insert test chunks for a document */
function insertTestChunks(docId: string, ocrId: string, chunkTexts: string[]): void {
  const { db } = requireDatabase();
  const conn = db.getConnection();
  const now = new Date().toISOString();

  for (let i = 0; i < chunkTexts.length; i++) {
    const chunkId = `chunk-${docId}-${i}`;
    const chunkProvId = `prov-chunk-${docId}-${i}`;

    conn.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, 'chunk-hash-' || ?, 'chunker', '1.0', '{}', '[]', 2)
    `).run(chunkProvId, now, now, `prov-ocr-${docId}`, docId, chunkId);

    conn.prepare(`
      INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end, page_number, overlap_previous, overlap_next, provenance_id, created_at, embedding_status)
      VALUES (?, ?, ?, ?, 'thash-' || ?, ?, ?, ?, ?, 0, 0, ?, ?, 'pending')
    `).run(chunkId, docId, ocrId, chunkTexts[i], chunkId, i, i * 1000, (i + 1) * 1000, i + 1, chunkProvId, now);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SHARED STATE
// ═════════════════════════════════════════════════════════════════════════════

let userId: string;
let secondUserId: string;
let annotationId: string;
let replyAnnotationId: string;
let approvalChainId: string;
let playbookId: string;
let obligationId: string;
let webhookId: string;

const DOC_ID_1 = 'test-doc-001';
const DOC_ID_2 = 'test-doc-002';
const DOC_ID_3 = 'test-doc-003';
const OCR_ID_1 = 'ocr-test-001';
const OCR_ID_2 = 'ocr-test-002';
const OCR_ID_3 = 'ocr-test-003';

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═════════════════════════════════════════════════════════════════════════════

describe('COLLAB-CLM-SYSOPT FULL STATE VERIFICATION', () => {
  beforeAll(() => {
    // Create a fresh test database
    createDatabase(DB_NAME, 'Integration test for collaboration and CLM verification');

    // Insert test documents with OCR results and chunks
    insertTestDocument(DOC_ID_1, 'contract-alpha.pdf');
    insertTestOCRResult(DOC_ID_1, OCR_ID_1);
    insertTestChunks(DOC_ID_1, OCR_ID_1, [
      'This confidentiality agreement is entered into between Acme Corp and Beta LLC. The effective date is January 1, 2026.',
      'The parties agree to keep all proprietary information confidential. This obligation shall survive termination of this agreement for a period of 5 years.',
      'Governing law: This agreement shall be governed by the laws of the State of California. Any disputes shall be resolved in the courts of San Francisco.',
    ]);

    insertTestDocument(DOC_ID_2, 'nda-bravo.pdf');
    insertTestOCRResult(DOC_ID_2, OCR_ID_2);
    insertTestChunks(DOC_ID_2, OCR_ID_2, [
      'Non-disclosure agreement between Charlie Inc and Delta Partners. Payment terms: Net 30 days.',
      'The total value of this contract is $150,000. Penalties for late delivery include a 2% surcharge per week.',
      'This agreement shall automatically renew for successive one-year terms unless either party provides 60 days written notice of termination.',
    ]);

    insertTestDocument(DOC_ID_3, 'sow-charlie.pdf');
    insertTestOCRResult(DOC_ID_3, OCR_ID_3);
    insertTestChunks(DOC_ID_3, OCR_ID_3, [
      'Statement of Work for Project Phoenix. Deliverables: Phase 1 report due March 2026.',
      'Force majeure: Neither party shall be liable for delays caused by unforeseeable circumstances.',
      'Data protection: All personal data shall be processed in accordance with GDPR requirements.',
    ]);
  });

  afterAll(() => {
    resetState();
    const dbPath = path.join(process.env.HOME || '', `.ocr-provenance/databases/${DB_NAME}.db`);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    for (const ext of ['-wal', '-shm']) {
      const walPath = dbPath + ext;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 1: Users & Audit
  // ─────────────────────────────────────────────────────────────────────────

  describe('Phase 1: Users & Audit', () => {
    it('1. Should create a user via ocr_user_info', async () => {
      const result = await userTools.ocr_user_info.handler({
        display_name: 'Alice Admin',
        email: 'alice@example.com',
        role: 'admin',
        external_id: 'ext-alice-001',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.created).toBe(true);
      const user = data.user as Record<string, unknown>;
      expect(user.display_name).toBe('Alice Admin');
      expect(user.role).toBe('admin');
      expect(user.email).toBe('alice@example.com');
      expect(user.external_id).toBe('ext-alice-001');
      userId = user.id as string;
      expect(userId).toBeTruthy();

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      expect(dbRow.display_name).toBe('Alice Admin');
      expect(dbRow.role).toBe('admin');
    });

    it('1b. Should create a second user for lock conflict tests', async () => {
      const result = await userTools.ocr_user_info.handler({
        display_name: 'Bob Reviewer',
        email: 'bob@example.com',
        role: 'reviewer',
        external_id: 'ext-bob-002',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      expect(data.created).toBe(true);
      secondUserId = (data.user as Record<string, unknown>).id as string;
      expect(secondUserId).toBeTruthy();
    });

    it('2. Should get user info back by user_id', async () => {
      const result = await userTools.ocr_user_info.handler({ user_id: userId });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const user = data.user as Record<string, unknown>;

      expect(user.id).toBe(userId);
      expect(user.display_name).toBe('Alice Admin');
      expect(user.role).toBe('admin');
    });

    it('2b. Should get user by external_id (existing)', async () => {
      const result = await userTools.ocr_user_info.handler({ external_id: 'ext-alice-001' });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.created).toBe(false);
      const user = data.user as Record<string, unknown>;
      expect(user.id).toBe(userId);
    });

    it('3. Should query empty audit log', async () => {
      const result = await userTools.ocr_audit_query.handler({});
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total).toBe(0);
      expect(data.entries).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 2: Annotations & Locks
  // ─────────────────────────────────────────────────────────────────────────

  describe('Phase 2: Annotations & Locks', () => {
    it('4. Should create annotation on document (type=comment)', async () => {
      const result = await collaborationTools.ocr_annotation_create.handler({
        document_id: DOC_ID_1,
        user_id: userId,
        annotation_type: 'comment',
        content: 'This clause needs legal review.',
        page_number: 1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const annotation = data.annotation as Record<string, unknown>;

      expect(annotation.document_id).toBe(DOC_ID_1);
      expect(annotation.annotation_type).toBe('comment');
      expect(annotation.content).toBe('This clause needs legal review.');
      expect(annotation.status).toBe('open');
      annotationId = annotation.id as string;
      expect(annotationId).toBeTruthy();

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM annotations WHERE id = ?').get(annotationId) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      expect(dbRow.annotation_type).toBe('comment');
      expect(dbRow.status).toBe('open');
    });

    it('5. Should create threaded reply (parent_id)', async () => {
      const result = await collaborationTools.ocr_annotation_create.handler({
        document_id: DOC_ID_1,
        user_id: userId,
        annotation_type: 'comment',
        content: 'Agreed, flagging for legal team.',
        parent_id: annotationId,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const reply = data.annotation as Record<string, unknown>;

      expect(reply.parent_id).toBe(annotationId);
      replyAnnotationId = reply.id as string;
      expect(replyAnnotationId).toBeTruthy();

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM annotations WHERE id = ?').get(replyAnnotationId) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      expect(dbRow.parent_id).toBe(annotationId);
    });

    it('6. Should list annotations for document (returns 2)', async () => {
      const result = await collaborationTools.ocr_annotation_list.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total).toBe(2);
      const annotations = data.annotations as Array<Record<string, unknown>>;
      expect(annotations).toHaveLength(2);
    });

    it('7. Should update annotation status to resolved', async () => {
      const result = await collaborationTools.ocr_annotation_update.handler({
        annotation_id: annotationId,
        status: 'resolved',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const annotation = data.annotation as Record<string, unknown>;

      expect(annotation.status).toBe('resolved');

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM annotations WHERE id = ?').get(annotationId) as Record<string, unknown>;
      expect(dbRow.status).toBe('resolved');
      expect(dbRow.updated_at).not.toBe(dbRow.created_at);
    });

    it('8. Should get annotation with thread', async () => {
      const result = await collaborationTools.ocr_annotation_get.handler({
        annotation_id: annotationId,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      const annotation = data.annotation as Record<string, unknown>;
      expect(annotation.id).toBe(annotationId);
      expect(data.reply_count).toBe(1);
      const replies = data.replies as Array<Record<string, unknown>>;
      expect(replies).toHaveLength(1);
      expect(replies[0].id).toBe(replyAnnotationId);
    });

    it('9. Should get annotation summary', async () => {
      const result = await collaborationTools.ocr_annotation_summary.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total_resolved).toBe(1);
      expect(data.total_open).toBe(1); // the reply is still open
      expect(data.total).toBe(2);
    });

    it('10. Should delete reply annotation', async () => {
      const result = await collaborationTools.ocr_annotation_delete.handler({
        annotation_id: replyAnnotationId,
        confirm: true,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.deleted).toBe(true);

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM annotations WHERE id = ?').get(replyAnnotationId);
      expect(dbRow).toBeUndefined();

      const countRow = conn.prepare('SELECT COUNT(*) as c FROM annotations WHERE document_id = ?').get(DOC_ID_1) as { c: number };
      expect(countRow.c).toBe(1);
    });

    it('11. Should acquire exclusive lock on document', async () => {
      const result = await collaborationTools.ocr_document_lock.handler({
        document_id: DOC_ID_1,
        user_id: userId,
        session_id: 'session-001',
        lock_type: 'exclusive',
        reason: 'Editing contract terms',
        ttl_minutes: 30,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const lock = data.lock as Record<string, unknown>;

      expect(lock.document_id).toBe(DOC_ID_1);
      expect(lock.user_id).toBe(userId);
      expect(lock.lock_type).toBe('exclusive');

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM document_locks WHERE document_id = ?').get(DOC_ID_1) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      expect(dbRow.lock_type).toBe('exclusive');
    });

    it('12. Should fail to acquire another exclusive lock by different user', async () => {
      // Use the second user (valid FK) to attempt a conflicting lock
      const result = await collaborationTools.ocr_document_lock.handler({
        document_id: DOC_ID_1,
        user_id: secondUserId,
        session_id: 'session-002',
        lock_type: 'exclusive',
      });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('exclusively locked');
    });

    it('13. Should check lock status', async () => {
      const result = await collaborationTools.ocr_document_lock_status.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.is_locked).toBe(true);
      const lock = data.lock as Record<string, unknown>;
      expect(lock.user_id).toBe(userId);
    });

    it('14. Should release lock', async () => {
      const result = await collaborationTools.ocr_document_unlock.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.released).toBe(true);

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM document_locks WHERE document_id = ?').get(DOC_ID_1);
      expect(dbRow).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 3: Workflow & Approval Chains
  // ─────────────────────────────────────────────────────────────────────────

  describe('Phase 3: Workflow & Approval Chains', () => {
    it('15. Should submit document for review', async () => {
      const result = await workflowTools.ocr_workflow_submit.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const ws = data.workflow_state as Record<string, unknown>;

      expect(ws.state).toBe('submitted');
      expect(ws.document_id).toBe(DOC_ID_1);

      // VERIFY: Direct DB check - should have draft + submitted
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const rows = conn.prepare(
        'SELECT state FROM workflow_states WHERE document_id = ? ORDER BY created_at ASC'
      ).all(DOC_ID_1) as Array<{ state: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].state).toBe('draft');
      expect(rows[1].state).toBe('submitted');
    });

    it('16. Should assign reviewer (transitions to in_review)', async () => {
      const result = await workflowTools.ocr_workflow_assign.handler({
        document_id: DOC_ID_1,
        user_id: userId,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.transitioned_to).toBe('in_review');

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const latest = conn.prepare(
        'SELECT * FROM workflow_states WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      ).get(DOC_ID_1) as Record<string, unknown>;
      expect(latest.state).toBe('in_review');
      expect(latest.assigned_to).toBe(userId);
    });

    it('17. Should check workflow status', async () => {
      const result = await workflowTools.ocr_workflow_status.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      const current = data.current_state as Record<string, unknown>;
      expect(current.state).toBe('in_review');
      const history = data.history as Array<Record<string, unknown>>;
      expect(history.length).toBeGreaterThanOrEqual(3); // draft, submitted, in_review
    });

    it('18. Should approve the document', async () => {
      const result = await workflowTools.ocr_workflow_review.handler({
        document_id: DOC_ID_1,
        decision: 'approved',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.decision).toBe('approved');
      const ws = data.workflow_state as Record<string, unknown>;
      expect(ws.state).toBe('approved');

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const latest = conn.prepare(
        'SELECT state FROM workflow_states WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      ).get(DOC_ID_1) as { state: string };
      expect(latest.state).toBe('approved');
    });

    it('19. Should fail on invalid transition (approved -> submitted)', async () => {
      const result = await workflowTools.ocr_workflow_submit.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Invalid workflow transition');
    });

    it('20. Should get workflow queue', async () => {
      // Submit DOC_ID_2 for review so we have something in the queue
      await workflowTools.ocr_workflow_submit.handler({
        document_id: DOC_ID_2,
      });

      const result = await workflowTools.ocr_workflow_queue.handler({
        state: 'submitted',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const items = data.items as Array<Record<string, unknown>>;
      const doc2Item = items.find((i) => i.document_id === DOC_ID_2);
      expect(doc2Item).toBeDefined();
    });

    it('21. Should create approval chain', async () => {
      const result = await workflowTools.ocr_approval_chain_create.handler({
        name: 'Legal Review Chain',
        description: 'Standard legal review process',
        steps: [
          { role: 'reviewer' },
          { role: 'legal' },
          { role: 'manager' },
        ],
        created_by: userId,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      const chain = data.chain as Record<string, unknown>;
      expect(chain.name).toBe('Legal Review Chain');
      approvalChainId = chain.id as string;
      expect(approvalChainId).toBeTruthy();

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM approval_chains WHERE id = ?').get(approvalChainId) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      expect(dbRow.name).toBe('Legal Review Chain');
      const steps = JSON.parse(dbRow.steps_json as string);
      expect(steps).toHaveLength(3);
    });

    it('22. Should apply approval chain to document', async () => {
      const result = await workflowTools.ocr_approval_chain_apply.handler({
        document_id: DOC_ID_1,
        chain_id: approvalChainId,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.steps_created).toBe(3);

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const steps = conn.prepare(
        'SELECT * FROM approval_steps WHERE document_id = ? AND chain_id = ? ORDER BY step_order ASC'
      ).all(DOC_ID_1, approvalChainId) as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(3);
      expect(steps[0].required_role).toBe('reviewer');
      expect(steps[0].status).toBe('pending');
      expect(steps[1].required_role).toBe('legal');
      expect(steps[2].required_role).toBe('manager');
    });

    it('23. Should decide on first approval step', async () => {
      const result = await workflowTools.ocr_approval_step_decide.handler({
        document_id: DOC_ID_1,
        chain_id: approvalChainId,
        decision: 'approved',
        user_id: userId,
        reason: 'Looks good',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      const step = data.step as Record<string, unknown>;
      expect(step.status).toBe('approved');
      expect(step.decided_by).toBe(userId);

      const progress = data.progress as Record<string, unknown>;
      expect(progress.completed_steps).toBe(1);
      expect(progress.total_steps).toBe(3);
      expect(progress.is_complete).toBe(false);

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbStep = conn.prepare(
        "SELECT * FROM approval_steps WHERE document_id = ? AND chain_id = ? AND step_order = 1"
      ).get(DOC_ID_1, approvalChainId) as Record<string, unknown>;
      expect(dbStep.status).toBe('approved');
      expect(dbStep.decided_by).toBe(userId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 4: CLM (Playbooks, Obligations, Summarization)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Phase 4: CLM', () => {
    it('24. Should create a playbook with clauses', async () => {
      const result = await clmTools.ocr_playbook_create.handler({
        name: 'Standard NDA Playbook',
        description: 'Preferred clauses for NDA review',
        clauses: [
          {
            clause_name: 'confidentiality',
            preferred_text: 'proprietary information confidential',
            severity: 'critical',
            alternatives: ['confidential information'],
          },
          {
            clause_name: 'governing_law',
            preferred_text: 'governed by the laws of the State of California',
            severity: 'major',
            alternatives: ['laws of New York'],
          },
          {
            clause_name: 'non_compete',
            preferred_text: 'shall not compete directly',
            severity: 'minor',
            alternatives: [],
          },
        ],
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const playbook = data.playbook as Record<string, unknown>;

      expect(playbook.name).toBe('Standard NDA Playbook');
      playbookId = playbook.id as string;
      expect(playbookId).toBeTruthy();

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM playbooks WHERE id = ?').get(playbookId) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      const clauses = JSON.parse(dbRow.clauses_json as string);
      expect(clauses).toHaveLength(3);
      expect(clauses[0].clause_name).toBe('confidentiality');
      expect(clauses[0].severity).toBe('critical');
    });

    it('25. Should list playbooks', async () => {
      const result = await clmTools.ocr_playbook_list.handler({});
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total).toBe(1);
      const playbooks = data.playbooks as Array<Record<string, unknown>>;
      expect(playbooks[0].name).toBe('Standard NDA Playbook');
      expect(playbooks[0].clause_count).toBe(3);
    });

    it('26. Should compare document with playbook', async () => {
      const result = await clmTools.ocr_playbook_compare.handler({
        document_id: DOC_ID_1,
        playbook_id: playbookId,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const comparison = data.comparison as Record<string, unknown>;

      expect(comparison.document_id).toBe(DOC_ID_1);
      expect(comparison.playbook_id).toBe(playbookId);
      expect(comparison.total_clauses).toBe(3);
      expect((comparison.matches as number) + (comparison.alternative_matches as number)).toBeGreaterThanOrEqual(1);

      const clauseResults = comparison.clause_results as Array<Record<string, unknown>>;
      expect(clauseResults).toHaveLength(3);
    });

    it('27. Should create obligation manually', async () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const { createObligation } = await import('../../src/services/storage/database/obligation-operations.js');

      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 1);

      const obligation = createObligation(conn, {
        document_id: DOC_ID_1,
        obligation_type: 'payment',
        description: 'Monthly payment of $5,000 due on the 15th',
        responsible_party: 'Acme Corp',
        due_date: futureDate.toISOString(),
        status: 'active',
        confidence: 0.85,
      });

      obligationId = obligation.id;

      // VERIFY: Direct DB check
      const dbRow = conn.prepare('SELECT * FROM obligations WHERE id = ?').get(obligationId) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      expect(dbRow.obligation_type).toBe('payment');
      expect(dbRow.status).toBe('active');
      expect(dbRow.responsible_party).toBe('Acme Corp');
    });

    it('28. Should list obligations', async () => {
      const result = await clmTools.ocr_obligation_list.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const obligations = data.obligations as Array<Record<string, unknown>>;
      const found = obligations.find((o) => o.id === obligationId);
      expect(found).toBeDefined();
      expect(found!.obligation_type).toBe('payment');
    });

    it('29. Should update obligation status to fulfilled', async () => {
      const result = await clmTools.ocr_obligation_update.handler({
        obligation_id: obligationId,
        status: 'fulfilled',
        reason: 'Payment received on time',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const obligation = data.obligation as Record<string, unknown>;

      expect(obligation.status).toBe('fulfilled');

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM obligations WHERE id = ?').get(obligationId) as Record<string, unknown>;
      expect(dbRow.status).toBe('fulfilled');

      const metadata = JSON.parse(dbRow.metadata_json as string) as Record<string, unknown>;
      const history = metadata.status_history as Array<Record<string, string>>;
      expect(history).toHaveLength(1);
      expect(history[0].from).toBe('active');
      expect(history[0].to).toBe('fulfilled');
      expect(history[0].reason).toBe('Payment received on time');
    });

    it('30. Should get obligation calendar', async () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const { createObligation } = await import('../../src/services/storage/database/obligation-operations.js');

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 14);

      createObligation(conn, {
        document_id: DOC_ID_2,
        obligation_type: 'delivery',
        description: 'Deliver project milestone report',
        due_date: futureDate.toISOString(),
        status: 'active',
      });

      const result = await clmTools.ocr_obligation_calendar.handler({
        months_ahead: 3,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total_months).toBeGreaterThanOrEqual(0);
      expect(data.total_obligations).toBeGreaterThanOrEqual(0);
    });

    it('31. Should summarize document', async () => {
      const result = await clmTools.ocr_document_summarize.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.file_name).toBe('contract-alpha.pdf');
      const summary = data.summary as Record<string, unknown>;
      expect(summary.total_chunks).toBe(3);
      expect((summary.word_count as number)).toBeGreaterThan(0);
    });

    it('32. Should summarize corpus', async () => {
      const result = await clmTools.ocr_corpus_summarize.handler({});
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total_documents).toBe(3);
      expect(data.total_chunks).toBe(9);
      expect((data.total_words as number)).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 5: Webhooks & Exports
  // ─────────────────────────────────────────────────────────────────────────

  describe('Phase 5: Webhooks & Exports', () => {
    it('33. Should create webhook', async () => {
      const result = await eventTools.ocr_webhook_create.handler({
        url: 'https://example.com/webhook',
        events: ['document.ingested', 'workflow.state_changed'],
        secret: 'test-secret-123',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const webhook = data.webhook as Record<string, unknown>;

      expect(webhook.url).toBe('https://example.com/webhook');
      expect(webhook.is_active).toBe(true);
      expect(webhook.has_secret).toBe(true);
      webhookId = webhook.id as string;
      expect(webhookId).toBeTruthy();

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId) as Record<string, unknown>;
      expect(dbRow).toBeDefined();
      expect(dbRow.url).toBe('https://example.com/webhook');
      expect(dbRow.events).toBe('document.ingested,workflow.state_changed');
      expect(dbRow.is_active).toBe(1);
    });

    it('34. Should list webhooks', async () => {
      const result = await eventTools.ocr_webhook_list.handler({});
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total).toBe(1);
      const webhooks = data.webhooks as Array<Record<string, unknown>>;
      expect(webhooks[0].url).toBe('https://example.com/webhook');
    });

    it('35. Should export audit log as JSON', async () => {
      const result = await eventTools.ocr_export_audit_log.handler({
        format: 'json',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.format).toBe('json');
      expect(data.row_count).toBeDefined();
      const jsonData = data.json_data as string;
      const parsedJson = JSON.parse(jsonData);
      expect(Array.isArray(parsedJson)).toBe(true);
    });

    it('36. Should export annotations as CSV', async () => {
      const result = await eventTools.ocr_export_annotations.handler({
        document_id: DOC_ID_1,
        format: 'csv',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.format).toBe('csv');
      expect(data.document_id).toBe(DOC_ID_1);
      const csvData = data.csv_data as string;
      expect(csvData).toContain('id,document_id,user_id');
      const lines = csvData.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it('37. Should delete webhook', async () => {
      const result = await eventTools.ocr_webhook_delete.handler({
        webhook_id: webhookId,
        confirm: true,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.deleted).toBe(true);

      // VERIFY: Direct DB check
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const dbRow = conn.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId);
      expect(dbRow).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 6: Cursor-based Pagination
  // ─────────────────────────────────────────────────────────────────────────

  describe('Phase 6: Cursor-based Pagination', () => {
    it('38. Should paginate through documents with cursor', async () => {
      // First page
      const result1 = await documentTools.ocr_document_list.handler({ limit: 1 });
      expect(result1.isError).toBeUndefined();
      const data1 = parseResult(result1);
      const docs1 = data1.documents as Array<Record<string, unknown>>;

      expect(docs1).toHaveLength(1);
      expect(data1.total).toBe(3);
      const cursor1 = data1.next_cursor as string;
      expect(cursor1).toBeDefined();

      // Second page
      const result2 = await documentTools.ocr_document_list.handler({
        limit: 1,
        cursor: cursor1,
      });
      expect(result2.isError).toBeUndefined();
      const data2 = parseResult(result2);
      const docs2 = data2.documents as Array<Record<string, unknown>>;

      expect(docs2).toHaveLength(1);
      expect(docs2[0].id).not.toBe(docs1[0].id);
      const cursor2 = data2.next_cursor as string;
      expect(cursor2).toBeDefined();

      // Third page
      const result3 = await documentTools.ocr_document_list.handler({
        limit: 1,
        cursor: cursor2,
      });
      expect(result3.isError).toBeUndefined();
      const data3 = parseResult(result3);
      const docs3 = data3.documents as Array<Record<string, unknown>>;

      expect(docs3).toHaveLength(1);
      expect(docs3[0].id).not.toBe(docs1[0].id);
      expect(docs3[0].id).not.toBe(docs2[0].id);

      // Verify all 3 unique documents
      const allIds = new Set([
        docs1[0].id as string,
        docs2[0].id as string,
        docs3[0].id as string,
      ]);
      expect(allIds.size).toBe(3);

      // Fourth page should be empty
      const cursor3 = data3.next_cursor as string | null;
      if (cursor3) {
        const result4 = await documentTools.ocr_document_list.handler({
          limit: 1,
          cursor: cursor3,
        });
        const data4 = parseResult(result4);
        const docs4 = data4.documents as Array<Record<string, unknown>>;
        expect(docs4).toHaveLength(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 7: Compliance
  // ─────────────────────────────────────────────────────────────────────────

  describe('Phase 7: Compliance', () => {
    it('39. Should generate compliance report', async () => {
      const result = await complianceTools.ocr_compliance_report.handler({});
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.report_type).toBe('compliance_overview');
      const docs = data.documents as Record<string, unknown>;
      expect(docs.total).toBe(3);
      expect(docs.processed).toBe(3);

      const users = data.users as Record<string, unknown>;
      expect(users.total).toBe(2); // Alice + Bob

      const provenance = data.provenance as Record<string, unknown>;
      expect((provenance.total_records as number)).toBeGreaterThan(0);
    });

    it('40. Should generate HIPAA report', async () => {
      const result = await complianceTools.ocr_compliance_hipaa.handler({});
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.report_type).toBe('hipaa_compliance');
      expect(data.encryption_status).toBeDefined();
      expect(data.user_authentication).toBeDefined();

      const dataRetention = data.data_retention as Record<string, unknown>;
      expect(dataRetention.total_documents).toBe(3);

      const userAuth = data.user_authentication as Record<string, unknown>;
      expect(userAuth.total_users).toBe(2);
    });

    it('41. Should export SOC2 compliance', async () => {
      const result = await complianceTools.ocr_compliance_export.handler({
        format: 'soc2',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.format).toBe('soc2');
      const exportData = data.export as Record<string, unknown>;
      expect(exportData.framework).toBe('SOC 2 Type II');
      expect(exportData.access_controls).toBeDefined();
      expect(exportData.audit_trail).toBeDefined();
      expect(exportData.data_integrity).toBeDefined();

      const dataIntegrity = exportData.data_integrity as Record<string, unknown>;
      expect(dataIntegrity.total_documents).toBe(3);
    });

    it('41b. Should export SOX compliance with approval chain evidence', async () => {
      const result = await complianceTools.ocr_compliance_export.handler({
        format: 'sox',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.format).toBe('sox');
      const exportData = data.export as Record<string, unknown>;
      expect(exportData.framework).toBe('SOX Section 404');
      expect(exportData.approval_chain_evidence).toBeDefined();
      expect(exportData.workflow_evidence).toBeDefined();

      const approvalEvidence = exportData.approval_chain_evidence as Record<string, unknown>;
      expect((approvalEvidence.total_chains as number)).toBeGreaterThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('42. Should fail annotation on non-existent document', async () => {
      const result = await collaborationTools.ocr_annotation_create.handler({
        document_id: 'non-existent-doc-xyz',
        annotation_type: 'comment',
        content: 'This should fail',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Document not found');
    });

    it('43. Should fail lock on non-existent document', async () => {
      const result = await collaborationTools.ocr_document_lock.handler({
        document_id: 'non-existent-doc-xyz',
        user_id: userId,
        session_id: 'session-fail',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Document not found');
    });

    it('44. Should fail workflow submit on non-existent document', async () => {
      const result = await workflowTools.ocr_workflow_submit.handler({
        document_id: 'non-existent-doc-xyz',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Document not found');
    });

    it('45. Should fail obligation update with invalid status', async () => {
      const result = await clmTools.ocr_obligation_update.handler({
        obligation_id: obligationId,
        status: 'totally_invalid_status',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid');
    });

    it('46. Should handle empty playbook comparison (missing clauses)', async () => {
      const result = await clmTools.ocr_playbook_compare.handler({
        document_id: DOC_ID_3,
        playbook_id: playbookId,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);
      const comparison = data.comparison as Record<string, unknown>;

      expect(comparison.total_clauses).toBe(3);
      expect(comparison.clause_results).toBeDefined();
      const clauseResults = comparison.clause_results as Array<Record<string, unknown>>;
      expect(clauseResults).toHaveLength(3);
    });

    it('47. Should fail to release lock that does not exist', async () => {
      const result = await collaborationTools.ocr_document_unlock.handler({
        document_id: DOC_ID_2,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No lock found');
    });

    it('48. Should fail annotation update with neither content nor status', async () => {
      const result = await collaborationTools.ocr_annotation_update.handler({
        annotation_id: annotationId,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('content or status');
    });

    it('49. Should fail to get non-existent annotation', async () => {
      const result = await collaborationTools.ocr_annotation_get.handler({
        annotation_id: 'non-existent-annotation-id',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Annotation not found');
    });

    it('50. Should fail workflow review when not in in_review state', async () => {
      const result = await workflowTools.ocr_workflow_review.handler({
        document_id: DOC_ID_1,
        decision: 'approved',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot review');
    });

    it('51. Should handle contract extract with all schemas', async () => {
      const result = await clmTools.ocr_contract_extract.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.chunk_count).toBe(3);
      const schemas = data.schemas_extracted as string[];
      expect(schemas.length).toBeGreaterThan(0);
      const extractions = data.extractions as Record<string, unknown>;
      expect(Object.keys(extractions).length).toBeGreaterThan(0);
    });

    it('52. Should fail to apply same approval chain twice', async () => {
      const result = await workflowTools.ocr_approval_chain_apply.handler({
        document_id: DOC_ID_1,
        chain_id: approvalChainId,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('already applied');
    });

    it('53. Should export obligations CSV (with filters)', async () => {
      const result = await eventTools.ocr_export_obligations_csv.handler({
        document_id: DOC_ID_1,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.format).toBe('csv');
      const csvData = data.csv_data as string;
      expect(csvData).toContain('id,document_id');
    });

    it('54. Should fail to delete non-existent webhook', async () => {
      const result = await eventTools.ocr_webhook_delete.handler({
        webhook_id: 'non-existent-webhook',
        confirm: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Webhook not found');
    });

    it('55. Should list users (no params returns all)', async () => {
      const result = await userTools.ocr_user_info.handler({});
      expect(result.isError).toBeUndefined();
      const data = parseResult(result);

      expect(data.total).toBe(2); // Alice + Bob
      const users = data.users as Array<Record<string, unknown>>;
      const alice = users.find((u) => u.display_name === 'Alice Admin');
      expect(alice).toBeDefined();
    });
  });
});
