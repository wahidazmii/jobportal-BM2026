/**
 * Admin_Console route plugin for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 21.3
 * Design  : §6 Admin (HTTP routing map)
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 11.4, 15.2
 *
 * Scope of THIS file:
 *   - GET  /admin/jobs                    → list with status filter + pagination.
 *   - GET  /admin/jobs/new                → empty create form (status=Draft).
 *   - POST /admin/jobs                    → createJob; on Zod / SlugConflict
 *                                           re-render with errors.
 *   - GET  /admin/jobs/:id                → edit form (404 if missing / scope).
 *   - POST /admin/jobs/:id                → updateJob.
 *   - POST /admin/jobs/:id/publish        → publishJob (Draft→Published).
 *   - POST /admin/jobs/:id/close          → closeJob (Published→Closed).
 *   - POST /admin/jobs/:id/archive        → archiveJob.
 *   - GET  /admin/jobs/:id/clone          → clone form prefilled with the
 *                                           source job's content; the new
 *                                           slug is the only editable field.
 *   - POST /admin/jobs/:id/clone          → cloneJob → 302 to new edit page.
 *
 * Authentication / RBAC:
 *   - Every endpoint sits behind `requireAdmin` from
 *     `src/infra/admin-guard.ts`. The guard accepts internal roles
 *     {Super_Admin, HR, Department_Head} by default — Department_Head
 *     gains read-only access to the list/edit views per Req 11.4 but is
 *     blocked from create/publish/close/archive/clone via the
 *     `allowedRoles` parameter on the relevant routes (write actions
 *     keep the design §14.1 policy: HR + Super_Admin only).
 *   - Department_Head sessions arrive with `scope.departments` resolved
 *     by the guard. We thread the scope into every repo / service call
 *     so a Dept_Head cannot read or mutate a posting outside their
 *     assigned departments. The `JobScope` shape collapses
 *     "out-of-scope" into `JobNotFoundError`, which the routes map to
 *     a clean 404 page.
 *
 * CSRF:
 *   - The CSRF middleware (`src/infra/csrf.ts`) is registered at the
 *     application level. POST handlers receive `_csrf` in the parsed
 *     body and the middleware verifies the three-way match (cookie,
 *     request token, sessions row) before this file sees the request.
 *     Each form template embeds `<input type="hidden" name="_csrf">`
 *     populated from the resolved session token.
 *
 * Locales:
 *   - Admin pages are NOT locale-prefixed in this MVP (per task brief).
 *     Internal staff see the views in a single mixed-language tone with
 *     id/en translation tabs available *inside* the job edit form.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';

import {
  type AdminSession,
  requireAdmin,
} from '../infra/admin-guard.js';
import { requirePolicy } from '../modules/security/policies.js';
import { zodErrorToFieldMap } from './_zod-helpers.js';
import {
  ALLOWED_TRANSITIONS,
  EMPLOYMENT_TYPES,
  InvalidTransitionError,
  JOB_LEVELS,
  JOB_LOCALES,
  JobNotFoundError,
  SlugConflictError,
  type JobPosting,
  type JobPostingDetail,
  type JobScope,
  list as listJobs,
} from '../modules/jobs/repo.js';
import {
  archiveJob,
  closeJob,
  cloneJob,
  createJob,
  findJobById,
  JOB_STATUSES,
  publishJob,
  updateJob,
} from '../modules/jobs/service.js';
import {
  KANBAN_STAGE_LABELS,
  KANBAN_STAGES,
  findKanbanCard,
  listForKanban,
  type KanbanColumn,
} from '../modules/applications/kanban-repo.js';
import {
  ApplicationNotFoundError,
  InvalidInterviewInputError,
  scheduleInterviewForApplication,
} from '../modules/applications/interviews-service.js';
import {
  // The notes service re-exports `ApplicationNotFoundError` from
  // `./errors.js`, which is a DIFFERENT class than the one the interview
  // service defines locally above. We alias it so the `instanceof` catch
  // in the notes handlers matches the class the service actually throws.
  ApplicationNotFoundError as NotesApplicationNotFoundError,
  InvalidNoteInputError,
  addNote,
  listNotes,
} from '../modules/applications/notes-service.js';
import {
  // The email service re-exports the SAME `ApplicationNotFoundError` from
  // `./errors.js` as the notes service, so we reuse the existing
  // `NotesApplicationNotFoundError` alias for the catch in the email
  // handler and import only the email-specific symbols here to avoid a
  // duplicate-identifier collision.
  InvalidEmailInputError,
  MailTemplateNotFoundError,
  sendTemplatedEmail,
} from '../modules/applications/email-service.js';
import {
  ApplicationNotFoundError as StageApplicationNotFoundError,
  BulkStageBatchTooLargeError,
  InvalidStageTransitionError,
  bulkChangeStage,
  changeStage,
  isPipelineStage,
  PIPELINE_STAGES,
  type PipelineStage,
} from '../modules/applications/stage-service.js';
import {
  InvalidTemplateInputError,
  TEMPLATE_LOCALES,
  getOne as getMailTemplate,
  listAll as listMailTemplates,
  saveTemplate as saveMailTemplate,
} from '../modules/mail/templates-service.js';
import type { MailTemplateRecord } from '../modules/mail/templates-repo.js';
import { ACTION_TYPES, auditService } from '../modules/audit/writer.js';
import {
  AUDIT_LIST_DEFAULT_PAGE_SIZE,
  listAuditEvents,
  type AuditEventFilter,
  type PaginatedAuditEvents,
} from '../modules/audit/queries.js';
import {
  INVITE_ROLES,
  InvalidInviteInputError,
  type InternalUserRecord,
  inviteUser,
  listInternalUsers,
} from '../modules/users/invite-service.js';
import {
  getReportSummary,
  type ReportFilter,
} from '../modules/reporting/queries.js';
import {
  getApplicationsForExport,
  type ApplicationExportRow,
} from '../modules/reporting/csv-export.js';
import { signCvDownloadUrl } from '../modules/reporting/signed-url.js';
import { query, type RowDataPacket } from '../infra/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdParams {
  id: string;
}

interface ListQuery {
  status?: unknown;
  page?: unknown;
}

/**
 * Raw form body shape. Every field is `unknown` because Fastify's
 * `formbody` parser produces strings (or arrays of strings) and Zod
 * normalises the values inside the service layer.
 *
 * Translations arrive as parallel field arrays (`title_id`, `title_en`,
 * `description_id`, …) because plain HTML forms cannot post nested
 * objects. The route collapses them into the `translations[]` shape
 * the schema expects.
 */
interface JobBody {
  slug?: unknown;
  department_id?: unknown;
  location?: unknown;
  employment_type?: unknown;
  level?: unknown;
  salary_min?: unknown;
  salary_max?: unknown;
  salary_currency?: unknown;
  application_deadline?: unknown;
  // id translation
  title_id?: unknown;
  description_id?: unknown;
  requirements_id?: unknown;
  responsibilities_id?: unknown;
  // en translation
  title_en?: unknown;
  description_en?: unknown;
  requirements_en?: unknown;
  responsibilities_en?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

interface CloneBody {
  slug?: unknown;
  _csrf?: unknown;
}

/**
 * Raw POST body for the schedule-interview form. Every field is
 * `unknown` because Fastify's `formbody` parser yields strings (or
 * arrays of strings); the interview service's zod schema
 * (`scheduleInterviewSchema`) parses and normalises the values
 * internally, so the route forwards the raw fields untouched.
 */
interface InterviewBody {
  scheduledAt?: unknown;
  location?: unknown;
  meetingUrl?: unknown;
  interviewerUserId?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

/**
 * Raw POST body for the add-note form. Every field is `unknown` because
 * Fastify's `formbody` parser yields strings (or arrays of strings); the
 * note service's zod schema (`addNoteSchema`) parses and normalises the
 * values internally — including the HTML-checkbox truthiness of
 * `visibleToApplicant` — so the route forwards the raw fields untouched.
 */
interface NoteBody {
  body?: unknown;
  visibleToApplicant?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

/**
 * Raw POST body for the send-templated-email form. Every field is
 * `unknown` because Fastify's `formbody` parser yields strings (or
 * arrays of strings); the email service's zod schema
 * (`sendTemplatedEmailSchema`) parses and normalises the values
 * internally — including the locale default — so the route forwards the
 * raw fields untouched.
 */
interface EmailBody {
  templateKey?: unknown;
  locale?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

/**
 * Raw POST body for the stage-transition endpoint
 * (`POST /api/applications/:id/stage`). The destination stage arrives
 * either as `stage` (card-menu select) or `newStage` (SortableJS
 * `hx-vals` payload from the drag handler); we accept both. An optional
 * `reason` is threaded into the audit + mail payloads. Every field is
 * `unknown` because Fastify's parser yields strings; the handler
 * validates `stage` against `PIPELINE_STAGES` before calling the service.
 */
interface StageBody {
  stage?: unknown;
  newStage?: unknown;
  reason?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

/**
 * Raw POST body for the bulk stage-transition endpoint
 * (`POST /api/applications/bulk-stage`). `applicationIds` arrives either
 * as a JSON array of ids (htmx `hx-vals` with `js:` or a JSON content
 * type) or, defensively, as a comma-separated string when posted as a
 * plain form field. The destination `stage` is validated against
 * `PIPELINE_STAGES`; an optional `reason` is threaded into each
 * per-application change. Every field is `unknown` because the parser
 * yields strings / arrays; the handler normalises before calling the
 * service.
 */
interface BulkStageBody {
  applicationIds?: unknown;
  stage?: unknown;
  reason?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

/**
 * Raw POST body for the mail-template editor form. Every field is
 * `unknown` because Fastify's `formbody` parser yields strings (or
 * arrays of strings); the templates service's zod schema
 * (`saveTemplateSchema`) parses and normalises the values internally, so
 * the route forwards the raw fields untouched.
 */
interface MailTemplateBody {
  key?: unknown;
  locale?: unknown;
  subject?: unknown;
  body_html?: unknown;
  body_text?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

/** URL params for the mail-template edit page (`:key/:locale`). */
interface MailTemplateParams {
  key: string;
  locale: string;
}

interface DepartmentRow extends RowDataPacket {
  id: number | string;
  code: string;
  name: string;
}

interface DepartmentOption {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

const SELECT_DEPARTMENTS_SQL =
  'SELECT id, code, name FROM departments ORDER BY name ASC';

/**
 * Pull the controlled vocabulary of departments so the edit form can
 * render a `<select>`. We fetch on every form GET — the table is small
 * (a few dozen rows), the query is indexed on the PK, and a stale list
 * would be more confusing than a fresh round-trip.
 */
async function loadDepartments(): Promise<DepartmentOption[]> {
  const rows = await query<DepartmentRow[]>(SELECT_DEPARTMENTS_SQL, []);
  return rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    name: row.name,
  }));
}

/**
 * Normalise an unknown form value into a plain string. Used for the
 * sticky-form pattern — pick the FIRST string when an array sneaks in
 * so a malicious double-post cannot smuggle an alternate value past
 * the visible field.
 */
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string') as
      | string
      | undefined;
    return typeof first === 'string' ? first : '';
  }
  return '';
}

/** Coerce the `:id` URL segment into a positive integer or `null`. */
function parseIdParam(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Coerce `?page=` to a 0-based page index. Defaults to 0. */
function parsePageParam(raw: unknown): number {
  const s = asString(raw);
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * Collapse the parallel form fields into the canonical `translations[]`
 * shape the schema expects. Empty rows are passed through — the schema
 * (and `pruneEmptyTranslations` inside the service) drops fully-empty
 * entries before the INSERT.
 */
function collectTranslations(body: JobBody): Array<{
  locale: 'id' | 'en';
  title: string;
  description: string;
  requirements: string;
  responsibilities: string;
}> {
  return [
    {
      locale: 'id',
      title: asString(body.title_id),
      description: asString(body.description_id),
      requirements: asString(body.requirements_id),
      responsibilities: asString(body.responsibilities_id),
    },
    {
      locale: 'en',
      title: asString(body.title_en),
      description: asString(body.description_en),
      requirements: asString(body.requirements_en),
      responsibilities: asString(body.responsibilities_en),
    },
  ];
}

/**
 * Project a raw form body onto the form-values map the view re-renders
 * after a validation failure. Mirrors what the persisted job looks like
 * so the template can use a single set of accessors regardless of
 * whether the data came from the DB or the failed POST.
 */
function bodyToFormValues(body: JobBody): Record<string, unknown> {
  return {
    slug: asString(body.slug),
    department_id: asString(body.department_id),
    location: asString(body.location),
    employment_type: asString(body.employment_type),
    level: asString(body.level),
    salary_min: asString(body.salary_min),
    salary_max: asString(body.salary_max),
    salary_currency: asString(body.salary_currency),
    application_deadline: asString(body.application_deadline),
    translations: {
      id: {
        title: asString(body.title_id),
        description: asString(body.description_id),
        requirements: asString(body.requirements_id),
        responsibilities: asString(body.responsibilities_id),
      },
      en: {
        title: asString(body.title_en),
        description: asString(body.description_en),
        requirements: asString(body.requirements_en),
        responsibilities: asString(body.responsibilities_en),
      },
    },
  };
}

/**
 * Project a `JobPostingDetail` onto the same form-values shape so the
 * view can re-use a single template path for both fresh edits and
 * post-validation re-renders.
 */
function detailToFormValues(job: JobPostingDetail): Record<string, unknown> {
  return {
    slug: job.slug,
    department_id: job.department_id === null ? '' : String(job.department_id),
    location: job.location,
    employment_type: job.employment_type,
    level: job.level,
    salary_min: job.salary_min === null ? '' : String(job.salary_min),
    salary_max: job.salary_max === null ? '' : String(job.salary_max),
    salary_currency: job.salary_currency ?? '',
    application_deadline: job.application_deadline ?? '',
    translations: {
      id: {
        title: job.translations.id?.title ?? '',
        description: job.translations.id?.description ?? '',
        requirements: job.translations.id?.requirements ?? '',
        responsibilities: job.translations.id?.responsibilities ?? '',
      },
      en: {
        title: job.translations.en?.title ?? '',
        description: job.translations.en?.description ?? '',
        requirements: job.translations.en?.requirements ?? '',
        responsibilities: job.translations.en?.responsibilities ?? '',
      },
    },
  };
}

/** Empty form values (used for `GET /admin/jobs/new`). */
function emptyFormValues(): Record<string, unknown> {
  return {
    slug: '',
    department_id: '',
    location: '',
    employment_type: '',
    level: '',
    salary_min: '',
    salary_max: '',
    salary_currency: '',
    application_deadline: '',
    translations: {
      id: { title: '', description: '', requirements: '', responsibilities: '' },
      en: { title: '', description: '', requirements: '', responsibilities: '' },
    },
  };
}

/**
 * Build the action-button affordances the edit view renders below the
 * form. The set is derived from the state machine (`ALLOWED_TRANSITIONS`)
 * so we never expose a button that the service would reject.
 *
 * Department_Head cannot transition statuses (write actions are
 * HR + Super_Admin only). The view honors `canWrite` to decide whether
 * to render the buttons at all.
 */
function actionsForStatus(
  status: JobPosting['status'],
): {
  canPublish: boolean;
  canClose: boolean;
  canArchive: boolean;
  canClone: boolean;
} {
  const allowed = ALLOWED_TRANSITIONS[status];
  return {
    canPublish: allowed.has('Published'),
    canClose: allowed.has('Closed'),
    canArchive: allowed.has('Archived'),
    // Cloning is always available — the source row is read-only and the
    // new draft inherits no status semantics.
    canClone: true,
  };
}

/** Whether the session is allowed to mutate jobs. Dept_Head is read-only. */
function canWrite(session: AdminSession): boolean {
  return session.role === 'HR' || session.role === 'Super_Admin';
}

/** Build a `JobScope` to thread into repo / service calls. */
function scopeForSession(session: AdminSession): JobScope | undefined {
  // Super_Admin and HR see every row → no scope clause. Department_Head
  // sees only their assigned departments (possibly empty array, which
  // collapses to "no rows").
  if (session.scope.departments === undefined) return undefined;
  return { departments: session.scope.departments };
}

/**
 * Render the canonical 404 admin page. The MVP keeps the response body
 * a JSON shape — the polished `views/admin/404.njk` lands later.
 */
function send404(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'job_not_found' });
}

// ---------------------------------------------------------------------------
// GET /admin/jobs (list)
// ---------------------------------------------------------------------------

/**
 * Render the admin job list. Supports `?status=Draft|Published|Closed|Archived`
 * and `?page=N` query parameters.
 *
 * Department_Head sessions get the same view but see only their
 * assigned departments thanks to the `scope` thread. The status filter
 * accepts a single value (multi-select is a Phase-8 polish).
 */
async function getJobsIndex(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: ListQuery }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply);
  if (session === null) return reply;

  const statusRaw = asString(request.query?.status);
  const status =
    statusRaw && (JOB_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as (typeof JOB_STATUSES)[number])
      : null;
  const page = parsePageParam(request.query?.page);

  let result: { rows: JobPosting[]; total: number };
  try {
    result = await listJobs(
      {
        status: status === null ? undefined : [status],
        page,
        pageSize: PAGE_SIZE,
      },
      scopeForSession(session),
    );
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'admin.jobs: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  const html = app.view('admin/jobs/index.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: canWrite(session),
    },
    statuses: JOB_STATUSES,
    statusFilter: status,
    jobs: result.rows,
    total: result.total,
    page,
    pageSize: PAGE_SIZE,
    totalPages,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// GET /admin/jobs/new (create form)
// ---------------------------------------------------------------------------

async function getJobNew(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  let departments: DepartmentOption[];
  try {
    departments = await loadDepartments();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'admin.jobs: department list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = app.view('admin/jobs/edit.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true,
    },
    mode: 'create',
    formAction: '/admin/jobs',
    job: null,
    values: emptyFormValues(),
    errors: {},
    generalError: null,
    departments,
    employmentTypes: EMPLOYMENT_TYPES,
    levels: JOB_LEVELS,
    locales: JOB_LOCALES,
    actions: {
      canPublish: false,
      canClose: false,
      canArchive: false,
      canClone: false,
    },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// POST /admin/jobs (create)
// ---------------------------------------------------------------------------

async function postJobCreate(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: JobBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  // Migrated to the §14.1 policy guard (task 39.1). `job.create` grants
  // {Super_Admin, HR} — identical to the prior
  // `requireAdmin({ allowedRoles: ['Super_Admin', 'HR'] })`, but a denied
  // role now gets the rendered 403 page + an `access_denied` audit event.
  const session = await requirePolicy('job.create')(request, reply);
  if (session === null) return reply;

  const body = request.body ?? {};
  const payload = {
    slug: asString(body.slug),
    department_id: asString(body.department_id),
    location: asString(body.location),
    employment_type: asString(body.employment_type),
    level: asString(body.level),
    salary_min: asString(body.salary_min),
    salary_max: asString(body.salary_max),
    salary_currency: asString(body.salary_currency),
    application_deadline: asString(body.application_deadline),
    translations: collectTranslations(body),
  };

  try {
    const created = await createJob(payload, session.userId);
    return reply
      .code(302)
      .header('location', `/admin/jobs/${created.id}?saved=1`)
      .send();
  } catch (err) {
    if (err instanceof ZodError || err instanceof SlugConflictError) {
      const errors =
        err instanceof ZodError
          ? zodErrorToFieldMap(err)
          : { slug: [`Slug "${err.slug}" is already in use`] };
      const status = err instanceof SlugConflictError ? 422 : 400;
      let departments: DepartmentOption[] = [];
      try {
        departments = await loadDepartments();
      } catch {
        // Non-fatal: the form still renders, the dropdown is just empty.
      }
      const html = app.view('admin/jobs/edit.njk', {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true,
        },
        mode: 'create',
        formAction: '/admin/jobs',
        job: null,
        values: bodyToFormValues(body),
        errors,
        generalError: null,
        departments,
        employmentTypes: EMPLOYMENT_TYPES,
        levels: JOB_LEVELS,
        locales: JOB_LOCALES,
        actions: {
          canPublish: false,
          canClose: false,
          canArchive: false,
          canClone: false,
        },
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
      });
      return reply.code(status).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId },
      'admin.jobs: create failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /admin/jobs/:id (edit form)
// ---------------------------------------------------------------------------

async function getJobEdit(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams; Querystring: { saved?: unknown } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply);
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) return send404(reply);

  let job: JobPostingDetail | null;
  try {
    job = await findJobById(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      'admin.jobs: load failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
  if (job === null) return send404(reply);

  let departments: DepartmentOption[];
  try {
    departments = await loadDepartments();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'admin.jobs: department list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const writable = canWrite(session);
  const saved = asString(request.query?.saved) === '1';

  const html = app.view('admin/jobs/edit.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: writable,
    },
    mode: 'edit',
    formAction: `/admin/jobs/${job.id}`,
    job,
    values: detailToFormValues(job),
    errors: {},
    generalError: null,
    saved,
    departments,
    employmentTypes: EMPLOYMENT_TYPES,
    levels: JOB_LEVELS,
    locales: JOB_LOCALES,
    actions: writable
      ? actionsForStatus(job.status)
      : { canPublish: false, canClose: false, canArchive: false, canClone: false },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// POST /admin/jobs/:id (update)
// ---------------------------------------------------------------------------

async function postJobUpdate(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams; Body: JobBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) return send404(reply);

  const body = request.body ?? {};
  const payload = {
    slug: asString(body.slug),
    department_id: asString(body.department_id),
    location: asString(body.location),
    employment_type: asString(body.employment_type),
    level: asString(body.level),
    salary_min: asString(body.salary_min),
    salary_max: asString(body.salary_max),
    salary_currency: asString(body.salary_currency),
    application_deadline: asString(body.application_deadline),
    translations: collectTranslations(body),
  };

  try {
    await updateJob(id, payload, session.userId, scopeForSession(session));
    return reply
      .code(302)
      .header('location', `/admin/jobs/${id}?saved=1`)
      .send();
  } catch (err) {
    if (err instanceof JobNotFoundError) return send404(reply);

    if (err instanceof ZodError || err instanceof SlugConflictError) {
      // Re-load the persisted detail so the action buttons still reflect
      // the real status (the body's `status` field is server-managed).
      const persisted = await findJobById(id, scopeForSession(session)).catch(
        () => null,
      );
      const errors =
        err instanceof ZodError
          ? zodErrorToFieldMap(err)
          : { slug: [`Slug "${err.slug}" is already in use`] };
      const status = err instanceof SlugConflictError ? 422 : 400;
      let departments: DepartmentOption[] = [];
      try {
        departments = await loadDepartments();
      } catch {
        // Non-fatal — see note above.
      }
      const html = app.view('admin/jobs/edit.njk', {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true,
        },
        mode: 'edit',
        formAction: `/admin/jobs/${id}`,
        job: persisted,
        values: bodyToFormValues(body),
        errors,
        generalError: null,
        departments,
        employmentTypes: EMPLOYMENT_TYPES,
        levels: JOB_LEVELS,
        locales: JOB_LOCALES,
        actions: persisted
          ? actionsForStatus(persisted.status)
          : { canPublish: false, canClose: false, canArchive: false, canClone: false },
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
      });
      return reply.code(status).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId, jobId: id },
      'admin.jobs: update failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// POST /admin/jobs/:id/{publish,close,archive}
// ---------------------------------------------------------------------------

type StatusAction = 'publish' | 'close' | 'archive';

async function postJobStatus(
  app: FastifyInstance,
  action: StatusAction,
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) return send404(reply);

  try {
    const scope = scopeForSession(session);
    if (action === 'publish') {
      await publishJob(id, session.userId, scope);
    } else if (action === 'close') {
      await closeJob(id, session.userId, scope);
    } else {
      await archiveJob(id, session.userId, scope);
    }
    return reply
      .code(302)
      .header('location', `/admin/jobs/${id}?saved=1`)
      .send();
  } catch (err) {
    if (err instanceof JobNotFoundError) return send404(reply);
    if (err instanceof InvalidTransitionError) {
      // 422 with a short explanatory body. The polished error page
      // lands with task 39.x; until then a JSON body keeps the contract
      // simple for tests.
      return reply.code(422).send({
        error: 'invalid_transition',
        from: err.from,
        to: err.to,
      });
    }
    if (err instanceof ZodError) {
      // Surfaced by `publishJob` when the persisted job lacks a slug
      // or a complete translation. We render a 422 with the Zod
      // message so HR knows what to fix.
      return reply.code(422).send({
        error: 'cannot_publish',
        details: zodErrorToFieldMap(err),
      });
    }
    app.log.error(
      { err, userId: session.userId, jobId: id, action },
      'admin.jobs: status transition failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /admin/jobs/:id/clone (clone form)
// ---------------------------------------------------------------------------

async function getJobClone(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) return send404(reply);

  let job: JobPostingDetail | null;
  try {
    job = await findJobById(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      'admin.jobs: clone load failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
  if (job === null) return send404(reply);

  const html = app.view('admin/jobs/clone.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true,
    },
    job,
    values: { slug: '' },
    errors: {},
    generalError: null,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// POST /admin/jobs/:id/clone
// ---------------------------------------------------------------------------

async function postJobClone(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams; Body: CloneBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) return send404(reply);

  const body = request.body ?? {};
  const slug = asString(body.slug);

  try {
    const cloned = await cloneJob(
      id,
      { slug },
      session.userId,
      scopeForSession(session),
    );
    return reply
      .code(302)
      .header('location', `/admin/jobs/${cloned.id}?saved=1`)
      .send();
  } catch (err) {
    if (err instanceof JobNotFoundError) return send404(reply);

    if (err instanceof ZodError || err instanceof SlugConflictError) {
      const errors =
        err instanceof ZodError
          ? zodErrorToFieldMap(err)
          : { slug: [`Slug "${err.slug}" is already in use`] };
      const status = err instanceof SlugConflictError ? 422 : 400;

      // Re-load the source row so the preview block stays populated.
      const job = await findJobById(id, scopeForSession(session)).catch(
        () => null,
      );
      if (job === null) return send404(reply);

      const html = app.view('admin/jobs/clone.njk', {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true,
        },
        job,
        values: { slug },
        errors,
        generalError: null,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
      });
      return reply.code(status).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId, jobId: id },
      'admin.jobs: clone failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /admin/jobs/:id/kanban (kanban board)
// ---------------------------------------------------------------------------

/**
 * Render the recruitment-pipeline kanban board for a single job
 * posting. Six columns in the canonical order (Applied, Screening,
 * Interview, Offer, Hired, Rejected); `Withdrawn` applications are
 * filtered out at the query level (kanban-repo).
 *
 * Authorization:
 *   - Default `requireAdmin` (Super_Admin / HR / Department_Head).
 *     Department_Head sees the board for jobs in their assigned
 *     departments only — `findJobById(id, scope)` collapses out-of-
 *     scope to `null`, which we map to a 404 so an unauthorised peek
 *     cannot confirm the job's existence.
 *   - `canWrite` is true only for Super_Admin / HR. The view passes
 *     it down to `kanban-card.njk` which strips the htmx hooks for
 *     read-only sessions, so a Dept_Head cannot smuggle a stage
 *     change through the endpoint by drag-and-drop.
 *
 * Why we re-fetch the cards every render:
 *   The board is the canonical "current state" view of the pipeline.
 *   Caching here would create a window where a recently-moved card
 *   appears in the wrong column, and HR's mental model is "page
 *   reload = ground truth". A 60s LRU cache like the public job list
 *   would actively undermine that contract; we trade a few milliseconds
 *   of DB time for correctness.
 */
async function getJobKanban(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply);
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) return send404(reply);

  let job: JobPostingDetail | null;
  try {
    job = await findJobById(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      'admin.jobs.kanban: load failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
  if (job === null) return send404(reply);

  let rawColumns: readonly KanbanColumn[];
  try {
    rawColumns = await listForKanban(id, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId: id },
      'admin.jobs.kanban: query failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const writable = canWrite(session);

  // Annotate each column with its display label. The kanban-repo
  // returns the canonical six-column shape, so we walk the
  // `KANBAN_STAGES` constant to keep the view-side ordering decision
  // colocated with the column-display vocabulary.
  const columns = KANBAN_STAGES.map((stage, index) => {
    const col = rawColumns[index];
    return {
      stage,
      label: KANBAN_STAGE_LABELS[stage],
      rows: col?.stage === stage ? col.rows : [],
    };
  });

  const html = app.view('admin/jobs/kanban.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: writable,
    },
    job,
    columns,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// POST /admin/applications/:id/interview (schedule interview)
// ---------------------------------------------------------------------------

/**
 * Schedule an interview on an existing application (Req 10.4).
 *
 * The `:id` segment is the APPLICATION primary key (not a job id).
 *
 * Authorization:
 *   - `requireAdmin` with `allowedRoles` {Super_Admin, HR,
 *     Department_Head}. Department_Head may only schedule for
 *     applications whose job sits in their assigned departments —
 *     we thread `scopeForSession(session)` into the service, which
 *     loads the application's job through `findJobById(jobId, scope)`
 *     and collapses an out-of-scope (or missing) row into
 *     `ApplicationNotFoundError`. That maps to the same 404 as a
 *     missing application id, so the endpoint never confirms the
 *     existence of an out-of-scope application.
 *
 * Validation:
 *   - The service parses the raw body through `scheduleInterviewSchema`
 *     internally, so we forward the four form fields untouched. A
 *     validation failure surfaces as `InvalidInterviewInputError`
 *     carrying the field-level error map.
 *
 * Response:
 *   - There is no admin application-detail page yet (task 30 area),
 *     so on success we return `201 { ok: true, interview }` rather
 *     than redirecting. When that page lands a future change can swap
 *     this for a 302 to `/admin/applications/:id`.
 *   - `InvalidInterviewInputError` → 422 with the field error map.
 *   - `ApplicationNotFoundError`   → 404 (shared send404 shape).
 *
 * CSRF is enforced by the global middleware before this handler runs,
 * exactly as for the other admin POST routes.
 */
async function postScheduleInterview(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams; Body: InterviewBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR', 'Department_Head'],
  });
  if (session === null) return reply;

  const applicationId = parseIdParam(request.params.id);
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
        interviewerUserId: body.interviewerUserId,
      },
    });
    return reply.code(201).send({ ok: true, interview: result.interview });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) return send404(reply);
    if (err instanceof InvalidInterviewInputError) {
      return reply.code(422).send({
        error: 'invalid_interview_input',
        fields: err.fieldErrors,
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId },
      'admin.applications.interview: schedule failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /admin/applications/:id/notes (list notes)
// ---------------------------------------------------------------------------

/**
 * List every note on an application (Req 10.3).
 *
 * The `:id` segment is the APPLICATION primary key (not a job id).
 *
 * Authorization:
 *   - `requireAdmin` with `allowedRoles` {Super_Admin, HR,
 *     Department_Head}. Department_Head may add/read notes per Req 11.4,
 *     but only for applications whose job sits in their assigned
 *     departments. We thread `scopeForSession(session)` into the
 *     service, which resolves the application's job through
 *     `findJobById(jobId, scope)` and collapses an out-of-scope (or
 *     missing) row into `ApplicationNotFoundError` → the same 404 as a
 *     missing application id, so the endpoint never confirms the
 *     existence of an out-of-scope application.
 *
 * Response:
 *   - There is no admin notes-view template yet (task 30 area), so we
 *     return `200 { ok: true, notes }` as JSON rather than rendering a
 *     page. This keeps the contract simple and mirrors how the
 *     interview route returns JSON. When the application-detail page
 *     lands a future change can render the notes inline.
 *   - `ApplicationNotFoundError` → 404 (shared send404 shape).
 */
async function getApplicationNotes(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR', 'Department_Head'],
  });
  if (session === null) return reply;

  const applicationId = parseIdParam(request.params.id);
  if (applicationId === null) return send404(reply);

  try {
    const notes = await listNotes({
      applicationId,
      scope: scopeForSession(session),
    });
    return reply.code(200).send({ ok: true, notes });
  } catch (err) {
    if (err instanceof NotesApplicationNotFoundError) return send404(reply);
    app.log.error(
      { err, userId: session.userId, applicationId },
      'admin.applications.notes: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// POST /admin/applications/:id/notes (add note)
// ---------------------------------------------------------------------------

/**
 * Add a note to an application (Req 10.3, 8.2).
 *
 * The `:id` segment is the APPLICATION primary key (not a job id).
 *
 * Authorization:
 *   - Same {Super_Admin, HR, Department_Head} set + scope thread as the
 *     GET above (Req 11.4 explicitly allows Department_Head to add
 *     notes).
 *
 * Validation:
 *   - The service parses the raw body through `addNoteSchema` internally
 *     (trim + length on `body`, HTML-form truthiness on
 *     `visibleToApplicant`), so we forward the two form fields
 *     untouched. A validation failure surfaces as `InvalidNoteInputError`
 *     carrying the field-level error map.
 *
 * Side effect:
 *   - When `visibleToApplicant` is true the service enqueues a
 *     notification email (Req 8.2). Internal notes do not.
 *
 * Response:
 *   - Success → `201 { ok: true, note }` (no admin detail page yet).
 *   - `InvalidNoteInputError` → 422 `{ error: 'invalid_note_input', fields }`.
 *   - `ApplicationNotFoundError` → 404 (shared send404 shape).
 *
 * CSRF is enforced by the global middleware before this handler runs,
 * exactly as for the other admin POST routes.
 */
async function postApplicationNote(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams; Body: NoteBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR', 'Department_Head'],
  });
  if (session === null) return reply;

  const applicationId = parseIdParam(request.params.id);
  if (applicationId === null) return send404(reply);

  const body = request.body ?? {};

  try {
    const note = await addNote({
      applicationId,
      authorUserId: session.userId,
      scope: scopeForSession(session),
      input: {
        body: body.body,
        visibleToApplicant: body.visibleToApplicant,
      },
    });
    return reply.code(201).send({ ok: true, note });
  } catch (err) {
    if (err instanceof NotesApplicationNotFoundError) return send404(reply);
    if (err instanceof InvalidNoteInputError) {
      return reply.code(422).send({
        error: 'invalid_note_input',
        fields: err.fieldErrors,
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId },
      'admin.applications.notes: add failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// POST /admin/applications/:id/email (send templated email)
// ---------------------------------------------------------------------------

/**
 * Send a templated email to an application's applicant (Req 10.7).
 *
 * The `:id` segment is the APPLICATION primary key (not a job id).
 *
 * Authorization:
 *   - `requireAdmin` with `allowedRoles` {Super_Admin, HR} per Design §6
 *     Admin + §14.1 — templated email send is an HR action and
 *     Department_Head is NOT granted it (a Dept_Head session is rejected
 *     by the guard with a 403). We still thread `scopeForSession(session)`
 *     into the service as defence in depth; for HR / Super_Admin it
 *     resolves to `undefined` (no scoping).
 *   - When a scope IS supplied, an out-of-department application
 *     collapses to the same 404 as a missing application id, so the
 *     endpoint never confirms the existence of an out-of-scope row.
 *
 * Validation:
 *   - The service parses the raw body through `sendTemplatedEmailSchema`
 *     internally (trimmed `templateKey`, locale enum with an `'id'`
 *     default), so we forward the two form fields untouched. A
 *     validation failure surfaces as `InvalidEmailInputError` carrying
 *     the field-level error map.
 *
 * Side effect:
 *   - The service renders the chosen `mail_templates` row against the
 *     `{applicant_name, job_title, stage}` placeholders and enqueues the
 *     mail inside a transaction (Design §12.3).
 *
 * Response:
 *   - Success → `200 { ok: true, templateKey, toEmail }` (no admin
 *     detail page yet).
 *   - `InvalidEmailInputError`    → 422 `{ error: 'invalid_email_input', fields }`.
 *   - `MailTemplateNotFoundError` → 422 `{ error: 'unknown_template' }`.
 *   - `ApplicationNotFoundError`  → 404 (shared send404 shape).
 *
 * CSRF is enforced by the global middleware before this handler runs,
 * exactly as for the other admin POST routes.
 */
async function postApplicationEmail(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams; Body: EmailBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const applicationId = parseIdParam(request.params.id);
  if (applicationId === null) return send404(reply);

  const body = request.body ?? {};

  try {
    const result = await sendTemplatedEmail({
      applicationId,
      actorUserId: session.userId,
      scope: scopeForSession(session),
      input: {
        templateKey: body.templateKey,
        locale: body.locale,
      },
    });
    return reply.code(200).send({
      ok: true,
      templateKey: result.templateKey,
      toEmail: result.toEmail,
    });
  } catch (err) {
    // The email service re-exports the SAME `ApplicationNotFoundError`
    // class as the notes service, so the existing alias matches here.
    if (err instanceof NotesApplicationNotFoundError) return send404(reply);
    if (err instanceof MailTemplateNotFoundError) {
      return reply.code(422).send({ error: 'unknown_template' });
    }
    if (err instanceof InvalidEmailInputError) {
      return reply.code(422).send({
        error: 'invalid_email_input',
        fields: err.fieldErrors,
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId },
      'admin.applications.email: send failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/applications/:id/stage (stage transition — htmx)
// ---------------------------------------------------------------------------

/**
 * Transition an application to a new pipeline stage (Req 10.2).
 *
 * The `:id` segment is the APPLICATION primary key. The kanban card
 * partial (`views/partials/kanban-card.njk`) posts here via
 * `hx-post="/api/applications/:id/stage"` with `hx-swap="outerHTML"`,
 * so on success we re-render the SAME card partial and return it as an
 * HTML fragment — htmx swaps the moved card in place.
 *
 * Authorization:
 *   - `requireAdmin` with `allowedRoles` {Super_Admin, HR}.
 *     Department_Head is read-only on the kanban (task 29.1 strips the
 *     htmx hooks for Dept_Head sessions), so a stage change attempt by a
 *     Department_Head is rejected by the guard with a 403. We still
 *     thread `scopeForSession(session)` into the service as defence in
 *     depth — for HR / Super_Admin it resolves to `undefined` (no
 *     scoping), so the service applies no extra clause.
 *
 * Request body:
 *   - `stage` (card-menu select) or `newStage` (SortableJS drag payload)
 *     — the destination stage, validated against `PIPELINE_STAGES`.
 *   - `reason` (optional) — threaded into the audit + mail payloads.
 *
 * Responses:
 *   - 200 + re-rendered `kanban-card.njk` fragment on success.
 *   - 422 `invalid_stage`            — destination not a known stage.
 *   - 422 `invalid_stage_transition` — transition disallowed by the
 *     pipeline graph (`InvalidStageTransitionError`).
 *   - 404                            — application missing / out of scope
 *     (`ApplicationNotFoundError`, shared send404 shape).
 *
 * CSRF is enforced by the global middleware before this handler runs,
 * exactly as for the other admin POST routes; the card partial supplies
 * the token via the `X-CSRF-Token` request header.
 */
async function postApplicationStage(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams; Body: StageBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const applicationId = parseIdParam(request.params.id);
  if (applicationId === null) return send404(reply);

  const body = request.body ?? {};
  // Accept either `stage` (card-menu) or `newStage` (drag payload).
  const rawStage = asString(body.stage) || asString(body.newStage);
  if (!isPipelineStage(rawStage)) {
    return reply.code(422).send({
      error: 'invalid_stage',
      allowed: PIPELINE_STAGES,
    });
  }
  const newStage: PipelineStage = rawStage;
  const reason = asString(body.reason);

  try {
    await changeStage({
      applicationId,
      newStage,
      actorUserId: session.userId,
      scope: scopeForSession(session),
      reason: reason === '' ? null : reason,
    });
  } catch (err) {
    if (err instanceof StageApplicationNotFoundError) return send404(reply);
    if (err instanceof InvalidStageTransitionError) {
      return reply.code(422).send({
        error: 'invalid_stage_transition',
        from: err.from,
        to: err.to,
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId, newStage },
      'admin.applications.stage: transition failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  // Re-render the moved card so htmx (hx-swap="outerHTML") can replace
  // it in place. We read the freshly-updated row back through the
  // kanban-repo so the card reflects the new stage + badge colour.
  let card;
  try {
    card = await findKanbanCard(applicationId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, applicationId },
      'admin.applications.stage: card re-render read failed',
    );
    // The transition already committed; signal success to htmx and let
    // a board refresh reconcile the card if the re-read failed.
    return reply
      .code(200)
      .header('HX-Trigger', 'stage-changed')
      .type('text/html; charset=utf-8')
      .send('');
  }

  if (card === null) {
    // Should be unreachable — we just updated the row — but degrade
    // gracefully rather than 500 on a committed change.
    return reply
      .code(200)
      .header('HX-Trigger', 'stage-changed')
      .type('text/html; charset=utf-8')
      .send('');
  }

  const html = app.view('partials/kanban-card.njk', {
    card,
    canWrite: canWrite(session),
    csrfToken: session.csrfToken,
  });
  return reply
    .code(200)
    .header('HX-Trigger', 'stage-changed')
    .type('text/html; charset=utf-8')
    .send(html);
}

// ---------------------------------------------------------------------------
// POST /api/applications/bulk-stage (bulk stage transition)
// ---------------------------------------------------------------------------

/**
 * Parse the posted `applicationIds` into a list of positive integers.
 *
 * Accepts (defensively) three wire shapes:
 *   - a JSON array (`[1, 2, 3]` or `["1", "2"]`) — the htmx / JSON form,
 *   - a comma-separated string (`"1,2,3"`) — a plain form field,
 *   - a single scalar (number or numeric string).
 *
 * Returns `null` when the input is absent / not one of the accepted
 * shapes, or when ANY element fails to coerce to a positive integer —
 * the handler treats a `null` as a 422 (`invalid_application_ids`). An
 * EMPTY but well-formed list also returns `null` (Req 10.5 operates on a
 * non-empty multi-select).
 */
function parseApplicationIds(raw: unknown): number[] | null {
  let parts: unknown[];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === 'number') {
    parts = [raw];
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    // Tolerate a JSON-encoded array smuggled into a string field.
    if (trimmed.startsWith('[')) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (!Array.isArray(decoded)) return null;
      parts = decoded;
    } else {
      parts = trimmed.split(',');
    }
  } else {
    return null;
  }

  const ids: number[] = [];
  for (const part of parts) {
    const s = typeof part === 'number' ? String(part) : asString(part).trim();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    ids.push(n);
  }
  if (ids.length === 0) return null;
  return ids;
}

/**
 * Bulk-transition a multi-select of applications to a target stage
 * (Req 10.5, 10.6).
 *
 * The board's bulk-action bar posts a JSON body
 * `{ applicationIds: number[], stage, reason? }` here.
 *
 * Authorization:
 *   - `requireAdmin` with `allowedRoles` {Super_Admin, HR} — identical
 *     to the single stage endpoint (Department_Head is read-only on the
 *     kanban). We thread `scopeForSession(session)` into the service as
 *     defence in depth; for HR / Super_Admin it resolves to `undefined`.
 *
 * Validation (all up-front, before any transition runs):
 *   - `stage` must be a known `PIPELINE_STAGES` value → else 422
 *     `invalid_stage`.
 *   - `applicationIds` must be a non-empty list of positive ints (JSON
 *     array or comma-separated string accepted) → else 422
 *     `invalid_application_ids`.
 *   - a de-duplicated list larger than the service cap →
 *     `BulkStageBatchTooLargeError` → 422 `batch_too_large`.
 *
 * Response:
 *   - 200 `{ ok: true, results, succeeded, failed }`. A partial-failure
 *     batch STILL returns 200 — the per-row `results` carry each
 *     outcome (Req 10.6: report success / failure without aborting the
 *     batch). Only a malformed REQUEST (bad stage / ids / oversize) is a
 *     non-200.
 *
 * CSRF is enforced by the global middleware before this handler runs.
 */
async function postApplicationsBulkStage(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: BulkStageBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const body = request.body ?? {};

  const rawStage = asString(body.stage);
  if (!isPipelineStage(rawStage)) {
    return reply.code(422).send({
      error: 'invalid_stage',
      allowed: PIPELINE_STAGES,
    });
  }
  const newStage: PipelineStage = rawStage;

  const applicationIds = parseApplicationIds(body.applicationIds);
  if (applicationIds === null) {
    return reply.code(422).send({ error: 'invalid_application_ids' });
  }

  const reason = asString(body.reason);

  try {
    const { results } = await bulkChangeStage({
      applicationIds,
      newStage,
      actorUserId: session.userId,
      scope: scopeForSession(session),
      reason: reason === '' ? null : reason,
    });
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    return reply.code(200).send({ ok: true, results, succeeded, failed });
  } catch (err) {
    if (err instanceof BulkStageBatchTooLargeError) {
      return reply.code(422).send({
        error: 'batch_too_large',
        count: err.count,
        max: err.max,
      });
    }
    app.log.error(
      { err, userId: session.userId, newStage },
      'admin.applications.bulkStage: transition failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// Mail templates editor (Req 10.7, 12.1 — Design §6 Admin, §15)
// ---------------------------------------------------------------------------

/**
 * Build the sticky form-values map the edit view re-renders from. Mirrors
 * the `mail_templates` row shape so the template uses a single set of
 * accessors regardless of whether the data came from the DB or a failed
 * POST. `body_text` collapses `null` to `''` for the textarea.
 */
function templateToFormValues(
  record: MailTemplateRecord,
): Record<string, unknown> {
  return {
    key: record.key,
    locale: record.locale,
    subject: record.subject,
    body_html: record.body_html,
    body_text: record.body_text ?? '',
  };
}

/** Project a raw form body onto the same sticky form-values shape. */
function templateBodyToFormValues(
  body: MailTemplateBody,
): Record<string, unknown> {
  return {
    key: asString(body.key),
    locale: asString(body.locale),
    subject: asString(body.subject),
    body_html: asString(body.body_html),
    body_text: asString(body.body_text),
  };
}

/** Empty form values for `GET /admin/mail-templates/new`. */
function emptyTemplateFormValues(): Record<string, unknown> {
  return {
    key: '',
    locale: TEMPLATE_LOCALES[0],
    subject: '',
    body_html: '',
    body_text: '',
  };
}

/**
 * Render the canonical mail-template 404. The MVP keeps the response a
 * JSON shape — the polished admin 404 page lands later.
 */
function sendTemplate404(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'mail_template_not_found' });
}

// ---------------------------------------------------------------------------
// GET /admin/mail-templates (list)
// ---------------------------------------------------------------------------

/**
 * Render the mail-template list (Req 10.7). Restricted to {Super_Admin,
 * HR} — Department_Head does not manage mail templates (Req 11.3), so the
 * guard rejects a Dept_Head session with a 403.
 */
async function getMailTemplatesIndex(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: { saved?: unknown } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  let templates: MailTemplateRecord[];
  try {
    templates = await listMailTemplates();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'admin.mailTemplates: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = app.view('admin/mail-templates/index.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true,
    },
    templates,
    saved: asString(request.query?.saved) === '1',
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// GET /admin/mail-templates/new (create form)
// ---------------------------------------------------------------------------

async function getMailTemplateNew(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const html = app.view('admin/mail-templates/edit.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true,
    },
    mode: 'create',
    formAction: '/admin/mail-templates',
    values: emptyTemplateFormValues(),
    errors: {},
    generalError: null,
    locales: TEMPLATE_LOCALES,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// GET /admin/mail-templates/:key/:locale (edit form)
// ---------------------------------------------------------------------------

async function getMailTemplateEdit(
  app: FastifyInstance,
  request: FastifyRequest<{
    Params: MailTemplateParams;
    Querystring: { saved?: unknown };
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireAdmin(request, reply, {
    allowedRoles: ['Super_Admin', 'HR'],
  });
  if (session === null) return reply;

  const key = asString(request.params.key);
  const locale = asString(request.params.locale);

  let record: MailTemplateRecord | null;
  try {
    record = await getMailTemplate(key, locale);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, key, locale },
      'admin.mailTemplates: load failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
  if (record === null) return sendTemplate404(reply);

  const html = app.view('admin/mail-templates/edit.njk', {
    session: {
      userId: session.userId,
      role: session.role,
      canWrite: true,
    },
    mode: 'edit',
    formAction: '/admin/mail-templates',
    values: templateToFormValues(record),
    errors: {},
    generalError: null,
    saved: asString(request.query?.saved) === '1',
    locales: TEMPLATE_LOCALES,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// POST /admin/mail-templates (upsert)
// ---------------------------------------------------------------------------

/**
 * Upsert a mail template (Req 10.7). On `InvalidTemplateInputError` the
 * form re-renders with 422 + field errors; on success a 302 redirect to
 * the list with `?saved=1` (post-redirect-get). Restricted to
 * {Super_Admin, HR}; the audit row (`mail_template_change`) is written by
 * the service (stub → task 40.1).
 */
async function postMailTemplateSave(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: MailTemplateBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  // Migrated to the §14.1 policy guard (task 39.1). `mail_template.manage`
  // grants {Super_Admin, HR} (Req 11.3 — Department_Head does not manage
  // mail templates), matching the prior
  // `requireAdmin({ allowedRoles: ['Super_Admin', 'HR'] })`; a denied role
  // now gets the rendered 403 page + an `access_denied` audit event.
  const session = await requirePolicy('mail_template.manage')(request, reply);
  if (session === null) return reply;

  const body = request.body ?? {};

  try {
    await saveMailTemplate({
      actorUserId: session.userId,
      input: {
        key: body.key,
        locale: body.locale,
        subject: body.subject,
        bodyHtml: body.body_html,
        bodyText: body.body_text,
      },
    });
    return reply
      .code(302)
      .header('location', '/admin/mail-templates?saved=1')
      .send();
  } catch (err) {
    if (err instanceof InvalidTemplateInputError) {
      // A re-render distinguishes create vs edit by whether the posted
      // key already has a row; on a validation failure we cannot trust
      // the key, so default to the create form (no readonly lock) so the
      // operator can correct any field including the key.
      const html = app.view('admin/mail-templates/edit.njk', {
        session: {
          userId: session.userId,
          role: session.role,
          canWrite: true,
        },
        mode: 'create',
        formAction: '/admin/mail-templates',
        values: templateBodyToFormValues(body),
        errors: err.fieldErrors,
        generalError: null,
        locales: TEMPLATE_LOCALES,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
      });
      return reply.code(422).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId },
      'admin.mailTemplates: save failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /admin/audit (audit log filter UI — Super_Admin only)
// ---------------------------------------------------------------------------

/** Raw querystring shape for the audit filter form. */
interface AuditQuery {
  dateFrom?: unknown;
  dateTo?: unknown;
  actor?: unknown;
  actionType?: unknown;
  targetEntity?: unknown;
  page?: unknown;
}

/** Raw querystring shape for the reports filter form. */
interface ReportQuery {
  dateFrom?: unknown;
  dateTo?: unknown;
}

/**
 * Coerce the `?actor=` filter into a positive integer, or `null` when
 * absent / malformed. An invalid value collapses to "no actor filter"
 * rather than erroring — the form is a best-effort investigative tool.
 */
function parseActorParam(raw: unknown): number | null {
  const s = asString(raw);
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Render the audit-log filter UI (Req 12.3). Gated by
 * `requirePolicy('audit.read')` which grants {Super_Admin} only (design
 * §14.1): a non-Super_Admin internal role gets the rendered 403 page plus
 * an `access_denied` audit event; an unauthenticated request is bounced to
 * login by the underlying `requireAdmin`.
 *
 * Filters (date range, actor, action type, target entity) are read from
 * the querystring, normalised, and threaded into the parameterised read
 * query. The applied values are echoed back to the view so the form stays
 * sticky and the pagination links can preserve them.
 */
async function getAuditIndex(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: AuditQuery }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('audit.read')(request, reply);
  if (session === null) return reply;

  const q = request.query ?? {};
  const dateFrom = asString(q.dateFrom);
  const dateTo = asString(q.dateTo);
  const actor = parseActorParam(q.actor);
  const actionType = asString(q.actionType);
  const targetEntity = asString(q.targetEntity);
  const page = parsePageParam(q.page);

  const filter: AuditEventFilter = {
    dateFrom: dateFrom === '' ? null : dateFrom,
    dateTo: dateTo === '' ? null : dateTo,
    actor,
    actionType: actionType === '' ? null : actionType,
    targetEntity: targetEntity === '' ? null : targetEntity,
    page,
    pageSize: AUDIT_LIST_DEFAULT_PAGE_SIZE,
  };

  let result: PaginatedAuditEvents;
  try {
    result = await listAuditEvents(filter);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'admin.audit: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const totalPages = Math.max(
    1,
    Math.ceil(result.total / result.pageSize),
  );

  const html = app.view('admin/audit/index.njk', {
    session: {
      userId: session.userId,
      role: session.role,
    },
    actionTypes: ACTION_TYPES,
    filter: {
      dateFrom,
      dateTo,
      actor: actor === null ? '' : String(actor),
      actionType,
      targetEntity,
    },
    events: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// GET /admin/users (internal-user list + invite form — Super_Admin only)
// ---------------------------------------------------------------------------

/** Raw POST body for the invite form. */
interface InviteBody {
  email?: unknown;
  role?: unknown;
  /** Hidden CSRF field — read by the global middleware, not here. */
  _csrf?: unknown;
}

/**
 * Resolve the canonical absolute base URL for invite-accept links.
 * Mirrors the `BASE_URL`-with-localhost-fallback convention used by
 * `routes/seo.ts` and `routes/public.ts`, read lazily (not captured at
 * module-load) so deployments running under Passenger get whatever is
 * injected at request time and tests that mutate `process.env.BASE_URL`
 * see the updated value. A trailing slash is trimmed so the invite
 * service never emits `//`.
 */
function resolveBaseUrl(): string {
  const raw = process.env.BASE_URL ?? 'http://localhost:3000';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Render the internal-user list + invite form (Req 11.7). Gated by
 * `requirePolicy('user.invite')` which grants {Super_Admin} only (design
 * §14.1): a non-Super_Admin internal role gets the rendered 403 page plus
 * an `access_denied` audit event; an unauthenticated request is bounced to
 * login by the underlying `requireAdmin`.
 *
 * The `?invited=1` flash (post-redirect-get) renders a success banner.
 */
async function getUsersIndex(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: { invited?: unknown } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('user.invite')(request, reply);
  if (session === null) return reply;

  let users: InternalUserRecord[];
  try {
    users = await listInternalUsers();
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'admin.users: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const invited = asString(request.query?.invited) === '1';

  const html = app.view('admin/users/index.njk', {
    session: {
      userId: session.userId,
      role: session.role,
    },
    users,
    inviteRoles: INVITE_ROLES,
    invited,
    errors: {},
    generalError: null,
    values: { email: '', role: INVITE_ROLES[0] },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// Helpers for CSV streaming
// ---------------------------------------------------------------------------

/**
 * CSV-escape a single field value. Wraps the value in double-quotes and
 * escapes any internal double-quotes by doubling them (RFC 4180).
 */
function csvEscape(value: string): string {
  return ['"', value.replace(/"/g, '""'), '"'].join('');
}

/**
 * Format a Date as an ISO-8601 string (YYYY-MM-DDTHH:mm:ss.sssZ).
 * Falls back to empty string for invalid dates.
 */
function formatDate(d: Date): string {
  try {
    return d.toISOString();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// GET /admin/reports/jobs/:id/export.csv (CSV export — HR + Super_Admin)
// ---------------------------------------------------------------------------

/**
 * Stream the applications list for a job as a CSV file (Req 13.4, 13.5).
 * Gated by `requirePolicy('report.read')` which grants {Super_Admin, HR}
 * (design §14.1): Department_Head gets the rendered 403 page + an
 * `access_denied` audit event; an unauthenticated request is bounced to
 * login.
 *
 * Row cap: if the query returns more than 10,000 rows the handler returns
 * 422 JSON with `{ error: 'too_many_rows', count, suggestion }` (design
 * §16.3, Req 13 refinement).
 *
 * Streaming: uses `reply.raw` (Node.js `ServerResponse`) to write the CSV
 * incrementally without buffering the entire payload in memory.
 *
 * Signed URLs: each row's `cv_download_url` is a 60-minute HMAC-signed
 * link generated by `signCvDownloadUrl` (design §16.3).
 *
 * Audit: writes a `data_export` event after streaming (Req 13.5).
 */
async function getJobCsvExport(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('report.read')(request, reply);
  if (session === null) return reply;

  const jobId = parseIdParam(request.params.id);
  if (jobId === null) return send404(reply);

  let rows: ApplicationExportRow[];
  try {
    rows = await getApplicationsForExport(jobId, scopeForSession(session));
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId },
      'admin.reports: getApplicationsForExport failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  // Row cap check (design §16.3): > 10,000 rows → 422.
  if (rows.length > 10_000) {
    return reply.code(422).send({
      error: 'too_many_rows',
      count: rows.length,
      suggestion: 'Apply a date filter to narrow the export',
    });
  }

  const secret = process.env.SESSION_SECRET ?? 'dev-secret';
  const SIXTY_MINUTES = 60 * 60;

  // Set streaming headers before writing to reply.raw.
  reply.raw.setHeader('Content-Type', 'text/csv; charset=utf-8');
  reply.raw.setHeader(
    'Content-Disposition',
    ['attachment; filename="applications-', String(jobId), '.csv"'].join(''),
  );

  // Write CSV header row.
  reply.raw.write(
    'applicant_name,email,phone,current_stage,applied_at,cv_download_url\n',
  );

  // Write data rows.
  for (const row of rows) {
    const cvUrl = signCvDownloadUrl(row.cvFileId, SIXTY_MINUTES, secret);
    const csvRow = [
      csvEscape(row.fullName),
      csvEscape(row.email),
      csvEscape(row.phone ?? ''),
      csvEscape(row.stage),
      csvEscape(formatDate(row.appliedAt)),
      csvEscape(cvUrl),
    ].join(',');
    reply.raw.write(csvRow + '\n');
  }

  reply.raw.end();

  // Audit event after streaming (Req 13.5, design §16.3).
  try {
    await auditService.write({
      actorUserId: session.userId,
      actorIp: request.ip,
      actionType: 'data_export',
      targetEntity: 'job_posting',
      targetId: jobId,
      details: { jobId, rowCount: rows.length },
    });
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, jobId },
      'admin.reports: failed to write data_export audit event',
    );
  }
}

// ---------------------------------------------------------------------------
// GET /admin/reports (reporting dashboard — HR + Super_Admin)
// ---------------------------------------------------------------------------

/**
 * Render the reporting dashboard (Req 13.1, 13.2, 13.3). Gated by
 * `requirePolicy('report.read')` which grants {Super_Admin, HR} (design
 * §14.1): Department_Head gets the rendered 403 page + an `access_denied`
 * audit event; an unauthenticated request is bounced to login.
 *
 * Filters `?dateFrom=` and `?dateTo=` (YYYY-MM-DD) are read from the
 * querystring and threaded into the parameterised reporting queries. When
 * absent the queries default to the last 30 days. The applied values are
 * echoed back to the view so the filter form stays sticky.
 */
async function getReportsIndex(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: ReportQuery }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('report.read')(request, reply);
  if (session === null) return reply;

  const dateFrom = asString(request.query?.dateFrom);
  const dateTo = asString(request.query?.dateTo);

  const filter: ReportFilter = {
    dateFrom: dateFrom !== '' ? dateFrom : null,
    dateTo: dateTo !== '' ? dateTo : null,
  };

  let summary;
  try {
    summary = await getReportSummary(filter);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'admin.reports: getReportSummary failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = app.view('admin/reports.njk', {
    session: {
      userId: session.userId,
      role: session.role,
    },
    filter: {
      dateFrom: dateFrom !== '' ? dateFrom : null,
      dateTo: dateTo !== '' ? dateTo : null,
    },
    summary,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// POST /admin/users/invite (invite a new internal user — Super_Admin only)
// ---------------------------------------------------------------------------

/**
 * Re-render the users page after a failed invite (validation error or a
 * duplicate email). Re-loads the list so the table stays fresh, threads
 * the sticky form values + per-field errors, and returns the supplied
 * HTTP status.
 */
async function renderInviteError(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  session: AdminSession,
  status: number,
  body: InviteBody,
  errors: Record<string, readonly string[]>,
  generalError: string | null,
): Promise<FastifyReply> {
  let users: InternalUserRecord[] = [];
  try {
    users = await listInternalUsers();
  } catch (err) {
    // Non-fatal: the form still renders, the table is just empty.
    app.log.error(
      { err, userId: session.userId },
      'admin.users: list failed during invite re-render',
    );
  }

  const html = app.view('admin/users/index.njk', {
    session: {
      userId: session.userId,
      role: session.role,
    },
    users,
    inviteRoles: INVITE_ROLES,
    invited: false,
    errors,
    generalError,
    values: {
      email: asString(body.email),
      role: asString(body.role) || INVITE_ROLES[0],
    },
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(status).type('text/html; charset=utf-8').send(html);
}

/**
 * Invite a new internal user (Req 11.7). Gated by
 * `requirePolicy('user.invite')` (Super_Admin only, design §14.1).
 *
 * The service performs the whole invite — pending account +
 * `invitation_tokens` (7-day expiry) + `user_invite` mail enqueue +
 * `role_change` audit — inside ONE transaction. On success we 302 back to
 * the list with `?invited=1`. A validation failure re-renders the form
 * (422); a duplicate email re-renders gracefully (422 + field error)
 * without leaking whether the address already existed beyond the form.
 */
async function postUserInvite(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: InviteBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('user.invite')(request, reply);
  if (session === null) return reply;

  const body = request.body ?? {};

  try {
    const result = await inviteUser({
      actorUserId: session.userId,
      actorIp: request.ip,
      baseUrl: resolveBaseUrl(),
      input: { email: asString(body.email), role: asString(body.role) },
    });

    if (result.ok) {
      return reply
        .code(302)
        .header('location', '/admin/users?invited=1')
        .send();
    }

    // Graceful duplicate-email: re-render with a field error (no crash).
    return renderInviteError(
      app,
      request,
      reply,
      session,
      422,
      body,
      { email: ['An account with this email already exists'] },
      null,
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
        null,
      );
    }

    app.log.error(
      { err, userId: session.userId },
      'admin.users: invite failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// GET /admin/backups        — list backup files (Super_Admin only, Req 18.4)
// GET /admin/backups/:filename — stream download (Super_Admin only, Req 18.4)
// ---------------------------------------------------------------------------

/**
 * Filename pattern for valid backup files (Design §17).
 * Matches: db-YYYY-MM-DD.sql.gz  or  files-YYYY-MM-DD.tar.gz
 * Used to prevent path traversal on the download endpoint.
 */
const BACKUP_FILENAME_RE =
  /^(db|files)-\d{4}-\d{2}-\d{2}\.(sql\.gz|tar\.gz)$/;

interface BackupFileEntry {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mtime: string; // ISO string
  readonly isMonthly: boolean;
}

interface BackupFilenameParams {
  filename: string;
}

/**
 * Collect backup file entries from a directory. Returns an empty array
 * when the directory does not exist.
 */
async function collectBackupEntries(
  dir: string,
  isMonthly: boolean,
): Promise<BackupFileEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const entries: BackupFileEntry[] = [];
  for (const filename of names) {
    if (!BACKUP_FILENAME_RE.test(filename)) continue;
    try {
      const s = await fs.stat(path.join(dir, filename));
      entries.push({
        filename,
        sizeBytes: s.size,
        mtime: s.mtime.toISOString(),
        isMonthly,
      });
    } catch {
      // Skip unreadable entries
    }
  }
  return entries;
}

/**
 * GET /admin/backups — list daily + monthly backup files.
 * Super_Admin only (requirePolicy('backup.read')).
 * Validates: Requirement 18.4
 */
async function getBackupsIndex(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('backup.read')(request, reply);
  if (session === null) return reply;

  const backupDir = path.join(os.homedir(), 'backups');
  const monthlyDir = path.join(backupDir, 'monthly');

  let dailyEntries: BackupFileEntry[];
  let monthlyEntries: BackupFileEntry[];
  try {
    [dailyEntries, monthlyEntries] = await Promise.all([
      collectBackupEntries(backupDir, false),
      collectBackupEntries(monthlyDir, true),
    ]);
  } catch (err) {
    app.log.error({ err, userId: session.userId }, 'admin.backups: list failed');
    return reply.code(500).send({ error: 'internal_error' });
  }

  // Sort newest first
  const sortByMtime = (a: BackupFileEntry, b: BackupFileEntry) =>
    b.mtime.localeCompare(a.mtime);
  dailyEntries.sort(sortByMtime);
  monthlyEntries.sort(sortByMtime);

  const html = app.view('admin/backups/index.njk', {
    session: { userId: session.userId, role: session.role },
    dailyFiles: dailyEntries,
    monthlyFiles: monthlyEntries,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /admin/backups/:filename — stream a backup file as an attachment.
 * Super_Admin only (requirePolicy('backup.read')).
 * Validates: Requirement 18.4
 *
 * Security:
 *   - `filename` is validated against BACKUP_FILENAME_RE before any
 *     filesystem access, preventing path traversal.
 *   - The route is already behind requirePolicy('backup.read') which
 *     admits only Super_Admin, so no additional signed-URL layer is
 *     needed (direct streaming is acceptable per task brief).
 */
async function getBackupDownload(
  _app: FastifyInstance,
  request: FastifyRequest<{ Params: BackupFilenameParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('backup.read')(request, reply);
  if (session === null) return reply;

  const { filename } = request.params;

  // Validate filename to prevent path traversal (Req 15.4 / security)
  if (!BACKUP_FILENAME_RE.test(filename)) {
    return reply.code(400).send({ error: 'invalid_filename' });
  }

  // Check both daily and monthly directories
  const backupDir = path.join(os.homedir(), 'backups');
  const monthlyDir = path.join(backupDir, 'monthly');

  let filePath: string | null = null;
  for (const dir of [backupDir, monthlyDir]) {
    const candidate = path.join(dir, filename);
    try {
      await fs.stat(candidate);
      filePath = candidate;
      break;
    } catch {
      // Not in this directory — try next
    }
  }

  if (filePath === null) {
    return reply.code(404).send({ error: 'backup_not_found' });
  }

  // Stream the file with Content-Disposition: attachment (Req 15.6 pattern)
  reply
    .code(200)
    .header('Content-Disposition', ['attachment; filename="', filename, '"'].join(''))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store');

  // Determine content type from extension
  if (filename.endsWith('.sql.gz') || filename.endsWith('.tar.gz')) {
    reply.header('Content-Type', 'application/gzip');
  }

  // Use Fastify's sendFile-equivalent: pipe via reply.raw
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(filePath);
  return reply.send(stream);
}

// ---------------------------------------------------------------------------
// GET /admin/diagnostics (Super_Admin only — design §18.3, Req 20.4)
// ---------------------------------------------------------------------------

interface CronLockRow extends RowDataPacket {
  name: string;
  last_run_at: Date | null;
  last_status: 'ok' | 'error' | null;
}

interface MailPendingRow extends RowDataPacket {
  n: number | string;
}

/**
 * Collect system diagnostics in parallel and return a JSON payload.
 *
 * Fields returned (design §18.3):
 *   - uptime_seconds   — process.uptime()
 *   - node_version     — process.version
 *   - memory_rss_bytes — process.memoryUsage().rss
 *   - mail_pending     — COUNT(*) of mail_outbox WHERE status='pending'
 *   - cron_locks       — [{name, last_run_at, last_status}] ORDER BY name ASC
 *   - backup_mtime     — ISO string of the most recent file mtime in
 *                        ~/backups/, or null if the directory does not exist
 */
async function getDiagnostics(
  _app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requirePolicy('diagnostics.read')(request, reply);
  if (session === null) return reply;

  const backupDir = path.join(process.env.HOME ?? '/tmp', 'backups');

  const [mailRows, cronRows, backupMtime] = await Promise.all([
    // Pending mail count
    query<MailPendingRow[]>(
      [
        'SELECT COUNT(*) AS n',
        'FROM mail_outbox',
        "WHERE status = 'pending'",
      ].join(' '),
      [],
    ),

    // Cron lock telemetry
    query<CronLockRow[]>(
      [
        'SELECT name, last_run_at, last_status',
        'FROM cron_locks',
        'ORDER BY name ASC',
      ].join(' '),
      [],
    ),

    // Latest backup mtime — gracefully returns null if dir absent
    (async (): Promise<string | null> => {
      try {
        const entries = await fs.readdir(backupDir);
        if (entries.length === 0) return null;
        const mtimes = await Promise.all(
          entries.map(async (entry) => {
            const stat = await fs.stat(path.join(backupDir, entry));
            return stat.mtimeMs;
          }),
        );
        const latest = Math.max(...mtimes);
        return new Date(latest).toISOString();
      } catch {
        // Directory does not exist or is not readable
        return null;
      }
    })(),
  ]);

  const pendingCount = Number((mailRows[0] as MailPendingRow | undefined)?.n ?? 0);

  return reply.code(200).send({
    uptime_seconds: process.uptime(),
    node_version: process.version,
    memory_rss_bytes: process.memoryUsage().rss,
    mail_pending: pendingCount,
    cron_locks: cronRows.map((row) => ({
      name: row.name,
      last_run_at: row.last_run_at ? (row.last_run_at instanceof Date ? row.last_run_at.toISOString() : row.last_run_at) : null,
      last_status: row.last_status ?? null,
    })),
    backup_mtime: backupMtime,
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Admin route plugin. Mounted at the application root with no prefix —
 * admin pages are not locale-prefixed in this MVP.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ListQuery }>(
    '/admin/jobs',
    (request, reply) => getJobsIndex(app, request, reply),
  );

  app.get(
    '/admin/jobs/new',
    (request, reply) => getJobNew(app, request, reply),
  );

  app.post<{ Body: JobBody }>(
    '/admin/jobs',
    (request, reply) => postJobCreate(app, request, reply),
  );

  // The `/clone` GET must be registered BEFORE the catch-all `/:id` GET
  // so Fastify's radix-tree routing dispatches correctly: an `:id` param
  // route would otherwise swallow `clone` as the id.
  app.get<{ Params: IdParams }>(
    '/admin/jobs/:id/clone',
    (request, reply) => getJobClone(app, request, reply),
  );

  app.post<{ Params: IdParams; Body: CloneBody }>(
    '/admin/jobs/:id/clone',
    (request, reply) => postJobClone(app, request, reply),
  );

  // Kanban board — same registration-order rule as `/clone`. The
  // catch-all `/admin/jobs/:id` route below would happily match
  // `/admin/jobs/42/kanban` with `id="42/kanban"` if registered
  // first, which would yield a 404 from `parseIdParam`.
  app.get<{ Params: IdParams }>(
    '/admin/jobs/:id/kanban',
    (request, reply) => getJobKanban(app, request, reply),
  );

  app.post<{ Params: IdParams }>(
    '/admin/jobs/:id/publish',
    (request, reply) => postJobStatus(app, 'publish', request, reply),
  );

  app.post<{ Params: IdParams }>(
    '/admin/jobs/:id/close',
    (request, reply) => postJobStatus(app, 'close', request, reply),
  );

  app.post<{ Params: IdParams }>(
    '/admin/jobs/:id/archive',
    (request, reply) => postJobStatus(app, 'archive', request, reply),
  );

  app.get<{ Params: IdParams; Querystring: { saved?: unknown } }>(
    '/admin/jobs/:id',
    (request, reply) => getJobEdit(app, request, reply),
  );

  app.post<{ Params: IdParams; Body: JobBody }>(
    '/admin/jobs/:id',
    (request, reply) => postJobUpdate(app, request, reply),
  );

  // Schedule interview. The `:id` here is an APPLICATION id and lives
  // under the `/admin/applications` segment, so it is NOT shadowed by
  // the `/admin/jobs/:id` catch-all above (different first segment).
  // Registered explicitly here to keep all admin routes in one place.
  app.post<{ Params: IdParams; Body: InterviewBody }>(
    '/admin/applications/:id/interview',
    (request, reply) => postScheduleInterview(app, request, reply),
  );

  // Application notes. The `:id` here is an APPLICATION id and lives
  // under the `/admin/applications` segment with a DISTINCT trailing
  // segment (`/notes` vs `/interview`), so it is not shadowed by the
  // interview route above nor by the `/admin/jobs/:id` catch-all
  // (different first segment). Registered explicitly here to keep all
  // admin routes in one place.
  app.get<{ Params: IdParams }>(
    '/admin/applications/:id/notes',
    (request, reply) => getApplicationNotes(app, request, reply),
  );

  app.post<{ Params: IdParams; Body: NoteBody }>(
    '/admin/applications/:id/notes',
    (request, reply) => postApplicationNote(app, request, reply),
  );

  // Templated email. The `:id` here is an APPLICATION id and lives under
  // the `/admin/applications` segment with a DISTINCT trailing segment
  // (`/email` vs `/notes` vs `/interview`), so it is not shadowed by the
  // notes/interview routes above nor by the `/admin/jobs/:id` catch-all
  // (different first segment). Registered explicitly here to keep all
  // admin routes in one place.
  app.post<{ Params: IdParams; Body: EmailBody }>(
    '/admin/applications/:id/email',
    (request, reply) => postApplicationEmail(app, request, reply),
  );

  // Stage transition (htmx). The `:id` is an APPLICATION id and lives
  // under the `/api/applications` segment — distinct from both
  // `/admin/jobs/:id` and `/admin/applications/:id`, so it is not
  // shadowed by any catch-all route above. The kanban-card partial
  // posts here with `hx-swap="outerHTML"`; the handler returns the
  // re-rendered card fragment.
  app.post<{ Params: IdParams; Body: StageBody }>(
    '/api/applications/:id/stage',
    (request, reply) => postApplicationStage(app, request, reply),
  );

  // Bulk stage transition (Req 10.5, 10.6). A STATIC path under the
  // `/api/applications` segment. It must be registered so it cannot be
  // shadowed by `/api/applications/:id/stage`: the param route only
  // matches a `:id/stage` two-segment tail, whereas this is the single
  // static segment `bulk-stage`, so Fastify's radix tree dispatches them
  // unambiguously. Restricted to {Super_Admin, HR} inside the handler.
  app.post<{ Body: BulkStageBody }>(
    '/api/applications/bulk-stage',
    (request, reply) => postApplicationsBulkStage(app, request, reply),
  );

  // Mail templates editor (Req 10.7, 12.1). All under the distinct
  // `/admin/mail-templates` first segment, so none of these are shadowed
  // by the `/admin/jobs/:id` or `/admin/applications/:id` routes above.
  // Restricted to {Super_Admin, HR} inside each handler.
  app.get<{ Querystring: { saved?: unknown } }>(
    '/admin/mail-templates',
    (request, reply) => getMailTemplatesIndex(app, request, reply),
  );

  // The static `/new` GET must be registered BEFORE the `/:key/:locale`
  // catch-all so Fastify's radix tree dispatches `new` as the literal
  // create-form path rather than treating it as a `:key` param. (The
  // param route is two segments, so the conflict is only theoretical, but
  // we keep the same registration-order discipline used by `/jobs/new`.)
  app.get(
    '/admin/mail-templates/new',
    (request, reply) => getMailTemplateNew(app, request, reply),
  );

  app.post<{ Body: MailTemplateBody }>(
    '/admin/mail-templates',
    (request, reply) => postMailTemplateSave(app, request, reply),
  );

  app.get<{
    Params: MailTemplateParams;
    Querystring: { saved?: unknown };
  }>(
    '/admin/mail-templates/:key/:locale',
    (request, reply) => getMailTemplateEdit(app, request, reply),
  );

  // Audit log filter UI (Req 12.3). A STATIC path under the distinct
  // `/admin/audit` first segment, so it is not shadowed by any of the
  // `/admin/jobs/:id`, `/admin/applications/:id`, or
  // `/admin/mail-templates/...` routes above. Gated by
  // `requirePolicy('audit.read')` (Super_Admin only, design §14.1) inside
  // the handler — a denied internal role gets the rendered 403 page + an
  // `access_denied` audit event.
  app.get<{ Querystring: AuditQuery }>(
    '/admin/audit',
    (request, reply) => getAuditIndex(app, request, reply),
  );

  // Internal-user management (Req 11.7, 12.1). Both routes sit under the
  // distinct `/admin/users` first segment, so neither is shadowed by the
  // `/admin/jobs/:id`, `/admin/applications/:id`, `/admin/mail-templates`,
  // or `/admin/audit` routes above. Gated by `requirePolicy('user.invite')`
  // (Super_Admin only, design §14.1) inside each handler — a denied
  // internal role gets the rendered 403 page + an `access_denied` audit
  // event. The static `/invite` POST cannot collide with the list GET
  // (different method + path), so registration order is irrelevant here.
  app.get<{ Querystring: { invited?: unknown } }>(
    '/admin/users',
    (request, reply) => getUsersIndex(app, request, reply),
  );

  app.post<{ Body: InviteBody }>(
    '/admin/users/invite',
    (request, reply) => postUserInvite(app, request, reply),
  );

  // CSV export for a specific job (Req 13.4, 13.5). A STATIC-prefix path
  // under `/admin/reports/jobs/:id/export.csv`. This route MUST be
  // registered BEFORE the `/admin/reports` GET route below so Fastify's
  // radix tree does not confuse the two (different path depth, but we
  // keep the ordering discipline consistent). Gated by
  // `requirePolicy('report.read')` (HR + Super_Admin, design §14.1)
  // inside the handler.
  app.get<{ Params: IdParams }>(
    '/admin/reports/jobs/:id/export.csv',
    (request, reply) => getJobCsvExport(app, request, reply),
  );

  // Reports dashboard (Req 13.1-13.3). A STATIC path under the distinct
  // `/admin/reports` first segment, so it is not shadowed by any of the
  // `/admin/jobs/:id`, `/admin/applications/:id`, `/admin/mail-templates`,
  // `/admin/audit`, or `/admin/users` routes above. Gated by
  // `requirePolicy('report.read')` (HR + Super_Admin, design §14.1) inside
  // the handler — Department_Head gets the rendered 403 page + an
  // `access_denied` audit event.
  app.get<{ Querystring: ReportQuery }>(
    '/admin/reports',
    (request, reply) => getReportsIndex(app, request, reply),
  );

  // Diagnostics endpoint (Req 20.4, design §18.3). A STATIC path under the
  // distinct `/admin/diagnostics` first segment. Gated by
  // `requirePolicy('diagnostics.read')` (Super_Admin only) inside the
  // handler — any other internal role gets the rendered 403 page + an
  // `access_denied` audit event.
  app.get(
    '/admin/diagnostics',
    (request, reply) => getDiagnostics(app, request, reply),
  );

  // Backup list + download (Req 18.4, design §17). Both routes sit under
  // the distinct `/admin/backups` first segment. The static list GET must
  // be registered BEFORE the `/:filename` param route so Fastify's radix
  // tree dispatches the list correctly. Gated by
  // `requirePolicy('backup.read')` (Super_Admin only, design §14.1) inside
  // each handler.
  app.get(
    '/admin/backups',
    (request, reply) => getBackupsIndex(app, request, reply),
  );

  app.get<{ Params: BackupFilenameParams }>(
    '/admin/backups/:filename',
    (request, reply) => getBackupDownload(app, request, reply),
  );
};

export default adminRoutes;
