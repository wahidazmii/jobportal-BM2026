/**
 * Applicant skill-tag service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 16.4
 * Design  : §6 Applicant_Area, §10.1 (FULLTEXT search)
 * Validates: Requirements 4.4
 *
 * Public surface:
 *   - `MAX_SKILLS_PER_APPLICANT = 30` — per-applicant cap from task 16.4.
 *   - `MAX_SEARCH_RESULTS = 20`       — autocomplete page size cap.
 *   - `SkillTag`                      — typed `skill_tags` row returned by
 *                                       the read helpers.
 *   - `SkillCapError`                 — thrown by `toggleSkill` when an
 *                                       ADD would push the assigned count
 *                                       past 30. The route layer maps
 *                                       this to HTTP 422.
 *   - `SkillInactiveError`            — thrown by `toggleSkill` when the
 *                                       requested skill exists but its
 *                                       `active` flag is 0. HR retires
 *                                       skills via the flag rather than
 *                                       DELETE (see migration 0002 notes),
 *                                       so we surface this as a distinct
 *                                       error rather than a silent no-op.
 *   - `SkillNotFoundError`            — thrown by `toggleSkill` when the
 *                                       requested skill id does not exist
 *                                       in `skill_tags`.
 *   - `listAssignedSkills(userId)`    — return every active skill assigned
 *                                       to the applicant, ordered by
 *                                       label ASC.
 *   - `searchSkills(query)`           — autocomplete via the FULLTEXT
 *                                       `ft_skill_label` index (BOOLEAN
 *                                       MODE, ngram parser). Returns up
 *                                       to `MAX_SEARCH_RESULTS` active
 *                                       skills ordered by relevance.
 *   - `toggleSkill(userId, skillId)`  — toggle the M:N assignment between
 *                                       the applicant and a skill.
 *                                       Returns `{ assigned: boolean }`
 *                                       describing the post-toggle state.
 *
 * Concurrency / cap enforcement:
 *   - Toggle wraps the SELECT + INSERT/DELETE in a single transaction.
 *     The "is this user already assigned to this skill?" probe holds
 *     the link row (or its absence range) under MySQL row locking, and
 *     the cap check `SELECT COUNT(*) FOR UPDATE` locks the per-applicant
 *     bucket. Two concurrent ADDs from the same user therefore
 *     serialise: the second one sees the freshly inserted row, finds
 *     the assignment already present, and either no-ops (idempotent
 *     ADD) or correctly rejects when the count crossed the cap.
 *   - Skill catalog rows are NOT locked beyond the existence check —
 *     HR's `active` flip races (a skill toggled inactive between the
 *     FULLTEXT search and the user's click) are accepted: we surface
 *     `SkillInactiveError` to the user.
 *
 * FULLTEXT sanitisation:
 *   - `searchSkills` accepts a free-text query from the autocomplete UI.
 *     Before handing it to MySQL we strip the BOOLEAN-mode operator
 *     characters (`+ - > < ( ) ~ * " @`) so a malicious or accidental
 *     `*` does not match every row. We then suffix `*` to the cleaned
 *     query (prefix expansion) so partial-word typing still matches —
 *     a 2-grams query like `ja` resolves to `ja*` and finds "JavaScript".
 *   - The `ngram` parser uses `ngram_token_size=2` by default, so any
 *     single-character query is dropped (returns no results) — we
 *     short-circuit and return `[]` in that case to avoid burning a DB
 *     round-trip on a guaranteed-empty result.
 */

import { z } from 'zod';

import {
  query,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum skill tags per applicant per task 16.4. */
export const MAX_SKILLS_PER_APPLICANT = 30;

/** Page size cap for autocomplete results. */
export const MAX_SEARCH_RESULTS = 20;

/**
 * Default minimum query length, matching MySQL's `ngram_token_size=2`.
 * Queries shorter than this are treated as "no input" — the FULLTEXT
 * index would return no rows anyway, and short-circuiting saves a DB
 * round trip on every keystroke before the user types the second
 * character.
 */
export const MIN_SEARCH_QUERY_LENGTH = 2;

/**
 * BOOLEAN-mode operator characters we strip from user input before
 * handing the query to `MATCH ... AGAINST (? IN BOOLEAN MODE)`. The
 * `*` is intentionally NOT replaced when it appears at the END of a
 * word (we add our own `*` suffix to enable prefix matching), but the
 * sanitiser strips ALL `*` first and the prefix is then re-applied
 * cleanly to the cleaned token.
 */
const BOOLEAN_MODE_OPERATORS_REGEX = /[+\-><()~*"@]/g;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `toggleSkill` when an ADD would push the assigned count
 * past the per-applicant cap. The route layer maps this to HTTP 422.
 */
export class SkillCapError extends Error {
  readonly code = 'skill_cap_reached' as const;
  constructor(public readonly limit: number) {
    super(
      `Skill cap reached (${limit}). ` +
        `Remove an existing skill before adding a new one.`,
    );
    this.name = 'SkillCapError';
  }
}

/**
 * Thrown by `toggleSkill` when the requested skill exists but is
 * marked inactive (`skill_tags.active = 0`). HR retires skills via the
 * flag rather than DELETE, so this signals a benign race rather than
 * a missing row.
 */
export class SkillInactiveError extends Error {
  readonly code = 'skill_inactive' as const;
  constructor(public readonly skillId: number) {
    super(`Skill ${skillId} is no longer active`);
    this.name = 'SkillInactiveError';
  }
}

/**
 * Thrown by `toggleSkill` when the requested `skillId` does not exist
 * in `skill_tags` at all.
 */
export class SkillNotFoundError extends Error {
  readonly code = 'skill_not_found' as const;
  constructor(public readonly skillId: number) {
    super(`Skill ${skillId} not found`);
    this.name = 'SkillNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Coerce a query-string parameter into a positive integer skill id.
 * The route layer uses this to validate the `skill_id` form field
 * before passing it to `toggleSkill`. Throws `ZodError` on failure.
 */
export const skillIdSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx): number => {
    const n = typeof v === 'string' ? Number(v.trim()) : v;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'skill_id must be a positive integer',
      });
      return 0;
    }
    return n;
  });

// ---------------------------------------------------------------------------
// Repository types
// ---------------------------------------------------------------------------

export interface SkillTag {
  readonly id: number;
  readonly label: string;
  readonly active: boolean;
}

interface SkillTagRow extends RowDataPacket {
  id: number | string;
  label: string;
  active: number;
}

function rowToSkillTag(row: SkillTagRow): SkillTag {
  return {
    id: Number(row.id),
    label: row.label,
    active: row.active === 1,
  };
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

/**
 * List the skills currently assigned to the applicant. Joins
 * `applicant_skills` against `skill_tags` so we can both filter on
 * `active=1` (HR may retire a tag the user previously picked — we hide
 * those from the editor without auto-deleting their assignment) and
 * sort by `label`.
 */
const SELECT_ASSIGNED_SKILLS_SQL =
  'SELECT s.id, s.label, s.active ' +
  'FROM applicant_skills aps ' +
  'JOIN skill_tags s ON s.id = aps.skill_id ' +
  'WHERE aps.applicant_user_id = ? AND s.active = 1 ' +
  'ORDER BY s.label ASC';

/**
 * FULLTEXT autocomplete. The MATCH expression appears twice: once in
 * the WHERE clause (to satisfy the index lookup) and once in the
 * ORDER BY (so MySQL's relevance score drives the row order). The
 * second `MATCH` reuses the same parser internals as the first because
 * they share an identical expression.
 */
const SEARCH_SKILLS_SQL =
  'SELECT id, label, active ' +
  'FROM skill_tags ' +
  'WHERE active = 1 AND MATCH(label) AGAINST (? IN BOOLEAN MODE) ' +
  'ORDER BY MATCH(label) AGAINST (? IN BOOLEAN MODE) DESC, label ASC ' +
  'LIMIT ?';

/**
 * LIKE-based fallback used for inputs that are shorter than the ngram
 * minimum token size. The FULLTEXT index cannot match a single
 * character with the default `ngram_token_size=2`, so the autocomplete
 * would otherwise return nothing as soon as the user typed the first
 * letter. Falling back to a `LIKE 'x%'` lookup keeps the results
 * arriving on every keystroke. The leading-character match is anchored
 * (`label LIKE ?`) and the row count capped to keep the scan cheap.
 */
const SEARCH_SKILLS_LIKE_SQL =
  'SELECT id, label, active ' +
  'FROM skill_tags ' +
  'WHERE active = 1 AND label LIKE ? ' +
  'ORDER BY label ASC ' +
  'LIMIT ?';

/**
 * Fetch a single skill catalog row. Used inside `toggleSkill` to
 * resolve "exists?" + "active?" before mutating the link table.
 */
const SELECT_SKILL_BY_ID_SQL =
  'SELECT id, label, active FROM skill_tags WHERE id = ? LIMIT 1';

const SELECT_LINK_FOR_UPDATE_SQL =
  'SELECT 1 FROM applicant_skills ' +
  'WHERE applicant_user_id = ? AND skill_id = ? FOR UPDATE';

const COUNT_LINKS_FOR_UPDATE_SQL =
  'SELECT COUNT(*) AS n FROM applicant_skills ' +
  'WHERE applicant_user_id = ? FOR UPDATE';

const INSERT_LINK_SQL =
  'INSERT INTO applicant_skills (applicant_user_id, skill_id) VALUES (?, ?)';

const DELETE_LINK_SQL =
  'DELETE FROM applicant_skills ' +
  'WHERE applicant_user_id = ? AND skill_id = ?';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return every active skill currently assigned to the applicant,
 * ordered by `label ASC`. Inactive (HR-retired) skills the user may
 * have previously picked are filtered out — the editor renders the
 * authoritative live set.
 */
export async function listAssignedSkills(userId: number): Promise<SkillTag[]> {
  const rows = await query<SkillTagRow[]>(SELECT_ASSIGNED_SKILLS_SQL, [
    userId,
  ]);
  return rows.map(rowToSkillTag);
}

/**
 * Build a BOOLEAN-mode FULLTEXT query string from raw user input.
 *
 * Steps:
 *   1. Trim and drop control whitespace.
 *   2. Strip every BOOLEAN-mode operator character so the user cannot
 *      smuggle in a wildcard or negation that breaks the search.
 *   3. Collapse runs of whitespace to a single space so the resulting
 *      query has well-defined tokens.
 *   4. Suffix each token with `*` to enable prefix matching — `ja`
 *      becomes `ja*`, which finds "Java", "JavaScript", and so on.
 *      The ngram parser indexes 2-character tokens, so the `*` only
 *      kicks in for queries that exceed `ngram_token_size`.
 *
 * Returns `null` if the cleaned query has no usable tokens (empty or
 * shorter than `MIN_SEARCH_QUERY_LENGTH` after stripping).
 */
export function buildBooleanQuery(raw: string): string | null {
  const stripped = raw
    .replace(BOOLEAN_MODE_OPERATORS_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped.length < MIN_SEARCH_QUERY_LENGTH) return null;

  const tokens = stripped
    .split(' ')
    .filter((token) => token.length >= MIN_SEARCH_QUERY_LENGTH)
    .map((token) => `${token}*`);

  if (tokens.length === 0) return null;

  return tokens.join(' ');
}

/**
 * Escape a string for use in a MySQL `LIKE` pattern. Backslash, `%`,
 * and `_` are the three wildcard / escape characters that need
 * neutralising so user input cannot inject "match every row" patterns
 * into the LIKE-fallback query path.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Search the active `skill_tags` catalog by label.
 *
 * Two query paths share the same return shape:
 *   - **FULLTEXT (preferred)**: when the cleaned query has at least
 *     `MIN_SEARCH_QUERY_LENGTH` characters, the input is sanitised by
 *     `buildBooleanQuery` and matched via the `ft_skill_label`
 *     BOOLEAN-mode index. Results are ordered by MySQL's relevance
 *     score with `label ASC` as a tiebreaker.
 *   - **LIKE fallback**: when the cleaned query is shorter than the
 *     ngram token size (e.g. a single typed character), the FULLTEXT
 *     index cannot match anything, so we fall back to
 *     `label LIKE 'x%'` ordered alphabetically. This keeps the
 *     autocomplete responsive on the first keystroke while still
 *     respecting `active=1` and capping the row count.
 *
 * Returns `[]` only for genuinely empty input. The function never
 * throws on operator characters in the user input — they are stripped
 * before reaching MySQL.
 */
export async function searchSkills(rawQuery: string): Promise<SkillTag[]> {
  const trimmed = (rawQuery ?? '').trim();
  if (trimmed.length === 0) return [];

  const booleanQuery = buildBooleanQuery(trimmed);
  if (booleanQuery !== null) {
    const rows = await query<SkillTagRow[]>(SEARCH_SKILLS_SQL, [
      booleanQuery,
      booleanQuery,
      MAX_SEARCH_RESULTS,
    ]);
    return rows.map(rowToSkillTag);
  }

  // LIKE-fallback path: a single character (or a string that boiled
  // down to a single token under the ngram minimum). Anchor the match
  // to the label start and escape MySQL LIKE wildcards so user input
  // cannot widen the pattern.
  const stripped = trimmed.replace(BOOLEAN_MODE_OPERATORS_REGEX, '').trim();
  if (stripped.length === 0) return [];

  const likePattern = `${escapeLikePattern(stripped)}%`;
  const rows = await query<SkillTagRow[]>(SEARCH_SKILLS_LIKE_SQL, [
    likePattern,
    MAX_SEARCH_RESULTS,
  ]);
  return rows.map(rowToSkillTag);
}

/**
 * Result of a successful `toggleSkill` call.
 *
 * - `assigned=true` means the skill is now associated with the
 *   applicant (an INSERT happened, OR an idempotent re-add returned the
 *   pre-existing row).
 * - `assigned=false` means the skill is no longer associated with the
 *   applicant (a DELETE happened).
 * - `count` is the post-toggle assignment count for the applicant, so
 *   the route layer can render the "X / 30" counter without a
 *   follow-up query.
 */
export interface ToggleResult {
  readonly assigned: boolean;
  readonly count: number;
  readonly skill: SkillTag;
}

/**
 * Toggle the M:N assignment between `userId` and `skillId`.
 *
 * Behaviour:
 *   - If a row already exists in `applicant_skills`, DELETE it.
 *     Returns `{ assigned: false }`.
 *   - If no row exists:
 *       - Resolve the skill: missing → `SkillNotFoundError`; inactive
 *         → `SkillInactiveError`.
 *       - Lock the per-applicant assignment count; if it is already
 *         at the cap → `SkillCapError`.
 *       - INSERT the link. Returns `{ assigned: true }`.
 *
 * The whole flow runs in a single transaction so a concurrent toggle
 * from the same user (e.g. a double-click on the autocomplete chip)
 * cannot leave both rows present or both absent in different
 * connections — the row-level locks serialise the branches.
 *
 * Throws:
 *   - `SkillNotFoundError` when `skillId` does not exist.
 *   - `SkillInactiveError` when the skill exists but `active=0`.
 *   - `SkillCapError` when adding would cross
 *     `MAX_SKILLS_PER_APPLICANT`.
 */
export async function toggleSkill(
  userId: number,
  skillId: number,
): Promise<ToggleResult> {
  if (!Number.isInteger(skillId) || skillId <= 0) {
    throw new TypeError('skillId must be a positive integer');
  }

  return withTransaction(async (conn: PoolConnection) => {
    // Resolve the skill catalog row first so we can fail fast on
    // missing/inactive without holding any link-table locks.
    const [skillRows] = await conn.execute<SkillTagRow[]>(
      SELECT_SKILL_BY_ID_SQL,
      [skillId],
    );
    const skillRow = skillRows[0];
    if (!skillRow) {
      throw new SkillNotFoundError(skillId);
    }
    const skill = rowToSkillTag(skillRow);

    // Lock the link row (or its absence) for this (user, skill) pair.
    const [linkRows] = await conn.execute<RowDataPacket[]>(
      SELECT_LINK_FOR_UPDATE_SQL,
      [userId, skillId],
    );
    const isAssigned = linkRows.length > 0;

    if (isAssigned) {
      // REMOVE branch — the cap is irrelevant.
      await conn.execute<ResultSetHeader>(DELETE_LINK_SQL, [userId, skillId]);

      const [postRows] = await conn.execute<RowDataPacket[]>(
        COUNT_LINKS_FOR_UPDATE_SQL,
        [userId],
      );
      const count = Number(
        (postRows[0] as { n?: number | string } | undefined)?.n ?? 0,
      );

      logger.info(
        { event: 'skill_remove', user_id: userId, skill_id: skillId, count },
        'applicant.skills: assignment removed',
      );

      return { assigned: false, count, skill };
    }

    // ADD branch — only allowed when the skill is active.
    if (!skill.active) {
      throw new SkillInactiveError(skillId);
    }

    // Lock the per-applicant assignment count to enforce the cap.
    const [countRows] = await conn.execute<RowDataPacket[]>(
      COUNT_LINKS_FOR_UPDATE_SQL,
      [userId],
    );
    const current = Number(
      (countRows[0] as { n?: number | string } | undefined)?.n ?? 0,
    );
    if (current >= MAX_SKILLS_PER_APPLICANT) {
      throw new SkillCapError(MAX_SKILLS_PER_APPLICANT);
    }

    await conn.execute<ResultSetHeader>(INSERT_LINK_SQL, [userId, skillId]);

    logger.info(
      {
        event: 'skill_add',
        user_id: userId,
        skill_id: skillId,
        count: current + 1,
      },
      'applicant.skills: assignment added',
    );

    return { assigned: true, count: current + 1, skill };
  });
}
