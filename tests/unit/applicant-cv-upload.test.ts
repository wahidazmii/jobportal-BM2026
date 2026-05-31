/**
 * Unit tests for the CV upload pipeline (task 17.1).
 *
 * Validates: Requirements 4.5, 4.6, 4.7, 4.8, 15.5 (Design §9)
 *
 * The pipeline crosses several boundaries — multipart stream, fs,
 * file-type magic-byte sniffer, db transaction. We mock each one so
 * the suite stays hermetic and focuses on the orchestration logic
 * (sequence of calls, error mapping, prune semantics).
 *
 * Coverage:
 *   - Happy path: streams the bytes through the limiter, accepts a
 *     PDF magic match, renames into `cv/yyyy/mm/<uuid>.pdf`, INSERTs
 *     a row, deactivates older rows, returns the fresh record.
 *   - Oversize input → throws `FileTooLargeError` (413), no DB write,
 *     temp file is unlinked.
 *   - Bad MIME (declared OK but magic bytes mismatch) → throws
 *     `MimeMismatchError` (415), no DB write, temp file is unlinked.
 *   - Insufficient storage → throws `InsufficientStorageError` (507)
 *     before any disk I/O.
 *   - 4th upload triggers retention prune: `MAX_CV_HISTORY` rows kept,
 *     the oldest row is DELETEd and its file unlinked.
 *
 * Module-level constants asserted against the canonical values used
 * elsewhere in the route layer / property tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

// `node:fs/promises` — open / rename / stat / unlink
const openMock = vi.fn();
const renameMock = vi.fn().mockResolvedValue(undefined);
const statMock = vi.fn();
const unlinkMock = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<
    typeof import('node:fs/promises')
  >('node:fs/promises');
  return {
    ...actual,
    open: openMock,
    rename: renameMock,
    stat: statMock,
    unlink: unlinkMock,
  };
});

// `node:fs` — createWriteStream
const writeStreamMock = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    createWriteStream: writeStreamMock,
  };
});

// `file-type` — fileTypeFromBuffer
const fileTypeMock = vi.fn();
vi.mock('file-type', () => ({
  fileTypeFromBuffer: fileTypeMock,
}));

// `disk` infra — quota guard, paths, dir helpers, safeUnlink
const assertFreeSpaceMock = vi.fn();
const cvPathMock = vi.fn();
const cvAbsolutePathMock = vi.fn();
const ensureCvDirMock = vi.fn();
const ensureDirMock = vi.fn();
const tmpUploadPathMock = vi.fn();
const safeUnlinkMock = vi.fn().mockResolvedValue(true);

class FakeInsufficientStorageError extends Error {
  public readonly statusCode = 507;
  public readonly freeBytes: number;
  public readonly minBytes: number;
  constructor(freeBytes: number, minBytes: number) {
    super('insufficient storage');
    this.name = 'InsufficientStorageError';
    this.freeBytes = freeBytes;
    this.minBytes = minBytes;
  }
}

vi.mock('../../src/infra/disk.js', () => ({
  assertFreeSpace: assertFreeSpaceMock,
  cvPath: cvPathMock,
  cvAbsolutePath: cvAbsolutePathMock,
  ensureCvDir: ensureCvDirMock,
  ensureDir: ensureDirMock,
  tmpUploadPath: tmpUploadPathMock,
  safeUnlink: safeUnlinkMock,
  InsufficientStorageError: FakeInsufficientStorageError,
}));

// `db` infra — query + withTransaction
const queryMock = vi.fn();
const withTransactionMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
  pool: { end: vi.fn().mockResolvedValue(undefined) },
}));

// Logger — silence
vi.mock('../../src/infra/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  genReqId: () => 'test',
  requestSerializers: {},
}));

// Import after mocks are registered.
const cvModule = await import('../../src/modules/applicant/cv.js');
const {
  ALLOWED_CV_MIMES,
  FileTooLargeError,
  MAX_CV_BYTES,
  MAX_CV_HISTORY,
  MIME_TO_EXT,
  MimeMismatchError,
  listCvsForOwner,
  processCvUpload,
} = cvModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake `WriteStream`-shaped object that consumes a Readable
 * and tracks the bytes written. Implemented as a Writable so
 * `pipeline()` treats it like a real stream end-point without any
 * real file descriptor.
 */
function makeFakeWriter() {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  Object.assign(w, { path: '/tmp/fake' });
  return Object.assign(w, {
    chunks,
    totalBytes: () => chunks.reduce((n, b) => n + b.length, 0),
  });
}

/**
 * Build a `MultipartFile`-like input from a Buffer of bytes.
 */
function makeMultipart(
  bytes: Buffer,
  options: {
    mimetype?: string;
    filename?: string;
    truncated?: boolean;
  } = {},
) {
  const stream = Readable.from([bytes]);
  Object.assign(stream, { truncated: options.truncated === true });
  return {
    file: stream as unknown as NodeJS.ReadableStream & {
      truncated?: boolean;
    },
    mimetype: options.mimetype ?? 'application/pdf',
    filename: options.filename ?? 'cv.pdf',
  };
}

/** Build a stream that yields `bytes` synchronously when read. */
function streamBytes(bytes: Buffer): Readable {
  return Readable.from([bytes]);
}
void streamBytes;

function makeHeader(insertId: number): ResultSetHeader {
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

function fakeFileHandle(sample: Buffer) {
  return {
    read: vi.fn(async (buffer: Buffer) => {
      sample.copy(buffer, 0, 0, Math.min(sample.length, buffer.length));
      return { bytesRead: Math.min(sample.length, buffer.length) };
    }),
    close: vi.fn(async () => undefined),
  };
}

/** Wire a default (happy-path) writer + tmp-stat. */
function defaultFsHappyPath(payloadSize: number) {
  writeStreamMock.mockImplementation(() => makeFakeWriter());
  statMock.mockImplementation(async () => ({
    size: payloadSize,
    isFile: () => true,
  }));
}

beforeEach(() => {
  // Free space passes by default.
  assertFreeSpaceMock.mockReset();
  assertFreeSpaceMock.mockResolvedValue({
    ok: true,
    freeBytes: 500 * 1024 * 1024,
    minBytes: 100 * 1024 * 1024,
  });

  cvPathMock.mockReset();
  cvPathMock.mockImplementation(
    (_uid: number, uuid: string, ext: string) =>
      `cv/2025/01/${uuid}.${ext}`,
  );
  cvAbsolutePathMock.mockReset();
  cvAbsolutePathMock.mockImplementation(
    (rel: string) => `/srv/file_store/${rel}`,
  );
  ensureCvDirMock.mockReset();
  ensureCvDirMock.mockImplementation(
    async (_uid: number, uuid: string, ext: string) =>
      `/srv/file_store/cv/2025/01/${uuid}.${ext}`,
  );
  ensureDirMock.mockReset().mockResolvedValue(undefined);
  tmpUploadPathMock.mockReset();
  tmpUploadPathMock.mockImplementation(
    (uuid: string) => `/home/test/tmp/uploads/${uuid}.tmp`,
  );
  safeUnlinkMock.mockReset().mockResolvedValue(true);

  writeStreamMock.mockReset();
  openMock.mockReset();
  renameMock.mockReset().mockResolvedValue(undefined);
  statMock.mockReset();
  unlinkMock.mockReset().mockResolvedValue(undefined);

  fileTypeMock.mockReset();

  queryMock.mockReset();
  withTransactionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

describe('module constants', () => {
  it('exposes MAX_CV_BYTES = 5 MiB per Req 4 AC #7', () => {
    expect(MAX_CV_BYTES).toBe(5 * 1024 * 1024);
  });

  it('exposes MAX_CV_HISTORY = 3 per Req 4 AC #8', () => {
    expect(MAX_CV_HISTORY).toBe(3);
  });

  it('exposes the canonical MIME allowlist', () => {
    expect([...ALLOWED_CV_MIMES]).toEqual([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
  });

  it('maps each allowed MIME to its on-disk extension', () => {
    expect(MIME_TO_EXT['application/pdf']).toBe('pdf');
    expect(MIME_TO_EXT['application/msword']).toBe('doc');
    expect(
      MIME_TO_EXT[
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ],
    ).toBe('docx');
  });
});

// ---------------------------------------------------------------------------
// processCvUpload — happy path
// ---------------------------------------------------------------------------

describe('processCvUpload — happy path (PDF, no history)', () => {
  it('streams to tmp, sniffs the magic bytes, renames, INSERTs, and returns the fresh record', async () => {
    const payload = Buffer.from('%PDF-1.5\n' + 'a'.repeat(2000));
    defaultFsHappyPath(payload.length);
    openMock.mockResolvedValue(fakeFileHandle(payload));
    fileTypeMock.mockResolvedValue({ ext: 'pdf', mime: 'application/pdf' });

    // Simulate a transaction body where INSERT yields id=42, the
    // deactivate UPDATE affects 0 rows, the prune SELECT returns no
    // rows, and the final SELECT_BY_ID returns the freshly-inserted
    // row shape.
    withTransactionMock.mockImplementation(async (fn) => {
      const conn = {
        execute: vi.fn(async (sql: string) => {
          if (sql.startsWith('INSERT INTO applicant_cv_files')) {
            return [makeHeader(42), []];
          }
          if (sql.startsWith('UPDATE applicant_cv_files')) {
            return [makeHeader(0), []];
          }
          if (sql.startsWith('SELECT id, storage_path FROM applicant_cv_files')) {
            return [[] as RowDataPacket[], []];
          }
          if (sql.startsWith('SELECT id, applicant_user_id, storage_path')) {
            return [
              [
                {
                  id: 42,
                  applicant_user_id: 7,
                  storage_path: 'cv/2025/01/abc.pdf',
                  original_filename: 'cv.pdf',
                  mime_type: 'application/pdf',
                  size_bytes: payload.length,
                  is_active: 1,
                  uploaded_at: new Date('2025-01-15T00:00:00Z'),
                } as RowDataPacket,
              ],
              [],
            ];
          }
          throw new Error('unexpected SQL: ' + sql);
        }),
      };
      return fn(conn as never);
    });

    const result = await processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload),
    });

    expect(result.cvFile.id).toBe(42);
    expect(result.cvFile.applicant_user_id).toBe(7);
    expect(result.cvFile.is_active).toBe(true);
    expect(result.cvFile.mime_type).toBe('application/pdf');
    expect(result.cvFile.size_bytes).toBe(payload.length);

    // Pre-flight: free-space check ran before any disk write.
    expect(assertFreeSpaceMock).toHaveBeenCalledTimes(1);
    // Magic-byte sniff happened.
    expect(fileTypeMock).toHaveBeenCalledTimes(1);
    // Rename moved tmp → final, exactly once.
    expect(renameMock).toHaveBeenCalledTimes(1);
    // Tmp file was NOT unlinked (it was renamed instead).
    expect(unlinkMock).not.toHaveBeenCalled();
    // No prune unlinks (history was empty).
    expect(safeUnlinkMock).not.toHaveBeenCalled();
  });

  it('accepts a DOCX upload (declared MIME matches sniffed MIME exactly)', async () => {
    const payload = Buffer.from('PK\x03\x04docx-zip-bytes-here');
    defaultFsHappyPath(payload.length);
    openMock.mockResolvedValue(fakeFileHandle(payload));
    fileTypeMock.mockResolvedValue({
      ext: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    withTransactionMock.mockImplementation(async (fn) => {
      const conn = {
        execute: vi.fn(async (sql: string) => {
          if (sql.startsWith('INSERT')) return [makeHeader(11), []];
          if (sql.startsWith('UPDATE')) return [makeHeader(0), []];
          if (sql.startsWith('SELECT id, storage_path')) return [[], []];
          if (sql.startsWith('SELECT id, applicant_user_id')) {
            return [
              [
                {
                  id: 11,
                  applicant_user_id: 7,
                  storage_path: 'cv/2025/01/abc.docx',
                  original_filename: 'cv.docx',
                  mime_type:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  size_bytes: payload.length,
                  is_active: 1,
                  uploaded_at: new Date('2025-01-15T00:00:00Z'),
                } as RowDataPacket,
              ],
              [],
            ];
          }
          throw new Error('unexpected SQL: ' + sql);
        }),
      };
      return fn(conn as never);
    });

    const result = await processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload, {
        mimetype:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'resume.docx',
      }),
    });
    expect(result.cvFile.mime_type).toMatch(/wordprocessingml/);
  });

  it('accepts a legacy .doc upload (declared msword + sniffed application/x-cfb)', async () => {
    const payload = Buffer.from('\xd0\xcf\x11\xe0' + 'a'.repeat(100));
    defaultFsHappyPath(payload.length);
    openMock.mockResolvedValue(fakeFileHandle(payload));
    // file-type sniffs OLE2/CFB containers as application/x-cfb.
    fileTypeMock.mockResolvedValue({ ext: 'cfb', mime: 'application/x-cfb' });

    withTransactionMock.mockImplementation(async (fn) => {
      const conn = {
        execute: vi.fn(async (sql: string) => {
          if (sql.startsWith('INSERT')) return [makeHeader(8), []];
          if (sql.startsWith('UPDATE')) return [makeHeader(0), []];
          if (sql.startsWith('SELECT id, storage_path')) return [[], []];
          if (sql.startsWith('SELECT id, applicant_user_id')) {
            return [
              [
                {
                  id: 8,
                  applicant_user_id: 7,
                  storage_path: 'cv/2025/01/legacy.doc',
                  original_filename: 'resume.doc',
                  mime_type: 'application/msword',
                  size_bytes: payload.length,
                  is_active: 1,
                  uploaded_at: new Date('2025-01-15T00:00:00Z'),
                } as RowDataPacket,
              ],
              [],
            ];
          }
          throw new Error('unexpected SQL: ' + sql);
        }),
      };
      return fn(conn as never);
    });

    const result = await processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload, {
        mimetype: 'application/msword',
        filename: 'resume.doc',
      }),
    });
    expect(result.cvFile.mime_type).toBe('application/msword');
  });
});

// ---------------------------------------------------------------------------
// processCvUpload — oversize → 413
// ---------------------------------------------------------------------------

describe('processCvUpload — oversize body (413)', () => {
  it('throws FileTooLargeError when the busboy stream is truncated', async () => {
    const payload = Buffer.from('%PDF-1.5\n' + 'a'.repeat(200));
    defaultFsHappyPath(payload.length);

    const result = processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload, {
        mimetype: 'application/pdf',
        truncated: true,
      }),
    });

    await expect(result).rejects.toBeInstanceOf(FileTooLargeError);
    // No DB write attempted, no rename.
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(renameMock).not.toHaveBeenCalled();
    // Tmp file is unlinked on the failure path.
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock.mock.calls[0]?.[0]).toMatch(/\.tmp$/);
  });

  it('throws FileTooLargeError when the in-band counter trips on oversize bytes', async () => {
    // Build a payload that exceeds MAX_CV_BYTES by emitting a single
    // chunk slightly larger than the limit. The size limiter aborts
    // pipeline() before busboy could.
    const oversize = Buffer.alloc(MAX_CV_BYTES + 1024, 0);
    defaultFsHappyPath(oversize.length);

    const result = processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(oversize, { mimetype: 'application/pdf' }),
    });
    await expect(result).rejects.toBeInstanceOf(FileTooLargeError);

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(renameMock).not.toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processCvUpload — bad MIME → 415
// ---------------------------------------------------------------------------

describe('processCvUpload — MIME mismatch (415)', () => {
  it('throws MimeMismatchError when the declared MIME is not in the allowlist', async () => {
    const payload = Buffer.from('hello');
    defaultFsHappyPath(payload.length);

    const result = processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload, {
        mimetype: 'image/png',
        filename: 'photo.png',
      }),
    });

    await expect(result).rejects.toBeInstanceOf(MimeMismatchError);
    // Rejected pre-flight: no temp write attempted.
    expect(writeStreamMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('throws MimeMismatchError when magic bytes do not match the declared MIME', async () => {
    const payload = Buffer.from('not-a-pdf');
    defaultFsHappyPath(payload.length);
    openMock.mockResolvedValue(fakeFileHandle(payload));
    // file-type sniffs the bytes as a PNG even though the browser
    // claimed PDF.
    fileTypeMock.mockResolvedValue({ ext: 'png', mime: 'image/png' });

    const result = processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload, {
        mimetype: 'application/pdf',
        filename: 'cv.pdf',
      }),
    });

    await expect(result).rejects.toBeInstanceOf(MimeMismatchError);
    // The temp file was streamed and then unlinked.
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    // No DB write attempted.
    expect(withTransactionMock).not.toHaveBeenCalled();
    // Rename never happened — file did not move into File_Store.
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('throws MimeMismatchError when file-type returns undefined (no signature)', async () => {
    const payload = Buffer.from('???');
    defaultFsHappyPath(payload.length);
    openMock.mockResolvedValue(fakeFileHandle(payload));
    fileTypeMock.mockResolvedValue(undefined);

    const result = processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload, { mimetype: 'application/pdf' }),
    });

    await expect(result).rejects.toBeInstanceOf(MimeMismatchError);
    expect(unlinkMock).toHaveBeenCalled();
    expect(renameMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processCvUpload — insufficient storage → 507
// ---------------------------------------------------------------------------

describe('processCvUpload — insufficient storage (507)', () => {
  it('throws InsufficientStorageError before opening any file', async () => {
    assertFreeSpaceMock.mockRejectedValueOnce(
      new FakeInsufficientStorageError(1024, 100 * 1024 * 1024),
    );

    const payload = Buffer.from('%PDF-1.5\nbody');
    const result = processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload),
    });

    await expect(result).rejects.toMatchObject({
      statusCode: 507,
      name: 'InsufficientStorageError',
    });

    // Pre-flight gates everything: no temp open, no sniff, no DB.
    expect(writeStreamMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    expect(fileTypeMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processCvUpload — retention prune (4th upload)
// ---------------------------------------------------------------------------

describe('processCvUpload — retention prune past MAX_CV_HISTORY', () => {
  it('keeps 3 rows and unlinks the oldest physical file when count > 3', async () => {
    const payload = Buffer.from('%PDF-1.5\n' + 'b'.repeat(500));
    defaultFsHappyPath(payload.length);
    openMock.mockResolvedValue(fakeFileHandle(payload));
    fileTypeMock.mockResolvedValue({ ext: 'pdf', mime: 'application/pdf' });

    // Capture the SQL the transaction body executes so we can assert
    // the contract: INSERT, UPDATE deactivate, SELECT prune (offset 3),
    // DELETE oldest, SELECT freshly-inserted.
    const executeOrder: string[] = [];
    const executeParams: unknown[][] = [];

    withTransactionMock.mockImplementation(async (fn) => {
      const conn = {
        execute: vi.fn(async (sql: string, params?: unknown[]) => {
          executeOrder.push(sql.split('\n')[0] ?? sql);
          executeParams.push(params ?? []);
          if (sql.startsWith('INSERT')) return [makeHeader(99), []];
          if (sql.startsWith('UPDATE')) return [makeHeader(2), []];
          if (sql.startsWith('SELECT id, storage_path')) {
            // 1 row past offset=3 → the oldest version.
            return [
              [
                {
                  id: 50,
                  storage_path: 'cv/2024/12/oldest.pdf',
                } as RowDataPacket,
              ],
              [],
            ];
          }
          if (sql.startsWith('DELETE')) return [makeHeader(1), []];
          if (sql.startsWith('SELECT id, applicant_user_id')) {
            return [
              [
                {
                  id: 99,
                  applicant_user_id: 7,
                  storage_path: 'cv/2025/01/new.pdf',
                  original_filename: 'cv.pdf',
                  mime_type: 'application/pdf',
                  size_bytes: payload.length,
                  is_active: 1,
                  uploaded_at: new Date('2025-01-15T00:00:00Z'),
                } as RowDataPacket,
              ],
              [],
            ];
          }
          throw new Error('unexpected SQL: ' + sql);
        }),
      };
      return fn(conn as never);
    });

    const result = await processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload),
    });

    expect(result.cvFile.id).toBe(99);

    // INSERT happened exactly once.
    expect(executeOrder.filter((s) => s.startsWith('INSERT')).length).toBe(1);
    // The deactivate ran once with (userId, newId).
    const deactivateIdx = executeOrder.findIndex((s) => s.startsWith('UPDATE'));
    expect(deactivateIdx).toBeGreaterThan(-1);
    expect(executeParams[deactivateIdx]).toEqual([7, 99]);
    // The prune SELECT used the MAX_CV_HISTORY offset.
    const pruneSelectIdx = executeOrder.findIndex((s) =>
      s.startsWith('SELECT id, storage_path'),
    );
    expect(pruneSelectIdx).toBeGreaterThan(-1);
    expect(executeParams[pruneSelectIdx]).toEqual([7, MAX_CV_HISTORY]);
    // The DELETE targeted the oldest row's id, scoped to the owner.
    const deleteIdx = executeOrder.findIndex((s) => s.startsWith('DELETE'));
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(executeParams[deleteIdx]).toEqual([50, 7]);

    // The on-disk file for the pruned row was unlinked AFTER the
    // transaction (best-effort safeUnlink).
    expect(safeUnlinkMock).toHaveBeenCalledTimes(1);
    expect(safeUnlinkMock).toHaveBeenCalledWith(
      '/srv/file_store/cv/2024/12/oldest.pdf',
    );
    expect(cvAbsolutePathMock).toHaveBeenCalledWith(
      'cv/2024/12/oldest.pdf',
    );
  });

  it('does not run safeUnlink when there are no rows past the cap', async () => {
    const payload = Buffer.from('%PDF-1.5\nbody');
    defaultFsHappyPath(payload.length);
    openMock.mockResolvedValue(fakeFileHandle(payload));
    fileTypeMock.mockResolvedValue({ ext: 'pdf', mime: 'application/pdf' });

    withTransactionMock.mockImplementation(async (fn) => {
      const conn = {
        execute: vi.fn(async (sql: string) => {
          if (sql.startsWith('INSERT')) return [makeHeader(1), []];
          if (sql.startsWith('UPDATE')) return [makeHeader(0), []];
          if (sql.startsWith('SELECT id, storage_path')) return [[], []];
          if (sql.startsWith('SELECT id, applicant_user_id')) {
            return [
              [
                {
                  id: 1,
                  applicant_user_id: 7,
                  storage_path: 'cv/2025/01/x.pdf',
                  original_filename: 'cv.pdf',
                  mime_type: 'application/pdf',
                  size_bytes: payload.length,
                  is_active: 1,
                  uploaded_at: new Date('2025-01-15T00:00:00Z'),
                } as RowDataPacket,
              ],
              [],
            ];
          }
          throw new Error('unexpected SQL: ' + sql);
        }),
      };
      return fn(conn as never);
    });

    await processCvUpload({
      userId: 7,
      multipartFile: makeMultipart(payload),
    });
    expect(safeUnlinkMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listCvsForOwner
// ---------------------------------------------------------------------------

describe('listCvsForOwner', () => {
  it('returns [] for invalid user ids without hitting the DB', async () => {
    expect(await listCvsForOwner(0)).toEqual([]);
    expect(await listCvsForOwner(-1)).toEqual([]);
    expect(await listCvsForOwner(1.5)).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('maps rows to CvFileRecord and returns newest-first', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 99,
        applicant_user_id: 7,
        storage_path: 'cv/2025/01/new.pdf',
        original_filename: 'cv-new.pdf',
        mime_type: 'application/pdf',
        size_bytes: '4096',
        is_active: 1,
        uploaded_at: new Date('2025-01-15T00:00:00Z'),
      },
      {
        id: 50,
        applicant_user_id: 7,
        storage_path: 'cv/2024/12/old.pdf',
        original_filename: 'cv-old.pdf',
        mime_type: 'application/pdf',
        size_bytes: '2048',
        is_active: 0,
        uploaded_at: new Date('2024-12-15T00:00:00Z'),
      },
    ] as RowDataPacket[]);

    const list = await listCvsForOwner(7);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(99);
    expect(list[0]?.is_active).toBe(true);
    expect(list[0]?.size_bytes).toBe(4096);
    expect(list[1]?.id).toBe(50);
    expect(list[1]?.is_active).toBe(false);
  });
});
