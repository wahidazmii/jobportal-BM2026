/**
 * Unit tests for `src/modules/mail/templates-service.ts`
 * (task 36.2 — Templated mail editor di admin).
 *
 * Validates: Requirements 10.7, 12.1 (Design §6 Admin, §15 Audit)
 *
 * Coverage:
 *   - `saveTemplate` happy path: validates → upserts via the repo →
 *     emits the `mail_template_change` audit log line → returns the
 *     persisted record.
 *   - `saveTemplate` validation: rejects an empty subject, a bad locale,
 *     and a key over the column width with `InvalidTemplateInputError`
 *     (422) — and never reaches the upsert.
 *   - `listAll` / `getOne` pass straight through to the repo.
 *
 * Boundaries mocked:
 *   1. `src/modules/mail/templates-repo.ts` — `upsertTemplate`,
 *      `listTemplates`, `findTemplate` so the service logic runs against
 *      a controllable persistence layer.
 *   2. `src/infra/logger.ts`                — capture the audit log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const upsertTemplateMock = vi.fn();
const listTemplatesMock = vi.fn();
const findTemplateMock = vi.fn();
vi.mock('../../src/modules/mail/templates-repo.js', () => ({
  upsertTemplate: upsertTemplateMock,
  listTemplates: listTemplatesMock,
  findTemplate: findTemplateMock,
}));

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

// Import after the mocks register.
const { saveTemplate, listAll, getOne, InvalidTemplateInputError } =
  await import('../../src/modules/mail/templates-service.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR_USER_ID = 7;

/** A persisted record stand-in returned by `upsertTemplate`. */
function persistedRecord(overrides: Record<string, unknown> = {}) {
  return {
    key: 'application_confirm',
    locale: 'id',
    subject: 'Lamaran Anda diterima',
    body_html: '<p>Halo {{ applicant_name }}</p>',
    body_text: null,
    updated_at: new Date('2025-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  upsertTemplateMock.mockReset();
  listTemplatesMock.mockReset();
  findTemplateMock.mockReset();
  loggerInfoSpy.mockReset();
  loggerErrorSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('saveTemplate — happy path', () => {
  it('validates, upserts, audits, and returns the persisted record', async () => {
    const record = persistedRecord();
    upsertTemplateMock.mockResolvedValueOnce(record);

    const result = await saveTemplate({
      actorUserId: ACTOR_USER_ID,
      input: {
        key: 'application_confirm',
        locale: 'id',
        subject: 'Lamaran Anda diterima',
        bodyHtml: '<p>Halo {{ applicant_name }}</p>',
        bodyText: '',
      },
    });

    // Returns the persisted record from the repo.
    expect(result).toBe(record);

    // The upsert received the normalised input. An empty bodyText
    // collapses to null (the column is nullable).
    expect(upsertTemplateMock).toHaveBeenCalledTimes(1);
    const upsertArg = upsertTemplateMock.mock.calls[0]![0] as {
      key: string;
      locale: string;
      subject: string;
      bodyHtml: string;
      bodyText: string | null;
    };
    expect(upsertArg.key).toBe('application_confirm');
    expect(upsertArg.locale).toBe('id');
    expect(upsertArg.subject).toBe('Lamaran Anda diterima');
    expect(upsertArg.bodyHtml).toBe('<p>Halo {{ applicant_name }}</p>');
    expect(upsertArg.bodyText).toBeNull();

    // Audit log line emitted via logger.info.
    const auditCall = loggerInfoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as { event?: string }).event === 'mail_template_change',
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBe(ACTOR_USER_ID);
    expect(payload.template_key).toBe('application_confirm');
    expect(payload.locale).toBe('id');
  });

  it('forwards a non-empty plain-text body to the repo', async () => {
    upsertTemplateMock.mockResolvedValueOnce(
      persistedRecord({ body_text: 'Halo' }),
    );

    await saveTemplate({
      actorUserId: ACTOR_USER_ID,
      input: {
        key: 'application_confirm',
        locale: 'en',
        subject: 'Application received',
        bodyHtml: '<p>Hi</p>',
        bodyText: 'Hi there',
      },
    });

    const upsertArg = upsertTemplateMock.mock.calls[0]![0] as {
      bodyText: string | null;
    };
    expect(upsertArg.bodyText).toBe('Hi there');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('saveTemplate — validation', () => {
  it('rejects an empty subject with InvalidTemplateInputError (422)', async () => {
    const error = await saveTemplate({
      actorUserId: ACTOR_USER_ID,
      input: {
        key: 'application_confirm',
        locale: 'id',
        subject: '   ',
        bodyHtml: '<p>Halo</p>',
        bodyText: '',
      },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidTemplateInputError);
    const invalid = error as InstanceType<typeof InvalidTemplateInputError>;
    expect(invalid.statusCode).toBe(422);
    expect(invalid.fieldErrors.subject).toBeDefined();
    // No upsert for an invalid input.
    expect(upsertTemplateMock).not.toHaveBeenCalled();
  });

  it('rejects a bad locale with InvalidTemplateInputError', async () => {
    const error = await saveTemplate({
      actorUserId: ACTOR_USER_ID,
      input: {
        key: 'application_confirm',
        locale: 'fr',
        subject: 'Bonjour',
        bodyHtml: '<p>Bonjour</p>',
        bodyText: '',
      },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidTemplateInputError);
    const invalid = error as InstanceType<typeof InvalidTemplateInputError>;
    expect(invalid.fieldErrors.locale).toBeDefined();
    expect(upsertTemplateMock).not.toHaveBeenCalled();
  });

  it('rejects a key over 64 characters with InvalidTemplateInputError', async () => {
    const error = await saveTemplate({
      actorUserId: ACTOR_USER_ID,
      input: {
        key: 'a'.repeat(65),
        locale: 'id',
        subject: 'Subject',
        bodyHtml: '<p>Body</p>',
        bodyText: '',
      },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidTemplateInputError);
    const invalid = error as InstanceType<typeof InvalidTemplateInputError>;
    expect(invalid.fieldErrors.key).toBeDefined();
    expect(invalid.fieldErrors.key?.join(' ')).toMatch(/64/);
    expect(upsertTemplateMock).not.toHaveBeenCalled();
  });

  it('rejects an empty HTML body with InvalidTemplateInputError', async () => {
    const error = await saveTemplate({
      actorUserId: ACTOR_USER_ID,
      input: {
        key: 'application_confirm',
        locale: 'id',
        subject: 'Subject',
        bodyHtml: '   ',
        bodyText: '',
      },
    }).then(
      () => {
        throw new Error('expected the call to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidTemplateInputError);
    const invalid = error as InstanceType<typeof InvalidTemplateInputError>;
    expect(invalid.fieldErrors.bodyHtml).toBeDefined();
    expect(upsertTemplateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Read pass-throughs
// ---------------------------------------------------------------------------

describe('listAll / getOne — repo pass-through', () => {
  it('listAll returns the repo list verbatim', async () => {
    const rows = [persistedRecord(), persistedRecord({ locale: 'en' })];
    listTemplatesMock.mockResolvedValueOnce(rows);

    const result = await listAll();

    expect(result).toBe(rows);
    expect(listTemplatesMock).toHaveBeenCalledTimes(1);
  });

  it('getOne forwards the key + locale to the repo', async () => {
    const record = persistedRecord();
    findTemplateMock.mockResolvedValueOnce(record);

    const result = await getOne('application_confirm', 'id');

    expect(result).toBe(record);
    expect(findTemplateMock).toHaveBeenCalledWith('application_confirm', 'id');
  });

  it('getOne returns null when the repo has no row', async () => {
    findTemplateMock.mockResolvedValueOnce(null);

    const result = await getOne('missing', 'id');

    expect(result).toBeNull();
  });
});
