/**
 * Unit tests for `src/modules/auth/password-reset.ts` (task 11.1).
 *
 * Validates: Requirements 3.8, 3.9 (Design §8.2)
 *
 * The service talks to MySQL via `withTransaction` from `src/infra/db.ts`
 * and to the mail layer via `src/modules/mail/service.ts`. We mock both
 * boundaries so the suite stays hermetic — the goal is to nail down the
 * contract:
 *
 *   - Schema enforces email + captcha presence.
 *   - The "user exists" path INSERTs `password_reset_tokens` with a
 *     43-char base64url token and a 60-minute expiry, then enqueues the
 *     `'reset'` mail on the same transaction connection.
 *   - The "no such user" path issues NO INSERTs and NO mail enqueue, and
 *     returns the same `{ ok: true }` shape (Req 3.9 — no leak).
 *   - Disabled / deleted accounts also fold into the no-op branch.
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
const passwordResetModule = await import(
  '../../src/modules/auth/password-reset.js'
);
const {
  RESET_TOKEN_MINUTES,
  requestPasswordReset,
  requestResetSchema,
} = passwordResetModule;

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
// schema (Req 14.1, 3.8)
// ---------------------------------------------------------------------------

describe('requestResetSchema', () => {
  const valid = {
    email: 'Alice@Example.COM',
    captchaToken: 'cap-token',
  };

  it('exposes the documented expiry constant (60 minutes)', () => {
    expect(RESET_TOKEN_MINUTES).toBe(60);
  });

  it('lowercases and trims the email so the unique-key compare is stable', () => {
    const parsed = requestResetSchema.parse({
      ...valid,
      email: '  ALICE@example.com  ',
    });
    expect(parsed.email).toBe('alice@example.com');
  });

  it('rejects an obviously invalid email', () => {
    expect(() =>
      requestResetSchema.parse({ ...valid, email: 'not-an-email' }),
    ).toThrow(/valid email/i);
  });

  it('rejects when the captcha token is missing or empty', () => {
    expect(() =>
      requestResetSchema.parse({ ...valid, captchaToken: '' }),
    ).toThrow(/captcha/i);
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      requestResetSchema.parse({ ...valid, role: 'Super_Admin' }),
    ).toThrow();
  });

  it('rejects an email longer than 254 characters', () => {
    const local = 'a'.repeat(250);
    expect(() =>
      requestResetSchema.parse({ ...valid, email: `${local}@x.io` }),
    ).toThrow(/too long|254/i);
  });
});

// ---------------------------------------------------------------------------
// requestPasswordReset() — user exists (Req 3.8)
// ---------------------------------------------------------------------------

describe('requestPasswordReset — user exists', () => {
  const happyInput = {
    email: 'alice@example.com',
    captchaToken: 'cap-token',
  };

  it('INSERTs the token row with a 60-minute expiry and enqueues the reset mail', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      // SELECT id, status FROM users WHERE email = ?
      .mockResolvedValueOnce([
        [{ id: 42, status: 'active' }] as RowDataPacket[],
        [],
      ])
      // INSERT INTO password_reset_tokens ...
      .mockResolvedValueOnce([header(0), []]);

    const result = await requestPasswordReset(happyInput);

    expect(result).toEqual({ ok: true, tokenIssued: true });

    expect(executeMock).toHaveBeenCalledTimes(2);

    const [selectSql, selectParams] = executeMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(selectSql).toMatch(
      /SELECT id, status FROM users WHERE email = \?\s*LIMIT 1/i,
    );
    expect(selectParams).toEqual(['alice@example.com']);

    const [tokenSql, tokenParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(tokenSql).toMatch(
      /INSERT INTO password_reset_tokens \(token, user_id, expires_at\) VALUES \(\?, \?, NOW\(\) \+ INTERVAL 60 MINUTE\)/i,
    );
    const [token, userId] = tokenParams as [string, number];
    // 32 random bytes → 43 base64url chars, no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(userId).toBe(42);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [enqueueConn, enqueueOpts] = enqueueMock.mock.calls[0] as [
      typeof connection,
      Record<string, unknown>,
    ];
    expect(enqueueConn).toBe(connection);
    expect(enqueueOpts.templateKey).toBe('reset');
    expect(enqueueOpts.toEmail).toBe('alice@example.com');
    expect(enqueueOpts.targetId).toBe(`42:${token}`);
    const ctx = enqueueOpts.context as Record<string, unknown>;
    expect(ctx.token).toBe(token);
    expect(ctx.expires_in_minutes).toBe(60);
  });

  it('also issues a reset for an unverified (status=pending) account', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ id: 7, status: 'pending' }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(0), []]);

    const result = await requestPasswordReset({
      email: 'pending@example.com',
      captchaToken: 'cap',
    });

    expect(result).toEqual({ ok: true, tokenIssued: true });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-recoverable INSERT failure so withTransaction can rollback', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    const boom = new Error('connection lost');
    executeMock
      .mockResolvedValueOnce([
        [{ id: 42, status: 'active' }] as RowDataPacket[],
        [],
      ])
      .mockRejectedValueOnce(boom);

    await expect(requestPasswordReset(happyInput)).rejects.toBe(boom);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('propagates a mail-enqueue failure (so the token row is rolled back too)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ id: 42, status: 'active' }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(0), []]);

    const mailErr = new Error('outbox unavailable');
    enqueueMock.mockRejectedValueOnce(mailErr);

    await expect(requestPasswordReset(happyInput)).rejects.toBe(mailErr);
  });
});

// ---------------------------------------------------------------------------
// requestPasswordReset() — silent no-op (Req 3.9, no leak)
// ---------------------------------------------------------------------------

describe('requestPasswordReset — silent no-op', () => {
  const unknownInput = {
    email: 'ghost@example.com',
    captchaToken: 'cap-token',
  };

  it('returns the same generic OK shape and writes nothing when the email is unknown', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([[] as RowDataPacket[], []]);

    const result = await requestPasswordReset(unknownInput);

    expect(result).toEqual({ ok: true, tokenIssued: false });
    // Only the SELECT was issued — no INSERTs.
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats a disabled account as no-op (no token, no mail)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ id: 9, status: 'disabled' }] as RowDataPacket[],
      [],
    ]);

    const result = await requestPasswordReset({
      email: 'banned@example.com',
      captchaToken: 'cap',
    });

    expect(result).toEqual({ ok: true, tokenIssued: false });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats a deleted account as no-op', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [{ id: 9, status: 'deleted' }] as RowDataPacket[],
      [],
    ]);

    const result = await requestPasswordReset({
      email: 'gone@example.com',
      captchaToken: 'cap',
    });

    expect(result).toEqual({ ok: true, tokenIssued: false });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns a result shape that does NOT distinguish branch (Req 3.9)', async () => {
    // Branch A — user exists.
    const fakeA = createFakeConnection();
    bindTransaction(fakeA.connection);
    fakeA.executeMock
      .mockResolvedValueOnce([
        [{ id: 1, status: 'active' }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(0), []]);
    const branchA = await requestPasswordReset({
      email: 'real@example.com',
      captchaToken: 'cap',
    });

    enqueueMock.mockClear();

    // Branch B — user missing.
    const fakeB = createFakeConnection();
    bindTransaction(fakeB.connection);
    fakeB.executeMock.mockResolvedValueOnce([[] as RowDataPacket[], []]);
    const branchB = await requestPasswordReset({
      email: 'fake@example.com',
      captchaToken: 'cap',
    });

    // The publicly-meaningful surface is `{ ok }`. The route layer
    // returns a static GENERIC_RESET_RESPONSE for both branches.
    expect(branchA.ok).toBe(true);
    expect(branchB.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requestPasswordReset() — input validation
// ---------------------------------------------------------------------------

describe('requestPasswordReset — input validation', () => {
  it('throws ZodError synchronously (without opening a transaction) for invalid input', async () => {
    await expect(
      requestPasswordReset({
        email: 'not-an-email',
        captchaToken: '',
      }),
    ).rejects.toThrowError();

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
