#!/usr/bin/env node
/**
 * tools/migrate.mjs — schema migration CLI for PT Buana Megah Job Portal.
 *
 * Sub-commands:
 *   up      Apply every pending `migrations/<id>.sql` file in lexical
 *           order. Each file runs in its own transaction on its own
 *           pooled connection, so a failure in file N does not pollute
 *           the connection used by file N+1 (Req 19 AC #2/#3).
 *   down    Roll back the most recently applied migration if a matching
 *           `migrations/<id>.down.sql` exists. Exits with a clear error
 *           when no `down` file is provided.
 *   status  Print every known migration with one of three flags:
 *             ✓  applied and on-disk checksum matches the recorded one
 *             ○  pending (file present, not yet applied)
 *             ✗  modified (applied row exists but file content changed)
 *
 * Direct invocation on the cPanel host (Req 19 AC #1, #5):
 *   /home/mycdmkay/nodevenv/ptk-app/22/bin/node tools/migrate.mjs up
 *
 * Design constraints (§5, §17, Req 19):
 *   - File ID = filename without `.sql`, e.g. `0001_init.sql` → `0001_init`.
 *     IDs sort lexicographically; the four-digit prefix enforces order
 *     even after dozens of migrations are added.
 *   - SHA-256 checksum of the raw file bytes is recorded alongside the id
 *     and filename in `schema_migrations(id, filename, checksum,
 *     applied_at)`. Any drift between disk and DB is fatal on `up` —
 *     migrations are append-only by contract; modifying an applied file
 *     forces operators to make the change explicit.
 *   - Idempotent: re-running `up` against an up-to-date database is a
 *     no-op that prints "Up to date" and exits 0 (Req 19 AC #2 — the
 *     applied checksum is consulted to skip already-applied files).
 *   - The CLI uses its OWN short-lived `createPool` (NOT the shared
 *     `src/infra/db.ts` pool) with `multipleStatements: true` so the
 *     application bundle does not need to be built before running
 *     migrations on a fresh deploy. A small pool with one connection
 *     per migration provides transaction isolation between files.
 *   - Database credentials come exclusively from `process.env.DATABASE_URL`
 *     (Req 1 AC #9) — there is no fallback or `.env` file lookup.
 *
 * Exit codes:
 *   0  success or `status` printed normally
 *   1  fatal error (missing env, IO error, SQL failure, checksum drift,
 *      missing `<id>.down.sql`, or unknown command)
 *
 * Validates: Requirements 19.1, 19.2, 19.3, 19.5 (Design §5, §17).
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';
import { Command } from 'commander';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'migrations');

/** Filename pattern for forward migrations: `0001_init.sql`, `0002_jobs.sql`, … */
const UP_FILE_RE = /^(\d{4,}_[a-z0-9_]+)\.sql$/i;
/** Filename pattern for matching reverse migrations: `0001_init.down.sql`. */
const DOWN_SUFFIX = '.down.sql';

/**
 * Read the connection URI from the environment. Throws so the CLI exits
 * with a clear error if the operator forgot to export it from the cPanel
 * "Setup Node.js App" panel.
 */
function requireDatabaseUrl() {
  const uri = process.env.DATABASE_URL;
  if (!uri || uri.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. Export it via cPanel "Setup Node.js App" ' +
        'environment variables before running migrations (Req 1 AC #9).',
    );
  }
  return uri;
}

/**
 * Open a fresh, short-lived mysql2 pool configured for migrations.
 *
 * Why a pool? Each migration runs on its own `getConnection()` so the
 * transactions are isolated — a failed BEGIN/ROLLBACK on file N cannot
 * leave session state (lock_wait_timeout overrides, autocommit toggles)
 * that affects file N+1. The pool is small because cPanel shared MySQL
 * caps total connections per cPanel user; we never need more than one
 * connection at a time during migrations.
 *
 * `multipleStatements: true` is required so a single `.sql` file may
 * contain several DDL/DML statements separated by `;`. Connections are
 * NOT long-lived; the CLI process exits as soon as the command
 * completes, which limits the blast radius of a misbehaving statement.
 */
function createMigrationPool() {
  return mysql.createPool({
    uri: requireDatabaseUrl(),
    multipleStatements: true,
    connectionLimit: 1,
    waitForConnections: true,
    timezone: 'Z',
    namedPlaceholders: true,
    decimalNumbers: true,
  });
}

/**
 * Compute the canonical SHA-256 checksum of a migration file. The checksum
 * covers the raw bytes verbatim (no normalisation) so that any whitespace
 * tweak forces operators to acknowledge the change rather than silently
 * shipping a different SQL.
 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Discover migration files on disk and return them sorted by id (which is
 * the four-digit-prefix lexical order). `.down.sql` files are filtered out
 * here — they're only consulted by the `down` command.
 */
async function discoverMigrationFiles() {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `migrations/ directory not found at ${MIGRATIONS_DIR}. ` +
          'Create it and add 0001_init.sql before running migrate.',
      );
    }
    throw err;
  }

  const files = [];
  for (const name of entries) {
    if (name.endsWith(DOWN_SUFFIX)) continue;
    const m = UP_FILE_RE.exec(name);
    if (!m) continue;
    const filePath = resolve(MIGRATIONS_DIR, name);
    const st = await stat(filePath);
    if (!st.isFile()) continue;
    files.push({ id: m[1], filename: name, path: filePath });
  }
  files.sort((a, b) => a.id.localeCompare(b.id));
  return files;
}

/**
 * Ensure the bookkeeping table exists. Mirrors the canonical DDL from
 * design §7.2 and `0001_init.sql` so the very first migration's
 * `CREATE TABLE IF NOT EXISTS schema_migrations …` is a no-op.
 *
 * Schema columns (per task 5.1 spec):
 *   id          — VARCHAR(64) — filename without `.sql`, e.g. "0001_init"
 *   filename    — VARCHAR(150) — original filename, e.g. "0001_init.sql"
 *   checksum    — CHAR(64) — SHA-256 hex of file bytes
 *   applied_at  — DATETIME — server time at successful apply
 *
 * Uses `CREATE TABLE IF NOT EXISTS` so it composes cleanly with
 * `0001_init.sql`, which (also using IF NOT EXISTS) may try to create
 * the same table during its forward migration.
 */
async function ensureMigrationsTable(connection) {
  await connection.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id VARCHAR(64) NOT NULL,
       filename VARCHAR(150) NOT NULL,
       checksum CHAR(64) NOT NULL,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

/**
 * Load every row from `schema_migrations` keyed by id for O(1) lookups
 * against the disk listing. The set is small (one row per migration ever
 * applied), so a full table scan is cheap and avoids per-file round trips.
 */
async function loadAppliedMigrations(connection) {
  const [rows] = await connection.query(
    `SELECT id, filename, checksum, applied_at
       FROM schema_migrations
      ORDER BY id ASC`,
  );
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      filename: row.filename,
      checksum: row.checksum,
      applied_at: row.applied_at,
    });
  }
  return byId;
}

/**
 * Format a duration (ms) for the user-facing log. We intentionally use ms
 * with no decimal — the audience is operators tailing the deploy log on a
 * shared host, not a profiler.
 */
function formatMs(ms) {
  return `${Math.max(0, Math.round(ms))} ms`;
}

/**
 * Apply a single migration file inside a transaction on its own pooled
 * connection. The caller is responsible for sequencing across files and
 * for mapping a thrown error to a non-zero exit code.
 *
 * On failure: ROLLBACK is issued (best-effort — DDL implicitly commits
 * on MySQL/MariaDB, so the rollback is structural for schema-only
 * migrations), the connection is released, and a `MigrationError` is
 * thrown. The `INSERT INTO schema_migrations` row is the durable
 * "this succeeded" marker — its absence guarantees the file will be
 * retried on the next `up` run.
 */
async function applyMigration(pool, file) {
  const buf = await readFile(file.path);
  const checksum = sha256(buf);
  const sql = buf.toString('utf8');

  process.stdout.write(`Applying ${file.id}... `);
  const startedAt = Date.now();

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      // mysql2 honours multipleStatements: true for `.query()` so the
      // entire file body executes in one round trip. `.execute()` would
      // NOT work here because prepared statements forbid multi-statement
      // payloads.
      await connection.query(sql);
      await connection.query(
        `INSERT INTO schema_migrations (id, filename, checksum) VALUES (?, ?, ?)`,
        [file.id, file.filename, checksum],
      );
      await connection.commit();
    } catch (err) {
      try {
        await connection.rollback();
      } catch {
        // Rollback failures are swallowed so the original SQL error
        // surfaces — DDL statements implicitly commit on MySQL, so the
        // rollback may be a structural no-op anyway.
      }
      process.stdout.write('✗\n');
      throw new MigrationError(file, err);
    }
  } finally {
    connection.release();
  }

  process.stdout.write(`✓ (${formatMs(Date.now() - startedAt)})\n`);
  return checksum;
}

/**
 * Distinct error class so the top-level command handlers can format a
 * deploy-log-friendly message ("Migration 0002_jobs failed: …") while
 * still preserving the underlying SQL/IO error for the exit-code path.
 */
class MigrationError extends Error {
  constructor(file, cause) {
    super(`Migration ${file.id} failed: ${cause?.message ?? cause}`);
    this.name = 'MigrationError';
    this.file = file;
    this.cause = cause;
  }
}

/**
 * Verify that every migration recorded in `schema_migrations` still
 * matches its on-disk checksum. Modifying an already-applied migration
 * is treated as an operator error: the SQL has either drifted from what
 * the database actually contains, or someone is trying to retro-fit a
 * change without a new migration file. Either way we refuse to proceed.
 *
 * Returns the list of pending files (sorted) ready to be applied.
 */
async function planUp(connection) {
  const files = await discoverMigrationFiles();
  const applied = await loadAppliedMigrations(connection);

  const pending = [];
  for (const file of files) {
    const dbRow = applied.get(file.id);
    if (!dbRow) {
      pending.push(file);
      continue;
    }
    // Already applied — verify checksum matches before we move on.
    const buf = await readFile(file.path);
    const diskSum = sha256(buf);
    if (diskSum !== dbRow.checksum) {
      throw new Error(
        `Checksum mismatch for ${file.id}: ` +
          `recorded=${dbRow.checksum.slice(0, 12)}…, disk=${diskSum.slice(0, 12)}…. ` +
          'A migration that has already been applied was modified on disk. ' +
          'Migrations are append-only — revert the file or write a new ' +
          'migration to express the change.',
      );
    }
  }

  // Surface applied rows whose source file vanished. Not fatal for the
  // up path (we cannot un-apply something we no longer have SQL for),
  // but operators should know.
  for (const id of applied.keys()) {
    if (!files.find((f) => f.id === id)) {
      console.log(
        `Note: applied migration ${id} has no matching file on disk.`,
      );
    }
  }

  return pending;
}

/* -------------------------------------------------------------------------- */
/*                                  Commands                                  */
/* -------------------------------------------------------------------------- */

async function cmdUp() {
  const pool = createMigrationPool();
  try {
    // Bootstrap + planning use a single connection that is released
    // before the per-migration loop so each apply gets its own.
    const bootstrap = await pool.getConnection();
    let pending;
    try {
      await ensureMigrationsTable(bootstrap);
      pending = await planUp(bootstrap);
    } finally {
      bootstrap.release();
    }

    if (pending.length === 0) {
      console.log('Up to date');
      return;
    }

    console.log(`${pending.length} pending migration(s).`);
    for (const file of pending) {
      await applyMigration(pool, file);
    }
    console.log(
      `Applied ${pending.length} migration(s)`,
    );
  } finally {
    await pool.end();
  }
}

async function cmdDown() {
  const pool = createMigrationPool();
  try {
    const bootstrap = await pool.getConnection();
    let lastId;
    let downName;
    let downPath;
    let downSql;
    try {
      await ensureMigrationsTable(bootstrap);
      const applied = await loadAppliedMigrations(bootstrap);
      if (applied.size === 0) {
        console.log('No migrations applied. Nothing to roll back.');
        return;
      }

      // Map iteration order matches insertion (id ASC); we want the
      // LAST applied id, so take the final entry.
      const ids = [...applied.keys()];
      lastId = ids[ids.length - 1];
      downName = `${lastId}${DOWN_SUFFIX}`;
      downPath = resolve(MIGRATIONS_DIR, downName);

      try {
        downSql = await readFile(downPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(
            `Cannot roll back ${lastId}: ${downName} is not present in ` +
              'migrations/. Down migrations are required for `down` — ' +
              'create the file or revert manually.',
          );
        }
        throw err;
      }
    } finally {
      bootstrap.release();
    }

    process.stdout.write(`Rolling back ${lastId}... `);
    const startedAt = Date.now();

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      try {
        await connection.query(downSql);
        await connection.query(
          `DELETE FROM schema_migrations WHERE id = ?`,
          [lastId],
        );
        await connection.commit();
      } catch (err) {
        try {
          await connection.rollback();
        } catch {
          // see applyMigration() — DDL implicit commit caveat applies here too.
        }
        process.stdout.write('✗\n');
        throw new MigrationError({ id: lastId, filename: downName }, err);
      }
    } finally {
      connection.release();
    }

    process.stdout.write(`✓ (${formatMs(Date.now() - startedAt)})\n`);
    console.log(`Rolled back ${lastId} using ${downName}.`);
  } finally {
    await pool.end();
  }
}

/**
 * Print a table summarising every known migration. Columns:
 *   STATUS  ID  APPLIED_AT
 * Where STATUS is one of:
 *   ✓  applied and disk file matches recorded checksum
 *   ○  pending (file present on disk, not yet applied)
 *   ✗  modified — applied row exists but disk file checksum differs
 *
 * A row also tagged with "(missing)" when an applied migration has no
 * file on disk (likely deleted). None of these states change the exit
 * code: `status` is purely informational.
 */
async function cmdStatus() {
  const pool = createMigrationPool();
  try {
    const connection = await pool.getConnection();
    let rows;
    let warnings;
    try {
      await ensureMigrationsTable(connection);
      const files = await discoverMigrationFiles();
      const applied = await loadAppliedMigrations(connection);

      const idsOnDisk = new Set(files.map((f) => f.id));
      const idsApplied = new Set(applied.keys());
      const allIds = [...new Set([...idsOnDisk, ...idsApplied])].sort((a, b) =>
        a.localeCompare(b),
      );

      rows = [];
      warnings = { modified: 0, missing: 0 };
      for (const id of allIds) {
        const file = files.find((f) => f.id === id);
        const dbRow = applied.get(id);
        let symbol;
        let label;
        if (!dbRow) {
          symbol = '○';
          label = 'pending';
        } else if (!file) {
          symbol = '✗';
          label = 'missing';
          warnings.missing += 1;
        } else {
          const buf = await readFile(file.path);
          const diskSum = sha256(buf);
          if (diskSum === dbRow.checksum) {
            symbol = '✓';
            label = 'applied';
          } else {
            symbol = '✗';
            label = 'modified';
            warnings.modified += 1;
          }
        }
        rows.push({
          id,
          symbol,
          label,
          applied_at: dbRow ? formatTimestamp(dbRow.applied_at) : '-',
        });
      }
    } finally {
      connection.release();
    }

    if (rows.length === 0) {
      console.log('No migrations on disk and none applied.');
      return;
    }

    const idWidth = Math.max(2, ...rows.map((r) => r.id.length));
    const tsWidth = Math.max(10, ...rows.map((r) => r.applied_at.length));
    const lblWidth = Math.max(6, ...rows.map((r) => r.label.length));

    const header =
      ' ' +
      'ID'.padEnd(idWidth) +
      '  ' +
      'STATUS'.padEnd(lblWidth) +
      '  ' +
      'APPLIED_AT'.padEnd(tsWidth);
    const rule = '-'.repeat(header.length);

    console.log(header);
    console.log(rule);
    for (const r of rows) {
      console.log(
        r.symbol +
          ' ' +
          r.id.padEnd(idWidth) +
          '  ' +
          r.label.padEnd(lblWidth) +
          '  ' +
          r.applied_at.padEnd(tsWidth),
      );
    }

    if (warnings.modified > 0 || warnings.missing > 0) {
      console.log('');
      if (warnings.modified > 0) {
        console.log(
          `WARNING: ${warnings.modified} migration(s) have on-disk content ` +
            'that no longer matches the recorded SHA-256. ' +
            '`up` will refuse to run until this is resolved.',
        );
      }
      if (warnings.missing > 0) {
        console.log(
          `WARNING: ${warnings.missing} applied migration(s) have no ` +
            'corresponding file on disk.',
        );
      }
    }
  } finally {
    await pool.end();
  }
}

/**
 * Render a DATETIME (returned from mysql2 as a JS Date) into a stable
 * `YYYY-MM-DD HH:mm:ss` UTC string for the `status` table. Falls back to
 * the raw value if mysql2 ever returns a string in some driver mode.
 */
function formatTimestamp(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '-';
    const iso = value.toISOString(); // 2025-01-02T03:04:05.000Z
    return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
  }
  return String(value ?? '-');
}

/* -------------------------------------------------------------------------- */
/*                                  Entry                                     */
/* -------------------------------------------------------------------------- */

const program = new Command();
program
  .name('migrate')
  .description(
    'Schema migration CLI for PT Buana Megah Job Portal (cPanel-friendly).',
  )
  .showHelpAfterError();

program
  .command('up')
  .description('Apply every pending migration in migrations/.')
  .action(async () => {
    await cmdUp();
  });

program
  .command('down')
  .description(
    'Roll back the most recently applied migration if a matching ' +
      '<id>.down.sql exists in migrations/.',
  )
  .action(async () => {
    await cmdDown();
  });

program
  .command('status')
  .description(
    'Show which migrations are applied (✓), pending (○), or modified (✗).',
  )
  .action(async () => {
    await cmdStatus();
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof MigrationError) {
    console.error(err.message);
  } else {
    console.error(`migrate: ${err.message ?? err}`);
  }
  process.exitCode = 1;
});
