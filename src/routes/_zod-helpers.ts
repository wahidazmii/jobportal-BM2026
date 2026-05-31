/**
 * Internal Zod helpers shared by the route handlers in this directory.
 *
 * Kept under a leading-underscore filename so it never shows up as a
 * Fastify-mountable plugin (the route loader globs for `routes/*.ts`
 * with no underscore prefix).
 */

import type { ZodError } from 'zod';

/**
 * Convert a `ZodError` into the `Record<string, string[]>` shape that
 * the form templates consume for field-level error rendering.
 *
 * Implementation notes:
 *   - Uses `err.flatten().fieldErrors`, which already groups Zod's
 *     `issues` by field path. The `formErrors` (top-level) bag is
 *     intentionally dropped — handlers surface those via the
 *     `generalError` slot instead.
 *   - Strips entries whose value is `undefined` or `[]` so the view
 *     can iterate the map with `{% for k, msgs in errors %}` without
 *     having to guard against empty arrays.
 *   - The return type uses plain `string[]` (not `readonly string[]`)
 *     so handlers can pass it straight into the Nunjucks render
 *     context, which expects mutable arrays.
 */
export function zodErrorToFieldMap(
  err: ZodError,
): Record<string, string[]> {
  const flat = err.flatten().fieldErrors;
  const out: Record<string, string[]> = {};
  for (const [key, msgs] of Object.entries(flat)) {
    if (msgs && msgs.length > 0) {
      out[key] = msgs;
    }
  }
  return out;
}
