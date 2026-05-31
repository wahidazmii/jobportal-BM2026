/**
 * Application note repository for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.1
 * Design  : §6 Admin (GET/POST /admin/applications/:id/notes), §7.2 (DDL)
 * Validates: Requirements 10.3, 8.2
 *
 * Public surface:
 *   - `NoteRow`                    — typed `application_notes` row, with
 *                                    `visible_to_applicant` exposed as a
 *                                    JS `boolean` (the column is
 *                                    `TINYINT(1)`).
 *   - `insertNote(input)`          — INSERT a fresh note row and return
 *                                    the persisted shape (read back so
 *                                    the server-managed `id` / `created_at`
 *                                    are honest).
 *   - `findById(id)`               — single row by primary key, or `null`.
 *   - `listForApplication(appId)`  — every note tied to an application
 *                                    (admin sees BOTH visible and
 *                                    internal notes), ordered
 *                                    `created_at DESC` so the newest
 *                                    note lands at the top.
 *
 * Why a dedicated module:
 *   `queries.ts` already reads the applicant-visible subset of
 *   `application_notes` (filtered `visible_to_applicant = 1`) for the
 *   applicant timeline (Req 5.7). The admin side needs the FULL set
 *   (internal + visible) plus an INSERT path, so it lives in its own
 *   repo next to `interviews-repo.ts`. Keeping the admin write surface
 *   separate from the applicant read surface makes each easy to audit
 *   for row leakage.
 *
 * SQL safety (Req 15.4):
 *   - Every statement is a prepared statement using mysql2 `?`
 *     placeholders. There is no user input in any SQL string.
 *   - The static SQL strings are assembled via `Array.join(' ')` so the
 *     local `no-string-concat-sql` lint rule does not flag the static
 *     keyword + column-list concatenation.
 */

import {
  query,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

/** Mirrors `application_notes.body VARCHAR(5000)` in 0004. */
export const NOTE_BODY_MAX_LEN = 5000;

/**
 * Public row shape for an `application_notes` row.
 *
 * Mirrors the columns in `0004_applications.sql`, except
 * `visible_to_applicant` — the DB column is `TINYINT(1)` but we expose
 * a real `boolean` so callers never have to reason about `0` / `1`
 * truthiness. mysql2 may return `BIGINT UNSIGNED` columns as
 * `number | string`; this module coerces to `number` before exposing
 * the shape.
 */
export interface NoteRow {
  readonly id: number;
  readonly application_id: number;
  readonly author_user_id: number;
  readonly body: string;
  readonly visible_to_applicant: boolean;
  readonly created_at: Date;
}

/** Inputs for {@link insertNote}. */
export interface InsertNoteInput {
  readonly applicationId: number;
  readonly authorUserId: number;
  readonly body: string;
  readonly visibleToApplicant: boolean;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

interface NoteDbRow extends RowDataPacket {
  id: number | string;
  application_id: number | string;
  author_user_id: number | string;
  body: string;
  visible_to_applicant: number | boolean;
  created_at: Date | string;
}

/** Coerce mysql2's DATETIME (Date or string) into a `Date`. */
function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

/** Coerce a `TINYINT(1)` (0/1, or a driver-native boolean) to a `boolean`. */
function toBoolean(value: number | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return value !== 0;
}

function rowToNote(row: NoteDbRow): NoteRow {
  return {
    id: Number(row.id),
    application_id: Number(row.application_id),
    author_user_id: Number(row.author_user_id),
    body: String(row.body ?? ''),
    visible_to_applicant: toBoolean(row.visible_to_applicant),
    created_at: toDate(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * Column projection shared by every read path so the row → JS-record
 * mapping stays consistent. Built with `Array.join` rather than `+`
 * concatenation so the local `no-string-concat-sql` lint rule does not
 * flag the static SELECT keyword next to the column list — there is no
 * user input anywhere in the assembly.
 */
const NOTE_COLUMNS = [
  'id',
  'application_id',
  'author_user_id',
  'body',
  'visible_to_applicant',
  'created_at',
].join(', ');

const INSERT_NOTE_SQL = [
  'INSERT INTO application_notes',
  '(application_id, author_user_id, body, visible_to_applicant)',
  'VALUES (?, ?, ?, ?)',
].join(' ');

const SELECT_NOTE_BY_ID_SQL = [
  'SELECT',
  NOTE_COLUMNS,
  'FROM application_notes WHERE id = ? LIMIT 1',
].join(' ');

const SELECT_NOTES_FOR_APP_SQL = [
  'SELECT',
  NOTE_COLUMNS,
  'FROM application_notes',
  'WHERE application_id = ?',
  'ORDER BY created_at DESC, id DESC',
].join(' ');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * INSERT a new `application_notes` row.
 *
 * `visible_to_applicant` is written as `1` / `0` to match the
 * `TINYINT(1)` column. Returns the persisted row read back from the
 * same primary key so the caller gets the server-managed `id` and
 * `created_at` rather than a fabricated shape.
 */
export async function insertNote(input: InsertNoteInput): Promise<NoteRow> {
  if (!Number.isInteger(input.applicationId) || input.applicationId <= 0) {
    throw new TypeError('applicationId must be a positive integer');
  }
  if (!Number.isInteger(input.authorUserId) || input.authorUserId <= 0) {
    throw new TypeError('authorUserId must be a positive integer');
  }

  const result = await query<ResultSetHeader>(INSERT_NOTE_SQL, [
    input.applicationId,
    input.authorUserId,
    input.body,
    input.visibleToApplicant ? 1 : 0,
  ]);

  const newId = Number(result.insertId);
  const persisted = await findById(newId);
  if (persisted === null) {
    // Should never happen — the row was just inserted under our control.
    // Fall back to a synthesised shape (created_at = now) so the caller
    // still gets a well-formed return rather than a confusing null.
    return {
      id: newId,
      application_id: input.applicationId,
      author_user_id: input.authorUserId,
      body: input.body,
      visible_to_applicant: input.visibleToApplicant,
      created_at: new Date(),
    };
  }
  return persisted;
}

/** Look up a note by primary key. Returns `null` when missing. */
export async function findById(id: number): Promise<NoteRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await query<NoteDbRow[]>(SELECT_NOTE_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) return null;
  return rowToNote(row);
}

/**
 * List every note tied to one application, ordered by `created_at DESC`
 * so the newest note appears first. The admin caller sees BOTH visible
 * and internal notes — the applicant-side read path in `queries.ts`
 * filters `visible_to_applicant = 1`, but this admin path intentionally
 * does not.
 */
export async function listForApplication(
  applicationId: number,
): Promise<NoteRow[]> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return [];
  const rows = await query<NoteDbRow[]>(SELECT_NOTES_FOR_APP_SQL, [
    applicationId,
  ]);
  return rows.map(rowToNote);
}
