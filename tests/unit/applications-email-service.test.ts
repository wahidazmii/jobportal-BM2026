/**
 * Unit tests for `src/modules/applications/email-service.ts`
 * (task 30.3 — Templated email send).
 *
 * Validates: Requirements 10.7 (Design §6 Admin, §12.3 — render + enqueue)
 *
 * Coverage:
 *   - Happy path: resolves the template, renders the
 *     `{applicant_name, job_title, stage}` placeholders into the subject
 *     and body, enqueues across the mail boundary (with templateKey,
 *     toEmail, and a context carrying the placeholder values), audits via
 *     `logger.info`, and returns `{ templateKey, toEmail }`.
 *   - Unknown template → `MailTemplateNotFoundError`.
 *   - Invalid input (empty templateKey) → `InvalidEmailInputError`.
 *   - Out-of-scope application → `ApplicationNotFoundError`.
 *   - Missing application → `ApplicationNotFoundError`.
 *
 * Boundaries mocked:
 *   1. `src/infra/db.ts`             — `query()` feeds the application
 *      context SELECT and the `mail_templates` SELECT; `withTransaction`
 *      runs its callback with a fake connection so the enqueue path
 *      executes.
 *   2. `src/modules/jobs/repo.ts`    — `findById` decides whether the
 *      application's job is in scope.
 *   3. `src/infra/logger.ts`         — capture the audit log line.
 *   4. `src/modules/mail/service.ts` — assert the templated email is
 *      enqueued (Req 10.7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const queryMock = vi.fn();
const withTransactionMock = vi.fn();
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
const loggerDebugSpy = vi.fn();
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
      debug: loggerDebugSpy,
      trace: vi.fn(),
    },
  };
});

const enqueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: enqueueMock,
}));

// Import after the mocks register.
const serviceModule = await import(
  '../../src/modules/applications/email-service.js'
);
const {
  sendTemplatedEmail,
  ApplicationNotFoundError,
  InvalidEmailInputError,
  MailTemplateNotFoundError,
} = serviceModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLICATION_ID = 555;
const JOB_ID = 42;
const ACTOR_USER_ID = 7;
const APPLICANT_NAME = 'Budi Santoso';
const TO_EMAIL = 'budi@example.com';
const STAGE = 'Interview';
const JOB_TITLE = 'Insinyur Frontend Senior';
const TEMPLATE_KEY = 'stage_change';

/** A fake transaction connection — the enqueue stub ignores it. */
const FAKE_CONN = { execute: vi.fn() } as unknown;

/**
 * Seed the application-context SELECT so the service resolves the row
 * with the requested-locale title present (no fallback query needed).
 */
function seedApplicationContextRow(
  options: { titleRequested?: string | null } = {},
): void {
  queryMock.mockResolvedValueOnce([
    {
      application_id: APPLICATION_ID,
      job_id: JOB_ID,
      stage: STAGE,
      applicant_name: APPLICANT_NAME,
      to_email: TO_EMAIL,
      title_requested:
        options.titleRequested === undefined
          ? JOB_TITLE
          : options.titleRequested,
    } as unknown as RowDataPacket,
  ]);
}

/** Seed the `mail_templates` SELECT with a row that uses all placeholders. */
function seedMailTemplateRow(): void {
  queryMock.mockResolvedValueOnce([
    {
      subject: 'Update for {{ applicant_name }}: {{ job_title }}',
      body_html:
        '<p>Hi {{ applicant_name }}, your application for ' +
        '{{ job_title }} is now at stage {{ stage }}.</p>',
      body_text:
        'Hi {{ applicant_name }}, stage: {{ stage }} for {{ job_title }}.',
    } as unknown as RowDataPacket,
  ]);
}

/** A minimal in-scope job stand-in returned by `findJobById`. */
function inScopeJob() {
  return { id: JOB_ID, slug: 'senior-fe-engineer', status: 'Published' };
}

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
  findJobByIdMock.mockReset();
  loggerInfoSpy.mockReset();
  loggerErrorSpy.mockReset();
  loggerDebugSpy.mockReset();
  enqueueMock.mockClear();
  // Default: run the transaction callback with the fake connection.
  withTransactionMock.mockImplementation(
    async (fn: (conn: unknown) => Promise<unknown>) => fn(FAKE_CONN),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('sendTemplatedEmail — happy path', () => {
  it('renders placeholders, enqueues with context, audits, and returns identifiers', async () => {
    seedApplicationContextRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());
    seedMailTemplateRow();

    const result = await sendTemplatedEmail({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      scope: undefined,
      input: { templateKey: TEMPLATE_KEY, locale: 'id' },
    });

    // Returns the resolved identifiers.
    expect(result).toEqual({ templateKey: TEMPLATE_KEY, toEmail: TO_EMAIL });

    // The enqueue was attempted inside a transaction.
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    const [conn, enqueueOptions] = enqueueMock.mock.calls[0]!;
    expect(conn).toBe(FAKE_CONN);
    expect(enqueueOptions.templateKey).toBe(TEMPLATE_KEY);
    expect(enqueueOptions.toEmail).toBe(TO_EMAIL);
    expect(enqueueOptions.locale).toBe('id');
    expect(enqueueOptions.targetId).toBe(String(APPLICATION_ID));
    // The placeholder context is carried through so the flusher
    // re-renders from the same input (Design §12.3).
    expect(enqueueOptions.context).toEqual({
      applicant_name: APPLICANT_NAME,
      job_title: JOB_TITLE,
      stage: STAGE,
    });

    // The preview render produced non-empty subject/body lengths.
    const previewCall = loggerDebugSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event ===
          'application_email_preview_rendered',
    );
    expect(previewCall).toBeDefined();
    const preview = previewCall![0] as Record<string, number>;
    expect(preview.subject_length).toBeGreaterThan(0);
    expect(preview.body_html_length).toBeGreaterThan(0);
    expect(preview.body_text_length).toBeGreaterThan(0);

    // Audit log line emitted via logger.info.
    const auditCall = loggerInfoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event === 'application_email_sent',
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBe(ACTOR_USER_ID);
    expect(payload.application_id).toBe(APPLICATION_ID);
    expect(payload.template_key).toBe(TEMPLATE_KEY);
  });

  it('falls back to the other-locale title when the requested-locale title is empty', async () => {
    // Requested-locale title null → triggers the fallback title query.
    seedApplicationContextRow({ titleRequested: null });
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());
    // Fallback title lookup returns the en title.
    queryMock.mockResolvedValueOnce([
      { locale: 'en', title: 'Senior Frontend Engineer' } as unknown as RowDataPacket,
    ]);
    seedMailTemplateRow();

    const result = await sendTemplatedEmail({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      input: { templateKey: TEMPLATE_KEY, locale: 'id' },
    });

    expect(result.toEmail).toBe(TO_EMAIL);
    const enqueueOptions = enqueueMock.mock.calls[0]![1];
    expect(enqueueOptions.context.job_title).toBe('Senior Frontend Engineer');
  });
});

// ---------------------------------------------------------------------------
// Unknown template
// ---------------------------------------------------------------------------

describe('sendTemplatedEmail — unknown template', () => {
  it('rejects with MailTemplateNotFoundError when no template row matches', async () => {
    seedApplicationContextRow();
    findJobByIdMock.mockResolvedValueOnce(inScopeJob());
    // mail_templates SELECT returns no rows.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    const error = await sendTemplatedEmail({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      input: { templateKey: 'does_not_exist', locale: 'id' },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(MailTemplateNotFoundError);
    const notFound = error as InstanceType<typeof MailTemplateNotFoundError>;
    expect(notFound.statusCode).toBe(422);
    expect(notFound.code).toBe('unknown_template');
    // No enqueue for a missing template.
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

describe('sendTemplatedEmail — input validation', () => {
  it('rejects an empty templateKey with InvalidEmailInputError before any query', async () => {
    const error = await sendTemplatedEmail({
      applicationId: APPLICATION_ID,
      actorUserId: ACTOR_USER_ID,
      input: { templateKey: '   ', locale: 'id' },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidEmailInputError);
    const invalid = error as InstanceType<typeof InvalidEmailInputError>;
    expect(invalid.statusCode).toBe(422);
    expect(invalid.fieldErrors.templateKey).toBeDefined();
    // Input is validated first, so no DB query and no enqueue fire.
    expect(queryMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement / missing application
// ---------------------------------------------------------------------------

describe('sendTemplatedEmail — scope enforcement', () => {
  it('rejects with ApplicationNotFoundError when the job is out of the Department_Head scope', async () => {
    seedApplicationContextRow();
    // findJobById collapses an out-of-scope row to null.
    findJobByIdMock.mockResolvedValueOnce(null);

    await expect(
      sendTemplatedEmail({
        applicationId: APPLICATION_ID,
        actorUserId: ACTOR_USER_ID,
        scope: { departments: [99] }, // does not include the job's dept
        input: { templateKey: TEMPLATE_KEY, locale: 'id' },
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // The scope was threaded into the job lookup.
    expect(findJobByIdMock).toHaveBeenCalledWith(JOB_ID, { departments: [99] });
    // No template lookup and no enqueue for an out-of-scope application.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects with ApplicationNotFoundError when the application row does not exist', async () => {
    // Application-context SELECT returns no rows.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    await expect(
      sendTemplatedEmail({
        applicationId: APPLICATION_ID,
        actorUserId: ACTOR_USER_ID,
        input: { templateKey: TEMPLATE_KEY, locale: 'id' },
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    // The job lookup is never reached when the application is missing.
    expect(findJobByIdMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
