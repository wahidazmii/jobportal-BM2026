/**
 * Unit tests for the Applicant_Area skill-tag routes
 * (`src/routes/applicant.ts`, task 16.4).
 *
 * Validates: Requirements 4.4 (Design §6 Applicant_Area, §10.1)
 *
 * The route plugin talks to two boundaries:
 *   - the auth-guard (`requireApplicant` from `src/infra/auth-guard.ts`),
 *     and
 *   - the skills service (`listAssignedSkills`, `searchSkills`,
 *     `toggleSkill` from `src/modules/applicant/skills.ts`).
 *
 * We mock both so the suite stays hermetic and exercise the route
 * end-to-end via Fastify's `inject()`. Service-level behaviour
 * (FULLTEXT sanitisation, transaction-bound cap enforcement, IDOR
 * scoping) is already covered by `applicant-skills.test.ts`. Here we
 * focus on the HTTP plumbing: status codes, fragment shape, locale
 * gating, unauthenticated redirect, error mapping (cap → 422,
 * inactive → 422, malformed id → 400).
 *
 * Cases covered:
 *   - GET /:locale/me/profile/skills (id and en) renders the section
 *     200 OK with the chosen-skill chips and search input.
 *   - GET without a session redirects 302 to /{locale}/login.
 *   - GET /skills/search?q=... renders the autocomplete fragment
 *     with the assignedIds the chip filter relies on.
 *   - POST /skills/toggle calls `toggleSkill` with the parsed body
 *     and returns the refreshed section fragment.
 *   - POST /skills/toggle with a bad skill_id renders 400.
 *   - POST /skills/toggle that hits the cap renders 422.
 *   - POST /skills/toggle for an inactive skill renders 422.
 *   - GET / POST with an unsupported locale segment 404 before any
 *     auth or service work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

const poolQueryMock = vi.fn();
const queryMock = vi.fn();
vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: poolQueryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: queryMock,
  withTransaction: vi.fn(),
}));

const requireApplicantMock = vi.fn();
vi.mock('../../src/infra/auth-guard.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/auth-guard.js')
  >('../../src/infra/auth-guard.js');
  return {
    ...actual,
    requireApplicant: requireApplicantMock,
  };
});

const listAssignedSkillsMock = vi.fn();
const searchSkillsMock = vi.fn();
const toggleSkillMock = vi.fn();
vi.mock('../../src/modules/applicant/skills.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/applicant/skills.js')
  >('../../src/modules/applicant/skills.js');
  return {
    ...actual,
    listAssignedSkills: listAssignedSkillsMock,
    searchSkills: searchSkillsMock,
    toggleSkill: toggleSkillMock,
  };
});

// Stub sibling route plugins so the server bootstrap doesn't pull
// their service mocks into this test.
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));
vi.mock('../../src/routes/auth.js', () => ({
  authRoutes: async () => undefined,
}));

// Import after mocks are registered.
const { buildApp } = await import('../../src/server.js');
const skillsModule = await import('../../src/modules/applicant/skills.js');
const { SkillCapError, SkillInactiveError, SkillNotFoundError } = skillsModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://localhost',
  databaseUrl: 'mysql://test',
  sessionSecret: 'test-secret',
  logLevel: 'silent',
} as const;

function fakeSession() {
  return {
    sid: 'a'.repeat(43),
    userId: 42,
    role: 'Applicant' as const,
    csrfToken: 'b'.repeat(43),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    expiresAt: new Date('2025-01-01T12:00:00Z'),
    ipAddress: null,
    userAgent: null,
  };
}

function stubRequireApplicantUnauthenticated(): void {
  requireApplicantMock.mockImplementation(async (_req, reply) => {
    reply.code(302).header('location', '/id/login').send();
    return null;
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  requireApplicantMock.mockReset();
  listAssignedSkillsMock.mockReset();
  searchSkillsMock.mockReset();
  toggleSkillMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /:locale/me/profile/skills — happy path
// ---------------------------------------------------------------------------

describe('GET /:locale/me/profile/skills — happy path', () => {
  it('renders the skills section 200 OK with the assigned chips', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    listAssignedSkillsMock.mockResolvedValueOnce([
      { id: 1, label: 'JavaScript', active: true },
      { id: 2, label: 'TypeScript', active: true },
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/profile/skills',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Both chips rendered.
      expect(res.body).toContain('JavaScript');
      expect(res.body).toContain('TypeScript');
      // Counter shows 2 of 30.
      expect(res.body).toMatch(/<strong>\s*2\s*<\/strong>\s*dari\s*30/);
      // Search input present.
      expect(res.body).toContain('id="skill-search"');
      // CSRF token rendered into the chip's hidden field.
      expect(res.body).toContain('b'.repeat(43));

      expect(listAssignedSkillsMock).toHaveBeenCalledWith(42);
    } finally {
      await app.close();
    }
  });

  it('renders the English variant for /en', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    listAssignedSkillsMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/en/me/profile/skills',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Skills/);
      expect(res.body).toMatch(/of\s*30/);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/me/profile/skills — unauthenticated
// ---------------------------------------------------------------------------

describe('GET /:locale/me/profile/skills — unauthenticated', () => {
  it('redirects 302 to /{locale}/login when no session is present', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/profile/skills',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(listAssignedSkillsMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/me/profile/skills — unsupported locale
// ---------------------------------------------------------------------------

describe('GET /:locale/me/profile/skills — unknown locale', () => {
  it('rejects with 404 before invoking the auth guard', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/fr/me/profile/skills',
      });
      expect(res.statusCode).toBe(404);
      expect(requireApplicantMock).not.toHaveBeenCalled();
      expect(listAssignedSkillsMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:locale/me/profile/skills/search
// ---------------------------------------------------------------------------

describe('GET /:locale/me/profile/skills/search', () => {
  it('renders the autocomplete fragment with assignedIds for the filter', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    listAssignedSkillsMock.mockResolvedValueOnce([
      { id: 1, label: 'JavaScript', active: true },
    ]);
    searchSkillsMock.mockResolvedValueOnce([
      { id: 1, label: 'JavaScript', active: true },
      { id: 7, label: 'Java', active: true },
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/profile/skills/search?q=java',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Both suggestions present.
      expect(res.body).toContain('Java');
      // Already-assigned suggestion should carry the "Already added" badge.
      expect(res.body).toMatch(/Sudah ditambahkan/);

      expect(searchSkillsMock).toHaveBeenCalledWith('java');
      expect(listAssignedSkillsMock).toHaveBeenCalledWith(42);
    } finally {
      await app.close();
    }
  });

  it('passes operator-bearing input straight to the service without errors', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    listAssignedSkillsMock.mockResolvedValueOnce([]);
    searchSkillsMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/profile/skills/search?q=%2B%2A',
      });
      expect(res.statusCode).toBe(200);
      // Service receives the raw string; sanitisation happens inside it.
      expect(searchSkillsMock).toHaveBeenCalledWith('+*');
    } finally {
      await app.close();
    }
  });

  it('returns an empty fragment when the query is missing', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    listAssignedSkillsMock.mockResolvedValueOnce([]);
    searchSkillsMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/profile/skills/search',
      });
      expect(res.statusCode).toBe(200);
      // Empty list message rendered.
      expect(res.body).toMatch(/Tidak ada skill cocok/);
      expect(searchSkillsMock).toHaveBeenCalledWith('');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/profile/skills/toggle — happy path
// ---------------------------------------------------------------------------

describe('POST /:locale/me/profile/skills/toggle — happy path', () => {
  it('calls toggleSkill with parsed userId+skillId and returns the section fragment', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    toggleSkillMock.mockResolvedValueOnce({
      assigned: true,
      count: 3,
      skill: { id: 9, label: 'TypeScript', active: true },
    });
    listAssignedSkillsMock.mockResolvedValueOnce([
      { id: 9, label: 'TypeScript', active: true },
    ]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile/skills/toggle',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'skill_id=9',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('TypeScript');
      expect(res.body).toContain('id="skills-section"');

      expect(toggleSkillMock).toHaveBeenCalledTimes(1);
      const [userId, skillId] = toggleSkillMock.mock.calls[0] as [number, number];
      expect(userId).toBe(42);
      expect(skillId).toBe(9);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/profile/skills/toggle — error mapping
// ---------------------------------------------------------------------------

describe('POST /:locale/me/profile/skills/toggle — error mapping', () => {
  it('returns 400 when skill_id is malformed', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    listAssignedSkillsMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile/skills/toggle',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'skill_id=not-a-number',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('id="skills-section"');
      expect(toggleSkillMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 422 when the cap is reached', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    toggleSkillMock.mockRejectedValueOnce(new SkillCapError(30));
    listAssignedSkillsMock.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        label: `Skill ${i + 1}`,
        active: true,
      })),
    );

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile/skills/toggle',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'skill_id=31',
      });
      expect(res.statusCode).toBe(422);
      // Section still rendered with the cap-reached banner.
      expect(res.body).toContain('id="skills-section"');
      expect(res.body).toMatch(/batas 30 skill/);
    } finally {
      await app.close();
    }
  });

  it('returns 422 when the skill is inactive', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    toggleSkillMock.mockRejectedValueOnce(new SkillInactiveError(9));
    listAssignedSkillsMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile/skills/toggle',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'skill_id=9',
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('id="skills-section"');
    } finally {
      await app.close();
    }
  });

  it('returns 422 when the skill id does not exist', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    toggleSkillMock.mockRejectedValueOnce(new SkillNotFoundError(99));
    listAssignedSkillsMock.mockResolvedValueOnce([]);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile/skills/toggle',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'skill_id=99',
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('id="skills-section"');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:locale/me/profile/skills/toggle — unauthenticated
// ---------------------------------------------------------------------------

describe('POST /:locale/me/profile/skills/toggle — unauthenticated', () => {
  it('redirects 302 to login without invoking the service', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/id/me/profile/skills/toggle',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'skill_id=9',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(toggleSkillMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
