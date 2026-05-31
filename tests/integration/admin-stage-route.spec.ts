/**
 * Admin stage-transition route integration test (task 29.2).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 29.2 — Stage transition endpoint
 * Design  : §6 Admin (POST /api/applications/:id/stage), §15
 * Validates: Requirements 10.2, 8.1, 12.1
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   so the route handler, the stage service, and the Nunjucks card
 *   partial all run end-to-end. Two boundaries are mocked, mirroring
 *   `admin-kanban.spec.ts` / `admin-interview-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        `withTransaction` runs the service callback against a scripted
 *        fake connection; `query()` feeds the post-commit
 *        `findKanbanCard` read-back.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin`. For the happy /
 *        invalid cases the mock returns a canonical AdminSession; for
 *        the Department_Head case the mock mirrors the PRODUCTION guard
 *        (403 when the role is outside `allowedRoles`), because the
 *        stage endpoint restricts to {Super_Admin, HR} (Dept_Head is
 *        read-only on the kanban per task 29.1); for the unauthenticated
 *        case it short-circuits with a 302 to /id/login.
 *
 *   Sibling route plugins are stubbed so the bootstrap does not pull in
 *   their service mocks.
 *
 * Cases:
 *   1. Unauthenticated POST → admin-guard short-circuit to /id/login.
 *   2. Super_Admin valid transition → 200 + re-rendered card fragment.
 *   3. Invalid transition → 422 invalid_stage_transition.
 *   4. Department_Head → 403 (guard rejects: stage endpoint is
 *      HR/Super_Admin only).
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

const APPLICATION_ID = 555;
const JOB_ID = 42;
const APPLICANT_USER_ID = 321;
const REFERENCE_NO = 'APP-2025-000555';

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

/**
 * Script the `withTransaction` callback against a fake connection whose
 * `execute(sql)` returns the next matching response. Mirrors the unit
 * test's fake transaction but inlined for the integration harness.
 */
function installFakeTransaction(
  responses: Array<{ match: RegExp; response: readonly [unknown, unknown] }>,
): void {
  withTransactionMock.mockImplementation(async (fn: (conn: unknown) => unknown) => {
    const remaining = [...responses];
    const conn = {
      execute: vi.fn(async (sql: string) => {
        const idx = remaining.findIndex((r) => r.match.test(sql));
        if (idx === -1) {
          throw new Error(
            'fakeTransaction: no scripted response for SQL: ' +
              sql.split('\n')[0]!.slice(0, 120),
          );
        }
        const item = remaining[idx]!;
        remaining.splice(idx, 1);
        return item.response;
      }),
    };
    return fn(conn);
  });
}

/** FOR UPDATE lock-row response for a given current stage. */
function lockRowResponse(stage: string): readonly [RowDataPacket[], unknown] {
  return [
    [
      {
        id: APPLICATION_ID,
        job_id: JOB_ID,
        applicant_user_id: APPLICANT_USER_ID,
        reference_no: REFERENCE_NO,
        stage,
      } as unknown as RowDataPacket,
    ],
    [],
  ];
}

/** Seed the post-commit `findKanbanCard` read-back via the global query(). */
function seedFindKanbanCard(stage: string): void {
  queryMock.mockResolvedValueOnce([
    {
      id: APPLICATION_ID,
      uuid: `uuid-${APPLICATION_ID}`,
      reference_no: REFERENCE_NO,
      applicant_user_id: APPLICANT_USER_ID,
      stage,
      applied_at: new Date('2025-04-01T00:00:00Z'),
      applicant_name: 'Andi Wijaya',
      applicant_email: 'andi@test',
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

describe('POST /api/applications/:id/stage — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/applications/${APPLICATION_ID}/stage`,
        payload: { stage: 'Screening' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // The handler never ran: no transaction, no read-back.
      expect(withTransactionMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/applications/:id/stage — Super_Admin happy path', () => {
  it('returns 200 with the re-rendered kanban card fragment on a valid transition', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    installFakeTransaction([
      { match: /FOR UPDATE/, response: lockRowResponse('Applied') },
      { match: /UPDATE applications SET stage/, response: [{ affectedRows: 1 }, []] },
      { match: /INSERT INTO application_stage_history/, response: [{ affectedRows: 1 }, []] },
      { match: /INSERT INTO audit_events/, response: [{ affectedRows: 1 }, []] },
    ]);
    seedFindKanbanCard('Screening');

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/applications/${APPLICATION_ID}/stage`,
        payload: { stage: 'Screening' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // The re-rendered card partial carries the moved card markup with
      // the new stage badge.
      expect(res.body).toContain(`data-application-id="${APPLICATION_ID}"`);
      expect(res.body).toContain('data-stage="Screening"');
      expect(res.body).toContain(REFERENCE_NO);
      expect(res.body).toContain('Andi Wijaya');
      // htmx swap trigger header present.
      expect(res.headers['hx-trigger']).toBe('stage-changed');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/applications/:id/stage — invalid transition', () => {
  it('returns 422 invalid_stage_transition for a disallowed pair', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));
    installFakeTransaction([
      { match: /FOR UPDATE/, response: lockRowResponse('Applied') },
      // No UPDATE / INSERT scripted — the transition guard rejects first.
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/applications/${APPLICATION_ID}/stage`,
        payload: { stage: 'Hired' }, // Applied → Hired is not allowed
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; from: string; to: string };
      expect(body.error).toBe('invalid_stage_transition');
      expect(body.from).toBe('Applied');
      expect(body.to).toBe('Hired');
      // No card read-back on a failed transition.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 422 invalid_stage for an unknown destination stage', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/applications/${APPLICATION_ID}/stage`,
        payload: { stage: 'Promoted' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string };
      expect(body.error).toBe('invalid_stage');
      // The destination was rejected before any DB work.
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/applications/:id/stage — Department_Head RBAC (Req 11.4)', () => {
  it('returns 403 because the stage endpoint is HR/Super_Admin only (Dept_Head read-only)', async () => {
    const session = fakeAdminSession('Department_Head', { departments: [JOB_ID] });
    requireAdminMock.mockImplementationOnce(guardRespectingAllowedRoles(session));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/applications/${APPLICATION_ID}/stage`,
        payload: { stage: 'Screening' },
      });

      expect(res.statusCode).toBe(403);
      // The guard rejected before any DB work.
      expect(withTransactionMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
