/**
 * RBAC policy map + `requirePolicy(name)` guard factory for the
 * PT Buana Megah Job Portal Admin_Console.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 39.1 (RBAC middleware)
 * Design  : §14.1 (Policy map — authoritative role→permission table),
 *           §14.3 (Denial: 403 + render `403.njk` + audit AccessDenied)
 * Validates: Requirements 11.1, 11.2, 11.3, 11.6
 *
 * Public surface:
 *   - `PolicyName`                — the union of every named policy in the
 *                                   §14.1 map (plus the derived
 *                                   `mail_template.manage`, see below).
 *   - `POLICIES`                  — the frozen `Record<PolicyName,
 *                                   ReadonlySet<UserRole>>` that encodes
 *                                   §14.1 verbatim. The single source of
 *                                   truth for "which roles may do what".
 *   - `can(role, policy)`         — pure predicate: is `role` in the set
 *                                   of roles allowed for `policy`?
 *   - `requirePolicy(policyName)` — returns a route guard
 *                                   `(request, reply) => Promise<AdminSession | null>`
 *                                   that layers a single-policy check on
 *                                   top of `requireAdmin`.
 *
 * Why build ON TOP of `requireAdmin` instead of replacing it:
 *   `requireAdmin` already owns the hard parts — session lookup, the
 *   unauthenticated 302 redirect, the Applicant-cookie-hitting-admin
 *   redirect, and (crucially) Department_Head scope resolution
 *   (`scope.departments`). `requirePolicy` calls it with NO `allowedRoles`
 *   so the session + scope are resolved first, then applies the §14.1
 *   policy check itself. This keeps scope resolution in one place and lets
 *   the denial path render the proper `views/admin/403.njk` page and write
 *   the `access_denied` audit event (§14.3) — which the bare
 *   `requireAdmin({ allowedRoles })` JSON 403 does not do.
 *
 * Policy naming (design §14.1):
 *   The keys mirror §14.1 exactly (`job.create`, `application.stage.change`,
 *   …). One policy — `mail_template.manage` — is NOT in the §14.1 code
 *   block but is required by Req 11.3 (HR manages mail templates,
 *   Department_Head does not). We add it following the same
 *   `resource.action` convention and the same {Super_Admin, HR} grant the
 *   mail-template editor already enforced via `requireAdmin`.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { type AdminSession, requireAdmin } from '../../infra/admin-guard.js';
import type { UserRole } from '../../infra/session-store.js';
import { auditService } from '../audit/writer.js';

// ---------------------------------------------------------------------------
// Policy map (design §14.1)
// ---------------------------------------------------------------------------

/**
 * Role grants per policy, transcribed from design §14.1. The trailing
 * `mail_template.manage` row is the one §14.1-adjacent addition (Req 11.3
 * — see module header). `as const satisfies …` keeps the literal role
 * tuples narrow (so `PolicyName` and the per-policy role lists stay exact)
 * while still type-checking every value against `readonly UserRole[]`.
 */
const POLICY_ROLES = {
  // --- Job postings (§14.1) ---
  'job.create': ['Super_Admin', 'HR'],
  'job.publish': ['Super_Admin', 'HR'],
  'job.read': ['Super_Admin', 'HR', 'Department_Head'],
  // --- Applications (§14.1) ---
  'application.note.add': ['Super_Admin', 'HR', 'Department_Head'],
  'application.stage.change': ['Super_Admin', 'HR'],
  'application.export': ['Super_Admin', 'HR'],
  // --- User / audit / backup (§14.1) ---
  'user.invite': ['Super_Admin'],
  'audit.read': ['Super_Admin'],
  'backup.read': ['Super_Admin'],
  // --- Mail templates (Req 11.3; not in §14.1 code block) ---
  'mail_template.manage': ['Super_Admin', 'HR'],
  // --- Reporting (Req 13.1-13.3; §14.1 — HR + Super_Admin, not Department_Head) ---
  'report.read': ['Super_Admin', 'HR'],
  // --- Diagnostics (Req 20.4; §18.3 — Super_Admin only) ---
  'diagnostics.read': ['Super_Admin'],
} as const satisfies Record<string, readonly UserRole[]>;

/** The union of every named policy in {@link POLICIES}. */
export type PolicyName = keyof typeof POLICY_ROLES;

/**
 * The authoritative §14.1 policy map, frozen and indexed by
 * {@link PolicyName}. Each value is a `ReadonlySet<UserRole>` so callers
 * get O(1) membership checks without mutating the table. The outer object
 * is `Object.freeze`d; the inner `Set`s are exposed as `ReadonlySet` so
 * TypeScript forbids `add`/`delete` at compile time.
 */
export const POLICIES: Readonly<Record<PolicyName, ReadonlySet<UserRole>>> =
  Object.freeze(
    Object.fromEntries(
      (Object.entries(POLICY_ROLES) as Array<[PolicyName, readonly UserRole[]]>).map(
        ([name, roles]) => [name, new Set(roles)] as const,
      ),
    ) as Record<PolicyName, ReadonlySet<UserRole>>,
  );

// ---------------------------------------------------------------------------
// Predicate
// ---------------------------------------------------------------------------

/**
 * Is `role` permitted to exercise `policy`?
 *
 * Pure and side-effect free — the building block both the guard and the
 * view layer (e.g. "should I render this button?") share so the UI never
 * offers an action the guard would reject.
 *
 * `Applicant` is never in any §14.1 grant, so this returns `false` for
 * every policy when handed an Applicant role.
 */
export function can(role: UserRole, policy: PolicyName): boolean {
  return POLICIES[policy].has(role);
}

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

/** The 403 template rendered when a policy check fails (design §14.3). */
const FORBIDDEN_VIEW = 'admin/403.njk';

/**
 * A route guard produced by {@link requirePolicy}. Mirrors the
 * `requireAdmin` contract: resolves to the {@link AdminSession} on
 * success, or `null` after the guard has already written the response
 * (302 / 403). Callers MUST early-return when the result is `null`.
 */
export type PolicyGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<AdminSession | null>;

/**
 * Build a guard that admits only roles permitted for `policyName`
 * (design §14.1).
 *
 * Flow:
 *   1. Delegate to `requireAdmin(request, reply)` with NO `allowedRoles`
 *      so the session + Department_Head scope resolve first. An
 *      unauthenticated / non-internal request is handled inside
 *      `requireAdmin` (302 redirect) and surfaces here as `null`.
 *   2. If `requireAdmin` returned `null`, it already responded — pass the
 *      `null` straight through.
 *   3. If the resolved role is NOT permitted for `policyName`, render
 *      `views/admin/403.njk` with HTTP 403 and append an `access_denied`
 *      audit event (§14.3, Req 11.6). Return `null`.
 *   4. Otherwise return the `AdminSession` (with scope intact).
 *
 * The audit write is best-effort: a failure to record the denial MUST NOT
 * turn the clean 403 into a 500, so it is caught and logged. The 403 is
 * the security-relevant outcome; the audit row is the paper trail.
 */
export function requirePolicy(policyName: PolicyName): PolicyGuard {
  return async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (session === null) {
      // requireAdmin already wrote a 302 / 403 (unauthenticated or
      // Applicant cookie). No audit — this is not a policy denial.
      return null;
    }

    if (can(session.role, policyName)) {
      return session;
    }

    // Policy denial (§14.3). Record it, then render the 403 page.
    try {
      await auditService.write({
        actorUserId: session.userId,
        actorIp: request.ip,
        actionType: 'access_denied',
        targetEntity: 'policy',
        targetId: null,
        details: { policy: policyName, role: session.role },
      });
    } catch (err) {
      request.log.error(
        { err, userId: session.userId, policy: policyName },
        'requirePolicy: failed to write access_denied audit event',
      );
    }

    const html = request.server.view(FORBIDDEN_VIEW, {
      role: session.role,
      policy: policyName,
      cspNonce: request.cspNonce,
    });
    reply.code(403).type('text/html; charset=utf-8').send(html);
    return null;
  };
}
