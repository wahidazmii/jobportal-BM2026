/**
 * Unit tests for `src/modules/jobs/search.ts` (task 22.1).
 *
 * Validates: Requirements 6.1, 6.2, 6.3 (Design §10.2, §10.3)
 *
 * Coverage:
 *   - `sanitizeKeyword`: preserves alphanumerics + spaces, strips
 *     MySQL BOOLEAN-mode operator characters, drops tokens shorter
 *     than `NGRAM_TOKEN_SIZE` (2), and returns `''` for empty /
 *     whitespace inputs. Also confirms an all-short input collapses
 *     to `''` so the SQL guard `(? = '' OR MATCH ...)` short-circuits.
 *   - `searchFilterSchema`: parses the public query string shape:
 *     accepts a CSV `location=A,B`, accepts the array form
 *     `location[]`, rejects unknown `employment_type` values with a
 *     ZodError.
 *   - `searchPublishedJobs`: orchestrates count + list + facet
 *     aggregations. The WHERE clause hard-codes `status='Published'`,
 *     the deadline-not-yet-passed predicate, and the boolean MATCH
 *     placeholder; user-supplied `IN (...)` filters thread through as
 *     bound parameters.
 *   - Pagination: `pageSize` defaults to 20; `page=15` with the default
 *     page size clamps `OFFSET` at `MAX_OFFSET` (200) per Design §10.2.
 *   - Facet caching (Design §10.3): a second call with an identical
 *     filter satisfies the facet aggregations from the in-memory
 *     `QuickLRU` and skips the four facet queries entirely;
 *     `clearSearchCache()` drops the cache so the next call hits the DB
 *     again.
 *   - Boolean-mode operator stripping: a hostile keyword like
 *     `"foo+ bar"` cannot reach MySQL with a literal `+` in the bound
 *     parameter — every operator character is removed before the
 *     query is parameterised.
 *
 * The service talks to MySQL through `query()` from `src/infra/db.ts`;
 * we mock that boundary so the suite is fully hermetic. Mocks return
 * shaped row objects and the test inspects the arguments passed by the
 * service to confirm SQL structure and parameter binding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Import after the mock is registered so the module picks up the double.
const search = await import('../../src/modules/jobs/search.js');
const {
  DEFAULT_PAGE_SIZE,
  MAX_OFFSET,
  clearSearchCache,
  sanitizeKeyword,
  searchFilterSchema,
  searchPublishedJobs,
} = search;

// ---------------------------------------------------------------------------
// Mock routing
// ---------------------------------------------------------------------------

/**
 * Default routing implementation for `query`. Each branch matches one
 * of the SQL shapes produced by `search.ts`:
 *   - `SELECT COUNT(*) AS n FROM job_postings` — count query
 *   - `SELECT id, slug, ...`                    — list query
 *   - `SELECT location AS value, ...`           — facet query
 *   - `SELECT department_id AS value, ...`      — facet query
 *   - `SELECT employment_type AS value, ...`    — facet query
 *   - `SELECT level AS value, ...`              — facet query
 *
 * Tests that need a tighter assertion override individual branches
 * via `queryMock.mockImplementationOnce`.
 */
function defaultQueryImpl(sql: string): unknown {
  if (/COUNT\(\*\) AS n FROM job_postings/i.test(sql)) {
    return [{ n: 0 }];
  }
  if (/^SELECT id, slug, location, employment_type/.test(sql)) {
    return [];
  }
  if (/^SELECT location AS value/.test(sql)) return [];
  if (/^SELECT department_id AS value/.test(sql)) return [];
  if (/^SELECT employment_type AS value/.test(sql)) return [];
  if (/^SELECT level AS value/.test(sql)) return [];
  return [];
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation((sql: string) => defaultQueryImpl(sql));
  // Always start each test with a clean facet cache so the cache-hit
  // / cache-miss assertions are deterministic across the file.
  clearSearchCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// sanitizeKeyword
// ---------------------------------------------------------------------------

describe('sanitizeKeyword', () => {
  it('returns empty string for empty / whitespace-only input', () => {
    expect(sanitizeKeyword('')).toBe('');
    expect(sanitizeKeyword('   ')).toBe('');
    expect(sanitizeKeyword('\t\n\r')).toBe('');
  });

  it('preserves alphanumerics across spaces, applies + (AND) prefix per token', () => {
    const out = sanitizeKeyword('data analyst');
    // The sanitiser AND-quotes each token. Both tokens must be present.
    expect(out).toContain('"data"');
    expect(out).toContain('"analyst"');
    // Every token is mandatory (`+`-prefixed).
    expect(out.startsWith('+')).toBe(true);
  });

  it('strips MySQL BOOLEAN-mode operator characters from the raw input', () => {
    // Each operator character below would otherwise be interpreted by
    // MySQL's BOOLEAN-mode parser — and a raw `+` next to junk bytes
    // can produce ER_PARSE_ERROR. The sanitiser must strip them all
    // from the user-supplied portion of the output.
    const operators = ['+', '-', '>', '<', '(', ')', '~', '*', '"', '@'];
    for (const op of operators) {
      const out = sanitizeKeyword(`foo${op}bar`);
      // The sanitiser DOES reintroduce its own `+"..."*` markers
      // (BOOLEAN-mode AND prefix + phrase quotes + optional prefix
      // expansion), so we cannot just assert "no operator char in
      // output". Instead, extract the quoted token BODIES — the
      // alphanumeric content between `"..."` — and assert those
      // never contain any operator character.
      const bodies = [...out.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        for (const stripped of operators) {
          expect(body).not.toContain(stripped);
        }
      }
    }
  });

  it('drops tokens shorter than NGRAM_TOKEN_SIZE (2 chars)', () => {
    // Single characters cannot match through the ngram parser — they
    // must be discarded entirely.
    expect(sanitizeKeyword('a b c')).toBe('');
    expect(sanitizeKeyword('a')).toBe('');
    // A two-char token survives without a trailing `*` (prefix
    // expansion is reserved for tokens of length ≥ 3).
    const twoChar = sanitizeKeyword('qa');
    expect(twoChar).toContain('"qa"');
    expect(twoChar.endsWith('*')).toBe(false);
  });

  it('appends prefix-expansion `*` only to tokens of length >= 3', () => {
    const out = sanitizeKeyword('qa data');
    // `qa` (2 chars) — no `*`.
    expect(out).toMatch(/\+"qa"(?!\*)/);
    // `data` (4 chars) — gets `*`.
    expect(out).toMatch(/\+"data"\*/);
  });

  it('returns empty string when every extracted token is shorter than NGRAM_TOKEN_SIZE', () => {
    expect(sanitizeKeyword('a b c d')).toBe('');
    expect(sanitizeKeyword('+ - * "')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// searchFilterSchema
// ---------------------------------------------------------------------------

describe('searchFilterSchema', () => {
  it('parses an empty query object to an all-undefined filter', () => {
    const parsed = searchFilterSchema.parse({});
    expect(parsed.keyword).toBeUndefined();
    expect(parsed.location).toBeUndefined();
    expect(parsed.department_id).toBeUndefined();
    expect(parsed.employment_type).toBeUndefined();
    expect(parsed.level).toBeUndefined();
    expect(parsed.page).toBeUndefined();
    expect(parsed.pageSize).toBeUndefined();
  });

  it('coerces a CSV string into a string array (location=Jakarta,Surabaya)', () => {
    const parsed = searchFilterSchema.parse({
      location: 'Jakarta, Surabaya',
    });
    expect(parsed.location).toEqual(['Jakarta', 'Surabaya']);
  });

  it('accepts the array form (location[]=Jakarta&location[]=Surabaya)', () => {
    const parsed = searchFilterSchema.parse({
      location: ['Jakarta', 'Surabaya'],
    });
    expect(parsed.location).toEqual(['Jakarta', 'Surabaya']);
  });

  it('parses department_id from CSV of integers', () => {
    const parsed = searchFilterSchema.parse({
      department_id: '3,7,11',
    });
    expect(parsed.department_id).toEqual([3, 7, 11]);
  });

  it('rejects an invalid employment_type value with a ZodError', () => {
    expect(() =>
      searchFilterSchema.parse({ employment_type: 'permanent' }),
    ).toThrow();
  });

  it('accepts every defined employment_type and level', () => {
    const parsed = searchFilterSchema.parse({
      employment_type: 'full-time,part-time,contract,internship',
      level: 'entry,junior,mid,senior,lead,manager,director',
    });
    expect(parsed.employment_type).toEqual([
      'full-time',
      'part-time',
      'contract',
      'internship',
    ]);
    expect(parsed.level).toEqual([
      'entry',
      'junior',
      'mid',
      'senior',
      'lead',
      'manager',
      'director',
    ]);
  });
});

// ---------------------------------------------------------------------------
// searchPublishedJobs — query orchestration
// ---------------------------------------------------------------------------

describe('searchPublishedJobs', () => {
  it('issues count + list + facet queries with the visibility predicate baked in', async () => {
    await searchPublishedJobs({
      keyword: 'data',
      location: ['Jakarta', 'Surabaya'],
      employment_type: ['full-time'],
      level: ['senior', 'lead'],
    });

    // Six queries: count, list, and the four facet aggregations.
    expect(queryMock).toHaveBeenCalledTimes(6);

    const sqls = queryMock.mock.calls.map((c) => c[0] as string);

    // Every query must enforce the public visibility predicate
    // (Req 6.1, Design §10.2). We assert against the count + list
    // SQL — the facet SQL inherits the same WHERE via
    // `buildWhereClause`.
    const countSql = sqls.find((s) =>
      /COUNT\(\*\) AS n FROM job_postings/i.test(s),
    );
    const listSql = sqls.find((s) =>
      /^SELECT j\.id, j\.slug, COALESCE/.test(s),
    );
    expect(countSql).toBeDefined();
    expect(listSql).toBeDefined();

    for (const sql of [countSql, listSql]) {
      expect(sql).toContain("j.status = 'Published'");
      expect(sql).toMatch(/j\.application_deadline IS NULL/);
      expect(sql).toMatch(/j\.application_deadline >= CURRENT_DATE/);
      expect(sql).toMatch(
        /MATCH\(j\.search_text\) AGAINST \(\? IN BOOLEAN MODE\)/,
      );
      // OR within a filter / AND across filters — `IN (?, ?)` for
      // `location` (two values), `IN (?)` for `employment_type`,
      // `IN (?, ?)` for `level`.
      expect(sql).toMatch(/j\.location IN \(\?, \?\)/);
      expect(sql).toMatch(/j\.employment_type IN \(\?\)/);
      expect(sql).toMatch(/j\.level IN \(\?, \?\)/);
    }
  });

  it('passes the sanitised keyword as both `?=`` and the MATCH `?` parameter', async () => {
    await searchPublishedJobs({ keyword: 'data analyst' });

    // The first call is the count; its parameter list starts with
    // [keyword, keyword, ...] because the WHERE shape is
    // `(? = '' OR MATCH(search_text) AGAINST (? IN BOOLEAN MODE))`.
    const countCall = queryMock.mock.calls.find((c) =>
      /COUNT\(\*\) AS n FROM job_postings/i.test(c[0] as string),
    );
    expect(countCall).toBeDefined();
    const params = countCall![1] as unknown[];
    expect(params[0]).toBe(params[1]);
    // Sanitised: contains both AND-prefixed quoted tokens.
    expect(params[0]).toContain('"data"');
    expect(params[0]).toContain('"analyst"');
  });

  it('does not inject literal `+` operator into the bound MATCH parameter for hostile keyword "foo+ bar"', async () => {
    // The naked `+` is the BOOLEAN-mode AND operator; without sanitisation
    // it would be passed straight to MySQL and could trigger
    // ER_PARSE_ERROR or unexpected match semantics.
    await searchPublishedJobs({ keyword: 'foo+ bar' });

    const countCall = queryMock.mock.calls.find((c) =>
      /COUNT\(\*\) AS n FROM job_postings/i.test(c[0] as string),
    );
    const bound = (countCall![1] as unknown[])[1] as string;

    // The token bodies must be present without the stripped `+`.
    expect(bound).toContain('"foo"');
    expect(bound).toContain('"bar"');

    // The sanitiser DOES reintroduce its own `+` markers as the
    // BOOLEAN-mode AND prefix on each token (e.g. `+"foo"*`). We
    // assert that NO `+` ever sits adjacent to alphanumeric content
    // (i.e. the user's `foo+` was stripped, not preserved).
    expect(bound).not.toMatch(/[A-Za-z0-9]\+/);
    expect(bound).not.toMatch(/\+[A-Za-z0-9]/);
  });

  it('binds IN(...) values in the supplied order for the count and list queries', async () => {
    await searchPublishedJobs({
      keyword: '',
      location: ['Jakarta', 'Surabaya'],
      employment_type: ['full-time'],
      level: ['senior', 'lead'],
    });

    const countCall = queryMock.mock.calls.find((c) =>
      /COUNT\(\*\) AS n FROM job_postings/i.test(c[0] as string),
    );
    const params = countCall![1] as unknown[];
    // params layout: [keyword, keyword, locations..., empType..., levels...]
    expect(params.slice(2)).toEqual([
      'Jakarta',
      'Surabaya',
      'full-time',
      'senior',
      'lead',
    ]);
  });
});

// ---------------------------------------------------------------------------
// searchPublishedJobs — pagination
// ---------------------------------------------------------------------------

describe('searchPublishedJobs — pagination', () => {
  it('defaults pageSize to 20 when not provided', async () => {
    const result = await searchPublishedJobs({});
    expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(result.pageSize).toBe(20);

    const listCall = queryMock.mock.calls.find((c) =>
      /^SELECT j\.id, j\.slug, COALESCE/.test(c[0] as string),
    );
    const listParams = listCall![1] as unknown[];
    // Last two parameters are LIMIT, OFFSET.
    const limit = listParams[listParams.length - 2];
    expect(limit).toBe(20);
  });

  it('clamps OFFSET to MAX_OFFSET (200) for deep pages', async () => {
    // page=15 with pageSize=20 would normally give offset=300 — the
    // service must clamp it to 200 per Design §10.2.
    const result = await searchPublishedJobs({ page: 15, pageSize: 20 });
    expect(result.page).toBe(15);
    expect(result.pageSize).toBe(20);

    const listCall = queryMock.mock.calls.find((c) =>
      /^SELECT j\.id, j\.slug, COALESCE/.test(c[0] as string),
    );
    const listParams = listCall![1] as unknown[];
    const offset = listParams[listParams.length - 1];
    expect(offset).toBe(MAX_OFFSET);
    expect(offset).toBe(200);
  });

  it('passes the requested pageSize through unchanged when it is below the cap', async () => {
    await searchPublishedJobs({ page: 0, pageSize: 10 });
    const listCall = queryMock.mock.calls.find((c) =>
      /^SELECT j\.id, j\.slug, COALESCE/.test(c[0] as string),
    );
    const listParams = listCall![1] as unknown[];
    expect(listParams[listParams.length - 2]).toBe(10);
    expect(listParams[listParams.length - 1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchPublishedJobs — facet caching
// ---------------------------------------------------------------------------

describe('searchPublishedJobs — facet caching', () => {
  /** Count facet queries seen by the mock so far. */
  function countFacetCalls(): number {
    return queryMock.mock.calls.filter((c) => {
      const sql = c[0] as string;
      return (
        /^SELECT j\.location AS value/.test(sql) ||
        /^SELECT j\.department_id AS value/.test(sql) ||
        /^SELECT j\.employment_type AS value/.test(sql) ||
        /^SELECT j\.level AS value/.test(sql)
      );
    }).length;
  }

  it('reuses the cached facet tuple when called twice with an identical filter', async () => {
    const filter = {
      location: ['Jakarta'],
      employment_type: ['full-time' as const],
    };

    await searchPublishedJobs(filter);
    expect(countFacetCalls()).toBe(4);

    await searchPublishedJobs(filter);
    // Second call still issues the count + list pair, but the four
    // facet queries are served from the per-worker QuickLRU cache.
    expect(countFacetCalls()).toBe(4);
  });

  it('clearSearchCache() forces the next call to recompute facets', async () => {
    const filter = { location: ['Jakarta'] };

    await searchPublishedJobs(filter);
    expect(countFacetCalls()).toBe(4);

    await searchPublishedJobs(filter);
    expect(countFacetCalls()).toBe(4); // cache hit

    clearSearchCache();
    await searchPublishedJobs(filter);
    // Cache was dropped — the third call recomputes and adds another
    // four facet queries.
    expect(countFacetCalls()).toBe(8);
  });

  it('caches separately when only the keyword differs (cache key includes keyword)', async () => {
    await searchPublishedJobs({ keyword: 'analyst' });
    expect(countFacetCalls()).toBe(4);

    await searchPublishedJobs({ keyword: 'developer' });
    // Different sanitised keyword → distinct cache key → recomputed.
    expect(countFacetCalls()).toBe(8);
  });
});
