import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Integration test configuration.
 *
 * Feature: pt-buana-megah-job-portal
 * Design: §Testing Strategy — Integration tests (MySQL test schema)
 *
 * Test berinteraksi dengan MySQL/MariaDB lokal pada schema
 * `mycdmkay_ptk_test`. Setiap test dibungkus transaksi yang di-rollback
 * pada hook afterEach (lihat `tests/setup.integration.ts`).
 *
 * Override:
 * - testMatch difokuskan ke `tests/integration/**`.
 * - setupFiles berbeda — mengaktifkan koneksi ke schema test sungguhan.
 * - Timeout lebih panjang karena round-trip ke DB.
 * - Single-thread agar transaksi rollback tidak bertabrakan.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/integration/**/*.{test,spec}.ts'],
      exclude: [
        '**/node_modules/**',
        'artifacts/**',
        'tests/unit/**',
        'tests/pbt/**',
        'tests/e2e/**',
      ],
      setupFiles: ['tests/setup.integration.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // Integration test menyentuh DB nyata; jalankan serial untuk
      // menghindari race antara migrasi dan transaksi rollback.
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
    },
  }),
);
