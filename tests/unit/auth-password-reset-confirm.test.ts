/**
 * Unit tests for `confirmPasswordReset` in
 * `src/modules/auth/password-reset.ts` (task 11.2).
 *
 * Validates: Requirements 3.8, 3.10 (Design §8.2)
 *
 * The service talks to MySQL via `withTransaction` from `src/infra/db.ts`,
 * to bcrypt for password hashing, and to `session-store.revokeAllForUser`
 * for the post-commit session sweep. We mock all three boundaries so the
 * suite stays hermetic — the goal is to nail down the contract:
 *
 *   - Schema enforces token shape (43 base64url chars) and password rules
 *     (≥10 chars, letter+digit).
 *   - The valid-token branch executes the expected SQL inside the
 *     transaction (`SELECT … FOR UPDATE`, `UPDATE users`, `UPDATE …
 *     used_at = NOW()`) AND revokes all sessions for the user.
 *   - The invalid-token branch (missing / expired / used) returns
 *     `{ ok: false, reason: 'invalid_token' }` without writing anything
 *     and without touching the session store.
 *   - bcrypt is invoked with the documented cost (12).
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

const revokeAllForUserMock = vi.fn().mockResolvedValue(0);

vi.mock('../../src/infra/session-store.js', () => ({
  revokeAllForUser: revokeAllForUserMock,
}));

const bcryptHashMock = vi.fn().mockResolvedValue(
  // bcrypt hashes are exactly 60 chars; the value is opaque to the
  // service so a fixed sentinel is sufficient.
  '$2b$12$' + 'a'.repeat(53),
);

vi.mock('bcrypt', () => ({
  default: { hash: bcryptHashMock },
  hash: bcryptHashMock,
}));

// Mail enqueue isn't called by confirmPasswordReset, but the request
// flow tests in the same module reach for it. Stub to keep import-time
// side-effects predictable.
const enqueueMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: enqueueMock,
}));

// Import after mocks are registered.
const passwordResetModule = await import(
  '../../src/modules/auth/password-reset.js'
);
const {
  RESET_BCRYPT_COST,
  RESET_TOKEN_LENGTH,
  confirmPasswordReset,
  confirmResetSchema,
  isStructurallyValidResetToken,
} = passwordResetModule;

// --- helpers ---------------------------------------------------------------

const VALID_TOKEN = 'A'.repeat(43); // structurally valid base64url, 43 chars

function createFakeConnection() {
  const executeMock = vi.fn();
  const connection = { execute: executeMock };
  return { connection, executeMock };
}

function header(affectedRows = 1): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId: 0,
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
  revokeAllForUserMock.mockReset();
  revokeAllForUserMock.mockResolvedValue(0);
  bcryptHashMock.mockReset();
  bcryptHashMock.mockResolvedValue('$2b$12$' + 'a'.repeat(53));
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
});

afterEach(() => {
  withTransactionMock.mockReset();
  revokeAllForUserMock.mockReset();
  bcryptHashMock.mockReset();
  enqueueMock.mockReset();
});

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

describe('confirm flow constants', () => {
  it('exposes the documented token length (43 chars)', () => {
    expect(RESET_TOKEN_LENGTH).toBe(43);
  });

  it('exposes the documented bcrypt cost (12)', () => {
    expect(RESET_BCRYPT_COST).toBe(12);
  });

  it('isStructurallyValidResetToken accepts a 43-char base64url string', () => {
    expect(isStructurallyValidResetToken('A'.repeat(43))).toBe(true);
    expect(isStructurallyValidResetToken('a-b_'.padEnd(43, 'x'))).toBe(true);
  });

  it('isStructurallyValidResetToken rejects malformed tokens', () => {
    expect(isStructurallyValidResetToken('')).toBe(false);
    expect(isStructurallyValidResetToken('A'.repeat(42))).toBe(false);
    expect(isStructurallyValidResetToken('A'.repeat(44))).toBe(false);
    expect(isStructurallyValidResetToken('!'.repeat(43))).toBe(false);
    expect(isStructurallyValidResetToken(undefined)).toBe(false);
    expect(isStructurallyValidResetToken(123 as unknown)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// confirmResetSchema
// ---------------------------------------------------------------------------

describe('confirmResetSchema', () => {
  const valid = {
    token: VALID_TOKEN,
    newPassword: 'newPass1234',
  };

  it('accepts a structurally-valid token + strong password', () => {
    expect(() => confirmResetSchema.parse(valid)).not.toThrow();
  });

  it('rejects a token that is not exactly 43 base64url chars', () => {
    expect(() =>
      confirmResetSchema.parse({ ...valid, token: 'short' }),
    ).toThrow(/token/i);
    expect(() =>
      confirmResetSchema.parse({ ...valid, token: '!'.repeat(43) }),
    ).toThrow(/token/i);
  });

  it('rejects passwords shorter than 10 characters', () => {
    expect(() =>
      confirmResetSchema.parse({ ...valid, newPassword: 'short1' }),
    ).toThrow(/at least 10/i);
  });

  it('rejects passwords longer than 128 characters', () => {
    expect(() =>
      confirmResetSchema.parse({
        ...valid,
        newPassword: 'a1' + 'b'.repeat(127),
      }),
    ).toThrow(/at most 128/i);
  });

  it('rejects passwords without a letter', () => {
    expect(() =>
      confirmResetSchema.parse({ ...valid, newPassword: '1234567890' }),
    ).toThrow(/letter/i);
  });

  it('rejects passwords without a digit', () => {
    expect(() =>
      confirmResetSchema.parse({ ...valid, newPassword: 'lettersOnly' }),
    ).toThrow(/digit/i);
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      confirmResetSchema.parse({ ...valid, role: 'Super_Admin' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// confirmPasswordReset — happy path
// ---------------------------------------------------------------------------

describe('confirmPasswordReset — valid token', () => {
  const happyInput = { token: VALID_TOKEN, newPassword: 'newPass1234' };

  it('hashes the password with bcrypt cost 12 outside the transaction', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ user_id: 42 }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(1), []]) // UPDATE users
      .mockResolvedValueOnce([header(1), []]); // UPDATE password_reset_tokens

    const result = await confirmPasswordReset(happyInput);

    expect(result).toEqual({ ok: true, userId: 42 });
    expect(bcryptHashMock).toHaveBeenCalledTimes(1);
    expect(bcryptHashMock).toHaveBeenCalledWith('newPass1234', 12);
  });

  it('locks the token row, updates password_hash, marks the token used', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ user_id: 42 }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(1), []])
      .mockResolvedValueOnce([header(1), []]);

    await confirmPasswordReset(happyInput);

    expect(executeMock).toHaveBeenCalledTimes(3);

    // 1) SELECT … FOR UPDATE on the token row
    const [selectSql, selectParams] = executeMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(selectSql).toMatch(
      /SELECT user_id FROM password_reset_tokens\s+WHERE token = \? AND used_at IS NULL AND expires_at > NOW\(\)\s+LIMIT 1 FOR UPDATE/i,
    );
    expect(selectParams).toEqual([VALID_TOKEN]);

    // 2) UPDATE users.password_hash
    const [updUserSql, updUserParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(updUserSql).toMatch(
      /UPDATE users SET password_hash = \? WHERE id = \?/i,
    );
    const [hash, userId] = updUserParams as [string, number];
    expect(hash).toMatch(/^\$2[aby]?\$\d{2}\$.+/); // bcrypt-shaped sentinel
    expect(userId).toBe(42);

    // 3) UPDATE password_reset_tokens.used_at = NOW() WHERE token = ?
    const [updTokSql, updTokParams] = executeMock.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(updTokSql).toMatch(
      /UPDATE password_reset_tokens SET used_at = NOW\(\) WHERE token = \?/i,
    );
    expect(updTokParams).toEqual([VALID_TOKEN]);
  });

  it('revokes every session for the user after the transaction commits', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ user_id: 42 }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(1), []])
      .mockResolvedValueOnce([header(1), []]);

    revokeAllForUserMock.mockResolvedValueOnce(3);

    const result = await confirmPasswordReset(happyInput);

    expect(result).toEqual({ ok: true, userId: 42 });
    expect(revokeAllForUserMock).toHaveBeenCalledTimes(1);
    expect(revokeAllForUserMock).toHaveBeenCalledWith(42);
  });

  it('still resolves OK when session revocation fails (password change has already committed)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ user_id: 42 }] as RowDataPacket[],
        [],
      ])
      .mockResolvedValueOnce([header(1), []])
      .mockResolvedValueOnce([header(1), []]);

    revokeAllForUserMock.mockRejectedValueOnce(new Error('pool closed'));

    const result = await confirmPasswordReset(happyInput);

    // The user has a valid new password — failing the success here would
    // lock them out of an account they've just successfully reset.
    expect(result).toEqual({ ok: true, userId: 42 });
  });

  it('treats a vanished user row as invalid_token (defensive failure mode)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([
        [{ user_id: 42 }] as RowDataPacket[],
        [],
      ])
      // UPDATE users with affectedRows=0 — the user was deleted between
      // the FOR UPDATE select and the password write.
      .mockResolvedValueOnce([header(0), []]);

    const result = await confirmPasswordReset(happyInput);

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    // The token-update SQL must NOT have been issued in this branch.
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(revokeAllForUserMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// confirmPasswordReset — invalid_token (Req 3.8)
// ---------------------------------------------------------------------------

describe('confirmPasswordReset — invalid token', () => {
  const happyInput = { token: VALID_TOKEN, newPassword: 'newPass1234' };

  it('returns invalid_token when no row matches the SELECT … FOR UPDATE', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([[] as RowDataPacket[], []]);

    const result = await confirmPasswordReset(happyInput);

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    // No UPDATE statements were issued.
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(revokeAllForUserMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// confirmPasswordReset — input validation
// ---------------------------------------------------------------------------

describe('confirmPasswordReset — input validation', () => {
  it('throws ZodError synchronously (without opening a transaction or hashing) for invalid input', async () => {
    await expect(
      confirmPasswordReset({
        token: 'too-short',
        newPassword: 'weak',
      }),
    ).rejects.toThrowError();

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(bcryptHashMock).not.toHaveBeenCalled();
    expect(revokeAllForUserMock).not.toHaveBeenCalled();
  });
});
