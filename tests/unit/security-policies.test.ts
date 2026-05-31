/**
 * Unit tests for `src/modules/security/policies.ts` (task 39.1).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.6 (Design §14.1 policy map,
 *            §14.3 denial → 403 + AccessDenied audit).
 *
 * Coverage:
 *   1. `can(role, policy)` returns the correct boolean for each role over a
 *      representative slice of the §14.1 map (Super_Admin everywhere; HR on
 *      HR policies but not Super_Admin-only ones; Department_Head only on
 *      its read/note policies; Applicant never).
 *   2. `POLICIES` transcribes the §14.1 table — a handful of key entries are
 *      asserted exactly.
 *   3. `requirePolicy(name)`:
 *        - allowed role        → returns the session, no audit, no 403.
 *        - disallowed role     → 403 + `admin/403.njk` rendered + one
 *                                `access_denied` audit write.
 *        - unauthenticated     → returns null (requireAdmin already
 *                                responded), NO audit.
 *
 * Two boundaries are mocked: `requireAdmin` (so we can hand the guard an
 * arbitrary session or a null short-circuit) and `auditService.write` (so
 * the denial path is observable without a DB). The DB module is mocked
 * because `audit/writer.js` imports it at module load.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AdminSession } from '../../src/infra/admin-guard.js';
import type { UserRole } from '../../src/infra/session-store.js';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

// `audit/writer.js` imports the DB at load — give it an inert pool/query.
vi.mock('../../src/infra/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

const requireAdminMock = vi.fn();
vi.mock('../../src/infra/admin-guard.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/admin-guard.js')
  >('../../src/infra/admin-guard.js');
  return { ...actual, requireAdmin: requireAdminMock };
});

const auditWriteMock = vi.fn();
vi.mock('../../src/modules/audit/writer.js', () => ({
  auditService: { write: auditWriteMock },
  write: auditWriteMock,
  writeAudit: auditWriteMock,
  ACTION_TYPES: [],
}));

// Import after the mocks register.
const { POLICIES, can, requirePolicy } = await import(
  '../../src/modules/security/policies.js'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build an AdminSession-shaped object for the requireAdmin mock. */
function fakeAdminSession(role: UserRole): AdminSession {
  const scope =
    role === 'Department_Head' ? { departments: [3] as const } : {};
  return {
    sid: 'a'.repeat(43),
    userId: 99,
    role,
    csrfToken: 'b'.repeat(43),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    expiresAt: new Date('2025-01-01T12:00:00Z'),
    ipAddress: null,
    userAgent: null,
    scope,
  } as unknown as AdminSession;
}

/** A minimal request with the surface `requirePolicy` touches. */
function fakeRequest(): FastifyRequest {
  const viewMock = vi.fn().mockReturnValue('<html>403</html>');
  return {
    ip: '203.0.113.5',
    server: { view: viewMock },
    log: { error: vi.fn() },
    cspNonce: 'nonce-xyz',
  } as unknown as FastifyRequest;
}

/** A minimal reply that records the status / body chain. */
function fakeReply(): FastifyReply & {
  _code: number | null;
  _body: unknown;
} {
  const reply = {
    _code: null as number | null,
    _body: undefined as unknown,
    code(n: number) {
      this._code = n;
      return this;
    },
    type() {
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return reply as unknown as FastifyReply & {
    _code: number | null;
    _body: unknown;
  };
}

beforeEach(() => {
  requireAdminMock.mockReset();
  auditWriteMock.mockReset();
  auditWriteMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. can(role, policy) per role
// ---------------------------------------------------------------------------

describe('can(role, policy) — §14.1 grants', () => {
  it('grants Super_Admin every policy', () => {
    for (const policy of Object.keys(POLICIES) as Array<
      keyof typeof POLICIES
    >) {
      expect(can('Super_Admin', policy)).toBe(true);
    }
  });

  it('grants HR job/application/mail policies but NOT Super_Admin-only ones', () => {
    expect(can('HR', 'job.create')).toBe(true);
    expect(can('HR', 'job.publish')).toBe(true);
    expect(can('HR', 'job.read')).toBe(true);
    expect(can('HR', 'application.stage.change')).toBe(true);
    expect(can('HR', 'application.export')).toBe(true);
    expect(can('HR', 'mail_template.manage')).toBe(true);
    // Super_Admin-only.
    expect(can('HR', 'user.invite')).toBe(false);
    expect(can('HR', 'audit.read')).toBe(false);
    expect(can('HR', 'backup.read')).toBe(false);
  });

  it('grants Department_Head only its read/note policies', () => {
    expect(can('Department_Head', 'job.read')).toBe(true);
    expect(can('Department_Head', 'application.note.add')).toBe(true);
    // Write / management actions are denied.
    expect(can('Department_Head', 'job.create')).toBe(false);
    expect(can('Department_Head', 'job.publish')).toBe(false);
    expect(can('Department_Head', 'application.stage.change')).toBe(false);
    expect(can('Department_Head', 'application.export')).toBe(false);
    expect(can('Department_Head', 'mail_template.manage')).toBe(false);
    expect(can('Department_Head', 'user.invite')).toBe(false);
  });

  it('grants Applicant nothing', () => {
    for (const policy of Object.keys(POLICIES) as Array<
      keyof typeof POLICIES
    >) {
      expect(can('Applicant', policy)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. POLICIES matches design §14.1
// ---------------------------------------------------------------------------

describe('POLICIES — §14.1 transcription', () => {
  it('maps each key policy to the exact role set', () => {
    const entries: Array<[keyof typeof POLICIES, UserRole[]]> = [
      ['job.create', ['Super_Admin', 'HR']],
      ['job.publish', ['Super_Admin', 'HR']],
      ['job.read', ['Super_Admin', 'HR', 'Department_Head']],
      ['application.note.add', ['Super_Admin', 'HR', 'Department_Head']],
      ['application.stage.change', ['Super_Admin', 'HR']],
      ['application.export', ['Super_Admin', 'HR']],
      ['user.invite', ['Super_Admin']],
      ['audit.read', ['Super_Admin']],
      ['backup.read', ['Super_Admin']],
    ];
    for (const [policy, roles] of entries) {
      const set = POLICIES[policy];
      expect(set.size).toBe(roles.length);
      for (const role of roles) expect(set.has(role)).toBe(true);
    }
  });

  it('never grants Applicant in any entry', () => {
    for (const policy of Object.keys(POLICIES) as Array<
      keyof typeof POLICIES
    >) {
      expect(POLICIES[policy].has('Applicant')).toBe(false);
    }
  });

  it('exposes the inner sets as ReadonlySet (frozen table)', () => {
    expect(Object.isFrozen(POLICIES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. requirePolicy(name)
// ---------------------------------------------------------------------------

describe('requirePolicy — allowed role', () => {
  it('returns the session without auditing or rendering a 403', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));
    const request = fakeRequest();
    const reply = fakeReply();

    const result = await requirePolicy('job.create')(request, reply);

    expect(result).not.toBeNull();
    expect(result?.role).toBe('HR');
    expect(auditWriteMock).not.toHaveBeenCalled();
    expect(reply._code).toBeNull();
    expect(
      (request.server.view as unknown as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });
});

describe('requirePolicy — disallowed role', () => {
  it('renders admin/403.njk with 403 and writes one access_denied audit', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Department_Head'));
    const request = fakeRequest();
    const reply = fakeReply();

    const result = await requirePolicy('job.create')(request, reply);

    expect(result).toBeNull();
    expect(reply._code).toBe(403);
    // The 403 view was rendered with the role + policy context.
    const viewMock = request.server.view as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(viewMock).toHaveBeenCalledTimes(1);
    expect(viewMock.mock.calls[0]?.[0]).toBe('admin/403.njk');
    expect(viewMock.mock.calls[0]?.[1]).toMatchObject({
      role: 'Department_Head',
      policy: 'job.create',
    });
    // Exactly one access_denied audit event was written (§14.3, Req 11.6).
    expect(auditWriteMock).toHaveBeenCalledTimes(1);
    expect(auditWriteMock.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: 99,
      actorIp: '203.0.113.5',
      actionType: 'access_denied',
      targetEntity: 'policy',
      targetId: null,
      details: { policy: 'job.create', role: 'Department_Head' },
    });
  });

  it('still returns a clean 403 when the audit write fails', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Department_Head'));
    auditWriteMock.mockRejectedValueOnce(new Error('db down'));
    const request = fakeRequest();
    const reply = fakeReply();

    const result = await requirePolicy('mail_template.manage')(request, reply);

    expect(result).toBeNull();
    expect(reply._code).toBe(403);
    // The failure was logged, not thrown.
    expect(
      (request.log.error as unknown as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalled();
  });
});

describe('requirePolicy — unauthenticated', () => {
  it('returns null without auditing when requireAdmin short-circuits', async () => {
    // requireAdmin already wrote a 302 and returned null.
    requireAdminMock.mockResolvedValueOnce(null);
    const request = fakeRequest();
    const reply = fakeReply();

    const result = await requirePolicy('job.create')(request, reply);

    expect(result).toBeNull();
    expect(auditWriteMock).not.toHaveBeenCalled();
    expect(
      (request.server.view as unknown as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });
});
