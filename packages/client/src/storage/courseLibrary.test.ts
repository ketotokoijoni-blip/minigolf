import { describe, expect, it } from 'vitest';
import type { Course } from '@puttipeli/shared/course/types';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import { createCourseLibrary, looksLikeCourse, randomKey, importCourseText, issueMessage, safeValidate, LIBRARY_KEY, DRAFT_KEY } from './courseLibrary';
import type { StorageLike } from './settings';
import { setLanguage } from '../i18n/t';
import '../i18n/fi';
import '../i18n/en';

const row = (c: string): string => c.repeat(49);
function makeCourse(name: string): Course {
  return {
    format: 'puttipeli-course',
    formatVersion: 1,
    id: '',
    name,
    author: 'Testaaja',
    description: '',
    width: 49,
    height: 25,
    rules: { maxStrokes: 20, par: 3 },
    surface: Array.from({ length: 25 }, () => row('.')),
    walls: Array.from({ length: 25 }, (_, y) => (y === 0 || y === 24 ? row('#') : '#' + row('.').slice(2) + '#')),
    objects: [{ type: 'start', x: 2, y: 12 }, { type: 'hole', x: 46, y: 12 }],
  };
}

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.has(k) ? this.data.get(k)! : null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
  removeItem(k: string): void { this.data.delete(k); }
}

class ThrowingStorage implements StorageLike {
  calls = 0;
  getItem(): string | null { this.calls++; throw new Error('SecurityError: storage disabled'); }
  setItem(): void { this.calls++; throw new Error('QuotaExceededError'); }
  removeItem(): void { this.calls++; throw new Error('SecurityError'); }
}

function lib(storage: StorageLike | null) {
  let n = 0;
  let now = 1000;
  return createCourseLibrary({ storage, uuid: () => `k${++n}`, now: () => now++, copySuffix: () => ' (kopio)' });
}

describe('courseLibrary phase 2: ids and validation on listing', () => {
  it('saves with a computed content id (withComputedId) and keeps built-in ids', () => {
    const l = lib(new MemoryStorage());
    const e = l.saveCourse(makeCourse('Hash'));
    expect(e.course.id).toMatch(/^c_[0-9a-f]{16}$/);
    const same = l.saveCourse({ ...makeCourse('Hash'), id: 'whatever' });
    expect(same.course.id).toBe(e.course.id);
    const b = l.saveCourse(BUILTIN_COURSES[0]!);
    expect(b.course.id).toBe('b_01');
  });

  it('listCoursesWithIssues re-validates every entry and greys out the ones with errors', () => {
    const storage = new MemoryStorage();
    const l = lib(storage);
    l.saveCourse(makeCourse('Kelpo'));
    const broken = makeCourse('Rikki');
    broken.objects = [{ type: 'start', x: 2, y: 12 }]; // no hole
    l.saveCourse(broken);
    const warn = makeCourse('Varoitus');
    warn.objects = [{ type: 'start', x: 2, y: 12 }, { type: 'hole', x: 3, y: 12 }]; // hole next to start
    l.saveCourse(warn);
    const listed = l.listCoursesWithIssues();
    expect(listed.map((e) => e.valid)).toEqual([true, false, true]);
    expect(listed[0]!.issues).toEqual([]);
    expect(listed[1]!.issues.map((i) => i.code)).toContain('NO_HOLE');
    expect(listed[2]!.issues.map((i) => i.code)).toContain('HOLE_NEXT_TO_START');
    expect(listed[2]!.issues.every((i) => i.level === 'warning')).toBe(true);
    // A corrupt entry that passes the structural check is still listed, as invalid, without throwing.
    const raw = JSON.parse(storage.getItem(LIBRARY_KEY)!) as { course: Record<string, unknown> }[];
    raw[0]!.course.surface = ['short'];
    storage.setItem(LIBRARY_KEY, JSON.stringify(raw));
    const relisted = lib(storage).listCoursesWithIssues();
    expect(relisted[0]!.valid).toBe(false);
    expect(relisted[0]!.issues[0]!.level).toBe('error');
    // Listing returns copies: mutating them does not touch the library.
    relisted[2]!.course.name = 'x';
    expect(lib(storage).listCoursesWithIssues()[2]!.course.name).toBe('Varoitus');
  });

  it('safeValidate never throws', () => {
    expect(safeValidate({} as never).some((i) => i.level === 'error')).toBe(true);
  });
});

describe('importCourseText', () => {
  it('accepts a built-in course file and keeps its id', () => {
    const r = importCourseText(JSON.stringify(BUILTIN_COURSES[1]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.course.id).toBe('b_02');
      expect(r.course.name).toBe(BUILTIN_COURSES[1]!.name);
    }
  });

  it('accepts a custom course and computes a c_ id, reporting warnings', () => {
    const c = makeCourse('Oma');
    c.objects = [{ type: 'start', x: 2, y: 12 }, { type: 'hole', x: 3, y: 12 }];
    const r = importCourseText(JSON.stringify(c));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.course.id).toMatch(/^c_[0-9a-f]{16}$/);
      expect(r.warnings.map((i) => i.code)).toContain('HOLE_NEXT_TO_START');
    }
  });

  it('reports invalid JSON, foreign files, too-new versions and validation errors as issues', () => {
    const bad = importCourseText('{not json');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.code)).toEqual(['BAD_JSON']);
    const foreign = importCourseText('{"hello":"world"}');
    if (!foreign.ok) expect(foreign.issues.map((i) => i.code)).toEqual(['FORMAT_UNKNOWN']);
    const tooNew = importCourseText(JSON.stringify({ ...makeCourse('Uusi'), formatVersion: 99 }));
    if (!tooNew.ok) expect(tooNew.issues.map((i) => i.code)).toEqual(['VERSION_TOO_NEW']);
    const structure = importCourseText(JSON.stringify({ ...makeCourse('Rakenne'), walls: 'nope' }));
    if (!structure.ok) expect(structure.issues.map((i) => i.code)).toEqual(['BAD_STRUCTURE']);
    const noStart = importCourseText(JSON.stringify({ ...makeCourse('Ei lähtöä'), objects: [{ type: 'hole', x: 40, y: 12 }] }));
    expect(noStart.ok).toBe(false);
    if (!noStart.ok) expect(noStart.issues.map((i) => i.code)).toContain('NO_START');
    for (const r of [bad, foreign, tooNew, structure, noStart]) expect(r.ok).toBe(false);
  });

  it('issueMessage localises every reported code with its params', () => {
    setLanguage('fi');
    expect(issueMessage({ level: 'error', code: 'BAD_JSON', message: 'x' })).toBe('Tiedosto ei ole kelvollista JSON-muotoa');
    expect(issueMessage({ level: 'error', code: 'OBJECT_ON_WALL', message: 'x', x: 4, y: 5 })).toBe('Kohde ei voi olla seinän päällä (4, 5)');
    expect(issueMessage({ level: 'error', code: 'TELEPORT_GROUP_SIZE', message: 'x', params: { group: 1, count: 3 } })).toContain('3 laattaa');
    expect(issueMessage({ level: 'error', code: 'SOMETHING_NEW', message: 'dev fallback' })).toBe('dev fallback');
    setLanguage('en');
    try {
      expect(issueMessage({ level: 'error', code: 'FORMAT_UNKNOWN', message: 'x' })).toBe('The file is not a Puttipeli course file');
    } finally {
      setLanguage('fi');
    }
  });
});

describe('courseLibrary with working storage', () => {
  it('starts empty and persists saves', () => {
    const storage = new MemoryStorage();
    const l = lib(storage);
    expect(l.listCourses()).toEqual([]);
    const e = l.saveCourse(makeCourse('Eka'));
    expect(e.key).toBe('k1');
    expect(e.savedAt).toBe(1000);
    expect(l.listCourses()).toHaveLength(1);
    expect(JSON.parse(storage.getItem(LIBRARY_KEY)!)).toHaveLength(1);
    // A fresh instance over the same storage sees the entry
    expect(lib(storage).listCourses()[0]!.course.name).toBe('Eka');
  });

  it('replaces in place when a key is given and appends unknown keys', () => {
    const l = lib(new MemoryStorage());
    const a = l.saveCourse(makeCourse('A'));
    l.saveCourse(makeCourse('B'));
    const a2 = l.saveCourse(makeCourse('A2'), a.key);
    expect(a2.key).toBe(a.key);
    expect(l.listCourses().map((e) => e.course.name)).toEqual(['A2', 'B']);
    l.saveCourse(makeCourse('C'), 'unknown-key');
    expect(l.listCourses().map((e) => e.key)).toEqual([a.key, 'k2', 'unknown-key']);
  });

  it('stores a copy, not the caller object', () => {
    const l = lib(new MemoryStorage());
    const c = makeCourse('Mut');
    l.saveCourse(c);
    c.name = 'changed';
    expect(l.listCourses()[0]!.course.name).toBe('Mut');
    const listed = l.listCourses()[0]!;
    listed.course.name = 'hacked';
    expect(l.listCourses()[0]!.course.name).toBe('Mut');
  });

  it('duplicates right after the source with a suffixed name and new key', () => {
    const l = lib(new MemoryStorage());
    const a = l.saveCourse(makeCourse('Alku'));
    l.saveCourse(makeCourse('Loppu'));
    const copy = l.duplicateCourse(a.key);
    expect(copy).not.toBeNull();
    expect(copy!.key).not.toBe(a.key);
    expect(copy!.course.name).toBe('Alku (kopio)');
    expect(l.listCourses().map((e) => e.course.name)).toEqual(['Alku', 'Alku (kopio)', 'Loppu']);
    expect(l.duplicateCourse('nope')).toBeNull();
  });

  it('uses the localised copy suffix by default', async () => {
    await import('../i18n/fi');
    await import('../i18n/en');
    const { setLanguage } = await import('../i18n/t');
    const l = createCourseLibrary({ storage: new MemoryStorage(), uuid: randomKey });
    const e = l.saveCourse(makeCourse('Rata'));
    setLanguage('en');
    try {
      expect(l.duplicateCourse(e.key)!.course.name).toBe('Rata (copy)');
    } finally {
      setLanguage('fi');
    }
    expect(l.duplicateCourse(e.key)!.course.name).toBe('Rata (kopio)');
  });

  it('keeps duplicated names within 40 characters', () => {
    const l = lib(new MemoryStorage());
    const e = l.saveCourse(makeCourse('x'.repeat(40)));
    const copy = l.duplicateCourse(e.key)!;
    expect(copy.course.name.length).toBe(40);
    expect(copy.course.name.endsWith(' (kopio)')).toBe(true);
  });

  it('deletes and clears, notifying listeners', () => {
    const l = lib(new MemoryStorage());
    let n = 0;
    const off = l.onLibraryChange(() => n++);
    const a = l.saveCourse(makeCourse('A'));
    l.saveCourse(makeCourse('B'));
    l.deleteCourse(a.key);
    l.deleteCourse('missing'); // no-op, no notification
    expect(l.listCourses().map((e) => e.course.name)).toEqual(['B']);
    expect(n).toBe(3);
    l.clearCourses();
    expect(l.listCourses()).toEqual([]);
    expect(n).toBe(4);
    off();
    l.saveCourse(makeCourse('C'));
    expect(n).toBe(4);
  });

  it('round-trips the editor draft', () => {
    const storage = new MemoryStorage();
    const l = lib(storage);
    expect(l.loadDraft()).toBeNull();
    l.saveDraft(makeCourse('Luonnos'));
    expect(l.loadDraft()!.name).toBe('Luonnos');
    expect(storage.getItem(DRAFT_KEY)).not.toBeNull();
    l.saveDraft(null);
    expect(l.loadDraft()).toBeNull();
  });

  it('ignores corrupt storage content and malformed entries', () => {
    const storage = new MemoryStorage();
    storage.setItem(LIBRARY_KEY, '{not json');
    expect(lib(storage).listCourses()).toEqual([]);
    storage.setItem(LIBRARY_KEY, JSON.stringify([{ key: 'ok', course: makeCourse('Ok'), savedAt: 5 }, { key: 7, course: makeCourse('BadKey') }, { key: 'x', course: { nope: true } }, null, 'str']));
    expect(lib(storage).listCourses().map((e) => e.key)).toEqual(['ok']);
    storage.setItem(DRAFT_KEY, '[1,2]');
    expect(lib(storage).loadDraft()).toBeNull();
  });
});

describe('courseLibrary with a throwing localStorage', () => {
  it('never throws and keeps working in memory for the session', () => {
    const storage = new ThrowingStorage();
    const l = lib(storage);
    expect(l.listCourses()).toEqual([]);
    const e = l.saveCourse(makeCourse('Muisti'));
    expect(e.key).toBe('k1');
    expect(l.listCourses()).toHaveLength(1);
    expect(l.duplicateCourse(e.key)!.course.name).toBe('Muisti (kopio)');
    expect(l.listCourses()).toHaveLength(2);
    l.deleteCourse(e.key);
    expect(l.listCourses()).toHaveLength(1);
    expect(() => l.saveDraft(makeCourse('d'))).not.toThrow();
    expect(l.loadDraft()).toBeNull();
    expect(() => l.clearCourses()).not.toThrow();
    expect(l.listCourses()).toEqual([]);
    expect(storage.calls).toBeGreaterThan(0);
  });

  it('works with no storage at all', () => {
    const l = lib(null);
    l.saveCourse(makeCourse('Ei varastoa'));
    expect(l.listCourses()).toHaveLength(1);
    expect(l.loadDraft()).toBeNull();
  });
});

describe('helpers', () => {
  it('looksLikeCourse accepts a course and rejects junk', () => {
    expect(looksLikeCourse(makeCourse('x'))).toBe(true);
    expect(looksLikeCourse(null)).toBe(false);
    expect(looksLikeCourse({ format: 'other' })).toBe(false);
    expect(looksLikeCourse({ ...makeCourse('x'), surface: 'nope' })).toBe(false);
  });

  it('randomKey yields distinct uuid-shaped keys', () => {
    const keys = new Set(Array.from({ length: 50 }, randomKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f-]{36}$/);
  });
});
