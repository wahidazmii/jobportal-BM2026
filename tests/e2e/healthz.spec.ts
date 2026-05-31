import { expect, test } from '@playwright/test';

/**
 * Smoke test: `/healthz` endpoint.
 *
 * Validates: Requirements 1.1 (per design §Testing Strategy "End-to-end smoke tests")
 * Reference: design.md §18.2 — endpoint melakukan `SELECT 1` dengan timeout
 * 1000 ms dan mengembalikan 200 saat pool MySQL sehat.
 *
 * Placeholder smoke test untuk memverifikasi bahwa server Fastify (versi test)
 * berjalan dan terhubung ke MySQL test schema sebelum suite E2E penuh
 * (register → verify → login, apply-to-job, kanban stage change, CV upload)
 * diimplementasikan.
 */

test.describe('healthz smoke', () => {
  test('GET /healthz returns 200', async ({ request }) => {
    const response = await request.get('/healthz');

    expect(
      response.status(),
      `Expected /healthz to be 200; got ${response.status()}. ` +
        'Periksa pool MySQL test schema dan env DATABASE_URL.',
    ).toBe(200);
  });

  test('GET /healthz responds with JSON content-type', async ({ request }) => {
    const response = await request.get('/healthz');
    const contentType = response.headers()['content-type'] ?? '';

    expect(contentType).toContain('application/json');
  });
});
