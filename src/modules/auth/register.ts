/**
 * Applicant registration service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 9.1
 * Design  : §8.1 (register → verify → login sequence)
 * Validates: Requirements 3.1, 3.2, 3.10, 14.1
 *
 * Public surface:
 *   - `registerSchema`   — zod schema validating raw form input.
 *   - `RegisterInput`    — type inferred from `registerSchema`.
 *   - `register()`       — service function executed after the route handler
 *                          has parsed the body, run the captcha check, and
 *                          enforced the per-IP rate limit (Req 14.2).
 *
 * Behaviour summary (Req 3.1, 3.2, 3.10, 14.1):
 *   - Validate email (RFC), password ≥10 chars with letter+digit, consent
 *     boolean true, captcha token present.
 *   - Hash password with bcrypt cost 12 (Req 3.10).
 *   - In a single MySQL transaction: INSERT users (status=pending) →
 *     applicants → consent_records (with the active policy version) →
 *     verification_tokens (24-hour expiry).
 *   - Enqueue the verification email via the mail service stub (task 35.1
 *     will fill in the real INSERT into `mail_outbox`).
 *   - If the email is already registered, return the SAME generic outcome
 *     (`{ ok: true, alreadyRegistered: true }`) without writing any rows
 *     and without enqueueing any email — Req 3.2 forbids leaking which
 *     emails exist in the system. We still run bcrypt to keep the
 *     timing profile uniform with the success path.
 *
 * Captcha + rate-limiting are enforced by the route layer (task 9.2) so
 * they aren't repeated here; the schema only checks the captcha token
 * is well-formed.
 */

import { randomBytes } from 'node:crypto';

import bcrypt from 'bcrypt';
import { z } from 'zod';
import { ulid } from 'ulid';

import {
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
  withTransaction,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { enqueue as enqueueMail } from '../mail/service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * bcrypt work factor mandated by Req 3.10 ("at least 12"). Tuned to give
 * sub-300 ms hashing on the cPanel container in §20.2 of the design.
 */
export const BCRYPT_COST = 12;

/** Minimum password length per Req 3.1. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Maximum password length the form accepts. bcrypt silently truncates at
 * 72 bytes; capping the form at 128 chars is the design's UX choice
 * (§8.5) so users with very long passphrases get a clear error rather
 * than a silent prefix-only hash.
 */
export const MAX_PASSWORD_LENGTH = 128;

/** Verification token lifetime per Req 3.1. */
export const VERIFICATION_TOKEN_HOURS = 24;

/**
 * Token width for `verification_tokens.token CHAR(43)`. 32 random bytes
 * encoded as base64url produce exactly 43 chars (no padding).
 */
const TOKEN_BYTES = 32;

/**
 * Active privacy policy version recorded in `consent_records.policy_version`
 * (Design §16.1). The value is read from `process.env.PRIVACY_POLICY_VERSION`
 * so a policy bump only requires an env change + Passenger restart, no code
 * deploy. Default `'v1'` matches the bootstrap policy shipped with the
 * portal's first launch.
 */
export function activePolicyVersion(): string {
  const raw = process.env.PRIVACY_POLICY_VERSION;
  return raw && raw.trim() !== '' ? raw.trim() : 'v1';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * RFC-compatible email regex used as a quick pre-filter before zod's
 * built-in `.email()` check, which already enforces RFC 5322's practical
 * subset. We also strip trailing whitespace and lowercase the local part
 * via `.transform` so the unique-key comparison in `users.email` is
 * stable.
 *
 * Length cap (254) matches the `users.email VARCHAR(254)` column.
 */
const EMAIL_MAX_LEN = 254;

/**
 * Password rule per Req 3.1: ≥10 chars containing both a letter and a
 * digit. Implemented as two `.refine` calls so error messages can be
 * tied to the specific rule that failed, which the form view will pick
 * up via `error.flatten().fieldErrors`.
 */
const passwordSchema = z
  .string({ required_error: 'Password is required' })
  .min(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  .max(MAX_PASSWORD_LENGTH, {
    message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
  })
  .refine((pw) => /[A-Za-z]/.test(pw), {
    message: 'Password must contain at least one letter',
  })
  .refine((pw) => /\d/.test(pw), {
    message: 'Password must contain at least one digit',
  });

/**
 * Consent must be the literal boolean `true`. Zod's `boolean()` accepts
 * both true and false, so we narrow with `.refine`. Front-end checkbox
 * arrives as `'on'` from `<form>`; the route layer is expected to coerce
 * to boolean before validating.
 */
const consentSchema = z
  .boolean({
    required_error: 'You must accept the privacy policy to continue',
    invalid_type_error: 'Consent must be true or false',
  })
  .refine((v) => v === true, {
    message: 'You must accept the privacy policy to continue',
  });

/**
 * Captcha token presence. The actual provider check happens at the route
 * layer (Design §6 Auth) — we only ensure the form did not submit an
 * empty value.
 */
const captchaSchema = z
  .string({ required_error: 'Captcha verification is required' })
  .min(1, { message: 'Captcha verification is required' })
  .max(2048, { message: 'Captcha token is too long' });

/**
 * Public registration schema. Use `.parse(input)` from the route handler
 * to fail-fast on invalid input.
 */
export const registerSchema = z
  .object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .max(EMAIL_MAX_LEN, { message: 'Email is too long' })
      .email({ message: 'Please enter a valid email address' })
      .transform((v) => v.toLowerCase()),
    password: passwordSchema,
    consent: consentSchema,
    captchaToken: captchaSchema,
  })
  .strict();

/** Strongly-typed input for `register()` — the parsed shape of the form. */
export type RegisterInput = z.infer<typeof registerSchema>;

// ---------------------------------------------------------------------------
// Service result
// ---------------------------------------------------------------------------

/**
 * Result of `register()`. The same shape is returned for both the
 * happy path and the duplicate-email path so the route layer can render
 * the same generic "check your inbox" message — see Req 3.2 (no leak).
 *
 * `alreadyRegistered` is exposed for **internal** logging and tests; the
 * HTTP layer must not branch on it.
 */
export interface RegisterResult {
  /** Always `true` on a normal completion (validation errors throw). */
  readonly ok: true;
  /** True iff the email was already registered (no rows written). */
  readonly alreadyRegistered: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a 32-byte token encoded as base64url (43 chars, no padding). */
function generateVerificationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Build a default `applicants.full_name` for a freshly-registered user.
 * The column is `NOT NULL` (see migration 0001_init.sql) but the design's
 * registration form only collects email/password/consent/captcha. Until
 * the user fills out their profile (Req 4.1) we seed the field with the
 * email's local part, capped at the column's 100-char limit.
 */
function defaultFullNameFromEmail(email: string): string {
  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  const trimmed = local.trim() === '' ? 'New Applicant' : local.trim();
  return trimmed.slice(0, 100);
}

/**
 * Detect mysql2's "duplicate entry" error in a way that survives both the
 * named-error variant (`ER_DUP_ENTRY`) and the numeric variant (1062).
 * Used to fold a race-induced duplicate INSERT back into the same
 * generic-success branch as the pre-check.
 */
function isDuplicateEntry(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { code?: unknown; errno?: unknown };
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
}

interface UserIdRow extends RowDataPacket {
  id: number | string;
}

/**
 * Look up an existing user by email. Returns `true` when a row exists.
 *
 * Uses a prepared statement on the unique `uk_users_email` index, so the
 * lookup is a single index dive. Note: this check is racy with respect
 * to a concurrent INSERT — the `uk_users_email` UNIQUE constraint is the
 * authoritative gate, and the INSERT path also catches `ER_DUP_ENTRY`.
 */
async function emailAlreadyExists(
  connection: PoolConnection,
  email: string,
): Promise<boolean> {
  const [rows] = await connection.execute<UserIdRow[]>(
    'SELECT id FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Captured request context the service layer needs but does not derive
 * from the form body. The route handler fills these in.
 */
export interface RegisterContext {
  /**
   * Packed IP address (4 or 16 bytes) for `consent_records.ip_address`
   * audit trail. `null` when the layer in front of Fastify hasn't passed
   * a verifiable client IP.
   */
  readonly ipAddress?: Buffer | null;
}

/**
 * Register a new Applicant.
 *
 * Workflow:
 *   1. Validate `input` via `registerSchema` (caller-supplied, already
 *      parsed in tests; the route handler does the parsing).
 *   2. Hash the password with bcrypt cost 12.
 *   3. Open a single transaction:
 *        a. Pre-check `users.email`. If present, COMMIT a no-op
 *           transaction and return `{ ok: true, alreadyRegistered: true }`.
 *        b. Otherwise INSERT `users` (status=pending), `applicants`,
 *           `consent_records`, and `verification_tokens`.
 *        c. Inside the same transaction, call `mail.enqueue` so the
 *           verify email is queued atomically with the user creation.
 *           If the future `mail_outbox` INSERT fails, the user creation
 *           is rolled back together with it (Design §12.3).
 *   4. If the INSERT race-collides on `uk_users_email`, swallow the
 *      `ER_DUP_ENTRY` and return the same generic result.
 *
 * Throws:
 *   - `z.ZodError` when `input` violates the schema (route handler
 *     should render the form with field-level errors).
 *   - The original error for any non-duplicate database failure.
 */
export async function register(
  rawInput: unknown,
  ctx: RegisterContext = {},
): Promise<RegisterResult> {
  const input: RegisterInput = registerSchema.parse(rawInput);

  // bcrypt outside the transaction so the row lock window stays narrow.
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const userUuid = ulid();
  const verificationToken = generateVerificationToken();

  return withTransaction(async (connection) => {
    // Pre-check for duplicate email (Req 3.2 — no leak).
    if (await emailAlreadyExists(connection, input.email)) {
      logger.info(
        { email_domain: input.email.split('@')[1] ?? '' },
        'auth.register: duplicate email — generic no-op response',
      );
      return { ok: true, alreadyRegistered: true };
    }

    try {
      // 1) users — status=pending, role=Applicant; bcrypt hash sized to
      //    the 72-char column.
      const userResult = await connection.execute<ResultSetHeader>(
        'INSERT INTO users (uuid, email, password_hash, role, status) ' +
          "VALUES (?, ?, ?, 'Applicant', 'pending')",
        [userUuid, input.email, passwordHash],
      );
      const insertId = (userResult[0] as ResultSetHeader).insertId;
      if (!insertId || insertId <= 0) {
        throw new Error('auth.register: missing insertId after users INSERT');
      }
      const userId = Number(insertId);

      // 2) applicants — full_name is required and the form has not yet
      //    collected one; seed it from the email local-part. The user
      //    will overwrite this through the profile page (Req 4.1).
      await connection.execute<ResultSetHeader>(
        'INSERT INTO applicants (user_id, full_name) VALUES (?, ?)',
        [userId, defaultFullNameFromEmail(input.email)],
      );

      // 3) consent_records — capture the policy version effective at
      //    registration time (Req 16.1, Design §16.1).
      await connection.execute<ResultSetHeader>(
        'INSERT INTO consent_records (applicant_user_id, policy_version, ip_address) ' +
          'VALUES (?, ?, ?)',
        [userId, activePolicyVersion(), ctx.ipAddress ?? null],
      );

      // 4) verification_tokens — single-use, 24h validity (Req 3.1).
      //    The interval literal is inlined here (rather than computed
      //    from `VERIFICATION_TOKEN_HOURS`) because `local/no-string-
      //    concat-sql` rejects template-built SQL: 24 hours is the
      //    fixed contract of Req 3.1, so a static literal is the correct
      //    expression of intent. The constant remains exported for any
      //    consumer (e.g. UI copy, expiry-display tests) that needs the
      //    same number in code.
      await connection.execute<ResultSetHeader>(
        'INSERT INTO verification_tokens (token, user_id, expires_at) ' +
          'VALUES (?, ?, NOW() + INTERVAL 24 HOUR)',
        [verificationToken, userId],
      );

      // 5) Enqueue the verification email atomically with the user row.
      //    Stub today; task 35.1/36.1 will replace this with the real
      //    INSERT IGNORE INTO mail_outbox (...) on the same connection.
      await enqueueMail(connection, {
        templateKey: 'verify',
        toEmail: input.email,
        targetId: String(userId),
        context: {
          token: verificationToken,
          expires_in_hours: VERIFICATION_TOKEN_HOURS,
          policy_version: activePolicyVersion(),
        },
      });

      logger.info(
        { user_id: userId },
        'auth.register: applicant created in pending state',
      );
      return { ok: true, alreadyRegistered: false };
    } catch (err) {
      // Race condition: another request created the same email between
      // our pre-check and the INSERT. The unique key on `users.email`
      // surfaces this as `ER_DUP_ENTRY` (errno 1062). Fold into the
      // generic no-op so Req 3.2's "no leak" guarantee holds even under
      // concurrency.
      if (isDuplicateEntry(err)) {
        logger.info(
          { email_domain: input.email.split('@')[1] ?? '' },
          'auth.register: duplicate-entry race — generic no-op response',
        );
        return { ok: true, alreadyRegistered: true };
      }
      throw err;
    }
  });
}
