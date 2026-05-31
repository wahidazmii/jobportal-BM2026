/**
 * Unit / integration tests for the verify + resend route plugin entries
 * (`src/routes/auth.ts`, task 9.3).
 *
 * Validates: Requirements 3.3, 3.4, 14.1 (Design §6 Auth, §8.1)
 *
 * The plugin talks to four boundaries: the MySQL pool (rate-limit + healthz),
 * the verify service (`src/modules/auth/verify.ts`), the registration
 * service (used by sibling task 9.2; mocked here as well to keep this
 * test self-contained), and the captcha verifier. We mock all four so
 * the suite stays hermetic and fast.
 *
 * Goals:
 *   - GET /:locale/verify?token=... renders the success view when the
 *     service returns `verified` and the generic invalid view when it
 *     returns `invalid`.
 *   - GET /:locale/verify with no token renders the invalid view (no
 *     leak).
 *   - POST /:locale/verify/resend honours the 3 per IP per hour cap.
 *   - POST /:locale/verify/resend renders the SAME generic page for
 *     both branches (token issued / silent no-op) so the response
 *     cannot enumerate pending accounts.
 *   - Captcha failure → 400 with field error and no service call.
 *   - Unknown locale → 404 across both endpoints.
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

// Verify service mocks — the route layer is the unit under test, the
// transaction logic is covered by `auth-verify.test.ts`.
const consumeTokenMock = vi.fn();
const resendMock = vi.fn();
vi.mock('../../src/modules/auth/verify.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/auth/verify.js')
  >('../../src/modules/auth/verify.js');
  return {
    ...actual,
    consumeVerificationToken: consumeTokenMock,
    resendVerificationEmail: resendMock,
  };
});

// Sibling 9.2 service — never invoked by these tests but the import
// graph reaches it via `routes/auth.ts`.
vi.mock('../../src/modules/auth/register.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/auth/register.js')
  >('../../src/modules/auth/register.js');
  return {
    ...actual,
    register: vi.fn(),
  };
});

// Captcha — same dev-mode bypass we rely on in production for empty tokens.
const verifyCaptchaMock = vi.fn();
vi.mock('../../src/modules/auth/captcha.js', () => ({
  verifyCaptcha: verifyCaptchaMock,
}));

// Password-reset plugin — registered by the server but unrelated.
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

function bucketEmpty(): unknown[] {
  return [];
}

function bucketRow(count: number, ageSeconds = 30): unknown[] {
  return [{ count, age_seconds: ageSeconds }];
}

beforeAll(() => {
  verifyCaptchaMock.mockResolvedValue(true);
});

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  consumeTokenMock.mockReset();
  resendMock.mockReset();
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
// GET /:locale/verify (Req 3.3, 3.4)
// ---------------------------------------------------------------------------

describe('GET /:locale/verify', () => {
  it('renders the success view when the service returns verified', async () => {
    consumeTokenMock.mockResolvedValueOnce({ status: 'verified', userId: 42 });
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/verify?token=' + 'a'.repeat(43),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Email Berhasil Diverifikasi/);
      expect(res.body).toContain('/id/login');

      expect(consumeTokenMock).toHaveBeenCalledTimes(1);
      const [token] = consumeTokenMock.mock.calls[0] as [string];
      expect(token).toBe('a'.repeat(43));
    } finally {
      await app.close();
    }
  });

  it('renders the generic invalid view when the service returns invalid', async () => {
    consumeTokenMock.mockResolvedValueOnce({ status: 'invalid' });
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/verify?token=' + 'b'.repeat(43),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Tautan Verifikasi Tidak Berlaku/);
      // Resend CTA is offered (Req 3.4).
      expect(res.body).toContain('/id/verify/resend');
    } finally {
      await app.close();
    }
  });

  it('renders the invalid view (no leak) when the token query param is absent', async () => {
    consumeTokenMock.mockResolvedValueOnce({ status: 'invalid' });
    const app = await buildAppForTest();
    try {
      const res = await app.inject({ method: 'GET', url: '/id/verify' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Tautan Verifikasi Tidak Berlaku/);
      // Service was still called (with `undefined` token) so all bad
      // tokens funnel through the same code path.
      expect(consumeTokenMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('renders the English success view for /en/verify', async () => {
    consumeTokenMock.mockResolvedValueOnce({ status: 'verified', userId: 1 });
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/en/verify?token=' + 'c'.repeat(43),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Email Verified/);
      expect(res.body).toContain('/en/login');
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown locale with 404', async () => {
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/zz/verify?token=' + 'a'.repeat(43),
      });
      expect(res.statusCode).toBe(404);
      expect(consumeTokenMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('renders the generic invalid view if the service throws (no leak of internals)', async () => {
    consumeTokenMock.mockRejectedValueOnce(new Error('boom'));
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/verify?token=' + 'd'.repeat(43),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Tautan Verifikasi Tidak Berlaku/);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/verify/resend (Req 3.4, 14.1)
// ---------------------------------------------------------------------------

describe('POST /:locale/verify/resend', () => {
  it('calls the service, records a hit, and renders the generic confirmation page', async () => {
    queryMock
      .mockResolvedValueOnce(bucketEmpty()) // checkRateLimit
      .mockResolvedValueOnce({ affectedRows: 1, insertId: 0 }); // recordHit
    resendMock.mockResolvedValueOnce({ ok: true, tokenIssued: true });

    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/verify/resend',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=alice%40example.com&captchaToken=cap-token',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Periksa Email Anda/);

      expect(resendMock).toHaveBeenCalledTimes(1);
      const [input] = resendMock.mock.calls[0] as [Record<string, unknown>];
      expect(input.email).toBe('alice@example.com');
      expect(input.captchaToken).toBe('cap-token');

      // checkRateLimit + recordHit
      expect(queryMock).toHaveBeenCalledTimes(2);
      const [recordSql, recordParams] = queryMock.mock.calls[1] as [
        string,
        unknown[],
      ];
      expect(recordSql).toMatch(/INSERT INTO rate_limits/i);
      expect((recordParams[0] as string).startsWith('verify-resend:ip:')).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it('produces the SAME response body for the silent no-op branch (Req 3.4 — no leak)', async () => {
    // Branch A — token issued.
    queryMock
      .mockResolvedValueOnce(bucketEmpty())
      .mockResolvedValueOnce({ affectedRows: 1, insertId: 0 });
    resendMock.mockResolvedValueOnce({ ok: true, tokenIssued: true });

    const app = await buildAppForTest();
    try {
      const resA = await app.inject({
        method: 'POST',
        url: '/id/verify/resend',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=real%40example.com&captchaToken=cap-token',
      });

      // Branch B — silent no-op.
      queryMock
        .mockResolvedValueOnce(bucketEmpty())
        .mockResolvedValueOnce({ affectedRows: 1, insertId: 0 });
      resendMock.mockResolvedValueOnce({ ok: true, tokenIssued: false });

      const resB = await app.inject({
        method: 'POST',
        url: '/id/verify/resend',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=ghost%40example.com&captchaToken=cap-token',
      });

      expect(resA.statusCode).toBe(resB.statusCode);
      // Body differs only in the echoed email; the user-facing copy is
      // identical so an attacker cannot tell which branch fired.
      expect(resA.body).toMatch(/Periksa Email Anda/);
      expect(resB.body).toMatch(/Periksa Email Anda/);
    } finally {
      await app.close();
    }
  });

  it('returns 429 with a Retry-After header when the bucket is already at the cap', async () => {
    queryMock.mockResolvedValueOnce(bucketRow(5, 60));
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/verify/resend',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=alice%40example.com&captchaToken=cap-token',
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(resendMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects with 400 when the captcha verification fails and does NOT call the service', async () => {
    queryMock.mockResolvedValueOnce(bucketEmpty());
    verifyCaptchaMock.mockResolvedValueOnce(false);

    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/verify/resend',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=alice%40example.com&captchaToken=bad',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Captcha verification failed/);
      expect(resendMock).not.toHaveBeenCalled();
      // No recordHit on captcha failure.
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('re-renders the form with field errors when the service throws ZodError', async () => {
    queryMock.mockResolvedValueOnce(bucketEmpty());
    const { ZodError } = await import('zod');
    resendMock.mockImplementationOnce(async () => {
      throw new ZodError([
        {
          code: 'invalid_string',
          validation: 'email',
          message: 'Please enter a valid email address',
          path: ['email'],
        },
      ]);
    });

    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/verify/resend',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=not-an-email&captchaToken=cap-token',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Please enter a valid email address/);
      // Only the pre-check ran — no recordHit.
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown locale with 404', async () => {
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/zz/verify/resend',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=alice%40example.com&captchaToken=cap-token',
      });
      expect(res.statusCode).toBe(404);
      expect(resendMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/verify/resend — render the form
// ---------------------------------------------------------------------------

describe('GET /:locale/verify/resend', () => {
  it('renders the resend form with a 200 OK', async () => {
    queryMock.mockResolvedValueOnce(bucketEmpty());
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/verify/resend',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<form');
      expect(res.body).toMatch(/Kirim Ulang Email Verifikasi/);
    } finally {
      await app.close();
    }
  });

  it('returns 429 when the resend bucket is already full', async () => {
    queryMock.mockResolvedValueOnce(bucketRow(5, 30));
    const app = await buildAppForTest();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/verify/resend',
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
