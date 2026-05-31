var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/infra/logger.ts
import { pino } from "pino";
import { ulid } from "ulid";
var isProduction, loggerOptions, logger;
var init_logger = __esm({
  "src/infra/logger.ts"() {
    "use strict";
    isProduction = process.env.NODE_ENV === "production";
    loggerOptions = {
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
    logger = pino(loggerOptions);
  }
});

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
async function closePool() {
  await pool.end();
}
var POOL_OPTIONS, pool;
var init_db = __esm({
  "src/infra/db.ts"() {
    "use strict";
    POOL_OPTIONS = {
      connectionLimit: 10,
      queueLimit: 50,
      waitForConnections: true,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      namedPlaceholders: true,
      timezone: "Z",
      decimalNumbers: true
    };
    pool = mysql.createPool({
      uri: resolveDatabaseUrl(),
      ...POOL_OPTIONS
    });
  }
});

// src/modules/jobs/state-machine.ts
var ALLOWED_TRANSITIONS;
var init_state_machine = __esm({
  "src/modules/jobs/state-machine.ts"() {
    "use strict";
    ALLOWED_TRANSITIONS = Object.freeze({
      Draft: /* @__PURE__ */ new Set(["Published", "Archived"]),
      Published: /* @__PURE__ */ new Set(["Closed", "Archived"]),
      Closed: /* @__PURE__ */ new Set(["Archived"]),
      Archived: /* @__PURE__ */ new Set()
    });
  }
});

// src/modules/jobs/repo.ts
var EMPLOYMENT_TYPES, JOB_LEVELS, JOB_COLUMNS, SELECT_JOB_BY_ID_SQL, SELECT_JOB_BY_SLUG_SQL;
var init_repo = __esm({
  "src/modules/jobs/repo.ts"() {
    "use strict";
    init_db();
    init_logger();
    init_state_machine();
    EMPLOYMENT_TYPES = [
      "full-time",
      "part-time",
      "contract",
      "internship"
    ];
    JOB_LEVELS = [
      "entry",
      "junior",
      "mid",
      "senior",
      "lead",
      "manager",
      "director"
    ];
    JOB_COLUMNS = "id, uuid, slug, department_id, location, employment_type, level, status, salary_min, salary_max, salary_currency, application_deadline, published_at, created_by, created_at, updated_at";
    SELECT_JOB_BY_ID_SQL = [
      "SELECT",
      JOB_COLUMNS,
      "FROM job_postings WHERE id = ? LIMIT 1"
    ].join(" ");
    SELECT_JOB_BY_SLUG_SQL = [
      "SELECT",
      JOB_COLUMNS,
      "FROM job_postings WHERE slug = ? LIMIT 1"
    ].join(" ");
  }
});

// src/modules/jobs/search.ts
var search_exports = {};
__export(search_exports, {
  DEFAULT_PAGE_SIZE: () => DEFAULT_PAGE_SIZE,
  FACET_CACHE_MAX_SIZE: () => FACET_CACHE_MAX_SIZE,
  FACET_CACHE_TTL_MS: () => FACET_CACHE_TTL_MS,
  MAX_OFFSET: () => MAX_OFFSET,
  MAX_PAGE_SIZE: () => MAX_PAGE_SIZE,
  clearSearchCache: () => clearSearchCache,
  getFacets: () => getFacets,
  sanitizeKeyword: () => sanitizeKeyword,
  searchFilterSchema: () => searchFilterSchema,
  searchPublishedJobs: () => searchPublishedJobs
});
import { z } from "zod";
import QuickLRU from "quick-lru";
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
function placeholders(n) {
  if (n <= 0) return "";
  return Array.from({ length: n }, () => "?").join(", ");
}
function toNumberOrNull(value) {
  if (value === null || value === void 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function toDate(value) {
  if (value === null || value === void 0) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function dateToIsoYmd(value) {
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
    department_id: toNumberOrNull(row.department_id),
    published_at: toDate(row.published_at),
    application_deadline: dateToIsoYmd(row.application_deadline)
  };
}
function normaliseFilter(filter) {
  const rawKeyword = (filter.keyword ?? "").trim();
  const sanitised = sanitizeKeyword(rawKeyword);
  const pageSizeRaw = filter.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(
    Math.max(1, Math.floor(pageSizeRaw)),
    MAX_PAGE_SIZE
  );
  const pageRaw = filter.page ?? 0;
  const page = Math.max(0, Math.floor(pageRaw));
  const offset = Math.min(page * pageSize, MAX_OFFSET);
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
    clauses.push("j.location IN (" + placeholders(filter.locations.length) + ")");
    for (const v of filter.locations) params.push(v);
  }
  if (excludeFacet !== "department_id" && filter.departmentIds.length > 0) {
    clauses.push(
      "j.department_id IN (" + placeholders(filter.departmentIds.length) + ")"
    );
    for (const v of filter.departmentIds) params.push(v);
  }
  if (excludeFacet !== "employment_type" && filter.employmentTypes.length > 0) {
    clauses.push(
      "j.employment_type IN (" + placeholders(filter.employmentTypes.length) + ")"
    );
    for (const v of filter.employmentTypes) params.push(v);
  }
  if (excludeFacet !== "level" && filter.levels.length > 0) {
    clauses.push("j.level IN (" + placeholders(filter.levels.length) + ")");
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
      value: toNumberOrNull(r.value) ?? 0,
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
function clearSearchCache() {
  facetCache.clear();
}
var DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_OFFSET, NGRAM_TOKEN_SIZE, MIN_PREFIX_TOKEN_LENGTH, FACET_CACHE_TTL_MS, FACET_CACHE_MAX_SIZE, BOOLEAN_MODE_STRIP_REGEX, csvOrArrayString, employmentTypeArray, levelArray, departmentIdArray, positiveInt, searchFilterSchema, VISIBILITY_PREDICATE, SEARCH_COLUMNS, facetCache;
var init_search = __esm({
  "src/modules/jobs/search.ts"() {
    "use strict";
    init_db();
    init_repo();
    DEFAULT_PAGE_SIZE = 20;
    MAX_PAGE_SIZE = 50;
    MAX_OFFSET = 200;
    NGRAM_TOKEN_SIZE = 2;
    MIN_PREFIX_TOKEN_LENGTH = 3;
    FACET_CACHE_TTL_MS = 6e4;
    FACET_CACHE_MAX_SIZE = 200;
    BOOLEAN_MODE_STRIP_REGEX = /[+\-><()~*"@`]/g;
    csvOrArrayString = z.union([z.string(), z.array(z.string())]).optional().transform((value) => {
      if (value === void 0) return void 0;
      const parts = Array.isArray(value) ? value : value.split(",");
      const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 0);
      return cleaned.length > 0 ? cleaned : void 0;
    });
    employmentTypeArray = csvOrArrayString.pipe(
      z.array(z.enum(EMPLOYMENT_TYPES)).optional()
    );
    levelArray = csvOrArrayString.pipe(
      z.array(z.enum(JOB_LEVELS)).optional()
    );
    departmentIdArray = z.union([z.string(), z.array(z.string()), z.number(), z.array(z.number())]).optional().transform((value) => {
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
    positiveInt = z.union([z.string(), z.number()]).optional().transform((value) => {
      if (value === void 0) return void 0;
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return void 0;
      return n;
    });
    searchFilterSchema = z.object({
      keyword: z.string().optional(),
      location: csvOrArrayString,
      department_id: departmentIdArray,
      employment_type: employmentTypeArray,
      level: levelArray,
      page: positiveInt,
      pageSize: positiveInt
    });
    VISIBILITY_PREDICATE = "j.status = 'Published' AND (j.application_deadline IS NULL OR j.application_deadline >= CURRENT_DATE())";
    SEARCH_COLUMNS = [
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
    facetCache = new QuickLRU({
      maxSize: FACET_CACHE_MAX_SIZE,
      maxAge: FACET_CACHE_TTL_MS
    });
  }
});

// src/crons/index.ts
init_logger();
init_db();
import { pathToFileURL } from "node:url";
import { Command } from "commander";

// src/infra/cron-lock.ts
init_db();
init_logger();
var DEFAULT_TIMEOUT_MS = 55e3;
var DEFAULT_HEARTBEAT_MS = 1e4;
var DEFAULT_STALE_MS = 9e4;
var LAST_ERROR_MAX_LEN = 500;
var ACQUIRE_SQL = `
  INSERT INTO cron_locks (name, locked_at, heartbeat_at)
  VALUES (?, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    locked_at = IF(heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL ? SECOND, NOW(), locked_at),
    heartbeat_at = IF(heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL ? SECOND, NOW(), heartbeat_at)
`;
var SELECT_LOCK_SQL = `SELECT locked_at, heartbeat_at FROM cron_locks WHERE name = ?`;
var HEARTBEAT_SQL = `UPDATE cron_locks SET heartbeat_at = NOW() WHERE name = ? AND locked_at = ?`;
var RELEASE_OK_SQL = `
  UPDATE cron_locks
  SET locked_at = NULL,
      heartbeat_at = NULL,
      last_run_at = NOW(),
      last_status = 'ok',
      last_error = NULL
  WHERE name = ? AND locked_at = ?
`;
var RELEASE_ERR_SQL = `
  UPDATE cron_locks
  SET locked_at = NULL,
      heartbeat_at = NULL,
      last_run_at = NOW(),
      last_status = 'error',
      last_error = ?
  WHERE name = ? AND locked_at = ?
`;
async function tryAcquire(name, staleAfterMs) {
  const staleSeconds = Math.max(1, Math.floor(staleAfterMs / 1e3));
  const result = await query(ACQUIRE_SQL, [
    name,
    staleSeconds,
    staleSeconds
  ]);
  if (result.affectedRows === 0) {
    return null;
  }
  const rows = await query(SELECT_LOCK_SQL, [name]);
  const row = rows[0];
  if (!row || !row.locked_at) {
    return null;
  }
  return row.locked_at;
}
function truncateError(message) {
  return message.length > LAST_ERROR_MAX_LEN ? message.slice(0, LAST_ERROR_MAX_LEN) : message;
}
async function recordFailureAndRelease(name, lockedAt, message) {
  try {
    await query(RELEASE_ERR_SQL, [
      truncateError(message),
      name,
      lockedAt
    ]);
  } catch (releaseErr) {
    logger.error(
      {
        cron: name,
        err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
      },
      "failed to record cron error and release lock"
    );
  }
}
async function recordSuccessAndRelease(name, lockedAt) {
  try {
    await query(RELEASE_OK_SQL, [name, lockedAt]);
  } catch (releaseErr) {
    logger.error(
      {
        cron: name,
        err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
      },
      "failed to release cron lock after success"
    );
  }
}
async function runWithLock(name, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
  const lockedAt = await tryAcquire(name, staleAfterMs);
  if (!lockedAt) {
    logger.info({ cron: name }, "lock not acquired");
    return null;
  }
  logger.info(
    { cron: name, locked_at: lockedAt.toISOString(), timeout_ms: timeoutMs },
    "cron lock acquired"
  );
  const heartbeat = setInterval(() => {
    void query(HEARTBEAT_SQL, [name, lockedAt]).catch(
      (err) => {
        logger.warn(
          { cron: name, err: err instanceof Error ? err.message : String(err) },
          "cron heartbeat failed"
        );
      }
    );
  }, heartbeatIntervalMs);
  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }
  let timeoutHandle;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`cron task '${name}' exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
    if (typeof timeoutHandle.unref === "function") {
      timeoutHandle.unref();
    }
  });
  const fnPromise = fn();
  fnPromise.catch(() => {
  });
  let result;
  try {
    result = await Promise.race([fnPromise, timeoutPromise]);
  } catch (err) {
    clearInterval(heartbeat);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : String(err);
    await recordFailureAndRelease(name, lockedAt, message);
    logger.error({ cron: name, err: message }, "cron task failed");
    throw err;
  }
  clearInterval(heartbeat);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  await recordSuccessAndRelease(name, lockedAt);
  logger.info({ cron: name }, "cron task completed");
  return result;
}

// src/crons/mail-flush.ts
init_db();
init_logger();

// src/modules/mail/state-machine.ts
var ALLOWED_MAIL_TRANSITIONS = Object.freeze({
  pending: /* @__PURE__ */ new Set(["sending"]),
  sending: /* @__PURE__ */ new Set(["sent", "pending", "failed"]),
  sent: /* @__PURE__ */ new Set(),
  failed: /* @__PURE__ */ new Set()
});
var MAIL_BACKOFF_SECONDS = Object.freeze([
  60,
  // 1 minute  — 1st failure
  300,
  // 5 minutes — 2nd failure
  900,
  // 15 minutes — 3rd failure
  3600,
  // 1 hour    — 4th failure
  21600
  // 6 hours   — defensive cap (see MAX_MAIL_FAILURES below)
]);
var MAX_MAIL_FAILURES = 5;
function isTerminalFailure(newRetryCount) {
  return newRetryCount >= MAX_MAIL_FAILURES;
}
function backoffSecondsForFailure(newRetryCount) {
  const lastIndex = MAIL_BACKOFF_SECONDS.length - 1;
  const index = Math.min(Math.max(newRetryCount - 1, 0), lastIndex);
  return MAIL_BACKOFF_SECONDS[index] ?? 21600;
}

// src/modules/mail/sender.ts
import { createTransport } from "nodemailer";
var cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter !== null) {
    return cachedTransporter;
  }
  const host = process.env.SMTP_HOST ?? "";
  const port = Number.parseInt(process.env.SMTP_PORT ?? "587", 10);
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";
  cachedTransporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: user !== "" ? { user, pass } : void 0
  });
  return cachedTransporter;
}
function resolveFrom() {
  const from = process.env.MAIL_FROM ?? process.env.SMTP_USER ?? "";
  return from;
}
function formatRecipient(toEmail, toName) {
  const name = (toName ?? "").trim();
  if (name === "") return toEmail;
  return `"${name.replace(/"/g, "")}" <${toEmail}>`;
}
async function sendMail(message) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: resolveFrom(),
    to: formatRecipient(message.toEmail, message.toName),
    subject: message.subject,
    html: message.bodyHtml,
    text: message.bodyText ?? void 0
  });
}

// src/crons/mail-flush.ts
var log = logger.child({ cron: "mail-flush" });
var BATCH_LIMIT = 200;
var LAST_ERROR_MAX_LEN2 = 500;
var SELECT_BATCH_SQL = [
  "SELECT id, to_email, to_name, subject, body_html, body_text, retry_count",
  "FROM mail_outbox",
  "WHERE status = 'pending' AND next_attempt_at <= NOW()",
  "ORDER BY id",
  `LIMIT ${BATCH_LIMIT}`
].join(" ");
var CLAIM_ROW_SQL = [
  "UPDATE mail_outbox",
  "SET status = 'sending'",
  "WHERE id = ? AND status = 'pending'"
].join(" ");
var MARK_SENT_SQL = [
  "UPDATE mail_outbox",
  "SET status = 'sent', sent_at = NOW()",
  "WHERE id = ?"
].join(" ");
var RETRY_ROW_SQL = [
  "UPDATE mail_outbox",
  "SET status = 'pending',",
  "    retry_count = ?,",
  "    next_attempt_at = NOW() + INTERVAL ? SECOND,",
  "    last_error = ?",
  "WHERE id = ?"
].join(" ");
var MARK_FAILED_SQL = [
  "UPDATE mail_outbox",
  "SET status = 'failed', retry_count = ?, last_error = ?",
  "WHERE id = ?"
].join(" ");
function toLastError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > LAST_ERROR_MAX_LEN2 ? message.slice(0, LAST_ERROR_MAX_LEN2) : message;
}
function toOutgoingMessage(row) {
  return {
    toEmail: row.to_email,
    toName: row.to_name,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text
  };
}
async function claimRow(id) {
  const result = await query(CLAIM_ROW_SQL, [id]);
  return (result.affectedRows ?? 0) === 1;
}
async function handleFailure(row, err) {
  const id = Number(row.id);
  const newRetryCount = Number(row.retry_count) + 1;
  const lastError = toLastError(err);
  if (isTerminalFailure(newRetryCount)) {
    await query(MARK_FAILED_SQL, [
      newRetryCount,
      lastError,
      id
    ]);
    log.error(
      {
        event: "mail_permanently_failed",
        mail_id: id,
        to_email: row.to_email,
        retry_count: newRetryCount,
        last_error: lastError
      },
      "mail-flush: delivery permanently failed after max retries"
    );
    return "failed";
  }
  const backoff = backoffSecondsForFailure(newRetryCount);
  await query(RETRY_ROW_SQL, [
    newRetryCount,
    backoff,
    lastError,
    id
  ]);
  return "retried";
}
async function processRow(row, counters) {
  const id = Number(row.id);
  const claimed = await claimRow(id);
  if (!claimed) {
    counters.skipped += 1;
    log.debug(
      { event: "mail_claim_skipped", mail_id: id },
      "mail-flush: row already claimed by another run"
    );
    return;
  }
  let sendError;
  let sendFailed = false;
  try {
    await sendMail(toOutgoingMessage(row));
  } catch (err) {
    sendFailed = true;
    sendError = err;
  }
  if (!sendFailed) {
    await query(MARK_SENT_SQL, [id]);
    counters.sent += 1;
    return;
  }
  const outcome = await handleFailure(row, sendError);
  if (outcome === "retried") counters.retried += 1;
  else counters.failed += 1;
}
async function mailFlush() {
  const startedAt = Date.now();
  const counters = {
    selected: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0
  };
  const rows = await query(SELECT_BATCH_SQL);
  counters.selected = rows.length;
  for (const row of rows) {
    try {
      await processRow(row, counters);
    } catch (err) {
      log.error(
        {
          event: "mail_row_error",
          mail_id: Number(row.id),
          error: toLastError(err)
        },
        "mail-flush: unexpected per-row error"
      );
    }
  }
  log.info(
    {
      event: "mail_flush_done",
      selected: counters.selected,
      sent: counters.sent,
      retried: counters.retried,
      failed: counters.failed,
      skipped: counters.skipped,
      duration_ms: Date.now() - startedAt
    },
    "mail-flush: completed"
  );
}

// src/crons/alert-digest.ts
init_logger();
init_db();

// src/modules/mail/service.ts
init_logger();
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
var EMAILS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
    return await readFile(path.join(EMAILS_DIR, fileName), "utf8");
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

// src/modules/alerts/digest-repo.ts
init_db();
init_search();
var MAX_ALERTS_PER_RUN = 500;
var MAX_JOBS_PER_DIGEST = 50;
var EPOCH = /* @__PURE__ */ new Date(0);
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
function toDateOrNull(value) {
  if (value === null || value === void 0) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
function toNumberOrNull2(value) {
  if (value === null || value === void 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function toLocale(value) {
  return value === "en" ? "en" : "id";
}
function placeholders2(n) {
  if (n <= 0) return "";
  return Array.from({ length: n }, () => "?").join(", ");
}
function rowToDueAlert(row) {
  return {
    id: Number(row.id),
    applicantUserId: Number(row.applicant_user_id),
    keyword: row.keyword ?? null,
    locations: parseLocations(row.locations),
    departments: parseDepartments(row.departments),
    frequency: row.frequency,
    lastEvaluatedAt: toDateOrNull(row.last_evaluated_at),
    applicantEmail: row.applicant_email,
    applicantName: row.applicant_name,
    locale: toLocale(row.language_pref)
  };
}
function rowToMatchingJob(row) {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title ?? null,
    location: row.location,
    departmentId: toNumberOrNull2(row.department_id),
    publishedAt: toDateOrNull(row.published_at)
  };
}
var SELECT_DUE_ALERTS_SQL = [
  "SELECT",
  "  ja.id, ja.applicant_user_id, ja.keyword, ja.locations, ja.departments,",
  "  ja.frequency, ja.last_evaluated_at,",
  "  u.email AS applicant_email, a.full_name AS applicant_name, a.language_pref",
  "FROM job_alerts ja",
  "JOIN users u ON u.id = ja.applicant_user_id",
  "JOIN applicants a ON a.user_id = ja.applicant_user_id",
  "WHERE (",
  "  ja.last_evaluated_at IS NULL",
  "  OR (ja.frequency = 'Daily'  AND ja.last_evaluated_at < NOW() - INTERVAL 1 DAY)",
  "  OR (ja.frequency = 'Weekly' AND ja.last_evaluated_at < NOW() - INTERVAL 7 DAY)",
  ")",
  "ORDER BY ja.id",
  `LIMIT ${MAX_ALERTS_PER_RUN}`
].join(" ");
var MARK_EVALUATED_SQL = [
  "UPDATE job_alerts",
  "SET last_evaluated_at = NOW()",
  "WHERE id = ?"
].join(" ");
var JOB_VISIBILITY_CLAUSES = [
  "j.status = 'Published'",
  "(j.application_deadline IS NULL OR j.application_deadline >= CURRENT_DATE())",
  "j.published_at IS NOT NULL"
];
async function listDueForDigest() {
  const rows = await query(SELECT_DUE_ALERTS_SQL);
  return rows.map(rowToDueAlert);
}
async function findMatchingJobs(alert, since, limit = MAX_JOBS_PER_DIGEST) {
  const clauses = [...JOB_VISIBILITY_CLAUSES, "j.published_at > ?"];
  const whereParams = [since];
  const sanitisedKeyword = sanitizeKeyword(alert.keyword ?? "");
  if (sanitisedKeyword !== "") {
    clauses.push("MATCH(j.search_text) AGAINST (? IN BOOLEAN MODE)");
    whereParams.push(sanitisedKeyword);
  }
  if (alert.locations && alert.locations.length > 0) {
    clauses.push("j.location IN (" + placeholders2(alert.locations.length) + ")");
    for (const loc of alert.locations) whereParams.push(loc);
  }
  if (alert.departments && alert.departments.length > 0) {
    clauses.push(
      "j.department_id IN (" + placeholders2(alert.departments.length) + ")"
    );
    for (const id of alert.departments) whereParams.push(id);
  }
  const sql = [
    "SELECT",
    "  j.id, j.slug, j.location, j.department_id, j.published_at,",
    "  COALESCE(tl.title, ti.title, te.title) AS title",
    "FROM job_postings j",
    "LEFT JOIN job_posting_translations tl ON tl.job_id = j.id AND tl.locale = ?",
    "LEFT JOIN job_posting_translations ti ON ti.job_id = j.id AND ti.locale = 'id'",
    "LEFT JOIN job_posting_translations te ON te.job_id = j.id AND te.locale = 'en'",
    "WHERE",
    clauses.join(" AND "),
    "ORDER BY j.published_at DESC, j.id DESC",
    "LIMIT ?"
  ].join(" ");
  const params = [alert.locale, ...whereParams, limit];
  const rows = await query(sql, params);
  return rows.map(rowToMatchingJob);
}
async function markEvaluated(id, conn) {
  if (conn) {
    const [result2] = await conn.execute(MARK_EVALUATED_SQL, [id]);
    return (result2.affectedRows ?? 0) > 0;
  }
  const result = await query(MARK_EVALUATED_SQL, [id]);
  return (result.affectedRows ?? 0) > 0;
}

// src/crons/alert-digest.ts
var log2 = logger.child({ cron: "alert-digest" });
var DIGEST_TEMPLATE_KEY = "alert_digest";
function resolveBaseUrl() {
  const raw = process.env.BASE_URL ?? "http://localhost:3000";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}
function toMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function toTemplateJobs(jobs, locale) {
  const baseUrl = resolveBaseUrl();
  return jobs.map((j) => ({
    id: j.id,
    slug: j.slug,
    // Fall back to the slug if a job somehow has no translation row, so
    // the email always shows something clickable.
    title: j.title ?? j.slug,
    location: j.location,
    url: `${baseUrl}/${locale}/jobs/${encodeURIComponent(j.slug)}`
  }));
}
async function processAlert(alert) {
  const since = alert.lastEvaluatedAt ?? EPOCH;
  const jobs = await findMatchingJobs(alert, since);
  if (jobs.length === 0) {
    await markEvaluated(alert.id);
    return "no_match";
  }
  await withTransaction(async (conn) => {
    await enqueue(conn, {
      templateKey: DIGEST_TEMPLATE_KEY,
      toEmail: alert.applicantEmail,
      toName: alert.applicantName,
      locale: alert.locale,
      context: {
        alert: {
          id: alert.id,
          keyword: alert.keyword,
          frequency: alert.frequency
        },
        applicant: { name: alert.applicantName },
        jobs: toTemplateJobs(jobs, alert.locale),
        count: jobs.length
      },
      // Digests are intentionally NOT natural-key deduped (migration 0006).
      targetId: null
    });
    await markEvaluated(alert.id, conn);
  });
  return "emailed";
}
async function alertDigest() {
  const startedAt = Date.now();
  const counters = {
    evaluated: 0,
    emailed: 0,
    skippedNoMatch: 0,
    failed: 0
  };
  const alerts = await listDueForDigest();
  for (const alert of alerts) {
    counters.evaluated += 1;
    try {
      const outcome = await processAlert(alert);
      if (outcome === "emailed") counters.emailed += 1;
      else counters.skippedNoMatch += 1;
    } catch (err) {
      counters.failed += 1;
      log2.error(
        {
          event: "alert_digest_error",
          alert_id: alert.id,
          applicant_user_id: alert.applicantUserId,
          error: toMessage(err)
        },
        "alert-digest: per-alert evaluation failed; timestamp retained"
      );
    }
  }
  log2.info(
    {
      event: "alert_digest_done",
      evaluated: counters.evaluated,
      emailed: counters.emailed,
      skipped_no_match: counters.skippedNoMatch,
      failed: counters.failed,
      duration_ms: Date.now() - startedAt
    },
    "alert-digest: completed"
  );
}

// src/crons/backup-daily.ts
init_db();
init_logger();
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";

// src/modules/audit/writer.ts
init_db();
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

// src/crons/backup-daily.ts
var log3 = logger.child({ cron: "backup-daily" });
var BACKUP_DIR = path2.join(os.homedir(), "backups");
var MONTHLY_DIR = path2.join(BACKUP_DIR, "monthly");
var DAILY_RETENTION = 14;
var MONTHLY_RETENTION = 12;
function todayLabel() {
  const d = /* @__PURE__ */ new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return [yyyy, mm, dd].join("-");
}
function todayDayOfMonth() {
  return (/* @__PURE__ */ new Date()).getDate();
}
function parseDbUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, "");
  const port = url.port || "3306";
  if (!host || !user || !database) {
    throw new Error("DATABASE_URL must contain host, user, and database name");
  }
  return { host, user, password, database, port };
}
function spawnCollect(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn(cmd, [...args], {
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(
          new Error(
            [`Process "${cmd}" exited with code ${code}`, stderr].filter(Boolean).join(": ")
          )
        );
      }
    });
  });
}
function spawnPipe(srcCmd, srcArgs, dstCmd, dstArgs, destFile, env) {
  return new Promise((resolve, reject) => {
    const srcErrChunks = [];
    const dstErrChunks = [];
    const src = spawn(srcCmd, [...srcArgs], {
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const dst = spawn(dstCmd, [...dstArgs], {
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    src.stdout.pipe(dst.stdin);
    const out = createWriteStream(destFile, { flags: "w", mode: 384 });
    dst.stdout.pipe(out);
    src.stderr.on("data", (c) => srcErrChunks.push(c));
    dst.stderr.on("data", (c) => dstErrChunks.push(c));
    let srcCode = null;
    let dstCode = null;
    let settled = false;
    function trySettle() {
      if (srcCode === null || dstCode === null) return;
      if (settled) return;
      settled = true;
      out.end();
      if (srcCode !== 0 || dstCode !== 0) {
        const srcErr = Buffer.concat(srcErrChunks).toString("utf8").trim();
        const dstErr = Buffer.concat(dstErrChunks).toString("utf8").trim();
        const parts = [
          srcCode !== 0 ? [`${srcCmd} exited ${srcCode}`, srcErr].filter(Boolean).join(": ") : "",
          dstCode !== 0 ? [`${dstCmd} exited ${dstCode}`, dstErr].filter(Boolean).join(": ") : ""
        ].filter(Boolean);
        reject(new Error(parts.join("; ")));
      } else {
        resolve();
      }
    }
    src.on("error", reject);
    dst.on("error", reject);
    out.on("error", reject);
    src.on("close", (code) => {
      srcCode = code ?? 1;
      trySettle();
    });
    dst.on("close", (code) => {
      dstCode = code ?? 1;
      trySettle();
    });
  });
}
async function dumpDatabase(destFile, creds) {
  log3.info({ destFile }, "backup: starting mysqldump");
  const dumpArgs = [
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--no-tablespaces",
    ["-h", creds.host].join(""),
    ["-P", creds.port].join(""),
    ["-u", creds.user].join(""),
    creds.database
  ];
  const childEnv = {
    ...process.env,
    // Pass password via env var so it never appears in the process list
    MYSQL_PWD: creds.password
  };
  await spawnPipe(
    "mysqldump",
    dumpArgs,
    "gzip",
    ["-9"],
    destFile,
    childEnv
  );
  log3.info({ destFile }, "backup: mysqldump complete");
}
async function archiveFileStore(destFile) {
  log3.info({ destFile }, "backup: starting file_store tar");
  const tarArgs = [
    "--exclude=*.tmp",
    "-czf",
    destFile,
    "-C",
    os.homedir(),
    "file_store"
  ];
  await spawnCollect("tar", tarArgs);
  log3.info({ destFile }, "backup: file_store tar complete");
}
async function verifyGzip(filePath) {
  log3.info({ filePath }, "backup: verifying gzip");
  await spawnCollect("gzip", ["-t", filePath]);
  log3.info({ filePath }, "backup: gzip OK");
}
async function verifyTar(filePath) {
  log3.info({ filePath }, "backup: verifying tar");
  const output = await spawnCollect("tar", ["-tzf", filePath]);
  const firstLine = output.toString("utf8").split("\n")[0] ?? "";
  log3.info({ filePath, firstEntry: firstLine }, "backup: tar OK");
}
async function handleBackupFailure(label, err) {
  const message = err instanceof Error ? err.message : String(err);
  log3.error({ label, err }, "backup: FAILED");
  try {
    const conn = await pool.getConnection();
    try {
      await enqueue(conn, {
        templateKey: "backup_failed",
        toEmail: process.env.ADMIN_ALERT_EMAIL ?? "",
        context: { label, message, date: (/* @__PURE__ */ new Date()).toISOString() }
      });
    } finally {
      conn.release();
    }
  } catch (mailErr) {
    log3.error({ mailErr }, "backup: failed to enqueue alert email");
  }
  try {
    await auditService.write({
      actorUserId: null,
      actorIp: null,
      actionType: "backup_failed",
      targetEntity: "backup",
      targetId: null,
      details: { label, message }
    });
  } catch (auditErr) {
    log3.error({ auditErr }, "backup: failed to write audit event");
  }
}
async function pruneDaily(prefix) {
  let entries;
  try {
    entries = await readdir(BACKUP_DIR);
  } catch {
    return;
  }
  const pattern = new RegExp(["^", prefix, "\\d{4}-\\d{2}-\\d{2}\\."].join(""));
  const matching = entries.filter((f) => pattern.test(f)).sort().reverse();
  const toDelete = matching.slice(DAILY_RETENTION);
  for (const file of toDelete) {
    const filePath = path2.join(BACKUP_DIR, file);
    try {
      await rm(filePath, { force: true });
      log3.info({ file }, "backup: pruned old daily backup");
    } catch (pruneErr) {
      log3.warn({ file, pruneErr }, "backup: failed to prune daily backup");
    }
  }
}
async function handleMonthlyRetention(dbFile, filesFile, label) {
  if (todayDayOfMonth() !== 1) return;
  log3.info({ label }, "backup: 1st of month \u2014 copying to monthly/");
  try {
    await mkdir(MONTHLY_DIR, { recursive: true, mode: 448 });
  } catch (mkdirErr) {
    log3.warn({ mkdirErr }, "backup: failed to create monthly dir");
    return;
  }
  for (const [src, name] of [
    [dbFile, path2.basename(dbFile)],
    [filesFile, path2.basename(filesFile)]
  ]) {
    const dest = path2.join(MONTHLY_DIR, name);
    try {
      await copyFile(src, dest);
      log3.info({ dest }, "backup: copied to monthly");
    } catch (copyErr) {
      log3.warn({ src, dest, copyErr }, "backup: failed to copy to monthly");
    }
  }
  let monthlyEntries;
  try {
    monthlyEntries = await readdir(MONTHLY_DIR);
  } catch {
    return;
  }
  const cutoff = /* @__PURE__ */ new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHLY_RETENTION);
  for (const file of monthlyEntries) {
    const filePath = path2.join(MONTHLY_DIR, file);
    try {
      const s = await stat(filePath);
      if (s.mtimeMs < cutoff.getTime()) {
        await rm(filePath, { force: true });
        log3.info({ file }, "backup: pruned old monthly backup");
      }
    } catch (pruneErr) {
      log3.warn({ file, pruneErr }, "backup: failed to check/prune monthly backup");
    }
  }
}
async function backupDaily() {
  const label = todayLabel();
  const dbFile = path2.join(BACKUP_DIR, ["db-", label, ".sql.gz"].join(""));
  const filesFile = path2.join(BACKUP_DIR, ["files-", label, ".tar.gz"].join(""));
  await mkdir(BACKUP_DIR, { recursive: true, mode: 448 });
  const rawUrl = process.env.DATABASE_URL ?? "";
  let creds;
  try {
    creds = parseDbUrl(rawUrl);
  } catch (err) {
    await handleBackupFailure(label, err);
    throw err;
  }
  try {
    await dumpDatabase(dbFile, creds);
  } catch (err) {
    await handleBackupFailure(label, err);
    throw err;
  }
  try {
    await archiveFileStore(filesFile);
  } catch (err) {
    await handleBackupFailure(label, err);
    throw err;
  }
  try {
    await verifyGzip(dbFile);
  } catch (err) {
    await handleBackupFailure(["db-verify-", label].join(""), err);
    throw err;
  }
  try {
    await verifyTar(filesFile);
  } catch (err) {
    await handleBackupFailure(["files-verify-", label].join(""), err);
    throw err;
  }
  log3.info({ label, dbFile, filesFile }, "backup: verification passed");
  await pruneDaily("db-");
  await pruneDaily("files-");
  await handleMonthlyRetention(dbFile, filesFile, label);
  log3.info({ label }, "backup: daily backup complete");
}

// src/crons/session-gc.ts
init_logger();
init_db();
var log4 = logger.child({ cron: "session-gc" });
var DELETE_EXPIRED_SESSIONS_SQL = "DELETE FROM sessions WHERE expires_at < NOW()    OR last_active_at < NOW() - INTERVAL 30 MINUTE";
var DELETE_EXPIRED_VERIFICATION_TOKENS_SQL = "DELETE FROM verification_tokens WHERE expires_at < NOW()";
var DELETE_EXPIRED_PASSWORD_RESET_TOKENS_SQL = "DELETE FROM password_reset_tokens WHERE expires_at < NOW()";
async function deleteRows(sql, table) {
  try {
    const result = await query(sql);
    return result.affectedRows ?? 0;
  } catch (err) {
    log4.error(
      { table, err: err instanceof Error ? err.message : String(err) },
      "session-gc: delete failed"
    );
    return null;
  }
}
async function sessionGc() {
  const startedAt = Date.now();
  const sessions = await deleteRows(DELETE_EXPIRED_SESSIONS_SQL, "sessions");
  const verificationTokens = await deleteRows(
    DELETE_EXPIRED_VERIFICATION_TOKENS_SQL,
    "verification_tokens"
  );
  const passwordResetTokens = await deleteRows(
    DELETE_EXPIRED_PASSWORD_RESET_TOKENS_SQL,
    "password_reset_tokens"
  );
  log4.info(
    {
      duration_ms: Date.now() - startedAt,
      deleted: {
        sessions,
        verification_tokens: verificationTokens,
        password_reset_tokens: passwordResetTokens
      }
    },
    "session-gc: completed"
  );
}

// src/crons/file-archive.ts
init_logger();
import { execFile as execFileCb } from "node:child_process";
import { readdir as readdir2, stat as stat2, unlink, mkdir as mkdir2 } from "node:fs/promises";
import os2 from "node:os";
import path3 from "node:path";
import { promisify } from "node:util";
var execFile = promisify(execFileCb);
var log5 = logger.child({ cron: "file-archive" });
var ARCHIVE_THRESHOLD_MONTHS = 24;
var CV_SUBDIR = "cv";
var ARCHIVE_SUBDIR = "archives";
function getFileStoreRoot() {
  const fromEnv = process.env.FILE_STORE_PATH;
  if (fromEnv && fromEnv.trim() !== "") {
    return path3.resolve(fromEnv.trim());
  }
  return path3.resolve(os2.homedir(), "file_store");
}
function quarterLabel(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}Q${quarter}`;
}
function computeCutoff(now = /* @__PURE__ */ new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_THRESHOLD_MONTHS);
  return cutoff;
}
async function walkFiles(dir) {
  const results = [];
  const entries = await readdir2(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path3.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkFiles(fullPath);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
var defaultIo = {
  cvDir() {
    return path3.join(getFileStoreRoot(), CV_SUBDIR);
  },
  archiveDir() {
    return path3.join(getFileStoreRoot(), ARCHIVE_SUBDIR);
  },
  async ensureDir(dir) {
    await mkdir2(dir, { recursive: true, mode: 448 });
  },
  async walkCvFiles() {
    return walkFiles(this.cvDir());
  },
  async fileMtime(filePath) {
    const s = await stat2(filePath);
    return s.mtime;
  },
  async createArchive(archivePath, files) {
    await execFile("tar", ["-czf", archivePath, ...files]);
  },
  async verifyArchive(archivePath) {
    try {
      const { stdout } = await execFile("tar", ["-tzf", archivePath]);
      return typeof stdout === "string" && stdout.trim().length > 0;
    } catch {
      return false;
    }
  },
  async deleteFile(filePath) {
    try {
      await unlink(filePath);
    } catch (err) {
      if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
};
async function archiveQuarter(io, archivesDir, quarter, files) {
  const archivePath = path3.join(archivesDir, `cv-${quarter}.tar.gz`);
  await io.createArchive(archivePath, files);
  const verified = await io.verifyArchive(archivePath);
  if (!verified) {
    log5.error(
      {
        event: "file_archive_verify_failed",
        quarter,
        archive: archivePath,
        file_count: files.length
      },
      "file-archive: tar verification failed; leaving originals in place"
    );
    return 0;
  }
  let deleted = 0;
  for (const filePath of files) {
    try {
      await io.deleteFile(filePath);
      deleted += 1;
    } catch (err) {
      log5.error(
        {
          event: "file_archive_delete_error",
          quarter,
          file: filePath,
          error: err instanceof Error ? err.message : String(err)
        },
        "file-archive: failed to delete original file"
      );
    }
  }
  log5.info(
    {
      event: "file_archive_quarter_done",
      quarter,
      archive: archivePath,
      archived_files: files.length,
      deleted_files: deleted
    },
    "file-archive: quarter archived and originals deleted"
  );
  return deleted;
}
async function fileArchive(io = defaultIo) {
  const startedAt = Date.now();
  const cvDir = io.cvDir();
  let allFiles;
  try {
    allFiles = await io.walkCvFiles();
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      log5.info(
        { event: "file_archive_no_cv_dir", dir: cvDir },
        "file-archive: CV directory does not exist; nothing to archive"
      );
      return;
    }
    throw err;
  }
  log5.info(
    { event: "file_archive_started", total_files: allFiles.length },
    "file-archive: started"
  );
  const cutoff = computeCutoff();
  const eligibleByQuarter = /* @__PURE__ */ new Map();
  for (const filePath of allFiles) {
    let mtime;
    try {
      mtime = await io.fileMtime(filePath);
    } catch (err) {
      log5.error(
        {
          event: "file_archive_stat_error",
          file: filePath,
          error: err instanceof Error ? err.message : String(err)
        },
        "file-archive: could not stat file; skipping"
      );
      continue;
    }
    if (mtime < cutoff) {
      const quarter = quarterLabel(mtime);
      const group = eligibleByQuarter.get(quarter) ?? [];
      group.push(filePath);
      eligibleByQuarter.set(quarter, group);
    }
  }
  const eligibleCount = [...eligibleByQuarter.values()].reduce(
    (sum, arr) => sum + arr.length,
    0
  );
  log5.info(
    {
      event: "file_archive_eligible",
      eligible_files: eligibleCount,
      quarters: eligibleByQuarter.size,
      cutoff: cutoff.toISOString()
    },
    "file-archive: eligible files identified"
  );
  if (eligibleByQuarter.size === 0) {
    log5.info(
      { event: "file_archive_nothing_to_do" },
      "file-archive: no files older than 24 months; nothing to archive"
    );
    return;
  }
  const archivesDir = io.archiveDir();
  await io.ensureDir(archivesDir);
  let totalDeleted = 0;
  let archivedQuarters = 0;
  for (const [quarter, files] of [...eligibleByQuarter.entries()].sort()) {
    try {
      const deleted = await archiveQuarter(io, archivesDir, quarter, files);
      if (deleted > 0) {
        totalDeleted += deleted;
        archivedQuarters += 1;
      }
    } catch (err) {
      log5.error(
        {
          event: "file_archive_quarter_error",
          quarter,
          error: err instanceof Error ? err.message : String(err)
        },
        "file-archive: quarter failed; continuing with remaining quarters"
      );
    }
  }
  log5.info(
    {
      event: "file_archive_done",
      total_files: allFiles.length,
      eligible_files: eligibleCount,
      deleted_files: totalDeleted,
      quarters: archivedQuarters,
      duration_ms: Date.now() - startedAt
    },
    "file-archive: completed"
  );
}

// src/crons/audit-archive.ts
init_db();
import { createWriteStream as createWriteStream2 } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";
import path5 from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzip } from "node:zlib";
import { promisify as promisify2 } from "node:util";

// src/infra/disk.ts
import { statfs, mkdir as mkdir3, unlink as unlink2 } from "node:fs/promises";
import os3 from "node:os";
import path4 from "node:path";
var MIN_FREE_BYTES = 100 * 1024 * 1024;
var ALLOWED_CV_EXTS = Object.freeze(["pdf", "doc", "docx"]);
function getFileStoreRoot2() {
  const fromEnv = process.env.FILE_STORE_PATH;
  if (fromEnv && fromEnv.trim() !== "") {
    return path4.resolve(fromEnv.trim());
  }
  return path4.resolve(os3.homedir(), "file_store");
}
async function ensureDir(target) {
  await mkdir3(target, { recursive: true, mode: 448 });
}

// src/crons/audit-archive.ts
init_logger();
var log6 = logger.child({ cron: "audit-archive" });
var gunzipAsync = promisify2(gunzip);
var AUDIT_TABLE_ROW_THRESHOLD = 5e6;
var ARCHIVE_SUBDIR2 = path5.join("archives", "audit");
var COUNT_SQL = "SELECT COUNT(*) AS n FROM audit_events";
var CUTOFF_SQL = "SELECT (NOW() - INTERVAL 24 MONTH) AS cutoff";
var BUCKETS_SQL = `
  SELECT DATE_FORMAT(occurred_at, '%Y-%m') AS ym, COUNT(*) AS cnt
  FROM audit_events
  WHERE occurred_at < ?
  GROUP BY ym
  ORDER BY ym
`;
var SELECT_BUCKET_ROWS_SQL = `
  SELECT id, occurred_at, actor_user_id, actor_ip,
         action_type, target_entity, target_id, details
  FROM audit_events
  WHERE occurred_at >= ? AND occurred_at < ? AND occurred_at < ?
  ORDER BY id
`;
var DELETE_BUCKET_ROWS_SQL = `
  DELETE FROM audit_events
  WHERE occurred_at >= ? AND occurred_at < ? AND occurred_at < ?
`;
function getAuditArchiveDir() {
  return path5.join(getFileStoreRoot2(), ARCHIVE_SUBDIR2);
}
function* jsonlChunks(lines) {
  for (const line of lines) {
    yield `${line}
`;
  }
}
var defaultIo2 = {
  archiveDir: getAuditArchiveDir,
  ensureDir,
  async writeGzipJsonl(filePath, lines) {
    await pipeline(
      Readable.from(jsonlChunks(lines)),
      createGzip(),
      createWriteStream2(filePath)
    );
  },
  async verifyGzipLineCount(filePath, expectedLines) {
    try {
      const compressed = await readFile2(filePath);
      const raw = await gunzipAsync(compressed);
      const actualLines = raw.toString("utf8").split("\n").filter((line) => line.length > 0).length;
      return actualLines === expectedLines;
    } catch {
      return false;
    }
  }
};
function monthBounds(ym) {
  const [yearStr, monthStr] = ym.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const start = `${ym}-01 00:00:00`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const mm = nextMonth < 10 ? `0${nextMonth}` : `${nextMonth}`;
  const end = `${nextYear}-${mm}-01 00:00:00`;
  return { start, end };
}
function toJsonlLine(row) {
  return JSON.stringify({
    id: row.id,
    occurred_at: row.occurred_at,
    actor_user_id: row.actor_user_id,
    actor_ip: row.actor_ip,
    action_type: row.action_type,
    target_entity: row.target_entity,
    target_id: row.target_id,
    details: row.details
  });
}
async function archiveBucket(io, dir, ym, cutoff) {
  const { start, end } = monthBounds(ym);
  const rows = await query(SELECT_BUCKET_ROWS_SQL, [
    start,
    end,
    cutoff
  ]);
  if (rows.length === 0) {
    return 0;
  }
  const filePath = path5.join(dir, `audit-${ym}.jsonl.gz`);
  const lines = rows.map(toJsonlLine);
  await io.writeGzipJsonl(filePath, lines);
  const verified = await io.verifyGzipLineCount(filePath, lines.length);
  if (!verified) {
    log6.error(
      {
        event: "audit_archive_verify_failed",
        bucket: ym,
        file: filePath,
        expected_rows: lines.length
      },
      "audit-archive: gzip verification failed; leaving rows in place"
    );
    return 0;
  }
  const result = await query(DELETE_BUCKET_ROWS_SQL, [
    start,
    end,
    cutoff
  ]);
  const deleted = result.affectedRows ?? 0;
  log6.info(
    {
      event: "audit_archive_bucket_done",
      bucket: ym,
      file: filePath,
      archived_rows: lines.length,
      deleted_rows: deleted
    },
    "audit-archive: bucket archived and pruned"
  );
  return deleted;
}
async function auditArchive(io = defaultIo2) {
  const startedAt = Date.now();
  const countRows = await query(COUNT_SQL);
  const countBefore = Number(countRows[0]?.n ?? 0);
  if (countBefore <= AUDIT_TABLE_ROW_THRESHOLD) {
    log6.info(
      { event: "audit_archive_skipped", count: countBefore },
      "audit-archive: below threshold, nothing to archive"
    );
    return;
  }
  const cutoffRows = await query(CUTOFF_SQL);
  const cutoff = cutoffRows[0]?.cutoff;
  const buckets = await query(BUCKETS_SQL, [cutoff]);
  const dir = io.archiveDir();
  await io.ensureDir(dir);
  let archivedRows = 0;
  let archivedBuckets = 0;
  for (const bucket of buckets) {
    try {
      const deleted = await archiveBucket(io, dir, bucket.ym, cutoff);
      if (deleted > 0) {
        archivedRows += deleted;
        archivedBuckets += 1;
      }
    } catch (err) {
      log6.error(
        {
          event: "audit_archive_bucket_error",
          bucket: bucket.ym,
          error: err instanceof Error ? err.message : String(err)
        },
        "audit-archive: bucket failed; continuing with remaining buckets"
      );
    }
  }
  log6.info(
    {
      event: "audit_archive_done",
      count_before: countBefore,
      archived_rows: archivedRows,
      buckets: archivedBuckets,
      duration_ms: Date.now() - startedAt
    },
    "audit-archive: completed"
  );
}

// src/crons/search-reindex.ts
init_db();
init_logger();
var log7 = logger.child({ cron: "search-reindex" });
var OPTIMIZE_JOB_POSTINGS_SQL = "OPTIMIZE TABLE job_postings";
var OPTIMIZE_JOB_POSTING_TRANSLATIONS_SQL = "OPTIMIZE TABLE job_posting_translations";
async function tryClearSearchCache() {
  try {
    const mod = await Promise.resolve().then(() => (init_search(), search_exports));
    if (typeof mod.clearSearchCache === "function") {
      await mod.clearSearchCache();
    }
  } catch (err) {
    log7.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "search-reindex: clearSearchCache helper unavailable"
    );
  }
}
async function runSearchReindex() {
  const startedAt = Date.now();
  const startAtIso = new Date(startedAt).toISOString();
  let tablesOptimized = 0;
  try {
    await query(OPTIMIZE_JOB_POSTINGS_SQL);
    tablesOptimized += 1;
    await query(OPTIMIZE_JOB_POSTING_TRANSLATIONS_SQL);
    tablesOptimized += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log7.error(
      {
        cron: "search-reindex",
        start_at: startAtIso,
        duration_ms: Date.now() - startedAt,
        tables_optimized: tablesOptimized,
        error: message,
        status: "failed"
      },
      "search-reindex: OPTIMIZE TABLE failed"
    );
    throw err;
  }
  await tryClearSearchCache();
  log7.info(
    {
      cron: "search-reindex",
      start_at: startAtIso,
      duration_ms: Date.now() - startedAt,
      tables_optimized: tablesOptimized,
      status: "ok"
    },
    "search-reindex: OPTIMIZE TABLE completed"
  );
}

// src/crons/index.ts
async function accountPurge() {
  log8.info("account-purge: stub \u2014 PII anonymization not yet implemented");
}
var log8 = logger.child({ component: "cron-dispatcher" });
var CRON_TASKS = {
  "mail-flush": mailFlush,
  "alert-digest": alertDigest,
  "backup-daily": backupDaily,
  "session-gc": sessionGc,
  "file-archive": fileArchive,
  "audit-archive": auditArchive,
  "search-reindex": runSearchReindex,
  "account-purge": accountPurge
};
function buildProgram() {
  const program = new Command();
  program.name("crons").description("PT Buana Megah Job Portal cron dispatcher").version("0.1.0");
  for (const [name, task] of Object.entries(CRON_TASKS)) {
    program.command(name).description(`Run the ${name} cron task under runWithLock('${name}', ...)`).action(async () => {
      await runWithLock(name, task);
    });
  }
  return program;
}
async function shutdown() {
  try {
    await closePool();
  } catch (err) {
    log8.warn({ err }, "cron: pool close failed");
  }
}
async function main(argv) {
  const program = buildProgram();
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (err) {
    log8.error({ err }, "cron task failed");
    return 1;
  } finally {
    await shutdown();
  }
}
var entrypointArg = process.argv[1];
var isEntrypoint = entrypointArg !== void 0 && import.meta.url === pathToFileURL(entrypointArg).href;
if (isEntrypoint || process.env.CRON_FORCE_RUN === "1") {
  main(process.argv).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      console.error("cron dispatcher crashed:", err);
      process.exit(1);
    }
  );
}
export {
  buildProgram
};
//# sourceMappingURL=index.mjs.map
