/**
 * Unit tests for the password-reset confirm endpoints in
 * `src/routes/password.ts` (task 11.2).
 *
 * Validates: Requirements 3.8, 3.10 (Design §6 Auth, §8.2)
 *
 * Goal: pin down the HTTP contract for:
 *
 *   - GET  /:locale/password/reset/:token
 *   - POST /:locale/password/reset/:token
 *
 * What we cover:
 *   - GET with a structurally valid token renders the new-password form.
 *   - GET with a structurally INVALID token renders the generic invalid
 *     page (200 OK, NOT 404 — so URL-shape probing returns no signal).
 *   - POST happy path: service returns ok → render success page.
 *   - POST invalid token (service reports invalid_token) renders the
 *     SAME generic invalid page as the GET handler.
 *   - POST with a weak password re-renders the form with field errors.
 *   - Locale outside {id, en} → 404.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mock setup ------------------------------------------------------------

const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: queryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: vi.fn(),
  withTransaction: withTransactionMock,
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: enqueueMock,
}));

// Mock the password-reset service so this test focuses on HTTP plumbing.
const requestPasswordResetMock = vi.fn();
const confirmPasswordResetMock = vi.fn();

vi.mock('../../src/modules/auth/password-reset.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/auth/password-reset.js')
  >('../../src/modules/auth/password-reset.js');
  return {
    ...actual,
    requestPasswordReset: requestPasswordResetMock,
    confirmPasswordReset: confirmPasswordResetMock,
  };
});

const { buildApp } = await import('../../src/server.js');

// --- helpers ---------------------------------------------------------------

const VALID_TOKEN = 'A'.repeat(43);

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://localhost',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

beforeEach(() => {
  delete process.env.HCAPTCHA_SECRET;
  withTransactionMock.mockReset();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
  requestPasswordResetMock.mockReset();
  requestPasswordResetMock.mockResolvedValue({ ok: true, tokenIssued: true });
  confirmPasswordResetMock.mockReset();
});

afterEach(() => {
  withTransactionMock.mockReset();
  enqueueMock.mockReset();
  requestPasswordResetMock.mockReset();
  confirmPasswordResetMock.mockReset();
});

// ---------------------------------------------------------------------------
// GET /:locale/password/reset/:token
// ---------------------------------------------------------------------------

describe('GET /:locale/password/reset/:token', () => {
  it('renders the new-password form for a structurally valid token', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/id/password/reset/${VALID_TOKEN}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Form points back at the same URL with the same token preserved.
      expect(res.body).toContain(`action="/id/password/reset/${VALID_TOKEN}"`);
      expect(res.body).toContain('name="newPassword"');
      // Service was NOT called for the GET render.
      expect(confirmPasswordResetMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('renders the generic invalid-link page for a malformed token (200, not 404)', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/password/reset/short-token',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // No form is rendered on the invalid page.
      expect(res.body).not.toContain('name="newPassword"');
      // Invalid page should link back to "request a new reset".
      expect(res.body).toContain('/id/password/reset');
    } finally {
      await app.close();
    }
  });

  it('also accepts the en locale segment', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/en/password/reset/${VALID_TOKEN}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`action="/en/password/reset/${VALID_TOKEN}"`);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown locale segment with 404', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/zz/password/reset/${VALID_TOKEN}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/password/reset/:token
// ---------------------------------------------------------------------------

describe('POST /:locale/password/reset/:token', () => {
  it('renders the success page when the service reports ok', async () => {
    confirmPasswordResetMock.mockResolvedValueOnce({ ok: true, userId: 42 });
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/id/password/reset/${VALID_TOKEN}`,
        payload: { newPassword: 'newPass1234' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Success page links the user to the login form.
      expect(res.body).toContain('/id/login');
      expect(confirmPasswordResetMock).toHaveBeenCalledTimes(1);
      expect(confirmPasswordResetMock).toHaveBeenCalledWith({
        token: VALID_TOKEN,
        newPassword: 'newPass1234',
      });
    } finally {
      await app.close();
    }
  });

  it('renders the generic invalid-link page when the service reports invalid_token', async () => {
    confirmPasswordResetMock.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_token',
    });
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/id/password/reset/${VALID_TOKEN}`,
        payload: { newPassword: 'newPass1234' },
      });
      expect(res.statusCode).toBe(200);
      // Same page as GET-with-malformed-token: no form, with a CTA back
      // to the request-reset page.
      expect(res.body).not.toContain('name="newPassword"');
      expect(res.body).toContain('/id/password/reset');
    } finally {
      await app.close();
    }
  });

  it('renders the generic invalid-link page when the URL token is malformed (no service call)', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/password/reset/bad',
        payload: { newPassword: 'newPass1234' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('name="newPassword"');
      expect(confirmPasswordResetMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('re-renders the form with field errors when the password is too weak', async () => {
    // Make the (unmocked) zod validation in the real service throw.
    const { ZodError } = await import('zod');
    confirmPasswordResetMock.mockRejectedValueOnce(
      new ZodError([
        {
          code: 'too_small',
          minimum: 10,
          type: 'string',
          inclusive: true,
          exact: false,
          message: 'Password must be at least 10 characters',
          path: ['newPassword'],
        },
      ]),
    );
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/id/password/reset/${VALID_TOKEN}`,
        payload: { newPassword: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('name="newPassword"');
      expect(res.body).toContain('Password must be at least 10 characters');
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown locale segment with 404', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/zz/password/reset/${VALID_TOKEN}`,
        payload: { newPassword: 'newPass1234' },
      });
      expect(res.statusCode).toBe(404);
      expect(confirmPasswordResetMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('renders a 500 error in-form when the service throws an unexpected error', async () => {
    confirmPasswordResetMock.mockRejectedValueOnce(new Error('db down'));
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/id/password/reset/${VALID_TOKEN}`,
        payload: { newPassword: 'newPass1234' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Form is re-rendered with a general error so the user can retry.
      expect(res.body).toContain('name="newPassword"');
    } finally {
      await app.close();
    }
  });
});
