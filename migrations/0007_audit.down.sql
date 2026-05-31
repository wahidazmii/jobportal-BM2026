-- Rollback for 0007_audit.sql
-- Refs: design.md §7.2, §15, tasks.md task 38.1
--
-- `audit_events` has no incoming foreign keys (no other table FKs to
-- it) and no outgoing foreign keys (the actor reference is FK-less
-- by design — see the up file's "No FK on actor_user_id" note), so
-- a single DROP unwinds the whole migration. IF EXISTS keeps the
-- rollback idempotent against a partially-applied up.

DROP TABLE IF EXISTS audit_events;
