/**
 * Applicant CV file service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 17.1 (upload pipeline) and task 17.3
 *           (download endpoint — owner branch wired). The HR /
 *           Super_Admin Application-reference branch of 17.3's
 *           authorization rule lands with task 25.1 (applications
 *           table) and task 30 (admin download route).
 * Design  : §9 (CV upload pipeline + download endpoint)
 * Validates: Requirements 4.5, 4.6, 4.7, 4.8, 15.5, 15.6
 *
 * Public surface (currently):
 *   - `CvFileRecord`                        — typed `applicant_cv_files`
 *                                             row used by the download
 *                                             route.
 *   - `CvDownloadDescriptor`                — narrow shape returned by
 *                                             `loadCvForDownload`: the
 *                                             absolute on-disk path, the
 *                                             stored MIME, and the
 *                                             original filename. The
 *                                             route uses these to set
 *                                             `Content-Type` and
 *                                             `Content-Disposition`.
 *   - `loadCvForOwner(userId, id)`          — load a CV row scoped to
 *                                             its owner. Returns `null`
 *                                             when the row is missing
 *                                             or owned by a different
 *                                             applicant.
 *   - `loadCvForDownload(viewerUserId,      — authorization-aware
 *                        viewerRole,           wrapper used by the
 *                        cvFileId)`            download route. Returns
 *                                             a `CvDownloadDescriptor`
 *                                             only when the viewer is
 *                                             the file owner — or, in
 *                                             the future, an HR /
 *                                             Super_Admin user with an
 *                                             `applications` row
 *                                             referencing the CV. The
 *                                             HR branch is currently
 *                                             stubbed: it returns
 *                                             `null` until task 25.1
 *                                             ships the `applications`
 *                                             table.
 *   - `processCvUpload({ userId,            — Streams a multipart upload
 *                        multipartFile })`     into the temp slot,
 *                                             validates size + magic
 *                                             bytes, moves it into the
 *                                             File_Store, persists the
 *                                             new row as the active CV,
 *                                             and prunes any history
 *                                             past the 3-version cap.
 *                                             Throws
 *                                             `InsufficientStorageError`
 *                                             (507),
 *                                             `FileTooLargeError`
 *                                             (413), or
 *                                             `MimeMismatchError`
 *                                             (415) on the relevant
 *                                             rejection paths so the
 *                                             route handler can map
 *                                             each case to an HTTP
 *                                             status verbatim.
 *   - `listCvsForOwner(userId)`             — owner-scoped list of
 *                                             every CV row, newest
 *                                             first, used by the
 *                                             upload form view.
 *   - `MAX_CV_BYTES` / `MAX_CV_HISTORY` /   — public knobs the route
 *     `ALLOWED_CV_MIMES` / `MIME_TO_EXT`     and tests share.
 *
 * Why this lives in `modules/applicant/` rather than `modules/files/`:
 *   - The CV file model is owned by the Applicant domain — every CV row
 *     is tied to an `applicants(user_id)` via the FK. Co-locating the
 *     service with the other applicant CRUD modules keeps the boundary
 *     consistent and matches Design §6 / §9.
 *
 * Why ownership is enforced in SQL rather than in the route:
 *   - The `WHERE id=? AND applicant_user_id=?` clause is the same
 *     defence used by every other applicant-scoped read in this codebase
 *     (`findEducationById`, `findExperienceById`). A row that is not
 *     owned by the authenticated user simply does not match — the
 *     request can never see it. Doing the check in the SQL means an
 *     IDOR attempt collapses to "not found" without requiring a second
 *     round-trip to the row, and the route layer cannot accidentally
 *     skip it.
 *
 * Why the absolute path goes through `cvAbsolutePath`:
 *   - `applicant_cv_files.storage_path` is a File_Store-relative path
 *     written by the upload pipeline (task 17.1). It is sanitised at
 *     write-time, but a defensive resolution at read-time is still
 *     mandatory: the column is `VARCHAR(255)` and any future bug in
 *     the writer (or a manual repair gone wrong) could store a
 *     traversal payload like `../etc/passwd`. `cvAbsolutePath`
 *     re-checks that the resolved absolute path stays under the
 *     File_Store root and throws otherwise — we treat that throw as
 *     `null` so the download collapses to a 404 instead of a 500.
 *
 * Future work (task 17.3 deferred branch and tasks 25.1 / 30):
 *   - The HR / Super_Admin branch of `loadCvForDownload` requires the
 *     `applications` table (task 25.1) and the admin download route
 *     (task 30 area: `GET /admin/applications/:appId/cv`). When those
 *     land, swap the stub `hrCanAccessViaApplication` for a real
 *     `EXISTS` lookup against `applications`. A separate
 *     `GET /admin/applications/:appId/cv` route will then call
 *     `loadCvForDownload` with `viewerRole='HR'` (or `Super_Admin`).
 */

import { createWriteStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { ulid } from 'ulid';
import { fileTypeFromBuffer } from 'file-type';

import {
  assertFreeSpace,
  cvAbsolutePath,
  cvPath,
  ensureCvDir,
  ensureDir,
  safeUnlink,
  tmpUploadPath,
} from '../../infra/disk.js';
import {
  query,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import type { UserRole } from '../../infra/session-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Public shape of a single `applicant_cv_files` row, normalised so
 * callers do not have to deal with mysql2's loose return types
 * (`number | string` for `BIGINT UNSIGNED`, `Date` for DATETIME, etc.).
 *
 * The columns mirror `migrations/0002_profile.sql`:
 *   - `storage_path`      File_Store-relative path produced by `cvPath`.
 *                          Always POSIX-style with forward slashes; the
 *                          download handler resolves it via
 *                          `cvAbsolutePath` before opening a stream.
 *   - `original_filename`  Filename the user uploaded the file under.
 *                          Reused as the suggested filename in the
 *                          `Content-Disposition: attachment; filename=…`
 *                          response header — but the route MUST sanitise
 *                          it (strip CR/LF/`"`) before quoting because
 *                          the column is unconstrained CHAR(255).
 *   - `mime_type`          MIME the upload pipeline confirmed via magic
 *                          bytes (`pdf` / `msword` / `wordprocessingml`).
 *                          Used as the `Content-Type` of the response.
 *   - `size_bytes`         Stored for capacity accounting / display;
 *                          the handler reads the file directly from
 *                          disk so this is informational only.
 *   - `is_active`          Whether this row represents the applicant's
 *                          currently-active CV. Inactive rows remain
 *                          downloadable by the owner (audit / undo
 *                          flows in Design §9), so the download route
 *                          does not filter on this column.
 */
export interface CvFileRecord {
  readonly id: number;
  readonly applicant_user_id: number;
  readonly storage_path: string;
  readonly original_filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly is_active: boolean;
  readonly uploaded_at: Date;
}

/** Row shape returned by mysql2 for the SELECT below. */
interface CvFileRow extends RowDataPacket {
  id: number | string;
  applicant_user_id: number | string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number | string;
  is_active: number;
  uploaded_at: Date | string;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Scoped-to-owner lookup: a row is only returned when both `id` and
 * `applicant_user_id` match. The composite KEY
 * `idx_cv_applicant_active(applicant_user_id, is_active, uploaded_at)`
 * does not cover this lookup directly, but the table's PRIMARY KEY on
 * `id` is used and the `applicant_user_id` filter is applied as a
 * residual predicate — fast enough at the row counts we expect (≤3
 * active + a small history per applicant).
 */
const SELECT_CV_FOR_OWNER_SQL =
  'SELECT id, applicant_user_id, storage_path, original_filename, ' +
  '       mime_type, size_bytes, is_active, uploaded_at ' +
  'FROM applicant_cv_files ' +
  'WHERE id = ? AND applicant_user_id = ? ' +
  'LIMIT 1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(row: CvFileRow): CvFileRecord {
  // mysql2 returns DATETIME as `Date`. Coerce defensively if a future
  // driver tweak hands us an ISO string instead so the public type
  // contract holds.
  const uploadedAt =
    row.uploaded_at instanceof Date
      ? row.uploaded_at
      : new Date(row.uploaded_at);
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    storage_path: row.storage_path,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    is_active: row.is_active === 1,
    uploaded_at: uploadedAt,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Load a single CV row scoped to its owner.
 *
 * Returns the {@link CvFileRecord} when the row exists *and* belongs to
 * `userId`; returns `null` when either the id is unknown or it is
 * owned by a different applicant. The two cases collapse to the same
 * `null` so the API never leaks the existence of another user's row.
 *
 * The download route (task 17.3) calls this helper inside the owner
 * branch of its authorization rule. The HR/Super_Admin branch (which
 * authorises a download via an `applications.cv_file_id` reference)
 * lands later when task 25.1 adds the `applications` table.
 */
export async function loadCvForOwner(
  userId: number,
  id: number,
): Promise<CvFileRecord | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await query<CvFileRow[]>(SELECT_CV_FOR_OWNER_SQL, [id, userId]);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Lightweight existence check: does the applicant have at least one
 * `applicant_cv_files` row marked `is_active=1`?
 *
 * Used by the dashboard / completeness routes (task 18.1) so the banner
 * can fold the "active CV" slot into its percentage without loading the
 * whole row. Returns `false` for invalid `userId` so the caller does
 * not have to validate up-front. The composite KEY
 * `idx_cv_applicant_active(applicant_user_id, is_active, uploaded_at)`
 * already covers this lookup, so the query is index-only.
 */
const COUNT_ACTIVE_CV_SQL =
  'SELECT 1 FROM applicant_cv_files ' +
  'WHERE applicant_user_id = ? AND is_active = 1 ' +
  'LIMIT 1';

interface CountActiveCvRow extends RowDataPacket {
  1: number;
}

export async function hasActiveCvForOwner(userId: number): Promise<boolean> {
  if (!Number.isInteger(userId) || userId <= 0) return false;
  const rows = await query<CountActiveCvRow[]>(COUNT_ACTIVE_CV_SQL, [userId]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Authorization-aware download wrapper
// ---------------------------------------------------------------------------

/**
 * Narrow shape returned by {@link loadCvForDownload}. Carries only the
 * three fields the download route needs to stream the file:
 *   - `absolutePath`       — the resolved on-disk path under
 *                            File_Store, already verified by
 *                            `cvAbsolutePath` to live under the root.
 *   - `mimeType`            — the stored MIME (`application/pdf`,
 *                            `application/msword`,
 *                            `application/vnd.openxmlformats-officedocument.wordprocessingml.document`).
 *                            Used as the response `Content-Type`.
 *   - `originalFilename`    — the upload-time filename. The route MUST
 *                            sanitise it before quoting in the
 *                            `Content-Disposition` header (strip
 *                            CR/LF/`"`, fall back to `cv.<ext>` when
 *                            the cleaned value is empty).
 *
 * We deliberately do NOT expose the full {@link CvFileRecord} here:
 * the route only needs the three fields above, and narrowing the
 * surface keeps "what an HR-side caller is allowed to see" decoupled
 * from "what the owner is allowed to see" once the HR branch lands.
 */
export interface CvDownloadDescriptor {
  readonly absolutePath: string;
  readonly mimeType: string;
  readonly originalFilename: string;
}

/**
 * Roles allowed to access another applicant's CV via an Application
 * reference, per Design §9 / Req 15.6. `Department_Head` is excluded
 * by design: a hiring manager looks at applications scoped to their
 * department, but the CV download URL itself is HR-curated.
 */
const APPLICATION_REVIEW_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'HR',
  'Super_Admin',
]);

/**
 * Stub for the HR / Super_Admin authorization branch.
 *
 * The real implementation will run an `EXISTS` query against the
 * `applications` table (task 25.1) of the form:
 *
 *   SELECT 1 FROM applications
 *   WHERE cv_file_id = ?
 *   LIMIT 1
 *
 * Until that table ships, this helper returns `false` so the route
 * collapses HR/Super_Admin requests to 404. That is the correct
 * temporary behaviour: we never want to leak another user's CV via a
 * privileged role before the audit trail / scoping that justifies
 * the access (task 30 area) is in place.
 *
 * The dependency is documented at the call site so the follow-up PR
 * has a single line to flip.
 */
async function hrCanAccessViaApplication(
  _viewerUserId: number,
  _viewerRole: UserRole,
  _cvFileId: number,
): Promise<boolean> {
  // TODO(task 25.1 + task 30): replace with
  //   const rows = await query<RowDataPacket[]>(
  //     'SELECT 1 FROM applications WHERE cv_file_id = ? LIMIT 1',
  //     [cvFileId],
  //   );
  //   return rows.length > 0;
  // The `viewerUserId` parameter will become relevant once
  // Department_Head scoping is wired (task 39.2): an HR user with a
  // restricted department list can only download CVs whose backing
  // application's job lives in their assigned departments. For now
  // the stub returns false so the privileged branch is inert.
  void _viewerUserId;
  void _viewerRole;
  void _cvFileId;
  return false;
}

/**
 * Load the bytes-level descriptor needed to stream a CV download,
 * applying the authorization rule from Design §9 / Req 15.6.
 *
 * Authorization (in order):
 *   1. The viewer is the file owner — by far the hottest path. We use
 *      {@link loadCvForOwner} so the SQL itself enforces the
 *      `applicant_user_id` check; an IDOR attempt collapses to
 *      "row not found" without an extra round-trip.
 *   2. The viewer holds an HR or Super_Admin role AND there is an
 *      `applications` row referencing this `cv_file_id`. This branch
 *      is currently stubbed (`hrCanAccessViaApplication` returns
 *      `false`) — see the function's docstring. The real lookup lands
 *      with task 25.1 / task 30.
 *   3. Anything else → `null` (treated as 404 by the route, never as
 *      403, because a 403 would confirm the row exists).
 *
 * Returns `null` whenever:
 *   - The cv_file_id is unknown.
 *   - The viewer is not authorized.
 *   - The stored `storage_path` resolves outside the File_Store root
 *     (`cvAbsolutePath` throws — see file header note). We swallow the
 *     throw and return `null` so the route returns 404 rather than
 *     500: the user never sees the corrupt path, and the upload
 *     pipeline's writer-side sanitisation remains the canonical
 *     defence.
 */
export async function loadCvForDownload(
  viewerUserId: number,
  viewerRole: UserRole,
  cvFileId: number,
): Promise<CvDownloadDescriptor | null> {
  if (!Number.isInteger(viewerUserId) || viewerUserId <= 0) return null;
  if (!Number.isInteger(cvFileId) || cvFileId <= 0) return null;

  // Step 1: owner-scoped lookup. The hot path: most CV downloads come
  // from the applicant viewing their own dashboard.
  const ownerRow = await loadCvForOwner(viewerUserId, cvFileId);
  if (ownerRow !== null) {
    return toDescriptor(ownerRow);
  }

  // Step 2: HR / Super_Admin via Application reference.
  if (APPLICATION_REVIEW_ROLES.has(viewerRole)) {
    const allowed = await hrCanAccessViaApplication(
      viewerUserId,
      viewerRole,
      cvFileId,
    );
    if (!allowed) {
      return null;
    }
    // Re-load the row without the owner predicate so HR can read a CV
    // they did not upload. We still keep the load behind an
    // application-existence check (the line above) so HR cannot
    // enumerate every CV id without an explicit application reference.
    const rows = await query<CvFileRow[]>(
      // SAFE: parameterised, ownership check upstream via
      // hrCanAccessViaApplication. Same column shape as the owner
      // SELECT so `rowToRecord` can be reused.
      'SELECT id, applicant_user_id, storage_path, original_filename, ' +
        '       mime_type, size_bytes, is_active, uploaded_at ' +
        'FROM applicant_cv_files ' +
        'WHERE id = ? ' +
        'LIMIT 1',
      [cvFileId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return toDescriptor(rowToRecord(row));
  }

  // Step 3: not authorized.
  return null;
}

/**
 * Resolve a {@link CvFileRecord} into a streamable
 * {@link CvDownloadDescriptor}. Wraps `cvAbsolutePath` so a corrupt
 * `storage_path` (one that escapes the File_Store root) collapses to
 * `null` rather than bubbling up as a 500.
 */
function toDescriptor(record: CvFileRecord): CvDownloadDescriptor | null {
  let absolutePath: string;
  try {
    absolutePath = cvAbsolutePath(record.storage_path);
  } catch {
    // Defensive: the writer-side sanitisation in `cvPath` should make
    // this unreachable, but if a row ever holds a traversal payload we
    // refuse the read instead of leaking. The route maps `null` to 404.
    return null;
  }
  return {
    absolutePath,
    mimeType: record.mime_type,
    originalFilename: record.original_filename,
  };
}

// ===========================================================================
// CV upload pipeline (task 17.1)
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum CV upload size in bytes (Req 4 AC #7). 5 MiB.
 *
 * Mirrors the `fileSize` limit configured on `@fastify/multipart` in
 * `server.ts`. busboy will already abort the stream once it reaches this
 * threshold (the file's `truncated` flag flips to `true`), so the
 * pipeline below uses both an in-band byte counter AND the post-stream
 * truncated flag to detect oversize uploads — defence in depth in case
 * the plugin's option is ever loosened or a caller passes a stream
 * directly.
 */
export const MAX_CV_BYTES = 5 * 1024 * 1024;

/**
 * Maximum number of historical CV rows retained per applicant
 * (Req 4 AC #8). Once a new upload pushes the count past this value,
 * the oldest rows (and their on-disk files) are pruned.
 *
 * The value is intentionally exposed as a `const` rather than a plain
 * literal so the property test (`tests/pbt`, task 17.4) and the route
 * tests can assert against the same canonical number.
 */
export const MAX_CV_HISTORY = 3;

/**
 * MIME allowlist enforced after magic-byte sniffing (Req 4 AC #6 /
 * Req 15 AC #5). Browsers MUST present one of these as the multipart
 * `Content-Type`, AND the sniffed type from `file-type` MUST also fall
 * inside this set — both checks are performed by `processCvUpload`.
 *
 * The Microsoft Word legacy MIME (`application/msword`) is sniffed by
 * `file-type` as `application/x-cfb` (Compound File Binary, the OLE2
 * container shared by .doc / .xls / .ppt / .msi / etc.), so the
 * pipeline accepts that sniffed value when the declared MIME is the
 * legacy Word type. The OOXML .docx is correctly sniffed as
 * `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
 * and PDFs as `application/pdf`. See the docstring of
 * `verifyMagicBytes` for the full mapping.
 */
export const ALLOWED_CV_MIMES = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const);

export type AllowedCvMime = (typeof ALLOWED_CV_MIMES)[number];

/**
 * Map declared MIME → on-disk extension. The extension is what
 * `cvPath()` writes into the File_Store-relative path. The values are
 * the same lowercase shape `disk.ts` enforces in `ALLOWED_CV_EXTS`.
 */
export const MIME_TO_EXT: Readonly<Record<AllowedCvMime, 'pdf' | 'doc' | 'docx'>> =
  Object.freeze({
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'docx',
  });

/**
 * Sniff sample size handed to `file-type`. The library documents 4100
 * bytes as the minimum reliable sample for every supported magic-byte
 * signature, including PDFs that prepend a comment line and DOCX/CFB
 * containers whose header lives a few hundred bytes in.
 */
const SNIFF_SAMPLE_SIZE = 4100;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the multipart body exceeds {@link MAX_CV_BYTES}. The
 * `statusCode = 413` lets the route map the error to HTTP 413 Payload
 * Too Large per Req 4 AC #7.
 *
 * The error is raised in two places:
 *   1. The in-band byte counter inside `processCvUpload` aborts the
 *      `pipeline()` call as soon as it crosses the threshold.
 *   2. After the stream finishes, we cross-check `multipartFile.file.truncated`
 *      (busboy's flag, set when `@fastify/multipart`'s `fileSize` limit
 *      kicks in). Either way we end up here.
 *
 * In either branch the temp file is unlinked before the throw so a
 * failed upload never leaks bytes to disk.
 */
export class FileTooLargeError extends Error {
  public readonly statusCode = 413;
  public readonly limitBytes: number;
  constructor(limitBytes: number = MAX_CV_BYTES) {
    super(`uploaded file exceeds ${limitBytes} bytes`);
    this.name = 'FileTooLargeError';
    this.limitBytes = limitBytes;
  }
}

/**
 * Thrown when the declared MIME type is missing/unknown OR the magic
 * bytes do not match a member of {@link ALLOWED_CV_MIMES}. The
 * `statusCode = 415` lets the route return HTTP 415 Unsupported Media
 * Type per Req 4 AC #6 / Req 15 AC #5.
 */
export class MimeMismatchError extends Error {
  public readonly statusCode = 415;
  /** What the browser claimed (or the empty string when absent). */
  public readonly declaredMime: string;
  /** What `file-type` actually saw (or `null` if no signature matched). */
  public readonly sniffedMime: string | null;
  constructor(declaredMime: string, sniffedMime: string | null) {
    super(
      `MIME mismatch: declared=${JSON.stringify(declaredMime)}, ` +
        `sniffed=${JSON.stringify(sniffedMime)}`,
    );
    this.name = 'MimeMismatchError';
    this.declaredMime = declaredMime;
    this.sniffedMime = sniffedMime;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal contract the pipeline needs from a `@fastify/multipart`
 * `MultipartFile`. Carrying our own structural type instead of
 * importing the plugin's interface keeps the service usable in unit
 * tests (where we feed it a `Readable` directly) and decouples the
 * repository from the HTTP shape.
 */
export interface CvMultipartLike {
  /** The Node.js readable that streams the bytes. */
  readonly file: NodeJS.ReadableStream & { truncated?: boolean };
  /** The MIME the browser declared in the multipart part header. */
  readonly mimetype: string;
  /** The original filename the browser sent (may be empty). */
  readonly filename: string;
}

/**
 * Input contract for {@link processCvUpload}.
 */
export interface ProcessCvUploadInput {
  readonly userId: number;
  readonly multipartFile: CvMultipartLike;
}

/**
 * Successful return shape — carries the freshly-inserted active CV row
 * so the route can render the "current CV" fragment without a second
 * SELECT.
 */
export interface ProcessCvUploadResult {
  readonly cvFile: CvFileRecord;
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/**
 * Build a `Transform` that simply counts bytes and aborts the pipeline
 * once {@link MAX_CV_BYTES} is crossed.
 *
 * `@fastify/multipart` already enforces the 5 MiB `fileSize` limit at
 * the busboy layer, but we keep this in-band counter for two reasons:
 *
 *   1. **Defence in depth.** A future caller might construct a
 *      `MultipartFile` shape directly (e.g. background job), bypassing
 *      busboy. The counter ensures `processCvUpload` itself enforces
 *      the cap.
 *   2. **Deterministic error type.** When busboy hits its limit it
 *      flips `file.truncated` and (depending on options) emits an
 *      `RequestFileTooLargeError`. Our counter raises a typed
 *      {@link FileTooLargeError} *before* the truncated flag matters,
 *      keeping the route's error mapping table small.
 *
 * Aborting via `callback(err)` propagates as a rejection out of the
 * `pipeline()` call wrapping it.
 */
function makeSizeLimiter(limitBytes: number): Transform {
  let bytesSeen = 0;
  return new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const buf = chunk as Buffer;
      bytesSeen += buf.length;
      if (bytesSeen > limitBytes) {
        // Stop reading immediately — we do NOT want to buffer the rest
        // of an oversize upload just to drain the stream.
        callback(new FileTooLargeError(limitBytes));
        return;
      }
      callback(null, buf);
    },
  });
}

/**
 * Ensure the temp directory `~/tmp/uploads/` exists before opening a
 * write stream into it. `tmpUploadPath()` only computes the path; the
 * directory may not yet exist on a fresh checkout / cPanel account.
 *
 * Splitting this out lets the unit tests assert that the directory is
 * created exactly once per upload (idempotent thanks to `mkdir -p`).
 */
async function ensureTmpDir(tmpAbsolute: string): Promise<void> {
  const lastSep = Math.max(
    tmpAbsolute.lastIndexOf('/'),
    tmpAbsolute.lastIndexOf('\\'),
  );
  if (lastSep < 0) return;
  await ensureDir(tmpAbsolute.slice(0, lastSep));
}

/**
 * Read the first {@link SNIFF_SAMPLE_SIZE} bytes of the temp file and
 * return them as a `Uint8Array` for `file-type` to inspect.
 *
 * Why we read AFTER the stream rather than tee'ing during the write:
 *   - file-type's `fileTypeFromBuffer` needs a contiguous buffer; tee'ing
 *     during the stream would force us to splice the incoming chunks
 *     and risk an off-by-one when the stream's first chunk is shorter
 *     than 4100 bytes (typical for HTTP/1.1 servers).
 *   - The sample read happens off a freshly-flushed file handle, so we
 *     get exactly what `fs.rename` will move — there is no chance of
 *     the sniffed bytes diverging from the persisted bytes.
 */
async function readSniffSample(absolutePath: string): Promise<Uint8Array> {
  const handle = await open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_SAMPLE_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_SAMPLE_SIZE, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve the declared MIME against the sniffed MIME, returning the
 * canonical {@link AllowedCvMime} when the pair is acceptable.
 *
 * Mapping table:
 *   declared                                                    sniffed
 *   `application/pdf`                                            `application/pdf`
 *   `application/msword`                                         `application/x-cfb`
 *   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
 *                                                                same string
 *
 * Any other combination → `null` (caller raises `MimeMismatchError`).
 *
 * The `application/x-cfb` accept is intentional: file-type cannot
 * distinguish a real `.doc` from any other OLE2 container by magic
 * bytes alone (Excel `.xls` and Outlook `.msg` share the same
 * signature). We accept the looser sniff here because the **declared**
 * MIME is the trustworthy upper-bound: the browser's `Content-Type`
 * for a `.doc` is `application/msword`, and a malicious `.xls`
 * uploaded under that declared MIME still has to defeat the route's
 * server-side rendering / virus scanning before doing harm. The
 * downstream consumer (HR downloading the file) sees the file with a
 * `.doc` extension and is responsible for opening it in a sandboxed
 * Word reader.
 */
function reconcileMimes(
  declaredMime: string,
  sniffedMime: string | null,
): AllowedCvMime | null {
  if (!(ALLOWED_CV_MIMES as readonly string[]).includes(declaredMime)) {
    return null;
  }
  const declared = declaredMime as AllowedCvMime;
  if (sniffedMime === null) return null;
  if (declared === 'application/pdf' && sniffedMime === 'application/pdf') {
    return declared;
  }
  if (
    declared === 'application/msword' &&
    (sniffedMime === 'application/x-cfb' || sniffedMime === 'application/msword')
  ) {
    return declared;
  }
  if (
    declared ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    sniffedMime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return declared;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SQL (upload-side)
// ---------------------------------------------------------------------------

const INSERT_CV_SQL =
  'INSERT INTO applicant_cv_files ' +
  '  (applicant_user_id, storage_path, original_filename, mime_type, size_bytes, is_active) ' +
  'VALUES (?, ?, ?, ?, ?, 1)';

const DEACTIVATE_OLDER_SQL =
  'UPDATE applicant_cv_files ' +
  'SET is_active = 0 ' +
  'WHERE applicant_user_id = ? AND id <> ?';

const SELECT_PRUNE_TARGETS_SQL =
  'SELECT id, storage_path FROM applicant_cv_files ' +
  'WHERE applicant_user_id = ? ' +
  'ORDER BY uploaded_at DESC, id DESC ' +
  'LIMIT 1000 OFFSET ?';

const DELETE_BY_ID_SQL =
  'DELETE FROM applicant_cv_files WHERE id = ? AND applicant_user_id = ?';

const SELECT_BY_ID_FULL_SQL =
  'SELECT id, applicant_user_id, storage_path, original_filename, ' +
  '       mime_type, size_bytes, is_active, uploaded_at ' +
  'FROM applicant_cv_files ' +
  'WHERE id = ? ' +
  'LIMIT 1';

const SELECT_LIST_FOR_OWNER_SQL =
  'SELECT id, applicant_user_id, storage_path, original_filename, ' +
  '       mime_type, size_bytes, is_active, uploaded_at ' +
  'FROM applicant_cv_files ' +
  'WHERE applicant_user_id = ? ' +
  'ORDER BY uploaded_at DESC, id DESC ' +
  'LIMIT 100';

interface PruneTargetRow extends RowDataPacket {
  id: number | string;
  storage_path: string;
}

// ---------------------------------------------------------------------------
// Filename sanitiser
// ---------------------------------------------------------------------------

/**
 * Sanitise the user-supplied original filename for safe storage. The
 * column is `VARCHAR(255)` and the string is later quoted into a
 * `Content-Disposition` response header by the download route, so we
 * defensively:
 *   - replace control characters (`< 0x20`, `0x7f`) with `_`,
 *     including CR/LF that would otherwise enable header-splitting,
 *   - replace path separators (`/`, `\`) with `_` so an attacker
 *     cannot smuggle a directory-style filename into the column,
 *   - replace double-quotes with `_` so the value can be quoted in a
 *     `filename="..."` header without escaping,
 *   - trim ASCII whitespace from both ends,
 *   - truncate to 200 chars (well under the column's 255) so the
 *     storage_path + filename combination always fits, and
 *   - fall back to `cv.<ext>` when the cleaned value is empty.
 */
function sanitiseOriginalFilename(raw: string, ext: string): string {
  const cleaned = String(raw ?? '')
    // Replace controls and separators in one pass.
    .replace(/[\x00-\x1f\x7f"\\/]+/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : `cv.${ext}`;
}

// ---------------------------------------------------------------------------
// Public service: processCvUpload
// ---------------------------------------------------------------------------

/**
 * Run the entire CV upload pipeline (Design §9):
 *
 *   1. **Pre-flight**: refuse with 507 if the File_Store volume has
 *      less than 100 MiB free (delegates to `assertFreeSpace`). We do
 *      this BEFORE opening any write stream so an oversize upload
 *      cannot fill the disk on a busy worker.
 *   2. **Stream to temp**: pipe the multipart `Readable` through a
 *      byte-counting `Transform` into `~/tmp/uploads/<uuid>.tmp`.
 *      Either the in-band counter or busboy's `truncated` flag
 *      triggers a {@link FileTooLargeError} on oversize input.
 *   3. **Magic-byte check**: read the first 4100 bytes of the temp
 *      file and call `file-type`'s `fileTypeFromBuffer`. The sniffed
 *      MIME must match the declared MIME via {@link reconcileMimes};
 *      mismatch → {@link MimeMismatchError}.
 *   4. **Move to File_Store**: compute the canonical
 *      `cv/yyyy/mm/<uuid>.<ext>` path via `cvPath`, ensure its parent
 *      via `ensureCvDir`, then `fs.rename` the temp file in place.
 *      Same-volume rename is atomic on every supported filesystem.
 *   5. **DB write**: inside `withTransaction`,
 *      a. INSERT the new row with `is_active = 1`,
 *      b. UPDATE every other row of this applicant to `is_active = 0`,
 *      c. SELECT the rows past `MAX_CV_HISTORY` and DELETE them, then
 *      d. unlink the on-disk files for those pruned rows.
 *      The SELECT is intentionally ordered by `uploaded_at DESC, id DESC`
 *      and offset by `MAX_CV_HISTORY` so the freshly-inserted row is
 *      always slot 0 — pruning never deletes the active CV.
 *   6. **Return**: the inserted {@link CvFileRecord}, ready for the
 *      route to render in the success fragment.
 *
 * Cleanup contract:
 *   - Any throw before the rename leaves the temp file behind, but the
 *     `try / finally` always attempts a best-effort `safeUnlink` of
 *     the temp path so a failed upload never leaks bytes.
 *   - Pruning errors (e.g. a missing on-disk file) are logged but do
 *     NOT abort the transaction: the row is the source of truth, and
 *     a dangling file on disk gets swept up by the file-archive cron
 *     (task 41.x) on its next pass.
 */
export async function processCvUpload(
  input: ProcessCvUploadInput,
): Promise<ProcessCvUploadResult> {
  const { userId, multipartFile } = input;
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('processCvUpload: invalid userId');
  }
  if (
    multipartFile === null ||
    typeof multipartFile !== 'object' ||
    typeof multipartFile.mimetype !== 'string' ||
    multipartFile.file === null ||
    typeof multipartFile.file !== 'object'
  ) {
    throw new Error('processCvUpload: invalid multipartFile shape');
  }

  // Step 1 — free-space pre-flight. Throws InsufficientStorageError(507)
  // when the File_Store volume is below the 100 MiB threshold.
  await assertFreeSpace();

  // Reject early on a declared MIME that is not in the allowlist. This
  // gives the user a 415 without any disk I/O when they upload a `.png`
  // selected from the file picker; the magic-byte check in step 3 still
  // runs for declared MIMEs that ARE in the allowlist.
  if (
    !(ALLOWED_CV_MIMES as readonly string[]).includes(multipartFile.mimetype)
  ) {
    throw new MimeMismatchError(multipartFile.mimetype, null);
  }
  const declaredMime = multipartFile.mimetype as AllowedCvMime;
  const ext = MIME_TO_EXT[declaredMime];

  // Generate the upload's identity once. We use ulid() here for
  // monotonic-ish lexicographic ordering — the value is stripped to
  // lowercase + dashes by `sanitiseUuid` inside `disk.ts`, and ULIDs
  // pass that filter natively.
  const uuid = ulid().toLowerCase();
  const tmpAbsolute = tmpUploadPath(uuid);
  await ensureTmpDir(tmpAbsolute);

  let cleanupTmp = true;
  let bytesWritten = 0;

  try {
    // Step 2 — stream into the temp slot through the size-limiting
    // transform. `pipeline()` ties stream lifecycles together: a
    // throw from the limiter destroys the writer and rejects the
    // promise. busboy's `truncated` flag is checked AFTER pipeline()
    // resolves so we map that path to the same FileTooLargeError.
    const limiter = makeSizeLimiter(MAX_CV_BYTES);
    const writer = createWriteStream(tmpAbsolute, { mode: 0o600 });
    await pipeline(multipartFile.file, limiter, writer);

    // Did busboy's own fileSize limit fire? If so, the stream ended
    // cleanly but with `truncated=true` — treat as oversize.
    if (multipartFile.file.truncated === true) {
      throw new FileTooLargeError(MAX_CV_BYTES);
    }

    const tmpStat = await stat(tmpAbsolute);
    bytesWritten = Number(tmpStat.size);
    if (bytesWritten > MAX_CV_BYTES) {
      // Defensive: should be unreachable thanks to the limiter, but a
      // future stream library that does not honour `Transform` errors
      // could in theory still write past the limit. Catch it here.
      throw new FileTooLargeError(MAX_CV_BYTES);
    }
    if (bytesWritten === 0) {
      // An empty upload could survive both limiters; treat it as a
      // MIME mismatch since file-type won't recognise it either.
      throw new MimeMismatchError(declaredMime, null);
    }

    // Step 3 — magic-byte check.
    const sample = await readSniffSample(tmpAbsolute);
    const sniffed = await fileTypeFromBuffer(sample);
    const sniffedMime = sniffed?.mime ?? null;
    const acceptedMime = reconcileMimes(declaredMime, sniffedMime);
    if (acceptedMime === null) {
      throw new MimeMismatchError(declaredMime, sniffedMime);
    }

    // Step 4 — move into the File_Store. `ensureCvDir` mkdirs the
    // year/month directory under the configured root. `rename` is
    // atomic on the same volume; tmp and File_Store both live under
    // `~`, so this is safe on the cPanel host.
    const finalAbsolute = await ensureCvDir(userId, uuid, ext);
    await rename(tmpAbsolute, finalAbsolute);
    cleanupTmp = false; // moved out of tmp; do not unlink it.

    const relativePath = cvPath(userId, uuid, ext);
    const safeFilename = sanitiseOriginalFilename(multipartFile.filename, ext);

    // Step 5 — persist the row and prune history. We collect the prune
    // descriptors inside the transaction and unlink the files AFTER the
    // commit so a rolled-back transaction never deletes bytes.
    const { record, pruneFiles } = await withTransaction(async (conn) =>
      insertActiveCvAndPrune(conn, {
        userId,
        relativePath,
        originalFilename: safeFilename,
        mimeType: acceptedMime,
        sizeBytes: bytesWritten,
      }),
    );

    // Best-effort unlink of pruned files; row deletion is the source
    // of truth, so a missing or unreadable on-disk file does not abort
    // the upload.
    for (const target of pruneFiles) {
      let absolutePath: string | null = null;
      try {
        absolutePath = cvAbsolutePath(target.storage_path);
      } catch {
        absolutePath = null;
      }
      if (absolutePath !== null) {
        try {
          await safeUnlink(absolutePath);
        } catch (err) {
          logger.warn(
            {
              event: 'cv_prune_unlink_failed',
              user_id: userId,
              cv_id: target.id,
              err,
            },
            'applicant.cv: failed to unlink pruned file',
          );
        }
      }
    }

    logger.info(
      {
        event: 'cv_upload',
        user_id: userId,
        cv_id: record.id,
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
        pruned_count: pruneFiles.length,
      },
      'applicant.cv: upload accepted',
    );

    return { cvFile: record };
  } finally {
    if (cleanupTmp) {
      // Best-effort: a tmp file is leftover only on the failure paths
      // above. ENOENT is fine (the file may have been renamed already
      // on the success path that didn't reach `cleanupTmp = false`).
      try {
        await unlink(tmpAbsolute);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Inner DB transaction body for `processCvUpload`. Lives in its own
 * function so the unit tests can drive it with a mocked
 * `PoolConnection` without spinning up the streaming machinery.
 *
 * Returns the inserted {@link CvFileRecord} together with the prune
 * descriptors (`{id, storage_path}`) that the caller should unlink
 * AFTER the transaction commits — running `unlink` inside the
 * transaction would couple I/O failure to a rollback and leave the
 * row alive while the file is gone, which is the worst possible
 * combination.
 */
async function insertActiveCvAndPrune(
  conn: PoolConnection,
  input: {
    userId: number;
    relativePath: string;
    originalFilename: string;
    mimeType: AllowedCvMime;
    sizeBytes: number;
  },
): Promise<{
  record: CvFileRecord;
  pruneFiles: ReadonlyArray<{ id: number; storage_path: string }>;
}> {
  const [insertResult] = await conn.execute<ResultSetHeader>(INSERT_CV_SQL, [
    input.userId,
    input.relativePath,
    input.originalFilename,
    input.mimeType,
    input.sizeBytes,
  ]);
  const newId = Number(insertResult.insertId);
  if (!Number.isInteger(newId) || newId <= 0) {
    throw new Error('applicant.cv: insert returned non-positive id');
  }

  // Flip every other row's is_active flag in a single statement. We
  // include the new row in the WHERE via `id <> ?` so the row we just
  // inserted (already is_active=1) is unaffected.
  await conn.execute<ResultSetHeader>(DEACTIVATE_OLDER_SQL, [
    input.userId,
    newId,
  ]);

  // SELECT every row past the first MAX_CV_HISTORY (sorted newest
  // first). The freshly-inserted row is always at offset 0 because
  // its `uploaded_at` defaults to `CURRENT_TIMESTAMP` and the index is
  // ordered by it descending — so prune targets are always older rows.
  const [pruneRows] = await conn.execute<PruneTargetRow[]>(
    SELECT_PRUNE_TARGETS_SQL,
    [input.userId, MAX_CV_HISTORY],
  );

  const pruneFiles: Array<{ id: number; storage_path: string }> = [];
  for (const row of pruneRows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    await conn.execute<ResultSetHeader>(DELETE_BY_ID_SQL, [id, input.userId]);
    pruneFiles.push({ id, storage_path: row.storage_path });
  }

  // Re-load the inserted row so we return canonical column values
  // (the DEFAULT CURRENT_TIMESTAMP for `uploaded_at` is computed by
  // the server, not by the INSERT params).
  const [freshRows] = await conn.execute<CvFileRow[]>(
    SELECT_BY_ID_FULL_SQL,
    [newId],
  );
  const fresh = freshRows[0];
  if (!fresh) {
    throw new Error('applicant.cv: inserted row vanished before re-select');
  }

  return { record: rowToRecord(fresh), pruneFiles };
}

// ---------------------------------------------------------------------------
// Public service: listCvsForOwner
// ---------------------------------------------------------------------------

/**
 * Owner-scoped list of every CV row, newest first. Used by the upload
 * form to show the active CV plus any retained history (≤ 3 rows
 * total). Returns an empty array if the applicant has not uploaded a
 * CV yet.
 *
 * The hard cap of 100 rows in the SQL is a defensive belt-and-braces:
 * `MAX_CV_HISTORY` keeps the live count at 3, but a future migration
 * or manual data fix should not trigger an unbounded result set.
 */
export async function listCvsForOwner(
  userId: number,
): Promise<CvFileRecord[]> {
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const rows = await query<CvFileRow[]>(SELECT_LIST_FOR_OWNER_SQL, [userId]);
  return rows.map((row) => rowToRecord(row));
}
