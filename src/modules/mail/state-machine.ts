/**
 * Mail outbox state machine + retry-backoff helpers for PT Buana Megah
 * Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 37.1 (flusher) — also underpins task 37.2 PBT
 *           (Property 3: MailOutboxStateMachineProperty)
 * Design  : §12.1 (state machine), §12.2 (backoff)
 * Validates: Requirements 8.3, 8.4, 8.5
 *
 * The `mail_outbox.status` column is declared as
 * `ENUM('pending','sending','sent','failed')` (migration 0006_mail.sql),
 * but the schema does not constrain transitions between those values —
 * that job lives here, mirroring the `applications/stage-machine.ts`
 * pattern.
 *
 * Allowed transitions (Design §12.1):
 *
 *   pending → sending           (cron picks the row and claims it)
 *   sending → sent              (SMTP success)
 *   sending → pending           (transient SMTP error, retry_count < 5)
 *   sending → failed            (5th failure — give up)
 *   sent    → ∅   (terminal)
 *   failed  → ∅   (terminal)
 *
 * Notes on the graph:
 *   - `sent` and `failed` are terminal: no outgoing transition is
 *     permitted. A row that reaches either is done.
 *   - `sending → pending` is the retry edge — the only place a row moves
 *     "backwards". It is gated on the retry counter staying below the
 *     ceiling; once the ceiling is hit the row goes to `failed` instead.
 *   - There is no `pending → failed` edge: a row only fails *after* an
 *     attempt was made (i.e. from `sending`).
 *
 * The functions are pure (no DB, no side effects) so they unit-test
 * without any mock setup; `src/crons/mail-flush.ts` wraps them with the
 * actual SELECT/UPDATE statements.
 */

/**
 * All status values enumerated in the `mail_outbox.status` ENUM
 * (migration 0006_mail.sql). Kept as a local const so this module is the
 * single source of truth for the transition graph.
 */
export const MAIL_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;

/** Discriminated union over the four `mail_outbox.status` values. */
export type MailStatus = (typeof MAIL_STATUSES)[number];

/**
 * Type guard: narrow an arbitrary value to `MailStatus`. Useful when
 * reading a raw status string back from the database before asserting a
 * transition against it.
 */
export function isMailStatus(value: unknown): value is MailStatus {
  return (
    typeof value === 'string' &&
    (MAIL_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Map of `from → set of allowed `to`s`. Frozen so callers cannot
 * accidentally mutate the graph at runtime. The empty sets on `sent` and
 * `failed` make those statuses terminal.
 */
export const ALLOWED_MAIL_TRANSITIONS: Readonly<
  Record<MailStatus, ReadonlySet<MailStatus>>
> = Object.freeze({
  pending: new Set<MailStatus>(['sending']),
  sending: new Set<MailStatus>(['sent', 'pending', 'failed']),
  sent: new Set<MailStatus>(),
  failed: new Set<MailStatus>(),
});

/**
 * Pure predicate. Same `from`/`to` returns `false` because no
 * self-transition appears in the graph (a row never moves to its current
 * status).
 */
export function canTransitionMail(from: MailStatus, to: MailStatus): boolean {
  return ALLOWED_MAIL_TRANSITIONS[from].has(to);
}

/**
 * Thrown by `assertMailTransition` when the (`from`, `to`) pair is not in
 * `ALLOWED_MAIL_TRANSITIONS`. Surfaces a clear message in the cron log if
 * a future code path ever attempts an illegal mutation.
 */
export class InvalidMailTransitionError extends Error {
  readonly code = 'invalid_mail_transition' as const;
  constructor(
    public readonly from: MailStatus,
    public readonly to: MailStatus,
  ) {
    super(`Invalid mail outbox transition: ${from} → ${to}`);
    this.name = 'InvalidMailTransitionError';
  }
}

/**
 * Throw `InvalidMailTransitionError` when the transition is not allowed.
 * Returns `void` on success so the call site reads as a guard:
 *
 *   assertMailTransition('sending', 'sent');
 *   await query(MARK_SENT_SQL, [id]);
 */
export function assertMailTransition(from: MailStatus, to: MailStatus): void {
  if (!canTransitionMail(from, to)) {
    throw new InvalidMailTransitionError(from, to);
  }
}

// ---------------------------------------------------------------------------
// Retry backoff (Design §12.2)
// ---------------------------------------------------------------------------

/**
 * Backoff schedule in seconds, one entry per failed attempt:
 * `[1m, 5m, 15m, 1h, 6h]` (Design §12.2). The cron adds this many seconds
 * to `NOW()` when re-queuing a row after a transient failure.
 */
export const MAIL_BACKOFF_SECONDS: readonly number[] = Object.freeze([
  60, // 1 minute  — 1st failure
  300, // 5 minutes — 2nd failure
  900, // 15 minutes — 3rd failure
  3_600, // 1 hour    — 4th failure
  21_600, // 6 hours   — defensive cap (see MAX_MAIL_FAILURES below)
]);

/**
 * Number of failed delivery attempts after which a row is marked
 * `failed` rather than re-queued (Req 8.5 — "until 5 attempts have
 * failed, after which mark the email as failed").
 */
export const MAX_MAIL_FAILURES = 5;

/**
 * Decide whether the `newRetryCount`-th failure is terminal. `true` once
 * the failure count reaches `MAX_MAIL_FAILURES` (the 5th failure), in
 * which case the caller transitions `sending → failed`; otherwise the
 * caller transitions `sending → pending` and schedules the next attempt.
 */
export function isTerminalFailure(newRetryCount: number): boolean {
  return newRetryCount >= MAX_MAIL_FAILURES;
}

/**
 * Backoff delay (in seconds) for a retry, indexed by the NEW retry count
 * (`retry_count` AFTER the increment). The 1st failure (`newRetryCount`
 * = 1) waits `MAIL_BACKOFF_SECONDS[0]` = 60s, and so on. The index is
 * clamped into range so an out-of-band `retry_count` (e.g. a row hand-
 * edited in the DB) degrades to the longest backoff rather than throwing.
 */
export function backoffSecondsForFailure(newRetryCount: number): number {
  const lastIndex = MAIL_BACKOFF_SECONDS.length - 1;
  const index = Math.min(Math.max(newRetryCount - 1, 0), lastIndex);
  return MAIL_BACKOFF_SECONDS[index] ?? 21_600;
}
