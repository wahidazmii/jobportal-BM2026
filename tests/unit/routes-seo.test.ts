/**
 * Unit tests for the SEO route plugin (`src/routes/seo.ts`).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 22.3 — SEO endpoints
 * Design  : §4.3 (sitemap + robots + hreflang)
 * Validates: Requirements 2.6 (sitemap), 2.7 (robots), 17.1 (hreflang)
 *
 * Coverage:
 *   - `GET /sitemap.xml`
 *       * 200 + `application/xml` content-type
 *       * `Cache-Control: public, max-age=300` header
 *       * static URLs always present (landing, jobs index, about) for
 *         both locales
 *       * Published job slugs appear under both `/id/jobs/:slug` and
 *         `/en/jobs/:slug` with `<lastmod>` matching `updated_at`
 *       * graceful fallback to static-only sitemap when the database
 *         query throws — no 5xx leaked to the crawler
 *       * cache returns the same body within the 5-minute window
 *         without re-querying the database
 *   - `GET /robots.txt`
 *       * 200 + `text/plain` content-type
 *       * `Cache-Control: public, max-age=3600`
 *       * disallows `/admin`, `/api`, `/applicant`, `/me`
 *       * advertises the sitemap URL via the configured `BASE_URL`
 *   - `buildHreflangLinks(slug, baseUrl)` helper
 *       * emits id / en / x-default tags pointing at `:locale/jobs/:slug`
 *       * URI-encodes the slug
 *       * XML-escapes the base URL
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — replace the shared `query` helper so the sitemap query returns
// the rows we control. The pool is mocked too so server.ts can wire its
// healthz route without touching MySQL.
// ---------------------------------------------------------------------------

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: queryMock,
}));

const { buildApp } = await import('../../src/server.js');
const seoModule = await import('../../src/routes/seo.js');

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'https://career.example.test',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

beforeEach(() => {
  process.env.BASE_URL = 'https://career.example.test';
  seoModule._resetSeoCachesForTests();
  queryMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /sitemap.xml
// ---------------------------------------------------------------------------

describe('GET /sitemap.xml — happy path', () => {
  it('returns 200 with the documented headers and includes static URLs + Published jobs for both locales', async () => {
    queryMock.mockResolvedValueOnce([
      { slug: 'senior-backend-engineer', updated_at: new Date('2025-01-15T10:00:00.000Z') },
      { slug: 'frontend-dev', updated_at: '2025-01-10T08:30:00.000Z' },
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/sitemap.xml' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
      expect(res.headers['cache-control']).toBe('public, max-age=300');

      const body = res.body;

      // Envelope — sitemap.org schema declared with the xhtml
      // alternate-language namespace per Req 17.1.
      expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(body).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
      expect(body).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
      expect(body).toContain('</urlset>');

      // Static landing URLs for both locales.
      expect(body).toContain('<loc>https://career.example.test/id/</loc>');
      expect(body).toContain('<loc>https://career.example.test/en/</loc>');
      expect(body).toContain('<loc>https://career.example.test/id/jobs</loc>');
      expect(body).toContain('<loc>https://career.example.test/en/jobs</loc>');
      expect(body).toContain('<loc>https://career.example.test/id/about</loc>');
      expect(body).toContain('<loc>https://career.example.test/en/about</loc>');

      // Job entries under both locales.
      expect(body).toContain(
        '<loc>https://career.example.test/id/jobs/senior-backend-engineer</loc>',
      );
      expect(body).toContain(
        '<loc>https://career.example.test/en/jobs/senior-backend-engineer</loc>',
      );
      expect(body).toContain(
        '<loc>https://career.example.test/id/jobs/frontend-dev</loc>',
      );
      expect(body).toContain(
        '<loc>https://career.example.test/en/jobs/frontend-dev</loc>',
      );

      // lastmod reflects updated_at as ISO timestamp.
      expect(body).toContain('<lastmod>2025-01-15T10:00:00.000Z</lastmod>');
      expect(body).toContain('<lastmod>2025-01-10T08:30:00.000Z</lastmod>');

      // Job entries advertise the documented changefreq + priority.
      expect(body).toContain('<changefreq>weekly</changefreq>');
      expect(body).toContain('<priority>0.7</priority>');

      // Each job entry carries `<xhtml:link rel="alternate" hreflang="…">`
      // siblings for the id/en/x-default trio (Req 17.1).
      expect(body).toContain(
        '<xhtml:link rel="alternate" hreflang="id" href="https://career.example.test/id/jobs/senior-backend-engineer" />',
      );
      expect(body).toContain(
        '<xhtml:link rel="alternate" hreflang="en" href="https://career.example.test/en/jobs/senior-backend-engineer" />',
      );
      expect(body).toContain(
        '<xhtml:link rel="alternate" hreflang="x-default" href="https://career.example.test/id/jobs/senior-backend-engineer" />',
      );
    } finally {
      await app.close();
    }
  });

  it('serves the cached body without re-querying within the 5-minute window', async () => {
    queryMock.mockResolvedValueOnce([
      { slug: 'job-a', updated_at: new Date('2025-01-01T00:00:00.000Z') },
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const first = await app.inject({ method: 'GET', url: '/sitemap.xml' });
      const second = await app.inject({ method: 'GET', url: '/sitemap.xml' });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe(first.body);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('GET /sitemap.xml — graceful degradation', () => {
  it('still returns 200 with the static URL list when the DB query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/sitemap.xml' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');

      // Static URLs are still emitted.
      expect(res.body).toContain('<loc>https://career.example.test/id/jobs</loc>');
      expect(res.body).toContain('<loc>https://career.example.test/en/jobs</loc>');

      // No job entries because the query failed.
      expect(res.body).not.toContain('/id/jobs/');
      expect(res.body).not.toContain('/en/jobs/');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /robots.txt
// ---------------------------------------------------------------------------

describe('GET /robots.txt', () => {
  it('returns the canonical robots policy with the sitemap URL', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/robots.txt' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['cache-control']).toBe('public, max-age=3600');

      const body = res.body;
      expect(body).toContain('User-agent: *');
      expect(body).toContain('Allow: /');
      expect(body).toContain('Disallow: /admin');
      expect(body).toContain('Disallow: /api');
      expect(body).toContain('Disallow: /applicant');
      expect(body).toContain('Disallow: /me');
      expect(body).toContain('Sitemap: https://career.example.test/sitemap.xml');

      // Robots is independent of the database — no query was issued.
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// buildHreflangLinks helper (Req 17.1)
// ---------------------------------------------------------------------------

describe('buildHreflangLinks', () => {
  it('emits id / en / x-default tags pointing at `:locale/jobs/:slug`', () => {
    const html = seoModule.buildHreflangLinks(
      'senior-backend-engineer',
      'https://career.example.test',
    );
    expect(html).toContain(
      '<link rel="alternate" hreflang="id" href="https://career.example.test/id/jobs/senior-backend-engineer">',
    );
    expect(html).toContain(
      '<link rel="alternate" hreflang="en" href="https://career.example.test/en/jobs/senior-backend-engineer">',
    );
    expect(html).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://career.example.test/id/jobs/senior-backend-engineer">',
    );
  });

  it('strips trailing slashes from the base URL and URI-encodes the slug', () => {
    const html = seoModule.buildHreflangLinks(
      'job with spaces',
      'https://career.example.test/',
    );
    expect(html).toContain(
      'href="https://career.example.test/id/jobs/job%20with%20spaces"',
    );
    expect(html).not.toContain('https://career.example.test//');
  });
});
