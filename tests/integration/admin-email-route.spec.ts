/**
 * Admin templated-email route integration test (task 30.3).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.3 — Templated email send
 * Design  : §6 Admin (POST /admin/applications/:id/email), §12.3
 * Validates: Requirements 10.7
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   so the route handler and the email service run end-to-end. Three
 *   boundaries are mocked, mirroring `admin-notes-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        Each test programs the `query()` responses for the
 *        application-context SELECT, the `findJobById` round-trip, and
 *        the `mail_templates` SELECT. `withTransaction` runs its callback
 *        with a fake connection so the enqueue path executes.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin` returns a canonical
 *        AdminSession when the test wants one; otherwise it
 *        short-circuits to a 302 redirect to `/id/login`.
 *
 *     3. `src/modules/mail/service.js` — the `enqueue` stub is mocked so
 *        the route does not depend on the real mail subsystem.
 *
 *   Sibling route plugins (auth / password / applicant / public / seo)
 *   are stubbed so the bootstrap does not pull in their service mocks.
 *
 * Cases:
 *   1. Unauthenticated POST → admin-guard short-circuit to /id/login.
 *   2. Super_Admin valid send → 200 { ok: true, templateKey, toEmail }.
 *   3. Unknown template → 422 unknown_template.
 *   4. Empty templateKey → 422 invalid_email_input.
 *   5. Department_Head → 403 (endpoint is HR/Super_Admin only per §6/§14.1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

const poolQueryMock = vi.fn();
const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: poolQueryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: queryMock,
  withTransaction: withTransactionMock,
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: enqueueMock,
}));

const requireAdminMock = vi.fn();
vi.mock('../../src/infra/admin-guard.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/admin-guard.js')
  >('../../src/infra/admin-guard.js');
  return {
    ...actual,
    requireAdmin: requireAdminMock,
  };
});

/** Stub sibling route plugins so we don't need their service mocks. */
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));
vi.mock('../../src/routes/auth.js', () => ({
  authRoutes: async () => undefined,
}));
vi.mock('../../src/routes/applicant.js', () => ({
  default: async () => undefined,
  applicantRoutes: async () => undefined,
}));
vi.mock('../../src/routes/public.js', () => ({
  default: async () => undefined,
  publicRoutes: async () => undefined,
}));
vi.mock('../../src/routes/seo.js', () => ({
  default: async () => undefined,
  seoRoutes: async () => undefined,
}));

// Import after the mocks register so the production module graph picks
// up the mocked db / admin-guard / mail boundaries.
const { buildApp } = await import('../../src/server.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://localhost',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

const APPLICATION_ID = 555;
const JOB_ID = 42;
const JOB_DEPARTMENT_ID = 3;
const TO_EMAIL = 'budi@example.com';
const TEMPLATE_KEY = 'stage_change';

/** Build an AdminSession-shaped object for the requireAdmin mock. */
function fakeAdminSession(
  role: 'Super_Admin' | 'HR' | 'Department_Head',
  options: { departments?: readonly number[] } = {},
) {
  const scope =
    role === 'Department_Head'
      ? { departments: options.departments ?? [] }
      : {};
  return {
    sid: 'a'.repeat(43),
    userId: 99,
    role,
    csrfToken: 'b'.repeat(43),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    expiresAt: new Date('2025-01-01T12:00:00Z'),
    ipAddress: null,
    userAgent: null,
    scope,
  };
}

/**
 * Mirror the production admin-guard: when the session role is outside the
 * route's `allowedRoles`, send a 403 and return null. Used for the
 * Department_Head case so the test exercises the real RBAC contract even
 * though the guard module itself is mocked. The email endpoint restricts
 * to {Super_Admin, HR} per Design §6 Admin + §14.1.
 */
function guardRespectingAllowedRoles(
  session: ReturnType<typeof fakeAdminSession>,
) {
  return async (
    _request: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    options?: { allowedRoles?: readonly string[] },
  ) => {
    const allowed = options?.allowedRoles ?? [
      'Super_Admin',
      'HR',
      'Department_Head',
    ];
    if (!allowed.includes(session.role)) {
      reply.code(403).send({ error: 'forbidden', role: session.role });
      return null;
    }
    return session;
  };
}

/** Seed the application-context SELECT so the service resolves the row. */
function seedApplicationContextRow(): void {
  queryMock.mockResolvedValueOnce([
    {
      application_id: APPLICATION_ID,
      job_id: JOB_ID,
      stage: 'Interview',
      applicant_name: 'Budi Santoso',
      to_email: TO_EMAIL,
      title_requested: 'Insinyur Frontend Senior',
    } as unknown as RowDataPacket,
  ]);
}

/** Seed the `findJobById(id, scope)` round-trip for an in-scope job. */
function seedFindJobByIdSuccess(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: JOB_ID,
      uuid: '01HQABCDEF',
      slug: 'senior-fe-engineer',
      department_id: JOB_DEPARTMENT_ID,
      location: 'Jakarta',
      employment_type: 'full-time',
      level: 'senior',
      status: 'Published',
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      application_deadline: null,
      published_at: new Date('2025-01-01T00:00:00Z'),
      created_by: 1,
      created_at: new Date('2025-01-01T00:00:00Z'),
      updated_at: new Date('2025-01-01T00:00:00Z'),
    } as unknown as RowDataPacket,
  ]);
  queryMock.mockResolvedValueOnce([
    {
      job_id: JOB_ID,
      locale: 'id',
      title: 'Insinyur Frontend Senior',
      description: 'desc',
      requirements: 'req',
      responsibilities: 'resp',
    } as unknown as RowDataPacket,
  ]);
}

/** Seed the `mail_templates` SELECT with a row that uses the placeholders. */
function seedMailTemplateRow(): void {
  queryMock.mockResolvedValueOnce([
    {
      subject: 'Update for {{ applicant_name }}: {{ job_title }}',
      body_html:
        '<p>Hi {{ applicant_name }}, stage {{ stage }} for {{ job_title }}.</p>',
      body_text: 'Hi {{ applicant_name }}, stage {{ stage }}.',
    } as unknown as RowDataPacket,
  ]);
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  requireAdminMock.mockReset();
  enqueueMock.mockClear();
  withTransactionMock.mockImplementation(
    async (fn: (conn: unknown) => Promise<unknown>) =>
      fn({ execute: vi.fn() } as unknown),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /admin/applications/:id/email — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/email`,
        payload: { templateKey: TEMPLATE_KEY, locale: 'id' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(queryMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/email — Super_Admin happy path', () => {
  it('returns 200 with templateKey + toEmail on a valid send', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedApplicationContextRow();
    seedFindJobByIdSuccess();
    seedMailTemplateRow();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/email`,
        payload: { templateKey: TEMPLATE_KEY, locale: 'id' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        templateKey: string;
        toEmail: string;
      };
      expect(body.ok).toBe(true);
      expect(body.templateKey).toBe(TEMPLATE_KEY);
      expect(body.toEmail).toBe(TO_EMAIL);
      // The templated email was enqueued.
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/email — unknown template', () => {
  it('returns 422 unknown_template when the template row is absent', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));
    seedApplicationContextRow();
    seedFindJobByIdSuccess();
    // mail_templates SELECT → no rows.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/email`,
        payload: { templateKey: 'does_not_exist', locale: 'id' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string };
      expect(body.error).toBe('unknown_template');
      expect(enqueueMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/email — validation', () => {
  it('returns 422 invalid_email_input when templateKey is empty', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/email`,
        payload: { templateKey: '   ', locale: 'id' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as {
        error: string;
        fields: Record<string, string[]>;
      };
      expect(body.error).toBe('invalid_email_input');
      expect(body.fields.templateKey).toBeDefined();
      // Input validated before any DB query.
      expect(queryMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/email — Department_Head RBAC (§6/§14.1)', () => {
  it('returns 403 because the email endpoint is HR/Super_Admin only', async () => {
    const session = fakeAdminSession('Department_Head', {
      departments: [JOB_DEPARTMENT_ID],
    });
    requireAdminMock.mockImplementationOnce(
      guardRespectingAllowedRoles(session),
    );

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/email`,
        payload: { templateKey: TEMPLATE_KEY, locale: 'id' },
      });

      expect(res.statusCode).toBe(403);
      // The guard rejected before any DB work or enqueue.
      expect(queryMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
