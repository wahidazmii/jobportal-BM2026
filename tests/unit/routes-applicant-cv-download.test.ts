/**
 * Unit tests for the Applicant_Area CV download route
 * (`GET /:locale/me/cv/:id`, task 17.3).
 *
 * Validates: Requirements 15.6 (Design §9 — CV download endpoint).
 *
 * The route stitches three boundaries together:
 *   - the auth-guard (`requireApplicant` from `src/infra/auth-guard.ts`);
 *   - the CV service (`loadCvForDownload` from
 *     `src/modules/applicant/cv.ts`); and
 *   - `node:fs` (`stat`, `createReadStream`).
 *
 * We mock the auth-guard and the CV service so the suite stays
 * hermetic, and we use a real temporary file on disk so the
 * `createReadStream` path is exercised end-to-end via Fastify's
 * `inject()`. That gives the test confidence the headers are emitted
 * correctly AND the body is wired through.
 *
 * Cases covered:
 *   - Owner happy path (PDF) returns 200 with the required headers
 *     (`Content-Disposition: attachment; filename="…"`,
 *     `X-Content-Type-Options: nosniff`,
 *     `Cache-Control: private, no-store`,
 *     `Content-Type` from the stored MIME) and the file body.
 *   - Owner happy path with a non-PDF MIME (DOCX) maps `Content-Type`
 *     to the right value.
 *   - The `original_filename` is sanitised in the
 *     `Content-Disposition` header: control chars / quotes / newlines
 *     are stripped; an empty cleaned name falls back to `cv.<ext>`.
 *   - Unknown id (service returns null) → 404, no headers leaked.
 *   - File missing on disk (ENOENT from stat) → 404, response body is
 *     a plain JSON `not_found` payload (no partial stream).
 *   - Unauthenticated request → 302 to `/{locale}/login`, the service
 *     is never called.
 *   - Non-numeric `:id` → 404 before any service call.
 *   - Unsupported locale → 404 before any auth or service work.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (registered before importing modules under test)
// ---------------------------------------------------------------------------

// DB pool — the healthz route may exercise it, but no test in this file
// depends on its result. Stubbed so the `pool.end()` from the test
// teardown does not crash.
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

// Auth guard — drives the session in/out of the route handler.
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

// CV service — the route's primary collaborator.
const loadCvForDownloadMock = vi.fn();
vi.mock('../../src/modules/applicant/cv.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/applicant/cv.js')
  >('../../src/modules/applicant/cv.js');
  return {
    ...actual,
    loadCvForDownload: loadCvForDownloadMock,
  };
});

// Stub sibling route plugins so the server bootstrap does not pull
// their service mocks into this test.
vi.mock('../../src/routes/password.js', () => ({
  default: async () => undefined,
}));
vi.mock('../../src/routes/auth.js', () => ({
  authRoutes: async () => undefined,
}));

// Import after mocks are registered.
const { buildApp } = await import('../../src/server.js');

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

/** Canonical SessionRecord for an authenticated Applicant. */
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
  requireApplicantMock.mockImplementation(async (_request, reply) => {
    reply.code(302).header('location', '/id/login').send();
    return null;
  });
}

/**
 * Create a real temporary file on disk and return its absolute path.
 * The caller is responsible for cleaning up via the suite's afterEach.
 */
async function createTempFile(
  contents: string | Buffer,
  filename: string,
): Promise<{ dir: string; abs: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ptk-cv-test-'));
  const abs = path.join(dir, filename);
  await writeFile(abs, contents);
  return { dir, abs };
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const tempDirs: string[] = [];

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  requireApplicantMock.mockReset();
  loadCvForDownloadMock.mockReset();
});

afterEach(async () => {
  vi.clearAllMocks();
  // Clean up every temp directory created during the test.
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

// ---------------------------------------------------------------------------
// Owner happy path — headers and body
// ---------------------------------------------------------------------------

describe('GET /:locale/me/cv/:id — owner happy path', () => {
  it('streams the file with the required headers and Content-Type from MIME', async () => {
    const body = '%PDF-1.4 fake pdf body';
    const { dir, abs } = await createTempFile(body, 'real.pdf');
    tempDirs.push(dir);

    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce({
      absolutePath: abs,
      mimeType: PDF_MIME,
      originalFilename: 'My_CV.pdf',
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/77' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="My_CV.pdf"',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      // Content-Length present because we successfully `stat`'d the file.
      expect(res.headers['content-length']).toBe(String(body.length));

      // Body is the file we wrote.
      expect(res.body).toBe(body);

      // Service called with the session's userId + role and the parsed id.
      expect(loadCvForDownloadMock).toHaveBeenCalledTimes(1);
      expect(loadCvForDownloadMock).toHaveBeenCalledWith(
        42,
        'Applicant',
        77,
      );
    } finally {
      await app.close();
    }
  });

  it('uses the wordprocessingml MIME for DOCX downloads', async () => {
    const { dir, abs } = await createTempFile(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // ZIP-like prefix; we only need the bytes to exist
      'real.docx',
    );
    tempDirs.push(dir);

    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce({
      absolutePath: abs,
      mimeType: DOCX_MIME,
      originalFilename: 'resume.docx',
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/12' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(
        /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/,
      );
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="resume.docx"',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Filename sanitisation
// ---------------------------------------------------------------------------

describe('GET /:locale/me/cv/:id — filename sanitisation', () => {
  it('strips quotes, backslashes, and CR/LF from the original filename', async () => {
    const { dir, abs } = await createTempFile('body', 'real.pdf');
    tempDirs.push(dir);

    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce({
      absolutePath: abs,
      mimeType: PDF_MIME,
      // A maliciously crafted filename trying to inject extra headers
      // and escape the quoted-string boundary.
      originalFilename: 'My"CV\\\r\nX-Injected: yes\n.pdf',
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/1' });
      expect(res.statusCode).toBe(200);
      const cd = res.headers['content-disposition'];
      expect(cd).toBeDefined();
      // Extract the filename portion (between the literal quotes) and
      // assert it has no raw CR/LF/quotes/backslashes — the header
      // wrapper itself uses `"…"` so we cannot regex the whole string
      // for `"`. The dangerous part of the injection attempt was the
      // CR/LF that would have ended the header line; once those are
      // stripped the literal text "X-Injected: yes" is harmless
      // because it stays inside the quoted-string on the same line.
      const match = String(cd).match(/^attachment; filename="([^"]*)"$/);
      expect(match).not.toBeNull();
      const filename = match?.[1] ?? '';
      expect(filename).not.toMatch(/[\r\n"\\]/);
      // The header value as a whole must contain no CR/LF — that is
      // the actual injection vector.
      expect(cd).not.toMatch(/[\r\n]/);
      // The normal `.pdf` suffix from the cleaned input is preserved.
      expect(filename).toMatch(/\.pdf$/);
    } finally {
      await app.close();
    }
  });

  it('replaces path separators in the filename so the value never looks like a path', async () => {
    const { dir, abs } = await createTempFile('body', 'real.pdf');
    tempDirs.push(dir);

    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce({
      absolutePath: abs,
      mimeType: PDF_MIME,
      originalFilename: '../../etc/passwd',
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/1' });
      expect(res.statusCode).toBe(200);
      const cd = res.headers['content-disposition'];
      expect(cd).toBe('attachment; filename=".._.._etc_passwd"');
    } finally {
      await app.close();
    }
  });

  it('falls back to cv.pdf when the original filename has no ASCII chars', async () => {
    const { dir, abs } = await createTempFile('body', 'real.pdf');
    tempDirs.push(dir);

    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce({
      absolutePath: abs,
      mimeType: PDF_MIME,
      // Pure non-ASCII (Chinese only): every character is dropped by
      // the printable-ASCII filter, so the cleaned value is empty and
      // the fallback `cv.pdf` is used.
      originalFilename: '简历文件',
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/1' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="cv.pdf"',
      );
    } finally {
      await app.close();
    }
  });

  it('falls back to cv.docx for DOCX downloads with empty cleaned filename', async () => {
    const { dir, abs } = await createTempFile('body', 'real.docx');
    tempDirs.push(dir);

    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce({
      absolutePath: abs,
      mimeType: DOCX_MIME,
      originalFilename: '',
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/1' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="cv.docx"',
      );
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization / not-found cases
// ---------------------------------------------------------------------------

describe('GET /:locale/me/cv/:id — not found / not authorized', () => {
  it('returns 404 when the service reports no descriptor (unknown id or wrong owner)', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce(null);

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/999' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['cache-control']).not.toBe('private, no-store');
      expect(loadCvForDownloadMock).toHaveBeenCalledWith(
        42,
        'Applicant',
        999,
      );
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the on-disk file is missing even if the row exists', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());
    loadCvForDownloadMock.mockResolvedValueOnce({
      absolutePath: path.join(
        tmpdir(),
        'ptk-cv-test-does-not-exist',
        'gone.pdf',
      ),
      mimeType: PDF_MIME,
      originalFilename: 'gone.pdf',
    });

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/5' });
      expect(res.statusCode).toBe(404);
      // No partial stream was emitted; headers should not include the
      // download flavour.
      expect(res.headers['content-disposition']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns 302 to /{locale}/login when the session is missing', async () => {
    stubRequireApplicantUnauthenticated();

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/id/me/cv/1' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/id/login');
      expect(loadCvForDownloadMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 404 for non-numeric :id without calling the service', async () => {
    requireApplicantMock.mockResolvedValueOnce(fakeSession());

    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/id/me/cv/not-a-number',
      });
      expect(res.statusCode).toBe(404);
      expect(loadCvForDownloadMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unsupported locale before any auth or service work', async () => {
    const app = await buildApp(TEST_CONFIG);
    try {
      const res = await app.inject({ method: 'GET', url: '/fr/me/cv/1' });
      expect(res.statusCode).toBe(404);
      expect(requireApplicantMock).not.toHaveBeenCalled();
      expect(loadCvForDownloadMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
