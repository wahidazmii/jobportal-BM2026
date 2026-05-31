/**
 * Applicant + internal login service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 10.1
 * Design  : §8.3 (lockout sequence), §8.4 (session lifecycle)
 * Validates: Requirements 3.5, 3.6, 3.7, 14.3
 *
 * Public surface:
 *   - `loginSchema`   — zod schema validating raw form input.
 *   - `LoginInput`    — type inferred from `loginSchema`.
 *   - `LoginContext`  — caller-supplied request metadata (ip, ua) needed
 *                       for `login_attempts` and `sessions` rows.
 *   - `LoginOutcome`  — discriminated union returned by `login()`:
 *                         `{ status: 'success', ... }` |
 *                         `{ status: 'locked',  ... }` |
 *                         `{ status: 'invalid_credentials' }`.
 *   - `login()`       — service function executed after the route handler
 *                       has parsed the body. The route layer wraps the
 *                       outcome into the appropriate HTTP response.
 *
 * Behaviour summary (Req 3.5, 3.6, 3.7, 14.3):
 *   1. **Lockout pre-check** (Req 3.7). Run a single SELECT against
 *      `login_attempts` counting failures for `email` within the last
 *      15 minutes. If `count > 5` return the `locked` outcome with a
 *      `retryAfterSeconds` value computed from the OLDEST failure's
 *      attempt timestamp (so `Retry-After` reflects when the window
 *      slides far enough to admit the next attempt).
 *   2. **Credential check** (Req 3.6). Look up `users` by email; if the
 *      row is missing or `status != 'active'` we still run bcrypt
 *      against a dummy hash to keep the timing profile uniform with the
 *      success path — so the response cannot be used to enumerate
 *      registered or active emails.
 *   3. **Failure path**. INSERT `login_attempts(email, success=0, ip)`
 *      and return `invalid_credentials`. The route renders a generic
 *      "Invalid email or password" message (Req 3.6: no leak).
 *   4. **Success path** (Req 3.5). INSERT `login_attempts(success=1)` for
 *      audit symmetry, then create a session via the MySQL session-store
 *      and return the `success` outcome with the redirect target.
 *      Applicant → `/:locale/me`; Super_Admin / HR / Department_Head →
 *      `/admin`.
 *
 * Notes on safety:
 *   - All SQL goes through prepared statements (mysql2 `?` placeholders)
 *     per Req 15.4; the local lint rule `local/no-string-concat-sql`
 *     enforces this at call sites.
 *   - We never reveal which arm of the failure tree triggered the
 *     `invalid_credentials` outcome (unknown email, wrong password,
 *     pending verification, disabled, deleted). The route layer treats
 *     them all identically.
 *   - Lockout is keyed on the submitted email only. An attacker who
 *     wishes to abuse this to lock out a real user can already do so
 *     by spamming failed logins on the same form; the per-IP rate
 *     limit (Req 14.3) is the orthogonal guard against that, applied
 *     by the route layer / Rate_Limiter (task 14.x).
 */

import bcrypt from 'bcrypt';
import { z } from 'zod';

import { query } from '../../infra/db.js';
import type { ResultSetHeader, RowDataPacket } from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import {
  type SessionMetadata,
  type SessionRecord,
  type UserRole,
  create as createSession,
} from '../../infra/session-store.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of failed attempts allowed in the lockout window before
 * further attempts return HTTP 429. Req 3.7: "exceeds 5 within 15 minutes".
 * The comparison is strictly greater than this value (`> 5`), so the 6th
 * failure is what trips the lock.
 */
export const LOCKOUT_MAX_FAILURES = 5;

/** Sliding-window length for the lockout counter. Req 3.7. */
export const LOCKOUT_WINDOW_MINUTES = 15;

/** Lockout window expressed in seconds, used to compute `Retry-After`. */
export const LOCKOUT_WINDOW_SECONDS = LOCKOUT_WINDOW_MINUTES * 60;

/** Maximum length of the password field accepted by the form (Design §8.5). */
export const MAX_PASSWORD_LENGTH = 128;

/** Maximum length of the email field accepted by the form (DDL: VARCHAR(254)). */
export const EMAIL_MAX_LEN = 254;

/** Redirect target for an authenticated Applicant (Design §8.1 sequence). */
export const REDIRECT_APPLICANT_PREFIX = '/me';

/** Redirect target for any internal role (Super_Admin / HR / Department_Head). */
export const REDIRECT_ADMIN = '/admin';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Login form schema. Intentionally permissive about content (a real
 * incorrect submission must still produce a generic
 * `invalid_credentials` outcome rather than a Zod validation error) —
 * we only enforce structural shape and the column-level length caps.
 *
 * The route layer parses with this schema; the service expects the
 * already-parsed shape.
 */
export const loginSchema = z
  .object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .max(EMAIL_MAX_LEN, { message: 'Email is too long' })
      .min(1, { message: 'Email is required' })
      .transform((v) => v.toLowerCase()),
    password: z
      .string({ required_error: 'Password is required' })
      .min(1, { message: 'Password is required' })
      .max(MAX_PASSWORD_LENGTH, { message: 'Password is too long' }),
  })
  .strict();

/** Strongly-typed input for `login()` — the parsed shape of the form. */
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-request metadata captured at submit time. The route handler is
 * responsible for extracting these from the Fastify request.
 *
 * `ipAddress` is mandatory for the `login_attempts.ip_address NOT NULL`
 * column — when the proxy didn't expose a usable client IP the route
 * should still pack a synthetic 16-byte value (e.g. all zeros) so the
 * INSERT does not fail.
 */
export interface LoginContext {
  /** Packed client IP (4- or 16-byte buffer). */
  readonly ipAddress: Buffer;
  /** Truncated User-Agent (≤ 255 chars), or null if unknown. */
  readonly userAgent?: string | null;
}

/** Successful authentication outcome. */
export interface LoginSuccess {
  readonly status: 'success';
  /** `users.id` of the authenticated user. */
  readonly userId: number;
  /** Effective role for this session. */
  readonly role: UserRole;
  /** Newly-created session row (sid + csrf token + timestamps). */
  readonly session: SessionRecord;
  /**
   * Path-only redirect target ('/' → applicant `/me`, internal → `/admin`).
   * The route layer prefixes the locale to the applicant target.
   */
  readonly redirectTo: typeof REDIRECT_APPLICANT_PREFIX | typeof REDIRECT_ADMIN;
}

/** Locked-out outcome — too many failures in the sliding window. */
export interface LoginLocked {
  readonly status: 'locked';
  /**
   * Number of seconds until the oldest in-window failure ages out, at
   * which point a fresh attempt MAY succeed. Always ≥ 1 so the
   * `Retry-After` header never advertises an immediate retry.
   */
  readonly retryAfterSeconds: number;
}

/** Generic credentials-rejected outcome (no enumeration, Req 3.6). */
export interface LoginInvalid {
  readonly status: 'invalid_credentials';
}

/** Discriminated union returned by `login()`. */
export type LoginOutcome = LoginSuccess | LoginLocked | LoginInvalid;

// ---------------------------------------------------------------------------
// SQL statements
// ---------------------------------------------------------------------------

/**
 * Single round-trip lockout query. Returns both the failure count and
 * the seconds remaining on the oldest failure's window so the route
 * layer can build `Retry-After` without a second query.
 *
 * `TIMESTAMPDIFF` returns a signed integer; `GREATEST(1, ...)` clamps
 * it so we never hand the client a non-positive value. When no rows
 * match, the aggregate row still comes back with `failure_count = 0`
 * and `retry_after_seconds = NULL` which we coerce to 0 below.
 */
const SELECT_LOCKOUT_SQL =
  'SELECT COUNT(*) AS failure_count, ' +
  '  GREATEST(1, COALESCE(' +
  '    TIMESTAMPDIFF(SECOND, NOW(), MIN(attempt_at) + INTERVAL 15 MINUTE), 0' +
  '  )) AS retry_after_seconds ' +
  'FROM login_attempts ' +
  'WHERE email = ? ' +
  '  AND success = 0 ' +
  '  AND attempt_at >= NOW() - INTERVAL 15 MINUTE';

/**
 * Look up the user record needed for authentication. Selects the
 * password hash, the role (for redirect + session creation), and the
 * status so we can reject pending/disabled/deleted accounts without
 * leaking the exact reason.
 */
const SELECT_USER_SQL =
  'SELECT id, password_hash, role, status FROM users WHERE email = ? LIMIT 1';

/** Append a row to `login_attempts` for both failure and success paths. */
const INSERT_ATTEMPT_SQL =
  'INSERT INTO login_attempts (email, ip_address, success) VALUES (?, ?, ?)';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface LockoutRow extends RowDataPacket {
  failure_count: number | string;
  retry_after_seconds: number | string | null;
}

interface UserRow extends RowDataPacket {
  id: number | string;
  password_hash: string;
  role: UserRole;
  status: 'pending' | 'active' | 'disabled' | 'deleted';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lazily-computed bcrypt hash used to keep the timing profile of the
 * "user not found" / "user inactive" branches indistinguishable from a
 * real `bcrypt.compare` against a stored hash. Without this step an
 * attacker can detect whether an email is registered by measuring the
 * response time of the login endpoint.
 *
 * The hash is generated once per process on first miss and reused; the
 * one-time cost is on the order of a single bcrypt-12 (~250 ms on the
 * cPanel container in §20.2) and runs on the worker that handles the
 * first cold login.
 */
let timingDummyHashPromise: Promise<string> | null = null;
function getTimingDummyHash(): Promise<string> {
  if (timingDummyHashPromise === null) {
    timingDummyHashPromise = bcrypt.hash(
      'login-timing-equaliser-not-a-real-password',
      12,
    );
  }
  return timingDummyHashPromise;
}

/**
 * Map `users.role` to the path-only redirect target. Applicant accounts
 * land on the profile dashboard; every internal role lands on the admin
 * console (the actual landing page is determined by the admin layout
 * based on RBAC, task 39).
 */
function redirectForRole(role: UserRole): LoginSuccess['redirectTo'] {
  return role === 'Applicant' ? REDIRECT_APPLICANT_PREFIX : REDIRECT_ADMIN;
}

/**
 * Run the lockout query and decide whether the email is currently
 * locked out. Returns a `LoginLocked` outcome when `failure_count > 5`,
 * otherwise `null` and the caller proceeds with credential verification.
 */
async function checkLockout(email: string): Promise<LoginLocked | null> {
  const rows = await query<LockoutRow[]>(SELECT_LOCKOUT_SQL, [email]);
  const row = rows[0];
  if (!row) {
    // Aggregate query always yields exactly one row; defensive fallback.
    return null;
  }
  const failureCount = Number(row.failure_count);
  if (!Number.isFinite(failureCount) || failureCount <= LOCKOUT_MAX_FAILURES) {
    return null;
  }
  const rawRetry = row.retry_after_seconds;
  const retryAfterSeconds =
    rawRetry === null || rawRetry === undefined
      ? LOCKOUT_WINDOW_SECONDS
      : Math.max(1, Number(rawRetry));
  return { status: 'locked', retryAfterSeconds };
}

/**
 * Persist a row to `login_attempts`. Best-effort: a transient DB error
 * here must NOT prevent the login outcome from being returned, so the
 * caller awaits this normally and any exception bubbles up to the
 * route's error handler. (The DB error is the unusual path; the common
 * failure path completes the INSERT successfully.)
 */
async function recordAttempt(
  email: string,
  ipAddress: Buffer,
  success: boolean,
): Promise<void> {
  await query<ResultSetHeader>(INSERT_ATTEMPT_SQL, [
    email,
    ipAddress,
    success ? 1 : 0,
  ]);
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Authenticate an email/password pair and, on success, create a fresh
 * session row.
 *
 * The function returns a discriminated `LoginOutcome` rather than
 * throwing on bad credentials: the route layer always wants to render
 * a 200/302/401/429 response and never a 500 for "wrong password",
 * so the success/failure paths are values rather than exceptions.
 *
 * Throws only on infrastructure errors (DB down, bcrypt module missing,
 * etc.) — the caller's onError hook surfaces those as 500s.
 */
export async function login(
  rawInput: unknown,
  ctx: LoginContext,
): Promise<LoginOutcome> {
  const input: LoginInput = loginSchema.parse(rawInput);

  // Step 1 — lockout pre-check (Req 3.7). Runs BEFORE bcrypt so a
  // locked-out account never burns the server's CPU on a doomed
  // hash compare, and so the lockout is enforced even when the
  // attacker happens to supply the correct password.
  const locked = await checkLockout(input.email);
  if (locked !== null) {
    logger.warn(
      {
        email_domain: input.email.split('@')[1] ?? '',
        retry_after_seconds: locked.retryAfterSeconds,
      },
      'auth.login: lockout active — rejected with 429',
    );
    return locked;
  }

  // Step 2 — look up the user. Missing / inactive rows fall through to
  // a dummy bcrypt comparison so timing stays uniform.
  const userRows = await query<UserRow[]>(SELECT_USER_SQL, [input.email]);
  const user = userRows[0] ?? null;

  // The expected hash for the comparison: real one when the row exists
  // AND the user is active; dummy hash otherwise. Resolving to the dummy
  // for missing/pending/disabled/deleted accounts gives every failure
  // path the same bcrypt-12 cost (Req 3.6 — no leak).
  const compareHash =
    user !== null && user.status === 'active'
      ? user.password_hash
      : await getTimingDummyHash();

  let passwordMatches = false;
  try {
    passwordMatches = await bcrypt.compare(input.password, compareHash);
  } catch (err) {
    // A malformed hash in `users.password_hash` is a data-integrity
    // bug; we treat it as a credential mismatch (no leak) but log so
    // operators can spot it.
    logger.error(
      { err, user_id: user?.id },
      'auth.login: bcrypt.compare threw — treating as invalid_credentials',
    );
    passwordMatches = false;
  }

  const isAuthorised =
    passwordMatches && user !== null && user.status === 'active';

  if (!isAuthorised) {
    await recordAttempt(input.email, ctx.ipAddress, false);
    // After this failure the count may now exceed the threshold; a
    // subsequent attempt will see the locked outcome via the pre-check
    // above. We still return invalid_credentials for the current
    // request — the spec only mandates 429 for *further* attempts (Req
    // 3.7: "WHILE … exceeds 5 … reject further login attempts").
    return { status: 'invalid_credentials' };
  }

  // Step 3 — success. Record the audit row and mint a session.
  await recordAttempt(input.email, ctx.ipAddress, true);

  const userId = Number(user.id);
  const sessionMeta: SessionMetadata = {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent ?? null,
  };
  const session = await createSession(userId, user.role, sessionMeta);

  logger.info(
    { user_id: userId, role: user.role, sid_prefix: session.sid.slice(0, 8) },
    'auth.login: session created',
  );

  return {
    status: 'success',
    userId,
    role: user.role,
    session,
    redirectTo: redirectForRole(user.role),
  };
}
