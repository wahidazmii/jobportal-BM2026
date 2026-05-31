/**
 * Password-reset HTTP routes for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 11.1 (request reset endpoint),
 *           tasks.md task 11.2 (reset confirm endpoint)
 * Design  : §6 Auth (route table), §8.2 (sequence)
 * Validates: Requirements 3.8, 3.9, 3.10
 *
 * Routes registered:
 *   - `POST /:locale/password/reset`            — accept the form body,
 *     verify the hCaptcha token, and call `requestPasswordReset()`.
 *     Always responds with the SAME generic confirmation regardless of
 *     whether an account for the submitted email exists (Req 3.9 — no
 *     leak).
 *   - `GET  /:locale/password/reset/:token`     — render the new-password
 *     form. Structurally invalid tokens render the generic "invalid /
 *     expired" page so the URL alone cannot be used to enumerate
 *     existing tokens.
 *   - `POST /:locale/password/reset/:token`     — validate the new
 *     password, call `confirmPasswordReset()`, render the success page on
 *     `{ ok: true }` and the same generic invalid-link page on
 *     `{ ok: false, reason: 'invalid_token' }` (Req 3.8). Updates the
 *     password and revokes every session for the user (Req 3.10).
 *
 * Captcha:
 *   - `verifyCaptcha()` from `modules/auth/captcha.ts` handles the
 *     hCaptcha siteverify call. The dev/test bypass (`HCAPTCHA_SECRET`
 *     unset and `NODE_ENV !== 'production'`) keeps the unit-test suite
 *     hermetic.
 *   - When the captcha check fails we still respond with a 400 — the
 *     "no leak" guarantee covers email-existence enumeration, not
 *     captcha bypass. Returning 200 on bad captcha would let an attacker
 *     skip the human-check entirely.
 *   - The CONFIRM endpoint (`/:locale/password/reset/:token`) is
 *     authenticated by token possession alone — it has no captcha and
 *     no CSRF token. The CSRF middleware (Req 15.2) explicitly bypasses
 *     unauthenticated requests, and an attacker who can reach the
 *     confirm page with a valid token has already compromised the
 *     user's mailbox; piling on a second factor at this point provides
 *     no incremental defence and would only break the form for genuine
 *     users.
 *
 * Locale parameter:
 *   - The `:locale` segment is captured but currently unused beyond
 *     validation. Mail rendering (task 36.1) will receive the locale to
 *     pick the right `mail_templates` row; we attach it to the enqueue
 *     context once that wiring lands.
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z, ZodError } from 'zod';

import { verifyCaptcha } from '../modules/auth/captcha.js';
import {
  confirmPasswordReset,
  isStructurallyValidResetToken,
  requestPasswordReset,
  requestResetSchema,
} from '../modules/auth/password-reset.js';

// ---------------------------------------------------------------------------
// Generic response shape (Req 3.9 — no leak)
// ---------------------------------------------------------------------------

/**
 * Body returned to the client regardless of branch (email exists or not,
 * even on duplicate / race conditions). Frozen so accidental mutation
 * can't introduce a spec violation.
 */
const GENERIC_RESET_RESPONSE = Object.freeze({
  ok: true,
  message:
    'If an account exists for that email, a password reset link has been sent. ' +
    'Please check your inbox and spam folder.',
});

/** Allowed locale segments — must mirror the i18n default in Design §13. */
const LOCALE_PARAM_SCHEMA = z.object({
  locale: z.enum(['id', 'en']),
});

/**
 * URL-param schema for the confirm endpoints (`/:locale/password/reset/:token`).
 * The token is validated structurally (43 base64url chars). A
 * structurally-invalid token resolves to a 200 OK rendering the
 * generic invalid-link page rather than a 404 — the URL is technically
 * well-formed, just bound to a non-existent token.
 */
const CONFIRM_PARAM_SCHEMA = z.object({
  locale: z.enum(['id', 'en']),
  token: z.string(),
});

/**
 * Body schema for `POST /:locale/password/reset/:token`. The token is
 * sourced from the URL parameter rather than the body, but we validate
 * the body's `newPassword` so we can render zod field errors before
 * calling the service. The full validation (token + newPassword) is
 * re-run by `confirmPasswordReset()` itself.
 */
const CONFIRM_BODY_SCHEMA = z.object({
  newPassword: z.string({ required_error: 'Password is required' }),
});

/**
 * Body type for the confirm POST endpoint. Accepts arbitrary string
 * fields so Fastify's form-body parser doesn't reject unrelated extra
 * inputs (e.g. CSRF placeholders); only `newPassword` is read.
 */
interface ConfirmBody {
  newPassword?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Confirm endpoint helpers (task 11.2)
// ---------------------------------------------------------------------------

interface ConfirmParams {
  locale: string;
  token: string;
}

/**
 * Render the generic invalid / expired link page. Used by both the GET
 * handler (when the URL token is structurally malformed) and the POST
 * handler (when the service reports `invalid_token`). Rendering the
 * SAME page from both branches preserves Req 3.8's no-distinguish
 * guarantee — an attacker cannot tell missing-token from expired-token
 * from already-consumed-token.
 */
function renderInvalidTokenPage(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  locale: string,
): FastifyReply {
  const html = app.view('public/password-reset-invalid.njk', {
    locale,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/** Render the new-password form for a given token. */
function renderConfirmForm(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  locale: string,
  token: string,
  errors: Record<string, string[]> = {},
  generalError: string | null = null,
  statusCode = 200,
): FastifyReply {
  const html = app.view('public/password-reset-confirm.njk', {
    locale,
    token,
    errors,
    generalError,
    cspNonce: request.cspNonce,
  });
  return reply.code(statusCode).type('text/html; charset=utf-8').send(html);
}

/**
 * Coerce form-body values to a plain string. Mirrors the helper in
 * `routes/auth.ts` — duplicated here so this plugin stays
 * self-contained.
 */
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string') as
      | string
      | undefined;
    return typeof first === 'string' ? first : '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Fastify plugin registering the password-reset request endpoint. Wired
 * into the main app by `src/server.ts` (or task 11.2 will register the
 * confirm handlers in the same plugin).
 */
const passwordRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/:locale/password/reset', async (request, reply) => {
    // 1) Validate the locale segment — keeps the URL space tight and
    //    prevents arbitrary path traversal via `:locale`.
    const localeParse = LOCALE_PARAM_SCHEMA.safeParse(request.params);
    if (!localeParse.success) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // 2) Validate the form body. We catch ZodError ourselves so we can
    //    surface a helpful message for genuinely malformed input (no
    //    captcha field, no email, …) without leaking which email was
    //    submitted.
    const bodyResult = requestResetSchema.safeParse(request.body);
    if (!bodyResult.success) {
      const flat = bodyResult.error.flatten();
      return reply.code(400).send({
        ok: false,
        error: 'invalid_input',
        fieldErrors: flat.fieldErrors,
      });
    }

    // 3) Verify the captcha. Failing here returns 400, not the generic
    //    success message — the no-leak guarantee scopes to email
    //    enumeration, not captcha bypass.
    const captchaOk = await verifyCaptcha(
      bodyResult.data.captchaToken,
      request.ip,
    );
    if (!captchaOk) {
      return reply.code(400).send({
        ok: false,
        error: 'captcha_failed',
      });
    }

    // 4) Run the service. Both branches (token issued / silently no-op)
    //    resolve to the same generic response shape so the HTTP response
    //    is byte-identical to an external observer.
    try {
      await requestPasswordReset(bodyResult.data, {
        ipAddress: request.ip ?? null,
      });
    } catch (err) {
      // ZodError can only fire here if the body somehow bypassed the
      // safeParse above (it can't), but fall through to a generic 500
      // for any other failure to avoid leaking implementation details.
      if (err instanceof ZodError) {
        return reply.code(400).send({ ok: false, error: 'invalid_input' });
      }
      app.log.error({ err }, 'password.reset: unexpected service failure');
      return reply.code(500).send({ ok: false, error: 'internal_error' });
    }

    return reply.code(200).send(GENERIC_RESET_RESPONSE);
  });

  // -------------------------------------------------------------------
  // Confirm endpoints (task 11.2): /:locale/password/reset/:token
  // -------------------------------------------------------------------

  app.get<{ Params: ConfirmParams }>(
    '/:locale/password/reset/:token',
    async (request, reply) => {
      const params = CONFIRM_PARAM_SCHEMA.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const { locale, token } = params.data;

      // Structural check: malformed tokens render the generic invalid
      // page without a database round-trip. The authoritative validity
      // check (unused, unexpired, FK-resolvable) happens at POST time.
      if (!isStructurallyValidResetToken(token)) {
        return renderInvalidTokenPage(app, request, reply, locale);
      }

      return renderConfirmForm(app, request, reply, locale, token);
    },
  );

  app.post<{ Params: ConfirmParams; Body: ConfirmBody }>(
    '/:locale/password/reset/:token',
    async (request, reply) => {
      const params = CONFIRM_PARAM_SCHEMA.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const { locale, token } = params.data;

      // Same structural pre-check as GET: a malformed token cannot
      // possibly succeed. Render the generic invalid-link page rather
      // than re-rendering the form so the user has a clear next step.
      if (!isStructurallyValidResetToken(token)) {
        return renderInvalidTokenPage(app, request, reply, locale);
      }

      // Pull the new password out of the form body. Empty bodies are
      // surfaced as a "Password is required" field error rather than a
      // 400, so the user sees the form again with guidance.
      const bodyResult = CONFIRM_BODY_SCHEMA.safeParse(request.body ?? {});
      const newPassword = bodyResult.success
        ? bodyResult.data.newPassword
        : asString((request.body as ConfirmBody | null)?.newPassword);

      try {
        const outcome = await confirmPasswordReset({
          token,
          newPassword,
        });

        if (outcome.ok) {
          // Render the success page. The service has already revoked
          // every session for the user; the user must log in again to
          // obtain a fresh sid + csrf token.
          const html = app.view('public/password-reset-success.njk', {
            locale,
            cspNonce: request.cspNonce,
          });
          return reply
            .code(200)
            .type('text/html; charset=utf-8')
            .send(html);
        }

        // Service reported `invalid_token`. Render the same page the
        // GET handler shows for malformed URLs (Req 3.8 — no distinguish).
        return renderInvalidTokenPage(app, request, reply, locale);
      } catch (err) {
        if (err instanceof ZodError) {
          // Surface field-level errors back into the form so the user
          // can correct e.g. a too-short password without resubmitting
          // the request from scratch.
          const flat = err.flatten().fieldErrors;
          const errors: Record<string, string[]> = {};
          for (const [key, msgs] of Object.entries(flat)) {
            if (msgs && msgs.length > 0) errors[key] = msgs;
          }
          // If the only failure is a structurally-invalid token (which
          // we should have caught above) treat it as the invalid-link
          // page rather than re-rendering the form for a token the
          // user cannot fix.
          if (errors.token && !errors.newPassword) {
            return renderInvalidTokenPage(app, request, reply, locale);
          }
          return renderConfirmForm(
            app,
            request,
            reply,
            locale,
            token,
            errors,
            null,
            400,
          );
        }
        app.log.error(
          { err },
          'password.reset.confirm: unexpected service failure',
        );
        return renderConfirmForm(
          app,
          request,
          reply,
          locale,
          token,
          {},
          'We could not update your password. Please try again.',
          500,
        );
      }
    },
  );
};

export default passwordRoutes;
export { GENERIC_RESET_RESPONSE };
