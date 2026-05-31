/**
 * Unit tests for `src/crons/search-reindex.ts` (task 23.1).
 *
 * Validates: Requirements 1.5 (Design §10.4, §11.2)
 *
 * The cron talks to MySQL via `query()` from `src/infra/db.ts`; we mock
 * the module before importing the cron so the suite stays hermetic — no
 * real database is required and the assertions stay focused on the
 * statement and observability contract:
 *   1. Exactly one `OPTIMIZE TABLE job_postings` and one
 *      `OPTIMIZE TABLE job_posting_translations` statement are issued.
 *   2. The success log carries `start_at` (ISO), numeric `duration_ms`,
 *      `tables_optimized` count, and `status: 'ok'`.
 *   3. Errors propagate so `runWithLock` records `last_status='error'`
 *      (Design §11.1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
}));

// Capture the logger.child output so we can assert on the JSON payloads.
const childLogs: Array<{
  level: 'info' | 'error' | 'debug';
  payload: unknown;
  msg: string;
}> = [];
const childLogger = {
  info: vi.fn((payload: unknown, msg: string) => {
    childLogs.push({ level: 'info', payload, msg });
  }),
  error: vi.fn((payload: unknown, msg: string) => {
    childLogs.push({ level: 'error', payload, msg });
  }),
  debug: vi.fn((payload: unknown, msg: string) => {
    childLogs.push({ level: 'debug', payload, msg });
  }),
};

vi.mock('../../src/infra/logger.js', () => ({
  logger: {
    child: vi.fn(() => childLogger),
  },
}));

// Import after the mocks are registered so the cron picks them up.
const { runSearchReindex } = await import('../../src/crons/search-reindex.js');

beforeEach(() => {
  queryMock.mockReset();
  childLogs.length = 0;
  childLogger.info.mockClear();
  childLogger.error.mockClear();
  childLogger.debug.mockClear();
});

afterEach(() => {
  queryMock.mockReset();
});

describe('runSearchReindex — OPTIMIZE statements', () => {
  it('issues OPTIMIZE TABLE for both job_postings and job_posting_translations', async () => {
    queryMock.mockResolvedValue([{}, []]);

    await runSearchReindex();

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [firstSql] = queryMock.mock.calls[0] as [string];
    const [secondSql] = queryMock.mock.calls[1] as [string];
    // Allow MySQL keyword-case variations but require the exact statements.
    expect(firstSql).toMatch(/^\s*OPTIMIZE\s+TABLE\s+job_postings\s*$/i);
    expect(secondSql).toMatch(
      /^\s*OPTIMIZE\s+TABLE\s+job_posting_translations\s*$/i,
    );
  });
});

describe('runSearchReindex — observability', () => {
  it('emits a success log with start_at, duration_ms, tables_optimized, and status=ok', async () => {
    queryMock.mockResolvedValue([{}, []]);

    await runSearchReindex();

    const completion = childLogs.find(
      (entry) => entry.level === 'info' && entry.msg.includes('completed'),
    );
    expect(completion).toBeDefined();
    const payload = completion?.payload as {
      cron: string;
      start_at: string;
      duration_ms: number;
      tables_optimized: number;
      status: string;
    };
    expect(payload.cron).toBe('search-reindex');
    expect(payload.status).toBe('ok');
    expect(payload.tables_optimized).toBe(2);
    expect(typeof payload.duration_ms).toBe('number');
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    // start_at must be a valid ISO 8601 timestamp.
    expect(typeof payload.start_at).toBe('string');
    expect(Number.isNaN(Date.parse(payload.start_at))).toBe(false);

    // No error log on success.
    expect(childLogs.find((entry) => entry.level === 'error')).toBeUndefined();
  });

  it('logs an error payload and rethrows when OPTIMIZE fails', async () => {
    const boom = new Error('lock wait timeout');
    queryMock.mockRejectedValueOnce(boom);

    await expect(runSearchReindex()).rejects.toThrow('lock wait timeout');

    // Error log surfaces the failure for cron-lock to persist.
    const errorEntry = childLogs.find((entry) => entry.level === 'error');
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.payload).toMatchObject({
      cron: 'search-reindex',
      error: 'lock wait timeout',
      status: 'failed',
    });

    // No success completion log on failure.
    expect(
      childLogs.find(
        (entry) => entry.level === 'info' && entry.msg.includes('completed'),
      ),
    ).toBeUndefined();
  });
});
