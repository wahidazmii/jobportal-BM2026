/**
 * Application pipeline stage state machine for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 29.2 (Stage transition endpoint)
 * Design  : §6 Admin
 * Validates: Requirements 10.2
 *
 * The `applications.stage` column is declared as
 * `ENUM('Applied','Screening','Interview','Offer','Hired','Rejected',
 * 'Withdrawn')` (migration 0004_applications.sql), but the schema does
 * not constrain transitions between those values — that job lives here,
 * mirroring the Job_Posting status machine in `jobs/state-machine.ts`.
 *
 * Allowed HR-driven transitions (per the task brief; design.md §6 Admin
 * specifies only the kanban column order, not a finer transition graph,
 * so the brief's graph is authoritative):
 *
 *   Applied    → Screening | Rejected
 *   Screening  → Interview  | Rejected
 *   Interview  → Offer      | Rejected
 *   Offer      → Hired      | Rejected
 *   Hired      → ∅   (terminal)
 *   Rejected   → ∅   (terminal)
 *   Withdrawn  → ∅   (terminal, applicant-driven — HR never moves a card here)
 *
 * Notes on the graph:
 *   - `Hired`, `Rejected`, and `Withdrawn` are terminal: no outgoing
 *     transition is permitted. A card that lands there is done.
 *   - `Withdrawn` is never a TARGET of any transition. It is reached
 *     only by the applicant-driven withdraw flow (Req 5.8, a different
 *     endpoint), never by an HR stage change. HR cannot move a card
 *     into Withdrawn, which is also why the kanban board has no
 *     Withdrawn column (see `kanban-repo.ts`).
 *   - `X → X` (no-op) returns `false`: callers MUST compare the current
 *     stage against the requested stage before calling. A no-op stage
 *     change is almost always a client bug (e.g. a SortableJS drop back
 *     into the same column) and we surface it as an invalid transition
 *     rather than silently re-running the side-effects (audit + mail).
 *   - Re-opening a terminal stage (e.g. `Rejected → Screening`) is
 *     rejected. Recruitment decisions are auditable and a "change of
 *     mind" should create a fresh application rather than rewrite a
 *     closed pipeline.
 *
 * Public surface:
 *   - `PipelineStage`                 — union of the seven stage values.
 *   - `PIPELINE_STAGES`               — readonly tuple (useful for zod).
 *   - `isPipelineStage(value)`        — type guard.
 *   - `ALLOWED_STAGE_TRANSITIONS`     — frozen map for inspection / tests.
 *   - `canTransitionStage(from, to)`  — pure boolean check.
 *   - `assertStageTransition(from, to)` — throws on a disallowed pair.
 *   - `InvalidStageTransitionError`   — thrown on disallowed transitions.
 *                                       The route layer maps it to HTTP 422.
 *
 * The functions are pure (no DB, no side effects) so they unit-test
 * without any mock setup; `stage-service.ts` wraps them with the actual
 * UPDATE + stage-history INSERT inside a transaction.
 */

/**
 * All stage values enumerated in the `applications.stage` ENUM
 * (migration 0004). Mirrors `APPLICATION_STAGES` in `./types.ts`; kept
 * as a local const so this module is the single source of truth for the
 * transition graph, exactly as `jobs/state-machine.ts` owns the
 * Job_Posting status graph.
 */
export const PIPELINE_STAGES = [
  'Applied',
  'Screening',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
  'Withdrawn',
] as const;

/** Discriminated union over the seven `applications.stage` values. */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Type guard: narrow an arbitrary value to `PipelineStage`. Used at the
 * route boundary to validate the posted destination stage before
 * handing it to the service.
 */
export function isPipelineStage(value: unknown): value is PipelineStage {
  return (
    typeof value === 'string' &&
    (PIPELINE_STAGES as readonly string[]).includes(value)
  );
}

/**
 * Map of `from → set of allowed `to`s`. Frozen so callers cannot
 * accidentally mutate the graph at runtime. The empty sets on `Hired`,
 * `Rejected`, and `Withdrawn` make those stages terminal.
 */
export const ALLOWED_STAGE_TRANSITIONS: Readonly<
  Record<PipelineStage, ReadonlySet<PipelineStage>>
> = Object.freeze({
  Applied: new Set<PipelineStage>(['Screening', 'Rejected']),
  Screening: new Set<PipelineStage>(['Interview', 'Rejected']),
  Interview: new Set<PipelineStage>(['Offer', 'Rejected']),
  Offer: new Set<PipelineStage>(['Hired', 'Rejected']),
  Hired: new Set<PipelineStage>(),
  Rejected: new Set<PipelineStage>(),
  Withdrawn: new Set<PipelineStage>(),
});

/**
 * Pure predicate. Equal `from`/`to` returns `false`: callers MUST check
 * equality themselves before calling — a no-op transition is almost
 * always a bug at the call site.
 */
export function canTransitionStage(
  from: PipelineStage,
  to: PipelineStage,
): boolean {
  if (from === to) return false;
  return ALLOWED_STAGE_TRANSITIONS[from].has(to);
}

/**
 * Thrown by `assertStageTransition` when the (`from`, `to`) pair is not
 * in `ALLOWED_STAGE_TRANSITIONS`. The route layer maps this to HTTP 422
 * with a short explanation (mirrors `InvalidTransitionError` in
 * `jobs/state-machine.ts`).
 */
export class InvalidStageTransitionError extends Error {
  readonly code = 'invalid_stage_transition' as const;
  /** HTTP status code the route layer surfaces for this error (Req 10.2). */
  readonly statusCode = 422 as const;
  constructor(
    public readonly from: PipelineStage,
    public readonly to: PipelineStage,
  ) {
    super(`Invalid application stage transition: ${from} → ${to}`);
    this.name = 'InvalidStageTransitionError';
  }
}

/**
 * Throw `InvalidStageTransitionError` when the transition is not
 * allowed. Returns `void` on success so the call site reads as a guard:
 *
 *   assertStageTransition(prev, next);
 *   await conn.execute(UPDATE_STAGE_SQL, [next, id]);
 */
export function assertStageTransition(
  from: PipelineStage,
  to: PipelineStage,
): void {
  if (!canTransitionStage(from, to)) {
    throw new InvalidStageTransitionError(from, to);
  }
}
