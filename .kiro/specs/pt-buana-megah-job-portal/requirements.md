# Requirements Document

## Introduction

PT Buana Megah Job Portal (selanjutnya disebut **The Portal**) adalah aplikasi web karir milik PT Buana Megah yang dijalankan di domain `buanamegahcareer.my.id` (subdomain `ptkbuanamegah.my.id`). Tujuannya adalah menggantikan situs karir lama dengan platform Applicant Tracking System (ATS) modern yang mempublikasikan lowongan kerja, menerima lamaran online, dan mengelola pipeline rekrutmen end-to-end (Applied → Screening → Interview → Offer → Hired/Rejected).

Kendala utama yang membentuk seluruh dokumen ini: The Portal harus berjalan di **shared hosting cPanel** dari penyedia HyperCloudHost. Ini berarti tidak ada akses root, tidak ada Docker, tidak ada daemon background yang persisten, tidak ada Redis/Elasticsearch, database hanya MySQL/MariaDB, file disimpan di disk lokal, dan pekerjaan terjadwal hanya melalui cron jobs cPanel. Stack yang sudah disiapkan di hosting adalah Node.js 22 (via Passenger/LSAPI dengan entry point `artifacts/api-server/dist/index.mjs`) dan MySQL (`mycdmkay_mycdmkay_ptk`).

Dokumen ini menjabarkan kebutuhan fungsional (publik, pelamar, HR, admin) dan non-fungsional (performa, keamanan, kepatuhan UU PDP, kompatibilitas shared hosting). Setiap requirement mengikuti pola EARS dan aturan kualitas INCOSE agar dapat diuji dan diimplementasikan tanpa ambiguitas.

## Glossary

- **The_Portal**: Aplikasi web Job Portal PT Buana Megah secara keseluruhan (frontend + backend + database).
- **Public_Site**: Bagian frontend yang dapat diakses tanpa login (landing, daftar lowongan, detail lowongan, halaman tentang perusahaan).
- **Applicant_Area**: Area frontend yang membutuhkan akun Applicant (profil, lamaran, notifikasi, job alert, bookmark).
- **Admin_Console**: Antarmuka backoffice untuk pengguna dengan role HR, Department_Head, atau Super_Admin.
- **API_Server**: Aplikasi Node.js 22 yang berjalan di Passenger dengan entry point `artifacts/api-server/dist/index.mjs` dan menyediakan REST/JSON API.
- **Database**: Instance MySQL/MariaDB yang disediakan cPanel (skema `mycdmkay_mycdmkay_ptk`). Satu-satunya datastore relasional The_Portal.
- **File_Store**: Direktori di disk shared hosting untuk menyimpan file terunggah (CV, foto profil, lampiran lowongan), berada di luar `public_html` agar tidak diakses langsung lewat HTTP.
- **Cron_Runner**: Skrip Node.js yang dipicu oleh cron job cPanel pada interval tertentu untuk menjalankan pekerjaan terjadwal (job alert digest, pembersihan file, pengiriman email tertunda, indeks ulang pencarian).
- **Mail_Sender**: Modul pengiriman email yang mengirim pesan transaksional dan digest melalui SMTP (cPanel mail atau SMTP relay eksternal seperti Brevo/SendGrid).
- **Applicant**: Pengguna terdaftar yang mencari kerja, dapat melamar lowongan dan mengelola profil.
- **HR**: Pengguna internal yang mengelola lowongan dan memproses lamaran masuk.
- **Department_Head**: Pengguna internal yang me-review kandidat untuk departemen tertentu.
- **Super_Admin**: Pengguna internal dengan akses penuh termasuk manajemen user, audit log, dan konfigurasi sistem.
- **Job_Posting**: Entitas lowongan kerja yang dipublikasikan, berisi judul, deskripsi, lokasi, departemen, level, tipe kerja, batas lamaran, dan status publikasi.
- **Application**: Entitas lamaran yang dikirim Applicant ke satu Job_Posting tertentu, memiliki status pipeline.
- **Pipeline_Stage**: Salah satu nilai dari himpunan {Applied, Screening, Interview, Offer, Hired, Rejected, Withdrawn}.
- **Job_Alert**: Konfigurasi langganan Applicant yang mengirim email daftar lowongan baru sesuai filter (kata kunci, lokasi, departemen) pada frekuensi harian atau mingguan.
- **CV_File**: Berkas resume Applicant dalam format PDF, DOC, atau DOCX.
- **Audit_Event**: Catatan tindakan penting (login, perubahan status lamaran, perubahan lowongan, ekspor data) yang disimpan untuk akuntabilitas.
- **Rate_Limiter**: Komponen yang membatasi jumlah permintaan per IP/akun pada endpoint sensitif untuk mencegah abuse.
- **CAPTCHA_Provider**: Layanan verifikasi manusia (mis. hCaptcha atau Cloudflare Turnstile) yang dipanggil pada form publik.
- **Search_Index**: Tabel MySQL dengan kolom FULLTEXT yang menyimpan teks lowongan untuk pencarian cepat tanpa Elasticsearch.
- **Consent_Record**: Catatan persetujuan Applicant terhadap pemrosesan data pribadi sesuai UU PDP, berisi versi kebijakan dan timestamp.
- **Backup_Archive**: File arsip terkompresi berisi dump SQL Database dan salinan File_Store yang dihasilkan secara terjadwal.

## Requirements

### Requirement 1: Hosting Compatibility (Shared cPanel)

**User Story:** As a System_Operator, I want The_Portal to run end-to-end on a shared cPanel hosting account without root access, so that I can deploy and maintain it without migrating infrastructure.

#### Acceptance Criteria

1. THE The_Portal SHALL run with Node.js version 22 as a Passenger/LSAPI application using `artifacts/api-server/dist/index.mjs` as the startup file.
2. THE The_Portal SHALL store all relational data in a single MySQL/MariaDB schema provisioned through cPanel.
3. THE The_Portal SHALL NOT require Redis, Elasticsearch, RabbitMQ, Kafka, or any additional service that cannot be installed on a shared cPanel account.
4. THE The_Portal SHALL NOT require root privileges, sudo, Docker, or systemd units for any runtime or scheduled task.
5. THE The_Portal SHALL execute all scheduled work through Cron_Runner scripts invoked by cPanel cron jobs, with each invocation completing within 60 seconds under normal load.
6. THE The_Portal SHALL keep the resident process memory of API_Server below 512 MB during normal operation.
7. THE The_Portal SHALL store File_Store outside `public_html` and serve uploaded files only through authenticated API_Server endpoints that enforce access control.
8. WHERE the hosting provider enforces an inode quota, THE The_Portal SHALL keep the total number of files in File_Store under 50,000 by archiving uploads older than 24 months into a single compressed archive per quarter.
9. WHEN the cPanel-provided environment variables `DATABASE_URL`, `SESSION_SECRET`, and `PORT` are set, THE API_Server SHALL read configuration from those variables and SHALL NOT require a separate `.env` file.

### Requirement 2: Public Site and SEO

**User Story:** As a Visitor, I want to browse company information and open job postings without logging in, so that I can decide whether to apply.

#### Acceptance Criteria

1. THE Public_Site SHALL render a landing page at `/` that displays company branding, a featured Job_Posting list, and a primary call-to-action linking to the full job list.
2. THE Public_Site SHALL render a company profile page at `/about` that displays company description, values, locations, and contact information.
3. THE Public_Site SHALL render a job list page at `/jobs` that displays every Job_Posting whose status is Published and whose application deadline is in the future or null.
4. THE Public_Site SHALL render a job detail page at `/jobs/:slug` for every Published Job_Posting, displaying title, department, location, employment type, level, description, requirements, responsibilities, posting date, and application deadline.
5. THE Public_Site SHALL emit a `JobPosting` JSON-LD structured data block conforming to schema.org on every job detail page so that the page is eligible for Google for Jobs indexing.
6. THE Public_Site SHALL serve a sitemap at `/sitemap.xml` that lists every Published Job_Posting URL with its `lastmod` timestamp.
7. THE Public_Site SHALL serve a `robots.txt` at `/robots.txt` that allows crawling of public pages and disallows `/admin`, `/api`, and `/applicant`.
8. WHEN a Visitor requests a job detail URL whose Job_Posting status is not Published, THE Public_Site SHALL respond with HTTP 404 and a page indicating the job is not available.
9. THE Public_Site SHALL render correctly on viewport widths from 320 px to 1920 px without horizontal scrolling on the main content area.
10. THE Public_Site SHALL achieve a Largest Contentful Paint of at most 2.5 seconds on the job list page when measured on a simulated 4G connection (1.6 Mbps, 150 ms RTT).

### Requirement 3: Applicant Registration and Authentication

**User Story:** As a Visitor, I want to create an account and sign in, so that I can apply to jobs and track my applications.

#### Acceptance Criteria

1. WHEN a Visitor submits the registration form with a unique email, a password of at least 10 characters containing letters and digits, and a checked Consent_Record checkbox, THE The_Portal SHALL create an Applicant account in pending-verification state and send a verification email containing a single-use token valid for 24 hours.
2. IF a Visitor submits the registration form with an email already associated with an existing account, THEN THE The_Portal SHALL respond with a generic message stating the registration could not be completed and SHALL NOT disclose that the email exists.
3. WHEN a Visitor opens a verification link with a valid unexpired token, THE The_Portal SHALL mark the Applicant account as verified and SHALL invalidate the token.
4. IF a Visitor opens a verification link with an expired or already-used token, THEN THE The_Portal SHALL display an error page and SHALL offer to resend the verification email.
5. WHEN an Applicant submits the login form with correct credentials and a verified account, THE The_Portal SHALL establish an authenticated session backed by an HTTP-only, Secure, SameSite=Lax cookie with an idle timeout of 30 minutes and an absolute timeout of 12 hours.
6. IF an Applicant submits the login form with incorrect credentials, THEN THE The_Portal SHALL respond with a generic error message and SHALL increment a failure counter for the submitted email.
7. WHILE the failure counter for an email exceeds 5 within 15 minutes, THE The_Portal SHALL reject further login attempts for that email with HTTP 429 and SHALL display a wait-and-retry message.
8. WHEN an Applicant requests a password reset for an existing account, THE The_Portal SHALL send a single-use reset token valid for 60 minutes via Mail_Sender.
9. WHERE password reset is requested for a non-existent email, THE The_Portal SHALL display the same confirmation message as for an existing email and SHALL NOT send any email.
10. THE The_Portal SHALL hash all passwords using bcrypt with a work factor of at least 12 before storing them in Database.

### Requirement 4: Applicant Profile

**User Story:** As an Applicant, I want to maintain a complete profile with my personal data, education, experience, skills, and CV, so that I can apply to jobs without re-entering information each time.

#### Acceptance Criteria

1. THE Applicant_Area SHALL allow an authenticated Applicant to create and update a profile containing full name, date of birth, gender, phone number, address, city, province, country, and a short summary.
2. THE Applicant_Area SHALL allow an Applicant to add, edit, and remove education entries, where each entry contains institution name, degree, field of study, start date, end date or "in progress" flag, and GPA.
3. THE Applicant_Area SHALL allow an Applicant to add, edit, and remove work experience entries, where each entry contains company name, title, employment type, start date, end date or "current" flag, and description of responsibilities.
4. THE Applicant_Area SHALL allow an Applicant to add and remove skill tags from a controlled list maintained by HR.
5. WHEN an Applicant uploads a CV_File of type PDF, DOC, or DOCX with a size of at most 5 MB, THE The_Portal SHALL store the file in File_Store with a server-generated filename and SHALL associate it with the Applicant profile as the active CV.
6. IF an Applicant uploads a file whose declared MIME type is not in {application/pdf, application/msword, application/vnd.openxmlformats-officedocument.wordprocessingml.document}, THEN THE The_Portal SHALL reject the upload with HTTP 415 and SHALL NOT persist the file.
7. IF an Applicant uploads a file larger than 5 MB, THEN THE The_Portal SHALL reject the upload with HTTP 413 and SHALL NOT persist the file.
8. THE The_Portal SHALL retain at most 3 historical CV_File versions per Applicant and SHALL delete older versions automatically when a new CV is uploaded.
9. THE Applicant_Area SHALL display a profile completeness percentage computed as the fraction of mandatory profile fields that are non-empty.
10. WHILE profile completeness is below 80 percent, THE Applicant_Area SHALL display a banner prompting the Applicant to complete the profile.

### Requirement 5: Applying to Jobs

**User Story:** As an Applicant, I want to apply to a job posting in a single click after my profile is complete, so that I can submit applications quickly.

#### Acceptance Criteria

1. WHEN an authenticated Applicant with profile completeness of at least 80 percent and an active CV_File clicks the Apply button on a Published Job_Posting whose deadline has not passed, THE The_Portal SHALL create an Application record with stage Applied and SHALL link the active CV_File version at submission time.
2. IF an Applicant attempts to apply with profile completeness below 80 percent or without an active CV_File, THEN THE The_Portal SHALL block the submission and SHALL display a message identifying the missing fields.
3. IF an Applicant attempts to apply to the same Job_Posting more than once, THEN THE The_Portal SHALL reject the duplicate submission and SHALL display a message stating the application already exists.
4. IF an Applicant attempts to apply to a Job_Posting whose status is not Published or whose deadline has passed, THEN THE The_Portal SHALL reject the submission with an explanatory message.
5. WHEN an Application is created, THE The_Portal SHALL send a confirmation email to the Applicant containing the Job_Posting title, application reference number, and a link to the application detail page.
6. THE Applicant_Area SHALL display a list of the Applicant's Applications sorted by submission date descending, showing job title, company location, current stage, and last update timestamp.
7. WHEN an Applicant opens an application detail page, THE Applicant_Area SHALL display the full pipeline timeline including stage changes, timestamps, and any HR notes flagged as visible to the Applicant.
8. WHEN an Applicant clicks Withdraw on an Application whose stage is not Hired or Rejected, THE The_Portal SHALL transition the Application to stage Withdrawn and SHALL record the timestamp and actor.

### Requirement 6: Job Search, Filter, and Bookmark

**User Story:** As a Visitor or Applicant, I want to search and filter open jobs and save interesting ones, so that I can find relevant opportunities efficiently.

#### Acceptance Criteria

1. THE Public_Site SHALL provide a keyword search field on the job list page that matches the keyword against Job_Posting title, description, and skill tags using the Search_Index FULLTEXT index.
2. THE Public_Site SHALL provide filters for location, department, employment type, and level, where selecting multiple values within one filter applies an OR within the filter and an AND across filters.
3. THE Public_Site SHALL paginate the job list at 20 results per page and SHALL respond to a search request with first-page results within 500 ms at the 95th percentile when Database contains up to 5,000 Published Job_Postings.
4. WHEN an authenticated Applicant clicks the bookmark icon on a Job_Posting, THE The_Portal SHALL toggle a bookmark association between the Applicant and the Job_Posting.
5. THE Applicant_Area SHALL provide a bookmarks page that lists every Job_Posting currently bookmarked by the Applicant.
6. WHEN a Job_Posting is unpublished or expires, THE Applicant_Area SHALL continue to show existing bookmarks but SHALL display the bookmarked Job_Posting as inactive and SHALL disable the Apply button.

### Requirement 7: Job Alerts (Cron-Based Email Digest)

**User Story:** As an Applicant, I want to receive email alerts for new jobs that match my interests, so that I do not miss relevant openings.

#### Acceptance Criteria

1. THE Applicant_Area SHALL allow an Applicant to create, edit, and delete Job_Alert entries, where each entry contains optional keyword, optional location list, optional department list, and a frequency value of Daily or Weekly.
2. WHILE a Job_Alert exists, Cron_Runner SHALL evaluate the Job_Alert at the configured frequency and SHALL include only Job_Postings published since the previous evaluation timestamp recorded for that Job_Alert.
3. WHEN Cron_Runner finds at least one matching Job_Posting for a Job_Alert evaluation, THE Mail_Sender SHALL send an email digest to the Applicant containing job titles, locations, and links to the job detail pages.
4. WHEN a Job_Alert evaluation finds no matching Job_Postings, THE Mail_Sender SHALL NOT send an email for that evaluation.
5. THE Cron_Runner SHALL update the previous evaluation timestamp of each Job_Alert after processing, regardless of whether an email was sent.
6. IF Cron_Runner cannot send an email due to a Mail_Sender error, THEN THE Cron_Runner SHALL retain the previous evaluation timestamp unchanged and SHALL log the error for later retry.

### Requirement 8: Application Status Notifications

**User Story:** As an Applicant, I want to be notified by email when my application status changes, so that I stay informed without having to log in.

#### Acceptance Criteria

1. WHEN an Application transitions to a new Pipeline_Stage other than Applied, THE The_Portal SHALL enqueue a status-change email to the Applicant containing the Job_Posting title, the new stage, and a link to the application detail page.
2. WHEN HR adds a note flagged as visible to the Applicant on an Application, THE The_Portal SHALL enqueue a notification email to the Applicant containing a non-truncated quoted excerpt of the note.
3. THE The_Portal SHALL enqueue notification emails into a `mail_outbox` table in Database and SHALL deliver them through Cron_Runner invocations rather than blocking the request that triggered them.
4. WHEN Cron_Runner processes the `mail_outbox`, THE Cron_Runner SHALL send each pending email through Mail_Sender and SHALL mark it as sent after successful delivery.
5. IF Mail_Sender fails to deliver a queued email, THEN THE Cron_Runner SHALL increment a retry counter and SHALL retry on subsequent invocations until 5 attempts have failed, after which THE Cron_Runner SHALL mark the email as failed and SHALL record the failure reason.

### Requirement 9: HR Job Posting Management

**User Story:** As HR, I want to create, edit, publish, and unpublish job postings, so that I can manage what candidates can apply to.

#### Acceptance Criteria

1. THE Admin_Console SHALL allow HR to create a Job_Posting with fields title, slug, department, location, employment type, level, description, requirements, responsibilities, salary range (optional), application deadline (optional), and status with allowed values {Draft, Published, Closed, Archived}.
2. WHEN HR saves a new Job_Posting with status Draft, THE The_Portal SHALL persist the Job_Posting and SHALL NOT make it visible on the Public_Site.
3. WHEN HR transitions a Job_Posting from Draft to Published, THE The_Portal SHALL set the published-at timestamp, SHALL make the Job_Posting visible on the Public_Site, and SHALL refresh its row in the Search_Index.
4. WHEN HR transitions a Job_Posting to Closed or Archived, THE The_Portal SHALL remove the Job_Posting from the Public_Site and SHALL retain existing Applications linked to it.
5. THE Admin_Console SHALL allow HR to clone an existing Job_Posting into a new Draft prefilled with the source values except slug, status, and published-at.
6. WHEN HR edits the description, requirements, or responsibilities of a Published Job_Posting, THE The_Portal SHALL refresh the corresponding Search_Index row within the same request.
7. THE Admin_Console SHALL allow HR to set or change the slug, and IF a submitted slug duplicates an existing slug, THEN THE The_Portal SHALL reject the change with a validation error.

### Requirement 10: Recruitment Pipeline (Kanban)

**User Story:** As HR, I want to view and move applications through pipeline stages on a kanban board, so that I can manage the recruitment process efficiently.

#### Acceptance Criteria

1. THE Admin_Console SHALL render a kanban board per Job_Posting with one column per Pipeline_Stage in the order Applied, Screening, Interview, Offer, Hired, Rejected.
2. WHEN HR drags an Application card from one column to another or selects a new stage from a card menu, THE The_Portal SHALL transition the Application to the target Pipeline_Stage, SHALL append a stage-change Audit_Event, and SHALL trigger Requirement 8 Acceptance Criterion 1.
3. THE Admin_Console SHALL allow HR to add a note to an Application with a flag indicating whether the note is visible to the Applicant.
4. THE Admin_Console SHALL allow HR to schedule an interview on an Application by entering a scheduled datetime, location or meeting URL, and an interviewer assignment, and SHALL send an interview invitation email to the Applicant.
5. THE Admin_Console SHALL allow HR to perform bulk stage transitions on a multi-select of Applications within one Job_Posting.
6. WHEN HR performs a bulk stage transition, THE The_Portal SHALL apply the transition transactionally per Application and SHALL report which Applications succeeded and which failed without aborting the entire batch.
7. THE Admin_Console SHALL allow HR to send a templated email to one or more Applicants from a list of HR-managed Mail_Sender templates supporting placeholders for applicant name, job title, and stage.

### Requirement 11: Role-Based Access Control

**User Story:** As Super_Admin, I want different internal users to have different permissions, so that access is limited to what each role needs.

#### Acceptance Criteria

1. THE The_Portal SHALL define four roles: Super_Admin, HR, Department_Head, and Applicant.
2. THE The_Portal SHALL grant Super_Admin full access to every Admin_Console feature including user management, audit log, system configuration, and backup operations.
3. THE The_Portal SHALL grant HR access to manage Job_Postings, Applications, mail templates, and Job_Alerts, but SHALL NOT grant access to user management or system configuration.
4. THE The_Portal SHALL grant Department_Head read-only access to Job_Postings and Applications belonging to assigned departments and SHALL allow adding notes and recommending stage changes.
5. THE The_Portal SHALL grant Applicant access only to the Applicant_Area scoped to the authenticated Applicant's own data.
6. IF a user attempts to access an endpoint or page outside the user's role permissions, THEN THE The_Portal SHALL respond with HTTP 403 and SHALL record an Audit_Event of type AccessDenied.
7. THE Admin_Console SHALL allow Super_Admin to invite a new internal user by email, where the invitation creates a pending account and sends an invitation email containing a single-use token valid for 7 days.

### Requirement 12: Audit Log

**User Story:** As Super_Admin, I want a record of important actions, so that I can investigate incidents and demonstrate accountability.

#### Acceptance Criteria

1. THE The_Portal SHALL record an Audit_Event for each of the following actions: user login success, user login failure, password reset request, password change, role assignment change, Job_Posting create, Job_Posting publish, Job_Posting unpublish, Application stage transition, Application data export, mail template change, and configuration change.
2. THE The_Portal SHALL store each Audit_Event with timestamp, actor user identifier, actor IP address, action type, target entity type, target entity identifier, and a JSON details payload.
3. THE Admin_Console SHALL allow Super_Admin to filter Audit_Events by date range, actor, action type, and target entity.
4. THE The_Portal SHALL retain Audit_Events for at least 24 months before allowing automated archival.
5. WHILE the audit log table exceeds 5,000,000 rows, Cron_Runner SHALL move rows older than 24 months into a monthly archive file in File_Store.

### Requirement 13: Reporting and Analytics

**User Story:** As HR, I want to see basic recruitment metrics, so that I can evaluate hiring performance.

#### Acceptance Criteria

1. THE Admin_Console SHALL display a dashboard showing total active Job_Postings, total Applications received in the selected date range, conversion rate from Applied to Interview, and conversion rate from Interview to Hired.
2. THE Admin_Console SHALL display per Job_Posting the count of Applications by Pipeline_Stage and the average time-to-hire computed as the mean number of days between Application creation and transition to stage Hired across hired Applications.
3. THE Admin_Console SHALL display the source distribution of Applications grouped by referral channel (direct, search engine, job alert email, social).
4. THE Admin_Console SHALL allow HR to export the Applications list of a Job_Posting as a CSV file containing applicant name, email, phone, current stage, applied-at timestamp, and CV download URL.
5. WHEN HR triggers an export, THE The_Portal SHALL record an Audit_Event of type DataExport including the count of rows exported.

### Requirement 14: Anti-Spam and Rate Limiting

**User Story:** As System_Operator, I want to prevent abuse on public forms, so that the application is not flooded with spam or brute-force attempts.

#### Acceptance Criteria

1. THE The_Portal SHALL require a successful CAPTCHA_Provider challenge on the registration form, the password reset form, and the unauthenticated contact form.
2. THE Rate_Limiter SHALL limit the registration endpoint to 5 successful submissions per IP address per hour.
3. THE Rate_Limiter SHALL limit the login endpoint to 20 attempts per IP address per 15 minutes.
4. THE Rate_Limiter SHALL limit the application submission endpoint to 30 submissions per Applicant account per 24 hours.
5. WHEN any Rate_Limiter threshold is exceeded, THE The_Portal SHALL respond with HTTP 429 including a `Retry-After` header.

### Requirement 15: Security Controls

**User Story:** As System_Operator, I want the application to follow standard web security practices, so that user data and the system are protected.

#### Acceptance Criteria

1. THE The_Portal SHALL set the response headers `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Frame-Options: DENY` on every HTML response.
2. THE The_Portal SHALL include a CSRF token in every state-changing form rendered to authenticated users and SHALL reject submissions whose token does not match the session.
3. THE The_Portal SHALL escape every user-supplied string in HTML output using the templating engine's default escaping and SHALL never use raw HTML insertion for untrusted input.
4. THE The_Portal SHALL parameterize every SQL statement using prepared statements and SHALL NOT concatenate user input into SQL strings.
5. WHEN a CV_File is uploaded, THE The_Portal SHALL verify the file's magic bytes against the declared MIME type before persisting and SHALL reject the upload on mismatch.
6. THE The_Portal SHALL serve CV_File downloads with `Content-Disposition: attachment` and SHALL set `X-Content-Type-Options: nosniff`.
7. THE The_Portal SHALL store SESSION_SECRET, SMTP credentials, and DATABASE_URL only in cPanel environment variables or Passenger environment configuration and SHALL NOT commit them to version control.

### Requirement 16: Data Privacy and UU PDP Compliance

**User Story:** As an Applicant, I want control over my personal data in line with Indonesian Personal Data Protection Law (UU PDP), so that my privacy rights are respected.

#### Acceptance Criteria

1. WHEN an Applicant registers, THE The_Portal SHALL require an explicit checkbox consent to a privacy policy and SHALL store a Consent_Record containing the policy version, timestamp, and Applicant identifier.
2. THE Applicant_Area SHALL allow an Applicant to download a machine-readable export (JSON) of all personal data held about the Applicant, including profile, applications, bookmarks, job alerts, and consent records.
3. WHEN an Applicant requests account deletion, THE The_Portal SHALL within 30 days delete or anonymize personal data fields (name, date of birth, phone, address, email, CV_File contents) while retaining minimum records required to demonstrate prior consent and to satisfy Application audit requirements.
4. WHEN HR exports an Applicant's data, THE The_Portal SHALL record an Audit_Event of type DataExport linking actor, target Applicant, and timestamp.
5. THE The_Portal SHALL display a privacy policy link in the global footer and on every form that collects personal data.
6. WHERE the privacy policy version changes, THE The_Portal SHALL prompt every Applicant on next login to review and accept the new version before continuing to use Applicant_Area features.

### Requirement 17: Internationalization (Indonesian and English)

**User Story:** As a Visitor, I want to use the portal in Bahasa Indonesia or English, so that I can read content in my preferred language.

#### Acceptance Criteria

1. THE The_Portal SHALL support two interface languages: Bahasa Indonesia (id) and English (en).
2. THE The_Portal SHALL detect a Visitor's preferred language from the URL prefix `/id` or `/en` first, then from a stored preference cookie, and finally from the `Accept-Language` request header, defaulting to id if none indicate a supported language.
3. THE The_Portal SHALL render every UI string through a translation lookup keyed by message identifier and SHALL fall back to the id translation when an en translation is missing.
4. WHERE a Job_Posting has both Indonesian and English content fields populated, THE Public_Site SHALL render the content in the active language; OTHERWISE THE Public_Site SHALL render whichever language version is available.
5. THE Applicant_Area SHALL allow an Applicant to set a language preference that persists across sessions for that Applicant.

### Requirement 18: Backup and Data Export

**User Story:** As System_Operator, I want regular backups of the database and uploaded files, so that I can recover from data loss.

#### Acceptance Criteria

1. WHILE The_Portal is in production, Cron_Runner SHALL produce a Backup_Archive once per day containing a `mysqldump` of Database and a tar.gz of File_Store excluding files older than 12 months.
2. THE Cron_Runner SHALL store the latest 14 daily Backup_Archives and the latest 12 monthly Backup_Archives in a backup directory inside the home directory and outside `public_html`.
3. WHEN a Backup_Archive is created, THE Cron_Runner SHALL verify the archive's integrity by listing its table-of-contents and SHALL log the verification result.
4. THE Admin_Console SHALL allow Super_Admin to download the most recent Backup_Archive on demand through an authenticated endpoint.
5. IF a Backup_Archive cannot be created due to disk-quota or `mysqldump` error, THEN THE Cron_Runner SHALL send an alert email to a Super_Admin-configured address and SHALL record the failure in the audit log.

### Requirement 19: Database Schema Migrations

**User Story:** As System_Operator, I want database schema changes to be versioned and reproducible on shared hosting, so that deployments do not require manual SQL editing.

#### Acceptance Criteria

1. THE The_Portal SHALL ship a migration tool that runs as a CLI command invoked through the Node.js binary at `/home/mycdmkay/nodevenv/ptk-app/22/bin/node`.
2. THE migration tool SHALL apply pending migrations against the Database in a single transaction per migration file and SHALL record each applied migration's identifier and checksum in a `schema_migrations` table.
3. IF a migration fails, THEN THE migration tool SHALL roll back the failing migration's transaction and SHALL exit with a non-zero status code without applying subsequent migrations.
4. WHEN deployment occurs, THE deployment process SHALL invoke the migration tool before restarting the Passenger application.
5. THE migration tool SHALL be runnable directly from cPanel Terminal with no service or daemon dependency.

### Requirement 20: Observability on Shared Hosting

**User Story:** As System_Operator, I want to diagnose issues using only what cPanel provides, so that I do not depend on external observability services.

#### Acceptance Criteria

1. THE API_Server SHALL emit structured JSON logs to standard output, which Passenger SHALL capture into the cPanel-managed Passenger log file.
2. THE API_Server SHALL include a request identifier, route, status code, latency in milliseconds, user identifier when authenticated, and IP address in every access log entry.
3. THE API_Server SHALL expose an unauthenticated `GET /healthz` endpoint that returns HTTP 200 with a JSON body when Database is reachable and HTTP 503 otherwise.
4. THE API_Server SHALL expose an authenticated `GET /admin/diagnostics` endpoint accessible only to Super_Admin that returns process uptime, Node.js version, memory usage, pending `mail_outbox` count, last Cron_Runner run timestamp per job, and last Backup_Archive timestamp.
5. WHEN an unhandled exception occurs in API_Server, THE API_Server SHALL log the error with stack trace at level error and SHALL respond with HTTP 500 and a generic error page that does not disclose stack traces to the client.
