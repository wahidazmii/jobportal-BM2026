/**
 * Phase 2 checkpoint integration test (task 14).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 14 — "Pastikan all tests pass; verifikasi
 *           alur register → verify → login → logout secara manual via
 *           integration test."
 * Design  : §8.1 (register → verify → login sequence), §8.4 (session
 *           lifecycle), §6 Auth.
 * Validates:
 *   - Requirement 3.1 — registration creates a pending account, sends
 *     a verify mail, and renders the generic confirmation page.
 *   - Requirement 3.3 — the verify endpoint atomically activates the
 *     user and consumes the token.
 *   - Requirement 3.5 — login on an active account creates a session,
 *     sets the `__Host-sid` cookie, and redirects to `/{locale}/me`;
 *     logout destroys the session and clears both auth cookies.
 *   - Requirement 3.6 — login does not leak whether the email exists
 *     (covered indirectly by the success path here; the no-leak
 *     branch is exhaustively tested in `auth-login.test.ts`).
 *
 * Scope:
 *   This test exercises the FULL Fastify app via `buildApp()` +
 *   `app.inject()`. The only boundary we mock is the database
 *   layer (`src/infra/db.ts`) plus bcrypt — no MySQL is required.
 *
 *   Mocking the DB at the `query` / `withTransaction` boundary keeps
 *   the test deterministic while still letting every route, plugin,
 *   middleware and view template execute end-to-end. This is the
 *   integration-test seam the production server uses too: the build
 *   pipeline emits `artifacts/api-server/dist/index.mjs` which calls
 *   the same `buildApp()` factory.
 *
 *   We deliberately do NOT mock `auth/register.ts`, `auth/verify.ts`,
 *   `auth/login.ts`, or `session-store.ts` — those modules exercise
 *   the real schema parsing, transaction sequencing, cookie issuing
 *   and lockout decisions, which is exactly what we want this
 *   checkpoint to confirm still hangs together after the Phase-2
 *   changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mock setup — must run before importing modules under test
// ---------------------------------------------------------------------------

/**
 * `pool.query` is invoked by `/healthz` only; the mocked function is
 * unused for this flow but the mock keeps `db.ts` import-side-effect
 * free so Fastify can boot without a live MySQL.
 */
const poolQueryMock = vi.fn();

/**
 * `query()` is the prepared-statement helper used by every repository
 * module. Each test programs the responses in arrival order via
 * `mockImplementationOnce` / `mockResolvedValueOnce` — see the helpers
 * below for the canonical sequences.
 */
const queryMock = vi.fn();

/**
 * `withTransaction(fn)` wraps a callback in a BEGIN/COMMIT pair. Our
 * mock invokes the callback with a fake `PoolConnection` whose
 * `execute()` is a vi.fn — programmed per call site so the
 * transactional INSERT/UPDATE chain returns the expected
 * `ResultSetHeader` / row tuple.
 */
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: poolQueryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: queryMock,
  withTransaction: withTransactionMock,
}));

/**
 * bcrypt is mocked so the integration test stays fast (a real hash at
 * cost 12 is ~250 ms per call) and so we can assert deterministically
 * which password matches. `hash()` returns a fixed string that mimics
 * a real `$2b$12$…` value; `compare()` is programmed per test.
 */
const bcryptHashMock = vi.fn();
const bcryptCompareMock = vi.fn();
vi.mock('bcrypt', () => ({
  default: {
    hash: bcryptHashMock,
    compare: bcryptCompareMock,
  },
  hash: bcryptHashMock,
  compare: bcryptCompareMock,
}));

// Import after mocks register so the production module graph picks up
// the mocked db / bcrypt boundaries.
const { buildApp } = await import('../../src/server.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLICANT_USER_ID = 42;
const APPLICANT_EMAIL = 'alice@example.com';
const APPLICANT_PASSWORD = 'Password123';
const APPLICANT_PASSWORD_HASH =
  '$2b$12$abcdefghijklmnopqrstuvCpkkVZ4eNi9hAvIQS5Q8aZdQk6Vvu5/i';

/**
 * Captured by the register handler when it calls
 * `connection.execute('INSERT INTO verification_tokens …', [token, …])`.
 * Re-used as the `?token=…` query string for the verify step so the
 * test exercises the same token end-to-end.
 */
let issuedVerificationToken = '';

/**
 * Captured at session creation time by `session-store.create()`. Re-used
 * to drive the cookie-bearing requests for the `/me` access (not part
 * of this test) and the logout step.
 */
let issuedSessionId = '';

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://localhost',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `ResultSetHeader` shape that mysql2 returns from
 * `connection.execute()` for INSERT / UPDATE / DELETE statements.
 */
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
 * Pull cookies out of Fastify's `set-cookie` response header. The
 * header may be a single string or an array depending on how many
 * cookies the route set; we coerce to an array of `Name=Value` pairs
 * (without the `; HttpOnly; …` attributes) so individual tests can
 * assert presence / value.
 */
function readCookies(res: { headers: Record<string, unknown> }): Map<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw === undefined ? [] : [raw as string];
  const out = new Map<string, string>();
  for (const entry of list) {
    const semicolon = entry.indexOf(';');
    const head = semicolon === -1 ? entry : entry.slice(0, semicolon);
    const eq = head.indexOf('=');
    if (eq <= 0) continue;
    out.set(head.slice(0, eq), head.slice(eq + 1));
  }
  return out;
}

/**
 * Returns true when the `Set-Cookie` for `name` is a clear (Max-Age=0
 * or `Expires=Thu, 01 Jan 1970`). `@fastify/cookie`'s `clearCookie()`
 * uses one or both forms depending on the runtime, so we accept either.
 */
function isCookieCleared(
  res: { headers: Record<string, unknown> },
  name: string,
): boolean {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw === undefined ? [] : [raw as string];
  const entry = list.find((e) => e.startsWith(`${name}=`));
  if (entry === undefined) return false;
  return /Max-Age=0/i.test(entry) || /Expires=Thu, 01 Jan 1970/i.test(entry);
}

/**
 * Create a fake `PoolConnection` whose `execute()` we program per call.
 * Mirrors the helper used by `auth-register.test.ts`.
 */
function createFakeConnection() {
  const executeMock = vi.fn();
  return { connection: { execute: executeMock }, executeMock };
}

/** Bind `withTransactionMock` to invoke the callback with `connection`. */
function bindNextTransaction(connection: { execute: ReturnType<typeof vi.fn> }) {
  withTransactionMock.mockImplementationOnce(
    async (fn: (conn: typeof connection) => Promise<unknown>) => fn(connection),
  );
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  bcryptHashMock.mockReset();
  bcryptCompareMock.mockReset();

  // bcrypt.hash returns a deterministic hash for the registration step.
  bcryptHashMock.mockResolvedValue(APPLICANT_PASSWORD_HASH);

  issuedVerificationToken = '';
  issuedSessionId = '';
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

describe('Phase 2 checkpoint — register → verify → login → logout', () => {
  it('walks the full happy-path sequence using only the db boundary as the mock seam', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      // ── Step 1: POST /id/register ───────────────────────────────
      // Rate-limit: bucket empty (no row) → checkRateLimit allows.
      // After the service succeeds the route calls `recordHit` which
      // emits an INSERT…ON DUPLICATE KEY UPDATE.
      queryMock
        .mockResolvedValueOnce([]) // checkRateLimit: empty bucket
        .mockResolvedValueOnce(header(0)); // recordHit INSERT…ODKU

      // Inside `register()` the service runs:
      //   1. SELECT users WHERE email = ?            → empty (no dup)
      //   2. INSERT users …                          → insertId = APPLICANT_USER_ID
      //   3. INSERT applicants …                     → affectedRows = 1
      //   4. INSERT consent_records …                → affectedRows = 1
      //   5. INSERT verification_tokens (token, …)   → captured below
      //   6. SELECT mail_templates (verify, id)      → DB override row
      //   7. INSERT IGNORE INTO mail_outbox …        → affectedRows = 1
      //
      // Steps 6-7 belong to `mail.enqueue()` (task 36.1): it now resolves
      // the `verify` template from `mail_templates` and writes the rendered
      // row into `mail_outbox` on the SAME transaction connection (Design
      // §12.3 — the verify mail is queued atomically with the user row).
      const registerConn = createFakeConnection();
      registerConn.executeMock
        // 1. dup-email pre-check returns no rows.
        .mockResolvedValueOnce([[] as RowDataPacket[], []])
        // 2. users INSERT — return the canonical insertId.
        .mockResolvedValueOnce([header(APPLICANT_USER_ID), []])
        // 3. applicants INSERT.
        .mockResolvedValueOnce([header(1), []])
        // 4. consent_records INSERT.
        .mockResolvedValueOnce([header(1), []])
        // 5. verification_tokens INSERT — capture the token bound to `?`.
        .mockImplementationOnce(async (_sql: string, params: unknown[]) => {
          const [token] = params as [string, number, ...unknown[]];
          issuedVerificationToken = token;
          return [header(1), []];
        })
        // 6. mail.enqueue → mail_templates SELECT (DB override present).
        .mockResolvedValueOnce([
          [
            {
              subject: 'Verifikasi email Anda',
              body_html: '<p>Token: {{ token }}</p>',
              body_text: null,
            } as RowDataPacket,
          ],
          [],
        ])
        // 7. mail.enqueue → INSERT IGNORE INTO mail_outbox.
        .mockResolvedValueOnce([header(1), []]);
      bindNextTransaction(registerConn.connection);

      const registerRes = await app.inject({
        method: 'POST',
        url: '/id/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'email=' +
          encodeURIComponent(APPLICANT_EMAIL) +
          '&password=' +
          encodeURIComponent(APPLICANT_PASSWORD) +
          '&consent=on&captchaToken=cap-token',
      });

      // Generic confirmation page — Req 3.1 + Req 3.2 (no leak between
      // brand-new and duplicate-email branches).
      expect(registerRes.statusCode).toBe(200);
      expect(registerRes.headers['content-type']).toMatch(/text\/html/);
      expect(registerRes.body).toMatch(/Periksa Email Anda/);

      // The service captured a 43-char base64url token.
      expect(issuedVerificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // bcrypt.hash invoked at cost 12 (Req 3.10). Asserted on the
      // mock because `register()` outsources hashing here.
      expect(bcryptHashMock).toHaveBeenCalledTimes(1);
      const [hashedInput, cost] = bcryptHashMock.mock.calls[0] as [
        string,
        number,
      ];
      expect(hashedInput).toBe(APPLICANT_PASSWORD);
      expect(cost).toBe(12);

      // ── Step 2: GET /id/verify?token=… ─────────────────────────
      // The service runs three statements in one transaction:
      //   1. SELECT … FROM verification_tokens WHERE token = ? AND
      //      used_at IS NULL AND expires_at > NOW() FOR UPDATE
      //          → return one row pointing at APPLICANT_USER_ID.
      //   2. UPDATE users SET status='active', email_verified_at=NOW()
      //      WHERE id = ? AND status='pending'
      //          → affectedRows = 1.
      //   3. UPDATE verification_tokens SET used_at=NOW() WHERE token = ?
      //          → affectedRows = 1.
      const verifyConn = createFakeConnection();
      verifyConn.executeMock
        .mockResolvedValueOnce([
          [{ user_id: APPLICANT_USER_ID } as RowDataPacket],
          [],
        ])
        .mockResolvedValueOnce([header(0, 1), []])
        .mockResolvedValueOnce([header(0, 1), []]);
      bindNextTransaction(verifyConn.connection);

      const verifyRes = await app.inject({
        method: 'GET',
        url: '/id/verify?token=' + encodeURIComponent(issuedVerificationToken),
      });

      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.headers['content-type']).toMatch(/text\/html/);
      // Success view — confirms the user was atomically activated.
      expect(verifyRes.body).toMatch(/Email Berhasil Diverifikasi/);
      // The success page CTA points at the login form (Req 3.3 wiring).
      expect(verifyRes.body).toContain('/id/login');

      // ── Step 3: POST /id/login ─────────────────────────────────
      // Sequence consumed by `query()` from the login service:
      //   1. SELECT lockout aggregate          → 0 failures (clear).
      //   2. SELECT users WHERE email = ?       → return active row.
      //   3. INSERT login_attempts (success=1)  → audit row.
      // Then session-store.create() runs (also via `query()`):
      //   4. INSERT INTO sessions …             → affectedRows = 1.
      //   5. SELECT session JOIN users …        → return the fresh row
      //      with the canonical timestamps and the JOIN'd role.
      queryMock
        // 1. lockout pre-check.
        .mockResolvedValueOnce([
          {
            failure_count: 0,
            retry_after_seconds: null,
          } as RowDataPacket,
        ])
        // 2. user lookup.
        .mockResolvedValueOnce([
          {
            id: APPLICANT_USER_ID,
            password_hash: APPLICANT_PASSWORD_HASH,
            role: 'Applicant',
            status: 'active',
          } as RowDataPacket,
        ])
        // 3. INSERT login_attempts(success=1).
        .mockResolvedValueOnce(header(1))
        // 4. INSERT INTO sessions … — capture the sid bound to `?`.
        .mockImplementationOnce(async (_sql: string, params: unknown[]) => {
          const [sid] = params as [string, number, string, ...unknown[]];
          issuedSessionId = sid;
          return header(1);
        })
        // 5. SELECT session JOIN users — re-fetch after INSERT so the
        //    record carries DB-authoritative timestamps.
        .mockImplementationOnce(async (_sql: string, params: unknown[]) => {
          const [sid] = params as [string];
          const now = new Date();
          const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000);
          const row = {
            sid,
            userId: APPLICANT_USER_ID,
            role: 'Applicant',
            csrfToken: 'csrf-token-' + sid.slice(0, 8),
            createdAt: now,
            lastActiveAt: now,
            expiresAt,
            ipAddress: null,
            userAgent: null,
          } as RowDataPacket;
          return [row];
        });

      // bcrypt.compare returns true for the canonical password.
      bcryptCompareMock.mockResolvedValueOnce(true);

      const loginRes = await app.inject({
        method: 'POST',
        url: '/id/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload:
          'email=' +
          encodeURIComponent(APPLICANT_EMAIL) +
          '&password=' +
          encodeURIComponent(APPLICANT_PASSWORD),
      });

      // 302 to /id/me — Applicant role per the user lookup row above.
      expect(loginRes.statusCode).toBe(302);
      expect(loginRes.headers.location).toBe('/id/me');

      // bcrypt.compare ran exactly once with the form password and the
      // hash we returned from the user lookup row (Req 3.6 — same code
      // path runs against a real-shaped hash).
      expect(bcryptCompareMock).toHaveBeenCalledTimes(1);
      expect(bcryptCompareMock.mock.calls[0]?.[0]).toBe(APPLICANT_PASSWORD);
      expect(bcryptCompareMock.mock.calls[0]?.[1]).toBe(
        APPLICANT_PASSWORD_HASH,
      );

      // The route issued the canonical session + csrf cookies.
      const loginCookies = readCookies(loginRes);
      expect(loginCookies.has('__Host-sid')).toBe(true);
      expect(loginCookies.has('csrf_token')).toBe(true);
      // The cookie value is the session id we captured at INSERT time.
      expect(loginCookies.get('__Host-sid')).toBe(issuedSessionId);
      expect(issuedSessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // ── Step 4: POST /id/logout ────────────────────────────────
      // The logout handler calls `session-store.destroy(sid)` which is
      // a single DELETE FROM sessions WHERE id = ?. CSRF middleware is
      // not registered globally on the Fastify instance built by
      // `buildApp()` (see src/server.ts), so the request needs only
      // the `__Host-sid` cookie to be accepted.
      queryMock.mockResolvedValueOnce(header(0, 1)); // DELETE FROM sessions

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/id/logout',
        cookies: { '__Host-sid': issuedSessionId },
      });

      // 302 → /id/ with both cookies cleared.
      expect(logoutRes.statusCode).toBe(302);
      expect(logoutRes.headers.location).toBe('/id/');
      expect(isCookieCleared(logoutRes, '__Host-sid')).toBe(true);
      expect(isCookieCleared(logoutRes, 'csrf_token')).toBe(true);

      // The DELETE went out with the EXACT sid the login flow issued.
      const lastCall = queryMock.mock.calls.at(-1) as [string, unknown[]];
      expect(lastCall[0]).toMatch(/DELETE FROM sessions WHERE id = \?/i);
      expect(lastCall[1]).toEqual([issuedSessionId]);
    } finally {
      await app.close();
    }
  });
});
