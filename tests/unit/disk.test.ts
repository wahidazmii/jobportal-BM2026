/**
 * Unit tests for `src/infra/disk.ts` (task 17.2).
 *
 * Validates: Requirements 1.7, 1.8 (Design §9)
 *
 * Coverage:
 *   - `checkFreeSpace` returns ok=true when the volume reports more than
 *     the 100 MiB threshold and ok=false when it reports less.
 *   - `cvPath` lays files out under `cv/yyyy/mm/<uuid>.<ext>` and rejects
 *     any input that smells like path traversal.
 *   - `cvAbsolutePath` refuses to resolve paths that escape the File_Store
 *     root.
 *
 * `fs/promises.statfs` is mocked so the suite stays hermetic and works
 * across Linux/macOS/Windows runners.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const statfsMock = vi.fn();
const mkdirMock = vi.fn().mockResolvedValue(undefined);
const unlinkMock = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  return {
    ...actual,
    statfs: statfsMock,
    mkdir: mkdirMock,
    unlink: unlinkMock,
  };
});

const {
  ALLOWED_CV_EXTS,
  InsufficientStorageError,
  MIN_FREE_BYTES,
  assertFreeSpace,
  checkFreeSpace,
  cvAbsolutePath,
  cvPath,
  ensureCvDir,
  ensureDir,
  getFileStoreRoot,
  safeUnlink,
  tmpUploadPath,
} = await import('../../src/infra/disk.js');

const ORIGINAL_FILE_STORE_PATH = process.env.FILE_STORE_PATH;
const ORIGINAL_MIN_FREE_BYTES = process.env.MIN_FREE_BYTES;

beforeEach(() => {
  statfsMock.mockReset();
  mkdirMock.mockClear();
  unlinkMock.mockReset();
  unlinkMock.mockResolvedValue(undefined);
  delete process.env.FILE_STORE_PATH;
  delete process.env.MIN_FREE_BYTES;
});

afterEach(() => {
  if (ORIGINAL_FILE_STORE_PATH === undefined) {
    delete process.env.FILE_STORE_PATH;
  } else {
    process.env.FILE_STORE_PATH = ORIGINAL_FILE_STORE_PATH;
  }
  if (ORIGINAL_MIN_FREE_BYTES === undefined) {
    delete process.env.MIN_FREE_BYTES;
  } else {
    process.env.MIN_FREE_BYTES = ORIGINAL_MIN_FREE_BYTES;
  }
});

/** Build a minimal `StatsFs`-shaped object for the mock. */
function makeStatfs(bsize: number, bavail: number): {
  type: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
} {
  return {
    type: 0,
    bsize,
    blocks: bavail * 2,
    bfree: bavail,
    bavail,
    files: 0,
    ffree: 0,
  };
}

describe('MIN_FREE_BYTES', () => {
  it('equals 100 MiB per Design §9', () => {
    expect(MIN_FREE_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('getFileStoreRoot', () => {
  it('honours FILE_STORE_PATH when set', () => {
    process.env.FILE_STORE_PATH = '/srv/custom/file_store';
    expect(getFileStoreRoot()).toBe(path.resolve('/srv/custom/file_store'));
  });

  it('defaults to ~/file_store', () => {
    const expected = path.resolve(os.homedir(), 'file_store');
    expect(getFileStoreRoot()).toBe(expected);
  });
});

describe('checkFreeSpace', () => {
  it('returns ok=true when free space exceeds the threshold', async () => {
    // 4096 * 60_000 = ~234 MiB, well above the 100 MiB threshold.
    statfsMock.mockResolvedValueOnce(makeStatfs(4096, 60_000));

    const result = await checkFreeSpace();

    expect(statfsMock).toHaveBeenCalledTimes(1);
    expect(statfsMock).toHaveBeenCalledWith(getFileStoreRoot());
    expect(result.ok).toBe(true);
    expect(result.minBytes).toBe(MIN_FREE_BYTES);
    expect(result.freeBytes).toBe(4096 * 60_000);
  });

  it('returns ok=false when free space is below the threshold', async () => {
    // 4096 * 1000 = ~4 MiB, well below 100 MiB.
    statfsMock.mockResolvedValueOnce(makeStatfs(4096, 1000));

    const result = await checkFreeSpace();

    expect(result.ok).toBe(false);
    expect(result.freeBytes).toBe(4096 * 1000);
    expect(result.minBytes).toBe(MIN_FREE_BYTES);
  });

  it('returns ok=false when free space exactly equals threshold minus one byte', async () => {
    // bsize=1, bavail = MIN_FREE_BYTES - 1
    statfsMock.mockResolvedValueOnce(makeStatfs(1, MIN_FREE_BYTES - 1));

    const result = await checkFreeSpace();

    expect(result.ok).toBe(false);
    expect(result.freeBytes).toBe(MIN_FREE_BYTES - 1);
  });

  it('returns ok=true when free space exactly equals threshold', async () => {
    statfsMock.mockResolvedValueOnce(makeStatfs(1, MIN_FREE_BYTES));

    const result = await checkFreeSpace();

    expect(result.ok).toBe(true);
    expect(result.freeBytes).toBe(MIN_FREE_BYTES);
  });

  it('respects the MIN_FREE_BYTES env override', async () => {
    process.env.MIN_FREE_BYTES = '2048';
    // 1 KiB free, threshold 2 KiB → not ok.
    statfsMock.mockResolvedValueOnce(makeStatfs(1024, 1));

    const result = await checkFreeSpace();

    expect(result.ok).toBe(false);
    expect(result.minBytes).toBe(2048);
    expect(result.freeBytes).toBe(1024);
  });
});

describe('cvPath layout', () => {
  it('uses cv/yyyy/mm/<uuid>.<ext> with the supplied date', () => {
    const date = new Date(Date.UTC(2025, 2, 7)); // March 2025
    const result = cvPath(42, '550e8400-e29b-41d4-a716-446655440000', 'pdf', date);
    expect(result).toBe('cv/2025/03/550e8400-e29b-41d4-a716-446655440000.pdf');
  });

  it('zero-pads the month for January', () => {
    const date = new Date(Date.UTC(2024, 0, 15));
    const result = cvPath(1, 'aabbcc', 'pdf', date);
    expect(result).toBe('cv/2024/01/aabbcc.pdf');
  });

  it('zero-pads the month for December', () => {
    const date = new Date(Date.UTC(2024, 11, 31));
    const result = cvPath(1, 'aabbcc', 'pdf', date);
    expect(result).toBe('cv/2024/12/aabbcc.pdf');
  });

  it('lowercases the extension and strips a leading dot', () => {
    const date = new Date(Date.UTC(2025, 0, 1));
    expect(cvPath(1, 'aabbcc', '.PDF', date)).toBe('cv/2025/01/aabbcc.pdf');
    expect(cvPath(1, 'aabbcc', 'DOCX', date)).toBe('cv/2025/01/aabbcc.docx');
  });
});

describe('cvPath sanitisation', () => {
  const validDate = new Date(Date.UTC(2025, 0, 1));

  it.each([
    '../etc/passwd',
    '..',
    'foo/bar',
    'foo\\bar',
    'foo bar',
    'foo.txt',
    '',
  ])('rejects malicious uuid %j', (badUuid) => {
    expect(() => cvPath(1, badUuid, 'pdf', validDate)).toThrow(/invalid uuid/);
  });

  it.each([
    '../sh',
    'pdf;rm',
    'p df',
    '',
    'php.exe',
    'p/d/f',
    'a'.repeat(20),
  ])('rejects malicious extension %j', (badExt) => {
    expect(() => cvPath(1, 'aabbcc', badExt, validDate)).toThrow(/invalid extension/);
  });
});

describe('cvAbsolutePath', () => {
  it('joins a sanitised relative path under the File_Store root', () => {
    process.env.FILE_STORE_PATH = '/srv/file_store';
    const absolute = cvAbsolutePath('cv/2025/01/abc.pdf');
    expect(absolute).toBe(path.resolve('/srv/file_store/cv/2025/01/abc.pdf'));
  });

  it('refuses paths that escape the root via traversal segments', () => {
    process.env.FILE_STORE_PATH = '/srv/file_store';
    expect(() => cvAbsolutePath('../../etc/passwd')).toThrow(/escapes/);
  });

  it('refuses absolute relative paths', () => {
    process.env.FILE_STORE_PATH = '/srv/file_store';
    // On POSIX `/etc/passwd` is absolute; on Windows resolve still treats it as
    // root-relative — either way the safety check rejects it.
    expect(() => cvAbsolutePath('/etc/passwd')).toThrow(/escapes/);
  });
});

describe('ensureCvDir', () => {
  it('mkdirs the parent directory and returns the absolute target path', async () => {
    process.env.FILE_STORE_PATH = '/srv/file_store';
    const date = new Date(Date.UTC(2025, 5, 2)); // June 2025

    const target = await ensureCvDir(99, 'deadbeef-cafe', 'pdf', date);

    expect(target).toBe(
      path.resolve('/srv/file_store/cv/2025/06/deadbeef-cafe.pdf'),
    );
    expect(mkdirMock).toHaveBeenCalledTimes(1);
    const [dir, opts] = mkdirMock.mock.calls[0] as [string, { recursive: boolean; mode: number }];
    expect(dir).toBe(path.resolve('/srv/file_store/cv/2025/06'));
    expect(opts).toEqual({ recursive: true, mode: 0o700 });
  });
});

describe('ALLOWED_CV_EXTS', () => {
  it('matches the Req 4 AC #6 MIME allowlist mapping', () => {
    expect([...ALLOWED_CV_EXTS]).toEqual(['pdf', 'doc', 'docx']);
  });

  it.each(['pdf', 'doc', 'docx'])('cvPath accepts %s', (ext) => {
    const date = new Date(Date.UTC(2025, 0, 1));
    expect(cvPath(1, 'aabbcc', ext, date)).toMatch(new RegExp(`\\.${ext}$`));
  });

  it.each(['exe', 'jpg', 'zip', 'sh', 'php'])(
    'cvPath rejects disallowed extension %j',
    (ext) => {
      const date = new Date(Date.UTC(2025, 0, 1));
      expect(() => cvPath(1, 'aabbcc', ext, date)).toThrow(/invalid extension/);
    },
  );
});

describe('assertFreeSpace', () => {
  it('returns the free-space report when above threshold', async () => {
    statfsMock.mockResolvedValueOnce(makeStatfs(4096, 60_000));

    const result = await assertFreeSpace();

    expect(result.ok).toBe(true);
    expect(result.freeBytes).toBe(4096 * 60_000);
  });

  it('throws InsufficientStorageError carrying statusCode 507', async () => {
    statfsMock.mockResolvedValueOnce(makeStatfs(1, MIN_FREE_BYTES - 1));

    await expect(assertFreeSpace()).rejects.toBeInstanceOf(InsufficientStorageError);

    statfsMock.mockResolvedValueOnce(makeStatfs(1, MIN_FREE_BYTES - 1));
    try {
      await assertFreeSpace();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientStorageError);
      const ise = err as InstanceType<typeof InsufficientStorageError>;
      expect(ise.statusCode).toBe(507);
      expect(ise.freeBytes).toBe(MIN_FREE_BYTES - 1);
      expect(ise.minBytes).toBe(MIN_FREE_BYTES);
      expect(ise.name).toBe('InsufficientStorageError');
    }
  });
});

describe('tmpUploadPath', () => {
  it('lives under ~/tmp/uploads with a .tmp suffix', () => {
    const target = tmpUploadPath('deadbeef-cafe');
    expect(target).toBe(
      path.resolve(os.homedir(), 'tmp', 'uploads', 'deadbeef-cafe.tmp'),
    );
  });

  it('refuses unsafe uuid input', () => {
    expect(() => tmpUploadPath('../etc/passwd')).toThrow(/invalid uuid/);
    expect(() => tmpUploadPath('foo bar')).toThrow(/invalid uuid/);
  });
});

describe('ensureDir', () => {
  it('mkdir -p with mode 0700', async () => {
    await ensureDir('/srv/file_store/cv/2025/06');
    expect(mkdirMock).toHaveBeenCalledTimes(1);
    expect(mkdirMock).toHaveBeenCalledWith('/srv/file_store/cv/2025/06', {
      recursive: true,
      mode: 0o700,
    });
  });
});

describe('safeUnlink', () => {
  it('returns true when the file is removed', async () => {
    unlinkMock.mockResolvedValueOnce(undefined);
    await expect(safeUnlink('/tmp/foo.tmp')).resolves.toBe(true);
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/foo.tmp');
  });

  it('returns false on ENOENT (idempotent prune)', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    unlinkMock.mockRejectedValueOnce(enoent);
    await expect(safeUnlink('/tmp/missing.tmp')).resolves.toBe(false);
  });

  it('rethrows non-ENOENT errors', async () => {
    const eperm = Object.assign(new Error('denied'), { code: 'EPERM' });
    unlinkMock.mockRejectedValueOnce(eperm);
    await expect(safeUnlink('/tmp/locked.tmp')).rejects.toMatchObject({
      code: 'EPERM',
    });
  });
});
