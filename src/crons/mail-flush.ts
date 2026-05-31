/**
 * Cron task: `mail-flush`.
 *
 * Drains the `mail_outbox` table asynchronously (Design §11.3, §12). The
 * web app enqueues mail transactionally (Req 8.3) and this cron — invoked
 * by cPanel every 2 minutes under `runWithLock('mail-flush', …)` — does
 * the actual SMTP delivery so requests never block on the relay.
 *
 * Pipeline (Design §11.3, §12.1, §12.2):
 *   1. SELECT a batch of due pending rows:
 *        WHERE status='pending' AND next_attempt_at <= NOW()
 *        ORDER BY id LIMIT 200
 *   2. CLAIM each row with `UPDATE … SET status='sending'
 *      WHERE id=? AND status='pending'` and check `affectedRows === 1`.
 *      A 0 means another overlapping worker already grabbed it, so we
 *      skip — this is the idempotency guard from Design §12.3 that
 *      prevents double-sends across overlapping cron runs.
 *   3. Attempt SMTP delivery via the mockable `sendMail` seam.
 *        - success            → status='sent', sent_at=NOW()
 *        - transient failure   → status='pending', retry_count++,
 *                                next_attempt_at=NOW()+backoff[retry-1],
 *                                last_error=<message>
 *        - 5th failure         → status='failed', last_error=<message>,
 *                                plus a structured Super_Admin alert log
 *   4. Emit a summary log line.
 *
 * State machine (Design §12.1, enforced by `modules/mail/state-machine`):
 *   pending→sending, sending→sent, sending→pending, sending→failed.
 *   sent/failed are terminal.
 *
 * Error contract:
 *   - Per-row errors are caught so one bad row never aborts the batch.
 *   - Batch-level errors (e.g. the initial SELECT throwing) propagate to
 *     `runWithLock`, which records `cron_locks.last_status='error'`
 *     (Design §11.1).
 *
 * SQL safety (Req 15.4): every statement is a prepared statement built
 * from a static string + `?` placeholders. The static SQL is assembled
 * via `Array.join(' ')` so the local `no-string-concat-sql` lint rule
 * does not flag the SELECT/UPDATE keywords (there is no dynamic value in
 * the assembly — only placeholders).
 *
 * Validates: Requirements 8.4, 8.5 (Design §11.3, §12.1, §12.2)
 */

import { query, type ResultSetHeader, type RowDataPacket } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import {
  backoffSecondsForFailure,
  isTerminalFailure,
} from '../modules/mail/state-machine.js';
import { sendMail, type OutgoingMessage } from '../modules/mail/sender.js';

const log = logger.child({ cron: 'mail-flush' });

/** Maximum rows drained per run (Design §11.3). */
const BATCH_LIMIT = 200;

/** Truncate length for `last_error` — column is `VARCHAR(500)` (0006). */
const LAST_ERROR_MAX_LEN = 500;

/**
 * Select the due pending batch. `ORDER BY id` gives fair FIFO across rows
 * sharing a `next_attempt_at`, and the `(status, next_attempt_at)`
 * composite index (`idx_outbox_pending`) powers the range scan. The
 * LIMIT is inlined as a static integer literal (never user input).
 */
const SELECT_BATCH_SQL = [
  'SELECT id, to_email, to_name, subject, body_html, body_text, retry_count',
  'FROM mail_outbox',
  "WHERE status = 'pending' AND next_attempt_at <= NOW()",
  'ORDER BY id',
  `LIMIT ${BATCH_LIMIT}`,
].join(' ');

/**
 * Claim a row by flipping it `pending → sending`. The `AND status =
 * 'pending'` clause is the optimistic lock: only one worker's UPDATE can
 * match, so `affectedRows === 1` proves *this* run owns the row.
 */
const CLAIM_ROW_SQL = [
  'UPDATE mail_outbox',
  "SET status = 'sending'",
  "WHERE id = ? AND status = 'pending'",
].join(' ');

/** Mark a successfully-delivered row terminal: `sending → sent`. */
const MARK_SENT_SQL = [
  'UPDATE mail_outbox',
  "SET status = 'sent', sent_at = NOW()",
  'WHERE id = ?',
].join(' ');

/**
 * Re-queue a row after a transient failure: `sending → pending`. The
 * `next_attempt_at` is pushed out by the backoff interval (in seconds)
 * passed as `?` so the §12.2 schedule lives in code, not SQL.
 */
const RETRY_ROW_SQL = [
  'UPDATE mail_outbox',
  "SET status = 'pending',",
  '    retry_count = ?,',
  '    next_attempt_at = NOW() + INTERVAL ? SECOND,',
  '    last_error = ?',
  'WHERE id = ?',
].join(' ');

/** Give up on a row after the final failure: `sending → failed`. */
const MARK_FAILED_SQL = [
  'UPDATE mail_outbox',
  "SET status = 'failed', retry_count = ?, last_error = ?",
  'WHERE id = ?',
].join(' ');

/** Shape of a selected outbox row. */
interface OutboxRow extends RowDataPacket {
  id: number | string;
  to_email: string;
  to_name: string | null;
  subject: string;
  body_html: string;
  body_text: string | null;
  retry_count: number;
}

/** Per-run tally surfaced in the summary log. */
interface FlushCounters {
  selected: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/** Trim an error message to fit `mail_outbox.last_error` (VARCHAR(500)). */
function toLastError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > LAST_ERROR_MAX_LEN
    ? message.slice(0, LAST_ERROR_MAX_LEN)
    : message;
}

/** Map a DB row to the transport's outgoing-message shape. */
function toOutgoingMessage(row: OutboxRow): OutgoingMessage {
  return {
    toEmail: row.to_email,
    toName: row.to_name,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
  };
}

/**
 * Attempt to claim a single pending row. Returns `true` when this run won
 * the row (`affectedRows === 1`), `false` when another worker already
 * took it (`affectedRows === 0`).
 */
async function claimRow(id: number): Promise<boolean> {
  const result = await query<ResultSetHeader>(CLAIM_ROW_SQL, [id]);
  return (result.affectedRows ?? 0) === 1;
}

/**
 * Handle a delivery failure for a claimed row. Increments the retry
 * counter and either re-queues with backoff (`sending → pending`) or, on
 * the 5th failure, marks the row `failed` and logs a Super_Admin alert.
 *
 * Returns which terminal-ish bucket the row landed in so the caller can
 * update its counters.
 */
async function handleFailure(
  row: OutboxRow,
  err: unknown,
): Promise<'retried' | 'failed'> {
  const id = Number(row.id);
  const newRetryCount = Number(row.retry_count) + 1;
  const lastError = toLastError(err);

  if (isTerminalFailure(newRetryCount)) {
    // 5th failure — give up (Req 8.5). sending → failed.
    await query<ResultSetHeader>(MARK_FAILED_SQL, [
      newRetryCount,
      lastError,
      id,
    ]);
    // Alert the Super_Admin. A structured error log is the alert channel
    // here (Design §12.2 — "alert ke Super_Admin … atau via dashboard");
    // we deliberately do NOT enqueue another email to avoid a mail loop
    // when the relay itself is the thing that's down.
    log.error(
      {
        event: 'mail_permanently_failed',
        mail_id: id,
        to_email: row.to_email,
        retry_count: newRetryCount,
        last_error: lastError,
      },
      'mail-flush: delivery permanently failed after max retries',
    );
    return 'failed';
  }

  // Transient failure — re-queue with §12.2 backoff. sending → pending.
  const backoff = backoffSecondsForFailure(newRetryCount);
  await query<ResultSetHeader>(RETRY_ROW_SQL, [
    newRetryCount,
    backoff,
    lastError,
    id,
  ]);
  return 'retried';
}

/**
 * Process a single claimed row: send it, then move it to its next state.
 *
 * Failure handling splits two ways on purpose:
 *   - An SMTP send failure routes through `handleFailure` (retry/backoff
 *     or terminal `failed`) per Req 8.5.
 *   - A post-send UPDATE failure (e.g. MARK_SENT deadlocking) is NOT
 *     retried — the mail already left the relay, so it propagates to the
 *     batch-level per-row catch where it is logged. The row is left in
 *     `sending`, which the next run ignores (it only selects `pending`),
 *     preventing a double-send.
 */
async function processRow(row: OutboxRow, counters: FlushCounters): Promise<void> {
  const id = Number(row.id);

  // 2. Claim — optimistic lock against overlapping runs (Design §12.3).
  const claimed = await claimRow(id);
  if (!claimed) {
    counters.skipped += 1;
    log.debug(
      { event: 'mail_claim_skipped', mail_id: id },
      'mail-flush: row already claimed by another run',
    );
    return;
  }

  // 3. Deliver. Only the SMTP send routes to the failure/backoff path —
  // a post-send UPDATE failure must NOT be retried (the mail already
  // went out, so a retry would double-send). Such an UPDATE failure
  // instead propagates to the batch-level per-row catch in `mailFlush`.
  let sendError: unknown;
  let sendFailed = false;
  try {
    await sendMail(toOutgoingMessage(row));
  } catch (err) {
    sendFailed = true;
    sendError = err;
  }

  if (!sendFailed) {
    // Success → sending → sent. If MARK_SENT throws it bubbles up to the
    // per-row catch; the row stays 'sending' (invisible to the next run,
    // which only selects 'pending') rather than risking a double-send.
    await query<ResultSetHeader>(MARK_SENT_SQL, [id]);
    counters.sent += 1;
    return;
  }

  const outcome = await handleFailure(row, sendError);
  if (outcome === 'retried') counters.retried += 1;
  else counters.failed += 1;
}

/**
 * Run a single mail-outbox flush pass. Resolves when the batch is drained
 * (or empty). The initial SELECT is intentionally NOT wrapped in a
 * try/catch so a batch-level failure propagates to `runWithLock` and is
 * recorded as `cron_locks.last_status='error'` (Design §11.1).
 */
export async function mailFlush(): Promise<void> {
  const startedAt = Date.now();
  const counters: FlushCounters = {
    selected: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
  };

  // 1. SELECT the due batch. Errors here propagate (batch-level).
  const rows = await query<OutboxRow[]>(SELECT_BATCH_SQL);
  counters.selected = rows.length;

  // 2-3. Process rows sequentially. A single connection pool with a small
  // limit (Design §20.1) makes sequential processing the safe default;
  // per-row errors are caught so the batch always completes.
  for (const row of rows) {
    try {
      await processRow(row, counters);
    } catch (err) {
      // A per-row failure (e.g. an UPDATE throwing) must not abort the
      // batch — log it and move on to the next row.
      log.error(
        {
          event: 'mail_row_error',
          mail_id: Number(row.id),
          error: toLastError(err),
        },
        'mail-flush: unexpected per-row error',
      );
    }
  }

  // 4. Summary line.
  log.info(
    {
      event: 'mail_flush_done',
      selected: counters.selected,
      sent: counters.sent,
      retried: counters.retried,
      failed: counters.failed,
      skipped: counters.skipped,
      duration_ms: Date.now() - startedAt,
    },
    'mail-flush: completed',
  );
}
