/**
 * i18n locale resolver and translation lookup for PT Buana Megah Job Portal.
 *
 * Design  : §13 (i18n)
 * Validates: Requirements 17.1, 17.2, 17.3, 17.5
 *
 * Responsibilities:
 *   - `resolveLocale(request)` — determine the active locale from:
 *       1. URL `:locale` param (highest priority)
 *       2. Cookie `lang`
 *       3. `Accept-Language` header
 *       4. Default `'id'`
 *   - `loadTranslations(locale)` — read `src/locales/${locale}.json`
 *     synchronously; result is cached after first load.
 *   - `t(key, locale)` — flat-key lookup with fallback to `id` locale
 *     when the key is missing in `en`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Locale = 'id' | 'en';

/** Supported locale codes. Exported for use in route validation. */
export const SUPPORTED_LOCALES = ['id', 'en'] as const;

const _SUPPORTED_LOCALES_SET: ReadonlySet<Locale> = new Set(SUPPORTED_LOCALES);
const DEFAULT_LOCALE: Locale = 'id';

// ---------------------------------------------------------------------------
// Translation cache
// ---------------------------------------------------------------------------

const translationCache = new Map<Locale, Record<string, string>>();

/**
 * Resolve the absolute path to the locales directory.
 * Works both from `src/` (ts-node / tsx) and from `dist/` (compiled JS).
 */
function localesDir(): string {
  // __dirname equivalent for ESM
  const thisFile = fileURLToPath(import.meta.url);
  // src/modules/i18n/resolver.ts → go up 3 levels to reach src/, then locales/
  return path.resolve(path.dirname(thisFile), '..', '..', 'locales');
}

/**
 * Load and cache translations for the given locale.
 * Reads `src/locales/${locale}.json` synchronously on first call;
 * subsequent calls return the cached object.
 *
 * Validates: Requirements 17.1, 17.3
 */
export function loadTranslations(locale: Locale): Record<string, string> {
  const cached = translationCache.get(locale);
  if (cached !== undefined) return cached;

  const filePath = path.join(localesDir(), `${locale}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, string>;
  translationCache.set(locale, parsed);
  return parsed;
}

/**
 * Flat-key translation lookup with fallback to `id` locale.
 *
 * Priority:
 *   1. `locale` translations[key]
 *   2. `id` translations[key]  (fallback when key missing in `en`)
 *   3. `key` itself            (last resort — never silently empty)
 *
 * Validates: Requirement 17.3
 */
export function t(key: string, locale: Locale): string {
  const translations = loadTranslations(locale);
  if (translations[key] !== undefined) return translations[key];

  // Fallback to id
  if (locale !== DEFAULT_LOCALE) {
    const idTranslations = loadTranslations(DEFAULT_LOCALE);
    if (idTranslations[key] !== undefined) return idTranslations[key];
  }

  // Last resort: return the key itself so the UI is never blank
  return key;
}

// ---------------------------------------------------------------------------
// Locale resolver
// ---------------------------------------------------------------------------

/**
 * Determine the active locale for a Fastify request.
 *
 * Priority (Design §13, Req 17.2):
 *   1. URL `:locale` param  — set by the route pattern `/:locale/...`
 *   2. Cookie `lang`
 *   3. `Accept-Language` header (first tag, e.g. `en-US` → `en`)
 *   4. Default `'id'`
 *
 * Validates: Requirements 17.2, 17.5
 */
export function resolveLocale(request: FastifyRequest): Locale {
  // 1. URL param — Fastify populates request.params when the route
  //    pattern includes `:locale`. Cast safely.
  const params = request.params as Record<string, unknown> | undefined;
  if (params && typeof params['locale'] === 'string') {
    const paramLocale = params['locale'] as string;
    if (_SUPPORTED_LOCALES_SET.has(paramLocale as Locale)) {
      return paramLocale as Locale;
    }
  }

  // 2. Cookie `lang`
  const cookieLang = (request.cookies as Record<string, string | undefined>)?.['lang'];
  if (typeof cookieLang === 'string' && _SUPPORTED_LOCALES_SET.has(cookieLang as Locale)) {
    return cookieLang as Locale;
  }

  // 3. Accept-Language header — parse the first language tag
  const acceptLang = request.headers['accept-language'];
  if (typeof acceptLang === 'string' && acceptLang.length > 0) {
    // Accept-Language: en-US,en;q=0.9,id;q=0.8
    // Take the first tag, strip region subtag
    const firstTag = acceptLang.split(',')[0]?.split(';')[0]?.trim() ?? '';
    const lang = firstTag.split('-')[0]?.toLowerCase() ?? '';
    if (_SUPPORTED_LOCALES_SET.has(lang as Locale)) {
      return lang as Locale;
    }
  }

  // 4. Default
  return DEFAULT_LOCALE;
}

/**
 * Clear the translation cache. Useful in tests to reload locale files.
 */
export function clearTranslationCache(): void {
  translationCache.clear();
}
