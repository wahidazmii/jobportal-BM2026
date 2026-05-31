/**
 * Profile completeness helper for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 18.1
 * Design  : §6 Applicant_Area
 * Validates: Requirements 4.9, 4.10
 *
 * Public surface:
 *   - `MANDATORY_STRING_FIELDS` — the 8 applicant string fields whose
 *     non-empty (trimmed) presence each contribute one slot toward
 *     completeness (Req 4.1, 4.9).
 *   - `MANDATORY_FLAGS` — the 3 boolean aggregates (`hasEducation`,
 *     `hasExperience`, `hasActiveCv`) corresponding to "≥1 education",
 *     "≥1 experience", and "active CV" per the design.
 *   - `MANDATORY_SLOTS` — the canonical ordered list of 11 slot keys
 *     (8 string + 3 flag). Used as both the denominator and the
 *     identifiers returned in `missingFields`.
 *   - `APPLY_THRESHOLD_PERCENT` — 80 (Req 4.10, 5.1). The banner is
 *     rendered while percentage is strictly below this value.
 *   - `computeCompleteness(input)` — pure function returning
 *     `{ percentage, missingFields }`.
 *
 * Behaviour summary (Req 4.9, 4.10):
 *   - Each of the 11 slots contributes 100/11 ≈ 9.09 %.
 *   - String fields count as filled when their trimmed value is non-empty.
 *     Anything else (`null`, `undefined`, whitespace-only, non-string)
 *     counts as missing.
 *   - Boolean flags count as filled iff the value is strictly `true`.
 *   - The percentage is rounded to the nearest integer (half-up):
 *       0/11 →  0     6/11 → 55    9/11 → 82
 *       1/11 →  9     7/11 → 64   10/11 → 91
 *       2/11 → 18     8/11 → 73   11/11 → 100
 *   - `missingFields` lists every slot that did NOT count as filled,
 *     preserving the canonical order of `MANDATORY_SLOTS` so the banner
 *     reads naturally top-to-bottom.
 *   - The function is pure and synchronous: no I/O, no logging.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The 8 applicant string fields that each occupy one completeness slot. */
export const MANDATORY_STRING_FIELDS = [
  'full_name',
  'date_of_birth',
  'phone',
  'address',
  'city',
  'province',
  'country',
  'summary',
] as const;

export type MandatoryStringField = (typeof MANDATORY_STRING_FIELDS)[number];

/** The 3 boolean-aggregate slots the caller supplies as flags. */
export const MANDATORY_FLAGS = [
  'hasEducation',
  'hasExperience',
  'hasActiveCv',
] as const;

export type MandatoryFlag = (typeof MANDATORY_FLAGS)[number];

/**
 * Canonical ordered list of all 11 mandatory slot keys. The keys
 * returned in `missingFields` are drawn from this list, in this order.
 */
export const MANDATORY_SLOTS = [
  ...MANDATORY_STRING_FIELDS,
  ...MANDATORY_FLAGS,
] as const;

export type MandatorySlot = (typeof MANDATORY_SLOTS)[number];

/** Apply threshold per Req 4.10 / 5.1. Banner shows while < 80. */
export const APPLY_THRESHOLD_PERCENT = 80;

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/**
 * Loose shape for the helper input. Every key is optional so callers
 * can pass partially-loaded rows (e.g. mid-edit form drafts) without
 * having to coerce types first. String fields accept `null`/`undefined`
 * as "missing"; boolean flags default to `false` when omitted.
 */
export interface CompletenessInput {
  readonly full_name?: string | null;
  readonly date_of_birth?: string | null;
  readonly phone?: string | null;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly country?: string | null;
  readonly summary?: string | null;
  readonly hasEducation?: boolean | null;
  readonly hasExperience?: boolean | null;
  readonly hasActiveCv?: boolean | null;
}

/**
 * Result of `computeCompleteness`.
 *
 * - `percentage` is an integer in [0, 100], rounded half-up from the
 *   raw `filled / 11 * 100` ratio.
 * - `missingFields` lists every slot that was NOT filled, in the
 *   canonical order of `MANDATORY_SLOTS`.
 */
export interface CompletenessResult {
  readonly percentage: number;
  readonly missingFields: readonly MandatorySlot[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * A string field is considered filled iff `value` is a string whose
 * trimmed form is non-empty.
 */
function isStringFilled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A boolean flag is considered filled iff `value` is strictly `true`.
 * Anything else (`false`, `null`, `undefined`, non-boolean) is missing.
 */
function isFlagFilled(value: unknown): boolean {
  return value === true;
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Compute the applicant profile completeness percentage and the list of
 * missing mandatory slot keys.
 *
 * @example
 *   const { percentage, missingFields } = computeCompleteness({
 *     full_name: 'Sari Pelita',
 *     date_of_birth: '1995-04-12',
 *     phone: '+6281234567890',
 *     address: 'Jl. Mawar 12',
 *     city: 'Bandung',
 *     province: 'Jawa Barat',
 *     country: 'Indonesia',
 *     summary: 'Frontend engineer',
 *     hasEducation: true,
 *     hasExperience: true,
 *     hasActiveCv: true,
 *   });
 *   // → { percentage: 100, missingFields: [] }
 */
export function computeCompleteness(
  input: CompletenessInput,
): CompletenessResult {
  const missingFields: MandatorySlot[] = [];

  for (const field of MANDATORY_STRING_FIELDS) {
    if (!isStringFilled(input[field])) {
      missingFields.push(field);
    }
  }

  for (const flag of MANDATORY_FLAGS) {
    if (!isFlagFilled(input[flag])) {
      missingFields.push(flag);
    }
  }

  const total = MANDATORY_SLOTS.length; // 11
  const filled = total - missingFields.length;
  // Round half-up to the nearest integer, per task 18.1.
  const percentage = Math.round((filled / total) * 100);

  return { percentage, missingFields };
}
