/**
 * Lightweight i18n.
 *
 * Loads the messages bundle for the locale configured in `tareas.config.json`
 * (`ui.locale`, default `"en"`). The `t(key, vars?)` helper looks up a dot-path
 * (e.g. `"modal.save"`) and interpolates `{var}` placeholders.
 *
 * The full bundle is also exported so it can be passed to client-side scripts
 * via `define:vars={{ messages: MESSAGES }}` — the inline JS then uses a tiny
 * `t()` mirror to keep the same key shapes server-side and client-side.
 *
 * Adding a locale = drop a new JSON file with the same shape into `src/i18n/`
 * and reference it in the LOCALES map below. No need to touch any other file.
 */
import en from './en.json' assert { type: 'json' };
import es from './es.json' assert { type: 'json' };
import { CONFIG } from '../lib/config';

type Messages = typeof en;

const LOCALES: Record<string, Messages> = { en, es };

function pickLocale(): { code: string; bundle: Messages } {
  const code = ((CONFIG as any).ui?.locale ?? 'en').toString();
  if (LOCALES[code]) return { code, bundle: LOCALES[code] };
  // Fallback chain: full match → language-only match (e.g. `es-PE` → `es`) → en
  const lang = code.split(/[-_]/)[0];
  if (LOCALES[lang]) return { code: lang, bundle: LOCALES[lang] };
  return { code: 'en', bundle: en };
}

const picked = pickLocale();
export const LOCALE: string = picked.code;
export const MESSAGES: Messages = picked.bundle;

function getByPath(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * Translate a key. Falls back to the English bundle, then to the key itself.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const v = getByPath(MESSAGES, key);
  if (typeof v === 'string') return interpolate(v, vars);
  const fallback = getByPath(en, key);
  if (typeof fallback === 'string') return interpolate(fallback, vars);
  return key;
}
