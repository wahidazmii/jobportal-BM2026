/**
 * Security headers for PT Buana Megah Job Portal.
 *
 * Registers `@fastify/helmet` with the policy defined in design §19 plus an
 * `onRequest` hook that mints a per-request CSP nonce. The nonce is exposed on
 * `request.cspNonce` so route handlers and Nunjucks template contexts can echo
 * it onto inline `<script>` / `<style>` tags. The same nonce is mirrored on
 * `request.raw` because helmet's directive function is invoked with the raw
 * `IncomingMessage` rather than the Fastify request.
 *
 * Headers applied to every response:
 * - `Content-Security-Policy`: per design §19 (function-form `script-src` nonce)
 * - `Strict-Transport-Security`: max-age=31536000; includeSubDomains; preload
 * - `X-Frame-Options`: DENY
 * - `X-Content-Type-Options`: nosniff
 * - `Referrer-Policy`: strict-origin-when-cross-origin
 * - `Permissions-Policy`: (minimal — empty value, browser defaults apply)
 *
 * Validates: Requirements 15.1 (Design §19)
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import fastifyHelmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Per-request CSP nonce. 16 random bytes encoded as base64 (24 chars).
     * Set by the `onRequest` hook installed by `registerSecurityHeaders`.
     */
    cspNonce: string;
  }
}

/** Internal shape used to read the nonce off the raw IncomingMessage. */
type RawRequestWithNonce = IncomingMessage & { cspNonce?: string };

/**
 * Build the CSP policy string from a nonce. Exported as a pure helper so unit
 * tests can assert the exact directive string without booting Fastify.
 *
 * Mirrors the directive order from design §19.
 */
export function cspDirectives(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `base-uri 'self'`,
  ].join('; ');
}

/**
 * Generate a fresh CSP nonce. Exported for symmetry with `cspDirectives` so
 * tests can verify the encoding.
 */
export function generateCspNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Register `@fastify/helmet` plus the per-request nonce hook on the supplied
 * Fastify instance. Call this once during application bootstrap, before any
 * route is registered, so the headers and the nonce are available everywhere.
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  // Mint the nonce as early as possible. helmet's CSP directive function runs
  // during the same `onRequest` lifecycle phase, so we register this hook
  // *before* `app.register(fastifyHelmet, ...)` to guarantee ordering.
  app.addHook('onRequest', async (request) => {
    const nonce = generateCspNonce();
    request.cspNonce = nonce;
    // helmet's directive function receives the raw Node IncomingMessage, so
    // mirror the nonce there as well.
    (request.raw as RawRequestWithNonce).cspNonce = nonce;
  });

  await app.register(fastifyHelmet, {
    // We declare every directive explicitly per design §19, so disable the
    // helmet built-in CSP defaults (which would inject extras like
    // `upgrade-insecure-requests` and `object-src 'none'`).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: [`'self'`],
        scriptSrc: [
          `'self'`,
          (req: IncomingMessage): string => {
            const nonce = (req as RawRequestWithNonce).cspNonce ?? '';
            return `'nonce-${nonce}'`;
          },
        ],
        styleSrc: [`'self'`, `'unsafe-inline'`],
        imgSrc: [`'self'`, `data:`],
        frameAncestors: [`'none'`],
        formAction: [`'self'`],
        baseUri: [`'self'`],
      },
    },
    hsts: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Cross-origin and origin-isolation headers are out of scope for §19 and
    // would conflict with htmx fragments served from the same origin. Disable
    // them so the response set matches the design exactly.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
    // We set Permissions-Policy ourselves below; helmet's option here is a
    // no-op pass-through so leaving it disabled is fine.
  });

  // Permissions-Policy: minimal — empty value means no features are
  // explicitly granted; browsers fall back to their default (most restrictive)
  // policy. Use `onSend` so the header survives helmet's own header pass.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Permissions-Policy', '');
    return payload;
  });
}
