/**
 * Fastify request type augmentations for PT Buana Megah Job Portal.
 *
 * Extends the Fastify `FastifyRequest` interface with fields set by the
 * request-lifecycle hooks registered in `src/server.ts`:
 *
 *   - `startTime`  — `Date.now()` captured in the `onRequest` hook; used by
 *                    the `onResponse` hook to compute `latency_ms`.
 *   - `session`    — Populated by the session-load middleware; carries the
 *                    authenticated user's id so the access-log hook can emit
 *                    `user_id` without coupling to the session-store module.
 *
 * Validates: Requirements 20.1, 20.2 (Design §18.1)
 */

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Unix timestamp (ms) captured at the start of the request lifecycle.
     * Set by the `onRequest` hook in `src/server.ts`.
     */
    startTime: number;

    /**
     * Authenticated session data. Populated by the session-load middleware
     * when a valid session cookie is present; `undefined` for unauthenticated
     * requests.
     */
    session?: {
      /** Database primary key of the authenticated user, if any. */
      userId?: number;
    };
  }
}

export {};
