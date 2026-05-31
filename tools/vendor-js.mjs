#!/usr/bin/env node
/**
 * tools/vendor-js.mjs
 *
 * Downloads pinned vendor JS libraries (htmx, Alpine.js, Sortable.js) from
 * unpkg (with jsdelivr fallback), writes them to src/public/js/, and computes
 * Subresource Integrity (SRI) SHA-384 hashes for use in
 * src/views/partials/header.njk.
 *
 * Usage:
 *   node tools/vendor-js.mjs           # download all
 *   node tools/vendor-js.mjs --check   # verify existing files match SRI manifest
 *   node tools/vendor-js.mjs --force   # re-download even if file exists & valid
 *
 * Why vendored?
 *   - Production CSP forbids external script sources (Req 15.1).
 *   - Avoids first-load network latency to a CDN (Req 2.10 — LCP budget).
 *   - SRI hash is recomputed on every download so header.njk can pin
 *     `integrity="sha384-..." crossorigin="anonymous"` even though the
 *     script is same-origin (defense in depth against tampering on disk).
 *
 * Validates: Requirements 2.10, 15.1 (per design §3, §4.2).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const TARGET_DIR = resolve(REPO_ROOT, 'src/public/js');
const MANIFEST_PATH = resolve(TARGET_DIR, 'sri-manifest.json');

/**
 * Pinned vendor libraries. Update both `version` and re-run this script when
 * upgrading. The placeholder files in src/public/js/*.min.js declare the same
 * pinned versions in their header comments — keep them in sync.
 */
const VENDORS = [
  {
    name: 'htmx',
    version: '1.9.12',
    file: 'htmx.min.js',
    primary: 'https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js',
    fallback: 'https://cdn.jsdelivr.net/npm/htmx.org@1.9.12/dist/htmx.min.js',
    license: 'BSD-2-Clause'
  },
  {
    name: 'alpinejs',
    version: '3.13.10',
    file: 'alpinejs.min.js',
    primary: 'https://unpkg.com/alpinejs@3.13.10/dist/cdn.min.js',
    fallback: 'https://cdn.jsdelivr.net/npm/alpinejs@3.13.10/dist/cdn.min.js',
    license: 'MIT'
  },
  {
    name: 'sortablejs',
    version: '1.15.6',
    file: 'sortable.min.js',
    primary: 'https://unpkg.com/sortablejs@1.15.6/Sortable.min.js',
    fallback: 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js',
    license: 'MIT'
  }
];

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const FORCE = args.has('--force');

/**
 * Compute the SRI integrity string for a buffer using SHA-384.
 * Format: `sha384-<base64>` per https://www.w3.org/TR/SRI/.
 */
function computeSri(buf) {
  const digest = createHash('sha384').update(buf).digest('base64');
  return `sha384-${digest}`;
}

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort heuristic: a placeholder file is short and contains the
 * sentinel TODO marker. Real vendor payloads are minified and >>10 KB.
 */
async function isPlaceholder(path) {
  try {
    const buf = await readFile(path);
    if (buf.byteLength > 5_000) return false;
    return buf.includes('TODO_FILL_AFTER_DOWNLOAD');
  } catch {
    return true;
  }
}

async function fetchWithFallback(primary, fallback) {
  for (const url of [primary, fallback]) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'ptk-app/vendor-js' }
      });
      if (!res.ok) {
        console.warn(`  ! ${url} -> HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < 1_000) {
        console.warn(`  ! ${url} -> suspiciously small payload (${buf.byteLength} B)`);
        continue;
      }
      return { buf, url };
    } catch (err) {
      console.warn(`  ! ${url} -> ${err.message}`);
    }
  }
  throw new Error(`failed to download via primary=${primary} fallback=${fallback}`);
}

async function downloadOne(vendor) {
  const target = resolve(TARGET_DIR, vendor.file);
  const exists = await fileExists(target);
  const placeholder = exists ? await isPlaceholder(target) : true;

  if (exists && !placeholder && !FORCE) {
    const buf = await readFile(target);
    const sri = computeSri(buf);
    console.log(`  = ${vendor.file} already vendored (${buf.byteLength} B) ${sri}`);
    return { ...vendor, sri, bytes: buf.byteLength };
  }

  if (CHECK_ONLY) {
    throw new Error(
      `${vendor.file} is missing or still a placeholder; run without --check to download.`
    );
  }

  console.log(`  ↓ ${vendor.name}@${vendor.version}`);
  const { buf, url } = await fetchWithFallback(vendor.primary, vendor.fallback);
  await writeFile(target, buf);
  const sri = computeSri(buf);
  console.log(`  ✓ ${vendor.file} ${buf.byteLength} B via ${url}`);
  console.log(`    integrity: ${sri}`);
  return { ...vendor, sri, bytes: buf.byteLength, sourceUrl: url };
}

async function main() {
  await mkdir(TARGET_DIR, { recursive: true });

  console.log(
    `vendor-js: ${CHECK_ONLY ? 'checking' : 'downloading'} ${VENDORS.length} libraries -> ${TARGET_DIR}`
  );

  const results = [];
  for (const v of VENDORS) {
    results.push(await downloadOne(v));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    algorithm: 'sha384',
    note: 'Consume in views/partials/header.njk: integrity="{{ sri.htmx }}" crossorigin="anonymous"',
    files: Object.fromEntries(
      results.map((r) => [
        r.name,
        {
          version: r.version,
          file: r.file,
          bytes: r.bytes,
          integrity: r.sri,
          license: r.license,
          source: r.sourceUrl ?? r.primary
        }
      ])
    )
  };

  if (!CHECK_ONLY) {
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nwrote ${MANIFEST_PATH}`);
  }

  console.log('\nSRI hashes (paste into views/partials/header.njk if not loading manifest):');
  for (const r of results) {
    console.log(`  ${r.file.padEnd(20)} ${r.sri}`);
  }
}

main().catch((err) => {
  console.error(`\nvendor-js failed: ${err.message}`);
  process.exit(1);
});
