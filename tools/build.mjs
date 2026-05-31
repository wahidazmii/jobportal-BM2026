#!/usr/bin/env node
/**
 * Bundle both runtime entrypoints with esbuild:
 *
 *   - `src/server.ts`      → `artifacts/api-server/dist/index.mjs`
 *     Passenger entry under cPanel "Setup Node.js App" (Design §2.2).
 *   - `src/crons/index.ts` → `artifacts/api-server/dist/crons/index.mjs`
 *     Cron CLI dispatcher invoked by cPanel cron lines (Design §11.1).
 *
 * Both bundles share the same `external` list because they share a
 * `node_modules/` install on the cPanel host — bundling those packages
 * would duplicate code and break native modules (`bcrypt`, `mysql2`).
 *
 * Usage:
 *   node tools/build.mjs
 *
 * Validates: Requirements 1.1, 1.5 (Design §2.2, §11.1)
 */

import { build } from 'esbuild';

/** Packages that MUST stay external to the bundle (see header comment). */
const EXTERNAL = [
  'fastify',
  'mysql2',
  'bcrypt',
  'nunjucks',
  'nodemailer',
  'pino',
  'pino-pretty',
  'zod',
  'ulid',
  'file-type',
  'quick-lru',
  'commander',
  '@fastify/*',
];

/** Common esbuild options shared across every bundle. */
const COMMON = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  external: EXTERNAL,
};

/** Bundles to produce. Order is irrelevant — built in parallel below. */
const BUNDLES = [
  {
    entryPoints: ['src/server.ts'],
    outfile: 'artifacts/api-server/dist/index.mjs',
  },
  {
    entryPoints: ['src/crons/index.ts'],
    outfile: 'artifacts/api-server/dist/crons/index.mjs',
  },
];

async function main() {
  await Promise.all(
    BUNDLES.map((bundle) => build({ ...COMMON, ...bundle })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
