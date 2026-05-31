/**
 * Unit tests for the Fastify bootstrap (`src/server.ts`).
 *
 * Validates: Requirements 1.1, 1.9, 20.3 (Design §2.2, §18.2)
 *
 * The healthz route delegates to `pool.query`; we mock the pool module
 * before importing `server.ts` so the test stays hermetic (no real MySQL).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Capture the mock so each test can swap behaviour.
const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  pool: {
    query: queryMock,
    end: vi.fn().mockResolvedValue(undefined),
  },
  query: vi.fn(),
}));

// Import after mock registration so server.ts picks up the mocked pool.
const { buildApp, loadConfig } = await import('../../src/server.js');

describe('loadConfig', () => {
  it('reads required env vars and provides safe defaults', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      PORT: '4242',
      BASE_URL: 'https://example.test',
      DATABASE_URL: 'mysql://user:pw@db/app',
      SESSION_SECRET: 'x'.repeat(32),
      LOG_LEVEL: 'warn',
    });
    expect(cfg.nodeEnv).toBe('production');
    expect(cfg.port).toBe(4242);
    expect(cfg.baseUrl).toBe('https://example.test');
    expect(cfg.databaseUrl).toBe('mysql://user:pw@db/app');
    expect(cfg.sessionSecret).toHaveLength(32);
    expect(cfg.logLevel).toBe('warn');
  });

  it('rejects an invalid PORT value', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/Invalid PORT/);
  });

  it('falls back to development defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.port).toBe(3000);
    expect(cfg.baseUrl).toBe('http://localhost:3000');
    expect(cfg.logLevel).toBe('info');
  });
});

describe('GET /healthz', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      nodeEnv: 'test',
      port: 0,
      host: '127.0.0.1',
      baseUrl: 'http://localhost',
      databaseUrl: 'mysql://test',
      sessionSecret: 'test-secret',
      logLevel: 'silent',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 ok when SELECT 1 succeeds', async () => {
    queryMock.mockResolvedValueOnce([[{ '1': 1 }], []]);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(queryMock).toHaveBeenCalledWith({ sql: 'SELECT 1', timeout: 1000 });
  });

  it('returns 503 db_unreachable when the pool throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'db_unreachable' });
  });
});
