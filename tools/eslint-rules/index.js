/**
 * Local ESLint plugin entry point. Exposes custom rules defined under
 * `tools/eslint-rules/` so they can be referenced as `local/<rule-name>`
 * from `eslint.config.js`.
 *
 * See: design.md §19, requirements 15.4.
 */

import noStringConcatSql from './no-string-concat-sql.js';

const plugin = {
  meta: {
    name: 'eslint-plugin-local',
    version: '0.1.0',
  },
  rules: {
    'no-string-concat-sql': noStringConcatSql,
  },
};

export default plugin;
