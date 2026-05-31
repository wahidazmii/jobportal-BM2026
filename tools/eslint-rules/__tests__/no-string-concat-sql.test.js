/**
 * Unit tests for the local ESLint rule `no-string-concat-sql`.
 *
 * Uses ESLint's built-in RuleTester. We rely on the Node.js built-in test
 * runner (`node:test`) so the test runs without any extra config — the
 * project's Vitest setup (Task 3.2) will pick up `*.test.js` here too via
 * globally compatible `describe`/`it` (Vitest provides them when configured
 * with `globals: true`).
 *
 * Run directly: `node --test tools/eslint-rules/__tests__/no-string-concat-sql.test.js`
 *
 * Validates: Requirements 15.4 — prepared statements only; no SQL string
 * concatenation. (per design §19)
 */

import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import rule from '../no-string-concat-sql.js';

// Wire ESLint's RuleTester into node:test so each scenario becomes its own
// `it(...)` test (rather than RuleTester's default of running inline).
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-string-concat-sql', rule, {
  valid: [
    // Static SQL with placeholders — the canonical safe pattern.
    { code: "const sql = 'SELECT * FROM users WHERE id = ?';" },
    { code: "pool.query('INSERT INTO sessions (sid) VALUES (?)', [sid]);" },

    // Template literal without any interpolation is just a static string.
    { code: 'const sql = `SELECT * FROM users WHERE id = ?`;' },

    // Interpolated template that does NOT contain SQL keywords.
    { code: 'const greeting = `hello ${name}`;' },

    // Concatenation without SQL keywords.
    { code: "const url = '/api/users/' + userId;" },

    // Concatenation of only string literals (no dynamic input) — allowed,
    // even with SQL keywords, because no user input can flow in.
    { code: "const sql = 'SELECT * ' + 'FROM users ' + 'WHERE id = ?';" },

    // Tagged template literal — assume the tag handles parameterization
    // (e.g. a `sql` tag that produces prepared statements).
    { code: 'const q = sql`SELECT * FROM users WHERE id = ${userId}`;' },
  ],

  invalid: [
    // Template literal with interpolation building a SELECT.
    {
      code: 'const q = `SELECT * FROM users WHERE id = ${userId}`;',
      errors: [{ messageId: 'noConcat' }],
    },
    // Template literal building an INSERT.
    {
      code: 'pool.query(`INSERT INTO users (email) VALUES (${email})`);',
      errors: [{ messageId: 'noConcat' }],
    },
    // Template literal building an UPDATE.
    {
      code: 'const q = `UPDATE users SET name = ${name} WHERE id = ${id}`;',
      errors: [{ messageId: 'noConcat' }],
    },
    // Template literal building a DELETE.
    {
      code: 'const q = `DELETE FROM sessions WHERE sid = ${sid}`;',
      errors: [{ messageId: 'noConcat' }],
    },

    // `+` concatenation of literal SQL fragment with a dynamic value.
    {
      code: "const q = 'SELECT * FROM users WHERE id = ' + userId;",
      errors: [{ messageId: 'noConcat' }],
    },
    // SQL keyword split across literal fragments still flagged when
    // keywords are present in any fragment alongside dynamic input.
    {
      code: "const q = 'SELECT * FROM users WHERE name = \\'' + name + '\\'';",
      errors: [{ messageId: 'noConcat' }],
    },
    // Mixed concatenation chain: should report exactly once on the
    // outermost BinaryExpression of the `+` chain.
    {
      code: "const q = 'DELETE FROM ' + table + ' WHERE id = ' + id;",
      errors: [{ messageId: 'noConcat' }],
    },
  ],
});
