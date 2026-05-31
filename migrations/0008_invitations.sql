-- Migration: 0008_invitations
-- Purpose : Single-use invitation tokens for the Super_Admin "invite an
--           internal user" flow. Each invite creates a PENDING `users`
--           row (no password yet) plus one `invitation_tokens` row whose
--           `token` is mailed to the invitee and is valid for 7 days
--           (Req 11.7). When the invitee accepts, the application marks
--           `accepted_at` and sets the user's password + status=active.
-- Engine  : InnoDB
-- Charset : utf8mb4 / utf8mb4_unicode_ci
-- Refs    : design.md §6 Admin (GET /admin/users, POST /admin/users/invite),
--           §7.2 (DDL conventions), §15 (audit) — Requirements 11.7, 12.1
--
-- Tables created (per task 42.1):
--   invitation_tokens
--
-- Column shape mirrors the existing token tables in 0001_init.sql
-- (`verification_tokens`, `password_reset_tokens`) so the invite flow's
-- persistence layer reads the same as the register/verify flows:
--   - `token` is CHAR(43): 32 random bytes encoded as base64url produce
--     exactly 43 chars (no padding), identical to the verification /
--     password-reset token width.
--   - `user_id` FKs the freshly-created PENDING account with
--     ON DELETE CASCADE, matching `fk_vt_user` / `fk_prt_user`: deleting
--     the pending account disposes of its outstanding invitation token.
--   - `expires_at` is DB-evaluated as `NOW() + INTERVAL 7 DAY` at INSERT
--     time (the application never binds the timestamp) so the 7-day
--     validity window (Req 11.7) is stamped on the single DB clock.
--   - `accepted_at` is NULL until the invitee accepts; a non-NULL value
--     marks the token consumed (single-use) so it cannot be replayed.
--
-- `role` ENUM (the INVITED role):
--   Constrained to the three internal roles — `Applicant` is deliberately
--   excluded because Req 11.7 invites *internal users* only (applicants
--   self-register via Req 3). The application layer validates the same
--   set with zod before the INSERT; the ENUM is the DB-level backstop.
--
-- `invited_by_user_id` (the Super_Admin who issued the invite):
--   Nullable with `ON DELETE SET NULL` rather than CASCADE — an
--   invitation record (and the resulting account) must outlive the
--   deletion of the inviter's account. This mirrors the non-cascading
--   actor-reference pattern used elsewhere in the schema
--   (`application_stage_history.changed_by`, `application_notes`
--   author refs — see migration 0004_applications.sql) so audit/history
--   survives an actor purge.
--
-- Indexes:
--   - `uk_invitation_token (token)` — UNIQUE: the token is the lookup
--     key the accept endpoint dereferences, and must be globally unique.
--   - `idx_invitation_user (user_id)` — resolve the token(s) for an
--     account (e.g. invalidate prior unused invites on re-invite).
--   - `idx_invitation_expires (expires_at)` — range scan for the
--     housekeeping sweep that prunes expired, unaccepted invitations
--     (mirrors the session-gc token cleanup in §8.4 / §11.2).

-- -----------------------------------------------------------------------------
-- invitation_tokens (design §6 Admin, §7.2 — Req 11.7, 12.1)
-- -----------------------------------------------------------------------------
CREATE TABLE invitation_tokens (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token               CHAR(43) NOT NULL,                                  -- base64url(32 bytes)
  user_id             BIGINT UNSIGNED NOT NULL,                           -- the pending account
  role                ENUM('Super_Admin','HR','Department_Head') NOT NULL,-- the invited role
  invited_by_user_id  BIGINT UNSIGNED NULL,                               -- Super_Admin who invited
  expires_at          DATETIME NOT NULL,
  accepted_at         DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_invitation_token (token),
  KEY idx_invitation_user (user_id),
  KEY idx_invitation_expires (expires_at),
  CONSTRAINT fk_invtok_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_invtok_invited_by
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
