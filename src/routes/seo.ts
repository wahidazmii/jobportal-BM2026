/**
 * SEO HTTP routes for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 22.3
 * Design  : §4.3 (SEO & performance), §6 Public (route table)
 * Validates: Requirements 2.6 (sitemap), 2.7 (robots), 17.1 (locale
 *            alternates / hreflang)
 *
 * Scope of THIS file:
 *   - `GET /sitemap.xml` — emit a sitemap covering the public landing
 *     pages (`/`, `/{id,en}/`, `/{id,en}/jobs`, `/{id,en}/about`) plus
 *     every `Published` job posting under both locales. The body is
 *     generated on-demand and cached in memory for 5 minutes (Design
 *     §4.3 — `Cache-Control: public, max-age=300`). On a database
 *     failure we fall back to the static URL list so the file stays
 *     reachable for crawlers.
 *   - `GET /robots.txt` — the canonical robots policy: allow `/`,
 *     disallow the privileged areas (`/admin`, `/api`, `/applicant`,
 *     `/me`), and advertise the sitemap. The body is static for the
 *     lifetime of the process so we cache it for one hour.
 *
 * Hreflang helper:
 *   - `buildHreflangLinks(slug, baseUrl)` returns the four `<link>`
 *     tags required by Req 17.1 — `id`, `en`, and the `x-default`
 *     fallback. Task 22.2 (job detail SSR) imports it and inserts the
 *     output into the `<head>` block of `views/public/job-detail.njk`.
 *
 * Cache / freshness:
 *   - Sitemap entries are clamped to the `Published` set; new jobs
 *     appear at most 5 minutes after publication. Closed/Archived
 *     postings drop on the next refresh — sufficient for Google's
 *     re-crawl cadence (typically 1–7 days for fresh job content).
 *   - Robots is effectively static; the 1-hour cap exists only so
 *     hot-reloads in development do not stale forever.
 *
 * Security:
 *   - All emitted strings are XML-escaped so a slug containing `&`
 *     or `<` (the slug column allows `%-`-encoded sequences via the
 *     repo) cannot break the document.
 *   - No user-controlled value reaches the outer headers; the
 *     `Sitemap:` line in robots.txt uses the configured `BASE_URL`
 *     read once at module-load.
 *   - The cache is a module-level `let` rather than a per-instance
 *     state because the routes are pure functions of the database
 *     state. Tests can call `_resetSeoCachesForTests()` between cases
 *     to clear it.
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { query, type RowDataPacket } from '../infra/db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Locale segments understood by the public site (Design §13). */
const LOCALES = ['id', 'en'] as const;
type Locale = (typeof LOCALES)[number];

/** Sitemap cache TTL — 5 minutes per Design §4.3. */
export const SITEMAP_CACHE_TTL_MS = 5 * 60 * 1000;

/** Robots cache TTL — 1 hour. The body is effectively static. */
export const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;

/** `Cache-Control` value matching the sitemap TTL. */
const SITEMAP_CACHE_CONTROL = 'public, max-age=300';

/** `Cache-Control` value matching the robots TTL. */
const ROBOTS_CACHE_CONTROL = 'public, max-age=3600';

/**
 * Hard cap on the number of `Published` jobs serialised into a single
 * sitemap. Per the sitemap.org spec a single file may not exceed 50 000
 * URLs; we set the cap well below that so the response stays small
 * even under unrealistic growth. With two locales per job the practical
 * URL count is 2× this number.
 */
const SITEMAP_JOB_CAP = 5000;

/** Static URL specs joined with the dynamic job entries. */
interface StaticUrlSpec {
  readonly path: string;
  readonly priority: string;
  readonly changefreq: string;
}

const STATIC_URLS: readonly StaticUrlSpec[] = [
  { path: '/', priority: '0.5', changefreq: 'monthly' },
  { path: '/id/', priority: '0.8', changefreq: 'weekly' },
  { path: '/en/', priority: '0.8', changefreq: 'weekly' },
  { path: '/id/jobs', priority: '0.8', changefreq: 'daily' },
  { path: '/en/jobs', priority: '0.8', changefreq: 'daily' },
  { path: '/id/about', priority: '0.5', changefreq: 'monthly' },
  { path: '/en/about', priority: '0.5', changefreq: 'monthly' },
];

// ---------------------------------------------------------------------------
// Cache state (module-level, single-process)
// ---------------------------------------------------------------------------

interface CachedBody {
  readonly body: string;
  readonly generatedAt: number;
}

let sitemapCache: CachedBody | null = null;
let robotsCache: CachedBody | null = null;

/**
 * Reset both caches. Exported for tests so each case starts from a
 * deterministic state — production code never calls this.
 */
export function _resetSeoCachesForTests(): void {
  sitemapCache = null;
  robotsCache = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical absolute base URL. We read `BASE_URL` lazily
 * (rather than capturing it at module-load) so tests that mutate
 * `process.env.BASE_URL` between cases see the updated value, and
 * deployments running under `npm start` get whatever Passenger injects.
 *
 * The fallback `http://localhost:3000` mirrors `loadConfig()` in
 * `server.ts` so dev runs stay self-consistent.
 *
 * Trailing slashes are stripped so we can concatenate path strings
 * (which always start with `/`) without producing `//`.
 */
function resolveBaseUrl(): string {
  const raw = process.env.BASE_URL ?? 'http://localhost:3000';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * XML-escape a string so it cannot break out of an element value.
 * Covers the five entities required by the XML spec — `&`, `<`, `>`,
 * `"`, and `'`. Slugs are constrained to ASCII by the repository's
 * `SLUG_MAX_LEN`, but description / title are not used here so the
 * surface for injection is small.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Coerce mysql2's DATETIME representation (Date | string) into an ISO
 * timestamp suitable for `<lastmod>`. Returns `null` for unparseable
 * values so the caller can omit the element rather than emit an
 * invalid sitemap.
 */
function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Row shape returned by the sitemap query. We only need the slug and
 * the updated_at timestamp — translations and full job rows would
 * waste bandwidth.
 */
interface SitemapJobRow extends RowDataPacket {
  slug: string;
  updated_at: Date | string;
}

/**
 * Pull every `Published` job's slug + last-modification time. The
 * query is parameterless (no user input) so it cannot be injected;
 * the column projection is constant. Ordered by `updated_at DESC` so
 * the freshest content surfaces first if the cap kicks in.
 */
async function fetchPublishedJobs(): Promise<readonly SitemapJobRow[]> {
  return query<SitemapJobRow[]>(
    [
      'SELECT slug, updated_at',
      'FROM job_postings',
      "WHERE status = 'Published'",
      'ORDER BY updated_at DESC',
      'LIMIT ?',
    ].join(' '),
    [SITEMAP_JOB_CAP],
  );
}

/**
 * Optional `<xhtml:link rel="alternate" hreflang="...">` sibling
 * inside a `<url>` entry. Per Google's sitemap-with-hreflang spec
 * (https://developers.google.com/search/docs/specialty/international/localized-versions#sitemap),
 * each localized URL group must list every alternate (including
 * itself) so crawlers can match the variants without ambiguity.
 */
export interface SitemapAlternate {
  readonly hreflang: string;
  readonly href: string;
}

/**
 * Build a single `<url>` element. Public for testing.
 *
 * The function never emits user-controlled bytes verbatim: every
 * dynamic value is XML-escaped. `lastmod` is omitted if `updated_at`
 * is unparseable rather than rendered as the empty element (which
 * some validators reject).
 *
 * When `alternates` is provided, a `<xhtml:link rel="alternate"
 * hreflang="…" href="…" />` sibling is emitted for each entry so
 * the sitemap satisfies Req 17.1 alongside the hreflang `<link>`
 * tags rendered in the job-detail HTML head.
 */
export function renderUrlEntry(
  loc: string,
  options: {
    lastmod?: string | null;
    changefreq?: string;
    priority?: string;
    alternates?: readonly SitemapAlternate[];
  } = {},
): string {
  const parts: string[] = ['  <url>', `    <loc>${escapeXml(loc)}</loc>`];
  if (options.lastmod) {
    parts.push(`    <lastmod>${escapeXml(options.lastmod)}</lastmod>`);
  }
  if (options.changefreq) {
    parts.push(`    <changefreq>${escapeXml(options.changefreq)}</changefreq>`);
  }
  if (options.priority) {
    parts.push(`    <priority>${escapeXml(options.priority)}</priority>`);
  }
  if (options.alternates && options.alternates.length > 0) {
    for (const alt of options.alternates) {
      parts.push(
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}" />`,
      );
    }
  }
  parts.push('  </url>');
  return parts.join('\n');
}

/**
 * Render the static portion of the sitemap (always available even
 * when the database is unreachable). Exported so the graceful
 * fallback path can reuse the exact same wire format.
 */
export function renderStaticSitemap(baseUrl: string): string {
  const entries: string[] = STATIC_URLS.map((spec) =>
    renderUrlEntry(`${baseUrl}${spec.path}`, {
      changefreq: spec.changefreq,
      priority: spec.priority,
    }),
  );
  return wrapUrlset(entries);
}

/**
 * Wrap a list of `<url>` element strings in the sitemap envelope.
 * The XML declaration is required by `sitemap.org` validators. The
 * `xhtml` namespace is declared so `<xhtml:link rel="alternate">`
 * children inside `<url>` entries (for hreflang per Req 17.1) are
 * well-formed.
 */
function wrapUrlset(urlEntries: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urlEntries,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * Generate the dynamic sitemap body (static URLs + every Published
 * job under both locales). This is the slow path — callers should
 * pass through `getSitemapBody()` so the result is cached.
 *
 * For each job we emit one `<url>` entry per locale, and inside each
 * entry we list `<xhtml:link rel="alternate" hreflang="…">` siblings
 * for every locale (including the entry's own) plus an `x-default`
 * pointing at the Indonesian variant. This satisfies Req 17.1 inside
 * the sitemap and is what Google's localized-versions guidance asks
 * for.
 */
async function generateSitemapBody(baseUrl: string): Promise<string> {
  const entries: string[] = STATIC_URLS.map((spec) =>
    renderUrlEntry(`${baseUrl}${spec.path}`, {
      changefreq: spec.changefreq,
      priority: spec.priority,
    }),
  );

  const rows = await fetchPublishedJobs();
  for (const row of rows) {
    const lastmod = toIsoTimestamp(row.updated_at);
    const localeHrefs: Record<Locale, string> = {
      id: `${baseUrl}/id/jobs/${row.slug}`,
      en: `${baseUrl}/en/jobs/${row.slug}`,
    };
    const alternates: readonly SitemapAlternate[] = [
      { hreflang: 'id', href: localeHrefs.id },
      { hreflang: 'en', href: localeHrefs.en },
      { hreflang: 'x-default', href: localeHrefs.id },
    ];
    for (const locale of LOCALES) {
      entries.push(
        renderUrlEntry(localeHrefs[locale], {
          lastmod,
          changefreq: 'weekly',
          priority: '0.7',
          alternates,
        }),
      );
    }
  }

  return wrapUrlset(entries);
}

/**
 * Resolve the sitemap body, regenerating it when the cache is empty
 * or the TTL has elapsed. On a query failure we serve the static-only
 * fallback and log the error so the file stays reachable for
 * crawlers (Design §4.3 graceful degradation).
 */
async function getSitemapBody(
  app: FastifyInstance,
  now: number = Date.now(),
): Promise<string> {
  if (sitemapCache !== null && now - sitemapCache.generatedAt < SITEMAP_CACHE_TTL_MS) {
    return sitemapCache.body;
  }
  const baseUrl = resolveBaseUrl();
  try {
    const body = await generateSitemapBody(baseUrl);
    sitemapCache = { body, generatedAt: now };
    return body;
  } catch (err) {
    app.log.warn({ err }, 'seo.sitemap: query failed, serving static fallback');
    // Do NOT cache the fallback aggressively — keep retrying on the
    // next request once the TTL on the previous good body expires.
    // We still cache for a short window (10 s) to avoid hammering a
    // sick database from a crawler's parallel fetches.
    const body = renderStaticSitemap(baseUrl);
    sitemapCache = { body, generatedAt: now - SITEMAP_CACHE_TTL_MS + 10_000 };
    return body;
  }
}

/**
 * Render the robots.txt body. Pure function over `baseUrl`; no I/O.
 *
 * Disallow list mirrors Design §6:
 *   - `/admin`     — internal Admin_Console.
 *   - `/api`       — htmx fragments + JSON endpoints.
 *   - `/applicant` — legacy alias for `/me/...` (in case the route
 *                     prefix is rewritten in the future).
 *   - `/me`        — Applicant_Area routes (current canonical).
 */
export function renderRobotsBody(baseUrl: string): string {
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /api',
    'Disallow: /applicant',
    'Disallow: /me',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Resolve the robots body, regenerating it when the cache is empty
 * or the TTL has elapsed.
 */
function getRobotsBody(now: number = Date.now()): string {
  if (robotsCache !== null && now - robotsCache.generatedAt < ROBOTS_CACHE_TTL_MS) {
    return robotsCache.body;
  }
  const body = renderRobotsBody(resolveBaseUrl());
  robotsCache = { body, generatedAt: now };
  return body;
}

// ---------------------------------------------------------------------------
// Hreflang helper (consumed by task 22.2 / job-detail template)
// ---------------------------------------------------------------------------

/**
 * Render the four `<link rel="alternate">` tags required by Req 17.1
 * for a locale-prefixed job-detail page:
 *   - `hreflang="id"`        → `/id/jobs/:slug`
 *   - `hreflang="en"`        → `/en/jobs/:slug`
 *   - `hreflang="x-default"` → `/id/jobs/:slug` (Indonesian as default)
 *
 * The function returns a newline-separated string suitable for
 * dropping into a Nunjucks `{{ ... | safe }}` expression. The slug is
 * URI-encoded; the base URL is XML-escaped. Tests assert both shapes.
 *
 * Designed for direct embed:
 *
 * ```
 * <head>
 *   …
 *   {{ hreflangLinks | safe }}
 * </head>
 * ```
 *
 * Per Google's hreflang docs the `x-default` annotation MUST point
 * at the page that handles language selection or the canonical
 * fallback locale. The portal's primary audience is Indonesian, so
 * `id` is the canonical x-default until a language picker exists.
 */
export function buildHreflangLinks(slug: string, baseUrl: string): string {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const encodedSlug = encodeURIComponent(slug);
  const idHref = `${trimmedBase}/id/jobs/${encodedSlug}`;
  const enHref = `${trimmedBase}/en/jobs/${encodedSlug}`;
  return [
    `<link rel="alternate" hreflang="id" href="${escapeXml(idHref)}">`,
    `<link rel="alternate" hreflang="en" href="${escapeXml(enHref)}">`,
    `<link rel="alternate" hreflang="x-default" href="${escapeXml(idHref)}">`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleSitemap(
  app: FastifyInstance,
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const body = await getSitemapBody(app);
  return reply
    .code(200)
    .header('content-type', 'application/xml; charset=utf-8')
    .header('cache-control', SITEMAP_CACHE_CONTROL)
    .send(body);
}

function handleRobots(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const body = getRobotsBody();
  return reply
    .code(200)
    .header('content-type', 'text/plain; charset=utf-8')
    .header('cache-control', ROBOTS_CACHE_CONTROL)
    .send(body);
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * SEO route plugin. Mounted at the application root with no prefix —
 * crawlers expect `/sitemap.xml` and `/robots.txt` at the origin.
 */
export const seoRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/sitemap.xml', (request, reply) => handleSitemap(app, request, reply));
  app.get('/robots.txt', (request, reply) => handleRobots(request, reply));
};

export default seoRoutes;

/** Re-export the locale tuple for tests / sibling tasks. */
export { LOCALES };
export type { Locale };
