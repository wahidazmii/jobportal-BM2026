/**
 * Unit tests for `src/modules/auth/login.ts` (task 10.1).
 *
 * Validates: Requirements 3.5, 3.6, 3.7, 14.3 (Design §8.3 / §8.4)
 *
 * The service touches MySQL via `query()` from `src/infra/db.ts`,
 * `bcrypt.compare`, and the session-store's `create()` helper. We mock
 * each boundary so the suite stays hermetic and the goals are clear:
 *
 *   - Schema rejects structural violations only — credential errors flow
 *     through to the `invalid_credentials` outcome (Req 3.6).
 *   - Lockout pre-check trips at the 6th in-window failure (Req 3.7) and
 *     never burns bcrypt CPU on a doomed compare.
 *   - Failure path INSERTs `login_attempts(success=0)` and never creates
 *     a session.
 *   - Success path INSERTs `login_attempts(success=1)`, creates a session
 *     via the store, and returns a redirect target keyed off `users.role`
 *     (Applicant → `/me`, internal → `/admin`).
 *   - Pending/disabled/deleted accounts hit the same generic
 *     `invalid_credentials` outcome — no enumeration (Req 3.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// --- mock setup ------------------------------------------------------------

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

const createSessionMock = vi.fn();

vi.mock('../../src/infra/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/infra/session-store.js')
  >();
  return {
    ...actual,
    create: createSessionMock,
  };
});

const bcryptCompareMock = vi.fn();
const bcryptHashMock = vi.fn().mockResolvedValue('$2b$12$' + 'x'.repeat(53));

vi.mock('bcrypt', () => ({
  default: {
    compare: bcryptCompareMock,
    hash: bcryptHashMock,
  },
  compare: bcryptCompareMock,
  hash: bcryptHashMock,
}));

// Import the module under test AFTER mocks are registered.
const loginModule = await import('../../src/modules/auth/login.js');
const {
  EMAIL_MAX_LEN,
  LOCKOUT_MAX_FAILURES,
  LOCKOUT_WINDOW_MINUTES,
  LOCKOUT_WINDOW_SECONDS,
  MAX_PASSWORD_LENGTH,
  REDIRECT_ADMIN,
  REDIRECT_APPLICANT_PREFIX,
  login,
  loginSchema,
} = loginModule;

// --- helpers ---------------------------------------------------------------

function header(affectedRows = 1, insertId = 0): ResultSetHeader {
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

function lockoutRow(failureCount: number, retryAfterSeconds: number | null = 1): RowDataPacket {
  return {
    failure_count: failureCount,
    retry_after_seconds: retryAfterSeconds,
  } as unknown as RowDataPacket;
}

function userRow(overrides: Partial<{
  id: number;
  password_hash: string;
  role: 'Applicant' | 'Super_Admin' | 'HR' | 'Department_Head';
  status: 'pending' | 'active' | 'disabled' | 'deleted';
}> = {}): RowDataPacket {
  return {
    id: 101,
    password_hash: '$2b$12$' + 'a'.repeat(53),
    role: 'Applicant',
    status: 'active',
    ...overrides,
  } as unknown as RowDataPacket;
}

const happyInput = {
  email: 'alice@example.com',
  password: 'Password123',
};

const ipv4 = Buffer.from([10, 0, 0, 1]);
const happyCtx = { ipAddress: ipv4, userAgent: 'vitest/1.0' };

beforeEach(() => {
  queryMock.mockReset();
  createSessionMock.mockReset();
  bcryptCompareMock.mockReset();
  // Default: matches whatever was supplied (the actual gating happens
  // via `users.status` in the service).
  bcryptCompareMock.mockResolvedValue(true);
});

afterEach(() => {
  queryMock.mockReset();
  createSessionMock.mockReset();
  bcryptCompareMock.mockReset();
});

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

describe('constants (Req 3.7, 14.3)', () => {
  it('locks at 5 failures within a 15-minute window', () => {
    expect(LOCKOUT_MAX_FAILURES).toBe(5);
    expect(LOCKOUT_WINDOW_MINUTES).toBe(15);
    expect(LOCKOUT_WINDOW_SECONDS).toBe(15 * 60);
  });

  it('routes Applicants to /me and internal roles to /admin', () => {
    expect(REDIRECT_APPLICANT_PREFIX).toBe('/me');
    expect(REDIRECT_ADMIN).toBe('/admin');
  });

  it('caps password / email length at the column-defined maxima', () => {
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    expect(EMAIL_MAX_LEN).toBe(254);
  });
});

// ---------------------------------------------------------------------------
// loginSchema
// ---------------------------------------------------------------------------

describe('loginSchema', () => {
  it('lowercases + trims the email so the unique-key compare is stable', () => {
    const parsed = loginSchema.parse({
      email: '  ALICE@example.com  ',
      password: 'Password123',
    });
    expect(parsed.email).toBe('alice@example.com');
  });

  it('rejects an empty email or password (structural)', () => {
    expect(() =>
      loginSchema.parse({ email: '', password: 'Password123' }),
    ).toThrow();
    expect(() =>
      loginSchema.parse({ email: 'a@b.c', password: '' }),
    ).toThrow();
  });

  it('rejects oversized email or password (column caps)', () => {
    expect(() =>
      loginSchema.parse({
        email: 'x'.repeat(EMAIL_MAX_LEN + 1),
        password: 'Password123',
      }),
    ).toThrow();
    expect(() =>
      loginSchema.parse({
        email: 'a@b.c',
        password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      loginSchema.parse({
        email: 'a@b.c',
        password: 'Password123',
        rememberMe: true,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// login() — lockout (Req 3.7, Design §8.3)
// ---------------------------------------------------------------------------

describe('login — lockout', () => {
  it('returns `locked` with retryAfterSeconds when failures > 5 in 15 min', async () => {
    queryMock
      // Lockout pre-check returns 6 failures and 247 seconds remaining.
      .mockResolvedValueOnce([lockoutRow(6, 247)]);

    const outcome = await login(happyInput, happyCtx);

    expect(outcome).toEqual({ status: 'locked', retryAfterSeconds: 247 });

    // Only the lockout query ran — no user lookup, no bcrypt, no insert.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(bcryptCompareMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();

    // The SQL must reference `success = 0` and the 15-minute window.
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/login_attempts/i);
    expect(sql).toMatch(/success = 0/i);
    expect(sql).toMatch(/INTERVAL 15 MINUTE/i);
    expect(params).toEqual(['alice@example.com']);
  });

  it('does NOT lock at exactly 5 failures (boundary: > 5)', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(5, 30)]) // boundary: not locked
      .mockResolvedValueOnce([userRow()]) // user lookup
      .mockResolvedValueOnce([header(1)]); // INSERT login_attempts (failure)
    bcryptCompareMock.mockResolvedValueOnce(false);

    const outcome = await login(happyInput, happyCtx);

    expect(outcome).toEqual({ status: 'invalid_credentials' });
  });

  it('clamps retryAfterSeconds to a positive value when the DB returns 0/null', async () => {
    queryMock.mockResolvedValueOnce([lockoutRow(7, 0)]);

    const outcome = await login(happyInput, happyCtx);

    expect(outcome.status).toBe('locked');
    if (outcome.status === 'locked') {
      expect(outcome.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// login() — failure path (Req 3.6)
// ---------------------------------------------------------------------------

describe('login — invalid credentials (no leak)', () => {
  it('returns invalid_credentials and inserts a failed login_attempts row when the password is wrong', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(0)]) // lockout: clear
      .mockResolvedValueOnce([userRow()]) // user lookup: active applicant
      .mockResolvedValueOnce([header(1)]); // INSERT login_attempts
    bcryptCompareMock.mockResolvedValueOnce(false); // wrong password

    const outcome = await login(happyInput, happyCtx);

    expect(outcome).toEqual({ status: 'invalid_credentials' });
    expect(createSessionMock).not.toHaveBeenCalled();

    // Third call MUST be the failure-row INSERT.
    expect(queryMock).toHaveBeenCalledTimes(3);
    const [sql, params] = queryMock.mock.calls[2] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO login_attempts \(email, ip_address, success\)/i);
    expect(params).toEqual(['alice@example.com', ipv4, 0]);
  });

  it('returns invalid_credentials when the email is unknown (no row)', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(0)])
      .mockResolvedValueOnce([] as RowDataPacket[]) // user lookup: empty
      .mockResolvedValueOnce([header(1)]);
    bcryptCompareMock.mockResolvedValueOnce(false); // dummy compare

    const outcome = await login(
      { email: 'ghost@example.com', password: 'whatever' },
      happyCtx,
    );

    expect(outcome).toEqual({ status: 'invalid_credentials' });
    // bcrypt MUST still have been called for timing-uniformity (Req 3.6).
    expect(bcryptCompareMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('rejects pending users with the same generic outcome (no leak)', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(0)])
      .mockResolvedValueOnce([userRow({ status: 'pending' })])
      .mockResolvedValueOnce([header(1)]);
    bcryptCompareMock.mockResolvedValueOnce(true); // even with a "correct" password

    const outcome = await login(happyInput, happyCtx);

    expect(outcome).toEqual({ status: 'invalid_credentials' });
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('rejects disabled users with the same generic outcome', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(0)])
      .mockResolvedValueOnce([userRow({ status: 'disabled' })])
      .mockResolvedValueOnce([header(1)]);
    bcryptCompareMock.mockResolvedValueOnce(true);

    const outcome = await login(happyInput, happyCtx);

    expect(outcome).toEqual({ status: 'invalid_credentials' });
  });

  it('rejects deleted users with the same generic outcome', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(0)])
      .mockResolvedValueOnce([userRow({ status: 'deleted' })])
      .mockResolvedValueOnce([header(1)]);
    bcryptCompareMock.mockResolvedValueOnce(true);

    const outcome = await login(happyInput, happyCtx);

    expect(outcome).toEqual({ status: 'invalid_credentials' });
  });

  it('treats a bcrypt.compare exception as invalid_credentials (no 500)', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(0)])
      .mockResolvedValueOnce([userRow()])
      .mockResolvedValueOnce([header(1)]);
    bcryptCompareMock.mockRejectedValueOnce(new Error('malformed hash'));

    const outcome = await login(happyInput, happyCtx);

    expect(outcome).toEqual({ status: 'invalid_credentials' });
  });
});

// ---------------------------------------------------------------------------
// login() — success path (Req 3.5)
// ---------------------------------------------------------------------------

describe('login — success', () => {
  it('creates a session and redirects an Applicant to /me', async () => {
    queryMock
      .mockResolvedValueOnce([lockoutRow(0)])
      .mockResolvedValueOnce([userRow()])
      .mockResolvedValueOnce([header(1)]); // INSERT login_attempts(success=1)
    bcryptCompareMock.mockResolvedValueOnce(true);
    createSessionMock.mockResolvedValueOnce({
      sid: 'a'.repeat(43),
      userId: 101,
      role: 'Applicant',
      csrfToken: 'b'.repeat(43),
      createdAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      ipAddress: ipv4,
      userAgent: 'vitest/1.0',
    });

    const outcome = await login(happyInput, happyCtx);

    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') return;
    expect(outcome.userId).toBe(101);
    expect(outcome.role).toBe('Applicant');
    expect(outcome.redirectTo).toBe('/me');
    expect(outcome.session.sid).toHaveLength(43);

    // Assert the audit row was a success row (Req 3.5 audit symmetry).
    const insertCall = queryMock.mock.calls[2] as [string, unknown[]];
    expect(insertCall[0]).toMatch(/INSERT INTO login_attempts/i);
    expect(insertCall[1]).toEqual(['alice@example.com', ipv4, 1]);

    // Session was created with the user's id, role, and request meta.
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).toHaveBeenCalledWith(101, 'Applicant', {
      ipAddress: ipv4,
      userAgent: 'vitest/1.0',
    });
  });

  it.each(['Super_Admin', 'HR', 'Department_Head'] as const)(
    'redirects internal role %s to /admin',
    async (role) => {
      queryMock
        .mockResolvedValueOnce([lockoutRow(0)])
        .mockResolvedValueOnce([userRow({ role })])
        .mockResolvedValueOnce([header(1)]);
      bcryptCompareMock.mockResolvedValueOnce(true);
      createSessionMock.mockResolvedValueOnce({
        sid: 'a'.repeat(43),
        userId: 101,
        role,
        csrfToken: 'b'.repeat(43),
        createdAt: new Date(),
        lastActiveAt: new Date(),
        expiresAt: new Date(),
        ipAddress: ipv4,
        userAgent: null,
      });

      const outcome = await login(happyInput, happyCtx);

      expect(outcome.status).toBe('success');
      if (outcome.status === 'success') {
        expect(outcome.redirectTo).toBe('/admin');
        expect(outcome.role).toBe(role);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// login() — input parsing
// ---------------------------------------------------------------------------

describe('login — input parsing', () => {
  it('throws on structurally invalid input without touching the database', async () => {
    await expect(
      login({ email: '', password: '' }, happyCtx),
    ).rejects.toThrowError();

    expect(queryMock).not.toHaveBeenCalled();
    expect(bcryptCompareMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
