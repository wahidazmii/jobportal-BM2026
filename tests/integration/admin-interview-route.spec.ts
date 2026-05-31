/**
 * Admin schedule-interview route integration test (task 30.2).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.2 — Schedule interview
 * Design  : §6 Admin (POST /admin/applications/:id/interview)
 * Validates: Requirement 10.4
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   so the route handler and the interview service run end-to-end. Two
 *   boundaries are mocked, mirroring `admin-kanban.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        Each test programs the `query()` responses for the
 *        `loadApplication` SELECT and the `findJobById` round-trip,
 *        plus the interview INSERT read-back.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin` returns a
 *        canonical AdminSession when the test wants one; otherwise it
 *        short-circuits to a 302 redirect to `/id/login`, matching the
 *        production admin-guard behaviour.
 *
 *   Sibling route plugins (auth / password / applicant / public / seo)
 *   are stubbed so the bootstrap does not pull in their service mocks.
 *
 *   CSRF is handled by registering the app with `nodeEnv='test'`, which
 *   matches the other admin integration specs — the inject calls carry
 *   no browser cookies, so we rely on the same harness behaviour the
 *   kanban spec relies on (the guard short-circuit / handler path is
 *   what we assert here, not the CSRF middleware).
 *
 * Cases:
 *   1. Unauthenticated POST → admin-guard short-circuit to /id/login.
 *   2. Super_Admin with valid input → 201 { ok: true, interview }.
 *   3. Past scheduledAt → 422 invalid_interview_input.
 *   4. Department_Head whose scope excludes the job's department → 404.
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

const APPLICATION_ID = 555;
const JOB_ID = 42;
const JOB_DEPARTMENT_ID = 3;
const INTERVIEW_ID = 9001;

const FUTURE_AT = '2099-06-10T09:30:00.000Z';
const PAST_AT = '2000-01-01T09:30:00.000Z';

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

/** Seed the `loadApplication` SELECT so the service finds the row. */
function seedApplicationRow(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: APPLICATION_ID,
      job_id: JOB_ID,
      applicant_user_id: 321,
      reference_no: 'APP-2025-000555',
    } as unknown as RowDataPacket,
  ]);
}

/**
 * Seed the `findJobById(id, scope)` round-trip for an in-scope job.
 * The repo fires two queries when the row matches: the job row and the
 * translations.
 */
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

/**
 * Seed the `findJobById` row read for an OUT-OF-SCOPE job. The repo
 * fires a single query (the row exists) but the scope check rejects it,
 * so the translations fetch is short-circuited.
 */
function seedFindJobByIdOutOfScope(): void {
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
}

/**
 * Seed the interview INSERT + read-back. The repo issues an INSERT
 * (ResultSetHeader with insertId) followed by a SELECT for the row.
 */
function seedInterviewInsert(): void {
  // INSERT → ResultSetHeader-shaped object with the new id.
  queryMock.mockResolvedValueOnce({
    insertId: INTERVIEW_ID,
    affectedRows: 1,
  } as unknown as RowDataPacket);
  // Read-back SELECT.
  queryMock.mockResolvedValueOnce([
    {
      id: INTERVIEW_ID,
      application_id: APPLICATION_ID,
      scheduled_at: new Date(FUTURE_AT),
      location: 'HQ Meeting Room 3',
      meeting_url: null,
      interviewer_user_id: 12,
      status: 'scheduled',
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

describe('POST /admin/applications/:id/interview — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/interview`,
        payload: { scheduledAt: FUTURE_AT, location: 'HQ Room 1' },
      });

      // The admin-guard's redirect is the canonical "no admin access"
      // response. The substantive assertion is that the handler did NOT
      // run: no DB query was issued.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/interview — Super_Admin happy path', () => {
  it('returns 201 with the persisted interview on valid input', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedApplicationRow();
    seedFindJobByIdSuccess();
    seedInterviewInsert();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/interview`,
        payload: {
          scheduledAt: FUTURE_AT,
          location: 'HQ Meeting Room 3',
          interviewerUserId: '12',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        ok: boolean;
        interview: { id: number; application_id: number; status: string };
      };
      expect(body.ok).toBe(true);
      expect(body.interview.id).toBe(INTERVIEW_ID);
      expect(body.interview.application_id).toBe(APPLICATION_ID);
      expect(body.interview.status).toBe('scheduled');
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/interview — validation', () => {
  it('returns 422 when scheduledAt is in the past', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));
    seedApplicationRow();
    seedFindJobByIdSuccess();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/interview`,
        payload: { scheduledAt: PAST_AT, location: 'HQ Room 1' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as {
        error: string;
        fields: Record<string, string[]>;
      };
      expect(body.error).toBe('invalid_interview_input');
      expect(body.fields.scheduledAt).toBeDefined();
      // The interview INSERT must never have run.
      // loadApplication + findJobById fired (3 queries); no INSERT.
      expect(queryMock).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/interview — Department_Head scoping (Req 11.4)', () => {
  it("returns 404 when the scope does NOT include the job's department (no row leak)", async () => {
    requireAdminMock.mockResolvedValueOnce(
      fakeAdminSession('Department_Head', { departments: [99] }),
    );
    seedApplicationRow();
    seedFindJobByIdOutOfScope();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/interview`,
        payload: { scheduledAt: FUTURE_AT, location: 'HQ Room 1' },
      });

      expect(res.statusCode).toBe(404);
      // loadApplication (1) + findJobById row read (1) = 2 queries; the
      // scope rejection short-circuits before the translations fetch
      // and before any INSERT.
      expect(queryMock).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
