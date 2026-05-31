/**
 * Unit tests for `src/modules/applications/interviews-service.ts`
 * (task 30.2 — Schedule interview).
 *
 * Validates: Requirements 10.4 (Design §6 Admin — Schedule interview)
 *
 * Coverage:
 *   - `scheduleInterviewForApplication` rejects with
 *     `InvalidInterviewInputError` when `scheduledAt` is in the past
 *     (clock pinned via the `now` option, which the service threads
 *     into `buildScheduleInterviewSchema`).
 *   - Rejects with `InvalidInterviewInputError` when BOTH `location`
 *     and `meetingUrl` are missing (an interview with no way to meet).
 *   - Rejects with `ApplicationNotFoundError` when the application's
 *     job is outside the Department_Head scope (the job lookup
 *     collapses to `null`, which becomes a 404-shaped error — no row
 *     leak).
 *   - Happy path: returns the persisted interview row, emits the
 *     audit log line via `logger.info`, and attempts the mail enqueue
 *     across the (mocked) mail boundary.
 *
 * Boundaries mocked:
 *   1. `src/infra/db.ts`                  — `query()` feeds the
 *      `loadApplication` SELECT round-trip.
 *   2. `src/modules/jobs/repo.ts`         — `findById` decides whether
 *      the application's job is in scope.
 *   3. `src/modules/applications/interviews-repo.ts` — `scheduleInterview`
 *      stands in for the INSERT + read-back so the suite is hermetic.
 *   4. `src/infra/logger.ts`              — capture the audit log line.
 *   5. `src/modules/mail/service.ts`      — expose the forward-compatible
 *      `enqueueInterviewInvitation` hook so we can assert the service
 *      attempts to enqueue the invitation email (Req 10.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const queryMock = vi.fn();
vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: vi.fn(),
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

const scheduleInterviewMock = vi.fn();
vi.mock('../../src/modules/applications/interviews-repo.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/applications/interviews-repo.js')
  >('../../src/modules/applications/interviews-repo.js');
  return {
    ...actual,
    scheduleInterview: scheduleInterviewMock,
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

// Forward-compatible mail hook (task 36.1). The service probes the mail
// module for an `enqueueInterviewInvitation` export and uses it when
// present; we surface it as a spy so the happy-path test can assert the
// invitation email is attempted.
const enqueueInterviewInvitationMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
  enqueueInterviewInvitation: enqueueInterviewInvitationMock,
}));

// Import after the mocks register.
const serviceModule = await import(
  '../../src/modules/applications/interviews-service.js'
);
const {
  scheduleInterviewForApplication,
  ApplicationNotFoundError,
  InvalidInterviewInputError,
} = serviceModule;

import type { InterviewRow } from '../../src/modules/applications/interviews-repo.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLICATION_ID = 555;
const JOB_ID = 42;
const ACTOR_USER_ID = 7;
const INTERVIEW_ID = 9001;

/** Deterministic "now" so the future-date refinement is stable. */
const FIXED_NOW = new Date('2025-06-01T00:00:00.000Z');
const FUTURE_AT = '2025-06-10T09:30:00.000Z';
const PAST_AT = '2025-01-01T09:30:00.000Z';

/**
 * Seed the `query()` response for the `loadApplication` SELECT so the
 * service proceeds past the application-existence check.
 */
function seedApplicationRow(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: APPLICATION_ID,
      job_id: JOB_ID,
      applicant_user_id: 321,
      reference_no: 'APP-2025-000555',
    } as unknown as RowDataPacket,
  ]);
}

/** A minimal in-scope job stand-in returned by `findJobById`. */
function inScopeJob() {
  return { id: JOB_ID, slug: 'senior-fe-engineer', status: 'Published' };
}

/** Build the persisted interview row the repo would read back. */
function persistedInterview(
  overrides: Partial<InterviewRow> = {},
): InterviewRow {
  return {
    id: INTERVIEW_ID,
    application_id: APPLICATION_ID,
    scheduled_at: new Date(FUTURE_AT),
    location: 'HQ Meeting Room 3',
    meeting_url: null,
    interviewer_user_id: 12,
    status: 'scheduled',
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
  findJobByIdMock.mockReset();
  scheduleInterviewMock.mockReset();
  loggerInfoSpy.mockReset();
  loggerErrorSpy.mockReset();
  enqueueInterviewInvitationMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Validation: scheduledAt in the past
// ---------------------------------------------------------------------------

describe('scheduleInterviewForApplication — past scheduledAt', () => {
  it('rejects with InvalidInterviewInputError when scheduledAt is in the past', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());

    const error = await scheduleInterviewForApplication({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      scope: undefined,
      now: FIXED_NOW,
      input: { scheduledAt: PAST_AT, location: 'HQ Room 1' },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidInterviewInputError);
    const invalid = error as InstanceType<typeof InvalidInterviewInputError>;
    expect(invalid.statusCode).toBe(422);
    expect(invalid.fieldErrors.scheduledAt).toBeDefined();
    expect(invalid.fieldErrors.scheduledAt?.join(' ')).toMatch(/future/i);
    // The INSERT must never have been attempted on a rejected input.
    expect(scheduleInterviewMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Validation: neither location nor meetingUrl
// ---------------------------------------------------------------------------

describe('scheduleInterviewForApplication — missing meeting details', () => {
  it('rejects with InvalidInterviewInputError when both location and meetingUrl are missing', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());

    const error = await scheduleInterviewForApplication({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      now: FIXED_NOW,
      // Future date is fine; the cross-field refinement should still
      // reject because there is no way to actually hold the interview.
      input: { scheduledAt: FUTURE_AT },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidInterviewInputError);
    const invalid = error as InstanceType<typeof InvalidInterviewInputError>;
    expect(invalid.statusCode).toBe(422);
    // The refinement maps onto the `location` path.
    expect(invalid.fieldErrors.location).toBeDefined();
    expect(scheduleInterviewMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Authorization: out-of-scope application (Department_Head)
// ---------------------------------------------------------------------------

describe('scheduleInterviewForApplication — scope enforcement', () => {
  it('rejects with ApplicationNotFoundError when the job is outside the Department_Head scope', async () => {
    seedApplicationRow();
    // findJobById collapses an out-of-scope row to null.
    findJobByIdMock.mockResolvedValueOnce(null);

    await expect(
      scheduleInterviewForApplication({
        applicationId: APPLICATION_ID,
        actorUserId: ACTOR_USER_ID,
        scope: { departments: [99] }, // does not include the job's dept
        now: FIXED_NOW,
        input: { scheduledAt: FUTURE_AT, location: 'HQ Room 1' },
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // The scope was threaded into the job lookup.
    expect(findJobByIdMock).toHaveBeenCalledWith(JOB_ID, {
      departments: [99],
    });
    // No INSERT for an out-of-scope application.
    expect(scheduleInterviewMock).not.toHaveBeenCalled();
  });

  it('rejects with ApplicationNotFoundError when the application row does not exist', async () => {
    // loadApplication returns no rows.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    await expect(
      scheduleInterviewForApplication({
        applicationId: APPLICATION_ID,
        actorUserId: ACTOR_USER_ID,
        now: FIXED_NOW,
        input: { scheduledAt: FUTURE_AT, location: 'HQ Room 1' },
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // The job lookup is never reached when the application is missing.
    expect(findJobByIdMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('scheduleInterviewForApplication — happy path', () => {
  it('returns the interview row, emits the audit log line, and attempts the mail enqueue', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());
    const row = persistedInterview();
    scheduleInterviewMock.mockResolvedValueOnce(row);

    const result = await scheduleInterviewForApplication({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      scope: undefined,
      now: FIXED_NOW,
      input: {
        scheduledAt: FUTURE_AT,
        location: 'HQ Meeting Room 3',
        interviewerUserId: '12',
      },
    });

    // Result carries the persisted row + the application id.
    expect(result.interview).toEqual(row);
    expect(result.applicationId).toBe(APPLICATION_ID);

    // The repo INSERT received the parsed, coerced values.
    expect(scheduleInterviewMock).toHaveBeenCalledTimes(1);
    const insertArg = scheduleInterviewMock.mock.calls[0]![0] as {
      applicationId: number;
      scheduledAt: Date;
      location: string | null;
      meetingUrl: string | null;
      interviewerUserId: number | null;
    };
    expect(insertArg.applicationId).toBe(APPLICATION_ID);
    expect(insertArg.scheduledAt).toBeInstanceOf(Date);
    expect(insertArg.scheduledAt.toISOString()).toBe(FUTURE_AT);
    expect(insertArg.location).toBe('HQ Meeting Room 3');
    expect(insertArg.meetingUrl).toBeNull();
    expect(insertArg.interviewerUserId).toBe(12);

    // Audit log line emitted via logger.info.
    const auditCall = loggerInfoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event === 'interview_scheduled',
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBe(ACTOR_USER_ID);
    expect(payload.application_id).toBe(APPLICATION_ID);
    expect(payload.interview_id).toBe(INTERVIEW_ID);
    expect(payload.reference_no).toBe('APP-2025-000555');

    // The interview-invitation email was attempted across the mail
    // boundary (Req 10.4 — "send an interview invitation email").
    expect(enqueueInterviewInvitationMock).toHaveBeenCalledTimes(1);
    const mailCtx = enqueueInterviewInvitationMock.mock.calls[0]![0] as {
      applicationId: number;
      interviewId: number;
    };
    expect(mailCtx.applicationId).toBe(APPLICATION_ID);
    expect(mailCtx.interviewId).toBe(INTERVIEW_ID);
  });

  it('does not unwind the committed interview when the mail enqueue fails', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());
    const row = persistedInterview({ location: null, meeting_url: 'https://meet.example.com/abc' });
    scheduleInterviewMock.mockResolvedValueOnce(row);
    enqueueInterviewInvitationMock.mockRejectedValueOnce(
      new Error('smtp boundary unavailable'),
    );

    // The call still resolves — the row is already committed and the
    // email is best-effort.
    const result = await scheduleInterviewForApplication({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      now: FIXED_NOW,
      input: { scheduledAt: FUTURE_AT, meetingUrl: 'https://meet.example.com/abc' },
    });

    expect(result.interview).toEqual(row);
    // The failure surfaced in the error log for an operator to re-enqueue.
    const mailFail = loggerErrorSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event ===
          'interview_mail_enqueue_failed',
    );
    expect(mailFail).toBeDefined();
  });
});
