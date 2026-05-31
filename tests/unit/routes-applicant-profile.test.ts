/**
 * Unit tests for the Applicant_Area profile route plugin
 * (`src/routes/applicant.ts`, task 16.1).
 *
 * Validates: Requirements 4.1, 3.5 (Design §6 Applicant_Area, §8.4)
 *
 * The plugin talks to two boundaries:
 *   - the auth-guard (`requireApplicant` from `src/infra/auth-guard.ts`),
 *     and
 *   - the profile service (`loadProfile` / `updateProfile` from
 *     `src/modules/applicant/profile.ts`).
 *
 * We mock both so the suite stays hermetic and exercise the route
 * end-to-end via Fastify's `inject()`. Schema-level rejection cases
 * (under-18, bad phone) are already covered by the
 * `applicant-profile.test.ts` service unit tests; here we focus on
 * the HTTP plumbing (locale validation, Post/Redirect/Get flow,
 * unauthenticated redirect, error re-render).
 *
 * Cases covered:
 *   - GET /:locale/me/profile (id and en) renders the form 200 OK
 *     with sticky values from the loaded `ProfileRecord` and exposes
 *     the `?saved=1` flash banner.
 *   - GET without a session cookie redirects 302 to /{locale}/login.
 *   - POST happy path calls `updateProfile` with the parsed body and
 *     redirects 302 to /{locale}/me/profile?saved=1.
 *   - POST with under-18 date_of_birth re-renders the form 400 with
 *     a field error (verifies the route translates ZodError correctly).
 *   - POST with bad phone re-renders the form 400 with a field error.
 *   - GET / POST with an unsupported locale segment 404 before any
 *     auth or DB work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

// DB pool — used by the healthz route only; never invoked in this suite.
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

// Auth guard — let us drive the session in/out of the route handler
// without exercising the cookie/session-store path (covered separately
// in tests/unit/session-store.test.ts and tests/unit/auth-logout-route.test.ts).
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

// Profile service — the business logic itself is covered by
// `applicant-profile.test.ts`. Here we only need to assert the route
// passes the right arguments through and reacts correctly to its
// success / ZodError outcomes.
const loadProfileMock = vi.fn();
const updateProfileMock = vi.fn();
vi.mock('../../src/modules/applicant/profile.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/applicant/profile.js')
  >('../../src/modules/applicant/profile.js');
  return {
    ...actual,
    loadProfile: loadProfileMock,
    updateProfile: updateProfileMock,
  };
});

// Stub sibling route plugins so the server bootstrap does not pull
// their service mocks into this test.
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));
vi.mock('../../src/routes/auth.js', () => ({
  authRoutes: async () => undefined,
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

/** A fully-populated SessionRecord for the "authenticated" test cases. */
function fakeSession() {
  return {
    sid: 'a'.repeat(43),
    userId: 42,
    role: 'Applicant' as const,
    csrfToken: 'b'.repeat(43),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    expiresAt: new Date('2025-01-01T12:00:00Z'),
    ipAddress: null,
    userAgent: null,
  };
}

/** A ProfileRecord that exercises every nullable column. */
function fakeProfileRecord() {
  return {
    user_id: 42,
    full_name: 'Sari Pelita',
    date_of_birth: '1995-04-12',
    gender: 'female' as const,
    phone: '+6281234567890',
    address: 'Jl. Mawar 12',
    city: 'Bandung',
    province: 'Jawa Barat',
    country: 'Indonesia',
    summary: 'Frontend engineer',
    language_pref: 'id' as const,
  };
}

/** Build a YYYY-MM-DD string for the date `years` years before today. */
function yearsAgoIsoYmd(years: number): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear() - years,
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  );
  return d.toISOString().slice(0, 10);
}

/**
 * `requireApplicant` short-circuits the response when it returns null;
 * this stub mirrors the production behaviour: write a 302 to `/id/login`
 * then return null. We do this so the route's early-return path is
 * exercised exactly as in production.
 */
function stubRequireApplicantUnauthenticated(): void {
  requireApplicantMock.mockImplementation(async (_request, reply) => {
    reply.code(302).header('location', '/id/login').send();
    return null;
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  requireApplicantMock.mockReset();
  loadProfileMock.mockReset();
  updateProfileMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /:locale/me/profile — happy path
// ---------------------------------------------------------------------------

describe('GET /:locale/me/profile — happy path', () => {
  it('renders the profile form 200 OK with sticky values from the loaded record', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadProfileMock.mockResolvedValueOnce(fakeProfileRecord());

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/profile' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Sticky values rendered into the form.
      expect(res.body).toContain('value="Sari Pelita"');
      expect(res.body).toContain('value="1995-04-12"');
      expect(res.body).toContain('value="+6281234567890"');
      expect(res.body).toContain('value="Bandung"');
      // CSRF hidden field is set from the session csrfToken.
      expect(res.body).toContain(`value="${'b'.repeat(43)}"`);
      // No saved-banner when ?saved is not present.
      expect(res.body).not.toMatch(/Profil berhasil disimpan/);

      expect(loadProfileMock).toHaveBeenCalledWith(42);
    } finally {
      await app.close();
    }
  });

  it('renders the English form for /en/me/profile', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadProfileMock.mockResolvedValueOnce(fakeProfileRecord());

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/en/me/profile' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/My Profile/);
    } finally {
      await app.close();
    }
  });

  it('shows the saved-banner when ?saved=1 is present', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadProfileMock.mockResolvedValueOnce(fakeProfileRecord());

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/profile?saved=1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Profil berhasil disimpan/);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/me/profile — unauthenticated
// ---------------------------------------------------------------------------

describe('GET /:locale/me/profile — unauthenticated', () => {
  it('redirects 302 to login when there is no valid session', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/profile' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      // The route must NOT touch the service layer when unauthenticated.
      expect(loadProfileMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/me/profile — bad locale
// ---------------------------------------------------------------------------

describe('GET /:locale/me/profile — unknown locale', () => {
  it('rejects with 404 before invoking the auth guard', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/me/profile' });
      expect(res.statusCode).toBe(404);
      expect(requireApplicantMock).not.toHaveBeenCalled();
      expect(loadProfileMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/profile — happy path (Post/Redirect/Get)
// ---------------------------------------------------------------------------

describe('POST /:locale/me/profile — happy path', () => {
  it('calls updateProfile with the parsed body and redirects 302 to ?saved=1', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    updateProfileMock.mockResolvedValueOnce({
      affected: 1,
      profile: { full_name: 'Sari Pelita', language_pref: 'id' },
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'full_name=Sari%20Pelita' +
          '&date_of_birth=1995-04-12' +
          '&gender=female' +
          '&phone=%2B6281234567890' +
          '&address=Jl.%20Mawar%2012' +
          '&city=Bandung' +
          '&province=Jawa%20Barat' +
          '&country=Indonesia' +
          '&summary=Frontend%20engineer' +
          '&language_pref=id',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/me/profile?saved=1');

      expect(updateProfileMock).toHaveBeenCalledTimes(1);
      const [userId, payload] = updateProfileMock.mock.calls[0] as [
        number,
        Record<string, unknown>,
      ];
      expect(userId).toBe(42);
      expect(payload.full_name).toBe('Sari Pelita');
      expect(payload.date_of_birth).toBe('1995-04-12');
      expect(payload.phone).toBe('+6281234567890');
      expect(payload.language_pref).toBe('id');
      // _csrf must NOT be forwarded to the service (schema is .strict()).
      expect(payload).not.toHaveProperty('_csrf');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/profile — schema rejection re-renders the form
// ---------------------------------------------------------------------------

describe('POST /:locale/me/profile — validation errors', () => {
  it('re-renders the form 400 with a field error on under-18 date_of_birth', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    updateProfileMock.mockImplementationOnce(async () => {
      throw new ZodError([
        {
          code: 'custom',
          path: ['date_of_birth'],
          message: 'You must be at least 18 years old',
        },
      ]);
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const dob = yearsAgoIsoYmd(10);
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          `full_name=Bagus&date_of_birth=${dob}&language_pref=id`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Field error rendered in the form.
      expect(res.body).toContain('You must be at least 18 years old');
      // Sticky values from the failed submission (not from the loaded row).
      expect(res.body).toContain('value="Bagus"');
      expect(res.body).toContain(`value="${dob}"`);
      // No redirect on failure.
      expect(res.headers.location).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('re-renders the form 400 with a field error on a bad phone', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    updateProfileMock.mockImplementationOnce(async () => {
      throw new ZodError([
        {
          code: 'custom',
          path: ['phone'],
          message:
            'Phone must be in E.164 format (e.g. +6281234567890, 7-19 digits, optional leading +)',
        },
      ]);
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'full_name=Bagus&phone=12&language_pref=id',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/E\.164/);
      // The bad phone value is sticky on the form so the user can fix it.
      expect(res.body).toContain('value="12"');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/profile — bad locale
// ---------------------------------------------------------------------------

describe('POST /:locale/me/profile — unknown locale', () => {
  it('rejects with 404 before invoking the auth guard', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/fr/me/profile',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'full_name=Bagus&language_pref=id',
      });
      expect(res.statusCode).toBe(404);
      expect(requireApplicantMock).not.toHaveBeenCalled();
      expect(updateProfileMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
