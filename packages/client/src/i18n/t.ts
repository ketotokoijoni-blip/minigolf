export type Lang = 'fi' | 'en';
export type Dict = Record<string, string>;
const dicts: Record<Lang, Dict> = { fi: {}, en: {} };
let lang: Lang = 'fi';
const listeners = new Set<() => void>();
/** Merge strings into a language. Called at module import by fi.ts, fi.mp.ts, fi.editor.ts, ... */
export function registerDictionary(l: Lang, dict: Dict): void { Object.assign(dicts[l], dict); }
export function setLanguage(l: Lang): void { lang = l; listeners.forEach((f) => f()); }
export function getLanguage(): Lang { return lang; }
export function onLanguageChange(f: () => void): () => void { listeners.add(f); return () => listeners.delete(f); }
/** Template params as {name}. Falls back to Finnish, then to the key itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  const s = dicts[lang][key] ?? dicts.fi[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : s;
}
