-- Migration: 0009_perf_indexes
-- Purpose : LCP / query-performance indexes for the public job listing
--           and job detail pages (task 56.1).
-- Refs    : design.md §4.3, §10.2, §20.2 — Requirements 2.10, 6.3
--
-- Background
-- ----------
-- The public listing query (design §10.2) is:
--
--   SELECT j.id, j.slug, t.title, j.location, j.employment_type,
--          j.level, j.published_at, j.application_deadline
--   FROM   job_postings j
--   JOIN   job_posting_translations t
--          ON t.job_id = j.id AND t.locale = ?
--   WHERE  j.status = 'Published'
--     AND  (j.application_deadline IS NULL
--           OR j.application_deadline >= CURDATE())
--     AND  (? = '' OR MATCH(j.search_text) AGAINST (? IN BOOLEAN MODE))
--     AND  (j.location IN (...))
--     AND  (j.level = ?)
--   ORDER BY j.published_at DESC
--   LIMIT 20 OFFSET ?;
--
-- The existing `idx_job_status_pub (status, published_at)` in 0003_jobs.sql
-- already covers the `WHERE status='Published' ORDER BY published_at DESC`
-- path, but MySQL must still visit the clustered index row to fetch
-- `slug, location, employment_type, level, application_deadline`.
--
-- Adding a covering index that includes those columns lets the engine
-- satisfy the entire WHERE + ORDER BY + SELECT projection from the index
-- alone (index-only scan), eliminating the row-lookup step.
--
-- Index: idx_jp_status_pub_covering
--   Columns: (status, published_at DESC, application_deadline,
--              id, slug, location, employment_type, level)
--   - Leading (status, published_at DESC) matches the existing predicate
--     and sort order.
--   - application_deadline is included so the deadline filter
--     `(application_deadline IS NULL OR application_deadline >= CURDATE())`
--     is evaluated inside the index.
--   - id, slug, location, employment_type, level are payload columns
--     that make the index covering for the SELECT list.
--
-- Note: MySQL/InnoDB does not support DESC in index definitions before
-- MySQL 8.0. The hosting stack targets MySQL 8.0+ (cPanel HyperCloudHost
-- ships MariaDB 10.6+ or MySQL 8.0+). If the server is MariaDB < 10.8,
-- the DESC hint is silently ignored and the index is still used (just
-- with a slightly less optimal sort direction). The query planner will
-- still use the index for the equality predicate on `status`.
--
-- Index: idx_jp_deadline_status
--   Covers the "expired jobs" sweep used by the search-visibility
--   predicate (Property 5, Req 9.4):
--     WHERE application_deadline < CURDATE() AND status = 'Published'
--   This is a secondary access path; the primary covering index above
--   already handles the main listing query.
--
-- Index: idx_jpt_job_locale
--   The JOIN `job_posting_translations ON job_id = ? AND locale = ?`
--   is already covered by the composite PK (job_id, locale), so no
--   additional index is needed on that table.

-- -----------------------------------------------------------------------------
-- Covering index for the public job listing query (§10.2)
-- -----------------------------------------------------------------------------
ALTER TABLE job_postings
  ADD INDEX idx_jp_status_pub_covering (
    status,
    published_at DESC,
    application_deadline,
    id,
    slug(120),
    location(150),
    employment_type,
    level
  );

-- -----------------------------------------------------------------------------
-- Secondary index for the deadline-based expiry sweep (Req 9.4, Property 5)
-- -----------------------------------------------------------------------------
ALTER TABLE job_postings
  ADD INDEX idx_jp_deadline_status (
    application_deadline,
    status
  );
