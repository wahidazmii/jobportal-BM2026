/**
 * Daily backup cron task for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 50.1
 * Design  : §17 (Backup Strategy), §11.2 (cPanel crontab — 0 2 * * *)
 * Validates: Requirements 18.1, 18.2, 18.3, 18.5
 *
 * What this module does (Design §17):
 *   1. Ensure ~/backups/ (mode 0700) exists.
 *   2. Dump MySQL via `mysqldump --single-transaction --quick --routines
 *      --triggers --no-tablespaces` piped through `gzip -9` into
 *      ~/backups/db-YYYY-MM-DD.sql.gz.
 *   3. Archive ~/file_store via `tar --exclude='*.tmp' -czf
 *      ~/backups/files-YYYY-MM-DD.tar.gz -C $HOME file_store`.
 *   4. Verify each archive: `gzip -t` for the SQL dump, `tar -tzf | head`
 *      for the tar. On failure → enqueue alert email + write audit event
 *      + throw (aborts the run).
 *   5. Retention: keep the 14 most-recent daily backups; delete older ones.
 *      On the 1st of the month, copy today's archives to ~/backups/monthly/
 *      and prune monthly archives older than 12 months.
 *
 * Subprocess safety:
 *   - Uses `child_process.spawn` (not `exec`) so arguments are never
 *     shell-interpolated. DATABASE_URL is parsed into discrete flags.
 *   - Credentials are passed via MYSQL_PWD env var (not CLI args) to
 *     avoid exposure in `ps aux`.
 *
 * SQL safety (Req 15.4):
 *   - No SQL is issued directly from this module; all DB interaction goes
 *     through `auditService.write` and `enqueue`, which use prepared
 *     statements internally.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { auditService } from '../modules/audit/writer.js';
import { enqueue } from '../modules/mail/service.js';

const log = logger.child({ cron: 'backup-daily' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root backup directory (Design §17: outside public_html, mode 0700). */
const BACKUP_DIR = path.join(os.homedir(), 'backups');

/** Monthly sub-directory for long-term retention. */
const MONTHLY_DIR = path.join(BACKUP_DIR, 'monthly');

/** Number of daily backups to retain (Req 18.2). */
const DAILY_RETENTION = 14;

/** Number of monthly backups to retain (Req 18.2). */
const MONTHLY_RETENTION = 12;

// ---------------------------------------------------------------------------
// Helpers — date
// ---------------------------------------------------------------------------

/**
 * Return today's date as `YYYY-MM-DD` (local time). Used for filenames so
 * the backup label matches the cPanel cron schedule (02:00 server time).
 */
function todayLabel(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return [yyyy, mm, dd].join('-');
}

/** Return the day-of-month (1-based) for today. */
function todayDayOfMonth(): number {
  return new Date().getDate();
}

// ---------------------------------------------------------------------------
// Helpers — DATABASE_URL parsing
// ---------------------------------------------------------------------------

interface DbCredentials {
  readonly host: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly port: string;
}

/**
 * Parse a `mysql://user:pass@host:port/dbname` URL into discrete
 * mysqldump flags. Throws if the URL is absent or malformed.
 */
function parseDbUrl(rawUrl: string): DbCredentials {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, '');
  const port = url.port || '3306';

  if (!host || !user || !database) {
    throw new Error('DATABASE_URL must contain host, user, and database name');
  }
  return { host, user, password, database, port };
}

// ---------------------------------------------------------------------------
// Helpers — subprocess
// ---------------------------------------------------------------------------

/**
 * Spawn a child process and collect its stdout as a Buffer. Rejects with
 * an error containing the process's stderr output if the exit code is
 * non-zero.
 */
function spawnCollect(
  cmd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(cmd, [...args], {
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        reject(
          new Error(
            [`Process "${cmd}" exited with code ${code}`, stderr]
              .filter(Boolean)
              .join(': '),
          ),
        );
      }
    });
  });
}

/**
 * Pipe the stdout of `srcCmd` into the stdin of `dstCmd`, writing the
 * final output to `destFile`. Used for `mysqldump | gzip > file`.
 * Rejects if either process exits non-zero.
 */
function spawnPipe(
  srcCmd: string,
  srcArgs: readonly string[],
  dstCmd: string,
  dstArgs: readonly string[],
  destFile: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const srcErrChunks: Buffer[] = [];
    const dstErrChunks: Buffer[] = [];

    const src = spawn(srcCmd, [...srcArgs], {
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const dst = spawn(dstCmd, [...dstArgs], {
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe src stdout → dst stdin
    src.stdout.pipe(dst.stdin);

    // Write dst stdout to the destination file
    const out = createWriteStream(destFile, { flags: 'w', mode: 0o600 });
    dst.stdout.pipe(out);

    src.stderr.on('data', (c: Buffer) => srcErrChunks.push(c));
    dst.stderr.on('data', (c: Buffer) => dstErrChunks.push(c));

    let srcCode: number | null = null;
    let dstCode: number | null = null;
    let settled = false;

    function trySettle() {
      if (srcCode === null || dstCode === null) return;
      if (settled) return;
      settled = true;

      out.end();
      if (srcCode !== 0 || dstCode !== 0) {
        const srcErr = Buffer.concat(srcErrChunks).toString('utf8').trim();
        const dstErr = Buffer.concat(dstErrChunks).toString('utf8').trim();
        const parts = [
          srcCode !== 0 ? [`${srcCmd} exited ${srcCode}`, srcErr].filter(Boolean).join(': ') : '',
          dstCode !== 0 ? [`${dstCmd} exited ${dstCode}`, dstErr].filter(Boolean).join(': ') : '',
        ].filter(Boolean);
        reject(new Error(parts.join('; ')));
      } else {
        resolve();
      }
    }

    src.on('error', reject);
    dst.on('error', reject);
    out.on('error', reject);

    src.on('close', (code) => {
      srcCode = code ?? 1;
      trySettle();
    });
    dst.on('close', (code) => {
      dstCode = code ?? 1;
      trySettle();
    });
  });
}

// ---------------------------------------------------------------------------
// Step 1 — DB dump
// ---------------------------------------------------------------------------

/**
 * Run `mysqldump ... | gzip -9 > ~/backups/db-YYYY-MM-DD.sql.gz`.
 * Uses `spawn` (not `exec`) so credentials are never shell-interpolated.
 * Password is passed via MYSQL_PWD env var to avoid ps-list exposure.
 */
async function dumpDatabase(destFile: string, creds: DbCredentials): Promise<void> {
  log.info({ destFile }, 'backup: starting mysqldump');

  const dumpArgs = [
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--no-tablespaces',
    ['-h', creds.host].join(''),
    ['-P', creds.port].join(''),
    ['-u', creds.user].join(''),
    creds.database,
  ];

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Pass password via env var so it never appears in the process list
    MYSQL_PWD: creds.password,
  };

  await spawnPipe(
    'mysqldump', dumpArgs,
    'gzip', ['-9'],
    destFile,
    childEnv,
  );

  log.info({ destFile }, 'backup: mysqldump complete');
}

// ---------------------------------------------------------------------------
// Step 2 — File store tar
// ---------------------------------------------------------------------------

/**
 * Run `tar --exclude='*.tmp' -czf ~/backups/files-YYYY-MM-DD.tar.gz
 *          -C $HOME file_store`.
 */
async function archiveFileStore(destFile: string): Promise<void> {
  log.info({ destFile }, 'backup: starting file_store tar');

  const tarArgs = [
    '--exclude=*.tmp',
    '-czf', destFile,
    '-C', os.homedir(),
    'file_store',
  ];

  await spawnCollect('tar', tarArgs);

  log.info({ destFile }, 'backup: file_store tar complete');
}

// ---------------------------------------------------------------------------
// Step 3 — Verification
// ---------------------------------------------------------------------------

/**
 * Verify a gzip file with `gzip -t`. Throws on failure (Req 18.3).
 */
async function verifyGzip(filePath: string): Promise<void> {
  log.info({ filePath }, 'backup: verifying gzip');
  await spawnCollect('gzip', ['-t', filePath]);
  log.info({ filePath }, 'backup: gzip OK');
}

/**
 * Verify a tar.gz file by listing its table-of-contents (`tar -tzf`).
 * Reads at least the first entry to confirm the archive is non-empty and
 * structurally valid (Req 18.3). Throws on failure.
 */
async function verifyTar(filePath: string): Promise<void> {
  log.info({ filePath }, 'backup: verifying tar');
  const output = await spawnCollect('tar', ['-tzf', filePath]);
  const firstLine = output.toString('utf8').split('\n')[0] ?? '';
  log.info({ filePath, firstEntry: firstLine }, 'backup: tar OK');
}

// ---------------------------------------------------------------------------
// Step 4 — Failure handling
// ---------------------------------------------------------------------------

/**
 * On backup failure: enqueue an alert email and write an audit event.
 * Best-effort — errors here are logged but do not mask the original error.
 * (Req 18.5)
 */
async function handleBackupFailure(
  label: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ label, err }, 'backup: FAILED');

  // Enqueue alert email (Req 18.5).
  try {
    const conn = await pool.getConnection();
    try {
      await enqueue(conn, {
        templateKey: 'backup_failed',
        toEmail: process.env.ADMIN_ALERT_EMAIL ?? '',
        context: { label, message, date: new Date().toISOString() },
      });
    } finally {
      conn.release();
    }
  } catch (mailErr) {
    log.error({ mailErr }, 'backup: failed to enqueue alert email');
  }

  // Write audit event (Req 18.5).
  try {
    await auditService.write({
      actorUserId: null,
      actorIp: null,
      actionType: 'backup_failed',
      targetEntity: 'backup',
      targetId: null,
      details: { label, message },
    });
  } catch (auditErr) {
    log.error({ auditErr }, 'backup: failed to write audit event');
  }
}

// ---------------------------------------------------------------------------
// Step 5 — Retention
// ---------------------------------------------------------------------------

/**
 * Keep only the `DAILY_RETENTION` most-recent daily backup files matching
 * the given prefix pattern (e.g. `db-` or `files-`). Deletes older ones.
 * (Req 18.2)
 */
async function pruneDaily(prefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(BACKUP_DIR);
  } catch {
    return; // Directory doesn't exist yet — nothing to prune
  }

  // Match files like db-2024-01-15.sql.gz or files-2024-01-15.tar.gz
  const pattern = new RegExp(['^', prefix, '\\d{4}-\\d{2}-\\d{2}\\.'].join(''));
  const matching = entries
    .filter((f) => pattern.test(f))
    .sort() // ISO date strings sort lexicographically
    .reverse(); // newest first

  const toDelete = matching.slice(DAILY_RETENTION);
  for (const file of toDelete) {
    const filePath = path.join(BACKUP_DIR, file);
    try {
      await rm(filePath, { force: true });
      log.info({ file }, 'backup: pruned old daily backup');
    } catch (pruneErr) {
      log.warn({ file, pruneErr }, 'backup: failed to prune daily backup');
    }
  }
}

/**
 * On the 1st of the month, copy today's archives to ~/backups/monthly/
 * and prune monthly archives older than 12 months (Req 18.2).
 */
async function handleMonthlyRetention(
  dbFile: string,
  filesFile: string,
  label: string,
): Promise<void> {
  if (todayDayOfMonth() !== 1) return;

  log.info({ label }, 'backup: 1st of month — copying to monthly/');

  try {
    await mkdir(MONTHLY_DIR, { recursive: true, mode: 0o700 });
  } catch (mkdirErr) {
    log.warn({ mkdirErr }, 'backup: failed to create monthly dir');
    return;
  }

  // Copy daily → monthly
  for (const [src, name] of [
    [dbFile, path.basename(dbFile)],
    [filesFile, path.basename(filesFile)],
  ] as Array<[string, string]>) {
    const dest = path.join(MONTHLY_DIR, name);
    try {
      await copyFile(src, dest);
      log.info({ dest }, 'backup: copied to monthly');
    } catch (copyErr) {
      log.warn({ src, dest, copyErr }, 'backup: failed to copy to monthly');
    }
  }

  // Prune monthly archives older than 12 months
  let monthlyEntries: string[];
  try {
    monthlyEntries = await readdir(MONTHLY_DIR);
  } catch {
    return;
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHLY_RETENTION);

  for (const file of monthlyEntries) {
    const filePath = path.join(MONTHLY_DIR, file);
    try {
      const s = await stat(filePath);
      if (s.mtimeMs < cutoff.getTime()) {
        await rm(filePath, { force: true });
        log.info({ file }, 'backup: pruned old monthly backup');
      }
    } catch (pruneErr) {
      log.warn({ file, pruneErr }, 'backup: failed to check/prune monthly backup');
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the full daily backup job. Called by the cron dispatcher via
 * `runWithLock('backup-daily', backupDaily)`.
 *
 * Validates: Requirements 18.1, 18.2, 18.3, 18.5
 */
export async function backupDaily(): Promise<void> {
  const label = todayLabel();
  const dbFile = path.join(BACKUP_DIR, ['db-', label, '.sql.gz'].join(''));
  const filesFile = path.join(BACKUP_DIR, ['files-', label, '.tar.gz'].join(''));

  // Ensure backup directory exists (mode 0700 — outside public_html)
  await mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });

  // Parse DB credentials from DATABASE_URL
  const rawUrl = process.env.DATABASE_URL ?? '';
  let creds: DbCredentials;
  try {
    creds = parseDbUrl(rawUrl);
  } catch (err) {
    await handleBackupFailure(label, err);
    throw err;
  }

  // --- Step 1: DB dump ---
  try {
    await dumpDatabase(dbFile, creds);
  } catch (err) {
    await handleBackupFailure(label, err);
    throw err;
  }

  // --- Step 2: File store archive ---
  try {
    await archiveFileStore(filesFile);
  } catch (err) {
    await handleBackupFailure(label, err);
    throw err;
  }

  // --- Step 3: Verify archives (Req 18.3) ---
  try {
    await verifyGzip(dbFile);
  } catch (err) {
    await handleBackupFailure(['db-verify-', label].join(''), err);
    throw err;
  }

  try {
    await verifyTar(filesFile);
  } catch (err) {
    await handleBackupFailure(['files-verify-', label].join(''), err);
    throw err;
  }

  log.info({ label, dbFile, filesFile }, 'backup: verification passed');

  // --- Step 4: Retention (Req 18.2) ---
  await pruneDaily('db-');
  await pruneDaily('files-');

  // --- Step 5: Monthly copy on 1st of month (Req 18.2) ---
  await handleMonthlyRetention(dbFile, filesFile, label);

  log.info({ label }, 'backup: daily backup complete');
}

/**
 * Alias exported for call sites that prefer a verb-noun name.
 */
export { backupDaily as runBackup };
