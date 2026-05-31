/**
 * Shared type definitions for the `applications` domain module.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 26.1 (apply endpoint)
 * Design  : §6 Applicant_Area, §7.2 (DDL ground truth)
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 *
 * Why a dedicated module:
 *   The `service.ts` (write paths — apply, withdraw, stage transitions)
 *   and the existing `queries.ts` (read paths — list, detail) both need
 *   to talk about the same ENUM values and row shape. Pulling those
 *   constants/types out into `types.ts` keeps them in a single source of
 *   truth so the two modules cannot drift.
 *
 * Source of truth:
 *   The literal lists below mirror migration `0004_applications.sql`
 *   verbatim. Any change to the DDL ENUMs MUST update this file too;
 *   the unit tests (`tests/unit/applications-service.spec.ts`) assert
 *   the canonical values to catch accidental drift.
 */

// ---------------------------------------------------------------------------
// Application source (the `?ref=` query parameter — Req 5.1, design §15)
// ---------------------------------------------------------------------------

/**
 * Whitelisted values for `applications.source`. Mirrors the DDL ENUM in
 * `0004_applications.sql`.
 *
 * The mapping rule (per task 26.1 specification):
 *   - Anything outside this whitelist (including `undefined`, the empty
 *     string, or unrecognised tokens) becomes `'unknown'`.
 *   - Matching is case-insensitive on the URL value but the DB stores
 *     the canonical lowercase form.
 */
export const APPLICATION_SOURCES = [
  'direct',
  'search',
  'alert',
  'social',
  'unknown',
] as const;

export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

/** Type-guard variant of `APPLICATION_SOURCES`. */
export function isApplicationSource(value: string): value is ApplicationSource {
  return (APPLICATION_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Application stage (pipeline ENUM)
// ---------------------------------------------------------------------------

/**
 * The seven Pipeline_Stage values from `applications.stage`,
 * `application_stage_history.prev_stage`, and `.new_stage`.
 *
 * The list is duplicated across three columns because MySQL does not
 * support a shared ENUM type — see the header note in
 * `0004_applications.sql`. The service layer is the single source of
 * truth for transition rules; this constant keeps the value list
 * consistent across the domain modules.
 */
export const APPLICATION_STAGES = [
  'Applied',
  'Screening',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
  'Withdrawn',
] as const;

export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * Public row shape for an `applications` row, normalised for the
 * service / route layers.
 *
 * Mirrors the columns in `0004_applications.sql` exactly. mysql2 may
 * return `BIGINT UNSIGNED` columns as `number | string` depending on
 * driver options; the service module coerces to `number` before
 * exposing this shape so callers do not have to.
 */
export interface ApplicationRow {
  readonly id: number;
  readonly uuid: string;
  readonly reference_no: string;
  readonly applicant_user_id: number;
  readonly job_id: number;
  readonly cv_file_id: number;
  readonly stage: ApplicationStage;
  readonly source: ApplicationSource;
  readonly applied_at: Date;
  readonly updated_at: Date;
  readonly hired_at: Date | null;
}
