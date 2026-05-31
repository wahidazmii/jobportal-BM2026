/**
 * Unit tests for `src/crons/alert-digest.ts` (task 34.1).
 *
 * Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6 (Design §11.3)
 *
 * The evaluator talks to MySQL via `src/infra/db.ts` (`query`,
 * `withTransaction`) — through the REAL `src/modules/alerts/digest-repo.ts`
 * — and to the SMTP outbox via `enqueue()` from
 * `src/modules/mail/service.ts`. We mock `db` + `enqueue` + `logger` so
 * the suite is hermetic (no real database, no live SMTP) while still
 * exercising the repo's real SQL assembly. Assertions focus on the Req
 * 7.5/7.6 timestamp-advance contract:
 *   1. ≥1 matching job  → enqueue called once, last_evaluated_at advanced
 *      inside the SAME transaction connection as the enqueue.
 *   2. 0 matching jobs  → NO enqueue, last_evaluated_at still advanced via
 *      a plain pool UPDATE (a clean evaluation — Req 7.4 + 7.5).
 *   3. Enqueue throws    → the transaction rolls back so last_evaluated_at
 *      is NOT advanced (Req 7.6); the per-alert error is logged and the
 *      batch continues.
 *   4. Daily vs Weekly thresholds present in the due-selection SQL.
 *   5. Empty due set     → no enqueue, summary still logged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

const queryMock = vi.fn();
const withTransactionMock = vi.fn();
const enqueueMock = vi.fn();

/**
 * The MARK_EVALUATED UPDATE inside a transaction runs on the connection
 * handed to `withTransaction`'s callback. We give that fake connection an
 * `execute` so `markEvaluated(id, conn)` resolves, and we record its calls
 * so a test can assert the timestamp advance was bound to the enqueue.
 */
const connExecuteMock = vi.fn();
const FAKE_CONN = { execute: connExecuteMock } as const;

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: enqueueMock,
}));

// Capture logger.child output so we can assert on the JSON payloads.
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
  logger: { child: vi.fn(() => childLogger) },
}));

// Import AFTER the mocks are registered. The cron + the real digest-repo
// pick up the mocked `db`, `enqueue`, and `logger`.
const { alertDigest } = await import('../../src/crons/alert-digest.js');

/** Build a fake `ResultSetHeader` with a chosen affectedRows. */
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

/** Build a DB-shaped `job_alerts` (joined) row with sensible defaults. */
function makeAlertRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 1,
    applicant_user_id: 100,
    keyword: 'engineer',
    locations: null,
    departments: null,
    frequency: 'Daily',
    last_evaluated_at: new Date('2024-01-01T00:00:00Z'),
    applicant_email: 'applicant@example.com',
    applicant_name: 'Applicant',
    language_pref: 'id',
    ...overrides,
  };
}

/** Build a DB-shaped matching `job_postings` row. */
function makeJobRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 10,
    slug: 'senior-engineer',
    title: 'Senior Engineer',
    location: 'Jakarta',
    department_id: 3,
    published_at: new Date('2024-02-01T00:00:00Z'),
    ...overrides,
  };
}

/** Find the `alert_digest_done` summary payload. */
function findSummary(): Record<string, unknown> | undefined {
  const entry = childLogs.find(
    (e) =>
      e.level === 'info' &&
      (e.payload as { event?: string }).event === 'alert_digest_done',
  );
  return entry?.payload as Record<string, unknown> | undefined;
}

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
  enqueueMock.mockReset();
  connExecuteMock.mockReset();
  childLogs.length = 0;
  childLogger.info.mockClear();
  childLogger.error.mockClear();
  childLogger.debug.mockClear();

  // Default: withTransaction mirrors the real helper — run fn(conn), and
  // if the callback throws, let the error propagate (the real helper
  // rolls back then re-throws).
  withTransactionMock.mockImplementation(
    async (fn: (conn: unknown) => Promise<unknown>) => fn(FAKE_CONN),
  );
  // Default: enqueue succeeds; the in-transaction MARK_EVALUATED touches 1 row.
  enqueueMock.mockResolvedValue(undefined);
  connExecuteMock.mockResolvedValue([makeHeader(1), []]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('alertDigest — ≥1 matching job (Req 7.3, 7.5)', () => {
  it('enqueues one digest and advances last_evaluated_at in the same transaction', async () => {
    queryMock
      .mockResolvedValueOnce([makeAlertRow()]) // listDueForDigest
      .mockResolvedValueOnce([
        makeJobRow({ id: 10 }),
        makeJobRow({ id: 11, slug: 'staff-engineer', title: 'Staff Engineer' }),
      ]); // findMatchingJobs

    await alertDigest();

    // findMatchingJobs SELECT carries the alert's previous timestamp (Req 7.2).
    const [matchSql, matchParams] = queryMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(matchSql).toMatch(/FROM\s+job_postings/i);
    expect(matchSql).toMatch(/j\.published_at\s*>\s*\?/i);
    expect(matchSql).toMatch(/status\s*=\s*'Published'/i);
    // params = [locale, since, ...]; since is the alert's lastEvaluatedAt.
    expect(matchParams[0]).toBe('id');
    expect(matchParams[1]).toEqual(new Date('2024-01-01T00:00:00Z'));

    // Exactly one digest enqueued for the alert (Req 7.3), on the txn conn.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [connArg, opts] = enqueueMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(connArg).toBe(FAKE_CONN);
    expect(opts.templateKey).toBe('alert_digest');
    expect(opts.toEmail).toBe('applicant@example.com');
    expect(opts.locale).toBe('id');
    expect(opts.targetId).toBeNull();
    const context = opts.context as { jobs: unknown[]; count: number };
    expect(context.count).toBe(2);
    expect(context.jobs).toHaveLength(2);

    // Timestamp advanced INSIDE the transaction (MARK_EVALUATED on the conn).
    expect(connExecuteMock).toHaveBeenCalledTimes(1);
    const [markSql, markParams] = connExecuteMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(markSql).toMatch(/UPDATE\s+job_alerts/i);
    expect(markSql).toMatch(/last_evaluated_at\s*=\s*NOW\(\)/i);
    expect(markParams).toEqual([1]);

    const summary = findSummary();
    expect(summary).toMatchObject({
      evaluated: 1,
      emailed: 1,
      skipped_no_match: 0,
      failed: 0,
    });
  });

  it('uses the epoch floor for a never-evaluated alert (Req 7.2)', async () => {
    queryMock
      .mockResolvedValueOnce([makeAlertRow({ last_evaluated_at: null })])
      .mockResolvedValueOnce([makeJobRow()]);

    await alertDigest();

    const [, matchParams] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(matchParams[1]).toEqual(new Date(0));
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});

describe('alertDigest — 0 matching jobs (Req 7.4, 7.5)', () => {
  it('does NOT enqueue but still advances last_evaluated_at via a pool UPDATE', async () => {
    queryMock
      .mockResolvedValueOnce([makeAlertRow()]) // listDueForDigest
      .mockResolvedValueOnce([]) // findMatchingJobs → no matches
      .mockResolvedValueOnce(makeHeader(1)); // markEvaluated (pool UPDATE)

    await alertDigest();

    // Req 7.4: no email; no transaction needed for the clean zero-match path.
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();

    // Req 7.5: clean evaluation still advances the timestamp via `query`
    // (no transaction connection).
    const markCall = queryMock.mock.calls[2] as [string, unknown[]];
    expect(markCall[0]).toMatch(/UPDATE\s+job_alerts/i);
    expect(markCall[0]).toMatch(/last_evaluated_at\s*=\s*NOW\(\)/i);
    expect(markCall[1]).toEqual([1]);

    const summary = findSummary();
    expect(summary).toMatchObject({
      evaluated: 1,
      emailed: 0,
      skipped_no_match: 1,
      failed: 0,
    });
  });
});

describe('alertDigest — enqueue error (Req 7.6)', () => {
  it('retains the old timestamp, logs the error, and continues the batch', async () => {
    queryMock
      .mockResolvedValueOnce([
        makeAlertRow({ id: 1 }),
        makeAlertRow({ id: 2, applicant_email: 'second@example.com' }),
      ]) // listDueForDigest (2 alerts)
      .mockResolvedValueOnce([makeJobRow()]) // alert 1 matches
      .mockResolvedValueOnce([makeJobRow({ id: 20 })]); // alert 2 matches

    // enqueue throws for alert 1 (SMTP/DB error), succeeds for alert 2. The
    // throw aborts the transaction callback BEFORE markEvaluated runs, so
    // alert 1's timestamp is never advanced (Req 7.6).
    enqueueMock
      .mockRejectedValueOnce(new Error('SMTP relay down')) // alert 1
      .mockResolvedValueOnce(undefined); // alert 2

    await alertDigest();

    // Both alerts attempted an enqueue.
    expect(enqueueMock).toHaveBeenCalledTimes(2);

    // Only alert 2 advanced its timestamp (alert 1's txn body threw first).
    expect(connExecuteMock).toHaveBeenCalledTimes(1);
    const [, markParams] = connExecuteMock.mock.calls[0] as [string, unknown[]];
    expect(markParams).toEqual([2]);

    // Per-alert error logged for alert 1 (Req 7.6 "log for later retry").
    const errLog = childLogs.find(
      (e) =>
        e.level === 'error' &&
        (e.payload as { event?: string }).event === 'alert_digest_error',
    );
    expect(errLog).toBeDefined();
    expect(errLog?.payload).toMatchObject({
      event: 'alert_digest_error',
      alert_id: 1,
      error: 'SMTP relay down',
    });

    // Batch continued: one emailed, one failed.
    const summary = findSummary();
    expect(summary).toMatchObject({
      evaluated: 2,
      emailed: 1,
      skipped_no_match: 0,
      failed: 1,
    });
  });
});

describe('alertDigest — due-selection query shape (Req 7.2, Design §11.3)', () => {
  it('honors the Daily and Weekly thresholds and the 500-row cap', async () => {
    // Drive a single empty run so listDueForDigest's real SQL is captured.
    queryMock.mockResolvedValueOnce([]);

    await alertDigest();

    const [dueSql] = queryMock.mock.calls[0] as [string];
    expect(dueSql).toMatch(/FROM\s+job_alerts/i);
    expect(dueSql).toMatch(/last_evaluated_at\s+IS\s+NULL/i);
    expect(dueSql).toMatch(
      /frequency\s*=\s*'Daily'\s+AND\s+ja\.last_evaluated_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s+1\s+DAY/i,
    );
    expect(dueSql).toMatch(
      /frequency\s*=\s*'Weekly'\s+AND\s+ja\.last_evaluated_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s+7\s+DAY/i,
    );
    expect(dueSql).toMatch(/ORDER\s+BY\s+ja\.id/i);
    expect(dueSql).toMatch(/LIMIT\s+500/i);
  });
});

describe('alertDigest — empty due set (Req 7.5)', () => {
  it('performs no enqueue and still logs a summary', async () => {
    queryMock.mockResolvedValueOnce([]); // listDueForDigest → nothing due

    await alertDigest();

    expect(queryMock).toHaveBeenCalledTimes(1); // only the due-batch SELECT
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();

    const summary = findSummary();
    expect(summary).toMatchObject({
      evaluated: 0,
      emailed: 0,
      skipped_no_match: 0,
      failed: 0,
    });
    expect(typeof summary?.duration_ms).toBe('number');
  });
});
