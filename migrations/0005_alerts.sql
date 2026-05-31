-- Migration: 0005_alerts
-- Purpose : Job alert subscriptions — the cron-evaluated digest mechanism
--           that emails Applicants new postings matching their saved
--           keyword / locations / departments / frequency criteria.
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §7.2 (DDL ground truth), §11.3 (alert-digest cron)
--           — Requirements 7.1, 7.2
--
-- Tables created (per task 32.1):
--   job_alerts
--
-- Why ONLY job_alerts:
--   The ERD in design.md §7.1 sketches a `JOB_ALERTS ||--o{ JOB_ALERT_RUNS`
--   relationship, but the canonical DDL in §7.2 does NOT define a
--   `job_alert_runs` table — the alert evaluator collapses run history
--   into the single `last_evaluated_at` column on `job_alerts` (Req 7.5
--   prescribes "update the previous evaluation timestamp" as the only
--   per-alert mutation). Following the same "design §7.2 wins over task
--   summary / ERD prose" precedent set by 0004_applications.sql, this
--   migration intentionally omits the runs table. If a separate audit
--   trail of every digest evaluation is later needed, it should arrive
--   in its own migration with its own design-doc update.
--
-- Why no employment_types / levels / updated_at columns:
--   The task summary suggests `employment_types JSON`, `levels JSON`, and
--   an `updated_at DATETIME ... ON UPDATE CURRENT_TIMESTAMP`, but
--   design.md §7.2 explicitly defines the schema as:
--       id, applicant_user_id, keyword, locations, departments,
--       frequency, last_evaluated_at, created_at
--   Per the "design.md wins" rule established in 0004, this migration
--   honours §7.2 exactly. Adding columns now would force a second
--   migration to drop them once the design is reconciled, and the alert
--   evaluator (task 34.1) only references the columns above. If HR ever
--   wants to filter alerts by employment_type or level, that's a new
--   migration with the matching design-doc change first.
--
-- Why VARCHAR(100) on keyword:
--   §7.2 specifies VARCHAR(100). The task summary suggests VARCHAR(200);
--   the smaller width is sufficient (a job-alert keyword is a search
--   phrase, not free-form prose) and keeps the row narrow.
--
-- "Max 10 per applicant" cap:
--   This rule (Req 7.1, applicant UI) is enforced at the application
--   layer (task 33.1, the `POST /:locale/me/alerts` handler). It is
--   NOT a CHECK constraint here:
--     - MySQL/MariaDB CHECK against an aggregate (COUNT(*) per
--       applicant_user_id) is impossible without a trigger, and the
--       cPanel host policy forbids triggers (design §1).
--     - JSON-based CHECK constraints would require MySQL 8.0.16+ and
--       still couldn't reach across rows.
--     - Design.md §7.2 explicitly notes "app-level guard" — the
--       service-layer guard reads COUNT(*) inside the same transaction
--       as the INSERT, returns a friendly 422 on the 11th attempt, and
--       reports which existing alert to delete first.
--   The schema therefore has no row-count constraint; integrity for
--   that rule lives in `src/modules/alerts/service.ts`.
--
-- FK strategy:
--   `job_alerts.applicant_user_id → applicants(user_id)` cascades on
--   delete: when a UU-PDP account-deletion sweep removes an applicant
--   (Req 16.3), their alerts must vanish — there is no audit value in
--   keeping a digest configuration whose owner no longer exists, and
--   the alert-digest cron (task 34.1) would otherwise email a deleted
--   identity. CASCADE is also consistent with the bookmark/consent
--   cleanup pattern in 0002 / 0004.
--
-- Indexes:
--   - `idx_alert_app (applicant_user_id)` is the canonical index from
--     design.md §7.2. It powers two read paths:
--       1. The "max 10" cap check inside the application-layer guard
--          (`SELECT COUNT(*) FROM job_alerts WHERE applicant_user_id=?
--          FOR UPDATE`).
--       2. The applicant's own alerts page (`GET /:locale/me/alerts`,
--          task 33.1) listing their alerts.
--   - The cron's "due alerts" scan in §11.3 is
--       SELECT ... FROM job_alerts
--        WHERE last_evaluated_at IS NULL
--           OR last_evaluated_at < NOW() - INTERVAL <freq> ...
--     With the table size bound at <=10 rows × applicant count and
--     workloads measured in tens of thousands of total alerts (Req 1
--     non-functional caps), a full table scan per 15-minute run is
--     acceptable; design.md §7.2 deliberately did not add a
--     `(frequency, last_evaluated_at)` index. Should the table grow
--     beyond expectations, that index can be added later without a
--     schema change to the columns themselves.
--
-- JSON column shapes (documented for the alert-digest cron, task 34.1):
--   - locations    : array of city strings, e.g. ["Jakarta","Surabaya"]
--                    Match against `job_postings.location` is exact /
--                    case-insensitive (utf8mb4_unicode_ci) via
--                    JSON_CONTAINS or LIKE on a generated facet column
--                    in a future optimisation.
--   - departments  : array of `departments.id` numbers, e.g. [3,7]
--                    Match against `job_postings.department_id` is
--                    integer equality.
--   NULL on either column means "no filter on that axis"; an empty
--   array `[]` is also treated as "no filter" by the evaluator (task
--   34.1) so the form serialiser does not need to special-case empty
--   selections. The validator at the HTTP layer (task 33.1) is the
--   sole guarantor of well-formed JSON arrays.

-- -----------------------------------------------------------------------------
-- job_alerts (design §7.2, Req 7.1, 7.2)
-- -----------------------------------------------------------------------------
CREATE TABLE job_alerts (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  applicant_user_id  BIGINT UNSIGNED NOT NULL,
  keyword            VARCHAR(100) NULL,
  locations          JSON NULL,
  departments        JSON NULL,
  frequency          ENUM('Daily','Weekly') NOT NULL,
  last_evaluated_at  DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_alert_app (applicant_user_id),
  CONSTRAINT fk_alert_app
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
