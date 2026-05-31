/**
 * Kanban-board read query for the Admin_Console.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 29.1 (Render kanban)
 * Design  : §4.2 (htmx kanban pattern), §6 Admin (HTTP routing map)
 * Validates: Requirements 10.1
 *
 * Why a dedicated module:
 *   The applications domain already carries a `queries.ts` (applicant-
 *   side reads — list / detail) and a `service.ts` (write paths —
 *   apply, withdraw, stage transitions). Task 29.1 is dispatched in
 *   parallel with task 26.1 which extends `service.ts`. To avoid merge
 *   conflicts between the two parallel branches, the kanban read path
 *   lives in its own file. The shared types in `types.ts` keep the
 *   stage / source enums consistent across all three modules.
 *
 * Why six columns, not seven:
 *   The kanban board lists every Pipeline_Stage EXCEPT `Withdrawn`.
 *   Per Req 10.1 the columns are exactly:
 *     Applied, Screening, Interview, Offer, Hired, Rejected.
 *   `Withdrawn` is an applicant-initiated terminal state (Req 5.8) —
 *   HR cannot move a card there, and showing it as a column would
 *   conflate "applicant left" with the HR-driven pipeline. The
 *   `KANBAN_STAGES` constant below is therefore the single source of
 *   truth for the columns rendered in `views/admin/jobs/kanban.njk`.
 *
 * Authorization model:
 *   The route layer enforces the Department_Head scope by calling
 *   `findById(jobId, scope)` BEFORE invoking this query — when that
 *   returns null, we 404 without ever reaching here. As of task 39.2
 *   `listForKanban` ALSO accepts an optional `scope` and, when one is
 *   supplied, re-applies `jp.department_id IN (?, …)` directly in the
 *   board query (defence in depth). Passing no scope preserves the
 *   original behaviour: a job that survived the upstream gate is by
 *   definition visible, so the unscoped query is correct for HR /
 *   Super_Admin and for callers that already gated the job.
 *
 * Index usage:
 *   The query touches `applications` once and JOINs to `applicants`
 *   (for the display name) and `users` (for an email fallback). The
 *   `idx_app_job_stage (job_id, stage)` index covers the WHERE +
 *   ORDER BY shape: `WHERE job_id = ? AND stage IN (...)` walks the
 *   index range in stage order, and the `applied_at DESC` ordering
 *   inside each stage is a small filesort (< 200 rows per stage in
 *   practice, well within the InnoDB sort buffer).
 *
 * SQL safety:
 *   All statements use mysql2 placeholders (`?`). The IN-clause
 *   placeholder list is built from `KANBAN_STAGES.length` slots —
 *   every value is a compile-time literal from this module, never
 *   user input.
 */

import { query, type RowDataPacket } from '../../infra/db.js';
// Type-only import: `JobScope` is erased at compile time so this adds no
// runtime dependency on `../jobs/repo.js`. Re-using the canonical scope
// shape keeps the Department_Head contract identical across the jobs and
// applications read paths (Req 11.4 / Design §14.2).
import type { JobScope } from '../jobs/repo.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The six Pipeline_Stage values rendered on the kanban board, in
 * left-to-right column order. Matches Req 10.1 verbatim.
 *
 * The list is intentionally NOT `APPLICATION_STAGES` from `types.ts`
 * (which includes `Withdrawn`) — see header note for the rationale.
 */
export const KANBAN_STAGES = [
  'Applied',
  'Screening',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
] as const;

export type KanbanStage = (typeof KANBAN_STAGES)[number];

/**
 * Display labels for each kanban column. Internal-only screen, so we
 * keep the labels in English to match the rest of the admin console.
 * The future i18n pass can swap these for `{{ 'admin.kanban.stage.x'
 * | t }}` lookups without changing the data shape.
 */
export const KANBAN_STAGE_LABELS: Readonly<Record<KanbanStage, string>> = {
  Applied: 'Applied',
  Screening: 'Screening',
  Interview: 'Interview',
  Offer: 'Offer',
  Hired: 'Hired',
  Rejected: 'Rejected',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Single card on the kanban board. The shape is intentionally narrow —
 * the view only needs the identifiers, the applicant's display name,
 * the current stage, and the submission timestamp for the per-column
 * ordering signal.
 */
export interface KanbanCard {
  /** Internal `applications.id`, used in the htmx stage-change URL. */
  readonly id: number;
  /** Stable external identifier for audit links. */
  readonly uuid: string;
  /** Public-facing reference number, e.g. `APP-2026-000123`. */
  readonly reference_no: string;
  /** `applications.applicant_user_id` (i.e. `users.id`). */
  readonly applicant_user_id: number;
  /** Display name resolved from `applicants.full_name`, with email fallback. */
  readonly applicant_name: string;
  /** Current pipeline stage. */
  readonly stage: KanbanStage;
  /** Submission timestamp; the column orders cards by this DESC. */
  readonly applied_at: Date;
}

/** One column on the kanban board: a stage + the cards in that stage. */
export interface KanbanColumn {
  readonly stage: KanbanStage;
  readonly rows: readonly KanbanCard[];
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Build the `(?, ?, ?, ?, ?, ?)` placeholder list for the stage IN
 * clause once at module load. The values bound at the call site are
 * the literal `KANBAN_STAGES` constants — never user input.
 */
const STAGE_PLACEHOLDERS = KANBAN_STAGES.map(() => '?').join(', ');

/**
 * Single-trip query that pulls every kanban card for one job. The
 * JOIN to `applicants` resolves the display name; the LEFT JOIN to
 * `users` provides the email fallback for the rare case where a row
 * predates the applicants seed (e.g. a HR-impersonation test or an
 * older test fixture).
 *
 * Ordering: the outer `ORDER BY stage, applied_at DESC` lets the
 * caller iterate the result once and bucket it into columns without
 * a per-stage sort. The `stage` ordering is alphabetical from MySQL's
 * point of view, but the caller bucketises into the `KANBAN_STAGES`
 * order anyway, so that detail does not leak.
 */
const SELECT_KANBAN_SQL = [
  'SELECT',
  '  a.id              AS id,',
  '  a.uuid            AS uuid,',
  '  a.reference_no    AS reference_no,',
  '  a.applicant_user_id AS applicant_user_id,',
  '  a.stage           AS stage,',
  '  a.applied_at      AS applied_at,',
  '  ap.full_name      AS applicant_name,',
  '  u.email           AS applicant_email',
  'FROM applications a',
  'LEFT JOIN applicants ap ON ap.user_id = a.applicant_user_id',
  'LEFT JOIN users      u  ON u.id       = a.applicant_user_id',
  'WHERE a.job_id = ?',
  '  AND a.stage IN (' + STAGE_PLACEHOLDERS + ')',
  'ORDER BY a.stage ASC, a.applied_at DESC, a.id DESC',
].join(' ');

/**
 * Department-scoped variant of {@link SELECT_KANBAN_SQL} (Req 11.4 /
 * Design §14.2). Adds an `INNER JOIN job_postings jp` plus a
 * `jp.department_id IN (?, …)` predicate so a Department_Head only
 * ever loads cards for jobs in their assigned departments — DIRECTLY
 * at the repository layer rather than relying solely on the
 * transitive `findJobById(jobId, scope)` gate in the route.
 *
 * The `IN (...)` placeholder list is assembled at call time from the
 * assigned-department count; every bound value is a department id,
 * never inlined into the SQL text. Assembled with `Array.join(' ')` so
 * the `local/no-string-concat-sql` lint rule never sees a SQL keyword
 * adjacent to a dynamic operand.
 *
 * Note: the existing `LEFT JOIN applicants` aliases `ap`, so the new
 * job join uses the distinct alias `jp` to avoid a clash.
 */
function buildSelectKanbanScopedSql(deptCount: number): string {
  return [
    'SELECT',
    '  a.id              AS id,',
    '  a.uuid            AS uuid,',
    '  a.reference_no    AS reference_no,',
    '  a.applicant_user_id AS applicant_user_id,',
    '  a.stage           AS stage,',
    '  a.applied_at      AS applied_at,',
    '  ap.full_name      AS applicant_name,',
    '  u.email           AS applicant_email',
    'FROM applications a',
    'INNER JOIN job_postings jp ON jp.id = a.job_id',
    'LEFT JOIN applicants ap ON ap.user_id = a.applicant_user_id',
    'LEFT JOIN users      u  ON u.id       = a.applicant_user_id',
    'WHERE a.job_id = ?',
    '  AND a.stage IN (' + STAGE_PLACEHOLDERS + ')',
    '  AND jp.department_id IN (' + KANBAN_DEPT_PLACEHOLDERS(deptCount) + ')',
    'ORDER BY a.stage ASC, a.applied_at DESC, a.id DESC',
  ].join(' ');
}

/**
 * Build the `?, ?, …` placeholder list for the department IN clause.
 * Emits `?` characters only — never user input.
 */
function KANBAN_DEPT_PLACEHOLDERS(n: number): string {
  if (n <= 0) return '';
  return Array.from({ length: n }, () => '?').join(', ');
}

interface KanbanRow extends RowDataPacket {
  id: number | string;
  uuid: string;
  reference_no: string;
  applicant_user_id: number | string;
  stage: KanbanStage;
  applied_at: Date | string;
  applicant_name: string | null;
  applicant_email: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDate(raw: unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return new Date(raw);
  return new Date(0);
}

/**
 * Resolve a card's display name. Prefers `applicants.full_name` (Req
 * 4.1 — "full name" is one of the mandatory profile fields), falls
 * back to the user's email when the applicants row is missing or the
 * full name is empty (defensive — should not happen for a real
 * applicant, but a clean fallback beats rendering blank cards).
 */
function resolveDisplayName(row: KanbanRow): string {
  const name = row.applicant_name;
  if (typeof name === 'string' && name.trim().length > 0) {
    return name;
  }
  const email = row.applicant_email;
  if (typeof email === 'string' && email.length > 0) {
    return email;
  }
  return `Applicant #${Number(row.applicant_user_id)}`;
}

// ---------------------------------------------------------------------------
// Public query
// ---------------------------------------------------------------------------

/**
 * Fetch every kanban card for `jobId` and bucket them by stage.
 *
 * Returns exactly six entries, one per `KANBAN_STAGES` value, in the
 * canonical column order. Stages with no applications come back with
 * an empty `rows` array — the view renders the empty-state placeholder
 * for those columns instead of skipping them.
 *
 * `Withdrawn` applications are filtered out at the SQL level via the
 * `IN (...)` clause; they NEVER appear in the result.
 *
 * Within each stage, rows are ordered by `applied_at DESC` (newest
 * first) with `id DESC` as a deterministic tiebreaker for two rows
 * with the same timestamp.
 *
 * Department_Head scoping (Req 11.4 / Design §14.2):
 *   - `scope` omitted / `scope.departments === undefined` → HR /
 *     Super_Admin path; the board loads every card for the job.
 *   - `scope.departments` non-empty → the query JOINs `job_postings`
 *     and applies `jp.department_id IN (?, …)`, so a job outside the
 *     assigned departments yields an empty board (defence in depth on
 *     top of the route's `findJobById(jobId, scope)` gate).
 *   - `scope.departments` EMPTY → the empty board, WITHOUT a query.
 */
export async function listForKanban(
  jobId: number,
  scope?: JobScope,
): Promise<readonly KanbanColumn[]> {
  if (!Number.isInteger(jobId) || jobId <= 0) {
    // Defensive: an invalid id never matches a row, so we short-circuit
    // to the canonical empty-board shape instead of issuing a query
    // that would always return zero rows.
    return KANBAN_STAGES.map((stage) => ({ stage, rows: [] }));
  }

  // Department_Head scoping (Req 11.4 / Design §14.2). When a scope is
  // supplied we enforce `jp.department_id IN (?, …)` directly in the
  // board query. An EMPTY assignment set means "no departments" → the
  // empty board, without hitting the DB. `undefined` scope (HR /
  // Super_Admin) runs the unscoped query.
  let rows: KanbanRow[];
  if (scope?.departments !== undefined) {
    const depts = scope.departments;
    if (depts.length === 0) {
      return KANBAN_STAGES.map((stage) => ({ stage, rows: [] }));
    }
    rows = await query<KanbanRow[]>(buildSelectKanbanScopedSql(depts.length), [
      jobId,
      ...KANBAN_STAGES,
      ...depts,
    ]);
  } else {
    rows = await query<KanbanRow[]>(SELECT_KANBAN_SQL, [
      jobId,
      ...KANBAN_STAGES,
    ]);
  }

  // Bucket the rows into a Map keyed by stage so the column assembly
  // below is O(1) per row.
  const buckets = new Map<KanbanStage, KanbanCard[]>();
  for (const stage of KANBAN_STAGES) buckets.set(stage, []);

  for (const row of rows) {
    const bucket = buckets.get(row.stage);
    if (!bucket) continue; // Defensive: an unknown stage cannot land in a column.
    bucket.push({
      id: Number(row.id),
      uuid: String(row.uuid),
      reference_no: String(row.reference_no),
      applicant_user_id: Number(row.applicant_user_id),
      applicant_name: resolveDisplayName(row),
      stage: row.stage,
      applied_at: toDate(row.applied_at),
    });
  }

  // The SQL ORDER BY already sorted by `applied_at DESC, id DESC` per
  // stage — but the OUTER ordering was `stage ASC` (alphabetical),
  // not the canonical column order. We rebuild the result in
  // `KANBAN_STAGES` order so the route hands back exactly six columns
  // in the right sequence regardless of MySQL's collation.
  return KANBAN_STAGES.map((stage) => ({
    stage,
    rows: buckets.get(stage) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Single-card read (task 29.2 — re-render after a stage transition)
// ---------------------------------------------------------------------------

/**
 * Single-card variant of {@link SELECT_KANBAN_SQL}. Loads one card by
 * its `applications.id` with the same projection / JOINs so the
 * `kanban-card.njk` partial renders identically to a board-load card.
 *
 * Unlike the board query this does NOT constrain `stage` to the six
 * kanban stages: after a transition the card may legitimately be in any
 * stage the state machine allows (e.g. `Rejected`), and the route needs
 * the row back so htmx can swap the moved card in place.
 */
const SELECT_KANBAN_CARD_BY_ID_SQL = [
  'SELECT',
  '  a.id              AS id,',
  '  a.uuid            AS uuid,',
  '  a.reference_no    AS reference_no,',
  '  a.applicant_user_id AS applicant_user_id,',
  '  a.stage           AS stage,',
  '  a.applied_at      AS applied_at,',
  '  ap.full_name      AS applicant_name,',
  '  u.email           AS applicant_email',
  'FROM applications a',
  'LEFT JOIN applicants ap ON ap.user_id = a.applicant_user_id',
  'LEFT JOIN users      u  ON u.id       = a.applicant_user_id',
  'WHERE a.id = ?',
  'LIMIT 1',
].join(' ');

/**
 * Load a single kanban card by application id. Returns `null` when the
 * row is missing or the id is non-positive. Used by the stage-transition
 * route (task 29.2) to re-render the moved card via `kanban-card.njk`
 * after a successful transition (the template declares
 * `hx-swap="outerHTML"`, so the server returns the fresh card markup).
 *
 * No scope filtering is applied here: the route has already authorised
 * the actor (and, for Department_Head, verified the job scope) before
 * the stage change committed, so re-reading the just-updated row needs
 * no further gate.
 */
export async function findKanbanCard(
  applicationId: number,
): Promise<KanbanCard | null> {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;

  const rows = await query<KanbanRow[]>(SELECT_KANBAN_CARD_BY_ID_SQL, [
    applicationId,
  ]);
  const row = rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    uuid: String(row.uuid),
    reference_no: String(row.reference_no),
    applicant_user_id: Number(row.applicant_user_id),
    applicant_name: resolveDisplayName(row),
    stage: row.stage,
    applied_at: toDate(row.applied_at),
  };
}
