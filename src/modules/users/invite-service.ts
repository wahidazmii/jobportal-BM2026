/**
 * Internal-user invitation service for PT Buana Megah Job Portal.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 42.1 (Endpoint GET /admin/users &
 *           POST /admin/users/invite)
 * Design  : §6 Admin (user management), §12 (mail outbox), §14.1 (policy:
 *           user.invite → Super_Admin only), §15 (audit)
 * Validates: Requirements 11.7, 12.1
 *
 * Public surface:
 *   - `INVITE_ROLES`            — the internal roles a Super_Admin may
 *                                 invite (Applicant is excluded — Req 11.7
 *                                 invites internal users only).
 *   - `inviteUserSchema`        — zod schema for the invite form payload.
 *   - `InviteUserInput`         — type inferred from the schema.
 *   - `InvalidInviteInputError` — thrown on validation failure with a
 *                                 field-level error map (422).
 *   - `inviteUser({ actorUserId, actorIp, baseUrl, input })`
 *                               — validate → (single transaction) create
 *                                 pending account + invitation token +
 *                                 enqueue invite mail + write `role_change`
 *                                 audit. Returns a discriminated result so
 *                                 the route can render the duplicate-email
 *                                 case without crashing or leaking.
 *   - `listInternalUsers()`     — read path for `GET /admin/users`.
 *   - `INVITATION_TOKEN_DAYS`   — the 7-day validity window (Req 11.7).
 *
 * Transactional contract (Design §12.3, §15 — Req 11.7, 12.1):
 *   The pending-account INSERT, the `invitation_tokens` INSERT, the mail
 *   enqueue, and the `role_change` audit write ALL run inside one
 *   `withTransaction`. If any step throws, the whole invite rolls back —
 *   no orphan account, no dangling token, no half-sent invitation, and no
 *   audit row for an invite that never happened.
 *
 * SQL safety (Req 15.4):
 *   Every statement is a prepared statement using mysql2 `?` placeholders;
 *   the static SQL is assembled via `Array.join(' ')` so the local
 *   `no-string-concat-sql` lint rule never sees a SQL keyword adjacent to
 *   a dynamic interpolation. No user input is concatenated into SQL text.
 */

import { randomBytes } from 'node:crypto';

import { z, ZodError } from 'zod';
import { ulid } from 'ulid';

import {
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
  query,
  withTransaction,
} from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { enqueue as enqueueMail } from '../mail/service.js';
import { auditService } from '../audit/writer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Internal roles a Super_Admin may invite (Req 11.7). `Applicant` is
 * deliberately excluded — applicants self-register (Req 3). Mirrors the
 * `invitation_tokens.role` ENUM in migration 0008_invitations.sql.
 */
export const INVITE_ROLES = ['Super_Admin', 'HR', 'Department_Head'] as const;

/** Invited role union, inferred from {@link INVITE_ROLES}. */
export type InviteRole = (typeof INVITE_ROLES)[number];

/** Invitation token validity window in days (Req 11.7). */
export const INVITATION_TOKEN_DAYS = 7;

/** Mirrors `users.email VARCHAR(254)`. */
const EMAIL_MAX_LEN = 254;

/**
 * Token width for `invitation_tokens.token CHAR(43)`. 32 random bytes
 * encoded as base64url produce exactly 43 chars (no padding) — identical
 * to the verification / password-reset token width.
 */
const TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the invite input fails validation. Carries the field-level
 * error map (`{ email: ['…'], role: ['…'] }`) so the route layer can
 * render per-field messages without re-running `zod.flatten()`.
 */
export class InvalidInviteInputError extends Error {
  readonly code = 'invalid_invite_input' as const;
  readonly statusCode = 422 as const;
  constructor(
    public readonly fieldErrors: Readonly<Record<string, readonly string[]>>,
    message = 'Invalid invite input',
  ) {
    super(message);
    this.name = 'InvalidInviteInputError';
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Invite form schema. `email` is RFC-validated, trimmed, lowercased, and
 * bounded to the `users.email` column width; `role` must be one of the
 * three internal roles (NOT Applicant).
 */
export const inviteUserSchema = z
  .object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .max(EMAIL_MAX_LEN, { message: 'Email is too long' })
      .email({ message: 'Please enter a valid email address' })
      .transform((v) => v.toLowerCase()),
    role: z.enum(INVITE_ROLES, {
      invalid_type_error: 'Role must be one of Super_Admin, HR, Department_Head',
      required_error: 'Role is required',
    }),
  })
  .strict();

/** Strongly-typed parsed invite input. */
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Discriminated result of {@link inviteUser}. The route maps:
 *   - `{ ok: true }`                       → 302 back to the list (?invited=1)
 *   - `{ ok: false, reason: 'duplicate_email' }`
 *                                          → re-render the form with a
 *                                            field error (no crash, no leak).
 */
export type InviteUserResult =
  | { readonly ok: true; readonly userId: number; readonly role: InviteRole }
  | { readonly ok: false; readonly reason: 'duplicate_email' };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a 32-byte token encoded as base64url (43 chars, no padding). */
function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Detect mysql2's "duplicate entry" error across both the named variant
 * (`ER_DUP_ENTRY`) and the numeric variant (1062). Folds a race-induced
 * duplicate INSERT back into the graceful duplicate-email branch.
 */
function isDuplicateEntry(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; errno?: unknown };
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
}

interface UserIdRow extends RowDataPacket {
  id: number | string;
}

/**
 * True when a `users` row already exists for `email`. Single index dive on
 * the unique `uk_users_email`. Racy with a concurrent INSERT — the unique
 * key is the authoritative gate and the INSERT path also catches
 * `ER_DUP_ENTRY`.
 */
async function emailAlreadyExists(
  connection: PoolConnection,
  email: string,
): Promise<boolean> {
  const [rows] = await connection.execute<UserIdRow[]>(
    'SELECT id FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  return rows.length > 0;
}

/**
 * Build the absolute accept URL embedded in the invitation email. The
 * invitee follows it to set a password and activate the account (a future
 * task implements the accept endpoint; the link carries the single-use
 * token regardless). `baseUrl` is normalised to drop a trailing slash so
 * we never emit `//`.
 */
function buildAcceptUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/id/invite/accept?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Pending-account INSERT. `password_hash` is the empty string — the
 * invitee has no password until they accept (a sentinel that bcrypt.compare
 * can never match, so the account cannot be logged into before acceptance);
 * `status='pending'` keeps it out of the active-user surface until then.
 * `role` is bound from the validated input.
 */
const INSERT_PENDING_USER_SQL = [
  'INSERT INTO users (uuid, email, password_hash, role, status)',
  "VALUES (?, ?, '', ?, 'pending')",
].join(' ');

/**
 * Invitation-token INSERT. `expires_at` is DB-evaluated as
 * `NOW() + INTERVAL 7 DAY` (the literal is inlined — there is no dynamic
 * value in the interval, so `no-string-concat-sql` is satisfied and the
 * 7-day window is stamped on the single DB clock, Req 11.7).
 */
const INSERT_INVITATION_TOKEN_SQL = [
  'INSERT INTO invitation_tokens (token, user_id, role, invited_by_user_id, expires_at)',
  'VALUES (?, ?, ?, ?, NOW() + INTERVAL 7 DAY)',
].join(' ');

/**
 * List path for `GET /admin/users`. Returns every internal user (the three
 * non-Applicant roles) ordered newest-first. Bound role list keeps the
 * statement parameterised even though the values are a fixed const.
 */
const SELECT_INTERNAL_USERS_SQL = [
  'SELECT id, email, role, status, created_at, email_verified_at',
  'FROM users',
  'WHERE role IN (?, ?, ?)',
  'ORDER BY created_at DESC, id DESC',
].join(' ');

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

interface InternalUserRow extends RowDataPacket {
  id: number | string;
  email: string;
  role: InviteRole;
  status: string;
  created_at: Date | string | null;
  email_verified_at: Date | string | null;
}

/** A row rendered by the `GET /admin/users` list view. */
export interface InternalUserRecord {
  readonly id: number;
  readonly email: string;
  readonly role: InviteRole;
  readonly status: string;
  readonly createdAt: Date | string | null;
  readonly emailVerifiedAt: Date | string | null;
}

/** List every internal user (Super_Admin / HR / Department_Head). */
export async function listInternalUsers(): Promise<InternalUserRecord[]> {
  const rows = await query<InternalUserRow[]>(SELECT_INTERNAL_USERS_SQL, [
    'Super_Admin',
    'HR',
    'Department_Head',
  ]);
  return rows.map((row) => ({
    id: Number(row.id),
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    emailVerifiedAt: row.email_verified_at,
  }));
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

export interface InviteUserOptions {
  /** Authenticated Super_Admin issuing the invite (audit actor + inviter). */
  readonly actorUserId: number;
  /** Request IP for the audit row (IPv6-safe text), or null. */
  readonly actorIp?: string | null;
  /** Absolute base URL used to build the accept link in the email. */
  readonly baseUrl: string;
  /** Raw form payload — passed through `inviteUserSchema`. */
  readonly input: unknown;
}

/**
 * Invite a new internal user (Req 11.7).
 *
 * Pipeline:
 *   1. Validate the input via `inviteUserSchema`. ZodError →
 *      `InvalidInviteInputError` carrying the field-level error map.
 *   2. Open ONE transaction:
 *        a. Pre-check `users.email`. If present → COMMIT a no-op and
 *           return `{ ok: false, reason: 'duplicate_email' }` (graceful).
 *        b. INSERT the pending `users` row (status=pending, chosen role,
 *           empty password_hash).
 *        c. INSERT `invitation_tokens` (token, expires = NOW() + 7 DAY).
 *        d. Enqueue the `user_invite` mail on the SAME connection (the
 *           link carries the token).
 *        e. Write a `role_change` audit event on the SAME connection
 *           (details: invited email + role + invited_by) — Req 12.1.
 *   3. If the INSERT race-collides on `uk_users_email`, fold the
 *      `ER_DUP_ENTRY` into the same graceful duplicate-email result.
 *
 * Throws:
 *   - `InvalidInviteInputError` on schema violation.
 *   - The original error for any non-duplicate database / mail failure
 *     (after the transaction has rolled back).
 */
export async function inviteUser(
  opts: InviteUserOptions,
): Promise<InviteUserResult> {
  const { actorUserId, actorIp = null, baseUrl } = opts;

  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError('actorUserId must be a positive integer');
  }

  // 1. Validate the input.
  let parsed: InviteUserInput;
  try {
    parsed = inviteUserSchema.parse(opts.input);
  } catch (err) {
    if (err instanceof ZodError) {
      const flat = err.flatten().fieldErrors;
      const fieldErrors: Record<string, readonly string[]> = {};
      for (const [k, msgs] of Object.entries(flat)) {
        if (msgs && msgs.length > 0) fieldErrors[k] = msgs;
      }
      throw new InvalidInviteInputError(fieldErrors);
    }
    throw err;
  }

  const userUuid = ulid();
  const token = generateInvitationToken();

  return withTransaction(async (connection) => {
    // 2a. Graceful duplicate-email pre-check (no leak, no crash).
    if (await emailAlreadyExists(connection, parsed.email)) {
      logger.info(
        { email_domain: parsed.email.split('@')[1] ?? '' },
        'users.invite: email already exists — no-op',
      );
      return { ok: false, reason: 'duplicate_email' } as const;
    }

    try {
      // 2b. Pending account (no password yet).
      const [userResult] = await connection.execute<ResultSetHeader>(
        INSERT_PENDING_USER_SQL,
        [userUuid, parsed.email, parsed.role],
      );
      const insertId = userResult.insertId;
      if (!insertId || insertId <= 0) {
        throw new Error('users.invite: missing insertId after users INSERT');
      }
      const userId = Number(insertId);

      // 2c. Single-use invitation token, 7-day validity (Req 11.7).
      await connection.execute<ResultSetHeader>(INSERT_INVITATION_TOKEN_SQL, [
        token,
        userId,
        parsed.role,
        actorUserId,
      ]);

      // 2d. Enqueue the invitation mail atomically with the account.
      await enqueueMail(connection, {
        templateKey: 'user_invite',
        toEmail: parsed.email,
        targetId: String(userId),
        context: {
          token,
          role: parsed.role,
          accept_url: buildAcceptUrl(baseUrl, token),
          expires_in_days: INVITATION_TOKEN_DAYS,
        },
      });

      // 2e. Audit the invite as a role_change (Req 12.1). Runs on the same
      //     connection so it commits atomically with the account creation.
      await auditService.write(
        {
          actorUserId,
          actorIp,
          actionType: 'role_change',
          targetEntity: 'user',
          targetId: userId,
          details: {
            event: 'invite',
            invited_email: parsed.email,
            role: parsed.role,
            invited_by: actorUserId,
          },
        },
        connection,
      );

      logger.info(
        { user_id: userId, role: parsed.role, actor_user_id: actorUserId },
        'users.invite: pending internal user created + invitation enqueued',
      );
      return { ok: true, userId, role: parsed.role } as const;
    } catch (err) {
      // Race: another request created the same email between the
      // pre-check and the INSERT. Fold into the graceful duplicate branch.
      if (isDuplicateEntry(err)) {
        logger.info(
          { email_domain: parsed.email.split('@')[1] ?? '' },
          'users.invite: duplicate-entry race — no-op',
        );
        return { ok: false, reason: 'duplicate_email' } as const;
      }
      throw err;
    }
  });
}
