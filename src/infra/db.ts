/**
 * MySQL connection pool & helpers for PT Buana Megah Job Portal.
 *
 * Owns the single shared `mysql2/promise` pool used by every repository
 * module. The pool is created at module-load time from `process.env.DATABASE_URL`;
 * connection options follow Design §20.1 (small connectionLimit because
 * cPanel shared MySQL caps total connections per cPanel user).
 *
 * Exports:
 *   - `pool`            — the shared `mysql2/promise` Pool instance.
 *   - `query<T>()`      — prepared-statement wrapper around `pool.execute`.
 *   - `withTransaction` — BEGIN / COMMIT / ROLLBACK helper with auto release.
 *   - `closePool()`     — graceful shutdown for SIGTERM / SIGINT handlers.
 *   - re-exported mysql2 row types for repository typing convenience.
 *
 * The `query<T>` wrapper always uses `pool.execute` (server-side prepared
 * statements) instead of `pool.query`, satisfying Req 15.4. The lint rule
 * `local/no-string-concat-sql` enforces the same constraint at call sites.
 *
 * Validates: Requirements 1.2, 15.4 (Design §20.1)
 */

import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
} from 'mysql2/promise';
import type {
  FieldPacket,
  OkPacket,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2';

/**
 * Resolve the MySQL connection URI from `process.env.DATABASE_URL`.
 *
 * Behaviour by `NODE_ENV`:
 *   - `production`: missing/empty value is a fatal misconfiguration; throws.
 *   - `test`:       falls back to a dummy URI so vitest can import the module
 *                   even when no real database is available.
 *   - otherwise:    falls back to a localhost placeholder for `npm run dev`
 *                   when the developer hasn't exported one yet.
 */
function resolveDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  if (raw && raw.trim() !== '') {
    return raw;
  }

  if (nodeEnv === 'production') {
    throw new Error(
      'DATABASE_URL is required when NODE_ENV=production but was not set. ' +
        'Configure it via the cPanel "Setup Node.js App" environment ' +
        'variables (Req 1 AC #9).',
    );
  }

  if (nodeEnv === 'test') {
    return 'mysql://test:test@127.0.0.1:3306/ptk_test';
  }

  return 'mysql://localhost/placeholder';
}

/**
 * Pool options per Design §20.1. Kept as a const so tests can introspect
 * the configuration without re-creating a pool.
 */
const POOL_OPTIONS: Omit<PoolOptions, 'uri'> = {
  connectionLimit: 10,
  queueLimit: 50,
  waitForConnections: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  namedPlaceholders: true,
  timezone: 'Z',
  decimalNumbers: true,
};

/** The single shared connection pool. mysql2 creates connections lazily. */
export const pool: Pool = mysql.createPool({
  uri: resolveDatabaseUrl(),
  ...POOL_OPTIONS,
});

/**
 * Re-export mysql2 row/result types so repository modules can import them
 * from `@/infra/db` instead of pulling from `mysql2` directly.
 */
export type {
  FieldPacket,
  OkPacket,
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
};

/**
 * Accepted shapes for query parameters.
 *
 * - Positional placeholders (`?`) take a tuple/array.
 * - Named placeholders (`:name`) take a plain object — enabled by
 *   `namedPlaceholders: true` on the pool.
 */
export type SqlParams =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>
  | undefined;

/**
 * Run a parameterised SQL statement against the shared pool using a
 * server-side prepared statement (`pool.execute`). The default generic
 * shapes the result as `RowDataPacket[]`; callers performing INSERT/UPDATE
 * pass `ResultSetHeader` instead.
 *
 * Examples:
 *   const rows = await query<UserRow[]>(
 *     'SELECT id, email FROM users WHERE id = :id',
 *     { id: userId },
 *   );
 *   const result = await query<ResultSetHeader>(
 *     'UPDATE users SET email = :email WHERE id = :id',
 *     { email, id: userId },
 *   );
 */
export async function query<T = RowDataPacket[]>(
  sql: string,
  params?: SqlParams,
): Promise<T> {
  const [rows] = await pool.execute(sql, params as never);
  return rows as T;
}

/**
 * Run `fn` inside a single MySQL transaction.
 *
 * Lifecycle:
 *   1. Acquire a connection from the pool.
 *   2. `BEGIN`.
 *   3. Invoke `fn(connection)`; the callback **must** route all queries
 *      through this connection (not the global `pool`) so they participate
 *      in the transaction.
 *   4. On resolve   → `COMMIT` and return the value.
 *   5. On reject    → `ROLLBACK` (best-effort) and re-throw the original
 *      error.
 *   6. Always       → `connection.release()` so the slot returns to the
 *      pool, regardless of commit/rollback outcome.
 *
 * Rollback is best-effort: if the rollback itself throws (e.g. the
 * connection has already been killed by the server), the original error
 * is still propagated so callers see the real failure cause.
 */
export async function withTransaction<T>(
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (err) {
      try {
        await connection.rollback();
      } catch {
        // Swallow rollback errors so the original failure surfaces to
        // the caller. The pool will dispose of the bad connection on
        // release().
      }
      throw err;
    }
  } finally {
    connection.release();
  }
}

/**
 * Drain and close the shared pool. Intended for SIGTERM / SIGINT handlers
 * and for vitest teardown (`tests/setup.ts`). Idempotent in practice:
 * subsequent calls reject because mysql2 marks the pool closed, so
 * callers should guard with try/catch when wiring multiple shutdown paths.
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
