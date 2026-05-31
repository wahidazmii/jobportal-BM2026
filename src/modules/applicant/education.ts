/**
 * Applicant education CRUD service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 16.2
 * Design  : §6 Applicant_Area
 * Validates: Requirements 4.2
 *
 * Public surface:
 *   - `educationSchema`               — zod schema validating raw form input
 *                                        for both create and update; mirrors
 *                                        the NOT NULL columns in
 *                                        `applicant_education`
 *                                        (migrations/0002_profile.sql).
 *   - `EducationInput`                — type inferred from `educationSchema`.
 *   - `EducationRecord`               — typed `applicant_education` row
 *                                        returned by the read helpers.
 *   - `MAX_EDUCATION_ENTRIES = 20`    — cap from task 16.2.
 *   - `EducationCapError`             — thrown when an INSERT would push
 *                                        the per-applicant count past the
 *                                        cap. The route layer translates
 *                                        this to HTTP 422.
 *   - `EducationNotFoundError`        — thrown when the requested row id
 *                                        either does not exist or belongs
 *                                        to a different applicant. Both
 *                                        branches collapse to the same
 *                                        error so the API never leaks
 *                                        the existence of another user's
 *                                        rows (Req 11.5 / Req 15.2 spirit).
 *   - `listEducation(userId)`         — load every education entry for
 *                                        the applicant, ordered by
 *                                        `start_date DESC, id DESC`.
 *   - `findEducationById(userId, id)` — load a single entry scoped to the
 *                                        owner; returns `null` when the
 *                                        row is missing or owned by
 *                                        someone else.
 *   - `createEducation(userId, raw)`  — validate + INSERT; enforces the
 *                                        20-entry cap inside the same
 *                                        transaction so two concurrent
 *                                        POSTs cannot both squeeze a 21st
 *                                        row in.
 *   - `updateEducation(userId, id,
 *                      raw)`          — validate + UPDATE; scoped to the
 *                                        owner.
 *   - `deleteEducation(userId, id)`   — DELETE scoped to the owner.
 *
 * Validation contract (task 16.2):
 *   - `institution` : trimmed string, 1..150 chars (matches column).
 *   - `degree`      : trimmed string, 1..100 chars (matches column).
 *   - `field`       : trimmed string, 1..100 chars (matches column).
 *   - `start_date`  : required `YYYY-MM-DD` and `<=` today (UTC). The
 *                     "<= today" rule mirrors the spec's
 *                     "start_date <= today" guard so a user cannot
 *                     declare an education entry beginning in the
 *                     future.
 *   - `end_date`    : optional `YYYY-MM-DD`. When `in_progress=true`,
 *                     `end_date` MUST be null/empty (Req 4.2 + the
 *                     `chk_edu_progress` CHECK in migration 0002).
 *                     When `in_progress=false`, `end_date` MAY still be
 *                     null (e.g. unknown completion date — the CHECK
 *                     constraint allows this). When both are provided,
 *                     `end_date >= start_date`.
 *   - `in_progress` : boolean (defaults false).
 *   - `gpa`         : optional decimal in `[0.00, 4.00]`. Stored as a
 *                     `DECIMAL(3,2)` so we accept up to 2 decimal places
 *                     and round to that precision before persisting.
 *
 * Why the cap is enforced inside the transaction:
 *   - A naïve "SELECT COUNT then INSERT" race-checks loses to two
 *     concurrent requests both reading 19, both inserting → 21. We hold
 *     a connection, BEGIN, SELECT COUNT(*) ... FOR UPDATE on the
 *     applicant's rows, THEN INSERT. The lock serialises the two
 *     branches so the second request sees the freshly-inserted row and
 *     correctly rejects.
 *   - Authorization is also colocated: the WHERE clause on every
 *     UPDATE/DELETE includes `applicant_user_id = ?`, sourced from the
 *     authenticated session — never from the URL or form body. This
 *     prevents IDOR (Insecure Direct Object Reference) attacks.
 */

import { z } from 'zod';

import {
  query,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum education entries per applicant per task 16.2. */
export const MAX_EDUCATION_ENTRIES = 20;

/** Inclusive lower bound for GPA. */
export const GPA_MIN = 0;

/** Inclusive upper bound for GPA. */
export const GPA_MAX = 4;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `createEducation` when the applicant already has the
 * maximum allowed entries. The route layer maps this to HTTP 422.
 */
export class EducationCapError extends Error {
  readonly code = 'education_cap_reached' as const;
  constructor(public readonly limit: number) {
    super(
      `Education entries cap reached (${limit}). ` +
        `Remove an existing entry before adding a new one.`,
    );
    this.name = 'EducationCapError';
  }
}

/**
 * Thrown by `updateEducation` and `deleteEducation` when the row id
 * either does not exist or is owned by a different applicant. We do
 * NOT distinguish between "missing" and "not yours" so the API never
 * leaks the existence of other users' rows.
 */
export class EducationNotFoundError extends Error {
  readonly code = 'education_not_found' as const;
  constructor(public readonly id: number) {
    super(`Education entry ${id} not found`);
    this.name = 'EducationNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` shape check. We use a strict regex rather than relying on
 * `Date.parse` so ambiguous formats (`2024/01/01`, `01-01-2024`) get a
 * helpful field error instead of being silently accepted.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `YYYY-MM-DD` string into a UTC-midnight Date for comparison.
 * Returns `null` when the value is empty or structurally invalid.
 */
function parseDate(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!DATE_REGEX.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * UTC midnight of "today" expressed in milliseconds. Computed at parse
 * time so the cutoff stays correct as the wall clock advances. We
 * compare against UTC so a user in a positive timezone (e.g. WIB +07:00)
 * who picks "today" in local time still sees their input accepted: the
 * regex result `YYYY-MM-DD` is interpreted as UTC midnight, and the
 * cutoff is also UTC midnight, so values up to and including today
 * pass.
 */
function todayUtcMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

const trimmedShortText = (max: number, label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, { message: `${label} is required` })
    .max(max, { message: `${label} must be at most ${max} characters` });

const startDateSchema = z
  .string({ required_error: 'Start date is required' })
  .trim()
  .min(1, { message: 'Start date is required' })
  .refine((v) => DATE_REGEX.test(v), {
    message: 'Start date must be in YYYY-MM-DD format',
  })
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
    message: 'Start date is not a valid calendar date',
  })
  .refine(
    (v) => {
      const ms = Date.parse(`${v}T00:00:00Z`);
      return !Number.isNaN(ms) && ms <= todayUtcMs();
    },
    { message: 'Start date cannot be in the future' },
  );

const endDateSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v))
  .refine((v) => v === null || DATE_REGEX.test(v), {
    message: 'End date must be in YYYY-MM-DD format',
  })
  .refine((v) => v === null || !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
    message: 'End date is not a valid calendar date',
  });

/**
 * Coerce a checkbox-style boolean. Form posts emit `'on'` for checked
 * boxes and omit the field entirely for unchecked. JS-driven submissions
 * may send `'true'`/`'false'` or actual booleans.
 */
const inProgressSchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v): boolean => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    const lowered = v.trim().toLowerCase();
    return lowered === 'on' || lowered === 'true' || lowered === '1';
  });

/**
 * GPA in `[0.00, 4.00]`. We accept either a number or a string (form
 * posts always arrive as strings) and snap to 2 decimal places to match
 * the column's `DECIMAL(3,2)` precision. An empty string normalises to
 * `null` so callers can transmit "no GPA supplied" without inventing a
 * sentinel value.
 */
const gpaSchema = z
  .union([z.number(), z.string()])
  .optional()
  .transform((v, ctx): number | null => {
    if (v === undefined) return null;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'GPA must be a number',
        });
        return null;
      }
      v = n;
    }
    if (!Number.isFinite(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GPA must be a finite number',
      });
      return null;
    }
    if (v < GPA_MIN || v > GPA_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `GPA must be between ${GPA_MIN.toFixed(2)} and ${GPA_MAX.toFixed(2)}`,
      });
      return null;
    }
    // Snap to 2 decimal places so JS float drift (e.g. 3.5000000004) does
    // not propagate into the database. `Math.round(v * 100) / 100` is
    // sufficient because the input range is bounded and small.
    return Math.round(v * 100) / 100;
  });

/**
 * Public education schema. `.superRefine` enforces the cross-field
 * invariants that match the SQL `chk_edu_progress` CHECK and the
 * `end_date >= start_date` rule from Req 4.2.
 */
export const educationSchema = z
  .object({
    institution: trimmedShortText(150, 'Institution'),
    degree: trimmedShortText(100, 'Degree'),
    field: trimmedShortText(100, 'Field of study'),
    start_date: startDateSchema,
    end_date: endDateSchema,
    in_progress: inProgressSchema,
    gpa: gpaSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    // in_progress=true ⇒ end_date must be null (matches chk_edu_progress).
    if (value.in_progress && value.end_date !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_date'],
        message:
          'End date must be empty when "in progress" is checked',
      });
    }

    // end_date present ⇒ end_date >= start_date.
    if (value.end_date !== null) {
      const start = parseDate(value.start_date);
      const end = parseDate(value.end_date);
      if (start !== null && end !== null && end.getTime() < start.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end_date'],
          message: 'End date must be on or after start date',
        });
      }
    }
  });

/** Strongly-typed input shape after validation. */
export type EducationInput = z.infer<typeof educationSchema>;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Public shape of an `applicant_education` row, with `Date`-typed
 * columns normalised to ISO `YYYY-MM-DD` strings for direct rendering
 * into form inputs.
 */
export interface EducationRecord {
  readonly id: number;
  readonly applicant_user_id: number;
  readonly institution: string;
  readonly degree: string;
  readonly field: string;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly in_progress: boolean;
  readonly gpa: number | null;
}

interface EducationRow extends RowDataPacket {
  id: number | string;
  applicant_user_id: number | string;
  institution: string;
  degree: string;
  field: string;
  start_date: Date | string;
  end_date: Date | string | null;
  in_progress: number;
  gpa: number | string | null;
}

/**
 * Convert a mysql2 DATE result to a stable `YYYY-MM-DD` string. mysql2
 * returns DATE columns as `Date` objects by default; we slice the ISO
 * representation so the value can flow directly into a
 * `<input type="date">` without timezone surprise.
 */
function dateToIsoYmd(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

/**
 * Coerce mysql2's GPA column. The pool's `decimalNumbers: true` setting
 * normally returns DECIMAL columns as `number`, but some driver paths
 * still return strings — guard both.
 */
function decimalToNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToRecord(row: EducationRow): EducationRecord {
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    institution: row.institution,
    degree: row.degree,
    field: row.field,
    start_date: dateToIsoYmd(row.start_date) ?? '',
    end_date: dateToIsoYmd(row.end_date),
    in_progress: row.in_progress === 1,
    gpa: decimalToNumber(row.gpa),
  };
}

const SELECT_LIST_SQL =
  'SELECT id, applicant_user_id, institution, degree, field, ' +
  '  start_date, end_date, in_progress, gpa ' +
  'FROM applicant_education ' +
  'WHERE applicant_user_id = ? ' +
  'ORDER BY start_date DESC, id DESC';

const SELECT_BY_ID_SQL =
  'SELECT id, applicant_user_id, institution, degree, field, ' +
  '  start_date, end_date, in_progress, gpa ' +
  'FROM applicant_education ' +
  'WHERE id = ? AND applicant_user_id = ? ' +
  'LIMIT 1';

const COUNT_FOR_UPDATE_SQL =
  'SELECT COUNT(*) AS n FROM applicant_education ' +
  'WHERE applicant_user_id = ? FOR UPDATE';

const INSERT_SQL =
  'INSERT INTO applicant_education ' +
  '  (applicant_user_id, institution, degree, field, start_date, end_date, in_progress, gpa) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

const UPDATE_SQL =
  'UPDATE applicant_education SET ' +
  '  institution = ?, ' +
  '  degree = ?, ' +
  '  field = ?, ' +
  '  start_date = ?, ' +
  '  end_date = ?, ' +
  '  in_progress = ?, ' +
  '  gpa = ? ' +
  'WHERE id = ? AND applicant_user_id = ?';

const DELETE_SQL =
  'DELETE FROM applicant_education WHERE id = ? AND applicant_user_id = ?';

/**
 * Load every education entry for `userId`, ordered by `start_date DESC,
 * id DESC` so the most recent / most recently created entry surfaces
 * first.
 */
export async function listEducation(userId: number): Promise<EducationRecord[]> {
  const rows = await query<EducationRow[]>(SELECT_LIST_SQL, [userId]);
  return rows.map(rowToRecord);
}

/**
 * Load a single entry scoped to the owner. Returns `null` when the row
 * is missing or owned by a different applicant.
 */
export async function findEducationById(
  userId: number,
  id: number,
): Promise<EducationRecord | null> {
  const rows = await query<EducationRow[]>(SELECT_BY_ID_SQL, [id, userId]);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Map a validated `EducationInput` to the positional parameter array
 * for `INSERT`. Booleans are sent as 0/1 to match the column's
 * `TINYINT(1)` declaration and avoid implicit casts.
 */
function inputToInsertParams(userId: number, input: EducationInput): unknown[] {
  return [
    userId,
    input.institution,
    input.degree,
    input.field,
    input.start_date,
    input.end_date, // already null-normalised
    input.in_progress ? 1 : 0,
    input.gpa, // already null-normalised
  ];
}

function inputToUpdateParams(
  userId: number,
  id: number,
  input: EducationInput,
): unknown[] {
  return [
    input.institution,
    input.degree,
    input.field,
    input.start_date,
    input.end_date,
    input.in_progress ? 1 : 0,
    input.gpa,
    id,
    userId,
  ];
}

/**
 * Create a new education entry for the applicant.
 *
 * - Validates `rawInput` via `educationSchema`. Throws `ZodError` on
 *   field-level failures.
 * - Inside a single transaction:
 *     1. `SELECT COUNT(*) ... FOR UPDATE` to lock the applicant's rows.
 *     2. If the count is already at or above the cap, throws
 *        `EducationCapError` (route layer maps to HTTP 422).
 *     3. Otherwise INSERTs the row and commits.
 *
 * Returns the newly inserted record (re-read from the DB so callers
 * receive the canonical row, including the auto-increment id).
 */
export async function createEducation(
  userId: number,
  rawInput: unknown,
): Promise<EducationRecord> {
  const input = educationSchema.parse(rawInput);

  return withTransaction(async (conn: PoolConnection) => {
    const [countRows] = await conn.execute<RowDataPacket[]>(
      COUNT_FOR_UPDATE_SQL,
      [userId],
    );
    const current = Number((countRows[0] as { n?: number | string } | undefined)?.n ?? 0);
    if (current >= MAX_EDUCATION_ENTRIES) {
      throw new EducationCapError(MAX_EDUCATION_ENTRIES);
    }

    const [result] = await conn.execute<ResultSetHeader>(
      INSERT_SQL,
      inputToInsertParams(userId, input),
    );
    const insertedId = result.insertId;

    const [rows] = await conn.execute<EducationRow[]>(SELECT_BY_ID_SQL, [
      insertedId,
      userId,
    ]);
    const row = rows[0];
    if (!row) {
      // Should never happen — we just inserted the row inside the same
      // transaction. Defend against driver weirdness anyway.
      throw new Error('education: failed to read back inserted row');
    }

    logger.info(
      { event: 'education_create', user_id: userId, education_id: insertedId },
      'applicant.education: row created',
    );

    return rowToRecord(row);
  });
}

/**
 * Update an existing education entry scoped to the owner.
 *
 * Throws:
 *   - `ZodError` on validation failure.
 *   - `EducationNotFoundError` when no row matches the (id, userId)
 *     pair (either the row was deleted or never belonged to this user).
 */
export async function updateEducation(
  userId: number,
  id: number,
  rawInput: unknown,
): Promise<EducationRecord> {
  const input = educationSchema.parse(rawInput);

  const result = await query<ResultSetHeader>(
    UPDATE_SQL,
    inputToUpdateParams(userId, id, input),
  );

  if (result.affectedRows === 0) {
    throw new EducationNotFoundError(id);
  }

  // Re-read so callers see the canonical row (including any column
  // defaults the UPDATE left untouched).
  const after = await findEducationById(userId, id);
  if (after === null) {
    // Race: row was deleted between UPDATE and SELECT. Treat as
    // not-found so the caller can re-render the list.
    throw new EducationNotFoundError(id);
  }

  logger.info(
    { event: 'education_update', user_id: userId, education_id: id },
    'applicant.education: row updated',
  );

  return after;
}

/**
 * Delete an education entry scoped to the owner.
 *
 * Throws `EducationNotFoundError` when no row matches the (id, userId)
 * pair. Idempotency is the caller's choice: if you want "delete is OK
 * even if already gone", catch and ignore the error in the route.
 */
export async function deleteEducation(
  userId: number,
  id: number,
): Promise<void> {
  const result = await query<ResultSetHeader>(DELETE_SQL, [id, userId]);
  if (result.affectedRows === 0) {
    throw new EducationNotFoundError(id);
  }
  logger.info(
    { event: 'education_delete', user_id: userId, education_id: id },
    'applicant.education: row deleted',
  );
}
