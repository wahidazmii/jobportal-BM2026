/**
 * Unit tests for `src/modules/mail/state-machine.ts` (task 37.1 helper).
 *
 * Validates: Requirements 8.3, 8.4, 8.5 (Design §12.1, §12.2)
 *
 * These are pure-function tests for the allowed-transition guard and the
 * retry-backoff schedule that the `mail-flush` cron relies on. The full
 * property test (task 37.2, Property 3) lives separately under
 * `tests/pbt/`; this file covers the concrete examples and edge cases.
 */

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MAIL_TRANSITIONS,
  MAIL_BACKOFF_SECONDS,
  MAIL_STATUSES,
  MAX_MAIL_FAILURES,
  assertMailTransition,
  backoffSecondsForFailure,
  canTransitionMail,
  InvalidMailTransitionError,
  isMailStatus,
  isTerminalFailure,
  type MailStatus,
} from '../../src/modules/mail/state-machine.js';

describe('mail state machine — allowed transitions', () => {
  it('permits exactly the Design §12.1 edges', () => {
    expect(canTransitionMail('pending', 'sending')).toBe(true);
    expect(canTransitionMail('sending', 'sent')).toBe(true);
    expect(canTransitionMail('sending', 'pending')).toBe(true);
    expect(canTransitionMail('sending', 'failed')).toBe(true);
  });

  it('treats sent and failed as terminal', () => {
    for (const to of MAIL_STATUSES) {
      expect(canTransitionMail('sent', to)).toBe(false);
      expect(canTransitionMail('failed', to)).toBe(false);
    }
  });

  it('rejects illegal edges', () => {
    expect(canTransitionMail('pending', 'sent')).toBe(false);
    expect(canTransitionMail('pending', 'failed')).toBe(false);
    expect(canTransitionMail('pending', 'pending')).toBe(false);
    expect(canTransitionMail('sending', 'sending')).toBe(false);
  });

  it('the transition map only ever targets the four known statuses', () => {
    const known = new Set<MailStatus>(MAIL_STATUSES);
    for (const targets of Object.values(ALLOWED_MAIL_TRANSITIONS)) {
      for (const target of targets) {
        expect(known.has(target)).toBe(true);
      }
    }
  });

  it('assertMailTransition throws on a disallowed pair', () => {
    expect(() => assertMailTransition('sending', 'sent')).not.toThrow();
    expect(() => assertMailTransition('sent', 'pending')).toThrow(
      InvalidMailTransitionError,
    );
  });
});

describe('mail state machine — isMailStatus guard', () => {
  it('accepts the four enum values and rejects anything else', () => {
    for (const status of MAIL_STATUSES) {
      expect(isMailStatus(status)).toBe(true);
    }
    expect(isMailStatus('queued')).toBe(false);
    expect(isMailStatus(42)).toBe(false);
    expect(isMailStatus(null)).toBe(false);
  });
});

describe('mail state machine — backoff schedule (§12.2)', () => {
  it('encodes [1m, 5m, 15m, 1h, 6h] in seconds', () => {
    expect(MAIL_BACKOFF_SECONDS).toEqual([60, 300, 900, 3_600, 21_600]);
  });

  it('maps the Nth failure to the (N-1)th backoff entry', () => {
    expect(backoffSecondsForFailure(1)).toBe(60); // 1m
    expect(backoffSecondsForFailure(2)).toBe(300); // 5m
    expect(backoffSecondsForFailure(3)).toBe(900); // 15m
    expect(backoffSecondsForFailure(4)).toBe(3_600); // 1h
  });

  it('clamps out-of-range failure counts to the longest backoff', () => {
    expect(backoffSecondsForFailure(0)).toBe(60); // clamps up to index 0
    expect(backoffSecondsForFailure(5)).toBe(21_600);
    expect(backoffSecondsForFailure(99)).toBe(21_600);
  });
});

describe('mail state machine — terminal failure threshold (Req 8.5)', () => {
  it('is terminal only once failures reach MAX_MAIL_FAILURES', () => {
    expect(MAX_MAIL_FAILURES).toBe(5);
    expect(isTerminalFailure(1)).toBe(false);
    expect(isTerminalFailure(4)).toBe(false);
    expect(isTerminalFailure(5)).toBe(true);
    expect(isTerminalFailure(6)).toBe(true);
  });
});
