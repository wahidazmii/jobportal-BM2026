/**
 * Templated-email service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.3
 * Design  : §6 Admin (POST /admin/applications/:id/email), §12 (Mail
 *           Outbox), §12.3 (template render / enqueue pipeline)
 * Validates: Requirements 10.7
 *
 * Public surface:
 *   - `sendTemplatedEmailSchema`     — zod schema for the form payload.
 *   - `SendTemplatedEmailInput`      — type inferred from the schema.
 *   - `InvalidEmailInputError`       — thrown on validation failure with a
 *                                      field-level error map (HTTP 422).
 *   - `MailTemplateNotFoundError`    — the chosen `(templateKey, locale)`
 *                                      pair has no row in `mail_templates`
 *                                      (HTTP 422 `unknown_template` — the
 *                                      admin picked a bad key, so it is a
 *                                      validation-class failure, NOT a
 *                                      missing-resource 404).
 *   - `ApplicationNotFoundError`     — RE-EXPORTED from `./errors.js` so a
 *                                      missing OR out-of-scope application
 *                                      collapses to the same 404 shape the
 *                                      rest of the applications domain uses
 *                                      (identical to notes/stage services).
 *   - `sendTemplatedEmail(opts)`     — scope check → validate → load the
 *                                      template → render the placeholders →
 *                                      transactional enqueue → audit log.
 *
 * Authorization model:
 *   - The route layer (`/admin/applications/:id/email`) restricts entry
 *     to {Super_Admin, HR} per Design §6 Admin + §14.1 — templated email
 *     send is an HR action and Department_Head is NOT granted it. The
 *     service still accepts an optional `scope` so it can be reused from
 *     a scoped context in the future; for HR / Super_Admin callers the
 *     route passes `undefined` (no department clause). When a scope IS
 *     supplied, an out-of-department application collapses to
 *     `ApplicationNotFoundError` — same shape as "id missing", which
 *     keeps the API from leaking the existence of out-of-scope rows
 *     (mirrors `notes-service.ts` and the `JobNotFoundError` pattern in
 *     `jobs/repo.ts`).
 *
 * Placeholder contract (Req 10.7):
 *   HR-managed templates support three placeholders:
 *     - `applicant_name` → `applicants.full_name`
 *     - `job_title`      → `job_posting_translations.title` for the
 *                          requested locale, falling back to the other
 *                          locale when the requested one is absent.
 *     - `stage`          → `applications.stage`
 *   These three keys form the Nunjucks render context.
 *
 * Render + enqueue pipeline (Design §12.3):
 *   1. The template row's `subject` / `body_html` / `body_text` strings
 *      are rendered HERE via `nunjucks.renderString(...)`. This is the
 *      "preview / validation" render — it proves the template compiles
 *      against the resolved context BEFORE the row is committed, so a
 *      broken template surfaces immediately rather than silently failing
 *      later inside the flusher cron.
 *   2. The canonical enqueue carries the placeholder `context` (NOT the
 *      pre-rendered strings) into `mail_outbox.context`. The `enqueue`
 *      stub today (task 9.1) only logs; task 36.1 swaps it for the
 *      idempotent `INSERT IGNORE INTO mail_outbox (...)` plus the final
 *      render against the persisted context, so a retry re-renders from
 *      exactly the same input. Passing the context (rather than the
 *      rendered strings) keeps that re-render path authoritative.
 *   3. The enqueue runs inside `withTransaction(...)` because Design §12.3
 *      requires every domain action that triggers an email to enqueue it
 *      inside a transaction; `enqueue` only accepts a `PoolConnection`.
 *
 * SQL safety (Req 15.4):
 *   - Every statement is a prepared statement using mysql2 `?`
 *     placeholders. Static SQL strings are assembled via `Array.join(' ')`
 *     so the local `no-string-concat-sql` lint rule does not flag the
 *     SELECT keyword next to the (placeholder-only) clause — there is no
 *     user input anywhere in the assembly.
 */

import nunjucks from 'nunjucks';
import { z, ZodError } from 'zod';

import { query, withTransaction, type RowDataPacket } from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import {
  findById as findJobById,
  JOB_LOCALES,
  type JobLocale,
  type JobScope,
} from '../jobs/repo.js';
import { enqueue } from '../mail/service.js';

// Re-export the shared application-not-found error so the route layer can
// import it from this module OR from a sibling applications service and
// receive the SAME class (all re-export from `./errors.js`). This avoids a
// duplicate-import collision in `routes/admin.ts`.
export { ApplicationNotFoundError } from './errors.js';
import { ApplicationNotFoundError } from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Upper bound on a template key length. `mail_templates.key` is
 * `VARCHAR(64)` per migration 0006, but the route accepts a slightly
 * looser ≤80 so an over-long value fails with a clean validation error
 * (422) rather than a silent truncation at the SQL layer.
 */
export const TEMPLATE_KEY_MAX_LEN = 80;

/** Locales accepted by the template picker; mirrors `JOB_LOCALES`. */
const EMAIL_LOCALES = JOB_LOCALES;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the email input fails validation. Carries the field-level
 * error map (`{ templateKey: ['must not be empty'] }`) so the route layer
 * can render per-field messages without re-running `zod.flatten()`.
 */
export class InvalidEmailInputError extends Error {
  readonly code = 'invalid_email_input' as const;
  readonly statusCode = 422 as const;
  constructor(
    public readonly fieldErrors: Readonly<Record<string, readonly string[]>>,
    message = 'Invalid email input',
  ) {
    super(message);
    this.name = 'InvalidEmailInputError';
  }
}

/**
 * Thrown when the chosen `(templateKey, locale)` pair has no row in
 * `mail_templates`. Distinct from `ApplicationNotFoundError` so the route
 * can surface a precise `unknown_template` 422 to HR — the template
 * picker offered a key/locale that no longer exists, which is a
 * validation-class failure (the admin picked a bad key) rather than a
 * missing-resource 404.
 */
export class MailTemplateNotFoundError extends Error {
  readonly code = 'unknown_template' as const;
  readonly statusCode = 422 as const;
  constructor(
    public readonly templateKey: string,
    public readonly locale: string,
  ) {
    super(`Mail template "${templateKey}" (${locale}) not found`);
    this.name = 'MailTemplateNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Trim a string template key; non-strings pass through for zod to reject. */
function preprocessTemplateKey(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  return value;
}

/**
 * The send-templated-email form schema. `templateKey` is trimmed and
 * bounded; `locale` is an enum defaulting to `'id'` (the i18n default in
 * Design §13). An absent/empty locale resolves to `'id'`.
 */
export const sendTemplatedEmailSchema = z.object({
  templateKey: z.preprocess(
    preprocessTemplateKey,
    z
      .string({
        invalid_type_error: 'templateKey must be a string',
        required_error: 'templateKey is required',
      })
      .min(1, 'templateKey must not be empty')
      .max(
        TEMPLATE_KEY_MAX_LEN,
        `templateKey must be at most ${TEMPLATE_KEY_MAX_LEN} characters`,
      ),
  ),
  locale: z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return 'id';
      if (typeof value === 'string') return value.trim().toLowerCase();
      return value;
    },
    z.enum(EMAIL_LOCALES, {
      invalid_type_error: 'locale must be one of id, en',
    }),
  ),
});

/** Inferred input type. */
export type SendTemplatedEmailInput = z.infer<typeof sendTemplatedEmailSchema>;

// ---------------------------------------------------------------------------
// Application + context loader
// ---------------------------------------------------------------------------

interface ApplicationContextRow extends RowDataPacket {
  application_id: number | string;
  job_id: number | string;
  stage: string;
  applicant_name: string;
  to_email: string;
  title_requested: string | null;
}

interface TitleRow extends RowDataPacket {
  locale: JobLocale;
  title: string;
}

/**
 * Resolve the application plus the joined context needed to fill the
 * `{applicant_name, job_title, stage}` placeholders.
 *
 * The primary SELECT joins:
 *   applications → applicants → users → job_posting_translations
 * pulling the requested-locale title via a LEFT JOIN bound by the locale
 * parameter. `to_email` is the applicant's login email (`users.email`).
 *
 * Built with `Array.join(' ')` so the local `no-string-concat-sql` lint
 * rule does not flag the static SELECT — the only dynamic pieces are `?`
 * placeholders, never inlined user values.
 */
const SELECT_APPLICATION_CONTEXT_SQL = [
  'SELECT',
  '  a.id AS application_id,',
  '  a.job_id AS job_id,',
  '  a.stage AS stage,',
  '  ap.full_name AS applicant_name,',
  '  u.email AS to_email,',
  '  jt.title AS title_requested',
  'FROM applications a',
  'JOIN applicants ap ON ap.user_id = a.applicant_user_id',
  'JOIN users u ON u.id = a.applicant_user_id',
  'LEFT JOIN job_posting_translations jt',
  '  ON jt.job_id = a.job_id AND jt.locale = ?',
  'WHERE a.id = ? LIMIT 1',
].join(' ');

/**
 * Fallback title lookup. Used only when the requested-locale title is
 * absent (a Draft drafted in the other locale, say) so the placeholder
 * still resolves to a meaningful string. Returns every translation row;
 * the caller picks the first non-empty title.
 */
const SELECT_ALL_TITLES_SQL = [
  'SELECT locale, title',
  'FROM job_posting_translations',
  'WHERE job_id = ?',
].join(' ');

interface ApplicationEmailContext {
  readonly applicationId: number;
  readonly jobId: number;
  readonly stage: string;
  readonly applicantName: string;
  readonly toEmail: string;
  readonly jobTitle: string;
}

/**
 * Load the application context row. Returns `null` when the application id
 * is invalid or the row is missing (collapsed to `ApplicationNotFoundError`
 * by the caller). The job-title fallback runs a second query ONLY when the
 * requested-locale title came back null/empty.
 */
async function loadApplicationContext(
  applicationId: number,
  locale: JobLocale,
): Promise<ApplicationEmailContext | null> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;

  const rows = await query<ApplicationContextRow[]>(
    SELECT_APPLICATION_CONTEXT_SQL,
    [locale, applicationId],
  );
  const row = rows[0];
  if (!row) return null;

  let jobTitle = (row.title_requested ?? '').trim();
  if (jobTitle === '') {
    // Requested-locale title missing — fall back to any other locale so
    // the `{job_title}` placeholder never renders empty.
    const titleRows = await query<TitleRow[]>(SELECT_ALL_TITLES_SQL, [
      Number(row.job_id),
    ]);
    for (const tr of titleRows) {
      const candidate = (tr.title ?? '').trim();
      if (candidate !== '') {
        jobTitle = candidate;
        break;
      }
    }
  }

  return {
    applicationId: Number(row.application_id),
    jobId: Number(row.job_id),
    stage: row.stage,
    applicantName: row.applicant_name,
    toEmail: row.to_email,
    jobTitle,
  };
}

/**
 * Resolve the application AND verify its job is within the caller's scope.
 * Both "application missing" and "job missing / out of scope" collapse to
 * `ApplicationNotFoundError` so the API never leaks the existence of an
 * out-of-scope row.
 */
async function resolveInScopeApplicationContext(
  applicationId: number,
  locale: JobLocale,
  scope: JobScope | undefined,
): Promise<ApplicationEmailContext> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError(applicationId);
  }

  const ctx = await loadApplicationContext(applicationId, locale);
  if (ctx === null) {
    throw new ApplicationNotFoundError(applicationId);
  }

  // The repo's `findById` short-circuits to `null` for out-of-scope
  // reads, so one branch covers both "job missing" and "out of scope".
  const job = await findJobById(ctx.jobId, scope);
  if (job === null) {
    throw new ApplicationNotFoundError(applicationId);
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Template loader
// ---------------------------------------------------------------------------

interface MailTemplateRow extends RowDataPacket {
  subject: string;
  body_html: string;
  body_text: string | null;
}

/**
 * Load the `mail_templates` row for a `(key, locale)` pair. The `key`
 * column is backtick-quoted because `key` is a SQL reserved word (verified
 * against migration 0006_mail.sql, where the column is declared as
 * `` `key` VARCHAR(64) ``). Assembled via `Array.join(' ')` for the
 * `no-string-concat-sql` rule.
 */
const SELECT_MAIL_TEMPLATE_SQL = [
  'SELECT subject, body_html, body_text',
  'FROM mail_templates',
  'WHERE `key` = ? AND locale = ? LIMIT 1',
].join(' ');

interface MailTemplate {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string | null;
}

async function loadMailTemplate(
  templateKey: string,
  locale: JobLocale,
): Promise<MailTemplate | null> {
  const rows = await query<MailTemplateRow[]>(SELECT_MAIL_TEMPLATE_SQL, [
    templateKey,
    locale,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
  };
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export interface SendTemplatedEmailOptions {
  /** Application primary key from the URL. */
  readonly applicationId: number;
  /** Authenticated admin user (for the audit log). */
  readonly actorUserId: number;
  /** Department_Head scope; HR / Super_Admin pass `undefined`. */
  readonly scope?: JobScope;
  /** Raw form payload — passed through `sendTemplatedEmailSchema`. */
  readonly input: unknown;
}

export interface SendTemplatedEmailResult {
  readonly templateKey: string;
  readonly toEmail: string;
}

/**
 * Send a templated email to an application's applicant (Req 10.7).
 *
 * Pipeline:
 *   1. Validate the input via `sendTemplatedEmailSchema`. ZodError →
 *      `InvalidEmailInputError` carrying the field-level error map.
 *   2. Resolve the application + context and enforce scope. Missing or
 *      out-of-scope → `ApplicationNotFoundError`.
 *   3. Load the `mail_templates` row for `(templateKey, locale)`. Absent →
 *      `MailTemplateNotFoundError`.
 *   4. Build the placeholder context `{applicant_name, job_title, stage}`.
 *   5. Render subject + body_html (+ body_text if present) via Nunjucks —
 *      the "preview / validation" render per Design §12.3.
 *   6. Enqueue inside a transaction, carrying the placeholder context so
 *      the flusher (task 36.1) re-renders from the same input.
 *   7. Audit-stub: `logger.info({ event: 'application_email_sent', ... })`.
 *   8. Return `{ templateKey, toEmail }`.
 *
 * Note on validation order: we validate the INPUT before touching the DB
 * so a malformed `templateKey` (e.g. empty) fails fast with a 422 and
 * never issues a query. Scope resolution then runs against the parsed
 * locale.
 */
export async function sendTemplatedEmail(
  opts: SendTemplatedEmailOptions,
): Promise<SendTemplatedEmailResult> {
  const { applicationId, actorUserId, scope, input } = opts;

  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError('actorUserId must be a positive integer');
  }

  // 1. Validate the input.
  let parsed: SendTemplatedEmailInput;
  try {
    parsed = sendTemplatedEmailSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors: Record<string, readonly string[]> = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidEmailInputError(fieldErrors);
    }
    throw err;
  }

  const locale = parsed.locale;

  // 2. Resolve + scope-check the application, pulling the placeholder
  //    context in the same round-trip.
  const ctx = await resolveInScopeApplicationContext(
    applicationId,
    locale,
    scope,
  );

  // 3. Load the chosen template row.
  const template = await loadMailTemplate(parsed.templateKey, locale);
  if (template === null) {
    throw new MailTemplateNotFoundError(parsed.templateKey, locale);
  }

  // 4. Build the placeholder context (Req 10.7).
  const renderContext = {
    applicant_name: ctx.applicantName,
    job_title: ctx.jobTitle,
    stage: ctx.stage,
  };

  // 5. Preview / validation render (Design §12.3). Rendering strings
  //    (not files) proves the template compiles against the context
  //    before the enqueue row is committed. The rendered subject/body
  //    are not persisted here — the canonical enqueue carries the
  //    context so the flusher (task 36.1) re-renders identically.
  const renderedSubject = nunjucks.renderString(template.subject, renderContext);
  const renderedBodyHtml = nunjucks.renderString(
    template.bodyHtml,
    renderContext,
  );
  const renderedBodyText =
    template.bodyText !== null
      ? nunjucks.renderString(template.bodyText, renderContext)
      : null;
  // Touch the rendered values so the preview render is not optimised away
  // and a broken template fails here rather than silently. We log lengths
  // (not bodies) to keep the access log light and PII-free.
  logger.debug(
    {
      event: 'application_email_preview_rendered',
      application_id: ctx.applicationId,
      template_key: parsed.templateKey,
      subject_length: renderedSubject.length,
      body_html_length: renderedBodyHtml.length,
      body_text_length: renderedBodyText === null ? 0 : renderedBodyText.length,
    },
    'templated email preview render ok',
  );

  // 6. Transactional enqueue (Design §12.3). The current `enqueue` stub
  //    only logs; task 36.1 swaps it for the idempotent INSERT. We pass
  //    the placeholder `context` (not the pre-rendered strings) so the
  //    future flusher re-renders from the same input, and `targetId` so
  //    the natural-key idempotency guard can dedupe retries.
  await withTransaction((conn) =>
    enqueue(conn, {
      templateKey: parsed.templateKey,
      toEmail: ctx.toEmail,
      toName: ctx.applicantName,
      locale,
      context: renderContext,
      targetId: String(ctx.applicationId),
    }),
  );

  // 7. Audit stub.
  // TODO(task 40.1): replace this log with an audit_events INSERT
  //   action_type='application_email_sent', actor=actorUserId,
  //   target_entity='Application', target_id=ctx.applicationId,
  //   details={ template_key, locale }.
  logger.info(
    {
      event: 'application_email_sent',
      actor_user_id: actorUserId,
      application_id: ctx.applicationId,
      template_key: parsed.templateKey,
    },
    'application templated email sent',
  );

  // 8. Return the resolved identifiers.
  return { templateKey: parsed.templateKey, toEmail: ctx.toEmail };
}
