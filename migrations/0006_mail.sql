-- Migration: 0006_mail
-- Purpose : Mail outbox + per-locale templates — the persistence layer for
--           every transactional and digest email The_Portal sends. Domain
--           code enqueues into `mail_outbox` inside the same transaction
--           that produced the side-effect; the `mail-flush` cron drains
--           it asynchronously (design §11.3, §12). `mail_templates`
--           stores per-locale overrides of the file-system Nunjucks
--           templates so HR can edit subjects/bodies without a redeploy
--           (Req 10.7, task 36.2).
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §7.2 (DDL ground truth), §12 (state machine,
--           backoff, idempotency), §12.3 (template merge pipeline) —
--           Requirements 8.3, 8.4, 8.5, 10.7
--
-- Tables created (per task 35.1):
--   mail_outbox
--   mail_templates
--
-- Why these two together:
--   They form the mail subsystem's storage surface. `mail_templates` is
--   independent of `mail_outbox` at the FK level — the cron renders the
--   final HTML/text into the outbox row at enqueue time (design §12.3),
--   so once a row is in the outbox it carries its own copy of the
--   message and never reads from `mail_templates` again. Keeping them in
--   one migration keeps the up/down pair self-contained for the entire
--   mail domain.
--
-- Reconciling design.md §7.2 vs the task-summary column list:
--   The task summary in tasks.md lists a slightly different shape than
--   §7.2 (e.g. `body MEDIUMTEXT NOT NULL` on templates, `subject
--   VARCHAR(500)`, `last_error VARCHAR(2000)` on outbox). Per the
--   migration convention used in 0001-0004 ("design.md §7.2 wins for
--   column types and names"), this file follows §7.2 exactly for every
--   column §7.2 defines:
--     - mail_outbox.subject is VARCHAR(255), not VARCHAR(500).
--     - mail_outbox.body_text is NULL-able (some legacy/system mails
--       are HTML-only); the service layer is responsible for always
--       supplying a plaintext fallback (Req 8.3 — design §12.3).
--     - mail_outbox.template_key is VARCHAR(64) NULL — NULL allows
--       ad-hoc one-off mails (mis. Super_Admin alert when retries
--       exhaust, design §12.2) that aren't backed by a template row.
--     - mail_outbox.last_error is VARCHAR(500) — long enough for
--       nodemailer's typical SMTP error string.
--     - mail_templates carries `body_html` and `body_text` (not a
--       single `body`) so HR can override either rendering without
--       breaking the other; this matches the §12.3 merge pipeline,
--       which prefers template-row content over file-system defaults
--       per channel.
--     - mail_templates.subject is VARCHAR(255).
--     - mail_outbox.id is the auto-increment surrogate; KEY
--       `idx_outbox_pending (status, next_attempt_at)` powers the
--       flusher scan (design §11.3 — task 37.1):
--         SELECT ... WHERE status='pending' AND next_attempt_at<=NOW()
--         ORDER BY id LIMIT 200
--       The composite key narrows on `status='pending'` first and lets
--       the optimiser walk `next_attempt_at` ascending without a
--       filesort.
--
-- Columns the task summary adds beyond §7.2 (and that this migration
-- does include):
--   - `target_id BIGINT UNSIGNED NULL` — design.md §12.3 names this
--     column explicitly as the partner of `template_key` in the
--     idempotency natural key, but §7.2 omits it. Per task 35.1 this
--     migration creates it; downstream code (task 36.1) relies on
--     `INSERT IGNORE INTO mail_outbox (template_key, target_id, ...)`
--     to make enqueue safe to call multiple times from retried
--     handlers (mis. duplicate `application_confirm` after a
--     transactional retry).
--   - `UNIQUE KEY uk_outbox_natural (template_key, target_id)` —
--     enforces the idempotency contract at the SQL layer. MySQL's
--     UNIQUE-with-NULL semantics (multiple NULLs are NOT equal) give
--     us exactly the behaviour the design wants:
--       * (`application_confirm`, 42)   → at most one row.
--       * (`alert_digest`, NULL)        → many rows allowed (the
--         per-applicant alert digest is intentionally not natural-key
--         deduped — each digest run produces a distinct row).
--       * (NULL, NULL)                  → many rows allowed (ad-hoc
--         system mails).
--
-- Data type for `target_id`:
--   BIGINT UNSIGNED matches the surrogate-PK type of every entity
--   currently used as a target (`applications.id`, `users.id`,
--   `job_postings.id`, `job_alerts.id`, etc.). Choosing a VARCHAR
--   here would force string casts at enqueue time and silently allow
--   collisions across entity types ("42" from applications colliding
--   with "42" from users). The natural key is therefore intentionally
--   namespaced by `template_key`: a template_key uniquely identifies
--   the entity domain it operates on (e.g. `application_confirm` is
--   always keyed by `applications.id`).
--
-- Index strategy:
--   - PK on `mail_outbox.id` gives the flusher a stable ORDER BY for
--     fair FIFO across rows with the same `next_attempt_at`.
--   - `uk_outbox_natural (template_key, target_id)` doubles as the
--     idempotency check and as a covering index for the rare lookup
--     "does an enqueue for (template, target) already exist?".
--   - `idx_outbox_pending (status, next_attempt_at)` is the
--     flusher's read path; deliberately not extended with `id`
--     because the optimiser will already follow PK ascending after
--     the index range scan.
--   - mail_templates uses the composite (`key`, locale) as PRIMARY
--     KEY so a single B-tree lookup retrieves the override; no
--     separate uniqueness constraint is needed.
--
-- No FKs are declared:
--   - `mail_outbox.target_id` cannot FK because it's polymorphic
--     across multiple parent tables (applications, users, …). The
--     application layer is responsible for passing the correct id;
--     a stale id at most produces a "no-op" enqueue that the cron
--     still attempts to send, and the row content is already a
--     server-rendered snapshot so no join-time resolution is needed.
--   - `mail_templates.key` is a free-form template identifier
--     (`verify`, `password_reset`, `application_confirm`,
--     `interview_invitation`, `stage_change`, `alert_digest`, …)
--     not backed by a separate "kinds" table; the application
--     validates the set against a const at enqueue time.
--   - `mail_templates.locale` is CHAR(2); the application layer
--     restricts the value to {'id','en'} (design §13). A CHECK
--     constraint is intentionally NOT added so DDL stays portable
--     between MySQL 8 and MariaDB.

-- -----------------------------------------------------------------------------
-- mail_outbox (design §7.2, §12.1-§12.3 — Req 8.3, 8.4, 8.5)
-- -----------------------------------------------------------------------------
CREATE TABLE mail_outbox (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  to_email        VARCHAR(254) NOT NULL,
  to_name         VARCHAR(150) NULL,
  subject         VARCHAR(255) NOT NULL,
  body_html       MEDIUMTEXT NOT NULL,
  body_text       MEDIUMTEXT NULL,
  template_key    VARCHAR(64) NULL,                                      -- references mail_templates.`key`
  target_id       BIGINT UNSIGNED NULL,                                  -- natural-key partner (design §12.3)
  context         JSON NULL,
  status          ENUM('pending','sending','sent','failed') NOT NULL DEFAULT 'pending',
  retry_count     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error      VARCHAR(500) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at         DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_outbox_natural (template_key, target_id),
  KEY idx_outbox_pending (status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- mail_templates (design §7.2, §12.3 — Req 10.7)
--
-- One row per (template_key, locale). Both id and en rows are
-- expected for every template the product ships; HR can edit either
-- without affecting the other (Req 17 i18n contract). The file-system
-- defaults under `src/views/emails/*.njk` act as the fallback when a
-- locale row is missing — see task 36.1 for the merge logic.
-- -----------------------------------------------------------------------------
CREATE TABLE mail_templates (
  `key`       VARCHAR(64) NOT NULL,
  locale      CHAR(2) NOT NULL,
  subject     VARCHAR(255) NOT NULL,
  body_html   MEDIUMTEXT NOT NULL,
  body_text   MEDIUMTEXT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`, locale)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
