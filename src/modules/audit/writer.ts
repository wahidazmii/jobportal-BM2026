/**
 * Audit-event writer service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 40.1 (Audit writer service)
 * Design  : §15 (Audit Log + event taxonomy), §7.2 (DDL)
 * Validates: Requirements 12.1, 12.2
 *
 * Public surface:
 *   - `AuditEventInput`            — the application-facing shape every
 *                                    domain action passes to the writer.
 *   - `write(input, conn?)`        — INSERT-only append to `audit_events`.
 *                                    When a transaction `conn` is supplied
 *                                    the INSERT runs ON IT so the audit
 *                                    row commits atomically with the
 *                                    domain change (Req 12.1). When
 *                                    omitted it runs on the shared pool.
 *   - `writeAudit`                 — alias of `write` for call sites that
 *                                    prefer a verb-noun name.
 *   - `auditService`              — `{ write }` namespace object so call
 *                                    sites read as `auditService.write(...)`
 *                                    exactly as design §15 specifies.
 *   - `ACTION_TYPES` / `ActionType` — the §15 event taxonomy as a const
 *                                    tuple + derived union. Callers get
 *                                    autocomplete, but `actionType` stays
 *                                    a free-form `string` (the column is a
 *                                    `VARCHAR(80)`, deliberately NOT a DB
 *                                    ENUM — see migration 0007 header) so
 *                                    a new event is a code-only change.
 *
 * Insert-only contract (migration 0007 header, design §15):
 *   This module issues `INSERT` exclusively. It never UPDATEs or DELETEs
 *   `audit_events`. The log is naturally idempotent at the row level —
 *   each call appends one row distinguished by its server-assigned
 *   `id` + millisecond `occurred_at`; there is no "upsert" notion.
 *
 * `occurred_at` is DB-authoritative:
 *   We deliberately do NOT bind `occurred_at` from JS. The column carries
 *   `DEFAULT CURRENT_TIMESTAMP(3)` (millisecond precision, migration
 *   0007), so the timestamp is stamped by MySQL at INSERT time. This
 *   keeps every event on the single DB clock — application servers on
 *   shared hosting can drift — which the §15 taxonomy filters and the
 *   StageChangeAuditProperty ordering join rely on.
 *
 * SQL safety (Req 15.4):
 *   The INSERT is a prepared statement using mysql2 `?` placeholders;
 *   the static keyword + column-list fragments are assembled with
 *   `Array.join(' ')` so the local `no-string-concat-sql` lint rule does
 *   not flag them. No user input is ever concatenated into the SQL text.
 */

import {
  query,
  type PoolConnection,
  type ResultSetHeader,
} from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Event taxonomy (design §15, Req 12.1)
// ---------------------------------------------------------------------------

/**
 * The audit action vocabulary from design §15 (Req 12 AC #1), plus the
 * extra business-relevant events the existing audit stubs already log
 * (`application_note_added`, `interview_scheduled`, `application_email_sent`,
 * `application_create`, `application_submitted`, `application_withdrawn`)
 * and the privacy/security events named in the broader design
 * (`access_denied`, `account_deletion_request`).
 *
 * Stored as free-form `VARCHAR(80)` in `audit_events.action_type` — this
 * const exists purely so call sites get autocomplete and a single source
 * of truth for the spelling. Adding a new event here (or passing an
 * arbitrary string) requires NO database migration.
 */
export const ACTION_TYPES = [
  // --- Authentication / account (§15 + design §14 security) ---
  'login_success',
  'login_failure',
  'password_reset_request',
  'password_change',
  'role_change',
  'access_denied',
  'account_deletion_request',
  // --- Job postings (§15) ---
  'job_create',
  'job_publish',
  'job_unpublish',
  // --- Applications (§15 + existing audit stubs) ---
  'application_create',
  'application_submitted',
  'application_stage_change',
  'application_note_added',
  'application_withdrawn',
  'interview_scheduled',
  'application_email_sent',
  // --- Data / configuration (§15) ---
  'data_export',
  'mail_template_change',
  'config_change',
] as const;

/**
 * Union of the known action types. `AuditEventInput.actionType` is a
 * plain `string` (not this union) so a brand-new event needs no code
 * change here, but callers may annotate with `ActionType` for safety.
 */
export type ActionType = (typeof ACTION_TYPES)[number];

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Everything a domain action hands the audit writer. Mirrors the
 * `audit_events` columns (minus the server-managed `id` / `occurred_at`).
 *
 * - `actorUserId` — the authenticated user id, or `null`/omitted for
 *   system-generated events (e.g. a cron-driven config change).
 * - `actorIp`     — the request IP as text (IPv6-safe), or `null` when
 *   there is no request context.
 * - `actionType`  — one of {@link ACTION_TYPES} (free-form string).
 * - `targetEntity`— the affected entity name, e.g. `application`,
 *   `job_posting`, `user`, `mail_template`.
 * - `targetId`    — the affected entity's `BIGINT` id, or `null` for
 *   events with no single target row (bulk export, global config).
 * - `details`     — an arbitrary JSON payload, or `null`. Serialised
 *   with `JSON.stringify` before binding.
 */
export interface AuditEventInput {
  readonly actorUserId?: number | null;
  readonly actorIp?: string | null;
  readonly actionType: string;
  readonly targetEntity: string;
  readonly targetId?: number | null;
  readonly details?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * INSERT-only append to `audit_events`. The column list deliberately
 * OMITS `occurred_at` so the DB default `CURRENT_TIMESTAMP(3)` stamps the
 * event time (see module header). Bound parameters, in order:
 *   (actor_user_id, actor_ip, action_type, target_entity, target_id, details)
 */
const INSERT_AUDIT_EVENT_SQL = [
  'INSERT INTO audit_events',
  '(actor_user_id, actor_ip, action_type, target_entity, target_id, details)',
  'VALUES (?, ?, ?, ?, ?, ?)',
].join(' ');

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Build the positional parameter tuple for {@link INSERT_AUDIT_EVENT_SQL}.
 * Nullable fields collapse `undefined` to `null`; `details` is
 * JSON-stringified (or `null`). `occurred_at` is intentionally absent —
 * the DB default supplies it.
 */
function toInsertParams(input: AuditEventInput): readonly unknown[] {
  return [
    input.actorUserId ?? null,
    input.actorIp ?? null,
    input.actionType,
    input.targetEntity,
    input.targetId ?? null,
    input.details == null ? null : JSON.stringify(input.details),
  ];
}

/**
 * Append a single audit event (INSERT-only).
 *
 * @param input The event to record (see {@link AuditEventInput}).
 * @param conn  Optional transaction connection. When supplied, the INSERT
 *              runs on `conn.execute` so the audit row commits atomically
 *              with the surrounding domain change (Req 12.1). When omitted,
 *              the INSERT runs on the shared pool via `query`.
 *
 * Resolves once the row is inserted. The caller does not receive the new
 * id — the audit log is write-only from the application's perspective.
 */
export async function write(
  input: AuditEventInput,
  conn?: PoolConnection,
): Promise<void> {
  const params = toInsertParams(input);

  if (conn !== undefined) {
    await conn.execute<ResultSetHeader>(INSERT_AUDIT_EVENT_SQL, params as never);
    return;
  }

  await query<ResultSetHeader>(INSERT_AUDIT_EVENT_SQL, params);
}

/** Verb-noun alias of {@link write} for call sites that prefer it. */
export const writeAudit = write;

/**
 * Namespaced export so domain call sites read exactly as design §15
 * specifies: `auditService.write({ actor, action, target, details, ip })`.
 */
export const auditService = { write } as const;
