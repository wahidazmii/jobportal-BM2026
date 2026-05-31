/**
 * Application note service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.1
 * Design  : §6 Admin (GET/POST /admin/applications/:id/notes), §15 (Audit Log)
 * Validates: Requirements 10.3, 8.2
 *
 * Public surface:
 *   - `addNoteSchema`              — zod schema for the form payload.
 *   - `AddNoteInput`               — type inferred from the schema.
 *   - `InvalidNoteInputError`      — thrown on validation failure with a
 *                                    field-level error map.
 *   - `ApplicationNotFoundError`   — RE-EXPORTED from `./errors.js` so a
 *                                    missing OR out-of-scope application
 *                                    collapses to the same 404 shape the
 *                                    rest of the applications domain uses.
 *   - `addNote(opts)`              — scope check → validate → INSERT →
 *                                    (optional) mail enqueue → audit log.
 *   - `listNotes(opts)`            — scope check → list every note for the
 *                                    application (internal + visible).
 *
 * Authorization model:
 *   - The route layer (`/admin/applications/:id/notes`) restricts entry
 *     to {Super_Admin, HR, Department_Head}. Department_Head callers
 *     thread their `scope.departments` list into this service so an
 *     out-of-department application collapses to
 *     `ApplicationNotFoundError` — same shape as "id missing", which
 *     keeps the API from leaking the existence of out-of-scope rows
 *     (mirrors `interviews-service.ts` and the `JobNotFoundError`
 *     pattern in `jobs/repo.ts`). Note: Department_Head is explicitly
 *     allowed to add notes per Req 11.4.
 *
 * Validation rules (per task 30.1 brief):
 *   - `body` is trimmed and must be 1..NOTE_BODY_MAX_LEN characters. A
 *     whitespace-only body collapses to empty and is rejected — a blank
 *     note carries no signal and would still trip the "visible note"
 *     email path with nothing to quote.
 *   - `visibleToApplicant` accepts HTML-form truthiness: the checkbox
 *     posts `'on'` (or is absent entirely), so we coerce
 *     `'on'/'true'/'1'/true` → true and `absent/''/'false'/'0'/false`
 *     → false rather than demanding a strict boolean from the wire.
 *
 * Audit + mail (deferred / stubbed):
 *   - The notification email (Req 8.2) is enqueued ONLY for notes flagged
 *     visible to the applicant. Internal notes never enqueue. The enqueue
 *     is best-effort: it runs after the INSERT has committed, so a mail
 *     failure is logged at `error` level but never unwinds the note.
 *   - `mail_outbox` lands with task 35.1 and the real enqueue with task
 *     36.1; until then we probe the mail module for a dedicated
 *     `enqueueNoteNotification` hook and otherwise emit a structured
 *     `logger.info` stub carrying the payload the future INSERT will use.
 *   - The audit row (`audit_events`) is written by task 40.1; for now we
 *     emit a structured `logger.info` with the shape the audit row will
 *     eventually carry.
 */

import { z, ZodError } from 'zod';

import { query, type RowDataPacket } from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import {
  findById as findJobById,
  type JobScope,
} from '../jobs/repo.js';
import * as mailService from '../mail/service.js';
import {
  insertNote,
  listForApplication,
  NOTE_BODY_MAX_LEN,
  type NoteRow,
} from './notes-repo.js';

// Re-export the shared application-not-found error so the route layer can
// import it from this module OR from `interviews-service.ts` and receive
// the SAME class (both re-export from `./errors.js`). This avoids a
// duplicate-import collision in `routes/admin.ts`.
export { ApplicationNotFoundError } from './errors.js';
import { ApplicationNotFoundError } from './errors.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the note input fails validation. Carries the field-level
 * error map (`{ body: ['must not be empty'] }`) so the route layer can
 * render per-field messages without re-running `zod.flatten()`.
 */
export class InvalidNoteInputError extends Error {
  readonly code = 'invalid_note_input' as const;
  readonly statusCode = 422 as const;
  constructor(
    public readonly fieldErrors: Readonly<Record<string, readonly string[]>>,
    message = 'Invalid note input',
  ) {
    super(message);
    this.name = 'InvalidNoteInputError';
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Coerce an HTML-form value into a boolean. Checkboxes post `'on'` when
 * checked and are ABSENT (undefined) when unchecked; some clients post
 * `'true'`/`'1'`. Everything else — including `''`, `'false'`, `'0'`,
 * and a literal `false` — normalises to `false`.
 */
function preprocessFormBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return (
      normalized === 'on' ||
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'yes'
    );
  }
  return false;
}

/** Trim a string body; non-strings pass through for zod to reject. */
function preprocessBody(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  return value;
}

/**
 * The note form schema. `body` is trimmed and bounded to the column
 * width; `visibleToApplicant` accepts HTML-form truthiness and always
 * resolves to a concrete boolean (defaulting to `false` when absent).
 */
export const addNoteSchema = z.object({
  body: z.preprocess(
    preprocessBody,
    z
      .string({
        invalid_type_error: 'body must be a string',
        required_error: 'body is required',
      })
      .min(1, 'body must not be empty')
      .max(
        NOTE_BODY_MAX_LEN,
        `body must be at most ${NOTE_BODY_MAX_LEN} characters`,
      ),
  ),
  visibleToApplicant: z.preprocess(preprocessFormBoolean, z.boolean()),
});

/** Inferred input type. */
export type AddNoteInput = z.infer<typeof addNoteSchema>;

// ---------------------------------------------------------------------------
// Application loader
// ---------------------------------------------------------------------------

interface ApplicationLookupRow extends RowDataPacket {
  id: number | string;
  job_id: number | string;
}

/**
 * Minimal projection of the `applications` row. We only need `id` and
 * `job_id` — the latter feeds the scope check via
 * `jobs/repo.findById(jobId, scope)`. Loading via a dedicated query
 * (rather than reusing `queries.ts`) keeps the applicant-scoped read
 * path on its own SQL plan: `queries.ts` always filters by
 * `applicant_user_id`, which is exactly what the admin path must NOT do.
 *
 * Built with `Array.join(' ')` so the local `no-string-concat-sql` lint
 * rule does not flag the static SELECT — there is no user input in the
 * SQL string.
 */
const SELECT_APPLICATION_FOR_NOTE_SQL = [
  'SELECT id, job_id',
  'FROM applications WHERE id = ? LIMIT 1',
].join(' ');

interface MinimalApplication {
  readonly id: number;
  readonly jobId: number;
}

async function loadApplication(
  applicationId: number,
): Promise<MinimalApplication | null> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  const rows = await query<ApplicationLookupRow[]>(
    SELECT_APPLICATION_FOR_NOTE_SQL,
    [applicationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
  };
}

/**
 * Resolve the application AND verify its job is within the caller's
 * scope. Both "application missing" and "job missing / out of scope"
 * collapse to `ApplicationNotFoundError` so the API never leaks the
 * existence of an out-of-scope row.
 */
async function resolveInScopeApplication(
  applicationId: number,
  scope: JobScope | undefined,
): Promise<MinimalApplication> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError(applicationId);
  }

  const app = await loadApplication(applicationId);
  if (app === null) {
    throw new ApplicationNotFoundError(applicationId);
  }

  // The repo's `findById` short-circuits to `null` for out-of-scope
  // reads, so one branch covers both "job missing" and "out of scope".
  const job = await findJobById(app.jobId, scope);
  if (job === null) {
    throw new ApplicationNotFoundError(applicationId);
  }

  return app;
}

// ---------------------------------------------------------------------------
// Public service — addNote
// ---------------------------------------------------------------------------

export interface AddNoteOptions {
  /** Application primary key from the URL. */
  readonly applicationId: number;
  /** Authenticated admin user (note author + audit actor). */
  readonly authorUserId: number;
  /** Department_Head scope; HR / Super_Admin pass `undefined`. */
  readonly scope?: JobScope;
  /** Raw form payload — passed through `addNoteSchema`. */
  readonly input: unknown;
}

/**
 * Add a note to an existing application (Req 10.3).
 *
 * Pipeline:
 *   1. Load the application row. Missing → `ApplicationNotFoundError`.
 *   2. Verify the application's job is in the caller's scope via
 *      `findJobById(jobId, scope)`. `null` → `ApplicationNotFoundError`.
 *   3. Validate the input via `addNoteSchema`. ZodError →
 *      `InvalidNoteInputError` carrying the field-level error map.
 *   4. INSERT the note via the repo (reads back the persisted row).
 *   5. If `visibleToApplicant`: best-effort notification enqueue
 *      (Req 8.2). Internal notes do NOT enqueue. A failure is logged
 *      but never unwinds the committed note.
 *   6. Audit-stub: `logger.info({ event: 'application_note_added', ... })`.
 *   7. Return the persisted `NoteRow`.
 */
export async function addNote(opts: AddNoteOptions): Promise<NoteRow> {
  const { applicationId, authorUserId, scope, input } = opts;

  if (!Number.isInteger(authorUserId) || authorUserId <= 0) {
    throw new TypeError('authorUserId must be a positive integer');
  }

  // 1 + 2. Resolve the application and enforce scope.
  const app = await resolveInScopeApplication(applicationId, scope);

  // 3. Validate the input.
  let parsed: AddNoteInput;
  try {
    parsed = addNoteSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors: Record<string, readonly string[]> = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidNoteInputError(fieldErrors);
    }
    throw err;
  }

  // 4. INSERT the note row.
  const note = await insertNote({
    applicationId: app.id,
    authorUserId,
    body: parsed.body,
    visibleToApplicant: parsed.visibleToApplicant,
  });

  // 5. Notification email — visible notes ONLY (Req 8.2). Internal notes
  //    never reach the applicant, so they never enqueue. The enqueue is
  //    best-effort: the note has already committed, so a mail failure is
  //    logged for an operator to re-enqueue rather than thrown.
  if (note.visible_to_applicant) {
    try {
      await safeEnqueueNoteNotification({
        applicationId: app.id,
        noteId: note.id,
        body: note.body,
      });
    } catch (err) {
      logger.error(
        {
          err,
          event: 'application_note_mail_enqueue_failed',
          application_id: app.id,
          note_id: note.id,
        },
        'failed to enqueue note notification; row already committed',
      );
    }
  }

  // 6. Audit stub.
  // TODO(task 40.1): replace this log with an audit_events INSERT
  //   action_type='application_note_added', actor=authorUserId,
  //   target_entity='Application', target_id=app.id,
  //   details={ note_id, visible_to_applicant }.
  logger.info(
    {
      event: 'application_note_added',
      actor_user_id: authorUserId,
      application_id: app.id,
      note_id: note.id,
      visible_to_applicant: note.visible_to_applicant,
    },
    'application note added',
  );

  // 7. Return the persisted row.
  return note;
}

// ---------------------------------------------------------------------------
// Public service — listNotes
// ---------------------------------------------------------------------------

export interface ListNotesOptions {
  /** Application primary key from the URL. */
  readonly applicationId: number;
  /** Department_Head scope; HR / Super_Admin pass `undefined`. */
  readonly scope?: JobScope;
}

/**
 * List every note tied to an application (internal + visible). The
 * application is resolved + scope-checked first so an out-of-scope or
 * missing id collapses to `ApplicationNotFoundError` (no row leak).
 */
export async function listNotes(opts: ListNotesOptions): Promise<NoteRow[]> {
  const { applicationId, scope } = opts;
  const app = await resolveInScopeApplication(applicationId, scope);
  return listForApplication(app.id);
}

// ---------------------------------------------------------------------------
// Mail helper
// ---------------------------------------------------------------------------

interface NoteMailContext {
  readonly applicationId: number;
  readonly noteId: number;
  readonly body: string;
}

/**
 * Best-effort wrapper around the note-notification enqueue. The future
 * `mail.enqueueNoteNotification` (task 36.1) will live alongside the
 * existing `enqueue` helper; today the stub only logs. Keeping the call
 * site in one helper means the future swap touches a single line.
 *
 * Defensive: if the mail module ever exports a dedicated
 * `enqueueNoteNotification` we use it; otherwise we fall back to a
 * structured log carrying the payload the future enqueue will produce.
 * Per Req 8.2 the email contains a NON-TRUNCATED excerpt of the note, so
 * we forward the full body (the future template decides framing).
 */
async function safeEnqueueNoteNotification(
  ctx: NoteMailContext,
): Promise<void> {
  const dedicated = (mailService as unknown as {
    enqueueNoteNotification?: (ctx: NoteMailContext) => Promise<void>;
  }).enqueueNoteNotification;

  if (typeof dedicated === 'function') {
    await dedicated(ctx);
    return;
  }

  // No dedicated helper yet — log the intent so the access log carries
  // the same payload the future enqueue will produce. We deliberately do
  // NOT call the generic `enqueue(connection, ...)` stub from the mail
  // module here because that helper requires a `PoolConnection` (its
  // design is transactional-only); calling it outside a transaction
  // would mis-signal the future contract. Once task 36.1 lands, this
  // branch is replaced by a real `INSERT IGNORE INTO mail_outbox`.
  // TODO(task 36.1): swap this stub for the transactional enqueue.
  logger.info(
    {
      template_key: 'note-notification',
      target_application_id: ctx.applicationId,
      note_id: ctx.noteId,
      body_length: ctx.body.length,
      stub: true,
    },
    'mail.enqueueNoteNotification (stub — see task 36.1)',
  );
}
