/**
 * Bookmarks routes integration test (task 28.1).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 28.1 — Toggle endpoint + bookmarks list page.
 * Design  : §4.2 (htmx interaction patterns), §6 Applicant_Area.
 * Validates:
 *   - Requirement 6.4 — `POST /api/bookmarks/toggle` flips the
 *                        bookmark on/off; the response carries the
 *                        rendered button partial with the new state.
 *   - Requirement 6.5 — `GET /:locale/me/bookmarks` lists the saved
 *                        jobs (200 with HTML).
 *   - Requirement 6.6 — covered indirectly here (the unit test
 *                        exhaustively asserts the inactive/expired
 *                        flagging in the service); this suite focuses
 *                        on HTTP plumbing.
 *
 * Scope:
 *   This test exercises the FULL Fastify app via `buildApp()` plus
 *   `app.inject()` so every plugin (security headers, cookies,
 *   formbody, view engine) and the real route handler run end-to-end.
 *   We mock only:
 *
 *     1. `src/infra/db.ts`          — the prepared-statement boundary.
 *     2. `src/infra/auth-guard.ts`  — `requireApplicant` returns a
 *                                      canonical Applicant session
 *                                      when the test wants one;
 *                                      otherwise it short-circuits to
 *                                      a 302 redirect to the login
 *                                      page (matching the production
 *                                      behaviour).
 *
 *   Sibling route plugins (auth / password) are stubbed so the server
 *   bootstrap does not pull in their service mocks.
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

// Import after the mocks register so the production module graph picks
// up the mocked db / auth-guard boundaries.
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

/**
 * Install `requireApplicant` to behave like the unauthenticated
 * production path: short-circuit with a 302 to /id/login and return
 * `null`.
 */
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
 * Wire `withTransactionMock` to invoke its callback against an
 * in-memory bookmarks set. The set tracks `(applicantUserId, jobId)`
 * pairs so two consecutive toggle calls in the same test correctly
 * flip the state. The fake driver script mirrors the SQL emitted by
 * `bookmarks/service.ts`:
 *
 *   1. SELECT 1 ... FOR UPDATE
 *   2a. DELETE FROM bookmarks ...      (when row exists)
 *   OR
 *   2b. SELECT id FROM job_postings    (when row missing)
 *   3b. INSERT INTO bookmarks ...
 */
let fakeBookmarks: Set<string>;
const KNOWN_JOB_ID = 7;

function installFakeTransaction(): void {
  withTransactionMock.mockImplementation(async (fn) => {
    const conn = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('SELECT 1 AS hit FROM bookmarks')) {
          const [userId, jobId] = params as [number, number];
          const key = `${userId}:${jobId}`;
          if (fakeBookmarks.has(key)) {
            return [
              [{ hit: 1 } as unknown as RowDataPacket],
              [],
            ];
          }
          return [[] as RowDataPacket[], []];
        }
        if (sql.startsWith('DELETE FROM bookmarks')) {
          const [userId, jobId] = params as [number, number];
          const key = `${userId}:${jobId}`;
          const removed = fakeBookmarks.delete(key);
          return [header(0, removed ? 1 : 0), []];
        }
        if (sql.startsWith('SELECT id FROM job_postings')) {
          const [jobId] = params as [number];
          if (jobId === KNOWN_JOB_ID) {
            return [
              [{ id: jobId } as unknown as RowDataPacket],
              [],
            ];
          }
          return [[] as RowDataPacket[], []];
        }
        if (sql.startsWith('INSERT INTO bookmarks')) {
          const [userId, jobId] = params as [number, number];
          fakeBookmarks.add(`${userId}:${jobId}`);
          return [header(0, 1), []];
        }
        throw new Error('unexpected SQL in fake transaction: ' + sql);
      }),
    };
    return fn(conn as never);
  });
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  requireApplicantMock.mockReset();
  fakeBookmarks = new Set<string>();
  installFakeTransaction();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /api/bookmarks/toggle
// ---------------------------------------------------------------------------

describe('POST /api/bookmarks/toggle — authentication', () => {
  it('returns 302 to /id/login when the session is missing (auth-guard short-circuit)', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/toggle',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ jobId: KNOWN_JOB_ID }),
      });

      // The auth-guard's redirect is the canonical "missing session"
      // response in this app — the production browser flow follows
      // it directly, and integration tests verify that the redirect
      // is emitted rather than the route running.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');

      // No DB work should have happened.
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/bookmarks/toggle — happy path (two consecutive calls)', () => {
  it('first call returns the filled bookmark icon; second call returns the outline icon', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());

    const app = await buildApp(TEST_CONFIG);
    try {
      // ── First toggle: not bookmarked → bookmarked. ────────────────
      const first = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/toggle',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ jobId: KNOWN_JOB_ID }),
      });

      expect(first.statusCode).toBe(200);
      expect(first.headers['content-type']).toMatch(/text\/html/);
      // The button partial renders the filled star and aria-pressed=true
      // when the new state is bookmarked.
      expect(first.body).toContain('aria-pressed="true"');
      expect(first.body).toContain('bookmark-icon--filled');
      expect(first.body).toContain('★');
      // The button still carries the htmx wiring so the next click
      // can flip it back.
      expect(first.body).toContain('hx-post="/api/bookmarks/toggle"');
      // The hx-vals payload includes the same jobId.
      expect(first.body).toMatch(/hx-vals='\{"jobId":\s*7\}'/);

      // The fake bookmark set now contains the (applicant, job) pair.
      expect(fakeBookmarks.has(`${APPLICANT_USER_ID}:${KNOWN_JOB_ID}`)).toBe(true);

      // ── Second toggle: bookmarked → not bookmarked. ───────────────
      const second = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/toggle',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ jobId: KNOWN_JOB_ID }),
      });

      expect(second.statusCode).toBe(200);
      expect(second.headers['content-type']).toMatch(/text\/html/);
      // The button partial renders the outline star and aria-pressed=false
      // when the new state is unbookmarked.
      expect(second.body).toContain('aria-pressed="false"');
      expect(second.body).toContain('bookmark-icon--outline');
      expect(second.body).toContain('☆');

      // The fake bookmark set no longer contains the pair.
      expect(fakeBookmarks.has(`${APPLICANT_USER_ID}:${KNOWN_JOB_ID}`)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('accepts a form-urlencoded body (htmx default) and toggles correctly', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/toggle',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `jobId=${KNOWN_JOB_ID}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('aria-pressed="true"');
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the target job does not exist', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/toggle',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ jobId: 9999 }),
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('job_not_found');
      // No bookmark row was created.
      expect(fakeBookmarks.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns 400 when jobId is missing from the body', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/toggle',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('invalid_body');
      expect(body.errors).toBeDefined();
      // No DB work happened.
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/me/bookmarks
// ---------------------------------------------------------------------------

describe('GET /:locale/me/bookmarks — authentication', () => {
  it('returns 302 to /id/login when the session is missing', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/bookmarks',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // No DB work should have happened.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /:locale/me/bookmarks — happy path', () => {
  it('returns 200 with a rendered HTML list of saved jobs', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());

    // Program the SELECT_BOOKMARKS_SQL response — one row per saved job.
    queryMock.mockResolvedValueOnce([
      {
        jobId: 1,
        bookmarkedAt: new Date('2025-01-05T10:00:00Z'),
        slug: 'senior-engineer',
        status: 'Published',
        location: 'Jakarta',
        applicationDeadline: null,
        title: 'Senior Engineer',
      } as unknown as RowDataPacket,
      {
        jobId: 2,
        bookmarkedAt: new Date('2025-01-04T10:00:00Z'),
        slug: 'data-analyst',
        status: 'Closed',
        location: 'Bandung',
        applicationDeadline: '2099-01-01',
        title: 'Data Analyst',
      } as unknown as RowDataPacket,
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/bookmarks',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Page title rendered.
      expect(res.body).toMatch(/Lowongan Tersimpan/);
      // Both jobs rendered.
      expect(res.body).toContain('Senior Engineer');
      expect(res.body).toContain('Data Analyst');
      // The Closed job carries the "no longer available" badge and
      // does NOT render an Apply CTA.
      expect(res.body).toMatch(/Tidak tersedia lagi/);
      // The Published job DOES render the Apply CTA.
      expect(res.body).toMatch(/Lamar Sekarang/);
      // Bookmark toggle button is embedded for each row.
      expect(res.body).toContain('id="bookmark-btn-1"');
      expect(res.body).toContain('id="bookmark-btn-2"');
    } finally {
      await app.close();
    }
  });

  it('renders the empty state when the applicant has no bookmarks', async () => {
    requireApplicantMock.mockResolvedValue(fakeSession());
    queryMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/bookmarks',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Anda belum menyimpan lowongan apa pun/);
      expect(res.body).toMatch(/Telusuri lowongan/);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unsupported locale segment', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/fr/me/bookmarks',
      });

      expect(res.statusCode).toBe(404);
      // The locale check happens before the auth guard, so
      // requireApplicant is never invoked.
      expect(requireApplicantMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
