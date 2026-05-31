-- Migration: 0002_profile
-- Purpose : Applicant profile companion tables — education, experience, skill
--           catalog, skill links, CV file history, and the UU PDP consent log.
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §7.2 — Requirements 4.1-4.8, 16.1
--
-- Tables created (per task 15.1):
--   applicant_education, applicant_experience,
--   skill_tags, applicant_skills,
--   applicant_cv_files,
--   consent_records
--
-- Profile data (full_name, phone, address, …) already lives on the
-- `applicants` row created by 0001_init.sql, so this migration does NOT
-- redefine an `applicants` table — it only adds the satellite tables that
-- depend on `applicants(user_id)`.
--
-- FK strategy:
--   - Every satellite table that hangs off a single applicant cascades on
--     delete from `applicants(user_id)` so a UU-PDP account-deletion sweep
--     (Req 16.3) can `DELETE FROM applicants WHERE user_id=?` and have the
--     children disappear in the same statement instead of needing per-table
--     cleanup. `applicant_skills` cascades to delete the M:N link rows
--     for the same reason; `skill_tags` itself is a controlled vocabulary
--     and is referenced (no cascade) so HR can curate it independently.
--   - `chk_edu_progress` enforces the design rule that an "in progress"
--     entry has no end_date. The criterion is encoded as
--       (in_progress=1 AND end_date IS NULL) OR (in_progress=0)
--     so a completed entry MAY have a NULL end_date too (e.g. pre-grad
--     transcripts where the date is unknown), matching design.md §7.2.
--   - `applicant_cv_files` keeps the same column set as design §7.2:
--       id, applicant_user_id, storage_path, original_filename,
--       mime_type, size_bytes, is_active, uploaded_at.
--     The "at most 3 historical versions" rule (Req 4.8) is enforced in
--     the upload service, not at the schema level; the index
--     `idx_cv_applicant_active` powers both the active-CV lookup
--     `(applicant_user_id, is_active=1)` and the prune sort by
--     `uploaded_at`.
--
-- FULLTEXT:
--   - `ft_skill_label` on `skill_tags(label)` uses the InnoDB ngram parser
--     so a 2-character query (the InnoDB default `ngram_token_size=2`)
--     can find skills whose labels are short non-Latin tokens (e.g.
--     "QA", "k8s") that the default word parser wouldn't index. Skill
--     suggestions in the profile editor are a primary read path against
--     this index.
--
-- consent_records:
--   - The table is referenced from `src/modules/auth/register.ts` (task
--     9.1) which writes (applicant_user_id, policy_version, ip_address)
--     during the registration transaction. Unit tests mock the DB so
--     the bind has been deferred to here, where it lands alongside the
--     rest of the applicant satellite schema (Req 16.1).
--   - `idx_consent_app (applicant_user_id, accepted_at)` powers both
--     the "latest consent for user" lookup used by the policy-version
--     middleware (task 46.1) and the data-export query (Req 16.2).

-- -----------------------------------------------------------------------------
-- applicant_education (Req 4.2)
-- -----------------------------------------------------------------------------
CREATE TABLE applicant_education (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  applicant_user_id  BIGINT UNSIGNED NOT NULL,
  institution        VARCHAR(150) NOT NULL,
  degree             VARCHAR(100) NOT NULL,
  field              VARCHAR(100) NOT NULL,
  start_date         DATE NOT NULL,
  end_date           DATE NULL,
  in_progress        TINYINT(1) NOT NULL DEFAULT 0,
  gpa                DECIMAL(3,2) NULL,
  PRIMARY KEY (id),
  KEY idx_edu_applicant (applicant_user_id),
  CONSTRAINT fk_edu_applicant
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id) ON DELETE CASCADE,
  CONSTRAINT chk_edu_progress
    CHECK ((in_progress = 1 AND end_date IS NULL) OR (in_progress = 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- applicant_experience (Req 4.3)
-- -----------------------------------------------------------------------------
CREATE TABLE applicant_experience (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  applicant_user_id  BIGINT UNSIGNED NOT NULL,
  company            VARCHAR(150) NOT NULL,
  title              VARCHAR(100) NOT NULL,
  employment_type    ENUM('full-time','part-time','contract','internship','freelance') NOT NULL,
  start_date         DATE NOT NULL,
  end_date           DATE NULL,
  is_current         TINYINT(1) NOT NULL DEFAULT 0,
  description        VARCHAR(1000) NULL,
  PRIMARY KEY (id),
  KEY idx_exp_applicant (applicant_user_id),
  CONSTRAINT fk_exp_applicant
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- skill_tags (controlled vocabulary, Req 4.4)
--
-- The unique index `uk_skill_label` enforces case-insensitive distinctness
-- (utf8mb4_unicode_ci is accent- and case-insensitive). The FULLTEXT index
-- `ft_skill_label` is parsed with `ngram` so two-character queries match
-- — the InnoDB default `ngram_token_size=2` is exactly what the autocomplete
-- in the profile editor needs.
-- -----------------------------------------------------------------------------
CREATE TABLE skill_tags (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  label   VARCHAR(50) NOT NULL,
  active  TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_skill_label (label),
  FULLTEXT KEY ft_skill_label (label) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- applicant_skills (M:N link applicants ↔ skill_tags, Req 4.4)
--
-- Composite PK doubles as the natural uniqueness constraint — an applicant
-- cannot tag the same skill twice. CASCADE on the applicant side wipes the
-- link rows when the user is deleted; we deliberately do NOT cascade on
-- skill deletion because HR retires skills via the `active` flag rather
-- than DELETE.
-- -----------------------------------------------------------------------------
CREATE TABLE applicant_skills (
  applicant_user_id  BIGINT UNSIGNED NOT NULL,
  skill_id           BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (applicant_user_id, skill_id),
  KEY idx_aps_skill (skill_id),
  CONSTRAINT fk_aps_app
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_aps_skill
    FOREIGN KEY (skill_id) REFERENCES skill_tags(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- applicant_cv_files (Req 4.5-4.8)
--
-- `storage_path` is a path relative to ~/file_store, populated by the
-- upload service after a successful fs.rename from tmp to the final
-- yyyy/mm/uuid.ext layout (design §6 flow). The composite index
-- `(applicant_user_id, is_active, uploaded_at)` covers two hot reads:
--   - active CV lookup at apply time
--     (`WHERE applicant_user_id=? AND is_active=1 ORDER BY uploaded_at DESC LIMIT 1`)
--   - 3-version prune
--     (`SELECT id FROM applicant_cv_files WHERE applicant_user_id=? ORDER BY uploaded_at DESC`)
-- -----------------------------------------------------------------------------
CREATE TABLE applicant_cv_files (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  applicant_user_id  BIGINT UNSIGNED NOT NULL,
  storage_path       VARCHAR(255) NOT NULL,                    -- relative to ~/file_store
  original_filename  VARCHAR(255) NOT NULL,
  mime_type          VARCHAR(100) NOT NULL,
  size_bytes         INT UNSIGNED NOT NULL,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  uploaded_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cv_applicant_active (applicant_user_id, is_active, uploaded_at),
  CONSTRAINT fk_cv_app
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- consent_records (UU PDP, Req 16.1)
--
-- Append-only log of every privacy-policy acceptance. `register.ts` writes
-- the first row at sign-up; the policy-version middleware (task 46.1)
-- writes additional rows when an Applicant accepts a new policy version.
-- The composite index supports the "latest consent for this user"
-- lookup with a single backward index scan.
-- -----------------------------------------------------------------------------
CREATE TABLE consent_records (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  applicant_user_id  BIGINT UNSIGNED NOT NULL,
  policy_version     VARCHAR(20) NOT NULL,
  accepted_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address         VARBINARY(16) NULL,
  PRIMARY KEY (id),
  KEY idx_consent_app (applicant_user_id, accepted_at),
  CONSTRAINT fk_consent_app
    FOREIGN KEY (applicant_user_id) REFERENCES applicants(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
