-- Migration: 0003_jobs
-- Purpose : Job postings domain — departments controlled vocab, the M:N
--           link between Department_Head users and the departments they
--           own, the canonical `job_postings` row plus its locale-specific
--           translation rows.
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §7.2, §10.1 — Requirements 9.1, 9.7, 17.4
--
-- Tables created (per task 20.1):
--   departments
--   user_department_assignments
--   job_postings
--   job_posting_translations
--
-- Why these four together:
--   - `job_postings.department_id` is a FK to `departments`, so
--     `departments` must exist first.
--   - `user_department_assignments` joins `users` (created in 0001_init)
--     and `departments`; it lives here because Department_Head scoping
--     (design §14.2, Req 11.4) only becomes meaningful once `job_postings`
--     and `applications` carry a department_id.
--   - `job_posting_translations` carries the (id, en) localized copy and
--     is composite-keyed on (job_id, locale) per design §7.2; we keep it
--     in the same migration so the up/down pair never leaves a half-built
--     job posting schema (Req 17.4).
--
-- FULLTEXT search:
--   - `ft_job_search` on `job_postings.search_text` uses the InnoDB
--     `ngram` parser (token size 2) so two-character keyword queries
--     (e.g. "QA", "ML", "PM") match — the same parser choice as
--     `ft_skill_label` in 0002_profile.sql for consistency.
--   - `search_text` is maintained by the repository on save (see
--     §10.1, task 21.1) by concatenating the id + en title, description,
--     requirements, responsibilities, and skill labels. The column is
--     declared NOT NULL DEFAULT '' so an empty Draft row created via
--     a SELECT projection fallback never violates the schema; the
--     application layer is still expected to populate it on every
--     UPDATE/INSERT.
--
-- Status state machine (Draft → Published → Closed/Archived) is enforced
-- in the service layer (task 21.2). The schema constrains values via the
-- ENUM, but transitions are application-level.
--
-- Slug uniqueness:
--   - `slug VARCHAR(120)` with `UNIQUE KEY uk_job_slug (slug)`. The
--     repository uses `SELECT ... FOR UPDATE` against this index inside
--     the publish transaction (task 21.2) to avoid the TOCTOU between
--     "is this slug free?" and "INSERT ... slug=?".
--
-- FK strategy:
--   - `job_postings.department_id` is NULLable so a job posting can
--     remain unassigned (e.g. cross-functional roles) while still
--     pointing at a real department once HR triages it. We do NOT
--     cascade on department delete because retiring a department is
--     done via a separate workflow that re-points the jobs first.
--   - `job_postings.created_by` references `users(id)` without cascade;
--     audit history must outlive an account deletion (Req 12.3).
--   - `job_posting_translations.job_id` cascades on delete so removing
--     a job posting (Archived sweep, future migration) automatically
--     drops its translations — there is no use for orphan translations.

-- -----------------------------------------------------------------------------
-- departments (controlled vocabulary)
-- -----------------------------------------------------------------------------
CREATE TABLE departments (
  id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code  VARCHAR(50)  NOT NULL,
  name  VARCHAR(150) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_dept_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- user_department_assignments (Department_Head scoping, design §14.2, Req 11.4)
--
-- Composite PK doubles as the natural uniqueness constraint — a user
-- cannot be assigned to the same department twice. The reverse-direction
-- index `idx_uda_dept` answers "which users own department X?" without
-- a full table scan when HR audits department ownership.
-- -----------------------------------------------------------------------------
CREATE TABLE user_department_assignments (
  user_id        BIGINT UNSIGNED NOT NULL,
  department_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, department_id),
  KEY idx_uda_dept (department_id),
  CONSTRAINT fk_uda_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_uda_dept
    FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- job_postings (design §7.2, Req 9.1, 9.7, 17.4)
--
-- Indexes:
--   uk_job_slug         — slug is the public URL key, unique across all
--                         postings (closed/archived rows still occupy a
--                         slug because we never reuse public URLs).
--   uk_job_uuid         — UUID is the stable external identifier used by
--                         admin links and audit events.
--   idx_job_status_pub  — covers `WHERE status='Published' ORDER BY
--                         published_at DESC` for the public list (§10.2).
--   idx_job_deadline    — drives the "expired" sweep
--                         `WHERE application_deadline < CURDATE()` used
--                         by the search-visibility predicate (Property 5,
--                         Req 9.4).
--   idx_job_dept        — answers Department_Head scoping queries
--                         `WHERE department_id IN (?)` (Req 11.4).
--   ft_job_search       — FULLTEXT(search_text) WITH PARSER ngram for
--                         the public keyword search (§10.2, Req 6.1).
-- -----------------------------------------------------------------------------
CREATE TABLE job_postings (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                  CHAR(36) NOT NULL,
  slug                  VARCHAR(120) NOT NULL,
  department_id         BIGINT UNSIGNED NULL,
  location              VARCHAR(150) NOT NULL,
  employment_type       ENUM('full-time','part-time','contract','internship') NOT NULL,
  level                 ENUM('entry','junior','mid','senior','lead','manager','director') NOT NULL,
  status                ENUM('Draft','Published','Closed','Archived') NOT NULL DEFAULT 'Draft',
  salary_min            INT UNSIGNED NULL,
  salary_max            INT UNSIGNED NULL,
  salary_currency       CHAR(3) NULL,
  application_deadline  DATE NULL,
  published_at          DATETIME NULL,
  created_by            BIGINT UNSIGNED NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Searchable concatenated text (id+en) maintained by the repo on save.
  search_text           MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_job_slug (slug),
  UNIQUE KEY uk_job_uuid (uuid),
  KEY idx_job_status_pub (status, published_at),
  KEY idx_job_deadline   (application_deadline),
  KEY idx_job_dept       (department_id),
  CONSTRAINT fk_job_dept
    FOREIGN KEY (department_id) REFERENCES departments(id),
  CONSTRAINT fk_job_creator
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- job_posting_translations (design §7.2, Req 17.4)
--
-- Composite PK (job_id, locale) gives a single backward index scan for
-- the "all translations for this job" lookup and is the natural
-- uniqueness constraint — exactly one row per (job, locale). Locales
-- are validated at the application layer against the supported set
-- {id, en} (design §17.4); a CHECK constraint here would couple the
-- DB to the i18n catalog, which is intentionally application-driven.
-- ON DELETE CASCADE ensures translations follow the parent posting.
-- -----------------------------------------------------------------------------
CREATE TABLE job_posting_translations (
  job_id            BIGINT UNSIGNED NOT NULL,
  locale            CHAR(2) NOT NULL,
  title             VARCHAR(150) NOT NULL,
  description       MEDIUMTEXT NOT NULL,
  requirements      MEDIUMTEXT NOT NULL,
  responsibilities  MEDIUMTEXT NOT NULL,
  PRIMARY KEY (job_id, locale),
  CONSTRAINT fk_jpt_job
    FOREIGN KEY (job_id) REFERENCES job_postings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

