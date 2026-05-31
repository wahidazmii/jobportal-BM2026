/**
 * Admin users route integration test (task 42.1).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 42.1 — Endpoint GET /admin/users &
 *           POST /admin/users/invite
 * Design  : §6 Admin (user management — Super_Admin only), §12 (mail),
 *           §14.1 (policy: user.invite → Super_Admin), §15 (audit)
 * Validates: Requirements 11.7, 12.1
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()` so
 *   the route handlers, the `requirePolicy('user.invite')` guard, the
 *   invite service (validation + transactional create), and the Nunjucks
 *   views all run end-to-end. Two boundaries are mocked, mirroring
 *   `admin-audit-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        `query()` feeds the `listInternalUsers` read on the list page and
 *        the duplicate-email `SELECT id FROM users` pre-check + the
 *        `access_denied` audit INSERT a denial writes. `withTransaction()`
 *        drives the invite happy path: it hands the callback a fake
 *        connection whose `execute()` records every SQL statement so we can
 *        assert the user INSERT, the invitation-token INSERT, the mail
 *        enqueue, and the `role_change` audit all ran on it.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin`. `requirePolicy`
 *        calls it with NO `allowedRoles`, so the mock simply returns the
 *        canonical AdminSession; the real `requirePolicy` then applies the
 *        §14.1 `user.invite` check itself (Super_Admin only). For the
 *        unauthenticated case the mock short-circuits with a 302.
 *
 *   Sibling route plugins are stubbed so the bootstrap does not pull in
 *   their service mocks.
 *
 * Cases:
 *   1. GET without session → admin-guard short-circuit to /id/login.
 *   2. GET as Super_Admin → 200 + users view with the invite form.
 *   3. POST invite as Super_Admin (happy path) → 302 ?invited=1, and the
 *      transaction inserts user + token, enqueues mail, writes role_change.
 *   4. POST invite as HR → 403 (user.invite is Super_Admin only) +
 *      access_denied audit.
 *   5. POST invite with an invalid email/role → 422 re-render, no writes.
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

/** Seed the `listInternalUsers` SELECT response (single internal user). */
function seedListInternalUsers(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: 7,
      email: 'hr.lead@buanamegah.test',
      role: 'HR',
      status: 'active',
      created_at: new Date('2025-05-01T00:00:00.000Z'),
      email_verified_at: new Date('2025-05-01T01:00:00.000Z'),
    } as unknown as RowDataPacket,
  ]);
}

/**
 * A fake transaction connection that records every `execute()` call so a
 * test can assert which statements ran inside `withTransaction`. The
 * `seedReturns` hook lets a test shape per-statement return values (e.g.
 * the duplicate-email pre-check SELECT or the user INSERT's insertId).
 */
interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function makeFakeConnection(
  calls: RecordedCall[],
  seedReturns: (sql: string) => unknown,
) {
  return {
    execute: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql: String(sql), params });
      return [seedReturns(String(sql)), []];
    }),
  };
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

describe('GET /admin/users — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/users' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // The handler never ran: no read query was issued.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/users — Super_Admin happy path', () => {
  it('renders 200 with the user list and the invite form', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedListInternalUsers();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/users' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Users');
      // The invite form posts to the invite endpoint.
      expect(res.body).toContain('/admin/users/invite');
      // The seeded internal user surfaces in the table.
      expect(res.body).toContain('hr.lead@buanamegah.test');
      // The role <select> is populated from INVITE_ROLES (no Applicant).
      expect(res.body).toContain('Department_Head');
      expect(res.body).not.toContain('>Applicant<');
      // The list SELECT ran.
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/users/invite — Super_Admin happy path (Req 11.7, 12.1)', () => {
  it('creates the pending account + token, enqueues mail, audits role_change, redirects', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));

    const calls: RecordedCall[] = [];
    // Inside the transaction: the duplicate-email pre-check SELECT returns
    // no rows; the user INSERT returns an insertId; everything else is a
    // benign ResultSetHeader-shaped object.
    const fakeConn = makeFakeConnection(calls, (sql) => {
      if (/SELECT id FROM users/.test(sql)) return [];
      if (/INSERT INTO users/.test(sql)) return { insertId: 501, affectedRows: 1 };
      return { insertId: 0, affectedRows: 1 };
    });
    withTransactionMock.mockImplementationOnce(async (fn: (c: unknown) => unknown) =>
      fn(fakeConn),
    );

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users/invite',
        payload: {
          email: 'new.manager@buanamegah.test',
          role: 'Department_Head',
        },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/users?invited=1');

      const sqls = calls.map((c) => c.sql);
      // Pending account INSERT.
      const userInsert = calls.find((c) => /INSERT INTO users/.test(c.sql));
      expect(userInsert).toBeDefined();
      // status=pending + chosen role are baked into the statement/params.
      expect(userInsert?.sql).toContain("'pending'");
      expect(userInsert?.params).toContain('Department_Head');
      // Invitation-token INSERT with the 7-day expiry.
      const tokenInsert = calls.find((c) =>
        /INSERT INTO invitation_tokens/.test(c.sql),
      );
      expect(tokenInsert).toBeDefined();
      expect(tokenInsert?.sql).toContain('INTERVAL 7 DAY');
      // Mail enqueue (INSERT IGNORE INTO mail_outbox — natural-key idempotent).
      expect(sqls.some((s) => /INSERT IGNORE INTO mail_outbox/.test(s))).toBe(
        true,
      );
      // role_change audit, written on the SAME transaction connection.
      const auditInsert = calls.find((c) =>
        /INSERT INTO audit_events/.test(c.sql),
      );
      expect(auditInsert).toBeDefined();
      expect(auditInsert?.params).toContain('role_change');
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/users/invite — RBAC (user.invite is Super_Admin only, §14.1)', () => {
  it('returns 403 for HR and writes an access_denied audit', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users/invite',
        payload: { email: 'someone@buanamegah.test', role: 'HR' },
      });

      expect(res.statusCode).toBe(403);
      // `requirePolicy` renders the `admin/403.njk` page (§14.3).
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('403');
      // No invite transaction was opened for the denied role.
      expect(withTransactionMock).not.toHaveBeenCalled();
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

describe('POST /admin/users/invite — validation (Req 11.7)', () => {
  it('re-renders 422 with a field error on an invalid email and writes nothing', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    // The form re-render re-loads the user list.
    seedListInternalUsers();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users/invite',
        payload: { email: 'not-an-email', role: 'HR' },
      });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // No invite transaction ran for an invalid payload.
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('re-renders 422 on an invalid role (Applicant is not invitable)', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedListInternalUsers();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users/invite',
        payload: { email: 'valid@buanamegah.test', role: 'Applicant' },
      });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
