-- Migration: 0004_applications
-- Purpose : Recruitment pipeline core — the `applications` row plus the
--           four satellites it owns (stage history, internal/visible
--           notes, scheduled interviews) and the `bookmarks` join used
--           by Applicant saved-jobs.
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §7.2 (DDL ground truth) — Requirements 5.1-5.8,
--           6.4-6.6, 10.1-10.7
--
-- Tables created (per task 25.1):
--   applications
--   application_stage_history
--   application_notes
--   application_interviews
--   bookmarks
--
-- Why these five together:
--   - `application_stage_history`, `application_notes`, and
--     `application_interviews` all FK to `applications(id)` and cascade
--     on delete, so they cannot exist before `applications`.
--   - `bookmarks` is independent of `applications` but lives in the same
--     domain (Applicant ↔ Job_Posting) and shares the same parent tables
--     (`applicants`, `job_postings`); landing it here keeps the up/down
--     pair self-contained for the "applications + bookmarks" domain
--     (Req 6.4-6.6 alongside Req 5.x and 10.x).
--
-- Stage enum:
--   The seven Pipeline_Stage values {Applied, Screening, Interview,
--   Offer, Hired, Rejected, Withdrawn} are repeated across
--   `applications.stage`, `application_stage_history.prev_stage`, and
--   `application_stage_history.new_stage` because MySQL does not
--   support a shared ENUM type. Any future change must touch all three
--   columns in a new migration; the service layer (task 29.2) is the
--   single source for transition rules.
--
-- FK strategy:
--   - `applications.applicant_user_id → applicants(user_id)` matches
--     design.md §7.2. We do NOT cascade on delete here: if an applicant
--     account is removed via the UU-PDP sweep (Req 16.3), the
--     `applicants` row deletion cascades through 0002_profile.sql
--     children, but applications must be retained for legal /
--     reporting reasons (time-to-hire history, Req 13.x). Cleanup of
--     orphan applications is handled by the data-export + anonymise
--     workflow, not by FK cascade.
--   - `applications.job_id → job_postings(id)` is non-cascading. A
--     posting can be Closed/Archived without dropping its applications,
--     and we never DELETE a job posting outright (status transitions
--     only — design §6 Admin, task 21.2).
--   - `applications.cv_file_id → applicant_cv_files(id)` snapshots the
--     CV that was active at submission time (design §9, Req 5.1). The
--     CV row is preserved so HR can re-download exactly the file the
--     applicant submitted, even after the applicant uploads a newer
--     version (the 3-version retention rule in 0002 prunes by
--     `is_active` ordering, not by application reference; the upload
--     service is responsible for not pruning a CV that is still
--     referenced — task 17.1).
--   - `application_stage_history.application_id`,
--     `application_notes.application_id`, and
--     `application_interviews.application_id` all CASCADE on delete so
--     that if an Application is hard-deleted (rare — see above), its
--     audit trail vanishes with it instead of leaving orphans.
--   - `application_notes.author_user_id → users(id)` is non-cascading;
--     a note must outlive the deletion of its author (Req 12 audit
--     immutability).
--   - `application_stage_history.changed_by` is NULLable with no FK —
--     design.md §7.2 specifies a nullable bigint without an FK so that
--     system-generated transitions (e.g. an automated Withdraw triggered
--     by a job archive sweep, future feature) can record the lack of a
--     human actor without inventing a sentinel user id.
--   - `application_interviews.interviewer_user_id` is NULLable with no
--     FK — design.md §7.2 again. An interview can be scheduled before a
--     specific interviewer is assigned; the application layer is
--     responsible for resolving the id to a real user when set.
--   - `bookmarks.applicant_user_id` and `bookmarks.job_id` BOTH cascade
--     on delete because a bookmark is purely a saved-search artefact —
--     no audit value once either side is gone (Req 6.5-6.6).
--
-- Indexes:
--   - `uk_app_applicant_job (applicant_user_id, job_id)` enforces the
--     "no duplicate application" rule (Req 5.3 — ApplyTwiceProperty,
--     Property 1, task 26.3). The unique violation is the natural
--     idempotency check at the SQL layer; the service catches
--     ER_DUP_ENTRY and returns a friendly 409.
--   - `uk_app_uuid` and `uk_app_ref` give two stable external
--     identifiers: UUID for internal admin links / audit, and
--     `reference_no` (e.g. APP-2026-000123) for human-facing
--     correspondence per Req 5.5 (confirmation email body).
--   - `idx_app_job_stage (job_id, stage)` covers the kanban board
--     query (Req 10.1, task 29.1) which fetches one column at a time:
--       SELECT ... FROM applications WHERE job_id=? AND stage=? ...
--   - `idx_app_applicant (applicant_user_id, applied_at)` covers the
--     applicant-side list (Req 5.6, task 27.1):
--       SELECT ... WHERE applicant_user_id=? ORDER BY applied_at DESC.
--   - `idx_ash_app (application_id, changed_at)` powers the timeline
--     render in Req 5.7 (task 27.1) — single backward scan per
--     application.
--   - `idx_note_app (application_id, created_at)` mirrors the notes
--     timeline read pattern (Req 10.3, task 30.1).
--   - `idx_int_app (application_id)` is the lookup index for the
--     "interviews on this application" list; design §7.2 deliberately
--     does not include `scheduled_at` in the key because the row count
--     per application is tiny (handful at most) and a filesort on
--     scheduled_at is cheaper than a wider index.
--
-- Notes on design vs task summary:
--   The task summary in tasks.md mentions a few columns/indexes that
--   are not present in design.md §7.2 (e.g. an `actor_user_id NOT NULL`
--   on stage history, a `withdrawn_at` on applications, a `notes`
--   column on interviews, a `idx_bm_user_created` on bookmarks). Per
--   the explicit "design.md wins" instruction, this migration follows
--   the §7.2 DDL exactly. Withdraw timestamps are captured by the
--   `application_stage_history` row whose `new_stage='Withdrawn'`
--   (Req 5.8); the service layer (task 26.2) reads that row when it
--   needs to display "Withdrawn at …" to the applicant.

-- -----------------------------------------------------------------------------
-- applications (design §7.2, Req 5.1-5.5)
-- -----------------------------------------------------------------------------
CREATE TABLE applications (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                CHAR(36) NOT NULL,
  reference_no        VARCHAR(20) NOT NULL,                 -- e.g. APP-2026-000123
  applicant_user_id   BIGINT UNSIGNED NOT NULL,
  job_id              BIGINT UNSIGNED NOT NULL,
  cv_file_id          BIGINT UNSIGNED NOT NULL,             -- snapshot at submission
  stage               ENUM('Applied','Screening','Interview','Offer','Hired','Rejected','Withdrawn')
                          NOT NULL DEFAULT 'Applied',
  source              ENUM('direct','search','alert','social','unknown')
                          NOT NULL DEFAULT 'unknown',
  applied_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  hired_at            DATETIME NULL,                        -- denormalised for time-to-hire
  PRIMARY KEY (id),
  UNIQUE KEY uk_app_uuid (uuid),
  UNIQUE KEY uk_app_ref (reference_no),
  UNIQUE KEY uk_app_applicant_job (applicant_user_id, job_id),
  KEY idx_app_job_stage (job_id, stage),
  KEY idx_app_applicant (applicant_user_id, applied_at),
  CONSTRAINT fk_app_applicant
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id),
  CONSTRAINT fk_app_job
    FOREIGN KEY (job_id) REFERENCES job_postings(id),
  CONSTRAINT fk_app_cv
    FOREIGN KEY (cv_file_id) REFERENCES applicant_cv_files(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- application_stage_history (design §7.2, Req 5.7, 10.2)
--
-- One row per stage transition, including the synthetic "create" row
-- (`prev_stage IS NULL`, `new_stage='Applied'`) inserted by the apply
-- service so the timeline always starts at a real event. `changed_by`
-- is NULLable per design.md §7.2 to allow system-driven transitions
-- without an FK; see header notes for rationale.
-- -----------------------------------------------------------------------------
CREATE TABLE application_stage_history (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id  BIGINT UNSIGNED NOT NULL,
  prev_stage      ENUM('Applied','Screening','Interview','Offer','Hired','Rejected','Withdrawn') NULL,
  new_stage       ENUM('Applied','Screening','Interview','Offer','Hired','Rejected','Withdrawn') NOT NULL,
  changed_by      BIGINT UNSIGNED NULL,
  changed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ash_app (application_id, changed_at),
  CONSTRAINT fk_ash_app
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- application_notes (design §7.2, Req 10.3, 8.2)
--
-- `body VARCHAR(5000)` matches design.md §7.2 — long enough for a
-- substantial HR note without bloating the row to TEXT (which would
-- force off-page storage on every read). `visible_to_applicant` toggles
-- whether the note is exposed in the applicant timeline (Req 5.7) and
-- whether a notification email is enqueued (Req 8.2, task 30.1).
-- -----------------------------------------------------------------------------
CREATE TABLE application_notes (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id        BIGINT UNSIGNED NOT NULL,
  author_user_id        BIGINT UNSIGNED NOT NULL,
  body                  VARCHAR(5000) NOT NULL,
  visible_to_applicant  TINYINT(1) NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_note_app (application_id, created_at),
  CONSTRAINT fk_note_app
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_note_author
    FOREIGN KEY (author_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- application_interviews (design §7.2, Req 10.4)
--
-- Both `location` (e.g. office address) and `meeting_url` (Zoom / Meet
-- link) are nullable so an interview row can carry either or both
-- depending on the format. `interviewer_user_id` is NULLable with no FK
-- per design §7.2 — the application layer maps it to a real user when
-- present. `status` defaults to 'scheduled' so a freshly-inserted row
-- is immediately listed in upcoming-interview views without an extra
-- update.
-- -----------------------------------------------------------------------------
CREATE TABLE application_interviews (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id        BIGINT UNSIGNED NOT NULL,
  scheduled_at          DATETIME NOT NULL,
  location              VARCHAR(500) NULL,
  meeting_url           VARCHAR(2000) NULL,
  interviewer_user_id   BIGINT UNSIGNED NULL,
  status                ENUM('scheduled','done','cancelled','no-show') NOT NULL DEFAULT 'scheduled',
  PRIMARY KEY (id),
  KEY idx_int_app (application_id),
  CONSTRAINT fk_int_app
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- bookmarks (design §7.2, Req 6.4-6.6)
--
-- Composite PK (applicant_user_id, job_id) doubles as the natural
-- uniqueness constraint — toggling a bookmark on/off is a simple
-- INSERT IGNORE / DELETE pair. Both FKs cascade so bookmark cleanup
-- is automatic when either side is removed.
-- -----------------------------------------------------------------------------
CREATE TABLE bookmarks (
  applicant_user_id  BIGINT UNSIGNED NOT NULL,
  job_id             BIGINT UNSIGNED NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (applicant_user_id, job_id),
  CONSTRAINT fk_bm_app
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_bm_job
    FOREIGN KEY (job_id) REFERENCES job_postings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
