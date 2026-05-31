/**
 * Unit / integration tests for the registration route plugin
 * (`src/routes/auth.ts`, task 9.2).
 *
 * Validates: Requirements 14.1, 14.2 (Design §6 Auth, §8.1)
 *
 * The plugin talks to three boundaries: the MySQL pool (rate-limit and
 * healthz queries), the registration service (`src/modules/auth/register.ts`),
 * and the captcha verifier. We mock all three so the suite stays hermetic
 * and fast — the goal is to nail down the route contract:
 *
 *   - GET  /:locale/register renders the form with a 200 OK.
 *   - POST /:locale/register on the happy path renders the generic
 *     "check your email" page and increments the rate-limit bucket.
 *   - POST is rejected with 429 + Retry-After once the bucket is full.
 *   - POST validation errors re-render the form with field errors and
 *     do NOT consume a rate-limit slot.
 *   - The locale segment must be in {'id','en'}; anything else 404s.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

// Pool used by the healthz route — never invoked here, but the mock keeps
// `src/infra/db.ts` import-side-effect-free.
const poolQueryMock = vi.fn();
const queryMock = vi.fn();
vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: poolQueryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: queryMock,
  withTransaction: vi.fn(),
}));

// The registration service is mocked: this test exercises the HTTP plumbing,
// not the database transaction (which `auth-register.test.ts` covers).
const registerServiceMock = vi.fn();
vi.mock('../../src/modules/auth/register.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/auth/register.js')
  >('../../src/modules/auth/register.js');
  return {
    ...actual,
    register: registerServiceMock,
  };
});

// Captcha — same dev-mode bypass we rely on in production for empty tokens.
const verifyCaptchaMock = vi.fn();
vi.mock('../../src/modules/auth/captcha.js', () => ({
  verifyCaptcha: verifyCaptchaMock,
}));

// Password-reset plugin — registered by the server but unrelated to this
// test; stub to avoid dragging in its own service mocks.
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));

// Import after mocks are registered.
const { buildApp } = await import('../../src/server.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAppForTest() {
  return buildApp({
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    baseUrl: 'http://localhost',
    databaseUrl: 'mysql://test',
    sessionSecret: 'test-secret',
    logLevel: 'silent',
  });
}

/**
 * Default rate-limit query result: bucket empty (no row).
 *
 * Note: our mock targets the `query()` helper from `src/infra/db.ts`, which
 * already unwraps the `[rows, fields]` tuple from `pool.execute`. So we
 * return JUST the rows array, not the tuple.
 */
function bucketEmpty(): unknown[] {
  return [];
}

/** Bucket row indicating `count` hits in a fresh window. */
function bucketRow(count: number, ageSeconds = 30): unknown[] {
  return [{ count, age_seconds: ageSeconds }];
}

beforeAll(() => {
  // Captcha bypass enabled by default — empty secret in env → verifier
  // returns true. We override per-test when needed.
  verifyCaptchaMock.mockResolvedValue(true);
});

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  registerServiceMock.mockReset();
  verifyCaptchaMock.mockReset();
  verifyCaptchaMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /:locale/register
// ---------------------------------------------------------------------------

describe('GET /:locale/register', () => {
  it('renders the registration form with a 200 OK', async () => {
    queryMock.mockResolvedValueOnce(bucketEmpty()); // rate-limit pre-check
    const app = await buildAppForTest();
    try {
      const res = await app.inject({ method: 'GET', url: '/id/register' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<form'); // form rendered
      expect(res.body).toMatch(/Daftar Akun Pelamar/); // id locale title
    } finally {
      await app.close();
    }
  });

  it('renders the English form for /en/register', async () => {
    queryMock.mockResolvedValueOnce(bucketEmpty());
    const app = await buildAppForTest();
    try {
      const res = await app.inject({ method: 'GET', url: '/en/register' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Create Applicant Account/);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown locale with 404', async () => {
    const app = await buildAppForTest();
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/register' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 429 with Retry-After when the bucket is already full', async () => {
    // bucket at the cap, in a fresh window 30s old → 3570s remaining.
    queryMock.mockResolvedValueOnce(bucketRow(5, 30));
    const app = await buildAppForTest();
    try {
      const res = await app.inject({ method: 'GET', url: '/id/register' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/register — happy path (Req 3.1, 14.1, 14.2)
// ---------------------------------------------------------------------------

describe('POST /:locale/register — happy path', () => {
  it('calls the register service, records a hit, and renders the generic success page', async () => {
    queryMock
      .mockResolvedValueOnce(bucketEmpty()) // checkRateLimit
      .mockResolvedValueOnce({ affectedRows: 1, insertId: 0 }); // recordHit INSERT…ODKU
    registerServiceMock.mockResolvedValueOnce({
      ok: true,
      alreadyRegistered: false,
    });

    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'email=alice%40example.com&password=Password123&consent=on&captchaToken=cap-token',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Generic confirmation page (Req 3.2: same UI for both branches).
      expect(res.body).toMatch(/Periksa Email Anda/);

      // Service was called with the parsed body shape.
      expect(registerServiceMock).toHaveBeenCalledTimes(1);
      const [input] = registerServiceMock.mock.calls[0] as [Record<string, unknown>];
      expect(input.email).toBe('alice@example.com');
      expect(input.password).toBe('Password123');
      expect(input.consent).toBe(true);
      expect(input.captchaToken).toBe('cap-token');

      // Two SQL calls: one rate-limit check, one recordHit.
      expect(queryMock).toHaveBeenCalledTimes(2);
      const [recordSql] = queryMock.mock.calls[1] as [string, unknown[]];
      expect(recordSql).toMatch(/INSERT INTO rate_limits/i);
      expect(recordSql).toMatch(/ON DUPLICATE KEY UPDATE/i);
    } finally {
      await app.close();
    }
  });

  it('produces the SAME response body for a duplicate-email submission (Req 3.2 — no leak)', async () => {
    queryMock
      .mockResolvedValueOnce(bucketEmpty())
      .mockResolvedValueOnce({ affectedRows: 1, insertId: 0 });
    registerServiceMock.mockResolvedValueOnce({
      ok: true,
      alreadyRegistered: true,
    });

    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'email=taken%40example.com&password=Password123&consent=on&captchaToken=cap-token',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Periksa Email Anda/);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/register — validation & rate-limit errors
// ---------------------------------------------------------------------------

describe('POST /:locale/register — validation errors', () => {
  it('re-renders the form with zod field errors and does NOT consume a rate-limit slot', async () => {
    queryMock.mockResolvedValueOnce(bucketEmpty()); // only the pre-check runs
    const { ZodError } = await import('zod');
    registerServiceMock.mockImplementationOnce(async () => {
      const err = new ZodError([
        {
          code: 'too_small',
          minimum: 10,
          type: 'string',
          inclusive: true,
          exact: false,
          message: 'Password must be at least 10 characters',
          path: ['password'],
        },
      ]);
      throw err;
    });

    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'email=alice%40example.com&password=short&consent=on&captchaToken=cap-token',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('<form');
      expect(res.body).toMatch(/Password must be at least 10 characters/);

      // Only the pre-check was issued — no recordHit on validation failure.
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects when captcha verification fails and does NOT call the service', async () => {
    queryMock.mockResolvedValueOnce(bucketEmpty());
    verifyCaptchaMock.mockResolvedValueOnce(false);

    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'email=alice%40example.com&password=Password123&consent=on&captchaToken=bad',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Captcha verification failed/);
      expect(registerServiceMock).not.toHaveBeenCalled();
      // No recordHit — failed captcha must not consume a slot.
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /:locale/register — rate limit', () => {
  it('returns 429 with a Retry-After header when the bucket is already at the cap', async () => {
    queryMock.mockResolvedValueOnce(bucketRow(5, 60));
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'email=alice%40example.com&password=Password123&consent=on&captchaToken=cap-token',
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(registerServiceMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
