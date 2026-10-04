import { describe, expect, it } from 'vitest';
import type { Course } from '@puttipeli/shared/course/types';
import { createCourseLibrary, looksLikeCourse, randomKey, LIBRARY_KEY, DRAFT_KEY } from './courseLibrary';
import type { StorageLike } from './settings';

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
