/**
 * Applicant profile service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 16.1
 * Design  : §6 Applicant_Area
 * Validates: Requirements 4.1
 *
 * Public surface:
 *   - `profileSchema`            — zod schema validating raw form input
 *                                  (mirrors the `applicants` columns
 *                                  defined in migration 0001_init.sql).
 *   - `ProfileInput`             — type inferred from `profileSchema`.
 *   - `ProfileRecord`            — typed `applicants` row returned by
 *                                  `loadProfile`.
 *   - `loadProfile(userId)`      — fetch the existing applicant row.
 *   - `updateProfile(userId,
 *                    input)`     — UPDATE the `applicants` row with the
 *                                  validated input. Emits a structured
 *                                  log line `profile_update` (Req 12 is
 *                                  not in scope at this phase; the audit
 *                                  table arrives in task 38.1).
 *
 * Validation contract (task 16.1):
 *   - `full_name`     : trimmed string, 1..100 chars (NOT NULL on the
 *                       `applicants` row; cap matches VARCHAR(100)).
 *   - `date_of_birth` : optional `YYYY-MM-DD` string, parsed to a Date
 *                       at least 18 years ago. The cutoff is computed
 *                       dynamically on every parse (`new Date(Date.now()
 *                       - 18 * 365.25 * 24 * 3600 * 1000)`) so the rule
 *                       is correct without hardcoded dates.
 *   - `gender`        : optional ENUM `{male, female, prefer-not-to-say}`.
 *   - `phone`         : optional E.164 string with 7..19 digits (plus
 *                       an optional leading `+`), canonicalising to
 *                       `+digits` ≤ 20 chars. The regex
 *                       `^\+?[1-9]\d{6,18}$` admits an optional `+`
 *                       followed by 7..19 digits; the first digit
 *                       must be 1..9 (E.164 forbids a leading 0).
 *                       The canonical form (`+` + digits) is then
 *                       enforced against the 20-char column cap by
 *                       `superRefine`, so 20 raw digits without a
 *                       `+` (which would canonicalise to 21 chars)
 *                       are rejected with a "≤ 20 characters" error.
 *   - `address`       : optional, ≤ 255 chars (matches column).
 *   - `city`/`province`/`country` : optional, ≤ 100 chars each.
 *   - `summary`       : optional, ≤ 500 chars.
 *   - `language_pref` : `'id'` or `'en'`; defaults to `'id'`.
 *
 * All optional fields accept the empty string from the form layer;
 * `.transform` maps `''` → `null` so the SQL UPDATE writes a real NULL
 * (not an empty string) and the column NOT NULL semantics line up with
 * the migration.
 *
 * Implementation notes:
 *   - All SQL goes through prepared statements (mysql2 `?` placeholders)
 *     per Req 15.4; the local lint rule `local/no-string-concat-sql`
 *     enforces this at call sites.
 *   - We do NOT touch `users.email` here — that lives on the `users`
 *     table and is changed via a separate flow (with verification).
 *   - The "audit event" called for in the task description ("ringan,
 *     tidak wajib di Req 12") is satisfied by a `logger.info` call with
 *     `event: 'profile_update'`. The richer DB-backed audit log lands
 *     in task 38.1 (migration 0007_audit.sql) and the writer in task
 *     40 — the route layer can be wired into that without a service
 *     contract change.
 */

import { z } from 'zod';

import {
  query,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum age in years required at registration time (UU PDP minor guard). */
export const MIN_AGE_YEARS = 18;

/** Average year length in milliseconds (accounts for leap years). */
export const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * E.164 international phone format. The leading `+` is optional in the
 * form input (users frequently type the number without it); the schema
 * canonicalises to a `+`-prefixed value via `.transform`. The first
 * digit cannot be 0 to exclude trunk-prefix numbers that don't carry a
 * country code.
 *
 * Length rule: 7..19 digits in input. The lower bound (7 digits)
 * matches the shortest realistic country-code + national-significant-
 * number combination per the ITU-T E.164 recommendation; the upper
 * bound (19 digits) keeps the canonical `+digits` form within the
 * `applicants.phone VARCHAR(20)` column. The canonical form is
 * additionally checked in `phoneSchema` to reject the edge case where
 * 20 raw digits were typed without a `+` (canonical form would be 21
 * chars) — those collapse to a clear "≤ 20 characters" message
 * instead of a regex mismatch.
 */
export const PHONE_E164_REGEX = /^\+?[1-9]\d{6,18}$/;

/** Allowed values for `applicants.language_pref`. */
export const SUPPORTED_LANGUAGES = ['id', 'en'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Allowed values for `applicants.gender`. */
export const GENDER_VALUES = ['male', 'female', 'prefer-not-to-say'] as const;
export type Gender = (typeof GENDER_VALUES)[number];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Compute the cutoff date for the 18-year minimum-age check.
 *
 * Done at parse time (rather than as a Zod constant) so the rule stays
 * correct as time passes. We avoid `setFullYear(year - 18)` here because
 * leap-day birthdays produce ambiguous results across `Feb 29 → Feb 28`
 * vs `Mar 1`; the millisecond subtraction is unambiguous and the
 * 365.25-day average accounts for leap years over any practical range.
 */
function eighteenYearsAgoCutoff(): Date {
  return new Date(Date.now() - MIN_AGE_YEARS * MS_PER_YEAR);
}

/**
 * Coerce empty strings to `undefined` so the optional fields below can
 * leave the value as `null` (after the trailing `.nullable()` chain),
 * which is what the `applicants` columns store for "not yet entered".
 */
const blankToUndef = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v))
  .optional();

/**
 * `full_name` is the only mandatory profile field — the registration
 * service seeds it from the email local-part, and the column is NOT NULL
 * (see migration 0001_init.sql).
 */
const fullNameSchema = z
  .string({ required_error: 'Full name is required' })
  .trim()
  .min(1, { message: 'Full name is required' })
  .max(100, { message: 'Full name must be at most 100 characters' });

/**
 * Optional `YYYY-MM-DD` date with the 18-year minimum-age check. We
 * parse the string with `Date.parse` (UTC midnight) so the comparison
 * against the cutoff is timezone-stable.
 */
const dateOfBirthSchema = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v))
  .optional()
  .superRefine((value, ctx) => {
    if (value === undefined) return;
    // YYYY-MM-DD shape — strict so we don't accept ambiguous formats.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Date of birth must be in YYYY-MM-DD format',
      });
      return;
    }
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(ms)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Date of birth is not a valid date',
      });
      return;
    }
    const dob = new Date(ms);
    if (dob.getTime() > eighteenYearsAgoCutoff().getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `You must be at least ${MIN_AGE_YEARS} years old`,
      });
    }
  })
  // After superRefine, the value is still string|undefined; map empty
  // sentinel to undefined for the public type.
  .transform((value) => (value === undefined ? undefined : value));

const genderSchema = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v))
  .optional()
  .refine(
    (v) => v === undefined || (GENDER_VALUES as readonly string[]).includes(v),
    { message: 'Gender must be male, female, or prefer-not-to-say' },
  )
  .transform((v) => v as Gender | undefined);

/**
 * Phone in E.164. The form layer typically posts the value with or
 * without a leading `+`; the regex accepts both and `.transform` adds
 * the `+` to canonicalise before storage. The column cap (20 chars)
 * is enforced AFTER canonicalisation: an input of 20 digits without a
 * `+` regex-matches but the canonical form (`+` + 20 digits = 21 chars)
 * would overrun the column, so the post-canonicalisation length check
 * rejects it.
 */
const phoneSchema = z
  .string()
  .transform((v) => v.trim().replace(/[\s-]/g, ''))
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .superRefine((value, ctx) => {
    if (value === undefined) return;
    if (!PHONE_E164_REGEX.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Phone must be in E.164 format (e.g. +6281234567890, 7-19 digits, optional leading +)',
      });
      return;
    }
    // Canonical form length check (≤ 20 chars to fit VARCHAR(20)).
    const canonical = value.startsWith('+') ? value : `+${value}`;
    if (canonical.length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 20,
        type: 'string',
        inclusive: true,
        message: 'Phone must be at most 20 characters',
      });
    }
  })
  .transform((value) => {
    if (value === undefined) return undefined;
    return value.startsWith('+') ? value : `+${value}`;
  });

const addressSchema = blankToUndef.refine(
  (v) => v === undefined || v.length <= 255,
  { message: 'Address must be at most 255 characters' },
);

const cityProvinceCountrySchema = blankToUndef.refine(
  (v) => v === undefined || v.length <= 100,
  { message: 'Must be at most 100 characters' },
);

const summarySchema = blankToUndef.refine(
  (v) => v === undefined || v.length <= 500,
  { message: 'Summary must be at most 500 characters' },
);

const languagePrefSchema = z
  .union([z.literal('id'), z.literal('en')])
  .default('id');

/**
 * Public profile schema. Use `.parse(input)` from the route handler to
 * fail-fast on invalid input. Optional fields accept either the empty
 * string (form default) or an explicit value; the empty-string path
 * normalises to `undefined`, which the service layer writes as SQL NULL.
 */
export const profileSchema = z
  .object({
    full_name: fullNameSchema,
    date_of_birth: dateOfBirthSchema,
    gender: genderSchema,
    phone: phoneSchema,
    address: addressSchema,
    city: cityProvinceCountrySchema,
    province: cityProvinceCountrySchema,
    country: cityProvinceCountrySchema,
    summary: summarySchema,
    language_pref: languagePrefSchema,
  })
  .strict();

/** Strongly-typed input for `updateProfile` — the parsed shape of the form. */
export type ProfileInput = z.infer<typeof profileSchema>;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Shape of an `applicants` row, matching the columns declared in
 * `migrations/0001_init.sql`. All optional columns are nullable; the
 * NOT-NULL `full_name` and `language_pref` columns are always present.
 */
export interface ProfileRecord {
  user_id: number;
  full_name: string;
  date_of_birth: string | null;
  gender: Gender | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  summary: string | null;
  language_pref: SupportedLanguage;
}

interface ProfileRow extends RowDataPacket {
  user_id: number | string;
  full_name: string;
  date_of_birth: Date | string | null;
  gender: Gender | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  summary: string | null;
  language_pref: SupportedLanguage;
}

const SELECT_PROFILE_SQL =
  'SELECT user_id, full_name, date_of_birth, gender, phone, address, ' +
  '  city, province, country, summary, language_pref ' +
  'FROM applicants WHERE user_id = ? LIMIT 1';

/**
 * Update statement scoped to a single applicant. The `WHERE user_id = ?`
 * clause keeps the UPDATE confined to the authenticated user; the route
 * layer is responsible for sourcing `user_id` from the session, never
 * from the form.
 */
const UPDATE_PROFILE_SQL =
  'UPDATE applicants SET ' +
  '  full_name = ?, ' +
  '  date_of_birth = ?, ' +
  '  gender = ?, ' +
  '  phone = ?, ' +
  '  address = ?, ' +
  '  city = ?, ' +
  '  province = ?, ' +
  '  country = ?, ' +
  '  summary = ?, ' +
  '  language_pref = ? ' +
  'WHERE user_id = ?';

/**
 * Normalise mysql2's date result. `mysql2` returns `DATE` columns as
 * `Date` objects by default; we convert to a `YYYY-MM-DD` string so the
 * value can flow straight into the form's `<input type="date">` without
 * any timezone surprise on the way back out.
 */
function dateToIsoYmd(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    // mysql2 in some configurations returns dates as strings already.
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  // toISOString returns YYYY-MM-DDThh:mm:ss.sssZ — slice the date part.
  return value.toISOString().slice(0, 10);
}

/**
 * Load the canonical applicants row for `userId`. Returns `null` when
 * no row exists; the caller (route layer) treats this as an internal
 * error since registration always inserts the row.
 */
export async function loadProfile(userId: number): Promise<ProfileRecord | null> {
  const rows = await query<ProfileRow[]>(SELECT_PROFILE_SQL, [userId]);
  const row = rows[0];
  if (!row) return null;
  return {
    user_id: Number(row.user_id),
    full_name: row.full_name,
    date_of_birth: dateToIsoYmd(row.date_of_birth),
    gender: row.gender,
    phone: row.phone,
    address: row.address,
    city: row.city,
    province: row.province,
    country: row.country,
    summary: row.summary,
    language_pref: row.language_pref,
  };
}

/**
 * Update the applicant's profile row.
 *
 * - Validates `rawInput` via `profileSchema` (throws `ZodError` on
 *   failure for the route to render field-level messages).
 * - Translates `undefined` field values to SQL NULL so the column
 *   semantics line up with the form's "not provided" representation.
 * - Returns the count of rows affected (always 0 or 1 because the
 *   filter is the primary key on `applicants.user_id`).
 *
 * The "audit event" in the task description is logged via `logger.info`
 * with `event: 'profile_update'`. The structured log line is consumed
 * by the cPanel log file (Req 20.1) until task 38.1 lands the
 * `audit_events` table.
 */
export async function updateProfile(
  userId: number,
  rawInput: unknown,
): Promise<{ affected: number; profile: ProfileInput }> {
  const input = profileSchema.parse(rawInput);

  const result = await query<ResultSetHeader>(UPDATE_PROFILE_SQL, [
    input.full_name,
    input.date_of_birth ?? null,
    input.gender ?? null,
    input.phone ?? null,
    input.address ?? null,
    input.city ?? null,
    input.province ?? null,
    input.country ?? null,
    input.summary ?? null,
    input.language_pref,
    userId,
  ]);

  // Lightweight audit trail per Req 12 ("not required at this phase").
  // Captures the actor only — we deliberately do not echo the new
  // values to keep PII out of stdout-logged JSON.
  logger.info(
    { event: 'profile_update', user_id: userId },
    'applicant.profile: row updated',
  );

  return { affected: result.affectedRows, profile: input };
}
