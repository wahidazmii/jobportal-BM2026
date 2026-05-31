/**
 * Unit tests for `src/modules/bookmarks/service.ts` (task 28.1).
 *
 * Validates: Requirements 6.4, 6.5, 6.6 (Design §6 Applicant_Area)
 *
 * Coverage:
 *   - `toggle` first time on a (applicant, job) pair → INSERT, returns
 *     `{ bookmarked: true }`.
 *   - `toggle` second time on the same (applicant, job) pair →
 *     DELETE, returns `{ bookmarked: false }`.
 *   - `toggle` against a non-existent job → throws `JobNotFoundError`,
 *     no INSERT is issued.
 *   - `list` returns bookmarks ordered by `created_at DESC` (the SQL
 *     trailing tiebreaker is preserved by the mock), and computes
 *     `isApplyable` correctly:
 *       * Closed job          → false
 *       * Archived job        → false
 *       * Published, expired  → false
 *       * Published, no/future deadline → true.
 *
 * The module talks to MySQL via `query()` and `withTransaction()` from
 * `src/infra/db.ts`; we mock those boundaries so the suite stays
 * hermetic. The fake `withTransaction` invokes the callback against a
 * scripted `conn.execute()` so the order of SELECT-for-update / INSERT
 * / DELETE statements matches what the production code emits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after the mocks are registered.
const bookmarksModule = await import('../../src/modules/bookmarks/service.js');
const { JobNotFoundError, list, toggle } = bookmarksModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake `ResultSetHeader`. */
function makeHeader(
  affectedRows: number,
  insertId = 0,
): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

/**
 * Install a fake `withTransaction` that records every `conn.execute(sql, params)`
 * call into `calls` and returns each scripted response in order. The
 * production code emits, per `toggle`:
 *   1. `SELECT 1 ... FOR UPDATE`            (existing-bookmark probe)
 *   2a. `DELETE FROM bookmarks ...`         (when the row exists)
 *   OR
 *   2b. `SELECT id FROM job_postings ...`   (when the row is missing)
 *   3b. `INSERT INTO bookmarks ...`         (only after a successful job probe)
 */
interface ExecCall {
  sql: string;
  params: unknown[];
}

function installFakeTransaction(
  responses: Array<readonly [unknown, unknown]>,
): { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  let idx = 0;
  withTransactionMock.mockImplementation(async (fn) => {
    const conn = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (idx >= responses.length) {
          throw new Error(
            'fakeTransaction: unexpected execute call: ' +
              sql.split('\n')[0]!.trim(),
          );
        }
        const r = responses[idx]!;
        idx += 1;
        return r;
      }),
    };
    return fn(conn as never);
  });
  return { calls };
}

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// toggle()
// ---------------------------------------------------------------------------

describe('bookmarks.toggle — first-time bookmark', () => {
  it('INSERTs a fresh row and returns { bookmarked: true } when the job exists', async () => {
    const { calls } = installFakeTransaction([
      // 1. SELECT 1 ... FOR UPDATE → no row exists yet.
      [[] as RowDataPacket[], []],
      // 2. SELECT id FROM job_postings → job exists.
      [[{ id: 7 } as unknown as RowDataPacket], []],
      // 3. INSERT INTO bookmarks → 1 row affected.
      [makeHeader(1), []],
    ]);

    const result = await toggle(42, 7);
    expect(result).toEqual({ bookmarked: true });

    expect(calls).toHaveLength(3);
    expect(calls[0]!.sql).toMatch(/SELECT 1 AS hit FROM bookmarks/);
    expect(calls[0]!.sql).toMatch(/FOR UPDATE/);
    expect(calls[0]!.params).toEqual([42, 7]);
    expect(calls[1]!.sql).toMatch(/SELECT id FROM job_postings/);
    expect(calls[1]!.params).toEqual([7]);
    expect(calls[2]!.sql).toMatch(/INSERT INTO bookmarks/);
    expect(calls[2]!.params).toEqual([42, 7]);
  });
});

describe('bookmarks.toggle — second-time bookmark', () => {
  it('DELETEs the row and returns { bookmarked: false } when one already exists', async () => {
    const { calls } = installFakeTransaction([
      // 1. SELECT 1 ... FOR UPDATE → row found.
      [[{ hit: 1 } as unknown as RowDataPacket], []],
      // 2. DELETE FROM bookmarks → 1 row affected.
      [makeHeader(1), []],
    ]);

    const result = await toggle(42, 7);
    expect(result).toEqual({ bookmarked: false });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toMatch(/SELECT 1 AS hit FROM bookmarks/);
    expect(calls[0]!.sql).toMatch(/FOR UPDATE/);
    expect(calls[1]!.sql).toMatch(/DELETE FROM bookmarks/);
    expect(calls[1]!.params).toEqual([42, 7]);
  });
});

describe('bookmarks.toggle — non-existent job', () => {
  it('throws JobNotFoundError and never issues an INSERT', async () => {
    const { calls } = installFakeTransaction([
      // 1. SELECT 1 ... FOR UPDATE → no row exists yet.
      [[] as RowDataPacket[], []],
      // 2. SELECT id FROM job_postings → empty (job missing).
      [[] as RowDataPacket[], []],
    ]);

    await expect(toggle(42, 999)).rejects.toBeInstanceOf(JobNotFoundError);

    // Exactly two execute() calls — no INSERT was issued.
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => /INSERT INTO bookmarks/.test(c.sql))).toBeUndefined();
  });
});

describe('bookmarks.toggle — input validation', () => {
  it('rejects a non-positive applicantUserId synchronously', async () => {
    await expect(toggle(0, 1)).rejects.toBeInstanceOf(TypeError);
    await expect(toggle(-1, 1)).rejects.toBeInstanceOf(TypeError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive jobId synchronously', async () => {
    await expect(toggle(1, 0)).rejects.toBeInstanceOf(TypeError);
    await expect(toggle(1, -5)).rejects.toBeInstanceOf(TypeError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('bookmarks.list — ordering and isApplyable', () => {
  /**
   * Build a row in the SELECT_BOOKMARKS_SQL projection shape. The
   * fields match the column aliases in the service module's SQL.
   */
  function fakeRow(overrides: Partial<{
    jobId: number;
    bookmarkedAt: Date;
    slug: string;
    status: string;
    location: string;
    applicationDeadline: string | null;
    title: string;
  }>): RowDataPacket {
    return {
      jobId: 1,
      bookmarkedAt: new Date('2025-01-01T00:00:00Z'),
      slug: 'job-slug',
      status: 'Published',
      location: 'Jakarta',
      applicationDeadline: null,
      title: 'Sample Job',
      ...overrides,
    } as unknown as RowDataPacket;
  }

  it('returns rows in the SELECT order with isApplyable correctly set per status/deadline', async () => {
    // The mock returns rows in the order the SELECT yields them, which
    // mirrors the SQL `ORDER BY created_at DESC`. We assemble the rows
    // newest-first (Job 4 → Job 1) so the array order is the assertion.
    const today = new Date('2025-06-15T12:00:00Z');
    const yesterdayYmd = '2025-06-14';
    const tomorrowYmd = '2025-06-16';

    queryMock.mockResolvedValueOnce([
      // Newest: Published, deadline tomorrow → applyable.
      fakeRow({
        jobId: 4,
        bookmarkedAt: new Date('2025-06-10T10:00:00Z'),
        slug: 'open-position',
        status: 'Published',
        applicationDeadline: tomorrowYmd,
        title: 'Open Position',
      }),
      // Published, NO deadline → applyable.
      fakeRow({
        jobId: 3,
        bookmarkedAt: new Date('2025-06-08T10:00:00Z'),
        slug: 'evergreen',
        status: 'Published',
        applicationDeadline: null,
        title: 'Evergreen',
      }),
      // Published, deadline yesterday → expired (NOT applyable).
      fakeRow({
        jobId: 2,
        bookmarkedAt: new Date('2025-06-05T10:00:00Z'),
        slug: 'too-late',
        status: 'Published',
        applicationDeadline: yesterdayYmd,
        title: 'Too Late',
      }),
      // Closed → NOT applyable regardless of deadline.
      fakeRow({
        jobId: 1,
        bookmarkedAt: new Date('2025-06-01T10:00:00Z'),
        slug: 'closed-job',
        status: 'Closed',
        applicationDeadline: tomorrowYmd,
        title: 'Closed Job',
      }),
    ]);

    const rows = await list(42, 'id', today);
    expect(rows).toHaveLength(4);

    // Order is preserved newest-first.
    expect(rows.map((r) => r.jobId)).toEqual([4, 3, 2, 1]);

    // applyable flags.
    expect(rows[0]!.isApplyable).toBe(true);
    expect(rows[0]!.isPublished).toBe(true);

    expect(rows[1]!.isApplyable).toBe(true);
    expect(rows[1]!.isPublished).toBe(true);

    expect(rows[2]!.isApplyable).toBe(false); // expired
    expect(rows[2]!.isPublished).toBe(true);

    expect(rows[3]!.isApplyable).toBe(false); // Closed
    expect(rows[3]!.isPublished).toBe(false);
  });

  it('marks Archived jobs as not applyable', async () => {
    queryMock.mockResolvedValueOnce([
      fakeRow({
        jobId: 9,
        status: 'Archived',
        applicationDeadline: null,
      }),
    ]);

    const rows = await list(42, 'id', new Date('2025-06-15T00:00:00Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPublished).toBe(false);
    expect(rows[0]!.isApplyable).toBe(false);
  });

  it('uses the requested locale as the primary translation locale and falls back to the alternate', async () => {
    queryMock.mockResolvedValueOnce([]);

    await list(42, 'en');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const params = queryMock.mock.calls[0]![1] as unknown[];
    // Bind order: ['', primary, fallback, applicantUserId]
    expect(params[0]).toBe('');
    expect(params[1]).toBe('en');
    expect(params[2]).toBe('id');
    expect(params[3]).toBe(42);
  });

  it('falls back to the default locale when an unknown locale is requested', async () => {
    queryMock.mockResolvedValueOnce([]);

    await list(42, 'fr');

    const params = queryMock.mock.calls[0]![1] as unknown[];
    expect(params[1]).toBe('id');
    expect(params[2]).toBe('en');
  });
});
