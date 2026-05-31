import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default Vitest configuration — unit tests only.
 *
 * Feature: pt-buana-megah-job-portal
 * Design: §Testing Strategy — Unit tests (vitest)
 *
 * Catatan:
 * - Integration test berada di `tests/integration/**` dan dijalankan via
 *   `vitest.integration.config.ts` dengan setup terpisah (membutuhkan MySQL
 *   schema test `mycdmkay_ptk_test`).
 * - PBT (`tests/pbt/**`) dan E2E (`tests/e2e/**`) memiliki entry script
 *   sendiri (`test:pbt`, `test:e2e`).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: [
      'tests/unit/**/*.{test,spec}.ts',
      'tests/integration/**/*.{test,spec}.ts',
      'src/**/*.{test,spec}.ts',
    ],
    exclude: [
      '**/node_modules/**',
      'artifacts/**',
      'tests/pbt/**',
      'tests/e2e/**',
    ],
    setupFiles: ['tests/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'artifacts/coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.{test,spec}.ts',
        'src/server.ts',
        'src/views/**',
        'src/locales/**',
        'src/public/**',
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
