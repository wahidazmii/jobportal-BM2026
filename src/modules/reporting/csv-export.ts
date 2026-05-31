/**
 * CSV export query for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 45.1
 * Design  : §16.3 (CSV export — row cap 10,000, column list)
 * Validates: Requirements 13.4, 13.5
 *
 * Public surface:
 *   - `ApplicationExportRow`          — typed shape of each row returned.
 *   - `getApplicationsForExport(jobId, scope?)` — SELECT up to 10,001 rows
 *     (to detect the cap) for the given job, optionally scoped to a set of
 *     department ids (Department_Head). Returns typed rows.
 *
 * SQL safety (Req 15.4, lint rule `local/no-string-concat-sql`):
 *   Every SQL fragment is assembled via `Array.join(' ')` — NO value is
 *   ever interpolated into the SQL text. Each bound value is passed as a
 *   `?` placeholder parameter to `query()` → `pool.execute` (server-side
 *   prepared statement). The optional department-scope IN clause is built
 *   by generating one `?` placeholder per department id and binding the
 *   ids as separate parameters.
 */

import { query, type RowDataPacket } from '../../infra/db.js';
import type { JobScope } from '../jobs/repo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row returned by {@link getApplicationsForExport}.
 * Mirrors the columns selected by the export query.
 */
export interface ApplicationExportRow {
  readonly id: number;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly stage: string;
  readonly appliedAt: Date;
  readonly cvFileId: number;
}

// ---------------------------------------------------------------------------
// Internal row shape from mysql2
// ---------------------------------------------------------------------------

interface ExportRawRow extends RowDataPacket {
  id: number | string;
  full_name: string;
  email: string;
  phone: string | null;
  stage: string;
  applied_at: Date | string;
  cv_file_id: number | string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a possibly-string DATETIME from mysql2 into a Date. */
function toDate(raw: Date | string | unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return new Date(raw);
  return new Date(0);
}

// ---------------------------------------------------------------------------
// getApplicationsForExport
// ---------------------------------------------------------------------------

/**
 * Fetch up to 10,001 application rows for the given job (to detect the
 * 10,000-row cap). The caller is responsible for checking
 * `rows.length > 10_000` and returning 422 before streaming.
 *
 * @param jobId  The `job_postings.id` to export.
 * @param scope  Optional Department_Head scope. When provided, adds
 *               `AND jp.department_id IN (?)` to restrict to the
 *               departments the caller is assigned to.
 */
export async function getApplicationsForExport(
  jobId: number,
  scope?: JobScope,
): Promise<ApplicationExportRow[]> {
  const params: unknown[] = [];

  // Base SELECT — columns match design §16.3 + Req 13.4.
  const parts = [
    'SELECT',
    'a.id,',
    'ap.full_name,',
    'u.email,',
    'ap.phone,',
    'a.stage,',
    'a.applied_at,',
    'a.cv_file_id',
    'FROM applications a',
    'JOIN applicants ap ON ap.user_id = a.applicant_user_id',
    'JOIN users u ON u.id = a.applicant_user_id',
    'JOIN job_postings jp ON jp.id = a.job_id',
    'WHERE a.job_id = ?',
  ];
  params.push(jobId);

  // Optional department scope for Department_Head (design §14.2).
  if (scope !== undefined && scope.departments.length > 0) {
    // Build one `?` placeholder per department id — no interpolation.
    const placeholders = scope.departments.map(() => '?').join(', ');
    parts.push(['AND jp.department_id IN (', placeholders, ')'].join(''));
    for (const deptId of scope.departments) {
      params.push(deptId);
    }
  }

  parts.push('ORDER BY a.applied_at DESC');
  // Fetch 10,001 so the caller can detect the cap without a separate COUNT.
  parts.push('LIMIT 10001');

  const sql = parts.join(' ');
  const rows = await query<ExportRawRow[]>(sql, params);

  return rows.map((row) => ({
    id: Number(row.id),
    fullName: String(row.full_name ?? ''),
    email: String(row.email ?? ''),
    phone: row.phone != null ? String(row.phone) : null,
    stage: String(row.stage ?? ''),
    appliedAt: toDate(row.applied_at),
    cvFileId: Number(row.cv_file_id),
  }));
}
