/**
 * Public_Site pages integration test (task 22.4).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 22.4 — landing dan about pages.
 * Design  : §6 Public (HTTP routing map), §13 (i18n).
 * Validates:
 *   - Requirement 2.1 — `GET /:locale/` renders the landing page with
 *                        the featured-jobs CTA.
 *   - Requirement 2.2 — `GET /:locale/about` renders the about page
 *                        with locale-specific company copy.
 *   - Requirement 17.2 — `/` redirects to `/id/` (default locale) and
 *                        unsupported locale segments return 404.
 *
 * Scope:
 *   This test exercises the FULL Fastify app via `buildApp()` plus
 *   `app.inject()` so every public route, the security-headers
 *   plugin, the Nunjucks renderer, and the public layout template
 *   run end-to-end. The only boundary we mock is the database
 *   layer (`src/infra/db.ts`); the jobs repo's `list()` runs against
 *   the mocked `query()` so the featured-jobs strip behaves like
 *   production. This mirrors the integration-test seam already used
 *   by `auth-flow.test.ts` and `cv-upload.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

/** `pool.query` is invoked only by `/healthz`; we never hit it here. */
const poolQueryMock = vi.fn();

/**
 * `query()` is the prepared-statement helper used by the jobs repo.
 * The landing route calls `repo.list({ status: ['Published'], pageSize: 6 })`
 * which under the hood runs a COUNT(*) followed by a SELECT — both
 * pass through this mock. Each test programs the responses in
 * arrival order via `mockResolvedValueOnce`.
 */
const queryMock = vi.fn();

/** `withTransaction` is unused on the public site but kept for parity. */
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: poolQueryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: queryMock,
  withTransaction: withTransactionMock,
}));

/**
 * Stub sibling route plugins so the server bootstrap does not require
 * their service mocks. Only the public + SEO plugins are exercised
 * here; the rest are unrelated to the routes under test.
 */
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
vi.mock('../../src/routes/admin.js', () => ({
  default: async () => undefined,
  adminRoutes: async () => undefined,
}));

// Import after mocks register so the production module graph picks up
// the mocked db boundary.
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

/**
 * Default jobs-repo response programmed before each test that
 * renders the landing page. `list()` runs two queries — first the
 * COUNT(*), then the paginated SELECT — so we seed both. Tests that
 * want different rows can call `queryMock.mockReset()` and program
 * their own sequence.
 */
function seedEmptyFeaturedJobsResponse(): void {
  queryMock.mockReset();
  // 1. COUNT(*) → 0 rows.
  queryMock.mockResolvedValueOnce([
    { n: 0 } as unknown as RowDataPacket,
  ]);
  // 2. SELECT … LIMIT ? OFFSET ? → empty list.
  queryMock.mockResolvedValueOnce([]);
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Public_Site pages — landing + about + root redirect', () => {
  it('GET / redirects 302 to /id/', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/');
      // The redirect must not run the featured-jobs query.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('GET /id/ renders the landing page with the Indonesian hero copy', async () => {
    seedEmptyFeaturedJobsResponse();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Brand + tagline copy proves the public layout + landing
      // template ran end-to-end with locale=id.
      expect(res.body).toContain('PT Buana Megah');
      expect(res.body).toMatch(/Karier di PT Buana Megah/);
      expect(res.body).toMatch(/Lihat Lowongan/);
      // CTA points at the locale-prefixed jobs list.
      expect(res.body).toMatch(/href="\/id\/jobs"/);
    } finally {
      await app.close();
    }
  });

  it('GET /en/ renders the landing page with the English variant', async () => {
    seedEmptyFeaturedJobsResponse();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/en/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Careers at PT Buana Megah/);
      expect(res.body).toMatch(/Browse Jobs/);
      // Empty-state copy in English.
      expect(res.body).toMatch(/No open positions/i);
      expect(res.body).toMatch(/href="\/en\/jobs"/);
    } finally {
      await app.close();
    }
  });

  it('GET /id/about renders the Indonesian about page', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/about' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Tentang PT Buana Megah/);
      // The about route never runs the featured-jobs query.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('GET /en/about renders the English about page', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/en/about' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/About PT Buana Megah/);
    } finally {
      await app.close();
    }
  });

  it('GET /fr/ returns 404 for an unsupported locale and never queries the repo', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/' });
      expect(res.statusCode).toBe(404);
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('GET /fr/about returns 404 for an unsupported locale on the about route', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/about' });
      expect(res.statusCode).toBe(404);
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
