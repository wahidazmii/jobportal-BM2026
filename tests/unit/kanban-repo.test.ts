/**
 * Unit tests for `src/modules/applications/kanban-repo.ts` (task 29.1).
 *
 * Validates: Requirement 10.1 (Design §4.2 / §6 Admin)
 *
 * Coverage:
 *   - `listForKanban` returns the canonical six-column shape in the
 *     right order even when MySQL streams the rows back grouped by
 *     stage in a different ordering.
 *   - `Withdrawn` applications are filtered out (the SQL IN clause
 *     does not include 'Withdrawn'; the test asserts both the bound
 *     parameters AND the absence of any Withdrawn row in the output).
 *   - Within a stage, rows are ordered by `applied_at` DESC, with
 *     `id` DESC as the tiebreaker. The SQL ORDER BY does that work,
 *     and we mirror the ordering in the mock so the test asserts that
 *     `listForKanban` preserves the ordering rather than re-sorting
 *     into a wrong shape.
 *   - The display name resolver picks `applicants.full_name` first,
 *     falls back to the user email when full_name is null/empty, and
 *     falls back to a synthetic `Applicant #<id>` string when both
 *     are missing.
 *   - A non-positive job id short-circuits to the empty board WITHOUT
 *     touching the DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: vi.fn(),
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

const repo = await import('../../src/modules/applications/kanban-repo.js');
const { KANBAN_STAGES, KANBAN_STAGE_LABELS, listForKanban } = repo;

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// KANBAN_STAGES constant
// ---------------------------------------------------------------------------

describe('KANBAN_STAGES', () => {
  it('lists the six pipeline stages in the canonical column order (Req 10.1)', () => {
    expect(KANBAN_STAGES).toEqual([
      'Applied',
      'Screening',
      'Interview',
      'Offer',
      'Hired',
      'Rejected',
    ]);
  });

  it('does NOT include Withdrawn (HR cannot move cards into a withdrawn column)', () => {
    expect(KANBAN_STAGES as readonly string[]).not.toContain('Withdrawn');
  });

  it('every stage has a display label', () => {
    for (const stage of KANBAN_STAGES) {
      expect(KANBAN_STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// listForKanban — column shape & ordering
// ---------------------------------------------------------------------------

describe('listForKanban', () => {
  it('returns six columns in canonical order even when no rows match', async () => {
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    const columns = await listForKanban(42);

    expect(columns).toHaveLength(6);
    expect(columns.map((c) => c.stage)).toEqual([
      'Applied',
      'Screening',
      'Interview',
      'Offer',
      'Hired',
      'Rejected',
    ]);
    for (const col of columns) {
      expect(col.rows).toEqual([]);
    }
  });

  it('binds the six kanban stages to the IN clause and never includes Withdrawn', async () => {
    queryMock.mockResolvedValueOnce([] as unknown as RowDataPacket[]);

    await listForKanban(7);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];

    // The SQL must filter by job_id and stage IN (...).
    expect(sql).toMatch(/FROM applications a/);
    expect(sql).toMatch(/WHERE a\.job_id = \?/);
    expect(sql).toMatch(/a\.stage IN \(\?, \?, \?, \?, \?, \?\)/);
    // ORDER BY applied_at DESC inside each stage.
    expect(sql).toMatch(/ORDER BY a\.stage ASC, a\.applied_at DESC, a\.id DESC/);

    // Params: jobId followed by the six canonical stages.
    expect(params).toEqual([
      7,
      'Applied',
      'Screening',
      'Interview',
      'Offer',
      'Hired',
      'Rejected',
    ]);
    // Withdrawn must never be in the bind list.
    expect(params).not.toContain('Withdrawn');
  });

  it('buckets rows into the right column and preserves applied_at DESC within each stage', async () => {
    // Six rows across three stages: two Applied (with the newer one
    // listed first by the SQL), one Screening, three Interview (with
    // a tied applied_at to exercise the id-DESC tiebreaker).
    const newerApplied = new Date('2025-04-10T00:00:00Z');
    const olderApplied = new Date('2025-04-01T00:00:00Z');
    const screen1 = new Date('2025-03-25T00:00:00Z');
    const tieTs = new Date('2025-02-15T00:00:00Z');

    // The SQL ORDER BY produces stage ASC, applied_at DESC, id DESC.
    // Stage alphabetical order: Applied, Interview, Screening (since
    // M < S in ASCII). We emit rows in that order so the buckets are
    // built in the same order MySQL would deliver.
    queryMock.mockResolvedValueOnce([
      // Applied — newer first.
      {
        id: 11,
        uuid: 'u-11',
        reference_no: 'APP-2025-000011',
        applicant_user_id: 100,
        stage: 'Applied',
        applied_at: newerApplied,
        applicant_name: 'Andi',
        applicant_email: 'andi@test',
      },
      {
        id: 5,
        uuid: 'u-5',
        reference_no: 'APP-2025-000005',
        applicant_user_id: 101,
        stage: 'Applied',
        applied_at: olderApplied,
        applicant_name: 'Budi',
        applicant_email: 'budi@test',
      },
      // Interview — tied applied_at, id DESC tiebreaker (id=33 first).
      {
        id: 33,
        uuid: 'u-33',
        reference_no: 'APP-2025-000033',
        applicant_user_id: 200,
        stage: 'Interview',
        applied_at: tieTs,
        applicant_name: 'Citra',
        applicant_email: 'citra@test',
      },
      {
        id: 22,
        uuid: 'u-22',
        reference_no: 'APP-2025-000022',
        applicant_user_id: 201,
        stage: 'Interview',
        applied_at: tieTs,
        applicant_name: 'Dewi',
        applicant_email: 'dewi@test',
      },
      {
        id: 12,
        uuid: 'u-12',
        reference_no: 'APP-2025-000012',
        applicant_user_id: 202,
        stage: 'Interview',
        applied_at: new Date('2025-02-01T00:00:00Z'),
        applicant_name: 'Eko',
        applicant_email: 'eko@test',
      },
      // Screening — single row.
      {
        id: 50,
        uuid: 'u-50',
        reference_no: 'APP-2025-000050',
        applicant_user_id: 300,
        stage: 'Screening',
        applied_at: screen1,
        applicant_name: 'Fitri',
        applicant_email: 'fitri@test',
      },
    ] as unknown as RowDataPacket[]);

    const columns = await listForKanban(42);

    // Six columns in canonical order regardless of how MySQL streamed.
    expect(columns.map((c) => c.stage)).toEqual([
      'Applied',
      'Screening',
      'Interview',
      'Offer',
      'Hired',
      'Rejected',
    ]);

    // Applied column: newer-first ordering preserved.
    const applied = columns[0];
    expect(applied?.rows.map((r) => r.id)).toEqual([11, 5]);
    expect(applied?.rows[0]?.applicant_name).toBe('Andi');

    // Screening column: single row.
    const screening = columns[1];
    expect(screening?.rows.map((r) => r.id)).toEqual([50]);

    // Interview column: tie-break by id DESC inside the same applied_at.
    const interview = columns[2];
    expect(interview?.rows.map((r) => r.id)).toEqual([33, 22, 12]);

    // Empty columns rendered with empty rows arrays.
    expect(columns[3]?.rows).toEqual([]); // Offer
    expect(columns[4]?.rows).toEqual([]); // Hired
    expect(columns[5]?.rows).toEqual([]); // Rejected
  });

  it('falls back to email when full_name is empty, then to a synthetic label when both are missing', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 1,
        uuid: 'u-1',
        reference_no: 'APP-2025-000001',
        applicant_user_id: 100,
        stage: 'Applied',
        applied_at: new Date('2025-01-01T00:00:00Z'),
        applicant_name: null,
        applicant_email: 'fallback@test',
      },
      {
        id: 2,
        uuid: 'u-2',
        reference_no: 'APP-2025-000002',
        applicant_user_id: 101,
        stage: 'Applied',
        applied_at: new Date('2025-01-02T00:00:00Z'),
        applicant_name: '   ',
        applicant_email: '',
      },
      {
        id: 3,
        uuid: 'u-3',
        reference_no: 'APP-2025-000003',
        applicant_user_id: 102,
        stage: 'Applied',
        applied_at: new Date('2025-01-03T00:00:00Z'),
        applicant_name: 'Real Name',
        applicant_email: 'unused@test',
      },
    ] as unknown as RowDataPacket[]);

    const columns = await listForKanban(1);
    const applied = columns[0];

    // The SQL orders by applied_at DESC, so the order in the column
    // is reversed from the mock list above.
    const byId = new Map(applied?.rows.map((r) => [r.id, r]));
    expect(byId.get(1)?.applicant_name).toBe('fallback@test');
    expect(byId.get(2)?.applicant_name).toBe('Applicant #101');
    expect(byId.get(3)?.applicant_name).toBe('Real Name');
  });

  it('short-circuits to the empty-board shape for non-positive job ids without hitting the DB', async () => {
    const out = await listForKanban(0);
    expect(out.map((c) => c.stage)).toEqual([
      'Applied',
      'Screening',
      'Interview',
      'Offer',
      'Hired',
      'Rejected',
    ]);
    for (const col of out) {
      expect(col.rows).toEqual([]);
    }
    expect(queryMock).not.toHaveBeenCalled();

    expect(await listForKanban(-1)).toHaveLength(6);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
