/**
 * Mail-template editor service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 36.2 (Templated mail editor di admin)
 * Design  : §15 (Audit Log), §6 Admin (GET/POST /admin/mail-templates)
 * Validates: Requirements 10.7, 12.1
 *
 * Public surface:
 *   - `saveTemplateSchema`             — zod schema for the editor payload.
 *   - `SaveTemplateInput`              — type inferred from the schema.
 *   - `InvalidTemplateInputError`      — thrown on validation failure with
 *                                        a field-level error map (422).
 *   - `TEMPLATE_LOCALES`               — the supported locale set {id,en}.
 *   - `saveTemplate({ actorUserId, input })` — validate → upsert →
 *                                        audit-stub.
 *   - `listAll()`                      — pass-through to the repo list.
 *   - `getOne(key, locale)`            — pass-through to the repo read.
 *
 * Authorization model:
 *   - The route layer (`/admin/mail-templates`) restricts entry to
 *     {Super_Admin, HR} per Design §6 Admin + Req 11.3 (HR manages mail
 *     templates; Department_Head does not). This service performs no
 *     scoping — mail templates are global, not department-scoped.
 *
 * Validation rules (per task 36.2 brief):
 *   - `key`        : trimmed, 1..64 chars, slug-ish
 *                    (`[a-z0-9][a-z0-9_-]*`) to match the file-system
 *                    template-key convention (`verify`, `password_reset`,
 *                    `application_confirm`, …).
 *   - `locale`     : one of {id, en} (Design §13 / Req 17).
 *   - `subject`    : trimmed, 1..255 chars (mirrors the column width).
 *   - `bodyHtml`   : non-empty, bounded to MEDIUMTEXT-reasonable cap.
 *   - `bodyText`   : optional; empty / whitespace collapses to null
 *                    (the column is nullable — the enqueue path derives a
 *                    plaintext fallback when absent, see mail/service.ts).
 *
 * Audit (deferred / stubbed):
 *   - The audit row (`audit_events`, action `mail_template_change`) is
 *     written by task 40.1; for now we emit a structured `logger.info`
 *     carrying the shape the future audit row will eventually persist
 *     (mirrors the stub pattern in `notes-service.ts`).
 */

import { z, ZodError } from 'zod';

import { logger } from '../../infra/logger.js';
import {
  findTemplate,
  listTemplates,
  upsertTemplate,
  type MailTemplateRecord,
} from './templates-repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Supported template locales (Design §13 / Req 17). */
export const TEMPLATE_LOCALES = ['id', 'en'] as const;

/** Mirrors `mail_templates.key VARCHAR(64)` in 0006. */
export const TEMPLATE_KEY_MAX_LEN = 64;

/** Mirrors `mail_templates.subject VARCHAR(255)` in 0006. */
export const TEMPLATE_SUBJECT_MAX_LEN = 255;

/**
 * Reasonable cap on the HTML body. The column is `MEDIUMTEXT` (~16 MB),
 * but a hand-edited transactional template never approaches that; we cap
 * at 64 KB so a runaway paste cannot bloat the row or the render path.
 */
export const TEMPLATE_BODY_MAX_LEN = 65_535;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the template input fails validation. Carries the
 * field-level error map (`{ subject: ['must not be empty'] }`) so the
 * route layer can render per-field messages without re-running
 * `zod.flatten()`.
 */
export class InvalidTemplateInputError extends Error {
  readonly code = 'invalid_template_input' as const;
  readonly statusCode = 422 as const;
  constructor(
    public readonly fieldErrors: Readonly<Record<string, readonly string[]>>,
    message = 'Invalid mail template input',
  ) {
    super(message);
    this.name = 'InvalidTemplateInputError';
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Trim a string value; non-strings pass through for zod to reject. */
function preprocessTrim(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  return value;
}

/**
 * Normalise the optional text body: trim, and collapse an empty /
 * whitespace-only value to `null` so the nullable column stores a clean
 * absence rather than an empty string. Non-strings pass through (an
 * absent field arrives as `undefined`, which also resolves to `null`).
 */
function preprocessBodyText(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

/**
 * The editor form schema. `key` is slug-ish and bounded to the column
 * width; `locale` is the {id,en} enum; `subject` / `bodyHtml` are
 * required and bounded; `bodyText` is optional and nullable.
 */
export const saveTemplateSchema = z.object({
  key: z.preprocess(
    preprocessTrim,
    z
      .string({
        invalid_type_error: 'key must be a string',
        required_error: 'key is required',
      })
      .min(1, 'key must not be empty')
      .max(
        TEMPLATE_KEY_MAX_LEN,
        `key must be at most ${TEMPLATE_KEY_MAX_LEN} characters`,
      )
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        'key must be lowercase letters, digits, underscores or hyphens',
      ),
  ),
  locale: z.preprocess(
    preprocessTrim,
    z.enum(TEMPLATE_LOCALES, {
      invalid_type_error: 'locale must be one of id, en',
      required_error: 'locale is required',
    }),
  ),
  subject: z.preprocess(
    preprocessTrim,
    z
      .string({
        invalid_type_error: 'subject must be a string',
        required_error: 'subject is required',
      })
      .min(1, 'subject must not be empty')
      .max(
        TEMPLATE_SUBJECT_MAX_LEN,
        `subject must be at most ${TEMPLATE_SUBJECT_MAX_LEN} characters`,
      ),
  ),
  bodyHtml: z.preprocess(
    preprocessTrim,
    z
      .string({
        invalid_type_error: 'bodyHtml must be a string',
        required_error: 'bodyHtml is required',
      })
      .min(1, 'bodyHtml must not be empty')
      .max(
        TEMPLATE_BODY_MAX_LEN,
        `bodyHtml must be at most ${TEMPLATE_BODY_MAX_LEN} characters`,
      ),
  ),
  bodyText: z.preprocess(
    preprocessBodyText,
    z
      .string()
      .max(
        TEMPLATE_BODY_MAX_LEN,
        `bodyText must be at most ${TEMPLATE_BODY_MAX_LEN} characters`,
      )
      .nullable(),
  ),
});

/** Inferred input type. */
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;

// ---------------------------------------------------------------------------
// Public service — saveTemplate
// ---------------------------------------------------------------------------

export interface SaveTemplateOptions {
  /** Authenticated admin user (audit actor). */
  readonly actorUserId: number;
  /** Raw form payload — passed through `saveTemplateSchema`. */
  readonly input: unknown;
}

/**
 * Validate and upsert a mail template (Req 10.7).
 *
 * Pipeline:
 *   1. Validate the input via `saveTemplateSchema`. ZodError →
 *      `InvalidTemplateInputError` carrying the field-level error map.
 *   2. Upsert the row via the repo (INSERT ... ON DUPLICATE KEY UPDATE on
 *      the composite PK), reading the persisted row back.
 *   3. Audit-stub: `logger.info({ event: 'mail_template_change', ... })`.
 *   4. Return the persisted `MailTemplateRecord`.
 */
export async function saveTemplate(
  opts: SaveTemplateOptions,
): Promise<MailTemplateRecord> {
  const { actorUserId, input } = opts;

  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError('actorUserId must be a positive integer');
  }

  // 1. Validate the input.
  let parsed: SaveTemplateInput;
  try {
    parsed = saveTemplateSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors: Record<string, readonly string[]> = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidTemplateInputError(fieldErrors);
    }
    throw err;
  }

  // 2. Upsert the row.
  const record = await upsertTemplate({
    key: parsed.key,
    locale: parsed.locale,
    subject: parsed.subject,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText,
  });

  // 3. Audit stub.
  // TODO(task 40.1): replace this log with an audit_events INSERT
  //   action_type='mail_template_change', actor=actorUserId,
  //   target_entity='MailTemplate', target_id="<key>:<locale>",
  //   details={ template_key, locale }.
  logger.info(
    {
      event: 'mail_template_change',
      actor_user_id: actorUserId,
      template_key: record.key,
      locale: record.locale,
    },
    'mail template changed',
  );

  // 4. Return the persisted row.
  return record;
}

// ---------------------------------------------------------------------------
// Public service — read paths
// ---------------------------------------------------------------------------

/** List every mail template, ordered by (`key`, locale). */
export async function listAll(): Promise<MailTemplateRecord[]> {
  return listTemplates();
}

/**
 * Look up a single template by its composite PK. Returns `null` when the
 * `(key, locale)` pair has no row.
 */
export async function getOne(
  key: string,
  locale: string,
): Promise<MailTemplateRecord | null> {
  return findTemplate(key, locale);
}
