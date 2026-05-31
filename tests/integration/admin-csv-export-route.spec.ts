/**
 * Admin CSV export route integration test (task 45.1).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 45.1 — Endpoint GET /admin/reports/jobs/:id/export.csv
 * Design  : §16.3 (CSV export, HMAC signed URL), §14.1 (policy: report.read)
 * Validates: Requirements 13.4, 13.5, 16.4
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()` so
 *   the route handler, the `requirePolicy('report.read')` guard, the CSV
 *   export query, the HMAC signed-URL helper, and the audit writer all run
 *   end-to-end. Two boundaries are mocked:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        `query()` feeds `getApplicationsForExport` (a SELECT) on the
 *        happy path, and the `data_export` audit INSERT after streaming.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin`. `requirePolicy`
 *        calls it with NO `allowedRoles`, so the mock simply returns the
 *        canonical AdminSession; the real `requirePolicy` then applies the
 *        §14.1 `report.read` check itself (Super_Admin + HR). For the
 *        Department_Head case the mock returns a Dept_Head session and the
 *        real policy guard rejects it with 403.
 *
 *   Sibling route plugins are stubbed so the bootstrap does not pull in
 *   their service mocks.
 *
 * Cases:
 *   1. Super_Admin GET with seeded rows → 200, Content-Type: text/csv,
 *      body contains CSV header + data rows + signed URL pattern.
 *   2. Row cap exceeded (seed 10,001 rows) → 422 `too_many_rows`.
 *   3. Department_Head → 403 (report.read is HR + Super_Admin only).
 *   4. Audit event `data_export` is written after a successful export.
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
 * Build a fake application export row as returned by mysql2.
 */
function fakeExportRow(overrides: Partial<{
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  stage: string;
  applied_at: Date;
  cv_file_id: number;
}> = {}): RowDataPacket {
  return {
    id: overrides.id ?? 1,
    full_name: overrides.full_name ?? 'Budi Santoso',
    email: overrides.email ?? 'budi@example.com',
    phone: overrides.phone !== undefined ? overrides.phone : '+6281234567890',
    stage: overrides.stage ?? 'Applied',
    applied_at: overrides.applied_at ?? new Date('2025-03-15T08:00:00Z'),
    cv_file_id: overrides.cv_file_id ?? 42,
  } as unknown as RowDataPacket;
}

/**
 * Seed the queryMock for a successful export with `count` rows.
 * The SELECT returns the rows; the audit INSERT returns a benign result.
 */
function seedExportRows(rows: RowDataPacket[]): void {
  queryMock.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (/FROM applications a/.test(s) && /JOIN applicants ap/.test(s)) {
      return rows;
    }
    if (/INSERT INTO audit_events/.test(s)) {
      return [{ insertId: 1, affectedRows: 1 }];
    }
    // access_denied audit INSERT (for 403 cases)
    return [{ insertId: 0, affectedRows: 1 }];
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

describe('GET /admin/reports/jobs/:id/export.csv — Super_Admin happy path (Req 13.4)', () => {
  it('returns 200 with text/csv, CSV header row, and data rows with signed URL', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    const rows = [
      fakeExportRow({ id: 1, full_name: 'Budi Santoso', email: 'budi@example.com', stage: 'Applied', cv_file_id: 42 }),
      fakeExportRow({ id: 2, full_name: 'Siti Rahayu', email: 'siti@example.com', stage: 'Interview', cv_file_id: 55 }),
    ];
    seedExportRows(rows);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports/jobs/7/export.csv',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toMatch(/applications-7\.csv/);

      const body = res.body;

      // CSV header row must be present.
      expect(body).toContain('applicant_name,email,phone,current_stage,applied_at,cv_download_url');

      // Data rows must contain the applicant names.
      expect(body).toContain('Budi Santoso');
      expect(body).toContain('Siti Rahayu');

      // Signed URL pattern: /me/cv/<id>?sig=<hex>&exp=<timestamp>
      expect(body).toMatch(/\/me\/cv\/\d+\?sig=[0-9a-f]+&exp=\d+/);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/reports/jobs/:id/export.csv — row cap exceeded (Req 13 refinement)', () => {
  it('returns 422 too_many_rows when query returns more than 10,000 rows', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));

    // Seed 10,001 rows to trigger the cap.
    const manyRows: RowDataPacket[] = Array.from({ length: 10_001 }, (_, i) =>
      fakeExportRow({ id: i + 1, email: `user${i}@example.com` }),
    );
    seedExportRows(manyRows);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports/jobs/7/export.csv',
      });

      expect(res.statusCode).toBe(422);
      const body = res.json<{ error: string; count: number; suggestion: string }>();
      expect(body.error).toBe('too_many_rows');
      expect(body.count).toBe(10_001);
      expect(body.suggestion).toMatch(/filter/i);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/reports/jobs/:id/export.csv — RBAC (report.read is HR + Super_Admin only)', () => {
  it('returns 403 for Department_Head', async () => {
    requireAdminMock.mockResolvedValueOnce(
      fakeAdminSession('Department_Head', { departments: [3] }),
    );
    // Seed the access_denied audit INSERT.
    queryMock.mockResolvedValue([{ insertId: 0, affectedRows: 1 }]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports/jobs/7/export.csv',
      });

      expect(res.statusCode).toBe(403);
      // requirePolicy renders the 403.njk page (§14.3).
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('403');

      // No export SELECT was attempted for the denied role.
      const exportCall = queryMock.mock.calls.find((call) =>
        /FROM applications a/.test(String(call[0])),
      );
      expect(exportCall).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/reports/jobs/:id/export.csv — audit event (Req 13.5)', () => {
  it('writes a data_export audit event after a successful export', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    const rows = [
      fakeExportRow({ id: 1 }),
      fakeExportRow({ id: 2 }),
    ];
    seedExportRows(rows);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports/jobs/7/export.csv',
      });

      expect(res.statusCode).toBe(200);

      // Find the audit INSERT call.
      const auditCall = queryMock.mock.calls.find((call) =>
        /INSERT INTO audit_events/.test(String(call[0])),
      );
      expect(auditCall).toBeDefined();

      // The bound params must include 'data_export' as the action type.
      const params = auditCall?.[1] as unknown[];
      expect(params).toContain('data_export');
    } finally {
      await app.close();
    }
  });
});
