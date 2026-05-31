/**
 * Consent guard middleware for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 46.1
 * Design  : §6 Applicant_Area (consent flow)
 * Validates: Requirements 16.6
 *
 * Public surface:
 *   - `requireConsent(request, reply)` — Fastify preHandler hook that
 *     checks whether the authenticated Applicant has accepted the
 *     current privacy policy version. If not, redirects to
 *     `/{locale}/me/consent`. For non-Applicant sessions (or when no
 *     session is present) the guard is a no-op — it only enforces
 *     consent for Applicant-role users.
 *
 * Design notes:
 *   - This guard is intentionally lightweight: it reads the session
 *     cookie directly (same approach as `auth-guard.ts`) and only
 *     performs the DB lookup when the session role is `'Applicant'`.
 *     Internal users (HR, Super_Admin, Department_Head) are never
 *     redirected to the consent page.
 *   - The guard does NOT call `requireApplicant` — it is designed to
 *     run AFTER `requireApplicant` has already validated the session.
 *     Routes that need both guards should call `requireApplicant` first
 *     and then `requireConsent` (or wire `requireConsent` as a
 *     preHandler on the route).
 *   - The redirect target uses `request.params.locale` when available,
 *     falling back to `'id'` so the user lands on the correct-language
 *     consent page.
 *   - The guard short-circuits by calling `reply.redirect()` and
 *     returning. Callers MUST early-return when the reply has been sent
 *     (check `reply.sent`).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  SESSION_COOKIE_NAME,
  TOKEN_LENGTH,
  read as readSession,
} from './session-store.js';
import {
  hasAcceptedCurrentVersion,
} from '../modules/applicant/consent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LocaleParams {
  readonly locale?: unknown;
}

/** Supported locale segments — mirrors the set in `auth-guard.ts`. */
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['id', 'en']);

/**
 * Resolve the locale from `request.params`, falling back to `'id'`.
 * Identical logic to `resolveRequestLocale` in `auth-guard.ts` but
 * kept local to avoid a circular dependency between infra modules.
 */
function resolveLocale(request: FastifyRequest): string {
  const params = (request.params ?? {}) as LocaleParams;
  const raw = params.locale;
  if (typeof raw === 'string' && SUPPORTED_LOCALES.has(raw)) {
    return raw;
  }
  return 'id';
}

// ---------------------------------------------------------------------------
// Public guard
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler hook — enforce privacy policy consent for Applicants.
 *
 * Behaviour:
 *   - If no `__Host-sid` cookie is present, or the session cannot be
 *     resolved, the guard is a no-op (the auth guard will handle it).
 *   - If the session role is NOT `'Applicant'`, the guard is a no-op
 *     (internal users are not subject to the consent prompt).
 *   - If the session role IS `'Applicant'` and the applicant has NOT
 *     accepted `CURRENT_POLICY_VERSION`, the guard redirects to
 *     `/{locale}/me/consent` with HTTP 302 and returns.
 *   - Otherwise (consent already recorded) the guard is a no-op and
 *     the request continues to the route handler.
 *
 * Callers MUST check `reply.sent` after calling this function and
 * early-return if the reply has already been sent.
 */
export async function requireConsent(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sid = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid !== 'string' || sid.length !== TOKEN_LENGTH) {
    // No session cookie — auth guard will handle this.
    return;
  }

  let session;
  try {
    session = await readSession(sid);
  } catch {
    // Transient DB error — let the auth guard deal with it.
    return;
  }

  if (session === null || session.role !== 'Applicant') {
    // No valid session or not an Applicant — guard is a no-op.
    return;
  }

  let accepted: boolean;
  try {
    accepted = await hasAcceptedCurrentVersion(session.userId);
  } catch (err) {
    // Fail open: if the consent check itself errors, let the request
    // through rather than blocking the user. The error will surface
    // in the server logs.
    request.log.warn(
      { err, userId: session.userId },
      'consent-guard: consent check failed, allowing request through',
    );
    return;
  }

  if (!accepted) {
    const locale = resolveLocale(request);
    reply.code(302).header('location', `/${locale}/me/consent`).send();
  }
}
