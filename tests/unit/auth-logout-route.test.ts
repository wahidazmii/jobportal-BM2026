/**
 * Unit tests for the logout route plugin (`src/routes/auth.ts`,
 * task 10.2).
 *
 * Validates: Requirement 3.5 (Design §6 Auth, §8.4)
 *
 * The plugin only talks to two boundaries:
 *   - the session-store's `destroy(sid)` function, and
 *   - the response cookie API (`reply.clearCookie`).
 *
 * We mock `destroy()` so the suite stays hermetic and exercise the
 * route end-to-end via Fastify's `inject()`.
 *
 * Cases covered:
 *   - Happy path: a valid `__Host-sid` cookie is destroyed server-side
 *     and the reply returns 302 to `/{locale}/` with both
 *     `__Host-sid` and `csrf_token` cookies cleared.
 *   - No-cookie path (idempotent): a request without any session
 *     cookie still returns 302 + clears cookies and never invokes
 *     `destroy()` (we skip the round-trip on garbage / missing input).
 *   - Unknown locale: the locale segment is validated against
 *     `{id, en}` and any other value 404s before any DB work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Mock the session-store's `destroy()` so we can assert the route
// invokes it with the cookie value.
const destroySessionMock = vi.fn();
vi.mock('../../src/infra/session-store.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/session-store.js')
  >('../../src/infra/session-store.js');
  return {
    ...actual,
    destroy: destroySessionMock,
  };
});

// Stub the password-reset plugin so the server bootstrap does not drag
// its own service mocks into this test.
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));

// Import after mocks are registered.
const { buildApp } = await import('../../src/server.js');
const { TOKEN_LENGTH } = await import('../../src/infra/session-store.js');

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

/** A 43-character base64url string that mimics a real session id. */
const SAMPLE_SID = 'a'.repeat(TOKEN_LENGTH);

/**
 * Parse the (possibly multi-valued) `set-cookie` header into an array
 * of strings. Fastify's inject returns either a string or an array
 * depending on how many cookies were set.
 */
function setCookieHeaders(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  destroySessionMock.mockReset();
  destroySessionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /:locale/logout — happy path
// ---------------------------------------------------------------------------

describe('POST /:locale/logout — happy path', () => {
  it('destroys the session, clears both cookies, and redirects 302 to /{locale}/', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/logout',
        cookies: { [`__Host-sid`]: SAMPLE_SID },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/');

      // The server-side row was destroyed with the EXACT cookie value.
      expect(destroySessionMock).toHaveBeenCalledTimes(1);
      expect(destroySessionMock).toHaveBeenCalledWith(SAMPLE_SID);

      // Both cookies are cleared on the response.
      const cookies = setCookieHeaders(res);
      const sessionCleared = cookies.find((c) => c.startsWith('__Host-sid='));
      const csrfCleared = cookies.find((c) => c.startsWith('csrf_token='));
      expect(sessionCleared).toBeDefined();
      expect(csrfCleared).toBeDefined();

      // `Max-Age=0` (or an `Expires=` in the past) is the canonical
      // cookie-deletion marker `@fastify/cookie`'s `clearCookie` emits.
      // Match either form to keep this resilient to library detail.
      const isCleared = (c: string): boolean =>
        /Max-Age=0/i.test(c) ||
        /Expires=Thu, 01 Jan 1970/i.test(c);
      expect(isCleared(sessionCleared as string)).toBe(true);
      expect(isCleared(csrfCleared as string)).toBe(true);

      // Path attributes mirror issuance attributes (Path=/) so the
      // browser actually drops the cookies.
      expect(sessionCleared).toMatch(/Path=\//);
      expect(csrfCleared).toMatch(/Path=\//);
    } finally {
      await app.close();
    }
  });

  it('redirects to /en/ when the locale segment is en', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/en/logout',
        cookies: { [`__Host-sid`]: SAMPLE_SID },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/en/');
      expect(destroySessionMock).toHaveBeenCalledWith(SAMPLE_SID);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/logout — idempotent path
// ---------------------------------------------------------------------------

describe('POST /:locale/logout — no session cookie (idempotent)', () => {
  it('still redirects 302 to /{locale}/ and does NOT invoke destroy()', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/logout',
        // No cookies at all.
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/');
      expect(destroySessionMock).not.toHaveBeenCalled();

      // Still issues clearCookie for both cookies — the response should
      // also blank any stale state the browser may still hold.
      const cookies = setCookieHeaders(res);
      expect(cookies.some((c) => c.startsWith('__Host-sid='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('csrf_token='))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('skips destroy() when the cookie is malformed (wrong length)', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/logout',
        cookies: { [`__Host-sid`]: 'short' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/');
      expect(destroySessionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/logout — unknown locale
// ---------------------------------------------------------------------------

describe('POST /:locale/logout — unknown locale', () => {
  it('rejects an unsupported locale segment with 404 before any DB work', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/fr/logout',
        cookies: { [`__Host-sid`]: SAMPLE_SID },
      });

      expect(res.statusCode).toBe(404);
      expect(destroySessionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
