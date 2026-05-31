/**
 * Admin mail-templates route integration test (task 36.2).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 36.2 — Templated mail editor di admin
 * Design  : §6 Admin (GET/POST /admin/mail-templates), §15 (audit)
 * Validates: Requirements 10.7, 12.1
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   so the route handler, the templates service + repo, and the Nunjucks
 *   views all run end-to-end. Two boundaries are mocked, mirroring
 *   `admin-stage-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        `query()` feeds the `listTemplates` read on the list page and
 *        the `upsertTemplate` INSERT + read-back on a save.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin`. For the happy /
 *        invalid cases the mock returns a canonical AdminSession; for the
 *        Department_Head case it mirrors the PRODUCTION guard (403 when
 *        the role is outside `allowedRoles`), because the editor
 *        restricts to {Super_Admin, HR} (Req 11.3 — HR manages mail
 *        templates, Dept_Head does not); for the unauthenticated case it
 *        short-circuits with a 302 to /id/login.
 *
 *   Sibling route plugins are stubbed so the bootstrap does not pull in
 *   their service mocks.
 *
 * Cases:
 *   1. GET list without session → admin-guard short-circuit to /id/login.
 *   2. GET list as Super_Admin → 200 + list view.
 *   3. POST upsert valid → 302 to the list with ?saved=1.
 *   4. POST invalid → 422 (re-rendered form).
 *   5. POST as Department_Head → 403 (HR/Super_Admin only).
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

// Import after the mocks register.
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
 * Mirror the production admin-guard: when the session role is outside
 * the route's `allowedRoles`, send a 403 and return null. Used for the
 * Department_Head case so the test exercises the real RBAC contract
 * even though the guard module itself is mocked.
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

/** Seed the `listTemplates` SELECT response. */
function seedListTemplates(): void {
  queryMock.mockResolvedValueOnce([
    {
      key: 'application_confirm',
      locale: 'id',
      subject: 'Lamaran Anda diterima',
      body_html: '<p>Halo {{ applicant_name }}</p>',
      body_text: null,
      updated_at: new Date('2025-06-01T00:00:00.000Z'),
    } as unknown as RowDataPacket,
  ]);
}

/**
 * Seed the `upsertTemplate` INSERT + read-back so a successful save
 * resolves. The repo issues an INSERT (ResultSetHeader) followed by a
 * SELECT-by-PK read-back.
 */
function seedUpsertTemplate(): void {
  // INSERT ... ON DUPLICATE KEY UPDATE → ResultSetHeader-shaped object.
  queryMock.mockResolvedValueOnce({
    insertId: 0,
    affectedRows: 1,
  } as unknown as RowDataPacket);
  // Read-back SELECT.
  queryMock.mockResolvedValueOnce([
    {
      key: 'application_confirm',
      locale: 'id',
      subject: 'Lamaran Anda diterima',
      body_html: '<p>Halo {{ applicant_name }}</p>',
      body_text: null,
      updated_at: new Date('2025-06-01T00:00:00.000Z'),
    } as unknown as RowDataPacket,
  ]);
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  requireAdminMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /admin/mail-templates — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/mail-templates',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // The handler never ran: no DB query was issued.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/mail-templates — Super_Admin happy path', () => {
  it('renders 200 with the template list', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedListTemplates();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/mail-templates',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Mail templates');
      // The seeded row appears with an edit link to its composite key.
      expect(res.body).toContain('application_confirm');
      expect(res.body).toContain('Lamaran Anda diterima');
      expect(res.body).toContain('/admin/mail-templates/application_confirm/id');
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/mail-templates — upsert', () => {
  it('returns 302 to the list with ?saved=1 on a valid save', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));
    seedUpsertTemplate();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/mail-templates',
        payload: {
          key: 'application_confirm',
          locale: 'id',
          subject: 'Lamaran Anda diterima',
          body_html: '<p>Halo {{ applicant_name }}</p>',
          body_text: '',
        },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/mail-templates?saved=1');
      // The upsert INSERT + read-back both ran.
      const upsertCall = queryMock.mock.calls.find((call) =>
        /INSERT INTO mail_templates/.test(String(call[0])),
      );
      expect(upsertCall).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('returns 422 and re-renders the form on invalid input', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/mail-templates',
        payload: {
          key: 'application_confirm',
          locale: 'id',
          subject: '', // empty subject → validation failure
          body_html: '<p>Halo</p>',
          body_text: '',
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // No upsert was attempted for an invalid payload.
      const upsertCall = queryMock.mock.calls.find((call) =>
        /INSERT INTO mail_templates/.test(String(call[0])),
      );
      expect(upsertCall).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/mail-templates — Department_Head RBAC (Req 11.3)', () => {
  it('returns 403 because the editor is HR/Super_Admin only', async () => {
    const session = fakeAdminSession('Department_Head', { departments: [3] });
    requireAdminMock.mockImplementationOnce(guardRespectingAllowedRoles(session));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/mail-templates',
        payload: {
          key: 'application_confirm',
          locale: 'id',
          subject: 'Lamaran Anda diterima',
          body_html: '<p>Halo</p>',
          body_text: '',
        },
      });

      expect(res.statusCode).toBe(403);
      // The route now sits behind `requirePolicy('mail_template.manage')`
      // (task 39.1): a denied role gets the rendered `admin/403.njk` page
      // (§14.3) instead of the bare JSON body.
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('403');
      // No template upsert was attempted.
      const upsertCall = queryMock.mock.calls.find((call) =>
        /INSERT INTO mail_templates/.test(String(call[0])),
      );
      expect(upsertCall).toBeUndefined();
      // The denial was recorded as an `access_denied` audit event (§14.3).
      const auditCall = queryMock.mock.calls.find((call) =>
        /INSERT INTO audit_events/.test(String(call[0])),
      );
      expect(auditCall).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
