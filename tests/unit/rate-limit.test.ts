/**
 * Unit tests for `src/infra/rate-limit.ts` (task 9.2).
 *
 * Validates: Requirements 14.2, 14.5 (Design §6 Auth)
 *
 * The limiter talks to MySQL through the `query()` helper from
 * `src/infra/db.ts`. We mock that single seam so the suite stays
 * hermetic — the goal is to nail down the contract between the
 * limiter and the SQL it issues:
 *
 *   - `checkRateLimit` returns `allowed=true` when no row exists,
 *     when the prior window has elapsed, or when the count is below
 *     the cap.
 *   - `checkRateLimit` returns `allowed=false` with a positive
 *     `retryAfterSec` once the cap is reached within the window.
 *   - `recordHit` issues the canonical INSERT … ON DUPLICATE KEY
 *     UPDATE statement that resets the window when it has elapsed
 *     and otherwise increments the counter.
 *   - Bucket validation rejects empty strings and over-long keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
  withTransaction: vi.fn(),
}));

const {
  MAX_BUCKET_LENGTH,
  REGISTER_BUCKET_PREFIX,
  REGISTER_LIMIT,
  REGISTER_WINDOW_SECONDS,
  checkRateLimit,
  recordHit,
} = await import('../../src/infra/rate-limit.js');

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  queryMock.mockReset();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('registration constants (Req 14.2)', () => {
  it('keeps 5 successful registrations / IP / hour as the documented cap', () => {
    expect(REGISTER_LIMIT).toBe(5);
    expect(REGISTER_WINDOW_SECONDS).toBe(60 * 60);
    expect(REGISTER_BUCKET_PREFIX).toBe('register:ip:');
    expect(MAX_BUCKET_LENGTH).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe('checkRateLimit', () => {
  const opts = { max: 5, windowSeconds: 60 * 60 };

  it('returns { allowed: true } when no row exists for the bucket', async () => {
    queryMock.mockResolvedValueOnce([]);
    const result = await checkRateLimit('register:ip:1.2.3.4', opts);
    expect(result).toEqual({ allowed: true });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT count, TIMESTAMPDIFF\(SECOND, window_started_at, NOW\(\)\) AS age_seconds FROM rate_limits/i);
    expect(params).toEqual(['register:ip:1.2.3.4']);
  });

  it('returns { allowed: true } when the previous window has elapsed (treats row as fresh)', async () => {
    queryMock.mockResolvedValueOnce([
      { count: 99, age_seconds: 60 * 60 + 1 },
    ]);
    const result = await checkRateLimit('bucket', opts);
    expect(result).toEqual({ allowed: true });
  });

  it('returns { allowed: true } when the count is under the cap', async () => {
    queryMock.mockResolvedValueOnce([{ count: 4, age_seconds: 30 }]);
    const result = await checkRateLimit('bucket', opts);
    expect(result).toEqual({ allowed: true });
  });

  it('returns { allowed: false, retryAfterSec } when the cap is reached', async () => {
    queryMock.mockResolvedValueOnce([{ count: 5, age_seconds: 600 }]);
    const result = await checkRateLimit('bucket', opts);
    expect(result.allowed).toBe(false);
    // window 3600s, age 600s → ~3000s remaining.
    expect(result.retryAfterSec).toBe(3000);
  });

  it('coerces string-encoded count/age values from mysql2 driver settings', async () => {
    queryMock.mockResolvedValueOnce([
      { count: '5' as unknown as number, age_seconds: '120' as unknown as number },
    ]);
    const result = await checkRateLimit('bucket', opts);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBe(60 * 60 - 120);
  });

  it('rejects empty bucket strings and oversized bucket strings', async () => {
    await expect(checkRateLimit('', opts)).rejects.toThrow(TypeError);
    await expect(checkRateLimit('a'.repeat(65), opts)).rejects.toThrow(RangeError);
  });

  it('rejects non-positive `max` and `windowSeconds`', async () => {
    await expect(checkRateLimit('b', { max: 0, windowSeconds: 60 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      checkRateLimit('b', { max: 5, windowSeconds: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// recordHit
// ---------------------------------------------------------------------------

describe('recordHit', () => {
  it('issues a single INSERT … ON DUPLICATE KEY UPDATE with the bucket and window', async () => {
    queryMock.mockResolvedValueOnce({ affectedRows: 1, insertId: 0 });

    await recordHit('register:ip:9.9.9.9', { windowSeconds: 60 * 60 });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO rate_limits \(bucket, count, window_started_at\)/i);
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
    expect(sql).toMatch(/TIMESTAMPDIFF\(SECOND, window_started_at, NOW\(\)\) >= \?/i);
    expect(params).toEqual(['register:ip:9.9.9.9', 3600, 3600]);
  });

  it('rejects empty / oversized bucket strings before issuing SQL', async () => {
    await expect(recordHit('', { windowSeconds: 60 })).rejects.toThrow(TypeError);
    await expect(
      recordHit('a'.repeat(65), { windowSeconds: 60 }),
    ).rejects.toThrow(RangeError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive windowSeconds', async () => {
    await expect(recordHit('b', { windowSeconds: 0 })).rejects.toThrow(RangeError);
    await expect(recordHit('b', { windowSeconds: -1 })).rejects.toThrow(RangeError);
  });
});
