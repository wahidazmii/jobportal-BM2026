/**
 * Admin application-notes route integration test (task 30.1).
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 30.1 — Application notes endpoint
 * Design  : §6 Admin (GET/POST /admin/applications/:id/notes)
 * Validates: Requirements 10.3, 8.2
 *
 * Scope:
 *   We exercise the FULL Fastify app via `buildApp()` + `app.inject()`
 *   so the route handler and the notes service run end-to-end. Two
 *   boundaries are mocked, mirroring `admin-interview-route.spec.ts`:
 *
 *     1. `src/infra/db.ts`           — the prepared-statement boundary.
 *        Each test programs the `query()` responses for the
 *        `loadApplication` SELECT, the `findJobById` round-trip, and the
 *        note INSERT read-back (and the list read for the GET).
 *
 *     2. `src/infra/admin-guard.ts`  — `requireAdmin` returns a canonical
 *        AdminSession when the test wants one; otherwise it
 *        short-circuits to a 302 redirect to `/id/login`, matching the
 *        production admin-guard behaviour.
 *
 *   Sibling route plugins (auth / password / applicant / public / seo)
 *   are stubbed so the bootstrap does not pull in their service mocks.
 *
 * Cases:
 *   1. Unauthenticated POST → admin-guard short-circuit to /id/login.
 *   2. Super_Admin valid internal note → 201 { ok: true, note }.
 *   3. Super_Admin visible note → 201 { ok: true, note }.
 *   4. Empty body → 422 invalid_note_input.
 *   5. GET notes list as Super_Admin → 200 { ok: true, notes }.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

const poolQueryMock = vi.fn();
const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: poolQueryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: queryMock,
  withTransaction: withTransactionMock,
}));

const requireAdminMock = vi.fn();
vi.mock('../../src/infra/admin-guard.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/admin-guard.js')
  >('../../src/infra/admin-guard.js');
  return {
    ...actual,
    requireAdmin: requireAdminMock,
  };
});

/** Stub sibling route plugins so we don't need their service mocks. */
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));
vi.mock('../../src/routes/auth.js', () => ({
  authRoutes: async () => undefined,
}));
vi.mock('../../src/routes/applicant.js', () => ({
  default: async () => undefined,
  applicantRoutes: async () => undefined,
}));
vi.mock('../../src/routes/public.js', () => ({
  default: async () => undefined,
  publicRoutes: async () => undefined,
}));
vi.mock('../../src/routes/seo.js', () => ({
  default: async () => undefined,
  seoRoutes: async () => undefined,
}));

// Import after the mocks register so the production module graph picks
// up the mocked db / admin-guard boundaries.
const { buildApp } = await import('../../src/server.js');

// ---------------------------------------------------------------------------
// Fixtures
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

const APPLICATION_ID = 555;
const JOB_ID = 42;
const JOB_DEPARTMENT_ID = 3;
const NOTE_ID = 8001;
const NOTE_BODY = 'Strong candidate, advancing to screening.';

/** Build an AdminSession-shaped object for the requireAdmin mock. */
function fakeAdminSession(
  role: 'Super_Admin' | 'HR' | 'Department_Head',
  options: { departments?: readonly number[] } = {},
) {
  const scope =
    role === 'Department_Head'
      ? { departments: options.departments ?? [] }
      : {};
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
  };
}

/** Seed the `loadApplication` SELECT so the service finds the row. */
function seedApplicationRow(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: APPLICATION_ID,
      job_id: JOB_ID,
    } as unknown as RowDataPacket,
  ]);
}

/**
 * Seed the `findJobById(id, scope)` round-trip for an in-scope job.
 * The repo fires two queries when the row matches: the job row and the
 * translations.
 */
function seedFindJobByIdSuccess(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: JOB_ID,
      uuid: '01HQABCDEF',
      slug: 'senior-fe-engineer',
      department_id: JOB_DEPARTMENT_ID,
      location: 'Jakarta',
      employment_type: 'full-time',
      level: 'senior',
      status: 'Published',
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      application_deadline: null,
      published_at: new Date('2025-01-01T00:00:00Z'),
      created_by: 1,
      created_at: new Date('2025-01-01T00:00:00Z'),
      updated_at: new Date('2025-01-01T00:00:00Z'),
    } as unknown as RowDataPacket,
  ]);
  queryMock.mockResolvedValueOnce([
    {
      job_id: JOB_ID,
      locale: 'id',
      title: 'Insinyur Frontend Senior',
      description: 'desc',
      requirements: 'req',
      responsibilities: 'resp',
    } as unknown as RowDataPacket,
  ]);
}

/**
 * Seed the note INSERT + read-back. The repo issues an INSERT
 * (ResultSetHeader with insertId) followed by a SELECT for the row.
 */
function seedNoteInsert(visibleToApplicant: boolean): void {
  queryMock.mockResolvedValueOnce({
    insertId: NOTE_ID,
    affectedRows: 1,
  } as unknown as RowDataPacket);
  queryMock.mockResolvedValueOnce([
    {
      id: NOTE_ID,
      application_id: APPLICATION_ID,
      author_user_id: 99,
      body: NOTE_BODY,
      visible_to_applicant: visibleToApplicant ? 1 : 0,
      created_at: new Date('2025-06-01T00:00:00.000Z'),
    } as unknown as RowDataPacket,
  ]);
}

/** Seed the `listForApplication` read for the GET path. */
function seedNotesList(): void {
  queryMock.mockResolvedValueOnce([
    {
      id: NOTE_ID,
      application_id: APPLICATION_ID,
      author_user_id: 99,
      body: NOTE_BODY,
      visible_to_applicant: 0,
      created_at: new Date('2025-06-01T00:00:00.000Z'),
    } as unknown as RowDataPacket,
    {
      id: NOTE_ID + 1,
      application_id: APPLICATION_ID,
      author_user_id: 99,
      body: 'Visible follow-up.',
      visible_to_applicant: 1,
      created_at: new Date('2025-06-02T00:00:00.000Z'),
    } as unknown as RowDataPacket,
  ]);
}

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  withTransactionMock.mockReset();
  requireAdminMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /admin/applications/:id/notes — authentication', () => {
  it('redirects unauthenticated requests to /id/login (admin-guard short-circuit)', async () => {
    requireAdminMock.mockImplementationOnce(async (_request, reply) => {
      reply.code(302).header('location', '/id/login').send();
      return null;
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/notes`,
        payload: { body: NOTE_BODY, visibleToApplicant: 'on' },
      });

      // The admin-guard's redirect is the canonical "no admin access"
      // response; the substantive assertion is that the handler did NOT
      // run: no DB query was issued.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/notes — Super_Admin happy path', () => {
  it('returns 201 with the persisted internal note on valid input', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedApplicationRow();
    seedFindJobByIdSuccess();
    seedNoteInsert(false);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/notes`,
        payload: { body: NOTE_BODY, visibleToApplicant: 'false' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        ok: boolean;
        note: {
          id: number;
          application_id: number;
          visible_to_applicant: boolean;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.note.id).toBe(NOTE_ID);
      expect(body.note.application_id).toBe(APPLICATION_ID);
      expect(body.note.visible_to_applicant).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns 201 with the persisted visible note (visibleToApplicant=on)', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedApplicationRow();
    seedFindJobByIdSuccess();
    seedNoteInsert(true);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/notes`,
        payload: { body: NOTE_BODY, visibleToApplicant: 'on' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        ok: boolean;
        note: { id: number; visible_to_applicant: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.note.visible_to_applicant).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/applications/:id/notes — validation', () => {
  it('returns 422 invalid_note_input when the body is empty', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('HR'));
    seedApplicationRow();
    seedFindJobByIdSuccess();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/applications/${APPLICATION_ID}/notes`,
        payload: { body: '   ', visibleToApplicant: 'false' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as {
        error: string;
        fields: Record<string, string[]>;
      };
      expect(body.error).toBe('invalid_note_input');
      expect(body.fields.body).toBeDefined();
      // loadApplication + findJobById fired (3 queries); no INSERT.
      expect(queryMock).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/applications/:id/notes — list', () => {
  it('returns 200 with the full note list as Super_Admin', async () => {
    requireAdminMock.mockResolvedValueOnce(fakeAdminSession('Super_Admin'));
    seedApplicationRow();
    seedFindJobByIdSuccess();
    seedNotesList();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/applications/${APPLICATION_ID}/notes`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        notes: Array<{ id: number; visible_to_applicant: boolean }>;
      };
      expect(body.ok).toBe(true);
      expect(body.notes).toHaveLength(2);
      // Admin sees BOTH internal and visible notes.
      const visibilities = body.notes.map((n) => n.visible_to_applicant);
      expect(visibilities).toContain(true);
      expect(visibilities).toContain(false);
    } finally {
      await app.close();
    }
  });
});
