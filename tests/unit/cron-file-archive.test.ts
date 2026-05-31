/**
 * Unit tests for `src/crons/file-archive.ts` (task 51.1).
 *
 * Validates: Requirements 1.8 (Design §11.2)
 *
 * The cron uses the filesystem and `tar` via `execFile`. All I/O is
 * exercised through the injectable `FileArchiveIo` seam so the suite
 * stays hermetic (no real filesystem, no real tar invocations).
 *
 * Coverage:
 *   1. Missing CV directory → log info, return cleanly (no error thrown).
 *   2. No files older than 24 months → log "nothing to do", return cleanly.
 *   3. Eligible files grouped by quarter → archive created, verified, originals deleted.
 *   4. Verification failure → originals NOT deleted; error logged.
 *   5. Multiple quarters → each archived independently; one failure does not abort others.
 *   6. Summary `file_archive_done` logged with correct counts.
 *   7. `quarterLabel` helper returns correct YYYY-Qn strings.
 *   8. `computeCutoff` returns a date exactly 24 months before `now`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Logger mock — must be registered before importing the cron module.
// ---------------------------------------------------------------------------

const childLogs: Array<{
  level: 'info' | 'error';
  payload: unknown;
  msg: string;
}> = [];

const childLogger = {
  info: vi.fn((payload: unknown, msg: string) => {
    childLogs.push({ level: 'info', payload, msg });
  }),
  error: vi.fn((payload: unknown, msg: string) => {
    childLogs.push({ level: 'error', payload, msg });
  }),
};

vi.mock('../../src/infra/logger.js', () => ({
  logger: {
    child: vi.fn(() => childLogger),
  },
}));

// Import after mocks are registered.
const {
  fileArchive,
  quarterLabel,
  computeCutoff,
  ARCHIVE_THRESHOLD_MONTHS,
} = await import('../../src/crons/file-archive.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a log entry by its structured `event` field. */
function findEvent(event: string): Record<string, unknown> | undefined {
  const entry = childLogs.find(
    (e) => (e.payload as { event?: string }).event === event,
  );
  return entry?.payload as Record<string, unknown> | undefined;
}

/** Build a Date that is `months` months before `now`. */
function monthsAgo(months: number, now: Date = new Date()): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d;
}

/** Minimal stub for FileArchiveIo. */
function makeIo(overrides: Partial<{
  cvDir: () => string;
  archiveDir: () => string;
  ensureDir: (dir: string) => Promise<void>;
  walkCvFiles: () => Promise<string[]>;
  fileMtime: (filePath: string) => Promise<Date>;
  createArchive: (archivePath: string, files: readonly string[]) => Promise<void>;
  verifyArchive: (archivePath: string) => Promise<boolean>;
  deleteFile: (filePath: string) => Promise<void>;
}> = {}) {
  return {
    cvDir: overrides.cvDir ?? (() => '/fake/file_store/cv'),
    archiveDir: overrides.archiveDir ?? (() => '/fake/file_store/archives'),
    ensureDir: overrides.ensureDir ?? vi.fn(async () => {}),
    walkCvFiles: overrides.walkCvFiles ?? vi.fn(async () => []),
    fileMtime: overrides.fileMtime ?? vi.fn(async () => new Date()),
    createArchive: overrides.createArchive ?? vi.fn(async () => {}),
    verifyArchive: overrides.verifyArchive ?? vi.fn(async () => true),
    deleteFile: overrides.deleteFile ?? vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Reset logs before each test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  childLogs.length = 0;
  childLogger.info.mockClear();
  childLogger.error.mockClear();
});

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('quarterLabel', () => {
  it.each([
    [new Date('2023-01-15'), '2023Q1'],
    [new Date('2023-03-31'), '2023Q1'],
    [new Date('2023-04-01'), '2023Q2'],
    [new Date('2023-06-30'), '2023Q2'],
    [new Date('2023-07-01'), '2023Q3'],
    [new Date('2023-09-30'), '2023Q3'],
    [new Date('2023-10-01'), '2023Q4'],
    [new Date('2023-12-31'), '2023Q4'],
  ])('returns %s for %s', (date, expected) => {
    expect(quarterLabel(date)).toBe(expected);
  });
});

describe('computeCutoff', () => {
  it('returns a date exactly ARCHIVE_THRESHOLD_MONTHS months before now', () => {
    const now = new Date('2025-06-15T12:00:00Z');
    const cutoff = computeCutoff(now);
    const expected = new Date('2023-06-15T12:00:00Z');
    expect(cutoff.getTime()).toBe(expected.getTime());
  });

  it('ARCHIVE_THRESHOLD_MONTHS is 24', () => {
    expect(ARCHIVE_THRESHOLD_MONTHS).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// fileArchive — missing CV directory
// ---------------------------------------------------------------------------

describe('fileArchive — missing CV directory (Req 1.8)', () => {
  it('logs info and returns cleanly when cv dir does not exist', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const io = makeIo({
      walkCvFiles: async () => { throw enoentError; },
    });

    await expect(fileArchive(io)).resolves.toBeUndefined();

    const ev = findEvent('file_archive_no_cv_dir');
    expect(ev).toBeDefined();
    expect(ev?.dir).toBe('/fake/file_store/cv');

    // No archive or delete operations.
    expect(io.createArchive).not.toHaveBeenCalled();
    expect(io.deleteFile).not.toHaveBeenCalled();
  });

  it('propagates non-ENOENT errors from walkCvFiles', async () => {
    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const io = makeIo({
      walkCvFiles: async () => { throw permError; },
    });

    await expect(fileArchive(io)).rejects.toThrow('EACCES');
  });
});

// ---------------------------------------------------------------------------
// fileArchive — no eligible files
// ---------------------------------------------------------------------------

describe('fileArchive — no eligible files (Req 1.8)', () => {
  it('logs nothing-to-do when all files are newer than 24 months', async () => {
    const recentFile = '/fake/file_store/cv/2024/01/recent.pdf';
    const io = makeIo({
      walkCvFiles: async () => [recentFile],
      fileMtime: async () => monthsAgo(1), // only 1 month old
    });

    await fileArchive(io);

    const ev = findEvent('file_archive_nothing_to_do');
    expect(ev).toBeDefined();

    expect(io.createArchive).not.toHaveBeenCalled();
    expect(io.deleteFile).not.toHaveBeenCalled();
  });

  it('logs nothing-to-do when cv dir is empty', async () => {
    const io = makeIo({
      walkCvFiles: async () => [],
    });

    await fileArchive(io);

    const ev = findEvent('file_archive_nothing_to_do');
    expect(ev).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fileArchive — archive + verify + delete (Req 1.8)
// ---------------------------------------------------------------------------

describe('fileArchive — archive, verify, delete (Req 1.8)', () => {
  it('creates archive, verifies it, then deletes originals', async () => {
    const oldFile = '/fake/file_store/cv/2022/03/old.pdf';
    const createdArchives: string[] = [];
    const verifiedArchives: string[] = [];
    const deletedFiles: string[] = [];

    const io = makeIo({
      walkCvFiles: async () => [oldFile],
      fileMtime: async () => monthsAgo(30), // 30 months old → eligible
      createArchive: vi.fn(async (archivePath) => {
        createdArchives.push(archivePath);
      }),
      verifyArchive: vi.fn(async (archivePath) => {
        verifiedArchives.push(archivePath);
        return true;
      }),
      deleteFile: vi.fn(async (filePath) => {
        deletedFiles.push(filePath);
      }),
    });

    await fileArchive(io);

    // Archive was created for the correct quarter.
    expect(createdArchives).toHaveLength(1);
    expect(createdArchives[0]).toMatch(/cv-\d{4}Q\d\.tar\.gz$/);

    // Archive was verified.
    expect(verifiedArchives).toHaveLength(1);
    expect(verifiedArchives[0]).toBe(createdArchives[0]);

    // Original file was deleted.
    expect(deletedFiles).toEqual([oldFile]);

    // Summary logged.
    const done = findEvent('file_archive_done');
    expect(done).toMatchObject({
      eligible_files: 1,
      deleted_files: 1,
      quarters: 1,
    });
    expect(typeof done?.duration_ms).toBe('number');
  });

  it('groups files by quarter and creates one archive per quarter', async () => {
    const file2021Q1 = '/fake/file_store/cv/2021/01/a.pdf';
    const file2021Q3 = '/fake/file_store/cv/2021/07/b.pdf';

    const mtimes: Record<string, Date> = {
      [file2021Q1]: new Date('2021-02-15'),
      [file2021Q3]: new Date('2021-08-20'),
    };

    const createdArchives: string[] = [];
    const deletedFiles: string[] = [];

    const io = makeIo({
      walkCvFiles: async () => [file2021Q1, file2021Q3],
      fileMtime: async (filePath) => mtimes[filePath] ?? new Date(),
      createArchive: vi.fn(async (archivePath) => {
        createdArchives.push(archivePath);
      }),
      verifyArchive: vi.fn(async () => true),
      deleteFile: vi.fn(async (filePath) => {
        deletedFiles.push(filePath);
      }),
    });

    await fileArchive(io);

    // Two separate archives, one per quarter.
    expect(createdArchives).toHaveLength(2);
    expect(createdArchives.some((p) => p.includes('2021Q1'))).toBe(true);
    expect(createdArchives.some((p) => p.includes('2021Q3'))).toBe(true);

    // Both originals deleted.
    expect(deletedFiles).toHaveLength(2);
    expect(deletedFiles).toContain(file2021Q1);
    expect(deletedFiles).toContain(file2021Q3);

    const done = findEvent('file_archive_done');
    expect(done).toMatchObject({ eligible_files: 2, deleted_files: 2, quarters: 2 });
  });

  it('passes all files in a quarter to createArchive', async () => {
    const file1 = '/fake/file_store/cv/2020/01/a.pdf';
    const file2 = '/fake/file_store/cv/2020/02/b.pdf';
    const file3 = '/fake/file_store/cv/2020/03/c.pdf';

    const capturedArgs: Array<{ archivePath: string; files: readonly string[] }> = [];

    const io = makeIo({
      walkCvFiles: async () => [file1, file2, file3],
      fileMtime: async () => new Date('2020-02-10'), // all in 2020Q1
      createArchive: vi.fn(async (archivePath, files) => {
        capturedArgs.push({ archivePath, files });
      }),
      verifyArchive: vi.fn(async () => true),
      deleteFile: vi.fn(async () => {}),
    });

    await fileArchive(io);

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0].archivePath).toContain('2020Q1');
    expect(capturedArgs[0].files).toHaveLength(3);
    expect(capturedArgs[0].files).toContain(file1);
    expect(capturedArgs[0].files).toContain(file2);
    expect(capturedArgs[0].files).toContain(file3);
  });
});

// ---------------------------------------------------------------------------
// fileArchive — verification failure (Req 1.8)
// ---------------------------------------------------------------------------

describe('fileArchive — verification failure (Req 1.8)', () => {
  it('does NOT delete originals when verification fails, and logs error', async () => {
    const oldFile = '/fake/file_store/cv/2021/05/old.pdf';

    const io = makeIo({
      walkCvFiles: async () => [oldFile],
      fileMtime: async () => monthsAgo(36),
      createArchive: vi.fn(async () => {}),
      verifyArchive: vi.fn(async () => false), // force failure
      deleteFile: vi.fn(async () => {}),
    });

    await fileArchive(io);

    // Archive was created but originals were NOT deleted.
    expect(io.createArchive).toHaveBeenCalledOnce();
    expect(io.deleteFile).not.toHaveBeenCalled();

    // Error logged.
    const ev = findEvent('file_archive_verify_failed');
    expect(ev).toBeDefined();
    expect(ev?.file_count).toBe(1);

    // Summary shows 0 deleted.
    const done = findEvent('file_archive_done');
    expect(done).toMatchObject({ deleted_files: 0, quarters: 0 });
  });
});

// ---------------------------------------------------------------------------
// fileArchive — per-quarter isolation (Req 1.8)
// ---------------------------------------------------------------------------

describe('fileArchive — per-quarter error isolation (Req 1.8)', () => {
  it('continues archiving remaining quarters when one quarter fails', async () => {
    const file2020Q1 = '/fake/file_store/cv/2020/01/a.pdf';
    const file2021Q1 = '/fake/file_store/cv/2021/01/b.pdf';

    const mtimes: Record<string, Date> = {
      [file2020Q1]: new Date('2020-02-10'),
      [file2021Q1]: new Date('2021-02-10'),
    };

    let callCount = 0;
    const deletedFiles: string[] = [];

    const io = makeIo({
      walkCvFiles: async () => [file2020Q1, file2021Q1],
      fileMtime: async (filePath) => mtimes[filePath] ?? new Date(),
      createArchive: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          // First quarter (2020Q1) fails to create archive.
          throw new Error('tar: disk full');
        }
      }),
      verifyArchive: vi.fn(async () => true),
      deleteFile: vi.fn(async (filePath) => {
        deletedFiles.push(filePath);
      }),
    });

    // Should not throw — per-quarter errors are isolated.
    await expect(fileArchive(io)).resolves.toBeUndefined();

    // The second quarter was still processed.
    expect(io.createArchive).toHaveBeenCalledTimes(2);
    expect(deletedFiles).toContain(file2021Q1);
    expect(deletedFiles).not.toContain(file2020Q1);

    // Error logged for the failed quarter.
    const ev = findEvent('file_archive_quarter_error');
    expect(ev).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fileArchive — ensureDir called before archiving (Req 1.8)
// ---------------------------------------------------------------------------

describe('fileArchive — ensureDir (Req 1.8)', () => {
  it('calls ensureDir on the archives directory before creating any archive', async () => {
    const oldFile = '/fake/file_store/cv/2021/01/old.pdf';
    const ensureDirCalls: string[] = [];

    const io = makeIo({
      walkCvFiles: async () => [oldFile],
      fileMtime: async () => monthsAgo(30),
      ensureDir: vi.fn(async (dir) => {
        ensureDirCalls.push(dir);
      }),
      createArchive: vi.fn(async () => {}),
      verifyArchive: vi.fn(async () => true),
      deleteFile: vi.fn(async () => {}),
    });

    await fileArchive(io);

    expect(ensureDirCalls).toContain('/fake/file_store/archives');
  });
});
