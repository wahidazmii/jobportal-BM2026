/**
 * Applicant work-experience CRUD service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 16.3
 * Design  : §6 Applicant_Area
 * Validates: Requirements 4.3
 *
 * Public surface:
 *   - `experienceSchema`              — zod schema validating raw form
 *                                        input for both create and
 *                                        update; mirrors the NOT NULL
 *                                        columns of `applicant_experience`
 *                                        (migrations/0002_profile.sql).
 *   - `ExperienceInput`               — type inferred from
 *                                        `experienceSchema`.
 *   - `ExperienceRecord`              — typed `applicant_experience` row
 *                                        returned by the read helpers.
 *   - `EMPLOYMENT_TYPES`              — readonly tuple of the five enum
 *                                        values declared in the DDL
 *                                        (full-time, part-time, contract,
 *                                        internship, freelance).
 *   - `MAX_EXPERIENCE_ENTRIES = 30`   — cap from task 16.3.
 *   - `ExperienceCapError`            — thrown when an INSERT would push
 *                                        the per-applicant count past the
 *                                        cap; the route layer maps this to
 *                                        HTTP 422.
 *   - `ExperienceNotFoundError`       — thrown when the requested row id
 *                                        either does not exist or belongs
 *                                        to a different applicant. Both
 *                                        branches collapse to the same
 *                                        error so the API never leaks the
 *                                        existence of another user's rows.
 *   - `listExperience(userId)`        — load every experience entry for
 *                                        the applicant, ordered by
 *                                        `start_date DESC, id DESC`.
 *   - `findExperienceById(userId,
 *                          id)`       — load a single entry scoped to
 *                                        the owner; returns `null` when
 *                                        the row is missing or owned by
 *                                        someone else.
 *   - `createExperience(userId, raw)` — validate + INSERT; enforces the
 *                                        30-entry cap inside the same
 *                                        transaction (SELECT ... FOR
 *                                        UPDATE) so two concurrent POSTs
 *                                        cannot both squeeze a 31st row in.
 *   - `updateExperience(userId, id,
 *                        raw)`        — validate + UPDATE; scoped to the
 *                                        owner.
 *   - `deleteExperience(userId, id)`  — DELETE scoped to the owner.
 *
 * Validation contract (task 16.3):
 *   - `company`         : trimmed string, 1..150 chars (matches column).
 *   - `title`           : trimmed string, 1..100 chars (matches column).
 *   - `employment_type` : one of the DDL enum values (`EMPLOYMENT_TYPES`).
 *   - `start_date`      : required `YYYY-MM-DD`, must be on or before
 *                         today (no future-dated experience entries).
 *   - `end_date`        : optional `YYYY-MM-DD`.
 *   - `is_current`      : boolean (defaults false). Bidirectional rule:
 *                         `is_current=true` ⇔ `end_date IS NULL`. Either
 *                         direction failing is reported as a field error
 *                         on `end_date`.
 *   - `description`     : optional, ≤ 1000 chars (matches column).
 *
 * Why the cap is enforced inside the transaction:
 *   - "SELECT COUNT then INSERT" loses the race when two concurrent
 *     requests both read 29 → both insert → 31 total. We hold a
 *     connection, BEGIN, then `SELECT COUNT(*) ... FOR UPDATE` on the
 *     applicant's rows before INSERT. The row-level locks serialise
 *     concurrent branches so the second request sees the freshly
 *     inserted row and rejects.
 *   - Authorization is colocated: every UPDATE/DELETE WHERE clause
 *     includes `applicant_user_id = ?` sourced from the authenticated
 *     session — never the URL or form body. This mirrors `education.ts`
 *     and prevents IDOR attacks.
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

/** Maximum experience entries per applicant per task 16.3. */
export const MAX_EXPERIENCE_ENTRIES = 30;

/**
 * Allowed `employment_type` values. Must stay in sync with the
 * ENUM declared in `migrations/0002_profile.sql`. Adding a new value
 * here without updating the DDL would let the schema accept input that
 * MySQL then rejects at INSERT time with a confusing 1265 warning.
 */
export const EMPLOYMENT_TYPES = [
  'full-time',
  'part-time',
  'contract',
  'internship',
  'freelance',
] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `createExperience` when the applicant already has the
 * maximum allowed entries. The route layer maps this to HTTP 422.
 */
export class ExperienceCapError extends Error {
  readonly code = 'experience_cap_reached' as const;
  constructor(public readonly limit: number) {
    super(
      `Experience entries cap reached (${limit}). ` +
        `Remove an existing entry before adding a new one.`,
    );
    this.name = 'ExperienceCapError';
  }
}

/**
 * Thrown by `updateExperience` and `deleteExperience` when the row id
 * either does not exist or is owned by a different applicant. We do
 * NOT distinguish between "missing" and "not yours" so the API never
 * leaks the existence of other users' rows.
 */
export class ExperienceNotFoundError extends Error {
  readonly code = 'experience_not_found' as const;
  constructor(public readonly id: number) {
    super(`Experience entry ${id} not found`);
    this.name = 'ExperienceNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` shape check. We use a strict regex rather than relying
 * on `Date.parse` so ambiguous formats (`2024/01/01`, `01-01-2024`) get
 * a helpful field error instead of being silently accepted.
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
  });

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
 * boxes and omit the field entirely for unchecked. JS-driven
 * submissions may send `'true'`/`'false'` or actual booleans.
 */
const isCurrentSchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v): boolean => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    const lowered = v.trim().toLowerCase();
    return lowered === 'on' || lowered === 'true' || lowered === '1';
  });

const employmentTypeSchema = z.enum(EMPLOYMENT_TYPES, {
  errorMap: () => ({
    message: `Employment type must be one of: ${EMPLOYMENT_TYPES.join(', ')}`,
  }),
});

const descriptionSchema = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined) return null;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  })
  .refine((v) => v === null || v.length <= 1000, {
    message: 'Description must be at most 1000 characters',
  });

/**
 * Public experience schema. `.superRefine` enforces the cross-field
 * invariants:
 *   - `start_date` must be on or before today (no future-dated entries).
 *   - `is_current=true` ⇔ `end_date IS NULL` (Req 4.3 bidirectional).
 *   - `end_date >= start_date` when both are provided.
 */
export const experienceSchema = z
  .object({
    company: trimmedShortText(150, 'Company'),
    title: trimmedShortText(100, 'Title'),
    employment_type: employmentTypeSchema,
    start_date: startDateSchema,
    end_date: endDateSchema,
    is_current: isCurrentSchema,
    description: descriptionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const start = parseDate(value.start_date);

    // start_date must be on or before today. We compare in UTC midnight
    // so "today" is unambiguous regardless of the server timezone, and
    // the user's locally-chosen date (which arrives as a naive
    // YYYY-MM-DD string) is interpreted in the same UTC frame.
    if (start !== null) {
      const now = new Date();
      const todayUtcMs = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
      );
      if (start.getTime() > todayUtcMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start_date'],
          message: 'Start date cannot be in the future',
        });
      }
    }

    // Bidirectional: is_current=true ⇒ end_date must be null.
    if (value.is_current && value.end_date !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_date'],
        message:
          'End date must be empty when "current position" is checked',
      });
    }

    // Bidirectional: is_current=false ⇒ end_date must NOT be null.
    if (!value.is_current && value.end_date === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_date'],
        message:
          'End date is required when this is not your current position',
      });
    }

    // end_date present ⇒ end_date >= start_date.
    if (value.end_date !== null) {
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
export type ExperienceInput = z.infer<typeof experienceSchema>;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Public shape of an `applicant_experience` row, with `Date`-typed
 * columns normalised to ISO `YYYY-MM-DD` strings for direct rendering
 * into form inputs.
 */
export interface ExperienceRecord {
  readonly id: number;
  readonly applicant_user_id: number;
  readonly company: string;
  readonly title: string;
  readonly employment_type: EmploymentType;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly is_current: boolean;
  readonly description: string | null;
}

interface ExperienceRow extends RowDataPacket {
  id: number | string;
  applicant_user_id: number | string;
  company: string;
  title: string;
  employment_type: EmploymentType;
  start_date: Date | string;
  end_date: Date | string | null;
  is_current: number;
  description: string | null;
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

function rowToRecord(row: ExperienceRow): ExperienceRecord {
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    company: row.company,
    title: row.title,
    employment_type: row.employment_type,
    start_date: dateToIsoYmd(row.start_date) ?? '',
    end_date: dateToIsoYmd(row.end_date),
    is_current: row.is_current === 1,
    description: row.description,
  };
}

const SELECT_LIST_SQL =
  'SELECT id, applicant_user_id, company, title, employment_type, ' +
  '  start_date, end_date, is_current, description ' +
  'FROM applicant_experience ' +
  'WHERE applicant_user_id = ? ' +
  'ORDER BY start_date DESC, id DESC';

const SELECT_BY_ID_SQL =
  'SELECT id, applicant_user_id, company, title, employment_type, ' +
  '  start_date, end_date, is_current, description ' +
  'FROM applicant_experience ' +
  'WHERE id = ? AND applicant_user_id = ? ' +
  'LIMIT 1';

const COUNT_FOR_UPDATE_SQL =
  'SELECT COUNT(*) AS n FROM applicant_experience ' +
  'WHERE applicant_user_id = ? FOR UPDATE';

const INSERT_SQL =
  'INSERT INTO applicant_experience ' +
  '  (applicant_user_id, company, title, employment_type, start_date, end_date, is_current, description) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

const UPDATE_SQL =
  'UPDATE applicant_experience SET ' +
  '  company = ?, ' +
  '  title = ?, ' +
  '  employment_type = ?, ' +
  '  start_date = ?, ' +
  '  end_date = ?, ' +
  '  is_current = ?, ' +
  '  description = ? ' +
  'WHERE id = ? AND applicant_user_id = ?';

const DELETE_SQL =
  'DELETE FROM applicant_experience WHERE id = ? AND applicant_user_id = ?';

/**
 * Load every experience entry for `userId`, ordered by `start_date
 * DESC, id DESC` so the most recent / most recently created entry
 * surfaces first.
 */
export async function listExperience(
  userId: number,
): Promise<ExperienceRecord[]> {
  const rows = await query<ExperienceRow[]>(SELECT_LIST_SQL, [userId]);
  return rows.map(rowToRecord);
}

/**
 * Load a single entry scoped to the owner. Returns `null` when the row
 * is missing or owned by a different applicant.
 */
export async function findExperienceById(
  userId: number,
  id: number,
): Promise<ExperienceRecord | null> {
  const rows = await query<ExperienceRow[]>(SELECT_BY_ID_SQL, [id, userId]);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Map a validated `ExperienceInput` to the positional parameter array
 * for `INSERT`. Booleans go in as 0/1 to match the column's
 * `TINYINT(1)` declaration and avoid implicit casts.
 */
function inputToInsertParams(
  userId: number,
  input: ExperienceInput,
): unknown[] {
  return [
    userId,
    input.company,
    input.title,
    input.employment_type,
    input.start_date,
    input.end_date,
    input.is_current ? 1 : 0,
    input.description,
  ];
}

function inputToUpdateParams(
  userId: number,
  id: number,
  input: ExperienceInput,
): unknown[] {
  return [
    input.company,
    input.title,
    input.employment_type,
    input.start_date,
    input.end_date,
    input.is_current ? 1 : 0,
    input.description,
    id,
    userId,
  ];
}

/**
 * Create a new experience entry for the applicant.
 *
 * - Validates `rawInput` via `experienceSchema`. Throws `ZodError` on
 *   field-level failures.
 * - Inside a single transaction:
 *     1. `SELECT COUNT(*) ... FOR UPDATE` to lock the applicant's rows.
 *     2. If the count is already at or above the cap, throws
 *        `ExperienceCapError` (route layer maps to HTTP 422).
 *     3. Otherwise INSERTs the row and commits.
 *
 * Returns the newly inserted record (re-read from the DB so callers
 * receive the canonical row, including the auto-increment id).
 */
export async function createExperience(
  userId: number,
  rawInput: unknown,
): Promise<ExperienceRecord> {
  const input = experienceSchema.parse(rawInput);

  return withTransaction(async (conn: PoolConnection) => {
    const [countRows] = await conn.execute<RowDataPacket[]>(
      COUNT_FOR_UPDATE_SQL,
      [userId],
    );
    const current = Number(
      (countRows[0] as { n?: number | string } | undefined)?.n ?? 0,
    );
    if (current >= MAX_EXPERIENCE_ENTRIES) {
      throw new ExperienceCapError(MAX_EXPERIENCE_ENTRIES);
    }

    const [result] = await conn.execute<ResultSetHeader>(
      INSERT_SQL,
      inputToInsertParams(userId, input),
    );
    const insertedId = result.insertId;

    const [rows] = await conn.execute<ExperienceRow[]>(SELECT_BY_ID_SQL, [
      insertedId,
      userId,
    ]);
    const row = rows[0];
    if (!row) {
      // Should never happen — we just inserted the row inside the same
      // transaction. Defend against driver weirdness anyway.
      throw new Error('experience: failed to read back inserted row');
    }

    logger.info(
      {
        event: 'experience_create',
        user_id: userId,
        experience_id: insertedId,
      },
      'applicant.experience: row created',
    );

    return rowToRecord(row);
  });
}

/**
 * Update an existing experience entry scoped to the owner.
 *
 * Throws:
 *   - `ZodError` on validation failure.
 *   - `ExperienceNotFoundError` when no row matches the (id, userId)
 *     pair (either the row was deleted or never belonged to this user).
 */
export async function updateExperience(
  userId: number,
  id: number,
  rawInput: unknown,
): Promise<ExperienceRecord> {
  const input = experienceSchema.parse(rawInput);

  const result = await query<ResultSetHeader>(
    UPDATE_SQL,
    inputToUpdateParams(userId, id, input),
  );

  if (result.affectedRows === 0) {
    throw new ExperienceNotFoundError(id);
  }

  // Re-read so callers see the canonical row.
  const after = await findExperienceById(userId, id);
  if (after === null) {
    // Race: row was deleted between UPDATE and SELECT. Treat as
    // not-found so the caller can re-render the list.
    throw new ExperienceNotFoundError(id);
  }

  logger.info(
    { event: 'experience_update', user_id: userId, experience_id: id },
    'applicant.experience: row updated',
  );

  return after;
}

/**
 * Delete an experience entry scoped to the owner.
 *
 * Throws `ExperienceNotFoundError` when no row matches the
 * (id, userId) pair. Idempotency is the caller's choice: if you want
 * "delete is OK even if already gone", catch and ignore the error in
 * the route.
 */
export async function deleteExperience(
  userId: number,
  id: number,
): Promise<void> {
  const result = await query<ResultSetHeader>(DELETE_SQL, [id, userId]);
  if (result.affectedRows === 0) {
    throw new ExperienceNotFoundError(id);
  }
  logger.info(
    { event: 'experience_delete', user_id: userId, experience_id: id },
    'applicant.experience: row deleted',
  );
}
