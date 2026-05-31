/**
 * Unit tests for `src/infra/session-store.ts` (task 8.1).
 *
 * Validates: Requirements 3.5 (Design §8.4)
 *
 * The store talks to MySQL via `query()` from `src/infra/db.ts`; we mock
 * that module before importing the store so the suite stays hermetic. The
 * tests assert two things in tandem:
 *   1. The public surface (constants, CRUD return shapes, token format).
 *   2. The exact SQL handed to `query()` — the timeouts, the absolute
 *      `INTERVAL 12 HOUR`, and the idle `INTERVAL 30 MINUTE` are encoded
 *      directly in the statements, so a regression in either is a
 *      regression in the design contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  pool: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after the mock is registered.
const sessionStore = await import('../../src/infra/session-store.js');
const {
  ABSOLUTE_TIMEOUT_HOURS,
  ABSOLUTE_TIMEOUT_MS,
  CSRF_COOKIE_NAME,
  IDLE_TIMEOUT_MINUTES,
  IDLE_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  TOKEN_BYTES,
  TOKEN_LENGTH,
  create,
  destroy,
  generateToken,
  read,
  revokeAllForUser,
  touch,
} = sessionStore;

/** Helper: build a fake session row that matches `SessionRow`. */
function makeRow(overrides: Partial<Record<string, unknown>> = {}): RowDataPacket {
  const now = new Date('2025-01-01T00:00:00.000Z');
  const expires = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);
  return {
    sid: 'a'.repeat(TOKEN_LENGTH),
    userId: 42,
    role: 'Applicant',
    csrfToken: 'b'.repeat(TOKEN_LENGTH),
    createdAt: now,
    lastActiveAt: now,
    expiresAt: expires,
    ipAddress: null,
    userAgent: null,
    ...overrides,
  } as unknown as RowDataPacket;
}

/** Helper: build a fake `ResultSetHeader` with a chosen affectedRows. */
function makeHeader(affectedRows: number): ResultSetHeader {
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

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  queryMock.mockReset();
});

describe('constants (design §8.4 / §8.6)', () => {
  it('declares 32-byte tokens encoded as 43-char base64url', () => {
    expect(TOKEN_BYTES).toBe(32);
    expect(TOKEN_LENGTH).toBe(43);
  });

  it('declares 30-minute idle timeout', () => {
    expect(IDLE_TIMEOUT_MINUTES).toBe(30);
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('declares 12-hour absolute timeout', () => {
    expect(ABSOLUTE_TIMEOUT_HOURS).toBe(12);
    expect(ABSOLUTE_TIMEOUT_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('uses the `__Host-sid` cookie name and the design-mandated attributes', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-sid');
    expect(SESSION_COOKIE_OPTIONS).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    // Must be frozen so callers can't mutate the shared object.
    expect(Object.isFrozen(SESSION_COOKIE_OPTIONS)).toBe(true);
  });

  it('exposes the non-HttpOnly csrf cookie name', () => {
    expect(CSRF_COOKIE_NAME).toBe('csrf_token');
  });
});

describe('generateToken', () => {
  it('emits 43-char base64url tokens (32 random bytes, no padding)', () => {
    const tok = generateToken();
    expect(tok).toHaveLength(TOKEN_LENGTH);
    // base64url alphabet: A-Z a-z 0-9 - _
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tok).not.toContain('=');
  });

  it('produces fresh values on every call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe('create', () => {
  it('inserts a session with NOW()+INTERVAL 12 HOUR expires_at and re-reads it', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(1)) // INSERT
      .mockResolvedValueOnce([makeRow({ userId: 7, role: 'HR' })]); // SELECT

    const session = await create(7, 'HR', {
      ipAddress: Buffer.from([10, 0, 0, 1]),
      userAgent: 'vitest/1',
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toMatch(/INSERT INTO sessions/i);
    expect(insertSql).toMatch(/NOW\(\)\s*\+\s*INTERVAL\s+12\s+HOUR/i);
    expect(insertSql).toMatch(/\(id, user_id, csrf_token, ip_address, user_agent, expires_at\)/i);
    expect(insertParams).toHaveLength(5);
    const [sid, userId, csrfToken, ip, ua] = insertParams as [
      string,
      number,
      string,
      Buffer | null,
      string | null,
    ];
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sid).not.toBe(csrfToken);
    expect(userId).toBe(7);
    expect(ip).toBeInstanceOf(Buffer);
    expect(ua).toBe('vitest/1');

    expect(session.userId).toBe(7);
    // Caller-supplied role is echoed even if the JOIN read a different one.
    expect(session.role).toBe('HR');
    expect(session.sid).toHaveLength(TOKEN_LENGTH);
    expect(session.csrfToken).toHaveLength(TOKEN_LENGTH);
  });

  it('defaults ip_address and user_agent to NULL when not supplied', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(1))
      .mockResolvedValueOnce([makeRow()]);

    await create(1, 'Applicant');

    const [, insertParams] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(insertParams[3]).toBeNull();
    expect(insertParams[4]).toBeNull();
  });

  it('throws if the post-insert re-read returns no row', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(1)) // INSERT
      .mockResolvedValueOnce([]); // SELECT — empty

    await expect(create(1, 'Applicant')).rejects.toThrow(/not visible after insert/);
  });
});

describe('read', () => {
  it('returns null without hitting the DB for malformed sids', async () => {
    expect(await read('')).toBeNull();
    expect(await read('short')).toBeNull();
    // 44 chars instead of 43.
    expect(await read('a'.repeat(44))).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('issues a SELECT that enforces both idle and absolute timeouts', async () => {
    queryMock.mockResolvedValueOnce([makeRow()]);

    const result = await read('a'.repeat(TOKEN_LENGTH));
    expect(result).not.toBeNull();

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM sessions s/i);
    expect(sql).toMatch(/JOIN users u ON u.id = s.user_id/i);
    expect(sql).toMatch(/s\.expires_at\s*>\s*NOW\(\)/i);
    expect(sql).toMatch(/s\.last_active_at\s*>=\s*NOW\(\)\s*-\s*INTERVAL\s+30\s+MINUTE/i);
    expect(sql).toMatch(/LIMIT 1/i);
    expect(params).toEqual(['a'.repeat(TOKEN_LENGTH)]);
  });

  it('returns null when the session row is missing or expired', async () => {
    queryMock.mockResolvedValueOnce([]);
    expect(await read('a'.repeat(TOKEN_LENGTH))).toBeNull();
  });

  it('maps DB row columns onto the SessionRecord shape', async () => {
    const created = new Date('2025-06-01T12:00:00.000Z');
    const lastActive = new Date('2025-06-01T12:10:00.000Z');
    const expires = new Date('2025-06-02T00:00:00.000Z');
    queryMock.mockResolvedValueOnce([
      makeRow({
        sid: 'c'.repeat(TOKEN_LENGTH),
        userId: 99,
        role: 'Super_Admin',
        csrfToken: 'd'.repeat(TOKEN_LENGTH),
        createdAt: created,
        lastActiveAt: lastActive,
        expiresAt: expires,
        ipAddress: Buffer.from([192, 168, 1, 1]),
        userAgent: 'curl/8',
      }),
    ]);

    const session = await read('c'.repeat(TOKEN_LENGTH));
    expect(session).toEqual({
      sid: 'c'.repeat(TOKEN_LENGTH),
      userId: 99,
      role: 'Super_Admin',
      csrfToken: 'd'.repeat(TOKEN_LENGTH),
      createdAt: created,
      lastActiveAt: lastActive,
      expiresAt: expires,
      ipAddress: Buffer.from([192, 168, 1, 1]),
      userAgent: 'curl/8',
    });
  });
});

describe('touch', () => {
  it('returns false without hitting the DB for malformed sids', async () => {
    expect(await touch('')).toBe(false);
    expect(await touch('a'.repeat(42))).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('uses GREATEST(last_active_at, NOW()) and gates on both timeouts', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));

    const ok = await touch('a'.repeat(TOKEN_LENGTH));
    expect(ok).toBe(true);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE sessions/i);
    expect(sql).toMatch(/SET\s+last_active_at\s*=\s*GREATEST\(\s*last_active_at\s*,\s*NOW\(\)\s*\)/i);
    expect(sql).toMatch(/expires_at\s*>\s*NOW\(\)/i);
    expect(sql).toMatch(/last_active_at\s*>=\s*NOW\(\)\s*-\s*INTERVAL\s+30\s+MINUTE/i);
    expect(params).toEqual(['a'.repeat(TOKEN_LENGTH)]);
  });

  it('returns false when no row matched (expired / missing)', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(0));
    expect(await touch('a'.repeat(TOKEN_LENGTH))).toBe(false);
  });
});

describe('destroy', () => {
  it('issues a DELETE on the sid', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));
    await destroy('a'.repeat(TOKEN_LENGTH));

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM sessions WHERE id = \?/i);
    expect(params).toEqual(['a'.repeat(TOKEN_LENGTH)]);
  });

  it('is a no-op for malformed sids', async () => {
    await destroy('');
    await destroy('not-43-chars');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('revokeAllForUser', () => {
  it('deletes every row for the given user_id and returns affectedRows', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(3));

    const removed = await revokeAllForUser(42);
    expect(removed).toBe(3);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM sessions WHERE user_id = \?/i);
    expect(params).toEqual([42]);
  });

  it('returns 0 when the user has no sessions', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(0));
    expect(await revokeAllForUser(999)).toBe(0);
  });
});
