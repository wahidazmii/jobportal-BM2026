/**
 * Applicant data-export service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 47.1
 * Design  : §6 Applicant_Area (data-export row), §16 (privacy)
 * Validates: Requirement 16.2
 *
 * Public surface:
 *   - `ApplicantDataExport`       — typed shape of the full export payload.
 *   - `exportApplicantData(userId)` — collect all personal data held about
 *                                     the applicant in parallel and return
 *                                     a single typed object.
 *
 * Data collected (Req 16.2):
 *   - profile      : `applicants` JOIN `users` row (no password_hash).
 *   - education    : all `applicant_education` rows.
 *   - experience   : all `applicant_experience` rows.
 *   - skills       : skill labels from `skill_tags` JOIN `applicant_skills`.
 *   - cvFiles      : metadata from `applicant_cv_files` (no file content).
 *   - applications : stage, applied_at, job_id from `applications`.
 *   - bookmarks    : all `bookmarks` rows.
 *   - alerts       : all `job_alerts` rows.
 *   - consentRecords : all `consent_records` rows.
 *
 * SQL conventions:
 *   - All SQL assembled via `Array.join(' ')` — no string interpolation.
 *   - All parameters passed as positional `?` placeholders via `query()`.
 *   - All queries run in parallel via `Promise.all` to minimise latency.
 *
 * Security:
 *   - `password_hash` is explicitly excluded from the profile query.
 *   - `storage_path` (internal disk path) is excluded from cvFiles.
 *   - The caller (route layer) sources `userId` from the session, never
 *     from user input, so the export is always scoped to the authenticated
 *     applicant.
 */

import {
  query,
  type RowDataPacket,
} from '../../infra/db.js';

// ---------------------------------------------------------------------------
// Types — export payload
// ---------------------------------------------------------------------------

/** Combined profile from `applicants` + `users`. */
export interface ExportProfile {
  user_id: number;
  uuid: string;
  email: string;
  role: string;
  status: string;
  email_verified_at: string | null;
  created_at: string;
  full_name: string;
  date_of_birth: string | null;
  gender: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  summary: string | null;
  language_pref: string;
}

export interface ExportEducation {
  id: number;
  institution: string;
  degree: string;
  field: string;
  start_date: string;
  end_date: string | null;
  in_progress: boolean;
  gpa: number | null;
}

export interface ExportExperience {
  id: number;
  company: string;
  title: string;
  employment_type: string;
  start_date: string;
  end_date: string | null;
  is_current: boolean;
  description: string | null;
}

export interface ExportSkill {
  label: string;
}

export interface ExportCvFile {
  id: number;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  is_active: boolean;
  uploaded_at: string;
}

export interface ExportApplication {
  id: number;
  uuid: string;
  reference_no: string;
  job_id: number;
  stage: string;
  source: string;
  applied_at: string;
  updated_at: string;
  hired_at: string | null;
}

export interface ExportBookmark {
  job_id: number;
  created_at: string;
}

export interface ExportAlert {
  id: number;
  keyword: string | null;
  locations: unknown;
  departments: unknown;
  frequency: string;
  last_evaluated_at: string | null;
  created_at: string;
}

export interface ExportConsentRecord {
  id: number;
  policy_version: string;
  accepted_at: string;
}

/** Full data-export payload returned by `exportApplicantData`. */
export interface ApplicantDataExport {
  exportedAt: string;
  profile: ExportProfile | null;
  education: ExportEducation[];
  experience: ExportExperience[];
  skills: ExportSkill[];
  cvFiles: ExportCvFile[];
  applications: ExportApplication[];
  bookmarks: ExportBookmark[];
  alerts: ExportAlert[];
  consentRecords: ExportConsentRecord[];
}

// ---------------------------------------------------------------------------
// SQL constants — assembled via Array.join(' ') per project convention
// ---------------------------------------------------------------------------

const SELECT_PROFILE_SQL = [
  'SELECT',
  '  a.user_id, u.uuid, u.email, u.role, u.status,',
  '  u.email_verified_at, u.created_at,',
  '  a.full_name, a.date_of_birth, a.gender, a.phone,',
  '  a.address, a.city, a.province, a.country,',
  '  a.summary, a.language_pref',
  'FROM applicants a',
  'JOIN users u ON u.id = a.user_id',
  'WHERE a.user_id = ?',
  'LIMIT 1',
].join(' ');

const SELECT_EDUCATION_SQL = [
  'SELECT',
  '  id, institution, degree, field,',
  '  start_date, end_date, in_progress, gpa',
  'FROM applicant_education',
  'WHERE applicant_user_id = ?',
  'ORDER BY start_date DESC',
].join(' ');

const SELECT_EXPERIENCE_SQL = [
  'SELECT',
  '  id, company, title, employment_type,',
  '  start_date, end_date, is_current, description',
  'FROM applicant_experience',
  'WHERE applicant_user_id = ?',
  'ORDER BY start_date DESC',
].join(' ');

const SELECT_SKILLS_SQL = [
  'SELECT s.label',
  'FROM applicant_skills aps',
  'JOIN skill_tags s ON s.id = aps.skill_id',
  'WHERE aps.applicant_user_id = ?',
  'ORDER BY s.label ASC',
].join(' ');

const SELECT_CV_FILES_SQL = [
  'SELECT',
  '  id, original_filename, mime_type, size_bytes,',
  '  is_active, uploaded_at',
  'FROM applicant_cv_files',
  'WHERE applicant_user_id = ?',
  'ORDER BY uploaded_at DESC',
].join(' ');

const SELECT_APPLICATIONS_SQL = [
  'SELECT',
  '  id, uuid, reference_no, job_id,',
  '  stage, source, applied_at, updated_at, hired_at',
  'FROM applications',
  'WHERE applicant_user_id = ?',
  'ORDER BY applied_at DESC',
].join(' ');

const SELECT_BOOKMARKS_SQL = [
  'SELECT job_id, created_at',
  'FROM bookmarks',
  'WHERE applicant_user_id = ?',
  'ORDER BY created_at DESC',
].join(' ');

const SELECT_ALERTS_SQL = [
  'SELECT',
  '  id, keyword, locations, departments,',
  '  frequency, last_evaluated_at, created_at',
  'FROM job_alerts',
  'WHERE applicant_user_id = ?',
  'ORDER BY created_at DESC',
].join(' ');

const SELECT_CONSENT_RECORDS_SQL = [
  'SELECT id, policy_version, accepted_at',
  'FROM consent_records',
  'WHERE applicant_user_id = ?',
  'ORDER BY accepted_at DESC',
].join(' ');

// ---------------------------------------------------------------------------
// Row types (mysql2 RowDataPacket extensions)
// ---------------------------------------------------------------------------

interface ProfileRow extends RowDataPacket {
  user_id: number | string;
  uuid: string;
  email: string;
  role: string;
  status: string;
  email_verified_at: Date | string | null;
  created_at: Date | string;
  full_name: string;
  date_of_birth: Date | string | null;
  gender: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  summary: string | null;
  language_pref: string;
}

interface EducationRow extends RowDataPacket {
  id: number | string;
  institution: string;
  degree: string;
  field: string;
  start_date: Date | string;
  end_date: Date | string | null;
  in_progress: number;
  gpa: number | string | null;
}

interface ExperienceRow extends RowDataPacket {
  id: number | string;
  company: string;
  title: string;
  employment_type: string;
  start_date: Date | string;
  end_date: Date | string | null;
  is_current: number;
  description: string | null;
}

interface SkillRow extends RowDataPacket {
  label: string;
}

interface CvFileRow extends RowDataPacket {
  id: number | string;
  original_filename: string;
  mime_type: string;
  size_bytes: number | string;
  is_active: number;
  uploaded_at: Date | string;
}

interface ApplicationRow extends RowDataPacket {
  id: number | string;
  uuid: string;
  reference_no: string;
  job_id: number | string;
  stage: string;
  source: string;
  applied_at: Date | string;
  updated_at: Date | string;
  hired_at: Date | string | null;
}

interface BookmarkRow extends RowDataPacket {
  job_id: number | string;
  created_at: Date | string;
}

interface AlertRow extends RowDataPacket {
  id: number | string;
  keyword: string | null;
  locations: unknown;
  departments: unknown;
  frequency: string;
  last_evaluated_at: Date | string | null;
  created_at: Date | string;
}

interface ConsentRow extends RowDataPacket {
  id: number | string;
  policy_version: string;
  accepted_at: Date | string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a mysql2 date value (Date object or string) to an ISO-8601
 * string. Returns `null` for null/undefined inputs. DATE columns come
 * back as `Date` objects with time set to midnight UTC; DATETIME columns
 * also come back as `Date` objects. We use `toISOString()` for both so
 * the output is always a well-formed, timezone-unambiguous string.
 */
function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

/**
 * Normalise a mysql2 date value to a `YYYY-MM-DD` string (for DATE
 * columns). Returns `null` for null/undefined inputs.
 */
function toDateString(value: Date | string | null | undefined): string | null {
  const iso = toIsoString(value);
  if (iso === null) return null;
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect all personal data held about the applicant and return it as a
 * single typed `ApplicantDataExport` object.
 *
 * All nine queries run in parallel via `Promise.all` to minimise
 * round-trip latency. Each query is scoped to `userId` via a positional
 * `?` placeholder — the caller (route layer) sources `userId` from the
 * authenticated session, never from user input.
 *
 * The `profile` field is `null` only when the `applicants` row is
 * missing (should not happen in normal operation — registration always
 * inserts it). All list fields default to `[]` when the table has no
 * matching rows.
 */
export async function exportApplicantData(
  userId: number,
): Promise<ApplicantDataExport> {
  const [
    profileRows,
    educationRows,
    experienceRows,
    skillRows,
    cvFileRows,
    applicationRows,
    bookmarkRows,
    alertRows,
    consentRows,
  ] = await Promise.all([
    query<ProfileRow[]>(SELECT_PROFILE_SQL, [userId]),
    query<EducationRow[]>(SELECT_EDUCATION_SQL, [userId]),
    query<ExperienceRow[]>(SELECT_EXPERIENCE_SQL, [userId]),
    query<SkillRow[]>(SELECT_SKILLS_SQL, [userId]),
    query<CvFileRow[]>(SELECT_CV_FILES_SQL, [userId]),
    query<ApplicationRow[]>(SELECT_APPLICATIONS_SQL, [userId]),
    query<BookmarkRow[]>(SELECT_BOOKMARKS_SQL, [userId]),
    query<AlertRow[]>(SELECT_ALERTS_SQL, [userId]),
    query<ConsentRow[]>(SELECT_CONSENT_RECORDS_SQL, [userId]),
  ]);

  // Map profile row
  const profileRow = profileRows[0] ?? null;
  const profile: ExportProfile | null = profileRow
    ? {
        user_id: Number(profileRow.user_id),
        uuid: profileRow.uuid,
        email: profileRow.email,
        role: profileRow.role,
        status: profileRow.status,
        email_verified_at: toIsoString(profileRow.email_verified_at),
        created_at: toIsoString(profileRow.created_at) ?? '',
        full_name: profileRow.full_name,
        date_of_birth: toDateString(profileRow.date_of_birth),
        gender: profileRow.gender,
        phone: profileRow.phone,
        address: profileRow.address,
        city: profileRow.city,
        province: profileRow.province,
        country: profileRow.country,
        summary: profileRow.summary,
        language_pref: profileRow.language_pref,
      }
    : null;

  // Map education rows
  const education: ExportEducation[] = educationRows.map((r) => ({
    id: Number(r.id),
    institution: r.institution,
    degree: r.degree,
    field: r.field,
    start_date: toDateString(r.start_date) ?? '',
    end_date: toDateString(r.end_date),
    in_progress: r.in_progress === 1,
    gpa: r.gpa !== null && r.gpa !== undefined ? Number(r.gpa) : null,
  }));

  // Map experience rows
  const experience: ExportExperience[] = experienceRows.map((r) => ({
    id: Number(r.id),
    company: r.company,
    title: r.title,
    employment_type: r.employment_type,
    start_date: toDateString(r.start_date) ?? '',
    end_date: toDateString(r.end_date),
    is_current: r.is_current === 1,
    description: r.description,
  }));

  // Map skill rows
  const skills: ExportSkill[] = skillRows.map((r) => ({ label: r.label }));

  // Map CV file rows (metadata only — no storage_path)
  const cvFiles: ExportCvFile[] = cvFileRows.map((r) => ({
    id: Number(r.id),
    original_filename: r.original_filename,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    is_active: r.is_active === 1,
    uploaded_at: toIsoString(r.uploaded_at) ?? '',
  }));

  // Map application rows
  const applications: ExportApplication[] = applicationRows.map((r) => ({
    id: Number(r.id),
    uuid: r.uuid,
    reference_no: r.reference_no,
    job_id: Number(r.job_id),
    stage: r.stage,
    source: r.source,
    applied_at: toIsoString(r.applied_at) ?? '',
    updated_at: toIsoString(r.updated_at) ?? '',
    hired_at: toIsoString(r.hired_at),
  }));

  // Map bookmark rows
  const bookmarks: ExportBookmark[] = bookmarkRows.map((r) => ({
    job_id: Number(r.job_id),
    created_at: toIsoString(r.created_at) ?? '',
  }));

  // Map alert rows
  const alerts: ExportAlert[] = alertRows.map((r) => ({
    id: Number(r.id),
    keyword: r.keyword,
    locations: r.locations,
    departments: r.departments,
    frequency: r.frequency,
    last_evaluated_at: toIsoString(r.last_evaluated_at),
    created_at: toIsoString(r.created_at) ?? '',
  }));

  // Map consent record rows
  const consentRecords: ExportConsentRecord[] = consentRows.map((r) => ({
    id: Number(r.id),
    policy_version: r.policy_version,
    accepted_at: toIsoString(r.accepted_at) ?? '',
  }));

  return {
    exportedAt: new Date().toISOString(),
    profile,
    education,
    experience,
    skills,
    cvFiles,
    applications,
    bookmarks,
    alerts,
    consentRecords,
  };
}
