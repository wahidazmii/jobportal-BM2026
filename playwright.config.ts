import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration — E2E smoke tests untuk PT Buana Megah Job Portal.
 *
 * Lihat design.md §Testing Strategy → "End-to-end smoke tests (Playwright)".
 *
 * - baseURL diambil dari env `E2E_BASE_URL` agar bisa diarahkan ke staging
 *   (mis. https://buanamegahcareer.my.id) atau dev lokal.
 * - `webServer` menjalankan `npm run start:test` (NODE_ENV=test) melawan
 *   MySQL test schema (`mycdmkay_ptk_test`); Playwright akan menunggu
 *   `/healthz` 200 sebelum test mulai (timeout 60 detik).
 * - `reuseExistingServer` aktif di non-CI agar developer dapat menjalankan
 *   server di terminal lain dan hanya menjalankan suite saat dibutuhkan.
 * - Projects: chromium + firefox sesuai cakupan smoke test minimum.
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  // Smoke tests harus selesai cepat; per-test cap 30 detik.
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Smoke test sederhana ke endpoint HTTP — tidak perlu navigasi panjang.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  webServer: {
    command: 'npm run start:test',
    // Probe /healthz: kembali 200 hanya saat pool MySQL test schema sehat.
    url: `${baseURL}/healthz`,
    timeout: 60_000,
    reuseExistingServer: !isCI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
