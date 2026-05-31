/**
 * Unit tests for `src/routes/password.ts` (task 11.1).
 *
 * Validates: Requirements 3.8, 3.9, 14.1 (Design §6 Auth, §8.2)
 *
 * Goal: pin down the HTTP contract for `POST /:locale/password/reset`.
 *
 *   - Captcha bypass for tests (no `HCAPTCHA_SECRET` set).
 *   - Both branches (email exists, email missing) return BYTE-IDENTICAL
 *     200 responses so an attacker cannot enumerate accounts.
 *   - Schema-invalid bodies → 400 with field errors (no leak — the
 *     "no leak" guarantee scopes to email enumeration, not generic
 *     malformed-input rejection).
 *   - Captcha failures → 400 (production path: HCAPTCHA_SECRET set,
 *     siteverify rejects).
 *   - Locale segment outside the {id, en} set → 404.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// --- mock setup ------------------------------------------------------------
//
// We mock the db pool and `withTransaction` so the route can be exercised
// end-to-end via Fastify's `inject()` without hitting MySQL.

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

const { buildApp } = await import('../../src/server.js');
const { GENERIC_RESET_RESPONSE } = await import(
  '../../src/routes/password.js'
);

// --- helpers ---------------------------------------------------------------

function header(insertId: number): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows: 1,
    insertId,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

function bindTransaction(executeMock: ReturnType<typeof vi.fn>) {
  withTransactionMock.mockImplementationOnce(
    async (fn: (conn: { execute: typeof executeMock }) => Promise<unknown>) =>
      fn({ execute: executeMock }),
  );
}

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://localhost',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

// hCaptcha secret is intentionally unset in unit tests so verifyCaptcha
// short-circuits to true (dev/test bypass).
beforeEach(() => {
  delete process.env.HCAPTCHA_SECRET;
  withTransactionMock.mockReset();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
});

afterEach(() => {
  withTransactionMock.mockReset();
  enqueueMock.mockReset();
});

// ---------------------------------------------------------------------------
// POST /:locale/password/reset — generic-response contract (Req 3.9)
// ---------------------------------------------------------------------------

describe('POST /:locale/password/reset', () => {
  it('returns a generic 200 with the documented body when the email exists', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const executeMock = vi.fn();
      executeMock
        // SELECT id, status FROM users
        .mockResolvedValueOnce([
          [{ id: 42, status: 'active' }] as RowDataPacket[],
          [],
        ])
        // INSERT password_reset_tokens
        .mockResolvedValueOnce([header(0), []]);
      bindTransaction(executeMock);

      const res = await app.inject({
        method: 'POST',
        url: '/id/password/reset',
        payload: {
          email: 'alice@example.com',
          captchaToken: 'dev-bypass-token',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(GENERIC_RESET_RESPONSE);
      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns the SAME 200 body when the email does NOT exist (Req 3.9 — no leak)', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      bindTransaction(executeMock);

      const res = await app.inject({
        method: 'POST',
        url: '/id/password/reset',
        payload: {
          email: 'ghost@example.com',
          captchaToken: 'dev-bypass-token',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(GENERIC_RESET_RESPONSE);
      // No INSERT, no mail enqueue.
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(enqueueMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns BYTE-IDENTICAL responses for the two branches', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      // Branch A — email exists.
      const execA = vi.fn();
      execA
        .mockResolvedValueOnce([
          [{ id: 1, status: 'active' }] as RowDataPacket[],
          [],
        ])
        .mockResolvedValueOnce([header(0), []]);
      bindTransaction(execA);

      const resA = await app.inject({
        method: 'POST',
        url: '/id/password/reset',
        payload: { email: 'real@example.com', captchaToken: 'cap' },
      });

      // Branch B — email missing.
      const execB = vi.fn();
      execB.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      bindTransaction(execB);

      const resB = await app.inject({
        method: 'POST',
        url: '/id/password/reset',
        payload: { email: 'fake@example.com', captchaToken: 'cap' },
      });

      expect(resA.statusCode).toBe(resB.statusCode);
      expect(resA.body).toBe(resB.body);
      expect(resA.headers['content-type']).toBe(resB.headers['content-type']);
    } finally {
      await app.close();
    }
  });

  it('also accepts the en locale segment', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      bindTransaction(executeMock);

      const res = await app.inject({
        method: 'POST',
        url: '/en/password/reset',
        payload: { email: 'foo@example.com', captchaToken: 'cap' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(GENERIC_RESET_RESPONSE);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown locale segment with 404', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/zz/password/reset',
        payload: { email: 'foo@example.com', captchaToken: 'cap' },
      });
      expect(res.statusCode).toBe(404);
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects schema-invalid bodies with 400 + fieldErrors', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/password/reset',
        payload: { email: 'not-an-email', captchaToken: '' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_input');
      expect(body.fieldErrors).toBeDefined();
      expect(withTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 400 captcha_failed when hCaptcha rejects the token', async () => {
    // Force the production path: HCAPTCHA_SECRET set + fetch returns
    // success=false. The dev/test bypass only triggers when the secret
    // is unset.
    process.env.HCAPTCHA_SECRET = 'test-secret-value';

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/password/reset',
        payload: {
          email: 'real@example.com',
          captchaToken: 'bad-captcha-token',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'captcha_failed' });
      expect(withTransactionMock).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.HCAPTCHA_SECRET;
      await app.close();
    }
  });
});
