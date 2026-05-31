/**
 * Unit tests for `src/modules/jobs/repo.ts` (task 21.1).
 *
 * Validates: Requirements 9.1, 9.6, 11.4 (Design §10.1, §14.2)
 *
 * Coverage:
 *   - `computeSearchText` joins id+en translation fields plus skill
 *     labels into a single space-separated blob; whitespace-only
 *     segments are dropped.
 *   - `save` create path: locks the slug row, generates a UUID via the
 *     `ulid` package, INSERTs the row with the recomputed `search_text`
 *     and the actor `created_by`, replaces translations, and returns
 *     the assembled `JobPostingDetail`.
 *   - `save` update path: same slug lock, UPDATE with new
 *     `search_text`, DELETE-then-INSERT translations, returns the
 *     refreshed detail.
 *   - `save` slug conflict: when the slug is owned by a different row,
 *     `SlugConflictError` surfaces and no INSERT/UPDATE runs.
 *   - `list` with no scope: emits the canonical SELECT + COUNT pair
 *     and never adds a `department_id IN (...)` clause.
 *   - `list` with `scope.departments = [3, 7]`: appends
 *     `department_id IN (?, ?)` to BOTH the COUNT and the SELECT, and
 *     binds 3 and 7 in order.
 *   - `list` with `scope.departments = []`: returns `{ rows: [],
 *     total: 0 }` without issuing any SQL.
 *   - `list` with status filter and pagination: clamps offset to the
 *     `MAX_OFFSET` cap, threads the values through `LIMIT ? OFFSET ?`.
 *   - `findById` with empty scope returns `null` without touching the
 *     DB; with a scope that doesn't include the row's department,
 *     returns `null` after the row read.
 *   - `findBySlug` with a non-matching scope returns `null`.
 *   - `softClose` and `archive` apply the scope via the in-transaction
 *     row read; an out-of-scope row throws `JobNotFoundError`.
 *
 * The repo talks to MySQL via `query()` and `withTransaction()` from
 * `src/infra/db.ts`; we mock that boundary so the suite stays
 * hermetic. The `ulid` import inside `save()` is mocked to a stable
 * value so we can assert the UUID flowed into the INSERT params.
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

const FAKE_ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
vi.mock('ulid', () => ({
  ulid: vi.fn(() => FAKE_ULID),
}));

// Import after mocks are registered so the module picks up the doubles.
const repo = await import('../../src/modules/jobs/repo.js');
const {
  DEFAULT_PAGE_SIZE,
  JobNotFoundError,
  MAX_OFFSET,
  SlugConflictError,
  archive,
  computeSearchText,
  findById,
  findBySlug,
  list,
  save,
  softClose,
} = repo;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake `ResultSetHeader` so `execute<ResultSetHeader>` resolves. */
function makeHeader(
  affectedRows: number,
  insertId = 0,
): ResultSetHeader {
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

/** A canonical `job_postings` row returned from the read paths. */
function jobRow(
  overrides: Partial<{
    id: number;
    uuid: string;
    slug: string;
    department_id: number | null;
    location: string;
    employment_type: string;
    level: string;
    status: string;
    salary_min: number | null;
    salary_max: number | null;
    salary_currency: string | null;
    application_deadline: string | null;
    published_at: Date | null;
    created_by: number;
    created_at: Date;
    updated_at: Date;
  }> = {},
): RowDataPacket {
  return {
    id: overrides.id ?? 1,
    uuid: overrides.uuid ?? FAKE_ULID,
    slug: overrides.slug ?? 'senior-data-analyst',
    department_id: overrides.department_id ?? 3,
    location: overrides.location ?? 'Jakarta',
    employment_type: overrides.employment_type ?? 'full-time',
    level: overrides.level ?? 'senior',
    status: overrides.status ?? 'Draft',
    salary_min: overrides.salary_min ?? null,
    salary_max: overrides.salary_max ?? null,
    salary_currency: overrides.salary_currency ?? null,
    application_deadline: overrides.application_deadline ?? null,
    published_at: overrides.published_at ?? null,
    created_by: overrides.created_by ?? 42,
    created_at: overrides.created_at ?? new Date('2024-01-15T10:00:00Z'),
    updated_at: overrides.updated_at ?? new Date('2024-01-15T10:00:00Z'),
  } as unknown as RowDataPacket;
}

/** A canonical `job_posting_translations` row. */
function translationRow(
  overrides: Partial<{
    job_id: number;
    locale: 'id' | 'en';
    title: string;
    description: string;
    requirements: string;
    responsibilities: string;
  }>,
): RowDataPacket {
  return {
    job_id: overrides.job_id ?? 1,
    locale: overrides.locale ?? 'id',
    title: overrides.title ?? 'Analis Data Senior',
    description: overrides.description ?? 'Mengolah dataset besar.',
    requirements: overrides.requirements ?? 'Pengalaman SQL.',
    responsibilities: overrides.responsibilities ?? 'Menyusun laporan.',
  } as unknown as RowDataPacket;
}

interface FakeConnection {
  execute: ReturnType<typeof vi.fn>;
}

function createFakeConnection(): {
  connection: FakeConnection;
  executeMock: ReturnType<typeof vi.fn>;
} {
  const executeMock = vi.fn();
  return { connection: { execute: executeMock }, executeMock };
}

/**
 * Bind `withTransaction` so the next call invokes the supplied
 * callback with the supplied fake connection. Mirrors production
 * behaviour minus the BEGIN/COMMIT bookkeeping (covered separately by
 * the `withTransaction` unit tests).
 */
function bindTransaction(connection: FakeConnection): void {
  withTransactionMock.mockImplementationOnce(
    async (fn: (conn: FakeConnection) => Promise<unknown>) => fn(connection),
  );
}

const SAMPLE_TRANSLATIONS = [
  {
    locale: 'id' as const,
    title: 'Analis Data Senior',
    description: 'Mengolah dataset besar dan membangun model.',
    requirements: 'Pengalaman SQL minimal 3 tahun.',
    responsibilities: 'Menyusun laporan mingguan.',
  },
  {
    locale: 'en' as const,
    title: 'Senior Data Analyst',
    description: 'Process large datasets and build models.',
    requirements: 'At least 3 years of SQL experience.',
    responsibilities: 'Produce weekly reports.',
  },
];

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// computeSearchText
// ---------------------------------------------------------------------------

describe('computeSearchText', () => {
  it('joins id+en translation fields and skill labels', () => {
    const out = computeSearchText(SAMPLE_TRANSLATIONS, ['SQL', 'Python']);
    // Must include each field from both locales and each skill label.
    expect(out).toContain('Analis Data Senior');
    expect(out).toContain('Senior Data Analyst');
    expect(out).toContain('Pengalaman SQL minimal 3 tahun.');
    expect(out).toContain('At least 3 years of SQL experience.');
    expect(out).toContain('Menyusun laporan mingguan.');
    expect(out).toContain('Produce weekly reports.');
    expect(out).toContain('SQL');
    expect(out).toContain('Python');
  });

  it('drops empty/whitespace-only segments', () => {
    const out = computeSearchText(
      [
        {
          locale: 'id',
          title: 'Hello',
          description: '',
          requirements: '   ',
          responsibilities: '',
        },
      ],
      ['', '   ', 'Skill'],
    );
    expect(out).toContain('Hello');
    expect(out).toContain('Skill');
    // No leading/trailing operator characters from the join.
    expect(out.startsWith('Hello')).toBe(true);
  });

  it('returns empty string when there is nothing to index', () => {
    expect(computeSearchText([], [])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// save() — create flow
// ---------------------------------------------------------------------------

describe('save() — create flow', () => {
  it('locks slug, generates uuid, computes search_text, inserts row and translations', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // 1. SLUG_LOCK_SQL → no existing row.
    executeMock.mockResolvedValueOnce([[], []]);
    // 2. INSERT job_postings.
    executeMock.mockResolvedValueOnce([makeHeader(1, 7), []]);
    // 3. DELETE translations (for the just-inserted job).
    executeMock.mockResolvedValueOnce([makeHeader(0), []]);
    // 4. INSERT translation id.
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);
    // 5. INSERT translation en.
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);
    // 6. SELECT job by id (read-back).
    executeMock.mockResolvedValueOnce([
      [jobRow({ id: 7, uuid: FAKE_ULID, status: 'Draft' })],
      [],
    ]);
    // 7. SELECT translations (read-back).
    executeMock.mockResolvedValueOnce([
      [
        translationRow({ job_id: 7, locale: 'id' }),
        translationRow({
          job_id: 7,
          locale: 'en',
          title: 'Senior Data Analyst',
        }),
      ],
      [],
    ]);

    const result = await save(
      {
        id: null,
        slug: 'senior-data-analyst',
        department_id: 3,
        location: 'Jakarta',
        employment_type: 'full-time',
        level: 'senior',
        status: 'Draft',
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        application_deadline: null,
        translations: SAMPLE_TRANSLATIONS,
        skillLabels: ['SQL', 'Python'],
      },
      42,
    );

    // 1. Slug lock SQL + bind value.
    const slugLockCall = executeMock.mock.calls[0];
    expect(slugLockCall[0]).toMatch(
      /SELECT id FROM job_postings WHERE slug = \? FOR UPDATE/i,
    );
    expect(slugLockCall[1]).toEqual(['senior-data-analyst']);

    // 2. INSERT job — uuid first, search_text last, actor as created_by.
    const insertJobCall = executeMock.mock.calls[1];
    expect(insertJobCall[0]).toMatch(/INSERT INTO job_postings/i);
    const insertParams = insertJobCall[1] as unknown[];
    expect(insertParams[0]).toBe(FAKE_ULID); // uuid
    expect(insertParams[1]).toBe('senior-data-analyst'); // slug
    expect(insertParams[2]).toBe(3); // department_id
    // status sits at index 6.
    expect(insertParams[6]).toBe('Draft');
    // created_by must be the actor user id, not whatever was on the
    // input. The caller never supplies created_by — the actor argument
    // is the source of truth.
    expect(insertParams[12]).toBe(42);
    // search_text is the last bind and must contain locale strings + skill labels.
    const searchText = insertParams[13] as string;
    expect(searchText).toContain('Analis Data Senior');
    expect(searchText).toContain('Senior Data Analyst');
    expect(searchText).toContain('SQL');
    expect(searchText).toContain('Python');

    // 3. DELETE translations.
    const deleteCall = executeMock.mock.calls[2];
    expect(deleteCall[0]).toMatch(
      /DELETE FROM job_posting_translations WHERE job_id = \?/i,
    );
    expect(deleteCall[1]).toEqual([7]);

    // 4-5. INSERT translations id + en.
    const trIdCall = executeMock.mock.calls[3];
    expect(trIdCall[0]).toMatch(/INSERT INTO job_posting_translations/i);
    expect(trIdCall[1]).toEqual([
      7,
      'id',
      'Analis Data Senior',
      'Mengolah dataset besar dan membangun model.',
      'Pengalaman SQL minimal 3 tahun.',
      'Menyusun laporan mingguan.',
    ]);
    const trEnCall = executeMock.mock.calls[4];
    expect(trEnCall[1]).toEqual([
      7,
      'en',
      'Senior Data Analyst',
      'Process large datasets and build models.',
      'At least 3 years of SQL experience.',
      'Produce weekly reports.',
    ]);

    // Returned shape carries the canonical row plus a translations map.
    expect(result.id).toBe(7);
    expect(result.uuid).toBe(FAKE_ULID);
    expect(result.slug).toBe('senior-data-analyst');
    expect(result.translations.id?.title).toBe('Analis Data Senior');
    expect(result.translations.en?.title).toBe('Senior Data Analyst');
  });

  it('rejects with SlugConflictError when slug is owned by a different row', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // Slug already owned by job id=99.
    executeMock.mockResolvedValueOnce([
      [{ id: 99 } as unknown as RowDataPacket],
      [],
    ]);

    await expect(
      save(
        {
          id: null,
          slug: 'senior-data-analyst',
          department_id: 3,
          location: 'Jakarta',
          employment_type: 'full-time',
          level: 'senior',
          status: 'Draft',
          salary_min: null,
          salary_max: null,
          salary_currency: null,
          application_deadline: null,
          translations: SAMPLE_TRANSLATIONS,
          skillLabels: [],
        },
        42,
      ),
    ).rejects.toBeInstanceOf(SlugConflictError);

    // Only the slug-lock SELECT ran — no INSERT.
    const sqls = executeMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /INSERT INTO job_postings/i.test(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// save() — update flow
// ---------------------------------------------------------------------------

describe('save() — update flow', () => {
  it('locks slug, UPDATEs row with recomputed search_text, replaces translations', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // 1. Slug lock — already owned by id=7 (the row we are updating).
    executeMock.mockResolvedValueOnce([
      [{ id: 7 } as unknown as RowDataPacket],
      [],
    ]);
    // 2. UPDATE job_postings.
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);
    // 3. SELECT existing row (to fetch uuid for the return value).
    executeMock.mockResolvedValueOnce([
      [jobRow({ id: 7, uuid: FAKE_ULID, status: 'Draft' })],
      [],
    ]);
    // 4. DELETE translations.
    executeMock.mockResolvedValueOnce([makeHeader(2), []]);
    // 5-6. INSERT translations id + en.
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);
    // 7. SELECT job (read-back).
    executeMock.mockResolvedValueOnce([
      [jobRow({ id: 7, uuid: FAKE_ULID, status: 'Draft' })],
      [],
    ]);
    // 8. SELECT translations (read-back).
    executeMock.mockResolvedValueOnce([
      [
        translationRow({ job_id: 7, locale: 'id' }),
        translationRow({ job_id: 7, locale: 'en', title: 'Senior Data Analyst' }),
      ],
      [],
    ]);

    const result = await save(
      {
        id: 7,
        slug: 'senior-data-analyst',
        department_id: 3,
        location: 'Jakarta',
        employment_type: 'full-time',
        level: 'senior',
        status: 'Draft',
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        application_deadline: null,
        translations: SAMPLE_TRANSLATIONS,
        skillLabels: ['SQL'],
      },
      42,
    );

    // UPDATE must carry the same column count as the SQL constant
    // (slug, dept, loc, type, level, status, smin, smax, scur, dl, pub,
    //  search_text, id) → 13 bound values.
    const updateCall = executeMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE job_postings SET/i);
    const updateParams = updateCall[1] as unknown[];
    expect(updateParams).toHaveLength(13);
    // Last bind is the WHERE id param.
    expect(updateParams[12]).toBe(7);
    // search_text sits at index 11 and must reflect the new translations.
    const searchText = updateParams[11] as string;
    expect(searchText).toContain('Analis Data Senior');
    expect(searchText).toContain('SQL');

    // Translations must be replaced (DELETE before INSERT).
    const sqls = executeMock.mock.calls.map((c) => c[0] as string);
    const deleteIdx = sqls.findIndex((s) =>
      /DELETE FROM job_posting_translations/i.test(s),
    );
    const firstInsertIdx = sqls.findIndex((s) =>
      /INSERT INTO job_posting_translations/i.test(s),
    );
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(firstInsertIdx).toBeGreaterThan(deleteIdx);

    expect(result.id).toBe(7);
    expect(result.translations.id?.title).toBe('Analis Data Senior');
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('list() — no scope, no filter', () => {
  it('runs COUNT + SELECT without a department_id IN clause', async () => {
    queryMock.mockResolvedValueOnce([
      { n: 2 } as unknown as RowDataPacket,
    ]);
    queryMock.mockResolvedValueOnce([jobRow({ id: 1 }), jobRow({ id: 2 })]);

    const out = await list();
    expect(out.total).toBe(2);
    expect(out.rows).toHaveLength(2);

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [countSql, countParams] = queryMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(countSql).toMatch(/SELECT COUNT\(\*\) AS n FROM job_postings/i);
    // Without filters or scope, no WHERE clause.
    expect(countSql).not.toMatch(/WHERE/i);
    expect(countSql).not.toMatch(/department_id IN/i);
    expect(countParams).toEqual([]);

    const [listSql, listParams] = queryMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(listSql).toMatch(/FROM job_postings/i);
    expect(listSql).toMatch(/ORDER BY/i);
    expect(listSql).toMatch(/LIMIT \? OFFSET \?/i);
    expect(listSql).not.toMatch(/department_id IN/i);
    // Last two params are the page size + offset.
    expect(listParams).toEqual([DEFAULT_PAGE_SIZE, 0]);
  });
});

describe('list() — Department_Head scope', () => {
  it('with departments=[3, 7] injects department_id IN (?, ?) and binds 3, 7', async () => {
    queryMock.mockResolvedValueOnce([
      { n: 1 } as unknown as RowDataPacket,
    ]);
    queryMock.mockResolvedValueOnce([jobRow({ id: 1, department_id: 3 })]);

    const out = await list({}, { departments: [3, 7] });
    expect(out.total).toBe(1);

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [countSql, countParams] = queryMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(countSql).toMatch(/WHERE/i);
    expect(countSql).toMatch(/department_id IN \(\?, \?\)/i);
    expect(countParams).toEqual([3, 7]);

    const [listSql, listParams] = queryMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(listSql).toMatch(/department_id IN \(\?, \?\)/i);
    // First two params are the scoped departments, then page size + offset.
    expect(listParams).toEqual([3, 7, DEFAULT_PAGE_SIZE, 0]);
  });

  it('with departments=[] short-circuits to {rows:[], total:0} without hitting the DB', async () => {
    const out = await list({}, { departments: [] });
    expect(out).toEqual({ rows: [], total: 0 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('with status filter combined with scope binds both', async () => {
    queryMock.mockResolvedValueOnce([{ n: 0 } as unknown as RowDataPacket]);
    queryMock.mockResolvedValueOnce([]);

    await list(
      { status: ['Published'], page: 0, pageSize: 5 },
      { departments: [9] },
    );

    const [countSql, countParams] = queryMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(countSql).toMatch(/status IN \(\?\)/i);
    expect(countSql).toMatch(/department_id IN \(\?\)/i);
    expect(countParams).toEqual(['Published', 9]);
  });

  it('clamps offset to MAX_OFFSET per design §10.2', async () => {
    queryMock.mockResolvedValueOnce([{ n: 0 } as unknown as RowDataPacket]);
    queryMock.mockResolvedValueOnce([]);

    // Page 1000 with pageSize 20 → naive offset is 20000. Repo must
    // clamp to MAX_OFFSET (200).
    await list({ page: 1000, pageSize: 20 });

    const [, listParams] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(listParams[listParams.length - 1]).toBe(MAX_OFFSET);
  });
});

// ---------------------------------------------------------------------------
// findById / findBySlug — scope behaviour
// ---------------------------------------------------------------------------

describe('findById() — scope', () => {
  it('returns null without hitting the DB when scope.departments=[]', async () => {
    const out = await findById(1, { departments: [] });
    expect(out).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns null when the row exists but its department_id is outside the scope', async () => {
    // SELECT job by id → row in dept 99.
    queryMock.mockResolvedValueOnce([jobRow({ id: 1, department_id: 99 })]);

    const out = await findById(1, { departments: [3, 7] });
    expect(out).toBeNull();
    // Translations were NOT fetched because the row is filtered out.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns the row when the department is inside the scope', async () => {
    queryMock.mockResolvedValueOnce([jobRow({ id: 1, department_id: 3 })]);
    queryMock.mockResolvedValueOnce([
      translationRow({ job_id: 1, locale: 'id' }),
    ]);

    const out = await findById(1, { departments: [3, 7] });
    expect(out).not.toBeNull();
    expect(out?.id).toBe(1);
    expect(out?.translations.id?.title).toBe('Analis Data Senior');
  });

  it('returns null without hitting the DB for non-positive ids', async () => {
    expect(await findById(0)).toBeNull();
    expect(await findById(-1)).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('findBySlug() — scope', () => {
  it('returns null when the slug exists but the row is outside scope', async () => {
    // Slug lookup hits a row in department 99.
    queryMock.mockResolvedValueOnce([jobRow({ id: 1, department_id: 99 })]);
    // findBySlug delegates to findById, which performs the scope
    // check on the freshly fetched row. The PK lookup is the second
    // queryMock call.
    queryMock.mockResolvedValueOnce([jobRow({ id: 1, department_id: 99 })]);

    const out = await findBySlug('senior-data-analyst', { departments: [3] });
    expect(out).toBeNull();
  });

  it('returns null without hitting the DB for empty scope', async () => {
    const out = await findBySlug('any-slug', { departments: [] });
    expect(out).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// softClose / archive — scope enforcement
// ---------------------------------------------------------------------------

describe('softClose() — scope', () => {
  it('rejects with JobNotFoundError when the row is outside the scope', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // SELECT job by id → row in dept 99.
    executeMock.mockResolvedValueOnce([
      [jobRow({ id: 1, department_id: 99, status: 'Published' })],
      [],
    ]);

    await expect(
      softClose(1, 42, { departments: [3] }),
    ).rejects.toBeInstanceOf(JobNotFoundError);

    // No UPDATE ran.
    const sqls = executeMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /UPDATE job_postings/i.test(s))).toBe(false);
  });

  it('UPDATEs the status when the row is in the scope and currently Published', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [jobRow({ id: 1, department_id: 3, status: 'Published' })],
      [],
    ]);
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);

    const result = await softClose(1, 42, { departments: [3, 7] });
    expect(result.status).toBe('Closed');

    const updateCall = executeMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE job_postings SET status = \?/i);
    expect(updateCall[1]).toEqual(['Closed', 1]);
  });
});

describe('archive() — scope', () => {
  it('rejects with JobNotFoundError when the row is outside the scope', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [jobRow({ id: 1, department_id: 99, status: 'Published' })],
      [],
    ]);

    await expect(
      archive(1, 42, { departments: [3] }),
    ).rejects.toBeInstanceOf(JobNotFoundError);

    const sqls = executeMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /UPDATE job_postings/i.test(s))).toBe(false);
  });

  it('archives a Published row in scope', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    executeMock.mockResolvedValueOnce([
      [jobRow({ id: 1, department_id: 3, status: 'Published' })],
      [],
    ]);
    executeMock.mockResolvedValueOnce([makeHeader(1), []]);

    const result = await archive(1, 42, { departments: [3] });
    expect(result.status).toBe('Archived');

    const updateCall = executeMock.mock.calls[1];
    expect(updateCall[1]).toEqual(['Archived', 1]);
  });
});
