// Custom course library + editor draft in localStorage (DESIGN §13.3). Stores Course objects as-is; validation is
// the caller's job (phase 2 re-validates on listing). A throwing or absent storage degrades to an in-memory library.
import type { Course } from '@puttipeli/shared/course/types';
import { MAX_COURSE_NAME_CHARS } from '@puttipeli/shared/constants';
import type { StorageLike } from './settings';
import { t } from '../i18n/t';

export interface LibraryEntry { key: string /* uuid, stable across edits */; course: Course; savedAt: number }

export const LIBRARY_KEY = 'puttipeli.courses.v1';
export const DRAFT_KEY = 'puttipeli.editorDraft.v1';

export interface CourseLibrary {
  listCourses(): LibraryEntry[];
  saveCourse(course: Course, key?: string): LibraryEntry;
  deleteCourse(key: string): void;
  duplicateCourse(key: string): LibraryEntry | null;
  clearCourses(): void;
  saveDraft(course: Course | null): void;
  loadDraft(): Course | null;
  onLibraryChange(listener: () => void): () => void;
}

export interface LibraryDeps {
  storage?: StorageLike | null;
  now?: () => number;
  uuid?: () => string;
  /** Suffix appended to a duplicated course's name. Default: the localised 'library.copySuffix' string. */
  copySuffix?: () => string;
  /** Hook for WP-A's withComputedId (phase 2). Phase 1 stores the course unchanged. */
  normalizeId?: (course: Course) => Course;
}

function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function randomKey(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* fall through */ }
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Structural sanity only: enough to not crash the UI. Deep validation is validateCourse (WP-A). */
export function looksLikeCourse(v: unknown): v is Course {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return c.format === 'puttipeli-course' && typeof c.name === 'string' && Array.isArray(c.surface) && Array.isArray(c.walls) && Array.isArray(c.objects) && typeof c.rules === 'object' && c.rules !== null;
}

function cloneCourse(c: Course): Course {
  return JSON.parse(JSON.stringify(c)) as Course;
}

export function createCourseLibrary(deps: LibraryDeps = {}): CourseLibrary {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const now = deps.now ?? (() => Date.now());
  const uuid = deps.uuid ?? randomKey;
  const copySuffix = deps.copySuffix ?? (() => t('library.copySuffix'));
  const normalizeId = deps.normalizeId ?? ((c: Course) => c); // TODO phase 2: withComputedId from @puttipeli/shared/course/canonical
  const listeners = new Set<() => void>();
  let entries: LibraryEntry[] | null = null;

  const load = (): LibraryEntry[] => {
    if (entries) return entries;
    entries = [];
    try {
      const raw = storage?.getItem(LIBRARY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (!e || typeof e !== 'object') continue;
          const r = e as Record<string, unknown>;
          if (typeof r.key !== 'string' || !looksLikeCourse(r.course)) continue;
          entries.push({ key: r.key, course: r.course, savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0 });
        }
      }
    } catch { /* corrupt or inaccessible storage: start empty */ }
    return entries;
  };

  const persist = (): void => {
    try { storage?.setItem(LIBRARY_KEY, JSON.stringify(entries ?? [])); } catch { /* keep in memory */ }
    listeners.forEach((l) => l());
  };

  // Callers get deep copies so that editing a listed course never changes the library behind its back.
  const copyEntry = (e: LibraryEntry): LibraryEntry => ({ key: e.key, course: cloneCourse(e.course), savedAt: e.savedAt });

  return {
    listCourses: () => load().map(copyEntry),

    saveCourse(course, key) {
      const list = load();
      const stored = normalizeId(cloneCourse(course));
      const entry: LibraryEntry = { key: key ?? uuid(), course: stored, savedAt: now() };
      const i = key ? list.findIndex((e) => e.key === key) : -1;
      if (i >= 0) list[i] = entry; else list.push(entry);
      persist();
      return copyEntry(entry);
    },

    deleteCourse(key) {
      const list = load();
      const i = list.findIndex((e) => e.key === key);
      if (i < 0) return;
      list.splice(i, 1);
      persist();
    },

    duplicateCourse(key) {
      const list = load();
      const src = list.find((e) => e.key === key);
      if (!src) return null;
      const copy = cloneCourse(src.course);
      const suffix = copySuffix();
      copy.name = (copy.name.slice(0, Math.max(1, MAX_COURSE_NAME_CHARS - suffix.length)) + suffix).slice(0, MAX_COURSE_NAME_CHARS);
      const entry: LibraryEntry = { key: uuid(), course: normalizeId(copy), savedAt: now() };
      list.splice(list.indexOf(src) + 1, 0, entry);
      persist();
      return copyEntry(entry);
    },

    clearCourses() {
      entries = [];
      try { storage?.removeItem(LIBRARY_KEY); } catch { /* ignore */ }
      listeners.forEach((l) => l());
    },

    saveDraft(course) {
      try {
        if (course) storage?.setItem(DRAFT_KEY, JSON.stringify(course));
        else storage?.removeItem(DRAFT_KEY);
      } catch { /* ignore */ }
    },

    loadDraft() {
      try {
        const raw = storage?.getItem(DRAFT_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return looksLikeCourse(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    onLibraryChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// Default singleton bound to window.localStorage (lazy: nothing is read at import time).
const lib = createCourseLibrary();
export const listCourses = (): LibraryEntry[] => lib.listCourses();
export const saveCourse = (course: Course, key?: string): LibraryEntry => lib.saveCourse(course, key);
export const deleteCourse = (key: string): void => lib.deleteCourse(key);
export const duplicateCourse = (key: string): LibraryEntry | null => lib.duplicateCourse(key);
export const clearCourses = (): void => lib.clearCourses();
export const saveDraft = (course: Course | null): void => lib.saveDraft(course);
export const loadDraft = (): Course | null => lib.loadDraft();
export const onLibraryChange = (listener: () => void): (() => void) => lib.onLibraryChange(listener);
