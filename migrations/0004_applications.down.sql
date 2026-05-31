-- Rollback for 0004_applications.sql
-- Refs: design.md §7.2, tasks.md task 25.1
--
-- DROP order is the reverse of the CREATE order in the up file so the
-- foreign-key graph unwinds without leaving orphan parents:
--   - bookmarks has no dependents — safe to drop first.
--   - application_interviews, application_notes, and
--     application_stage_history all FK to `applications(id)` (CASCADE
--     on row delete, but DROP TABLE does not run row cascades), so
--     they go before `applications`.
--   - applications FKs to `applicants`, `job_postings`, and
--     `applicant_cv_files` (all owned by earlier migrations); once
--     the four children above are gone, dropping `applications`
--     leaves those parents intact.
--
-- Each DROP uses IF EXISTS so a partially-applied up migration can
-- still be rolled back without the operator hand-editing this file.

DROP TABLE IF EXISTS bookmarks;
DROP TABLE IF EXISTS application_interviews;
DROP TABLE IF EXISTS application_notes;
DROP TABLE IF EXISTS application_stage_history;
DROP TABLE IF EXISTS applications;
