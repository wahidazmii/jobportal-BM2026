/**
 * Unit tests for Department_Head scoping in the applications read paths
 * (task 39.2).
 *
 * Validates: Requirements 11.4 (Design §14.2)
 *
 * Coverage:
 *   `applications/repo.ts` `findById(id, scope?)`:
 *     - In-scope row (job in an assigned department) → returns the row,
 *       and the SQL JOINs `job_postings` with
 *       `jp.department_id IN (?, ?)` bound to the assigned ids.
 *     - Out-of-scope row → returns null (the scoped query simply does
 *       not match; the repo collapses "missing" and "out of scope" into
 *       the same null).
 *     - Empty assignment set (`{ departments: [] }`) → returns null
 *       WITHOUT issuing any query.
 *     - No scope (`undefined`) → returns the row via the trivial PK
 *       lookup, with no `department_id` clause (HR / Super_Admin path).
 *     - Non-positive id → null without touching the DB.
 *
 *   `applications/kanban-repo.ts` `listForKanban(jobId, scope?)`:
 *     - With a scope, the board query gains
 *       `jp.department_id IN (?, ?)` and binds [jobId, ...stages,
 *       ...departments].
 *     - Empty assignment set → the canonical empty board WITHOUT a
 *       query.
 *     - No scope → the original unscoped query (no department clause).
 *
 * Both repos talk to MySQL via `query()` from `src/infra/db.ts`; we mock
 * that boundary so the suite stays hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: vi.fn(),
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Import after the mock is registered so the modules pick up the double.
const appRepo = await import('../../src/modules/applications/repo.js');
const kanbanRepo = await import('../../src/modules/applications/kanban-repo.js');

const { findById } = appRepo;
const { listForKanban, KANBAN_STAGES } = kanbanRepo;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A canonical `applications` row as mysql2 would return it. */
function appRow(
  overrides: Partial<{
    id: number;
    uuid: string;
    reference_no: string;
    applicant_user_id: number;
    job_id: number;
    cv_file_id: number;
    stage: string;
    source: string;
    applied_at: Date;
    updated_at: Date;
    hired_at: Date | null;
  }> = {},
): RowDataPacket {
  return {
    id: overrides.id ?? 100,
    uuid: overrides.uuid ?? '11111111-1111-1111-1111-111111111111',
    reference_no: overrides.reference_no ?? 'APP-2026-000100',
    applicant_user_id: overrides.applicant_user_id ?? 7,
    job_id: overrides.job_id ?? 55,
    cv_file_id: overrides.cv_file_id ?? 9,
    stage: overrides.stage ?? 'Applied',
    source: overrides.source ?? 'direct',
    applied_at: overrides.applied_at ?? new Date('2026-01-10T08:00:00Z'),
    updated_at: overrides.updated_at ?? new Date('2026-01-10T08:00:00Z'),
    hired_at: overrides.hired_at ?? null,
  } as unknown as RowDataPacket;
}

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// findById — Department_Head scope
// ---------------------------------------------------------------------------

describe('applications.findById — Department_Head scope', () => {
  it('returns the row when the owning job is in an assigned department', async () => {
    // The scoped SQL only returns the row when the JOIN + IN clause
    // matched, so a single returned row IS the in-scope case.
    queryMock.mockResolvedValueOnce([appRow({ id: 100, job_id: 55 })]);

    const out = await findById(100, { departments: [3, 7] });

    expect(out).not.toBeNull();
    expect(out?.id).toBe(100);
    expect(out?.job_id).toBe(55);

    // One query, and it JOINs job_postings with a 2-slot IN clause.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INNER JOIN job_postings jp ON jp\.id = a\.job_id/i);
    expect(sql).toMatch(/department_id IN \(\?, \?\)/i);
    // Bound params: the application id first, then the department ids.
    expect(params).toEqual([100, 3, 7]);
  });

  it('returns null when the owning job is outside the assigned departments', async () => {
    // The scoped query for an out-of-scope row matches nothing.
    queryMock.mockResolvedValueOnce([]);

    const out = await findById(100, { departments: [3, 7] });

    expect(out).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/department_id IN \(\?, \?\)/i);
    expect(params).toEqual([100, 3, 7]);
  });

  it('returns null WITHOUT hitting the DB when the assignment set is empty', async () => {
    const out = await findById(100, { departments: [] });

    expect(out).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns the row regardless of department when no scope is supplied (HR / Super_Admin)', async () => {
    queryMock.mockResolvedValueOnce([appRow({ id: 100, job_id: 55 })]);

    const out = await findById(100);

    expect(out).not.toBeNull();
    expect(out?.id).toBe(100);

    // The unscoped path uses the trivial PK lookup — no department clause.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/department_id IN/i);
    expect(sql).not.toMatch(/INNER JOIN job_postings/i);
    expect(params).toEqual([100]);
  });

  it('binds department_id IN (?, ?, ?) with all assigned ids when scoped to three departments', async () => {
    queryMock.mockResolvedValueOnce([appRow({ id: 100, job_id: 55 })]);

    await findById(100, { departments: [3, 7, 12] });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/department_id IN \(\?, \?, \?\)/i);
    expect(params).toEqual([100, 3, 7, 12]);
  });

  it('returns null WITHOUT hitting the DB for non-positive ids', async () => {
    expect(await findById(0, { departments: [3] })).toBeNull();
    expect(await findById(-1)).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listForKanban — Department_Head scope
// ---------------------------------------------------------------------------

describe('listForKanban — Department_Head scope', () => {
  it('injects jp.department_id IN (?, ?) and binds [jobId, ...stages, ...departments]', async () => {
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    await listForKanban(55, { departments: [3, 7] });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INNER JOIN job_postings jp ON jp\.id = a\.job_id/i);
    expect(sql).toMatch(/department_id IN \(\?, \?\)/i);
    // jobId, then the six kanban stages, then the two department ids.
    expect(params).toEqual([55, ...KANBAN_STAGES, 3, 7]);
  });

  it('returns the canonical empty board WITHOUT a query for an empty assignment set', async () => {
    const out = await listForKanban(55, { departments: [] });

    expect(out).toHaveLength(6);
    expect(out.map((c) => c.stage)).toEqual([...KANBAN_STAGES]);
    for (const col of out) expect(col.rows).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('runs the unscoped board query (no department clause) when no scope is supplied', async () => {
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    await listForKanban(55);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/department_id IN/i);
    expect(sql).not.toMatch(/INNER JOIN job_postings/i);
    expect(params).toEqual([55, ...KANBAN_STAGES]);
  });
});
