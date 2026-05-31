/**
 * Application stage-transition service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 29.2 (Stage transition endpoint)
 * Design  : §6 Admin (POST /api/applications/:id/stage), §15 (Audit Log)
 * Validates: Requirements 10.2, 8.1, 12.1
 *
 * Public surface:
 *   - `changeStage(opts)`            — orchestrates the full stage
 *                                      transition inside ONE transaction:
 *                                      row lock → scope check → transition
 *                                      guard → UPDATE → stage-history INSERT
 *                                      → audit write → mail stub.
 *   - `ChangeStageOptions` / `ChangeStageResult` — IO types.
 *   - Re-exported errors so the route imports from one place:
 *       - `ApplicationNotFoundError` (from `./errors.js`) — id missing OR
 *         out of the caller's Department_Head scope (no row leak).
 *       - `InvalidStageTransitionError` (from `./stage-machine.js`) — the
 *         requested transition is not allowed by the pipeline graph.
 *
 * Why everything runs inside one `withTransaction(...)`:
 *   Req 10.2 requires the stage UPDATE, the `application_stage_history`
 *   row, the audit event, and the status-change email enqueue to be a
 *   single atomic unit — either all of them happen or none do. We open
 *   one transaction and `SELECT ... FOR UPDATE` the application row so a
 *   concurrent stage change on the same card serialises (the second
 *   caller sees the first's committed stage and re-validates the
 *   transition against it). The audit + mail side-effects are issued
 *   inside the same transaction body (see the stubs below) so task 40.1
 *   / 36.1 can swap the logger calls for real INSERTs on `conn` without
 *   touching this control flow.
 *
 * Department_Head scope (Req 11.4):
 *   The route restricts this endpoint to {Super_Admin, HR} (per task
 *   29.1 — Department_Head is read-only on the kanban). We still thread
 *   `scope` through as defence in depth: when a scope is supplied we
 *   verify the application's job is visible to the caller by reading it
 *   through `jobs/repo.findById(jobId, scope)`. A `null` return collapses
 *   "job missing" and "out of scope" into the same
 *   `ApplicationNotFoundError`, so the endpoint never confirms the
 *   existence of an out-of-scope application (mirrors the
 *   `interviews-service.ts` pattern).
 *
 * `hired_at` semantics (task brief):
 *   `applications.hired_at` is the denormalised time-to-hire signal
 *   (design §7.2, Req 13.2). We stamp it to `NOW()` ONLY on a transition
 *   whose target stage is `Hired`; every other transition leaves the
 *   column untouched (it stays NULL, or — defensively — keeps a prior
 *   value). This is expressed as two distinct UPDATE statements rather
 *   than an inline `IF()` so the executed SQL is self-evident in tests.
 *
 * Audit + mail:
 *   - The audit event is written via `auditService.write(...)` (task
 *     40.1) ON the transaction connection `conn`, so the `audit_events`
 *     row commits atomically with the stage UPDATE + stage-history
 *     INSERT (Req 12.1). A structured `logger.info` line is kept
 *     alongside it so the access log remains forensically equivalent.
 *   - The `mail_outbox` table EXISTS (migration 0006, task 35.1) and the
 *     enqueue stub (`mail/service.ts`) logs intent; the real sender is
 *     task 36.1/37.1. We attempt the enqueue inside a try/catch so a
 *     mail-stub failure cannot unwind a committed stage change — the
 *     email is best-effort and a failure is logged for re-enqueue (Req
 *     8.1 + 8.3 transactional-enqueue contract).
 *
 * SQL safety (Req 15.4):
 *   Every statement uses mysql2 placeholders (`?`). Statements are
 *   pre-assembled from static fragments at module load.
 */

import {
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { findById as findJobById, type JobScope } from '../jobs/repo.js';
import * as mailService from '../mail/service.js';
import { auditService } from '../audit/writer.js';

import { ApplicationNotFoundError } from './errors.js';
import {
  assertStageTransition,
  InvalidStageTransitionError,
  type PipelineStage,
} from './stage-machine.js';

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Lock the application row for the duration of the transaction. Returns
 * the columns the transition logic needs: the current `stage`, the
 * `job_id` (for the scope check), the `applicant_user_id` and
 * `reference_no` (for the audit + mail payloads). Bound parameter: `(id)`.
 */
const SELECT_APPLICATION_FOR_UPDATE_SQL = [
  'SELECT id, job_id, applicant_user_id, reference_no, stage',
  'FROM applications WHERE id = ? FOR UPDATE',
].join(' ');

/**
 * Stage UPDATE that ALSO stamps `hired_at = NOW()`. Used only when the
 * target stage is `Hired`. Bound parameters: `(newStage, id)`.
 */
const UPDATE_STAGE_HIRED_SQL =
  'UPDATE applications SET stage = ?, hired_at = NOW() WHERE id = ?';

/**
 * Stage UPDATE that leaves `hired_at` untouched. Used for every
 * non-Hired transition. Bound parameters: `(newStage, id)`.
 */
const UPDATE_STAGE_SQL = 'UPDATE applications SET stage = ? WHERE id = ?';

/**
 * Append the stage-history audit-trail row (Req 5.7, 10.2). The
 * `application_stage_history` table (migration 0004) carries
 * `(application_id, prev_stage, new_stage, changed_by)` — there is NO
 * `reason` column, so the human-supplied reason is threaded into the
 * audit-event details / mail payload instead. Bound parameters:
 * `(applicationId, prevStage, newStage, changedBy)`.
 */
const INSERT_STAGE_HISTORY_SQL =
  'INSERT INTO application_stage_history ' +
  '  (application_id, prev_stage, new_stage, changed_by) ' +
  'VALUES (?, ?, ?, ?)';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ApplicationLockRow extends RowDataPacket {
  id: number | string;
  job_id: number | string;
  applicant_user_id: number | string;
  reference_no: string;
  stage: PipelineStage;
}

interface LockedApplication {
  readonly id: number;
  readonly jobId: number;
  readonly applicantUserId: number;
  readonly referenceNo: string;
  readonly stage: PipelineStage;
}

// ---------------------------------------------------------------------------
// Public IO
// ---------------------------------------------------------------------------

export interface ChangeStageOptions {
  /** Application primary key from the URL. */
  readonly applicationId: number;
  /** Destination pipeline stage (already validated against the enum). */
  readonly newStage: PipelineStage;
  /** Authenticated admin user id (for the audit trail). */
  readonly actorUserId: number;
  /** Department_Head scope; HR / Super_Admin pass `undefined`. */
  readonly scope?: JobScope;
  /**
   * Optional free-text reason captured from the card menu. Threaded
   * into the audit-event details + status-change email; NOT persisted
   * to `application_stage_history` (no column for it — see SQL note).
   */
  readonly reason?: string | null;
}

export interface ChangeStageResult {
  readonly applicationId: number;
  readonly prevStage: PipelineStage;
  readonly newStage: PipelineStage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToLockedApplication(row: ApplicationLockRow): LockedApplication {
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    applicantUserId: Number(row.applicant_user_id),
    referenceNo: String(row.reference_no),
    stage: row.stage,
  };
}

/**
 * Best-effort wrapper around the mail enqueue stub for the status-change
 * email (Req 8.1). The future `mail.enqueueStageChange` (task 36.1) will
 * live alongside the existing `enqueue` helper; today we probe for a
 * dedicated export and fall back to a structured log line so the access
 * log carries the same payload the real enqueue will produce.
 *
 * We deliberately do NOT call the generic transactional `enqueue(conn,
 * ...)` stub here: its signature requires a `PoolConnection` and is
 * transactional-only by design. Task 36.1 will replace this branch with
 * a real `INSERT IGNORE INTO mail_outbox` issued on the caller's
 * connection (keeping the Req 8.3 transactional-enqueue contract).
 */
async function safeEnqueueStageChange(ctx: {
  readonly applicationId: number;
  readonly applicantUserId: number;
  readonly jobId: number;
  readonly prevStage: PipelineStage;
  readonly newStage: PipelineStage;
  readonly referenceNo: string;
}): Promise<void> {
  const dedicated = (
    mailService as unknown as {
      enqueueStageChange?: (ctx: unknown) => Promise<void>;
    }
  ).enqueueStageChange;

  if (typeof dedicated === 'function') {
    await dedicated(ctx);
    return;
  }

  logger.info(
    {
      template_key: 'application-stage-change',
      target_application_id: ctx.applicationId,
      applicant_user_id: ctx.applicantUserId,
      job_id: ctx.jobId,
      prev_stage: ctx.prevStage,
      new_stage: ctx.newStage,
      reference_no: ctx.referenceNo,
      stub: true,
    },
    'mail.enqueueStageChange (stub — see task 36.1)',
  );
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Transition an application to a new pipeline stage (Req 10.2).
 *
 * Pipeline (all inside a single transaction):
 *   1. `SELECT ... FOR UPDATE` the application row. Missing →
 *      `ApplicationNotFoundError`.
 *   2. When a `scope` is supplied (Department_Head defence in depth),
 *      verify the application's job is visible via
 *      `findJobById(jobId, scope)`. A `null` return → the same
 *      `ApplicationNotFoundError` (no row leak).
 *   3. `assertStageTransition(currentStage, newStage)` — throws
 *      `InvalidStageTransitionError` on a disallowed pair (including a
 *      same-stage no-op).
 *   4. UPDATE the stage. When the target is `Hired`, the UPDATE also
 *      stamps `hired_at = NOW()`; otherwise `hired_at` is left untouched.
 *   5. INSERT the `application_stage_history` row
 *      (`prev_stage`, `new_stage`, `changed_by = actorUserId`).
 *   6. Audit event written on `conn` (audit_events INSERT, Req 12.1).
 *   7. Mail stub (best-effort enqueue; TODO task 36.1).
 *   8. COMMIT and return `{ applicationId, prevStage, newStage }`.
 */
export async function changeStage(
  opts: ChangeStageOptions,
): Promise<ChangeStageResult> {
  const { applicationId, newStage, actorUserId, scope } = opts;

  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError(applicationId);
  }
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError('changeStage: actorUserId must be a positive integer');
  }

  return withTransaction<ChangeStageResult>(async (conn: PoolConnection) => {
    // 1. Lock the application row.
    const [rows] = await conn.execute<ApplicationLockRow[]>(
      SELECT_APPLICATION_FOR_UPDATE_SQL,
      [applicationId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const application = rowToLockedApplication(row);

    // 2. Department_Head scope check (defence in depth). `findJobById`
    //    collapses out-of-scope reads to `null`, so one branch covers
    //    both "job missing" and "out of scope".
    if (scope !== undefined) {
      const job = await findJobById(application.jobId, scope);
      if (job === null) {
        throw new ApplicationNotFoundError(applicationId);
      }
    }

    const prevStage = application.stage;

    // 3. Transition guard. Throws InvalidStageTransitionError (422) on a
    //    disallowed pair or a same-stage no-op.
    assertStageTransition(prevStage, newStage);

    // 4. UPDATE the stage. Stamp hired_at only when entering Hired.
    if (newStage === 'Hired') {
      await conn.execute<ResultSetHeader>(UPDATE_STAGE_HIRED_SQL, [
        newStage,
        applicationId,
      ]);
    } else {
      await conn.execute<ResultSetHeader>(UPDATE_STAGE_SQL, [
        newStage,
        applicationId,
      ]);
    }

    // 5. Append the stage-history audit-trail row.
    await conn.execute<ResultSetHeader>(INSERT_STAGE_HISTORY_SQL, [
      applicationId,
      prevStage,
      newStage,
      actorUserId,
    ]);

    // 6. Audit event (Req 12.1). Written on `conn` so the audit_events
    //    row commits atomically with the stage UPDATE + stage-history
    //    INSERT above. We KEEP the structured log line too so the access
    //    log stays forensically equivalent for ops triage.
    await auditService.write(
      {
        actorUserId: actorUserId,
        actionType: 'application_stage_change',
        targetEntity: 'application',
        targetId: applicationId,
        details: {
          prev_stage: prevStage,
          new_stage: newStage,
          job_id: application.jobId,
          reference_no: application.referenceNo,
          reason: opts.reason ?? null,
        },
      },
      conn,
    );

    logger.info(
      {
        event: 'application_stage_change',
        actor_user_id: actorUserId,
        application_id: applicationId,
        job_id: application.jobId,
        prev_stage: prevStage,
        new_stage: newStage,
        reference_no: application.referenceNo,
        reason: opts.reason ?? null,
      },
      'application stage changed',
    );

    // 7. Mail stub. Req 8.1: a transition to a new stage other than
    //    Applied enqueues a status-change email. The current pipeline
    //    graph never targets Applied (it is only ever the START stage),
    //    so every successful transition here qualifies. We still wrap in
    //    try/catch so a mail-stub failure cannot unwind the committed
    //    domain change — the email is best-effort.
    try {
      await safeEnqueueStageChange({
        applicationId,
        applicantUserId: application.applicantUserId,
        jobId: application.jobId,
        prevStage,
        newStage,
        referenceNo: application.referenceNo,
      });
    } catch (err) {
      logger.error(
        {
          err,
          event: 'application_stage_change_mail_enqueue_failed',
          application_id: applicationId,
          new_stage: newStage,
        },
        'failed to enqueue stage-change email; stage change still applied',
      );
    }

    return { applicationId, prevStage, newStage };
  });
}

// ---------------------------------------------------------------------------
// Bulk stage transition (Req 10.5, 10.6)
// ---------------------------------------------------------------------------

/**
 * Upper bound on the number of applications a single bulk request may
 * touch. The kanban multi-select (Req 10.5) operates within ONE job
 * posting, so a realistic batch is dozens of cards, not thousands. We
 * cap the batch to bound the work performed in a single request: each
 * id runs its own transaction (see `bulkChangeStage`), so an unbounded
 * list would hold a worker for an unbounded time on shared hosting
 * (Req 1.5 — every request must finish quickly). Ids beyond the cap are
 * rejected up-front with {@link BulkStageBatchTooLargeError} so the
 * caller fixes the request rather than getting a partially-applied
 * batch.
 */
export const BULK_STAGE_MAX_BATCH = 100;

/**
 * Thrown by {@link bulkChangeStage} when the de-duplicated id list
 * exceeds {@link BULK_STAGE_MAX_BATCH}. The route layer maps this to
 * HTTP 422 (`batch_too_large`) — the request is malformed, not a
 * per-row failure, so it is rejected before ANY transition runs (no
 * partially-applied batch).
 */
export class BulkStageBatchTooLargeError extends Error {
  readonly code = 'batch_too_large' as const;
  /** HTTP status code the route layer surfaces for this error. */
  readonly statusCode = 422 as const;
  constructor(
    public readonly count: number,
    public readonly max: number = BULK_STAGE_MAX_BATCH,
  ) {
    super(
      `bulk stage batch of ${count} exceeds the maximum of ${max}`,
    );
    this.name = 'BulkStageBatchTooLargeError';
  }
}

/** Per-application outcome in a bulk stage transition. */
export interface BulkStageItemResult {
  readonly applicationId: number;
  readonly ok: boolean;
  /**
   * Machine-readable failure reason; present only when `ok === false`.
   * One of `invalid_transition`, `not_found`, or `internal_error`.
   */
  readonly error?: string;
  /** Previous stage; present only on a successful transition. */
  readonly prevStage?: PipelineStage;
  /** Destination stage; present only on a successful transition. */
  readonly newStage?: PipelineStage;
}

export interface BulkChangeStageOptions {
  /** Application primary keys to transition. De-duplicated internally. */
  readonly applicationIds: readonly number[];
  /** Destination pipeline stage (already validated against the enum). */
  readonly newStage: PipelineStage;
  /** Authenticated admin user id (for the audit trail). */
  readonly actorUserId: number;
  /** Department_Head scope; HR / Super_Admin pass `undefined`. */
  readonly scope?: JobScope;
  /** Optional free-text reason threaded into each per-application change. */
  readonly reason?: string | null;
}

export interface BulkChangeStageResult {
  readonly results: readonly BulkStageItemResult[];
}

/**
 * Apply a stage transition to many applications, one transaction PER
 * application, reporting per-row success / failure WITHOUT aborting the
 * batch (Req 10.5, 10.6).
 *
 * Contract:
 *   - The input ids are de-duplicated (a kanban multi-select can repeat
 *     a card; we transition each application at most once) preserving
 *     first-seen order.
 *   - If the de-duplicated list exceeds {@link BULK_STAGE_MAX_BATCH},
 *     we throw {@link BulkStageBatchTooLargeError} BEFORE processing any
 *     id — the whole request is rejected, nothing is applied.
 *   - For each remaining id we call the existing {@link changeStage},
 *     which wraps its own `withTransaction(...)`. We catch per-id so one
 *     failure cannot unwind or abort the others (Req 10.6):
 *       - success                       → `{ ok: true, prevStage, newStage }`
 *       - `InvalidStageTransitionError`  → `{ ok: false, error: 'invalid_transition' }`
 *       - `ApplicationNotFoundError`     → `{ ok: false, error: 'not_found' }`
 *       - anything else (logged)         → `{ ok: false, error: 'internal_error' }`
 *
 * The `results` array is returned in the same first-seen order as the
 * (de-duplicated) input so the caller can correlate rows positionally.
 */
export async function bulkChangeStage(
  opts: BulkChangeStageOptions,
): Promise<BulkChangeStageResult> {
  const { applicationIds, newStage, actorUserId, scope } = opts;
  const reason = opts.reason ?? null;

  // De-duplicate, preserving first-seen order. A repeated card in the
  // multi-select must not be transitioned twice.
  const uniqueIds: number[] = [];
  const seen = new Set<number>();
  for (const id of applicationIds) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  // Bound the work: reject an oversized batch before doing anything so
  // the request never partially applies.
  if (uniqueIds.length > BULK_STAGE_MAX_BATCH) {
    throw new BulkStageBatchTooLargeError(uniqueIds.length);
  }

  const results: BulkStageItemResult[] = [];
  for (const applicationId of uniqueIds) {
    try {
      const { prevStage } = await changeStage({
        applicationId,
        newStage,
        actorUserId,
        scope,
        reason,
      });
      results.push({ applicationId, ok: true, prevStage, newStage });
    } catch (err) {
      if (err instanceof InvalidStageTransitionError) {
        results.push({ applicationId, ok: false, error: 'invalid_transition' });
      } else if (err instanceof ApplicationNotFoundError) {
        results.push({ applicationId, ok: false, error: 'not_found' });
      } else {
        logger.error(
          {
            err,
            event: 'application_bulk_stage_item_failed',
            application_id: applicationId,
            new_stage: newStage,
          },
          'bulk stage transition: per-application failure (batch continues)',
        );
        results.push({ applicationId, ok: false, error: 'internal_error' });
      }
    }
  }

  return { results };
}

// ---------------------------------------------------------------------------
// Re-exports (so the route layer imports from one place)
// ---------------------------------------------------------------------------

export { ApplicationNotFoundError } from './errors.js';
export {
  InvalidStageTransitionError,
  PIPELINE_STAGES,
  isPipelineStage,
  type PipelineStage,
} from './stage-machine.js';
