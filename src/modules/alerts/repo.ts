/**
 * Job alert repository for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 33.1
 * Design  : §6 Applicant_Area, §7.2 (job_alerts DDL), §11.3 (alert-digest cron)
 * Validates: Requirements 7.1
 *
 * Owns every SQL statement that touches the `job_alerts` table
 * (migration 0005). The column shape follows design §7.2 exactly:
 *
 *     id, applicant_user_id, keyword VARCHAR(100) NULL,
 *     locations JSON NULL, departments JSON NULL,
 *     frequency ENUM('Daily','Weekly'), last_evaluated_at, created_at
 *
 * There are intentionally NO `employment_types` / `levels` /
 * `updated_at` columns — see the migration header for the rationale.
 *
 * JSON column contract (read back into arrays):
 *   - `locations`   : array of city strings (e.g. ["Jakarta","Surabaya"]).
 *   - `departments` : array of `departments.id` numbers (e.g. [3,7]).
 *   NULL on either column means "no filter on that axis". The read
 *   helpers parse the JSON columns into real arrays so callers never
 *   touch the raw string / driver-native value.
 *
 * The "max 10 alerts per applicant" cap is an APP-LEVEL guard (design
 * §7.2 "app-level guard"); `countForApplicant` exposes the locked count
 * the service uses inside the create transaction.
 *
 * Authorization: every read / mutate helper that targets a single alert
 * is scoped to `applicant_user_id` so a malicious id in the URL can
 * never reach another applicant's row (IDOR guard).
 */

import {
  query,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed `frequency` ENUM values (design §7.2). */
export type AlertFrequency = 'Daily' | 'Weekly';

/**
 * Public shape of a `job_alerts` row. The JSON columns are parsed into
 * real arrays (or `null` for "no filter"); `last_evaluated_at` /
 * `created_at` are normalised to `Date | null`.
 */
export interface AlertRow {
  readonly id: number;
  readonly applicant_user_id: number;
  readonly keyword: string | null;
  readonly locations: string[] | null;
  readonly departments: number[] | null;
  readonly frequency: AlertFrequency;
  readonly last_evaluated_at: Date | null;
  readonly created_at: Date;
}

/** Validated input accepted by {@link insertAlert}. */
export interface AlertInsertInput {
  readonly applicantUserId: number;
  readonly keyword: string | null;
  readonly locations: string[] | null;
  readonly departments: number[] | null;
  readonly frequency: AlertFrequency;
}

interface AlertDbRow extends RowDataPacket {
  id: number | string;
  applicant_user_id: number | string;
  keyword: string | null;
  locations: string | unknown[] | null;
  departments: string | unknown[] | null;
  frequency: AlertFrequency;
  last_evaluated_at: Date | string | null;
  created_at: Date | string | null;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSON column value into an array. mysql2 may return a JSON
 * column either as an already-parsed value (its default for the `JSON`
 * type) or as a raw string depending on driver configuration — handle
 * both. Anything that does not parse into an array collapses to `null`
 * ("no filter") so a corrupt row never crashes the digest evaluator.
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

function rowToAlert(row: AlertDbRow): AlertRow {
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    keyword: row.keyword ?? null,
    locations: parseLocations(row.locations),
    departments: parseDepartments(row.departments),
    frequency: row.frequency,
    last_evaluated_at: toDateOrNull(row.last_evaluated_at),
    // created_at is NOT NULL with a default; fall back to "now" only if
    // the driver ever hands back an unparseable value.
    created_at: toDateOrNull(row.created_at) ?? new Date(),
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SELECT_LIST_SQL =
  'SELECT id, applicant_user_id, keyword, locations, departments, ' +
  '  frequency, last_evaluated_at, created_at ' +
  'FROM job_alerts ' +
  'WHERE applicant_user_id = ? ' +
  'ORDER BY created_at DESC, id DESC';

const SELECT_BY_ID_SQL =
  'SELECT id, applicant_user_id, keyword, locations, departments, ' +
  '  frequency, last_evaluated_at, created_at ' +
  'FROM job_alerts ' +
  'WHERE id = ? AND applicant_user_id = ? ' +
  'LIMIT 1';

const COUNT_FOR_UPDATE_SQL =
  'SELECT COUNT(*) AS n FROM job_alerts ' +
  'WHERE applicant_user_id = ? FOR UPDATE';

const INSERT_SQL =
  'INSERT INTO job_alerts ' +
  '  (applicant_user_id, keyword, locations, departments, frequency) ' +
  'VALUES (?, ?, ?, ?, ?)';

const DELETE_SQL =
  'DELETE FROM job_alerts WHERE id = ? AND applicant_user_id = ?';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List every alert owned by `applicantUserId`, newest first. The JSON
 * columns are parsed into arrays before returning.
 */
export async function listForApplicant(
  applicantUserId: number,
): Promise<AlertRow[]> {
  const rows = await query<AlertDbRow[]>(SELECT_LIST_SQL, [applicantUserId]);
  return rows.map(rowToAlert);
}

/**
 * Count the applicant's alerts inside the supplied transaction
 * connection, holding the rows under `FOR UPDATE` so the cap check and
 * the subsequent INSERT serialise against a concurrent create. Always
 * call this through `withTransaction` so the lock is meaningful.
 */
export async function countForApplicant(
  conn: PoolConnection,
  applicantUserId: number,
): Promise<number> {
  const [rows] = await conn.execute<RowDataPacket[]>(COUNT_FOR_UPDATE_SQL, [
    applicantUserId,
  ]);
  const n = (rows[0] as { n?: number | string } | undefined)?.n ?? 0;
  return Number(n);
}

/**
 * Load a single alert scoped to its owner. Returns `null` when the row
 * is missing or belongs to a different applicant (the two cases are
 * intentionally indistinguishable so the API never leaks the existence
 * of another user's row).
 */
export async function findByIdForApplicant(
  applicantUserId: number,
  id: number,
): Promise<AlertRow | null> {
  const rows = await query<AlertDbRow[]>(SELECT_BY_ID_SQL, [
    id,
    applicantUserId,
  ]);
  const row = rows[0];
  return row ? rowToAlert(row) : null;
}

/**
 * Serialise the `locations` / `departments` arrays to JSON for storage.
 * `null` (or an empty array) is stored as SQL NULL so the digest
 * evaluator treats it as "no filter on that axis".
 */
function serialiseJsonColumn(value: readonly unknown[] | null): string | null {
  if (value === null || value.length === 0) return null;
  return JSON.stringify(value);
}

/**
 * Insert a new alert. Intended to be called from inside the service's
 * create transaction (right after the cap check). Returns the freshly
 * inserted row re-read through {@link findByIdForApplicant} so callers
 * receive the canonical shape, including the auto-increment id and the
 * server-assigned `created_at`.
 */
export async function insertAlert(
  input: AlertInsertInput,
  conn?: PoolConnection,
): Promise<AlertRow> {
  const params = [
    input.applicantUserId,
    input.keyword,
    serialiseJsonColumn(input.locations),
    serialiseJsonColumn(input.departments),
    input.frequency,
  ];

  let insertedId: number;
  if (conn) {
    const [result] = await conn.execute<ResultSetHeader>(INSERT_SQL, params);
    insertedId = result.insertId;
    const [rows] = await conn.execute<AlertDbRow[]>(SELECT_BY_ID_SQL, [
      insertedId,
      input.applicantUserId,
    ]);
    const row = rows[0];
    if (!row) {
      throw new Error('alerts: failed to read back inserted row');
    }
    return rowToAlert(row);
  }

  const result = await query<ResultSetHeader>(INSERT_SQL, params);
  insertedId = result.insertId;
  const after = await findByIdForApplicant(input.applicantUserId, insertedId);
  if (after === null) {
    throw new Error('alerts: failed to read back inserted row');
  }
  return after;
}

/**
 * Delete an alert scoped to its owner. Returns `true` when a row was
 * removed, `false` when nothing matched the `(id, applicantUserId)`
 * pair (missing or not-owned). Owner scoping lives in the WHERE clause
 * so a non-owned id is a no-op rather than a cross-tenant delete.
 */
export async function deleteAlert(
  applicantUserId: number,
  id: number,
): Promise<boolean> {
  const result = await query<ResultSetHeader>(DELETE_SQL, [id, applicantUserId]);
  return result.affectedRows > 0;
}
