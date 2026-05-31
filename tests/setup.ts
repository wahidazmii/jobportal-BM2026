import { afterAll, beforeAll } from 'vitest';

/**
 * Default (unit) test setup.
 *
 * Feature: pt-buana-megah-job-portal
 * Design: §Testing Strategy — Unit tests (vitest)
 *
 * Memuat environment variable test sebelum module di-load oleh test file.
 * Nilai-nilai di sini bersifat dummy karena unit test tidak berinteraksi
 * dengan MySQL nyata; integration test memakai `tests/setup.integration.ts`.
 */

// Set sebelum import agar modul yang membaca env saat module-load
// (mis. konfigurasi pool) menerima nilai test.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'mysql://test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-secret';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

beforeAll(() => {
  // Placeholder untuk inisialisasi global ringan di masa depan
  // (mis. seed in-memory state). Saat ini tidak ada side-effect.
});

afterAll(async () => {
  // Tear down koneksi pool MySQL bila modul `src/infra/db` sudah pernah
  // di-import oleh test. Memakai dynamic import dan try/catch supaya
  // unit test yang tidak menyentuh DB tidak gagal hanya karena modul
  // belum tersedia (file dibuat oleh task 4.1).
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
    // Diam — pool mungkin belum di-init atau sudah ditutup.
  }
});
