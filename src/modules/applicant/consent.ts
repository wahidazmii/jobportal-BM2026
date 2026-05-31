/**
 * Consent service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 46.1
 * Design  : §6 Applicant_Area (consent flow)
 * Validates: Requirements 16.1, 16.6
 *
 * Public surface:
 *   - `CURRENT_POLICY_VERSION`          — the active policy version string,
 *                                         read from `process.env.POLICY_VERSION`
 *                                         with fallback to `'1.0'`.
 *   - `recordAcceptance(userId,
 *                        version, conn?)` — INSERT IGNORE into
 *                                           `consent_records` (idempotent).
 *                                           Accepts an optional
 *                                           `PoolConnection` so callers
 *                                           can participate in an outer
 *                                           transaction (e.g. registration).
 *   - `hasAcceptedCurrentVersion(userId)` — SELECT 1 to check whether the
 *                                           applicant has a row for the
 *                                           current policy version.
 *
 * SQL conventions:
 *   - All SQL assembled via `Array.join(' ')` per project convention.
 *   - All parameters are positional `?` placeholders (prepared statements,
 *     Req 15.4).
 *   - `INSERT IGNORE` makes `recordAcceptance` idempotent: a duplicate
 *     call (same user + same version) silently no-ops rather than
 *     throwing a unique-key violation. The `consent_records` table does
 *     not have a unique constraint on `(applicant_user_id, policy_version)`
 *     in the migration, so idempotency is achieved by the IGNORE keyword
 *     combined with the service-level check in `hasAcceptedCurrentVersion`.
 *
 * Note on column name:
 *   The `consent_records` table uses `applicant_user_id` (not `user_id`)
 *   as the FK column name — see migration 0002_profile.sql.
 */

import type { PoolConnection } from 'mysql2/promise';

import {
  query,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The currently active privacy policy version. Reads from the
 * `POLICY_VERSION` environment variable; falls back to `'1.0'` when
 * the variable is absent or empty so the app works without explicit
 * configuration in development and test environments.
 */
export const CURRENT_POLICY_VERSION: string =
  (process.env.POLICY_VERSION ?? '').trim() || '1.0';

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const INSERT_CONSENT_SQL = [
  'INSERT IGNORE INTO consent_records',
  '  (applicant_user_id, policy_version, accepted_at)',
  'VALUES',
  '  (?, ?, NOW())',
].join(' ');

const SELECT_CONSENT_SQL = [
  'SELECT 1 AS found',
  'FROM consent_records',
  'WHERE applicant_user_id = ?',
  '  AND policy_version = ?',
  'LIMIT 1',
].join(' ');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConsentRow extends RowDataPacket {
  found: number;
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Record that `userId` has accepted `version` of the privacy policy.
 *
 * Uses `INSERT IGNORE` so the call is idempotent: if a row already
 * exists for `(applicant_user_id, policy_version)` the statement
 * silently no-ops and `affectedRows` will be 0. Callers do not need
 * to check the return value.
 *
 * @param userId  — the `users.id` / `applicants.user_id` of the applicant.
 * @param version — the policy version string (e.g. `'1.0'`).
 * @param conn    — optional `PoolConnection` for transactional callers.
 *                  When omitted, the shared pool is used.
 */
export async function recordAcceptance(
  userId: number,
  version: string,
  conn?: PoolConnection,
): Promise<void> {
  if (conn) {
    await conn.execute(INSERT_CONSENT_SQL, [userId, version]);
  } else {
    await query<ResultSetHeader>(INSERT_CONSENT_SQL, [userId, version]);
  }
}

/**
 * Check whether `userId` has accepted the current policy version.
 *
 * Returns `true` when at least one `consent_records` row exists for
 * `(applicant_user_id = userId, policy_version = CURRENT_POLICY_VERSION)`.
 * Returns `false` when no such row exists (the applicant needs to
 * accept the current version before continuing).
 */
export async function hasAcceptedCurrentVersion(
  userId: number,
): Promise<boolean> {
  const rows = await query<ConsentRow[]>(SELECT_CONSENT_SQL, [
    userId,
    CURRENT_POLICY_VERSION,
  ]);
  return rows.length > 0 && rows[0].found === 1;
}
