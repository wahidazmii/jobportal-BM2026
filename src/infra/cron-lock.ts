/**
 * Cron job lock with heartbeat for PT Buana Megah Job Portal.
 *
 * Provides `runWithLock(name, fn)` so multiple cPanel cron processes that
 * happen to launch the same script concurrently (typical when an earlier
 * run overruns its scheduled window) cooperate via the shared `cron_locks`
 * table. A lock whose `heartbeat_at` is older than 90 seconds is treated
 * as stale and may be taken over by a fresh process — this prevents a
 * crashed run from blocking the schedule indefinitely.
 *
 * Lifecycle of `runWithLock(name, fn)`:
 *   1. Try to acquire by INSERT..ON DUPLICATE KEY UPDATE with stale
 *      detection.
 *   2. If another process owns a fresh lock → return null and log skip.
 *   3. Otherwise start a 10-second heartbeat that touches `heartbeat_at`.
 *   4. Race `fn()` against a 55-second timeout (Req 1 AC #5).
 *   5. On success/failure/timeout: clear the heartbeat, persist
 *      `last_run_at`/`last_status`/`last_error`, and release the lock by
 *      setting `locked_at = NULL`.
 *
 * Every cleanup statement filters by both `name` and the captured
 * `locked_at` signature, so if a stale takeover happens mid-run our
 * release does not clobber the new owner's lock (Design §11.1).
 *
 * Validates: Requirements 1.5, 20.4 (Design §11.1)
 */

import type { ResultSetHeader, RowDataPacket } from './db.js';
import { query } from './db.js';
import { logger } from './logger.js';

/**
 * Tunable parameters for a single `runWithLock` invocation. Defaults
 * match Design §11.1: 55s task timeout, 10s heartbeat, 90s stale threshold.
 */
export interface LockOptions {
  /** Maximum wall-time for `fn()` before it is aborted. Default 55_000ms. */
  timeoutMs?: number;
  /** Interval between heartbeat updates. Default 10_000ms. */
  heartbeatIntervalMs?: number;
  /** Threshold after which a missed heartbeat marks the lock stale. Default 90_000ms. */
  staleAfterMs?: number;
}

const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STALE_MS = 90_000;

/** `cron_locks.last_error` is `VARCHAR(500)` per Design §7.2. */
const LAST_ERROR_MAX_LEN = 500;

/** Row shape returned by SELECT on `cron_locks`. */
interface LockRow extends RowDataPacket {
  locked_at: Date | null;
  heartbeat_at: Date | null;
}

/**
 * Acquisition statement. Stale detection covers both NULL heartbeat
 * (clean release) and old heartbeat (crashed run). The IF expressions
 * intentionally evaluate identical predicates so MySQL reports
 * `affectedRows = 0` (existing values kept) when the lock is held fresh
 * by someone else.
 */
const ACQUIRE_SQL = `
  INSERT INTO cron_locks (name, locked_at, heartbeat_at)
  VALUES (?, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    locked_at = IF(heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL ? SECOND, NOW(), locked_at),
    heartbeat_at = IF(heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL ? SECOND, NOW(), heartbeat_at)
`;

const SELECT_LOCK_SQL = `SELECT locked_at, heartbeat_at FROM cron_locks WHERE name = ?`;

const HEARTBEAT_SQL = `UPDATE cron_locks SET heartbeat_at = NOW() WHERE name = ? AND locked_at = ?`;

const RELEASE_OK_SQL = `
  UPDATE cron_locks
  SET locked_at = NULL,
      heartbeat_at = NULL,
      last_run_at = NOW(),
      last_status = 'ok',
      last_error = NULL
  WHERE name = ? AND locked_at = ?
`;

const RELEASE_ERR_SQL = `
  UPDATE cron_locks
  SET locked_at = NULL,
      heartbeat_at = NULL,
      last_run_at = NOW(),
      last_status = 'error',
      last_error = ?
  WHERE name = ? AND locked_at = ?
`;

const FORCE_RELEASE_SQL = `UPDATE cron_locks SET locked_at = NULL, heartbeat_at = NULL WHERE name = ?`;

/**
 * Try to acquire `name`. On success returns the captured `locked_at` —
 * this acts as the lock's ownership signature for subsequent heartbeat
 * and release statements. Returns `null` when the lock is held fresh by
 * another process.
 *
 * mysql2 `affectedRows` semantics for `INSERT ... ON DUPLICATE KEY UPDATE`:
 *   1 = new row inserted          → we acquired
 *   2 = existing row updated      → stale takeover, we acquired
 *   0 = existing values preserved → held by another fresh process
 */
async function tryAcquire(name: string, staleAfterMs: number): Promise<Date | null> {
  const staleSeconds = Math.max(1, Math.floor(staleAfterMs / 1000));
  const result = await query<ResultSetHeader>(ACQUIRE_SQL, [
    name,
    staleSeconds,
    staleSeconds,
  ]);

  if (result.affectedRows === 0) {
    return null;
  }

  const rows = await query<LockRow[]>(SELECT_LOCK_SQL, [name]);
  const row = rows[0];
  if (!row || !row.locked_at) {
    return null;
  }
  return row.locked_at;
}

/** Truncate to fit `cron_locks.last_error` (`VARCHAR(500)`). */
function truncateError(message: string): string {
  return message.length > LAST_ERROR_MAX_LEN
    ? message.slice(0, LAST_ERROR_MAX_LEN)
    : message;
}

/** Best-effort `last_error` + lock release for a failed run. */
async function recordFailureAndRelease(
  name: string,
  lockedAt: Date,
  message: string,
): Promise<void> {
  try {
    await query<ResultSetHeader>(RELEASE_ERR_SQL, [
      truncateError(message),
      name,
      lockedAt,
    ]);
  } catch (releaseErr) {
    logger.error(
      {
        cron: name,
        err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      },
      'failed to record cron error and release lock',
    );
  }
}

/** Best-effort `last_status='ok'` lock release for a successful run. */
async function recordSuccessAndRelease(name: string, lockedAt: Date): Promise<void> {
  try {
    await query<ResultSetHeader>(RELEASE_OK_SQL, [name, lockedAt]);
  } catch (releaseErr) {
    logger.error(
      {
        cron: name,
        err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      },
      'failed to release cron lock after success',
    );
  }
}

/**
 * Run `fn` exclusively across all callers sharing the same `name`.
 *
 * Returns the function's resolved value on success, `null` if the lock is
 * already held fresh by another process, and rejects (after attempting to
 * release the lock and persist `last_status='error'`) if `fn` throws or
 * the timeout fires.
 */
export async function runWithLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;

  const lockedAt = await tryAcquire(name, staleAfterMs);
  if (!lockedAt) {
    logger.info({ cron: name }, 'lock not acquired');
    return null;
  }

  logger.info(
    { cron: name, locked_at: lockedAt.toISOString(), timeout_ms: timeoutMs },
    'cron lock acquired',
  );

  // Heartbeat: keep `heartbeat_at` fresh so other processes know we're alive.
  const heartbeat = setInterval(() => {
    void query<ResultSetHeader>(HEARTBEAT_SQL, [name, lockedAt]).catch(
      (err: unknown) => {
        logger.warn(
          { cron: name, err: err instanceof Error ? err.message : String(err) },
          'cron heartbeat failed',
        );
      },
    );
  }, heartbeatIntervalMs);
  if (typeof heartbeat.unref === 'function') {
    heartbeat.unref();
  }

  // Timeout race: 55s budget per Req 1 AC #5.
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`cron task '${name}' exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }
  });

  // Start `fn` and silence any late rejection that arrives after the
  // timeout already lost the race; the original error has already been
  // observed by `Promise.race`.
  const fnPromise = fn();
  fnPromise.catch(() => {
    /* swallow late rejection — primary observer is Promise.race below */
  });

  let result: T;
  try {
    result = await Promise.race<T>([fnPromise, timeoutPromise]);
  } catch (err) {
    clearInterval(heartbeat);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : String(err);
    await recordFailureAndRelease(name, lockedAt, message);
    logger.error({ cron: name, err: message }, 'cron task failed');
    throw err;
  }

  clearInterval(heartbeat);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  await recordSuccessAndRelease(name, lockedAt);
  logger.info({ cron: name }, 'cron task completed');
  return result;
}

/**
 * Force-release a cron lock by name. Intended for SIGTERM/SIGINT shutdown
 * handlers when a long-running task is interrupted before `runWithLock`
 * can clean up. Best-effort: errors are logged, never thrown — the caller
 * is already winding down.
 */
export async function releaseLock(name: string): Promise<void> {
  try {
    await query<ResultSetHeader>(FORCE_RELEASE_SQL, [name]);
    logger.info({ cron: name }, 'cron lock force-released');
  } catch (err) {
    logger.warn(
      { cron: name, err: err instanceof Error ? err.message : String(err) },
      'failed to force-release cron lock',
    );
  }
}
