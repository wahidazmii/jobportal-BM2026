/**
 * Unit tests for `src/modules/auth/verify.ts` (task 9.3).
 *
 * Validates: Requirements 3.3, 3.4 (Design §8.1)
 *
 * The service talks to MySQL via `withTransaction` from `src/infra/db.ts`
 * and to the mail layer via `src/modules/mail/service.ts`. We mock both
 * boundaries so the suite stays hermetic — the goal is to nail down the
 * contract:
 *
 *   - `consumeVerificationToken` row-locks the token (FOR UPDATE),
 *     activates the user, marks the token used, and returns
 *     `{ status: 'verified', userId }` — all inside one transaction.
 *   - Missing / expired / already-used tokens collapse into the same
 *     `{ status: 'invalid' }` outcome with no UPDATEs (Req 3.4 — no leak).
 *   - Malformed tokens (wrong charset / empty) skip the SELECT entirely
 *     and still return `{ status: 'invalid' }`.
 *   - `resendVerificationEmail` invalidates prior unused tokens, INSERTs
 *     a fresh 24-hour token, and enqueues the verify mail when the
 *     account is in the `pending` state.
 *   - For accounts that are missing, active, disabled, or deleted the
 *     resend service is a silent no-op (Req 3.4 — no enumeration).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// --- mock setup ------------------------------------------------------------

const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  withTransaction: withTransactionMock,
  query: vi.fn(),
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: enqueueMock,
}));

// Import after mocks are registered.
const verifyModule = await import('../../src/modules/auth/verify.js');
const {
  VERIFICATION_TOKEN_HOURS,
  consumeVerificationToken,
  resendSchema,
  resendVerificationEmail,
  verifyTokenSchema,
} = verifyModule;

// --- helpers ---------------------------------------------------------------

function createFakeConnection() {
  const executeMock = vi.fn();
  const connection = { execute: executeMock };
  return { connection, executeMock };
}

function header(insertId: number, affectedRows = 1): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

function bindTransaction(connection: { execute: ReturnType<typeof vi.fn> }) {
  withTransactionMock.mockImplementationOnce(
    async (fn: (conn: typeof connection) => Promise<unknown>) => fn(connection),
  );
}

beforeEach(() => {
  withTransactionMock.mockReset();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
});

afterEach(() => {
  withTransactionMock.mockReset();
  enqueueMock.mockReset();
});

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('verifyTokenSchema', () => {
  it('exposes the documented expiry constant (24 hours)', () => {
    expect(VERIFICATION_TOKEN_HOURS).toBe(24);
  });

  it('accepts a 43-char base64url token', () => {
    const ok = 'a'.repeat(43);
    expect(verifyTokenSchema.parse(ok)).toBe(ok);
  });

  it('rejects empty / missing tokens', () => {
    expect(() => verifyTokenSchema.parse('')).toThrow(/required/i);
    expect(() => verifyTokenSchema.parse(undefined)).toThrow();
  });

  it('rejects tokens containing characters outside the base64url alphabet', () => {
    expect(() => verifyTokenSchema.parse('abc!def')).toThrow(/invalid characters/i);
    expect(() => verifyTokenSchema.parse('abc=def')).toThrow(/invalid characters/i);
  });

  it('rejects tokens longer than 64 characters', () => {
    expect(() => verifyTokenSchema.parse('a'.repeat(65))).toThrow(/too long/i);
  });
});

describe('resendSchema', () => {
  const valid = {
    email: 'Alice@Example.COM',
    captchaToken: 'cap-token',
  };

  it('lowercases and trims the email so the unique-key compare is stable', () => {
    const parsed = resendSchema.parse({
      ...valid,
      email: '  ALICE@example.com  ',
    });
    expect(parsed.email).toBe('alice@example.com');
  });

  it('rejects an obviously invalid email', () => {
    expect(() =>
      resendSchema.parse({ ...valid, email: 'not-an-email' }),
    ).toThrow(/valid email/i);
  });

  it('rejects when the captcha token is missing or empty', () => {
    expect(() => resendSchema.parse({ ...valid, captchaToken: '' })).toThrow(
      /captcha/i,
    );
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      resendSchema.parse({ ...valid, role: 'Super_Admin' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// consumeVerificationToken — happy path (Req 3.3)
// ---------------------------------------------------------------------------

describe('consumeVerificationToken — happy path', () => {
  const goodToken = 'a'.repeat(43);

  it('row-locks the token, activates the user, and marks the token used', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      // SELECT user_id FROM verification_tokens ... FOR UPDATE
      .mockResolvedValueOnce([
        [{ user_id: 42 }] as RowDataPacket[],
        [],
      ])
      // UPDATE users SET status='active', email_verified_at=NOW() ...
      .mockResolvedValueOnce([header(0), []])
      // UPDATE verification_tokens SET used_at=NOW() ...
      .mockResolvedValueOnce([header(0), []]);

    const result = await consumeVerificationToken(goodToken);

    expect(result).toEqual({ status: 'verified', userId: 42 });
    expect(executeMock).toHaveBeenCalledTimes(3);

    const [selectSql, selectParams] = executeMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(selectSql).toMatch(
      /SELECT user_id FROM verification_tokens\s+WHERE token = \?\s*AND used_at IS NULL\s*AND expires_at > NOW\(\)/i,
    );
    expect(selectSql).toMatch(/FOR UPDATE/i);
    expect(selectParams).toEqual([goodToken]);

    const [activateSql, activateParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(activateSql).toMatch(
      /UPDATE users SET status = 'active', email_verified_at = NOW\(\)\s+WHERE id = \?\s*AND status = 'pending'/i,
    );
    expect(activateParams).toEqual([42]);

    const [tokenSql, tokenParams] = executeMock.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(tokenSql).toMatch(
      /UPDATE verification_tokens SET used_at = NOW\(\)\s+WHERE token = \?/i,
    );
    expect(tokenParams).toEqual([goodToken]);
  });

  it('marks the token used even when the activation UPDATE matched 0 rows (already-active user)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ user_id: 7 }] as RowDataPacket[],
        [],
      ])
      // affectedRows=0 because the user is no longer in 'pending'
      .mockResolvedValueOnce([header(0, 0), []])
      .mockResolvedValueOnce([header(0), []]);

    const result = await consumeVerificationToken(goodToken);

    expect(result).toEqual({ status: 'verified', userId: 7 });
    // Three queries — the token UPDATE still ran.
    expect(executeMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// consumeVerificationToken — invalid (Req 3.4 — no leak)
// ---------------------------------------------------------------------------

describe('consumeVerificationToken — invalid / expired', () => {
  const goodToken = 'b'.repeat(43);

  it('returns { status: "invalid" } when the token row is missing/expired/used', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([[] as RowDataPacket[], []]);

    const result = await consumeVerificationToken(goodToken);

    expect(result).toEqual({ status: 'invalid' });
    // Only the SELECT ran — no UPDATEs.
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('returns { status: "invalid" } for malformed tokens WITHOUT opening a transaction', async () => {
    const result = await consumeVerificationToken('bad!token');
    expect(result).toEqual({ status: 'invalid' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('returns { status: "invalid" } for missing tokens (undefined / empty)', async () => {
    expect(await consumeVerificationToken(undefined)).toEqual({
      status: 'invalid',
    });
    expect(await consumeVerificationToken('')).toEqual({ status: 'invalid' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resendVerificationEmail — pending account (Req 3.4)
// ---------------------------------------------------------------------------

describe('resendVerificationEmail — pending account', () => {
  const pendingInput = {
    email: 'alice@example.com',
    captchaToken: 'cap-token',
  };

  it('invalidates prior tokens, INSERTs a fresh one, and enqueues the verify mail', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      // SELECT id, status FROM users WHERE email = ?
      .mockResolvedValueOnce([
        [{ id: 99, status: 'pending' }] as RowDataPacket[],
        [],
      ])
      // UPDATE verification_tokens SET used_at=NOW() WHERE user_id=? AND used_at IS NULL
      .mockResolvedValueOnce([header(0, 1), []])
      // INSERT verification_tokens
      .mockResolvedValueOnce([header(0), []]);

    const result = await resendVerificationEmail(pendingInput);

    expect(result).toEqual({ ok: true, tokenIssued: true });
    expect(executeMock).toHaveBeenCalledTimes(3);

    const [selectSql, selectParams] = executeMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(selectSql).toMatch(
      /SELECT id, status FROM users WHERE email = \?\s*LIMIT 1/i,
    );
    expect(selectParams).toEqual(['alice@example.com']);

    const [invalidateSql, invalidateParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(invalidateSql).toMatch(
      /UPDATE verification_tokens SET used_at = NOW\(\)\s+WHERE user_id = \?\s*AND used_at IS NULL/i,
    );
    expect(invalidateParams).toEqual([99]);

    const [insertSql, insertParams] = executeMock.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(insertSql).toMatch(
      /INSERT INTO verification_tokens \(token, user_id, expires_at\) VALUES \(\?, \?, NOW\(\) \+ INTERVAL 24 HOUR\)/i,
    );
    const [token, userId] = insertParams as [string, number];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(userId).toBe(99);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [enqueueConn, enqueueOpts] = enqueueMock.mock.calls[0] as [
      typeof connection,
      Record<string, unknown>,
    ];
    expect(enqueueConn).toBe(connection);
    expect(enqueueOpts.templateKey).toBe('verify');
    expect(enqueueOpts.toEmail).toBe('alice@example.com');
    expect(enqueueOpts.targetId).toBe(`99:${token}`);
    const ctx = enqueueOpts.context as Record<string, unknown>;
    expect(ctx.token).toBe(token);
    expect(ctx.expires_in_hours).toBe(24);
  });

  it('propagates a non-recoverable INSERT failure so withTransaction can rollback', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    const boom = new Error('connection lost');
    executeMock
      .mockResolvedValueOnce([
        [{ id: 99, status: 'pending' }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(0), []])
      .mockRejectedValueOnce(boom);

    await expect(resendVerificationEmail(pendingInput)).rejects.toBe(boom);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('propagates a mail-enqueue failure (so the token row is rolled back too)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ id: 99, status: 'pending' }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(0), []])
      .mockResolvedValueOnce([header(0), []]);

    const mailErr = new Error('outbox unavailable');
    enqueueMock.mockRejectedValueOnce(mailErr);

    await expect(resendVerificationEmail(pendingInput)).rejects.toBe(mailErr);
  });
});

// ---------------------------------------------------------------------------
// resendVerificationEmail — silent no-op (Req 3.4 — no leak)
// ---------------------------------------------------------------------------

describe('resendVerificationEmail — silent no-op', () => {
  it('returns the same generic OK shape and writes nothing when the email is unknown', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([[] as RowDataPacket[], []]);

    const result = await resendVerificationEmail({
      email: 'ghost@example.com',
      captchaToken: 'cap',
    });

    expect(result).toEqual({ ok: true, tokenIssued: false });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats an active account as no-op (no token, no mail)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ id: 12, status: 'active' }] as RowDataPacket[],
      [],
    ]);

    const result = await resendVerificationEmail({
      email: 'verified@example.com',
      captchaToken: 'cap',
    });

    expect(result).toEqual({ ok: true, tokenIssued: false });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats a disabled account as no-op', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ id: 13, status: 'disabled' }] as RowDataPacket[],
      [],
    ]);

    const result = await resendVerificationEmail({
      email: 'banned@example.com',
      captchaToken: 'cap',
    });

    expect(result).toEqual({ ok: true, tokenIssued: false });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats a deleted account as no-op', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ id: 14, status: 'deleted' }] as RowDataPacket[],
      [],
    ]);

    const result = await resendVerificationEmail({
      email: 'gone@example.com',
      captchaToken: 'cap',
    });

    expect(result).toEqual({ ok: true, tokenIssued: false });
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resendVerificationEmail — input validation
// ---------------------------------------------------------------------------

describe('resendVerificationEmail — input validation', () => {
  it('throws ZodError synchronously (without opening a transaction) for invalid input', async () => {
    await expect(
      resendVerificationEmail({
        email: 'not-an-email',
        captchaToken: '',
      }),
    ).rejects.toThrowError();

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
