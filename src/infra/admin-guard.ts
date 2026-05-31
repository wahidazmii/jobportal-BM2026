/**
 * Admin_Console authentication guard for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 21.3 (used by `src/routes/admin.ts`)
 * Design  : §6 Admin (HTTP routing map), §14.1 (RBAC policies),
 *           §14.2 (Department_Head scoping)
 * Validates: Requirements 9.1, 11.4, 11.5, 11.6
 *
 * Public surface:
 *   - `AdminSession`              — the `SessionRecord` shape returned
 *                                   to the route, plus a resolved
 *                                   `scope.departments` field for
 *                                   Department_Head sessions.
 *   - `requireAdmin(request,
 *                   reply,
 *                   { allowedRoles? })`
 *                                 — verify the request carries an
 *                                   internal-role session and, if the
 *                                   role is `Department_Head`, resolve
 *                                   the assigned department ids. Returns
 *                                   `null` after writing a 302 redirect
 *                                   to `/{locale}/login` (unauthenticated)
 *                                   or a 403 (authenticated but the
 *                                   role is outside `allowedRoles`).
 *
 * Why a separate guard from `requireApplicant`:
 *   - Admin routes accept three roles (Super_Admin / HR /
 *     Department_Head) instead of a single role, so the guard takes
 *     an `allowedRoles` parameter for per-route narrowing.
 *   - Department_Head sessions need their assignment list resolved at
 *     guard time so the route can pass `scope.departments` straight
 *     into the repo without an extra lookup. We do the lookup once,
 *     in the guard, instead of asking every route to remember.
 *   - The 403 page differs from the applicant redirect: an authenticated
 *     internal user who hits the wrong route should see the canonical
 *     403 (currently a JSON body — Phase 8 will swap it for
 *     `views/admin/403.njk`), not be bounced back to the login form.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { query, type RowDataPacket } from './db.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
} from './csrf.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  TOKEN_LENGTH,
  type SessionRecord,
  type UserRole,
  read as readSession,
} from './session-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Locale segments accepted by the auth-protected routes. */
export const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['id', 'en']);

/** Default locale used when the URL does not carry a recognised one. */
export const DEFAULT_LOCALE = 'id';

/** Internal roles allowed into the Admin_Console at all (per Req 11). */
export const INTERNAL_ROLES: readonly UserRole[] = [
  'Super_Admin',
  'HR',
  'Department_Head',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Session augmented with Department_Head scope. For Super_Admin and
 * HR, `scope.departments` is `undefined` — the repository layer
 * treats that as "no scoping" and the user sees every row.
 *
 * For Department_Head, `scope.departments` is an array of the ids
 * the user owns. The array MAY be empty: in that case the repo's
 * `applyDepartmentScope` short-circuits to zero rows, which matches
 * the Req 11.4 rule "scoped to assigned departments" and makes
 * un-assigned Dept_Heads see nothing.
 */
export interface AdminSession extends SessionRecord {
  readonly scope: {
    readonly departments?: readonly number[];
  };
}

interface AssignmentRow extends RowDataPacket {
  department_id: number | string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LocaleParams {
  readonly locale?: unknown;
}

function resolveRequestLocale(request: FastifyRequest): string {
  const params = (request.params ?? {}) as LocaleParams;
  const raw = params.locale;
  if (typeof raw === 'string' && SUPPORTED_LOCALES.has(raw)) {
    return raw;
  }
  return DEFAULT_LOCALE;
}

/**
 * 302 → /{locale}/login plus cookie clearing. Identical to the
 * applicant guard's redirect except the redirect target is the
 * locale-prefixed login URL — internal users share the same login
 * page as applicants today.
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

/**
 * 403 forbidden response. The Phase-8 admin theme swaps the JSON for a
 * rendered `views/admin/403.njk` page — until that lands, the JSON
 * keeps the contract simple for tests.
 */
function send403(reply: FastifyReply, role: UserRole): FastifyReply {
  return reply.code(403).send({ error: 'forbidden', role });
}

const SELECT_ASSIGNED_DEPARTMENTS_SQL =
  'SELECT department_id FROM user_department_assignments WHERE user_id = ?';

/** Resolve assigned department ids for a Department_Head session. */
async function loadDepartmentScope(userId: number): Promise<readonly number[]> {
  const rows = await query<AssignmentRow[]>(
    SELECT_ASSIGNED_DEPARTMENTS_SQL,
    [userId],
  );
  return rows.map((row) => Number(row.department_id));
}

// ---------------------------------------------------------------------------
// Public guard
// ---------------------------------------------------------------------------

export interface RequireAdminOptions {
  /**
   * Roles permitted to enter the route. Defaults to all internal
   * roles (Super_Admin, HR, Department_Head). Routes that should
   * exclude Dept_Head pass `['Super_Admin', 'HR']`.
   */
  readonly allowedRoles?: readonly UserRole[];
}

/**
 * Resolve and authorise the request's session for the Admin_Console.
 *
 * Outcomes:
 *   - Missing / invalid / expired session  → 302 to `/{locale}/login`
 *     and returns `null`.
 *   - Authenticated session with role NOT in `INTERNAL_ROLES`
 *     (Applicant)                          → 302 to `/{locale}/login`
 *     (no leak of the admin URL surface to applicant cookies).
 *   - Authenticated internal session with role NOT in `allowedRoles`
 *                                          → 403 + JSON body. Returns
 *     `null`. Audit-log integration lands with task 39.1 / 40.
 *   - Otherwise                            → returns `AdminSession`.
 *
 * Callers MUST early-return when the result is `null`.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RequireAdminOptions = {},
): Promise<AdminSession | null> {
  const sid = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid !== 'string' || sid.length !== TOKEN_LENGTH) {
    redirectToLogin(request, reply);
    return null;
  }

  let session: SessionRecord | null;
  try {
    session = await readSession(sid);
  } catch (err) {
    request.log.warn(
      { err, sidPrefix: sid.slice(0, 8) },
      'admin-guard: session lookup failed, redirecting to login',
    );
    redirectToLogin(request, reply);
    return null;
  }

  if (session === null) {
    redirectToLogin(request, reply);
    return null;
  }

  if (!INTERNAL_ROLES.includes(session.role)) {
    // Applicant cookie hitting an admin URL → treat as
    // unauthenticated for this surface so we don't leak the admin
    // existence to the wrong audience.
    redirectToLogin(request, reply);
    return null;
  }

  const allowed = options.allowedRoles ?? INTERNAL_ROLES;
  if (!allowed.includes(session.role)) {
    send403(reply, session.role);
    return null;
  }

  // Resolve Department_Head scoping. For Super_Admin / HR we keep
  // `scope.departments` undefined so the repo applies no clause.
  let scope: AdminSession['scope'];
  if (session.role === 'Department_Head') {
    try {
      const depts = await loadDepartmentScope(session.userId);
      scope = { departments: depts };
    } catch (err) {
      request.log.error(
        { err, userId: session.userId },
        'admin-guard: failed to resolve department scope',
      );
      // Fail closed: no assignments → no rows.
      scope = { departments: [] };
    }
  } else {
    scope = {};
  }

  return { ...session, scope };
}
