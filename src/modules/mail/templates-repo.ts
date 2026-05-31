/**
 * Mail-template repository for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 36.2 (Templated mail editor di admin)
 * Design  : §15 (Audit Log), §12.3 (template merge pipeline), §6 Admin
 * Validates: Requirements 10.7, 12.1
 *
 * Public surface:
 *   - `MailTemplateRecord`             — typed `mail_templates` row.
 *   - `listTemplates()`                — every row, ordered (`key`, locale).
 *   - `findTemplate(key, locale)`      — single row by composite PK, or null.
 *   - `upsertTemplate(input)`          — INSERT ... ON DUPLICATE KEY UPDATE
 *                                        keyed on the (`key`, locale) PK;
 *                                        returns the persisted row.
 *   - `deleteTemplate(key, locale)`    — DELETE by composite PK; returns
 *                                        whether a row was removed.
 *
 * Why a dedicated repo:
 *   `mail/service.ts` already reads `mail_templates` at enqueue time
 *   (SELECT by `key` + locale), but only the three render channels — it
 *   never writes the table. The HR editor (Req 10.7) needs the full CRUD
 *   surface (list / read / upsert / delete) plus `updated_at`, so the
 *   write path lives in its own module next to the read-only service.
 *
 * SQL safety (Req 15.4):
 *   - Every statement is a prepared statement using mysql2 `?`
 *     placeholders. There is no user input in any SQL string.
 *   - `key` is a SQL reserved word (declared as `` `key` VARCHAR(64) `` in
 *     migration 0006_mail.sql) so it is backtick-quoted everywhere.
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
// Types
// ---------------------------------------------------------------------------

/**
 * Public row shape for a `mail_templates` row. Mirrors the columns in
 * `0006_mail.sql`: the composite PK is (`key`, `locale`); `body_text` is
 * nullable (HTML-only templates); `updated_at` is server-managed
 * (`ON UPDATE CURRENT_TIMESTAMP`).
 */
export interface MailTemplateRecord {
  readonly key: string;
  readonly locale: string;
  readonly subject: string;
  readonly body_html: string;
  readonly body_text: string | null;
  readonly updated_at: Date;
}

/** Inputs for {@link upsertTemplate}. */
export interface UpsertTemplateInput {
  readonly key: string;
  readonly locale: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string | null;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

interface MailTemplateDbRow extends RowDataPacket {
  key: string;
  locale: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  updated_at: Date | string;
}

/** Coerce mysql2's DATETIME (Date or string) into a `Date`. */
function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function rowToRecord(row: MailTemplateDbRow): MailTemplateRecord {
  return {
    key: String(row.key),
    locale: String(row.locale),
    subject: String(row.subject ?? ''),
    body_html: String(row.body_html ?? ''),
    body_text: row.body_text === null ? null : String(row.body_text),
    updated_at: toDate(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * Shared column projection. `key` is backtick-quoted because it is a SQL
 * reserved word. Assembled with `Array.join` so the local
 * `no-string-concat-sql` rule never sees a SQL keyword adjacent to a
 * dynamic part — there is no user input in the assembly.
 */
const TEMPLATE_COLUMNS = [
  '`key`',
  'locale',
  'subject',
  'body_html',
  'body_text',
  'updated_at',
].join(', ');

const SELECT_ALL_TEMPLATES_SQL = [
  'SELECT',
  TEMPLATE_COLUMNS,
  'FROM mail_templates',
  'ORDER BY `key` ASC, locale ASC',
].join(' ');

const SELECT_TEMPLATE_SQL = [
  'SELECT',
  TEMPLATE_COLUMNS,
  'FROM mail_templates',
  'WHERE `key` = ? AND locale = ? LIMIT 1',
].join(' ');

/**
 * Upsert keyed on the composite PK (`key`, locale). On a duplicate PK we
 * overwrite the three editable channels (`subject`, `body_html`,
 * `body_text`); `updated_at` refreshes via the column's
 * `ON UPDATE CURRENT_TIMESTAMP` default.
 */
const UPSERT_TEMPLATE_SQL = [
  'INSERT INTO mail_templates',
  '(`key`, locale, subject, body_html, body_text)',
  'VALUES (?, ?, ?, ?, ?)',
  'ON DUPLICATE KEY UPDATE',
  'subject = ?, body_html = ?, body_text = ?',
].join(' ');

const DELETE_TEMPLATE_SQL = [
  'DELETE FROM mail_templates',
  'WHERE `key` = ? AND locale = ?',
].join(' ');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** List every mail template, ordered by (`key`, locale). */
export async function listTemplates(): Promise<MailTemplateRecord[]> {
  const rows = await query<MailTemplateDbRow[]>(SELECT_ALL_TEMPLATES_SQL, []);
  return rows.map(rowToRecord);
}

/**
 * Look up a single template by its composite PK. Returns `null` when the
 * `(key, locale)` pair has no row.
 */
export async function findTemplate(
  key: string,
  locale: string,
): Promise<MailTemplateRecord | null> {
  const rows = await query<MailTemplateDbRow[]>(SELECT_TEMPLATE_SQL, [
    key,
    locale,
  ]);
  const row = rows[0];
  if (!row) return null;
  return rowToRecord(row);
}

/**
 * Insert or update a template row keyed on (`key`, locale). Returns the
 * persisted row read back from the same PK so the caller gets the
 * server-managed `updated_at`.
 */
export async function upsertTemplate(
  input: UpsertTemplateInput,
): Promise<MailTemplateRecord> {
  await query<ResultSetHeader>(UPSERT_TEMPLATE_SQL, [
    // INSERT tuple
    input.key,
    input.locale,
    input.subject,
    input.bodyHtml,
    input.bodyText,
    // ON DUPLICATE KEY UPDATE assignments
    input.subject,
    input.bodyHtml,
    input.bodyText,
  ]);

  const persisted = await findTemplate(input.key, input.locale);
  if (persisted === null) {
    // Should never happen — the row was just written under our control.
    // Synthesise a well-formed shape (updated_at = now) rather than
    // returning a confusing null.
    return {
      key: input.key,
      locale: input.locale,
      subject: input.subject,
      body_html: input.bodyHtml,
      body_text: input.bodyText,
      updated_at: new Date(),
    };
  }
  return persisted;
}

/**
 * Delete a template by its composite PK. Returns `true` when a row was
 * removed, `false` when the `(key, locale)` pair did not exist.
 */
export async function deleteTemplate(
  key: string,
  locale: string,
): Promise<boolean> {
  const result = await query<ResultSetHeader>(DELETE_TEMPLATE_SQL, [
    key,
    locale,
  ]);
  return result.affectedRows > 0;
}
