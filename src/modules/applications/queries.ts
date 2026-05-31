/**
 * Application read-only queries for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 27.1
 * Design  : §6 Applicant_Area
 * Validates: Requirements 5.6, 5.7
 *
 * Scope:
 *   This module is intentionally **read-only**. It powers the two
 *   Applicant_Area endpoints:
 *     - `GET /:locale/me/applications`         (list, Req 5.6)
 *     - `GET /:locale/me/applications/:id`     (detail + timeline, Req 5.7)
 *
 *   The corresponding write paths (apply, withdraw, stage transitions)
 *   live in a future `service.ts` next to this file (tasks 26.x and
 *   29.x). Splitting the read and write surfaces keeps the
 *   applicant-facing queries easy to audit for IDOR / row leakage
 *   without dragging in the transactional write code.
 *
 * Authorization model:
 *   Every public function accepts `applicantUserId: number` from the
 *   authenticated session and ALWAYS scopes the SQL `WHERE` clause to
 *   that id. We never accept the applicant id from the URL or query
 *   string, and `findOneForApplicant` returns `null` when the
 *   application id exists but belongs to a different applicant — same
 *   shape as "id is unknown" so the API never confirms the existence of
 *   another user's row. This mirrors the
 *   `EducationNotFoundError`/`ExperienceNotFoundError` collapse in the
 *   profile services and supports Req 11.5 / Req 15.x in spirit.
 *
 * Locale handling:
 *   The job posting title comes from `job_posting_translations`. The
 *   route passes the URL locale (`id` | `en`) to the query layer; we
 *   prefer that locale's translation and fall back to the OTHER locale
 *   when the requested one is missing. The fallback is implemented in
 *   SQL via a `COALESCE` over two `LEFT JOIN`s so the read still happens
 *   in a single round-trip.
 *
 * Note on internal-only data:
 *   `findOneForApplicant` deliberately filters
 *   `application_notes.visible_to_applicant = 1`. Internal-only HR
 *   notes never leave this query layer, so the route / view never
 *   has to remember to redact them (Req 5.7 calls out the
 *   "visible to the Applicant" qualifier explicitly).
 */

import {
  query,
  type RowDataPacket,
} from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Locale segments accepted by the localised translation lookup. */
export type SupportedLocale = 'id' | 'en';

/** Pipeline stage values mirroring the DDL ENUM in 0004_applications.sql. */
export type ApplicationStage =
  | 'Applied'
  | 'Screening'
  | 'Interview'
  | 'Offer'
  | 'Hired'
  | 'Rejected'
  | 'Withdrawn';

/**
 * Single row returned by `listForApplicant`. Pre-joined with the job
 * posting + the preferred locale's translation so the view does not
 * have to issue per-row N+1 fetches.
 */
export interface ApplicationListRow {
  /** `applications.id` — opaque internal identifier, used in URLs. */
  readonly id: number;
  /** `applications.uuid` — stable external identifier (audit links). */
  readonly uuid: string;
  /** Public-facing reference number, e.g. `APP-2026-000123`. */
  readonly referenceNo: string;
  /** Job posting primary key. */
  readonly jobId: number;
  /** Slug used for `/:locale/jobs/:slug`. */
  readonly jobSlug: string;
  /** Title from the requested locale, falling back to the other locale. */
  readonly jobTitle: string;
  /** `job_postings.location` — denormalised company location string. */
  readonly jobLocation: string;
  /** Current pipeline stage. */
  readonly stage: ApplicationStage;
  /** ISO-8601 timestamp of submission. */
  readonly appliedAt: Date;
  /** ISO-8601 timestamp of hire (denormalised) or null. */
  readonly hiredAt: Date | null;
}

/**
 * Single timeline entry from `application_stage_history`. Sorted ASC
 * by `changed_at` so the view renders chronologically.
 */
export interface StageTimelineEntry {
  readonly id: number;
  readonly prevStage: ApplicationStage | null;
  readonly newStage: ApplicationStage;
  /** Actor user id, NULL for system-generated transitions. */
  readonly changedBy: number | null;
  readonly changedAt: Date;
}

/**
 * Applicant-visible note (filtered by `visible_to_applicant=1`).
 * `authorName` is the author's display name resolved at query time
 * (`users.email` is the only canonical "display" we have at this stage
 * of the spec — name fields live on `applicants` for Applicant role
 * users, but most note authors are HR/Super_Admin).
 */
export interface ApplicantVisibleNote {
  readonly id: number;
  readonly authorUserId: number;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * Detail view for a single application — used by
 * `GET /:locale/me/applications/:id`.
 */
export interface ApplicationDetail {
  readonly id: number;
  readonly uuid: string;
  readonly referenceNo: string;
  readonly jobId: number;
  readonly jobSlug: string;
  readonly jobTitle: string;
  readonly jobLocation: string;
  readonly stage: ApplicationStage;
  readonly appliedAt: Date;
  readonly hiredAt: Date | null;
  readonly stageHistory: readonly StageTimelineEntry[];
  readonly notes: readonly ApplicantVisibleNote[];
}

interface ListOptions {
  readonly locale?: SupportedLocale;
  readonly page?: number;
  readonly pageSize?: number;
}

interface DetailOptions {
  readonly locale?: SupportedLocale;
}

/** Internal: paginated list result. */
export interface PaginatedApplicationList {
  readonly rows: readonly ApplicationListRow[];
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_LOCALE: SupportedLocale = 'id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick a clean (locale, fallback) pair from the user-supplied locale.
 * The fallback is the OTHER supported locale so a missing translation
 * still resolves to a real title.
 */
function resolveLocalePair(
  raw: SupportedLocale | undefined,
): { primary: SupportedLocale; fallback: SupportedLocale } {
  const primary: SupportedLocale = raw === 'en' ? 'en' : 'id';
  const fallback: SupportedLocale = primary === 'id' ? 'en' : 'id';
  return { primary, fallback };
}

/**
 * Coerce a possibly-string DATETIME from mysql2 into a Date. mysql2
 * with `decimalNumbers: true` already returns DATETIME columns as
 * `Date`, but tests / future driver upgrades may surface strings —
 * this normalises to a single shape for the route layer.
 */
function toDate(raw: unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return new Date(raw);
  // Defensive: an unexpected value would point at a programming error;
  // the caller treats this Date as opaque, so falling back to "now"
  // is safer than throwing during a render.
  return new Date(0);
}

function toDateOrNull(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  return toDate(raw);
}

function clampPage(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const n = Math.floor(value);
  return n < 1 ? 1 : n;
}

function clampPageSize(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PAGE_SIZE;
  }
  const n = Math.floor(value);
  if (n < 1) return DEFAULT_PAGE_SIZE;
  if (n > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return n;
}

// ---------------------------------------------------------------------------
// listForApplicant
// ---------------------------------------------------------------------------

/**
 * List every application owned by `applicantUserId`, ordered by the
 * submission timestamp descending (Req 5.6 — "sorted by submission
 * date descending").
 *
 * The query JOINs `job_postings` and `job_posting_translations`. The
 * preferred locale's translation is `LEFT JOIN`-ed alongside the
 * fallback locale's row, and we `COALESCE(primary.title,
 * fallback.title)` so the row always carries a usable title even when
 * the preferred locale's translation is missing. (`job_postings.title`
 * does not exist; the title only lives on the translations table per
 * design §7.2.)
 *
 * Pagination is applied at the SQL layer with bounded page sizes
 * (defaults 20, max 100) so a hostile `?pageSize=99999` cannot strain
 * the connection. A `SQL_CALC_FOUND_ROWS`-free pattern is used: we run
 * a separate `COUNT(*)` query so we can index the count without
 * bloating the list query.
 */
export async function listForApplicant(
  applicantUserId: number,
  opts: ListOptions = {},
): Promise<PaginatedApplicationList> {
  const { primary, fallback } = resolveLocalePair(opts.locale);
  const page = clampPage(opts.page);
  const pageSize = clampPageSize(opts.pageSize);
  const offset = (page - 1) * pageSize;

  // Total count first — a single index seek on
  // `idx_app_applicant (applicant_user_id, applied_at)`.
  const countRows = await query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM applications WHERE applicant_user_id = ?',
    [applicantUserId],
  );
  const total = Number((countRows[0] as RowDataPacket | undefined)?.n ?? 0);

  // Page query. The two `LEFT JOIN`s are guaranteed cheap because
  // (`job_id`, `locale`) is the PK on `job_posting_translations`.
  const rows = await query<RowDataPacket[]>(
    `SELECT
        a.id            AS id,
        a.uuid          AS uuid,
        a.reference_no  AS reference_no,
        a.job_id        AS job_id,
        j.slug          AS job_slug,
        j.location      AS job_location,
        a.stage         AS stage,
        a.applied_at    AS applied_at,
        a.hired_at      AS hired_at,
        COALESCE(tp.title, tf.title) AS job_title
     FROM applications a
     INNER JOIN job_postings j ON j.id = a.job_id
     LEFT  JOIN job_posting_translations tp
            ON tp.job_id = a.job_id AND tp.locale = ?
     LEFT  JOIN job_posting_translations tf
            ON tf.job_id = a.job_id AND tf.locale = ?
     WHERE a.applicant_user_id = ?
     ORDER BY a.applied_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [primary, fallback, applicantUserId, pageSize, offset],
  );

  const mapped: ApplicationListRow[] = rows.map((row) => ({
    id: Number(row.id),
    uuid: String(row.uuid),
    referenceNo: String(row.reference_no),
    jobId: Number(row.job_id),
    jobSlug: String(row.job_slug),
    jobTitle: row.job_title === null || row.job_title === undefined
      ? ''
      : String(row.job_title),
    jobLocation: String(row.job_location ?? ''),
    stage: row.stage as ApplicationStage,
    appliedAt: toDate(row.applied_at),
    hiredAt: toDateOrNull(row.hired_at),
  }));

  return { rows: mapped, total };
}

// ---------------------------------------------------------------------------
// findOneForApplicant
// ---------------------------------------------------------------------------

/**
 * Fetch a single application + its timeline + applicant-visible notes.
 * Returns `null` when the application id does not exist OR is not owned
 * by `applicantUserId`. Both branches collapse to the same return so
 * the API never confirms the existence of another user's row.
 *
 * Three queries run in series (NOT in a single multi-result statement
 * because mysql2's prepared-statement multi-statement support is OFF
 * by default for safety). Each query is small (the row count per
 * application is bounded), and they all hit covering indexes:
 *   - `applications` PK by id, plus the `applicant_user_id` filter.
 *   - `application_stage_history (idx_ash_app)` ordered ASC.
 *   - `application_notes (idx_note_app)` ordered ASC, filtered
 *     `visible_to_applicant=1`.
 *
 * The notes query LEFT JOINs `users` for the author display label.
 * We do NOT JOIN `applicants` because most authors are HR/Super_Admin
 * who do not have an `applicants` row; the email column is the
 * canonical fallback identifier for now (the dashboard label can be
 * upgraded to a `display_name` column later without changing this
 * query's shape).
 */
export async function findOneForApplicant(
  applicantUserId: number,
  applicationId: number,
  opts: DetailOptions = {},
): Promise<ApplicationDetail | null> {
  const { primary, fallback } = resolveLocalePair(opts.locale);

  // 1. Application row (scoped to the owner).
  const appRows = await query<RowDataPacket[]>(
    `SELECT
        a.id            AS id,
        a.uuid          AS uuid,
        a.reference_no  AS reference_no,
        a.job_id        AS job_id,
        j.slug          AS job_slug,
        j.location      AS job_location,
        a.stage         AS stage,
        a.applied_at    AS applied_at,
        a.hired_at      AS hired_at,
        COALESCE(tp.title, tf.title) AS job_title
     FROM applications a
     INNER JOIN job_postings j ON j.id = a.job_id
     LEFT  JOIN job_posting_translations tp
            ON tp.job_id = a.job_id AND tp.locale = ?
     LEFT  JOIN job_posting_translations tf
            ON tf.job_id = a.job_id AND tf.locale = ?
     WHERE a.id = ? AND a.applicant_user_id = ?
     LIMIT 1`,
    [primary, fallback, applicationId, applicantUserId],
  );
  const appRow = appRows[0];
  if (appRow === undefined) return null;

  // 2. Stage history (chronological).
  const historyRows = await query<RowDataPacket[]>(
    `SELECT id, prev_stage, new_stage, changed_by, changed_at
       FROM application_stage_history
       WHERE application_id = ?
       ORDER BY changed_at ASC, id ASC`,
    [applicationId],
  );
  const stageHistory: StageTimelineEntry[] = historyRows.map((row) => ({
    id: Number(row.id),
    prevStage: (row.prev_stage as ApplicationStage | null) ?? null,
    newStage: row.new_stage as ApplicationStage,
    changedBy:
      row.changed_by === null || row.changed_by === undefined
        ? null
        : Number(row.changed_by),
    changedAt: toDate(row.changed_at),
  }));

  // 3. Applicant-visible notes only (Req 5.7).
  const noteRows = await query<RowDataPacket[]>(
    `SELECT
        n.id              AS id,
        n.author_user_id  AS author_user_id,
        n.body            AS body,
        n.created_at      AS created_at,
        u.email           AS author_email
       FROM application_notes n
       LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.application_id = ?
         AND n.visible_to_applicant = 1
       ORDER BY n.created_at ASC, n.id ASC`,
    [applicationId],
  );
  const notes: ApplicantVisibleNote[] = noteRows.map((row) => ({
    id: Number(row.id),
    authorUserId: Number(row.author_user_id),
    authorName:
      typeof row.author_email === 'string' && row.author_email.length > 0
        ? row.author_email
        : 'PT Buana Megah',
    body: String(row.body ?? ''),
    createdAt: toDate(row.created_at),
  }));

  return {
    id: Number(appRow.id),
    uuid: String(appRow.uuid),
    referenceNo: String(appRow.reference_no),
    jobId: Number(appRow.job_id),
    jobSlug: String(appRow.job_slug),
    jobTitle:
      appRow.job_title === null || appRow.job_title === undefined
        ? ''
        : String(appRow.job_title),
    jobLocation: String(appRow.job_location ?? ''),
    stage: appRow.stage as ApplicationStage,
    appliedAt: toDate(appRow.applied_at),
    hiredAt: toDateOrNull(appRow.hired_at),
    stageHistory,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for callers that want the constants without redefining.
// ---------------------------------------------------------------------------

export const APPLICATION_LIST_DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const APPLICATION_LIST_MAX_PAGE_SIZE = MAX_PAGE_SIZE;
export const APPLICATION_LIST_DEFAULT_LOCALE = DEFAULT_LOCALE;
