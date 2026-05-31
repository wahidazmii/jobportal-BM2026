/**
 * Application repository for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 26.1
 * Design  : §6 Applicant_Area, §7.2 (DDL ground truth)
 * Validates: Requirements 5.1, 5.3, 5.5
 *
 * Public surface:
 *   - `ApplicationRow`              — re-exported from `./types.ts` so
 *                                     callers can `import { ApplicationRow }
 *                                     from '../applications/repo.js'`
 *                                     without crossing module boundaries.
 *   - `findByApplicantAndJob`       — duplicate-check helper used by
 *                                     the apply path (Req 5.3) and by
 *                                     diagnostic / admin tools.
 *   - `findById`                    — load a single row by primary key.
 *                                     Accepts an OPTIONAL Department_Head
 *                                     `scope`: when `scope.departments`
 *                                     is a non-empty array the read JOINs
 *                                     `job_postings` and adds
 *                                     `WHERE jp.department_id IN (?, …)`,
 *                                     collapsing an out-of-scope row to
 *                                     `null` (Req 11.4 / Design §14.2). An
 *                                     EMPTY array short-circuits to `null`
 *                                     without touching the DB. No scope
 *                                     (`undefined`) = HR / Super_Admin
 *                                     path, every row visible.
 *   - `insertApplication`           — wrapper around the transactional
 *                                     INSERT pipeline. Generates the
 *                                     `uuid` + `reference_no`, INSERTs
 *                                     the row at stage `'Applied'`,
 *                                     records the synthetic
 *                                     `application_stage_history` row,
 *                                     and re-throws
 *                                     `DuplicateApplicationError` on
 *                                     `uk_app_applicant_job` collisions.
 *
 * Why the apply orchestration lives in `service.ts` rather than here:
 *   The `applyToJob` flow (in `./service.ts`) needs to load the
 *   applicant snapshot + job posting + completeness signals before it
 *   can know whether an INSERT is even legal. Splitting that work
 *   into the repo would force the service to re-open the transaction
 *   twice or the repo to grow into a service. We keep the repo lean
 *   (row-shaped reads + the canonical INSERT helper) so it can be
 *   reused by future write paths (admin "create application on
 *   behalf of applicant", import flows) without dragging the
 *   completeness gate into them.
 *
 * `reference_no` generation strategy:
 *   Format: `APP-YYYY-NNNNNN`. The sequence is per calendar year. The
 *   helper computes the next slot via:
 *
 *     SELECT COUNT(*) + 1
 *       FROM applications
 *       WHERE reference_no LIKE 'APP-YYYY-%'
 *       FOR UPDATE
 *
 *   The `FOR UPDATE` clause holds a row-range lock for the duration
 *   of the transaction, so two concurrent inserts in the same year
 *   serialise — the second sees the first's row before it commits.
 *   The DB also carries `UNIQUE KEY uk_app_ref (reference_no)` as the
 *   absolute backstop. On collision (extremely rare in practice) we
 *   retry once with a freshly-recomputed slot before giving up.
 *
 * SQL safety (Req 15.4):
 *   - Every statement uses mysql2 placeholders (`?`). The local lint
 *     rule `local/no-string-concat-sql` enforces this at the file
 *     level.
 */

import { randomUUID } from 'node:crypto';

import {
  query,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';

import { DuplicateApplicationError } from './errors.js';
import type {
  ApplicationRow,
  ApplicationSource,
  ApplicationStage,
} from './types.js';
// Type-only import: `JobScope` is erased at compile time, so this does
// NOT create a runtime cycle with `../jobs/repo.js` (which never imports
// this module). Re-using the canonical `JobScope` keeps the
// Department_Head scoping contract identical across the jobs and
// applications repositories (Design §14.2 / Req 11.4).
import type { JobScope } from '../jobs/repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** mysql2 surfaces unique-key violations with this code. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/**
 * Maximum number of times {@link insertApplication} retries on a
 * `uk_app_ref` collision. The FOR UPDATE lock makes a real collision
 * essentially impossible inside one MySQL session, so a single retry
 * is more than enough. We keep the bound tight so a persistent
 * collision is loud rather than silently spinning.
 */
const MAX_REFERENCE_NO_RETRIES = 1;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `DuplicateApplicationError` lives in `./errors.js` so both this
// module (which detects the SQL collision) and `./service.ts` (which
// orchestrates the apply flow) can import it without forming a
// circular module dependency. We re-export it below for callers that
// only want one import path.

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * Column projection shared by every read path so the row → JS-record
 * mapping is consistent. Mirrors `0004_applications.sql` verbatim.
 */
const APPLICATION_COLUMNS =
  'id, uuid, reference_no, applicant_user_id, job_id, cv_file_id, ' +
  'stage, source, applied_at, updated_at, hired_at';

const SELECT_BY_ID_SQL = [
  'SELECT',
  APPLICATION_COLUMNS,
  'FROM applications WHERE id = ? LIMIT 1',
].join(' ');

/**
 * Department-scoped single-row read (Req 11.4 / Design §14.2).
 *
 * Projects every `applications` column (aliased `a.`) and JOINs
 * `job_postings jp` so the `jp.department_id IN (?, …)` predicate can
 * gate the row by the owning job's department. The `IN (...)`
 * placeholder list is assembled at call time from
 * `scope.departments.length` slots — every bound value is a department
 * id, never inlined into the SQL text (the `local/no-string-concat-sql`
 * lint rule guards this).
 *
 * Built with `Array.join(' ')` so the rule never sees a SQL keyword
 * adjacent to the dynamic (placeholder-only) IN clause.
 */
const APPLICATION_COLUMNS_PREFIXED =
  'a.id, a.uuid, a.reference_no, a.applicant_user_id, a.job_id, ' +
  'a.cv_file_id, a.stage, a.source, a.applied_at, a.updated_at, a.hired_at';

function buildSelectByIdScopedSql(deptCount: number): string {
  return [
    'SELECT',
    APPLICATION_COLUMNS_PREFIXED,
    'FROM applications a',
    'INNER JOIN job_postings jp ON jp.id = a.job_id',
    'WHERE a.id = ?',
    'AND jp.department_id IN (' + buildPlaceholders(deptCount) + ')',
    'LIMIT 1',
  ].join(' ');
}

const SELECT_BY_APPLICANT_AND_JOB_SQL = [
  'SELECT',
  APPLICATION_COLUMNS,
  'FROM applications',
  'WHERE applicant_user_id = ? AND job_id = ?',
  'LIMIT 1',
].join(' ');

/**
 * Reference-number sequence query. The `LIKE 'APP-YYYY-%'` predicate
 * makes the count year-scoped; the `FOR UPDATE` clause holds the
 * locked range for the rest of the transaction so two concurrent
 * applies in the same year will serialise on this row set.
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
// Row mapping
// ---------------------------------------------------------------------------

/** Loose row shape returned by mysql2 for a SELECT against `applications`. */
interface AppRow extends RowDataPacket {
  id: number | string;
  uuid: string;
  reference_no: string;
  applicant_user_id: number | string;
  job_id: number | string;
  cv_file_id: number | string;
  stage: ApplicationStage;
  source: ApplicationSource;
  applied_at: Date | string;
  updated_at: Date | string;
  hired_at: Date | string | null;
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date(0) : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

function rowToApplication(row: AppRow): ApplicationRow {
  return {
    id: Number(row.id),
    uuid: row.uuid,
    reference_no: row.reference_no,
    applicant_user_id: Number(row.applicant_user_id),
    job_id: Number(row.job_id),
    cv_file_id: Number(row.cv_file_id),
    stage: row.stage,
    source: row.source,
    applied_at: toDate(row.applied_at),
    updated_at: toDate(row.updated_at),
    hired_at: toDateOrNull(row.hired_at),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when `err` looks like a mysql2 ER_DUP_ENTRY rejection. */
function isDuplicateEntryError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === ER_DUP_ENTRY;
}

/**
 * True when the duplicate-entry error message names the
 * `uk_app_applicant_job` index. mysql2 surfaces the index name in the
 * error message, e.g.
 * `Duplicate entry '7-42' for key 'applications.uk_app_applicant_job'`.
 */
function isDuplicateApplicantJobIndex(err: unknown): boolean {
  if (!isDuplicateEntryError(err)) return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return message.includes('uk_app_applicant_job');
}

/**
 * True when the duplicate-entry error names the `uk_app_ref` (i.e.
 * `reference_no`) unique key. The caller retries this branch with a
 * freshly-recomputed sequence slot rather than surfacing it as a 409.
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
 * Build a `?, ?, …` placeholder list of `n` slots for an `IN (...)`
 * clause. Emits `?` characters only — never user input — so the
 * assembled SQL stays a prepared statement. Returns the empty string
 * when `n <= 0` so callers can short-circuit before issuing a query.
 */
function buildPlaceholders(n: number): string {
  if (n <= 0) return '';
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Compute the next reference number for the current calendar year.
 * Caller MUST pass the transactional connection so the FOR UPDATE
 * lock binds to the same MySQL session.
 *
 * The format is `APP-YYYY-NNNNNN`. The year is derived from the
 * caller-supplied `now` argument (defaults to `new Date()`). Using
 * UTC keeps the sequence reproducible across hosts.
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

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/**
 * Load a single application by primary key. Returns `null` when the
 * row is missing.
 *
 * Department_Head scoping (Req 11.4 / Design §14.2):
 *   - `scope` omitted / `scope.departments === undefined` → HR /
 *     Super_Admin path. No department clause; every row is visible.
 *   - `scope.departments` is a non-empty array → the read JOINs
 *     `job_postings` and applies `jp.department_id IN (?, …)`. A row
 *     whose owning job sits outside the assigned departments collapses
 *     to `null` — identical shape to "row missing" so the caller never
 *     confirms the existence of an out-of-scope application.
 *   - `scope.departments` is an EMPTY array → "Department_Head with no
 *     assignments". By definition no rows are visible, so we return
 *     `null` WITHOUT issuing a query.
 *
 * The scoped path enforces the department gate DIRECTLY at the
 * repository layer (defence in depth). The admin application read
 * paths also enforce it transitively via `findJobById(job_id, scope)`
 * in the service layer; both gates collapse to the same not-found
 * shape.
 */
export async function findById(
  id: number,
  scope?: JobScope,
): Promise<ApplicationRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;

  // Department_Head scoping.
  if (scope?.departments !== undefined) {
    const depts = scope.departments;
    // Empty assignment set → no rows visible; short-circuit.
    if (depts.length === 0) return null;
    const rows = await query<AppRow[]>(buildSelectByIdScopedSql(depts.length), [
      id,
      ...depts,
    ]);
    const row = rows[0];
    return row ? rowToApplication(row) : null;
  }

  // No scope (HR / Super_Admin) — trivial PK lookup.
  const rows = await query<AppRow[]>(SELECT_BY_ID_SQL, [id]);
  const row = rows[0];
  return row ? rowToApplication(row) : null;
}

/**
 * Look up the (applicant, job) pair. Used by the apply path as a
 * pre-flight duplicate check (the `uk_app_applicant_job` index
 * catches the race condition; this read short-circuits the common
 * case so the route can return the existing reference number on a
 * second click).
 */
export async function findByApplicantAndJob(
  applicantUserId: number,
  jobId: number,
): Promise<ApplicationRow | null> {
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) return null;
  if (!Number.isInteger(jobId) || jobId <= 0) return null;
  const rows = await query<AppRow[]>(SELECT_BY_APPLICANT_AND_JOB_SQL, [
    applicantUserId,
    jobId,
  ]);
  const row = rows[0];
  return row ? rowToApplication(row) : null;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/** Inputs accepted by {@link insertApplication}. */
export interface InsertApplicationInput {
  readonly applicantUserId: number;
  readonly jobId: number;
  readonly cvFileId: number;
  readonly source: ApplicationSource;
  /** Optional override for the year-prefix calculation (test seam). */
  readonly now?: Date;
}

/**
 * INSERT a new application row (stage `'Applied'`, with the synthetic
 * `application_stage_history` row) inside a single transaction.
 *
 * Pipeline:
 *   1. Generate `uuid` via `crypto.randomUUID()`.
 *   2. Compute `reference_no` via {@link nextReferenceNo} (FOR UPDATE
 *      lock on the year-scoped range).
 *   3. INSERT the application row.
 *   4. INSERT the synthetic stage-history row
 *      (`prev_stage=NULL, new_stage='Applied', changed_by=applicantUserId`).
 *   5. Re-load the row via the same connection so the caller sees the
 *      server-set `applied_at` / `updated_at` timestamps.
 *
 * Error mapping:
 *   - `uk_app_applicant_job` violation → {@link DuplicateApplicationError}
 *     (Req 5.3). The route layer maps this to HTTP 409.
 *   - `uk_app_ref` violation → silently retry with a recomputed slot
 *     (up to {@link MAX_REFERENCE_NO_RETRIES}).
 *   - Anything else propagates so `withTransaction` rolls back.
 */
export async function insertApplication(
  input: InsertApplicationInput,
): Promise<ApplicationRow> {
  const { applicantUserId, jobId, cvFileId, source } = input;
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError('insertApplication: applicantUserId must be positive');
  }
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new TypeError('insertApplication: jobId must be positive');
  }
  if (!Number.isInteger(cvFileId) || cvFileId <= 0) {
    throw new TypeError('insertApplication: cvFileId must be positive');
  }

  return withTransaction<ApplicationRow>(async (conn) => {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_REFERENCE_NO_RETRIES; attempt += 1) {
      const uuid = randomUUID();
      const referenceNo = await nextReferenceNo(conn, input.now);

      try {
        const [insertResult] = await conn.execute<ResultSetHeader>(
          INSERT_APPLICATION_SQL,
          [uuid, referenceNo, applicantUserId, jobId, cvFileId, source],
        );
        const applicationId = Number(insertResult.insertId);

        // Synthetic stage-history row. Per migration 0004, the actor
        // for the create event is the applicant — the timeline reads
        // naturally that way.
        await conn.execute<ResultSetHeader>(INSERT_STAGE_HISTORY_SQL, [
          applicationId,
          applicantUserId,
        ]);

        // Reload via the same connection so the caller sees the
        // server-stamped timestamps.
        const [rows] = await conn.execute<AppRow[]>(SELECT_BY_ID_SQL, [
          applicationId,
        ]);
        const row = rows[0];
        if (row === undefined) {
          // Should be unreachable inside the transaction we just
          // INSERTed in, but be loud rather than return a synthesised
          // row.
          throw new Error(
            `insertApplication: row ${applicationId} disappeared mid-transaction`,
          );
        }
        return rowToApplication(row);
      } catch (err) {
        if (isDuplicateApplicantJobIndex(err)) {
          throw new DuplicateApplicationError(applicantUserId, jobId);
        }
        if (isDuplicateReferenceNoIndex(err)) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    if (lastError !== null) throw lastError;
    throw new Error('insertApplication: exhausted reference-number retries');
  });
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ApplicationRow, ApplicationSource, ApplicationStage };
export type { JobScope };
export { DuplicateApplicationError };
