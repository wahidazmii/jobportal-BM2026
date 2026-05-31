/**
 * Fastify bootstrap for PT Buana Megah Job Portal (The_Portal).
 *
 * Responsibilities:
 *   - Build a Fastify instance wired to the project pino logger (task 4.3).
 *   - Register `@fastify/helmet` (via the security-headers helper from
 *     task 4.4), `@fastify/cookie`, `@fastify/formbody`.
 *   - Register a Nunjucks-backed view engine that resolves templates from
 *     `src/views`. The `app.view(name, ctx)` helper renders templates.
 *   - Read configuration from `process.env` only (no `.env` file): the
 *     cPanel-managed Passenger environment owns the secrets per Req 1 AC #9.
 *   - Expose `GET /healthz` that runs `SELECT 1` against the MySQL pool with
 *     a 1000 ms timeout and returns 200 on success, 503 on failure.
 *   - Add `onRequest` hook: set `request.id` to a ULID and capture
 *     `request.startTime = Date.now()` (task 49.2).
 *   - Add `onResponse` hook: emit a structured access-log line with
 *     `req_id`, `method`, `route`, `status`, `latency_ms`, `user_id`, `ip`,
 *     `ua` (task 49.2, Design §18.1, Requirements 20.1, 20.2).
 *   - Register `setErrorHandler`: catch unhandled errors, log error + stack,
 *     respond with 500 generic HTML page (no stack trace) (task 49.2,
 *     Requirement 20.5).
 *
 * The `buildApp()` factory is the integration-test seam (returns a Fastify
 * instance without calling `listen`). When this module is the entrypoint
 * (`artifacts/api-server/dist/index.mjs` under Passenger) and `NODE_ENV` is
 * not `test`, we call `listen()` against the configured PORT.
 *
 * Validates: Requirements 1.1, 1.9, 20.1, 20.2, 20.3, 20.5 (Design §2.2, §18.1, §18.2)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import nunjucks from 'nunjucks';

import { t as i18nT, type Locale } from './modules/i18n/resolver.js';

import { logger, genReqId, requestSerializers } from './infra/logger.js';
import { pool } from './infra/db.js';
import { checkRequiredEnvVars } from './infra/startup-check.js';
import { registerSecurityHeaders } from './infra/security-headers.js';
import { authRoutes } from './routes/auth.js';
import passwordRoutes from './routes/password.js';
import applicantRoutes from './routes/applicant.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import seoRoutes from './routes/seo.js';

/** Directory holding `src/server.ts` — used to resolve view templates. */
const projectSrcDir = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.join(projectSrcDir, 'views');

/**
 * Configuration read from the cPanel/Passenger environment. Required values
 * fall back to safe development defaults so the dev server (`npm run dev`)
 * stays usable; production deployments must inject real values via
 * "Setup Node.js App" environment variables (Req 1 AC #9).
 */
export interface AppConfig {
  readonly nodeEnv: string;
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly logLevel: string;
}

/** Resolve configuration from `process.env`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const portRaw = env.PORT ?? '3000';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT environment variable: ${portRaw}`);
  }
  return {
    nodeEnv,
    port,
    host: env.HOST ?? '0.0.0.0',
    baseUrl: env.BASE_URL ?? `http://localhost:${port}`,
    databaseUrl: env.DATABASE_URL ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

/**
 * Register a Nunjucks-backed view renderer. Templates are looked up under
 * `src/views`. Autoescape is enabled. Each Fastify instance gets its own
 * `nunjucks.Environment` so test instances stay isolated.
 *
 * The renderer is exposed via `app.view(name, ctx)` which returns the
 * rendered HTML string. We do not use a Fastify view-engine plugin here
 * because @fastify/view's nunjucks adapter is heavyweight; a thin decorator
 * is enough for SSR.
 */
function registerViewEngine(app: FastifyInstance): void {
  const env = nunjucks.configure(viewsDir, {
    autoescape: true,
    noCache: process.env.NODE_ENV !== 'production',
    throwOnUndefined: false,
    trimBlocks: true,
    lstripBlocks: true,
  });

  /**
   * Nunjucks `t` filter — translates a flat key using the active locale.
   *
   * Usage in templates: `{{ 'jobs.title' | t }}`
   *
   * The filter reads `locale` from the template context. If `locale` is
   * not present (e.g. in email templates), it falls back to `'id'`.
   *
   * Validates: Requirements 17.1, 17.3 (Design §13)
   */
  env.addFilter('t', function (this: { ctx?: Record<string, unknown> }, key: string): string {
    const ctx = this.ctx ?? {};
    const locale = (ctx['locale'] as Locale | undefined) ?? 'id';
    return i18nT(key, locale);
  });

  const render = (name: string, context: Record<string, unknown> = {}): string =>
    env.render(name, context);

  app.decorate('view', render);
  app.decorate('viewEnv', env);
}

declare module 'fastify' {
  interface FastifyInstance {
    view: (name: string, context?: Record<string, unknown>) => string;
    viewEnv: nunjucks.Environment;
  }
}

/**
 * Construct a Fastify application instance. Pure factory: does not call
 * `listen()`, which keeps it usable from integration tests (Req 1 AC #1
 * still covered because the production entrypoint below invokes this then
 * listens).
 */
export async function buildApp(config: AppConfig = loadConfig()): Promise<FastifyInstance> {
  // Pino child logger with the Fastify request/response serializers from
  // task 4.3 attached, so request access logs follow Design §18.1 schema.
  const fastifyLogger = logger.child({}, { serializers: requestSerializers });

  // Construct the Fastify instance with the pre-built pino logger. The
  // result narrows the Logger generic to the concrete `pino.Logger` type;
  // we widen it back to the default `FastifyBaseLogger` so the public
  // surface (and downstream plugins/tests) sees the canonical
  // `FastifyInstance` shape.
  const app = Fastify({
    logger: fastifyLogger,
    genReqId,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024, // 5 MB
  }) as unknown as FastifyInstance;

  // Plugins ----------------------------------------------------------------
  // Helmet + CSP nonce + HSTS / X-Frame-Options / Referrer-Policy etc. The
  // canonical implementation lives in `infra/security-headers.ts` (task 4.4)
  // so the policy stays in one place.
  await registerSecurityHeaders(app);

  // Cookies: session + csrf cookies are read/written by downstream middleware.
  await app.register(cookie, {
    secret: config.sessionSecret || undefined,
    parseOptions: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      path: '/',
    },
  });

  // application/x-www-form-urlencoded body parsing for SSR forms.
  await app.register(formbody);

  // Multipart upload parsing for the CV pipeline (task 17.1). The 5 MiB
  // file-size cap mirrors Req 4 AC #7 — `@fastify/multipart` enforces it
  // at the busboy layer so an oversize body is rejected without ever
  // reaching the disk. `files: 1` constrains the form to a single file
  // part, matching the `<input type="file" name="cv">` contract on the
  // upload form. The CV ingestion pipeline lives in
  // `src/modules/applicant/cv.ts` and is invoked from the route plugin.
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
      // Defensive: keep field counts low so a malicious form cannot
      // burn memory before busboy aborts. The CV form only carries
      // `_csrf` plus the file part.
      fields: 4,
      fieldSize: 1024,
      headerPairs: 32,
    },
  });

  // Views: Nunjucks lookup at src/views.
  registerViewEngine(app);

  // -------------------------------------------------------------------------
  // Request lifecycle hooks (task 49.2)
  // -------------------------------------------------------------------------

  /**
   * onRequest: assign a ULID as the canonical request id and capture the
   * start timestamp for latency computation.
   *
   * Fastify already calls `genReqId` (configured above) to set `request.id`
   * before the first `onRequest` hook fires, so `request.id` is already a
   * ULID here. We only need to record `startTime`.
   *
   * Validates: Requirements 20.1, 20.2 (Design §18.1)
   */
  app.addHook('onRequest', async (request) => {
    request.startTime = Date.now();
  });

  /**
   * onResponse: emit a structured access-log line after the response is sent.
   *
   * Fields emitted (Design §18.1):
   *   req_id     — ULID set by genReqId
   *   method     — HTTP verb
   *   route      — matched route pattern (e.g. "/id/jobs") or raw URL for 404s
   *   status     — HTTP status code
   *   latency_ms — elapsed ms since onRequest
   *   user_id    — authenticated user id from session, or null
   *   ip         — client IP (respects trustProxy)
   *   ua         — User-Agent header, or null
   *
   * Validates: Requirements 20.1, 20.2 (Design §18.1)
   */
  app.addHook('onResponse', async (request, reply) => {
    const routeOptions = (request as { routeOptions?: { url?: string } }).routeOptions;
    const route = routeOptions?.url ?? request.url;
    app.log.info({
      req_id: request.id,
      method: request.method,
      route,
      status: reply.statusCode,
      latency_ms: Date.now() - (request.startTime ?? 0),
      user_id: request.session?.userId ?? null,
      ip: request.ip,
      ua: (request.headers['user-agent'] as string | undefined) ?? null,
    }, 'request completed');
  });

  /**
   * setErrorHandler: catch all unhandled errors thrown by route handlers.
   *
   * - Logs the error at `error` level with `req_id`, `err.message`, and
   *   `err.stack` so the full trace is available in the Passenger log.
   * - Responds with HTTP 500 and a generic HTML page. The stack trace is
   *   intentionally omitted from the response body (Requirement 20.5).
   * - Uses `src/views/errors/500.njk` when the view engine is available;
   *   falls back to an inline HTML string so the handler is self-contained.
   *
   * Validates: Requirement 20.5 (Design §18.1)
   */
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    app.log.error({
      req_id: request.id,
      err: {
        message: error.message,
        stack: error.stack,
      },
    }, 'unhandled error');

    // If the reply has already been sent (e.g. by a streaming handler that
    // errored mid-stream) we cannot send another response.
    if (reply.sent) return;

    // Attempt to render the Nunjucks 500 page; fall back to inline HTML.
    let body: string;
    try {
      body = app.view('errors/500.njk');
    } catch {
      body = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
<title>500 – Terjadi Kesalahan</title></head><body>
<h1>500</h1><p>An unexpected error occurred. Please try again.</p>
</body></html>`;
    }

    await reply
      .code(500)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(body);
  });

  // Routes -----------------------------------------------------------------
  // GET /healthz — liveness/readiness probe required by Req 20.3 and
  // documented in Design §18.2. Runs `SELECT 1` against the MySQL pool with
  // a 1000 ms timeout. Returns 200 on success, 503 on any failure.
  app.get('/healthz', async (_request, reply) => {
    try {
      await pool.query({ sql: 'SELECT 1', timeout: 1000 });
      return reply.code(200).send({ status: 'ok' });
    } catch (err) {
      app.log.warn({ err }, 'healthz: db unreachable');
      return reply.code(503).send({ status: 'db_unreachable' });
    }
  });

  // Password-reset routes (task 11.1). Registered as a plugin so future
  // task 11.2 can append GET / :token endpoints to the same module.
  await app.register(passwordRoutes);

  // Public_Site routes (task 22.4): root redirect (`/` → `/id/`),
  // landing page (`/:locale/`), and the company about page
  // (`/:locale/about`). Registered AFTER the `/healthz` and
  // `/sitemap.xml` (task 22.3) handlers so the catch-all-looking
  // `/` redirect cannot shadow them. Each public route here is
  // individually scoped to a literal path segment, so in practice
  // Fastify's radix tree would route `/healthz` correctly regardless
  // of registration order — but ordering it after operational
  // endpoints documents the intent clearly.
  await app.register(publicRoutes);

  // Auth routes (task 9.2): GET/POST /:locale/register today; login,
  // logout, and verify (tasks 9.3, 10.1, 10.2) will plug in to the same
  // plugin in subsequent commits.
  await app.register(authRoutes);

  // Applicant_Area routes (task 16.1+). Currently mounts:
  //   - GET/POST /:locale/me/profile
  // Subsequent Phase-3 tasks (education, experience, skills, CV, alerts,
  // bookmarks) extend the same plugin.
  await app.register(applicantRoutes);

  // Admin_Console routes (task 21.3). Mounts the job CRUD endpoints
  // under `/admin/jobs/...` (no locale prefix — admin pages are not
  // localized in this MVP). Subsequent admin tasks (kanban,
  // applications, audit, users, reports) extend the same module.
  await app.register(adminRoutes);

  // SEO endpoints (task 22.3). Registers `/sitemap.xml` and
  // `/robots.txt` at the application root so crawlers find them at
  // the canonical origin paths. The plugin manages its own
  // in-memory cache (5 min for sitemap, 1 hour for robots) so this
  // call has no per-request DB cost beyond the initial generation.
  await app.register(seoRoutes);

  return app;
}

/**
 * Production / Passenger entrypoint.
 *
 * Passenger imports `artifacts/api-server/dist/index.mjs` (esbuild output of
 * this file) and expects the module side-effect to start the HTTP listener.
 * We skip listen() under NODE_ENV=test so vitest can `await buildApp()`
 * without binding a socket.
 */
async function main(): Promise<void> {
  // Fail fast in production if required env vars are missing (Design §21,
  // Req 1 AC #9). Must run before buildApp() so the pool and session store
  // never start with empty credentials.
  checkRequiredEnvVars();

  const config = loadConfig();
  const app = await buildApp(config);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
    } catch (err) {
      app.log.error({ err }, 'shutdown error');
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error({ err }, 'failed to start http server');
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
