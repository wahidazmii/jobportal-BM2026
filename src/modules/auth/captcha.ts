/**
 * hCaptcha verification helper for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 11.1 (and forthcoming 9.2 / 10.1 / 26.1)
 * Design  : §6 Auth table, §19 Tech Choices (captcha = hCaptcha)
 * Validates: Requirements 14.1 (CAPTCHA on registration / password-reset /
 *            unauthenticated contact form)
 *
 * Public surface:
 *   - `verifyCaptcha(token, remoteIp?)` — returns `true` when the token is
 *     accepted by hCaptcha's siteverify endpoint; `false` otherwise.
 *
 * Configuration:
 *   - `HCAPTCHA_SECRET`  — server-side secret. Required in production.
 *   - `HCAPTCHA_VERIFY_URL` — override target URL for tests / staging.
 *     Defaults to the public hCaptcha endpoint.
 *
 * Behaviour:
 *   - When `HCAPTCHA_SECRET` is **unset/blank** AND `NODE_ENV !== 'production'`
 *     the verifier short-circuits to `true`. This is the "dev/test bypass"
 *     so contributors can run the dev server and the unit-test suite without
 *     wiring an hCaptcha account.
 *   - In production the missing secret fails closed (returns `false`) and
 *     a structured warning is emitted; we never want a misconfigured
 *     deployment to silently disable a captcha-protected endpoint.
 *   - Network/parse failures fail closed for the same reason — a bad
 *     response from hCaptcha (5xx, malformed JSON, timeout) is treated as
 *     a verification failure.
 *
 * The function uses Node 22's global `fetch`. No external dependency is
 * pulled in; tests can stub `globalThis.fetch` with `vi.spyOn(global, 'fetch')`.
 */

import { logger } from '../../infra/logger.js';

/**
 * Default hCaptcha siteverify endpoint. The env override
 * (`HCAPTCHA_VERIFY_URL`) lets integration tests aim at a local fake.
 */
const DEFAULT_HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';

/** Network timeout for the siteverify call. hCaptcha typically responds <1s. */
const VERIFY_TIMEOUT_MS = 5_000;

/**
 * Shape of the hCaptcha siteverify response we care about. Other fields
 * (`challenge_ts`, `hostname`, `error-codes`, `score`, …) are ignored.
 */
interface HCaptchaResponse {
  readonly success?: boolean;
  readonly 'error-codes'?: readonly string[];
}

/**
 * Verify an hCaptcha response token.
 *
 * @param token    The `h-captcha-response` token submitted with the form.
 *                 Must be a non-empty string; any falsy value resolves to
 *                 `false` without making a network call.
 * @param remoteIp Optional client IP, forwarded to hCaptcha as `remoteip`
 *                 to improve scoring. Pass `request.ip` from Fastify.
 * @returns `true` when the token is valid (or the dev/test bypass triggers),
 *          `false` otherwise.
 */
export async function verifyCaptcha(
  token: string,
  remoteIp?: string | null,
): Promise<boolean> {
  if (typeof token !== 'string' || token.trim() === '') {
    return false;
  }

  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret || secret.trim() === '') {
    if ((process.env.NODE_ENV ?? 'development') === 'production') {
      logger.warn(
        'auth.captcha: HCAPTCHA_SECRET is unset in production — failing closed',
      );
      return false;
    }
    // Dev/test bypass: skip the network call so the form is usable
    // without an hCaptcha account configured locally.
    return true;
  }

  const verifyUrl =
    process.env.HCAPTCHA_VERIFY_URL ?? DEFAULT_HCAPTCHA_VERIFY_URL;

  const params = new URLSearchParams();
  params.set('secret', secret);
  params.set('response', token);
  if (remoteIp && remoteIp.trim() !== '') {
    params.set('remoteip', remoteIp);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const resp = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        'auth.captcha: hCaptcha siteverify returned non-2xx',
      );
      return false;
    }
    const data = (await resp.json()) as HCaptchaResponse;
    if (data.success === true) {
      return true;
    }
    logger.info(
      { error_codes: data['error-codes'] ?? [] },
      'auth.captcha: hCaptcha rejected the token',
    );
    return false;
  } catch (err) {
    logger.warn({ err }, 'auth.captcha: hCaptcha verify request failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
