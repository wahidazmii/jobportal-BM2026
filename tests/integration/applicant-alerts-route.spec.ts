/**
 * Integration test for the Applicant_Area job alerts routes (task 33.1).
 *
 * Validates: Requirement 7.1 (Design §6 Applicant_Area, §7.2 job_alerts)
 *
 * Routes:
 *   - GET  /:locale/me/alerts            — list + create form
 *   - POST /:locale/me/alerts            — create (cap of 10)
 *   - POST /:locale/me/alerts/:id/delete — remove (owner-scoped)
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `inject()` so
 *   every plugin (security headers, cookies, formbody, view engine) and
 *   the real route handler run end-to-end. Two boundaries are mocked:
 *     - `src/infra/db.ts`          — prepared-statement + tx boundary.
 *     - `src/infra/auth-guard.ts`  — `requireApplicant` returns a
 *                                    canonical Applicant session, or
 *                                    short-circuits to a 302 login
 *                                    redirect (production behaviour).
 *   Sibling route plugins are stubbed so the bootstrap does not pull
 *   their service mocks.
 *
 * Cases:
 *   1. GET without a session → 302 to /id/login.
 *   2. GET as an applicant → 200 with the alerts page.
 *   3. POST create valid → success (302 redirect to the alerts page).
 *   4. POST when already at the 10-alert cap → 422.
 *   5. POST delete → success (302 redirect to the alerts page).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

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

const requireApplicantMock = vi.fn();
vi.mock('../../src/infra/auth-guard.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/auth-guard.js')
  >('../../src/infra/auth-guard.js');
  return {
    ...actual,
    requireApplicant: requireApplicantMock,
  };
});

// Stub sibling route plugins.
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));
vi.mock('../../src/routes/auth.js', () => ({
  authRoutes: async () => undefined,
}));
vi.mock('../../src/routes/admin.js', () => ({
  default: async () => undefined,
  adminRoutes: async () => undefined,
}));

// Import after the mocks register.
const { buildApp } = await import('../../src/server.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLICANT_USER_ID = 42;

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://localhost',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

function fakeSession() {
  return {
    sid: 'a'.repeat(43),
    userId: APPLICANT_USER_ID,
    role: 'Applicant' as const,
    csrfToken: 'b'.repeat(43),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    expiresAt: new Date('2025-01-01T12:00:00Z'),
    ipAddress: null,
    userAgent: null,
  };
}

function stubRequireApplicantUnauthenticated(): void {
  requireApplicantMock.mockImplementation(async (_req, reply) => {
    reply.code(302).header('location', '/id/login').send();
    return null;
  });
}

function header(insertId: number, affectedRows = 1): ResultSetHeader {
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

function alertDbRow(
  overrides: Partial<{
    id: number;
    keyword: string | null;
    locations: string | null;
    departments: string | null;
    frequency: 'Daily' | 'Weekly';
  }> = {},
): RowDataPacket {
  return {
    id: overrides.id ?? 1,
    applicant_user_id: APPLICANT_USER_ID,
    keyword: overrides.keyword ?? null,
    locations: overrides.locations ?? null,
    departments: overrides.departments ?? null,
    frequency: overrides.frequency ?? 'Daily',
    last_evaluated_at: null,
    created_at: new Date('2025-01-01T00:00:00Z'),
  } as unknown as RowDataPacket;
}

/**
 * Wire `withTransactionMock` to drive the create flow against a scripted
 * fake connection. `existingCount` controls the COUNT(*) FOR UPDATE
 * result so the cap branch can be exercised.
 */
function installCreateTransaction(existingCount: number): void {
  withTransactionMock.mockImplementation(async (fn) => {
    const conn = {
      execute: vi.fn(async (sql: string) => {
        if (/COUNT\(\*\)/i.test(sql)) {
          return [[{ n: existingCount } as unknown as RowDataPacket], []];
        }
        if (/INSERT\s+INTO\s+job_alerts/i.test(sql)) {
          return [header(7, 1), []];
        }
        if (/FROM\s+job_alerts\s+WHERE\s+id\s*=\s*\?/i.test(sql)) {
          return [[alertDbRow({ id: 7, keyword: 'engineer' })], []];
        }
        throw new Error('unexpected SQL in fake transaction: ' + sql);
      }),
    };
    return fn(conn as never);
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  requireApplicantMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /:locale/me/alerts
// ---------------------------------------------------------------------------

describe('GET /:locale/me/alerts — authentication', () => {
  it('returns 302 to /id/login when the session is missing', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/alerts' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /:locale/me/alerts — happy path', () => {
  it('returns 200 with the alerts page listing existing alerts', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    // listAlerts → SELECT_LIST_SQL response.
    queryMock.mockResolvedValueOnce([
      alertDbRow({
        id: 1,
        keyword: 'engineer',
        locations: '["Jakarta"]',
        departments: '[3]',
        frequency: 'Weekly',
      }),
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/alerts' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Page heading + create form present.
      expect(res.body).toMatch(/Notifikasi Lowongan/);
      expect(res.body).toContain('name="frequency"');
      // The existing alert's keyword is rendered.
      expect(res.body).toContain('engineer');
      expect(res.body).toContain('Jakarta');
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unsupported locale segment before auth runs', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/me/alerts' });

      expect(res.statusCode).toBe(404);
      expect(requireApplicantMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/alerts — create
// ---------------------------------------------------------------------------

describe('POST /:locale/me/alerts — create', () => {
  it('creates a valid alert and redirects to the alerts page (non-htmx)', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    installCreateTransaction(2);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/alerts',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'keyword=engineer&locations=Jakarta%2C+Surabaya&frequency=Weekly',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/me/alerts');
      expect(withTransactionMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns 422 when the applicant is already at the 10-alert cap', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    installCreateTransaction(10);
    // The error re-render calls listAlerts → SELECT_LIST_SQL.
    queryMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/alerts',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'keyword=engineer&frequency=Daily',
      });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Cap banner is rendered.
      expect(res.body).toMatch(/maksimal 10 notifikasi/i);
    } finally {
      await app.close();
    }
  });

  it('returns 422 with field errors for an invalid frequency', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    // Validation fails before the transaction; the error re-render
    // calls listAlerts → SELECT_LIST_SQL.
    queryMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/alerts',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'frequency=Monthly',
      });

      expect(res.statusCode).toBe(422);
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/alerts/:id/delete
// ---------------------------------------------------------------------------

describe('POST /:locale/me/alerts/:id/delete', () => {
  it('deletes an owned alert and redirects to the alerts page (non-htmx)', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    // removeAlert → owner-scoped DELETE affects 1 row.
    queryMock.mockResolvedValueOnce(header(0, 1));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/alerts/5/delete',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/me/alerts');

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/DELETE\s+FROM\s+job_alerts/i);
      expect(params).toEqual([5, APPLICANT_USER_ID]);
    } finally {
      await app.close();
    }
  });

  it('treats a non-owned / missing id as idempotent success (302)', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    // Owner-scoped DELETE matches nothing → affectedRows 0 →
    // AlertNotFoundError swallowed by the route as idempotent success.
    queryMock.mockResolvedValueOnce(header(0, 0));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/alerts/999/delete',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/me/alerts');
    } finally {
      await app.close();
    }
  });
});
