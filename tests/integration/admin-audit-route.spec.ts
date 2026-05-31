/**
 * Admin audit-log route integration test (task 40.2).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 40.2 — Admin audit log filter UI
 * Design  : §6 Admin (GET /admin/audit — Super_Admin only), §14.1, §15
 * Validates: Requirements 12.3
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()` so
 *   the route handler, the `requirePolicy('audit.read')` guard, the audit
 *   read queries, and the Nunjucks view all run end-to-end. Two boundaries
 *   are mocked, mirroring `admin-mail-templates-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        `query()` feeds `listAuditEvents` (a COUNT + a page SELECT) on the
 *        happy path, and the `access_denied` audit INSERT that
 *        `requirePolicy` writes on a denial.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin`. `requirePolicy`
 *        calls it with NO `allowedRoles`, so the mock simply returns the
 *        canonical AdminSession; the real `requirePolicy` then applies the
 *        §14.1 `audit.read` check itself (Super_Admin only). For the
 *        unauthenticated case the mock short-circuits with a 302.
 *
 *   Sibling route plugins are stubbed so the bootstrap does not pull in
 *   their service mocks.
 *
 * Cases:
 *   1. GET without session → admin-guard short-circuit to /id/login.
 *   2. GET as Super_Admin → 200 + audit view with the seeded rows.
 *   3. GET as Super_Admin with filters → 200, and the filter values reach
 *      the parameterised query layer.
 *   4. GET as HR → 403 (audit.read is Super_Admin only) + access_denied audit.
 *   5. GET as Department_Head → 403 (same).
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
 * Seed the `listAuditEvents` read: a COUNT(*) response followed by the
 * page SELECT response. The repo issues the count first, then the page.
 */
function seedListAuditEvents(): void {
  // COUNT(*) AS n
  queryMock.mockResolvedValueOnce([
    { n: 1 } as unknown as RowDataPacket,
  ]);
  // Page SELECT
  queryMock.mockResolvedValueOnce([
    {
      id: 4242,
      occurred_at: new Date('2025-06-01T08:30:00.000Z'),
      actor_user_id: 7,
      actor_ip: '203.0.113.9',
      action_type: 'login_success',
      target_entity: 'user',
      target_id: 7,
      details: { method: 'password' },
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

describe('GET /admin/audit — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/audit' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // The handler never ran: no read query was issued.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/audit — Super_Admin happy path', () => {
  it('renders 200 with the audit log', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedListAuditEvents();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/audit' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Audit log');
      // The seeded event surfaces in the table.
      expect(res.body).toContain('login_success');
      expect(res.body).toContain('203.0.113.9');
      // The action-type filter <select> is populated from ACTION_TYPES.
      expect(res.body).toContain('application_stage_change');
      // The read query ran (COUNT + page).
      expect(queryMock).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/audit — filters reach the query layer (Req 12.3)', () => {
  it('passes date range, actor, action type, and target entity to the parameterised query', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedListAuditEvents();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url:
          '/admin/audit?dateFrom=2025-01-01&dateTo=2025-06-30' +
          '&actor=7&actionType=login_success&targetEntity=user',
      });

      expect(res.statusCode).toBe(200);

      // The page SELECT carries every filter as a bound `?` parameter,
      // plus the trailing LIMIT/OFFSET. We find the SELECT (not the COUNT)
      // and assert its params include each filter value.
      const pageCall = queryMock.mock.calls.find((call) =>
        /ORDER BY occurred_at DESC/.test(String(call[0])),
      );
      expect(pageCall).toBeDefined();
      const sql = String(pageCall?.[0]);
      const params = pageCall?.[1] as unknown[];

      // WHERE clause was assembled with one condition per active filter.
      expect(sql).toContain('WHERE');
      expect(sql).toContain('occurred_at >= ?');
      expect(sql).toContain('occurred_at <= ?');
      expect(sql).toContain('actor_user_id = ?');
      expect(sql).toContain('action_type = ?');
      expect(sql).toContain('target_entity = ?');
      // No value is interpolated into the SQL text — everything is bound.
      expect(params).toContain('2025-01-01');
      expect(params).toContain('2025-06-30');
      expect(params).toContain(7);
      expect(params).toContain('login_success');
      expect(params).toContain('user');
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/audit — RBAC (audit.read is Super_Admin only, §14.1)', () => {
  it('returns 403 for HR', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/audit' });

      expect(res.statusCode).toBe(403);
      // `requirePolicy` renders the `admin/403.njk` page (§14.3) instead of
      // a bare JSON body.
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('403');
      // No audit-list SELECT was attempted for the denied role.
      const listCall = queryMock.mock.calls.find((call) =>
        /ORDER BY occurred_at DESC/.test(String(call[0])),
      );
      expect(listCall).toBeUndefined();
      // The denial was recorded as an `access_denied` audit event (§14.3).
      const auditCall = queryMock.mock.calls.find((call) =>
        /INSERT INTO audit_events/.test(String(call[0])),
      );
      expect(auditCall).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('returns 403 for Department_Head', async () => {
    requireAdminMock.mockResolvedValueOnce(
      fakeAdminSession('Department_Head', { departments: [3] }),
    );

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/audit' });

      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('403');
      const listCall = queryMock.mock.calls.find((call) =>
        /ORDER BY occurred_at DESC/.test(String(call[0])),
      );
      expect(listCall).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
