/**
 * Public_Site route plugin for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md tasks 22.2 (jobs list + detail) and 22.4
 *           (landing + about + root redirect)
 * Design  : §4.3 (htmx auto-refresh, JSON-LD), §6 Public (HTTP map)
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.8, 17.2
 *
 * Scope of THIS file:
 *   - GET `/`                    → 302 redirect to `/{DEFAULT_LOCALE}/`.
 *   - GET `/:locale/`            → landing page (`views/public/landing.njk`)
 *                                  with the 6 most-recent Published jobs
 *                                  (Req 2.1) and a CTA to `/:locale/jobs`.
 *   - GET `/:locale/about`       → about page (`views/public/about.njk`)
 *                                  (Req 2.2).
 *   - GET `/:locale/jobs`        → keyword + filter + paginated job list
 *                                  (`views/public/jobs.njk`). htmx
 *                                  auto-refresh per design §4.3 swaps
 *                                  the `_jobs-list.njk` partial when the
 *                                  request carries `HX-Request: true`
 *                                  (Req 2.3, 6.1-3).
 *   - GET `/:locale/jobs/:slug`  → detail page (`views/public/job-detail.njk`)
 *                                  with embedded JSON-LD `JobPosting`
 *                                  (Req 2.4, 2.5). Returns 404 for
 *                                  missing slugs and for non-Published
 *                                  rows (Req 2.8).
 *
 * Route ordering note:
 *   The catch-all `/:locale/...` matchers from the auth, applicant, and
 *   admin plugins are registered alongside this one in `server.ts`; this
 *   plugin must mount BEFORE any wildcard handler that would shadow
 *   `/healthz` or `/sitemap.xml`. We do NOT register either of those —
 *   task 22.3 owns SEO endpoints.
 *
 * Locales:
 *   `:locale` is validated against `SUPPORTED_LOCALES`; anything else
 *   returns 404 (Req 17.2 — only `id` and `en` are supported). Other
 *   plugins (auth, applicant, admin) follow the same convention so the
 *   route shape stays consistent for tests.
 *
 * Scope of jobs queries:
 *   Public_Site visitors see every Published row regardless of
 *   department (Req 11.4 only scopes admin reads), so we deliberately
 *   do NOT thread a `JobScope` into any read path here. Both the
 *   featured-jobs strip (`repo.list`) and the search service
 *   (`searchPublishedJobs`) hard-code the `Published` predicate.
 *
 * htmx fragment detection:
 *   The standard htmx convention is the `HX-Request: true` header on
 *   AJAX calls. We render the bare `_jobs-list.njk` partial in that
 *   case so htmx can swap it into the results container without the
 *   surrounding layout (Design §4.3). Direct browser navigations
 *   never carry the header so the full page renders.
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  findBySlug,
  list as listJobs,
  type EmploymentType,
  type JobLocale,
  type JobPosting,
  type JobPostingDetail,
} from '../modules/jobs/repo.js';
import {
  searchFilterSchema,
  searchPublishedJobs,
  type SearchFilter,
  type SearchResult,
} from '../modules/jobs/search.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed locale segments for the URL `:locale` parameter (Req 17.2). */
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['id', 'en']);

/**
 * Default locale used by the root redirect (Design §6: `/` → `/id/`).
 * Mirrors Req 17.2's "default to id when none of URL/cookie/header
 * indicate a supported language" precedence rule.
 */
const DEFAULT_LOCALE = 'id';

/** Number of featured jobs rendered on the landing page (Req 2.1). */
const FEATURED_JOBS_LIMIT = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocaleParams {
  locale: string;
}

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

/**
 * Root redirect. Always 302 → `/id/`. We use 302 (and not 301) so a
 * future change to the default-locale rule (per a Visitor's stored
 * cookie / `Accept-Language` header) does not get stuck in a browser
 * cache. Caching the bare-root redirect for the lifetime of the
 * cache-busting deploy is not worth the lock-in.
 */
function getRoot(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(302).header('location', `/${DEFAULT_LOCALE}/`).send();
}

// ---------------------------------------------------------------------------
// GET /:locale/
// ---------------------------------------------------------------------------

/**
 * Landing page. Renders the company hero + a "Featured jobs" grid.
 *
 * The featured-jobs query is best-effort: a transient DB hiccup
 * shouldn't 500 the homepage (the page is the company's front door).
 * If the query throws we log and render the page with an empty grid —
 * the CTA to `/:locale/jobs` still works, and the visitor can retry
 * the dedicated list page where 500s are appropriate.
 */
async function getLanding(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES.has(locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  let featured: JobPosting[] = [];
  try {
    const result = await listJobs({
      status: ['Published'],
      pageSize: FEATURED_JOBS_LIMIT,
    });
    featured = result.rows;
  } catch (err) {
    app.log.warn(
      { err },
      'public.landing: featured jobs query failed; rendering empty strip',
    );
  }

  const html = app.view('public/landing.njk', {
    locale,
    featured,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// GET /:locale/about
// ---------------------------------------------------------------------------

/**
 * About page. Static i18n content; the template branches on `locale`
 * for the prose. No DB access — this is the safe fallback the landing
 * grid links to when a visitor wants to learn more before browsing.
 */
async function getAbout(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES.has(locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const html = app.view('public/about.njk', {
    locale,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// GET /:locale/jobs (list + filter)
// ---------------------------------------------------------------------------

/**
 * Detect the htmx fragment-swap convention. htmx sets `HX-Request: true`
 * on every AJAX call it issues so the server can distinguish "render
 * the partial" from "render the full page". Header values are case-
 * insensitive per RFC 9110 — the lowercase comparison covers every
 * version of htmx (1.x, 2.x) plus any reverse-proxy normalisation.
 */
function isHtmxRequest(request: FastifyRequest): boolean {
  const raw = request.headers['hx-request'];
  if (typeof raw !== 'string') return false;
  return raw.toLowerCase() === 'true';
}

/**
 * Pick the active-locale translation, falling back to id, then en. The
 * job detail page always wants *some* translation (Req 2.4 lists the
 * fields that must render), and Draft jobs are 404'd before this is
 * called so we know at least one locale exists for any Published row
 * that reaches this point.
 *
 * Returns both the translation object and the actual locale it came from
 * so the template can show the "Original Language" badge (Req 17.4,
 * Design §13) when the displayed content is not in the requested locale.
 */
function pickTranslation(
  job: JobPostingDetail,
  locale: JobLocale,
): { translation: JobPostingDetail['translations'][JobLocale]; translationLocale: JobLocale } | null {
  if (job.translations[locale] !== undefined && job.translations[locale] !== null) {
    return { translation: job.translations[locale], translationLocale: locale };
  }
  if (job.translations.id !== undefined && job.translations.id !== null) {
    return { translation: job.translations.id, translationLocale: 'id' };
  }
  if (job.translations.en !== undefined && job.translations.en !== null) {
    return { translation: job.translations.en, translationLocale: 'en' };
  }
  return null;
}

/**
 * Map the project's `EmploymentType` enum onto the schema.org
 * `JobPosting.employmentType` vocabulary. Returns the canonical
 * upper-case constant — schema.org accepts either a single value or
 * an array; we always emit a single string so the JSON-LD stays
 * compact.
 */
function employmentTypeToSchemaOrg(value: EmploymentType): string {
  switch (value) {
    case 'full-time':
      return 'FULL_TIME';
    case 'part-time':
      return 'PART_TIME';
    case 'contract':
      return 'CONTRACTOR';
    case 'internship':
      return 'INTERN';
  }
}

/**
 * Build a schema.org `JobPosting` JSON-LD payload (Req 2 AC #5,
 * Design §4.3). The shape mirrors Google's required and recommended
 * properties:
 *   - `@context`, `@type`, `title`, `description`        (required)
 *   - `datePosted`, `validThrough`, `employmentType`,
 *     `hiringOrganization`, `jobLocation`               (recommended)
 *   - `baseSalary`                                       (when both
 *                                                         min+max set,
 *                                                         per design)
 *
 * The function accepts the resolved translation rather than the full
 * detail row so it stays pure (no fallback logic) and the route
 * handler controls which locale's content reaches Google's index.
 */
function buildJobPostingJsonLd(options: {
  job: JobPostingDetail;
  translation: NonNullable<JobPostingDetail['translations'][JobLocale]>;
  url: string;
}): Record<string, unknown> {
  const { job, translation, url } = options;

  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: translation.title,
    description: translation.description,
    employmentType: employmentTypeToSchemaOrg(job.employment_type),
    hiringOrganization: {
      '@type': 'Organization',
      name: 'PT Buana Megah',
    },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: job.location,
        addressCountry: 'ID',
      },
    },
    url,
  };

  if (job.published_at !== null) {
    ld.datePosted = job.published_at.toISOString();
  }
  if (job.application_deadline !== null) {
    ld.validThrough = job.application_deadline;
  }

  // baseSalary: emit only when both bounds are present so the value
  // unambiguously represents the advertised range. Google rejects a
  // baseSalary with neither minValue nor maxValue.
  if (job.salary_min !== null && job.salary_max !== null) {
    ld.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.salary_currency ?? 'IDR',
      value: {
        '@type': 'QuantitativeValue',
        minValue: job.salary_min,
        maxValue: job.salary_max,
        unitText: 'MONTH',
      },
    };
  }

  return ld;
}

/**
 * Render the public job list. Handles three response modes:
 *   1. `?locale` is unsupported              → 404
 *   2. `HX-Request: true`                    → `_jobs-list.njk` partial
 *   3. otherwise                             → full `jobs.njk` page
 *
 * Filter parsing flows through `searchFilterSchema.parse()`. On a
 * malformed value (an out-of-range pageSize, an unknown
 * employment_type) we treat the field as absent rather than 400 — the
 * htmx auto-refresh fires on every keystroke / checkbox toggle, and
 * users would see error pages mid-typing if we were strict. The
 * service applies its own clamps (offset cap, pageSize cap) so a
 * "garbage in" input produces a safe "empty filter" output.
 */
async function getJobsList(
  app: FastifyInstance,
  request: FastifyRequest<{
    Params: LocaleParams;
    Querystring: Record<string, unknown>;
  }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES.has(locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  // Parse filter from the query string. `safeParse` so a malformed
  // value yields an empty filter instead of a 400 — see comment above.
  const parsed = searchFilterSchema.safeParse(request.query ?? {});
  const filter: SearchFilter = parsed.success ? parsed.data : {};

  let result: SearchResult;
  try {
    result = await searchPublishedJobs(filter, locale);
  } catch (err) {
    app.log.error(
      { err, locale },
      'public.jobsList: search query failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const totalPages = Math.max(
    1,
    Math.ceil(result.total / result.pageSize),
  );

  const context: Record<string, unknown> = {
    locale,
    filter,
    keyword: typeof filter.keyword === 'string' ? filter.keyword : '',
    locations: filter.location ?? [],
    employmentTypes: filter.employment_type ?? [],
    levels: filter.level ?? [],
    departments: filter.department_id ?? [],
    results: result,
    rows: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages,
    facets: result.facets,
    cspNonce: request.cspNonce,
  };

  // htmx-driven swap: render only the partial so htmx's `outerHTML`
  // (or `innerHTML`) swap can drop it into the results container
  // without re-executing the full layout. Direct browser navigation
  // never carries `HX-Request: true`, so the full page renders.
  if (isHtmxRequest(request)) {
    const partial = app.view('public/_jobs-list.njk', context);
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(partial);
  }

  const html = app.view('public/jobs.njk', context);
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// GET /:locale/jobs/:slug (detail + JSON-LD)
// ---------------------------------------------------------------------------

/**
 * Render a single job detail page.
 *
 * Pipeline:
 *   1. Validate the locale segment (404 on unknown).
 *   2. Validate the slug (404 on empty).
 *   3. Look up the row by slug — `findBySlug` is unscoped because the
 *      public site sees every department's published rows.
 *   4. 404 when the row is missing OR `status !== 'Published'`
 *      (Req 2.8). Closed/Draft/Archived rows must NEVER reach the
 *      public surface.
 *   5. Pick the translation (active locale → id → en) and assemble
 *      the JSON-LD `JobPosting` payload.
 *   6. Render the template; the `<script type="application/ld+json">`
 *      block in the template embeds the stringified payload.
 */
async function getJobDetail(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams & { slug: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES.has(locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const slug = request.params.slug;
  if (typeof slug !== 'string' || slug.length === 0) {
    return reply.code(404).send({ error: 'job_not_found' });
  }

  let job: JobPostingDetail | null;
  try {
    job = await findBySlug(slug);
  } catch (err) {
    app.log.error(
      { err, locale, slug },
      'public.jobDetail: lookup failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  // Req 2.8 — non-Published jobs (Draft, Closed, Archived) MUST 404
  // even if the slug exists. This is also the natural outcome when
  // an admin closes a job that was previously crawled.
  if (job === null || job.status !== 'Published') {
    return reply.code(404).send({ error: 'job_not_found' });
  }

  const picked = pickTranslation(job, locale as JobLocale);
  if (picked === null) {
    // A Published job without any translation is a data-integrity
    // bug elsewhere (the publish service requires at least one
    // locale). Surface 404 rather than a half-rendered page so the
    // public surface never advertises an unrenderable job.
    app.log.warn(
      { slug, status: job.status },
      'public.jobDetail: published job has no translation',
    );
    return reply.code(404).send({ error: 'job_not_found' });
  }

  const { translation, translationLocale } = picked;

  // Build the canonical absolute URL for the JSON-LD `url` property.
  // We honor `BASE_URL` when set (production / cPanel deployments)
  // and fall back to the request origin in dev.
  const baseUrl = (() => {
    const raw = process.env.BASE_URL;
    if (typeof raw === 'string' && raw.length > 0) {
      return raw.endsWith('/') ? raw.slice(0, -1) : raw;
    }
    const proto = (request.headers['x-forwarded-proto'] as string) ?? 'http';
    const host = request.headers.host ?? 'localhost';
    return `${proto}://${host}`;
  })();
  const canonicalUrl = `${baseUrl}/${locale}/jobs/${encodeURIComponent(slug)}`;

  const jsonLd = buildJobPostingJsonLd({ job, translation, url: canonicalUrl });

  // The detail template embeds the JSON-LD inside a
  // `<script type="application/ld+json">` block, so we hand it
  // through pre-stringified. JSON.stringify here uses the no-op
  // replacer; if the slug or title ever contains characters that
  // break out of a `<script>` tag we rely on Nunjucks autoescape +
  // the application/ld+json mime to keep the embed safe.
  const jsonLdString = JSON.stringify(jsonLd);

  const html = app.view('public/job-detail.njk', {
    locale,
    job,
    translation,
    translationLocale,
    jsonLd,
    jsonLdString,
    canonicalUrl,
    applyUrl: `/${locale}/jobs/${encodeURIComponent(slug)}/apply`,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Fastify plugin registering the Public_Site routes covered by this task.
 *
 * Mounted by `src/server.ts`. The plugin does not declare a prefix —
 * `:locale` lives in the URL itself so each route owns its own path.
 * This keeps the design's `GET /:locale/`, `GET /:locale/about`,
 * `GET /:locale/jobs`, `GET /:locale/jobs/:slug`, `GET /` mapping
 * (Design §6 Public_Site) readable from the route file.
 *
 * SEO endpoints (`/sitemap.xml`, `/robots.txt`) live in a sibling
 * plugin (task 22.3); this file owns the landing, about, jobs list,
 * and job detail routes.
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', (request, reply) => getRoot(request, reply));

  app.get<{ Params: LocaleParams }>(
    '/:locale/',
    (request, reply) => getLanding(app, request, reply),
  );

  app.get<{ Params: LocaleParams }>(
    '/:locale/about',
    (request, reply) => getAbout(app, request, reply),
  );

  app.get<{ Params: LocaleParams; Querystring: Record<string, unknown> }>(
    '/:locale/jobs',
    (request, reply) => getJobsList(app, request, reply),
  );

  app.get<{ Params: LocaleParams & { slug: string } }>(
    '/:locale/jobs/:slug',
    (request, reply) => getJobDetail(app, request, reply),
  );
};

export default publicRoutes;
