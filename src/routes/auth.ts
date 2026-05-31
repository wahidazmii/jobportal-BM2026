/**
 * Authentication route plugin for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Tasks   : 9.2  — `GET/POST /:locale/register` and the matching form.
 *           9.3  — `GET /:locale/verify?token=...` and
 *                   `POST /:locale/verify/resend` (rate-limited).
 *           10.2 — `POST /:locale/logout` (destroy session + clear cookies).
 * Design  : §6 Auth, §8.1 (sequence: register → verify → login),
 *           §8.4 (session lifecycle), §8.6 (CSRF), §14.1.
 * Validates: Requirements 3.3, 3.4 (verify + resend), 3.5 (logout
 *            terminates the authenticated session), 14.1 (CAPTCHA on
 *            registration / resend), 14.2 (registration rate-limit).
 *
 * Scope of THIS file:
 *   - GET  /:locale/register         → render `views/public/register.njk`
 *   - POST /:locale/register         → validate body, verify hCaptcha,
 *                                      check rate limit, call `register()`
 *                                      service, render the generic success
 *                                      page on completion.
 *   - GET  /:locale/verify           → consume the token and render either
 *                                      `verify-success.njk` or
 *                                      `verify-invalid.njk`.
 *   - POST /:locale/verify/resend    → captcha + rate-limit (3 per IP per
 *                                      hour) then call `resendVerificationEmail`
 *                                      and render the generic
 *                                      `verify-resend-sent.njk` page.
 *   - POST /:locale/logout           → destroy the server-side session,
 *                                      clear `__Host-sid` and `csrf_token`
 *                                      cookies, redirect 302 to
 *                                      `/{locale}/`. Idempotent — calling
 *                                      it without a session cookie still
 *                                      issues the redirect (and clears
 *                                      any stale cookies the browser may
 *                                      still be holding).
 *
 * The login and password-reset endpoints listed in design §6 are
 * implemented by sibling tasks (10.1, 11.1 etc.); they plug into this
 * same Fastify plugin.
 *
 * Notes on the request lifecycle:
 *
 *   - The CSRF middleware (src/infra/csrf.ts) is wired at the application
 *     level and bypasses requests without a `__Host-sid` cookie, so the
 *     unauthenticated registration form does not need CSRF tokens. Once
 *     the user has a session (after login), CSRF kicks in automatically.
 *
 *   - The captcha token is read from either `captchaToken` or
 *     `h-captcha-response` (the field name the official hCaptcha widget
 *     posts). Both are mapped onto the schema's `captchaToken` field
 *     before zod validation.
 *
 *   - The rate-limit bucket key is `register:ip:<request.ip>`. We
 *     `checkRateLimit` BEFORE doing any work, return 429 with
 *     `Retry-After` when the bucket is full, and call `recordHit` ONLY
 *     after the service layer reports success. Failed validations,
 *     captcha rejections, and database errors do NOT consume a slot —
 *     this matches Req 14.2 ("5 successful submissions") rather than
 *     "5 attempts".
 *
 *   - On the success path the response is a generic "check your email"
 *     page that does not differentiate between a brand-new account and
 *     a duplicate-email submission (Req 3.2). We `recordHit` regardless
 *     because both branches return `ok: true` from the service layer
 *     and we MUST NOT leak which one happened — including via timing.
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';

import {
  REGISTER_BUCKET_PREFIX,
  REGISTER_LIMIT,
  REGISTER_WINDOW_SECONDS,
  VERIFY_RESEND_BUCKET_PREFIX,
  VERIFY_RESEND_LIMIT,
  VERIFY_RESEND_WINDOW_SECONDS,
  checkRateLimit,
  recordHit,
} from '../infra/rate-limit.js';
import { verifyCaptcha } from '../modules/auth/captcha.js';
import {
  REDIRECT_ADMIN,
  REDIRECT_APPLICANT_PREFIX,
  login,
  loginSchema,
} from '../modules/auth/login.js';
import { register } from '../modules/auth/register.js';
import {
  consumeVerificationToken,
  resendVerificationEmail,
} from '../modules/auth/verify.js';
import { CSRF_COOKIE_OPTIONS, setCsrfCookie } from '../infra/csrf.js';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  TOKEN_LENGTH,
  destroy as destroySession,
} from '../infra/session-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed locale values matched by the `:locale` URL segment. */
export const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['id', 'en']);

/** Field name posted by the official hCaptcha widget. */
const HCAPTCHA_BODY_FIELD = 'h-captcha-response';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocaleParams {
  locale: string;
}

/** Query string for `GET /:locale/verify?token=...`. */
interface VerifyQuery {
  token?: unknown;
}

/**
 * Form body for `POST /:locale/verify/resend`. Same captcha-token
 * conventions as the register form: accept either `captchaToken` or the
 * widget's `h-captcha-response`.
 */
interface ResendBody {
  email?: unknown;
  captchaToken?: unknown;
  [HCAPTCHA_BODY_FIELD]?: unknown;
}

/**
 * Raw shape we accept from the form before normalisation. Every field is
 * `unknown` because Fastify's `formbody` parses everything as strings (or
 * arrays of strings) — the route normalises and zod validates downstream.
 */
interface RegisterBody {
  email?: unknown;
  password?: unknown;
  consent?: unknown;
  captchaToken?: unknown;
  [HCAPTCHA_BODY_FIELD]?: unknown;
}

/**
 * Raw shape for `POST /:locale/login`. Mirrors `RegisterBody` but the
 * service-layer schema (`loginSchema`) only enforces email + password.
 * The `_csrf` field is read by the CSRF middleware, not here.
 */
interface LoginBody {
  email?: unknown;
  password?: unknown;
  _csrf?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an unknown value into a plain string. Used for form fields
 * that could be `string`, `string[]` (duplicate inputs), or absent. We
 * pick the FIRST string value so a malicious double-post cannot smuggle
 * an alternate value past the visible field.
 */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string') as string | undefined;
    return first;
  }
  return undefined;
}

/**
 * Coerce a checkbox value (`undefined` when unchecked, `'on'` when
 * checked, but also `'true'` / `'false'` from JS-driven submissions)
 * into a strict boolean for the zod schema.
 */
function coerceConsent(value: unknown): boolean {
  const s = asString(value);
  if (s === undefined) return false;
  const lowered = s.toLowerCase();
  return lowered === 'on' || lowered === 'true' || lowered === '1';
}

/**
 * Pull the captcha token out of the body, accepting both the schema's own
 * `captchaToken` field and the hCaptcha widget's `h-captcha-response`.
 * Empty / missing returns `''` so the schema reports a precise error.
 */
function readCaptchaToken(body: RegisterBody | undefined): string {
  if (!body) return '';
  const direct = asString(body.captchaToken);
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct.trim();
  }
  const widget = asString(body[HCAPTCHA_BODY_FIELD]);
  return typeof widget === 'string' ? widget.trim() : '';
}

/** Resolve the locale from `request.params`, falling back to `'id'`. */
function resolveLocale(request: FastifyRequest<{ Params: LocaleParams }>): string {
  const raw = request.params.locale;
  return SUPPORTED_LOCALES.has(raw) ? raw : 'id';
}

/**
 * Pack the client IP into a single-segment bucket key. We do not parse
 * IPv6 down to a /64 prefix here — that is a refinement for Phase 8;
 * for now `request.ip` is the canonical "one IP, one bucket" key.
 */
function bucketForIp(ip: string): string {
  // Cap the IP length defensively so an oversized value cannot push the
  // bucket past `MAX_BUCKET_LENGTH` (64 chars). IPv6 maxes at 39 chars,
  // so this only triggers on a misbehaving proxy.
  const safeIp = ip.slice(0, 50);
  return `${REGISTER_BUCKET_PREFIX}${safeIp}`;
}

/**
 * Bucket key for the verify-resend endpoint. Same shape as
 * `bucketForIp` but with the `verify-resend:ip:` prefix so the two
 * limiters do not share a counter.
 */
function bucketForVerifyResend(ip: string): string {
  const safeIp = ip.slice(0, 40);
  return `${VERIFY_RESEND_BUCKET_PREFIX}${safeIp}`;
}

/**
 * Format a number of seconds for the `Retry-After` header. The HTTP spec
 * accepts either a delta-seconds integer or an HTTP-date; we use the
 * integer form (simpler for clients to consume).
 */
function retryAfterHeader(seconds: number): string {
  return String(Math.max(1, Math.ceil(seconds)));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Render the register form (or the rate-limit page when the bucket is
 * already full so the user does not waste effort filling out the form).
 */
async function getRegister(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);

  // Pre-render rate-limit check: friendly UX, but the POST handler
  // re-checks so the GET is purely informational.
  const decision = await checkRateLimit(bucketForIp(request.ip), {
    max: REGISTER_LIMIT,
    windowSeconds: REGISTER_WINDOW_SECONDS,
  });

  if (!decision.allowed && decision.retryAfterSec !== undefined) {
    reply.header('Retry-After', retryAfterHeader(decision.retryAfterSec));
    const html = app.view('public/too-many-requests.njk', {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce,
    });
    return reply.code(429).type('text/html; charset=utf-8').send(html);
  }

  const html = app.view('public/register.njk', {
    locale,
    form: { email: '', consent: false },
    errors: {},
    generalError: null,
    hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * Handle a registration submission. Pipeline:
 *   1. Reject unknown locale → 404.
 *   2. Rate-limit pre-check → 429 (no captcha, no DB work).
 *   3. Captcha verification → re-render form with field error on failure.
 *   4. zod validation        → re-render form with field errors on failure.
 *   5. Service `register()`  → propagate non-domain errors as 500; on
 *                              success render the generic "check email"
 *                              page and `recordHit` the bucket.
 */
async function postRegister(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: RegisterBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);
  const bucket = bucketForIp(request.ip);

  // ── 1. Rate limit ────────────────────────────────────────────────
  const decision = await checkRateLimit(bucket, {
    max: REGISTER_LIMIT,
    windowSeconds: REGISTER_WINDOW_SECONDS,
  });

  if (!decision.allowed && decision.retryAfterSec !== undefined) {
    reply.header('Retry-After', retryAfterHeader(decision.retryAfterSec));
    const html = app.view('public/too-many-requests.njk', {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce,
    });
    return reply.code(429).type('text/html; charset=utf-8').send(html);
  }

  const body = request.body ?? {};
  const email = (asString(body.email) ?? '').trim();
  const password = asString(body.password) ?? '';
  const consent = coerceConsent(body.consent);
  const captchaToken = readCaptchaToken(body);

  // Helper to render the form with errors. Capturing it as a closure
  // keeps the field-error mapping in one place.
  const renderForm = (
    statusCode: number,
    errors: Record<string, string[]>,
    generalError: string | null = null,
  ): FastifyReply => {
    const html = app.view('public/register.njk', {
      locale,
      form: { email, consent },
      errors,
      generalError,
      hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
      cspNonce: request.cspNonce,
    });
    return reply.code(statusCode).type('text/html; charset=utf-8').send(html);
  };

  // ── 2. Captcha ───────────────────────────────────────────────────
  // `verifyCaptcha` short-circuits to `true` when `HCAPTCHA_SECRET` is
  // unset in non-production environments, so the dev/test flow keeps
  // working. In production a missing secret fails closed there. The
  // schema still requires a non-empty token, so the form's hidden
  // dev-mode fallback keeps zod happy in dev/test.
  const captchaOk = await verifyCaptcha(captchaToken, request.ip);
  if (!captchaOk) {
    app.log.info({ ip: request.ip }, 'auth.register: captcha verification failed');
    return renderForm(
      400,
      { captchaToken: ['Captcha verification failed. Please try again.'] },
    );
  }

  // ── 3. Service call (zod validation runs inside `register`) ──────
  try {
    await register(
      { email, password, consent, captchaToken: captchaToken || '' },
      { ipAddress: null },
    );
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors = err.flatten().fieldErrors;
      // zod's flatten typing widens to `Record<string, string[] | undefined>`;
      // strip undefined slots so the template can iterate plainly.
      const errors: Record<string, string[]> = {};
      for (const [key, msgs] of Object.entries(fieldErrors)) {
        if (msgs && msgs.length > 0) errors[key] = msgs;
      }
      return renderForm(400, errors);
    }
    app.log.error({ err }, 'auth.register: unexpected error');
    return renderForm(
      500,
      {},
      'We could not complete your registration. Please try again.',
    );
  }

  // ── 4. Success → record the slot and render the generic page ────
  // We swallow rate-limit recording errors so a transient MySQL hiccup
  // never breaks the user-visible success flow. The service layer's
  // own writes already committed in their own transaction by this point.
  try {
    await recordHit(bucket, { windowSeconds: REGISTER_WINDOW_SECONDS });
  } catch (err) {
    app.log.warn({ err }, 'auth.register: rate-limit recordHit failed');
  }

  const html = app.view('public/register-success.njk', {
    locale,
    email,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// Verify (task 9.3)
// ---------------------------------------------------------------------------

/**
 * Render the verification result page. Returns either the success view
 * (account activated) or the generic "invalid or expired" view (Req
 * 3.4). The status code is 200 in both branches: a 4xx would let an
 * attacker tell "token shape was wrong" from "token was never issued".
 */
async function getVerify(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Querystring: VerifyQuery }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);

  const rawToken = asString(request.query?.token);

  let outcome: Awaited<ReturnType<typeof consumeVerificationToken>>;
  try {
    outcome = await consumeVerificationToken(rawToken);
  } catch (err) {
    app.log.error({ err }, 'auth.verify: unexpected error consuming token');
    // Fall through to the generic invalid page so we never leak
    // database details to the user. The exception is recorded above.
    outcome = { status: 'invalid' };
  }

  if (outcome.status === 'verified') {
    const html = app.view('public/verify-success.njk', {
      locale,
      cspNonce: request.cspNonce,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }

  const html = app.view('public/verify-invalid.njk', {
    locale,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * Handle a verification-resend submission. Pipeline:
 *   1. Reject unknown locale → 404.
 *   2. Rate-limit pre-check (3 per IP per hour) → 429.
 *   3. Captcha verification → 400 with field error on failure.
 *   4. Service `resendVerificationEmail()` → propagate non-domain
 *      errors as 500. On success render the generic "if a pending
 *      account exists, we resent the link" page.
 *   5. Always `recordHit` after the service returns ok, so the cap
 *      cannot be circumvented by submitting random emails (which the
 *      service would silently no-op).
 */
async function postVerifyResend(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: ResendBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);
  const bucket = bucketForVerifyResend(request.ip);

  // ── 1. Rate limit ────────────────────────────────────────────────
  const decision = await checkRateLimit(bucket, {
    max: VERIFY_RESEND_LIMIT,
    windowSeconds: VERIFY_RESEND_WINDOW_SECONDS,
  });

  if (!decision.allowed && decision.retryAfterSec !== undefined) {
    reply.header('Retry-After', retryAfterHeader(decision.retryAfterSec));
    const html = app.view('public/too-many-requests.njk', {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce,
    });
    return reply.code(429).type('text/html; charset=utf-8').send(html);
  }

  const body = request.body ?? {};
  const email = (asString(body.email) ?? '').trim();
  const captchaToken = readCaptchaToken(body);

  // Helper to render the resend form with errors (used by validation +
  // captcha branches). Captures the closure so error mapping stays in
  // one place.
  const renderForm = (
    statusCode: number,
    errors: Record<string, string[]>,
    generalError: string | null = null,
  ): FastifyReply => {
    const html = app.view('public/verify-resend.njk', {
      locale,
      form: { email },
      errors,
      generalError,
      hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
      cspNonce: request.cspNonce,
    });
    return reply.code(statusCode).type('text/html; charset=utf-8').send(html);
  };

  // ── 2. Captcha ───────────────────────────────────────────────────
  const captchaOk = await verifyCaptcha(captchaToken, request.ip);
  if (!captchaOk) {
    app.log.info(
      { ip: request.ip },
      'auth.verify-resend: captcha verification failed',
    );
    return renderForm(400, {
      captchaToken: ['Captcha verification failed. Please try again.'],
    });
  }

  // ── 3. Service call ──────────────────────────────────────────────
  try {
    await resendVerificationEmail(
      { email, captchaToken: captchaToken || '' },
      { ipAddress: request.ip ?? null },
    );
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors = err.flatten().fieldErrors;
      const errors: Record<string, string[]> = {};
      for (const [key, msgs] of Object.entries(fieldErrors)) {
        if (msgs && msgs.length > 0) errors[key] = msgs;
      }
      return renderForm(400, errors);
    }
    app.log.error({ err }, 'auth.verify-resend: unexpected error');
    return renderForm(
      500,
      {},
      'We could not process your request. Please try again.',
    );
  }

  // ── 4. Success → record the slot and render the generic page ────
  // Record AFTER the service so a transient DB error in the lookup
  // stage doesn't burn a slot, but BEFORE rendering so a render-time
  // failure still consumes the cap. As with register, we swallow
  // recordHit failures so a transient MySQL hiccup never breaks the
  // user-visible success flow.
  try {
    await recordHit(bucket, { windowSeconds: VERIFY_RESEND_WINDOW_SECONDS });
  } catch (err) {
    app.log.warn({ err }, 'auth.verify-resend: rate-limit recordHit failed');
  }

  const html = app.view('public/verify-resend-sent.njk', {
    locale,
    email,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * Render the resend form (or the rate-limit page when the bucket is
 * already full so the user does not waste effort filling out the form).
 */
async function getVerifyResend(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);

  const decision = await checkRateLimit(bucketForVerifyResend(request.ip), {
    max: VERIFY_RESEND_LIMIT,
    windowSeconds: VERIFY_RESEND_WINDOW_SECONDS,
  });

  if (!decision.allowed && decision.retryAfterSec !== undefined) {
    reply.header('Retry-After', retryAfterHeader(decision.retryAfterSec));
    const html = app.view('public/too-many-requests.njk', {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce,
    });
    return reply.code(429).type('text/html; charset=utf-8').send(html);
  }

  const html = app.view('public/verify-resend.njk', {
    locale,
    form: { email: '' },
    errors: {},
    generalError: null,
    hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// Logout (task 10.2)
// ---------------------------------------------------------------------------

/**
 * Handle a logout submission.
 *
 * Behaviour (Design §6 Auth, §8.4 / Req 3.5):
 *   - The locale segment is validated against the {id, en} allowlist;
 *     an unknown locale 404s before any DB work, just like the other
 *     auth routes.
 *   - The CSRF middleware (`src/infra/csrf.ts`) is wired at the
 *     application level: any authenticated POST without a matching
 *     `X-CSRF-Token` / `_csrf` token is rejected with 403 BEFORE this
 *     handler runs. Logout therefore inherits CSRF protection for
 *     free — the form just has to include the token like every other
 *     state-changing form.
 *   - When the request carries a well-formed `__Host-sid` cookie we
 *     `destroy()` the row so the session id is unusable on the next
 *     request even if the browser ignores our `Set-Cookie` clear.
 *   - We always issue cookie-clearing headers (`Max-Age=0` /
 *     `Expires=epoch` via `reply.clearCookie`) for both
 *     `__Host-sid` and `csrf_token`, mirroring the same path / secure
 *     / sameSite attributes used at issuance so the browser actually
 *     drops the cookies (cookie deletion requires the Path/Secure
 *     attributes to match).
 *   - The response is a 302 redirect to `/{locale}/`. This is
 *     idempotent: a logout request without any cookies still returns
 *     302 and clears any stale cookies the browser might still hold.
 *
 * Implementation note: `destroySession` is itself idempotent — calling
 * it with a malformed sid is a no-op — but we still validate the cookie
 * length here to avoid a needless round-trip to MySQL on garbage input.
 */
async function postLogout(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);

  const sid = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid === 'string' && sid.length === TOKEN_LENGTH) {
    try {
      await destroySession(sid);
    } catch (err) {
      // A transient DB hiccup must not strand the user with a
      // half-logged-out browser: we still clear the cookies and
      // redirect. The cron `session-gc` will eventually GC the row
      // even if this delete failed.
      app.log.warn(
        { err, sidPrefix: sid.slice(0, 8) },
        'auth.logout: destroy session failed, clearing cookies anyway',
      );
    }
  }

  // Clear both cookies with the SAME attributes that issued them.
  // Cookie deletion is only effective when the browser sees a matching
  // (name, path, domain) tuple, so we reuse `SESSION_COOKIE_OPTIONS` /
  // `CSRF_COOKIE_OPTIONS` rather than inventing a new shape here.
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE_OPTIONS);

  return reply.code(302).header('location', `/${locale}/`).send();
}

// ---------------------------------------------------------------------------
// Login (task 10.1)
// ---------------------------------------------------------------------------

/**
 * Pack the client IP into a 16-byte buffer suitable for the
 * `login_attempts.ip_address VARBINARY(16)` column. We do not parse the
 * IP — that requires per-IPv4/IPv6 logic that the service layer does
 * not need — instead we hash it deterministically into 16 bytes via
 * `Buffer.from(ip, 'utf8')` truncated/padded to length 16. The column
 * is opaque storage; the only consumer is the lockout aggregate which
 * groups by `email`, not IP.
 */
function packIpForLoginAttempt(ip: string | undefined | null): Buffer {
  const safe = typeof ip === 'string' ? ip.slice(0, 16) : '';
  const buf = Buffer.alloc(16);
  buf.write(safe, 0, 'utf8');
  return buf;
}

/**
 * Render the login form. Always 200 — the rate-limit / lockout decision
 * happens on POST. We deliberately do NOT pre-check the email-keyed
 * lockout on GET because that would require knowing the email, which
 * the form does not yet have.
 */
async function getLogin(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);

  const html = app.view('public/login.njk', {
    locale,
    form: { email: '' },
    errors: {},
    generalError: null,
    retryAfterSec: null,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * Handle a login submission. Pipeline:
 *   1. Reject unknown locale → 404.
 *   2. Call the `login()` service. The service does:
 *        - lockout pre-check (Req 3.7)
 *        - bcrypt compare with timing-equaliser dummy hash (Req 3.6)
 *        - `login_attempts` INSERT (success or failure row)
 *        - on success, mint a session row via the session-store.
 *      The service returns a discriminated union; we map each arm to
 *      a render / redirect.
 *   3. On `success`: issue the `__Host-sid` and `csrf_token` cookies
 *      using the same attribute set the rest of the auth flow uses,
 *      then 302 to `/{locale}/me` (Applicant) or `/admin` (internal).
 *   4. On `locked`: render the login form with the generic lockout
 *      copy + `Retry-After` header.
 *   5. On `invalid_credentials`: render the login form with the same
 *      generic "invalid email or password" message regardless of
 *      whether the email existed (Req 3.6 — no leak).
 *   6. On `ZodError`: re-render with field errors. The schema is
 *      permissive (only requires non-empty values + length caps), so
 *      this branch fires only for missing fields or oversized inputs.
 */
async function postLogin(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: LoginBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const locale = resolveLocale(request);

  const body = request.body ?? {};
  const email = (asString(body.email) ?? '').trim();
  const password = asString(body.password) ?? '';

  // Helper to render the form with errors / banner. Captures the
  // closure so error mapping stays in one place.
  const renderForm = (
    statusCode: number,
    errors: Record<string, string[]>,
    generalError: string | null = null,
    retryAfterSec: number | null = null,
  ): FastifyReply => {
    if (retryAfterSec !== null) {
      reply.header('Retry-After', retryAfterHeader(retryAfterSec));
    }
    const html = app.view('public/login.njk', {
      locale,
      form: { email },
      errors,
      generalError,
      retryAfterSec,
      cspNonce: request.cspNonce,
    });
    return reply.code(statusCode).type('text/html; charset=utf-8').send(html);
  };

  // Generic error string. Localised on the page; the service layer
  // is intentionally English-only because the message is also used
  // by JSON API consumers in later phases.
  const GENERIC_INVALID =
    locale === 'id'
      ? 'Email atau kata sandi salah.'
      : 'Invalid email or password.';
  const GENERIC_LOCKED =
    locale === 'id'
      ? 'Terlalu banyak percobaan gagal. Coba lagi nanti.'
      : 'Too many failed attempts. Please try again later.';

  // Parse with the loginSchema BEFORE calling the service so we can
  // surface zod errors as field messages (the service throws ZodError
  // on bad input, but parsing here keeps the error-handling branch
  // explicit instead of buried in a catch).
  let parsed;
  try {
    parsed = loginSchema.parse({ email, password });
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors = err.flatten().fieldErrors;
      const errors: Record<string, string[]> = {};
      for (const [key, msgs] of Object.entries(fieldErrors)) {
        if (msgs && msgs.length > 0) errors[key] = msgs;
      }
      return renderForm(400, errors);
    }
    throw err;
  }

  // ── Service call ─────────────────────────────────────────────────
  const ipAddress = packIpForLoginAttempt(request.ip);
  const userAgent = (() => {
    const raw = request.headers['user-agent'];
    if (typeof raw !== 'string') return null;
    return raw.slice(0, 255);
  })();

  let outcome;
  try {
    outcome = await login(parsed, { ipAddress, userAgent });
  } catch (err) {
    app.log.error({ err }, 'auth.login: unexpected error');
    return renderForm(500, {}, GENERIC_INVALID);
  }

  if (outcome.status === 'locked') {
    return renderForm(429, {}, GENERIC_LOCKED, outcome.retryAfterSeconds);
  }

  if (outcome.status === 'invalid_credentials') {
    return renderForm(401, {}, GENERIC_INVALID);
  }

  // ── Success ──────────────────────────────────────────────────────
  // Issue both cookies with the SAME attributes the rest of the auth
  // flow uses so the `__Host-` prefix constraints are satisfied (and
  // the logout / auth-guard helpers can clear them later with a
  // matching attribute set).
  reply.setCookie(
    SESSION_COOKIE_NAME,
    outcome.session.sid,
    SESSION_COOKIE_OPTIONS,
  );
  setCsrfCookie(reply, outcome.session.csrfToken);

  // Redirect target: Applicant → `/{locale}/me`, internal → `/admin`.
  // The service layer returns a path-only target (`/me` or `/admin`);
  // we prefix the locale only for the Applicant branch because the
  // admin console is locale-agnostic in Design §6 Admin.
  const target =
    outcome.redirectTo === REDIRECT_APPLICANT_PREFIX
      ? `/${locale}${REDIRECT_APPLICANT_PREFIX}`
      : REDIRECT_ADMIN;

  return reply.code(302).header('location', target).send();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Fastify plugin that mounts the auth routes implemented so far.
 *
 * Register from `src/server.ts`:
 *
 *   ```ts
 *   import { authRoutes } from './routes/auth.js';
 *   await app.register(authRoutes);
 *   ```
 *
 * The plugin does not declare a prefix — the locale lives in the URL as
 * `:locale` so each route owns its own path. This keeps the design's
 * `GET /:locale/register` mapping (§6 Auth) readable from the route file.
 */
export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: LocaleParams }>('/:locale/register', (request, reply) =>
    getRegister(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: RegisterBody }>(
    '/:locale/register',
    (request, reply) => postRegister(app, request, reply),
  );

  // Email verification (task 9.3) ----------------------------------------
  app.get<{ Params: LocaleParams; Querystring: VerifyQuery }>(
    '/:locale/verify',
    (request, reply) => getVerify(app, request, reply),
  );

  app.get<{ Params: LocaleParams }>(
    '/:locale/verify/resend',
    (request, reply) => getVerifyResend(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: ResendBody }>(
    '/:locale/verify/resend',
    (request, reply) => postVerifyResend(app, request, reply),
  );

  // Login (task 10.1) ----------------------------------------------------
  app.get<{ Params: LocaleParams }>('/:locale/login', (request, reply) =>
    getLogin(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: LoginBody }>(
    '/:locale/login',
    (request, reply) => postLogin(app, request, reply),
  );

  // Logout (task 10.2) ---------------------------------------------------
  // The CSRF middleware enforces token check on POST for authenticated
  // requests, so logout is automatically CSRF-protected.
  app.post<{ Params: LocaleParams }>('/:locale/logout', (request, reply) =>
    postLogout(app, request, reply),
  );
};

export default authRoutes;
