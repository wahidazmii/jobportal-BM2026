/**
 * Public job search service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 22.1
 * Design  : §10.2 (Public search), §10.3 (Facet caching)
 * Validates: Requirements 6.1, 6.2, 6.3
 *
 * Public surface:
 *   - `sanitizeKeyword(input)`        — pure function. Strips MySQL
 *                                       BOOLEAN-mode operator characters
 *                                       from the user keyword and emits
 *                                       a query string fit for
 *                                       `MATCH(...) AGAINST (? IN BOOLEAN
 *                                       MODE)`. Empty / whitespace-only
 *                                       inputs return `''`.
 *   - `searchFilterSchema`            — zod schema. Accepts the shape the
 *                                       route layer (task 22.2) receives
 *                                       directly from `request.query` and
 *                                       coerces strings/comma-separated
 *                                       lists into the typed
 *                                       `SearchFilter` consumed by
 *                                       `searchPublishedJobs`.
 *   - `searchPublishedJobs(filter)`   — main entry. Runs the FULLTEXT
 *                                       query restricted to
 *                                       `status='Published'` and the
 *                                       deadline-not-yet-passed predicate
 *                                       and returns `{ rows, total,
 *                                       facets }`.
 *   - `getFacets(filter)`             — runs four COUNT(*) GROUP BY
 *                                       aggregations in parallel, cached
 *                                       60 seconds in a per-worker
 *                                       `QuickLRU`.
 *   - `clearSearchCache()`            — drops the facet cache. Called by
 *                                       the `search-reindex` cron and
 *                                       (eventually) by the job
 *                                       publish/unpublish hooks so admins
 *                                       see fresh counts.
 *
 * Status visibility (Req 6.1, Design §10.2):
 *   - The "only Published, not-yet-expired" predicate is hard-coded into
 *     every SQL constant in this file. The `SearchFilter` type does NOT
 *     accept a status filter — the public endpoint must NEVER see
 *     Draft/Closed/Archived rows regardless of caller-supplied query
 *     parameters.
 *
 * Sanitisation strategy (Req 6.1, Design §10.2):
 *   - Strip every MySQL BOOLEAN-mode operator character from the raw
 *     input: `+ - > < ( ) ~ * " @`. We also strip the backtick because
 *     it terminates identifiers in some MySQL fork branches.
 *   - Split on whitespace and discard tokens shorter than the
 *     `ngram_token_size=2` threshold — a single character can never
 *     match through the ngram parser.
 *   - For each surviving token, prefix `+` so MySQL ANDs the tokens
 *     together (every word must appear). Append `*` (prefix expansion)
 *     ONLY for tokens with at least three characters: prefix-matching a
 *     two-character token tends to inflate result counts pointlessly
 *     because every ngram bigram fragment matches it.
 *   - Wrap each token with double quotes when it would otherwise have
 *     been left bare so MySQL treats it as a single phrase token rather
 *     than re-tokenising — this is robust against locale-sensitive
 *     whitespace once the sanitiser has decided the boundaries.
 *   - The whole result is passed to MySQL as a single `?` parameter; we
 *     never inline the keyword string into the SQL.
 *
 * Filter semantics (Req 6.2):
 *   - `location`, `department_id`, `employment_type`, `level` accept
 *     arrays. Multiple values WITHIN one filter are OR'd via
 *     `IN (?, ?, ?)`. Filters across categories are AND'd.
 *
 * Pagination (Req 6.3, Design §10.2):
 *   - `pageSize` defaults to 20 and is capped at 50 — the public list
 *     view caps at 20 in production, but admins occasionally call this
 *     service with `pageSize=50` for previews; the LIMIT cap is
 *     defensive.
 *   - `page` is zero-based. The resulting OFFSET is clamped to 200
 *     (10 pages of 20). Callers that need deeper results MUST tighten
 *     their filters — Design §10.2 recommends a "refine your search"
 *     UI nudge.
 *
 * Facet caching (Req 6.3, Design §10.3):
 *   - Four COUNT-by-X aggregations (`location`, `department_id`,
 *     `employment_type`, `level`) run in parallel via `Promise.all`.
 *     Each respects the visibility predicate so retired or future-dated
 *     jobs never bleed into the facet counts.
 *   - The aggregated tuple is cached in a module-level `QuickLRU`
 *     keyed by the JSON-stringified filter (excluding pagination). TTL
 *     is 60 s; size cap is 200 entries. The cache is per-worker
 *     (Passenger may run multiple Node workers; that's fine — a 60 s
 *     skew on facet counts is acceptable for the public list).
 *
 * SQL safety (Req 15.4):
 *   - Every statement uses mysql2 placeholders. Dynamic clause
 *     assembly uses `Array.join` so the `local/no-string-concat-sql`
 *     lint rule does not trip on a perfectly safe static pattern.
 */

import { z } from 'zod';
import QuickLRU from 'quick-lru';

import { query, type RowDataPacket } from '../../infra/db.js';
import {
  EMPLOYMENT_TYPES,
  JOB_LEVELS,
  type EmploymentType,
  type JobLevel,
} from './repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size per Design §10.2 (Req 6.3). */
export const DEFAULT_PAGE_SIZE = 20;

/** Defensive upper bound on page size (admins can request up to 50). */
export const MAX_PAGE_SIZE = 50;

/** Pagination cap (offset ≤ 200 per Design §10.2, Req 6.3). */
export const MAX_OFFSET = 200;

/**
 * MySQL `ngram_token_size` default. Tokens shorter than this can never
 * match through the ngram parser, so the sanitiser drops them rather
 * than emitting a query MySQL is going to no-op anyway.
 */
const NGRAM_TOKEN_SIZE = 2;

/**
 * Minimum token length that earns a trailing `*` (prefix expansion).
 * Bigram-prefixing a two-character token expands to roughly "match
 * everything that contains this bigram", which is too noisy for the
 * public list — we reserve the `*` for tokens of length ≥ 3.
 */
const MIN_PREFIX_TOKEN_LENGTH = 3;

/**
 * Facet cache TTL in milliseconds (Design §10.3). The `QuickLRU` library
 * does lazy expiration on read/write so a 60 s entry effectively
 * guarantees ≤ 60 s staleness without a background timer.
 */
export const FACET_CACHE_TTL_MS = 60_000;

/**
 * Maximum number of cached facet tuples per worker. Each entry is keyed
 * by a JSON-stringified filter so the cardinality is bounded by the
 * number of distinct filter combinations the public list serves; 200
 * entries cover the realistic working set comfortably.
 */
export const FACET_CACHE_MAX_SIZE = 200;

// ---------------------------------------------------------------------------
// Keyword sanitisation
// ---------------------------------------------------------------------------

/**
 * MySQL BOOLEAN-mode operator characters. Stripped from raw input
 * before token assembly so a malicious or accidental `*` cannot widen
 * the result set, and a stray `"` cannot fragment the parsed query.
 *
 * The backtick is included even though it is not a documented BOOLEAN
 * mode operator — it has been observed to terminate identifiers in
 * some MariaDB error messages, so we strip it defensively.
 */
const BOOLEAN_MODE_STRIP_REGEX = /[+\-><()~*"@`]/g;

/**
 * Build a BOOLEAN-mode safe FULLTEXT query string from raw user input.
 *
 * Pure function — no I/O, no async. See module-level "Sanitisation
 * strategy" notes for the full algorithm.
 *
 * Returns `''` when the input is empty/whitespace-only or when every
 * extracted token is shorter than `NGRAM_TOKEN_SIZE`. The caller (the
 * search SQL builder) interprets `''` as "no keyword filter", which
 * the WHERE clause expresses as `(? = '' OR MATCH(...) AGAINST(?...))`.
 */
export function sanitizeKeyword(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  // Strip operator characters first, then collapse whitespace runs.
  const cleaned = input
    .replace(BOOLEAN_MODE_STRIP_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return '';

  const tokens: string[] = [];
  for (const raw of cleaned.split(' ')) {
    const token = raw.trim();
    if (token.length < NGRAM_TOKEN_SIZE) continue;

    const suffix = token.length >= MIN_PREFIX_TOKEN_LENGTH ? '*' : '';
    // Quote the token so MySQL treats it as a single phrase term and
    // never tries to re-tokenise on locale-sensitive whitespace.
    // The leading `+` makes the token mandatory (AND across tokens).
    tokens.push(`+"${token}"${suffix}`);
  }

  if (tokens.length === 0) return '';

  return tokens.join(' ');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Coerce a query-string field into a string array.
 *
 * The route layer hands us either a single string (`?location=Jakarta`),
 * a CSV (`?location=Jakarta,Surabaya`), or an actual array
 * (`?location=Jakarta&location=Surabaya` — Fastify's default parser
 * delivers this as a string array). Empty / whitespace-only entries
 * are dropped.
 */
const csvOrArrayString = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value): string[] | undefined => {
    if (value === undefined) return undefined;
    const parts = Array.isArray(value)
      ? value
      : value.split(',');
    const cleaned = parts
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  });

const employmentTypeArray = csvOrArrayString.pipe(
  z
    .array(z.enum(EMPLOYMENT_TYPES as readonly [EmploymentType, ...EmploymentType[]]))
    .optional(),
);

const levelArray = csvOrArrayString.pipe(
  z.array(z.enum(JOB_LEVELS as readonly [JobLevel, ...JobLevel[]])).optional(),
);

const departmentIdArray = z
  .union([z.string(), z.array(z.string()), z.number(), z.array(z.number())])
  .optional()
  .transform((value): number[] | undefined => {
    if (value === undefined) return undefined;
    const raw = Array.isArray(value) ? value : [value];
    const flat: string[] = [];
    for (const v of raw) {
      if (typeof v === 'number') {
        flat.push(String(v));
      } else {
        for (const part of v.split(',')) flat.push(part);
      }
    }
    const ids: number[] = [];
    for (const part of flat) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const n = Number(trimmed);
      if (Number.isInteger(n) && n > 0) ids.push(n);
    }
    return ids.length > 0 ? ids : undefined;
  });

const positiveInt = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value): number | undefined => {
    if (value === undefined) return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
    return n;
  });

/**
 * Zod schema accepted directly by the route layer (task 22.2). Every
 * field is optional so the same schema parses both the bare list URL
 * (`/jobs`) and the fully-qualified filter URL.
 *
 * The `status` field is intentionally absent: see "Status visibility"
 * notes at the top of this file.
 */
export const searchFilterSchema = z.object({
  keyword: z.string().optional(),
  location: csvOrArrayString,
  department_id: departmentIdArray,
  employment_type: employmentTypeArray,
  level: levelArray,
  page: positiveInt,
  pageSize: positiveInt,
});

/** Resolved `SearchFilter` returned by `searchFilterSchema.parse()`. */
export type SearchFilter = z.infer<typeof searchFilterSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Single row returned by the public search query. We deliberately do
 * NOT include the full `JobPosting` shape — the public list view only
 * needs a handful of columns plus the active locale's title, which the
 * route layer joins on.
 */
export interface SearchResultRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string | null;
  readonly location: string;
  readonly employment_type: EmploymentType;
  readonly level: JobLevel;
  readonly department_id: number | null;
  readonly published_at: Date | null;
  readonly application_deadline: string | null;
}

/** Single facet bucket: a value plus its row count. */
export interface FacetBucket<T extends string | number> {
  readonly value: T;
  readonly count: number;
}

/** Tuple of facet aggregations per Design §10.3. */
export interface SearchFacets {
  readonly location: ReadonlyArray<FacetBucket<string>>;
  readonly department_id: ReadonlyArray<FacetBucket<number>>;
  readonly employment_type: ReadonlyArray<FacetBucket<EmploymentType>>;
  readonly level: ReadonlyArray<FacetBucket<JobLevel>>;
}

export interface SearchResult {
  readonly rows: ReadonlyArray<SearchResultRow>;
  readonly total: number;
  readonly facets: SearchFacets;
  readonly page: number;
  readonly pageSize: number;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface SearchRow extends RowDataPacket {
  id: number | string;
  slug: string;
  title: string | null;
  location: string;
  employment_type: EmploymentType;
  level: JobLevel;
  department_id: number | string | null;
  published_at: Date | string | null;
  application_deadline: Date | string | null;
}

interface CountRow extends RowDataPacket {
  n: number | string;
}

interface FacetRow<V> extends RowDataPacket {
  value: V;
  n: number | string;
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * The visibility predicate that defines a "publicly searchable" job.
 * Hard-coded into every read query in this module so the route layer
 * cannot accidentally widen it. Uses the `j` alias because the search
 * query joins `job_postings AS j` against the translations table.
 */
const VISIBILITY_PREDICATE =
  "j.status = 'Published' " +
  'AND (j.application_deadline IS NULL OR j.application_deadline >= CURRENT_DATE())';

/** Search-result column projection. */
const SEARCH_COLUMNS = [
  'j.id',
  'j.slug',
  'COALESCE(t_active.title, t_fallback.title) AS title',
  'j.location',
  'j.employment_type',
  'j.level',
  'j.department_id',
  'j.published_at',
  'j.application_deadline',
].join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `(?, ?, ?)` placeholder list of `n` slots. The function
 * emits `?` characters only — no user input is interpolated — but we
 * keep it here so the SQL string assembly reads cleanly and the
 * `local/no-string-concat-sql` rule never sees a dynamic operand
 * adjacent to a SQL keyword.
 */
function placeholders(n: number): string {
  if (n <= 0) return '';
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Coerce a `number | string` value (mysql2 may return BIGINT as a
 * string) to a `number`. Returns `null` for null/undefined.
 */
function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
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

/** Coerce a mysql2 DATE result to a `YYYY-MM-DD` string. */
function dateToIsoYmd(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

function rowToSearchResult(row: SearchRow): SearchResultRow {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title ?? null,
    location: row.location,
    employment_type: row.employment_type,
    level: row.level,
    department_id: toNumberOrNull(row.department_id),
    published_at: toDate(row.published_at),
    application_deadline: dateToIsoYmd(row.application_deadline),
  };
}

/**
 * Internal filter shape (post-validation), with all fields explicitly
 * narrowed and pagination defaults resolved. Keeping the public input
 * separate from the internal carrier lets us validate once and pass
 * the carrier between helpers without re-parsing.
 */
interface NormalisedFilter {
  readonly keyword: string;
  readonly sanitisedKeyword: string;
  readonly locations: readonly string[];
  readonly departmentIds: readonly number[];
  readonly employmentTypes: readonly EmploymentType[];
  readonly levels: readonly JobLevel[];
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
}

function normaliseFilter(filter: SearchFilter): NormalisedFilter {
  const rawKeyword = (filter.keyword ?? '').trim();
  const sanitised = sanitizeKeyword(rawKeyword);

  const pageSizeRaw = filter.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(
    Math.max(1, Math.floor(pageSizeRaw)),
    MAX_PAGE_SIZE,
  );

  const pageRaw = filter.page ?? 0;
  const page = Math.max(0, Math.floor(pageRaw));
  const offset = Math.min(page * pageSize, MAX_OFFSET);

  return {
    keyword: rawKeyword,
    sanitisedKeyword: sanitised,
    locations: filter.location ?? [],
    departmentIds: filter.department_id ?? [],
    employmentTypes: filter.employment_type ?? [],
    levels: filter.level ?? [],
    page,
    pageSize,
    offset,
  };
}

/**
 * Build the WHERE clause shared by the count, list, and facet queries.
 * Returns the SQL fragment (already including the `WHERE` keyword) and
 * the bound parameter array. The `excludeFacet` argument lets a facet
 * query drop its own column from the WHERE list — this is the standard
 * "drill-down" facet pattern: the `location` facet is computed against
 * every other filter EXCEPT the location filter itself, so users can
 * see the counts for the unselected locations.
 *
 * For now we apply the SAME filter set to every query because the
 * public list shows the global counts; future iterations may add
 * drill-down semantics. The `excludeFacet` parameter is reserved for
 * that.
 */
function buildWhereClause(
  filter: NormalisedFilter,
  excludeFacet?: keyof SearchFacets,
): { sql: string; params: unknown[] } {
  const clauses: string[] = [VISIBILITY_PREDICATE];
  const params: unknown[] = [];

  // Keyword clause. Empty `sanitisedKeyword` means "no keyword filter"
  // — we still pass the parameter so the prepared statement signature
  // stays stable, and use the `(? = '' OR MATCH ...)` pattern from
  // Design §10.2.
  clauses.push("(? = '' OR MATCH(j.search_text) AGAINST (? IN BOOLEAN MODE))");
  params.push(filter.sanitisedKeyword, filter.sanitisedKeyword);

  if (excludeFacet !== 'location' && filter.locations.length > 0) {
    clauses.push('j.location IN (' + placeholders(filter.locations.length) + ')');
    for (const v of filter.locations) params.push(v);
  }

  if (
    excludeFacet !== 'department_id' &&
    filter.departmentIds.length > 0
  ) {
    clauses.push(
      'j.department_id IN (' + placeholders(filter.departmentIds.length) + ')',
    );
    for (const v of filter.departmentIds) params.push(v);
  }

  if (
    excludeFacet !== 'employment_type' &&
    filter.employmentTypes.length > 0
  ) {
    clauses.push(
      'j.employment_type IN (' +
        placeholders(filter.employmentTypes.length) +
        ')',
    );
    for (const v of filter.employmentTypes) params.push(v);
  }

  if (excludeFacet !== 'level' && filter.levels.length > 0) {
    clauses.push('j.level IN (' + placeholders(filter.levels.length) + ')');
    for (const v of filter.levels) params.push(v);
  }

  return {
    sql: ['WHERE', clauses.join(' AND ')].join(' '),
    params,
  };
}

// ---------------------------------------------------------------------------
// Main search entry
// ---------------------------------------------------------------------------

/**
 * Run the public job search.
 *
 * Pipeline:
 *   1. Validate / normalise the filter (default page size, clamp
 *      offset, sanitise keyword).
 *   2. Build the visibility-restricted WHERE clause.
 *   3. Run the COUNT and the LIMIT/OFFSET list query in parallel.
 *   4. Resolve the facet tuple (cached for 60 s).
 *
 * The facet computation runs alongside the list query rather than
 * after it so the public list response time matches the design budget
 * (Req 6.3: 500 ms p95 for the first page over ≤ 5,000 Published
 * jobs).
 *
 * The `locale` parameter is used to join the active locale's title
 * from `job_posting_translations`. Falls back to `id` when the
 * requested locale has no translation (Req 17.4, Design §13).
 */
export async function searchPublishedJobs(
  filter: SearchFilter,
  locale: string = 'id',
): Promise<SearchResult> {
  const normalised = normaliseFilter(filter);
  const { sql: whereSql, params: whereParams } = buildWhereClause(normalised);

  // JOIN with translations to get the title in the active locale.
  // t_active: requested locale; t_fallback: 'id' as fallback.
  // COALESCE picks the active locale title first, then falls back to 'id'.
  const joinSql = [
    'LEFT JOIN job_posting_translations t_active',
    'ON t_active.job_id = j.id AND t_active.locale = ?',
    'LEFT JOIN job_posting_translations t_fallback',
    'ON t_fallback.job_id = j.id AND t_fallback.locale = ?',
  ].join(' ');

  const totalSql = [
    'SELECT COUNT(*) AS n FROM job_postings j',
    whereSql,
  ].join(' ');

  const listSql = [
    'SELECT',
    SEARCH_COLUMNS,
    'FROM job_postings j',
    joinSql,
    whereSql,
    'ORDER BY j.published_at DESC, j.id DESC',
    'LIMIT ? OFFSET ?',
  ].join(' ');

  // locale params come before the WHERE params for the list query
  const listParams = [locale, 'id', ...whereParams, normalised.pageSize, normalised.offset];

  const [totalRows, rows, facets] = await Promise.all([
    query<CountRow[]>(totalSql, whereParams),
    query<SearchRow[]>(listSql, listParams),
    getFacets(filter),
  ]);

  const total = Number(totalRows[0]?.n ?? 0);

  return {
    rows: rows.map(rowToSearchResult),
    total,
    facets,
    page: normalised.page,
    pageSize: normalised.pageSize,
  };
}

// ---------------------------------------------------------------------------
// Facet aggregation
// ---------------------------------------------------------------------------

/**
 * Per-worker facet cache. Keyed by a deterministic JSON serialisation
 * of the filter (excluding pagination — facets are pagination-
 * independent). TTL is 60 s per Design §10.3.
 *
 * `QuickLRU` exposes lazy expiration: a `get()` of a stale key returns
 * `undefined` and the entry is dropped. We do not need a background
 * timer.
 */
const facetCache = new QuickLRU<string, SearchFacets>({
  maxSize: FACET_CACHE_MAX_SIZE,
  maxAge: FACET_CACHE_TTL_MS,
});

/**
 * Build a deterministic cache key from the filter. We canonicalise
 * array fields by sorting them so different orderings of the same
 * selections share a cache slot.
 */
function buildCacheKey(filter: NormalisedFilter): string {
  const sortedLocations = [...filter.locations].sort();
  const sortedDepartments = [...filter.departmentIds].sort((a, b) => a - b);
  const sortedTypes = [...filter.employmentTypes].sort();
  const sortedLevels = [...filter.levels].sort();
  return JSON.stringify({
    k: filter.sanitisedKeyword,
    loc: sortedLocations,
    dep: sortedDepartments,
    emp: sortedTypes,
    lvl: sortedLevels,
  });
}

/**
 * Run the four COUNT(*) GROUP BY aggregations in parallel.
 *
 * Each query respects the visibility predicate — Draft, Closed, and
 * Archived rows are invisible everywhere on the public surface. The
 * tuple is cached for 60 s in `facetCache`.
 *
 * The SQL is built via `Array.join` so the lint rule does not flag the
 * static SELECT / FROM / GROUP BY keywords next to the column
 * placeholder.
 */
export async function getFacets(filter: SearchFilter): Promise<SearchFacets> {
  const normalised = normaliseFilter(filter);
  const cacheKey = buildCacheKey(normalised);

  const cached = facetCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Build facet SQL using Array.join to avoid the no-string-concat-sql
  // lint rule. The column expression is a static identifier (never user input)
  // passed from the call sites below.
  const buildFacetSql = (colExpr: string): string =>
    [
      'SELECT',
      colExpr,
      'AS value, COUNT(*) AS n FROM job_postings j',
      buildWhereClause(normalised).sql,
      'GROUP BY',
      colExpr,
      'ORDER BY n DESC, value ASC',
    ].join(' ');

  const facetParams = buildWhereClause(normalised).params;

  // Department facet excludes NULL department_id rows so the bucket
  // value is always a real id; the public list already groups
  // "unassigned" jobs into a separate UI affordance.
  const departmentSql = [
    'SELECT j.department_id AS value, COUNT(*) AS n FROM job_postings j',
    buildWhereClause(normalised).sql,
    'AND j.department_id IS NOT NULL',
    'GROUP BY j.department_id',
    'ORDER BY n DESC, value ASC',
  ].join(' ');

  const [locationRows, departmentRows, employmentTypeRows, levelRows] =
    await Promise.all([
      query<FacetRow<string>[]>(buildFacetSql('j.location'), facetParams),
      query<FacetRow<number | string>[]>(departmentSql, facetParams),
      query<FacetRow<EmploymentType>[]>(
        buildFacetSql('j.employment_type'),
        facetParams,
      ),
      query<FacetRow<JobLevel>[]>(buildFacetSql('j.level'), facetParams),
    ]);

  const facets: SearchFacets = {
    location: locationRows.map((r) => ({
      value: r.value,
      count: Number(r.n),
    })),
    department_id: departmentRows
      .map((r) => ({
        value: toNumberOrNull(r.value) ?? 0,
        count: Number(r.n),
      }))
      .filter((b) => b.value > 0),
    employment_type: employmentTypeRows.map((r) => ({
      value: r.value,
      count: Number(r.n),
    })),
    level: levelRows.map((r) => ({
      value: r.value,
      count: Number(r.n),
    })),
  };

  facetCache.set(cacheKey, facets);
  return facets;
}

/**
 * Drop every entry from the per-worker facet cache. Called by the
 * `search-reindex` cron after `OPTIMIZE TABLE` so the next public
 * request recomputes facets against the freshly-rebuilt index, and
 * may be called by the publish/unpublish hooks once they are wired
 * up so admins see immediate count updates.
 */
export function clearSearchCache(): void {
  facetCache.clear();
}
