/**
 * Applicant_Area route plugin for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 16.1 (profile main service + endpoint),
 *           task 17.1 (CV upload pipeline endpoint).
 * Design  : §6 Applicant_Area, §8.4 (session lifecycle), §8.6 (CSRF), §9
 * Validates: Requirements 4.1, 4.5, 4.6, 4.7, 4.8, 3.5, 15.5
 *
 * Scope of THIS file:
 *   - GET  /:locale/me/profile  → render `views/applicant/profile.njk` with
 *                                  the current `applicants` row hydrated
 *                                  into the form. A flash query parameter
 *                                  (`?saved=1`) flips the page into the
 *                                  "saved successfully" state after the
 *                                  POST/redirect handshake.
 *   - POST /:locale/me/profile  → validate the form via `profileSchema`,
 *                                  UPDATE the applicants row, then 302
 *                                  back to the GET (Post/Redirect/Get
 *                                  pattern). Validation errors render the
 *                                  form back with field-level messages
 *                                  rather than redirecting.
 *
 * Authentication:
 *   - Both endpoints sit behind `requireApplicant()` from
 *     `src/infra/auth-guard.ts` — the helper reads the `__Host-sid`
 *     cookie, resolves the session via the MySQL session-store
 *     (which already enforces idle / absolute timeouts), and either
 *     returns the canonical `SessionRecord` or short-circuits the
 *     response with a 302 to `/{locale}/login` and returns `null`. We
 *     early-return in both branches when the session is missing.
 *   - The full RBAC policy framework (task 39.1) lands later. For now,
 *     `requireApplicant` enforces that the role is exactly "Applicant"
 *     so internal users cannot stray into the Applicant_Area. Once the
 *     policy framework is wired we can swap this guard for the
 *     `requirePolicy('applicant.profile.read'/'.update')` calls without
 *     changing the route shape.
 *
 * CSRF:
 *   - The CSRF middleware (`src/infra/csrf.ts`) is wired at the
 *     application level. Every authenticated POST without a matching
 *     `X-CSRF-Token` / `_csrf` token is rejected with 403 before this
 *     handler runs, so the form template just has to include the
 *     hidden `_csrf` field for non-htmx submissions (the layout does
 *     this via `<meta name="csrf-token">` for htmx fragments).
 *
 * Audit:
 *   - The lightweight audit event is logged inside `updateProfile`
 *     itself (`pino.info({ event: 'profile_update' })`). The richer
 *     `audit_events` row arrives with task 38.1 + 40 — when that lands
 *     we wire the route to the audit-writer service without changing
 *     the service contract here.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ZodError, z } from 'zod';

import { requireApplicant } from '../infra/auth-guard.js';
import { zodErrorToFieldMap } from './_zod-helpers.js';
import {
  computeCompleteness,
  type CompletenessInput,
} from '../modules/applicant/completeness.js';
import {
  ALLOWED_CV_MIMES,
  FileTooLargeError,
  MAX_CV_BYTES,
  MAX_CV_HISTORY,
  MimeMismatchError,
  hasActiveCvForOwner,
  listCvsForOwner,
  loadCvForDownload,
  processCvUpload,
  type CvFileRecord,
} from '../modules/applicant/cv.js';
import {
  EMPLOYMENT_TYPES,
  ExperienceCapError,
  ExperienceNotFoundError,
  MAX_EXPERIENCE_ENTRIES,
  createExperience,
  deleteExperience,
  experienceSchema,
  findExperienceById,
  listExperience,
  updateExperience,
  type ExperienceInput,
  type ExperienceRecord,
} from '../modules/applicant/experience.js';
import {
  loadProfile,
  updateProfile,
  type ProfileRecord,
} from '../modules/applicant/profile.js';
import {
  EducationCapError,
  EducationNotFoundError,
  MAX_EDUCATION_ENTRIES,
  createEducation,
  deleteEducation,
  findEducationById,
  listEducation,
  updateEducation,
  type EducationRecord,
} from '../modules/applicant/education.js';
import { InsufficientStorageError } from '../infra/disk.js';
import {
  MAX_SKILLS_PER_APPLICANT,
  SkillCapError,
  SkillInactiveError,
  SkillNotFoundError,
  listAssignedSkills,
  searchSkills,
  skillIdSchema,
  toggleSkill,
  type SkillTag,
} from '../modules/applicant/skills.js';
import {
  APPLICATION_LIST_DEFAULT_PAGE_SIZE,
  findOneForApplicant,
  listForApplicant,
  type SupportedLocale as ApplicationLocale,
} from '../modules/applications/queries.js';
import {
  ApplicationNotFoundError,
  DuplicateApplicationError,
  IncompleteProfileError,
  JobUnavailableError,
  MissingCvError,
  WithdrawNotAllowedError,
  applyToJob,
  withdrawApplication,
  type ApplyToJobResult,
} from '../modules/applications/service.js';
import {
  JobNotFoundError as BookmarkJobNotFoundError,
  list as listBookmarks,
  toggle as toggleBookmark,
  type BookmarkRow,
} from '../modules/bookmarks/service.js';
import {
  AlertCapError,
  AlertNotFoundError,
  InvalidAlertInputError,
  MAX_ALERTS_PER_APPLICANT,
  createAlert,
  listAlerts,
  removeAlert,
} from '../modules/alerts/service.js';
import type { AlertRow } from '../modules/alerts/repo.js';
import {
  exportApplicantData,
} from '../modules/applicant/data-export.js';
import {
  CURRENT_POLICY_VERSION,
  recordAcceptance,
} from '../modules/applicant/consent.js';
import {
  scheduleAccountDeletion,
} from '../modules/applicant/account-deletion.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from '../infra/session-store.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
} from '../infra/csrf.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed locale segments for the URL `:locale` parameter. */
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['id', 'en']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocaleParams {
  locale: string;
}

/** Query string for `GET /:locale/me/profile`. */
interface ProfileQuery {
  /** `?saved=1` after a successful POST → render the "saved" state. */
  saved?: unknown;
}

/**
 * Raw shape we accept from the form before normalisation. Every field is
 * `unknown` because Fastify's `formbody` parses everything as strings (or
 * arrays of strings); the route normalises and `profileSchema` validates
 * downstream.
 */
interface ProfileBody {
  full_name?: unknown;
  date_of_birth?: unknown;
  gender?: unknown;
  phone?: unknown;
  address?: unknown;
  city?: unknown;
  province?: unknown;
  country?: unknown;
  summary?: unknown;
  language_pref?: unknown;
  /** Hidden CSRF field — read by the global CSRF middleware, not here. */
  _csrf?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an unknown value into a plain string. Used for form fields
 * that could be `string`, `string[]` (duplicate inputs), or absent. We
 * pick the FIRST string value so a malicious double-post cannot smuggle
 * an alternate value past the visible field.
 */
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string') as string | undefined;
    return typeof first === 'string' ? first : '';
  }
  return '';
}

/** Resolve the locale from `request.params`, falling back to `'id'`. */
function resolveLocale(request: FastifyRequest<{ Params: LocaleParams }>): string {
  const raw = request.params.locale;
  return SUPPORTED_LOCALES.has(raw) ? raw : 'id';
}

/**
 * Convert the parsed `ProfileRecord` into the form-field shape the view
 * expects. Nullable columns become empty strings so `<input value="…">`
 * renders cleanly. The `language_pref` column is non-nullable on the
 * row but we still default it to `'id'` defensively.
 */
function profileRecordToFormFields(
  record: ProfileRecord,
): Record<string, string> {
  return {
    full_name: record.full_name,
    date_of_birth: record.date_of_birth ?? '',
    gender: record.gender ?? '',
    phone: record.phone ?? '',
    address: record.address ?? '',
    city: record.city ?? '',
    province: record.province ?? '',
    country: record.country ?? '',
    summary: record.summary ?? '',
    language_pref: record.language_pref ?? 'id',
  };
}

/**
 * Convert the raw form body into the shape the view will re-render.
 * Identical to `profileRecordToFormFields` but sourced from the failed
 * submission rather than the persisted row, so the user sees the
 * values they typed (including the failed ones) rather than the
 * pre-edit state.
 */
function formBodyToFormFields(body: ProfileBody): Record<string, string> {
  return {
    full_name: asString(body.full_name),
    date_of_birth: asString(body.date_of_birth),
    gender: asString(body.gender),
    phone: asString(body.phone),
    address: asString(body.address),
    city: asString(body.city),
    province: asString(body.province),
    country: asString(body.country),
    summary: asString(body.summary),
    language_pref: asString(body.language_pref) || 'id',
  };
}

// ---------------------------------------------------------------------------
// GET /:locale/me/profile
// ---------------------------------------------------------------------------

/**
 * Render the profile form for the authenticated applicant.
 *
 * Pipeline:
 *   1. Authenticate via `requireApplicant`. Missing / non-Applicant
 *      sessions cause a 302 to login and we return.
 *   2. Reject unsupported locales with 404 (matches the auth routes).
 *   3. Load the applicants row. A NULL row should not happen — the
 *      registration service inserts it inside the same transaction
 *      as the user — but we surface it as a 500 if it ever does, so
 *      the issue is loud rather than silently rendering an empty form
 *      that POST would 0-affect.
 *   4. Render the view with sticky values, no errors, and the `?saved=1`
 *      flash flag if present.
 */
async function getProfile(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Querystring: ProfileQuery }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const session = await requireApplicant(request, reply);
  if (session === null) {
    // requireApplicant has already finalised the response (302 to login).
    return reply;
  }

  const locale = resolveLocale(request);

  let record: ProfileRecord | null;
  try {
    record = await loadProfile(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.profile: load failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  if (record === null) {
    // The registration service guarantees this row exists — if it does
    // not, something is structurally wrong. Surface as a 500 rather than
    // rendering a blank form whose POST would silently 0-affect.
    app.log.error(
      { userId: session.userId },
      'applicant.profile: applicants row missing for authenticated user',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const saved = asString(request.query?.saved) === '1';

  const html = app.view('applicant/profile.njk', {
    locale,
    form: profileRecordToFormFields(record),
    errors: {},
    generalError: null,
    saved,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// POST /:locale/me/profile
// ---------------------------------------------------------------------------

/**
 * Handle a profile submission. Pipeline:
 *   1. Authenticate via `requireApplicant`.
 *   2. Reject unsupported locales with 404.
 *   3. Pass the raw body straight to `updateProfile(userId, body)` —
 *      the service layer parses through `profileSchema` and either
 *      throws `ZodError` (re-render the form with field errors) or
 *      writes the row + emits the audit log.
 *   4. On success, 302 back to the GET with `?saved=1` so a refresh of
 *      the destination does not re-submit the form (Post/Redirect/Get
 *      pattern).
 */
async function postProfile(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: ProfileBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }

  const locale = resolveLocale(request);
  const body = request.body ?? {};

  // Strip the CSRF field before handing the body to the schema —
  // `profileSchema` is `.strict()` and would reject the extra key.
  const { _csrf: _csrfDiscarded, ...payload } = body;
  void _csrfDiscarded;

  try {
    await updateProfile(session.userId, payload);
  } catch (err) {
    if (err instanceof ZodError) {
      const errors = zodErrorToFieldMap(err);
      const html = app.view('applicant/profile.njk', {
        locale,
        form: formBodyToFormFields(body),
        errors,
        generalError: null,
        saved: false,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
      });
      return reply.code(400).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId },
      'applicant.profile: update failed',
    );
    const html = app.view('applicant/profile.njk', {
      locale,
      form: formBodyToFormFields(body),
      errors: {},
      generalError:
        locale === 'en'
          ? 'We could not save your profile. Please try again.'
          : 'Profil Anda tidak dapat disimpan. Silakan coba lagi.',
      saved: false,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
    });
    return reply.code(500).type('text/html; charset=utf-8').send(html);
  }

  // Post/Redirect/Get — refreshing the destination must not re-submit.
  return reply
    .code(302)
    .header('location', `/${locale}/me/profile?saved=1`)
    .send();
}

// ---------------------------------------------------------------------------
// Education routes (task 16.2 — Req 4.2)
// ---------------------------------------------------------------------------

/**
 * Raw form shape for create / update. Every field is `unknown` because
 * Fastify's `formbody` parser returns strings (or arrays of strings)
 * before the schema normalises them.
 */
interface EducationBody {
  institution?: unknown;
  degree?: unknown;
  field?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  in_progress?: unknown;
  gpa?: unknown;
  /** Hidden CSRF field — the global middleware verifies it before the handler runs. */
  _csrf?: unknown;
}

/** URL params for routes that target a specific education id. */
interface EducationIdParams extends LocaleParams {
  id: string;
}

/**
 * Coerce the `:id` URL segment into a positive integer or return `null`.
 * The cast is strict (`Number.isInteger` + positive) so a path like
 * `/me/profile/education/abc/edit` never reaches the service layer.
 */
function parseIdParam(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Mirror raw form values back into a `Record<string, string>` so a
 * failed submission can re-render the form without losing what the
 * user typed. Identical pattern to `formBodyToFormFields` for the
 * profile route.
 */
function educationBodyToFormValues(
  body: EducationBody,
): Record<string, unknown> {
  return {
    institution: asString(body.institution),
    degree: asString(body.degree),
    field: asString(body.field),
    start_date: asString(body.start_date),
    end_date: asString(body.end_date),
    in_progress:
      asString(body.in_progress).toLowerCase() === 'on' ||
      asString(body.in_progress).toLowerCase() === 'true' ||
      asString(body.in_progress) === '1',
    gpa: asString(body.gpa),
  };
}

/**
 * Convert a stored `EducationRecord` into the loose `values` map the
 * row partial expects (string-friendly so `<input value=…>` renders
 * cleanly, plus a real boolean for `in_progress`).
 */
function educationRecordToFormValues(
  edu: EducationRecord,
): Record<string, unknown> {
  return {
    institution: edu.institution,
    degree: edu.degree,
    field: edu.field,
    start_date: edu.start_date,
    end_date: edu.end_date ?? '',
    in_progress: edu.in_progress,
    gpa: edu.gpa === null ? '' : edu.gpa.toFixed(2),
  };
}

/**
 * Detect htmx-driven requests so the route can return a fragment
 * instead of a redirect. htmx sets `HX-Request: true` on every
 * client-side request it issues.
 */
function isHtmxRequest(request: FastifyRequest): boolean {
  const hdr = request.headers['hx-request'];
  if (typeof hdr === 'string') return hdr.toLowerCase() === 'true';
  if (Array.isArray(hdr)) {
    return hdr.some((h) => typeof h === 'string' && h.toLowerCase() === 'true');
  }
  return false;
}

/**
 * Render the canonical education section: the full list + the "add"
 * form. Used by both the full-page GET response (wrapped in
 * `applicant/profile.njk`'s scaffold) and the htmx fragment swap that
 * fires after a successful create / update / delete.
 */
function renderEducationSection(
  app: FastifyInstance,
  options: {
    locale: string;
    csrfToken: string;
    educations: EducationRecord[];
    addForm?: {
      values: Record<string, unknown>;
      errors: Record<string, string[]>;
      generalError: string | null;
    } | null;
  },
): string {
  const capReached = options.educations.length >= MAX_EDUCATION_ENTRIES;
  return app.view('applicant/education-section.njk', {
    locale: options.locale,
    csrfToken: options.csrfToken,
    educations: options.educations,
    capReached,
    addForm: options.addForm ?? null,
    editingId: null,
    editForm: null,
  });
}

/**
 * Render the education section with one row swapped to its inline edit
 * form. The whole section re-renders so htmx can `outerHTML` swap
 * `#education-section` and pick up the editor in place.
 */
function renderEducationSectionWithEdit(
  app: FastifyInstance,
  options: {
    locale: string;
    csrfToken: string;
    educations: EducationRecord[];
    editingId: number;
    editForm?: {
      values: Record<string, unknown>;
      errors: Record<string, string[]>;
      generalError: string | null;
    } | null;
  },
): string {
  const capReached = options.educations.length >= MAX_EDUCATION_ENTRIES;
  return app.view('applicant/education-section.njk', {
    locale: options.locale,
    csrfToken: options.csrfToken,
    educations: options.educations,
    capReached,
    addForm: null,
    editingId: options.editingId,
    editForm: options.editForm ?? null,
  });
}

/**
 * GET /:locale/me/profile/education
 *
 * Render the standalone education section page. When called with the
 * `HX-Request` header, returns just the section fragment for an htmx
 * swap; otherwise wraps the section in the public layout for a normal
 * navigation request.
 */
async function getEducationList(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);

  let educations: EducationRecord[];
  try {
    educations = await listEducation(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.education: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = renderEducationSection(app, {
    locale,
    csrfToken: session.csrfToken,
    educations,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /:locale/me/profile/education/:id/edit
 *
 * Render the section with the targeted row in inline-edit mode. Returns
 * 404 when the id does not belong to the authenticated applicant — we
 * deliberately do not differentiate "missing" from "not yours" so the
 * route never confirms the existence of another user's row.
 */
async function getEducationEdit(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: EducationIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const locale = resolveLocale(request);

  try {
    const target = await findEducationById(session.userId, id);
    if (target === null) {
      return reply.code(404).send({ error: 'not_found' });
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
        generalError: null,
      },
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, educationId: id },
      'applicant.education: edit form load failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
}

/**
 * POST /:locale/me/profile/education
 *
 * Create a new entry. On a Zod or cap-reached failure, re-render the
 * section with the "add" form populated with the user's submitted
 * values + field-level errors. On success, htmx swaps the freshly
 * re-rendered section; non-htmx clients get a 302 to the section URL.
 */
async function postEducationCreate(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: EducationBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const body = request.body ?? {};
  const { _csrf: _csrfDiscarded, ...payload } = body;
  void _csrfDiscarded;

  try {
    await createEducation(session.userId, payload);
  } catch (err) {
    if (err instanceof ZodError || err instanceof EducationCapError) {
      const educations = await listEducation(session.userId).catch(() => []);
      const isCap = err instanceof EducationCapError;
      const status = isCap ? 422 : 400;
      const fieldErrors = isCap ? {} : zodErrorToFieldMap(err as ZodError);
      const general = isCap
        ? locale === 'en'
          ? `You can have at most ${MAX_EDUCATION_ENTRIES} education entries.`
          : `Anda hanya dapat memiliki maksimal ${MAX_EDUCATION_ENTRIES} entri pendidikan.`
        : null;
      const html = renderEducationSection(app, {
        locale,
        csrfToken: session.csrfToken,
        educations,
        addForm: {
          values: educationBodyToFormValues(body),
          errors: fieldErrors,
          generalError: general,
        },
      });
      return reply.code(status).type('text/html; charset=utf-8').send(html);
    }
    app.log.error(
      { err, userId: session.userId },
      'applicant.education: create failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  // Success — re-render the section so htmx can outerHTML-swap. Non-htmx
  // clients get a 302 back to the GET URL.
  if (isHtmxRequest(request)) {
    const educations = await listEducation(session.userId);
    const html = renderEducationSection(app, {
      locale,
      csrfToken: session.csrfToken,
      educations,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }
  return reply
    .code(302)
    .header('location', `/${locale}/me/profile/education`)
    .send();
}

/**
 * POST /:locale/me/profile/education/:id
 *
 * Update an existing entry. Returns 404 when the id does not belong to
 * the authenticated applicant. Validation errors re-render the section
 * with the targeted row swapped to inline-edit mode.
 */
async function postEducationUpdate(
  app: FastifyInstance,
  request: FastifyRequest<{
    Params: EducationIdParams;
    Body: EducationBody;
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const locale = resolveLocale(request);
  const body = request.body ?? {};
  const { _csrf: _csrfDiscarded, ...payload } = body;
  void _csrfDiscarded;

  try {
    await updateEducation(session.userId, id, payload);
  } catch (err) {
    if (err instanceof EducationNotFoundError) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (err instanceof ZodError) {
      const educations = await listEducation(session.userId).catch(() => []);
      const html = renderEducationSectionWithEdit(app, {
        locale,
        csrfToken: session.csrfToken,
        educations,
        editingId: id,
        editForm: {
          values: educationBodyToFormValues(body),
          errors: zodErrorToFieldMap(err),
          generalError: null,
        },
      });
      return reply.code(400).type('text/html; charset=utf-8').send(html);
    }
    app.log.error(
      { err, userId: session.userId, educationId: id },
      'applicant.education: update failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  if (isHtmxRequest(request)) {
    const educations = await listEducation(session.userId);
    const html = renderEducationSection(app, {
      locale,
      csrfToken: session.csrfToken,
      educations,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }
  return reply
    .code(302)
    .header('location', `/${locale}/me/profile/education`)
    .send();
}

/**
 * POST /:locale/me/profile/education/:id/delete
 *
 * Delete an entry. Idempotent against missing-row races (a not-found
 * error after a successful initial click is treated as success so the
 * UI converges).
 */
async function postEducationDelete(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: EducationIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const locale = resolveLocale(request);

  try {
    await deleteEducation(session.userId, id);
  } catch (err) {
    if (!(err instanceof EducationNotFoundError)) {
      app.log.error(
        { err, userId: session.userId, educationId: id },
        'applicant.education: delete failed',
      );
      return reply.code(500).send({ error: 'internal_error' });
    }
    // Idempotent: a not-found here means the row was already gone (e.g.
    // the user double-clicked Remove). Fall through to the success
    // path so the UI re-renders the up-to-date list.
  }

  if (isHtmxRequest(request)) {
    const educations = await listEducation(session.userId);
    const html = renderEducationSection(app, {
      locale,
      csrfToken: session.csrfToken,
      educations,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }
  return reply
    .code(302)
    .header('location', `/${locale}/me/profile/education`)
    .send();
}

// ---------------------------------------------------------------------------
// Experience routes (task 16.3)
// ---------------------------------------------------------------------------

/**
 * Raw form body shape accepted by the create/update experience handlers.
 * Every field is `unknown` because Fastify's `formbody` parses every
 * value as a string (or array of strings); the route normalises and
 * `experienceSchema` validates downstream.
 */
interface ExperienceBody {
  company?: unknown;
  title?: unknown;
  employment_type?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  is_current?: unknown;
  description?: unknown;
  /** Hidden CSRF field — read by the global CSRF middleware, not here. */
  _csrf?: unknown;
}

interface ExperienceIdParams extends LocaleParams {
  id: string;
}

/**
 * Sticky values used when re-rendering the section after a validation
 * failure. Mirrors the form keys so the view re-populates each input
 * with the user's submitted value rather than the persisted state.
 */
type ExperienceFormValues = {
  company: string;
  title: string;
  employment_type: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  description: string;
};

function bodyToExperienceFormValues(body: ExperienceBody): ExperienceFormValues {
  return {
    company: asString(body.company),
    title: asString(body.title),
    employment_type: asString(body.employment_type),
    start_date: asString(body.start_date),
    end_date: asString(body.end_date),
    is_current: asString(body.is_current).trim() !== '',
    description: asString(body.description),
  };
}

/**
 * Convert a stored `ExperienceRecord` into the form-field shape the
 * edit view expects. Mirrors `bodyToExperienceFormValues` so the same
 * view can render either source uniformly.
 */
function recordToExperienceFormValues(
  record: ExperienceRecord,
): ExperienceFormValues {
  return {
    company: record.company,
    title: record.title,
    employment_type: record.employment_type,
    start_date: record.start_date,
    end_date: record.end_date ?? '',
    is_current: record.is_current,
    description: record.description ?? '',
  };
}

/**
 * Strip the CSRF field — `experienceSchema` is `.strict()` and would
 * reject the extra key.
 */
function stripCsrf(body: ExperienceBody): Omit<ExperienceBody, '_csrf'> {
  const { _csrf: _drop, ...rest } = body;
  void _drop;
  return rest;
}

/**
 * Render the entire experience section (`views/applicant/experience-section.njk`).
 *
 * The same template handles all four states:
 *   - plain list (no editing, no add-form errors)
 *   - list + add-form errors  (validation failed on POST create)
 *   - list + inline edit-form (GET/POST edit)
 *   - list + inline edit-form errors (POST edit failed validation)
 */
function renderExperienceSection(
  app: FastifyInstance,
  options: {
    locale: string;
    csrfToken: string;
    cspNonce: string | undefined;
    experiences: ExperienceRecord[];
    addForm?: {
      values: ExperienceFormValues;
      errors: Record<string, string[]>;
      generalError: string | null;
    } | null;
    editingId?: number | null;
    editForm?: {
      values: ExperienceFormValues;
      errors: Record<string, string[]>;
      generalError: string | null;
    } | null;
  },
): string {
  return app.view('applicant/experience-section.njk', {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    experiences: options.experiences,
    capReached: options.experiences.length >= MAX_EXPERIENCE_ENTRIES,
    employmentTypes: EMPLOYMENT_TYPES,
    addForm: options.addForm ?? null,
    editingId: options.editingId ?? null,
    editForm: options.editForm ?? null,
  });
}

/**
 * Parse the `:id` segment for the experience handlers as a strictly
 * positive base-10 integer. Returns `null` when malformed. Distinct
 * from the education routes' `parseIdParam` only by accepting the raw
 * string directly (the URL guarantees a string).
 */
function parseExperienceId(raw: string): number | null {
  if (!/^[1-9]\d{0,18}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * GET /:locale/me/profile/experience
 *
 * Render the experience section as a standalone page. htmx callers
 * receive the same fragment, which fits naturally inside the
 * `#experience-section` outer wrapper. Browsers without htmx see a
 * usable form-only page.
 */
async function getExperience(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * POST /:locale/me/profile/experience  — create
 *
 * On success: re-render the section so the new row is visible (htmx
 * swaps `#experience-section` outerHTML).
 * On validation error: re-render the section with sticky values + field
 * messages on the add form (HTTP 400).
 * On cap-reached: re-render with a general error (HTTP 422).
 */
async function postExperienceCreate(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: ExperienceBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const body = request.body ?? {};
  const payload = stripCsrf(body);

  try {
    await createExperience(session.userId, payload);
  } catch (err) {
    const experiences = await listExperience(session.userId);

    if (err instanceof ZodError) {
      const html = renderExperienceSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        experiences,
        addForm: {
          values: bodyToExperienceFormValues(body),
          errors: zodErrorToFieldMap(err),
          generalError: null,
        },
      });
      return reply.code(400).type('text/html; charset=utf-8').send(html);
    }

    if (err instanceof ExperienceCapError) {
      const message =
        locale === 'en'
          ? `You can have at most ${MAX_EXPERIENCE_ENTRIES} experience entries.`
          : `Anda hanya dapat memiliki maksimum ${MAX_EXPERIENCE_ENTRIES} pengalaman.`;
      const html = renderExperienceSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        experiences,
        addForm: {
          values: bodyToExperienceFormValues(body),
          errors: {},
          generalError: message,
        },
      });
      return reply.code(422).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId },
      'applicant.experience: create failed',
    );
    const html = renderExperienceSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      experiences,
      addForm: {
        values: bodyToExperienceFormValues(body),
        errors: {},
        generalError:
          locale === 'en'
            ? 'We could not save your experience entry. Please try again.'
            : 'Pengalaman Anda tidak dapat disimpan. Silakan coba lagi.',
      },
    });
    return reply.code(500).type('text/html; charset=utf-8').send(html);
  }

  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * POST /:locale/me/profile/experience/:id/edit
 *
 * Update an existing entry. The `WHERE id=? AND applicant_user_id=?`
 * clause inside the service guarantees the request can only mutate
 * rows owned by the authenticated session.
 */
async function postExperienceEdit(
  app: FastifyInstance,
  request: FastifyRequest<{
    Params: ExperienceIdParams;
    Body: ExperienceBody;
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: 'not_found' });

  const locale = resolveLocale(request);
  const body = request.body ?? {};
  const payload = stripCsrf(body);

  // Ownership pre-check: load the row scoped to the session. Avoids the
  // weird case where a ZodError on a non-owned id leaks "valid id" via
  // the rendered edit form.
  const existing = await findExperienceById(session.userId, id);
  if (existing === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  // Validate first so we can re-render the inline edit form with sticky
  // values + field errors when validation fails.
  let parsed: ExperienceInput;
  try {
    parsed = experienceSchema.parse(payload);
  } catch (err) {
    if (err instanceof ZodError) {
      const experiences = await listExperience(session.userId);
      const html = renderExperienceSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        experiences,
        editingId: id,
        editForm: {
          values: bodyToExperienceFormValues(body),
          errors: zodErrorToFieldMap(err),
          generalError: null,
        },
      });
      return reply.code(400).type('text/html; charset=utf-8').send(html);
    }
    throw err;
  }

  try {
    await updateExperience(session.userId, id, parsed);
  } catch (err) {
    if (err instanceof ExperienceNotFoundError) {
      return reply.code(404).send({ error: 'not_found' });
    }
    app.log.error(
      { err, userId: session.userId, id },
      'applicant.experience: update failed',
    );
    const experiences = await listExperience(session.userId);
    const html = renderExperienceSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      experiences,
      editingId: id,
      editForm: {
        values: bodyToExperienceFormValues(body),
        errors: {},
        generalError:
          locale === 'en'
            ? 'We could not save your experience entry. Please try again.'
            : 'Pengalaman Anda tidak dapat disimpan. Silakan coba lagi.',
      },
    });
    return reply.code(500).type('text/html; charset=utf-8').send(html);
  }

  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /:locale/me/profile/experience/:id/edit
 *
 * Render the section with the inline edit form open on the requested
 * row. Used as the htmx "fetch the edit form" target.
 */
async function getExperienceEdit(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: ExperienceIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: 'not_found' });

  const existing = await findExperienceById(session.userId, id);
  if (existing === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const locale = resolveLocale(request);
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
      generalError: null,
    },
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * POST /:locale/me/profile/experience/:id/delete
 *
 * Remove the entry. Idempotent for the user's view: a missing or
 * non-owned id returns 404 so the API does not leak the existence of
 * other users' rows.
 */
async function postExperienceDelete(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: ExperienceIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: 'not_found' });

  const locale = resolveLocale(request);

  try {
    await deleteExperience(session.userId, id);
  } catch (err) {
    if (err instanceof ExperienceNotFoundError) {
      return reply.code(404).send({ error: 'not_found' });
    }
    app.log.error(
      { err, userId: session.userId, id },
      'applicant.experience: delete failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const experiences = await listExperience(session.userId);
  const html = renderExperienceSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    experiences,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /:locale/me/profile/experience/:id/row
 *
 * htmx fragment route returning a single `applicant/experience-row.njk`
 * for the requested row. Useful for clients that want to refresh just
 * one card without re-fetching the whole section. Mounted alongside
 * the section route to satisfy task 16.3's "htmx fragment route
 * returning views/applicant/experience-row.njk" requirement.
 */
async function getExperienceRow(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: ExperienceIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseExperienceId(request.params.id);
  if (id === null) return reply.code(404).send({ error: 'not_found' });

  const existing = await findExperienceById(session.userId, id);
  if (existing === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const locale = resolveLocale(request);
  const html = app.view('applicant/experience-row.njk', {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    exp: existing,
    editingId: null,
    editForm: null,
    employmentTypes: EMPLOYMENT_TYPES,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// Skill tag routes (task 16.4 — Req 4.4)
// ---------------------------------------------------------------------------

/**
 * Form body shape accepted by the toggle handler. The visible field is
 * `skill_id`; `_csrf` is consumed by the global CSRF middleware before
 * the handler runs and is stripped here defensively.
 */
interface SkillToggleBody {
  skill_id?: unknown;
  _csrf?: unknown;
}

/** Query string for the autocomplete endpoint. */
interface SkillSearchQuery {
  q?: unknown;
}

/**
 * Render the full skills section fragment. Used by the GET section
 * route, the POST toggle response, and any error path that needs to
 * show the panel back to the user. The same template handles every
 * variant (with / without a chosen skill, cap-reached, generalError).
 */
function renderSkillSection(
  app: FastifyInstance,
  options: {
    locale: string;
    csrfToken: string;
    cspNonce: string | undefined;
    assigned: SkillTag[];
    generalError: string | null;
  },
): string {
  return app.view('applicant/skill-section.njk', {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    assigned: options.assigned,
    capReached: options.assigned.length >= MAX_SKILLS_PER_APPLICANT,
    generalError: options.generalError,
  });
}

/**
 * Render the autocomplete results list. Always returns the
 * `<ul id="skill-search-results">` outer element so the htmx
 * `outerHTML` swap on `#skill-search-results` produces a stable,
 * idempotent target across keystrokes.
 */
function renderSkillSearchResults(
  app: FastifyInstance,
  options: {
    locale: string;
    csrfToken: string;
    cspNonce: string | undefined;
    results: SkillTag[];
    assignedIds: number[];
    capReached: boolean;
  },
): string {
  return app.view('applicant/skill-search-results.njk', {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    results: options.results,
    assignedIds: options.assignedIds,
    capReached: options.capReached,
  });
}

/**
 * GET /:locale/me/profile/skills
 *
 * Render the skills section: the list of currently-assigned skills as
 * chips, plus the autocomplete search input. The same fragment serves
 * full-page navigation and htmx swaps — htmx callers identify
 * themselves via `HX-Request: true` but the response body is identical
 * either way (the section is self-contained), so the route does not
 * branch on the header.
 */
async function getSkills(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  let assigned: SkillTag[];
  try {
    assigned = await listAssignedSkills(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.skills: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = renderSkillSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    assigned,
    generalError: null,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * POST /:locale/me/profile/skills/toggle
 *
 * Toggle a skill assignment for the authenticated applicant. The
 * service layer enforces the 30-entry cap inside a transaction so
 * concurrent requests cannot squeeze in a 31st row. Errors collapse
 * to user-friendly general-error banners on the same section
 * fragment:
 *   - cap reached → 422 + localised banner
 *   - skill missing / inactive → 422 + localised banner (we do not
 *     differentiate the two states in the user-facing text)
 *   - bad / missing skill_id → 400 + localised banner
 */
async function postSkillToggle(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: SkillToggleBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const body = request.body ?? {};

  // Localised error messages used across the rejection branches.
  const messages = {
    invalid:
      locale === 'en'
        ? 'Could not identify the requested skill. Please try again.'
        : 'Skill yang diminta tidak dapat dikenali. Silakan coba lagi.',
    capReached:
      locale === 'en'
        ? `You have reached the limit of ${MAX_SKILLS_PER_APPLICANT} skills. Remove one before adding another.`
        : `Anda telah mencapai batas ${MAX_SKILLS_PER_APPLICANT} skill. Hapus salah satu sebelum menambah yang baru.`,
    notFound:
      locale === 'en'
        ? 'That skill is no longer available.'
        : 'Skill tersebut sudah tidak tersedia.',
    failed:
      locale === 'en'
        ? 'We could not update your skills. Please try again.'
        : 'Skill Anda tidak dapat diperbarui. Silakan coba lagi.',
  } as const;

  // Parse `skill_id` via the shared schema; reject 400 on malformed input.
  let skillId: number;
  try {
    skillId = skillIdSchema.parse(body.skill_id);
  } catch (err) {
    if (err instanceof ZodError) {
      const assigned = await listAssignedSkills(session.userId).catch(
        () => [],
      );
      const html = renderSkillSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        assigned,
        generalError: messages.invalid,
      });
      return reply.code(400).type('text/html; charset=utf-8').send(html);
    }
    throw err;
  }

  try {
    await toggleSkill(session.userId, skillId);
  } catch (err) {
    const assigned = await listAssignedSkills(session.userId).catch(() => []);

    if (err instanceof SkillCapError) {
      const html = renderSkillSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        assigned,
        generalError: messages.capReached,
      });
      return reply.code(422).type('text/html; charset=utf-8').send(html);
    }

    if (err instanceof SkillInactiveError || err instanceof SkillNotFoundError) {
      const html = renderSkillSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        assigned,
        generalError: messages.notFound,
      });
      return reply.code(422).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId, skillId },
      'applicant.skills: toggle failed',
    );
    const html = renderSkillSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      assigned,
      generalError: messages.failed,
    });
    return reply.code(500).type('text/html; charset=utf-8').send(html);
  }

  // Success — re-fetch the assignment list and render the refreshed
  // section so htmx swaps `#skills-section` outerHTML.
  const assigned = await listAssignedSkills(session.userId);
  const html = renderSkillSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    assigned,
    generalError: null,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /:locale/me/profile/skills/search?q=...
 *
 * htmx autocomplete fragment. Returns `applicant/skill-search-results.njk`
 * (a `<ul>` with one `<li>` per suggestion). The handler:
 *   1. Rejects unsupported locales with 404.
 *   2. Loads the applicant's currently-assigned skill ids so the view
 *      can disable the "Add" button on rows already chosen.
 *   3. Calls `searchSkills(q)` which sanitises BOOLEAN-mode operators
 *      and falls back to LIKE for short queries (see service docstring).
 *   4. Returns the rendered fragment with 200 OK.
 *
 * The fragment always renders — even for empty / no-match queries — so
 * htmx can `outerHTML` swap `#skill-search-results` without checking
 * status codes.
 */
async function getSkillSearch(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Querystring: SkillSearchQuery }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const rawQuery = asString(request.query?.q);

  let assigned: SkillTag[];
  let results: SkillTag[];
  try {
    [assigned, results] = await Promise.all([
      listAssignedSkills(session.userId),
      searchSkills(rawQuery),
    ]);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.skills: search failed',
    );
    // Render an empty result list so the autocomplete dropdown clears
    // gracefully rather than leaving a stale snapshot.
    const html = renderSkillSearchResults(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      results: [],
      assignedIds: [],
      capReached: false,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }

  const html = renderSkillSearchResults(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    results,
    assignedIds: assigned.map((s) => s.id),
    capReached: assigned.length >= MAX_SKILLS_PER_APPLICANT,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// CV download (task 17.3 — Req 15.6, Design §9)
// ---------------------------------------------------------------------------

/**
 * URL params for `GET /:locale/me/cv/:id`. The `:id` segment is the
 * `applicant_cv_files.id` value the upload pipeline (task 17.1) prints
 * into the dashboard's "your CVs" list.
 */
interface CvIdParams extends LocaleParams {
  id: string;
}

/**
 * Sanitise an applicant-supplied filename for use as the literal
 * `filename="..."` token of `Content-Disposition`.
 *
 * RFC 6266 §4.1 says the unquoted `filename` parameter must be a
 * `quoted-string` (RFC 7230 §3.2.6) — i.e. only printable US-ASCII
 * minus `"` and `\`. We additionally strip CR/LF so a malicious
 * `original_filename` cannot smuggle a header into the response, and
 * collapse path separators (`/`, `\`) to underscores so the browser
 * never interprets the value as a directory hint.
 *
 * The cleaned value is then truncated to 80 characters, which is
 * comfortably under the 8 KiB header line cap and matches the
 * `original_filename VARCHAR(255)` column without forcing the response
 * header to carry the full DB value.
 *
 * If the cleaned value is empty (e.g. the user uploaded "….pdf" with
 * only non-ASCII characters), we fall back to `cv.<ext>` derived from
 * the stored MIME type, which always produces a safe, recognisable
 * filename. The `filename*=UTF-8''…` variant for non-ASCII names is
 * intentionally not emitted: design §9 specifies a plain
 * `filename="cv.pdf"` form, and most browsers handle the ASCII-only
 * fallback fine.
 */
function sanitiseAttachmentFilename(
  raw: string | null | undefined,
  mimeType: string,
): string {
  // Map the stored MIME to a sensible default extension for the fallback
  // path. We deliberately do NOT trust the stored extension on disk:
  // the upload pipeline already cross-checks magic bytes against MIME,
  // so the MIME is authoritative at this layer.
  const fallback =
    mimeType === 'application/pdf'
      ? 'cv.pdf'
      : mimeType === 'application/msword'
        ? 'cv.doc'
        : mimeType ===
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ? 'cv.docx'
          : 'cv';

  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  // Strip every control character (CR/LF/NUL/HT etc.) and the chars
  // that break a quoted-string (`"`, `\`). Replace path separators
  // with `_` so the value never looks like a path. Anything outside
  // printable US-ASCII is dropped — a non-ASCII name will fall back to
  // the cv.<ext> default below.
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/["\\]/g, '')
    .replace(/[/\\]/g, '_')
    // Drop anything outside printable US-ASCII (0x20..0x7E).
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0x20 && c <= 0x7e;
    })
    .join('')
    .trim();

  if (cleaned.length === 0) return fallback;
  // Truncate to a sane length so the header line stays bounded.
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

/**
 * GET `/:locale/me/cv/:id` — stream a CV file to the authenticated owner.
 *
 * Authorization (Design §9 / Req 15.6):
 *   - The owner branch is wired here. `loadCvForDownload` runs
 *     `WHERE id=? AND applicant_user_id=?` so an attempt to download
 *     another applicant's id collapses to "not found" without a second
 *     round-trip.
 *   - The HR / Super_Admin branch is gated on the `applications` table
 *     (task 25.1) and the admin download surface (Phase 5 / task 30).
 *     `loadCvForDownload` already exposes the seam — when the table
 *     lands, that branch flips on without changes here. For the
 *     applicant-facing route, only Applicant sessions ever reach this
 *     handler (`requireApplicant` rejects internal roles), so the HR
 *     branch is naturally inert for now.
 *
 * Response shape:
 *   - 200 on success. Body is the raw file stream.
 *   - 404 when the id does not exist, is not owned by the session, or
 *     when its `storage_path` resolves outside the File_Store root
 *     (defensive — `loadCvForDownload` already collapses that to null).
 *   - 302 to /{locale}/login when the session is missing/expired
 *     (handled by `requireApplicant`).
 *
 * Headers (Design §9 / Req 15.6):
 *   - `Content-Type` from the stored MIME (`application/pdf`,
 *     `application/msword`, or the OOXML wordprocessingml type).
 *   - `Content-Disposition: attachment; filename="<sanitised>"`. Always
 *     `attachment` so the browser does not render the file inline —
 *     this neutralises a stored-XSS attack via a crafted `.html`-named
 *     PDF, and keeps the download UX consistent.
 *   - `X-Content-Type-Options: nosniff` so the browser MUST honour
 *     the declared MIME and never sniff a CV file as
 *     `text/html`. The global helmet config also sets this header
 *     (task 4.4 / Req 15.1), but we set it again on the route response
 *     for defence-in-depth — a future tweak to the global policy
 *     cannot accidentally weaken the CV download.
 *   - `Cache-Control: private, no-store` so neither the browser nor
 *     any intermediary caches the response. CV files contain PII and
 *     must never be served from a shared cache.
 *   - `Content-Length` from the on-disk size when available — small
 *     UX win (the browser shows progress) and lets HEAD-style probes
 *     answer without reading the body.
 */
async function getCvDownload(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: CvIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const cvId = parseIdParam(request.params.id);
  if (cvId === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  let descriptor;
  try {
    descriptor = await loadCvForDownload(
      session.userId,
      session.role,
      cvId,
    );
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, cvId },
      'applicant.cv.download: lookup failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  if (descriptor === null) {
    // Unknown id, owned by a different applicant, or `storage_path`
    // escaped the File_Store root. All three branches collapse to 404
    // so the API never confirms the existence of another user's row.
    return reply.code(404).send({ error: 'not_found' });
  }

  // `stat` doubles as an existence probe before we open the stream:
  // a missing file (the row exists but the on-disk artefact was
  // pruned out-of-band by the retention cron, or the migration moved
  // the File_Store) is reported as 404 rather than as a 500 mid-body.
  let sizeBytes: number | null = null;
  try {
    const stats = await stat(descriptor.absolutePath);
    if (!stats.isFile()) {
      app.log.warn(
        { userId: session.userId, cvId, path: descriptor.absolutePath },
        'applicant.cv.download: stored path is not a regular file',
      );
      return reply.code(404).send({ error: 'not_found' });
    }
    sizeBytes = stats.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      app.log.warn(
        { userId: session.userId, cvId, path: descriptor.absolutePath },
        'applicant.cv.download: file missing on disk',
      );
      return reply.code(404).send({ error: 'not_found' });
    }
    app.log.error(
      { err, userId: session.userId, cvId, path: descriptor.absolutePath },
      'applicant.cv.download: stat failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const filename = sanitiseAttachmentFilename(
    descriptor.originalFilename,
    descriptor.mimeType,
  );

  // Set every header BEFORE streaming the body so the response line is
  // emitted with the correct shape. `reply.send(stream)` finalises the
  // response; once the stream is piped we cannot add more headers.
  reply
    .code(200)
    .type(descriptor.mimeType)
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store');
  if (sizeBytes !== null) {
    reply.header('Content-Length', String(sizeBytes));
  }

  // Open the read stream after `stat` succeeded — this narrows the
  // window where a concurrent prune could remove the file between the
  // existence check and the open. `createReadStream` propagates ENOENT
  // through the stream's `error` event; Fastify in turn forwards that
  // to the request logger and emits a 500 to the client.
  const stream = createReadStream(descriptor.absolutePath);
  return reply.send(stream);
}


// ---------------------------------------------------------------------------
// CV upload routes (task 17.1 — Req 4.5-4.8, 15.5)
// ---------------------------------------------------------------------------

/**
 * Render the CV section fragment using the applicant's current CV
 * history. The same template serves both the full GET response and
 * the htmx-targeted upload response.
 */
function renderCvSection(
  app: FastifyInstance,
  options: {
    locale: string;
    csrfToken: string;
    cvs: CvFileRecord[];
    generalError?: string | null;
    saved?: boolean;
  },
): string {
  return app.view('applicant/cv-section.njk', {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cvs: options.cvs,
    generalError: options.generalError ?? null,
    saved: options.saved ?? false,
    maxBytes: MAX_CV_BYTES,
    maxHistory: MAX_CV_HISTORY,
    allowedMimes: ALLOWED_CV_MIMES,
  });
}

/**
 * Localised error message for the user-facing alert when the upload
 * pipeline rejects the file. Mirrors the locale strings used by the
 * other applicant routes.
 */
function cvErrorMessage(
  locale: string,
  kind: 'too_large' | 'mime' | 'storage' | 'internal',
): string {
  const id = locale === 'en' ? 'en' : 'id';
  const msgs = {
    id: {
      too_large: 'Ukuran berkas melebihi 5 MB. Pilih CV yang lebih kecil.',
      mime: 'Format berkas tidak didukung. Gunakan PDF, DOC, atau DOCX.',
      storage:
        'Penyimpanan server hampir penuh. Silakan coba lagi beberapa saat lagi.',
      internal: 'CV Anda tidak dapat diunggah. Silakan coba lagi.',
    },
    en: {
      too_large: 'File size exceeds 5 MB. Please choose a smaller CV.',
      mime: 'Unsupported file format. Use PDF, DOC, or DOCX.',
      storage:
        'Server storage is almost full. Please try again in a few moments.',
      internal: 'We could not upload your CV. Please try again.',
    },
  } as const;
  return msgs[id][kind];
}

/**
 * GET /:locale/me/cv
 *
 * Render the CV upload form together with the applicant's active CV
 * and any retained history (≤ 3 rows total per `MAX_CV_HISTORY`).
 * Used both as a standalone page and as the htmx-target fragment when
 * the upload form is loaded into another view.
 *
 * The route must NOT collide with `GET /:locale/me/cv/:id` (task 17.3,
 * the download handler). Fastify's radix router resolves the more
 * specific `/:id` segment first, so this list endpoint only matches
 * when the URL has exactly two `/me/cv` segments.
 */
async function getCv(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Querystring: ProfileQuery }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);

  let cvs: CvFileRecord[];
  try {
    cvs = await listCvsForOwner(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.cv: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const saved = asString(request.query?.saved) === '1';

  const html = renderCvSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cvs,
    saved,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * POST /:locale/me/cv
 *
 * Accept a multipart upload, run it through the CV pipeline
 * (`processCvUpload`), and render the refreshed CV section. Error
 * mapping (Design §9):
 *   - `FileTooLargeError`        → HTTP 413  (Req 4 AC #7)
 *   - `MimeMismatchError`        → HTTP 415  (Req 4 AC #6 / Req 15 AC #5)
 *   - `InsufficientStorageError` → HTTP 507  (Design §9)
 *   - any other throw            → HTTP 500
 *
 * On every failure path we still render the section fragment with the
 * pre-existing CV list so an htmx response replaces the section in
 * place with a visible error banner. Non-htmx clients see the same
 * fragment as a standalone document.
 *
 * `@fastify/multipart` is registered on the Fastify instance with
 * `limits.fileSize = MAX_CV_BYTES` and `throwFileSizeLimit = true`
 * (its default). That means an oversize upload surfaces as a
 * `FST_REQ_FILE_TOO_LARGE` either:
 *   (a) when `request.file()` itself rejects (limit hit before any
 *       data is consumed), or
 *   (b) when `processCvUpload`'s in-band byte counter aborts the
 *       pipeline (limit hit mid-stream).
 * Both branches map to the same 413 response.
 */
async function postCv(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);

  // Refuse non-multipart submissions before pulling the file part —
  // `request.file()` would throw on an unrelated content-type, but
  // returning an explicit 400 here keeps the failure mode predictable.
  if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
    const cvs = await listCvsForOwner(session.userId).catch(() => []);
    const html = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs,
      generalError: cvErrorMessage(locale, 'mime'),
    });
    return reply.code(400).type('text/html; charset=utf-8').send(html);
  }

  // Pull the single expected file part. `@fastify/multipart` is
  // configured with `files: 1, throwFileSizeLimit: true` (server.ts),
  // so a busboy size-limit fires as a `RequestFileTooLargeError` here
  // — we map it to HTTP 413 below.
  let multipartFile: Awaited<ReturnType<typeof request.file>>;
  try {
    multipartFile = await request.file();
  } catch (err) {
    const fastifyErr = err as { statusCode?: unknown; code?: unknown } | null;
    const code = fastifyErr?.code;
    const status = fastifyErr?.statusCode;
    const cvs = await listCvsForOwner(session.userId).catch(() => []);
    if (code === 'FST_REQ_FILE_TOO_LARGE' || status === 413) {
      const html = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs,
        generalError: cvErrorMessage(locale, 'too_large'),
      });
      return reply.code(413).type('text/html; charset=utf-8').send(html);
    }
    app.log.error(
      { err, userId: session.userId },
      'applicant.cv: multipart parse failed',
    );
    const html = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs,
      generalError: cvErrorMessage(locale, 'internal'),
    });
    return reply.code(400).type('text/html; charset=utf-8').send(html);
  }

  if (!multipartFile) {
    const cvs = await listCvsForOwner(session.userId).catch(() => []);
    const html = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs,
      generalError: cvErrorMessage(locale, 'mime'),
    });
    return reply.code(400).type('text/html; charset=utf-8').send(html);
  }

  try {
    await processCvUpload({
      userId: session.userId,
      multipartFile: {
        file: multipartFile.file,
        mimetype: multipartFile.mimetype,
        filename: multipartFile.filename,
      },
    });
  } catch (err) {
    // Drain any unread bytes on the busboy stream so subsequent
    // requests on the same connection are not stalled. Reading the
    // rest is a no-op on the happy failure paths but defensive in
    // case `processCvUpload` rejected before consuming the body.
    try {
      multipartFile.file.resume();
    } catch {
      /* ignore */
    }

    const cvs = await listCvsForOwner(session.userId).catch(() => []);
    if (err instanceof FileTooLargeError) {
      const html = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs,
        generalError: cvErrorMessage(locale, 'too_large'),
      });
      return reply.code(413).type('text/html; charset=utf-8').send(html);
    }
    if (err instanceof MimeMismatchError) {
      const html = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs,
        generalError: cvErrorMessage(locale, 'mime'),
      });
      return reply.code(415).type('text/html; charset=utf-8').send(html);
    }
    if (err instanceof InsufficientStorageError) {
      const html = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs,
        generalError: cvErrorMessage(locale, 'storage'),
      });
      return reply.code(507).type('text/html; charset=utf-8').send(html);
    }
    // busboy's RequestFileTooLargeError can also surface here when the
    // stream is consumed past the limit by the pipeline.
    const fastifyErr = err as { statusCode?: unknown; code?: unknown } | null;
    if (
      fastifyErr?.code === 'FST_REQ_FILE_TOO_LARGE' ||
      fastifyErr?.statusCode === 413
    ) {
      const html = renderCvSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cvs,
        generalError: cvErrorMessage(locale, 'too_large'),
      });
      return reply.code(413).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId },
      'applicant.cv: upload failed',
    );
    const html = renderCvSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cvs,
      generalError: cvErrorMessage(locale, 'internal'),
    });
    return reply.code(500).type('text/html; charset=utf-8').send(html);
  }

  // Success — refresh the section. htmx swaps it in place; non-htmx
  // clients see the rendered fragment as their response.
  const cvs = await listCvsForOwner(session.userId).catch(() => []);
  const html = renderCvSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cvs,
    saved: true,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}


// ---------------------------------------------------------------------------
// GET /:locale/me — Applicant dashboard (task 18.1)
// ---------------------------------------------------------------------------

/**
 * Render the applicant dashboard at `/{locale}/me`.
 *
 * Validates: Requirements 4.9, 4.10 (Design §6 Applicant_Area).
 *
 * Pipeline:
 *   1. Authenticate via `requireApplicant`. Missing / non-Applicant
 *      sessions are short-circuited to a login redirect.
 *   2. Reject unsupported locales with 404 BEFORE any DB work.
 *   3. Load the canonical applicants row plus the satellite signals
 *      needed to compute completeness:
 *        - `≥1 education`     via `listEducation(userId)`
 *        - `≥1 experience`    via `listExperience(userId)`
 *        - `active CV`        via `hasActiveCvForOwner(userId)`
 *      All three reads run in parallel because they target disjoint
 *      tables and share only the `applicant_user_id` predicate. We use
 *      the existing `list*` services rather than introducing fresh
 *      `count*` helpers — the per-applicant caps (20 education, 30
 *      experience) keep the row counts well below anything that would
 *      justify a dedicated COUNT round-trip, and reusing the listing
 *      services keeps the contract surface small.
 *   4. Compose the `CompletenessInput` from the loaded record + flags
 *      and call `computeCompleteness` (the pure helper in
 *      `src/modules/applicant/completeness.ts`).
 *   5. Render `views/applicant/dashboard.njk` with `{ percentage,
 *      missingFields }`. The template embeds the shared
 *      `partials/profile-completeness-banner.njk` partial below the
 *      80 % threshold (Req 4.10) and shows a success card otherwise.
 *
 * Authentication is enforced through `requireApplicant()` per the task
 * description. We deliberately do NOT touch session activity here — a
 * dashboard view is not a meaningful "user is using the app" signal
 * for idle-timeout purposes; that belongs to mutation routes.
 */
async function getDashboard(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const session = await requireApplicant(request, reply);
  if (session === null) {
    // requireApplicant has already finalised the response (302 to login).
    return reply;
  }

  const locale = resolveLocale(request);

  let profile: ProfileRecord | null;
  let educationCount = 0;
  let experienceCount = 0;
  let hasActiveCv = false;
  try {
    const [profileRow, educations, experiences, activeCv] = await Promise.all([
      loadProfile(session.userId),
      listEducation(session.userId),
      listExperience(session.userId),
      hasActiveCvForOwner(session.userId),
    ]);
    profile = profileRow;
    educationCount = educations.length;
    experienceCount = experiences.length;
    hasActiveCv = activeCv;
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.dashboard: load failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  if (profile === null) {
    // Same defensive branch as the profile route: registration always
    // inserts the applicants row inside the same transaction as the
    // user, so a missing row indicates a structural failure rather
    // than a normal "not yet filled" state.
    app.log.error(
      { userId: session.userId },
      'applicant.dashboard: applicants row missing for authenticated user',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const completenessInput: CompletenessInput = {
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
    hasActiveCv,
  };
  const { percentage, missingFields } = computeCompleteness(completenessInput);

  const html = app.view('applicant/dashboard.njk', {
    locale,
    percentage,
    // Cast through `unknown` for nunjucks: the readonly tuple type from
    // `computeCompleteness` is structurally compatible with `string[]`,
    // and the view only iterates / inspects `length`.
    missingFields: missingFields as readonly string[],
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}


// ---------------------------------------------------------------------------
// Apply to a job (task 26.1 — Req 5.1, 5.2, 5.3, 5.4, 5.5, 14.4)
// ---------------------------------------------------------------------------

/**
 * zod schema for `POST /api/applications` body. We accept either a
 * JSON body (htmx with `hx-vals` JSON-encoded) or a form-urlencoded
 * body (htmx default form posts). The job id must be a positive
 * integer that fits in `BIGINT UNSIGNED`.
 */
const applyBodySchema = z
  .object({
    jobId: z.coerce
      .number({ required_error: 'jobId is required' })
      .int({ message: 'jobId must be an integer' })
      .positive({ message: 'jobId must be positive' }),
  })
  // `.passthrough()` — the form may also carry `_csrf`; the global CSRF
  // middleware verifies that. We only validate the keys we need.
  .passthrough();

/**
 * Allowed values for the `?ref=` query parameter. The route narrows
 * any recognised value to this union before handing it to the service;
 * anything else collapses to `undefined` here (and the service maps a
 * missing/unrecognised source to `'unknown'`).
 */
type ApplySource = 'direct' | 'search' | 'alert' | 'social' | 'unknown';

/** Whitelist used to narrow a raw `?ref=` string into {@link ApplySource}. */
const APPLY_SOURCE_VALUES: ReadonlySet<ApplySource> = new Set<ApplySource>([
  'direct',
  'search',
  'alert',
  'social',
  'unknown',
]);

/** Type-guard: is `value` one of the canonical {@link ApplySource} tokens? */
function isApplySource(value: string): value is ApplySource {
  return APPLY_SOURCE_VALUES.has(value as ApplySource);
}

interface ApplyQuery {
  /** Optional referral channel (matches the `applications.source` ENUM). */
  ref?: unknown;
}

/**
 * Read the `?ref=` query parameter and narrow it to a canonical
 * {@link ApplySource}. The match is case-insensitive on the URL value;
 * anything unrecognised (or absent) returns `undefined` so the service
 * applies its own `'unknown'` default. Returning the narrowed union
 * (rather than a raw string) keeps the apply route's contract explicit
 * about which referral channels it understands.
 */
function readApplySourceParam(
  query: ApplyQuery | undefined,
): ApplySource | undefined {
  if (!query || typeof query !== 'object') return undefined;
  const raw = query.ref;
  let candidate: string | undefined;
  if (typeof raw === 'string') {
    candidate = raw;
  } else if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === 'string');
    candidate = typeof first === 'string' ? first : undefined;
  }
  if (candidate === undefined) return undefined;
  const normalised = candidate.trim().toLowerCase();
  return isApplySource(normalised) ? normalised : undefined;
}

/**
 * POST /api/applications
 *
 * Body shape: `{ jobId: number }` (JSON or form-urlencoded; the
 * htmx default uses urlencoded).
 *
 * Query: `?ref=direct|search|alert|social` — anything else (or
 * absent) collapses to `'unknown'`.
 *
 * The handler delegates to {@link applyToJob} which:
 *   1. Loads the applicant snapshot + active CV;
 *   2. Computes profile completeness;
 *   3. Loads the job and validates Published + future deadline;
 *   4. INSERTs the application + the synthetic stage-history row
 *      inside one transaction;
 *   5. Catches `uk_app_applicant_job` collisions and re-throws
 *      `DuplicateApplicationError`.
 *
 * Response shape:
 *   - Success: 302 redirect to `/{locale}/me/applications/:id` so a
 *     refresh of the destination does not re-submit the form
 *     (Post/Redirect/Get pattern). htmx clients see the redirect via
 *     `HX-Redirect: <url>` so the browser navigates rather than
 *     swapping in the empty body.
 *   - {@link MissingCvError} or {@link IncompleteProfileError}: 422
 *     with a JSON envelope carrying `{ error, missingFields? }` so
 *     htmx can swap a friendly fragment in.
 *   - {@link JobUnavailableError}: 422 (the design treats "not
 *     applicable" as a client mistake even though the underlying
 *     issue is "you may not apply" — see error class docstring).
 *   - {@link DuplicateApplicationError}: 409 with the existing
 *     application's reference number so the UI can deep-link the
 *     applicant back to the prior submission.
 *   - 400 on body validation failures (missing/non-integer jobId).
 *
 * Why we redirect rather than render a fragment on success:
 *   The apply CTA today lives on the public `/jobs/:slug` page, which
 *   renders OUTSIDE the Applicant_Area layout. After applying, the
 *   user belongs in `/me/applications/:id` (the timeline). Redirect
 *   keeps the URL bar honest; htmx's `HX-Redirect` header tells the
 *   browser to follow the redirect even when the request was
 *   issued via fetch.
 */
async function postApply(
  app: FastifyInstance,
  request: FastifyRequest<{
    Querystring: ApplyQuery;
    Body: unknown;
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireApplicant(request, reply);
  if (session === null) {
    // requireApplicant has already finalised the redirect.
    return reply;
  }

  // Normalise body: empty body becomes `{}` so the schema produces a
  // coherent "jobId required" error rather than throwing against
  // `null`/`undefined`.
  const rawBody =
    request.body !== null && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>)
      : {};

  let parsed;
  try {
    parsed = applyBodySchema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      const errors = zodErrorToFieldMap(err);
      return reply.code(400).send({ error: 'invalid_body', errors });
    }
    throw err;
  }

  // The locale on the apply route is implicit: the form is posted
  // from a localised public page, but the endpoint itself lives at
  // `/api/applications` (no locale prefix). We default to `id` for
  // the redirect target; the destination page will resolve its own
  // locale from URL prefix → cookie → Accept-Language per design §13.
  const locale = 'id';
  const sourceParam = readApplySourceParam(request.query);

  let result: ApplyToJobResult;
  try {
    result = await applyToJob({
      applicantUserId: session.userId,
      jobId: parsed.jobId,
      sourceParam,
    });
  } catch (err) {
    if (err instanceof MissingCvError) {
      return reply.code(422).send({
        error: 'missing_cv',
        missingFields: ['hasActiveCv'],
      });
    }
    if (err instanceof IncompleteProfileError) {
      return reply.code(422).send({
        error: 'incomplete_profile',
        percentage: err.percentage,
        missingFields: err.missingFields,
      });
    }
    if (err instanceof JobUnavailableError) {
      // We surface 422 (rather than 404 from the error class) because
      // the apply pipeline reaches this branch only for a job the
      // applicant just clicked Apply on. The richer status guides
      // htmx error swap targets.
      return reply.code(422).send({
        error: 'job_unavailable',
        jobId: err.jobId,
      });
    }
    if (err instanceof DuplicateApplicationError) {
      // Surface the existing reference number so the UI can deep-link
      // the applicant back to the prior submission. We do NOT re-load
      // the row here — the caller can hit `/me/applications` to
      // discover it. This keeps the failure path one round-trip away
      // from the DB, matching the design's "fail fast" stance.
      return reply.code(409).send({
        error: 'duplicate_application',
        jobId: err.jobId,
      });
    }
    app.log.error(
      { err, userId: session.userId, jobId: parsed.jobId },
      'apply: unexpected error',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const location = `/${locale}/me/applications/${result.id}`;
  // htmx clients respect `HX-Redirect` to perform a full page nav.
  // Plain browser form submissions follow the 302.
  reply.header('hx-redirect', location);
  return reply.code(302).header('location', location).send();
}


// ---------------------------------------------------------------------------
// Bookmarks (task 28.1 — Req 6.4, 6.5, 6.6)
// ---------------------------------------------------------------------------

/**
 * zod schema for `POST /api/bookmarks/toggle` body. We accept either a
 * JSON body (htmx with `hx-vals` JSON-encoded) or a form-urlencoded
 * body (htmx default), and z.coerce.number() handles the form-string
 * variant gracefully. The id must be a positive integer that fits in
 * `BIGINT UNSIGNED`.
 */
const bookmarkToggleBodySchema = z
  .object({
    jobId: z.coerce
      .number({ required_error: 'jobId is required' })
      .int({ message: 'jobId must be an integer' })
      .positive({ message: 'jobId must be positive' }),
  })
  // `.passthrough()` — the form may also carry `_csrf`; the global CSRF
  // middleware reads that. We only validate the keys we need.
  .passthrough();

/**
 * Render the bookmark-toggle button partial on its own. The same
 * fragment is embedded inside the bookmarks page rows AND returned by
 * `POST /api/bookmarks/toggle` so the htmx swap is consistent
 * (Design §4.2).
 */
function renderBookmarkButton(
  app: FastifyInstance,
  options: {
    locale: string;
    jobId: number;
    bookmarked: boolean;
    csrfToken: string;
  },
): string {
  return app.view('partials/bookmark-button.njk', {
    locale: options.locale,
    jobId: options.jobId,
    bookmarked: options.bookmarked,
    csrfToken: options.csrfToken,
  });
}

/**
 * POST /api/bookmarks/toggle
 *
 * Body: `{ jobId: number }` (JSON or form-urlencoded). The session
 * (`requireApplicant`) and CSRF middleware run before this handler;
 * a missing session yields 302 to login (the htmx swap on the client
 * will follow `HX-Redirect`-style hints handled by the global
 * security plugin) — but we ALSO emit a 401 for raw JSON probes by
 * inspecting the `Accept` header. For htmx + form-encoded clients the
 * `requireApplicant` redirect is fine; for tests probing with
 * `Accept: application/json` we send 401 directly.
 *
 * Errors:
 *   - 400 — body fails zod validation (missing or non-integer jobId).
 *   - 404 — `JobNotFoundError` from the service (jobId does not exist).
 *   - 200 — success; body is the rendered bookmark-button partial.
 *
 * The handler does NOT return JSON on success: the HTMX swap target
 * is the button itself, so we serve `text/html`.
 */
async function postBookmarkToggle(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const session = await requireApplicant(request, reply);
  if (session === null) {
    // requireApplicant has already finalised the redirect.
    return reply;
  }

  // Normalise body: empty body becomes `{}` so the schema can produce
  // a coherent "jobId required" error rather than throwing against
  // `null`/`undefined`.
  const rawBody =
    request.body !== null && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>)
      : {};

  let parsed;
  try {
    parsed = bookmarkToggleBodySchema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      const errors = zodErrorToFieldMap(err);
      return reply.code(400).send({ error: 'invalid_body', errors });
    }
    throw err;
  }

  // The locale defaults to 'id' for the button render; the partial
  // only uses it for the `aria-label` strings. The fragment lives
  // outside any locale-prefixed URL space (the endpoint is `/api/...`)
  // so we pick a sensible default here. Since we don't have a
  // `:locale` URL param on this route, fall back via session.role
  // would not help — the language preference column is unrelated. A
  // future enhancement could read the htmx `Hx-Current-URL` header
  // for the locale prefix; for now `id` is the spec default.
  const locale = 'id';

  let bookmarked: boolean;
  try {
    const result = await toggleBookmark(session.userId, parsed.jobId);
    bookmarked = result.bookmarked;
  } catch (err) {
    if (err instanceof BookmarkJobNotFoundError) {
      return reply.code(404).send({ error: 'job_not_found' });
    }
    app.log.error(
      { err, userId: session.userId, jobId: parsed.jobId },
      'bookmarks.toggle: failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = renderBookmarkButton(app, {
    locale,
    jobId: parsed.jobId,
    bookmarked,
    csrfToken: session.csrfToken,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /:locale/me/bookmarks
 *
 * Render the bookmarks page (`views/applicant/bookmarks.njk`) with
 * the applicant's saved jobs. Inactive jobs (Closed/Archived/expired)
 * still show — Req 6.6 explicitly keeps them visible, just with the
 * Apply CTA disabled and a "no longer available" badge.
 */
async function getBookmarks(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);

  let bookmarks: BookmarkRow[];
  try {
    bookmarks = await listBookmarks(session.userId, locale);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.bookmarks: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = app.view('applicant/bookmarks.njk', {
    locale,
    bookmarks,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

// ---------------------------------------------------------------------------
// Job alerts (task 33.1 — Req 7.1)
// ---------------------------------------------------------------------------

/**
 * Raw form body for `POST /:locale/me/alerts`. Every field is `unknown`
 * because Fastify's `formbody` parses values as strings or arrays of
 * strings (repeated fields); the service's `alertSchema` normalises and
 * validates downstream.
 */
interface AlertBody {
  keyword?: unknown;
  locations?: unknown;
  departments?: unknown;
  frequency?: unknown;
  /** Hidden CSRF field — verified by the global CSRF middleware. */
  _csrf?: unknown;
}

/** URL params for routes that target a specific alert id. */
interface AlertIdParams extends LocaleParams {
  id: string;
}

/**
 * Mirror a failed submission back into the loose `values` map the
 * alerts form re-renders from, so the user does not lose what they
 * typed. Array-valued fields (repeated `locations` / `departments`
 * inputs) collapse to a comma-joined string to match the text-input
 * shape the template renders.
 */
function alertBodyToFormValues(body: AlertBody): Record<string, string> {
  const joinList = (value: unknown): string => {
    if (Array.isArray(value)) {
      return value
        .filter((v) => typeof v === 'string' || typeof v === 'number')
        .join(', ');
    }
    return asString(value);
  };
  return {
    keyword: asString(body.keyword),
    locations: joinList(body.locations),
    departments: joinList(body.departments),
    frequency: asString(body.frequency) || 'Daily',
  };
}

/**
 * Render the canonical alerts section: the list + the create form.
 * Used by the full-page GET (wrapped in `applicant/alerts.njk`) and by
 * the htmx fragment swap after a successful create / delete, as well as
 * the cap / validation error re-renders.
 */
function renderAlertsSection(
  app: FastifyInstance,
  options: {
    locale: string;
    csrfToken: string;
    cspNonce: string | undefined;
    alerts: AlertRow[];
    form?: {
      values: Record<string, string>;
      errors: Record<string, string[]>;
      generalError: string | null;
    } | null;
    wrap: boolean;
  },
): string {
  const capReached = options.alerts.length >= MAX_ALERTS_PER_APPLICANT;
  const template = options.wrap
    ? 'applicant/alerts.njk'
    : 'applicant/alerts-section.njk';
  return app.view(template, {
    locale: options.locale,
    csrfToken: options.csrfToken,
    cspNonce: options.cspNonce,
    alerts: options.alerts,
    capReached,
    form: options.form ?? null,
  });
}

/**
 * GET /:locale/me/alerts
 *
 * Render the alerts page (full document) listing the applicant's alerts
 * plus the create form.
 */
async function getAlerts(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);

  let alerts: AlertRow[];
  try {
    alerts = await listAlerts(session.userId);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.alerts: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = renderAlertsSection(app, {
    locale,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
    alerts,
    wrap: true,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * POST /:locale/me/alerts
 *
 * Create a new alert. The service validates the form and enforces the
 * 10-alert cap inside a transaction. Error mapping:
 *   - InvalidAlertInputError → 422 + field errors re-rendered on the form.
 *   - AlertCapError          → 422 + cap banner.
 *   - success                → htmx swaps the freshly-rendered section;
 *                              non-htmx clients get a 302 to the page.
 */
async function postAlertCreate(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams; Body: AlertBody }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const body = request.body ?? {};
  const { _csrf: _csrfDiscarded, ...payload } = body;
  void _csrfDiscarded;

  const htmx = isHtmxRequest(request);

  try {
    await createAlert({ applicantUserId: session.userId, input: payload });
  } catch (err) {
    if (
      err instanceof InvalidAlertInputError ||
      err instanceof AlertCapError
    ) {
      const isCap = err instanceof AlertCapError;
      const alerts = await listAlerts(session.userId).catch(() => []);
      const fieldErrors = isCap ? {} : err.fieldErrors;
      const generalError = isCap
        ? locale === 'en'
          ? `You can have at most ${MAX_ALERTS_PER_APPLICANT} job alerts. Remove one to add a new alert.`
          : `Anda hanya dapat memiliki maksimal ${MAX_ALERTS_PER_APPLICANT} notifikasi. Hapus salah satu untuk menambah yang baru.`
        : null;
      const html = renderAlertsSection(app, {
        locale,
        csrfToken: session.csrfToken,
        cspNonce: request.cspNonce,
        alerts,
        form: {
          values: alertBodyToFormValues(body),
          errors: fieldErrors,
          generalError,
        },
        wrap: !htmx,
      });
      return reply.code(422).type('text/html; charset=utf-8').send(html);
    }

    app.log.error(
      { err, userId: session.userId },
      'applicant.alerts: create failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  if (htmx) {
    const alerts = await listAlerts(session.userId);
    const html = renderAlertsSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      alerts,
      wrap: false,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }
  return reply.code(302).header('location', `/${locale}/me/alerts`).send();
}

/**
 * POST /:locale/me/alerts/:id/delete
 *
 * Remove an alert scoped to the owner. A not-found (missing / non-owned
 * id) collapses to idempotent success so the UI converges — the
 * owner-scoped DELETE means a non-owned id never touches another
 * applicant's row.
 */
async function postAlertDelete(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: AlertIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const locale = resolveLocale(request);

  try {
    await removeAlert({ applicantUserId: session.userId, id });
  } catch (err) {
    if (!(err instanceof AlertNotFoundError)) {
      app.log.error(
        { err, userId: session.userId, alertId: id },
        'applicant.alerts: delete failed',
      );
      return reply.code(500).send({ error: 'internal_error' });
    }
    // Idempotent: a not-found here means the row was already gone (e.g.
    // a double-click on Remove). Fall through to the success path so
    // the UI re-renders the up-to-date list.
  }

  if (isHtmxRequest(request)) {
    const alerts = await listAlerts(session.userId);
    const html = renderAlertsSection(app, {
      locale,
      csrfToken: session.csrfToken,
      cspNonce: request.cspNonce,
      alerts,
      wrap: false,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }
  return reply.code(302).header('location', `/${locale}/me/alerts`).send();
}

// ---------------------------------------------------------------------------
// Applications list & detail (task 27.1 — Req 5.6, 5.7)
// ---------------------------------------------------------------------------

/** Query string for `GET /:locale/me/applications`. */
interface ApplicationsListQuery {
  /** 1-based page number; clamped server-side. */
  page?: unknown;
}

/** URL params for `GET /:locale/me/applications/:id`. */
interface ApplicationIdParams extends LocaleParams {
  id: string;
}

/**
 * Coerce the `:id` URL segment into a strictly positive base-10
 * integer, or return `null` when malformed. Mirrors the same shape as
 * `parseExperienceId` so the two handlers reject obviously-invalid
 * paths the same way.
 */
function parseApplicationId(raw: string): number | null {
  if (!/^[1-9]\d{0,18}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Coerce a possibly-string `?page=` value into a positive integer.
 * Falls back to 1 on anything else (the queries module clamps too,
 * but normalising here keeps the rendered "page X / Y" text correct).
 */
function parsePageQuery(raw: unknown): number {
  if (typeof raw === 'string' && /^[1-9]\d{0,4}$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return 1;
}

/**
 * Render the canonical 404 page for the Applicant_Area applications
 * routes. Used both when the application id is malformed and when the
 * database row does not belong to the authenticated applicant — Req
 * 5.6 / 5.7 require the two cases to look identical so the API never
 * confirms the existence of another user's row.
 */
function renderApplicantNotFound(
  app: FastifyInstance,
  reply: FastifyReply,
  locale: string,
  cspNonce: string | undefined,
): FastifyReply {
  const html = app.view('applicant/404.njk', {
    locale,
    cspNonce,
  });
  return reply.code(404).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /:locale/me/applications  (task 27.1 — Req 5.6)
 *
 * Render the list of every application owned by the authenticated
 * applicant, sorted by `applied_at DESC`. Pagination is driven by a
 * single `?page=` query string segment; the page size is fixed at
 * `APPLICATION_LIST_DEFAULT_PAGE_SIZE` (20) per design §6.
 */
async function getApplicationsList(
  app: FastifyInstance,
  request: FastifyRequest<{
    Params: LocaleParams;
    Querystring: ApplicationsListQuery;
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const page = parsePageQuery(request.query?.page);
  const pageSize = APPLICATION_LIST_DEFAULT_PAGE_SIZE;

  let result;
  try {
    result = await listForApplicant(session.userId, {
      locale: locale as ApplicationLocale,
      page,
      pageSize,
    });
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.applications: list failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const html = app.view('applicant/applications-list.njk', {
    locale,
    rows: result.rows,
    total: result.total,
    page,
    pageSize,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * GET /:locale/me/applications/:id  (task 27.1 — Req 5.7)
 *
 * Render the timeline + applicant-visible notes for a single
 * application. The queries module is responsible for:
 *   - scoping the row read to `applicant_user_id = ?`,
 *   - sorting `application_stage_history` ASC by `changed_at`, and
 *   - filtering `application_notes.visible_to_applicant = 1`.
 *
 * If `findOneForApplicant` returns null (id missing OR owned by
 * someone else) we render the same applicant 404 view so the response
 * never confirms the existence of another user's row.
 */
async function getApplicationDetail(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: ApplicationIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const id = parseApplicationId(request.params.id);
  if (id === null) {
    return renderApplicantNotFound(app, reply, locale, request.cspNonce);
  }

  let detail;
  try {
    detail = await findOneForApplicant(session.userId, id, {
      locale: locale as ApplicationLocale,
    });
  } catch (err) {
    app.log.error(
      { err, userId: session.userId, applicationId: id },
      'applicant.applications: detail failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  if (detail === null) {
    return renderApplicantNotFound(app, reply, locale, request.cspNonce);
  }

  const html = app.view('applicant/application-detail.njk', {
    locale,
    app: detail,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}


/**
 * POST /:locale/me/applications/:id/withdraw  (task 26.2 — Req 5.8)
 *
 * Withdraw an application the authenticated applicant owns. The whole
 * transition lives in {@link withdrawApplication}, which:
 *   - locks + reads the row scoped to `applicant_user_id` (so another
 *     applicant's id collapses to not-found — no row leak),
 *   - rejects a withdraw from a terminal stage ({Hired, Rejected,
 *     Withdrawn}),
 *   - flips `stage='Withdrawn'` and records the stage-history row, and
 *   - emits the audit-stub log line.
 *
 * Responses:
 *   - Success: 302 redirect to `/{locale}/me/applications/:id` so a
 *     refresh of the destination does not re-submit the form
 *     (Post/Redirect/Get). htmx clients follow `HX-Redirect`.
 *   - {@link WithdrawNotAllowedError}: 409 — the application is in a
 *     terminal stage. Carries `{ error: 'terminal_stage' }`.
 *   - {@link ApplicationNotFoundError}: 404 — rendered with the same
 *     applicant 404 page used by the detail route so the response
 *     never confirms the existence of another user's row.
 *   - 404 (malformed id) before the service is invoked.
 *
 * CSRF + auth: the global CSRF preHandler verifies the token for this
 * POST; `requireApplicant` enforces the Applicant role.
 */
async function postApplicationWithdraw(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: ApplicationIdParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }
  const session = await requireApplicant(request, reply);
  if (session === null) return reply;

  const locale = resolveLocale(request);
  const id = parseApplicationId(request.params.id);
  if (id === null) {
    return renderApplicantNotFound(app, reply, locale, request.cspNonce);
  }

  try {
    await withdrawApplication({
      applicantUserId: session.userId,
      applicationId: id,
    });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) {
      return renderApplicantNotFound(app, reply, locale, request.cspNonce);
    }
    if (err instanceof WithdrawNotAllowedError) {
      // The application is in a terminal stage. The applicant landed
      // here from a stale page (the Withdraw button should be hidden
      // once Hired/Rejected/Withdrawn), so surface a 409 the UI can
      // swap rather than a redirect.
      return reply.code(409).send({
        error: 'terminal_stage',
        stage: err.stage,
      });
    }
    app.log.error(
      { err, userId: session.userId, applicationId: id },
      'applicant.applications: withdraw failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  const location = `/${locale}/me/applications/${id}`;
  // htmx clients respect `HX-Redirect` to perform a full page nav;
  // plain browser form submissions follow the 302.
  reply.header('hx-redirect', location);
  return reply.code(302).header('location', location).send();
}


// ---------------------------------------------------------------------------
// Data export (task 47.1 — Req 16.2)
// ---------------------------------------------------------------------------

/**
 * GET /:locale/me/data-export
 *
 * Return a machine-readable JSON dump of all personal data held about
 * the authenticated applicant (Req 16.2). The response is served as a
 * downloadable attachment so the browser prompts a Save dialog rather
 * than rendering the JSON inline.
 *
 * Data included:
 *   - profile (applicants + users row, no password_hash)
 *   - education, experience, skills
 *   - CV file metadata (no file content)
 *   - applications (stage, applied_at, job_id)
 *   - bookmarks, job alerts, consent records
 *
 * All nine queries run in parallel inside `exportApplicantData`.
 *
 * No audit event is recorded for this endpoint — Req 16.2 does not
 * mandate one (Req 16.4 covers HR-triggered exports, not self-service).
 */
async function getDataExport(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
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
      'applicant.data-export: export failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  return reply
    .code(200)
    .header('Content-Type', 'application/json; charset=utf-8')
    .header('Content-Disposition', 'attachment; filename="data-export.json"')
    .send(JSON.stringify(exportData, null, 2));
}

// ---------------------------------------------------------------------------
// Consent (task 46.1 — Req 16.6)
// ---------------------------------------------------------------------------

/**
 * GET /:locale/me/consent
 *
 * Render the privacy policy consent page. The page shows the current
 * policy version and an "I Accept" button that POSTs back to the same
 * URL. This page is shown when the consent-guard detects that the
 * authenticated Applicant has not yet accepted the current policy version.
 */
async function getConsent(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }

  const locale = resolveLocale(request);

  const html = app.view('applicant/consent.njk', {
    locale,
    policyVersion: CURRENT_POLICY_VERSION,
    csrfToken: session.csrfToken,
    cspNonce: request.cspNonce,
  });
  return reply.code(200).type('text/html; charset=utf-8').send(html);
}

/**
 * POST /:locale/me/consent
 *
 * Accept the current privacy policy version. Records the acceptance via
 * `recordAcceptance` (idempotent INSERT IGNORE) and redirects to the
 * applicant dashboard at `/{locale}/me`.
 *
 * CSRF is enforced by the global preHandler hook (the form includes a
 * hidden `_csrf` field). The route requires an authenticated Applicant
 * session via `requireApplicant`.
 */
async function postConsent(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }

  const locale = resolveLocale(request);

  try {
    await recordAcceptance(session.userId, CURRENT_POLICY_VERSION);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.consent: recordAcceptance failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  // Post/Redirect/Get — redirect to the applicant dashboard after acceptance.
  return reply.code(302).header('location', `/${locale}/me`).send();
}

// ---------------------------------------------------------------------------
// POST /:locale/me/account/delete (task 47.2 — Req 16.3)
// ---------------------------------------------------------------------------

/**
 * Handle an account deletion request from the authenticated applicant.
 *
 * Behaviour (Design §6 Applicant_Area, Req 16.3):
 *   1. Authenticate via `requireApplicant`. Missing / non-Applicant
 *      sessions cause a 302 to login and we return.
 *   2. Call `scheduleAccountDeletion(userId, ip)` which, in ONE transaction:
 *      a. Sets `users.status='deleted'` immediately.
 *      b. Revokes all active sessions for the user.
 *      c. Writes an `account_deletion_requested` audit event.
 *   3. Clear the `__Host-sid` and `csrf_token` cookies so the browser
 *      drops the now-invalid session.
 *   4. Redirect 302 to `/{locale}/` (home page).
 *
 * The actual PII anonymization (name, dob, phone, address, email masking
 * + CV file deletion) is deferred to the `account-purge` cron job which
 * runs daily and processes accounts within the 30-day window (Req 16.3).
 *
 * CSRF: The global preHandler hook enforces CSRF token validation on every
 * POST before this handler runs, so no additional check is needed here.
 */
async function postAccountDelete(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: LocaleParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!SUPPORTED_LOCALES.has(request.params.locale)) {
    return reply.code(404).send({ error: 'unknown_locale' });
  }

  const session = await requireApplicant(request, reply);
  if (session === null) {
    return reply;
  }

  const locale = resolveLocale(request);

  // Resolve the client IP for the audit event. Fastify exposes it as
  // `request.ip` (string). We pass it through as-is; the audit writer
  // stores it in the `actor_ip` VARCHAR(45) column.
  const actorIp: string | null =
    typeof request.ip === 'string' && request.ip.length > 0
      ? request.ip
      : null;

  try {
    await scheduleAccountDeletion(session.userId, actorIp);
  } catch (err) {
    app.log.error(
      { err, userId: session.userId },
      'applicant.account-delete: scheduleAccountDeletion failed',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }

  // Clear both cookies so the browser drops the now-invalid session.
  // Mirror the same attribute set used at issuance so the browser
  // actually honours the clear (path/secure/sameSite must match).
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE_OPTIONS);

  // Redirect to the home page. The account is flagged as deleted and all
  // sessions have been revoked, so the user cannot log back in.
  return reply.code(302).header('location', `/${locale}/`).send();
}

/**
 * Fastify plugin that mounts the Applicant_Area routes implemented so far.
 *
 * Register from `src/server.ts`:
 *
 *   ```ts
 *   import applicantRoutes from './routes/applicant.js';
 *   await app.register(applicantRoutes);
 *   ```
 *
 * The plugin does not declare a prefix — the locale lives in the URL as
 * `:locale` so each route owns its own path. This keeps the design's
 * `GET /:locale/me/profile` mapping (§6 Applicant_Area) readable from
 * the route file.
 */
export const applicantRoutes: FastifyPluginAsync = async (app) => {
  // Dashboard (task 18.1 — Req 4.9, 4.10). Renders
  // `views/applicant/dashboard.njk` with the completeness percentage
  // and missing slot list returned by `computeCompleteness`.
  app.get<{ Params: LocaleParams }>(
    '/:locale/me',
    (request, reply) => getDashboard(app, request, reply),
  );

  app.get<{ Params: LocaleParams; Querystring: ProfileQuery }>(
    '/:locale/me/profile',
    (request, reply) => getProfile(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: ProfileBody }>(
    '/:locale/me/profile',
    (request, reply) => postProfile(app, request, reply),
  );

  // Education (task 16.2 — Req 4.2). Mounts list + create + edit + update
  // + delete; htmx swaps the section fragment in place after every write.
  app.get<{ Params: LocaleParams }>(
    '/:locale/me/profile/education',
    (request, reply) => getEducationList(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: EducationBody }>(
    '/:locale/me/profile/education',
    (request, reply) => postEducationCreate(app, request, reply),
  );

  app.get<{ Params: EducationIdParams }>(
    '/:locale/me/profile/education/:id/edit',
    (request, reply) => getEducationEdit(app, request, reply),
  );

  app.post<{ Params: EducationIdParams; Body: EducationBody }>(
    '/:locale/me/profile/education/:id',
    (request, reply) => postEducationUpdate(app, request, reply),
  );

  app.post<{ Params: EducationIdParams }>(
    '/:locale/me/profile/education/:id/delete',
    (request, reply) => postEducationDelete(app, request, reply),
  );

  // ----- Experience CRUD (task 16.3 — Req 4.3) ---------------------------
  // Mirrors the education shape but with the cap raised to 30 entries
  // and the `is_current` ↔ `end_date IS NULL` invariant enforced by the
  // service. The htmx flow swaps `#experience-section` outerHTML after
  // every successful create/update/delete.

  app.get<{ Params: LocaleParams }>(
    '/:locale/me/profile/experience',
    (request, reply) => getExperience(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: ExperienceBody }>(
    '/:locale/me/profile/experience',
    (request, reply) => postExperienceCreate(app, request, reply),
  );

  app.get<{ Params: ExperienceIdParams }>(
    '/:locale/me/profile/experience/:id/edit',
    (request, reply) => getExperienceEdit(app, request, reply),
  );

  app.post<{ Params: ExperienceIdParams; Body: ExperienceBody }>(
    '/:locale/me/profile/experience/:id/edit',
    (request, reply) => postExperienceEdit(app, request, reply),
  );

  app.post<{ Params: ExperienceIdParams }>(
    '/:locale/me/profile/experience/:id/delete',
    (request, reply) => postExperienceDelete(app, request, reply),
  );

  // htmx fragment route — returns just `views/applicant/experience-row.njk`
  // for a single entry. Mounted at `/row` so it does not collide with
  // `/edit` or `/delete` in the routing table.
  app.get<{ Params: ExperienceIdParams }>(
    '/:locale/me/profile/experience/:id/row',
    (request, reply) => getExperienceRow(app, request, reply),
  );

  // ----- Skill tags (task 16.4 — Req 4.4) --------------------------------
  // The full section is served at `/skills`. Toggling a skill happens
  // via `/skills/toggle` (POST, htmx swaps `#skills-section` outerHTML).
  // Autocomplete suggestions come from `/skills/search?q=...` and are
  // served as a `<ul>` fragment matching `applicant/skill-search-results.njk`.

  app.get<{ Params: LocaleParams }>(
    '/:locale/me/profile/skills',
    (request, reply) => getSkills(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: SkillToggleBody }>(
    '/:locale/me/profile/skills/toggle',
    (request, reply) => postSkillToggle(app, request, reply),
  );

  app.get<{ Params: LocaleParams; Querystring: SkillSearchQuery }>(
    '/:locale/me/profile/skills/search',
    (request, reply) => getSkillSearch(app, request, reply),
  );

  // ----- CV download (task 17.3 — Req 15.6) -----------------------------
  // The owner branch is wired here; HR/Super_Admin downloads via an
  // Application reference will surface in Phase 5 (task 30) once the
  // `applications` table lands. `requireApplicant` rejects internal
  // roles, so this route is naturally Applicant-scoped — the HR branch
  // of `loadCvForDownload` is dormant under this mount point.
  app.get<{ Params: CvIdParams }>(
    '/:locale/me/cv/:id',
    (request, reply) => getCvDownload(app, request, reply),
  );

  // ----- CV upload pipeline (task 17.1 — Req 4.5-4.8, 15.5) -------------
  // GET serves the upload form + current CV history. POST runs the
  // full multipart streaming pipeline (size cap, magic-byte sniff,
  // tmp → File_Store rename, INSERT + history prune). Mounted AFTER
  // `/me/cv/:id` so the more-specific download route always wins on
  // GET; POST is unique to the list URL.
  app.get<{ Params: LocaleParams; Querystring: ProfileQuery }>(
    '/:locale/me/cv',
    (request, reply) => getCv(app, request, reply),
  );

  app.post<{ Params: LocaleParams }>(
    '/:locale/me/cv',
    (request, reply) => postCv(app, request, reply),
  );

  // ----- Bookmarks (task 28.1 — Req 6.4, 6.5, 6.6) ----------------------
  // `POST /api/bookmarks/toggle` is intentionally NOT locale-prefixed —
  // it is a JSON/htmx endpoint not tied to any rendered page. The
  // bookmark page itself lives at `/:locale/me/bookmarks` and renders
  // the active applicant's saved jobs (still listing inactive ones
  // per Req 6.6). The toggle endpoint validates the body via zod, so
  // a missing/non-integer `jobId` lands as a 400 with a field-level
  // error map — matching the shape used by the other Applicant_Area
  // routes.

  // ----- Apply to a job (task 26.1 — Req 5.1, 5.2, 5.3, 5.4, 5.5, 14.4) --
  // `POST /api/applications` is intentionally NOT locale-prefixed —
  // it is a JSON / htmx endpoint not tied to any rendered page. The
  // redirect target IS locale-prefixed (`/{locale}/me/applications/:id`).
  // CSRF runs at the global preHandler hook; rate limiting (Req 14.4)
  // lands later when the rate-limiter middleware is wired into this
  // module. Body shape is validated by `applyBodySchema` and the
  // service throws domain errors that the handler maps to 422 / 409.

  app.post<{ Querystring: ApplyQuery; Body: unknown }>(
    '/api/applications',
    (request, reply) => postApply(app, request, reply),
  );

  app.post<{ Body: unknown }>(
    '/api/bookmarks/toggle',
    (request, reply) => postBookmarkToggle(app, request, reply),
  );

  app.get<{ Params: LocaleParams }>(
    '/:locale/me/bookmarks',
    (request, reply) => getBookmarks(app, request, reply),
  );

  // ----- Job alerts (task 33.1 — Req 7.1) -------------------------------
  // The alerts page lists the applicant's saved alerts plus a create
  // form. POST creates (cap of 10 enforced in the service); the per-row
  // delete endpoint removes one. htmx swaps `#alerts-section` outerHTML
  // after every write; non-htmx clients get a 302 back to the page.
  app.get<{ Params: LocaleParams }>(
    '/:locale/me/alerts',
    (request, reply) => getAlerts(app, request, reply),
  );

  app.post<{ Params: LocaleParams; Body: AlertBody }>(
    '/:locale/me/alerts',
    (request, reply) => postAlertCreate(app, request, reply),
  );

  app.post<{ Params: AlertIdParams }>(
    '/:locale/me/alerts/:id/delete',
    (request, reply) => postAlertDelete(app, request, reply),
  );

  // ----- Applications list & detail (task 27.1 — Req 5.6, 5.7) ----------
  // Applicants can see every application they have submitted, sorted
  // newest-first, and drill into the timeline + applicant-visible
  // notes. The queries module enforces ownership scoping at the SQL
  // layer; the route layer adds the locale guard and the 404
  // collapse for missing / non-owned ids.
  app.get<{ Params: LocaleParams; Querystring: ApplicationsListQuery }>(
    '/:locale/me/applications',
    (request, reply) => getApplicationsList(app, request, reply),
  );

  app.get<{ Params: ApplicationIdParams }>(
    '/:locale/me/applications/:id',
    (request, reply) => getApplicationDetail(app, request, reply),
  );

  app.post<{ Params: ApplicationIdParams }>(
    '/:locale/me/applications/:id/withdraw',
    (request, reply) => postApplicationWithdraw(app, request, reply),
  );

  // ----- Consent (task 46.1 — Req 16.6) ----------------------------------
  // GET renders the consent page with the current policy version and an
  // "I Accept" form. POST records the acceptance (idempotent INSERT IGNORE)
  // and redirects to the applicant dashboard. CSRF is enforced by the
  // global preHandler hook.
  app.get<{ Params: LocaleParams }>(
    '/:locale/me/consent',
    (request, reply) => getConsent(app, request, reply),
  );

  app.post<{ Params: LocaleParams }>(
    '/:locale/me/consent',
    (request, reply) => postConsent(app, request, reply),
  );

  // ----- Data export (task 47.1 — Req 16.2) ------------------------------
  // Returns a JSON attachment containing all personal data held about
  // the authenticated applicant. No audit event is required (Req 16.2
  // does not mandate one for self-service exports).
  app.get<{ Params: LocaleParams }>(
    '/:locale/me/data-export',
    (request, reply) => getDataExport(app, request, reply),
  );

  // ----- Account deletion (task 47.2 — Req 16.3) -------------------------
  // POST flags the account as deleted immediately (users.status='deleted'),
  // revokes all sessions, writes an audit event, clears cookies, and
  // redirects to the home page. The actual PII anonymization is deferred
  // to the `account-purge` cron job (daily) which processes accounts
  // within the 30-day window mandated by Req 16.3.
  // CSRF is enforced by the global preHandler hook on every POST.
  app.post<{ Params: LocaleParams }>(
    '/:locale/me/account/delete',
    (request, reply) => postAccountDelete(app, request, reply),
  );
};

export default applicantRoutes;
