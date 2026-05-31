/**
 * Application write-path service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 26.1, 26.2
 * Design  : §6 Applicant_Area, §15 (audit events)
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.8, 14.4
 *
 * Public surface:
 *   - `applyToJob(input)`            — orchestrates the full apply flow
 *                                      inside a single transaction.
 *   - `withdrawApplication(input)`   — transitions an applicant-owned
 *                                      application to `Withdrawn` inside
 *                                      a single transaction (Req 5.8).
 *   - `mapSourceParam(raw)`          — pure helper that maps a raw
 *                                      `?ref=` URL parameter to one of
 *                                      the canonical `ApplicationSource`
 *                                      values. Anything unrecognised
 *                                      collapses to `'unknown'`.
 *   - Error classes:
 *       - `MissingCvError`           — applicant has no `is_active=1`
 *                                      CV row (Req 5.2).
 *       - `IncompleteProfileError`   — completeness < 80 %; carries the
 *                                      `missingFields` array so the
 *                                      route can surface them (Req 5.2).
 *       - `JobUnavailableError`      — the job either does not exist,
 *                                      is not Published, or has a past
 *                                      deadline. Collapses three causes
 *                                      to a single error so the route
 *                                      never leaks job state to a
 *                                      probing client (Req 5.4).
 *       - `DuplicateApplicationError` — second apply by the same
 *                                       applicant to the same job
 *                                       (`uk_app_applicant_job` violation,
 *                                       Req 5.3).
 *
 * Why all the work happens inside one `withTransaction(...)`:
 *   The acceptance criteria (Req 5.1, 5.5) require the application row,
 *   the synthetic stage-history row, and the side-effects (audit + mail)
 *   to either ALL succeed or ALL fail. We open a single transaction so
 *   a network glitch between INSERTs cannot leave a half-built
 *   application stranded. The audit + mail TODOs (tasks 38.1 + 35.1)
 *   will hang their `INSERT INTO ...` calls inside this same
 *   transaction body when those tables ship.
 *
 * Reference number generation (`nextReferenceNo`):
 *   Format: `APP-YYYY-NNNNNN` (e.g. `APP-2026-000123`). The sequence is
 *   per calendar year. We compute the next slot by:
 *
 *     SELECT COUNT(*) + 1
 *       FROM applications
 *       WHERE reference_no LIKE 'APP-YYYY-%'
 *       FOR UPDATE
 *
 *   Race-condition mitigation (defence in depth):
 *     1. The `FOR UPDATE` clause holds a row-range lock for the
 *        duration of the transaction. Inside one MySQL session, two
 *        concurrent applies will serialise — the second sees the
 *        freshly-inserted row from the first.
 *     2. The DB schema has `UNIQUE KEY uk_app_ref (reference_no)` as
 *        the absolute backstop. If the FOR UPDATE somehow degrades
 *        (unlikely on InnoDB, but the lock is range-based and depends
 *        on the surrounding query plan), the unique constraint
 *        catches the collision as `ER_DUP_ENTRY`. The service catches
 *        that branch and retries ONCE with a freshly-recomputed slot
 *        — see `applyToJob` for the retry loop.
 *
 * Audit + mail enqueue (deferred):
 *   The task 26.1 brief explicitly defers both side-effects to later
 *   phases:
 *     - `audit_events` table lands with task 38.1; the writer service
 *       lands with task 40.1.
 *     - `mail_outbox` table lands with task 35.1; the enqueue / sender
 *       lands with task 36.1.
 *   For now we emit a structured `logger.info({ event: ... })` so the
 *   pino access log carries the same payload the audit row would. The
 *   `// TODO(...)` comments at the call sites point at the precise
 *   tasks that flip these to real DB writes.
 *
 * SQL safety:
 *   Every statement uses mysql2 placeholders (`?`). The `local
 *   /no-string-concat-sql` lint rule guards against future drift.
 *   Statements are pre-assembled at module-load time (or via
 *   `Array.join` of static fragments) so the lint rule does not flag
 *   the perfectly-safe SELECT keyword next to a constant column list.
 */

import { randomUUID } from 'node:crypto';

import {
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { computeCompleteness } from '../applicant/completeness.js';
import { findById as findJobById } from '../jobs/repo.js';

import {
  ApplicationNotFoundError,
  DuplicateApplicationError,
  IncompleteProfileError,
  JobUnavailableError,
  MissingCvError,
  WithdrawNotAllowedError,
} from './errors.js';
import {
  APPLICATION_SOURCES,
  isApplicationSource,
  type ApplicationRow,
  type ApplicationSource,
  type ApplicationStage,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold for "profile is complete enough to apply" (Req 5.1). */
export const APPLY_COMPLETENESS_THRESHOLD = 80;

/**
 * Maximum number of times the apply transaction will retry on a
 * `reference_no` ER_DUP_ENTRY collision. The FOR UPDATE lock makes a
 * collision essentially impossible inside one MySQL session, so a
 * single retry is more than enough — we keep the bound tight so a
 * persistent collision is loud rather than spinning forever.
 */
const MAX_REFERENCE_NO_RETRIES = 1;

/** mysql2 surfaces unique-key violations with this code. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `MissingCvError`, `IncompleteProfileError`, `JobUnavailableError`,
// and `DuplicateApplicationError` were defined inline in this module
// before task 26.1 introduced `./repo.ts`. They now live in
// `./errors.js` so the repo module can throw `DuplicateApplicationError`
// without forming a circular import. The classes are re-exported
// below so existing callers (`src/routes/...`, tests) keep importing
// them from `./service.js`.

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

/** Inputs for {@link applyToJob}. */
export interface ApplyToJobInput {
  /** ID of the authenticated applicant (`users.id`). */
  readonly applicantUserId: number;
  /** Target job posting id. */
  readonly jobId: number;
  /**
   * Raw `?ref=` query parameter. Mapped via the whitelist; anything
   * unrecognised becomes `'unknown'`.
   */
  readonly sourceParam?: string | null;
}

/** Successful result of {@link applyToJob}. */
export interface ApplyToJobResult {
  readonly id: number;
  readonly uuid: string;
  readonly referenceNo: string;
  readonly source: ApplicationSource;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Load the applicant's profile + active CV in a single round-trip.
 *
 * The LEFT JOIN keeps the row even when the applicant has no active
 * CV — the route then reports a `MissingCvError`. The CV row's `id`
 * comes back as NULL when the join misses; we coalesce to a sentinel
 * (NULL) and check it below.
 *
 * Selecting the profile columns AND the active CV in one query
 * minimises round-trips inside the transaction (FOR UPDATE locks are
 * held for the duration of the txn, so we want to release them as
 * early as possible).
 */
const SELECT_APPLICANT_AND_ACTIVE_CV_SQL =
  'SELECT a.user_id, a.full_name, a.date_of_birth, a.phone, ' +
  '       a.address, a.city, a.province, a.country, a.summary, ' +
  '       cv.id AS cv_id ' +
  'FROM applicants a ' +
  'LEFT JOIN applicant_cv_files cv ' +
  '       ON cv.applicant_user_id = a.user_id AND cv.is_active = 1 ' +
  'WHERE a.user_id = ? ' +
  'LIMIT 1';

/** Existence checks for "applicant has at least one education / experience". */
const COUNT_EDUCATION_SQL =
  'SELECT 1 FROM applicant_education WHERE applicant_user_id = ? LIMIT 1';
const COUNT_EXPERIENCE_SQL =
  'SELECT 1 FROM applicant_experience WHERE applicant_user_id = ? LIMIT 1';

/**
 * Reference-number sequence query. The `LIKE 'APP-YYYY-%'` predicate
 * makes the count year-scoped; the FOR UPDATE clause holds the locked
 * range for the rest of the transaction so two concurrent applies in
 * the same year will serialise on this row set.
 */
const COUNT_REFERENCE_NO_SQL =
  'SELECT COUNT(*) AS n ' +
  'FROM applications ' +
  'WHERE reference_no LIKE ? ' +
  'FOR UPDATE';

const INSERT_APPLICATION_SQL =
  'INSERT INTO applications ' +
  '  (uuid, reference_no, applicant_user_id, job_id, cv_file_id, stage, source) ' +
  "VALUES (?, ?, ?, ?, ?, 'Applied', ?)";

const INSERT_STAGE_HISTORY_SQL =
  'INSERT INTO application_stage_history ' +
  '  (application_id, prev_stage, new_stage, changed_by) ' +
  "VALUES (?, NULL, 'Applied', ?)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw `?ref=` URL parameter to the canonical `ApplicationSource`
 * value. Anything outside the whitelist (including `undefined`, the
 * empty string, mixed case, or unrecognised tokens) becomes
 * `'unknown'`.
 *
 * The match is case-insensitive on the URL value but the DB always
 * stores the lowercase canonical form.
 */
export function mapSourceParam(
  raw: string | null | undefined,
): ApplicationSource {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return 'unknown';
  return isApplicationSource(trimmed) ? trimmed : 'unknown';
}

/** True when `err` looks like a mysql2 ER_DUP_ENTRY rejection. */
function isDuplicateEntryError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === ER_DUP_ENTRY;
}

/**
 * True when the error message names the `uk_app_applicant_job` index.
 * mysql2 surfaces the index name in the error message, e.g.
 * `Duplicate entry '7-42' for key 'applications.uk_app_applicant_job'`.
 *
 * We use this to distinguish the "duplicate apply" case (Req 5.3 →
 * 409) from a `reference_no` collision (which we retry).
 */
function isDuplicateApplicantJobIndex(err: unknown): boolean {
  if (!isDuplicateEntryError(err)) return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return message.includes('uk_app_applicant_job');
}

/**
 * True when the duplicate-entry error names the `reference_no` unique
 * key. We translate this branch to a one-shot retry rather than a
 * 409.
 */
function isDuplicateReferenceNoIndex(err: unknown): boolean {
  if (!isDuplicateEntryError(err)) return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return message.includes('uk_app_ref');
}

/** Pad a non-negative integer to 6 digits with leading zeros. */
function padSixDigits(n: number): string {
  return n.toString().padStart(6, '0');
}

/**
 * Compute the next reference number for the current calendar year.
 * Caller MUST pass the transactional connection so the FOR UPDATE
 * lock binds to the same MySQL session.
 *
 * The format is `APP-YYYY-NNNNNN`. Year is the server clock's UTC
 * year — switching to a non-UTC year boundary would require a
 * settings knob; we have no such requirement and using UTC keeps the
 * sequence reproducible across hosts.
 */
export async function nextReferenceNo(
  conn: PoolConnection,
  now: Date = new Date(),
): Promise<string> {
  const year = now.getUTCFullYear();
  const prefix = `APP-${year}-`;
  const [rows] = await conn.execute<RowDataPacket[]>(COUNT_REFERENCE_NO_SQL, [
    `${prefix}%`,
  ]);
  const current = Number((rows[0] as { n?: number | string } | undefined)?.n ?? 0);
  const next = current + 1;
  return `${prefix}${padSixDigits(next)}`;
}

/**
 * Apply-time profile completeness signals. Loaded by the apply
 * transaction in a single read where possible.
 */
interface ApplicantSnapshot {
  readonly userId: number;
  readonly fullName: string | null;
  readonly dateOfBirth: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  readonly summary: string | null;
  readonly cvId: number | null;
}

interface ApplicantSnapshotRow extends RowDataPacket {
  user_id: number | string;
  full_name: string | null;
  date_of_birth: Date | string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  summary: string | null;
  cv_id: number | string | null;
}

function dateToIsoYmd(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

async function loadApplicantSnapshot(
  conn: PoolConnection,
  userId: number,
): Promise<ApplicantSnapshot | null> {
  const [rows] = await conn.execute<ApplicantSnapshotRow[]>(
    SELECT_APPLICANT_AND_ACTIVE_CV_SQL,
    [userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    userId: Number(row.user_id),
    fullName: row.full_name,
    dateOfBirth: dateToIsoYmd(row.date_of_birth),
    phone: row.phone,
    address: row.address,
    city: row.city,
    province: row.province,
    country: row.country,
    summary: row.summary,
    cvId:
      row.cv_id === null || row.cv_id === undefined ? null : Number(row.cv_id),
  };
}

async function applicantHasEducation(
  conn: PoolConnection,
  userId: number,
): Promise<boolean> {
  const [rows] = await conn.execute<RowDataPacket[]>(COUNT_EDUCATION_SQL, [
    userId,
  ]);
  return rows.length > 0;
}

async function applicantHasExperience(
  conn: PoolConnection,
  userId: number,
): Promise<boolean> {
  const [rows] = await conn.execute<RowDataPacket[]>(COUNT_EXPERIENCE_SQL, [
    userId,
  ]);
  return rows.length > 0;
}

/** Date helper: strip a Date down to a YYYY-MM-DD string for comparison. */
function todayIsoYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * True when the job is unavailable (Req 5.4). Combines the three
 * "not Published" / "no row" / "deadline past" branches.
 */
function jobIsUnavailable(
  job: { status: string; application_deadline: string | null } | null,
  todayYmd: string,
): boolean {
  if (job === null) return true;
  if (job.status !== 'Published') return true;
  if (job.application_deadline !== null && job.application_deadline < todayYmd) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Apply an authenticated applicant to a published job posting.
 *
 * Pipeline (all inside a single transaction):
 *   1. Load the applicant + active CV in one round-trip.
 *      - No row at all → `MissingCvError` (registration always inserts
 *        an `applicants` row, so a missing row indicates a structural
 *        bug; we surface it the same as "no CV" rather than a confusing
 *        500 because both block apply at the same boundary).
 *      - No active CV → `MissingCvError`.
 *   2. Load the education + experience existence flags.
 *   3. Compute completeness via the canonical helper. If < 80 %, throw
 *      `IncompleteProfileError` carrying the missing-field list.
 *   4. Load the job posting via `findJobById`. If unavailable (any of
 *      the three causes in Req 5.4) → `JobUnavailableError`.
 *   5. Generate `uuid` + `reference_no`.
 *   6. INSERT `applications` row. On `uk_app_applicant_job` collision
 *      → `DuplicateApplicationError`. On `uk_app_ref` collision →
 *      retry once with a freshly-computed sequence slot.
 *   7. INSERT the synthetic `application_stage_history` row.
 *   8. Audit + mail enqueue (TODOs — see file header).
 *   9. COMMIT and return `{ id, uuid, referenceNo, source }`.
 */
export async function applyToJob(
  input: ApplyToJobInput,
): Promise<ApplyToJobResult> {
  const { applicantUserId, jobId, sourceParam } = input;
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError('applicantUserId must be a positive integer');
  }
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new TypeError('jobId must be a positive integer');
  }

  const source = mapSourceParam(sourceParam);

  // ---------------------------------------------------------------------
  // Job lookup happens BEFORE the transaction so the FOR UPDATE lock on
  // `applications` does not need to be held across the read. The tiny
  // race window (job goes offline between this read and the INSERT)
  // collapses to a 409 via the FK constraint and a retry round-trip,
  // which the application surfaces as a generic error — but in
  // practice an admin closing a job mid-apply is rare enough that
  // accepting the read-then-write pattern is the right tradeoff.
  // ---------------------------------------------------------------------
  const job = await findJobById(jobId);
  if (jobIsUnavailable(job, todayIsoYmd())) {
    throw new JobUnavailableError(jobId);
  }

  return withTransaction<ApplyToJobResult>(async (conn) => {
    // 1 & 2. Applicant snapshot + education/experience signals.
    const snapshot = await loadApplicantSnapshot(conn, applicantUserId);
    if (snapshot === null || snapshot.cvId === null) {
      throw new MissingCvError();
    }

    const [hasEdu, hasExp] = await Promise.all([
      applicantHasEducation(conn, applicantUserId),
      applicantHasExperience(conn, applicantUserId),
    ]);

    // 3. Completeness gate.
    const { percentage, missingFields } = computeCompleteness({
      full_name: snapshot.fullName,
      date_of_birth: snapshot.dateOfBirth,
      phone: snapshot.phone,
      address: snapshot.address,
      city: snapshot.city,
      province: snapshot.province,
      country: snapshot.country,
      summary: snapshot.summary,
      hasEducation: hasEdu,
      hasExperience: hasExp,
      hasActiveCv: snapshot.cvId !== null,
    });
    if (percentage < APPLY_COMPLETENESS_THRESHOLD) {
      throw new IncompleteProfileError(percentage, missingFields);
    }

    // 4 & 5. Reference-number generation, INSERT, retry on unique
    // collision. The retry budget is tiny (1) because the FOR UPDATE
    // lock on the year-prefixed range makes a real collision only
    // possible across distinct MySQL sessions.
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_REFERENCE_NO_RETRIES; attempt += 1) {
      const uuid = randomUUID();
      const referenceNo = await nextReferenceNo(conn);

      try {
        const [insertResult] = await conn.execute<ResultSetHeader>(
          INSERT_APPLICATION_SQL,
          [uuid, referenceNo, applicantUserId, jobId, snapshot.cvId, source],
        );
        const applicationId = Number(insertResult.insertId);

        // 7. Synthetic stage history row (`prev_stage=NULL,
        // new_stage='Applied'`). The applicant is the actor for the
        // create event so the timeline reads naturally.
        await conn.execute<ResultSetHeader>(INSERT_STAGE_HISTORY_SQL, [
          applicationId,
          applicantUserId,
        ]);

        // 8. Audit + mail enqueue side-effects.
        // TODO(task 40.1): replace this log with an audit_events INSERT
        //   action_type='application_submitted', actor=applicantUserId,
        //   target_entity='Application', target_id=applicationId,
        //   details={ jobId, source, referenceNo }.
        // TODO(task 36.1): enqueue mail_outbox row with template
        //   `application-confirm`, target=applicantUserId,
        //   payload={ jobTitle, referenceNo, applicationId }.
        logger.info(
          {
            event: 'application_submitted',
            application_id: applicationId,
            applicant_user_id: applicantUserId,
            job_id: jobId,
            reference_no: referenceNo,
            source,
          },
          'application created',
        );

        return {
          id: applicationId,
          uuid,
          referenceNo,
          source,
        };
      } catch (err) {
        // 6a. Duplicate (applicant_user_id, job_id) — Req 5.3, 409.
        if (isDuplicateApplicantJobIndex(err)) {
          throw new DuplicateApplicationError(applicantUserId, jobId);
        }

        // 6b. Duplicate reference_no — exceedingly rare, retry once.
        if (isDuplicateReferenceNoIndex(err)) {
          lastError = err;
          continue;
        }

        // Any other error: bubble out of the transaction.
        throw err;
      }
    }

    // The retry loop exited without returning — the reference number
    // generator hit an unrecoverable conflict. Bubble up a generic
    // error rather than a misleading domain error so the caller
    // sees the actual failure cause.
    if (lastError !== null) throw lastError;
    throw new Error('applyToJob: exhausted reference-number retries');
  });
}

// ---------------------------------------------------------------------------
// Withdraw (task 26.2 — Req 5.8)
// ---------------------------------------------------------------------------

/**
 * Stages from which an application can no longer be withdrawn.
 *
 * Req 5.8 forbids withdrawing from `Hired` or `Rejected` ("an
 * Application whose stage is not Hired or Rejected"). We also add
 * `Withdrawn` so a second withdraw click is rejected with the same
 * 409 rather than inserting a redundant stage-history row — the
 * idempotency guard the route relies on.
 */
const WITHDRAW_TERMINAL_STAGES: ReadonlySet<ApplicationStage> = new Set([
  'Hired',
  'Rejected',
  'Withdrawn',
]);

/**
 * SELECT the application FOR UPDATE, scoped to the owning applicant.
 * The `applicant_user_id = ?` predicate is what makes the read
 * applicant-scoped: another applicant's row (or a non-existent id)
 * returns zero rows and collapses to `ApplicationNotFoundError`, so
 * the service never confirms the existence of someone else's
 * application (Req 5.8 / no row leak).
 *
 * `FOR UPDATE` holds a row lock for the rest of the transaction so a
 * concurrent stage transition (HR moving the application to Hired,
 * say) cannot race the withdraw between this read and the UPDATE.
 */
const SELECT_FOR_WITHDRAW_SQL =
  'SELECT id, stage ' +
  'FROM applications ' +
  'WHERE id = ? AND applicant_user_id = ? ' +
  'LIMIT 1 ' +
  'FOR UPDATE';

/**
 * Transition the row to `Withdrawn`. Per migration `0004` there is NO
 * `withdrawn_at` column on `applications` — the withdraw timestamp is
 * captured by the `application_stage_history` row whose
 * `new_stage='Withdrawn'`. We only flip `stage`; `updated_at` is
 * maintained by the `ON UPDATE CURRENT_TIMESTAMP` clause in the DDL.
 */
const UPDATE_STAGE_WITHDRAWN_SQL =
  "UPDATE applications SET stage = 'Withdrawn' WHERE id = ?";

/**
 * Record the transition in the audit timeline. `prev_stage` carries
 * the stage we read under the FOR UPDATE lock; `changed_by` is the
 * acting applicant.
 */
const INSERT_WITHDRAW_HISTORY_SQL =
  'INSERT INTO application_stage_history ' +
  '  (application_id, prev_stage, new_stage, changed_by) ' +
  "VALUES (?, ?, 'Withdrawn', ?)";

/** Loose row shape for the FOR UPDATE select. */
interface WithdrawRow extends RowDataPacket {
  id: number | string;
  stage: ApplicationStage;
}

/** Inputs for {@link withdrawApplication}. */
export interface WithdrawApplicationInput {
  /** ID of the authenticated applicant (`users.id` / `applicants.user_id`). */
  readonly applicantUserId: number;
  /** Target application id (from the URL). */
  readonly applicationId: number;
}

/**
 * Withdraw an application on behalf of its owning applicant (Req 5.8).
 *
 * Pipeline (all inside a single transaction):
 *   1. SELECT the application `FOR UPDATE`, scoped to
 *      `applicant_user_id = ?`. No row → `ApplicationNotFoundError`
 *      (covers both "unknown id" and "belongs to another applicant").
 *   2. If the current stage is terminal ({Hired, Rejected, Withdrawn})
 *      → `WithdrawNotAllowedError`.
 *   3. UPDATE the row to `stage='Withdrawn'` (no `withdrawn_at` column
 *      exists — the timestamp lives on the stage-history row).
 *   4. INSERT an `application_stage_history` row recording the
 *      `prev_stage → Withdrawn` transition with `changed_by` = the
 *      acting applicant.
 *   5. Emit a structured audit log line (audit table write deferred to
 *      task 40.1).
 *
 * Resolves with `void` on success — the route reloads / redirects to
 * the detail page rather than consuming a return value.
 */
export async function withdrawApplication(
  input: WithdrawApplicationInput,
): Promise<void> {
  const { applicantUserId, applicationId } = input;
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError('applicantUserId must be a positive integer');
  }
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new TypeError('applicationId must be a positive integer');
  }

  await withTransaction<void>(async (conn) => {
    // 1. Owner-scoped lock-read. A missing row collapses both the
    //    "unknown id" and "not yours" cases to the same not-found.
    const [rows] = await conn.execute<WithdrawRow[]>(SELECT_FOR_WITHDRAW_SQL, [
      applicationId,
      applicantUserId,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new ApplicationNotFoundError(applicationId);
    }

    const prevStage = row.stage;

    // 2. Terminal-stage guard (Req 5.8 + idempotency on Withdrawn).
    if (WITHDRAW_TERMINAL_STAGES.has(prevStage)) {
      throw new WithdrawNotAllowedError(applicationId, prevStage);
    }

    // 3. Transition the row.
    await conn.execute<ResultSetHeader>(UPDATE_STAGE_WITHDRAWN_SQL, [
      applicationId,
    ]);

    // 4. Audit timeline row (prev_stage → Withdrawn, actor = applicant).
    await conn.execute<ResultSetHeader>(INSERT_WITHDRAW_HISTORY_SQL, [
      applicationId,
      prevStage,
      applicantUserId,
    ]);

    // 5. Audit-stub.
    // TODO(task 40.1): replace with auditService.write — action_type
    //   'application_withdrawn', actor=applicantUserId,
    //   target_entity='Application', target_id=applicationId,
    //   details={ prevStage }.
    logger.info(
      {
        event: 'application_withdrawn',
        actor_user_id: applicantUserId,
        application_id: applicationId,
        prev_stage: prevStage,
      },
      'application withdrawn',
    );
  });
}

// ---------------------------------------------------------------------------
// Re-exports (so the route layer only has to import from one place)
// ---------------------------------------------------------------------------

export type { ApplicationRow, ApplicationSource };
export { APPLICATION_SOURCES };
export {
  ApplicationNotFoundError,
  DuplicateApplicationError,
  IncompleteProfileError,
  JobUnavailableError,
  MissingCvError,
  WithdrawNotAllowedError,
};
