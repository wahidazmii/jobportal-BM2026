/**
 * Unit tests for `src/crons/session-gc.ts` (task 13.1).
 *
 * Validates: Requirements 1.5, 3.5 (Design §8.4, §11.2)
 *
 * The GC talks to MySQL via `query()` from `src/infra/db.ts`; we mock
 * that module before importing the cron so the suite stays hermetic.
 * The tests assert two things in tandem:
 *   1. The exact SQL handed to `query()` — the `INTERVAL 30 MINUTE` idle
 *      filter, the `expires_at < NOW()` absolute filter, and the two
 *      housekeeping tables (`verification_tokens`, `password_reset_tokens`)
 *      are part of the design contract.
 *   2. Per-table affectedRows counts surface in the structured log line so
 *      operators can read them in cPanel cron logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  pool: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

// Capture the logger.child output so we can assert on the JSON payload.
const childLogs: Array<{ level: 'info' | 'error'; payload: unknown; msg: string }> = [];
const childLogger = {
  info: vi.fn((payload: unknown, msg: string) => {
    childLogs.push({ level: 'info', payload, msg });
  }),
  error: vi.fn((payload: unknown, msg: string) => {
    childLogs.push({ level: 'error', payload, msg });
  }),
};

vi.mock('../../src/infra/logger.js', () => ({
  logger: {
    child: vi.fn(() => childLogger),
  },
}));

// Import after the mocks are registered.
const { sessionGc } = await import('../../src/crons/session-gc.js');

/** Helper: build a fake `ResultSetHeader` with a chosen affectedRows. */
function makeHeader(affectedRows: number): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId: 0,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

beforeEach(() => {
  queryMock.mockReset();
  childLogs.length = 0;
  childLogger.info.mockClear();
  childLogger.error.mockClear();
});

afterEach(() => {
  queryMock.mockReset();
});

describe('sessionGc — DELETE statements', () => {
  it('deletes expired sessions using the absolute OR idle filter', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(2)) // sessions
      .mockResolvedValueOnce(makeHeader(0)) // verification_tokens
      .mockResolvedValueOnce(makeHeader(0)); // password_reset_tokens

    await sessionGc();

    expect(queryMock).toHaveBeenCalledTimes(3);
    const [sessionsSql] = queryMock.mock.calls[0] as [string];
    expect(sessionsSql).toMatch(/^\s*DELETE FROM sessions/i);
    expect(sessionsSql).toMatch(/expires_at\s*<\s*NOW\(\)/i);
    expect(sessionsSql).toMatch(
      /last_active_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s+30\s+MINUTE/i,
    );
    // The OR is the design contract — either timeout boundary qualifies.
    expect(sessionsSql).toMatch(/\bOR\b/i);
  });

  it('deletes expired verification_tokens', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(0))
      .mockResolvedValueOnce(makeHeader(5))
      .mockResolvedValueOnce(makeHeader(0));

    await sessionGc();

    const [verSql] = queryMock.mock.calls[1] as [string];
    expect(verSql).toMatch(/DELETE FROM verification_tokens/i);
    expect(verSql).toMatch(/expires_at\s*<\s*NOW\(\)/i);
  });

  it('deletes expired password_reset_tokens', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(0))
      .mockResolvedValueOnce(makeHeader(0))
      .mockResolvedValueOnce(makeHeader(3));

    await sessionGc();

    const [prSql] = queryMock.mock.calls[2] as [string];
    expect(prSql).toMatch(/DELETE FROM password_reset_tokens/i);
    expect(prSql).toMatch(/expires_at\s*<\s*NOW\(\)/i);
  });
});

describe('sessionGc — observability', () => {
  it('emits a single structured log line with per-table row counts', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(7))
      .mockResolvedValueOnce(makeHeader(2))
      .mockResolvedValueOnce(makeHeader(1));

    await sessionGc();

    const completion = childLogs.find((entry) => entry.msg.includes('completed'));
    expect(completion).toBeDefined();
    expect(completion?.level).toBe('info');
    const payload = completion?.payload as {
      duration_ms: number;
      deleted: {
        sessions: number | null;
        verification_tokens: number | null;
        password_reset_tokens: number | null;
      };
    };
    expect(payload.deleted).toEqual({
      sessions: 7,
      verification_tokens: 2,
      password_reset_tokens: 1,
    });
    expect(typeof payload.duration_ms).toBe('number');
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('continues sweeping the remaining tables when one DELETE fails', async () => {
    const boom = new Error('lost connection');
    queryMock
      .mockRejectedValueOnce(boom) // sessions: fails
      .mockResolvedValueOnce(makeHeader(4)) // verification_tokens: ok
      .mockResolvedValueOnce(makeHeader(2)); // password_reset_tokens: ok

    await sessionGc();

    // All three statements still attempted.
    expect(queryMock).toHaveBeenCalledTimes(3);

    // Per-table error log surfaced for the failing table.
    const errorEntry = childLogs.find((entry) => entry.level === 'error');
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.payload).toMatchObject({
      table: 'sessions',
      err: 'lost connection',
    });

    // Completion log marks the failed table as null but keeps real counts
    // for the survivors.
    const completion = childLogs.find((entry) => entry.msg.includes('completed'));
    expect(completion?.payload).toMatchObject({
      deleted: {
        sessions: null,
        verification_tokens: 4,
        password_reset_tokens: 2,
      },
    });
  });
});
