/**
 * Minimal ambient type declarations for `nodemailer`.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 37.1 (cron mail-flush)
 *
 * The project pins `nodemailer@6.9.16` (package.json) but intentionally
 * does NOT depend on the community `@types/nodemailer` package — the only
 * consumer is `src/modules/mail/sender.ts`, which uses a tiny slice of the
 * API (`createTransport(...).sendMail(...)`). Shipping a focused local
 * declaration keeps the dependency surface small while satisfying
 * `noImplicitAny` for the import.
 *
 * Only the members the sender seam actually touches are declared. Extend
 * this file if a future task reaches for more of the nodemailer surface.
 */
declare module 'nodemailer' {
  /** Subset of nodemailer's per-message options used by the sender. */
  export interface SendMailOptions {
    from?: string;
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
  }

  /** Result envelope returned by `sendMail` (we only need its presence). */
  export interface SentMessageInfo {
    messageId?: string;
    accepted?: string[];
    rejected?: string[];
    response?: string;
  }

  /** Subset of transport options consumed from `SMTP_*` env. */
  export interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user: string; pass: string } | undefined;
  }

  /** A configured transport able to send messages. */
  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
  }

  /** Factory mirroring `nodemailer.createTransport(options)`. */
  export function createTransport(options: TransportOptions): Transporter;
}
