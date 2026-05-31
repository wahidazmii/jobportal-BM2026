/**
 * Static structural tests for `migrations/0001_init.sql`.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 5.3, design.md §7.2, §8.6
 * Validates: Requirements 1.2, 3.5, 14.2, 14.3, 14.4
 *
 * These tests parse the raw SQL bytes — they do NOT connect to MySQL — so
 * they run in the unit suite and protect the schema from accidental
 * regressions (e.g. an index being renamed away, a CHARSET silently
 * downgraded, an FK on `applicants` being dropped). Integration coverage
 * with a live MySQL instance is provided separately by the migration
 * runner test suite.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(
  __dirname,
  '..',
  '..',
  'migrations',
  '0001_init.sql',
);
const SQL = readFileSync(MIGRATION_PATH, 'utf8');

/**
 * Pull the body of a single `CREATE TABLE [IF NOT EXISTS] <name> ( ... ) ENGINE=...`
 * statement. We anchor on the trailing `ENGINE=` so multi-line definitions
 * parse cleanly without us having to track parenthesis depth.
 */
function tableBlock(name: string): string {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${name}\`?\\s*\\(([\\s\\S]*?)\\)\\s*ENGINE\\s*=\\s*InnoDB[^;]*;`,
    'i',
  );
  const match = re.exec(SQL);
  if (!match) {
    throw new Error(`CREATE TABLE for "${name}" not found in 0001_init.sql`);
  }
  return match[0];
}

describe('migrations/0001_init.sql — task 5.3', () => {
  describe('required tables (§7.2)', () => {
    const required = [
      'users',
      'applicants',
      'sessions',
      'schema_migrations',
      'login_attempts',
      'rate_limits',
      'cron_locks',
    ];

    it.each(required)('declares table `%s` with InnoDB engine', (name) => {
      expect(() => tableBlock(name)).not.toThrow();
    });

    it('does NOT declare a separate `csrf_tokens` table (design §8.6 stores csrf inline on sessions)', () => {
      expect(SQL).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?csrf_tokens`?/i);
      // Sanity: csrf_token is the inline column on sessions instead.
      expect(tableBlock('sessions')).toMatch(/csrf_token\s+CHAR\(43\)\s+NOT\s+NULL/i);
    });
  });

  describe('charset and engine', () => {
    it('uses utf8mb4_0900_ai_ci on every CREATE TABLE statement', () => {
      const matches = [
        ...SQL.matchAll(/CREATE\s+TABLE[\s\S]*?ENGINE\s*=\s*InnoDB[^;]*;/gi),
      ];
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m[0]).toMatch(/COLLATE\s*=\s*utf8mb4_0900_ai_ci/i);
        expect(m[0]).toMatch(/CHARSET\s*=\s*utf8mb4/i);
      }
    });
  });

  describe('users table (Req 3, 11)', () => {
    const block = tableBlock('users');

    it('has uk_users_email unique index', () => {
      expect(block).toMatch(/UNIQUE\s+KEY\s+uk_users_email\s*\(\s*email\s*\)/i);
    });

    it('has uk_users_uuid unique index', () => {
      expect(block).toMatch(/UNIQUE\s+KEY\s+uk_users_uuid\s*\(\s*uuid\s*\)/i);
    });

    it('has idx_users_role index', () => {
      expect(block).toMatch(/KEY\s+idx_users_role\s*\(\s*role\s*\)/i);
    });

    it('stores password_hash as VARCHAR(72) for bcrypt', () => {
      expect(block).toMatch(/password_hash\s+VARCHAR\(72\)\s+NOT\s+NULL/i);
    });

    it('declares the four roles in Req 11.1', () => {
      expect(block).toMatch(
        /role\s+ENUM\(\s*'Super_Admin'\s*,\s*'HR'\s*,\s*'Department_Head'\s*,\s*'Applicant'\s*\)/i,
      );
    });
  });

  describe('applicants table', () => {
    const block = tableBlock('applicants');

    it('PKs on user_id (1:1 with users)', () => {
      expect(block).toMatch(/PRIMARY\s+KEY\s*\(\s*user_id\s*\)/i);
    });

    it('cascades delete from users via FK', () => {
      expect(block).toMatch(
        /FOREIGN\s+KEY\s*\(\s*user_id\s*\)\s+REFERENCES\s+users\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });
  });

  describe('sessions table (Req 3.5)', () => {
    const block = tableBlock('sessions');

    it('uses CHAR(43) for the session id (32 bytes base64url)', () => {
      expect(block).toMatch(/^\s*id\s+CHAR\(43\)\s+NOT\s+NULL/im);
    });

    it('embeds csrf_token inline (design §8.6)', () => {
      expect(block).toMatch(/csrf_token\s+CHAR\(43\)\s+NOT\s+NULL/i);
    });

    it('records expires_at and last_active_at for absolute + idle timeouts', () => {
      expect(block).toMatch(/expires_at\s+DATETIME\s+NOT\s+NULL/i);
      expect(block).toMatch(/last_active_at\s+DATETIME\s+NOT\s+NULL/i);
    });
  });

  describe('login_attempts table (Req 3.7, 14.3)', () => {
    const block = tableBlock('login_attempts');

    it('has idx_login_attempts_email_time on (email, attempt_at)', () => {
      expect(block).toMatch(
        /KEY\s+idx_login_attempts_email_time\s*\(\s*email\s*,\s*attempt_at\s*\)/i,
      );
    });

    it('has an IP-time index for per-IP rate limiting', () => {
      expect(block).toMatch(
        /KEY\s+idx_login_attempts_ip_time\s*\(\s*ip_address\s*,\s*attempt_at\s*\)/i,
      );
    });
  });

  describe('rate_limits table (Req 14.2-4)', () => {
    const block = tableBlock('rate_limits');

    it('PKs on bucket', () => {
      expect(block).toMatch(/PRIMARY\s+KEY\s*\(\s*bucket\s*\)/i);
    });

    it('has idx_rate_limits_key_window on (bucket, window_started_at)', () => {
      expect(block).toMatch(
        /KEY\s+idx_rate_limits_key_window\s*\(\s*bucket\s*,\s*window_started_at\s*\)/i,
      );
    });
  });

  describe('cron_locks table (design §11.1)', () => {
    const block = tableBlock('cron_locks');

    it('PKs on name (advisory lock key)', () => {
      expect(block).toMatch(/PRIMARY\s+KEY\s*\(\s*name\s*\)/i);
    });

    it('carries last-run telemetry columns', () => {
      expect(block).toMatch(/last_run_at\s+DATETIME\s+NULL/i);
      expect(block).toMatch(/last_status\s+ENUM\(\s*'ok'\s*,\s*'error'\s*\)\s+NULL/i);
      expect(block).toMatch(/last_error\s+VARCHAR\(500\)\s+NULL/i);
    });
  });

  describe('schema_migrations table (Req 19.2)', () => {
    const block = tableBlock('schema_migrations');

    it('uses CREATE TABLE IF NOT EXISTS to compose with migrate.mjs bootstrap', () => {
      expect(block).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+schema_migrations/i);
    });

    it('records id, checksum, applied_at', () => {
      expect(block).toMatch(/^\s*id\s+VARCHAR\(\d+\)\s+NOT\s+NULL/im);
      expect(block).toMatch(/checksum\s+CHAR\(64\)\s+NOT\s+NULL/i);
      expect(block).toMatch(/applied_at\s+DATETIME\s+NOT\s+NULL/i);
    });
  });
});
