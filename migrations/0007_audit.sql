-- Migration: 0007_audit
-- Purpose : Tamper-evident, insert-only audit trail. One row per
--           security-relevant or business-relevant action, retained
--           for ≥ 24 months and archived to gzip files when the table
--           crosses 5 million rows (Req 12.4-12.5, cron 41.1).
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §7.2 (DDL), §15 (event taxonomy) — Requirements
--           12.1, 12.2; index/column shape from tasks.md task 38.1.
--
-- Tables created (per task 38.1):
--   audit_events
--
-- Why this migration is its own file:
--   The audit log is independent of every domain table — it FKs to
--   nothing (see "No FK on actor_user_id" below) and nothing FKs to
--   it. Keeping it isolated means RBAC (39.x) and reporting (16.x)
--   features can land without churning this DDL, and the archive
--   cron (41.1) can later add partitioning or rename to a hot/cold
--   pair in a focused future migration without disturbing other
--   domains.
--
-- Deviations from design.md §7.2 — and why each is intentional:
--   The §7.2 reference DDL was sketched early; the column/index shape
--   below follows the more recent tasks.md task 38.1 specification.
--   Specifically:
--     - `occurred_at` is `DATETIME(3)` (millisecond precision) instead
--       of plain `DATETIME` (second precision). Two events from the
--       same HTTP request — e.g. `application_stage_change` plus the
--       enqueued `mail_template_change` audit row, or a burst of
--       `login_failure` events from a brute-force probe — must be
--       orderable by `occurred_at` alone for the §15 taxonomy filters
--       and the Property 4 (StageChangeAuditProperty, task 26.3) join
--       to be deterministic. Second precision routinely collides
--       under load; millisecond precision does not.
--     - `actor_ip` is `VARCHAR(45) NULL` instead of `VARBINARY(16)`.
--       45 chars is the canonical max for a textual IPv6 address
--       including a `%zone` suffix or an IPv4-mapped form
--       (`::ffff:255.255.255.255`). Storing the address as text means
--       the audit log is human-readable in `mysql` shell during an
--       incident triage without a custom `INET6_NTOA` view; the
--       insert path simply takes whatever the reverse-proxy header
--       hands us. The few extra bytes per row vs `VARBINARY(16)` are
--       negligible against the JSON `details` column that dominates
--       row width.
--     - `action_type` is `VARCHAR(80)` and `target_entity` is
--       `VARCHAR(50)` (vs §7.2's `VARCHAR(64)` for both). The §15
--       taxonomy lists 12 named actions with the longest currently
--       at 22 chars (`password_reset_request`); 80 leaves headroom
--       for future events without a schema migration. 50 is plenty
--       for entity names (`application`, `job_posting`, `user`,
--       `mail_template`).
--     - `target_id` is `BIGINT UNSIGNED NULL` instead of §7.2's
--       `VARCHAR(64) NOT NULL`. Every entity in this schema has a
--       `BIGINT UNSIGNED` PK, so storing the id natively keeps the
--       index narrow and lets the archive query use range scans on
--       integer ids. NULL covers system-level events that have no
--       single target row (e.g. a `config_change` that affects
--       global state, or a bulk `data_export`).
--     - Indexes are `(actor_user_id, occurred_at)`,
--       `(action_type, occurred_at)`, and
--       `(target_entity, target_id, occurred_at)` instead of §7.2's
--       three less-specific keys. All three Admin_Console filters in
--       Req 12.3 (date range × actor, date range × action,
--       date range × target) are answered by a single key seek + range
--       scan in this layout. The plain `idx_audit_time` from §7.2
--       isn't needed because every compound index above is prefixed
--       by a discriminator and ends in `occurred_at`, so a date-only
--       scan is rare and acceptably served by a full-scan + filesort.
--
-- No FK on `actor_user_id`:
--   The audit log MUST outlive the deletion of the actor's user
--   account (Req 12 — immutability across the 24-month retention
--   window, even when an account is purged via the UU-PDP sweep in
--   Req 16.3). A foreign key would either cascade-delete the audit
--   row (defeating retention) or block the user delete (defeating
--   the right-to-erasure). This is the same pattern the schema
--   already uses for `application_stage_history.changed_by` (see
--   migration 0004_applications.sql header) and for
--   `application_notes.author_user_id` (preserved with a non-cascading
--   FK). The audit log goes one step further and drops the FK
--   altogether: at the moment of erasure the application layer
--   (task 39 RBAC + 41 archive cron) will pseudonymise actor ids
--   inside `details` payloads on cold rows; an FK would force us to
--   either NULL the column or rewrite history, both of which would
--   break tamper-evidence.
--
-- Insert-only contract:
--   Application code MUST NOT issue UPDATE or DELETE against this
--   table. The only writer is `auditService.write(...)` (design §15)
--   which performs `INSERT` exclusively. The only legitimate deleter
--   is the `audit-archive` cron (task 41.1), and even that one moves
--   rows out (gzip file in File_Store) before deleting them — never
--   in-place edits. There is no DB-level CHECK or trigger enforcing
--   this; the discipline lives in code review and in the absence of
--   any UPDATE/DELETE statement targeting `audit_events` anywhere in
--   the codebase. (We deliberately avoid SQL triggers per the §6
--   "no DB business logic" constraint.)
--
-- Action taxonomy (§15, Req 12.1):
--   login_success, login_failure, password_reset_request,
--   password_change, role_change, job_create, job_publish,
--   job_unpublish, application_create, application_stage_change,
--   data_export, mail_template_change, access_denied, config_change.
--   Stored as free-form `VARCHAR` rather than ENUM so that adding a
--   new event in a code-only change doesn't require a migration.

-- -----------------------------------------------------------------------------
-- audit_events (design §7.2, §15, Req 12.1, 12.2)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_user_id   BIGINT UNSIGNED NULL,                     -- NULL for system-generated events
  actor_ip        VARCHAR(45) NULL,                         -- IPv6-safe textual form
  action_type     VARCHAR(80) NOT NULL,                     -- e.g. login_success, application_stage_change
  target_entity   VARCHAR(50) NOT NULL,                     -- e.g. application, job_posting, user
  target_id       BIGINT UNSIGNED NULL,                     -- NULL for events with no single target
  details         JSON NULL,
  PRIMARY KEY (id),
  KEY idx_audit_actor_time (actor_user_id, occurred_at),
  KEY idx_audit_action_time (action_type, occurred_at),
  KEY idx_audit_target (target_entity, target_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
