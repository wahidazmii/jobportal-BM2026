/**
 * Shared error classes for the `applications` domain module.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 26.1
 * Design  : §6 Applicant_Area, §15
 * Validates: Requirements 5.2, 5.3, 5.4
 *
 * Why a dedicated module:
 *   `repo.ts` (the SQL boundary) and `service.ts` (the orchestration
 *   boundary) both throw / catch these errors. Putting the class
 *   definitions here breaks the circular dependency that would
 *   otherwise form between the two modules:
 *
 *     - service.ts → repo.ts        (calls `insertApplication`)
 *     - repo.ts    → service.ts     (would import the error class)
 *
 *   With this file as the third vertex, both modules import their
 *   error types from `./errors.js` and there is no cycle.
 *
 * Error semantics:
 *   - {@link MissingCvError}            — applicant has no
 *     `applicant_cv_files` row with `is_active = 1` (Req 5.2). The
 *     route layer maps this to HTTP 422 with a "no active CV"
 *     fragment.
 *   - {@link IncompleteProfileError}    — completeness < 80 %; carries
 *     the `missingFields` array so the route can surface them
 *     (Req 5.2).
 *   - {@link JobUnavailableError}       — the job either does not
 *     exist, is not Published, or has a past deadline. The three
 *     causes collapse to a single error so the API never leaks job
 *     state to a probing client (Req 5.4).
 *   - {@link DuplicateApplicationError} — second apply by the same
 *     applicant to the same job (`uk_app_applicant_job` violation,
 *     Req 5.3). Mapped to HTTP 409 by the route layer.
 *   - {@link ApplicationNotFoundError} — the application id is unknown
 *     OR is owned by a different applicant (Req 5.8). The two causes
 *     collapse to a single error so the API never confirms the
 *     existence of another user's row. Mapped to HTTP 404.
 *   - {@link WithdrawNotAllowedError}  — the application is already in
 *     a terminal stage ({Hired, Rejected, Withdrawn}) so it cannot be
 *     withdrawn (Req 5.8). Mapped to HTTP 409.
 */

/** Thrown when the applicant has no active CV (Req 5.2). */
export class MissingCvError extends Error {
  readonly code = 'missing_cv' as const;
  /** HTTP status the route layer maps this to (Req 5.2 → 422). */
  readonly statusCode = 422 as const;
  constructor() {
    super('applicant has no active CV');
    this.name = 'MissingCvError';
  }
}

/**
 * Thrown when the profile completeness percentage is below 80 %.
 * The `missingFields` array carries the canonical slot keys returned
 * by `computeCompleteness` so the route can list them in the error
 * fragment (Req 5.2).
 */
export class IncompleteProfileError extends Error {
  readonly code = 'incomplete_profile' as const;
  readonly statusCode = 422 as const;
  constructor(
    public readonly percentage: number,
    public readonly missingFields: readonly string[],
  ) {
    super(`profile completeness ${percentage}% is below the apply threshold`);
    this.name = 'IncompleteProfileError';
  }
}

/**
 * Thrown when the job is not findable, not in `Published` state, or
 * its `application_deadline` has passed. The three causes collapse
 * to a single error so the API never leaks the difference between
 * "job does not exist" and "you may not apply to this job" — a
 * probing client cannot distinguish them.
 */
export class JobUnavailableError extends Error {
  readonly code = 'job_unavailable' as const;
  readonly statusCode = 404 as const;
  constructor(public readonly jobId: number) {
    super(`job ${jobId} is not available for application`);
    this.name = 'JobUnavailableError';
  }
}

/** Thrown when the same applicant tries to apply twice (Req 5.3). */
export class DuplicateApplicationError extends Error {
  readonly code = 'duplicate_application' as const;
  readonly statusCode = 409 as const;
  constructor(
    public readonly applicantUserId: number,
    public readonly jobId: number,
  ) {
    super(
      `applicant ${applicantUserId} has already applied to job ${jobId}`,
    );
    this.name = 'DuplicateApplicationError';
  }
}

/**
 * Thrown when an application id cannot be resolved for the requesting
 * applicant (Req 5.8). The id is either unknown OR belongs to a
 * different applicant — the two causes collapse to ONE error so a
 * probing client cannot distinguish "does not exist" from "not yours"
 * (no row leak, mirrors the `findOneForApplicant` null collapse).
 */
export class ApplicationNotFoundError extends Error {
  readonly code = 'application_not_found' as const;
  readonly statusCode = 404 as const;
  constructor(public readonly applicationId: number) {
    super(`application ${applicationId} not found for this applicant`);
    this.name = 'ApplicationNotFoundError';
  }
}

/**
 * Thrown when an applicant attempts to withdraw an application that is
 * already in a terminal stage (Req 5.8). The terminal set is
 * {Hired, Rejected, Withdrawn}:
 *   - Hired / Rejected are the two stages Req 5.8 explicitly forbids
 *     withdrawing from ("whose stage is not Hired or Rejected").
 *   - Withdrawn is added so a double-withdraw is rejected rather than
 *     inserting a redundant stage-history row (idempotency guard).
 *
 * Mapped to HTTP 409 by the route layer.
 */
export class WithdrawNotAllowedError extends Error {
  readonly code = 'terminal_stage' as const;
  readonly statusCode = 409 as const;
  constructor(
    public readonly applicationId: number,
    public readonly stage: string,
  ) {
    super(
      `application ${applicationId} in stage ${stage} cannot be withdrawn`,
    );
    this.name = 'WithdrawNotAllowedError';
  }
}
