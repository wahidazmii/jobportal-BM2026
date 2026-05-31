/**
 * Cron task: `session-gc`.
 *
 * Hourly housekeeping that drops expired auth state from MySQL so the
 * `sessions` and one-time-token tables stay bounded:
 *
 *   1. Sessions whose `expires_at` has passed (12-hour absolute timeout)
 *      OR whose `last_active_at` is older than 30 minutes (idle timeout).
 *      The OR matches Design §8.4's rule and the WHERE clause that
 *      `session-store.ts:read()` uses to hide expired rows from callers,
 *      so anything pruned here is already invisible to the application.
 *   2. Verification tokens past their 24-hour expiry (Phase 2 register →
 *      verify flow). Used tokens are kept (`used_at IS NOT NULL`) until
 *      they expire so audit trails for "token reused" investigations
 *      survive the next sweep, then are removed by the same expiry rule.
 *   3. Password-reset tokens past their 60-minute expiry. Same retention
 *      rationale as verification tokens.
 *
 * Each DELETE runs as its own statement against the shared pool — they
 * are not part of a transaction because a failure on one table should
 * not block the others (they share no FK relationship). Per-statement
 * row counts are emitted as a single structured log line so cPanel cron
 * logs (`~/logs/cron-gc.log`, Design §11.2) show exactly how many rows
 * each sweep removed.
 *
 * Invoked from `src/crons/index.ts` under `runWithLock('session-gc', …)`,
 * which provides the 55 s timeout and lock coordination required by Req
 * 1 AC #5.
 *
 * Validates: Requirements 1.5, 3.5 (Design §8.4, §11.2)
 */

import { logger } from '../infra/logger.js';
import { query, type ResultSetHeader } from '../infra/db.js';

const log = logger.child({ cron: 'session-gc' });

/**
 * Idle/absolute timeout filter for `sessions`. Mirrors the WHERE clause
 * used by `session-store.read()` so the GC only deletes rows that have
 * already become unreachable to authenticated requests. The literal
 * intervals (12 h via `expires_at`, 30 min via `last_active_at`) are
 * encoded by the writers; here we just check the boundaries.
 */
const DELETE_EXPIRED_SESSIONS_SQL =
  'DELETE FROM sessions ' +
  'WHERE expires_at < NOW() ' +
  '   OR last_active_at < NOW() - INTERVAL 30 MINUTE';

/**
 * Verification tokens are single-use and live 24 hours from creation
 * (Req 3 AC #1 / Design §8.1). Once `expires_at` is in the past the
 * verify endpoint will reject the token regardless of `used_at`, so
 * dropping the row is safe and keeps the table small.
 */
const DELETE_EXPIRED_VERIFICATION_TOKENS_SQL =
  'DELETE FROM verification_tokens WHERE expires_at < NOW()';

/**
 * Password-reset tokens live 60 minutes (Req 3 AC #8 / Design §8.2).
 * Same logic as verification tokens — once expired the row serves no
 * functional purpose.
 */
const DELETE_EXPIRED_PASSWORD_RESET_TOKENS_SQL =
  'DELETE FROM password_reset_tokens WHERE expires_at < NOW()';

/**
 * Best-effort wrapper around a single DELETE statement. Returns the
 * number of rows removed, or `null` when the statement itself failed
 * (the caller logs the error and continues with the remaining tables —
 * a transient failure on one sweep should not block the others).
 */
async function deleteRows(sql: string, table: string): Promise<number | null> {
  try {
    const result = await query<ResultSetHeader>(sql);
    return result.affectedRows ?? 0;
  } catch (err) {
    log.error(
      { table, err: err instanceof Error ? err.message : String(err) },
      'session-gc: delete failed',
    );
    return null;
  }
}

/**
 * Run a single garbage-collection sweep. Idempotent — calling it twice
 * back-to-back is harmless because the second invocation finds nothing
 * to delete.
 *
 * Logs per-table affected-row counts at info level via the shared pino
 * logger so the JSON line shows up in cPanel cron logs (Design §11.2).
 */
export async function sessionGc(): Promise<void> {
  const startedAt = Date.now();

  const sessions = await deleteRows(DELETE_EXPIRED_SESSIONS_SQL, 'sessions');
  const verificationTokens = await deleteRows(
    DELETE_EXPIRED_VERIFICATION_TOKENS_SQL,
    'verification_tokens',
  );
  const passwordResetTokens = await deleteRows(
    DELETE_EXPIRED_PASSWORD_RESET_TOKENS_SQL,
    'password_reset_tokens',
  );

  log.info(
    {
      duration_ms: Date.now() - startedAt,
      deleted: {
        sessions,
        verification_tokens: verificationTokens,
        password_reset_tokens: passwordResetTokens,
      },
    },
    'session-gc: completed',
  );
}
