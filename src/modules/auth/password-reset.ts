/**
 * Password-reset services for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 11.1 (request reset endpoint),
 *           tasks.md task 11.2 (reset confirm endpoint)
 * Design  : §8.2 (password reset sequence)
 * Validates: Requirements 3.8, 3.9, 3.10
 *
 * Public surface (request flow — task 11.1):
 *   - `requestResetSchema`  — zod schema for the form body (email + captcha).
 *   - `RequestResetInput`   — type inferred from the schema.
 *   - `RequestResetResult`  — generic result the route layer returns.
 *   - `requestPasswordReset(input, ctx?)` — service function executed
 *                          after the route handler has parsed the body and
 *                          verified the hCaptcha token.
 *
 * Public surface (confirm flow — task 11.2):
 *   - `confirmResetSchema`  — zod schema for the form body (token + new
 *                          password).
 *   - `ConfirmResetInput`   — type inferred from the schema.
 *   - `ConfirmResetResult`  — `{ ok: true } | { ok: false, reason: 'invalid_token' }`.
 *   - `confirmPasswordReset(input)` — applies the new password and
 *                          invalidates the consumed token.
 *
 * Behaviour summary (Req 3.8, 3.9 / Design §8.2):
 *   - Validate email + captcha token via `requestResetSchema`.
 *   - Look up `users.id` by email (limited to active or pending accounts —
 *     a deleted/disabled account should not receive a reset link, but for
 *     the purposes of the "no leak" guarantee we still respond identically
 *     in that case).
 *   - **If a row exists**: INSERT a single-use `password_reset_tokens` row
 *     with a 60-minute expiry and enqueue a `'reset'` mail.
 *   - **If no row exists**: silently no-op. The HTTP layer must return the
 *     same generic response so an attacker cannot enumerate registered
 *     emails (Req 3.9).
 *   - The lookup → INSERT → mail-enqueue runs inside a single transaction
 *     (`withTransaction`) so a mail-outbox INSERT failure rolls back the
 *     token row — Design §12.3 transactional-enqueue contract.
 *
 * Captcha + per-IP rate limit are enforced by the route layer; this
 * service only validates that the captcha token field is well-formed
 * (non-empty, length-bounded) so the schema can be reused by tests.
 *
 * Tokens:
 *   - 32 random bytes encoded as base64url (43 chars, no padding) to fit
 *     the `password_reset_tokens.token CHAR(43)` column.
 *   - Expiry: `NOW() + INTERVAL 60 MINUTE` evaluated server-side so the
 *     database is the single source of truth for the deadline.
 */

import { randomBytes } from 'node:crypto';

import bcrypt from 'bcrypt';
import { z } from 'zod';

import {
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
  withTransaction,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { revokeAllForUser } from '../../infra/session-store.js';
import { enqueue as enqueueMail } from '../mail/service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reset token lifetime per Req 3.8 ("valid for 60 minutes"). */
export const RESET_TOKEN_MINUTES = 60;

/**
 * Token width matches `password_reset_tokens.token CHAR(43)`. 32 random
 * bytes encoded as base64url produce exactly 43 chars (no padding).
 */
const TOKEN_BYTES = 32;

/** Maximum email length matches the `users.email VARCHAR(254)` column. */
const EMAIL_MAX_LEN = 254;

/** Mail template key used by the future `mail_outbox` row. */
const RESET_TEMPLATE_KEY = 'reset';

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

/**
 * Captcha token presence. The actual provider check happens at the route
 * layer via `auth/captcha.ts`; the schema only ensures the form did not
 * submit an empty value.
 */
const captchaSchema = z
  .string({ required_error: 'Captcha verification is required' })
  .min(1, { message: 'Captcha verification is required' })
  .max(2048, { message: 'Captcha token is too long' });

/**
 * Public schema for the password-reset request form. The trim + lowercase
 * transform mirrors `registerSchema` so the lookup against the unique
 * `uk_users_email` index is stable.
 */
export const requestResetSchema = z
  .object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .max(EMAIL_MAX_LEN, { message: 'Email is too long' })
      .email({ message: 'Please enter a valid email address' })
      .transform((v) => v.toLowerCase()),
    captchaToken: captchaSchema,
  })
  .strict();

/** Strongly-typed input for `requestPasswordReset()`. */
export type RequestResetInput = z.infer<typeof requestResetSchema>;

// ---------------------------------------------------------------------------
// Service result
// ---------------------------------------------------------------------------

/**
 * Result of `requestPasswordReset()`. The same shape is returned for both
 * the "user found" and "user not found" branches so the route layer can
 * render the same generic confirmation message — see Req 3.9 (no leak).
 *
 * `tokenIssued` is exposed for **internal** logging and tests; the HTTP
 * layer must not branch on it.
 */
export interface RequestResetResult {
  /** Always `true` on a normal completion (validation errors throw). */
  readonly ok: true;
  /** True iff a token row was actually inserted. */
  readonly tokenIssued: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a 32-byte token encoded as base64url (43 chars, no padding). */
function generateResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

interface UserIdRow extends RowDataPacket {
  id: number | string;
  status: string;
}

/**
 * Look up an existing user by email. Returns the numeric `users.id` when
 * a row exists and the account is in a state that should receive reset
 * mail (`'pending'` or `'active'`). Returns `null` for missing or
 * disabled/deleted accounts.
 *
 * Disabled / deleted accounts are treated identically to "no such email"
 * because Req 3.9 only requires response indistinguishability, and we do
 * not want to mail a reset link to a banned account.
 */
async function findEligibleUserId(
  connection: PoolConnection,
  email: string,
): Promise<number | null> {
  const [rows] = await connection.execute<UserIdRow[]>(
    'SELECT id, status FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0]!;
  if (row.status !== 'active' && row.status !== 'pending') {
    return null;
  }
  return Number(row.id);
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Captured request context the service layer needs but does not derive
 * from the form body. The route handler fills these in.
 */
export interface RequestResetContext {
  /**
   * Client IP for structured logging (and, in future, audit-event row).
   * Not persisted on `password_reset_tokens` — the table is intentionally
   * minimal per migration 0001_init.sql.
   */
  readonly ipAddress?: string | null;
}

/**
 * Issue a password-reset token (or silently no-op).
 *
 * Workflow:
 *   1. Validate `rawInput` via `requestResetSchema`.
 *   2. Open a transaction (`withTransaction`):
 *        a. Look up the user by email.
 *        b. If no eligible row → COMMIT no-op, return
 *           `{ ok: true, tokenIssued: false }`.
 *        c. Otherwise INSERT `password_reset_tokens(token, user_id,
 *           expires_at = NOW() + INTERVAL 60 MINUTE)` and enqueue the
 *           `'reset'` mail on the same connection. If the mail enqueue
 *           throws, `withTransaction` rolls back the token row too
 *           (Design §12.3).
 *
 * Throws:
 *   - `z.ZodError` when `rawInput` violates the schema.
 *   - The original error for any non-recoverable database/mail failure
 *     (after `withTransaction` has rolled the row back). The route layer
 *     should map these to a generic 500 / re-render — never reveal
 *     details that would let an attacker distinguish branches.
 */
export async function requestPasswordReset(
  rawInput: unknown,
  ctx: RequestResetContext = {},
): Promise<RequestResetResult> {
  const input: RequestResetInput = requestResetSchema.parse(rawInput);

  // Pre-generate the token outside the transaction so the row-lock window
  // stays narrow. randomBytes is synchronous + cheap, so this is purely a
  // readability choice rather than a performance one.
  const token = generateResetToken();

  return withTransaction(async (connection) => {
    const userId = await findEligibleUserId(connection, input.email);

    if (userId === null) {
      // Req 3.9 — silently no-op. No INSERT, no mail enqueue. The route
      // layer returns the same response shape as the success branch.
      logger.info(
        {
          email_domain: input.email.split('@')[1] ?? '',
          ip: ctx.ipAddress ?? null,
        },
        'auth.password-reset: unknown email — generic no-op response',
      );
      return { ok: true, tokenIssued: false };
    }

    // INSERT the single-use token. The expiry literal is inlined so the
    // local lint rule `no-string-concat-sql` passes — 60 minutes is the
    // fixed contract of Req 3.8 / Design §8.2 and is not parameterised.
    await connection.execute<ResultSetHeader>(
      'INSERT INTO password_reset_tokens (token, user_id, expires_at) ' +
        'VALUES (?, ?, NOW() + INTERVAL 60 MINUTE)',
      [token, userId],
    );

    // Enqueue the reset mail atomically with the token row (Design §12.3).
    // The mail service is a stub today (task 35.1 wires the real INSERT
    // INTO mail_outbox); contract is identical so no call-site change is
    // needed when the stub goes away.
    await enqueueMail(connection, {
      templateKey: RESET_TEMPLATE_KEY,
      toEmail: input.email,
      targetId: `${userId}:${token}`,
      context: {
        token,
        expires_in_minutes: RESET_TOKEN_MINUTES,
      },
    });

    logger.info(
      { user_id: userId },
      'auth.password-reset: reset token issued',
    );
    return { ok: true, tokenIssued: true };
  });
}

// ===========================================================================
// CONFIRM FLOW (task 11.2)
// ===========================================================================
//
// `GET /:locale/password/reset/:token` renders the new-password form.
// `POST /:locale/password/reset/:token` accepts the new password, swaps the
// `users.password_hash`, marks the token used, and revokes every session
// belonging to the user (Req 3.10 — Design §8.2).
//
// The structural shape of a token (43 base64url chars) is enforced by both
// the schema below and the GET handler so a clearly-malformed URL renders
// the generic "invalid token" page without a database round-trip. The
// authoritative validity check (unused + unexpired + matching user) still
// happens inside the transaction so a token used by a concurrent request
// cannot be redeemed twice.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum password length per Req 3.1 / shared with `auth/register.ts`. */
export const RESET_MIN_PASSWORD_LENGTH = 10;

/**
 * Maximum password length the form accepts. bcrypt silently truncates at
 * 72 bytes; the form caps at 128 chars to match `auth/register.ts`
 * (Design §8.5).
 */
export const RESET_MAX_PASSWORD_LENGTH = 128;

/**
 * bcrypt cost mandated by Req 3.10 ("at least 12"). Mirrors the value
 * used at registration time so a reset hash is indistinguishable from a
 * fresh-account hash.
 */
export const RESET_BCRYPT_COST = 12;

/**
 * Base64url length of a `password_reset_tokens.token`. 32 random bytes
 * encoded as base64url produce exactly 43 chars (no padding).
 */
export const RESET_TOKEN_LENGTH = 43;

/** Regex matching the structural shape of a reset token (43 base64url chars). */
const TOKEN_STRUCTURAL_RE = /^[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Same password rule as `auth/register.ts`: ≥10 chars, ≤128 chars,
 * containing at least one letter and one digit. Re-implemented here
 * (rather than imported from `register.ts`) so the two services have
 * independent contracts and a future divergence (e.g. a stricter
 * post-incident reset rule) is a one-file change.
 */
const newPasswordSchema = z
  .string({ required_error: 'Password is required' })
  .min(RESET_MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${RESET_MIN_PASSWORD_LENGTH} characters`,
  })
  .max(RESET_MAX_PASSWORD_LENGTH, {
    message: `Password must be at most ${RESET_MAX_PASSWORD_LENGTH} characters`,
  })
  .refine((pw) => /[A-Za-z]/.test(pw), {
    message: 'Password must contain at least one letter',
  })
  .refine((pw) => /\d/.test(pw), {
    message: 'Password must contain at least one digit',
  });

/**
 * Token shape: structurally a 43-char base64url string. Anything else is
 * rejected before we touch the database (Req 3.8 — invalid links must
 * render the same generic error page).
 */
const tokenSchema = z
  .string({ required_error: 'Reset token is required' })
  .regex(TOKEN_STRUCTURAL_RE, { message: 'Invalid reset token format' });

/**
 * Public schema for the password-reset confirm form.
 */
export const confirmResetSchema = z
  .object({
    token: tokenSchema,
    newPassword: newPasswordSchema,
  })
  .strict();

/** Strongly-typed input for `confirmPasswordReset()`. */
export type ConfirmResetInput = z.infer<typeof confirmResetSchema>;

// ---------------------------------------------------------------------------
// Service result
// ---------------------------------------------------------------------------

/**
 * Result of `confirmPasswordReset()`.
 *
 *   - `{ ok: true }` — token was valid, password updated, sessions
 *     revoked. The route layer renders the "password updated, please log
 *     in" page.
 *   - `{ ok: false, reason: 'invalid_token' }` — token was missing,
 *     expired, or already used. The route layer renders the same
 *     generic "invalid or expired link" page rendered by the GET
 *     handler so an attacker cannot distinguish "token does not exist"
 *     from "token already consumed" or "token expired".
 *
 * Note that schema validation errors (weak password, malformed token in
 * the body) still throw `z.ZodError` so the route layer can surface
 * field-level guidance.
 */
export type ConfirmResetResult =
  | { readonly ok: true; readonly userId: number }
  | { readonly ok: false; readonly reason: 'invalid_token' };

// ---------------------------------------------------------------------------
// Helper: structural token check (exported so the GET handler can reuse it)
// ---------------------------------------------------------------------------

/**
 * Return `true` when `token` has the structural shape of a base64url
 * 32-byte token (43 chars, base64url alphabet, no padding). This is the
 * cheapest filter the GET handler can apply to short-circuit obviously
 * malformed `/password/reset/:token` URLs.
 */
export function isStructurallyValidResetToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_STRUCTURAL_RE.test(token);
}

// ---------------------------------------------------------------------------
// Internal types and helpers
// ---------------------------------------------------------------------------

interface ResetTokenRow extends RowDataPacket {
  user_id: number | string;
}

/**
 * Look up the user the token belongs to, locking the row so a concurrent
 * confirm request blocks until we either consume or reject this attempt.
 *
 * Filters: `used_at IS NULL` (single-use) and `expires_at > NOW()` (60-min
 * window from issuance, Req 3.8). A matched-but-stale token resolves to
 * `null` exactly like a missing token — Req 3.8 requires a generic "link
 * is invalid or expired" UX without leaking which case applies.
 *
 * The `FOR UPDATE` clause holds the row lock until the surrounding
 * transaction commits or rolls back, preventing the
 * "two browsers, same token, both win" race.
 */
async function lockTokenForConsumption(
  connection: PoolConnection,
  token: string,
): Promise<number | null> {
  const [rows] = await connection.execute<ResetTokenRow[]>(
    'SELECT user_id FROM password_reset_tokens ' +
      'WHERE token = ? AND used_at IS NULL AND expires_at > NOW() ' +
      'LIMIT 1 FOR UPDATE',
    [token],
  );
  if (rows.length === 0) {
    return null;
  }
  return Number(rows[0]!.user_id);
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Apply a new password using a single-use reset token.
 *
 * Workflow (inside `withTransaction`):
 *   1. SELECT … FOR UPDATE the token row (must be unused + unexpired).
 *   2. If missing → return `{ ok: false, reason: 'invalid_token' }`.
 *   3. bcrypt-hash the new password (cost 12, Req 3.10).
 *   4. UPDATE `users.password_hash` for that user_id.
 *   5. UPDATE `password_reset_tokens.used_at = NOW()` to invalidate the
 *      token — single-use semantics (Req 3.8).
 *
 * Session revocation (Design §8.2 / Req 3.10) runs AFTER the transaction
 * commits. Trade-off: `session-store.revokeAllForUser` uses the global
 * `pool.execute` rather than the transaction-scoped connection, so we
 * cannot include it inside the same transaction without refactoring the
 * session store. Phase 2 chooses to defer the refactor — by the time we
 * call `revokeAllForUser`, the password has already changed, so any
 * adversary still holding a valid sid for that user can only race the
 * delete by a few milliseconds. Worst case: an attacker observes the
 * commit, races the in-flight request to use a stolen sid, and gets
 * served until the next request after the delete commits. This is
 * acceptable for Phase 2; a follow-up task can move session revocation
 * onto the transaction connection once the session-store API is
 * generalised to accept an external connection.
 *
 * Throws:
 *   - `z.ZodError` for invalid input (weak password, malformed token).
 *   - The original error for any non-recoverable database failure
 *     (after `withTransaction` has rolled the row back).
 */
export async function confirmPasswordReset(
  rawInput: unknown,
): Promise<ConfirmResetResult> {
  const input: ConfirmResetInput = confirmResetSchema.parse(rawInput);

  // bcrypt outside the transaction so the row-lock window stays narrow.
  // Even if the token turns out to be invalid, bcrypt hashing also keeps
  // the timing profile uniform between the "valid" and "invalid" branches
  // — an attacker cannot use response latency to enumerate valid tokens.
  const newHash = await bcrypt.hash(input.newPassword, RESET_BCRYPT_COST);

  const txnResult = await withTransaction<ConfirmResetResult>(
    async (connection) => {
      const userId = await lockTokenForConsumption(connection, input.token);

      if (userId === null) {
        // Req 3.8 — token missing / expired / already used. Generic
        // failure shape; the route renders the same page as the GET
        // handler does for malformed URLs.
        logger.info(
          { event: 'password-reset.confirm', outcome: 'invalid_token' },
          'auth.password-reset: confirm rejected — invalid or expired token',
        );
        return { ok: false, reason: 'invalid_token' };
      }

      // 1) Update users.password_hash. The bcrypt hash is exactly 60
      //    chars; the column is VARCHAR(72) which has the headroom for
      //    future algorithm bumps.
      const updUser = await connection.execute<ResultSetHeader>(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [newHash, userId],
      );
      const updUserHeader = updUser[0] as ResultSetHeader;
      if (updUserHeader.affectedRows !== 1) {
        // The user row should always exist (FK on password_reset_tokens
        // makes orphan tokens impossible). If it doesn't, treat the
        // token as invalid rather than attempting recovery — this is the
        // safest failure mode for a credential change.
        logger.warn(
          { user_id: userId },
          'auth.password-reset: confirm could not update user row',
        );
        return { ok: false, reason: 'invalid_token' };
      }

      // 2) Mark the token consumed. Updating by `token` (the PK) is a
      //    single-row primary-key dive. Any future incoming request
      //    presenting the same token will fail the `used_at IS NULL`
      //    filter in step 1 and resolve to `invalid_token`.
      await connection.execute<ResultSetHeader>(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE token = ?',
        [input.token],
      );

      logger.info(
        { user_id: userId, event: 'password-reset.confirm' },
        'auth.password-reset: password updated, token consumed',
      );
      return { ok: true, userId };
    },
  );

  // Post-commit: revoke every session for the user so other devices /
  // browser tabs are forced to re-authenticate with the new password
  // (Req 3.10 / Design §8.2). See the workflow comment above for why
  // this runs outside the transaction.
  if (txnResult.ok) {
    try {
      const revoked = await revokeAllForUser(txnResult.userId);
      logger.info(
        { user_id: txnResult.userId, sessions_revoked: revoked },
        'auth.password-reset: revoked all sessions after password change',
      );
    } catch (err) {
      // The password change has already committed at this point. We log
      // a warning and let the caller render the success page anyway —
      // a stale session can also be force-closed by `session-gc` and by
      // the user logging out. The alternative (rolling back the password
      // change) would leave the user locked into their old credentials.
      logger.warn(
        { err, user_id: txnResult.userId },
        'auth.password-reset: session revocation failed after password change',
      );
    }
  }

  return txnResult;
}
