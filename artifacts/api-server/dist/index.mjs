// src/server.ts
import path5 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import nunjucks3 from "nunjucks";

// src/modules/i18n/resolver.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var SUPPORTED_LOCALES = ["id", "en"];
var _SUPPORTED_LOCALES_SET = new Set(SUPPORTED_LOCALES);
var DEFAULT_LOCALE = "id";
var translationCache = /* @__PURE__ */ new Map();
function localesDir() {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "..", "locales");
}
function loadTranslations(locale) {
  const cached = translationCache.get(locale);
  if (cached !== void 0) return cached;
  const filePath = path.join(localesDir(), `${locale}.json`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  translationCache.set(locale, parsed);
  return parsed;
}
function t(key, locale) {
  const translations = loadTranslations(locale);
  if (translations[key] !== void 0) return translations[key];
  if (locale !== DEFAULT_LOCALE) {
    const idTranslations = loadTranslations(DEFAULT_LOCALE);
    if (idTranslations[key] !== void 0) return idTranslations[key];
  }
  return key;
}

// src/infra/logger.ts
import { pino } from "pino";
import { ulid } from "ulid";
var isProduction = process.env.NODE_ENV === "production";
var loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProduction ? void 0 : {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname"
    }
  }
};
var logger = pino(loggerOptions);
var genReqId = () => ulid();
var resolveRoute = (request) => {
  const routeOptions = request.routeOptions;
  if (routeOptions?.url) {
    return routeOptions.url;
  }
  const legacyRouterPath = request.routerPath;
  if (legacyRouterPath) {
    return legacyRouterPath;
  }
  return request.url;
};
var requestSerializers = {
  req(request) {
    return {
      id: request.id,
      method: request.method,
      url: request.url,
      route: resolveRoute(request),
      ip: request.ip
    };
  },
  res(reply) {
    return {
      statusCode: reply.statusCode
    };
  }
};

// src/infra/db.ts
import mysql from "mysql2/promise";
function resolveDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (raw && raw.trim() !== "") {
    return raw;
  }
  if (nodeEnv === "production") {
    throw new Error(
      'DATABASE_URL is required when NODE_ENV=production but was not set. Configure it via the cPanel "Setup Node.js App" environment variables (Req 1 AC #9).'
    );
  }
  if (nodeEnv === "test") {
    return "mysql://test:test@127.0.0.1:3306/ptk_test";
  }
  return "mysql://localhost/placeholder";
}
var POOL_OPTIONS = {
  connectionLimit: 10,
  queueLimit: 50,
  waitForConnections: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  namedPlaceholders: true,
  timezone: "Z",
  decimalNumbers: true
};
var pool = mysql.createPool({
  uri: resolveDatabaseUrl(),
  ...POOL_OPTIONS
});
async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}
async function withTransaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (err) {
      try {
        await connection.rollback();
      } catch {
      }
      throw err;
    }
  } finally {
    connection.release();
  }
}

// src/infra/startup-check.ts
var REQUIRED_PRODUCTION_VARS = ["DATABASE_URL", "SESSION_SECRET", "BASE_URL"];
function checkRequiredEnvVars(env = process.env) {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const missing = [];
  for (const name of REQUIRED_PRODUCTION_VARS) {
    const value = env[name];
    if (value === void 0 || value.trim() === "") {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[startup-check] Missing required environment variable(s) for production: ${missing.join(", ")}. Set these in cPanel \u2192 Setup Node.js App \u2192 Environment Variables and restart Passenger (touch tmp/restart.txt).`
    );
  }
}

// src/infra/security-headers.ts
import { randomBytes } from "node:crypto";
import fastifyHelmet from "@fastify/helmet";
function generateCspNonce() {
  return randomBytes(16).toString("base64");
}
async function registerSecurityHeaders(app) {
  app.addHook("onRequest", async (request) => {
    const nonce = generateCspNonce();
    request.cspNonce = nonce;
    request.raw.cspNonce = nonce;
  });
  await app.register(fastifyHelmet, {
    // We declare every directive explicitly per design §19, so disable the
    // helmet built-in CSP defaults (which would inject extras like
    // `upgrade-insecure-requests` and `object-src 'none'`).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: [`'self'`],
        scriptSrc: [
          `'self'`,
          (req) => {
            const nonce = req.cspNonce ?? "";
            return `'nonce-${nonce}'`;
          }
        ],
        styleSrc: [`'self'`, `'unsafe-inline'`],
        imgSrc: [`'self'`, `data:`],
        frameAncestors: [`'none'`],
        formAction: [`'self'`],
        baseUri: [`'self'`]
      }
    },
    hsts: {
      maxAge: 31536e3,
      includeSubDomains: true,
      preload: true
    },
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // Cross-origin and origin-isolation headers are out of scope for §19 and
    // would conflict with htmx fragments served from the same origin. Disable
    // them so the response set matches the design exactly.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false
    // We set Permissions-Policy ourselves below; helmet's option here is a
    // no-op pass-through so leaving it disabled is fine.
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Permissions-Policy", "");
    return payload;
  });
}

// src/routes/auth.ts
import { ZodError } from "zod";

// src/infra/rate-limit.ts
var REGISTER_BUCKET_PREFIX = "register:ip:";
var REGISTER_LIMIT = 5;
var REGISTER_WINDOW_SECONDS = 60 * 60;
var VERIFY_RESEND_BUCKET_PREFIX = "verify-resend:ip:";
var VERIFY_RESEND_LIMIT = 5;
var VERIFY_RESEND_WINDOW_SECONDS = 60 * 60;
var MAX_BUCKET_LENGTH = 64;
function assertBucket(bucket) {
  if (typeof bucket !== "string" || bucket.length === 0) {
    throw new TypeError("rate-limit: bucket must be a non-empty string");
  }
  if (bucket.length > MAX_BUCKET_LENGTH) {
    throw new RangeError(
      `rate-limit: bucket length ${bucket.length} exceeds ${MAX_BUCKET_LENGTH}`
    );
  }
}
function assertOptions(opts) {
  if (!Number.isInteger(opts.max) || opts.max <= 0) {
    throw new RangeError("rate-limit: `max` must be a positive integer");
  }
  if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds <= 0) {
    throw new RangeError("rate-limit: `windowSeconds` must be a positive integer");
  }
}
async function checkRateLimit(bucket, opts) {
  assertBucket(bucket);
  assertOptions(opts);
  const rows = await query(
    "SELECT count, TIMESTAMPDIFF(SECOND, window_started_at, NOW()) AS age_seconds FROM rate_limits WHERE bucket = ? LIMIT 1",
    [bucket]
  );
  if (rows.length === 0) {
    return { allowed: true };
  }
  const row = rows[0];
  const age = Number(row.age_seconds);
  const count = Number(row.count);
  if (!Number.isFinite(age) || age >= opts.windowSeconds) {
    return { allowed: true };
  }
  if (count < opts.max) {
    return { allowed: true };
  }
  const remaining = Math.max(1, opts.windowSeconds - age);
  return { allowed: false, retryAfterSec: remaining };
}
async function recordHit(bucket, opts) {
  assertBucket(bucket);
  if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds <= 0) {
    throw new RangeError("rate-limit: `windowSeconds` must be a positive integer");
  }
  await query(
    "INSERT INTO rate_limits (bucket, count, window_started_at) VALUES (?, 1, NOW()) ON DUPLICATE KEY UPDATE count = IF(TIMESTAMPDIFF(SECOND, window_started_at, NOW()) >= ?, 1, count + 1), window_started_at = IF(TIMESTAMPDIFF(SECOND, window_started_at, NOW()) >= ?, NOW(), window_started_at)",
    [bucket, opts.windowSeconds, opts.windowSeconds]
  );
}

// src/modules/auth/captcha.ts
var DEFAULT_HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify";
var VERIFY_TIMEOUT_MS = 5e3;
async function verifyCaptcha(token, remoteIp) {
  if (typeof token !== "string" || token.trim() === "") {
    return false;
  }
  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret || secret.trim() === "") {
    if ((process.env.NODE_ENV ?? "development") === "production") {
      logger.warn(
        "auth.captcha: HCAPTCHA_SECRET is unset in production \u2014 failing closed"
      );
      return false;
    }
    return true;
  }
  const verifyUrl = process.env.HCAPTCHA_VERIFY_URL ?? DEFAULT_HCAPTCHA_VERIFY_URL;
  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);
  if (remoteIp && remoteIp.trim() !== "") {
    params.set("remoteip", remoteIp);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const resp = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        "auth.captcha: hCaptcha siteverify returned non-2xx"
      );
      return false;
    }
    const data = await resp.json();
    if (data.success === true) {
      return true;
    }
    logger.info(
      { error_codes: data["error-codes"] ?? [] },
      "auth.captcha: hCaptcha rejected the token"
    );
    return false;
  } catch (err) {
    logger.warn({ err }, "auth.captcha: hCaptcha verify request failed");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// src/modules/auth/login.ts
import bcrypt from "bcrypt";
import { z } from "zod";

// src/infra/session-store.ts
import { randomBytes as randomBytes2 } from "node:crypto";
var TOKEN_BYTES = 32;
var TOKEN_LENGTH = 43;
var IDLE_TIMEOUT_MINUTES = 30;
var IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60 * 1e3;
var ABSOLUTE_TIMEOUT_HOURS = 12;
var ABSOLUTE_TIMEOUT_MS = ABSOLUTE_TIMEOUT_HOURS * 60 * 60 * 1e3;
var SESSION_COOKIE_NAME = "__Host-sid";
var CSRF_COOKIE_NAME = "csrf_token";
var SESSION_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/"
});
function generateToken() {
  return randomBytes2(TOKEN_BYTES).toString("base64url");
}
var INSERT_SESSION_SQL = "INSERT INTO sessions (id, user_id, csrf_token, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL 12 HOUR)";
var SELECT_SESSION_SQL = "SELECT s.id AS sid, s.user_id AS userId, u.role AS role, s.csrf_token AS csrfToken, s.created_at AS createdAt, s.last_active_at AS lastActiveAt, s.expires_at AS expiresAt, s.ip_address AS ipAddress, s.user_agent AS userAgent FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?   AND s.expires_at > NOW()   AND s.last_active_at >= NOW() - INTERVAL 30 MINUTE LIMIT 1";
var DELETE_SESSION_SQL = "DELETE FROM sessions WHERE id = ?";
var DELETE_USER_SESSIONS_SQL = "DELETE FROM sessions WHERE user_id = ?";
async function create(userId, role, meta = {}) {
  const sid = generateToken();
  const csrfToken = generateToken();
  const ipAddress = meta.ipAddress ?? null;
  const userAgent = meta.userAgent ?? null;
  await query(INSERT_SESSION_SQL, [
    sid,
    userId,
    csrfToken,
    ipAddress,
    userAgent
  ]);
  const fresh = await read(sid);
  if (!fresh) {
    throw new Error("session-store: created session not visible after insert");
  }
  return { ...fresh, role };
}
async function read(sid) {
  if (typeof sid !== "string" || sid.length !== TOKEN_LENGTH) {
    return null;
  }
  const rows = await query(SELECT_SESSION_SQL, [sid]);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    sid: row.sid,
    userId: Number(row.userId),
    role: row.role,
    csrfToken: row.csrfToken,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    expiresAt: row.expiresAt,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent
  };
}
async function destroy(sid) {
  if (typeof sid !== "string" || sid.length !== TOKEN_LENGTH) {
    return;
  }
  await query(DELETE_SESSION_SQL, [sid]);
}
async function revokeAllForUser(userId) {
  const result = await query(DELETE_USER_SESSIONS_SQL, [
    userId
  ]);
  return result.affectedRows;
}

// src/modules/auth/login.ts
var LOCKOUT_MAX_FAILURES = 5;
var LOCKOUT_WINDOW_MINUTES = 15;
var LOCKOUT_WINDOW_SECONDS = LOCKOUT_WINDOW_MINUTES * 60;
var MAX_PASSWORD_LENGTH = 128;
var EMAIL_MAX_LEN = 254;
var REDIRECT_APPLICANT_PREFIX = "/me";
var REDIRECT_ADMIN = "/admin";
var loginSchema = z.object({
  email: z.string({ required_error: "Email is required" }).trim().max(EMAIL_MAX_LEN, { message: "Email is too long" }).min(1, { message: "Email is required" }).transform((v) => v.toLowerCase()),
  password: z.string({ required_error: "Password is required" }).min(1, { message: "Password is required" }).max(MAX_PASSWORD_LENGTH, { message: "Password is too long" })
}).strict();
var SELECT_LOCKOUT_SQL = "SELECT COUNT(*) AS failure_count,   GREATEST(1, COALESCE(    TIMESTAMPDIFF(SECOND, NOW(), MIN(attempt_at) + INTERVAL 15 MINUTE), 0  )) AS retry_after_seconds FROM login_attempts WHERE email = ?   AND success = 0   AND attempt_at >= NOW() - INTERVAL 15 MINUTE";
var SELECT_USER_SQL = "SELECT id, password_hash, role, status FROM users WHERE email = ? LIMIT 1";
var INSERT_ATTEMPT_SQL = "INSERT INTO login_attempts (email, ip_address, success) VALUES (?, ?, ?)";
var timingDummyHashPromise = null;
function getTimingDummyHash() {
  if (timingDummyHashPromise === null) {
    timingDummyHashPromise = bcrypt.hash(
      "login-timing-equaliser-not-a-real-password",
      12
    );
  }
  return timingDummyHashPromise;
}
function redirectForRole(role) {
  return role === "Applicant" ? REDIRECT_APPLICANT_PREFIX : REDIRECT_ADMIN;
}
async function checkLockout(email) {
  const rows = await query(SELECT_LOCKOUT_SQL, [email]);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const failureCount = Number(row.failure_count);
  if (!Number.isFinite(failureCount) || failureCount <= LOCKOUT_MAX_FAILURES) {
    return null;
  }
  const rawRetry = row.retry_after_seconds;
  const retryAfterSeconds = rawRetry === null || rawRetry === void 0 ? LOCKOUT_WINDOW_SECONDS : Math.max(1, Number(rawRetry));
  return { status: "locked", retryAfterSeconds };
}
async function recordAttempt(email, ipAddress, success) {
  await query(INSERT_ATTEMPT_SQL, [
    email,
    ipAddress,
    success ? 1 : 0
  ]);
}
async function login(rawInput, ctx) {
  const input = loginSchema.parse(rawInput);
  const locked = await checkLockout(input.email);
  if (locked !== null) {
    logger.warn(
      {
        email_domain: input.email.split("@")[1] ?? "",
        retry_after_seconds: locked.retryAfterSeconds
      },
      "auth.login: lockout active \u2014 rejected with 429"
    );
    return locked;
  }
  const userRows = await query(SELECT_USER_SQL, [input.email]);
  const user = userRows[0] ?? null;
  const compareHash = user !== null && user.status === "active" ? user.password_hash : await getTimingDummyHash();
  let passwordMatches = false;
  try {
    passwordMatches = await bcrypt.compare(input.password, compareHash);
  } catch (err) {
    logger.error(
      { err, user_id: user?.id },
      "auth.login: bcrypt.compare threw \u2014 treating as invalid_credentials"
    );
    passwordMatches = false;
  }
  const isAuthorised = passwordMatches && user !== null && user.status === "active";
  if (!isAuthorised) {
    await recordAttempt(input.email, ctx.ipAddress, false);
    return { status: "invalid_credentials" };
  }
  await recordAttempt(input.email, ctx.ipAddress, true);
  const userId = Number(user.id);
  const sessionMeta = {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent ?? null
  };
  const session = await create(userId, user.role, sessionMeta);
  logger.info(
    { user_id: userId, role: user.role, sid_prefix: session.sid.slice(0, 8) },
    "auth.login: session created"
  );
  return {
    status: "success",
    userId,
    role: user.role,
    session,
    redirectTo: redirectForRole(user.role)
  };
}

// src/modules/auth/register.ts
import { randomBytes as randomBytes3 } from "node:crypto";
import bcrypt2 from "bcrypt";
import { z as z2 } from "zod";
import { ulid as ulid2 } from "ulid";

// src/modules/mail/service.ts
import { readFile } from "node:fs/promises";
import path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import nunjucks from "nunjucks";
var MailTemplateMissingError = class extends Error {
  constructor(templateKey, locale) {
    super(`No mail template found for "${templateKey}" (${locale})`);
    this.templateKey = templateKey;
    this.locale = locale;
    this.name = "MailTemplateMissingError";
  }
  code = "mail_template_missing";
};
var EMAILS_DIR = path2.resolve(
  path2.dirname(fileURLToPath2(import.meta.url)),
  "..",
  "..",
  "views",
  "emails"
);
var SELECT_MAIL_TEMPLATE_SQL = [
  "SELECT subject, body_html, body_text",
  "FROM mail_templates",
  "WHERE `key` = ? AND locale = ? LIMIT 1"
].join(" ");
async function readChannelFile(fileName) {
  try {
    return await readFile(path2.join(EMAILS_DIR, fileName), "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
async function loadFsTemplate(templateKey) {
  const [subject, bodyHtml, bodyText] = await Promise.all([
    readChannelFile(`${templateKey}.subject.njk`),
    readChannelFile(`${templateKey}.html.njk`),
    readChannelFile(`${templateKey}.text.njk`)
  ]);
  if (subject === null || bodyHtml === null) {
    return null;
  }
  return { subject, bodyHtml, bodyText };
}
async function resolveTemplate(connection, templateKey, locale) {
  const [rows] = await connection.execute(
    SELECT_MAIL_TEMPLATE_SQL,
    [templateKey, locale]
  );
  const dbRow = rows[0];
  if (dbRow) {
    return {
      subject: dbRow.subject,
      bodyHtml: dbRow.body_html,
      bodyText: dbRow.body_text
    };
  }
  const fsTemplate = await loadFsTemplate(templateKey);
  if (fsTemplate) {
    return fsTemplate;
  }
  throw new MailTemplateMissingError(templateKey, locale);
}
function htmlToPlainText(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
}
function renderTemplate(template, context) {
  const subject = nunjucks.renderString(template.subject, context);
  const bodyHtml = nunjucks.renderString(template.bodyHtml, context);
  const bodyText = template.bodyText !== null ? nunjucks.renderString(template.bodyText, context) : htmlToPlainText(bodyHtml);
  return { subject, bodyHtml, bodyText };
}
var OUTBOX_VALUES_CLAUSE = [
  "(template_key, target_id, to_email, to_name, subject, body_html, body_text, context, status, next_attempt_at, created_at)",
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())"
].join(" ");
var INSERT_IGNORE_OUTBOX_SQL = [
  "INSERT IGNORE INTO mail_outbox",
  OUTBOX_VALUES_CLAUSE
].join(" ");
var INSERT_OUTBOX_SQL = ["INSERT INTO mail_outbox", OUTBOX_VALUES_CLAUSE].join(
  " "
);
async function enqueue(connection, options) {
  const locale = options.locale ?? "id";
  const context = { ...options.context ?? {} };
  const template = await resolveTemplate(connection, options.templateKey, locale);
  const message = renderTemplate(template, context);
  const targetId = options.targetId ?? null;
  const params = [
    options.templateKey,
    targetId,
    options.toEmail,
    options.toName ?? null,
    message.subject,
    message.bodyHtml,
    message.bodyText,
    JSON.stringify(context)
  ];
  const sql = targetId === null ? INSERT_OUTBOX_SQL : INSERT_IGNORE_OUTBOX_SQL;
  const [result] = await connection.execute(sql, params);
  logger.info(
    {
      template_key: options.templateKey,
      to_email: options.toEmail,
      to_name: options.toName ?? null,
      locale,
      target_id: targetId,
      idempotent: targetId !== null,
      // `affectedRows === 0` under INSERT IGNORE means the natural key
      // already existed — a deduped retry, not an error.
      affected_rows: result.affectedRows,
      deduped: targetId !== null && result.affectedRows === 0
    },
    "mail.enqueue"
  );
}

// src/modules/auth/register.ts
var BCRYPT_COST = 12;
var MIN_PASSWORD_LENGTH = 10;
var MAX_PASSWORD_LENGTH2 = 128;
var VERIFICATION_TOKEN_HOURS = 24;
var TOKEN_BYTES2 = 32;
function activePolicyVersion() {
  const raw = process.env.PRIVACY_POLICY_VERSION;
  return raw && raw.trim() !== "" ? raw.trim() : "v1";
}
var EMAIL_MAX_LEN2 = 254;
var passwordSchema = z2.string({ required_error: "Password is required" }).min(MIN_PASSWORD_LENGTH, {
  message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
}).max(MAX_PASSWORD_LENGTH2, {
  message: `Password must be at most ${MAX_PASSWORD_LENGTH2} characters`
}).refine((pw) => /[A-Za-z]/.test(pw), {
  message: "Password must contain at least one letter"
}).refine((pw) => /\d/.test(pw), {
  message: "Password must contain at least one digit"
});
var consentSchema = z2.boolean({
  required_error: "You must accept the privacy policy to continue",
  invalid_type_error: "Consent must be true or false"
}).refine((v) => v === true, {
  message: "You must accept the privacy policy to continue"
});
var captchaSchema = z2.string({ required_error: "Captcha verification is required" }).min(1, { message: "Captcha verification is required" }).max(2048, { message: "Captcha token is too long" });
var registerSchema = z2.object({
  email: z2.string({ required_error: "Email is required" }).trim().max(EMAIL_MAX_LEN2, { message: "Email is too long" }).email({ message: "Please enter a valid email address" }).transform((v) => v.toLowerCase()),
  password: passwordSchema,
  consent: consentSchema,
  captchaToken: captchaSchema
}).strict();
function generateVerificationToken() {
  return randomBytes3(TOKEN_BYTES2).toString("base64url");
}
function defaultFullNameFromEmail(email) {
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const trimmed = local.trim() === "" ? "New Applicant" : local.trim();
  return trimmed.slice(0, 100);
}
function isDuplicateEntry(err) {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const e = err;
  return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}
async function emailAlreadyExists(connection, email) {
  const [rows] = await connection.execute(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  return rows.length > 0;
}
async function register(rawInput, ctx = {}) {
  const input = registerSchema.parse(rawInput);
  const passwordHash = await bcrypt2.hash(input.password, BCRYPT_COST);
  const userUuid = ulid2();
  const verificationToken = generateVerificationToken();
  return withTransaction(async (connection) => {
    if (await emailAlreadyExists(connection, input.email)) {
      logger.info(
        { email_domain: input.email.split("@")[1] ?? "" },
        "auth.register: duplicate email \u2014 generic no-op response"
      );
      return { ok: true, alreadyRegistered: true };
    }
    try {
      const userResult = await connection.execute(
        "INSERT INTO users (uuid, email, password_hash, role, status) VALUES (?, ?, ?, 'Applicant', 'pending')",
        [userUuid, input.email, passwordHash]
      );
      const insertId = userResult[0].insertId;
      if (!insertId || insertId <= 0) {
        throw new Error("auth.register: missing insertId after users INSERT");
      }
      const userId = Number(insertId);
      await connection.execute(
        "INSERT INTO applicants (user_id, full_name) VALUES (?, ?)",
        [userId, defaultFullNameFromEmail(input.email)]
      );
      await connection.execute(
        "INSERT INTO consent_records (applicant_user_id, policy_version, ip_address) VALUES (?, ?, ?)",
        [userId, activePolicyVersion(), ctx.ipAddress ?? null]
      );
      await connection.execute(
        "INSERT INTO verification_tokens (token, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 24 HOUR)",
        [verificationToken, userId]
      );
      await enqueue(connection, {
        templateKey: "verify",
        toEmail: input.email,
        targetId: String(userId),
        context: {
          token: verificationToken,
          expires_in_hours: VERIFICATION_TOKEN_HOURS,
          policy_version: activePolicyVersion()
        }
      });
      logger.info(
        { user_id: userId },
        "auth.register: applicant created in pending state"
      );
      return { ok: true, alreadyRegistered: false };
    } catch (err) {
      if (isDuplicateEntry(err)) {
        logger.info(
          { email_domain: input.email.split("@")[1] ?? "" },
          "auth.register: duplicate-entry race \u2014 generic no-op response"
        );
        return { ok: true, alreadyRegistered: true };
      }
      throw err;
    }
  });
}

// src/modules/auth/verify.ts
import { randomBytes as randomBytes4 } from "node:crypto";
import { z as z3 } from "zod";
var VERIFICATION_TOKEN_HOURS2 = 24;
var TOKEN_BYTES3 = 32;
var EMAIL_MAX_LEN3 = 254;
var VERIFY_TEMPLATE_KEY = "verify";
var verifyTokenSchema = z3.string({ required_error: "Verification token is required" }).min(1, { message: "Verification token is required" }).max(64, { message: "Verification token is too long" }).regex(/^[A-Za-z0-9_-]+$/, {
  message: "Verification token contains invalid characters"
});
var captchaSchema2 = z3.string({ required_error: "Captcha verification is required" }).min(1, { message: "Captcha verification is required" }).max(2048, { message: "Captcha token is too long" });
var resendSchema = z3.object({
  email: z3.string({ required_error: "Email is required" }).trim().max(EMAIL_MAX_LEN3, { message: "Email is too long" }).email({ message: "Please enter a valid email address" }).transform((v) => v.toLowerCase()),
  captchaToken: captchaSchema2
}).strict();
function generateVerificationToken2() {
  return randomBytes4(TOKEN_BYTES3).toString("base64url");
}
async function consumeVerificationToken(rawToken) {
  const parsed = verifyTokenSchema.safeParse(rawToken);
  if (!parsed.success) {
    return { status: "invalid" };
  }
  const token = parsed.data;
  return withTransaction(async (connection) => {
    const [tokenRows] = await connection.execute(
      "SELECT user_id FROM verification_tokens WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1 FOR UPDATE",
      [token]
    );
    if (tokenRows.length === 0) {
      return { status: "invalid" };
    }
    const userId = Number(tokenRows[0].user_id);
    await connection.execute(
      "UPDATE users SET status = 'active', email_verified_at = NOW() WHERE id = ? AND status = 'pending'",
      [userId]
    );
    await connection.execute(
      "UPDATE verification_tokens SET used_at = NOW() WHERE token = ?",
      [token]
    );
    logger.info(
      { user_id: userId },
      "auth.verify: account activated and token consumed"
    );
    return { status: "verified", userId };
  });
}
async function resendVerificationEmail(rawInput, ctx = {}) {
  const input = resendSchema.parse(rawInput);
  const token = generateVerificationToken2();
  return withTransaction(async (connection) => {
    const userId = await findPendingUserId(connection, input.email);
    if (userId === null) {
      logger.info(
        {
          email_domain: input.email.split("@")[1] ?? "",
          ip: ctx.ipAddress ?? null
        },
        "auth.verify-resend: not pending \u2014 generic no-op response"
      );
      return { ok: true, tokenIssued: false };
    }
    await connection.execute(
      "UPDATE verification_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL",
      [userId]
    );
    await connection.execute(
      "INSERT INTO verification_tokens (token, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 24 HOUR)",
      [token, userId]
    );
    await enqueue(connection, {
      templateKey: VERIFY_TEMPLATE_KEY,
      toEmail: input.email,
      targetId: `${userId}:${token}`,
      context: {
        token,
        expires_in_hours: VERIFICATION_TOKEN_HOURS2
      }
    });
    logger.info(
      { user_id: userId },
      "auth.verify-resend: fresh verification token issued"
    );
    return { ok: true, tokenIssued: true };
  });
}
async function findPendingUserId(connection, email) {
  const [rows] = await connection.execute(
    "SELECT id, status FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (row.status !== "pending") {
    return null;
  }
  return Number(row.id);
}

// src/infra/csrf.ts
var CSRF_COOKIE_OPTIONS = Object.freeze({
  httpOnly: false,
  secure: true,
  sameSite: "lax",
  path: "/"
});
function setCsrfCookie(reply, token) {
  return reply.setCookie(CSRF_COOKIE_NAME, token, CSRF_COOKIE_OPTIONS);
}

// src/routes/auth.ts
var SUPPORTED_LOCALES2 = /* @__PURE__ */ new Set(["id", "en"]);
var HCAPTCHA_BODY_FIELD = "h-captcha-response";
function asString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string");
    return first;
  }
  return void 0;
}
function coerceConsent(value) {
  const s = asString(value);
  if (s === void 0) return false;
  const lowered = s.toLowerCase();
  return lowered === "on" || lowered === "true" || lowered === "1";
}
function readCaptchaToken(body) {
  if (!body) return "";
  const direct = asString(body.captchaToken);
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct.trim();
  }
  const widget = asString(body[HCAPTCHA_BODY_FIELD]);
  return typeof widget === "string" ? widget.trim() : "";
}
function resolveLocale(request) {
  const raw = request.params.locale;
  return SUPPORTED_LOCALES2.has(raw) ? raw : "id";
}
function bucketForIp(ip) {
  const safeIp = ip.slice(0, 50);
  return `${REGISTER_BUCKET_PREFIX}${safeIp}`;
}
function bucketForVerifyResend(ip) {
  const safeIp = ip.slice(0, 40);
  return `${VERIFY_RESEND_BUCKET_PREFIX}${safeIp}`;
}
function retryAfterHeader(seconds) {
  return String(Math.max(1, Math.ceil(seconds)));
}
async function getRegister(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const decision = await checkRateLimit(bucketForIp(request.ip), {
    max: REGISTER_LIMIT,
    windowSeconds: REGISTER_WINDOW_SECONDS
  });
  if (!decision.allowed && decision.retryAfterSec !== void 0) {
    reply.header("Retry-After", retryAfterHeader(decision.retryAfterSec));
    const html2 = app.view("public/too-many-requests.njk", {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce
    });
    return reply.code(429).type("text/html; charset=utf-8").send(html2);
  }
  const html = app.view("public/register.njk", {
    locale,
    form: { email: "", consent: false },
    errors: {},
    generalError: null,
    hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postRegister(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const bucket = bucketForIp(request.ip);
  const decision = await checkRateLimit(bucket, {
    max: REGISTER_LIMIT,
    windowSeconds: REGISTER_WINDOW_SECONDS
  });
  if (!decision.allowed && decision.retryAfterSec !== void 0) {
    reply.header("Retry-After", retryAfterHeader(decision.retryAfterSec));
    const html2 = app.view("public/too-many-requests.njk", {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce
    });
    return reply.code(429).type("text/html; charset=utf-8").send(html2);
  }
  const body = request.body ?? {};
  const email = (asString(body.email) ?? "").trim();
  const password = asString(body.password) ?? "";
  const consent = coerceConsent(body.consent);
  const captchaToken = readCaptchaToken(body);
  const renderForm = (statusCode, errors, generalError = null) => {
    const html2 = app.view("public/register.njk", {
      locale,
      form: { email, consent },
      errors,
      generalError,
      hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
      cspNonce: request.cspNonce
    });
    return reply.code(statusCode).type("text/html; charset=utf-8").send(html2);
  };
  const captchaOk = await verifyCaptcha(captchaToken, request.ip);
  if (!captchaOk) {
    app.log.info({ ip: request.ip }, "auth.register: captcha verification failed");
    return renderForm(
      400,
      { captchaToken: ["Captcha verification failed. Please try again."] }
    );
  }
  try {
    await register(
      { email, password, consent, captchaToken: captchaToken || "" },
      { ipAddress: null }
    );
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors = err.flatten().fieldErrors;
      const errors = {};
      for (const [key, msgs] of Object.entries(fieldErrors)) {
        if (msgs && msgs.length > 0) errors[key] = msgs;
      }
      return renderForm(400, errors);
    }
    app.log.error({ err }, "auth.register: unexpected error");
    return renderForm(
      500,
      {},
      "We could not complete your registration. Please try again."
    );
  }
  try {
    await recordHit(bucket, { windowSeconds: REGISTER_WINDOW_SECONDS });
  } catch (err) {
    app.log.warn({ err }, "auth.register: rate-limit recordHit failed");
  }
  const html = app.view("public/register-success.njk", {
    locale,
    email,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getVerify(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const rawToken = asString(request.query?.token);
  let outcome;
  try {
    outcome = await consumeVerificationToken(rawToken);
  } catch (err) {
    app.log.error({ err }, "auth.verify: unexpected error consuming token");
    outcome = { status: "invalid" };
  }
  if (outcome.status === "verified") {
    const html2 = app.view("public/verify-success.njk", {
      locale,
      cspNonce: request.cspNonce
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html2);
  }
  const html = app.view("public/verify-invalid.njk", {
    locale,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postVerifyResend(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const bucket = bucketForVerifyResend(request.ip);
  const decision = await checkRateLimit(bucket, {
    max: VERIFY_RESEND_LIMIT,
    windowSeconds: VERIFY_RESEND_WINDOW_SECONDS
  });
  if (!decision.allowed && decision.retryAfterSec !== void 0) {
    reply.header("Retry-After", retryAfterHeader(decision.retryAfterSec));
    const html2 = app.view("public/too-many-requests.njk", {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce
    });
    return reply.code(429).type("text/html; charset=utf-8").send(html2);
  }
  const body = request.body ?? {};
  const email = (asString(body.email) ?? "").trim();
  const captchaToken = readCaptchaToken(body);
  const renderForm = (statusCode, errors, generalError = null) => {
    const html2 = app.view("public/verify-resend.njk", {
      locale,
      form: { email },
      errors,
      generalError,
      hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
      cspNonce: request.cspNonce
    });
    return reply.code(statusCode).type("text/html; charset=utf-8").send(html2);
  };
  const captchaOk = await verifyCaptcha(captchaToken, request.ip);
  if (!captchaOk) {
    app.log.info(
      { ip: request.ip },
      "auth.verify-resend: captcha verification failed"
    );
    return renderForm(400, {
      captchaToken: ["Captcha verification failed. Please try again."]
    });
  }
  try {
    await resendVerificationEmail(
      { email, captchaToken: captchaToken || "" },
      { ipAddress: request.ip ?? null }
    );
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors = err.flatten().fieldErrors;
      const errors = {};
      for (const [key, msgs] of Object.entries(fieldErrors)) {
        if (msgs && msgs.length > 0) errors[key] = msgs;
      }
      return renderForm(400, errors);
    }
    app.log.error({ err }, "auth.verify-resend: unexpected error");
    return renderForm(
      500,
      {},
      "We could not process your request. Please try again."
    );
  }
  try {
    await recordHit(bucket, { windowSeconds: VERIFY_RESEND_WINDOW_SECONDS });
  } catch (err) {
    app.log.warn({ err }, "auth.verify-resend: rate-limit recordHit failed");
  }
  const html = app.view("public/verify-resend-sent.njk", {
    locale,
    email,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getVerifyResend(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const decision = await checkRateLimit(bucketForVerifyResend(request.ip), {
    max: VERIFY_RESEND_LIMIT,
    windowSeconds: VERIFY_RESEND_WINDOW_SECONDS
  });
  if (!decision.allowed && decision.retryAfterSec !== void 0) {
    reply.header("Retry-After", retryAfterHeader(decision.retryAfterSec));
    const html2 = app.view("public/too-many-requests.njk", {
      locale,
      retryAfterSec: decision.retryAfterSec,
      cspNonce: request.cspNonce
    });
    return reply.code(429).type("text/html; charset=utf-8").send(html2);
  }
  const html = app.view("public/verify-resend.njk", {
    locale,
    form: { email: "" },
    errors: {},
    generalError: null,
    hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY ?? null,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postLogout(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const sid = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid === "string" && sid.length === TOKEN_LENGTH) {
    try {
      await destroy(sid);
    } catch (err) {
      app.log.warn(
        { err, sidPrefix: sid.slice(0, 8) },
        "auth.logout: destroy session failed, clearing cookies anyway"
      );
    }
  }
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE_OPTIONS);
  return reply.code(302).header("location", `/${locale}/`).send();
}
function packIpForLoginAttempt(ip) {
  const safe = typeof ip === "string" ? ip.slice(0, 16) : "";
  const buf = Buffer.alloc(16);
  buf.write(safe, 0, "utf8");
  return buf;
}
async function getLogin(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const html = app.view("public/login.njk", {
    locale,
    form: { email: "" },
    errors: {},
    generalError: null,
    retryAfterSec: null,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postLogin(app, request, reply) {
  if (!SUPPORTED_LOCALES2.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const locale = resolveLocale(request);
  const body = request.body ?? {};
  const email = (asString(body.email) ?? "").trim();
  const password = asString(body.password) ?? "";
  const renderForm = (statusCode, errors, generalError = null, retryAfterSec = null) => {
    if (retryAfterSec !== null) {
      reply.header("Retry-After", retryAfterHeader(retryAfterSec));
    }
    const html = app.view("public/login.njk", {
      locale,
      form: { email },
      errors,
      generalError,
      retryAfterSec,
      cspNonce: request.cspNonce
    });
    return reply.code(statusCode).type("text/html; charset=utf-8").send(html);
  };
  const GENERIC_INVALID = locale === "id" ? "Email atau kata sandi salah." : "Invalid email or password.";
  const GENERIC_LOCKED = locale === "id" ? "Terlalu banyak percobaan gagal. Coba lagi nanti." : "Too many failed attempts. Please try again later.";
  let parsed;
  try {
    parsed = loginSchema.parse({ email, password });
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors = err.flatten().fieldErrors;
      const errors = {};
      for (const [key, msgs] of Object.entries(fieldErrors)) {
        if (msgs && msgs.length > 0) errors[key] = msgs;
      }
      return renderForm(400, errors);
    }
    throw err;
  }
  const ipAddress = packIpForLoginAttempt(request.ip);
  const userAgent = (() => {
    const raw = request.headers["user-agent"];
    if (typeof raw !== "string") return null;
    return raw.slice(0, 255);
  })();
  let outcome;
  try {
    outcome = await login(parsed, { ipAddress, userAgent });
  } catch (err) {
    app.log.error({ err }, "auth.login: unexpected error");
    return renderForm(500, {}, GENERIC_INVALID);
  }
  if (outcome.status === "locked") {
    return renderForm(429, {}, GENERIC_LOCKED, outcome.retryAfterSeconds);
  }
  if (outcome.status === "invalid_credentials") {
    return renderForm(401, {}, GENERIC_INVALID);
  }
  reply.setCookie(
    SESSION_COOKIE_NAME,
    outcome.session.sid,
    SESSION_COOKIE_OPTIONS
  );
  setCsrfCookie(reply, outcome.session.csrfToken);
  const target = outcome.redirectTo === REDIRECT_APPLICANT_PREFIX ? `/${locale}${REDIRECT_APPLICANT_PREFIX}` : REDIRECT_ADMIN;
  return reply.code(302).header("location", target).send();
}
var authRoutes = async (app) => {
  app.get(
    "/:locale/register",
    (request, reply) => getRegister(app, request, reply)
  );
  app.post(
    "/:locale/register",
    (request, reply) => postRegister(app, request, reply)
  );
  app.get(
    "/:locale/verify",
    (request, reply) => getVerify(app, request, reply)
  );
  app.get(
    "/:locale/verify/resend",
    (request, reply) => getVerifyResend(app, request, reply)
  );
  app.post(
    "/:locale/verify/resend",
    (request, reply) => postVerifyResend(app, request, reply)
  );
  app.get(
    "/:locale/login",
    (request, reply) => getLogin(app, request, reply)
  );
  app.post(
    "/:locale/login",
    (request, reply) => postLogin(app, request, reply)
  );
  app.post(
    "/:locale/logout",
    (request, reply) => postLogout(app, request, reply)
  );
};

// src/routes/password.ts
import { z as z5, ZodError as ZodError2 } from "zod";

// src/modules/auth/password-reset.ts
import { randomBytes as randomBytes5 } from "node:crypto";
import bcrypt3 from "bcrypt";
import { z as z4 } from "zod";
var RESET_TOKEN_MINUTES = 60;
var TOKEN_BYTES4 = 32;
var EMAIL_MAX_LEN4 = 254;
var RESET_TEMPLATE_KEY = "reset";
var captchaSchema3 = z4.string({ required_error: "Captcha verification is required" }).min(1, { message: "Captcha verification is required" }).max(2048, { message: "Captcha token is too long" });
var requestResetSchema = z4.object({
  email: z4.string({ required_error: "Email is required" }).trim().max(EMAIL_MAX_LEN4, { message: "Email is too long" }).email({ message: "Please enter a valid email address" }).transform((v) => v.toLowerCase()),
  captchaToken: captchaSchema3
}).strict();
function generateResetToken() {
  return randomBytes5(TOKEN_BYTES4).toString("base64url");
}
async function findEligibleUserId(connection, email) {
  const [rows] = await connection.execute(
    "SELECT id, status FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (row.status !== "active" && row.status !== "pending") {
    return null;
  }
  return Number(row.id);
}
async function requestPasswordReset(rawInput, ctx = {}) {
  const input = requestResetSchema.parse(rawInput);
  const token = generateResetToken();
  return withTransaction(async (connection) => {
    const userId = await findEligibleUserId(connection, input.email);
    if (userId === null) {
      logger.info(
        {
          email_domain: input.email.split("@")[1] ?? "",
          ip: ctx.ipAddress ?? null
        },
        "auth.password-reset: unknown email \u2014 generic no-op response"
      );
      return { ok: true, tokenIssued: false };
    }
    await connection.execute(
      "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 60 MINUTE)",
      [token, userId]
    );
    await enqueue(connection, {
      templateKey: RESET_TEMPLATE_KEY,
      toEmail: input.email,
      targetId: `${userId}:${token}`,
      context: {
        token,
        expires_in_minutes: RESET_TOKEN_MINUTES
      }
    });
    logger.info(
      { user_id: userId },
      "auth.password-reset: reset token issued"
    );
    return { ok: true, tokenIssued: true };
  });
}
var RESET_MIN_PASSWORD_LENGTH = 10;
var RESET_MAX_PASSWORD_LENGTH = 128;
var RESET_BCRYPT_COST = 12;
var TOKEN_STRUCTURAL_RE = /^[A-Za-z0-9_-]{43}$/;
var newPasswordSchema = z4.string({ required_error: "Password is required" }).min(RESET_MIN_PASSWORD_LENGTH, {
  message: `Password must be at least ${RESET_MIN_PASSWORD_LENGTH} characters`
}).max(RESET_MAX_PASSWORD_LENGTH, {
  message: `Password must be at most ${RESET_MAX_PASSWORD_LENGTH} characters`
}).refine((pw) => /[A-Za-z]/.test(pw), {
  message: "Password must contain at least one letter"
}).refine((pw) => /\d/.test(pw), {
  message: "Password must contain at least one digit"
});
var tokenSchema = z4.string({ required_error: "Reset token is required" }).regex(TOKEN_STRUCTURAL_RE, { message: "Invalid reset token format" });
var confirmResetSchema = z4.object({
  token: tokenSchema,
  newPassword: newPasswordSchema
}).strict();
function isStructurallyValidResetToken(token) {
  return typeof token === "string" && TOKEN_STRUCTURAL_RE.test(token);
}
async function lockTokenForConsumption(connection, token) {
  const [rows] = await connection.execute(
    "SELECT user_id FROM password_reset_tokens WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1 FOR UPDATE",
    [token]
  );
  if (rows.length === 0) {
    return null;
  }
  return Number(rows[0].user_id);
}
async function confirmPasswordReset(rawInput) {
  const input = confirmResetSchema.parse(rawInput);
  const newHash = await bcrypt3.hash(input.newPassword, RESET_BCRYPT_COST);
  const txnResult = await withTransaction(
    async (connection) => {
      const userId = await lockTokenForConsumption(connection, input.token);
      if (userId === null) {
        logger.info(
          { event: "password-reset.confirm", outcome: "invalid_token" },
          "auth.password-reset: confirm rejected \u2014 invalid or expired token"
        );
        return { ok: false, reason: "invalid_token" };
      }
      const updUser = await connection.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        [newHash, userId]
      );
      const updUserHeader = updUser[0];
      if (updUserHeader.affectedRows !== 1) {
        logger.warn(
          { user_id: userId },
          "auth.password-reset: confirm could not update user row"
        );
        return { ok: false, reason: "invalid_token" };
      }
      await connection.execute(
        "UPDATE password_reset_tokens SET used_at = NOW() WHERE token = ?",
        [input.token]
      );
      logger.info(
        { user_id: userId, event: "password-reset.confirm" },
        "auth.password-reset: password updated, token consumed"
      );
      return { ok: true, userId };
    }
  );
  if (txnResult.ok) {
    try {
      const revoked = await revokeAllForUser(txnResult.userId);
      logger.info(
        { user_id: txnResult.userId, sessions_revoked: revoked },
        "auth.password-reset: revoked all sessions after password change"
      );
    } catch (err) {
      logger.warn(
        { err, user_id: txnResult.userId },
        "auth.password-reset: session revocation failed after password change"
      );
    }
  }
  return txnResult;
}

// src/routes/password.ts
var GENERIC_RESET_RESPONSE = Object.freeze({
  ok: true,
  message: "If an account exists for that email, a password reset link has been sent. Please check your inbox and spam folder."
});
var LOCALE_PARAM_SCHEMA = z5.object({
  locale: z5.enum(["id", "en"])
});
var CONFIRM_PARAM_SCHEMA = z5.object({
  locale: z5.enum(["id", "en"]),
  token: z5.string()
});
var CONFIRM_BODY_SCHEMA = z5.object({
  newPassword: z5.string({ required_error: "Password is required" })
});
function renderInvalidTokenPage(app, request, reply, locale) {
  const html = app.view("public/password-reset-invalid.njk", {
    locale,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
function renderConfirmForm(app, request, reply, locale, token, errors = {}, generalError = null, statusCode = 200) {
  const html = app.view("public/password-reset-confirm.njk", {
    locale,
    token,
    errors,
    generalError,
    cspNonce: request.cspNonce
  });
  return reply.code(statusCode).type("text/html; charset=utf-8").send(html);
}
function asString2(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}
var passwordRoutes = async (app) => {
  app.post("/:locale/password/reset", async (request, reply) => {
    const localeParse = LOCALE_PARAM_SCHEMA.safeParse(request.params);
    if (!localeParse.success) {
      return reply.code(404).send({ error: "not_found" });
    }
    const bodyResult = requestResetSchema.safeParse(request.body);
    if (!bodyResult.success) {
      const flat = bodyResult.error.flatten();
      return reply.code(400).send({
        ok: false,
        error: "invalid_input",
        fieldErrors: flat.fieldErrors
      });
    }
    const captchaOk = await verifyCaptcha(
      bodyResult.data.captchaToken,
      request.ip
    );
    if (!captchaOk) {
      return reply.code(400).send({
        ok: false,
        error: "captcha_failed"
      });
    }
    try {
      await requestPasswordReset(bodyResult.data, {
        ipAddress: request.ip ?? null
      });
    } catch (err) {
      if (err instanceof ZodError2) {
        return reply.code(400).send({ ok: false, error: "invalid_input" });
      }
      app.log.error({ err }, "password.reset: unexpected service failure");
      return reply.code(500).send({ ok: false, error: "internal_error" });
    }
    return reply.code(200).send(GENERIC_RESET_RESPONSE);
  });
  app.get(
    "/:locale/password/reset/:token",
    async (request, reply) => {
      const params = CONFIRM_PARAM_SCHEMA.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const { locale, token } = params.data;
      if (!isStructurallyValidResetToken(token)) {
        return renderInvalidTokenPage(app, request, reply, locale);
      }
      return renderConfirmForm(app, request, reply, locale, token);
    }
  );
  app.post(
    "/:locale/password/reset/:token",
    async (request, reply) => {
      const params = CONFIRM_PARAM_SCHEMA.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const { locale, token } = params.data;
      if (!isStructurallyValidResetToken(token)) {
        return renderInvalidTokenPage(app, request, reply, locale);
      }
      const bodyResult = CONFIRM_BODY_SCHEMA.safeParse(request.body ?? {});
      const newPassword = bodyResult.success ? bodyResult.data.newPassword : asString2(request.body?.newPassword);
      try {
        const outcome = await confirmPasswordReset({
          token,
          newPassword
        });
        if (outcome.ok) {
          const html = app.view("public/password-reset-success.njk", {
            locale,
            cspNonce: request.cspNonce
          });
          return reply.code(200).type("text/html; charset=utf-8").send(html);
        }
        return renderInvalidTokenPage(app, request, reply, locale);
      } catch (err) {
        if (err instanceof ZodError2) {
          const flat = err.flatten().fieldErrors;
          const errors = {};
          for (const [key, msgs] of Object.entries(flat)) {
            if (msgs && msgs.length > 0) errors[key] = msgs;
          }
          if (errors.token && !errors.newPassword) {
            return renderInvalidTokenPage(app, request, reply, locale);
          }
          return renderConfirmForm(
            app,
            request,
            reply,
            locale,
            token,
            errors,
            null,
            400
          );
        }
        app.log.error(
          { err },
          "password.reset.confirm: unexpected service failure"
        );
        return renderConfirmForm(
          app,
          request,
          reply,
          locale,
          token,
          {},
          "We could not update your password. Please try again.",
          500
        );
      }
    }
  );
};
var password_default = passwordRoutes;

// src/routes/applicant.ts
import { createReadStream } from "node:fs";
import { stat as stat2 } from "node:fs/promises";
import { ZodError as ZodError3, z as z11 } from "zod";

// src/infra/auth-guard.ts
var SUPPORTED_LOCALES3 = /* @__PURE__ */ new Set(["id", "en"]);
var DEFAULT_LOCALE2 = "id";
function resolveRequestLocale(request) {
  const params = request.params ?? {};
  const raw = params.locale;
  if (typeof raw === "string" && SUPPORTED_LOCALES3.has(raw)) {
    return raw;
  }
  return DEFAULT_LOCALE2;
}
function redirectToLogin(request, reply) {
  const locale = resolveRequestLocale(request);
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE_OPTIONS);
  return reply.code(302).header("location", `/${locale}/login`).send();
}
async function requireApplicant(request, reply) {
  const sid = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid !== "string" || sid.length !== TOKEN_LENGTH) {
    redirectToLogin(request, reply);
    return null;
  }
  let session;
  try {
    session = await read(sid);
  } catch (err) {
    request.log.warn(
      { err, sidPrefix: sid.slice(0, 8) },
      "auth-guard: session lookup failed, redirecting to login"
    );
    redirectToLogin(request, reply);
    return null;
  }
  if (session === null) {
    redirectToLogin(request, reply);
    return null;
  }
  if (session.role !== "Applicant") {
    redirectToLogin(request, reply);
    return null;
  }
  return session;
}

// src/routes/_zod-helpers.ts
function zodErrorToFieldMap(err) {
  const flat = err.flatten().fieldErrors;
  const out = {};
  for (const [key, msgs] of Object.entries(flat)) {
    if (msgs && msgs.length > 0) {
      out[key] = msgs;
    }
  }
  return out;
}

// src/modules/applicant/completeness.ts
var MANDATORY_STRING_FIELDS = [
  "full_name",
  "date_of_birth",
  "phone",
  "address",
  "city",
  "province",
  "country",
  "summary"
];
var MANDATORY_FLAGS = [
  "hasEducation",
  "hasExperience",
  "hasActiveCv"
];
var MANDATORY_SLOTS = [
  ...MANDATORY_STRING_FIELDS,
  ...MANDATORY_FLAGS
];
function isStringFilled(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isFlagFilled(value) {
  return value === true;
}
function computeCompleteness(input) {
  const missingFields = [];
  for (const field of MANDATORY_STRING_FIELDS) {
    if (!isStringFilled(input[field])) {
      missingFields.push(field);
    }
  }
  for (const flag of MANDATORY_FLAGS) {
    if (!isFlagFilled(input[flag])) {
      missingFields.push(flag);
    }
  }
  const total = MANDATORY_SLOTS.length;
  const filled = total - missingFields.length;
  const percentage = Math.round(filled / total * 100);
  return { percentage, missingFields };
}

// src/modules/applicant/cv.ts
import { createWriteStream } from "node:fs";
import { open, rename, stat, unlink as unlink2 } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { ulid as ulid3 } from "ulid";
import { fileTypeFromBuffer } from "file-type";

// src/infra/disk.ts
import { statfs, mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path3 from "node:path";
var MIN_FREE_BYTES = 100 * 1024 * 1024;
var CV_SUBDIR = "cv";
var ALLOWED_CV_EXTS = Object.freeze(["pdf", "doc", "docx"]);
var InsufficientStorageError = class extends Error {
  /** HTTP status code expected by Fastify reply.code(...). */
  statusCode = 507;
  /** Bytes currently free on the File_Store volume. */
  freeBytes;
  /** Threshold the upload was rejected against. */
  minBytes;
  constructor(freeBytes, minBytes) {
    super(
      `insufficient storage on file_store volume: ${freeBytes} bytes free, ${minBytes} required`
    );
    this.name = "InsufficientStorageError";
    this.freeBytes = freeBytes;
    this.minBytes = minBytes;
  }
};
function getFileStoreRoot() {
  const fromEnv = process.env.FILE_STORE_PATH;
  if (fromEnv && fromEnv.trim() !== "") {
    return path3.resolve(fromEnv.trim());
  }
  return path3.resolve(os.homedir(), "file_store");
}
function resolveMinBytes() {
  const raw = process.env.MIN_FREE_BYTES;
  if (raw !== void 0 && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return MIN_FREE_BYTES;
}
async function checkFreeSpace() {
  const minBytes = resolveMinBytes();
  const root = getFileStoreRoot();
  const stats = await statfs(root);
  const blockSize = Number(stats.bsize);
  const blocksAvailable = Number(stats.bavail);
  const freeBytes = blockSize * blocksAvailable;
  return {
    ok: freeBytes >= minBytes,
    freeBytes,
    minBytes
  };
}
async function assertFreeSpace() {
  const result = await checkFreeSpace();
  if (!result.ok) {
    throw new InsufficientStorageError(result.freeBytes, result.minBytes);
  }
  return result;
}
var UUID_PATTERN = /^[0-9a-f-]+$/;
var EXT_PATTERN = /^[a-z0-9]+$/;
function sanitiseUuid(uuid) {
  const lowered = uuid.toLowerCase();
  if (!UUID_PATTERN.test(lowered) || lowered.length === 0 || lowered.length > 64) {
    throw new Error(`invalid uuid for cvPath: ${JSON.stringify(uuid)}`);
  }
  return lowered;
}
function sanitiseExt(ext) {
  const trimmed = ext.replace(/^\.+/, "").toLowerCase();
  if (!EXT_PATTERN.test(trimmed) || trimmed.length === 0 || trimmed.length > 8) {
    throw new Error(`invalid extension for cvPath: ${JSON.stringify(ext)}`);
  }
  if (!ALLOWED_CV_EXTS.includes(trimmed)) {
    throw new Error(`invalid extension for cvPath: ${JSON.stringify(ext)}`);
  }
  return trimmed;
}
function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}
function cvPath(applicantId, uuid, ext, now = /* @__PURE__ */ new Date()) {
  const safeUuid = sanitiseUuid(uuid);
  const safeExt = sanitiseExt(ext);
  const yyyy = String(now.getUTCFullYear());
  const mm = pad2(now.getUTCMonth() + 1);
  return `${CV_SUBDIR}/${yyyy}/${mm}/${safeUuid}.${safeExt}`;
}
function cvAbsolutePath(relativePath) {
  const root = getFileStoreRoot();
  const absolute = path3.resolve(root, relativePath);
  const rel = path3.relative(root, absolute);
  if (rel.startsWith("..") || path3.isAbsolute(rel)) {
    throw new Error(`relative path escapes File_Store root: ${relativePath}`);
  }
  return absolute;
}
async function ensureCvDir(applicantId, uuid, ext, now = /* @__PURE__ */ new Date()) {
  const relative = cvPath(applicantId, uuid, ext, now);
  const absolute = cvAbsolutePath(relative);
  await mkdir(path3.dirname(absolute), { recursive: true, mode: 448 });
  return absolute;
}
function tmpUploadPath(uuid) {
  const safeUuid = sanitiseUuid(uuid);
  return path3.resolve(os.homedir(), "tmp", "uploads", `${safeUuid}.tmp`);
}
async function ensureDir(target) {
  await mkdir(target, { recursive: true, mode: 448 });
}
async function safeUnlink(target) {
  try {
    await unlink(target);
    return true;
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

// src/modules/applicant/cv.ts
var SELECT_CV_FOR_OWNER_SQL = "SELECT id, applicant_user_id, storage_path, original_filename,        mime_type, size_bytes, is_active, uploaded_at FROM applicant_cv_files WHERE id = ? AND applicant_user_id = ? LIMIT 1";
function rowToRecord(row) {
  const uploadedAt = row.uploaded_at instanceof Date ? row.uploaded_at : new Date(row.uploaded_at);
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    storage_path: row.storage_path,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    is_active: row.is_active === 1,
    uploaded_at: uploadedAt
  };
}
async function loadCvForOwner(userId, id) {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await query(SELECT_CV_FOR_OWNER_SQL, [id, userId]);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}
var COUNT_ACTIVE_CV_SQL = "SELECT 1 FROM applicant_cv_files WHERE applicant_user_id = ? AND is_active = 1 LIMIT 1";
async function hasActiveCvForOwner(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return false;
  const rows = await query(COUNT_ACTIVE_CV_SQL, [userId]);
  return rows.length > 0;
}
var APPLICATION_REVIEW_ROLES = /* @__PURE__ */ new Set([
  "HR",
  "Super_Admin"
]);
async function hrCanAccessViaApplication(_viewerUserId, _viewerRole, _cvFileId) {
  return false;
}
async function loadCvForDownload(viewerUserId, viewerRole, cvFileId) {
  if (!Number.isInteger(viewerUserId) || viewerUserId <= 0) return null;
  if (!Number.isInteger(cvFileId) || cvFileId <= 0) return null;
  const ownerRow = await loadCvForOwner(viewerUserId, cvFileId);
  if (ownerRow !== null) {
    return toDescriptor(ownerRow);
  }
  if (APPLICATION_REVIEW_ROLES.has(viewerRole)) {
    const allowed = await hrCanAccessViaApplication(
      viewerUserId,
      viewerRole,
      cvFileId
    );
    if (!allowed) {
      return null;
    }
    const rows = await query(
      // SAFE: parameterised, ownership check upstream via
      // hrCanAccessViaApplication. Same column shape as the owner
      // SELECT so `rowToRecord` can be reused.
      "SELECT id, applicant_user_id, storage_path, original_filename,        mime_type, size_bytes, is_active, uploaded_at FROM applicant_cv_files WHERE id = ? LIMIT 1",
      [cvFileId]
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return toDescriptor(rowToRecord(row));
  }
  return null;
}
function toDescriptor(record) {
  let absolutePath;
  try {
    absolutePath = cvAbsolutePath(record.storage_path);
  } catch {
    return null;
  }
  return {
    absolutePath,
    mimeType: record.mime_type,
    originalFilename: record.original_filename
  };
}
var MAX_CV_BYTES = 5 * 1024 * 1024;
var MAX_CV_HISTORY = 3;
var ALLOWED_CV_MIMES = Object.freeze([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
var MIME_TO_EXT = Object.freeze({
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
});
var SNIFF_SAMPLE_SIZE = 4100;
var FileTooLargeError = class extends Error {
  statusCode = 413;
  limitBytes;
  constructor(limitBytes = MAX_CV_BYTES) {
    super(`uploaded file exceeds ${limitBytes} bytes`);
    this.name = "FileTooLargeError";
    this.limitBytes = limitBytes;
  }
};
var MimeMismatchError = class extends Error {
  statusCode = 415;
  /** What the browser claimed (or the empty string when absent). */
  declaredMime;
  /** What `file-type` actually saw (or `null` if no signature matched). */
  sniffedMime;
  constructor(declaredMime, sniffedMime) {
    super(
      `MIME mismatch: declared=${JSON.stringify(declaredMime)}, sniffed=${JSON.stringify(sniffedMime)}`
    );
    this.name = "MimeMismatchError";
    this.declaredMime = declaredMime;
    this.sniffedMime = sniffedMime;
  }
};
function makeSizeLimiter(limitBytes) {
  let bytesSeen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buf = chunk;
      bytesSeen += buf.length;
      if (bytesSeen > limitBytes) {
        callback(new FileTooLargeError(limitBytes));
        return;
      }
      callback(null, buf);
    }
  });
}
async function ensureTmpDir(tmpAbsolute) {
  const lastSep = Math.max(
    tmpAbsolute.lastIndexOf("/"),
    tmpAbsolute.lastIndexOf("\\")
  );
  if (lastSep < 0) return;
  await ensureDir(tmpAbsolute.slice(0, lastSep));
}
async function readSniffSample(absolutePath) {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_SAMPLE_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_SAMPLE_SIZE, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
function reconcileMimes(declaredMime, sniffedMime) {
  if (!ALLOWED_CV_MIMES.includes(declaredMime)) {
    return null;
  }
  const declared = declaredMime;
  if (sniffedMime === null) return null;
  if (declared === "application/pdf" && sniffedMime === "application/pdf") {
    return declared;
  }
  if (declared === "application/msword" && (sniffedMime === "application/x-cfb" || sniffedMime === "application/msword")) {
    return declared;
  }
  if (declared === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && sniffedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return declared;
  }
  return null;
}
var INSERT_CV_SQL = "INSERT INTO applicant_cv_files   (applicant_user_id, storage_path, original_filename, mime_type, size_bytes, is_active) VALUES (?, ?, ?, ?, ?, 1)";
var DEACTIVATE_OLDER_SQL = "UPDATE applicant_cv_files SET is_active = 0 WHERE applicant_user_id = ? AND id <> ?";
var SELECT_PRUNE_TARGETS_SQL = "SELECT id, storage_path FROM applicant_cv_files WHERE applicant_user_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT 1000 OFFSET ?";
var DELETE_BY_ID_SQL = "DELETE FROM applicant_cv_files WHERE id = ? AND applicant_user_id = ?";
var SELECT_BY_ID_FULL_SQL = "SELECT id, applicant_user_id, storage_path, original_filename,        mime_type, size_bytes, is_active, uploaded_at FROM applicant_cv_files WHERE id = ? LIMIT 1";
var SELECT_LIST_FOR_OWNER_SQL = "SELECT id, applicant_user_id, storage_path, original_filename,        mime_type, size_bytes, is_active, uploaded_at FROM applicant_cv_files WHERE applicant_user_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT 100";
function sanitiseOriginalFilename(raw, ext) {
  const cleaned = String(raw ?? "").replace(/[\x00-\x1f\x7f"\\/]+/g, "_").trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : `cv.${ext}`;
}
async function processCvUpload(input) {
  const { userId, multipartFile } = input;
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("processCvUpload: invalid userId");
  }
  if (multipartFile === null || typeof multipartFile !== "object" || typeof multipartFile.mimetype !== "string" || multipartFile.file === null || typeof multipartFile.file !== "object") {
    throw new Error("processCvUpload: invalid multipartFile shape");
  }
  await assertFreeSpace();
  if (!ALLOWED_CV_MIMES.includes(multipartFile.mimetype)) {
    throw new MimeMismatchError(multipartFile.mimetype, null);
  }
  const declaredMime = multipartFile.mimetype;
  const ext = MIME_TO_EXT[declaredMime];
  const uuid = ulid3().toLowerCase();
  const tmpAbsolute = tmpUploadPath(uuid);
  await ensureTmpDir(tmpAbsolute);
  let cleanupTmp = true;
  let bytesWritten = 0;
  try {
    const limiter = makeSizeLimiter(MAX_CV_BYTES);
    const writer = createWriteStream(tmpAbsolute, { mode: 384 });
    await pipeline(multipartFile.file, limiter, writer);
    if (multipartFile.file.truncated === true) {
      throw new FileTooLargeError(MAX_CV_BYTES);
    }
    const tmpStat = await stat(tmpAbsolute);
    bytesWritten = Number(tmpStat.size);
    if (bytesWritten > MAX_CV_BYTES) {
      throw new FileTooLargeError(MAX_CV_BYTES);
    }
    if (bytesWritten === 0) {
      throw new MimeMismatchError(declaredMime, null);
    }
    const sample = await readSniffSample(tmpAbsolute);
    const sniffed = await fileTypeFromBuffer(sample);
    const sniffedMime = sniffed?.mime ?? null;
    const acceptedMime = reconcileMimes(declaredMime, sniffedMime);
    if (acceptedMime === null) {
      throw new MimeMismatchError(declaredMime, sniffedMime);
    }
    const finalAbsolute = await ensureCvDir(userId, uuid, ext);
    await rename(tmpAbsolute, finalAbsolute);
    cleanupTmp = false;
    const relativePath = cvPath(userId, uuid, ext);
    const safeFilename = sanitiseOriginalFilename(multipartFile.filename, ext);
    const { record, pruneFiles } = await withTransaction(
      async (conn) => insertActiveCvAndPrune(conn, {
        userId,
        relativePath,
        originalFilename: safeFilename,
        mimeType: acceptedMime,
        sizeBytes: bytesWritten
      })
    );
    for (const target of pruneFiles) {
      let absolutePath = null;
      try {
        absolutePath = cvAbsolutePath(target.storage_path);
      } catch {
        absolutePath = null;
      }
      if (absolutePath !== null) {
        try {
          await safeUnlink(absolutePath);
        } catch (err) {
          logger.warn(
            {
              event: "cv_prune_unlink_failed",
              user_id: userId,
              cv_id: target.id,
              err
            },
            "applicant.cv: failed to unlink pruned file"
          );
        }
      }
    }
    logger.info(
      {
        event: "cv_upload",
        user_id: userId,
        cv_id: record.id,
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
        pruned_count: pruneFiles.length
      },
      "applicant.cv: upload accepted"
    );
    return { cvFile: record };
  } finally {
    if (cleanupTmp) {
      try {
        await unlink2(tmpAbsolute);
      } catch {
      }
    }
  }
}
async function insertActiveCvAndPrune(conn, input) {
  const [insertResult] = await conn.execute(INSERT_CV_SQL, [
    input.userId,
    input.relativePath,
    input.originalFilename,
    input.mimeType,
    input.sizeBytes
  ]);
  const newId = Number(insertResult.insertId);
  if (!Number.isInteger(newId) || newId <= 0) {
    throw new Error("applicant.cv: insert returned non-positive id");
  }
  await conn.execute(DEACTIVATE_OLDER_SQL, [
    input.userId,
    newId
  ]);
  const [pruneRows] = await conn.execute(
    SELECT_PRUNE_TARGETS_SQL,
    [input.userId, MAX_CV_HISTORY]
  );
  const pruneFiles = [];
  for (const row of pruneRows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    await conn.execute(DELETE_BY_ID_SQL, [id, input.userId]);
    pruneFiles.push({ id, storage_path: row.storage_path });
  }
  const [freshRows] = await conn.execute(
    SELECT_BY_ID_FULL_SQL,
    [newId]
  );
  const fresh = freshRows[0];
  if (!fresh) {
    throw new Error("applicant.cv: inserted row vanished before re-select");
  }
  return { record: rowToRecord(fresh), pruneFiles };
}
async function listCvsForOwner(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const rows = await query(SELECT_LIST_FOR_OWNER_SQL, [userId]);
  return rows.map((row) => rowToRecord(row));
}

// src/modules/applicant/experience.ts
import { z as z6 } from "zod";
var MAX_EXPERIENCE_ENTRIES = 30;
var EMPLOYMENT_TYPES = [
  "full-time",
  "part-time",
  "contract",
  "internship",
  "freelance"
];
var ExperienceCapError = class extends Error {
  constructor(limit) {
    super(
      `Experience entries cap reached (${limit}). Remove an existing entry before adding a new one.`
    );
    this.limit = limit;
    this.name = "ExperienceCapError";
  }
  code = "experience_cap_reached";
};
var ExperienceNotFoundError = class extends Error {
  constructor(id) {
    super(`Experience entry ${id} not found`);
    this.id = id;
    this.name = "ExperienceNotFoundError";
  }
  code = "experience_not_found";
};
var DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!DATE_REGEX.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}
var trimmedShortText = (max, label) => z6.string({ required_error: `${label} is required` }).trim().min(1, { message: `${label} is required` }).max(max, { message: `${label} must be at most ${max} characters` });
var startDateSchema = z6.string({ required_error: "Start date is required" }).trim().min(1, { message: "Start date is required" }).refine((v) => DATE_REGEX.test(v), {
  message: "Start date must be in YYYY-MM-DD format"
}).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
  message: "Start date is not a valid calendar date"
});
var endDateSchema = z6.string().trim().optional().transform((v) => v === void 0 || v === "" ? null : v).refine((v) => v === null || DATE_REGEX.test(v), {
  message: "End date must be in YYYY-MM-DD format"
}).refine((v) => v === null || !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
  message: "End date is not a valid calendar date"
});
var isCurrentSchema = z6.union([z6.boolean(), z6.string()]).optional().transform((v) => {
  if (v === void 0) return false;
  if (typeof v === "boolean") return v;
  const lowered = v.trim().toLowerCase();
  return lowered === "on" || lowered === "true" || lowered === "1";
});
var employmentTypeSchema = z6.enum(EMPLOYMENT_TYPES, {
  errorMap: () => ({
    message: `Employment type must be one of: ${EMPLOYMENT_TYPES.join(", ")}`
  })
});
var descriptionSchema = z6.string().optional().transform((v) => {
  if (v === void 0) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}).refine((v) => v === null || v.length <= 1e3, {
  message: "Description must be at most 1000 characters"
});
var experienceSchema = z6.object({
  company: trimmedShortText(150, "Company"),
  title: trimmedShortText(100, "Title"),
  employment_type: employmentTypeSchema,
  start_date: startDateSchema,
  end_date: endDateSchema,
  is_current: isCurrentSchema,
  description: descriptionSchema
}).strict().superRefine((value, ctx) => {
  const start = parseDate(value.start_date);
  if (start !== null) {
    const now = /* @__PURE__ */ new Date();
    const todayUtcMs2 = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    );
    if (start.getTime() > todayUtcMs2) {
      ctx.addIssue({
        code: z6.ZodIssueCode.custom,
        path: ["start_date"],
        message: "Start date cannot be in the future"
      });
    }
  }
  if (value.is_current && value.end_date !== null) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["end_date"],
      message: 'End date must be empty when "current position" is checked'
    });
  }
  if (!value.is_current && value.end_date === null) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["end_date"],
      message: "End date is required when this is not your current position"
    });
  }
  if (value.end_date !== null) {
    const end = parseDate(value.end_date);
    if (start !== null && end !== null && end.getTime() < start.getTime()) {
      ctx.addIssue({
        code: z6.ZodIssueCode.custom,
        path: ["end_date"],
        message: "End date must be on or after start date"
      });
    }
  }
});
function dateToIsoYmd(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
function rowToRecord2(row) {
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    company: row.company,
    title: row.title,
    employment_type: row.employment_type,
    start_date: dateToIsoYmd(row.start_date) ?? "",
    end_date: dateToIsoYmd(row.end_date),
    is_current: row.is_current === 1,
    description: row.description
  };
}
var SELECT_LIST_SQL = "SELECT id, applicant_user_id, company, title, employment_type,   start_date, end_date, is_current, description FROM applicant_experience WHERE applicant_user_id = ? ORDER BY start_date DESC, id DESC";
var SELECT_BY_ID_SQL = "SELECT id, applicant_user_id, company, title, employment_type,   start_date, end_date, is_current, description FROM applicant_experience WHERE id = ? AND applicant_user_id = ? LIMIT 1";
var COUNT_FOR_UPDATE_SQL = "SELECT COUNT(*) AS n FROM applicant_experience WHERE applicant_user_id = ? FOR UPDATE";
var INSERT_SQL = "INSERT INTO applicant_experience   (applicant_user_id, company, title, employment_type, start_date, end_date, is_current, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
var UPDATE_SQL = "UPDATE applicant_experience SET   company = ?,   title = ?,   employment_type = ?,   start_date = ?,   end_date = ?,   is_current = ?,   description = ? WHERE id = ? AND applicant_user_id = ?";
var DELETE_SQL = "DELETE FROM applicant_experience WHERE id = ? AND applicant_user_id = ?";
async function listExperience(userId) {
  const rows = await query(SELECT_LIST_SQL, [userId]);
  return rows.map(rowToRecord2);
}
async function findExperienceById(userId, id) {
  const rows = await query(SELECT_BY_ID_SQL, [id, userId]);
  const row = rows[0];
  return row ? rowToRecord2(row) : null;
}
function inputToInsertParams(userId, input) {
  return [
    userId,
    input.company,
    input.title,
    input.employment_type,
    input.start_date,
    input.end_date,
    input.is_current ? 1 : 0,
    input.description
  ];
}
function inputToUpdateParams(userId, id, input) {
  return [
    input.company,
    input.title,
    input.employment_type,
    input.start_date,
    input.end_date,
    input.is_current ? 1 : 0,
    input.description,
    id,
    userId
  ];
}
async function createExperience(userId, rawInput) {
  const input = experienceSchema.parse(rawInput);
  return withTransaction(async (conn) => {
    const [countRows] = await conn.execute(
      COUNT_FOR_UPDATE_SQL,
      [userId]
    );
    const current = Number(
      countRows[0]?.n ?? 0
    );
    if (current >= MAX_EXPERIENCE_ENTRIES) {
      throw new ExperienceCapError(MAX_EXPERIENCE_ENTRIES);
    }
    const [result] = await conn.execute(
      INSERT_SQL,
      inputToInsertParams(userId, input)
    );
    const insertedId = result.insertId;
    const [rows] = await conn.execute(SELECT_BY_ID_SQL, [
      insertedId,
      userId
    ]);
    const row = rows[0];
    if (!row) {
      throw new Error("experience: failed to read back inserted row");
    }
    logger.info(
      {
        event: "experience_create",
        user_id: userId,
        experience_id: insertedId
      },
      "applicant.experience: row created"
    );
    return rowToRecord2(row);
  });
}
async function updateExperience(userId, id, rawInput) {
  const input = experienceSchema.parse(rawInput);
  const result = await query(
    UPDATE_SQL,
    inputToUpdateParams(userId, id, input)
  );
  if (result.affectedRows === 0) {
    throw new ExperienceNotFoundError(id);
  }
  const after = await findExperienceById(userId, id);
  if (after === null) {
    throw new ExperienceNotFoundError(id);
  }
  logger.info(
    { event: "experience_update", user_id: userId, experience_id: id },
    "applicant.experience: row updated"
  );
  return after;
}
async function deleteExperience(userId, id) {
  const result = await query(DELETE_SQL, [id, userId]);
  if (result.affectedRows === 0) {
    throw new ExperienceNotFoundError(id);
  }
  logger.info(
    { event: "experience_delete", user_id: userId, experience_id: id },
    "applicant.experience: row deleted"
  );
}

// src/modules/applicant/profile.ts
import { z as z7 } from "zod";
var MIN_AGE_YEARS = 18;
var MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1e3;
var PHONE_E164_REGEX = /^\+?[1-9]\d{6,18}$/;
var GENDER_VALUES = ["male", "female", "prefer-not-to-say"];
function eighteenYearsAgoCutoff() {
  return new Date(Date.now() - MIN_AGE_YEARS * MS_PER_YEAR);
}
var blankToUndef = z7.string().transform((v) => v.trim() === "" ? void 0 : v).optional();
var fullNameSchema = z7.string({ required_error: "Full name is required" }).trim().min(1, { message: "Full name is required" }).max(100, { message: "Full name must be at most 100 characters" });
var dateOfBirthSchema = z7.string().transform((v) => v.trim() === "" ? void 0 : v).optional().superRefine((value, ctx) => {
  if (value === void 0) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    ctx.addIssue({
      code: z7.ZodIssueCode.custom,
      message: "Date of birth must be in YYYY-MM-DD format"
    });
    return;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    ctx.addIssue({
      code: z7.ZodIssueCode.custom,
      message: "Date of birth is not a valid date"
    });
    return;
  }
  const dob = new Date(ms);
  if (dob.getTime() > eighteenYearsAgoCutoff().getTime()) {
    ctx.addIssue({
      code: z7.ZodIssueCode.custom,
      message: `You must be at least ${MIN_AGE_YEARS} years old`
    });
  }
}).transform((value) => value === void 0 ? void 0 : value);
var genderSchema = z7.string().transform((v) => v.trim() === "" ? void 0 : v).optional().refine(
  (v) => v === void 0 || GENDER_VALUES.includes(v),
  { message: "Gender must be male, female, or prefer-not-to-say" }
).transform((v) => v);
var phoneSchema = z7.string().transform((v) => v.trim().replace(/[\s-]/g, "")).transform((v) => v === "" ? void 0 : v).optional().superRefine((value, ctx) => {
  if (value === void 0) return;
  if (!PHONE_E164_REGEX.test(value)) {
    ctx.addIssue({
      code: z7.ZodIssueCode.custom,
      message: "Phone must be in E.164 format (e.g. +6281234567890, 7-19 digits, optional leading +)"
    });
    return;
  }
  const canonical = value.startsWith("+") ? value : `+${value}`;
  if (canonical.length > 20) {
    ctx.addIssue({
      code: z7.ZodIssueCode.too_big,
      maximum: 20,
      type: "string",
      inclusive: true,
      message: "Phone must be at most 20 characters"
    });
  }
}).transform((value) => {
  if (value === void 0) return void 0;
  return value.startsWith("+") ? value : `+${value}`;
});
var addressSchema = blankToUndef.refine(
  (v) => v === void 0 || v.length <= 255,
  { message: "Address must be at most 255 characters" }
);
var cityProvinceCountrySchema = blankToUndef.refine(
  (v) => v === void 0 || v.length <= 100,
  { message: "Must be at most 100 characters" }
);
var summarySchema = blankToUndef.refine(
  (v) => v === void 0 || v.length <= 500,
  { message: "Summary must be at most 500 characters" }
);
var languagePrefSchema = z7.union([z7.literal("id"), z7.literal("en")]).default("id");
var profileSchema = z7.object({
  full_name: fullNameSchema,
  date_of_birth: dateOfBirthSchema,
  gender: genderSchema,
  phone: phoneSchema,
  address: addressSchema,
  city: cityProvinceCountrySchema,
  province: cityProvinceCountrySchema,
  country: cityProvinceCountrySchema,
  summary: summarySchema,
  language_pref: languagePrefSchema
}).strict();
var SELECT_PROFILE_SQL = "SELECT user_id, full_name, date_of_birth, gender, phone, address,   city, province, country, summary, language_pref FROM applicants WHERE user_id = ? LIMIT 1";
var UPDATE_PROFILE_SQL = "UPDATE applicants SET   full_name = ?,   date_of_birth = ?,   gender = ?,   phone = ?,   address = ?,   city = ?,   province = ?,   country = ?,   summary = ?,   language_pref = ? WHERE user_id = ?";
function dateToIsoYmd2(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
async function loadProfile(userId) {
  const rows = await query(SELECT_PROFILE_SQL, [userId]);
  const row = rows[0];
  if (!row) return null;
  return {
    user_id: Number(row.user_id),
    full_name: row.full_name,
    date_of_birth: dateToIsoYmd2(row.date_of_birth),
    gender: row.gender,
    phone: row.phone,
    address: row.address,
    city: row.city,
    province: row.province,
    country: row.country,
    summary: row.summary,
    language_pref: row.language_pref
  };
}
async function updateProfile(userId, rawInput) {
  const input = profileSchema.parse(rawInput);
  const result = await query(UPDATE_PROFILE_SQL, [
    input.full_name,
    input.date_of_birth ?? null,
    input.gender ?? null,
    input.phone ?? null,
    input.address ?? null,
    input.city ?? null,
    input.province ?? null,
    input.country ?? null,
    input.summary ?? null,
    input.language_pref,
    userId
  ]);
  logger.info(
    { event: "profile_update", user_id: userId },
    "applicant.profile: row updated"
  );
  return { affected: result.affectedRows, profile: input };
}

// src/modules/applicant/education.ts
import { z as z8 } from "zod";
var MAX_EDUCATION_ENTRIES = 20;
var GPA_MIN = 0;
var GPA_MAX = 4;
var EducationCapError = class extends Error {
  constructor(limit) {
    super(
      `Education entries cap reached (${limit}). Remove an existing entry before adding a new one.`
    );
    this.limit = limit;
    this.name = "EducationCapError";
  }
  code = "education_cap_reached";
};
var EducationNotFoundError = class extends Error {
  constructor(id) {
    super(`Education entry ${id} not found`);
    this.id = id;
    this.name = "EducationNotFoundError";
  }
  code = "education_not_found";
};
var DATE_REGEX2 = /^\d{4}-\d{2}-\d{2}$/;
function parseDate2(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!DATE_REGEX2.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}
function todayUtcMs() {
  const now = /* @__PURE__ */ new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
var trimmedShortText2 = (max, label) => z8.string({ required_error: `${label} is required` }).trim().min(1, { message: `${label} is required` }).max(max, { message: `${label} must be at most ${max} characters` });
var startDateSchema2 = z8.string({ required_error: "Start date is required" }).trim().min(1, { message: "Start date is required" }).refine((v) => DATE_REGEX2.test(v), {
  message: "Start date must be in YYYY-MM-DD format"
}).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
  message: "Start date is not a valid calendar date"
}).refine(
  (v) => {
    const ms = Date.parse(`${v}T00:00:00Z`);
    return !Number.isNaN(ms) && ms <= todayUtcMs();
  },
  { message: "Start date cannot be in the future" }
);
var endDateSchema2 = z8.string().trim().optional().transform((v) => v === void 0 || v === "" ? null : v).refine((v) => v === null || DATE_REGEX2.test(v), {
  message: "End date must be in YYYY-MM-DD format"
}).refine((v) => v === null || !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
  message: "End date is not a valid calendar date"
});
var inProgressSchema = z8.union([z8.boolean(), z8.string()]).optional().transform((v) => {
  if (v === void 0) return false;
  if (typeof v === "boolean") return v;
  const lowered = v.trim().toLowerCase();
  return lowered === "on" || lowered === "true" || lowered === "1";
});
var gpaSchema = z8.union([z8.number(), z8.string()]).optional().transform((v, ctx) => {
  if (v === void 0) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      ctx.addIssue({
        code: z8.ZodIssueCode.custom,
        message: "GPA must be a number"
      });
      return null;
    }
    v = n;
  }
  if (!Number.isFinite(v)) {
    ctx.addIssue({
      code: z8.ZodIssueCode.custom,
      message: "GPA must be a finite number"
    });
    return null;
  }
  if (v < GPA_MIN || v > GPA_MAX) {
    ctx.addIssue({
      code: z8.ZodIssueCode.custom,
      message: `GPA must be between ${GPA_MIN.toFixed(2)} and ${GPA_MAX.toFixed(2)}`
    });
    return null;
  }
  return Math.round(v * 100) / 100;
});
var educationSchema = z8.object({
  institution: trimmedShortText2(150, "Institution"),
  degree: trimmedShortText2(100, "Degree"),
  field: trimmedShortText2(100, "Field of study"),
  start_date: startDateSchema2,
  end_date: endDateSchema2,
  in_progress: inProgressSchema,
  gpa: gpaSchema
}).strict().superRefine((value, ctx) => {
  if (value.in_progress && value.end_date !== null) {
    ctx.addIssue({
      code: z8.ZodIssueCode.custom,
      path: ["end_date"],
      message: 'End date must be empty when "in progress" is checked'
    });
  }
  if (value.end_date !== null) {
    const start = parseDate2(value.start_date);
    const end = parseDate2(value.end_date);
    if (start !== null && end !== null && end.getTime() < start.getTime()) {
      ctx.addIssue({
        code: z8.ZodIssueCode.custom,
        path: ["end_date"],
        message: "End date must be on or after start date"
      });
    }
  }
});
function dateToIsoYmd3(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
function decimalToNumber(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function rowToRecord3(row) {
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    institution: row.institution,
    degree: row.degree,
    field: row.field,
    start_date: dateToIsoYmd3(row.start_date) ?? "",
    end_date: dateToIsoYmd3(row.end_date),
    in_progress: row.in_progress === 1,
    gpa: decimalToNumber(row.gpa)
  };
}
var SELECT_LIST_SQL2 = "SELECT id, applicant_user_id, institution, degree, field,   start_date, end_date, in_progress, gpa FROM applicant_education WHERE applicant_user_id = ? ORDER BY start_date DESC, id DESC";
var SELECT_BY_ID_SQL2 = "SELECT id, applicant_user_id, institution, degree, field,   start_date, end_date, in_progress, gpa FROM applicant_education WHERE id = ? AND applicant_user_id = ? LIMIT 1";
var COUNT_FOR_UPDATE_SQL2 = "SELECT COUNT(*) AS n FROM applicant_education WHERE applicant_user_id = ? FOR UPDATE";
var INSERT_SQL2 = "INSERT INTO applicant_education   (applicant_user_id, institution, degree, field, start_date, end_date, in_progress, gpa) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
var UPDATE_SQL2 = "UPDATE applicant_education SET   institution = ?,   degree = ?,   field = ?,   start_date = ?,   end_date = ?,   in_progress = ?,   gpa = ? WHERE id = ? AND applicant_user_id = ?";
var DELETE_SQL2 = "DELETE FROM applicant_education WHERE id = ? AND applicant_user_id = ?";
async function listEducation(userId) {
  const rows = await query(SELECT_LIST_SQL2, [userId]);
  return rows.map(rowToRecord3);
}
async function findEducationById(userId, id) {
  const rows = await query(SELECT_BY_ID_SQL2, [id, userId]);
  const row = rows[0];
  return row ? rowToRecord3(row) : null;
}
function inputToInsertParams2(userId, input) {
  return [
    userId,
    input.institution,
    input.degree,
    input.field,
    input.start_date,
    input.end_date,
    // already null-normalised
    input.in_progress ? 1 : 0,
    input.gpa
    // already null-normalised
  ];
}
function inputToUpdateParams2(userId, id, input) {
  return [
    input.institution,
    input.degree,
    input.field,
    input.start_date,
    input.end_date,
    input.in_progress ? 1 : 0,
    input.gpa,
    id,
    userId
  ];
}
async function createEducation(userId, rawInput) {
  const input = educationSchema.parse(rawInput);
  return withTransaction(async (conn) => {
    const [countRows] = await conn.execute(
      COUNT_FOR_UPDATE_SQL2,
      [userId]
    );
    const current = Number(countRows[0]?.n ?? 0);
    if (current >= MAX_EDUCATION_ENTRIES) {
      throw new EducationCapError(MAX_EDUCATION_ENTRIES);
    }
    const [result] = await conn.execute(
      INSERT_SQL2,
      inputToInsertParams2(userId, input)
    );
    const insertedId = result.insertId;
    const [rows] = await conn.execute(SELECT_BY_ID_SQL2, [
      insertedId,
      userId
    ]);
    const row = rows[0];
    if (!row) {
      throw new Error("education: failed to read back inserted row");
    }
    logger.info(
      { event: "education_create", user_id: userId, education_id: insertedId },
      "applicant.education: row created"
    );
    return rowToRecord3(row);
  });
}
async function updateEducation(userId, id, rawInput) {
  const input = educationSchema.parse(rawInput);
  const result = await query(
    UPDATE_SQL2,
    inputToUpdateParams2(userId, id, input)
  );
  if (result.affectedRows === 0) {
    throw new EducationNotFoundError(id);
  }
  const after = await findEducationById(userId, id);
  if (after === null) {
    throw new EducationNotFoundError(id);
  }
  logger.info(
    { event: "education_update", user_id: userId, education_id: id },
    "applicant.education: row updated"
  );
  return after;
}
async function deleteEducation(userId, id) {
  const result = await query(DELETE_SQL2, [id, userId]);
  if (result.affectedRows === 0) {
    throw new EducationNotFoundError(id);
  }
  logger.info(
    { event: "education_delete", user_id: userId, education_id: id },
    "applicant.education: row deleted"
  );
}

// src/modules/applicant/skills.ts
import { z as z9 } from "zod";
var MAX_SKILLS_PER_APPLICANT = 30;
var MAX_SEARCH_RESULTS = 20;
var MIN_SEARCH_QUERY_LENGTH = 2;
var BOOLEAN_MODE_OPERATORS_REGEX = /[+\-><()~*"@]/g;
var SkillCapError = class extends Error {
  constructor(limit) {
    super(
      `Skill cap reached (${limit}). Remove an existing skill before adding a new one.`
    );
    this.limit = limit;
    this.name = "SkillCapError";
  }
  code = "skill_cap_reached";
};
var SkillInactiveError = class extends Error {
  constructor(skillId) {
    super(`Skill ${skillId} is no longer active`);
    this.skillId = skillId;
    this.name = "SkillInactiveError";
  }
  code = "skill_inactive";
};
var SkillNotFoundError = class extends Error {
  constructor(skillId) {
    super(`Skill ${skillId} not found`);
    this.skillId = skillId;
    this.name = "SkillNotFoundError";
  }
  code = "skill_not_found";
};
var skillIdSchema = z9.union([z9.number(), z9.string()]).transform((v, ctx) => {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "skill_id must be a positive integer"
    });
    return 0;
  }
  return n;
});
function rowToSkillTag(row) {
  return {
    id: Number(row.id),
    label: row.label,
    active: row.active === 1
  };
}
var SELECT_ASSIGNED_SKILLS_SQL = "SELECT s.id, s.label, s.active FROM applicant_skills aps JOIN skill_tags s ON s.id = aps.skill_id WHERE aps.applicant_user_id = ? AND s.active = 1 ORDER BY s.label ASC";
var SEARCH_SKILLS_SQL = "SELECT id, label, active FROM skill_tags WHERE active = 1 AND MATCH(label) AGAINST (? IN BOOLEAN MODE) ORDER BY MATCH(label) AGAINST (? IN BOOLEAN MODE) DESC, label ASC LIMIT ?";
var SEARCH_SKILLS_LIKE_SQL = "SELECT id, label, active FROM skill_tags WHERE active = 1 AND label LIKE ? ORDER BY label ASC LIMIT ?";
var SELECT_SKILL_BY_ID_SQL = "SELECT id, label, active FROM skill_tags WHERE id = ? LIMIT 1";
var SELECT_LINK_FOR_UPDATE_SQL = "SELECT 1 FROM applicant_skills WHERE applicant_user_id = ? AND skill_id = ? FOR UPDATE";
var COUNT_LINKS_FOR_UPDATE_SQL = "SELECT COUNT(*) AS n FROM applicant_skills WHERE applicant_user_id = ? FOR UPDATE";
var INSERT_LINK_SQL = "INSERT INTO applicant_skills (applicant_user_id, skill_id) VALUES (?, ?)";
var DELETE_LINK_SQL = "DELETE FROM applicant_skills WHERE applicant_user_id = ? AND skill_id = ?";
async function listAssignedSkills(userId) {
  const rows = await query(SELECT_ASSIGNED_SKILLS_SQL, [
    userId
  ]);
  return rows.map(rowToSkillTag);
}
function buildBooleanQuery(raw) {
  const stripped = raw.replace(BOOLEAN_MODE_OPERATORS_REGEX, " ").replace(/\s+/g, " ").trim();
  if (stripped.length < MIN_SEARCH_QUERY_LENGTH) return null;
  const tokens = stripped.split(" ").filter((token) => token.length >= MIN_SEARCH_QUERY_LENGTH).map((token) => `${token}*`);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}
function escapeLikePattern(input) {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
async function searchSkills(rawQuery) {
  const trimmed = (rawQuery ?? "").trim();
  if (trimmed.length === 0) return [];
  const booleanQuery = buildBooleanQuery(trimmed);
  if (booleanQuery !== null) {
    const rows2 = await query(SEARCH_SKILLS_SQL, [
      booleanQuery,
      booleanQuery,
      MAX_SEARCH_RESULTS
    ]);
    return rows2.map(rowToSkillTag);
  }
  const stripped = trimmed.replace(BOOLEAN_MODE_OPERATORS_REGEX, "").trim();
  if (stripped.length === 0) return [];
  const likePattern = `${escapeLikePattern(stripped)}%`;
  const rows = await query(SEARCH_SKILLS_LIKE_SQL, [
    likePattern,
    MAX_SEARCH_RESULTS
  ]);
  return rows.map(rowToSkillTag);
}
async function toggleSkill(userId, skillId) {
  if (!Number.isInteger(skillId) || skillId <= 0) {
    throw new TypeError("skillId must be a positive integer");
  }
  return withTransaction(async (conn) => {
    const [skillRows] = await conn.execute(
      SELECT_SKILL_BY_ID_SQL,
      [skillId]
    );
    const skillRow = skillRows[0];
    if (!skillRow) {
      throw new SkillNotFoundError(skillId);
    }
    const skill = rowToSkillTag(skillRow);
    const [linkRows] = await conn.execute(
      SELECT_LINK_FOR_UPDATE_SQL,
      [userId, skillId]
    );
    const isAssigned = linkRows.length > 0;
    if (isAssigned) {
      await conn.execute(DELETE_LINK_SQL, [userId, skillId]);
      const [postRows] = await conn.execute(
        COUNT_LINKS_FOR_UPDATE_SQL,
        [userId]
      );
      const count = Number(
        postRows[0]?.n ?? 0
      );
      logger.info(
        { event: "skill_remove", user_id: userId, skill_id: skillId, count },
        "applicant.skills: assignment removed"
      );
      return { assigned: false, count, skill };
    }
    if (!skill.active) {
      throw new SkillInactiveError(skillId);
    }
    const [countRows] = await conn.execute(
      COUNT_LINKS_FOR_UPDATE_SQL,
      [userId]
    );
    const current = Number(
      countRows[0]?.n ?? 0
    );
    if (current >= MAX_SKILLS_PER_APPLICANT) {
      throw new SkillCapError(MAX_SKILLS_PER_APPLICANT);
    }
    await conn.execute(INSERT_LINK_SQL, [userId, skillId]);
    logger.info(
      {
        event: "skill_add",
        user_id: userId,
        skill_id: skillId,
        count: current + 1
      },
      "applicant.skills: assignment added"
    );
    return { assigned: true, count: current + 1, skill };
  });
}

// src/modules/applications/queries.ts
var DEFAULT_PAGE_SIZE = 20;
var MAX_PAGE_SIZE = 100;
function resolveLocalePair(raw) {
  const primary = raw === "en" ? "en" : "id";
  const fallback = primary === "id" ? "en" : "id";
  return { primary, fallback };
}
function toDate(raw) {
  if (raw instanceof Date) return raw;
  if (typeof raw === "string") return new Date(raw);
  return /* @__PURE__ */ new Date(0);
}
function toDateOrNull(raw) {
  if (raw === null || raw === void 0) return null;
  return toDate(raw);
}
function clampPage(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const n = Math.floor(value);
  return n < 1 ? 1 : n;
}
function clampPageSize(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PAGE_SIZE;
  }
  const n = Math.floor(value);
  if (n < 1) return DEFAULT_PAGE_SIZE;
  if (n > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return n;
}
async function listForApplicant(applicantUserId, opts = {}) {
  const { primary, fallback } = resolveLocalePair(opts.locale);
  const page = clampPage(opts.page);
  const pageSize = clampPageSize(opts.pageSize);
  const offset = (page - 1) * pageSize;
  const countRows = await query(
    "SELECT COUNT(*) AS n FROM applications WHERE applicant_user_id = ?",
    [applicantUserId]
  );
  const total = Number(countRows[0]?.n ?? 0);
  const rows = await query(
    `SELECT
        a.id            AS id,
        a.uuid          AS uuid,
        a.reference_no  AS reference_no,
        a.job_id        AS job_id,
        j.slug          AS job_slug,
        j.location      AS job_location,
        a.stage         AS stage,
        a.applied_at    AS applied_at,
        a.hired_at      AS hired_at,
        COALESCE(tp.title, tf.title) AS job_title
     FROM applications a
     INNER JOIN job_postings j ON j.id = a.job_id
     LEFT  JOIN job_posting_translations tp
            ON tp.job_id = a.job_id AND tp.locale = ?
     LEFT  JOIN job_posting_translations tf
            ON tf.job_id = a.job_id AND tf.locale = ?
     WHERE a.applicant_user_id = ?
     ORDER BY a.applied_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [primary, fallback, applicantUserId, pageSize, offset]
  );
  const mapped = rows.map((row) => ({
    id: Number(row.id),
    uuid: String(row.uuid),
    referenceNo: String(row.reference_no),
    jobId: Number(row.job_id),
    jobSlug: String(row.job_slug),
    jobTitle: row.job_title === null || row.job_title === void 0 ? "" : String(row.job_title),
    jobLocation: String(row.job_location ?? ""),
    stage: row.stage,
    appliedAt: toDate(row.applied_at),
    hiredAt: toDateOrNull(row.hired_at)
  }));
  return { rows: mapped, total };
}
async function findOneForApplicant(applicantUserId, applicationId, opts = {}) {
  const { primary, fallback } = resolveLocalePair(opts.locale);
  const appRows = await query(
    `SELECT
        a.id            AS id,
        a.uuid          AS uuid,
        a.reference_no  AS reference_no,
        a.job_id        AS job_id,
        j.slug          AS job_slug,
        j.location      AS job_location,
        a.stage         AS stage,
        a.applied_at    AS applied_at,
        a.hired_at      AS hired_at,
        COALESCE(tp.title, tf.title) AS job_title
     FROM applications a
     INNER JOIN job_postings j ON j.id = a.job_id
     LEFT  JOIN job_posting_translations tp
            ON tp.job_id = a.job_id AND tp.locale = ?
     LEFT  JOIN job_posting_translations tf
            ON tf.job_id = a.job_id AND tf.locale = ?
     WHERE a.id = ? AND a.applicant_user_id = ?
     LIMIT 1`,
    [primary, fallback, applicationId, applicantUserId]
  );
  const appRow = appRows[0];
  if (appRow === void 0) return null;
  const historyRows = await query(
    `SELECT id, prev_stage, new_stage, changed_by, changed_at
       FROM application_stage_history
       WHERE application_id = ?
       ORDER BY changed_at ASC, id ASC`,
    [applicationId]
  );
  const stageHistory = historyRows.map((row) => ({
    id: Number(row.id),
    prevStage: row.prev_stage ?? null,
    newStage: row.new_stage,
    changedBy: row.changed_by === null || row.changed_by === void 0 ? null : Number(row.changed_by),
    changedAt: toDate(row.changed_at)
  }));
  const noteRows = await query(
    `SELECT
        n.id              AS id,
        n.author_user_id  AS author_user_id,
        n.body            AS body,
        n.created_at      AS created_at,
        u.email           AS author_email
       FROM application_notes n
       LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.application_id = ?
         AND n.visible_to_applicant = 1
       ORDER BY n.created_at ASC, n.id ASC`,
    [applicationId]
  );
  const notes = noteRows.map((row) => ({
    id: Number(row.id),
    authorUserId: Number(row.author_user_id),
    authorName: typeof row.author_email === "string" && row.author_email.length > 0 ? row.author_email : "PT Buana Megah",
    body: String(row.body ?? ""),
    createdAt: toDate(row.created_at)
  }));
  return {
    id: Number(appRow.id),
    uuid: String(appRow.uuid),
    referenceNo: String(appRow.reference_no),
    jobId: Number(appRow.job_id),
    jobSlug: String(appRow.job_slug),
    jobTitle: appRow.job_title === null || appRow.job_title === void 0 ? "" : String(appRow.job_title),
    jobLocation: String(appRow.job_location ?? ""),
    stage: appRow.stage,
    appliedAt: toDate(appRow.applied_at),
    hiredAt: toDateOrNull(appRow.hired_at),
    stageHistory,
    notes
  };
}
var APPLICATION_LIST_DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;

// src/modules/applications/service.ts
import { randomUUID } from "node:crypto";

// src/modules/jobs/state-machine.ts
var JOB_STATUSES = [
  "Draft",
  "Published",
  "Closed",
  "Archived"
];
var ALLOWED_TRANSITIONS = Object.freeze({
  Draft: /* @__PURE__ */ new Set(["Published", "Archived"]),
  Published: /* @__PURE__ */ new Set(["Closed", "Archived"]),
  Closed: /* @__PURE__ */ new Set(["Archived"]),
  Archived: /* @__PURE__ */ new Set()
});
function canTransition(from, to) {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].has(to);
}
var InvalidTransitionError = class extends Error {
  constructor(from, to) {
    super(`Invalid job status transition: ${from} \u2192 ${to}`);
    this.from = from;
    this.to = to;
    this.name = "InvalidTransitionError";
  }
  code = "invalid_transition";
  /** HTTP status code the route layer surfaces for this error (Req 9.2). */
  statusCode = 422;
};
function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

// src/modules/jobs/repo.ts
var JOB_LOCALES = ["id", "en"];
var DEFAULT_PAGE_SIZE2 = 20;
var MAX_OFFSET = 200;
var SLUG_MAX_LEN = 120;
var TITLE_MAX_LEN = 150;
var LOCATION_MAX_LEN = 150;
var JobNotFoundError = class extends Error {
  constructor(idOrSlug) {
    super(`Job posting ${idOrSlug} not found`);
    this.idOrSlug = idOrSlug;
    this.name = "JobNotFoundError";
  }
  code = "job_not_found";
};
var SlugConflictError = class extends Error {
  constructor(slug) {
    super(`Slug "${slug}" is already in use`);
    this.slug = slug;
    this.name = "SlugConflictError";
  }
  code = "slug_conflict";
  /** HTTP status code the route layer surfaces for this error (Req 9.7). */
  statusCode = 422;
};
var EMPLOYMENT_TYPES2 = [
  "full-time",
  "part-time",
  "contract",
  "internship"
];
var JOB_LEVELS = [
  "entry",
  "junior",
  "mid",
  "senior",
  "lead",
  "manager",
  "director"
];
var JOB_COLUMNS = "id, uuid, slug, department_id, location, employment_type, level, status, salary_min, salary_max, salary_currency, application_deadline, published_at, created_by, created_at, updated_at";
var SELECT_JOB_BY_ID_SQL = [
  "SELECT",
  JOB_COLUMNS,
  "FROM job_postings WHERE id = ? LIMIT 1"
].join(" ");
var SELECT_JOB_BY_SLUG_SQL = [
  "SELECT",
  JOB_COLUMNS,
  "FROM job_postings WHERE slug = ? LIMIT 1"
].join(" ");
var SELECT_TRANSLATIONS_SQL = "SELECT job_id, locale, title, description, requirements, responsibilities FROM job_posting_translations WHERE job_id = ?";
var SLUG_LOCK_SQL = "SELECT id FROM job_postings WHERE slug = ? FOR UPDATE";
var INSERT_JOB_SQL = "INSERT INTO job_postings   (uuid, slug, department_id, location, employment_type, level, status,    salary_min, salary_max, salary_currency, application_deadline,    published_at, created_by, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
var UPDATE_JOB_SQL = "UPDATE job_postings SET   slug = ?, department_id = ?, location = ?, employment_type = ?,   level = ?, status = ?, salary_min = ?, salary_max = ?,   salary_currency = ?, application_deadline = ?, published_at = ?,   search_text = ? WHERE id = ?";
var DELETE_TRANSLATIONS_SQL = "DELETE FROM job_posting_translations WHERE job_id = ?";
var INSERT_TRANSLATION_SQL = "INSERT INTO job_posting_translations   (job_id, locale, title, description, requirements, responsibilities) VALUES (?, ?, ?, ?, ?, ?)";
var UPDATE_STATUS_SQL = "UPDATE job_postings SET status = ?, updated_at = NOW() WHERE id = ?";
var UPDATE_PUBLISH_SQL = "UPDATE job_postings SET status = 'Published', published_at = NOW(), search_text = ?, updated_at = NOW() WHERE id = ?";
var SLUG_UNIQUENESS_LOCK_SQL = "SELECT id FROM job_postings WHERE slug = ? AND id <> ? FOR UPDATE";
var SELECT_JOB_FOR_UPDATE_SQL = "SELECT id, status, slug FROM job_postings WHERE id = ? FOR UPDATE";
var SELECT_TRANSLATIONS_FOR_PUBLISH_SQL = "SELECT locale, title, description, requirements, responsibilities FROM job_posting_translations WHERE job_id = ?";
function toNumberOrNull(value) {
  if (value === null || value === void 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function dateToIsoYmd4(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
function toDate2(value) {
  if (value === null || value === void 0) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function rowToJobPosting(row) {
  return {
    id: Number(row.id),
    uuid: row.uuid,
    slug: row.slug,
    department_id: toNumberOrNull(row.department_id),
    location: row.location,
    employment_type: row.employment_type,
    level: row.level,
    status: row.status,
    salary_min: toNumberOrNull(row.salary_min),
    salary_max: toNumberOrNull(row.salary_max),
    salary_currency: row.salary_currency,
    application_deadline: dateToIsoYmd4(row.application_deadline),
    published_at: toDate2(row.published_at),
    created_by: Number(row.created_by),
    created_at: toDate2(row.created_at) ?? /* @__PURE__ */ new Date(0),
    updated_at: toDate2(row.updated_at) ?? /* @__PURE__ */ new Date(0)
  };
}
function rowToTranslation(row) {
  return {
    locale: row.locale,
    title: row.title,
    description: row.description,
    requirements: row.requirements,
    responsibilities: row.responsibilities
  };
}
function computeSearchText(translations, skillLabels) {
  const segments = [];
  for (const t2 of translations) {
    if (t2.title) segments.push(t2.title);
    if (t2.description) segments.push(t2.description);
    if (t2.requirements) segments.push(t2.requirements);
    if (t2.responsibilities) segments.push(t2.responsibilities);
  }
  for (const label of skillLabels) {
    const trimmed = label.trim();
    if (trimmed.length > 0) segments.push(trimmed);
  }
  return segments.join(" \n ");
}
function placeholders(n) {
  if (n <= 0) return "";
  return Array.from({ length: n }, () => "?").join(", ");
}
function applyDepartmentScope(scope, clauses, params) {
  if (!scope || scope.departments === void 0) {
    return true;
  }
  const depts = scope.departments;
  if (depts.length === 0) {
    return false;
  }
  clauses.push("department_id IN (" + placeholders(depts.length) + ")");
  for (const id of depts) params.push(id);
  return true;
}
var ER_DUP_ENTRY = "ER_DUP_ENTRY";
function isDuplicateEntryError(err) {
  if (err === null || typeof err !== "object") return false;
  const code = err.code;
  return typeof code === "string" && code === ER_DUP_ENTRY;
}
async function findById(id, scope) {
  if (!Number.isInteger(id) || id <= 0) return null;
  if (scope?.departments !== void 0 && scope.departments.length === 0) {
    return null;
  }
  const rows = await query(SELECT_JOB_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) return null;
  const job = rowToJobPosting(row);
  if (scope?.departments !== void 0 && (job.department_id === null || !scope.departments.includes(job.department_id))) {
    return null;
  }
  const tRows = await query(SELECT_TRANSLATIONS_SQL, [id]);
  const translations = {};
  for (const tr of tRows) {
    translations[tr.locale] = rowToTranslation(tr);
  }
  return { ...job, translations };
}
async function findBySlug(slug, scope) {
  if (typeof slug !== "string" || slug.length === 0) return null;
  if (scope?.departments !== void 0 && scope.departments.length === 0) {
    return null;
  }
  const rows = await query(SELECT_JOB_BY_SLUG_SQL, [slug]);
  const row = rows[0];
  if (!row) return null;
  return findById(Number(row.id), scope);
}
async function list(filter = {}, scope) {
  const clauses = [];
  const params = [];
  if (filter.status && filter.status.length > 0) {
    clauses.push("status IN (" + placeholders(filter.status.length) + ")");
    for (const s of filter.status) params.push(s);
  }
  if (filter.department_id !== void 0 && filter.department_id !== null) {
    clauses.push("department_id = ?");
    params.push(filter.department_id);
  }
  if (filter.employment_type && filter.employment_type.length > 0) {
    clauses.push(
      "employment_type IN (" + placeholders(filter.employment_type.length) + ")"
    );
    for (const e of filter.employment_type) params.push(e);
  }
  if (filter.level && filter.level.length > 0) {
    clauses.push("level IN (" + placeholders(filter.level.length) + ")");
    for (const l of filter.level) params.push(l);
  }
  if (filter.location && filter.location.length > 0) {
    clauses.push("location IN (" + placeholders(filter.location.length) + ")");
    for (const loc of filter.location) params.push(loc);
  }
  if (typeof filter.keyword === "string" && filter.keyword.trim().length > 0) {
    clauses.push("MATCH(search_text) AGAINST (? IN BOOLEAN MODE)");
    params.push(filter.keyword.trim());
  }
  if (!applyDepartmentScope(scope, clauses, params)) {
    return { rows: [], total: 0 };
  }
  const whereSql = clauses.length > 0 ? ["WHERE", clauses.join(" AND ")].join(" ") : "";
  const pageSizeRaw = filter.pageSize ?? DEFAULT_PAGE_SIZE2;
  const pageSize = Math.min(Math.max(1, Math.floor(pageSizeRaw)), 100);
  const pageRaw = filter.page ?? 0;
  const page = Math.max(0, Math.floor(pageRaw));
  const offset = Math.min(page * pageSize, MAX_OFFSET);
  const totalSql = ["SELECT COUNT(*) AS n FROM job_postings", whereSql].filter((s) => s.length > 0).join(" ");
  const totalRows = await query(totalSql, params);
  const total = Number(
    totalRows[0]?.n ?? 0
  );
  const listSql = [
    "SELECT",
    JOB_COLUMNS,
    "FROM job_postings",
    whereSql,
    "ORDER BY COALESCE(published_at, updated_at) DESC, id DESC",
    "LIMIT ? OFFSET ?"
  ].filter((s) => s.length > 0).join(" ");
  const listParams = [...params, pageSize, offset];
  const rows = await query(listSql, listParams);
  return { rows: rows.map(rowToJobPosting), total };
}
async function save(input, actorUserId) {
  return withTransaction(async (conn) => {
    const [lockedRows] = await conn.execute(SLUG_LOCK_SQL, [
      input.slug
    ]);
    const ownerOfSlug = lockedRows.length > 0 ? Number(lockedRows[0]?.id) : null;
    if (ownerOfSlug !== null && ownerOfSlug !== input.id) {
      throw new SlugConflictError(input.slug);
    }
    const searchText = computeSearchText(input.translations, input.skillLabels);
    let jobId;
    let jobUuid;
    if (input.id === null) {
      const { ulid: ulid5 } = await import("ulid");
      jobUuid = ulid5();
      try {
        const [result] = await conn.execute(INSERT_JOB_SQL, [
          jobUuid,
          input.slug,
          input.department_id,
          input.location,
          input.employment_type,
          input.level,
          input.status,
          input.salary_min,
          input.salary_max,
          input.salary_currency,
          input.application_deadline,
          input.published_at ?? null,
          actorUserId,
          searchText
        ]);
        jobId = result.insertId;
      } catch (err) {
        if (isDuplicateEntryError(err)) {
          throw new SlugConflictError(input.slug);
        }
        throw err;
      }
    } else {
      jobId = input.id;
      try {
        const [result] = await conn.execute(UPDATE_JOB_SQL, [
          input.slug,
          input.department_id,
          input.location,
          input.employment_type,
          input.level,
          input.status,
          input.salary_min,
          input.salary_max,
          input.salary_currency,
          input.application_deadline,
          input.published_at ?? null,
          searchText,
          input.id
        ]);
        if (result.affectedRows === 0) {
          throw new JobNotFoundError(input.id);
        }
      } catch (err) {
        if (isDuplicateEntryError(err)) {
          throw new SlugConflictError(input.slug);
        }
        throw err;
      }
      const [existingRows] = await conn.execute(
        SELECT_JOB_BY_ID_SQL,
        [jobId]
      );
      const existing = existingRows[0];
      if (!existing) throw new JobNotFoundError(input.id);
      jobUuid = existing.uuid;
    }
    await conn.execute(DELETE_TRANSLATIONS_SQL, [jobId]);
    for (const tr of input.translations) {
      await conn.execute(INSERT_TRANSLATION_SQL, [
        jobId,
        tr.locale,
        tr.title,
        tr.description,
        tr.requirements,
        tr.responsibilities
      ]);
    }
    const [rows] = await conn.execute(SELECT_JOB_BY_ID_SQL, [jobId]);
    const row = rows[0];
    if (!row) {
      throw new Error("jobs.repo: failed to read back saved job");
    }
    const job = rowToJobPosting(row);
    const [tRows] = await conn.execute(
      SELECT_TRANSLATIONS_SQL,
      [jobId]
    );
    const translations = {};
    for (const tr of tRows) {
      translations[tr.locale] = rowToTranslation(tr);
    }
    logger.info(
      {
        event: input.id === null ? "job_create" : "job_update",
        actor_user_id: actorUserId,
        job_id: jobId,
        slug: input.slug,
        status: input.status
      },
      "jobs.repo: saved job posting"
    );
    return { ...job, uuid: jobUuid, translations };
  });
}
async function transitionStatus(conn, id, next, actorUserId, scope) {
  const [rows] = await conn.execute(SELECT_JOB_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) throw new JobNotFoundError(id);
  const current = rowToJobPosting(row);
  if (scope?.departments !== void 0 && (current.department_id === null || !scope.departments.includes(current.department_id))) {
    throw new JobNotFoundError(id);
  }
  assertTransition(current.status, next);
  await conn.execute(UPDATE_STATUS_SQL, [next, id]);
  logger.info(
    {
      event: "job_status_transition",
      actor_user_id: actorUserId,
      job_id: id,
      from: current.status,
      to: next
    },
    "jobs.repo: status transitioned"
  );
  return { ...current, status: next };
}
async function softClose(id, actorUserId, scope) {
  return withTransaction(
    (conn) => transitionStatus(conn, id, "Closed", actorUserId, scope)
  );
}
async function archive(id, actorUserId, scope) {
  return withTransaction(
    (conn) => transitionStatus(conn, id, "Archived", actorUserId, scope)
  );
}
async function publish(id, actorUserId, scope) {
  return withTransaction(async (conn) => {
    const [lockedRows] = await conn.execute(
      SELECT_JOB_FOR_UPDATE_SQL,
      [id]
    );
    const locked = lockedRows[0];
    if (!locked) throw new JobNotFoundError(id);
    const [rows] = await conn.execute(SELECT_JOB_BY_ID_SQL, [id]);
    const row = rows[0];
    if (!row) throw new JobNotFoundError(id);
    const current = rowToJobPosting(row);
    if (scope?.departments !== void 0 && (current.department_id === null || !scope.departments.includes(current.department_id))) {
      throw new JobNotFoundError(id);
    }
    assertTransition(current.status, "Published");
    const [slugRows] = await conn.execute(
      SLUG_UNIQUENESS_LOCK_SQL,
      [current.slug, id]
    );
    if (slugRows.length > 0) {
      throw new SlugConflictError(current.slug);
    }
    const [trRows] = await conn.execute(
      SELECT_TRANSLATIONS_FOR_PUBLISH_SQL,
      [id]
    );
    const translations = trRows.map((tr) => ({
      locale: tr.locale,
      title: tr.title,
      description: tr.description,
      requirements: tr.requirements,
      responsibilities: tr.responsibilities
    }));
    const searchText = computeSearchText(translations, []);
    try {
      const [result] = await conn.execute(
        UPDATE_PUBLISH_SQL,
        [searchText, id]
      );
      if (result.affectedRows === 0) {
        throw new JobNotFoundError(id);
      }
    } catch (err) {
      if (isDuplicateEntryError(err)) {
        throw new SlugConflictError(current.slug);
      }
      throw err;
    }
    logger.info(
      {
        event: "job_status_transition",
        actor_user_id: actorUserId,
        job_id: id,
        from: current.status,
        to: "Published"
      },
      "jobs.repo: status transitioned"
    );
    const [postRows] = await conn.execute(SELECT_JOB_BY_ID_SQL, [id]);
    const postRow = postRows[0];
    if (!postRow) throw new JobNotFoundError(id);
    return rowToJobPosting(postRow);
  });
}
async function clone(id, actorUserId, newSlug, scope) {
  const source = await findById(id, scope);
  if (source === null) throw new JobNotFoundError(id);
  const translations = [];
  for (const locale of JOB_LOCALES) {
    const tr = source.translations[locale];
    if (tr) {
      translations.push({
        locale,
        title: tr.title,
        description: tr.description,
        requirements: tr.requirements,
        responsibilities: tr.responsibilities
      });
    }
  }
  return save(
    {
      id: null,
      slug: newSlug,
      department_id: source.department_id,
      location: source.location,
      employment_type: source.employment_type,
      level: source.level,
      status: "Draft",
      salary_min: source.salary_min,
      salary_max: source.salary_max,
      salary_currency: source.salary_currency,
      application_deadline: source.application_deadline,
      published_at: null,
      translations,
      skillLabels: []
    },
    actorUserId
  );
}

// src/modules/applications/errors.ts
var MissingCvError = class extends Error {
  code = "missing_cv";
  /** HTTP status the route layer maps this to (Req 5.2 → 422). */
  statusCode = 422;
  constructor() {
    super("applicant has no active CV");
    this.name = "MissingCvError";
  }
};
var IncompleteProfileError = class extends Error {
  constructor(percentage, missingFields) {
    super(`profile completeness ${percentage}% is below the apply threshold`);
    this.percentage = percentage;
    this.missingFields = missingFields;
    this.name = "IncompleteProfileError";
  }
  code = "incomplete_profile";
  statusCode = 422;
};
var JobUnavailableError = class extends Error {
  constructor(jobId) {
    super(`job ${jobId} is not available for application`);
    this.jobId = jobId;
    this.name = "JobUnavailableError";
  }
  code = "job_unavailable";
  statusCode = 404;
};
var DuplicateApplicationError = class extends Error {
  constructor(applicantUserId, jobId) {
    super(
      `applicant ${applicantUserId} has already applied to job ${jobId}`
    );
    this.applicantUserId = applicantUserId;
    this.jobId = jobId;
    this.name = "DuplicateApplicationError";
  }
  code = "duplicate_application";
  statusCode = 409;
};
var ApplicationNotFoundError = class extends Error {
  constructor(applicationId) {
    super(`application ${applicationId} not found for this applicant`);
    this.applicationId = applicationId;
    this.name = "ApplicationNotFoundError";
  }
  code = "application_not_found";
  statusCode = 404;
};
var WithdrawNotAllowedError = class extends Error {
  constructor(applicationId, stage) {
    super(
      `application ${applicationId} in stage ${stage} cannot be withdrawn`
    );
    this.applicationId = applicationId;
    this.stage = stage;
    this.name = "WithdrawNotAllowedError";
  }
  code = "terminal_stage";
  statusCode = 409;
};

// src/modules/applications/types.ts
var APPLICATION_SOURCES = [
  "direct",
  "search",
  "alert",
  "social",
  "unknown"
];
function isApplicationSource(value) {
  return APPLICATION_SOURCES.includes(value);
}

// src/modules/applications/service.ts
var APPLY_COMPLETENESS_THRESHOLD = 80;
var MAX_REFERENCE_NO_RETRIES = 1;
var ER_DUP_ENTRY2 = "ER_DUP_ENTRY";
var SELECT_APPLICANT_AND_ACTIVE_CV_SQL = "SELECT a.user_id, a.full_name, a.date_of_birth, a.phone,        a.address, a.city, a.province, a.country, a.summary,        cv.id AS cv_id FROM applicants a LEFT JOIN applicant_cv_files cv        ON cv.applicant_user_id = a.user_id AND cv.is_active = 1 WHERE a.user_id = ? LIMIT 1";
var COUNT_EDUCATION_SQL = "SELECT 1 FROM applicant_education WHERE applicant_user_id = ? LIMIT 1";
var COUNT_EXPERIENCE_SQL = "SELECT 1 FROM applicant_experience WHERE applicant_user_id = ? LIMIT 1";
var COUNT_REFERENCE_NO_SQL = "SELECT COUNT(*) AS n FROM applications WHERE reference_no LIKE ? FOR UPDATE";
var INSERT_APPLICATION_SQL = "INSERT INTO applications   (uuid, reference_no, applicant_user_id, job_id, cv_file_id, stage, source) VALUES (?, ?, ?, ?, ?, 'Applied', ?)";
var INSERT_STAGE_HISTORY_SQL = "INSERT INTO application_stage_history   (application_id, prev_stage, new_stage, changed_by) VALUES (?, NULL, 'Applied', ?)";
function mapSourceParam(raw) {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return "unknown";
  return isApplicationSource(trimmed) ? trimmed : "unknown";
}
function isDuplicateEntryError2(err) {
  if (err === null || typeof err !== "object") return false;
  const code = err.code;
  return typeof code === "string" && code === ER_DUP_ENTRY2;
}
function isDuplicateApplicantJobIndex(err) {
  if (!isDuplicateEntryError2(err)) return false;
  const message = err.message;
  if (typeof message !== "string") return false;
  return message.includes("uk_app_applicant_job");
}
function isDuplicateReferenceNoIndex(err) {
  if (!isDuplicateEntryError2(err)) return false;
  const message = err.message;
  if (typeof message !== "string") return false;
  return message.includes("uk_app_ref");
}
function padSixDigits(n) {
  return n.toString().padStart(6, "0");
}
async function nextReferenceNo(conn, now = /* @__PURE__ */ new Date()) {
  const year = now.getUTCFullYear();
  const prefix = `APP-${year}-`;
  const [rows] = await conn.execute(COUNT_REFERENCE_NO_SQL, [
    `${prefix}%`
  ]);
  const current = Number(rows[0]?.n ?? 0);
  const next = current + 1;
  return `${prefix}${padSixDigits(next)}`;
}
function dateToIsoYmd5(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
async function loadApplicantSnapshot(conn, userId) {
  const [rows] = await conn.execute(
    SELECT_APPLICANT_AND_ACTIVE_CV_SQL,
    [userId]
  );
  const row = rows[0];
  if (row === void 0) return null;
  return {
    userId: Number(row.user_id),
    fullName: row.full_name,
    dateOfBirth: dateToIsoYmd5(row.date_of_birth),
    phone: row.phone,
    address: row.address,
    city: row.city,
    province: row.province,
    country: row.country,
    summary: row.summary,
    cvId: row.cv_id === null || row.cv_id === void 0 ? null : Number(row.cv_id)
  };
}
async function applicantHasEducation(conn, userId) {
  const [rows] = await conn.execute(COUNT_EDUCATION_SQL, [
    userId
  ]);
  return rows.length > 0;
}
async function applicantHasExperience(conn, userId) {
  const [rows] = await conn.execute(COUNT_EXPERIENCE_SQL, [
    userId
  ]);
  return rows.length > 0;
}
function todayIsoYmd(now = /* @__PURE__ */ new Date()) {
  return now.toISOString().slice(0, 10);
}
function jobIsUnavailable(job, todayYmd) {
  if (job === null) return true;
  if (job.status !== "Published") return true;
  if (job.application_deadline !== null && job.application_deadline < todayYmd) {
    return true;
  }
  return false;
}
async function applyToJob(input) {
  const { applicantUserId, jobId, sourceParam } = input;
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError("applicantUserId must be a positive integer");
  }
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new TypeError("jobId must be a positive integer");
  }
  const source = mapSourceParam(sourceParam);
  const job = await findById(jobId);
  if (jobIsUnavailable(job, todayIsoYmd())) {
    throw new JobUnavailableError(jobId);
  }
  return withTransaction(async (conn) => {
    const snapshot = await loadApplicantSnapshot(conn, applicantUserId);
    if (snapshot === null || snapshot.cvId === null) {
      throw new MissingCvError();
    }
    const [hasEdu, hasExp] = await Promise.all([
      applicantHasEducation(conn, applicantUserId),
      applicantHasExperience(conn, applicantUserId)
    ]);
    const { percentage, missingFields } = computeCompleteness({
      full_name: snapshot.fullName,
      date_of_birth: snapshot.dateOfBirth,
      phone: snapshot.phone,
      address: snapshot.address,
      city: snapshot.city,
      province: snapshot.province,
      country: snapshot.country,
      summary: snapshot.summary,
      hasEducation: hasEdu,
      hasExperience: hasExp,
      hasActiveCv: snapshot.cvId !== null
    });
    if (percentage < APPLY_COMPLETENESS_THRESHOLD) {
      throw new IncompleteProfileError(percentage, missingFields);
    }
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_REFERENCE_NO_RETRIES; attempt += 1) {
      const uuid = randomUUID();
      const referenceNo = await nextReferenceNo(conn);
      try {
        const [insertResult] = await conn.execute(
          INSERT_APPLICATION_SQL,
          [uuid, referenceNo, applicantUserId, jobId, snapshot.cvId, source]
        );
        const applicationId = Number(insertResult.insertId);
        await conn.execute(INSERT_STAGE_HISTORY_SQL, [
          applicationId,
          applicantUserId
        ]);
        logger.info(
          {
            event: "application_submitted",
            application_id: applicationId,
            applicant_user_id: applicantUserId,
            job_id: jobId,
            reference_no: referenceNo,
            source
          },
          "application created"
        );
        return {
          id: applicationId,
          uuid,
          referenceNo,
          source
        };
      } catch (err) {
        if (isDuplicateApplicantJobIndex(err)) {
          throw new DuplicateApplicationError(applicantUserId, jobId);
        }
        if (isDuplicateReferenceNoIndex(err)) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    if (lastError !== null) throw lastError;
    throw new Error("applyToJob: exhausted reference-number retries");
  });
}
var WITHDRAW_TERMINAL_STAGES = /* @__PURE__ */ new Set([
  "Hired",
  "Rejected",
  "Withdrawn"
]);
var SELECT_FOR_WITHDRAW_SQL = "SELECT id, stage FROM applications WHERE id = ? AND applicant_user_id = ? LIMIT 1 FOR UPDATE";
var UPDATE_STAGE_WITHDRAWN_SQL = "UPDATE applications SET stage = 'Withdrawn' WHERE id = ?";
var INSERT_WITHDRAW_HISTORY_SQL = "INSERT INTO application_stage_history   (application_id, prev_stage, new_stage, changed_by) VALUES (?, ?, 'Withdrawn', ?)";
async function withdrawApplication(input) {
  const { applicantUserId, applicationId } = input;
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError("applicantUserId must be a positive integer");
  }
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new TypeError("applicationId must be a positive integer");
  }
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute(SELECT_FOR_WITHDRAW_SQL, [
      applicationId,
      applicantUserId
    ]);
    const row = rows[0];
    if (row === void 0) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const prevStage = row.stage;
    if (WITHDRAW_TERMINAL_STAGES.has(prevStage)) {
      throw new WithdrawNotAllowedError(applicationId, prevStage);
    }
    await conn.execute(UPDATE_STAGE_WITHDRAWN_SQL, [
      applicationId
    ]);
    await conn.execute(INSERT_WITHDRAW_HISTORY_SQL, [
      applicationId,
      prevStage,
      applicantUserId
    ]);
    logger.info(
      {
        event: "application_withdrawn",
        actor_user_id: applicantUserId,
        application_id: applicationId,
        prev_stage: prevStage
      },
      "application withdrawn"
    );
  });
}

// src/modules/bookmarks/service.ts
var SUPPORTED_LOCALES4 = ["id", "en"];
var DEFAULT_LOCALE3 = "id";
var JobNotFoundError2 = class extends Error {
  constructor(jobId) {
    super(`Job posting ${jobId} not found`);
    this.jobId = jobId;
    this.name = "JobNotFoundError";
  }
  code = "job_not_found";
};
var SELECT_BOOKMARK_FOR_UPDATE_SQL = "SELECT 1 AS hit FROM bookmarks WHERE applicant_user_id = ? AND job_id = ? FOR UPDATE";
var DELETE_BOOKMARK_SQL = "DELETE FROM bookmarks WHERE applicant_user_id = ? AND job_id = ?";
var INSERT_BOOKMARK_SQL = "INSERT INTO bookmarks (applicant_user_id, job_id, created_at) VALUES (?, ?, NOW())";
var SELECT_JOB_EXISTS_SQL = "SELECT id FROM job_postings WHERE id = ? LIMIT 1";
var SELECT_BOOKMARKS_SQL = "SELECT   b.job_id            AS jobId,   b.created_at        AS bookmarkedAt,   j.slug              AS slug,   j.status            AS status,   j.location          AS location,   j.application_deadline AS applicationDeadline,   COALESCE(t_primary.title, t_fallback.title, ?) AS title FROM bookmarks b JOIN job_postings j ON j.id = b.job_id LEFT JOIN job_posting_translations t_primary   ON t_primary.job_id = j.id AND t_primary.locale = ? LEFT JOIN job_posting_translations t_fallback   ON t_fallback.job_id = j.id AND t_fallback.locale = ? WHERE b.applicant_user_id = ? ORDER BY b.created_at DESC, b.job_id DESC";
function dateToIsoYmd6(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
function toDate3(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return /* @__PURE__ */ new Date(0);
}
function computeIsApplyable(status, applicationDeadlineYmd, todayYmd) {
  if (status !== "Published") return false;
  if (applicationDeadlineYmd === null) return true;
  return applicationDeadlineYmd >= todayYmd;
}
function todayYmdUtc(now = /* @__PURE__ */ new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function rowToBookmark(row, todayYmd) {
  const status = String(row.status);
  const deadline = dateToIsoYmd6(row.applicationDeadline);
  return {
    jobId: Number(row.jobId),
    slug: row.slug,
    status,
    title: row.title ?? "",
    location: row.location,
    applicationDeadline: deadline,
    isPublished: status === "Published",
    isApplyable: computeIsApplyable(status, deadline, todayYmd),
    bookmarkedAt: toDate3(row.bookmarkedAt)
  };
}
async function toggle(applicantUserId, jobId) {
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError("bookmarks.toggle: invalid applicantUserId");
  }
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new TypeError("bookmarks.toggle: invalid jobId");
  }
  return withTransaction(async (conn) => {
    const [existingRows] = await conn.execute(
      SELECT_BOOKMARK_FOR_UPDATE_SQL,
      [applicantUserId, jobId]
    );
    if (existingRows.length > 0) {
      const [delResult] = await conn.execute(
        DELETE_BOOKMARK_SQL,
        [applicantUserId, jobId]
      );
      logger.info(
        {
          event: "bookmark_toggle",
          user_id: applicantUserId,
          job_id: jobId,
          new_state: "removed",
          affected: delResult.affectedRows
        },
        "bookmarks.toggle: removed"
      );
      return { bookmarked: false };
    }
    const [jobRows] = await conn.execute(
      SELECT_JOB_EXISTS_SQL,
      [jobId]
    );
    if (jobRows.length === 0) {
      throw new JobNotFoundError2(jobId);
    }
    await conn.execute(INSERT_BOOKMARK_SQL, [
      applicantUserId,
      jobId
    ]);
    logger.info(
      {
        event: "bookmark_toggle",
        user_id: applicantUserId,
        job_id: jobId,
        new_state: "added"
      },
      "bookmarks.toggle: added"
    );
    return { bookmarked: true };
  });
}
async function list2(applicantUserId, requestedLocale = DEFAULT_LOCALE3, now = /* @__PURE__ */ new Date()) {
  if (!Number.isInteger(applicantUserId) || applicantUserId <= 0) {
    throw new TypeError("bookmarks.list: invalid applicantUserId");
  }
  const primary = SUPPORTED_LOCALES4.includes(
    requestedLocale
  ) ? requestedLocale : DEFAULT_LOCALE3;
  const fallback = primary === "id" ? "en" : "id";
  const todayYmd = todayYmdUtc(now);
  const rows = await query(SELECT_BOOKMARKS_SQL, [
    "",
    primary,
    fallback,
    applicantUserId
  ]);
  return rows.map((row) => rowToBookmark(row, todayYmd));
}

// src/modules/alerts/service.ts
import { z as z10 } from "zod";

// src/modules/alerts/repo.ts
function parseJsonArray(value) {
  if (value === null || value === void 0) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
function parseLocations(value) {
  const arr = parseJsonArray(value);
  if (arr === null) return null;
  const strings = arr.filter((v) => typeof v === "string");
  return strings.length > 0 ? strings : null;
}
function parseDepartments(value) {
  const arr = parseJsonArray(value);
  if (arr === null) return null;
  const numbers = arr.map((v) => typeof v === "number" ? v : Number(v)).filter((n) => Number.isFinite(n) && Number.isInteger(n));
  return numbers.length > 0 ? numbers : null;
}
function toDateOrNull2(value) {
  if (value === null || value === void 0) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
function rowToAlert(row) {
  return {
    id: Number(row.id),
    applicant_user_id: Number(row.applicant_user_id),
    keyword: row.keyword ?? null,
    locations: parseLocations(row.locations),
    departments: parseDepartments(row.departments),
    frequency: row.frequency,
    last_evaluated_at: toDateOrNull2(row.last_evaluated_at),
    // created_at is NOT NULL with a default; fall back to "now" only if
    // the driver ever hands back an unparseable value.
    created_at: toDateOrNull2(row.created_at) ?? /* @__PURE__ */ new Date()
  };
}
var SELECT_LIST_SQL3 = "SELECT id, applicant_user_id, keyword, locations, departments,   frequency, last_evaluated_at, created_at FROM job_alerts WHERE applicant_user_id = ? ORDER BY created_at DESC, id DESC";
var SELECT_BY_ID_SQL3 = "SELECT id, applicant_user_id, keyword, locations, departments,   frequency, last_evaluated_at, created_at FROM job_alerts WHERE id = ? AND applicant_user_id = ? LIMIT 1";
var COUNT_FOR_UPDATE_SQL3 = "SELECT COUNT(*) AS n FROM job_alerts WHERE applicant_user_id = ? FOR UPDATE";
var INSERT_SQL3 = "INSERT INTO job_alerts   (applicant_user_id, keyword, locations, departments, frequency) VALUES (?, ?, ?, ?, ?)";
var DELETE_SQL3 = "DELETE FROM job_alerts WHERE id = ? AND applicant_user_id = ?";
async function listForApplicant2(applicantUserId) {
  const rows = await query(SELECT_LIST_SQL3, [applicantUserId]);
  return rows.map(rowToAlert);
}
async function countForApplicant(conn, applicantUserId) {
  const [rows] = await conn.execute(COUNT_FOR_UPDATE_SQL3, [
    applicantUserId
  ]);
  const n = rows[0]?.n ?? 0;
  return Number(n);
}
async function findByIdForApplicant(applicantUserId, id) {
  const rows = await query(SELECT_BY_ID_SQL3, [
    id,
    applicantUserId
  ]);
  const row = rows[0];
  return row ? rowToAlert(row) : null;
}
function serialiseJsonColumn(value) {
  if (value === null || value.length === 0) return null;
  return JSON.stringify(value);
}
async function insertAlert(input, conn) {
  const params = [
    input.applicantUserId,
    input.keyword,
    serialiseJsonColumn(input.locations),
    serialiseJsonColumn(input.departments),
    input.frequency
  ];
  let insertedId;
  if (conn) {
    const [result2] = await conn.execute(INSERT_SQL3, params);
    insertedId = result2.insertId;
    const [rows] = await conn.execute(SELECT_BY_ID_SQL3, [
      insertedId,
      input.applicantUserId
    ]);
    const row = rows[0];
    if (!row) {
      throw new Error("alerts: failed to read back inserted row");
    }
    return rowToAlert(row);
  }
  const result = await query(INSERT_SQL3, params);
  insertedId = result.insertId;
  const after = await findByIdForApplicant(input.applicantUserId, insertedId);
  if (after === null) {
    throw new Error("alerts: failed to read back inserted row");
  }
  return after;
}
async function deleteAlert(applicantUserId, id) {
  const result = await query(DELETE_SQL3, [id, applicantUserId]);
  return result.affectedRows > 0;
}

// src/modules/alerts/service.ts
var MAX_ALERTS_PER_APPLICANT = 10;
var MAX_KEYWORD_LENGTH = 100;
var AlertCapError = class extends Error {
  constructor(limit) {
    super(
      `Job alert cap reached (${limit}). Remove an existing alert before adding a new one.`
    );
    this.limit = limit;
    this.name = "AlertCapError";
  }
  code = "alert_cap_reached";
  status = 422;
};
var InvalidAlertInputError = class extends Error {
  constructor(fieldErrors) {
    super("Invalid job alert input");
    this.fieldErrors = fieldErrors;
    this.name = "InvalidAlertInputError";
  }
  code = "invalid_alert_input";
  status = 422;
};
var AlertNotFoundError = class extends Error {
  constructor(id) {
    super(`Job alert ${id} not found`);
    this.id = id;
    this.name = "AlertNotFoundError";
  }
  code = "alert_not_found";
  status = 404;
};
function toStringList(value) {
  const raw = value === void 0 || value === null ? [] : Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      if (typeof item === "number") {
        const s = String(item).trim();
        if (s !== "") out.push(s);
      }
      continue;
    }
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "") out.push(trimmed);
    }
  }
  return out;
}
var keywordSchema = z10.union([z10.string(), z10.undefined(), z10.null()]).transform((v, ctx) => {
  if (v === void 0 || v === null) return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_KEYWORD_LENGTH) {
    ctx.addIssue({
      code: z10.ZodIssueCode.custom,
      message: `Keyword must be at most ${MAX_KEYWORD_LENGTH} characters`
    });
    return null;
  }
  return trimmed;
});
var locationsSchema = z10.unknown().transform((v) => {
  const list3 = toStringList(v);
  return list3.length > 0 ? list3 : null;
});
var departmentsSchema = z10.unknown().transform((v, ctx) => {
  const list3 = toStringList(v);
  if (list3.length === 0) return null;
  const out = [];
  for (const token of list3) {
    const n = Number(token);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      ctx.addIssue({
        code: z10.ZodIssueCode.custom,
        message: "Each department must be a positive integer id"
      });
      return null;
    }
    out.push(n);
  }
  return out;
});
var frequencySchema = z10.union([z10.string(), z10.undefined(), z10.null()]).transform((v, ctx) => {
  const trimmed = typeof v === "string" ? v.trim() : "";
  if (trimmed === "Daily" || trimmed === "Weekly") {
    return trimmed;
  }
  ctx.addIssue({
    code: z10.ZodIssueCode.custom,
    message: "Frequency must be either Daily or Weekly"
  });
  return "Daily";
});
var alertSchema = z10.object({
  keyword: keywordSchema,
  locations: locationsSchema,
  departments: departmentsSchema,
  frequency: frequencySchema
});
function validateInput(raw) {
  const parsed = alertSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    const fieldErrors = {};
    for (const [key, msgs] of Object.entries(flat)) {
      if (msgs && msgs.length > 0) {
        fieldErrors[key] = msgs;
      }
    }
    throw new InvalidAlertInputError(fieldErrors);
  }
  return parsed.data;
}
async function createAlert(params) {
  const { applicantUserId } = params;
  const input = validateInput(params.input);
  return withTransaction(async (conn) => {
    const current = await countForApplicant(conn, applicantUserId);
    if (current >= MAX_ALERTS_PER_APPLICANT) {
      throw new AlertCapError(MAX_ALERTS_PER_APPLICANT);
    }
    const row = await insertAlert(
      {
        applicantUserId,
        keyword: input.keyword,
        locations: input.locations,
        departments: input.departments,
        frequency: input.frequency
      },
      conn
    );
    logger.info(
      {
        event: "alert_create",
        user_id: applicantUserId,
        alert_id: row.id,
        frequency: row.frequency
      },
      "applicant.alerts: alert created"
    );
    return row;
  });
}
async function listAlerts(applicantUserId) {
  return listForApplicant2(applicantUserId);
}
async function removeAlert(params) {
  const { applicantUserId, id } = params;
  const removed = await deleteAlert(applicantUserId, id);
  if (!removed) {
    throw new AlertNotFoundError(id);
  }
  logger.info(
    { event: "alert_delete", user_id: applicantUserId, alert_id: id },
    "applicant.alerts: alert deleted"
  );
}

// src/modules/applicant/data-export.ts
var SELECT_PROFILE_SQL2 = [
  "SELECT",
  "  a.user_id, u.uuid, u.email, u.role, u.status,",
  "  u.email_verified_at, u.created_at,",
  "  a.full_name, a.date_of_birth, a.gender, a.phone,",
  "  a.address, a.city, a.province, a.country,",
  "  a.summary, a.language_pref",
  "FROM applicants a",
  "JOIN users u ON u.id = a.user_id",
  "WHERE a.user_id = ?",
  "LIMIT 1"
].join(" ");
var SELECT_EDUCATION_SQL = [
  "SELECT",
  "  id, institution, degree, field,",
  "  start_date, end_date, in_progress, gpa",
  "FROM applicant_education",
  "WHERE applicant_user_id = ?",
  "ORDER BY start_date DESC"
].join(" ");
var SELECT_EXPERIENCE_SQL = [
  "SELECT",
  "  id, company, title, employment_type,",
  "  start_date, end_date, is_current, description",
  "FROM applicant_experience",
  "WHERE applicant_user_id = ?",
  "ORDER BY start_date DESC"
].join(" ");
var SELECT_SKILLS_SQL = [
  "SELECT s.label",
  "FROM applicant_skills aps",
  "JOIN skill_tags s ON s.id = aps.skill_id",
  "WHERE aps.applicant_user_id = ?",
  "ORDER BY s.label ASC"
].join(" ");
var SELECT_CV_FILES_SQL = [
  "SELECT",
  "  id, original_filename, mime_type, size_bytes,",
  "  is_active, uploaded_at",
  "FROM applicant_cv_files",
  "WHERE applicant_user_id = ?",
  "ORDER BY uploaded_at DESC"
].join(" ");
var SELECT_APPLICATIONS_SQL = [
  "SELECT",
  "  id, uuid, reference_no, job_id,",
  "  stage, source, applied_at, updated_at, hired_at",
  "FROM applications",
  "WHERE applicant_user_id = ?",
  "ORDER BY applied_at DESC"
].join(" ");
var SELECT_BOOKMARKS_SQL2 = [
  "SELECT job_id, created_at",
  "FROM bookmarks",
  "WHERE applicant_user_id = ?",
  "ORDER BY created_at DESC"
].join(" ");
var SELECT_ALERTS_SQL = [
  "SELECT",
  "  id, keyword, locations, departments,",
  "  frequency, last_evaluated_at, created_at",
  "FROM job_alerts",
  "WHERE applicant_user_id = ?",
  "ORDER BY created_at DESC"
].join(" ");
var SELECT_CONSENT_RECORDS_SQL = [
  "SELECT id, policy_version, accepted_at",
  "FROM consent_records",
  "WHERE applicant_user_id = ?",
  "ORDER BY accepted_at DESC"
].join(" ");
function toIsoString(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") return value;
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}
function toDateString(value) {
  const iso = toIsoString(value);
  if (iso === null) return null;
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}
async function exportApplicantData(userId) {
  const [
    profileRows,
    educationRows,
    experienceRows,
    skillRows,
    cvFileRows,
    applicationRows,
    bookmarkRows,
    alertRows,
    consentRows
  ] = await Promise.all([
    query(SELECT_PROFILE_SQL2, [userId]),
    query(SELECT_EDUCATION_SQL, [userId]),
    query(SELECT_EXPERIENCE_SQL, [userId]),
    query(SELECT_SKILLS_SQL, [userId]),
    query(SELECT_CV_FILES_SQL, [userId]),
    query(SELECT_APPLICATIONS_SQL, [userId]),
    query(SELECT_BOOKMARKS_SQL2, [userId]),
    query(SELECT_ALERTS_SQL, [userId]),
    query(SELECT_CONSENT_RECORDS_SQL, [userId])
  ]);
  const profileRow = profileRows[0] ?? null;
  const profile = profileRow ? {
    user_id: Number(profileRow.user_id),
    uuid: profileRow.uuid,
    email: profileRow.email,
    role: profileRow.role,
    status: profileRow.status,
    email_verified_at: toIsoString(profileRow.email_verified_at),
    created_at: toIsoString(profileRow.created_at) ?? "",
    full_name: profileRow.full_name,
    date_of_birth: toDateString(profileRow.date_of_birth),
    gender: profileRow.gender,
    phone: profileRow.phone,
    address: profileRow.address,
    city: profileRow.city,
    province: profileRow.province,
    country: profileRow.country,
    summary: profileRow.summary,
    language_pref: profileRow.language_pref
  } : null;
  const education = educationRows.map((r) => ({
    id: Number(r.id),
    institution: r.institution,
    degree: r.degree,
    field: r.field,
    start_date: toDateString(r.start_date) ?? "",
    end_date: toDateString(r.end_date),
    in_progress: r.in_progress === 1,
    gpa: r.gpa !== null && r.gpa !== void 0 ? Number(r.gpa) : null
  }));
  const experience = experienceRows.map((r) => ({
    id: Number(r.id),
    company: r.company,
    title: r.title,
    employment_type: r.employment_type,
    start_date: toDateString(r.start_date) ?? "",
    end_date: toDateString(r.end_date),
    is_current: r.is_current === 1,
    description: r.description
  }));
  const skills = skillRows.map((r) => ({ label: r.label }));
  const cvFiles = cvFileRows.map((r) => ({
    id: Number(r.id),
    original_filename: r.original_filename,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    is_active: r.is_active === 1,
    uploaded_at: toIsoString(r.uploaded_at) ?? ""
  }));
  const applications = applicationRows.map((r) => ({
    id: Number(r.id),
    uuid: r.uuid,
    reference_no: r.reference_no,
    job_id: Number(r.job_id),
    stage: r.stage,
    source: r.source,
    applied_at: toIsoString(r.applied_at) ?? "",
    updated_at: toIsoString(r.updated_at) ?? "",
    hired_at: toIsoString(r.hired_at)
  }));
  const bookmarks = bookmarkRows.map((r) => ({
    job_id: Number(r.job_id),
    created_at: toIsoString(r.created_at) ?? ""
  }));
  const alerts = alertRows.map((r) => ({
    id: Number(r.id),
    keyword: r.keyword,
    locations: r.locations,
    departments: r.departments,
    frequency: r.frequency,
    last_evaluated_at: toIsoString(r.last_evaluated_at),
    created_at: toIsoString(r.created_at) ?? ""
  }));
  const consentRecords = consentRows.map((r) => ({
    id: Number(r.id),
    policy_version: r.policy_version,
    accepted_at: toIsoString(r.accepted_at) ?? ""
  }));
  return {
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    profile,
    education,
    experience,
    skills,
    cvFiles,
    applications,
    bookmarks,
    alerts,
    consentRecords
  };
}

// src/modules/applicant/consent.ts
var CURRENT_POLICY_VERSION = (process.env.POLICY_VERSION ?? "").trim() || "1.0";
var INSERT_CONSENT_SQL = [
  "INSERT IGNORE INTO consent_records",
  "  (applicant_user_id, policy_version, accepted_at)",
  "VALUES",
  "  (?, ?, NOW())"
].join(" ");
var SELECT_CONSENT_SQL = [
  "SELECT 1 AS found",
  "FROM consent_records",
  "WHERE applicant_user_id = ?",
  "  AND policy_version = ?",
  "LIMIT 1"
].join(" ");
async function recordAcceptance(userId, version, conn) {
  if (conn) {
    await conn.execute(INSERT_CONSENT_SQL, [userId, version]);
  } else {
    await query(INSERT_CONSENT_SQL, [userId, version]);
  }
}

// src/modules/audit/writer.ts
var ACTION_TYPES = [
  // --- Authentication / account (§15 + design §14 security) ---
  "login_success",
  "login_failure",
  "password_reset_request",
  "password_change",
  "role_change",
  "access_denied",
  "account_deletion_request",
  // --- Job postings (§15) ---
  "job_create",
  "job_publish",
  "job_unpublish",
  // --- Applications (§15 + existing audit stubs) ---
  "application_create",
  "application_submitted",
  "application_stage_change",
  "application_note_added",
  "application_withdrawn",
  "interview_scheduled",
  "application_email_sent",
  // --- Data / configuration (§15) ---
  "data_export",
  "mail_template_change",
  "config_change"
];
var INSERT_AUDIT_EVENT_SQL = [
  "INSERT INTO audit_events",
  "(actor_user_id, actor_ip, action_type, target_entity, target_id, details)",
  "VALUES (?, ?, ?, ?, ?, ?)"
].join(" ");
function toInsertParams(input) {
  return [
    input.actorUserId ?? null,
    input.actorIp ?? null,
    input.actionType,
    input.targetEntity,
    input.targetId ?? null,
    input.details == null ? null : JSON.stringify(input.details)
  ];
}
async function write(input, conn) {
  const params = toInsertParams(input);
  if (conn !== void 0) {
    await conn.execute(INSERT_AUDIT_EVENT_SQL, params);
    return;
  }
  await query(INSERT_AUDIT_EVENT_SQL, params);
}
var auditService = { write };

// src/modules/applicant/account-deletion.ts
var UPDATE_USER_STATUS_SQL = [
  "UPDATE users",
  "SET status = 'deleted'",
  "WHERE id = ?"
].join(" ");
var DELETE_USER_SESSIONS_SQL2 = [
  "DELETE FROM sessions",
  "WHERE user_id = ?"
].join(" ");
async function scheduleAccountDeletion(userId, actorIp) {
  await withTransaction(async (conn) => {
    await conn.execute(UPDATE_USER_STATUS_SQL, [userId]);
    await conn.execute(DELETE_USER_SESSIONS_SQL2, [userId]);
    await write(
      {
        actorUserId: userId,
        actorIp: actorIp ?? null,
        actionType: "account_deletion_requested",
        targetEntity: "user",
        targetId: userId,
        details: { userId }
      },
      conn
    );
  });
}

// src/routes/applicant.ts
var SUPPORTED_LOCALES5 = /* @__PURE__ */ new Set(["id", "en"]);
function asString3(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}
function resolveLocale2(request) {
  const raw = request.params.locale;
  return SUPPORTED_LOCALES5.has(raw) ? raw : "id";
}
function profileRecordToFormFields(record) {
  return {
    full_name: record.full_name,
    date_of_birth: record.date_of_birth ?? "",
    gender: record.gender ?? "",
    phone: record.phone ?? "",
    address: record.address ?? "",
    city: record.city ?? "",
    province: record.province ?? "",
    country: record.country ?? "",
    summary: record.summary ?? "",
    language_pref: record.language_pref ?? "id"
  };
}
function formBodyToFormFields(body) {
  return {
    full_name: asString3(body.full_name),
    date_of_birth: asString3(body.date_of_birth),
    gender: asString3(body.gender),
    phone: asString3(body.phone),
    address: asString3(body.address),
    city: asString3(body.city),
    province: asString3(body.province),
    country: asString3(body.country),
    summary: asString3(body.summary),
    language_pref: asString3(body.language_pref) || "id"
  };
}
async function getProfile(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const locale = resolveLocale2(request);
  let record;
  try {
    record = await loadProfile(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.profile: load failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (record === null) {
    app.log.error(
      { userId: session.userId },
      "applicant.profile: applicants row missing for authenticated user"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const saved = asString3(request.query?.saved) === "1";
  const html = app.view("applicant/profile.njk", {
    locale,
    form: profileRecordToFormFields(record),
    errors: {},
    generalError: null,
    saved,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postProfile(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const locale = resolveLocale2(request);
  const body = request.body ?? {};
  const { _csrf: _csrfDiscarded, ...payload } = body;
  try {
    await updateProfile(session.userId, payload);
  } catch (err) {
    if (err instanceof ZodError3) {
      const errors = zodErrorToFieldMap(err);
      const html2 = app.view("applicant/profile.njk", {
        locale,
        form: formBodyToFormFields(body),
        errors,
        generalError: null,
        saved: false,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce
      });
      return reply.code(400).type("text/html; charset=utf-8").send(html2);
    }
    app.log.error(
      { err, userId: session.userId },
      "applicant.profile: update failed"
    );
    const html = app.view("applicant/profile.njk", {
      locale,
      form: formBodyToFormFields(body),
      errors: {},
      generalError: locale === "en" ? "We could not save your profile. Please try again." : "Profil Anda tidak dapat disimpan. Silakan coba lagi.",
      saved: false,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce
    });
    return reply.code(500).type("text/html; charset=utf-8").send(html);
  }
  return reply.code(302).header("location", `/${locale}/me/profile?saved=1`).send();
}
function parseIdParam(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}
function educationBodyToFormValues(body) {
  return {
    institution: asString3(body.institution),
    degree: asString3(body.degree),
    field: asString3(body.field),
    start_date: asString3(body.start_date),
    end_date: asString3(body.end_date),
    in_progress: asString3(body.in_progress).toLowerCase() === "on" || asString3(body.in_progress).toLowerCase() === "true" || asString3(body.in_progress) === "1",
    gpa: asString3(body.gpa)
  };
}
function educationRecordToFormValues(edu) {
  return {
    institution: edu.institution,
    degree: edu.degree,
    field: edu.field,
    start_date: edu.start_date,
    end_date: edu.end_date ?? "",
    in_progress: edu.in_progress,
    gpa: edu.gpa === null ? "" : edu.gpa.toFixed(2)
  };
}
function isHtmxRequest(request) {
  const hdr = request.headers["hx-request"];
  if (typeof hdr === "string") return hdr.toLowerCase() === "true";
  if (Array.isArray(hdr)) {
    return hdr.some((h) => typeof h === "string" && h.toLowerCase() === "true");
  }
  return false;
}
function renderEducationSection(app, options) {
  const capReached = options.educations.length >= MAX_EDUCATION_ENTRIES;
  return app.view("applicant/education-section.njk", {
    locale: options.locale,
    csrfToken: options.csrfToken,
    educations: options.educations,
    capReached,
    addForm: options.addForm ?? null,
    editingId: null,
    editForm: null
  });
}
function renderEducationSectionWithEdit(app, options) {
  const capReached = options.educations.length >= MAX_EDUCATION_ENTRIES;
  return app.view("applicant/education-section.njk", {
    locale: options.locale,
    csrfToken: options.csrfToken,
    educations: options.educations,
    capReached,
    addForm: null,
    editingId: options.editingId,
    editForm: options.editForm ?? null
  });
}
async function getEducationList(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  let educations;
  try {
    educations = await listEducation(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.education: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = renderEducationSection(app, {
    locale,
    csrfToken: session.csrfToken,
    educations
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getEducationEdit(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  const locale = resolveLocale2(request);
  try {
    const target = await findEducationById(session.userId, id);
    if (target === null) {
      return reply.code(404).send({ error: "not_found" });
    }
    const educations = await listEducation(session.userId);
    const html = renderEducationSectionWithEdit(app, {
      locale,
      csrfToken: session.csrfToken,
      educations,
      editingId: id,
      editForm: {
        values: educationRecordToFormValues(target),
        errors: {},
        generalError: null
      }
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, educationId: id },
      "applicant.education: edit form load failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function postEducationCreate(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const body = request.body ?? {};
  const { _csrf: _csrfDiscarded, ...payload } = body;
  try {
    await createEducation(session.userId, payload);
  } catch (err) {
    if (err instanceof ZodError3 || err instanceof EducationCapError) {
      const educations = await listEducation(session.userId).catch(() => []);
      const isCap = err instanceof EducationCapError;
      const status = isCap ? 422 : 400;
      const fieldErrors = isCap ? {} : zodErrorToFieldMap(err);
      const general = isCap ? locale === "en" ? `You can have at most ${MAX_EDUCATION_ENTRIES} education entries.` : `Anda hanya dapat memiliki maksimal ${MAX_EDUCATION_ENTRIES} entri pendidikan.` : null;
      const html = renderEducationSection(app, {
        locale,
        csrfToken: session.csrfToken,
        educations,
        addForm: {
          values: educationBodyToFormValues(body),
          errors: fieldErrors,
          generalError: general
        }
      });
      return reply.code(status).type("text/html; charset=utf-8").send(html);
    }
    app.log.error(
      { err, userId: session.userId },
      "applicant.education: create failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (isHtmxRequest(request)) {
    const educations = await listEducation(session.userId);
    const html = renderEducationSection(app, {
      locale,
      csrfToken: session.csrfToken,
      educations
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html);
  }
  return reply.code(302).header("location", `/${locale}/me/profile/education`).send();
}
async function postEducationUpdate(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  const locale = resolveLocale2(request);
  const body = request.body ?? {};
  const { _csrf: _csrfDiscarded, ...payload } = body;
  try {
    await updateEducation(session.userId, id, payload);
  } catch (err) {
    if (err instanceof EducationNotFoundError) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (err instanceof ZodError3) {
      const educations = await listEducation(session.userId).catch(() => []);
      const html = renderEducationSectionWithEdit(app, {
        locale,
        csrfToken: session.csrfToken,
        educations,
        editingId: id,
        editForm: {
          values: educationBodyToFormValues(body),
          errors: zodErrorToFieldMap(err),
          generalError: null
        }
      });
      return reply.code(400).type("text/html; charset=utf-8").send(html);
    }
    app.log.error(
      { err, userId: session.userId, educationId: id },
      "applicant.education: update failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (isHtmxRequest(request)) {
    const educations = await listEducation(session.userId);
    const html = renderEducationSection(app, {
      locale,
      csrfToken: session.csrfToken,
      educations
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html);
  }
  return reply.code(302).header("location", `/${locale}/me/profile/education`).send();
}
async function postEducationDelete(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  const locale = resolveLocale2(request);
  try {
    await deleteEducation(session.userId, id);
  } catch (err) {
    if (!(err instanceof EducationNotFoundError)) {
      app.log.error(
        { err, userId: session.userId, educationId: id },
        "applicant.education: delete failed"
      );
      return reply.code(500).send({ error: "internal_error" });
    }
  }
  if (isHtmxRequest(request)) {
    const educations = await listEducation(session.userId);
    const html = renderEducationSection(app, {
      locale,
      csrfToken: session.csrfToken,
      educations
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html);
  }
  return reply.code(302).header("location", `/${locale}/me/profile/education`).send();
}
function bodyToExperienceFormValues(body) {
  return {
    company: asString3(body.company),
    title: asString3(body.title),
    employment_type: asString3(body.employment_type),
    start_date: asString3(body.start_date),
    end_date: asString3(body.end_date),
    is_current: asString3(body.is_current).trim() !== "",
    description: asString3(body.description)
  };
}
function recordToExperienceFormValues(record) {
  return {
    company: record.company,
    title: record.title,
    employment_type: record.employment_type,
    start_date: record.start_date,
    end_date: record.end_date ?? "",
    is_current: record.is_current,
    description: record.description ?? ""
  };
}
function stripCsrf(body) {
  const { _csrf: _drop, ...rest } = body;
  return rest;
}
function renderExperienceSection(app, options) {
  return app.view("applicant/experience-section.njk", {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    experiences: options.experiences,
    capReached: options.experiences.length >= MAX_EXPERIENCE_ENTRIES,
    employmentTypes: EMPLOYMENT_TYPES,
    addForm: options.addForm ?? null,
    editingId: options.editingId ?? null,
    editForm: options.editForm ?? null
  });
}
function parseExperienceId(raw) {
  if (!/^[1-9]\d{0,18}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
async function getExperience(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postExperienceCreate(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const body = request.body ?? {};
  const payload = stripCsrf(body);
  try {
    await createExperience(session.userId, payload);
  } catch (err) {
    const experiences2 = await listExperience(session.userId);
    if (err instanceof ZodError3) {
      const html3 = renderExperienceSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        experiences: experiences2,
        addForm: {
          values: bodyToExperienceFormValues(body),
          errors: zodErrorToFieldMap(err),
          generalError: null
        }
      });
      return reply.code(400).type("text/html; charset=utf-8").send(html3);
    }
    if (err instanceof ExperienceCapError) {
      const message = locale === "en" ? `You can have at most ${MAX_EXPERIENCE_ENTRIES} experience entries.` : `Anda hanya dapat memiliki maksimum ${MAX_EXPERIENCE_ENTRIES} pengalaman.`;
      const html3 = renderExperienceSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        experiences: experiences2,
        addForm: {
          values: bodyToExperienceFormValues(body),
          errors: {},
          generalError: message
        }
      });
      return reply.code(422).type("text/html; charset=utf-8").send(html3);
    }
    app.log.error(
      { err, userId: session.userId },
      "applicant.experience: create failed"
    );
    const html2 = renderExperienceSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      experiences: experiences2,
      addForm: {
        values: bodyToExperienceFormValues(body),
        errors: {},
        generalError: locale === "en" ? "We could not save your experience entry. Please try again." : "Pengalaman Anda tidak dapat disimpan. Silakan coba lagi."
      }
    });
    return reply.code(500).type("text/html; charset=utf-8").send(html2);
  }
  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postExperienceEdit(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: "not_found" });
  const locale = resolveLocale2(request);
  const body = request.body ?? {};
  const payload = stripCsrf(body);
  const existing = await findExperienceById(session.userId, id);
  if (existing === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  let parsed;
  try {
    parsed = experienceSchema.parse(payload);
  } catch (err) {
    if (err instanceof ZodError3) {
      const experiences2 = await listExperience(session.userId);
      const html2 = renderExperienceSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        experiences: experiences2,
        editingId: id,
        editForm: {
          values: bodyToExperienceFormValues(body),
          errors: zodErrorToFieldMap(err),
          generalError: null
        }
      });
      return reply.code(400).type("text/html; charset=utf-8").send(html2);
    }
    throw err;
  }
  try {
    await updateExperience(session.userId, id, parsed);
  } catch (err) {
    if (err instanceof ExperienceNotFoundError) {
      return reply.code(404).send({ error: "not_found" });
    }
    app.log.error(
      { err, userId: session.userId, id },
      "applicant.experience: update failed"
    );
    const experiences2 = await listExperience(session.userId);
    const html2 = renderExperienceSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      experiences: experiences2,
      editingId: id,
      editForm: {
        values: bodyToExperienceFormValues(body),
        errors: {},
        generalError: locale === "en" ? "We could not save your experience entry. Please try again." : "Pengalaman Anda tidak dapat disimpan. Silakan coba lagi."
      }
    });
    return reply.code(500).type("text/html; charset=utf-8").send(html2);
  }
  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getExperienceEdit(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: "not_found" });
  const existing = await findExperienceById(session.userId, id);
  if (existing === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  const locale = resolveLocale2(request);
  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences,
    editingId: id,
    editForm: {
      values: recordToExperienceFormValues(existing),
      errors: {},
      generalError: null
    }
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postExperienceDelete(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: "not_found" });
  const locale = resolveLocale2(request);
  try {
    await deleteExperience(session.userId, id);
  } catch (err) {
    if (err instanceof ExperienceNotFoundError) {
      return reply.code(404).send({ error: "not_found" });
    }
    app.log.error(
      { err, userId: session.userId, id },
      "applicant.experience: delete failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getExperienceRow(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: "not_found" });
  const existing = await findExperienceById(session.userId, id);
  if (existing === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  const locale = resolveLocale2(request);
  const html = app.view("applicant/experience-row.njk", {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    exp: existing,
    editingId: null,
    editForm: null,
    employmentTypes: EMPLOYMENT_TYPES
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
function renderSkillSection(app, options) {
  return app.view("applicant/skill-section.njk", {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    assigned: options.assigned,
    capReached: options.assigned.length >= MAX_SKILLS_PER_APPLICANT,
    generalError: options.generalError
  });
}
function renderSkillSearchResults(app, options) {
  return app.view("applicant/skill-search-results.njk", {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    results: options.results,
    assignedIds: options.assignedIds,
    capReached: options.capReached
  });
}
async function getSkills(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  let assigned;
  try {
    assigned = await listAssignedSkills(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.skills: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = renderSkillSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    assigned,
    generalError: null
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postSkillToggle(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const body = request.body ?? {};
  const messages = {
    invalid: locale === "en" ? "Could not identify the requested skill. Please try again." : "Skill yang diminta tidak dapat dikenali. Silakan coba lagi.",
    capReached: locale === "en" ? `You have reached the limit of ${MAX_SKILLS_PER_APPLICANT} skills. Remove one before adding another.` : `Anda telah mencapai batas ${MAX_SKILLS_PER_APPLICANT} skill. Hapus salah satu sebelum menambah yang baru.`,
    notFound: locale === "en" ? "That skill is no longer available." : "Skill tersebut sudah tidak tersedia.",
    failed: locale === "en" ? "We could not update your skills. Please try again." : "Skill Anda tidak dapat diperbarui. Silakan coba lagi."
  };
  let skillId;
  try {
    skillId = skillIdSchema.parse(body.skill_id);
  } catch (err) {
    if (err instanceof ZodError3) {
      const assigned2 = await listAssignedSkills(session.userId).catch(
        () => []
      );
      const html2 = renderSkillSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        assigned: assigned2,
        generalError: messages.invalid
      });
      return reply.code(400).type("text/html; charset=utf-8").send(html2);
    }
    throw err;
  }
  try {
    await toggleSkill(session.userId, skillId);
  } catch (err) {
    const assigned2 = await listAssignedSkills(session.userId).catch(() => []);
    if (err instanceof SkillCapError) {
      const html3 = renderSkillSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        assigned: assigned2,
        generalError: messages.capReached
      });
      return reply.code(422).type("text/html; charset=utf-8").send(html3);
    }
    if (err instanceof SkillInactiveError || err instanceof SkillNotFoundError) {
      const html3 = renderSkillSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        assigned: assigned2,
        generalError: messages.notFound
      });
      return reply.code(422).type("text/html; charset=utf-8").send(html3);
    }
    app.log.error(
      { err, userId: session.userId, skillId },
      "applicant.skills: toggle failed"
    );
    const html2 = renderSkillSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      assigned: assigned2,
      generalError: messages.failed
    });
    return reply.code(500).type("text/html; charset=utf-8").send(html2);
  }
  const assigned = await listAssignedSkills(session.userId);
  const html = renderSkillSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    assigned,
    generalError: null
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getSkillSearch(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const rawQuery = asString3(request.query?.q);
  let assigned;
  let results;
  try {
    [assigned, results] = await Promise.all([
      listAssignedSkills(session.userId),
      searchSkills(rawQuery)
    ]);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.skills: search failed"
    );
    const html2 = renderSkillSearchResults(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      results: [],
      assignedIds: [],
      capReached: false
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html2);
  }
  const html = renderSkillSearchResults(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    results,
    assignedIds: assigned.map((s) => s.id),
    capReached: assigned.length >= MAX_SKILLS_PER_APPLICANT
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
function sanitiseAttachmentFilename(raw, mimeType) {
  const fallback = mimeType === "application/pdf" ? "cv.pdf" : mimeType === "application/msword" ? "cv.doc" : mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "cv.docx" : "cv";
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").replace(/["\\]/g, "").replace(/[/\\]/g, "_").split("").filter((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 32 && c <= 126;
  }).join("").trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}
async function getCvDownload(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const cvId = parseIdParam(request.params.id);
  if (cvId === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  let descriptor;
  try {
    descriptor = await loadCvForDownload(
      session.userId,
      session.role,
      cvId
    );
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, cvId },
      "applicant.cv.download: lookup failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (descriptor === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  let sizeBytes = null;
  try {
    const stats = await stat2(descriptor.absolutePath);
    if (!stats.isFile()) {
      app.log.warn(
        { userId: session.userId, cvId, path: descriptor.absolutePath },
        "applicant.cv.download: stored path is not a regular file"
      );
      return reply.code(404).send({ error: "not_found" });
    }
    sizeBytes = stats.size;
  } catch (err) {
    const code = err?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      app.log.warn(
        { userId: session.userId, cvId, path: descriptor.absolutePath },
        "applicant.cv.download: file missing on disk"
      );
      return reply.code(404).send({ error: "not_found" });
    }
    app.log.error(
      { err, userId: session.userId, cvId, path: descriptor.absolutePath },
      "applicant.cv.download: stat failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const filename = sanitiseAttachmentFilename(
    descriptor.originalFilename,
    descriptor.mimeType
  );
  reply.code(200).type(descriptor.mimeType).header("Content-Disposition", `attachment; filename="${filename}"`).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, no-store");
  if (sizeBytes !== null) {
    reply.header("Content-Length", String(sizeBytes));
  }
  const stream = createReadStream(descriptor.absolutePath);
  return reply.send(stream);
}
function renderCvSection(app, options) {
  return app.view("applicant/cv-section.njk", {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cvs: options.cvs,
    generalError: options.generalError ?? null,
    saved: options.saved ?? false,
    maxBytes: MAX_CV_BYTES,
    maxHistory: MAX_CV_HISTORY,
    allowedMimes: ALLOWED_CV_MIMES
  });
}
function cvErrorMessage(locale, kind) {
  const id = locale === "en" ? "en" : "id";
  const msgs = {
    id: {
      too_large: "Ukuran berkas melebihi 5 MB. Pilih CV yang lebih kecil.",
      mime: "Format berkas tidak didukung. Gunakan PDF, DOC, atau DOCX.",
      storage: "Penyimpanan server hampir penuh. Silakan coba lagi beberapa saat lagi.",
      internal: "CV Anda tidak dapat diunggah. Silakan coba lagi."
    },
    en: {
      too_large: "File size exceeds 5 MB. Please choose a smaller CV.",
      mime: "Unsupported file format. Use PDF, DOC, or DOCX.",
      storage: "Server storage is almost full. Please try again in a few moments.",
      internal: "We could not upload your CV. Please try again."
    }
  };
  return msgs[id][kind];
}
async function getCv(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  let cvs;
  try {
    cvs = await listCvsForOwner(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.cv: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const saved = asString3(request.query?.saved) === "1";
  const html = renderCvSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cvs,
    saved
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postCv(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  if (typeof request.isMultipart !== "function" || !request.isMultipart()) {
    const cvs2 = await listCvsForOwner(session.userId).catch(() => []);
    const html2 = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs: cvs2,
      generalError: cvErrorMessage(locale, "mime")
    });
    return reply.code(400).type("text/html; charset=utf-8").send(html2);
  }
  let multipartFile;
  try {
    multipartFile = await request.file();
  } catch (err) {
    const fastifyErr = err;
    const code = fastifyErr?.code;
    const status = fastifyErr?.statusCode;
    const cvs2 = await listCvsForOwner(session.userId).catch(() => []);
    if (code === "FST_REQ_FILE_TOO_LARGE" || status === 413) {
      const html3 = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs: cvs2,
        generalError: cvErrorMessage(locale, "too_large")
      });
      return reply.code(413).type("text/html; charset=utf-8").send(html3);
    }
    app.log.error(
      { err, userId: session.userId },
      "applicant.cv: multipart parse failed"
    );
    const html2 = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs: cvs2,
      generalError: cvErrorMessage(locale, "internal")
    });
    return reply.code(400).type("text/html; charset=utf-8").send(html2);
  }
  if (!multipartFile) {
    const cvs2 = await listCvsForOwner(session.userId).catch(() => []);
    const html2 = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs: cvs2,
      generalError: cvErrorMessage(locale, "mime")
    });
    return reply.code(400).type("text/html; charset=utf-8").send(html2);
  }
  try {
    await processCvUpload({
      userId: session.userId,
      multipartFile: {
        file: multipartFile.file,
        mimetype: multipartFile.mimetype,
        filename: multipartFile.filename
      }
    });
  } catch (err) {
    try {
      multipartFile.file.resume();
    } catch {
    }
    const cvs2 = await listCvsForOwner(session.userId).catch(() => []);
    if (err instanceof FileTooLargeError) {
      const html3 = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs: cvs2,
        generalError: cvErrorMessage(locale, "too_large")
      });
      return reply.code(413).type("text/html; charset=utf-8").send(html3);
    }
    if (err instanceof MimeMismatchError) {
      const html3 = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs: cvs2,
        generalError: cvErrorMessage(locale, "mime")
      });
      return reply.code(415).type("text/html; charset=utf-8").send(html3);
    }
    if (err instanceof InsufficientStorageError) {
      const html3 = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs: cvs2,
        generalError: cvErrorMessage(locale, "storage")
      });
      return reply.code(507).type("text/html; charset=utf-8").send(html3);
    }
    const fastifyErr = err;
    if (fastifyErr?.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr?.statusCode === 413) {
      const html3 = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs: cvs2,
        generalError: cvErrorMessage(locale, "too_large")
      });
      return reply.code(413).type("text/html; charset=utf-8").send(html3);
    }
    app.log.error(
      { err, userId: session.userId },
      "applicant.cv: upload failed"
    );
    const html2 = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs: cvs2,
      generalError: cvErrorMessage(locale, "internal")
    });
    return reply.code(500).type("text/html; charset=utf-8").send(html2);
  }
  const cvs = await listCvsForOwner(session.userId).catch(() => []);
  const html = renderCvSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cvs,
    saved: true
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getDashboard(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const locale = resolveLocale2(request);
  let profile;
  let educationCount = 0;
  let experienceCount = 0;
  let hasActiveCv = false;
  try {
    const [profileRow, educations, experiences, activeCv] = await Promise.all([
      loadProfile(session.userId),
      listEducation(session.userId),
      listExperience(session.userId),
      hasActiveCvForOwner(session.userId)
    ]);
    profile = profileRow;
    educationCount = educations.length;
    experienceCount = experiences.length;
    hasActiveCv = activeCv;
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.dashboard: load failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (profile === null) {
    app.log.error(
      { userId: session.userId },
      "applicant.dashboard: applicants row missing for authenticated user"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const completenessInput = {
    full_name: profile.full_name,
    date_of_birth: profile.date_of_birth,
    phone: profile.phone,
    address: profile.address,
    city: profile.city,
    province: profile.province,
    country: profile.country,
    summary: profile.summary,
    hasEducation: educationCount > 0,
    hasExperience: experienceCount > 0,
    hasActiveCv
  };
  const { percentage, missingFields } = computeCompleteness(completenessInput);
  const html = app.view("applicant/dashboard.njk", {
    locale,
    percentage,
    // Cast through `unknown` for nunjucks: the readonly tuple type from
    // `computeCompleteness` is structurally compatible with `string[]`,
    // and the view only iterates / inspects `length`.
    missingFields,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
var applyBodySchema = z11.object({
  jobId: z11.coerce.number({ required_error: "jobId is required" }).int({ message: "jobId must be an integer" }).positive({ message: "jobId must be positive" })
}).passthrough();
var APPLY_SOURCE_VALUES = /* @__PURE__ */ new Set([
  "direct",
  "search",
  "alert",
  "social",
  "unknown"
]);
function isApplySource(value) {
  return APPLY_SOURCE_VALUES.has(value);
}
function readApplySourceParam(query2) {
  if (!query2 || typeof query2 !== "object") return void 0;
  const raw = query2.ref;
  let candidate;
  if (typeof raw === "string") {
    candidate = raw;
  } else if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === "string");
    candidate = typeof first === "string" ? first : void 0;
  }
  if (candidate === void 0) return void 0;
  const normalised = candidate.trim().toLowerCase();
  return isApplySource(normalised) ? normalised : void 0;
}
async function postApply(app, request, reply) {
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const rawBody = request.body !== null && typeof request.body === "object" ? request.body : {};
  let parsed;
  try {
    parsed = applyBodySchema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError3) {
      const errors = zodErrorToFieldMap(err);
      return reply.code(400).send({ error: "invalid_body", errors });
    }
    throw err;
  }
  const locale = "id";
  const sourceParam = readApplySourceParam(request.query);
  let result;
  try {
    result = await applyToJob({
      applicantUserId: session.userId,
      jobId: parsed.jobId,
      sourceParam
    });
  } catch (err) {
    if (err instanceof MissingCvError) {
      return reply.code(422).send({
        error: "missing_cv",
        missingFields: ["hasActiveCv"]
      });
    }
    if (err instanceof IncompleteProfileError) {
      return reply.code(422).send({
        error: "incomplete_profile",
        percentage: err.percentage,
        missingFields: err.missingFields
      });
    }
    if (err instanceof JobUnavailableError) {
      return reply.code(422).send({
        error: "job_unavailable",
        jobId: err.jobId
      });
    }
    if (err instanceof DuplicateApplicationError) {
      return reply.code(409).send({
        error: "duplicate_application",
        jobId: err.jobId
      });
    }
    app.log.error(
      { err, userId: session.userId, jobId: parsed.jobId },
      "apply: unexpected error"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const location = `/${locale}/me/applications/${result.id}`;
  reply.header("hx-redirect", location);
  return reply.code(302).header("location", location).send();
}
var bookmarkToggleBodySchema = z11.object({
  jobId: z11.coerce.number({ required_error: "jobId is required" }).int({ message: "jobId must be an integer" }).positive({ message: "jobId must be positive" })
}).passthrough();
function renderBookmarkButton(app, options) {
  return app.view("partials/bookmark-button.njk", {
    locale: options.locale,
    jobId: options.jobId,
    bookmarked: options.bookmarked,
    csrfToken: options.csrfToken
  });
}
async function postBookmarkToggle(app, request, reply) {
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const rawBody = request.body !== null && typeof request.body === "object" ? request.body : {};
  let parsed;
  try {
    parsed = bookmarkToggleBodySchema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError3) {
      const errors = zodErrorToFieldMap(err);
      return reply.code(400).send({ error: "invalid_body", errors });
    }
    throw err;
  }
  const locale = "id";
  let bookmarked;
  try {
    const result = await toggle(session.userId, parsed.jobId);
    bookmarked = result.bookmarked;
  } catch (err) {
    if (err instanceof JobNotFoundError2) {
      return reply.code(404).send({ error: "job_not_found" });
    }
    app.log.error(
      { err, userId: session.userId, jobId: parsed.jobId },
      "bookmarks.toggle: failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = renderBookmarkButton(app, {
    locale,
    jobId: parsed.jobId,
    bookmarked,
    csrfToken: session.csrfToken
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getBookmarks(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  let bookmarks;
  try {
    bookmarks = await list2(session.userId, locale);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.bookmarks: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = app.view("applicant/bookmarks.njk", {
    locale,
    bookmarks,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
function alertBodyToFormValues(body) {
  const joinList = (value) => {
    if (Array.isArray(value)) {
      return value.filter((v) => typeof v === "string" || typeof v === "number").join(", ");
    }
    return asString3(value);
  };
  return {
    keyword: asString3(body.keyword),
    locations: joinList(body.locations),
    departments: joinList(body.departments),
    frequency: asString3(body.frequency) || "Daily"
  };
}
function renderAlertsSection(app, options) {
  const capReached = options.alerts.length >= MAX_ALERTS_PER_APPLICANT;
  const template = options.wrap ? "applicant/alerts.njk" : "applicant/alerts-section.njk";
  return app.view(template, {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    alerts: options.alerts,
    capReached,
    form: options.form ?? null
  });
}
async function getAlerts(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  let alerts;
  try {
    alerts = await listAlerts(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.alerts: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = renderAlertsSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    alerts,
    wrap: true
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postAlertCreate(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const body = request.body ?? {};
  const { _csrf: _csrfDiscarded, ...payload } = body;
  const htmx = isHtmxRequest(request);
  try {
    await createAlert({ applicantUserId: session.userId, input: payload });
  } catch (err) {
    if (err instanceof InvalidAlertInputError || err instanceof AlertCapError) {
      const isCap = err instanceof AlertCapError;
      const alerts = await listAlerts(session.userId).catch(() => []);
      const fieldErrors = isCap ? {} : err.fieldErrors;
      const generalError = isCap ? locale === "en" ? `You can have at most ${MAX_ALERTS_PER_APPLICANT} job alerts. Remove one to add a new alert.` : `Anda hanya dapat memiliki maksimal ${MAX_ALERTS_PER_APPLICANT} notifikasi. Hapus salah satu untuk menambah yang baru.` : null;
      const html = renderAlertsSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        alerts,
        form: {
          values: alertBodyToFormValues(body),
          errors: fieldErrors,
          generalError
        },
        wrap: !htmx
      });
      return reply.code(422).type("text/html; charset=utf-8").send(html);
    }
    app.log.error(
      { err, userId: session.userId },
      "applicant.alerts: create failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (htmx) {
    const alerts = await listAlerts(session.userId);
    const html = renderAlertsSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      alerts,
      wrap: false
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html);
  }
  return reply.code(302).header("location", `/${locale}/me/alerts`).send();
}
async function postAlertDelete(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: "not_found" });
  }
  const locale = resolveLocale2(request);
  try {
    await removeAlert({ applicantUserId: session.userId, id });
  } catch (err) {
    if (!(err instanceof AlertNotFoundError)) {
      app.log.error(
        { err, userId: session.userId, alertId: id },
        "applicant.alerts: delete failed"
      );
      return reply.code(500).send({ error: "internal_error" });
    }
  }
  if (isHtmxRequest(request)) {
    const alerts = await listAlerts(session.userId);
    const html = renderAlertsSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      alerts,
      wrap: false
    });
    return reply.code(200).type("text/html; charset=utf-8").send(html);
  }
  return reply.code(302).header("location", `/${locale}/me/alerts`).send();
}
function parseApplicationId(raw) {
  if (!/^[1-9]\d{0,18}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function parsePageQuery(raw) {
  if (typeof raw === "string" && /^[1-9]\d{0,4}$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return 1;
}
function renderApplicantNotFound(app, reply, locale, cspNonce) {
  const html = app.view("applicant/404.njk", {
    locale,
    cspNonce
  });
  return reply.code(404).type("text/html; charset=utf-8").send(html);
}
async function getApplicationsList(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const page = parsePageQuery(request.query?.page);
  const pageSize = APPLICATION_LIST_DEFAULT_PAGE_SIZE;
  let result;
  try {
    result = await listForApplicant(session.userId, {
      locale,
      page,
      pageSize
    });
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.applications: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = app.view("applicant/applications-list.njk", {
    locale,
    rows: result.rows,
    total: result.total,
    page,
    pageSize,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getApplicationDetail(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const id = parseApplicationId(request.params.id);
  if (id === null) {
    return renderApplicantNotFound(app, reply, locale, request.cspNonce);
  }
  let detail;
  try {
    detail = await findOneForApplicant(session.userId, id, {
      locale
    });
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, applicationId: id },
      "applicant.applications: detail failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (detail === null) {
    return renderApplicantNotFound(app, reply, locale, request.cspNonce);
  }
  const html = app.view("applicant/application-detail.njk", {
    locale,
    app: detail,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postApplicationWithdraw(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;
  const locale = resolveLocale2(request);
  const id = parseApplicationId(request.params.id);
  if (id === null) {
    return renderApplicantNotFound(app, reply, locale, request.cspNonce);
  }
  try {
    await withdrawApplication({
      applicantUserId: session.userId,
      applicationId: id
    });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) {
      return renderApplicantNotFound(app, reply, locale, request.cspNonce);
    }
    if (err instanceof WithdrawNotAllowedError) {
      return reply.code(409).send({
        error: "terminal_stage",
        stage: err.stage
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId: id },
      "applicant.applications: withdraw failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const location = `/${locale}/me/applications/${id}`;
  reply.header("hx-redirect", location);
  return reply.code(302).header("location", location).send();
}
async function getDataExport(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  let exportData;
  try {
    exportData = await exportApplicantData(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.data-export: export failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  return reply.code(200).header("Content-Type", "application/json; charset=utf-8").header("Content-Disposition", 'attachment; filename="data-export.json"').send(JSON.stringify(exportData, null, 2));
}
async function getConsent(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const locale = resolveLocale2(request);
  const html = app.view("applicant/consent.njk", {
    locale,
    policyVersion: CURRENT_POLICY_VERSION,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postConsent(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const locale = resolveLocale2(request);
  try {
    await recordAcceptance(session.userId, CURRENT_POLICY_VERSION);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.consent: recordAcceptance failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  return reply.code(302).header("location", `/${locale}/me`).send();
}
async function postAccountDelete(app, request, reply) {
  if (!SUPPORTED_LOCALES5.has(request.params.locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }
  const locale = resolveLocale2(request);
  const actorIp = typeof request.ip === "string" && request.ip.length > 0 ? request.ip : null;
  try {
    await scheduleAccountDeletion(session.userId, actorIp);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "applicant.account-delete: scheduleAccountDeletion failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE_OPTIONS);
  return reply.code(302).header("location", `/${locale}/`).send();
}
var applicantRoutes = async (app) => {
  app.get(
    "/:locale/me",
    (request, reply) => getDashboard(app, request, reply)
  );
  app.get(
    "/:locale/me/profile",
    (request, reply) => getProfile(app, request, reply)
  );
  app.post(
    "/:locale/me/profile",
    (request, reply) => postProfile(app, request, reply)
  );
  app.get(
    "/:locale/me/profile/education",
    (request, reply) => getEducationList(app, request, reply)
  );
  app.post(
    "/:locale/me/profile/education",
    (request, reply) => postEducationCreate(app, request, reply)
  );
  app.get(
    "/:locale/me/profile/education/:id/edit",
    (request, reply) => getEducationEdit(app, request, reply)
  );
  app.post(
    "/:locale/me/profile/education/:id",
    (request, reply) => postEducationUpdate(app, request, reply)
  );
  app.post(
    "/:locale/me/profile/education/:id/delete",
    (request, reply) => postEducationDelete(app, request, reply)
  );
  app.get(
    "/:locale/me/profile/experience",
    (request, reply) => getExperience(app, request, reply)
  );
  app.post(
    "/:locale/me/profile/experience",
    (request, reply) => postExperienceCreate(app, request, reply)
  );
  app.get(
    "/:locale/me/profile/experience/:id/edit",
    (request, reply) => getExperienceEdit(app, request, reply)
  );
  app.post(
    "/:locale/me/profile/experience/:id/edit",
    (request, reply) => postExperienceEdit(app, request, reply)
  );
  app.post(
    "/:locale/me/profile/experience/:id/delete",
    (request, reply) => postExperienceDelete(app, request, reply)
  );
  app.get(
    "/:locale/me/profile/experience/:id/row",
    (request, reply) => getExperienceRow(app, request, reply)
  );
  app.get(
    "/:locale/me/profile/skills",
    (request, reply) => getSkills(app, request, reply)
  );
  app.post(
    "/:locale/me/profile/skills/toggle",
    (request, reply) => postSkillToggle(app, request, reply)
  );
  app.get(
    "/:locale/me/profile/skills/search",
    (request, reply) => getSkillSearch(app, request, reply)
  );
  app.get(
    "/:locale/me/cv/:id",
    (request, reply) => getCvDownload(app, request, reply)
  );
  app.get(
    "/:locale/me/cv",
    (request, reply) => getCv(app, request, reply)
  );
  app.post(
    "/:locale/me/cv",
    (request, reply) => postCv(app, request, reply)
  );
  app.post(
    "/api/applications",
    (request, reply) => postApply(app, request, reply)
  );
  app.post(
    "/api/bookmarks/toggle",
    (request, reply) => postBookmarkToggle(app, request, reply)
  );
  app.get(
    "/:locale/me/bookmarks",
    (request, reply) => getBookmarks(app, request, reply)
  );
  app.get(
    "/:locale/me/alerts",
    (request, reply) => getAlerts(app, request, reply)
  );
  app.post(
    "/:locale/me/alerts",
    (request, reply) => postAlertCreate(app, request, reply)
  );
  app.post(
    "/:locale/me/alerts/:id/delete",
    (request, reply) => postAlertDelete(app, request, reply)
  );
  app.get(
    "/:locale/me/applications",
    (request, reply) => getApplicationsList(app, request, reply)
  );
  app.get(
    "/:locale/me/applications/:id",
    (request, reply) => getApplicationDetail(app, request, reply)
  );
  app.post(
    "/:locale/me/applications/:id/withdraw",
    (request, reply) => postApplicationWithdraw(app, request, reply)
  );
  app.get(
    "/:locale/me/consent",
    (request, reply) => getConsent(app, request, reply)
  );
  app.post(
    "/:locale/me/consent",
    (request, reply) => postConsent(app, request, reply)
  );
  app.get(
    "/:locale/me/data-export",
    (request, reply) => getDataExport(app, request, reply)
  );
  app.post(
    "/:locale/me/account/delete",
    (request, reply) => postAccountDelete(app, request, reply)
  );
};
var applicant_default = applicantRoutes;

// src/routes/admin.ts
import fs2 from "node:fs/promises";
import os2 from "node:os";
import path4 from "node:path";
import { ZodError as ZodError9 } from "zod";

// src/infra/admin-guard.ts
var SUPPORTED_LOCALES6 = /* @__PURE__ */ new Set(["id", "en"]);
var DEFAULT_LOCALE4 = "id";
var INTERNAL_ROLES = [
  "Super_Admin",
  "HR",
  "Department_Head"
];
function resolveRequestLocale2(request) {
  const params = request.params ?? {};
  const raw = params.locale;
  if (typeof raw === "string" && SUPPORTED_LOCALES6.has(raw)) {
    return raw;
  }
  return DEFAULT_LOCALE4;
}
function redirectToLogin2(request, reply) {
  const locale = resolveRequestLocale2(request);
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE_OPTIONS);
  return reply.code(302).header("location", `/${locale}/login`).send();
}
function send403(reply, role) {
  return reply.code(403).send({ error: "forbidden", role });
}
var SELECT_ASSIGNED_DEPARTMENTS_SQL = "SELECT department_id FROM user_department_assignments WHERE user_id = ?";
async function loadDepartmentScope(userId) {
  const rows = await query(
    SELECT_ASSIGNED_DEPARTMENTS_SQL,
    [userId]
  );
  return rows.map((row) => Number(row.department_id));
}
async function requireAdmin(request, reply, options = {}) {
  const sid = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid !== "string" || sid.length !== TOKEN_LENGTH) {
    redirectToLogin2(request, reply);
    return null;
  }
  let session;
  try {
    session = await read(sid);
  } catch (err) {
    request.log.warn(
      { err, sidPrefix: sid.slice(0, 8) },
      "admin-guard: session lookup failed, redirecting to login"
    );
    redirectToLogin2(request, reply);
    return null;
  }
  if (session === null) {
    redirectToLogin2(request, reply);
    return null;
  }
  if (!INTERNAL_ROLES.includes(session.role)) {
    redirectToLogin2(request, reply);
    return null;
  }
  const allowed = options.allowedRoles ?? INTERNAL_ROLES;
  if (!allowed.includes(session.role)) {
    send403(reply, session.role);
    return null;
  }
  let scope;
  if (session.role === "Department_Head") {
    try {
      const depts = await loadDepartmentScope(session.userId);
      scope = { departments: depts };
    } catch (err) {
      request.log.error(
        { err, userId: session.userId },
        "admin-guard: failed to resolve department scope"
      );
      scope = { departments: [] };
    }
  } else {
    scope = {};
  }
  return { ...session, scope };
}

// src/modules/security/policies.ts
var POLICY_ROLES = {
  // --- Job postings (§14.1) ---
  "job.create": ["Super_Admin", "HR"],
  "job.publish": ["Super_Admin", "HR"],
  "job.read": ["Super_Admin", "HR", "Department_Head"],
  // --- Applications (§14.1) ---
  "application.note.add": ["Super_Admin", "HR", "Department_Head"],
  "application.stage.change": ["Super_Admin", "HR"],
  "application.export": ["Super_Admin", "HR"],
  // --- User / audit / backup (§14.1) ---
  "user.invite": ["Super_Admin"],
  "audit.read": ["Super_Admin"],
  "backup.read": ["Super_Admin"],
  // --- Mail templates (Req 11.3; not in §14.1 code block) ---
  "mail_template.manage": ["Super_Admin", "HR"],
  // --- Reporting (Req 13.1-13.3; §14.1 — HR + Super_Admin, not Department_Head) ---
  "report.read": ["Super_Admin", "HR"],
  // --- Diagnostics (Req 20.4; §18.3 — Super_Admin only) ---
  "diagnostics.read": ["Super_Admin"]
};
var POLICIES = Object.freeze(
  Object.fromEntries(
    Object.entries(POLICY_ROLES).map(
      ([name, roles]) => [name, new Set(roles)]
    )
  )
);
function can(role, policy) {
  return POLICIES[policy].has(role);
}
var FORBIDDEN_VIEW = "admin/403.njk";
function requirePolicy(policyName) {
  return async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (session === null) {
      return null;
    }
    if (can(session.role, policyName)) {
      return session;
    }
    try {
      await auditService.write({
        actorUserId: session.userId,
        actorIp: request.ip,
        actionType: "access_denied",
        targetEntity: "policy",
        targetId: null,
        details: { policy: policyName, role: session.role }
      });
    } catch (err) {
      request.log.error(
        { err, userId: session.userId, policy: policyName },
        "requirePolicy: failed to write access_denied audit event"
      );
    }
    const html = request.server.view(FORBIDDEN_VIEW, {
      role: session.role,
      policy: policyName,
      cspNonce: request.cspNonce
    });
    reply.code(403).type("text/html; charset=utf-8").send(html);
    return null;
  };
}

// src/modules/jobs/service.ts
import { z as z12 } from "zod";
var SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var slugSchema = z12.string({ required_error: "Slug is required" }).trim().min(1, { message: "Slug is required" }).max(SLUG_MAX_LEN, { message: `Slug must be at most ${SLUG_MAX_LEN} characters` }).regex(SLUG_REGEX, {
  message: "Slug must be kebab-case (lowercase letters, digits, hyphens; no spaces)"
});
var optionalSlugSchema = z12.string().trim().max(SLUG_MAX_LEN, { message: `Slug must be at most ${SLUG_MAX_LEN} characters` }).refine((v) => v === "" || SLUG_REGEX.test(v), {
  message: "Slug must be kebab-case (lowercase letters, digits, hyphens; no spaces)"
});
var locationSchema = z12.string({ required_error: "Location is required" }).trim().min(1, { message: "Location is required" }).max(LOCATION_MAX_LEN, {
  message: `Location must be at most ${LOCATION_MAX_LEN} characters`
});
var employmentTypeSchema2 = z12.enum(EMPLOYMENT_TYPES2);
var levelSchema = z12.enum(JOB_LEVELS);
var statusSchema = z12.enum(JOB_STATUSES);
var optionalIntStringSchema = z12.union([z12.number(), z12.string()]).optional().transform((v, ctx) => {
  if (v === void 0) return null;
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    const n = Number(v.trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      ctx.addIssue({
        code: z12.ZodIssueCode.custom,
        message: "Must be a non-negative integer"
      });
      return null;
    }
    return n;
  }
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    ctx.addIssue({
      code: z12.ZodIssueCode.custom,
      message: "Must be a non-negative integer"
    });
    return null;
  }
  return v;
});
var optionalCurrencySchema = z12.string().trim().optional().transform((v) => {
  if (v === void 0 || v === "") return null;
  return v.toUpperCase();
}).refine((v) => v === null || /^[A-Z]{3}$/.test(v), {
  message: "Currency must be a 3-letter ISO code (e.g. IDR, USD)"
});
var optionalDateSchema = z12.string().trim().optional().transform((v) => {
  if (v === void 0 || v === "") return null;
  return v;
}).refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), {
  message: "Date must be in YYYY-MM-DD format"
}).refine(
  (v) => v === null || !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
  { message: "Date is not a valid calendar date" }
);
var optionalTranslationSchema = z12.object({
  locale: z12.enum(JOB_LOCALES),
  title: z12.string().trim().max(TITLE_MAX_LEN),
  description: z12.string().trim().max(3e4),
  requirements: z12.string().trim().max(3e4),
  responsibilities: z12.string().trim().max(3e4)
}).transform((t2) => ({
  locale: t2.locale,
  title: t2.title,
  description: t2.description,
  requirements: t2.requirements,
  responsibilities: t2.responsibilities
}));
var jobInputSchema = z12.object({
  slug: optionalSlugSchema,
  department_id: optionalIntStringSchema,
  location: locationSchema,
  employment_type: employmentTypeSchema2,
  level: levelSchema,
  status: statusSchema,
  salary_min: optionalIntStringSchema,
  salary_max: optionalIntStringSchema,
  salary_currency: optionalCurrencySchema,
  application_deadline: optionalDateSchema,
  translations: z12.array(optionalTranslationSchema).default([])
}).superRefine((value, ctx) => {
  if (value.salary_min !== null && value.salary_max !== null && value.salary_min > value.salary_max) {
    ctx.addIssue({
      code: z12.ZodIssueCode.custom,
      path: ["salary_min"],
      message: "Minimum salary must not exceed maximum salary"
    });
  }
  if (value.status === "Published") {
    if (value.slug === "") {
      ctx.addIssue({
        code: z12.ZodIssueCode.custom,
        path: ["slug"],
        message: "Slug is required to publish a job posting"
      });
    }
    const hasComplete = value.translations.some((t2) => {
      return t2.title.length > 0 && t2.description.length > 0 && t2.requirements.length > 0 && t2.responsibilities.length > 0;
    });
    if (!hasComplete) {
      ctx.addIssue({
        code: z12.ZodIssueCode.custom,
        path: ["translations"],
        message: "At least one complete translation (title, description, requirements, responsibilities) is required to publish"
      });
    }
  }
});
var cloneInputSchema = z12.object({
  slug: slugSchema
}).strict();
function pruneEmptyTranslations(translations) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = translations.length - 1; i >= 0; i--) {
    const t2 = translations[i];
    if (!t2) continue;
    if (seen.has(t2.locale)) continue;
    if (t2.title.length === 0 && t2.description.length === 0 && t2.requirements.length === 0 && t2.responsibilities.length === 0) {
      continue;
    }
    seen.add(t2.locale);
    out.push({
      locale: t2.locale,
      title: t2.title,
      description: t2.description,
      requirements: t2.requirements,
      responsibilities: t2.responsibilities
    });
  }
  return out.reverse();
}
function inputToSavePayload(id, input) {
  return {
    id,
    slug: input.slug,
    department_id: input.department_id,
    location: input.location,
    employment_type: input.employment_type,
    level: input.level,
    status: input.status,
    salary_min: input.salary_min,
    salary_max: input.salary_max,
    salary_currency: input.salary_currency,
    application_deadline: input.application_deadline,
    published_at: input.status === "Published" ? /* @__PURE__ */ new Date() : null,
    translations: pruneEmptyTranslations(input.translations)
  };
}
async function createJob(rawInput, actorUserId) {
  const input = jobInputSchema.parse({
    ...rawInput ?? {},
    status: "Draft"
  });
  const payload = inputToSavePayload(null, input);
  return save({ ...payload, skillLabels: [] }, actorUserId);
}
async function updateJob(id, rawInput, actorUserId, scope) {
  const existing = await findById(id, scope);
  if (existing === null) throw new JobNotFoundError(id);
  const input = jobInputSchema.parse({
    ...rawInput ?? {},
    status: existing.status
  });
  const payload = inputToSavePayload(id, input);
  return save({ ...payload, skillLabels: [] }, actorUserId);
}
async function publishJob(id, actorUserId, scope) {
  const existing = await findById(id, scope);
  if (existing === null) throw new JobNotFoundError(id);
  assertTransition(existing.status, "Published");
  const translations = JOB_LOCALES.map((locale) => {
    const tr = existing.translations[locale];
    return {
      locale,
      title: tr?.title ?? "",
      description: tr?.description ?? "",
      requirements: tr?.requirements ?? "",
      responsibilities: tr?.responsibilities ?? ""
    };
  });
  jobInputSchema.parse({
    slug: existing.slug,
    department_id: existing.department_id,
    location: existing.location,
    employment_type: existing.employment_type,
    level: existing.level,
    status: "Published",
    salary_min: existing.salary_min ?? "",
    salary_max: existing.salary_max ?? "",
    salary_currency: existing.salary_currency ?? "",
    application_deadline: existing.application_deadline ?? "",
    translations
  });
  const updated = await publish(id, actorUserId, scope);
  logger.info(
    { event: "job_publish", actor_user_id: actorUserId, job_id: id },
    "jobs.service: published job"
  );
  const fresh = await findById(id, scope);
  if (fresh === null) throw new JobNotFoundError(id);
  return fresh;
}
async function closeJob(id, actorUserId, scope) {
  await softClose(id, actorUserId, scope);
  const fresh = await findById(id, scope);
  if (fresh === null) throw new JobNotFoundError(id);
  logger.info(
    { event: "job_close", actor_user_id: actorUserId, job_id: id },
    "jobs.service: closed job"
  );
  return fresh;
}
async function archiveJob(id, actorUserId, scope) {
  await archive(id, actorUserId, scope);
  const fresh = await findById(id, scope);
  if (fresh === null) throw new JobNotFoundError(id);
  logger.info(
    { event: "job_archive", actor_user_id: actorUserId, job_id: id },
    "jobs.service: archived job"
  );
  return fresh;
}
async function cloneJob(id, rawInput, actorUserId, scope) {
  const input = cloneInputSchema.parse(rawInput);
  const cloned = await clone(id, actorUserId, input.slug, scope);
  logger.info(
    {
      event: "job_clone",
      actor_user_id: actorUserId,
      source_job_id: id,
      new_job_id: cloned.id
    },
    "jobs.service: cloned job"
  );
  return cloned;
}

// src/modules/applications/kanban-repo.ts
var KANBAN_STAGES = [
  "Applied",
  "Screening",
  "Interview",
  "Offer",
  "Hired",
  "Rejected"
];
var KANBAN_STAGE_LABELS = {
  Applied: "Applied",
  Screening: "Screening",
  Interview: "Interview",
  Offer: "Offer",
  Hired: "Hired",
  Rejected: "Rejected"
};
var STAGE_PLACEHOLDERS = KANBAN_STAGES.map(() => "?").join(", ");
var SELECT_KANBAN_SQL = [
  "SELECT",
  "  a.id              AS id,",
  "  a.uuid            AS uuid,",
  "  a.reference_no    AS reference_no,",
  "  a.applicant_user_id AS applicant_user_id,",
  "  a.stage           AS stage,",
  "  a.applied_at      AS applied_at,",
  "  ap.full_name      AS applicant_name,",
  "  u.email           AS applicant_email",
  "FROM applications a",
  "LEFT JOIN applicants ap ON ap.user_id = a.applicant_user_id",
  "LEFT JOIN users      u  ON u.id       = a.applicant_user_id",
  "WHERE a.job_id = ?",
  "  AND a.stage IN (" + STAGE_PLACEHOLDERS + ")",
  "ORDER BY a.stage ASC, a.applied_at DESC, a.id DESC"
].join(" ");
function buildSelectKanbanScopedSql(deptCount) {
  return [
    "SELECT",
    "  a.id              AS id,",
    "  a.uuid            AS uuid,",
    "  a.reference_no    AS reference_no,",
    "  a.applicant_user_id AS applicant_user_id,",
    "  a.stage           AS stage,",
    "  a.applied_at      AS applied_at,",
    "  ap.full_name      AS applicant_name,",
    "  u.email           AS applicant_email",
    "FROM applications a",
    "INNER JOIN job_postings jp ON jp.id = a.job_id",
    "LEFT JOIN applicants ap ON ap.user_id = a.applicant_user_id",
    "LEFT JOIN users      u  ON u.id       = a.applicant_user_id",
    "WHERE a.job_id = ?",
    "  AND a.stage IN (" + STAGE_PLACEHOLDERS + ")",
    "  AND jp.department_id IN (" + KANBAN_DEPT_PLACEHOLDERS(deptCount) + ")",
    "ORDER BY a.stage ASC, a.applied_at DESC, a.id DESC"
  ].join(" ");
}
function KANBAN_DEPT_PLACEHOLDERS(n) {
  if (n <= 0) return "";
  return Array.from({ length: n }, () => "?").join(", ");
}
function toDate4(raw) {
  if (raw instanceof Date) return raw;
  if (typeof raw === "string") return new Date(raw);
  return /* @__PURE__ */ new Date(0);
}
function resolveDisplayName(row) {
  const name = row.applicant_name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name;
  }
  const email = row.applicant_email;
  if (typeof email === "string" && email.length > 0) {
    return email;
  }
  return `Applicant #${Number(row.applicant_user_id)}`;
}
async function listForKanban(jobId, scope) {
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return KANBAN_STAGES.map((stage) => ({ stage, rows: [] }));
  }
  let rows;
  if (scope?.departments !== void 0) {
    const depts = scope.departments;
    if (depts.length === 0) {
      return KANBAN_STAGES.map((stage) => ({ stage, rows: [] }));
    }
    rows = await query(buildSelectKanbanScopedSql(depts.length), [
      jobId,
      ...KANBAN_STAGES,
      ...depts
    ]);
  } else {
    rows = await query(SELECT_KANBAN_SQL, [
      jobId,
      ...KANBAN_STAGES
    ]);
  }
  const buckets = /* @__PURE__ */ new Map();
  for (const stage of KANBAN_STAGES) buckets.set(stage, []);
  for (const row of rows) {
    const bucket = buckets.get(row.stage);
    if (!bucket) continue;
    bucket.push({
      id: Number(row.id),
      uuid: String(row.uuid),
      reference_no: String(row.reference_no),
      applicant_user_id: Number(row.applicant_user_id),
      applicant_name: resolveDisplayName(row),
      stage: row.stage,
      applied_at: toDate4(row.applied_at)
    });
  }
  return KANBAN_STAGES.map((stage) => ({
    stage,
    rows: buckets.get(stage) ?? []
  }));
}
var SELECT_KANBAN_CARD_BY_ID_SQL = [
  "SELECT",
  "  a.id              AS id,",
  "  a.uuid            AS uuid,",
  "  a.reference_no    AS reference_no,",
  "  a.applicant_user_id AS applicant_user_id,",
  "  a.stage           AS stage,",
  "  a.applied_at      AS applied_at,",
  "  ap.full_name      AS applicant_name,",
  "  u.email           AS applicant_email",
  "FROM applications a",
  "LEFT JOIN applicants ap ON ap.user_id = a.applicant_user_id",
  "LEFT JOIN users      u  ON u.id       = a.applicant_user_id",
  "WHERE a.id = ?",
  "LIMIT 1"
].join(" ");
async function findKanbanCard(applicationId) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  const rows = await query(SELECT_KANBAN_CARD_BY_ID_SQL, [
    applicationId
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    uuid: String(row.uuid),
    reference_no: String(row.reference_no),
    applicant_user_id: Number(row.applicant_user_id),
    applicant_name: resolveDisplayName(row),
    stage: row.stage,
    applied_at: toDate4(row.applied_at)
  };
}

// src/modules/applications/interviews-service.ts
import { z as z13, ZodError as ZodError4 } from "zod";

// src/modules/applications/interviews-repo.ts
function toDate5(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}
function toNumberOrNull2(value) {
  if (value === null || value === void 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function rowToInterview(row) {
  return {
    id: Number(row.id),
    application_id: Number(row.application_id),
    scheduled_at: toDate5(row.scheduled_at),
    location: row.location,
    meeting_url: row.meeting_url,
    interviewer_user_id: toNumberOrNull2(row.interviewer_user_id),
    status: row.status
  };
}
var INTERVIEW_COLUMNS = "id, application_id, scheduled_at, location, meeting_url, interviewer_user_id, status";
var INSERT_INTERVIEW_SQL = [
  "INSERT INTO application_interviews",
  "(application_id, scheduled_at, location, meeting_url, interviewer_user_id)",
  "VALUES (?, ?, ?, ?, ?)"
].join(" ");
var SELECT_INTERVIEW_BY_ID_SQL = [
  "SELECT",
  INTERVIEW_COLUMNS,
  "FROM application_interviews WHERE id = ? LIMIT 1"
].join(" ");
var SELECT_INTERVIEWS_FOR_APP_SQL = [
  "SELECT",
  INTERVIEW_COLUMNS,
  "FROM application_interviews",
  "WHERE application_id = ?",
  "ORDER BY scheduled_at DESC, id DESC"
].join(" ");
async function scheduleInterview(input) {
  if (!Number.isInteger(input.applicationId) || input.applicationId <= 0) {
    throw new TypeError("applicationId must be a positive integer");
  }
  if (!(input.scheduledAt instanceof Date) || Number.isNaN(input.scheduledAt.getTime())) {
    throw new TypeError("scheduledAt must be a valid Date");
  }
  const result = await query(INSERT_INTERVIEW_SQL, [
    input.applicationId,
    input.scheduledAt,
    input.location ?? null,
    input.meetingUrl ?? null,
    input.interviewerUserId ?? null
  ]);
  const newId = Number(result.insertId);
  const persisted = await findById2(newId);
  if (persisted === null) {
    return {
      id: newId,
      application_id: input.applicationId,
      scheduled_at: input.scheduledAt,
      location: input.location ?? null,
      meeting_url: input.meetingUrl ?? null,
      interviewer_user_id: input.interviewerUserId ?? null,
      status: "scheduled"
    };
  }
  return persisted;
}
async function findById2(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await query(SELECT_INTERVIEW_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) return null;
  return rowToInterview(row);
}

// src/modules/applications/interviews-service.ts
var LOCATION_MAX_LEN2 = 500;
var MEETING_URL_MAX_LEN = 2e3;
var InvalidInterviewInputError = class extends Error {
  constructor(fieldErrors, message = "Invalid interview input") {
    super(message);
    this.fieldErrors = fieldErrors;
    this.name = "InvalidInterviewInputError";
  }
  code = "invalid_interview_input";
  statusCode = 422;
};
var ApplicationNotFoundError2 = class extends Error {
  constructor(applicationId) {
    super(`Application ${applicationId} not found`);
    this.applicationId = applicationId;
    this.name = "ApplicationNotFoundError";
  }
  code = "application_not_found";
  statusCode = 404;
};
function preprocessDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return void 0;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed;
  }
  return value;
}
function preprocessOptionalString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? void 0 : trimmed;
  }
  return value;
}
function preprocessOptionalInt(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return void 0;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}
function buildScheduleInterviewSchema(now = /* @__PURE__ */ new Date()) {
  const nowMs = now.getTime();
  return z13.object({
    scheduledAt: z13.preprocess(
      preprocessDate,
      z13.date({
        invalid_type_error: "scheduledAt must be a valid datetime",
        required_error: "scheduledAt is required"
      }).refine((d) => d.getTime() > nowMs, {
        message: "scheduledAt must be in the future"
      })
    ),
    location: z13.preprocess(
      preprocessOptionalString,
      z13.string().max(
        LOCATION_MAX_LEN2,
        `location must be at most ${LOCATION_MAX_LEN2} characters`
      ).optional()
    ),
    meetingUrl: z13.preprocess(
      preprocessOptionalString,
      z13.string().max(
        MEETING_URL_MAX_LEN,
        `meetingUrl must be at most ${MEETING_URL_MAX_LEN} characters`
      ).url("meetingUrl must be a valid URL").refine(
        (raw) => {
          try {
            const u = new URL(raw);
            return u.protocol === "http:" || u.protocol === "https:";
          } catch {
            return false;
          }
        },
        { message: "meetingUrl must use http or https" }
      ).optional()
    ),
    interviewerUserId: z13.preprocess(
      preprocessOptionalInt,
      z13.number().int("interviewerUserId must be an integer").positive("interviewerUserId must be a positive integer").optional()
    )
  }).refine(
    (val) => val.location !== void 0 && val.location.length > 0 || val.meetingUrl !== void 0 && val.meetingUrl.length > 0,
    {
      // Mapped to the `_form` field by the route's error renderer.
      message: "At least one of location or meetingUrl must be provided",
      path: ["location"]
    }
  );
}
var scheduleInterviewSchema = buildScheduleInterviewSchema();
var SELECT_APPLICATION_FOR_INTERVIEW_SQL = [
  "SELECT id, job_id, applicant_user_id, reference_no",
  "FROM applications WHERE id = ? LIMIT 1"
].join(" ");
async function loadApplication(applicationId) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  const rows = await query(
    SELECT_APPLICATION_FOR_INTERVIEW_SQL,
    [applicationId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    applicantUserId: Number(row.applicant_user_id),
    referenceNo: row.reference_no
  };
}
async function scheduleInterviewForApplication(opts) {
  const { applicationId, actorUserId, scope, input } = opts;
  const now = opts.now ?? /* @__PURE__ */ new Date();
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError2(applicationId);
  }
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError("actorUserId must be a positive integer");
  }
  const app = await loadApplication(applicationId);
  if (app === null) {
    throw new ApplicationNotFoundError2(applicationId);
  }
  const job = await findById(app.jobId, scope);
  if (job === null) {
    throw new ApplicationNotFoundError2(applicationId);
  }
  const schema = buildScheduleInterviewSchema(now);
  let parsed;
  try {
    parsed = schema.parse(input);
  } catch (err) {
    if (err instanceof ZodError4) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidInterviewInputError(fieldErrors);
    }
    throw err;
  }
  const interview = await scheduleInterview({
    applicationId: app.id,
    scheduledAt: parsed.scheduledAt,
    location: parsed.location ?? null,
    meetingUrl: parsed.meetingUrl ?? null,
    interviewerUserId: parsed.interviewerUserId ?? null
  });
  logger.info(
    {
      event: "interview_scheduled",
      actor_user_id: actorUserId,
      application_id: app.id,
      interview_id: interview.id,
      scheduled_at: interview.scheduled_at.toISOString(),
      interviewer_user_id: interview.interviewer_user_id,
      reference_no: app.referenceNo
    },
    "application interview scheduled"
  );
  try {
    await safeEnqueueInterviewInvitation({
      applicationId: app.id,
      applicantUserId: app.applicantUserId,
      interviewId: interview.id,
      scheduledAt: interview.scheduled_at,
      location: interview.location,
      meetingUrl: interview.meeting_url,
      referenceNo: app.referenceNo
    });
  } catch (err) {
    logger.error(
      {
        err,
        event: "interview_mail_enqueue_failed",
        application_id: app.id,
        interview_id: interview.id
      },
      "failed to enqueue interview invitation; row already committed"
    );
  }
  return { interview, applicationId: app.id };
}
async function safeEnqueueInterviewInvitation(ctx) {
  const dedicated = void 0;
  if (typeof dedicated === "function") {
    await dedicated(ctx);
    return;
  }
  logger.info(
    {
      template_key: "interview-invitation",
      target_application_id: ctx.applicationId,
      applicant_user_id: ctx.applicantUserId,
      interview_id: ctx.interviewId,
      scheduled_at: ctx.scheduledAt.toISOString(),
      has_location: ctx.location !== null,
      has_meeting_url: ctx.meetingUrl !== null,
      reference_no: ctx.referenceNo,
      stub: true
    },
    "mail.enqueueInterviewInvitation (stub \u2014 see task 36.1)"
  );
}

// src/modules/applications/notes-service.ts
import { z as z14, ZodError as ZodError5 } from "zod";

// src/modules/applications/notes-repo.ts
var NOTE_BODY_MAX_LEN = 5e3;
function toDate6(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  return value !== 0;
}
function rowToNote(row) {
  return {
    id: Number(row.id),
    application_id: Number(row.application_id),
    author_user_id: Number(row.author_user_id),
    body: String(row.body ?? ""),
    visible_to_applicant: toBoolean(row.visible_to_applicant),
    created_at: toDate6(row.created_at)
  };
}
var NOTE_COLUMNS = [
  "id",
  "application_id",
  "author_user_id",
  "body",
  "visible_to_applicant",
  "created_at"
].join(", ");
var INSERT_NOTE_SQL = [
  "INSERT INTO application_notes",
  "(application_id, author_user_id, body, visible_to_applicant)",
  "VALUES (?, ?, ?, ?)"
].join(" ");
var SELECT_NOTE_BY_ID_SQL = [
  "SELECT",
  NOTE_COLUMNS,
  "FROM application_notes WHERE id = ? LIMIT 1"
].join(" ");
var SELECT_NOTES_FOR_APP_SQL = [
  "SELECT",
  NOTE_COLUMNS,
  "FROM application_notes",
  "WHERE application_id = ?",
  "ORDER BY created_at DESC, id DESC"
].join(" ");
async function insertNote(input) {
  if (!Number.isInteger(input.applicationId) || input.applicationId <= 0) {
    throw new TypeError("applicationId must be a positive integer");
  }
  if (!Number.isInteger(input.authorUserId) || input.authorUserId <= 0) {
    throw new TypeError("authorUserId must be a positive integer");
  }
  const result = await query(INSERT_NOTE_SQL, [
    input.applicationId,
    input.authorUserId,
    input.body,
    input.visibleToApplicant ? 1 : 0
  ]);
  const newId = Number(result.insertId);
  const persisted = await findById3(newId);
  if (persisted === null) {
    return {
      id: newId,
      application_id: input.applicationId,
      author_user_id: input.authorUserId,
      body: input.body,
      visible_to_applicant: input.visibleToApplicant,
      created_at: /* @__PURE__ */ new Date()
    };
  }
  return persisted;
}
async function findById3(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await query(SELECT_NOTE_BY_ID_SQL, [id]);
  const row = rows[0];
  if (!row) return null;
  return rowToNote(row);
}
async function listForApplication(applicationId) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return [];
  const rows = await query(SELECT_NOTES_FOR_APP_SQL, [
    applicationId
  ]);
  return rows.map(rowToNote);
}

// src/modules/applications/notes-service.ts
var InvalidNoteInputError = class extends Error {
  constructor(fieldErrors, message = "Invalid note input") {
    super(message);
    this.fieldErrors = fieldErrors;
    this.name = "InvalidNoteInputError";
  }
  code = "invalid_note_input";
  statusCode = 422;
};
function preprocessFormBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "on" || normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}
function preprocessBody(value) {
  if (typeof value === "string") return value.trim();
  return value;
}
var addNoteSchema = z14.object({
  body: z14.preprocess(
    preprocessBody,
    z14.string({
      invalid_type_error: "body must be a string",
      required_error: "body is required"
    }).min(1, "body must not be empty").max(
      NOTE_BODY_MAX_LEN,
      `body must be at most ${NOTE_BODY_MAX_LEN} characters`
    )
  ),
  visibleToApplicant: z14.preprocess(preprocessFormBoolean, z14.boolean())
});
var SELECT_APPLICATION_FOR_NOTE_SQL = [
  "SELECT id, job_id",
  "FROM applications WHERE id = ? LIMIT 1"
].join(" ");
async function loadApplication2(applicationId) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  const rows = await query(
    SELECT_APPLICATION_FOR_NOTE_SQL,
    [applicationId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    jobId: Number(row.job_id)
  };
}
async function resolveInScopeApplication(applicationId, scope) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError(applicationId);
  }
  const app = await loadApplication2(applicationId);
  if (app === null) {
    throw new ApplicationNotFoundError(applicationId);
  }
  const job = await findById(app.jobId, scope);
  if (job === null) {
    throw new ApplicationNotFoundError(applicationId);
  }
  return app;
}
async function addNote(opts) {
  const { applicationId, authorUserId, scope, input } = opts;
  if (!Number.isInteger(authorUserId) || authorUserId <= 0) {
    throw new TypeError("authorUserId must be a positive integer");
  }
  const app = await resolveInScopeApplication(applicationId, scope);
  let parsed;
  try {
    parsed = addNoteSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError5) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidNoteInputError(fieldErrors);
    }
    throw err;
  }
  const note = await insertNote({
    applicationId: app.id,
    authorUserId,
    body: parsed.body,
    visibleToApplicant: parsed.visibleToApplicant
  });
  if (note.visible_to_applicant) {
    try {
      await safeEnqueueNoteNotification({
        applicationId: app.id,
        noteId: note.id,
        body: note.body
      });
    } catch (err) {
      logger.error(
        {
          err,
          event: "application_note_mail_enqueue_failed",
          application_id: app.id,
          note_id: note.id
        },
        "failed to enqueue note notification; row already committed"
      );
    }
  }
  logger.info(
    {
      event: "application_note_added",
      actor_user_id: authorUserId,
      application_id: app.id,
      note_id: note.id,
      visible_to_applicant: note.visible_to_applicant
    },
    "application note added"
  );
  return note;
}
async function listNotes(opts) {
  const { applicationId, scope } = opts;
  const app = await resolveInScopeApplication(applicationId, scope);
  return listForApplication(app.id);
}
async function safeEnqueueNoteNotification(ctx) {
  const dedicated = void 0;
  if (typeof dedicated === "function") {
    await dedicated(ctx);
    return;
  }
  logger.info(
    {
      template_key: "note-notification",
      target_application_id: ctx.applicationId,
      note_id: ctx.noteId,
      body_length: ctx.body.length,
      stub: true
    },
    "mail.enqueueNoteNotification (stub \u2014 see task 36.1)"
  );
}

// src/modules/applications/email-service.ts
import nunjucks2 from "nunjucks";
import { z as z15, ZodError as ZodError6 } from "zod";
var TEMPLATE_KEY_MAX_LEN = 80;
var EMAIL_LOCALES = JOB_LOCALES;
var InvalidEmailInputError = class extends Error {
  constructor(fieldErrors, message = "Invalid email input") {
    super(message);
    this.fieldErrors = fieldErrors;
    this.name = "InvalidEmailInputError";
  }
  code = "invalid_email_input";
  statusCode = 422;
};
var MailTemplateNotFoundError = class extends Error {
  constructor(templateKey, locale) {
    super(`Mail template "${templateKey}" (${locale}) not found`);
    this.templateKey = templateKey;
    this.locale = locale;
    this.name = "MailTemplateNotFoundError";
  }
  code = "unknown_template";
  statusCode = 422;
};
function preprocessTemplateKey(value) {
  if (typeof value === "string") return value.trim();
  return value;
}
var sendTemplatedEmailSchema = z15.object({
  templateKey: z15.preprocess(
    preprocessTemplateKey,
    z15.string({
      invalid_type_error: "templateKey must be a string",
      required_error: "templateKey is required"
    }).min(1, "templateKey must not be empty").max(
      TEMPLATE_KEY_MAX_LEN,
      `templateKey must be at most ${TEMPLATE_KEY_MAX_LEN} characters`
    )
  ),
  locale: z15.preprocess(
    (value) => {
      if (value === void 0 || value === null || value === "") return "id";
      if (typeof value === "string") return value.trim().toLowerCase();
      return value;
    },
    z15.enum(EMAIL_LOCALES, {
      invalid_type_error: "locale must be one of id, en"
    })
  )
});
var SELECT_APPLICATION_CONTEXT_SQL = [
  "SELECT",
  "  a.id AS application_id,",
  "  a.job_id AS job_id,",
  "  a.stage AS stage,",
  "  ap.full_name AS applicant_name,",
  "  u.email AS to_email,",
  "  jt.title AS title_requested",
  "FROM applications a",
  "JOIN applicants ap ON ap.user_id = a.applicant_user_id",
  "JOIN users u ON u.id = a.applicant_user_id",
  "LEFT JOIN job_posting_translations jt",
  "  ON jt.job_id = a.job_id AND jt.locale = ?",
  "WHERE a.id = ? LIMIT 1"
].join(" ");
var SELECT_ALL_TITLES_SQL = [
  "SELECT locale, title",
  "FROM job_posting_translations",
  "WHERE job_id = ?"
].join(" ");
async function loadApplicationContext(applicationId, locale) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  const rows = await query(
    SELECT_APPLICATION_CONTEXT_SQL,
    [locale, applicationId]
  );
  const row = rows[0];
  if (!row) return null;
  let jobTitle = (row.title_requested ?? "").trim();
  if (jobTitle === "") {
    const titleRows = await query(SELECT_ALL_TITLES_SQL, [
      Number(row.job_id)
    ]);
    for (const tr of titleRows) {
      const candidate = (tr.title ?? "").trim();
      if (candidate !== "") {
        jobTitle = candidate;
        break;
      }
    }
  }
  return {
    applicationId: Number(row.application_id),
    jobId: Number(row.job_id),
    stage: row.stage,
    applicantName: row.applicant_name,
    toEmail: row.to_email,
    jobTitle
  };
}
async function resolveInScopeApplicationContext(applicationId, locale, scope) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError(applicationId);
  }
  const ctx = await loadApplicationContext(applicationId, locale);
  if (ctx === null) {
    throw new ApplicationNotFoundError(applicationId);
  }
  const job = await findById(ctx.jobId, scope);
  if (job === null) {
    throw new ApplicationNotFoundError(applicationId);
  }
  return ctx;
}
var SELECT_MAIL_TEMPLATE_SQL2 = [
  "SELECT subject, body_html, body_text",
  "FROM mail_templates",
  "WHERE `key` = ? AND locale = ? LIMIT 1"
].join(" ");
async function loadMailTemplate(templateKey, locale) {
  const rows = await query(SELECT_MAIL_TEMPLATE_SQL2, [
    templateKey,
    locale
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text
  };
}
async function sendTemplatedEmail(opts) {
  const { applicationId, actorUserId, scope, input } = opts;
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError("actorUserId must be a positive integer");
  }
  let parsed;
  try {
    parsed = sendTemplatedEmailSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError6) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidEmailInputError(fieldErrors);
    }
    throw err;
  }
  const locale = parsed.locale;
  const ctx = await resolveInScopeApplicationContext(
    applicationId,
    locale,
    scope
  );
  const template = await loadMailTemplate(parsed.templateKey, locale);
  if (template === null) {
    throw new MailTemplateNotFoundError(parsed.templateKey, locale);
  }
  const renderContext = {
    applicant_name: ctx.applicantName,
    job_title: ctx.jobTitle,
    stage: ctx.stage
  };
  const renderedSubject = nunjucks2.renderString(template.subject, renderContext);
  const renderedBodyHtml = nunjucks2.renderString(
    template.bodyHtml,
    renderContext
  );
  const renderedBodyText = template.bodyText !== null ? nunjucks2.renderString(template.bodyText, renderContext) : null;
  logger.debug(
    {
      event: "application_email_preview_rendered",
      application_id: ctx.applicationId,
      template_key: parsed.templateKey,
      subject_length: renderedSubject.length,
      body_html_length: renderedBodyHtml.length,
      body_text_length: renderedBodyText === null ? 0 : renderedBodyText.length
    },
    "templated email preview render ok"
  );
  await withTransaction(
    (conn) => enqueue(conn, {
      templateKey: parsed.templateKey,
      toEmail: ctx.toEmail,
      toName: ctx.applicantName,
      locale,
      context: renderContext,
      targetId: String(ctx.applicationId)
    })
  );
  logger.info(
    {
      event: "application_email_sent",
      actor_user_id: actorUserId,
      application_id: ctx.applicationId,
      template_key: parsed.templateKey
    },
    "application templated email sent"
  );
  return { templateKey: parsed.templateKey, toEmail: ctx.toEmail };
}

// src/modules/applications/stage-machine.ts
var PIPELINE_STAGES = [
  "Applied",
  "Screening",
  "Interview",
  "Offer",
  "Hired",
  "Rejected",
  "Withdrawn"
];
function isPipelineStage(value) {
  return typeof value === "string" && PIPELINE_STAGES.includes(value);
}
var ALLOWED_STAGE_TRANSITIONS = Object.freeze({
  Applied: /* @__PURE__ */ new Set(["Screening", "Rejected"]),
  Screening: /* @__PURE__ */ new Set(["Interview", "Rejected"]),
  Interview: /* @__PURE__ */ new Set(["Offer", "Rejected"]),
  Offer: /* @__PURE__ */ new Set(["Hired", "Rejected"]),
  Hired: /* @__PURE__ */ new Set(),
  Rejected: /* @__PURE__ */ new Set(),
  Withdrawn: /* @__PURE__ */ new Set()
});
function canTransitionStage(from, to) {
  if (from === to) return false;
  return ALLOWED_STAGE_TRANSITIONS[from].has(to);
}
var InvalidStageTransitionError = class extends Error {
  constructor(from, to) {
    super(`Invalid application stage transition: ${from} \u2192 ${to}`);
    this.from = from;
    this.to = to;
    this.name = "InvalidStageTransitionError";
  }
  code = "invalid_stage_transition";
  /** HTTP status code the route layer surfaces for this error (Req 10.2). */
  statusCode = 422;
};
function assertStageTransition(from, to) {
  if (!canTransitionStage(from, to)) {
    throw new InvalidStageTransitionError(from, to);
  }
}

// src/modules/applications/stage-service.ts
var SELECT_APPLICATION_FOR_UPDATE_SQL = [
  "SELECT id, job_id, applicant_user_id, reference_no, stage",
  "FROM applications WHERE id = ? FOR UPDATE"
].join(" ");
var UPDATE_STAGE_HIRED_SQL = "UPDATE applications SET stage = ?, hired_at = NOW() WHERE id = ?";
var UPDATE_STAGE_SQL = "UPDATE applications SET stage = ? WHERE id = ?";
var INSERT_STAGE_HISTORY_SQL2 = "INSERT INTO application_stage_history   (application_id, prev_stage, new_stage, changed_by) VALUES (?, ?, ?, ?)";
function rowToLockedApplication(row) {
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    applicantUserId: Number(row.applicant_user_id),
    referenceNo: String(row.reference_no),
    stage: row.stage
  };
}
async function safeEnqueueStageChange(ctx) {
  const dedicated = void 0;
  if (typeof dedicated === "function") {
    await dedicated(ctx);
    return;
  }
  logger.info(
    {
      template_key: "application-stage-change",
      target_application_id: ctx.applicationId,
      applicant_user_id: ctx.applicantUserId,
      job_id: ctx.jobId,
      prev_stage: ctx.prevStage,
      new_stage: ctx.newStage,
      reference_no: ctx.referenceNo,
      stub: true
    },
    "mail.enqueueStageChange (stub \u2014 see task 36.1)"
  );
}
async function changeStage(opts) {
  const { applicationId, newStage, actorUserId, scope } = opts;
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new ApplicationNotFoundError(applicationId);
  }
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError("changeStage: actorUserId must be a positive integer");
  }
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      SELECT_APPLICATION_FOR_UPDATE_SQL,
      [applicationId]
    );
    const row = rows[0];
    if (row === void 0) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const application = rowToLockedApplication(row);
    if (scope !== void 0) {
      const job = await findById(application.jobId, scope);
      if (job === null) {
        throw new ApplicationNotFoundError(applicationId);
      }
    }
    const prevStage = application.stage;
    assertStageTransition(prevStage, newStage);
    if (newStage === "Hired") {
      await conn.execute(UPDATE_STAGE_HIRED_SQL, [
        newStage,
        applicationId
      ]);
    } else {
      await conn.execute(UPDATE_STAGE_SQL, [
        newStage,
        applicationId
      ]);
    }
    await conn.execute(INSERT_STAGE_HISTORY_SQL2, [
      applicationId,
      prevStage,
      newStage,
      actorUserId
    ]);
    await auditService.write(
      {
        actorUserId,
        actionType: "application_stage_change",
        targetEntity: "application",
        targetId: applicationId,
        details: {
          prev_stage: prevStage,
          new_stage: newStage,
          job_id: application.jobId,
          reference_no: application.referenceNo,
          reason: opts.reason ?? null
        }
      },
      conn
    );
    logger.info(
      {
        event: "application_stage_change",
        actor_user_id: actorUserId,
        application_id: applicationId,
        job_id: application.jobId,
        prev_stage: prevStage,
        new_stage: newStage,
        reference_no: application.referenceNo,
        reason: opts.reason ?? null
      },
      "application stage changed"
    );
    try {
      await safeEnqueueStageChange({
        applicationId,
        applicantUserId: application.applicantUserId,
        jobId: application.jobId,
        prevStage,
        newStage,
        referenceNo: application.referenceNo
      });
    } catch (err) {
      logger.error(
        {
          err,
          event: "application_stage_change_mail_enqueue_failed",
          application_id: applicationId,
          new_stage: newStage
        },
        "failed to enqueue stage-change email; stage change still applied"
      );
    }
    return { applicationId, prevStage, newStage };
  });
}
var BULK_STAGE_MAX_BATCH = 100;
var BulkStageBatchTooLargeError = class extends Error {
  constructor(count, max = BULK_STAGE_MAX_BATCH) {
    super(
      `bulk stage batch of ${count} exceeds the maximum of ${max}`
    );
    this.count = count;
    this.max = max;
    this.name = "BulkStageBatchTooLargeError";
  }
  code = "batch_too_large";
  /** HTTP status code the route layer surfaces for this error. */
  statusCode = 422;
};
async function bulkChangeStage(opts) {
  const { applicationIds, newStage, actorUserId, scope } = opts;
  const reason = opts.reason ?? null;
  const uniqueIds = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of applicationIds) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }
  if (uniqueIds.length > BULK_STAGE_MAX_BATCH) {
    throw new BulkStageBatchTooLargeError(uniqueIds.length);
  }
  const results = [];
  for (const applicationId of uniqueIds) {
    try {
      const { prevStage } = await changeStage({
        applicationId,
        newStage,
        actorUserId,
        scope,
        reason
      });
      results.push({ applicationId, ok: true, prevStage, newStage });
    } catch (err) {
      if (err instanceof InvalidStageTransitionError) {
        results.push({ applicationId, ok: false, error: "invalid_transition" });
      } else if (err instanceof ApplicationNotFoundError) {
        results.push({ applicationId, ok: false, error: "not_found" });
      } else {
        logger.error(
          {
            err,
            event: "application_bulk_stage_item_failed",
            application_id: applicationId,
            new_stage: newStage
          },
          "bulk stage transition: per-application failure (batch continues)"
        );
        results.push({ applicationId, ok: false, error: "internal_error" });
      }
    }
  }
  return { results };
}

// src/modules/mail/templates-service.ts
import { z as z16, ZodError as ZodError7 } from "zod";

// src/modules/mail/templates-repo.ts
function toDate7(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}
function rowToRecord4(row) {
  return {
    key: String(row.key),
    locale: String(row.locale),
    subject: String(row.subject ?? ""),
    body_html: String(row.body_html ?? ""),
    body_text: row.body_text === null ? null : String(row.body_text),
    updated_at: toDate7(row.updated_at)
  };
}
var TEMPLATE_COLUMNS = [
  "`key`",
  "locale",
  "subject",
  "body_html",
  "body_text",
  "updated_at"
].join(", ");
var SELECT_ALL_TEMPLATES_SQL = [
  "SELECT",
  TEMPLATE_COLUMNS,
  "FROM mail_templates",
  "ORDER BY `key` ASC, locale ASC"
].join(" ");
var SELECT_TEMPLATE_SQL = [
  "SELECT",
  TEMPLATE_COLUMNS,
  "FROM mail_templates",
  "WHERE `key` = ? AND locale = ? LIMIT 1"
].join(" ");
var UPSERT_TEMPLATE_SQL = [
  "INSERT INTO mail_templates",
  "(`key`, locale, subject, body_html, body_text)",
  "VALUES (?, ?, ?, ?, ?)",
  "ON DUPLICATE KEY UPDATE",
  "subject = ?, body_html = ?, body_text = ?"
].join(" ");
var DELETE_TEMPLATE_SQL = [
  "DELETE FROM mail_templates",
  "WHERE `key` = ? AND locale = ?"
].join(" ");
async function listTemplates() {
  const rows = await query(SELECT_ALL_TEMPLATES_SQL, []);
  return rows.map(rowToRecord4);
}
async function findTemplate(key, locale) {
  const rows = await query(SELECT_TEMPLATE_SQL, [
    key,
    locale
  ]);
  const row = rows[0];
  if (!row) return null;
  return rowToRecord4(row);
}
async function upsertTemplate(input) {
  await query(UPSERT_TEMPLATE_SQL, [
    // INSERT tuple
    input.key,
    input.locale,
    input.subject,
    input.bodyHtml,
    input.bodyText,
    // ON DUPLICATE KEY UPDATE assignments
    input.subject,
    input.bodyHtml,
    input.bodyText
  ]);
  const persisted = await findTemplate(input.key, input.locale);
  if (persisted === null) {
    return {
      key: input.key,
      locale: input.locale,
      subject: input.subject,
      body_html: input.bodyHtml,
      body_text: input.bodyText,
      updated_at: /* @__PURE__ */ new Date()
    };
  }
  return persisted;
}

// src/modules/mail/templates-service.ts
var TEMPLATE_LOCALES = ["id", "en"];
var TEMPLATE_KEY_MAX_LEN2 = 64;
var TEMPLATE_SUBJECT_MAX_LEN = 255;
var TEMPLATE_BODY_MAX_LEN = 65535;
var InvalidTemplateInputError = class extends Error {
  constructor(fieldErrors, message = "Invalid mail template input") {
    super(message);
    this.fieldErrors = fieldErrors;
    this.name = "InvalidTemplateInputError";
  }
  code = "invalid_template_input";
  statusCode = 422;
};
function preprocessTrim(value) {
  if (typeof value === "string") return value.trim();
  return value;
}
function preprocessBodyText(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return value;
}
var saveTemplateSchema = z16.object({
  key: z16.preprocess(
    preprocessTrim,
    z16.string({
      invalid_type_error: "key must be a string",
      required_error: "key is required"
    }).min(1, "key must not be empty").max(
      TEMPLATE_KEY_MAX_LEN2,
      `key must be at most ${TEMPLATE_KEY_MAX_LEN2} characters`
    ).regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      "key must be lowercase letters, digits, underscores or hyphens"
    )
  ),
  locale: z16.preprocess(
    preprocessTrim,
    z16.enum(TEMPLATE_LOCALES, {
      invalid_type_error: "locale must be one of id, en",
      required_error: "locale is required"
    })
  ),
  subject: z16.preprocess(
    preprocessTrim,
    z16.string({
      invalid_type_error: "subject must be a string",
      required_error: "subject is required"
    }).min(1, "subject must not be empty").max(
      TEMPLATE_SUBJECT_MAX_LEN,
      `subject must be at most ${TEMPLATE_SUBJECT_MAX_LEN} characters`
    )
  ),
  bodyHtml: z16.preprocess(
    preprocessTrim,
    z16.string({
      invalid_type_error: "bodyHtml must be a string",
      required_error: "bodyHtml is required"
    }).min(1, "bodyHtml must not be empty").max(
      TEMPLATE_BODY_MAX_LEN,
      `bodyHtml must be at most ${TEMPLATE_BODY_MAX_LEN} characters`
    )
  ),
  bodyText: z16.preprocess(
    preprocessBodyText,
    z16.string().max(
      TEMPLATE_BODY_MAX_LEN,
      `bodyText must be at most ${TEMPLATE_BODY_MAX_LEN} characters`
    ).nullable()
  )
});
async function saveTemplate(opts) {
  const { actorUserId, input } = opts;
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError("actorUserId must be a positive integer");
  }
  let parsed;
  try {
    parsed = saveTemplateSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError7) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidTemplateInputError(fieldErrors);
    }
    throw err;
  }
  const record = await upsertTemplate({
    key: parsed.key,
    locale: parsed.locale,
    subject: parsed.subject,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText
  });
  logger.info(
    {
      event: "mail_template_change",
      actor_user_id: actorUserId,
      template_key: record.key,
      locale: record.locale
    },
    "mail template changed"
  );
  return record;
}
async function listAll() {
  return listTemplates();
}
async function getOne(key, locale) {
  return findTemplate(key, locale);
}

// src/modules/audit/queries.ts
var AUDIT_LIST_DEFAULT_PAGE_SIZE = 50;
var AUDIT_LIST_MAX_PAGE_SIZE = 200;
function toDate8(raw) {
  if (raw instanceof Date) return raw;
  if (typeof raw === "string") return new Date(raw);
  return /* @__PURE__ */ new Date(0);
}
function toNumberOrNull3(raw) {
  if (raw === null || raw === void 0) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function toDetails(raw) {
  if (raw === null || raw === void 0) return null;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return null;
}
function clampPage2(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n < 0 ? 0 : n;
}
function clampPageSize2(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return AUDIT_LIST_DEFAULT_PAGE_SIZE;
  }
  const n = Math.floor(value);
  if (n < 1) return AUDIT_LIST_DEFAULT_PAGE_SIZE;
  if (n > AUDIT_LIST_MAX_PAGE_SIZE) return AUDIT_LIST_MAX_PAGE_SIZE;
  return n;
}
function nonEmpty(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
function buildWhere(filter) {
  const conditions = [];
  const params = [];
  const dateFrom = nonEmpty(filter.dateFrom);
  if (dateFrom !== null) {
    conditions.push("occurred_at >= ?");
    params.push(dateFrom);
  }
  const dateTo = nonEmpty(filter.dateTo);
  if (dateTo !== null) {
    conditions.push("occurred_at <= ?");
    params.push(dateTo);
  }
  if (filter.actor !== null && filter.actor !== void 0) {
    conditions.push("actor_user_id = ?");
    params.push(filter.actor);
  }
  const actionType = nonEmpty(filter.actionType);
  if (actionType !== null) {
    conditions.push("action_type = ?");
    params.push(actionType);
  }
  const targetEntity = nonEmpty(filter.targetEntity);
  if (targetEntity !== null) {
    conditions.push("target_entity = ?");
    params.push(targetEntity);
  }
  if (conditions.length === 0) {
    return { clause: "", params };
  }
  const clause = ["WHERE", conditions.join(" AND ")].join(" ");
  return { clause, params };
}
async function listAuditEvents(filter = {}) {
  const page = clampPage2(filter.page);
  const pageSize = clampPageSize2(filter.pageSize);
  const offset = page * pageSize;
  const { clause, params } = buildWhere(filter);
  const countParts = ["SELECT COUNT(*) AS n FROM audit_events"];
  if (clause !== "") countParts.push(clause);
  const countSql = countParts.join(" ");
  const countRows = await query(countSql, params);
  const total = Number(countRows[0]?.n ?? 0);
  const listParts = [
    "SELECT id, occurred_at, actor_user_id, actor_ip, action_type, target_entity, target_id, details",
    "FROM audit_events"
  ];
  if (clause !== "") listParts.push(clause);
  listParts.push("ORDER BY occurred_at DESC, id DESC");
  listParts.push("LIMIT ? OFFSET ?");
  const listSql = listParts.join(" ");
  const rows = await query(listSql, [
    ...params,
    pageSize,
    offset
  ]);
  const mapped = rows.map((row) => ({
    id: Number(row.id),
    occurredAt: toDate8(row.occurred_at),
    actorUserId: toNumberOrNull3(row.actor_user_id),
    actorIp: typeof row.actor_ip === "string" && row.actor_ip.length > 0 ? row.actor_ip : null,
    actionType: String(row.action_type ?? ""),
    targetEntity: String(row.target_entity ?? ""),
    targetId: toNumberOrNull3(row.target_id),
    details: toDetails(row.details)
  }));
  return { rows: mapped, total, page, pageSize };
}

// src/modules/users/invite-service.ts
import { randomBytes as randomBytes6 } from "node:crypto";
import { z as z17, ZodError as ZodError8 } from "zod";
import { ulid as ulid4 } from "ulid";
var INVITE_ROLES = ["Super_Admin", "HR", "Department_Head"];
var INVITATION_TOKEN_DAYS = 7;
var EMAIL_MAX_LEN5 = 254;
var TOKEN_BYTES5 = 32;
var InvalidInviteInputError = class extends Error {
  constructor(fieldErrors, message = "Invalid invite input") {
    super(message);
    this.fieldErrors = fieldErrors;
    this.name = "InvalidInviteInputError";
  }
  code = "invalid_invite_input";
  statusCode = 422;
};
var inviteUserSchema = z17.object({
  email: z17.string({ required_error: "Email is required" }).trim().max(EMAIL_MAX_LEN5, { message: "Email is too long" }).email({ message: "Please enter a valid email address" }).transform((v) => v.toLowerCase()),
  role: z17.enum(INVITE_ROLES, {
    invalid_type_error: "Role must be one of Super_Admin, HR, Department_Head",
    required_error: "Role is required"
  })
}).strict();
function generateInvitationToken() {
  return randomBytes6(TOKEN_BYTES5).toString("base64url");
}
function isDuplicateEntry2(err) {
  if (typeof err !== "object" || err === null) return false;
  const e = err;
  return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}
async function emailAlreadyExists2(connection, email) {
  const [rows] = await connection.execute(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  return rows.length > 0;
}
function buildAcceptUrl(baseUrl, token) {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/id/invite/accept?token=${encodeURIComponent(token)}`;
}
var INSERT_PENDING_USER_SQL = [
  "INSERT INTO users (uuid, email, password_hash, role, status)",
  "VALUES (?, ?, '', ?, 'pending')"
].join(" ");
var INSERT_INVITATION_TOKEN_SQL = [
  "INSERT INTO invitation_tokens (token, user_id, role, invited_by_user_id, expires_at)",
  "VALUES (?, ?, ?, ?, NOW() + INTERVAL 7 DAY)"
].join(" ");
var SELECT_INTERNAL_USERS_SQL = [
  "SELECT id, email, role, status, created_at, email_verified_at",
  "FROM users",
  "WHERE role IN (?, ?, ?)",
  "ORDER BY created_at DESC, id DESC"
].join(" ");
async function listInternalUsers() {
  const rows = await query(SELECT_INTERNAL_USERS_SQL, [
    "Super_Admin",
    "HR",
    "Department_Head"
  ]);
  return rows.map((row) => ({
    id: Number(row.id),
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    emailVerifiedAt: row.email_verified_at
  }));
}
async function inviteUser(opts) {
  const { actorUserId, actorIp = null, baseUrl } = opts;
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError("actorUserId must be a positive integer");
  }
  let parsed;
  try {
    parsed = inviteUserSchema.parse(opts.input);
  } catch (err) {
    if (err instanceof ZodError8) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidInviteInputError(fieldErrors);
    }
    throw err;
  }
  const userUuid = ulid4();
  const token = generateInvitationToken();
  return withTransaction(async (connection) => {
    if (await emailAlreadyExists2(connection, parsed.email)) {
      logger.info(
        { email_domain: parsed.email.split("@")[1] ?? "" },
        "users.invite: email already exists \u2014 no-op"
      );
      return { ok: false, reason: "duplicate_email" };
    }
    try {
      const [userResult] = await connection.execute(
        INSERT_PENDING_USER_SQL,
        [userUuid, parsed.email, parsed.role]
      );
      const insertId = userResult.insertId;
      if (!insertId || insertId <= 0) {
        throw new Error("users.invite: missing insertId after users INSERT");
      }
      const userId = Number(insertId);
      await connection.execute(INSERT_INVITATION_TOKEN_SQL, [
        token,
        userId,
        parsed.role,
        actorUserId
      ]);
      await enqueue(connection, {
        templateKey: "user_invite",
        toEmail: parsed.email,
        targetId: String(userId),
        context: {
          token,
          role: parsed.role,
          accept_url: buildAcceptUrl(baseUrl, token),
          expires_in_days: INVITATION_TOKEN_DAYS
        }
      });
      await auditService.write(
        {
          actorUserId,
          actorIp,
          actionType: "role_change",
          targetEntity: "user",
          targetId: userId,
          details: {
            event: "invite",
            invited_email: parsed.email,
            role: parsed.role,
            invited_by: actorUserId
          }
        },
        connection
      );
      logger.info(
        { user_id: userId, role: parsed.role, actor_user_id: actorUserId },
        "users.invite: pending internal user created + invitation enqueued"
      );
      return { ok: true, userId, role: parsed.role };
    } catch (err) {
      if (isDuplicateEntry2(err)) {
        logger.info(
          { email_domain: parsed.email.split("@")[1] ?? "" },
          "users.invite: duplicate-entry race \u2014 no-op"
        );
        return { ok: false, reason: "duplicate_email" };
      }
      throw err;
    }
  });
}

// src/modules/reporting/queries.ts
function nonEmpty2(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
function resolveDateRange(filter) {
  const now = /* @__PURE__ */ new Date();
  const defaultTo = now.toISOString().slice(0, 10);
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
  return {
    dateFrom: nonEmpty2(filter.dateFrom) ?? defaultFrom,
    dateTo: nonEmpty2(filter.dateTo) ?? defaultTo
  };
}
function toNumberOrNull4(raw) {
  if (raw === null || raw === void 0) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
async function queryActiveJobsCount() {
  const sql = [
    "SELECT COUNT(*) AS n",
    "FROM job_postings",
    "WHERE status = 'Published'"
  ].join(" ");
  const rows = await query(sql, []);
  return Number(rows[0]?.n ?? 0);
}
async function queryApplicationsInRange(dateFrom, dateTo) {
  const sql = [
    "SELECT COUNT(*) AS n",
    "FROM applications",
    "WHERE applied_at BETWEEN ? AND ?"
  ].join(" ");
  const rows = await query(sql, [dateFrom, dateTo]);
  return Number(rows[0]?.n ?? 0);
}
async function queryConversionAppliedToInterview(dateFrom, dateTo, totalInRange) {
  if (totalInRange === 0) return null;
  const sql = [
    "SELECT COUNT(DISTINCT a.id) AS n",
    "FROM applications a",
    "WHERE a.applied_at BETWEEN ? AND ?",
    "AND a.stage IN ('Interview', 'Offer', 'Hired', 'Rejected')"
  ].join(" ");
  const rows = await query(sql, [dateFrom, dateTo]);
  const reached = Number(rows[0]?.n ?? 0);
  return reached / totalInRange;
}
async function queryConversionInterviewToHired(dateFrom, dateTo) {
  const denomSql = [
    "SELECT COUNT(*) AS n",
    "FROM applications",
    "WHERE applied_at BETWEEN ? AND ?",
    "AND stage IN ('Interview', 'Offer', 'Hired', 'Rejected')"
  ].join(" ");
  const denomRows = await query(denomSql, [dateFrom, dateTo]);
  const denom = Number(denomRows[0]?.n ?? 0);
  if (denom === 0) return null;
  const numSql = [
    "SELECT COUNT(*) AS n",
    "FROM applications",
    "WHERE applied_at BETWEEN ? AND ?",
    "AND stage = 'Hired'"
  ].join(" ");
  const numRows = await query(numSql, [dateFrom, dateTo]);
  const num = Number(numRows[0]?.n ?? 0);
  return num / denom;
}
async function queryAvgTimeToHireHours(dateFrom, dateTo) {
  const sql = [
    "SELECT AVG(TIMESTAMPDIFF(HOUR, applied_at, hired_at)) AS avg_hours",
    "FROM applications",
    "WHERE hired_at IS NOT NULL",
    "AND applied_at BETWEEN ? AND ?"
  ].join(" ");
  const rows = await query(sql, [dateFrom, dateTo]);
  return toNumberOrNull4(rows[0]?.avg_hours);
}
async function querySourceDistribution(dateFrom, dateTo) {
  const sql = [
    "SELECT source, COUNT(*) AS cnt",
    "FROM applications",
    "WHERE applied_at BETWEEN ? AND ?",
    "GROUP BY source",
    "ORDER BY cnt DESC"
  ].join(" ");
  const rows = await query(sql, [dateFrom, dateTo]);
  return rows.map((row) => ({
    source: String(row.source ?? ""),
    count: Number(row.cnt ?? 0)
  }));
}
async function getReportSummary(filter = {}) {
  const { dateFrom, dateTo } = resolveDateRange(filter);
  const [activeJobsCount, applicationsInRange] = await Promise.all([
    queryActiveJobsCount(),
    queryApplicationsInRange(dateFrom, dateTo)
  ]);
  const [
    conversionAppliedToInterview,
    conversionInterviewToHired,
    avgTimeToHireHours,
    sourceDistribution
  ] = await Promise.all([
    queryConversionAppliedToInterview(dateFrom, dateTo, applicationsInRange),
    queryConversionInterviewToHired(dateFrom, dateTo),
    queryAvgTimeToHireHours(dateFrom, dateTo),
    querySourceDistribution(dateFrom, dateTo)
  ]);
  return {
    activeJobsCount,
    applicationsInRange,
    conversionAppliedToInterview,
    conversionInterviewToHired,
    avgTimeToHireHours,
    sourceDistribution
  };
}

// src/modules/reporting/csv-export.ts
function toDate9(raw) {
  if (raw instanceof Date) return raw;
  if (typeof raw === "string") return new Date(raw);
  return /* @__PURE__ */ new Date(0);
}
async function getApplicationsForExport(jobId, scope) {
  const params = [];
  const parts = [
    "SELECT",
    "a.id,",
    "ap.full_name,",
    "u.email,",
    "ap.phone,",
    "a.stage,",
    "a.applied_at,",
    "a.cv_file_id",
    "FROM applications a",
    "JOIN applicants ap ON ap.user_id = a.applicant_user_id",
    "JOIN users u ON u.id = a.applicant_user_id",
    "JOIN job_postings jp ON jp.id = a.job_id",
    "WHERE a.job_id = ?"
  ];
  params.push(jobId);
  if (scope !== void 0 && scope.departments.length > 0) {
    const placeholders3 = scope.departments.map(() => "?").join(", ");
    parts.push(["AND jp.department_id IN (", placeholders3, ")"].join(""));
    for (const deptId of scope.departments) {
      params.push(deptId);
    }
  }
  parts.push("ORDER BY a.applied_at DESC");
  parts.push("LIMIT 10001");
  const sql = parts.join(" ");
  const rows = await query(sql, params);
  return rows.map((row) => ({
    id: Number(row.id),
    fullName: String(row.full_name ?? ""),
    email: String(row.email ?? ""),
    phone: row.phone != null ? String(row.phone) : null,
    stage: String(row.stage ?? ""),
    appliedAt: toDate9(row.applied_at),
    cvFileId: Number(row.cv_file_id)
  }));
}

// src/modules/reporting/signed-url.ts
import { createHmac, timingSafeEqual } from "node:crypto";
function hmacHex(secret, message) {
  return createHmac("sha256", secret).update(message).digest("hex");
}
function buildMessage(cvFileId, exp) {
  return ["cv", String(cvFileId), String(exp)].join(":");
}
function signCvDownloadUrl(cvFileId, expiresInSeconds, secret) {
  const exp = Math.floor(Date.now() / 1e3) + expiresInSeconds;
  const sig = hmacHex(secret, buildMessage(cvFileId, exp));
  return ["/me/cv/", String(cvFileId), "?sig=", sig, "&exp=", String(exp)].join("");
}

// src/routes/admin.ts
var PAGE_SIZE = 20;
var SELECT_DEPARTMENTS_SQL = "SELECT id, code, name FROM departments ORDER BY name ASC";
async function loadDepartments() {
  const rows = await query(SELECT_DEPARTMENTS_SQL, []);
  return rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    name: row.name
  }));
}
function asString4(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}
function parseIdParam2(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}
function parsePageParam(raw) {
  const s = asString4(raw);
  if (s === "") return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}
function collectTranslations(body) {
  return [
    {
      locale: "id",
      title: asString4(body.title_id),
      description: asString4(body.description_id),
      requirements: asString4(body.requirements_id),
      responsibilities: asString4(body.responsibilities_id)
    },
    {
      locale: "en",
      title: asString4(body.title_en),
      description: asString4(body.description_en),
      requirements: asString4(body.requirements_en),
      responsibilities: asString4(body.responsibilities_en)
    }
  ];
}
function bodyToFormValues(body) {
  return {
    slug: asString4(body.slug),
    department_id: asString4(body.department_id),
    location: asString4(body.location),
    employment_type: asString4(body.employment_type),
    level: asString4(body.level),
    salary_min: asString4(body.salary_min),
    salary_max: asString4(body.salary_max),
    salary_currency: asString4(body.salary_currency),
    application_deadline: asString4(body.application_deadline),
    translations: {
      id: {
        title: asString4(body.title_id),
        description: asString4(body.description_id),
        requirements: asString4(body.requirements_id),
        responsibilities: asString4(body.responsibilities_id)
      },
      en: {
        title: asString4(body.title_en),
        description: asString4(body.description_en),
        requirements: asString4(body.requirements_en),
        responsibilities: asString4(body.responsibilities_en)
      }
    }
  };
}
function detailToFormValues(job) {
  return {
    slug: job.slug,
    department_id: job.department_id === null ? "" : String(job.department_id),
    location: job.location,
    employment_type: job.employment_type,
    level: job.level,
    salary_min: job.salary_min === null ? "" : String(job.salary_min),
    salary_max: job.salary_max === null ? "" : String(job.salary_max),
    salary_currency: job.salary_currency ?? "",
    application_deadline: job.application_deadline ?? "",
    translations: {
      id: {
        title: job.translations.id?.title ?? "",
        description: job.translations.id?.description ?? "",
        requirements: job.translations.id?.requirements ?? "",
        responsibilities: job.translations.id?.responsibilities ?? ""
      },
      en: {
        title: job.translations.en?.title ?? "",
        description: job.translations.en?.description ?? "",
        requirements: job.translations.en?.requirements ?? "",
        responsibilities: job.translations.en?.responsibilities ?? ""
      }
    }
  };
}
function emptyFormValues() {
  return {
    slug: "",
    department_id: "",
    location: "",
    employment_type: "",
    level: "",
    salary_min: "",
    salary_max: "",
    salary_currency: "",
    application_deadline: "",
    translations: {
      id: { title: "", description: "", requirements: "", responsibilities: "" },
      en: { title: "", description: "", requirements: "", responsibilities: "" }
    }
  };
}
function actionsForStatus(status) {
  const allowed = ALLOWED_TRANSITIONS[status];
  return {
    canPublish: allowed.has("Published"),
    canClose: allowed.has("Closed"),
    canArchive: allowed.has("Archived"),
    // Cloning is always available — the source row is read-only and the
    // new draft inherits no status semantics.
    canClone: true
  };
}
function canWrite(session) {
  return session.role === "HR" || session.role === "Super_Admin";
}
function scopeForSession(session) {
  if (session.scope.departments === void 0) return void 0;
  return { departments: session.scope.departments };
}
function send404(reply) {
  return reply.code(404).send({ error: "job_not_found" });
}
async function getJobsIndex(app, request, reply) {
  const session = await requireAdmin(request, reply);
  if (session === null) return reply;
  const statusRaw = asString4(request.query?.status);
  const status = statusRaw && JOB_STATUSES.includes(statusRaw) ? statusRaw : null;
  const page = parsePageParam(request.query?.page);
  let result;
  try {
    result = await list(
      {
        status: status === null ? void 0 : [status],
        page,
        pageSize: PAGE_SIZE
      },
      scopeForSession(session)
    );
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.jobs: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const html = app.view("admin/jobs/index.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: canWrite(session)
    },
    statuses: JOB_STATUSES,
    statusFilter: status,
    jobs: result.rows,
    total: result.total,
    page,
    pageSize: PAGE_SIZE,
    totalPages,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getJobNew(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  let departments;
  try {
    departments = await loadDepartments();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.jobs: department list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = app.view("admin/jobs/edit.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true
    },
    mode: "create",
    formAction: "/admin/jobs",
    job: null,
    values: emptyFormValues(),
    errors: {},
    generalError: null,
    departments,
    employmentTypes: EMPLOYMENT_TYPES2,
    levels: JOB_LEVELS,
    locales: JOB_LOCALES,
    actions: {
      canPublish: false,
      canClose: false,
      canArchive: false,
      canClone: false
    },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postJobCreate(app, request, reply) {
  const session = await requirePolicy("job.create")(request, reply);
  if (session === null) return reply;
  const body = request.body ?? {};
  const payload = {
    slug: asString4(body.slug),
    department_id: asString4(body.department_id),
    location: asString4(body.location),
    employment_type: asString4(body.employment_type),
    level: asString4(body.level),
    salary_min: asString4(body.salary_min),
    salary_max: asString4(body.salary_max),
    salary_currency: asString4(body.salary_currency),
    application_deadline: asString4(body.application_deadline),
    translations: collectTranslations(body)
  };
  try {
    const created = await createJob(payload, session.userId);
    return reply.code(302).header("location", `/admin/jobs/${created.id}?saved=1`).send();
  } catch (err) {
    if (err instanceof ZodError9 || err instanceof SlugConflictError) {
      const errors = err instanceof ZodError9 ? zodErrorToFieldMap(err) : { slug: [`Slug "${err.slug}" is already in use`] };
      const status = err instanceof SlugConflictError ? 422 : 400;
      let departments = [];
      try {
        departments = await loadDepartments();
      } catch {
      }
      const html = app.view("admin/jobs/edit.njk", {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true
        },
        mode: "create",
        formAction: "/admin/jobs",
        job: null,
        values: bodyToFormValues(body),
        errors,
        generalError: null,
        departments,
        employmentTypes: EMPLOYMENT_TYPES2,
        levels: JOB_LEVELS,
        locales: JOB_LOCALES,
        actions: {
          canPublish: false,
          canClose: false,
          canArchive: false,
          canClone: false
        },
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce
      });
      return reply.code(status).type("text/html; charset=utf-8").send(html);
    }
    app.log.error(
      { err, userId: session.userId },
      "admin.jobs: create failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function getJobEdit(app, request, reply) {
  const session = await requireAdmin(request, reply);
  if (session === null) return reply;
  const id = parseIdParam2(request.params.id);
  if (id === null) return send404(reply);
  let job;
  try {
    job = await findById(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      "admin.jobs: load failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (job === null) return send404(reply);
  let departments;
  try {
    departments = await loadDepartments();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.jobs: department list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const writable = canWrite(session);
  const saved = asString4(request.query?.saved) === "1";
  const html = app.view("admin/jobs/edit.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: writable
    },
    mode: "edit",
    formAction: `/admin/jobs/${job.id}`,
    job,
    values: detailToFormValues(job),
    errors: {},
    generalError: null,
    saved,
    departments,
    employmentTypes: EMPLOYMENT_TYPES2,
    levels: JOB_LEVELS,
    locales: JOB_LOCALES,
    actions: writable ? actionsForStatus(job.status) : { canPublish: false, canClose: false, canArchive: false, canClone: false },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postJobUpdate(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const id = parseIdParam2(request.params.id);
  if (id === null) return send404(reply);
  const body = request.body ?? {};
  const payload = {
    slug: asString4(body.slug),
    department_id: asString4(body.department_id),
    location: asString4(body.location),
    employment_type: asString4(body.employment_type),
    level: asString4(body.level),
    salary_min: asString4(body.salary_min),
    salary_max: asString4(body.salary_max),
    salary_currency: asString4(body.salary_currency),
    application_deadline: asString4(body.application_deadline),
    translations: collectTranslations(body)
  };
  try {
    await updateJob(id, payload, session.userId, scopeForSession(session));
    return reply.code(302).header("location", `/admin/jobs/${id}?saved=1`).send();
  } catch (err) {
    if (err instanceof JobNotFoundError) return send404(reply);
    if (err instanceof ZodError9 || err instanceof SlugConflictError) {
      const persisted = await findById(id, scopeForSession(session)).catch(
        () => null
      );
      const errors = err instanceof ZodError9 ? zodErrorToFieldMap(err) : { slug: [`Slug "${err.slug}" is already in use`] };
      const status = err instanceof SlugConflictError ? 422 : 400;
      let departments = [];
      try {
        departments = await loadDepartments();
      } catch {
      }
      const html = app.view("admin/jobs/edit.njk", {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true
        },
        mode: "edit",
        formAction: `/admin/jobs/${id}`,
        job: persisted,
        values: bodyToFormValues(body),
        errors,
        generalError: null,
        departments,
        employmentTypes: EMPLOYMENT_TYPES2,
        levels: JOB_LEVELS,
        locales: JOB_LOCALES,
        actions: persisted ? actionsForStatus(persisted.status) : { canPublish: false, canClose: false, canArchive: false, canClone: false },
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce
      });
      return reply.code(status).type("text/html; charset=utf-8").send(html);
    }
    app.log.error(
      { err, userId: session.userId, jobId: id },
      "admin.jobs: update failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function postJobStatus(app, action, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const id = parseIdParam2(request.params.id);
  if (id === null) return send404(reply);
  try {
    const scope = scopeForSession(session);
    if (action === "publish") {
      await publishJob(id, session.userId, scope);
    } else if (action === "close") {
      await closeJob(id, session.userId, scope);
    } else {
      await archiveJob(id, session.userId, scope);
    }
    return reply.code(302).header("location", `/admin/jobs/${id}?saved=1`).send();
  } catch (err) {
    if (err instanceof JobNotFoundError) return send404(reply);
    if (err instanceof InvalidTransitionError) {
      return reply.code(422).send({
        error: "invalid_transition",
        from: err.from,
        to: err.to
      });
    }
    if (err instanceof ZodError9) {
      return reply.code(422).send({
        error: "cannot_publish",
        details: zodErrorToFieldMap(err)
      });
    }
    app.log.error(
      { err, userId: session.userId, jobId: id, action },
      "admin.jobs: status transition failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function getJobClone(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const id = parseIdParam2(request.params.id);
  if (id === null) return send404(reply);
  let job;
  try {
    job = await findById(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      "admin.jobs: clone load failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (job === null) return send404(reply);
  const html = app.view("admin/jobs/clone.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true
    },
    job,
    values: { slug: "" },
    errors: {},
    generalError: null,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postJobClone(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const id = parseIdParam2(request.params.id);
  if (id === null) return send404(reply);
  const body = request.body ?? {};
  const slug = asString4(body.slug);
  try {
    const cloned = await cloneJob(
      id,
      { slug },
      session.userId,
      scopeForSession(session)
    );
    return reply.code(302).header("location", `/admin/jobs/${cloned.id}?saved=1`).send();
  } catch (err) {
    if (err instanceof JobNotFoundError) return send404(reply);
    if (err instanceof ZodError9 || err instanceof SlugConflictError) {
      const errors = err instanceof ZodError9 ? zodErrorToFieldMap(err) : { slug: [`Slug "${err.slug}" is already in use`] };
      const status = err instanceof SlugConflictError ? 422 : 400;
      const job = await findById(id, scopeForSession(session)).catch(
        () => null
      );
      if (job === null) return send404(reply);
      const html = app.view("admin/jobs/clone.njk", {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true
        },
        job,
        values: { slug },
        errors,
        generalError: null,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce
      });
      return reply.code(status).type("text/html; charset=utf-8").send(html);
    }
    app.log.error(
      { err, userId: session.userId, jobId: id },
      "admin.jobs: clone failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function getJobKanban(app, request, reply) {
  const session = await requireAdmin(request, reply);
  if (session === null) return reply;
  const id = parseIdParam2(request.params.id);
  if (id === null) return send404(reply);
  let job;
  try {
    job = await findById(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      "admin.jobs.kanban: load failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (job === null) return send404(reply);
  let rawColumns;
  try {
    rawColumns = await listForKanban(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      "admin.jobs.kanban: query failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const writable = canWrite(session);
  const columns = KANBAN_STAGES.map((stage, index) => {
    const col = rawColumns[index];
    return {
      stage,
      label: KANBAN_STAGE_LABELS[stage],
      rows: col?.stage === stage ? col.rows : []
    };
  });
  const html = app.view("admin/jobs/kanban.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: writable
    },
    job,
    columns,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postScheduleInterview(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR", "Department_Head"]
  });
  if (session === null) return reply;
  const applicationId = parseIdParam2(request.params.id);
  if (applicationId === null) return send404(reply);
  const body = request.body ?? {};
  try {
    const result = await scheduleInterviewForApplication({
      applicationId,
      actorUserId: session.userId,
      scope: scopeForSession(session),
      input: {
        scheduledAt: body.scheduledAt,
        location: body.location,
        meetingUrl: body.meetingUrl,
        interviewerUserId: body.interviewerUserId
      }
    });
    return reply.code(201).send({ ok: true, interview: result.interview });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError2) return send404(reply);
    if (err instanceof InvalidInterviewInputError) {
      return reply.code(422).send({
        error: "invalid_interview_input",
        fields: err.fieldErrors
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId },
      "admin.applications.interview: schedule failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function getApplicationNotes(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR", "Department_Head"]
  });
  if (session === null) return reply;
  const applicationId = parseIdParam2(request.params.id);
  if (applicationId === null) return send404(reply);
  try {
    const notes = await listNotes({
      applicationId,
      scope: scopeForSession(session)
    });
    return reply.code(200).send({ ok: true, notes });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) return send404(reply);
    app.log.error(
      { err, userId: session.userId, applicationId },
      "admin.applications.notes: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function postApplicationNote(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR", "Department_Head"]
  });
  if (session === null) return reply;
  const applicationId = parseIdParam2(request.params.id);
  if (applicationId === null) return send404(reply);
  const body = request.body ?? {};
  try {
    const note = await addNote({
      applicationId,
      authorUserId: session.userId,
      scope: scopeForSession(session),
      input: {
        body: body.body,
        visibleToApplicant: body.visibleToApplicant
      }
    });
    return reply.code(201).send({ ok: true, note });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) return send404(reply);
    if (err instanceof InvalidNoteInputError) {
      return reply.code(422).send({
        error: "invalid_note_input",
        fields: err.fieldErrors
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId },
      "admin.applications.notes: add failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function postApplicationEmail(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const applicationId = parseIdParam2(request.params.id);
  if (applicationId === null) return send404(reply);
  const body = request.body ?? {};
  try {
    const result = await sendTemplatedEmail({
      applicationId,
      actorUserId: session.userId,
      scope: scopeForSession(session),
      input: {
        templateKey: body.templateKey,
        locale: body.locale
      }
    });
    return reply.code(200).send({
      ok: true,
      templateKey: result.templateKey,
      toEmail: result.toEmail
    });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) return send404(reply);
    if (err instanceof MailTemplateNotFoundError) {
      return reply.code(422).send({ error: "unknown_template" });
    }
    if (err instanceof InvalidEmailInputError) {
      return reply.code(422).send({
        error: "invalid_email_input",
        fields: err.fieldErrors
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId },
      "admin.applications.email: send failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
async function postApplicationStage(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const applicationId = parseIdParam2(request.params.id);
  if (applicationId === null) return send404(reply);
  const body = request.body ?? {};
  const rawStage = asString4(body.stage) || asString4(body.newStage);
  if (!isPipelineStage(rawStage)) {
    return reply.code(422).send({
      error: "invalid_stage",
      allowed: PIPELINE_STAGES
    });
  }
  const newStage = rawStage;
  const reason = asString4(body.reason);
  try {
    await changeStage({
      applicationId,
      newStage,
      actorUserId: session.userId,
      scope: scopeForSession(session),
      reason: reason === "" ? null : reason
    });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) return send404(reply);
    if (err instanceof InvalidStageTransitionError) {
      return reply.code(422).send({
        error: "invalid_stage_transition",
        from: err.from,
        to: err.to
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId, newStage },
      "admin.applications.stage: transition failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  let card;
  try {
    card = await findKanbanCard(applicationId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, applicationId },
      "admin.applications.stage: card re-render read failed"
    );
    return reply.code(200).header("HX-Trigger", "stage-changed").type("text/html; charset=utf-8").send("");
  }
  if (card === null) {
    return reply.code(200).header("HX-Trigger", "stage-changed").type("text/html; charset=utf-8").send("");
  }
  const html = app.view("partials/kanban-card.njk", {
    card,
    canWrite: canWrite(session),
    csrfToken: session.csrfToken
  });
  return reply.code(200).header("HX-Trigger", "stage-changed").type("text/html; charset=utf-8").send(html);
}
function parseApplicationIds(raw) {
  let parts;
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === "number") {
    parts = [raw];
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    if (trimmed.startsWith("[")) {
      let decoded;
      try {
        decoded = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (!Array.isArray(decoded)) return null;
      parts = decoded;
    } else {
      parts = trimmed.split(",");
    }
  } else {
    return null;
  }
  const ids = [];
  for (const part of parts) {
    const s = typeof part === "number" ? String(part) : asString4(part).trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    ids.push(n);
  }
  if (ids.length === 0) return null;
  return ids;
}
async function postApplicationsBulkStage(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const body = request.body ?? {};
  const rawStage = asString4(body.stage);
  if (!isPipelineStage(rawStage)) {
    return reply.code(422).send({
      error: "invalid_stage",
      allowed: PIPELINE_STAGES
    });
  }
  const newStage = rawStage;
  const applicationIds = parseApplicationIds(body.applicationIds);
  if (applicationIds === null) {
    return reply.code(422).send({ error: "invalid_application_ids" });
  }
  const reason = asString4(body.reason);
  try {
    const { results } = await bulkChangeStage({
      applicationIds,
      newStage,
      actorUserId: session.userId,
      scope: scopeForSession(session),
      reason: reason === "" ? null : reason
    });
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    return reply.code(200).send({ ok: true, results, succeeded, failed });
  } catch (err) {
    if (err instanceof BulkStageBatchTooLargeError) {
      return reply.code(422).send({
        error: "batch_too_large",
        count: err.count,
        max: err.max
      });
    }
    app.log.error(
      { err, userId: session.userId, newStage },
      "admin.applications.bulkStage: transition failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
function templateToFormValues(record) {
  return {
    key: record.key,
    locale: record.locale,
    subject: record.subject,
    body_html: record.body_html,
    body_text: record.body_text ?? ""
  };
}
function templateBodyToFormValues(body) {
  return {
    key: asString4(body.key),
    locale: asString4(body.locale),
    subject: asString4(body.subject),
    body_html: asString4(body.body_html),
    body_text: asString4(body.body_text)
  };
}
function emptyTemplateFormValues() {
  return {
    key: "",
    locale: TEMPLATE_LOCALES[0],
    subject: "",
    body_html: "",
    body_text: ""
  };
}
function sendTemplate404(reply) {
  return reply.code(404).send({ error: "mail_template_not_found" });
}
async function getMailTemplatesIndex(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  let templates;
  try {
    templates = await listAll();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.mailTemplates: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = app.view("admin/mail-templates/index.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true
    },
    templates,
    saved: asString4(request.query?.saved) === "1",
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getMailTemplateNew(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const html = app.view("admin/mail-templates/edit.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true
    },
    mode: "create",
    formAction: "/admin/mail-templates",
    values: emptyTemplateFormValues(),
    errors: {},
    generalError: null,
    locales: TEMPLATE_LOCALES,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getMailTemplateEdit(app, request, reply) {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ["Super_Admin", "HR"]
  });
  if (session === null) return reply;
  const key = asString4(request.params.key);
  const locale = asString4(request.params.locale);
  let record;
  try {
    record = await getOne(key, locale);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, key, locale },
      "admin.mailTemplates: load failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (record === null) return sendTemplate404(reply);
  const html = app.view("admin/mail-templates/edit.njk", {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true
    },
    mode: "edit",
    formAction: "/admin/mail-templates",
    values: templateToFormValues(record),
    errors: {},
    generalError: null,
    saved: asString4(request.query?.saved) === "1",
    locales: TEMPLATE_LOCALES,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function postMailTemplateSave(app, request, reply) {
  const session = await requirePolicy("mail_template.manage")(request, reply);
  if (session === null) return reply;
  const body = request.body ?? {};
  try {
    await saveTemplate({
      actorUserId: session.userId,
      input: {
        key: body.key,
        locale: body.locale,
        subject: body.subject,
        bodyHtml: body.body_html,
        bodyText: body.body_text
      }
    });
    return reply.code(302).header("location", "/admin/mail-templates?saved=1").send();
  } catch (err) {
    if (err instanceof InvalidTemplateInputError) {
      const html = app.view("admin/mail-templates/edit.njk", {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true
        },
        mode: "create",
        formAction: "/admin/mail-templates",
        values: templateBodyToFormValues(body),
        errors: err.fieldErrors,
        generalError: null,
        locales: TEMPLATE_LOCALES,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce
      });
      return reply.code(422).type("text/html; charset=utf-8").send(html);
    }
    app.log.error(
      { err, userId: session.userId },
      "admin.mailTemplates: save failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
function parseActorParam(raw) {
  const s = asString4(raw);
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}
async function getAuditIndex(app, request, reply) {
  const session = await requirePolicy("audit.read")(request, reply);
  if (session === null) return reply;
  const q = request.query ?? {};
  const dateFrom = asString4(q.dateFrom);
  const dateTo = asString4(q.dateTo);
  const actor = parseActorParam(q.actor);
  const actionType = asString4(q.actionType);
  const targetEntity = asString4(q.targetEntity);
  const page = parsePageParam(q.page);
  const filter = {
    dateFrom: dateFrom === "" ? null : dateFrom,
    dateTo: dateTo === "" ? null : dateTo,
    actor,
    actionType: actionType === "" ? null : actionType,
    targetEntity: targetEntity === "" ? null : targetEntity,
    page,
    pageSize: AUDIT_LIST_DEFAULT_PAGE_SIZE
  };
  let result;
  try {
    result = await listAuditEvents(filter);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.audit: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const totalPages = Math.max(
    1,
    Math.ceil(result.total / result.pageSize)
  );
  const html = app.view("admin/audit/index.njk", {
    session: {
      userId: session.userId,
      role: session.role
    },
    actionTypes: ACTION_TYPES,
    filter: {
      dateFrom,
      dateTo,
      actor: actor === null ? "" : String(actor),
      actionType,
      targetEntity
    },
    events: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
function resolveBaseUrl() {
  const raw = process.env.BASE_URL ?? "http://localhost:3000";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}
async function getUsersIndex(app, request, reply) {
  const session = await requirePolicy("user.invite")(request, reply);
  if (session === null) return reply;
  let users;
  try {
    users = await listInternalUsers();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.users: list failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const invited = asString4(request.query?.invited) === "1";
  const html = app.view("admin/users/index.njk", {
    session: {
      userId: session.userId,
      role: session.role
    },
    users,
    inviteRoles: INVITE_ROLES,
    invited,
    errors: {},
    generalError: null,
    values: { email: "", role: INVITE_ROLES[0] },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
function csvEscape(value) {
  return ['"', value.replace(/"/g, '""'), '"'].join("");
}
function formatDate(d) {
  try {
    return d.toISOString();
  } catch {
    return "";
  }
}
async function getJobCsvExport(app, request, reply) {
  const session = await requirePolicy("report.read")(request, reply);
  if (session === null) return reply;
  const jobId = parseIdParam2(request.params.id);
  if (jobId === null) return send404(reply);
  let rows;
  try {
    rows = await getApplicationsForExport(jobId, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId },
      "admin.reports: getApplicationsForExport failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (rows.length > 1e4) {
    return reply.code(422).send({
      error: "too_many_rows",
      count: rows.length,
      suggestion: "Apply a date filter to narrow the export"
    });
  }
  const secret = process.env.SESSION_SECRET ?? "dev-secret";
  const SIXTY_MINUTES = 60 * 60;
  reply.raw.setHeader("Content-Type", "text/csv; charset=utf-8");
  reply.raw.setHeader(
    "Content-Disposition",
    ['attachment; filename="applications-', String(jobId), '.csv"'].join("")
  );
  reply.raw.write(
    "applicant_name,email,phone,current_stage,applied_at,cv_download_url\n"
  );
  for (const row of rows) {
    const cvUrl = signCvDownloadUrl(row.cvFileId, SIXTY_MINUTES, secret);
    const csvRow = [
      csvEscape(row.fullName),
      csvEscape(row.email),
      csvEscape(row.phone ?? ""),
      csvEscape(row.stage),
      csvEscape(formatDate(row.appliedAt)),
      csvEscape(cvUrl)
    ].join(",");
    reply.raw.write(csvRow + "\n");
  }
  reply.raw.end();
  try {
    await auditService.write({
      actorUserId: session.userId,
      actorIp: request.ip,
      actionType: "data_export",
      targetEntity: "job_posting",
      targetId: jobId,
      details: { jobId, rowCount: rows.length }
    });
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId },
      "admin.reports: failed to write data_export audit event"
    );
  }
}
async function getReportsIndex(app, request, reply) {
  const session = await requirePolicy("report.read")(request, reply);
  if (session === null) return reply;
  const dateFrom = asString4(request.query?.dateFrom);
  const dateTo = asString4(request.query?.dateTo);
  const filter = {
    dateFrom: dateFrom !== "" ? dateFrom : null,
    dateTo: dateTo !== "" ? dateTo : null
  };
  let summary;
  try {
    summary = await getReportSummary(filter);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.reports: getReportSummary failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const html = app.view("admin/reports.njk", {
    session: {
      userId: session.userId,
      role: session.role
    },
    filter: {
      dateFrom: dateFrom !== "" ? dateFrom : null,
      dateTo: dateTo !== "" ? dateTo : null
    },
    summary,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function renderInviteError(app, request, reply, session, status, body, errors, generalError) {
  let users = [];
  try {
    users = await listInternalUsers();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      "admin.users: list failed during invite re-render"
    );
  }
  const html = app.view("admin/users/index.njk", {
    session: {
      userId: session.userId,
      role: session.role
    },
    users,
    inviteRoles: INVITE_ROLES,
    invited: false,
    errors,
    generalError,
    values: {
      email: asString4(body.email),
      role: asString4(body.role) || INVITE_ROLES[0]
    },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(status).type("text/html; charset=utf-8").send(html);
}
async function postUserInvite(app, request, reply) {
  const session = await requirePolicy("user.invite")(request, reply);
  if (session === null) return reply;
  const body = request.body ?? {};
  try {
    const result = await inviteUser({
      actorUserId: session.userId,
      actorIp: request.ip,
      baseUrl: resolveBaseUrl(),
      input: { email: asString4(body.email), role: asString4(body.role) }
    });
    if (result.ok) {
      return reply.code(302).header("location", "/admin/users?invited=1").send();
    }
    return renderInviteError(
      app,
      request,
      reply,
      session,
      422,
      body,
      { email: ["An account with this email already exists"] },
      null
    );
  } catch (err) {
    if (err instanceof InvalidInviteInputError) {
      return renderInviteError(
        app,
        request,
        reply,
        session,
        err.statusCode,
        body,
        err.fieldErrors,
        null
      );
    }
    app.log.error(
      { err, userId: session.userId },
      "admin.users: invite failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
}
var BACKUP_FILENAME_RE = /^(db|files)-\d{4}-\d{2}-\d{2}\.(sql\.gz|tar\.gz)$/;
async function collectBackupEntries(dir, isMonthly) {
  let names;
  try {
    names = await fs2.readdir(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const filename of names) {
    if (!BACKUP_FILENAME_RE.test(filename)) continue;
    try {
      const s = await fs2.stat(path4.join(dir, filename));
      entries.push({
        filename,
        sizeBytes: s.size,
        mtime: s.mtime.toISOString(),
        isMonthly
      });
    } catch {
    }
  }
  return entries;
}
async function getBackupsIndex(app, request, reply) {
  const session = await requirePolicy("backup.read")(request, reply);
  if (session === null) return reply;
  const backupDir = path4.join(os2.homedir(), "backups");
  const monthlyDir = path4.join(backupDir, "monthly");
  let dailyEntries;
  let monthlyEntries;
  try {
    [dailyEntries, monthlyEntries] = await Promise.all([
      collectBackupEntries(backupDir, false),
      collectBackupEntries(monthlyDir, true)
    ]);
  } catch (err) {
    app.log.error({ err, userId: session.userId }, "admin.backups: list failed");
    return reply.code(500).send({ error: "internal_error" });
  }
  const sortByMtime = (a, b) => b.mtime.localeCompare(a.mtime);
  dailyEntries.sort(sortByMtime);
  monthlyEntries.sort(sortByMtime);
  const html = app.view("admin/backups/index.njk", {
    session: { userId: session.userId, role: session.role },
    dailyFiles: dailyEntries,
    monthlyFiles: monthlyEntries,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getBackupDownload(_app, request, reply) {
  const session = await requirePolicy("backup.read")(request, reply);
  if (session === null) return reply;
  const { filename } = request.params;
  if (!BACKUP_FILENAME_RE.test(filename)) {
    return reply.code(400).send({ error: "invalid_filename" });
  }
  const backupDir = path4.join(os2.homedir(), "backups");
  const monthlyDir = path4.join(backupDir, "monthly");
  let filePath = null;
  for (const dir of [backupDir, monthlyDir]) {
    const candidate = path4.join(dir, filename);
    try {
      await fs2.stat(candidate);
      filePath = candidate;
      break;
    } catch {
    }
  }
  if (filePath === null) {
    return reply.code(404).send({ error: "backup_not_found" });
  }
  reply.code(200).header("Content-Disposition", ['attachment; filename="', filename, '"'].join("")).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, no-store");
  if (filename.endsWith(".sql.gz") || filename.endsWith(".tar.gz")) {
    reply.header("Content-Type", "application/gzip");
  }
  const { createReadStream: createReadStream2 } = await import("node:fs");
  const stream = createReadStream2(filePath);
  return reply.send(stream);
}
async function getDiagnostics(_app, request, reply) {
  const session = await requirePolicy("diagnostics.read")(request, reply);
  if (session === null) return reply;
  const backupDir = path4.join(process.env.HOME ?? "/tmp", "backups");
  const [mailRows, cronRows, backupMtime] = await Promise.all([
    // Pending mail count
    query(
      [
        "SELECT COUNT(*) AS n",
        "FROM mail_outbox",
        "WHERE status = 'pending'"
      ].join(" "),
      []
    ),
    // Cron lock telemetry
    query(
      [
        "SELECT name, last_run_at, last_status",
        "FROM cron_locks",
        "ORDER BY name ASC"
      ].join(" "),
      []
    ),
    // Latest backup mtime — gracefully returns null if dir absent
    (async () => {
      try {
        const entries = await fs2.readdir(backupDir);
        if (entries.length === 0) return null;
        const mtimes = await Promise.all(
          entries.map(async (entry) => {
            const stat3 = await fs2.stat(path4.join(backupDir, entry));
            return stat3.mtimeMs;
          })
        );
        const latest = Math.max(...mtimes);
        return new Date(latest).toISOString();
      } catch {
        return null;
      }
    })()
  ]);
  const pendingCount = Number(mailRows[0]?.n ?? 0);
  return reply.code(200).send({
    uptime_seconds: process.uptime(),
    node_version: process.version,
    memory_rss_bytes: process.memoryUsage().rss,
    mail_pending: pendingCount,
    cron_locks: cronRows.map((row) => ({
      name: row.name,
      last_run_at: row.last_run_at ? row.last_run_at instanceof Date ? row.last_run_at.toISOString() : row.last_run_at : null,
      last_status: row.last_status ?? null
    })),
    backup_mtime: backupMtime
  });
}
var adminRoutes = async (app) => {
  app.get(
    "/admin/jobs",
    (request, reply) => getJobsIndex(app, request, reply)
  );
  app.get(
    "/admin/jobs/new",
    (request, reply) => getJobNew(app, request, reply)
  );
  app.post(
    "/admin/jobs",
    (request, reply) => postJobCreate(app, request, reply)
  );
  app.get(
    "/admin/jobs/:id/clone",
    (request, reply) => getJobClone(app, request, reply)
  );
  app.post(
    "/admin/jobs/:id/clone",
    (request, reply) => postJobClone(app, request, reply)
  );
  app.get(
    "/admin/jobs/:id/kanban",
    (request, reply) => getJobKanban(app, request, reply)
  );
  app.post(
    "/admin/jobs/:id/publish",
    (request, reply) => postJobStatus(app, "publish", request, reply)
  );
  app.post(
    "/admin/jobs/:id/close",
    (request, reply) => postJobStatus(app, "close", request, reply)
  );
  app.post(
    "/admin/jobs/:id/archive",
    (request, reply) => postJobStatus(app, "archive", request, reply)
  );
  app.get(
    "/admin/jobs/:id",
    (request, reply) => getJobEdit(app, request, reply)
  );
  app.post(
    "/admin/jobs/:id",
    (request, reply) => postJobUpdate(app, request, reply)
  );
  app.post(
    "/admin/applications/:id/interview",
    (request, reply) => postScheduleInterview(app, request, reply)
  );
  app.get(
    "/admin/applications/:id/notes",
    (request, reply) => getApplicationNotes(app, request, reply)
  );
  app.post(
    "/admin/applications/:id/notes",
    (request, reply) => postApplicationNote(app, request, reply)
  );
  app.post(
    "/admin/applications/:id/email",
    (request, reply) => postApplicationEmail(app, request, reply)
  );
  app.post(
    "/api/applications/:id/stage",
    (request, reply) => postApplicationStage(app, request, reply)
  );
  app.post(
    "/api/applications/bulk-stage",
    (request, reply) => postApplicationsBulkStage(app, request, reply)
  );
  app.get(
    "/admin/mail-templates",
    (request, reply) => getMailTemplatesIndex(app, request, reply)
  );
  app.get(
    "/admin/mail-templates/new",
    (request, reply) => getMailTemplateNew(app, request, reply)
  );
  app.post(
    "/admin/mail-templates",
    (request, reply) => postMailTemplateSave(app, request, reply)
  );
  app.get(
    "/admin/mail-templates/:key/:locale",
    (request, reply) => getMailTemplateEdit(app, request, reply)
  );
  app.get(
    "/admin/audit",
    (request, reply) => getAuditIndex(app, request, reply)
  );
  app.get(
    "/admin/users",
    (request, reply) => getUsersIndex(app, request, reply)
  );
  app.post(
    "/admin/users/invite",
    (request, reply) => postUserInvite(app, request, reply)
  );
  app.get(
    "/admin/reports/jobs/:id/export.csv",
    (request, reply) => getJobCsvExport(app, request, reply)
  );
  app.get(
    "/admin/reports",
    (request, reply) => getReportsIndex(app, request, reply)
  );
  app.get(
    "/admin/diagnostics",
    (request, reply) => getDiagnostics(app, request, reply)
  );
  app.get(
    "/admin/backups",
    (request, reply) => getBackupsIndex(app, request, reply)
  );
  app.get(
    "/admin/backups/:filename",
    (request, reply) => getBackupDownload(app, request, reply)
  );
};
var admin_default = adminRoutes;

// src/modules/jobs/search.ts
import { z as z18 } from "zod";
import QuickLRU from "quick-lru";
var DEFAULT_PAGE_SIZE3 = 20;
var MAX_PAGE_SIZE2 = 50;
var MAX_OFFSET2 = 200;
var NGRAM_TOKEN_SIZE = 2;
var MIN_PREFIX_TOKEN_LENGTH = 3;
var FACET_CACHE_TTL_MS = 6e4;
var FACET_CACHE_MAX_SIZE = 200;
var BOOLEAN_MODE_STRIP_REGEX = /[+\-><()~*"@`]/g;
function sanitizeKeyword(input) {
  if (typeof input !== "string" || input.length === 0) return "";
  const cleaned = input.replace(BOOLEAN_MODE_STRIP_REGEX, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "";
  const tokens = [];
  for (const raw of cleaned.split(" ")) {
    const token = raw.trim();
    if (token.length < NGRAM_TOKEN_SIZE) continue;
    const suffix = token.length >= MIN_PREFIX_TOKEN_LENGTH ? "*" : "";
    tokens.push(`+"${token}"${suffix}`);
  }
  if (tokens.length === 0) return "";
  return tokens.join(" ");
}
var csvOrArrayString = z18.union([z18.string(), z18.array(z18.string())]).optional().transform((value) => {
  if (value === void 0) return void 0;
  const parts = Array.isArray(value) ? value : value.split(",");
  const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned : void 0;
});
var employmentTypeArray = csvOrArrayString.pipe(
  z18.array(z18.enum(EMPLOYMENT_TYPES2)).optional()
);
var levelArray = csvOrArrayString.pipe(
  z18.array(z18.enum(JOB_LEVELS)).optional()
);
var departmentIdArray = z18.union([z18.string(), z18.array(z18.string()), z18.number(), z18.array(z18.number())]).optional().transform((value) => {
  if (value === void 0) return void 0;
  const raw = Array.isArray(value) ? value : [value];
  const flat = [];
  for (const v of raw) {
    if (typeof v === "number") {
      flat.push(String(v));
    } else {
      for (const part of v.split(",")) flat.push(part);
    }
  }
  const ids = [];
  for (const part of flat) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) ids.push(n);
  }
  return ids.length > 0 ? ids : void 0;
});
var positiveInt = z18.union([z18.string(), z18.number()]).optional().transform((value) => {
  if (value === void 0) return void 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return void 0;
  return n;
});
var searchFilterSchema = z18.object({
  keyword: z18.string().optional(),
  location: csvOrArrayString,
  department_id: departmentIdArray,
  employment_type: employmentTypeArray,
  level: levelArray,
  page: positiveInt,
  pageSize: positiveInt
});
var VISIBILITY_PREDICATE = "j.status = 'Published' AND (j.application_deadline IS NULL OR j.application_deadline >= CURRENT_DATE())";
var SEARCH_COLUMNS = [
  "j.id",
  "j.slug",
  "COALESCE(t_active.title, t_fallback.title) AS title",
  "j.location",
  "j.employment_type",
  "j.level",
  "j.department_id",
  "j.published_at",
  "j.application_deadline"
].join(", ");
function placeholders2(n) {
  if (n <= 0) return "";
  return Array.from({ length: n }, () => "?").join(", ");
}
function toNumberOrNull5(value) {
  if (value === null || value === void 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function toDate10(value) {
  if (value === null || value === void 0) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function dateToIsoYmd7(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
function rowToSearchResult(row) {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title ?? null,
    location: row.location,
    employment_type: row.employment_type,
    level: row.level,
    department_id: toNumberOrNull5(row.department_id),
    published_at: toDate10(row.published_at),
    application_deadline: dateToIsoYmd7(row.application_deadline)
  };
}
function normaliseFilter(filter) {
  const rawKeyword = (filter.keyword ?? "").trim();
  const sanitised = sanitizeKeyword(rawKeyword);
  const pageSizeRaw = filter.pageSize ?? DEFAULT_PAGE_SIZE3;
  const pageSize = Math.min(
    Math.max(1, Math.floor(pageSizeRaw)),
    MAX_PAGE_SIZE2
  );
  const pageRaw = filter.page ?? 0;
  const page = Math.max(0, Math.floor(pageRaw));
  const offset = Math.min(page * pageSize, MAX_OFFSET2);
  return {
    keyword: rawKeyword,
    sanitisedKeyword: sanitised,
    locations: filter.location ?? [],
    departmentIds: filter.department_id ?? [],
    employmentTypes: filter.employment_type ?? [],
    levels: filter.level ?? [],
    page,
    pageSize,
    offset
  };
}
function buildWhereClause(filter, excludeFacet) {
  const clauses = [VISIBILITY_PREDICATE];
  const params = [];
  clauses.push("(? = '' OR MATCH(j.search_text) AGAINST (? IN BOOLEAN MODE))");
  params.push(filter.sanitisedKeyword, filter.sanitisedKeyword);
  if (excludeFacet !== "location" && filter.locations.length > 0) {
    clauses.push("j.location IN (" + placeholders2(filter.locations.length) + ")");
    for (const v of filter.locations) params.push(v);
  }
  if (excludeFacet !== "department_id" && filter.departmentIds.length > 0) {
    clauses.push(
      "j.department_id IN (" + placeholders2(filter.departmentIds.length) + ")"
    );
    for (const v of filter.departmentIds) params.push(v);
  }
  if (excludeFacet !== "employment_type" && filter.employmentTypes.length > 0) {
    clauses.push(
      "j.employment_type IN (" + placeholders2(filter.employmentTypes.length) + ")"
    );
    for (const v of filter.employmentTypes) params.push(v);
  }
  if (excludeFacet !== "level" && filter.levels.length > 0) {
    clauses.push("j.level IN (" + placeholders2(filter.levels.length) + ")");
    for (const v of filter.levels) params.push(v);
  }
  return {
    sql: ["WHERE", clauses.join(" AND ")].join(" "),
    params
  };
}
async function searchPublishedJobs(filter, locale = "id") {
  const normalised = normaliseFilter(filter);
  const { sql: whereSql, params: whereParams } = buildWhereClause(normalised);
  const joinSql = [
    "LEFT JOIN job_posting_translations t_active",
    "ON t_active.job_id = j.id AND t_active.locale = ?",
    "LEFT JOIN job_posting_translations t_fallback",
    "ON t_fallback.job_id = j.id AND t_fallback.locale = ?"
  ].join(" ");
  const totalSql = [
    "SELECT COUNT(*) AS n FROM job_postings j",
    whereSql
  ].join(" ");
  const listSql = [
    "SELECT",
    SEARCH_COLUMNS,
    "FROM job_postings j",
    joinSql,
    whereSql,
    "ORDER BY j.published_at DESC, j.id DESC",
    "LIMIT ? OFFSET ?"
  ].join(" ");
  const listParams = [locale, "id", ...whereParams, normalised.pageSize, normalised.offset];
  const [totalRows, rows, facets] = await Promise.all([
    query(totalSql, whereParams),
    query(listSql, listParams),
    getFacets(filter)
  ]);
  const total = Number(totalRows[0]?.n ?? 0);
  return {
    rows: rows.map(rowToSearchResult),
    total,
    facets,
    page: normalised.page,
    pageSize: normalised.pageSize
  };
}
var facetCache = new QuickLRU({
  maxSize: FACET_CACHE_MAX_SIZE,
  maxAge: FACET_CACHE_TTL_MS
});
function buildCacheKey(filter) {
  const sortedLocations = [...filter.locations].sort();
  const sortedDepartments = [...filter.departmentIds].sort((a, b) => a - b);
  const sortedTypes = [...filter.employmentTypes].sort();
  const sortedLevels = [...filter.levels].sort();
  return JSON.stringify({
    k: filter.sanitisedKeyword,
    loc: sortedLocations,
    dep: sortedDepartments,
    emp: sortedTypes,
    lvl: sortedLevels
  });
}
async function getFacets(filter) {
  const normalised = normaliseFilter(filter);
  const cacheKey = buildCacheKey(normalised);
  const cached = facetCache.get(cacheKey);
  if (cached !== void 0) {
    return cached;
  }
  const buildFacetSql = (colExpr) => [
    "SELECT",
    colExpr,
    "AS value, COUNT(*) AS n FROM job_postings j",
    buildWhereClause(normalised).sql,
    "GROUP BY",
    colExpr,
    "ORDER BY n DESC, value ASC"
  ].join(" ");
  const facetParams = buildWhereClause(normalised).params;
  const departmentSql = [
    "SELECT j.department_id AS value, COUNT(*) AS n FROM job_postings j",
    buildWhereClause(normalised).sql,
    "AND j.department_id IS NOT NULL",
    "GROUP BY j.department_id",
    "ORDER BY n DESC, value ASC"
  ].join(" ");
  const [locationRows, departmentRows, employmentTypeRows, levelRows] = await Promise.all([
    query(buildFacetSql("j.location"), facetParams),
    query(departmentSql, facetParams),
    query(
      buildFacetSql("j.employment_type"),
      facetParams
    ),
    query(buildFacetSql("j.level"), facetParams)
  ]);
  const facets = {
    location: locationRows.map((r) => ({
      value: r.value,
      count: Number(r.n)
    })),
    department_id: departmentRows.map((r) => ({
      value: toNumberOrNull5(r.value) ?? 0,
      count: Number(r.n)
    })).filter((b) => b.value > 0),
    employment_type: employmentTypeRows.map((r) => ({
      value: r.value,
      count: Number(r.n)
    })),
    level: levelRows.map((r) => ({
      value: r.value,
      count: Number(r.n)
    }))
  };
  facetCache.set(cacheKey, facets);
  return facets;
}

// src/routes/public.ts
var SUPPORTED_LOCALES7 = /* @__PURE__ */ new Set(["id", "en"]);
var DEFAULT_LOCALE5 = "id";
var FEATURED_JOBS_LIMIT = 6;
function getRoot(_request, reply) {
  return reply.code(302).header("location", `/${DEFAULT_LOCALE5}/`).send();
}
async function getLanding(app, request, reply) {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES7.has(locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  let featured = [];
  try {
    const result = await list({
      status: ["Published"],
      pageSize: FEATURED_JOBS_LIMIT
    });
    featured = result.rows;
  } catch (err) {
    app.log.warn(
      { err },
      "public.landing: featured jobs query failed; rendering empty strip"
    );
  }
  const html = app.view("public/landing.njk", {
    locale,
    featured,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getAbout(app, request, reply) {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES7.has(locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const html = app.view("public/about.njk", {
    locale,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
function isHtmxRequest2(request) {
  const raw = request.headers["hx-request"];
  if (typeof raw !== "string") return false;
  return raw.toLowerCase() === "true";
}
function pickTranslation(job, locale) {
  if (job.translations[locale] !== void 0 && job.translations[locale] !== null) {
    return { translation: job.translations[locale], translationLocale: locale };
  }
  if (job.translations.id !== void 0 && job.translations.id !== null) {
    return { translation: job.translations.id, translationLocale: "id" };
  }
  if (job.translations.en !== void 0 && job.translations.en !== null) {
    return { translation: job.translations.en, translationLocale: "en" };
  }
  return null;
}
function employmentTypeToSchemaOrg(value) {
  switch (value) {
    case "full-time":
      return "FULL_TIME";
    case "part-time":
      return "PART_TIME";
    case "contract":
      return "CONTRACTOR";
    case "internship":
      return "INTERN";
  }
}
function buildJobPostingJsonLd(options) {
  const { job, translation, url } = options;
  const ld = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: translation.title,
    description: translation.description,
    employmentType: employmentTypeToSchemaOrg(job.employment_type),
    hiringOrganization: {
      "@type": "Organization",
      name: "PT Buana Megah"
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.location,
        addressCountry: "ID"
      }
    },
    url
  };
  if (job.published_at !== null) {
    ld.datePosted = job.published_at.toISOString();
  }
  if (job.application_deadline !== null) {
    ld.validThrough = job.application_deadline;
  }
  if (job.salary_min !== null && job.salary_max !== null) {
    ld.baseSalary = {
      "@type": "MonetaryAmount",
      currency: job.salary_currency ?? "IDR",
      value: {
        "@type": "QuantitativeValue",
        minValue: job.salary_min,
        maxValue: job.salary_max,
        unitText: "MONTH"
      }
    };
  }
  return ld;
}
async function getJobsList(app, request, reply) {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES7.has(locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const parsed = searchFilterSchema.safeParse(request.query ?? {});
  const filter = parsed.success ? parsed.data : {};
  let result;
  try {
    result = await searchPublishedJobs(filter, locale);
  } catch (err) {
    app.log.error(
      { err, locale },
      "public.jobsList: search query failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  const totalPages = Math.max(
    1,
    Math.ceil(result.total / result.pageSize)
  );
  const context = {
    locale,
    filter,
    keyword: typeof filter.keyword === "string" ? filter.keyword : "",
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
    cspNonce: request.cspNonce
  };
  if (isHtmxRequest2(request)) {
    const partial = app.view("public/_jobs-list.njk", context);
    return reply.code(200).type("text/html; charset=utf-8").send(partial);
  }
  const html = app.view("public/jobs.njk", context);
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
async function getJobDetail(app, request, reply) {
  const locale = request.params.locale;
  if (!SUPPORTED_LOCALES7.has(locale)) {
    return reply.code(404).send({ error: "unknown_locale" });
  }
  const slug = request.params.slug;
  if (typeof slug !== "string" || slug.length === 0) {
    return reply.code(404).send({ error: "job_not_found" });
  }
  let job;
  try {
    job = await findBySlug(slug);
  } catch (err) {
    app.log.error(
      { err, locale, slug },
      "public.jobDetail: lookup failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  }
  if (job === null || job.status !== "Published") {
    return reply.code(404).send({ error: "job_not_found" });
  }
  const picked = pickTranslation(job, locale);
  if (picked === null) {
    app.log.warn(
      { slug, status: job.status },
      "public.jobDetail: published job has no translation"
    );
    return reply.code(404).send({ error: "job_not_found" });
  }
  const { translation, translationLocale } = picked;
  const baseUrl = (() => {
    const raw = process.env.BASE_URL;
    if (typeof raw === "string" && raw.length > 0) {
      return raw.endsWith("/") ? raw.slice(0, -1) : raw;
    }
    const proto = request.headers["x-forwarded-proto"] ?? "http";
    const host = request.headers.host ?? "localhost";
    return `${proto}://${host}`;
  })();
  const canonicalUrl = `${baseUrl}/${locale}/jobs/${encodeURIComponent(slug)}`;
  const jsonLd = buildJobPostingJsonLd({ job, translation, url: canonicalUrl });
  const jsonLdString = JSON.stringify(jsonLd);
  const html = app.view("public/job-detail.njk", {
    locale,
    job,
    translation,
    translationLocale,
    jsonLd,
    jsonLdString,
    canonicalUrl,
    applyUrl: `/${locale}/jobs/${encodeURIComponent(slug)}/apply`,
    cspNonce: request.cspNonce
  });
  return reply.code(200).type("text/html; charset=utf-8").send(html);
}
var publicRoutes = async (app) => {
  app.get("/", (request, reply) => getRoot(request, reply));
  app.get(
    "/:locale/",
    (request, reply) => getLanding(app, request, reply)
  );
  app.get(
    "/:locale/about",
    (request, reply) => getAbout(app, request, reply)
  );
  app.get(
    "/:locale/jobs",
    (request, reply) => getJobsList(app, request, reply)
  );
  app.get(
    "/:locale/jobs/:slug",
    (request, reply) => getJobDetail(app, request, reply)
  );
};
var public_default = publicRoutes;

// src/routes/seo.ts
var LOCALES = ["id", "en"];
var SITEMAP_CACHE_TTL_MS = 5 * 60 * 1e3;
var ROBOTS_CACHE_TTL_MS = 60 * 60 * 1e3;
var SITEMAP_CACHE_CONTROL = "public, max-age=300";
var ROBOTS_CACHE_CONTROL = "public, max-age=3600";
var SITEMAP_JOB_CAP = 5e3;
var STATIC_URLS = [
  { path: "/", priority: "0.5", changefreq: "monthly" },
  { path: "/id/", priority: "0.8", changefreq: "weekly" },
  { path: "/en/", priority: "0.8", changefreq: "weekly" },
  { path: "/id/jobs", priority: "0.8", changefreq: "daily" },
  { path: "/en/jobs", priority: "0.8", changefreq: "daily" },
  { path: "/id/about", priority: "0.5", changefreq: "monthly" },
  { path: "/en/about", priority: "0.5", changefreq: "monthly" }
];
var sitemapCache = null;
var robotsCache = null;
function resolveBaseUrl2() {
  const raw = process.env.BASE_URL ?? "http://localhost:3000";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}
function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function toIsoTimestamp(value) {
  if (value === null || value === void 0) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
async function fetchPublishedJobs() {
  return query(
    [
      "SELECT slug, updated_at",
      "FROM job_postings",
      "WHERE status = 'Published'",
      "ORDER BY updated_at DESC",
      "LIMIT ?"
    ].join(" "),
    [SITEMAP_JOB_CAP]
  );
}
function renderUrlEntry(loc, options = {}) {
  const parts = ["  <url>", `    <loc>${escapeXml(loc)}</loc>`];
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
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}" />`
      );
    }
  }
  parts.push("  </url>");
  return parts.join("\n");
}
function renderStaticSitemap(baseUrl) {
  const entries = STATIC_URLS.map(
    (spec) => renderUrlEntry(`${baseUrl}${spec.path}`, {
      changefreq: spec.changefreq,
      priority: spec.priority
    })
  );
  return wrapUrlset(entries);
}
function wrapUrlset(urlEntries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urlEntries,
    "</urlset>",
    ""
  ].join("\n");
}
async function generateSitemapBody(baseUrl) {
  const entries = STATIC_URLS.map(
    (spec) => renderUrlEntry(`${baseUrl}${spec.path}`, {
      changefreq: spec.changefreq,
      priority: spec.priority
    })
  );
  const rows = await fetchPublishedJobs();
  for (const row of rows) {
    const lastmod = toIsoTimestamp(row.updated_at);
    const localeHrefs = {
      id: `${baseUrl}/id/jobs/${row.slug}`,
      en: `${baseUrl}/en/jobs/${row.slug}`
    };
    const alternates = [
      { hreflang: "id", href: localeHrefs.id },
      { hreflang: "en", href: localeHrefs.en },
      { hreflang: "x-default", href: localeHrefs.id }
    ];
    for (const locale of LOCALES) {
      entries.push(
        renderUrlEntry(localeHrefs[locale], {
          lastmod,
          changefreq: "weekly",
          priority: "0.7",
          alternates
        })
      );
    }
  }
  return wrapUrlset(entries);
}
async function getSitemapBody(app, now = Date.now()) {
  if (sitemapCache !== null && now - sitemapCache.generatedAt < SITEMAP_CACHE_TTL_MS) {
    return sitemapCache.body;
  }
  const baseUrl = resolveBaseUrl2();
  try {
    const body = await generateSitemapBody(baseUrl);
    sitemapCache = { body, generatedAt: now };
    return body;
  } catch (err) {
    app.log.warn({ err }, "seo.sitemap: query failed, serving static fallback");
    const body = renderStaticSitemap(baseUrl);
    sitemapCache = { body, generatedAt: now - SITEMAP_CACHE_TTL_MS + 1e4 };
    return body;
  }
}
function renderRobotsBody(baseUrl) {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api",
    "Disallow: /applicant",
    "Disallow: /me",
    "",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    ""
  ];
  return lines.join("\n");
}
function getRobotsBody(now = Date.now()) {
  if (robotsCache !== null && now - robotsCache.generatedAt < ROBOTS_CACHE_TTL_MS) {
    return robotsCache.body;
  }
  const body = renderRobotsBody(resolveBaseUrl2());
  robotsCache = { body, generatedAt: now };
  return body;
}
async function handleSitemap(app, _request, reply) {
  const body = await getSitemapBody(app);
  return reply.code(200).header("content-type", "application/xml; charset=utf-8").header("cache-control", SITEMAP_CACHE_CONTROL).send(body);
}
function handleRobots(_request, reply) {
  const body = getRobotsBody();
  return reply.code(200).header("content-type", "text/plain; charset=utf-8").header("cache-control", ROBOTS_CACHE_CONTROL).send(body);
}
var seoRoutes = async (app) => {
  app.get("/sitemap.xml", (request, reply) => handleSitemap(app, request, reply));
  app.get("/robots.txt", (request, reply) => handleRobots(request, reply));
};
var seo_default = seoRoutes;

// src/server.ts
var projectSrcDir = path5.dirname(fileURLToPath3(import.meta.url));
var viewsDir = path5.join(projectSrcDir, "views");
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const portRaw = env.PORT ?? "3000";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT environment variable: ${portRaw}`);
  }
  return {
    nodeEnv,
    port,
    host: env.HOST ?? "0.0.0.0",
    baseUrl: env.BASE_URL ?? `http://localhost:${port}`,
    databaseUrl: env.DATABASE_URL ?? "",
    sessionSecret: env.SESSION_SECRET ?? "",
    logLevel: env.LOG_LEVEL ?? "info"
  };
}
function registerViewEngine(app) {
  const env = nunjucks3.configure(viewsDir, {
    autoescape: true,
    noCache: process.env.NODE_ENV !== "production",
    throwOnUndefined: false,
    trimBlocks: true,
    lstripBlocks: true
  });
  env.addFilter("t", function(key) {
    const ctx = this.ctx ?? {};
    const locale = ctx["locale"] ?? "id";
    return t(key, locale);
  });
  const render = (name, context = {}) => env.render(name, context);
  app.decorate("view", render);
  app.decorate("viewEnv", env);
}
async function buildApp(config = loadConfig()) {
  const fastifyLogger = logger.child({}, { serializers: requestSerializers });
  const app = Fastify({
    logger: fastifyLogger,
    genReqId,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024
    // 5 MB
  });
  await registerSecurityHeaders(app);
  await app.register(cookie, {
    secret: config.sessionSecret || void 0,
    parseOptions: {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/"
    }
  });
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
      // Defensive: keep field counts low so a malicious form cannot
      // burn memory before busboy aborts. The CV form only carries
      // `_csrf` plus the file part.
      fields: 4,
      fieldSize: 1024,
      headerPairs: 32
    }
  });
  registerViewEngine(app);
  app.addHook("onRequest", async (request) => {
    request.startTime = Date.now();
  });
  app.addHook("onResponse", async (request, reply) => {
    const routeOptions = request.routeOptions;
    const route = routeOptions?.url ?? request.url;
    app.log.info({
      req_id: request.id,
      method: request.method,
      route,
      status: reply.statusCode,
      latency_ms: Date.now() - (request.startTime ?? 0),
      user_id: request.session?.userId ?? null,
      ip: request.ip,
      ua: request.headers["user-agent"] ?? null
    }, "request completed");
  });
  app.setErrorHandler(async (error, request, reply) => {
    app.log.error({
      req_id: request.id,
      err: {
        message: error.message,
        stack: error.stack
      }
    }, "unhandled error");
    if (reply.sent) return;
    let body;
    try {
      body = app.view("errors/500.njk");
    } catch {
      body = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
<title>500 \u2013 Terjadi Kesalahan</title></head><body>
<h1>500</h1><p>An unexpected error occurred. Please try again.</p>
</body></html>`;
    }
    await reply.code(500).header("Content-Type", "text/html; charset=utf-8").send(body);
  });
  app.get("/healthz", async (_request, reply) => {
    try {
      await pool.query({ sql: "SELECT 1", timeout: 1e3 });
      return reply.code(200).send({ status: "ok" });
    } catch (err) {
      app.log.warn({ err }, "healthz: db unreachable");
      return reply.code(503).send({ status: "db_unreachable" });
    }
  });
  await app.register(password_default);
  await app.register(public_default);
  await app.register(authRoutes);
  await app.register(applicant_default);
  await app.register(admin_default);
  await app.register(seo_default);
  return app;
}
async function main() {
  checkRequiredEnvVars();
  const config = loadConfig();
  const app = await buildApp(config);
  const shutdown = async (signal) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await pool.end();
    } catch (err) {
      app.log.error({ err }, "shutdown error");
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error({ err }, "failed to start http server");
    process.exit(1);
  }
}
if (process.env.NODE_ENV !== "test") {
  void main();
}
export {
  buildApp,
  loadConfig
};
//# sourceMappingURL=index.mjs.map
