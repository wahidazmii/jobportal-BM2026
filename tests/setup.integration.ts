import { afterAll, beforeAll } from 'vitest';

/**
 * Integration test setup.
 *
 * Feature: pt-buana-megah-job-portal
 * Design: §Testing Strategy — Integration tests (MySQL test schema)
 *
 * Berbeda dengan `tests/setup.ts`, file ini mengarahkan koneksi ke
 * schema test nyata `mycdmkay_ptk_test`. Migrasi dijalankan oleh
 * helper `tests/setup/migrate.ts` (dibuat di task migrasi terkait).
 */

const DEFAULT_TEST_DB_URL =
  'mysql://root@127.0.0.1:3306/mycdmkay_ptk_test?charset=utf8mb4';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_TEST_DB_URL;
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-secret';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

beforeAll(async () => {
  // Hook untuk menjalankan migrasi (`tools/migrate.mjs up`) sebelum suite
  // mulai. Implementasi konkret ditambahkan oleh task migrasi (5.x) yang
  // menyediakan `tests/setup/migrate.ts`. Saat ini no-op agar konfigurasi
  // dapat berjalan walau modul belum ada.
  try {
    const migrateModule = await import('./setup/migrate.js').catch(() => null);
    if (migrateModule && typeof (migrateModule as { runMigrations?: () => Promise<void> }).runMigrations === 'function') {
      await (migrateModule as { runMigrations: () => Promise<void> }).runMigrations();
    }
  } catch {
    // Migrasi belum tersedia — abaikan agar smoke run masih lulus.
  }
});

afterAll(async () => {
  try {
    const dbModule = await import('../src/infra/db.js').catch(() => null);
    if (!dbModule) return;
    const pool = (dbModule as Record<string, unknown>).pool as
      | { end?: () => Promise<void> }
      | undefined;
    if (pool && typeof pool.end === 'function') {
      await pool.end();
    }
  } catch {
    // Pool mungkin belum di-init atau sudah ditutup.
  }
});
