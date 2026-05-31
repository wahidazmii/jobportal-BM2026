-- Rollback for 0008_invitations.sql
-- Refs: design.md §6 Admin, §7.2, tasks.md task 42.1
--
-- `invitation_tokens` has no incoming foreign keys (nothing else FKs
-- to it) — its two outgoing FKs to `users` are dropped implicitly with
-- the table. A single DROP therefore unwinds the whole migration.
-- IF EXISTS keeps the rollback idempotent against a partially-applied
-- up migration.

DROP TABLE IF EXISTS invitation_tokens;
