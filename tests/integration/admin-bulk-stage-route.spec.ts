/**
 * Admin bulk stage-transition route integration test (task 29.3).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 29.3 — Bulk stage transition
 * Design  : §6 Admin (POST /api/applications/bulk-stage)
 * Validates: Requirements 10.5, 10.6
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   so the route handler and the bulk stage service run end-to-end.
 *   Two boundaries are mocked, mirroring `admin-stage-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        `withTransaction` runs each per-application `changeStage`
 *        callback against a scripted fake connection, keyed by the
 *        application id read off the FOR UPDATE params.
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin`. For the happy /
 *        invalid cases the mock returns a canonical AdminSession; for
 *        the Department_Head case the mock mirrors the PRODUCTION guard
 *        (403 when the role is outside `allowedRoles`); for the
 *        unauthenticated case it short-circuits with a 302 to /id/login.
 *
 *   Sibling route plugins are stubbed so the bootstrap does not pull in
 *   their service mocks.
 *
 * Cases:
 *   1. Unauthenticated POST → admin-guard short-circuit to /id/login.
 *   2. Super_Admin mixed batch → 200 with a results array + counts
 *      (batch not aborted on a per-row failure, Req 10.6).
 *   3. Unknown stage → 422 invalid_stage.
 *   4. Department_Head → 403 (bulk endpoint is HR/Super_Admin only).
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

const JOB_ID = 42;

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
 * the route's `allowedRoles`, send a 403 and return null.
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

/** FOR UPDATE lock-row response for a given id + current stage. */
function lockRow(
  id: number,
  stage: string,
): readonly [RowDataPacket[], unknown] {
  return [
    [
      {
        id,
        job_id: JOB_ID,
        applicant_user_id: 300 + id,
        reference_no: `APP-2025-${String(id).padStart(6, '0')}`,
        stage,
      } as unknown as RowDataPacket,
    ],
    [],
  ];
}

interface IdSpec {
  readonly stage?: string;
  readonly missing?: boolean;
}

/**
 * Drive `withTransaction` so each per-application `changeStage` runs
 * against a fake connection resolving from `byId`, keyed by the FOR
 * UPDATE id param.
 */
function installBulkTransaction(byId: Map<number, IdSpec>): void {
  withTransactionMock.mockImplementation(
    async (fn: (conn: unknown) => unknown) => {
      let currentId = -1;
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (/FOR UPDATE/.test(sql)) {
            currentId = Number(params[0]);
            const spec = byId.get(currentId);
            if (spec === undefined || spec.missing === true) {
              return [[] as RowDataPacket[], []];
            }
            return lockRow(currentId, spec.stage ?? 'Applied');
          }
          if (/UPDATE applications SET stage/.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/INSERT INTO application_stage_history/.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/INSERT INTO audit_events/.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(
            'unscripted SQL: ' + sql.split('\n')[0]!.slice(0, 80),
          );
        }),
      };
      return fn(conn);
    },
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

describe('POST /api/applications/bulk-stage — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/applications/bulk-stage',
        payload: { applicationIds: [1, 2], stage: 'Screening' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/applications/bulk-stage — Super_Admin mixed batch (Req 10.6)', () => {
  it('returns 200 with a per-row results array and success/failure counts', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    installBulkTransaction(
      new Map<number, IdSpec>([
        [501, { stage: 'Applied' }], // Applied → Screening : ok
        [502, { stage: 'Hired' }], // Hired → Screening : invalid_transition
        [503, { missing: true }], // not_found
      ]),
    );

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/applications/bulk-stage',
        payload: { applicationIds: [501, 502, 503], stage: 'Screening' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        succeeded: number;
        failed: number;
        results: Array<{ applicationId: number; ok: boolean; error?: string }>;
      };
      expect(body.ok).toBe(true);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(2);
      expect(body.results).toEqual([
        { applicationId: 501, ok: true, prevStage: 'Applied', newStage: 'Screening' },
        { applicationId: 502, ok: false, error: 'invalid_transition' },
        { applicationId: 503, ok: false, error: 'not_found' },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/applications/bulk-stage — invalid stage', () => {
  it('returns 422 invalid_stage for an unknown destination stage', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/applications/bulk-stage',
        payload: { applicationIds: [1, 2], stage: 'Promoted' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string };
      expect(body.error).toBe('invalid_stage');
      // Rejected before any DB work.
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/applications/bulk-stage — Department_Head RBAC (Req 11.4)', () => {
  it('returns 403 because the bulk endpoint is HR/Super_Admin only', async () => {
    const session = fakeAdminSession('Department_Head', {
      departments: [JOB_ID],
    });
    requireAdminMock.mockImplementationOnce(guardRespectingAllowedRoles(session));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/applications/bulk-stage',
        payload: { applicationIds: [1, 2], stage: 'Screening' },
      });

      expect(res.statusCode).toBe(403);
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
