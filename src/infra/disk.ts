/**
 * File_Store path helpers and free-space quota guard for PT Buana Megah Job Portal.
 *
 * The application stores uploaded CV files on local disk outside `public_html`
 * (Req 1 AC #7) under a single root directory whose location is resolved from
 * the env var `FILE_STORE_PATH` (default `~/file_store` per Design §9).
 *
 * This module is the single source of truth for:
 *   - Where the File_Store lives (`getFileStoreRoot`).
 *   - Whether free space is sufficient before accepting a new upload
 *     (`checkFreeSpace` — drives the 507 Insufficient Storage response).
 *   - How a CV file's relative path is laid out (`cvPath`,
 *     `cvAbsolutePath`, `ensureCvDir`).
 *
 * The path layout is `cv/yyyy/mm/<uuid>.<ext>` where `yyyy` and `mm` come
 * from the current UTC date. The applicant id is part of the helper
 * signature so future overrides (e.g. per-applicant subdir) only need to
 * adjust this one helper, but the value is intentionally kept out of the
 * default layout to match Design §9 verbatim.
 *
 * `uuid` and `ext` are aggressively sanitised inside `cvPath` so a
 * malicious caller can never escape the File_Store root via `..` or by
 * smuggling a path separator. The validators are conservative: only
 * lowercase hex-and-dash for `uuid` and lowercase alphanumeric for `ext`.
 *
 * Validates: Requirements 1.7, 1.8 (Design §9)
 */

import { statfs, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Minimum free space (bytes) before accepting a new CV upload. 100 MiB. */
export const MIN_FREE_BYTES = 100 * 1024 * 1024;

/** Subdirectory under File_Store dedicated to CVs. */
const CV_SUBDIR = 'cv';

/** Allowed CV file extensions per Req 4 AC #6 (mapped from MIME allowlist). */
export const ALLOWED_CV_EXTS = Object.freeze(['pdf', 'doc', 'docx'] as const);
type AllowedCvExt = (typeof ALLOWED_CV_EXTS)[number];

/**
 * Custom error thrown when the File_Store volume does not have enough free
 * space for a new CV upload. Carries `statusCode = 507` so the Fastify
 * error handler in `routes/applicant.ts` can return HTTP 507 Insufficient
 * Storage verbatim (Req 1 AC #8 / Design §9).
 */
export class InsufficientStorageError extends Error {
  /** HTTP status code expected by Fastify reply.code(...). */
  public readonly statusCode = 507;
  /** Bytes currently free on the File_Store volume. */
  public readonly freeBytes: number;
  /** Threshold the upload was rejected against. */
  public readonly minBytes: number;

  constructor(freeBytes: number, minBytes: number) {
    super(
      `insufficient storage on file_store volume: ${freeBytes} bytes free, ${minBytes} required`,
    );
    this.name = 'InsufficientStorageError';
    this.freeBytes = freeBytes;
    this.minBytes = minBytes;
  }
}

/** Result of {@link checkFreeSpace}. */
export interface FreeSpaceCheck {
  /** True when `freeBytes >= minBytes`. */
  ok: boolean;
  /** Bytes available to the running user on the File_Store volume. */
  freeBytes: number;
  /** Threshold used for the comparison (defaults to {@link MIN_FREE_BYTES}). */
  minBytes: number;
}

/**
 * Resolve the File_Store root directory.
 *
 * Order of precedence:
 *   1. `FILE_STORE_PATH` env var (typical in cPanel via Passenger env).
 *   2. `~/file_store` (Design §9 default for the `mycdmkay` cPanel account).
 */
export function getFileStoreRoot(): string {
  const fromEnv = process.env.FILE_STORE_PATH;
  if (fromEnv && fromEnv.trim() !== '') {
    return path.resolve(fromEnv.trim());
  }
  return path.resolve(os.homedir(), 'file_store');
}

/**
 * Resolve the override threshold for the free-space guard.
 *
 * `MIN_FREE_BYTES` env var (positive integer, bytes) takes precedence so
 * operators can tune the limit at deploy time without code changes. Any
 * non-positive / non-numeric value falls back to the {@link MIN_FREE_BYTES}
 * constant.
 */
function resolveMinBytes(): number {
  const raw = process.env.MIN_FREE_BYTES;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return MIN_FREE_BYTES;
}

/**
 * Check that the File_Store volume has at least `minBytes` of free space.
 *
 * Uses `fs.statfs(root)` which reports stats for the filesystem
 * containing `root`. `bavail * bsize` gives the bytes available to the
 * unprivileged user (excludes reserved blocks), which is exactly the
 * number relevant on a shared cPanel account.
 *
 * The handler in `routes/applicant.ts` calls this before accepting a
 * multipart body and returns HTTP 507 when `ok` is false (Req 1 AC #8,
 * Design §9).
 */
export async function checkFreeSpace(): Promise<FreeSpaceCheck> {
  const minBytes = resolveMinBytes();
  const root = getFileStoreRoot();
  const stats = await statfs(root);
  // Prefer `bavail` (available to non-root) over `bfree` (total free
  // including reserved blocks). Some shared hosts return BigInt; coerce
  // defensively to a Number we can compare against `minBytes`.
  const blockSize = Number(stats.bsize);
  const blocksAvailable = Number(stats.bavail);
  const freeBytes = blockSize * blocksAvailable;
  return {
    ok: freeBytes >= minBytes,
    freeBytes,
    minBytes,
  };
}

/**
 * Throw {@link InsufficientStorageError} (HTTP 507) when the File_Store
 * volume has dropped below the configured minimum free space. Returns
 * the {@link FreeSpaceCheck} on success so callers may log the headroom
 * for observability.
 */
export async function assertFreeSpace(): Promise<FreeSpaceCheck> {
  const result = await checkFreeSpace();
  if (!result.ok) {
    throw new InsufficientStorageError(result.freeBytes, result.minBytes);
  }
  return result;
}

/** Match only lowercase hex with optional dashes — covers UUID v4 / v7. */
const UUID_PATTERN = /^[0-9a-f-]+$/;
/** Match only lowercase alphanumerics — extension whitelist enforced separately. */
const EXT_PATTERN = /^[a-z0-9]+$/;

/** Sanitise a candidate uuid; throws when invalid (caller bug, not user input). */
function sanitiseUuid(uuid: string): string {
  const lowered = uuid.toLowerCase();
  if (!UUID_PATTERN.test(lowered) || lowered.length === 0 || lowered.length > 64) {
    throw new Error(`invalid uuid for cvPath: ${JSON.stringify(uuid)}`);
  }
  return lowered;
}

/**
 * Sanitise a candidate file extension against the CV allowlist
 * `{pdf, doc, docx}` (Req 4 AC #6).
 *
 * Strips a leading `.` so callers can pass either `pdf` or `.pdf`
 * interchangeably, lowercases, and rejects anything not in
 * {@link ALLOWED_CV_EXTS}.
 */
function sanitiseExt(ext: string): AllowedCvExt {
  const trimmed = ext.replace(/^\.+/, '').toLowerCase();
  if (!EXT_PATTERN.test(trimmed) || trimmed.length === 0 || trimmed.length > 8) {
    throw new Error(`invalid extension for cvPath: ${JSON.stringify(ext)}`);
  }
  if (!(ALLOWED_CV_EXTS as readonly string[]).includes(trimmed)) {
    throw new Error(`invalid extension for cvPath: ${JSON.stringify(ext)}`);
  }
  return trimmed as AllowedCvExt;
}

/** Format the current month as `mm` zero-padded. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Build the File_Store-relative path for a freshly uploaded CV.
 *
 * Layout: `cv/yyyy/mm/<uuid>.<ext>` where `yyyy` and `mm` come from the
 * current UTC date. Always returns a POSIX-style path with forward
 * slashes regardless of the OS, since the value is also stored verbatim
 * in `applicant_cv_files.relative_path` and used in URLs.
 *
 * `applicantId` is accepted for future-proofing (per-applicant
 * subdirectories) but is not part of the current layout.
 */
export function cvPath(
  applicantId: number,
  uuid: string,
  ext: string,
  now: Date = new Date(),
): string {
  // `applicantId` is intentionally unused in the current path layout (Design
  // §9 keeps year/month grouping); accepted in the signature for forward
  // compatibility so future per-applicant subdirectories don't break callers.
  void applicantId;
  const safeUuid = sanitiseUuid(uuid);
  const safeExt = sanitiseExt(ext);
  const yyyy = String(now.getUTCFullYear());
  const mm = pad2(now.getUTCMonth() + 1);
  return `${CV_SUBDIR}/${yyyy}/${mm}/${safeUuid}.${safeExt}`;
}

/**
 * Resolve a File_Store-relative CV path (as produced by {@link cvPath})
 * to an absolute path on disk. Defends against caller-side traversal by
 * verifying the resolved absolute path stays under the File_Store root.
 */
export function cvAbsolutePath(relativePath: string): string {
  const root = getFileStoreRoot();
  const absolute = path.resolve(root, relativePath);
  // Guard against a caller passing `../...` or an absolute path that
  // escapes the root. `path.relative` returning a value that starts with
  // `..` (or that is itself absolute) means the resolved path is outside
  // `root` — refuse to compute it.
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`relative path escapes File_Store root: ${relativePath}`);
  }
  return absolute;
}

/**
 * Make sure the parent directory for a fresh CV upload exists, then
 * return the absolute path the caller should write to.
 *
 * Equivalent to `mkdir -p $(dirname target)` followed by returning
 * `target`. Idempotent: subsequent calls in the same `yyyy/mm` window
 * are cheap because `mkdir` with `recursive: true` is a no-op on an
 * existing directory.
 */
export async function ensureCvDir(
  applicantId: number,
  uuid: string,
  ext: string,
  now: Date = new Date(),
): Promise<string> {
  const relative = cvPath(applicantId, uuid, ext, now);
  const absolute = cvAbsolutePath(relative);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  return absolute;
}

/**
 * Build the absolute path of a temporary upload buffer file.
 *
 * Per Design §9 the multipart handler streams an upload to
 * `~/tmp/uploads/<uuid>.tmp` first, runs MIME sniffing, then `rename`s
 * the file into its final `cv/yyyy/mm/...` slot. Living under
 * `os.homedir()` keeps the temp directory on the same volume as the
 * File_Store so `rename` is atomic.
 */
export function tmpUploadPath(uuid: string): string {
  const safeUuid = sanitiseUuid(uuid);
  return path.resolve(os.homedir(), 'tmp', 'uploads', `${safeUuid}.tmp`);
}

/**
 * `mkdir -p` shim. Used by upload handlers that need to make sure the
 * temp directory exists before streaming, and by retention/archival
 * jobs that may run before any user upload has created the directory.
 *
 * Mode `0700` matches the File_Store root mode (Design §9) so that
 * uploaded CVs are never world-readable on a shared host.
 */
export async function ensureDir(target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
}

/**
 * Best-effort `unlink`. Swallows `ENOENT` so retention pruning is
 * idempotent (re-running the prune cron after a crash should not abort
 * because the file was already removed). Any other error is rethrown
 * so genuine I/O failures still surface.
 */
export async function safeUnlink(target: string): Promise<boolean> {
  try {
    await unlink(target);
    return true;
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw err;
  }
}
