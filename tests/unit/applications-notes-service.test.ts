/**
 * Unit tests for `src/modules/applications/notes-service.ts`
 * (task 30.1 — Application notes endpoint).
 *
 * Validates: Requirements 10.3, 8.2 (Design §6 Admin — notes)
 *
 * Coverage:
 *   - `addNote` for an INTERNAL note (visibleToApplicant=false): inserts
 *     with `visible_to_applicant=0`, does NOT enqueue a notification,
 *     emits the audit log line.
 *   - `addNote` for a VISIBLE note (true): inserts and ATTEMPTS the
 *     notification enqueue across the mail boundary (Req 8.2).
 *   - Rejects with `InvalidNoteInputError` for an empty / whitespace
 *     body, and for a body over the column width.
 *   - Rejects with `ApplicationNotFoundError` when the application's job
 *     is out of the Department_Head scope (job lookup → null) and when
 *     the application row itself is missing (no row leak).
 *
 * Boundaries mocked:
 *   1. `src/infra/db.ts`                  — `query()` feeds the
 *      `loadApplication` SELECT and (when not mocking the repo) the
 *      INSERT + read-back. Here we drive `insertNote` through the db
 *      boundary so the repo's real logic runs.
 *   2. `src/modules/jobs/repo.ts`         — `findById` decides whether
 *      the application's job is in scope.
 *   3. `src/infra/logger.ts`              — capture the audit log line.
 *   4. `src/modules/mail/service.ts`      — expose the forward-compatible
 *      `enqueueNoteNotification` hook so we can assert the visible-note
 *      path attempts the notification email (Req 8.2).
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
// module for an `enqueueNoteNotification` export and uses it when
// present; we surface it as a spy so the visible-note test can assert the
// notification email is attempted (Req 8.2).
const enqueueNoteNotificationMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
  enqueueNoteNotification: enqueueNoteNotificationMock,
}));

// Import after the mocks register.
const serviceModule = await import(
  '../../src/modules/applications/notes-service.js'
);
const { addNote, ApplicationNotFoundError, InvalidNoteInputError } =
  serviceModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLICATION_ID = 555;
const JOB_ID = 42;
const AUTHOR_USER_ID = 7;
const NOTE_ID = 8001;

/** Seed the `loadApplication` SELECT so the service finds the row. */
function seedApplicationRow(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: APPLICATION_ID,
      job_id: JOB_ID,
    } as unknown as RowDataPacket,
  ]);
}

/** A minimal in-scope job stand-in returned by `findJobById`. */
function inScopeJob() {
  return { id: JOB_ID, slug: 'senior-fe-engineer', status: 'Published' };
}

/**
 * Seed the repo's INSERT + read-back so `insertNote` (run through the
 * real repo against the mocked db boundary) returns a well-formed row.
 *
 * The repo issues an INSERT (ResultSetHeader with insertId) followed by a
 * SELECT-by-id read-back.
 */
function seedNoteInsert(visibleToApplicant: boolean): void {
  // INSERT → ResultSetHeader-shaped object with the new id.
  queryMock.mockResolvedValueOnce({
    insertId: NOTE_ID,
    affectedRows: 1,
  } as unknown as RowDataPacket);
  // Read-back SELECT.
  queryMock.mockResolvedValueOnce([
    {
      id: NOTE_ID,
      application_id: APPLICATION_ID,
      author_user_id: AUTHOR_USER_ID,
      body: 'Strong candidate, advancing to screening.',
      visible_to_applicant: visibleToApplicant ? 1 : 0,
      created_at: new Date('2025-06-01T00:00:00.000Z'),
    } as unknown as RowDataPacket,
  ]);
}

beforeEach(() => {
  queryMock.mockReset();
  findJobByIdMock.mockReset();
  loggerInfoSpy.mockReset();
  loggerErrorSpy.mockReset();
  enqueueNoteNotificationMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path — internal note (visibleToApplicant=false)
// ---------------------------------------------------------------------------

describe('addNote — internal note', () => {
  it('inserts with visible_to_applicant=0, does NOT enqueue, and audits', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());
    seedNoteInsert(false);

    const note = await addNote({
      applicationId: APPLICATION_ID,
      authorUserId: AUTHOR_USER_ID,
      scope: undefined,
      input: {
        body: 'Strong candidate, advancing to screening.',
        visibleToApplicant: false,
      },
    });

    // Returns the persisted row.
    expect(note.id).toBe(NOTE_ID);
    expect(note.visible_to_applicant).toBe(false);

    // The INSERT received `0` for the TINYINT flag.
    const insertCall = queryMock.mock.calls.find((call) =>
      /INSERT INTO application_notes/.test(String(call[0])),
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as unknown[];
    // params: [applicationId, authorUserId, body, visible_to_applicant]
    expect(insertParams[3]).toBe(0);

    // Internal notes never enqueue a notification.
    expect(enqueueNoteNotificationMock).not.toHaveBeenCalled();

    // Audit log line emitted via logger.info.
    const auditCall = loggerInfoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event === 'application_note_added',
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBe(AUTHOR_USER_ID);
    expect(payload.application_id).toBe(APPLICATION_ID);
    expect(payload.note_id).toBe(NOTE_ID);
    expect(payload.visible_to_applicant).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy path — visible note (visibleToApplicant=true)
// ---------------------------------------------------------------------------

describe('addNote — visible note', () => {
  it('inserts with visible_to_applicant=1 and ATTEMPTS the notification enqueue (Req 8.2)', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());
    seedNoteInsert(true);

    const note = await addNote({
      applicationId: APPLICATION_ID,
      authorUserId: AUTHOR_USER_ID,
      scope: undefined,
      // HTML checkbox posts 'on' when checked; the schema coerces it.
      input: {
        body: 'Strong candidate, advancing to screening.',
        visibleToApplicant: 'on',
      },
    });

    expect(note.visible_to_applicant).toBe(true);

    // The INSERT received `1` for the TINYINT flag.
    const insertCall = queryMock.mock.calls.find((call) =>
      /INSERT INTO application_notes/.test(String(call[0])),
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as unknown[];
    expect(insertParams[3]).toBe(1);

    // The note-notification email was attempted across the mail boundary.
    expect(enqueueNoteNotificationMock).toHaveBeenCalledTimes(1);
    const mailCtx = enqueueNoteNotificationMock.mock.calls[0]![0] as {
      applicationId: number;
      noteId: number;
      body: string;
    };
    expect(mailCtx.applicationId).toBe(APPLICATION_ID);
    expect(mailCtx.noteId).toBe(NOTE_ID);
    // Non-truncated excerpt (Req 8.2): the full body is forwarded.
    expect(mailCtx.body).toBe('Strong candidate, advancing to screening.');
  });
});

// ---------------------------------------------------------------------------
// Validation — empty / oversized body
// ---------------------------------------------------------------------------

describe('addNote — body validation', () => {
  it('rejects a whitespace-only body with InvalidNoteInputError', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());

    const error = await addNote({
      applicationId: APPLICATION_ID,
      authorUserId: AUTHOR_USER_ID,
      input: { body: '    \n\t  ', visibleToApplicant: false },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidNoteInputError);
    const invalid = error as InstanceType<typeof InvalidNoteInputError>;
    expect(invalid.statusCode).toBe(422);
    expect(invalid.fieldErrors.body).toBeDefined();
    // No INSERT for an invalid note.
    const insertCall = queryMock.mock.calls.find((call) =>
      /INSERT INTO application_notes/.test(String(call[0])),
    );
    expect(insertCall).toBeUndefined();
  });

  it('rejects a body over 5000 characters with InvalidNoteInputError', async () => {
    seedApplicationRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());

    const error = await addNote({
      applicationId: APPLICATION_ID,
      authorUserId: AUTHOR_USER_ID,
      input: { body: 'x'.repeat(5001), visibleToApplicant: false },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidNoteInputError);
    const invalid = error as InstanceType<typeof InvalidNoteInputError>;
    expect(invalid.fieldErrors.body).toBeDefined();
    expect(invalid.fieldErrors.body?.join(' ')).toMatch(/5000/);
  });
});

// ---------------------------------------------------------------------------
// Authorization — out-of-scope / missing application
// ---------------------------------------------------------------------------

describe('addNote — scope enforcement', () => {
  it('rejects with ApplicationNotFoundError when the job is out of the Department_Head scope', async () => {
    seedApplicationRow();
    // findJobById collapses an out-of-scope row to null.
    findJobByIdMock.mockResolvedValueOnce(null);

    await expect(
      addNote({
        applicationId: APPLICATION_ID,
        authorUserId: AUTHOR_USER_ID,
        scope: { departments: [99] }, // does not include the job's dept
        input: { body: 'note', visibleToApplicant: false },
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // The scope was threaded into the job lookup.
    expect(findJobByIdMock).toHaveBeenCalledWith(JOB_ID, { departments: [99] });
    // No INSERT for an out-of-scope application.
    const insertCall = queryMock.mock.calls.find((call) =>
      /INSERT INTO application_notes/.test(String(call[0])),
    );
    expect(insertCall).toBeUndefined();
  });

  it('rejects with ApplicationNotFoundError when the application row does not exist', async () => {
    // loadApplication returns no rows.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    await expect(
      addNote({
        applicationId: APPLICATION_ID,
        authorUserId: AUTHOR_USER_ID,
        input: { body: 'note', visibleToApplicant: false },
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // The job lookup is never reached when the application is missing.
    expect(findJobByIdMock).not.toHaveBeenCalled();
  });
});
