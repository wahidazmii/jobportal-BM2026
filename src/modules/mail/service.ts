/**
 * Mail enqueue service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 9.1 (stub) → task 36.1 (full implementation)
 * Design  : §12 (Mail Outbox), §12.3 (transactional enqueue + template
 *           merge pipeline)
 * Validates: Requirements 8.3 (transactional, idempotent enqueue contract)
 *
 * Public surface (unchanged contract from the task 9.1 stub):
 *   - `EnqueueOptions`          — arguments accepted by `enqueue()`.
 *   - `enqueue(connection, opts)` — render + idempotent INSERT into
 *                                   `mail_outbox` on the caller's
 *                                   transaction connection.
 *   - `MailTemplateMissingError` — neither a DB `mail_templates` row nor a
 *                                   file-system default exists for the
 *                                   requested `(templateKey, locale)`.
 *
 * Why accept a `PoolConnection`? Per Design §12.3, every domain action
 * that triggers an email enqueues it inside the same transaction that
 * persists the domain change. That guarantees: if the domain change
 * commits, the email is queued; if it rolls back, no email is queued.
 * The INSERT therefore runs on the caller's connection, not the pool.
 *
 * Template merge pipeline (Design §12.3, migration 0006_mail.sql):
 *   1. DB first — `mail_templates` holds HR-editable per-locale overrides
 *      (Req 10.7). A `(key, locale)` row, when present, is authoritative.
 *   2. File-system default — when no DB row exists, fall back to the
 *      Nunjucks defaults shipped under `src/views/emails/`. The three
 *      `mail_outbox` channels (subject / body_html / body_text) map to
 *      three per-channel files so each channel can be overridden
 *      independently ("prefers template-row content over file-system
 *      defaults per channel" — migration 0006_mail.sql):
 *        - `<templateKey>.subject.njk`  (required)
 *        - `<templateKey>.html.njk`     (required)
 *        - `<templateKey>.text.njk`     (optional)
 *      Design §4.2 lists these as single `<key>.njk` entries; that tree is
 *      a simplification — the persistence layer needs the subject and both
 *      body channels, so the default is split per channel here.
 *   3. If NEITHER source resolves, throw `MailTemplateMissingError` so the
 *      caller's transaction rolls back and the misconfiguration surfaces
 *      immediately rather than silently dropping mail.
 *
 * Idempotency (Design §12.3, Req 8.3):
 *   - When `targetId` is set, the INSERT uses `INSERT IGNORE` keyed on the
 *     natural key `(template_key, target_id)` (UNIQUE `uk_outbox_natural`
 *     in migration 0006). A retried domain handler therefore never
 *     double-enqueues the same message (mis. `verify` after a register
 *     retry, `application_confirm` after an apply retry).
 *   - When `targetId` is null, a plain INSERT is used. MySQL's
 *     UNIQUE-with-NULL semantics (multiple NULLs are not equal) allow many
 *     `target_id IS NULL` rows, matching the newsletter / digest case
 *     where each run intentionally produces a distinct row.
 *
 * SQL safety (Req 15.4):
 *   - Every statement is a prepared statement using mysql2 `?`
 *     placeholders. Static SQL strings are assembled via `Array.join(' ')`
 *     so the local `no-string-concat-sql` lint rule never sees a SQL
 *     keyword adjacent to a dynamic `+`/template part — there is no user
 *     input anywhere in the assembly.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nunjucks from 'nunjucks';

import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';

/**
 * Arguments accepted by `enqueue()`.
 *
 * Only `templateKey` and `toEmail` are required at the call site; everything
 * else is optional or has a sensible default. The shape mirrors the columns
 * of the `mail_outbox` table (Design §12) so the INSERT is a direct
 * field-for-field map.
 */
export interface EnqueueOptions {
  /**
   * Identifier of the template to render (e.g. `'verify'`, `'reset'`,
   * `'application-confirm'`). Resolved against `mail_templates.key` plus
   * the active locale, then against the file-system defaults.
   */
  readonly templateKey: string;

  /** Recipient address. Caller is responsible for trimming/validation. */
  readonly toEmail: string;

  /** Optional friendly name for the recipient, used in `to_name`. */
  readonly toName?: string | null;

  /**
   * Locale used to pick a row from `mail_templates` (`mail_templates.key`
   * + `mail_templates.locale` is the composite PK). Defaults to `'id'` to
   * match the i18n default in Design §13.
   */
  readonly locale?: 'id' | 'en';

  /**
   * Free-form context handed to the Nunjucks template at render time.
   * Persisted as JSON in `mail_outbox.context` so re-renders during
   * retries see exactly the same input.
   */
  readonly context?: Readonly<Record<string, unknown>>;

  /**
   * Natural key for idempotency. When set, the INSERT uses `INSERT IGNORE`
   * keyed on `(template_key, target_id)` so retries of the same domain
   * action never produce duplicate emails (Design §12.3).
   *
   * Examples:
   *   - register     → `target_id = users.id`
   *   - apply        → `target_id = applications.id`
   *   - stage_change → `target_id = "<application_id>:<new_stage>"`
   */
  readonly targetId?: string | null;
}

/**
 * Thrown when neither a `mail_templates` row nor a file-system default
 * exists for the requested `(templateKey, locale)`. Surfacing this (rather
 * than logging + skipping) lets the caller's transaction roll back so a
 * mail misconfiguration is caught at the point of use (Design §12.3).
 */
export class MailTemplateMissingError extends Error {
  readonly code = 'mail_template_missing' as const;
  constructor(
    public readonly templateKey: string,
    public readonly locale: string,
  ) {
    super(`No mail template found for "${templateKey}" (${locale})`);
    this.name = 'MailTemplateMissingError';
  }
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/** Directory holding the file-system Nunjucks email defaults. */
const EMAILS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'views',
  'emails',
);

/**
 * Load the `mail_templates` row for a `(key, locale)` pair. The `key`
 * column is backtick-quoted because `key` is a SQL reserved word (declared
 * as `` `key` VARCHAR(64) `` in migration 0006_mail.sql). Assembled via
 * `Array.join(' ')` for the `no-string-concat-sql` rule. The SELECT runs on
 * the caller's transaction connection so it sees the same snapshot.
 */
const SELECT_MAIL_TEMPLATE_SQL = [
  'SELECT subject, body_html, body_text',
  'FROM mail_templates',
  'WHERE `key` = ? AND locale = ? LIMIT 1',
].join(' ');

interface MailTemplateRow extends RowDataPacket {
  subject: string;
  body_html: string;
  body_text: string | null;
}

/** A resolved template's raw (pre-render) channel strings. */
interface ResolvedTemplate {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string | null;
}

/**
 * Read a single file-system template channel. Returns `null` when the file
 * does not exist (ENOENT) so an optional channel (`.text.njk`) degrades
 * gracefully; any other I/O error propagates.
 */
async function readChannelFile(fileName: string): Promise<string | null> {
  try {
    return await readFile(path.join(EMAILS_DIR, fileName), 'utf8');
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Load the file-system default for a template key. Returns `null` when the
 * required channels (subject + html) are absent so the caller can raise
 * `MailTemplateMissingError`.
 */
async function loadFsTemplate(
  templateKey: string,
): Promise<ResolvedTemplate | null> {
  const [subject, bodyHtml, bodyText] = await Promise.all([
    readChannelFile(`${templateKey}.subject.njk`),
    readChannelFile(`${templateKey}.html.njk`),
    readChannelFile(`${templateKey}.text.njk`),
  ]);

  if (subject === null || bodyHtml === null) {
    return null;
  }
  return { subject, bodyHtml, bodyText };
}

/**
 * Resolve a template through the §12.3 merge pipeline: DB override first,
 * file-system default second. Throws `MailTemplateMissingError` when
 * neither source resolves.
 */
async function resolveTemplate(
  connection: PoolConnection,
  templateKey: string,
  locale: string,
): Promise<ResolvedTemplate> {
  const [rows] = await connection.execute<MailTemplateRow[]>(
    SELECT_MAIL_TEMPLATE_SQL,
    [templateKey, locale],
  );
  const dbRow = rows[0];
  if (dbRow) {
    return {
      subject: dbRow.subject,
      bodyHtml: dbRow.body_html,
      bodyText: dbRow.body_text,
    };
  }

  const fsTemplate = await loadFsTemplate(templateKey);
  if (fsTemplate) {
    return fsTemplate;
  }

  throw new MailTemplateMissingError(templateKey, locale);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Minimal HTML → plain-text reduction used to derive a `body_text` fallback
 * when a template supplies no dedicated text channel. The migration notes
 * the service "is responsible for always supplying a plaintext fallback
 * (Req 8.3)", so a rendered outbox row always carries a text body. This is
 * deliberately small (strip tags, decode the few common entities, collapse
 * whitespace) — it is a fallback, not a full HTML-to-text engine.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

/** A fully-rendered message ready to persist into `mail_outbox`. */
interface RenderedMessage {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
}

/**
 * Render every channel of a resolved template against `context` via
 * `nunjucks.renderString` (the same string-render path used by
 * `applications/email-service.ts`). When the template carries no text
 * channel, derive a plaintext fallback from the rendered HTML so the
 * outbox row always has a text body (Req 8.3).
 */
function renderTemplate(
  template: ResolvedTemplate,
  context: Record<string, unknown>,
): RenderedMessage {
  const subject = nunjucks.renderString(template.subject, context);
  const bodyHtml = nunjucks.renderString(template.bodyHtml, context);
  const bodyText =
    template.bodyText !== null
      ? nunjucks.renderString(template.bodyText, context)
      : htmlToPlainText(bodyHtml);
  return { subject, bodyHtml, bodyText };
}

// ---------------------------------------------------------------------------
// Outbox INSERT
// ---------------------------------------------------------------------------

/**
 * The shared column list for an outbox INSERT. `status`, `next_attempt_at`
 * and `created_at` use SQL defaults (`'pending'` / `NOW()` / `NOW()`) so a
 * freshly-enqueued row is immediately eligible for the flusher's
 * `status='pending' AND next_attempt_at <= NOW()` scan (Design §11.3).
 */
const OUTBOX_VALUES_CLAUSE = [
  '(template_key, target_id, to_email, to_name, subject, body_html, body_text, context, status, next_attempt_at, created_at)',
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())",
].join(' ');

/**
 * Idempotent variant (Design §12.3). `INSERT IGNORE` makes a retry of the
 * same `(template_key, target_id)` a no-op against `uk_outbox_natural`.
 */
const INSERT_IGNORE_OUTBOX_SQL = [
  'INSERT IGNORE INTO mail_outbox',
  OUTBOX_VALUES_CLAUSE,
].join(' ');

/**
 * Plain variant for `targetId === null` (newsletter / digest style). No
 * dedupe: MySQL allows many `target_id IS NULL` rows under the unique key.
 */
const INSERT_OUTBOX_SQL = ['INSERT INTO mail_outbox', OUTBOX_VALUES_CLAUSE].join(
  ' ',
);

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Enqueue an email into `mail_outbox` in the context of the caller's
 * transaction (Design §12.3, Req 8.3).
 *
 * Pipeline:
 *   1. Resolve the template — DB `mail_templates` override first, then the
 *      file-system default under `src/views/emails/`. Missing both →
 *      `MailTemplateMissingError`.
 *   2. Render the subject + body_html (+ body_text, falling back to a
 *      plaintext reduction of the HTML) via Nunjucks against `context`.
 *   3. INSERT the rendered row on the supplied transaction `connection`:
 *      `INSERT IGNORE` keyed on `(template_key, target_id)` when `targetId`
 *      is set (idempotent), otherwise a plain INSERT.
 *
 * Returns void so callers cannot leak a "did this hit a real row?" bit out
 * to the HTTP layer; idempotency is enforced at the SQL layer.
 */
export async function enqueue(
  connection: PoolConnection,
  options: EnqueueOptions,
): Promise<void> {
  const locale = options.locale ?? 'id';
  const context: Record<string, unknown> = { ...(options.context ?? {}) };

  // 1. Resolve (DB override → file-system default).
  const template = await resolveTemplate(connection, options.templateKey, locale);

  // 2. Render every channel against the supplied context.
  const message = renderTemplate(template, context);

  // 3. Persist into the outbox on the caller's transaction connection.
  const targetId = options.targetId ?? null;
  const params = [
    options.templateKey,
    targetId,
    options.toEmail,
    options.toName ?? null,
    message.subject,
    message.bodyHtml,
    message.bodyText,
    JSON.stringify(context),
  ];

  const sql = targetId === null ? INSERT_OUTBOX_SQL : INSERT_IGNORE_OUTBOX_SQL;
  const [result] = await connection.execute<ResultSetHeader>(sql, params);

  logger.info(
    {
      template_key: options.templateKey,
      to_email: options.toEmail,
      to_name: options.toName ?? null,
      locale,
      target_id: targetId,
      idempotent: targetId !== null,
      // `affectedRows === 0` under INSERT IGNORE means the natural key
      // already existed — a deduped retry, not an error.
      affected_rows: result.affectedRows,
      deduped: targetId !== null && result.affectedRows === 0,
    },
    'mail.enqueue',
  );
}
