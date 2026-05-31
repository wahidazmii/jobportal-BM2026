-- Rollback for 0003_jobs.sql
-- Refs: design.md §7.2, tasks.md task 20.1
--
-- DROP order is the reverse of the CREATE order in the up file so the
-- foreign-key graph unwinds without leaving orphan parents:
--   - job_posting_translations depends on job_postings (CASCADE on delete,
--     but DROP TABLE does not trigger row cascades, so children go first).
--   - job_postings depends on departments (fk_job_dept) and users
--     (fk_job_creator), so it must be dropped before departments.
--   - user_department_assignments depends on departments AND users; once
--     job_postings is gone, departments can be dropped after the link
--     table.
--   - departments has no remaining FK dependents at this point.
--
-- Each DROP uses IF EXISTS so a partially-applied up migration can still
-- be rolled back without the operator hand-editing this file.

DROP TABLE IF EXISTS job_posting_translations;
DROP TABLE IF EXISTS job_postings;
DROP TABLE IF EXISTS user_department_assignments;
DROP TABLE IF EXISTS departments;

