/**
 * Cron task: `file-archive`.
 *
 * Quarterly cold-storage sweep for CV files in `~/file_store/cv/` that are
 * older than 24 months (Design §11.2 — runs day 1 of each month 04:00;
 * Req 1 AC #8 — keep total File_Store inodes under 50,000 by archiving
 * uploads older than 24 months into a single compressed archive per quarter).
 *
 * Pipeline (Req 1.8):
 *   1. Resolve `~/file_store/cv/` via `os.homedir()`. If the directory does
 *      not exist, log info and return cleanly — nothing to archive.
 *   2. Walk the directory recursively and collect every file whose `mtime`
 *      is older than `now - 24 months`.
 *   3. Group the eligible files by quarter (YYYY-Qn based on mtime).
 *   4. For each quarter group, in order:
 *        a. Ensure `~/file_store/archives/` exists.
 *        b. Create `~/file_store/archives/cv-YYYYQn.tar.gz` using
 *           `execFile('tar', ['-czf', archivePath, ...files])`.
 *        c. Verify the archive with `execFile('tar', ['-tzf', archivePath])`.
 *           If verification fails (non-zero exit or empty listing), log error
 *           and skip deletion for this quarter.
 *        d. After successful verification, delete the original files.
 *   5. Emit a summary line.
 *
 * Error contract: per-quarter errors are caught so one bad quarter never
 * aborts the rest of the sweep. Top-level errors (directory walk failure)
 * propagate to `runWithLock`, which records `cron_locks.last_status='error'`.
 *
 * Shell safety (Req 15.4): `execFile` is used (not `exec`) so arguments are
 * passed as an array and never interpolated into a shell string.
 *
 * Validates: Requirements 1.8 (Design §11.2)
 */

import { execFile as execFileCb } from 'node:child_process';
import { readdir, stat, unlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { logger } from '../infra/logger.js';

const execFile = promisify(execFileCb);

const log = logger.child({ cron: 'file-archive' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files older than this many months are eligible for archival (Req 1.8). */
export const ARCHIVE_THRESHOLD_MONTHS = 24;

/** Subdirectory under File_Store containing CV files. */
const CV_SUBDIR = 'cv';

/** Subdirectory under File_Store where quarterly archives are written. */
const ARCHIVE_SUBDIR = 'archives';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the File_Store root. Mirrors `getFileStoreRoot()` from
 * `src/infra/disk.ts` but kept local so this module has no DB dependency.
 */
export function getFileStoreRoot(): string {
  const fromEnv = process.env.FILE_STORE_PATH;
  if (fromEnv && fromEnv.trim() !== '') {
    return path.resolve(fromEnv.trim());
  }
  return path.resolve(os.homedir(), 'file_store');
}

/**
 * Compute the quarter label `YYYYQn` for a given Date.
 * Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec.
 */
export function quarterLabel(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  const quarter = Math.floor(month / 3) + 1;
  return `${year}Q${quarter}`;
}

/**
 * Compute the cutoff Date: `now - ARCHIVE_THRESHOLD_MONTHS` months.
 * Uses the same calendar-month arithmetic as MySQL `NOW() - INTERVAL 24 MONTH`.
 */
export function computeCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_THRESHOLD_MONTHS);
  return cutoff;
}

/**
 * Recursively walk `dir` and return the absolute paths of all regular files.
 * Symlinks are skipped. Throws if `dir` cannot be read (caller handles ENOENT
 * separately before calling this).
 */
async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkFiles(fullPath);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
    // Symlinks intentionally skipped.
  }
  return results;
}

// ---------------------------------------------------------------------------
// IO seam (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Filesystem + process seam. Defaulted to the real implementations below;
 * tests inject stubs to avoid touching the real filesystem or spawning tar.
 */
export interface FileArchiveIo {
  /** Absolute path to the CV directory. */
  cvDir(): string;
  /** Absolute path to the archives directory. */
  archiveDir(): string;
  /** `mkdir -p` the given directory. */
  ensureDir(dir: string): Promise<void>;
  /**
   * Walk `cvDir()` recursively and return all regular file paths.
   * Should throw with `code === 'ENOENT'` when the directory does not exist.
   */
  walkCvFiles(): Promise<string[]>;
  /** Return the mtime of a file. */
  fileMtime(filePath: string): Promise<Date>;
  /**
   * Create a tar.gz archive at `archivePath` containing `files`.
   * Resolves on success, rejects on non-zero exit.
   */
  createArchive(archivePath: string, files: readonly string[]): Promise<void>;
  /**
   * Verify a tar.gz archive by listing its contents.
   * Returns `true` when the listing is non-empty, `false` otherwise.
   * Never throws — a corrupt archive is simply "not verified".
   */
  verifyArchive(archivePath: string): Promise<boolean>;
  /** Delete a single file. Swallows ENOENT (idempotent). */
  deleteFile(filePath: string): Promise<void>;
}

/** Production IO: real filesystem + real tar invocations. */
const defaultIo: FileArchiveIo = {
  cvDir() {
    return path.join(getFileStoreRoot(), CV_SUBDIR);
  },
  archiveDir() {
    return path.join(getFileStoreRoot(), ARCHIVE_SUBDIR);
  },
  async ensureDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  async walkCvFiles() {
    return walkFiles(this.cvDir());
  },
  async fileMtime(filePath) {
    const s = await stat(filePath);
    return s.mtime;
  },
  async createArchive(archivePath, files) {
    // tar -czf <archive> <file1> <file2> ...
    // execFile avoids shell injection (Req 15.4).
    await execFile('tar', ['-czf', archivePath, ...files]);
  },
  async verifyArchive(archivePath) {
    try {
      const { stdout } = await execFile('tar', ['-tzf', archivePath]);
      // A valid archive lists at least one entry.
      return typeof stdout === 'string' && stdout.trim().length > 0;
    } catch {
      return false;
    }
  },
  async deleteFile(filePath) {
    try {
      await unlink(filePath);
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: unknown }).code === 'ENOENT'
      ) {
        return; // Already gone — idempotent.
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Archive and delete one quarter's worth of eligible CV files.
 * Returns the number of files deleted (0 when verification failed).
 */
async function archiveQuarter(
  io: FileArchiveIo,
  archivesDir: string,
  quarter: string,
  files: readonly string[],
): Promise<number> {
  const archivePath = path.join(archivesDir, `cv-${quarter}.tar.gz`);

  // a-b. Create the tar.gz archive.
  await io.createArchive(archivePath, files);

  // c. Verify before deleting.
  const verified = await io.verifyArchive(archivePath);
  if (!verified) {
    log.error(
      {
        event: 'file_archive_verify_failed',
        quarter,
        archive: archivePath,
        file_count: files.length,
      },
      'file-archive: tar verification failed; leaving originals in place',
    );
    return 0;
  }

  // d. Delete originals only after successful verification.
  let deleted = 0;
  for (const filePath of files) {
    try {
      await io.deleteFile(filePath);
      deleted += 1;
    } catch (err) {
      log.error(
        {
          event: 'file_archive_delete_error',
          quarter,
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        },
        'file-archive: failed to delete original file',
      );
    }
  }

  log.info(
    {
      event: 'file_archive_quarter_done',
      quarter,
      archive: archivePath,
      archived_files: files.length,
      deleted_files: deleted,
    },
    'file-archive: quarter archived and originals deleted',
  );
  return deleted;
}

/**
 * Run a single quarterly file-archive pass.
 *
 * The `io` seam defaults to the real filesystem/tar implementation; the
 * dispatcher invokes this with no arguments under `runWithLock`.
 */
export async function fileArchive(io: FileArchiveIo = defaultIo): Promise<void> {
  const startedAt = Date.now();
  const cvDir = io.cvDir();

  // 1. Walk the CV directory. Handle missing directory gracefully.
  let allFiles: string[];
  try {
    allFiles = await io.walkCvFiles();
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      log.info(
        { event: 'file_archive_no_cv_dir', dir: cvDir },
        'file-archive: CV directory does not exist; nothing to archive',
      );
      return;
    }
    throw err;
  }

  log.info(
    { event: 'file_archive_started', total_files: allFiles.length },
    'file-archive: started',
  );

  // 2. Filter files older than 24 months.
  const cutoff = computeCutoff();
  const eligibleByQuarter = new Map<string, string[]>();

  for (const filePath of allFiles) {
    let mtime: Date;
    try {
      mtime = await io.fileMtime(filePath);
    } catch (err) {
      log.error(
        {
          event: 'file_archive_stat_error',
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        },
        'file-archive: could not stat file; skipping',
      );
      continue;
    }

    if (mtime < cutoff) {
      const quarter = quarterLabel(mtime);
      const group = eligibleByQuarter.get(quarter) ?? [];
      group.push(filePath);
      eligibleByQuarter.set(quarter, group);
    }
  }

  const eligibleCount = [...eligibleByQuarter.values()].reduce(
    (sum, arr) => sum + arr.length,
    0,
  );

  log.info(
    {
      event: 'file_archive_eligible',
      eligible_files: eligibleCount,
      quarters: eligibleByQuarter.size,
      cutoff: cutoff.toISOString(),
    },
    'file-archive: eligible files identified',
  );

  if (eligibleByQuarter.size === 0) {
    log.info(
      { event: 'file_archive_nothing_to_do' },
      'file-archive: no files older than 24 months; nothing to archive',
    );
    return;
  }

  // 3. Ensure the archives directory exists.
  const archivesDir = io.archiveDir();
  await io.ensureDir(archivesDir);

  // 4. Archive each quarter, isolating per-quarter failures.
  let totalDeleted = 0;
  let archivedQuarters = 0;

  for (const [quarter, files] of [...eligibleByQuarter.entries()].sort()) {
    try {
      const deleted = await archiveQuarter(io, archivesDir, quarter, files);
      if (deleted > 0) {
        totalDeleted += deleted;
        archivedQuarters += 1;
      }
    } catch (err) {
      log.error(
        {
          event: 'file_archive_quarter_error',
          quarter,
          error: err instanceof Error ? err.message : String(err),
        },
        'file-archive: quarter failed; continuing with remaining quarters',
      );
    }
  }

  // 5. Summary line.
  log.info(
    {
      event: 'file_archive_done',
      total_files: allFiles.length,
      eligible_files: eligibleCount,
      deleted_files: totalDeleted,
      quarters: archivedQuarters,
      duration_ms: Date.now() - startedAt,
    },
    'file-archive: completed',
  );
}

/**
 * Named export alias used by `src/crons/index.ts` dispatcher.
 * The dispatcher already imports `fileArchive` by this name.
 */
export { fileArchive as runFileArchive };
