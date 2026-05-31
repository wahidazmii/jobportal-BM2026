/**
 * Unit tests for `src/modules/applications/stage-service.ts` (task 29.2).
 *
 * Validates: Requirements 10.2, 8.1, 12.1 (Design §6 Admin, §15)
 *
 * Coverage:
 *   - `changeStage` happy path: locks the row, UPDATEs the stage,
 *     INSERTs the stage-history row, emits the audit log line, attempts
 *     the mail enqueue, and returns `{ applicationId, prevStage,
 *     newStage }`.
 *   - Sets `hired_at = NOW()` ONLY when `newStage === 'Hired'` (the
 *     Hired UPDATE carries `hired_at = NOW()`; non-Hired transitions use
 *     the plain UPDATE that leaves the column untouched).
 *   - Rejects an invalid transition with `InvalidStageTransitionError`
 *     and never issues the UPDATE / history INSERT.
 *   - `ApplicationNotFoundError` when the row is missing.
 *   - `ApplicationNotFoundError` when the application's job is outside
 *     the Department_Head scope (the job lookup collapses to null — no
 *     row leak).
 *
 * The service talks to MySQL via `withTransaction()` and to the jobs
 * repo via `findById`; both are mocked. The transaction's `conn.execute`
 * is scripted to mirror the production SQL order:
 *
 *   1. SELECT ... FROM applications WHERE id = ? FOR UPDATE
 *   2. UPDATE applications SET stage = ? [, hired_at = NOW()] WHERE id = ?
 *   3. INSERT INTO application_stage_history ...
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const withTransactionMock = vi.fn();
const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

const findJobByIdMock = vi.fn();
vi.mock('../../src/modules/jobs/repo.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/jobs/repo.js')
  >('../../src/modules/jobs/repo.js');
  return {
    ...actual,
    findById: findJobByIdMock,
  };
});

const loggerInfoSpy = vi.fn();
const loggerErrorSpy = vi.fn();
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
      error: loggerErrorSpy,
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => ({
        info: loggerInfoSpy,
        warn: vi.fn(),
        error: loggerErrorSpy,
      })),
    },
  };
});

const enqueueStageChangeMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
  enqueueStageChange: enqueueStageChangeMock,
}));

// Import after the mocks register.
const serviceModule = await import(
  '../../src/modules/applications/stage-service.js'
);
const { changeStage, ApplicationNotFoundError, InvalidStageTransitionError } =
  serviceModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLICATION_ID = 555;
const JOB_ID = 42;
const APPLICANT_USER_ID = 321;
const ACTOR_USER_ID = 7;
const REFERENCE_NO = 'APP-2025-000555';

/** Build a fake `ResultSetHeader`. */
function makeHeader(affectedRows = 1): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId: 0,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: affectedRows,
  } as ResultSetHeader;
}

interface ExecCall {
  sql: string;
  params: unknown[];
}

/**
 * Configure `withTransactionMock` to invoke its callback against an
 * in-memory script of `(sql-matcher) → response` pairs. Each
 * `conn.execute(sql, params)` call is matched (in declaration order)
 * against the remaining scripted responses.
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

/** Build the FOR UPDATE lock row response for a given current stage. */
function lockRow(stage: string): readonly [RowDataPacket[], unknown] {
  return [
    [
      {
        id: APPLICATION_ID,
        job_id: JOB_ID,
        applicant_user_id: APPLICANT_USER_ID,
        reference_no: REFERENCE_NO,
        stage,
      } as unknown as RowDataPacket,
    ],
    [],
  ];
}

beforeEach(() => {
  withTransactionMock.mockReset();
  queryMock.mockReset();
  findJobByIdMock.mockReset();
  loggerInfoSpy.mockReset();
  loggerErrorSpy.mockReset();
  enqueueStageChangeMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('changeStage — happy path', () => {
  it('UPDATEs the stage, inserts stage_history, audits, and returns prev/new', async () => {
    let updateParams: unknown[] | undefined;
    let historyParams: unknown[] | undefined;
    let auditParams: unknown[] | undefined;

    const { calls } = installFakeTransaction([
      { match: /FROM applications WHERE id = \? FOR UPDATE/, response: lockRow('Applied') },
      {
        match: /UPDATE applications SET stage = \? WHERE id = \?/,
        response: (params) => {
          updateParams = params;
          return [makeHeader(1), []];
        },
      },
      {
        match: /INSERT INTO application_stage_history/,
        response: (params) => {
          historyParams = params;
          return [makeHeader(1), []];
        },
      },
      {
        match: /INSERT INTO audit_events/,
        response: (params) => {
          auditParams = params;
          return [makeHeader(1), []];
        },
      },
    ]);

    const result = await changeStage({
      applicationId: APPLICATION_ID,
      newStage: 'Screening',
      actorUserId: ACTOR_USER_ID,
      reason: 'Looks promising',
    });

    expect(result).toEqual({
      applicationId: APPLICATION_ID,
      prevStage: 'Applied',
      newStage: 'Screening',
    });

    // UPDATE bound (newStage, id). It must be the plain (non-Hired)
    // UPDATE — no hired_at clause.
    expect(updateParams).toEqual(['Screening', APPLICATION_ID]);
    const updateCall = calls.find((c) => /UPDATE applications SET stage/.test(c.sql));
    expect(updateCall!.sql).not.toMatch(/hired_at/);

    // stage_history bound (application_id, prev_stage, new_stage, changed_by).
    expect(historyParams).toEqual([
      APPLICATION_ID,
      'Applied',
      'Screening',
      ACTOR_USER_ID,
    ]);

    // Audit log line emitted with the stage-change payload.
    const auditCall = loggerInfoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event === 'application_stage_change',
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBe(ACTOR_USER_ID);
    expect(payload.application_id).toBe(APPLICATION_ID);
    expect(payload.prev_stage).toBe('Applied');
    expect(payload.new_stage).toBe('Screening');
    expect(payload.reason).toBe('Looks promising');

    // A real audit_events INSERT ran ON the transaction connection
    // (Req 12.1) — it commits atomically with the UPDATE + history INSERT.
    const auditCallSql = calls.find((c) => /INSERT INTO audit_events/.test(c.sql));
    expect(auditCallSql).toBeDefined();
    // Column list omits occurred_at (DB default CURRENT_TIMESTAMP(3)).
    expect(auditCallSql!.sql).not.toMatch(/occurred_at/);
    // Bound params: (actor_user_id, actor_ip, action_type, target_entity,
    // target_id, details-json).
    expect(auditParams).toBeDefined();
    expect(auditParams![0]).toBe(ACTOR_USER_ID);
    expect(auditParams![2]).toBe('application_stage_change');
    expect(auditParams![3]).toBe('application');
    expect(auditParams![4]).toBe(APPLICATION_ID);
    const details = JSON.parse(auditParams![5] as string) as Record<
      string,
      unknown
    >;
    expect(details.prev_stage).toBe('Applied');
    expect(details.new_stage).toBe('Screening');
    expect(details.reason).toBe('Looks promising');

    // The status-change email was attempted (Req 8.1).
    expect(enqueueStageChangeMock).toHaveBeenCalledTimes(1);
    const mailCtx = enqueueStageChangeMock.mock.calls[0]![0] as {
      applicationId: number;
      newStage: string;
    };
    expect(mailCtx.applicationId).toBe(APPLICATION_ID);
    expect(mailCtx.newStage).toBe('Screening');
  });
});

// ---------------------------------------------------------------------------
// hired_at semantics
// ---------------------------------------------------------------------------

describe('changeStage — hired_at stamping', () => {
  it('uses the hired_at = NOW() UPDATE only when newStage is Hired', async () => {
    let updateSql: string | undefined;

    installFakeTransaction([
      { match: /FROM applications WHERE id = \? FOR UPDATE/, response: lockRow('Offer') },
      {
        match: /UPDATE applications SET stage = \?, hired_at = NOW\(\) WHERE id = \?/,
        response: (params) => {
          updateSql = 'hired';
          void params;
          return [makeHeader(1), []];
        },
      },
      {
        match: /INSERT INTO application_stage_history/,
        response: [makeHeader(1), []],
      },
      {
        match: /INSERT INTO audit_events/,
        response: [makeHeader(1), []],
      },
    ]);

    const result = await changeStage({
      applicationId: APPLICATION_ID,
      newStage: 'Hired',
      actorUserId: ACTOR_USER_ID,
    });
    expect(result.prevStage).toBe('Offer');
    expect(result.newStage).toBe('Hired');
    // The hired-specific UPDATE branch ran (the matcher only accepts the
    // `hired_at = NOW()` variant).
    expect(updateSql).toBe('hired');
  });

  it('does NOT stamp hired_at for a non-Hired transition', async () => {
    const { calls } = installFakeTransaction([
      { match: /FROM applications WHERE id = \? FOR UPDATE/, response: lockRow('Interview') },
      {
        match: /UPDATE applications SET stage = \? WHERE id = \?/,
        response: [makeHeader(1), []],
      },
      {
        match: /INSERT INTO application_stage_history/,
        response: [makeHeader(1), []],
      },
      {
        match: /INSERT INTO audit_events/,
        response: [makeHeader(1), []],
      },
    ]);

    await changeStage({
      applicationId: APPLICATION_ID,
      newStage: 'Offer',
      actorUserId: ACTOR_USER_ID,
    });

    const updateCall = calls.find((c) => /UPDATE applications SET stage/.test(c.sql));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).not.toMatch(/hired_at/);
  });
});

// ---------------------------------------------------------------------------
// Invalid transition
// ---------------------------------------------------------------------------

describe('changeStage — invalid transition', () => {
  it('rejects an invalid transition and never UPDATEs or inserts history', async () => {
    const { calls } = installFakeTransaction([
      { match: /FROM applications WHERE id = \? FOR UPDATE/, response: lockRow('Applied') },
      // No UPDATE / INSERT scripted: if the service tried to run them the
      // fake transaction would throw "no scripted response".
    ]);

    await expect(
      changeStage({
        applicationId: APPLICATION_ID,
        newStage: 'Hired', // Applied → Hired is not allowed
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(InvalidStageTransitionError);

    // Only the FOR UPDATE lock ran; no UPDATE / history INSERT.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/FOR UPDATE/);
    expect(enqueueStageChangeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Not found / out of scope
// ---------------------------------------------------------------------------

describe('changeStage — not found and scope', () => {
  it('rejects with ApplicationNotFoundError when the row is missing', async () => {
    installFakeTransaction([
      {
        match: /FROM applications WHERE id = \? FOR UPDATE/,
        response: [[] as RowDataPacket[], []],
      },
    ]);

    await expect(
      changeStage({
        applicationId: APPLICATION_ID,
        newStage: 'Screening',
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    expect(findJobByIdMock).not.toHaveBeenCalled();
  });

  it('rejects with ApplicationNotFoundError when the job is outside the Department_Head scope', async () => {
    findJobByIdMock.mockResolvedValueOnce(null); // out-of-scope → null

    const { calls } = installFakeTransaction([
      { match: /FROM applications WHERE id = \? FOR UPDATE/, response: lockRow('Applied') },
    ]);

    await expect(
      changeStage({
        applicationId: APPLICATION_ID,
        newStage: 'Screening',
        actorUserId: ACTOR_USER_ID,
        scope: { departments: [99] }, // does not include the job's dept
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // The scope was threaded into the job lookup.
    expect(findJobByIdMock).toHaveBeenCalledWith(JOB_ID, { departments: [99] });
    // No UPDATE / history INSERT for an out-of-scope application.
    expect(calls).toHaveLength(1);
    expect(enqueueStageChangeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Argument validation (defensive)
// ---------------------------------------------------------------------------

describe('changeStage — argument validation', () => {
  it('rejects a non-positive applicationId with ApplicationNotFoundError', async () => {
    await expect(
      changeStage({
        applicationId: 0,
        newStage: 'Screening',
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive actorUserId synchronously', async () => {
    await expect(
      changeStage({
        applicationId: APPLICATION_ID,
        newStage: 'Screening',
        actorUserId: 0,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});
