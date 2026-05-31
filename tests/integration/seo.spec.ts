/**
 * SEO endpoints integration test (task 22.3).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 22.3 — `/sitemap.xml`, `/robots.txt`, hreflang.
 * Design  : §4.3 — sitemap dinamis 5-menit cache, robots.txt, hreflang.
 * Validates:
 *   - Requirement 2.6 — `GET /sitemap.xml` lists every Published
 *                        Job_Posting URL with `<lastmod>` from the
 *                        repository's `updated_at`.
 *   - Requirement 2.7 — `GET /robots.txt` allows crawling of public
 *                        pages and disallows `/admin`, `/api`,
 *                        `/applicant` (plus `/me` per Design §6).
 *   - Requirement 17.1 — hreflang `id ↔ en` alternates surface inside
 *                        each job sitemap entry as
 *                        `<xhtml:link rel="alternate" hreflang="…">`
 *                        siblings.
 *
 * Scope:
 *   The test boots the full Fastify app via `buildApp()` (so the SEO
 *   plugin is registered in its production wiring) and uses
 *   `app.inject()` for in-process HTTP calls. Only the database
 *   boundary (`src/infra/db.ts`) is mocked; no MySQL is required.
 *
 *   The unit-test counterpart `tests/unit/routes-seo.test.ts` covers
 *   the renderer details (XML envelope, escaping, helpers). This
 *   file focuses on the three endpoint contracts plus the cache
 *   contract that the orchestrator explicitly asks for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

/** `pool.query` is consulted only by `/healthz`; we never hit it here. */
const poolQueryMock = vi.fn();

/**
 * `query()` is the prepared-statement helper used by the SEO plugin
 * to fetch every Published job's slug + `updated_at`. Each test
 * programs the response via `mockResolvedValueOnce`.
 */
const queryMock = vi.fn();

/** `withTransaction` is unused on the SEO surface; stubbed for parity. */
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
 * Stub sibling route plugins so the bootstrap does not require their
 * service mocks. Only the SEO plugin is exercised here; the rest are
 * unrelated to the routes under test.
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
vi.mock('../../src/routes/public.js', () => ({
  default: async () => undefined,
  publicRoutes: async () => undefined,
}));

// Import after mocks register so the production graph picks up the
// mocked db boundary.
const { buildApp } = await import('../../src/server.js');
const seoModule = await import('../../src/routes/seo.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'https://career.example.test',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

const PUBLISHED_JOBS = [
  {
    slug: 'senior-backend-engineer',
    updated_at: new Date('2025-01-15T10:00:00.000Z'),
  },
  {
    slug: 'frontend-dev',
    updated_at: new Date('2025-01-10T08:30:00.000Z'),
  },
] as const;

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.BASE_URL = 'https://career.example.test';
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  // Reset the in-memory cache so each test sees a fresh state.
  seoModule._resetSeoCachesForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SEO endpoints — sitemap.xml, robots.txt, hreflang', () => {
  it('GET /sitemap.xml returns 200 application/xml with <urlset>, landing locales, and Published job <loc> + ISO <lastmod>', async () => {
    queryMock.mockResolvedValueOnce(PUBLISHED_JOBS);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/sitemap.xml' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');

      const body = res.body;

      // urlset envelope present.
      expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(body).toMatch(/<urlset[^>]*xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
      expect(body).toContain('</urlset>');

      // Landing URLs for both locales.
      expect(body).toContain('<loc>https://career.example.test/id/</loc>');
      expect(body).toContain('<loc>https://career.example.test/en/</loc>');

      // At least one published job slug appears under both locales.
      expect(body).toContain(
        '<loc>https://career.example.test/id/jobs/senior-backend-engineer</loc>',
      );
      expect(body).toContain(
        '<loc>https://career.example.test/en/jobs/senior-backend-engineer</loc>',
      );

      // <lastmod> values are ISO 8601 timestamps (YYYY-MM-DDTHH:MM:SS.sssZ).
      const lastmodMatches = body.match(
        /<lastmod>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)<\/lastmod>/g,
      );
      expect(lastmodMatches).not.toBeNull();
      // One row per locale per job → 2 jobs × 2 locales = 4 entries.
      expect(lastmodMatches?.length).toBeGreaterThanOrEqual(4);

      // hreflang alternates inside each job entry (Req 17.1).
      expect(body).toContain('<xhtml:link rel="alternate" hreflang="id"');
      expect(body).toContain('<xhtml:link rel="alternate" hreflang="en"');
    } finally {
      await app.close();
    }
  });

  it('GET /robots.txt returns 200 text/plain with User-agent + Allow + all required Disallow lines and the Sitemap line', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/robots.txt' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');

      const body = res.body;
      expect(body).toContain('User-agent: *');
      expect(body).toContain('Allow: /');
      expect(body).toContain('Disallow: /admin');
      expect(body).toContain('Disallow: /api');
      expect(body).toContain('Disallow: /applicant');
      expect(body).toContain('Disallow: /me');
      expect(body).toContain('Sitemap: https://career.example.test/sitemap.xml');

      // robots.txt is independent of the database — never queries it.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('two consecutive GET /sitemap.xml requests inside the 5-minute TTL hit the repo only once', async () => {
    queryMock.mockResolvedValueOnce(PUBLISHED_JOBS);

    const app = await buildApp(TEST_CONFIG);
    try {
      const first = await app.inject({ method: 'GET', url: '/sitemap.xml' });
      const second = await app.inject({ method: 'GET', url: '/sitemap.xml' });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe(first.body);
      // Cache contract: only one DB call regardless of request count.
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
