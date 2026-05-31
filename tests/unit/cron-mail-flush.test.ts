/**
 * Unit tests for `src/crons/mail-flush.ts` (task 37.1).
 *
 * Validates: Requirements 8.4, 8.5 (Design §11.3, §12.1, §12.2)
 *
 * The flusher talks to MySQL via `query()` from `src/infra/db.ts` and to
 * the SMTP relay via `sendMail()` from `src/modules/mail/sender.ts`; we
 * mock both before importing the cron so the suite stays hermetic — no
 * real database and no live SMTP server. The assertions focus on the
 * state-machine + backoff contract:
 *   1. A pending row is claimed (UPDATE→sending, affectedRows check),
 *      sent via SMTP, then marked 'sent' with sent_at=NOW().
 *   2. A transient SMTP error on retry_count 0 re-queues the row to
 *      'pending' with retry_count=1, next_attempt_at = NOW()+60s, and
 *      last_error set.
 *   3. The 5th failure marks the row 'failed' and logs a Super_Admin
 *      alert.
 *   4. A claim race (UPDATE→sending affectedRows=0) skips the row with no
 *      send attempted.
 *   5. A per-row failure does not abort the batch — the next row still
 *      processes.
 *   6. An empty batch performs no sends and still logs a summary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

const queryMock = vi.fn();
const sendMailMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  pool: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/modules/mail/sender.js', () => ({
  sendMail: sendMailMock,
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
const { mailFlush } = await import('../../src/crons/mail-flush.js');

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

/** Build a fake outbox row with sensible defaults. */
function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<
  string,
  unknown
> {
  return {
    id: 1,
    to_email: 'applicant@example.com',
    to_name: 'Applicant',
    subject: 'Your application',
    body_html: '<p>Hello</p>',
    body_text: 'Hello',
    retry_count: 0,
    ...overrides,
  };
}

/** Find the `mail_flush_done` summary payload. */
function findSummary(): Record<string, unknown> | undefined {
  const entry = childLogs.find(
    (e) =>
      e.level === 'info' &&
      (e.payload as { event?: string }).event === 'mail_flush_done',
  );
  return entry?.payload as Record<string, unknown> | undefined;
}

beforeEach(() => {
  queryMock.mockReset();
  sendMailMock.mockReset();
  childLogs.length = 0;
  childLogger.info.mockClear();
  childLogger.error.mockClear();
  childLogger.debug.mockClear();
});

afterEach(() => {
  queryMock.mockReset();
  sendMailMock.mockReset();
});

describe('mailFlush — happy path (pending → sending → sent)', () => {
  it('claims a pending row, sends it, and marks it sent with sent_at', async () => {
    queryMock
      .mockResolvedValueOnce([makeRow()]) // SELECT batch
      .mockResolvedValueOnce(makeHeader(1)) // CLAIM → sending (won)
      .mockResolvedValueOnce(makeHeader(1)); // MARK sent
    sendMailMock.mockResolvedValueOnce(undefined);

    await mailFlush();

    // SELECT scans the pending, due batch in FIFO order with a LIMIT.
    const [selectSql] = queryMock.mock.calls[0] as [string];
    expect(selectSql).toMatch(/SELECT/i);
    expect(selectSql).toMatch(/FROM\s+mail_outbox/i);
    expect(selectSql).toMatch(/status\s*=\s*'pending'/i);
    expect(selectSql).toMatch(/next_attempt_at\s*<=\s*NOW\(\)/i);
    expect(selectSql).toMatch(/ORDER\s+BY\s+id/i);
    expect(selectSql).toMatch(/LIMIT\s+200/i);

    // CLAIM flips pending → sending guarded by the optimistic status clause.
    const [claimSql, claimParams] = queryMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(claimSql).toMatch(/UPDATE\s+mail_outbox/i);
    expect(claimSql).toMatch(/status\s*=\s*'sending'/i);
    expect(claimSql).toMatch(/WHERE\s+id\s*=\s*\?\s+AND\s+status\s*=\s*'pending'/i);
    expect(claimParams).toEqual([1]);

    // SMTP send invoked with the row's content.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith({
      toEmail: 'applicant@example.com',
      toName: 'Applicant',
      subject: 'Your application',
      bodyHtml: '<p>Hello</p>',
      bodyText: 'Hello',
    });

    // MARK sent → sets sent_at=NOW().
    const [sentSql, sentParams] = queryMock.mock.calls[2] as [string, unknown[]];
    expect(sentSql).toMatch(/status\s*=\s*'sent'/i);
    expect(sentSql).toMatch(/sent_at\s*=\s*NOW\(\)/i);
    expect(sentParams).toEqual([1]);

    const summary = findSummary();
    expect(summary).toMatchObject({ selected: 1, sent: 1, retried: 0, failed: 0 });
  });
});

describe('mailFlush — transient failure (sending → pending, backoff)', () => {
  it('re-queues with retry_count=1 and a 60s backoff on the first failure', async () => {
    queryMock
      .mockResolvedValueOnce([makeRow({ retry_count: 0 })]) // SELECT
      .mockResolvedValueOnce(makeHeader(1)) // CLAIM (won)
      .mockResolvedValueOnce(makeHeader(1)); // RETRY update
    sendMailMock.mockRejectedValueOnce(new Error('SMTP 421 try later'));

    await mailFlush();

    // The third call is the retry UPDATE (sending → pending).
    const [retrySql, retryParams] = queryMock.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(retrySql).toMatch(/status\s*=\s*'pending'/i);
    expect(retrySql).toMatch(/retry_count\s*=\s*\?/i);
    expect(retrySql).toMatch(/next_attempt_at\s*=\s*NOW\(\)\s*\+\s*INTERVAL\s+\?\s+SECOND/i);
    expect(retrySql).toMatch(/last_error\s*=\s*\?/i);

    // Params: [newRetryCount, backoffSeconds, lastError, id]
    expect(retryParams[0]).toBe(1); // retry_count incremented to 1
    expect(retryParams[1]).toBe(60); // 1m backoff for the first failure
    expect(retryParams[2]).toBe('SMTP 421 try later'); // last_error
    expect(retryParams[3]).toBe(1); // id

    const summary = findSummary();
    expect(summary).toMatchObject({ sent: 0, retried: 1, failed: 0 });
  });

  it('uses the 5-minute backoff for the second failure (retry_count 1 → 2)', async () => {
    queryMock
      .mockResolvedValueOnce([makeRow({ retry_count: 1 })])
      .mockResolvedValueOnce(makeHeader(1))
      .mockResolvedValueOnce(makeHeader(1));
    sendMailMock.mockRejectedValueOnce(new Error('greylisted'));

    await mailFlush();

    const [, retryParams] = queryMock.mock.calls[2] as [string, unknown[]];
    expect(retryParams[0]).toBe(2); // retry_count
    expect(retryParams[1]).toBe(300); // 5m backoff
  });
});

describe('mailFlush — terminal failure (sending → failed, 5th attempt)', () => {
  it('marks the row failed and logs a Super_Admin alert on the 5th failure', async () => {
    queryMock
      .mockResolvedValueOnce([makeRow({ retry_count: 4 })]) // already failed 4×
      .mockResolvedValueOnce(makeHeader(1)) // CLAIM (won)
      .mockResolvedValueOnce(makeHeader(1)); // MARK failed
    sendMailMock.mockRejectedValueOnce(new Error('relay permanently down'));

    await mailFlush();

    const [failSql, failParams] = queryMock.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(failSql).toMatch(/status\s*=\s*'failed'/i);
    expect(failSql).toMatch(/last_error\s*=\s*\?/i);
    // Params: [newRetryCount, lastError, id]
    expect(failParams[0]).toBe(5); // retry_count reaches the ceiling
    expect(failParams[1]).toBe('relay permanently down');
    expect(failParams[2]).toBe(1);

    // The alert is a structured error log (no second email — avoids loops).
    const alert = childLogs.find(
      (e) =>
        e.level === 'error' &&
        (e.payload as { event?: string }).event === 'mail_permanently_failed',
    );
    expect(alert).toBeDefined();
    expect(alert?.payload).toMatchObject({
      event: 'mail_permanently_failed',
      mail_id: 1,
      retry_count: 5,
      last_error: 'relay permanently down',
    });

    const summary = findSummary();
    expect(summary).toMatchObject({ sent: 0, retried: 0, failed: 1 });
  });
});

describe('mailFlush — claim race (affectedRows = 0)', () => {
  it('skips the row and never attempts an SMTP send', async () => {
    queryMock
      .mockResolvedValueOnce([makeRow()]) // SELECT
      .mockResolvedValueOnce(makeHeader(0)); // CLAIM lost (another worker)

    await mailFlush();

    // Only SELECT + CLAIM ran — no MARK sent / retry / failed UPDATE.
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(sendMailMock).not.toHaveBeenCalled();

    const summary = findSummary();
    expect(summary).toMatchObject({ selected: 1, sent: 0, retried: 0, failed: 0, skipped: 1 });
  });
});

describe('mailFlush — per-row isolation', () => {
  it('continues to the next row when one row throws mid-process', async () => {
    queryMock
      .mockResolvedValueOnce([makeRow({ id: 1 }), makeRow({ id: 2 })]) // SELECT (2 rows)
      .mockResolvedValueOnce(makeHeader(1)) // CLAIM row 1 (won)
      .mockRejectedValueOnce(new Error('deadlock on MARK sent')) // MARK sent row 1 throws
      .mockResolvedValueOnce(makeHeader(1)) // CLAIM row 2 (won)
      .mockResolvedValueOnce(makeHeader(1)); // MARK sent row 2
    sendMailMock.mockResolvedValue(undefined);

    await mailFlush();

    // Both rows attempted a send despite row 1 throwing on its UPDATE.
    expect(sendMailMock).toHaveBeenCalledTimes(2);

    // A per-row error was logged for row 1.
    const rowError = childLogs.find(
      (e) =>
        e.level === 'error' &&
        (e.payload as { event?: string }).event === 'mail_row_error',
    );
    expect(rowError).toBeDefined();
    expect(rowError?.payload).toMatchObject({ mail_id: 1 });

    // Row 2 still counted as sent.
    const summary = findSummary();
    expect(summary).toMatchObject({ selected: 2, sent: 1 });
  });
});

describe('mailFlush — empty batch', () => {
  it('performs no sends and still logs a summary', async () => {
    queryMock.mockResolvedValueOnce([]); // SELECT returns nothing

    await mailFlush();

    expect(queryMock).toHaveBeenCalledTimes(1); // only the SELECT
    expect(sendMailMock).not.toHaveBeenCalled();

    const summary = findSummary();
    expect(summary).toMatchObject({ selected: 0, sent: 0, retried: 0, failed: 0 });
    expect(typeof summary?.duration_ms).toBe('number');
  });
});
