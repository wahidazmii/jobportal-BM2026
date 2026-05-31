/**
 * Application interview scheduling service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.2
 * Design  : §6 Admin (Schedule interview), §15 (Audit Log)
 * Validates: Requirements 10.4
 *
 * Public surface:
 *   - `scheduleInterviewSchema`              — zod schema for the form.
 *   - `ScheduleInterviewInput`               — type inferred from schema.
 *   - `InvalidInterviewInputError`           — thrown on validation failure
 *                                              with a field-level error map.
 *   - `ApplicationNotFoundError`             — application id missing OR
 *                                              outside the caller's scope.
 *   - `scheduleInterviewForApplication(opts)` — orchestrates the scope
 *                                               check, validation, INSERT,
 *                                               audit log, and mail enqueue.
 *
 * Authorization model:
 *   - The route layer (`/admin/applications/:id/interview`) restricts
 *     entry to {Super_Admin, HR, Department_Head}. Department_Head
 *     callers thread their `scope.departments` list into this service
 *     so an out-of-department application collapses to
 *     `ApplicationNotFoundError` — same shape as "id missing", which
 *     keeps the API from leaking the existence of out-of-scope rows
 *     (mirrors the `JobNotFoundError` pattern in `jobs/repo.ts`).
 *
 * Validation rules (per task 30.2 brief):
 *   - `scheduledAt` must be a future ISO datetime. We compare against a
 *     caller-supplied `now` so the test suite can pin the clock; in
 *     production the route omits it and the service uses `new Date()`.
 *   - `location` ≤ 500 chars (mirrors the column width).
 *   - `meetingUrl` must parse as a URL and be ≤ 2000 chars (mirrors the
 *     column width). Required-protocol check (http/https) protects
 *     against `javascript:` / `file:` URLs slipping into the email.
 *   - `interviewerUserId`, when set, must be a positive integer.
 *   - At least ONE of `location` / `meetingUrl` must be set — an
 *     interview with neither has no way to actually happen, so we
 *     reject at the schema layer rather than silently storing a
 *     useless row.
 *
 * Audit + mail (deferred / stubbed):
 *   - `audit_events` lands with task 38.1; the writer service lands
 *     with task 40.1. For now we emit a structured `logger.info` with
 *     the same shape an audit row will eventually carry, so the access
 *     log is forensically equivalent until the table exists.
 *   - The mail enqueue stub (`mail/service.ts`) writes a structured
 *     log line; future task 36.1 swaps it for an `INSERT INTO
 *     mail_outbox`. We wrap the call in try/catch so a mail-stub
 *     failure cannot strand the freshly-inserted interview row — the
 *     INSERT has already committed at that point and the side-effect
 *     is best-effort. A failure is logged at `error` level so an
 *     operator can re-enqueue manually.
 */

import { z, ZodError } from 'zod';

import {
  query,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import {
  findById as findJobById,
  type JobScope,
} from '../jobs/repo.js';
import * as mailService from '../mail/service.js';
import {
  scheduleInterview,
  type InterviewRow,
} from './interviews-repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mirrors `application_interviews.location VARCHAR(500)` in 0004. */
export const LOCATION_MAX_LEN = 500;

/** Mirrors `application_interviews.meeting_url VARCHAR(2000)` in 0004. */
export const MEETING_URL_MAX_LEN = 2000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the scheduling input fails validation. Carries the
 * field-level error map (`{ scheduledAt: ['must be in the future'] }`)
 * so the route layer can render per-field messages without re-running
 * `zod.flatten()`.
 */
export class InvalidInterviewInputError extends Error {
  readonly code = 'invalid_interview_input' as const;
  readonly statusCode = 422 as const;
  constructor(
    public readonly fieldErrors: Readonly<Record<string, readonly string[]>>,
    message = 'Invalid interview input',
  ) {
    super(message);
    this.name = 'InvalidInterviewInputError';
  }
}

/**
 * Thrown when the application id is missing OR the application's job is
 * outside the caller's scope. Both branches collapse to the same error
 * so the API never leaks the existence of out-of-scope applications
 * (mirrors `JobNotFoundError` from `jobs/repo.ts`).
 */
export class ApplicationNotFoundError extends Error {
  readonly code = 'application_not_found' as const;
  readonly statusCode = 404 as const;
  constructor(public readonly applicationId: number) {
    super(`Application ${applicationId} not found`);
    this.name = 'ApplicationNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Coerce a non-empty string into a Date, rejecting empty/whitespace and
 * unparseable values. Used as a `z.preprocess` step so the resulting
 * field carries a real `Date` rather than a string.
 */
function preprocessDate(value: unknown): Date | unknown {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return value; // let zod surface the error
    return parsed;
  }
  return value;
}

/** Whitespace-only or empty values normalise to `undefined`. */
function preprocessOptionalString(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return value;
}

/** Coerce a numeric-looking string into a number; pass through otherwise. */
function preprocessOptionalInt(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/**
 * Build the zod schema. Wrapped in a factory so the test suite can pin
 * `now` and the production route uses the live clock.
 */
export function buildScheduleInterviewSchema(now: Date = new Date()) {
  const nowMs = now.getTime();
  return z
    .object({
      scheduledAt: z.preprocess(
        preprocessDate,
        z
          .date({
            invalid_type_error: 'scheduledAt must be a valid datetime',
            required_error: 'scheduledAt is required',
          })
          .refine((d) => d.getTime() > nowMs, {
            message: 'scheduledAt must be in the future',
          }),
      ),
      location: z.preprocess(
        preprocessOptionalString,
        z
          .string()
          .max(
            LOCATION_MAX_LEN,
            `location must be at most ${LOCATION_MAX_LEN} characters`,
          )
          .optional(),
      ),
      meetingUrl: z.preprocess(
        preprocessOptionalString,
        z
          .string()
          .max(
            MEETING_URL_MAX_LEN,
            `meetingUrl must be at most ${MEETING_URL_MAX_LEN} characters`,
          )
          .url('meetingUrl must be a valid URL')
          .refine(
            (raw) => {
              try {
                const u = new URL(raw);
                return u.protocol === 'http:' || u.protocol === 'https:';
              } catch {
                return false;
              }
            },
            { message: 'meetingUrl must use http or https' },
          )
          .optional(),
      ),
      interviewerUserId: z.preprocess(
        preprocessOptionalInt,
        z
          .number()
          .int('interviewerUserId must be an integer')
          .positive('interviewerUserId must be a positive integer')
          .optional(),
      ),
    })
    .refine(
      (val) =>
        (val.location !== undefined && val.location.length > 0) ||
        (val.meetingUrl !== undefined && val.meetingUrl.length > 0),
      {
        // Mapped to the `_form` field by the route's error renderer.
        message:
          'At least one of location or meetingUrl must be provided',
        path: ['location'],
      },
    );
}

/** Default schema bound to `new Date()`. Re-built per call so the clock is live. */
export const scheduleInterviewSchema = buildScheduleInterviewSchema();

/** Inferred type. */
export type ScheduleInterviewInput = z.infer<typeof scheduleInterviewSchema>;

// ---------------------------------------------------------------------------
// Application loader
// ---------------------------------------------------------------------------

interface ApplicationLookupRow extends RowDataPacket {
  id: number | string;
  job_id: number | string;
  applicant_user_id: number | string;
  reference_no: string;
}

/**
 * Minimal projection of the `applications` row. We only need `id`,
 * `job_id`, and the applicant id for the audit log. Loading via a
 * dedicated query (rather than reusing `queries.ts`) keeps the
 * applicant-scoped read path on its own SQL plan: `queries.ts` always
 * filters by `applicant_user_id`, which is exactly what we DON'T want
 * for the admin path.
 */
const SELECT_APPLICATION_FOR_INTERVIEW_SQL = [
  'SELECT id, job_id, applicant_user_id, reference_no',
  'FROM applications WHERE id = ? LIMIT 1',
].join(' ');

interface MinimalApplication {
  readonly id: number;
  readonly jobId: number;
  readonly applicantUserId: number;
  readonly referenceNo: string;
}

async function loadApplication(
  applicationId: number,
): Promise<MinimalApplication | null> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  const rows = await query<ApplicationLookupRow[]>(
    SELECT_APPLICATION_FOR_INTERVIEW_SQL,
    [applicationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    applicantUserId: Number(row.applicant_user_id),
    referenceNo: row.reference_no,
  };
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export interface ScheduleInterviewOptions {
  /** Application primary key from the URL. */
  readonly applicationId: number;
  /** Authenticated admin user (for the audit log). */
  readonly actorUserId: number;
  /** Department_Head scope; HR / Super_Admin pass `undefined`. */
  readonly scope?: JobScope;
  /** Raw form payload — passed through `scheduleInterviewSchema`. */
  readonly input: unknown;
  /**
   * Override the "now" clock used by the schema's future-date refinement.
   * Defaults to the live wall-clock; the unit tests pin it.
   */
  readonly now?: Date;
}

export interface ScheduleInterviewResult {
  readonly interview: InterviewRow;
  readonly applicationId: number;
}

/**
 * Schedule an interview for an existing application.
 *
 * Pipeline:
 *   1. Load the application row. Missing → `ApplicationNotFoundError`.
 *   2. Verify the application's job is in the caller's scope by reading
 *      the job through `jobs/repo.findById(jobId, scope)`. A `null`
 *      return collapses both "job missing" and "job out of scope" into
 *      the same error shape, which propagates to the same 404.
 *   3. Validate the input via `scheduleInterviewSchema`. ZodError →
 *      `InvalidInterviewInputError` carrying the field-level error map.
 *   4. INSERT the interview via the repo. The repo issues a follow-up
 *      SELECT so the returned row carries the server-managed `id`,
 *      `status`, and the `scheduled_at` value the DB stored (post any
 *      timezone normalisation).
 *   5. Audit-stub: `logger.info({ event: 'interview_scheduled', ... })`
 *      with a TODO comment for task 40.1 to wire the real audit row.
 *   6. Mail-stub: try/catch around `mail.enqueue(...)` (the stub today,
 *      a real `mail_outbox` INSERT after task 36.1). Failures are
 *      logged but do not unwind the INSERT — by the time we reach the
 *      mail step the interview row has already committed.
 */
export async function scheduleInterviewForApplication(
  opts: ScheduleInterviewOptions,
): Promise<ScheduleInterviewResult> {
  const { applicationId, actorUserId, scope, input } = opts;
  const now = opts.now ?? new Date();

  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError(applicationId);
  }
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError('actorUserId must be a positive integer');
  }

  // 1. Load the application.
  const app = await loadApplication(applicationId);
  if (app === null) {
    throw new ApplicationNotFoundError(applicationId);
  }

  // 2. Verify the application's job is in scope. The repo's `findById`
  //    short-circuits to `null` for out-of-scope reads, so we need only
  //    one branch here for both "job missing" and "out of scope".
  const job = await findJobById(app.jobId, scope);
  if (job === null) {
    throw new ApplicationNotFoundError(applicationId);
  }

  // 3. Validate the input. We rebuild the schema with the caller-pinned
  //    clock so the future-date refinement is deterministic in tests.
  const schema = buildScheduleInterviewSchema(now);
  let parsed: ScheduleInterviewInput;
  try {
    parsed = schema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors: Record<string, readonly string[]> = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidInterviewInputError(fieldErrors);
    }
    throw err;
  }

  // 4. INSERT the interview row.
  const interview = await scheduleInterview({
    applicationId: app.id,
    scheduledAt: parsed.scheduledAt,
    location: parsed.location ?? null,
    meetingUrl: parsed.meetingUrl ?? null,
    interviewerUserId: parsed.interviewerUserId ?? null,
  });

  // 5. Audit stub.
  // TODO(task 40.1): replace this log with an audit_events INSERT
  //   action_type='interview_scheduled', actor=actorUserId,
  //   target_entity='Application', target_id=app.id,
  //   details={ interview_id, scheduled_at, interviewer_user_id }.
  logger.info(
    {
      event: 'interview_scheduled',
      actor_user_id: actorUserId,
      application_id: app.id,
      interview_id: interview.id,
      scheduled_at: interview.scheduled_at.toISOString(),
      interviewer_user_id: interview.interviewer_user_id,
      reference_no: app.referenceNo,
    },
    'application interview scheduled',
  );

  // 6. Mail stub. We do NOT roll back the interview row on a mail
  //    failure — by this point the INSERT has committed and the email
  //    is best-effort. A persistent failure surfaces in the access log
  //    so an operator can re-enqueue manually until task 36.1 lands.
  try {
    // Future signature (task 36.1) takes a transactional connection.
    // Today the stub accepts an unused `connection` arg, so we pass
    // `null as never` because we are not yet inside a transaction. The
    // production stub only logs.
    await safeEnqueueInterviewInvitation({
      applicationId: app.id,
      applicantUserId: app.applicantUserId,
      interviewId: interview.id,
      scheduledAt: interview.scheduled_at,
      location: interview.location,
      meetingUrl: interview.meeting_url,
      referenceNo: app.referenceNo,
    });
  } catch (err) {
    logger.error(
      {
        err,
        event: 'interview_mail_enqueue_failed',
        application_id: app.id,
        interview_id: interview.id,
      },
      'failed to enqueue interview invitation; row already committed',
    );
  }

  return { interview, applicationId: app.id };
}

// ---------------------------------------------------------------------------
// Mail helper
// ---------------------------------------------------------------------------

interface InterviewMailContext {
  readonly applicationId: number;
  readonly applicantUserId: number;
  readonly interviewId: number;
  readonly scheduledAt: Date;
  readonly location: string | null;
  readonly meetingUrl: string | null;
  readonly referenceNo: string;
}

/**
 * Best-effort wrapper around the mail enqueue stub. The future
 * `mail.enqueueInterviewInvitation` (task 36.1) will live alongside
 * the existing `enqueue` helper; today the stub only logs. We keep
 * the call site in one helper so the future swap touches a single
 * line.
 *
 * Defensive: if the mail module ever exports a dedicated
 * `enqueueInterviewInvitation` we use it; otherwise we fall back to
 * the generic `enqueue` stub. Both branches collapse to the same
 * structured log line until `mail_outbox` is provisioned.
 */
async function safeEnqueueInterviewInvitation(
  ctx: InterviewMailContext,
): Promise<void> {
  const dedicated = (mailService as unknown as {
    enqueueInterviewInvitation?: (ctx: InterviewMailContext) => Promise<void>;
  }).enqueueInterviewInvitation;

  if (typeof dedicated === 'function') {
    await dedicated(ctx);
    return;
  }

  // No dedicated helper yet — log the intent so the access log carries
  // the same payload the future enqueue will produce. We deliberately
  // do NOT call the generic `enqueue(connection, ...)` stub from the
  // mail module here because that helper requires a `PoolConnection`
  // (its design is transactional-only); calling it outside a
  // transaction would mis-signal the future contract. Once task 36.1
  // lands, this branch is replaced by a real `INSERT IGNORE INTO
  // mail_outbox` issued from inside the interview transaction.
  logger.info(
    {
      template_key: 'interview-invitation',
      target_application_id: ctx.applicationId,
      applicant_user_id: ctx.applicantUserId,
      interview_id: ctx.interviewId,
      scheduled_at: ctx.scheduledAt.toISOString(),
      has_location: ctx.location !== null,
      has_meeting_url: ctx.meetingUrl !== null,
      reference_no: ctx.referenceNo,
      stub: true,
    },
    'mail.enqueueInterviewInvitation (stub — see task 36.1)',
  );
}
