/**
 * Unit tests for `src/modules/applications/service.ts` (task 26.1).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5 (Design §6 Applicant_Area)
 *
 * Coverage:
 *   - `applyToJob` rejects with `IncompleteProfileError` when
 *     completeness < 80 % — `missingFields` is populated from the
 *     canonical slot keys.
 *   - `applyToJob` rejects with `MissingCvError` when no active CV
 *     row exists.
 *   - `applyToJob` rejects with `JobUnavailableError` when the job
 *     is not Published.
 *   - `applyToJob` rejects with `JobUnavailableError` when the
 *     deadline is in the past.
 *   - `applyToJob` translates `ER_DUP_ENTRY` on
 *     `uk_app_applicant_job` into `DuplicateApplicationError`
 *     (Req 5.3).
 *   - `applyToJob` happy path: returns the freshly-inserted row,
 *     stage is `'Applied'`, the source threads through correctly,
 *     and the audit log line is emitted via `logger.info`.
 *
 * The service talks to MySQL via `withTransaction()` from
 * `src/infra/db.ts` and to the jobs repo via `findById`. Both are
 * mocked so the suite stays hermetic. The transaction's `conn.execute`
 * is scripted to mirror the production SQL order:
 *
 *   1. SELECT applicants + active CV (one round-trip).
 *   2. SELECT 1 FROM applicant_education ... LIMIT 1
 *   3. SELECT 1 FROM applicant_experience ... LIMIT 1
 *   4. SELECT COUNT(*) FROM applications WHERE reference_no LIKE ? FOR UPDATE
 *   5. INSERT INTO applications ...
 *   6. INSERT INTO application_stage_history ...
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
  applyToJob,
  DuplicateApplicationError,
  IncompleteProfileError,
  JobUnavailableError,
  MissingCvError,
} = serviceModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPLICANT_USER_ID = 42;
const JOB_ID = 7;
const CV_FILE_ID = 99;
const INSERTED_APPLICATION_ID = 1234;

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

/**
 * Build a "complete" applicant snapshot row — every mandatory string
 * field non-empty, plus an active CV id. Combined with `hasEducation`
 * and `hasExperience` flags the suite drives the completeness gate.
 */
function completeApplicantSnapshot(
  overrides: Partial<{
    cv_id: number | null;
    full_name: string | null;
    summary: string | null;
  }> = {},
): RowDataPacket {
  return {
    user_id: APPLICANT_USER_ID,
    full_name: 'Sari Pelita',
    date_of_birth: '1995-04-12',
    phone: '+6281234567890',
    address: 'Jl. Mawar 12',
    city: 'Bandung',
    province: 'Jawa Barat',
    country: 'Indonesia',
    summary: 'Frontend engineer with 5 years experience',
    cv_id: CV_FILE_ID,
    ...overrides,
  } as unknown as RowDataPacket;
}

/** Build a future-deadline Published job posting record. */
function publishedJob(
  overrides: Partial<{
    status: string;
    application_deadline: string | null;
  }> = {},
) {
  return {
    id: JOB_ID,
    uuid: 'job-uuid-1',
    slug: 'senior-fe-engineer',
    department_id: null,
    location: 'Jakarta',
    employment_type: 'full-time',
    level: 'senior',
    status: 'Published',
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    application_deadline: '2099-01-01',
    published_at: new Date('2025-01-01T00:00:00Z'),
    created_by: 1,
    created_at: new Date('2025-01-01T00:00:00Z'),
    updated_at: new Date('2025-01-01T00:00:00Z'),
    translations: {},
    ...overrides,
  };
}

interface ExecCall {
  sql: string;
  params: unknown[];
}

/**
 * Configure `withTransactionMock` to invoke its callback against an
 * in-memory script of `(sql, params) → response` pairs. Each
 * `conn.execute(sql, params)` call advances through the script.
 *
 * The production SQL order inside `applyToJob` is:
 *   1. SELECT applicants + active CV
 *   2. SELECT 1 FROM applicant_education
 *   3. SELECT 1 FROM applicant_experience
 *   4. SELECT COUNT(*) FROM applications ... FOR UPDATE
 *   5. INSERT INTO applications
 *   6. INSERT INTO application_stage_history
 *
 * The two existence checks (steps 2 + 3) are issued via
 * `Promise.all`, so the order between them is implementation-detail
 * but the script accepts them in either order via SQL prefix
 * matching.
 */
function installFakeTransaction(
  responses: Array<{
    match: RegExp | ((sql: string) => boolean);
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
        const idx = remaining.findIndex((r) =>
          typeof r.match === 'function'
            ? (r.match as (s: string) => boolean)(sql)
            : (r.match as RegExp).test(sql),
        );
        if (idx === -1) {
          throw new Error(
            'fakeTransaction: no scripted response for SQL: ' +
              sql.split('\n')[0]!.slice(0, 120),
          );
        }
        const item = remaining[idx]!;
        remaining.splice(idx, 1);
        if (typeof item.response === 'object' && item.response !== null && 'throws' in (item.response as object)) {
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

beforeEach(() => {
  withTransactionMock.mockReset();
  queryMock.mockReset();
  findJobByIdMock.mockReset();
  loggerInfoSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// IncompleteProfileError when completeness < 80%
// ---------------------------------------------------------------------------

describe('applyToJob — completeness gate', () => {
  it('rejects with IncompleteProfileError when completeness is below 80%', async () => {
    findJobByIdMock.mockResolvedValueOnce(publishedJob());

    // A sparse profile: missing address, city, province, country,
    // summary, hasEducation, hasExperience → 4/11 filled ≈ 36 %.
    installFakeTransaction([
      {
        match: /FROM applicants a/,
        response: [
          [
            {
              user_id: APPLICANT_USER_ID,
              full_name: 'Sari',
              date_of_birth: '1995-04-12',
              phone: '+62812',
              address: '',
              city: null,
              province: null,
              country: null,
              summary: null,
              cv_id: CV_FILE_ID,
            } as unknown as RowDataPacket,
          ],
          [],
        ],
      },
      {
        match: /FROM applicant_education/,
        response: [[] as RowDataPacket[], []],
      },
      {
        match: /FROM applicant_experience/,
        response: [[] as RowDataPacket[], []],
      },
    ]);

    // A single invocation: capture the rejection so we can assert both
    // the error type AND the payload it carries without re-driving the
    // (one-shot) job + transaction mocks.
    const error = await applyToJob({
      applicantUserId: APPLICANT_USER_ID,
      jobId: JOB_ID,
    }).then(
      () => {
        throw new Error('expected applyToJob to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(IncompleteProfileError);
    const incomplete = error as InstanceType<typeof IncompleteProfileError>;
    expect(incomplete.percentage).toBeLessThan(80);
    expect(incomplete.missingFields.length).toBeGreaterThan(0);
    // The slot keys are the canonical ones from the completeness
    // helper. We assert membership rather than exact ordering so the
    // test does not break if the helper re-orders.
    expect(incomplete.missingFields).toEqual(
      expect.arrayContaining(['address', 'city', 'province', 'summary']),
    );
  });
});

// ---------------------------------------------------------------------------
// MissingCvError when no active CV
// ---------------------------------------------------------------------------

describe('applyToJob — active CV gate', () => {
  it('rejects with MissingCvError when the applicant has no active CV', async () => {
    findJobByIdMock.mockResolvedValueOnce(publishedJob());

    installFakeTransaction([
      {
        match: /FROM applicants a/,
        // cv_id null → service short-circuits with MissingCvError
        // BEFORE the education / experience reads.
        response: [
          [completeApplicantSnapshot({ cv_id: null })] as RowDataPacket[],
          [],
        ],
      },
    ]);

    await expect(
      applyToJob({
        applicantUserId: APPLICANT_USER_ID,
        jobId: JOB_ID,
      }),
    ).rejects.toBeInstanceOf(MissingCvError);
  });

  it('rejects with MissingCvError when the applicants row is missing entirely', async () => {
    findJobByIdMock.mockResolvedValueOnce(publishedJob());

    installFakeTransaction([
      {
        match: /FROM applicants a/,
        response: [[] as RowDataPacket[], []],
      },
    ]);

    await expect(
      applyToJob({
        applicantUserId: APPLICANT_USER_ID,
        jobId: JOB_ID,
      }),
    ).rejects.toBeInstanceOf(MissingCvError);
  });
});

// ---------------------------------------------------------------------------
// JobUnavailableError — not Published / deadline passed
// ---------------------------------------------------------------------------

describe('applyToJob — job availability gate', () => {
  it('rejects with JobUnavailableError when the job status is not Published', async () => {
    findJobByIdMock.mockResolvedValueOnce(publishedJob({ status: 'Draft' }));

    await expect(
      applyToJob({
        applicantUserId: APPLICANT_USER_ID,
        jobId: JOB_ID,
      }),
    ).rejects.toBeInstanceOf(JobUnavailableError);
    // No transaction was opened — the job check fails fast.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects with JobUnavailableError when the application deadline has passed', async () => {
    findJobByIdMock.mockResolvedValueOnce(
      publishedJob({ application_deadline: '2000-01-01' }),
    );

    await expect(
      applyToJob({
        applicantUserId: APPLICANT_USER_ID,
        jobId: JOB_ID,
      }),
    ).rejects.toBeInstanceOf(JobUnavailableError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects with JobUnavailableError when the job does not exist at all', async () => {
    findJobByIdMock.mockResolvedValueOnce(null);

    await expect(
      applyToJob({
        applicantUserId: APPLICANT_USER_ID,
        jobId: JOB_ID,
      }),
    ).rejects.toBeInstanceOf(JobUnavailableError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DuplicateApplicationError on uk_app_applicant_job collision
// ---------------------------------------------------------------------------

describe('applyToJob — duplicate guard', () => {
  it('translates ER_DUP_ENTRY on uk_app_applicant_job into DuplicateApplicationError', async () => {
    findJobByIdMock.mockResolvedValueOnce(publishedJob());

    const dupErr = Object.assign(
      new Error(
        "Duplicate entry '42-7' for key 'applications.uk_app_applicant_job'",
      ),
      { code: 'ER_DUP_ENTRY' },
    );

    installFakeTransaction([
      {
        match: /FROM applicants a/,
        response: [
          [completeApplicantSnapshot()] as RowDataPacket[],
          [],
        ],
      },
      {
        match: /FROM applicant_education/,
        response: [[{ '1': 1 }] as unknown as RowDataPacket[], []],
      },
      {
        match: /FROM applicant_experience/,
        response: [[{ '1': 1 }] as unknown as RowDataPacket[], []],
      },
      {
        match: /FROM applications\s+WHERE reference_no LIKE/,
        response: [[{ n: 0 } as unknown as RowDataPacket], []],
      },
      {
        match: /INSERT INTO applications/,
        response: { throws: dupErr },
      },
    ]);

    await expect(
      applyToJob({
        applicantUserId: APPLICANT_USER_ID,
        jobId: JOB_ID,
      }),
    ).rejects.toBeInstanceOf(DuplicateApplicationError);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('applyToJob — happy path', () => {
  it('inserts at stage Applied, threads source, and emits the audit log line', async () => {
    findJobByIdMock.mockResolvedValueOnce(publishedJob());

    let insertParams: unknown[] | undefined;

    const { calls } = installFakeTransaction([
      {
        match: /FROM applicants a/,
        response: [
          [completeApplicantSnapshot()] as RowDataPacket[],
          [],
        ],
      },
      {
        match: /FROM applicant_education/,
        response: [[{ '1': 1 }] as unknown as RowDataPacket[], []],
      },
      {
        match: /FROM applicant_experience/,
        response: [[{ '1': 1 }] as unknown as RowDataPacket[], []],
      },
      {
        match: /FROM applications\s+WHERE reference_no LIKE/,
        response: [[{ n: 122 } as unknown as RowDataPacket], []],
      },
      {
        match: /INSERT INTO applications/,
        response: (params) => {
          insertParams = params;
          return [makeHeader(INSERTED_APPLICATION_ID), []];
        },
      },
      {
        match: /INSERT INTO application_stage_history/,
        response: [makeHeader(1, 1), []],
      },
    ]);

    const result = await applyToJob({
      applicantUserId: APPLICANT_USER_ID,
      jobId: JOB_ID,
      sourceParam: 'search',
    });

    // Result shape is correct.
    expect(result.id).toBe(INSERTED_APPLICATION_ID);
    expect(typeof result.uuid).toBe('string');
    expect(result.uuid.length).toBe(36); // crypto.randomUUID
    expect(result.referenceNo).toMatch(/^APP-\d{4}-000123$/);
    expect(result.source).toBe('search');

    // INSERT carried the right values: uuid, referenceNo,
    // applicantUserId, jobId, cvFileId, source.
    expect(insertParams).toBeDefined();
    expect(insertParams![0]).toBe(result.uuid);
    expect(insertParams![1]).toBe(result.referenceNo);
    expect(insertParams![2]).toBe(APPLICANT_USER_ID);
    expect(insertParams![3]).toBe(JOB_ID);
    expect(insertParams![4]).toBe(CV_FILE_ID);
    expect(insertParams![5]).toBe('search');

    // Stage='Applied' is hard-coded into the SQL — verify the SQL
    // string that ran carries it.
    const insertCall = calls.find((c) =>
      /INSERT INTO applications/.test(c.sql),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toMatch(/'Applied'/);

    // Audit log was emitted via logger.info. The first arg is the
    // structured payload; the second is the message.
    expect(loggerInfoSpy).toHaveBeenCalled();
    const lastCall = loggerInfoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event === 'application_submitted',
    );
    expect(lastCall).toBeDefined();
    const payload = lastCall![0] as Record<string, unknown>;
    expect(payload.application_id).toBe(INSERTED_APPLICATION_ID);
    expect(payload.applicant_user_id).toBe(APPLICANT_USER_ID);
    expect(payload.job_id).toBe(JOB_ID);
    expect(payload.reference_no).toBe(result.referenceNo);
    expect(payload.source).toBe('search');
  });

  it('threads an unrecognised ?ref= value as "unknown"', async () => {
    findJobByIdMock.mockResolvedValueOnce(publishedJob());

    let insertParams: unknown[] | undefined;
    installFakeTransaction([
      {
        match: /FROM applicants a/,
        response: [[completeApplicantSnapshot()] as RowDataPacket[], []],
      },
      {
        match: /FROM applicant_education/,
        response: [[{ '1': 1 }] as unknown as RowDataPacket[], []],
      },
      {
        match: /FROM applicant_experience/,
        response: [[{ '1': 1 }] as unknown as RowDataPacket[], []],
      },
      {
        match: /FROM applications\s+WHERE reference_no LIKE/,
        response: [[{ n: 0 } as unknown as RowDataPacket], []],
      },
      {
        match: /INSERT INTO applications/,
        response: (params) => {
          insertParams = params;
          return [makeHeader(INSERTED_APPLICATION_ID), []];
        },
      },
      {
        match: /INSERT INTO application_stage_history/,
        response: [makeHeader(1, 1), []],
      },
    ]);

    const result = await applyToJob({
      applicantUserId: APPLICANT_USER_ID,
      jobId: JOB_ID,
      sourceParam: 'instagram-promo',
    });

    expect(result.source).toBe('unknown');
    expect(insertParams![5]).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Argument validation (defensive)
// ---------------------------------------------------------------------------

describe('applyToJob — argument validation', () => {
  it('rejects a non-positive applicantUserId synchronously', async () => {
    await expect(
      applyToJob({ applicantUserId: 0, jobId: JOB_ID }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(findJobByIdMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive jobId synchronously', async () => {
    await expect(
      applyToJob({ applicantUserId: APPLICANT_USER_ID, jobId: -3 }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(findJobByIdMock).not.toHaveBeenCalled();
  });
});
