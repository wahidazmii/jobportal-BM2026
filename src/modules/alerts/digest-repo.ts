/**
 * Job-alert digest repository for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 34.1 (cron alert-digest)
 * Design  : §7.2 (job_alerts DDL), §10.2 (search visibility predicate),
 *           §11.3 (alert-digest batching)
 * Validates: Requirements 7.2, 7.3
 *
 * Owns the two read paths the `alert-digest` cron needs that do NOT
 * belong on the applicant-facing `alerts/repo.ts` (which is scoped to a
 * single owner and would never expose a cross-tenant "all due alerts"
 * scan):
 *
 *   - `listDueForDigest(limit)`  — the §11.3 "due alerts" batch query.
 *     Returns every alert whose configured frequency window has elapsed
 *     (or that has never been evaluated), joined to the recipient's
 *     email / name / locale so the cron can enqueue a digest without a
 *     second round-trip per alert.
 *
 *   - `findMatchingJobs(alert, since, limit)` — the per-alert match. Finds
 *     Published, not-yet-expired Job_Postings published strictly after
 *     `since` (the alert's previous evaluation timestamp, Req 7.2) that
 *     also satisfy the alert's keyword / locations / departments filter.
 *
 *   - `markEvaluated(id, conn?)` — advance `last_evaluated_at = NOW()`.
 *     Accepts an optional transaction connection so the cron can advance
 *     the timestamp inside the SAME transaction as the digest enqueue —
 *     that coupling is what makes Req 7.6 hold (enqueue + timestamp
 *     advance commit or roll back together).
 *
 * Visibility predicate (Design §10.2, Req 7.2):
 *   A job is "matchable" only when it is `status='Published'` AND its
 *   `application_deadline` has not passed — identical to the public
 *   search predicate so a digest never links to a job an applicant
 *   could not actually apply to.
 *
 * Filter semantics (Req 7.2, migration 0005 JSON contract):
 *   - keyword NULL / empty / sub-ngram → no keyword filter.
 *   - locations NULL / empty array     → no location filter.
 *   - departments NULL / empty array   → no department filter.
 *   The keyword is run through the SAME `sanitizeKeyword` sanitiser the
 *   public search uses so the FULLTEXT BOOLEAN-mode query is consistent
 *   between the two surfaces (and BOOLEAN-mode operator injection is
 *   stripped).
 *
 * SQL safety (Req 15.4):
 *   - Every statement is a prepared statement using mysql2 `?`
 *     placeholders. Static SQL is assembled via `Array.join(' ')` and the
 *     dynamic `IN (?, ?, …)` lists emit `?` characters only (never
 *     interpolated values) so the local `no-string-concat-sql` rule is
 *     satisfied.
 */

import {
  query,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { sanitizeKeyword } from '../jobs/search.js';
import type { AlertFrequency } from './repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum alerts evaluated per cron run (Design §11.3 — "batasi 500 alert
 * per run"). Inlined as a static integer literal in the SELECT (never user
 * input) exactly like `mail-flush`'s `LIMIT 200`.
 */
export const MAX_ALERTS_PER_RUN = 500;

/**
 * Defensive cap on the number of jobs a single digest enumerates. A digest
 * email is a teaser, not a full export — capping keeps the rendered email
 * (and the `mail_outbox.context` JSON) bounded even for a brand-new,
 * never-evaluated alert whose `since` is the epoch.
 */
export const MAX_JOBS_PER_DIGEST = 50;

/** The COALESCE floor for a never-evaluated alert (Req 7.2). */
export const EPOCH = new Date(0);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A due alert plus the recipient fields needed to enqueue its digest.
 * JSON columns are parsed into real arrays (or `null` for "no filter");
 * `language_pref` is narrowed to the supported `'id' | 'en'` set.
 */
export interface DueAlert {
  readonly id: number;
  readonly applicantUserId: number;
  readonly keyword: string | null;
  readonly locations: string[] | null;
  readonly departments: number[] | null;
  readonly frequency: AlertFrequency;
  readonly lastEvaluatedAt: Date | null;
  readonly applicantEmail: string;
  readonly applicantName: string;
  readonly locale: 'id' | 'en';
}

/** A single Job_Posting that matched an alert, shaped for the digest. */
export interface MatchingJob {
  readonly id: number;
  readonly slug: string;
  readonly title: string | null;
  readonly location: string;
  readonly departmentId: number | null;
  readonly publishedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface DueAlertDbRow extends RowDataPacket {
  id: number | string;
  applicant_user_id: number | string;
  keyword: string | null;
  locations: string | unknown[] | null;
  departments: string | unknown[] | null;
  frequency: AlertFrequency;
  last_evaluated_at: Date | string | null;
  applicant_email: string;
  applicant_name: string;
  language_pref: string | null;
}

interface MatchingJobDbRow extends RowDataPacket {
  id: number | string;
  slug: string;
  title: string | null;
  location: string;
  department_id: number | string | null;
  published_at: Date | string | null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON column value into an array. mysql2 may hand a `JSON`
 * column back already-parsed or as a raw string depending on driver
 * config; handle both. Anything that does not parse into an array
 * collapses to `null` ("no filter") so one corrupt row never crashes the
 * whole digest run.
 */
function parseJsonArray(value: string | unknown[] | null | undefined): unknown[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse the `locations` JSON column into a `string[]` (or `null`). */
function parseLocations(value: string | unknown[] | null | undefined): string[] | null {
  const arr = parseJsonArray(value);
  if (arr === null) return null;
  const strings = arr.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 ? strings : null;
}

/** Parse the `departments` JSON column into a `number[]` (or `null`). */
function parseDepartments(value: string | unknown[] | null | undefined): number[] | null {
  const arr = parseJsonArray(value);
  if (arr === null) return null;
  const numbers = arr
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n));
  return numbers.length > 0 ? numbers : null;
}

/** Normalise a mysql2 DATETIME column to `Date | null`. */
function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Coerce a `number | string | null` to `number | null`. */
function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Narrow the applicant's stored `language_pref` to the supported set. */
function toLocale(value: string | null | undefined): 'id' | 'en' {
  return value === 'en' ? 'en' : 'id';
}

/**
 * Build a `(?, ?, ?)` placeholder list of `n` slots. Emits `?` characters
 * only — no user input is interpolated — so the `no-string-concat-sql`
 * rule never sees a value adjacent to a SQL keyword.
 */
function placeholders(n: number): string {
  if (n <= 0) return '';
  return Array.from({ length: n }, () => '?').join(', ');
}

function rowToDueAlert(row: DueAlertDbRow): DueAlert {
  return {
    id: Number(row.id),
    applicantUserId: Number(row.applicant_user_id),
    keyword: row.keyword ?? null,
    locations: parseLocations(row.locations),
    departments: parseDepartments(row.departments),
    frequency: row.frequency,
    lastEvaluatedAt: toDateOrNull(row.last_evaluated_at),
    applicantEmail: row.applicant_email,
    applicantName: row.applicant_name,
    locale: toLocale(row.language_pref),
  };
}

function rowToMatchingJob(row: MatchingJobDbRow): MatchingJob {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title ?? null,
    location: row.location,
    departmentId: toNumberOrNull(row.department_id),
    publishedAt: toDateOrNull(row.published_at),
  };
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * Due-alert batch (Design §11.3). The WHERE is exactly the design's
 * `last_evaluated_at IS NULL OR <freq threshold>` shape: a `Daily` alert
 * is due once its last evaluation is older than 24 h, a `Weekly` alert
 * once older than 7 days, and any never-evaluated alert is always due.
 *
 * Joined to `users` (email — required to send) and `applicants`
 * (full_name, language_pref) so the cron has everything it needs to
 * enqueue without a per-alert lookup. Both joins are INNER: an alert
 * whose owner row vanished (it cannot — `fk_alert_app` cascades — but
 * defence in depth) simply drops out of the batch rather than producing
 * a digest addressed to nobody.
 *
 * `LIMIT 500` is a static integer literal (never user input); the
 * remainder is picked up by the next cron run (Design §11.3).
 */
const SELECT_DUE_ALERTS_SQL = [
  'SELECT',
  '  ja.id, ja.applicant_user_id, ja.keyword, ja.locations, ja.departments,',
  '  ja.frequency, ja.last_evaluated_at,',
  '  u.email AS applicant_email, a.full_name AS applicant_name, a.language_pref',
  'FROM job_alerts ja',
  'JOIN users u ON u.id = ja.applicant_user_id',
  'JOIN applicants a ON a.user_id = ja.applicant_user_id',
  'WHERE (',
  '  ja.last_evaluated_at IS NULL',
  "  OR (ja.frequency = 'Daily'  AND ja.last_evaluated_at < NOW() - INTERVAL 1 DAY)",
  "  OR (ja.frequency = 'Weekly' AND ja.last_evaluated_at < NOW() - INTERVAL 7 DAY)",
  ')',
  'ORDER BY ja.id',
  `LIMIT ${MAX_ALERTS_PER_RUN}`,
].join(' ');

/** Advance the evaluation timestamp for one alert (Req 7.5 / 7.6). */
const MARK_EVALUATED_SQL = [
  'UPDATE job_alerts',
  'SET last_evaluated_at = NOW()',
  'WHERE id = ?',
].join(' ');

/**
 * The "matchable job" visibility predicate (Design §10.2). Shared by the
 * matching query so a digest never surfaces a Draft/Closed/Archived or
 * expired posting. `published_at IS NOT NULL` is belt-and-braces: a
 * Published row always has it stamped (Req 9.3), but the strict
 * `published_at > ?` comparison below would mis-handle a NULL otherwise.
 */
const JOB_VISIBILITY_CLAUSES: readonly string[] = [
  "j.status = 'Published'",
  '(j.application_deadline IS NULL OR j.application_deadline >= CURRENT_DATE())',
  'j.published_at IS NOT NULL',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the batch of alerts due for evaluation this run, newest-id last
 * (stable FIFO). `limit` defaults to {@link MAX_ALERTS_PER_RUN}; callers
 * SHOULD leave it at the default — the parameter exists for tests.
 */
export async function listDueForDigest(): Promise<DueAlert[]> {
  const rows = await query<DueAlertDbRow[]>(SELECT_DUE_ALERTS_SQL);
  return rows.map(rowToDueAlert);
}

/**
 * Find the Job_Postings that match `alert` and were published strictly
 * after `since` (Req 7.2). Returns at most {@link MAX_JOBS_PER_DIGEST}
 * rows, newest first, each carrying the title in the recipient's locale
 * (falling back id → en) plus the location and slug the digest renders.
 *
 * Filter axes are AND'd; an absent axis (null/empty keyword, locations,
 * or departments) contributes no clause (migration 0005 JSON contract).
 */
export async function findMatchingJobs(
  alert: Pick<DueAlert, 'keyword' | 'locations' | 'departments' | 'locale'>,
  since: Date,
  limit: number = MAX_JOBS_PER_DIGEST,
): Promise<MatchingJob[]> {
  const clauses: string[] = [...JOB_VISIBILITY_CLAUSES, 'j.published_at > ?'];
  const whereParams: unknown[] = [since];

  // Keyword — sanitised through the same path as public search. An empty
  // result means "no keyword filter".
  const sanitisedKeyword = sanitizeKeyword(alert.keyword ?? '');
  if (sanitisedKeyword !== '') {
    clauses.push('MATCH(j.search_text) AGAINST (? IN BOOLEAN MODE)');
    whereParams.push(sanitisedKeyword);
  }

  // Locations — exact (case-insensitive via the column collation) match.
  if (alert.locations && alert.locations.length > 0) {
    clauses.push('j.location IN (' + placeholders(alert.locations.length) + ')');
    for (const loc of alert.locations) whereParams.push(loc);
  }

  // Departments — integer equality against the FK.
  if (alert.departments && alert.departments.length > 0) {
    clauses.push(
      'j.department_id IN (' + placeholders(alert.departments.length) + ')',
    );
    for (const id of alert.departments) whereParams.push(id);
  }

  // The locale join params come BEFORE the WHERE params; the LIMIT value
  // comes last. We COALESCE the recipient locale → id → en so a digest in
  // `en` still shows a title for an id-only Draft that was later published.
  const sql = [
    'SELECT',
    '  j.id, j.slug, j.location, j.department_id, j.published_at,',
    '  COALESCE(tl.title, ti.title, te.title) AS title',
    'FROM job_postings j',
    'LEFT JOIN job_posting_translations tl ON tl.job_id = j.id AND tl.locale = ?',
    "LEFT JOIN job_posting_translations ti ON ti.job_id = j.id AND ti.locale = 'id'",
    "LEFT JOIN job_posting_translations te ON te.job_id = j.id AND te.locale = 'en'",
    'WHERE',
    clauses.join(' AND '),
    'ORDER BY j.published_at DESC, j.id DESC',
    'LIMIT ?',
  ].join(' ');

  const params = [alert.locale, ...whereParams, limit];
  const rows = await query<MatchingJobDbRow[]>(sql, params);
  return rows.map(rowToMatchingJob);
}

/**
 * Advance `last_evaluated_at = NOW()` for one alert.
 *
 * When `conn` is supplied the UPDATE runs on that transaction connection
 * so it commits/rolls back atomically with the caller's other work — the
 * cron uses this to bind the timestamp advance to a successful digest
 * enqueue (Req 7.6). When `conn` is omitted the UPDATE runs on the pool
 * (the clean zero-match path, where there is no enqueue to bind to).
 *
 * Returns `true` when a row was updated.
 */
export async function markEvaluated(
  id: number,
  conn?: PoolConnection,
): Promise<boolean> {
  if (conn) {
    const [result] = await conn.execute<ResultSetHeader>(MARK_EVALUATED_SQL, [id]);
    return (result.affectedRows ?? 0) > 0;
  }
  const result = await query<ResultSetHeader>(MARK_EVALUATED_SQL, [id]);
  return (result.affectedRows ?? 0) > 0;
}
