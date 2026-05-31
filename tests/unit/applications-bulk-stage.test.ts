/**
 * Unit tests for `bulkChangeStage` in
 * `src/modules/applications/stage-service.ts` (task 29.3).
 *
 * Validates: Requirements 10.5, 10.6 (Design §6 Admin)
 *
 * `bulkChangeStage` orchestrates the existing `changeStage` once PER
 * application, each inside its OWN transaction, and reports per-row
 * success / failure WITHOUT aborting the batch (Req 10.6). Because
 * `bulkChangeStage` calls `changeStage` through a direct lexical binding
 * inside the same module, a module-level mock of the `changeStage`
 * export would not intercept that internal call. We therefore make the
 * test hermetic at the DB boundary instead: `withTransaction` runs each
 * `changeStage` callback against a scripted fake connection keyed by the
 * application id (the FOR UPDATE select carries the id in its params), so
 * the real orchestration logic of BOTH functions is exercised end-to-end
 * without touching MySQL.
 *
 * Coverage:
 *   1. All-success batch → every id transitions, results all `ok: true`.
 *   2. Mixed batch (valid / invalid-transition / not-found) → results
 *      reflect each outcome, the batch is NOT aborted, counts correct.
 *   3. Duplicate ids are de-duplicated (each application touched once).
 *   4. Batch over the cap → `BulkStageBatchTooLargeError` BEFORE any
 *      transition runs.
 *   5. (bonus) An unexpected per-id error collapses to `internal_error`
 *      and the batch continues.
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

vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
  enqueueStageChange: vi.fn().mockResolvedValue(undefined),
}));

// Import after the mocks register.
const serviceModule = await import(
  '../../src/modules/applications/stage-service.js'
);
const { bulkChangeStage, BulkStageBatchTooLargeError, BULK_STAGE_MAX_BATCH } =
  serviceModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR_USER_ID = 7;
const JOB_ID = 42;

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

/** Build the FOR UPDATE lock row response for a given id + current stage. */
function lockRow(
  id: number,
  stage: string,
): readonly [RowDataPacket[], unknown] {
  return [
    [
      {
        id,
        job_id: JOB_ID,
        applicant_user_id: 300 + id,
        reference_no: `APP-2025-${String(id).padStart(6, '0')}`,
        stage,
      } as unknown as RowDataPacket,
    ],
    [],
  ];
}

/**
 * Per-application script for the fake transaction. `stage` is the
 * application's CURRENT stage; `missing: true` makes the FOR UPDATE
 * return no row (→ ApplicationNotFoundError); `updateThrows` injects a
 * generic error at the UPDATE step (→ internal_error).
 */
interface IdSpec {
  readonly stage?: string;
  readonly missing?: boolean;
  readonly updateThrows?: unknown;
}

/**
 * Drive `withTransactionMock` so each `changeStage` transaction runs
 * against a fake connection that resolves its responses from `byId`,
 * keyed by the application id read off the FOR UPDATE params. Returns a
 * counter of how many transactions (i.e. changeStage calls) ran.
 */
function installBulkTransaction(byId: Map<number, IdSpec>): {
  transactions: number;
} {
  const state = { transactions: 0 };
  withTransactionMock.mockImplementation(async (fn) => {
    state.transactions += 1;
    let currentId = -1;
    const conn = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (/FOR UPDATE/.test(sql)) {
          currentId = Number(params[0]);
          const spec = byId.get(currentId);
          if (spec === undefined || spec.missing === true) {
            return [[] as RowDataPacket[], []];
          }
          return lockRow(currentId, spec.stage ?? 'Applied');
        }
        if (/UPDATE applications SET stage/.test(sql)) {
          const spec = byId.get(currentId);
          if (spec?.updateThrows !== undefined) {
            throw spec.updateThrows;
          }
          return [makeHeader(1), []];
        }
        if (/INSERT INTO application_stage_history/.test(sql)) {
          return [makeHeader(1), []];
        }
        if (/INSERT INTO audit_events/.test(sql)) {
          return [makeHeader(1), []];
        }
        throw new Error('unscripted SQL: ' + sql.split('\n')[0]!.slice(0, 80));
      }),
    };
    return fn(conn as never);
  });
  return state;
}

beforeEach(() => {
  withTransactionMock.mockReset();
  queryMock.mockReset();
  findJobByIdMock.mockReset();
  loggerInfoSpy.mockReset();
  loggerErrorSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. All-success batch
// ---------------------------------------------------------------------------

describe('bulkChangeStage — all-success batch', () => {
  it('transitions every id and reports ok:true for each, in input order', async () => {
    const byId = new Map<number, IdSpec>([
      [101, { stage: 'Applied' }],
      [102, { stage: 'Applied' }],
      [103, { stage: 'Applied' }],
    ]);
    const state = installBulkTransaction(byId);

    const { results } = await bulkChangeStage({
      applicationIds: [101, 102, 103],
      newStage: 'Screening',
      actorUserId: ACTOR_USER_ID,
    });

    expect(state.transactions).toBe(3);
    expect(results).toEqual([
      { applicationId: 101, ok: true, prevStage: 'Applied', newStage: 'Screening' },
      { applicationId: 102, ok: true, prevStage: 'Applied', newStage: 'Screening' },
      { applicationId: 103, ok: true, prevStage: 'Applied', newStage: 'Screening' },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Mixed batch — not aborted on per-row failure
// ---------------------------------------------------------------------------

describe('bulkChangeStage — mixed batch (Req 10.6)', () => {
  it('reports each outcome without aborting the batch and counts correctly', async () => {
    const byId = new Map<number, IdSpec>([
      [201, { stage: 'Applied' }], // Applied → Screening : valid
      [202, { stage: 'Hired' }], // Hired → Screening : invalid (terminal)
      [203, { missing: true }], // not found
    ]);
    installBulkTransaction(byId);

    const { results } = await bulkChangeStage({
      applicationIds: [201, 202, 203],
      newStage: 'Screening',
      actorUserId: ACTOR_USER_ID,
    });

    expect(results).toEqual([
      { applicationId: 201, ok: true, prevStage: 'Applied', newStage: 'Screening' },
      { applicationId: 202, ok: false, error: 'invalid_transition' },
      { applicationId: 203, ok: false, error: 'not_found' },
    ]);

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    expect(succeeded).toBe(1);
    expect(failed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate ids de-duplicated
// ---------------------------------------------------------------------------

describe('bulkChangeStage — de-duplication', () => {
  it('transitions each application at most once even with repeated ids', async () => {
    const byId = new Map<number, IdSpec>([
      [301, { stage: 'Applied' }],
      [302, { stage: 'Applied' }],
    ]);
    const state = installBulkTransaction(byId);

    const { results } = await bulkChangeStage({
      applicationIds: [301, 301, 302, 301],
      newStage: 'Screening',
      actorUserId: ACTOR_USER_ID,
    });

    // Only two distinct applications → two transactions, two result rows.
    expect(state.transactions).toBe(2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.applicationId)).toEqual([301, 302]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Batch over the cap → rejected before processing
// ---------------------------------------------------------------------------

describe('bulkChangeStage — batch cap', () => {
  it('throws BulkStageBatchTooLargeError before running any transition', async () => {
    installBulkTransaction(new Map());

    // One more than the cap, all distinct so de-dup does not save it.
    const tooMany = Array.from(
      { length: BULK_STAGE_MAX_BATCH + 1 },
      (_, i) => i + 1,
    );

    await expect(
      bulkChangeStage({
        applicationIds: tooMany,
        newStage: 'Screening',
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(BulkStageBatchTooLargeError);

    // Rejected up-front: no transition ran.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('accepts a batch exactly at the cap', async () => {
    const ids = Array.from({ length: BULK_STAGE_MAX_BATCH }, (_, i) => i + 1);
    const byId = new Map<number, IdSpec>(
      ids.map((id) => [id, { stage: 'Applied' } as IdSpec]),
    );
    const state = installBulkTransaction(byId);

    const { results } = await bulkChangeStage({
      applicationIds: ids,
      newStage: 'Screening',
      actorUserId: ACTOR_USER_ID,
    });

    expect(state.transactions).toBe(BULK_STAGE_MAX_BATCH);
    expect(results).toHaveLength(BULK_STAGE_MAX_BATCH);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Unexpected per-id error → internal_error, batch continues
// ---------------------------------------------------------------------------

describe('bulkChangeStage — unexpected per-id error', () => {
  it('collapses an unknown error to internal_error and continues the batch', async () => {
    const byId = new Map<number, IdSpec>([
      [401, { stage: 'Applied', updateThrows: new Error('db exploded') }],
      [402, { stage: 'Applied' }],
    ]);
    installBulkTransaction(byId);

    const { results } = await bulkChangeStage({
      applicationIds: [401, 402],
      newStage: 'Screening',
      actorUserId: ACTOR_USER_ID,
    });

    expect(results).toEqual([
      { applicationId: 401, ok: false, error: 'internal_error' },
      { applicationId: 402, ok: true, prevStage: 'Applied', newStage: 'Screening' },
    ]);
    // The failure was logged for forensics.
    expect(loggerErrorSpy).toHaveBeenCalled();
  });
});
