/**
 * MySQL-backed session store for PT Buana Megah Job Portal.
 *
 * Owns every server-side session row and exposes the CRUD surface used by
 * the auth module (login, logout, password-reset revocation) and the
 * authenticated-request middleware (read + touch).
 *
 * Design contract (§8.4 / §8.6):
 *   - Cookie name `__Host-sid`, attributes `HttpOnly; Secure; SameSite=Lax;
 *     Path=/`. The `__Host-` prefix mandates `Secure` + `Path=/` and
 *     forbids `Domain=`, which together neutralise sub-domain hijacks.
 *   - Session id and CSRF token are each 32 random bytes encoded as
 *     base64url (43 chars), matching the `CHAR(43)` columns in the
 *     `sessions` table (`id`, `csrf_token`).
 *   - Idle timeout: 30 minutes (`last_active_at` must be within the last
 *     30 minutes for the session to remain valid).
 *   - Absolute timeout: 12 hours (`expires_at = created_at + INTERVAL
 *     12 HOUR`); a session is invalid past `expires_at` regardless of how
 *     recent the last activity was.
 *
 * Notes on the API:
 *   - `create(userId, role, meta?)` accepts the freshly-fetched role from
 *     the caller's user lookup so the returned record can be threaded into
 *     the response without a second query. The role is **not** persisted
 *     on the row — `read()` re-fetches it via a JOIN so role changes (e.g.
 *     demotion) take effect on the next authenticated request.
 *   - `touch(sid)` uses `GREATEST(last_active_at, NOW())` so the column is
 *     monotonically non-decreasing even under server clock skew, which is
 *     the invariant `Property 2: SessionMonotonicityProperty` validates.
 *   - All SQL goes through prepared statements (mysql2 `?` placeholders)
 *     per Req 15.4; the local lint rule `local/no-string-concat-sql`
 *     enforces this at call sites.
 *
 * Validates: Requirements 3.5 (Design §8.4)
 */

import { randomBytes } from 'node:crypto';

import type { ResultSetHeader, RowDataPacket } from './db.js';
import { query } from './db.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Number of random bytes that back a session id / CSRF token. */
export const TOKEN_BYTES = 32;

/** Length of a base64url-encoded 32-byte token (no padding). */
export const TOKEN_LENGTH = 43;

/** Idle timeout in minutes — requests further apart invalidate the session. */
export const IDLE_TIMEOUT_MINUTES = 30;

/** Idle timeout expressed in milliseconds, for in-process arithmetic/tests. */
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60 * 1000;

/** Absolute lifetime of a session row from creation. */
export const ABSOLUTE_TIMEOUT_HOURS = 12;

/** Absolute timeout in milliseconds, for in-process arithmetic/tests. */
export const ABSOLUTE_TIMEOUT_MS = ABSOLUTE_TIMEOUT_HOURS * 60 * 60 * 1000;

/**
 * Session cookie name. The `__Host-` prefix is browser-enforced: any
 * `Set-Cookie` carrying this prefix is rejected unless it is also `Secure`,
 * has `Path=/`, and omits `Domain`. We serve the apex over HTTPS so the
 * prefix is always satisfiable in production (Design §8.4).
 */
export const SESSION_COOKIE_NAME = '__Host-sid';

/**
 * CSRF token cookie name. Non-`HttpOnly` so the htmx beforeRequest hook can
 * mirror it into the `X-CSRF-Token` header (Design §8.6).
 */
export const CSRF_COOKIE_NAME = 'csrf_token';

/**
 * Cookie attributes mandated by Design §8.4. Frozen so callers can spread it
 * into `reply.setCookie(...)` calls without accidentally mutating the shared
 * object. The shape is compatible with `@fastify/cookie`'s `CookieOptions`.
 */
export const SESSION_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Roles defined by the `users.role` ENUM in `migrations/0001_init.sql`. */
export type UserRole =
  | 'Super_Admin'
  | 'HR'
  | 'Department_Head'
  | 'Applicant';

/** Per-session metadata captured at login time. Both fields are optional. */
export interface SessionMetadata {
  /**
   * IP address packed as a 4- or 16-byte buffer (mysql2 returns
   * `VARBINARY(16)` as `Buffer`). Pass `null` to omit.
   */
  readonly ipAddress?: Buffer | null;
  /**
   * User-Agent header truncated to the first 255 chars to fit the column.
   * Truncation is the caller's responsibility; we store whatever is given.
   */
  readonly userAgent?: string | null;
}

/**
 * Canonical session record returned by `create` / `read`. `role` is fetched
 * from `users.role` on read (so promotions/demotions propagate); on create
 * it echoes the value the caller passed.
 */
export interface SessionRecord {
  /** Base64url-encoded 32-byte session id (43 chars). Identical to cookie value. */
  readonly sid: string;
  /** `users.id` of the authenticated user. */
  readonly userId: number;
  /** Effective role for this request — see API note above. */
  readonly role: UserRole;
  /** Base64url-encoded 32-byte CSRF token (43 chars). */
  readonly csrfToken: string;
  /** `sessions.created_at` from the DB. */
  readonly createdAt: Date;
  /** `sessions.last_active_at` from the DB (refreshed by `touch`). */
  readonly lastActiveAt: Date;
  /** `sessions.expires_at` — absolute timeout boundary. */
  readonly expiresAt: Date;
  /** Bound IP address, as stored. `null` if not captured. */
  readonly ipAddress: Buffer | null;
  /** Bound User-Agent string. `null` if not captured. */
  readonly userAgent: string | null;
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 32-byte token encoded as base64url
 * (43 chars, no padding). Used for both session ids and CSRF tokens; both
 * columns are `CHAR(43)` so the encoding is fixed-width.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

// ---------------------------------------------------------------------------
// SQL statements
// ---------------------------------------------------------------------------

/**
 * `expires_at` is computed in SQL so the database is the single source of
 * truth for "now" and the absolute timeout. `created_at` and
 * `last_active_at` fall back to their column defaults (`CURRENT_TIMESTAMP`).
 */
const INSERT_SESSION_SQL =
  'INSERT INTO sessions (id, user_id, csrf_token, ip_address, user_agent, expires_at) ' +
  'VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL 12 HOUR)';

/**
 * `read()` enforces both the idle and absolute timeouts in the WHERE clause
 * so an expired row is invisible to callers without a separate validity
 * check. Joining `users` lets us return the *current* role, not a snapshot.
 */
const SELECT_SESSION_SQL =
  'SELECT s.id AS sid, s.user_id AS userId, u.role AS role, ' +
  's.csrf_token AS csrfToken, s.created_at AS createdAt, ' +
  's.last_active_at AS lastActiveAt, s.expires_at AS expiresAt, ' +
  's.ip_address AS ipAddress, s.user_agent AS userAgent ' +
  'FROM sessions s ' +
  'JOIN users u ON u.id = s.user_id ' +
  'WHERE s.id = ? ' +
  '  AND s.expires_at > NOW() ' +
  '  AND s.last_active_at >= NOW() - INTERVAL 30 MINUTE ' +
  'LIMIT 1';

/**
 * `GREATEST(last_active_at, NOW())` guarantees monotonicity even if the
 * server clock briefly rewinds (NTP step). The WHERE clause keeps the
 * touch idempotent for already-expired sessions: an idle/absolute-timed-out
 * row is left untouched and will be GC'd by `session-gc`.
 */
const TOUCH_SESSION_SQL =
  'UPDATE sessions ' +
  'SET last_active_at = GREATEST(last_active_at, NOW()) ' +
  'WHERE id = ? ' +
  '  AND expires_at > NOW() ' +
  '  AND last_active_at >= NOW() - INTERVAL 30 MINUTE';

const DELETE_SESSION_SQL = 'DELETE FROM sessions WHERE id = ?';

const DELETE_USER_SESSIONS_SQL = 'DELETE FROM sessions WHERE user_id = ?';

/** Row shape returned by `SELECT_SESSION_SQL`. */
interface SessionRow extends RowDataPacket {
  sid: string;
  userId: number;
  role: UserRole;
  csrfToken: string;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  ipAddress: Buffer | null;
  userAgent: string | null;
}

// ---------------------------------------------------------------------------
// CRUD API
// ---------------------------------------------------------------------------

/**
 * Create a new session for `userId` and return its canonical record.
 *
 * Generates a fresh session id and CSRF token, inserts the row, then
 * re-reads it so the returned `createdAt` / `lastActiveAt` / `expiresAt`
 * carry the DB-authoritative timestamps (these are the values the cron
 * `session-gc` will compare against, so callers must not synthesise them
 * client-side).
 *
 * The `role` argument is echoed back into the returned record but is
 * **not** persisted. See the file header for the rationale.
 */
export async function create(
  userId: number,
  role: UserRole,
  meta: SessionMetadata = {},
): Promise<SessionRecord> {
  const sid = generateToken();
  const csrfToken = generateToken();
  const ipAddress = meta.ipAddress ?? null;
  const userAgent = meta.userAgent ?? null;

  await query<ResultSetHeader>(INSERT_SESSION_SQL, [
    sid,
    userId,
    csrfToken,
    ipAddress,
    userAgent,
  ]);

  // Re-fetch so the returned timestamps come from the DB rather than from
  // an in-process `new Date()` (which would differ from the row by the
  // round-trip latency).
  const fresh = await read(sid);
  if (!fresh) {
    // Should not happen — the row was just inserted with `expires_at` 12
    // hours in the future and `last_active_at` defaulting to NOW(). If the
    // re-fetch misses, something out-of-band (clock jump backwards, FK
    // cascade) has invalidated the row.
    throw new Error('session-store: created session not visible after insert');
  }
  // Guarantee the caller-supplied role propagates even if the JOIN read it
  // from a stale replica or the user row's role changed concurrently.
  return { ...fresh, role };
}

/**
 * Look up an active session by id. Returns `null` if the row is missing,
 * past its absolute timeout, or has been idle for more than 30 minutes.
 *
 * Callers should treat a `null` result as "unauthenticated" and clear the
 * `__Host-sid` cookie to stop the browser from re-presenting it.
 */
export async function read(sid: string): Promise<SessionRecord | null> {
  // Defensive: reject obviously malformed ids without a round-trip. The
  // column is fixed-width `CHAR(43)`, so anything else cannot match.
  if (typeof sid !== 'string' || sid.length !== TOKEN_LENGTH) {
    return null;
  }

  const rows = await query<SessionRow[]>(SELECT_SESSION_SQL, [sid]);
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    sid: row.sid,
    userId: Number(row.userId),
    role: row.role,
    csrfToken: row.csrfToken,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    expiresAt: row.expiresAt,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  };
}

/**
 * Refresh the activity timestamp for an authenticated request. Returns
 * `true` if the row was found and updated (i.e. the session is still
 * valid), `false` otherwise.
 *
 * Note: when `last_active_at` is already at or past `NOW()` (e.g. two
 * touches arrive within the same MySQL second), MySQL reports
 * `affectedRows = 0` even though the row existed. We therefore check
 * `affectedRows >= 1`. Callers that need a strict "row matched" signal
 * should `read()` afterwards.
 */
export async function touch(sid: string): Promise<boolean> {
  if (typeof sid !== 'string' || sid.length !== TOKEN_LENGTH) {
    return false;
  }
  const result = await query<ResultSetHeader>(TOUCH_SESSION_SQL, [sid]);
  return result.affectedRows >= 1;
}

/**
 * Delete a single session row (logout). Idempotent — calling `destroy`
 * with an unknown sid is a no-op.
 */
export async function destroy(sid: string): Promise<void> {
  if (typeof sid !== 'string' || sid.length !== TOKEN_LENGTH) {
    return;
  }
  await query<ResultSetHeader>(DELETE_SESSION_SQL, [sid]);
}

/**
 * Delete every session belonging to `userId`. Used by:
 *   - the password-reset confirm endpoint, which "revokes all sessions"
 *     after a password change (Design §8.2 / Req 3.10);
 *   - the admin "force logout" tools added later in the auth phase.
 *
 * Returns the number of rows deleted so the caller can log how many
 * devices were signed out.
 */
export async function revokeAllForUser(userId: number): Promise<number> {
  const result = await query<ResultSetHeader>(DELETE_USER_SESSIONS_SQL, [
    userId,
  ]);
  return result.affectedRows;
}
