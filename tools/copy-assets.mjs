#!/usr/bin/env node
/**
 * tools/copy-assets.mjs
 *
 * Copies built static assets (Tailwind CSS, vendored JS, images) from
 * src/public/* to ../public_html/assets/ during deploy. cPanel's Apache
 * serves /assets/* directly without going through Passenger, so this is
 * the one-shot synchronisation that the build pipeline performs after
 * `tailwindcss --minify` finishes.
 *
 * Usage (run after `npm run build:assets`):
 *   node tools/copy-assets.mjs
 *
 * Honors PUBLIC_HTML env var so local dev can target a sandboxed dir
 * (defaults to ../public_html relative to repo root). On non-cPanel hosts
 * (CI, dev), the script is a no-op when the target directory is missing
 * unless --force is passed.
 *
 * Validates: Requirements 2.10, 1.1 (Design §3, §4.3, §21)
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_DIR = resolve(REPO_ROOT, 'src/public');
const TARGET_ROOT =
  process.env.PUBLIC_HTML ?? resolve(REPO_ROOT, '..', 'public_html');
const TARGET_DIR = resolve(TARGET_ROOT, 'assets');

const force = process.argv.includes('--force');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(SRC_DIR))) {
    console.error(`copy-assets: source missing: ${SRC_DIR}`);
    process.exit(1);
  }

  if (!(await exists(TARGET_ROOT)) && !force) {
    console.warn(
      `copy-assets: target ${TARGET_ROOT} does not exist; skipping (pass --force to override).`
    );
    return;
  }

  await mkdir(TARGET_DIR, { recursive: true });

  // Skip the Tailwind source file when copying (only the built `.css` is
  // shipped). Everything else (js, img, css/app.css) is copied verbatim.
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  for (const entry of entries) {
    const src = resolve(SRC_DIR, entry.name);
    const dest = resolve(TARGET_DIR, entry.name);
    await cp(src, dest, {
      recursive: true,
      filter: (s) => !s.endsWith('app.src.css'),
    });
    console.log(`  ✓ ${entry.name}`);
  }

  console.log(`copy-assets: synced ${SRC_DIR} -> ${TARGET_DIR}`);
}

main().catch((err) => {
  console.error(`copy-assets failed: ${err.message}`);
  process.exit(1);
});
