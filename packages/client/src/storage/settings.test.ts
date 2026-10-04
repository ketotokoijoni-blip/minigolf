import { describe, expect, it } from 'vitest';
import { createSettingsStore, sanitizeSettings, sanitizeName, DEFAULT_SETTINGS, SETTINGS_KEY, type StorageLike } from './settings';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
  removeItem(k: string): void { this.data.delete(k); }
}
const throwing: StorageLike = {
  getItem() { throw new Error('nope'); },
  setItem() { throw new Error('nope'); },
  removeItem() { throw new Error('nope'); },
};

describe('sanitize', () => {
  it('fills defaults and clamps values', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ volume: 7, colour: 9, language: 'sv', name: 42 })).toEqual({ ...DEFAULT_SETTINGS, volume: 1 });
    expect(sanitizeSettings({ volume: -1, colour: 3, language: 'en', aimGuide: true, touchFireButton: false, reduceEffects: true }))
      .toEqual({ name: '', colour: 3, volume: 0, language: 'en', aimGuide: true, touchFireButton: false, reduceEffects: true });
  });
  it('trims and caps names', () => {
    expect(sanitizeName('  Ville\u0007  ')).toBe('Ville');
    expect(sanitizeName('x'.repeat(30))).toHaveLength(16);
    expect(sanitizeName(undefined)).toBe('');
  });
});

describe('settings store', () => {
  it('loads, updates, persists and notifies', () => {
    const storage = new MemoryStorage();
    const s = createSettingsStore(storage);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    const seen: string[] = [];
    const off = s.subscribe((v) => seen.push(v.name));
    s.update({ name: 'Maija', volume: 0.3 });
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!)).toMatchObject({ name: 'Maija', volume: 0.3 });
    expect(createSettingsStore(storage).get().name).toBe('Maija');
    off();
    s.update({ name: 'X' });
    expect(seen).toEqual(['Maija']);
  });

  it('survives a throwing storage and corrupt JSON', () => {
    const s = createSettingsStore(throwing);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => s.update({ language: 'en' })).not.toThrow();
    expect(s.get().language).toBe('en');
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, '{{{');
    expect(createSettingsStore(storage).get()).toEqual(DEFAULT_SETTINGS);
    expect(createSettingsStore(null).get()).toEqual(DEFAULT_SETTINGS);
  });
});
