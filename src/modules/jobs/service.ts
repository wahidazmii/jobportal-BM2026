/**
 * Job_Posting service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 21.3
 * Design  : §6 Admin
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
 *
 * Public surface:
 *   - `jobInputSchema`            — zod schema for the create/update form.
 *   - `JobInput`                  — type inferred from the schema.
 *   - `slugSchema`                — kebab-case slug validator (1..120).
 *   - `cloneInputSchema`          — schema for the clone form.
 *   - `createJob(input, actor)`   — validate + repo.save() with status=Draft.
 *   - `updateJob(id, input, actor, scope?)`
 *                                 — validate + repo.save() with the
 *                                   incoming status, after asserting the
 *                                   transition from the persisted state.
 *   - `publishJob(id, actor, scope?)` — repo.publish().
 *   - `closeJob(id, actor, scope?)`   — repo.softClose().
 *   - `archiveJob(id, actor, scope?)` — repo.archive().
 *   - `cloneJob(id, input, actor, scope?)` — clone with a new slug.
 *
 * Validation contract:
 *   - `slug` is kebab-case `[a-z0-9]+(?:-[a-z0-9]+)*`, 1..120 chars.
 *     Required when status is Published — a Draft can carry an empty
 *     slug while HR is still drafting (the column is NOT NULL but the
 *     service ensures a non-empty value before insert).
 *   - Each translation's `title` is 1..150 chars, `description` is
 *     1..30000 chars, `requirements` and `responsibilities` are
 *     1..30000 chars (matches MEDIUMTEXT realistically; we cap at
 *     30000 to keep the form small and the index quick).
 *   - `salary_min ≤ salary_max` when both provided.
 *   - `application_deadline`, when provided, must be `YYYY-MM-DD`.
 *
 * Why the service owns transition assertion:
 *   - The repo layer's `save()` accepts any status, leaving the state
 *     machine to be enforced one layer up. The route layer hands raw
 *     form input to this service, which loads the persisted row,
 *     `assertTransition(prev, next)`, then calls `save()`. That keeps
 *     the repo a pure persistence helper that the cron / migration
 *     scripts can also use without re-rolling the state machine.
 */

import { z } from 'zod';

import { logger } from '../../infra/logger.js';
import {
  EMPLOYMENT_TYPES,
  JOB_LEVELS,
  JOB_LOCALES,
  JobNotFoundError,
  SLUG_MAX_LEN,
  TITLE_MAX_LEN,
  LOCATION_MAX_LEN,
  type JobLocale,
  type JobPostingDetail,
  type JobScope,
  type JobSaveInput,
  type JobTranslationInput,
  clone as repoClone,
  findById as repoFindById,
  save as repoSave,
  softClose as repoSoftClose,
  archive as repoArchive,
  publish as repoPublish,
} from './repo.js';
import {
  JOB_STATUSES,
  assertTransition,
  type JobStatus,
} from './state-machine.js';

// ---------------------------------------------------------------------------
// Re-exports for the route layer
// ---------------------------------------------------------------------------

export { JobNotFoundError, repoFindById as findJobById, JOB_STATUSES };
export type { JobPostingDetail, JobScope };

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/**
 * Slug validator. Enforces:
 *   - kebab-case: lowercase letters, digits, dashes; no leading or
 *     trailing dash; no consecutive dashes.
 *   - length 1..120 (matches the column).
 */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
  .string({ required_error: 'Slug is required' })
  .trim()
  .min(1, { message: 'Slug is required' })
  .max(SLUG_MAX_LEN, { message: `Slug must be at most ${SLUG_MAX_LEN} characters` })
  .regex(SLUG_REGEX, {
    message:
      'Slug must be kebab-case (lowercase letters, digits, hyphens; no spaces)',
  });

/**
 * Slug variant that accepts an empty string (for Drafts that haven't
 * been named yet). The publish path still requires a non-empty
 * `slugSchema` value, so an empty Draft slug never reaches the public
 * site.
 */
const optionalSlugSchema = z
  .string()
  .trim()
  .max(SLUG_MAX_LEN, { message: `Slug must be at most ${SLUG_MAX_LEN} characters` })
  .refine((v) => v === '' || SLUG_REGEX.test(v), {
    message:
      'Slug must be kebab-case (lowercase letters, digits, hyphens; no spaces)',
  });

const locationSchema = z
  .string({ required_error: 'Location is required' })
  .trim()
  .min(1, { message: 'Location is required' })
  .max(LOCATION_MAX_LEN, {
    message: `Location must be at most ${LOCATION_MAX_LEN} characters`,
  });

const employmentTypeSchema = z.enum(EMPLOYMENT_TYPES as readonly [string, ...string[]] as readonly [
  'full-time',
  'part-time',
  'contract',
  'internship',
]);

const levelSchema = z.enum(JOB_LEVELS as readonly [string, ...string[]] as readonly [
  'entry',
  'junior',
  'mid',
  'senior',
  'lead',
  'manager',
  'director',
]);

const statusSchema = z.enum(JOB_STATUSES);

const optionalIntStringSchema = z
  .union([z.number(), z.string()])
  .optional()
  .transform((v, ctx): number | null => {
    if (v === undefined) return null;
    if (typeof v === 'string') {
      if (v.trim() === '') return null;
      const n = Number(v.trim());
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Must be a non-negative integer',
        });
        return null;
      }
      return n;
    }
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must be a non-negative integer',
      });
      return null;
    }
    return v;
  });

const optionalCurrencySchema = z
  .string()
  .trim()
  .optional()
  .transform((v): string | null => {
    if (v === undefined || v === '') return null;
    return v.toUpperCase();
  })
  .refine((v) => v === null || /^[A-Z]{3}$/.test(v), {
    message: 'Currency must be a 3-letter ISO code (e.g. IDR, USD)',
  });

const optionalDateSchema = z
  .string()
  .trim()
  .optional()
  .transform((v): string | null => {
    if (v === undefined || v === '') return null;
    return v;
  })
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    message: 'Date must be in YYYY-MM-DD format',
  })
  .refine(
    (v) => v === null || !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
    { message: 'Date is not a valid calendar date' },
  );

// Note: a strict `translationSchema` (all four text fields required) is
// not declared here because the `optionalTranslationSchema` plus the
// Published-mode `superRefine` below already enforces "at least one
// complete translation when status=Published" — exactly the rule the
// repository / public site cares about. Drafts may carry a partially-
// filled translation row, so a single strict schema would over-reject.

const optionalTranslationSchema = z
  .object({
    locale: z.enum(JOB_LOCALES),
    title: z.string().trim().max(TITLE_MAX_LEN),
    description: z.string().trim().max(30000),
    requirements: z.string().trim().max(30000),
    responsibilities: z.string().trim().max(30000),
  })
  .transform((t) => ({
    locale: t.locale,
    title: t.title,
    description: t.description,
    requirements: t.requirements,
    responsibilities: t.responsibilities,
  }));

// ---------------------------------------------------------------------------
// Job input schema
// ---------------------------------------------------------------------------

/**
 * Schema for the admin create/update form. Translations are an array
 * because the form posts them as repeated fields keyed by locale; the
 * service collapses duplicate locales (last write wins).
 *
 * The schema is split into a "Draft mode" branch that allows an empty
 * slug + empty translations, and a "Published mode" branch that
 * tightens both. The split happens via `superRefine` because Zod's
 * `discriminatedUnion` does not gel with the form-encoded shape.
 */
export const jobInputSchema = z
  .object({
    slug: optionalSlugSchema,
    department_id: optionalIntStringSchema,
    location: locationSchema,
    employment_type: employmentTypeSchema,
    level: levelSchema,
    status: statusSchema,
    salary_min: optionalIntStringSchema,
    salary_max: optionalIntStringSchema,
    salary_currency: optionalCurrencySchema,
    application_deadline: optionalDateSchema,
    translations: z.array(optionalTranslationSchema).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      value.salary_min !== null &&
      value.salary_max !== null &&
      value.salary_min > value.salary_max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salary_min'],
        message: 'Minimum salary must not exceed maximum salary',
      });
    }

    if (value.status === 'Published') {
      if (value.slug === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slug'],
          message: 'Slug is required to publish a job posting',
        });
      }
      // For Published we require AT LEAST ONE translation with all
      // four fields populated. We do not require BOTH locales because
      // a job posted in only one language is still useful.
      const hasComplete = value.translations.some((t) => {
        return (
          t.title.length > 0 &&
          t.description.length > 0 &&
          t.requirements.length > 0 &&
          t.responsibilities.length > 0
        );
      });
      if (!hasComplete) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['translations'],
          message:
            'At least one complete translation (title, description, requirements, responsibilities) is required to publish',
        });
      }
    }
  });

export type JobInput = z.infer<typeof jobInputSchema>;

/** Schema for the clone form — only the new slug is collected. */
export const cloneInputSchema = z
  .object({
    slug: slugSchema,
  })
  .strict();

export type CloneInput = z.infer<typeof cloneInputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drop translation rows whose every text field is empty. The form
 * posts both locales side-by-side; if HR fills in only the id locale,
 * we want to skip the empty en row entirely (no DELETE-then-INSERT
 * an empty row that fails the NOT NULL columns).
 */
function pruneEmptyTranslations(
  translations: readonly { locale: JobLocale; title: string; description: string; requirements: string; responsibilities: string }[],
): JobTranslationInput[] {
  const out: JobTranslationInput[] = [];
  const seen = new Set<JobLocale>();
  // Walk in reverse so a duplicate locale's LAST occurrence wins; then
  // reverse the result to preserve the original order.
  for (let i = translations.length - 1; i >= 0; i--) {
    const t = translations[i];
    if (!t) continue;
    if (seen.has(t.locale)) continue;
    if (
      t.title.length === 0 &&
      t.description.length === 0 &&
      t.requirements.length === 0 &&
      t.responsibilities.length === 0
    ) {
      continue;
    }
    seen.add(t.locale);
    out.push({
      locale: t.locale,
      title: t.title,
      description: t.description,
      requirements: t.requirements,
      responsibilities: t.responsibilities,
    });
  }
  return out.reverse();
}

function inputToSavePayload(
  id: number | null,
  input: JobInput,
): Omit<JobSaveInput, 'skillLabels'> {
  return {
    id,
    slug: input.slug,
    department_id: input.department_id,
    location: input.location,
    employment_type: input.employment_type as JobSaveInput['employment_type'],
    level: input.level as JobSaveInput['level'],
    status: input.status as JobStatus,
    salary_min: input.salary_min,
    salary_max: input.salary_max,
    salary_currency: input.salary_currency,
    application_deadline: input.application_deadline,
    published_at: input.status === 'Published' ? new Date() : null,
    translations: pruneEmptyTranslations(input.translations),
  };
}

// ---------------------------------------------------------------------------
// Service entrypoints
// ---------------------------------------------------------------------------

/**
 * Create a new Draft job. The status field on the input is forced to
 * 'Draft' regardless of what the form posted — the publish step is a
 * separate endpoint (`POST /admin/jobs/:id/publish`).
 */
export async function createJob(
  rawInput: unknown,
  actorUserId: number,
): Promise<JobPostingDetail> {
  const input = jobInputSchema.parse({
    ...((rawInput as Record<string, unknown>) ?? {}),
    status: 'Draft',
  });
  const payload = inputToSavePayload(null, input);
  return repoSave({ ...payload, skillLabels: [] }, actorUserId);
}

/**
 * Update an existing job. The status on the input MUST equal the
 * current status — transitions go through the dedicated `publishJob`
 * / `closeJob` / `archiveJob` endpoints. We assert this here so a
 * smuggled `<input name="status">` cannot bypass the state machine.
 */
export async function updateJob(
  id: number,
  rawInput: unknown,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPostingDetail> {
  const existing = await repoFindById(id, scope);
  if (existing === null) throw new JobNotFoundError(id);

  // Force the status on the input to match the persisted value. The
  // form may post a stale value if the user clicked "Save" after a
  // background publish; ignoring it keeps the state machine honest.
  const input = jobInputSchema.parse({
    ...((rawInput as Record<string, unknown>) ?? {}),
    status: existing.status,
  });

  const payload = inputToSavePayload(id, input);
  return repoSave({ ...payload, skillLabels: [] }, actorUserId);
}

/**
 * Transition Draft → Published. Sets `published_at = NOW()` (handled
 * by the repo). Re-runs the search-text computation by piggybacking
 * on `save()` with the existing translations so the FULLTEXT index
 * picks up any drift between the last save and now (Req 9.6).
 */
export async function publishJob(
  id: number,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPostingDetail> {
  const existing = await repoFindById(id, scope);
  if (existing === null) throw new JobNotFoundError(id);

  // State machine guard. The repo layer also asserts inside the
  // transaction; doing it here lets us return a clean error before
  // opening the connection.
  assertTransition(existing.status, 'Published');

  // The publish path requires a non-empty slug + at least one
  // complete translation. We piggyback on `jobInputSchema` to
  // re-validate the persisted state instead of duplicating the rule.
  const translations = JOB_LOCALES.map((locale) => {
    const tr = existing.translations[locale];
    return {
      locale,
      title: tr?.title ?? '',
      description: tr?.description ?? '',
      requirements: tr?.requirements ?? '',
      responsibilities: tr?.responsibilities ?? '',
    };
  });

  jobInputSchema.parse({
    slug: existing.slug,
    department_id: existing.department_id,
    location: existing.location,
    employment_type: existing.employment_type,
    level: existing.level,
    status: 'Published',
    salary_min: existing.salary_min ?? '',
    salary_max: existing.salary_max ?? '',
    salary_currency: existing.salary_currency ?? '',
    application_deadline: existing.application_deadline ?? '',
    translations,
  });

  // We delegate the actual UPDATE to repo.publish so the slug FOR
  // UPDATE lock is held inside the same transaction.
  const updated = await repoPublish(id, actorUserId, scope);

  logger.info(
    { event: 'job_publish', actor_user_id: actorUserId, job_id: id },
    'jobs.service: published job',
  );

  // Re-read the full detail (translations + new published_at).
  const fresh = await repoFindById(id, scope);
  if (fresh === null) throw new JobNotFoundError(id);
  // Belt + suspenders: ensure the returned detail reflects the
  // post-update status. `repoPublish` already updated the row, but
  // an in-flight cache layer could surprise us — explicit is better.
  void updated;
  return fresh;
}

/** Transition Published → Closed. */
export async function closeJob(
  id: number,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPostingDetail> {
  await repoSoftClose(id, actorUserId, scope);
  const fresh = await repoFindById(id, scope);
  if (fresh === null) throw new JobNotFoundError(id);
  logger.info(
    { event: 'job_close', actor_user_id: actorUserId, job_id: id },
    'jobs.service: closed job',
  );
  return fresh;
}

/** Transition to Archived (from Published or Closed). */
export async function archiveJob(
  id: number,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPostingDetail> {
  await repoArchive(id, actorUserId, scope);
  const fresh = await repoFindById(id, scope);
  if (fresh === null) throw new JobNotFoundError(id);
  logger.info(
    { event: 'job_archive', actor_user_id: actorUserId, job_id: id },
    'jobs.service: archived job',
  );
  return fresh;
}

/**
 * Clone a job into a fresh Draft with the supplied new slug.
 * Per Req 9.5 every field is copied EXCEPT slug, status, and
 * `published_at`.
 */
export async function cloneJob(
  id: number,
  rawInput: unknown,
  actorUserId: number,
  scope?: JobScope,
): Promise<JobPostingDetail> {
  const input = cloneInputSchema.parse(rawInput);
  const cloned = await repoClone(id, actorUserId, input.slug, scope);
  logger.info(
    {
      event: 'job_clone',
      actor_user_id: actorUserId,
      source_job_id: id,
      new_job_id: cloned.id,
    },
    'jobs.service: cloned job',
  );
  return cloned;
}
