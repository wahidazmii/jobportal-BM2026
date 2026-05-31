/**
 * Integration test for the Applicant_Area withdraw route (task 26.2).
 *
 * Validates: Requirement 5.8 (Design §6 Applicant_Area)
 *
 * Route: POST /:locale/me/applications/:id/withdraw
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `inject()` so
 *   every plugin (security headers, cookies, formbody, view engine)
 *   and the real route handler run end-to-end. Two boundaries are
 *   mocked:
 *     - `src/infra/db.ts`           — the prepared-statement + tx
 *                                     boundary. `withTransaction` runs
 *                                     against an in-memory script that
 *                                     mirrors the withdraw SQL order.
 *     - `src/infra/auth-guard.ts`   — `requireApplicant` returns a
 *                                     canonical Applicant session, or
 *                                     short-circuits to a 302 login
 *                                     redirect (production behaviour).
 *
 *   Cases covered:
 *     1. POST without a session → 302 to `/id/login` (auth-guard
 *        short-circuit; no DB work).
 *     2. POST a valid withdraw → 302 redirect to the detail page.
 *     3. POST for an application that is NOT owned by the session user
 *        → 404 (owner-scoped read returns no row; no row leak).
 *     4. POST for an application in a terminal stage (Hired) → 409.
 *
 * Note on CSRF: the CSRF preHandler (`registerCsrf`) is not wired into
 * the instance returned by `buildApp()` (see `src/server.ts`), so this
 * suite does not assert the 403 path — that behaviour is covered by the
 * dedicated CSRF unit tests for `src/infra/csrf.ts`.
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

// Stub sibling route plugins so the bootstrap does not pull their mocks.
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

// Import after mocks register.
const { buildApp } = await import('../../src/server.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLICANT_USER_ID = 42;
const APPLICATION_ID = 11;

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://localhost',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

/** Canonical SessionRecord for an authenticated Applicant. */
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

/** Build a mysql2 ResultSetHeader. */
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

/**
 * Wire `withTransactionMock` to invoke its callback against a scripted
 * fake connection. `stageRow` controls the result of the FOR UPDATE
 * lock-read: `null` simulates "no row for this applicant" (not-found),
 * a string simulates the current stage.
 */
function installFakeTransaction(stageRow: string | null): void {
  withTransactionMock.mockImplementation(async (fn) => {
    const conn = {
      execute: vi.fn(async (sql: string) => {
        if (/FROM applications\s+WHERE id = \? AND applicant_user_id = \?/.test(sql)) {
          if (stageRow === null) {
            return [[] as RowDataPacket[], []];
          }
          return [
            [
              {
                id: APPLICATION_ID,
                stage: stageRow,
              } as unknown as RowDataPacket,
            ],
            [],
          ];
        }
        if (/UPDATE applications SET stage = 'Withdrawn'/.test(sql)) {
          return [header(0, 1), []];
        }
        if (/INSERT INTO application_stage_history/.test(sql)) {
          return [header(99, 1), []];
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
// Tests
// ---------------------------------------------------------------------------

describe('POST /:locale/me/applications/:id/withdraw — authentication', () => {
  it('returns 302 to /id/login when the session is missing', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/id/me/applications/${APPLICATION_ID}/withdraw`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // No DB work happened — the guard short-circuited.
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /:locale/me/applications/:id/withdraw — happy path', () => {
  it('returns 302 redirect to the detail page on a valid withdraw', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    installFakeTransaction('Applied');

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/id/me/applications/${APPLICATION_ID}/withdraw`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        `/id/me/applications/${APPLICATION_ID}`,
      );
      // htmx clients also get the HX-Redirect header.
      expect(res.headers['hx-redirect']).toBe(
        `/id/me/applications/${APPLICATION_ID}`,
      );
      expect(withTransactionMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /:locale/me/applications/:id/withdraw — owner scoping', () => {
  it("returns 404 when the application is not owned by the session user", async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    // FOR UPDATE read returns no row → ApplicationNotFoundError → 404.
    installFakeTransaction(null);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/applications/999/withdraw',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // No reference number leaks for another applicant's row.
      expect(res.body).not.toMatch(/APP-\d{4}-\d{6}/);
    } finally {
      await app.close();
    }
  });
});

describe('POST /:locale/me/applications/:id/withdraw — terminal stage', () => {
  it('returns 409 when the application is already in a terminal stage', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    installFakeTransaction('Hired');

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/id/me/applications/${APPLICATION_ID}/withdraw`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('terminal_stage');
    } finally {
      await app.close();
    }
  });
});

describe('POST /:locale/me/applications/:id/withdraw — locale guard', () => {
  it('returns 404 for an unsupported locale segment before auth runs', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/fr/me/applications/${APPLICATION_ID}/withdraw`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(404);
      expect(requireApplicantMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
