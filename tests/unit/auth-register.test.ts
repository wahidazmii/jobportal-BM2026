/**
 * Unit tests for `src/modules/auth/register.ts` (task 9.1).
 *
 * Validates: Requirements 3.1, 3.2, 3.10, 14.1 (Design §8.1)
 *
 * The service talks to MySQL via `withTransaction` from `src/infra/db.ts`
 * and to the mail layer via `src/modules/mail/service.ts`. We mock both
 * boundaries so the suite stays hermetic — the goal is to nail down the
 * contract:
 *
 *   - Schema enforces every Req 3.1 / 14.1 rule.
 *   - The success path INSERTs in the order users → applicants →
 *     consent_records → verification_tokens, then enqueues the verify
 *     email — all on the SAME connection (Design §12.3).
 *   - bcrypt is invoked at cost 12 (Req 3.10).
 *   - Duplicate-email pre-check returns the generic no-op shape with no
 *     INSERTs and no email enqueue (Req 3.2).
 *   - ER_DUP_ENTRY race on the INSERT folds into the same generic no-op.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// --- mock setup ------------------------------------------------------------

const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  withTransaction: withTransactionMock,
  // The session-store tests mock these too; harmless extras here keep the
  // module surface stable for any transitive importer.
  query: vi.fn(),
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/modules/mail/service.js', () => ({
  enqueue: enqueueMock,
}));

// Import after mocks are registered (top-level await is enabled in Vitest).
const registerModule = await import('../../src/modules/auth/register.js');
const {
  BCRYPT_COST,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  VERIFICATION_TOKEN_HOURS,
  activePolicyVersion,
  register,
  registerSchema,
} = registerModule;

// --- helpers ---------------------------------------------------------------

/** Construct a fake `PoolConnection` whose `execute` we can program per call. */
function createFakeConnection() {
  const executeMock = vi.fn();
  const connection = {
    execute: executeMock,
  };
  return { connection, executeMock };
}

/** Helper: build a fake `ResultSetHeader` with a chosen insertId. */
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

/**
 * Wire `withTransaction` so the next call invokes the supplied callback
 * with the supplied fake connection and propagates its return value.
 * Mirrors the production behaviour minus the BEGIN/COMMIT bookkeeping
 * (which is covered by `db.test.ts`).
 */
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
// schema (Req 3.1, 14.1)
// ---------------------------------------------------------------------------

describe('registerSchema', () => {
  const valid = {
    email: 'Alice@Example.COM',
    password: 'Password123', // 11 chars: letter+digit
    consent: true,
    captchaToken: 'cap-token',
  };

  it('exposes the documented length constants', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    expect(BCRYPT_COST).toBe(12);
    expect(VERIFICATION_TOKEN_HOURS).toBe(24);
  });

  it('lowercases and trims the email so the unique-key compare is stable', () => {
    const parsed = registerSchema.parse({ ...valid, email: '  ALICE@example.com  ' });
    expect(parsed.email).toBe('alice@example.com');
  });

  it('rejects an obviously invalid email', () => {
    expect(() =>
      registerSchema.parse({ ...valid, email: 'not-an-email' }),
    ).toThrow(/valid email/i);
  });

  it('rejects passwords under 10 characters', () => {
    expect(() =>
      registerSchema.parse({ ...valid, password: 'abc12' }),
    ).toThrow(/at least 10/i);
  });

  it('rejects passwords without a digit', () => {
    expect(() =>
      registerSchema.parse({ ...valid, password: 'PasswordOnly' }),
    ).toThrow(/digit/i);
  });

  it('rejects passwords without a letter', () => {
    expect(() =>
      registerSchema.parse({ ...valid, password: '1234567890' }),
    ).toThrow(/letter/i);
  });

  it('rejects when consent is not exactly `true`', () => {
    expect(() => registerSchema.parse({ ...valid, consent: false })).toThrow(
      /privacy policy/i,
    );
  });

  it('rejects when the captcha token is missing or empty', () => {
    expect(() => registerSchema.parse({ ...valid, captchaToken: '' })).toThrow(
      /captcha/i,
    );
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      registerSchema.parse({ ...valid, role: 'Super_Admin' }),
    ).toThrow();
  });

  it('rejects an email longer than 254 characters', () => {
    const local = 'a'.repeat(250);
    expect(() =>
      registerSchema.parse({ ...valid, email: `${local}@x.io` }),
    ).toThrow(/too long|254/i);
  });
});

// ---------------------------------------------------------------------------
// activePolicyVersion (Design §16.1)
// ---------------------------------------------------------------------------

describe('activePolicyVersion', () => {
  const original = process.env.PRIVACY_POLICY_VERSION;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.PRIVACY_POLICY_VERSION;
    } else {
      process.env.PRIVACY_POLICY_VERSION = original;
    }
  });

  it('defaults to v1 when the env var is unset or blank', () => {
    delete process.env.PRIVACY_POLICY_VERSION;
    expect(activePolicyVersion()).toBe('v1');
    process.env.PRIVACY_POLICY_VERSION = '   ';
    expect(activePolicyVersion()).toBe('v1');
  });

  it('uses the env var verbatim (trimmed) when set', () => {
    process.env.PRIVACY_POLICY_VERSION = '  2025-q1  ';
    expect(activePolicyVersion()).toBe('2025-q1');
  });
});

// ---------------------------------------------------------------------------
// register() — happy path (Req 3.1, 3.10, Design §8.1)
// ---------------------------------------------------------------------------

describe('register — happy path', () => {
  const happyInput = {
    email: 'alice@example.com',
    password: 'Password123',
    consent: true,
    captchaToken: 'cap-token',
  };

  it('inserts users → applicants → consent_records → verification_tokens, then enqueues the verify email', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      // SELECT email pre-check — no row.
      .mockResolvedValueOnce([[] as RowDataPacket[], []])
      // INSERT users.
      .mockResolvedValueOnce([header(101), []])
      // INSERT applicants.
      .mockResolvedValueOnce([header(0), []])
      // INSERT consent_records.
      .mockResolvedValueOnce([header(7), []])
      // INSERT verification_tokens.
      .mockResolvedValueOnce([header(0), []]);

    const result = await register(happyInput);

    expect(result).toEqual({ ok: true, alreadyRegistered: false });

    // Five `execute` calls in the design-mandated order.
    expect(executeMock).toHaveBeenCalledTimes(5);

    const [selectSql, selectParams] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(selectSql).toMatch(/SELECT id FROM users WHERE email = \?\s*LIMIT 1/i);
    expect(selectParams).toEqual(['alice@example.com']);

    const [usersSql, usersParams] = executeMock.mock.calls[1] as [string, unknown[]];
    expect(usersSql).toMatch(
      /INSERT INTO users \(uuid, email, password_hash, role, status\) VALUES \(\?, \?, \?, 'Applicant', 'pending'\)/i,
    );
    expect(usersParams).toHaveLength(3);
    const [uuid, email, hash] = usersParams as [string, string, string];
    expect(typeof uuid).toBe('string');
    expect(uuid.length).toBeGreaterThan(0);
    expect(email).toBe('alice@example.com');
    // bcrypt hashes start with `$2b$12$...` for cost 12.
    expect(hash).toMatch(/^\$2[aby]\$12\$/);

    const [applicantsSql, applicantsParams] = executeMock.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(applicantsSql).toMatch(
      /INSERT INTO applicants \(user_id, full_name\) VALUES \(\?, \?\)/i,
    );
    expect(applicantsParams[0]).toBe(101);
    expect(typeof applicantsParams[1]).toBe('string');
    expect((applicantsParams[1] as string).length).toBeGreaterThan(0);

    const [consentSql, consentParams] = executeMock.mock.calls[3] as [string, unknown[]];
    expect(consentSql).toMatch(
      /INSERT INTO consent_records \(applicant_user_id, policy_version, ip_address\) VALUES \(\?, \?, \?\)/i,
    );
    expect(consentParams[0]).toBe(101);
    expect(typeof consentParams[1]).toBe('string'); // policy version
    expect(consentParams[2]).toBeNull();

    const [tokenSql, tokenParams] = executeMock.mock.calls[4] as [string, unknown[]];
    expect(tokenSql).toMatch(
      /INSERT INTO verification_tokens \(token, user_id, expires_at\) VALUES \(\?, \?, NOW\(\) \+ INTERVAL 24 HOUR\)/i,
    );
    expect(typeof tokenParams[0]).toBe('string');
    expect((tokenParams[0] as string)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenParams[1]).toBe(101);

    // Mail enqueue runs on the SAME connection passed to the transaction.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [enqueueConn, enqueueOpts] = enqueueMock.mock.calls[0] as [
      typeof connection,
      Record<string, unknown>,
    ];
    expect(enqueueConn).toBe(connection);
    expect(enqueueOpts.templateKey).toBe('verify');
    expect(enqueueOpts.toEmail).toBe('alice@example.com');
    expect(enqueueOpts.targetId).toBe('101');
    const ctx = enqueueOpts.context as Record<string, unknown>;
    expect(ctx.token).toBe(tokenParams[0]);
    expect(ctx.expires_in_hours).toBe(24);
  });

  it('passes the request IP into consent_records.ip_address when supplied', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([[] as RowDataPacket[], []])
      .mockResolvedValueOnce([header(202), []])
      .mockResolvedValueOnce([header(0), []])
      .mockResolvedValueOnce([header(0), []])
      .mockResolvedValueOnce([header(0), []]);

    const ip = Buffer.from([10, 0, 0, 1]);
    await register(happyInput, { ipAddress: ip });

    const [, consentParams] = executeMock.mock.calls[3] as [string, unknown[]];
    expect(consentParams[2]).toBe(ip);
  });

  it('hashes the password with bcrypt cost 12 (Req 3.10)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock
      .mockResolvedValueOnce([[] as RowDataPacket[], []])
      .mockResolvedValueOnce([header(303), []])
      .mockResolvedValueOnce([header(0), []])
      .mockResolvedValueOnce([header(0), []])
      .mockResolvedValueOnce([header(0), []]);

    await register(happyInput);

    const [, usersParams] = executeMock.mock.calls[1] as [string, unknown[]];
    const hash = usersParams[2] as string;
    // bcrypt's modular crypt format encodes the cost in chars 4-5.
    expect(hash.startsWith('$2b$12$')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// register() — duplicate email (Req 3.2)
// ---------------------------------------------------------------------------

describe('register — duplicate email (no leak)', () => {
  const dupInput = {
    email: 'taken@example.com',
    password: 'Password123',
    consent: true,
    captchaToken: 'cap-token',
  };

  it('returns the generic OK shape and writes nothing when the email pre-check finds a row', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // Pre-check returns a row → service must short-circuit.
    executeMock.mockResolvedValueOnce([
      [{ id: 99 }] as RowDataPacket[],
      [],
    ]);

    const result = await register(dupInput);

    expect(result).toEqual({ ok: true, alreadyRegistered: true });
    // Only the SELECT was issued — no INSERTs.
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('folds an ER_DUP_ENTRY race on users.email back into the same generic OK shape', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // Pre-check passes (no row), but the INSERT collides because a
    // concurrent request already created the user.
    executeMock
      .mockResolvedValueOnce([[] as RowDataPacket[], []]) // SELECT
      .mockImplementationOnce(async () => {
        const err = new Error('ER_DUP_ENTRY: duplicate entry') as Error & {
          code?: string;
          errno?: number;
        };
        err.code = 'ER_DUP_ENTRY';
        err.errno = 1062;
        throw err;
      });

    const result = await register(dupInput);

    expect(result).toEqual({ ok: true, alreadyRegistered: true });
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// register() — error propagation
// ---------------------------------------------------------------------------

describe('register — error propagation', () => {
  it('throws ZodError synchronously (without opening a transaction) for invalid input', async () => {
    await expect(
      register({
        email: 'not-an-email',
        password: 'short',
        consent: false,
        captchaToken: '',
      }),
    ).rejects.toThrowError();

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('propagates non-duplicate database errors so withTransaction can rollback', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    const boom = new Error('connection lost');
    executeMock
      .mockResolvedValueOnce([[] as RowDataPacket[], []]) // SELECT
      .mockRejectedValueOnce(boom); // INSERT users → fails

    await expect(
      register({
        email: 'bob@example.com',
        password: 'Password123',
        consent: true,
        captchaToken: 'cap-token',
      }),
    ).rejects.toBe(boom);

    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
