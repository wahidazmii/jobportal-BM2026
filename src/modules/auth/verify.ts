/**
 * Email verification service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 9.3
 * Design  : §8.1 (register → verify → login sequence)
 * Validates: Requirements 3.3, 3.4
 *
 * Public surface:
 *   - `verifyTokenSchema`        — zod schema for the `?token=...` query
 *                                  param (length-bounded base64url).
 *   - `consumeVerificationToken` — atomically mark a token used and a
 *                                  user active. Idempotent on the
 *                                  invalid/expired branch (Req 3.4).
 *   - `resendVerificationEmail`  — silently issue a fresh verification
 *                                  token + mail when the email belongs
 *                                  to a `pending` account; otherwise
 *                                  no-op (so the response cannot be used
 *                                  to enumerate accounts).
 *   - `resendSchema`             — zod schema for the resend form body
 *                                  (email + captcha).
 *
 * Behaviour summary:
 *
 *   `consumeVerificationToken(token)` (Req 3.3, 3.4):
 *     1. Open a transaction.
 *     2. `SELECT user_id FROM verification_tokens
 *           WHERE token = ? AND used_at IS NULL AND expires_at > NOW()
 *           FOR UPDATE` — row-locks the token row so a concurrent
 *           request cannot consume it twice.
 *     3. If missing → COMMIT no-op, return `{ status: 'invalid' }`.
 *        The HTTP layer renders a generic "invalid or expired" page;
 *        leaking which case it is would help an attacker enumerate
 *        recently-issued vs. never-issued tokens (Req 3.4).
 *     4. If found → `UPDATE users SET status='active',
 *        email_verified_at=NOW() WHERE id=? AND status='pending'`.
 *        The `AND status='pending'` guard makes the activation a no-op
 *        when the account is already active or has been disabled — but
 *        we still mark the token used in step 5 so it cannot be
 *        replayed.
 *     5. `UPDATE verification_tokens SET used_at=NOW() WHERE token=?`.
 *     6. COMMIT and return `{ status: 'verified', userId }`.
 *
 *   `resendVerificationEmail({ email })` (Req 3.4):
 *     1. Look up `users` by email. If found AND `status='pending'`:
 *        - Invalidate any prior unused tokens for this user
 *          (`UPDATE verification_tokens SET used_at=NOW()
 *            WHERE user_id=? AND used_at IS NULL`).
 *        - INSERT a new token with `expires_at = NOW() + INTERVAL 24
 *          HOUR`.
 *        - Enqueue the verify mail via `mail.enqueue` on the same
 *          connection (Design §12.3 transactional-enqueue).
 *     2. If not found OR not pending → silent no-op.
 *     3. Always returns `{ ok: true }` so the HTTP layer renders the
 *        same generic "if a pending account exists, we resent the
 *        link" page regardless of branch (Req 3.4 + Design §8.1's
 *        no-leak posture).
 */

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

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

/** Verification token lifetime per Req 3.1 / 3.4. */
export const VERIFICATION_TOKEN_HOURS = 24;

/**
 * Token width matches `verification_tokens.token CHAR(43)`. 32 random
 * bytes encoded as base64url produce exactly 43 chars (no padding).
 */
const TOKEN_BYTES = 32;

/** Maximum email length matches `users.email VARCHAR(254)`. */
const EMAIL_MAX_LEN = 254;

/** Mail template key reused with the registration verify mail. */
const VERIFY_TEMPLATE_KEY = 'verify';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Schema for the `?token=...` query parameter. Tokens are 43-char
 * base64url strings; we accept anything in that character set up to
 * the column width and let the SELECT decide whether the token exists.
 *
 * The schema does NOT enforce a length of exactly 43 — that would
 * cause a malformed length to skip the SELECT and emit a generic
 * "invalid or expired" page anyway, but it would also distinguish
 * "URL was clearly tampered" from "URL was unused/expired" in the
 * status code path. Keeping the schema permissive means every bad
 * token funnels through the same branch.
 */
export const verifyTokenSchema = z
  .string({ required_error: 'Verification token is required' })
  .min(1, { message: 'Verification token is required' })
  .max(64, { message: 'Verification token is too long' })
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: 'Verification token contains invalid characters',
  });

/**
 * Captcha-token presence check. The route layer re-uses the standard
 * hCaptcha verifier; the schema only ensures the form did not submit
 * an empty value.
 */
const captchaSchema = z
  .string({ required_error: 'Captcha verification is required' })
  .min(1, { message: 'Captcha verification is required' })
  .max(2048, { message: 'Captcha token is too long' });

/**
 * Public schema for the resend form. Mirrors the password-reset request
 * schema's email handling so unique-key comparisons against
 * `users.email` are stable.
 */
export const resendSchema = z
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

/** Strongly-typed input for `resendVerificationEmail()`. */
export type ResendInput = z.infer<typeof resendSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome of `consumeVerificationToken()`. */
export type ConsumeResult =
  | { readonly status: 'verified'; readonly userId: number }
  | { readonly status: 'invalid' };

/**
 * Outcome of `resendVerificationEmail()`.
 *
 * `tokenIssued` is exposed for **internal** logging and tests; the HTTP
 * layer must not branch on it (Req 3.4 — same generic response).
 */
export interface ResendResult {
  readonly ok: true;
  readonly tokenIssued: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a 32-byte token encoded as base64url (43 chars, no padding). */
function generateVerificationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

interface TokenRow extends RowDataPacket {
  user_id: number | string;
}

interface UserStatusRow extends RowDataPacket {
  id: number | string;
  status: 'pending' | 'active' | 'disabled' | 'deleted';
}

// ---------------------------------------------------------------------------
// Public service — consume token (GET /:locale/verify)
// ---------------------------------------------------------------------------

/**
 * Validate a verification token, activate the owning user, and mark
 * the token used — all in one transaction.
 *
 * The function returns a discriminated `ConsumeResult` rather than
 * throwing: the route layer always wants to render a 200 OK page (or a
 * 200 "invalid or expired" page) and never a 500 for an
 * already-used token.
 *
 * Throws only on infrastructure errors — the caller's onError hook
 * surfaces those as 500s.
 */
export async function consumeVerificationToken(
  rawToken: unknown,
): Promise<ConsumeResult> {
  // Reject obviously malformed tokens (missing field, wrong charset)
  // by returning the same `invalid` outcome the SELECT-miss path uses.
  // We catch the ZodError so the HTTP layer doesn't have to.
  const parsed = verifyTokenSchema.safeParse(rawToken);
  if (!parsed.success) {
    return { status: 'invalid' };
  }
  const token = parsed.data;

  return withTransaction(async (connection) => {
    // 1) Row-lock the token. The `FOR UPDATE` clause prevents two
    //    concurrent verify requests from both seeing an unused/unexpired
    //    row and both proceeding to update it.
    const [tokenRows] = await connection.execute<TokenRow[]>(
      'SELECT user_id FROM verification_tokens ' +
        'WHERE token = ? AND used_at IS NULL AND expires_at > NOW() ' +
        'LIMIT 1 FOR UPDATE',
      [token],
    );

    if (tokenRows.length === 0) {
      // Missing row, already used, or already expired — all collapse to
      // the same generic outcome (Req 3.4).
      return { status: 'invalid' };
    }

    const userId = Number(tokenRows[0]!.user_id);

    // 2) Activate the user. The `AND status='pending'` guard is
    //    deliberate: if the row is already `active` we still want to
    //    mark the token used (step 3) but not over-write
    //    `email_verified_at`. If the row is `disabled` or `deleted` we
    //    must NOT silently re-enable it via a verify link.
    await connection.execute<ResultSetHeader>(
      "UPDATE users SET status = 'active', email_verified_at = NOW() " +
        "WHERE id = ? AND status = 'pending'",
      [userId],
    );

    // 3) Mark the token consumed regardless of whether the UPDATE in
    //    step 2 actually matched — replay attempts (token reuse) are
    //    blocked by the `used_at IS NULL` predicate in step 1, but
    //    we still want to record consumption for audit symmetry.
    await connection.execute<ResultSetHeader>(
      'UPDATE verification_tokens SET used_at = NOW() WHERE token = ?',
      [token],
    );

    logger.info(
      { user_id: userId },
      'auth.verify: account activated and token consumed',
    );
    return { status: 'verified', userId };
  });
}

// ---------------------------------------------------------------------------
// Public service — resend verification email (POST /:locale/verify/resend)
// ---------------------------------------------------------------------------

/**
 * Captured request context the resend service needs but does not derive
 * from the form body. The route handler fills these in.
 */
export interface ResendContext {
  /**
   * Client IP for structured logging. Not persisted on
   * `verification_tokens` — the table is intentionally minimal.
   */
  readonly ipAddress?: string | null;
}

/**
 * Issue a fresh verification token (or silently no-op).
 *
 * Workflow:
 *   1. Validate `rawInput` via `resendSchema`.
 *   2. Open a transaction:
 *        a. Look up the user by email.
 *        b. If no row OR `status != 'pending'` → COMMIT no-op, return
 *           `{ ok: true, tokenIssued: false }`.
 *        c. Otherwise, mark prior unused tokens as used (so the
 *           previous link in the inbox stops working — Req 3.4
 *           "single-use"), INSERT a fresh token, and enqueue the
 *           `'verify'` mail on the same connection.
 *
 * Throws:
 *   - `z.ZodError` when `rawInput` violates the schema (the route
 *     layer should map this to 400 with field errors).
 *   - The original error for any non-recoverable database/mail failure.
 */
export async function resendVerificationEmail(
  rawInput: unknown,
  ctx: ResendContext = {},
): Promise<ResendResult> {
  const input: ResendInput = resendSchema.parse(rawInput);

  // Pre-generate the token outside the transaction so the row-lock
  // window stays narrow.
  const token = generateVerificationToken();

  return withTransaction(async (connection) => {
    const userId = await findPendingUserId(connection, input.email);

    if (userId === null) {
      // Req 3.4 — silent no-op. No INSERT, no mail enqueue. The route
      // layer returns the same generic response for both branches.
      logger.info(
        {
          email_domain: input.email.split('@')[1] ?? '',
          ip: ctx.ipAddress ?? null,
        },
        'auth.verify-resend: not pending — generic no-op response',
      );
      return { ok: true, tokenIssued: false };
    }

    // Invalidate any prior unused tokens for this user. This keeps the
    // single-use guarantee from Req 3.3 honest after a resend: a user
    // who clicks the OLD link after asking for a resend gets the same
    // "invalid or expired" page they would for any other consumed
    // token.
    await connection.execute<ResultSetHeader>(
      'UPDATE verification_tokens SET used_at = NOW() ' +
        'WHERE user_id = ? AND used_at IS NULL',
      [userId],
    );

    // INSERT the fresh token. The 24-hour interval literal is inlined
    // (rather than computed from `VERIFICATION_TOKEN_HOURS`) because
    // `local/no-string-concat-sql` rejects template-built SQL: 24 hours
    // is the fixed contract of Req 3.1 / 3.4.
    await connection.execute<ResultSetHeader>(
      'INSERT INTO verification_tokens (token, user_id, expires_at) ' +
        'VALUES (?, ?, NOW() + INTERVAL 24 HOUR)',
      [token, userId],
    );

    // Enqueue the verify mail atomically with the token row (Design
    // §12.3). Re-using `targetId = users.id` keeps a future
    // `INSERT IGNORE` natural-key dedup compatible with both the
    // initial register and any subsequent resend; in practice the
    // outbox INSERT under task 36.1 will INCLUDE a generation suffix
    // (e.g. token prefix) so each resend is its own row.
    await enqueueMail(connection, {
      templateKey: VERIFY_TEMPLATE_KEY,
      toEmail: input.email,
      targetId: `${userId}:${token}`,
      context: {
        token,
        expires_in_hours: VERIFICATION_TOKEN_HOURS,
      },
    });

    logger.info(
      { user_id: userId },
      'auth.verify-resend: fresh verification token issued',
    );
    return { ok: true, tokenIssued: true };
  });
}

/**
 * Look up a `users.id` by email, restricted to accounts in the
 * `'pending'` state (the only state that should receive a fresh verify
 * link). Returns `null` for missing or non-pending accounts so the
 * caller folds them into the same silent no-op branch.
 */
async function findPendingUserId(
  connection: PoolConnection,
  email: string,
): Promise<number | null> {
  const [rows] = await connection.execute<UserStatusRow[]>(
    'SELECT id, status FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0]!;
  if (row.status !== 'pending') {
    return null;
  }
  return Number(row.id);
}
