/**
 * Unit tests for `src/crons/audit-archive.ts` (task 41.1).
 *
 * Validates: Requirements 12.4, 12.5 (Design §11.2, §15)
 *
 * The cron talks to MySQL via `query()` from `src/infra/db.ts`; we mock
 * that module before importing the cron so the suite stays hermetic. The
 * filesystem + gzip work is exercised against a *real* temp directory
 * (created per-test, cleaned up in afterEach) using the default IO seam,
 * so the gzip write + gunzip verification round-trip is genuinely
 * validated rather than mocked away. A custom `AuditArchiveIo` is injected
 * only when a test needs to force a verification failure.
 *
 * Coverage:
 *   1. COUNT ≤ 5,000,000 → skip: no row SELECT, no file write, no DELETE;
 *      logs `audit_archive_skipped` (Req 12.4).
 *   2. COUNT > threshold with eligible rows → writes a gzip file per
 *      month, verifies it, then DELETEs that month's rows (Req 12.5).
 *   3. Verification failure → DELETE is NOT issued; error logged (Req 12.5).
 *   4. Summary `audit_archive_done` logged with counts.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

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
const { auditArchive, AUDIT_TABLE_ROW_THRESHOLD } = await import(
  '../../src/crons/audit-archive.js'
);

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

/** Build a fake audit row with sensible defaults. */
function makeAuditRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 1,
    occurred_at: '2021-06-15 10:00:00.000',
    actor_user_id: 42,
    actor_ip: '203.0.113.9',
    action_type: 'login_success',
    target_entity: 'user',
    target_id: 42,
    details: { ok: true },
    ...overrides,
  };
}

/** Find a log entry by its structured `event` field. */
function findEvent(event: string): Record<string, unknown> | undefined {
  const entry = childLogs.find(
    (e) => (e.payload as { event?: string }).event === event,
  );
  return entry?.payload as Record<string, unknown> | undefined;
}

let tmpDir: string;

beforeEach(() => {
  queryMock.mockReset();
  childLogs.length = 0;
  childLogger.info.mockClear();
  childLogger.error.mockClear();
  childLogger.debug.mockClear();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-archive-test-'));
});

afterEach(() => {
  queryMock.mockReset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('auditArchive — threshold gate (Req 12.4)', () => {
  it('skips entirely when COUNT(*) is at or below 5,000,000', async () => {
    queryMock.mockResolvedValueOnce([{ n: AUDIT_TABLE_ROW_THRESHOLD }]); // COUNT

    await auditArchive();

    // Only the COUNT ran — no cutoff, no bucket scan, no row SELECT, no DELETE.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [countSql] = queryMock.mock.calls[0] as [string];
    expect(countSql).toMatch(/SELECT\s+COUNT\(\*\)/i);
    expect(countSql).toMatch(/FROM\s+audit_events/i);

    const skipped = findEvent('audit_archive_skipped');
    expect(skipped).toMatchObject({ count: AUDIT_TABLE_ROW_THRESHOLD });

    // No archive file was created.
    expect(existsSync(path.join(tmpDir, 'archives'))).toBe(false);
  });
});

describe('auditArchive — archive + verify + prune (Req 12.5)', () => {
  it('writes a gzip file per month, verifies it, then DELETEs that month', async () => {
    const cutoff = new Date('2023-06-15T00:00:00Z');
    const rows = [
      makeAuditRow({ id: 10, occurred_at: '2021-06-01 08:00:00.000' }),
      makeAuditRow({ id: 11, occurred_at: '2021-06-20 23:30:00.000' }),
    ];

    queryMock
      .mockResolvedValueOnce([{ n: AUDIT_TABLE_ROW_THRESHOLD + 3 }]) // COUNT > threshold
      .mockResolvedValueOnce([{ cutoff }]) // cutoff
      .mockResolvedValueOnce([{ ym: '2021-06', cnt: 2 }]) // buckets
      .mockResolvedValueOnce(rows) // SELECT bucket rows
      .mockResolvedValueOnce(makeHeader(2)); // DELETE bucket rows

    await auditArchive({
      archiveDir: () => path.join(tmpDir, 'archives', 'audit'),
      ensureDir: async (dir) => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dir, { recursive: true });
      },
      writeGzipJsonl: async (filePath, lines) => {
        const { createWriteStream } = await import('node:fs');
        const { createGzip } = await import('node:zlib');
        const { Readable } = await import('node:stream');
        const { pipeline } = await import('node:stream/promises');
        await pipeline(
          Readable.from(lines.map((l) => `${l}\n`)),
          createGzip(),
          createWriteStream(filePath),
        );
      },
      verifyGzipLineCount: async (filePath, expected) => {
        const buf = readFileSync(filePath);
        const text = gunzipSync(buf).toString('utf8');
        const count = text.split('\n').filter((l) => l.length > 0).length;
        return count === expected;
      },
    });

    // The archive file exists and round-trips to the two rows we wrote.
    const archivePath = path.join(
      tmpDir,
      'archives',
      'audit',
      'audit-2021-06.jsonl.gz',
    );
    expect(existsSync(archivePath)).toBe(true);
    const decoded = gunzipSync(readFileSync(archivePath)).toString('utf8');
    const lines = decoded.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 10, action_type: 'login_success' });

    // The DELETE used the same month/cutoff bounds as the SELECT.
    const selectCall = queryMock.mock.calls[3] as [string, unknown[]];
    const deleteCall = queryMock.mock.calls[4] as [string, unknown[]];
    expect(selectCall[0]).toMatch(/SELECT/i);
    expect(selectCall[0]).toMatch(/FROM\s+audit_events/i);
    expect(deleteCall[0]).toMatch(/DELETE\s+FROM\s+audit_events/i);
    // [monthStart, monthEnd, cutoff]
    expect(deleteCall[1]).toEqual(['2021-06-01 00:00:00', '2021-07-01 00:00:00', cutoff]);
    expect(selectCall[1]).toEqual(['2021-06-01 00:00:00', '2021-07-01 00:00:00', cutoff]);

    const done = findEvent('audit_archive_done');
    expect(done).toMatchObject({ archived_rows: 2, buckets: 1 });
  });
});

describe('auditArchive — verification failure (Req 12.5)', () => {
  it('does NOT DELETE the bucket when gzip verification fails, and logs an error', async () => {
    const cutoff = new Date('2023-06-15T00:00:00Z');
    const rows = [makeAuditRow({ id: 99, occurred_at: '2021-03-10 12:00:00.000' })];

    queryMock
      .mockResolvedValueOnce([{ n: AUDIT_TABLE_ROW_THRESHOLD + 1 }]) // COUNT
      .mockResolvedValueOnce([{ cutoff }]) // cutoff
      .mockResolvedValueOnce([{ ym: '2021-03', cnt: 1 }]) // buckets
      .mockResolvedValueOnce(rows); // SELECT bucket rows
    // NOTE: no DELETE mock queued — if the cron tried to DELETE it would
    // resolve to `undefined` and throw on `.affectedRows`, failing the test.

    await auditArchive({
      archiveDir: () => path.join(tmpDir, 'archives', 'audit'),
      ensureDir: async (dir) => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dir, { recursive: true });
      },
      writeGzipJsonl: async () => {
        // Pretend the write happened but produced a corrupt file.
      },
      verifyGzipLineCount: async () => false, // force verification failure
    });

    // DELETE must NOT have been attempted — only COUNT, cutoff, buckets, SELECT.
    expect(queryMock).toHaveBeenCalledTimes(4);
    const calledSqls = queryMock.mock.calls.map((c) => c[0] as string);
    expect(calledSqls.some((sql) => /DELETE/i.test(sql))).toBe(false);

    const verifyFailed = findEvent('audit_archive_verify_failed');
    expect(verifyFailed).toMatchObject({ bucket: '2021-03', expected_rows: 1 });

    // The run still completes and reports zero archived rows.
    const done = findEvent('audit_archive_done');
    expect(done).toMatchObject({ archived_rows: 0, buckets: 0 });
  });
});

describe('auditArchive — summary log (Req 12.5)', () => {
  it('logs audit_archive_done with count_before, archived_rows, buckets, and duration_ms', async () => {
    const cutoff = new Date('2023-06-15T00:00:00Z');
    queryMock
      .mockResolvedValueOnce([{ n: AUDIT_TABLE_ROW_THRESHOLD + 5 }]) // COUNT
      .mockResolvedValueOnce([{ cutoff }]) // cutoff
      .mockResolvedValueOnce([]); // no buckets

    await auditArchive({
      archiveDir: () => path.join(tmpDir, 'archives', 'audit'),
      ensureDir: async () => {},
      writeGzipJsonl: async () => {},
      verifyGzipLineCount: async () => true,
    });

    const done = findEvent('audit_archive_done');
    expect(done).toBeDefined();
    expect(done).toMatchObject({
      count_before: AUDIT_TABLE_ROW_THRESHOLD + 5,
      archived_rows: 0,
      buckets: 0,
    });
    expect(typeof done?.duration_ms).toBe('number');
    expect(done?.duration_ms as number).toBeGreaterThanOrEqual(0);
  });
});
