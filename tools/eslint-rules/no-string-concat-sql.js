/**
 * @fileoverview Disallow building SQL via string concatenation (`+`) or
 * template literal interpolation. SQL must always be built via prepared
 * statements with placeholders (mysql2 named/positional placeholders).
 *
 * Validates: Requirements 15.4 — "THE The_Portal SHALL parameterize every
 * SQL statement using prepared statements and SHALL NOT concatenate user
 * input into SQL strings." (per design §19)
 *
 * Rule logic:
 *  - For TemplateLiteral nodes: if at least one `${expr}` placeholder is
 *    present AND the static text segments contain a SQL keyword
 *    (SELECT/INSERT/UPDATE/DELETE/FROM/WHERE, case-insensitive), report.
 *  - For `+` BinaryExpressions: flatten the entire chain. If at least one
 *    string-literal operand contains a SQL keyword AND at least one
 *    operand is a non-literal (i.e. dynamic value), report.
 *
 * Tagged template literals are ignored — SQL drivers/libraries that wrap
 * tagged templates (e.g. `sql\`SELECT ...\``) typically build prepared
 * statements safely.
 */

const SQL_KEYWORD_RE = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/i;

/**
 * Flatten a left-leaning `+` BinaryExpression chain into its leaf operands.
 * @param {import('estree').Node} node
 * @param {import('estree').Node[]} parts
 */
function flattenPlusChain(node, parts) {
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    flattenPlusChain(node.left, parts);
    flattenPlusChain(node.right, parts);
  } else {
    parts.push(node);
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow string concatenation or template literal interpolation that builds SQL. Use prepared statements with placeholders instead.',
      recommended: true,
    },
    schema: [],
    messages: {
      noConcat:
        'Avoid building SQL via string concatenation or template interpolation. Use prepared statements with placeholders (e.g. mysql2 `?` or named `:name`).',
    },
  },

  create(context) {
    return {
      TemplateLiteral(node) {
        // Skip pure static templates (no interpolation).
        if (!node.expressions || node.expressions.length === 0) return;

        // Skip tagged templates — assume the tag handles parameterization.
        if (
          node.parent &&
          node.parent.type === 'TaggedTemplateExpression' &&
          node.parent.quasi === node
        ) {
          return;
        }

        const staticText = node.quasis
          .map((q) => (q.value && q.value.cooked) || '')
          .join(' ');

        if (SQL_KEYWORD_RE.test(staticText)) {
          context.report({ node, messageId: 'noConcat' });
        }
      },

      BinaryExpression(node) {
        if (node.operator !== '+') return;

        // Only inspect the outermost node of a `+` chain to avoid duplicate
        // reports on nested BinaryExpressions.
        if (
          node.parent &&
          node.parent.type === 'BinaryExpression' &&
          node.parent.operator === '+'
        ) {
          return;
        }

        const parts = [];
        flattenPlusChain(node, parts);

        const stringLiteralParts = [];
        let hasNonLiteralPart = false;
        for (const p of parts) {
          if (p.type === 'Literal' && typeof p.value === 'string') {
            stringLiteralParts.push(p.value);
          } else if (
            p.type === 'TemplateLiteral' &&
            p.expressions.length === 0
          ) {
            // Static template literal acts like a string literal.
            stringLiteralParts.push(
              p.quasis.map((q) => (q.value && q.value.cooked) || '').join(''),
            );
          } else {
            hasNonLiteralPart = true;
          }
        }

        if (stringLiteralParts.length === 0 || !hasNonLiteralPart) return;

        const combined = stringLiteralParts.join(' ');
        if (SQL_KEYWORD_RE.test(combined)) {
          context.report({ node, messageId: 'noConcat' });
        }
      },
    };
  },
};

export default rule;
