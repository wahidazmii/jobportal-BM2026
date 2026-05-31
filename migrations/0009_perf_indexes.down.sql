-- Migration: 0009_perf_indexes (rollback)
-- Drops the performance indexes added by 0009_perf_indexes.sql.

ALTER TABLE job_postings DROP INDEX idx_jp_status_pub_covering;
ALTER TABLE job_postings DROP INDEX idx_jp_deadline_status;
