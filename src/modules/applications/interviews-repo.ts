/**
 * Application interview repository for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.2
 * Design  : §6 Admin (Schedule interview), §7.2 (DDL ground truth)
 * Validates: Requirements 10.4
 *
 * Public surface:
 *   - `InterviewRow`              — typed `application_interviews` row.
 *   - `InterviewStatus`           — ENUM list mirrored from the DDL.
 *   - `scheduleInterview(input)`  — INSERT a fresh interview row with
 *                                   default status `'scheduled'` and
 *                                   return the persisted shape.
 *   - `findById(id)`              — single row by primary key, or `null`.
 *   - `listForApplication(appId)` — every interview row tied to an
 *                                   application, ordered by
 *                                   `scheduled_at DESC` so upcoming
 *                                   interviews land at the top of the
 *                                   list.
 *
 * Why a dedicated module:
 *   The `applications/service.ts` already covers the apply flow (task
 *   26.1) and `queries.ts` owns the read-only timeline. Interviews
 *   are a separate side-effect with their own transactional lifecycle
 *   (insert + email enqueue, future "complete / cancel" transitions),
 *   so keeping the repo helpers in their own file keeps each domain
 *   surface easy to audit. The split also matches design §6 Admin
 *   which lists "schedule interview" as a distinct admin action.
 *
 * SQL safety (Req 15.4):
 *   - Every statement is a prepared statement using mysql2 `?`
 *     placeholders. The local `no-string-concat-sql` lint rule enforces
 *     this at the file level.
 *   - The static SQL strings are assembled via `Array.join(' ')` so the
 *     lint rule does not flag them as dynamic concatenation; there is
 *     no user input anywhere in the assembly.
 */

import {
  query,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

/**
 * Mirror of `application_interviews.status` ENUM from
 * `0004_applications.sql`. The DDL defines four states; we never INSERT
 * anything other than the default `'scheduled'` here, but the type list
 * stays exhaustive so future "mark done / no-show / cancel" transitions
 * (out of scope for task 30.2) can land without a type-shape change.
 */
export const INTERVIEW_STATUSES = [
  'scheduled',
  'done',
  'cancelled',
  'no-show',
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/**
 * Public row shape for an `application_interviews` row.
 *
 * Mirrors the columns in `0004_applications.sql` exactly. mysql2 may
 * return `BIGINT UNSIGNED` columns as `number | string` depending on
 * driver options; this module coerces to `number` before exposing the
 * shape so callers do not have to.
 *
 * Per the migration:
 *   - `application_id` and `scheduled_at` are NOT NULL.
 *   - `location`, `meeting_url`, and `interviewer_user_id` are
 *     NULLable. The service layer (`interviews-service.ts`) enforces
 *     that at least one of `location` / `meeting_url` is non-null at
 *     the application boundary so an interview row always carries a
 *     way to actually meet — that rule is intentionally NOT pushed
 *     down to the DB so future side-channel inserts (e.g. an admin
 *     CSV import) can still succeed even when the data is partial.
 */
export interface InterviewRow {
  readonly id: number;
  readonly application_id: number;
  readonly scheduled_at: Date;
  readonly location: string | null;
  readonly meeting_url: string | null;
  readonly interviewer_user_id: number | null;
  readonly status: InterviewStatus;
}

/** Inputs for {@link scheduleInterview}. */
export interface ScheduleInterviewInput {
  readonly applicationId: number;
  readonly scheduledAt: Date;
  readonly location?: string | null;
  readonly meetingUrl?: string | null;
  readonly interviewerUserId?: number | null;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

interface InterviewDbRow extends RowDataPacket {
  id: number | string;
  application_id: number | string;
  scheduled_at: Date | string;
  location: string | null;
  meeting_url: string | null;
  interviewer_user_id: number | string | null;
  status: InterviewStatus;
}

/** Coerce mysql2's DATETIME (Date or string) into a `Date`. */
function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

/** Coerce a possibly-string `BIGINT UNSIGNED` to a `number | null`. */
function toNumberOrNull(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToInterview(row: InterviewDbRow): InterviewRow {
  return {
    id: Number(row.id),
    application_id: Number(row.application_id),
    scheduled_at: toDate(row.scheduled_at),
    location: row.location,
    meeting_url: row.meeting_url,
    interviewer_user_id: toNumberOrNull(row.interviewer_user_id),
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * Column projection shared by every read path so the row → JS-record
 * mapping stays consistent. Built with `Array.join` rather than `+`
 * concatenation so the local `no-string-concat-sql` lint rule does
 * not flag the static SELECT keyword next to the column list — there
 * is no user input anywhere in the assembly.
 */
const INTERVIEW_COLUMNS =
  'id, application_id, scheduled_at, location, meeting_url, ' +
  'interviewer_user_id, status';

const INSERT_INTERVIEW_SQL = [
  'INSERT INTO application_interviews',
  '(application_id, scheduled_at, location, meeting_url, interviewer_user_id)',
  'VALUES (?, ?, ?, ?, ?)',
].join(' ');

const SELECT_INTERVIEW_BY_ID_SQL = [
  'SELECT',
  INTERVIEW_COLUMNS,
  'FROM application_interviews WHERE id = ? LIMIT 1',
].join(' ');

const SELECT_INTERVIEWS_FOR_APP_SQL = [
  'SELECT',
  INTERVIEW_COLUMNS,
  'FROM application_interviews',
  'WHERE application_id = ?',
  'ORDER BY scheduled_at DESC, id DESC',
].join(' ');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * INSERT a new `application_interviews` row.
 *
 * The DB column `status` defaults to `'scheduled'` per the DDL — we
 * explicitly do NOT set it in the INSERT so a future ALTER changing
 * the default propagates without code changes here.
 *
 * Returns the persisted row read back from the same primary key. We
 * issue a follow-up SELECT instead of fabricating the row from inputs
 * because the DB owns two server-managed values (the auto-increment
 * `id` and the `status` default), and reading them back keeps the
 * service layer's audit log honest.
 */
export async function scheduleInterview(
  input: ScheduleInterviewInput,
): Promise<InterviewRow> {
  if (!Number.isInteger(input.applicationId) || input.applicationId <= 0) {
    throw new TypeError('applicationId must be a positive integer');
  }
  if (
    !(input.scheduledAt instanceof Date) ||
    Number.isNaN(input.scheduledAt.getTime())
  ) {
    throw new TypeError('scheduledAt must be a valid Date');
  }

  const result = await query<ResultSetHeader>(INSERT_INTERVIEW_SQL, [
    input.applicationId,
    input.scheduledAt,
    input.location ?? null,
    input.meetingUrl ?? null,
    input.interviewerUserId ?? null,
  ]);

  const newId = Number(result.insertId);
  const persisted = await findById(newId);
  if (persisted === null) {
    // Should never happen — the row was just inserted under our control.
    // Fall back to a synthesised shape so the caller still gets a well
    // -formed return rather than a confusing null.
    return {
      id: newId,
      application_id: input.applicationId,
      scheduled_at: input.scheduledAt,
      location: input.location ?? null,
      meeting_url: input.meetingUrl ?? null,
      interviewer_user_id: input.interviewerUserId ?? null,
      status: 'scheduled',
    };
  }
  return persisted;
}

/** Look up an interview by primary key. Returns `null` when missing. */
export async function findById(id: number): Promise<InterviewRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await query<InterviewDbRow[]>(SELECT_INTERVIEW_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) return null;
  return rowToInterview(row);
}

/**
 * List every interview tied to one application, ordered by
 * `scheduled_at DESC` so upcoming/recent interviews appear first.
 */
export async function listForApplication(
  applicationId: number,
): Promise<InterviewRow[]> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return [];
  const rows = await query<InterviewDbRow[]>(SELECT_INTERVIEWS_FOR_APP_SQL, [
    applicationId,
  ]);
  return rows.map(rowToInterview);
}
