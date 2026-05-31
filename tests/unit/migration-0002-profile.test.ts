/**
 * Static structural tests for `migrations/0002_profile.sql`.
 *
 * Feature : pt-buana-megah-job-portal
 * Spec    : tasks.md task 15.1, design.md §7.2
 * Validates: Requirements 4.1-4.8, 16.1
 *
 * Like `migration-0001-init.test.ts`, these tests parse the raw SQL bytes
 * — they do NOT connect to MySQL — so they can run in the unit suite and
 * protect the schema from accidental regressions: a renamed FULLTEXT index,
 * a missing CASCADE, a downgraded charset, a CHECK constraint losing its
 * "in progress" branch, and so on. Integration coverage with a live MySQL
 * instance is provided separately by the migration runner test suite.
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
  '0002_profile.sql',
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
    throw new Error(`CREATE TABLE for "${name}" not found in 0002_profile.sql`);
  }
  return match[0];
}

describe('migrations/0002_profile.sql — task 15.1', () => {
  describe('required tables (§7.2)', () => {
    const required = [
      'applicant_education',
      'applicant_experience',
      'skill_tags',
      'applicant_skills',
      'applicant_cv_files',
      'consent_records',
    ];

    it.each(required)('declares table `%s` with InnoDB engine', (name) => {
      expect(() => tableBlock(name)).not.toThrow();
    });

    it('does NOT redeclare `applicants` (already created by 0001_init)', () => {
      expect(SQL).not.toMatch(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?applicants`?\s*\(/i,
      );
    });

    it('does NOT redeclare `users` (already created by 0001_init)', () => {
      expect(SQL).not.toMatch(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?users`?\s*\(/i,
      );
    });
  });

  describe('charset and engine', () => {
    it('uses utf8mb4_0900_ai_ci on every CREATE TABLE statement', () => {
      const matches = [
        ...SQL.matchAll(/CREATE\s+TABLE[\s\S]*?ENGINE\s*=\s*InnoDB[^;]*;/gi),
      ];
      expect(matches.length).toBe(6);
      for (const m of matches) {
        expect(m[0]).toMatch(/COLLATE\s*=\s*utf8mb4_0900_ai_ci/i);
        expect(m[0]).toMatch(/CHARSET\s*=\s*utf8mb4/i);
      }
    });
  });

  describe('applicant_education (Req 4.2)', () => {
    const block = tableBlock('applicant_education');

    it('cascades delete from applicants(user_id)', () => {
      expect(block).toMatch(
        /FOREIGN\s+KEY\s*\(\s*applicant_user_id\s*\)\s+REFERENCES\s+applicants\(\s*user_id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it('declares chk_edu_progress with both branches', () => {
      // (in_progress=1 AND end_date IS NULL) OR (in_progress=0)
      expect(block).toMatch(
        /CONSTRAINT\s+chk_edu_progress\s+CHECK\s*\(\s*\(\s*in_progress\s*=\s*1\s+AND\s+end_date\s+IS\s+NULL\s*\)\s+OR\s+\(\s*in_progress\s*=\s*0/i,
      );
    });

    it('indexes on applicant_user_id for the per-applicant list query', () => {
      expect(block).toMatch(/KEY\s+idx_edu_applicant\s*\(\s*applicant_user_id\s*\)/i);
    });

    it('stores GPA as DECIMAL(3,2)', () => {
      expect(block).toMatch(/gpa\s+DECIMAL\(3\s*,\s*2\)\s+NULL/i);
    });
  });

  describe('applicant_experience (Req 4.3)', () => {
    const block = tableBlock('applicant_experience');

    it('cascades delete from applicants(user_id)', () => {
      expect(block).toMatch(
        /FOREIGN\s+KEY\s*\(\s*applicant_user_id\s*\)\s+REFERENCES\s+applicants\(\s*user_id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it('declares the five employment_type ENUM values', () => {
      expect(block).toMatch(
        /employment_type\s+ENUM\(\s*'full-time'\s*,\s*'part-time'\s*,\s*'contract'\s*,\s*'internship'\s*,\s*'freelance'\s*\)/i,
      );
    });

    it('indexes on applicant_user_id for the per-applicant list query', () => {
      expect(block).toMatch(/KEY\s+idx_exp_applicant\s*\(\s*applicant_user_id\s*\)/i);
    });
  });

  describe('skill_tags (Req 4.4)', () => {
    const block = tableBlock('skill_tags');

    it('has uk_skill_label unique index for case-insensitive distinctness', () => {
      expect(block).toMatch(/UNIQUE\s+KEY\s+uk_skill_label\s*\(\s*label\s*\)/i);
    });

    it('declares ft_skill_label as a FULLTEXT index parsed with ngram', () => {
      expect(block).toMatch(
        /FULLTEXT\s+KEY\s+ft_skill_label\s*\(\s*label\s*\)\s+WITH\s+PARSER\s+ngram/i,
      );
    });

    it('label is VARCHAR(50)', () => {
      expect(block).toMatch(/label\s+VARCHAR\(50\)\s+NOT\s+NULL/i);
    });
  });

  describe('applicant_skills (M:N link, Req 4.4)', () => {
    const block = tableBlock('applicant_skills');

    it('PKs on (applicant_user_id, skill_id)', () => {
      expect(block).toMatch(
        /PRIMARY\s+KEY\s*\(\s*applicant_user_id\s*,\s*skill_id\s*\)/i,
      );
    });

    it('cascades delete from applicants(user_id)', () => {
      expect(block).toMatch(
        /FOREIGN\s+KEY\s*\(\s*applicant_user_id\s*\)\s+REFERENCES\s+applicants\(\s*user_id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it('does NOT cascade delete from skill_tags (HR curates via `active`)', () => {
      const fkSkill =
        /FOREIGN\s+KEY\s*\(\s*skill_id\s*\)\s+REFERENCES\s+skill_tags\(\s*id\s*\)([^,)]*)/i.exec(
          block,
        );
      expect(fkSkill).not.toBeNull();
      expect(fkSkill![1]).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    });
  });

  describe('applicant_cv_files (Req 4.5-4.8)', () => {
    const block = tableBlock('applicant_cv_files');

    it('cascades delete from applicants(user_id)', () => {
      expect(block).toMatch(
        /FOREIGN\s+KEY\s*\(\s*applicant_user_id\s*\)\s+REFERENCES\s+applicants\(\s*user_id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it('has the columns required by the upload service', () => {
      expect(block).toMatch(/storage_path\s+VARCHAR\(255\)\s+NOT\s+NULL/i);
      expect(block).toMatch(/original_filename\s+VARCHAR\(255\)\s+NOT\s+NULL/i);
      expect(block).toMatch(/mime_type\s+VARCHAR\(100\)\s+NOT\s+NULL/i);
      expect(block).toMatch(/size_bytes\s+INT\s+UNSIGNED\s+NOT\s+NULL/i);
      expect(block).toMatch(/is_active\s+TINYINT\(1\)\s+NOT\s+NULL\s+DEFAULT\s+1/i);
      expect(block).toMatch(
        /uploaded_at\s+DATETIME\s+NOT\s+NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/i,
      );
    });

    it('has idx_cv_applicant_active on (applicant_user_id, is_active, uploaded_at)', () => {
      expect(block).toMatch(
        /KEY\s+idx_cv_applicant_active\s*\(\s*applicant_user_id\s*,\s*is_active\s*,\s*uploaded_at\s*\)/i,
      );
    });
  });

  describe('consent_records (Req 16.1)', () => {
    const block = tableBlock('consent_records');

    it('cascades delete from applicants(user_id)', () => {
      expect(block).toMatch(
        /FOREIGN\s+KEY\s*\(\s*applicant_user_id\s*\)\s+REFERENCES\s+applicants\(\s*user_id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it('records (policy_version, accepted_at, ip_address)', () => {
      expect(block).toMatch(/policy_version\s+VARCHAR\(20\)\s+NOT\s+NULL/i);
      expect(block).toMatch(
        /accepted_at\s+DATETIME\s+NOT\s+NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/i,
      );
      expect(block).toMatch(/ip_address\s+VARBINARY\(16\)\s+NULL/i);
    });

    it('has idx_consent_app on (applicant_user_id, accepted_at) for latest-consent lookup', () => {
      expect(block).toMatch(
        /KEY\s+idx_consent_app\s*\(\s*applicant_user_id\s*,\s*accepted_at\s*\)/i,
      );
    });
  });
});
