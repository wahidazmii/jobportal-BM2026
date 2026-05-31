/**
 * Admin reports route integration test (task 44.2).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 44.2 — Endpoint GET /admin/reports
 * Design  : §6 Admin (GET /admin/reports — HR + Super_Admin), §16.1, §16.2,
 *           §14.1 (policy: report.read → Super_Admin + HR)
 * Validates: Requirements 13.1, 13.2, 13.3
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()` so
 *   the route handler, the `requirePolicy('report.read')` guard, the
 *   reporting queries, and the Nunjucks view all run end-to-end. Two
 *   boundaries are mocked, mirroring `admin-audit-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        `query()` feeds `getReportSummary` (multiple parallel SELECTs) on
 *        the happy path, and the `access_denied` audit INSERT that
 *        `requirePolicy` writes on a denial.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin`. `requirePolicy`
 *        calls it with NO `allowedRoles`, so the mock simply returns the
 *        canonical AdminSession; the real `requirePolicy` then applies the
 *        §14.1 `report.read` check itself (Super_Admin + HR). For the
 *        unauthenticated case the mock short-circuits with a 302.
 *
 *   Sibling route plugins are stubbed so the bootstrap does not pull in
 *   their service mocks.
 *
 * Cases:
 *   1. GET as Super_Admin → 200 + reports view with seeded summary data.
 *   2. GET as HR → 200 (report.read grants HR too).
 *   3. GET as Department_Head → 403 (report.read is HR + Super_Admin only).
 *   4. GET with dateFrom/dateTo filters → 200, and the bound params contain
 *      the filter values (filters reach the query layer).
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
 * Seed the `getReportSummary` query responses using SQL-pattern matching
 * so the test is robust against parallel query execution order.
 *
 * `getReportSummary` issues queries in two waves:
 *   Wave 1 (parallel): activeJobsCount SELECT, applicationsInRange SELECT
 *   Wave 2 (parallel): conversionAppliedToInterview SELECT,
 *                      conversionInterviewToHired denominator SELECT,
 *                      conversionInterviewToHired numerator SELECT,
 *                      avgTimeToHireHours SELECT,
 *                      sourceDistribution SELECT
 *
 * We use mockImplementation to match by SQL content so the test is
 * independent of parallel execution order.
 */
function seedReportSummary(): void {
  queryMock.mockImplementation(async (sql: string) => {
    const s = String(sql);
    // activeJobsCount: Published job_postings count
    if (/FROM job_postings/.test(s) && /Published/.test(s)) {
      return [{ n: 12 } as unknown as RowDataPacket];
    }
    // sourceDistribution: GROUP BY source
    if (/GROUP BY source/.test(s)) {
      return [
        { source: 'direct', cnt: 30 } as unknown as RowDataPacket,
        { source: 'search', cnt: 10 } as unknown as RowDataPacket,
        { source: 'alert', cnt: 5 } as unknown as RowDataPacket,
      ];
    }
    // avgTimeToHireHours: TIMESTAMPDIFF
    if (/TIMESTAMPDIFF/.test(s)) {
      return [{ avg_hours: 240 } as unknown as RowDataPacket];
    }
    // conversionAppliedToInterview: COUNT(DISTINCT a.id)
    if (/COUNT\(DISTINCT a\.id\)/.test(s)) {
      return [{ n: 20 } as unknown as RowDataPacket];
    }
    // conversionInterviewToHired numerator: stage = 'Hired'
    if (/stage = 'Hired'/.test(s)) {
      return [{ n: 8 } as unknown as RowDataPacket];
    }
    // applicationsInRange + conversionInterviewToHired denominator:
    // both are COUNT(*) FROM applications WHERE applied_at BETWEEN
    // We distinguish: denominator has stage IN (...), applicationsInRange does not
    if (/FROM applications/.test(s) && /stage IN/.test(s)) {
      return [{ n: 20 } as unknown as RowDataPacket];
    }
    // applicationsInRange: plain BETWEEN, no stage filter
    if (/FROM applications/.test(s) && /BETWEEN/.test(s)) {
      return [{ n: 45 } as unknown as RowDataPacket];
    }
    // access_denied audit INSERT — return benign result
    if (/INSERT INTO audit_events/.test(s)) {
      return [{ insertId: 0, affectedRows: 1 }];
    }
    return [];
  });
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

describe('GET /admin/reports — Super_Admin happy path (Req 13.1, 13.2, 13.3)', () => {
  it('renders 200 with the reports view and seeded summary data', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedReportSummary();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/reports' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Reports');
      // Summary cards are rendered.
      expect(res.body).toContain('12');   // activeJobsCount
      expect(res.body).toContain('45');   // applicationsInRange
      // Conversion rates rendered as percentages.
      expect(res.body).toContain('%');
      // Source distribution table.
      expect(res.body).toContain('direct');
      expect(res.body).toContain('search');
      // Filter form is present.
      expect(res.body).toContain('dateFrom');
      expect(res.body).toContain('dateTo');
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/reports — HR happy path (report.read grants HR, §14.1)', () => {
  it('renders 200 for HR', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));
    seedReportSummary();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/reports' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Reports');
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/reports — RBAC (report.read is HR + Super_Admin only, §14.1)', () => {
  it('returns 403 for Department_Head and writes an access_denied audit', async () => {
    requireAdminMock.mockResolvedValueOnce(
      fakeAdminSession('Department_Head', { departments: [2] }),
    );

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/reports' });

      expect(res.statusCode).toBe(403);
      // `requirePolicy` renders the `admin/403.njk` page (§14.3).
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('403');
      // No reporting SELECT was attempted for the denied role.
      const reportCall = queryMock.mock.calls.find((call) =>
        /FROM job_postings/.test(String(call[0])),
      );
      expect(reportCall).toBeUndefined();
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

describe('GET /admin/reports — filters reach the query layer (Req 13.1)', () => {
  it('passes dateFrom and dateTo as bound params to the reporting queries', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedReportSummary();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports?dateFrom=2025-01-01&dateTo=2025-06-30',
      });

      expect(res.statusCode).toBe(200);

      // The applicationsInRange SELECT carries the date range as bound `?`
      // parameters. We find any call that queries `FROM applications` with
      // a BETWEEN clause and assert the params include the filter values.
      const rangeCall = queryMock.mock.calls.find((call) =>
        /FROM applications/.test(String(call[0])) &&
        /BETWEEN/.test(String(call[0])),
      );
      expect(rangeCall).toBeDefined();
      const params = rangeCall?.[1] as unknown[];
      expect(params).toContain('2025-01-01');
      expect(params).toContain('2025-06-30');

      // The filter values are echoed back in the rendered form (sticky).
      expect(res.body).toContain('2025-01-01');
      expect(res.body).toContain('2025-06-30');
    } finally {
      await app.close();
    }
  });
});
