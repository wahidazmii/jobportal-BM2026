/**
 * Cron task: `alert-digest`.
 *
 * Evaluates saved Job_Alerts and emails each subscriber a digest of the
 * Job_Postings published since their last evaluation (Design §11.3, Req
 * 7.2-7.6). Invoked by cPanel every 15 minutes under
 * `runWithLock('alert-digest', …)` (Design §11.2).
 *
 * Pipeline:
 *   1. SELECT the due-alert batch (Design §11.3):
 *        WHERE last_evaluated_at IS NULL
 *           OR (frequency='Daily'  AND last_evaluated_at < NOW()-INTERVAL 1 DAY)
 *           OR (frequency='Weekly' AND last_evaluated_at < NOW()-INTERVAL 7 DAY)
 *        ORDER BY id LIMIT 500
 *      The remainder is picked up by the next run (natural loop via the
 *      cron schedule).
 *   2. For each alert, find Published, not-yet-expired Job_Postings
 *      published strictly after the alert's previous evaluation timestamp
 *      (`COALESCE(last_evaluated_at, epoch)`, Req 7.2) that also match the
 *      alert's keyword / locations / departments criteria.
 *   3. If ≥1 match → enqueue ONE digest email for the alert, inside a
 *      transaction, AND advance `last_evaluated_at = NOW()` in that SAME
 *      transaction. If 0 matches → DO NOT enqueue (Req 7.4) but still
 *      advance the timestamp (the alert WAS evaluated — see the Req 7.6
 *      note below).
 *
 * Timestamp advance policy (Req 7.5 / 7.6):
 *   Req 7.5 says "update the previous evaluation timestamp after
 *   processing, regardless of whether an email was sent", and Req 7.6
 *   says "IF the Mail_Sender errors, retain the previous timestamp
 *   unchanged … for later retry". Reconciling the two:
 *     - Zero matches      → CLEAN evaluation, nothing to send. Advance the
 *                           timestamp so we never re-scan the same empty
 *                           window forever (Req 7.5).
 *     - ≥1 match, enqueue
 *       SUCCEEDS           → advance the timestamp (Req 7.5). The enqueue
 *                           and the advance share one transaction so they
 *                           commit together.
 *     - ≥1 match, enqueue
 *       THROWS (SMTP/DB)   → the transaction ROLLS BACK, so the timestamp
 *                           is NOT advanced (Req 7.6). The next run sees
 *                           the same window and retries.
 *   Net rule: advance on (zero matches) OR (enqueue succeeded); never
 *   advance when an attempted enqueue failed.
 *
 * Error isolation:
 *   - Per-alert errors are caught so one failing alert (a missing mail
 *     template, an SMTP/DB blip during enqueue) never aborts the batch —
 *     the loop logs the error and moves on (Req 7.6 "log the error for
 *     later retry").
 *   - Batch-level errors (e.g. the initial SELECT throwing) propagate to
 *     `runWithLock`, which records `cron_locks.last_status='error'`
 *     (Design §11.1).
 *
 * Idempotency:
 *   The digest enqueue passes `targetId: null` — per migration 0006's
 *   note, `(alert_digest, NULL)` rows are intentionally NOT natural-key
 *   deduped (each run produces a distinct row). Re-send protection comes
 *   from the `last_evaluated_at` window, not the outbox unique key.
 *
 * Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6 (Design §11.3)
 */

import { logger } from '../infra/logger.js';
import { withTransaction } from '../infra/db.js';
import { enqueue } from '../modules/mail/service.js';
import {
  listDueForDigest,
  findMatchingJobs,
  markEvaluated,
  EPOCH,
  type DueAlert,
  type MatchingJob,
} from '../modules/alerts/digest-repo.js';

const log = logger.child({ cron: 'alert-digest' });

/** Template key for the digest email (migration 0006 names `alert_digest`). */
const DIGEST_TEMPLATE_KEY = 'alert_digest';

/**
 * Resolve the canonical absolute base URL for digest links. Mirrors the
 * `BASE_URL`-with-localhost-fallback convention used by `routes/seo.ts`
 * and `routes/public.ts` so a digest email links to real, absolute job
 * detail pages in production. Read lazily (not at module-load) so it
 * honours whatever Passenger injects at cron-run time.
 */
function resolveBaseUrl(): string {
  const raw = process.env.BASE_URL ?? 'http://localhost:3000';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** Per-run tally surfaced in the summary log line. */
interface DigestCounters {
  evaluated: number;
  emailed: number;
  skippedNoMatch: number;
  failed: number;
}

/** Trim an error to a short message for structured logging. */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shape the matched jobs for the Nunjucks template context. We hand the
 * template a small, render-ready array (title, location, slug, locale)
 * rather than the raw DB row so the template stays dumb and the
 * `mail_outbox.context` JSON snapshot is compact.
 */
function toTemplateJobs(
  jobs: readonly MatchingJob[],
  locale: 'id' | 'en',
): ReadonlyArray<Record<string, unknown>> {
  const baseUrl = resolveBaseUrl();
  return jobs.map((j) => ({
    id: j.id,
    slug: j.slug,
    // Fall back to the slug if a job somehow has no translation row, so
    // the email always shows something clickable.
    title: j.title ?? j.slug,
    location: j.location,
    url: `${baseUrl}/${locale}/jobs/${encodeURIComponent(j.slug)}`,
  }));
}

/**
 * Process a single due alert.
 *
 * Returns the bucket the alert landed in so the caller can tally:
 *   - 'emailed'      → ≥1 match, digest enqueued, timestamp advanced.
 *   - 'no_match'     → 0 matches, no email, timestamp advanced.
 *   - (throws)       → enqueue failed; the transaction rolled back so the
 *                      timestamp is unchanged. The caller catches, logs,
 *                      and counts it as `failed` (Req 7.6).
 */
async function processAlert(alert: DueAlert): Promise<'emailed' | 'no_match'> {
  // Req 7.2: only postings published since the previous evaluation. A
  // never-evaluated alert uses the epoch floor so its first run includes
  // every currently-published posting.
  const since = alert.lastEvaluatedAt ?? EPOCH;
  const jobs = await findMatchingJobs(alert, since);

  if (jobs.length === 0) {
    // Req 7.4: no email. Req 7.5: still a clean evaluation — advance the
    // timestamp (no enqueue to bind it to, so a plain pool UPDATE).
    await markEvaluated(alert.id);
    return 'no_match';
  }

  // Req 7.3 + 7.5 + 7.6: enqueue the digest AND advance the timestamp in
  // ONE transaction. If the enqueue throws (missing template, SMTP/DB
  // error), the whole transaction rolls back and the timestamp stays put
  // so the next run retries the same window.
  await withTransaction(async (conn) => {
    await enqueue(conn, {
      templateKey: DIGEST_TEMPLATE_KEY,
      toEmail: alert.applicantEmail,
      toName: alert.applicantName,
      locale: alert.locale,
      context: {
        alert: {
          id: alert.id,
          keyword: alert.keyword,
          frequency: alert.frequency,
        },
        applicant: { name: alert.applicantName },
        jobs: toTemplateJobs(jobs, alert.locale),
        count: jobs.length,
      },
      // Digests are intentionally NOT natural-key deduped (migration 0006).
      targetId: null,
    });

    // Only reached when the enqueue succeeded — advancing here keeps the
    // timestamp move atomic with the outbox INSERT (Req 7.6).
    await markEvaluated(alert.id, conn);
  });

  return 'emailed';
}

/**
 * Run a single alert-digest evaluation pass. Resolves when the batch is
 * drained (or empty). The initial SELECT is intentionally NOT wrapped in
 * a try/catch so a batch-level failure propagates to `runWithLock` and is
 * recorded as `cron_locks.last_status='error'` (Design §11.1).
 */
export async function alertDigest(): Promise<void> {
  const startedAt = Date.now();
  const counters: DigestCounters = {
    evaluated: 0,
    emailed: 0,
    skippedNoMatch: 0,
    failed: 0,
  };

  // 1. SELECT the due batch. Errors here propagate (batch-level).
  const alerts = await listDueForDigest();

  // 2-3. Evaluate each alert. Per-alert errors are caught so one bad
  // alert never aborts the batch (Req 7.6).
  for (const alert of alerts) {
    counters.evaluated += 1;
    try {
      const outcome = await processAlert(alert);
      if (outcome === 'emailed') counters.emailed += 1;
      else counters.skippedNoMatch += 1;
    } catch (err) {
      // Req 7.6: the enqueue failed; the transaction rolled back so the
      // timestamp is unchanged. Log for later retry and continue.
      counters.failed += 1;
      log.error(
        {
          event: 'alert_digest_error',
          alert_id: alert.id,
          applicant_user_id: alert.applicantUserId,
          error: toMessage(err),
        },
        'alert-digest: per-alert evaluation failed; timestamp retained',
      );
    }
  }

  // 4. Summary line.
  log.info(
    {
      event: 'alert_digest_done',
      evaluated: counters.evaluated,
      emailed: counters.emailed,
      skipped_no_match: counters.skippedNoMatch,
      failed: counters.failed,
      duration_ms: Date.now() - startedAt,
    },
    'alert-digest: completed',
  );
}
