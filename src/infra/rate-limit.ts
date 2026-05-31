/**
 * Sliding-window rate limiter for PT Buana Megah Job Portal.
 *
 * Backed by the `rate_limits` table created in migration 0001_init.sql:
 *
 *   bucket             VARCHAR(64) NOT NULL PRIMARY KEY,
 *   count              INT UNSIGNED NOT NULL DEFAULT 0,
 *   window_started_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
 *
 * Each call site picks an opaque `bucket` string (e.g. `register:ip:1.2.3.4`,
 * `login:ip:…`) and a window. The limiter keeps a single row per bucket
 * holding the current window's hit count and the moment that window was
 * opened. Once the window elapses (`NOW() - window_started_at >= window`),
 * the next hit resets the row to a fresh window with count = 1.
 *
 * Public surface (per task 9.2 — registration scenario):
 *
 *   - `checkRateLimit(bucket, { max, windowSeconds })`
 *       → returns `{ allowed, retryAfterSec }`. Pure read — does NOT
 *         increment the counter. The caller decides when to record a hit.
 *   - `recordHit(bucket, { windowSeconds })`
 *       → increments the counter for the bucket, opening a fresh window
 *         when the previous window has elapsed. Idempotent within a
 *         single window only — every call increments by 1.
 *
 * The split (check then record) lets the registration flow honour the
 * design's "5 SUCCESSFUL registrations per IP per hour" rule from
 * Req 14.2: we check on every POST but only call `recordHit` after the
 * service layer reports success, so brute-force attempts that fail
 * validation never burn through the cap.
 *
 * Constants for the registration bucket are exported so route handlers
 * and tests share the same configuration:
 *
 *   - `REGISTER_BUCKET_PREFIX = 'register:ip:'`
 *   - `REGISTER_LIMIT          = 5`
 *   - `REGISTER_WINDOW_SECONDS = 3600` (1 hour)
 *
 * Validates: Requirements 14.2, 14.5 (Design §6 Auth)
 */

import { query, type ResultSetHeader, type RowDataPacket } from './db.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Bucket-key prefix for the registration endpoint per Req 14.2. */
export const REGISTER_BUCKET_PREFIX = 'register:ip:';

/** Successful registrations allowed per IP per window (Req 14.2). */
export const REGISTER_LIMIT = 5;

/** Window length applied to `REGISTER_LIMIT` (Req 14.2 — "per hour"). */
export const REGISTER_WINDOW_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Verification resend (task 9.3)
// ---------------------------------------------------------------------------

/**
 * Bucket-key prefix for the verify-email resend endpoint.
 *
 * Format: `verify-resend:ip:<request.ip>`. The 14-char prefix plus an
 * IPv6 string (≤ 39 chars) stays well below `MAX_BUCKET_LENGTH = 64`.
 */
export const VERIFY_RESEND_BUCKET_PREFIX = 'verify-resend:ip:';

/**
 * Cap on resend attempts per IP per window. Task 9.3 in tasks.md sets
 * this at 5/hour, matching the registration cap (Req 14.2). The
 * limiter is keyed on IP only; the route layer additionally hides the
 * existence of pending accounts so a per-email bucket would itself
 * leak that information.
 */
export const VERIFY_RESEND_LIMIT = 5;

/** Window length applied to `VERIFY_RESEND_LIMIT` (1 hour). */
export const VERIFY_RESEND_WINDOW_SECONDS = 60 * 60;

/**
 * Hard cap on `bucket` length so callers cannot exceed the column's
 * `VARCHAR(64)` declared in 0001_init.sql.
 */
export const MAX_BUCKET_LENGTH = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options passed to `checkRateLimit` and `recordHit`. */
export interface RateLimitOptions {
  /** Maximum hits permitted in one window. */
  readonly max: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

/** Outcome of a `checkRateLimit` call. */
export interface RateLimitDecision {
  /**
   * `true` when the next hit may proceed (the caller still needs to call
   * `recordHit` after a successful operation to consume the slot).
   * `false` when the bucket is at its cap for the current window.
   */
  readonly allowed: boolean;
  /**
   * Number of seconds the caller should wait before retrying. Always set
   * when `allowed === false`; otherwise omitted. Suitable for the
   * `Retry-After` HTTP header.
   */
  readonly retryAfterSec?: number;
}

interface BucketRow extends RowDataPacket {
  count: number;
  age_seconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a bucket key. Catches misuse early — bucket strings shorter
 * than 1 char or longer than the column width would either be ambiguous
 * or silently truncated by MySQL.
 */
function assertBucket(bucket: string): void {
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new TypeError('rate-limit: bucket must be a non-empty string');
  }
  if (bucket.length > MAX_BUCKET_LENGTH) {
    throw new RangeError(
      `rate-limit: bucket length ${bucket.length} exceeds ${MAX_BUCKET_LENGTH}`,
    );
  }
}

/**
 * Validate window/limit options. Both must be positive integers; zero or
 * negative values would make the limiter behave nonsensically.
 */
function assertOptions(opts: RateLimitOptions): void {
  if (!Number.isInteger(opts.max) || opts.max <= 0) {
    throw new RangeError('rate-limit: `max` must be a positive integer');
  }
  if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds <= 0) {
    throw new RangeError('rate-limit: `windowSeconds` must be a positive integer');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a bucket WITHOUT incrementing it. Returns `allowed: true` when
 * either no row exists, the prior window has elapsed, or the in-window
 * count is below `max`. Otherwise returns `allowed: false` together with
 * a `retryAfterSec` value derived from the row's open window.
 *
 * Implementation notes:
 *   - The single round-trip selects `count` and the row's age in seconds
 *     (via `TIMESTAMPDIFF(SECOND, window_started_at, NOW())`) so we can
 *     decide locally whether the window has rolled over without a second
 *     query and without trusting the application clock.
 *   - The bucket key is a prepared-statement placeholder, satisfying
 *     Req 15.4 / the `local/no-string-concat-sql` lint rule.
 */
export async function checkRateLimit(
  bucket: string,
  opts: RateLimitOptions,
): Promise<RateLimitDecision> {
  assertBucket(bucket);
  assertOptions(opts);

  const rows = await query<BucketRow[]>(
    'SELECT count, TIMESTAMPDIFF(SECOND, window_started_at, NOW()) AS age_seconds FROM rate_limits WHERE bucket = ? LIMIT 1',
    [bucket],
  );

  if (rows.length === 0) {
    return { allowed: true };
  }

  const row = rows[0]!;
  // mysql2 may return age as `number` or `string` depending on driver
  // settings; coerce to be safe. Negative ages can occur if the server
  // clock skews backwards — treat them as "fresh window".
  const age = Number(row.age_seconds);
  const count = Number(row.count);

  if (!Number.isFinite(age) || age >= opts.windowSeconds) {
    // Window has elapsed; the next hit will reset the counter.
    return { allowed: true };
  }

  if (count < opts.max) {
    return { allowed: true };
  }

  // Bucket is full for the current window. Compute how many seconds remain.
  const remaining = Math.max(1, opts.windowSeconds - age);
  return { allowed: false, retryAfterSec: remaining };
}

/**
 * Record a single hit against the bucket. Opens a fresh window when the
 * prior window has elapsed (or no row exists yet).
 *
 * SQL strategy: a single INSERT…ON DUPLICATE KEY UPDATE wraps the create
 * and the increment, atomic on the `bucket` PRIMARY KEY. The
 * `window_started_at` column is conditionally reset based on
 * `TIMESTAMPDIFF(SECOND, window_started_at, NOW()) >= ?` so the window
 * boundary advances exactly when the previous window closed.
 *
 * Returns nothing — failures bubble up as MySQL errors.
 */
export async function recordHit(
  bucket: string,
  opts: Pick<RateLimitOptions, 'windowSeconds'>,
): Promise<void> {
  assertBucket(bucket);
  if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds <= 0) {
    throw new RangeError('rate-limit: `windowSeconds` must be a positive integer');
  }

  await query<ResultSetHeader>(
    'INSERT INTO rate_limits (bucket, count, window_started_at) ' +
      'VALUES (?, 1, NOW()) ' +
      'ON DUPLICATE KEY UPDATE ' +
      'count = IF(TIMESTAMPDIFF(SECOND, window_started_at, NOW()) >= ?, 1, count + 1), ' +
      'window_started_at = IF(TIMESTAMPDIFF(SECOND, window_started_at, NOW()) >= ?, NOW(), window_started_at)',
    [bucket, opts.windowSeconds, opts.windowSeconds],
  );
}
