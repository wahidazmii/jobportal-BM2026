/**
 * Cron CLI dispatcher for PT Buana Megah Job Portal (The_Portal).
 *
 * This is the single entrypoint that cPanel cron lines invoke, e.g.
 *   /home/mycdmkay/nodevenv/ptk-app/22/bin/node \
 *     /home/mycdmkay/ptk-app/dist/crons/index.mjs mail-flush
 *
 * Each sub-command maps to a task module under `src/crons/*.ts` and is
 * wrapped in `runWithLock(name, fn)` (from `src/infra/cron-lock.ts`,
 * built in parallel by task 6.2) so two cron invocations of the same job
 * cannot overlap (Design §11.1, Req 1 AC #5 — cron jobs MUST complete
 * within 60 seconds; the lock helper enforces a 55s timeout).
 *
 * Logging: pino emits structured JSON to stdout; cPanel redirects each
 * cron line's stdout/stderr into `~/logs/cron-*.log` (Design §11.2).
 *
 * Exit codes:
 *   - 0 on success or graceful overlap skip (handled inside runWithLock).
 *   - 1 on any error propagated from runWithLock (lock failure, task
 *     timeout, or task throw). Cron will surface this in the cPanel cron
 *     run summary email.
 *
 * Validates: Requirements 1.5 (Design §11.1)
 */

import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { logger } from '../infra/logger.js';
import { closePool } from '../infra/db.js';
import { runWithLock } from '../infra/cron-lock.js';

import { mailFlush } from './mail-flush.js';
import { alertDigest } from './alert-digest.js';
import { backupDaily } from './backup-daily.js';
import { sessionGc } from './session-gc.js';
import { fileArchive } from './file-archive.js';
import { auditArchive } from './audit-archive.js';
import { runSearchReindex } from './search-reindex.js';

// ---------------------------------------------------------------------------
// account-purge stub (task 47.2 — Req 16.3)
// ---------------------------------------------------------------------------

/**
 * Stub for the `account-purge` cron job.
 *
 * This job is responsible for anonymizing PII of accounts that have been
 * flagged for deletion (users.status='deleted') within the 30-day window
 * mandated by Req 16.3. Anonymization includes:
 *   - name, dob, phone, address → replaced with deterministic tokens
 *   - email → replaced with deterministic token
 *   - CV file contents → physical file deleted from File_Store
 *   - Retained minimum records: consent_records, audit_events,
 *     applications (with PII masked)
 *
 * The actual implementation is deferred; this stub satisfies the
 * dispatcher registration requirement so the cron entry can be added
 * to cPanel immediately.
 *
 * Schedule: Daily (Design §11.2 — cPanel crontab entry to be added).
 */
async function accountPurge(): Promise<void> {
  log.info('account-purge: stub — PII anonymization not yet implemented');
}

const log = logger.child({ component: 'cron-dispatcher' });

/**
 * Mapping from cron sub-command name (as used in cPanel crontab and as the
 * row key in `cron_locks`) to the implementation module's entry function.
 *
 * The keys here MUST match Design §11.2's crontab table verbatim because
 * they double as the `cron_locks.name` primary-key value used by
 * runWithLock to coordinate overlapping invocations.
 */
const CRON_TASKS: Readonly<Record<string, () => Promise<void>>> = {
  'mail-flush': mailFlush,
  'alert-digest': alertDigest,
  'backup-daily': backupDaily,
  'session-gc': sessionGc,
  'file-archive': fileArchive,
  'audit-archive': auditArchive,
  'search-reindex': runSearchReindex,
  'account-purge': accountPurge,
};

/**
 * Build the commander program. Exposed as a function (not a top-level
 * side effect) so tests can construct an isolated parser without invoking
 * `process.exit`.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('crons')
    .description('PT Buana Megah Job Portal cron dispatcher')
    .version('0.1.0');

  for (const [name, task] of Object.entries(CRON_TASKS)) {
    program
      .command(name)
      .description(`Run the ${name} cron task under runWithLock('${name}', ...)`)
      .action(async () => {
        await runWithLock(name, task);
      });
  }

  return program;
}

/**
 * Drain the shared MySQL pool so the Node process can exit promptly after
 * the cron task finishes. Best-effort: any teardown error is logged but
 * does not change the parent exit code, because the cron task itself has
 * already reported success/failure by this point.
 */
async function shutdown(): Promise<void> {
  try {
    await closePool();
  } catch (err) {
    log.warn({ err }, 'cron: pool close failed');
  }
}

/**
 * CLI entrypoint. Parses argv, runs the matched action, and exits with
 * status 0 on success or 1 on any error from `runWithLock`.
 *
 * Skipped runs (overlap with an existing lock) resolve normally inside
 * runWithLock per Design §11.1 step 2, so they also exit 0 — cron should
 * not interpret a skipped run as a failure.
 */
async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (err) {
    log.error({ err }, 'cron task failed');
    return 1;
  } finally {
    await shutdown();
  }
}

// Side-effect entrypoint: only when this file is the process entry, not
// when imported by tests. esbuild's `--bundle --format=esm` preserves
// `import.meta.url`, so the production build under
// `artifacts/api-server/dist/crons/index.mjs` still triggers main().
const entrypointArg = process.argv[1];
const isEntrypoint =
  entrypointArg !== undefined &&
  import.meta.url === pathToFileURL(entrypointArg).href;

if (isEntrypoint || process.env.CRON_FORCE_RUN === '1') {
  main(process.argv).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Defensive: main() catches its own errors, but a bug in shutdown()
      // could still escape. Surface it loudly via stderr (cron log) and
      // exit non-zero so cPanel reports the failure.
      console.error('cron dispatcher crashed:', err);
      process.exit(1);
    },
  );
}
