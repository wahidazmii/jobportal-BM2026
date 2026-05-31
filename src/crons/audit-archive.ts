/**
 * Cron task: `audit-archive`.
 *
 * Monthly cold-storage sweep for the insert-only `audit_events` table
 * (Design §11.2 — runs day 2 of each month 04:30; Design §15 — "arsip
 * oleh cron `audit-archive` jika `> 5_000_000` rows"). The audit log is
 * never edited in place; the only legitimate deleter is this cron, and
 * even it MOVES rows out to a gzip archive in File_Store before deleting
 * them (migration 0007 header — "moves rows out … before deleting them").
 *
 * Pipeline (Req 12.4, 12.5):
 *   1. `SELECT COUNT(*)`. While the table is at/under 5,000,000 rows the
 *      retention window has not been crossed yet (Req 12.4 — events are
 *      kept ≥ 24 months "before allowing automated archival"), so we log
 *      `audit_archive_skipped` and return without touching any rows.
 *   2. Resolve a single cutoff = `NOW() - INTERVAL 24 MONTH` up front and
 *      reuse it for every subsequent query. Reading it once (rather than
 *      re-evaluating `NOW()` inside each statement) guarantees the SELECT
 *      that writes a bucket and the DELETE that prunes it share the exact
 *      same boundary — otherwise a few milliseconds of clock drift between
 *      the two could let the DELETE remove a row the archive never wrote.
 *   3. Group the eligible rows (`occurred_at < cutoff`) by `yyyy-mm`.
 *   4. For each month bucket, in order:
 *        a. SELECT that month's rows (`>= monthStart AND < monthEnd AND
 *           < cutoff` — the cutoff clause trims the partial boundary month).
 *        b. Write them newline-delimited JSON, gzip-compressed, to
 *           `<file_store>/archives/audit/audit-yyyy-mm.jsonl.gz`.
 *        c. VERIFY the gzip before deleting (Req 12.5): re-open it,
 *           gunzip it, and confirm the decompressed line count matches the
 *           number of rows written. Only on a clean verify do we DELETE
 *           that month's rows (same predicate as the SELECT).
 *        d. A failed verify (corrupt gzip / line-count mismatch) leaves the
 *           rows in place for the next run and logs an error — we never
 *           delete unverified data.
 *   5. Emit a summary line.
 *
 * Error contract: per-bucket errors are caught so one bad month never
 * aborts the rest of the sweep. Batch-level errors (the initial COUNT or
 * cutoff query throwing) propagate to `runWithLock`, which records
 * `cron_locks.last_status='error'` (Design §11.1).
 *
 * SQL safety (Req 15.4): every statement is a static string with `?`
 * placeholders — no value is ever concatenated into SQL.
 *
 * Validates: Requirements 12.4, 12.5 (Design §11.2, §15)
 */

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

import { query, type ResultSetHeader, type RowDataPacket } from '../infra/db.js';
import { ensureDir, getFileStoreRoot } from '../infra/disk.js';
import { logger } from '../infra/logger.js';

const log = logger.child({ cron: 'audit-archive' });

const gunzipAsync = promisify(gunzip);

/**
 * Row-count ceiling from Req 12.5 / Design §15. Archival only kicks in
 * once the table *exceeds* this value; at or below it we skip so the
 * 24-month retention floor (Req 12.4) is never undercut prematurely.
 */
export const AUDIT_TABLE_ROW_THRESHOLD = 5_000_000;

/** Subdirectory under File_Store dedicated to audit archives. */
const ARCHIVE_SUBDIR = path.join('archives', 'audit');

/** `SELECT COUNT(*)` — drives the §15 threshold gate. */
const COUNT_SQL = 'SELECT COUNT(*) AS n FROM audit_events';

/**
 * Materialise the retention cutoff once. Returned as a DATETIME the driver
 * hands back as a `Date`, which we then feed back as a bound parameter to
 * every range query so all of them agree on the boundary.
 */
const CUTOFF_SQL = 'SELECT (NOW() - INTERVAL 24 MONTH) AS cutoff';

/**
 * Enumerate the month buckets that have eligible rows. `DATE_FORMAT(...,
 * '%Y-%m')` collapses each row to its calendar month so we can archive one
 * file per month (Req 12.5 — "a monthly archive file").
 */
const BUCKETS_SQL = `
  SELECT DATE_FORMAT(occurred_at, '%Y-%m') AS ym, COUNT(*) AS cnt
  FROM audit_events
  WHERE occurred_at < ?
  GROUP BY ym
  ORDER BY ym
`;

/** Select a single month's eligible rows in stable id order. */
const SELECT_BUCKET_ROWS_SQL = `
  SELECT id, occurred_at, actor_user_id, actor_ip,
         action_type, target_entity, target_id, details
  FROM audit_events
  WHERE occurred_at >= ? AND occurred_at < ? AND occurred_at < ?
  ORDER BY id
`;

/**
 * Prune a single month's rows. Uses the *same* predicate as
 * {@link SELECT_BUCKET_ROWS_SQL} (and the same bound cutoff) so it can
 * never delete a row the archive did not capture.
 */
const DELETE_BUCKET_ROWS_SQL = `
  DELETE FROM audit_events
  WHERE occurred_at >= ? AND occurred_at < ? AND occurred_at < ?
`;

/** A row as archived. Mirrors the `audit_events` column set (migration 0007). */
interface AuditEventRow extends RowDataPacket {
  id: number | string;
  occurred_at: Date | string;
  actor_user_id: number | string | null;
  actor_ip: string | null;
  action_type: string;
  target_entity: string;
  target_id: number | string | null;
  details: unknown;
}

/** One `yyyy-mm` bucket discovered by {@link BUCKETS_SQL}. */
interface BucketRow extends RowDataPacket {
  ym: string;
  cnt: number | string;
}

/** Inclusive-start / exclusive-end DATETIME bounds for a calendar month. */
interface MonthBounds {
  start: string;
  end: string;
}

/**
 * Filesystem + compression seam. Defaulted to the real `node:zlib` /
 * `node:fs` implementations below; tests inject a stub (e.g. to force a
 * verification failure) or point the archive dir at a tmp directory via
 * `FILE_STORE_PATH`.
 */
export interface AuditArchiveIo {
  /** Absolute directory the monthly archives are written into. */
  archiveDir(): string;
  /** `mkdir -p` the archive directory. */
  ensureDir(dir: string): Promise<void>;
  /** Write `lines` as gzip-compressed newline-delimited JSON to `filePath`. */
  writeGzipJsonl(filePath: string, lines: readonly string[]): Promise<void>;
  /**
   * Re-open `filePath`, gunzip it, and report whether the decompressed
   * line count equals `expectedLines`. Returns `false` (never throws) when
   * the file is corrupt or the count disagrees.
   */
  verifyGzipLineCount(filePath: string, expectedLines: number): Promise<boolean>;
}

/** Resolve the audit-archive directory under the configured File_Store. */
export function getAuditArchiveDir(): string {
  return path.join(getFileStoreRoot(), ARCHIVE_SUBDIR);
}

/** Yield each line with its terminating newline for the gzip stream. */
function* jsonlChunks(lines: readonly string[]): Generator<string> {
  for (const line of lines) {
    yield `${line}\n`;
  }
}

/**
 * Production IO: streams JSONL through a gzip transform into a write
 * stream (`node:zlib` + `node:fs`), and verifies by gunzipping the file
 * back (`node:fs/promises` + `node:zlib`).
 */
const defaultIo: AuditArchiveIo = {
  archiveDir: getAuditArchiveDir,
  ensureDir,
  async writeGzipJsonl(filePath, lines) {
    await pipeline(
      Readable.from(jsonlChunks(lines)),
      createGzip(),
      createWriteStream(filePath),
    );
  },
  async verifyGzipLineCount(filePath, expectedLines) {
    try {
      const compressed = await readFile(filePath);
      const raw = await gunzipAsync(compressed);
      const actualLines = raw
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0).length;
      return actualLines === expectedLines;
    } catch {
      // A corrupt / unreadable archive is simply "not verified" — the
      // caller will skip the DELETE and leave the rows for the next run.
      return false;
    }
  },
};

/** Compute `[monthStart, nextMonthStart)` DATETIME bounds for a `yyyy-mm`. */
function monthBounds(ym: string): MonthBounds {
  const [yearStr, monthStr] = ym.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12
  const start = `${ym}-01 00:00:00`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const mm = nextMonth < 10 ? `0${nextMonth}` : `${nextMonth}`;
  const end = `${nextYear}-${mm}-01 00:00:00`;
  return { start, end };
}

/** Serialise a row to a single JSONL line with a stable column shape. */
function toJsonlLine(row: AuditEventRow): string {
  return JSON.stringify({
    id: row.id,
    occurred_at: row.occurred_at,
    actor_user_id: row.actor_user_id,
    actor_ip: row.actor_ip,
    action_type: row.action_type,
    target_entity: row.target_entity,
    target_id: row.target_id,
    details: row.details,
  });
}

/**
 * Archive and prune one month bucket. Returns the number of rows deleted
 * (0 when the bucket was empty or verification failed). Throws only on an
 * unexpected DB error, which the caller isolates per-bucket.
 */
async function archiveBucket(
  io: AuditArchiveIo,
  dir: string,
  ym: string,
  cutoff: unknown,
): Promise<number> {
  const { start, end } = monthBounds(ym);
  const rows = await query<AuditEventRow[]>(SELECT_BUCKET_ROWS_SQL, [
    start,
    end,
    cutoff,
  ]);

  if (rows.length === 0) {
    // The bucket emptied out between the GROUP BY and now — nothing to do.
    return 0;
  }

  const filePath = path.join(dir, `audit-${ym}.jsonl.gz`);
  const lines = rows.map(toJsonlLine);

  // a-b. Write the gzip archive.
  await io.writeGzipJsonl(filePath, lines);

  // c. Verify before deleting (Req 12.5).
  const verified = await io.verifyGzipLineCount(filePath, lines.length);
  if (!verified) {
    log.error(
      {
        event: 'audit_archive_verify_failed',
        bucket: ym,
        file: filePath,
        expected_rows: lines.length,
      },
      'audit-archive: gzip verification failed; leaving rows in place',
    );
    return 0;
  }

  // d. Only now is it safe to prune — identical predicate to the SELECT.
  const result = await query<ResultSetHeader>(DELETE_BUCKET_ROWS_SQL, [
    start,
    end,
    cutoff,
  ]);
  const deleted = result.affectedRows ?? 0;

  log.info(
    {
      event: 'audit_archive_bucket_done',
      bucket: ym,
      file: filePath,
      archived_rows: lines.length,
      deleted_rows: deleted,
    },
    'audit-archive: bucket archived and pruned',
  );
  return deleted;
}

/**
 * Run a single monthly audit-archive pass.
 *
 * The `io` seam defaults to the real filesystem/zlib implementation; the
 * dispatcher invokes this with no arguments under `runWithLock`.
 */
export async function auditArchive(io: AuditArchiveIo = defaultIo): Promise<void> {
  const startedAt = Date.now();

  // 1. Threshold gate (Req 12.4). Errors here propagate (batch-level).
  const countRows = await query<RowDataPacket[]>(COUNT_SQL);
  const countBefore = Number(countRows[0]?.n ?? 0);

  if (countBefore <= AUDIT_TABLE_ROW_THRESHOLD) {
    log.info(
      { event: 'audit_archive_skipped', count: countBefore },
      'audit-archive: below threshold, nothing to archive',
    );
    return;
  }

  // 2. Single shared cutoff so every SELECT/DELETE agrees on the boundary.
  const cutoffRows = await query<RowDataPacket[]>(CUTOFF_SQL);
  const cutoff = cutoffRows[0]?.cutoff as unknown;

  // 3. Enumerate eligible month buckets.
  const buckets = await query<BucketRow[]>(BUCKETS_SQL, [cutoff]);

  // Make sure the archive directory exists before writing any file.
  const dir = io.archiveDir();
  await io.ensureDir(dir);

  // 4. Archive each bucket, isolating per-bucket failures.
  let archivedRows = 0;
  let archivedBuckets = 0;
  for (const bucket of buckets) {
    try {
      const deleted = await archiveBucket(io, dir, bucket.ym, cutoff);
      if (deleted > 0) {
        archivedRows += deleted;
        archivedBuckets += 1;
      }
    } catch (err) {
      log.error(
        {
          event: 'audit_archive_bucket_error',
          bucket: bucket.ym,
          error: err instanceof Error ? err.message : String(err),
        },
        'audit-archive: bucket failed; continuing with remaining buckets',
      );
    }
  }

  // 5. Summary line.
  log.info(
    {
      event: 'audit_archive_done',
      count_before: countBefore,
      archived_rows: archivedRows,
      buckets: archivedBuckets,
      duration_ms: Date.now() - startedAt,
    },
    'audit-archive: completed',
  );
}
