/**
 * Job_Posting status state machine for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 21.2
 * Design  : §6 Admin
 * Validates: Requirements 9.2, 9.3, 9.4, 9.7
 *
 * The `job_postings.status` column is declared as
 * `ENUM('Draft','Published','Closed','Archived')` (migration 0003), but
 * the schema does not constrain transitions between those values — that
 * job lives here. Allowed transitions per Req 9 / design §6 Admin:
 *
 *   Draft     → Published   (sets `published_at = NOW()`, refreshes search index)
 *   Draft     → Archived    (discard a draft without ever publishing)
 *   Published → Closed      (removes from public site, retains applications)
 *   Published → Archived    (removes from public site, retains applications)
 *   Closed    → Archived    (long-term retention)
 *
 * Every other transition is rejected as `InvalidTransitionError`. In
 * particular:
 *   - Draft → Closed is rejected: a posting that was never published
 *     cannot be "closed". Either Archive it (terminal) or leave it as
 *     Draft.
 *   - Published → Draft and Closed → Published are rejected: re-using a
 *     slug after un-publishing would leak that the URL existed. Clone
 *     into a fresh Draft instead (Req 9.5).
 *   - Archived → * is rejected: Archived is terminal.
 *   - X → X (no-op) is rejected: callers must check equality before
 *     calling `assertTransition`. Returning OK on no-ops would mask
 *     bugs where the route handler accidentally re-runs the publish
 *     pipeline.
 *
 * Public surface:
 *   - `JobStatus`                — enum union of the four states.
 *   - `JOB_STATUSES`             — readonly tuple, useful for zod.
 *   - `isJobStatus(value)`       — type guard.
 *   - `ALLOWED_TRANSITIONS`      — readonly map for inspection / tests.
 *   - `canTransition(from, to)`  — pure boolean check.
 *   - `assertTransition(from, to)` — throws `InvalidTransitionError`
 *                                    when not allowed.
 *   - `InvalidTransitionError`   — thrown on disallowed transitions.
 *                                  The route layer maps this to HTTP 422.
 *
 * The functions are pure (no DB, no side effects) so they can be unit
 * tested without any mock setup; the repository / service layers wrap
 * them with the actual UPDATE statements + slug-uniqueness FOR UPDATE
 * lock.
 */

/** All status values enumerated in the `job_postings.status` column. */
export const JOB_STATUSES = [
  'Draft',
  'Published',
  'Closed',
  'Archived',
] as const;

/** Discriminated union over the four `job_postings.status` values. */
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Type guard: narrow an arbitrary value to `JobStatus`. Used at the
 * service boundary to validate URL form input before passing it down.
 */
export function isJobStatus(value: unknown): value is JobStatus {
  return (
    typeof value === 'string' &&
    (JOB_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Map of `from → set of allowed `to`s`. Frozen so callers cannot
 * accidentally add transitions at runtime. The empty set on
 * `Archived` makes it terminal.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<JobStatus, ReadonlySet<JobStatus>>
> = Object.freeze({
  Draft: new Set<JobStatus>(['Published', 'Archived']),
  Published: new Set<JobStatus>(['Closed', 'Archived']),
  Closed: new Set<JobStatus>(['Archived']),
  Archived: new Set<JobStatus>(),
});

/**
 * Pure predicate. Equal `from`/`to` returns `false`: callers MUST
 * check equality themselves before calling — a no-op transition is
 * almost always a bug at the call site.
 */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].has(to);
}

/**
 * Thrown by `assertTransition` when the (`from`, `to`) pair is not in
 * `ALLOWED_TRANSITIONS`. The route layer maps this to HTTP 422 with
 * a short explanation.
 */
export class InvalidTransitionError extends Error {
  readonly code = 'invalid_transition' as const;
  /** HTTP status code the route layer surfaces for this error (Req 9.2). */
  readonly statusCode = 422 as const;
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`Invalid job status transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Throw `InvalidTransitionError` when the transition is not allowed.
 * Returns `void` on success so the call site reads as a guard:
 *
 *   assertTransition(prev, next);
 *   await repo.update(id, { status: next });
 */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
