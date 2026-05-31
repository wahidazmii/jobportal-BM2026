/**
 * Unit tests for `withdrawApplication` in
 * `src/modules/applications/service.ts` (task 26.2).
 *
 * Validates: Requirements 5.8 (Design §6 Applicant_Area)
 *
 * Coverage:
 *   1. Withdraws an application in stage 'Applied' → UPDATE
 *      stage='Withdrawn', a stage-history row is inserted, and the
 *      audit line is emitted via `logger.info`.
 *   2. Rejects with `WithdrawNotAllowedError` when stage='Hired'.
 *   3. Rejects with `WithdrawNotAllowedError` when stage='Rejected'.
 *   4. Rejects with `WithdrawNotAllowedError` when stage='Withdrawn'
 *      (idempotency guard — no double withdraw, no extra history row).
 *   5. Rejects with `ApplicationNotFoundError` when the FOR UPDATE
 *      read returns no row (the application belongs to a different
 *      applicant, or does not exist — both collapse to not-found).
 *
 * The service talks to MySQL only via `withTransaction()` from
 * `src/infra/db.ts`, which is mocked so the suite stays hermetic. The
 * transaction's `conn.execute` is scripted to mirror the production
 * SQL order:
 *
 *   1. SELECT id, stage FROM applications WHERE id=? AND
 *      applicant_user_id=? ... FOR UPDATE
 *   2. UPDATE applications SET stage='Withdrawn' WHERE id=?
 *   3. INSERT INTO application_stage_history ...
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

const withTransactionMock = vi.fn();
const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

const loggerInfoSpy = vi.fn();
vi.mock('../../src/infra/logger.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/logger.js')
  >('../../src/infra/logger.js');
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: loggerInfoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => ({
        info: loggerInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
  };
});

// Import after mocks register.
const serviceModule = await import('../../src/modules/applications/service.js');
const {
  withdrawApplication,
  ApplicationNotFoundError,
  WithdrawNotAllowedError,
} = serviceModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPLICANT_USER_ID = 42;
const APPLICATION_ID = 1234;

/** Build a fake `ResultSetHeader`. */
function makeHeader(insertId: number, affectedRows = 1): ResultSetHeader {
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

interface ExecCall {
  sql: string;
  params: unknown[];
}

/**
 * Configure `withTransactionMock` to invoke its callback against an
 * in-memory script of `{ match, response }` pairs. Each
 * `conn.execute(sql, params)` call finds the first matching entry,
 * consumes it, and returns / throws the scripted response.
 */
function installFakeTransaction(
  responses: Array<{
    match: RegExp;
    response:
      | readonly [unknown, unknown]
      | ((params: unknown[]) => readonly [unknown, unknown])
      | { throws: unknown };
  }>,
): { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const remaining = [...responses];
  withTransactionMock.mockImplementation(async (fn) => {
    const conn = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const idx = remaining.findIndex((r) => r.match.test(sql));
        if (idx === -1) {
          throw new Error(
            'fakeTransaction: no scripted response for SQL: ' +
              sql.split('\n')[0]!.slice(0, 120),
          );
        }
        const item = remaining[idx]!;
        remaining.splice(idx, 1);
        if (
          typeof item.response === 'object' &&
          item.response !== null &&
          'throws' in (item.response as object)
        ) {
          throw (item.response as { throws: unknown }).throws;
        }
        if (typeof item.response === 'function') {
          return item.response(params);
        }
        return item.response;
      }),
    };
    return fn(conn as never);
  });
  return { calls };
}

/** Script a single-row SELECT result for the FOR UPDATE lock-read. */
function selectRow(stage: string): readonly [RowDataPacket[], unknown[]] {
  return [
    [{ id: APPLICATION_ID, stage } as unknown as RowDataPacket],
    [],
  ];
}

beforeEach(() => {
  withTransactionMock.mockReset();
  queryMock.mockReset();
  loggerInfoSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Happy path — withdraw from 'Applied'
// ---------------------------------------------------------------------------

describe('withdrawApplication — happy path', () => {
  it("transitions an 'Applied' application to 'Withdrawn', records history, and audits", async () => {
    let updateParams: unknown[] | undefined;
    let historyParams: unknown[] | undefined;

    const { calls } = installFakeTransaction([
      {
        match: /FROM applications\s+WHERE id = \? AND applicant_user_id = \?/,
        response: selectRow('Applied'),
      },
      {
        match: /UPDATE applications SET stage = 'Withdrawn'/,
        response: (params) => {
          updateParams = params;
          return [makeHeader(0, 1), []];
        },
      },
      {
        match: /INSERT INTO application_stage_history/,
        response: (params) => {
          historyParams = params;
          return [makeHeader(55, 1), []];
        },
      },
    ]);

    await expect(
      withdrawApplication({
        applicantUserId: APPLICANT_USER_ID,
        applicationId: APPLICATION_ID,
      }),
    ).resolves.toBeUndefined();

    // The owner-scoped FOR UPDATE read ran first with (id, applicantId).
    const selectCall = calls.find((c) => /FOR UPDATE/.test(c.sql));
    expect(selectCall).toBeDefined();
    expect(selectCall!.params).toEqual([APPLICATION_ID, APPLICANT_USER_ID]);

    // UPDATE flipped stage='Withdrawn' (hard-coded in the SQL) for the id.
    expect(updateParams).toEqual([APPLICATION_ID]);
    const updateCall = calls.find((c) =>
      /UPDATE applications SET stage = 'Withdrawn'/.test(c.sql),
    );
    expect(updateCall).toBeDefined();

    // Stage-history row: (application_id, prev_stage, changed_by).
    // new_stage='Withdrawn' is hard-coded into the SQL.
    expect(historyParams).toEqual([
      APPLICATION_ID,
      'Applied',
      APPLICANT_USER_ID,
    ]);
    const historyCall = calls.find((c) =>
      /INSERT INTO application_stage_history/.test(c.sql),
    );
    expect(historyCall!.sql).toMatch(/'Withdrawn'/);

    // Audit log emitted via logger.info with the canonical event.
    const auditCall = loggerInfoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event === 'application_withdrawn',
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBe(APPLICANT_USER_ID);
    expect(payload.application_id).toBe(APPLICATION_ID);
    expect(payload.prev_stage).toBe('Applied');
  });
});

// ---------------------------------------------------------------------------
// 2-4. Terminal-stage guard
// ---------------------------------------------------------------------------

describe('withdrawApplication — terminal-stage guard', () => {
  it("rejects with WithdrawNotAllowedError when stage='Hired'", async () => {
    const { calls } = installFakeTransaction([
      {
        match: /FROM applications\s+WHERE id = \? AND applicant_user_id = \?/,
        response: selectRow('Hired'),
      },
    ]);

    await expect(
      withdrawApplication({
        applicantUserId: APPLICANT_USER_ID,
        applicationId: APPLICATION_ID,
      }),
    ).rejects.toBeInstanceOf(WithdrawNotAllowedError);

    // No UPDATE / INSERT ran — only the lock-read.
    expect(calls.some((c) => /UPDATE applications/.test(c.sql))).toBe(false);
    expect(
      calls.some((c) => /INSERT INTO application_stage_history/.test(c.sql)),
    ).toBe(false);
    expect(loggerInfoSpy).not.toHaveBeenCalled();
  });

  it("rejects with WithdrawNotAllowedError when stage='Rejected'", async () => {
    const { calls } = installFakeTransaction([
      {
        match: /FROM applications\s+WHERE id = \? AND applicant_user_id = \?/,
        response: selectRow('Rejected'),
      },
    ]);

    await expect(
      withdrawApplication({
        applicantUserId: APPLICANT_USER_ID,
        applicationId: APPLICATION_ID,
      }),
    ).rejects.toBeInstanceOf(WithdrawNotAllowedError);

    expect(calls.some((c) => /UPDATE applications/.test(c.sql))).toBe(false);
  });

  it("rejects with WithdrawNotAllowedError when already 'Withdrawn' (idempotency guard)", async () => {
    const { calls } = installFakeTransaction([
      {
        match: /FROM applications\s+WHERE id = \? AND applicant_user_id = \?/,
        response: selectRow('Withdrawn'),
      },
    ]);

    await expect(
      withdrawApplication({
        applicantUserId: APPLICANT_USER_ID,
        applicationId: APPLICATION_ID,
      }),
    ).rejects.toBeInstanceOf(WithdrawNotAllowedError);

    // Crucially: no second history row is inserted on a double-withdraw.
    expect(
      calls.some((c) => /INSERT INTO application_stage_history/.test(c.sql)),
    ).toBe(false);
    expect(calls.some((c) => /UPDATE applications/.test(c.sql))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Owner-scope check → not found
// ---------------------------------------------------------------------------

describe('withdrawApplication — owner scoping', () => {
  it('rejects with ApplicationNotFoundError when the row belongs to another applicant', async () => {
    // The owner-scoped FOR UPDATE read returns zero rows because the
    // WHERE clause requires BOTH id AND applicant_user_id to match.
    const { calls } = installFakeTransaction([
      {
        match: /FROM applications\s+WHERE id = \? AND applicant_user_id = \?/,
        response: [[] as RowDataPacket[], []],
      },
    ]);

    await expect(
      withdrawApplication({
        applicantUserId: APPLICANT_USER_ID,
        applicationId: APPLICATION_ID,
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // Only the lock-read ran; nothing was mutated.
    expect(calls.some((c) => /UPDATE applications/.test(c.sql))).toBe(false);
    expect(
      calls.some((c) => /INSERT INTO application_stage_history/.test(c.sql)),
    ).toBe(false);
    expect(loggerInfoSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Argument validation (defensive)
// ---------------------------------------------------------------------------

describe('withdrawApplication — argument validation', () => {
  it('rejects a non-positive applicantUserId synchronously', async () => {
    await expect(
      withdrawApplication({ applicantUserId: 0, applicationId: APPLICATION_ID }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive applicationId synchronously', async () => {
    await expect(
      withdrawApplication({
        applicantUserId: APPLICANT_USER_ID,
        applicationId: -1,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});
