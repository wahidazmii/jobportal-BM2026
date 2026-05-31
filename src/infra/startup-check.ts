/**
 * Production startup environment variable validation.
 *
 * `checkRequiredEnvVars()` is called from `main()` in `src/server.ts` before
 * `buildApp()` when `NODE_ENV=production`. It throws a descriptive error if
 * any of the three secrets that are mandatory in production are absent or
 * empty, so the process fails fast with a clear message rather than starting
 * in a broken state.
 *
 * Required in production (Req 1 AC #9, Design §21):
 *   - DATABASE_URL   — MySQL connection string for the mysql2 pool
 *   - SESSION_SECRET — 32-byte hex secret for cookie signing / CSRF
 *   - BASE_URL       — canonical origin used in email links and HSTS
 *
 * Validates: Requirements 1.1, 1.9, 18.1 (Design §21)
 */

/** Names of env vars that must be non-empty in production. */
const REQUIRED_PRODUCTION_VARS = ['DATABASE_URL', 'SESSION_SECRET', 'BASE_URL'] as const;

/**
 * Throw a descriptive `Error` if any required production env var is missing
 * or empty. Safe to call in any environment; the check is a no-op when
 * `NODE_ENV !== 'production'`.
 *
 * @param env - The environment object to inspect (defaults to `process.env`).
 *
 * @throws {Error} When `NODE_ENV=production` and one or more required vars
 *   are absent or empty. The message lists every missing variable so the
 *   operator can fix all issues in one restart cycle.
 *
 * @example
 * // In src/server.ts main():
 * checkRequiredEnvVars();
 * const app = await buildApp(config);
 */
export function checkRequiredEnvVars(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') {
    // Non-production environments (development, test) are allowed to omit
    // secrets so the dev server and test suite work without real credentials.
    return;
  }

  const missing: string[] = [];

  for (const name of REQUIRED_PRODUCTION_VARS) {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[startup-check] Missing required environment variable(s) for production: ` +
        `${missing.join(', ')}. ` +
        `Set these in cPanel → Setup Node.js App → Environment Variables and restart Passenger ` +
        `(touch tmp/restart.txt).`,
    );
  }
}
