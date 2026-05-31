/**
 * Authenticated-request guard helpers for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 16.1 (introduces the helper for the applicant
 *           profile route; later tasks under Phase 3+ wire the same helper
 *           into education / experience / CV / bookmarks / alerts routes).
 * Design  : §8.4 (session lifecycle), §14 (RBAC)
 * Validates: Requirements 3.5, 11.5
 *
 * Public surface:
 *   - `requireApplicant(request, reply)` — read the `__Host-sid` cookie,
 *     resolve the session via the MySQL session-store, and either return
 *     the canonical `SessionRecord` (role === 'Applicant') or short-circuit
 *     the response with a 302 redirect to `/{locale}/login` and return
 *     `null`. Callers MUST early-return when the result is `null` so they
 *     do not double-write the response.
 *
 * Why this lives in `infra/`:
 *   - The session-store module already lives in `infra/session-store.ts`
 *     and the security headers / CSRF helpers next to it. Keeping the
 *     authentication GUARD alongside its dependencies (rather than
 *     scattering a copy in every route) means a future tweak to the
 *     redirect target / cookie-clearing semantics is a single edit.
 *
 * Why redirect with 302 instead of 401:
 *   - The handlers that consume this helper (Phase 3) all render full
 *     HTML pages: a 401 page would force an extra round-trip and the
 *     design (§6 Applicant_Area) explicitly maps unauthenticated access
 *     to "redirect to login". A 401 is reserved for JSON endpoints
 *     (added later under `/api/...`) which take a different path.
 *
 * Why we touch the session here instead of in the route:
 *   - `read()` already enforces both idle (30 min) and absolute (12 h)
 *     timeouts in its WHERE clause, so a row that comes back from
 *     `read()` is by construction a valid session — no extra check
 *     needed in the caller. We deliberately do NOT call `touch()` here:
 *     the caller may decide that a particular request (e.g. healthz,
 *     CSRF preview) should not bump activity. Touching is a separate
 *     concern wired by the middleware in task 14 / Phase 8.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
} from './csrf.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  TOKEN_LENGTH,
  type SessionRecord,
  read as readSession,
} from './session-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Locale segments accepted by the auth-protected routes. */
export const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['id', 'en']);

/** Default locale used when the URL does not carry a recognised one. */
export const DEFAULT_LOCALE = 'id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LocaleParams {
  readonly locale?: unknown;
}

/**
 * Pick the locale segment from the request params, falling back to
 * `DEFAULT_LOCALE` when the segment is missing or unsupported. The
 * function is total: it always returns one of the supported values, so
 * the redirect target is always well-formed.
 */
export function resolveRequestLocale(request: FastifyRequest): string {
  const params = (request.params ?? {}) as LocaleParams;
  const raw = params.locale;
  if (typeof raw === 'string' && SUPPORTED_LOCALES.has(raw)) {
    return raw;
  }
  return DEFAULT_LOCALE;
}

/**
 * Issue the canonical "you are unauthenticated, please log in" response.
 *
 * Behaviour:
 *   - 302 to `/{locale}/login`. The locale is whatever the route had
 *     (defaulting to `id`) so the user lands on the right-language
 *     login form.
 *   - Both `__Host-sid` and `csrf_token` cookies are cleared, mirroring
 *     the same attribute set used at issuance so the browser actually
 *     drops them. This prevents an expired sid from ping-ponging the
 *     user back into the redirect on every request.
 *   - The reply is finalised here (`.send()`); callers MUST early-return
 *     so they do not double-write.
 */
function redirectToLogin(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const locale = resolveRequestLocale(request);
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE_OPTIONS);
  return reply.code(302).header('location', `/${locale}/login`).send();
}

// ---------------------------------------------------------------------------
// Public guard
// ---------------------------------------------------------------------------

/**
 * Require an authenticated Applicant on the current request.
 *
 * Behaviour:
 *   - Reads the `__Host-sid` cookie. If absent or structurally invalid
 *     (not a 43-char base64url string), redirects to `/{locale}/login`
 *     and returns `null`.
 *   - Looks up the session via the MySQL session-store. `read()`
 *     enforces both timeouts (30 min idle / 12 h absolute), so a `null`
 *     return means the row was missing OR expired — both treated as
 *     "not authenticated" and routed to the same login redirect.
 *   - If the session belongs to an internal role (Super_Admin, HR,
 *     Department_Head), redirects to login as well. Internal users
 *     cannot stray into the Applicant_Area, and for an Applicant route
 *     a non-Applicant session is functionally equivalent to "not
 *     authenticated as the right kind of user". We deliberately do NOT
 *     redirect to `/admin` here: that would leak the existence of a
 *     non-Applicant session at this URL.
 *
 * Returns: the `SessionRecord` on success, or `null` on rejection.
 * Callers MUST early-return when the result is `null` to avoid
 * double-writing the response.
 */
export async function requireApplicant(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionRecord | null> {
  const sid = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid !== 'string' || sid.length !== TOKEN_LENGTH) {
    redirectToLogin(request, reply);
    return null;
  }

  let session: SessionRecord | null;
  try {
    session = await readSession(sid);
  } catch (err) {
    // A transient DB error must not strand the user with a confusing
    // 500 — log and treat as unauthenticated. The session-gc cron will
    // eventually clean up any orphaned row.
    request.log.warn(
      { err, sidPrefix: sid.slice(0, 8) },
      'auth-guard: session lookup failed, redirecting to login',
    );
    redirectToLogin(request, reply);
    return null;
  }

  if (session === null) {
    redirectToLogin(request, reply);
    return null;
  }

  if (session.role !== 'Applicant') {
    redirectToLogin(request, reply);
    return null;
  }

  return session;
}
