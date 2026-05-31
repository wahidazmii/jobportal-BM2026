-- Rollback for 0005_alerts.sql
-- Refs: design.md §7.2, tasks.md task 32.1
--
-- DROP order is the reverse of the CREATE order in the up file. Only
-- one table was created (`job_alerts`) — design.md §7.2 does not
-- define a `job_alert_runs` table, so the up file did not create one
-- and there is nothing else to drop here. If a future migration adds
-- `job_alert_runs` (or any other child of `job_alerts`), its own
-- `*.down.sql` is responsible for unwinding that table BEFORE this
-- file is run, since the runner rolls back one migration at a time
-- in reverse order.
--
-- IF EXISTS so a partially-applied up migration can still be rolled
-- back without the operator hand-editing this file.

DROP TABLE IF EXISTS job_alerts;
