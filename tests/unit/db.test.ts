/**
 * Unit tests for the database helpers in `src/infra/db.ts`.
 *
 * Validates: Requirements 15.4 (Design §20.1)
 *
 * These tests cover the transaction lifecycle of `withTransaction` using a
 * fake `PoolConnection`. We do not boot mysql2 or talk to a real database;
 * this keeps the unit suite hermetic while still exercising the
 * BEGIN / COMMIT / ROLLBACK / release ordering that Req 15.4 depends on.
 *
 * Integration coverage with a live MySQL instance lives under
 * `tests/integration/**` (driven by `tests/setup.integration.ts`).
 */

import { describe, expect, it, vi } from 'vitest';

import { pool, withTransaction } from '../../src/infra/db.js';
import type { PoolConnection } from 'mysql2/promise';

/** Construct an in-memory fake of `PoolConnection` that records call order. */
function createFakeConnection() {
  const calls: string[] = [];

  const connection = {
    beginTransaction: vi.fn(async () => {
      calls.push('begin');
    }),
    commit: vi.fn(async () => {
      calls.push('commit');
    }),
    rollback: vi.fn(async () => {
      calls.push('rollback');
    }),
    release: vi.fn(() => {
      calls.push('release');
    }),
  } as unknown as PoolConnection & {
    beginTransaction: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };

  return { connection, calls };
}

describe('withTransaction', () => {
  it('runs BEGIN, the callback, COMMIT, and release on success', async () => {
    const { connection, calls } = createFakeConnection();
    const getConnectionSpy = vi
      .spyOn(pool, 'getConnection')
      .mockResolvedValue(connection);

    const result = await withTransaction(async (conn) => {
      expect(conn).toBe(connection);
      calls.push('fn');
      return 42;
    });

    expect(result).toBe(42);
    expect(calls).toEqual(['begin', 'fn', 'commit', 'release']);
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);

    getConnectionSpy.mockRestore();
  });

  it('runs BEGIN, the callback, ROLLBACK, and release when the callback throws', async () => {
    const { connection, calls } = createFakeConnection();
    const getConnectionSpy = vi
      .spyOn(pool, 'getConnection')
      .mockResolvedValue(connection);
    const boom = new Error('callback failed');

    await expect(
      withTransaction(async () => {
        calls.push('fn');
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls).toEqual(['begin', 'fn', 'rollback', 'release']);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);

    getConnectionSpy.mockRestore();
  });

  it('still releases the connection if rollback itself throws, and re-raises the original error', async () => {
    const { connection, calls } = createFakeConnection();
    connection.rollback.mockImplementation(async () => {
      calls.push('rollback');
      throw new Error('rollback failed');
    });
    const getConnectionSpy = vi
      .spyOn(pool, 'getConnection')
      .mockResolvedValue(connection);
    const original = new Error('callback failed');

    await expect(
      withTransaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['begin', 'rollback', 'release']);

    getConnectionSpy.mockRestore();
  });

  it('releases the connection even if COMMIT throws and propagates the commit error', async () => {
    const { connection, calls } = createFakeConnection();
    const commitErr = new Error('commit failed');
    connection.commit.mockImplementation(async () => {
      calls.push('commit');
      throw commitErr;
    });
    const getConnectionSpy = vi
      .spyOn(pool, 'getConnection')
      .mockResolvedValue(connection);

    await expect(
      withTransaction(async () => {
        calls.push('fn');
        return 'ok';
      }),
    ).rejects.toBe(commitErr);

    // commit failed → rollback is attempted as part of the catch path,
    // and finally release runs no matter what.
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(calls).toContain('begin');
    expect(calls).toContain('fn');
    expect(calls).toContain('commit');
    expect(calls[calls.length - 1]).toBe('release');

    getConnectionSpy.mockRestore();
  });
});
