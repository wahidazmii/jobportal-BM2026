/**
 * Job alert service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 33.1
 * Design  : §6 Applicant_Area, §7.2 (job_alerts), §11.3 (alert-digest cron)
 * Validates: Requirements 7.1
 *
 * Public surface:
 *   - `MAX_ALERTS_PER_APPLICANT = 10` — the app-level cap from Req 7.1
 *                                       (design §7.2 "app-level guard").
 *   - `alertSchema` / `AlertInput`    — zod validation for the create form.
 *   - `AlertCapError`                 — thrown when an INSERT would push
 *                                       the per-applicant count past 10.
 *                                       Route layer maps to HTTP 422.
 *   - `InvalidAlertInputError`        — thrown when validation fails;
 *                                       carries a `fieldErrors` map.
 *                                       Route layer maps to HTTP 422.
 *   - `AlertNotFoundError`            — thrown by `removeAlert` when the
 *                                       id is missing or not owned.
 *                                       Route layer maps to HTTP 404.
 *   - `createAlert({ applicantUserId, input })`
 *   - `listAlerts(applicantUserId)`
 *   - `removeAlert({ applicantUserId, id })`
 *
 * Validation contract (task 33.1):
 *   - `keyword`     : optional, trimmed, <= 100 chars (matches the
 *                     VARCHAR(100) column). An empty / whitespace-only
 *                     value normalises to `null` ("no keyword filter").
 *   - `locations`   : optional `string[]` of non-empty, trimmed city
 *                     names. The form may submit them as repeated
 *                     fields (`locations=Jakarta&locations=Bandung`),
 *                     a single comma-separated string
 *                     (`locations=Jakarta, Bandung`), or a single
 *                     value — all normalise to `string[]`. An empty
 *                     selection normalises to `null`.
 *   - `departments` : optional array of positive integer
 *                     `departments.id` values, accepting the same
 *                     repeated / comma-separated shapes as locations.
 *                     An empty selection normalises to `null`.
 *   - `frequency`   : required, exactly `'Daily'` or `'Weekly'`.
 *
 * Why the cap runs inside the transaction:
 *   A naïve "SELECT COUNT then INSERT" loses to two concurrent POSTs
 *   both reading 9 and both inserting → 11. We hold a connection, lock
 *   the applicant's rows with `SELECT COUNT(*) ... FOR UPDATE`, then
 *   INSERT, so the second request observes the freshly-inserted row and
 *   correctly rejects with `AlertCapError`.
 */

import { z } from 'zod';

import { withTransaction, type PoolConnection } from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import {
  countForApplicant,
  insertAlert,
  listForApplicant,
  deleteAlert,
  type AlertFrequency,
  type AlertRow,
} from './repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum job alerts per applicant per Req 7.1 (design §7.2). */
export const MAX_ALERTS_PER_APPLICANT = 10;

/** Maximum keyword length, matching the `job_alerts.keyword` column. */
export const MAX_KEYWORD_LENGTH = 100;

/** Allowed `frequency` ENUM values (design §7.2). */
export const ALERT_FREQUENCIES = ['Daily', 'Weekly'] as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `createAlert` when the applicant already has
 * `MAX_ALERTS_PER_APPLICANT` alerts. The route layer maps this to HTTP
 * 422 with a banner asking the user to delete an existing alert first.
 */
export class AlertCapError extends Error {
  readonly code = 'alert_cap_reached' as const;
  readonly status = 422 as const;
  constructor(public readonly limit: number) {
    super(
      `Job alert cap reached (${limit}). ` +
        `Remove an existing alert before adding a new one.`,
    );
    this.name = 'AlertCapError';
  }
}

/**
 * Thrown by `createAlert` when the submitted form fails validation.
 * Carries a `fieldErrors` map (field name → messages) so the route can
 * re-render the form with field-level errors. The route layer maps this
 * to HTTP 422.
 */
export class InvalidAlertInputError extends Error {
  readonly code = 'invalid_alert_input' as const;
  readonly status = 422 as const;
  constructor(public readonly fieldErrors: Record<string, string[]>) {
    super('Invalid job alert input');
    this.name = 'InvalidAlertInputError';
  }
}

/**
 * Thrown by `removeAlert` when the id either does not exist or belongs
 * to a different applicant. The two cases collapse to one error so the
 * API never leaks the existence of another user's row. Route layer
 * maps this to HTTP 404.
 */
export class AlertNotFoundError extends Error {
  readonly code = 'alert_not_found' as const;
  readonly status = 404 as const;
  constructor(public readonly id: number) {
    super(`Job alert ${id} not found`);
    this.name = 'AlertNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Normalise the loose form shape for a string-list field into a clean
 * `string[]`. Accepts:
 *   - a real array of strings (repeated form fields),
 *   - a single comma-separated string (`"Jakarta, Bandung"`),
 *   - a single bare string.
 * Each token is trimmed and empties are dropped. Returns `[]` for
 * "nothing supplied" so the schema can normalise that to `null`.
 */
function toStringList(value: unknown): string[] {
  const raw: unknown[] =
    value === undefined || value === null
      ? []
      : Array.isArray(value)
        ? value
        : [value];

  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      if (typeof item === 'number') {
        const s = String(item).trim();
        if (s !== '') out.push(s);
      }
      continue;
    }
    // Split on commas so a single comma-separated field expands.
    for (const part of item.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') out.push(trimmed);
    }
  }
  return out;
}

const keywordSchema = z
  .union([z.string(), z.undefined(), z.null()])
  .transform((v, ctx): string | null => {
    if (v === undefined || v === null) return null;
    const trimmed = v.trim();
    if (trimmed === '') return null;
    if (trimmed.length > MAX_KEYWORD_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Keyword must be at most ${MAX_KEYWORD_LENGTH} characters`,
      });
      return null;
    }
    return trimmed;
  });

const locationsSchema = z
  .unknown()
  .transform((v): string[] | null => {
    const list = toStringList(v);
    return list.length > 0 ? list : null;
  });

const departmentsSchema = z
  .unknown()
  .transform((v, ctx): number[] | null => {
    const list = toStringList(v);
    if (list.length === 0) return null;
    const out: number[] = [];
    for (const token of list) {
      const n = Number(token);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Each department must be a positive integer id',
        });
        return null;
      }
      out.push(n);
    }
    return out;
  });

const frequencySchema = z
  .union([z.string(), z.undefined(), z.null()])
  .transform((v, ctx): AlertFrequency => {
    const trimmed = typeof v === 'string' ? v.trim() : '';
    if (trimmed === 'Daily' || trimmed === 'Weekly') {
      return trimmed;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Frequency must be either Daily or Weekly',
    });
    return 'Daily';
  });

/**
 * Public alert schema. `.strip()` (the zod default for `.object`) drops
 * unknown keys so a stray `_csrf` field does not cause a hard failure —
 * the route also strips it, but defence-in-depth keeps the service
 * usable standalone.
 */
export const alertSchema = z.object({
  keyword: keywordSchema,
  locations: locationsSchema,
  departments: departmentsSchema,
  frequency: frequencySchema,
});

/** Strongly-typed input shape after validation. */
export type AlertInput = z.infer<typeof alertSchema>;

/**
 * Validate raw form input via {@link alertSchema}, converting a
 * `ZodError` into an {@link InvalidAlertInputError} carrying the
 * field-error map the templates consume.
 */
function validateInput(raw: unknown): AlertInput {
  const parsed = alertSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    const fieldErrors: Record<string, string[]> = {};
    for (const [key, msgs] of Object.entries(flat)) {
      if (msgs && msgs.length > 0) {
        fieldErrors[key] = msgs;
      }
    }
    throw new InvalidAlertInputError(fieldErrors);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new job alert for the applicant.
 *
 * Pipeline:
 *   1. Validate `input` (throws `InvalidAlertInputError` on failure).
 *   2. Inside a single transaction:
 *        a. `countForApplicant` under `FOR UPDATE` to lock the rows.
 *        b. If the count is already at the cap → `AlertCapError`
 *           (no INSERT happens).
 *        c. Otherwise INSERT and return the canonical row.
 *
 * Note: validation runs BEFORE the transaction so an invalid submission
 * never opens a connection or takes a lock.
 */
export async function createAlert(params: {
  applicantUserId: number;
  input: unknown;
}): Promise<AlertRow> {
  const { applicantUserId } = params;
  const input = validateInput(params.input);

  return withTransaction(async (conn: PoolConnection) => {
    const current = await countForApplicant(conn, applicantUserId);
    if (current >= MAX_ALERTS_PER_APPLICANT) {
      throw new AlertCapError(MAX_ALERTS_PER_APPLICANT);
    }

    const row = await insertAlert(
      {
        applicantUserId,
        keyword: input.keyword,
        locations: input.locations,
        departments: input.departments,
        frequency: input.frequency,
      },
      conn,
    );

    logger.info(
      {
        event: 'alert_create',
        user_id: applicantUserId,
        alert_id: row.id,
        frequency: row.frequency,
      },
      'applicant.alerts: alert created',
    );

    return row;
  });
}

/**
 * List every alert owned by the applicant, newest first, with the JSON
 * columns parsed into arrays.
 */
export async function listAlerts(applicantUserId: number): Promise<AlertRow[]> {
  return listForApplicant(applicantUserId);
}

/**
 * Delete an alert scoped to the owner.
 *
 * Throws `AlertNotFoundError` when nothing matched the
 * `(applicantUserId, id)` pair — the caller (route) can choose to treat
 * that as idempotent success or surface a 404.
 */
export async function removeAlert(params: {
  applicantUserId: number;
  id: number;
}): Promise<void> {
  const { applicantUserId, id } = params;
  const removed = await deleteAlert(applicantUserId, id);
  if (!removed) {
    throw new AlertNotFoundError(id);
  }
  logger.info(
    { event: 'alert_delete', user_id: applicantUserId, alert_id: id },
    'applicant.alerts: alert deleted',
  );
}
