/**
 * Public_Site jobs integration test (task 22.2).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 22.2 — public job list + detail endpoints.
 * Design  : §4.3 (htmx auto-refresh, JSON-LD), §6 Public.
 * Validates:
 *   - Requirement 2.3 — `GET /:locale/jobs` lists Published jobs with
 *                        keyword search and filter facets.
 *   - Requirement 2.4 — `GET /:locale/jobs/:slug` renders detail
 *                        including title, location, employment_type,
 *                        level, description, requirements,
 *                        responsibilities, posting date, and deadline.
 *   - Requirement 2.5 — detail page emits a `JobPosting` JSON-LD
 *                        block conforming to schema.org.
 *   - Requirement 2.8 — non-Published rows return HTTP 404.
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   against real Nunjucks rendering. The only boundary we mock is
 *   `src/infra/db.ts` so each test deterministically programs the
 *   `query()` responses for the search COUNT / list / facet
 *   aggregations and for the slug lookup. This mirrors the seam
 *   `public-pages.spec.ts` already uses for the landing page.
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
vi.mock('../../src/routes/admin.js', () => ({
  default: async () => undefined,
  adminRoutes: async () => undefined,
}));

// Import after mocks register so the production module graph picks up
// the mocked db boundary.
const { buildApp } = await import('../../src/server.js');
const searchModule = await import('../../src/modules/jobs/search.js');

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
 * Seed mock responses for `searchPublishedJobs(filter)` which fires:
 *   1. COUNT(*)                              → total rows
 *   2. SELECT … LIMIT ? OFFSET ?             → paginated list
 *   3. SELECT location AS value … GROUP BY   → location facet
 *   4. SELECT department_id AS value …       → department facet
 *   5. SELECT employment_type AS value …     → employment_type facet
 *   6. SELECT level AS value …               → level facet
 *
 * The facets are computed via `Promise.all` inside `getFacets()` so
 * the calls fan out concurrently — but `queryMock.mockResolvedValueOnce`
 * resolves them in registration order, which is deterministic.
 */
function seedSearchResponse(options: {
  total: number;
  rows: ReadonlyArray<{
    id: number;
    slug: string;
    location: string;
    employment_type: string;
    level: string;
    department_id: number | null;
    published_at: Date | string | null;
    application_deadline: string | null;
  }>;
}): void {
  // 1. COUNT(*)
  queryMock.mockResolvedValueOnce([
    { n: options.total } as unknown as RowDataPacket,
  ]);
  // 2. list
  queryMock.mockResolvedValueOnce(
    options.rows.map((r) => ({ ...r }) as unknown as RowDataPacket),
  );
  // 3-6. facets — empty buckets are fine; the page just renders 0
  // checkboxes which is the natural behaviour for a fresh test schema.
  queryMock.mockResolvedValueOnce([]); // location
  queryMock.mockResolvedValueOnce([]); // department
  queryMock.mockResolvedValueOnce([]); // employment_type
  queryMock.mockResolvedValueOnce([]); // level
}

/**
 * Seed mock responses for `findBySlug(slug)` which fires:
 *   1. SELECT … FROM job_postings WHERE slug = ? LIMIT 1
 *   2. SELECT … FROM job_postings WHERE id = ? LIMIT 1   (via findById)
 *   3. SELECT … FROM job_posting_translations WHERE job_id = ?
 *
 * Pass `row=null` to mark "slug not found" — we only seed the first
 * query in that case so the route 404s.
 */
function seedFindBySlugResponse(options: {
  row: {
    id: number;
    uuid: string;
    slug: string;
    department_id: number | null;
    location: string;
    employment_type: string;
    level: string;
    status: string;
    salary_min: number | null;
    salary_max: number | null;
    salary_currency: string | null;
    application_deadline: string | null;
    published_at: Date | null;
    created_by: number;
    created_at: Date;
    updated_at: Date;
  } | null;
  translations?: ReadonlyArray<{
    job_id: number;
    locale: 'id' | 'en';
    title: string;
    description: string;
    requirements: string;
    responsibilities: string;
  }>;
}): void {
  if (options.row === null) {
    // 1. slug lookup → empty.
    queryMock.mockResolvedValueOnce([]);
    return;
  }
  // 1. slug lookup → row.
  queryMock.mockResolvedValueOnce([
    { ...options.row } as unknown as RowDataPacket,
  ]);
  // 2. id lookup (findById internally) → same row.
  queryMock.mockResolvedValueOnce([
    { ...options.row } as unknown as RowDataPacket,
  ]);
  // 3. translations.
  queryMock.mockResolvedValueOnce(
    (options.translations ?? []).map(
      (t) => ({ ...t }) as unknown as RowDataPacket,
    ),
  );
}

const SAMPLE_PUBLISHED_ROW = {
  id: 7,
  uuid: '01HQABCDEF',
  slug: 'data-analyst-jakarta',
  department_id: 3,
  location: 'Jakarta',
  employment_type: 'full-time',
  level: 'mid',
  status: 'Published',
  salary_min: 10000000,
  salary_max: 15000000,
  salary_currency: 'IDR',
  application_deadline: '2099-12-31',
  published_at: new Date('2024-06-01T00:00:00Z'),
  created_by: 1,
  created_at: new Date('2024-05-01T00:00:00Z'),
  updated_at: new Date('2024-06-01T00:00:00Z'),
};

const SAMPLE_TRANSLATIONS = [
  {
    job_id: 7,
    locale: 'id' as const,
    title: 'Data Analyst Senior',
    description: 'Membantu tim data dalam menganalisis tren pasar.',
    requirements: 'Pengalaman 3+ tahun di analitik data.',
    responsibilities: 'Membuat laporan mingguan dan dashboard.',
  },
  {
    job_id: 7,
    locale: 'en' as const,
    title: 'Senior Data Analyst',
    description: 'Help the data team analyze market trends.',
    requirements: '3+ years of experience in data analytics.',
    responsibilities: 'Build weekly reports and dashboards.',
  },
];

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  // Drop the in-process facet cache so each test sees a deterministic
  // sequence of `query()` calls instead of a cache hit on the second
  // case.
  searchModule.clearSearchCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — list endpoint
// ---------------------------------------------------------------------------

describe('Public_Site — GET /:locale/jobs (list)', () => {
  it('renders the Indonesian list page with the empty-state message when no rows match', async () => {
    seedSearchResponse({ total: 0, rows: [] });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/jobs' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Indonesian heading + empty-state copy from the template.
      expect(res.body).toMatch(/Lowongan/);
      expect(res.body).toMatch(/Tidak ada lowongan/);
      // The htmx swap target is present so the AJAX form has a place
      // to land its results.
      expect(res.body).toMatch(/id="jobs-results"/);
    } finally {
      await app.close();
    }
  });

  it('renders the English list page with the empty-state message', async () => {
    seedSearchResponse({ total: 0, rows: [] });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/en/jobs' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Open Positions/);
      expect(res.body).toMatch(/No jobs match your search/);
    } finally {
      await app.close();
    }
  });

  it('passes the keyword filter through to the FULLTEXT MATCH query', async () => {
    seedSearchResponse({
      total: 1,
      rows: [
        {
          id: 7,
          slug: 'engineer-jakarta',
          location: 'Jakarta',
          employment_type: 'full-time',
          level: 'mid',
          department_id: null,
          published_at: new Date('2024-06-01T00:00:00Z'),
          application_deadline: null,
        },
      ],
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/jobs?keyword=engineer',
      });
      expect(res.statusCode).toBe(200);
      // The slug appears in the rendered card list.
      expect(res.body).toMatch(/engineer-jakarta/);

      // First call is the COUNT(*); inspect its SQL + params to
      // confirm the keyword sanitiser produced the expected MATCH …
      // AGAINST clause and bound the keyword as a parameter.
      const firstCall = queryMock.mock.calls[0] as [string, unknown[]];
      expect(firstCall[0]).toMatch(/SELECT COUNT\(\*\)/i);
      expect(firstCall[0]).toMatch(/MATCH\(j\.search_text\) AGAINST/i);
      // sanitiser converts "engineer" -> "+\"engineer\"*"
      expect(firstCall[1]).toContain('+"engineer"*');
    } finally {
      await app.close();
    }
  });

  it('passes the employment_type filter through to the IN clause', async () => {
    seedSearchResponse({ total: 0, rows: [] });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/jobs?employment_type=full-time',
      });
      expect(res.statusCode).toBe(200);

      // First call is the COUNT(*); the WHERE clause must include the
      // employment_type IN (?) predicate and bind 'full-time'.
      const firstCall = queryMock.mock.calls[0] as [string, unknown[]];
      expect(firstCall[0]).toMatch(/employment_type IN/i);
      expect(firstCall[1]).toContain('full-time');
    } finally {
      await app.close();
    }
  });

  it('renders only the partial when HX-Request: true is supplied', async () => {
    seedSearchResponse({ total: 0, rows: [] });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/jobs',
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // No layout — the partial must NOT include the doctype or <html>.
      expect(res.body).not.toMatch(/<!doctype/i);
      expect(res.body).not.toMatch(/<html/i);
      // But the swap target is still there.
      expect(res.body).toMatch(/id="jobs-results"/);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — detail endpoint
// ---------------------------------------------------------------------------

describe('Public_Site — GET /:locale/jobs/:slug (detail)', () => {
  it('renders the detail page with title and JSON-LD JobPosting block', async () => {
    seedFindBySlugResponse({
      row: SAMPLE_PUBLISHED_ROW,
      translations: SAMPLE_TRANSLATIONS,
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/jobs/data-analyst-jakarta',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // The active-locale title appears in the rendered body.
      expect(res.body).toContain('Data Analyst Senior');
      // The JSON-LD block must be present and tagged as a JobPosting.
      expect(res.body).toMatch(
        /<script type="application\/ld\+json"[^>]*>/,
      );
      expect(res.body).toMatch(/"@type":\s*"JobPosting"/);
      expect(res.body).toMatch(/"datePosted"/);
      expect(res.body).toMatch(/"hiringOrganization"/);
      // The Apply CTA points at the locale-prefixed apply URL.
      expect(res.body).toMatch(
        /href="\/id\/jobs\/data-analyst-jakarta\/apply"/,
      );
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the slug does not exist', async () => {
    seedFindBySlugResponse({ row: null });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/jobs/missing-slug',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the slug exists but the status is not Published (Req 2.8)', async () => {
    seedFindBySlugResponse({
      row: { ...SAMPLE_PUBLISHED_ROW, status: 'Draft' },
      translations: SAMPLE_TRANSLATIONS,
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/jobs/data-analyst-jakarta',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
