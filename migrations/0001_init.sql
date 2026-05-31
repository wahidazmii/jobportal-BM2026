-- Migration: 0001_init
-- Purpose : Initial schema — auth, sessions, applicants stub, infra (rate limits,
--           login attempts, cron locks, schema migrations) plus Phase-2 token tables.
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §7.2, §8.6 — Requirements 1.2, 3.5, 14.2, 14.3, 14.4
--
-- Tables created (per task 5.3):
--   users, applicants, sessions, schema_migrations, login_attempts,
--   rate_limits, cron_locks
-- Plus Phase-2 token tables (verification_tokens, password_reset_tokens) so the
-- registration → verification → password-reset flow has its persistence layer
-- ready in lockstep with the auth modules built on top of this migration.
--
-- Indexes created (per task 5.3):
--   uk_users_email, uk_users_uuid, idx_users_role,
--   idx_login_attempts_email_time, idx_rate_limits_key_window,
--   PRIMARY KEY cron_locks(name)
--
-- Notes:
--   - The task list mentions a `csrf_tokens` table, but design §8.6 explicitly
--     stores CSRF tokens inline on `sessions.csrf_token` (a CHAR(43) column on
--     each session row). Design wins — there is intentionally no separate
--     `csrf_tokens` table. This keeps the double-submit cookie/token check a
--     single-row session lookup with no join.
--   - `schema_migrations` carries `filename` in addition to the design's
--     (id, checksum, applied_at) so migrate.mjs (task 5.1) can record source.
--   - This file is executed inside a single transaction by tools/migrate.mjs;
--     however MySQL/MariaDB implicitly commit DDL statements, so each CREATE
--     TABLE is effectively its own commit. The migration tool still wraps
--     bookkeeping (`schema_migrations` insert) in an atomic step and rolls
--     forward only when every statement succeeds.

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid              CHAR(36) NOT NULL,
  email             VARCHAR(254) NOT NULL,
  password_hash     VARCHAR(72) NOT NULL,                                 -- bcrypt
  role              ENUM('Super_Admin','HR','Department_Head','Applicant') NOT NULL,
  status            ENUM('pending','active','disabled','deleted') NOT NULL DEFAULT 'pending',
  email_verified_at DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email),
  UNIQUE KEY uk_users_uuid  (uuid),
  KEY        idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- applicants (1:1 with users for role='Applicant')
-- -----------------------------------------------------------------------------
CREATE TABLE applicants (
  user_id        BIGINT UNSIGNED NOT NULL,
  full_name      VARCHAR(100) NOT NULL,
  date_of_birth  DATE NULL,
  gender         ENUM('male','female','prefer-not-to-say') NULL,
  phone          VARCHAR(20) NULL,
  address        VARCHAR(255) NULL,
  city           VARCHAR(100) NULL,
  province       VARCHAR(100) NULL,
  country        VARCHAR(100) NULL,
  summary        VARCHAR(500) NULL,
  language_pref  CHAR(2) NOT NULL DEFAULT 'id',
  PRIMARY KEY (user_id),
  CONSTRAINT fk_applicants_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- sessions (server-side session store with embedded CSRF token, design §8.6)
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
  id              CHAR(43) NOT NULL,                                       -- base64url(32 bytes)
  user_id         BIGINT UNSIGNED NOT NULL,
  ip_address      VARBINARY(16) NULL,                                      -- IPv4/IPv6 packed
  user_agent      VARCHAR(255) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME NOT NULL,
  csrf_token      CHAR(43) NOT NULL,                                       -- base64url(32 bytes)
  PRIMARY KEY (id),
  KEY idx_sess_user    (user_id),
  KEY idx_sess_expires (expires_at),
  CONSTRAINT fk_sess_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- schema_migrations (bookkeeping for tools/migrate.mjs)
--
-- IF NOT EXISTS: tools/migrate.mjs bootstraps this table on first run via
-- ensureMigrationsTable() BEFORE applying any migration file, so this CREATE
-- must be a no-op when the bootstrap shape already exists. The bootstrap shape
-- (id, checksum, applied_at) is a strict subset of the columns below, and the
-- migrate.mjs INSERT only writes (id, checksum); `filename` is therefore NULLable
-- so the bookkeeping insert never fails.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          VARCHAR(20)  NOT NULL,                                       -- e.g. "0001_init"
  checksum    CHAR(64)     NOT NULL,                                       -- sha256 hex
  filename    VARCHAR(120) NULL,                                           -- e.g. "0001_init.sql"
  applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- login_attempts (anti brute force; pruned by cron session-gc, design §7.3)
--
-- Index `idx_login_attempts_email_time` powers the lockout query
--   `SELECT COUNT(*) FROM login_attempts WHERE email=? AND attempt_at>=NOW()-INTERVAL 15 MINUTE`
-- (Req 3 AC #7, Req 14 AC #3); the IP-time index supports per-IP rate limiting
-- (Req 14 AC #3) and the cron `session-gc` 90-day prune (design §7.3).
-- -----------------------------------------------------------------------------
CREATE TABLE login_attempts (
  email       VARCHAR(254) NOT NULL,
  ip_address  VARBINARY(16) NOT NULL,
  attempt_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success     TINYINT(1) NOT NULL,
  KEY idx_login_attempts_email_time (email, attempt_at),
  KEY idx_login_attempts_ip_time    (ip_address, attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- rate_limits (sliding bucket counters, e.g. "register:ip:1.2.3.4")
--
-- The PRIMARY KEY on `bucket` already gives us a unique lookup, but task 5.3
-- explicitly calls for `idx_rate_limits_key_window` so window-based sweeps
-- (`DELETE FROM rate_limits WHERE window_started_at < NOW() - INTERVAL 1 HOUR`)
-- run as an index range scan instead of a table scan once buckets accumulate.
-- -----------------------------------------------------------------------------
CREATE TABLE rate_limits (
  bucket             VARCHAR(64)  NOT NULL,
  count              INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket),
  KEY idx_rate_limits_key_window (bucket, window_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- cron_locks (advisory lock + last-run telemetry per cron job)
-- -----------------------------------------------------------------------------
CREATE TABLE cron_locks (
  name           VARCHAR(64) NOT NULL,
  locked_at      DATETIME NULL,
  heartbeat_at   DATETIME NULL,
  last_run_at    DATETIME NULL,
  last_status    ENUM('ok','error') NULL,
  last_error     VARCHAR(500) NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- verification_tokens (email verification flow, Phase 2)
-- -----------------------------------------------------------------------------
CREATE TABLE verification_tokens (
  token       CHAR(43) NOT NULL,                                           -- base64url(32 bytes)
  user_id     BIGINT UNSIGNED NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token),
  KEY idx_vtok_user (user_id),
  CONSTRAINT fk_vt_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- password_reset_tokens (forgot-password flow, Phase 2)
-- -----------------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
  token       CHAR(43) NOT NULL,                                           -- base64url(32 bytes)
  user_id     BIGINT UNSIGNED NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token),
  KEY idx_prtok_user (user_id),
  CONSTRAINT fk_prt_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
