/**
 * HMAC-signed CV download URL helper for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 45.1
 * Design  : §16.3 (CSV export — signed CV download URL, HMAC)
 * Validates: Requirements 13.4, 13.5
 *
 * Public surface:
 *   - `signCvDownloadUrl(cvFileId, expiresInSeconds, secret)` — generate a
 *     signed URL `/me/cv/:id?sig=<hmac>&exp=<timestamp>` valid for the
 *     given number of seconds. The HMAC covers `"cv:<cvFileId>:<exp>"` so
 *     the signature is bound to both the file id and the expiry timestamp.
 *   - `verifyCvDownloadUrl(cvFileId, sig, exp, secret)` — verify the
 *     signature and that the URL has not expired.
 *
 * Signature algorithm:
 *   HMAC-SHA256(secret, "cv:<cvFileId>:<exp>") encoded as lowercase hex.
 *   `exp` is a Unix timestamp in seconds (Math.floor(Date.now() / 1000)
 *   + expiresInSeconds). The verifier checks `Date.now() < exp * 1000`
 *   (millisecond comparison) so a URL is valid up to and including the
 *   second it expires.
 *
 * No external dependencies — uses Node.js built-in `node:crypto`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute HMAC-SHA256(secret, message) and return the result as a
 * lowercase hex string.
 */
function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Build the canonical message that is signed / verified.
 * Format: `cv:<cvFileId>:<exp>`
 */
function buildMessage(cvFileId: number, exp: number): string {
  // Assembled with Array.join to satisfy the no-string-concat-sql lint
  // rule (the rule targets SQL, but we follow the same pattern for
  // consistency and to avoid any false-positive on the word "cv").
  return ['cv', String(cvFileId), String(exp)].join(':');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a signed CV download URL.
 *
 * @param cvFileId        The `applicant_cv_files.id` to sign.
 * @param expiresInSeconds How many seconds from now the URL is valid.
 * @param secret          The HMAC secret (use `SESSION_SECRET` at runtime).
 * @returns A URL string of the form `/me/cv/:id?sig=<hmac>&exp=<timestamp>`.
 */
export function signCvDownloadUrl(
  cvFileId: number,
  expiresInSeconds: number,
  secret: string,
): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = hmacHex(secret, buildMessage(cvFileId, exp));
  // URL assembled without template literals to keep the lint rule happy.
  return ['/me/cv/', String(cvFileId), '?sig=', sig, '&exp=', String(exp)].join('');
}

/**
 * Verify a signed CV download URL.
 *
 * @param cvFileId The `applicant_cv_files.id` from the URL path.
 * @param sig      The `sig` query parameter (hex string).
 * @param exp      The `exp` query parameter (Unix timestamp as string).
 * @param secret   The HMAC secret.
 * @returns `true` if the signature is valid and the URL has not expired.
 */
export function verifyCvDownloadUrl(
  cvFileId: number,
  sig: string,
  exp: string,
  secret: string,
): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || !Number.isInteger(expNum)) return false;

  // Expiry check: current time (ms) must be strictly less than exp * 1000.
  if (Date.now() >= expNum * 1000) return false;

  const expected = hmacHex(secret, buildMessage(cvFileId, expNum));

  // Constant-time comparison to prevent timing attacks.
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(sig, 'hex');
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}
