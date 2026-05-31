/**
 * Integration test for the Applicant_Area applications list / detail
 * routes (task 27.1).
 *
 * Validates: Requirements 5.6, 5.7 (Design §6 Applicant_Area)
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `inject()`
 *   against real Nunjucks rendering. Two boundaries are mocked:
 *     - `src/infra/db.ts`           — so each test programs the
 *       `query()` responses for the rate-limit, session-store, list
 *       and detail queries.
 *     - `src/infra/auth-guard.js`   — so we can deterministically
 *       toggle "no session" vs "Applicant session #42".
 *
 *   Cases covered:
 *     1. `GET /id/me/applications` without a session → 302 to
 *        `/id/login` (Req 3.5 + auth-guard contract).
 *     2. `GET /id/me/applications` with a session → 200, rendered
 *        body contains the application reference number (Req 5.6).
 *     3. `GET /id/me/applications/999` for an id that is NOT owned
 *        by the session user → 404 with the applicant 404 page
 *        (Req 5.7 — no row leak).
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

/** Stub sibling route plugins so we don't need their service mocks. */
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

// Import after mocks register so the production module graph picks up
// the mocked db / auth-guard boundaries.
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

const APPLICANT_USER_ID = 42;

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

describe('GET /:locale/me/applications  (task 27.1)', () => {
  it('redirects to /:locale/login when the session is missing', async () => {
    requireApplicantMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/applications',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // No DB calls made because the auth guard short-circuited.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('renders the list with application reference numbers when the session is valid', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());

    // 1. COUNT(*) → 1 row total.
    queryMock.mockResolvedValueOnce([
      { n: 1 } as unknown as RowDataPacket,
    ]);
    // 2. Page query → one row.
    queryMock.mockResolvedValueOnce([
      {
        id: 11,
        uuid: 'uuid-11',
        reference_no: 'APP-2025-000011',
        job_id: 5,
        job_slug: 'senior-fe-engineer',
        job_location: 'Jakarta',
        stage: 'Applied',
        applied_at: new Date('2025-03-01T00:00:00.000Z'),
        hired_at: null,
        job_title: 'Insinyur Senior',
      },
    ] as unknown as RowDataPacket[]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/applications',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Body must contain the reference number — the most stable
      // human-readable signal that the row rendered.
      expect(res.body).toContain('APP-2025-000011');
      // The job title (from the requested-locale translation) is
      // rendered too.
      expect(res.body).toContain('Insinyur Senior');
      // The detail link target is the row id, not the uuid.
      expect(res.body).toContain('/id/me/applications/11');
    } finally {
      await app.close();
    }
  });
});

describe('GET /:locale/me/applications/:id  (task 27.1, Req 5.7 no-leak)', () => {
  it('returns 404 when the application id is not owned by the session user', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());

    // The owner-scoped SELECT returns no rows because the WHERE clause
    // requires both id AND applicant_user_id to match. The detail
    // helper short-circuits with `null` so we expect ONE query call.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/applications/999',
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // The body is the canonical applicant 404 page — there is NO
      // mention of any reference number / job title that would
      // indicate the row exists for somebody else.
      expect(res.body).not.toMatch(/APP-\d{4}-\d{6}/);
      // We expect to have made exactly one query (the owner-scoped
      // SELECT). The follow-up history / notes queries are skipped
      // because the row was missing.
      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/WHERE a\.id = \? AND a\.applicant_user_id = \?/i);
      // applicationId, applicantId at the END of the params list.
      expect(params[params.length - 2]).toBe(999);
      expect(params[params.length - 1]).toBe(APPLICANT_USER_ID);
    } finally {
      await app.close();
    }
  });
});
