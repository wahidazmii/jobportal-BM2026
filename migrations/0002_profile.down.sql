-- Rollback for 0002_profile.sql
-- Refs: design.md §7.2, tasks.md task 15.1
--
-- DROP order is the reverse of the CREATE order in the up file so the
-- foreign-key graph unwinds without leaving orphan parents:
--   - applicant_skills depends on skill_tags AND applicants
--   - applicant_cv_files / applicant_experience / applicant_education /
--     consent_records depend on applicants
--   - skill_tags has no FK dependents once applicant_skills is gone
-- All FKs have ON DELETE CASCADE on the applicants(user_id) side, but
-- DROP TABLE doesn't fire cascades — we have to drop child tables first.
--
-- Each DROP uses IF EXISTS so a partially-applied up migration (which
-- the runner shouldn't produce, but just in case) can still be rolled
-- back without the operator hand-editing this file.

DROP TABLE IF EXISTS consent_records;
DROP TABLE IF EXISTS applicant_cv_files;
DROP TABLE IF EXISTS applicant_skills;
DROP TABLE IF EXISTS skill_tags;
DROP TABLE IF EXISTS applicant_experience;
DROP TABLE IF EXISTS applicant_education;
