// ESLint flat config for the PT Buana Megah job portal.
// Target: TypeScript sources under src/, tools/, and tests/.
// Validates: Requirements 15.4 (per design §19) — enforces prepared statements
// via the local rule `local/no-string-concat-sql`.

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import localPlugin from './tools/eslint-rules/index.js';

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  globalThis: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'artifacts/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'src/public/css/app.css',
      'src/public/js/**',
    ],
  },

  // TypeScript sources — recommended TS rules + local SQL rule.
  {
    files: ['src/**/*.ts', 'src/**/*.mts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: NODE_GLOBALS,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      local: localPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'local/no-string-concat-sql': 'error',
    },
  },

  // Plain JS tooling/scripts (incl. ESM `.mjs`).
  {
    files: ['tools/**/*.js', 'tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    plugins: {
      local: localPlugin,
    },
    rules: {
      'local/no-string-concat-sql': 'error',
    },
  },

  // Test files for the rule itself use Node's built-in test runner globals.
  {
    files: ['tools/eslint-rules/__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
  },
];
