/**
 * Unit tests for `src/modules/mail/service.ts` (task 36.1 — mail enqueue).
 *
 * Validates: Requirements 8.3 (Design §12.3 — transactional, idempotent
 * enqueue + DB-override / file-system-default template merge pipeline).
 *
 * Coverage:
 *   1. DB template + targetId → renders placeholders and issues
 *      `INSERT IGNORE` carrying the rendered subject/body and the natural
 *      key `(template_key, target_id)`.
 *   2. targetId = null → plain `INSERT` (no IGNORE dedupe).
 *   3. DB template missing but file-system default present → renders the
 *      file-system template.
 *   4. Neither DB nor file-system template present → throws
 *      `MailTemplateMissingError`.
 *   5. Context placeholders are interpolated into the rendered output.
 *
 * Boundaries mocked:
 *   - `node:fs/promises`     — `readFile` feeds the file-system defaults
 *     so the merge pipeline's fallback branch is exercised without real
 *     files on disk.
 *   - `src/infra/logger.ts`  — silence the structured log line.
 *   - The transaction `connection` is a fake whose `execute` we program
 *     per call (SELECT `mail_templates`, then INSERT `mail_outbox`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

vi.mock('../../src/infra/logger.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/infra/logger.js')
  >('../../src/infra/logger.js');
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    },
  };
});

// Import after the mocks register.
const serviceModule = await import('../../src/modules/mail/service.js');
const { enqueue, MailTemplateMissingError } = serviceModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an ENOENT error so `readFile` mimics a missing file. */
function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** A fake `ResultSetHeader` with a chosen affectedRows. */
function header(affectedRows = 1): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId: 1,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

/** Construct a fake `PoolConnection` whose `execute` we program per call. */
function createFakeConnection() {
  const executeMock = vi.fn();
  const connection = { execute: executeMock } as unknown as Parameters<
    typeof enqueue
  >[0];
  return { connection, executeMock };
}

/**
 * Program the connection so the `mail_templates` SELECT returns the given
 * row and the `mail_outbox` INSERT returns a header. Pass `null` for
 * `templateRow` to simulate "no DB override".
 */
function programConnection(
  executeMock: ReturnType<typeof vi.fn>,
  templateRow: Record<string, unknown> | null,
  affectedRows = 1,
): void {
  executeMock.mockImplementation(async (sql: string) => {
    if (/FROM mail_templates/i.test(sql)) {
      const rows = templateRow === null ? [] : [templateRow as RowDataPacket];
      return [rows, []];
    }
    if (/INTO mail_outbox/i.test(sql)) {
      return [header(affectedRows), []];
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  });
}

/** A DB `mail_templates` row using every placeholder channel. */
function dbTemplateRow(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'Verify {{ name }}',
    body_html: '<p>Hi {{ name }}, your code is {{ code }}.</p>',
    body_text: 'Hi {{ name }}, code: {{ code }}.',
    ...overrides,
  };
}

beforeEach(() => {
  readFileMock.mockReset();
  // Default: no file-system templates exist unless a test provides them.
  readFileMock.mockRejectedValue(enoent());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. DB template + targetId → INSERT IGNORE with the natural key
// ---------------------------------------------------------------------------

describe('enqueue — DB template with targetId (idempotent)', () => {
  it('renders placeholders and issues INSERT IGNORE keyed on (template_key, target_id)', async () => {
    const { connection, executeMock } = createFakeConnection();
    programConnection(executeMock, dbTemplateRow());

    await enqueue(connection, {
      templateKey: 'verify',
      toEmail: 'user@example.com',
      toName: 'Budi',
      locale: 'id',
      targetId: '101',
      context: { name: 'Budi', code: 'ABC123' },
    });

    // SELECT mail_templates first, then INSERT mail_outbox.
    expect(executeMock).toHaveBeenCalledTimes(2);

    const [selectSql, selectParams] = executeMock.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(selectSql).toMatch(/FROM mail_templates/i);
    // `key` is a reserved word — must be backtick-quoted and parameterised.
    expect(selectSql).toMatch(/`key` = \? AND locale = \?/i);
    expect(selectParams).toEqual(['verify', 'id']);

    const [insertSql, insertParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    // Idempotent insert keyed on the natural key.
    expect(insertSql).toMatch(/INSERT IGNORE INTO mail_outbox/i);

    // Params: template_key, target_id, to_email, to_name, subject,
    // body_html, body_text, context.
    expect(insertParams[0]).toBe('verify');
    expect(insertParams[1]).toBe('101');
    expect(insertParams[2]).toBe('user@example.com');
    expect(insertParams[3]).toBe('Budi');
    // Rendered subject + bodies carry the interpolated context.
    expect(insertParams[4]).toBe('Verify Budi');
    expect(insertParams[5]).toBe('<p>Hi Budi, your code is ABC123.</p>');
    expect(insertParams[6]).toBe('Hi Budi, code: ABC123.');
    // Context persisted as JSON.
    expect(JSON.parse(insertParams[7] as string)).toEqual({
      name: 'Budi',
      code: 'ABC123',
    });
  });

  it('treats an INSERT IGNORE no-op (affectedRows=0) as a deduped retry, not an error', async () => {
    const { connection, executeMock } = createFakeConnection();
    programConnection(executeMock, dbTemplateRow(), /* affectedRows */ 0);

    await expect(
      enqueue(connection, {
        templateKey: 'verify',
        toEmail: 'user@example.com',
        targetId: '101',
        context: { name: 'Budi', code: 'ABC123' },
      }),
    ).resolves.toBeUndefined();

    expect(executeMock.mock.calls[1]![0]).toMatch(
      /INSERT IGNORE INTO mail_outbox/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. targetId = null → plain INSERT (no dedupe)
// ---------------------------------------------------------------------------

describe('enqueue — targetId null (newsletter-style)', () => {
  it('issues a plain INSERT (no IGNORE) and stores a NULL target_id', async () => {
    const { connection, executeMock } = createFakeConnection();
    programConnection(executeMock, dbTemplateRow());

    await enqueue(connection, {
      templateKey: 'alert_digest',
      toEmail: 'user@example.com',
      // targetId omitted → null
      context: { name: 'Budi', code: 'X' },
    });

    const [insertSql, insertParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(insertSql).toMatch(/INSERT INTO mail_outbox/i);
    expect(insertSql).not.toMatch(/INSERT IGNORE/i);
    // target_id is NULL for the non-deduped path.
    expect(insertParams[1]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. DB missing, file-system default present
// ---------------------------------------------------------------------------

describe('enqueue — file-system default fallback', () => {
  it('uses the file-system template when no DB override exists', async () => {
    const { connection, executeMock } = createFakeConnection();
    // No DB override.
    programConnection(executeMock, null);
    // File-system defaults: subject + html present, text absent (ENOENT).
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('reset.subject.njk')) return 'Reset for {{ name }}';
      if (filePath.endsWith('reset.html.njk')) {
        return '<p>Reset link for {{ name }}: {{ link }}</p>';
      }
      throw enoent();
    });

    await enqueue(connection, {
      templateKey: 'reset',
      toEmail: 'user@example.com',
      targetId: '55',
      context: { name: 'Sari', link: 'https://x/y' },
    });

    const [insertSql, insertParams] = executeMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(insertSql).toMatch(/INSERT IGNORE INTO mail_outbox/i);
    // Rendered from the file-system template.
    expect(insertParams[4]).toBe('Reset for Sari');
    expect(insertParams[5]).toBe('<p>Reset link for Sari: https://x/y</p>');
    // body_text absent on disk → derived plaintext fallback from the HTML.
    expect(insertParams[6]).toBe('Reset link for Sari: https://x/y');
  });
});

// ---------------------------------------------------------------------------
// 4. Neither template present → throws
// ---------------------------------------------------------------------------

describe('enqueue — no template anywhere', () => {
  it('throws MailTemplateMissingError when DB and file-system both miss', async () => {
    const { connection, executeMock } = createFakeConnection();
    programConnection(executeMock, null);
    // readFileMock already rejects ENOENT for every channel (beforeEach).

    const error = await enqueue(connection, {
      templateKey: 'ghost',
      toEmail: 'user@example.com',
      targetId: '1',
      context: {},
    }).then(
      () => {
        throw new Error('expected enqueue to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(MailTemplateMissingError);
    const missing = error as InstanceType<typeof MailTemplateMissingError>;
    expect(missing.code).toBe('mail_template_missing');
    expect(missing.templateKey).toBe('ghost');
    // The outbox INSERT never ran.
    const insertCalls = executeMock.mock.calls.filter((c) =>
      /INTO mail_outbox/i.test(c[0] as string),
    );
    expect(insertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Context interpolation
// ---------------------------------------------------------------------------

describe('enqueue — context interpolation', () => {
  it('interpolates context values into the rendered subject and body', async () => {
    const { connection, executeMock } = createFakeConnection();
    programConnection(
      executeMock,
      dbTemplateRow({
        subject: 'Hello {{ first }} {{ last }}',
        body_html: '<p>Token: {{ token }}</p>',
        body_text: 'Token={{ token }}',
      }),
    );

    await enqueue(connection, {
      templateKey: 'verify',
      toEmail: 'user@example.com',
      targetId: '7',
      context: { first: 'Ada', last: 'Lovelace', token: 'zzz999' },
    });

    const insertParams = executeMock.mock.calls[1]![1] as unknown[];
    expect(insertParams[4]).toBe('Hello Ada Lovelace');
    expect(insertParams[5]).toBe('<p>Token: zzz999</p>');
    expect(insertParams[6]).toBe('Token=zzz999');
  });
});
