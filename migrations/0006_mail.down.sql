-- Rollback for 0006_mail.sql
-- Refs: design.md §7.2, tasks.md task 35.1
--
-- Neither table has dependents elsewhere in the schema:
--   - mail_outbox holds server-rendered snapshots; nothing FKs into it.
--   - mail_templates is read at enqueue time only; nothing FKs into it.
-- Drop order is therefore arbitrary, but we still drop `mail_outbox`
-- first to mirror the create order in the up file (parent of the
-- mail-flow lifecycle, even though the relation is logical not FK).
--
-- IF EXISTS keeps the down idempotent in case the up migration was
-- only partially applied (e.g. a syntax error after the first CREATE).

DROP TABLE IF EXISTS mail_outbox;
DROP TABLE IF EXISTS mail_templates;
