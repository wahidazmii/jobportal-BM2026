/**
 * Bookmarks service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 28.1
 * Design  : §4.2 (htmx interaction patterns), §6 Applicant_Area
 * Validates: Requirements 6.4, 6.5, 6.6
 *
 * Public surface:
 *   - `JobNotFoundError`               — thrown by `toggle` when the
 *                                        target job does not exist. The
 *                                        route layer maps this to HTTP
 *                                        404 so the API never confirms
 *                                        the existence of an arbitrary
 *                                        id.
 *   - `BookmarkRow`                    — typed row returned by `list()`.
 *   - `toggle(applicantUserId, jobId)` — flip the (applicant, job) row
 *                                        on or off inside one
 *                                        transaction.
 *   - `list(applicantUserId, locale)`  — list every bookmark for the
 *                                        applicant with the surrounding
 *                                        job context, sorted newest
 *                                        first.
 *
 * Behaviour summary:
 *   - `toggle` runs inside `withTransaction`. It first locks the
 *     `bookmarks` row at `(applicant_user_id, job_id)` via
 *     `SELECT ... FOR UPDATE`. If the row exists it is DELETED and the
 *     function returns `{ bookmarked: false }`. Otherwise the function
 *     verifies the job exists at all (any status) — this guards
 *     against fabricating bookmarks for non-existent ids and gives
 *     the route a stable error shape — then INSERTs a fresh row and
 *     returns `{ bookmarked: true }`. The composite PK
 *     `(applicant_user_id, job_id)` doubles as the natural uniqueness
 *     constraint (migration 0004), so concurrent toggles from the
 *     same applicant on the same job serialise on the row lock.
 *   - `list` returns one row per bookmark with the job snapshot
 *     needed to render the bookmarks page (Req 6.5 / 6.6): the
 *     job's slug, status, location, the active translation title
 *     (locale-aware fallback to the other supported locale when the
 *     requested locale is missing — design §17.4), and two derived
 *     booleans:
 *       * `isPublished` — `status === 'Published'`. Drives the
 *         "no longer available" badge.
 *       * `isApplyable` — `isPublished && (deadline IS NULL OR
 *         deadline >= CURDATE())`. Drives the Apply CTA visibility
 *         (Req 6.6 — disable Apply for unpublished/expired jobs).
 *
 * SQL safety (Req 15.4):
 *   - Every statement uses prepared placeholders. The local lint rule
 *     `local/no-string-concat-sql` enforces no string interpolation
 *     into SQL.
 */

import {
  query,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

/** Locales supported by `job_posting_translations` (mirror migration 0003). */
export const SUPPORTED_LOCALES = ['id', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Default locale when the caller omits one or supplies an unknown value. */
export const DEFAULT_LOCALE: Locale = 'id';

/**
 * Public shape of a bookmark row enriched with the surrounding job
 * snapshot needed to render the bookmarks page. `title` falls back to
 * the alternate supported locale (and finally to an empty string)
 * when the requested locale's translation is missing.
 */
export interface BookmarkRow {
  readonly jobId: number;
  readonly slug: string;
  readonly status: string;
  readonly title: string;
  readonly location: string;
  readonly applicationDeadline: string | null;
  readonly isPublished: boolean;
  readonly isApplyable: boolean;
  readonly bookmarkedAt: Date;
}

/** Toggle result — the new state of the (applicant, job) bookmark. */
export interface ToggleResult {
  readonly bookmarked: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `toggle` when the target `job_id` does not exist in
 * `job_postings` at all. The route layer maps this to HTTP 404 so the
 * API never confirms the existence of an arbitrary id.
 */
export class JobNotFoundError extends Error {
  readonly code = 'job_not_found' as const;
  constructor(public readonly jobId: number) {
    super(`Job posting ${jobId} not found`);
    this.name = 'JobNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * Lock the `(applicant_user_id, job_id)` slot — empty range or
 * existing row — for the duration of the toggle transaction. Two
 * concurrent toggles from the same applicant on the same job
 * serialise here so the second sees the first's effect and toggles
 * back. The `FOR UPDATE` is essential: without it, the SELECT and
 * INSERT/DELETE race could leave both bookmarks in an inconsistent
 * state.
 */
const SELECT_BOOKMARK_FOR_UPDATE_SQL =
  'SELECT 1 AS hit FROM bookmarks ' +
  'WHERE applicant_user_id = ? AND job_id = ? FOR UPDATE';

const DELETE_BOOKMARK_SQL =
  'DELETE FROM bookmarks WHERE applicant_user_id = ? AND job_id = ?';

const INSERT_BOOKMARK_SQL =
  'INSERT INTO bookmarks (applicant_user_id, job_id, created_at) VALUES (?, ?, NOW())';

/**
 * Lightweight existence probe used by `toggle` before INSERT. We do
 * NOT scope this by status — Req 6.6 explicitly says bookmarks
 * persist when the job becomes Closed/Archived, so a "Closed" target
 * remains a legitimate INSERT (the row simply renders inactive in
 * the bookmarks page).
 */
const SELECT_JOB_EXISTS_SQL =
  'SELECT id FROM job_postings WHERE id = ? LIMIT 1';

/**
 * List every bookmark for the applicant with the job snapshot
 * (status, location, deadline) and the active locale's title. The
 * outer LEFT JOIN onto `job_posting_translations` is duplicated for
 * the two locales so the SELECT can pick the requested locale first
 * and fall back to the alternate when the translation is missing
 * (Design §17.4 — single locale Drafts are valid).
 *
 * Ordering: `bookmarks.created_at DESC, bookmarks.job_id DESC`. The
 * id-tiebreak keeps the order stable across two bookmarks created in
 * the same MySQL second.
 *
 * Bind order:
 *   - $1 = primary locale (e.g. 'id')
 *   - $2 = fallback locale (e.g. 'en')
 *   - $3 = applicant_user_id
 */
const SELECT_BOOKMARKS_SQL =
  'SELECT ' +
  '  b.job_id            AS jobId, ' +
  '  b.created_at        AS bookmarkedAt, ' +
  '  j.slug              AS slug, ' +
  '  j.status            AS status, ' +
  '  j.location          AS location, ' +
  '  j.application_deadline AS applicationDeadline, ' +
  '  COALESCE(t_primary.title, t_fallback.title, ?) AS title ' +
  'FROM bookmarks b ' +
  'JOIN job_postings j ON j.id = b.job_id ' +
  'LEFT JOIN job_posting_translations t_primary ' +
  '  ON t_primary.job_id = j.id AND t_primary.locale = ? ' +
  'LEFT JOIN job_posting_translations t_fallback ' +
  '  ON t_fallback.job_id = j.id AND t_fallback.locale = ? ' +
  'WHERE b.applicant_user_id = ? ' +
  'ORDER BY b.created_at DESC, b.job_id DESC';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ListRow extends RowDataPacket {
  jobId: number | string;
  bookmarkedAt: Date | string;
  slug: string;
  status: string;
  location: string;
  applicationDeadline: Date | string | null;
  title: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce mysql2 DATE-style results to a `YYYY-MM-DD` string. */
function dateToIsoYmd(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

/** Coerce mysql2 DATETIME to a Date with NaN guard. */
function toDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  // Fall through — the column is NOT NULL DEFAULT CURRENT_TIMESTAMP so we
  // should never see a missing value in practice. Use the epoch as a
  // defensive fallback rather than throwing mid-render.
  return new Date(0);
}

/**
 * Decide whether a job is currently applyable: must be Published AND
 * either have no deadline or a deadline today-or-later (UTC). The
 * deadline column is a SQL DATE so `today` is computed as UTC midnight
 * to align with how MySQL treats `CURDATE()` and how the search
 * service compares deadlines.
 */
function computeIsApplyable(
  status: string,
  applicationDeadlineYmd: string | null,
  todayYmd: string,
): boolean {
  if (status !== 'Published') return false;
  if (applicationDeadlineYmd === null) return true;
  return applicationDeadlineYmd >= todayYmd;
}

/**
 * Today expressed as `YYYY-MM-DD` in UTC. Mirrors the way deadlines
 * are stored (DATE) and is timezone-stable for the cross-row sort
 * comparison in `computeIsApplyable`.
 */
function todayYmdUtc(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function rowToBookmark(row: ListRow, todayYmd: string): BookmarkRow {
  const status = String(row.status);
  const deadline = dateToIsoYmd(row.applicationDeadline);
  return {
    jobId: Number(row.jobId),
    slug: row.slug,
    status,
    title: row.title ?? '',
    location: row.location,
    applicationDeadline: deadline,
    isPublished: status === 'Published',
    isApplyable: computeIsApplyable(status, deadline, todayYmd),
    bookmarkedAt: toDate(row.bookmarkedAt),
  };
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Toggle the bookmark for `(applicantUserId, jobId)`.
 *
 * Pipeline (Design §6 Applicant_Area, Req 6.4):
 *   1. Open a transaction.
 *   2. Lock the bookmarks slot via `SELECT 1 ... FOR UPDATE`. The
 *      composite PK doubles as the lock target so concurrent toggles
 *      from the same applicant on the same job serialise.
 *   3. If the row exists → DELETE → return `{ bookmarked: false }`.
 *   4. Otherwise → verify the job exists (any status). Missing job →
 *      throw `JobNotFoundError`. Found → INSERT a fresh row and
 *      return `{ bookmarked: true }`.
 *
 * Why we accept any job status on INSERT (not only Published):
 *   Req 6.6 keeps existing bookmarks visible after a job is closed
 *   or archived. Toggling a bookmark for a Closed job from a
 *   stale-but-still-rendered job card is therefore a normal flow,
 *   not an error — the user expectation is "this row still shows up
 *   in my bookmarks page, just inactive". The list service handles
 *   the inactive-state rendering.
 */
export async function toggle(
  applicantUserId: number,
  jobId: number,
): Promise<ToggleResult> {
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError('bookmarks.toggle: invalid applicantUserId');
  }
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new TypeError('bookmarks.toggle: invalid jobId');
  }

  return withTransaction(async (conn: PoolConnection) => {
    const [existingRows] = await conn.execute<RowDataPacket[]>(
      SELECT_BOOKMARK_FOR_UPDATE_SQL,
      [applicantUserId, jobId],
    );

    if (existingRows.length > 0) {
      const [delResult] = await conn.execute<ResultSetHeader>(
        DELETE_BOOKMARK_SQL,
        [applicantUserId, jobId],
      );
      logger.info(
        {
          event: 'bookmark_toggle',
          user_id: applicantUserId,
          job_id: jobId,
          new_state: 'removed',
          affected: delResult.affectedRows,
        },
        'bookmarks.toggle: removed',
      );
      return { bookmarked: false };
    }

    // No row yet — confirm the job exists before INSERT so we can
    // give the route a stable 404 path. The check is a separate
    // statement (rather than relying on the FK error from
    // `fk_bm_job`) so the error shape is uniform across drivers and
    // we never leak the FK-violation reason to the client.
    const [jobRows] = await conn.execute<RowDataPacket[]>(
      SELECT_JOB_EXISTS_SQL,
      [jobId],
    );
    if (jobRows.length === 0) {
      throw new JobNotFoundError(jobId);
    }

    await conn.execute<ResultSetHeader>(INSERT_BOOKMARK_SQL, [
      applicantUserId,
      jobId,
    ]);
    logger.info(
      {
        event: 'bookmark_toggle',
        user_id: applicantUserId,
        job_id: jobId,
        new_state: 'added',
      },
      'bookmarks.toggle: added',
    );
    return { bookmarked: true };
  });
}

/**
 * List every bookmark for the applicant, newest first.
 *
 * The single SELECT joins `job_postings` and (twice) the
 * `job_posting_translations` table so the query returns one row per
 * bookmark with both the requested locale's title and the alternate
 * locale's title to fall back on. The COALESCE in the projection
 * picks the first non-null value; the trailing literal '' guards
 * against the unlikely case where neither locale has a translation
 * row (e.g. a partially-saved Draft) so the view never sees `null`.
 */
export async function list(
  applicantUserId: number,
  requestedLocale: string = DEFAULT_LOCALE,
  now: Date = new Date(),
): Promise<BookmarkRow[]> {
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError('bookmarks.list: invalid applicantUserId');
  }

  const primary: Locale = (SUPPORTED_LOCALES as readonly string[]).includes(
    requestedLocale,
  )
    ? (requestedLocale as Locale)
    : DEFAULT_LOCALE;
  const fallback: Locale = primary === 'id' ? 'en' : 'id';

  const todayYmd = todayYmdUtc(now);

  // Bind order documented above in `SELECT_BOOKMARKS_SQL`.
  // Slot 1 is the COALESCE fallback for "no translation row at all"
  // — we use the empty string so the view never has to handle null.
  const rows = await query<ListRow[]>(SELECT_BOOKMARKS_SQL, [
    '',
    primary,
    fallback,
    applicantUserId,
  ]);
  return rows.map((row) => rowToBookmark(row, todayYmd));
}
