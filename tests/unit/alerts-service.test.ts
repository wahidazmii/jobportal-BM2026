/**
 * Unit tests for `src/modules/alerts/service.ts` + `repo.ts` (task 33.1).
 *
 * Validates: Requirements 7.1 (Design §6 Applicant_Area, §7.2 job_alerts)
 *
 * Coverage:
 *   - `createAlert` happy path (all fields) → INSERT serialises the
 *     `locations` / `departments` arrays to JSON.
 *   - `createAlert` with only `frequency` → INSERT stores nulls for the
 *     optional columns.
 *   - Cap: 10 existing alerts → `AlertCapError`, no INSERT.
 *   - Invalid `frequency` → `InvalidAlertInputError` (no transaction).
 *   - `keyword` > 100 chars → `InvalidAlertInputError`.
 *   - `removeAlert` owner scoping: a non-owned / missing id (DELETE
 *     affects 0 rows) → `AlertNotFoundError`.
 *   - `listAlerts` returns parsed rows (JSON columns → arrays).
 *
 * The service + repo talk to MySQL via `query()` and `withTransaction()`
 * from `src/infra/db.ts`; we mock that boundary so the suite stays
 * hermetic. The repo's real SQL + row-parsing logic runs unmocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Import after the mock registers.
const alertsModule = await import('../../src/modules/alerts/service.js');
const {
  MAX_ALERTS_PER_APPLICANT,
  MAX_KEYWORD_LENGTH,
  AlertCapError,
  AlertNotFoundError,
  InvalidAlertInputError,
  createAlert,
  listAlerts,
  removeAlert,
} = alertsModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPLICANT_USER_ID = 42;

function makeHeader(affectedRows: number, insertId = 0): ResultSetHeader {
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
 * Build a raw `job_alerts` DB row as mysql2 would hand it back. JSON
 * columns are strings here (one driver path) so the repo's parser is
 * exercised end-to-end.
 */
function alertDbRow(
  overrides: Partial<{
    id: number;
    applicant_user_id: number;
    keyword: string | null;
    locations: string | null;
    departments: string | null;
    frequency: 'Daily' | 'Weekly';
    last_evaluated_at: Date | null;
    created_at: Date;
  }> = {},
): RowDataPacket {
  return {
    id: overrides.id ?? 1,
    applicant_user_id: overrides.applicant_user_id ?? APPLICANT_USER_ID,
    keyword: overrides.keyword ?? null,
    locations: overrides.locations ?? null,
    departments: overrides.departments ?? null,
    frequency: overrides.frequency ?? 'Daily',
    last_evaluated_at: overrides.last_evaluated_at ?? null,
    created_at: overrides.created_at ?? new Date('2025-01-01T00:00:00Z'),
  } as unknown as RowDataPacket;
}

function createFakeConnection() {
  const executeMock = vi.fn();
  const connection = { execute: executeMock };
  return { connection, executeMock };
}

/**
 * Wire `withTransaction` so the next call invokes the supplied callback
 * with the fake connection (mirrors production minus the BEGIN/COMMIT
 * bookkeeping covered by the `withTransaction` unit tests).
 */
function bindTransaction(connection: { execute: ReturnType<typeof vi.fn> }) {
  withTransactionMock.mockImplementationOnce(
    async (fn: (conn: typeof connection) => Promise<unknown>) => fn(connection),
  );
}

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('alert module constants', () => {
  it('caps alerts at 10 per applicant', () => {
    expect(MAX_ALERTS_PER_APPLICANT).toBe(10);
  });

  it('caps keyword length at the column width', () => {
    expect(MAX_KEYWORD_LENGTH).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// createAlert — happy paths
// ---------------------------------------------------------------------------

describe('createAlert — all fields', () => {
  it('INSERTs and serialises locations/departments to JSON', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // 1. COUNT(*) FOR UPDATE → 2 existing (under cap).
    executeMock.mockResolvedValueOnce([
      [{ n: 2 } as unknown as RowDataPacket],
      [],
    ]);
    // 2. INSERT → new id 7.
    executeMock.mockResolvedValueOnce([makeHeader(1, 7), []]);
    // 3. SELECT_BY_ID read-back.
    executeMock.mockResolvedValueOnce([
      [
        alertDbRow({
          id: 7,
          keyword: 'engineer',
          locations: '["Jakarta","Surabaya"]',
          departments: '[3,7]',
          frequency: 'Weekly',
        }),
      ],
      [],
    ]);

    const out = await createAlert({
      applicantUserId: APPLICANT_USER_ID,
      input: {
        keyword: 'engineer',
        locations: 'Jakarta, Surabaya',
        departments: '3, 7',
        frequency: 'Weekly',
      },
    });

    expect(out.id).toBe(7);
    expect(out.keyword).toBe('engineer');
    expect(out.locations).toEqual(['Jakarta', 'Surabaya']);
    expect(out.departments).toEqual([3, 7]);
    expect(out.frequency).toBe('Weekly');

    // The INSERT must carry JSON-serialised arrays + the owner id.
    const insertCall = executeMock.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT\s+INTO\s+job_alerts/i);
    const params = insertCall[1] as unknown[];
    expect(params[0]).toBe(APPLICANT_USER_ID);
    expect(params[1]).toBe('engineer');
    expect(params[2]).toBe('["Jakarta","Surabaya"]');
    expect(params[3]).toBe('[3,7]');
    expect(params[4]).toBe('Weekly');
  });
});

describe('createAlert — only frequency', () => {
  it('INSERTs with null keyword/locations/departments', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ n: 0 } as unknown as RowDataPacket],
      [],
    ]);
    executeMock.mockResolvedValueOnce([makeHeader(1, 3), []]);
    executeMock.mockResolvedValueOnce([
      [alertDbRow({ id: 3, frequency: 'Daily' })],
      [],
    ]);

    const out = await createAlert({
      applicantUserId: APPLICANT_USER_ID,
      input: { frequency: 'Daily' },
    });

    expect(out.id).toBe(3);
    expect(out.keyword).toBeNull();
    expect(out.locations).toBeNull();
    expect(out.departments).toBeNull();
    expect(out.frequency).toBe('Daily');

    const params = executeMock.mock.calls[1][1] as unknown[];
    expect(params[1]).toBeNull(); // keyword
    expect(params[2]).toBeNull(); // locations
    expect(params[3]).toBeNull(); // departments
    expect(params[4]).toBe('Daily');
  });

  it('treats an empty locations selection as null (no filter)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ n: 0 } as unknown as RowDataPacket],
      [],
    ]);
    executeMock.mockResolvedValueOnce([makeHeader(1, 4), []]);
    executeMock.mockResolvedValueOnce([[alertDbRow({ id: 4 })], []]);

    await createAlert({
      applicantUserId: APPLICANT_USER_ID,
      input: { frequency: 'Daily', locations: '', departments: [] },
    });

    const params = executeMock.mock.calls[1][1] as unknown[];
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAlert — cap enforcement
// ---------------------------------------------------------------------------

describe('createAlert — cap', () => {
  it('rejects with AlertCapError when 10 alerts already exist, with no INSERT', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ n: MAX_ALERTS_PER_APPLICANT } as unknown as RowDataPacket],
      [],
    ]);

    await expect(
      createAlert({
        applicantUserId: APPLICANT_USER_ID,
        input: { frequency: 'Daily', keyword: 'engineer' },
      }),
    ).rejects.toBeInstanceOf(AlertCapError);

    // No INSERT must have happened — only the COUNT ran.
    const sqls = executeMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /INSERT\s+INTO\s+job_alerts/i.test(s))).toBe(false);
    expect(sqls.some((s) => /COUNT\(\*\)/i.test(s))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAlert — validation
// ---------------------------------------------------------------------------

describe('createAlert — validation', () => {
  it('rejects an invalid frequency with InvalidAlertInputError and no transaction', async () => {
    await expect(
      createAlert({
        applicantUserId: APPLICANT_USER_ID,
        input: { frequency: 'Monthly' },
      }),
    ).rejects.toBeInstanceOf(InvalidAlertInputError);

    // Validation runs before the transaction opens.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('reports the frequency field error', async () => {
    let caught: unknown;
    try {
      await createAlert({
        applicantUserId: APPLICANT_USER_ID,
        input: { frequency: '' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidAlertInputError);
    expect((caught as InstanceType<typeof InvalidAlertInputError>).fieldErrors)
      .toHaveProperty('frequency');
  });

  it('rejects a keyword longer than 100 chars with InvalidAlertInputError', async () => {
    const longKeyword = 'a'.repeat(MAX_KEYWORD_LENGTH + 1);

    let caught: unknown;
    try {
      await createAlert({
        applicantUserId: APPLICANT_USER_ID,
        input: { frequency: 'Daily', keyword: longKeyword },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidAlertInputError);
    expect((caught as InstanceType<typeof InvalidAlertInputError>).fieldErrors)
      .toHaveProperty('keyword');
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeAlert — owner scoping
// ---------------------------------------------------------------------------

describe('removeAlert — owner scoping', () => {
  it('throws AlertNotFoundError when the DELETE affects no rows (missing / non-owned)', async () => {
    // Owner-scoped DELETE matches nothing → affectedRows 0.
    queryMock.mockResolvedValueOnce(makeHeader(0));

    await expect(
      removeAlert({ applicantUserId: APPLICANT_USER_ID, id: 999 }),
    ).rejects.toBeInstanceOf(AlertNotFoundError);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE\s+FROM\s+job_alerts/i);
    expect(sql).toMatch(/applicant_user_id\s*=\s*\?/i);
    // id first, then owner id (matches the SQL placeholder order).
    expect(params).toEqual([999, APPLICANT_USER_ID]);
  });

  it('resolves when the owner-scoped DELETE removes a row', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));

    await expect(
      removeAlert({ applicantUserId: APPLICANT_USER_ID, id: 5 }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listAlerts — JSON parsing
// ---------------------------------------------------------------------------

describe('listAlerts', () => {
  it('returns parsed rows with JSON columns hydrated into arrays', async () => {
    queryMock.mockResolvedValueOnce([
      alertDbRow({
        id: 2,
        keyword: 'designer',
        locations: '["Bandung"]',
        departments: '[5]',
        frequency: 'Weekly',
      }),
      alertDbRow({
        id: 1,
        keyword: null,
        locations: null,
        departments: null,
        frequency: 'Daily',
      }),
    ]);

    const out = await listAlerts(APPLICANT_USER_ID);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 2,
      keyword: 'designer',
      locations: ['Bandung'],
      departments: [5],
      frequency: 'Weekly',
    });
    expect(out[1]).toMatchObject({
      id: 1,
      keyword: null,
      locations: null,
      departments: null,
      frequency: 'Daily',
    });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM\s+job_alerts/i);
    expect(sql).toMatch(/applicant_user_id\s*=\s*\?/i);
    expect(sql).toMatch(/ORDER\s+BY\s+created_at\s+DESC/i);
    expect(params).toEqual([APPLICANT_USER_ID]);
  });

  it('parses already-array JSON columns (mysql2 native JSON path)', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 9,
        applicant_user_id: APPLICANT_USER_ID,
        keyword: 'ops',
        // Driver returns parsed arrays directly for JSON columns.
        locations: ['Medan', 'Batam'],
        departments: [1, 2],
        frequency: 'Daily',
        last_evaluated_at: null,
        created_at: new Date('2025-02-02T00:00:00Z'),
      } as unknown as RowDataPacket,
    ]);

    const out = await listAlerts(APPLICANT_USER_ID);
    expect(out[0].locations).toEqual(['Medan', 'Batam']);
    expect(out[0].departments).toEqual([1, 2]);
  });
});
