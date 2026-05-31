/**
 * Cron task: `search-reindex`.
 *
 * Weekly housekeeping (Sunday 03:30 WIB, Design §11.2) that runs
 * `OPTIMIZE TABLE` against the FULLTEXT-bearing job tables. The
 * `job_postings.search_text` column drives FULLTEXT lookups for the
 * public `/jobs` listing and is rewritten on every CREATE/UPDATE in
 * `jobs.repo.save()` (Design §10.4). Frequent rewrites fragment the
 * underlying InnoDB pages and the FULLTEXT auxiliary tables; OPTIMIZE
 * rebuilds them so search queries stay fast over time.
 *
 * `job_posting_translations` is much smaller (one row per posting per
 * locale) but lives in the same query path via JOIN, so we keep it
 * fresh in the same sweep — both writes happen inside the same cron
 * window outside business hours so the table-level locks MySQL takes
 * during OPTIMIZE don't block job admins or applicants.
 *
 * After the rebuild succeeds we invalidate any in-process search cache
 * (`clearSearchCache` from `modules/jobs/search.ts`, task 22.1). The
 * helper is loaded via dynamic import so this cron remains importable
 * even when the search module is being added in a parallel task — a
 * missing/unimplemented helper degrades to a no-op and the cron still
 * succeeds, since the OPTIMIZE itself is the primary deliverable.
 *
 * Implementation notes:
 *   - We use `query<T>` from `infra/db.ts`, which routes through
 *     `pool.execute` (prepared statements). OPTIMIZE TABLE is supported
 *     by MySQL's binary protocol and the table names are SQL literals
 *     here (never user input), so prepared-statement execution is safe.
 *   - No transaction wrapping — OPTIMIZE TABLE is a single
 *     auto-committing maintenance statement; the dispatcher already
 *     coordinates retries via `runWithLock` (Design §11.1).
 *   - Errors propagate to `runWithLock`, which records
 *     `cron_locks.last_status='error'` plus the truncated message so
 *     cPanel operators can see the failure without trawling logs
 *     (Design §11.1).
 *
 * Validates: Requirements 1.5 (Design §10.4, §11.2)
 */

import { query } from '../infra/db.js';
import { logger } from '../infra/logger.js';

const log = logger.child({ cron: 'search-reindex' });

/**
 * SQL constants. OPTIMIZE TABLE accepts no placeholders so string literals
 * are correct here — the lint rule `local/no-string-concat-sql` only
 * flags dynamic interpolation, which we do not perform.
 */
const OPTIMIZE_JOB_POSTINGS_SQL = 'OPTIMIZE TABLE job_postings';
const OPTIMIZE_JOB_POSTING_TRANSLATIONS_SQL =
  'OPTIMIZE TABLE job_posting_translations';

/**
 * Best-effort search-cache invalidation. The helper is owned by task
 * 22.1's `src/modules/jobs/search.ts` which may not exist yet when
 * this cron runs in development; in production the file is bundled
 * alongside the cron and the import resolves cleanly.
 *
 * Failures here never propagate — a stale cache is a soft degradation
 * compared to the OPTIMIZE TABLE work which is the cron's contract.
 */
async function tryClearSearchCache(): Promise<void> {
  try {
    const mod = (await import('../modules/jobs/search.js')) as {
      clearSearchCache?: () => void | Promise<void>;
    };
    if (typeof mod.clearSearchCache === 'function') {
      await mod.clearSearchCache();
    }
  } catch (err) {
    // Missing module / unimplemented helper — log at debug so the cron
    // log stays quiet in production where the import resolves.
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'search-reindex: clearSearchCache helper unavailable',
    );
  }
}

/**
 * Run a single weekly OPTIMIZE pass on the FULLTEXT-bearing job tables.
 *
 * On success: logs `{ start_at, duration_ms, tables_optimized, status: 'ok' }`
 * at info level. On failure: logs the same fields plus the truncated
 * error message at error level and re-throws so `runWithLock` records
 * `last_status='error'` per the dispatcher contract.
 */
export async function runSearchReindex(): Promise<void> {
  const startedAt = Date.now();
  const startAtIso = new Date(startedAt).toISOString();
  let tablesOptimized = 0;

  try {
    await query(OPTIMIZE_JOB_POSTINGS_SQL);
    tablesOptimized += 1;

    await query(OPTIMIZE_JOB_POSTING_TRANSLATIONS_SQL);
    tablesOptimized += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        cron: 'search-reindex',
        start_at: startAtIso,
        duration_ms: Date.now() - startedAt,
        tables_optimized: tablesOptimized,
        error: message,
        status: 'failed',
      },
      'search-reindex: OPTIMIZE TABLE failed',
    );
    // Re-throw so `runWithLock` persists `last_status='error'` + last_error.
    throw err;
  }

  await tryClearSearchCache();

  log.info(
    {
      cron: 'search-reindex',
      start_at: startAtIso,
      duration_ms: Date.now() - startedAt,
      tables_optimized: tablesOptimized,
      status: 'ok',
    },
    'search-reindex: OPTIMIZE TABLE completed',
  );
}
