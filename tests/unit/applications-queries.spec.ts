/**
 * Unit tests for `src/modules/applications/queries.ts` (task 27.1).
 *
 * Validates: Requirements 5.6, 5.7 (Design §6 Applicant_Area)
 *
 * Coverage:
 *   - `listForApplicant`:
 *       * filters by applicant_user_id and orders by `applied_at DESC`;
 *       * returns the requested-locale translation when present.
 *       * falls back to the OTHER locale via the
 *         `COALESCE(primary, fallback)` pattern when the requested
 *         locale's translation row is missing.
 *   - `findOneForApplicant`:
 *       * returns null when the application id exists but is owned by
 *         a different applicant (no row leak);
 *       * populates `stageHistory` ordered ASC and excludes notes with
 *         `visible_to_applicant = 0` (the SQL filter is asserted on
 *         the parameter list).
 *
 * The service talks to MySQL via `query()` from `src/infra/db.ts`; we
 * mock that boundary so the suite stays hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: vi.fn(),
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Import after the mock is registered.
const queriesModule = await import('../../src/modules/applications/queries.js');
const { listForApplicant, findOneForApplicant } = queriesModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPLICANT_ID = 42;
const OTHER_APPLICANT_ID = 99;

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  queryMock.mockReset();
});

// ---------------------------------------------------------------------------
// listForApplicant
// ---------------------------------------------------------------------------

describe('listForApplicant', () => {
  it('filters by applicant_user_id, orders by applied_at DESC, and returns the requested-locale translation', async () => {
    // 1. COUNT(*) → 2 rows total.
    queryMock.mockResolvedValueOnce([{ n: 2 } as unknown as RowDataPacket]);

    // 2. Page query → two rows with the `id` translation present.
    const newer = new Date('2025-03-01T00:00:00.000Z');
    const older = new Date('2025-01-15T00:00:00.000Z');
    queryMock.mockResolvedValueOnce([
      {
        id: 11,
        uuid: 'uuid-newer',
        reference_no: 'APP-2025-000011',
        job_id: 5,
        job_slug: 'senior-fe-engineer',
        job_location: 'Jakarta',
        stage: 'Applied',
        applied_at: newer,
        hired_at: null,
        job_title: 'Insinyur Senior',
      },
      {
        id: 7,
        uuid: 'uuid-older',
        reference_no: 'APP-2025-000007',
        job_id: 4,
        job_slug: 'junior-be',
        job_location: 'Bandung',
        stage: 'Hired',
        applied_at: older,
        hired_at: new Date('2025-02-01T00:00:00.000Z'),
        job_title: 'Insinyur Junior',
      },
    ] as unknown as RowDataPacket[]);

    const result = await listForApplicant(APPLICANT_ID, { locale: 'id' });

    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.id).toBe(11);
    expect(result.rows[1]?.id).toBe(7);
    // Newer first.
    expect(result.rows[0]?.appliedAt.getTime()).toBeGreaterThan(
      result.rows[1]?.appliedAt.getTime() ?? 0,
    );
    // Translation comes from the requested locale.
    expect(result.rows[0]?.jobTitle).toBe('Insinyur Senior');

    // The COUNT query is scoped to the applicant.
    const [countSql, countParams] = queryMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(countSql).toMatch(
      /SELECT COUNT\(\*\)\s+AS n FROM applications WHERE applicant_user_id = \?/i,
    );
    expect(countParams).toEqual([APPLICANT_ID]);

    // The page query is scoped + ordered + paginated.
    const [pageSql, pageParams] = queryMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(pageSql).toMatch(/FROM applications a/);
    expect(pageSql).toMatch(/WHERE a\.applicant_user_id = \?/);
    expect(pageSql).toMatch(/ORDER BY a\.applied_at DESC/);
    expect(pageSql).toMatch(/LIMIT \? OFFSET \?/);
    // The COALESCE order encodes "preferred locale wins".
    expect(pageSql).toMatch(/COALESCE\(tp\.title, tf\.title\)/);
    // Params: primary, fallback, applicantId, pageSize, offset.
    expect(pageParams).toEqual(['id', 'en', APPLICANT_ID, 20, 0]);
  });

  it('falls back to the other locale when the requested locale translation is missing', async () => {
    // 1. COUNT(*) → 1 row.
    queryMock.mockResolvedValueOnce([{ n: 1 } as unknown as RowDataPacket]);

    // 2. Page query — the SQL `COALESCE(tp.title, tf.title)` already
    // resolves to the fallback when `tp.title IS NULL` (the requested
    // locale's translation row is missing). The driver delivers the
    // already-coalesced value as `job_title`. To exercise the fallback
    // wiring we send the English title (the fallback row) through.
    queryMock.mockResolvedValueOnce([
      {
        id: 21,
        uuid: 'uuid-en-only',
        reference_no: 'APP-2025-000021',
        job_id: 9,
        job_slug: 'product-manager',
        job_location: 'Remote',
        stage: 'Screening',
        applied_at: new Date('2025-04-01T00:00:00.000Z'),
        hired_at: null,
        // Only the English translation exists in DB; COALESCE picks it
        // up as the value of `job_title` even though `id` was requested.
        job_title: 'Product Manager',
      },
    ] as unknown as RowDataPacket[]);

    const result = await listForApplicant(APPLICANT_ID, { locale: 'id' });

    expect(result.rows[0]?.jobTitle).toBe('Product Manager');

    // Confirm the SQL passes BOTH locales (primary + fallback) so the
    // fallback row is even available to the COALESCE.
    const [, pageParams] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(pageParams[0]).toBe('id'); // primary
    expect(pageParams[1]).toBe('en'); // fallback
  });

  it('uses en as primary and id as fallback when locale=en is requested', async () => {
    queryMock.mockResolvedValueOnce([{ n: 0 } as unknown as RowDataPacket]);
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    await listForApplicant(APPLICANT_ID, { locale: 'en' });

    const [, pageParams] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(pageParams[0]).toBe('en');
    expect(pageParams[1]).toBe('id');
  });
});

// ---------------------------------------------------------------------------
// findOneForApplicant
// ---------------------------------------------------------------------------

describe('findOneForApplicant', () => {
  it('returns null when the application id exists but is owned by another applicant', async () => {
    // The owner-scoped SELECT returns no rows because the WHERE clause
    // matches both id AND applicant_user_id. We DO NOT issue the
    // history / notes follow-up queries when the row is missing — the
    // service short-circuits with `null`.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    const result = await findOneForApplicant(APPLICANT_ID, 777, {
      locale: 'id',
    });

    expect(result).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE a\.id = \? AND a\.applicant_user_id = \?/i);
    // Params: primary, fallback, applicationId, applicantId.
    expect(params).toEqual(['id', 'en', 777, APPLICANT_ID]);
  });

  it('does not leak existence: a row owned by a different user is indistinguishable from a missing row', async () => {
    // Even if the route handler called `findOneForApplicant(other, id)`
    // the WHERE clause still requires the applicant id to match — so
    // a different applicant CANNOT pull the row.
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);
    const result = await findOneForApplicant(OTHER_APPLICANT_ID, 777, {
      locale: 'id',
    });
    expect(result).toBeNull();
  });

  it('populates stageHistory ordered ASC and excludes invisible notes via SQL filter', async () => {
    const appliedAt = new Date('2025-01-01T00:00:00.000Z');

    // 1. Application row (owner-scoped).
    queryMock.mockResolvedValueOnce([
      {
        id: 100,
        uuid: 'uuid-100',
        reference_no: 'APP-2025-000100',
        job_id: 5,
        job_slug: 'senior-fe-engineer',
        job_location: 'Jakarta',
        stage: 'Interview',
        applied_at: appliedAt,
        hired_at: null,
        job_title: 'Senior FE Engineer',
      },
    ] as unknown as RowDataPacket[]);

    // 2. Stage history (mysql2 returns the rows in the order the
    // `ORDER BY changed_at ASC` clause asked for; the service should
    // preserve that order without re-sorting).
    const t1 = new Date('2025-01-01T00:00:00.000Z');
    const t2 = new Date('2025-01-08T00:00:00.000Z');
    const t3 = new Date('2025-01-15T00:00:00.000Z');
    queryMock.mockResolvedValueOnce([
      {
        id: 1,
        prev_stage: null,
        new_stage: 'Applied',
        changed_by: null,
        changed_at: t1,
      },
      {
        id: 2,
        prev_stage: 'Applied',
        new_stage: 'Screening',
        changed_by: 50,
        changed_at: t2,
      },
      {
        id: 3,
        prev_stage: 'Screening',
        new_stage: 'Interview',
        changed_by: 50,
        changed_at: t3,
      },
    ] as unknown as RowDataPacket[]);

    // 3. Notes (only visible_to_applicant=1 rows; the SQL WHERE clause
    // filters; we mirror the DB behaviour by returning ONLY visible
    // rows here and assert the WHERE clause carries the predicate).
    queryMock.mockResolvedValueOnce([
      {
        id: 11,
        author_user_id: 50,
        body: 'Looking forward to chatting.',
        created_at: t2,
        author_email: 'hr@buanamegah.test',
      },
    ] as unknown as RowDataPacket[]);

    const result = await findOneForApplicant(APPLICANT_ID, 100, {
      locale: 'id',
    });

    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.id).toBe(100);
    expect(result.referenceNo).toBe('APP-2025-000100');
    expect(result.jobTitle).toBe('Senior FE Engineer');

    // Timeline: chronological order preserved.
    expect(result.stageHistory.map((h) => h.id)).toEqual([1, 2, 3]);
    expect(result.stageHistory[0]?.prevStage).toBeNull();
    expect(result.stageHistory[0]?.newStage).toBe('Applied');
    expect(result.stageHistory[2]?.newStage).toBe('Interview');
    // The system-generated row carries no actor.
    expect(result.stageHistory[0]?.changedBy).toBeNull();
    expect(result.stageHistory[1]?.changedBy).toBe(50);

    // Confirm timestamps come back as Date objects in ASC order.
    for (let i = 1; i < result.stageHistory.length; i += 1) {
      const prevTs = result.stageHistory[i - 1]?.changedAt.getTime() ?? 0;
      const currTs = result.stageHistory[i]?.changedAt.getTime() ?? 0;
      expect(currTs).toBeGreaterThanOrEqual(prevTs);
    }

    // Notes: the SQL filter excludes invisible rows. Verify the WHERE
    // clause is the right shape — this is the only place the service
    // can guarantee internal-only notes never leak (Req 5.7).
    const [notesSql, notesParams] = queryMock.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(notesSql).toMatch(/FROM application_notes/);
    expect(notesSql).toMatch(/WHERE n\.application_id = \?/i);
    expect(notesSql).toMatch(/AND n\.visible_to_applicant = 1/i);
    expect(notesSql).toMatch(/ORDER BY n\.created_at ASC/i);
    expect(notesParams).toEqual([100]);

    // The single returned note round-trips body + author label.
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.body).toBe('Looking forward to chatting.');
    expect(result.notes[0]?.authorName).toBe('hr@buanamegah.test');
  });

  it('falls back to a generic author label when the email column is null', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 100,
        uuid: 'uuid-100',
        reference_no: 'APP-2025-000100',
        job_id: 5,
        job_slug: 'fe',
        job_location: 'Jakarta',
        stage: 'Applied',
        applied_at: new Date('2025-01-01T00:00:00.000Z'),
        hired_at: null,
        job_title: 'FE',
      },
    ] as unknown as RowDataPacket[]);
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);
    queryMock.mockResolvedValueOnce([
      {
        id: 11,
        author_user_id: 50,
        body: 'Anonymous note',
        created_at: new Date('2025-01-02T00:00:00.000Z'),
        author_email: null,
      },
    ] as unknown as RowDataPacket[]);

    const result = await findOneForApplicant(APPLICANT_ID, 100, {
      locale: 'id',
    });

    expect(result).not.toBeNull();
    expect(result?.notes[0]?.authorName).toBe('PT Buana Megah');
  });
});
