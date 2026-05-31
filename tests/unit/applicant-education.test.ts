/**
 * Unit tests for `src/modules/applicant/education.ts` (task 16.2).
 *
 * Validates: Requirements 4.2 (Design §6 Applicant_Area)
 *
 * Coverage:
 *   - `educationSchema` enforces every Req-4.2 rule:
 *       * `institution` 1..150 chars, `degree` 1..100, `field` 1..100.
 *       * `start_date` is a `YYYY-MM-DD` and `<=` today.
 *       * `end_date` ≥ `start_date` when both are provided.
 *       * `in_progress=true` ⇔ `end_date IS NULL` (matches the
 *         `chk_edu_progress` CHECK in migration 0002).
 *       * `gpa` ∈ `[0.00, 4.00]` and is snapped to 2 decimal places to
 *         fit `DECIMAL(3,2)`.
 *   - `createEducation` enforces the 20-entry cap by rejecting at the
 *     SELECT-COUNT-FOR-UPDATE branch with `EducationCapError`.
 *   - `updateEducation` and `deleteEducation` always include
 *     `applicant_user_id = ?` in the WHERE clause and surface
 *     `EducationNotFoundError` when the row does not match the
 *     authenticated user (ownership check / IDOR guard).
 *
 * The module talks to MySQL via `query()` and `withTransaction()` from
 * `src/infra/db.ts`. We mock those boundaries so the suite stays
 * hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after the mocks are registered.
const educationModule = await import(
  '../../src/modules/applicant/education.js'
);
const {
  EducationCapError,
  EducationNotFoundError,
  GPA_MAX,
  GPA_MIN,
  MAX_EDUCATION_ENTRIES,
  createEducation,
  deleteEducation,
  educationSchema,
  findEducationById,
  listEducation,
  updateEducation,
} = educationModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a YYYY-MM-DD string for the date `dayOffset` days from today UTC. */
function todayPlus(dayOffset: number): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
    ),
  );
  return d.toISOString().slice(0, 10);
}

/** Helper: build a fake `ResultSetHeader` with chosen `affectedRows`/`insertId`. */
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

/** Build a fake `applicant_education` row in mysql2's expected shape. */
function rowFor(overrides: Partial<{
  id: number;
  applicant_user_id: number;
  institution: string;
  degree: string;
  field: string;
  start_date: string | Date | null;
  end_date: string | Date | null;
  in_progress: number;
  gpa: number | string | null;
}> = {}): RowDataPacket {
  return {
    id: 1,
    applicant_user_id: 42,
    institution: 'Universitas Padjadjaran',
    degree: 'S1',
    field: 'Computer Science',
    start_date: '2018-09-01',
    end_date: '2022-07-15',
    in_progress: 0,
    gpa: 3.75,
    ...overrides,
  } as unknown as RowDataPacket;
}

const VALID_INPUT = {
  institution: 'Universitas Padjadjaran',
  degree: 'S1',
  field: 'Computer Science',
  start_date: '2018-09-01',
  end_date: '2022-07-15',
  in_progress: false,
  gpa: 3.75,
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

describe('education constants', () => {
  it('exposes the 20-entry cap', () => {
    expect(MAX_EDUCATION_ENTRIES).toBe(20);
  });

  it('exposes GPA bounds 0..4', () => {
    expect(GPA_MIN).toBe(0);
    expect(GPA_MAX).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// educationSchema — text fields
// ---------------------------------------------------------------------------

describe('educationSchema — text fields', () => {
  it('accepts a minimal valid input and trims surrounding whitespace', () => {
    const result = educationSchema.parse({
      ...VALID_INPUT,
      institution: '  Universitas Padjadjaran  ',
    });
    expect(result.institution).toBe('Universitas Padjadjaran');
  });

  it('rejects an empty institution', () => {
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, institution: '' }),
    ).toThrow(/Institution is required/);
  });

  it('accepts exactly 150 chars for institution but rejects 151', () => {
    const ok = 'a'.repeat(150);
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, institution: ok }),
    ).not.toThrow();
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, institution: 'a'.repeat(151) }),
    ).toThrow(/at most 150/);
  });

  it('accepts exactly 100 chars for degree and field, rejects 101', () => {
    const ok = 'b'.repeat(100);
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, degree: ok, field: ok }),
    ).not.toThrow();
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, degree: 'b'.repeat(101) }),
    ).toThrow(/at most 100/);
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, field: 'b'.repeat(101) }),
    ).toThrow(/at most 100/);
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, applicant_user_id: 999 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// educationSchema — start_date / end_date
// ---------------------------------------------------------------------------

describe('educationSchema — start_date <= today', () => {
  it('accepts a start_date in the past', () => {
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, start_date: '2010-01-01' }),
    ).not.toThrow();
  });

  it('accepts a start_date equal to today', () => {
    const today = todayPlus(0);
    expect(() =>
      educationSchema.parse({
        ...VALID_INPUT,
        start_date: today,
        end_date: '',
        in_progress: true,
      }),
    ).not.toThrow();
  });

  it('rejects a start_date in the future', () => {
    expect(() =>
      educationSchema.parse({
        ...VALID_INPUT,
        start_date: todayPlus(1),
        end_date: '',
        in_progress: true,
      }),
    ).toThrow(/cannot be in the future/);
  });

  it('rejects a malformed start_date', () => {
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, start_date: '2018/09/01' }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe('educationSchema — end_date relationships', () => {
  it('treats empty end_date as null', () => {
    const result = educationSchema.parse({
      ...VALID_INPUT,
      end_date: '',
      in_progress: true,
    });
    expect(result.end_date).toBeNull();
  });

  it('rejects end_date before start_date', () => {
    expect(() =>
      educationSchema.parse({
        ...VALID_INPUT,
        start_date: '2020-01-01',
        end_date: '2019-12-31',
      }),
    ).toThrow(/on or after start date/);
  });

  it('accepts end_date equal to start_date', () => {
    const result = educationSchema.parse({
      ...VALID_INPUT,
      start_date: '2020-01-01',
      end_date: '2020-01-01',
    });
    expect(result.end_date).toBe('2020-01-01');
  });

  it('rejects end_date when in_progress=true', () => {
    expect(() =>
      educationSchema.parse({
        ...VALID_INPUT,
        in_progress: true,
        end_date: '2022-07-15',
      }),
    ).toThrow(/End date must be empty/);
  });

  it('accepts in_progress=true with empty end_date', () => {
    const result = educationSchema.parse({
      ...VALID_INPUT,
      in_progress: true,
      end_date: '',
    });
    expect(result.in_progress).toBe(true);
    expect(result.end_date).toBeNull();
  });

  it('accepts in_progress=false with null end_date (column allows it)', () => {
    // chk_edu_progress permits in_progress=0 with end_date IS NULL
    // because the second branch is `(in_progress = 0)` unconditionally.
    const result = educationSchema.parse({
      ...VALID_INPUT,
      in_progress: false,
      end_date: '',
    });
    expect(result.in_progress).toBe(false);
    expect(result.end_date).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// educationSchema — gpa
// ---------------------------------------------------------------------------

describe('educationSchema — gpa range and precision', () => {
  it('accepts boundary values 0.00 and 4.00', () => {
    expect(
      educationSchema.parse({ ...VALID_INPUT, gpa: 0 }).gpa,
    ).toBe(0);
    expect(
      educationSchema.parse({ ...VALID_INPUT, gpa: 4 }).gpa,
    ).toBe(4);
  });

  it('rejects negative GPA', () => {
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, gpa: -0.01 }),
    ).toThrow(/between/);
  });

  it('rejects GPA > 4', () => {
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, gpa: 4.01 }),
    ).toThrow(/between/);
  });

  it('snaps GPA to 2 decimal places to fit DECIMAL(3,2)', () => {
    // 3.456 → 3.46 (banker's rounding not relevant here; Math.round = HALF_AWAY_FROM_ZERO)
    expect(educationSchema.parse({ ...VALID_INPUT, gpa: 3.456 }).gpa).toBe(3.46);
  });

  it('treats empty GPA as null', () => {
    const result = educationSchema.parse({ ...VALID_INPUT, gpa: '' });
    expect(result.gpa).toBeNull();
  });

  it('accepts string GPA from a form post', () => {
    expect(educationSchema.parse({ ...VALID_INPUT, gpa: '3.75' }).gpa).toBe(
      3.75,
    );
  });

  it('rejects non-numeric GPA strings', () => {
    expect(() =>
      educationSchema.parse({ ...VALID_INPUT, gpa: 'A+' }),
    ).toThrow(/GPA must be a number/);
  });
});

// ---------------------------------------------------------------------------
// listEducation
// ---------------------------------------------------------------------------

describe('listEducation', () => {
  it('queries scoped by applicant_user_id and returns typed records', async () => {
    queryMock.mockResolvedValueOnce([
      rowFor({ id: 2, in_progress: 1, end_date: null, gpa: 3.5 }),
      rowFor({ id: 1, gpa: '3.75' }),
    ]);
    const result = await listEducation(42);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /FROM applicant_education[\s\S]+WHERE applicant_user_id = \?/i,
    );
    expect(params).toEqual([42]);
    expect(result).toHaveLength(2);
    expect(result[0]?.in_progress).toBe(true);
    expect(result[0]?.end_date).toBeNull();
    expect(result[1]?.gpa).toBe(3.75);
  });
});

// ---------------------------------------------------------------------------
// findEducationById — ownership scoping
// ---------------------------------------------------------------------------

describe('findEducationById', () => {
  it('always includes applicant_user_id in the WHERE clause', async () => {
    queryMock.mockResolvedValueOnce([rowFor()]);
    await findEducationById(42, 1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \? AND applicant_user_id = \?/i);
    expect(params).toEqual([1, 42]);
  });

  it('returns null when the row does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);
    const result = await findEducationById(42, 999);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createEducation — cap enforcement
// ---------------------------------------------------------------------------

describe('createEducation — cap enforcement (20 entries)', () => {
  it('throws EducationCapError when the count is already at the cap', async () => {
    const conn = {
      execute: vi
        .fn()
        // SELECT COUNT(*) FOR UPDATE
        .mockResolvedValueOnce([
          [{ n: MAX_EDUCATION_ENTRIES }],
          [],
        ]),
    };
    withTransactionMock.mockImplementation(
      async (fn: (c: typeof conn) => Promise<unknown>) => fn(conn),
    );

    await expect(
      createEducation(42, VALID_INPUT),
    ).rejects.toThrow(EducationCapError);

    expect(conn.execute).toHaveBeenCalledTimes(1);
    const [countSql, countParams] = conn.execute.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(countSql).toMatch(
      /SELECT COUNT\(\*\)[\s\S]+FROM applicant_education[\s\S]+WHERE applicant_user_id = \?[\s\S]+FOR UPDATE/i,
    );
    expect(countParams).toEqual([42]);
  });

  it('throws EducationCapError when count exceeds the cap', async () => {
    const conn = {
      execute: vi.fn().mockResolvedValueOnce([
        [{ n: MAX_EDUCATION_ENTRIES + 1 }],
        [],
      ]),
    };
    withTransactionMock.mockImplementation(
      async (fn: (c: typeof conn) => Promise<unknown>) => fn(conn),
    );
    await expect(
      createEducation(42, VALID_INPUT),
    ).rejects.toThrow(EducationCapError);
  });

  it('inserts when count is one below the cap and returns the new record', async () => {
    const conn = {
      execute: vi
        .fn()
        // SELECT COUNT
        .mockResolvedValueOnce([[{ n: MAX_EDUCATION_ENTRIES - 1 }], []])
        // INSERT
        .mockResolvedValueOnce([makeHeader(1, 7), []])
        // SELECT inserted row
        .mockResolvedValueOnce([[rowFor({ id: 7 })], []]),
    };
    withTransactionMock.mockImplementation(
      async (fn: (c: typeof conn) => Promise<unknown>) => fn(conn),
    );

    const result = await createEducation(42, VALID_INPUT);
    expect(result.id).toBe(7);
    expect(conn.execute).toHaveBeenCalledTimes(3);

    // Verify the INSERT params order matches the column order documented
    // in the service (applicant_user_id first, booleans as 0/1).
    const [insertSql, insertParams] = conn.execute.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(insertSql).toMatch(/INSERT INTO applicant_education/i);
    expect(insertParams).toEqual([
      42,
      'Universitas Padjadjaran',
      'S1',
      'Computer Science',
      '2018-09-01',
      '2022-07-15',
      0,
      3.75,
    ]);
  });

  it('throws ZodError before opening a transaction on invalid input', async () => {
    await expect(
      createEducation(42, { ...VALID_INPUT, institution: '' }),
    ).rejects.toThrow(ZodError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateEducation — ownership / not-found
// ---------------------------------------------------------------------------

describe('updateEducation — ownership scoping', () => {
  it('UPDATE WHERE always carries applicant_user_id', async () => {
    queryMock
      .mockResolvedValueOnce(makeHeader(1)) // UPDATE
      .mockResolvedValueOnce([rowFor({ id: 5 })]); // re-read

    await updateEducation(42, 5, VALID_INPUT);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE applicant_education SET/i);
    expect(sql).toMatch(/WHERE id = \? AND applicant_user_id = \?/i);
    // last two params must be (id, userId) per the service.
    expect(params[params.length - 2]).toBe(5);
    expect(params[params.length - 1]).toBe(42);
  });

  it('throws EducationNotFoundError when no row matches (id, userId)', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(0));
    await expect(
      updateEducation(42, 999, VALID_INPUT),
    ).rejects.toThrow(EducationNotFoundError);
  });

  it('throws ZodError without issuing SQL when input is invalid', async () => {
    await expect(
      updateEducation(42, 5, { ...VALID_INPUT, gpa: 5 }),
    ).rejects.toThrow(ZodError);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteEducation — ownership / not-found
// ---------------------------------------------------------------------------

describe('deleteEducation — ownership scoping', () => {
  it('DELETE WHERE always carries applicant_user_id', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));
    await deleteEducation(42, 5);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /DELETE FROM applicant_education WHERE id = \? AND applicant_user_id = \?/i,
    );
    expect(params).toEqual([5, 42]);
  });

  it('throws EducationNotFoundError when nothing was deleted', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(0));
    await expect(deleteEducation(42, 999)).rejects.toThrow(
      EducationNotFoundError,
    );
  });
});
