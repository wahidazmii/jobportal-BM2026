/**
 * Unit tests for `src/modules/audit/writer.ts` (task 40.1).
 *
 * Validates: Requirements 12.1, 12.2 (Design §15 — Audit Log)
 *
 * Coverage:
 *   1. `write` with all fields → one INSERT INTO audit_events with the
 *      column params in the documented order; `details` JSON-stringified.
 *   2. `write` with a transaction `conn` → the INSERT runs on
 *      `conn.execute`, NOT on the pool `query` (so the audit row commits
 *      atomically with the surrounding domain change — Req 12.1).
 *   3. `write` with null/omitted actor, ip, target, and details → those
 *      params bind as SQL NULL.
 *   4. `occurred_at` is NEVER set from JS — the INSERT column list and the
 *      bound params do not mention it (the DB default CURRENT_TIMESTAMP(3)
 *      stamps it). The param tuple has exactly six entries.
 *   5. `ACTION_TYPES` covers the design §15 taxonomy, and the
 *      `auditService` / `writeAudit` aliases delegate to `write`.
 *
 * The writer talks to MySQL only through `query` (pool path) or a caller
 * supplied `conn.execute` (transaction path); both are faked so the test
 * is hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: vi.fn(),
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Import after the mock registers.
const writerModule = await import('../../src/modules/audit/writer.js');
const { write, writeAudit, auditService, ACTION_TYPES } = writerModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake `ResultSetHeader` for an INSERT. */
function makeHeader(insertId = 1): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows: 1,
    insertId,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue(makeHeader());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. All fields → INSERT with correct params, details JSON-stringified
// ---------------------------------------------------------------------------

describe('write — all fields (pool path)', () => {
  it('issues one INSERT INTO audit_events with the documented param order', async () => {
    await write({
      actorUserId: 7,
      actorIp: '203.0.113.9',
      actionType: 'application_stage_change',
      targetEntity: 'application',
      targetId: 555,
      details: { prev_stage: 'Applied', new_stage: 'Screening' },
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0]!;

    // INSERT-only.
    expect(sql).toMatch(/^INSERT INTO audit_events/);
    expect(sql).not.toMatch(/UPDATE|DELETE/);

    // (actor_user_id, actor_ip, action_type, target_entity, target_id, details)
    expect(params).toEqual([
      7,
      '203.0.113.9',
      'application_stage_change',
      'application',
      555,
      JSON.stringify({ prev_stage: 'Applied', new_stage: 'Screening' }),
    ]);

    // details is a JSON string, not a raw object.
    expect(typeof (params as unknown[])[5]).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 2. Transaction conn → runs on conn.execute, not the pool query
// ---------------------------------------------------------------------------

describe('write — transaction connection (Req 12.1)', () => {
  it('runs the INSERT on conn.execute and never touches the pool query', async () => {
    const execute = vi.fn().mockResolvedValue([makeHeader(), []]);
    const conn = { execute } as never;

    await write(
      {
        actorUserId: 7,
        actionType: 'application_stage_change',
        targetEntity: 'application',
        targetId: 555,
        details: { reason: 'looks good' },
      },
      conn,
    );

    // Ran on the transaction connection ...
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0]!;
    expect(sql).toMatch(/^INSERT INTO audit_events/);
    expect((params as unknown[])[2]).toBe('application_stage_change');

    // ... and NOT on the shared pool.
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Null / omitted optional fields → NULLs bound
// ---------------------------------------------------------------------------

describe('write — null/omitted optional fields', () => {
  it('binds NULL for omitted actor, ip, target, and details', async () => {
    await write({
      actionType: 'config_change',
      targetEntity: 'config',
    });

    const [, params] = queryMock.mock.calls[0]!;
    expect(params).toEqual([null, null, 'config_change', 'config', null, null]);
  });

  it('binds NULL when actor/target/details are explicitly null', async () => {
    await write({
      actorUserId: null,
      actorIp: null,
      actionType: 'login_failure',
      targetEntity: 'user',
      targetId: null,
      details: null,
    });

    const [, params] = queryMock.mock.calls[0]!;
    expect(params).toEqual([null, null, 'login_failure', 'user', null, null]);
  });
});

// ---------------------------------------------------------------------------
// 4. occurred_at is DB-authoritative (never set from JS)
// ---------------------------------------------------------------------------

describe('write — occurred_at is DB-authoritative', () => {
  it('omits occurred_at from the column list and binds exactly six params', async () => {
    await write({
      actorUserId: 7,
      actionType: 'data_export',
      targetEntity: 'application',
      targetId: 42,
      details: { rows: 1234, job_id: 9 },
    });

    const [sql, params] = queryMock.mock.calls[0]!;

    // The INSERT does not mention occurred_at — the DB default
    // CURRENT_TIMESTAMP(3) stamps it.
    expect(sql).not.toMatch(/occurred_at/);

    // Exactly six bound parameters (no timestamp slot).
    expect(params as unknown[]).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 5. Taxonomy + aliases
// ---------------------------------------------------------------------------

describe('ACTION_TYPES taxonomy + aliases', () => {
  it('covers the design §15 named actions (Req 12.1)', () => {
    const required = [
      'login_success',
      'login_failure',
      'password_reset_request',
      'password_change',
      'role_change',
      'job_create',
      'job_publish',
      'job_unpublish',
      'application_stage_change',
      'data_export',
      'mail_template_change',
      'config_change',
    ];
    for (const action of required) {
      expect(ACTION_TYPES as readonly string[]).toContain(action);
    }
  });

  it('exposes writeAudit and auditService.write as the same writer', async () => {
    expect(writeAudit).toBe(write);
    expect(auditService.write).toBe(write);

    await auditService.write({
      actionType: 'mail_template_change',
      targetEntity: 'mail_template',
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
