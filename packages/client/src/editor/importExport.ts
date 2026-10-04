// Import/export (DESIGN §13.3): JSON file download/upload, drag-and-drop file reading, clipboard sharing with a
// fallback window, and "Tuo koodista" (paste JSON into a textarea). Every import goes through parseCourseFile —
// issues are listed, never silently fixed. Pure helpers first (tested), DOM helpers below (runtime only).
import { canonicalCourseJson } from '@puttipeli/shared/course/canonical';
import { parseCourseFile, type ParseResult } from '@puttipeli/shared/course/migrate';
import type { Course } from '@puttipeli/shared/course/types';
import { el, button } from '../ui/components';
import { t } from '../i18n/t';
import { installModalKeys } from './modal';

export const EXPORT_SUFFIX = '.puttipeli.json';

/** File-name friendly slug: lower-case ASCII letters/digits with dashes; Finnish letters are transliterated. */
export function slugify(name: string): string {
  const s = name.trim().toLowerCase()
    .replace(/[äå]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e').replace(/ü/g, 'u')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/g, '');
  return s || 'rata';
}

export const exportFileName = (course: Course): string => slugify(course.name) + EXPORT_SUFFIX;

/** Pretty JSON of the full course (the file format of §7.1; the id is included and re-derived on import). */
export const courseToJsonText = (course: Course): string => JSON.stringify(course, null, 2) + '\n';

/** Compact canonical JSON for "Jaa koodina". */
export const courseToShareCode = (course: Course): string => canonicalCourseJson(course);

/** JSON text -> ParseResult. Invalid JSON is reported as an issue (code BAD_JSON) instead of throwing. */
export function parseCourseText(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, issues: [{ level: 'error', code: 'BAD_JSON', message: err instanceof Error ? err.message : 'invalid JSON' }] };
  }
  return parseCourseFile(data);
}

// ---------------------------------------------------------------------------------------------------------------
// Browser helpers (not exercised by the node tests)
// ---------------------------------------------------------------------------------------------------------------

/** Downloads a text file through a Blob URL and a temporary <a download> (a normal web page, not a sandbox). */
export function downloadTextFile(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens the file picker for one .json file; resolves null when the dialog is dismissed. */
export function pickJsonFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    let settled = false;
    const finish = (f: File | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(f);
    };
    // Browsers without the 'cancel' event: when the window regains focus and no file arrived within a second, give up.
    const onFocus = (): void => { window.setTimeout(() => finish(input.files?.[0] ?? null), 1000); };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', onFocus);
    document.body.append(input);
    input.click();
  });
}

export function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/** First .json file of a drop event, or null. */
export function fileFromDrop(e: DragEvent): File | null {
  const files = e.dataTransfer?.files;
  if (!files) return null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (/\.json$/i.test(f.name) || f.type === 'application/json') return f;
  }
  return null;
}

/** Clipboard write with the legacy textarea fallback; false when neither route worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface CodeDialogOptions {
  title: string;
  hint: string;
  initial?: string;
  readonly?: boolean;
  placeholder?: string;
  okLabel?: string;
  /** Returns an error text to show (and keep the dialog open) or null when the text is acceptable. */
  validate?: (text: string) => string | null;
  /** Called once the dialog is on screen with a function that cancels it (resolves null); the screen closes open dialogs on unmount. */
  onOpen?: (cancel: () => void) => void;
}

/**
 * Modal with a large textarea (same look as ui/dialogs.ts). Resolves with the text on OK, null on cancel/Escape.
 * Clipboard *reading* is never relied upon: the user pastes into the textarea.
 */
export function openCodeDialog(opts: CodeDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const ta = el('textarea', { class: 'input ed-code', spellcheck: 'false', autocomplete: 'off', wrap: 'off' });
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    ta.value = opts.initial ?? '';
    if (opts.readonly) ta.readOnly = true;
    const error = el('div', { class: 'dialog__error', 'aria-live': 'polite' });
    let settled = false;
    const close = (): void => {
      if (settled) return;
      settled = true;
      offKeys();
      backdrop.remove();
      if (!document.querySelector('.dialog-backdrop')) document.body.style.overflow = '';
      if (previous && previous.isConnected) previous.focus();
    };
    const cancel = (): void => { if (!settled) { close(); resolve(null); } };
    const submit = (): void => {
      const text = ta.value;
      const err = opts.validate ? opts.validate(text) : null;
      if (err) { error.textContent = err; ta.setAttribute('aria-invalid', 'true'); return; }
      close();
      resolve(text);
    };
    const actions = el('div', { class: 'dialog__actions' });
    if (opts.readonly) actions.append(button(t('common.close'), cancel, { primary: true }));
    else actions.append(button(t('common.cancel'), cancel), button(opts.okLabel ?? t('common.ok'), submit, { primary: true }));
    const box = el('div', { class: 'dialog ed-dialog', role: 'dialog', 'aria-modal': 'true' },
      el('h2', {}, opts.title), el('p', { class: 'muted small' }, opts.hint), ta, error, actions);
    const backdrop = el('div', { class: 'dialog-backdrop ed-modal' }, box);
    // Escape / Tab trap / Ctrl+Enter on window (see modal.ts): the dialog stays closable after the focus leaves it.
    const offKeys = installModalKeys(backdrop, box, { onEscape: cancel, onSubmit: opts.readonly ? undefined : submit });
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) cancel(); });
    ta.addEventListener('input', () => { error.textContent = ''; ta.removeAttribute('aria-invalid'); });
    document.body.append(backdrop);
    document.body.style.overflow = 'hidden';
    ta.focus();
    if (opts.readonly) ta.select();
    opts.onOpen?.(cancel);
  });
}
