/**
 * Audit-log read queries for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 40.2 (Admin audit log filter UI)
 * Design  : §6 Admin (GET /admin/audit — Super_Admin only), §15 (audit)
 * Validates: Requirements 12.3
 *
 * Scope:
 *   This module is intentionally **read-only**. It powers the single
 *   Admin_Console endpoint `GET /admin/audit` (Super_Admin only, gated by
 *   `requirePolicy('audit.read')`). The append-only writer lives next door
 *   in `writer.ts`; keeping the read surface separate means the
 *   insert-only contract on `audit_events` (migration 0007 header) is never
 *   muddied by a SELECT helper.
 *
 * Filter model (Req 12.3):
 *   Super_Admin may filter Audit_Events by date range, actor, action type,
 *   and target entity. Every filter is OPTIONAL and the supplied ones are
 *   AND-combined:
 *     - `dateFrom` / `dateTo` → range on `occurred_at` (inclusive bounds).
 *     - `actor`               → exact match on `actor_user_id`.
 *     - `actionType`          → exact match on `action_type`.
 *     - `targetEntity`        → exact match on `target_entity`.
 *   With no filters the query returns the most recent page across the
 *   whole table. Results are ordered `occurred_at DESC, id DESC` (newest
 *   first; `id` breaks ties for events sharing a millisecond) and
 *   paginated (default 50 rows/page).
 *
 * SQL safety (Req 15.4, lint rule `local/no-string-concat-sql`):
 *   The WHERE clause is assembled DYNAMICALLY from the set of active
 *   filters, but NO value is ever interpolated into the SQL text. Each
 *   active filter contributes a `?`-placeholder fragment plus a bound
 *   parameter; the fragments and the static keyword fragments are joined
 *   with `Array.join(' ')` so the lint rule (which only flags template
 *   interpolation and `+` concatenation that contains SQL keywords) is
 *   satisfied. Every statement runs through `query()` → `pool.execute`
 *   (server-side prepared statement).
 */

import { query, type RowDataPacket } from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The filter accepted by {@link listAuditEvents}. Every field is optional;
 * `null` / `undefined` / empty string mean "do not constrain on this
 * column". `dateFrom` / `dateTo` are passed straight to MySQL as
 * comparison operands against `occurred_at` (a `DATETIME(3)`), so an
 * `YYYY-MM-DD` value compares against midnight of that day and an
 * `YYYY-MM-DDTHH:MM` value compares against that instant.
 */
export interface AuditEventFilter {
  /** Lower bound (inclusive) on `occurred_at`. */
  readonly dateFrom?: string | null;
  /** Upper bound (inclusive) on `occurred_at`. */
  readonly dateTo?: string | null;
  /** Exact `actor_user_id` to match. */
  readonly actor?: number | null;
  /** Exact `action_type` to match (see {@link ACTION_TYPES}). */
  readonly actionType?: string | null;
  /** Exact `target_entity` to match (e.g. `application`, `user`). */
  readonly targetEntity?: string | null;
  /** 0-based page index. Defaults to 0. */
  readonly page?: number;
  /** Rows per page. Defaults to 50, capped at 200. */
  readonly pageSize?: number;
}

/** A single `audit_events` row projected for the admin read view. */
export interface AuditEventRow {
  readonly id: number;
  readonly occurredAt: Date;
  readonly actorUserId: number | null;
  readonly actorIp: string | null;
  readonly actionType: string;
  readonly targetEntity: string;
  readonly targetId: number | null;
  readonly details: Record<string, unknown> | null;
}

/** Paginated result returned by {@link listAuditEvents}. */
export interface PaginatedAuditEvents {
  readonly rows: readonly AuditEventRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AUDIT_LIST_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_LIST_MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a possibly-string DATETIME from mysql2 into a Date. */
function toDate(raw: unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return new Date(raw);
  return new Date(0);
}

function toNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise the `details` column. mysql2 returns a `JSON` column already
 * parsed into a JS value, but a string (older driver config or a test
 * fixture) is parsed defensively. Anything that is not a plain object
 * collapses to `null`.
 */
function toDetails(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Clamp a 0-based page index to a non-negative integer. */
function clampPage(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n < 0 ? 0 : n;
}

/** Clamp the page size into `[1, AUDIT_LIST_MAX_PAGE_SIZE]`. */
function clampPageSize(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return AUDIT_LIST_DEFAULT_PAGE_SIZE;
  }
  const n = Math.floor(value);
  if (n < 1) return AUDIT_LIST_DEFAULT_PAGE_SIZE;
  if (n > AUDIT_LIST_MAX_PAGE_SIZE) return AUDIT_LIST_MAX_PAGE_SIZE;
  return n;
}

/** Treat empty / whitespace-only strings as "no value". */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Build the dynamic WHERE clause + its bound parameters from the active
 * filters. Returns an empty `clause` (and empty params) when no filter is
 * supplied. Each condition is a `?`-placeholder fragment — NO value is
 * ever concatenated into the SQL text (Req 15.4).
 */
function buildWhere(filter: AuditEventFilter): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const dateFrom = nonEmpty(filter.dateFrom);
  if (dateFrom !== null) {
    conditions.push('occurred_at >= ?');
    params.push(dateFrom);
  }

  const dateTo = nonEmpty(filter.dateTo);
  if (dateTo !== null) {
    conditions.push('occurred_at <= ?');
    params.push(dateTo);
  }

  if (filter.actor !== null && filter.actor !== undefined) {
    conditions.push('actor_user_id = ?');
    params.push(filter.actor);
  }

  const actionType = nonEmpty(filter.actionType);
  if (actionType !== null) {
    conditions.push('action_type = ?');
    params.push(actionType);
  }

  const targetEntity = nonEmpty(filter.targetEntity);
  if (targetEntity !== null) {
    conditions.push('target_entity = ?');
    params.push(targetEntity);
  }

  if (conditions.length === 0) {
    return { clause: '', params };
  }
  // `WHERE a AND b AND ...` assembled via Array.join — no interpolation.
  const clause = ['WHERE', conditions.join(' AND ')].join(' ');
  return { clause, params };
}

// ---------------------------------------------------------------------------
// listAuditEvents
// ---------------------------------------------------------------------------

/**
 * List audit events matching `filter`, newest first, paginated.
 *
 * Runs two statements: a `COUNT(*)` for the total (so the view can render
 * a pagination strip) and the page SELECT. Both share the same dynamic
 * WHERE clause + params so the count and the page stay consistent. The
 * page SELECT appends `LIMIT ? OFFSET ?` bound parameters — the limit and
 * offset are server-clamped integers, never user text.
 */
export async function listAuditEvents(
  filter: AuditEventFilter = {},
): Promise<PaginatedAuditEvents> {
  const page = clampPage(filter.page);
  const pageSize = clampPageSize(filter.pageSize);
  const offset = page * pageSize;

  const { clause, params } = buildWhere(filter);

  // Total count first — shares the WHERE clause + params with the page.
  const countParts = ['SELECT COUNT(*) AS n FROM audit_events'];
  if (clause !== '') countParts.push(clause);
  const countSql = countParts.join(' ');
  const countRows = await query<RowDataPacket[]>(countSql, params);
  const total = Number((countRows[0] as RowDataPacket | undefined)?.n ?? 0);

  // Page query. The column list + keyword fragments + (optional) WHERE
  // clause are assembled with Array.join(' '); only `?` placeholders carry
  // values (Req 15.4, lint rule `local/no-string-concat-sql`).
  const listParts = [
    'SELECT id, occurred_at, actor_user_id, actor_ip, action_type, target_entity, target_id, details',
    'FROM audit_events',
  ];
  if (clause !== '') listParts.push(clause);
  listParts.push('ORDER BY occurred_at DESC, id DESC');
  listParts.push('LIMIT ? OFFSET ?');
  const listSql = listParts.join(' ');

  const rows = await query<RowDataPacket[]>(listSql, [
    ...params,
    pageSize,
    offset,
  ]);

  const mapped: AuditEventRow[] = rows.map((row) => ({
    id: Number(row.id),
    occurredAt: toDate(row.occurred_at),
    actorUserId: toNumberOrNull(row.actor_user_id),
    actorIp:
      typeof row.actor_ip === 'string' && row.actor_ip.length > 0
        ? row.actor_ip
        : null,
    actionType: String(row.action_type ?? ''),
    targetEntity: String(row.target_entity ?? ''),
    targetId: toNumberOrNull(row.target_id),
    details: toDetails(row.details),
  }));

  return { rows: mapped, total, page, pageSize };
}
