/**
 * Unit tests for the Public_Site route plugin
 * (`src/routes/public.ts`, task 22.4).
 *
 * Validates: Requirements 2.1, 2.2, 17.2 (Design §6 Public_Site).
 *
 * The plugin talks to one boundary: the jobs repo (`list` from
 * `src/modules/jobs/repo.ts`), which we mock so the suite stays
 * hermetic. The full job-CRUD path is covered separately.
 *
 * Cases covered:
 *   - GET / → 302 to /id/.
 *   - GET /:locale/ (id, en) renders 200 HTML with the featured strip
 *     populated from `list({ status: ['Published'], pageSize: 6 })`.
 *   - GET /:locale/ with a DB failure still renders 200 (best-effort
 *     featured strip — landing must never 500 because of a transient
 *     jobs query hiccup).
 *   - GET /:locale/about renders 200 HTML with the static about copy.
 *   - GET on an unsupported locale segment returns 404 without
 *     touching the jobs repo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

// DB pool — used by the healthz route only; never invoked here.
vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

// Jobs repo — stub `list()` so the route's featured-strip query is
// driven from the test rather than a real connection.
const listJobsMock = vi.fn();
vi.mock('../../src/modules/jobs/repo.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/jobs/repo.js')
  >('../../src/modules/jobs/repo.js');
  return {
    ...actual,
    list: listJobsMock,
  };
});

// Stub sibling route plugins so the server bootstrap does not drag in
// their service mocks. We exercise only the public plugin here.
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

// Import after mocks are registered.
const { buildApp } = await import('../../src/server.js');

// ---------------------------------------------------------------------------
// Helpers
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

/** Build a minimal `JobPosting`-shaped record sufficient for templating. */
function fakeJob(slug: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 1,
    uuid: 'uuid-' + slug,
    slug,
    department_id: null,
    location: 'Jakarta',
    employment_type: 'full-time',
    level: 'mid',
    status: 'Published',
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    application_deadline: null,
    published_at: new Date('2024-01-01T00:00:00Z'),
    created_by: 1,
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  listJobsMock.mockReset();
});

afterEach(() => {
  listJobsMock.mockReset();
});

// ---------------------------------------------------------------------------
// GET / — root redirect (Req 17.2)
// ---------------------------------------------------------------------------

describe('GET /', () => {
  it('redirects 302 to /id/', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/');
      // The featured-jobs query must not run for the redirect.
      expect(listJobsMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/ — landing page (Req 2.1)
// ---------------------------------------------------------------------------

describe('GET /:locale/ (landing)', () => {
  it('renders the landing page with up to 6 featured Published jobs (id)', async () => {
    listJobsMock.mockResolvedValueOnce({
      rows: [fakeJob('manager-jakarta'), fakeJob('engineer-bandung')],
      total: 2,
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Indonesian CTA copy.
      expect(res.body).toMatch(/Lihat Lowongan/);
      // Featured slug rendered as a placeholder card title.
      expect(res.body).toMatch(/manager-jakarta/);
      expect(res.body).toMatch(/engineer-bandung/);
      // CTA links to /id/jobs.
      expect(res.body).toMatch(/href="\/id\/jobs"/);

      expect(listJobsMock).toHaveBeenCalledTimes(1);
      const [filter] = listJobsMock.mock.calls[0];
      expect(filter).toMatchObject({
        status: ['Published'],
        pageSize: 6,
      });
    } finally {
      await app.close();
    }
  });

  it('renders the en variant when locale=en', async () => {
    listJobsMock.mockResolvedValueOnce({ rows: [], total: 0 });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/en/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Browse Jobs/);
      // Empty-state message (en).
      expect(res.body).toMatch(/No open positions/i);
      expect(res.body).toMatch(/href="\/en\/jobs"/);
    } finally {
      await app.close();
    }
  });

  it('renders 200 with an empty featured strip if the repo throws', async () => {
    listJobsMock.mockRejectedValueOnce(new Error('db down'));

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/' });
      // Best-effort: the homepage must not 500 because of a transient
      // jobs-query hiccup. The CTA still works for the visitor.
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Lihat Lowongan/);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unsupported locale without touching the repo', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/' });
      expect(res.statusCode).toBe(404);
      expect(listJobsMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/about — about page (Req 2.2)
// ---------------------------------------------------------------------------

describe('GET /:locale/about', () => {
  it('renders the id about page with the company copy', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/about' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Tentang PT Buana Megah/);
      // Does not run the jobs query for the about page.
      expect(listJobsMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('renders the en variant when locale=en', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/en/about' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/About PT Buana Megah/);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unsupported locale', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/about' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
