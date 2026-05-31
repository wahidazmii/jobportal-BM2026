/**
 * Admin kanban board integration test (task 29.1).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 29.1 — render kanban
 * Design  : §4.2 (htmx kanban pattern), §6 Admin
 * Validates: Requirement 10.1
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   so the route handler, the Nunjucks renderer, the kanban template,
 *   and the partial all run end-to-end. Two boundaries are mocked:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        Each test programs the `query()` responses for the
 *        `findJobById` round-trip (job row + translations) and for
 *        the `listForKanban` round-trip (six-stage card list).
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin` returns a
 *        canonical AdminSession when the test wants one; otherwise
 *        it short-circuits to a 302 redirect to `/id/login`,
 *        matching the production admin-guard behaviour.
 *
 *   Sibling route plugins (auth / password / applicant / public / seo)
 *   are stubbed so the bootstrap does not pull in their service mocks.
 *
 * Cases:
 *   1. Unauthenticated → admin guard short-circuits to /id/login
 *      (the production "no admin access" response).
 *   2. Super_Admin session for a real job → 200, body contains every
 *      one of the six column headings.
 *   3. Department_Head with scope INCLUDING the job's department →
 *      200 (read-only board still renders).
 *   4. Department_Head with scope NOT including the job's department
 *      → 404 (no row leak).
 *   5. Non-existent job id → 404.
 *   6. Cards appear in their stage's column with the partial markup
 *      (reference number, applicant name, data-application-id).
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

// Import after the mocks register so the production module graph picks
// up the mocked db / admin-guard boundaries.
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

const JOB_ID = 42;
const JOB_DEPARTMENT_ID = 3;

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
 * Seed `query()` responses for a `findJobById(id, scope)` call that
 * RESOLVES to a job (i.e. the row exists AND the scope check passes).
 *
 * The repo fires two queries when the row matches:
 *   1. SELECT … FROM job_postings WHERE id = ?
 *   2. SELECT … FROM job_posting_translations WHERE job_id = ?
 */
function seedFindJobByIdSuccess(options: { departmentId: number }): void {
  // 1. Job row.
  queryMock.mockResolvedValueOnce([
    {
      id: JOB_ID,
      uuid: '01HQABCDEF',
      slug: 'senior-fe-engineer',
      department_id: options.departmentId,
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
  // 2. Translations.
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

/**
 * Seed `query()` responses for a `findJobById(id, scope)` call that
 * RESOLVES to null because the row exists but is in a department
 * outside the caller's scope. Only one query fires (the row read);
 * the translation fetch is short-circuited.
 */
function seedFindJobByIdOutOfScope(options: { departmentId: number }): void {
  queryMock.mockResolvedValueOnce([
    {
      id: JOB_ID,
      uuid: '01HQABCDEF',
      slug: 'senior-fe-engineer',
      department_id: options.departmentId,
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
}

/**
 * Seed `query()` responses for a `findJobById(id, scope)` call that
 * RESOLVES to null because the row does not exist.
 */
function seedFindJobByIdMissing(): void {
  queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);
}

/**
 * Seed the kanban-repo `query()` response. The mock returns a flat
 * array of card rows; the repo buckets them into the canonical six
 * columns. We deliberately pass rows for several different stages so
 * the test can verify stage-to-column bucketing.
 */
function seedListForKanbanRows(
  rows: ReadonlyArray<{
    id: number;
    stage:
      | 'Applied'
      | 'Screening'
      | 'Interview'
      | 'Offer'
      | 'Hired'
      | 'Rejected';
    applicant_user_id: number;
    applicant_name: string;
    reference_no: string;
    applied_at: Date;
  }>,
): void {
  queryMock.mockResolvedValueOnce(
    rows.map(
      (r) =>
        ({
          id: r.id,
          uuid: `uuid-${r.id}`,
          reference_no: r.reference_no,
          applicant_user_id: r.applicant_user_id,
          stage: r.stage,
          applied_at: r.applied_at,
          applicant_name: r.applicant_name,
          applicant_email: 'test@example.com',
        }) as unknown as RowDataPacket,
    ),
  );
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

describe('GET /admin/jobs/:id/kanban — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      // Mirror the production admin-guard behaviour for missing
      // sessions: 302 → /id/login plus cookie clearing.
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/jobs/${JOB_ID}/kanban`,
      });

      // The admin-guard's redirect is the canonical "no admin access"
      // response — production code never returns a literal 401 for
      // browser-facing admin pages. The substantive assertion is that
      // the kanban handler did NOT run: no DB query was issued.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/jobs/:id/kanban — Super_Admin happy path', () => {
  it('renders 200 with all six column headings', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedFindJobByIdSuccess({ departmentId: JOB_DEPARTMENT_ID });
    seedListForKanbanRows([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/jobs/${JOB_ID}/kanban`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);

      // All six column headings rendered.
      for (const stage of [
        'Applied',
        'Screening',
        'Interview',
        'Offer',
        'Hired',
        'Rejected',
      ]) {
        expect(res.body).toContain(`>${stage}<`);
      }

      // Every empty column shows the placeholder.
      const placeholders = (res.body.match(/No applications/g) ?? []).length;
      expect(placeholders).toBe(6);

      // The page header carries the slug for orientation.
      expect(res.body).toContain('senior-fe-engineer');

      // Sortable script is included so 29.2 has it on first visit.
      expect(res.body).toContain('/assets/js/sortable.min.js');
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/jobs/:id/kanban — Department_Head scoping (Req 11.4)', () => {
  it('returns 200 when the scope INCLUDES the job\'s department', async () => {
    requireAdminMock.mockResolvedValueOnce(
      fakeAdminSession('Department_Head', {
        departments: [JOB_DEPARTMENT_ID, 7],
      }),
    );
    seedFindJobByIdSuccess({ departmentId: JOB_DEPARTMENT_ID });
    seedListForKanbanRows([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/jobs/${JOB_ID}/kanban`,
      });

      expect(res.statusCode).toBe(200);
      // The board still renders the six column headings.
      expect(res.body).toContain('>Applied<');
      expect(res.body).toContain('>Rejected<');
      // Read-only badge present (Dept_Head cannot drag).
      expect(res.body).toMatch(/Read-only/);
      // Cards in this view are read-only — no hx-post hooks.
      expect(res.body).not.toMatch(/hx-post="\/api\/applications\//);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the scope does NOT include the job\'s department (no row leak)', async () => {
    requireAdminMock.mockResolvedValueOnce(
      fakeAdminSession('Department_Head', {
        departments: [99], // not 3
      }),
    );
    // findJobById fires the SELECT but the scope check rejects the row.
    seedFindJobByIdOutOfScope({ departmentId: JOB_DEPARTMENT_ID });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/jobs/${JOB_ID}/kanban`,
      });

      expect(res.statusCode).toBe(404);
      // The kanban query MUST NOT have run — only the job lookup.
      // findJobById fires a single query when the scope rejects.
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/jobs/:id/kanban — missing job', () => {
  it('returns 404 when the job id does not exist', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedFindJobByIdMissing();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/jobs/${JOB_ID}/kanban`,
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the id segment is not a positive integer', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/jobs/abc/kanban',
      });

      expect(res.statusCode).toBe(404);
      // No DB call: parseIdParam rejected the segment first.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/jobs/:id/kanban — card rendering', () => {
  it('renders the kanban-card markup for each application, grouped by stage', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedFindJobByIdSuccess({ departmentId: JOB_DEPARTMENT_ID });
    seedListForKanbanRows([
      {
        id: 11,
        stage: 'Applied',
        applicant_user_id: 100,
        applicant_name: 'Andi Wijaya',
        reference_no: 'APP-2025-000011',
        applied_at: new Date('2025-04-01T00:00:00Z'),
      },
      {
        id: 22,
        stage: 'Interview',
        applicant_user_id: 200,
        applicant_name: 'Budi Santoso',
        reference_no: 'APP-2025-000022',
        applied_at: new Date('2025-03-25T00:00:00Z'),
      },
      {
        id: 33,
        stage: 'Hired',
        applicant_user_id: 300,
        applicant_name: 'Citra Lestari',
        reference_no: 'APP-2025-000033',
        applied_at: new Date('2025-02-15T00:00:00Z'),
      },
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/jobs/${JOB_ID}/kanban`,
      });

      expect(res.statusCode).toBe(200);

      // Each card carries the partial's markup hooks.
      expect(res.body).toContain('data-application-id="11"');
      expect(res.body).toContain('data-application-id="22"');
      expect(res.body).toContain('data-application-id="33"');

      // Reference numbers + applicant names from the partial.
      expect(res.body).toContain('APP-2025-000011');
      expect(res.body).toContain('Andi Wijaya');
      expect(res.body).toContain('APP-2025-000022');
      expect(res.body).toContain('Budi Santoso');
      expect(res.body).toContain('APP-2025-000033');
      expect(res.body).toContain('Citra Lestari');

      // The htmx hook for the stage transition endpoint is present
      // for Super_Admin. The actual JS handler ships with task 29.2.
      expect(res.body).toContain('hx-post="/api/applications/11/stage"');
      expect(res.body).toContain('hx-post="/api/applications/22/stage"');

      // Cards are placed inside the right stage's column. The kanban
      // board is rendered as six `<section data-stage="...">` blocks
      // with a `<ul data-stage="..."` list inside each. We assert
      // that the card HTML appears AFTER its column's data-stage tag
      // and BEFORE the next data-stage tag, which is the simplest
      // way to verify bucketing in a rendered template.
      const indexOf = (needle: string) => res.body.indexOf(needle);
      expect(indexOf('data-application-id="11"')).toBeGreaterThan(
        indexOf('data-stage="Applied"'),
      );
      expect(indexOf('data-application-id="11"')).toBeLessThan(
        indexOf('data-stage="Screening"'),
      );
      expect(indexOf('data-application-id="22"')).toBeGreaterThan(
        indexOf('data-stage="Interview"'),
      );
      expect(indexOf('data-application-id="22"')).toBeLessThan(
        indexOf('data-stage="Offer"'),
      );
      expect(indexOf('data-application-id="33"')).toBeGreaterThan(
        indexOf('data-stage="Hired"'),
      );
      expect(indexOf('data-application-id="33"')).toBeLessThan(
        indexOf('data-stage="Rejected"'),
      );
    } finally {
      await app.close();
    }
  });
});
