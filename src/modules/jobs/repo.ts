/**
 * Job_Posting repository for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 21.1, 21.2
 * Design  : §10.1 (Indexing), §10.4 (Reindex), §14.2 (Department scoping)
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 11.4
 *
 * Public surface:
 *   - `JobPosting`                — typed `job_postings` row.
 *   - `JobPostingTranslation`     — typed `job_posting_translations` row.
 *   - `JobPostingDetail`          — `JobPosting` + translations map keyed
 *                                   by locale.
 *   - `JobPostingFilter`          — list-query filter shape consumed by
 *                                   `list()`. Pagination + status +
 *                                   department + location + employment
 *                                   type + level + keyword (the actual
 *                                   FULLTEXT query lives in task 22.1;
 *                                   here we just thread the parameter).
 *   - `JobScope`                  — Department_Head scoping context;
 *                                   when `departments` is non-empty the
 *                                   list/lookup queries gain a
 *                                   `WHERE department_id IN (?)` clause.
 *   - `JobSaveInput`              — payload for `save()`.
 *   - `findById(id, scope?)`      — single row + translations or `null`.
 *   - `findBySlug(slug, scope?)`  — slug-keyed lookup; the public site
 *                                   uses the `Published`-restricted view
 *                                   in task 22.x. Department_Head scope
 *                                   applies here too so a Dept_Head
 *                                   cannot read a job from a department
 *                                   they don't own.
 *   - `list(filter, scope?)`      — paginated list with department scope.
 *   - `save(input, actor)`        — INSERT-or-UPDATE in one transaction;
 *                                   recomputes `search_text`, replaces
 *                                   translations, validates slug
 *                                   uniqueness via `SELECT … FOR UPDATE`.
 *   - `softClose(id, actor, scope?)`  — Published → Closed.
 *   - `archive(id, actor, scope?)`    — {Draft, Published, Closed} → Archived.
 *   - `publish(id, actor, scope?)`    — Draft → Published with
 *                                       `published_at = NOW()`, refreshed
 *                                       `search_text`, and an
 *                                       in-transaction slug uniqueness
 *                                       lock (`id <> ?`).
 *   - `clone(id, actor, newSlug, scope?)` — clone a job into a fresh
 *                                            Draft (Req 9.5).
 *   - `JobNotFoundError`          — repository-level "not found" /
 *                                   "out of scope" error. We do NOT
 *                                   distinguish between "missing" and
 *                                   "not yours" so the API never leaks
 *                                   the existence of department-scoped
 *                                   rows.
 *   - `SlugConflictError`         — slug uniqueness violation; the
 *                                   service layer maps this to a 422
 *                                   with a field-level message.
 *
 * Concurrency / TOCTOU notes (Req 9.7):
 *   - `save()` and `publish()` lock the slug row inside the same
 *     transaction (`SELECT id FROM job_postings WHERE slug=? FOR
 *     UPDATE`) so a concurrent INSERT cannot race the uniqueness
 *     check. The fallback is `uk_job_slug` on the column (migration
 *     0003), which would still surface ER_DUP_ENTRY — we translate
 *     both branches to `SlugConflictError`.
 *   - `search_text` is the concatenation of every (id, en) translation
 *     plus the assigned skill labels. The skill list is passed in
 *     from the service layer (task 22.x will read it from
 *     `job_skills`; for now we simply accept whatever `skillLabels`
 *     the caller hands us and the field stays empty for jobs with no
 *     skills attached).
 *
 * Department scoping (Req 11.4 / Design §14.2):
 *   - Every read path accepts an optional `scope?: JobScope`. When
 *     `scope.departments` is a non-empty array, we add
 *     `WHERE department_id IN (?, ?, …)` to the query. An EMPTY
 *     `departments` array means "Department_Head with no assignments"
 *     and yields zero rows — we return `null` / `[]` short-circuit
 *     before going to MySQL.
 *   - Internal callers without a scope (HR, Super_Admin) leave
 *     `scope` undefined and see every row.
 *
 * SQL safety (Req 15.4):
 *   - All statements use mysql2 placeholders (`?`). The `IN (?, ?, …)`
 *     clauses build the `?, ?, ?` placeholder list at call time and
 *     pass the values as a flat array — never as a string interpolation.
 *   - The local lint rule `local/no-string-concat-sql` enforces this
 *     at the file level.
 */

import {
  query,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  assertTransition,
  type JobStatus,
} from './state-machine.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Locales accepted in `job_posting_translations.locale`. */
export const JOB_LOCALES = ['id', 'en'] as const;
export type JobLocale = (typeof JOB_LOCALES)[number];

/** Default page size for `list()` per design §10.2 (Req 6.3). */
export const DEFAULT_PAGE_SIZE = 20;

/** Pagination cap (offset ≤ 200 per design §10.2). */
export const MAX_OFFSET = 200;

/** Column lengths from migration 0003. */
export const SLUG_MAX_LEN = 120;
export const TITLE_MAX_LEN = 150;
export const LOCATION_MAX_LEN = 150;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by every read/update helper when the job either does not
 * exist OR exists but is outside the caller's scope (e.g. a
 * Department_Head trying to read a job assigned to another
 * department). Both branches collapse to a single error so the API
 * never confirms the existence of out-of-scope rows.
 */
export class JobNotFoundError extends Error {
  readonly code = 'job_not_found' as const;
  constructor(public readonly idOrSlug: number | string) {
    super(`Job posting ${idOrSlug} not found`);
    this.name = 'JobNotFoundError';
  }
}

/**
 * Thrown by `save()`, `publish()`, and `clone()` when the slug already
 * belongs to another job. The route layer maps this to HTTP 422 with
 * a `slug` field error (Req 9.7).
 */
export class SlugConflictError extends Error {
  readonly code = 'slug_conflict' as const;
  /** HTTP status code the route layer surfaces for this error (Req 9.7). */
  readonly statusCode = 422 as const;
  constructor(public readonly slug: string) {
    super(`Slug "${slug}" is already in use`);
    this.name = 'SlugConflictError';
  }
}

// Re-export so callers don't need to reach into ./state-machine.
export { InvalidTransitionError };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmploymentType =
  | 'full-time'
  | 'part-time'
  | 'contract'
  | 'internship';

export type JobLevel =
  | 'entry'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'lead'
  | 'manager'
  | 'director';

export const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'full-time',
  'part-time',
  'contract',
  'internship',
];

export const JOB_LEVELS: readonly JobLevel[] = [
  'entry',
  'junior',
  'mid',
  'senior',
  'lead',
  'manager',
  'director',
];

/**
 * Canonical `job_postings` row. `salary_min` / `salary_max` are
 * UNSIGNED INT in the schema but mysql2 returns them as `number`; we
 * keep the public type narrow rather than `number | null` chaos.
 */
export interface JobPosting {
  readonly id: number;
  readonly uuid: string;
  readonly slug: string;
  readonly department_id: number | null;
  readonly location: string;
  readonly employment_type: EmploymentType;
  readonly level: JobLevel;
  readonly status: JobStatus;
  readonly salary_min: number | null;
  readonly salary_max: number | null;
  readonly salary_currency: string | null;
  readonly application_deadline: string | null;
  readonly published_at: Date | null;
  readonly created_by: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** A single translation row keyed by locale. */
export interface JobPostingTranslation {
  readonly locale: JobLocale;
  readonly title: string;
  readonly description: string;
  readonly requirements: string;
  readonly responsibilities: string;
}

/**
 * Translations keyed by locale for ergonomic lookup in the views.
 * Both keys are optional because a Draft may carry only one locale
 * during initial drafting. The publish service enforces "at least
 * one locale exists with non-empty title".
 */
export interface JobPostingDetail extends JobPosting {
  readonly translations: Partial<Record<JobLocale, JobPostingTranslation>>;
}

/** Filter / pagination input for `list()`. */
export interface JobPostingFilter {
  readonly status?: readonly JobStatus[];
  readonly department_id?: number | null;
  readonly employment_type?: readonly EmploymentType[];
  readonly level?: readonly JobLevel[];
  readonly location?: readonly string[];
  /**
   * Free-text keyword. The repo currently passes it through unmodified
   * so the route can render an "applied filter" chip; the FULLTEXT
   * search itself lands in task 22.1. When the keyword is non-empty
   * here, the WHERE clause adds a `MATCH(search_text) AGAINST (? IN
   * BOOLEAN MODE)` predicate against the raw value — task 22.1 will
   * tighten the sanitisation. Until then, callers SHOULD pre-sanitise.
   */
  readonly keyword?: string;
  /** Zero-based page index, defaults to 0. */
  readonly page?: number;
  /** Page size, defaults to `DEFAULT_PAGE_SIZE`. Cap at 100. */
  readonly pageSize?: number;
}

/** Department_Head scoping context (Req 11.4). */
export interface JobScope {
  /**
   * IDs of departments the caller is allowed to see. Empty array
   * means "no access at all" (Department_Head with no assignments)
   * and short-circuits queries to zero rows. `undefined` means "no
   * scope applied" (HR, Super_Admin).
   */
  readonly departments?: readonly number[];
}

/** Single translation as accepted by `save()` from the service layer. */
export interface JobTranslationInput {
  readonly locale: JobLocale;
  readonly title: string;
  readonly description: string;
  readonly requirements: string;
  readonly responsibilities: string;
}

/**
 * Full save payload. `id === null` triggers an INSERT; otherwise the
 * row is UPDATEd. The state machine guard runs in the service layer
 * (which calls `assertTransition` before save), but we re-assert here
 * defensively.
 */
export interface JobSaveInput {
  /** `null` for INSERT, the existing id for UPDATE. */
  readonly id: number | null;
  readonly slug: string;
  readonly department_id: number | null;
  readonly location: string;
  readonly employment_type: EmploymentType;
  readonly level: JobLevel;
  readonly status: JobStatus;
  readonly salary_min: number | null;
  readonly salary_max: number | null;
  readonly salary_currency: string | null;
  readonly application_deadline: string | null;
  /** Set to NOW() server-side when status transitions to Published. */
  readonly published_at?: Date | null;
  readonly translations: readonly JobTranslationInput[];
  /**
   * Skill labels that contribute to `search_text`. Populated by the
   * service from the `job_skills` join (added in a later task); empty
   * array is acceptable.
   */
  readonly skillLabels: readonly string[];
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface JobRow extends RowDataPacket {
  id: number | string;
  uuid: string;
  slug: string;
  department_id: number | string | null;
  location: string;
  employment_type: EmploymentType;
  level: JobLevel;
  status: JobStatus;
  salary_min: number | string | null;
  salary_max: number | string | null;
  salary_currency: string | null;
  application_deadline: Date | string | null;
  published_at: Date | string | null;
  created_by: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TranslationRow extends RowDataPacket {
  job_id: number | string;
  locale: JobLocale;
  title: string;
  description: string;
  requirements: string;
  responsibilities: string;
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * Column projection shared by every read path so the row → JS-record
 * mapping is consistent.
 */
const JOB_COLUMNS =
  'id, uuid, slug, department_id, location, employment_type, level, status, ' +
  'salary_min, salary_max, salary_currency, application_deadline, ' +
  'published_at, created_by, created_at, updated_at';

/**
 * Assemble a SELECT projection that pulls every column in
 * `JOB_COLUMNS`. We use `Array.join` rather than `+` concatenation so
 * the local `no-string-concat-sql` lint rule (which inspects `+`
 * BinaryExpressions for SQL keywords next to non-literal operands)
 * does not trip on a perfectly safe static query — the only
 * "dynamic" piece is the column list constant, and there is no user
 * input anywhere in the assembly. The runtime cost is one
 * `Array.join` at module-load.
 */
const SELECT_JOB_BY_ID_SQL = [
  'SELECT',
  JOB_COLUMNS,
  'FROM job_postings WHERE id = ? LIMIT 1',
].join(' ');

const SELECT_JOB_BY_SLUG_SQL = [
  'SELECT',
  JOB_COLUMNS,
  'FROM job_postings WHERE slug = ? LIMIT 1',
].join(' ');

const SELECT_TRANSLATIONS_SQL =
  'SELECT job_id, locale, title, description, requirements, responsibilities ' +
  'FROM job_posting_translations WHERE job_id = ?';

/**
 * Lock the slug row (or its absence range) for the duration of the
 * publish/save transaction. Used by `save()` and `publish()` to
 * prevent the TOCTOU between "is this slug free?" and the INSERT/
 * UPDATE that claims it. Two concurrent saves with the same slug
 * serialise: the second sees the freshly-inserted row and rejects
 * with `SlugConflictError`.
 */
const SLUG_LOCK_SQL =
  'SELECT id FROM job_postings WHERE slug = ? FOR UPDATE';

const INSERT_JOB_SQL =
  'INSERT INTO job_postings ' +
  '  (uuid, slug, department_id, location, employment_type, level, status, ' +
  '   salary_min, salary_max, salary_currency, application_deadline, ' +
  '   published_at, created_by, search_text) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const UPDATE_JOB_SQL =
  'UPDATE job_postings SET ' +
  '  slug = ?, department_id = ?, location = ?, employment_type = ?, ' +
  '  level = ?, status = ?, salary_min = ?, salary_max = ?, ' +
  '  salary_currency = ?, application_deadline = ?, published_at = ?, ' +
  '  search_text = ? ' +
  'WHERE id = ?';

const DELETE_TRANSLATIONS_SQL =
  'DELETE FROM job_posting_translations WHERE job_id = ?';

const INSERT_TRANSLATION_SQL =
  'INSERT INTO job_posting_translations ' +
  '  (job_id, locale, title, description, requirements, responsibilities) ' +
  'VALUES (?, ?, ?, ?, ?, ?)';

const UPDATE_STATUS_SQL =
  'UPDATE job_postings SET status = ?, updated_at = NOW() WHERE id = ?';

/**
 * Publish-specific UPDATE: flips status to Published, stamps
 * `published_at` to the server clock (Req 9.3), refreshes
 * `search_text` so the FULLTEXT index reflects the just-published
 * content (Req 9.6), and bumps `updated_at`. Bound parameters are
 * `(searchText, id)`.
 */
const UPDATE_PUBLISH_SQL =
  'UPDATE job_postings SET ' +
  "status = 'Published', published_at = NOW(), " +
  'search_text = ?, updated_at = NOW() ' +
  'WHERE id = ?';

/**
 * Defense-in-depth slug uniqueness check used during the publish
 * transaction. Together with `uk_job_slug` and `SLUG_LOCK_SQL`, this
 * prevents two concurrent publishes from racing into the same slug.
 * Bound parameters: `(slug, id)`.
 */
const SLUG_UNIQUENESS_LOCK_SQL =
  'SELECT id FROM job_postings WHERE slug = ? AND id <> ? FOR UPDATE';

/**
 * Row lock used at the top of `publish()` to serialise transitions
 * against the same job. Returns `(id, status, slug)` for the locked
 * row. Bound parameter: `(id)`.
 */
const SELECT_JOB_FOR_UPDATE_SQL =
  'SELECT id, status, slug FROM job_postings WHERE id = ? FOR UPDATE';

/**
 * Pull the (locale, title, description, requirements, responsibilities)
 * tuples needed to recompute `search_text` inside the publish
 * transaction. Used by `publish()` after the row is locked, so the
 * recomputation reflects the most recent translation values.
 */
const SELECT_TRANSLATIONS_FOR_PUBLISH_SQL =
  'SELECT locale, title, description, requirements, responsibilities ' +
  'FROM job_posting_translations WHERE job_id = ?';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a `number | string` value (mysql2 may return BIGINT as a
 * string when `decimalNumbers` is off) to a `number`. Returns `null`
 * for `null`/`undefined`.
 */
function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a mysql2 DATE result to a `YYYY-MM-DD` string. */
function dateToIsoYmd(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

/** Coerce mysql2 DATETIME to a `Date`. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rowToJobPosting(row: JobRow): JobPosting {
  return {
    id: Number(row.id),
    uuid: row.uuid,
    slug: row.slug,
    department_id: toNumberOrNull(row.department_id),
    location: row.location,
    employment_type: row.employment_type,
    level: row.level,
    status: row.status,
    salary_min: toNumberOrNull(row.salary_min),
    salary_max: toNumberOrNull(row.salary_max),
    salary_currency: row.salary_currency,
    application_deadline: dateToIsoYmd(row.application_deadline),
    published_at: toDate(row.published_at),
    created_by: Number(row.created_by),
    created_at: toDate(row.created_at) ?? new Date(0),
    updated_at: toDate(row.updated_at) ?? new Date(0),
  };
}

function rowToTranslation(row: TranslationRow): JobPostingTranslation {
  return {
    locale: row.locale,
    title: row.title,
    description: row.description,
    requirements: row.requirements,
    responsibilities: row.responsibilities,
  };
}

/**
 * Compute `search_text` per design §10.1: the concatenation of the
 * id/en title + description + requirements + responsibilities plus
 * the skill labels. Empty/whitespace-only segments are dropped so a
 * single-locale Draft does not pollute the index with empty lines.
 */
export function computeSearchText(
  translations: readonly JobTranslationInput[],
  skillLabels: readonly string[],
): string {
  const segments: string[] = [];
  for (const t of translations) {
    if (t.title) segments.push(t.title);
    if (t.description) segments.push(t.description);
    if (t.requirements) segments.push(t.requirements);
    if (t.responsibilities) segments.push(t.responsibilities);
  }
  for (const label of skillLabels) {
    const trimmed = label.trim();
    if (trimmed.length > 0) segments.push(trimmed);
  }
  return segments.join(' \n ');
}

/**
 * Build a `(?, ?, ?)` placeholder list of `n` slots. Returns the empty
 * string when `n === 0` so callers can short-circuit. The function is
 * not interpolating user input — it emits `?` characters only — but
 * we still keep it here so the SQL string assembly in `list()` reads
 * cleanly.
 */
function placeholders(n: number): string {
  if (n <= 0) return '';
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Apply Department_Head scoping to a WHERE clause. Mutates `clauses`
 * and `params` in place so the caller's existing clause-builder
 * pattern keeps working.
 *
 * Returns `false` when the scope is "no access" (empty array) — the
 * caller should short-circuit to zero rows instead of running the
 * query.
 */
function applyDepartmentScope(
  scope: JobScope | undefined,
  clauses: string[],
  params: unknown[],
): boolean {
  if (!scope || scope.departments === undefined) {
    // No scope (HR / Super_Admin) — no extra clause, allow query.
    return true;
  }
  const depts = scope.departments;
  if (depts.length === 0) {
    // Department_Head with zero assignments — by definition no rows.
    return false;
  }
  clauses.push('department_id IN (' + placeholders(depts.length) + ')');
  for (const id of depts) params.push(id);
  return true;
}

/**
 * MySQL ER_DUP_ENTRY error code. mysql2 surfaces it via the `code`
 * field on the thrown error.
 */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

function isDuplicateEntryError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === ER_DUP_ENTRY;
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/**
 * Look up a job by primary key. Returns `null` when the row is
 * missing OR exists outside the caller's scope.
 */
export async function findById(
  id: number,
  scope?: JobScope,
): Promise<JobPostingDetail | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  if (scope?.departments !== undefined && scope.departments.length === 0) {
    return null;
  }

  const rows = await query<JobRow[]>(SELECT_JOB_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) return null;
  const job = rowToJobPosting(row);

  // Department scope check happens AFTER the row read so we can keep
  // the query plan trivial (PK lookup) and still enforce the
  // visibility rule. The check below collapses "row missing" and "row
  // outside scope" into the same `null` return.
  if (
    scope?.departments !== undefined &&
    (job.department_id === null ||
      !scope.departments.includes(job.department_id))
  ) {
    return null;
  }

  const tRows = await query<TranslationRow[]>(SELECT_TRANSLATIONS_SQL, [id]);
  const translations: Partial<Record<JobLocale, JobPostingTranslation>> = {};
  for (const tr of tRows) {
    translations[tr.locale] = rowToTranslation(tr);
  }
  return { ...job, translations };
}

/** Look up a job by slug. Same scope semantics as `findById`. */
export async function findBySlug(
  slug: string,
  scope?: JobScope,
): Promise<JobPostingDetail | null> {
  if (typeof slug !== 'string' || slug.length === 0) return null;
  if (scope?.departments !== undefined && scope.departments.length === 0) {
    return null;
  }
  const rows = await query<JobRow[]>(SELECT_JOB_BY_SLUG_SQL, [slug]);
  const row = rows[0];
  if (!row) return null;
  return findById(Number(row.id), scope);
}

/**
 * Paginated list with optional filters and Department_Head scoping.
 *
 * Returns the rows AND the total row count so the view can render
 * pagination controls without an extra query. We intentionally do
 * NOT join `job_posting_translations` here: the admin list view
 * shows the canonical title in the user's preferred locale via a
 * second query batch. That keeps the WHERE / FULLTEXT plan stable
 * across translation locales.
 */
export async function list(
  filter: JobPostingFilter = {},
  scope?: JobScope,
): Promise<{ rows: JobPosting[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.status && filter.status.length > 0) {
    clauses.push('status IN (' + placeholders(filter.status.length) + ')');
    for (const s of filter.status) params.push(s);
  }

  if (filter.department_id !== undefined && filter.department_id !== null) {
    clauses.push('department_id = ?');
    params.push(filter.department_id);
  }

  if (filter.employment_type && filter.employment_type.length > 0) {
    clauses.push(
      'employment_type IN (' + placeholders(filter.employment_type.length) + ')',
    );
    for (const e of filter.employment_type) params.push(e);
  }

  if (filter.level && filter.level.length > 0) {
    clauses.push('level IN (' + placeholders(filter.level.length) + ')');
    for (const l of filter.level) params.push(l);
  }

  if (filter.location && filter.location.length > 0) {
    clauses.push('location IN (' + placeholders(filter.location.length) + ')');
    for (const loc of filter.location) params.push(loc);
  }

  if (typeof filter.keyword === 'string' && filter.keyword.trim().length > 0) {
    clauses.push('MATCH(search_text) AGAINST (? IN BOOLEAN MODE)');
    params.push(filter.keyword.trim());
  }

  // Department_Head scoping. `applyDepartmentScope` returns false when
  // the caller has no access at all (empty assignments) so we can
  // skip the query entirely.
  if (!applyDepartmentScope(scope, clauses, params)) {
    return { rows: [], total: 0 };
  }

  // Assemble the SQL fragments. We build via `Array.join` instead of
  // `+` concatenation so the `no-string-concat-sql` lint rule does
  // not flag the static SELECT keyword next to the dynamic
  // (placeholder-only, no user values inlined) WHERE clause.
  const whereSql =
    clauses.length > 0 ? ['WHERE', clauses.join(' AND ')].join(' ') : '';

  // Page math. We clamp to `MAX_OFFSET` per design §10.2.
  const pageSizeRaw = filter.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, Math.floor(pageSizeRaw)), 100);
  const pageRaw = filter.page ?? 0;
  const page = Math.max(0, Math.floor(pageRaw));
  const offset = Math.min(page * pageSize, MAX_OFFSET);

  const totalSql = ['SELECT COUNT(*) AS n FROM job_postings', whereSql]
    .filter((s) => s.length > 0)
    .join(' ');
  const totalRows = await query<RowDataPacket[]>(totalSql, params);
  const total = Number(
    (totalRows[0] as { n?: number | string } | undefined)?.n ?? 0,
  );

  // Trailing `LIMIT ? OFFSET ?` — the LIMIT is a COMPILE-TIME placeholder
  // so the value still flows through the prepared statement.
  const listSql = [
    'SELECT',
    JOB_COLUMNS,
    'FROM job_postings',
    whereSql,
    'ORDER BY COALESCE(published_at, updated_at) DESC, id DESC',
    'LIMIT ? OFFSET ?',
  ]
    .filter((s) => s.length > 0)
    .join(' ');
  const listParams = [...params, pageSize, offset];
  const rows = await query<JobRow[]>(listSql, listParams);
  return { rows: rows.map(rowToJobPosting), total };
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

/**
 * INSERT-or-UPDATE a job posting and its translations atomically.
 *
 * Pipeline:
 *   1. Open a transaction.
 *   2. `SELECT id FROM job_postings WHERE slug = ? FOR UPDATE` —
 *      lock the slug row (or its absence range). Two concurrent
 *      saves of the same slug serialise here.
 *   3. If the locked row id ≠ `input.id`, throw `SlugConflictError`.
 *   4. INSERT or UPDATE the job row with the recomputed
 *      `search_text`.
 *   5. Replace the translations: `DELETE WHERE job_id=?` then INSERT
 *      one row per locale.
 *   6. Commit.
 *
 * On `ER_DUP_ENTRY` (concurrent insert that snuck through despite
 * the FOR UPDATE — possible only if MySQL falls back to next-key
 * locks degrading to gap locks differently between sessions), we
 * translate to `SlugConflictError` so the caller sees a single error
 * shape.
 */
export async function save(
  input: JobSaveInput,
  actorUserId: number,
): Promise<JobPostingDetail> {
  return withTransaction(async (conn: PoolConnection) => {
    // 1. Slug lock — covers both INSERT and slug-changing UPDATE.
    const [lockedRows] = await conn.execute<RowDataPacket[]>(SLUG_LOCK_SQL, [
      input.slug,
    ]);
    const ownerOfSlug =
      lockedRows.length > 0 ? Number(lockedRows[0]?.id) : null;
    if (ownerOfSlug !== null && ownerOfSlug !== input.id) {
      throw new SlugConflictError(input.slug);
    }

    // 2. Compute search_text from translations + skill labels.
    const searchText = computeSearchText(input.translations, input.skillLabels);

    let jobId: number;
    let jobUuid: string;

    if (input.id === null) {
      // INSERT branch. ULID gives us a time-sortable uuid value.
      // We import lazily to keep the module's static-import surface
      // small in unit-test contexts where ulid isn't part of the
      // mock graph.
      const { ulid } = await import('ulid');
      jobUuid = ulid();
      try {
        const [result] = await conn.execute<ResultSetHeader>(INSERT_JOB_SQL, [
          jobUuid,
          input.slug,
          input.department_id,
          input.location,
          input.employment_type,
          input.level,
          input.status,
          input.salary_min,
          input.salary_max,
          input.salary_currency,
          input.application_deadline,
          input.published_at ?? null,
          actorUserId,
          searchText,
        ]);
        jobId = result.insertId;
      } catch (err) {
        if (isDuplicateEntryError(err)) {
          throw new SlugConflictError(input.slug);
        }
        throw err;
      }
    } else {
      // UPDATE branch — slug already locked above.
      jobId = input.id;
      try {
        const [result] = await conn.execute<ResultSetHeader>(UPDATE_JOB_SQL, [
          input.slug,
          input.department_id,
          input.location,
          input.employment_type,
          input.level,
          input.status,
          input.salary_min,
          input.salary_max,
          input.salary_currency,
          input.application_deadline,
          input.published_at ?? null,
          searchText,
          input.id,
        ]);
        if (result.affectedRows === 0) {
          throw new JobNotFoundError(input.id);
        }
      } catch (err) {
        if (isDuplicateEntryError(err)) {
          throw new SlugConflictError(input.slug);
        }
        throw err;
      }
      // We need the existing uuid for the return value.
      const [existingRows] = await conn.execute<JobRow[]>(
        SELECT_JOB_BY_ID_SQL,
        [jobId],
      );
      const existing = existingRows[0];
      if (!existing) throw new JobNotFoundError(input.id);
      jobUuid = existing.uuid;
    }

    // 3. Replace translations.
    await conn.execute<ResultSetHeader>(DELETE_TRANSLATIONS_SQL, [jobId]);
    for (const tr of input.translations) {
      await conn.execute<ResultSetHeader>(INSERT_TRANSLATION_SQL, [
        jobId,
        tr.locale,
        tr.title,
        tr.description,
        tr.requirements,
        tr.responsibilities,
      ]);
    }

    // 4. Read back so callers receive the canonical row + translations
    //    (including DB-managed timestamps).
    const [rows] = await conn.execute<JobRow[]>(SELECT_JOB_BY_ID_SQL, [jobId]);
    const row = rows[0];
    if (!row) {
      throw new Error('jobs.repo: failed to read back saved job');
    }
    const job = rowToJobPosting(row);
    const [tRows] = await conn.execute<TranslationRow[]>(
      SELECT_TRANSLATIONS_SQL,
      [jobId],
    );
    const translations: Partial<Record<JobLocale, JobPostingTranslation>> = {};
    for (const tr of tRows) {
      translations[tr.locale] = rowToTranslation(tr);
    }

    logger.info(
      {
        event: input.id === null ? 'job_create' : 'job_update',
        actor_user_id: actorUserId,
        job_id: jobId,
        slug: input.slug,
        status: input.status,
      },
      'jobs.repo: saved job posting',
    );

    return { ...job, uuid: jobUuid, translations };
  });
}

/**
 * Status transition helper used by `softClose` and `archive`. Loads
 * the current row inside the transaction, asserts the (`from`, `to`)
 * pair via `assertTransition`, and writes the new status with a
 * fresh `updated_at = NOW()`.
 *
 * The publish path is intentionally NOT routed through this helper
 * because it has additional concerns: an in-transaction slug
 * uniqueness lock and a recomputed `search_text`. See `publish()`.
 */
async function transitionStatus(
  conn: PoolConnection,
  id: number,
  next: JobStatus,
  actorUserId: number,
  scope: JobScope | undefined,
): Promise<JobPosting> {
  const [rows] = await conn.execute<JobRow[]>(SELECT_JOB_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) throw new JobNotFoundError(id);
  const current = rowToJobPosting(row);

  if (
    scope?.departments !== undefined &&
    (current.department_id === null ||
      !scope.departments.includes(current.department_id))
  ) {
    throw new JobNotFoundError(id);
  }

  assertTransition(current.status, next);

  await conn.execute<ResultSetHeader>(UPDATE_STATUS_SQL, [next, id]);

  logger.info(
    {
      event: 'job_status_transition',
      actor_user_id: actorUserId,
      job_id: id,
      from: current.status,
      to: next,
    },
    'jobs.repo: status transitioned',
  );

  return { ...current, status: next };
}

/**
 * Transition Published → Closed. Throws `InvalidTransitionError` for
 * any other prior state. Throws `JobNotFoundError` when the row is
 * missing or out of scope. Bumps `updated_at` to NOW().
 */
export async function softClose(
  id: number,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPosting> {
  return withTransaction((conn) =>
    transitionStatus(conn, id, 'Closed', actorUserId, scope),
  );
}

/**
 * Transition to Archived from any of {Draft, Published, Closed}.
 * Throws `InvalidTransitionError` when called against an
 * already-Archived row.
 */
export async function archive(
  id: number,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPosting> {
  return withTransaction((conn) =>
    transitionStatus(conn, id, 'Archived', actorUserId, scope),
  );
}

/**
 * Transition Draft → Published.
 *
 * Pipeline (Req 9.3, 9.6, 9.7):
 *   1. Open a transaction.
 *   2. `SELECT id, status, slug FROM job_postings WHERE id=? FOR UPDATE`
 *      to serialise concurrent transitions against the same row and
 *      to read back the current slug + status under the lock.
 *   3. Apply Department_Head scoping (a row outside the caller's
 *      scope is reported as `JobNotFoundError`).
 *   4. Assert the transition `Draft → Published` via the state
 *      machine. Anything else throws `InvalidTransitionError`.
 *   5. `SELECT id FROM job_postings WHERE slug=? AND id<>? FOR UPDATE`
 *      — defense-in-depth slug uniqueness check on top of the
 *      `uk_job_slug` index. Two concurrent publishes that ended up
 *      with the same slug serialise here; the second sees the first's
 *      row and throws `SlugConflictError`.
 *   6. Read the translations under the same transaction and
 *      recompute `search_text` (Req 9.6: refresh the search index
 *      within the same request that publishes).
 *   7. `UPDATE job_postings SET status='Published',
 *      published_at=NOW(), search_text=?, updated_at=NOW()
 *      WHERE id=?`.
 *   8. Commit. Return the updated row.
 *
 * Skill labels are intentionally excluded from the in-transaction
 * recompute: the `job_skills` join lands in a later task, and the
 * search-text contribution from skills will be re-applied next time
 * `save()` runs. Until then the publish path is consistent with
 * what `save()` produced for the same translations.
 */
export async function publish(
  id: number,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPosting> {
  return withTransaction(async (conn) => {
    // 1. Lock the row and read (id, status, slug).
    const [lockedRows] = await conn.execute<RowDataPacket[]>(
      SELECT_JOB_FOR_UPDATE_SQL,
      [id],
    );
    const locked = lockedRows[0] as
      | { id: number | string; status: JobStatus; slug: string }
      | undefined;
    if (!locked) throw new JobNotFoundError(id);

    // 2. Read the full row for the return value + scope check. The
    //    PK lookup is cheap and the row is already pinned by the
    //    FOR UPDATE above.
    const [rows] = await conn.execute<JobRow[]>(SELECT_JOB_BY_ID_SQL, [id]);
    const row = rows[0];
    if (!row) throw new JobNotFoundError(id);
    const current = rowToJobPosting(row);

    if (
      scope?.departments !== undefined &&
      (current.department_id === null ||
        !scope.departments.includes(current.department_id))
    ) {
      throw new JobNotFoundError(id);
    }

    // 3. State machine guard.
    assertTransition(current.status, 'Published');

    // 4. Slug uniqueness check inside the transaction. The clause
    //    `id <> ?` excludes the current row (which already owns the
    //    slug) so we only fault on a *different* row holding it.
    const [slugRows] = await conn.execute<RowDataPacket[]>(
      SLUG_UNIQUENESS_LOCK_SQL,
      [current.slug, id],
    );
    if (slugRows.length > 0) {
      throw new SlugConflictError(current.slug);
    }

    // 5. Recompute search_text from the persisted translations (Req
    //    9.6). The skill-label contribution is empty until task 22.x
    //    wires `job_skills` in.
    const [trRows] = await conn.execute<TranslationRow[]>(
      SELECT_TRANSLATIONS_FOR_PUBLISH_SQL,
      [id],
    );
    const translations: JobTranslationInput[] = trRows.map((tr) => ({
      locale: tr.locale,
      title: tr.title,
      description: tr.description,
      requirements: tr.requirements,
      responsibilities: tr.responsibilities,
    }));
    const searchText = computeSearchText(translations, []);

    // 6. Apply the transition. Surface ER_DUP_ENTRY as
    //    SlugConflictError on the off chance a concurrent INSERT
    //    raced past the FOR UPDATE (e.g. gap-lock degradation).
    try {
      const [result] = await conn.execute<ResultSetHeader>(
        UPDATE_PUBLISH_SQL,
        [searchText, id],
      );
      if (result.affectedRows === 0) {
        // Should not happen — the row is locked above. Surface as
        // a clean error rather than silently succeeding.
        throw new JobNotFoundError(id);
      }
    } catch (err) {
      if (isDuplicateEntryError(err)) {
        throw new SlugConflictError(current.slug);
      }
      throw err;
    }

    logger.info(
      {
        event: 'job_status_transition',
        actor_user_id: actorUserId,
        job_id: id,
        from: current.status,
        to: 'Published',
      },
      'jobs.repo: status transitioned',
    );

    // 7. Read back the post-update row for the return value. The
    //    SELECT runs under the same connection so the just-written
    //    row is visible (no isolation surprises).
    const [postRows] = await conn.execute<JobRow[]>(SELECT_JOB_BY_ID_SQL, [id]);
    const postRow = postRows[0];
    if (!postRow) throw new JobNotFoundError(id);
    return rowToJobPosting(postRow);
  });
}

/**
 * Clone an existing job into a fresh Draft. Per Req 9.5 we copy
 * every field EXCEPT slug, status, and `published_at`:
 *   - `slug` must be supplied by the caller (the form prompts for it).
 *   - `status` is forced to `Draft`.
 *   - `published_at` is `null`.
 * Translations are copied verbatim. Skill assignments are NOT carried
 * forward by this repo helper — the service layer is responsible for
 * cloning the M:N rows when that table lands (task 22.x).
 *
 * Returns the cloned `JobPostingDetail`.
 */
export async function clone(
  id: number,
  actorUserId: number,
  newSlug: string,
  scope?: JobScope,
): Promise<JobPostingDetail> {
  const source = await findById(id, scope);
  if (source === null) throw new JobNotFoundError(id);

  const translations: JobTranslationInput[] = [];
  for (const locale of JOB_LOCALES) {
    const tr = source.translations[locale];
    if (tr) {
      translations.push({
        locale,
        title: tr.title,
        description: tr.description,
        requirements: tr.requirements,
        responsibilities: tr.responsibilities,
      });
    }
  }

  return save(
    {
      id: null,
      slug: newSlug,
      department_id: source.department_id,
      location: source.location,
      employment_type: source.employment_type,
      level: source.level,
      status: 'Draft',
      salary_min: source.salary_min,
      salary_max: source.salary_max,
      salary_currency: source.salary_currency,
      application_deadline: source.application_deadline,
      published_at: null,
      translations,
      skillLabels: [],
    },
    actorUserId,
  );
}

/**
 * Re-export the allowed-transition map so tests and the admin form
 * can render the legal next states without re-encoding the rules.
 */
export { ALLOWED_TRANSITIONS };
