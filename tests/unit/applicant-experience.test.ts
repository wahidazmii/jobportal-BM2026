/**
 * Unit tests for `src/modules/applicant/experience.ts` (task 16.3).
 *
 * Validates: Requirements 4.3 (Design §6 Applicant_Area)
 *
 * Coverage:
 *   - `experienceSchema` enforces every Req-4.3 rule:
 *       * `company` 1..150 chars (NOT NULL).
 *       * `title` 1..100 chars (NOT NULL).
 *       * `employment_type` is one of the DDL enum values.
 *       * `start_date` is required and ≤ today.
 *       * `is_current=true` ⇔ `end_date IS NULL` (bidirectional).
 *       * `end_date >= start_date` when both are provided.
 *       * `description` ≤ 1000 chars / nullable.
 *   - `MAX_EXPERIENCE_ENTRIES` is 30 (cap from task 16.3).
 *   - `createExperience` enforces the 30-entry cap inside a transaction
 *     and refuses to insert a 31st row.
 *   - `updateExperience` and `deleteExperience` scope every WHERE to
 *     `(id, applicant_user_id)` and surface `ExperienceNotFoundError`
 *     when the row is missing or owned by another applicant
 *     (preventing IDOR).
 *
 * The service talks to MySQL via `query()` and `withTransaction()` from
 * `src/infra/db.ts`; we mock that boundary so the suite stays hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Import after the mock is registered.
const experienceModule = await import(
  '../../src/modules/applicant/experience.js'
);
const {
  EMPLOYMENT_TYPES,
  ExperienceCapError,
  ExperienceNotFoundError,
  MAX_EXPERIENCE_ENTRIES,
  createExperience,
  deleteExperience,
  experienceSchema,
  findExperienceById,
  listExperience,
  updateExperience,
} = experienceModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a YYYY-MM-DD string `years` years before today (in UTC). */
function yearsAgoIsoYmd(years: number, dayOffset = 0): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear() - years,
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
    ),
  );
  return d.toISOString().slice(0, 10);
}

function todayIsoYmd(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

function tomorrowIsoYmd(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  )
    .toISOString()
    .slice(0, 10);
}

/** Build a fake mysql2 ResultSetHeader. */
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

const VALID_BASE = {
  company: 'PT Buana Megah',
  title: 'Engineer',
  employment_type: 'full-time',
  start_date: yearsAgoIsoYmd(2),
  end_date: yearsAgoIsoYmd(1),
  is_current: false,
  description: 'Did engineering things.',
} as const;

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

afterEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('experience constants', () => {
  it('caps entries at 30 per applicant', () => {
    expect(MAX_EXPERIENCE_ENTRIES).toBe(30);
  });

  it('exposes the DDL employment_type enum values', () => {
    expect([...EMPLOYMENT_TYPES]).toEqual([
      'full-time',
      'part-time',
      'contract',
      'internship',
      'freelance',
    ]);
  });
});

// ---------------------------------------------------------------------------
// experienceSchema — company / title length caps
// ---------------------------------------------------------------------------

describe('experienceSchema — company (1..150 chars)', () => {
  it('accepts a typical company name and trims surrounding whitespace', () => {
    const result = experienceSchema.parse({
      ...VALID_BASE,
      company: '  ACME Inc  ',
    });
    expect(result.company).toBe('ACME Inc');
  });

  it('rejects an empty company name', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, company: '' }),
    ).toThrow(ZodError);
  });

  it('accepts exactly 150 characters', () => {
    const company = 'A'.repeat(150);
    const result = experienceSchema.parse({ ...VALID_BASE, company });
    expect(result.company).toBe(company);
  });

  it('rejects 151 characters', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, company: 'A'.repeat(151) }),
    ).toThrow(/150/);
  });
});

describe('experienceSchema — title (1..100 chars)', () => {
  it('accepts exactly 100 characters', () => {
    const title = 'T'.repeat(100);
    const result = experienceSchema.parse({ ...VALID_BASE, title });
    expect(result.title).toBe(title);
  });

  it('rejects 101 characters', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, title: 'T'.repeat(101) }),
    ).toThrow(/100/);
  });

  it('rejects an empty title', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, title: '' }),
    ).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// experienceSchema — employment_type enum
// ---------------------------------------------------------------------------

describe('experienceSchema — employment_type enum', () => {
  it.each(EMPLOYMENT_TYPES)('accepts employment_type = %s', (value) => {
    const result = experienceSchema.parse({
      ...VALID_BASE,
      employment_type: value,
    });
    expect(result.employment_type).toBe(value);
  });

  it('rejects a value outside the DDL enum', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, employment_type: 'volunteer' }),
    ).toThrow(/Employment type/);
  });

  it('rejects an empty employment_type', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, employment_type: '' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// experienceSchema — start_date <= today
// ---------------------------------------------------------------------------

describe('experienceSchema — start_date (required, ≤ today)', () => {
  it('accepts today as the start date', () => {
    const result = experienceSchema.parse({
      ...VALID_BASE,
      start_date: todayIsoYmd(),
      end_date: '',
      is_current: true,
    });
    expect(result.start_date).toBe(todayIsoYmd());
  });

  it('accepts a past start date', () => {
    const ten = yearsAgoIsoYmd(10);
    const result = experienceSchema.parse({
      ...VALID_BASE,
      start_date: ten,
      end_date: yearsAgoIsoYmd(5),
    });
    expect(result.start_date).toBe(ten);
  });

  it('rejects a future start date', () => {
    expect(() =>
      experienceSchema.parse({
        ...VALID_BASE,
        start_date: tomorrowIsoYmd(),
        end_date: '',
        is_current: true,
      }),
    ).toThrow(/future/);
  });

  it('rejects malformed start_date strings', () => {
    expect(() =>
      experienceSchema.parse({
        ...VALID_BASE,
        start_date: '2024/01/01',
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('rejects an empty start_date', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, start_date: '' }),
    ).toThrow(/required/i);
  });
});

// ---------------------------------------------------------------------------
// experienceSchema — is_current ↔ end_date bidirectional
// ---------------------------------------------------------------------------

describe('experienceSchema — is_current ↔ end_date is null', () => {
  it('accepts is_current=true with empty end_date', () => {
    const result = experienceSchema.parse({
      ...VALID_BASE,
      end_date: '',
      is_current: true,
    });
    expect(result.is_current).toBe(true);
    expect(result.end_date).toBeNull();
  });

  it('rejects is_current=true with a non-empty end_date', () => {
    expect(() =>
      experienceSchema.parse({
        ...VALID_BASE,
        end_date: yearsAgoIsoYmd(1),
        is_current: true,
      }),
    ).toThrow(/current position/);
  });

  it('rejects is_current=false with empty end_date', () => {
    expect(() =>
      experienceSchema.parse({
        ...VALID_BASE,
        end_date: '',
        is_current: false,
      }),
    ).toThrow(/End date is required/);
  });

  it('accepts is_current=false with end_date >= start_date', () => {
    const result = experienceSchema.parse({
      ...VALID_BASE,
      start_date: yearsAgoIsoYmd(3),
      end_date: yearsAgoIsoYmd(1),
      is_current: false,
    });
    expect(result.is_current).toBe(false);
    expect(result.end_date).toBe(yearsAgoIsoYmd(1));
  });

  it('rejects end_date < start_date', () => {
    expect(() =>
      experienceSchema.parse({
        ...VALID_BASE,
        start_date: yearsAgoIsoYmd(2),
        end_date: yearsAgoIsoYmd(3),
        is_current: false,
      }),
    ).toThrow(/on or after start date/);
  });

  it('coerces "on" string to is_current=true', () => {
    const result = experienceSchema.parse({
      ...VALID_BASE,
      end_date: '',
      is_current: 'on',
    });
    expect(result.is_current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// experienceSchema — description ≤ 1000
// ---------------------------------------------------------------------------

describe('experienceSchema — description (≤ 1000 chars / nullable)', () => {
  it('accepts a 1000-character description', () => {
    const desc = 'd'.repeat(1000);
    const result = experienceSchema.parse({ ...VALID_BASE, description: desc });
    expect(result.description).toBe(desc);
  });

  it('rejects a 1001-character description', () => {
    expect(() =>
      experienceSchema.parse({
        ...VALID_BASE,
        description: 'd'.repeat(1001),
      }),
    ).toThrow(/1000/);
  });

  it('treats an empty description as null', () => {
    const result = experienceSchema.parse({
      ...VALID_BASE,
      description: '',
    });
    expect(result.description).toBeNull();
  });

  it('accepts a missing description (null)', () => {
    const { description: _drop, ...without } = VALID_BASE;
    void _drop;
    const result = experienceSchema.parse(without);
    expect(result.description).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// experienceSchema — strict mode
// ---------------------------------------------------------------------------

describe('experienceSchema — strict mode', () => {
  it('rejects unknown keys', () => {
    expect(() =>
      experienceSchema.parse({ ...VALID_BASE, applicant_user_id: 99 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// listExperience / findExperienceById
// ---------------------------------------------------------------------------

describe('listExperience', () => {
  it('queries the table scoped to the applicant', async () => {
    queryMock.mockResolvedValueOnce([]);
    const result = await listExperience(42);
    expect(result).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /FROM applicant_experience\s+WHERE applicant_user_id = \?/i,
    );
    expect(params).toEqual([42]);
  });

  it('hydrates rows into the canonical record shape', async () => {
    const row = {
      id: 7,
      applicant_user_id: 42,
      company: 'ACME',
      title: 'Engineer',
      employment_type: 'full-time',
      start_date: new Date('2020-01-01T00:00:00.000Z'),
      end_date: new Date('2022-06-30T00:00:00.000Z'),
      is_current: 0,
      description: 'Stuff',
    } as unknown as RowDataPacket;
    queryMock.mockResolvedValueOnce([row]);
    const result = await listExperience(42);
    expect(result).toEqual([
      {
        id: 7,
        applicant_user_id: 42,
        company: 'ACME',
        title: 'Engineer',
        employment_type: 'full-time',
        start_date: '2020-01-01',
        end_date: '2022-06-30',
        is_current: false,
        description: 'Stuff',
      },
    ]);
  });
});

describe('findExperienceById', () => {
  it('scopes the WHERE clause to (id, applicant_user_id)', async () => {
    queryMock.mockResolvedValueOnce([]);
    await findExperienceById(42, 7);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \? AND applicant_user_id = \?/i);
    expect(params).toEqual([7, 42]);
  });

  it('returns null when the row does not exist or is owned by another user', async () => {
    queryMock.mockResolvedValueOnce([]);
    const result = await findExperienceById(42, 7);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createExperience
// ---------------------------------------------------------------------------

describe('createExperience', () => {
  it('inserts a row when below the cap and returns the canonical record', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);

    // Sequence inside the transaction:
    //   1. SELECT COUNT(*) FOR UPDATE → 5
    //   2. INSERT → ResultSetHeader(insertId=10)
    //   3. SELECT BY ID → newly-inserted row
    executeMock
      .mockResolvedValueOnce([[{ n: 5 }] as unknown as RowDataPacket[], []])
      .mockResolvedValueOnce([makeHeader(1, 10), []])
      .mockResolvedValueOnce([
        [
          {
            id: 10,
            applicant_user_id: 42,
            company: 'PT Buana Megah',
            title: 'Engineer',
            employment_type: 'full-time',
            start_date: '2020-01-01',
            end_date: '2022-06-30',
            is_current: 0,
            description: 'Did engineering things.',
          },
        ] as unknown as RowDataPacket[],
        [],
      ]);

    const result = await createExperience(42, {
      ...VALID_BASE,
      start_date: '2020-01-01',
      end_date: '2022-06-30',
      is_current: false,
    });

    expect(result.id).toBe(10);
    expect(result.applicant_user_id).toBe(42);
    expect(executeMock).toHaveBeenCalledTimes(3);

    // 1. COUNT FOR UPDATE pinned to applicant.
    const [countSql, countParams] = executeMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(countSql).toMatch(/SELECT COUNT\(\*\)[\s\S]+FOR UPDATE/i);
    expect(countParams).toEqual([42]);

    // 2. INSERT carries applicant_user_id from the session, never the body.
    const [insertSql, insertParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(insertSql).toMatch(/INSERT INTO applicant_experience/i);
    expect(insertParams).toEqual([
      42,
      'PT Buana Megah',
      'Engineer',
      'full-time',
      '2020-01-01',
      '2022-06-30',
      0,
      'Did engineering things.',
    ]);
  });

  it('throws ExperienceCapError when count is already 30', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);
    executeMock.mockResolvedValueOnce([
      [{ n: 30 }] as unknown as RowDataPacket[],
      [],
    ]);

    await expect(
      createExperience(42, {
        ...VALID_BASE,
        start_date: '2020-01-01',
        end_date: '2022-06-30',
        is_current: false,
      }),
    ).rejects.toBeInstanceOf(ExperienceCapError);

    // Only the COUNT query ran — no INSERT, no SELECT BY ID.
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('throws ExperienceCapError when count exceeds 30 (defensive guard)', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);
    executeMock.mockResolvedValueOnce([
      [{ n: 31 }] as unknown as RowDataPacket[],
      [],
    ]);

    await expect(
      createExperience(42, {
        ...VALID_BASE,
        start_date: '2020-01-01',
        end_date: '2022-06-30',
        is_current: false,
      }),
    ).rejects.toThrow(ExperienceCapError);
  });

  it('throws ZodError without opening a transaction when input is invalid', async () => {
    await expect(
      createExperience(42, {
        ...VALID_BASE,
        company: '',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses is_current=true when end_date is provided (bidirectional)', async () => {
    await expect(
      createExperience(42, {
        ...VALID_BASE,
        is_current: true,
        end_date: '2022-06-30',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('writes is_current as 0/1 (TINYINT) to MySQL', async () => {
    const { connection, executeMock } = createFakeConnection();
    bindTransaction(connection);
    executeMock
      .mockResolvedValueOnce([[{ n: 0 }] as unknown as RowDataPacket[], []])
      .mockResolvedValueOnce([makeHeader(1, 1), []])
      .mockResolvedValueOnce([
        [
          {
            id: 1,
            applicant_user_id: 42,
            company: 'ACME',
            title: 'Eng',
            employment_type: 'full-time',
            start_date: '2024-01-01',
            end_date: null,
            is_current: 1,
            description: null,
          },
        ] as unknown as RowDataPacket[],
        [],
      ]);

    await createExperience(42, {
      company: 'ACME',
      title: 'Eng',
      employment_type: 'full-time',
      start_date: '2024-01-01',
      end_date: '',
      is_current: true,
    });

    const [, insertParams] = executeMock.mock.calls[1] as [string, unknown[]];
    // is_current at index 6 must be 1 (not the boolean true).
    expect(insertParams[6]).toBe(1);
    // end_date at index 5 must be null.
    expect(insertParams[5]).toBeNull();
    // applicant_user_id at index 0 sourced from the session, not the body.
    expect(insertParams[0]).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// updateExperience — ownership scoping
// ---------------------------------------------------------------------------

describe('updateExperience', () => {
  it('scopes the WHERE clause to (id, applicant_user_id) and returns canonical row', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(1)) // UPDATE
      .mockResolvedValueOnce([
        {
          id: 7,
          applicant_user_id: 42,
          company: 'ACME',
          title: 'Engineer',
          employment_type: 'full-time',
          start_date: '2020-01-01',
          end_date: '2022-06-30',
          is_current: 0,
          description: null,
        },
      ] as unknown as RowDataPacket[]); // SELECT BY ID

    const result = await updateExperience(42, 7, {
      company: 'ACME',
      title: 'Engineer',
      employment_type: 'full-time',
      start_date: '2020-01-01',
      end_date: '2022-06-30',
      is_current: false,
      description: '',
    });

    expect(result.id).toBe(7);
    expect(result.applicant_user_id).toBe(42);

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = queryMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(updateSql).toMatch(/UPDATE applicant_experience SET/i);
    expect(updateSql).toMatch(/WHERE id = \? AND applicant_user_id = \?$/);
    // The `id` and `applicant_user_id` are the LAST two parameters.
    expect(updateParams[updateParams.length - 2]).toBe(7);
    expect(updateParams[updateParams.length - 1]).toBe(42);
  });

  it('throws ExperienceNotFoundError when no row matches', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(0));
    await expect(
      updateExperience(42, 999, {
        company: 'ACME',
        title: 'Engineer',
        employment_type: 'full-time',
        start_date: '2020-01-01',
        end_date: '2022-06-30',
        is_current: false,
        description: '',
      }),
    ).rejects.toBeInstanceOf(ExperienceNotFoundError);
  });

  it('throws ZodError without issuing a query when validation fails', async () => {
    await expect(
      updateExperience(42, 7, {
        company: '',
        title: 'Engineer',
        employment_type: 'full-time',
        start_date: '2020-01-01',
        end_date: '2022-06-30',
        is_current: false,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('refuses to relax the future-date rule on update', async () => {
    await expect(
      updateExperience(42, 7, {
        company: 'ACME',
        title: 'Engineer',
        employment_type: 'full-time',
        start_date: tomorrowIsoYmd(),
        end_date: '',
        is_current: true,
      }),
    ).rejects.toThrow(/future/);
  });
});

// ---------------------------------------------------------------------------
// deleteExperience — ownership scoping
// ---------------------------------------------------------------------------

describe('deleteExperience', () => {
  it('scopes the DELETE to (id, applicant_user_id)', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));
    await deleteExperience(42, 7);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /DELETE FROM applicant_experience WHERE id = \? AND applicant_user_id = \?/i,
    );
    expect(params).toEqual([7, 42]);
  });

  it('throws ExperienceNotFoundError when the row is missing or not owned', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(0));
    await expect(deleteExperience(42, 999)).rejects.toBeInstanceOf(
      ExperienceNotFoundError,
    );
  });
});
