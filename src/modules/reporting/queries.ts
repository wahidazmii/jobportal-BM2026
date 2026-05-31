/**
 * Reporting read queries for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 44.1
 * Design  : §16.1 (dashboard metrics), §16.2 (reporting queries)
 * Validates: Requirements 13.1, 13.2, 13.3
 *
 * Scope:
 *   This module is intentionally **read-only**. It powers the Admin_Console
 *   endpoint `GET /admin/reports` (HR + Super_Admin, gated by
 *   `requirePolicy('report.read')`). All queries run in parallel via
 *   `Promise.all` to minimise latency.
 *
 * SQL safety (Req 15.4, lint rule `local/no-string-concat-sql`):
 *   Every SQL statement is assembled via `Array.join(' ')` — NO value is
 *   ever interpolated into the SQL text. Each bound value is passed as a
 *   `?` placeholder parameter to `query()` → `pool.execute` (server-side
 *   prepared statement).
 *
 * Date defaults:
 *   When `filter.dateFrom` / `filter.dateTo` are absent the queries default
 *   to the last 30 days so the dashboard always shows meaningful data on
 *   first load.
 */

import { query, type RowDataPacket } from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Optional date-range filter accepted by {@link getReportSummary}.
 * Both fields are YYYY-MM-DD strings. `null` / `undefined` / empty string
 * mean "use the default last-30-days window".
 */
export interface ReportFilter {
  readonly dateFrom?: string | null;
  readonly dateTo?: string | null;
}

/** One row from the source-distribution query. */
export interface SourceDistributionRow {
  readonly source: string;
  readonly count: number;
}

/**
 * Aggregated report summary returned by {@link getReportSummary}.
 * Conversion ratios are in the range [0, 1] or `null` when the denominator
 * is zero (no data in the selected range).
 */
export interface ReportSummary {
  /** Total job_postings with status = 'Published'. */
  readonly activeJobsCount: number;
  /** Applications with applied_at in the selected date range. */
  readonly applicationsInRange: number;
  /**
   * Fraction of applications in range that ever reached stage
   * Interview, Offer, Hired, or Rejected (i.e. passed screening).
   * `null` when `applicationsInRange` is 0.
   */
  readonly conversionAppliedToInterview: number | null;
  /**
   * Fraction of applications that reached Interview (or beyond) that
   * ultimately reached stage Hired.
   * `null` when no applications reached Interview.
   */
  readonly conversionInterviewToHired: number | null;
  /**
   * Average hours between `applied_at` and `hired_at` for applications
   * hired within the date range. `null` when no hired applications exist.
   */
  readonly avgTimeToHireHours: number | null;
  /** Applications grouped by `source`, ordered by count descending. */
  readonly sourceDistribution: readonly SourceDistributionRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Treat empty / whitespace-only strings as "no value". */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the effective date range from the filter, defaulting to the
 * last 30 days when either bound is absent.
 */
function resolveDateRange(filter: ReportFilter): {
  readonly dateFrom: string;
  readonly dateTo: string;
} {
  const now = new Date();
  const defaultTo = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return {
    dateFrom: nonEmpty(filter.dateFrom) ?? defaultFrom,
    dateTo: nonEmpty(filter.dateTo) ?? defaultTo,
  };
}

function toNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Individual query functions
// ---------------------------------------------------------------------------

/** COUNT of Published job_postings. */
async function queryActiveJobsCount(): Promise<number> {
  const sql = [
    'SELECT COUNT(*) AS n',
    'FROM job_postings',
    "WHERE status = 'Published'",
  ].join(' ');
  const rows = await query<RowDataPacket[]>(sql, []);
  return Number((rows[0] as RowDataPacket | undefined)?.n ?? 0);
}

/** COUNT of applications with applied_at in [dateFrom, dateTo]. */
async function queryApplicationsInRange(
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const sql = [
    'SELECT COUNT(*) AS n',
    'FROM applications',
    'WHERE applied_at BETWEEN ? AND ?',
  ].join(' ');
  const rows = await query<RowDataPacket[]>(sql, [dateFrom, dateTo]);
  return Number((rows[0] as RowDataPacket | undefined)?.n ?? 0);
}

/**
 * Conversion Applied → Interview.
 *
 * Numerator  : applications in range that ever reached stage IN
 *              ('Interview', 'Offer', 'Hired', 'Rejected').
 * Denominator: total applications in range.
 *
 * Returns `null` when denominator is 0.
 */
async function queryConversionAppliedToInterview(
  dateFrom: string,
  dateTo: string,
  totalInRange: number,
): Promise<number | null> {
  if (totalInRange === 0) return null;

  const sql = [
    'SELECT COUNT(DISTINCT a.id) AS n',
    'FROM applications a',
    'WHERE a.applied_at BETWEEN ? AND ?',
    "AND a.stage IN ('Interview', 'Offer', 'Hired', 'Rejected')",
  ].join(' ');
  const rows = await query<RowDataPacket[]>(sql, [dateFrom, dateTo]);
  const reached = Number((rows[0] as RowDataPacket | undefined)?.n ?? 0);
  return reached / totalInRange;
}

/**
 * Conversion Interview → Hired.
 *
 * Numerator  : applications in range with stage = 'Hired'.
 * Denominator: applications in range that reached stage IN
 *              ('Interview', 'Offer', 'Hired', 'Rejected').
 *
 * Returns `null` when denominator is 0.
 */
async function queryConversionInterviewToHired(
  dateFrom: string,
  dateTo: string,
): Promise<number | null> {
  // Denominator: reached Interview or beyond.
  const denomSql = [
    'SELECT COUNT(*) AS n',
    'FROM applications',
    'WHERE applied_at BETWEEN ? AND ?',
    "AND stage IN ('Interview', 'Offer', 'Hired', 'Rejected')",
  ].join(' ');
  const denomRows = await query<RowDataPacket[]>(denomSql, [dateFrom, dateTo]);
  const denom = Number((denomRows[0] as RowDataPacket | undefined)?.n ?? 0);
  if (denom === 0) return null;

  // Numerator: reached Hired.
  const numSql = [
    'SELECT COUNT(*) AS n',
    'FROM applications',
    'WHERE applied_at BETWEEN ? AND ?',
    "AND stage = 'Hired'",
  ].join(' ');
  const numRows = await query<RowDataPacket[]>(numSql, [dateFrom, dateTo]);
  const num = Number((numRows[0] as RowDataPacket | undefined)?.n ?? 0);
  return num / denom;
}

/**
 * Average TIMESTAMPDIFF(HOUR, applied_at, hired_at) for applications
 * hired within the date range.
 */
async function queryAvgTimeToHireHours(
  dateFrom: string,
  dateTo: string,
): Promise<number | null> {
  const sql = [
    'SELECT AVG(TIMESTAMPDIFF(HOUR, applied_at, hired_at)) AS avg_hours',
    'FROM applications',
    'WHERE hired_at IS NOT NULL',
    'AND applied_at BETWEEN ? AND ?',
  ].join(' ');
  const rows = await query<RowDataPacket[]>(sql, [dateFrom, dateTo]);
  return toNumberOrNull((rows[0] as RowDataPacket | undefined)?.avg_hours);
}

/**
 * Source distribution: GROUP BY source, ORDER BY count DESC.
 */
async function querySourceDistribution(
  dateFrom: string,
  dateTo: string,
): Promise<readonly SourceDistributionRow[]> {
  const sql = [
    'SELECT source, COUNT(*) AS cnt',
    'FROM applications',
    'WHERE applied_at BETWEEN ? AND ?',
    'GROUP BY source',
    'ORDER BY cnt DESC',
  ].join(' ');
  const rows = await query<RowDataPacket[]>(sql, [dateFrom, dateTo]);
  return rows.map((row) => ({
    source: String(row.source ?? ''),
    count: Number(row.cnt ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// getReportSummary
// ---------------------------------------------------------------------------

/**
 * Fetch all reporting metrics in parallel and return a typed
 * {@link ReportSummary}.
 *
 * All queries share the same resolved date range. The conversion queries
 * depend on `applicationsInRange` (denominator guard), so that value is
 * fetched first; the remaining five queries run in parallel.
 */
export async function getReportSummary(
  filter: ReportFilter = {},
): Promise<ReportSummary> {
  const { dateFrom, dateTo } = resolveDateRange(filter);

  // Fetch active-jobs count and applications-in-range in parallel first
  // (the conversion query needs the latter as a denominator guard).
  const [activeJobsCount, applicationsInRange] = await Promise.all([
    queryActiveJobsCount(),
    queryApplicationsInRange(dateFrom, dateTo),
  ]);

  // Remaining queries run in parallel.
  const [
    conversionAppliedToInterview,
    conversionInterviewToHired,
    avgTimeToHireHours,
    sourceDistribution,
  ] = await Promise.all([
    queryConversionAppliedToInterview(dateFrom, dateTo, applicationsInRange),
    queryConversionInterviewToHired(dateFrom, dateTo),
    queryAvgTimeToHireHours(dateFrom, dateTo),
    querySourceDistribution(dateFrom, dateTo),
  ]);

  return {
    activeJobsCount,
    applicationsInRange,
    conversionAppliedToInterview,
    conversionInterviewToHired,
    avgTimeToHireHours,
    sourceDistribution,
  };
}
