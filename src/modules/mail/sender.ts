/**
 * SMTP send seam for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 37.1 (cron mail-flush)
 * Design  : §2.3 (nodemailer SMTP), §11.3, §12 (Mail Outbox)
 * Validates: Requirements 8.4, 8.5
 *
 * This module is the *only* place that talks to nodemailer. The flusher
 * cron (`src/crons/mail-flush.ts`) depends on the small `sendMail`
 * function exported here rather than on nodemailer directly, so unit
 * tests can mock the whole transport without standing up a live SMTP
 * server (Design §Testing — "mock SMTP").
 *
 * Transport configuration (Design §17 secrets):
 *   - `SMTP_HOST`  — relay hostname (cPanel mail or Brevo).
 *   - `SMTP_PORT`  — defaults to 587 (STARTTLS submission).
 *   - `SMTP_USER`  — auth user (also the default envelope From).
 *   - `SMTP_PASS`  — auth password.
 *   - `MAIL_FROM`  — optional explicit From header; falls back to
 *                    `SMTP_USER`.
 *
 * The transporter is created lazily and memoised so a single cron run
 * reuses one connection pool. Tests never reach `getTransporter()`
 * because they mock `sendMail` itself.
 */

import { createTransport, type Transporter } from 'nodemailer';

/**
 * Minimal outgoing-message shape the cron hands to `sendMail`. Mirrors
 * the `mail_outbox` columns the flusher SELECTs (Design §12.1) — the cron
 * never passes raw DB rows so the transport stays decoupled from the
 * table schema.
 */
export interface OutgoingMessage {
  /** Recipient address (`mail_outbox.to_email`). */
  readonly toEmail: string;
  /** Optional friendly recipient name (`mail_outbox.to_name`). */
  readonly toName?: string | null;
  /** Subject line (`mail_outbox.subject`). */
  readonly subject: string;
  /** HTML body (`mail_outbox.body_html`). */
  readonly bodyHtml: string;
  /** Optional plaintext alternative (`mail_outbox.body_text`). */
  readonly bodyText?: string | null;
}

/**
 * Lazily-constructed, memoised transporter. Reset to `null` only in
 * tests via {@link resetTransporterForTests}; production keeps the single
 * instance for the life of the cron process.
 */
let cachedTransporter: Transporter | null = null;

/**
 * Build (or return the memoised) nodemailer transport from `SMTP_*` env.
 * `secure` is inferred from the port: 465 → implicit TLS, otherwise
 * STARTTLS on submission ports (587/25).
 */
function getTransporter(): Transporter {
  if (cachedTransporter !== null) {
    return cachedTransporter;
  }

  const host = process.env.SMTP_HOST ?? '';
  const port = Number.parseInt(process.env.SMTP_PORT ?? '587', 10);
  const user = process.env.SMTP_USER ?? '';
  const pass = process.env.SMTP_PASS ?? '';

  cachedTransporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: user !== '' ? { user, pass } : undefined,
  });

  return cachedTransporter;
}

/** Resolve the From header: explicit `MAIL_FROM`, else `SMTP_USER`. */
function resolveFrom(): string {
  const from = process.env.MAIL_FROM ?? process.env.SMTP_USER ?? '';
  return from;
}

/**
 * Format the recipient as `"Name" <email>` when a name is present, else
 * the bare address.
 */
function formatRecipient(toEmail: string, toName?: string | null): string {
  const name = (toName ?? '').trim();
  if (name === '') return toEmail;
  return `"${name.replace(/"/g, '')}" <${toEmail}>`;
}

/**
 * Send a single message through the SMTP transport.
 *
 * Rejects when nodemailer fails to hand the message to the relay (relay
 * down, auth failure, greylisting, etc.). The flusher cron treats *any*
 * rejection here as a retryable delivery failure and applies the §12.2
 * backoff schedule — it does not attempt to distinguish transient from
 * permanent SMTP errors, matching Req 8.5 ("retry … until 5 attempts
 * have failed").
 *
 * Resolves with `void` on success; the cron only needs the success/fail
 * signal, not the SMTP response envelope.
 */
export async function sendMail(message: OutgoingMessage): Promise<void> {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: resolveFrom(),
    to: formatRecipient(message.toEmail, message.toName),
    subject: message.subject,
    html: message.bodyHtml,
    text: message.bodyText ?? undefined,
  });
}

/**
 * Test-only hook: drop the memoised transporter so a subsequent
 * `getTransporter()` re-reads env. Never called in production.
 */
export function resetTransporterForTests(): void {
  cachedTransporter = null;
}
