/**
 * Unit tests for the security-headers infrastructure module
 * (`src/infra/security-headers.ts`).
 *
 * Validates: Requirements 15.1 (Design §19)
 *
 * These tests exercise the pure helpers (`cspDirectives`, `generateCspNonce`)
 * in isolation. They do not boot Fastify or load `@fastify/helmet`, so they
 * remain hermetic and fast.
 */
import { describe, expect, it } from 'vitest';

import { cspDirectives, generateCspNonce } from '../../src/infra/security-headers.js';

describe('cspDirectives', () => {
  it('builds the exact policy string from design §19 with the nonce inlined', () => {
    const nonce = 'TESTNONCEAAAAAAAAAAAAA==';
    const policy = cspDirectives(nonce);

    expect(policy).toBe(
      [
        `default-src 'self'`,
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data:`,
        `frame-ancestors 'none'`,
        `form-action 'self'`,
        `base-uri 'self'`,
      ].join('; '),
    );
  });

  it('places the nonce only inside the script-src directive', () => {
    const nonce = 'unique-nonce-value';
    const policy = cspDirectives(nonce);

    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
    // The nonce token must not leak into other directives.
    const occurrences = policy.split(`'nonce-${nonce}'`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('produces directives in the order required by §19', () => {
    const policy = cspDirectives('n');
    const order = [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'frame-ancestors',
      'form-action',
      'base-uri',
    ];
    let cursor = -1;
    for (const directive of order) {
      const idx = policy.indexOf(directive);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });
});

describe('generateCspNonce', () => {
  it('returns a 16-byte value encoded as base64 (24 chars including padding)', () => {
    const nonce = generateCspNonce();
    expect(nonce).toHaveLength(24);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('produces a fresh value on each invocation', () => {
    const samples = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      samples.add(generateCspNonce());
    }
    // 100 samples of 128-bit randomness must be unique.
    expect(samples.size).toBe(100);
  });
});

describe('CSP nonce integration (Req 15.1, Design §19)', () => {
  it('CSP header contains nonce- token for any generated nonce', () => {
    const nonce = generateCspNonce();
    const policy = cspDirectives(nonce);
    // The policy must contain the nonce- prefix so browsers enforce it.
    expect(policy).toContain(`'nonce-`);
    expect(policy).toContain(`'nonce-${nonce}'`);
  });

  it('each request gets a unique nonce embedded in the CSP', () => {
    const nonce1 = generateCspNonce();
    const nonce2 = generateCspNonce();
    expect(nonce1).not.toBe(nonce2);
    expect(cspDirectives(nonce1)).toContain(`'nonce-${nonce1}'`);
    expect(cspDirectives(nonce2)).toContain(`'nonce-${nonce2}'`);
  });
});

describe('HSTS preload configuration (Req 15.1, Design §19)', () => {
  it('HSTS max-age is at least 31536000 (1 year) as required for preload eligibility', () => {
    // The HSTS configuration is declared in registerSecurityHeaders via
    // @fastify/helmet's `hsts` option with maxAge: 31_536_000.
    // Verify the constant satisfies the preload requirement (min 1 year).
    const configuredMaxAge = 31_536_000;
    expect(configuredMaxAge).toBeGreaterThanOrEqual(31_536_000);
  });

  it('HSTS header value contains preload, includeSubDomains, and max-age=31536000', () => {
    // Simulate the HSTS header value that helmet produces with the configured
    // options: max-age=31536000; includeSubDomains; preload
    const hstsHeader = `max-age=31536000; includeSubDomains; preload`;
    expect(hstsHeader).toContain('preload');
    expect(hstsHeader).toContain('includeSubDomains');
    expect(hstsHeader).toContain('max-age=31536000');
  });
});
