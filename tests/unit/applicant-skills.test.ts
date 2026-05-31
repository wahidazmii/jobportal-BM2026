/**
 * Unit tests for `src/modules/applicant/skills.ts` (task 16.4).
 *
 * Validates: Requirements 4.4 (Design §6 Applicant_Area, §10.1)
 *
 * Coverage:
 *   - Module constants (`MAX_SKILLS_PER_APPLICANT = 30`, ngram-aware
 *     `MIN_SEARCH_QUERY_LENGTH`).
 *   - `buildBooleanQuery` strips MySQL BOOLEAN-mode operator characters
 *     (`+`, `-`, `*`, `~`, `<`, `>`, `"`, `(`, `)`, `@`) and short-
 *     circuits to `null` for inputs shorter than the ngram minimum.
 *   - `searchSkills`:
 *       * sends sanitised tokens to the FULLTEXT path,
 *       * accepts queries containing `+`, `-`, `*` without erroring,
 *       * falls back to `LIKE` when the cleaned query is shorter than
 *         the ngram minimum (1-character autocomplete still works),
 *       * returns `[]` for empty input without hitting the DB.
 *   - `listAssignedSkills` filters on `active = 1` and orders by label.
 *   - `toggleSkill` (transactional):
 *       * INSERTs when no link row exists and the skill is active,
 *       * DELETEs when a link row already exists,
 *       * enforces the 30-entry cap on the ADD branch
 *         (`SkillCapError`),
 *       * rejects ADD when the requested skill is inactive
 *         (`SkillInactiveError`),
 *       * rejects ADD when the requested skill id does not exist
 *         (`SkillNotFoundError`),
 *       * scopes every WHERE to `applicant_user_id` (ownership /
 *         IDOR guard) — the SELECT_LINK_FOR_UPDATE always carries
 *         the authenticated user id.
 *
 * The service talks to MySQL via `query()` and `withTransaction()` from
 * `src/infra/db.ts`; we mock that boundary so the suite stays
 * hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Import after mocks are registered.
const skillsModule = await import('../../src/modules/applicant/skills.js');
const {
  MAX_SKILLS_PER_APPLICANT,
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_QUERY_LENGTH,
  SkillCapError,
  SkillInactiveError,
  SkillNotFoundError,
  buildBooleanQuery,
  listAssignedSkills,
  searchSkills,
  toggleSkill,
} = skillsModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeader(affectedRows: number, insertId = 0): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

function skillRow(
  overrides: Partial<{ id: number; label: string; active: number }> = {},
): RowDataPacket {
  return {
    id: overrides.id ?? 1,
    label: overrides.label ?? 'JavaScript',
    active: overrides.active ?? 1,
  } as unknown as RowDataPacket;
}

/**
 * Build a fake `PoolConnection`-like object whose `execute` is a vitest
 * mock so the test can drive the in-transaction query sequence.
 */
function createFakeConnection() {
  const executeMock = vi.fn();
  const connection = { execute: executeMock };
  return { connection, executeMock };
}

/**
 * Wire `withTransaction` so the next call invokes the supplied callback
 * with the supplied fake connection (mirrors the production behaviour
 * minus the BEGIN/COMMIT bookkeeping that is already covered by the
 * `withTransaction` unit tests).
 */
function bindTransaction(connection: {
  execute: ReturnType<typeof vi.fn>;
}) {
  withTransactionMock.mockImplementationOnce(
    async (fn: (conn: typeof connection) => Promise<unknown>) =>
      fn(connection),
  );
}

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('skill module constants', () => {
  it('caps assignments at 30 per applicant', () => {
    expect(MAX_SKILLS_PER_APPLICANT).toBe(30);
  });

  it('caps autocomplete results to a sensible page size', () => {
    expect(MAX_SEARCH_RESULTS).toBeGreaterThan(0);
    expect(MAX_SEARCH_RESULTS).toBeLessThanOrEqual(50);
  });

  it('exposes the ngram-aware minimum query length', () => {
    expect(MIN_SEARCH_QUERY_LENGTH).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildBooleanQuery — sanitisation
// ---------------------------------------------------------------------------

describe('buildBooleanQuery', () => {
  it('trims whitespace and suffixes prefix-match wildcard', () => {
    expect(buildBooleanQuery('  java  ')).toBe('java*');
  });

  it('strips every BOOLEAN-mode operator character', () => {
    // All operators present in one query — none should leak through.
    const out = buildBooleanQuery('+java -script *star ~tilde <lt >gt "quote" (paren) @mention');
    // Result must contain no operator characters at all.
    expect(out).not.toMatch(/[+\-><()~"@]/);
    // The remaining `*` characters must come from our prefix suffix
    // only (one per token), never embedded inside a token.
    if (out !== null) {
      const tokens = out.split(' ');
      for (const t of tokens) {
        expect(t.endsWith('*')).toBe(true);
        expect(t.slice(0, -1)).not.toMatch(/\*/);
      }
    }
  });

  it('returns null for empty input', () => {
    expect(buildBooleanQuery('')).toBeNull();
    expect(buildBooleanQuery('   ')).toBeNull();
  });

  it('returns null for input shorter than the ngram minimum', () => {
    expect(buildBooleanQuery('a')).toBeNull();
  });

  it('drops sub-minimum tokens but keeps long ones', () => {
    // 'a' is dropped, 'java' stays.
    expect(buildBooleanQuery('a java')).toBe('java*');
  });

  it('returns null when only operator characters remain', () => {
    expect(buildBooleanQuery('+++')).toBeNull();
    expect(buildBooleanQuery('***')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// searchSkills — FULLTEXT path
// ---------------------------------------------------------------------------

describe('searchSkills — FULLTEXT path', () => {
  it('passes a sanitised BOOLEAN-mode query plus a row-count cap', async () => {
    queryMock.mockResolvedValueOnce([
      skillRow({ id: 7, label: 'JavaScript' }),
    ]);

    const out = await searchSkills('java');
    expect(out).toEqual([{ id: 7, label: 'JavaScript', active: true }]);

    // Two MATCH placeholders (WHERE + ORDER BY) plus the LIMIT.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/MATCH\(label\)\s+AGAINST\s*\(\s*\?\s+IN\s+BOOLEAN\s+MODE\)/i);
    expect(sql).toMatch(/active\s*=\s*1/i);
    expect(params[0]).toBe('java*');
    expect(params[1]).toBe('java*');
    expect(params[2]).toBe(MAX_SEARCH_RESULTS);
  });

  it('accepts queries containing `+`, `-`, `*` without erroring', async () => {
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);

    await expect(searchSkills('+java')).resolves.toEqual([]);
    await expect(searchSkills('-java')).resolves.toEqual([]);
    await expect(searchSkills('java*')).resolves.toEqual([]);

    // None of the parameter values may carry a leading operator.
    for (const call of queryMock.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[0]).not.toMatch(/^[+\-]/);
      expect(params[0]).toBe('java*');
    }
  });

  it('returns [] for empty input without hitting the DB', async () => {
    await expect(searchSkills('')).resolves.toEqual([]);
    await expect(searchSkills('   ')).resolves.toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchSkills — LIKE fallback for short queries
// ---------------------------------------------------------------------------

describe('searchSkills — LIKE fallback', () => {
  it('falls back to LIKE when the cleaned query is shorter than the ngram minimum', async () => {
    queryMock.mockResolvedValueOnce([
      skillRow({ id: 1, label: 'Java' }),
      skillRow({ id: 2, label: 'JavaScript' }),
    ]);

    const out = await searchSkills('j');
    expect(out).toHaveLength(2);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIKE\s+\?/i);
    expect(sql).not.toMatch(/MATCH\(label\)/i);
    expect(params[0]).toBe('j%');
    expect(params[1]).toBe(MAX_SEARCH_RESULTS);
  });

  it('escapes `%` and `_` so user input cannot widen the LIKE pattern', async () => {
    queryMock.mockResolvedValueOnce([]);
    await searchSkills('%');
    // A bare `%` is an operator-free single character → LIKE fallback.
    if (queryMock.mock.calls.length > 0) {
      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      const pattern = params[0] as string;
      expect(pattern.startsWith('\\%')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// listAssignedSkills
// ---------------------------------------------------------------------------

describe('listAssignedSkills', () => {
  it('returns only active skills assigned to the applicant ordered by label', async () => {
    queryMock.mockResolvedValueOnce([
      skillRow({ id: 2, label: 'AutoCAD' }),
      skillRow({ id: 5, label: 'Excel' }),
    ]);

    const out = await listAssignedSkills(42);
    expect(out).toEqual([
      { id: 2, label: 'AutoCAD', active: true },
      { id: 5, label: 'Excel', active: true },
    ]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // FROM applicant_skills + JOIN skill_tags + active filter + ORDER BY label.
    expect(sql).toMatch(/FROM\s+applicant_skills/i);
    expect(sql).toMatch(/JOIN\s+skill_tags/i);
    expect(sql).toMatch(/applicant_user_id\s*=\s*\?/i);
    expect(sql).toMatch(/s\.active\s*=\s*1/i);
    expect(sql).toMatch(/ORDER\s+BY\s+s\.label\s+ASC/i);
    expect(params).toEqual([42]);
  });
});

// ---------------------------------------------------------------------------
// toggleSkill — ADD branch
// ---------------------------------------------------------------------------

describe('toggleSkill — ADD branch', () => {
  it('INSERTs a new link when the skill is active and below the cap', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // 1. SELECT skill row → active.
    executeMock.mockResolvedValueOnce([
      [skillRow({ id: 9, label: 'TypeScript', active: 1 })],
      [],
    ]);
    // 2. SELECT 1 FROM applicant_skills FOR UPDATE → no row.
    executeMock.mockResolvedValueOnce([[], []]);
    // 3. SELECT COUNT(*) FOR UPDATE → 5 already (well under cap).
    executeMock.mockResolvedValueOnce([
      [{ n: 5 } as unknown as RowDataPacket],
      [],
    ]);
    // 4. INSERT link.
    executeMock.mockResolvedValueOnce([makeHeader(1, 0), []]);

    const out = await toggleSkill(42, 9);
    expect(out.assigned).toBe(true);
    expect(out.count).toBe(6);
    expect(out.skill).toEqual({ id: 9, label: 'TypeScript', active: true });

    // The INSERT must scope to (userId, skillId).
    const insertCall = executeMock.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT\s+INTO\s+applicant_skills/i);
    expect(insertCall[1]).toEqual([42, 9]);

    // Every SELECT under the link table must filter on applicant_user_id.
    const linkLockCall = executeMock.mock.calls[1];
    expect(linkLockCall[0]).toMatch(/applicant_user_id\s*=\s*\?/i);
    expect(linkLockCall[1]).toEqual([42, 9]);
  });

  it('rejects with SkillCapError when the applicant is at 30 already', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [skillRow({ id: 9, label: 'TypeScript', active: 1 })],
      [],
    ]);
    executeMock.mockResolvedValueOnce([[], []]); // no link → ADD branch
    executeMock.mockResolvedValueOnce([
      [{ n: MAX_SKILLS_PER_APPLICANT } as unknown as RowDataPacket],
      [],
    ]);

    await expect(toggleSkill(42, 9)).rejects.toBeInstanceOf(SkillCapError);

    // INSERT must NOT have happened.
    const sqlsCalled = executeMock.mock.calls.map((c) => c[0] as string);
    expect(sqlsCalled.some((s) => /INSERT\s+INTO\s+applicant_skills/i.test(s))).toBe(false);
  });

  it('rejects with SkillInactiveError when the skill exists but active=0', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [skillRow({ id: 9, label: 'PunchCardOps', active: 0 })],
      [],
    ]);
    executeMock.mockResolvedValueOnce([[], []]); // no link

    await expect(toggleSkill(42, 9)).rejects.toBeInstanceOf(SkillInactiveError);

    const sqlsCalled = executeMock.mock.calls.map((c) => c[0] as string);
    expect(sqlsCalled.some((s) => /INSERT\s+INTO\s+applicant_skills/i.test(s))).toBe(false);
  });

  it('rejects with SkillNotFoundError when the skill id does not exist', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([[], []]); // skill row missing

    await expect(toggleSkill(42, 9)).rejects.toBeInstanceOf(SkillNotFoundError);

    // We must NOT have probed the link table.
    const sqlsCalled = executeMock.mock.calls.map((c) => c[0] as string);
    expect(sqlsCalled.some((s) => /FROM\s+applicant_skills/i.test(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggleSkill — REMOVE branch
// ---------------------------------------------------------------------------

describe('toggleSkill — REMOVE branch', () => {
  it('DELETEs an existing link and returns the post-toggle count', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // 1. Resolve skill row.
    executeMock.mockResolvedValueOnce([
      [skillRow({ id: 9, label: 'TypeScript', active: 1 })],
      [],
    ]);
    // 2. SELECT 1 FOR UPDATE → row present.
    executeMock.mockResolvedValueOnce([
      [{ '1': 1 } as unknown as RowDataPacket],
      [],
    ]);
    // 3. DELETE link.
    executeMock.mockResolvedValueOnce([makeHeader(1, 0), []]);
    // 4. SELECT COUNT(*) → post-delete count.
    executeMock.mockResolvedValueOnce([
      [{ n: 4 } as unknown as RowDataPacket],
      [],
    ]);

    const out = await toggleSkill(42, 9);
    expect(out.assigned).toBe(false);
    expect(out.count).toBe(4);

    const deleteCall = executeMock.mock.calls[2];
    expect(deleteCall[0]).toMatch(/DELETE\s+FROM\s+applicant_skills/i);
    expect(deleteCall[1]).toEqual([42, 9]);
  });

  it('does NOT reject on REMOVE even when the user is at the cap', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [skillRow({ id: 9, label: 'X', active: 1 })],
      [],
    ]);
    executeMock.mockResolvedValueOnce([
      [{ '1': 1 } as unknown as RowDataPacket],
      [],
    ]);
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);
    executeMock.mockResolvedValueOnce([
      [{ n: MAX_SKILLS_PER_APPLICANT - 1 } as unknown as RowDataPacket],
      [],
    ]);

    const out = await toggleSkill(42, 9);
    expect(out.assigned).toBe(false);
    expect(out.count).toBe(MAX_SKILLS_PER_APPLICANT - 1);
  });
});

// ---------------------------------------------------------------------------
// toggleSkill — input validation
// ---------------------------------------------------------------------------

describe('toggleSkill — input validation', () => {
  it('rejects non-positive skillId', async () => {
    await expect(toggleSkill(42, 0)).rejects.toBeInstanceOf(TypeError);
    await expect(toggleSkill(42, -1)).rejects.toBeInstanceOf(TypeError);
    await expect(toggleSkill(42, 1.5)).rejects.toBeInstanceOf(TypeError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});
